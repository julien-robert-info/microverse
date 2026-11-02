import { expect, test } from 'claude-code/testing'

import type { BoardData } from '../../../types/board'
import { renderCockpit } from '../cockpit'
import { lookFor, withLook } from '../kit'
import { CURVE_POINTS, decimate, laneOf, paceOf, renderUsage, spendRows } from '../usage'

const SURFACES = ['terminal', 'desktop'] as const
const ROOT = '/work/demo'
const HOUR = 3_600_000
const MINUTE = 60_000
const DAY = 24 * HOUR
const NOW = 1_767_000_000_000
const COLUMNS = 100

// Components as plain strings: an element is then a node to walk.
const fake = (surface: (typeof SURFACES)[number]) =>
  withLook(
    {
      Box: 'Box',
      Text: 'Text',
      Button: 'Button',
      Link: 'Link',
      ...(surface === 'desktop' ? { Svg: 'Svg' } : {}),
    } as never,
    lookFor(surface, 'dark'),
  )

type Node = {
  type?: unknown
  key?: unknown
  props?: Record<string, unknown>
  children?: unknown
}

const kids = (node: Node): Node[] =>
  [node.children, node.props?.children]
    .flat(Infinity)
    .filter((one): one is Node => typeof one === 'object' && one !== null)

const all = (node: Node): Node[] => [node, ...kids(node).flatMap(all)]
const keyOf = (node: Node) => String(node.key ?? node.props?.key ?? '')
const byKey = (tree: Node, key: string) => all(tree).find(one => keyOf(one) === key)
const texts = (node: Node): string[] =>
  all(node)
    .filter(one => one.type === 'Text')
    .flatMap(one => [one.children, one.props?.children].flat(Infinity))
    .filter((one): one is string => typeof one === 'string')

const sensed = <T,>(value: T) => ({ value, at: NOW })

type RunShape = {
  id: string
  type?: string
  model: string
  description: string
  started?: number
  ended?: number
  cost: number
  tokens?: Partial<Record<'input' | 'write5m' | 'write1h' | 'read' | 'output', number>>
  finished?: boolean
}

const runOf = (one: RunShape) => ({
  agentId: one.id,
  type: one.type ?? 'demo:morty',
  model: one.model,
  description: one.description,
  started: one.started ?? NOW - 5 * HOUR,
  ended: one.ended ?? NOW - 4 * HOUR,
  requests: 1,
  tokens: { input: 0, write5m: 0, write1h: 0, read: 0, output: 0, ...one.tokens },
  cost: one.cost,
  advisor: { calls: 0, cost: 0 },
  finished: one.finished ?? true,
})

const HIT = { input: 100, write5m: 50, write1h: 50, read: 800, output: 200 }

// Three missions (E1 merged, E2 waiting for a merge, E3 with no state) and two
// runs linked to none.
const RUNS: RunShape[] = [
  { id: 'a1', model: 'claude-opus-4', description: 'E1 task', cost: 4, tokens: HIT },
  { id: 'a2', model: 'claude-sonnet-4', description: 'E1 review', cost: 1 },
  { id: 'b1', model: 'claude-sonnet-4', description: 'E2 task', cost: 6, tokens: { input: 300, read: 100, output: 100 } },
  { id: 'c1', model: 'claude-haiku-4', description: 'E3 task', cost: 0.5 },
  { id: 'x1', model: 'claude-opus-4', description: 'misc one', cost: 0.3 },
  { id: 'x2', model: 'claude-haiku-4', description: 'misc two', cost: 0.2 },
]

type Scene = {
  runs?: RunShape[]
  history?: { at: number; used: number }[]
  week?: { used: number; resetsAt: number } | null
  expected?: number
  isFinishing?: boolean
  roster?: string[]
}

