import type {
  Activity,
  AgentRun,
  BoardContext,
  CheckResult,
  LightAgent,
} from '../../types/board'
import { RAW_LINES, parseBrief } from './brief'
import { linkAgent } from './link'
import { isMorty } from './observe'

const STEPS = ['Setup', 'Implement', 'Checks', 'Report'] as const
const STEP_AT: Record<string, number> = { setup: 0, implement: 1, checks: 2 }
const SHOWN = 6

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`

const family = (model: string) =>
  /opus/i.test(model)
    ? 'Opus'
    : /sonnet/i.test(model)
      ? 'Sonnet'
      : /haiku/i.test(model)
        ? 'Haiku'
        : model

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

// What the Cockpit cards and the mission views say of a branch's last check.
export const checkLine = (result: CheckResult | undefined): string | null => {
  if (result === undefined) {
    return null
  }
  if (result.state === 'running') {
    return 'checks running'
  }
  if (result.state === 'error') {
    return `checks not run: ${result.error ?? 'unknown error'}`
  }
  const failed = result.checks.filter(item => item.state === 'fail').length

  return failed === 0 && result.verdict === 'green'
    ? `checks passed ${clock(result.at)}`
    : `${plural(failed, 'check', 'checks')} failing ${clock(result.at)}`
}

const runsOf = (context: BoardContext): AgentRun[] => {
  const status = context.board.heavy?.status?.value
  const series = status?.report?.agents ?? status?.agents ?? undefined

  return series !== undefined && 'runs' in series ? series.runs : []
}

// The branch an agent works on: its worktree's, else the one its brief names.
const branchOf = (context: BoardContext, id: string): string | null => {
  const { light, heavy, activity } = context.board
  const tree = (light?.worktrees?.value ?? []).find(one =>
    one.path.replace(/\\/g, '/').replace(/\/+$/, '').endsWith(`/agent-${id}`),
  )
  if (tree !== undefined && tree.branch !== '(detached)') {
    return tree.branch
  }

  return (
    light?.missions?.briefs[id] ?? heavy?.missions?.briefs[id] ?? activity[id]?.brief?.branch ?? null
  )
}

const missionOf = (context: BoardContext, agent: LightAgent): string | null => {
  const { light, heavy } = context.board
  const status = heavy?.status?.value
  const trees = [
    ...(light?.worktrees?.value ?? []).map(tree => ({ branch: tree.branch, path: tree.path })),
    ...(status?.worktrees ?? []).map(tree => ({ branch: tree.branch, path: tree.path })),
  ]
  const briefs = { ...heavy?.missions?.briefs, ...light?.missions?.briefs }

  return linkAgent(
    { agentId: agent.id, description: agent.description, briefBranch: briefs[agent.id] },
    light?.missions?.rows ?? [],
    trees,
  )
}

// Marks of the four steps of a morty: done, the one in progress, to come.
const stepMarks = (activity: Activity | undefined, run: AgentRun | undefined) => {
  const current = run?.finished === true ? STEPS.length : (STEP_AT[activity?.step ?? ''] ?? -1)

  return STEPS.map((name, index) => ({
    name,
    state: index < current ? 'done' : index === current ? 'active' : 'todo',
  }))
}

const MARK = { done: '✓', active: '●', todo: '○' } as const

export const renderAgents = (context: BoardContext) => {
  const { Box, Button, Text } = context.ui
  const { board, actions } = context
  const { light, checks, activity } = board
  const agents = light?.agents?.value ?? []
  const runs = runsOf(context)

  return (
    <Box flexDirection="column">
      <Text weight="semibold">{`Agents (${agents.length})`}</Text>
      {agents.length === 0 && (
        <Text dimColor>{light?.agents === null || light === null ? 'Unavailable.' : 'None running.'}</Text>
      )}
      {agents.map(agent => {
        const seen: Activity | undefined = activity[agent.id]
        const run = runs.find(one => one.agentId === agent.id)
        const mission = missionOf(context, agent)
        const branch = branchOf(context, agent.id)
        const check = checkLine(branch === null ? undefined : checks[branch])
        const model = run === undefined ? '' : family(run.model)
        const facts = [
          seen === undefined || seen.unavailable === true ? null : plural(seen.calls, 'call', 'calls'),
          seen?.ahead === undefined || seen.ahead === null ? null : `${seen.ahead} ahead`,
        ].filter(Boolean)

        return (
          <Box key={`agent:${agent.id}`} flexDirection="column" marginBottom={1}>
            <Button key={`agent:open:${agent.id}`} plain onPress={() => actions.openAgent(agent.id)}>
              <Text color="warning">●</Text>
              <Text weight="semibold">{` ${agent.type}`}</Text>
              {model !== '' && <Text dimColor>{` · ${model}`}</Text>}
            </Button>
            <Text dimColor wrap="truncate">
              {`${agent.status} · ${mission ?? agent.description} · ${minutes((light?.at ?? 0) - agent.firstSeenAt)}`}
            </Text>
            {isMorty(agent.type) && seen !== undefined && (
              <Text wrap="truncate">
                {stepMarks(seen, run)
                  .map(step => `${MARK[step.state as keyof typeof MARK]} ${step.name}`)
                  .join('  ')}
              </Text>
            )}
            {seen?.unavailable === true && <Text dimColor>activity unavailable</Text>}
            {seen !== undefined && seen.unavailable !== true && seen.lastTool !== '' && (
              <Text wrap="truncate">
                <Text weight="semibold">{seen.lastTool}</Text>
                <Text dimColor>{` ${seen.lastSummary ?? ''}`}</Text>
              </Text>
            )}
            {facts.length > 0 && <Text dimColor>{facts.join(' · ')}</Text>}
            {check !== null && <Text dimColor wrap="truncate">{check}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

// The detail of one agent (the drawer): brief, steps, calls, checks, usage,
// branch. Nothing here sends a request to a model.
export const renderAgentDetail = (context: BoardContext) => {
  const { Box, Button, Text } = context.ui
  const { board, actions } = context
  const { light, heavy, view, checks, activity } = board
  const id = view.detail?.id ?? ''
  const agent = light?.agents?.value.find(one => one.id === id)
  const run = runsOf(context).find(one => one.agentId === id)
  const seen: Activity | undefined = activity[id]
  const type = agent?.type ?? run?.type ?? ''
  const description = agent?.description ?? run?.description ?? ''
  if (agent === undefined && run === undefined) {
    return <Text dimColor>{`Agent ${id} is not running and has no run record.`}</Text>
  }
  const mission = agent === undefined ? null : missionOf(context, agent)
  const branch = branchOf(context, id)
  const base = heavy?.status?.value.base.name
  const brief = seen?.brief
  const isFull = view.toggled.includes(`agent:full:${id}`)
  const parsed = brief === undefined || brief === null ? null : parseBrief(brief.text)
  const result = branch === null ? undefined : checks[branch]
  const started = run?.started ?? agent?.firstSeenAt
  const heading = (title: string, note?: string) => (
    <Text weight="semibold">
      {title}
      {note !== undefined && <Text dimColor>{` · ${note}`}</Text>}
    </Text>
  )
  const row = (label: string, text: string) => (
    <Text wrap="wrap">
      <Text dimColor>{`${label} `}</Text>
      {text}
    </Text>
  )
  const more = (all: string[]) =>
    all.length > SHOWN ? <Text dimColor>{`${all.length - SHOWN} more`}</Text> : null

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text weight="semibold" wrap="wrap">
          {mission === null ? description : `${mission} · ${description}`}
        </Text>
        <Text dimColor>
          {[
            type,
            run === undefined ? '' : family(run.model),
            started === undefined ? '' : `started ${clock(started)}`,
            agent === undefined || light === null ? '' : minutes(light.at - agent.firstSeenAt),
            seen === undefined || seen.unavailable === true ? '' : plural(seen.calls, 'tool call', 'tool calls'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {branch !== null && (
          <Text wrap="truncate">
            {branch}
            <Text dimColor>{base === undefined ? '' : ` from ${base}`}</Text>
          </Text>
        )}
      </Box>

      <Box flexDirection="column">
        <Box gap={1}>
          {heading('Brief', brief === undefined || brief === null ? undefined : `from the orchestrator, ${clock(brief.at)}`)}
          <Button
            key={`agent:full:${id}`}
            plain
            dimColor
            onPress={() => actions.toggle(`agent:full:${id}`)}
          >
            {isFull ? 'Summary' : 'Full text'}
          </Button>
        </Box>
        {brief === undefined && <Text dimColor>Reading the brief…</Text>}
        {brief === null && <Text dimColor>No brief was captured for this agent.</Text>}
        {brief !== undefined && brief !== null && parsed !== null && isFull && (
          <Box flexDirection="column">
            {brief.text.split(/\r?\n/).map((line, index) => (
              <Text key={`full:${index}`} wrap="wrap">{line}</Text>
            ))}
          </Box>
        )}
        {parsed !== null && !isFull && !parsed.isTemplate && (
          <Box flexDirection="column">
            {parsed.raw.map((line, index) => (
              <Text key={`raw:${index}`} wrap="wrap">{line}</Text>
            ))}
            <Text dimColor>{`first ${RAW_LINES} lines as written`}</Text>
          </Box>
        )}
        {parsed !== null && !isFull && parsed.isTemplate && (
          <Box flexDirection="column">
            {parsed.goal !== '' && row('Goal', parsed.goal)}
            {parsed.zone !== '' && row('Zone', parsed.zone)}
            {parsed.rules.length > 0 && heading(`Rules · ${parsed.rules.length}`)}
            {parsed.rules.slice(0, SHOWN).map(rule => (
              <Text key={`rule:${rule}`} wrap="wrap">{rule}</Text>
            ))}
            {more(parsed.rules)}
            {parsed.traps.length > 0 && heading(`Traps · ${parsed.traps.length}`)}
            {parsed.traps.slice(0, SHOWN).map(trap => (
              <Text key={`trap:${trap}`} wrap="wrap">{`- ${trap}`}</Text>
            ))}
            {more(parsed.traps)}
            {parsed.tests.length > 0 && row(`Tests · ${parsed.tests.length}`, parsed.tests.map(test => test.split(/\s/)[0]).join(' '))}
            {parsed.verify !== '' && row('Verify', parsed.verify)}
          </Box>
        )}
        <Text dimColor>Read from the prompt the agent was given: no model request.</Text>
      </Box>

      {isMorty(type) && (
        <Box flexDirection="column">
          {heading('Steps')}
          <Text>
            {stepMarks(seen, run)
              .map(step => `${MARK[step.state as keyof typeof MARK]} ${step.name}`)
              .join('  ')}
          </Text>
        </Box>
      )}

      <Box flexDirection="column">
        {heading('Tool calls', seen?.tools === undefined ? undefined : `latest ${seen.tools.length} of ${seen.calls}`)}
        {seen?.unavailable === true && <Text dimColor>activity unavailable</Text>}
        {seen?.tools === undefined && seen?.unavailable !== true && <Text dimColor>No reading yet.</Text>}
        {(seen?.tools ?? []).map((call, index) => (
          <Text key={`call:${index}`} wrap="truncate">
            <Text weight="semibold">{call.tool}</Text>
            {` ${call.summary} `}
            <Text color={call.state === 'error' ? 'error' : call.state === 'running' ? 'warning' : 'success'}>
              {call.state}
            </Text>
          </Text>
        ))}
      </Box>

      <Box flexDirection="column">
        {heading('agent-check', result === undefined || result.state === 'running' ? undefined : clock(result.at))}
        {result?.state === 'running' && <Text color="warning">Running agent-check…</Text>}
        {result?.note !== undefined && <Text dimColor>{result.note}</Text>}
        {result?.state === 'error' && <Text color="error" wrap="wrap">{`Not run: ${result.error ?? 'unknown error'}`}</Text>}
        {result?.state === 'done' &&
          result.checks.map(item => (
            <Text key={`check:${item.name}`} wrap="truncate">
              <Text color={item.state === 'ok' ? 'success' : item.state === 'fail' ? 'error' : undefined} dimColor={item.state === 'skip'}>
                {item.state === 'ok' ? 'Pass' : item.state === 'fail' ? 'Fail' : 'Skip'}
              </Text>
              {` ${item.name}`}
              <Text dimColor>{item.detail === '' ? '' : ` · ${item.detail}`}</Text>
            </Text>
          ))}
        {branch === null && <Text dimColor>No branch known for this agent.</Text>}
        {branch !== null && result?.state !== 'running' && (
          <Button key={`check:run:${branch}`} label="Run agent-check" onPress={() => actions.runCheck(branch)} />
        )}
      </Box>

      <Box flexDirection="column">
        {heading('Usage', run === undefined ? undefined : `≈ $${run.cost.toFixed(2)}`)}
        {run === undefined && <Text dimColor>Not recorded yet.</Text>}
        {run !== undefined && (
          <Box flexDirection="column">
            <Text dimColor>{`Input, not cached · ${Math.round(run.tokens.input / 1000)}k`}</Text>
            <Text dimColor>{`Served from cache · ${Math.round(run.tokens.read / 1000)}k`}</Text>
            <Text dimColor>{`Output · ${Math.round(run.tokens.output / 1000)}k`}</Text>
          </Box>
        )}
      </Box>

      <Box flexDirection="column">
        {heading(
          'Branch',
          seen?.branch === undefined
            ? undefined
            : [
                seen.ahead === undefined || seen.ahead === null ? null : `${seen.ahead} ahead`,
                seen.branch.dirty === null ? null : `${plural(seen.branch.dirty, 'file', 'files')} not committed`,
              ]
                .filter(Boolean)
                .join(', '),
        )}
        {seen?.branch === undefined && <Text dimColor>Reading the branch…</Text>}
        {seen?.branch !== undefined && seen.branch.files === null && (
          <Text dimColor>The changed files could not be read.</Text>
        )}
        {(seen?.branch?.files ?? []).map(file => (
          <Text key={`file:${file.path}`} wrap="truncate">
            {file.path}
            <Text dimColor>
              {file.added === null || file.removed === null ? ' binary' : ` +${file.added} −${file.removed}`}
            </Text>
          </Text>
        ))}
        {seen?.branch?.files !== null &&
          seen?.branch?.total !== null &&
          seen?.branch !== undefined &&
          seen.branch.total > (seen.branch.files?.length ?? 0) && (
            <Text dimColor>{`${seen.branch.total - (seen.branch.files?.length ?? 0)} more files`}</Text>
          )}
      </Box>
    </Box>
  )
}
