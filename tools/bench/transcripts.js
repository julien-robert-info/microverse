"use strict";

// Bench: what a pass cost, whether it saw the solution, how it ended.
// Pure readers of the pass transcripts (<projects>/<slug>/<session>.jsonl and
// <session>/subagents/agent-*.jsonl) and of the stream-json output: they write
// nothing and never launch `claude`.

const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const lib = require("../../scripts/orch-lib.js");

const MAIN_ROLE = "orchestrator";
const ADVISOR_ROLE = "advisor";

// The transcripts of one session: main file plus the subagents' files, sorted.
function sessionFiles(projects, slot, session) {
  // Claude Code keeps the path's case in the folder name; the slug is lowercase.
  const slug = lib.projectSlug(slot);
  let folder;
  try {
    folder = readdirSync(projects).find((n) => n.toLowerCase() === slug);
  } catch {
    // no projects folder
  }
  const dir = join(projects, folder ?? slug);
  const main = join(dir, `${session}.jsonl`);
  if (!existsSync(main)) throw new Error(`transcript of session ${session} not found in the slot's project folder`);
  const subDir = join(dir, session, "subagents");
  let agents = [];
  try {
    agents = readdirSync(subDir)
      .filter((f) => /^agent-.+\.jsonl$/.test(f))
      .sort()
      .map((f) => join(subDir, f));
  } catch {
    // no subagents
  }
  return { dir, main, agents };
}

// Events of a stream-json output (text of JSON lines, or an array of events).
function streamEvents(stream) {
  if (Array.isArray(stream)) return stream;
  const out = [];
  for (const line of String(stream ?? "").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a cut or foreign line
    }
  }
  return out;
}

const lastResult = (events) => events.filter((e) => e?.type === "result").at(-1) ?? null;

const sum = (v) => v.reduce((a, x) => a + x, 0);

// Tokens and cost by role and model. The five counters are those of orch-lib:
// [input, 5 min write, 1 h write, cache read, output]. `usd` is the sum of
// requestCost parts, unrounded; a model without a price keeps its tokens, has
// `usd: null`, is listed in `unpriced` and is left out of the totals. Points
// are usd x ratio, with the ratios passed in and copied to the output: without
// them there are no points.
function passCost({ projects, slot, session, ratios = null, stream = null }) {
  // A ratio may be null (calibration without enough data): its points are null.
  // One that is present must be a positive number.
  const ratio = (k) => {
    const r = ratios?.[k] ?? null;
    if (r !== null && (!Number.isFinite(r) || r <= 0)) throw new Error(`ratios.${k} must be a positive number or null`);
    return r;
  };
  const ratio7 = ratio("ratio7");
  const ratio5 = ratio("ratio5");
  const { main, agents } = sessionFiles(projects, slot, session);
  const requests = new Map();
  lib.readRequests(main, "conversation", null, requests);
  for (const file of agents) {
    // Ids repeat across files only by accident: key the map by file as well.
    const part = new Map();
    lib.readRequests(file, "agent", null, part, lib.agentInfo(file).type);
    for (const [id, r] of part) requests.set(`${file}\0${id}`, r);
  }

  const byRole = {};
  const unpriced = new Set();
  let usd = 0;
  const add = (role, model, tokens, cost) => {
    const entry = (byRole[role] ??= { requests: 0, models: {} });
    const m = (entry.models[model] ??= { tokens: [0, 0, 0, 0, 0], usd: 0 });
    m.tokens = m.tokens.map((x, i) => x + tokens[i]);
    if (cost) {
      m.usd = m.usd === null ? null : m.usd + sum(cost);
      if (m.usd !== null) usd += sum(cost);
    } else {
      m.usd = null;
      unpriced.add(model);
    }
  };
  for (const r of requests.values()) {
    const role = r.kind === "conversation" ? MAIN_ROLE : r.agent;
    byRole[role] ??= { requests: 0, models: {} };
    byRole[role].requests++;
    add(role, r.model, r.v, lib.executorCost(r));
    for (const it of lib.advisorSteps(r)) {
      byRole[ADVISOR_ROLE] ??= { requests: 0, models: {} };
      byRole[ADVISOR_ROLE].requests++;
      add(ADVISOR_ROLE, it.model, it.v, lib.priceOf(it.model, it.v));
    }
  }
  // A model unpriced in one request makes its usd null for the whole model:
  // a partial figure under a model name would read as complete.
  const reported = lastResult(streamEvents(stream))?.total_cost_usd;
  return {
    byRole,
    usd,
    usdReported: Number.isFinite(reported) ? reported : null,
    unpriced: [...unpriced].sort(),
    weekPts: ratio7 === null ? null : usd * ratio7,
    fiveHourPts: ratio5 === null ? null : usd * ratio5,
    ratios: ratios ? { ratio7, ratio5 } : null,
  };
}

