# Changelog

## Unreleased

- A `Stop` hook (`audio-guard`) makes the orchestrator send the mp3 of a `▶` message it showed without one while the audio report is on. The state file line is now written exactly `Audio report: on`.
- README: the writing rules are imported from the catalog folder Claude Code keeps for a GitHub install; the table of French voices gives way to `edge-tts --list-voices`.

## [0.3.2] - 2026-10-24

- The `orchestration` skill loads less text on every request: the series report format, the rules turning a defect into a mission and the design procedure with a `rick` moved to `report.md`, `series.md` and `design.md`, read when needed. The text is unchanged.
- README: installation commands for the public repository, and a link to the GitHub Releases page.
- README: the `powershell-guard` row was above the introduction; it is back in the Contents table.
- A `PreToolUse` hook denies a PowerShell command that runs a `bin/` script by name (`orch-*`, `agent-check`, `agent-cleanup`): the scripts have no extension and Windows opened an "Open with" dialog. `morty` is told to run them from Bash, or through `node`.
- Hooks and scripts no longer cut their output on a pipe: stdout is flushed before the process ends (a hook's JSON was truncated at 8192 bytes on macOS).
- `orch-quota` no longer counts an agent that has just finished as running: it reads the `finished` mark Claude Code writes to the agent's `.meta.json` (an agent resumed afterwards still counts). Agents without the mark keep the ten-minute window.

## [0.3.1] - 2026-10-21

- `notes/` is in the project's `.gitignore`, in the README and in the check of `/microverse:init`: the notes hold the design and the measurements of the missions and stay out of the repository.
- MIT license (`LICENSE`, `license` of the manifest).
- CI also runs the tests on macOS.

## [0.3.0] - 2026-10-21

- `/microverse:status` is easier to read: a header and a three-line summary (quota gauges with the expected pace, advice, context), state file lines cut at 100 characters, `✔ ● ? !` markers where the data says it, merges without their sub-commits, one total line for the agents (`--agents` lists the runs, `--verbose` adds the Pace, Running, Agent cost and Advice lines).
- The terminal status line shows the 5h and 7d counters as five-cell gauges, coloured green below the expected pace, yellow up to the target and red above (none with `NO_COLOR` or `TERM=dumb`). Run `statusline.js --install` again to refresh the copy.

## [0.2.0] - 2026-10-20

- The Windows `.cmd` wrappers of `bin/` are removed: cmd.exe expanded `& | % "` of an argument before Node started. Outside Git Bash and the Claude Code Bash tool, run a script as `node <plugin dir>\bin\<script> <args>`, and never give it text taken from a repository through cmd.exe or PowerShell.
- `council`, `rick` and `meeseeks` never use `Artifact` or `SendUserFile`: a review or notes go in the repository file the prompt names.
- Profile trust: `sanitize` also strips default-ignorable characters (variation selectors, soft hyphen, U+034F, U+3164…), so the approval screen and `orch-trust --commands` agree. The SessionStart hook tells the model to have an invalid profile fixed, or that the main worktree was not found, instead of asking for an approval; the README and the orchestration skill document both cases.

- Profile trust, strict schema: `setup`, `teardown` and `servers` must be arrays of strings and each check an object with a string `run`; anything else (or unreadable JSON) is state `invalid`: it cannot be approved, `--status` and `--commands` exit 1, `agent-check` exits 2 with the reason, and `agent-check` runs only the validated lists. `--commands` also refuses a command with hidden characters (tag, zero-width, bidi). A main worktree that cannot be found is unapproved, never `none`.

- Profile trust, review fixes: `orch-trust --commands setup|checks` prints the approved main profile's commands (agents run these, not their branch's file; exit 1 unapproved, exit 2 for a command with a line break or control character); `orch-trust` shows every command whole and ends by asking the user to type the approval, while `agent-check` bounds its listing and says what was omitted; `agent-check` compares the protected folder case-insensitively and sees renames out of it; the SubagentStop hook stops nothing until the profile is approved; a git dir not named `.git` (`--separate-git-dir`) resolves its main worktree; the fingerprint ignores CRLF conversion.
- Profile trust: the commands of `profile.json` run only after the user approves its fingerprint with the new `orch-trust` (`orch-trust <sha256>`, run by the user, never by an agent). The fingerprint is that of the main worktree's profile and is stored in `~/.claude/microverse/trust.json`. Unapproved, `agent-check` exits 2 without running anything, `morty` and the orchestration skill stop, and the SessionStart hook no longer loads the skill. A diff touching `.claude/orchestration/` fails `agent-check`. The README gains a trust-model section.
- `agent-check` and `agent-cleanup` refuse an invalid branch name (exit 2) and print everything from the repository sanitized; the branch listings show `(invalid name)`; git calls set `core.fsmonitor=false`.
- `agent-cleanup` only touches worktrees under `.claude/worktrees` and refuses any other worktree carrying the branch (it never unlocks or removes one of yours). Git calls set `GIT_OPTIONAL_LOCKS=0` so status checks do not take `index.lock` in live agent worktrees, and `agent-check` reclaims a stale lock atomically.
- Output hygiene: one shared `sanitize` strips terminal control sequences, line separators, bidi, zero-width and tag characters from commit subjects, branch names, agent descriptions and tool errors before `orch-status`, `orch-report`, `orch-usage`, `orch-speak`, the status hook and the SessionStart context print them (length-capped there). The stop-agent-servers journal is size-bounded and no longer records command-line arguments. The skills say how to write an apostrophe in a quoted option value.
- Optional audio report: tell the orchestrator to turn it on and each report or question message also arrives as an mp3 (SendUserFile). The new orch-speak turns the spoken text into speech with edge-tts (installed separately); options speak_voice (default fr-FR-HenriNeural), speak_rate (default +10%), speak_pitch and speak_volume.
- `/microverse:status` shows the orchestration at a glance in the terminal
  (missions and questions of `CLAUDE.local.md`, agent worktrees, branches
  without a worktree, merges since the last report, agent runs, quota,
  context) with no model request: a `UserPromptExpansion` hook runs the new
  read-only `orch-status` and blocks the command with its output. The last
  report is read from the `Last report` / `Dernier rapport` line of
  `CLAUDE.local.md` or given as argument. The skill body is the fallback when
  hooks are off.

