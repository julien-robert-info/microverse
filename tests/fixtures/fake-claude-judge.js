"use strict";

// Stands in for `claude -p` in the judge tests. It is run as `node <this file>
// <the arguments the bench passes>`. What it does is read from the JSON file
// named by FAKE_CONFIG (re-read on every call); `perCall[n]` overrides the
// settings for the n-th call (counted from the lines of FAKE_LOG). Every call
// is recorded in FAKE_LOG: arguments, working directory, standard input and
// environment.

const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const slugOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
const args = process.argv.slice(2);
const after = (flag) => args[args.indexOf(flag) + 1];

const base = JSON.parse(readFileSync(process.env.FAKE_CONFIG, "utf8"));
const logFile = process.env.FAKE_LOG;
const n = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).length : 0;
const cfg = { ...base, ...(base.perCall?.[n] ?? {}) };

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  appendFileSync(logFile, `${JSON.stringify({ args, cwd: process.cwd(), stdin, env: process.env })}\n`);
  if (cfg.hang) return setInterval(() => {}, 1000);

  const session = after("--session-id");
  const model = cfg.model ?? "claude-opus-5-5";
  if (cfg.writeFile) writeFileSync(join(process.cwd(), "stray.txt"), "x");

  const dir = join(process.env.FAKE_PROJECTS, slugOf(process.cwd()));
  mkdirSync(dir, { recursive: true });
  const usage = { input_tokens: 1000, output_tokens: 100 };
  const lines = [];
  if (cfg.attachFiles) lines.push({ type: "attachment", attachment: { type: "instructions", files: [{ path: "X/CLAUDE.md", type: "Project", content: "x" }] } });
  lines.push({ type: "assistant", timestamp: "2026-01-01T00:00:00Z", requestId: "r1", message: { id: "m1", model, usage } });
  if (!cfg.noTranscript) writeFileSync(join(dir, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (cfg.subagent && !cfg.noTranscript) {
    const sub = join(dir, session, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-abc123.meta.json"), JSON.stringify({ agentType: cfg.subagent }));
    writeFileSync(join(sub, "agent-abc123.jsonl"), `${JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:00Z", requestId: "r2", message: { id: "m2", model, usage } })}\n`);
  }

  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  out({ type: "system", subtype: "init", session_id: session, model: cfg.initModel ?? model, tools: cfg.tools ?? ["StructuredOutput"], mcp_servers: cfg.mcp ?? [], plugins: cfg.plugins ?? [] });
  const answer = cfg.answer ?? { rubric: "r1", scores: { fidelity: 5, correctness: 4, tests: 3, clarity: 4, scope: 4 }, defects: [{ criterion: "tests", severity: "minor", summary: "one case missing" }] };
  const result = { type: "result", subtype: cfg.subtype ?? "success", is_error: Boolean(cfg.isError), session_id: session, total_cost_usd: 0.006, result: cfg.resultText ?? "" };
  if (cfg.structured !== false && !cfg.resultText) result.structured_output = answer;
  else if (cfg.resultText === undefined && cfg.structured === false) result.result = JSON.stringify(answer);
  out(result);
  process.exit(cfg.exitCode ?? 0);
});
