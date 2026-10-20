// Helpers shared by the bin/ scripts. CommonJS without dependencies, so the
// scripts run on any Node >= 20 without an install step.
"use strict";

const { spawnSync } = require("node:child_process");
const { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
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

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// $/MTok: input, 5m cache write, 1h cache write, cache read, output.
const PRICES = {
  "claude-opus-5-5": [4, 5, 8, 0.2, 20],
  "claude-sonnet-5-5": [2, 2.5, 4, 0.1, 10],
  "claude-sonnet-5": [2, 2.5, 4, 0.2, 10],
};
// Haiku 5.5 is priced by request size: above 100K tokens of context, x5.
const HAIKU = { small: [0.1, 0.125, 0.2, 0.01, 0.5], large: [0.5, 0.625, 1, 0.05, 2.5], limit: 100e3 };

// Streamed replies repeat the same message id + request id on several lines
// with partial counts: keep the maximum of each counter.
function readRequests(file, kind, since, requests, agent = null) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"usage"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o.message;
    if (!m?.usage || !m.model?.startsWith("claude")) continue;
    if (since && new Date(o.timestamp) < since) continue;
    const v = counters(m.usage);
    // Per-step usage when an advisor may have run: "message" steps are the
    // executor (their sum is the top-level usage), "advisor_message" steps are
    // billed to the advisor's own model. Kept by index so that a streamed
    // repeat takes the maximum of each counter step by step.
    const iters = (m.usage.iterations ?? []).map((it) => ({ advisor: it.type === "advisor_message", model: it.model ?? null, v: counters(it) }));
    const id = `${m.id}:${o.requestId ?? ""}`;
    const prev = requests.get(id);
    if (prev) {
      for (let i = 0; i < v.length; i++) v[i] = Math.max(v[i], prev.v[i]);
      for (let j = 0; j < Math.max(iters.length, prev.iters.length); j++) {
        const a = iters[j], b = prev.iters[j];
        if (!a) iters[j] = b;
        else if (b) a.v = a.v.map((x, i) => Math.max(x, b.v[i]));
      }
    }
    requests.set(id, { kind, agent, model: m.model, ts: o.timestamp, v, iters });
  }
}

// [input, 5m write, 1h write, read, output] of a usage object.
function counters(u) {
  const cc = u.cache_creation ?? {};
  let w5 = cc.ephemeral_5m_input_tokens ?? 0;
  const w1 = cc.ephemeral_1h_input_tokens ?? 0;
  if (!u.cache_creation && u.cache_creation_input_tokens) w5 = u.cache_creation_input_tokens;
  return [u.input_tokens ?? 0, w5, w1, u.cache_read_input_tokens ?? 0, u.output_tokens ?? 0];
}

// Cost vector of the executor part of a request, or null without a price. The
// Haiku tier depends on each call's size, so its steps are priced one by one.
function executorCost(r) {
  const steps = r.iters.filter((it) => !it.advisor);
  if (!r.model.startsWith("claude-haiku-5-5") || !steps.length) return priceOf(r.model, r.v);
  const parts = steps.map((it) => priceOf(r.model, it.v));
  return parts.reduce((a, c) => a.map((x, i) => x + c[i]), [0, 0, 0, 0, 0]);
}

const advisorSteps = (r) => r.iters.filter((it) => it.advisor && it.model);

function priceOf(model, v) {
  let p = PRICES[model];
  if (!p && model.startsWith("claude-haiku-5-5")) p = v[0] + v[1] + v[2] + v[3] > HAIKU.limit ? HAIKU.large : HAIKU.small;
  return p ? v.map((x, i) => (x / 1e6) * p[i]) : null;
}

