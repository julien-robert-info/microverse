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
    env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.project, CLAUDE_PLUGIN_DATA: ctx.data, CLAUDE_PLUGIN_OPTION_COMPACT_WINDOW: "", ...ctx.env },
  });

const message = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "");

const APPROACH = (n, w) => `context ${n}K, auto-compaction at ${w}K: update the state file now (missions, decisions not yet in the notes, pending questions); no conversation switch`;

test("the approach warning is given once, and re-armed after a compaction", () => {
  const ctx = setup();
  transcript(ctx, 129000);
  const quiet = run(ctx, {});
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, "");

  transcript(ctx, 131000, "m2");
  const first = run(ctx, {});
  assert.equal(message(first), APPROACH(131, 150));
  assert.equal(JSON.parse(first.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");

  transcript(ctx, 140000, "m3");
  assert.equal(run(ctx, {}).stdout, "");

  transcript(ctx, 60000, "m4");
  assert.equal(run(ctx, {}).stdout, "", "context after a compaction");

  transcript(ctx, 135000, "m5");
  assert.equal(message(run(ctx, {})), APPROACH(135, 150));

  transcript(ctx, 131000, "m6");
  assert.equal(message(run(ctx, {}, "other")), APPROACH(131, 150), "another session has its own state");
});

test("the window comes from the plugin option", () => {
  const ctx = setup();
  ctx.env = { CLAUDE_PLUGIN_OPTION_COMPACT_WINDOW: "300000" };
  transcript(ctx, 270000);
  assert.equal(run(ctx, {}).stdout, "");
  transcript(ctx, 285000, "m2");
  assert.equal(message(run(ctx, {})), APPROACH(285, 300));
});

test("an invalid window falls back to 150K", () => {
  for (const value of ["abc", "50000", "5000000"]) {
    const ctx = setup();
    ctx.env = { CLAUDE_PLUGIN_OPTION_COMPACT_WINDOW: value };
    transcript(ctx, 129000);
    assert.equal(run(ctx, {}).stdout, "", value);
    transcript(ctx, 131000, "m2");
    assert.equal(message(run(ctx, {})), APPROACH(131, 150), value);
  }
});

test("a context past the window reports the missing configuration, once per session", () => {
  const ctx = setup();
  transcript(ctx, 175000);
  assert.equal(
    message(run(ctx, {})),
    "context 175K is past the auto-compaction window 150K: autoCompactWindow is probably not set in .claude/settings.local.json (run /microverse:init), or run /compact",
  );
  transcript(ctx, 180000, "m2");
  assert.equal(run(ctx, {}).stdout, "");
});

test("an old state file with contextStep does not prevent the approach warning", () => {
  const ctx = setup();
  mkdirSync(join(ctx.data, "context-guard"), { recursive: true });
  writeFileSync(join(ctx.data, "context-guard", "s1.json"), JSON.stringify({ contextStep: 3 }));
  transcript(ctx, 135000);
  assert.equal(message(run(ctx, {})), APPROACH(135, 150));
});

const settings = (ctx, content) => {
  mkdirSync(join(ctx.project, ".claude"), { recursive: true });
  writeFileSync(join(ctx.project, ".claude", "settings.local.json"), typeof content === "string" ? content : JSON.stringify(content));
};

test("an autoCompactWindow below compact_window + 33K is reported once per session", () => {
  const ctx = setup();
  settings(ctx, { autoCompactWindow: 150000, model: "sonnet" });
  transcript(ctx, 1000);
  assert.equal(
    message(run(ctx, {})),
    "autoCompactWindow 150000 compacts at about 117K, before compact_window 150K: set it to 183000 (/microverse:init)",
  );
  assert.equal(run(ctx, {}).stdout, "");
});

test("a sufficient autoCompactWindow is not reported", () => {
  const ctx = setup();
  settings(ctx, { autoCompactWindow: 183000 });
  transcript(ctx, 1000);
  assert.equal(run(ctx, {}).stdout, "");
});

test("a missing file, invalid JSON or an absent key gives no autoCompactWindow message", () => {
  for (const content of [null, "{not json", "[]", { model: "sonnet" }, { autoCompactWindow: "150000" }]) {
    const ctx = setup();
    if (content !== null) settings(ctx, content);
    transcript(ctx, 1000);
    const r = run(ctx, {});
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", JSON.stringify(content));
  }
});

test("the autoCompactWindow proposal follows a custom compact_window", () => {
  const ctx = setup();
  ctx.env = { CLAUDE_PLUGIN_OPTION_COMPACT_WINDOW: "200000" };
  settings(ctx, { autoCompactWindow: 220000 });
  transcript(ctx, 1000);
  assert.equal(
    message(run(ctx, {})),
    "autoCompactWindow 220000 compacts at about 187K, before compact_window 200K: set it to 233000 (/microverse:init)",
  );
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
  assert.match(message(run(ctx, {})), /context 170K is past/);
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
