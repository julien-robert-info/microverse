"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normPath, parseArgs } = require("../scripts/orch-lib.js");

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
