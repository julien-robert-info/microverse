"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, utimesSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { ROOT, commitFile, git, makeAccount, makeRepo, script: runScript } = require("./helpers.js");

// APPDATA (Windows) is where orch-quota looks for the extension's readings: an
// empty one keeps the real quota out of the tests.
const emptyAppData = mkdtempSync(join(tmpdir(), "microverse-appdata-"));
const script = (name, args, cwd, env) => runScript(name, args, cwd, { APPDATA: emptyAppData, ...env });

const HOUR = 3600e3;
const PROFILE = { checks: [] };

// Readings of both counters, taken now, in a window that resets in two days.
function quotaFile(week, five) {
  const now = Date.now();
  const file = join(mkdtempSync(join(tmpdir(), "microverse-quota-")), "quota.json");
  writeFileSync(
    file,
    JSON.stringify({
      observations: [
        { periodType: "seven-day", usedFraction: week, resetAt: now + 48 * HOUR, observedAt: now },
        { periodType: "five-hour", usedFraction: five, resetAt: now + 2 * HOUR, observedAt: now },
      ],
    }),
  );
  return file;
}

const head = (dir) => git(dir, "rev-parse", "HEAD").out.trim();

function mergeBranch(dir, name) {
  git(dir, "checkout", "-q", "-b", `feat/${name}`);
  commitFile(dir, `${name}.txt`, `${name}\n`, `feat: ${name}`);
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "--no-ff", "-q", "-m", `merge: ${name}`, `feat/${name}`);
}

const FR_STATE = [
  "# Notes locales",
  "",
  "## But",
  "",
  "Texte du but.",
  "",
  "## Missions (séries du jour)",
  "",
  "| Id | Branche | État |",
  "|---|---|---|",
  "| E1 | feat/a | mergé \\| poussé |",
  "",
  "| E2 | feat/b | en cours |",
  "",
  "Dernier rapport : 2026-10-18, commit `LAST` (E1).",
  "",
  "## Questions à Julien",
  "",
  "- Une question sans numéro ?",
  "- Q2 : une autre",
  "",
  "# Compact instructions",
  "",
  "Ne pas afficher.",
].join("\r\n");

const sectionOf = (out, title) => {
  const i = out.split("\n").findIndex((l) => l.startsWith(title));
  if (i < 0) return null;
  const rest = out.split("\n").slice(i + 1);
  const end = rest.findIndex((l) => l !== "" && !l.startsWith(" "));
  return rest.slice(0, end < 0 ? undefined : end).join("\n");
};

test("T1: a French state file shows Missions and Questions, tables as a · b, nothing else", () => {
  const { dir } = makeRepo(PROFILE);
  writeFileSync(join(dir, "CLAUDE.local.md"), FR_STATE.replace("LAST", head(dir).slice(0, 7)));
  const r = script("orch-status", [], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Missions \(séries du jour\)$/m);
  assert.match(r.out, /^Questions à Julien$/m);
  assert.match(r.out, /^ {2}Id · Branche · État$/m);
  assert.match(r.out, /^ {2}E1 · feat\/a · mergé \| poussé$/m);
  assert.match(r.out, /^ {2}E2 · feat\/b · en cours$/m);
  assert.match(r.out, /^ {2}- Une question sans numéro \?$/m);
  assert.doesNotMatch(r.out, /\|---|\|\s*---/);
  assert.doesNotMatch(r.out, /Texte du but|But$|Compact instructions|Ne pas afficher/m);
});

test("T2: English titles are recognized", () => {
  const { dir } = makeRepo(PROFILE);
  writeFileSync(join(dir, "CLAUDE.local.md"), "## Missions in progress\n\nm1\n\n## Questions awaiting the user\n\nq1\n\n## Resume\n\nr1\n\n## Other\n\nzzz\n");
  const r = script("orch-status", [], dir);
  for (const t of ["Missions in progress", "Questions awaiting the user", "Resume"]) assert.match(r.out, new RegExp(`^${t}$`, "m"));
  assert.doesNotMatch(r.out, /zzz/);
});

