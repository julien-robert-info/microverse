"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { script } = require("./helpers.js");

const HOUR = 3600e3;

// Readings of both counters, taken now, in a window that resets in two days.
function quotaFile(week, five, fiveAge = 0) {
  const now = Date.now();
  const file = join(mkdtempSync(join(tmpdir(), "microverse-quota-")), "quota.json");
  writeFileSync(
    file,
    JSON.stringify({
      observations: [
        { periodType: "seven-day", usedFraction: week, resetAt: now + 48 * HOUR, observedAt: now },
        { periodType: "five-hour", usedFraction: five, resetAt: now + 2 * HOUR, observedAt: now - fiveAge },
      ],
    }),
  );
  return file;
}

const advice = (week, five, extra = []) => script("orch-quota", ["--file", quotaFile(week, five), ...extra], process.cwd()).out;

test("stops everything at the weekly target", () => {
  assert.match(advice(0.99, 0.1), /Advice: stop/);
});

test("accepts a custom target", () => {
  assert.match(advice(0.5, 0.1, ["--target", "50"]), /Advice: stop/);
});

test("launches no new agent three points under the target", () => {
  assert.match(advice(0.96, 0.1), /Advice: no new agent/);
});

test("the 5h counter blocks new agents at the limit and resuming five points above", () => {
  assert.match(advice(0.1, 0.91), /Advice: no new agent/);
  assert.match(advice(0.1, 0.96), /Advice: no more resuming/);
  assert.match(advice(0.1, 0.91, ["--five-hour", "95", "--agent-cost", "2"]), /Advice: (speed up|normal|smooth out)/);
});

test("the 5h room bounds new agents by their cost and the running ones", () => {
  assert.match(advice(0.1, 0.8), /Advice: no new agent: 10 points left before the 5h limit/);
  assert.match(advice(0.1, 0.5, ["--running", "3"]), /Advice: no new agent: 40 points left.*3 running/);
  assert.match(advice(0.1, 0.8, ["--agent-cost", "5"]), /Advice: (speed up|normal)/);
});

test("a missing counters file is reported with exit code 1", () => {
  const r = script("orch-quota", ["--file", join(tmpdir(), "microverse-missing.json")], process.cwd());
  assert.equal(r.code, 1);
  assert.match(r.out, /not found/);
});

test("an unexpanded plugin option falls back to the default location", () => {
  const r = script("orch-quota", ["--file", "${user_config.quota_file}"], process.cwd());
  assert.doesNotMatch(r.out, /user_config/);
});

test("an empty numeric option means unset, never 0", () => {
  assert.doesNotMatch(advice(0.5, 0.1, ["--target", ""]), /Advice: stop/);
  assert.match(advice(0.5, 0.1, ["--target", ""]), /Advice: (speed up|normal|smooth out)/);
  assert.match(advice(0.5, 0.5, ["--five-hour", ""]), /Advice: (no new agent: 40 points left|speed up|normal)/);
  assert.match(advice(0.1, 0.1, ["--agent-cost", ""]), /Agent cost: 15 points of 5h \(default\)/);
  assert.match(advice(0.1, 0.1, ["--running", ""]), /Running: 0 agents \(0 in other projects\)/);
  assert.match(advice(0.1, 0.1, ["--reserve", ""]), /Advice:/);
});

const staleLine = (fiveAge) => script("orch-quota", ["--file", quotaFile(0.1, 0.2, fiveAge)], process.cwd()).out;

test("a 5h reading over 15 minutes old is flagged", () => {
  assert.match(staleLine(20 * 60e3), /^Warning: 5h reading 20 min old; the 5h counter can rise quickly: ask the user for it before launching more than one agent\.$/m);
  assert.doesNotMatch(staleLine(10 * 60e3), /5h reading/);
});
