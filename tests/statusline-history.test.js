"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, makeAccount, script } = require("./helpers.js");
const lib = require(join(ROOT, "scripts", "orch-lib.js"));
const statusline = require(join(ROOT, "scripts", "statusline.js"));

const SCRIPT = join(ROOT, "scripts", "statusline.js");
const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 24 * HOUR;

const newHome = () => realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-history-")));
const histDir = (home) => join(home, ".claude", "microverse", "statusline-history");
const sessionDir = (home) => join(home, ".claude", "microverse", "statusline");
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function render(home, five, week, session = "sess-1") {
  const rate_limits = {};
  if (five) rate_limits.five_hour = { used_percentage: five[0], resets_at: five[1] };
  if (week) rate_limits.seven_day = { used_percentage: week[0], resets_at: week[1] };
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    input: JSON.stringify({ session_id: session, rate_limits }),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: "" },
  });
  return { code: r.status, out: r.stdout };
}

// The history lines of the home, in file order.
function lines(home) {
  let out = [];
  try {
    for (const name of readdirSync(histDir(home)).sort()) {
      out = out.concat(readFileSync(join(histDir(home), name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    }
  } catch {}
  return out;
}

// statusline.js resolves its folders from the home at each call.
function withHome(home, fn) {
  const saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    [process.env.HOME, process.env.USERPROFILE] = saved;
  }
}

// Writes history lines { at, type, used, resetsAt } to their UTC day files.
function writeHistory(home, entries) {
  mkdirSync(histDir(home), { recursive: true });
  for (const e of entries) appendFileSync(join(histDir(home), `${utcDay(e.at)}.jsonl`), JSON.stringify({ v: 1, ...e }) + "\n");
}

test("T1: the first render appends one line per counter, with an integer used and resetsAt in ms; the session file is written", () => {
  const home = newHome();
  const t0 = Date.now();
  render(home, [37.4, 1800000000], [64.6, 1800500000]);
  const got = lines(home);
  assert.equal(got.length, 2);
  const five = got.find((l) => l.type === "five-hour");
  const week = got.find((l) => l.type === "seven-day");
  assert.deepEqual({ v: five.v, used: five.used, resetsAt: five.resetsAt }, { v: 1, used: 37, resetsAt: 1800000000000 });
  assert.deepEqual({ v: week.v, used: week.used, resetsAt: week.resetsAt }, { v: 1, used: 65, resetsAt: 1800500000000 });
  assert.ok(five.at >= t0 && five.at <= Date.now());
  assert.ok(existsSync(join(sessionDir(home), "sess-1.json")));
  // The file is named after the UTC day of `at`.
  assert.deepEqual(readdirSync(histDir(home)), [`${utcDay(five.at)}.jsonl`]);
  const obs = withHome(home, () => statusline.readHistory());
  assert.equal(obs.find((o) => o.periodType === "five-hour").usedFraction, 0.37);
  assert.equal(obs.find((o) => o.periodType === "five-hour").resetAt, 1800000000000);
});

test("T2: the same values append nothing; a higher 5h value appends one 5h line only", () => {
  const home = newHome();
  render(home, [37, 1800000000], [60, 1800500000]);
  render(home, [37, 1800000000], [60, 1800500000]);
  assert.equal(lines(home).length, 2);
  render(home, [38, 1800000000], [60, 1800500000]);
  const got = lines(home);
  assert.equal(got.length, 3);
  assert.deepEqual({ type: got[2].type, used: got[2].used }, { type: "five-hour", used: 38 });
  // The same rounded value with a fractional drift is not a rise.
  render(home, [38.4, 1800000000], [60.2, 1800500000]);
  assert.equal(lines(home).length, 3);
  // A lower value of the same window is not a rise.
  render(home, [30, 1800000000], [60, 1800500000]);
  assert.equal(lines(home).length, 3);
});

test("T1b: the file is named after the UTC day of the line, whatever the local time zone", () => {
  const home = newHome();
  const code = `require(${JSON.stringify(SCRIPT)}).appendHistory([
    { v: 1, at: Date.UTC(2026, 2, 5, 23, 30), type: "five-hour", used: 1, resetsAt: 1 },
    { v: 1, at: Date.UTC(2026, 2, 6, 0, 10), type: "five-hour", used: 2, resetsAt: 1 }])`;
  for (const TZ of ["Pacific/Auckland", "America/Los_Angeles"]) {
    spawnSync(process.execPath, ["-e", code], { env: { ...process.env, HOME: home, USERPROFILE: home, TZ } });
  }
  assert.deepEqual(readdirSync(histDir(home)).sort(), ["2026-03-05.jsonl", "2026-03-06.jsonl"]);
});

test("T3: a new window with a lower value appends a line", () => {
  const home = newHome();
  render(home, [80, 1800000000], null);
  render(home, [3, 1800000000 + 5 * 3600], null);
  const got = lines(home);
  assert.equal(got.length, 2);
  assert.deepEqual({ used: got[1].used, resetsAt: got[1].resetsAt }, { used: 3, resetsAt: (1800000000 + 5 * 3600) * 1000 });
  // A counter the previous reading lacked is appended too.
  render(home, [3, 1800000000 + 5 * 3600], [10, 1800500000]);
  assert.equal(lines(home).length, 3);
  assert.equal(lines(home)[2].type, "seven-day");
});

test("T4: the history line is appended even when the session file cannot be written; a repeat is dropped by risingOnly", () => {
  const home = newHome();
  mkdirSync(join(sessionDir(home), "sess-1.json"), { recursive: true });
  const r1 = render(home, [37, 1800000000], [60, 1800500000]);
  assert.equal(r1.code, 0);
  assert.match(r1.out, /5h 37 %/);
  assert.equal(lines(home).length, 2);
  const r2 = render(home, [37, 1800000000], [60, 1800500000]);
  assert.equal(r2.code, 0);
  assert.equal(lines(home).length, 4);
  const kept = lib.risingOnly(withHome(home, () => statusline.readHistory()));
  assert.equal(kept.length, 2);
});

test("T5: readHistory skips torn, v:2 and non-numeric lines, and ignores other file names", () => {
  const home = newHome();
  const now = Date.now();
  mkdirSync(histDir(home), { recursive: true });
  const good = { v: 1, at: now - HOUR, type: "five-hour", used: 40, resetsAt: now + HOUR };
  writeFileSync(
    join(histDir(home), `${utcDay(now)}.jsonl`),
    [
      JSON.stringify(good),
      '{"v":1,"at":1700000000000,"type":"five-ho',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, used: "40" }),
      JSON.stringify({ ...good, resetsAt: null }),
      JSON.stringify({ ...good, type: "daily" }),
      "not json",
      "",
    ].join("\n") + "\n",
  );
  writeFileSync(join(histDir(home), "notes.jsonl"), JSON.stringify(good) + "\n");
  writeFileSync(join(histDir(home), `${utcDay(now)}.jsonl.bak`), JSON.stringify(good) + "\n");
  const obs = withHome(home, () => statusline.readHistory({ now }));
  assert.deepEqual(obs, [{ periodType: "five-hour", usedFraction: 0.4, resetAt: now + HOUR, observedAt: now - HOUR, source: "statusline" }]);
});

