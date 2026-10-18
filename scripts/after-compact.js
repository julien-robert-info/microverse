// SessionStart hook (sources "compact", "startup", "resume", "clear"): in a
// project with an orchestration profile, every conversation is told first to
// load the orchestration skill. Then it restores the orientation that a
// compaction or a new conversation lost: where the state lives and which agent
// worktrees exist, merged or not. On startup, clear and resume each row also
// gives the last commit and whether uncommitted changes remain, to resume an
// interrupted agent; with no agent worktree (or if listing them fails) only the
// skill instruction and the transcript path are given. Silent without a profile
// and on bad input.
//
// A worktree counts as merged when its HEAD is an ancestor of the main
// worktree's HEAD. Paths are compared in a normal form (forward slashes, lower
// case) because git and the environment disagree on drive-letter case and
// separators on Windows.
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { git } = require("./orch-lib.js");

const HEADER =
  "Conversation compacted: CLAUDE.local.md is reloaded and is the state of reference; agents still running keep reporting here; continue with the orchestration skill.";

// First line of every output. The skill is loaded by the model, not inlined
// here: its text exceeds the hook output cap and its ${user_config.*}
// placeholders are only expanded when the Skill tool loads it.
const LOAD_SKILL =
  "This project is orchestrated with microverse: before replying, call the Skill tool with `microverse:orchestration`, unless its text is already in this conversation.";

const STARTED =
  "New conversation: CLAUDE.local.md holds the state of the orchestration. No agent runs in this conversation; a worktree below that is not merged belongs to an interrupted run. Resume it as the orchestration skill says (Stopping and resuming).";

const OPENING = {
  startup: STARTED,
  clear: STARTED,
  resume:
    "Conversation resumed: CLAUDE.local.md holds the state of the orchestration. Agents launched before the interruption may have finished or been cut off; check each worktree below before relaunching anything (orchestration skill, Stopping and resuming).",
};

const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// Worktrees of `cwd`'s repository as { path, head, branch }, main one first.
function listWorktrees(cwd) {
  const r = git(["worktree", "list", "--porcelain"], cwd);
  if (r.code !== 0) return [];
  return r.out
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const wt = {};
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) wt.path = line.slice(9);
        else if (line.startsWith("HEAD ")) wt.head = line.slice(5);
        else if (line.startsWith("branch ")) wt.branch = line.slice(7).replace(/^refs\/heads\//, "");
      }
      return wt;
    })
    .filter((wt) => wt.path && wt.head);
}

function main() {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const source = payload.source;
  if (source !== "compact" && !Object.hasOwn(OPENING, source)) return;
  const detailed = source !== "compact";
  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd;
  if (!projectDir || !existsSync(join(projectDir, ".claude", "orchestration", "profile.json"))) return;

  // The orchestrator cannot otherwise know its own transcript, which the next
  // conversation searches when the user refers to something said here.
  const transcript = typeof payload.transcript_path === "string" && payload.transcript_path ? `Transcript of this conversation: ${payload.transcript_path}` : null;
  const orientation = detailed ? OPENING[source] : HEADER;
  const lines = [LOAD_SKILL, orientation];
  try {
    const all = listWorktrees(projectDir);
    const prefix = `${norm(projectDir)}/.claude/worktrees/`;
    const projectLen = norm(projectDir).length;
    const rows = [];
    for (const wt of all.slice(1)) {
      if (!norm(wt.path).startsWith(prefix)) continue;
      const merged = git(["merge-base", "--is-ancestor", wt.head, all[0].head], all[0].path).code === 0;
      const rel = wt.path.replace(/\\/g, "/").slice(projectLen + 1);
      let row = `- ${wt.branch ?? "(detached)"} (${rel}): ${merged ? "merged" : "not merged"}`;
      if (detailed) {
        const last = git(["log", "-1", "--format=%h %s"], wt.path).out.trim();
        const dirty = git(["status", "--porcelain"], wt.path).out.trim() !== "";
        row += `, last commit ${last || "unknown"}, ${dirty ? "UNCOMMITTED CHANGES" : "no uncommitted changes"}`;
      }
      rows.push(row);
    }
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
