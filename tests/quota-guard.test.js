"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { ROOT, makeAccount } = require("./helpers.js");

const HOOK = join(ROOT, "scripts", "quota-guard.js");
const HOUR = 3600e3;
const MIN = 60e3;

const OPTIONS = ["WEEK_TARGET", "WEEKDAY_RESERVE", "FIVE_HOUR_LIMIT", "QUOTA_FILE"].map((k) => `CLAUDE_PLUGIN_OPTION_${k}`);

// Calibration whose learned cost is `points` per agent: 1 dollar costs 1 point
// of 5h, and the larger of a rick and a morty with its council review is `points`.
function calibration(acc, points, at = Date.now()) {
  const dir = join(acc.home, ".claude", "microverse");
  mkdirSync(dir, { recursive: true });
  const role = (median) => ({ n: 5, median });
  const cal = { at, ratio5: 1, roles: { rick: role(points), morty: role(points - 1), council: role(1) } };
  writeFileSync(join(dir, "calibration.json"), JSON.stringify(cal));
}

// A throwaway account with a project that has a profile and a readings file.
// `five` and `week` are percentages; `fiveAge` the age of the 5h reading.
function setup({ five = 20, week = 10, fiveAge = 0, weekReset = 48 * HOUR, extra = [], profile = true } = {}) {
  const acc = makeAccount();
  const project = acc.project("proj");
  if (profile) {
    mkdirSync(join(project, ".claude", "orchestration"), { recursive: true });
    writeFileSync(join(project, ".claude", "orchestration", "profile.json"), "{}");
  }
  const now = Date.now();
  const obs = [...extra];
  if (week !== null) obs.push({ periodType: "seven-day", usedFraction: week / 100, resetAt: now + weekReset, observedAt: now });
  if (five !== null) obs.push({ periodType: "five-hour", usedFraction: five / 100, resetAt: now + 2 * HOUR, observedAt: now - fiveAge });
  const file = join(acc.home, "quota.json");
  writeFileSync(file, JSON.stringify({ observations: obs }));
  return { acc, project, file };
}

function guard(fx, { type = "microverse:morty", tool = "Agent", env = {}, cwd = fx.project, projectDir = fx.project } = {}) {
  const payload = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { subagent_type: type, model: "sonnet", description: "x", prompt: "y" }, cwd };
  const full = { ...process.env, ...fx.acc.env, APPDATA: fx.acc.home, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_OPTION_QUOTA_FILE: fx.file, ...env };
  for (const k of OPTIONS) if (!(k in env) && k !== "CLAUDE_PLUGIN_OPTION_QUOTA_FILE") delete full[k];
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: "utf8", env: full });
  assert.equal(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

const denied = (out) => {
  assert.ok(out, "expected an output");
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, "deny");
  assert.ok(out.permissionDecisionReason.length < 400);
  assert.ok(!out.permissionDecisionReason.includes("\n"));
  return out.permissionDecisionReason;
};

test("a morty at the 5h limit is denied with both counters and the option to raise", () => {
  const reason = denied(guard(setup({ five: 91, week: 33 })));
  assert.match(reason, /^Quota: no new agent/);
  assert.match(reason, /5h 91 % \(reading \d+ min old\), week 33 %/);
  assert.match(reason, /0 running/);
  assert.match(reason, /five_hour_limit/);
});

test("a rick with no room for one more agent given the running ones is denied", () => {
  const fx = setup({ five: 60, week: 10 });
  for (const id of ["a1", "a2"]) fx.acc.agent("proj", id, "microverse:morty", [{ ts: Date.now(), dollars: 1 }], 0);
  const reason = denied(guard(fx, { type: "microverse:rick" }));
  assert.match(reason, /no new agent: 30 points left before the 5h limit, 2 running and about 15 per agent/);
  assert.match(reason, /2 running/);
  // The same counters without the running agents leave room.
  assert.equal(guard(setup({ five: 60, week: 10 }), { type: "microverse:rick" }), null);
});

test("5h five points over the limit denies as no more resuming", () => {
  const reason = denied(guard(setup({ five: 96, week: 10 })));
  assert.match(reason, /^Quota: no more resuming agents/);
  assert.doesNotMatch(reason, /no new agent/);
});

test("the week at the target, or three points under it, is denied", () => {
  assert.match(denied(guard(setup({ five: 10, week: 98 }))), /^Quota: stop/);
  assert.match(denied(guard(setup({ five: 10, week: 95 }))), /^Quota: no new agent \(≥ 95 %\)/);
});

test("council, meeseeks and other agents are not guarded", () => {
  const fx = setup({ five: 96, week: 99 });
  for (const type of ["microverse:council", "microverse:meeseeks", "general-purpose", "Explore"]) assert.equal(guard(fx, { type }), null, type);
});

test("other tools are not guarded; the Task name is", () => {
  const fx = setup({ five: 96, week: 99 });
  assert.equal(guard(fx, { tool: "Bash" }), null);
  assert.equal(guard(fx, { tool: "Read" }), null);
  denied(guard(fx, { tool: "Task" }));
});

test("under every limit with a fresh reading there is no output", () => {
  assert.equal(guard(setup({ five: 20, week: 10 })), null);
});

