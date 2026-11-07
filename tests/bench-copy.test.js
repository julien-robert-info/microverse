"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, parse } = require("node:path");
const { ROOT, commitFile, emptyHome, git, makeRepo, sh } = require("./helpers.js");
const { prepare } = require("../tools/bench/copy.js");
const { grade, validate } = require("../tools/bench/grade.js");
const { briefFindings, loadSuite } = require("../tools/bench/suite.js");

// profileTrust reads the approval store of the home it is run under.
process.env.HOME = emptyHome;
process.env.USERPROFILE = emptyHome;

const BENCH = join(ROOT, "tools", "bench", "orch-bench.js");
const temps = [];
test.after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const tmp = (prefix) => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};

const ORACLE = `const test = require("node:test");
const assert = require("node:assert/strict");
test("src answers 2", () => assert.equal(require("./src.js")(), 2));
`;
const node = (code) => `node -e "${code}"`;
const head = (cwd) => git(cwd, "rev-parse", "HEAD").out.trim();

// A source repository: C1 (profile, gen.txt), fork (src.js answers 1), tip (src.js
// answers 2, the hidden oracle, tip-only.txt), merge (merge-only.txt).
function makeSource({ envFile = false } = {}) {
  const { dir } = makeRepo({ checks: [{ name: "tests", run: node("process.exit(0)") }, { name: "lint", run: node("process.exit(1)") }] });
  commitFile(dir, "src.js", "module.exports = () => 1;\n", "feat: src");
  if (envFile) commitFile(dir, ".env", "SECRET=1\n", "chore: env");
  const fork = head(dir);
  commitFile(dir, "src.js", "module.exports = () => 2;\n", "fix: src");
  commitFile(dir, "oracle.test.js", ORACLE, "test: oracle");
  commitFile(dir, "tip-only.txt", "later content\n", "feat: later");
  const tip = head(dir);
  commitFile(dir, "merge-only.txt", "merged\n", "chore: merge");
  return { dir, fork, tip, merge: head(dir) };
}

const CLEAN_BRIEF = "# Task\n\nMake src.js answer 2.\n";

// Writes a suite for `src` in a fresh folder; `patch(raw)` edits the raw object before it is written.
function makeSuite(src, { patch = () => {}, tasks } = {}) {
  const dir = tmp("bench-suite-");
  writeFileSync(join(dir, "state.md"), "# State\n\nsynthetic\n");
  const list = tasks ?? [{ id: "t1", fork: src.fork, tip: src.tip, merge: src.merge, brief: "t1.md", oracle: ["oracle.test.js"], zone: ["src.js"] }];
  for (const t of list) writeFileSync(join(dir, t.brief), t.briefText ?? CLEAN_BRIEF);
  const raw = {
    id: "synthetic",
    source: src.dir,
    slot: join(dir, "slot"),
    results: join(dir, "results"),
    forbiddenPaths: ["backups"],
    forbiddenSkills: ["pi-ops"],
    env: { BENCH_FAKE: "yes", DATABASE_URL: "postgres://bench:bench@127.0.0.1:1/bench" },
    install: [],
    oracleCommand: "node --test --test-reporter=tap {files}",
    stateTemplate: "state.md",
    prompts: { O0: "do it", O2: "run it" },
    organisations: {
      O0: { plugin: false, advisor: true, organisation: null, maxBudgetUsd: 3, estimateUsd: 2, p90Usd: 3 },
      O2: { plugin: true, advisor: true, organisation: { name: "O2", review: "never", council: [] }, maxBudgetUsd: 4, estimateUsd: 2.7, p90Usd: 4 },
    },
    tasks: list.map(({ briefText, ...t }) => t),
  };
  patch(raw);
  const file = join(dir, "suite.json");
  writeFileSync(file, JSON.stringify(raw));
  return { file, dir, raw };
}

const load = (src, patch) => loadSuite(makeSuite(src, { patch }).file);

// What `validate` leaves for tasks it accepted, written directly, for the tests
// of `prepare` that are not about validation.
function approve(suite) {
  mkdirSync(suite.results, { recursive: true });
  const record = Object.fromEntries(suite.tasks.map((t) => [t.id, { fork: t.fork, tip: t.tip, ok: true, checks: {} }]));
  writeFileSync(join(suite.results, "validate.json"), JSON.stringify(record));
  return suite;
}

