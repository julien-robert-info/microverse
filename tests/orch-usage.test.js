"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
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

test("orch-usage --agents prints agent descriptions without control or invisible characters", () => {
  const { env, project } = fixture();
  const slug = project.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
  const meta = join(env.HOME, ".claude", "projects", slug, "sess1", "subagents", "agent-a1.meta.json");
  const hostile = `Add \u001b]52;c;QQ\u0007the\u2028thing\u{e0041}\nnext`;
  writeFileSync(meta, JSON.stringify({ agentType: "microverse:morty", description: hostile }));
  const r = script("orch-usage", ["--project", project, "--since", "2026-10-01", "--agents"], process.cwd(), env);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u{e0000}-\u{e007f}]/u);
  assert.match(r.out, /\tAdd \]52;c;QQthething next\n/);
});

// --json: one JSON line, the same figures as the table.
function json(args, env) {
  const r = script("orch-usage", [...args, "--json"], process.cwd(), env);
  const lines = r.out.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, r.out);
  return { code: r.code, out: JSON.parse(lines[0]) };
}

const subagentsOf = (env, project) => join(env.HOME, ".claude", "projects", project.replace(/[^A-Za-z0-9]/g, "-").toLowerCase(), "sess1", "subagents");

test("orch-usage --agents --json lists each run with its id, tokens, end, advisor and cost", () => {
  const { env, project } = advisedFixture();
  // A third run of two requests, 45 minutes apart.
  const sub = subagentsOf(env, project);
  const at = (id, ts) => JSON.stringify({ timestamp: ts, requestId: `r-${id}`, message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 250000, output_tokens: 30000 } } }) + "\n";
  writeFileSync(join(sub, "agent-a3.jsonl"), at("m7", "2026-10-10T11:00:00.000Z") + at("m8", "2026-10-10T11:45:00.000Z"));
  writeFileSync(join(sub, "agent-a3.meta.json"), JSON.stringify({ agentType: "microverse:council", description: "Review it" }));
  const { code, out } = json(["--project", project, "--since", "2026-10-01", "--agents"], env);
  assert.equal(code, 0);
  assert.equal(out.v, 1);
  assert.equal(out.since, Date.parse("2026-10-01"));
  assert.equal(out.project, resolve(project));
  assert.deepEqual(out.runs.map((r) => r.agentId), ["a1", "a2", "a3"]);
  const [a1, a2, a3] = out.runs;
  const t10 = Date.parse("2026-10-10T10:00:00.000Z");
  assert.deepEqual(a1.tokens, { input: 1e6, write5m: 0, write1h: 0, read: 0, output: 0 });
  assert.equal(a1.cost, 2);
  assert.equal(a1.type, "microverse:morty");
  assert.equal(a1.description, "Add the thing");
  assert.deepEqual([a1.started, a1.ended, a1.requests], [t10, t10, 1]);
  assert.deepEqual(a1.advisor, { calls: 0, cost: 0 });
  // The streamed repeat counts once; the advisor's call is billed to the run.
  assert.equal(a2.requests, 1);
  assert.equal(a2.tokens.input, 180000);
  assert.equal(a2.cost, 0.08);
  assert.deepEqual(a2.advisor, { calls: 1, cost: 0.02 });
  assert.equal(a3.requests, 2);
  assert.equal(a3.started, Date.parse("2026-10-10T11:00:00.000Z"));
  assert.equal(a3.ended, Date.parse("2026-10-10T11:45:00.000Z"));
  assert.deepEqual(a3.tokens, { input: 500000, write5m: 0, write1h: 0, read: 0, output: 60000 });
  assert.equal(a3.cost, 1.6); // two requests of 250K x $2 + 30K x $10 per MTok
  assert.deepEqual(out.total, { cost: 3.68, advisor: { calls: 1, cost: 0.02 } });
});

