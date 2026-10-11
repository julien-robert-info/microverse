# Consumption pacing

Read before launching an agent or resuming one.

## The counters

`orch-quota` reads the latest reading of the VS Code extension "Claude Code
Usage" (growthjack) for the two counters, `five-hour` and `seven-day`. If the
extension is not installed, or the reading is more than two hours old, ask the
user for both counters (`5h x% | wk y%`) at the next opportunity, without
blocking, and apply the same rules by hand.

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
| more than 10 points below the line | **speed up**: two `meeseeks` on distinct zones, only one on a shared resource |
| otherwise | **normal**: one `meeseeks` at a time |

`morty` agents do not count. A `rick` (Opus) counts as an agent: keep it for
risky diffs.

## Cost, to decide

- Most of the cost is the main conversation's context, re-read at every
  request: switching conversation around 150K tokens is cheaper than continuing.
- A pause of more than an hour (waiting for an agent, night) expires the cache:
  the next request rewrites the whole context, at twice the input price.
- `orch-usage [--since <date>]` gives tokens and API-equivalent cost per model,
  conversations and agents apart; relate a chantier's tokens to the weekly
  counter's variation during that chantier.