// Total cost of a request, advisor steps included; `priced` is false when a
// model has no price, and `cost` then leaves it out.
function requestCost(r) {
  const sum = (c) => c.reduce((a, x) => a + x, 0);
  const c = executorCost(r);
  let cost = c ? sum(c) : 0;
  let priced = Boolean(c);
  for (const it of advisorSteps(r)) {
    const ac = priceOf(it.model, it.v);
    if (ac) cost += sum(ac);
    else priced = false;
  }
  return { cost, priced };
}

// The transcript's sibling .meta.json names the agent type and its task.
function agentInfo(file) {
  const id = file.replace(/^.*agent-/, "").replace(/.jsonl$/, "");
  try {
    const m = JSON.parse(readFileSync(file.replace(/.jsonl$/, ".meta.json"), "utf8"));
    return { id, file, type: m.agentType ?? "?", description: m.description ?? "" };
  } catch {
    return { id, file, type: "?", description: "" };
  }
}

// Claude Code names a project's folder after its path, every character other
// than a letter or digit replaced by "-". The drive letter's case varies.
const projectSlug = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();

const projectsRoot = () => join(homedir(), ".claude", "projects");

// Every transcript of every project, from directory listings and stat only:
// { path, project, kind: "conversation" | "agent", mtime }.
function walkTranscripts(root = projectsRoot()) {
  const out = [];
  const add = (path, project, kind) => {
    try {
      out.push({ path, project, kind, mtime: statSync(path).mtimeMs });
    } catch {
      // vanished between the listing and the stat
    }
  };
  const list = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const p of list(root)) {
    if (!p.isDirectory()) continue;
    const pdir = join(root, p.name);
    for (const e of list(pdir)) {
      if (e.isFile() && e.name.endsWith(".jsonl")) add(join(pdir, e.name), p.name, "conversation");
      else if (e.isDirectory()) {
        const sub = join(pdir, e.name, "subagents");
        for (const a of list(sub)) if (a.isFile() && a.name.startsWith("agent-") && a.name.endsWith(".jsonl")) add(join(sub, a.name), p.name, "agent");
      }
    }
  }
  return out;
}

const RUNNING_WINDOW = 10 * 60e3;

// Agents working now on the account: subagent transcripts written in the last
// ten minutes, `meeseeks` left out (they cost little and do not take a slot).
// `others` are those of projects other than `currentSlug`.
function countRunning(files, { now = Date.now(), currentSlug = null } = {}) {
  let total = 0;
  let others = 0;
  for (const f of files) {
    if (f.kind !== "agent" || f.mtime < now - RUNNING_WINDOW) continue;
    if (agentInfo(f.path).type.endsWith("meeseeks")) continue;
    total++;
    if (f.project.toLowerCase() !== currentSlug) others++;
  }
  return { total, others };
}

const CAL = { days: 14, fresh: 6 * HOUR, minCost: 1, minIntervals: 5, recent: 48 * HOUR, recentMin: 3, factor: 2, quantile: 0.25 };
const ROLES = ["rick", "morty", "council"];

