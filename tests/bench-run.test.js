"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, commitFile, emptyHome, git, makeRepo } = require("./helpers.js");
const lib = require("../scripts/orch-lib.js");
const { runCampaign, takeLock } = require("../tools/bench/campaign.js");
const { runPass, sweep } = require("../tools/bench/run.js");
const { loadSuite } = require("../tools/bench/suite.js");

// profileTrust reads the approval store of the home it is run under.
process.env.HOME = emptyHome;
process.env.USERPROFILE = emptyHome;

const FAKE = join(ROOT, "tests", "fixtures", "fake-claude.js");
const BENCH = join(ROOT, "tools", "bench", "orch-bench.js");
const RATIOS = { ratio7: 10, ratio5: 10 };
const temps = [];
test.after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const tmp = (prefix) => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonl = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const head = (cwd) => git(cwd, "rev-parse", "HEAD").out.trim();

const ORACLE = `const test = require("node:test");
const assert = require("node:assert/strict");
test("src answers 2", () => assert.equal(require("./src.js")(), 2));
`;
const node = (code) => `node -e "${code}"`;
const WORK = { file: "src.js", content: "module.exports = () => 2;\n" };

let sourceCache;
function source() {
  if (sourceCache) return sourceCache;
  const { dir } = makeRepo({ checks: [{ name: "tests", run: node("process.exit(0)") }, { name: "lint", run: node("process.exit(1)") }] });
  commitFile(dir, "src.js", "module.exports = () => 1;\n", "feat: src");
  const fork = head(dir);
  commitFile(dir, "src.js", "module.exports = () => 2;\n", "fix: src");
  commitFile(dir, "oracle.test.js", ORACLE, "test: oracle");
  const tip = head(dir);
  commitFile(dir, "merge-only.txt", "merged\n", "chore: merge");
  return (sourceCache = { dir, fork, tip, merge: head(dir) });
}

// A suite whose `claude` is the fake, driven by files in its folder.
function makeSuite({ patch = () => {} } = {}) {
  const src = source();
  const dir = tmp("bench-run-");
  writeFileSync(join(dir, "state.md"), "# State\n\nsynthetic\n");
  writeFileSync(join(dir, "t1.md"), "# Task\n\nMake src.js answer 2.\n");
  const raw = {
    id: "synthetic",
    source: src.dir,
    slot: join(dir, "slot"),
    results: join(dir, "results"),
    forbiddenPaths: ["backups"],
    forbiddenSkills: ["pi-ops"],
    env: { FAKE_CONFIG: join(dir, "fake.json"), FAKE_LOG: join(dir, "fake.log"), FAKE_PROJECTS: join(dir, "projects") },
    install: [],
    oracleCommand: "node --test --test-reporter=tap {files}",
    stateTemplate: "state.md",
    prompts: { O0: "do it", O2: "run it" },
    organisations: {
      O0: { plugin: false, advisor: true, organisation: null, maxBudgetUsd: 1, estimateUsd: 0.1, p90Usd: 0.2 },
      O2: { plugin: true, advisor: false, organisation: { name: "O2", review: "never", council: [] }, maxBudgetUsd: 2, estimateUsd: 0.1, p90Usd: 0.2 },
    },
    judge: { model: "opus", effort: "high", cwd: join(dir, "judge"), rubric: "r1", estimateUsd: 0.2, p90Usd: 0.4, maxBudgetUsd: 1 },
    tasks: [{ id: "t1", fork: src.fork, tip: src.tip, merge: src.merge, brief: "t1.md", oracle: ["oracle.test.js"], zone: ["src.js"] }],
  };
  patch(raw);
  const file = join(dir, "suite.json");
  writeFileSync(file, JSON.stringify(raw));
  return { file, dir };
}

