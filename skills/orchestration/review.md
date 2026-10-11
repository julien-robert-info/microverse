# Reviewing an agent's diff

After `agent-check` (which covers commits, clean worktree, the profile's checks
and mechanical patterns), read `git diff main...<branch>` against the brief. The
agent's report says what it believes it did; the diff says what it did.

## What has slipped past reviews before

- **The work exists**: an agent has launched another agent instead of coding,
  then returned a "delegated, in progress" report.
- **Colliding keys**: a storage or deduplication key that is not unique on real
  data loses rows without a word.
- **Silent fallback**: a failing source or a missing value that becomes zero, a
  default or a cache, instead of a `null`, an incompleteness flag or an error.
- **Decision taken in the user's place**: a value proposed by default (tag,
  category) where the user must choose.
- **Blind test**: a test that feeds the same case to both sides of a comparison
  cannot see the defect it exists to catch (same symbols, same units, same
  amounts on both sides).
- **Comments**: a useful comment lost in a move; a comment that tells the
  history, the process or a measurement.
- **Computation in the wrong place**: a screen that recomputes at render time
  what an upstream step stored.
- **Out of zone**: files changed outside the brief's zone, a shared resource
  touched without a reservation.
- **Personal data**: a real identifier, address or amount in code, tests or
  commits.
- **Scope**: a brief rule half applied, an excluded case handled anyway, an
  expected case without a test.

## When to hand over to rick

Arithmetic on amounts or units, deduplication or storage keys, migrations, data
deletion or rewriting, concurrency: the diff goes to `rick` (Opus) with the
branch, the brief and the risky zones. It returns ranked defects with file:line
and the scenario that breaks; rule on each (fix through the agent, accept, note)
before merging.