const quotaOf = (scene: Scene) => ({
  counters: {
    five: { used: 19, resetsAt: NOW + HOUR, observedAt: NOW, source: 'statusline' },
    week:
      scene.week === null
        ? null
        : { ...(scene.week ?? { used: 17, resetsAt: NOW + 4 * DAY }), observedAt: NOW, source: 'statusline' },
  },
  limits: { target: 98, reserve: 30, fiveHour: 90 },
  period: null,
  pace: { expected: scene.expected ?? 23, actual: 17, delta: -6, left: 81 },
  running: { total: 2, others: 0 },
  agentCost: { points: 2, runs: null },
  advice: { level: 'launch', text: 'Launch', more: 2 },
  warnings: [],
  history: scene.history ?? [
    { at: NOW - 2 * DAY, used: 5 },
    { at: NOW - DAY, used: 11 },
    { at: NOW - HOUR, used: 17 },
  ],
})

const boardOf = (scene: Scene = {}, tab: 'usage' | 'cockpit' = 'usage'): BoardData => {
  const runs = (scene.runs ?? RUNS).map(runOf)
  const total = runs.reduce((sum, one) => sum + one.cost, 0)
  const isFinishing = scene.isFinishing !== false
  const status = {
    v: 1,
    project: ROOT,
    base: { name: 'main', tip: '1111111' },
    lastReport: null,
    state: { exists: true, sections: [] },
    worktrees: isFinishing
      ? [
          {
            branch: 'feat/b',
            path: `${ROOT}/.claude/worktrees/agent-b1`,
            rel: '.claude/worktrees/agent-b1',
            merged: false,
            last: null,
            dirty: false,
          },
        ]
      : [],
    free: [],
    report: null,
    agents: { since: NOW - 7 * DAY, runs, total: { cost: total, advisor: { calls: 0, cost: 0 } } },
    quota: quotaOf(scene),
    context: { error: 'none' },
  }

  return {
    light: {
      project: ROOT,
      root: ROOT,
      at: NOW,
      worktrees: null,
      agents: sensed((scene.roster ?? []).map(id => ({ id, type: 'demo:morty', description: 'E2 task', status: 'running', firstSeenAt: NOW }))),
      usage: null,
      state: null,
      missions: {
        stateStamp: null,
        rows: ['E1', 'E2', 'E3'].map(id => ({
          id,
          isRange: false,
          branch: `feat/${id === 'E1' ? 'a' : id === 'E2' ? 'b' : 'c'}`,
          title: `Mission ${id}`,
          hashes: id === 'E1' && isFinishing ? ['h1'] : [],
          sections: [],
        })),
        notes: {},
        sections: {},
        notesStamp: null,
        briefs: {},
      },
      failures: [],
    },
    heavy: {
      project: ROOT,
      status: sensed(status as never),
      failure: null,
      missions: { hashes: { h1: { ancestor: true, at: NOW - HOUR } }, briefs: {} },
    },
    view: { tab, detail: null, toggled: [] },
    checks: {},
    answer: { pending: null, sent: [] },
    activity: {},
  } as never
}

const draw = (
  surface: (typeof SURFACES)[number],
  scene: Scene = {},
  columns = COLUMNS,
) =>
  renderUsage({ ui: fake(surface), board: boardOf(scene), columns, actions: {} as never }) as Node

