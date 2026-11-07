"use strict";

// Reading and validation of a bench suite (private JSON file, outside any
// repository), and the environment every command launched by the bench gets.

const { createHash } = require("node:crypto");
const { existsSync, readFileSync, realpathSync } = require("node:fs");
const { dirname, isAbsolute, resolve } = require("node:path");
const { normPath, run } = require("../../scripts/orch-lib.js");

// R-env: nothing else is inherited from the parent process.
const INHERITED = [
  "PATH", "PATHEXT", "SystemRoot", "ComSpec", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
  "npm_config_cache", "NPM_CONFIG_CACHE",
];

// The environment of a command: the whitelist, the quota switch of R-env, then
// the suite's own variables.
function benchEnv(extra = {}) {
  const env = {};
  for (const name of INHERITED) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.CLAUDE_PLUGIN_OPTION_QUOTA_MODE = "off";
  return { ...env, ...extra };
}

// `git -C <dir> ...` under the bench environment. `core.fsmonitor=false`: a
// repository we only read may name a fsmonitor command in its config.
function gitIn(dir, args, env, opts = {}) {
  return run("git", ["-c", "core.fsmonitor=false", "-C", dir, ...args], { env, ...opts });
}

const HEX40 = /^[0-9a-f]{40}$/;
const TASK_ID = /^[A-Za-z0-9._-]+$/;
const ORG_ID = /^O[0-3]$/;

const bad = (field, want) => new Error(`suite: field "${field}" ${want}`);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s !== "");

function str(obj, key, path) {
  if (typeof obj[key] !== "string" || obj[key] === "") throw bad(path + key, "must be a non-empty string");
  return obj[key];
}

function strings(obj, key, path, { min = 0 } = {}) {
  if (!isStrings(obj[key]) || obj[key].length < min) throw bad(path + key, `must be an array of ${min ? "at least " + min + " " : ""}non-empty strings`);
  return obj[key];
}

function positive(obj, key, path) {
  if (typeof obj[key] !== "number" || !Number.isFinite(obj[key]) || obj[key] <= 0) throw bad(path + key, "must be a positive number");
  return obj[key];
}

// A path inside a folder: relative, no `..`, no drive.
function safeRelative(p) {
  return typeof p === "string" && p !== "" && !isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes("..");
}

// Nearest existing ancestor of `p` (itself included).
function nearestExisting(p) {
  let d = resolve(p);
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}

const inGitRepo = (dir, env) => gitIn(dir, ["rev-parse", "--show-toplevel"], env).code === 0;

// Path of `p` with its existing part resolved by the file system, so that the
// comparisons of R1 see the real casing and no junction.
function realPath(p) {
  const anc = nearestExisting(p);
  const real = realpathSync.native(anc);
  return resolve(real, resolve(p).slice(anc.length).replace(/^[\\/]+/, ""));
}

