"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { commitFile, git, hasMergeTree, makeRepo, script } = require("./helpers.js");

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

test("agent-check fails when the branch conflicts with the base, naming the file", { skip: !hasMergeTree }, () => {
  const { dir, wt } = makeRepo({});
  commitFile(wt, "gen.txt", "from branch\n");
  commitFile(dir, "gen.txt", "from main\n");
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL merge: conflicts with main\r?\n\s+gen\.txt/);
});

test("agent-check reports an unrelated base commit without failing", { skip: !hasMergeTree }, () => {
  const { dir } = makeRepo({});
  commitFile(dir, "other.txt", "o\n");
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OK {2}merge/);
  assert.match(r.out, /-- {2}base: 1 commit\(s\) on main/);
});

// Fails only when both files exist, i.e. on the merge result.
const both = { name: "both", run: `node -e "const f=require('fs');process.exit(f.existsSync('a.txt')&&f.existsSync('b.txt')?1:0)"` };

test("--merged runs the checks on the merge result and undoes the merge", () => {
  const { dir, wt } = makeRepo({ checks: [both] });
  commitFile(dir, "b.txt", "b\n");
  const head = git(wt, "rev-parse", "HEAD").out;
  const alone = script("agent-check", ["feat/x"], dir);
  assert.equal(alone.code, 0, alone.out);
  const merged = script("agent-check", ["feat/x", "--merged"], dir);
  assert.equal(merged.code, 1);
  assert.match(merged.out, /FAIL both/);
  assert.equal(git(wt, "rev-parse", "HEAD").out, head);
  assert.equal(git(wt, "status", "--porcelain").out, "");
});

test("--merged is skipped when the base has not moved", () => {
  const { dir } = makeRepo({ checks: [both] });
  const r = script("agent-check", ["feat/x", "--merged"], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /merged: skipped/);
  assert.match(r.out, /OK {2}both/);
});

test("--no-checks before the branch name does not swallow it", () => {
  const { dir } = makeRepo({ checks: [{ name: "boom", run: `node -e "process.exit(3)"` }] });
  const r = script("agent-check", ["--no-checks", "feat/x"], dir);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /boom/);
});

test("an added line starting with ++ is scanned and reported with its line", () => {
  const { dir, wt } = makeRepo({ diffPatterns: [{ pattern: "marker", why: "bad" }] });
  commitFile(wt, "c.txt", "one\n++marker\n");
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /c\.txt:2 bad/);
});

const lockOf = (wt) => join(git(wt, "rev-parse", "--absolute-git-dir").out.trim(), "microverse-agent-check.lock");

test("agent-check refuses to run while another run holds the worktree", () => {
  const { dir, wt } = makeRepo({});
  writeFileSync(lockOf(wt), String(process.pid));
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes(`another agent-check is running on feat/x (pid ${process.pid})`), r.out);
  assert.ok(existsSync(lockOf(wt)), "the other run's lock is left in place");
});

test("agent-check takes over the lock of a run that is gone, and releases it", () => {
  const { dir, wt } = makeRepo({});
  const gone = require("node:child_process").spawnSync(process.execPath, ["-e", "0"]).pid;
  writeFileSync(lockOf(wt), String(gone));
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(lockOf(wt)));
});

// --json: one object on stdout and nothing else, same verdict and exit code.
const json = (r) => {
  assert.ok(r.out.endsWith("\n") && !r.out.trimEnd().includes("\n"), `one line: ${r.out}`);
  return JSON.parse(r.out);
};
const check = (o, name) => o.checks.find((c) => c.name === name);

test("--json: a green run lists the commits and every control as ok", () => {
  const { dir } = makeRepo({ checks: [dirty], teardown: ["git checkout -- gen.txt"] });
  const r = script("agent-check", ["feat/x", "--json"], dir);
  assert.equal(r.code, 0, r.out);
  const o = json(r);
  assert.equal(o.v, 1);
  assert.equal(o.branch, "feat/x");
  assert.equal(o.base, "main");
  assert.equal(o.verdict, "green");
  assert.deepEqual(o.commits.map((c) => c.subject), ["feat: a"]);
  assert.match(o.commits[0].sha, /^[0-9a-f]{7,}$/);
  assert.deepEqual(
    o.checks.filter((c) => c.name !== "merge").map((c) => [c.name, c.state]),
    [["commits", "ok"], ["worktree", "ok"], ["profile:dirty", "ok"], ["patterns", "ok"]],
  );
});

