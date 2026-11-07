import type {
  AgentRun,
  BoardContext,
  BoardData,
  MissionRow,
  NoteType,
  NotesItem,
} from '../../types/board'
import {
  Action,
  Avatar,
  Card,
  FoldHeader,
  Legend,
  Pill,
  Segmented,
  Steps,
  Tile,
  roleProps,
  type Part,
} from './kit'
import { linkAgent } from './link'
import { NOTE_TYPES, filesOf } from './notes'
import { AGENT_HUE, COLUMN_HUE, PALETTE, SPACE, TONE, textColor } from './tokens'

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
const REPORT_SHOWN = 5
// Pane width from which the six columns sit side by side: 6 x 14 cells and the
// 5 gaps between them. Below it the columns fold.
export const KANBAN_AT = 89
export const HUE_OF: Record<Column, string> = {
  design: COLUMN_HUE.design,
  brief: COLUMN_HUE.brief,
  building: COLUMN_HUE.building,
  review: COLUMN_HUE.review,
  merge: COLUMN_HUE.ready,
  merged: COLUMN_HUE.merged,
  other: TONE.muted,
}
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

export const label = (name: Column) => COLUMNS.find(column => column.name === name)?.label ?? name

const stamp = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`

const fileHref = (project: string, relative: string) =>
  `file:///${project.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')}/${relative}`

