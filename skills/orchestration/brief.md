# A morty's brief

The agent starts with no context. What holds for every task (worktree setup,
conventions, generic traps, checks, report format) is in its definition; what
holds for every task of the project is in `.claude/orchestration/rules.md` and
`profile.json`, which it reads first. Do not copy it: write only what is
specific to the task.

1. **Branch** (`<type>/<subject>`) and **shared resources**: "you own the
   schema, migration `00NN`" or nothing (the agent does not touch them).
2. **Goal**: the user's question the task serves, in one sentence.
3. **Zone**: folders and files the agent owns; what it reads first, with
   functions or lines.
4. **Decided rules**, numbered R1, R2…, to apply as they stand: definitions,
   thresholds, priority orders, signs, excluded cases. Say what is **not** in
   scope.
5. **Storage** and **interface**: tables and columns, screens, labels,
   pagination, filters.
6. **Along the way**: small neighbouring fixes expected.
7. **Traps specific to the task**, in addition to those of the definition and
   of `rules.md`.
8. **Expected tests**, numbered T1, T2…: the list of cases, including mixed cases (two
   different sides) and negative cases. For a bug fix: a test that fails before
   the fix.
9. **Verification on real data**: how to rerun the step, expected figures,
   precise questions the report must answer.

**Size.** An agent's cost grows faster than its length, since each request
re-reads the whole context. Aim at a `morty` run of about 60 tool calls. A
mission with more than about six rules, or spanning several layers (storage,
computation, screen), is split into chained briefs, each merged before the
next one starts.

A brief that leaves a business rule open is not ready: settle it first, or hand
the mission to a `rick`. A brief drafted by a `rick` is taken from its notes
file as it stands, once the user has answered its questions.