for (const surface of SURFACES) {
  test(`T1 the table sums cost per model, orders by cost, unattributed last (${surface})`, async () => {
    const rows = spendRows(boardOf())

    expect(rows.map(one => one.key)).toEqual([
      'mission:E2',
      'mission:E1',
      'mission:E3',
      'unattributed',
    ])
    expect(rows.map(one => one.total)).toEqual([6, 5, 0.5, 0.5])
    expect(rows[1].costs).toMatchObject({ Opus: 4, Sonnet: 1, Haiku: 0 })
    expect(rows[3].costs).toMatchObject({ Opus: 0.3, Haiku: 0.2 })
    // 800 read of 1,000 input tokens; the output is counted in the tokens only.
    expect(rows[1].cache).toBe(80)
    expect(rows[1].tokens).toBe(1200)
    expect(rows[0].cache).toBe(25)

    const tree = draw(surface)
    const own = (key: string) => texts(byKey(tree, `row:${key}`)!)
    expect(own('mission:E1')).toEqual(expect.arrayContaining(['$4.00', '$1.00', '$5.00', '1k', '80 %', 'Merged']))
    expect(own('mission:E2')).toEqual(expect.arrayContaining(['$6.00', '25 %', 'To merge']))
    expect(own('unattributed')).toEqual(expect.arrayContaining(['Unattributed', '$0.50']))
    const order = all(tree)
      .map(keyOf)
      .filter(key => key.startsWith('row:'))
    expect(order).toEqual(['row:mission:E2', 'row:mission:E1', 'row:mission:E3', 'row:unattributed'])
    // Two finished missions (merged, to merge): (5 + 6) / 2.
    expect(texts(byKey(tree, 'tile:finished')!)).toContain('2')
    expect(texts(byKey(tree, 'tile:per-mission')!)).toContain('$5.50')
    expect(texts(byKey(tree, 'tile:time')!)).toContain('6 runs')
  })

  test(`T2 no finished mission gives a dash, not a division (${surface})`, async () => {
    const tree = draw(surface, {
      isFinishing: false,
      runs: [{ id: 'c1', model: 'claude-haiku-4', description: 'E3 task', cost: 0.5 }],
    })

    expect(texts(byKey(tree, 'tile:finished')!)).toContain('0')
    expect(texts(byKey(tree, 'tile:per-mission')!)).toContain('–')
    // No cache token at all.
    expect(texts(byKey(tree, 'tile:cache')!)).toContain('–')
    expect(texts(tree).join(' ')).not.toMatch(/NaN|Infinity/)
  })

  test(`T3 an empty history says there is no reading yet (${surface})`, async () => {
    const tree = draw(surface, { history: [] })

    expect(texts(tree)).toContain('no reading yet')
    expect(all(tree).some(one => one.type === 'Svg')).toBe(false)
  })

  test(`T4 the week curve is an Svg with an alt on the desktop, a sentence in the terminal (${surface})`, async () => {
    const tree = draw(surface)
    const svg = all(tree).find(one => one.type === 'Svg')
    const sentence = '17 % used, expected 23 %, target 98 % at reset'

    if (surface === 'desktop') {
      expect(svg).toBeDefined()
      expect(String(svg!.props?.alt)).toContain(sentence)
      expect(String(svg!.props?.source).length).toBeLessThan(131_072)
      expect(String(svg!.props?.source)).toMatch(/^<svg /)
    } else {
      expect(svg).toBeUndefined()
      expect(texts(tree)).toContain(sentence)
    }
  })

  test(`T5 a run still going reaches now in the lanes (${surface})`, async () => {
    const tree = draw(surface, {
      runs: [
        { id: 'g1', model: 'claude-opus-4', description: 'E2 task', cost: 1, started: NOW - 30 * MINUTE, ended: NOW - 10 * MINUTE, finished: false },
        { id: 'g2', model: 'claude-opus-4', description: 'E2 task', cost: 1, started: NOW - 60 * MINUTE, ended: NOW - 40 * MINUTE },
      ],
    })
    const track = byKey(tree, 'lane:track:g1')!
    const widths = (key: string) => kids(byKey(tree, key)!).map(one => one.props?.width as number)
    const total = track.props?.width as number
    const end = (key: string) => widths(key).reduce((sum, one) => sum + one, 0)

    expect(end('lane:track:g1')).toBe(total)
    // Started 30 minutes ago: it begins two thirds of the way along the 90 minutes.
    expect(Math.abs((byKey(tree, 'lane:gap:g1')?.props?.width as number) - total * (60 / 90))).toBeLessThanOrEqual(1)
    // A finished run stops where it ended: 40 minutes ago.
    expect(end('lane:track:g2')).toBeLessThan(total)
    expect(laneOf({ started: NOW - 30 * MINUTE, ended: NOW - 10 * MINUTE }, true, NOW, 90)).toEqual({
      offset: 60,
      length: 30,
    })
    expect(laneOf({ started: NOW + MINUTE, ended: NOW + 2 * MINUTE }, true, NOW, 90)).toBeNull()
  })

  test(`T6 a run older than 90 minutes is not in the lanes but is in the table (${surface})`, async () => {
    const tree = draw(surface, {
      runs: [
        { id: 'o1', model: 'claude-opus-4', description: 'E2 task', cost: 2.5, started: NOW - 3 * HOUR, ended: NOW - 2 * HOUR },
        { id: 'n1', model: 'claude-opus-4', description: 'E2 task', cost: 1, started: NOW - 20 * MINUTE, ended: NOW - 5 * MINUTE },
      ],
    })

    expect(byKey(tree, 'lane:o1')).toBeUndefined()
    expect(byKey(tree, 'lane:n1')).toBeDefined()
    expect(texts(byKey(tree, 'row:mission:E2')!)).toContain('$3.50')
    expect(texts(byKey(tree, 'tile:time')!)).toContain('2 runs')
  })
}

