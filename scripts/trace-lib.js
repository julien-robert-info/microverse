// Shared by the trace hooks (trace-launch.js, trace-stop.js): the `trace_dir`
// option, the folder of a session, atomic writes, the error log, fingerprints
// and the bounded read-only git calls. Format: docs/traces.md.
//
// Self-contained on purpose (no orch-lib): these hooks run on every agent
// launch and stop, inside a 5 s timeout.
"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { dirname, join } = require("node:path");

// Each external call is cut at 2 s; once the whole run has used up the budget
// the remaining optional calls are skipped (their value becomes null), so the
// hook ends before its own timeout.
const CALL_MS = 2000;
const BUDGET_MS = 3500;
const startedAt = Date.now();

// Empty, absent or an unexpanded `${user_config.KEY}`: nothing is recorded.
function traceDir() {
  const raw = process.env.CLAUDE_PLUGIN_OPTION_TRACE_DIR;
  return typeof raw === "string" && raw.trim() !== "" && !raw.includes("${") ? raw.trim() : null;
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
};
