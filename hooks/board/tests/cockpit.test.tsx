import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { WIDE_AT, renderCockpit } from '../cockpit'
import { lookFor, withLook } from '../kit'

type Kit = Parameters<TestBody>

const PANE = {
  plugin: 'microverse',
  component: 'Pane',
  requestId: 'microverse-board',
  props: {
    title: 'Board',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const
const ROOT = '/work/demo'
const START = 1_767_000_000_000
const HOUR = 3_600_000

const run = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type Shape = {
  level?: string
  text?: string
  more?: number
  tokens?: number
  counters?: boolean
  report?: boolean
  off?: string
}

// An `orch-status --json` answer with the parts the tests vary.
const status = (shape: Shape = {}) => {
  const {
    level = 'launch',
    text = 'Launch',
    more = 2,
    tokens = 85_000,
    counters = false,
    report = false,
    off,
  } = shape
  const agents = {
    since: START,
    runs: [
      {
        agentId: 'a',
        type: 'demo:worker',
        model: 'claude-opus-4',
        description: 'task',
        started: START,
        ended: START,
        requests: 1,
        tokens: { input: 1, write5m: 0, write1h: 0, read: 0, output: 1 },
        cost: 3,
        advisor: { calls: 0, cost: 0 },
        finished: true,
      },
    ],
    total: { cost: 3, advisor: { calls: 0, cost: 0 } },
  }
  const metered = {
    mode: 'metered',
    counters: counters
      ? {
          five: { used: 61, resetsAt: START + 2 * HOUR, observedAt: START, source: 'statusline' },
          week: { used: 33, resetsAt: START + 48 * HOUR, observedAt: START, source: 'statusline' },
        }
      : { five: null, week: null },
    limits: { target: 98, reserve: 30, fiveHour: 90 },
    period: null,
    pace: { expected: 40, actual: 35, delta: -5, left: 63 },
    running: { total: 1, others: 0 },
    agentCost: { points: 2, runs: null },
    advice: { level, text, more },
    warnings: [],
    history: [],
  }
  const quota =
    off === undefined
      ? metered
      : { v: 1, mode: 'off', reason: off, advice: { level: 'off', text: 'no quota: no pacing', more: 0 } }
  const context = {
    session: 's1',
    model: 'm',
    tokens,
    threshold: 150_000,
    percent: Math.round((tokens / 150_000) * 100),
    verdict: 'Fine',
  }

  return {
    v: 1,
    project: ROOT,
    base: { name: 'main', tip: '1111111' },
    lastReport: report ? { sha: 'abcdef1234567', line: 'Merge the secret subject' } : null,
    state: { exists: true, sections: [] },
    worktrees: [],
    free: [],
    report: report
      ? { since: { sha: '9999999', at: START }, base: 'main', merged: [], agents, quota, context }
      : null,
    agents,
    quota,
    context,
  }
}

const done = () => ({
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
})

const world = (on: Kit[1], shape: Shape = {}, limits = true) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.root', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: '' }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') {
      return run(`worktree ${ROOT}\nHEAD 1111111aaaa\nbranch refs/heads/main\n`)
    }
    if (e.argv[1]?.endsWith('statusline.js') === true) {
      return run('')
    }

    return run(JSON.stringify(status(shape)))
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, percent: 42 },
      rateLimits: limits
        ? [
            { kind: 'five_hour', percentUsed: 78, resetsAt: '2026-01-01T22:40:00Z' },
            { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-01-04T09:00:00Z' },
          ]
        : [],
    },
  }))
  on('agent.list', () => ({
    value: [{ id: 'a1', type: 'demo:worker', description: 'task', status: 'running' }],
  }))

  return mock.clock(on, { now: START })
}

const mounted = async (
  $: Kit[0],
  on: Kit[1],
  surface: string,
  shape: Shape = {},
  limits = true,
) => {
  world(on, shape, limits)
  await $.session.start({ cwd: ROOT, surface, isInteractive: true })
  await $.turn.complete(done())
  await new Promise(resolve => setTimeout(resolve, 20))

  return $.ui.mount({ ...PANE, surface })
}

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown }

const kids = (node: Node): Node[] =>
  [node.children, node.props?.children]
    .flat(Infinity)
    .filter((one): one is Node => typeof one === 'object' && one !== null)