test("orch-usage --agents --json: finished is true only for an agent that handed back and was not resumed", () => {
  const { env, project } = fixture();
  const sub = subagentsOf(env, project);
  const line = (id) => request(id, "claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 0 });
  const t0 = Date.now() - 3600e3;
  const touch = (file, secs) => utimesSync(join(sub, file), new Date(t0 + secs * 1000), new Date(t0 + secs * 1000));
  // a1 is done; a4 is working; a5 handed back, then was written to again a minute later.
  for (const [id, finished] of [["a4", false], ["a5", true], ["a1", true]]) {
    writeFileSync(join(sub, `agent-${id}.jsonl`), line(`m-${id}`));
    writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: "microverse:morty", description: id, ...(finished ? { finished: true } : {}) }));
  }
  touch("agent-a1.jsonl", 0);
  touch("agent-a1.meta.json", 1);
  touch("agent-a4.jsonl", 0);
  touch("agent-a4.meta.json", 0);
  touch("agent-a5.meta.json", 0);
  touch("agent-a5.jsonl", 60);
  const { out } = json(["--project", project, "--since", "2026-10-01", "--agents"], env);
  assert.deepEqual(Object.fromEntries(out.runs.map((r) => [r.agentId, r.finished])), { a1: true, a4: false, a5: false });
});

test("orch-usage --context --json gives the size, the threshold, the percentage and the verdict", () => {
  const { env, project } = fixture();
  const withWindow = { ...env, CLAUDE_PLUGIN_OPTION_COMPACT_WINDOW: "400000" };
  const { code, out } = json(["--project", project, "--context"], withWindow);
  assert.equal(code, 0);
  assert.deepEqual(Object.keys(out), ["v", "project", "session", "model", "tokens", "threshold", "percent", "verdict"]);
  assert.deepEqual([out.session, out.model, out.tokens, out.threshold, out.percent], ["sess1", "claude-opus-5-5", 1e6, 400000, 250]);
  const text = script("orch-usage", ["--project", project, "--context"], process.cwd(), withWindow).out;
  assert.ok(text.trimEnd().endsWith(out.verdict));
});

test("orch-usage --json by model: tokens as counts, a model without a price has a null cost", () => {
  const { env, project } = fixture();
  const sess = join(env.HOME, ".claude", "projects", project.replace(/[^A-Za-z0-9]/g, "-").toLowerCase(), "sess1.jsonl");
  appendFileSync(sess, request("m9", "claude-mystery-9", { input_tokens: 3000, cache_read_input_tokens: 700, output_tokens: 50 }));
  const { code, out } = json(["--project", project, "--since", "2026-10-01"], env);
  assert.equal(code, 0);
  assert.deepEqual(Object.keys(out), ["v", "project", "since", "rows"]);
  assert.equal(out.since, Date.parse("2026-10-01"));
  assert.deepEqual(out.rows.map((r) => `${r.type} ${r.model}`), ["agent claude-sonnet-5-5", "conversation claude-mystery-9", "conversation claude-opus-5-5"]);
  const [agent, mystery, opus] = out.rows;
  assert.deepEqual(agent, { type: "agent", model: "claude-sonnet-5-5", requests: 1, tokens: { input: 1e6, write5m: 0, write1h: 0, read: 0, output: 0 }, cost: 2 });
  assert.deepEqual(mystery.tokens, { input: 3000, write5m: 0, write1h: 0, read: 700, output: 50 });
  assert.equal(mystery.cost, null);
  assert.equal(opus.cost, 4);
});

test("orch-usage --json: a failure is { v, error } with the exit code of the text", () => {
  const { env, project } = fixture();
  const bad = json(["--project", project, "--since", "not-a-date"], env);
  assert.deepEqual([bad.code, bad.out.v, /invalid date/.test(bad.out.error)], [2, 1, true]);
  const elsewhere = join(project, "elsewhere");
  const none = json(["--project", elsewhere, "--agents"], env);
  assert.deepEqual([none.code, none.out.v, /no conversation/.test(none.out.error)], [2, 1, true]);
  assert.equal(script("orch-usage", ["--project", elsewhere], process.cwd(), env).code, 2);
});
