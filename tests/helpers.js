"use strict";

const { spawnSync } = require("node:child_process");
const { appendFileSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");
const bin = (name) => join(ROOT, "bin", name);

function sh(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const git = (cwd, ...args) => sh("git", args, cwd);
// Scripts run with an empty home, so that none reads the real transcripts nor
// writes the real calibration; a test that needs files passes its own home.
const emptyHome = mkdtempSync(join(tmpdir(), "microverse-nohome-"));
const script = (name, args, cwd, env) =>
  sh(process.execPath, [bin(name), ...args], cwd, { HOME: emptyHome, USERPROFILE: emptyHome, CLAUDE_PLUGIN_DATA: "", ...env });

// A repository on `main` with one commit, a feature branch checked out in a
// worktree with one commit, and the profile written as given.
function makeRepo(profile) {
  // Long path form: on Windows the temp folder can be an 8.3 short name
  // (RUNNER~1), which git expands, so command-line matching would miss it.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-")));
  git(dir, "init", "-q", "-b", "main", ".");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "core.autocrlf", "false");
  mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
  writeFileSync(join(dir, ".claude", "orchestration", "profile.json"), JSON.stringify(profile));
  writeFileSync(join(dir, "gen.txt"), "generated\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "chore: init");
  const wt = join(dir, ".claude", "worktrees", "w");
  git(dir, "worktree", "add", "-q", "-b", "feat/x", wt);
  writeFileSync(join(wt, "a.txt"), "a\n");
  git(wt, "add", "a.txt");
  git(wt, "commit", "-qm", "feat: a");
  return { dir, wt };
}

// Writes `content` to `file` and commits it in the checkout at `cwd`.
function commitFile(cwd, file, content, msg = `chore: ${file}`) {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", msg);
}

// A fake account: a home with transcripts of several projects (requests priced
// at Opus 5.5 input rates, $4 per million tokens) and a plugin data folder.
// `env` points the scripts at them.
function makeAccount() {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-account-")));
  const data = join(home, "plugin-data");
  const root = join(home, ".claude", "projects");
  let n = 0;
  const folder = (project) => {
    const dir = join(root, join(home, project).replace(/[^A-Za-z0-9]/g, "-").toLowerCase());
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const line = (ts, dollars) =>
    JSON.stringify({
      timestamp: new Date(ts).toISOString(),
      requestId: `r${++n}`,
      message: { id: `m${n}`, model: "claude-opus-5-5", usage: { input_tokens: Math.round((dollars / 4) * 1e6), output_tokens: 0 } },
    }) + "\n";
  return {
    home,
    data,
    env: { HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: data },
    // The directory of a project, which is also the working directory of a script run "in" it.
    project(name) {
      mkdirSync(join(home, name), { recursive: true });
      folder(name);
      return join(home, name);
    },
    conversation(project, ts, dollars) {
      appendFileSync(join(folder(project), "main.jsonl"), line(ts, dollars));
    },
    // A subagent transcript last written `ageMs` ago, with one request per `requests` item { ts, dollars }.
    agent(project, id, type, requests, ageMs = 0) {
      const dir = join(folder(project), "main", "subagents");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `agent-${id}.jsonl`);
      writeFileSync(file, requests.map((r) => line(r.ts, r.dollars)).join(""));
      writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: type, description: "task" }));
      const t = new Date(Date.now() - ageMs);
      utimesSync(file, t, t);
    },
  };
}

// `git merge-tree --write-tree` exists from git 2.38; the tests relying on it skip without.
const hasMergeTree = sh("git", ["merge-tree", "--write-tree", "HEAD", "HEAD"], ROOT).code === 0;

module.exports = { ROOT, bin, sh, git, script, makeRepo, makeAccount, commitFile, hasMergeTree };
