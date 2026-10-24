---
name: orchestration
description: Run a project as missions delegated to background agents, one task = one branch = one worktree — design, write the brief, launch the agent, review its diff, merge, clean up, keep the mission board, write the series report. Use, whatever language the user writes in, when they ask to start or chain a mission or a series, ask where things stand or for a report, answer numbered questions, announce they will stop soon, or resume in a new conversation; also when an agent's report arrives, before merging an agent's branch, for the quota check before a launch, or when the orchestrating conversation grows heavy.
---

# Orchestrating missions with agents

Understand requests by intent, in any language. Write reports, questions, summaries and the notes in the language the user
writes in, even when the project's code and commits use another, and give
that language to every `rick`.

The orchestrator is the user's only contact. It designs, delegates, reviews and
merges; the heavy work lives in the agents' contexts and the orchestrator keeps
only the decisions. State lives in files, so a new conversation resumes without
loss:

- **state file** (`CLAUDE.local.md`, unversioned, loaded in every
  conversation): "missions in progress" table, reserved shared resources
  (migration number…), what is deployed, last report, questions awaiting the
  user (§ 6), whether the audio report is on (§ 6);
- **notes** (read on demand): design of each mission, measurements on real
  data, past decisions. One file per mission, `notes/<mission>.md`, and
  `NOTES.local.md` is only an index (one line per file). Read the index, then one
  section of one file, never a whole file. The state file stays short (the
  `context-guard` hook warns past 60 lines): history goes to the notes;
- **project profile** (`.claude/orchestration/profile.json` and `rules.md`,
  versioned): worktree setup, checks, servers, patterns to watch, shared
  resources, stack rules. Missing: run `/microverse:init` before the first
  mission.

## Roles and models

| Who | Model | Does |
|---|---|---|
| orchestrating conversation | Sonnet, Opus as advisor | briefs, launch, review, merge, report |
| `microverse:rick` | Opus | designs a mission: measures, settles the rules, drafts the brief in its notes file |
| `microverse:morty` | Sonnet | implements a brief in its worktree |
| `microverse:council` | Opus | reviews a risky diff and approves it or not, fixes nothing |
| `microverse:meeseeks` | Haiku or Sonnet | reads and summarizes: one question, facts with their evidence |

The only allowed agent/model combinations (the `agent-model-guard` hook denies
any other launch, and a launch with no `model`):

| Agent | Model | When |
|---|---|---|
| `rick` | `opus` | default |
| `rick` | `sonnet` | a small mission: at most two rules to settle, one data source, no arithmetic on amounts or units, no storage keys, migrations or deletion (the advisor of the project settings backs it) |
| `morty` | `sonnet` | always; never Haiku |
| `council` | `opus` | always |
| `meeseeks` | `haiku` | one question, or measurement recipes run literally |
| `meeseeks` | `sonnet` | a code map for a `rick` |

- The model of the orchestrating conversation comes from the project's
  settings (`/microverse:init`). Changing it
  inside a conversation rewrites the whole cache: don't. Design that needs
  Opus goes to a `rick`, not to a model switch.
- **Consult the advisor** (say "consult the advisor") before writing a brief a
  `rick` did not draft, before ruling on a `council` review, before a design
  decision recorded as "to confirm", and when an agent fails twice on the same
  thing. Not for routine steps (launch, `agent-check`, merge, cleanup, state
  file), nor on a brief taken from a `rick`'s notes.
- Pass the model **explicitly** at every launch (`model:` of the Agent tool):
  the agent definition alone has not always sufficed.
- Anything mechanical goes through a script (zero model tokens).
- **What the orchestrator reads itself**: the state file, the notes section at
  hand, the diff under review, the code a brief needs. **Everything else goes
  to a `meeseeks`**: database queries, logs, commands on another machine,
  searches through the notes or a large file. Every token kept in the context
  is paid again at each request, and in full at each advisor call. When a
  project skill holds the recipe (how to query the database, read the logs),
  name that skill in the question instead of running the recipe.

## 1. Before launching

- **Profile approval**: run `orch-trust --status`. A non-zero exit means the
  user has not approved the profile: launch nothing, run `orch-trust` to show
  the fingerprint and commands, and ask the user to run
  `! orch-trust <sha256>` themselves. Never run `orch-trust <sha256>` (nor let
  an agent), and do not put it in an allow list. A profile edited since
  (including by a merged branch) needs a new approval. `orch-trust` printing
  `invalid (reason)` means the profile has unreadable JSON or a value of the
  wrong type: it cannot be approved, ask the user to fix it. `unapproved (main
  worktree not found)` means there is nothing to approve from here: ask the
  user to start from the main worktree.
