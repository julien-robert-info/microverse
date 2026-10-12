// SessionStart hook (matcher "compact"): after Claude Code compacts the
// orchestrating conversation, restores the orientation the summary may have
// lost: where the state lives and which agent worktrees exist, merged or not.
// Active only in a project with an orchestration profile; silent on any error.
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
  if (payload.source !== "compact") return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd;
  if (!projectDir || !existsSync(join(projectDir, ".claude", "orchestration", "profile.json"))) return;

  const lines = [HEADER];
  try {
    const all = listWorktrees(projectDir);
    const prefix = `${norm(projectDir)}/.claude/worktrees/`;
    const projectLen = norm(projectDir).length;
    const rows = [];
    for (const wt of all.slice(1)) {
      if (!norm(wt.path).startsWith(prefix)) continue;
      const merged = git(["merge-base", "--is-ancestor", wt.head, all[0].head], all[0].path).code === 0;
      const rel = wt.path.replace(/\\/g, "/").slice(projectLen + 1);
      rows.push(`- ${wt.branch ?? "(detached)"} (${rel}): ${merged ? "merged" : "not merged"}`);
    }
    if (rows.length) lines.push("Agent worktrees:", ...rows);
  } catch {}

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }));
}

try {
  main();
} catch {}
process.exit(0);
