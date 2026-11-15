"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, git } = require("./helpers.js");

const LAUNCH = join(ROOT, "scripts", "trace-launch.js");
const STOP = join(ROOT, "scripts", "trace-stop.js");
const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-trace-")));
const commit = (cwd, file, msg) => {
  writeFileSync(join(cwd, file), msg);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", msg);
  return git(cwd, "rev-parse", "HEAD").out.trim();
};

// main: c1 (launch time), c2 (lands after the launch); the agent's worktree
// starts at c2 and adds two commits. The launch base c1 and the merge-base c2
// differ, so the test shows which one the record takes.
function fixture() {
  const repo = tmp();
  const home = tmp();
  const traces = tmp();
  git(repo, "init", "-q", "-b", "main", ".");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  const c1 = commit(repo, "one.txt", "feat: one");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PROJECT_DIR: repo,
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_PLUGIN_OPTION_TRACE_DIR: traces,
  };
  const projDir = join(home, ".claude", "projects", "proj-slug");
  const transcript = join(projDir, "sess-1.jsonl");
  const launchInput = {
    tool_name: "Agent",
    tool_use_id: "toolu_77",
    session_id: "sess-1",
    transcript_path: transcript,
    cwd: repo,
    tool_input: { subagent_type: "microverse:morty", prompt: "brief" },
  };
  const launched = spawnSync(process.execPath, [LAUNCH], { input: JSON.stringify(launchInput), env, encoding: "utf8" });
  assert.equal(launched.status, 0);
  const c2 = commit(repo, "two.txt", "feat: two");
  const wt = join(repo, ".claude", "worktrees", "agent-abc123");
  git(repo, "worktree", "add", "-q", "-b", "feat/agent", wt);
  const w1 = commit(wt, "a.txt", "feat: a");
  const w2 = commit(wt, "b.txt", "feat: b");
  const subDir = join(projDir, "sess-1", "subagents");
  mkdirSync(subDir, { recursive: true });
  const metaFile = join(subDir, "agent-abc123.meta.json");
  writeFileSync(metaFile, JSON.stringify({ agentType: "microverse:morty", toolUseId: "toolu_77", finished: true }));
  const input = {
    hook_event_name: "SubagentStop",
    session_id: "sess-1",
    transcript_path: transcript,
    agent_id: "abc123",
    agent_transcript_path: join(subDir, "agent-abc123.jsonl"),
    cwd: repo,
  };
  return { repo, traces, env, input, c1, c2, w1, w2, wt, metaFile, session: join(traces, "proj-slug", "sess-1") };
}

const stop = (f, input = f.input) => spawnSync(process.execPath, [STOP], { input: JSON.stringify(input), env: f.env, encoding: "utf8" });
const stops = (f) => readdirSync(f.session).filter((n) => n.startsWith("stop-")).sort();
const read = (f, name) => JSON.parse(readFileSync(join(f.session, name), "utf8"));

test("T4 stop: toolUseId from the meta, branch and head of the worktree, base from the launch", () => {
  const f = fixture();
  const r = stop(f);
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
  assert.equal(stops(f).length, 1);
  assert.match(stops(f)[0], /^stop-\d{8}T\d{9}Z-abc123\.json$/);
  const rec = read(f, stops(f)[0]);
  assert.equal(rec.v, 1);
  assert.equal(rec.kind, "stop");
  assert.equal(rec.session, "sess-1");
  assert.equal(rec.agentId, "abc123");
  assert.equal(rec.toolUseId, "toolu_77");
  assert.equal(rec.worktree, f.wt);
  assert.equal(rec.branch, "feat/agent");
  assert.equal(rec.head, f.w2);
  // Taken from the launch (c1), not from the merge-base (c2).
  assert.equal(rec.base, f.c1);
  assert.deepEqual(rec.commits, [f.w2, f.w1, f.c2]);
  assert.equal(rec.dirty, false);
});

test("T4 without a matching launch the base is the merge-base with main", () => {
  const f = fixture();
  writeFileSync(f.metaFile, JSON.stringify({ toolUseId: "toolu_other" }));
  const rec = (stop(f), read(f, stops(f)[0]));
  assert.equal(rec.toolUseId, "toolu_other");
  assert.equal(rec.base, f.c2);
  assert.deepEqual(rec.commits, [f.w2, f.w1]);
});

test("T4 the meta is found without agent_transcript_path, and absent gives null", () => {
  const f = fixture();
  const { agent_transcript_path, ...input } = f.input;
  stop(f, input);
  assert.equal(read(f, stops(f)[0]).toolUseId, "toolu_77");

  const g = fixture();
  writeFileSync(g.metaFile.replace(".meta.json", ".other"), "");
  const noMeta = { ...g.input, agent_transcript_path: join(g.session, "nowhere", "agent-abc123.jsonl") };
  stop(g, noMeta);
  const rec = read(g, stops(g)[0]);
  assert.equal(rec.toolUseId, null);
  assert.equal(rec.base, g.c2);
});

test("T4 an agent without a worktree: worktree, branch, commits are null", () => {
  const f = fixture();
  stop(f, { ...f.input, agent_id: "noworktree", agent_transcript_path: undefined });
  const rec = read(f, stops(f)[0]);
  assert.equal(rec.agentId, "noworktree");
  for (const k of ["worktree", "branch", "base", "head", "commits", "dirty", "toolUseId"]) assert.equal(rec[k], null, k);
});

test("a second stop of the same agent adds a record; uncommitted work is flagged", () => {
  const f = fixture();
  stop(f);
  writeFileSync(join(f.wt, "a.txt"), "edited");
  stop(f);
  const files = stops(f);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((n) => read(f, n).dirty).sort(), [false, true]);
});

test("empty option: nothing written; malformed input: exit 0 and silent", () => {
  const f = fixture();
  const quiet = spawnSync(process.execPath, [STOP], { input: JSON.stringify(f.input), env: { ...f.env, CLAUDE_PLUGIN_OPTION_TRACE_DIR: "" }, encoding: "utf8" });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout + quiet.stderr, "");
  assert.deepEqual(stops(f), []);
  const bad = spawnSync(process.execPath, [STOP], { input: "{{", env: f.env, encoding: "utf8" });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout + bad.stderr, "");
});
