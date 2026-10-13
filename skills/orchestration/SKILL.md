---
name: orchestration
description: Run a project as chantiers delegated to background agents, one task = one branch = one worktree — design, write the brief, launch the agent, review its diff, merge, clean up, keep the chantier board, write the series report. Use as soon as the user says "démarre X", "lance", "chantier suivant", "enchaîne", "on passe à …", "où en est-on", "rapport", when an agent's report arrives, before merging an agent's branch, when deciding whether a new agent may start (quota), or when the orchestrating conversation grows heavy.
---

# Orchestrating chantiers with agents

Write reports, questions and summaries in the language the user writes in.

The orchestrator is the user's only contact. It designs, delegates, reviews and
merges; the heavy work lives in the agents' contexts and the orchestrator keeps
only the decisions. State lives in files, so a new conversation resumes without
loss:

- **state file** (`CLAUDE.local.md`, unversioned, loaded in every
  conversation): "chantiers in progress" table, reserved shared resources
  (migration number…), what is deployed, last report, questions awaiting the
  user (§ 6);
- **notes** (read on demand): design of each chantier, measurements on real
  data, past decisions. One file per chantier, `notes/<chantier>.md`, and
  `NOTES.local.md` is only an index (one line per file). Read the index, then one
  section of one file, never a whole file. The state file stays short (the
  `context-guard` hook warns past 60 lines): history goes to the notes;
- **project profile** (`.claude/orchestration/profile.json` and `rules.md`,
  versioned): worktree setup, checks, servers, patterns to watch, shared
  resources, stack rules. Missing: run `/microverse:init` before the first
  chantier.

## Roles and models

| Who | Model | Does |
|---|---|---|
| orchestrating conversation | Sonnet, Opus as advisor | briefs, launch, review, merge, report |
| `microverse:rick` | Opus | designs a chantier: measures, settles the rules, drafts the brief in its notes file |
| `microverse:morty` | Sonnet | implements a brief in its worktree |
| `microverse:council` | Opus | reviews a risky diff and approves it or not, fixes nothing |
| `microverse:meeseeks` | Haiku | reads and summarizes: one question, facts with their evidence |

- The model comes from the project's settings (`/microverse:init`). Changing it
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

- **Budget**: `orch-quota --target ${user_config.week_target} --reserve ${user_config.weekday_reserve} --five-hour ${user_config.five_hour_limit} --file "${user_config.quota_file}"`.
  Follow its advice (speed up, normal, smooth out, no new agent, stop); details
  and the no-file case in `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/budget.md`.
- **Parallelism**: as many agents (`morty` or `rick`) as the advice allows,
  `morty` on distinct code zones and never two on the same `shared` resource
  of the profile (schema, local database…). A task that takes a shared resource
  reserves it in the state file. A `rick` touches no code: it runs beside a
  `morty`, preparing the next chantier.
- **Design first**: an implementer who has to decide a business rule alone will
  decide it badly. A chantier whose rules are settled and need one or two
  measurements: one `meeseeks` per measurement (launched together when
  independent), then write the rules in the notes. A chantier with open rules
  or an investigation to run goes to a `rick`: it measures, writes the rules
  and a draft brief in `notes/<chantier>.md`, and returns the questions for
  the user. It has no worktree, so the `after-compact` hook does not list it:
  the chantier gets a line "design in progress (rick)" in the state file at
  launch. Add its notes file to the `NOTES.local.md` index yourself, put its
  questions in the state file's list, and launch its briefs once the questions
  they depend on are answered.

## 2. Launch

```
Agent(subagent_type: "microverse:morty", model: "sonnet",
      isolation: "worktree", run_in_background: true,
      description: "<3-5 words>", prompt: <brief>)
Agent(subagent_type: "microverse:rick", model: "opus", run_in_background: true,
      description: "<3-5 words>",
      prompt: <chantier, user's question, what is decided, notes file>)
Agent(subagent_type: "microverse:meeseeks", model: "haiku",
      description: "<3-5 words>", prompt: <one question>)
```

- The brief follows `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/brief.md`.
- Launch from the main repository root. With a remote, the worktree starts from
  `origin/HEAD`, not the local `HEAD`: the `morty` fast-forwards to `main`
  first; a brief based on another branch names it. On Windows a lowercase drive
  letter (`d:`) makes the worktree creation fail: `cd "D:/…"`.
- A `meeseeks` takes one question; several questions, several `meeseeks`. It does not
  count toward parallelism.

