"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { ROOT, commitFile, emptyHome, git, makeRepo } = require("./helpers.js");
const { prepare } = require("../tools/bench/copy.js");
const { grade } = require("../tools/bench/grade.js");
const { ANONYMISER, PATTERNS, anonymise, keepDiff } = require("../tools/bench/diff.js");
const { judgeCampaign, prepareJudgeDir, validateOutput, loadRubric } = require("../tools/bench/judge.js");
const { guard, spent } = require("../tools/bench/spend.js");
const { loadSuite } = require("../tools/bench/suite.js");

// profileTrust reads the approval store of the home it is run under.
process.env.HOME = emptyHome;
process.env.USERPROFILE = emptyHome;

const FAKE = join(ROOT, "tests", "fixtures", "fake-claude-judge.js");
const RATIOS = { ratio7: 10, ratio5: 100 };
const temps = [];
test.after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const tmp = (prefix) => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
const sha = (t) => createHash("sha256").update(t).digest("hex");
const head = (cwd) => git(cwd, "rev-parse", "HEAD").out.trim();
const commit = (cwd, msg) => git(cwd, "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "commit", "-qm", msg);
const jsonl = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const ORACLE = `const test = require("node:test");
const assert = require("node:assert/strict");
test("src answers 2", () => assert.equal(require("./src.js")(), 2));
`;
const node = (code) => `node -e "${code}"`;

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

const BRIEF = "# Task\n\nMake src.js answer 2.\n";

// A suite with a `judge` field whose fake `claude` is driven by files in its folder.
function makeSuite({ patch = () => {} } = {}) {
  const src = source();
  const dir = tmp("bench-judge-");
  writeFileSync(join(dir, "state.md"), "# State\n\nsynthetic\n");
  writeFileSync(join(dir, "t1.md"), BRIEF);
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
      O0: { plugin: false, advisor: true, organisation: null, maxBudgetUsd: 3, estimateUsd: 2, p90Usd: 3 },
      O2: { plugin: true, advisor: true, organisation: { name: "O2", review: "never", council: [] }, maxBudgetUsd: 4, estimateUsd: 2.7, p90Usd: 4 },
    },
    judge: { model: "opus", effort: "high", cwd: join(dir, "judge"), rubric: "r1", estimateUsd: 0.3, p90Usd: 0.6, maxBudgetUsd: 1 },
    tasks: [{ id: "t1", fork: src.fork, tip: src.tip, merge: src.merge, brief: "t1.md", oracle: ["oracle.test.js"], zone: ["src.js"] }],
  };
  patch(raw);
  const file = join(dir, "suite.json");
  writeFileSync(file, JSON.stringify(raw));
  return { file, dir, raw };
}

// What `validate` leaves for the task, written directly.
function approve(suite) {
  mkdirSync(suite.results, { recursive: true });
  writeFileSync(join(suite.results, "validate.json"), JSON.stringify({ t1: { fork: suite.tasks[0].fork, tip: suite.tasks[0].tip, ok: true, checks: { tests: true, lint: false } } }));
  return suite;
}

const diffOf = (n) =>
  `diff --git a/src.js b/src.js\nindex 1111111..2222222 100644\n--- a/src.js\n+++ b/src.js\n@@ -1 +1 @@\n-module.exports = () => 1;\n+module.exports = () => ${n};\n`;

// A campaign with the fake model; `passes` are { session, n } (n picks the diff).
function world({ cfg = {}, passes = [{ session: "aaaaaaaa-1111-4111-8111-000000000001", n: 2 }], patch } = {}) {
  const s = makeSuite({ patch });
  const suite = approve(loadSuite(s.file));
  const camp = join(suite.results, "camp-id-1");
  mkdirSync(join(camp, "diffs"), { recursive: true });
  const w = { suite, camp, dir: s.dir, projects: join(s.dir, "projects"), home: tmp("bench-home-"), log: join(s.dir, "fake.log"), cfgFile: join(s.dir, "fake.json") };
  w.setCfg = (c) => writeFileSync(w.cfgFile, JSON.stringify(c));
  w.setCfg(cfg);
  w.addPass = ({ session, n = 2, text = diffOf(n), ...more }) => {
    const file = `diffs/${session}.diff`;
    writeFileSync(join(camp, file), text);
    const line = {
      schema: 1, session, task: "t1", org: "O2", fork: suite.tasks[0].fork, tip: suite.tasks[0].tip, startedAt: new Date(Date.now() - 60000).toISOString(),
      minutes: 4242, outcome: "delivered", cost: { usd: 1.5, weekPts: 0.01, fiveHourPts: 0.1 }, diff: { file, sha256: sha(text), bytes: text.length, files: 1 }, ...more,
    };
    appendFileSync(join(camp, "passes.jsonl"), `${JSON.stringify(line)}\n`);
    return line;
  };
  for (const p of passes) w.addPass(p);
  w.run = (extra = {}) =>
    judgeCampaign({ suite, campaignDir: camp, claude: process.execPath, claudeArgs: [FAKE], projects: w.projects, ratios: RATIOS, home: w.home, seed: "0123456789abcdef", ...extra });
  w.calls = () => jsonl(w.log);
  w.lines = (kind) => jsonl(join(camp, "judge.jsonl")).filter((l) => !kind || l.kind === kind);
  return w;
}

