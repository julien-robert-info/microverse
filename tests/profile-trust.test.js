"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, approveProfile, commitFile, emptyHome, git, makeRepo, script } = require("./helpers.js");

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

test("the commands are shown without escape sequences; agent-check bounds the list and says so", () => {
  const evil = `echo \u001b]0;PWNED\u0007\u001b[31mred${String.fromCharCode(0x2028)}${"y".repeat(400)}`;
  const run = Array.from({ length: 25 }, (_, i) => (i === 0 ? evil : `echo ${i}`));
  const { dir } = makeRepo({ setup: run }, { approve: false });
  const check = script("agent-check", ["feat/x"], dir);
  const trust = script("orch-trust", [], dir);
  for (const r of [check, trust]) {
    assert.doesNotMatch(r.out, /[\u001b\u0007\p{Zl}]/u);
    assert.ok(r.out.includes("PWNED"), "the text stays readable");
  }
  assert.match(check.out, /6 truncated or omitted, read them with orch-trust/);
  assert.ok(check.out.split("\n").every((l) => [...l].length < 260), "line too long");
  assert.ok(trust.out.includes("echo 24"), "orch-trust lists every command");
  assert.ok(trust.out.includes("y".repeat(400)), "and each one whole");
  assert.doesNotMatch(trust.out, /truncated/);
});

test("orch-trust shows a command padded beyond 200 characters whole", () => {
  const cmd = `npm test${" ".repeat(300)}&& echo tail-marker`;
  const { dir } = makeRepo({ checks: [{ name: "t", run: cmd }] }, { approve: false });
  const r = script("orch-trust", [], dir);
  assert.ok(r.out.includes("&& echo tail-marker"), r.out);
  assert.match(script("agent-check", ["feat/x"], dir).out, /1 truncated or omitted/);
});

test("the last line of orch-trust asks the user, not the model", () => {
  const { dir } = makeRepo({ setup: ["echo hi"] }, { approve: false });
  const lines = script("orch-trust", [], dir).out.trimEnd().split("\n");
  assert.equal(lines.at(-1), `Ask the user to type: ! orch-trust ${sha(profileOf(dir))}`);
});

test("--commands prints the approved main profile's commands, not the branch's", () => {
  const { wt } = makeRepo({ setup: ["echo main-setup"], checks: [{ name: "a", run: "echo main-check" }] });
  commitFile(wt, ".claude/orchestration/profile.json", JSON.stringify({ setup: ["echo branch-setup"], checks: [{ name: "a", run: "echo branch-check" }] }));
  const setup = script("orch-trust", ["--commands", "setup"], wt);
  assert.equal(setup.code, 0, setup.out);
  assert.equal(setup.out.trim(), "echo main-setup");
  assert.equal(script("orch-trust", ["--commands", "checks"], wt).out.trim(), "echo main-check");
});

test("--commands exits 1 for an unapproved profile and prints nothing for no profile", () => {
  const { dir } = makeRepo({ setup: ["echo hi"] }, { approve: false });
  const r = script("orch-trust", ["--commands", "setup"], dir);
  assert.equal(r.code, 1, r.out);
  assert.ok(!r.out.includes("echo hi"));
  const bare = mkdtempSync(join(tmpdir(), "microverse-bare-"));
  git(bare, "init", "-q", "-b", "main", ".");
  const none = script("orch-trust", ["--commands", "setup"], bare);
  assert.equal(none.code, 0);
  assert.equal(none.out, "");
});

test("--commands outputs what the parser kept: the last duplicate key wins", () => {
  const raw = '{"setup": ["echo first"], "checks": [{"run": "echo ok"}], "setup": ["echo last"]}';
  const { dir } = makeRepo({}, { approve: false });
  writeFileSync(profileOf(dir), raw);
  approveProfile(emptyHome, dir);
  assert.equal(script("orch-trust", ["--commands", "setup"], dir).out.trim(), "echo last");
  assert.equal(script("orch-trust", ["--commands", "checks"], dir).out.trim(), "echo ok");
});

