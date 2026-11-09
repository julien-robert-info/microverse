"use strict";

// One bench pass: prepares the slot, runs `claude -p` in it with nobody
// present, stops it at the time limit, keeps the diff, grades, prices and
// records one line of `passes.jsonl`. The campaign (campaign.js) chains passes.

const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const { basename, join } = require("node:path");
const lib = require("../../scripts/orch-lib.js");
const { prepare } = require("./copy.js");
const { keepDiff } = require("./diff.js");
const { grade, readMarker } = require("./grade.js");
const { killTree } = require("./proc.js");
const { readLines } = require("./spend.js");
const { gitIn, taskOf } = require("./suite.js");
const { passActivity, passCost, passOutcome, scanLeaks } = require("./transcripts.js");

const DEFAULT_MODEL = "sonnet";
const DEFAULT_TIMEOUT_MINUTES = 120;
const DB_PORT = 5432;
// A call that ran but left no figure counts for this many times its budget cap.
const BOUND_MARGIN = 1.5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// R6. The development database listens on this port: a pass that could reach
// it is not run. Resolves true when something accepts a connection.
function portOpen(port, host = "127.0.0.1", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}

async function assertNoDatabase({ allowPort = false, dbPort = DB_PORT } = {}) {
  if (allowPort) return;
  if (await portOpen(dbPort)) throw new Error(`127.0.0.1:${dbPort} accepts connections: the development database is up, a pass is not started (stop it first)`);
}

function assertExe(claude) {
  if (/\.(cmd|bat)$/i.test(claude)) throw new Error(`${claude}: a .cmd or .bat would need a shell, which the bench never opens; give the .exe with --claude`);
}

// --- what is asked of the call -----------------------------------------------

// R1. Generated settings of a pass. The permissions are those of a worker that
// builds and tests in its copy and reaches neither the network, the database,
// the deployment nor the source. The allow list derives from the profile the
// user approved (`trusted`), so a worker can run exactly the checks and setup
// the user approved, and from the plugin's `bin` folder, so no script name is
// written by hand. The checks also get `:*` so that `<check> 2>&1 | tail` is
// matched segment by segment. `orch-trust` is only allowed in its read forms:
// `orch-trust <sha256>` is the user's approval, which an agent never runs.
const READ_TOOLS = ["grep", "head", "tail", "wc", "sort", "uniq", "ls"];
const PLUGIN_NO_ALLOW = ["orch-trust", "orch-speak"];

function settingsFor(suite, orgId, trusted) {
  const org = suite.organisations[orgId];
  const slash = (p) => p.replace(/\\/g, "/");
  const pluginBin = org.plugin ? pluginRules(`${slash(`${suite.slot}-plugin`)}/bin`) : [];
  const allow = [
    "Read", "Edit", "Write",
    ...suite.install.map((c) => `Bash(${c})`),
    "Bash(git:*)", "Bash(node:*)", "Bash(npm test:*)", "Bash(npm ci:*)", "Bash(npx tsc:*)",
    ...trusted.checks.flatMap((c) => [`Bash(${c})`, `Bash(${c}:*)`]),
    ...trusted.setup.map((c) => `Bash(${c})`),
    ...READ_TOOLS.map((t) => `Bash(${t}:*)`),
    ...pluginBin,
  ];
  const deny = [
    "Bash(ssh:*)", "Bash(scp:*)", "Bash(docker:*)", "Bash(psql:*)", "Bash(git push:*)", "Bash(npm run deploy:*)",
    "Bash(npm run step:*)", "Bash(npm run db:*)", "Bash(curl:*)",
    `Read(${slash(suite.source)}/**)`, `Edit(${slash(suite.source)}/**)`,
    ...suite.forbiddenPaths.flatMap((p) => [`Read(${slash(p)}/**)`, `Edit(${slash(p)}/**)`]),
    "Read(~/.claude/projects/**)",
  ];
  return {
    ...(org.advisor === false ? {} : { advisorModel: "opus" }),
    autoCompactWindow: 183000,
    autoMemoryEnabled: false,
    permissions: { allow, deny },
  };
}

