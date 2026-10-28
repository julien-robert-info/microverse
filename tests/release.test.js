"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { ROOT, git, sh, makeRepo } = require("./helpers.js");
const { checkRelease } = require("../tools/release.js");

const GOOD_LOG = "# Changelog\n\n## Unreleased\n\n- x\n\n## [0.2.0] - 2026-10-20\n\n- y\n\n## [0.1.0] - 2026-10-11\n\n- z\n";
const manifest = (v) => JSON.stringify({ name: "p", version: v });

test("the repository's CHANGELOG and plugin.json agree", () => {
  const log = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const plugin = readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8");
  assert.deepEqual(checkRelease(log, plugin), []);
});

test("checkRelease accepts a well-formed changelog", () => {
  assert.deepEqual(checkRelease(GOOD_LOG, manifest("0.2.0")), []);
});

test("checkRelease fails on a version mismatch", () => {
  assert.equal(checkRelease(GOOD_LOG, manifest("0.1.0")).length, 1);
});

test("checkRelease fails on an undated heading", () => {
  const log = GOOD_LOG.replace("## [0.1.0] - 2026-10-11", "## 0.1.0");
  assert.ok(checkRelease(log, manifest("0.2.0")).some((p) => p.includes("heading without")));
});

test("checkRelease fails on a non-SemVer version", () => {
  const log = GOOD_LOG.replace("[0.2.0]", "[0.2]");
  assert.ok(checkRelease(log, manifest("0.2")).some((p) => p.includes("not SemVer")));
});

test("checkRelease fails when Unreleased is missing", () => {
  const log = GOOD_LOG.replace("## Unreleased", "## Next");
  assert.ok(checkRelease(log, manifest("0.2.0")).some((p) => p.includes("Unreleased")));
});

test("review agents forbid Artifact and SendUserFile", () => {
  for (const name of ["council", "rick", "meeseeks"]) {
    const text = readFileSync(join(ROOT, "agents", `${name}.md`), "utf8");
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1];
    const line = front.split(/\r?\n/).find((l) => l.startsWith("disallowedTools:"));
    const tools = line.slice("disallowedTools:".length).split(",").map((s) => s.trim());
    assert.ok(tools.includes("Artifact") && tools.includes("SendUserFile"), name);
  }
});

// Release script, on throwaway repositories (--skip-checks: no suite, no claude).
const RELEASE = join(ROOT, "tools", "release.js");
const LOG = "# Changelog\n\n## Unreleased\n\n### Added\n\n- feature one\n\n### Fixed\n\n- bug two\n\n## [0.8.0] - 2026-10-01\n\n- old\n";
const PLUGIN = '{\n  "name": "p",\n  "version": "0.8.0",\n  "keywords": ["a", "b"]\n}\n';

function releaseRepo(log = LOG) {
  const { dir } = makeRepo({});
  mkdirSync(join(dir, ".claude-plugin"));
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), PLUGIN);
  // Written byte for byte: a CRLF fixture must reach the script as CRLF.
  writeFileSync(join(dir, "CHANGELOG.md"), log);
  // makeRepo leaves its worktree folder untracked.
  writeFileSync(join(dir, ".gitignore"), ".claude/worktrees/\n");
  git(dir, "add", "CHANGELOG.md", ".claude-plugin/plugin.json", ".gitignore");
  git(dir, "commit", "-qm", "chore: manifest");
  return dir;
}
const release = (dir, version) => sh(process.execPath, [RELEASE, version, "--skip-checks"], dir);
const read = (dir, f) => readFileSync(join(dir, f), "utf8");

test("release moves Unreleased under the dated version and sets plugin.json", () => {
  const dir = releaseRepo();
  const r = release(dir, "0.9.0");
  assert.equal(r.code, 0, r.out);
  const log = read(dir, "CHANGELOG.md");
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  assert.equal(
    log,
    `# Changelog\n\n## Unreleased\n\n## [0.9.0] - ${date}\n\n### Added\n\n- feature one\n\n### Fixed\n\n- bug two\n\n## [0.8.0] - 2026-10-01\n\n- old\n`,
  );
  // Only the value changes.
  assert.equal(read(dir, ".claude-plugin/plugin.json"), PLUGIN.replace("0.8.0", "0.9.0"));
  assert.deepEqual(checkRelease(log, read(dir, ".claude-plugin/plugin.json")), []);
});

