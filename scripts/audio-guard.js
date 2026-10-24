// Stop hook: when the audio report is on, makes the orchestrator send the mp3 of
// a `▶` message it showed without one. Blocks the end of the turn once (the
// block reason is the instruction); `stop_hook_active` stops a second block.
//
// The audio report is on when CLAUDE.local.md has a line `Audio report: on…`
// (language-independent, written by the orchestration skill). Active only in a
// project with an orchestration profile; silent otherwise and on any error.
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { readTail } = require("./orch-lib.js");

const TAIL_BYTES = 2 * 1024 * 1024;

function audioOn(projectDir) {
  let text;
  try {
    text = readFileSync(join(projectDir, "CLAUDE.local.md"), "utf8");
  } catch {
    return false;
  }
  return text.split(/\r?\n/).some((line) => /^\s*(?:-\s+)?audio report: on/i.test(line) && !/edge-tts missing/i.test(line));
}

// A real prompt: a user entry with a string, or text blocks and no tool_result.
function isPrompt(entry) {
  if (entry.type !== "user") return false;
  const content = entry.message && entry.message.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some((b) => b && b.type === "text") && !content.some((b) => b && b.type === "tool_result");
}

function main() {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  if (payload.stop_hook_active) return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd;
  if (!projectDir || !existsSync(join(projectDir, ".claude", "orchestration", "profile.json"))) return;
  if (!audioOn(projectDir)) return;

  const entries = [];
  for (const line of readTail(payload.transcript_path, TAIL_BYTES).split("\n")) {
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  let start = 0;
  entries.forEach((e, i) => {
    if (e && isPrompt(e)) start = i + 1;
  });

  const texts = typeof payload.last_assistant_message === "string" ? [payload.last_assistant_message] : [];
  for (const e of entries.slice(start)) {
    if (!e || e.type !== "assistant" || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (!b) continue;
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      if (b.type === "tool_use") {
        if (b.name === "SendUserFile") return;
        if (b.name === "Bash" && typeof (b.input && b.input.command) === "string" && b.input.command.includes("orch-speak")) return;
      }
    }
  }
  if (!texts.some((t) => t.trimStart().startsWith("▶"))) return;

  const reason = [
    "The audio report is on in CLAUDE.local.md and this turn showed a `▶` message without its mp3.",
    `Write the spoken text per ${join(process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, ".."), "skills", "orchestration", "audio.md")}, run \`orch-speak\` from Bash (command in the skill § 6),`,
    "and send the printed path with `SendUserFile` (load it with ToolSearch when deferred). Do not rewrite the message.",
  ].join("\n");
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

try {
  main();
} catch {}
// Not process.exit: on a pipe stdout is flushed asynchronously and exit cuts it.
process.exitCode = 0;
