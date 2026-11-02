import type {
  AgentsJson,
  BoardContext,
  ErrorJson,
  LightRateLimit,
  QuotaCounter,
  QuotaJson,
} from '../../types/board'
import { renderAgentDetail, renderAgents } from './agents'
import {
  Action,
  Bar,
  Card,
  Legend,
  Pill,
  Segmented,
  StackedBar,
  cellsFor,
  lookFor,
  roleProps,
  withLook,
  type Look,
} from './kit'
import { renderMissionDetail, renderMissions } from './missions'
import { renderQuestionDetail, renderQuestions } from './questions'
import { PALETTE, TONE } from './tokens'
import { renderUsage } from './usage'

// Pane body width (columns) from which the detail drawer sits on the right.
export const WIDE_AT = 130
// The drawer takes 40 % of the row; the gap between the two zones is 2 columns.
const DRAWER_SHARE = 0.4
const GAP_COLUMNS = 2
// A vitals card is at least this wide (borders and padding included).
const CARD_MIN = 28
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The look is computed by the caller from `e.surface` and the theme setting.
export type CockpitContext = BoardContext & { look?: Look }

const isFailed = (value: unknown): value is ErrorJson =>
  typeof value === 'object' && value !== null && 'error' in value

const pad = (value: number) => String(value).padStart(2, '0')

