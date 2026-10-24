"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, realpathSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT } = require("./helpers.js");

const HOOK = join(ROOT, "scripts", "audio-guard.js");

const prompt = (text = "go") => ({ type: "user", message: { role: "user", content: text } });
const said = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (name, input = {}) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
const result = () => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });

// Builds a project and runs the hook on it; `opts.state` is the CLAUDE.local.md text.
function run(entries, opts = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-audio-")));
  if (opts.profile !== false) {
    mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
    writeFileSync(join(dir, ".claude", "orchestration", "profile.json"), "{}");
  }
  if (opts.state !== null) writeFileSync(join(dir, "CLAUDE.local.md"), opts.state ?? "# State\nAudio report: on\n");
  const transcript = join(dir, opts.missing ? "absent.jsonl" : "t.jsonl");
  if (!opts.missing) writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const input = opts.raw ?? JSON.stringify({ hook_event_name: "Stop", cwd: dir, transcript_path: transcript, stop_hook_active: false, ...opts.payload });
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
  assert.equal(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test("T1 a ▶ message without mp3 blocks, naming orch-speak and SendUserFile", () => {
  const out = run([prompt(), said("▶ Series report")]);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /orch-speak/);
  assert.match(out.reason, /SendUserFile/);
  assert.ok(out.reason.split("\n").length <= 3);
});

test("T2 SendUserFile in the turn, before or after the text, is silent", () => {
  assert.equal(run([prompt(), said("▶ r"), tool("SendUserFile", { path: "a.mp3" })]), null);
  assert.equal(run([prompt(), tool("SendUserFile", { path: "a.mp3" }), said("▶ r")]), null);
});

test("T3 a Bash orch-speak call in the turn is silent", () => {
  assert.equal(run([prompt(), said("▶ r"), tool("Bash", { command: "orch-speak --voice x <<'EOF'\nhi\nEOF" })]), null);
});

test("T4 no audio line, or a French wording, is off", () => {
  assert.equal(run([prompt(), said("▶ r")], { state: "# State\n" }), null);
  assert.equal(run([prompt(), said("▶ r")], { state: "Rapport audio : activé\n" }), null);
  assert.equal(run([prompt(), said("▶ r")], { state: null }), null);
});

test("T5 edge-tts missing is off", () => {
  assert.equal(run([prompt(), said("▶ r")], { state: "Audio report: on — edge-tts missing\n" }), null);
});

test("T6 stop_hook_active is silent", () => {
  assert.equal(run([prompt(), said("▶ r")], { payload: { stop_hook_active: true } }), null);
});

test("T7 no profile is silent", () => {
  assert.equal(run([prompt(), said("▶ r")], { profile: false }), null);
});

test("T8 a ▶ in an earlier turn only is silent", () => {
  assert.equal(run([prompt("a"), said("▶ old"), prompt("b"), said("plain")]), null);
  assert.equal(run([prompt("a"), said("▶ old"), prompt("b"), said("plain")].map((e, i) => (i === 2 ? { type: "user", message: { content: [{ type: "text", text: "b" }] } } : e))), null);
});

test("T9 a tool_result entry does not start a new turn", () => {
  const out = run([prompt(), said("▶ r"), tool("Bash", { command: "ls" }), result(), said("done")]);
  assert.equal(out.decision, "block");
});

test("T10 a dashed, CRLF, upper-case line is on", () => {
  const out = run([prompt(), said("▶ r")], { state: "# State\r\n- audio report: ON, voice x\r\nnext\r\n" });
  assert.equal(out.decision, "block");
});

test("T12 ▶ only in last_assistant_message blocks", () => {
  const out = run([prompt(), said("working")], { payload: { last_assistant_message: "  ▶ Question" } });
  assert.equal(out.decision, "block");
  assert.equal(run([prompt(), said("working")], { payload: { last_assistant_message: "plain" } }), null);
});

test("T11 garbage stdin or a missing transcript exits 0 silently", () => {
  assert.equal(run([], { raw: "not json" }), null);
  assert.equal(run([], { missing: true }), null);
});