function world({ cfg = {}, patch } = {}) {
  const s = makeSuite({ patch });
  const suite = loadSuite(s.file);
  // What `validate` leaves for the task, written directly.
  mkdirSync(suite.results, { recursive: true });
  writeFileSync(join(suite.results, "validate.json"), JSON.stringify({ t1: { fork: suite.tasks[0].fork, tip: suite.tasks[0].tip, ok: true, checks: { tests: true, lint: false } } }));
  mkdirSync(`${suite.slot}-plugin`, { recursive: true });
  const w = { suite, dir: s.dir, camp: join(suite.results, "camp-1"), projects: join(s.dir, "projects"), log: join(s.dir, "fake.log"), cfgFile: join(s.dir, "fake.json") };
  w.setCfg = (c) => writeFileSync(w.cfgFile, JSON.stringify(c));
  w.setCfg(cfg);
  const common = () => ({ suite, campaignDir: w.camp, claude: process.execPath, claudeArgs: [FAKE], projects: w.projects, ratios: RATIOS, allowPort: true });
  w.pass = (extra = {}) => runPass({ ...common(), taskId: "t1", orgId: "O0", ...extra });
  w.campaign = (extra = {}) => runCampaign({ ...common(), id: "camp-1", quota: () => null, ...extra });
  w.calls = () => jsonl(w.log);
  w.passes = () => jsonl(join(w.camp, "passes.jsonl"));
  // Processes whose command line holds the slot.
  w.left = () => lib.listProcesses().filter((p) => p.pid !== process.pid && lib.normPath(p.line ?? "").includes(lib.normPath(realpathSync.native(suite.slot))));
  return w;
}

const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

test("T1 a nominal pass writes a full line with its costs, quality and diff", async () => {
  const w = world({ cfg: { commit: WORK, cost: 0.5 } });
  const line = await w.pass();
  assert.equal(line.outcome, "done");
  assert.ok(line.cost.usd > 0 && line.cost.weekPts > 0 && line.cost.fiveHourPts > 0, JSON.stringify(line.cost));
  assert.equal(line.cost.weekPts, line.cost.usd * RATIOS.ratio7);
  assert.equal(line.cost.fiveHourPts, line.cost.usd * RATIOS.ratio5);
  assert.equal(line.quality.oracle.fail, 0);
  assert.ok(line.quality.oracle.pass >= 1);
  assert.equal(line.diff.files, 1);
  assert.equal(line.diffError, null);
  assert.deepEqual([line.killed, line.leftover], [0, 0]);
  assert.equal(line.leaks.length, 0);
  assert.deepEqual(w.passes(), [line], "one line, as returned");
  assert.equal(line.session, argAfter(w.calls()[0].args, "--session-id"));
  for (const k of ["task", "org", "session", "startedAt", "minutes", "outcome", "cost", "quality", "diff", "diffError", "killed"]) assert.ok(k in line, k);

  // Several result events: the last one counts.
  const w2 = world({ cfg: { commit: WORK, results: 3, cost: 0.1, noTranscript: true } });
  const l2 = await w2.pass();
  assert.equal(l2.cost.usd, 0.1 * 3);
  // A pass whose main did not advance is not "done".
  const w3 = world({ cfg: {} });
  assert.equal((await w3.pass()).outcome, "no-merge");
});

test("T2 an init that does not match the organisation is misconfigured and the call is killed", async () => {
  const cases = [
    ["a plugin in O0", "O0", { initPlugins: [{ name: "microverse", source: "inline" }] }],
    ["another plugin in O0", "O0", { initPlugins: [{ name: "other" }] }],
    ["no plugin in O2", "O2", { initPlugins: [] }],
    ["an extra plugin in O2", "O2", { initPlugins: [{ name: "microverse" }, { name: "other" }] }],
    ["a forbidden skill", "O0", { initSkills: ["pi-ops"] }],
    ["a forbidden plugin skill", "O2", { initPlugins: [{ name: "microverse" }], initSkills: ["x:pi-ops"] }],
  ];
  for (const [name, org, cfg] of cases) {
    const w = world({ cfg: { ...cfg, hang: true } });
    const started = Date.now();
    // The short limit only turns a missed check into a failed assertion instead of a long wait.
    const line = await w.pass({ orgId: org, timeoutMinutes: 0.3 });
    assert.equal(line.outcome, "misconfigured", name);
    assert.ok(line.reason, name);
    assert.ok(Date.now() - started < 60000, `${name}: killed, not waited for`);
    assert.equal(w.left().length, 0, `${name}: nothing left`);
    assert.equal(w.passes().length, 1, `${name}: the line is written`);
  }
  // The controls: the expected configuration is accepted.
  const ok = world({ cfg: { initPlugins: [{ name: "microverse", source: "inline" }], commit: WORK } });
  assert.equal((await ok.pass({ orgId: "O2" })).outcome, "done");
  // Claude Code's own built-in plugins are not a configuration choice.
  const ok0 = world({ cfg: { initPlugins: [{ name: "cc-plugin-x", path: "builtin", source: "cc-plugin-x@builtin" }], initSkills: ["local-data"], commit: WORK } });
  assert.equal((await ok0.pass()).outcome, "done");
});

