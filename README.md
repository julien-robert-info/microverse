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
| skill `status` plus `UserPromptExpansion` hook | `/microverse:status`: overview of the orchestration in the terminal, with no model request |
| agent `morty` (Sonnet) | implements a brief in its worktree |
| agent `meeseeks` (Haiku; Sonnet for a code map; writes only the new file its prompt names) | answers one question with facts and their evidence, writes a code map or runs measurement recipes |
| agent `rick` (Opus, Sonnet for a small mission; writes only its notes file) | designs a mission: measurements, rules, draft brief, questions for the user |
| agent `council` (Opus; writes only its review file) | reviews a risky diff, writes the full review to a file, returns a verdict and one line per defect |
| `orch-quota` | reads the quota counters (extension and terminal status line readings, merged; the status line also keeps a 15-day history that serves the period start and, without a recent extension reading, the calibration) and advises the launch pace, counting the agents running on the account and learning their cost (`--calibrate`); `--no-write` reads without refreshing, pruning or saving anything |
| `orch-usage` | tokens and API-equivalent cost per model (advisor calls on their own `<model> (advisor)` rows) or per agent run, context size of a session |
| `orch-report --since <commit>` | merges since a commit, agent runs and their cost, quota and context size, in Markdown (`--no-write` is passed to `orch-quota`, `--session <id>` picks the conversation of the context line) |
| `orch-speak` | turns a spoken text (stdin or `--file`) into an mp3 with edge-tts for the optional audio report and prints its path; `MICROVERSE_EDGE_TTS` names the edge-tts command when it is not on PATH |
| `orch-status [<commit>]` | plain-text overview, read-only: missions and questions of `CLAUDE.local.md`, agent worktrees, merges since the last report, agent runs, quota, context (the command behind `/microverse:status`) |
| `orch-trust [<sha256>]` | shows the fingerprint and commands of the project profile and the approval line to run; `orch-trust <sha256>` approves it (the user runs it, never an agent); `--project <dir>` resolves the project from `<dir>` instead of the current directory, in every mode; `--status` exits 0 when approved or without profile; `--commands setup\|checks` prints the approved commands for agents |
| `agent-check <branch>` | commits, merge with the base, clean worktree, profile checks (only once the profile is approved; `--merged`: on the merge result), suspicious patterns in the diff; one run per worktree at a time |
| `agent-cleanup [--keep-branch] <branch>` | removes an agent's worktree (only under `.claude/worktrees`) and merged branch; `--keep-branch` removes the worktree only, to resume an interrupted agent (refuses with uncommitted changes) |
| `PreToolUse` hook (`agent-model-guard`, matcher `Agent\|Task`) | denies the launch of a `microverse:` agent with no model or a model its role does not allow; other agents pass |
| `PreToolUse` hook (`quota-guard`, matcher `Agent\|Task`) | in a project with a profile, asks you to confirm the launch of a `microverse:morty` or `microverse:rick` when the `orch-quota` advice is at a limit (week at the target or 3 points under it, 5h at the limit, or no room left for one more agent); allows with a note when the weekly counter is above the pacing line or the 5h reading is over 15 minutes old; council, meeseeks and other agents pass; read only, no model request |
| `PreToolUse` hook (`powershell-guard`, matcher `PowerShell`) | denies a PowerShell command that runs a `bin/` script by name (Windows opens an "Open with" dialog instead); the message points to Bash or `node <plugin dir>/bin/<script>` |
| `UserPromptExpansion` hook (`status-command`, matcher `^microverse:status$`) | answers `/microverse:status` by blocking the command with the output of `orch-status`; other commands are untouched |
| `Stop` hook (`audio-guard`) | with the audio report on and a `▶` message shown without its mp3, makes the orchestrator send it before the turn ends (blocks once per turn) |
| `SubagentStop` hook | stops servers left running by a finished agent |
| `UserPromptSubmit` hook (`context-guard`) | once, when the context nears the auto-compaction window: update the state file; once, when it is past it (`autoCompactWindow` probably unset); once, when `autoCompactWindow` is below `compact_window` + 33000; once, when `CLAUDE.local.md` exceeds 60 lines; ignores a prompt starting with `/microverse:status` |
| `SessionStart` hook (matcher `compact\|startup\|resume\|clear`) | in a project with a profile, tells every conversation to load the orchestration skill first; after a compaction, restates that `CLAUDE.local.md` is the state of reference and lists the agent worktrees, merged or not; on a new, cleared or resumed conversation, lists them with their last commit and uncommitted changes to resume an interrupted series (silent without a profile) |
| `user/CLAUDE.md` | writing rules (README, comments, commits), to import into `~/.claude/CLAUDE.md` |

