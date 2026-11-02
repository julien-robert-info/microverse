import type {
  Activity,
  AgentRun,
  BoardContext,
  CheckResult,
  LightAgent,
} from '../../types/board'
import { parseBrief } from './brief'
import {
  Action,
  Avatar,
  Card,
  Legend,
  Pill,
  Segmented,
  StackedBar,
  Steps,
  cellsFor,
  roleProps,
} from './kit'
import { linkAgent } from './link'
import { isMorty } from './observe'
import { AGENT_HUE, PALETTE, TONE, toolHue } from './tokens'

const STEPS = ['Setup', 'Implement', 'Checks', 'Report'] as const
const STEP_AT: Record<string, number> = { setup: 0, implement: 1, checks: 2 }
const SHOWN = 6
// Lines of a brief without the template shown before "n more lines".
const RAW_SHOWN = 8

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

// The worktree made for an agent, with its path as the board's repository
// knows it.
const treeOf = (context: BoardContext, id: string) =>
  (context.board.light?.worktrees?.value ?? []).find(one =>
    one.path.replace(/\\/g, '/').replace(/\/+$/, '').endsWith(`/agent-${id}`),
  )

// The branch an agent works on: its worktree's, else the one its brief names.
const branchOf = (context: BoardContext, id: string): string | null => {
  const { light, heavy, activity } = context.board
  const tree = treeOf(context, id)
  if (tree !== undefined && tree.branch !== '(detached)') {
    return tree.branch
  }

  return (
    light?.missions?.briefs[id] ?? heavy?.missions?.briefs[id] ?? activity[id]?.brief?.branch ?? null
  )
}

// The worktree path relative to the repository root, else as it is.
const relOf = (context: BoardContext, id: string): string | null => {
  const tree = treeOf(context, id)
  if (tree === undefined) {
    return null
  }
  const path = tree.path.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = (context.board.light?.root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')

  return root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
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

// The four steps of a morty: done, the one in progress, to come.
const stepMarks = (activity: Activity | undefined, run: AgentRun | undefined) => {
  const current = run?.finished === true ? STEPS.length : (STEP_AT[activity?.step ?? ''] ?? -1)

  return STEPS.map((label, index) => ({
    label,
    state: index < current ? ('done' as const) : index === current ? ('doing' as const) : ('todo' as const),
  }))
}

// `microverse:morty` gives `morty`; a type the board does not know gets no hue
// of its own.
const kindOf = (type: string) => /(?:^|:)([^:]+)$/.exec(type)?.[1].toLowerCase() ?? type

const avatarOf = (ui: BoardContext['ui'], type: string) => {
  const kind = kindOf(type)

  return Avatar(ui, {
    letter: (kind[0] ?? '?').toUpperCase(),
    hue: AGENT_HUE[kind] ?? PALETTE.text2,
  })
}

const statePill = (ui: BoardContext['ui'], status: string) =>
  Pill(ui, { label: status, hue: status === 'running' ? TONE.warning : TONE.success })

// A tool call state: running is warm, an error red, the rest green.
const callColor = (state: string) =>
  state === 'error' ? 'error' : state === 'running' ? 'warning' : 'success'

export const renderAgents = (context: BoardContext) => {
  const { ui } = context
  const { Box, Button, Text } = ui
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
            {Card(ui, {
              children: (
                <Box flexDirection="column" minWidth={0}>
                  <Box flexDirection="row" gap={1} minWidth={0}>
                    {avatarOf(ui, agent.type)}
                    <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
                      <Button key={`agent:open:${agent.id}`} plain onPress={() => actions.openAgent(agent.id)}>
                        <Text weight="semibold">{agent.type}</Text>
                        {model !== '' && <Text dimColor>{` · ${model}`}</Text>}
                      </Button>
                    </Box>
                    <Box flexShrink={0}>{statePill(ui, agent.status)}</Box>
                  </Box>
                  <Box flexDirection="row" gap={1} minWidth={0}>
                    {/* One string: tests/board.test.tsx reads "running · task · 5 min". */}
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text {...roleProps(ui, 'id')} wrap="truncate">
                        {`${agent.status} · ${mission ?? agent.description} · ${minutes((light?.at ?? 0) - agent.firstSeenAt)}`}
                      </Text>
                    </Box>
                  </Box>
                  {isMorty(agent.type) && seen !== undefined && Steps(ui, { steps: stepMarks(seen, run) })}
                  {seen?.unavailable === true && <Text dimColor>activity unavailable</Text>}
                  {seen !== undefined && seen.unavailable !== true && seen.lastTool !== '' && (
                    <Box flexDirection="row" gap={1} minWidth={0}>
                      <Box flexShrink={0}>{Pill(ui, { label: seen.lastTool, hue: toolHue(seen.lastTool) })}</Box>
                      <Box flexGrow={1} flexShrink={1} minWidth={0}>
                        <Text wrap="truncate">{seen.lastSummary ?? ''}</Text>
                      </Box>
                    </Box>
                  )}
                  {facts.length > 0 && <Text dimColor>{facts.join(' · ')}</Text>}
                  {check !== null && <Text dimColor wrap="truncate">{check}</Text>}
                </Box>
              ),
            })}
          </Box>
        )
      })}
    </Box>
  )
}

