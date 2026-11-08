"use strict";

// A campaign: the grid tasks x organisations x passes, run one pass after the
// other under the quota cap. It writes `manifest.json` and `passes.jsonl` and
// never calls the judge (that is `orch-bench judge`, paid on its own).

const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const lib = require("../../scripts/orch-lib.js");
const { DEFAULT_MODEL, assertExe, assertNoDatabase, runPass } = require("./run.js");
const { guard, readLines, spent } = require("./spend.js");
const { gitIn } = require("./suite.js");

const ROOT = join(__dirname, "..", "..");
// A counter reading older than this says nothing about the quota now.
const QUOTA_FRESH_MS = 10 * 60 * 1000;

// `orch-quota --json`, or null when it cannot be read. Never throws: the
// campaign's own guard still applies without it.
function readQuota() {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "orch-quota"), "--json", "--no-write"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim().split("\n").at(-1));
  } catch {
    return null;
  }
}

// The five-hour counter against its cap, from a reading that is fresh. A
// reading that is stale, absent or without a figure is ignored, never read as
// zero. Returns { reason } to stop, { ignored } when unusable, or {}.
function quotaCheck({ quota, nextUsd, ratios, capFive, now }) {
  const five = quota?.counters?.five;
  if (!five || !Number.isFinite(five.used) || !Number.isFinite(five.observedAt)) return { ignored: "no usable reading" };
  if (now - five.observedAt > QUOTA_FRESH_MS) return { ignored: "stale reading" };
  if (five.used + nextUsd * ratios.ratio5 > capFive) return { reason: "five-hour cap (counter)" };
  return {};
}

// A lock that a dead process left behind is taken over.
function takeLock(file) {
  mkdirSync(join(file, ".."), { recursive: true });
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });
    return;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const pid = Number(readFileSync(file, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = Number.isInteger(pid) && pid !== process.pid;
  } catch (e) {
    alive = e.code === "EPERM";
  }
  if (alive) throw new Error(`another campaign holds ${file} (pid ${pid})`);
  writeFileSync(file, String(process.pid));
}

