"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, commitFile, git, makeRepo, script } = require("./helpers.js");

const HOOK = join(ROOT, "scripts", "status-command.js");
const HOUR = 3600e3;
const emptyHome = mkdtempSync(join(tmpdir(), "microverse-hookhome-"));

// Readings of both counters, taken now, in a window that resets in two days.
function quotaFile(week, five) {
  const now = Date.now();
  const file = join(mkdtempSync(join(tmpdir(), "microverse-quota-")), "quota.json");
  writeFileSync(
    file,
    JSON.stringify({
      observations: [
        { periodType: "seven-day", usedFraction: week, resetAt: now + 48 * HOUR, observedAt: now },
        { periodType: "five-hour", usedFraction: five, resetAt: now + 2 * HOUR, observedAt: now },
      ],
    }),
  );
  return file;
}

// A hook environment that reads nothing of the real account.
const baseEnv = (extra = {}) => ({
  ...process.env,
  HOME: emptyHome,
  USERPROFILE: emptyHome,
  APPDATA: emptyHome,
  CLAUDE_PROJECT_DIR: "",
  CLAUDE_PLUGIN_DATA: "",
  CLAUDE_PLUGIN_OPTION_WEEK_TARGET: "",
  CLAUDE_PLUGIN_OPTION_WEEKDAY_RESERVE: "",
  CLAUDE_PLUGIN_OPTION_FIVE_HOUR_LIMIT: "",
  CLAUDE_PLUGIN_OPTION_QUOTA_FILE: "",
  ...extra,
});

const hook = (input, env) =>
  spawnSync(process.execPath, [HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: baseEnv(env) });

const payload = (cwd, extra = {}) => ({ command_name: "microverse:status", command_args: "", cwd, session_id: "sess-x", ...extra });

test("T17: the command is blocked with the overview as the reason", () => {
  const { dir } = makeRepo({});
  const r = hook(payload(dir));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptExpansion");
  assert.equal(out.hookSpecificOutput.suppressOriginalPrompt, true);
  assert.match(out.reason, /^microverse status:/);
  assert.ok(out.reason.length <= 9000);
});

test("T17: plugin options reach the quota, and a commit argument gives Merged since", () => {
  const { dir } = makeRepo({});
  const first = git(dir, "rev-parse", "HEAD").out.trim();
  const file = quotaFile(0.4, 0.1);
  const week = JSON.parse(hook(payload(dir), { CLAUDE_PLUGIN_OPTION_WEEK_TARGET: "30", CLAUDE_PLUGIN_OPTION_QUOTA_FILE: file }).stdout).reason;
  assert.match(week, /^advice {3}stop/m);
  // An unexpanded placeholder is ignored.
  const holder = JSON.parse(hook(payload(dir), { CLAUDE_PLUGIN_OPTION_WEEK_TARGET: "${user_config.week_target}", CLAUDE_PLUGIN_OPTION_QUOTA_FILE: file }).stdout).reason;
  assert.doesNotMatch(holder, /target 30/);
  commitFile(dir, "later.txt", "x\n", "feat: later");
  const merged = JSON.parse(hook(payload(dir, { command_args: ` ${first.slice(0, 7)} extra words` })).stdout).reason;
  assert.match(merged, new RegExp(`^Merged since ${first.slice(0, 7)} `, "m"));
  assert.match(merged, /feat: later/);
});

test("T17: CLAUDE_PLUGIN_DATA does not reach orch-status", () => {
  const { dir } = makeRepo({});
  const data = mkdtempSync(join(tmpdir(), "microverse-data-"));
  const role = { median: 2, n: 5 };
  writeFileSync(join(data, "calibration.json"), JSON.stringify({ at: Date.now(), n5: 8, n7: 8, since: null, change: null, ratio5: 10, roles: { rick: role, morty: role, council: role } }));
  const file = quotaFile(0.1, 0.1);
  // Control: the calibration is used when orch-status does see the folder.
  const direct = script("orch-status", ["--verbose", "--file", file], dir, { CLAUDE_PLUGIN_DATA: data });
  assert.match(direct.out, /Agent cost: ~\d+ points of 5h \(learned from/);
  const r = JSON.parse(hook(payload(dir, { command_args: "--verbose" }), { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_OPTION_QUOTA_FILE: file }).stdout);
  assert.match(r.reason, /Agent cost: 15 points of 5h \(default\)/);
  assert.equal(readFileSync(join(data, "calibration.json"), "utf8").includes('"ratio5":10'), true, "calibration untouched");
});

test("--verbose and --agents reach orch-status, alone or with a commit; other options are refused", () => {
  const { dir } = makeRepo({});
  const file = quotaFile(0.1, 0.1);
  const env = { CLAUDE_PLUGIN_OPTION_QUOTA_FILE: file };
  const reason = (args) => JSON.parse(hook(payload(dir, { command_args: args }), env).stdout).reason;
  assert.doesNotMatch(reason(""), /Agent cost:/);
  assert.match(reason("--verbose"), /Agent cost:/);
  assert.match(reason("HEAD --verbose"), /Agent cost:/);
  assert.match(reason("--agents --verbose HEAD"), /^Merged since /m);
  assert.match(reason("--verbose --file /etc/passwd"), /^not a commit: --file/);
});

test("T17: an argument that looks like an option is refused before anything runs", () => {
  const { dir } = makeRepo({});
  const r = JSON.parse(hook(payload(dir, { command_args: "--file /etc/passwd" })).stdout);
  assert.match(r.reason, /^not a commit: --file/);
  const bad = JSON.parse(hook(payload(dir, { command_args: "nothere123" })).stdout);
  assert.match(bad.reason, /not a commit/);
});

test("a huge one-line message is bounded and bidi characters are stripped", () => {
  const { dir } = makeRepo({});
  const r = JSON.parse(hook(payload(dir, { command_args: `-a‮b​c${"z".repeat(12000)}` })).stdout);
  assert.ok(r.reason.length <= 9000, String(r.reason.length));
  assert.match(r.reason, /^not a commit: -abcz+/);
  assert.match(r.reason, /… output truncated$/);
});

test("T18: other commands, invalid JSON and empty input print nothing", () => {
  const { dir } = makeRepo({});
  for (const input of [payload(dir, { command_name: "microverse:init" }), payload(dir, { command_name: "status" }), "{not json", "", "[]", "null", {}]) {
    const r = hook(input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", JSON.stringify(input));
  }
  assert.equal(hook({ command_name: "microverse:status" }).stdout, "", "no directory");
});

test("T19: the skill is hidden from the model and the hook is declared with its script", () => {
  const skill = readFileSync(join(ROOT, "skills", "status", "SKILL.md"), "utf8");
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.match(skill, /^name: status$/m);
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")).hooks.UserPromptExpansion;
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].matcher, "^microverse:status$");
  const h = hooks[0].hooks[0];
  assert.equal(h.command, "node");
  const script_ = h.args[0].replace("${CLAUDE_PLUGIN_ROOT}", ROOT);
  assert.equal(existsSync(script_), true);
  assert.ok(new RegExp(hooks[0].matcher).test("microverse:status"));
  assert.equal(new RegExp(hooks[0].matcher).test("microverse:statusx"), false);
});
