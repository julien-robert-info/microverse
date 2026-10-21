# Security policy

## Reporting a vulnerability

Open a private vulnerability report on the GitHub repository (Security tab,
"Report a vulnerability"). Please do not file a public issue for a
vulnerability.

## Details

Edge cases of the [trust model](README.md#trust-model).

- Line-end conversion (CRLF) does not change the fingerprint of the profile;
  any other edit to the file, including one brought by a merged branch, revokes
  the approval.
- A profile is `invalid` when its JSON is unreadable or a value has the wrong
  type: `setup`, `teardown`, `servers` and `paths` are arrays of strings, each
  `checks` entry is an object with a string `run`, and each `diffPatterns` entry
  is an object with a string `pattern`. An invalid
  profile cannot be approved, every script refuses it and `orch-trust` says why.
- When the main worktree of the repository cannot be found (a worktree outside
  the main tree of a repository with a separate git dir, or a bare repository),
  the state is `unapproved` with nothing to approve: start from the main
  worktree.
- A branch whose diff touches `.claude/orchestration/` fails `agent-check`.
- Without approval, `agent-check` exits 2 without running anything, `morty`
  stops, and the SessionStart hook does not tell the model to load the
  orchestration skill. With an approved profile, that hook asks the model to
  load the skill and follow `CLAUDE.local.md`, so approving a profile entrusts
  the session to that repository.
- `checks` execute the agent's branch code (tests, scripts) with the rights of
  the session that launches them.
- Never give a script text taken from a repository through cmd.exe or
  PowerShell: they expand `& | % "` of an argument before Node starts (see
  Usage in the README).
