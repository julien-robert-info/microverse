"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { ROOT, makeRepo, script } = require("./helpers.js");

// The skeleton `init` offers to write; the Board test cannot read plugin
// files, so its shape is pinned here against the shipped contract.
const contract = readFileSync(join(ROOT, "skills", "orchestration", "state-file.md"), "utf8");
const skeleton = /```markdown\n([\s\S]*?)```/.exec(contract)?.[1] ?? "";

test("the skeleton has the three fixed headings and the table header, in order", () => {
  const headings = skeleton.split("\n").filter((l) => l.startsWith("#"));
  assert.deepEqual(headings, ["## Missions", "## Questions", "## Resume"]);
  assert.ok(skeleton.includes("| Id | Branch | State |"));
});

test("the skeleton is short and holds no data row, bullet or placeholder", () => {
  const lines = skeleton.split("\n").filter((l) => l.trim());
  assert.ok(lines.length < 15, `${lines.length} lines`);
  const rows = lines.filter((l) => l.startsWith("|"));
  assert.equal(rows.length, 2, "header and separator only");
  assert.ok(!lines.some((l) => /^[-*]\s/.test(l)));
  assert.ok(!skeleton.includes("${"));
});

test("the contract holds exactly one markdown block, the skeleton", () => {
  assert.equal(contract.split("```markdown").length, 2);
});

test("the Board test keeps a copy of the skeleton identical to the shipped one", () => {
  const source = readFileSync(join(ROOT, "hooks", "board", "tests", "state-file.test.tsx"), "utf8");
  const copy = /const SKELETON = `([^`]*)`/.exec(source)?.[1];
  assert.equal(
    copy,
    skeleton,
    "SKELETON in hooks/board/tests/state-file.test.tsx and the markdown block of skills/orchestration/state-file.md differ: update the one that is stale",
  );
});

test("orch-status shows the mission and the question of the filled skeleton", () => {
  const { dir } = makeRepo({ checks: [] });
  const filled = skeleton
    .replace("| --- | --- | --- |\n", "| --- | --- | --- |\n| M1 | `feat/example` | merged `abc1234` |\n")
    .replace("## Questions\n", "## Questions\n\n- Q1 (notes/M1.md) : Which schema?\n");
  writeFileSync(join(dir, "CLAUDE.local.md"), filled);
  const r = script("orch-status", [], dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ {2}M1 · `feat\/example` · merged `abc1234`$/m);
  assert.match(r.out, /^ {2}\? Q1 \(notes\/M1\.md\) : Which schema\?$/m);
});