const clock = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`

const dayOf = (ms: number) =>
  `${new Date(ms).getFullYear()}-${pad(new Date(ms).getMonth() + 1)}-${pad(new Date(ms).getDate())}`

const resetOf = (kind: 'five' | 'week', ms: number | undefined) =>
  ms === undefined ? '' : kind === 'five' ? clock(ms) : `${DAYS[new Date(ms).getDay()]} ${clock(ms)}`

const thousands = (tokens: number) =>
  tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

const family = (model: string) =>
  /opus/i.test(model)
    ? 'Opus'
    : /sonnet/i.test(model)
      ? 'Sonnet'
      : /haiku/i.test(model)
        ? 'Haiku'
        : model

const FAMILY_HUE: Record<string, string> = {
  Opus: PALETTE.violet,
  Sonnet: PALETTE.teal,
  Haiku: PALETTE.blue,
}

// Series cost per model family, as a share of the cost of the runs.
export const costShares = (agents: AgentsJson) => {
  const byFamily = new Map<string, number>()
  for (const run of agents.runs) {
    byFamily.set(family(run.model), (byFamily.get(family(run.model)) ?? 0) + run.cost)
  }
  const sum = [...byFamily.values()].reduce((one, other) => one + other, 0)

  return sum > 0
    ? [...byFamily].map(([name, cost]) => ({
        name,
        share: Math.round((cost / sum) * 100),
      }))
    : []
}

const adviceOf = (quota: QuotaJson) =>
  quota.advice.level === 'launch' && quota.advice.more > 0
    ? `Room for ${quota.advice.more} more ${quota.advice.more === 1 ? 'agent' : 'agents'}`
    : quota.advice.text

// The colour of an advice follows its level: it says whether to launch.
export const adviceHue = (level: string) =>
  level === 'launch'
    ? TONE.success
    : ['smooth', 'no-room', 'five-hour'].includes(level)
      ? TONE.warning
      : ['stop', 'week-limit', 'no-resume'].includes(level)
        ? TONE.error
        : TONE.muted

// What is left before auto-compaction, in words.
export const contextSentence = (tokens: number, threshold: number) =>
  tokens > threshold
    ? `over the threshold by ${thousands(tokens - threshold)}`
    : `${thousands(threshold - tokens)} left before auto-compaction`

const contextHue = (percent: number) =>
  percent >= 90 ? TONE.error : percent >= 70 ? TONE.warning : TONE.info

type Reading = { percent: number; resetsAt: number | undefined }

// A window's reading: the live rate limit, else the counter `orch-status` kept.
const readingOf = (
  live: LightRateLimit[],
  kind: string,
  counter: QuotaCounter | undefined,
): Reading | undefined => {
  const found = live.find(limit => limit.kind === kind)
  if (found !== undefined) {
    return {
      percent: found.percentUsed,
      resetsAt: found.resetsAt === undefined ? undefined : new Date(found.resetsAt).getTime(),
    }
  }

  return counter === undefined || counter === null
    ? undefined
    : { percent: counter.used, resetsAt: counter.resetsAt }
}

export const renderCockpit = (context: CockpitContext) => {
  const ui = withLook(context.ui, context.look ?? lookFor('terminal', null))
  const { Box, Text } = ui
  const { board, columns, actions } = context
  const { light, heavy, view } = board
  const status = heavy?.status?.value
  const isWide = columns >= WIDE_AT
  const detail = view.detail
  // Each section is drawn in its own zone: it gets that zone's width.
  const hasDrawer = isWide && detail !== null
  const drawerColumns = Math.floor(columns * DRAWER_SHARE)
  const mainContext = {
    ...context,
    ui,
    columns: hasDrawer ? columns - drawerColumns - GAP_COLUMNS : columns,
  }
  const drawerContext = { ...context, ui, columns: isWide ? drawerColumns : columns }
  const heading = (title: string) => <Text {...roleProps(ui, 'heading')}>{title}</Text>
  const cells = cellsFor(mainContext.columns)

  const project = (status?.project ?? light?.project ?? '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
  const agents = light?.agents?.value ?? []
  const pending = light?.state?.value.pending ?? []
  const isAudioOn = light?.state?.value.isAudioOn === true
  const quota = status?.quota
  const live = light?.usage?.value.rateLimits ?? []
  const series = status?.report?.agents ?? status?.agents ?? undefined
  const failures = [...(light?.failures ?? []), ...(heavy?.failure ? [heavy.failure] : [])]
  const updatedAt = Math.max(light?.at ?? 0, heavy?.status?.at ?? 0)

  const sha = status?.lastReport?.sha.slice(0, 7)
  const reportAt = status?.report?.since.at
  const line =
    status === undefined
      ? undefined
      : sha !== undefined && reportAt !== undefined
        ? `${status.base.name} · report ${dayOf(reportAt)} ${clock(reportAt)} · ${sha}`
        : status.base.name

  const header = (
    <Box flexDirection="column">
      <Text {...roleProps(ui, 'title')}>{project === undefined || project === '' ? 'Board' : project}</Text>
      {line !== undefined && (
        <Text {...roleProps(ui, 'id')} dimColor wrap="truncate">
          {line}
        </Text>
      )}
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {agents.length > 0 &&
          Pill(ui, {
            label: `Series running · ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`,
            hue: TONE.warning,
          })}
        {pending.length > 0 &&
          Pill(ui, {
            label: `${pending.length} ${pending.length === 1 ? 'question needs' : 'questions need'} you`,
            hue: PALETTE.accent,
          })}
      </Box>
    </Box>
  )

  const tabs = Segmented(ui, {
    keyOf: id => `tab:${id}`,
    items: [
      { id: 'cockpit', label: 'Cockpit' },
      { id: 'usage', label: 'Usage' },
    ],
    active: view.tab,
    onSelect: id => actions.setTab(id as typeof view.tab),
  })

  // One window of the pace card: the number, the bar, where it resets.
  const windowRow = (
    kind: 'five' | 'week',
    reading: Reading,
    marker: { at: number; hue: string } | undefined,
    note: string,
  ) => (
    <Box key={`window:${kind}`} flexDirection="column" minWidth={0}>
      <Text>
        <Text {...roleProps(ui, 'figure')}>{`${Math.round(reading.percent)} %`}</Text>
        {` ${kind === 'five' ? '5 h window' : 'week'}`}
      </Text>
      {Bar(ui, {
        percent: reading.percent,
        cells,
        hue: reading.percent >= 90 ? TONE.error : reading.percent >= 70 ? TONE.warning : TONE.success,
        markers: marker === undefined ? [] : [marker],
      })}
      <Text {...roleProps(ui, 'caption')} wrap="truncate">{`resets ${resetOf(kind, reading.resetsAt)}${note}`}</Text>
    </Box>
  )

  const hasQuota = quota !== undefined && !isFailed(quota)
  const five = readingOf(live, 'five_hour', hasQuota ? quota.counters.five : undefined)
  const week = readingOf(live, 'seven_day', hasQuota ? quota.counters.week : undefined)

  const pace = Card(ui, {
    box: { flexGrow: 1, minWidth: CARD_MIN },
    children: (
      <Box flexDirection="column" gap={1} minWidth={0}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {heading('Launch pace')}
          {hasQuota &&
            Pill(ui, { label: adviceOf(quota), hue: adviceHue(quota.advice.level) })}
        </Box>
        {five === undefined && week === undefined && (
          <Text dimColor>No rate-limit reading yet.</Text>
        )}
        {five !== undefined &&
          windowRow(
            'five',
            five,
            hasQuota ? { at: quota.limits.fiveHour, hue: TONE.error } : undefined,
            hasQuota ? ` · limit ${quota.limits.fiveHour} %` : '',
          )}
        {week !== undefined &&
          windowRow(
            'week',
            week,
            hasQuota && quota.pace !== null ? { at: quota.pace.expected, hue: PALETTE.text } : undefined,
            hasQuota ? ` · target ${quota.limits.target} %` : '',
          )}
        {hasQuota && (
          <Box flexDirection="column" minWidth={0}>
            {quota.pace !== null && (
              <Text {...roleProps(ui, 'caption')}>
                {`expected ${quota.pace.expected} % · actual ${quota.pace.actual} % (${quota.pace.delta > 0 ? '+' : ''}${quota.pace.delta})`}
              </Text>
            )}
            <Text {...roleProps(ui, 'caption')}>{`${quota.running.total} running on the account`}</Text>
          </Box>
        )}
        {quota !== undefined && isFailed(quota) && (
          <Text dimColor>{`Pace unavailable: ${quota.error}`}</Text>
        )}
      </Box>
    ),
  })

  const ctx = status !== undefined && !isFailed(status.context) ? status.context : undefined
  const contextBox = Card(ui, {
    box: { flexGrow: 1, minWidth: CARD_MIN },
    children: (
      <Box flexDirection="column" gap={1} minWidth={0}>
        {heading('Context')}
        {status === undefined && <Text dimColor>Loading…</Text>}
        {status !== undefined && isFailed(status.context) && (
          <Text dimColor>{`Unavailable: ${status.context.error}`}</Text>
        )}
        {ctx !== undefined && (
          <Box flexDirection="column" minWidth={0}>
            <Text>
              <Text {...roleProps(ui, 'figure')}>{`${ctx.percent} %`}</Text>
              {` ${thousands(ctx.tokens)} of ${thousands(ctx.threshold)} tokens`}
            </Text>
            {Bar(ui, { percent: ctx.percent, cells, hue: contextHue(ctx.percent) })}
            <Text {...roleProps(ui, 'caption')}>{contextSentence(ctx.tokens, ctx.threshold)}</Text>
          </Box>
        )}
      </Box>
    ),
  })

  const parts =
    series !== undefined && !isFailed(series)
      ? costShares(series).map(one => ({
          label: `${one.name} ${one.share} %`,
          value: one.share,
          hue: FAMILY_HUE[one.name] ?? PALETTE.text2,
        }))
      : []
  const cost = Card(ui, {
    box: { flexGrow: 1, minWidth: CARD_MIN },
    children: (
      <Box flexDirection="column" gap={1} minWidth={0}>
        {heading('Series cost')}
        {series === undefined && <Text dimColor>{status === undefined ? 'Loading…' : 'No agent run yet.'}</Text>}
        {series !== undefined && isFailed(series) && <Text dimColor>{`Unavailable: ${series.error}`}</Text>}
        {series !== undefined && !isFailed(series) && (
          <Box flexDirection="column" minWidth={0}>
            <Text>
              <Text {...roleProps(ui, 'figure')}>{`$${series.total.cost.toFixed(2)}`}</Text>
              {` · ${series.runs.length} ${series.runs.length === 1 ? 'run' : 'runs'}`}
            </Text>
            {parts.length > 0 && StackedBar(ui, { parts, cells })}
            {parts.length > 0 && Legend(ui, { parts })}
          </Box>
        )}
      </Box>
    ),
  })

  const vitals = (
    <Box flexDirection="row" flexWrap="wrap" gap={1} minWidth={0}>
      {pace}
      {contextBox}
      {cost}
    </Box>
  )

  const footer = (
    <Box flexDirection="column">
      {failures.map(failure => (
        <Text {...roleProps(ui, 'caption')} wrap="truncate">{`! ${failure}`}</Text>
      ))}
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {Action(ui, { keyName: 'refresh', label: 'Refresh', onPress: () => actions.refresh() })}
        {updatedAt > 0 && <Text dimColor>{`updated ${clock(updatedAt)} ·`}</Text>}
        {isAudioOn && <Text dimColor>audio report on ·</Text>}
        <Text dimColor>{`${columns} cols`}</Text>
      </Box>
    </Box>
  )

  const cockpit = (
    <Box flexDirection="column" gap={1}>
      {vitals}
      {renderMissions(mainContext)}
      {renderAgents(mainContext)}
      {renderQuestions(mainContext)}
    </Box>
  )
  const body =
    view.tab === 'usage' ? (
      (renderUsage(mainContext) ?? <Text dimColor>Not yet available</Text>)
    ) : (
      cockpit
    )

  const drawer =
    detail === null ? null : detail.kind === 'mission' ? (
      renderMissionDetail(drawerContext)
    ) : detail.kind === 'question' ? (
      renderQuestionDetail(drawerContext)
    ) : detail.kind === 'agent' ? (
      renderAgentDetail(drawerContext)
    ) : (
      <Box flexDirection="column">
        <Text weight="semibold">{`${detail.kind} ${detail.id}`}</Text>
        <Text dimColor>Detail not available yet.</Text>
      </Box>
    )

  return (
    <Box flexDirection="column" gap={1}>
      {header}
      {tabs}
      {isWide ? (
        <Box key="layout:wide" flexDirection="row" gap={2}>
          <Box
            key="main"
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            overflow="hidden"
            gap={1}
          >
            {body}
          </Box>
          {detail !== null && (
            <Box
              key="drawer"
              flexDirection="column"
              width="40%"
              flexShrink={0}
              minWidth={0}
              overflow="hidden"
            >
              {Action(ui, { keyName: 'detail:close', label: 'Close', onPress: () => actions.closeDetail() })}
              {drawer}
            </Box>
          )}
        </Box>
      ) : detail === null ? (
        <Box key="layout:narrow" flexDirection="column" gap={1}>
          {body}
        </Box>
      ) : (
        <Box key="layout:detail" flexDirection="column" gap={1}>
          {Action(ui, { keyName: 'detail:back', label: 'Back', onPress: () => actions.closeDetail() })}
          {drawer}
        </Box>
      )}
      {footer}
    </Box>
  )
}
