---
name: status
description: Overview of the orchestration in the terminal (missions, agent worktrees, questions, merges since the last report, agents, quota, context) without a model request.
disable-model-invocation: true
argument-hint: "[commit of the last report] [--agents] [--verbose]"
allowed-tools: Bash(orch-status *)
---

The hook that prints this overview did not answer. Run `orch-status ARGS --target ${user_config.week_target} --reserve ${user_config.weekday_reserve} --five-hour ${user_config.five_hour_limit} --file FILE` with the Bash tool, where ARGS is the arguments `'$ARGUMENTS'`, except that the words `--agents` (one line per agent run) and `--verbose` (the quota detail) are written as separate options outside the quotes and the rest (a commit) stays between single quotes, and FILE is `'${user_config.quota_file}'` (an unset option stays literal, hence the single quotes); write each apostrophe inside a value as `'\''`. Show its output unchanged in a code block, adding nothing.
