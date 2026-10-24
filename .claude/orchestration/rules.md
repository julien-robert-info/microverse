# Rules for agents working on microverse

- The repository is a Claude Code plugin. The main working tree is installed
  in place: whatever is merged on `main` loads in every new conversation of the
  user. Work only in your worktree.
- Scripts are CommonJS Node 20, `"use strict"`, no dependency outside the
  standard library (`node:` modules). Shared helpers live in
  `scripts/orch-lib.js`; reuse them rather than duplicating.
- A new command in `bin/` gets a shebang `#!/usr/bin/env node`, a usage comment
  at the top like its siblings.
- Tests: `node:test` in `tests/`, on throwaway repositories and files built by
  `tests/helpers.js` (`makeRepo`), never on the user's real transcripts, quota
  file or `~/.claude`. Fixtures use synthetic values.
- Run the `bin/` scripts from the Bash tool, never from PowerShell or cmd.exe
  with a branch name or other text taken from the repository.
- Never write to `~/.claude` (settings, plugins, projects), never run
  `claude plugin install|uninstall|configure`, never push.
- Variables `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
  `${user_config.KEY}` are substituted in skill and agent bodies only; Bash
  commands do not see them: pass them as arguments. Hooks receive them in the
  environment (`CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_OPTION_<KEY>`).
- Skills, agents and README are in English. A skill's body is loaded into
  every conversation that uses it: keep `SKILL.md` short, put detail in the
  side files it points to.
- Any user-visible change (new command, option, profile key, hook) updates
  `README.md` (contents table, configuration, usage) and `CHANGELOG.md`
  (section `Unreleased`).
- The plugin must keep working on Windows, macOS and Linux: paths with
  `path.join`, no shell-specific syntax in spawned commands, and tests that
  pass on both CI systems.
- `claude plugin validate --strict .` runs in CI; when you change a manifest,
  `hooks/hooks.json`, a frontmatter or `settings.json`, check the field names
  against code.claude.com/docs/en/plugins-reference.

## Releasing

Run by the orchestrator, never by an agent, at the end of a series when
`## Unreleased` of `CHANGELOG.md` is not empty.

1. Pick the version (0.x): a new feature raises the minor, fixes only raise the
   patch.
2. Move the `Unreleased` entries under `## [x.y.z] - YYYY-MM-DD` and leave an
   empty `## Unreleased` on top.
3. Set `version` in `.claude-plugin/plugin.json` to `x.y.z`.
4. `npm test` with a temporary `HOME` and `USERPROFILE`; after the commit,
   `claude plugin validate --strict .` run in an export of it (`git archive HEAD`
   into a temporary folder): an unversioned `CLAUDE.local.md` at the root of the
   working tree is a warning.
5. Commit `chore(release): vX.Y.Z`, then tag it: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
6. Push the commit and the tag.
7. Publish the release: `gh release create vX.Y.Z --title vX.Y.Z --notes-file <file holding the version's CHANGELOG section> --verify-tag`.
