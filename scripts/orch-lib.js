// Helpers shared by the bin/ scripts. CommonJS without dependencies, so the
// scripts run on any Node >= 20 without an install step.
"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? (r.error ? String(r.error) : "") };
}

function git(args, cwd) {
  return run("git", args, { cwd });
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

// `--key value` and `--flag` pairs; everything else is positional. A name in
// `flags` is boolean: it never takes the next token as its value.
function parseArgs(argv, { flags = [] } = {}) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (flags.includes(key) || next === undefined || next.startsWith("--")) opts[key] = true;
    else {
      opts[key] = next;
      i++;
    }
  }
  return opts;
}

function repoRoot(cwd = process.cwd()) {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  if (r.code !== 0) fail("not in a git repository");
  return r.out.trim();
}

function loadProfile(root) {
  const file = join(root, ".claude", "orchestration", "profile.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`unreadable profile (${file}): ${e.message}`);
  }
}

function defaultBase(root) {
  for (const b of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], root).code === 0) return b;
  }
  fail("neither main nor master: pass --base");
}

// Worktree checked out on `branch`, from `git worktree list --porcelain`.
function worktreeFor(root, branch) {
  const r = git(["worktree", "list", "--porcelain"], root);
  let path = null;
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

// Paths compared case-insensitively with one separator, as on Windows.
function normPath(p) {
  return p.replace(/\//g, "\\").toLowerCase();
}

// Running processes as { pid, ppid, name, line }, on Windows (CIM) and POSIX (ps).
function listProcesses() {
  if (process.platform === "win32") {
    const r = run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ]);
    if (r.code !== 0) fail(`cannot read the process list: ${r.err.trim()}`);
    const list = JSON.parse(r.out || "[]");
    return (Array.isArray(list) ? list : [list]).map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      name: p.Name ?? "",
      line: p.CommandLine ?? "",
    }));
  }
  const r = run("ps", ["-eo", "pid=,ppid=,comm=,args="]);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l);
      return { pid: Number(m?.[1]), ppid: Number(m?.[2]), name: m?.[3] ?? "", line: m?.[4] ?? "" };
    });
}

module.exports = { run, git, fail, parseArgs, repoRoot, loadProfile, defaultBase, worktreeFor, normPath, listProcesses };
