"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { bin, git, makeRepo, script, sh } = require("./helpers.js");

test("agent-cleanup refuses a branch that is not merged", () => {
  const { dir, wt } = makeRepo({});
  const r = script("agent-cleanup", ["feat/x"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not merged/);
  assert.ok(existsSync(wt));
});

test("agent-cleanup removes the worktree and the branch once merged", () => {
  const { dir, wt } = makeRepo({});
  git(dir, "merge", "-q", "--no-ff", "feat/x", "-m", "merge: x");
  const r = script("agent-cleanup", ["feat/x"], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(wt));
  assert.equal(git(dir, "branch", "--list", "feat/x").out.trim(), "");
});

test("agent-cleanup is not blocked by a parent process that carries the worktree path", () => {
  const { dir, wt } = makeRepo({});
  git(dir, "merge", "-q", "--no-ff", "feat/x", "-m", "merge: x");
  // The intermediate process has the worktree path in its command line, as a
  // shell does after `cd <worktree> && ...`.
  const relay = "const r = require('child_process').spawnSync(process.argv[1], [process.argv[2], 'feat/x'], { stdio: 'inherit' }); process.exit(r.status)";
  const r = sh(process.execPath, ["-e", relay, process.execPath, bin("agent-cleanup"), wt], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(wt));
});

test("agent-cleanup is blocked by an unrelated process running in the worktree", () => {
  const { dir, wt } = makeRepo({});
  git(dir, "merge", "-q", "--no-ff", "feat/x", "-m", "merge: x");
  const { spawn } = require("node:child_process");
  const busy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", wt], { stdio: "ignore" });
  try {
    const r = script("agent-cleanup", ["feat/x"], dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED: processes still running/);
    assert.ok(existsSync(wt));
  } finally {
    busy.kill();
  }
});

test("agent-cleanup --keep-branch removes the worktree and keeps the unmerged branch", () => {
  const { dir, wt } = makeRepo({});
  const r = script("agent-cleanup", ["--keep-branch", "feat/x"], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(wt));
  assert.equal(git(dir, "branch", "--list", "feat/x").out.trim(), "feat/x");
});

test("agent-cleanup --keep-branch refuses uncommitted changes, untracked files included", () => {
  const { dir, wt } = makeRepo({});
  writeFileSync(join(wt, "a.txt"), "changed\n");
  let r = script("agent-cleanup", ["--keep-branch", "feat/x"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /uncommitted/);
  assert.ok(existsSync(wt));
  git(wt, "checkout", "--", "a.txt");
  writeFileSync(join(wt, "new.txt"), "n\n");
  r = script("agent-cleanup", ["--keep-branch", "feat/x"], dir);
  assert.notEqual(r.code, 0);
  assert.ok(existsSync(wt));
});
