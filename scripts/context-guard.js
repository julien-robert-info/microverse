// UserPromptSubmit hook: warns the orchestrating conversation when its context
// is large, and when the project's CLAUDE.local.md grows. Active only in a
// project with an orchestration profile; silent otherwise and on any error, so
// it never slows or blocks a prompt.
//
// The context size is read from the last 512 KB of the transcript. Each warning
// is given once per session: the context one again at every further 50K step.
// State lives in <plugin data>/context-guard/<session_id>.json.
"use strict";

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { lastContext, readTail } = require("./orch-lib.js");

const THRESHOLD = 150e3;
const STEP = 50e3;
const TAIL_BYTES = 512 * 1024;
const LOCAL_MD_LINES = 60;

function main() {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd;
  if (!projectDir || !existsSync(join(projectDir, ".claude", "orchestration", "profile.json"))) return;

  const session = String(payload.session_id ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!session) return;
  const stateFile = join(process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "microverse"), "context-guard", `${session}.json`);
  let state = {};
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {}

  const messages = [];

  let last = null;
  try {
    last = lastContext(readTail(payload.transcript_path, TAIL_BYTES));
  } catch {}
  const step = last ? Math.floor(last.tokens / STEP) : 0;
  if (last && last.tokens >= THRESHOLD && step > (state.contextStep ?? 0)) {
    state.contextStep = step;
    messages.push(`context ${Math.round(last.tokens / 1e3)}K: series report, then switch conversation once no agent awaits review`);
  }

  const localMd = join(projectDir, "CLAUDE.local.md");
  if (!state.localMdWarned && existsSync(localMd)) {
    const lines = readFileSync(localMd, "utf8").replace(/\n$/, "").split("\n").length;
    if (lines > LOCAL_MD_LINES) {
      state.localMdWarned = true;
      messages.push(`CLAUDE.local.md has ${lines} lines (limit ${LOCAL_MD_LINES}): shrink it, history goes to the notes`);
    }
  }

  if (!messages.length) return;
  mkdirSync(join(stateFile, ".."), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: messages.join("\n") } }));
}

try {
  main();
} catch {}
process.exit(0);
