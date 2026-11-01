"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { ROOT, makeAccount, script } = require("./helpers.js");
const statusline = require("../scripts/statusline.js");

const HOUR = 3600e3;
const MIN = 60e3;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const reading = (acc, args) => script("orch-reading", args, acc.home, acc.env);
const both = (five, week) => ["--five-hour", String(five.pct), "--five-hour-resets", iso(five.at), "--week", String(week.pct), "--week-resets", iso(week.at)];
const desktopFile = (acc) => join(acc.home, ".claude", "microverse", "statusline", "desktop.json");
const historyDir = (acc) => join(acc.home, ".claude", "microverse", "statusline-history");
const historyLines = (acc) => {
  try {
    return readdirSync(historyDir(acc)).flatMap((f) => readFileSync(join(historyDir(acc), f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  } catch {
    return [];
  }
};
// readReadings reads the home of the running process: point it at the account's.
function readBack(acc) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: acc.home, USERPROFILE: acc.home });
  try {
    return statusline.readReadings({ now, prune: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test("two windows write desktop.json in the reading format and history lines", () => {
  const acc = makeAccount();
  const five = { pct: 1, at: now + 2 * HOUR + 123 };
  const week = { pct: 42.4, at: now + 5 * 24 * HOUR + 199 };
  const r = reading(acc, both(five, week));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out.trim(), /^Recorded: 5h 1 % \(resets \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\), week 42 % \(resets \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)$/);
  const file = JSON.parse(readFileSync(desktopFile(acc), "utf8"));
  assert.equal(file.v, 1);
  assert.ok(Math.abs(file.at - now) < 60e3);
  assert.deepEqual(file.five, { used: 1, resetsAt: five.at });
  assert.deepEqual(file.week, { used: 42.4, resetsAt: week.at });
  const lines = historyLines(acc);
  assert.deepEqual(lines.map((l) => [l.type, l.used, l.resetsAt]).sort(), [["five-hour", 1, five.at], ["seven-day", 42, week.at]].sort());
  const back = readBack(acc);
  assert.equal(back.length, 1);
  assert.equal(back[0].session, "desktop");
  assert.deepEqual(back[0].five, file.five);
});

test("one window writes only that window", () => {
  const acc = makeAccount();
  const r = reading(acc, ["--week", "55", "--week-resets", iso(now + 3 * 24 * HOUR)]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out.trim(), /^Recorded: week 55 % \(resets /);
  assert.doesNotMatch(r.out, /5h/);
  const file = JSON.parse(readFileSync(desktopFile(acc), "utf8"));
  assert.ok(file.week && !("five" in file));
  assert.deepEqual(historyLines(acc).map((l) => l.type), ["seven-day"]);
});

test("refused inputs exit 2 with one line and write nothing", () => {
  const ok = iso(now + 2 * HOUR);
  const cases = {
    "non-numeric percentage": ["--five-hour", "abc", "--five-hour-resets", ok],
    "percentage above 100": ["--five-hour", "101", "--five-hour-resets", ok],
    "negative percentage": ["--week", "-5", "--week-resets", ok],
    "unreadable date": ["--five-hour", "10", "--five-hour-resets", "tomorrow"],
    "date without a zone": ["--five-hour", "10", "--five-hour-resets", "2099-01-01T10:00:00"],
    "date already past": ["--week", "10", "--week-resets", iso(now - MIN)],
    "unknown flag": ["--five-hour", "10", "--five-hour-resets", ok, "--month", "3"],
    "no window": [],
    "percentage without its date": ["--five-hour", "10"],
    "date without its percentage": ["--week-resets", ok],
    "valid window next to an invalid one": ["--five-hour", "10", "--five-hour-resets", ok, "--week", "200", "--week-resets", ok],
  };
  for (const [name, args] of Object.entries(cases)) {
    const acc = makeAccount();
    const r = reading(acc, args);
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.equal(r.out.trim().split("\n").length, 1, name);
    assert.equal(existsSync(desktopFile(acc)), false, name);
    assert.deepEqual(historyLines(acc), [], name);
  }
});

test("a second call replaces the desktop reading", () => {
  const acc = makeAccount();
  assert.equal(reading(acc, both({ pct: 10, at: now + 2 * HOUR }, { pct: 20, at: now + 3 * 24 * HOUR })).code, 0);
  const second = reading(acc, ["--five-hour", "30", "--five-hour-resets", iso(now + 2 * HOUR)]);
  assert.equal(second.code, 0, second.out);
  const file = JSON.parse(readFileSync(desktopFile(acc), "utf8"));
  assert.equal(file.five.used, 30);
  assert.ok(!("week" in file), "the first call's week is gone");
  assert.equal(readBack(acc).length, 1);
});

test("the desktop reading survives pruning while in its window", () => {
  const acc = makeAccount();
  assert.equal(reading(acc, ["--week", "40", "--week-resets", iso(now + 6 * 24 * HOUR)]).code, 0);
  // Pruning (as orch-quota does when it writes) keeps a reading younger than 8 days.
  assert.equal(readBack(acc).length, 1);
  assert.equal(existsSync(desktopFile(acc)), true);
  // An old one goes.
  const old = JSON.parse(readFileSync(desktopFile(acc), "utf8"));
  writeFileSync(desktopFile(acc), JSON.stringify({ ...old, at: now - 9 * 24 * HOUR }));
  assert.equal(readBack(acc).length, 0);
  assert.equal(existsSync(desktopFile(acc)), false);
});

// An account with an extension reading file and terminal readings.
function quotaRun(acc, extension) {
  const file = join(acc.home, "quota.json");
  writeFileSync(file, JSON.stringify({ observations: extension }));
  return script("orch-quota", ["--file", file], acc.project("proj-a"), acc.env);
}
const ext = (periodType, usedFraction, resetAt, observedAt) => ({ periodType, usedFraction, resetAt, observedAt });

test("orch-quota shows the fresh desktop reading, not the warning for a 10 h old extension reading", () => {
  const acc = makeAccount();
  const old = [ext("five-hour", 0.2, now + 2 * HOUR, now - 10 * HOUR), ext("seven-day", 0.3, now + 48 * HOUR, now - 10 * HOUR)];
  const before = quotaRun(acc, old);
  assert.match(before.out, /Warning: last reading 10 h ago/);
  assert.match(before.out, /week 30 %/);
  const w = reading(acc, both({ pct: 61, at: now + 2 * HOUR + 400 }, { pct: 47, at: now + 48 * HOUR + 400 }));
  assert.equal(w.code, 0, w.out);
  const after = quotaRun(acc, old);
  const counters = after.out.split("\n").find((l) => l.startsWith("Counters:"));
  assert.match(counters, /5h 61 %/);
  assert.match(counters, /week 47 %/);
  assert.doesNotMatch(after.out, /Warning: last reading/);
});

test("a desktop reading and an extension one a second apart are one window; a week apart, two", () => {
  const { mergeReadings, statuslineObservations } = require("../scripts/orch-lib.js");
  const reset = now + 2 * 24 * HOUR;
  const desktop = statuslineObservations([{ at: now - MIN, week: { used: 44, resetsAt: reset } }]);
  const near = mergeReadings({ extensionObs: [ext("seven-day", 0.4, reset + 1000, now - 5 * MIN)], statuslineObs: desktop, historyObs: [], now });
  // Two windows would return the extension's 40, the later reset.
  assert.equal(Math.round(near.w.usedFraction * 100), 44);
  const far = mergeReadings({ extensionObs: [ext("seven-day", 0.4, reset + 7 * 24 * HOUR, now - 5 * MIN)], statuslineObs: desktop, historyObs: [], now });
  assert.equal(Math.round(far.w.usedFraction * 100), 40);
  assert.equal(far.w.resetAt, reset + 7 * 24 * HOUR);
});

test("a terminal reading higher than the desktop one of the same window still counts", () => {
  const acc = makeAccount();
  const reset = now + 48 * HOUR;
  assert.equal(reading(acc, ["--week", "40", "--week-resets", iso(reset)]).code, 0);
  const dir = join(acc.home, ".claude", "microverse", "statusline");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "term1.json"), JSON.stringify({ v: 1, at: now - 2 * MIN, week: { used: 48, resetsAt: reset } }));
  const out = quotaRun(acc, []).out;
  assert.match(out.split("\n").find((l) => l.startsWith("Counters:")), /week 48 %/);
});

test("quota-guard asks for confirmation for a morty at 5h 95 % from a desktop reading", () => {
  const acc = makeAccount();
  const project = acc.project("proj");
  mkdirSync(join(project, ".claude", "orchestration"), { recursive: true });
  writeFileSync(join(project, ".claude", "orchestration", "profile.json"), "{}");
  const w = reading(acc, both({ pct: 95, at: now + 2 * HOUR }, { pct: 10, at: now + 48 * HOUR }));
  assert.equal(w.code, 0, w.out);
  const payload = { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "microverse:morty", model: "sonnet", description: "x", prompt: "y" }, cwd: project };
  const env = { ...process.env, ...acc.env, APPDATA: acc.home, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_OPTION_QUOTA_FILE: join(acc.home, "missing.json") };
  for (const k of ["WEEK_TARGET", "WEEKDAY_RESERVE", "FIVE_HOUR_LIMIT"]) delete env[`CLAUDE_PLUGIN_OPTION_${k}`];
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "quota-guard.js")], { input: JSON.stringify(payload), encoding: "utf8", env });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, "ask");
  assert.match(out.permissionDecisionReason, /^Quota: no /);
  assert.match(out.permissionDecisionReason, /5h 95 %/);
});