export const kindOf = (type: string) =>
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

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The H1 of `notes/<id>.md` without its `# <id> — ` lead, or null when the file
// is absent, has no H1, or the H1 does not start with the id.
export const titleOf = (id: string, raw: string | undefined): string | null => {
  const heading = raw?.split(/\r?\n/).find(line => /^#\s/.test(line))
  if (heading === undefined) {
    return null
  }
  const lead = new RegExp(`^#\\s*${escaped(id)}\\s*[—–:-]\\s*`)
  if (!lead.test(heading)) {
    return null
  }
  const title = heading.replace(lead, '').trim()

  return title === '' ? null : title
}

export const renderMissions = (context: BoardContext) => {
  const { ui } = context
  const { Box, Button, Text } = ui
  const { board, columns, actions } = context
  const missions = board.light?.missions
  if (missions === undefined) {
    return null
  }
  const { views, loose } = viewsOf(board)
  const isKanban = columns >= KANBAN_AT
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
    const agent = view.running[0]
    const kind = agent === undefined ? undefined : kindOf(agent.type)
    const pills: { label: string; hue: string }[] = []
    if (agent !== undefined) {
      pills.push({
        label: `${agent.type.split(':').pop()} ${minutes((board.light?.at ?? 0) - agent.firstSeenAt)}`,
        hue: AGENT_HUE[kind ?? ''] ?? TONE.muted,
      })
    }
    if (name === 'merged' && view.mergedAt !== null) {
      pills.push({ label: stamp(view.mergedAt).slice(0, 10), hue: TONE.muted })
    }
    if (check !== undefined) {
      pills.push(
        check.state === 'running'
          ? { label: 'checking…', hue: TONE.warning }
          : check.verdict === 'green'
            ? { label: 'checks green', hue: TONE.success }
            : { label: 'checks need fixes', hue: TONE.error },
      )
    }
    // The title is the notes file's H1; the state cell stands in when there is
    // none, except in Merged where it is a long "merged and pushed on…" sentence.
    const title =
      titleOf(view.row.id, missions.notes[`${view.row.id}.md`]?.raw) ?? (name === 'merged' ? '' : view.row.title)

    return (
      <Box key={`mission:${view.row.id}`} flexDirection="column" minWidth={0}>
        {Card(ui, {
          hue: name === 'merged' ? PALETTE.mergedBar : HUE_OF[name],
          children: (
            <Box flexDirection="column" minWidth={0}>
              <Button key={`open:${view.row.id}`} plain onPress={() => actions.openDetail('mission', view.row.id)}>
                <Text mono weight="semibold">
                  {view.row.id}
                </Text>
              </Button>
              {title !== '' && <Text wrap="truncate">{title}</Text>}
              {branch !== null && (
                <Text dimColor wrap="truncate">
                  {branch}
                </Text>
              )}
              {pills.length > 0 && (
                <Box flexDirection="row" flexWrap="wrap" gap={1} minWidth={0}>
                  {pills.map((pill, index) => (
                    <Box key={`pill:${index}`} flexShrink={1} minWidth={0}>
                      {Pill(ui, pill)}
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          ),
        })}
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
  // One fold per mission, holding the sections picked above.
  const notes = [...new Set(excerpts.map(one => one.view))].map(view => ({
    view,
    excerpts: excerpts.filter(one => one.view === view),
  }))

  const shownColumns = COLUMNS.filter(column => column.name !== 'other')
  const parts: Part[] = shownColumns.map(column => ({
    label: `${column.label} ${byColumn(column.name).length}`,
    value: byColumn(column.name).length,
    hue: HUE_OF[column.name],
  }))

  // Every column header is one level of sibling `Text`: dot, label, dimmed count.
  const body = isKanban ? (
    <Box flexDirection="row" gap={1} minWidth={0}>
      {shownColumns.map(column => (
        <Box
          key={`column:${column.name}`}
          flexDirection="column"
          width={0}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
        >
          <Box flexDirection="row" gap={1} minWidth={0}>
            <Text color={textColor(HUE_OF[column.name])} wrap="truncate">
              ●
            </Text>
            <Text weight="semibold" wrap="truncate">
              {column.label}
            </Text>
            <Text dimColor wrap="truncate">{`(${byColumn(column.name).length})`}</Text>
          </Box>
          {cardsOf(column.name)}
        </Box>
      ))}
    </Box>
  ) : (
    <Box flexDirection="column" gap={1} minWidth={0}>
      {Legend(ui, { parts })}
      <Box flexDirection="column" minWidth={0}>
        {shownColumns.map((column, index) => {
          const count = byColumn(column.name).length
          const isOpenAt = (name: Column, size: number) =>
            OPEN_BY_DEFAULT.includes(name) && size > 0 ? !flipped(`missions:${name}`) : flipped(`missions:${name}`)
          const isOpen = isOpenAt(column.name, count)
          const before = shownColumns[index - 1]
          // A blank row keeps an open group's last card off the next header.
          const follows = before !== undefined && isOpenAt(before.name, byColumn(before.name).length)

          return (
            <Box
              key={`column:${column.name}`}
              flexDirection="column"
              minWidth={0}
              paddingTop={follows ? SPACE.section : 0}
            >
              {FoldHeader(ui, {
                keyName: `fold:${column.name}`,
                open: isOpen,
                label: column.label,
                count,
                hue: HUE_OF[column.name],
                onPress: () => actions.toggle(`missions:${column.name}`),
              })}
              {isOpen && cardsOf(column.name)}
            </Box>
          )
        })}
      </Box>
    </Box>
  )

  const others = byColumn('other')

  // The latest merges since the last report, newest first.
  const report = board.heavy?.status?.value?.report
  const merges = [...(report?.merged ?? [])].reverse()

  return (
    <Box flexDirection="column" gap={1} minWidth={0}>
      <Box flexDirection="row" gap={1} minWidth={0}>
        <Text weight="semibold">Missions</Text>
        <Text dimColor>{`· ${views.length}`}</Text>
      </Box>
      {views.length === 0 && <Text dimColor>No mission table in the state file.</Text>}
      {views.length > 0 && body}
      {others.length > 0 && (
        <Box flexDirection="column" minWidth={0}>
          {FoldHeader(ui, {
            keyName: 'fold:other',
            open: flipped('missions:other'),
            label: 'Other',
            count: others.length,
            hue: HUE_OF.other,
            onPress: () => actions.toggle('missions:other'),
          })}
          {flipped('missions:other') && cardsOf('other')}
        </Box>
      )}
      {loose.length > 0 && (
        <Text dimColor>{`${loose.length} ${loose.length === 1 ? 'run' : 'runs'} not attributed to a mission`}</Text>
      )}
      {report !== undefined && report !== null && (
        <Box flexDirection="column" minWidth={0}>
          <Box flexDirection="row" gap={1} minWidth={0}>
            <Text weight="semibold">Since the last report</Text>
            <Text dimColor>{`· ${merges.length} ${merges.length === 1 ? 'merge' : 'merges'}`}</Text>
          </Box>
          {merges.length === 0 && <Text dimColor>Nothing merged yet.</Text>}
          {merges.slice(0, REPORT_SHOWN).map(merge => (
            <Box key={`merge:${merge.sha}`} flexDirection="row" gap={1} minWidth={0}>
              <Text mono weight="semibold" wrap="truncate">
                {merge.sha}
              </Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text wrap="truncate">{merge.subject}</Text>
              </Box>
              <Text dimColor wrap="truncate">
                {stamp(merge.at).slice(0, 10)}
              </Text>
            </Box>
          ))}
          {merges.length > REPORT_SHOWN && <Text dimColor>{`+${merges.length - REPORT_SHOWN} more`}</Text>}
        </Box>
      )}
      {notes.length > 0 && (
        <Box flexDirection="column" minWidth={0}>
          <Text weight="semibold">Mission notes</Text>
          {notes.map(({ view, excerpts }) => {
            const key = `notes:${view.row.id}`
            const isOpen = flipped(key)

            return (
              <Box key={`notes:${view.row.id}`} flexDirection="column" minWidth={0}>
                <Box flexDirection="row" gap={1} minWidth={0}>
                  {FoldHeader(ui, {
                    keyName: `fold:${key}`,
                    open: isOpen,
                    label: view.row.id,
                    mono: true,
                    onPress: () => actions.toggle(key),
                  })}
                  {Pill(ui, { label: label(view.column), hue: HUE_OF[view.column] })}
                  {!isOpen && (
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text dimColor wrap="truncate">
                        {firstParagraph(excerpts[0].section?.raw ?? '')}
                      </Text>
                    </Box>
                  )}
                </Box>
                {isOpen &&
                  excerpts.map(({ number, section }) => (
                    <Box key={`excerpt:${view.row.id}:${number}`} flexDirection="column" minWidth={0}>
                      <Text wrap="truncate">{`${view.row.id} · § ${number} ${section?.title ?? ''}`}</Text>
                      <Text dimColor wrap="truncate">
                        {firstParagraph(section?.raw ?? '')}
                      </Text>
                    </Box>
                  ))}
              </Box>
            )
          })}
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

// Hue of the left bar of each type of notes.
const TYPE_HUE: Record<NoteType, string> = {
  decided: PALETTE.blue,
  open: PALETTE.yellow,
  measures: PALETTE.teal,
  risks: PALETTE.red,
  verified: PALETTE.green,
  brief: PALETTE.violet,
  other: PALETTE.text2,
}

// Steps of a mission, as the columns they follow. The mission's column says
// which one is in progress; `merge` is "Ready".
const STEPS = ['Design', 'Brief', 'Build', 'Review', 'Ready', 'Merged']
const STEP_AT: Record<Column, number> = {
  design: 0,
  brief: 1,
  building: 2,
  review: 3,
  merge: 4,
  merged: STEPS.length,
  other: -1,
}

type Tab = 'overview' | 'runs' | 'review'
const TABS: Tab[] = ['overview', 'runs', 'review']

const tabKey = (tab: string, id: string) => `mission:tab:${tab}:${id}`

// `microverse:rick` gives `rick`.
const shortType = (type: string) => type.replace(/^.*:/, '')

const avatarOf = (ui: BoardContext['ui'], type: string) => {
  const kind = kindOf(type)

  return Avatar(ui, {
    letter: (kind?.[0] ?? '?').toUpperCase(),
    hue: kind === null ? PALETTE.text2 : AGENT_HUE[kind],
  })
}

// One card per type of notes: a coloured bar, a fold header with the count, the
// items with their title and their text.
const cardsOf = (
  context: BoardContext,
  entries: { type: NoteType; items: NotesItem[] }[],
  scope: string,
) => {
  const { Box, Text } = context.ui
  const { board, actions } = context

  return entries.map(({ type, items: own }) => {
    const key = `mission:${scope}:${type}`
    const isOpen = !board.view.toggled.includes(key)

    return (
      <Box key={key}>
        {Card(context.ui, {
          hue: TYPE_HUE[type],
          children: (
            <Box flexDirection="column" minWidth={0}>
              {FoldHeader(context.ui, {
                keyName: `fold:${key}`,
                open: isOpen,
                label: TYPE_LABELS[type],
                count: own.length,
                onPress: () => actions.toggle(key),
              })}
              {isOpen &&
                own.map((item, index) => (
                  <Box key={`${key}:${index}`} flexDirection="column" minWidth={0}>
                    <Text weight="semibold" wrap="wrap">
                      {item.title}
                    </Text>
                    {item.text !== '' && (
                      <Text dimColor wrap="wrap">
                        {item.text}
                      </Text>
                    )}
                  </Box>
                ))}
            </Box>
          ),
        })}
      </Box>
    )
  })
}

const byType = (items: NotesItem[]) =>
  NOTE_TYPES.map(type => ({ type, items: items.filter(item => item.type === type) })).filter(
    one => one.items.length > 0,
  )

// The detail of one mission: where it stands, its totals, then a tab: the
// overview (sources and notes by type), the runs linked to it, the review notes.
// No button here changes anything (rule E-5).
export const renderMissionDetail = (context: BoardContext) => {
  const { Box, Link, Text } = context.ui
  const { board, actions } = context
  const id = board.view.detail?.id
  const missions = board.light?.missions
  const { views } = viewsOf(board)
  const view = views.find(one => one.row.id === id)
  if (id === undefined || missions === undefined || view === undefined) {
    return (
      <Text dimColor wrap="wrap">
        {`Mission ${id ?? ''} is not in the state file.`}
      </Text>
    )
  }
  const project = board.light?.project ?? ''
  const files = filesOf(missions, id)
  const reviewFiles = files.filter(name => name !== `${id}.md`)
  const mainFiles = files.filter(name => name === `${id}.md`)
  const isRaw = board.view.toggled.includes(`mission:raw:${id}`)
  const sectionItems = view.row.sections.flatMap(number => missions.sections[number]?.items ?? [])
  const counts = byType([...mainFiles.flatMap(name => missions.notes[name].items), ...sectionItems])
  const reviewCounts = byType(reviewFiles.flatMap(name => missions.notes[name].items))
  const status = board.heavy?.status?.value
  const first = (kind: string) =>
    view.runs.filter(run => kindOf(run.type) === kind).sort((one, other) => one.started - other.started)[0]
  const times = [
    first('rick')?.started,
    undefined,
    first('morty')?.started,
    first('council')?.started,
    undefined,
    view.mergedAt,
  ]
  const current = STEP_AT[view.column]
  const steps = STEPS.map((name, index) => ({
    label: name,
    state: index < current ? ('done' as const) : index === current ? ('doing' as const) : ('todo' as const),
    ...(times[index] === null || times[index] === undefined ? {} : { when: stamp(times[index]) }),
  }))
  // A running agent that already has a run record is listed once, by the record.
  const liveOnly = view.running.filter(agent => !view.runs.some(one => one.agentId === agent.id))
  const raw = [
    ...mainFiles.map(name => ({ name, text: missions.notes[name].raw })),
    ...view.row.sections.map(number => ({
      name: `NOTES.local.md § ${number}`,
      text: missions.sections[number]?.raw ?? '',
    })),
  ]
  const title = titleOf(view.row.id, missions.notes[`${view.row.id}.md`]?.raw) ?? view.row.title
  // The tabs are exclusive; a stale key of a tab that is gone falls back to the
  // overview.
  const available = TABS.filter(tab => tab !== 'review' || reviewFiles.length > 0)
  const active =
    available.find(tab => tab !== 'overview' && board.view.toggled.includes(tabKey(tab, id))) ??
    'overview'
  const select = async (next: string) => {
    for (const tab of TABS) {
      if (tab !== 'overview' && tab !== next && board.view.toggled.includes(tabKey(tab, id))) {
        await actions.toggle(tabKey(tab, id))
      }
    }
    if (next !== 'overview' && !board.view.toggled.includes(tabKey(next, id))) {
      await actions.toggle(tabKey(next, id))
    }
  }
  const costs = view.runs.reduce((sum, run) => sum + run.cost, 0)
  const spent = view.runs.reduce((sum, run) => sum + (run.ended - run.started), 0)
  // Totals of runs not read yet are a gap, not zero.
  const known = status !== undefined

  return (
    <Box flexDirection="column" gap={1} minWidth={0}>
      <Box flexDirection="column" minWidth={0}>
        <Box flexDirection="row" gap={1} minWidth={0}>
          <Box flexShrink={0}>
            <Text {...roleProps(context.ui, 'id')} weight="semibold">
              {view.row.id}
            </Text>
          </Box>
          {title !== '' && (
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text {...roleProps(context.ui, 'title')} wrap="wrap">
                {title}
              </Text>
            </Box>
          )}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1} minWidth={0}>
          {Pill(context.ui, { label: label(view.column), hue: HUE_OF[view.column] })}
          {view.row.branch !== null && (
            <Box flexShrink={1} minWidth={0}>
              <Text {...roleProps(context.ui, 'id')} dimColor wrap="wrap">
                {view.row.branch}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
      {Steps(context.ui, { steps })}

      <Box flexDirection="row" flexWrap="wrap" gap={1} minWidth={0}>
        {Tile(context.ui, { label: 'Cost', value: known ? `$${costs.toFixed(2)}` : '—' })}
        {Tile(context.ui, { label: 'Agent time', value: known ? minutes(spent) : '—' })}
        {Tile(context.ui, { label: 'Runs', value: known ? String(view.runs.length) : '—' })}
      </Box>

      {Segmented(context.ui, {
        keyOf: tab => tabKey(tab, id),
        items: available.map(tab => ({
          id: tab,
          label: tab === 'overview' ? 'Overview' : tab === 'runs' ? 'Runs' : 'Review',
        })),
        active,
        onSelect: select,
      })}

      {active === 'overview' && (
        <Box flexDirection="column" gap={1} minWidth={0}>
          <Box flexDirection="row" flexWrap="wrap" gap={1} minWidth={0}>
            <Text dimColor>Sources</Text>
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
          <Box flexDirection="row" gap={1}>
            {Action(context.ui, {
              keyName: 'mission:structured',
              label: 'Structured',
              primary: !isRaw,
              onPress: () => isRaw && actions.toggle(`mission:raw:${id}`),
            })}
            {Action(context.ui, {
              keyName: 'mission:raw',
              label: 'Raw',
              primary: isRaw,
              onPress: () => !isRaw && actions.toggle(`mission:raw:${id}`),
            })}
          </Box>
          {!isRaw && counts.length === 0 && (
            <Text dimColor wrap="wrap">
              No notes for this mission.
            </Text>
          )}
          {!isRaw && cardsOf(context, counts, id)}
          {isRaw &&
            raw.map(file => (
              <Box key={`raw:${file.name}`} flexDirection="column" minWidth={0}>
                <Text dimColor wrap="wrap">
                  {file.name}
                </Text>
                {file.text
                  .split(/\r?\n/)
                  .slice(0, RAW_LINES)
                  .map((line, index) => (
                    <Text key={`raw:${file.name}:${index}`} wrap="wrap">
                      {line === '' ? ' ' : line}
                    </Text>
                  ))}
              </Box>
            ))}
        </Box>
      )}

      {active === 'review' && (
        <Box flexDirection="column" gap={1} minWidth={0}>
          {reviewCounts.length === 0 && (
            <Text dimColor wrap="wrap">
              No structured notes in the review files.
            </Text>
          )}
          {cardsOf(context, reviewCounts, `${id}:review`)}
        </Box>
      )}

      {active === 'runs' && (
        <Box flexDirection="column" gap={1} minWidth={0}>
          {status === undefined && (
            <Text dimColor wrap="wrap">
              Loading…
            </Text>
          )}
          {liveOnly.map(agent => (
            <Box
              key={`run:live:${agent.id}`}
              flexDirection="row"
              gap={1}
              justifyContent="space-between"
              minWidth={0}
            >
              <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
                {avatarOf(context.ui, agent.type)}
                <Box flexDirection="column" flexShrink={1} minWidth={0}>
                  <Text weight="semibold" wrap="wrap">
                    {shortType(agent.type)}
                  </Text>
                  <Text dimColor wrap="wrap">{`running · ${agent.description}`}</Text>
                </Box>
              </Box>
              <Box flexShrink={0}>
                <Text color="warning">●</Text>
              </Box>
            </Box>
          ))}
          {view.runs.map(run => (
            <Box
              key={`run:${run.agentId}`}
              flexDirection="row"
              gap={1}
              justifyContent="space-between"
              minWidth={0}
            >
              <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
                {avatarOf(context.ui, run.type)}
                <Box flexShrink={1} minWidth={0}>
                  <Text wrap="wrap">
                    {`${shortType(run.type)} · ${run.model} · ${minutes(run.ended - run.started)}`}
                  </Text>
                </Box>
              </Box>
              <Box flexShrink={0}>
                <Text>{`$${run.cost.toFixed(2)}`}</Text>
              </Box>
            </Box>
          ))}
          {status !== undefined && view.runs.length + liveOnly.length === 0 && (
            <Text dimColor wrap="wrap">
              No run linked.
            </Text>
          )}
        </Box>
      )}
    </Box>
  )
}
