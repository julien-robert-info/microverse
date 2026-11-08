"use strict";

// The blind judge: scores the diff a pass delivered against the task's brief
// with a model that knows neither the organisation nor the campaign, and
// records the score in `judge.jsonl` (R-juge). The judge has no tool, runs in a
// folder of its own and sees only what `anonymise` lets through.

const { spawn } = require("node:child_process");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } = require("node:fs");
const { homedir, userInfo } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const lib = require("../../scripts/orch-lib.js");
const { ANONYMISER, anonymise } = require("./diff.js");
const { killTree } = require("./proc.js");
const { guard, judgeable, readLines, spent } = require("./spend.js");
const { inGitRepo, readRecord, safeRelative, taskOf } = require("./suite.js");
const { passCost } = require("./transcripts.js");

const RUBRIC_DIR = join(__dirname, "rubric");
const JUDGE_MARKER = ".bench-judge";
const PROMPT = "Score the submission given on standard input.";
// A call that ran but left no figure counts for this many times its budget cap.
const BOUND_MARGIN = 1.5;
const FINAL = new Set(["ok", "invalid", "too-large", "anonymisation-failed"]);

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// --- rubric and output validation ------------------------------------------

function loadRubric(name, dir = RUBRIC_DIR) {
  if (!/^r[1-9][0-9]*$/.test(name)) throw new Error(`invalid rubric name: ${name}`);
  const mdFile = join(dir, `${name}.md`);
  const schemaFile = join(dir, `${name}.schema.json`);
  if (!existsSync(mdFile) || !existsSync(schemaFile)) throw new Error(`rubric ${name} not found in ${dir}`);
  const md = readFileSync(mdFile);
  const schemaBytes = readFileSync(schemaFile);
  const schema = JSON.parse(schemaBytes.toString("utf8"));
  // Refused before any call: found at validation, it would cost a paid answer.
  checkKeywords(schema);
  return { name, mdFile, schemaFile, schema, schemaText: JSON.stringify(schema), rubricSha: sha256(md), schemaSha: sha256(schemaBytes) };
}

const KEYWORDS = new Set(["type", "required", "properties", "additionalProperties", "items", "minimum", "maximum", "enum", "const", "maxItems", "maxLength", "title", "description"]);

// Walks the schema where validateOutput looks: the schema itself, `items` and
// each of `properties`.
function checkKeywords(schema) {
  if (!isObject(schema)) return;
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k)) throw new Error(`schema keyword not supported by the bench: ${k}`);
  checkKeywords(schema.items);
  for (const s of Object.values(isObject(schema.properties) ? schema.properties : {})) checkKeywords(s);
}

const typeOk = (v, t) =>
  ({ object: isObject(v), array: Array.isArray(v), string: typeof v === "string", integer: Number.isInteger(v), number: typeof v === "number" && Number.isFinite(v), boolean: typeof v === "boolean", null: v === null })[t] ?? false;

// A validator for the subset of JSON Schema the rubric schemas use. A keyword
// it does not know is an error of the schema, not something to skip: a check
// that silently accepts is no check.
function validateOutput(value, schema, path = "$") {
  const errors = [];
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k)) throw new Error(`schema keyword not supported by the bench: ${k}`);
  if ("const" in schema && value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not one of the allowed values`);
  if (schema.type && !typeOk(value, schema.type)) {
    errors.push(`${path}: must be ${schema.type}`);
    return errors;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (typeof value === "string" && schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validateOutput(v, schema.items, `${path}[${i}]`)));
  }
  if (isObject(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${path}: missing ${k}`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) errors.push(...validateOutput(v, props[k], `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${k}`);
    }
  }
  return errors;
}

// --- the judge's folder -----------------------------------------------------