test("--json: checks that leave the worktree modified fail the worktree control", () => {
  const { dir } = makeRepo({ checks: [dirty] });
  const r = script("agent-check", ["feat/x", "--json"], dir);
  assert.equal(r.code, 1);
  const o = json(r);
  assert.equal(o.verdict, "needs-fixes");
  const bad = o.checks.filter((c) => c.name === "worktree" && c.state === "fail");
  assert.equal(bad.length, 1);
  assert.match(bad[0].detail, /the checks left changes/);
  assert.deepEqual(bad[0].lines, [" M gen.txt"]);
});

test("--json: a failing check keeps its output tail and a pattern hit is file:line", () => {
  const { dir, wt } = makeRepo({
    checks: [{ name: "boom", run: `node -e "console.log('l1');process.exit(3)"` }],
    diffPatterns: [{ pattern: "console\\.log", why: "debug trace" }],
  });
  commitFile(wt, "b.js", "console.log(1)\n");
  const o = json(script("agent-check", ["feat/x", "--json"], dir));
  assert.deepEqual([check(o, "profile:boom").state, check(o, "profile:boom").detail], ["fail", "code 3"]);
  assert.ok(check(o, "profile:boom").lines.includes("l1"));
  const p = check(o, "patterns");
  assert.equal(p.state, "fail");
  assert.equal(p.detail, "1");
  assert.deepEqual(p.lines, ["b.js:1 debug trace : console.log(1)"]);
});

test("--json: a branch without commits is a failed commits control, exit 1", () => {
  const { dir } = makeRepo({});
  git(dir, "branch", "empty");
  const r = script("agent-check", ["empty", "--json"], dir);
  assert.equal(r.code, 1);
  const o = json(r);
  assert.equal(o.verdict, "needs-fixes");
  assert.deepEqual(o.commits, []);
  assert.deepEqual(o.checks.map((c) => [c.name, c.state]), [["commits", "fail"]]);
  assert.match(o.checks[0].detail, /no commit on empty/);
});

test("--json: a conflict names the files in the merge control", { skip: !hasMergeTree }, () => {
  const { dir, wt } = makeRepo({});
  commitFile(wt, "gen.txt", "from branch\n");
  commitFile(dir, "gen.txt", "from main\n");
  const r = script("agent-check", ["feat/x", "--json"], dir);
  assert.equal(r.code, 1);
  const m = check(json(r), "merge");
  assert.equal(m.state, "fail");
  assert.deepEqual(m.lines, ["gen.txt"]);
});

test("--json: a lock held by another run is { v, branch, error } with exit 1", () => {
  const { dir, wt } = makeRepo({});
  writeFileSync(lockOf(wt), String(process.pid));
  const r = script("agent-check", ["feat/x", "--json"], dir);
  assert.equal(r.code, 1);
  const o = json(r);
  assert.deepEqual(Object.keys(o), ["v", "branch", "error"]);
  assert.ok(o.error.includes(`another agent-check is running on feat/x (pid ${process.pid})`), r.out);
  assert.ok(existsSync(lockOf(wt)), "the other run's lock is left in place");
});

test("--json --no-checks marks every profile check as skip and runs none", () => {
  const { dir } = makeRepo({ checks: [{ name: "boom", run: `node -e "process.exit(3)"` }, dirty] });
  const r = script("agent-check", ["feat/x", "--json", "--no-checks"], dir);
  assert.equal(r.code, 0, r.out);
  const o = json(r);
  assert.deepEqual(
    o.checks.filter((c) => c.name.startsWith("profile:")).map((c) => [c.name, c.state]),
    [["profile:boom", "skip"], ["profile:dirty", "skip"]],
  );
  assert.equal(o.verdict, "green");
});

test("--json with an unapproved profile is { v, branch, error } with exit 2 and no check", () => {
  const { dir } = makeRepo({ checks: [dirty] }, { approve: false });
  const r = script("agent-check", ["feat/x", "--json"], dir);
  assert.equal(r.code, 2);
  const o = json(r);
  assert.deepEqual(Object.keys(o), ["v", "branch", "error"]);
  assert.match(o.error, /profile not approved/);
});

test("the text of a green run keeps its exact lines", { skip: !hasMergeTree }, () => {
  const { dir } = makeRepo({ checks: [{ name: "ok1", run: `node -e "0"` }] });
  const r = script("agent-check", ["feat/x"], dir);
  const sha = /    (\w+) feat: a/.exec(r.out)?.[1];
  assert.ok(sha, r.out);
  assert.equal(r.out.replace(/\r\n/g, "\n"), `commits (1):\n    ${sha} feat: a\nOK  merge\nOK  worktree clean\nOK  ok1\nOK  patterns (1)\n\nfeat/x: all green\n`);
});
