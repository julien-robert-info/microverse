# microverse

Claude Code plugin to run a project as missions delegated to background
agents: one task, one branch, one worktree. An orchestrating conversation
designs, writes the brief, launches the agent, reviews its diff, merges and
cleans up; the launch pace follows the usage quota.

## Contents

| Component | Role |
|---|---|
| skill `orchestration` | procedure: roles and models, budget, brief, review of an agent's branch, series report, compaction, talking to the user, a series that runs on its own, stopping and resuming |
| skill `init` | writes a project's orchestration profile; offers to set `autoCompactWindow`, `"model": "sonnet"` and `"advisorModel": "opus"` in `.claude/settings.local.json` (the conversation runs on Sonnet and consults Opus at decision points) |
| agent `morty` (Sonnet) | implements a brief in its worktree |
| agent `meeseeks` (Haiku; Sonnet for a code map; writes only the new file its prompt names) | answers one question with facts and their evidence, writes a code map or runs measurement recipes |
| agent `rick` (Opus, Sonnet for a small mission; writes only its notes file) | designs a mission: measurements, rules, draft brief, questions for the user |
| agent `council` (Opus; writes only its review file) | reviews a risky diff, writes the full review to a file, returns a verdict and one line per defect |
| `orch-quota` | reads the quota counters and advises the launch pace, counting the agents running on the account and learning their cost (`--calibrate`) |
| `orch-usage` | tokens and API-equivalent cost per model (advisor calls on their own `<model> (advisor)` rows) or per agent run, context size of a session |
| `orch-report --since <commit>` | merges since a commit, agent runs and their cost, quota and context size, in Markdown |
| `agent-check <branch>` | commits, merge with the base, clean worktree, profile checks (`--merged`: on the merge result), suspicious patterns in the diff; one run per worktree at a time |
| `agent-cleanup [--keep-branch] <branch>` | removes an agent's worktree and merged branch; `--keep-branch` removes the worktree only, to resume an interrupted agent (refuses with uncommitted changes) |
| `PreToolUse` hook (`agent-model-guard`, matcher `Agent\|Task`) | denies the launch of a `microverse:` agent with no model or a model its role does not allow; other agents pass |
| `SubagentStop` hook | stops servers left running by a finished agent |
| `UserPromptSubmit` hook (`context-guard`) | once, when the context nears the auto-compaction window: update the state file; once, when it is past it (`autoCompactWindow` probably unset); once, when `autoCompactWindow` is below `compact_window` + 33000; once, when `CLAUDE.local.md` exceeds 60 lines |
| `SessionStart` hook (matcher `compact\|startup\|resume`) | after a compaction, restates that `CLAUDE.local.md` is the state of reference and lists the agent worktrees, merged or not; on a new or resumed conversation, lists them with their last commit and uncommitted changes to resume an interrupted series (silent without a profile or worktree) |
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
| `compact_window` | 150000 | context size (tokens, 100000 to 1000000) at which Claude Code compacts the orchestrating conversation; `/microverse:init` writes it + 33000 as `autoCompactWindow` in `.claude/settings.local.json`, because Claude Code compacts about 33K below that setting |
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

In a conversation opened at the project root, the `orchestration` skill loads
on requests about missions and series;
`/microverse:orchestration` forces it.

### Talking to the orchestrator

Requests are understood by intent, in any language; the examples are not a
word list.

| You say (example) | The orchestrator |
|---|---|
| start a mission, or a series with its goal | designs or briefs it, launches it; the series then runs on its own |
| next mission, chain | launches the next one after a fresh quota check |
| where are we | summarizes the trace lines |
| report | writes the series report |
| "Q1 as recommended, Q2 b" | applies the answers to the numbered questions |
| confirm or reject a "to confirm" decision | records it in the notes and the state file |
| the counters "5h x% \| wk y%" | fills in the quota when the usage extension is missing |
| yes to a push or deploy | pushes or deploys; nothing remote happens before |
| "I'm stopping soon" | agents commit their work, the state file gets a "Resume" section, the last message is "Ready to shut down" |
| "resume", in a new conversation | relaunches interrupted missions from their branches |
| a reference to a message of the previous conversation | searched in its transcript |

Stopping and resuming. On an announced stop, each running `morty` commits its
work as `wip:`, each `rick` writes its notes, and the state file lists per
mission the branch, last commit and next step, with the open questions and the
transcript path. On an unannounced one, the state file is already current and a
`morty` commits after each step, so at most one step is lost. In the next
conversation the `SessionStart` hook lists the agent worktrees; interrupted
branches are freed with `agent-cleanup --keep-branch` and relaunched.

The scripts can also be run by hand from the repository root:

```bash
orch-quota --target 98 --reserve 30 --running 1
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
skills/           orchestration (SKILL.md, budget.md, brief.md, review.md, stop-resume.md), init
agents/           rick, morty, council, meeseeks
bin/              dependency-free Node scripts, added to the Bash tool's PATH;
                  the .cmd files make them callable from PowerShell
scripts/          orch-lib.js (shared by bin/ and the hooks), hooks (SubagentStop,
                  UserPromptSubmit, SessionStart on compaction, startup and resume)
tests/            node:test suite, run with `npm test`
hooks/hooks.json  hook declaration
user/CLAUDE.md    global writing rules
```
