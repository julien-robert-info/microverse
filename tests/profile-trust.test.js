"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, commitFile, git, makeRepo, script } = require("./helpers.js");

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const profileOf = (dir) => join(dir, ".claude", "orchestration", "profile.json");
const home = () => mkdtempSync(join(tmpdir(), "microverse-trusthome-"));
const envOf = (h) => ({ HOME: h, USERPROFILE: h });
const storeOf = (h) => join(h, ".claude", "microverse", "trust.json");

// A command that leaves a witness file in the directory it runs in.
const touch = (name) => `node -e "require('fs').writeFileSync('${name}', 'x')"`;

test("an unapproved profile stops agent-check before any command runs", () => {
  const { dir, wt } = makeRepo({ checks: [{ name: "w", run: touch("witness-check") }], teardown: [touch("witness-teardown")] }, { approve: false });
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 2, r.out);
  assert.ok(r.out.includes(`orch-trust ${sha(profileOf(dir))}`), r.out);
  assert.ok(r.out.includes("witness-check"), "the commands are listed");
  assert.ok(!existsSync(join(wt, "witness-check")), "check did not run");
  assert.ok(!existsSync(join(wt, "witness-teardown")), "teardown did not run");
  assert.doesNotMatch(r.out, /all green|needs fixes/);
});

test("an approved profile runs its checks and teardown", () => {
  const { dir, wt } = makeRepo({ checks: [{ name: "w", run: touch("witness-check") }], teardown: [touch("witness-teardown")] });
  const r = script("agent-check", ["feat/x", "--no-checks"], dir);
  assert.equal(r.code, 0, r.out);
  const full = script("agent-check", ["feat/x"], dir);
  assert.ok(existsSync(join(wt, "witness-check")), full.out);
  assert.ok(existsSync(join(wt, "witness-teardown")), full.out);
});

test("a profile modified after approval is unapproved again", () => {
  const { dir, wt } = makeRepo({ checks: [{ name: "w", run: touch("witness-check") }] });
  writeFileSync(profileOf(dir), JSON.stringify({ checks: [{ name: "w", run: touch("witness-check") }], setup: [] }));
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 2, r.out);
  assert.ok(!existsSync(join(wt, "witness-check")));
});

test("the profile of the main worktree counts, not the branch's, even when run from the agent's worktree", () => {
  const { dir, wt } = makeRepo({ checks: [{ name: "from-main", run: touch("witness-main") }] });
  commitFile(wt, ".claude/orchestration/profile.json", JSON.stringify({ checks: [{ name: "from-branch", run: touch("witness-branch") }] }));
  const r = script("agent-check", ["feat/x"], wt);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /OK {2}from-main/);
  assert.doesNotMatch(r.out, /from-branch/);
  assert.ok(existsSync(join(wt, "witness-main")));
  assert.ok(!existsSync(join(wt, "witness-branch")));
  assert.match(r.out, /profile\.json profile changed: review and re-approve/);
});

test("a diff touching .claude/orchestration/ fails agent-check", () => {
  const { dir, wt } = makeRepo({});
  commitFile(wt, ".claude/orchestration/rules.md", "new rule\n");
  const r = script("agent-check", ["feat/x"], dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL patterns/);
  assert.match(r.out, /\.claude\/orchestration\/rules\.md profile changed: review and re-approve/);
});

test("the commands are shown without escape sequences, capped in number and length", () => {
  const evil = `echo \u001b]0;PWNED\u0007\u001b[31mred${String.fromCharCode(0x2028)}${"y".repeat(400)}`;
  const run = Array.from({ length: 25 }, (_, i) => (i === 0 ? evil : `echo ${i}`));
  const { dir } = makeRepo({ setup: run }, { approve: false });
  const check = script("agent-check", ["feat/x"], dir);
  const trust = script("orch-trust", [], dir);
  for (const r of [check, trust]) {
    assert.doesNotMatch(r.out, /[\u001b\u0007\u2028]/);
    assert.match(r.out, /\.\.\. and 5 more/);
    assert.ok(r.out.split("\n").every((l) => [...l].length < 260), "line too long");
    assert.ok(r.out.includes("PWNED"), "the text stays readable");
  }
});

test("orch-trust without argument shows the profile and writes nothing", () => {
  const h = home();
  const { dir } = makeRepo({ checks: [{ name: "t", run: "npm test" }], teardown: ["git checkout ."] }, { approve: false });
  const r = script("orch-trust", [], dir, envOf(h));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /profile: unapproved/);
  assert.ok(r.out.includes(`fingerprint: ${sha(profileOf(dir))}`));
  assert.match(r.out, /npm test/);
  assert.match(r.out, /git checkout \./);
  assert.ok(!existsSync(storeOf(h)));
});

test("orch-trust refuses a fingerprint that is not the profile's and writes nothing", () => {
  const h = home();
  const { dir } = makeRepo({ checks: [{ name: "t", run: "npm test" }] }, { approve: false });
  for (const bad of ["0".repeat(64), "abc", `${sha(profileOf(dir))}0`]) {
    const r = script("orch-trust", [bad], dir, envOf(h));
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /rerun without argument/);
  }
  assert.ok(!existsSync(storeOf(h)));
  assert.equal(script("orch-trust", ["--status"], dir, envOf(h)).code, 1);
});

test("orch-trust <sha256> approves, from the main worktree or an agent's, and a later edit revokes it", () => {
  const h = home();
  const { dir, wt } = makeRepo({ checks: [{ name: "t", run: "npm test" }] }, { approve: false });
  const r = script("orch-trust", [sha(profileOf(dir))], wt, envOf(h));
  assert.equal(r.code, 0, r.out);
  assert.equal(script("orch-trust", ["--status"], dir, envOf(h)).code, 0);
  assert.equal(script("orch-trust", ["--status"], wt, envOf(h)).code, 0);
  writeFileSync(profileOf(dir), JSON.stringify({ checks: [{ name: "t", run: "npm run evil" }] }));
  assert.equal(script("orch-trust", ["--status"], dir, envOf(h)).code, 1);
});

test("--status is 0 without a profile and 1 for an unapproved one", () => {
  const h = home();
  const bare = mkdtempSync(join(tmpdir(), "microverse-bare-"));
  git(bare, "init", "-q", "-b", "main", ".");
  assert.equal(script("orch-trust", ["--status"], bare, envOf(h)).code, 0);
  const { dir } = makeRepo({}, { approve: false });
  assert.equal(script("orch-trust", ["--status"], dir, envOf(h)).code, 1);
});

// The SessionStart hook.
function hook(dir, h) {
  return spawnSync(process.execPath, [join(ROOT, "scripts", "after-compact.js")], {
    input: JSON.stringify({ session_id: "s1", cwd: dir, source: "startup" }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...envOf(h) },
  });
}

test("the hook gives no skill instruction for an unapproved profile, then does once approved", () => {
  const h = home();
  const { dir } = makeRepo({ setup: ["echo hi"] }, { approve: false });
  mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
  const before = JSON.parse(hook(dir, h).stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(before, /microverse:orchestration`, unless/);
  assert.match(before, /not approved/);
  assert.match(before, /orch-trust/);
  assert.equal(before.split("\n").length, 1);
  script("orch-trust", [sha(profileOf(dir))], dir, envOf(h));
  const after = JSON.parse(hook(dir, h).stdout).hookSpecificOutput.additionalContext;
  assert.match(after, /call the Skill tool with `microverse:orchestration`/);
});