// Bare name (found on PATH through --plugin-dir) and full path, per script.
function pluginRules(bin) {
  let names;
  try {
    names = readdirSync(bin);
  } catch (e) {
    throw new Error(`${bin} cannot be listed (${e.code ?? e.message}): the plugin folder is misconfigured`);
  }
  const rules = [];
  for (const f of names.filter((n) => !PLUGIN_NO_ALLOW.includes(n)).sort()) rules.push(`Bash(${f}:*)`, `Bash(${bin}/${f}:*)`);
  if (names.includes("orch-trust")) {
    for (const p of ["orch-trust", `${bin}/orch-trust`]) rules.push(`Bash(${p} --status)`, `Bash(${p} --commands:*)`);
  }
  return rules;
}

function commandLine({ suite, orgId, prompt, model, session, settingsFile, claudeArgs = [] }) {
  const org = suite.organisations[orgId];
  const args = [
    ...claudeArgs, "-p", prompt, "--model", model, "--settings", settingsFile, "--setting-sources", "project,local",
    "--strict-mcp-config", "--permission-mode", "dontAsk", "--session-id", session, "--output-format", "stream-json", "--verbose",
    "--max-budget-usd", String(org.maxBudgetUsd),
  ];
  if (org.plugin) args.push("--plugin-dir", `${suite.slot}-plugin`);
  return args;
}

// The inline copy as `init` lists it: { name: "microverse", source:
// "microverse@inline", path: <the --plugin-dir folder> }. The installed copy
// is "microverse@microverse" and is not the version under test.
function isInlineCopy(p, suite) {
  if (p?.source === "microverse@inline") return true;
  let dir;
  try {
    dir = realpathSync.native(`${suite.slot}-plugin`);
  } catch {
    return false;
  }
  return typeof p?.path === "string" && lib.normPath(p.path) === lib.normPath(dir);
}

// R2. Why the first init event does not match the organisation, or null.
function initProblem(init, suite, orgId) {
  const org = suite.organisations[orgId];
  // Claude Code lists its own built-in plugins (path "builtin"): they are not a configuration choice.
  const plugins = (Array.isArray(init.plugins) ? init.plugins : []).filter((p) => p?.path !== "builtin" && !/@builtin$/.test(p?.source ?? ""));
  if (org.plugin) {
    if (plugins.length !== 1) return plugins.length ? "more than one plugin is loaded" : "the microverse plugin is not loaded";
    if (!isInlineCopy(plugins[0], suite)) return "the plugin loaded is not the inline copy (microverse@inline)";
  } else if (plugins.length) return "a plugin is loaded in an organisation without one";
  const names = (Array.isArray(init.skills) ? init.skills : []).map((s) => (typeof s === "string" ? s : s?.name ?? ""));
  for (const f of suite.forbiddenSkills) {
    if (names.some((n) => n === f || n.endsWith(`:${f}`))) return `the forbidden skill ${f} is loaded`;
  }
  return null;
}

// --- running the call ---------------------------------------------------------

// Spawns `claude` without a shell and reads its stream line by line, so that
// the first init can be judged while the call is running. On POSIX the child
// leads its own group, which killTree reaches. `exit` ends the wait after a
// short grace even if an orphan still holds the pipes open.
function launch({ claude, args, cwd, env, timeoutMs, onInit }) {
  return new Promise((resolve) => {
    const child = spawn(claude, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let pending = "";
    let timedOut = false;
    let failed = null;
    let misconfigured = null;
    let inited = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString("utf8"), timedOut, failed, misconfigured });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const line = (text) => {
      if (inited || !text.trim().startsWith("{")) return;
      let e;
      try {
        e = JSON.parse(text);
      } catch {
        return;
      }
      if (e?.type !== "system" || e.subtype !== "init") return;
      inited = true;
      misconfigured = onInit(e);
      if (misconfigured) killTree(child.pid);
    };
    child.stdout.on("data", (d) => {
      out.push(d);
      pending += d.toString("utf8");
      const parts = pending.split("\n");
      pending = parts.pop();
      parts.forEach(line);
    });
    child.stderr.on("data", () => {});
    child.on("error", (e) => {
      failed = e;
      finish();
    });
    child.on("exit", () => setTimeout(finish, 1500));
    child.on("close", () => {
      if (pending) line(pending);
      finish();
    });
  });
}

