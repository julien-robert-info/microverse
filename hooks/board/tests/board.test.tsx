import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Kit = Parameters<TestBody>

const PANE = {
  plugin: 'microverse',
  component: 'Pane',
  requestId: 'microverse-board',
  props: {
    title: 'Board',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const
const ROOT = '/work/demo'
const START = 1_767_000_000_000

const WORKTREES = [
  `worktree ${ROOT}`,
  'HEAD 1111111aaaa',
  'branch refs/heads/main',
  '',
].join('\n')

const run = (stdout: string, exitCode = 0) => ({
  value: {
    exitCode,
    stdout,
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})

const agentRun = (model: string, cost: number) => ({
  agentId: `${model}-${cost}`,
  type: 'demo:worker',
  model,
  description: 'task',
  started: START,
  ended: START,
  requests: 1,
  tokens: { input: 1, write5m: 0, write1h: 0, read: 0, output: 1 },
  cost,
  advisor: { calls: 0, cost: 0 },
  finished: true,
})

// A `orch-status --json` answer (schema v1) for the demo project.
const status = (more: number) =>
  JSON.stringify({
    v: 1,
    project: ROOT,
    base: { name: 'main', tip: '1111111' },
    lastReport: null,
    state: { exists: true, sections: [] },
    worktrees: [],
    free: [],
    report: null,
    agents: {
      since: START,
      runs: [agentRun('claude-opus-4', 3), agentRun('claude-sonnet-5', 1)],
      total: { cost: 4, advisor: { calls: 0, cost: 0 } },
    },
    quota: {
      counters: { five: null, week: null },
      limits: { target: 98, reserve: 30, fiveHour: 90 },
      period: null,
      pace: { expected: 40, actual: 35, delta: -5, left: 63 },
      running: { total: 1, others: 0 },
      agentCost: { points: 2, runs: null },
      advice: { level: 'launch', text: 'Launch', more },
      warnings: [],
      history: [],
    },
    context: {
      session: 's1',
      model: 'm',
      tokens: 85_000,
      threshold: 150_000,
      percent: 57,
      verdict: 'Fine',
    },
  })

const done = (agentId?: string) => ({
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  ...(agentId === undefined ? {} : { agentId }),
})

type World = {
  // argv of every `orch-status` run, in order.
  heavy: string[][]
  opens: number
  commands: number
  every: number
  gitRuns: number
}

// The world under the board: a project with a profile, a `git`, a roster and
// a rate-limit reading. `heavy` answers `orch-status`.
const world = (
  on: Kit[1],
  options: {
    profile?: boolean
    surfaces?: readonly string[]
    heavy?: (argv: readonly string[]) => unknown
    clock?: boolean
    // What `$.session.root()` answers, and what `git worktree list` prints.
    root?: string
    git?: () => unknown
    // The pane is listed as open, so the 30 s light timer reads.
    paneOpen?: boolean
    // Content of CLAUDE.local.md.
    state?: string
  } = {},
) => {
  const seen: World = { heavy: [], opens: 0, commands: 0, every: 0, gitRuns: 0 }
  const {
    profile = true,
    surfaces = ['desktop'],
    heavy = () => run(status(2)),
    root = ROOT,
    git = () => run(WORKTREES),
    paneOpen = false,
    state = '',
  } = options

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.root', () => ({ value: root }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('fs.exists', (_, e) => ({
    value: profile || !e.path.endsWith('profile.json'),
  }))
  on('fs.read', () => ({ value: state }))
  on('command.register', () => {
    seen.commands += 1

    return { value: { command: 'board' } }
  })
  on('ui.open', () => {
    seen.opens += 1

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: paneOpen ? [{ id: 'microverse-board', title: 'Board' }] : [],
  }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') {
      seen.gitRuns += 1

      return git()
    }
    seen.heavy.push([...e.argv])

    return heavy(e.argv)
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 78, resetsAt: '2026-01-01T22:40:00Z' },
        { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-01-04T09:00:00Z' },
      ],
    },
  }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', type: 'demo:worker', description: 'task', status: 'running' },
      { id: 'a2', type: 'demo:worker', description: 'old', status: 'completed' },
    ],
  }))
  if (options.clock === false) {
    on('clock.now', () => ({ value: START }))
    on('clock.every', () => {
      seen.every += 1

      return { value: undefined }
    })

    return { seen, clock: undefined }
  }

  return { seen, clock: mock.clock(on, { now: START }) }
}

