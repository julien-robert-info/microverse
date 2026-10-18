"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { ROOT } = require("./helpers.js");

const HOOK = join(ROOT, "scripts", "agent-model-guard.js");

const runRaw = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: "utf8" });
const launch = (subagent_type, model, tool_name = "Agent") => {
  const tool_input = { subagent_type, description: "x", prompt: "y" };
  if (model !== undefined) tool_input.model = model;
  const r = runRaw(JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }));
  assert.equal(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};

test("every allowed combination passes", () => {
  const allowed = [
    ["rick", "opus"],
    ["rick", "sonnet"],
    ["morty", "sonnet"],
    ["council", "opus"],
    ["meeseeks", "haiku"],
    ["meeseeks", "sonnet"],
  ];
  for (const [role, model] of allowed) assert.equal(launch(`microverse:${role}`, model), null, `${role} ${model}`);
});

test("a combination outside the table is denied with the allowed models", () => {
  const out = launch("microverse:morty", "haiku");
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /sonnet/);
  assert.doesNotMatch(out.permissionDecisionReason, /opus/);

  assert.equal(launch("microverse:council", "sonnet").permissionDecision, "deny");
  assert.equal(launch("microverse:meeseeks", "opus").permissionDecision, "deny");
});

test("a missing model is denied", () => {
  const out = launch("microverse:rick", undefined);
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /opus, sonnet/);
});

test("other agent types and unknown microverse roles pass", () => {
  assert.equal(launch("general-purpose", undefined), null);
  assert.equal(launch("general-purpose", "haiku"), null);
  assert.equal(launch("Explore", "opus"), null);
  assert.equal(launch("microverse:unknown", undefined), null);
  assert.equal(launch(undefined, undefined), null);
});

test("malformed or empty input passes with exit 0", () => {
  for (const input of ["", "not json", "null", "[]", '{"tool_name":"Agent"}', '{"tool_name":"Agent","tool_input":"x"}']) {
    const r = runRaw(input);
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, "", input);
  }
});

test("the Task tool name behaves as Agent", () => {
  assert.equal(launch("microverse:morty", "haiku", "Task").permissionDecision, "deny");
  assert.equal(launch("microverse:morty", "sonnet", "Task"), null);
  assert.equal(launch("microverse:morty", "haiku", "Bash"), null);
});
