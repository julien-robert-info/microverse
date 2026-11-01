import type {
  AgentRun,
  BoardContext,
  BoardData,
  MissionRow,
  NoteType,
  NotesItem,
} from '../../types/board'
import { WIDE_AT } from './cockpit'
import { linkAgent } from './link'
import { NOTE_TYPES, filesOf } from './notes'

export type Column = 'design' | 'brief' | 'building' | 'review' | 'merge' | 'merged' | 'other'

const COLUMNS: { name: Column; label: string }[] = [
  { name: 'design', label: 'Design' },
  { name: 'brief', label: 'Brief' },
  { name: 'building', label: 'Building' },
  { name: 'review', label: 'Review' },
  { name: 'merge', label: 'To merge' },
  { name: 'merged', label: 'Merged' },
  { name: 'other', label: 'Other' },
]
const TYPE_LABELS: Record<NoteType, string> = {
  decided: 'Decided',
  measures: 'Measures',
  risks: 'Risks',
  open: 'Open points',
  verified: 'Verified',
  brief: 'Brief',
  other: 'Other',
}
const MERGED_SHOWN = 3
const RAW_LINES = 400
// A column of the narrow list starts unfolded when it holds live work.
const OPEN_BY_DEFAULT: Column[] = ['design', 'brief', 'building', 'review', 'merge']

type Running = { id: string; type: string; description: string; firstSeenAt: number }

export type MissionView = {
  row: MissionRow
  column: Column
  running: Running[]
  runs: AgentRun[]
  // Last cited hash that is an ancestor of the base, as a time.
  mergedAt: number | null
  // The branch exists as a worktree or as an unmerged branch.
  hasBranch: boolean
}

const label = (name: Column) => COLUMNS.find(column => column.name === name)?.label ?? name

const stamp = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`

const fileHref = (project: string, relative: string) =>
  `file:///${project.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')}/${relative}`

const kindOf = (type: string) =>
  /rick$/.test(type) ? 'rick' : /morty$/.test(type) ? 'morty' : /council$/.test(type) ? 'council' : null

// Rule E-4, first rule that applies. `running` holds the live agents linked to
// the mission; meeseeks and any other type do not count.
export const columnOf = (facts: {
  row: MissionRow
  running: Running[]
  hasTree: boolean
  isTreeMerged: boolean
  hasBranch: boolean
  isAncestor: boolean
  hasNotes: boolean
  hasBriefTitle: boolean
}): Column => {
  const kinds = facts.running.map(agent => kindOf(agent.type))
  if (kinds.includes('morty')) {
    return 'building'
  }
  if (kinds.includes('council')) {
    return 'review'
  }
  if (kinds.includes('rick')) {
    return 'design'
  }
  if (facts.hasTree && !facts.isTreeMerged) {
    return 'merge'
  }
  if (facts.isTreeMerged || (!facts.hasBranch && facts.isAncestor)) {
    return 'merged'
  }
  if (!facts.hasBranch && facts.hasBriefTitle) {
    return 'brief'
  }
  if (facts.hasNotes) {
    return 'design'
  }

  return 'other'
}

