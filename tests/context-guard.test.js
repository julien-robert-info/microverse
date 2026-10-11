"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, realpathSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT } = require("./helpers.js");

const HOOK = join(ROOT, "scripts", "context-guard.js");

function setup({ profile = true } = {}) {
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-guard-")));
  if (profile) {
    mkdirSync(join(project, ".claude", "orchestration"), { recursive: true });
    writeFileSync(join(project, ".claude", "orchestration", "profile.json"), "{}");
  }
  return { project, data: join(project, "data"), transcript: join(project, "t.jsonl") };
}

// A transcript whose last request holds `tokens` tokens of context, split
// across the three input counters.
function transcript(ctx, tokens, id = "m1") {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: tokens - 100, output_tokens: 5 };
  const line = JSON.stringify({ timestamp: "2026-10-10T10:00:00.000Z", requestId: `r-${id}`, message: { id, model: "claude-opus-5-5", usage } });
  writeFileSync(ctx.transcript, `${line}\n`);
}

const run = (ctx, input, session = "s1") =>
  spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify({ session_id: session, transcript_path: ctx.transcript, cwd: ctx.project, ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.project, CLAUDE_PLUGIN_DATA: ctx.data },
  });

const message = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "");

test("below the threshold the hook is silent", () => {
  const ctx = setup();
  transcript(ctx, 149000);
  const r = run(ctx, {});
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("above the threshold the hook speaks once, then again at the next 50K step only", () => {
  const ctx = setup();
  transcript(ctx, 160000);
  const first = run(ctx, {});
  assert.equal(first.status, 0);
  assert.match(message(first), /context 160K: series report, then switch conversation once no agent awaits review/);
  assert.equal(JSON.parse(first.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");

  transcript(ctx, 190000);
  assert.equal(run(ctx, {}).stdout, "", "same step, no second message");

  transcript(ctx, 205000, "m2");
  assert.match(message(run(ctx, {})), /context 205K/);
  assert.equal(run(ctx, {}).stdout, "");

  assert.match(message(run(ctx, {}, "other")), /context 205K/, "another session has its own state");
});

test("without a profile the hook is silent", () => {
  const ctx = setup({ profile: false });
  transcript(ctx, 300000);
  const r = run(ctx, {});
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("malformed input or a missing transcript exits 0 silently", () => {
  const ctx = setup();
  for (const input of ["not json", "", "[]"]) {
    const r = run(ctx, input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
  const r = run(ctx, { transcript_path: join(ctx.project, "missing.jsonl") });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("the context is read from the tail of a large transcript", () => {
  const ctx = setup();
  const filler = `${JSON.stringify({ type: "user", text: "x".repeat(1000) })}\n`.repeat(1500);
  const last = JSON.stringify({ timestamp: "2026-10-10T10:00:00.000Z", requestId: "r", message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 170000 } } });
  writeFileSync(ctx.transcript, `${filler}${last}\n`);
  assert.match(message(run(ctx, {})), /context 170K/);
});

test("CLAUDE.local.md warns above 60 lines, once per session", () => {
  const ctx = setup();
  transcript(ctx, 1000);
  const lines = (n) => `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;
  writeFileSync(join(ctx.project, "CLAUDE.local.md"), lines(60));
  assert.equal(run(ctx, {}).stdout, "");
  writeFileSync(join(ctx.project, "CLAUDE.local.md"), lines(61));
  assert.match(message(run(ctx, {})), /CLAUDE\.local\.md has 61 lines/);
  assert.equal(run(ctx, {}).stdout, "");
});
