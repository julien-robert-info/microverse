"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, makeAccount, makeRepo, script } = require("./helpers.js");
const lib = require("../scripts/orch-lib.js");

const HOUR = 3600e3;
const MIN = 60e3;
const now = Date.now();

// An account whose home holds what the sources would: status line readings
// (session -> { at, week?, five? }), extension observations, a marker.
function account({ readings = {}, extension = null, marker = null } = {}) {
  const acc = makeAccount();
  const sdir = join(acc.home, ".claude", "microverse", "statusline");
  mkdirSync(sdir, { recursive: true });
  for (const [session, r] of Object.entries(readings)) writeFileSync(join(sdir, `${session}.json`), JSON.stringify({ v: 1, ...r }));
  const file = join(acc.home, "quota.json");
  if (extension) writeFileSync(file, JSON.stringify({ observations: extension }));
  if (marker) writeFileSync(join(acc.home, ".claude", "microverse", "quota-mode.json"), JSON.stringify({ v: 1, mode: "off", ...marker }));
  // APPDATA: the extension file is searched there under Windows.
  const env = { ...acc.env, APPDATA: acc.home, CLAUDE_PLUGIN_OPTION_QUOTA_MODE: undefined };
  return { acc, file, env, cwd: acc.project("proj-a"), extension };
}

const current = (at) => ({ s1: { at, five: { used: 20, resetsAt: now + 2 * HOUR }, week: { used: 52, resetsAt: now + 48 * HOUR } } });
const stale = () => [{ periodType: "seven-day", usedFraction: 0.5, resetAt: now - 2 * HOUR, observedAt: now - 3 * 24 * HOUR }];

// Pass --file only when the fixture wrote one: without it the default location
// (under the temporary APPDATA / HOME) is used.
const quota = (fx, extra = [], env = {}) =>
  script("orch-quota", [...(fx.extension ? ["--file", fx.file] : []), "--no-write", "--running", "0", "--agent-cost", "15", ...extra], fx.cwd, { ...fx.env, ...env });
const asJson = (fx, extra = [], env = {}) => {
  const r = quota(fx, ["--json", ...extra], env);
  const lines = r.out.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, r.out);
  return { code: r.code, out: JSON.parse(lines[0]) };
};

test("T1: quota_mode=off is off whatever the readings, in text and JSON", () => {
  const fx = account({ readings: current(now - MIN) });
  const t = quota(fx, ["--mode", "off"]);
  assert.equal(t.code, 0, t.out);
  assert.equal(t.out.trim(), "Quota: off (quota_mode=off)\nAdvice: no quota: no pacing");
  const { code, out } = asJson(fx, ["--mode", "off"]);
  assert.equal(code, 0);
  assert.deepEqual(out, {
    v: 1,
    mode: "off",
    reason: "quota_mode=off",
    error: "Quota off (quota_mode=off): no pacing.",
    advice: { level: "off", text: "no quota: no pacing", more: 0 },
  });
  // The option also arrives through the environment when --mode is empty or unexpanded.
  for (const flag of ["", "${user_config.quota_mode}"]) assert.match(quota(fx, ["--mode", flag], { CLAUDE_PLUGIN_OPTION_QUOTA_MODE: "off" }).out, /^Quota: off \(quota_mode=off\)$/m);
});

test("T2: a marker newer than every reading is off, with the source it names", () => {
  for (const [source, text] of [["get_usage", "from get_usage"], ["user", "said by the user"]]) {
    const fx = account({ readings: current(now - 10 * MIN), extension: stale(), marker: { at: now - MIN, source } });
    const t = quota(fx);
    assert.equal(t.code, 0, t.out);
    assert.equal(t.out.trim(), `Quota: off (no quota windows, ${text})\nAdvice: no quota: no pacing`);
    const { out } = asJson(fx);
    assert.equal(out.mode, "off");
    assert.equal(out.reason, `no quota windows, ${text}`);
    assert.ok("error" in out);
  }
});

test("T3: a marker older than a current weekly reading is metered", () => {
  const fx = account({ readings: current(now - 10 * MIN), marker: { at: now - HOUR, source: "get_usage" } });
  const t = quota(fx);
  assert.equal(t.code, 0, t.out);
  assert.match(t.out, /^Counters: 5h 20 %.*week 52 %/m);
  assert.doesNotMatch(t.out, /Quota: off/);
  assert.equal(asJson(fx).out.mode, "metered");
});

test("T4: no marker and a current reading is metered, with the figures of before plus mode", () => {
  const fx = account({ readings: current(now - MIN) });
  const t = quota(fx);
  assert.match(t.out, /^Counters: 5h 20 %.*week 52 %/m);
  assert.match(t.out, /^Advice: /m);
  const { code, out } = asJson(fx);
  assert.equal(code, 0);
  assert.equal(out.mode, "metered");
  assert.equal(out.counters.week.used, 52);
  assert.ok(out.pace && out.advice && out.limits && !("error" in out));
});

test("T5: readings that are all old ask for the counters, or for orch-reading --none", () => {
  const fx = account({ extension: stale() });
  const t = quota(fx);
  assert.equal(t.code, 1);
  assert.equal(t.out.trim(), "No current weekly reading: ask the user for the counters, or run orch-reading --none if the plan has no limits.");
  const { code, out } = asJson(fx);
  assert.equal(code, 1);
  assert.match(out.error, /orch-reading --none/);
  // An older marker does not lift the question.
  const withMarker = account({ extension: stale(), marker: { at: now - 10 * 24 * HOUR, source: "user" } });
  assert.equal(quota(withMarker).code, 1);
});