test("T6: readHistory prune deletes the dated files older than 15 days and nothing else", () => {
  const home = newHome();
  const now = Date.now();
  const entry = (days) => ({ at: now - days * DAY, type: "seven-day", used: 10, resetsAt: now + DAY });
  writeHistory(home, [entry(40), entry(16), entry(15), entry(1), entry(0)]);
  writeFileSync(join(histDir(home), "keep.txt"), "x");
  writeFileSync(join(histDir(home), "2020-01-01.jsonl.old"), "x");
  mkdirSync(sessionDir(home), { recursive: true });
  writeFileSync(join(sessionDir(home), "old.json"), JSON.stringify({ v: 1, at: now - 40 * DAY }));
  writeFileSync(join(sessionDir(home), "2020-01-01.jsonl"), "x");

  const before = withHome(home, () => statusline.readHistory({ now }));
  assert.equal(before.length, 3, "files older than 15 days are not read");
  assert.equal(readdirSync(histDir(home)).length, 7, "reading alone deletes nothing");

  withHome(home, () => statusline.readHistory({ now, prune: true }));
  const left = readdirSync(histDir(home)).sort();
  assert.deepEqual(left, [
    "2020-01-01.jsonl.old",
    `${utcDay(now - 15 * DAY)}.jsonl`,
    `${utcDay(now - DAY)}.jsonl`,
    `${utcDay(now)}.jsonl`,
    "keep.txt",
  ].sort());
  assert.deepEqual(readdirSync(sessionDir(home)).sort(), ["2020-01-01.jsonl", "old.json"]);
  // Today's file survives even a nonsensical window.
  withHome(home, () => statusline.readHistory({ now, days: -1, prune: true }));
  assert.ok(existsSync(join(histDir(home), `${utcDay(now)}.jsonl`)));
});

