// UserPromptSubmit hook: tells the orchestrating conversation to save its state
// when its context nears the auto-compaction window, flags a window that seems
// not to be configured, and warns when the project's CLAUDE.local.md grows.
// Active only in a project with an orchestration profile; silent otherwise and
// on any error, so it never slows or blocks a prompt.
//
// The context size is that of the last request, read from the last 512 KB of
// the transcript. The approach warning is given once and re-armed when a later
// prompt sees a small context (a compaction happened). State lives in
// <plugin data>/context-guard/<session_id>.json.
"use strict";

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { lastContext, readTail } = require("./orch-lib.js");

const DEFAULT_WINDOW = 150e3;
const MIN_WINDOW = 100e3;
const MAX_WINDOW = 1e6;
const MARGIN = 20e3;
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
  const before = JSON.stringify(state);

  const messages = [];

  let last = null;
  try {
    last = lastContext(readTail(payload.transcript_path, TAIL_BYTES));
  } catch {}
  if (last) {
    const raw = process.env.CLAUDE_PLUGIN_OPTION_COMPACT_WINDOW;
    const parsed = /^\s*\d+\s*$/.test(raw ?? "") ? parseInt(raw, 10) : NaN;
    const window = parsed >= MIN_WINDOW && parsed <= MAX_WINDOW ? parsed : DEFAULT_WINDOW;
    const k = Math.round(last.tokens / 1e3);
    if (last.tokens >= window + MARGIN) {
      // Compaction should have happened already; the approach warning is moot.
      if (!state.windowMissingWarned) {
        state.windowMissingWarned = true;
        messages.push(`context ${k}K is past the auto-compaction window ${window / 1e3}K: autoCompactWindow is probably not set in .claude/settings.local.json (run /microverse:init), or run /compact`);
      }
      state.compactWarned = true;
    } else if (last.tokens >= window - MARGIN) {
      if (!state.compactWarned) {
        state.compactWarned = true;
        messages.push(`context ${k}K, auto-compaction at ${window / 1e3}K: update the state file now (chantiers, decisions not yet in the notes, pending questions); no conversation switch`);
      }
    } else state.compactWarned = false;
  }

  const localMd = join(projectDir, "CLAUDE.local.md");
  if (!state.localMdWarned && existsSync(localMd)) {
    const lines = readFileSync(localMd, "utf8").replace(/\n$/, "").split("\n").length;
    if (lines > LOCAL_MD_LINES) {
      state.localMdWarned = true;
      messages.push(`CLAUDE.local.md has ${lines} lines (limit ${LOCAL_MD_LINES}): shrink it, history goes to the notes`);
    }
  }

  if (JSON.stringify(state) !== before) {
    mkdirSync(join(stateFile, ".."), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state));
  }
  if (!messages.length) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: messages.join("\n") } }));
}

try {
  main();
} catch {}
process.exit(0);