// The runs of the series and the agents now running, each linked to a mission
// (rule E-2) or not.
export const viewsOf = (board: BoardData): { views: MissionView[]; loose: AgentRun[] } => {
  const missions = board.light?.missions
  const rows = missions?.rows ?? []
  const status = board.heavy?.status?.value
  const facts = board.heavy?.missions
  const briefs = { ...facts?.briefs, ...missions?.briefs }
  const lightTrees = (board.light?.worktrees?.value ?? []).filter(tree => !tree.isMain)
  const trees = [
    ...lightTrees.map(tree => ({ branch: tree.branch, path: tree.path })),
    ...(status?.worktrees ?? []).map(tree => ({ branch: tree.branch, path: tree.path })),
  ]
  const merged = new Set((status?.worktrees ?? []).filter(tree => tree.merged).map(tree => tree.branch))
  const unmerged = new Set([
    ...lightTrees.map(tree => tree.branch).filter(branch => !merged.has(branch)),
    ...(status?.worktrees ?? []).filter(tree => !tree.merged).map(tree => tree.branch),
  ])
  const free = new Set((status?.free ?? []).map(entry => entry.branch))
  const series = status?.report?.agents ?? status?.agents ?? undefined
  const runs = series !== undefined && 'runs' in series ? series.runs : []

  const live = (board.light?.agents?.value ?? []).map(agent => ({
    agent,
    mission: linkAgent(
      { agentId: agent.id, description: agent.description, briefBranch: briefs[agent.id] },
      rows,
      trees,
    ),
  }))
  const linked = runs.map(run => ({
    run,
    mission: linkAgent(
      { agentId: run.agentId, description: run.description, briefBranch: briefs[run.agentId] },
      rows,
      trees,
    ),
  }))

  const views = rows.map((row): MissionView => {
    const running = live.filter(one => one.mission === row.id).map(one => one.agent)
    const files = missions === undefined ? [] : filesOf(missions, row.id)
    const main = missions?.notes[`${row.id}.md`]
    const ancestors = row.hashes
      .map(hash => facts?.hashes[hash])
      .filter(fact => fact?.ancestor === true)
    const dates = ancestors.map(fact => fact?.at ?? 0)
    const hasTree = row.branch !== null && unmerged.has(row.branch)
    const isTreeMerged = row.branch !== null && merged.has(row.branch)
    const hasBranch = hasTree || (row.branch !== null && free.has(row.branch))

    return {
      row,
      running,
      runs: linked.filter(one => one.mission === row.id).map(one => one.run),
      mergedAt: dates.length > 0 ? Math.max(...dates) || null : null,
      hasBranch,
      column: columnOf({
        row,
        running,
        hasTree,
        isTreeMerged,
        hasBranch,
        isAncestor: ancestors.length > 0,
        hasNotes: main !== undefined,
        hasBriefTitle: main?.items.some(item => item.type === 'brief') === true,
      }),
    }
  })

  return { views, loose: linked.filter(one => one.mission === null).map(one => one.run) }
}

const isSpoken = (view: MissionView) => view.column !== 'merged' && view.column !== 'other'