## 3. When the report arrives

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
   model: "opus", prompt: <branch, brief, risky zones>)`, then rule on its
   remarks. The risky zones come from the `rick`'s notes when there are some.
4. **Merge** without waiting for the user, who reviews afterwards:
   `git merge --no-ff <branch>` with the subject `merge: …`. The full check of
   the main branch (build included) runs once, before a deployment.
5. `agent-cleanup <branch>`: refuses while a process runs in the worktree or the
   branch is not merged.
6. **State file**: the chantier's line, merged commit, released reservation,
   pending questions.
7. **Chain**: a task already planned launches as soon as the previous one is
   merged, without asking, after a fresh `orch-quota`. Between two reports, one
   line per event, under 150 characters ("D1 merged (`abc1234`), D2
   launched"). What an agent found goes to the notes, not to the chat.

## 4. Series report

Written at every stop of the chain (no planned task left, quota threshold,
blocking question) and at every user request. It covers
everything since the previous one, whose commit is noted in the state file.
Start from `orch-report --since <last report commit>` (same quota options as
§ 1): it prints the merges, the agent runs and their cost, the quota and the
context size. Write on top of it the decisions, requests, open points and next
steps.

The report is short by its wording, not by leaving things out: one line per
item, no restating of the brief or the diff. Nothing is dropped: an item that
does not appear in full is written in the chantier's notes before the report,
and the report counts it and points to its section. Aim at 15 to 20 lines; a
longer series takes more lines rather than losing an item. In this order:

1. **Merged**: one line per task, what changes for the user, with the commit,
   and the `council` verdict with the fixes it led to when there was a review.
2. **Incidents**: agent failures and retries, rejected reviews, anything
   reverted or abandoned, one line each with its consequence. Left out when
   there is none.
3. **To confirm**: business decisions taken alone, one line each with its why.
   Technical choices taken alone (tolerances, tests, `agent-check` false
   positives) are written in the notes and take one line here: how many, where.
4. **Requests to the user** (§ 6): what was verified since the previous
   report, then what only they can do.
5. **Open points**: in full, the ones that change a decision; the others
   counted, with their notes section.
6. **Next**: task in progress or next, what awaits a decision, and as **a single
   question**: deploy and push what has been merged since the last deployment.
   The deployment steps (migrations, restarts) come once the user says yes.
7. **Quota and context**, on one line: `orch-quota`, the series' agent cost
   from `orch-report` and `orch-usage --context`, summarized.

An explanation stays when the user needs it to decide or to understand what
changed for them. For example:

```
Merged
- D1 fees per position (abc1234): the screen shows fees net of rebates.
- D2 CSV import (def5678): duplicates are skipped, counted in the summary.
  council: approved with fixes (rounding of the totals, fixed in def5678).

Incidents
- D2: first run failed on the migration number, relaunched on 0042.

To confirm
- Positions opened before the import start at zero, not at their last value:
  the source gives no earlier balance.
- Technical choices: 2 in notes/import.md § Decided rules.

Open points
- 3 rows of the sample have no date: left out, listed in notes/import.md.
- +2 minor, notes/import.md § Open points.

Next
- D3 launched (alerts). Deploy and push D1 and D2?

Quota 5h 40 %, week 52 % (normal) · agents $4.20 · context 90K
```

Then note the new "Last report" in the state file.

## 5. Compaction

The conversation is not switched: Claude Code compacts it automatically at
`${user_config.compact_window}` tokens (`autoCompactWindow`, written by
`/microverse:init`). Agents keep running and their reports still arrive.

- When the `context-guard` hook warns that compaction is near, update the state
  file before going on: chantier table, decisions not yet in the notes, pending
  questions. No report is required.
- After a compaction, the `after-compact` hook lists the agent worktrees and
  whether each is merged. Re-read the state file rather than trusting the
  summary.
- If the guard says `autoCompactWindow` seems unset, ask the user to run
  `/compact` (a slash command the model cannot run) and `/microverse:init`.

## 6. What remains to ask

Pushing, deploying, any write on a production machine. Build and tests do not
prove a screen renders: after a deployment that touches the interface, ask the
user to open the screens.

The state file holds **a single list** of what is asked of the user:

- **verify yourself first** everything that can be (database, logs, local
  rendering, `git`), through a `meeseeks` if needed; ask only what requires the
  user: a screen, a gesture in the application, a decision;
- **a request counts as done once made**: it leaves the list when the report is
  delivered; only questions awaiting an answer stay;
- **then verify the effect** of the requested gestures when it can be read, and
  say so in the next report; a gesture a chantier depends on is verified before
  launching it.