// R3. Processes still running from the slot after the call: killed with their
// trees. Returns how many were killed and how many remain.
//
// The process list is read by a variant that throws: lib.listProcesses ends
// the whole process on a failed listing, which would lose the line of a pass
// already paid for.
function listProcesses() {
  if (process.platform === "win32") {
    const r = spawnSync("powershell.exe", [
      "-NoProfile", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ], { encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error("cannot read the process list");
    const list = JSON.parse(r.stdout || "[]");
    return (Array.isArray(list) ? list : [list]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name ?? "", line: p.CommandLine ?? "" }));
  }
  const r = spawnSync("ps", ["-eo", "pid=,ppid=,comm=,args="], { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error("cannot read the process list");
  return r.stdout.split("\n").filter(Boolean).map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l);
    return { pid: Number(m?.[1]), ppid: Number(m?.[2]), name: m?.[3] ?? "", line: m?.[4] ?? "" };
  });
}

// True when `line` holds `key` as a whole path: what follows it ends the
// path (so `<slot>-plugin` and `<slot>2` are other folders). Both are
// normalised by normPath, which makes every separator a backslash.
function holdsPath(line, key) {
  const text = lib.normPath(line);
  for (let i = text.indexOf(key); i !== -1; i = text.indexOf(key, i + 1)) {
    const next = text[i + key.length];
    if (next === undefined || /[\\"' ]/.test(next)) return true;
  }
  return false;
}

async function sweep(slot, { list = listProcesses } = {}) {
  const key = lib.normPath(slot);
  const find = () => list().filter((p) => p.pid !== process.pid && holdsPath(p.line ?? "", key));
  let killed = 0;
  for (let round = 0; round < 3; round++) {
    const left = find();
    if (!left.length) return { killed, left: 0 };
    for (const p of left) {
      killTree(p.pid);
      killed++;
    }
    await sleep(400);
  }
  return { killed, left: find().length };
}

function parseEvents(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a cut line
    }
  }
  return out;
}

// The cost of a launched call: its transcript; a model without a price, or no
// transcript, gives the points of the figure the call reported (flagged
// `fromReported`, `usd` is never replaced by it), and with none the most it
// could have spent (budget cap with a margin), flagged `bound`. A call that
// ran is never written as free or unknown: either would let the guard approve
// the next one blind.
function costOf({ projects, slot, session, ratios, events, maxBudgetUsd }) {
  const reported = events.filter((e) => e?.type === "result").at(-1)?.total_cost_usd;
  const bound = (base) => ({
    byRole: {}, usd: null, usdReported: null, unpriced: [], ...base,
    weekPts: maxBudgetUsd * BOUND_MARGIN * ratios.ratio7, fiveHourPts: maxBudgetUsd * BOUND_MARGIN * ratios.ratio5, bound: true, ratios: { ...ratios },
  });
  let cost = null;
  try {
    cost = passCost({ projects, slot, session, ratios, stream: events });
  } catch {
    // no transcript
  }
  if (cost === null) {
    if (!Number.isFinite(reported)) return bound({});
    // `usd` is the measure by tokens: without a transcript there is none.
    return { byRole: {}, usd: null, usdReported: reported, unpriced: [], weekPts: reported * ratios.ratio7, fiveHourPts: reported * ratios.ratio5, fromReported: true, ratios: { ...ratios } };
  }
  if (cost.unpriced.length) {
    if (!Number.isFinite(cost.usdReported)) return bound(cost);
    return { ...cost, weekPts: cost.usdReported * ratios.ratio7, fiveHourPts: cost.usdReported * ratios.ratio5, fromReported: true, ratios: { ...ratios } };
  }
  return cost;
}

// A process that never started cost nothing, and says so.
const freeCost = (ratios) => ({ byRole: {}, usd: 0, usdReported: null, unpriced: [], weekPts: 0, fiveHourPts: 0, ratios: { ...ratios }, neverStarted: true });

const attempt = (fn) => {
  try {
    return { value: fn(), error: null };
  } catch (e) {
    return { value: null, error: String(e.message ?? e) };
  }
};

function mainAdvanced(suite) {
  let marker;
  try {
    marker = readMarker(suite.slot);
  } catch {
    return false;
  }
  const r = gitIn(suite.slot, ["rev-parse", "refs/heads/main"], suite.cmdEnv);
  return r.code === 0 && marker.base != null && r.out.trim() !== marker.base;
}