test("T3: the commit comes from the last report line; a non-commit hex token before it is skipped", () => {
  const { dir } = makeRepo(PROFILE);
  mergeBranch(dir, "before");
  const last = head(dir);
  mergeBranch(dir, "after");
  writeFileSync(join(dir, "CLAUDE.local.md"), `## Missions\n\nBuild deadbeefcafe0 then Last report: commit \`${last.slice(0, 7)}\`.\nLine with ${head(dir).slice(0, 7)} but not the report.\n`);
  const r = script("orch-status", [], dir);
  assert.equal(r.code, 0, r.out);
  const merged = sectionOf(r.out, "Merged since");
  assert.match(r.out, new RegExp(`^Merged since ${last.slice(0, 7)} \\(last report\\)$`, "m"));
  assert.match(merged, /merge: after/);
  assert.doesNotMatch(merged, /merge: before/);
});

test("T4: a positional commit beats the state file; an invalid one exits 2", () => {
  const { dir } = makeRepo(PROFILE);
  const first = head(dir);
  mergeBranch(dir, "one");
  const last = head(dir);
  mergeBranch(dir, "two");
  writeFileSync(join(dir, "CLAUDE.local.md"), `## Missions\n\nLast report: ${last.slice(0, 7)}\n`);
  const r = script("orch-status", [first.slice(0, 7)], dir);
  assert.match(r.out, new RegExp(`^Merged since ${first.slice(0, 7)} `, "m"));
  assert.match(r.out, /merge: one/);
  assert.match(r.out, /merge: two/);
  for (const bad of ["0123abc0123abc", "-x"]) {
    const b = script("orch-status", [bad], dir);
    assert.equal(b.code, 2, bad);
    assert.match(b.out, /not a commit/);
  }
  assert.equal(script("orch-status", [""], dir).code, 0, "an empty positional is ignored");
});

test("T5: no last report line gives the explanation and the quota, without Merged", () => {
  const { dir } = makeRepo(PROFILE);
  writeFileSync(join(dir, "CLAUDE.local.md"), "## Missions\n\nnothing here\n");
  const r = script("orch-status", [], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Last report: no commit found /m);
  assert.match(r.out, /^Quota$/m);
  assert.match(r.out, /^Context$/m);
  assert.doesNotMatch(r.out, /Merged since|^Agents since/m);
});

test("T6: agent worktrees and branches without one", () => {
  const { dir, wt } = makeRepo(PROFILE);
  writeFileSync(join(wt, "dirty.txt"), "x\n");
  const wts = join(dir, ".claude", "worktrees");
  git(dir, "worktree", "add", "-q", "-b", "feat/merged", join(wts, "m"));
  git(dir, "worktree", "add", "-q", "--detach", join(wts, "d"));
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-outside-")));
  git(dir, "worktree", "add", "-q", "-b", "feat/outside", join(outside, "o"));
  git(dir, "branch", "feat/free");
  git(dir, "checkout", "-q", "feat/free");
  commitFile(dir, "free.txt", "f\n", "feat: free work");
  git(dir, "checkout", "-q", "main");
  git(dir, "branch", "feat/done");
  const out = script("orch-status", [], dir).out;
  const agents = sectionOf(out, "Agent worktrees");
  assert.match(agents, /^ {2}feat\/x {2}\.claude\/worktrees\/w {2}not merged, last commit \w+ feat: a, uncommitted changes$/m);
  assert.match(agents, /^ {2}feat\/merged {2}\.claude\/worktrees\/m {2}merged, last commit .*, clean$/m);
  assert.match(agents, /^ {2}\(detached\) {2}\.claude\/worktrees\/d {2}merged/m);
  assert.doesNotMatch(agents, /outside/);
  const free = sectionOf(out, "Branches not merged into main, without a worktree");
  assert.match(free, /^ {2}feat\/free {2}\w+ {2}feat: free work$/m);
  assert.doesNotMatch(free, /feat\/x|feat\/done|feat\/merged|outside/);
});

test("T7: from an agent worktree, the state file of the main clone is read", () => {
  const { dir, wt } = makeRepo(PROFILE);
  writeFileSync(join(dir, "CLAUDE.local.md"), "## Missions\n\nonly in the main clone\n");
  const r = script("orch-status", [], wt);
  assert.match(r.out, /only in the main clone/);
  assert.match(r.out, new RegExp(`^microverse status: ${dir.split(/[\\/]/).pop()} · main `, "m"));
});

