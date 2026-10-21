// UserPromptExpansion hook for /microverse:status: runs bin/orch-status and
// shows its output as the (blocked) command's message, so the command costs no
// model request. Writes nothing and exits 0 on any error or empty output, in
// which case the command expands normally and the skill body runs the same
// script through the model.
//
// The child runs without CLAUDE_PLUGIN_DATA: a hook gets it and the Bash tool
// does not, so keeping it would read another calibration than the
// orchestrator's. The user's argument is passed as one positional token and
// never starts an option.
"use strict";

const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { sanitize } = require("./orch-lib.js");

const MAX = 9000;
const COMMAND = "microverse:status";
const FLAGS = ["--agents", "--verbose"];

// The plugin options reach a hook as CLAUDE_PLUGIN_OPTION_<KEY>; an unset one
// can be empty or still hold its `${user_config.KEY}` placeholder.
const OPTIONS = [
  ["--target", "CLAUDE_PLUGIN_OPTION_WEEK_TARGET"],
  ["--reserve", "CLAUDE_PLUGIN_OPTION_WEEKDAY_RESERVE"],
  ["--five-hour", "CLAUDE_PLUGIN_OPTION_FIVE_HOUR_LIMIT"],
  ["--file", "CLAUDE_PLUGIN_OPTION_QUOTA_FILE"],
];

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

  const args = [];
  // --agents and --verbose are the only options a user may give; the first
  // other token is the commit, and it never starts an option.
  const tokens = typeof payload.command_args === "string" ? payload.command_args.trim().split(/\s+/).filter(Boolean) : [];
  const token = tokens.find((t) => !FLAGS.includes(t)) ?? "";
  args.push(...FLAGS.filter((f) => tokens.includes(f)));
  if (token) {
    if (token.startsWith("-")) return block(`not a commit: ${token}`);
    args.push(token);
  }
  if (typeof payload.session_id === "string" && payload.session_id) args.push("--session", payload.session_id);
  for (const [flag, name] of OPTIONS) {
    const v = process.env[name];
    if (v && !v.includes("${")) args.push(flag, v);
  }

  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_DATA;
  const r = spawnSync(process.execPath, [join(__dirname, "..", "bin", "orch-status"), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (r.error || r.status === null) return;
  const text = clean((r.stdout ?? "") + (r.status === 0 ? "" : r.stderr ?? ""));
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
process.exit(0);