test("T6: no source at all is off (no counter source), nothing written", () => {
  const fx = account();
  const t = quota(fx);
  assert.equal(t.code, 0, t.out);
  assert.equal(t.out.trim(), "Quota: off (no counter source)\nAdvice: no quota: no pacing");
  const { out } = asJson(fx);
  assert.equal(out.mode, "off");
  assert.equal(out.reason, "no counter source");
  assert.ok(!existsSync(join(fx.acc.home, ".claude", "microverse", "quota-mode.json")));
});

test("T7: an unknown value is read as auto with a warning", () => {
  const fx = account({ readings: current(now - MIN) });
  const t = quota(fx, ["--mode", "banana"]);
  assert.equal(t.code, 0, t.out);
  assert.equal(t.out.split("\n")[0], 'Warning: quota_mode "banana" unknown, read as auto.');
  assert.match(t.out, /^Counters: /m);
  const { out } = asJson(fx, ["--mode", "banana"]);
  assert.equal(out.mode, "metered");
  assert.ok(out.warnings.includes('Warning: quota_mode "banana" unknown, read as auto.'));
  // The same through the environment.
  assert.match(quota(fx, [], { CLAUDE_PLUGIN_OPTION_QUOTA_MODE: "banana" }).out, /^Warning: quota_mode "banana" unknown/);
});

test("T8: a marker written by orch-reading is lifted by a later status line reading", () => {
  const fx = account();
  const w = script("orch-reading", ["--none"], fx.cwd, fx.env);
  assert.equal(w.code, 0, w.out);
  assert.match(quota(fx).out, /^Quota: off \(no quota windows, from get_usage\)$/m);
  const marker = JSON.parse(readFileSync(join(fx.acc.home, ".claude", "microverse", "quota-mode.json"), "utf8"));
  // A reading taken after the marker is the new subscription.
  const sdir = join(fx.acc.home, ".claude", "microverse", "statusline");
  const at = marker.at + 5000;
  writeFileSync(join(sdir, "s9.json"), JSON.stringify({ v: 1, at, week: { used: 30, resetsAt: Math.max(now, at) + 48 * HOUR } }));
  const r = quota(fx);
  assert.match(r.out, /^Counters: .*week 30 %/m, r.out);
  assert.doesNotMatch(r.out, /Quota: off/);
});

test("quotaMode: the latest of the three sources wins, reasons and option handling", () => {
  const week = (observedAt, resetAt = now + 48 * HOUR) => ({ periodType: "seven-day", usedFraction: 0.3, resetAt, observedAt });
  const sl = (observedAt) => [{ ...week(observedAt), source: "statusline" }];
  const marker = { at: now - 5 * MIN, source: "user" };
  const m = (o) => lib.quotaMode({ now, ...o });
  // Each source, alone, newer than the marker, lifts it.
  assert.equal(m({ option: "auto", marker, readings: { extensionObs: [week(now - MIN)] } }).mode, "metered");
  assert.equal(m({ option: "auto", marker, readings: { statuslineObs: sl(now - MIN) } }).mode, "metered");
  assert.equal(m({ option: "auto", marker, readings: { historyObs: sl(now - MIN) } }).mode, "metered");
  // Older than the marker: off, even with a current reading.
  assert.deepEqual(m({ option: "auto", marker, readings: { extensionObs: [week(now - HOUR)] } }), { mode: "off", reason: "user" });
  // A newer but expired reading still lifts the marker, and asks.
  assert.deepEqual(m({ option: "auto", marker, readings: { extensionObs: [week(now - MIN, now - MIN)] } }), { mode: "ask", reason: "stale" });
  assert.deepEqual(m({ option: undefined, marker: null, readings: {} }), { mode: "off", reason: "no-source" });
  assert.equal(m({ option: "OFF", marker: null, readings: { extensionObs: [week(now)] } }).reason, "option");
  assert.match(m({ option: "on", marker: null, readings: {} }).warning, /"on" unknown/);
  assert.equal(m({ option: "${user_config.quota_mode}", marker: null, readings: {} }).warning, undefined);
});

test("T11: orch-status next to an off orch-quota exits 0 and reports off", () => {
  const { dir } = makeRepo({ checks: [] });
  // The scripts' default home is an empty temporary one; the profile approval lives there.
  const env = { APPDATA: mkdtempSync(join(tmpdir(), "microverse-appdata-")), CLAUDE_PLUGIN_OPTION_QUOTA_MODE: undefined };
  const r = script("orch-status", [], dir, env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /off/);
  assert.doesNotMatch(r.out, /TypeError|at .*\.js:\d+|Cannot read/);
  const j = script("orch-status", ["--json"], dir, env);
  assert.equal(j.code, 0, j.out);
  assert.doesNotMatch(j.out, /TypeError|Cannot read/);
});

test("T12: the Budget step runs get_usage, then orch-reading, then orch-quota with --mode", () => {
  const skill = readFileSync(join(ROOT, "skills", "orchestration", "SKILL.md"), "utf8");
  assert.ok(skill.includes("orch-quota --mode '${user_config.quota_mode}'"));
  const budget = skill.slice(skill.indexOf("- **Budget**"));
  const at = (s) => budget.indexOf(s);
  assert.ok(at("get_usage") >= 0 && at("get_usage") < at("orch-reading --five-hour"));
  assert.ok(at("orch-reading --five-hour") < at("orch-reading --none`"));
  assert.ok(at("orch-reading --none`") < at("orch-quota --mode"));
  assert.ok(at("orch-reading --none --source user") > at("orch-quota --mode"));
});