test("T1 keepDiff keeps the diff of a prepared copy under the campaign, writes nothing in the slot, and names its failures", () => {
  const w = world();
  const { suite } = w;
  prepare(suite, "t1");
  writeFileSync(join(suite.slot, "src.js"), "module.exports = () => 2;\n");
  mkdirSync(join(suite.slot, "docs"));
  writeFileSync(join(suite.slot, "docs", "a.md"), "doc\n");
  git(suite.slot, "add", "-A");
  commit(suite.slot, "fix: answer");
  const before = git(suite.slot, "status", "--porcelain", "--untracked-files=all").out;
  const r = keepDiff({ suite, campaignDir: w.camp, session: "s-1" });
  assert.equal(r.diffError, null);
  assert.deepEqual(Object.keys(r.diff).sort(), ["bytes", "file", "files", "sha256"]);
  assert.equal(r.diff.file, "diffs/s-1.diff");
  assert.equal(r.diff.files, 2);
  const bytes = readFileSync(join(w.camp, r.diff.file));
  assert.equal(r.diff.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(r.diff.bytes, bytes.length);
  assert.match(bytes.toString(), /^diff --git a\/docs\/a\.md b\/docs\/a\.md/m);
  assert.equal(git(suite.slot, "status", "--porcelain", "--untracked-files=all").out, before, "the slot is untouched");
  assert.ok(!existsSync(join(suite.slot, "diffs")));

  assert.throws(() => keepDiff({ suite, campaignDir: w.camp, session: "../x" }), /session/);

  // too-large: over 2 MB of diff.
  writeFileSync(join(suite.slot, "big.txt"), "0123456789abcdef\n".repeat(140000));
  git(suite.slot, "add", "-A");
  commit(suite.slot, "chore: big");
  assert.deepEqual(keepDiff({ suite, campaignDir: w.camp, session: "s-2" }), { diff: null, diffError: "too-large" });
  assert.ok(!existsSync(join(w.camp, "diffs", "s-2.diff")));

  // git-error: a base that is not a commit.
  const markerFile = join(suite.slot, ".bench-slot");
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));
  writeFileSync(markerFile, JSON.stringify({ ...marker, base: "0".repeat(40) }));
  assert.deepEqual(keepDiff({ suite, campaignDir: w.camp, session: "s-3" }), { diff: null, diffError: "git-error" });

  // no-marker.
  rmSync(markerFile);
  assert.deepEqual(keepDiff({ suite, campaignDir: w.camp, session: "s-4" }), { diff: null, diffError: "no-marker" });
});

test("T2 a hostile git config of the copy runs nothing, in keepDiff or in grade", () => {
  const w = world();
  const { suite } = w;
  prepare(suite, "t1");
  const witness = join(tmp("bench-wit-"), "ran.txt");
  const script = join(w.dir, "witness.js");
  writeFileSync(script, `require("fs").appendFileSync(${JSON.stringify(witness)}, "ran\\n");`);
  const cmd = `node ${script.replace(/\\/g, "/")}`;
  git(suite.slot, "config", "diff.external", cmd);
  git(suite.slot, "config", "diff.evil.textconv", cmd);
  writeFileSync(join(suite.slot, ".gitattributes"), "*.js diff=evil\n");
  writeFileSync(join(suite.slot, "src.js"), "module.exports = () => 2;\n");
  git(suite.slot, "add", "-A");
  commit(suite.slot, "fix: answer");

  // Control: a plain `git diff` does run the witness, so the test can fail.
  const marker = JSON.parse(readFileSync(join(suite.slot, ".bench-slot"), "utf8"));
  git(suite.slot, "diff", marker.base, "main");
  assert.ok(existsSync(witness), "the hostile config is live");
  rmSync(witness);

  const r = keepDiff({ suite, campaignDir: w.camp, session: "s-1" });
  assert.equal(r.diffError, null);
  assert.match(readFileSync(join(w.camp, r.diff.file), "utf8"), /^\+module\.exports = \(\) => 2;$/m);
  assert.ok(!existsSync(witness), "keepDiff ran the witness");
  grade(suite, "t1");
  assert.ok(!existsSync(witness), "grade ran the witness");
});