## Requirements

- Claude Code 2.1.293 or newer (`haiku` model alias for Claude Haiku 5.5).
- Node.js 20 or newer, for the scripts in `bin/`.
- Git.
- Optional, for the quota counters: the VS Code extension "Claude Code Usage"
  (growthjack), or the microverse status line in a terminal session (set up by
  `/microverse:init`; the VS Code panel runs no status line). `orch-quota`
  merges the readings of both. With neither,
  the orchestrator asks the user for the counters. The status bar shows the 5h
  and 7d counters as five-cell gauges, green below the expected pace, yellow up
  to the target (defaults 90 and 98 %), red above; `NO_COLOR` or `TERM=dumb`
  gives plain text.
- Optional, for the audio report: edge-tts (Python 3, "pip install --user
  edge-tts" or "pipx install edge-tts"). It is an unofficial client of
  Microsoft's online speech service: the spoken text leaves the computer.

## Installation

The repository is its own plugin catalog. Claude Code fetches it itself: no
manual clone.

```bash
claude plugin marketplace add julien-robert-info/microverse
claude plugin install microverse@microverse
```

From a clone, add `<path to the clone>` instead of `julien-robert-info/microverse`.
The changes of each version are on the
[GitHub Releases page](https://github.com/julien-robert-info/microverse/releases).

In the VS Code extension without the CLI, use `/plugin` in the chat panel
(Marketplaces, then Discover) for the same two steps.

A catalog added from a local path loads the plugin in place: a change takes
effect in the next conversation or after `/reload-plugins`.

Optional writing rules (README, comments, commit messages), imported in
`~/.claude/CLAUDE.md`. With the plugin installed from GitHub, Claude Code keeps
the catalog in `~/.claude/plugins/marketplaces/microverse/`:

```markdown
@~/.claude/plugins/marketplaces/microverse/user/CLAUDE.md
```

From a clone, import `user/CLAUDE.md` of the clone instead. The folder of the
catalog is the `installLocation` of `microverse` in
`~/.claude/plugins/known_marketplaces.json`.

## Configuration

Plugin settings (`/config`):

| Key | Default | Meaning |
|---|---|---|
| `week_target` | 98 | consumption aimed at the end of the week; beyond it no more resuming, 3 points before no new agent (%) |
| `weekday_reserve` | 30 | points kept for weekdays; the weekend rises to `week_target` minus this value |
| `five_hour_limit` | 90 | beyond it, no new agent until the 5h counter resets; 5 points higher, no more resuming (%) |
| `compact_window` | 150000 | context size (tokens, 100000 to 1000000) at which Claude Code compacts the orchestrating conversation; `/microverse:init` writes it + 33000 as `autoCompactWindow` in `.claude/settings.local.json`, because Claude Code compacts about 33K below that setting |
| `quota_file` | — | readings file, if the extension is not at its default location |
| `speak_voice` | fr-FR-HenriNeural | voice of the audio report, from `edge-tts --list-voices` |
| `speak_rate` | +10% | speaking rate of the audio report, such as +20% or -5% |
| `speak_pitch` | +0Hz | pitch of the audio report, such as -5Hz |
| `speak_volume` | +0% | volume of the audio report, such as +20% |

#### Launches at a quota limit

In a project with a profile, a `PreToolUse` hook computes the `orch-quota` advice at each launch of a `microverse:morty` or `microverse:rick`, whether or not the orchestrator ran `orch-quota`, and asks you to confirm the launch when the advice is a limit. The prompt gives the advice, both counters, the agents running and the cost per agent; confirming launches the agent. In a non-interactive run (`claude -p`) the prompt cannot be answered: the launch is denied and the reason is returned. The hook reads the readings and the stored calibration and writes nothing; with no weekly reading, or on any error, the launch goes through. Agents launched in the same message do not count as running for each other. `five_hour_limit` and `week_target` move the thresholds (an empty option means its default). The stored calibration is refreshed by `orch-quota`, not by the hook.

Per project, the `.claude/orchestration/` profile (versioned), written by
`/microverse:init`:

- `profile.json`: `setup` (commands for a fresh worktree), `checks` (`name`,
  `run`, optional `paths`), `teardown` (commands restoring files the checks
  rewrite), `servers` (command-line patterns), `diffPatterns`
  (`pattern`, `why`), `shared` (exclusive resources);
- `rules.md`: the project's rules and traps, read first by the agents.

The project ignores `CLAUDE.local.md`, `NOTES.local.md`, `notes/` (the
missions' design and measurements) and `.claude/worktrees/`.

## Usage

In a conversation opened at the project root, the `orchestration` skill loads
on requests about missions and series;
`/microverse:orchestration` forces it.

`/microverse:status` shows the state of the orchestration at once: the
missions and questions of `CLAUDE.local.md` (sections titled Missions,
Questions, Resume or Reprise, copied as written), the agent worktrees, the
branches not merged and without a worktree, what was merged since the last
report, the agent runs and their cost since then, the quota and the context
size. It sends no request to the model: a `UserPromptExpansion` hook runs
`orch-status` and blocks the command with the output, which Claude Code shows
as a warning preceded by `UserPromptExpansion operation blocked by hook:`. The
last report is the commit on the first `Last report` / `Dernier rapport` line
of `CLAUDE.local.md`, or the commit given as argument
(`/microverse:status a0f5690`). Nothing is written. The output is plain
Unicode for a code block: a header, a summary of three lines (the 5h and week
counters as ten-cell gauges, the week with a `|` at the expected pace, then the
advice and the context size), then the state file lines cut at 100 characters
(`?` marks a question), the worktrees (`●` to merge, `✔` merged, `!` merged but
with uncommitted changes), the merges of the first-parent line only, the agents
total and the quota and context detail. `--agents` lists each agent run and
`--verbose` adds the Pace, Running, Agent cost and Advice lines of the quota
(`/microverse:status --agents --verbose`). With hooks disabled, the
skill asks the model to run `orch-status` instead, which costs one request.

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
| the counters "5h x% \| wk y%" | fills in the quota when neither the extension nor the status line has a reading |
| yes to a push or deploy | pushes or deploys; nothing remote happens before |
| "I'm stopping soon" | agents commit their work, the state file gets a "Resume" section, the last message is "Ready to shut down" |
| "resume", in a new conversation | relaunches interrupted missions from their branches |
| a reference to a message of the previous conversation | searched in its transcript |

### Audio report

Tell the orchestrator to turn the audio report on or off, in any words.
While it is on, each message for you (series report, questions, ready to
shut down) also arrives as an mp3 sent with `SendUserFile`, to play on the
phone or the PC. The setting is one line of the state file, so it survives
compaction and new conversations; it reads exactly `Audio report: on` (any
voice or rate after it), and the `Stop` hook `audio-guard` relies on it to make
the orchestrator send the mp3 of a `▶` message it forgot. A voice or rate asked for in the
conversation applies at once; `/config` changes the defaults. The mp3 files
go to `microverse-speak/` in the system temporary folder and are deleted
after 7 days. It needs edge-tts (see Requirements).

Any edge-tts voice works: `edge-tts --list-voices` lists them, and
`speak_voice` sets the one to use (the default is French).

Stopping and resuming. On an announced stop, each running `morty` commits its
work as `wip:`, each `rick` writes its notes, and the state file lists per
mission the branch, last commit and next step, with the open questions and the
transcript path. On an unannounced one, the state file is already current and a
`morty` commits after each step, so at most one step is lost. In the next
conversation the `SessionStart` hook loads the orchestration skill and lists the agent worktrees; interrupted
branches are freed with `agent-cleanup --keep-branch` and relaunched.

The scripts can also be run by hand from the repository root:

```bash
orch-quota --target 98 --reserve 30            # counts the running agents and learns their cost
orch-quota --running 1 --agent-cost 15         # overrides, rarely needed
orch-quota --calibrate                         # recompute the calibration now
orch-quota --no-write                          # read-only: no refresh, no pruning, no saved calibration
orch-status --target 98 --reserve 30           # what /microverse:status prints
orch-status --agents --verbose                 # one line per agent run, the full quota detail
orch-usage --since 2026-01-01
orch-usage --context
orch-usage --agents
orch-report --since a0f5690 --target 98 --reserve 30
orch-report --since a0f5690 --no-write --session <id>   # read-only; context of that conversation
orch-trust                                     # fingerprint and commands of the profile
orch-trust --project /path/to/project --status # any mode, from another directory
agent-check feat/subject
agent-check feat/subject --merged
agent-cleanup feat/subject
```

`agent-check` and `agent-cleanup` refuse (exit 2) a branch name that git
accepts but that is unsafe in a shell: one containing `& | < > ^ % ! "`, a
control character or a leading `-`; the listings print `(invalid name)` for such
a branch. The bare script name works in the Claude Code Bash tool and in Git
Bash. On Windows outside Git Bash, run a script as
`node <plugin dir>\bin\<script> <args>`, and never give it text taken from a
repository through cmd.exe or PowerShell: they expand `& | % "` of an argument
before Node starts, which validation inside Node cannot undo.

## Trust model

`.claude/orchestration/profile.json` is code, like the scripts of a
`package.json`: review it on each pull. Nothing in it runs until you approve it
on your machine: `orch-trust` shows its fingerprint (sha256) and commands, and
the approval line it prints records the approval in
`~/.claude/microverse/trust.json`. The line names the script by absolute path
and the project with `--project`, so it works from any directory, with a local
clone as with a marketplace install (the script then lives in the plugin
cache), without the plugin `bin/` on the PATH:

```
! node "/path/to/plugin/bin/orch-trust" <sha256> --project "/path/to/project"   # Claude Code CLI: type it at the prompt
node "/path/to/plugin/bin/orch-trust" <sha256> --project "/path/to/project"     # VS Code extension, desktop app: run it in a terminal
```

The `!` prefix exists only in the Claude Code CLI; elsewhere it would be sent
to the model as a prompt. `orch-trust` picks the form from
`CLAUDE_CODE_ENTRYPOINT` (`cli` gives the `!` form). No agent ever runs the
line, so never put `orch-trust` in a permission allow list.

The approval covers the profile of the main worktree, and `agent-check` and
`orch-trust --commands setup|checks` take the commands from it: what an agent
runs is what you approved, never the profile of its branch. Any edit to the
file, including one brought by a merged branch, revokes the approval. Until it
is approved, `agent-check` exits 2, `morty` stops and the SessionStart hook
does not load the orchestration skill. Edge cases are in
[SECURITY.md](SECURITY.md#details).

- Runs: `setup` (each `morty`, in its worktree); `checks[].run` and `teardown`
  (`agent-check`, the agent, `/microverse:init`), which execute the branch's
  code with your session's rights; `servers` patterns, to decide which
  processes the SubagentStop hook kills.
- Reads: transcripts of `~/.claude/projects/` (token counts and agent metadata,
  never message text), the quota file, `CLAUDE.local.md`, git data and the
  process list.
- Writes: `~/.claude/microverse/` (or `CLAUDE_PLUGIN_DATA`) for status line
  data, calibration, approvals and logs; `.claude/settings.local.json` with
  your consent (`/microverse:init`); a lock file in the worktree's git directory.
- Deletes or stops: `agent-cleanup` removes a merged branch's worktree under
  `.claude/worktrees/` and the branch; the SubagentStop hook kills the processes
  of a finished agent that match a `servers` pattern.

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
skills/           orchestration (SKILL.md, budget.md, brief.md, review.md, stop-resume.md, audio.md; read on demand: report.md, series.md, design.md), init, status
agents/           rick, morty, council, meeseeks
bin/              dependency-free Node scripts, added to the Bash tool's PATH
scripts/          orch-lib.js (shared by bin/ and the hooks), hooks (SubagentStop,
                  UserPromptSubmit, UserPromptExpansion, Stop, SessionStart on compaction,
                  startup, resume and clear)
tests/            node:test suite, run with `npm test`
hooks/hooks.json  hook declaration
user/CLAUDE.md    global writing rules
```

## License

MIT, see `LICENSE`.