- `orch-quota` reads the counters from the terminal status line readings as
  well as from the VS Code extension, so a CLI-only session gets its pacing
  advice. Per counter it takes the latest window not yet reset and its highest
  value; the `Counters:` line names the source and age of each. A weekly
  reading whose reset has passed is no longer used ("No current weekly
  reading"). Each run refreshes the installed copy of the status line script.
- The status line keeps a 15-day history of the rising readings
  (`statusline-history/<UTC day>.jsonl` in the data folder). `orch-quota` uses
  it for the usage at the start of the weekday period, and calibrates from it
  (points per dollar, agent cost) when the extension has no reading under 48
  hours old; the two sources are never mixed, `calibration.json` stores the
  `source`, a switch skips the plan-change comparison, and `--calibrate` names
  the source.
- `/microverse:init` offers the status line in `.claude/settings.local.json`;
  it replaces an earlier microverse status line once confirmed and leaves any
  other one untouched.
- `orch-quota --no-write` reads without writing: it does not refresh the
  installed status line script, deletes no expired reading and does not save the
  calibration (a stale one is recomputed in memory). `orch-report` accepts
  `--no-write`, passed to `orch-quota`, and `--session <id>`, passed to
  `orch-usage --context`.
- The `context-guard` hook ignores a prompt starting with `/microverse:status`,
  so its one-time warnings are not spent on a prompt that is not answered by
  the model.

- In a project set up with `/microverse:init`, every conversation (new,
  resumed, cleared or compacted) is told by the `SessionStart` hook to load the
  orchestration skill first; the hook now also runs on `clear` and no longer
  stays silent when there is no agent worktree.
- A series runs on its own by default: after a merge the next launchable
  mission starts, including missions generated from defects under guards
  (no new business rule, depth 1, fewer than three unconfirmed decisions in the
  zone, quota); questions wait for the series report unless nothing else can
  launch. New skill sections "Running a series" and "Stopping and resuming":
  on the user's word every agent commits its work and the state file gets a
  "Resume" section. The `SessionStart` hook also runs on `startup` and
  `resume` and lists the worktrees with last commit and uncommitted changes;
  `agent-cleanup --keep-branch` frees an interrupted branch; `morty` commits
  after each step and can resume a branch. The hook also gives the
  conversation's transcript path, and the stop procedure lives in
  `stop-resume.md`.
- The orchestration skill triggers on intent, in any language, instead of
  quoted phrases; the README documents what to say in "Talking to the
  orchestrator".
- Compaction happens at `compact_window`: Claude Code compacts about 33K below
  `autoCompactWindow`, so `/microverse:init` writes `compact_window` + 33000,
  `context-guard` warns when the setting is lower, and `orch-usage --context`
  uses the plugin option as its threshold.

- Agent/model combinations are a short table in the orchestration skill
  (`rick` Opus or Sonnet for a small mission, `morty` Sonnet, `council` Opus,
  `meeseeks` Haiku or Sonnet) and the new `PreToolUse` hook `agent-model-guard`
  denies any other launch of a `microverse:` agent, or one with no model.
- Cheaper, shorter work: design runs in two phases (a Sonnet `meeseeks` writes
  the code map, the `rick` requests measurements as recipes that a Haiku
  `meeseeks` runs, then the `rick` is resumed); `meeseeks` and `council` write
  one new file named by the prompt, so `council` returns only the verdict and
  one line per defect; briefs aim at about 60 tool calls and are split past
  about six rules or several layers.

- The unit of work is now called a mission (it was "chantier") in the skills,
  agents, hooks and scripts. Projects already set up rename the term in their
  state file (section titles, the `# Compact instructions` section) and in
  their notes index.
- The orchestration skill sorts its messages into trace lines (one line per
  event, detail in the notes, safe to skip) and messages for the user (report
  and questions) opened with `▶`. Each question is numbered and carries its
  context, the options and their effect, the recommendation and what waits on
  it, so it can be answered without reading the conversation; `rick` writes
  its open questions the same way.
- `rick` now designs chantiers instead of reviewing diffs: it measures on real
  data, settles the rules and writes them with a draft brief, the risky zones
  and the questions for the user in `notes/<chantier>.md`, the only file it
  writes. It runs in the background beside the `morty` agents. The diff
  review moves to the new `council` agent (Opus, read-only), which opens its
  report with a verdict. The orchestration skill no longer sends open
  investigations to a `general-purpose` Opus agent nor suggests opening the
  conversation on Opus for design.
- `orch-quota` allows agents side by side: up to 2 on the normal advice, 3 on
  speed up, bounded by the room left under the 5h limit. An agent is a
  `morty` or a `rick`; the advice moved to `paceAdvice` in `orch-lib.js`.
- `orch-quota --running <n> [--agent-cost 15]` launches no agent when the room
  left under `five_hour_limit`, minus the share of the running agents, is
  under what one agent uses (about 15 points of the 5h counter: a `morty` with
  its review, or a `rick`). It replaces the rule that only looked at the 5h
  counter being under 60 %; a series that started two missions at 80 % hit
  the limit.
- `orch-quota` counts the agents running on the whole account (subagent
  transcripts of all projects written in the last 10 minutes, `meeseeks` left
  out) when `--running` is not given, and learns the agent cost from the past
  runs: the 5h points per API-equivalent dollar, calibrated against the
  transcripts of all projects, times the median cost of a `rick` or of a
  `morty` plus its `council`. `--calibrate` recomputes and prints it; a ratio
  that moves by more than x2 in 48 hours is reported as a subscription change.
  The pricing code moved from `orch-usage` to `orch-lib.js`.
- The orchestration skill passes the `quota_file` option in single quotes: an
  unset option stays literal and made the command fail in bash.
- Briefs number their rules (R1…) and expected tests (T1…); the `morty`
  checks its diff against them before reporting, with a line per rule and
  test in its report; the orchestrator checks that table before calling
  `council` and passes it along. After a review, the fixes go back to the
  `morty` and are checked on the fix commits; `council` is relaunched only on
  what touches the risky zones again, on that range.
- `agent-check` refuses a second run on a worktree while the first is alive
  (lock file in the worktree's git dir, taken over when its process is gone):
  two `--merged` runs undid each other's merge and collided on the build
  tools' output lock.
- The series report aims at 15 to 20 lines through its wording, without
  dropping items: business decisions in full under "to confirm", technical
  choices and minor open points counted with their notes section, a new
  "incidents" section, the `council` verdict per merge, deployment steps once
  the user agrees to deploy, quota, agent cost and context on one line, with an
  example. Between reports, one line per event, under 150 characters.

- The orchestration skill lists what the orchestrator reads itself (state
  file, notes section, diff under review, code for a brief) and sends the rest
  to a `meeseeks`: database queries, logs, remote commands, searches through
  notes or large files, one `meeseeks` per measurement during design. A project
  skill holding the query recipe is named in the question; `meeseeks` follows
  it.

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

## [0.1.0] - 2026-10-11

- Skills `orchestration` and `init`.
- Agents `morty` (implements a brief, Sonnet), `meeseeks` (answers one question,
  Haiku, read-only) and `rick` (reviews a risky diff, Opus, read-only).
- Scripts `orch-quota`, `orch-usage` (`--context`, `--agents`), `agent-check`
  (with the profile's `teardown`) and `agent-cleanup`.
- `SubagentStop` hook stopping the servers a finished agent left running, on
  Windows, macOS and Linux.
- Writing rules in `user/CLAUDE.md`.
