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

- `.gitignore` contains `CLAUDE.local.md`, `NOTES.local.md` and
  `.claude/worktrees/`; offer to add what is missing;
- offer a `.worktreeinclude` for unversioned files a worktree needs (`.env`…);
- run each `checks` command once on the current branch, to verify it passes
  before making it a criterion.