// --- what a line records about the world ------------------------------------

const ROOT = join(__dirname, "..", "..");
// A counter reading older than this says nothing about the quota now.
const QUOTA_FRESH_MS = 10 * 60 * 1000;

// `orch-quota --json`, or null when it cannot be read. Never throws.
function readQuota() {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "orch-quota"), "--json", "--no-write"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim().split("\n").at(-1));
  } catch {
    return null;
  }
}

// { five, week } (percent used) and the age of the older counter in seconds,
// or null when either counter is missing, has no figure or is not fresh.
function freshReading(quota, now) {
  const five = quota?.counters?.five;
  const week = quota?.counters?.week;
  for (const c of [five, week]) {
    if (!c || !Number.isFinite(c.used) || !Number.isFinite(c.observedAt) || now - c.observedAt > QUOTA_FRESH_MS) return null;
  }
  return { five: five.used, week: week.used, ageSeconds: Math.max(0, Math.round((now - Math.min(five.observedAt, week.observedAt)) / 1000)) };
}

function claudeVersion(claude, claudeArgs = []) {
  const r = spawnSync(claude, [...claudeArgs, "--version"], { encoding: "utf8", timeout: 30000, windowsHide: true, shell: false });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
}

function pluginCommit(suite) {
  if (!Object.values(suite.organisations).some((o) => o.plugin)) return null;
  const dir = `${suite.slot}-plugin`;
  if (!existsSync(dir)) return null;
  const r = gitIn(dir, ["rev-parse", "HEAD"], suite.cmdEnv);
  return r.code === 0 ? r.out.trim() : null;
}

// $ per million tokens of a model, for the five counters, or null without a price.
function priceVector(model) {
  const v = [0, 1, 2, 3, 4].map((i) => lib.priceOf(model, [0, 1, 2, 3, 4].map((j) => (j === i ? 1e6 : 0))));
  return v.every((x) => Array.isArray(x)) ? v.map((x, i) => x[i]) : null;
}

// A misconfigured pass or one that never started is not counted against its
// organisation: a relaunch retries the cell. Its cost still counts in the guard.
const counted = (p) => p.outcome !== "misconfigured" && !p.cost?.neverStarted;

// --- the pass -------------------------------------------------------------------

