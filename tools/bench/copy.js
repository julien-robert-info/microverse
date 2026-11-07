"use strict";

// The throwaway copy of the source repository a pass works in (`prepare`), and
// the pieces `validate` and `grade` share with it: unpacking a commit, running
// the suite's install commands, laying the hidden oracle files over a tree.

const { spawnSync } = require("node:child_process");
const { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { listProcesses, normPath, run } = require("../../scripts/orch-lib.js");
const { gitIn, taskOf } = require("./suite.js");

const MARKER = ".bench-slot";
const LONG = 30 * 60 * 1000;

const rmTree = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const tail = (r) => `${r.out}${r.err}`.trim().split(/\r?\n/).slice(-15).join("\n");

// A fresh folder in the system temp, in its long path form.
const tempDir = (prefix) => mkdtempSync(join(realpathSync.native(tmpdir()), prefix));

// Runs `fn(dir)` in a fresh folder that is removed afterwards, whatever happens.
function withTempDir(prefix, fn) {
  const dir = tempDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmTree(dir);
  }
}

// Unpacks the tree of `rev` of the source into the existing folder `dest`.
// `git archive` honours `export-ignore` of .gitattributes: files marked so in
// the source are absent from the copy. The tar file sits in `dest` and is named
// relatively, with `dest` as working directory: GNU tar reads `C:` in an archive
// name as a host and unescapes backslashes of a `-C` path (`\b` becomes a
// backspace), so no absolute path goes to it.
function extractArchive(suite, rev, dest, repo = suite.source) {
  const name = ".bench-tree.tar";
  const tar = join(dest, name);
  try {
    const a = gitIn(repo, ["archive", "--format=tar", "-o", tar, rev], suite.cmdEnv);
    if (a.code !== 0) throw new Error(`git archive ${rev} failed: ${tail(a)}`);
    const x = run("tar", ["-xf", name], { cwd: dest, env: suite.cmdEnv });
    if (x.code !== 0) throw new Error(`tar failed: ${tail(x)}`);
  } finally {
    rmSync(tar, { force: true });
  }
}

// A command line of the suite, run by the shell in `cwd` under the bench environment.
function shell(suite, command, cwd) {
  return run(command, [], { cwd, env: suite.cmdEnv, shell: true, timeout: LONG });
}

function install(suite, dir) {
  for (const command of suite.install) {
    const r = shell(suite, command, dir);
    if (r.code !== 0) throw new Error(`install command failed (${command}):\n${tail(r)}`);
  }
}

// Lays the oracle files of `task`, as they are at its tip, over `dir`.
function overlayOracle(suite, task, dir) {
  for (const file of task.oracle) {
    const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", suite.source, "show", `${task.tip}:${file}`], { env: suite.cmdEnv, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`oracle file ${file} is not at the tip of ${task.id}`);
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, r.stdout);
  }
}

// R3: a slot is deleted only when it carries the marker, and not while a
// process still runs from it (a leftover would hold files and keep writing).
function clearSlot(suite) {
  const slot = suite.slot;
  if (!existsSync(slot)) return;
  if (lstatSync(slot).isSymbolicLink() || !lstatSync(slot).isDirectory()) throw new Error(`slot ${slot} is not a plain folder: not deleted`);
  if (!existsSync(join(slot, MARKER))) throw new Error(`slot ${slot} has no ${MARKER} marker: not deleted`);
  const key = normPath(slot);
  const left = listProcesses().filter((p) => p.pid !== process.pid && normPath(p.line ?? "").includes(key));
  if (left.length) throw new Error(`slot ${slot} is in use by ${left.length} process(es) (pid ${left.map((p) => p.pid).join(", ")}): not deleted`);
  rmTree(slot);
}

// Files and links that must not exist in a copy: a `.env` other than
// `.env.example`, and any link or junction outside node_modules.
function forbiddenEntries(root) {
  const found = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = join(dir, e.name);
      if (lstatSync(full).isSymbolicLink()) found.push(`link: ${r}`);
      else if (e.isDirectory()) walk(full, r);
      else if ((e.name === ".env" || e.name.startsWith(".env.")) && e.name !== ".env.example") found.push(`env file: ${r}`);
    }
  };
  walk(root, "");
  return found;
}

// R-copie. A single commit "bench base" of the tree at the task's fork, no
// remote: a clone would let `git log --all` reach the solution.
function prepare(suite, taskId, { org = null } = {}) {
  const task = taskOf(suite, taskId);
  if (org !== null && !suite.organisations[org]) throw new Error(`unknown organisation: ${org}`);
  if (!existsSync(task.brief)) throw new Error(`brief not found for ${task.id}`);
  if (!existsSync(suite.stateTemplate)) throw new Error("state template not found (stateTemplate)");
  const slot = suite.slot;
  const git = (args) => {
    const r = gitIn(slot, args, suite.cmdEnv);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${tail(r)}`);
    return r.out.trim();
  };

  clearSlot(suite);
  mkdirSync(slot, { recursive: true });
  // First thing in the folder, so that a copy that fails half-way can still be deleted.
  writeFileSync(join(slot, MARKER), `${task.id}\n`);
  extractArchive(suite, task.fork, slot);

  git(["init", "-q", "-b", "main"]);
  appendFileSync(join(slot, ".git", "info", "exclude"), `${MARKER}\n`);
  const author = ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"];
  git([...author, "add", "-A"]);
  git([...author, "commit", "-q", "-m", "bench base"]);
  const base = git(["rev-parse", "HEAD"]);

  install(suite, slot);

  // Pass files, after the commit and unversioned: the agent's `git add -A` must not pick them up.
  mkdirSync(join(slot, "notes"), { recursive: true });
  copyFileSync(task.brief, join(slot, "notes", `${task.id}.md`));
  copyFileSync(suite.stateTemplate, join(slot, "CLAUDE.local.md"));
  const excluded = ["notes/", "CLAUDE.local.md"];
  const orgDef = org && suite.organisations[org];
  if (orgDef && orgDef.organisation) {
    const dir = join(slot, ".claude", "orchestration");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "organisation.json"), `${JSON.stringify(orgDef.organisation, null, 2)}\n`);
    excluded.push(".claude/orchestration/organisation.json");
  }
  appendFileSync(join(slot, ".git", "info", "exclude"), `${excluded.join("\n")}\n`);

  const problems = [];
  if (git(["rev-list", "--all", "--count"]) !== "1") problems.push("the copy has more than one commit");
  if (git(["remote"]) !== "") problems.push("the copy has a remote");
  problems.push(...forbiddenEntries(slot));
  if (problems.length) throw new Error(`copy of ${task.id} refused: ${problems.join("; ")}`);
  return { task: task.id, org, slot, base };
}

module.exports = { MARKER, prepare, extractArchive, install, shell, overlayOracle, withTempDir, tempDir, rmTree, tail, forbiddenEntries };