- **Budget**: `orch-quota --target ${user_config.week_target} --reserve ${user_config.weekday_reserve} --five-hour ${user_config.five_hour_limit} --file '${user_config.quota_file}'`
  (single quotes: an unset option stays literal and double quotes would make
  bash fail on it; write an apostrophe inside a value as `'\''`). Do not pass `--running` or `--agent-cost`: without them it
  counts the agents running on the whole account and uses their learned cost,
  which several orchestrators need to share one room; they only override
  that. Follow its advice (speed up, normal, smooth out, no new
  agent, stop); details and the no-file case in
  `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/budget.md`.
- **Parallelism**: as many agents (`morty` or `rick`) as the advice allows,
  `morty` on distinct code zones and never two on the same `shared` resource
  of the profile (schema, local database…). A task that takes a shared resource
  reserves it in the state file. A `rick` touches no code: it runs beside a
  `morty`, preparing the next mission.
- **Design first**: an implementer who has to decide a business rule alone will
  decide it badly. A mission whose rules are settled and need one or two
  measurements: one `meeseeks` per measurement (launched together when
  independent), then write the rules in the notes. A mission with open rules
  or an investigation to run goes to a `rick`. Before launching a `rick` or a
  measurement `meeseeks`, read
  `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/design.md`.

## 2. Launch

```
Agent(subagent_type: "microverse:morty", model: "sonnet",
      isolation: "worktree", run_in_background: true,
      description: "<3-5 words>", prompt: <brief>)
Agent(subagent_type: "microverse:rick", model: "opus", run_in_background: true,
      description: "<3-5 words>",
      prompt: <mission, user's question, what is decided, notes file,
               user's language>)
Agent(subagent_type: "microverse:rick", model: "sonnet", run_in_background: true,
      description: "<3-5 words>", prompt: <as above; small mission only>)
Agent(subagent_type: "microverse:meeseeks", model: "haiku",
      description: "<3-5 words>", prompt: <one question, or up to 20 recipes
               and the new file for the results>)
Agent(subagent_type: "microverse:meeseeks", model: "sonnet",
      description: "<3-5 words>", prompt: <the mission, the new file for the
               code map>)
```

- The brief follows `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/brief.md`.
- Launch from the main repository root. With a remote, the worktree starts from
  `origin/HEAD`, not the local `HEAD`: the `morty` fast-forwards to `main`
  first; a brief based on another branch names it. On Windows a lowercase drive
  letter (`d:`) makes the worktree creation fail: `cd "D:/…"`.
- A `meeseeks` takes one question; several questions, several `meeseeks`. It does not
  count toward parallelism.

## 3. When the report arrives

Run the `bin` scripts (`agent-check`, `agent-cleanup`, `orch-*`) from the Bash
tool, never from PowerShell or cmd.exe.

1. `agent-check <branch>`: commits present, worktree clean, the profile's
   `checks`, diff patterns; it also reports conflicts with main and how far main
   moved: when it moved since the launch, rerun with `--merged` before merging.
   One run per branch at a time: wait for its result, never start a second
   (it refuses while the first holds the worktree), never pair
   `run_in_background` with a trailing `&`. A failure of a few lines goes back
   to the agent with `SendMessage` (context still warm) rather than being fixed
   by hand.
2. **Read the diff for real**, not the report, with
   `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/review.md`.
3. **Risky diff** (arithmetic on amounts or units, deduplication or storage
   keys, migrations, data deletion): `Agent(subagent_type: "microverse:council",
   model: "opus", prompt: <branch, brief, the morty's rule and test table,
   risky zones, the new file `notes/<mission>.review-<n>.md`>)`. It writes the
   full review there and returns the verdict, one line per defect and the path:
   read the file's section of a defect when you rule on it. The risky zones
   come from the `rick`'s notes when there are some. The fixes go back to the
   `morty`; `review.md` says how they are checked.
4. **Merge** without waiting for the user, who reviews afterwards:
   `git merge --no-ff <branch>` with the subject `merge: …`. The full check of
   the main branch (build included) runs once, before a deployment, with the
   commands of `orch-trust --commands checks`, never read from `profile.json`.
5. `agent-cleanup <branch>`: refuses while a process runs in the worktree or the
   branch is not merged.
6. **State file**: the mission's line, merged commit, released reservation,
   pending questions.
7. **Chain**: by default the series runs on its own (§ 7): after a merge, the
   next launchable mission starts without asking, after a fresh `orch-quota`.
   Between two reports, trace lines only (§ 6).

## 4. Series report

