"use strict";

// `validate` (is a task fit to be graded?) and `grade` (what did a pass
// deliver?). Both unpack commits into fresh folders and always remove them.

const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { profileTrust } = require("../../scripts/orch-lib.js");
const { MARKER, extractArchive, install, overlayOracle, shell, withTempDir } = require("./copy.js");
const { briefFindings, gitIn, readRecord, recordFile, taskOf, validatedRecord } = require("./suite.js");

// Last `# pass N` and `# fail N` lines of a TAP stream. A command that exits
// non-zero counts as at least one failure: a file that does not load gives no
// summary, or a summary of zero tests.
function parseTap(out, code) {
  const last = (name) => {
    const all = [...out.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, "gm"))];
    return all.length ? Number(all[all.length - 1][1]) : 0;
  };
  const pass = last("pass");
  let fail = last("fail");
  if (code !== 0 && fail === 0) fail = 1;
  return { pass, fail };
}

const quoted = (files) => files.map((f) => `"${f}"`).join(" ");

function runOracle(suite, task, dir) {
  const r = shell(suite, suite.oracleCommand.replace("{files}", quoted(task.oracle)), dir);
  return parseTap(r.out, r.code);
}

// The profile checks at the tip of a task. The commands come from the source's
// approved profile only: the tip's profile must be that very file.
function tipChecks(suite, task) {
  const shown = gitIn(suite.source, ["show", `${task.tip}:.claude/orchestration/profile.json`], suite.cmdEnv);
  if (shown.code !== 0) return [];
  const hash = createHash("sha256").update(shown.out.replace(/\r\n/g, "\n")).digest("hex");
  const trust = profileTrust(suite.source);
  if (trust.state !== "approved" || trust.hash !== hash) {
    throw new Error(`the profile at the tip of ${task.id} is not the approved profile of the source (orch-trust): its checks are not run`);
  }
  return trust.profile.checks ?? [];
}

const checkName = (c) => c.name ?? c.run;

// R5. One entry per task: the oracle fails at the base and passes at the tip,
// the profile checks at the tip, the brief is clean. Fail closed: any error
// of a step is a problem of the task, never a pass.
function validate(suite, { task: only = null } = {}) {
  const tasks = only ? [taskOf(suite, only)] : suite.tasks;
  const record = readRecord(suite);
  const out = tasks.map((task) => {
    const res = { id: task.id, ok: false, base: null, tip: null, checks: {}, brief: { findings: [] }, problems: [] };
    const step = (name, fn) => {
      try {
        fn();
      } catch (e) {
        res.problems.push(`${name}: ${e.message}`);
      }
    };
    step("base", () =>
      withTempDir("bench-base-", (dir) => {
        extractArchive(suite, task.fork, dir);
        install(suite, dir);
        overlayOracle(suite, task, dir);
        res.base = runOracle(suite, task, dir);
        if (res.base.fail === 0) res.problems.push("the oracle passes at the base");
      }),
    );
    step("tip", () =>
      withTempDir("bench-tip-", (dir) => {
        extractArchive(suite, task.tip, dir);
        install(suite, dir);
        overlayOracle(suite, task, dir);
        res.tip = runOracle(suite, task, dir);
        if (res.tip.fail !== 0 || res.tip.pass < 1) res.problems.push("the oracle does not pass at the tip");
        for (const c of tipChecks(suite, task)) res.checks[checkName(c)] = shell(suite, c.run, dir).code === 0;
      }),
    );
    step("brief", () => {
      if (!existsSync(task.brief)) throw new Error("brief not found");
      res.brief.findings = briefFindings(readFileSync(task.brief, "utf8"), task);
      if (res.brief.findings.length) res.problems.push(`the brief holds forbidden patterns (${[...new Set(res.brief.findings.map((f) => f.pattern))].join(", ")})`);
    });
    res.ok = res.problems.length === 0;
    // Always written, `ok` included: a task that fails now must not keep the
    // approval of an earlier run. A check that fails at the tip is excluded
    // from grading.
    record[task.id] = { fork: task.fork, tip: task.tip, ok: res.ok, checks: res.checks };
    return res;
  });
  mkdirSync(suite.results, { recursive: true });
  writeFileSync(recordFile(suite), `${JSON.stringify(record, null, 2)}\n`);
  return { v: 1, ok: out.every((t) => t.ok), tasks: out };
}