const markerFile = (acc) => join(acc.home, ".claude", "microverse", "quota-mode.json");
const env = (acc) => ({ ...acc.env, APPDATA: acc.home });

test("--none writes the marker beside, not inside, the readings, and deletes no reading", () => {
  const acc = makeAccount();
  assert.equal(reading(acc, both({ pct: 1, at: now + 2 * HOUR }, { pct: 2, at: now + 48 * HOUR })).code, 0);
  const r = script("orch-reading", ["--none"], acc.home, env(acc));
  assert.equal(r.code, 0, r.out);
  const m = JSON.parse(readFileSync(markerFile(acc), "utf8"));
  assert.deepEqual(Object.keys(m).sort(), ["at", "mode", "source", "v"]);
  assert.deepEqual({ v: m.v, mode: m.mode, source: m.source }, { v: 1, mode: "off", source: "get_usage" });
  assert.ok(Math.abs(m.at - Date.now()) < 60e3);
  assert.ok(existsSync(desktopFile(acc)));
  assert.equal(readdirSync(join(acc.home, ".claude", "microverse", "statusline")).join(), "desktop.json");
  assert.equal(script("orch-reading", ["--none", "--source", "user"], acc.home, env(acc)).code, 0);
  assert.equal(JSON.parse(readFileSync(markerFile(acc), "utf8")).source, "user");
});

test("T9: --none with a counter flag, a bad --source, or --source alone is refused and writes nothing", () => {
  const acc = makeAccount();
  for (const args of [["--none", "--week", "40"], ["--none", "--week", "40", "--week-resets", iso(now + 48 * HOUR)], ["--none", "--source", "bogus"], ["--source", "user"], ["--none", "--none"]]) {
    const r = script("orch-reading", args, acc.home, env(acc));
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}`);
  }
  assert.ok(!existsSync(markerFile(acc)));
  assert.ok(!existsSync(desktopFile(acc)));
});