// --- leaks -----------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// Lowercase, one separator, no repeated or trailing one.
const unify = (s) => s.toLowerCase().replace(/[\\/]+/g, "/");

// Regexes for a path under the forms it takes in a tool call: D:/x, D:\x (after
// unify), /d/x (git bash) and /mnt/d/x (WSL). The next character may not
// extend the last name (c:/src/app must not match c:/src/app-bench).
function pathPatterns(path) {
  const n = unify(path).replace(/\/$/, "");
  if (!n) throw new Error("empty path in the leak scan");
  const forms = [n];
  const drive = /^([a-z]):(\/.*)$/.exec(n);
  if (drive) forms.push(`/${drive[1]}${drive[2]}`, `/mnt/${drive[1]}${drive[2]}`);
  return forms.map((f) => new RegExp(`(?<![a-z0-9_.-])${escapeRe(f)}(?![a-z0-9_-])`));
}

// A hash is searched whole (full, and its first 10 characters) and ignored when
// it holds no letter a-f: a run of digits is a number, not a hash.
function hashPatterns(id, hash) {
  if (typeof hash !== "string" || !/^[0-9a-f]{10,64}$/i.test(hash)) throw new Error(`${id}: not a commit hash`);
  const out = [];
  for (const [name, h] of [[id, hash.toLowerCase()], [`${id}10`, hash.slice(0, 10).toLowerCase()]]) {
    if (/[a-f]/.test(h)) out.push({ needle: name, re: [new RegExp(`(?<![a-z0-9_])${h}(?![a-z0-9_])`)] });
  }
  return out;
}

// Strings of the tool calls and tool results of a transcript line.
function toolStrings(o) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  const content = o?.message?.content;
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (b?.type === "tool_use") walk(b.input);
    else if (b?.type === "tool_result") walk(b.content);
  }
  return out;
}

// Findings { needle, file, line } for the transcripts of a pass; never the text
// found. `needle` names the pattern: "source", "forbidden:<n>", "project" (a
// project folder other than the slot's under .claude/projects), "tip",
// "tip10", "merge", "merge10". `file` is relative to the slot's project folder.
function scanLeaks({ projects, slot, session, source, forbiddenPaths = [], hashes = {} }) {
  const { dir, main, agents } = sessionFiles(projects, slot, session);
  const patterns = [{ needle: "source", re: pathPatterns(source) }];
  forbiddenPaths.forEach((p, i) => patterns.push({ needle: `forbidden:${i}`, re: pathPatterns(p) }));
  for (const id of ["tip", "merge"]) if (hashes[id] != null) patterns.push(...hashPatterns(id, hashes[id]));
  const ownSlug = lib.projectSlug(slot);

  const findings = [];
  for (const file of [main, ...agents]) {
    const rel = file.slice(dir.length + 1).replace(/\\/g, "/");
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (!text.includes('"tool_')) return;
        let o;
        try {
          o = JSON.parse(text);
        } catch {
          return;
        }
        const strings = toolStrings(o);
        if (!strings.length) return;
        const hit = new Set();
        for (const s of strings) {
          // A result can itself be JSON text: a path after "\n" would read
          // "/n<path>". The text is also scanned with those escapes as spaces.
          for (const variant of [s, s.replace(/\\(?:[nrtbf]|u[0-9a-fA-F]{4})/g, " ")]) {
            const u = unify(variant);
            const raw = variant.toLowerCase();
            for (const p of patterns) {
              // Hashes are matched on the raw text, paths on the unified one.
              if (p.re.some((re) => re.test(p.needle.startsWith("tip") || p.needle.startsWith("merge") ? raw : u))) hit.add(p.needle);
            }
            for (const m of u.matchAll(/\.claude\/projects\/([a-z0-9-]+)/g)) if (m[1] !== ownSlug) hit.add("project");
            // A wildcard reads the transcripts of every project; a bare listing does not.
            if (/\.claude\/projects\/[*?[{]/.test(u)) hit.add("project");
          }
        }
        for (const needle of hit) findings.push({ needle, file: rel, line: i + 1 });
      });
  }
  return findings;
}

