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
  assert.match(r.out, /context 1000K tokens, threshold 150K/);
});

test("orch-usage --context takes its threshold from the compact_window option", () => {
  const { env, project } = fixture();
  const r = script("orch-usage", ["--project", project, "--context"], process.cwd(), { ...env, CLAUDE_PLUGIN_OPTION_COMPACT_WINDOW: "1500000" });
  assert.match(r.out, /threshold 150K/, "out of range falls back");
  const ok = script("orch-usage", ["--project", project, "--context"], process.cwd(), { ...env, CLAUDE_PLUGIN_OPTION_COMPACT_WINDOW: "250000" });
  assert.match(ok.out, /threshold 250K/);
});

const step = (type, input, extra = {}) => ({ type, input_tokens: input, output_tokens: 0, ...extra });

// A conversation with one request that consulted the advisor and one that did
// not, and a Haiku agent run whose two steps straddle the price tier, plus one
// advisor call.
function advisedFixture() {
  const { env, project } = fixture();
  const slug = project.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
  const sessions = join(env.HOME, ".claude", "projects", slug);
  const subagents = join(sessions, "sess1", "subagents");
  const opus = { model: "claude-opus-5-5" };
  writeFileSync(
    join(sessions, "sess1.jsonl"),
    request("c1", "claude-sonnet-5-5", { input_tokens: 1e6, output_tokens: 0, iterations: [step("message", 1e6)] }) +
      request("c2", "claude-sonnet-5-5", {
        input_tokens: 1e6,
        output_tokens: 0,
        iterations: [step("message", 5e5), step("advisor_message", 46108, { ...opus, output_tokens: 875 }), step("message", 5e5)],
      }),
  );
  const haiku = request("h1", "claude-haiku-5-5", {
    input_tokens: 180000,
    output_tokens: 0,
    iterations: [step("message", 60000), step("message", 120000), step("advisor_message", 4000, opus)],
  });
  writeFileSync(join(subagents, "agent-a1.jsonl"), request("m2", "claude-sonnet-5-5", { input_tokens: 1e6, output_tokens: 0 }));
  // Streamed: the same request twice.
  writeFileSync(join(subagents, "agent-a2.jsonl"), haiku + haiku);
  writeFileSync(join(subagents, "agent-a2.meta.json"), JSON.stringify({ agentType: "microverse:meeseeks", description: "Look it up" }));
  return { env, project };
}

test("orch-usage counts advisor calls under their own model, once per streamed request", () => {
  const { env, project } = advisedFixture();
  const r = script("orch-usage", ["--project", project, "--since", "2026-10-01"], process.cwd(), env);
  assert.equal(r.code, 0, r.out);
  // 46108 x $4 + 875 x $20 per MTok = 0.2019.
  assert.match(r.out, /conversation\tclaude-opus-5-5 \(advisor\)\t1\t0\.05\t0\.00\t0\.00\t0\.00\t0\.00\t0\.20/);
  // The executor row keeps the top-level sums: 2 x 1M input at $2.
  assert.match(r.out, /conversation\tclaude-sonnet-5-5\t2\t2\.00.*\t4\.00/);
  assert.match(r.out, /agent\tclaude-opus-5-5 \(advisor\)\t1\t0\.00.*\t0\.02/);
  // 60K at the small tier and 120K at the large tier: 0.006 + 0.06.
  assert.match(r.out, /agent\tclaude-haiku-5-5\t1\t0\.18.*\t0\.07/);
});

test("orch-usage --agents includes the advisor cost in the run", () => {
  const { env, project } = advisedFixture();
  const r = script("orch-usage", ["--project", project, "--since", "2026-10-01", "--agents"], process.cwd(), env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /microverse:meeseeks\tclaude-haiku-5-5\t1\t0\.08\tLook it up/);
});