test("T3 the time limit gives timeout and no process of the slot is left", async () => {
  const w = world({ cfg: { hang: true, child: true } });
  const line = await w.pass({ timeoutMinutes: 0.05 });
  assert.equal(line.outcome, "timeout");
  assert.equal(line.leftover, 0);
  assert.equal(w.left().length, 0, "no process whose command line holds the slot");
  assert.equal(w.passes().length, 1);

  // The sweep kills what the tree kill missed (a child that left its group).
  const where = join(tmp("bench-sweep-"), "slot");
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", where], { stdio: "ignore", windowsHide: true, detached: true });
  orphan.unref();
  await sleep(600);
  const res = await sweep(where);
  assert.ok(res.killed >= 1);
  assert.equal(res.left, 0);
  assert.throws(() => process.kill(orphan.pid, 0));
});

test("T4 the spend cap stops the campaign with its reason, a stale quota reading is ignored, and a relaunch resumes", async () => {
  const w = world({ cfg: { commit: WORK, cost: 0.5, noTranscript: true }, patch: (raw) => delete raw.judge });
  const stale = () => ({ counters: { five: { used: 99, observedAt: Date.now() - 3 * 3600 * 1000 }, week: { used: 99, observedAt: Date.now() - 3 * 3600 * 1000 } } });
  // Each pass costs 5 points of week against a cap of 10: the third is refused.
  const first = await w.campaign({ passes: 2, capWeek: 10, quota: stale });
  assert.equal(first.stopped, "week cap");
  assert.equal(w.passes().length, 2);
  assert.equal(first.lines.filter((l) => /^t1 O[02] done /.test(l)).length, 2);
  const before = readFileSync(join(w.camp, "passes.jsonl"), "utf8");
  assert.equal(w.calls().length, 2);

  const second = await w.campaign({ passes: 2, capWeek: 100, quota: stale });
  assert.equal(second.stopped, null);
  assert.equal(w.passes().length, 4);
  assert.equal(readFileSync(join(w.camp, "passes.jsonl"), "utf8").startsWith(before), true, "the first two lines are not redone");
  assert.equal(w.calls().length, 4);
  const cells = w.passes().map((p) => `${p.task}${p.org}`).sort();
  assert.deepEqual(cells, ["t1O0", "t1O0", "t1O2", "t1O2"]);

  // A fresh reading above the five-hour cap stops before any call.
  const w2 = world({ cfg: { commit: WORK, noTranscript: true }, patch: (raw) => delete raw.judge });
  const fresh = await w2.campaign({ passes: 1, quota: () => ({ counters: { five: { used: 95, observedAt: Date.now() - 1000 } } }) });
  assert.match(fresh.stopped, /five-hour cap/);
  assert.equal(w2.calls().length, 0);

  // The lock: held by a live process it refuses, left by a dead one it is taken over.
  const lock = join(w.dir, "x.lock");
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  writeFileSync(lock, String(live.pid));
  assert.throws(() => takeLock(lock), /another campaign/);
  live.kill();
  await new Promise((r) => live.on("exit", r));
  takeLock(lock);
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
});

