"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { makeAccount, makeRepo, script } = require("./helpers.js");

const HOUR = 3600e3;

function quotaFile(observations) {
  const file = join(mkdtempSync(join(tmpdir(), "microverse-quota-")), "quota.json");
  writeFileSync(file, JSON.stringify({ observations }));
  return file;
}

// Both counters read now: `week` and `five` as fractions, the five-hour one
// `fiveAge` ms ago, in a window that resets in two days.
const both = (week, five, fiveAge = 0) => {
  const now = Date.now();
  return quotaFile([
    { periodType: "seven-day", usedFraction: week, resetAt: now + 48 * HOUR, observedAt: now },
    { periodType: "five-hour", usedFraction: five, resetAt: now + 2 * HOUR, observedAt: now - fiveAge },
  ]);
};

// stdout must be exactly one JSON line.
function json(args, cwd = process.cwd(), env) {
  const r = script("orch-quota", ["--json", ...args], cwd, env);
  const lines = r.out.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, r.out);
  return { code: r.code, out: JSON.parse(lines[0]), raw: r.out };
}

test("--json gives every field of the schema, with the source of each counter", () => {
  const { code, out } = json(["--file", both(0.42, 0.17), "--running", "2", "--agent-cost", "7"]);
  assert.equal(code, 0);
  assert.equal(out.v, 1);
  assert.equal(out.counters.week.used, 42);
  assert.equal(out.counters.five.used, 17);
  for (const c of [out.counters.week, out.counters.five]) {
    assert.deepEqual(Object.keys(c), ["used", "resetsAt", "observedAt", "source"]);
    assert.equal(c.source, "extension");
  }
  assert.ok(Math.abs(out.counters.week.resetsAt - (Date.now() + 48 * HOUR)) < 60e3);
  assert.ok(Math.abs(out.counters.five.resetsAt - (Date.now() + 2 * HOUR)) < 60e3);
  assert.deepEqual(out.limits, { target: 98, reserve: 30, fiveHour: 90 });
  assert.deepEqual(Object.keys(out.period), ["name", "start", "end", "target"]);
  assert.ok(["weekend", "weekdays", "whole window"].includes(out.period.name));
  assert.deepEqual(Object.keys(out.pace), ["expected", "actual", "delta", "left"]);
  assert.equal(out.pace.actual, 42);
  assert.equal(out.pace.left, Math.max(0, out.period.target - 42));
  assert.deepEqual(out.running, { total: 2, others: null });
  assert.deepEqual(out.agentCost, { points: 7, runs: null });
  assert.deepEqual(Object.keys(out.advice), ["level", "more", "text"]);
  assert.ok(Array.isArray(out.warnings));
  assert.ok(Array.isArray(out.history));
});

test("--json and the text show the same counters and the same advice", () => {
  const file = both(0.61, 0.33);
  const args = ["--file", file, "--no-write", "--running", "0", "--agent-cost", "9"];
  const { out } = json(args);
  const text = script("orch-quota", args, process.cwd()).out;
  assert.match(text, new RegExp(`Counters: 5h ${out.counters.five.used} %.*week ${out.counters.week.used} %`));
  assert.ok(text.includes(`Advice: ${out.advice.text}`));
  assert.match(text, new RegExp(`${out.pace.left} points left for the period`));
});

test("a counter read from the status line says so", () => {
  const acc = makeAccount();
  const now = Date.now();
  // A history line of the status line, which is the only reading.
  const dir = join(acc.home, ".claude", "microverse", "statusline-history");
  mkdirSync(dir, { recursive: true });
  const day = new Date(now).toISOString().slice(0, 10);
  const line = (type, used, resetsAt) => `${JSON.stringify({ v: 1, at: now - 1000, type, used, resetsAt })}\n`;
  writeFileSync(join(dir, `${day}.jsonl`), line("seven-day", 31, now + 48 * HOUR) + line("five-hour", 12, now + 2 * HOUR));
  const { out } = json(["--file", join(acc.home, "none.json")], acc.project("proj-a"), acc.env);
  assert.equal(out.counters.week.source, "statusline");
  assert.equal(out.counters.week.used, 31);
  assert.equal(out.counters.five.source, "statusline");
});

test("without any source: off on one line, exit code 0, with the error key kept", () => {
  const { code, out, raw } = json([], process.cwd(), { APPDATA: mkdtempSync(join(tmpdir(), "microverse-appdata-")) });
  assert.equal(code, 0);
  assert.deepEqual(Object.keys(out), ["v", "mode", "reason", "error", "advice"]);
  assert.equal(out.v, 1);
  assert.equal(out.mode, "off");
  assert.match(out.error, /^Quota off \(no counter source\)/);
  assert.equal(raw.trim().split("\n").length, 1);
});

test("with an unreadable counters file and no other source: { v, error }, exit code 1", () => {
  const file = join(mkdtempSync(join(tmpdir(), "microverse-quota-")), "quota.json");
  writeFileSync(file, "{not json");
  const { code, out, raw } = json(["--file", file]);
  assert.equal(code, 1);
  assert.deepEqual(Object.keys(out), ["v", "error"]);
  assert.match(out.error, /unreadable.*no status line reading/);
  assert.equal(raw.trim().split("\n").length, 1);
});

