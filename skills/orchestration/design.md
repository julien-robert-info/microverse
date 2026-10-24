# Designing a mission with a rick

A mission with open rules or an investigation to run goes to a `rick`,
in two phases chained by the orchestrator (a `rick` cannot launch agents), so the Opus context stays
small:

1. a `meeseeks` (sonnet) writes the code map to the new file
   `notes/<mission>.map.md`: entry points, functions with file:line, data
   flow, tables, existing tests, about 150 lines at most;
2. the `rick` reads the map first, the code only where the map points or
   falls short, and writes each measurement it needs as an exact recipe in
   its notes (command or query, where and how to run it, the project skill
   holding the recipe, expected output shape, what each outcome would
   decide). It returns "measurements requested" and stops. A measurement
   whose next step depends on its result it runs itself;
3. one `meeseeks` (haiku) per batch of at most 20 recipes runs them
   literally and writes the results to the new file
   `notes/<mission>.measures.md`; a recipe that fails or returns an
   unexpected shape is reported as such, never rewritten;
4. resume the same `rick` with `SendMessage` (context and cache still warm):
   it settles the rules, writes the draft brief in `notes/<mission>.md` and
   returns the questions for the user. At most two measurement rounds, then
   the `rick` runs what remains itself.

The `rick` has no worktree, so the `after-compact` hook does not list it:
the mission gets a line "design in progress (rick)" in the state file at
launch. Add its notes file to the `NOTES.local.md` index yourself, put its
questions in the state file's list, and launch its briefs once the questions
they depend on are answered.