test("T7: risingOnly drops equal and stale lower values, and a new window restarts the running max", () => {
  const R1 = 1e12;
  const R2 = R1 + 5 * HOUR;
  const o = (observedAt, usedFraction, resetAt = R1, periodType = "five-hour") => ({ periodType, usedFraction, resetAt, observedAt });
  const out = lib.risingOnly([
    o(5, 0.5),
    o(1, 0.2),
    o(2, 0.4),
    o(3, 0.4), // equal to the max: dropped
    o(4, 0.3), // session B writes a stale lower value after a higher one: dropped
    o(6, 0.5), // equal to the max: dropped
    o(7, 0.6, R1 + 400), // jitter of the same window, higher: kept
    o(8, 0.1, R2), // new window, lower: kept, restarts the max
    o(9, 0.05, R2), // below the new max: dropped
    o(10, 0.2, R2),
    o(2, 0.9, R1, "seven-day"), // another counter is independent
  ]);
  const five = out.filter((x) => x.periodType === "five-hour").map((x) => [x.observedAt, x.usedFraction]);
  assert.deepEqual(five, [[1, 0.2], [2, 0.4], [5, 0.5], [7, 0.6], [8, 0.1], [10, 0.2]]);
  assert.equal(out.filter((x) => x.periodType === "seven-day").length, 1);
  // Same time, ascending value: the lower one is the first of its window.
  const tie = lib.risingOnly([o(1, 0.3), o(1, 0.2)]);
  assert.deepEqual(tie.map((x) => x.usedFraction), [0.2, 0.3]);
});

// A fixture of the account whose home holds a history and/or an extension file.
function quotaAccount() {
  const acc = makeAccount();
  return { acc, file: join(acc.home, "quota.json"), cwd: acc.project("proj-a") };
}
const run = (fx, extra = []) => script("orch-quota", ["--file", fx.file, ...extra], fx.cwd, fx.acc.env);
const lineOf = (r, prefix) => r.out.split("\n").find((l) => l.startsWith(prefix));

// Latest Monday 00:00 local time not after `t`.
function mondayBefore(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
  return d.getTime();
}

test("T8: the usage at the start of the weekday period comes from the history", (t) => {
  const now = Date.now();
  const monday = mondayBefore(now);
  // The window began Sunday 23:00 and has less than an hour left on Sundays 23:00-24:00 only.
  if (now - monday > 7 * DAY - 2 * HOUR) return t.skip("last hour of the week");
  const fx = quotaAccount();
  const start = monday - HOUR;
  const resetsAt = start + 7 * DAY;
  const home = fx.acc.home;
  writeHistory(home, [
    { at: monday - 30 * MIN, type: "seven-day", used: 30, resetsAt },
    { at: now - 2 * MIN, type: "seven-day", used: 50, resetsAt },
  ]);
  mkdirSync(sessionDir(home), { recursive: true });
  writeFileSync(join(sessionDir(home), "s1.json"), JSON.stringify({ v: 1, at: now - MIN, week: { used: 50, resetsAt } }));
  const r = run(fx);
  assert.equal(r.code, 0, r.out);
  const m = /Pace: expected (\d+) % by now, actual 50 %/.exec(r.out);
  assert.ok(m, r.out);
  const elapsed = (Date.now() - monday) / (resetsAt - monday);
  const fromHistory = 30 + (98 - 30) * elapsed;
  const fromSession = 50 + (98 - 50) * elapsed;
  assert.ok(Math.abs(Number(m[1]) - fromHistory) <= 1.5, `${m[1]} vs ${fromHistory}`);
  if (Math.abs(fromHistory - fromSession) > 4) assert.ok(Math.abs(Number(m[1]) - fromSession) > 1.5);
});

test("T9: the counter age comes from the session file, not an older history line of the same value", () => {
  const fx = quotaAccount();
  const now = Date.now();
  const resetsAt = now + 48 * HOUR;
  const home = fx.acc.home;
  writeHistory(home, [{ at: now - 3 * HOUR, type: "seven-day", used: 52, resetsAt }]);
  mkdirSync(sessionDir(home), { recursive: true });
  writeFileSync(join(sessionDir(home), "s1.json"), JSON.stringify({ v: 1, at: now - 4 * MIN, week: { used: 52, resetsAt } }));
  const r = run(fx);
  assert.match(lineOf(r, "Counters:"), /week 52 % \(resets [^;]*; status line, 4 min ago\)/);
  assert.doesNotMatch(r.out, /Warning: last reading/);
});

// Six windows of `points` each on both counters, with a $2 request in each
// interval: the ratio is points / 2. Returns the readings; `kind` shapes them.
function intervals(acc, base, points) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const start = base + i * 6 * HOUR;
    const resetsAt = start + 2 * HOUR;
    for (const type of ["five-hour", "seven-day"]) {
      out.push({ at: start, type, used: 5, resetsAt });
      out.push({ at: start + HOUR, type, used: 5 + points, resetsAt });
    }
    acc.conversation("proj-a", start + 10 * MIN, 2);
  }
  return out;
}
const asExtension = (rows) => rows.map((e) => ({ periodType: e.type, usedFraction: e.used / 100, resetAt: e.resetsAt, observedAt: e.at }));
const ratioLines = (r) => r.out.split("\n").filter((l) => /^(5h|Week):/.test(l));