// Commits a symbolic link (git mode 120000) at `path` of the repository `cwd`
// without needing the right to create one on disk.
function commitLink(cwd, path, target) {
  const blobFile = join(tmp("bench-blob-"), "target");
  writeFileSync(blobFile, target);
  const sha = git(cwd, "hash-object", "-w", blobFile).out.trim();
  git(cwd, "update-index", "--add", "--cacheinfo", `120000,${sha},${path}`);
  git(cwd, "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "commit", "-qm", `chore: link ${path}`);
  return head(cwd);
}

test("T1 an invalid suite fails with the name of the field", () => {
  const src = makeSource();
  assert.doesNotThrow(() => load(src));
  assert.throws(() => load(src, (r) => delete r.id), /field "id"/);
  assert.throws(() => load(src, (r) => (r.install = "npm ci")), /field "install"/);
  assert.throws(() => load(src, (r) => (r.tasks[0].fork = "abc")), /field "tasks\[0\]\.fork"/);
  assert.throws(() => load(src, (r) => (r.organisations.O0.maxBudgetUsd = "3")), /field "organisations\.O0\.maxBudgetUsd"/);
  assert.throws(() => load(src, (r) => (r.tasks[0].oracle = ["../x.test.js"])), /field "tasks\[0\]\.oracle"/);
  assert.throws(() => load(src, (r) => delete r.prompts.O2), /field "prompts\.O2"/);
  // slot: inside the source, equal to it, inside another repository; results inside a repository.
  assert.throws(() => load(src, (r) => (r.slot = join(src.dir, "slot"))), /field "slot"/);
  assert.throws(() => load(src, (r) => (r.slot = src.dir)), /field "slot"/);
  const other = tmp("bench-other-");
  git(other, "init", "-q", "-b", "main", ".");
  assert.throws(() => load(src, (r) => (r.slot = join(other, "slot"))), /field "slot".*git repository/);
  assert.throws(() => load(src, (r) => (r.results = join(other, "results"))), /field "results"/);
  // Inside the `.git` folder of a repository: git answers with an error there, not with "no".
  assert.throws(() => load(src, (r) => (r.slot = join(other, ".git", "slot"))), /field "slot".*git repository/);
  // A slot that contains the source, and a drive or file system root (which contains everything).
  assert.throws(() => load(src, (r) => (r.slot = dirname(src.dir))), /field "slot".*contain the source/);
  assert.throws(() => load(src, (r) => (r.slot = parse(src.dir).root)), /field "slot".*root/);
  // The CLI reports the same, with exit code 2.
  const bad = makeSuite(src, { patch: (r) => delete r.source });
  const r = sh(process.execPath, [BENCH, "validate", "--suite", bad.file], ROOT, { HOME: emptyHome, USERPROFILE: emptyHome });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /field "source"/);
});

test("T1 a slot whose casing differs from the real path is refused", (t) => {
  const src = makeSource();
  const parent = tmp("bench-Case-");
  const swapped = parent.replace(/bench-Case-/, "BENCH-cASE-");
  // Only a case-insensitive file system resolves the swapped path.
  if (!existsSync(swapped)) return t.skip("case-sensitive file system");
  assert.throws(() => load(src, (r) => (r.slot = join(swapped, "slot"))), /field "slot".*real path/);
  assert.doesNotThrow(() => load(src, (r) => (r.slot = join(parent, "slot"))));
});

test("T2 prepare gives one commit, no remote, and none of what came after the fork", () => {
  const src = makeSource();
  const { file } = makeSuite(src);
  const suite = approve(loadSuite(file));
  const r = prepare(suite, "t1", { org: "O2" });
  const slot = suite.slot;
  assert.equal(git(slot, "rev-list", "--all", "--count").out.trim(), "1");
  assert.equal(git(slot, "remote").out.trim(), "");
  assert.equal(git(slot, "log", "-1", "--format=%an <%ae> %s").out.trim(), "bench <bench@example.invalid> bench base");
  assert.equal(git(slot, "rev-parse", "HEAD").out.trim(), r.base);
  assert.equal(readFileSync(join(slot, "src.js"), "utf8"), "module.exports = () => 1;\n");
  assert.ok(!existsSync(join(slot, "tip-only.txt")) && !existsSync(join(slot, "oracle.test.js")) && !existsSync(join(slot, "merge-only.txt")));
  const history = git(slot, "log", "--all", "--format=%H %s").out + git(slot, "reflog", "--all").out;
  for (const h of [src.tip, src.merge]) assert.ok(!history.includes(h.slice(0, 10)), "the solution is not reachable");
  assert.ok(!existsSync(join(slot, ".git", "packed-refs")) || !readFileSync(join(slot, ".git", "packed-refs"), "utf8").includes(src.tip));
  // Pass files exist, stay unversioned and do not show as work.
  assert.equal(readFileSync(join(slot, "notes", "t1.md"), "utf8"), CLEAN_BRIEF);
  assert.match(readFileSync(join(slot, "CLAUDE.local.md"), "utf8"), /synthetic/);
  assert.deepEqual(JSON.parse(readFileSync(join(slot, ".claude", "orchestration", "organisation.json"), "utf8")).review, "never");
  assert.equal(git(slot, "status", "--porcelain").out.trim(), "");
});

