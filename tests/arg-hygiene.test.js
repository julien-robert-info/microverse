"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { commitFile, git, makeRepo, script } = require("./helpers.js");
const { git: libGit, validBranch } = require("../scripts/orch-lib.js");

test("validBranch accepts ordinary names and refuses shell, cmd and control characters", () => {
  for (const ok of ["main", "feat/x", "fix/arg-hygiene", "release-1.2", "agent_a1"]) assert.equal(validBranch(ok), true, ok);
  for (const bad of ["a&b", "a|b", "-x", "a^b", "a%b", "a<b", "a>b", "a!b", 'a"b', "a\u001b[31mb", "a\u0007b", "a b", "a..b", "", "@{-1}"]) {
    assert.equal(validBranch(bad), false, JSON.stringify(bad));
  }
  assert.equal(validBranch(undefined), false);
});

for (const name of ["agent-check", "agent-cleanup"]) {
  test(`${name} refuses an invalid branch name and touches nothing`, () => {
    const { dir, wt } = makeRepo({});
    git(dir, "branch", "a&b");
    for (const bad of ["a&b", "-x", "a\u001b[31mb"]) {
      const r = script(name, [bad], dir);
      assert.equal(r.code, 2, `${JSON.stringify(bad)}: ${r.out}`);
      assert.match(r.out, /invalid branch name/);
    }
    assert.ok(existsSync(wt));
    assert.notEqual(git(dir, "branch", "--list", "feat/x").out.trim(), "");
    assert.notEqual(git(dir, "branch", "--list", "a&b").out.trim(), "");
  });
}

test("agent-check prints a commit subject with terminal escapes sanitized", () => {
  const { dir, wt } = makeRepo({});
  commitFile(wt, "b.txt", "b\n", "feat: b \u001b]0;pwned\u0007\u001b[31mred");
  const r = script("agent-check", ["feat/x", "--no-checks"], dir);
  assert.ok(!/[\u001b\u0007]/.test(r.out), JSON.stringify(r.out));
  assert.match(r.out, /feat: b/);
});

test("git() does not run a core.fsmonitor command planted in .git/config", () => {
  const { dir } = makeRepo({});
  const witness = join(mkdtempSync(join(tmpdir(), "microverse-witness-")), "ran").replace(/\\/g, "/");
  const hook = join(mkdtempSync(join(tmpdir(), "microverse-hook-")), "hook.js");
  writeFileSync(hook, `require("node:fs").writeFileSync(${JSON.stringify(witness)}, "x");\n`);
  git(dir, "config", "core.fsmonitor", `node ${JSON.stringify(hook.replace(/\\/g, "/"))}`);
  // Control: plain git does run it, so the test can fail.
  git(dir, "status");
  assert.ok(existsSync(witness), "the planted command should run under plain git");
  require("node:fs").rmSync(witness);
  libGit(["status", "--porcelain"], dir);
  assert.ok(!existsSync(witness), "libGit ran the fsmonitor command");
});
