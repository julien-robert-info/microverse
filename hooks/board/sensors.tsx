import type { AgentInfo, EngineInterface, PluginOptions } from 'claude-code'

import type {
  Heavy,
  Light,
  LightAgent,
  LightState,
  LightUsage,
  LightWorktree,
  OrchStatus,
  Sensed,
} from '../../types/board'

type Engine = EngineInterface

export const PROFILE = '.claude/orchestration/profile.json'
const STATE_FILE = 'CLAUDE.local.md'
export const FINISHED = ['completed', 'failed', 'killed']
const HEAVY_TIMEOUT_MS = 60_000
// Same variable as orch-status's own git calls: a read must not take the
// index lock a running agent may need.
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }

// Option name -> flag, as scripts/status-command.js passes them.
const FLAGS: [string, string][] = [
  ['week_target', '--target'],
  ['weekday_reserve', '--reserve'],
  ['five_hour_limit', '--five-hour'],
  ['quota_file', '--file'],
]

const reasonOf = (error: unknown) =>
  String(error).replace(/\s+/g, ' ').slice(0, 80)

export const at = (root: string, relative: string) =>
  `${root.replace(/[\\/]+$/, '')}/${relative}`

// `$.session.root()` may answer `D:\work\x` where git prints `D:/work/x`: paths
// are compared in one spelling.
export const samePath = (left: string, right: string) => {
  const spell = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')

  return spell(left).toLowerCase() === spell(right).toLowerCase()
}

// An option with no value, or one the host left as `${user_config.x}`, is not
// passed: the script then uses its own default.
export const optionArgs = (options: PluginOptions): string[] =>
  FLAGS.flatMap(([name, flag]) => {
    const value = options[name]
    if (value === undefined || Array.isArray(value)) {
      return []
    }
    const text = String(value).trim()

    return text === '' || /^\$\{.*\}$/.test(text) ? [] : [flag, text]
  })

// The three readers below are function declarations: the engine follows `$`
// into an imported function only when it is one.
export function hasProfile($: Engine, root: string): Promise<boolean> {
  return $.fs.exists(at(root, PROFILE)).catch(() => false)
}

const sectionOf = (lines: string[], title: RegExp): string[] => {
  const start = lines.findIndex(
    line => /^#{1,6}\s/.test(line) && title.test(line),
  )
  if (start < 0) {
    return []
  }
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^#{1,6}\s/.test(line))

  return end < 0 ? rest : rest.slice(0, end)
}

