"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, commitFile, git, makeRepo, script } = require("./helpers.js");

const MERGE = join(ROOT, "scripts", "trace-merge.js");
const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-trace-")));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const head = (cwd, ref = "HEAD") => git(cwd, "rev-parse", ref).out.trim();
const noTrace = { CLAUDE_PLUGIN_OPTION_TRACE_DIR: undefined };

// A repository whose branch feat/x (checked out in a worktree) has two commits,
// plus a trace folder; `session` is where the hook writes.
function fixture() {
  const { dir, wt } = makeRepo({ checks: [{ name: "say", run: `node -e "console.log('out-line')"` }] });
  commitFile(wt, "b.txt", "b\n", "feat: b");
  const traces = tmp();
  return { dir, wt, traces, session: join(traces, "proj-slug", "sess-1") };
}

const mergeInput = (cwd, command) => ({
  hook_event_name: "PostToolUse",
  tool_name: command.includes(";") ? "PowerShell" : "Bash",
  tool_input: { command },
  session_id: "sess-1",
  transcript_path: join(tmpdir(), ".claude", "projects", "proj-slug", "sess-1.jsonl"),
  cwd,
});

// Runs the hook on `input`; returns its duration. Silence and exit 0 are asserted every time.
function hook(traces, input) {
  const env = { ...process.env, CLAUDE_PLUGIN_OPTION_TRACE_DIR: traces };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [MERGE], { input: JSON.stringify(input), env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
  return Date.now() - t0;
}

const records = (session) => {
  try {
    return readdirSync(session).filter((n) => n.startsWith("merge-") && n.endsWith(".json"));
  } catch {
    return [];
  }
};
const readRecord = (session) => JSON.parse(readFileSync(join(session, records(session)[0]), "utf8"));
const checksRoot = (traces, dir) => join(traces, dir.replace(/[^A-Za-z0-9]/g, "-").toLowerCase(), "checks");

test("a --no-ff merge titled merge: x (E9z) is recorded with its side commits and its check", () => {
  const { dir, wt, traces, session } = fixture();
  assert.equal(script("agent-check", ["feat/x", "--trace-dir", traces], dir, noTrace).code, 0);
  const before = head(dir);
  const side = git(wt, "rev-list", "main..feat/x").out.trim().split("\n");
  assert.equal(side.length, 2);
  const cmd = `git merge --no-ff feat/x -m "merge: x (E9z)"`;
  assert.equal(git(dir, "merge", "--no-ff", "feat/x", "-m", "merge: x (E9z)").code, 0);
  hook(traces, mergeInput(dir, cmd));
  const rec = readRecord(session);
  assert.equal(rec.kind, "merge");
  assert.equal(rec.session, "sess-1");
  assert.equal(rec.mission, "E9z");
  assert.equal(rec.branch, "feat/x");
  assert.equal(rec.mergeSha, head(dir));
  assert.deepEqual(rec.parents, [before, head(wt)]);
  assert.deepEqual([...rec.sideCommits].sort(), [...side].sort());
  assert.deepEqual(readdirSync(checksRoot(traces, dir)), [rec.check]);
  assert.deepEqual(rec.reviews, []);
  assert.match(records(session)[0], new RegExp(`^merge-\\d{8}T\\d{9}Z-${rec.mergeSha.slice(0, 12)}\\.json$`));
});

test("a merge whose branch head was not checked has check: null", () => {
  const { dir, wt, traces, session } = fixture();
  assert.equal(script("agent-check", ["feat/x", "--trace-dir", traces], dir, noTrace).code, 0);
  commitFile(wt, "c.txt", "c\n", "feat: c");
  git(dir, "merge", "--no-ff", "feat/x", "-m", "merge: x (E9z)");
  hook(traces, mergeInput(dir, "git merge --no-ff feat/x"));
  assert.equal(readRecord(session).check, null);
});

test("git -C <path> merge is read in that repository, whatever the cwd", () => {
  const { dir, traces, session } = fixture();
  git(dir, "merge", "--no-ff", "feat/x", "-m", "merge: y (E8)");
  hook(traces, mergeInput(tmp(), `git -C "${dir}" merge --no-ff feat/x -m "merge: y (E8)"`));
  assert.equal(readRecord(session).mission, "E8");
  assert.equal(readRecord(session).branch, "feat/x");
});

test("nothing is recorded for merge-base, --abort, a conflicted merge, a single parent or another subject", () => {
  const { dir, traces, session } = fixture();
  // HEAD is a real merge: only the command can say no.
  git(dir, "merge", "--no-ff", "feat/x", "-m", "merge: x (E9z)");
  for (const cmd of ["git merge-base main feat/x", "git merge --abort", "git log --oneline", "agent-check feat/x --merged", `git commit -m "git merge it"`]) {
    hook(traces, mergeInput(dir, cmd));
  }
  assert.deepEqual(records(session), []);

  // HEAD with one parent after a fast-forward.
  const ff = fixture();
  assert.equal(git(ff.dir, "merge", "feat/x").code, 0);
  hook(ff.traces, mergeInput(ff.dir, "git merge feat/x"));
  assert.deepEqual(records(ff.session), []);

  // A single-parent commit that merely carries a `merge:` subject.
  const one = fixture();
  commitFile(one.dir, "m.txt", "m\n", "merge: not a merge (E9z)");
  hook(one.traces, mergeInput(one.dir, "git merge feat/x"));
  assert.deepEqual(records(one.session), []);

  // A merge commit whose subject is not `merge:`.
  const other = fixture();
  git(other.dir, "merge", "--no-ff", "feat/x", "-m", "Merge branch feat/x (E9z)");
  hook(other.traces, mergeInput(other.dir, "git merge --no-ff feat/x"));
  assert.deepEqual(records(other.session), []);

  // A conflicted merge leaves HEAD on one parent.
  const c = fixture();
  commitFile(c.dir, "a.txt", "main side\n", "feat: main a");
  commitFile(c.wt, "a.txt", "branch side\n", "feat: branch a");
  assert.notEqual(git(c.dir, "merge", "--no-ff", "feat/x", "-m", "merge: z (E9z)").code, 0);
  hook(c.traces, mergeInput(c.dir, `git merge --no-ff feat/x -m "merge: z (E9z)"`));
  assert.deepEqual(records(c.session), []);
  assert.equal(existsSync(join(c.traces, "errors.log")), false);
});

test("the same merge seen twice gives one record", () => {
  const { dir, traces, session } = fixture();
  const cmd = `git merge --no-ff feat/x -m "merge: x (E9z)"`;
  git(dir, "merge", "--no-ff", "feat/x", "-m", "merge: x (E9z)");
  hook(traces, mergeInput(dir, cmd));
  hook(traces, mergeInput(dir, `git status; ${cmd}`));
  assert.equal(records(session).length, 1);
});

test("reviews of the mission are copied with their hashes, other missions are not", () => {
  const { dir, traces, session } = fixture();
  mkdirSync(join(dir, "notes"));
  writeFileSync(join(dir, "notes", "E9z.review.md"), "first review\n");
  writeFileSync(join(dir, "notes", "E9z.review-2.md"), "second review\n");
  writeFileSync(join(dir, "notes", "E9y.review.md"), "someone else\n");
  writeFileSync(join(dir, "notes", "E9z.md"), "the mission notes\n");
  git(dir, "merge", "--no-ff", "feat/x", "-m", "merge: x (E9z)");
  hook(traces, mergeInput(dir, "git merge --no-ff feat/x"));
  const rec = readRecord(session);
  const by = Object.fromEntries(rec.reviews.map((r) => [r.rel, r]));
  assert.deepEqual(Object.keys(by).sort(), ["notes/E9z.review-2.md", "notes/E9z.review.md"]);
  assert.equal(by["notes/E9z.review.md"].sha256, sha("first review\n"));
  assert.equal(by["notes/E9z.review-2.md"].sha256, sha("second review\n"));
  assert.equal(by["notes/E9z.review.md"].file, `reviews/${rec.mergeSha}/E9z.review.md`);
  assert.equal(readFileSync(join(session, by["notes/E9z.review-2.md"].file), "utf8"), "second review\n");
  assert.equal(existsSync(join(session, "reviews", rec.mergeSha, "E9y.review.md")), false);
});

test("an unknown mission gives no review", () => {
  const { dir, traces, session } = fixture();
  mkdirSync(join(dir, "notes"));
  writeFileSync(join(dir, "notes", "E9z.review.md"), "a review\n");
  git(dir, "merge", "--no-ff", "feat/x", "-m", "merge: no id here");
  hook(traces, mergeInput(dir, "git merge --no-ff feat/x"));
  const rec = readRecord(session);
  assert.equal(rec.mission, null);
  assert.deepEqual(rec.reviews, []);
});

test("a PowerShell line chaining merge and branch -d is recorded", () => {
  const { dir, traces, session } = fixture();
  git(dir, "branch", "b", "feat/x");
  git(dir, "merge", "--no-ff", "b", "-m", "merge: x (E9z)");
  git(dir, "branch", "-d", "b");
  const input = mergeInput(dir, `git merge --no-ff b -m "merge: x (E9z)"; git branch -d b`);
  assert.equal(input.tool_name, "PowerShell");
  hook(traces, input);
  const rec = readRecord(session);
  assert.equal(rec.branch, "b");
  assert.equal(rec.mission, "E9z");
});

// One merge of feat/x, then the hook on `command`; returns the recorded branch.
function branchOf(command) {
  const { dir, traces, session } = fixture();
  git(dir, "merge", "--no-ff", "feat/x", "-m", "merge: x (E9z)");
  hook(traces, mergeInput(dir, command));
  return readRecord(session).branch;
}

test("a redirection is never the branch (2>&1, >&2, &>f, >f, 2>f, >>f, <f, 2>/dev/null)", () => {
  const m = `git merge --no-ff feat/x -m "merge: x (E9z)"`;
  for (const r of ["2>&1", ">&2", "&>all.txt", ">out.txt", "2>err.txt", ">>out.txt", "<in.txt", "2>/dev/null"]) {
    assert.equal(branchOf(`${m} ${r}`), "feat/x", r);
  }
  assert.equal(branchOf("git merge --no-ff feat/x 2>&1 >out.txt"), "feat/x");
});

test("a word after a separate redirection is not the branch", () => {
  for (const r of ["> out.txt", "2> err.txt", ">> out.txt", "< in.txt", "&> all.txt"]) {
    assert.equal(branchOf(`git merge --no-ff feat/x ${r}`), "feat/x", r);
  }
});

test("a redirection before the branch is skipped and the branch still found", () => {
  assert.equal(branchOf("git merge --no-ff 2>&1 feat/x"), "feat/x");
  assert.equal(branchOf("git merge --no-ff > out.txt feat/x"), "feat/x");
});

test("a quoted branch holding > or & is kept whole", () => {
  assert.equal(branchOf(`git merge --no-ff "a&b" `), "a&b");
  assert.equal(branchOf(`git merge --no-ff "a>b&c"`), "a>b&c");
});

test("&& and a lone & stay separators: the last git merge wins", () => {
  assert.equal(branchOf("git merge --no-ff feat/x && git branch -d feat/x"), "feat/x");
  assert.equal(branchOf("git merge --no-ff other & git merge --no-ff feat/x 2>&1"), "feat/x");
});

test("without a redirection the branch is the last plain word", () => {
  assert.equal(branchOf("git merge --no-ff -m 'merge: x (E9z)' feat/x"), "feat/x");
});

test("without the option the hook reads nothing and writes nothing", () => {
  const { dir } = fixture();
  git(dir, "merge", "--no-ff", "feat/x", "-m", "merge: x (E9z)");
  const traces = tmp();
  for (const value of ["", "${user_config.trace_dir}"]) {
    const r = spawnSync(process.execPath, [MERGE], {
      input: JSON.stringify(mergeInput(dir, "git merge feat/x")),
      env: { ...process.env, CLAUDE_PLUGIN_OPTION_TRACE_DIR: value },
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, "");
  }
  assert.deepEqual(readdirSync(traces), []);
});

test("garbage input and a missing directory exit 0 in silence", () => {
  const traces = tmp();
  for (const input of ["", "not json", JSON.stringify(mergeInput(join(traces, "nope"), "git merge x"))]) {
    const r = spawnSync(process.execPath, [MERGE], { input, env: { ...process.env, CLAUDE_PLUGIN_OPTION_TRACE_DIR: traces }, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, "");
  }
});
