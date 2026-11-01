// UserPromptExpansion hook for /microverse:doctor: runs bin/orch-doctor and
// shows its report as the (blocked) command's message, so the command costs no
// model request. Writes nothing and exits 0 whatever doctor answers; on a
// payload it does not understand it prints nothing and the command expands
// normally, the skill body running the same script through the model.
//
// The child gets neither CLAUDE_PLUGIN_DATA nor the plugin options, as the Bash
// tool does not: the report must be the one the model would get.
"use strict";

const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { sanitize } = require("./orch-lib.js");

const MAX = 9000;
const COMMAND = "microverse:doctor";

function clean(text) {
  let s = sanitize(text).trim();
  if (s.length > MAX) {
    const cut = s.lastIndexOf("\n", MAX - 60);
    s = `${s.slice(0, cut > 0 ? cut : MAX - 60)}\n… output truncated`;
  }
  return s;
}

function main() {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  if (payload?.command_name !== COMMAND) return;
  const cwd = process.env.CLAUDE_PROJECT_DIR || payload.cwd;
  if (!cwd) return;

  const args = ["--from-hook", "--project", cwd];
  const transcript = payload.transcript_path;
  if (typeof transcript === "string" && transcript && !transcript.startsWith("-")) args.push("--transcript", transcript);

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "CLAUDE_PLUGIN_DATA" || k.startsWith("CLAUDE_PLUGIN_OPTION_")) delete env[k];
  const r = spawnSync(process.execPath, [join(__dirname, "..", "bin", "orch-doctor"), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (r.error || r.status === null) return;
  const text = clean((r.stdout ?? "") + (r.status <= 1 ? "" : r.stderr ?? ""));
  if (text) block(text);
}

function block(reason) {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: clean(reason),
      hookSpecificOutput: { hookEventName: "UserPromptExpansion", suppressOriginalPrompt: true },
    }),
  );
}

try {
  main();
} catch {}
// Not process.exit: on a pipe stdout is flushed asynchronously and exit cuts it.
process.exitCode = 0;
