# Traces

With the `trace_dir` option set, hooks record agent launches, stops and merges, and `agent-check` records checks, as JSON files, at no token cost. Empty: nothing is recorded and the hooks exit at once without reading anything.

## Layout

```
<trace_dir>/errors.log                      one JSON line {at, script, message} per hook error
<trace_dir>/<slug>/<session>/               <slug>: folder name of the project in ~/.claude/projects
    launch-<stamp>-<toolUseId>.json
    stop-<stamp>-<agentId>.json
    brief/<toolUseId>.md                    the brief, as sent
    notes/<toolUseId>/<rel>                 the cited notes, as at launch
    merge-<stamp>-<mergeSha 12>.json
    reviews/<mergeSha>/<name>               the council's reviews of the merged mission
<trace_dir>/<projectSlug>/checks/<id>/      <projectSlug>: of the root of the main repository
    check.json
    <name>.log                              complete output of one check
```

`<stamp>` is `AAAAMMJJTHHMMSSmmmZ` (UTC). An id the hook input does not carry is replaced by 8 random hexadecimal characters. Each record is written to `<name>.tmp` in its folder then renamed, never appended to a shared file: hooks run in parallel and two launches never touch the same file. A stop arriving again for the same agent (resumed by `SendMessage`) gives one more record.

## Format v:1

A field the hook could not learn is `null`, never absent.

```
launch : {v:1, kind:"launch", at, session, toolUseId, cwd,
          repo:{top, branch, head, dirty},
          agent:{type, model, background, description},
          brief:{file:"brief/<toolUseId>.md", sha256, chars},
          notes:[{rel, sha256, copied, reason}],          // copiées dans notes/<toolUseId>/<rel>
          config:{plugin:{name, version, commit}, rtk:{version}, hooks:[{event, matcher, program}],
                  userSettingsSha, projectSettingsSha, profileSha}}
stop   : {v:1, kind:"stop", at, session, agentId, toolUseId, worktree, branch, base, head, commits:[sha], dirty}
check  : {v:1, kind:"check", at, repoTop, branch, head, merged, verdict, checks:[{name, state, ms, log}]}
         // sous <trace_dir>/<projectSlug(racine du dépôt principal)>/checks/<id>/, log = <nom>.log à côté
merge  : {v:1, kind:"merge", at, session, branch, mergeSha, parents:[sha, sha], sideCommits:[sha],
          mission, check, reviews:[{rel, sha256, file}]}  // check = <id> du check ; file = reviews/<mergeSha>/<nom>
```

### launch

- `toolUseId`: `tool_use_id` of the `PreToolUse` input; `null` when absent (the file name then carries a random id).
- `repo`: `git rev-parse` of `cwd`; `dirty` from `git --no-optional-locks status --porcelain`. All `null` outside a repository.
- `notes`: every `notes/<path>.md` cited in the brief, once each, relative to `repo.top`. `copied:false` with `reason`: `absent` (no such file), `outside` (the path climbs with `..` or leaves the repository) or `too-big` (past 2 MB cumulated).
- `config.plugin`: name and version of the plugin manifest, `commit` from `git rev-parse HEAD` of the plugin folder. `rtk.version`: first line of `rtk --version`.
- `config.hooks`: event, matcher and the **program name alone** (first word of the command; for `node`, the script name) of the hooks in `~/.claude/settings.json` and in the project's `.claude/settings.json` and `.claude/settings.local.json`. No argument, no environment variable, no other setting is copied.
- `userSettingsSha`, `projectSettingsSha` (`.claude/settings.json`), `profileSha` (`.claude/orchestration/profile.json`): sha256 of the file, `null` when absent.

A launch refused by a guard that runs before the hook is still recorded: it is an orphan launch, with no matching `stop`.

### stop

- `toolUseId`: read from the sub-agent's `.meta.json`, beside `agent_transcript_path` (else `<session folder>/subagents/agent-<agentId>.meta.json`); it joins the stop to its launch.
- `worktree`, `branch`, `head`, `commits`, `dirty`: those of `.claude/worktrees/agent-<agentId>`; all `null` for an agent without a worktree.
- `base`: `repo.head` of the launch with the same `toolUseId`, else `git merge-base HEAD main`. `commits` = `git rev-list base..HEAD`.

### check

Written by `agent-check <branch>` with `--trace-dir <dir>`, else with the option (same order as `--mode` then `quota_mode` in `orch-quota`), once its controls are done; nothing changes in its output, verdict or exit code. A run that stops before the controls (usage, unapproved profile, unknown branch, lock held) records nothing.

- `<id>` = `<stamp>-<first 12 characters of head>`; `head` is the tip of `<branch>`, `repoTop` the repository root `agent-check` ran in, `merged` whether the checks ran on the merge of the base (`--merged`), `verdict` `green` or `needs-fixes`.
- `checks`: every control of the `--json` output, in order, with its `name` (`profile:<name>` for the profile's checks), `state` (`ok`, `fail`, `skip`), `ms` (duration of a profile check that ran, else `null`) and `log`.
- `log`: `<name>.log` beside `check.json` (characters outside `[\w.-]` replaced by `_`, `-2`, `-3` added on a name collision), the complete standard output then, after a `[stderr]` line, the standard error of a check that ran; `null` for a control that did not run a command. A log is cut at 5 MB with a last line `[truncated at 5 MB]`. Logs may hold local paths: they stay in `trace_dir`.
- The logs are written first and `check.json` last: a `check.json` always has its logs.

### merge

Written by the `trace-merge` hook (`PostToolUse`, `Bash|PowerShell`).

- Detected when the command has `git` then `merge` as a word (global options such as `-C <path>` skipped; not `merge-base`, not `--abort` or `--quit`), and, in the repository of `cwd` (or of `git -C`), `HEAD` has two parents and a subject starting with `merge:`. The final state of the repository decides, not the exit code: a command chaining `git merge …; git branch -d …` is recorded, a conflicted merge (one parent) is not. `agent-check --merged` is not a `git merge` command and never matches.
- One record per `mergeSha` in the session folder: a merge seen again writes nothing.
- `mergeSha` = `HEAD`, `parents` = its two parents, `sideCommits` = `git rev-list HEAD^1..HEAD^2`, `branch` = last argument of the command that is neither an option, an option's value nor a redirection (`2>&1`, `> file`) (else `null`), `mission` = last `(<id>)` of the subject (else `null`).
- `check`: `<id>` of the latest `check` of the project whose `head` is `HEAD^2`, else `null`.
- `reviews`: each `notes/<mission>.review*.md` of the repository root, copied to `reviews/<mergeSha>/<name>` with its sha256; `[]` when the mission is unknown or has none.

## Guarantees

Nothing is written to the standard output or error, the exit code is 0 whatever happens, the hook timeout is 5 s (10 s for `trace-merge`) and each `git` or `rtk` call is cut at 2 s. Git is used read-only. Nothing is written in `~/.claude` or in a repository. A failure is one line in `errors.log`, without the hook input.
