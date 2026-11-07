"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { buildReport, renderMarkdown } = require("../tools/bench/report.js");

// Synthetic values only.
const SHA = (c) => c.repeat(64);
const SECRET = "WITNESS-DEFECT-SUMMARY";

function pass(task, org, n, o = {}) {
  const usd = o.usd ?? 2;
  return {
    schema: 1, campaign: "c1", task, org, pass: n, session: o.session ?? `s-${task}-${org}-${n}`,
    minutes: o.minutes ?? 10, outcome: o.outcome ?? "done", contamination: [], killed: 0,
    cost: {
      byRole: {}, usd, usdReported: usd, unpriced: o.unpriced ?? [], weekPts: o.weekPts ?? usd * 0.4, fiveHourPts: 1,
      ratios: { ratio7: 0.4, ratio5: 3 },
    },
    quality: {
      oracle: o.oracle ?? { pass: 10, fail: 0 }, checks: o.checks ?? { typecheck: true, tests: true, biome: true, build: null },
      filesChanged: 3, outsideZone: o.outside ?? 0, added: o.added ?? 100, deleted: o.deleted ?? 20,
      refAdded: 100, refDeleted: 20, uncommitted: 0, agents: o.agents ?? { morty: 1 }, sendMessages: 0, permissionDenials: 0,
    },
    diff: "diff" in o ? o.diff : { file: "diffs/x.diff", sha256: SHA("a"), bytes: 10, files: 2 },
    diffError: null,
  };
}

function judgment(key, o = {}) {
  const ok = (o.status ?? "ok") === "ok";
  return {
    schema: 1, kind: "judgment", key, task: o.task ?? "t1", rubric: "r1", rubricSha: o.rubricSha ?? SHA("1"),
    schemaSha: SHA("2"), anonymiser: "a1", model: "claude-opus-5-5", effort: "high", session: `j-${key}`,
    attempt: o.attempt ?? 1, status: o.status ?? "ok",
    scores: ok ? { fidelity: o.overall ?? 3, correctness: 3, tests: 3, clarity: 3, scope: 3 } : null,
    overall: ok ? (o.overall ?? 3) : null,
    defects: ok ? { major: o.major ?? 0, minor: 1, items: [{ criterion: "tests", severity: "major", summary: SECRET }] } : null,
    redactions: o.redactions ?? { dropped: { notes: 1 }, words: { worktree: 2 }, brief: {} },
    cost: o.cost === null ? null : { byRole: {}, usd: o.usd ?? 0.2, weekPts: o.weekPts ?? 0.08, unpriced: [] },
  };
}

const run = (o = {}) => ({
  schema: 1, kind: "run", seed: "ab".repeat(8), order: [], anonymiser: "a1", rubric: "r1", rubricSha: o.rubricSha ?? SHA("1"),
  schemaSha: SHA("2"), model: "opus", effort: "high",
});
const link = (session, key) => ({ schema: 1, kind: "link", pass: session, key });

