"use strict";

const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");
const bin = (name) => join(ROOT, "bin", name);

function sh(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const git = (cwd, ...args) => sh("git", args, cwd);
const script = (name, args, cwd, env) => sh(process.execPath, [bin(name), ...args], cwd, env);

// A repository on `main` with one commit, a feature branch checked out in a
// worktree with one commit, and the profile written as given.
function makeRepo(profile) {
  const dir = mkdtempSync(join(tmpdir(), "microverse-"));
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

// `git merge-tree --write-tree` exists from git 2.38; the tests relying on it skip without.
const hasMergeTree = sh("git", ["merge-tree", "--write-tree", "HEAD", "HEAD"], ROOT).code === 0;

module.exports = { ROOT, bin, sh, git, script, makeRepo, commitFile, hasMergeTree };