const trimSep = (p) => p.replace(/[\\/]+$/, "");
const sameText = (a, b) => trimSep(a).replace(/\//g, "\\") === trimSep(b).replace(/\//g, "\\");

function checkSlot(slot, source, env) {
  const anc = nearestExisting(slot);
  // Only the existing part is compared: the rest of the path does not exist yet, so it has no casing to differ from.
  if (!sameText(realpathSync.native(anc), anc)) throw bad("slot", `differs from its real path ${realpathSync.native(anc)} (casing, short name or link)`);
  // The parent, not the slot: a slot prepared earlier is itself a repository.
  if (inGitRepo(nearestExisting(dirname(slot)), env)) throw bad("slot", "must not be inside a git repository");
  const real = normPath(realPath(slot));
  const src = normPath(realpathSync.native(source));
  if (real === src || real.startsWith(src + "\\")) throw bad("slot", "must not be the source or inside it");
  if (src.startsWith(real + "\\")) throw bad("slot", "must not contain the source");
}

// Reads, validates and resolves the suite: relative paths are taken from the
// suite's folder. Throws an Error naming the faulty field.
function loadSuite(file) {
  const text = readFileSync(file, "utf8");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`suite: unreadable (${e.message})`);
  }
  if (!isObject(raw)) throw new Error("suite: not a JSON object");
  const dir = dirname(resolve(file));
  const at = (p) => resolve(dir, p);

  const suite = { file: resolve(file), dir, sha256: createHash("sha256").update(text).digest("hex") };
  suite.id = str(raw, "id", "");
  suite.source = at(str(raw, "source", ""));
  suite.slot = at(str(raw, "slot", ""));
  suite.results = at(str(raw, "results", ""));
  suite.forbiddenPaths = strings(raw, "forbiddenPaths", "");
  suite.forbiddenSkills = strings(raw, "forbiddenSkills", "");
  if (!isObject(raw.env) || !Object.values(raw.env).every((v) => typeof v === "string")) throw bad("env", "must be an object of strings");
  suite.env = raw.env;
  suite.install = strings(raw, "install", "");
  suite.oracleCommand = str(raw, "oracleCommand", "");
  if (!suite.oracleCommand.includes("{files}")) throw bad("oracleCommand", "must contain {files}");
  suite.stateTemplate = at(str(raw, "stateTemplate", ""));

  if (!isObject(raw.prompts)) throw bad("prompts", "must be an object of strings by organisation");
  if (!isObject(raw.organisations) || Object.keys(raw.organisations).length === 0) throw bad("organisations", "must be an object of organisations");
  suite.prompts = raw.prompts;
  suite.organisations = {};
  for (const [id, o] of Object.entries(raw.organisations)) {
    const p = `organisations.${id}.`;
    if (!ORG_ID.test(id)) throw bad(`organisations.${id}`, "is not one of O0 to O3");
    if (!isObject(o)) throw bad(`organisations.${id}`, "must be an object");
    if (typeof o.plugin !== "boolean") throw bad(p + "plugin", "must be a boolean");
    if (typeof o.advisor !== "boolean") throw bad(p + "advisor", "must be a boolean");
    if (o.organisation !== null && !isObject(o.organisation)) throw bad(p + "organisation", "must be null or an object");
    for (const k of ["maxBudgetUsd", "estimateUsd", "p90Usd"]) positive(o, k, p);
    if (typeof raw.prompts[id] !== "string" || raw.prompts[id] === "") throw bad(`prompts.${id}`, "must be a non-empty string");
    suite.organisations[id] = o;
  }

  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw bad("tasks", "must be a non-empty array");
  const ids = new Set();
  suite.tasks = raw.tasks.map((t, i) => {
    const p = `tasks[${i}].`;
    if (!isObject(t)) throw bad(`tasks[${i}]`, "must be an object");
    const id = str(t, "id", p);
    if (!TASK_ID.test(id)) throw bad(p + "id", "may only hold letters, digits, dot, dash and underscore");
    if (ids.has(id)) throw bad(p + "id", `is used twice (${id})`);
    ids.add(id);
    for (const k of ["fork", "tip", "merge"]) if (!HEX40.test(str(t, k, p))) throw bad(p + k, "must be a 40-character lowercase hex commit");
    const oracle = strings(t, "oracle", p, { min: 1 });
    if (!oracle.every(safeRelative)) throw bad(p + "oracle", "must hold relative paths without ..");
    const zone = strings(t, "zone", p, { min: 1 });
    return { id, fork: t.fork, tip: t.tip, merge: t.merge, brief: at(str(t, "brief", p)), oracle, zone };
  });

  const env = benchEnv(suite.env);
  suite.cmdEnv = env;
  if (!existsSync(suite.source) || !inGitRepo(suite.source, env)) throw bad("source", "must be an existing git repository");
  checkSlot(suite.slot, suite.source, env);
  if (inGitRepo(nearestExisting(suite.results), env)) throw bad("results", "must not be inside a git repository");
  return suite;
}

const taskOf = (suite, id) => {
  const t = suite.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task: ${id}`);
  return t;
};

// Findings of a brief against the patterns the suite forbids: { pattern, line }
// only, never the matched text. A hash is matched in full and, for the first
// ten characters, only when it holds a letter a-f (a run of digits is a number).
function briefFindings(text, task) {
  const rules = [
    ["address", /\b0x[0-9a-fA-F]{40}\b/],
    ["hash64", /\b[0-9a-fA-F]{64}\b/],
    ["amount", /(?:[$€£]\s?\d|\d[\d.,]*\s?(?:[$€£]|EUR|USD|USDC|USDT|DAI|ETH|WETH|BTC|GBP)(?![A-Za-z]))/],
    ["real-data-title", /v[ée]rification sur donn[ée]es r[ée]elles|verification on real data/i],
  ];
  for (const k of ["tip", "merge"]) {
    const h = task[k];
    rules.push([`${k}-hash`, new RegExp(`${h}${/[a-f]/.test(h.slice(0, 10)) ? "|" + h.slice(0, 10) : ""}`, "i")]);
  }
  const findings = [];
  text.split(/\r?\n/).forEach((l, i) => {
    for (const [pattern, re] of rules) if (re.test(l)) findings.push({ pattern, line: i + 1 });
  });
  return findings;
}

module.exports = { INHERITED, benchEnv, gitIn, loadSuite, taskOf, briefFindings, safeRelative };
