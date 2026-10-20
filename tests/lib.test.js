"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { sanitize, agentWorktrees, lastContext, listWorktrees, normPath, paceAdvice, parseArgs } = require("../scripts/orch-lib.js");
const { git, makeRepo } = require("./helpers.js");

const norm = (p) => p.replace(/\\/g, "/").toLowerCase();

test("parseArgs splits options, flags and positionals", () => {
  const o = parseArgs(["feat/x", "--base", "dev", "--no-checks", "--since", "2026-01-01"]);
  assert.deepEqual(o._, ["feat/x"]);
  assert.equal(o.base, "dev");
  assert.equal(o["no-checks"], true);
  assert.equal(o.since, "2026-01-01");
});

test("normPath ignores separator and case", () => {
  assert.equal(normPath("D:/Dev/Perso"), normPath("d:\\dev\\perso"));
});

test("parseArgs: a listed flag never takes the next token", () => {
  const o = parseArgs(["--no-checks", "feat/x", "--merged"], { flags: ["no-checks", "merged"] });
  assert.deepEqual(o._, ["feat/x"]);
  assert.equal(o["no-checks"], true);
  assert.equal(o.merged, true);
});

test("parseArgs: an unlisted option still takes its value", () => {
  const o = parseArgs(["--base", "dev", "feat/x"], { flags: ["merged"] });
  assert.equal(o.base, "dev");
  assert.deepEqual(o._, ["feat/x"]);
});

const ADVISED = {
  timestamp: "2026-10-10T10:00:00.000Z",
  requestId: "r1",
  message: {
    id: "m1",
    model: "claude-sonnet-5-5",
    usage: {
      input_tokens: 4,
      cache_read_input_tokens: 72117,
      cache_creation_input_tokens: 17516,
      cache_creation: { ephemeral_5m_input_tokens: 577, ephemeral_1h_input_tokens: 16939 },
      output_tokens: 446,
      iterations: [
        { type: "message", input_tokens: 2, output_tokens: 26, cache_read_input_tokens: 27589, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 16939 } },
        { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 46108, output_tokens: 875, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
        { type: "message", input_tokens: 2, output_tokens: 420, cache_read_input_tokens: 44528, cache_creation: { ephemeral_5m_input_tokens: 577, ephemeral_1h_input_tokens: 0 } },
      ],
    },
  },
};

test("lastContext counts the last executor step of a request with an advisor call", () => {
  const text = JSON.stringify(ADVISED) + "\n";
  assert.deepEqual(lastContext(text), { model: "claude-sonnet-5-5", ts: "2026-10-10T10:00:00.000Z", tokens: 45107 });
  // A streamed repeat of the same request gives the same result.
  assert.equal(lastContext(text + text).tokens, 45107);
});