test('the cockpit draws pace, context, series cost and agents', async ($, on) => {
  world(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.turn.complete(done())
  await new Promise(resolve => setTimeout(resolve, 20))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /^demo$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Room for 2 more agents/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /expected 40 % · actual 35 %/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /57 %/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /85k of 150k tokens/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$4\.00 · 2 runs/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Opus 75 % · Sonnet 25 %/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Agents \(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /78 % 5 h window/ })).toBeDefined()
    await ui.unmount()
  }
})

test('with no profile nothing runs and nothing is registered', async ($, on) => {
  const { seen } = world(on, { profile: false, clock: false })

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.turn.complete(done())
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(seen.gitRuns).toBe(0)
  expect(seen.heavy).toHaveLength(0)
  expect(seen.every).toBe(0)
  expect(seen.commands).toBe(0)
  expect(seen.opens).toBe(0)
})

test('a subagent turn does not launch orch-status', async ($, on) => {
  // A terminal session opens no pane at start, so only turns can launch it.
  const { seen, clock } = world(on, { surfaces: ['terminal'] })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.turn.complete(done('a1'))
  await clock?.settle()

  expect(seen.heavy).toHaveLength(0)

  await $.turn.complete(done())
  await clock?.settle()

  expect(seen.heavy).toHaveLength(1)
})

test('orch-status runs at most once per 120 s and never twice at once', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let first = true
  const { seen, clock } = world(on, {
    heavy: () => {
      if (!first) {
        return run(status(1))
      }
      first = false

      return gate.then(() => run(status(1)))
    },
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.turn.complete(done())
  await clock?.settle()
  // The first run is still waiting on its gate.
  expect(seen.heavy).toHaveLength(1)

  await clock?.advance(130_000)
  await $.turn.complete(done())
  await clock?.settle()
  expect(seen.heavy).toHaveLength(1)

  release()
  await clock?.settle()
  await $.turn.complete(done())
  await clock?.settle()
  // The first run started 130 s ago: this one is due.
  expect(seen.heavy).toHaveLength(2)

  await clock?.advance(30_000)
  await $.turn.complete(done())
  await clock?.settle()
  expect(seen.heavy).toHaveLength(2)
})

test('a failing orch-status keeps the previous data and adds one line', async ($, on) => {
  const answers = [
    () => run(status(2)),
    () => ({ deny: 'node not found' }),
    () => run('{"v":2}'),
  ]
  const { clock } = world(on, { heavy: () => answers.shift()?.() })

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.turn.complete(done())
  await clock?.settle()

  const seen = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const found = {
      data: (await ui.find({ type: 'Text', text: /85k of 150k tokens/ })) !== undefined,
      denied: (await ui.find({ type: 'Text', text: /! orch-status: .*node not found/ })) !== undefined,
      unreadable:
        (await ui.find({ type: 'Text', text: /! orch-status: unreadable output/ })) !== undefined,
    }
    await ui.unmount()

    return found
  }

  expect(await seen()).toEqual({ data: true, denied: false, unreadable: false })

  await clock?.advance(130_000)
  await $.turn.complete(done())
  await clock?.settle()
  expect(await seen()).toEqual({ data: true, denied: true, unreadable: false })

  await clock?.advance(130_000)
  await $.turn.complete(done())
  await clock?.settle()
  expect(await seen()).toEqual({ data: true, denied: false, unreadable: true })
})