function quantile(sorted, p) {
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const sortedNumbers = (a) => [...a].sort((x, y) => x - y);

// Cost of the requests with a timestamp in [t1, t2], by binary search over a
// timeline sorted by time with running sums.
function costLine(requests) {
  const rows = [...requests.values()]
    .map((r) => ({ t: Date.parse(r.ts), ...requestCost(r) }))
    .filter((r) => !Number.isNaN(r.t))
    .sort((a, b) => a.t - b.t);
  const cost = [0];
  const unpriced = [0];
  for (const r of rows) {
    cost.push(cost.at(-1) + r.cost);
    unpriced.push(unpriced.at(-1) + (r.priced ? 0 : 1));
  }
  const bound = (t, after) => {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (after ? rows[mid].t <= t : rows[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (t1, t2) => {
    const a = bound(t1, false);
    const b = bound(t2, true);
    return { cost: cost[b] - cost[a], unpriced: unpriced[b] - unpriced[a] };
  };
}

// Points per dollar of each interval between two consecutive readings of a
// counter in the same window. An interval whose cost is unknown (a model
// without a price) or under the minimum says nothing and is left out.
function intervalRatios(observations, type, from, between) {
  const obs = observations.filter((o) => o.periodType === type && (o.provider ?? "claude") === "claude").sort((a, b) => a.observedAt - b.observedAt);
  const out = [];
  for (let i = 1; i < obs.length; i++) {
    const a = obs[i - 1];
    const b = obs[i];
    if (a.observedAt < from || Math.abs(a.resetAt - b.resetAt) >= HOUR) continue;
    const points = (b.usedFraction - a.usedFraction) * 100;
    if (!(points > 0)) continue;
    const span = between(a.observedAt, b.observedAt);
    if (span.unpriced || span.cost < CAL.minCost) continue;
    out.push(points / span.cost);
  }
  return out;
}

// Points of the quota counters per API-equivalent dollar and the cost of the
// agent roles, from the transcripts of all projects. `files` comes from
// walkTranscripts. The ratio is a low quantile because usage the transcripts
// do not hold (claude.ai, another machine) only makes a ratio look larger.
// When the last 48 hours differ from the stored ratio by more than x2 either
// way the plan changed: the recent ratio replaces it, and only intervals since
// then count until enough of them exist. `observations` come from one source
// only (`source`, stored in the result): the two never mix, and a stored ratio
// of the other source is no basis for detecting a plan change.
function computeCalibration({ files, observations, now = Date.now(), previous = null, source = "extension" }) {
  const cutoff = now - CAL.days * DAY;
  const requests = new Map();
  const mtimes = new Map();
  for (const f of files) {
    if (f.mtime < cutoff) continue;
    try {
      readRequests(f.path, f.kind, null, requests, f.kind === "agent" ? agentInfo(f.path) : null);
      mtimes.set(f.path, f.mtime);
    } catch {
      // unreadable or removed: its requests are missing, the interval costs are lower bounds
    }
  }
  const between = costLine(requests);

  // A plan change narrows the window to the intervals since it; once that is
  // older than the cutoff the window is the ordinary one again.
  let since = previous?.since >= cutoff ? previous.since : null;
  const counters = [["5", "five-hour", "5h"], ["7", "seven-day", "week"]];
  const changed = {};
  const sameSource = !previous || (previous.source ?? "extension") === source;
  for (const [key, type, label] of counters) {
    const prev = sameSource ? previous?.[`ratio${key}`] ?? null : null;
    const recent = intervalRatios(observations, type, now - CAL.recent, between);
    if (prev === null || recent.length < CAL.recentMin) continue;
    const r = quantile(sortedNumbers(recent), CAL.quantile);
    if (r > prev * CAL.factor || r < prev / CAL.factor) changed[key] = { text: `${label} ${fmtRatio(prev)}→${fmtRatio(r)}`, r, n: recent.length };
  }
  if (Object.keys(changed).length) since = now - CAL.recent;

  const cal = { at: now, source, ratio5: null, n5: 0, ratio7: null, n7: 0, since, change: null, roles: {} };
  for (const [key, type] of counters) {
    const kept = intervalRatios(observations, type, Math.max(cutoff, since ?? 0), between);
    cal[`n${key}`] = kept.length;
    if (kept.length >= CAL.minIntervals) cal[`ratio${key}`] = quantile(sortedNumbers(kept), CAL.quantile);
    else if (since && sameSource && previous?.[`ratio${key}`] != null) {
      cal[`ratio${key}`] = previous[`ratio${key}`];
      cal[`n${key}`] = previous[`n${key}`];
    }
    if (changed[key]) {
      cal[`ratio${key}`] = changed[key].r;
      cal[`n${key}`] = changed[key].n;
    }
  }
  const texts = Object.values(changed).map((c) => c.text);
  if (texts.length) cal.change = `Calibration changed (subscription?): ${texts.join(", ")} points/$`;

  const runs = new Map();
  for (const r of requests.values()) {
    if (r.kind !== "agent") continue;
    const run = runs.get(r.agent.file) ?? { type: r.agent.type, cost: 0, priced: true, first: r.ts, file: r.agent.file };
    const c = requestCost(r);
    run.cost += c.cost;
    if (!c.priced) run.priced = false;
    if (r.ts < run.first) run.first = r.ts;
    runs.set(r.agent.file, run);
  }
  for (const role of ROLES) {
    const costs = [...runs.values()]
      .filter((r) => new RegExp(`(^|:)${role}$`).test(r.type) && r.priced && Date.parse(r.first) >= cutoff && mtimes.get(r.file) < now - RUNNING_WINDOW)
      .map((r) => r.cost);
    cal.roles[role] = { n: costs.length, median: costs.length >= CAL.minIntervals ? quantile(sortedNumbers(costs), 0.5) : null };
  }
  return cal;
}

const fmtRatio = (x) => String(Number(x.toPrecision(3)));

// Points of the 5h counter one agent may use, from the stored calibration:
// the larger of a rick and a morty with its council review. Null (the default
// applies) unless all three roles have a median: a missing one would leave the
// cost under-estimated.
function learnedAgentCost(cal) {
  if (!cal?.ratio5) return null;
  const { rick, morty, council } = cal.roles ?? {};
  if (![rick, morty, council].every((r) => r?.median != null)) return null;
  const dollars = Math.max(rick.median, morty.median + council.median);
  return { points: Math.max(1, Math.round(cal.ratio5 * dollars)), runs: rick.n + morty.n + council.n };
}

const calibrationFile = () => join(process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".claude", "microverse"), "calibration.json");

function loadCalibration() {
  try {
    const cal = JSON.parse(readFileSync(calibrationFile(), "utf8"));
    return typeof cal.at === "number" ? cal : null;
  } catch {
    return null;
  }
}

const calibrationStale = (cal, now = Date.now()) => !cal || now - cal.at > CAL.fresh || cal.at > now;

function saveCalibration(cal) {
  const file = calibrationFile();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(cal, null, 2));
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

// Claude Code compacts about this many tokens before `autoCompactWindow`
// (likely a reserved output budget plus a buffer; undocumented).
const COMPACT_OFFSET = 33000;

// Status line readings ([{ at, five?, week? }] from scripts/statusline.js) as
// observations of the extension's shape. `used` is 0-100, `usedFraction` 0-1.
// An absent window yields no observation: it is not a reading of 0.
function statuslineObservations(readings) {
  const out = [];
  for (const r of readings) {
    for (const [periodType, w] of [["five-hour", r.five], ["seven-day", r.week]]) {
      if (w) out.push({ periodType, usedFraction: w.used / 100, resetAt: w.resetsAt, observedAt: r.at, source: "statusline" });
    }
  }
  return out;
}

// The observations that raise a counter: per counter, the first reading of
// each window and every reading strictly above the highest value seen in it.
// A window is a run of readings (by time) whose reset stays within an hour of
// the run's first one. Sessions append to the history independently, so it
// holds duplicates and stale lower values that would fake intervals.
function risingOnly(observations) {
  const out = [];
  for (const type of ["five-hour", "seven-day"]) {
    const obs = observations
      .filter((o) => o.periodType === type)
      .sort((a, b) => a.observedAt - b.observedAt || a.usedFraction - b.usedFraction);
    let first = null;
    let max = -Infinity;
    for (const o of obs) {
      if (!first || !(Math.abs(o.resetAt - first.resetAt) < HOUR)) {
        first = o;
        max = o.usedFraction;
        out.push(o);
      } else if (o.usedFraction > max) {
        max = o.usedFraction;
        out.push(o);
      }
    }
  }
  return out;
}

// The current reading of one counter among observations of any source: group
// them by window (two resets less than an hour apart are one window, the
// extension's jitter), keep the latest window whose reset is still ahead, and
// return its highest value (a counter does not fall inside a window, and an
// idle session may rewrite an old value after a fresher one) with the resetAt,
// time and source of its newest reading. Readings without a reset belong to no
// window. Null when no window is current.
function currentReading(observations, now) {
  const live = observations.filter((o) => Number.isFinite(o.resetAt) && o.resetAt > now).sort((a, b) => a.resetAt - b.resetAt);
  if (!live.length) return null;
  let start = live.length - 1;
  while (start > 0 && live[start].resetAt - live[start - 1].resetAt < HOUR) start--;
  const group = live.slice(start);
  const newest = group.reduce((a, b) => (b.observedAt >= a.observedAt ? b : a));
  return {
    usedFraction: Math.max(...group.map((o) => o.usedFraction)),
    resetAt: newest.resetAt,
    observedAt: newest.observedAt,
    source: newest.source,
  };
}

function fmtAge(ms) {
  if (ms < 60e3) return "under 1 min";
  if (ms < HOUR) return `${Math.floor(ms / 60e3)} min`;
  return `${Math.floor(ms / HOUR)} h`;
}

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

// Worktrees of the agents under <projectDir>/.claude/worktrees/ as
// { branch|null, path, rel, merged, last?, dirty? }. Merged means the worktree's
// HEAD is an ancestor of the main worktree's HEAD. Paths are compared in a
// normal form (forward slashes, lower case) because git and the environment
// disagree on drive-letter case and separators on Windows. With `details`,
// `last` is the last commit ("<hash> <subject>", "" when unknown) and `dirty`
// whether uncommitted changes remain. Throws as the git calls do.
function agentWorktrees(projectDir, { details = false } = {}) {
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const all = listWorktrees(projectDir);
  const prefix = `${norm(projectDir)}/.claude/worktrees/`;
  const projectLen = norm(projectDir).length;
  const rows = [];
  for (const wt of all.slice(1)) {
    if (!norm(wt.path).startsWith(prefix)) continue;
    const merged = git(["merge-base", "--is-ancestor", wt.head, all[0].head], all[0].path).code === 0;
    const rel = wt.path.replace(/\\/g, "/").slice(projectLen + 1);
    const row = { branch: wt.branch ?? null, path: wt.path, rel, merged };
    if (details) {
      row.last = git(["log", "-1", "--format=%h %s"], wt.path).out.trim();
      row.dirty = git(["status", "--porcelain"], wt.path).out.trim() !== "";
    }
    rows.push(row);
  }
  return rows;
}

// Text taken from a repository, a transcript or a process must not drive the
// terminal (ESC/OSC sequences, C1 controls) nor read differently from what it
// says (line separators, bidi and zero-width characters) nor carry instructions
// the human cannot see (tag characters). Newline is kept, tabs become spaces,
// accents and ordinary text are untouched. `max` caps the length in code points.
const UNSAFE_TEXT = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u180e\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff\\u{e0000}-\\u{e007f}]", "gu");
function sanitize(text, max) {
  let s = String(text ?? "").replace(/\t/g, "  ").replace(UNSAFE_TEXT, "");
  if (max && [...s].length > max) s = `${[...s].slice(0, max - 1).join("")}…`;
  return s;
}

module.exports = {
  sanitize,
  listWorktrees, agentWorktrees,
  statuslineObservations, risingOnly, currentReading, fmtAge,
  COMPACT_OFFSET, run, git, fail, parseArgs, repoRoot, loadProfile, defaultBase, worktreeFor, normPath, listProcesses, lastContext, readTail, paceAdvice,
  FIVE_HOUR_COST, readRequests, executorCost, advisorSteps, priceOf, requestCost, agentInfo, projectSlug, projectsRoot, walkTranscripts,
  countRunning, computeCalibration, learnedAgentCost, calibrationFile, loadCalibration, saveCalibration, calibrationStale, fmtRatio,
};