test("lastContext without iterations uses the top-level usage", () => {
  const line = { timestamp: "t", requestId: "r", message: { id: "m", model: "claude-sonnet-5-5", usage: { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } };
  assert.equal(lastContext(JSON.stringify(line)).tokens, 18);
});

// On the line, mid-week, 5h counter low: the base case each test shifts.
const pace = (o) => paceAdvice({ used7: 40, used5: 10, delta: 0, target: 98, period: 98, fiveLimit: 90, ...o });

test("paceAdvice: on the line, two agents, fewer when the 5h room cannot pay for them", () => {
  assert.match(pace({}), /^normal: up to 2 agents/);
  assert.match(pace({ used5: 60 }), /^normal: up to 2 agents/);
  assert.match(pace({ used5: 70 }), /^normal: one agent at a time/);
});

test("paceAdvice: behind the line, three agents, fewer when the 5h room cannot pay for them", () => {
  assert.match(pace({ delta: -11 }), /^speed up: up to 3 agents/);
  assert.match(pace({ delta: -11, used5: 45 }), /^speed up: up to 3 agents/);
  assert.match(pace({ delta: -11, used5: 60 }), /^speed up: up to 2 agents/);
});

test("paceAdvice: no new agent when the 5h room is under the cost of one", () => {
  assert.match(pace({ used5: 76, reset5: " until X" }), /^no new agent: 14 points left before the 5h limit, about 15 per agent until X/);
  assert.match(pace({ used5: 75 }), /^normal: one agent at a time/);
});

test("paceAdvice: running agents keep their share of the 5h room", () => {
  assert.match(pace({ used5: 40, running: 2 }), /^normal: up to 2 agents/);
  assert.match(pace({ used5: 50, running: 3 }), /^no new agent: 40 points left before the 5h limit, 3 running and about 15 per agent/);
  assert.match(pace({ used5: 60, running: 1 }), /^normal: up to 2 agents/);
  assert.match(pace({ used5: 70, running: 1 }), /^no new agent/);
  assert.match(pace({ used5: 40, agentCost: 25 }), /^normal: up to 2 agents/);
  assert.match(pace({ used5: 70, agentCost: 25 }), /^no new agent/);
});

test("paceAdvice: ahead of the line or at the period target, no new agent", () => {
  assert.match(pace({ delta: 6 }), /^smooth out/);
  assert.match(pace({ used7: 70, period: 68 }), /^smooth out/);
});

test("paceAdvice: the weekly and 5h limits come before the pace", () => {
  assert.match(pace({ used7: 98, delta: -20 }), /^stop/);
  assert.match(pace({ used7: 95, delta: -20 }), /^no new agent \(≥ 95 %\)/);
  assert.match(pace({ used5: 90, delta: -20, reset5: " until X" }), /^no new agent until X/);
  assert.match(pace({ used5: 95, delta: -20 }), /^no more resuming/);
});

test("listWorktrees gives the main worktree first, and nothing outside a git repository", () => {
  const { dir, wt } = makeRepo({});
  const list = listWorktrees(wt);
  assert.equal(list.length, 2);
  assert.equal(norm(list[0].path), norm(dir));
  assert.equal(list[0].branch, "main");
  assert.equal(norm(list[1].path), norm(wt));
  assert.equal(list[1].branch, "feat/x");
  assert.match(list[1].head, /^[0-9a-f]{40}$/);
  assert.deepEqual(listWorktrees(mkdtempSync(join(tmpdir(), "microverse-nogit-"))), []);
});

test("agentWorktrees keeps the worktrees under .claude/worktrees, with merge status and details", () => {
  const { dir, wt } = makeRepo({});
  git(dir, "worktree", "add", "-q", "-b", "feat/done", join(dir, ".claude", "worktrees", "done"));
  git(dir, "worktree", "add", "-q", "--detach", join(dir, ".claude", "worktrees", "loose"));
  git(dir, "worktree", "add", "-q", "-b", "feat/elsewhere", join(mkdtempSync(join(tmpdir(), "microverse-else-")), "wt"));
  writeFileSync(join(wt, "dirty.txt"), "x\n");

  const rows = agentWorktrees(dir);
  assert.deepEqual(rows.map((r) => r.rel).sort(), [".claude/worktrees/done", ".claude/worktrees/loose", ".claude/worktrees/w"]);
  const by = Object.fromEntries(rows.map((r) => [r.rel.split("/").pop(), r]));
  assert.equal(by.w.branch, "feat/x");
  assert.equal(by.w.merged, false);
  assert.equal(by.done.merged, true);
  assert.equal(by.loose.branch, null);
  assert.equal(by.loose.merged, true);
  assert.equal(norm(by.w.path), norm(wt));
  assert.equal("last" in by.w, false);
  assert.equal("dirty" in by.w, false);

  const detailed = Object.fromEntries(agentWorktrees(dir, { details: true }).map((r) => [r.rel.split("/").pop(), r]));
  assert.match(detailed.w.last, /^[0-9a-f]+ feat: a$/);
  assert.equal(detailed.w.dirty, true);
  assert.equal(detailed.done.dirty, false);
  assert.deepEqual(agentWorktrees(mkdtempSync(join(tmpdir(), "microverse-nogit-"))), []);
});

test("sanitize removes every class of control and invisible character", () => {
  const classes = {
    "C0 ESC": "\u001b",
    "C0 NUL": "\u0000",
    "C0 BEL": "\u0007",
    "C0 CR": "\r",
    "DEL": "\u007f",
    "C1 CSI": "\u009b",
    "C1 NEL": "\u0085",
    "Arabic letter mark": "\u061c",
    "Mongolian vowel separator": "\u180e",
    "zero-width space": "\u200b",
    "LRM/RLM": "\u200f",
    "line separator": "\u2028",
    "paragraph separator": "\u2029",
    "bidi embedding": "\u202e",
    "word joiner": "\u2060",
    "invisible operator": "\u2064",
    "bidi isolate": "\u2066",
    "pop isolate": "\u2069",
    "BOM": "\ufeff",
    "tag A": "\u{e0041}",
    "tag cancel": "\u{e007f}",
  };
  for (const [name, ch] of Object.entries(classes)) assert.equal(sanitize(`a${ch}b`), "ab", name);
  assert.equal(sanitize("x\u001b]52;c;QQ\u0007y"), "x]52;c;QQy");
});

test("sanitize keeps newlines, accents, other scripts and emoji; tabs become spaces", () => {
  const text = "Élève: ça marche\nlié – 日本語 ✓ 🙂 \u00ad";
  assert.equal(sanitize(text), text);
  assert.equal(sanitize("a\tb"), "a  b");
  assert.equal(sanitize(undefined), "");
});

test("sanitize caps the length in code points", () => {
  assert.equal(sanitize("abcdef", 4), "abc…");
  assert.equal(sanitize("abcd", 4), "abcd");
  assert.equal(sanitize("🙂".repeat(5), 3), "🙂🙂…");
});