export const renderMissions = (context: BoardContext) => {
  const { Box, Button, Text } = context.ui
  const { board, columns, actions } = context
  const missions = board.light?.missions
  if (missions === undefined) {
    return null
  }
  const { views, loose } = viewsOf(board)
  const isWide = columns >= WIDE_AT
  const toggled = board.view.toggled
  const flipped = (key: string) => toggled.includes(key)
  const byColumn = (name: Column) => {
    const own = views.filter(view => view.column === name)

    // The most recent first; rows without a date keep the table's order,
    // newest line last.
    return name === 'merged'
      ? [...own].reverse().sort((one, other) => (other.mergedAt ?? 0) - (one.mergedAt ?? 0))
      : own
  }

  const card = (view: MissionView, name: Column) => {
    const branch = view.row.branch
    const check = branch === null ? undefined : board.checks[branch]
    const meta = [
      view.running[0] === undefined
        ? undefined
        : `${view.running[0].type.split(':').pop()} ${minutes((board.light?.at ?? 0) - view.running[0].firstSeenAt)}`,
      name === 'merged' && view.mergedAt !== null ? stamp(view.mergedAt).slice(0, 10) : undefined,
      check === undefined
        ? undefined
        : check.state === 'running'
          ? 'checking…'
          : check.verdict === 'green'
            ? 'checks green'
            : 'checks need fixes',
    ].filter(Boolean)

    return (
      <Box key={`mission:${view.row.id}`} flexDirection="column">
        <Button key={`open:${view.row.id}`} plain onPress={() => actions.openDetail('mission', view.row.id)}>
          <Text weight="semibold">{view.row.id}</Text>
        </Button>
        {view.row.title !== '' && (
          <Text dimColor wrap="truncate">
            {view.row.title}
          </Text>
        )}
        {branch !== null && (
          <Text dimColor wrap="truncate">
            {branch}
          </Text>
        )}
        {meta.length > 0 && <Text dimColor>{meta.join(' · ')}</Text>}
      </Box>
    )
  }

  const cardsOf = (name: Column) => {
    const own = byColumn(name)
    const shown = name === 'merged' ? own.slice(0, MERGED_SHOWN) : own

    return (
      <Box flexDirection="column" gap={1}>
        {shown.map(view => card(view, name))}
        {shown.length < own.length && <Text dimColor>{`+${own.length - shown.length} more`}</Text>}
        {own.length === 0 && <Text dimColor>—</Text>}
      </Box>
    )
  }

  const excerpts = views
    .filter(view => isSpoken(view) && view.row.sections.length > 0)
    .flatMap(view =>
      view.row.sections.slice(0, 2).map(number => ({ view, number, section: missions.sections[number] })),
    )
    .filter(one => one.section !== undefined)
    .slice(0, 3)

  const body = isWide ? (
    <Box flexDirection="row" gap={2}>
      {COLUMNS.filter(column => column.name !== 'other').map(column => (
        <Box key={`column:${column.name}`} flexDirection="column" flexGrow={1} flexBasis={0}>
          <Text weight="semibold">{`${column.label} (${byColumn(column.name).length})`}</Text>
          {cardsOf(column.name)}
        </Box>
      ))}
    </Box>
  ) : (
    <Box flexDirection="column">
      {COLUMNS.filter(column => column.name !== 'other').map(column => {
        const count = byColumn(column.name).length
        const isOpen =
          OPEN_BY_DEFAULT.includes(column.name) && count > 0
            ? !flipped(`missions:${column.name}`)
            : flipped(`missions:${column.name}`)

        return (
          <Box key={`column:${column.name}`} flexDirection="column">
            <Button key={`fold:${column.name}`} plain onPress={() => actions.toggle(`missions:${column.name}`)}>
              <Text weight="semibold">{`${isOpen ? '▾' : '▸'} ${column.label} · ${count}`}</Text>
            </Button>
            {isOpen && cardsOf(column.name)}
          </Box>
        )
      })}
    </Box>
  )

  const others = byColumn('other')

  return (
    <Box flexDirection="column" gap={1}>
      <Text weight="semibold">Missions</Text>
      {views.length === 0 && <Text dimColor>No mission table in the state file.</Text>}
      {views.length > 0 && body}
      {others.length > 0 && (
        <Box flexDirection="column">
          <Button key="fold:other" plain onPress={() => actions.toggle('missions:other')}>
            <Text dimColor>{`${flipped('missions:other') ? '▾' : '▸'} Other · ${others.length}`}</Text>
          </Button>
          {flipped('missions:other') && cardsOf('other')}
        </Box>
      )}
      {loose.length > 0 && (
        <Text dimColor>{`${loose.length} ${loose.length === 1 ? 'run' : 'runs'} not attributed to a mission`}</Text>
      )}
      {excerpts.length > 0 && (
        <Box flexDirection="column">
          <Text weight="semibold">Mission notes</Text>
          {excerpts.map(({ view, number, section }) => (
            <Box key={`excerpt:${view.row.id}:${number}`} flexDirection="column">
              <Text wrap="truncate">{`${view.row.id} · § ${number} ${section?.title ?? ''}`}</Text>
              <Text dimColor wrap="truncate">
                {firstParagraph(section?.raw ?? '')}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

const firstParagraph = (raw: string) => {
  const lines = raw.split(/\r?\n/)
  const first = lines.findIndex(line => line.trim() !== '' && !/^#/.test(line))
  if (first < 0) {
    return ''
  }
  const end = lines.slice(first).findIndex(line => line.trim() === '')
  const text = lines
    .slice(first, end < 0 ? undefined : first + end)
    .join(' ')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

// The detail of one mission: where it stands, its sources, its notes by type,
// the runs linked to it. No button here changes anything (rule E-5).
export const renderMissionDetail = (context: BoardContext) => {
  const { Box, Button, Link, Text } = context.ui
  const { board, actions } = context
  const id = board.view.detail?.id
  const missions = board.light?.missions
  const { views } = viewsOf(board)
  const view = views.find(one => one.row.id === id)
  if (id === undefined || missions === undefined || view === undefined) {
    return <Text dimColor>{`Mission ${id ?? ''} is not in the state file.`}</Text>
  }
  const project = board.light?.project ?? ''
  const files = filesOf(missions, id)
  const isRaw = board.view.toggled.includes(`mission:raw:${id}`)
  const items: NotesItem[] = [
    ...files.flatMap(name => missions.notes[name].items),
    ...view.row.sections.flatMap(number => missions.sections[number]?.items ?? []),
  ]
  const counts = NOTE_TYPES.map(type => ({
    type,
    items: items.filter(item => item.type === type),
  })).filter(one => one.items.length > 0)
  const status = board.heavy?.status?.value
  const first = (kind: string) =>
    view.runs.filter(run => kindOf(run.type) === kind).sort((one, other) => one.started - other.started)[0]
  const steps: [string, number | null | undefined][] = [
    ['Design', first('rick')?.started],
    ['Build', first('morty')?.started],
    ['Review', first('council')?.started],
    ['Merged', view.mergedAt],
  ]
  const raw = [
    ...files.map(name => ({ name, text: missions.notes[name].raw })),
    ...view.row.sections.map(number => ({
      name: `NOTES.local.md § ${number}`,
      text: missions.sections[number]?.raw ?? '',
    })),
  ]

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text weight="semibold">{view.row.id}</Text>
        {view.row.title !== '' && <Text wrap="wrap">{view.row.title}</Text>}
        <Text dimColor>
          {[label(view.column), view.row.branch].filter(Boolean).join(' · ')}
        </Text>
      </Box>
      <Text dimColor>{steps.map(([name, at]) => `${name} ${stamp(at)}`).join(' · ')}</Text>

      <Box flexDirection="column">
        <Text weight="semibold">Sources</Text>
        <Text dimColor>State line</Text>
        {files.map(name => (
          <Link key={`source:${name}`} href={fileHref(project, `notes/${name}`)}>{`notes/${name}`}</Link>
        ))}
        {view.row.sections.map(number => (
          <Link key={`source:§${number}`} href={fileHref(project, 'NOTES.local.md')}>
            {`NOTES.local.md § ${number}`}
          </Link>
        ))}
      </Box>

      <Box flexDirection="column">
        <Box gap={1}>
          <Text weight="semibold">Notes</Text>
          <Button
            key="mission:structured"
            label="Structured"
            onPress={() => isRaw && actions.toggle(`mission:raw:${id}`)}
          />
          <Button
            key="mission:raw"
            label="Raw"
            onPress={() => !isRaw && actions.toggle(`mission:raw:${id}`)}
          />
        </Box>
        {!isRaw && counts.length === 0 && <Text dimColor>No notes for this mission.</Text>}
        {!isRaw &&
          counts.map(({ type, items: own }) => {
            const key = `mission:${id}:${type}`
            const isOpen = !board.view.toggled.includes(key)

            return (
              <Box key={key} flexDirection="column">
                <Button key={`fold:${key}`} plain onPress={() => actions.toggle(key)}>
                  <Text weight="semibold">{`${isOpen ? '▾' : '▸'} ${TYPE_LABELS[type]} · ${own.length}`}</Text>
                </Button>
                {isOpen &&
                  own.map((item, index) => (
                    <Box key={`${key}:${index}`} flexDirection="column">
                      <Text>{item.title}</Text>
                      {item.text !== '' && <Text dimColor>{item.text}</Text>}
                    </Box>
                  ))}
              </Box>
            )
          })}
        {isRaw &&
          raw.map(file => (
            <Box key={`raw:${file.name}`} flexDirection="column">
              <Text dimColor>{file.name}</Text>
              {file.text
                .split(/\r?\n/)
                .slice(0, RAW_LINES)
                .map((line, index) => (
                  <Text key={`raw:${file.name}:${index}`}>{line === '' ? ' ' : line}</Text>
                ))}
            </Box>
          ))}
      </Box>

      <Box flexDirection="column">
        <Text weight="semibold">{`Runs (${view.runs.length + view.running.length})`}</Text>
        {status === undefined && <Text dimColor>Loading…</Text>}
        {view.running.map(agent => (
          <Text key={`run:live:${agent.id}`} wrap="truncate">
            <Text color="warning">●</Text> {agent.type}{' '}
            <Text dimColor>{`running · ${agent.description}`}</Text>
          </Text>
        ))}
        {view.runs.map(run => (
          <Text key={`run:${run.agentId}`} wrap="truncate">
            {run.type}{' '}
            <Text dimColor>
              {`${run.model} · ${minutes(run.ended - run.started)} · $${run.cost.toFixed(2)}`}
            </Text>
          </Text>
        ))}
        {status !== undefined && view.runs.length + view.running.length === 0 && (
          <Text dimColor>No run linked.</Text>
        )}
      </Box>
    </Box>
  )
}
