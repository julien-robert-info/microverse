import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Kit = Parameters<TestBody>

const pane = (surface: 'terminal' | 'desktop', bodyColumns: number) =>
  ({
    plugin: 'microverse',
    component: 'Pane',
    requestId: 'microverse-board',
    surface,
    props: {
      title: 'Board',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

const SURFACES = ['terminal', 'desktop'] as const
const WIDE = 140
const NARROW = 60
const ROOT = '/work/demo'
const START = 1_767_000_000_000
// Seconds, as `git show --format=%ct` prints them.
const DATES: Record<string, number> = {
  aaaaaaa: 1_766_000_000,
  bbbbbbb: 1_766_500_000,
  ccccccc: 1_766_900_000,
}

const run = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const done = () => ({
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
})

type Tree = { branch: string; id: string; isMerged?: boolean }
type Roster = { id: string; type: string; description: string }
type Run = {
  agentId: string
  type: string
  model: string
  description: string
  started: number
  ended: number
  cost: number
}

type Scene = {
  // CLAUDE.local.md
  state: string
  // notes/<name>
  notes?: Record<string, string>
  // NOTES.local.md
  journal?: string
  // Worktrees of agents, at `.claude/worktrees/agent-<id>`.
  trees?: Tree[]
  free?: string[]
  agents?: Roster[]
  runs?: Run[]
  // Hashes that are ancestors of the base.
  ancestors?: string[]
  store?: Record<string, unknown>
}

const porcelain = (trees: Tree[]) =>
  [
    `worktree ${ROOT}\nHEAD 1111111aaaa\nbranch refs/heads/main\n`,
    ...trees.map(
      tree =>
        `worktree ${ROOT}/.claude/worktrees/agent-${tree.id}\nHEAD 2222222bbbb\nbranch refs/heads/${tree.branch}\n`,
    ),
  ].join('\n')

const status = (scene: Scene) =>
  JSON.stringify({
    v: 1,
    project: ROOT,
    base: { name: 'main', tip: '1111111' },
    lastReport: null,
    state: { exists: true, sections: [] },
    worktrees: (scene.trees ?? []).map(tree => ({
      branch: tree.branch,
      path: `${ROOT}/.claude/worktrees/agent-${tree.id}`,
      rel: `.claude/worktrees/agent-${tree.id}`,
      merged: tree.isMerged === true,
      last: null,
      dirty: false,
    })),
    free: (scene.free ?? []).map(branch => ({ branch, sha: '3333333', subject: 'work' })),
    report: null,
    agents: {
      since: START,
      runs: (scene.runs ?? []).map(one => ({
        ...one,
        requests: 1,
        tokens: { input: 1, write5m: 0, write1h: 0, read: 0, output: 1 },
        advisor: { calls: 0, cost: 0 },
        finished: true,
      })),
      total: { cost: 1, advisor: { calls: 0, cost: 0 } },
    },
    quota: { error: 'none' },
    context: { error: 'none' },
  })

type Reads = { journal: number; state: number; notes: string[] }

// The world under the board for a scene. `reads` counts what the light sensor
// reads, `ancestorCalls` the `merge-base` runs.
// The engine resolves a path against the host (a drive letter and backslashes
// on Windows): files are keyed by their POSIX spelling.
const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const world = (on: Kit[1], scene: Scene) => {
  const reads: Reads = { journal: 0, state: 0, notes: [] }
  const ancestorCalls: string[] = []
  const files: Record<string, string> = {
    [`${ROOT}/CLAUDE.local.md`]: scene.state,
    ...(scene.journal === undefined ? {} : { [`${ROOT}/NOTES.local.md`]: scene.journal }),
    ...Object.fromEntries(
      Object.entries(scene.notes ?? {}).map(([name, text]) => [`${ROOT}/notes/${name}`, text]),
    ),
  }

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.root', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('fs.exists', (_, e) => ({
    value: e.path.endsWith('profile.json') || norm(e.path) in files,
  }))
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: (files[norm(e.path)] ?? '').length, mtimeMs: 7, isLink: false },
  }))
  on('fs.list', (_, e) => ({
    value: Object.entries(files)
      .filter(([path]) => path.startsWith(`${norm(e.path)}/`))
      .map(([path, text]) => ({
        name: path.slice(norm(e.path).length + 1),
        kind: 'file' as const,
        size: text.length,
        mtimeMs: 7,
        isLink: false,
      })),
  }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('NOTES.local.md')) {
      reads.journal += 1
    } else if (e.path.endsWith('CLAUDE.local.md')) {
      reads.state += 1
    } else {
      reads.notes.push(e.path)
    }

    return { value: files[norm(e.path)] ?? '' }
  })
  on('store.get', (_, e) => ({ value: scene.store?.[e.key] }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: 1 }, rateLimits: [] },
  }))
  on('agent.list', () => ({
    value: (scene.agents ?? []).map(agent => ({ ...agent, status: 'running' })),
  }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git' && e.argv[1] === 'worktree') {
      return run(porcelain(scene.trees ?? []))
    }
    if (e.argv[0] === 'git' && e.argv[1] === 'merge-base') {
      ancestorCalls.push(e.argv[3])

      return run('', (scene.ancestors ?? []).includes(e.argv[3]) ? 0 : 1)
    }
    if (e.argv[0] === 'git' && e.argv[1] === 'show') {
      return run(`${DATES[e.argv[4]] ?? 1}\n`)
    }
    if (e.argv[1]?.endsWith('statusline.js') === true) {
      return run('')
    }

    return run(status(scene))
  })
  mock.clock(on, { now: START })

  return { reads, ancestorCalls }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30))

