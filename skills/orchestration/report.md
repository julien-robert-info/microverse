# Series report

It covers
everything since the previous one, whose commit is noted in the state file.
Start from `orch-report --since <last report commit>` (same quota options as
§ 1): it prints the merges, the agent runs and their cost, the quota and the
context size. Write on top of it the decisions, requests, open points and next
steps.

The report is short by its wording, not by leaving things out: one line per
item, no restating of the brief or the diff. Nothing is dropped: an item that
does not appear in full is written in the mission's notes before the report,
and the report counts it and points to its section. Aim at 15 to 20 lines; a
longer series takes more lines rather than losing an item. It opens with the
`▶` marker (§ 6). In this order:

1. **Merged**: one line per task, what changes for the user, with the commit,
   and the `council` verdict with the fixes it led to when there was a review.
2. **Incidents**: agent failures and retries, rejected reviews, anything
   reverted or abandoned, one line each with its consequence. Left out when
   there is none.
3. **To confirm**: business decisions taken alone, each with the rule, the
   alternative dropped and why. Technical choices taken alone (tolerances,
   tests, `agent-check` false positives) are written in the notes and take one
   line here: how many, where.
4. **Requests to the user** (§ 6): what was verified since the previous
   report, then what only they can do, questions in the § 6 form.
5. **Open points**: defects found and not fixed, surprising measurements. In
   full, the ones that change a decision or that the user will meet; the others
   counted, with their notes section.
6. **Next**: task in progress or next, what awaits a decision, and as **a single
   question**: deploy and push what has been merged since the last deployment.
   The deployment steps (migrations, restarts) come once the user says yes.
7. **Quota and context**, on one line: `orch-quota`, the series' agent cost
   from `orch-report` and `orch-usage --context`, summarized.

An explanation stays when the user needs it to decide or to understand what
changed for them. For example:

```
▶ Report
Merged
- D1 fees per position (abc1234): the screen shows fees net of rebates.
- D2 CSV import (def5678): duplicates are skipped, counted in the summary.
  council: approved with fixes (rounding of the totals, fixed in def5678).

Incidents
- D2: first run failed on the migration number, relaunched on 0042.

To confirm
- Positions opened before the import start at zero, not at their last known
  value: the source gives no earlier balance.
- Technical choices: 2 in notes/import.md § Decided rules.

Open points
- 3 rows of the sample have no date: left out, listed in notes/import.md.
- +2 minor, notes/import.md § Open points.

Next
- D3 launched (alerts). Deploy and push D1 and D2?

Quota 5h 40 %, week 52 % (normal) · agents $4.20 · context 90K
```

Then note the new "Last report" in the state file.
