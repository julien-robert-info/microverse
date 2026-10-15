# microverse

Claude Code plugin to run a project as missions delegated to background
agents: one task, one branch, one worktree. An orchestrating conversation
designs, writes the brief, launches the agent, reviews its diff, merges and
cleans up; the launch pace follows the usage quota.

## Contents

| Component | Role |
|---|---|
| skill `orchestration` | procedure: roles and models, budget, brief, reception, series report, conversation switch |
| skill `init` | writes a project's orchestration profile; offers to set `autoCompactWindow`, `"model": "sonnet"` and `"advisorModel": "opus"` in `.claude/settings.local.json` (the conversation runs on Sonnet and consults Opus at decision points) |
| agent `morty` (Sonnet) | implements a brief in its worktree |
| agent `meeseeks` (Haiku, read-only) | answers one question with facts and their evidence |
| agent `rick` (Opus, writes only its notes file) | designs a mission: measurements, rules, draft brief, questions for the user |
| agent `council` (Opus, read-only) | reviews a risky diff, returns a verdict and ranked defects |
| `orch-quota` | reads the quota counters and advises the launch pace |
| `orch-usage` | tokens and API-equivalent cost per model (advisor calls on their own `<model> (advisor)` rows) or per agent run, context size of a session |
| `orch-report --since <commit>` | merges since a commit, agent runs and their cost, quota and context size, in Markdown |
| `agent-check <branch>` | commits, merge with the base, clean worktree, profile checks (`--merged`: on the merge result), suspicious patterns in the diff; one run per worktree at a time |
| `agent-cleanup <branch>` | removes an agent's worktree and merged branch |
| `SubagentStop` hook | stops servers left running by a finished agent |
| `UserPromptSubmit` hook (`context-guard`) | once, when the context nears the auto-compaction window: update the state file; once, when it is past it (`autoCompactWindow` probably unset); once, when `CLAUDE.local.md` exceeds 60 lines |
| `SessionStart` hook (matcher `compact`) | after a compaction, restates that `CLAUDE.local.md` is the state of reference and lists the agent worktrees, merged or not |
| `user/CLAUDE.md` | writing rules (README, comments, commits), to import into `~/.claude/CLAUDE.md` |

## Requirements

- Claude Code 2.1.293 or newer (`haiku` model alias for Claude Haiku 5.5).
- Node.js 20 or newer, for the scripts in `bin/`.
- Git.
- Optional: the VS Code extension "Claude Code Usage" (growthjack), whose
  readings `orch-quota` uses. Without it, the orchestrator asks the user for the
  counters.

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
| `compact_window` | 150000 | context size (tokens, 100000 to 1000000) at which Claude Code compacts the orchestrating conversation; `/microverse:init` writes it as `autoCompactWindow` in `.claude/settings.local.json` |
| `quota_file` | — | readings file, if the extension is not at its default location |

Per project, the `.claude/orchestration/` profile (versioned), written by
`/microverse:init`:

- `profile.json`: `setup` (commands for a fresh worktree), `checks` (`name`,
  `run`, optional `paths`), `teardown` (commands restoring files the checks
  rewrite), `servers` (command-line patterns), `diffPatterns`
  (`pattern`, `why`), `shared` (exclusive resources);
- `rules.md`: the project's rules and traps, read first by the agents.

The project ignores `CLAUDE.local.md`, `NOTES.local.md` and
`.claude/worktrees/`.

## Usage

In a conversation opened at the project root: "démarre <mission>", "mission
suivante", "où en est-on ?", "rapport". The `orchestration` skill loads on these
requests; `/microverse:orchestration` forces it.

The scripts can also be run by hand from the repository root:

```bash
orch-quota --target 98 --reserve 30
orch-usage --since 2026-01-01
orch-usage --context
orch-usage --agents
orch-report --since a0f5690 --target 98 --reserve 30
agent-check feat/subject
agent-check feat/subject --merged
agent-cleanup feat/subject
```

## Evaluation

`evals/` holds a `claude plugin eval` suite checking that the skills trigger on
natural phrasing, in French and English: `orchestration` on "démarre …",
"mission suivante", status and report requests, `init` on "initialise
l'orchestration", and neither on an ordinary code question. Each case is one
`case.yaml` with a `tool_used: Skill` grader.

```bash
npm run eval                                    # 12 cases x 3 runs
claude plugin eval . --runs 1 --ablation none   # cheaper pass, about $1
claude plugin eval . --case "neg-*"             # one case or glob
```

It calls the API on your own credential (a few dollars at 3 runs), so it is
not part of the CI workflow. `--ablation none` skips the no-plugin baseline arm:
the skill graders are scored directly instead of being treated as indicators.
Results land in `evals/results/` (ignored by git).

## Architecture

```
.claude-plugin/   plugin.json (manifest, settings), marketplace.json (catalog)
skills/           orchestration (SKILL.md, budget.md, brief.md, review.md), init
agents/           rick, morty, council, meeseeks
bin/              dependency-free Node scripts, added to the Bash tool's PATH;
                  the .cmd files make them callable from PowerShell
scripts/          orch-lib.js (shared by bin/ and the hooks), hooks (SubagentStop,
                  UserPromptSubmit, SessionStart after a compaction)
tests/            node:test suite, run with `npm test`
hooks/hooks.json  hook declaration
user/CLAUDE.md    global writing rules
```