// --- outcome ---------------------------------------------------------------

// The refusal text a PreToolUse hook gives when quota-guard asks and nobody
// can answer: it starts with "Quota:" and ends with its confirmation line.
const QUOTA_REFUSAL = /Quota: [^]*?Confirm to launch anyway/;

const LAUNCH_TOOLS = new Set(["Agent", "Task"]);

// The guard only refuses an agent launch. A result that merely quotes its text
// (a Read or grep of the guard's source) is not a refusal: it must answer an
// Agent/Task call with is_error, or the last result must list a denied
// Agent/Task call.
function quotaRefused(events) {
  const launches = new Set();
  for (const e of events) {
    const content = e?.message?.content;
    if (e?.type === "assistant" && Array.isArray(content)) {
      for (const b of content) if (b?.type === "tool_use" && LAUNCH_TOOLS.has(b.name)) launches.add(b.id);
    }
  }
  const denied = (lastResult(events)?.permission_denials ?? []).some((d) => LAUNCH_TOOLS.has(d?.tool_name));
  for (const e of events) {
    const content = e?.message?.content;
    if (e?.type !== "user" || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      if (!QUOTA_REFUSAL.test(text)) continue;
      if ((b.is_error === true && launches.has(b.tool_use_id)) || denied) return true;
    }
  }
  return false;
}

// Outcome of a pass from its stream-json output and whether `main` advanced:
// done, no-merge, asked, budget, aborted-quota or error. The runner decides
// timeout, misconfigured and contaminated itself. A quota refusal ends the pass
// as aborted-quota unless main advanced anyway; a budget stop wins over done
// because the pass did not finish by itself.
function passOutcome({ stream, mainAdvanced }) {
  if (typeof mainAdvanced !== "boolean") throw new Error("mainAdvanced must be a boolean");
  const events = streamEvents(stream);
  const result = lastResult(events);
  if (!result) return "error";
  if (result.subtype === "error_max_budget_usd") return "budget";
  if (quotaRefused(events) && !mainAdvanced) return "aborted-quota";
  if (result.subtype !== "success" || result.is_error === true) return "error";
  if (mainAdvanced) return "done";
  const asked = (result.permission_denials ?? []).some((d) => d?.tool_name === "AskUserQuestion");
  const endsWithQuestion = /\?[\s*_"')\]]*$/.test(String(result.result ?? ""));
  return asked || endsWithQuestion ? "asked" : "no-merge";
}

// --- activity --------------------------------------------------------------

// SendMessage calls, agents by type and the permission denials of the last
// result (null without a result: unknown is not zero).
function passActivity({ projects, slot, session, stream = null }) {
  const { main, agents } = sessionFiles(projects, slot, session);
  const types = {};
  for (const file of agents) {
    const t = lib.agentInfo(file).type;
    types[t] = (types[t] ?? 0) + 1;
  }
  // Streamed replies repeat a tool call: count each tool_use id once.
  const sent = new Set();
  for (const file of [main, ...agents]) {
    for (const text of readFileSync(file, "utf8").split("\n")) {
      if (!text.includes('"SendMessage"')) continue;
      let o;
      try {
        o = JSON.parse(text);
      } catch {
        continue;
      }
      const content = o?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) if (b?.type === "tool_use" && b.name === "SendMessage") sent.add(b.id ?? `${file}:${sent.size}`);
    }
  }
  const denials = lastResult(streamEvents(stream))?.permission_denials;
  return { agents: types, sendMessages: sent.size, permissionDenials: Array.isArray(denials) ? denials.length : null };
}

module.exports = { passCost, scanLeaks, passOutcome, passActivity };
