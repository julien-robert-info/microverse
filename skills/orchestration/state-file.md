# State file contract

The Board and `orch-status` read `CLAUDE.local.md` at the project root. They
match fixed English tokens, whatever language the user writes in; free text
(titles, the state sentence) stays in the user's language. Read this before
creating or restructuring the state file, and keep the tokens below exactly.

## Skeleton

```markdown
## Missions

| Id | Branch | State |
| --- | --- | --- |

## Questions

## Resume
```

## Missions

- Heading `## Missions`; header row `| Id | Branch | State |`.
- First cell: the Id alone, letters then digits (`M1`), or a range (`M1-M3`).
  Never a title there: `M1 Feed schema` is not read as a mission. Put the title
  in the state cell.
- Second cell: the branch in backticks, starting with `feat/`, `fix/`, `docs/`,
  `chore/`, `refactor/`, `test/` or `perf/`. Any other branch is shown but not
  linked.
- State cell: a sentence, and the merged commit as a backticked hash of 7 to 40
  hex characters.
- Optional: `NOTES § N` in the row links it to the `## N.` heading of
  `NOTES.local.md`; without such headings it links nothing.
- A mission's notes file is `notes/<Id>.md` or `notes/<Id>.review-<n>.md`; any
  other name is not attached to the mission.

Example row, added under the header (never part of the skeleton):

```text
| M1 | `feat/example` | merged `abc1234` |
```

## Questions

- Exactly one `## Questions` heading. It must be the first heading of the file
  whose text contains "question": a line such as `Pending questions:` without
  a heading is ignored.
- The section holds only bullets, ended by the next heading:
  `- Q<n> (notes/<file>.md) : <title>`. The file is read through the path in the
  bullet. `Pending:` may prefix a pending bullet.
- An answered question moves to one bullet starting with `Answered`:
  `- Answered: Q1 a, Q2 b (2026-01-01)`.
- The block format of a question in the notes file is in
  `agents/rick.md` of the plugin.

## Resume

The `## Resume` heading holds free text to restart from. `orch-status` shows the
sections whose title starts with missions, questions, resume or reprise. Keep
the whole state file under 60 lines: `context-guard` warns past that.
