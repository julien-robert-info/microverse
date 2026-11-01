// Types of the `board` module (hooks/board). Every `$.state` key the board uses
// is declared here: `plugin validate --strict` refuses a key that is not
// declared.

// A value read by a sensor and the time it was read. A sensor that fails keeps
// its previous value with the old `at`, so the pane can say how stale it is.
export type Sensed<T> = { value: T; at: number }

export type LightWorktree = {
  branch: string
  path: string
  head: string
  // The first entry of `git worktree list` is the repository's own checkout.
  isMain: boolean
}

export type LightAgent = {
  id: string
  type: string
  description: string
  status: string
  // When the board first saw the agent running: the roster has no start time.
  firstSeenAt: number
}

export type LightRateLimit = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type LightUsage = {
  rateLimits: LightRateLimit[]
  contextPercent?: number
}

export type LightState = {
  exists: boolean
  // `Q<n>` of the state file's Questions section still waiting (rule D-2).
  pending: string[]
  isAudioOn: boolean
}

// Missions (hooks/board/notes.ts, missions.tsx).
export type NoteType =
  | 'decided'
  | 'measures'
  | 'risks'
  | 'open'
  | 'verified'
  | 'brief'
  | 'other'

// One sub-section of a notes file: its title and its first paragraph.
export type NotesItem = { title: string; type: NoteType; text: string }

// A parsed notes file, kept with the stamp (`mtimeMs:size`) it was read at.
export type NotesFile = {
  stamp: string
  raw: string
  items: NotesItem[]
}

// One line of the state file's mission table.
export type MissionRow = {
  id: string
  // `E1-E29` or `E3, E4`: shown, never a link target.
  isRange: boolean
  branch: string | null
  title: string
  hashes: string[]
  // `NOTES.local.md` sections the line cites, as numbers.
  sections: string[]
}

export type MissionsLight = {
  // `mtimeMs:size` of the state file the rows come from.
  stateStamp: string | null
  rows: MissionRow[]
  // By file name under `notes/` (`E7.md`, `E7.review-1.md`).
  notes: Record<string, NotesFile>
  // By section number of `NOTES.local.md`.
  sections: Record<string, NotesFile & { title: string }>
  notesStamp: string | null
  // By agent id: the branch of the brief the store holds, when it holds one.
  briefs: Record<string, string>
}

// What `git` says about the hashes the table cites.
export type MissionsHeavy = {
  hashes: Record<string, { ancestor: boolean; at: number | null }>
  briefs: Record<string, string>
}

// Light reading: no node process, no model token. One per project root.
export type Light = {
  // Absolute path of the repository's root.
  project: string
  // What `$.session.root()` gave: the key of the reading. It differs from
  // `project` in spelling on Windows (`D:\` against `D:/`), and in place when
  // the session runs in a subfolder or a worktree.
  root: string
  at: number
  worktrees: Sensed<LightWorktree[]> | null
  agents: Sensed<LightAgent[]> | null
  usage: Sensed<LightUsage> | null
  state: Sensed<LightState> | null
  missions?: MissionsLight
  failures: string[]
}

export type ErrorJson = { error: string }

export type QuotaCounter = {
  used: number
  resetsAt: number
  observedAt: number
  source: string
} | null

export type QuotaJson = {
  counters: { five: QuotaCounter; week: QuotaCounter }
  limits: { target: number; reserve: number; fiveHour: number }
  period: { name: string; start: number; end: number; target: number } | null
  pace: { expected: number; actual: number; delta: number; left: number } | null
  running: { total: number; others: number }
  agentCost: { points: number; runs: number | null }
  advice: { level: string; text: string; more: number }
  warnings: string[]
  history: { at: number; used: number }[]
}

export type ContextJson = {
  session: string
  model: string
  tokens: number
  threshold: number
  percent: number
  verdict: string
}

export type TokenCounts = {
  input: number
  write5m: number
  write1h: number
  read: number
  output: number
}

export type AgentRun = {
  agentId: string
  type: string
  model: string
  description: string
  started: number
  ended: number
  requests: number
  tokens: TokenCounts
  cost: number
  advisor: { calls: number; cost: number }
  finished: boolean
}

export type AgentsJson = {
  since: number
  runs: AgentRun[]
  total: { cost: number; advisor: { calls: number; cost: number } }
}

export type StateSection = { title: string; kind: string; lines: string[] }

export type StatusWorktree = {
  branch: string
  path: string
  rel: string
  merged: boolean
  last: string | null
  dirty: boolean
}