// Trigger text for each pattern id, as a line of a diff and as a word of a brief.
const TRIGGERS = {
  morty: "the morty agent",
  rick: "ask rick today",
  council: "council review",
  meeseeks: "one meeseeks",
  microverse: "microverse plugin",
  orchestrat: "orchestration layer",
  worktree: "in a worktree",
  subagent: "a sub-agent",
  orchCommand: "run orch-bench now",
  agentTool: "run agent-check now",
  quotaGuard: "the quota-guard hook",
  claudeDir: "see .claude/rules",
  claudeMd: "read CLAUDE.md first",
  homePath: "C:\\Users\\bob\\proj",
  uuid: "id 123e4567-e89b-12d3-a456-426614174000",
  agentId: "agent-0123456789abcdef",
  conflict: "<<<<<<< HEAD",
};
const sectionOf = (path, added) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n keep line\n${added.map((l) => `+${l}`).join("\n")}\n`;

test("T3 anonymise: one case per pattern, sections and lockfiles dropped, O0 to O3 kept", () => {
  assert.equal(ANONYMISER, "a1");
  assert.deepEqual(Object.keys(TRIGGERS).sort(), Object.keys(PATTERNS).sort(), "the table covers every pattern");
  const slot = "D:\\bench\\work\\slot";
  for (const [id, trigger] of Object.entries(TRIGGERS)) {
    const lineStart = id === "conflict";
    const r = anonymise({ diff: sectionOf("f.txt", [lineStart ? trigger : `before ${trigger} after`, "O2 stays"]), brief: lineStart ? trigger : `Brief ${trigger} end`, slot });
    assert.equal(r.status, "ok", id);
    assert.ok(r.input.includes("keep line") && r.input.includes("+O2 stays"), id);
    assert.ok(!r.input.includes(trigger), `${id}: the trigger is gone`);
    assert.ok(r.input.includes("[redacted]"), `${id}: the brief is redacted`);
    assert.ok(r.redactions.words[id] >= 1, `${id}: counted as a dropped line`);
    assert.ok(r.redactions.brief[id] >= 1, `${id}: counted in the brief`);
  }
  // Case does not matter.
  assert.ok(!anonymise({ diff: sectionOf("f.txt", ["MORTY here"]), brief: "x", slot }).input.includes("MORTY"));
  // O0 to O3 are never masked; "brick" is not "rick".
  const keep = anonymise({ diff: sectionOf("f.txt", ["O0 O1 O2 O3 brick"]), brief: "O0 and O3 and brick", slot });
  assert.ok(keep.input.includes("+O0 O1 O2 O3 brick") && keep.input.includes("O0 and O3 and brick"));
  // The slot path, as written and with other separators and case.
  for (const form of [slot, slot.replace(/\\/g, "/"), slot.toLowerCase(), `${slot}-plugin\\x`]) {
    const r = anonymise({ diff: sectionOf("f.txt", [`at ${form} ok`]), brief: `in ${form}`, slot });
    assert.ok(!r.input.toLowerCase().includes("bench"), form);
  }
  // Sections: working files, a file named after a pattern, transcripts, index lines.
  const diff = [
    sectionOf(".claude/rules.md", ["rules"]),
    sectionOf(".claude-plugin/plugin.json", ["{}"]),
    sectionOf("notes/n.md", ["note"]),
    sectionOf("CLAUDE.md", ["memory"]),
    sectionOf("morty.js", ["ordinary"]),
    sectionOf("t.jsonl", ['{"sessionId":"x"}']),
    sectionOf("package-lock.json", ["a", "b"]).replace("-1 +1,2", "-1 +1,2"),
    sectionOf("ok.js", ["kept"]),
  ].join("");
  const r = anonymise({ diff, brief: "b", slot });
  assert.equal(r.status, "ok");
  for (const gone of ["rules", "plugin.json", "note", "memory", "morty.js", "sessionId"]) assert.ok(!r.input.includes(gone), gone);
  assert.ok(r.input.includes("[lockfile: +2 -0 lines]") && !r.input.includes("package-lock"));
  assert.ok(r.input.includes("+kept") && !/^index /m.test(r.input));
  assert.deepEqual(
    { c: r.redactions.dropped.claudeDir, p: r.redactions.dropped.claudePlugin, n: r.redactions.dropped.notes, w: r.redactions.dropped.workFile, l: r.redactions.dropped.lockfile, t: r.redactions.dropped.transcript, h: r.redactions.dropped.headerPattern },
    { c: 1, p: 1, n: 1, w: 1, l: 1, t: 1, h: 1 },
  );
  // Only counters, never the matched text.
  assert.doesNotMatch(JSON.stringify(r.redactions), /bob|morty\.js/);
});

test("T4 anonymise fails closed and refuses an input over 150000 characters; the judge is not called", () => {
  const slot = "D:\\bench\\work\\slot";
  const forged = anonymise({ diff: sectionOf("f.txt", ["fine"]), brief: "clean", slot, afterReplace: "\nmorty slipped through" });
  assert.deepEqual({ s: forged.status, i: forged.input }, { s: "anonymisation-failed", i: null });
  // A check name is part of the input too.
  assert.equal(anonymise({ diff: sectionOf("f.txt", ["fine"]), brief: "clean", checks: { "council-check": true }, slot }).status, "anonymisation-failed");
  const big = anonymise({ diff: sectionOf("f.txt", Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(40)}`)), brief: "clean", slot });
  assert.deepEqual({ s: big.status, i: big.input }, { s: "too-large", i: null });

  // In the command: no call, a judgment with the status and a link, no cost.
  const w = world({ passes: [{ session: "aaaaaaaa-1111-4111-8111-000000000001", text: sectionOf("src.js", Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(40)}`)) }] });
  return w.run().then((res) => {
    assert.equal(w.calls().length, 0);
    assert.deepEqual(res.judgments.map((j) => j.status), ["too-large"]);
    assert.equal(w.lines("judgment")[0].cost, null);
    assert.equal(w.lines("link").length, 1);
  });
});

test("T5 the judge sees the brief, the checks and the diff and nothing of the pass or the campaign", async () => {
  const sessions = ["bbbbbbbb-2222-4222-8222-000000000001", "bbbbbbbb-2222-4222-8222-000000000002"];
  const w = world({ passes: [{ session: sessions[0], n: 3, org: "O2", minutes: 4242 }] });
  await w.run();
  const [call] = w.calls();
  const p = jsonl(join(w.camp, "passes.jsonl"))[0];
  const witnesses = [sessions[0], p.fork, p.tip, "4242", "1.5", "camp-id-1", "synthetic"];
  const haystack = { stdin: call.stdin, env: JSON.stringify(call.env), cwd: call.cwd };
  for (const [where, text] of Object.entries(haystack)) {
    for (const x of witnesses) assert.ok(!text.includes(x), `${x} leaked into ${where}`);
  }
  // Args: the settings file lives in the campaign folder, which the brief fixes; nothing else of the pass.
  const argv = call.args.filter((a) => a !== call.args[call.args.indexOf("--settings") + 1]);
  for (const x of witnesses) assert.ok(!argv.join("\n").includes(x), `${x} leaked into the arguments`);
  assert.deepEqual([...call.stdin.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ["Task", "Checks", "Submission"]);
  assert.match(call.stdin, /- lint: false\n- tests: true/);
  assert.match(call.stdin, /\+module\.exports = \(\) => 3;/);
  assert.equal(call.cwd, realpathSync.native(w.suite.judge.cwd));
  assert.notEqual(call.args[call.args.indexOf("--session-id") + 1], sessions[0]);
});

test("T6 the call is launched with the options of the brief and no others", async () => {
  const w = world({ passes: [{ session: "cccccccc-3333-4333-8333-000000000001", n: 2 }, { session: "cccccccc-3333-4333-8333-000000000002", n: 3 }] });
  const rubric = loadRubric("r1");
  await w.run();
  const calls = w.calls();
  assert.equal(calls.length, 2);
  const ids = [];
  for (const c of calls) {
    const a = c.args;
    const at = (flag) => a[a.indexOf(flag) + 1];
    assert.deepEqual(a.slice(0, 2), ["-p", "Score the submission given on standard input."]);
    assert.equal(at("--model"), "opus");
    assert.equal(at("--effort"), "high");
    assert.equal(a[a.indexOf("--tools") + 1], "", "an empty --tools");
    assert.ok(a.includes("--disable-slash-commands") && a.includes("--strict-mcp-config") && a.includes("--verbose"));
    assert.equal(at("--system-prompt-file"), rubric.mdFile);
    assert.equal(at("--json-schema"), rubric.schemaText);
    assert.equal(at("--setting-sources"), "project,local");
    assert.equal(at("--permission-mode"), "dontAsk");
    assert.equal(at("--output-format"), "stream-json");
    assert.equal(at("--max-budget-usd"), "1");
    assert.match(at("--session-id"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    ids.push(at("--session-id"));
    assert.deepEqual(JSON.parse(readFileSync(at("--settings"), "utf8")), { autoMemoryEnabled: false });
    assert.equal(dirname(at("--settings")), w.camp);
    for (const never of ["--max-turns", "--no-session-persistence", "--plugin-dir"]) assert.ok(!a.includes(never), never);
    assert.match(c.stdin, /^## Task/);
  }
  assert.notEqual(ids[0], ids[1], "one session per call");
  await assert.rejects(() => w.run({ claude: "C:\\tools\\claude.cmd" }), /\.cmd|shell/);
  await assert.rejects(() => w.run({ claude: "claude.BAT" }), /\.cmd|shell/);
});

test("T7 a call that is not configured as asked is misconfigured and stops the command", async () => {
  const two = [{ session: "dddddddd-4444-4444-8444-000000000001", n: 2 }, { session: "dddddddd-4444-4444-8444-000000000002", n: 3 }];
  const cases = {
    "a tool beyond StructuredOutput": { tools: ["StructuredOutput", "Read"] },
    "no StructuredOutput": { tools: [] },
    "an MCP server": { mcp: [{ name: "x", status: "connected" }] },
    "a microverse plugin by name": { plugins: [{ name: "microverse", path: "p" }] },
    "a microverse plugin by source": { plugins: [{ name: "x", source: "git://example.invalid/microverse@main" }] },
    "another model": { initModel: "claude-sonnet-5-5" },
    "an instructions file loaded": { attachFiles: true },
    "a role other than the orchestrator": { subagent: "morty" },
    "a file written in the judge folder": { writeFile: true },
    "no transcript": { noTranscript: true },
  };
  for (const [name, cfg] of Object.entries(cases)) {
    const w = world({ cfg, passes: two });
    const res = await w.run();
    assert.equal(res.judgments[0].status, "misconfigured", name);
    assert.match(res.stopped, /misconfigured/, name);
    assert.equal(w.calls().length, 1, `${name}: stops at the first`);
    assert.equal(w.lines("link").length, 0, `${name}: no link`);
    assert.ok(w.lines("judgment")[0].cost, `${name}: the cost stays counted`);
  }
  // The control: the right configuration is accepted.
  const ok = world({ passes: two });
  assert.deepEqual((await ok.run()).judgments.map((j) => j.status), ["ok", "ok"]);
  // The stray file stays (the bench deletes nothing there) and refuses the next run.
  const stray = world({ cfg: { writeFile: true } });
  await stray.run();
  assert.ok(existsSync(join(stray.suite.judge.cwd, "stray.txt")));
  await assert.rejects(() => stray.run(), /besides its marker/);
});

const ANSWER = { rubric: "r1", scores: { fidelity: 5, correctness: 4, tests: 3, clarity: 4, scope: 4 }, defects: [{ criterion: "tests", severity: "major", summary: "no negative case" }, { criterion: "scope", severity: "minor", summary: "stray file" }] };

test("T8 output: the bench computes overall, falls back on result text, validates, retries once", async () => {
  // overall is the mean of the five scores, counts of defects by severity.
  let w = world({ cfg: { answer: ANSWER } });
  let res = await w.run();
  const j = w.lines("judgment")[0];
  assert.equal(res.judgments[0].overall, 4);
  assert.deepEqual({ s: j.status, o: j.overall, sc: j.scores, d: { major: j.defects.major, minor: j.defects.minor } }, { s: "ok", o: 4, sc: ANSWER.scores, d: { major: 1, minor: 1 } });
  assert.equal(j.attempt, 1);

  // No structured_output: the result text is parsed.
  w = world({ cfg: { structured: false, answer: ANSWER } });
  assert.equal((await w.run()).judgments[0].status, "ok");

  // A model-made overall, a score out of range, a wrong const, too many defects, text that is not JSON: invalid, fail closed.
  const bad = {
    overall: { ...ANSWER, overall: 5 },
    range: { ...ANSWER, scores: { ...ANSWER.scores, tests: 6 } },
    float: { ...ANSWER, scores: { ...ANSWER.scores, tests: 3.5 } },
    rubric: { ...ANSWER, rubric: "r2" },
    missing: { rubric: "r1", scores: ANSWER.scores },
    defects: { ...ANSWER, defects: Array.from({ length: 11 }, () => ANSWER.defects[0]) },
    long: { ...ANSWER, defects: [{ ...ANSWER.defects[0], summary: "x".repeat(301) }] },
    enum: { ...ANSWER, defects: [{ ...ANSWER.defects[0], severity: "blocker" }] },
  };
  for (const [name, answer] of Object.entries(bad)) {
    w = world({ cfg: { answer } });
    res = await w.run();
    assert.deepEqual(res.judgments.map((x) => x.status), ["invalid", "invalid"], name);
    assert.equal(w.calls().length, 2, `${name}: one retry only`);
    assert.equal(w.lines("link").length, 1, `${name}: final, linked`);
  }
  w = world({ cfg: { resultText: "not json" } });
  assert.equal((await w.run()).judgments[0].status, "invalid");

  // The retry can succeed; both attempts are recorded.
  w = world({ cfg: { perCall: [{ answer: bad.range }, { answer: ANSWER }] } });
  res = await w.run();
  assert.deepEqual(res.judgments.map((x) => x.status), ["invalid", "ok"]);
  assert.deepEqual(w.lines("judgment").map((l) => l.attempt), [1, 2]);
  assert.equal(w.lines("link").length, 1);

  // Budget and error are not final: no link, the cost stays counted, the pass is judged again.
  for (const cfg of [{ subtype: "error_max_budget_usd" }, { subtype: "error_during_execution" }]) {
    w = world({ cfg });
    res = await w.run();
    assert.notEqual(res.judgments[0].status, "ok");
    assert.equal(w.lines("link").length, 0);
    assert.ok(spent({ campaignDir: w.camp }).weekPts > 0.01, "the call's cost is in the spend");
    w.setCfg({ answer: ANSWER });
    assert.deepEqual((await w.run()).judgments.map((x) => x.status), ["ok"]);
  }
  w = world({ cfg: { subtype: "error_max_budget_usd" } });
  assert.equal((await w.run()).judgments[0].status, "budget");

  // The time limit kills the call.
  w = world({ cfg: { hang: true } });
  res = await w.run({ timeoutMs: 800 });
  assert.equal(res.judgments[0].status, "error");
  assert.equal(w.lines("link").length, 0);
});

test("T9 one judgment per key, links for final statuses only, a seeded order, nothing judged twice", async () => {
  const s = (n) => `eeeeeeee-5555-4555-8555-00000000000${n}`;
  const w = world({
    cfg: { answer: ANSWER },
    passes: [{ session: s(1), n: 2 }, { session: s(2), n: 2 }, { session: s(3), n: 3 }, { session: s(4), n: 4 }, { session: s(5), n: 5 }, { session: s(6), n: 6 }],
  });
  // Not judgeable: no diff, an empty diff, contaminated, misconfigured.
  w.addPass({ session: s(7), n: 7, diff: null });
  w.addPass({ session: s(8), n: 8, diff: { file: "x", sha256: "0", bytes: 0, files: 0 } });
  w.addPass({ session: s(9), n: 9, outcome: "contaminated" });
  w.addPass({ session: "eeeeeeee-5555-4555-8555-00000000000a", n: 10, outcome: "misconfigured" });
  const first = await w.run({ seed: "aaaaaaaaaaaaaaaa" });
  assert.equal(w.calls().length, 5, "six judgeable passes, two share a diff");
  assert.equal(w.lines("judgment").length, 5);
  assert.equal(w.lines("link").length, 6);
  assert.equal(first.judgments.length, 5);
  const keys = w.lines("judgment").map((l) => l.key);
  assert.equal(new Set(keys).size, 5);
  const shared = w.lines("link").filter((l) => [s(1), s(2)].includes(l.pass));
  assert.equal(shared[0].key, shared[1].key, "two passes, one judgment");
  const run = w.lines("run")[0];
  assert.equal(run.seed, "aaaaaaaaaaaaaaaa");
  assert.deepEqual([...run.order].sort(), [s(1), s(2), s(3), s(4), s(5), s(6)]);
  assert.deepEqual(Object.keys(run).filter((k) => ["anonymiser", "rubric", "rubricSha", "schemaSha", "model", "effort"].includes(k)).length, 6);
  // The calls follow the recorded order (first pass of each key).
  const wanted = [];
  for (const sess of run.order) {
    const k = w.lines("link").find((l) => l.pass === sess).key;
    if (!wanted.includes(k)) wanted.push(k);
  }
  assert.deepEqual(keys, wanted);

  // The same seed gives the same order; a random seed is 16 hex characters.
  const order = (seed) => world({ cfg: { answer: ANSWER }, passes: [1, 2, 3, 4, 5, 6].map((n) => ({ session: s(n), n })) }).run({ seed }).then((r) => r.judgments.length);
  await order("aaaaaaaaaaaaaaaa");
  const x = world({ cfg: { answer: ANSWER }, passes: [1, 2, 3, 4, 5, 6].map((n) => ({ session: s(n), n })) });
  await x.run({ seed: "aaaaaaaaaaaaaaaa" });
  assert.deepEqual(x.lines("run")[0].order, run.order.filter((o) => [s(1), s(2), s(3), s(4), s(5), s(6)].includes(o)).length === 6 ? x.lines("run")[0].order : []);
  const y = world({ cfg: { answer: ANSWER }, passes: [1, 2, 3, 4, 5, 6].map((n) => ({ session: s(n), n })) });
  await y.run({ seed: "bbbbbbbbbbbbbbbb" });
  const z = world({ cfg: { answer: ANSWER }, passes: [1, 2, 3, 4, 5, 6].map((n) => ({ session: s(n), n })) });
  await z.run({ seed: "aaaaaaaaaaaaaaaa" });
  assert.deepEqual(z.lines("run")[0].order, x.lines("run")[0].order);
  assert.notDeepEqual(y.lines("run")[0].order, x.lines("run")[0].order);
  const r = world({ cfg: { answer: ANSWER } });
  await r.run({ seed: undefined });
  assert.match(r.lines("run")[0].seed, /^[0-9a-f]{16}$/);

  // Re-run: nothing to judge, no call, no new line.
  const lines = w.lines().length;
  const again = await w.run();
  assert.equal(w.calls().length, 5);
  assert.equal(again.judgments.length, 0);
  assert.equal(w.lines().length, lines);

  // A new rubric (or anonymiser) rejudges everything; the old lines stay.
  const rubrics = tmp("bench-rubric-");
  writeFileSync(join(rubrics, "r1.md"), `${readFileSync(join(ROOT, "tools", "bench", "rubric", "r1.md"), "utf8")}\nBe strict.\n`);
  writeFileSync(join(rubrics, "r1.schema.json"), readFileSync(join(ROOT, "tools", "bench", "rubric", "r1.schema.json")));
  await w.run({ rubricDir: rubrics });
  assert.equal(w.calls().length, 10);
  assert.equal(w.lines("judgment").length, 10);
  await w.run({ anonymiser: "a2" });
  assert.equal(w.calls().length, 15);
  assert.equal(w.lines("judgment").length, 15);
  assert.equal((await w.run({ anonymiser: "a2" })).judgments.length, 0);
});

test("T10 spend sums passes and judgments, unknown is not zero, and the guard checks each cap", async () => {
  const w = world({ passes: [] });
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  w.addPass({ session: "ffffffff-6666-4666-8666-000000000001", startedAt: iso(60 * 60000), minutes: 30, cost: { weekPts: 10, fiveHourPts: 100 } });
  // Finished more than 5 hours ago: in the week, out of the five-hour window.
  w.addPass({ session: "ffffffff-6666-4666-8666-000000000002", startedAt: iso(9 * 3600000), minutes: 60, cost: { weekPts: 7, fiveHourPts: 70 } });
  appendFileSync(join(w.camp, "judge.jsonl"), `${JSON.stringify({ kind: "judgment", startedAt: iso(120000), seconds: 60, cost: { weekPts: 0.5, fiveHourPts: 5 } })}\n`);
  appendFileSync(join(w.camp, "judge.jsonl"), `${JSON.stringify({ kind: "judgment", startedAt: iso(0), seconds: 0, cost: null })}\n`);
  appendFileSync(join(w.camp, "judge.jsonl"), `${JSON.stringify({ kind: "link", pass: "ffffffff-6666-4666-8666-000000000001", key: "k" })}\n`);
  assert.deepEqual(spent({ campaignDir: w.camp, now }), { weekPts: 17.5, fiveHourPts: 105, unjudged: 1 });
  // A pass without a figure makes the spend unknown, not smaller.
  w.addPass({ session: "ffffffff-6666-4666-8666-000000000003", cost: null });
  const unknown = spent({ campaignDir: w.camp, now });
  assert.deepEqual({ w: unknown.weekPts, f: unknown.fiveHourPts }, { w: null, f: null });
  assert.deepEqual(guard({ spent: unknown, nextUsd: 0.1, ratios: RATIOS, capWeek: 1000, capFive: 1000 }), { ok: false, reason: "spend unknown" });

  const sp = { weekPts: 50, fiveHourPts: 60, unjudged: 0 };
  const g = (over) => guard({ spent: sp, reserveUsd: 0, nextUsd: 1, ratios: { ratio7: 10, ratio5: 20 }, capWeek: 100, capFive: 100, ...over });
  assert.deepEqual(g({}), { ok: true, reason: null });
  assert.equal(g({ capWeek: 59.9 }).reason, "week cap");
  assert.equal(g({ capWeek: 60 }).ok, true, "exactly the cap is allowed");
  assert.equal(g({ reserveUsd: 5, capWeek: 100 }).reason, "week cap (judge reserve)");
  assert.equal(g({ reserveUsd: 4, capWeek: 100 }).ok, true);
  assert.equal(g({ capFive: 79.9 }).reason, "five-hour cap");
  assert.equal(g({ ratios: { ratio7: 10, ratio5: null } }).reason, "no ratio");
  assert.equal(g({ ratios: { ratio7: 0, ratio5: 20 } }).reason, "no ratio");
  assert.equal(g({ ratios: null }).reason, "no ratio");

  // In the command: the guard runs before each call with the next call's p90 (0.6 usd = 6 points).
  const s = (n) => `99999999-7777-4777-8777-00000000000${n}`;
  const run = world({ passes: [{ session: s(1), n: 2 }, { session: s(2), n: 3 }, { session: s(3), n: 4 }] });
  let res = await run.run({ capWeek: 6.05 });
  assert.equal(res.stopped, "week cap");
  assert.equal(run.calls().length, 1, "the first fits, the second would not");
  assert.equal(res.judgments.length, 1);
  const none = world();
  assert.equal((await none.run({ capWeek: 5 })).stopped, "week cap");
  assert.equal(none.calls().length, 0);
  const five = world();
  assert.equal((await five.run({ capFive: 50 })).stopped, "five-hour cap");
  // A missing ratio refuses to start.
  await assert.rejects(() => none.run({ ratios: { ratio7: null, ratio5: 100 } }), /ratio/);
  res = await run.run();
  assert.equal(res.stopped, null);
});

test("T11 the judge folder: created with its marker, kept clean, never deleted from, away from repositories, the home and the memory files", async () => {
  const dirFor = (judgeCwd) => {
    const w = world({ patch: (r) => (r.judge.cwd = judgeCwd(r)) });
    return w;
  };
  // Absent: created with its marker and nothing else.
  let w = dirFor((r) => join(dirname(r.slot), "fresh", "judge"));
  const made = prepareJudgeDir(w.suite, { home: w.home });
  assert.deepEqual(readdirSync(made), [".bench-judge"]);
  // Present with its marker: accepted. Extra content: refused and left in place.
  assert.equal(prepareJudgeDir(w.suite, { home: w.home }), made);
  writeFileSync(join(made, "leftover.txt"), "x");
  assert.throws(() => prepareJudgeDir(w.suite, { home: w.home }), /besides its marker/);
  assert.ok(existsSync(join(made, "leftover.txt")), "the bench deletes nothing there");

  // Non-empty without a marker.
  w = dirFor((r) => join(dirname(r.slot), "other"));
  mkdirSync(w.suite.judge.cwd, { recursive: true });
  writeFileSync(join(w.suite.judge.cwd, "mine.txt"), "x");
  assert.throws(() => prepareJudgeDir(w.suite, { home: w.home }), /no \.bench-judge marker/);
  assert.ok(existsSync(join(w.suite.judge.cwd, "mine.txt")));

  // Inside a git repository.
  w = dirFor((r) => join(dirname(r.slot), "repo", "judge"));
  mkdirSync(join(dirname(w.suite.slot), "repo"), { recursive: true });
  git(join(dirname(w.suite.slot), "repo"), "init", "-q", "-b", "main", ".");
  assert.throws(() => prepareJudgeDir(w.suite, { home: w.home }), /git repository/);

  // Under the home folder; the home folder itself.
  w = dirFor((r) => join(dirname(r.slot), "judge"));
  mkdirSync(w.suite.judge.cwd, { recursive: true });
  assert.throws(() => prepareJudgeDir(w.suite, { home: dirname(w.suite.slot) }), /home/);
  assert.throws(() => prepareJudgeDir(w.suite, { home: w.suite.judge.cwd }), /home/);

  // Inside or containing slot, results, source.
  for (const [name, pick] of [["slot", (r) => join(r.slot, "j")], ["results", (r) => join(r.results, "j")], ["slot", (r) => r.slot], ["results", (r) => dirname(r.results)]]) {
    w = dirFor(pick);
    mkdirSync(dirname(w.suite.slot), { recursive: true });
    assert.throws(() => prepareJudgeDir(w.suite, { home: tmp("bench-home-") }), new RegExp(`inside or contain ${name}|inside or contain (slot|results)|git repository`), name);
  }
  w = dirFor((r) => join(r.source, "judge"));
  assert.throws(() => prepareJudgeDir(w.suite, { home: w.home }), /source|git repository/);

  // A memory file in the folder or in a parent.
  w = dirFor((r) => join(dirname(r.slot), "mem", "judge"));
  const parent = join(dirname(w.suite.slot), "mem");
  mkdirSync(join(parent, "judge"), { recursive: true });
  writeFileSync(join(parent, "judge", ".bench-judge"), "{}\n");
  for (const [where, rel] of [["judge", "CLAUDE.md"], ["judge", "AGENTS.md"], ["judge", "CLAUDE.local.md"], ["mem", "CLAUDE.md"], ["mem", join(".claude", "CLAUDE.md")]]) {
    const file = join(parent, where === "judge" ? "judge" : "", rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "rules\n");
    assert.throws(() => prepareJudgeDir(w.suite, { home: w.home }), /read as instructions/, `${where}/${rel}`);
    rmSync(file);
  }
  assert.doesNotThrow(() => prepareJudgeDir(w.suite, { home: w.home }));

  // The suite's `judge` field names the faulty field.
  const bad = (edit) => () => loadSuite(makeSuite({ patch: (r) => edit(r.judge) }).file);
  assert.doesNotThrow(bad(() => {}));
  assert.throws(bad((j) => delete j.model), /judge\.model/);
  assert.throws(bad((j) => (j.effort = "")), /judge\.effort/);
  assert.throws(bad((j) => (j.model = "--help")), /judge\.model/);
  assert.throws(bad((j) => (j.rubric = "r0")), /judge\.rubric/);
  assert.throws(bad((j) => (j.p90Usd = -1)), /judge\.p90Usd/);
  assert.throws(bad((j) => (j.estimateUsd = "0.3")), /judge\.estimateUsd/);
  assert.throws(bad((j) => (j.maxBudgetUsd = 0)), /judge\.maxBudgetUsd/);
  assert.throws(bad((j) => (j.timeoutMinutes = 0)), /judge\.timeoutMinutes/);
  assert.throws(bad((j) => delete j.cwd), /judge\.cwd/);
  assert.equal(loadSuite(makeSuite({ patch: (r) => delete r.judge }).file).judge, null);
});

test("the output validator accepts the rubric's schema and refuses what it does not know", () => {
  const { schema } = loadRubric("r1");
  assert.deepEqual(validateOutput(ANSWER, schema), []);
  assert.throws(() => validateOutput({}, { type: "object", pattern: "x" }), /not supported/);
});
