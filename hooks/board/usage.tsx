import type {
  AgentRun,
  AgentsJson,
  BoardContext,
  ErrorJson,
  OrchStatus,
  QuotaJson,
  TokenCounts,
} from '../../types/board'
import { FAMILY_HUE, family } from './cockpit'
import {
  Action,
  Bar,
  Card,
  Legend,
  Pill,
  StackedBar,
  Tile,
  cellsFor,
  hasSvg,
  roleProps,
  type Part,
} from './kit'
import { HUE_OF, kindOf, label as columnLabel, titleOf, viewsOf, type Column } from './missions'
import { AGENT_HUE, PALETTE, TONE, textColor } from './tokens'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Without a report the period is the last week.
const FALLBACK_PERIOD = 7 * DAY
// The lanes show the last 90 minutes.
export const LANES_SPAN = 90 * MINUTE
const LANES_SHOWN = 10
const MERGES_SHOWN = 8
// The engine refuses an Svg over 131,072 characters; 500 points stay far below.
export const CURVE_POINTS = 500
// Pane width from which the per-mission table has one column per figure.
export const TABLE_AT = 100
const LANE_LABEL = 14
const MODELS = ['Opus', 'Sonnet', 'Haiku']

const isFailed = (value: unknown): value is ErrorJson =>
  typeof value === 'object' && value !== null && 'error' in value

const pad = (value: number) => String(value).padStart(2, '0')
const clock = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`
const dayOf = (ms: number) =>
  `${new Date(ms).getFullYear()}-${pad(new Date(ms).getMonth() + 1)}-${pad(new Date(ms).getDate())}`

// A figure the data lacks or garbles counts as nothing, never as NaN.
const safe = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const money = (value: number) => `$${safe(value).toFixed(2)}`

const compact = (tokens: number) =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)} M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : String(Math.round(tokens))

const span = (ms: number) => {
  const minutes = Math.max(0, Math.round(safe(ms) / MINUTE))

  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${pad(minutes % 60)}`
}

const tokensOf = (tokens: Partial<TokenCounts> | undefined) => ({
  fresh: safe(tokens?.input) + safe(tokens?.write5m) + safe(tokens?.write1h),
  read: safe(tokens?.read),
  output: safe(tokens?.output),
})

// Tokens of a set of runs, and the share of the input served from the cache;
// null when no input token was read.
export const tallyOf = (runs: AgentRun[]) => {
  const sum = runs.reduce(
    (total, run) => {
      const one = tokensOf(run.tokens)

      return {
        fresh: total.fresh + one.fresh,
        read: total.read + one.read,
        output: total.output + one.output,
      }
    },
    { fresh: 0, read: 0, output: 0 },
  )
  const input = sum.fresh + sum.read

  return {
    tokens: input + sum.output,
    cache: input > 0 ? Math.round((sum.read / input) * 100) : null,
  }
}

export type SpendRow = {
  key: string
  id: string | null
  title: string
  column: Column | null
  // Cost per model family; `Other` holds the models none of them names.
  costs: Record<string, number>
  total: number
  tokens: number
  cache: number | null
}

const rowOf = (
  key: string,
  id: string | null,
  title: string,
  column: Column | null,
  runs: AgentRun[],
): SpendRow => {
  const costs: Record<string, number> = { Opus: 0, Sonnet: 0, Haiku: 0, Other: 0 }
  for (const run of runs) {
    const name = family(run.model)
    const own = MODELS.includes(name) ? name : 'Other'
    costs[own] += safe(run.cost)
  }

  return {
    key,
    id,
    title,
    column,
    costs,
    total: runs.reduce((sum, run) => sum + safe(run.cost), 0),
    ...tallyOf(runs),
  }
}

// One row per mission that has a run, by decreasing cost, then the runs linked
// to no mission.
export const spendRows = (board: BoardContext['board']): SpendRow[] => {
  const { views, loose } = viewsOf(board)
  const notes = board.light?.missions?.notes
  const rows = views
    .filter(view => view.runs.length > 0)
    .map(view =>
      rowOf(
        `mission:${view.row.id}`,
        view.row.id,
        titleOf(view.row.id, notes?.[`${view.row.id}.md`]?.raw) ?? view.row.title,
        view.column,
        view.runs,
      ),
    )
    .sort((one, other) => other.total - one.total)

  return loose.length > 0
    ? [...rows, rowOf('unattributed', null, 'Unattributed', null, loose)]
    : rows
}

