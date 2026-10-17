// Helpers shared by the bin/ scripts. CommonJS without dependencies, so the
// scripts run on any Node >= 20 without an install step.
"use strict";

const { spawnSync } = require("node:child_process");
const { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } = require("node:fs");
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

// Context size of the last request found in transcript text (JSON lines):
// { model, ts, tokens } with tokens = input + cache read + cache write, or null.
// A request with an advisor call counts its last executor step only.
// Streamed replies repeat the same message id + request id on several lines with
// partial counts: the maximum of each counter is kept. A line cut by a tail read
// does not parse and is skipped.
function lastContext(text) {
  const requests = new Map();
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o.message;
    if (!m?.usage || !m.model?.startsWith("claude")) continue;
    // With an advisor call the top-level usage sums the executor's steps: the
    // context is that of the last "message" step, not the sum.
    const steps = Array.isArray(m.usage.iterations) ? m.usage.iterations.filter((it) => it.type === "message") : [];
    const u = steps.length ? steps.at(-1) : m.usage;
    const cc = u.cache_creation;
    const written = cc ? (cc.ephemeral_5m_input_tokens ?? 0) + (cc.ephemeral_1h_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
    const tokens = (u.input_tokens ?? 0) + written + (u.cache_read_input_tokens ?? 0);
    const id = `${m.id}:${o.requestId ?? ""}`;
    const prev = requests.get(id);
    requests.set(id, { model: m.model, ts: o.timestamp, tokens: Math.max(tokens, prev?.tokens ?? 0) });
  }
  return [...requests.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1)).at(-1) ?? null;
}

// The last `maxBytes` of a file as text.
function readTail(file, maxBytes) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// Pacing advice for launching agents: the first rule that applies. `delta`
// is the weekly counter minus the pacing line, in points; `period` is the
// current period's target. An agent here is a morty (with its council review)
// or a rick; `running` of them are already working.
const AHEAD = 5; // points above the pacing line before advising to slow down
const BEHIND = 10; // points below it before advising to speed up
const AGENT_COST = 3; // weekly points an agent may still use once launched
const FIVE_HOUR_RESUME = 5; // points above the five-hour limit where resuming stops too
const FIVE_HOUR_COST = 15; // points of the five-hour counter one agent may use

function paceAdvice({ used7, used5, delta, target, period, fiveLimit, reset5 = "", running = 0, agentCost = FIVE_HOUR_COST }) {
  if (used7 >= target) return `stop: no more resuming agents (≥ ${target} %); keep the rest for end-of-week questions`;
  if (used7 >= target - AGENT_COST) return `no new agent (≥ ${target - AGENT_COST} %): finish, review and merge the running ones`;
  if (used5 >= fiveLimit + FIVE_HOUR_RESUME) return `no more resuming agents${reset5}`;
  if (used5 >= fiveLimit) return `no new agent${reset5}`;
  if (used7 >= period || delta > AHEAD) return "smooth out: no new agent until the counter drops back under the line";
  // Each running agent keeps its share of the room left under the five-hour
  // limit: a launch that does not fit would hit the limit and stop them all.
  const fits = Math.floor((fiveLimit - used5 - running * agentCost) / agentCost);
  if (fits < 1) return `no new agent: ${fiveLimit - used5} points left before the 5h limit, ${running ? `${running} running and ` : ""}about ${agentCost} per agent${reset5}`;
  const total = Math.min(delta < -BEHIND ? 3 : 2, running + fits);
  const where = "(morty on distinct zones, one per shared resource)";
  if (delta < -BEHIND) return `speed up: up to ${total} agents at once ${where}`;
  if (total >= 2) return `normal: up to ${total} agents at once ${where}`;
  return "normal: one agent at a time";
}

module.exports = { run, git, fail, parseArgs, repoRoot, loadProfile, defaultBase, worktreeFor, normPath, listProcesses, lastContext, readTail, paceAdvice };
