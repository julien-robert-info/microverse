"use strict";

// What CI's clean-install job runs on a machine with an empty home: orch-doctor
// on a synthetic repository, with nothing of the developer's around. Without
// MICROVERSE_E2E the `claude` binary is a stand-in; with it the installed one
// is read and must be the tested version.

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, approveProfile, git, script } = require("./helpers.js");

const tested = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).testedWith;
const e2e = process.env.MICROVERSE_E2E === "1";
const tmp = (name) => realpathSync.native(mkdtempSync(join(tmpdir(), `microverse-${name}-`)));

test("a clean machine: no fix record, node, git, profile, hooks and claude-code ok", () => {
  const home = tmp("clean-home");
  const dir = tmp("clean-repo");
  git(dir, "init", "-q", "-b", "main", ".");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
  writeFileSync(join(dir, ".claude", "orchestration", "profile.json"), JSON.stringify({ checks: [{ run: "node -e \"process.exit(0)\"" }], servers: [] }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "chore: init");
  approveProfile(home, dir);

  const env = { HOME: home, USERPROFILE: home, APPDATA: home, CLAUDE_PROJECT_DIR: "", CLAUDE_PLUGIN_DATA: "" };
  if (e2e) {
    // The real binary: found on PATH, as a user's would be.
    env.MICROVERSE_CLAUDE_BIN = undefined;
    env.MICROVERSE_NODE_VERSION = undefined;
  } else {
    const fake = join(tmp("clean-bin"), "claude-fake.js");
    writeFileSync(fake, `console.log(${JSON.stringify(`${tested.claudeCode} (Claude Code)`)});\n`);
    env.MICROVERSE_CLAUDE_BIN = fake;
    // Whatever Node runs the suite, the check is against a tested one.
    env.MICROVERSE_NODE_VERSION = `${tested.node[0]}.1.0`;
  }
  const r = script("orch-doctor", ["--json", "--project", dir, "--from-hook"], dir, env);
  const out = JSON.parse(r.out);
  const state = (name) => out.records.find((x) => x.name === name)?.state;
  assert.deepEqual(out.records.filter((x) => x.state === "fix"), [], r.out);
  for (const name of ["node", "git", "profile", "hooks", "claude-code"]) assert.equal(state(name), "ok", `${name}: ${r.out}`);
  assert.equal(r.code, 0, r.out);
});