export type Productivity = {
  finished: number
  // Null when no mission is finished.
  perMission: number | null
  cache: number | null
  tokens: number
  time: number
  runs: number
}

// Missions finished: merged since the period began, or waiting for a merge.
export const productivityOf = (
  board: BoardContext['board'],
  runs: AgentRun[],
  since: number,
): Productivity => {
  const { views } = viewsOf(board)
  const done = views.filter(
    view =>
      view.column === 'merge' ||
      (view.column === 'merged' && view.mergedAt !== null && view.mergedAt >= since),
  )
  // Only the runs inside the period count, and only the missions that have
  // one with a cost: a mission whose runs all lie outside it would dilute the
  // average with a zero.
  const inPeriod = new Set(runs.map(run => run.agentId))
  const costed = done
    .map(view => view.runs.filter(run => inPeriod.has(run.agentId) && safe(run.ended) >= since && safe(run.cost) > 0))
    .filter(own => own.length > 0)
  const cost = costed.flat().reduce((sum, run) => sum + safe(run.cost), 0)

  return {
    finished: done.length,
    perMission: costed.length > 0 ? cost / costed.length : null,
    ...tallyOf(runs),
    time: runs.reduce((sum, run) => sum + Math.max(0, safe(run.ended) - safe(run.started)), 0),
    runs: runs.length,
  }
}

type Reading = { at: number; used: number }
type Point = { at: number; value: number }

export type Pace = {
  windowStart: number
  resetsAt: number
  // Straight pieces of the expected line: the weekend, then the weekdays. The
  // two meet at Monday 0:00 only when the weekdays start where the weekend ended.
  segments: Point[][]
  // The expected usage at `now`, in points.
  expected: number
}

// The expected pace of `orch-quota` (`quotaState`), as a pure function of the
// readings of the window. The window starts 7 days before `resetsAt`; its
// weekend (start to Monday 0:00 local time) goes up to `target - reserve`, the
// weekdays from the usage at Monday 0:00 up to `target` at the reset. A window
// that has no weekend is one piece from 0 to `target`. Null without a reading.
export const paceOf = (input: {
  history: Reading[]
  resetsAt: number
  target: number
  reserve: number
  now: number
}): Pace | null => {
  const { resetsAt, target, reserve, now } = input
  const history = input.history
    .filter(one => Number.isFinite(one.at) && Number.isFinite(one.used))
    .sort((one, other) => one.at - other.at)
  if (history.length === 0 || ![resetsAt, target, reserve, now].every(Number.isFinite)) {
    return null
  }
  const windowStart = resetsAt - 7 * DAY
  const monday = new Date(windowStart)
  monday.setHours(0, 0, 0, 0)
  do {
    monday.setDate(monday.getDate() + 1)
  } while (monday.getDay() !== 1)
  const weekendEnd = monday.getTime()
  const hasWeekend = weekendEnd - windowStart <= 3 * DAY

  // The usage when a period began: the last reading before it, else 0 at the
  // window start, else the first reading inside the period, else the latest one.
  const startOf = (start: number) => {
    const before = history.filter(one => one.at <= start).at(-1)
    if (before !== undefined) {
      return before.used
    }

    return start === windowStart ? 0 : (history.find(one => one.at >= start) ?? history.at(-1)!).used
  }
  const value = (from: Point, to: Point, at: number) => {
    const elapsed = Math.min(1, Math.max(0, (at - from.at) / (to.at - from.at)))

    return from.value + (to.value - from.value) * elapsed
  }

  if (!hasWeekend) {
    const from = { at: windowStart, value: startOf(windowStart) }
    const to = { at: resetsAt, value: target }

    return { windowStart, resetsAt, segments: [[from, to]], expected: value(from, to, now) }
  }
  const weekend = [
    { at: windowStart, value: startOf(windowStart) },
    { at: weekendEnd, value: target - reserve },
  ]
  const isWeekend = now < weekendEnd
  const weekdays = [
    { at: weekendEnd, value: isWeekend ? target - reserve : startOf(weekendEnd) },
    { at: resetsAt, value: target },
  ]
  const [from, to] = isWeekend ? weekend : weekdays

  return { windowStart, resetsAt, segments: [weekend, weekdays], expected: value(from, to, now) }
}