test("T2 prepare refuses a tree that holds a .env file", () => {
  const src = makeSource({ envFile: true });
  const suite = approve(loadSuite(makeSuite(src).file));
  assert.throws(() => prepare(suite, "t1"), /env file: \.env/);
});

test("T3 prepare deletes a marked slot and refuses a slot without the marker", () => {
  const src = makeSource();
  const suite = approve(loadSuite(makeSuite(src).file));
  prepare(suite, "t1");
  writeFileSync(join(suite.slot, "stale.txt"), "left by a pass");
  prepare(suite, "t1");
  assert.ok(!existsSync(join(suite.slot, "stale.txt")), "a marked slot is replaced");

  const other = approve(loadSuite(makeSuite(src).file));
  mkdirSync(other.slot);
  writeFileSync(join(other.slot, "precious.txt"), "not a bench folder");
  assert.throws(() => prepare(other, "t1"), /marker/);
  assert.equal(readFileSync(join(other.slot, "precious.txt"), "utf8"), "not a bench folder");
});

test("T4 validate: failing at the base and passing at the tip is valid, an oracle already passing is not", () => {
  const src = makeSource();
  const second = { id: "t2", fork: src.tip, tip: src.merge, merge: src.merge, brief: "t2.md", oracle: ["oracle.test.js"], zone: ["src.js"] };
  const dirty = { id: "t3", fork: src.fork, tip: src.tip, merge: src.merge, brief: "t3.md", oracle: ["oracle.test.js"], zone: ["src.js"], briefText: `see 0x${"ab12".repeat(10)}\n` };
  const first = { id: "t1", fork: src.fork, tip: src.tip, merge: src.merge, brief: "t1.md", oracle: ["oracle.test.js"], zone: ["src.js"] };
  const suite = loadSuite(makeSuite(src, { tasks: [first, second, dirty] }).file);
  const v = validate(suite);
  const by = Object.fromEntries(v.tasks.map((t) => [t.id, t]));
  assert.equal(v.ok, false);
  assert.equal(by.t1.ok, true, by.t1.problems.join("; "));
  assert.ok(by.t1.base.fail > 0 && by.t1.tip.fail === 0 && by.t1.tip.pass >= 1);
  assert.deepEqual(by.t1.checks, { tests: true, lint: false });
  assert.equal(by.t2.ok, false);
  assert.match(by.t2.problems.join(), /passes at the base/);
  assert.equal(by.t3.ok, false);
  assert.match(by.t3.problems.join(), /forbidden patterns \(address\)/);
  assert.deepEqual(by.t3.brief.findings, [{ pattern: "address", line: 1 }]);
  // --task restricts the run, and the CLI prints a line per task and a JSON object.
  const cli = sh(process.execPath, [BENCH, "validate", "--suite", suite.file, "--task", "t1", "--json"], ROOT, { HOME: emptyHome, USERPROFILE: emptyHome });
  assert.equal(cli.code, 0, cli.out);
  assert.equal(JSON.parse(cli.out).tasks.length, 1);
  // A rejected task is neither prepared nor graded; the slot of the others is not touched.
  for (const id of ["t2", "t3"]) {
    assert.throws(() => prepare(suite, id), /did not pass validate/, id);
    assert.throws(() => grade(suite, id), /did not pass validate/, id);
  }
  assert.ok(!existsSync(suite.slot));
  // An accepted task whose brief changed since is scanned again by prepare.
  writeFileSync(join(suite.dir, "t1.md"), `see 0x${"ab12".repeat(10)}\n`);
  assert.throws(() => prepare(suite, "t1"), /forbidden patterns \(address\)/);
  assert.ok(!existsSync(suite.slot));
});

