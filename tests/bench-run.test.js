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
const { runPass, settingsFor, sweep } = require("../tools/bench/run.js");
const { killTree } = require("../tools/bench/proc.js");
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

// Approves the profile the slot will hold once prepared (the one committed at
// the fork of the source), under the slot's path: the slot does not exist yet.
function approveSlot(suite) {
  const text = git(source().dir, "show", `${source().fork}:.claude/orchestration/profile.json`).out.replace(/\r\n/g, "\n");
  const key = join(realpathSync.native(join(suite.slot, "..")), "slot");
  const file = join(emptyHome, ".claude", "microverse", "trust.json");
  let store = {};
  try {
    store = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  store[process.platform === "win32" ? key.toLowerCase() : key] = createHash("sha256").update(text).digest("hex");
  mkdirSync(join(emptyHome, ".claude", "microverse"), { recursive: true });
  writeFileSync(file, JSON.stringify(store));
}

// A plugin manifest of the test, not the repository's.
const MANIFEST = {
  name: "demo-plugin",
  userConfig: {
    week_target: { type: "number", default: 90 },
    label: { type: "string", default: "x" },
    quota_mode: { type: "string", default: "auto" },
    quota_file: { type: "string" },
    speak_voice: { type: "string", title: "no default" },
  },
};
function writeManifest(slot, content) {
  mkdirSync(join(`${slot}-plugin`, ".claude-plugin"), { recursive: true });
  writeFileSync(join(`${slot}-plugin`, ".claude-plugin", "plugin.json"), typeof content === "string" ? content : JSON.stringify(content));
}

function world({ cfg = {}, patch, approve = true } = {}) {
  const s = makeSuite({ patch });
  const suite = loadSuite(s.file);
  if (approve) approveSlot(suite);
  // What `validate` leaves for the task, written directly.
  mkdirSync(suite.results, { recursive: true });
  writeFileSync(join(suite.results, "validate.json"), JSON.stringify({ t1: { fork: suite.tasks[0].fork, tip: suite.tasks[0].tip, ok: true, checks: { tests: true, lint: false } } }));
  mkdirSync(join(`${suite.slot}-plugin`, "bin"), { recursive: true });
  writeFileSync(join(`${suite.slot}-plugin`, "bin", "agent-check"), "");
  writeManifest(suite.slot, MANIFEST);
  const w = { suite, dir: s.dir, camp: join(suite.results, "camp-1"), projects: join(s.dir, "projects"), log: join(s.dir, "fake.log"), cfgFile: join(s.dir, "fake.json") };
  w.setCfg = (c) => writeFileSync(w.cfgFile, JSON.stringify(c));
  w.setCfg(cfg);
  const common = () => ({ suite, campaignDir: w.camp, claude: process.execPath, claudeArgs: [FAKE], projects: w.projects, ratios: RATIOS, allowPort: true, quota: fresh() });
  w.pass = (extra = {}) => runPass({ ...common(), taskId: "t1", orgId: "O0", ...extra });
  w.campaign = (extra = {}) => runCampaign({ ...common(), id: "camp-1", ...extra });
  w.calls = () => jsonl(w.log);
  w.passes = () => jsonl(join(w.camp, "passes.jsonl"));
  // Processes whose command line holds the slot.
  w.left = () => lib.listProcesses().filter((p) => p.pid !== process.pid && lib.normPath(p.line ?? "").includes(lib.normPath(realpathSync.native(suite.slot))));
  return w;
}

const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

// An orch-quota reading taken now, with the whole week left.
const fresh = (five = 5, week = 0) => () => ({ counters: { five: { used: five, observedAt: Date.now() }, week: { used: week, observedAt: Date.now() } } });
const INLINE = { name: "microverse", path: "C:\\synthetic\\plugin", source: "microverse@inline", version: "0.6.0" };

test("T1 a nominal pass writes a full line with its costs, quality and diff", async () => {
  const w = world({ cfg: { commit: WORK, cost: 0.5 } });
  // Different ratios, so that a swapped pair of them cannot pass.
  const ratios = { ratio7: 0.4, ratio5: 3 };
  const readings = [fresh(7, 3)(), fresh(9, 4)()];
  const line = await w.pass({ ratios, quota: () => readings.shift() ?? null });
  assert.equal(line.outcome, "done");
  assert.ok(line.cost.usd > 0 && line.cost.weekPts > 0 && line.cost.fiveHourPts > 0, JSON.stringify(line.cost));
  assert.equal(line.cost.weekPts, line.cost.usd * 0.4);
  assert.equal(line.cost.fiveHourPts, line.cost.usd * 3);
  assert.equal(line.quality.oracle.fail, 0);
  assert.ok(line.quality.oracle.pass >= 1);
  assert.equal(line.diff.files, 1);
  assert.equal(line.diffError, null);
  assert.deepEqual([line.killed, line.leftover], [0, 0]);
  assert.equal(line.contamination.length, 0);
  assert.ok(!("leaks" in line));
  assert.deepEqual(w.passes(), [line], "one line, as returned");
  assert.equal(line.session, argAfter(w.calls()[0].args, "--session-id"));
  for (const k of ["task", "org", "session", "startedAt", "minutes", "outcome", "cost", "quality", "diff", "diffError", "killed", "campaign", "pass", "env", "quota", "model"]) assert.ok(k in line, k);
  assert.equal(line.campaign, "camp-1");
  assert.equal(line.pass, 1);
  assert.equal(line.model, "claude-sonnet-5-5", "the id the call resolved to");
  assert.deepEqual(line.env, { claudeCode: "9.9.9 (Fake Code)", plugin: null, models: { orchestrator: "claude-sonnet-5-5" } });
  assert.deepEqual([line.quota.weekBefore, line.quota.weekAfter, line.quota.fiveBefore, line.quota.fiveAfter], [3, 4, 7, 9]);

  // The same cell again is its second pass; with no fresh reading the figures are null, never zero.
  assert.equal((await w.pass()).pass, 2);
  const blind = await w.pass({ quota: () => null });
  assert.deepEqual([blind.quota.weekBefore, blind.quota.weekAfter, blind.quota.fiveBefore, blind.quota.fiveAfter, blind.quota.ageSeconds], [null, null, null, null, null]);

  // Several result events: the last one counts. Without a transcript the cost is the
  // reported figure, flagged, and usd (the measure by tokens) is unknown.
  const w2 = world({ cfg: { commit: WORK, results: 3, cost: 0.1, noTranscript: true } });
  const l2 = await w2.pass({ ratios });
  assert.equal(l2.cost.usd, null);
  assert.equal(l2.cost.fromReported, true);
  assert.equal(l2.cost.usdReported, 0.1 * 3);
  assert.equal(l2.cost.weekPts, 0.1 * 3 * 0.4);
  assert.equal(l2.cost.fiveHourPts, 0.1 * 3 * 3);
  // No transcript and no figure: the bound, not zero.
  const w4 = world({ cfg: { commit: WORK, noTranscript: true, results: 0 } });
  const l4 = await w4.pass({ ratios });
  assert.equal(l4.cost.bound, true);
  assert.equal(l4.cost.usd, null);
  assert.ok(l4.cost.weekPts > 0);
  // A pass whose main did not advance is not "done".
  const w3 = world({ cfg: {} });
  assert.equal((await w3.pass()).outcome, "no-merge");
});

test("T2 an init that does not match the organisation is misconfigured and the call is killed", async () => {
  const cases = [
    ["a plugin in O0", "O0", { initPlugins: [INLINE] }],
    ["another plugin in O0", "O0", { initPlugins: [{ name: "other", path: "C:\\synthetic\\other", source: "other@market" }] }],
    ["no plugin in O2", "O2", { initPlugins: [] }],
    ["an extra plugin in O2", "O2", { initPlugins: [INLINE, { name: "other", path: "C:\\synthetic\\other", source: "other@market" }] }],
    ["microverse@microverse alone in O2", "O2", { initPlugins: [{ name: "microverse", path: "C:\\synthetic\\cache", source: "microverse@microverse", version: "0.6.0" }] }],
    ["the inline copy and the installed copy in O2", "O2", { initPlugins: [INLINE, { name: "microverse", path: "C:\\synthetic\\cache", source: "microverse@microverse", version: "0.6.0" }] }],
    ["a forbidden skill", "O0", { initSkills: ["pi-ops"] }],
    ["a forbidden plugin skill", "O2", { initPlugins: [INLINE], initSkills: ["x:pi-ops"] }],
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
  const ok = world({ cfg: { initPlugins: [INLINE], commit: WORK } });
  assert.equal((await ok.pass({ orgId: "O2" })).outcome, "done");
  // The inline copy is also recognised by its folder.
  const byPath = world({ cfg: { commit: WORK } });
  byPath.setCfg({ commit: WORK, initPlugins: [{ name: "microverse", path: realpathSync.native(`${byPath.suite.slot}-plugin`), source: "elsewhere" }] });
  assert.equal((await byPath.pass({ orgId: "O2" })).outcome, "done");
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

  // A process on a folder that only starts like the slot is not the slot's.
  const near = [`${where}-plugin`, `${where}2`].map((p) => {
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", p], { stdio: "ignore", windowsHide: true, detached: true });
    c.unref();
    return c;
  });
  await sleep(600);
  try {
    const res2 = await sweep(where);
    assert.deepEqual([res2.killed, res2.left], [0, 0]);
    for (const c of near) assert.doesNotThrow(() => process.kill(c.pid, 0), "still running");
  } finally {
    for (const c of near) killTree(c.pid);
  }
});

test("T3b a failed process listing keeps the line, the diff and the rest of the pass", async () => {
  const w = world({ cfg: { commit: WORK, cost: 0.5 } });
  const line = await w.pass({ listProcesses: () => { throw new Error("cannot read C:\\secret\\place"); } });
  assert.equal(line.leftover, null);
  assert.equal(line.killed, null);
  assert.equal(line.sweepError, "process listing failed");
  assert.ok(!JSON.stringify(line).includes("secret"), "no path in the line");
  assert.equal(line.diff.files, 1, "the diff is kept after the failed sweep");
  assert.ok(line.cost.usd > 0 && line.quality, "graded and costed");
  assert.deepEqual(w.passes(), [line]);
});

test("T4 the spend cap stops the campaign with its reason, a stale quota reading is ignored, and a relaunch resumes", async () => {
  const w = world({ cfg: { commit: WORK, cost: 0.5, noTranscript: true }, patch: (raw) => delete raw.judge });
  // The launch needs one fresh reading; every later one is stale and ignored.
  const staleAfterFirst = () => {
    let n = 0;
    return () => (n++ === 0 ? fresh()() : { counters: { five: { used: 99, observedAt: Date.now() - 3 * 3600 * 1000 }, week: { used: 99, observedAt: Date.now() - 3 * 3600 * 1000 } } });
  };
  // Each pass costs 5 points of week against a cap of 10: the third is refused.
  const first = await w.campaign({ passes: 2, capWeek: 10, quota: staleAfterFirst() });
  assert.equal(first.stopped, "week cap");
  assert.equal(w.passes().length, 2);
  assert.ok(w.passes().every((p) => p.campaign === "camp-1" && p.pass === 1 && p.quota.weekBefore === null), "stale readings are null in the line");
  assert.equal(first.lines.filter((l) => /^t1 O[02] done /.test(l)).length, 2);
  const before = readFileSync(join(w.camp, "passes.jsonl"), "utf8");
  assert.equal(w.calls().length, 2);

  const second = await w.campaign({ passes: 2, capWeek: 100, quota: staleAfterFirst() });
  assert.equal(second.stopped, null);
  assert.equal(w.passes().length, 4);
  assert.deepEqual(w.passes().slice(2).map((p) => p.pass), [2, 2], "the pass index counts within the cell");
  assert.equal(readFileSync(join(w.camp, "passes.jsonl"), "utf8").startsWith(before), true, "the first two lines are not redone");
  assert.equal(w.calls().length, 4);
  const cells = w.passes().map((p) => `${p.task}${p.org}`).sort();
  assert.deepEqual(cells, ["t1O0", "t1O0", "t1O2", "t1O2"]);

  // A fresh reading above the five-hour cap stops before any call.
  const w2 = world({ cfg: { commit: WORK, noTranscript: true }, patch: (raw) => delete raw.judge });
  const high = await w2.campaign({ passes: 1, quota: fresh(95, 0) });
  assert.match(high.stopped, /five-hour cap/);
  assert.equal(w2.calls().length, 0);
});

test("T4b the launch needs a fresh reading and a week margin that covers the cap", async () => {
  const w = world({ cfg: { commit: WORK, cost: 0.1, noTranscript: true }, patch: (raw) => delete raw.judge });
  const old = Date.now() - 3600 * 1000;
  const stale = () => ({ counters: { five: { used: 1, observedAt: old }, week: { used: 1, observedAt: old } } });
  const noWeek = () => ({ counters: { five: { used: 1, observedAt: Date.now() } } });
  for (const [name, quota] of [["absent", () => null], ["stale", stale], ["without the week counter", noWeek]]) {
    await assert.rejects(() => w.campaign({ capWeek: 10, quota }), /no fresh orch-quota reading/, name);
  }
  // 100 - 95 = 5 points left against a cap of 10: refused, both numbers named.
  await assert.rejects(() => w.campaign({ capWeek: 10, quota: fresh(5, 95) }), /5\.0%.*10%/);
  assert.equal(w.calls().length, 0);
  assert.ok(!existsSync(join(w.camp, "passes.jsonl")));
  assert.ok(!existsSync(join(w.camp, "campaign.lock")), "no lock left by a refusal");
  // Exactly enough margin is accepted.
  const ok = await w.campaign({ capWeek: 10, quota: fresh(5, 90) });
  assert.equal(ok.ran, 2);
});

test("T4c the lock: a live holder refuses, a dead one is taken over, an unreadable one is left alone", async () => {
  const w = world({ cfg: {} });
  const lock = join(w.dir, "x.lock");
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  writeFileSync(lock, String(live.pid));
  assert.throws(() => takeLock(lock), /another campaign/);
  assert.equal(readFileSync(lock, "utf8"), String(live.pid), "a live holder keeps its lock");
  live.kill();
  await new Promise((r) => live.on("exit", r));
  takeLock(lock);
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
  for (const content of ["abc", "", "12abc", "-5", "1.5"]) {
    writeFileSync(lock, content);
    assert.throws(() => takeLock(lock), /lock file unreadable, remove it by hand/, JSON.stringify(content));
    assert.equal(readFileSync(lock, "utf8"), content, "not taken over");
  }
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

// A suite shape for settingsFor, with a plugin `bin` folder in a temp dir.
function settingsWorld(binNames) {
  const dir = tmp("bench-settings-");
  const slot = join(dir, "slot").replace(/\\/g, "/");
  if (binNames) {
    mkdirSync(join(`${slot}-plugin`, "bin"), { recursive: true });
    for (const n of binNames) writeFileSync(join(`${slot}-plugin`, "bin", n), "");
    writeManifest(slot, MANIFEST);
  }
  const suite = {
    slot, source: "/src/main", install: ["npm ci --ignore-scripts"], forbiddenPaths: ["/data/backups", "/data/other"],
    organisations: { O0: { plugin: false, advisor: true }, O2: { plugin: true, advisor: false } },
  };
  return { suite, slot };
}
const TRUSTED = { setup: ["npm ci", "npm run build:deps"], checks: ["npm run typecheck", "npm test", "npx biome check .", "npm run build"] };
const DENY_BEFORE = (src, forbidden) => [
  "Bash(ssh:*)", "Bash(scp:*)", "Bash(docker:*)", "Bash(psql:*)", "Bash(git push:*)", "Bash(npm run deploy:*)",
  "Bash(npm run step:*)", "Bash(npm run db:*)", "Bash(curl:*)",
  `Read(${src}/**)`, `Edit(${src}/**)`,
  ...forbidden.flatMap((p) => [`Read(${p}/**)`, `Edit(${p}/**)`]),
  "Read(~/.claude/projects/**)",
];

test("P1 without plugin: the approved checks and setup, the read tools, no orch- entry", () => {
  const { suite } = settingsWorld(null);
  const { allow } = settingsFor(suite, "O0", TRUSTED).permissions;
  for (const e of ["Bash(npx biome check .)", "Bash(npx biome check .:*)", "Bash(npm run typecheck:*)", "Bash(npm run build:*)", "Bash(grep:*)", "Bash(tail:*)", "Bash(head:*)", "Bash(wc:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(ls:*)"]) assert.ok(allow.includes(e), e);
  for (const c of TRUSTED.setup) assert.equal(allow.filter((a) => a === `Bash(${c})`).length, 1, c);
  assert.ok(!allow.includes("Bash(npm run build:deps:*)"), "setup commands get no prefix form");
  assert.ok(!allow.some((a) => a.startsWith("Bash(orch-")));
  for (const never of ["cat", "find", "sed", "awk", "xargs", "tee", "curl"]) assert.ok(!allow.includes(`Bash(${never}:*)`), never);
});

test("P2 with plugin: bare names and full paths from the folder, orch-trust only in its read forms, orch-speak never", () => {
  const { suite, slot } = settingsWorld(["agent-check", "orch-quota", "orch-trust", "orch-speak"]);
  const { allow } = settingsFor(suite, "O2", TRUSTED).permissions;
  const bin = `${slot}-plugin/bin`;
  for (const f of ["agent-check", "orch-quota"]) for (const e of [`Bash(${f}:*)`, `Bash(${bin}/${f}:*)`]) assert.ok(allow.includes(e), e);
  for (const e of ["Bash(orch-trust --status)", "Bash(orch-trust --commands:*)", `Bash(${bin}/orch-trust --status)`, `Bash(${bin}/orch-trust --commands:*)`]) assert.ok(allow.includes(e), e);
  for (const e of ["Bash(orch-trust:*)", "Bash(orch-trust)", `Bash(${bin}/orch-trust:*)`, `Bash(${bin}/orch-trust)`, `Bash(${bin}/*)`]) assert.ok(!allow.includes(e), e);
  assert.ok(!allow.some((a) => a.includes("orch-speak")));
  assert.ok(!allow.some((a) => a.includes("\\")), "forward slashes only");
});

test("P3 the deny list and the other settings are those of before, for both arms", () => {
  const { suite } = settingsWorld(["agent-check"]);
  for (const orgId of ["O0", "O2"]) {
    const s = settingsFor(suite, orgId, TRUSTED);
    assert.deepEqual(s.permissions.deny, DENY_BEFORE("/src/main", suite.forbiddenPaths));
    assert.equal(s.autoCompactWindow, 183000);
    assert.equal(s.autoMemoryEnabled, false);
    assert.equal(s.advisorModel, orgId === "O0" ? "opus" : undefined);
  }
});

const ARMS = ["O0", "O2"];

test("T1 echo is allowed in both arms", () => {
  const { suite } = settingsWorld(["agent-check"]);
  for (const o of ARMS) assert.ok(settingsFor(suite, o, TRUSTED).permissions.allow.includes("Bash(echo:*)"), o);
});

test("T2 an npx check opens its tool prefix, tsc stays single", () => {
  const { suite } = settingsWorld(["agent-check"]);
  const trusted = { setup: [], checks: ["npx biome check .", "npx tsc --noEmit"] };
  for (const o of ARMS) {
    const { allow } = settingsFor(suite, o, trusted).permissions;
    assert.ok(allow.includes("Bash(npx biome:*)"), o);
    assert.equal(allow.filter((a) => a === "Bash(npx tsc:*)").length, 1, o);
  }
});

test("T3 no generic npm, npx, pnpm or yarn prefix is ever derived", () => {
  const { suite } = settingsWorld(["agent-check"]);
  const trusted = { setup: [], checks: ["npm run typecheck", "npm run build", "npm test", "pnpm exec foo", "yarn lint", "npx -y foo", "npx biome check ."] };
  const { allow } = settingsFor(suite, "O0", trusted).permissions;
  for (const r of ["Bash(npm run:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(pnpm:*)", "Bash(yarn:*)"]) assert.ok(!allow.includes(r), r);
  // The check's own two forms exist; nothing broader is derived from its flag.
  assert.deepEqual(allow.filter((a) => a.startsWith("Bash(npx -")), ["Bash(npx -y foo)", "Bash(npx -y foo:*)"]);
  for (const r of ["Bash(npm run typecheck)", "Bash(npm run typecheck:*)"]) assert.ok(allow.includes(r), r);
  assert.ok(!allow.some((a) => /^Bash\((npm|npx|pnpm|yarn)( run)?:\*\)$/.test(a)));
  const { suite: s2 } = settingsWorld(["agent-check", "orch-trust"]);
  s2.allowBash = ["npm run lint"];
  assert.ok(!settingsFor(s2, "O2", TRUSTED).permissions.allow.some((a) => /^Bash\((npm|npx|pnpm|yarn)( run)?:\*\)$/.test(a)));
});

test("T4 setup and install commands never give an npx prefix", () => {
  const { suite } = settingsWorld(["agent-check"]);
  suite.install = ["npx foo install"];
  const { allow } = settingsFor(suite, "O0", { setup: ["npx foo setup"], checks: [] }).permissions;
  assert.ok(!allow.includes("Bash(npx foo:*)"));
});

test("T5 allowBash gives two rules per entry in both arms, none when absent", () => {
  const { suite } = settingsWorld(["agent-check"]);
  const before = ARMS.map((o) => settingsFor(suite, o, TRUSTED).permissions.allow);
  suite.allowBash = ["npm run lint", "npm run format"];
  ARMS.forEach((o, i) => {
    const { allow } = settingsFor(suite, o, TRUSTED).permissions;
    const added = allow.filter((a) => !before[i].includes(a));
    assert.deepEqual(added.sort(), ["Bash(npm run format)", "Bash(npm run format:*)", "Bash(npm run lint)", "Bash(npm run lint:*)"], o);
  });
  suite.allowBash = [];
  assert.deepEqual(settingsFor(suite, "O0", TRUSTED).permissions.allow, before[0]);
});

test("T6 suite validation refuses unsafe allowBash entries and names the index", () => {
  const load = (entries) => () => loadSuite(makeSuite({ patch: (r) => (r.allowBash = entries) }).file);
  const refused = ["npm run deploy", "npm run deployment", "npm run db:apply", "npm run step", "curl http://x", "git push", "docker ps", "ssh host", "orch-trust", "node", "npm run", "lint; rm -rf x", "npm run lint && npm run format", "npm run lint | tail", "npm run $X", " npm run lint", "python x.py", "bash -c x", "", 7];
  for (const e of refused) assert.throws(load(["npm run lint", e]), /allowBash\[1\]/, JSON.stringify(e));
  assert.throws(load("npm run lint"), /allowBash/);
  assert.deepEqual(load(["npm run lint", "npm run format", "npm run typecheck"])().allowBash, ["npm run lint", "npm run format", "npm run typecheck"]);
  assert.deepEqual(loadSuite(makeSuite().file).allowBash, []);
});

test("P4 an unapproved profile or a missing bin folder stops the pass before the call", async () => {
  const un = world({ cfg: { commit: WORK }, approve: false });
  await assert.rejects(() => un.pass(), /orch-trust|approved/);
  assert.equal(un.calls().length, 0, "claude was not spawned");
  const nobin = world({ cfg: { commit: WORK } });
  rmSync(join(`${nobin.suite.slot}-plugin`, "bin"), { recursive: true, force: true });
  await assert.rejects(() => nobin.pass({ orgId: "O2" }), /cannot be listed/);
  assert.equal(nobin.calls().length, 0);
  assert.throws(() => settingsFor(settingsWorld(null).suite, "O2", TRUSTED), /cannot be listed/);
});

test("PC1 plugin arm: pluginConfigs has only <name>@inline, manifest defaults, quota_mode off, no key without default", () => {
  const { suite } = settingsWorld(["agent-check"]);
  const { pluginConfigs } = settingsFor(suite, "O2", TRUSTED);
  assert.deepEqual(pluginConfigs, { "demo-plugin@inline": { options: { week_target: 90, label: "x", quota_mode: "off" } } });
});

test("PC2 arm without plugin: no pluginConfigs key", () => {
  const { suite } = settingsWorld(["agent-check"]);
  assert.ok(!("pluginConfigs" in settingsFor(suite, "O0", TRUSTED)));
});

test("PC3 manifest missing, not JSON or without a name: an error naming the file", () => {
  const { suite, slot } = settingsWorld(["agent-check"]);
  const file = `${slot}-plugin/.claude-plugin/plugin.json`;
  const named = (e) => e.message.includes(file) && /misconfigured/.test(e.message);
  rmSync(file);
  assert.throws(() => settingsFor(suite, "O2", TRUSTED), named);
  writeManifest(slot, "{ not json");
  assert.throws(() => settingsFor(suite, "O2", TRUSTED), named);
  writeManifest(slot, { userConfig: {} });
  assert.throws(() => settingsFor(suite, "O2", TRUSTED), named);
  writeManifest(slot, { name: 3 });
  assert.throws(() => settingsFor(suite, "O2", TRUSTED), named);
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
  // Known only once a call resolved the model; the other fields are untouched.
  assert.deepEqual(m.resolvedModels, { sonnet: "claude-sonnet-5-5" });
  assert.deepEqual(Object.keys(m.prices), ["claude-sonnet-5-5"]);
  assert.ok(m.prices["claude-sonnet-5-5"].length === 5 && m.prices["claude-sonnet-5-5"].every((x) => x > 0), JSON.stringify(m.prices));
  assert.ok(!existsSync(join(w.camp, "manifest.json.tmp")));

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
  await assert.rejects(() => runCampaign({ suite: other.suite, id: "camp-1", campaignDir: w.camp, claude: process.execPath, claudeArgs: [FAKE], projects: w.projects, ratios: RATIOS, allowPort: true, quota: fresh() }), /suite changed/);
});

test("T10 a process left in the slot, a failed sweep or an exception stops the campaign and the summary is still printed", async () => {
  const slotOf = (w) => realpathSync.native(w.suite.slot);
  // A process that the kills cannot reach (here a pid that does not exist) and that still holds the slot.
  const stuck = (w) => () => [{ pid: 99999999, ppid: 1, name: "node", line: `node ${slotOf(w)}\\work.js` }];
  const w = world({ cfg: { commit: WORK, cost: 0.1 } });
  const left = await w.campaign({ passes: 1, capWeek: 100, listProcesses: stuck(w) });
  assert.equal(left.stopped, "processes left in the slot (1)");
  assert.equal(w.passes().length, 1, "no pass after it");
  assert.equal(w.passes()[0].leftover, 1);
  assert.ok(left.lines.includes("stopped: processes left in the slot (1)"));
  assert.match(left.lines.at(-1), /judgeable pass/, "the summary is printed");
  assert.ok(!existsSync(join(w.camp, "campaign.lock")));

  const f = world({ cfg: { commit: WORK, cost: 0.1 } });
  const failed = await f.campaign({ passes: 1, capWeek: 100, listProcesses: () => { throw new Error("no list"); } });
  assert.match(failed.stopped, /^sweep failed/);
  assert.equal(f.passes().length, 1);
  assert.equal(f.passes()[0].leftover, null);
  assert.match(failed.lines.at(-1), /judgeable pass/);

  // runPass throwing (the plugin folder of O2 is gone) does not skip the summary or leave the lock.
  const t = world({ cfg: { commit: WORK } });
  rmSync(`${t.suite.slot}-plugin`, { recursive: true, force: true });
  const thrown = await t.campaign({ passes: 1, capWeek: 100, orgs: ["O2"] });
  assert.match(thrown.stopped, /^error: .*plugin/);
  assert.equal(thrown.ran, 0);
  assert.ok(thrown.lines.includes(`stopped: ${thrown.stopped}`));
  assert.match(thrown.lines.at(-1), /judgeable pass/);
  assert.ok(!existsSync(join(t.camp, "campaign.lock")));
});

test("T11 a relaunch retries the cells whose pass was misconfigured or never started", async () => {
  const w = world({ cfg: { initSkills: ["pi-ops"], hang: true }, patch: (raw) => delete raw.judge });
  const bad = await w.campaign({ passes: 1, capWeek: 100, orgs: ["O0"], timeoutMinutes: 0.3 });
  assert.match(bad.stopped, /^misconfigured/);
  assert.equal(w.passes().length, 1);
  // The configuration is fixed: the cell is run again, as the first counted pass.
  w.setCfg({ commit: WORK, cost: 0.1 });
  const again = await w.campaign({ passes: 1, capWeek: 100, orgs: ["O0"] });
  assert.equal(again.ran, 1);
  assert.deepEqual(w.passes().map((p) => [p.outcome, p.pass]), [["misconfigured", 1], ["done", 1]]);
  // Counted now: a third launch has nothing to do.
  assert.equal((await w.campaign({ passes: 1, capWeek: 100, orgs: ["O0"] })).ran, 0);

  // Same for a call that never started; its (zero) cost stays in the file.
  const n = world({ cfg: { commit: WORK, cost: 0.1 }, patch: (raw) => delete raw.judge });
  mkdirSync(n.camp, { recursive: true });
  const never = { schema: 1, task: "t1", org: "O0", session: "s0", startedAt: new Date().toISOString(), minutes: 0, outcome: "error", cost: { usd: 0, weekPts: 0, fiveHourPts: 0, neverStarted: true } };
  writeFileSync(join(n.camp, "passes.jsonl"), `${JSON.stringify(never)}\n`);
  const run = await n.campaign({ passes: 1, capWeek: 100, orgs: ["O0"] });
  assert.equal(run.ran, 1);
  assert.equal(n.passes().length, 2);
});