// At most `limit` readings, the first and the last always kept.
export const decimate = <T,>(points: T[], limit = CURVE_POINTS): T[] => {
  if (points.length <= limit) {
    return points
  }
  const step = (points.length - 1) / (limit - 1)

  return Array.from({ length: limit }, (_, index) => points[Math.round(index * step)])
}

const WIDTH = 600
const HEIGHT = 170
const PAD = { left: 34, right: 10, top: 8, bottom: 22 }

// The week curve as an SVG document: used, expected pace, dotted target, now.
export const curveSvg = (input: {
  history: Reading[]
  pace: Pace
  target: number
  now: number
}) => {
  const { pace, target, now } = input
  const length = pace.resetsAt - pace.windowStart
  const x = (at: number) =>
    (PAD.left + (Math.min(pace.resetsAt, Math.max(pace.windowStart, at)) - pace.windowStart) / length * (WIDTH - PAD.left - PAD.right)).toFixed(1)
  const y = (value: number) =>
    (PAD.top + (1 - Math.min(100, Math.max(0, value)) / 100) * (HEIGHT - PAD.top - PAD.bottom)).toFixed(1)
  const line = (points: Point[]) => points.map(one => `${x(one.at)},${y(one.value)}`).join(' ')
  const used = decimate(
    input.history
      .filter(one => Number.isFinite(one.at) && Number.isFinite(one.used))
      .sort((one, other) => one.at - other.at),
  ).map(one => ({ at: one.at, value: one.used }))

  const midnights: number[] = []
  const day = new Date(pace.windowStart)
  day.setHours(0, 0, 0, 0)
  for (day.setDate(day.getDate() + 1); day.getTime() < pace.resetsAt; day.setDate(day.getDate() + 1)) {
    midnights.push(day.getTime())
  }
  const bounds = [pace.windowStart, ...midnights, pace.resetsAt]
  const labels = bounds.slice(0, -1).flatMap((from, index) => {
    const to = bounds[index + 1]

    return to - from < DAY / 3
      ? []
      : [
          `<text x="${x((from + to) / 2)}" y="${HEIGHT - 6}" text-anchor="middle" font-size="10" fill="${PALETTE.text3}">${DAYS[new Date(from + 1).getDay()]}</text>`,
        ]
  })
  const grid = [0, 50, 100].map(
    value =>
      `<line x1="${PAD.left}" x2="${WIDTH - PAD.right}" y1="${y(value)}" y2="${y(value)}" stroke="${PALETTE.text3}" stroke-opacity="0.3"/>` +
      `<text x="${PAD.left - 4}" y="${Number(y(value)) + 3}" text-anchor="end" font-size="10" fill="${PALETTE.text3}">${value} %</text>`,
  )
  const marks = midnights.map(
    at =>
      `<line x1="${x(at)}" x2="${x(at)}" y1="${PAD.top}" y2="${HEIGHT - PAD.bottom}" stroke="${PALETTE.text3}" stroke-opacity="0.15"/>`,
  )
  const nowAt = x(now)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">`,
    ...grid,
    ...marks,
    ...labels,
    `<line x1="${PAD.left}" x2="${WIDTH - PAD.right}" y1="${y(target)}" y2="${y(target)}" stroke="${PALETTE.yellow}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="1 4"/>`,
    ...pace.segments.map(
      segment =>
        `<polyline points="${line(segment)}" fill="none" stroke="${PALETTE.text2}" stroke-width="1.5" stroke-dasharray="6 4"/>`,
    ),
    `<polyline points="${line(used)}" fill="none" stroke="${PALETTE.accent}" stroke-width="2.5" stroke-linejoin="round"/>`,
    `<line x1="${nowAt}" x2="${nowAt}" y1="${PAD.top}" y2="${HEIGHT - PAD.bottom}" stroke="${PALETTE.text}" stroke-opacity="0.7"/>`,
    `<text x="${nowAt}" y="${PAD.top + 8}" font-size="10" fill="${PALETTE.text}" text-anchor="${Number(nowAt) > WIDTH - 40 ? 'end' : 'start'}" dx="${Number(nowAt) > WIDTH - 40 ? -3 : 3}">now</text>`,
    '</svg>',
  ].join('')
}

