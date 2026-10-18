# Consumption pacing

Read before launching an agent or resuming one.

## The counters

`orch-quota` reads the two counters, `five-hour` and `seven-day`, from two
sources: the VS Code extension "Claude Code Usage" (growthjack), and the
readings the microverse status line writes in terminal sessions. For each
counter it takes the latest window not yet reset and, in it, the highest value
(a counter does not fall within a window, and an idle session may rewrite an old
value late); the `Counters:` line gives the source and age of each. If neither
source has a reading, or the newest is more than two hours old, ask the user for
both counters (`5h x% | wk y%`) at the next opportunity, without blocking, and
apply the same rules by hand.

## The periods

The weekly window starts at `resetAt` − 7 days (at the end of a week). It splits
into two periods:

- **weekend**: from the window start to Sunday 24:00, local time; consumption
  may rise to C − R %, where C is the end-of-week target (`week_target`) and R
  the weekday reserve (`weekday_reserve`);
- **weekdays**: from Monday 00:00 to the reset; weekday evenings share the
  remaining R points up to C. Anything above C is kept for end-of-week
  questions.

In each period, the pacing line goes from the consumption at the start of the
period to its target, linearly in time. `orch-quota` compares the weekly counter
with that line.

## The advice

In order, the first that applies:

| Situation | Advice |
|---|---|
| weekly ≥ C | **stop**: no more resuming agents; update the state, keep the rest for questions |
| weekly ≥ C − 3 | **no new agent**: finish, review and merge the running ones (a launched agent still costs a few points) |
| 5h ≥ `five_hour_limit` + 5 | no more resuming until the 5h counter resets |
| 5h ≥ `five_hour_limit` | no new agent until the 5h counter resets |
| more than 5 points above the line, or target reached | **smooth out**: no new agent until the counter drops back under the line |
| the room left under `five_hour_limit`, minus 15 points per running agent, is under 15 | no new agent until the 5h counter resets |
| more than 10 points below the line | **speed up**: up to 3 agents at once |
| otherwise | **normal**: up to 2 agents at once |

Both counts shrink to what the 5h room can pay for: one agent (a `morty` with
its `council` review, or a `rick`) may use about 15 points of the 5h counter,
and the agents already running keep their share. `--running` gives their
number, `--agent-cost` replaces the 15; both are overrides, the Budget command
passes neither. Without them, `orch-quota` counts the
agents running on the whole account (subagent transcripts written in the last
10 minutes, in every project, `meeseeks` left out) so that orchestrators of
several projects share one room, and learns the cost of an agent from the
past runs (ratio of 5h points per dollar times the median cost of a `rick`,
or of a `morty` plus its `council`). The calibration is kept in
`calibration.json` (plugin data folder), recomputed after 6 hours or with
`orch-quota --calibrate`, and a ratio that jumps by more than x2 in two days
is reported as a likely subscription change.

An agent here is a `morty` or a `rick`. Two `morty` work on distinct code
zones, never two on the same `shared` resource; a `rick` touches no code and
runs beside them. A `council` review takes the slot of the agent whose branch
it reviews; `meeseeks` agents do not count.

## Cost, to decide

- Most of the cost is the main conversation's context, re-read at every
  request: automatic compaction at the configured window keeps it bounded.
- A pause of more than an hour (waiting for an agent, night) expires the cache:
  the next request rewrites the whole context, at twice the input price.
- `orch-usage [--since <date>]` gives tokens and API-equivalent cost per model,
  conversations and agents apart; relate a mission's tokens to the weekly
  counter's variation during that mission.