function claudeVersion(claude, claudeArgs) {
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

// R7. Written once; a resume must find the same suite.
function writeManifest({ suite, id, campaignDir, claude, claudeArgs, model, ratios, capWeek, capFive, now }) {
  const file = join(campaignDir, "manifest.json");
  if (existsSync(file)) {
    const old = JSON.parse(readFileSync(file, "utf8"));
    if (old.suiteSha256 !== suite.sha256) throw new Error(`the suite changed since campaign ${id} started (manifest.json holds another sha256)`);
    return old;
  }
  const manifest = {
    schema: 1,
    id,
    date: new Date(now).toISOString(),
    claudeCode: claudeVersion(claude, claudeArgs),
    models: {
      executor: model,
      advisor: Object.values(suite.organisations).some((o) => o.advisor !== false) ? "opus" : null,
      judge: suite.judge?.model ?? null,
    },
    plugin: pluginCommit(suite),
    capWeek,
    capFive,
    suite: suite.id,
    suiteSha256: suite.sha256,
    prompts: suite.prompts,
    ratios: { ...ratios },
  };
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// The cells to run, in order: pass index, then task, then organisations
// rotated by the task and the pass so that no organisation always goes first.
function grid({ tasks, orgs, passes }) {
  const cells = [];
  for (let i = 0; i < passes; i++) {
    tasks.forEach((task, ti) => {
      for (let k = 0; k < orgs.length; k++) cells.push({ task, org: orgs[(ti + i + k) % orgs.length], index: i });
    });
  }
  return cells;
}

const money = (c) => (Number.isFinite(c?.usd) ? c.usd.toFixed(3) : "?");

// opts: suite, id, campaignDir, tasks, orgs, passes, capWeek, capFive, ratios,
// claude, claudeArgs, projects, model, timeoutMinutes, allowPort, dbPort,
// quota (a function), log, now (a function).
// Returns { lines, stopped, unjudged, ran }.
async function runCampaign(opts) {
  const { suite, id, campaignDir } = opts;
  const log = opts.log ?? (() => {});
  const claude = opts.claude ?? "claude";
  const claudeArgs = opts.claudeArgs ?? [];
  const now = opts.now ?? Date.now;
  const capWeek = opts.capWeek ?? 10;
  const capFive = opts.capFive ?? 90;
  const model = opts.model ?? DEFAULT_MODEL;
  const ratios = opts.ratios ?? (() => {
    const cal = lib.loadCalibration();
    return { ratio7: cal?.ratio7 ?? null, ratio5: cal?.ratio5 ?? null };
  })();
  if (![ratios.ratio7, ratios.ratio5].every((r) => Number.isFinite(r) && r > 0)) throw new Error("no calibration ratio: the guard cannot convert dollars to points");
  assertExe(claude);
  const tasks = opts.tasks ?? suite.tasks.map((t) => t.id);
  const orgs = opts.orgs ?? Object.keys(suite.organisations);
  for (const t of tasks) if (!suite.tasks.some((x) => x.id === t)) throw new Error(`unknown task: ${t}`);
  for (const o of orgs) if (!suite.organisations[o]) throw new Error(`unknown organisation: ${o}`);
  const passes = opts.passes ?? 1;
  const readQ = opts.quota ?? readQuota;

  await assertNoDatabase(opts);
  mkdirSync(campaignDir, { recursive: true });
  const lock = join(campaignDir, "campaign.lock");
  takeLock(lock);
  const lines = [];
  const say = (text) => {
    lines.push(text);
    log(text);
  };
  let stopped = null;
  let ran = 0;
  try {
    writeManifest({ suite, id, campaignDir, claude, claudeArgs, model, ratios, capWeek, capFive, now: now() });
    const done = new Map();
    for (const p of readLines(join(campaignDir, "passes.jsonl"))) done.set(`${p.task}\0${p.org}`, (done.get(`${p.task}\0${p.org}`) ?? 0) + 1);

    for (const cell of grid({ tasks, orgs, passes })) {
      // Resume: a cell already in passes.jsonl is not redone.
      if ((done.get(`${cell.task}\0${cell.org}`) ?? 0) > cell.index) continue;
      const orgDef = suite.organisations[cell.org];
      const judgeP90 = suite.judge?.p90Usd ?? null;
      const s = spent({ campaignDir, now: now() });
      const nextUsd = orgDef.p90Usd + (judgeP90 ?? 0);
      const verdict = guard({ spent: s, reserveUsd: judgeP90 === null ? 0 : s.unjudged * judgeP90, nextUsd, ratios, capWeek, capFive });
      if (!verdict.ok) {
        stopped = verdict.reason;
        break;
      }
      const q = quotaCheck({ quota: readQ(), nextUsd, ratios, capFive, now: now() });
      if (q.reason) {
        stopped = q.reason;
        break;
      }
      if (q.ignored) log(`orch-quota: ${q.ignored}, ignored`);
      const line = await runPass({ ...opts, claude, claudeArgs, model, ratios, taskId: cell.task, orgId: cell.org, campaignDir });
      ran++;
      done.set(`${cell.task}\0${cell.org}`, (done.get(`${cell.task}\0${cell.org}`) ?? 0) + 1);
      say(`${line.task} ${line.org} ${line.outcome} $${money(line.cost)} ${line.minutes.toFixed(1)} min`);
      // These two touch every pass that follows.
      if (line.outcome === "misconfigured") {
        stopped = `misconfigured (${line.reason})`;
        break;
      }
      if (line.cost?.neverStarted) {
        stopped = `launch failed (${line.reason})`;
        break;
      }
    }
  } finally {
    rmSync(lock, { force: true });
  }

  // R8: the judge is a separate, paid command.
  const unjudged = spent({ campaignDir, now: now() }).unjudged;
  if (stopped) say(`stopped: ${stopped}`);
  say(
    suite.judge
      ? `${unjudged} judgeable pass(es) not judged yet; to judge them: orch-bench judge --suite ${suite.file} --id ${id}`
      : `${unjudged} judgeable pass(es); the suite has no judge field`,
  );
  return { lines, stopped, unjudged, ran };
}

module.exports = { runCampaign, grid, quotaCheck, takeLock, readQuota };