// Where a run sits in the lanes, in cells of a track of `cells` covering the 90
// minutes before `now`. Null when it is not in them: older, or not started yet.
// A run still going is drawn up to `now`.
export const laneOf = (
  run: { started: number; ended: number },
  isGoing: boolean,
  now: number,
  cells: number,
): { offset: number; length: number } | null => {
  const from = now - LANES_SPAN
  const end = Math.min(now, isGoing ? now : run.ended)
  if (!Number.isFinite(run.started) || !Number.isFinite(end) || end < from || run.started > now) {
    return null
  }
  const cell = (at: number) => ((Math.max(from, at) - from) / LANES_SPAN) * cells
  const offset = Math.min(cells - 1, Math.floor(cell(run.started)))
  const last = Math.min(cells, Math.max(offset + 1, Math.ceil(cell(end))))

  return { offset, length: last - offset }
}

const shortType = (type: string) => type.replace(/^.*:/, '')

const seriesOf = (status: OrchStatus | undefined): AgentsJson | undefined => {
  const series = status?.report?.agents ?? status?.agents ?? undefined

  return series === undefined || series === null || isFailed(series) ? undefined : series
}

const quotaOf = (status: OrchStatus | undefined): QuotaJson | undefined =>
  status === undefined || isFailed(status.quota) ? undefined : status.quota

