"use strict";

// One bench pass: prepares the slot, runs `claude -p` in it with nobody
// present, stops it at the time limit, keeps the diff, grades, prices and
// records one line of `passes.jsonl`. The campaign (campaign.js) chains passes.

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const { join } = require("node:path");
const lib = require("../../scripts/orch-lib.js");
const { prepare } = require("./copy.js");
const { keepDiff } = require("./diff.js");
const { grade, readMarker } = require("./grade.js");
const { killTree } = require("./proc.js");
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
// the deployment nor the source.
function settingsFor(suite, orgId) {
  const org = suite.organisations[orgId];
  const slash = (p) => p.replace(/\\/g, "/");
  const pluginBin = org.plugin ? [`Bash(${slash(`${suite.slot}-plugin`)}/bin/*)`] : [];
  const allow = [
    "Read", "Edit", "Write",
    ...suite.install.map((c) => `Bash(${c})`),
    "Bash(git:*)", "Bash(node:*)", "Bash(npm test:*)", "Bash(npm ci:*)", "Bash(npx tsc:*)",
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

// R2. Why the first init event does not match the organisation, or null.
function initProblem(init, suite, orgId) {
  const org = suite.organisations[orgId];
  // Claude Code lists its own built-in plugins (path "builtin"): they are not a configuration choice.
  const plugins = (Array.isArray(init.plugins) ? init.plugins : []).filter((p) => p?.path !== "builtin" && !/@builtin$/.test(p?.source ?? ""));
  const microverse = plugins.filter((p) => /microverse/i.test(JSON.stringify(p)));
  if (org.plugin && microverse.length !== 1) return "the microverse plugin is not loaded exactly once";
  if (plugins.length !== microverse.length) return "a plugin other than microverse is loaded";
  if (!org.plugin && plugins.length) return "a plugin is loaded in an organisation without one";
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
async function sweep(slot) {
  const key = lib.normPath(slot);
  const find = () => lib.listProcesses().filter((p) => p.pid !== process.pid && lib.normPath(p.line ?? "").includes(key));
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
// transcript, falls back on the figure the call reported, and with none on the
// most it could have spent (budget cap with a margin), flagged `bound`. A call
// that ran is never written as free or unknown: either would let the guard
// approve the next one blind.
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
    return { byRole: {}, usd: reported, usdReported: reported, unpriced: [], weekPts: reported * ratios.ratio7, fiveHourPts: reported * ratios.ratio5, ratios: { ...ratios } };
  }
  if (cost.unpriced.length) {
    if (!Number.isFinite(cost.usdReported)) return bound(cost);
    return { ...cost, weekPts: cost.usdReported * ratios.ratio7, fiveHourPts: cost.usdReported * ratios.ratio5, ratios: { ...ratios } };
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
  mkdirSync(campaignDir, { recursive: true });
  const session = randomUUID();
  const settingsFile = join(campaignDir, `settings-${orgId}.json`);
  writeFileSync(settingsFile, `${JSON.stringify(settingsFor(suite, orgId), null, 2)}\n`);
  const model = opts.model ?? DEFAULT_MODEL;
  const args = commandLine({ suite, orgId, prompt: suite.prompts[orgId], model, session, settingsFile, claudeArgs: opts.claudeArgs });

  const started = Date.now();
  const r = await launch({
    claude, args, cwd: slot, env: suite.cmdEnv, timeoutMs: (opts.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60000,
    onInit: (init) => initProblem(init, suite, orgId),
  });
  const minutes = Math.round(((Date.now() - started) / 60000) * 1000) / 1000;
  const events = parseEvents(r.stdout);

  // R4, in this order: the leftovers, the kept diff, the grade, then the figures.
  const swept = await sweep(slot);
  const projects = opts.projects ?? lib.projectsRoot();
  const advanced = mainAdvanced(suite);
  const kept = attempt(() => keepDiff({ suite, campaignDir, session }));
  const diffResult = kept.value ?? { diff: null, diffError: "git-error" };
  const graded = attempt(() => grade(suite, taskId));
  const cost = r.failed ? freeCost(ratios) : costOf({ projects, slot, session, ratios, events, maxBudgetUsd: org.maxBudgetUsd });
  const leaks = attempt(() =>
    scanLeaks({ projects, slot, session, source: suite.source, forbiddenPaths: suite.forbiddenPaths, hashes: { tip: task.tip, merge: task.merge } }));
  const activity = attempt(() => passActivity({ projects, slot, session, stream: events }));

  // The runner decides these three itself, strongest first.
  let outcome;
  if (r.failed) outcome = "error";
  else if (r.misconfigured) outcome = "misconfigured";
  else if (leaks.value?.length) outcome = "contaminated";
  else if (r.timedOut) outcome = "timeout";
  else outcome = passOutcome({ stream: events, mainAdvanced: advanced });

  const quality = graded.value ? { ...graded.value, ...(activity.value ? { agents: activity.value.agents } : {}) } : null;
  const line = {
    schema: 1, task: taskId, org: orgId, session, model, startedAt: new Date(started).toISOString(), minutes, outcome,
    reason: r.misconfigured ?? (r.failed ? String(r.failed.message) : null),
    killed: swept.killed, leftover: swept.left,
    cost, quality, qualityError: graded.error, activity: activity.value, activityError: activity.error,
    leaks: leaks.value, leaksError: leaks.error,
    diff: diffResult.diff, diffError: diffResult.diffError ?? kept.error,
  };
  appendFileSync(join(campaignDir, "passes.jsonl"), `${JSON.stringify(line)}\n`);
  return line;
}

module.exports = { runPass, assertNoDatabase, portOpen, assertExe, settingsFor, commandLine, initProblem, sweep, DEFAULT_MODEL, DEFAULT_TIMEOUT_MINUTES };