test("T10: the extension is the source while it has a reading under 48 hours old, the history otherwise", () => {
  const now = Date.now();
  // Extension with a reading 1 h old: the history, twice as steep, is ignored.
  let fx = quotaAccount();
  const ext = intervals(fx.acc, now - 10 * DAY, 4);
  const current = { periodType: "seven-day", usedFraction: 0.1, resetAt: now + 48 * HOUR, observedAt: now - HOUR };
  writeFileSync(fx.file, JSON.stringify({ observations: [...asExtension(ext), current] }));
  const alone = run(fx, ["--calibrate"]);
  assert.match(alone.out, /from the extension/);
  assert.deepEqual(ratioLines(alone), ["5h: 2 points/$ (6 intervals)", "Week: 2 points/$ (6 intervals)"]);

  fx = quotaAccount();
  intervals(fx.acc, now - 10 * DAY, 4);
  writeFileSync(fx.file, JSON.stringify({ observations: [...asExtension(ext), current] }));
  writeHistory(fx.acc.home, intervals(fx.acc, now - 5 * DAY, 8));
  const both = run(fx, ["--calibrate"]);
  assert.deepEqual(ratioLines(both), ratioLines(alone));
  assert.match(both.out, /from the extension/);

  // Extension last seen 3 days ago: the history is the source.
  fx = quotaAccount();
  const old = intervals(fx.acc, now - 13 * DAY, 4).filter((e) => e.at < now - 3 * DAY);
  writeFileSync(fx.file, JSON.stringify({ observations: asExtension(old) }));
  const hist = intervals(fx.acc, now - 5 * DAY, 8);
  writeHistory(fx.acc.home, [...hist, { at: now - HOUR, type: "seven-day", used: 10, resetsAt: now + 48 * HOUR }]);
  const fromHistory = run(fx, ["--calibrate"]);
  assert.match(fromHistory.out, /Calibration of \S+Z from the status line history, intervals since/);
  assert.deepEqual(ratioLines(fromHistory), ["5h: 4 points/$ (6 intervals)", "Week: 4 points/$ (6 intervals)"]);
  assert.equal(JSON.parse(readFileSync(join(fx.acc.data, "calibration.json"), "utf8")).source, "statusline");
});

test("T11: a source switch skips the plan-change comparison; a stored extension calibration still detects a change", () => {
  const now = Date.now();
  const acc = makeAccount();
  const rows = intervals(acc, now - 40 * HOUR, 12).map((e) => ({ periodType: e.type, usedFraction: e.used / 100, resetAt: e.resetsAt, observedAt: e.at }));
  const files = lib.walkTranscripts(join(acc.home, ".claude", "projects"));
  const since = now - 5 * DAY;
  const stored = { at: now - DAY, ratio5: 1, n5: 8, ratio7: 1, n7: 8, since, change: null, roles: {} };
  // History ratio 6 points/$, more than twice the stored 1 of the extension.
  const switched = lib.computeCalibration({ files, observations: rows, now, previous: { ...stored, source: "extension" }, source: "statusline" });
  assert.equal(switched.change, null);
  assert.equal(switched.since, since);
  assert.equal(switched.source, "statusline");
  assert.ok(Math.abs(switched.ratio5 - 6) < 1e-9);
  // No `source` in the stored calibration means the extension: same extension source, real change.
  const changed = lib.computeCalibration({ files, observations: rows, now, previous: stored, source: "extension" });
  assert.match(changed.change, /Calibration changed \(subscription\?\): 5h 1→6/);
  assert.equal(changed.source, "extension");
  assert.ok(changed.since > now - 49 * HOUR);
  // With `since` set and too few history intervals, the extension's ratio and n
  // are not carried over, and the next run reports no change.
  const few = rows.filter((o) => o.observedAt < now - 40 * HOUR + 18 * HOUR);
  const first = lib.computeCalibration({ files, observations: few, now, previous: { ...stored, source: "extension" }, source: "statusline" });
  assert.equal(first.ratio5, null);
  assert.equal(first.n5, 3);
  assert.equal(first.ratio7, null);
  assert.equal(first.since, since);
  const second = lib.computeCalibration({ files, observations: rows, now, previous: first, source: "statusline" });
  assert.equal(second.change, null);
  assert.equal(second.since, since);
  // A stored statusline calibration compared with the extension is a switch too.
  const back = lib.computeCalibration({ files, observations: rows, now, previous: { ...stored, source: "statusline" }, source: "extension" });
  assert.equal(back.change, null);
});
