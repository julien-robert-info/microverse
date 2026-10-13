"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { lastContext, normPath, paceAdvice, parseArgs } = require("../scripts/orch-lib.js");

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

test("paceAdvice: on the line, two agents while the 5h counter is under 60 %, else one", () => {
  assert.match(pace({}), /^normal: up to 2 agents/);
  assert.match(pace({ used5: 60 }), /^normal: one agent at a time/);
});

test("paceAdvice: behind the line, three agents under 60 % on the 5h counter, else two", () => {
  assert.match(pace({ delta: -11 }), /^speed up: up to 3 agents/);
  assert.match(pace({ delta: -11, used5: 75 }), /^speed up: up to 2 agents/);
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
