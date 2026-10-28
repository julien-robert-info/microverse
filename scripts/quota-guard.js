// PreToolUse hook (matcher Agent|Task): refuses the launch of a morty or a rick
// when the quota advice (the one of bin/orch-quota) is at a limit, whether or
// not the orchestrator ran orch-quota. Costs no token: it is computed here.
//
// Read only and in process: the readings are read without pruning, the stored
// calibration is used even when stale (recomputing it takes longer than the
// hook's timeout), and nothing is written. Council, meeseeks and other agents
// pass, as does anything it cannot compute (no profile, no weekly reading, any
// error): a false refusal blocks the user's work, a false pass costs no more
// than not having the guard.
//
// Launches sent in one message do not see each other as running: none of them
// has a transcript yet when the guard runs.
"use strict";

// The Bash tool does not get it, so orch-quota run there stores the calibration
// under ~/.claude/microverse/: look there too, before calibrationFile() is called.
delete process.env.CLAUDE_PLUGIN_DATA;

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const lib = require("./orch-lib.js");
const statusline = require("./statusline.js");

const GUARDED = ["microverse:morty", "microverse:rick"];
const REFUSED = ["stop", "week-limit", "no-resume", "five-hour", "no-room"];

// Empty, unexpanded (`${user_config.KEY}`) or not a number: the default. An
// empty value must never become 0, which would refuse every launch.
function option(name, fallback) {
  const raw = process.env[`CLAUDE_PLUGIN_OPTION_${name}`];
  if (!lib.setOption(raw)) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function main() {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  if (payload.tool_name !== "Agent" && payload.tool_name !== "Task") return;
  const type = payload.tool_input && payload.tool_input.subagent_type;
  if (!GUARDED.includes(type)) return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd;
  if (!projectDir || !existsSync(join(projectDir, ".claude", "orchestration", "profile.json"))) return;

  const target = option("WEEK_TARGET", 98);
  const reserve = option("WEEKDAY_RESERVE", 30);
  const fiveLimit = option("FIVE_HOUR_LIMIT", 90);
  const rawFile = process.env.CLAUDE_PLUGIN_OPTION_QUOTA_FILE;
  const file = lib.setOption(rawFile) ? rawFile : lib.defaultQuotaFile();

  const now = Date.now();
  let extensionObs = [];
  try {
    extensionObs = JSON.parse(readFileSync(file, "utf8")).observations ?? [];
  } catch {
    // absent or unreadable: the status line readings may be enough
  }
  const statuslineObs = lib.statuslineObservations(statusline.readReadings({ now, prune: false }));
  const historyObs = lib.risingOnly(statusline.readHistory({ now, prune: false }));
  const { week, f, w } = lib.mergeReadings({ extensionObs, statuslineObs, historyObs, now });
  const state = lib.quotaState({ week, f, w, now, target, reserve });
  if (!state) return;

  const running = lib.countRunning(lib.walkTranscripts(), { now, currentSlug: lib.projectSlug(projectDir) }).total;
  const cal = lib.loadCalibration();
  const agentCost = lib.learnedAgentCost(cal)?.points ?? lib.FIVE_HOUR_COST;
  const { level, text } = lib.paceDecision({
    used7: state.used7,
    used5: state.used5,
    delta: state.delta,
    target,
    period: state.period.target,
    fiveLimit,
    reset5: state.reset5,
    running,
    agentCost,
  });

  const out = (fields) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } }));
  const stale5 = lib.staleFiveHourWarning(f, now);

  if (REFUSED.includes(level)) {
    const reading = f ? `reading ${Math.round((now - f.observedAt) / 60e3)} min old` : "no current reading";
    const reason =
      `Quota: ${text}. 5h ${state.used5} % (${reading}), week ${state.used7} %, ${running} running, ~${agentCost} points per agent. ` +
      "Raise the five_hour_limit or week_target option of the microverse plugin to launch anyway.";
    out({ permissionDecision: "deny", permissionDecisionReason: reason.replace(/\s+/g, " ") });
    return;
  }
  const notes = [];
  if (level === "smooth") notes.push(`Quota: ${text}.`);
  if (stale5) notes.push(stale5);
  if (notes.length) out({ additionalContext: notes.join("\n") });
}

try {
  main();
} catch {}
// Not process.exit: on a pipe stdout is flushed asynchronously and exit cuts it.
process.exitCode = 0;