// `git diff --numstat -z --no-renames`: "<added>\t<deleted>\t<path>\0" per file,
// paths unquoted (without -z a non-ASCII name comes back quoted and escaped).
const numstat = (text) => {
  const files = [];
  let added = 0;
  let deleted = 0;
  for (const l of text.split("\0").filter(Boolean)) {
    const [a, d, ...name] = l.split("\t");
    added += Number(a) || 0; // "-" for a binary file
    deleted += Number(d) || 0;
    files.push(name.join("\t"));
  }
  return { files, added, deleted };
};

// The marker `prepare` left in the slot: which task it was made for, and its
// base commit.
function readMarker(slot) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(join(slot, MARKER), "utf8"));
  } catch (e) {
    throw new Error(`the slot has no readable ${MARKER} marker (${e.message}): run prepare`);
  }
  if (typeof marker.task !== "string" || !/^[0-9a-f]{40}$/.test(marker.base ?? "")) throw new Error(`the ${MARKER} marker of the slot is incomplete: run prepare`);
  return marker;
}

// Work that is not committed, as `git status` sees it. Dependencies and the
// worktrees of an agent's own sub-agents are not work.
const NOT_WORK = /^(?:node_modules|\.claude\/worktrees)\//;

// R-qualité 1 to 4 on what the copy's `main` delivers; work that is not
// committed counts for nothing and is counted aside.
function grade(suite, taskId) {
  const task = taskOf(suite, taskId);
  const rec = validatedRecord(suite, task);
  const slot = suite.slot;
  const git = (args) => {
    const r = gitIn(slot, args, suite.cmdEnv);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} in the slot failed: ${r.err.trim()}`);
    return r.out;
  };

  // The slot must be the copy made for this task, and its main must still
  // descend from the base recorded then: the base is not recomputed from the
  // history the pass could rewrite (`commit --amend` of the base commit).
  const marker = readMarker(slot);
  if (marker.task !== task.id) throw new Error(`the slot was prepared for ${marker.task}, not ${task.id}`);
  const base = marker.base;
  const descends = gitIn(slot, ["merge-base", "--is-ancestor", base, "refs/heads/main"], suite.cmdEnv);
  if (descends.code !== 0) throw new Error(`the copy's main does not descend from its base commit ${base.slice(0, 10)} (history rewritten?)`);
  const mine = numstat(git(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, "refs/heads/main"]));
  const ref = gitIn(suite.source, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", task.fork, task.tip], suite.cmdEnv);
  if (ref.code !== 0) throw new Error(`reference diff failed: ${ref.err.trim()}`);
  const refDiff = numstat(ref.out);
  const uncommitted = git(["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"])
    .split("\0")
    .filter((l) => l && !NOT_WORK.test(l.slice(3))).length;

  return withTempDir("bench-grade-", (dir) => {
    extractArchive(suite, "refs/heads/main", dir, slot);
    install(suite, dir);
    overlayOracle(suite, task, dir);
    const oracle = runOracle(suite, task, dir);
    // Applicable checks only: one that failed at the tip, or whose paths the
    // delivery does not touch, is null (excluded), not false.
    const checks = {};
    for (const c of tipChecks(suite, task)) {
      const name = checkName(c);
      const touched = !c.paths || mine.files.some((f) => c.paths.some((p) => f.startsWith(p)));
      checks[name] = rec.checks[name] === true && touched ? shell(suite, c.run, dir).code === 0 : null;
    }
    return {
      oracle,
      checks,
      filesChanged: mine.files.length,
      outsideZone: mine.files.filter((f) => !task.zone.some((z) => f.startsWith(z))).length,
      added: mine.added,
      deleted: mine.deleted,
      refAdded: refDiff.added,
      refDeleted: refDiff.deleted,
      uncommitted,
    };
  });
}

module.exports = { validate, grade, parseTap, readMarker };
