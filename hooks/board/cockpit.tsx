import type {
  AgentsJson,
  BoardContext,
  ContextJson,
  ErrorJson,
  LightRateLimit,
  QuotaJson,
} from '../../types/board'
import { renderAgents } from './agents'
import { renderMissions } from './missions'
import { renderQuestions } from './questions'
import { renderUsage } from './usage'

// Pane body width (columns) from which the detail drawer sits on the right.
export const WIDE_AT = 110
const DRAWER_COLUMNS = 44
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const LABELS: Record<string, string> = {
  five_hour: '5 h window',
  seven_day: 'week',
}

const isFailed = (value: unknown): value is ErrorJson =>
  typeof value === 'object' && value !== null && 'error' in value

const gauge = (percent: number, cells = 10) => {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))

  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

const toneOf = (percent: number) =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

const resetOf = (limit: LightRateLimit) => {
  if (limit.resetsAt === undefined) {
    return ''
  }
  const at = new Date(limit.resetsAt)

  return limit.kind === 'five_hour'
    ? clock(at.getTime())
    : `${DAYS[at.getDay()]} ${clock(at.getTime())}`
}

const thousands = (tokens: number) =>
  tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`

const family = (model: string) =>
  /opus/i.test(model)
    ? 'Opus'
    : /sonnet/i.test(model)
      ? 'Sonnet'
      : /haiku/i.test(model)
        ? 'Haiku'
        : model

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

export const renderCockpit = (context: BoardContext) => {
  const { Box, Button, Text } = context.ui
  const { board, columns, actions } = context
  const { light, heavy, view } = board
  const status = heavy?.status?.value
  const isWide = columns >= WIDE_AT
  const heading = (title: string) => <Text weight="semibold">{title}</Text>

  const project = (status?.project ?? light?.project ?? '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
  const agents = light?.agents?.value ?? []
  const pending = light?.state?.value.pending ?? []
  const quota = status?.quota
  const live = light?.usage?.value.rateLimits ?? []
  const series = status?.report?.agents ?? status?.agents ?? undefined
  const failures = [...(light?.failures ?? []), ...(heavy?.failure ? [heavy.failure] : [])]
  const updatedAt = Math.max(light?.at ?? 0, heavy?.status?.at ?? 0)

  const header = (
    <Box flexDirection="column">
      <Text weight="semibold" size="heading">
        {project === undefined || project === '' ? 'Board' : project}
      </Text>
      {status !== undefined && (
        <Text dimColor wrap="truncate">
          {[status.base.name, status.lastReport?.line].filter(Boolean).join(' · ')}
        </Text>
      )}
      <Box gap={2}>
        {agents.length > 0 && (
          <Text color="warning">{`Series running · ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`}</Text>
        )}
        {pending.length > 0 && (
          <Text color="warning">{`${pending.length} ${pending.length === 1 ? 'question needs' : 'questions need'} you`}</Text>
        )}
        {light?.state?.value.isAudioOn === true && <Text dimColor>Audio report on</Text>}
      </Box>
    </Box>
  )

  const tabs = (
    <Box gap={1}>
      {(['cockpit', 'usage'] as const).map(tab => (
        <Button key={`tab:${tab}`} plain onPress={() => actions.setTab(tab)}>
          <Text weight={view.tab === tab ? 'semibold' : undefined} dimColor={view.tab !== tab}>
            {tab === 'cockpit' ? 'Cockpit' : 'Usage'}
          </Text>
        </Button>
      ))}
    </Box>
  )

  const pace = (
    <Box flexDirection="column">
      {heading('Launch pace')}
      {light?.usage === null || light === null ? (
        <Text dimColor>No rate-limit reading yet.</Text>
      ) : (
        live.map(limit => (
          <Text>
            <Text color={toneOf(limit.percentUsed)}>{gauge(limit.percentUsed)}</Text>{' '}
            {`${Math.round(limit.percentUsed)} % ${LABELS[limit.kind] ?? limit.kind}`}{' '}
            <Text dimColor>{`resets ${resetOf(limit)}`}</Text>
          </Text>
        ))
      )}
      {quota !== undefined && !isFailed(quota) && (
        <Box flexDirection="column">
          <Text color="success">{adviceOf(quota)}</Text>
          {quota.pace !== null && (
            <Text dimColor>
              {`expected ${quota.pace.expected} % · actual ${quota.pace.actual} % (${quota.pace.delta > 0 ? '+' : ''}${quota.pace.delta})`}
            </Text>
          )}
          <Text dimColor>
            {`limit ${quota.limits.fiveHour} % · target ${quota.limits.target} % · ${quota.running.total} running on the account`}
          </Text>
        </Box>
      )}
      {quota !== undefined && isFailed(quota) && <Text dimColor>{`Pace unavailable: ${quota.error}`}</Text>}
    </Box>
  )

  const contextBox = (
    <Box flexDirection="column">
      {heading('Context')}
      {status === undefined && <Text dimColor>Loading…</Text>}
      {status !== undefined && isFailed(status.context) && (
        <Text dimColor>{`Unavailable: ${status.context.error}`}</Text>
      )}
      {status !== undefined && !isFailed(status.context) && (
        <Box flexDirection="column">
          <Text>
            <Text color={toneOf((status.context as ContextJson).percent)}>
              {gauge((status.context as ContextJson).percent)}
            </Text>{' '}
            {`${(status.context as ContextJson).percent} % · ${thousands((status.context as ContextJson).tokens)} of ${thousands((status.context as ContextJson).threshold)} tokens`}
          </Text>
          <Text dimColor>{(status.context as ContextJson).verdict}</Text>
        </Box>
      )}
    </Box>
  )

  const cost = (
    <Box flexDirection="column">
      {heading('Series cost')}
      {series === undefined && <Text dimColor>{status === undefined ? 'Loading…' : 'No agent run yet.'}</Text>}
      {series !== undefined && isFailed(series) && <Text dimColor>{`Unavailable: ${series.error}`}</Text>}
      {series !== undefined && !isFailed(series) && (
        <Box flexDirection="column">
          <Text>{`$${series.total.cost.toFixed(2)} · ${series.runs.length} ${series.runs.length === 1 ? 'run' : 'runs'}`}</Text>
          <Text dimColor>{costShares(series).map(one => `${one.name} ${one.share} %`).join(' · ')}</Text>
        </Box>
      )}
    </Box>
  )

  const running = (
    <Box flexDirection="column">
      {heading(`Agents (${agents.length})`)}
      {agents.length === 0 && (
        <Text dimColor>{light?.agents === null || light === null ? 'Unavailable.' : 'None running.'}</Text>
      )}
      {agents.map(agent => (
        <Text wrap="truncate">
          <Text color="warning">●</Text> {agent.type}{' '}
          <Text dimColor>{`${agent.status} · ${agent.description} · ${minutes((light?.at ?? 0) - agent.firstSeenAt)}`}</Text>
        </Text>
      ))}
    </Box>
  )

  const footer = (
    <Box flexDirection="column">
      {failures.map(line => (
        <Text dimColor wrap="truncate">{`! ${line}`}</Text>
      ))}
      <Box gap={1}>
        <Button key="refresh" label="Refresh" onPress={() => actions.refresh()} />
        {updatedAt > 0 && <Text dimColor>{`updated ${clock(updatedAt)}`}</Text>}
      </Box>
    </Box>
  )

  const cockpit = (
    <Box flexDirection="column" gap={1}>
      {pace}
      {contextBox}
      {cost}
      {renderMissions(context)}
      {renderAgents(context)}
      {running}
      {renderQuestions(context)}
    </Box>
  )
  const body =
    view.tab === 'usage' ? (
      (renderUsage(context) ?? <Text dimColor>Not yet available</Text>)
    ) : (
      cockpit
    )

  const detail = view.detail
  const drawer =
    detail === null ? (
      <Text dimColor>Nothing selected.</Text>
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
          <Box key="main" flexDirection="column" flexGrow={1} gap={1}>
            {body}
          </Box>
          <Box key="drawer" flexDirection="column" width={DRAWER_COLUMNS}>
            {detail !== null && (
              <Button key="detail:close" label="Close" onPress={() => actions.closeDetail()} />
            )}
            {drawer}
          </Box>
        </Box>
      ) : detail === null ? (
        <Box key="layout:narrow" flexDirection="column" gap={1}>
          {body}
        </Box>
      ) : (
        <Box key="layout:detail" flexDirection="column" gap={1}>
          <Button key="detail:back" label="Back" onPress={() => actions.closeDetail()} />
          {drawer}
        </Box>
      )}
      {footer}
    </Box>
  )
}