test("a week above the pacing line allows with the advice as context", () => {
  // Usage was 0 a day before the window began and is 94 % a few hours into it.
  const now = Date.now();
  const reset = now + 6.9 * 24 * HOUR;
  const fx = setup({ five: 20, week: 94, weekReset: 6.9 * 24 * HOUR, extra: [{ periodType: "seven-day", usedFraction: 0, resetAt: reset, observedAt: now - 24 * HOUR }] });
  const out = guard(fx);
  assert.equal(out.permissionDecision, undefined);
  assert.match(out.additionalContext, /^Quota: smooth out: no new agent until the counter drops back under the line\.$/);
});

test("no profile: no output, even at a limit", () => {
  assert.equal(guard(setup({ five: 96, profile: false })), null);
});

test("the payload cwd stands in for CLAUDE_PROJECT_DIR", () => {
  const fx = setup({ five: 96 });
  denied(guard(fx, { projectDir: "" }));
  assert.equal(guard(fx, { projectDir: "", cwd: join(fx.acc.home, "nowhere") }), null);
});

test("no counters file, an unreadable one, or no weekly reading: no output", () => {
  const fx = setup({ five: 96 });
  assert.equal(guard(fx, { env: { CLAUDE_PLUGIN_OPTION_QUOTA_FILE: join(fx.acc.home, "missing.json") } }), null);
  const junk = join(fx.acc.home, "junk.json");
  writeFileSync(junk, "{not json");
  assert.equal(guard(fx, { env: { CLAUDE_PLUGIN_OPTION_QUOTA_FILE: junk } }), null);
  assert.equal(guard(setup({ five: 96, week: null })), null);
});

test("malformed input passes with exit 0", () => {
  const r = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("five_hour_limit option: 95 lets 92 % through, empty or unexpanded means 90", () => {
  // A cost of 2 points per agent leaves room under the raised limit.
  const run = (value) => {
    const fx = setup({ five: 92, week: 10 });
    calibration(fx.acc, 2);
    return guard(fx, { env: { CLAUDE_PLUGIN_OPTION_FIVE_HOUR_LIMIT: value } });
  };
  assert.equal(run("95"), null);
  assert.match(denied(run("")), /^Quota: no new agent/);
  assert.match(denied(run("${user_config.five_hour_limit}")), /^Quota: no new agent/);
  assert.match(denied(run("abc")), /^Quota: no new agent/);
  assert.match(denied(run(undefined)), /^Quota: no new agent/);
});

test("empty week options never become 0", () => {
  const out = guard(setup({ five: 20, week: 10 }), { env: { CLAUDE_PLUGIN_OPTION_WEEK_TARGET: "", CLAUDE_PLUGIN_OPTION_WEEKDAY_RESERVE: "" } });
  assert.equal(out, null);
  denied(guard(setup({ five: 20, week: 60 }), { env: { CLAUDE_PLUGIN_OPTION_WEEK_TARGET: "60" } }));
});

test("the learned cost is used although CLAUDE_PLUGIN_DATA points at a folder without calibration", () => {
  const fx = setup({ five: 91, week: 10 });
  calibration(fx.acc, 11);
  const data = join(fx.acc.home, "empty-data");
  mkdirSync(data);
  assert.match(denied(guard(fx, { env: { CLAUDE_PLUGIN_DATA: data } })), /~11 points per agent/);
  // Without a calibration the default applies.
  assert.match(denied(guard(setup({ five: 91, week: 10 }))), /~15 points per agent/);
});

// Every file under `dir` with its size and modification time.
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const s = statSync(p);
        out.push(`${p} ${s.size} ${s.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

test("a stale calibration and status line readings are used and nothing is written", () => {
  const fx = setup({ five: null, week: null });
  const now = Date.now();
  calibration(fx.acc, 11, now - 10 * 24 * HOUR);
  const dir = join(fx.acc.home, ".claude", "microverse", "statusline");
  mkdirSync(dir, { recursive: true });
  const reading = (at, five, week) => ({ v: 1, at, five: { used: five, resetsAt: at + 2 * HOUR }, week: { used: week, resetsAt: at + 48 * HOUR } });
  writeFileSync(join(dir, "live.json"), JSON.stringify(reading(now - MIN, 93, 20)));
  // Expired: orch-quota would prune it, the guard must not.
  writeFileSync(join(dir, "old.json"), JSON.stringify(reading(now - 30 * 24 * HOUR, 10, 10)));
  const before = snapshot(fx.acc.home);
  const reason = denied(guard(fx, { env: { CLAUDE_PLUGIN_OPTION_QUOTA_FILE: join(fx.acc.home, "missing.json") } }));
  assert.match(reason, /5h 93 %.*week 20 %.*~11 points per agent/);
  assert.deepEqual(snapshot(fx.acc.home), before);
});

test("a 5h reading 20 minutes old allows with the warning as context; 10 minutes old, nothing", () => {
  const out = guard(setup({ five: 20, week: 10, fiveAge: 20 * MIN }));
  assert.equal(out.permissionDecision, undefined);
  assert.equal(out.additionalContext, "Warning: 5h reading 20 min old; the 5h counter can rise quickly: ask the user for it before launching more than one agent.");
  assert.equal(guard(setup({ five: 20, week: 10, fiveAge: 10 * MIN })), null);
});

test("a stale 5h reading alone does not refuse", () => {
  const out = guard(setup({ five: 20, week: 10, fiveAge: 4 * HOUR }));
  assert.equal(out.permissionDecision, undefined);
});
