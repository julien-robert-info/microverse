"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { script } = require("./helpers.js");

const request = (id, model, usage) =>
  JSON.stringify({ timestamp: "2026-10-10T10:00:00.000Z", requestId: `r-${id}`, message: { id, model, usage } }) + "\n";

// A fake home with one conversation (Opus, 1M input tokens) and one agent run
// (Sonnet, 1M input tokens), for a project at `project`.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "microverse-home-"));
  const project = join(home, "my-project");
  const slug = project.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
  const sessions = join(home, ".claude", "projects", slug);
  const subagents = join(sessions, "sess1", "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(sessions, "sess1.jsonl"), request("m1", "claude-opus-5-5", { input_tokens: 1e6, output_tokens: 0 }));
  writeFileSync(join(subagents, "agent-a1.jsonl"), request("m2", "claude-sonnet-5-5", { input_tokens: 1e6, output_tokens: 0 }));
  writeFileSync(join(subagents, "agent-a1.meta.json"), JSON.stringify({ agentType: "microverse:morty", description: "Add the thing" }));
  return { env: { HOME: home, USERPROFILE: home }, project };
}

test("orch-usage prices tokens at the API rates, conversations and agents apart", () => {
  const { env, project } = fixture();
  const r = script("orch-usage", ["--project", project, "--since", "2026-10-01"], process.cwd(), env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /conversation\tclaude-opus-5-5\t1\t1\.00.*\t4\.00/);
  assert.match(r.out, /agent\tclaude-sonnet-5-5\t1\t1\.00.*\t2\.00/);
  assert.match(r.out, /total.*6\.00/);
});

test("orch-usage --agents lists each agent run with its type and task", () => {
  const { env, project } = fixture();
  const r = script("orch-usage", ["--project", project, "--since", "2026-10-01", "--agents"], process.cwd(), env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /microverse:morty\tclaude-sonnet-5-5\t1\t2\.00\tAdd the thing/);
});

test("orch-usage --context reports the size of the last request", () => {
  const { env, project } = fixture();
  const r = script("orch-usage", ["--project", project, "--context"], process.cwd(), env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /context 1000K tokens/);
});
