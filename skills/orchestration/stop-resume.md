# Stopping and resuming

## Stop on the user's word

Any message, in any language, meaning the user will stop soon (stop, I'm
leaving, pause, wrap up are examples):

1. launch nothing more;
2. `SendMessage` to each running `morty`: commit the work in progress now
   (`wip: <what>` on its branch, checks not required) and reply with what is
   done and what remains; to each `rick`: write its notes so far and the
   remaining steps. A `council` near its end finishes; otherwise it is rerun
   later;
3. write the state file: per mission its branch, last commit, next step and how
   to resume it, and a "Resume" section holding the open questions (number, a
   few words, notes section), the discussion in progress (what the user last
   asked, what awaits their answer) and the path of this conversation's
   transcript (the "Transcript of this conversation" line the `SessionStart`
   hook gave at the start);
4. last message: `▶` "Ready to shut down", with the questions.

## Unannounced shutdown

The state file is already written at every event (§ 6) and a `morty` commits
after each completed step, so at most one step is lost.

## New conversation

The `SessionStart` hook lists the agent worktrees (branch, last commit, merged
or not, uncommitted changes or not); it gives only the skill instruction and
the transcript path when there are none. Read the state file and its "Resume"
section, then for each mission left unmerged:

1. commit the leftover changes of its worktree, or put them in the notes;
2. free the branch: `agent-cleanup --keep-branch <branch>` removes the worktree
   only and refuses while changes are uncommitted;
3. launch a new `morty` whose brief says "resume branch X" (its Setup then
   checks the branch out and continues from `git log main..HEAD`).

A merged worktree is cleaned up as usual. A `rick` that was cut off is
relaunched from its notes.

## Answers and references

An answer such as "Q3 b" is resolved from the state file. Anything else the
user refers to that the state file and the notes do not hold is searched in the
previous transcript (path in "Resume") by a `meeseeks`, never by reading the
transcript in this context.