test("T8 a tree that holds a symbolic link is never unpacked, by prepare, validate or grade", () => {
  const src = makeSource();
  const outside = tmp("bench-outside-");
  writeFileSync(join(outside, "leak.txt"), "outside the copy\n");
  const withLink = commitLink(src.dir, "linked", outside);
  const task = (id, fork, tip) => ({ id, fork, tip, merge: src.merge, brief: `${id}.md`, oracle: ["oracle.test.js"], zone: ["src.js"] });
  const tasks = [task("t1", src.fork, src.tip), task("lf", withLink, withLink), task("lt", src.fork, withLink)];
  const suite = loadSuite(makeSuite(src, { tasks }).file);

  const v = validate(suite);
  const by = Object.fromEntries(v.tasks.map((t) => [t.id, t]));
  assert.equal(by.t1.ok, true, by.t1.problems.join("; "));
  assert.match(by.lf.problems.join(), /symbolic links/);
  assert.match(by.lt.problems.join(), /symbolic links/);
  assert.equal(by.lf.ok || by.lt.ok, false);

  // The gate of validate is lifted by hand: the refusal below is the link check, not the record.
  approve(suite);
  assert.throws(() => prepare(suite, "lf"), /symbolic links/);
  assert.ok(!existsSync(join(suite.slot, "src.js")) && !existsSync(join(suite.slot, "linked")) && !existsSync(join(suite.slot, "leak.txt")), "nothing was unpacked");

  // A pass that commits a link on its main: the delivered tree is refused before it is unpacked.
  prepare(suite, "t1");
  commitLink(suite.slot, "linked", outside);
  assert.throws(() => grade(suite, "t1"), /symbolic links/);
});

test("T5 every forbidden brief pattern fails, a clean brief passes", () => {
  const task = { tip: "d3adbeef".repeat(5), merge: "0285480123".padEnd(40, "1") };
  const names = (text) => briefFindings(text, task).map((f) => f.pattern);
  assert.deepEqual(names(CLEAN_BRIEF), []);
  assert.deepEqual(names(`wallet 0x${"1f".repeat(20)}`), ["address"]);
  assert.deepEqual(names(`id ${"ab".repeat(32)}`), ["hash64"]);
  // The `x` of the prefix is a word character: no `\b` stands before the digits.
  assert.deepEqual(names(`tx 0x${"ab".repeat(32)}`), ["hash64"]);
  assert.deepEqual(names(`tx 0X${"AB".repeat(32)}`), ["hash64"]);
  assert.deepEqual(names(`wallet 0X${"1F".repeat(20)}`), ["address"]);
  for (const amount of ["pays 12.50 EUR", "costs $300", "worth 1,000 USDC", "fee 0.5 ETH", "fee 1.5 eth", "left 0.25 GHST", "paid 12 EURe", "9 weth"]) {
    assert.deepEqual(names(amount), ["amount"], amount);
  }
  // Numbers that are not amounts.
  for (const plain of ["## 2. Scope", "step 2 of 3", "t1 Foo", "3 files", "2 Next", "the 41-character 0x" + "a".repeat(41)]) assert.deepEqual(names(plain), [], plain);
  assert.deepEqual(names(`at ${task.tip}`), ["tip-hash"]);
  assert.deepEqual(names(`prefix ${task.tip.slice(0, 10)}`), ["tip-hash"]);
  assert.deepEqual(names(`merged as ${task.merge}`), ["merge-hash"]);
  // A prefix made of digits only is a number, not a hash; the full hash still counts.
  assert.deepEqual(names("see 0285480123 lines"), []);
  assert.deepEqual(names("## Vérification sur données réelles"), ["real-data-title"]);
  assert.deepEqual(names("## Verification on real data"), ["real-data-title"]);
  assert.deepEqual(briefFindings("ok\n\n$5 bonus", task), [{ pattern: "amount", line: 3 }]);
});

