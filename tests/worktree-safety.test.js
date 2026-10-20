"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { commitFile, git, makeRepo, script } = require("./helpers.js");
const { git: libGit } = require("../scripts/orch-lib.js");

// A worktree of the user's at `rel` (relative to the repo), locked, with an
// ignored file git would not warn about.
function userWorktree(dir, rel, branch) {
  const wt = join(dir, rel);
  mkdirSync(join(wt, ".."), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  git(dir, "add", ".gitignore");
  git(dir, "commit", "-qm", "chore: ignore env");
  const add = git(dir, "worktree", "add", "-q", "-b", branch, wt);
  assert.equal(add.code, 0, add.out);
  writeFileSync(join(wt, ".env"), "SECRET=synthetic\n");
  git(dir, "worktree", "lock", wt);
  return wt;
}

function assertIntact(dir, wt, branch) {
  assert.ok(existsSync(join(wt, ".env")));
  assert.match(git(dir, "worktree", "list", "--porcelain").out, /^locked/m);
  assert.notEqual(git(dir, "branch", "--list", branch).out.trim(), "");
}

test("agent-cleanup refuses a locked user worktree outside .claude/worktrees (merged branch)", () => {
  const { dir } = makeRepo({});
  const wt = userWorktree(dir, `../user-copy-${process.pid}-a`, "mine");
  const r = script("agent-cleanup", ["mine"], dir);
  assert.notEqual(r.code, 0, r.out + git(dir, "worktree", "list", "--porcelain").out);
  assert.match(r.out, /outside/);
  assertIntact(dir, wt, "mine");
});

test("agent-cleanup --keep-branch refuses a user worktree outside .claude/worktrees (unmerged branch)", () => {
  const { dir } = makeRepo({});
  const wt = userWorktree(dir, `../user-copy-${process.pid}-b`, "mine");
  commitFile(wt, "b.txt", "b\n");
  const r = script("agent-cleanup", ["--keep-branch", "mine"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /outside/);
  assertIntact(dir, wt, "mine");
});

test("agent-cleanup refuses a sibling folder named like .claude/worktrees-evil", () => {
  const { dir } = makeRepo({});
  const wt = userWorktree(dir, ".claude/worktrees-evil/w", "mine");
  const r = script("agent-cleanup", ["mine"], dir);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /outside/);
  assertIntact(dir, wt, "mine");
});

test("agent-cleanup still removes a locked agent worktree: branch deleted when merged, kept with --keep-branch", () => {
  let { dir, wt } = makeRepo({});
  git(dir, "worktree", "lock", wt);
  git(dir, "merge", "-q", "--no-ff", "feat/x", "-m", "merge: x");
  let r = script("agent-cleanup", ["--keep-branch", "feat/x"], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(wt));
  assert.equal(git(dir, "branch", "--list", "feat/x").out.trim(), "feat/x");

  ({ dir, wt } = makeRepo({}));
  git(dir, "worktree", "lock", wt);
  git(dir, "merge", "-q", "--no-ff", "feat/x", "-m", "merge: x");
  r = script("agent-cleanup", ["feat/x"], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(wt));
  assert.equal(git(dir, "branch", "--list", "feat/x").out.trim(), "");
});

test("the git runner sets GIT_OPTIONAL_LOCKS=0", () => {
  const { dir } = makeRepo({});
  // An alias runs in a shell that echoes the environment git was given.
  git(dir, "config", "alias.showlocks", '!echo "locks=$GIT_OPTIONAL_LOCKS"');
  assert.match(libGit(["showlocks"], dir).out, /locks=0/);
});

function lockedRepo(content, guard) {
  const { dir, wt } = makeRepo({});
  const lock = join(git(wt, "rev-parse", "--absolute-git-dir").out.trim(), "microverse-agent-check.lock");
  writeFileSync(lock, content);
  if (guard !== undefined) writeFileSync(`${lock}.reclaim`, guard);
  return { dir, lock };
}

test("agent-check treats an empty lock file as a live run", () => {
  const { dir, lock } = lockedRepo("");
  const r = script("agent-check", ["feat/x", "--no-checks"], dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /another agent-check/);
  assert.ok(existsSync(lock));
});

test("agent-check refuses to reclaim a stale lock while a reclaim guard exists", () => {
  const dead = spawnSync(process.execPath, ["-e", ""]);
  const { dir, lock } = lockedRepo(String(dead.pid), "1");
  const r = script("agent-check", ["feat/x", "--no-checks"], dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /reclaiming/);
  assert.ok(existsSync(lock));
});

test("agent-check reclaims a stale lock and removes its guard", () => {
  const dead = spawnSync(process.execPath, ["-e", ""]);
  const { dir, lock } = lockedRepo(String(dead.pid));
  const r = script("agent-check", ["feat/x", "--no-checks"], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(`${lock}.reclaim`));
});
