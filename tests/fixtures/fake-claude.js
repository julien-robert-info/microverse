"use strict";

// Stands in for `claude -p` in the bench run tests. It is run as `node <this
// file> <the arguments the bench passes>` from the slot. What it does is read
// from the JSON file named by FAKE_CONFIG (re-read on every call); `perCall[n]`
// overrides the settings for the n-th call (counted from the lines of
// FAKE_LOG). Every call is recorded in FAKE_LOG: arguments, working directory
// and environment. `--version` answers and logs nothing.
//
// Settings (initPlugins defaults to microverse when --plugin-dir is passed, else none): initPlugins,initSkills, initModel, model, cost, noTranscript,
// results (number of result events), subtype, hang, child (leave a process
// whose command line holds the slot), commit ({ file, content } on the slot's
// main), removeMarker, leak (a path read in a tool call), exitCode.

const { spawn, spawnSync } = require("node:child_process");
const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const slugOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
const args = process.argv.slice(2);
const after = (flag) => args[args.indexOf(flag) + 1];

if (args.includes("--version")) {
  process.stdout.write("9.9.9 (Fake Code)\n");
  process.exit(0);
}

const base = JSON.parse(readFileSync(process.env.FAKE_CONFIG, "utf8"));
const logFile = process.env.FAKE_LOG;
const n = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).length : 0;
const cfg = { ...base, ...(base.perCall?.[n] ?? {}) };
appendFileSync(logFile, `${JSON.stringify({ args, cwd: process.cwd(), env: process.env })}\n`);

const session = after("--session-id");
const model = cfg.model ?? "claude-sonnet-5-5";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

// The transcript, where `claude` keeps it.
if (!cfg.noTranscript) {
  const dir = join(process.env.FAKE_PROJECTS, slugOf(process.cwd()));
  mkdirSync(dir, { recursive: true });
  const usage = { input_tokens: 1000, output_tokens: 100 };
  const lines = [{ type: "assistant", timestamp: "2026-01-01T00:00:00Z", requestId: "r1", message: { id: "m1", model, usage } }];
  if (cfg.leak) {
    lines.push({
      type: "assistant", timestamp: "2026-01-01T00:00:01Z", requestId: "r2",
      message: { id: "m2", model, usage, content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: cfg.leak } }] },
    });
  }
  writeFileSync(join(dir, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

out({ type: "system", subtype: "init", session_id: session, model, tools: ["Read", "Edit", "Bash"], mcp_servers: [], plugins: cfg.initPlugins ?? (args.includes("--plugin-dir") ? [{ name: "microverse", source: "inline" }] : []), skills: cfg.initSkills ?? [] });

if (cfg.child) spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", process.cwd()], { stdio: "ignore", windowsHide: true, detached: true }).unref();
if (cfg.removeMarker) rmSync(join(process.cwd(), ".bench-slot"));
if (cfg.commit) {
  writeFileSync(join(process.cwd(), cfg.commit.file), cfg.commit.content);
  const git = (...a) => spawnSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@example.invalid", ...a], { cwd: process.cwd() });
  git("add", "-A");
  git("commit", "-qm", "feat: work");
}
if (cfg.hang) setInterval(() => {}, 1000);
else {
  for (let i = 0; i < (cfg.results ?? 1); i++) {
    out({ type: "result", subtype: cfg.subtype ?? "success", is_error: false, session_id: session, total_cost_usd: (cfg.cost ?? 0.5) * (i + 1), result: "done." });
  }
  process.stdout.write("", () => process.exit(cfg.exitCode ?? 0));
}
