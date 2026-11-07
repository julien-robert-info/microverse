"use strict";

// Process helpers of the bench.

const { spawnSync } = require("node:child_process");

// Kills `pid` and everything it started. Windows: taskkill /T walks the tree.
// POSIX: the child was spawned `detached`, so it leads a process group that
// `kill(-pid)` reaches; without that group only the process itself is killed.
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).status === 0;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
      return true;
    } catch {
      // not a group leader, or already gone
    }
  }
  return false;
}

module.exports = { killTree };