test('the pane opens by itself only on Desktop', async ($, on) => {
  const terminal = world(on, { surfaces: ['terminal'], clock: false })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(terminal.seen.opens).toBe(0)
  expect(terminal.seen.commands).toBe(1)
})

test('the pane opens by itself with desktop in the surfaces', async ($, on) => {
  const desktop = world(on, { surfaces: ['terminal', 'desktop'], clock: false })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(desktop.seen.opens).toBe(1)
})

test(
  'options become flags only when set',
  {
    options: {
      week_target: 95,
      weekday_reserve: '',
      five_hour_limit: 85,
      quota_file: '',
    },
  },
  async ($, on) => {
    const { seen, clock } = world(on)

    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await $.turn.complete(done())
    await clock?.settle()

    expect(seen.heavy[0]?.slice(2)).toEqual(['--json', '--target', '95', '--five-hour', '85'])
  },
)

test(
  'an empty option is not passed',
  {
    options: {
      week_target: '',
      weekday_reserve: '',
      five_hour_limit: '',
      quota_file: '',
    },
  },
  async ($, on) => {
    const { seen, clock } = world(on)

    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await $.turn.complete(done())
    await clock?.settle()

    expect(seen.heavy[0]?.slice(2)).toEqual(['--json'])
  },
)

test('a session root spelled with backslashes keeps the light reading between runs', async ($, on) => {
  // Git prints forward slashes, the session root may not.
  const { clock } = world(on, {
    root: 'D:\\work\\demo',
    git: () => run(['worktree D:/work/demo', 'HEAD 1111111aaaa', 'branch refs/heads/main', ''].join('\n')),
    paneOpen: true,
  })

  await $.session.start({ cwd: 'D:\\work\\demo', surface: 'desktop', isInteractive: true })
  await clock?.settle()
  await clock?.advance(300_000)
  await clock?.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The agent was first seen at the start: five minutes, not zero.
  expect(await ui.find({ type: 'Text', text: /running · task · 5 min/ })).toBeDefined()
  await ui.unmount()
})

const QUESTIONS = (...bullets: string[]) =>
  ['# State', '', '## Questions', '', '- Q41 which one?', ...bullets, '', '## Next', ''].join('\n')

const ANSWERS: [string, boolean][] = [
  ['', true],
  ['- Répondu le 2026-11-02 : Q41 a', false],
  ['- Répondue : Q41 a', false],
  ['- Répondues : Q41 a', false],
  ['- Répondus : Q41 a', false],
  ['- Answered: Q41 a', false],
  ['- Répondre à Q41 plus tard', true],
]

for (const [bullet, isPending] of ANSWERS) {
  test(`question Q41 with the bullet "${bullet}" is ${isPending ? 'waiting' : 'settled'}`, async ($, on) => {
    world(on, { state: QUESTIONS(...(bullet === '' ? [] : [bullet])) })
    await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const found = (await ui.find({ type: 'Text', text: /1 question needs you/ })) !== undefined
    await ui.unmount()

    expect(found).toBe(isPending)
  })
}

test('the body is one column below 110 and two above', async ($, on) => {
  world(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const wide = await $.ui.mount({
      ...PANE,
      surface,
      props: { ...PANE.props, bodyColumns: 140 },
    })
    expect(await wide.find({ key: 'layout:wide' })).toBeDefined()
    expect(await wide.find({ key: 'layout:narrow' })).toBeUndefined()
    await wide.unmount()

    const narrow = await $.ui.mount({
      ...PANE,
      surface,
      props: { ...PANE.props, bodyColumns: 60 },
    })
    expect(await narrow.find({ key: 'layout:narrow' })).toBeDefined()
    expect(await narrow.find({ key: 'layout:wide' })).toBeUndefined()
    await narrow.unmount()
  }
})
