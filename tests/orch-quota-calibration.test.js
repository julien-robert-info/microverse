"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { makeAccount, script } = require("./helpers.js");

const HOUR = 3600e3;
const days = (n) => Date.now() - n * 24 * HOUR;

// Pairs of readings of the 5h counter, one pair per interval, 6 h apart so that
// the pairs differ in window and only the two readings of a pair make an
// interval. Each interval gets `points` and one request of `dollars` in
// `project`; `t0` is the first pair's start.
function accountWith(intervals, t0, week = false) {
  const acc = makeAccount();
  const observations = [];
  // The counter keeps rising between pairs and each gap holds a $2 request: if
  // readings of different windows were paired, the gap would be an interval too.
  let used = 0.05;
  intervals.forEach((iv, i) => {
    const start = iv.start ?? t0 + i * 6 * HOUR;
    const reset = start + 2 * HOUR;
    const types = week ? ["five-hour", "seven-day"] : ["five-hour"];
    for (const periodType of types) observations.push({ periodType, usedFraction: used, resetAt: reset, observedAt: start });
    used += iv.points / 100;
    for (const periodType of types) observations.push({ periodType, usedFraction: used, resetAt: reset, observedAt: start + HOUR });
    used += 0.01;
    acc.conversation(iv.project ?? "proj-a", start + 10 * 60e3, iv.dollars);
    acc.conversation("proj-a", start + 3 * HOUR, 2);
  });
  const now = Date.now();
  observations.push({ periodType: "seven-day", usedFraction: 0.1, resetAt: now + 48 * HOUR, observedAt: now });
  const file = join(acc.home, "quota.json");
  writeFileSync(file, JSON.stringify({ observations }));
  return { acc, file, cwd: acc.project("proj-a") };
}

const run = ({ acc, file, cwd }, extra = []) => script("orch-quota", ["--file", file, ...extra], cwd, acc.env);
const stored = (acc) => JSON.parse(readFileSync(join(acc.data, "calibration.json"), "utf8"));

// Six usable intervals at 1, 4, 2, 6, 3 and 5 points per dollar, in two
// projects, then one under $1 and one without any point gained.
const SIX = [
  { points: 2, dollars: 2, project: "proj-a" },
  { points: 8, dollars: 2, project: "proj-b" },
  { points: 4, dollars: 2, project: "proj-a" },
  { points: 12, dollars: 2, project: "proj-b" },
  { points: 6, dollars: 2, project: "proj-a" },
  { points: 10, dollars: 2, project: "proj-b" },
  { points: 3, dollars: 0.4, project: "proj-a" },
  { points: 0, dollars: 2, project: "proj-b" },
];

test("running agents are counted on the whole account, meeseeks and idle ones left out", () => {
  const acc = makeAccount();
  const cwd = acc.project("proj-a");
  acc.project("proj-b");
  const t = Date.now();
  acc.agent("proj-a", "a1", "microverse:morty", [{ ts: t, dollars: 1 }]);
  acc.agent("proj-a", "a2", "microverse:rick", [{ ts: t, dollars: 1 }], 60 * 60e3);
  acc.agent("proj-a", "a3", "microverse:meeseeks", [{ ts: t, dollars: 1 }]);
  acc.agent("proj-b", "b1", "microverse:council", [{ ts: t, dollars: 1 }], 5 * 60e3);
  acc.agent("proj-b", "b2", "microverse:rick", [{ ts: t, dollars: 1 }]);
  acc.agent("proj-b", "b3", "microverse:meeseeks", [{ ts: t, dollars: 1 }]);
  const file = join(acc.home, "quota.json");
  writeFileSync(file, JSON.stringify({ observations: [{ periodType: "seven-day", usedFraction: 0.1, resetAt: t + 48 * HOUR, observedAt: t }] }));
  const r = script("orch-quota", ["--file", file], cwd, acc.env);
  assert.match(r.out, /Running: 3 agents \(2 in other projects\)/);
});

test("an explicit --running overrides the detection", () => {
  const acc = makeAccount();
  const cwd = acc.project("proj-a");
  const t = Date.now();
  acc.agent("proj-b", "b1", "microverse:morty", [{ ts: t, dollars: 1 }]);
  const file = join(acc.home, "quota.json");
  writeFileSync(file, JSON.stringify({ observations: [{ periodType: "seven-day", usedFraction: 0.1, resetAt: t + 48 * HOUR, observedAt: t }] }));
  const r = script("orch-quota", ["--file", file, "--running", "1"], cwd, acc.env);
  assert.match(r.out, /Running: 1 agent \(given\)/);
  assert.doesNotMatch(r.out, /other projects/);
});

