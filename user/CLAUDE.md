# Writing: README, comments, commit messages

Tell no story: not the user's, not mine, not the project's. Stick to the
conventions of open source projects.

- **README**: what the project does, requirements, installation, configuration,
  usage, deployment, architecture in brief. No decision log, no anecdotes, no
  figures measured on the user's data.
- **Comments**: the non-obvious technical *why*, in a few lines. No history
  ("before", "the first version", "it cost"), no date of a finding, no
  measurement on real data, no "we".
- **Commit messages**: Conventional Commits, a short subject and a brief body
  saying what changes and why. No account of the investigation, no figures
  taken from personal data.
- **Personal data**: never a wallet address, amount, name or real identifier of
  the user in code, tests or docs; synthetic values instead.

Everything else goes outside the repository, in two files at the project root,
both added to `.gitignore`, or in local memory:

- **`CLAUDE.local.md`**: the current context and the missions in progress,
  nothing else. It is loaded in every conversation, so it stays short.
- **`NOTES.local.md`**: the history of decisions, incidents and figures measured
  on the user's data. Read on demand, when a question concerns a figure, a data
  source or an incident.
