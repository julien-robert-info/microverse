# Changelog

## Unreleased

- The unit of work is now called a mission (it was "chantier") in the skills,
  agents, hooks and scripts. Projects already set up rename the term in their
  state file (section titles, the `# Compact instructions` section) and in
  their notes index.
- The orchestration skill sorts its messages into trace lines (one line per
  event, detail in the notes, safe to skip) and messages for the user (report
  and questions) opened with `▶`. Each question is numbered and carries its
  context, the options and their effect, the recommendation and what waits on
  it, so it can be answered without reading the conversation; `rick` writes
  its open questions the same way.
- `rick` now designs chantiers instead of reviewing diffs: it measures on real
  data, settles the rules and writes them with a draft brief, the risky zones
  and the questions for the user in `notes/<chantier>.md`, the only file it
  writes. It runs in the background beside the `morty` agents. The diff
  review moves to the new `council` agent (Opus, read-only), which opens its
  report with a verdict. The orchestration skill no longer sends open
  investigations to a `general-purpose` Opus agent nor suggests opening the
  conversation on Opus for design.
- `orch-quota` allows agents side by side: up to 2 on the normal advice, 3 on
  speed up, bounded by the room left under the 5h limit. An agent is a
  `morty` or a `rick`; the advice moved to `paceAdvice` in `orch-lib.js`.
- `orch-quota --running <n> [--agent-cost 15]` launches no agent when the room
  left under `five_hour_limit`, minus the share of the running agents, is
  under what one agent uses (about 15 points of the 5h counter: a `morty` with
  its review, or a `rick`). It replaces the rule that only looked at the 5h
  counter being under 60 %; a series that started two missions at 80 % hit
  the limit.
- The orchestration skill passes the `quota_file` option in single quotes: an
  unset option stays literal and made the command fail in bash.
- Briefs number their rules (R1…) and expected tests (T1…); the `morty`
  checks its diff against them before reporting, with a line per rule and
  test in its report; the orchestrator checks that table before calling
  `council` and passes it along. After a review, the fixes go back to the
  `morty` and are checked on the fix commits; `council` is relaunched only on
  what touches the risky zones again, on that range.
- `agent-check` refuses a second run on a worktree while the first is alive
  (lock file in the worktree's git dir, taken over when its process is gone):
  two `--merged` runs undid each other's merge and collided on the build
  tools' output lock.
- The series report aims at 15 to 20 lines through its wording, without
  dropping items: business decisions in full under "to confirm", technical
  choices and minor open points counted with their notes section, a new
  "incidents" section, the `council` verdict per merge, deployment steps once
  the user agrees to deploy, quota, agent cost and context on one line, with an
  example. Between reports, one line per event, under 150 characters.

- The orchestration skill lists what the orchestrator reads itself (state
  file, notes section, diff under review, code for a brief) and sends the rest
  to a `meeseeks`: database queries, logs, remote commands, searches through
  notes or large files, one `meeseeks` per measurement during design. A project
  skill holding the query recipe is named in the question; `meeseeks` follows
  it.

- The orchestrating conversation runs on Sonnet with Opus as advisor, so no
  model is chosen when opening it: `/microverse:init` offers to write
  `"model": "sonnet"` and `"advisorModel": "opus"` in
  `.claude/settings.local.json`, and the skill says when to consult the advisor.
  `lastContext` (hence `context-guard` and `orch-usage --context`) counts the
  last executor step of a request that called the advisor, not the sum of its
  steps. `orch-usage` lists advisor calls as `<model> (advisor)` rows priced at
  that model's rates, adds them to the cost of an agent run in `--agents`, and
  prices Haiku 5.5 steps one by one for the size tier; `orch-report` prints an
  `Advisor: N calls, X $` line. `meeseeks` never calls the advisor; `morty` only
  when a failure repeats.

- The orchestrating conversation is no longer switched around 150K tokens:
  Claude Code compacts it at the new `compact_window` setting (default 150000),
  which `/microverse:init` offers to write as `autoCompactWindow` in
  `.claude/settings.local.json`, along with a `# Compact instructions` section
  in `CLAUDE.local.md`. `context-guard` now warns once when the context nears
  the window (update the state file), re-armed after a compaction, and once when
  it is past the window (`autoCompactWindow` probably unset). New `SessionStart`
  hook (`scripts/after-compact.js`, matcher `compact`): lists the agent
  worktrees and whether they are merged. The skill's "Switching conversation"
  section became "Compaction".
- `morty` fast-forwards its worktree to `main` before working: with a remote,
  the worktree starts from `origin/HEAD`, not the local `HEAD`.
- New `UserPromptSubmit` hook (`scripts/context-guard.js`), active in projects
  with an orchestration profile: warns once per 50K step above 150K tokens of
  context, and once per session when `CLAUDE.local.md` exceeds 60 lines. The
  context computation moved to `orch-lib.js` (`lastContext`), shared with
  `orch-usage --context`.
- The orchestration skill describes `notes/<chantier>.md` with an index in
  `NOTES.local.md`; the brief asks for a test that fails before a bug fix.
- `agent-check` reports whether the branch merges cleanly into the base and how
  many commits the base gained; `--merged` runs the checks on the merge result.
- `agent-check`: an added line starting with `++` is no longer taken for a file
  header by the pattern scan.
- Script `orch-report --since <commit>`: the mechanical parts of the series
  report (merges, agent runs and cost, quota, context size) in Markdown.

## 0.1.0

- Skills `orchestration` and `init`.
- Agents `morty` (implements a brief, Sonnet), `meeseeks` (answers one question,
  Haiku, read-only) and `rick` (reviews a risky diff, Opus, read-only).
- Scripts `orch-quota`, `orch-usage` (`--context`, `--agents`), `agent-check`
  (with the profile's `teardown`) and `agent-cleanup`.
- `SubagentStop` hook stopping the servers a finished agent left running, on
  Windows, macOS and Linux.
- Writing rules in `user/CLAUDE.md`.
