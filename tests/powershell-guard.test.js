"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { ROOT } = require("./helpers.js");

const HOOK = join(ROOT, "scripts", "powershell-guard.js");

const runRaw = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: "utf8" });
const run = (command, tool_name = "PowerShell") => {
  const r = runRaw(JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input: { command } }));
  assert.equal(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};

test("a bin script run by name is denied with the way to run it", () => {
  const commands = [
    "orch-trust --status",
    'git status; orch-trust --status; "rc=$LASTEXITCODE"',
    "& orch-quota --target 98",
    "cd x && agent-check fix/a",
    "orch-status | Out-String",
    '"C:\\plugin\\bin\\orch-trust" --status',
    "if ($true) { agent-cleanup fix/a }",
    "git log\norch-usage --context",
  ];
  for (const command of commands) {
    const out = run(command);
    assert.equal(out && out.permissionDecision, "deny", command);
    assert.match(out.permissionDecisionReason, /node "<plugin dir>\/bin\//, command);
  }
  assert.match(run("& orch-quota").permissionDecisionReason, /`orch-quota`/);
});

test("running them through node, or mentioning them, passes", () => {
  const commands = [
    'node "C:\\plugin\\bin\\orch-trust" --status',
    "Get-Command orch-trust | Select Source",
    "Select-String -Pattern orch-trust notes.md",
    "git commit -m 'fix orch-quota'",
    "orch-trust-extra --x",
    "npm run test",
  ];
  for (const command of commands) assert.equal(run(command), null, command);
});

test("other tools and malformed input pass with exit 0", () => {
  assert.equal(run("orch-trust --status", "Bash"), null);
  for (const input of ["", "not json", "null", "[]", '{"tool_name":"PowerShell"}', '{"tool_name":"PowerShell","tool_input":"x"}']) {
    const r = runRaw(input);
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, "", input);
  }
});
