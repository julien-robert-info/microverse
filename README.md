# microverse

Claude Code plugin to run a project as chantiers delegated to background
agents: one task, one branch, one worktree. An orchestrating conversation
designs, writes the brief, launches the agent, reviews its diff, merges and
cleans up; the launch pace follows the usage quota.

## Contents

| Component | Role |
|---|---|
| skill `orchestration` | procedure: roles and models, budget, brief, reception, series report, conversation switch |
| skill `init` | writes a project's orchestration profile |
| agent `meeseeks` (Haiku) | implements a brief in its worktree |
| agent `morty` (Sonnet, read-only) | answers one question with facts and their evidence |
| agent `rick` (Opus, read-only) | reviews a risky diff, returns ranked defects |
| `orch-quota` | reads the quota counters and advises the launch pace |
| `orch-usage` | tokens and API-equivalent cost per model, context size of a session |
| `agent-check <branch>` | commits, clean worktree, profile checks, suspicious patterns in the diff |
| `agent-cleanup <branch>` | removes an agent's worktree and merged branch |
| `SubagentStop` hook | stops servers left running by a finished agent (Windows) |
| `user/CLAUDE.md` | writing rules (README, comments, commits), to import into `~/.claude/CLAUDE.md` |

## Requirements

- Claude Code 2.1.293 or newer (`haiku` model alias for Claude Haiku 5.5).
- Node.js 20 or newer, for the scripts in `bin/`.
- Git.
- Optional: the VS Code extension "Claude Code Usage" (growthjack), whose
  readings `orch-quota` uses. Without it, the orchestrator asks the user for the
  counters.
- The `SubagentStop` hook works on Windows only (PowerShell).

## Installation

The repository is its own plugin catalog.

```bash
claude plugin marketplace add <path to the clone or owner/repo>
claude plugin install microverse@microverse
```

In the VS Code extension without the CLI, use `/plugin` in the chat panel
(Marketplaces, then Discover) for the same two steps.

A catalog added from a local path loads the plugin in place: a change takes
effect in the next conversation or after `/reload-plugins`.

Writing rules, in `~/.claude/CLAUDE.md`:

```markdown
@<path to the clone>/user/CLAUDE.md
```

## Configuration

Plugin settings (`/config`):

| Key | Default | Meaning |
|---|---|---|
| `week_target` | 98 | consumption aimed at the end of the week; beyond it no more resuming, 3 points before no new agent (%) |
| `weekday_reserve` | 30 | points kept for weekdays; the weekend rises to `week_target` minus this value |
| `five_hour_limit` | 90 | beyond it, no new agent until the 5h counter resets; 5 points higher, no more resuming (%) |
| `quota_file` | — | readings file, if the extension is not at its default location |

Per project, the `.claude/orchestration/` profile (versioned), written by
`/microverse:init`:

- `profile.json`: `setup` (commands for a fresh worktree), `checks` (`name`,
  `run`, optional `paths`), `servers` (command-line patterns), `diffPatterns`
  (`pattern`, `why`), `shared` (exclusive resources);
- `rules.md`: the project's rules and traps, read first by the agents.

The project ignores `CLAUDE.local.md`, `NOTES.local.md` and
`.claude/worktrees/`.

## Usage

In a conversation opened at the project root: "démarre <chantier>", "chantier
suivant", "où en est-on ?", "rapport". The `orchestration` skill loads on these
requests; `/microverse:orchestration` forces it.

The scripts can also be run by hand from the repository root:

```bash
orch-quota --target 98 --reserve 30
orch-usage --since 2026-01-01
orch-usage --context
agent-check feat/subject
agent-cleanup feat/subject
```

## Architecture

```
.claude-plugin/   plugin.json (manifest, settings), marketplace.json (catalog)
skills/           orchestration (SKILL.md, budget.md, brief.md, review.md), init
agents/           meeseeks, morty, rick
bin/              dependency-free Node scripts, added to the Bash tool's PATH;
                  the .cmd files make them callable from PowerShell
scripts/          orch-lib.js (shared by bin/), SubagentStop hook
hooks/hooks.json  hook declaration
user/CLAUDE.md    global writing rules
```