export const renderUsage = (context: BoardContext) => {
  const { ui, board, columns, actions } = context
  const { Box, Button, Svg, Text } = ui
  const status = board.heavy?.status?.value
  const now = board.light?.at ?? Date.now()
  const series = seriesOf(status)
  const quota = quotaOf(status)
  const runs = (series?.runs ?? []).filter(one => typeof one === 'object' && one !== null)
  const since = status?.report?.since.at ?? now - FALLBACK_PERIOD
  const cells = cellsFor(columns)
  const heading = (title: string, note?: string) => (
    <Box key={`heading:${title}`} flexDirection="row" flexWrap="wrap" gap={1} minWidth={0}>
      <Text {...roleProps(ui, 'heading')}>{title}</Text>
      {note !== undefined && <Text dimColor>{note}</Text>}
    </Box>
  )
  const section = (key: string, children: unknown) => (
    <Box key={key} flexDirection="column" minWidth={0}>
      {Card(ui, {
        children: (
          <Box flexDirection="column" gap={1} minWidth={0}>
            {children}
          </Box>
        ),
      })}
    </Box>
  )
  const tile = (key: string, label: string, value: string, note?: string) => (
    <Box key={`tile:${key}`} flexGrow={1} flexShrink={1} minWidth={16}>
      {Tile(ui, { label, value, ...(note === undefined ? {} : { note }) })}
    </Box>
  )

  const top = (
    <Box flexDirection="row" flexWrap="wrap" gap={1} minWidth={0}>
      {Action(ui, { keyName: 'refresh', label: 'Refresh', onPress: () => actions.refresh() })}
      <Text dimColor>
        {status?.report?.since.at === undefined
          ? 'last 7 days'
          : `since the last report, ${dayOf(status.report.since.at)}`}
      </Text>
    </Box>
  )
  if (status === undefined) {
    return (
      <Box flexDirection="column" gap={1} minWidth={0}>
        {top}
        <Text dimColor>Loading…</Text>
      </Box>
    )
  }

  // Week curve.
  const week = quota?.counters.week ?? null
  const history = quota?.history ?? []
  const pace =
    quota === undefined || week === null || !Array.isArray(history)
      ? null
      : paceOf({
          history,
          resetsAt: week.resetsAt,
          target: quota.limits.target,
          reserve: quota.limits.reserve,
          now,
        })
  const curve = (() => {
    if (quota === undefined || pace === null) {
      return <Text dimColor>no reading yet</Text>
    }
    const usedNow = week?.used ?? history.at(-1)?.used ?? 0
    const expected = Math.round(quota.pace?.expected ?? pace.expected)
    const target = quota.limits.target
    const sentence = `${Math.round(usedNow)} % used, expected ${expected} %, target ${target} % at reset`
    const parts: Part[] = [
      { label: 'Used', value: 1, hue: PALETTE.accent },
      { label: 'Expected pace', value: 1, hue: PALETTE.text2 },
      { label: 'Target', value: 1, hue: PALETTE.yellow },
    ]

    return hasSvg(ui) ? (
      <Box flexDirection="column" gap={1} minWidth={0}>
        <Svg
          key="curve"
          source={curveSvg({ history, pace, target, now })}
          alt={`Week usage: ${sentence}`}
        />
        {Legend(ui, { parts })}
        <Text dimColor wrap="wrap">{`${sentence} · resets ${DAYS[new Date(pace.resetsAt).getDay()]} ${clock(pace.resetsAt)}`}</Text>
      </Box>
    ) : (
      <Box flexDirection="column" minWidth={0}>
        <Text wrap="wrap">{sentence}</Text>
        {Bar(ui, {
          percent: usedNow,
          cells: Math.max(cells, 20),
          hue: usedNow >= target ? TONE.error : TONE.success,
          markers: [
            { at: expected, hue: PALETTE.text },
            { at: target, hue: TONE.warning },
          ],
        })}
        <Text dimColor wrap="wrap">{`resets ${DAYS[new Date(pace.resetsAt).getDay()]} ${clock(pace.resetsAt)}`}</Text>
      </Box>
    )
  })()

  // Tiles of the account.
  const five = quota?.counters.five ?? null
  const account = (
    <Box key="account" flexDirection="row" flexWrap="wrap" gap={1} minWidth={0}>
      {tile('five', '5 h window', five === null ? '–' : `${Math.round(five.used)} %`)}
      {tile(
        'room',
        'Room',
        quota === undefined ? '–' : String(Math.max(0, safe(quota.advice.more))),
        quota === undefined ? undefined : quota.advice.text,
      )}
      {tile('running', 'Running', quota === undefined ? '–' : String(quota.running.total), 'agents')}
      {tile('cost', 'Series cost', series === undefined ? '–' : money(series.total.cost))}
    </Box>
  )

  // Cost per model.
  const byModel = rowOf('all', null, '', null, runs)
  const sumCost = byModel.total
  const modelParts: Part[] = [...MODELS, 'Other']
    .filter(name => byModel.costs[name] > 0)
    .map(name => ({
      label: `${name} ${money(byModel.costs[name])} (${Math.round((byModel.costs[name] / sumCost) * 100)} %)`,
      value: byModel.costs[name],
      hue: FAMILY_HUE[name] ?? PALETTE.text2,
    }))

  const prod = productivityOf(board, runs, since)
  const tiles = (
    <Box key="tiles" flexDirection="row" flexWrap="wrap" gap={1} minWidth={0}>
      {tile('finished', 'Finished missions', String(prod.finished))}
      {tile('per-mission','Cost per finished mission', prod.perMission === null ? '–' : money(prod.perMission), 'agents only')}
      {tile('cache', 'Served from the cache', prod.cache === null ? '–' : `${prod.cache} %`, `of ${compact(prod.tokens)} tokens`)}
      {tile('time', 'Agent time', span(prod.time), `${prod.runs} ${prod.runs === 1 ? 'run' : 'runs'}`)}
    </Box>
  )

  // Per-mission table.
  const rows = spendRows(board)
  const biggest = Math.max(0, ...rows.map(one => one.total))
  const barOf = (row: SpendRow, width: number) => {
    const shown = biggest > 0 ? Math.max(1, Math.round((row.total / biggest) * width)) : 0
    const parts = [...MODELS, 'Other'].map(name => ({
      label: name,
      value: row.costs[name],
      hue: FAMILY_HUE[name] ?? PALETTE.text2,
    }))

    return shown > 0 ? StackedBar(ui, { parts, cells: shown }) : <Box width={width} height={1} />
  }
  const open = (row: SpendRow) =>
    row.id === null ? (
      <Text wrap="truncate">{row.title}</Text>
    ) : (
      <Button key={`open:${row.id}`} plain onPress={() => actions.openDetail('mission', row.id!)}>
        <Text mono weight="semibold">
          {row.id}
        </Text>
      </Button>
    )
  const state = (row: SpendRow) =>
    row.column === null ? (
      <Text dimColor>–</Text>
    ) : (
      Pill(ui, { label: columnLabel(row.column), hue: HUE_OF[row.column] })
    )
  const cell = (key: string, width: number, text: string, isHead = false) => (
    <Box key={key} width={width} flexShrink={0} justifyContent="flex-end">
      <Text dimColor={isHead} wrap="truncate">
        {text}
      </Text>
    </Box>
  )
  const isTable = columns >= TABLE_AT
  const table = (
    <Box key="table" flexDirection="column" minWidth={0}>
      {isTable && (
        <Box key="head" flexDirection="row" gap={1} minWidth={0}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text dimColor>Mission</Text>
          </Box>
          <Box width={12} flexShrink={0}>
            <Text dimColor>Cost by model</Text>
          </Box>
          {MODELS.map(name => cell(`head:${name}`, 8, name, true))}
          {cell('head:total', 8, 'Cost', true)}
          {cell('head:tokens', 8, 'Tokens', true)}
          {cell('head:cache', 7, 'Cached', true)}
          <Box width={10} flexShrink={0}>
            <Text dimColor>State</Text>
          </Box>
        </Box>
      )}
      {rows.map(row =>
        isTable ? (
          <Box key={`row:${row.key}`} flexDirection="row" gap={1} minWidth={0}>
            <Box flexGrow={1} flexShrink={1} flexDirection="row" gap={1} minWidth={0}>
              {open(row)}
              {row.id !== null && (
                <Box flexShrink={1} minWidth={0}>
                  <Text wrap="truncate">{row.title}</Text>
                </Box>
              )}
            </Box>
            <Box width={12} flexShrink={0}>
              {barOf(row, 12)}
            </Box>
            {MODELS.map(name => cell(`${row.key}:${name}`, 8, money(row.costs[name])))}
            {cell(`${row.key}:total`, 8, money(row.total))}
            {cell(`${row.key}:tokens`, 8, compact(row.tokens))}
            {cell(`${row.key}:cache`, 7, row.cache === null ? '–' : `${row.cache} %`)}
            <Box width={10} flexShrink={0}>
              {state(row)}
            </Box>
          </Box>
        ) : (
          <Box key={`row:${row.key}`} flexDirection="column" minWidth={0}>
            <Box flexDirection="row" gap={1} minWidth={0}>
              {open(row)}
              {row.id !== null && (
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap="truncate">{row.title}</Text>
                </Box>
              )}
              <Box flexShrink={0}>
                <Text weight="semibold">{money(row.total)}</Text>
              </Box>
            </Box>
            <Box flexDirection="row" gap={1} minWidth={0}>
              {barOf(row, Math.min(cells, 12))}
              {row.column !== null && (
                <Text dimColor wrap="truncate">
                  {columnLabel(row.column)}
                </Text>
              )}
            </Box>
            <Text dimColor wrap="wrap">
              {`${MODELS.filter(name => row.costs[name] > 0)
                .map(name => `${name} ${money(row.costs[name])}`)
                .join(' · ')}${row.costs.Other > 0 ? ` · Other ${money(row.costs.Other)}` : ''} · ${compact(row.tokens)} tokens · cached ${row.cache === null ? '–' : `${row.cache} %`}`}
            </Text>
          </Box>
        ),
      )}
      {rows.length === 0 && <Text dimColor>No agent run yet.</Text>}
    </Box>
  )

  // Who runs when: the last 90 minutes, one lane per run.
  const live = new Set((board.light?.agents?.value ?? []).map(agent => agent.id))
  const track = Math.max(20, Math.min(72, columns - 4 - LANE_LABEL - 1))
  const lanes = runs
    .map(run => ({
      run,
      lane: laneOf(run, run.finished !== true || live.has(run.agentId), now, track),
    }))
    .filter(one => one.lane !== null)
    .sort((one, other) => one.run.started - other.run.started)
  const shownLanes = lanes.slice(-LANES_SHOWN)
  const lanesBody = (
    <Box key="lanes" flexDirection="column" minWidth={0}>
      {shownLanes.map(({ run, lane }) => {
        const hue = AGENT_HUE[kindOf(run.type) ?? ''] ?? PALETTE.text2

        return (
          <Box key={`lane:${run.agentId}`} flexDirection="row" gap={1} minWidth={0}>
            <Box width={LANE_LABEL} flexShrink={0}>
              <Text wrap="truncate" color={textColor(hue)}>{`${shortType(run.type)} ${run.agentId.slice(0, 6)}`}</Text>
            </Box>
            <Box key={`lane:track:${run.agentId}`} flexDirection="row" width={track} height={1} flexShrink={0}>
              {lane!.offset > 0 && (
                <Box key={`lane:gap:${run.agentId}`} width={lane!.offset} height={1} flexShrink={0} />
              )}
              <Box
                key={`lane:bar:${run.agentId}`}
                width={lane!.length}
                height={1}
                flexShrink={0}
                backgroundColor={hue}
              />
            </Box>
          </Box>
        )
      })}
      {shownLanes.length === 0 && <Text dimColor>No agent in the last 90 minutes.</Text>}
      {shownLanes.length > 0 && (
        <Box flexDirection="row" gap={1} minWidth={0}>
          <Box width={LANE_LABEL} flexShrink={0} />
          <Box width={track} flexShrink={0} flexDirection="row" justifyContent="space-between">
            <Text dimColor>{`${clock(now - LANES_SPAN)}`}</Text>
            <Text dimColor>{`now ${clock(now)}`}</Text>
          </Box>
        </Box>
      )}
      {lanes.length > shownLanes.length && (
        <Text dimColor>{`+${lanes.length - shownLanes.length} earlier`}</Text>
      )}
    </Box>
  )

  // Since the last report: the merged commits, newest first.
  const report = status.report
  const merges = [...(report?.merged ?? [])].sort((one, other) => other.at - one.at)

  return (
    <Box flexDirection="column" gap={1} minWidth={0}>
      {top}
      {section('usage:week', [
        heading('Week pace'),
        <Box key="curve" flexDirection="column" minWidth={0}>
          {curve}
        </Box>,
        account,
      ])}
      {section('usage:productivity', [
        heading('Productivity and tokens', `· ${runs.length === 0 ? 'no run' : `${prod.runs} ${prod.runs === 1 ? 'run' : 'runs'}`}`),
        modelParts.length > 0 && (
          <Box key="models" flexDirection="column" minWidth={0}>
            {StackedBar(ui, { parts: modelParts, cells: Math.max(cells, 20) })}
            {Legend(ui, { parts: modelParts })}
          </Box>
        ),
        tiles,
        table,
      ])}
      {section('usage:lanes', [heading('Who runs when', '· the last 90 minutes'), lanesBody])}
      {report !== null && report !== undefined &&
        section('usage:merges', [
          heading('Since the last report', `· ${merges.length} ${merges.length === 1 ? 'merge' : 'merges'}`),
          merges.length === 0 && <Text key="none" dimColor>Nothing merged yet.</Text>,
          ...merges.slice(0, MERGES_SHOWN).map(merge => (
            <Box key={`merge:${merge.sha}`} flexDirection="row" gap={1} minWidth={0}>
              <Text mono weight="semibold" wrap="truncate">
                {merge.sha}
              </Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text wrap="truncate">{merge.subject}</Text>
              </Box>
              <Text dimColor wrap="truncate">{`${dayOf(merge.at)} ${clock(merge.at)}`}</Text>
            </Box>
          )),
          merges.length > MERGES_SHOWN && (
            <Text key="more" dimColor>{`+${merges.length - MERGES_SHOWN} more`}</Text>
          ),
        ])}
    </Box>
  )
}
