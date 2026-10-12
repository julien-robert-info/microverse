# Changelog

## Unreleased

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
