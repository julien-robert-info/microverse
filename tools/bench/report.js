"use strict";

// Report of a bench campaign: per task and organisation, cost and quality of
// the recorded passes, optionally against an earlier campaign. Reads
// `passes.jsonl`, `manifest.json` and `judge.jsonl`; writes nothing.
// The report holds task ids and numbers only: no judge defect summary, no
// diff text, no brief text.

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

// Passes that tell nothing about an organisation: counted apart.
const EXCLUDED = new Set(["contaminated", "misconfigured"]);

function readJsonl(file) {
  const rows = [];
  readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`${file}:${i + 1}: not valid JSON`);
    }
  });
  return rows;
}

function readManifest(dir) {
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) return null;
  const m = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  const cap = m.capWeek ?? m.caps?.week ?? m.cap?.week ?? null;
  return {
    id: m.id ?? m.campaign ?? null,
    date: m.date ?? m.startedAt ?? null,
    claudeCode: m.claudeCode ?? m.claudeVersion ?? null,
    models: m.models ?? null,
    plugin: m.plugin ?? m.pluginCommit ?? null,
    capWeek: Number.isFinite(cap) ? cap : null,
  };
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);

// Median of the finite values; the mean of the two middle ones when the count
// is even. Rates are never mixed with absent values: those are dropped here.
function stats(values) {
  const v = values.filter(finite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { median, min: v[0], max: v[v.length - 1], n: v.length };
}

const sum = (values) => values.filter(finite).reduce((a, b) => a + b, 0);

function oracleOk(p) {
  const o = p.quality?.oracle;
  return !!o && o.fail === 0 && o.pass >= 1;
}

// null when the pass recorded no control at all.
function checksOk(p) {
  const vals = Object.values(p.quality?.checks ?? {}).filter((v) => v !== null && v !== undefined);
  return vals.length ? vals.every((v) => v === true) : null;
}

function sizeRatio(p) {
  const q = p.quality;
  if (!q) return null;
  const ref = (q.refAdded ?? 0) + (q.refDeleted ?? 0);
  return ref > 0 && finite(q.added) && finite(q.deleted) ? (q.added + q.deleted) / ref : null;
}

const agentCount = (p) => {
  const a = p.quality?.agents;
  return a ? sum(Object.values(a)) : null;
};

// A pass with an unpriced model has a partial `usd`: it is not a zero and not
// a cost, so it stays out of the statistics and is counted.
const pricedUsd = (p) => (p.cost && !(p.cost.unpriced?.length) && finite(p.cost.usd) ? p.cost.usd : null);

// ---- judge ---------------------------------------------------------------

function sameConfig(run, j) {
  return (
    j.rubric === run.rubric &&
    j.rubricSha === run.rubricSha &&
    j.schemaSha === run.schemaSha &&
    j.anonymiser === run.anonymiser &&
    j.effort === run.effort &&
    typeof j.model === "string" &&
    j.model.toLowerCase().includes(String(run.model).toLowerCase())
  );
}

const redactionTotal = (r) =>
  r ? sum(Object.values(r).flatMap((group) => (group && typeof group === "object" ? Object.values(group) : []))) : 0;

// Reads judge.jsonl: configuration of the last `run` line, final judgment per
// key (the last `ok` of the key, else its last line) and pass -> keys links.
function readJudge(dir) {
  const file = join(dir, "judge.jsonl");
  if (!existsSync(file)) return null;
  const rows = readJsonl(file);
  const run = [...rows].reverse().find((r) => r.kind === "run") ?? null;
  const judgments = rows.filter((r) => r.kind === "judgment");
  const config = run && {
    rubric: run.rubric, rubricSha: run.rubricSha, schemaSha: run.schemaSha,
    anonymiser: run.anonymiser, model: run.model, effort: run.effort,
  };
  const finals = new Map();
  for (const j of run ? judgments.filter((x) => sameConfig(run, x)) : []) {
    const prev = finals.get(j.key);
    if (!prev || j.status === "ok" || prev.status !== "ok") finals.set(j.key, j);
  }
  const links = new Map();
  for (const l of rows.filter((r) => r.kind === "link")) {
    if (!links.has(l.pass)) links.set(l.pass, []);
    links.get(l.pass).push(l.key);
  }
  // Every judgment line costs, whatever its configuration; a link costs nothing.
  const cost = {
    usd: sum(judgments.map((j) => j.cost?.usd)),
    weekPts: sum(judgments.map((j) => j.cost?.weekPts)),
    calls: judgments.filter((j) => j.cost).length,
  };
  return { config, finals, links, cost };
}

// Final judgment of a pass under the current configuration, or null.
function judgmentOf(judge, pass) {
  let found = null;
  for (const key of judge.links.get(pass.session) ?? []) {
    const j = judge.finals.get(key);
    if (j && (!found || j.status === "ok")) found = j;
  }
  return found;
}

const jugeable = (p) => !!p.diff && (p.diff.files ?? 1) >= 1;

function judgeCell(judge, passes) {
  if (!judge) return null;
  const targets = passes.filter(jugeable);
  const done = [];
  const nonOk = {};
  for (const p of targets) {
    const j = judgmentOf(judge, p);
    if (!j) continue;
    if (j.status === "ok") done.push(j);
    else nonOk[j.status] = (nonOk[j.status] ?? 0) + 1;
  }
  const criteria = {};
  for (const name of new Set(done.flatMap((j) => Object.keys(j.scores ?? {})))) {
    criteria[name] = stats(done.map((j) => j.scores?.[name]));
  }
  return {
    judged: done.length,
    jugeable: targets.length,
    overall: stats(done.map((j) => j.overall)),
    major: sum(done.map((j) => j.defects?.major)),
    nonOk,
    redactions: sum(done.map((j) => redactionTotal(j.redactions))),
    criteria,
  };
}

// ---- report --------------------------------------------------------------

function cellOf(task, org, passes, judge) {
  const checks = passes.map(checksOk).filter((v) => v !== null);
  const outcomes = {};
  for (const p of passes) outcomes[p.outcome] = (outcomes[p.outcome] ?? 0) + 1;
  const priced = passes.map(pricedUsd);
  return {
    task, org,
    passes: passes.length,
    outcomes,
    oracle: { ok: passes.filter(oracleOk).length, of: passes.length },
    checks: { ok: checks.filter(Boolean).length, of: checks.length },
    outsideZone: stats(passes.map((p) => p.quality?.outsideZone)),
    sizeRatio: stats(passes.map(sizeRatio)),
    usd: stats(priced),
    unpricedPasses: priced.filter((v) => v === null).length,
    weekPts: stats(passes.map((p) => p.cost?.weekPts)),
    minutes: stats(passes.map((p) => p.minutes)),
    agents: stats(passes.map(agentCount)),
    dominated: false,
    judge: judgeCell(judge, passes),
  };
}

// Dominated: another organisation of the same task costs less (median usd)
// for an oracle share at least as high. No global ranking.
function markDominated(cells) {
  for (const a of cells) {
    if (!a.usd || !a.oracle.of) continue;
    const rate = (c) => c.oracle.ok / c.oracle.of;
    a.dominated = cells.some(
      (b) => b !== a && b.task === a.task && b.usd && b.usd.median < a.usd.median && rate(b) >= rate(a),
    );
  }
}

function load(dir) {
  const file = join(dir, "passes.jsonl");
  if (!existsSync(file)) throw new Error(`${file}: not found`);
  return { all: readJsonl(file), manifest: readManifest(dir), judge: readJudge(dir) };
}

function summarise(dir) {
  const { all, manifest, judge } = load(dir);
  const kept = all.filter((p) => !EXCLUDED.has(p.outcome));
  const excluded = {};
  for (const p of all) if (EXCLUDED.has(p.outcome)) excluded[p.outcome] = (excluded[p.outcome] ?? 0) + 1;
  const groups = new Map();
  for (const p of kept) {
    const k = `${p.task}\u0000${p.org}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const cells = [...groups.values()]
    .map((ps) => cellOf(ps[0].task, ps[0].org, ps, judge))
    .sort((a, b) => a.task.localeCompare(b.task) || a.org.localeCompare(b.org));
  markDominated(cells);
  const passUsd = sum(all.map((p) => p.cost?.usd));
  const passWeek = sum(all.map((p) => p.cost?.weekPts));
  const totals = {
    passes: all.length,
    excluded,
    passUsd,
    passUsdPartial: all.filter((p) => p.cost?.unpriced?.length).length,
    passWeekPts: passWeek,
    judgeUsd: judge ? judge.cost.usd : null,
    judgeWeekPts: judge ? judge.cost.weekPts : null,
    weekPts: passWeek + (judge ? judge.cost.weekPts : 0),
    capWeek: manifest?.capWeek ?? null,
  };
  return { manifest, judge: judge?.config ?? null, cells, totals };
}

function compareCell(cur, prev) {
  const d = (a, b) => (a && b ? a.median - b.median : null);
  const out = {
    task: cur.task, org: cur.org,
    passes: [prev.passes, cur.passes],
    usd: d(cur.usd, prev.usd),
    weekPts: d(cur.weekPts, prev.weekPts),
    minutes: d(cur.minutes, prev.minutes),
    oracleRate:
      cur.oracle.of && prev.oracle.of ? cur.oracle.ok / cur.oracle.of - prev.oracle.ok / prev.oracle.of : null,
    judge: null,
    judgeNote: null,
  };
  return out;
}

const sameJudgeConfig = (a, b) =>
  !!a && !!b && a.rubric === b.rubric && a.rubricSha === b.rubricSha && a.model === b.model;

// Resolved model ids are compared as written: a different id is a difference.
function buildReport({ dir, compareDir } = {}) {
  if (!dir) throw new Error("buildReport: dir is required");
  const report = summarise(dir);
  if (!compareDir) return report;
  const prev = summarise(compareDir);
  const key = (c) => `${c.task}\u0000${c.org}`;
  const prevCells = new Map(prev.cells.map((c) => [key(c), c]));
  const curKeys = new Set(report.cells.map(key));
  const comparable = sameJudgeConfig(report.judge, prev.judge);
  const cells = [];
  const onlyHere = [];
  for (const c of report.cells) {
    const p = prevCells.get(key(c));
    if (!p) { onlyHere.push({ task: c.task, org: c.org }); continue; }
    const diff = compareCell(c, p);
    if (!c.judge || !p.judge) diff.judgeNote = "no judgment on one side";
    else if (!comparable) diff.judgeNote = "rubric differs";
    else diff.judge = c.judge.overall && p.judge.overall ? c.judge.overall.median - p.judge.overall.median : null;
    cells.push(diff);
  }
  const onlyThere = prev.cells.filter((c) => !curKeys.has(key(c))).map((c) => ({ task: c.task, org: c.org }));
  report.compare = { manifest: prev.manifest, judge: prev.judge, cells, onlyHere, onlyThere };
  return report;
}

// ---- Markdown ------------------------------------------------------------

const DASH = "—";
const num = (v, d = 2) => (finite(v) ? String(Number(v.toFixed(d))) : DASH);
const signed = (v, d = 2) => (finite(v) ? `${v > 0 ? "+" : ""}${num(v, d)}` : DASH);
const range = (s, d = 2) => (s ? `${num(s.median, d)} (${num(s.min, d)}-${num(s.max, d)})` : DASH);
const counts = (o) => Object.entries(o).sort().map(([k, n]) => `${k} ${n}`).join(", ") || DASH;
const cellText = (v) => String(v).replace(/\|/g, "\\|");

function table(head, rows) {
  const line = (r) => `| ${r.map(cellText).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

function manifestLines(label, m) {
  if (!m) return [`- ${label}: no manifest`];
  const models = m.models ? Object.entries(m.models).map(([k, v]) => `${k}=${v}`).join(", ") : DASH;
  return [
    `- ${label}: ${m.id ?? DASH}, Claude Code ${m.claudeCode ?? DASH}, models ${models}, plugin ${m.plugin ?? DASH}`,
  ];
}

function judgeLine(label, j) {
  if (!j) return `- ${label}: no judge.jsonl`;
  return `- ${label}: rubric ${j.rubric} (${j.rubricSha}), anonymiser ${j.anonymiser}, model ${j.model}, effort ${j.effort}`;
}

function renderMarkdown(report) {
  const out = ["# Bench report", ""];
  out.push(...manifestLines("Campaign", report.manifest));
  if (report.compare) out.push(...manifestLines("Compared with", report.compare.manifest));
  out.push(judgeLine("Judge", report.judge));
  if (report.compare) out.push(judgeLine("Judge (compared)", report.compare.judge));
  out.push("");

  const head = [
    "org", "passes", "outcomes", "oracle ok (passes)", "checks ok (passes)", "outside zone (files)",
    "size vs reference (x)", "usd median (min-max) [USD]", "week points", "minutes", "agents launched", "dominated",
    "judged/jugeable (passes)", "judge overall median (min-max) [1-5]", "major defects", "judge not ok", "redactions",
  ];
  for (const task of [...new Set(report.cells.map((c) => c.task))]) {
    out.push(`## Task ${task}`, "");
    const rows = report.cells.filter((c) => c.task === task).map((c) => {
      const j = c.judge;
      const usd = c.usd ? range(c.usd) + (c.unpricedPasses ? ` +${c.unpricedPasses} unpriced` : "")
        : c.unpricedPasses ? `${DASH} (${c.unpricedPasses} unpriced)` : DASH;
      return [
        c.org, c.passes, counts(c.outcomes), `${c.oracle.ok}/${c.oracle.of}`,
        c.checks.of ? `${c.checks.ok}/${c.checks.of}` : DASH,
        range(c.outsideZone, 1), range(c.sizeRatio), usd, range(c.weekPts), range(c.minutes, 1), range(c.agents, 1),
        c.dominated ? "dominated" : "",
        j ? `${j.judged}/${j.jugeable}` : DASH, j ? range(j.overall) : DASH, j ? j.major : DASH,
        j ? counts(j.nonOk) : DASH, j ? j.redactions : DASH,
      ];
    });
    out.push(table(head, rows), "");
  }

  const t = report.totals;
  out.push("## Totals", "");
  const ex = counts(t.excluded);
  out.push(`- Passes: ${t.passes} (excluded from the tables: ${ex})`);
  out.push(
    `- Passes cost: ${num(t.passUsd)} USD, ${num(t.passWeekPts)} week points` +
      (t.passUsdPartial ? ` (${t.passUsdPartial} pass(es) with an unpriced model: usd is partial)` : ""),
  );
  out.push(`- Judge cost: ${t.judgeUsd === null ? DASH : `${num(t.judgeUsd)} USD, ${num(t.judgeWeekPts)} week points`}`);
  out.push(`- Total: ${num(t.weekPts)} week points against a cap of ${t.capWeek === null ? DASH : num(t.capWeek)}`, "");

  if (report.compare) {
    const c = report.compare;
    out.push("## Comparison (campaign minus compared)", "");
    if (c.cells.length) {
      out.push(table(
        ["task", "org", "passes (before/now)", "usd median [USD]", "week points", "minutes", "oracle share", "judge overall"],
        c.cells.map((x) => [
          x.task, x.org, `${x.passes[0]}/${x.passes[1]}`, signed(x.usd), signed(x.weekPts), signed(x.minutes, 1),
          signed(x.oracleRate), x.judgeNote ?? signed(x.judge),
        ]),
      ), "");
    }
    const list = (cells) => cells.map((x) => `${x.task}/${x.org}`).join(", ");
    if (c.onlyHere.length) out.push(`- New cells: ${list(c.onlyHere)}`);
    if (c.onlyThere.length) out.push(`- Missing cells: ${list(c.onlyThere)}`);
    out.push("");
  }
  return out.join("\n");
}

module.exports = { buildReport, renderMarkdown };