// Runs one pass and appends its line to `<campaignDir>/passes.jsonl`.
// opts: suite, taskId, orgId, campaignDir, ratios, claude, claudeArgs, projects,
// model, timeoutMinutes, allowPort, dbPort.
// Returns the line written.
async function runPass(opts) {
  const { suite, taskId, orgId, campaignDir } = opts;
  const claude = opts.claude ?? "claude";
  const ratios = opts.ratios;
  const org = suite.organisations[orgId];
  if (!org) throw new Error(`unknown organisation: ${orgId}`);
  const task = taskOf(suite, taskId);
  assertExe(claude);
  if (![ratios?.ratio7, ratios?.ratio5].every((r) => Number.isFinite(r) && r > 0)) throw new Error("no calibration ratio: the cost of a pass cannot be converted to points");
  await assertNoDatabase(opts);
  if (org.plugin && !existsSync(`${suite.slot}-plugin`)) throw new Error(`${suite.slot}-plugin is missing: the organisation ${orgId} needs the plugin folder`);

  prepare(suite, taskId, { org: orgId });
  const slot = realpathSync.native(suite.slot);
  const trust = lib.profileTrust(lib.mainRoot(slot));
  if (trust.state !== "approved") throw new Error(`the profile of ${slot} is ${trust.state}: its orch-trust must be approved by the user before a pass (no pass started)`);
  mkdirSync(campaignDir, { recursive: true });
  const session = randomUUID();
  const settingsFile = join(campaignDir, `settings-${orgId}.json`);
  writeFileSync(settingsFile, `${JSON.stringify(settingsFor(suite, orgId, trust), null, 2)}\n`);
  const model = opts.model ?? DEFAULT_MODEL;
  const args = commandLine({ suite, orgId, prompt: suite.prompts[orgId], model, session, settingsFile, claudeArgs: opts.claudeArgs });

  const readQ = opts.quota ?? readQuota;
  const before = attempt(() => freshReading(readQ(), Date.now()));
  const passNo = readLines(join(campaignDir, "passes.jsonl")).filter((p) => p.task === taskId && p.org === orgId && counted(p)).length + 1;
  let init = null;
  const started = Date.now();
  const r = await launch({
    claude, args, cwd: slot, env: suite.cmdEnv, timeoutMs: (opts.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60000,
    onInit: (e) => {
      init = e;
      return initProblem(e, suite, orgId);
    },
  });
  const minutes = Math.round(((Date.now() - started) / 60000) * 1000) / 1000;
  const events = parseEvents(r.stdout);

  // R4, in this order: the leftovers, the kept diff, the grade, then the figures.
  // A failed listing leaves `leftover: null`: the line is still written and the
  // campaign stops on it.
  const swept = await sweep(slot, { list: opts.listProcesses }).catch(() => ({ killed: null, left: null, error: "process listing failed" }));
  const projects = opts.projects ?? lib.projectsRoot();
  const advanced = mainAdvanced(suite);
  const kept = attempt(() => keepDiff({ suite, campaignDir, session }));
  const diffResult = kept.value ?? { diff: null, diffError: "git-error" };
  const graded = attempt(() => grade(suite, taskId));
  const cost = r.failed ? freeCost(ratios) : costOf({ projects, slot, session, ratios, events, maxBudgetUsd: org.maxBudgetUsd });
  const contamination = attempt(() =>
    scanLeaks({ projects, slot, session, source: suite.source, forbiddenPaths: suite.forbiddenPaths, hashes: { tip: task.tip, merge: task.merge } }));
  const activity = attempt(() => passActivity({ projects, slot, session, stream: events }));

  // The runner decides these three itself, strongest first.
  let outcome;
  if (r.failed) outcome = "error";
  else if (r.misconfigured) outcome = "misconfigured";
  else if (contamination.value?.length) outcome = "contaminated";
  else if (r.timedOut) outcome = "timeout";
  else outcome = passOutcome({ stream: events, mainAdvanced: advanced });

  const quality = graded.value ? { ...graded.value, ...(activity.value ? { agents: activity.value.agents } : {}) } : null;
  const after = attempt(() => freshReading(readQ(), Date.now()));
  const b = before.value;
  const a = after.value;
  const line = {
    schema: 1, campaign: opts.campaign ?? basename(campaignDir), pass: passNo, task: taskId, org: orgId, session,
    // The id the call resolved to; the configured alias is in the manifest.
    model: init?.model ?? null,
    env: {
      claudeCode: opts.claudeCode !== undefined ? opts.claudeCode : claudeVersion(claude, opts.claudeArgs),
      plugin: opts.pluginCommit !== undefined ? opts.pluginCommit : pluginCommit(suite),
      models: { orchestrator: init?.model ?? null },
    },
    startedAt: new Date(started).toISOString(), minutes, outcome,
    reason: r.misconfigured ?? (r.failed ? String(r.failed.message) : null),
    killed: swept.killed, leftover: swept.left, ...(swept.error ? { sweepError: swept.error } : {}),
    // A reading that is not fresh is null, never zero.
    quota: {
      weekBefore: b?.week ?? null, weekAfter: a?.week ?? null, fiveBefore: b?.five ?? null, fiveAfter: a?.five ?? null,
      ageSeconds: b && a ? { before: b.ageSeconds, after: a.ageSeconds } : null,
    },
    cost, quality, qualityError: graded.error, activity: activity.value, activityError: activity.error,
    contamination: contamination.value, contaminationError: contamination.error,
    diff: diffResult.diff, diffError: diffResult.diffError ?? kept.error,
  };
  appendFileSync(join(campaignDir, "passes.jsonl"), `${JSON.stringify(line)}\n`);
  return line;
}

module.exports = {
  runPass, assertNoDatabase, portOpen, assertExe, settingsFor, commandLine, initProblem, sweep, listProcesses, holdsPath,
  readQuota, freshReading, claudeVersion, pluginCommit, priceVector, counted, QUOTA_FRESH_MS, DEFAULT_MODEL, DEFAULT_TIMEOUT_MINUTES,
};