test('T7 the expected pace agrees with orch-quota on a weekend and a weekday', async () => {
  // Window Fri 21:00 to Fri 21:00 (local time): Monday 0:00 splits it.
  const windowStart = new Date(2026, 0, 2, 21, 0).getTime()
  const resetsAt = windowStart + 7 * DAY
  const readings = [
    { at: new Date(2026, 0, 2, 22, 0).getTime(), used: 5 },
    { at: new Date(2026, 0, 3, 10, 0).getTime(), used: 17 },
    { at: new Date(2026, 0, 4, 23, 0).getTime(), used: 40 },
    { at: new Date(2026, 0, 6, 12, 0).getTime(), used: 55 },
  ]

  // What orch-quota's quotaState gives at these two instants, worked by hand:
  // the weekend is 51 h long and climbs to 68 %; the weekdays run 117 h from the
  // 40 % read at Monday 0:00 to 98 %.
  const cases = [
    { now: new Date(2026, 0, 3, 12, 0).getTime(), expected: (68 * 15) / 51 },
    { now: new Date(2026, 0, 7, 12, 0).getTime(), expected: 40 + (58 * 60) / 117 },
  ]

  for (const { now, expected } of cases) {
    const seen = readings.filter(one => one.at <= now)
    const pace = paceOf({ history: seen, resetsAt, target: 98, reserve: 30, now })

    expect(pace).not.toBeNull()
    expect(Math.abs(pace!.expected - expected)).toBeLessThanOrEqual(1)
    expect(pace!.windowStart).toBe(windowStart)
  }
  // The weekdays start from the usage read at Monday 0:00 (40 %), not from the planned 68 %.
  const weekday = paceOf({ history: readings, resetsAt, target: 98, reserve: 30, now: new Date(2026, 0, 7, 12, 0).getTime() })
  expect(weekday!.segments[1][0].value).toBe(40)
  const weekend = paceOf({ history: readings, resetsAt, target: 98, reserve: 30, now: new Date(2026, 0, 3, 12, 0).getTime() })
  expect(weekend!.segments[1][0].value).toBe(68)
  expect(paceOf({ history: [], resetsAt, target: 98, reserve: 30, now: NOW })).toBeNull()
})

test('T7b more than 500 points are decimated, the first and the last kept', async () => {
  const points = Array.from({ length: 2000 }, (_, index) => ({ at: index, used: index % 100 }))
  const kept = decimate(points)

  expect(kept).toHaveLength(CURVE_POINTS)
  expect(kept[0]).toBe(points[0])
  expect(kept.at(-1)).toBe(points.at(-1))
})

test('T8 the Usage tab has one refresh button and keeps the tab keys; the Cockpit keeps its own', async () => {
  const cockpit = (tab: 'usage' | 'cockpit', columns = COLUMNS) =>
    renderCockpit({
      ui: fake('desktop'),
      columns,
      look: lookFor('desktop', 'dark'),
      actions: {} as never,
      board: boardOf({}, tab),
    }) as Node
  const count = (tree: Node, key: string) => all(tree).filter(one => keyOf(one) === key).length

  for (const tab of ['usage', 'cockpit'] as const) {
    const tree = cockpit(tab)

    expect(count(tree, 'refresh')).toBe(1)
    expect(count(tree, 'tab:cockpit')).toBe(1)
    expect(count(tree, 'tab:usage')).toBe(1)
  }
  expect(texts(cockpit('usage')).join(' ')).not.toContain('Not yet available')
  // A narrow pane stacks the table and stays whole.
  const narrow = cockpit('usage', 60)
  expect(count(narrow, 'refresh')).toBe(1)
  expect(count(narrow, 'row:mission:E2')).toBe(1)
  expect(texts(narrow)).not.toContain('Tokens')
})