test('T4 no coloured Text sits inside a Text on the desktop Cockpit', async () => {
  const ui = withLook(
    {
      Box: 'Box',
      Text: 'Text',
      Button: 'Button',
      Markdown: 'Markdown',
      Input: 'Input',
      Link: 'Link',
    } as never,
    lookFor('desktop', 'dark'),
  )
  const sensed = <T,>(value: T) => ({ value, at: START })
  const found: string[] = []
  const walk = (node: Node, inText: boolean) => {
    const isText = node.type === 'Text'
    if (isText && inText && node.props?.color !== undefined) {
      found.push(String(node.props.color))
    }
    for (const child of kids(node)) {
      walk(child, inText || isText)
    }
  }

  for (const columns of [60, WIDE_AT + 10]) {
    const tree = renderCockpit({
      ui: ui as never,
      columns,
      look: lookFor('desktop', 'dark'),
      actions: {} as never,
      board: {
        light: {
          project: ROOT,
          root: ROOT,
          at: START,
          worktrees: null,
          agents: sensed([
            { id: 'a1', type: 'demo:worker', description: 'task', status: 'running', firstSeenAt: START },
          ]),
          usage: sensed({ rateLimits: [{ kind: 'five_hour', percentUsed: 78 }] }),
          state: sensed({ exists: true, pending: ['Q1', 'Q2'], isAudioOn: true }),
          failures: ['one failure'],
        },
        heavy: { project: ROOT, status: sensed(status({ report: true }) as never), failure: null },
        view: { tab: 'cockpit', detail: null, toggled: [] },
        checks: {},
        answer: { pending: null, sent: [] },
        activity: {},
      },
    }) as Node
    walk(tree, false)
  }

  expect(found).toEqual([])
})

for (const surface of SURFACES) {
  test(`T5 the header line holds the date and the sha, not the report subject (${surface})`, async ($, on) => {
    const ui = await mounted($, on, surface, { report: true })
    const at = new Date(START)
    const pad = (value: number) => String(value).padStart(2, '0')
    const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`

    expect(await ui.find({ type: 'Text', text: `main · report ${stamp} · abcdef1` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /secret subject/ })).toBeUndefined()
    await ui.unmount()
  })

  test(`T6 the active tab is primary, the other secondary (${surface})`, async ($, on) => {
    const ui = await mounted($, on, surface)

    expect((await ui.find({ key: 'tab:cockpit' }))?.props?.variant).toBe('primary')
    expect((await ui.find({ key: 'tab:usage' }))?.props?.variant).toBe('secondary')
    await ui.unmount()
  })

  test(`T8 the context says what is left before auto-compaction (${surface})`, async ($, on) => {
    const ui = await mounted($, on, surface, { tokens: 123_000 })

    expect(await ui.find({ type: 'Text', text: /27k left before auto-compaction/ })).toBeDefined()
    await ui.unmount()
  })

  test(`T8 past the threshold it says by how much (${surface})`, async ($, on) => {
    const ui = await mounted($, on, surface, { tokens: 155_000 })

    expect(await ui.find({ type: 'Text', text: /over the threshold by 5k/ })).toBeDefined()
    await ui.unmount()
  })

  test(`T9 without rate limits both bars come from the quota counters (${surface})`, async ($, on) => {
    const ui = await mounted($, on, surface, { counters: true }, false)

    expect(await ui.find({ type: 'Text', text: /61 % 5 h window/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /33 % week/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No rate-limit reading/ })).toBeUndefined()
    await ui.unmount()
  })
}

for (const surface of SURFACES) {
  test(`T4 quota off: a grey line replaces the pace, no bars and no failure text (${surface})`, async ($, on) => {
    const ui = await mounted($, on, surface, { off: 'quota_mode=off', counters: true })
    const line = await ui.find({ type: 'Text', text: 'Quota off: quota_mode=off' })

    expect(line).toBeDefined()
    expect(line?.props?.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'Launch pace' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Pace unavailable/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /No rate-limit reading/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /5 h window|% week/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /running on the account/ })).toBeUndefined()
    await ui.unmount()
  })
}

for (const surface of SURFACES) {
  const levels: [string, string, string | undefined][] = [
    ['launch', 'success', undefined],
    ['smooth', 'warning', undefined],
    ['stop', 'error', undefined],
    ['off', undefined as never, 'dim'],
  ]

  for (const [level, color, dim] of levels) {
    test(`T7 advice "${level}" is ${dim === undefined ? color : 'dimmed'} (${surface})`, async ($, on) => {
      const ui = await mounted($, on, surface, { level, text: `Advice ${level}`, more: 0 })
      const advice = await ui.find({ type: 'Text', text: `Advice ${level}` })

      expect(advice).toBeDefined()
      if (dim === undefined) {
        expect(advice?.props?.color).toBe(color)
      } else {
        expect(advice?.props?.dimColor).toBe(true)
        expect(advice?.props?.color).toBeUndefined()
      }
      await ui.unmount()
    })
  }
}

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`T10 the Cockpit mounts without a validation error (${surface})`, async ($, on) => {
    const ui = await mounted($, on, surface, { report: true })

    expect(await ui.find({ type: 'Text', text: 'Launch pace' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Series cost' })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    await ui.unmount()
  })
}

test('T11 on vscode the active tab differs without variant and the figure stays bold', async ($, on) => {
  const ui = await mounted($, on, 'vscode')
  const active = await ui.find({ key: 'tab:cockpit' })
  const other = await ui.find({ key: 'tab:usage' })

  expect(active?.props?.variant).toBeUndefined()
  expect(other?.props?.variant).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▸ Cockpit' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▸ Usage' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '▸ Cockpit' }))?.props?.weight).toBe('bold')
  const figure = await ui.find({ type: 'Text', text: /^57 %$/ })
  expect(figure?.props?.weight).toBe('bold')
  expect(figure?.props?.size).toBeUndefined()
  expect(figure?.props?.mono).toBeUndefined()
  await ui.unmount()
})
