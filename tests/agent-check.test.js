"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { git, makeRepo, script } = require("./helpers.js");

// Appends to a tracked file, like a build rewriting generated code.
const dirty = { name: "dirty", run: `node -e "require('fs').appendFileSync('gen.txt', 'x')"` };

test("agent-check is green when the checks pass and teardown restores the files", () => {
  const { dir } = makeRepo({ checks: [dirty], teardown: ["git checkout -- gen.txt"] });
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /feat\/x: all green/);
});

test("agent-check fails when the checks leave the worktree modified", () => {
  const { dir } = makeRepo({ checks: [dirty] });
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /the checks left changes/);
});

test("agent-check reports a failing check and a bad diff pattern", () => {
  const { dir, wt } = makeRepo({
    checks: [{ name: "boom", run: `node -e "process.exit(3)"` }],
    diffPatterns: [{ pattern: "console\\.log", why: "debug trace" }],
  });
  writeFileSync(join(wt, "b.js"), "console.log(1)\n");
  git(wt, "add", "b.js");
  git(wt, "commit", "-qm", "feat: b");
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL boom \(code 3\)/);
  assert.match(r.out, /b\.js:1 debug trace/);
});

test("agent-check fails on a branch without commits", () => {
  const { dir } = makeRepo({});
  git(dir, "branch", "empty");
  const r = script("agent-check", ["empty"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /no commit on empty/);
});

test("a check with paths is skipped when the diff does not touch them", () => {
  const { dir } = makeRepo({ checks: [{ name: "build", run: `node -e "process.exit(1)"`, paths: ["src/"] }] });
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /build: skipped/);
});