// The detail of one agent (the drawer): brief, steps, calls, checks, usage,
// branch. Nothing here sends a request to a model.
export const renderAgentDetail = (context: BoardContext) => {
  const { ui } = context
  const { Box, Button, Text } = ui
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
  const rel = relOf(context, id)
  const base = heavy?.status?.value.base.name
  const brief = seen?.brief
  const isFull = view.toggled.includes(`agent:full:${id}`)
  const parsed = brief === undefined || brief === null ? null : parseBrief(brief.text)
  const result = branch === null ? undefined : checks[branch]
  const started = run?.started ?? agent?.firstSeenAt
  const status = agent?.status ?? (run?.finished === true ? 'finished' : 'ended')
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
  const briefText = brief === undefined || brief === null ? '' : brief.text
  const rawLines = parsed === null ? [] : parsed.raw

  return (
    <Box flexDirection="column" gap={1}>
      {Card(ui, {
        children: (
          <Box flexDirection="column" minWidth={0}>
            <Box flexDirection="row" gap={1} minWidth={0}>
              {avatarOf(ui, type)}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text weight="semibold" wrap="wrap">
                  {mission === null ? description : `${mission} · ${description}`}
                </Text>
              </Box>
              <Box flexShrink={0}>{statePill(ui, status)}</Box>
            </Box>
            <Text dimColor wrap="wrap">
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
              <Box flexDirection="row" minWidth={0}>
                <Box flexShrink={1} minWidth={0}>
                  <Text {...roleProps(ui, 'id')} wrap="truncate">{branch}</Text>
                </Box>
                {base !== undefined && (
                  <Box flexShrink={0}>
                    <Text dimColor>{` from ${base}`}</Text>
                  </Box>
                )}
                {rel !== null && (
                  <Box flexShrink={1} minWidth={0}>
                    <Text dimColor wrap="truncate">{`  ${rel}`}</Text>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        ),
      })}

      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} minWidth={0}>
          {heading('Brief', brief === undefined || brief === null ? undefined : `from the orchestrator, ${clock(brief.at)}`)}
        </Box>
        {Segmented(ui, {
          keyOf: choice => (choice === 'full' ? `agent:full:${id}` : `agent:summary:${id}`),
          items: [
            { id: 'summary', label: 'Summary' },
            { id: 'full', label: 'Full text' },
          ],
          active: isFull ? 'full' : 'summary',
          // A click on the tab already shown changes nothing.
          onSelect: choice => (choice === 'full') === isFull || actions.toggle(`agent:full:${id}`),
        })}
        {brief === undefined && <Text dimColor>Reading the brief…</Text>}
        {brief === null && <Text dimColor>No brief was captured for this agent.</Text>}
        {brief !== undefined && brief !== null && parsed !== null && isFull && (
          <Box flexDirection="column">
            {briefText.split(/\r?\n/).map((line, index) => (
              <Text key={`full:${index}`} wrap="wrap">{line}</Text>
            ))}
          </Box>
        )}
        {parsed !== null && !isFull && !parsed.isTemplate &&
          Card(ui, {
            inner: true,
            children: (
              <Box flexDirection="column">
                {rawLines.slice(0, RAW_SHOWN).map((line, index) => (
                  <Text key={`raw:${index}`} wrap="wrap">{line}</Text>
                ))}
                {rawLines.length > RAW_SHOWN && (
                  <Text dimColor>{`${rawLines.length - RAW_SHOWN} more lines`}</Text>
                )}
              </Box>
            ),
          })}
        {parsed !== null && !isFull && parsed.isTemplate &&
          Card(ui, {
            inner: true,
            children: (
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
            ),
          })}
        <Text dimColor>Read from the prompt the agent was given: no model request.</Text>
      </Box>

      {isMorty(type) && (
        <Box flexDirection="column">
          {heading('Steps')}
          {Steps(ui, { steps: stepMarks(seen, run) })}
        </Box>
      )}

      <Box flexDirection="column">
        {heading('Tool calls', seen?.tools === undefined ? undefined : `latest ${seen.tools.length} of ${seen.calls}`)}
        {seen?.unavailable === true && <Text dimColor>activity unavailable</Text>}
        {seen?.tools === undefined && seen?.unavailable !== true && <Text dimColor>No reading yet.</Text>}
        {(seen?.tools ?? []).map((call, index) => (
          <Box key={`call:${index}`} flexDirection="row" gap={1} minWidth={0}>
            <Box flexShrink={0}>{Pill(ui, { label: call.tool, hue: toolHue(call.tool) })}</Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text {...roleProps(ui, 'id')} wrap="truncate">{call.summary}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={callColor(call.state)}>{call.state}</Text>
            </Box>
          </Box>
        ))}
      </Box>

      {Card(ui, {
        inner: true,
        children: (
          <Box flexDirection="column" minWidth={0}>
            {heading('agent-check', result === undefined || result.state === 'running' ? undefined : clock(result.at))}
            {result?.state === 'running' && <Text color="warning">Running agent-check…</Text>}
            {result?.note !== undefined && <Text dimColor>{result.note}</Text>}
            {result?.state === 'error' && <Text color="error" wrap="wrap">{`Not run: ${result.error ?? 'unknown error'}`}</Text>}
            {result?.state === 'done' &&
              result.checks.map(item => (
                <Box key={`check:${item.name}`} flexDirection="row" gap={1} minWidth={0}>
                  <Box flexShrink={0}>
                    <Text
                      color={item.state === 'ok' ? 'success' : item.state === 'fail' ? 'error' : undefined}
                      dimColor={item.state === 'skip'}
                    >
                      {item.state === 'ok' ? 'Pass' : item.state === 'fail' ? 'Fail' : 'Skip'}
                    </Text>
                  </Box>
                  <Box flexShrink={1} minWidth={0}>
                    <Text wrap="truncate">{item.name}</Text>
                  </Box>
                  {item.detail !== '' && (
                    <Box flexShrink={1} minWidth={0}>
                      <Text dimColor wrap="truncate">{`· ${item.detail}`}</Text>
                    </Box>
                  )}
                </Box>
              ))}
            {branch === null && <Text dimColor>No branch known for this agent.</Text>}
            {branch !== null &&
              result?.state !== 'running' &&
              Action(ui, { keyName: `check:run:${branch}`, label: 'Run agent-check', onPress: () => actions.runCheck(branch) })}
          </Box>
        ),
      })}

      {Card(ui, {
        inner: true,
        children: (
          <Box flexDirection="column" minWidth={0}>
            {heading('Usage')}
            {run === undefined && <Text dimColor>Not recorded yet.</Text>}
            {run !== undefined && (
              <Box flexDirection="column" minWidth={0}>
                <Text {...roleProps(ui, 'figure')}>{`≈ $${run.cost.toFixed(2)}`}</Text>
                {StackedBar(ui, {
                  cells: cellsFor(context.columns),
                  parts: [
                    { label: 'input', value: run.tokens.input, hue: PALETTE.blue },
                    { label: 'cache', value: run.tokens.read, hue: PALETTE.teal },
                    { label: 'output', value: run.tokens.output, hue: PALETTE.violet },
                  ],
                })}
                {Legend(ui, {
                  parts: [
                    { label: `Input, not cached · ${Math.round(run.tokens.input / 1000)}k`, value: run.tokens.input, hue: PALETTE.blue },
                    { label: `Served from cache · ${Math.round(run.tokens.read / 1000)}k`, value: run.tokens.read, hue: PALETTE.teal },
                    { label: `Output · ${Math.round(run.tokens.output / 1000)}k`, value: run.tokens.output, hue: PALETTE.violet },
                  ],
                })}
              </Box>
            )}
          </Box>
        ),
      })}

      {Card(ui, {
        inner: true,
        children: (
          <Box flexDirection="column" minWidth={0}>
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
              <Box key={`file:${file.path}`} flexDirection="row" gap={1} minWidth={0}>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text {...roleProps(ui, 'id')} wrap="truncate">{file.path}</Text>
                </Box>
                {(file.added === null || file.removed === null) && (
                  <Box flexShrink={0}>
                    <Text dimColor>binary</Text>
                  </Box>
                )}
                {file.added !== null && file.removed !== null && (
                  <Box flexShrink={0}>
                    <Text color="success">{`+${file.added}`}</Text>
                  </Box>
                )}
                {file.added !== null && file.removed !== null && (
                  <Box flexShrink={0}>
                    <Text color="error">{`−${file.removed}`}</Text>
                  </Box>
                )}
              </Box>
            ))}
            {seen?.branch?.files !== null &&
              seen?.branch?.total !== null &&
              seen?.branch !== undefined &&
              seen.branch.total > (seen.branch.files?.length ?? 0) && (
                <Text dimColor>{`${seen.branch.total - (seen.branch.files?.length ?? 0)} more files`}</Text>
              )}
          </Box>
        ),
      })}
    </Box>
  )
}
