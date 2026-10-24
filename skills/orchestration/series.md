# Defects that become missions

A defect met in a review, a report or a measurement becomes a mission without
asking only if all of these hold:

- it needs no new business rule (otherwise it is a question, § 6);
- it serves the series' goal;
- its brief says in one line what it changes for the user;
- it was not found by a mission itself generated from a defect (depth 1: those
  go to the notes, or become questions);
- the zone it touches holds fewer than three decisions taken alone and not yet
  confirmed by the user;
- the quota allows it.

Cosmetic defects are grouped into one mission. Each generated mission gets a
trace line and a state-file line marked `auto`.

These guards prevent three drifts: a cascade where each fix uncovers the next
defect and the series never ends; decisions stacked on decisions the user has
not confirmed, so one wrong early choice spoils everything after it; and a
budget spent on marginal fixes while the goal waits.