test("T5 a development database that accepts connections refuses the start", async () => {
  const server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const w = world({ cfg: { commit: WORK } });
    await assert.rejects(() => w.campaign({ allowPort: false, dbPort: port }), /accepts connections/);
    await assert.rejects(() => w.pass({ allowPort: false, dbPort: port }), /accepts connections/);
    assert.equal(w.calls().length, 0);
    assert.ok(!existsSync(w.suite.slot), "nothing was prepared");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("T6 the call gets the whitelisted environment, the options and the settings of the brief", async () => {
  process.env.PARENT_SECRET = "from-the-parent";
  const w = world({ cfg: { commit: WORK } });
  await w.pass();
  await w.pass({ orgId: "O2", model: "haiku" });
  delete process.env.PARENT_SECRET;
  const [a, b] = w.calls();
  for (const c of [a, b]) {
    assert.equal(c.env.PARENT_SECRET, undefined);
    assert.equal(c.env.CLAUDE_PLUGIN_OPTION_QUOTA_MODE, "off");
    assert.equal(c.env.FAKE_CONFIG, w.cfgFile, "the suite's env is passed");
    assert.equal(c.cwd, realpathSync.native(w.suite.slot));
    for (const never of ["--no-session-persistence", "--max-turns"]) assert.ok(!c.args.includes(never), never);
    assert.equal(argAfter(c.args, "--setting-sources"), "project,local");
    assert.ok(c.args.includes("--strict-mcp-config"));
    assert.equal(argAfter(c.args, "--permission-mode"), "dontAsk");
    assert.equal(argAfter(c.args, "--output-format"), "stream-json");
    assert.ok(c.args.includes("--verbose"));
    assert.match(argAfter(c.args, "--session-id"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.equal(argAfter(a.args, "--model"), "sonnet");
  assert.equal(argAfter(b.args, "--model"), "haiku");
  assert.equal(argAfter(a.args, "-p"), "do it");
  assert.equal(argAfter(b.args, "-p"), "run it");
  assert.equal(argAfter(a.args, "--max-budget-usd"), "1");
  assert.equal(argAfter(b.args, "--max-budget-usd"), "2");
  assert.ok(!a.args.includes("--plugin-dir"));
  assert.equal(argAfter(b.args, "--plugin-dir"), `${w.suite.slot}-plugin`);
  const sa = JSON.parse(readFileSync(argAfter(a.args, "--settings"), "utf8"));
  const sb = JSON.parse(readFileSync(argAfter(b.args, "--settings"), "utf8"));
  assert.equal(sa.advisorModel, "opus");
  assert.ok(!("advisorModel" in sb), "an organisation without advisor has none");
  for (const s of [sa, sb]) {
    assert.equal(s.autoCompactWindow, 183000);
    assert.equal(s.autoMemoryEnabled, false);
    assert.ok(s.permissions.allow.includes("Bash(git:*)") && s.permissions.allow.includes("Bash(npm test:*)"));
    for (const denied of ["Bash(git push:*)", "Bash(curl:*)", "Bash(docker:*)", "Bash(npm run deploy:*)", "Read(~/.claude/projects/**)"]) assert.ok(s.permissions.deny.includes(denied), denied);
    assert.ok(s.permissions.deny.some((d) => d.startsWith("Read(") && d.includes("backups")));
  }
  await assert.rejects(() => w.pass({ claude: "C:\\tools\\claude.cmd" }), /\.cmd|shell/);
  await assert.rejects(() => w.pass({ claude: "claude.BAT" }), /\.cmd|shell/);
});

test("T7 the diff is kept before the grade, for every outcome, and survives the next preparation", async () => {
  const w = world({ cfg: { commit: WORK } });
  const line = await w.pass();
  const file = join(w.camp, line.diff.file);
  assert.equal(line.diff.file, `diffs/${line.session}.diff`);
  const bytes = readFileSync(file);
  assert.equal(line.diff.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(line.diff.bytes, bytes.length);
  assert.match(bytes.toString(), /^diff --git a\/src\.js b\/src\.js/m);
  // The next preparation deletes the slot (and the commit); the diff file stays.
  w.setCfg({});
  const next = await w.pass();
  assert.equal(next.outcome, "no-merge");
  assert.equal(next.diff.files, 0);
  assert.ok(existsSync(file));
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), line.diff.sha256);

  // A timeout after a commit still keeps the diff.
  const t = world({ cfg: { commit: WORK, hang: true } });
  const timed = await t.pass({ timeoutMinutes: 0.1 });
  assert.equal(timed.outcome, "timeout");
  assert.equal(timed.diff.files, 1);
  assert.ok(existsSync(join(t.camp, timed.diff.file)));

  // A marker removed by the agent: no diff, the reason named, the line still written.
  const m = world({ cfg: { commit: WORK, removeMarker: true } });
  const lost = await m.pass();
  assert.equal(lost.diff, null);
  assert.equal(lost.diffError, "no-marker");
  assert.equal(m.passes().length, 1);
});

test("T8 the judge reserve counts in the guard, a measured judgment lowers it, no judge means no reserve", async () => {
  // 10 points per dollar, cap 10: a pass is 0.2 + 0.4 judge = 6 points to launch.
  // After a first pass of 0.1 dollar (1 point) the second fits alone (7) but not
  // with the 4 points the first one's judgment may still cost (11).
  const w = world({ cfg: { commit: WORK, cost: 0.1, noTranscript: true } });
  const first = await w.campaign({ passes: 1, capWeek: 10 });
  assert.equal(first.stopped, "week cap (judge reserve)");
  assert.equal(w.passes().length, 1);
  assert.equal(first.unjudged, 1);
  assert.ok(first.lines.at(-1).includes(`orch-bench judge --suite ${w.suite.file} --id camp-1`), first.lines.at(-1));

  // The pass judged for less than its reserve: the next one launches.
  const p = w.passes()[0];
  appendFileSync(join(w.camp, "judge.jsonl"), `${JSON.stringify({ schema: 1, kind: "judgment", key: "k1", status: "ok", startedAt: new Date().toISOString(), seconds: 5, cost: { usd: 0.001, weekPts: 0.01, fiveHourPts: 0.01 } })}\n`);
  appendFileSync(join(w.camp, "judge.jsonl"), `${JSON.stringify({ schema: 1, kind: "link", pass: p.session, key: "k1" })}\n`);
  const second = await w.campaign({ passes: 1, capWeek: 10 });
  assert.equal(second.ran, 1);
  assert.equal(w.passes().length, 2);
  assert.equal(second.stopped, null);

  // Without a judge in the suite the same grid is not stopped.
  const n = world({ cfg: { commit: WORK, cost: 0.1, noTranscript: true }, patch: (raw) => delete raw.judge });
  const all = await n.campaign({ passes: 1, capWeek: 10 });
  assert.equal(all.stopped, null);
  assert.equal(n.passes().length, 2);
  assert.match(all.lines.at(-1), /no judge/);
});

test("T9 report prints the tables of a campaign, and the campaign never calls the judge", async () => {
  const w = world({ cfg: { commit: WORK, cost: 0.1 } });
  const res = await w.campaign({ passes: 1, capWeek: 100 });
  assert.equal(res.stopped, null);
  for (const c of w.calls()) {
    for (const judgeOnly of ["--json-schema", "--system-prompt-file", "--effort", "--tools"]) assert.ok(!c.args.includes(judgeOnly), `a judge call: ${judgeOnly}`);
  }
  assert.equal(w.calls().length, 2);
  assert.ok(!existsSync(join(w.camp, "judge.jsonl")));
  const m = JSON.parse(readFileSync(join(w.camp, "manifest.json"), "utf8"));
  assert.equal(m.id, "camp-1");
  assert.equal(m.claudeCode, "9.9.9 (Fake Code)");
  assert.deepEqual(m.models, { executor: "sonnet", advisor: "opus", judge: "opus" });
  assert.equal(m.capWeek, 100);
  assert.ok(Date.parse(m.date) > 0);
  assert.equal(m.suiteSha256, w.suite.sha256);

  const r = spawnSync(process.execPath, [BENCH, "report", "--results", w.camp], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim().length > 100);
  assert.match(r.stdout, /t1/);
  const j = spawnSync(process.execPath, [BENCH, "report", "--results", w.camp, "--json"], { encoding: "utf8" });
  assert.equal(j.status, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).cells.length, 2);
  const missing = spawnSync(process.execPath, [BENCH, "report", "--results", join(w.dir, "nope")], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);

  // A resume with another suite file is refused: the manifest would lie.
  const other = world({ cfg: {} });
  await assert.rejects(() => runCampaign({ suite: other.suite, id: "camp-1", campaignDir: w.camp, claude: process.execPath, claudeArgs: [FAKE], projects: w.projects, ratios: RATIOS, allowPort: true, quota: () => null }), /suite changed/);
});