const trimSep = (p) => p.replace(/[\\/]+$/, "");
const sameText = (a, b) => trimSep(a).replace(/\//g, "\\") === trimSep(b).replace(/\//g, "\\");
const within = (outer, inner) => inner === outer || inner.startsWith(`${trimSep(outer)}\\`);
const MEMORY_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", join(".claude", "CLAUDE.md")];

function nearestExisting(p) {
  let d = resolve(p);
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}

// Checks the folder the judge runs in and returns its real path. Absent: it is
// created with its marker. The bench never deletes anything in it.
function prepareJudgeDir(suite, { home = homedir() } = {}) {
  const dir = resolve(suite.judge.cwd);
  const bad = (why) => new Error(`judge.cwd ${dir}: ${why}`);
  const anc = nearestExisting(dir);
  if (!sameText(realpathSync.native(anc), anc)) throw bad(`differs from its real path ${realpathSync.native(anc)} (casing, short name or link)`);
  if (inGitRepo(anc, suite.cmdEnv)) throw bad("must not be inside a git repository");
  const norm = (p) => lib.normPath(trimSep(p));
  const target = norm(dir);
  if (within(norm(realpathSync.native(home)), target)) throw bad("must not be inside the home folder: its CLAUDE.md would be read");
  for (const [name, p] of [["source", suite.source], ["slot", suite.slot], ["results", suite.results]]) {
    const other = norm(existsSync(p) ? realpathSync.native(p) : resolve(p));
    if (within(other, target) || within(target, other)) throw bad(`must not be inside or contain ${name}`);
  }
  if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, JUDGE_MARKER))) throw bad(`is not empty and has no ${JUDGE_MARKER} marker`);
  mkdirSync(dir, { recursive: true });
  const real = realpathSync.native(dir);
  // The memory files Claude Code reads: in the folder and in every parent. The
  // real home is out of that walk when a test names another one (its tests'
  // folders sit under it); outside tests the home check above has refused it.
  const realHome = norm(realpathSync.native(userInfo().homedir));
  for (let d = real; ; d = dirname(d)) {
    if (!(home !== homedir() && norm(d) === realHome)) {
      for (const f of MEMORY_FILES) if (existsSync(join(d, f))) throw bad(`${join(d, f)} would be read as instructions`);
    }
    if (dirname(d) === d) break;
  }
  if (!existsSync(join(real, JUDGE_MARKER))) writeFileSync(join(real, JUDGE_MARKER), `${JSON.stringify({ purpose: "bench judge" })}\n`);
  assertOnlyMarker(real);
  return real;
}

function assertOnlyMarker(dir) {
  const extra = readdirSync(dir).filter((n) => n !== JUDGE_MARKER);
  if (extra.length) throw new Error(`the judge folder holds ${extra.length} file(s) besides its marker (left in place): ${extra.slice(0, 3).join(", ")}`);
}

// --- running the model -------------------------------------------------------

function parseEvents(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a cut line
    }
  }
  return out;
}

// One call, `shell: false`, the input on standard input. On POSIX the child
// leads its own group so that the whole tree can be killed at the limit.
function callModel({ claude, args, input, cwd, env, timeoutMs }) {
  return new Promise((resolveCall) => {
    const child = spawn(claude, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let timedOut = false;
    let failed = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      failed = e;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveCall({ code, stdout: Buffer.concat(out).toString("utf8"), timedOut, failed });
    });
    child.stdin.end(input);
  });
}

function transcriptFile(projects, cwd, session) {
  const slug = lib.projectSlug(cwd);
  let folder = slug;
  try {
    folder = readdirSync(projects).find((n) => n.toLowerCase() === slug) ?? slug;
  } catch {
    // no projects folder
  }
  return join(projects, folder, `${session}.jsonl`);
}

// An `instructions` attachment that carries a file: a CLAUDE.md or AGENTS.md
// was loaded into the judge's context.
function instructionFiles(file) {
  const found = [];
  for (const text of readFileSync(file, "utf8").split("\n")) {
    if (!text.includes('"instructions"')) continue;
    try {
      const a = JSON.parse(text)?.attachment;
      if (a?.type === "instructions" && Array.isArray(a.files) && a.files.length) found.push(a.files.length);
    } catch {
      // a cut line
    }
  }
  return found.length;
}

// Reasons a call does not run as configured. Any of them touches every
// judgment, so the command stops on the first.
function misconfiguration({ events, model, projects, cwd, session, cost }) {
  const init = events.find((e) => e?.type === "system" && e.subtype === "init");
  if (!init) return "no init event";
  if (!Array.isArray(init.tools) || init.tools.length !== 1 || init.tools[0] !== "StructuredOutput") return `tools are ${JSON.stringify(init.tools)}`;
  if (Array.isArray(init.mcp_servers) ? init.mcp_servers.length : init.mcp_servers) return "an MCP server is loaded";
  if ((init.plugins ?? []).some((p) => /microverse/i.test(JSON.stringify(p)))) return "a microverse plugin is loaded";
  if (typeof init.model !== "string" || !init.model.toLowerCase().includes(model.toLowerCase())) return "the resolved model is not the one asked for";
  const file = transcriptFile(projects, cwd, session);
  if (!existsSync(file)) return "the transcript is not where it is expected";
  if (instructionFiles(file)) return "an instructions file was loaded into the context";
  if (!cost || Object.keys(cost.byRole).some((r) => r !== "orchestrator")) return "the cost has a role other than the orchestrator";
  return null;
}

