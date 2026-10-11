# Changelog

## Unreleased

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
