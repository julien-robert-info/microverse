"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT } = require("./helpers.js");
const { spawnSync } = require("node:child_process");

const HOOK = join(ROOT, "scripts", "stop-agent-servers.js");
const idle = "setTimeout(() => {}, 60000)";

function setup(profile) {
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-hook-")));
  mkdirSync(join(project, ".claude", "orchestration"), { recursive: true });
  if (profile) writeFileSync(join(project, ".claude", "orchestration", "profile.json"), JSON.stringify(profile));
  return { project, data: join(project, "data") };
}

const runHook = ({ project, data }, payload) =>
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_DATA: data },
  });

const log = ({ data }) => readFileSync(join(data, "stop-agent-servers.log"), "utf8");
const alive = (child) => child.exitCode === null && child.signalCode === null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the hook stops a matching server of the agent and spares its other processes", async () => {
  const ctx = setup({ servers: ["fakeserver"] });
  const worktree = join(ctx.project, ".claude", "worktrees", "agent-abc123");
  const server = spawn(process.execPath, ["-e", idle, join(worktree, "fakeserver")], { stdio: "ignore" });
  const tests = spawn(process.execPath, ["-e", idle, join(worktree, "othertask")], { stdio: "ignore" });
  const elsewhere = spawn(process.execPath, ["-e", idle, join(ctx.project, "agent-other", "fakeserver")], { stdio: "ignore" });
  try {
    await wait(500);
    const r = runHook(ctx, { agent_id: "abc123", cwd: ctx.project });
    assert.equal(r.status, 0);
    await wait(500);
    assert.ok(!alive(server), "the server should be stopped");
    assert.ok(alive(tests), "the agent's other process should survive");
    assert.ok(alive(elsewhere), "another agent's server should survive");
    assert.match(log(ctx), /agent abc123: stopped PID/);
  } finally {
    for (const p of [server, tests, elsewhere]) p.kill();
  }
});

test("the hook logs and exits 0 when there is nothing to do", () => {
  const noProfile = setup(null);
  assert.equal(runHook(noProfile, { agent_id: "x" }).status, 0);
  assert.match(log(noProfile), /no profile/);

  const noServers = setup({ checks: [] });
  runHook(noServers, { agent_id: "x" });
  assert.match(log(noServers), /no servers pattern/);

  const empty = setup({ servers: ["fakeserver"] });
  runHook(empty, { agent_id: "x" });
  assert.match(log(empty), /nothing to stop/);
  assert.ok(existsSync(join(empty.data, "stop-agent-servers.log")));
});
