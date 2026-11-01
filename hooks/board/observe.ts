import type {
  AgentInfo,
  AgentSpawnInput,
  EngineInterface,
  SessionMessage,
  ToolUseSummary,
} from 'claude-code'

import type {
  Activity,
  AgentBranch,
  AgentTool,
  BriefRecord,
  CheckItem,
  CheckResult,
} from '../../types/board'
import { BRIEF_KEEP, BRIEF_LIMIT, missionOf, parseBrief, safeBranch } from './brief'
import { FINISHED, at } from './sensors'

type Engine = EngineInterface

const STORE_PREFIX = 'brief:'
// Same variable as the other git reads of the board: a read must not take the
// index lock a running agent may need.
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }
const SUMMARY_CUT = 120
const TOOLS_SHOWN = 9
const FILES_SHOWN = 8
const CHECK_TIMEOUT_MS = 600_000
const EDITS = ['Edit', 'Write', 'NotebookEdit']
const CHECK_COMMAND = /orch-trust --commands checks|agent-check/

const reasonOf = (error: unknown) =>
  String(error).replace(/\s+/g, ' ').slice(0, 120)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// One line, without control characters, whatever the tool was given.
const oneLine = (text: string, length = SUMMARY_CUT) => {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()

  return clean.length > length ? `${clean.slice(0, length - 1).trimEnd()}…` : clean
}

// The command of a Bash call, the path of a file tool, the pattern of a search.
export const summaryOf = (use: ToolUseSummary): string => {
  const input = use.input
  const pick = ['command', 'file_path', 'notebook_path', 'pattern', 'path', 'url', 'description', 'prompt']
    .map(key => input[key])
    .find(value => typeof value === 'string' && value !== '')

  return typeof pick === 'string' ? oneLine(pick) : ''
}

// Rule R4: setup until the first edit, implement after it, checks from the
// first Bash that runs them. Only a morty has steps.
export const stepOf = (uses: ToolUseSummary[]): string => {
  let step = 'setup'
  for (const use of uses) {
    if (use.tool === 'Bash' && CHECK_COMMAND.test(String(use.input.command ?? ''))) {
      step = 'checks'
    } else if (step === 'setup' && EDITS.includes(use.tool)) {
      step = 'implement'
    }
  }

  return step
}

export const isMorty = (type: string) => /(^|:)morty$/.test(type)

// A worktree made for an agent sits at `.claude/worktrees/agent-<agentId>`.
export const worktreeOf = (
  project: string,
  agentId: string,
  trees: { branch: string; path: string }[],
): { path: string; branch: string | null } => {
  const found = trees.find(tree =>
    tree.path.replace(/\\/g, '/').replace(/\/+$/, '').endsWith(`/agent-${agentId}`),
  )

  return found === undefined
    ? { path: at(project, `.claude/worktrees/agent-${agentId}`), branch: null }
    : { path: found.path, branch: found.branch }
}

// Rule R1. The store keeps the 40 most recent briefs: the new one always
// stays, the oldest of the others go first.
export async function captureBrief(
  $: Engine,
  input: AgentSpawnInput,
  agentId: string,
  model: string,
): Promise<void> {
  const text = input.prompt.slice(0, BRIEF_LIMIT)
  const record: BriefRecord = {
    at: await $.clock.now(),
    type: input.subagentType,
    model,
    description: input.description,
    branch: parseBrief(text).branch,
    mission: missionOf(input.description),
    text,
  }
  const key = `${STORE_PREFIX}${agentId}`
  await $.store.set(key, record)
  const others = (await $.store.keys()).filter(name => name.startsWith(STORE_PREFIX) && name !== key)
  if (others.length < BRIEF_KEEP) {
    return
  }
  const dated = await Promise.all(
    others.map(async (name, index) => {
      const stored = await $.store.get(name)

      return { name, index, at: isRecord(stored) && typeof stored.at === 'number' ? stored.at : 0 }
    }),
  )
  // Equal times keep the order the store lists them in.
  dated.sort((one, other) => other.at - one.at || other.index - one.index)
  for (const old of dated.slice(BRIEF_KEEP - 1)) {
    await $.store.delete(old.name)
  }
}

const isBrief = (value: unknown): value is BriefRecord =>
  isRecord(value) && typeof value.text === 'string' && typeof value.at === 'number'

// The captured brief, or, for an agent launched before the mod loaded, its
// first user message. Null when neither can be read.
export async function readBrief(
  $: Engine,
  agent: { id: string; type: string; description: string },
): Promise<BriefRecord | null> {
  try {
    const stored = await $.store.get(`${STORE_PREFIX}${agent.id}`)
    if (isBrief(stored)) {
      return stored
    }
  } catch {
    // The store is unreadable: the first message is the next best.
  }
  try {
    const messages = await $.session.messages({ agentId: agent.id })
    const first = Array.isArray(messages)
      ? messages.find((message: SessionMessage) => message.role === 'user' && message.text !== '')
      : undefined
    if (first === undefined) {
      return null
    }
    const text = first.text.slice(0, BRIEF_LIMIT)

    return {
      at: await $.clock.now(),
      type: agent.type,
      model: '',
      description: agent.description,
      branch: parseBrief(text).branch,
      mission: missionOf(agent.description),
      text,
    }
  } catch {
    return null
  }
}

