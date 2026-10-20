// SubagentStop hook: stops the servers a background agent left running in its
// own worktree (.claude/worktrees/agent-<agent_id>). A forgotten server keeps a
// port busy and locks the worktree folder on Windows.
//
// Only processes whose command line contains both that worktree path and one
// of the `servers` patterns of the project profile are stopped: an agent can
// stop while its own tests or a long job still run, and those must survive.
// Patterns are plain substrings, compared case-insensitively with "\" as the
// path separator. Every run is logged in the plugin's data folder.
"use strict";

const { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { run, listProcesses, normPath, sanitize } = require("./orch-lib.js");

const dataDir = process.env.CLAUDE_PLUGIN_DATA || __dirname;
mkdirSync(dataDir, { recursive: true });
const logFile = join(dataDir, "stop-agent-servers.log");
const LOG_MAX = 64 * 1024;
const LOG_KEEP = 16 * 1024;
const log = (message) => {
  try {
    // Bounded: past the cap only the newest lines are kept.
    if (statSync(logFile).size > LOG_MAX) {
      const tail = readFileSync(logFile, "utf8").slice(-LOG_KEEP);
      writeFileSync(logFile, tail.slice(tail.indexOf("\n") + 1));
    }
  } catch {}
  appendFileSync(logFile, `${new Date().toISOString().slice(0, 19)} ${sanitize(message, 300).replace(/\n/g, " ")}\n`);
};

// Shells are never taken for a server: their command line can mention the
// worktree (this hook's caller, an agent's Bash) without serving anything.
const SHELLS = new Set(["bash", "sh", "zsh", "cmd", "powershell", "pwsh", "conhost"]);

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return log("unreadable payload");
  }
  const agentId = payload.agent_id;
  if (!agentId) return log("no agent_id");

  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd;
  const profilePath = join(projectDir, ".claude", "orchestration", "profile.json");
  if (!existsSync(profilePath)) return log(`agent ${agentId}: no profile at ${profilePath}`);

  let patterns;
  try {
    patterns = (JSON.parse(readFileSync(profilePath, "utf8")).servers ?? []).filter(Boolean).map(normPath);
  } catch {
    return log(`agent ${agentId}: unreadable profile ${profilePath}`);
  }
  if (!patterns.length) return log(`agent ${agentId}: no servers pattern in the profile`);

  const marker = normPath(`/worktrees/agent-${agentId}/`);
  const all = listProcesses();
  const targets = all.filter((p) => {
    if (!p.line || SHELLS.has(p.name.toLowerCase().replace(/\.exe$/, ""))) return false;
    const line = normPath(p.line);
    return line.includes(marker) && patterns.some((x) => line.includes(x));
  });
  if (!targets.length) return log(`agent ${agentId}: nothing to stop`);

  for (const p of targets) {
    if (process.platform === "win32") run("taskkill.exe", ["/PID", String(p.pid), "/T", "/F"]);
    else {
      // Children first, so none is orphaned while the parent dies.
      const tree = [p.pid];
      for (let i = 0; i < tree.length; i++) for (const c of all) if (c.ppid === tree[i]) tree.push(c.pid);
      for (const pid of tree.reverse()) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
    // The executable name only: arguments can carry passwords or tokens.
    log(`agent ${agentId}: stopped PID ${p.pid} ${p.name}`);
  }
}

try {
  main();
} catch (e) {
  log(`error: ${e.message}`);
}
process.exit(0);
