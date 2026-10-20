"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { bin, commitFile, git, makeRepo, script } = require("./helpers.js");
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

test("two agent-check runs reclaiming a stale lock: one winner", async () => {
  const slow = `node -e "setTimeout(()=>{},2500)"`;
  const { dir, wt } = makeRepo({ checks: [{ name: "slow", run: slow }] });
  const gitDir = git(wt, "rev-parse", "--absolute-git-dir").out.trim();
  const dead = spawnSync(process.execPath, ["-e", ""]);
  writeFileSync(join(gitDir, "microverse-agent-check.lock"), String(dead.pid ?? 999999));
  const run = () =>
    new Promise((res) => {
      let out = "";
      const p = spawn(process.execPath, [bin("agent-check"), "feat/x"], { cwd: dir });
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => res({ code, out }));
    });
  const results = await Promise.all([run(), run()]);
  const codes = results.map((r) => r.code).sort();
  assert.deepEqual(codes, [0, 1], results.map((r) => r.out).join("\n---\n"));
  assert.match(results.find((r) => r.code === 1).out, /another agent-check/);
});
