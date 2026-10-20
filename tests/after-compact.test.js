"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, realpathSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, git, commitFile, emptyHome, approveProfile } = require("./helpers.js");

const HOOK = join(ROOT, "scripts", "after-compact.js");
const HEADER =
  "Conversation compacted: CLAUDE.local.md is reloaded and is the state of reference; agents still running keep reporting here; continue with the orchestration skill.";

const LOAD_SKILL =
  "This project is orchestrated with microverse: before replying, call the Skill tool with `microverse:orchestration`, unless its text is already in this conversation.";

const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-compact-")));

function withProfile(dir, { approve = true } = {}) {
  mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
  writeFileSync(join(dir, ".claude", "orchestration", "profile.json"), "{}");
  if (approve) approveProfile(emptyHome, dir);
}

const run = (dir, input) =>
  spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify({ session_id: "s1", cwd: dir, source: "compact", ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: emptyHome, USERPROFILE: emptyHome },
  });

const message = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

test("without a profile, with another source, or on bad input the hook is silent", () => {
  const bare = tmp();
  for (const source of ["startup", "resume", "clear", "compact"]) {
    const r = run(bare, { source });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
  const dir = tmp();
  withProfile(dir);
  for (const r of [run(dir, { source: "toString" }), run(dir, { source: "other" }), run(dir, "not json"), run(dir, "")]) {
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
  assert.equal(message(r), [LOAD_SKILL, HEADER].join("\n"));
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
      LOAD_SKILL,
      HEADER,
      "Agent worktrees:",
      "- (detached) (.claude/worktrees/agent-detached): not merged",
      "- feat/done (.claude/worktrees/agent-done): merged",
      "- feat/open (.claude/worktrees/agent-open): not merged",
    ].join("\n"),
  );
});

function repoWith(dir) {
  git(dir, "init", "-q", "-b", "main", ".");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "core.autocrlf", "false");
  withProfile(dir);
  commitFile(dir, "base.txt", "base\n");
}

test("on startup and resume, worktrees are listed with last commit and uncommitted changes", () => {
  const dir = tmp();
  repoWith(dir);

  const done = join(dir, ".claude", "worktrees", "agent-done");
  git(dir, "worktree", "add", "-q", "-b", "feat/done", done);
  commitFile(done, "done.txt", "done\n", "feat: finish the import");
  git(dir, "merge", "-q", "--no-ff", "-m", "merge: done", "feat/done");

  const open = join(dir, ".claude", "worktrees", "agent-open");
  git(dir, "worktree", "add", "-q", "-b", "feat/open", open);
  commitFile(open, "open.txt", "open\n", "wip: first step of the export");
  writeFileSync(join(open, "open.txt"), "edited\n");

  const clean = join(dir, ".claude", "worktrees", "agent-clean");
  git(dir, "worktree", "add", "-q", "-b", "feat/clean", clean);
  commitFile(clean, "clean.txt", "clean\n", "feat: clean step");

  const rows = (m) => m.split("\n").filter((l) => l.startsWith("- "));
  const expected = [
    "- feat/clean (.claude/worktrees/agent-clean): not merged, last commit <sha> feat: clean step, no uncommitted changes",
    "- feat/done (.claude/worktrees/agent-done): merged, last commit <sha> feat: finish the import, no uncommitted changes",
    "- feat/open (.claude/worktrees/agent-open): not merged, last commit <sha> wip: first step of the export, UNCOMMITTED CHANGES",
  ];
  for (const source of ["startup", "clear"]) {
    const m = message(run(dir, { source }));
    const lines = m.split("\n");
    assert.equal(lines[0], LOAD_SKILL);
    assert.match(lines[1], /^New conversation: /);
    assert.deepEqual(rows(m).map((l) => l.replace(/ [0-9a-f]{7,} /, " <sha> ")), expected);
  }
  const resumed = message(run(dir, { source: "resume" }));
  assert.equal(resumed.split("\n")[0], LOAD_SKILL);
  assert.match(resumed.split("\n")[1], /^Conversation resumed: /);
  assert.equal(rows(resumed).length, 3);
});

test("compact keeps its orientation line and rows without commit details", () => {
  const dir = tmp();
  repoWith(dir);
  const open = join(dir, ".claude", "worktrees", "agent-open");
  git(dir, "worktree", "add", "-q", "-b", "feat/open", open);
  commitFile(open, "open.txt", "open\n");
  writeFileSync(join(open, "open.txt"), "edited\n");
  assert.equal(
    message(run(dir, {})),
    [LOAD_SKILL, HEADER, "Agent worktrees:", "- feat/open (.claude/worktrees/agent-open): not merged"].join("\n"),
  );
});