const start = async ($: Kit[0], on: Kit[1], scene: Scene) => {
  const seen = world(on, scene)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.turn.complete(done())
  await settle()

  return seen
}

type Mounted = Awaited<ReturnType<Kit[0]['ui']['mount']>>

const TABLE = (...rows: string[]) => ['| Id | Branche | État |', '|---|---|---|', ...rows].join('\n')
const STATE = TABLE('| E7 | `feat/seven` | rendu |')
const SCENE: Scene = { state: STATE, trees: [{ branch: 'feat/seven', id: 'm1' }] }

const shows = async (ui: Mounted, text: RegExp) =>
  (await ui.find({ type: 'Text', text })) !== undefined

const LABELS = ['Design', 'Brief', 'Building', 'Review', 'To merge', 'Merged']

for (const surface of ['terminal', 'desktop'] as const) {
  test(`T1 a detail at 140 columns: the drawer is 40 % and nothing is forced wider (${surface})`, async ($, on) => {
    await start($, on, SCENE)
    const ui = await $.ui.mount(pane(surface, 140))
    await ui.press({ key: 'open:E7' })
    await settle()

    expect((await ui.find({ key: 'drawer' }))?.props).toMatchObject({
      width: '40%',
      flexShrink: 0,
      minWidth: 0,
      overflow: 'hidden',
    })
    expect((await ui.find({ key: 'main' }))?.props).toMatchObject({
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      overflow: 'hidden',
    })
    await ui.unmount()
  })

  test(`T2 no detail at 140 columns: no drawer and no placeholder (${surface})`, async ($, on) => {
    await start($, on, SCENE)
    const ui = await $.ui.mount(pane(surface, 140))

    expect(await ui.find({ key: 'layout:wide' })).toBeDefined()
    expect(await ui.find({ key: 'main' })).toBeDefined()
    expect(await ui.find({ key: 'drawer' })).toBeUndefined()
    expect(await shows(ui, /Nothing selected\./)).toBe(false)
    await ui.unmount()
  })

  test(`T3 120 columns is the narrow layout (${surface})`, async ($, on) => {
    await start($, on, SCENE)
    const ui = await $.ui.mount(pane(surface, 120))

    expect(await ui.find({ key: 'layout:narrow' })).toBeDefined()
    expect(await ui.find({ key: 'layout:wide' })).toBeUndefined()
    await ui.unmount()
  })

  test(`T4 a mission open at 140 columns folds the table, closed it has six columns (${surface})`, async ($, on) => {
    await start($, on, SCENE)
    const ui = await $.ui.mount(pane(surface, 140))

    for (const label of LABELS) {
      expect(await shows(ui, new RegExp(`^${label} \\(\\d+\\)$`))).toBe(true)
    }
    expect(await ui.find({ key: 'fold:merged' })).toBeUndefined()

    await ui.press({ key: 'open:E7' })
    await settle()
    expect(await ui.find({ key: 'fold:merged' })).toBeDefined()
    expect(await shows(ui, /^Building \(\d+\)$/)).toBe(false)
    await ui.unmount()
  })

  test(`T5 the footer shows the pane width (${surface})`, async ($, on) => {
    await start($, on, SCENE)
    const ui = await $.ui.mount(pane(surface, 140))

    expect(await shows(ui, /^140 cols$/)).toBe(true)
    await ui.unmount()
  })
}