// A bullet may continue on indented lines.
const bulletsOf = (section: string[]): string[] => {
  const bullets: string[] = []
  for (const line of section) {
    if (/^[-*]\s/.test(line)) {
      bullets.push(line.slice(2).replace(/[`*]/g, '').trim())
    } else if (/^\s+\S/.test(line)) {
      const last = bullets.pop()
      if (last !== undefined) {
        bullets.push(`${last} ${line.replace(/[`*]/g, '').trim()}`)
      }
    }
  }

  return bullets
}

// Rule D-2: a `Q<n>` in a bullet that is not an answer waits; one in an answer
// bullet is settled, even if an earlier bullet still lists it.
export const readQuestions = (lines: string[]): string[] => {
  const ids = (text: string) => text.match(/\bQ\d+\b/g) ?? []
  const pending: string[] = []
  const answered = new Set<string>()
  for (const bullet of bulletsOf(sectionOf(lines, /question/i))) {
    // "Répondu", "Répondue(s)", "Répondus" and "Answered", whatever follows.
    if (/^(répondu(?:e|s|es)?|answered)(?![\p{L}])/iu.test(bullet)) {
      ids(bullet).forEach(id => answered.add(id))
    } else {
      pending.push(...ids(bullet))
    }
  }

  return [...new Set(pending)].filter(id => !answered.has(id))
}

// Same test as scripts/audio-guard.js.
const isAudioOn = (lines: string[]) =>
  lines.some(
    line =>
      /^\s*(?:-\s+)?audio report: on/i.test(line) &&
      !/edge-tts missing/i.test(line),
  )

export const worktreesOf = (porcelain: string): LightWorktree[] =>
  porcelain
    .split(/\r?\n\r?\n/)
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => /^worktree /m.test(block))
    .map(({ block, index }) => ({
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? '(detached)',
      path: (/^worktree (.+)$/m.exec(block)?.[1] ?? '').replace(/\\/g, '/'),
      head: (/^HEAD (\w+)$/m.exec(block)?.[1] ?? '').slice(0, 7),
      isMain: index === 0,
    }))

// Runs one light sensor. A failure adds one line and keeps the sensor's last
// value with its own time.
const sense = async <T,>(
  label: string,
  now: number,
  previous: Sensed<T> | null | undefined,
  failures: string[],
  read: () => Promise<T>,
): Promise<Sensed<T> | null> => {
  try {
    return { value: await read(), at: now }
  } catch (error) {
    failures.push(`${label}: ${reasonOf(error)}`)

    return previous ?? null
  }
}

// The light reading of `root` (the project the pane shows). Nothing here
// starts node or spends a model token.
export async function readLight(
  $: Engine,
  root: string,
  previous: Light | null,
): Promise<Light> {
  // `root` is what the session gave, `project` what git says the repository
  // is: the previous reading is kept only for the same session root.
  const keep = previous !== null && samePath(previous.root, root) ? previous : null
  const now = await $.clock.now()
  const failures: string[] = []

  const worktrees = await sense(
    'git',
    now,
    keep?.worktrees,
    failures,
    async () => {
      const run = await $.process.run(['git', 'worktree', 'list', '--porcelain'], {
        cwd: root,
        env: GIT_ENV,
      })
      if (run.exitCode !== 0) {
        throw new Error(`exit ${run.exitCode}`)
      }

      return worktreesOf(run.stdout)
    },
  )
  const agents = await sense('agents', now, keep?.agents, failures, async () => {
    const roster: AgentInfo[] = await $.agent.list()
    const seen = new Map(
      (keep?.agents?.value ?? []).map(agent => [agent.id, agent.firstSeenAt]),
    )

    return roster
      .filter(agent => !FINISHED.includes(agent.status))
      .map(
        (agent): LightAgent => ({
          id: agent.id,
          type: agent.type,
          description: agent.description,
          status: agent.status,
          firstSeenAt: seen.get(agent.id) ?? now,
        }),
      )
  })
  const usage = await sense('usage', now, keep?.usage, failures, async () => {
    // No `breakdown`: with it the call sends one request per tool.
    const reading = await $.session.usage()
    const value: LightUsage = {
      rateLimits: reading.rateLimits
        .filter(limit => limit.kind === 'five_hour' || limit.kind === 'seven_day')
        .map(limit => ({
          kind: limit.kind,
          percentUsed: limit.percentUsed,
          resetsAt: limit.resetsAt,
        })),
      contextPercent: reading.context.percent,
    }

    return value
  })
  const state = await sense('state', now, keep?.state, failures, async () => {
    const path = at(root, STATE_FILE)
    if (!(await $.fs.exists(path))) {
      return { exists: false, pending: [], isAudioOn: false } as LightState
    }
    const text = await $.fs.read(path)
    const lines = String(text).split(/\r?\n/)

    return {
      exists: true,
      pending: readQuestions(lines),
      isAudioOn: isAudioOn(lines),
    } as LightState
  })

  // The first worktree is the repository's own checkout, wherever the session
  // was started from.
  const main = worktrees?.value.find(tree => tree.isMain)

  return {
    project: main?.path ?? root,
    root,
    at: now,
    worktrees,
    agents,
    usage,
    state,
    failures,
  }
}

const isOrchStatus =(json: unknown): json is OrchStatus =>
  typeof json === 'object' && json !== null && (json as { v?: unknown }).v === 1

// One `orch-status --json` run. The previous good value stays when this run
// fails; the failure is one line, replaced by the next run.
export async function readHeavy(
  $: Engine,
  root: string,
  options: PluginOptions,
  previous: Heavy | null,
): Promise<Heavy> {
  const keep =
    previous !== null && samePath(previous.project, root) ? previous.status : null
  const fail = (line: string): Heavy => ({
    project: root,
    status: keep,
    failure: `orch-status: ${line}`,
  })
  let out: { exitCode: number; stdout: string }
  try {
    out = await $.process.run(
      [
        'node',
        `${$.plugin.root}/bin/orch-status`,
        '--json',
        ...optionArgs(options),
      ],
      { cwd: root, env: GIT_ENV, timeoutMs: HEAVY_TIMEOUT_MS },
    )
  } catch (error) {
    return fail(reasonOf(error))
  }
  let json: unknown
  try {
    json = JSON.parse(out.stdout.trim())
  } catch {
    return fail('unreadable output')
  }
  if (!isOrchStatus(json)) {
    return fail('unreadable output')
  }
  const message = (json as { error?: unknown }).error
  if (typeof message === 'string') {
    return fail(reasonOf(message))
  }
  if (out.exitCode !== 0) {
    return fail(`exit ${out.exitCode}`)
  }

  return {
    project: root,
    status: { value: json, at: await $.clock.now() },
    failure: null,
  }
}