// `orch-status --json`, version 1 (rule B6).
export type OrchStatus = {
  v: 1
  project: string
  base: { name: string; tip: string }
  lastReport: { sha: string; line: string } | null
  state: { exists: boolean; sections: StateSection[] }
  worktrees: StatusWorktree[]
  free: { branch: string; sha: string; subject: string }[]
  report: {
    since: { sha: string; at: number }
    base: string
    merged: { sha: string; subject: string; at: number }[]
    agents: AgentsJson | ErrorJson
    quota: QuotaJson | ErrorJson
    context: ContextJson | ErrorJson
  } | null
  agents: AgentsJson | null
  quota: QuotaJson | ErrorJson
  context: ContextJson | ErrorJson
}

// Heavy reading: the last good `orch-status --json` and, apart, the line of
// the run that failed since (one line, replaced by the next run).
export type Heavy = {
  project: string
  status: Sensed<OrchStatus> | null
  failure: string | null
  missions?: MissionsHeavy
}

export type DetailKind = 'mission' | 'question' | 'agent'

export type View = {
  tab: 'cockpit' | 'usage'
  detail: { kind: DetailKind; id: string } | null
  // Keys of the folds flipped from their default.
  toggled: string[]
}

// One check of `agent-check --json` (schema B4).
export type CheckItem = {
  name: string
  state: 'ok' | 'fail' | 'skip'
  detail: string
  lines: string[]
}

// agent-check result of a branch, by branch name. `running` has no checks yet.
export type CheckResult = {
  at: number
  // `error`: nothing could be checked (E33g); `error` below says why.
  state: 'running' | 'done' | 'error'
  verdict?: 'green' | 'needs-fixes'
  checks: CheckItem[]
  error?: string
  // A click that found the check already running.
  note?: string
}

// Last quota reading sent to the status line recorder.
export type QuotaSent = {
  at: number
  five: { used: number; resetsAt: number } | null
  week: { used: number; resetsAt: number } | null
}

// The answer in progress (an option marked, not yet sent), and the questions
// whose answer was already sent.
export type AnswerState = {
  pending: { question: string; option: string } | null
  sent: string[]
}

// Per agent id: what the board saw the agent do.
export type Activity = {
  lastTool: string
  calls: number
  step: string
  startedAt: number
  updatedAt: number
  // E33g: the one-line summary of the last tool call, and the last calls.
  lastSummary?: string
  tools?: AgentTool[]
  // The roster call was refused: not the same as "not read yet" (no entry).
  unavailable?: boolean
  // Commits ahead of the base, null when it could not be counted.
  ahead?: number | null
  // Read when the detail opens.
  brief?: BriefRecord | null
  branch?: AgentBranch
}

// What the brief store holds under `brief:<agentId>`.
export type BriefRecord = {
  at: number
  type: string
  model: string
  description: string
  branch: string | null
  mission: string | null
  text: string
}

export type AgentTool = { tool: string; summary: string; state: 'ok' | 'error' | 'running' }

// `added` and `removed` are null for a binary file, which git counts as `-`.
export type AgentFile = { path: string; added: number | null; removed: number | null }

// The branch of an agent, null where git could not answer.
export type AgentBranch = {
  at: number
  files: AgentFile[] | null
  // Files changed in all, beyond the eight listed.
  total: number | null
  // Files not committed.
  dirty: number | null
}

export type BoardData = {
  light: Light | null
  heavy: Heavy | null
  view: View
  // By branch.
  checks: Record<string, CheckResult>
  answer: AnswerState
  // By agent id.
  activity: Record<string, Activity>
}

// The components `$.ui.resolve(e)` hands a render. Written out because the file
// named by plugin.json `types` may not import anything.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UiComponent = (props: any) => any

export type BoardUi = {
  Box: UiComponent
  Text: UiComponent
  Button: UiComponent
  [component: string]: UiComponent
}

export type BoardActions = {
  refresh: () => unknown
  setTab: (tab: View['tab']) => unknown
  closeDetail: () => unknown
  openDetail: (kind: DetailKind, id: string) => unknown
  // Flips a fold from its default: adds the key to `view.toggled`, or removes it.
  toggle: (key: string) => unknown
  // E33g: opens an agent's detail and reads its brief and branch; runs
  // agent-check on a branch.
  openAgent: (id: string) => unknown
  runCheck: (branch: string) => unknown
}

// What every section renderer of the Cockpit receives.
export type BoardContext = {
  ui: BoardUi
  board: BoardData
  // `e.props.bodyColumns`: the width the pane body has.
  columns: number
  actions: BoardActions
}

declare module 'claude-code' {
  interface PluginState {
    microverse: {
      light: Shaped<Light | null>
      heavy: Shaped<Heavy | null>
      view: Shaped<View>
      checks: Shaped<Record<string, CheckResult>>
      quotaSent: Shaped<QuotaSent | null>
      answer: Shaped<AnswerState>
      activity: Shaped<Record<string, Activity>>
    }
  }
}