test("the ratio is the 25th percentile of the usable intervals of all projects", () => {
  const fx = accountWith(SIX, days(6));
  const r = run(fx, ["--calibrate"]);
  assert.equal(r.code, 0, r.out);
  // Ratios 1, 4, 2, 6, 3, 5: sorted, the quantile sits a quarter of the way from 2 to 3.
  assert.match(r.out, /5h: 2\.25 points\/\$ \(6 intervals\)/);
  assert.match(r.out, /Week: none/);
  assert.ok(Math.abs(stored(fx.acc).ratio5 - 2.25) < 1e-9);
});

test("fewer than five usable intervals give no calibration and the default agent cost", () => {
  const fx = accountWith(SIX.slice(0, 4), days(6));
  const r = run(fx, ["--calibrate"]);
  assert.match(r.out, /5h: none \(4 intervals/);
  assert.match(r.out, /Agent cost: 15 points of 5h \(default\)/);
  assert.equal(stored(fx.acc).ratio5, null);
});

// Five runs per role at the given costs, finished an hour ago, two days back.
function addRuns(acc, role, costs) {
  costs.forEach((c, i) => acc.agent("proj-b", `${role}${i}`, `microverse:${role}`, [{ ts: days(2), dollars: c }], HOUR));
}

test("the agent cost is the 5h ratio times the larger of rick and morty plus council", () => {
  // rick above morty + council: 2.25 x 20 = 45.
  let fx = accountWith(SIX, days(6));
  addRuns(fx.acc, "rick", [16, 18, 20, 22, 30]);
  addRuns(fx.acc, "morty", [4, 6, 6, 8, 10]);
  addRuns(fx.acc, "council", [1, 2, 2, 3, 4]);
  let r = run(fx, ["--calibrate"]);
  assert.match(r.out, /rick: median \$20\.00 \(5 runs\)/);
  assert.match(r.out, /Agent cost: ~45 points of 5h \(learned from 15 runs\)/);
  // morty + council above rick: 2.25 x (10 + 5) = 33.75.
  fx = accountWith(SIX, days(6));
  addRuns(fx.acc, "rick", [1, 2, 2, 3, 4]);
  addRuns(fx.acc, "morty", [8, 9, 10, 11, 12]);
  addRuns(fx.acc, "council", [3, 4, 5, 6, 7]);
  r = run(fx, ["--calibrate"]);
  assert.match(r.out, /Agent cost: ~34 points of 5h \(learned from 15 runs\)/);
  // An explicit --agent-cost wins.
  r = run(fx, ["--agent-cost", "7"]);
  assert.match(r.out, /Agent cost: 7 points of 5h \(given\)/);
});

test("a role with fewer than five runs is not used, and a running agent is not a finished run", () => {
  const fx = accountWith(SIX, days(6));
  addRuns(fx.acc, "morty", [4, 6, 6, 8, 10]);
  addRuns(fx.acc, "council", [1, 2, 2, 3]);
  fx.acc.agent("proj-b", "council-live", "microverse:council", [{ ts: days(2), dollars: 2 }]);
  const r = run(fx, ["--calibrate"]);
  assert.match(r.out, /council: no median \(4 runs/);
  assert.match(r.out, /Agent cost: 15 points of 5h \(default\)/);
});

test("a ratio three times the stored one is reported and used, one and a half times is not", () => {
  // The old plan (2 points/$, 5 to 10 days back) keeps the 14-day ratio at 2, so
  // only the change branch can produce the 6 of the last 48 h.
  const oldPlan = SIX.slice(0, 6).map((iv, i) => ({ ...iv, points: iv.dollars * 2, start: Date.now() - 10 * 24 * HOUR + i * 6 * HOUR }));
  const recent = SIX.slice(0, 6).map((iv, i) => ({ ...iv, points: iv.dollars * 6, start: Date.now() - 40 * HOUR + i * 6 * HOUR }));
  const intervals = [...oldPlan, ...recent];
  const old = { at: Date.now() - 24 * HOUR, ratio5: 2, n5: 8, ratio7: null, n7: 0, since: null, change: null, roles: {} };
  let fx = accountWith(intervals, 0);
  mkdirSync(fx.acc.data, { recursive: true });
  writeFileSync(join(fx.acc.data, "calibration.json"), JSON.stringify(old));
  let r = run(fx, ["--calibrate"]);
  assert.match(r.out, /Calibration changed \(subscription\?\): 5h 2→6 points\/\$/);
  assert.ok(Math.abs(stored(fx.acc).ratio5 - 6) < 1e-9);
  assert.ok(stored(fx.acc).since > Date.now() - 49 * HOUR);
  // The message stays with the stored calibration until it is recomputed.
  assert.match(run(fx).out, /Calibration changed/);

  fx = accountWith(intervals, 0);
  mkdirSync(fx.acc.data, { recursive: true });
  writeFileSync(join(fx.acc.data, "calibration.json"), JSON.stringify({ ...old, ratio5: 4 }));
  r = run(fx, ["--calibrate"]);
  assert.doesNotMatch(r.out, /Calibration changed/);
  assert.ok(Math.abs(stored(fx.acc).ratio5 - 2) < 1e-9);
  assert.equal(stored(fx.acc).since, null);
});

const plans = () => [
  ...SIX.slice(0, 6).map((iv, i) => ({ ...iv, points: iv.dollars * 2, start: Date.now() - 10 * 24 * HOUR + i * 6 * HOUR })),
  ...SIX.slice(0, 6).map((iv, i) => ({ ...iv, points: iv.dollars * 6, start: Date.now() - 40 * HOUR + i * 6 * HOUR })),
];
const withStored = (fx, cal) => {
  mkdirSync(fx.acc.data, { recursive: true });
  writeFileSync(join(fx.acc.data, "calibration.json"), JSON.stringify({ at: 0, n5: 8, n7: 8, since: null, change: null, roles: {}, ...cal }));
};

test("a plan change narrows both counters to the same window", () => {
  const fx = accountWith(plans(), 0, true);
  // The week ratio is within x2 of the recent 6: only the 5h counter changed.
  withStored(fx, { ratio5: 2, ratio7: 5 });
  const r = run(fx, ["--calibrate"]);
  assert.match(r.out, /Calibration changed \(subscription\?\): 5h 2→6 points\/\$/);
  assert.doesNotMatch(r.out, /changed.*week \d+(\.\d+)?→/);
  assert.ok(Math.abs(stored(fx.acc).ratio7 - 6) < 1e-9);
});

test("a window narrowed more than 14 days ago is dropped, with the ratio it kept", () => {
  const fx = accountWith(SIX.slice(0, 3), days(6));
  withStored(fx, { ratio5: 2, ratio7: null, since: Date.now() - 20 * 24 * HOUR });
  run(fx, ["--calibrate"]);
  assert.equal(stored(fx.acc).ratio5, null);
  assert.equal(stored(fx.acc).since, null);
});

test("a calibration that cannot be saved is still used and reported as not saved", () => {
  const fx = accountWith(SIX, days(6));
  // A file where the data folder should be: the save fails, the computation does not.
  writeFileSync(join(fx.acc.home, "blocked"), "");
  const r = script("orch-quota", ["--file", fx.file, "--calibrate"], fx.cwd, { ...fx.acc.env, CLAUDE_PLUGIN_DATA: join(fx.acc.home, "blocked", "data") });
  assert.match(r.out, /5h: 2\.25 points\/\$/);
  assert.match(r.out, /Calibration not saved: /);
  assert.doesNotMatch(r.out, /Calibration unavailable/);
});

test("a fresh calibration is reused without reading the transcripts, --calibrate recomputes", () => {
  const fx = accountWith(SIX, days(6));
  addRuns(fx.acc, "rick", [16, 18, 20, 22, 30]);
  // A role without a median leaves the default, whatever the others say.
  assert.match(run(fx, ["--calibrate"]).out, /Agent cost: 15 points of 5h \(default\)/);
  addRuns(fx.acc, "morty", [4, 6, 6, 8, 10]);
  addRuns(fx.acc, "council", [1, 2, 2, 3, 4]);
  const first = run(fx, ["--calibrate"]).out;
  assert.match(first, /Agent cost: ~45 points of 5h \(learned from 15 runs\)/);
  rmSync(join(fx.acc.home, ".claude"), { recursive: true });
  assert.match(run(fx).out, /Agent cost: ~45 points of 5h \(learned from 15 runs\)/);
  // Recomputed without the transcripts: nothing left to calibrate on.
  assert.match(run(fx, ["--calibrate"]).out, /5h: none/);
  assert.match(run(fx).out, /Agent cost: 15 points of 5h \(default\)/);
});
