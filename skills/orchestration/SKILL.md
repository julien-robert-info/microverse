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
| orchestrating conversation | Sonnet, Opus as advisor | design, launch, review, merge, report |
| `microverse:morty` | Sonnet | implements a brief in its worktree |
| `microverse:meeseeks` | Haiku | reads and summarizes: one question, facts with their evidence |
| `microverse:rick` | Opus | reviews a risky diff, fixes nothing |

- The model comes from the project's settings (`/microverse:init`). Changing it
  inside a conversation rewrites the whole cache: don't. A long design session
  the user wants on Opus is their choice at opening.
- **Consult the advisor** (say "consult the advisor") before writing a brief,
  before ruling on a `rick` review, before a design decision recorded as "to
  confirm", and when an agent fails twice on the same thing. Not for routine
  steps (launch, `agent-check`, merge, cleanup, state file).
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
- **Parallelism**: two `morty` at once only on the "speed up" advice, on
  distinct code zones, and never two on the same `shared` resource of the
  profile (schema, local database…). A task that takes a shared resource
  reserves it in the state file.
- **Design first**: measure on real data what the task will meet, one
  `meeseeks` per measurement (launched together when independent), settle the
  rules (consult the advisor on them), write them in the notes. An implementer
  who has to decide a business rule alone will decide it badly. An open
  investigation, with no single question to ask, goes to a `general-purpose`
  agent with `model: "opus"`.

## 2. Launch

```
Agent(subagent_type: "microverse:morty", model: "sonnet",
      isolation: "worktree", run_in_background: true,
      description: "<3-5 words>", prompt: <brief>)
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
   A failure of a few lines goes back to the agent with
   `SendMessage` (context still warm) rather than being fixed by hand.
2. **Read the diff for real**, not the report, with
   `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/review.md`.
3. **Risky diff** (arithmetic on amounts or units, deduplication or storage
   keys, migrations, data deletion): `Agent(subagent_type: "microverse:rick",
   model: "opus", prompt: <branch, brief, risky zones>)`, then rule on its
   remarks.
4. **Merge** without waiting for the user, who reviews afterwards:
   `git merge --no-ff <branch>` with the subject `merge: …`. The full check of
   the main branch (build included) runs once, before a deployment.
5. `agent-cleanup <branch>`: refuses while a process runs in the worktree or the
   branch is not merged.
6. **State file**: the chantier's line, merged commit, released reservation,
   pending questions.
7. **Chain**: a task already planned launches as soon as the previous one is
   merged, without asking, after a fresh `orch-quota`. Between two reports, one
   line per event ("D1 merged (`abc1234`), D2 launched").

## 4. Series report

Written at every stop of the chain (no planned task left, quota threshold,
blocking question) and at every user request. It covers
everything since the previous one, whose commit is noted in the state file.
Start from `orch-report --since <last report commit>` (same quota options as
§ 1): it prints the merges, the agent runs and their cost, the quota and the
context size. Write on top of it the decisions, requests, open points and next
steps. The report stands on its own, in this order:

1. **Merged**: per task, what changes for the user, with the commit.
2. **Decisions taken alone**, to confirm: the rule, the alternative dropped,
   why.
3. **Requests to the user** (§ 6): what was verified since the previous
   report, then what only they can do.
4. **Open points**: defects found and not fixed, surprising measurements.
5. **Next**: task in progress or next, what awaits a decision, and as **a single
   question**: deploy and push what has been merged since the last deployment.
6. **Quota**: the summarized output of `orch-quota`.
7. **Context**: `orch-usage --context`, for information.

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