// The cost of a launched call. From its transcript; a model the price table
// does not know, or no transcript, falls back on the figure the call reported
// (points from the ratios); with no figure at all, on the most the call could
// have spent (`--max-budget-usd` with a margin), flagged `bound`. A call that
// ran is never written as free or as unknown: either would let the guard
// approve the next call on a spend it cannot see.
function costOf({ projects, cwd, session, ratios, events, maxBudgetUsd }) {
  const reported = events.filter((e) => e?.type === "result").at(-1)?.total_cost_usd;
  const bound = (base) => ({
    byRole: {}, usd: null, usdReported: null, unpriced: [], ...base,
    weekPts: maxBudgetUsd * BOUND_MARGIN * ratios.ratio7, fiveHourPts: maxBudgetUsd * BOUND_MARGIN * ratios.ratio5, bound: true, ratios: { ...ratios },
  });
  let cost = null;
  try {
    cost = passCost({ projects, slot: cwd, session, ratios, stream: events });
  } catch {
    // no transcript
  }
  if (cost === null) {
    if (!Number.isFinite(reported)) return bound({});
    return { byRole: {}, usd: reported, usdReported: reported, unpriced: [], weekPts: reported * ratios.ratio7, fiveHourPts: reported * ratios.ratio5, ratios: { ...ratios } };
  }
  if (cost.unpriced.length) {
    // The transcript's sum leaves the unpriced model out: it is a floor, not the cost.
    if (!Number.isFinite(cost.usdReported)) return bound(cost);
    return { ...cost, weekPts: cost.usdReported * ratios.ratio7, fiveHourPts: cost.usdReported * ratios.ratio5, ratios: { ...ratios } };
  }
  return cost;
}

// One call of the model and what to make of it:
// { status, output, reason, cost, model, session, seconds, startedAt }.
async function attempt(ctx, input) {
  const { suite, rubric, claude, claudeArgs, projects, cwd, ratios, settingsFile, timeoutMs } = ctx;
  const j = suite.judge;
  const session = randomUUID();
  const args = [
    ...claudeArgs, "-p", PROMPT, "--model", j.model, "--effort", j.effort,
    "--tools", "", "--disable-slash-commands", "--system-prompt-file", rubric.mdFile, "--json-schema", rubric.schemaText,
    "--setting-sources", "project,local", "--strict-mcp-config", "--permission-mode", "dontAsk", "--settings", settingsFile,
    "--output-format", "stream-json", "--verbose", "--session-id", session, "--max-budget-usd", String(j.maxBudgetUsd),
  ];
  const started = Date.now();
  const r = await callModel({ claude, args, input, cwd, env: suite.cmdEnv, timeoutMs });
  const seconds = Math.round((Date.now() - started)) / 1000;
  const events = parseEvents(r.stdout);
  const base = { session, seconds, startedAt: new Date(started).toISOString(), output: null, reason: null, model: null };
  // A process that never started cost nothing.
  const cost = r.failed ? null : costOf({ projects, cwd, session, ratios, events, maxBudgetUsd: j.maxBudgetUsd });
  const done = (status, reason = null) => ({ ...base, status, reason, cost, model: events.find((e) => e?.subtype === "init")?.model ?? null });
  // A file left in the folder is a finding whatever became of the call.
  const stray = () => {
    try {
      assertOnlyMarker(cwd);
      return null;
    } catch (e) {
      return e.message;
    }
  };
  if (r.timedOut) return stray() ? done("misconfigured", stray()) : done("error", "timeout");
  if (r.failed || !events.length) return stray() ? done("misconfigured", stray()) : { ...done("error", r.failed ? String(r.failed.message) : "no output"), launchFailed: Boolean(r.failed) };

  const bad = misconfiguration({ events, model: j.model, projects, cwd, session, cost });
  if (bad) return done("misconfigured", bad);
  if (stray()) return done("misconfigured", stray());
  const result = events.filter((e) => e?.type === "result").at(-1);
  if (!result) return done("error", "no result");
  if (result.subtype === "error_max_budget_usd") return done("budget");
  if (result.subtype !== "success" || result.is_error === true) return done("error", String(result.subtype));
  let output = result.structured_output;
  if (output === undefined || output === null) {
    try {
      output = JSON.parse(result.result);
    } catch {
      return done("invalid", "the answer is not JSON");
    }
  }
  // The call is paid: a validator failure is a judgment with its cost, not a lost one.
  let errors;
  try {
    errors = validateOutput(output, rubric.schema);
  } catch (e) {
    return done("error", `validator: ${e.message}`);
  }
  if (errors.length) return done("invalid", errors[0]);
  return { ...done("ok"), output };
}

