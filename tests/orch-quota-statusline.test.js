"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { makeAccount, script } = require("./helpers.js");

const HOUR = 3600e3;
const MIN = 60e3;
const now = Date.now();

// An account whose home holds the status line readings; `readings` maps a
// session to { at, five?: { used, resetsAt }, week?: { used, resetsAt } }.
function account(readings = {}, extension = null) {
  const acc = makeAccount();
  const dir = join(acc.home, ".claude", "microverse", "statusline");
  mkdirSync(dir, { recursive: true });
  for (const [session, r] of Object.entries(readings)) writeFileSync(join(dir, `${session}.json`), JSON.stringify({ v: 1, ...r }));
  const file = join(acc.home, "quota.json");
  if (extension) writeFileSync(file, JSON.stringify({ observations: extension }));
  return { acc, file, cwd: acc.project("proj-a") };
}

const ext = (periodType, usedFraction, resetAt, observedAt) => ({ periodType, usedFraction, resetAt, observedAt });
const run = ({ acc, file, cwd }, extra = []) => script("orch-quota", ["--file", file, ...extra], cwd, acc.env);
const counters = (r) => r.out.split("\n").find((l) => l.startsWith("Counters:"));

test("status line readings alone give the advice and the line names the source", () => {
  const fx = account({ s1: { at: now - 3 * MIN, five: { used: 20, resetsAt: now + 2 * HOUR }, week: { used: 52, resetsAt: now + 48 * HOUR } } });
  const r = run(fx);
  assert.equal(r.code, 0);
  assert.match(counters(r), /5h 20 % \(resets [^;]*; status line, 3 min ago\), week 52 % \(resets [^;]*; status line, 3 min ago\)/);
  assert.match(r.out, /Advice:/);
});

test("with neither source the message names the extension file and the status line setup", () => {
  const fx = account();
  const r = run(fx);
  assert.equal(r.code, 1);
  assert.match(r.out, /Counters not found/);
  assert.ok(r.out.includes(fx.file));
  assert.match(r.out, /\/microverse:init/);
});

test("the highest reading of the current window wins, even when a lower one is newer", () => {
  const reset = now + 48 * HOUR;
  const fx = account(
    {
      s1: { at: now - 30 * MIN, week: { used: 45, resetsAt: reset } },
      s2: { at: now - 1 * MIN, week: { used: 40, resetsAt: reset } },
    },
    [ext("seven-day", 0.43, reset, now - 10 * MIN)],
  );
  const r = run(fx);
  assert.match(counters(r), /week 45 % \(resets [^;]*; status line, 1 min ago\)/);
});

test("a reading of the previous weekly window does not hide the current one, even when newer", () => {
  const fx = account({ s1: { at: now - 1 * MIN, week: { used: 90, resetsAt: now - 5 * 24 * HOUR } } }, [
    ext("seven-day", 0.3, now + 48 * HOUR, now - 10 * MIN),
  ]);
  const r = run(fx);
  assert.match(counters(r), /week 30 % \(resets [^;]*; extension, 10 min ago\)/);
});

test("5h readings whose reset has passed count as 0", () => {
  const fx = account(
    { s1: { at: now - MIN, five: { used: 80, resetsAt: now - HOUR }, week: { used: 10, resetsAt: now + 48 * HOUR } } },
    [ext("five-hour", 0.7, now - 2 * HOUR, now - 3 * HOUR), ext("five-hour", 0.9, null, now - MIN)],
  );
  const r = run(fx);
  assert.match(counters(r), /5h 0 %, week 10 %/);
});

test("a weekly reading whose reset has passed is not used", () => {
  const fx = account({}, [ext("seven-day", 0.5, now - HOUR, now - 2 * HOUR), ext("five-hour", 0.1, now + HOUR, now)]);
  const r = run(fx);
  assert.equal(r.code, 1);
  assert.match(r.out, /No current weekly reading/);
});

test("a status line used percentage is shown as the same percentage", () => {
  const fx = account({ s1: { at: now, week: { used: 52, resetsAt: now + 48 * HOUR } } });
  assert.match(counters(run(fx)), /week 52 %/);
});

test("resets 400 ms apart across the sources are one window", () => {
  const reset = now + 48 * HOUR;
  const fx = account({ s1: { at: now - 5 * MIN, week: { used: 44, resetsAt: reset } } }, [ext("seven-day", 0.4, reset + 400, now - MIN)]);
  // Two windows would show the extension's 40 (the later reset).
  assert.match(counters(run(fx)), /week 44 %/);
});

test("a reading older than 2 h triggers the warning, a 30 min old one does not", () => {
  const reading = (age) => ({ s1: { at: now - age, week: { used: 10, resetsAt: now + 48 * HOUR } } });
  const old = run(account(reading(3 * HOUR)));
  assert.match(old.out, /Warning: last reading 3\.0 h ago .*status line/);
  assert.doesNotMatch(run(account(reading(30 * MIN))).out, /Warning/);
});

// Pairs of 5h readings 6 h apart, one request of $2 in each pair; six
// intervals of 1 to 6 points per dollar.
function calibrationAccount(withStatusline) {
  const t0 = now - 3 * 24 * HOUR;
  const readings = {};
  const observations = [];
  let used = 0.05;
  [2, 8, 4, 12, 6, 10].forEach((points, i) => {
    const start = t0 + i * 6 * HOUR;
    const reset = start + 2 * HOUR;
    observations.push(ext("five-hour", used, reset, start));
    used += points / 100;
    observations.push(ext("five-hour", used, reset, start + HOUR));
    used += 0.01;
    // In the same window, in between: paired with the extension ones these would add intervals.
    if (withStatusline) readings[`s${i}`] = { at: start + 30 * MIN, five: { used: (used - 0.01) * 50, resetsAt: reset } };
  });
  observations.push(ext("seven-day", 0.1, now + 48 * HOUR, now));
  const fx = account(readings, observations);
  [2, 8, 4, 12, 6, 10].forEach((_, i) => {
    fx.acc.conversation("proj-a", t0 + i * 6 * HOUR + 10 * MIN, 2);
    fx.acc.conversation("proj-a", t0 + i * 6 * HOUR + 3 * HOUR, 2);
  });
  for (let i = 0; i < 5; i++) fx.acc.agent("proj-a", `m${i}`, "microverse:morty", [{ ts: now - 24 * HOUR, dollars: 1 + i }]);
  return fx;
}

test("status line readings do not change the calibration", () => {
  const lines = (fx) =>
    run(fx, ["--calibrate"])
      .out.split("\n")
      .filter((l) => /^(5h|Week):|median/.test(l));
  const without = lines(calibrationAccount(false));
  const withReadings = lines(calibrationAccount(true));
  assert.ok(without.some((l) => /^5h: .*6 intervals/.test(l)), without.join("\n"));
  assert.ok(without.some((l) => /median/.test(l)));
  assert.deepEqual(withReadings, without);
});

test("an installed copy of the status line script is refreshed, an absent one is not created", () => {
  const fx = account({ s1: { at: now, week: { used: 10, resetsAt: now + 48 * HOUR } } });
  const copy = join(fx.acc.home, ".claude", "microverse", "statusline.js");
  assert.equal(existsSync(copy), false);
  run(fx);
  assert.equal(existsSync(copy), false);
  writeFileSync(copy, "// outdated copy\n");
  run(fx);
  assert.equal(readFileSync(copy, "utf8"), readFileSync(join(__dirname, "..", "scripts", "statusline.js"), "utf8"));
});