function campaign(passes, judge, manifest) {
  const dir = mkdtempSync(join(tmpdir(), "bench-report-"));
  writeFileSync(join(dir, "passes.jsonl"), passes.map((p) => JSON.stringify(p)).join("\n") + "\n");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest ?? {
    id: "c1", claudeCode: "9.0.1", models: { orchestrator: "model-x" }, plugin: "abc1234", capWeek: 10,
  }));
  if (judge) writeFileSync(join(dir, "judge.jsonl"), judge.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

const cell = (r, task, org) => r.cells.find((c) => c.task === task && c.org === org);

test("T1 table over three synthetic passes (odd and even medians)", () => {
  const dir = campaign([
    pass("t1", "O0", 1, { usd: 1, minutes: 8 }),
    pass("t1", "O0", 2, { usd: 3, minutes: 12, outside: 2, oracle: { pass: 9, fail: 1 } }),
    pass("t1", "O1", 1, { usd: 4.5, agents: { morty: 1, council: 1 }, checks: { typecheck: true, tests: false, build: null } }),
  ]);
  const r = buildReport({ dir });
  const o0 = cell(r, "t1", "O0");
  assert.equal(o0.passes, 2);
  assert.deepEqual(o0.usd, { median: 2, min: 1, max: 3, n: 2 });
  assert.deepEqual(o0.oracle, { ok: 1, of: 2 });
  assert.deepEqual(o0.checks, { ok: 2, of: 2 });
  assert.equal(o0.outsideZone.median, 1);
  assert.equal(o0.minutes.median, 10);
  assert.equal(o0.sizeRatio.median, 1);
  const o1 = cell(r, "t1", "O1");
  assert.deepEqual(o1.checks, { ok: 0, of: 1 });
  assert.equal(o1.agents.median, 2);
  const md = renderMarkdown(r);
  assert.match(md, /\| O0 \| 2 \| done 2 \| 1\/2 \| 2\/2 \|/);
  assert.match(md, /usd median \(min-max\) \[USD\]/);
  assert.match(md, /2 \(1-3\)/);
  console.log(md);
});

test("T2 a contaminated or misconfigured pass is out of the table and counted apart", () => {
  const dir = campaign([
    pass("t1", "O0", 1, { usd: 1 }),
    pass("t1", "O0", 2, { usd: 50, outcome: "contaminated" }),
    pass("t1", "O1", 1, { usd: 9, outcome: "misconfigured" }),
  ]);
  const r = buildReport({ dir });
  assert.equal(cell(r, "t1", "O0").passes, 1);
  assert.equal(cell(r, "t1", "O0").usd.median, 1);
  assert.equal(cell(r, "t1", "O1"), undefined);
  assert.deepEqual(r.totals.excluded, { contaminated: 1, misconfigured: 1 });
  assert.equal(r.totals.passUsd, 60, "excluded passes still cost");
});

test("T3 dominated is marked, and not at equal cost or lower oracle share", () => {
  const dir = campaign([
    pass("a", "O0", 1, { usd: 2 }), pass("a", "O1", 1, { usd: 4 }),
    pass("b", "O0", 1, { usd: 2 }), pass("b", "O1", 1, { usd: 2 }),
    pass("c", "O0", 1, { usd: 2, oracle: { pass: 5, fail: 1 } }), pass("c", "O1", 1, { usd: 4 }),
  ]);
  const r = buildReport({ dir });
  assert.equal(cell(r, "a", "O1").dominated, true);
  assert.equal(cell(r, "a", "O0").dominated, false);
  assert.equal(cell(r, "b", "O0").dominated, false);
  assert.equal(cell(r, "b", "O1").dominated, false);
  assert.equal(cell(r, "c", "O1").dominated, false, "costs more but passes the oracle more often");
  assert.equal(cell(r, "c", "O0").dominated, false);
});

test("T4 compare: new cell, missing cell, deltas and both manifests", () => {
  const prev = campaign([pass("t1", "O0", 1, { usd: 2, minutes: 10 }), pass("t1", "O3", 1)],
    null, { id: "c0", claudeCode: "8.0.0", models: { orchestrator: "model-w" }, plugin: "old0001" });
  const cur = campaign([pass("t1", "O0", 1, { usd: 3, minutes: 7 }), pass("t1", "O1", 1)]);
  const r = buildReport({ dir: cur, compareDir: prev });
  assert.deepEqual(r.compare.onlyHere, [{ task: "t1", org: "O1" }]);
  assert.deepEqual(r.compare.onlyThere, [{ task: "t1", org: "O3" }]);
  assert.equal(r.compare.cells.length, 1);
  assert.equal(r.compare.cells[0].usd, 1);
  assert.equal(r.compare.cells[0].minutes, -3);
  const md = renderMarkdown(r);
  assert.match(md, /Claude Code 9\.0\.1/);
  assert.match(md, /Claude Code 8\.0\.0/);
  assert.match(md, /old0001/);
  assert.match(md, /New cells: t1\/O1/);
  assert.match(md, /Missing cells: t1\/O3/);
});

test("T5 a pass with an unpriced model is not a zero cost", () => {
  const dir = campaign([
    pass("t1", "O0", 1, { usd: 2 }),
    pass("t1", "O0", 2, { usd: 0.5, unpriced: ["model-new"] }),
    pass("t1", "O1", 1, { usd: 0, unpriced: ["model-new"] }),
  ]);
  const r = buildReport({ dir });
  assert.equal(cell(r, "t1", "O0").usd.median, 2);
  assert.equal(cell(r, "t1", "O0").unpricedPasses, 1);
  assert.equal(cell(r, "t1", "O1").usd, null);
  assert.equal(cell(r, "t1", "O1").dominated, false);
  const md = renderMarkdown(r);
  assert.match(md, /\+1 unpriced/);
  assert.match(md, /— \(1 unpriced\)/);
  assert.equal(cell(r, "t1", "O0").dominated, false, "an unpriced cell does not dominate");
  assert.equal(r.totals.passUsdPartial, 2);
});

test("T6 judge: median overall, major defects, a too-large pass counted unjudged", () => {
  const passes = [
    pass("t1", "O0", 1, { session: "p1" }), pass("t1", "O0", 2, { session: "p2" }),
    pass("t1", "O0", 3, { session: "p3" }), pass("t1", "O0", 4, { session: "p4" }),
    pass("t1", "O0", 5, { session: "p5", diff: null }),
  ];
  const dir = campaign(passes, [
    run(),
    judgment("k1", { overall: 2, major: 3 }), link("p1", "k1"),
    judgment("k2", { overall: 4, major: 1 }), link("p2", "k2"),
    judgment("k3", { status: "too-large", cost: null }), link("p3", "k3"),
    // p4: error, no link, cost still counted
    judgment("k4", { status: "error", usd: 0.1, weekPts: 0.04 }),
  ]);
  const r = buildReport({ dir });
  const j = cell(r, "t1", "O0").judge;
  assert.equal(j.judged, 2);
  assert.equal(j.jugeable, 4, "a pass without a kept diff is not jugeable");
  assert.equal(j.overall.median, 3);
  assert.equal(j.overall.min, 2);
  assert.equal(j.major, 4);
  assert.deepEqual(j.nonOk, { "too-large": 1 });
  assert.equal(j.redactions, 6, "two judged keys x (1 dropped + 2 words)");
  assert.equal(j.criteria.fidelity.median, 3);
  assert.equal(r.totals.judgeUsd.toFixed(2), "0.50");
  console.log(renderMarkdown(r));
});

test("T7 shared judgment counts for both passes, once in the cost; retries add up", () => {
  const dir = campaign([
    pass("t1", "O0", 1, { session: "p1" }), pass("t1", "O0", 2, { session: "p2" }), pass("t1", "O1", 1, { session: "p3" }),
  ], [
    run(),
    judgment("k1", { overall: 5, usd: 0.3, weekPts: 0.1 }), link("p1", "k1"), link("p2", "k1"),
    judgment("k2", { status: "invalid", usd: 0.2, weekPts: 0.05, attempt: 1 }),
    judgment("k2", { overall: 1, usd: 0.25, weekPts: 0.07, attempt: 2 }), link("p3", "k2"),
  ]);
  const r = buildReport({ dir });
  const j = cell(r, "t1", "O0").judge;
  assert.equal(j.judged, 2);
  assert.deepEqual(j.overall, { median: 5, min: 5, max: 5, n: 2 });
  assert.equal(r.totals.judgeUsd.toFixed(2), "0.75");
  assert.equal(r.totals.judgeWeekPts.toFixed(2), "0.22");
  assert.equal(cell(r, "t1", "O1").judge.overall.median, 1, "the retry that succeeded gives the note");
  assert.deepEqual(cell(r, "t1", "O1").judge.nonOk, {});
});

test("T7b a later invalid line does not replace an earlier ok for the same key", () => {
  const dir = campaign([pass("t1", "O0", 1, { session: "p1" })], [
    run(), judgment("k1", { overall: 4 }), judgment("k1", { status: "invalid" }), link("p1", "k1"),
  ]);
  assert.equal(cell(buildReport({ dir }), "t1", "O0").judge.overall.median, 4);
});

test("T8 without judge.jsonl: dashes, no failure, no defect summary in the output", () => {
  const dir = campaign([pass("t1", "O0", 1)]);
  const r = buildReport({ dir });
  assert.equal(r.judge, null);
  assert.equal(cell(r, "t1", "O0").judge, null);
  const md = renderMarkdown(r);
  assert.match(md, /no judge\.jsonl/);
  assert.match(md, /\| — \| — \| — \| — \| — \|$/m);
  // with a judge file: the witness summary never reaches Markdown or JSON
  const dir2 = campaign([pass("t1", "O0", 1, { session: "p1" })], [run(), judgment("k1"), link("p1", "k1")]);
  const r2 = buildReport({ dir: dir2 });
  assert.ok(!renderMarkdown(r2).includes(SECRET));
  assert.ok(!JSON.stringify(r2).includes(SECRET));
});

test("T9 compare with a different rubricSha: judge notes not compared, said so", () => {
  const mk = (sha) => campaign([pass("t1", "O0", 1, { session: "p1" })], [
    run({ rubricSha: sha }), judgment("k1", { overall: 4, rubricSha: sha }), link("p1", "k1"),
  ]);
  const r = buildReport({ dir: mk(SHA("1")), compareDir: mk(SHA("9")) });
  assert.equal(r.compare.cells[0].judge, null);
  assert.equal(r.compare.cells[0].judgeNote, "rubric differs");
  assert.match(renderMarkdown(r), /rubric differs/);
  const same = buildReport({ dir: mk(SHA("1")), compareDir: mk(SHA("1")) });
  assert.equal(same.compare.cells[0].judge, 0);
});

test("judge file with several configurations: the last run line wins, other judgments only cost", () => {
  const dir = campaign([pass("t1", "O0", 1, { session: "p1" })], [
    run({ rubricSha: SHA("1") }), judgment("k1", { overall: 1, usd: 0.3 }), link("p1", "k1"),
    run({ rubricSha: SHA("7") }), judgment("k7", { overall: 5, usd: 0.4, rubricSha: SHA("7") }), link("p1", "k7"),
  ]);
  const r = buildReport({ dir });
  assert.equal(r.judge.rubricSha, SHA("7"));
  assert.equal(cell(r, "t1", "O0").judge.overall.median, 5);
  assert.equal(r.totals.judgeUsd.toFixed(1), "0.7");
  // a pass linked only to an old configuration is unjudged under the new one
  const dir2 = campaign([pass("t1", "O0", 1, { session: "p1" })], [
    run({ rubricSha: SHA("1") }), judgment("k1", { overall: 1 }), link("p1", "k1"), run({ rubricSha: SHA("7") }),
  ]);
  assert.equal(cell(buildReport({ dir: dir2 }), "t1", "O0").judge.judged, 0);
});

test("a malformed passes.jsonl line fails with its line number", () => {
  const dir = campaign([pass("t1", "O0", 1)]);
  writeFileSync(join(dir, "passes.jsonl"), "{\"task\":\n");
  assert.throws(() => buildReport({ dir }), /passes\.jsonl:1/);
});