test("release commits only the two files and tags annotated", () => {
  const dir = releaseRepo();
  assert.equal(release(dir, "0.9.0").code, 0);
  assert.equal(git(dir, "log", "-1", "--format=%s").out.trim(), "chore(release): v0.9.0");
  assert.equal(git(dir, "cat-file", "-t", "v0.9.0").out.trim(), "tag");
  const files = git(dir, "show", "--name-only", "--format=", "HEAD").out.trim().split(/\r?\n/).sort();
  assert.deepEqual(files, [".claude-plugin/plugin.json", "CHANGELOG.md"]);
  assert.equal(git(dir, "status", "--porcelain").out.trim(), "");
});

test("release refuses an empty Unreleased and writes nothing", () => {
  const dir = releaseRepo("# Changelog\n\n## Unreleased\n\n### Added\n\n## [0.8.0] - 2026-10-01\n\n- old\n");
  const before = git(dir, "rev-parse", "HEAD").out;
  const r = release(dir, "0.9.0");
  assert.equal(r.code, 1);
  assert.match(r.out, /no entry/);
  assert.equal(git(dir, "status", "--porcelain").out.trim(), "");
  assert.equal(git(dir, "rev-parse", "HEAD").out, before);
  assert.equal(git(dir, "tag", "-l").out.trim(), "");
});

test("release refuses a dirty tree and a branch other than main", () => {
  const dir = releaseRepo();
  writeFileSync(join(dir, "stray.txt"), "x");
  const r = release(dir, "0.9.0");
  assert.equal(r.code, 1);
  assert.match(r.out, /not clean/);
  assert.equal(read(dir, ".claude-plugin/plugin.json"), PLUGIN);
  rmSync(join(dir, "stray.txt"));
  git(dir, "checkout", "-q", "-b", "topic");
  const b = release(dir, "0.9.0");
  assert.equal(b.code, 1);
  assert.match(b.out, /not main/);
});

test("release refuses a malformed version and one not greater", () => {
  const dir = releaseRepo();
  for (const v of ["0.9", "v0.9.0", "0.8.0", "0.7.9"]) {
    const r = release(dir, v);
    assert.equal(r.code, 1, v);
    assert.equal(git(dir, "status", "--porcelain").out.trim(), "", v);
  }
  assert.equal(git(dir, "tag", "-l").out.trim(), "");
  // Numeric, not lexical: 0.10.0 > 0.8.0.
  assert.equal(release(dir, "0.10.0").code, 0);
});

test("release prints the commands and a notes file holding exactly the version's section", () => {
  const dir = releaseRepo();
  const r = release(dir, "0.9.0");
  assert.match(r.out, /git push origin main/);
  assert.match(r.out, /git push origin v0\.9\.0/);
  const m = /gh release create v0\.9\.0 --title v0\.9\.0 --notes-file (.+) --verify-tag/.exec(r.out);
  assert.ok(m, r.out);
  const notes = readFileSync(m[1].trim(), "utf8");
  assert.match(notes, /^## \[0\.9\.0\] - \d{4}-\d{2}-\d{2}\n\n### Added\n\n- feature one\n\n### Fixed\n\n- bug two\n$/);
  assert.ok(!notes.includes("0.8.0"));
  rmSync(dirname(m[1].trim()), { recursive: true, force: true });
});

test("release writes LF only, even from a CRLF CHANGELOG", () => {
  const dir = releaseRepo(LOG.replace(/\n/g, "\r\n"));
  assert.equal(release(dir, "0.9.0").code, 0);
  assert.ok(!read(dir, "CHANGELOG.md").includes("\r"));
});