Written at every stop of the chain (no planned task left, quota threshold,
blocking question) and at every user request. Read
`${CLAUDE_PLUGIN_ROOT}/skills/orchestration/report.md` before writing it.

## 5. Compaction

The conversation is not switched: Claude Code compacts it automatically at
`${user_config.compact_window}` tokens (`/microverse:init` writes that value plus
33000 as `autoCompactWindow`, as Claude Code compacts about 33K below it).
Agents keep running and their reports still arrive.

- When the `context-guard` hook warns that compaction is near, update the state
  file before going on: mission table, decisions not yet in the notes, pending
  questions. No report is required.
- After a compaction, the `after-compact` hook tells you to load this skill
  again (its text may not survive the summary), then lists the agent worktrees
  and whether each is merged. Re-read the state file rather than trusting the
  summary.
- If the guard says `autoCompactWindow` seems unset, ask the user to run
  `/compact` (a slash command the model cannot run) and `/microverse:init`.

## 6. Talking to the user

The user reads every message the conversation shows. Nothing exists only in
the chat: what an agent found, a review's detail, the reason for a choice are
in the notes; questions are in the state file; decisions taken alone are in
the next report. A new conversation, which loads the state file, takes over
without the user rereading this one.

Two kinds of message, nothing else:

- **Trace**, between reports: one line per event, under 150 characters, no
  reasoning ("D1 merged (`abc1234`), D2 launched", "D2: council rejects,
  3 fixes sent back"). Write the detail in the mission's notes first. The
  user can skip every trace line without losing anything.
- **For the user**: the series report (§ 4) and questions. They open with `▶`
  and a title in the user's language, so the user finds them by scrolling.

**Audio report** (off by default). The user turns it on or off in any
words, but the state file line is written exactly `Audio report: on`, in
English whatever their language, with any voice or rate after it (`Audio report: on, voice fr-FR-DeniseNeural, rate +20%`),
and removed to turn it off; a line saying it is on in other words is rewritten
in this form. The `audio-guard` hook reads it. While it is on, each message for the user, once
written, also goes as an mp3: a spoken text per
`${CLAUDE_PLUGIN_ROOT}/skills/orchestration/audio.md`, then

```
orch-speak --voice '${user_config.speak_voice}' --rate '${user_config.speak_rate}' --pitch '${user_config.speak_pitch}' --volume '${user_config.speak_volume}' <<'EOF'
<spoken text>
EOF
```

(same quoting rule for an apostrophe in a value), and `SendUserFile` with the path it prints. Off: no spoken text, no call.

Each question is answered without having read the conversation:

- a number (Q1, Q2…), kept in the state file and the notes;
- the context in one or two lines: what it is about, why it comes up now;
- the options, and what each changes for the user;
- the recommendation and its reason;
- what waits on the answer (a brief, a deployment).

The user can then answer "Q1 as recommended, Q2 b". A `rick`'s questions are
rewritten in this form, not relayed as it wrote them.

A question that blocks a launch is asked at once only when nothing else can be
launched; otherwise it waits, numbered, in the state file and is asked in the
series report. Numbers stay stable across conversations: a new question takes
the next number after the highest in the state file and the notes, an answered
number is never reused.

### What remains to ask

Pushing, deploying, any write on a production machine. Build and tests do not
prove a screen renders: after a deployment that touches the interface, ask the
user to open the screens.

The state file holds **a single list** of what is asked of the user, one line
per question (number, the question in a few words, the notes section with its
options):

- **verify yourself first** everything that can be (database, logs, local
  rendering, `git`), through a `meeseeks` if needed; ask only what requires the
  user: a screen, an action in the application, a decision;
- **a request counts as done once made**: it leaves the list when the report is
  delivered; only questions awaiting an answer stay;
- **then verify the effect** of the requested actions when it can be read, and
  say so in the next report; an action a mission depends on is verified before
  launching it.

## 7. Running a series

The series runs on its own as long as nothing blocks it. When it starts, write
its goal in the state file (one line: what the user wants at the end). After
each merge the next launchable mission starts without asking: planned missions
first, then missions generated from defects (below). The series stops only
when nothing is launchable, on the quota advice, or on the user's stop request
(§ 8); it then ends with the series report (§ 4), which asks the questions that
waited.

Read `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/series.md` before turning a
defect met in a review, a report or a measurement into a mission.

## 8. Stopping and resuming

Read `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/stop-resume.md` when the user
announces, in any words, that they will stop soon, or when a new conversation
starts and the `SessionStart` hook lists unmerged agent worktrees. It covers the
stop procedure, the "Resume" section of the state file and the resuming of
interrupted missions.
