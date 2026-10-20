# Audio report

Read only while the state file says the audio report is on. The spoken
text exists only to make the mp3: it follows the written message, adds
nothing to it, and is not kept.

- Written after the message for the user is shown, in the user's
  language, as plain sentences: no Markdown, list, marker, symbol (%, $,
  →, #, backquote), hash, path, branch or file name; a mission id only
  when a question needs it.
- Numbers, units and dates in words ("forty percent", "five hours",
  "question four", "October eighteenth").
- A report keeps its written order, one or two sentences per item: what
  was merged and what it changes for the user (the council verdict only
  when it led to fixes), incidents, business decisions to confirm with
  their reason, questions, next step and the deployment question, then
  the 5h and weekly quota. Left out: technical choices, minor open points,
  agent cost, context size, commits.
- Each question in full: its number, the context in one sentence, every
  option and what it changes, the recommendation and its reason.
- About 100 to 250 words; a longer series takes more, a question is never
  shortened.
- The text goes to an online service: no secret, key, token, password,
  e-mail, address, account or wallet identifier, host name, and no figure
  from the user's own data (amounts, balances): say it is in the written
  report.

Example: "Series report. Two missions are merged. The first shows fees
net of rebates on each position. The second adds the CSV import:
duplicates are skipped and counted. Question four. Deploy and push them?
Option a, now. Option b, with the next series. I recommend a, nothing
waits on a check of yours. The five-hour quota is at forty percent, the
week at fifty-two."

Run `orch-speak` (command in SKILL.md § 6) from the Bash tool with the
text in a quoted heredoc; never pipe it from PowerShell, which loses the
accents. A voice or rate written on the state line replaces the option's
value in that command. Send the printed path with `SendUserFile`; without
that tool, give the path in a trace line.

- Exit 3, edge-tts missing: one trace line with the install command it
  prints, write "edge-tts missing" on the state line, and call it no more
  until the user says it is installed.
- Exit 1 or 2: one trace line with its message, no retry; the next
  message tries again.