test("T8: without a profile, and outside git, a line and the quota", () => {
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-plain-")));
  git(plain, "init", "-q", "-b", "main", ".");
  const a = script("orch-status", [], plain);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /^Not an orchestrated project: no \.claude\/orchestration\/profile\.json \(\/microverse:init sets one up\)\.$/m);
  assert.match(a.out, /^Quota$/m);
  const bare = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-bare-")));
  const b = script("orch-status", [], bare);
  assert.equal(b.code, 0, b.out);
  assert.match(b.out, /^Not in a git repository: /m);
  assert.match(b.out, /^Quota$/m);
});

test("T9: no state file", () => {
  const { dir } = makeRepo(PROFILE);
  const r = script("orch-status", [], dir);
  assert.match(r.out, /^No CLAUDE\.local\.md \(state file\)\.$/m);
  assert.match(r.out, /^Agent worktrees$/m);
  assert.match(r.out, /^Quota$/m);
});

test("T10: quota options reach orch-quota; without a reading, its three lines", () => {
  const { dir } = makeRepo(PROFILE);
  const none = script("orch-status", [], dir);
  assert.equal(none.code, 0, none.out);
  assert.equal(sectionOf(none.out, "Quota").split("\n").filter(Boolean).length, 3, none.out);
  const stop = script("orch-status", ["--file", quotaFile(0.99, 0.1)], dir);
  assert.match(stop.out, /Advice: stop/);
});

test("T11: seven agent runs: count, total, five rows and the earlier ones", () => {
  const acc = makeAccount();
  const dir = acc.project("proj");
  git(dir, "init", "-q", "-b", "main", ".");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
  writeFileSync(join(dir, ".claude", "orchestration", "profile.json"), "{}");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "chore: init");
  const t0 = Date.now();
  acc.conversation("proj", t0, 0.5);
  for (let i = 0; i < 7; i++) acc.agent("proj", `a${i}`, "microverse:morty", [{ ts: t0 + i * 1000, dollars: 1 + i }], i * 1000);
  const r = script("orch-status", ["HEAD", "--file", quotaFile(0.2, 0.1)], dir, acc.env);
  assert.equal(r.code, 0, r.out);
  const agents = sectionOf(r.out, "Agents since");
  assert.match(r.out, /^Agents since \S+: 7 runs, \$28\.00 \(API-equivalent\)$/m);
  assert.equal(agents.split("\n").filter((l) => l.includes("microverse:morty")).length, 5);
  assert.match(agents, /… 2 earlier runs/);
  // Read-only: the calibration orch-quota would save is not written.
  assert.equal(existsSync(join(acc.data, "calibration.json")), false);
});

