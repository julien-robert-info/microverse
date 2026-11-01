"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, approveProfile, makeRepo } = require("./helpers.js");

const HOOK = join(ROOT, "scripts", "doctor-command.js");
const tested = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).testedWith;
const home = mkdtempSync(join(tmpdir(), "microverse-hookhome-"));

const transcript = (version) => {
  const file = join(mkdtempSync(join(tmpdir(), "microverse-transcript-")), "session.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "user", version })}\n`);
  return file;
};

// A hook environment that reads nothing of the real account.
const baseEnv = (extra = {}) => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: home,
  CLAUDE_PROJECT_DIR: "",
  CLAUDE_PLUGIN_DATA: "",
  MICROVERSE_NODE_VERSION: `${tested.node[0]}.0.0`,
  MICROVERSE_CLAUDE_BIN: join(home, "claude-absent.js"),
  ...extra,
});

const hook = (input, env) =>
  spawnSync(process.execPath, [HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: baseEnv(env) });

const payload = (cwd, extra = {}) => ({
  command_name: "microverse:doctor",
  command_args: "",
  cwd,
  session_id: "sess-x",
  transcript_path: transcript(tested.claudeCode),
  ...extra,
});

test("T8: the command is blocked with the report as the reason, hooks ok", () => {
  const { dir } = makeRepo({});
  approveProfile(home, dir);
  const r = hook(payload(dir));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptExpansion");
  assert.equal(out.hookSpecificOutput.suppressOriginalPrompt, true);
  assert.match(out.reason, /^ok node /);
  assert.match(out.reason, /^ok hooks /m);
  assert.match(out.reason, new RegExp(`^ok claude-code  ${tested.claudeCode.replace(/\./g, "\\.")}`, "m"));
  assert.ok(out.reason.length <= 9000);
});

test("T8: the exit code is 0 even when doctor finds a fix", () => {
  const { dir } = makeRepo({}, { approve: false });
  const r = hook(payload(dir, { cwd: dir }), { HOME: mkdtempSync(join(tmpdir(), "microverse-h-")) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).reason, /^fix profile /m);
});

test("T8: the transcript of the payload gives the Claude Code version", () => {
  const { dir } = makeRepo({});
  const [maj, min] = tested.claudeCode.split(".");
  const r = JSON.parse(hook(payload(dir, { transcript_path: transcript(`${maj}.${Number(min) + 1}.0`) })).stdout);
  assert.match(r.reason, /^warn claude-code /m);
});

test("T8: the plugin options and data folder do not reach doctor", () => {
  const { dir } = makeRepo({});
  const r = hook(payload(dir), { CLAUDE_PLUGIN_DATA: dir, CLAUDE_PLUGIN_OPTION_WEEK_TARGET: "30" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).reason, /^ok node /);
});

test("T8: other commands, invalid JSON and empty input print nothing", () => {
  const { dir } = makeRepo({});
  for (const input of [payload(dir, { command_name: "microverse:status" }), payload(dir, { command_name: "doctor" }), "{not json", "", "[]", "null", {}]) {
    const r = hook(input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", JSON.stringify(input));
  }
  assert.equal(hook({ command_name: "microverse:doctor" }).stdout, "", "no directory");
});

test("the skill is hidden from the model and the hook is declared with its script", () => {
  const skill = readFileSync(join(ROOT, "skills", "doctor", "SKILL.md"), "utf8");
  assert.match(skill, /^name: doctor$/m);
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.match(skill, /^allowed-tools: Bash\(orch-doctor \*\)$/m);
  assert.match(skill, /Run `orch-doctor` with the Bash tool/);
  assert.doesNotMatch(skill, /--from-hook/);
  const entries = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")).hooks.UserPromptExpansion.filter((e) => e.matcher === "^microverse:doctor$");
  assert.equal(entries.length, 1);
  const h = entries[0].hooks[0];
  assert.equal(h.command, "node");
  assert.equal(h.timeout, 20);
  assert.equal(existsSync(h.args[0].replace("${CLAUDE_PLUGIN_ROOT}", ROOT)), true);
  assert.ok(new RegExp(entries[0].matcher).test("microverse:doctor"));
  assert.equal(new RegExp(entries[0].matcher).test("microverse:doctorx"), false);
});

test("the README cites the versions of testedWith", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(readme.includes(tested.claudeCode), "Claude Code version");
  assert.ok(readme.includes(`Node.js ${tested.node.join(" and ")}`), "Node.js versions");
});
