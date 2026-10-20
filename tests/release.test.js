"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { ROOT } = require("./helpers.js");

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATED = /^\[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/;

// Returns the list of problems between a CHANGELOG and a plugin manifest.
function checkRelease(changelog, pluginJson) {
  const problems = [];
  const headings = changelog.split(/\r?\n/).filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim());
  if (!headings.includes("Unreleased")) problems.push("no Unreleased section");
  const versions = [];
  for (const h of headings) {
    if (h === "Unreleased") continue;
    const m = DATED.exec(h);
    if (!m) { problems.push(`heading without [x.y.z] - YYYY-MM-DD: ${h}`); continue; }
    if (!SEMVER.test(m[1])) problems.push(`not SemVer: ${m[1]}`);
    versions.push(m[1]);
  }
  if (versions.length === 0) problems.push("no dated version");
  const { version } = JSON.parse(pluginJson);
  if (!SEMVER.test(String(version))) problems.push(`plugin.json version is not SemVer: ${version}`);
  if (versions.length && versions[0] !== version) problems.push(`first version ${versions[0]} != plugin.json ${version}`);
  return problems;
}

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