test("without a current weekly reading: { v, error }, exit code 1", () => {
  const now = Date.now();
  const file = quotaFile([{ periodType: "five-hour", usedFraction: 0.1, resetAt: now + 2 * HOUR, observedAt: now }]);
  const { code, out } = json(["--file", file]);
  assert.equal(code, 1);
  assert.match(out.error, /No current weekly reading/);
});

test("history keeps the rising readings of the current window, not the previous one", () => {
  const now = Date.now();
  const reset = now + 48 * HOUR;
  const file = quotaFile([
    // previous window: its reset is days away from the current one's
    { periodType: "seven-day", usedFraction: 0.9, resetAt: reset - 7 * 24 * HOUR, observedAt: now - 9 * 24 * HOUR },
    // current window; the third reading is a stale lower value, and the 5h readings are no part of it
    { periodType: "seven-day", usedFraction: 0.1, resetAt: reset, observedAt: now - 4 * HOUR },
    { periodType: "seven-day", usedFraction: 0.2, resetAt: reset + 20 * 60e3, observedAt: now - 3 * HOUR },
    { periodType: "seven-day", usedFraction: 0.15, resetAt: reset, observedAt: now - 2.5 * HOUR },
    { periodType: "seven-day", usedFraction: 0.3, resetAt: reset, observedAt: now - 1 * HOUR },
    { periodType: "five-hour", usedFraction: 0.5, resetAt: now + 2 * HOUR, observedAt: now - HOUR },
  ]);
  const { out } = json(["--file", file]);
  assert.deepEqual(out.history.map((p) => p.used), [10, 20, 30]);
  assert.ok(out.history.every((p, i, a) => i === 0 || p.at > a[i - 1].at));
  assert.equal(out.history[0].at, now - 4 * HOUR);
  assert.equal(out.counters.week.used, 30);
});

test("advice.more is the room left for new agents, 0 unless the level is launch", () => {
  // 1 % of the week, 10 % of the 5h: one agent runs, 40 points each, room for two in all.
  const launch = json(["--file", both(0.01, 0.1), "--running", "1", "--agent-cost", "40"]).out.advice;
  assert.equal(launch.level, "launch");
  assert.match(launch.text, /up to 2 agents/);
  assert.equal(launch.more, 1);
  const none = json(["--file", both(0.01, 0.9), "--running", "1", "--agent-cost", "40"]).out.advice;
  assert.equal(none.level, "five-hour");
  assert.equal(none.more, 0);
  assert.equal(json(["--file", both(0.99, 0.1)]).out.advice.more, 0);
});

test("a stale 5h reading is a warning", () => {
  const { out } = json(["--file", both(0.2, 0.2, 30 * 60e3)]);
  assert.ok(out.warnings.some((w) => /5h reading 30 min old/.test(w)), out.warnings.join("|"));
  assert.deepEqual(json(["--file", both(0.2, 0.2)]).out.warnings, []);
});

test("--calibrate --json adds the calibration", () => {
  const acc = makeAccount();
  const { out } = json(["--file", both(0.2, 0.2), "--calibrate"], acc.project("proj-a"), acc.env);
  assert.ok(out.calibration);
  assert.deepEqual(Object.keys(out.calibration).sort(), ["at", "change", "n5", "n7", "ratio5", "ratio7", "roles", "since", "source"]);
  assert.equal(json(["--file", both(0.2, 0.2)], acc.project("proj-a"), acc.env).out.calibration, undefined);
});

test("--json --no-write does not write the calibration nor refresh the status line copy; without it, it writes like the text", () => {
  const file = both(0.2, 0.2);
  // An older installed copy of the status line and an expired reading, as found.
  const account = () => {
    const acc = makeAccount();
    const dir = join(acc.home, ".claude", "microverse");
    mkdirSync(join(dir, "statusline"), { recursive: true });
    writeFileSync(join(dir, "statusline", "old-session.json"), JSON.stringify({ v: 1, at: Date.now() - 10 * 24 * HOUR, week: { used: 10, resetsAt: 2 } }));
    writeFileSync(join(dir, "statusline.js"), "// an older copy\n");
    return { acc, copy: join(dir, "statusline.js"), reading: join(dir, "statusline", "old-session.json"), cal: join(acc.data, "calibration.json") };
  };
  const quiet = account();
  json(["--file", file, "--no-write"], quiet.acc.project("proj-a"), quiet.acc.env);
  assert.equal(existsSync(quiet.cal), false);
  assert.equal(readFileSync(quiet.copy, "utf8"), "// an older copy\n");
  assert.equal(existsSync(quiet.reading), true);
  const loud = account();
  json(["--file", file], loud.acc.project("proj-a"), loud.acc.env);
  assert.equal(existsSync(loud.cal), true);
  assert.notEqual(readFileSync(loud.copy, "utf8"), "// an older copy\n");
  assert.equal(existsSync(loud.reading), false);
});

test("project is the root of the repository, from a worktree too", () => {
  const { dir, wt } = makeRepo({});
  const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
  const file = both(0.2, 0.2);
  assert.equal(norm(json(["--file", file], dir).out.project), norm(dir));
  assert.equal(norm(json(["--file", file], wt).out.project), norm(dir));
});
