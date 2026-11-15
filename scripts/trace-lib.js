// Shared by the trace hooks (trace-launch.js, trace-stop.js, trace-merge.js) and
// agent-check: the `trace_dir` option, the folder of a session, atomic writes,
// the error log, fingerprints, the bounded read-only git calls and the `check`
// record. Format: docs/traces.md.
//
// Self-contained on purpose (no orch-lib): these hooks run on every agent
// launch and stop and after every shell command, inside a short timeout.
"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { basename, dirname, join, resolve } = require("node:path");

// Each external call is cut at 2 s; once the whole run has used up the budget
// the remaining optional calls are skipped (their value becomes null), so the
// hook ends before its own timeout.
const CALL_MS = 2000;
const BUDGET_MS = 3500;
const startedAt = Date.now();

// Empty, absent or an unexpanded `${user_config.KEY}`: nothing is recorded.
// An explicit value (a `--trace-dir` argument) wins over the option, as
// `--mode` does over quota_mode in bin/orch-quota.
const isSet = (v) => typeof v === "string" && v.trim() !== "" && !v.includes("${");
function traceDir(explicit) {
  const raw = isSet(explicit) ? explicit : process.env.CLAUDE_PLUGIN_OPTION_TRACE_DIR;
  return isSet(raw) ? raw.trim() : null;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hex8 = () => randomBytes(4).toString("hex");

// A path segment safe on every platform: no separator, no ":", never "." or "..".
const safeSegment = (s) => {
  const v = String(s).replace(/[^\w.-]/g, "_");
  return /^\.*$/.test(v) ? "_" : v;
};

// <trace_dir>/<slug>/<session>: the slug is the folder name Claude Code gives
// the project in ~/.claude/projects (the parent of the transcript). Windows
// paths arrive with backslashes, which path.basename would not split on POSIX.
function sessionDir(dir, payload) {
  const t = typeof payload.transcript_path === "string" ? payload.transcript_path.split(/[\\/]/).filter(Boolean) : [];
  const slug = t.length >= 2 ? t[t.length - 2] : "unknown";
  const session = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : "unknown";
  return join(dir, safeSegment(slug), safeSegment(session));
}

// AAAAMMJJTHHMMSSmmmZ: sortable, and without ":" (not allowed in Windows names).
const stamp = (d) => d.toISOString().replace(/[-:.]/g, "");

// Writes through <name>.tmp of the same folder then renames: a reader never sees
// a half-written record, and two hooks never share a file.
function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

// The only shared file: one JSON line per error, never the hook input.
function logError(dir, script, e) {
  try {
    mkdirSync(dir, { recursive: true });
    const message = String((e && e.message) || e).slice(0, 300).replace(/\s+/g, " ");
    appendFileSync(join(dir, "errors.log"), JSON.stringify({ at: new Date().toISOString(), script, message }) + "\n");
  } catch {}
}

function call(cmd, args, opts = {}) {
  if (Date.now() - startedAt > BUDGET_MS) return null;
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: CALL_MS,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    ...opts,
  });
  return r.status === 0 && !r.error ? r.stdout : null;
}

// Read-only git; --no-optional-locks keeps `status` from taking the index lock
// of a worktree an agent is committing in.
const git = (cwd, ...args) =>
  call("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const gitLine = (cwd, ...args) => {
  const out = git(cwd, ...args);
  const v = out == null ? "" : out.trim();
  return v === "" ? null : v;
};
const dirty = (cwd) => {
  const out = git(cwd, "status", "--porcelain");
  return out == null ? null : out.trim() !== "";
};

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

function fileSha(file) {
  try {
    return sha256(readFileSync(file));
  } catch {
    return null;
  }
}

// Same folder name as projectSlug of orch-lib (the name Claude Code gives a
// project in ~/.claude/projects); repeated here to keep this module self-contained.
const projectSlug = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();

// Root of the main worktree from any worktree of the repository, so that checks
// and merges of one project land under one slug. Falls back to the top level
// of `cwd` when the git dir is not a `.git` folder; null outside a repository.
function mainRootOf(cwd) {
  const common = gitLine(cwd, "rev-parse", "--git-common-dir");
  if (common) {
    const abs = resolve(cwd, common);
    if (basename(abs) === ".git") return dirname(abs);
  }
  return gitLine(cwd, "rev-parse", "--show-toplevel");
}

// A check log is cut here, with a last line saying so.
const LOG_MAX = 5 * 1024 * 1024;

// <dir>/<slug>/checks/<stamp>-<head 12>/check.json and one <name>.log per
// check that ran. The logs go first and check.json last, so a check.json that
// exists always has its logs. `checks`: [{name, state, ms, text}]; `text` is the
// complete output of a check that ran, else null (no log). Returns the id.
function recordCheck(dir, { slug, at, repoTop, branch, head, merged, verdict, checks }) {
  const id = `${stamp(at)}-${head ? head.slice(0, 12) : "unknown"}`;
  const out = join(dir, safeSegment(slug), "checks", id);
  const used = new Set();
  const rows = checks.map((c) => {
    let log = null;
    if (typeof c.text === "string") {
      const base = safeSegment(c.name).slice(0, 80);
      let n = 1;
      while (used.has(n === 1 ? base : `${base}-${n}`)) n++;
      log = `${n === 1 ? base : `${base}-${n}`}.log`;
      used.add(log.slice(0, -4));
      let data = Buffer.from(c.text);
      if (data.length > LOG_MAX) data = Buffer.concat([data.subarray(0, LOG_MAX), Buffer.from("\n[truncated at 5 MB]\n")]);
      writeAtomic(join(out, log), data);
    }
    return { name: c.name, state: c.state, ms: c.ms ?? null, log };
  });
  const record = { v: 1, kind: "check", at: at.toISOString(), repoTop, branch, head, merged, verdict, checks: rows };
  writeAtomic(join(out, "check.json"), JSON.stringify(record, null, 2) + "\n");
  return id;
}

// Runs a hook body: nothing on stdout or stderr, exit code 0, whatever happens.
function runHook(script, body) {
  const dir = traceDir();
  if (!dir) return;
  try {
    body(dir);
  } catch (e) {
    logError(dir, script, e);
  }
  process.exitCode = 0;
}

function readPayload() {
  try {
    const p = JSON.parse(readFileSync(0, "utf8"));
    return p && typeof p === "object" && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

module.exports = {
  traceDir, sha256, hex8, safeSegment, sessionDir, stamp, writeAtomic, logError, call, git, gitLine, dirty, readJson, fileSha, runHook, readPayload,
  projectSlug, mainRootOf, recordCheck,
};
