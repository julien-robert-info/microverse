"use strict";

// A campaign: the grid tasks x organisations x passes, run one pass after the
// other under the quota cap. It writes `manifest.json` and `passes.jsonl` and
// never calls the judge (that is `orch-bench judge`, paid on its own).

const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const lib = require("../../scripts/orch-lib.js");
const { DEFAULT_MODEL, QUOTA_FRESH_MS, assertExe, assertNoDatabase, claudeVersion, counted, freshReading, pluginCommit, priceVector, readQuota, runPass } = require("./run.js");
const { guard, readLines, spent } = require("./spend.js");

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

// A lock that a dead process left behind is taken over; one whose content is
// not a pid is left alone, since it may belong to something else.
// The takeover removes the file then creates it exclusively: of two campaigns
// racing for it, only one create succeeds.
function takeLock(file) {
  mkdirSync(join(file, ".."), { recursive: true });
  try {
    writeFileSync(file, String(process.pid), { flag: "wx" });
    return;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const text = readFileSync(file, "utf8").trim();
  const pid = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(pid) || pid < 1) throw new Error(`lock file unreadable, remove it by hand: ${file}`);
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = pid !== process.pid;
  } catch (e) {
    alive = e.code === "EPERM";
  }
  if (alive) throw new Error(`another campaign holds ${file} (pid ${pid})`);
  try {
    unlinkSync(file);
    writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch {
    throw new Error(`another campaign took over ${file}`);
  }
}

// The aliases and their prices are known only once a call has resolved the
// model: the first pass that gives an id adds them to the manifest, through a
// temporary file so that a reader never sees a half-written one.
function recordResolved({ campaignDir, alias, line }) {
  if (!line.model) return;
  const file = join(campaignDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (manifest.resolvedModels) return;
  manifest.resolvedModels = { [alias]: line.model };
  manifest.prices = { [line.model]: priceVector(line.model) };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, file);
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
  // The week margin is checked on a fresh reading before anything is spent:
  // the cap is a share of the week, so what is left of the week must cover it.
  const first = freshReading(readQ(), now());
  if (!first) throw new Error("no fresh orch-quota reading: run orch-quota (a reading is fresh for 10 minutes) and relaunch");
  const remaining = 100 - first.week;
  if (remaining < capWeek) throw new Error(`not enough week margin: ${remaining.toFixed(1)}% of the week left, the campaign cap is ${capWeek}%`);
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
    // A pass that was misconfigured or never started is not counted: a
    // relaunch retries its cell.
    for (const p of readLines(join(campaignDir, "passes.jsonl")).filter(counted)) done.set(`${p.task}\0${p.org}`, (done.get(`${p.task}\0${p.org}`) ?? 0) + 1);

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
      let line;
      try {
        line = await runPass({ ...opts, claude, claudeArgs, model, ratios, taskId: cell.task, orgId: cell.org, campaignDir, campaign: id });
      } catch (e) {
        stopped = `error: ${String(e.message ?? e).split("\n")[0].slice(0, 200)}`;
        break;
      }
      ran++;
      recordResolved({ campaignDir, alias: model, line });
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
      // A process left in the slot, or a sweep that could not tell, would
      // taint the next pass.
      if (line.leftover === null) {
        stopped = `sweep failed (${line.sweepError ?? "unknown"})`;
        break;
      }
      if (line.leftover > 0) {
        stopped = `processes left in the slot (${line.leftover})`;
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
