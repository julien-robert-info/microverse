---
name: init
description: Prepare a project for orchestration by agents — examine the stack and write the profile `.claude/orchestration/profile.json` (worktree setup, checks, servers, patterns, shared resources) and `rules.md` (the project's rules and traps), then check `.gitignore`. Use when the user asks to initialize orchestration in a project ("initialise l'orchestration"), or when the `orchestration` skill finds no profile.
---

# A project's orchestration profile

Write reports, questions and summaries in the language the user writes in.

The profile tells agents and scripts how to work in this project. It is
versioned with the project, in `.claude/orchestration/`.

## 1. Examine the project

Read the manifests present (`package.json`, `pyproject.toml`, `Cargo.toml`,
`go.mod`, `pom.xml`, `Makefile`, `docker-compose.yml`…), the lint and test
configuration, the project's `CLAUDE.md`, the skills and agents under
`.claude/`, and a `README`. Derive from them:

- what a fresh worktree must run to be usable (dependency installation, code
  generation);
- a branch's checks: typing, tests, lint, build; and those that only matter if
  certain folders change;
- the servers an agent may start (development server, preview server);
- the resources only one task at a time may touch (database schema, local
  database, shared configuration file);
- the project's own rules and traps.

## 2. Write `profile.json`

```json
{
  "setup": ["npm ci"],
  "checks": [
    { "name": "typecheck", "run": "npm run typecheck" },
    { "name": "tests", "run": "npm test" },
    { "name": "build", "run": "npm run build", "paths": ["src/", "app/"] }
  ],
  "teardown": ["git checkout -- next-env.d.ts"],
  "servers": ["/next/"],
  "diffPatterns": [{ "pattern": "console\\.log\\(", "why": "leftover debug trace" }],
  "shared": ["database schema (migration number reserved in CLAUDE.local.md)"]
}
```

- `setup`: commands the `morty` runs in order in a fresh worktree.
- `checks`: run by `agent-check` in the agent's worktree, and by the agent
  before its report. `paths` (optional): path prefixes; the check runs only if
  the diff touches one of them.
- `teardown`: commands `agent-check` runs after the checks to restore tracked
  files they rewrite (generated code); a worktree left modified cannot be
  removed by `agent-cleanup`.
- `servers`: command-line substrings of a server (`/` or `\` separators are
  interchangeable); the `SubagentStop` hook stops the finished agent's
  processes that contain one. Stay precise: a pattern that is too broad would
  stop tests still running.
- `diffPatterns`: regular expressions (JavaScript) searched by `agent-check` in
  the added lines, with the reason. UTF-8 double encoding is already searched.
- `shared`: free text read by the orchestrator before launching two agents.

## 3. Write `rules.md`

Short, in imperatives, read first by every agent: stack conventions (versions
to check, imposed style, language of code and interface), what an agent must
never do (production, reserved ports, containers), how to verify an interface
or a processing step, the project's skills to follow for a given kind of change.
No generic procedure: it is already in the agents' definitions.

## 4. Have it validated, then write

Show both files to the user, integrate their corrections, then write them.
Also check:

- `.gitignore` contains `CLAUDE.local.md`, `NOTES.local.md`, `notes/` and
  `.claude/worktrees/`; offer to add what is missing;
- offer to merge `"autoCompactWindow"` into `.claude/settings.local.json`
  (create it if missing, keep every existing key), set to
  `${user_config.compact_window}` + 33000 (at most 1000000), so Claude Code
  compacts the orchestrating conversation at `compact_window` tokens: it
  compacts about 33K below this setting (reserved output budget and buffer);
  merge `"model": "sonnet"` and `"advisorModel": "opus"` in the same file: the
  orchestrating conversation runs on Sonnet and consults Opus at decision
  points, so no model has to be chosen when opening a conversation; check that
  file is ignored by git;
- offer the microverse status line, which records the quota counters for
  `orch-quota` in terminal sessions (the VS Code panel runs no status line):
  run `node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js" --install`, which
  copies the script to `~/.claude/microverse/` and prints the `statusLine`
  setting, then look at `statusLine` in `.claude/settings.local.json`:
  - absent, or already the printed command: merge the printed setting (nothing
    to do when it is already there);
  - a command that points into `.claude/microverse/` (an earlier microverse
    script): replace it once the user confirms, and give them the old command;
  - any other command: write nothing; show the printed setting and say that
    their own script can pass its stdin on to that command, or that they can
    replace it by hand;
- offer to append to the state file `CLAUDE.local.md` a `# Compact instructions`
  section of three or four lines, in the user's language: the summary keeps the
  missions in progress with their branches, the agents launched and not yet
  returned, the decisions not yet written to the notes, the questions awaiting
  the user;
- tell the user that once the profile exists, the plugin's `SessionStart` hook
  loads the orchestration skill in every conversation of the project (new,
  resumed, cleared or compacted); nothing to configure;
- offer a `.worktreeinclude` for unversioned files a worktree needs (`.env`…);
- once the user has approved the profile (`orch-trust --status` exits 0), run
  each command printed by `orch-trust --commands checks` once on the current
  branch, to verify it passes before making it a criterion; never run them
  from the unapproved file.
- end by asking the user to approve the profile you wrote: run `orch-trust`
  to show them its fingerprint and commands, then give them, word for
  word, the approval line it prints. Until then the hook, `agent-check` and
  the agents run none of its commands. Never run that line
  (`orch-trust <sha256>`, or its `node` form) yourself, and do not rewrite the profile after they approved it without
  asking again.