// --- records ------------------------------------------------------------------

function seededShuffle(list, seed) {
  const a = [...list];
  let n = 0;
  const next = () => createHash("sha256").update(`${seed}:${n++}`).digest().readUInt32BE(0) / 2 ** 32;
  for (let i = a.length - 1; i > 0; i--) {
    const k = Math.floor(next() * (i + 1));
    [a[i], a[k]] = [a[k], a[i]];
  }
  return a;
}

const isFinal = (j) => FINAL.has(j.status) && (j.status !== "invalid" || j.attempt === 2);

// The input for one pass, from the brief, the checks and the diff only: not
// the pass's line, not the manifest, not the campaign.
function judgeInput({ suite, taskId, diff, anonymiserVersion, afterReplace }) {
  const task = taskOf(suite, taskId);
  const checks = readRecord(suite)[taskId]?.checks ?? {};
  const r = anonymise({ diff, brief: readFileSync(task.brief, "utf8"), checks, slot: suite.slot, afterReplace });
  return { ...r, anonymiser: anonymiserVersion };
}

// --- the command ---------------------------------------------------------------

// Judges the judgeable passes of a campaign that have no current judgment.
// Returns { judgments: [{ task, status, overall, usd }], totalUsd, stopped }.
async function judgeCampaign(opts) {
  const { suite, campaignDir } = opts;
  const claude = opts.claude ?? "claude";
  const log = opts.log ?? (() => {});
  const j = suite.judge;
  if (!j) throw new Error("the suite has no judge field");
  if (/\.(cmd|bat)$/i.test(claude)) throw new Error(`${claude}: a .cmd or .bat would need a shell, which the bench never opens`);
  const ratios = opts.ratios ?? (() => {
    const cal = lib.loadCalibration();
    return { ratio7: cal?.ratio7 ?? null, ratio5: cal?.ratio5 ?? null };
  })();
  if (![ratios.ratio7, ratios.ratio5].every((r) => Number.isFinite(r) && r > 0)) throw new Error("no calibration ratio: the guard cannot convert dollars to points");
  const rubric = loadRubric(j.rubric, opts.rubricDir);
  const anonymiserVersion = opts.anonymiser ?? ANONYMISER;
  const cwd = prepareJudgeDir(suite, { home: opts.home });
  mkdirSync(campaignDir, { recursive: true });
  const settingsFile = join(campaignDir, "judge-settings.json");
  writeFileSync(settingsFile, `${JSON.stringify({ autoMemoryEnabled: false })}\n`);
  const ctx = {
    suite, rubric, claude, claudeArgs: opts.claudeArgs ?? [], projects: opts.projects ?? lib.projectsRoot(), cwd, ratios, settingsFile,
    timeoutMs: opts.timeoutMs ?? j.timeoutMinutes * 60000,
  };

  const judgeFile = join(campaignDir, "judge.jsonl");
  const append = (o) => appendFileSync(judgeFile, `${JSON.stringify({ schema: 1, ...o })}\n`);
  const keyOf = (p) => sha256(JSON.stringify([p.task, p.diff.sha256, anonymiserVersion, rubric.name, rubric.rubricSha, rubric.schemaSha, j.model, j.effort]));

  const lines = readLines(judgeFile);
  const judged = new Set(lines.filter((l) => l.kind === "judgment" && isFinal(l)).map((l) => l.key));
  const linked = new Map(lines.filter((l) => l.kind === "link").map((l) => [l.pass, l.key]));
  const passes = readLines(join(campaignDir, "passes.jsonl")).filter(judgeable);
  const todo = passes.filter((p) => linked.get(p.session) !== keyOf(p));

  const result = { judgments: [], totalUsd: 0, stopped: null };
  if (!todo.length) return result;
  const seed = opts.seed ?? randomBytes(8).toString("hex");
  const order = seededShuffle(todo, seed);
  append({
    kind: "run", startedAt: new Date().toISOString(), seed, order: order.map((p) => p.session), anonymiser: anonymiserVersion,
    rubric: rubric.name, rubricSha: rubric.rubricSha, schemaSha: rubric.schemaSha, model: j.model, effort: j.effort,
  });

  const link = (p, key) => {
    append({ kind: "link", pass: p.session, key });
    linked.set(p.session, key);
  };
  const queue = [...order];
  while (queue.length) {
    const p = queue.shift();
    const key = keyOf(p);
    if (judged.has(key)) {
      link(p, key);
      continue;
    }
    const line = { kind: "judgment", key, task: p.task, rubric: rubric.name, rubricSha: rubric.rubricSha, schemaSha: rubric.schemaSha, anonymiser: anonymiserVersion };
    const report = (rec) => {
      const usd = rec.cost?.usd ?? 0;
      result.totalUsd += usd;
      result.judgments.push({ task: p.task, status: rec.status, overall: rec.overall, usd });
      log(`${p.task} ${rec.status} overall=${rec.overall ?? "-"} usd=${usd.toFixed(3)}`);
    };

    let diff;
    try {
      if (!safeRelative(p.diff.file)) throw new Error("unsafe path");
      diff = readFileSync(join(campaignDir, p.diff.file));
      if (sha256(diff) !== p.diff.sha256) throw new Error("changed");
    } catch (e) {
      const reason = `the kept diff is missing or changed (${e.message})`;
      result.judgments.push({ task: p.task, status: "skipped", overall: null, usd: 0, reason });
      log(`${p.task} skipped: ${reason}`);
      continue;
    }
    const input = judgeInput({ suite, taskId: p.task, diff: diff.toString("utf8"), anonymiserVersion, afterReplace: opts.afterReplace });
    const empty = { model: null, resolvedModel: null, effort: j.effort, session: null, attempt: null, startedAt: new Date().toISOString(), seconds: null, scores: null, overall: null, defects: null, redactions: input.redactions, cost: null };
    if (input.status !== "ok") {
      const rec = { ...line, ...empty, status: input.status };
      append(rec);
      judged.add(key);
      link(p, key);
      report(rec);
      continue;
    }

    let last = null;
    for (let n = 1; n <= 2; n++) {
      const g = guard({ spent: spent({ campaignDir, now: opts.now ?? Date.now() }), reserveUsd: 0, nextUsd: j.p90Usd, ratios, capWeek: opts.capWeek ?? 10, capFive: opts.capFive ?? 90 });
      if (!g.ok) {
        result.stopped = g.reason;
        return result;
      }
      const a = await attempt(ctx, input.input);
      const rec = {
        // `resolvedModel` is a trace of what the alias pointed to; it is not part of the key.
        ...line, model: a.model, resolvedModel: a.model, effort: j.effort, session: a.session, attempt: n, startedAt: a.startedAt, seconds: a.seconds, status: a.status,
        scores: null, overall: null, defects: null, redactions: input.redactions, cost: a.cost,
      };
      if (a.status === "ok") {
        const s = a.output.scores;
        rec.scores = s;
        rec.overall = Object.values(s).reduce((x, y) => x + y, 0) / Object.values(s).length;
        rec.defects = { major: a.output.defects.filter((d) => d.severity === "major").length, minor: a.output.defects.filter((d) => d.severity === "minor").length, items: a.output.defects };
      }
      append(rec);
      report(rec);
      last = { rec, reason: a.reason };
      // The program cannot be started: every other pass would fail the same way.
      if (a.launchFailed) {
        result.stopped = "launch failed";
        return result;
      }
      if (a.status !== "invalid") break;
    }
    if (last.rec.status === "misconfigured") {
      result.stopped = `misconfigured: ${last.reason}`;
      return result;
    }
    if (isFinal(last.rec)) {
      judged.add(key);
      link(p, key);
      // Every other pass with the same diff shares this judgment: one call, one cost.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (keyOf(queue[i]) === key) link(queue.splice(i, 1)[0], key);
      }
    } else {
      // The same input would fail the same way and be paid again: those passes
      // are left without a link and picked up by the next run.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (keyOf(queue[i]) === key) queue.splice(i, 1);
      }
    }
  }
  return result;
}

module.exports = { judgeCampaign, validateOutput, loadRubric, prepareJudgeDir, judgeInput, JUDGE_MARKER };