// Each of these has a run-able string hidden behind a wrong type.
const WRONG = {
  // The valid check beside it would leave its witness if the profile were run.
  "teardown as a string": { checks: [{ name: "w", run: touch("witness-check") }], teardown: "echo restore" },
  "a check without run": { checks: [{ name: "w", command: touch("witness-check") }] },
  "setup as a string": { setup: touch("witness-setup") },
};
for (const [label, profile] of Object.entries(WRONG)) {
  test(`an invalid profile (${label}) cannot be approved and nothing of it runs`, () => {
    const { dir, wt } = makeRepo(profile, { approve: false });
    const hash = sha(profileOf(dir));
    const shown = script("orch-trust", [], dir);
    assert.match(shown.out, /profile: invalid \(/);
    const approve = script("orch-trust", [hash], dir);
    assert.equal(approve.code, 2, approve.out);
    // Even an approval written into the store by other means does not make it run.
    approveProfile(emptyHome, dir);
    assert.equal(script("orch-trust", ["--status"], dir).code, 1);
    assert.equal(script("orch-trust", ["--status"], dir).out.trim(), "invalid");
    for (const kind of ["setup", "checks"]) {
      const c = script("orch-trust", ["--commands", kind], dir);
      assert.equal(c.code, 1, c.out);
      assert.ok(!c.out.includes("witness"), c.out);
    }
    const check = script("agent-check", ["feat/x"], dir);
    assert.equal(check.code, 2, check.out);
    assert.match(check.out, /profile invalid/);
    for (const w of ["witness-check", "witness-setup"]) assert.ok(!existsSync(join(wt, w)), w);
  });
}

test("--commands refuses a command with a tag character or other hidden text", () => {
  const hidden = String.fromCodePoint(0xe0041, 0xe0042);
  const { dir } = makeRepo({ setup: [`echo hi${hidden}`] });
  const r = script("orch-trust", ["--commands", "setup"], dir);
  assert.equal(r.code, 2, r.out);
  assert.ok(!r.out.includes("echo hi"));
  const zw = makeRepo({ checks: [{ run: "echo a​b" }] });
  assert.equal(script("orch-trust", ["--commands", "checks"], zw.dir).code, 2);
});

test("--commands refuses invisible and bidi characters the approval screen strips", () => {
  const hidden = {
    "variation selector": 0xfe0f,
    "soft hyphen": 0x00ad,
    "combining grapheme joiner": 0x034f,
    "hangul filler": 0x3164,
    "bidi override": 0x202e,
    "bidi isolate": 0x2066,
    "word joiner": 0x2060,
  };
  for (const [label, cp] of Object.entries(hidden)) {
    const { dir } = makeRepo({ setup: [`echo a${String.fromCodePoint(cp)}b`] });
    const shown = script("orch-trust", [], dir);
    assert.ok(shown.out.includes("echo ab"), `${label}: shown sanitized\n${shown.out}`);
    assert.ok(!shown.out.includes(String.fromCodePoint(cp)), label);
    const c = script("orch-trust", ["--commands", "setup"], dir);
    assert.equal(c.code, 2, label);
    assert.ok(!c.out.includes("echo"), `${label}: no command printed\n${c.out}`);
  }
});

test("wrong types for servers and diffPatterns make the profile invalid", () => {
  for (const profile of [{ servers: "vite" }, { servers: [1] }, { diffPatterns: "x" }, { diffPatterns: [{ why: "no pattern" }] }, { diffPatterns: [{ pattern: 5 }] }]) {
    const { dir } = makeRepo(profile, { approve: false });
    assert.equal(script("orch-trust", ["--status"], dir).out.trim(), "invalid", JSON.stringify(profile));
    assert.equal(script("orch-trust", [sha(profileOf(dir))], dir).code, 2);
  }
});

// A linked worktree outside the main tree of a repository with a separate git
// dir: nothing points back to the main worktree.
function orphanWorktree() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-sep-")));
  const gitdir = mkdtempSync(join(tmpdir(), "microverse-sepgit-"));
  git(dir, "init", "-q", "-b", "main", "--separate-git-dir", join(gitdir, "repo.git"), ".");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
  writeFileSync(profileOf(dir), JSON.stringify({ servers: ["vite"] }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "chore: init");
  const wt = join(mkdtempSync(join(tmpdir(), "microverse-out-")), "w");
  git(dir, "worktree", "add", "-q", "-b", "feat/x", wt);
  return wt;
}

function stopHook(project, h, data) {
  return spawnSync(process.execPath, [join(ROOT, "scripts", "stop-agent-servers.js")], {
    input: JSON.stringify({ agent_id: "a1", cwd: project }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_DATA: data, ...envOf(h) },
  });
}

test("hooks refuse an invalid profile and a main worktree that is not found", () => {
  const h = home();
  const ctx = (m) => ({ message: m, data: mkdtempSync(join(tmpdir(), "microverse-data-")) });
  const invalid = makeRepo({ setup: "echo hi" }, { approve: false }).dir;
  const orphan = orphanWorktree();
  const cases = [
    [invalid, /invalid/, /fix the profile/],
    [orphan, /main worktree .* not found/, /nothing to approve/],
  ];
  for (const [dir, , expected] of cases) {
    const out = JSON.parse(hook(dir, h).stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(out, /microverse:orchestration`, unless/);
    assert.match(out, expected);
    assert.doesNotMatch(out, /approve it with/);
    const data = ctx().data;
    const stop = stopHook(dir, h, data);
    assert.equal(stop.status, 0);
    assert.match(readFileSync(join(data, "stop-agent-servers.log"), "utf8"), /profile not approved, nothing stopped/);
  }
});

test("an approved empty setup prints nothing and is approved, not 'none'", () => {
  const { dir } = makeRepo({ setup: [] });
  const c = script("orch-trust", ["--commands", "setup"], dir);
  assert.equal(c.code, 0);
  assert.equal(c.out, "");
  assert.equal(script("orch-trust", ["--status"], dir).out.trim(), "approved");
});

test("unreadable JSON is invalid: --status 1 and --commands 1, agent-check 2", () => {
  const { dir } = makeRepo({}, { approve: false });
  writeFileSync(profileOf(dir), "{ not json");
  approveProfile(emptyHome, dir);
  assert.equal(script("orch-trust", ["--status"], dir).code, 1);
  assert.equal(script("orch-trust", ["--commands", "setup"], dir).code, 1);
  assert.equal(script("agent-check", ["feat/x"], dir).code, 2);
});

test("a main worktree that cannot be found is unapproved, never 'none'", () => {
  const h = home();
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-sep-")));
  const gitdir = mkdtempSync(join(tmpdir(), "microverse-sepgit-"));
  git(dir, "init", "-q", "-b", "main", "--separate-git-dir", join(gitdir, "repo.git"), ".");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
  writeFileSync(profileOf(dir), JSON.stringify({ setup: ["echo hi"] }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "chore: init");
  // A linked worktree outside the main tree: nothing points back to the main one.
  const wt = join(mkdtempSync(join(tmpdir(), "microverse-out-")), "w");
  git(dir, "worktree", "add", "-q", "-b", "feat/x", wt);
  const s = script("orch-trust", ["--status"], wt, envOf(h));
  assert.equal(s.code, 1, s.out);
  assert.equal(s.out.trim(), "unapproved");
  assert.equal(script("agent-check", ["feat/x"], wt, envOf(h)).code, 2);
  assert.equal(script("orch-trust", ["--commands", "setup"], wt, envOf(h)).code, 1);
});

test("--commands refuses a command holding a line break", () => {
  const { dir } = makeRepo({ setup: ["echo a\necho b"] });
  const r = script("orch-trust", ["--commands", "setup"], dir);
  assert.equal(r.code, 2);
  assert.ok(!r.out.includes("echo a"));
});

test("a folder name in another case fails agent-check", () => {
  const { dir, wt } = makeRepo({});
  const h = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: wt, input: "{}", encoding: "utf8" }).stdout.trim();
  git(wt, "update-index", "--add", "--cacheinfo", `100644,${h},.Claude/orchestration/profile.json`);
  git(wt, "commit", "-qm", "chore: case");
  assert.match(script("agent-check", ["feat/x", "--no-checks"], dir).out, /profile changed: review and re-approve/);
});

test("a rename of the profile out of the folder fails agent-check", () => {
  const { dir, wt } = makeRepo({ setup: ["echo a profile long enough to be detected as the same file", "echo more"] });
  git(wt, "mv", ".claude/orchestration/profile.json", "moved.json");
  git(wt, "commit", "-qm", "chore: move");
  const r = script("agent-check", ["feat/x", "--no-checks"], dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\.claude\/orchestration\/profile\.json profile changed/);
});

test("a git dir not named .git still resolves the main worktree's profile", () => {
  const h = home();
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-sep-")));
  const gitdir = mkdtempSync(join(tmpdir(), "microverse-sepgit-"));
  git(dir, "init", "-q", "-b", "main", "--separate-git-dir", join(gitdir, "repo.git"), ".");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
  writeFileSync(profileOf(dir), JSON.stringify({ setup: ["echo main-setup"] }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "chore: init");
  const wt = join(dir, ".claude", "worktrees", "w");
  git(dir, "worktree", "add", "-q", "-b", "feat/x", wt);
  writeFileSync(profileOf(wt), JSON.stringify({ setup: ["echo branch-setup"] }));
  const r = script("orch-trust", [sha(profileOf(dir))], wt, envOf(h));
  assert.equal(r.code, 0, r.out);
  assert.equal(script("orch-trust", ["--status"], dir, envOf(h)).code, 0);
  const shown = script("orch-trust", [], wt, envOf(h));
  assert.ok(shown.out.includes("echo main-setup") && !shown.out.includes("branch-setup"), shown.out);
  assert.match(shown.out, /file: .*profile\.json/);
});

test("rewriting the profile with CRLF line ends keeps the approval", () => {
  const { dir } = makeRepo({}, { approve: false });
  writeFileSync(profileOf(dir), '{\n  "setup": ["echo hi"]\n}\n');
  approveProfile(emptyHome, dir);
  assert.equal(script("orch-trust", ["--status"], dir).code, 0);
  writeFileSync(profileOf(dir), '{\r\n  "setup": ["echo hi"]\r\n}\r\n');
  assert.equal(script("orch-trust", ["--status"], dir).code, 0);
  assert.equal(script("orch-trust", ["--commands", "setup"], dir).out.trim(), "echo hi");
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