// Rule R3. What the agent did, from its transcript; the roster call being
// refused is "unavailable", the previous reading standing.
export async function readActivity(
  $: Engine,
  agent: { id: string; type: string },
  startedAt: number,
  previous: Activity | undefined,
): Promise<Activity> {
  const now = await $.clock.now()
  let messages: SessionMessage[] | { deny: string }
  try {
    messages = await $.session.messages({ agentId: agent.id })
  } catch (error) {
    messages = { deny: reasonOf(error) }
  }
  if (!Array.isArray(messages)) {
    return {
      lastTool: previous?.lastTool ?? '',
      calls: previous?.calls ?? 0,
      step: previous?.step ?? '',
      startedAt,
      updatedAt: now,
      lastSummary: previous?.lastSummary,
      tools: previous?.tools,
      unavailable: true,
    }
  }
  const uses = messages.flatMap(message => (message.role === 'assistant' ? message.toolUses : []))
  const last = uses.at(-1)
  const tools = uses.slice(-TOOLS_SHOWN).map((use, index, shown): AgentTool => ({
    tool: use.tool,
    summary: summaryOf(use),
    state:
      use.isError === true
        ? 'error'
        : index === shown.length - 1 && use.text === undefined && use.result === undefined
          ? 'running'
          : 'ok',
  }))

  return {
    lastTool: last?.tool ?? '',
    calls: uses.length,
    step: isMorty(agent.type) ? stepOf(uses) : '',
    startedAt,
    updatedAt: now,
    lastSummary: last === undefined ? '' : summaryOf(last),
    tools,
  }
}

// Rule R5, for the cards: commits ahead of the base in the agent's worktree.
// Null when git cannot say (no worktree, no base known yet).
export async function readAhead(
  $: Engine,
  path: string,
  base: string | undefined,
): Promise<number | null> {
  if (base === undefined || !safeBranch(base)) {
    return null
  }
  try {
    const run = await $.process.run(['git', 'rev-list', '--count', `${base}..HEAD`], {
      cwd: path,
      env: GIT_ENV,
    })
    const count = Number(run.stdout.trim())

    return run.exitCode === 0 && Number.isInteger(count) ? count : null
  } catch {
    return null
  }
}

// Rule R5, when the detail opens: the files changed against the base and the
// number of files not committed.
export async function readBranch(
  $: Engine,
  path: string,
  base: string | undefined,
): Promise<AgentBranch> {
  const now = await $.clock.now()
  let files: AgentBranch['files'] = null
  let total: number | null = null
  let dirty: number | null = null
  if (base !== undefined && safeBranch(base)) {
    try {
      const run = await $.process.run(['git', 'diff', '--numstat', `${base}...HEAD`], {
        cwd: path,
        env: GIT_ENV,
      })
      if (run.exitCode === 0) {
        const lines = run.stdout.split(/\r?\n/).filter(line => line.trim() !== '')
        total = lines.length
        files = lines.slice(0, FILES_SHOWN).map(line => {
          const [added, removed, ...name] = line.split('\t')

          return {
            path: name.join('\t'),
            added: /^\d+$/.test(added) ? Number(added) : null,
            removed: /^\d+$/.test(removed) ? Number(removed) : null,
          }
        })
      }
    } catch {
      // Left null: the pane says it could not be read.
    }
  }
  try {
    const run = await $.process.run(['git', 'status', '--porcelain'], { cwd: path, env: GIT_ENV })
    if (run.exitCode === 0) {
      dirty = run.stdout.split(/\r?\n/).filter(line => line.trim() !== '').length
    }
  } catch {
    // Left null.
  }

  return { at: now, files, total, dirty }
}

export async function runningAgents($: Engine): Promise<AgentInfo[]> {
  return (await $.agent.list()).filter(agent => !FINISHED.includes(agent.status))
}

const CHECK_STATES = ['ok', 'fail', 'skip']

// Rule R6. One `agent-check --json` run, never `--merged`. Every way it can
// fail to say something is an `error` result with its reason, not a verdict.
export async function runAgentCheck($: Engine, root: string, branch: string): Promise<CheckResult> {
  const fail = async (error: string): Promise<CheckResult> => ({
    at: await $.clock.now(),
    state: 'error',
    checks: [],
    error,
  })
  if (!safeBranch(branch)) {
    return fail('invalid branch name')
  }
  let out: { exitCode: number; stdout: string }
  try {
    out = await $.process.run(['node', `${$.plugin.root}/bin/agent-check`, branch, '--json'], {
      cwd: root,
      timeoutMs: CHECK_TIMEOUT_MS,
    })
  } catch (error) {
    return fail(reasonOf(error))
  }
  let json: unknown
  try {
    json = JSON.parse(out.stdout.trim())
  } catch {
    return fail(out.exitCode === 0 ? 'unreadable output' : `exit ${out.exitCode}, unreadable output`)
  }
  if (!isRecord(json) || json.v !== 1) {
    return fail('unreadable output')
  }
  if (typeof json.error === 'string') {
    return fail(oneLine(json.error.split('\n')[0], SUMMARY_CUT))
  }
  const verdict = json.verdict
  const list = json.checks
  if (
    (verdict !== 'green' && verdict !== 'needs-fixes') ||
    !Array.isArray(list) ||
    !list.every(item => isRecord(item) && typeof item.name === 'string' && CHECK_STATES.includes(String(item.state)))
  ) {
    return fail('unreadable output')
  }
  const checks = list.map(
    (item): CheckItem => ({
      name: String(item.name),
      state: item.state as CheckItem['state'],
      detail: typeof item.detail === 'string' ? item.detail : '',
      lines: Array.isArray(item.lines) ? item.lines.map(String) : [],
    }),
  )

  return { at: await $.clock.now(), state: 'done', verdict, checks }
}