test("T6 grade: a delivered fix passes the oracle, uncommitted work does not, scope is counted", () => {
  const src = makeSource();
  const suite = loadSuite(makeSuite(src).file);
  assert.throws(() => grade(suite, "t1"), /validate/);
  assert.equal(validate(suite).ok, true);
  const slot = suite.slot;
  const commit = (cwd, msg) => git(cwd, "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "commit", "-qm", msg);

  prepare(suite, "t1");
  writeFileSync(join(slot, "src.js"), "module.exports = () => 2;\n");
  writeFileSync(join(slot, "extra.txt"), "out of zone\n");
  git(slot, "add", "-A");
  commit(slot, "fix: answer");
  const done = grade(suite, "t1");
  assert.equal(done.oracle.fail, 0);
  assert.ok(done.oracle.pass >= 1);
  assert.deepEqual(done.checks, { tests: true, lint: null });
  assert.equal(done.uncommitted, 0);
  assert.equal(done.filesChanged, 2);
  assert.equal(done.outsideZone, 1);
  assert.equal(done.added, 2);
  assert.equal(done.deleted, 1);
  assert.ok(done.refAdded > done.added && done.refDeleted === 1);

  prepare(suite, "t1");
  writeFileSync(join(slot, "src.js"), "module.exports = () => 2;\n");
  const loose = grade(suite, "t1");
  assert.equal(loose.uncommitted, 1);
  assert.ok(loose.oracle.fail > 0, "work that is not committed is not delivered");
  assert.equal(loose.filesChanged, 0);

  const cli = sh(process.execPath, [BENCH, "grade", "t1", "--suite", suite.file, "--json"], ROOT, { HOME: emptyHome, USERPROFILE: emptyHome });
  assert.equal(cli.code, 0, cli.out);
  assert.equal(JSON.parse(cli.out).quality.uncommitted, 1);
});

test("T9 grade refuses the copy of another task and a main that no longer descends from the recorded base", () => {
  const src = makeSource();
  const task = (id) => ({ id, fork: src.fork, tip: src.tip, merge: src.merge, brief: `${id}.md`, oracle: ["oracle.test.js"], zone: ["src.js"] });
  const suite = loadSuite(makeSuite(src, { tasks: [task("t1"), task("t4")] }).file);
  assert.equal(validate(suite).ok, true);
  const slot = suite.slot;
  const agent = ["-c", "user.name=agent", "-c", "user.email=agent@example.invalid"];

  prepare(suite, "t1");
  const marker = JSON.parse(readFileSync(join(slot, ".bench-slot"), "utf8"));
  assert.equal(marker.task, "t1");
  assert.equal(marker.base, head(slot));
  writeFileSync(join(slot, "src.js"), "module.exports = () => 2;\n");
  git(slot, "add", "-A");
  git(slot, ...agent, "commit", "-qm", "fix: answer");
  assert.throws(() => grade(suite, "t4"), /prepared for t1, not t4/);
  assert.equal(grade(suite, "t1").filesChanged, 1);

  // Rewriting the base commit leaves a single root, but not the recorded one.
  git(slot, ...agent, "reset", "-q", "--soft", marker.base);
  git(slot, ...agent, "commit", "-q", "--amend", "-m", "rewritten base");
  assert.throws(() => grade(suite, "t1"), /does not descend from its base/);

  rmSync(join(slot, ".bench-slot"));
  assert.throws(() => grade(suite, "t1"), /marker/);
});

test("T10 grade counts non-ASCII paths and ignores dependencies and sub-agent worktrees as uncommitted work", () => {
  const src = makeSource();
  const suite = loadSuite(makeSuite(src).file);
  assert.equal(validate(suite).ok, true);
  const slot = suite.slot;
  prepare(suite, "t1");
  const name = "src/café.js";
  mkdirSync(join(slot, "src"), { recursive: true });
  writeFileSync(join(slot, name), "module.exports = 1;\n");
  git(slot, "add", "-A");
  git(slot, "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "commit", "-qm", "feat: accent");
  mkdirSync(join(slot, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(slot, "node_modules", "dep", "index.js"), "x\n");
  mkdirSync(join(slot, ".claude", "worktrees", "sub"), { recursive: true });
  writeFileSync(join(slot, ".claude", "worktrees", "sub", "f.txt"), "x\n");
  const done = grade(suite, "t1");
  assert.equal(done.filesChanged, 1);
  assert.equal(done.outsideZone, 1);
  assert.equal(done.uncommitted, 0);
  writeFileSync(join(slot, "loose.txt"), "x\n");
  assert.equal(grade(suite, "t1").uncommitted, 1);
});

test("T7 a variable of the parent process is not seen by an install command", () => {
  const src = makeSource();
  const witness = node(
    "require('fs').writeFileSync('seen.json', JSON.stringify({ secret: process.env.SECRET_X ?? null, fake: process.env.BENCH_FAKE ?? null, quota: process.env.CLAUDE_PLUGIN_OPTION_QUOTA_MODE ?? null }))",
  );
  const { file } = makeSuite(src, { patch: (r) => (r.install = [witness]) });
  process.env.SECRET_X = "leak";
  try {
    prepare(approve(loadSuite(file)), "t1");
  } finally {
    delete process.env.SECRET_X;
  }
  assert.deepEqual(JSON.parse(readFileSync(join(loadSuite(file).slot, "seen.json"), "utf8")), { secret: null, fake: "yes", quota: "off" });
});
