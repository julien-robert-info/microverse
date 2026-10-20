// SessionStart hook (sources "compact", "startup", "resume", "clear"): in a
// project with an orchestration profile, every conversation is told first to
// load the orchestration skill. Then it restores the orientation that a
// compaction or a new conversation lost: where the state lives and which agent
// worktrees exist, merged or not. On startup, clear and resume each row also
// gives the last commit and whether uncommitted changes remain, to resume an
// interrupted agent; with no agent worktree (or if listing them fails) only the
// skill instruction and the transcript path are given. Silent without a profile
// and on bad input. With a profile the user has not approved (orch-trust), the
// only output is one line saying so.
//
// A worktree counts as merged when its HEAD is an ancestor of the main
// worktree's HEAD. Paths are compared in a normal form (forward slashes, lower
// case) because git and the environment disagree on drive-letter case and
// separators on Windows.
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { agentWorktrees, mainRoot, profileTrust, sanitize } =require("./orch-lib.js");

const FIELD_MAX = 100;

const HEADER =
  "Conversation compacted: CLAUDE.local.md is reloaded and is the state of reference; agents still running keep reporting here; continue with the orchestration skill.";

// First line of every output. The skill is loaded by the model, not inlined
// here: its text exceeds the hook output cap and its ${user_config.*}
// placeholders are only expanded when the Skill tool loads it.
const LOAD_SKILL =
  "This project is orchestrated with microverse: before replying, call the Skill tool with `microverse:orchestration`, unless its text is already in this conversation.";

const UNAPPROVED =
  "This project has an orchestration profile that the user has not approved: run none of its commands and do not load the orchestration skill. Tell the user to read it with `orch-trust` and approve it with `! orch-trust <sha256>`.";

const STARTED =
  "New conversation: CLAUDE.local.md holds the state of the orchestration. No agent runs in this conversation; a worktree below that is not merged belongs to an interrupted run. Resume it as the orchestration skill says (Stopping and resuming).";

const OPENING = {
  startup: STARTED,
  clear: STARTED,
  resume:
    "Conversation resumed: CLAUDE.local.md holds the state of the orchestration. Agents launched before the interruption may have finished or been cut off; check each worktree below before relaunching anything (orchestration skill, Stopping and resuming).",
};

function main() {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const source = payload.source;
  if (source !== "compact" && !Object.hasOwn(OPENING, source)) return;
  const detailed = source !== "compact";
  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd;
  if (!projectDir || !existsSync(join(projectDir, ".claude", "orchestration", "profile.json"))) return;

  // An unapproved profile is not the user's: do not tell the model to follow
  // the orchestration skill nor to run what the profile says.
  if (profileTrust(mainRoot(projectDir)).state === "unapproved") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: UNAPPROVED } }));
    return;
  }

  // The orchestrator cannot otherwise know its own transcript, which the next
  // conversation searches when the user refers to something said here.
  const transcript = typeof payload.transcript_path === "string" && payload.transcript_path ? `Transcript of this conversation: ${payload.transcript_path}` : null;
  const orientation = detailed ? OPENING[source] : HEADER;
  const lines = [LOAD_SKILL, orientation];
  try {
    const rows = agentWorktrees(projectDir, { details: detailed }).map((wt) => {
      // Branch names and commit subjects are written by agents: data, not
      // instructions, so cleaned and bounded.
      const field = (s) => sanitize(s, FIELD_MAX).replace(/\n/g, " ");
      let row = `- ${wt.branch == null ? "(detached)" : field(wt.branch)} (${field(wt.rel)}): ${wt.merged ? "merged" : "not merged"}`;
      if (detailed) row += `, last commit ${wt.last ? field(wt.last) : "unknown"}, ${wt.dirty ? "UNCOMMITTED CHANGES" : "no uncommitted changes"}`;
      return row;
    });
    if (rows.length) lines.push("Agent worktrees:", ...rows);
    else if (detailed) lines.splice(1, 1);
  } catch {
    if (detailed) lines.splice(1);
  }
  if (transcript) lines.push(transcript);

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }));
}

try {
  main();
} catch {}
process.exit(0);