test("T12: plain text, bounded", () => {
  const { dir } = makeRepo(PROFILE);
  const rows = Array.from({ length: 600 }, (_, i) => `| M${i} | feat/x${i} | state ${i} |`);
  // The risky lines come first so they fall in the shown part of the file.
  const risky = `\`\`\`\n## fenced\n\`\`\`\n### sub heading\n▶ trace line\n\u001b[31mred\u001b[0m \u009b\u0007 end\n`;
  const state = `## Missions\n\n${risky}\n${rows.join("\n")}\n\nLast report: ${head(dir).slice(0, 7)}\n`;
  assert.ok(state.length > 10000);
  writeFileSync(join(dir, "CLAUDE.local.md"), state);
  const r = script("orch-status", [], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ {2}fenced$/m);
  assert.match(r.out, /^ {2}sub heading$/m);
  assert.match(r.out, /trace line/);
  assert.match(r.out, /\[31mred\[0m/);
  assert.doesNotMatch(r.out, /## |### |```|▶|\t|[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  assert.match(r.out, /^ {2}… \d+ more lines in CLAUDE\.local\.md$/m);
  assert.ok(r.out.length <= 9000, String(r.out.length));
  const state_part = r.out.slice(r.out.indexOf("Missions"), r.out.indexOf("  … "));
  assert.ok(state_part.length <= 4000 + 100, String(state_part.length));
});

test("a file without a recognized section is shown whole, control characters stripped", () => {
  const { dir } = makeRepo(PROFILE);
  writeFileSync(join(dir, "CLAUDE.local.md"), "# Title\n\nplain \u001b[2Jnote\n");
  const r = script("orch-status", [], dir);
  assert.match(r.out, /^ {2}Title$/m);
  assert.match(r.out, /plain \[2Jnote/);
});

test("orch-status leaves the calibration and the readings alone", () => {
  const acc = makeAccount();
  const dir = acc.project("proj2");
  git(dir, "init", "-q", "-b", "main", ".");
  mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
  writeFileSync(join(dir, ".claude", "orchestration", "profile.json"), "{}");
  // No commit to report from: the quota section comes from orch-quota directly.
  const r = script("orch-status", ["--file", quotaFile(0.2, 0.1)], dir, acc.env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Advice:/);
  assert.equal(existsSync(join(acc.data, "calibration.json")), false, "no calibration saved");
});

test("a UTF-8 BOM before the first heading does not hide the sections", () => {
  const { dir } = makeRepo(PROFILE);
  writeFileSync(join(dir, "CLAUDE.local.md"), "﻿## Missions\n\n| E1 | feat/a | doing |\n\n## Other\n\nsecret other text\n");
  const r = script("orch-status", [], dir);
  assert.match(r.out, /^ {2}E1 · feat\/a · doing$/m);
  assert.doesNotMatch(r.out, /secret other text/);
});

test("bidi and zero-width characters are stripped", () => {
  const { dir } = makeRepo(PROFILE);
  writeFileSync(join(dir, "CLAUDE.local.md"), "## Missions\n\nfdp.‮txt ​zero⁦x\n");
  const r = script("orch-status", [], dir);
  assert.match(r.out, /^ {2}fdp\.txt zerox$/m);
  assert.doesNotMatch(r.out, /[​-‏‪-‮⁦-⁩﻿]/);
});

test("a huge single line is still cut to the bound", () => {
  const { dir } = makeRepo(PROFILE);
  commitFile(dir, "big.txt", "x\n", `feat: ${"y".repeat(12000)}`);
  const r = script("orch-status", ["HEAD~1"], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.length <= 9100, String(r.out.length));
  assert.match(r.out, /… output truncated\n?$/);
});

test("no base branch: a given commit keeps the Agents section and says Merged is skipped", () => {
  const acc = makeAccount();
  const dir = acc.project("proj3");
  git(dir, "init", "-q", "-b", "trunk", ".");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  mkdirSync(join(dir, ".claude", "orchestration"), { recursive: true });
  writeFileSync(join(dir, ".claude", "orchestration", "profile.json"), "{}");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "chore: init");
  const t0 = Date.now() + 60000;
  acc.conversation("proj3", t0, 0.5);
  acc.agent("proj3", "a0", "microverse:morty", [{ ts: t0, dollars: 3 }], 1000);
  const r = script("orch-status", ["HEAD", "--file", quotaFile(0.2, 0.1)], dir, acc.env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Merged since \w+: not listed, no base branch/m);
  assert.match(r.out, /^Agents since \S+: 1 runs, \$3\.00 \(API-equivalent\)$/m);
  assert.match(r.out, /microverse:morty/);
});

test("the index of an agent worktree is not rewritten", () => {
  const { dir, wt } = makeRepo(PROFILE);
  const index = resolve(wt, git(wt, "rev-parse", "--git-path", "index").out.trim());
  // A tracked file with a fresh mtime makes a plain `git status` refresh the index.
  const later = new Date(Date.now() + 5000);
  utimesSync(join(wt, "a.txt"), later, later);
  const before = statSync(index).mtimeMs;
  const r = script("orch-status", [], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(statSync(index).mtimeMs, before);
});

test("the scripts are executable in git", { skip: !existsSync(join(ROOT, ".git")) }, () => {
  for (const f of ["bin/orch-status", "bin/orch-report"]) {
    const r = spawnSync("git", ["ls-files", "-s", f], { cwd: ROOT, encoding: "utf8" });
    assert.match(r.stdout, /^100755 /, f);
  }
});
