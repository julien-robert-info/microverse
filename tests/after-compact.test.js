"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, realpathSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, git, commitFile } = require("./helpers.js");

const HOOK = join(ROOT, "scripts", "after-compact.js");
const HEADER =
  "Conversation compacted: CLAUDE.local.md is reloaded and is the state of reference; agents still running keep reporting here; continue with the orchestration skill.";

const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-compact-")));

function withProfile(dir) {
  mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
  writeFileSync(join(dir, ".claude", "orchestration", "profile.json"), "{}");
}

const run = (dir, input) =>
  spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify({ session_id: "s1", cwd: dir, source: "compact", ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });

const message = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

test("without a profile, with another source, or on bad input the hook is silent", () => {
  const bare = tmp();
  for (const r of [run(bare, {})]) {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
  const dir = tmp();
  withProfile(dir);
  for (const r of [run(dir, { source: "startup" }), run(dir, "not json"), run(dir, "")]) {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
});

test("outside a git repository only the orientation line is given", () => {
  const dir = tmp();
  withProfile(dir);
  const r = run(dir, {});
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(message(r), HEADER);
});

test("agent worktrees are listed with their merge status, others are left out", () => {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main", ".");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "core.autocrlf", "false");
  withProfile(dir);
  commitFile(dir, "base.txt", "base\n");

  const done = join(dir, ".claude", "worktrees", "agent-done");
  git(dir, "worktree", "add", "-q", "-b", "feat/done", done);
  commitFile(done, "done.txt", "done\n");
  git(dir, "merge", "-q", "--no-ff", "-m", "merge: done", "feat/done");

  const open = join(dir, ".claude", "worktrees", "agent-open");
  git(dir, "worktree", "add", "-q", "-b", "feat/open", open);
  commitFile(open, "open.txt", "open\n");

  const detached = join(dir, ".claude", "worktrees", "agent-detached");
  git(dir, "worktree", "add", "-q", "--detach", detached);
  commitFile(detached, "detached.txt", "detached\n");

  const outside = join(tmp(), "elsewhere");
  git(dir, "worktree", "add", "-q", "-b", "feat/outside", outside);

  // Drive letter in lower case: git prints it the other way on Windows.
  const r = run(dir.replace(/^[A-Z]:/, (d) => d.toLowerCase()), {});
  assert.equal(r.status, 0);
  const out = message(r);
  assert.equal(
    out,
    [
      HEADER,
      "Agent worktrees:",
      "- (detached) (.claude/worktrees/agent-detached): not merged",
      "- feat/done (.claude/worktrees/agent-done): merged",
      "- feat/open (.claude/worktrees/agent-open): not merged",
    ].join("\n"),
  );
});