test("every source with a profile gives the skill instruction first, alone when there is no agent worktree", () => {
  const dir = tmp();
  repoWith(dir);
  for (const source of ["startup", "resume", "clear"]) {
    const r = run(dir, { source });
    assert.equal(r.status, 0);
    assert.equal(message(r), LOAD_SKILL);
  }
  assert.equal(message(run(dir, { source: "compact" })), [LOAD_SKILL, HEADER].join("\n"));
  // Not a profile-less repository: no profile, no output, even in a git repo.
  const bare = tmp();
  git(bare, "init", "-q", "-b", "main", ".");
  for (const source of ["startup", "clear"]) assert.equal(run(bare, { source }).stdout, "");
});

test("clear, resume and compact give the instruction before the orientation and the rows", () => {
  const dir = tmp();
  repoWith(dir);
  const open = join(dir, ".claude", "worktrees", "agent-open");
  git(dir, "worktree", "add", "-q", "-b", "feat/open", open);
  commitFile(open, "open.txt", "open\n");
  const cleared = message(run(dir, { source: "clear" })).split("\n");
  assert.deepEqual(cleared.slice(0, 2).map((l) => l.slice(0, 16)), [LOAD_SKILL.slice(0, 16), "New conversation"]);
  assert.ok(cleared.some((l) => l.startsWith("- feat/open")));
  const compacted = message(run(dir, { source: "compact" })).split("\n");
  assert.deepEqual(compacted.slice(0, 2), [LOAD_SKILL, HEADER]);
  const resumed = message(run(dir, { source: "resume" })).split("\n");
  assert.equal(resumed[0], LOAD_SKILL);
});

test("when listing worktrees fails, startup still gives the instruction and the transcript", () => {
  const dir = tmp();
  withProfile(dir); // not a git repository: nothing to list
  const transcript_path = join(tmp(), "s.jsonl");
  assert.equal(
    message(run(dir, { source: "startup", transcript_path })),
    [LOAD_SKILL, `Transcript of this conversation: ${transcript_path}`].join("\n"),
  );
});

test("the transcript path is given on every source, alone when nothing else is to say", () => {
  const dir = tmp();
  repoWith(dir);
  const transcript_path = join(tmp(), "session-1.jsonl");
  const line = `Transcript of this conversation: ${transcript_path}`;
  // No agent worktree: startup, clear and resume give the instruction and the transcript line.
  for (const source of ["startup", "clear", "resume"]) assert.equal(message(run(dir, { source, transcript_path })), [LOAD_SKILL, line].join("\n"));
  assert.equal(message(run(dir, { transcript_path })), [LOAD_SKILL, HEADER, line].join("\n"));

  const open = join(dir, ".claude", "worktrees", "agent-open");
  git(dir, "worktree", "add", "-q", "-b", "feat/open", open);
  commitFile(open, "open.txt", "open\n");
  for (const source of ["startup", "clear", "resume", "compact"]) {
    const lines = message(run(dir, { source, transcript_path })).split("\n");
    assert.equal(lines.at(-1), line);
    assert.ok(lines.some((l) => l.startsWith("- feat/open")));
  }
});

test("without a transcript_path in the payload no transcript line is given", () => {
  const dir = tmp();
  repoWith(dir);
  const open = join(dir, ".claude", "worktrees", "agent-open");
  git(dir, "worktree", "add", "-q", "-b", "feat/open", open);
  commitFile(open, "open.txt", "open\n");
  for (const source of ["startup", "resume", "compact"]) {
    assert.ok(!message(run(dir, { source })).includes("Transcript"));
  }
  assert.ok(!message(run(dir, { source: "compact", transcript_path: "" })).includes("Transcript"));
});

test("a hostile commit subject and branch name reach the context cleaned and bounded", () => {
  const dir = tmp();
  repoWith(dir);
  const open = join(dir, ".claude", "worktrees", "agent-open");
  // Git refuses ASCII controls in a ref name but accepts C1, U+2028 and tag characters.
  git(dir, "worktree", "add", "-q", "-b", "feat/a\u009bb\u2028c\u{e0041}d", open);
  const subject = `fix: x\r\u001b]0;PWNED\u0007\u001b[31m\u2028\u{e0049}${"y".repeat(300)}`;
  commitFile(open, "open.txt", "open\n", subject);
  for (const source of ["startup", "resume"]) {
    const m = message(run(dir, { source }));
    assert.doesNotMatch(m, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u{e0000}-\u{e007f}]/u, source);
    const row = m.split("\n").find((l) => l.startsWith("- (invalid name)"));
    assert.ok(row.startsWith("- (invalid name) (.claude/worktrees/agent-open): not merged, last commit "), row);
    assert.match(row, /fix: x\]0;PWNED\[31m/);
    assert.ok(row.length < 100 + 100 + 120, `row too long: ${row.length}`);
    assert.ok(row.includes("…"));
  }
});
