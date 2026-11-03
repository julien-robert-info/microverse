"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { ROOT } = require("./helpers.js");

// The body of the top-level job `name` in a workflow file, or null.
function jobBlock(ci, name) {
  const m = new RegExp(`^  ${name}:[^\\n]*\\n((?:(?: {3,}[^\\n]*)?\\n)*)`, "m").exec(ci);
  return m ? m[1] : null;
}

// The numbers of a flow list such as `node: [22, 24]`, or null.
function numberList(block, key) {
  const m = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`, "m").exec(block ?? "");
  return m ? m[1].split(",").map((s) => Number(s.trim())) : null;
}

// What the CI configuration must agree with `pkg.testedWith` on; returns the
// list of problems, empty when the three texts are consistent. Regular
// expressions rather than a YAML parser: the repository has no dependency.
function checkPortability(ci, readme, pkg) {
  const problems = [];
  const { claudeCode, node } = pkg.testedWith;
  if (/claude-code@\d/.test(ci)) problems.push("ci.yml hard-codes a Claude Code version (read testedWith.claudeCode instead)");
  const test_ = jobBlock(ci, "test");
  const listed = numberList(test_, "node");
  if (!listed) problems.push("ci.yml: no node list in the matrix of the test job");
  else if (listed.join(",") !== node.join(",")) problems.push(`ci.yml: test job runs Node ${listed.join(", ")}, testedWith.node is ${node.join(", ")}`);
  const clean = jobBlock(ci, "clean-install");
  const cleanNode = /node-version:\s*(\d+)/.exec(clean ?? "");
  if (!cleanNode) problems.push("ci.yml: clean-install job has no node-version");
  else if (Number(cleanNode[1]) !== Math.max(...node)) problems.push(`ci.yml: clean-install runs Node ${cleanNode[1]}, the highest tested is ${Math.max(...node)}`);
  const req = /^## Requirements\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme);
  if (!req) problems.push("README: no Requirements section");
  else {
    if (!req[1].includes(`Claude Code ${claudeCode}`)) problems.push(`README Requirements: does not cite Claude Code ${claudeCode}`);
    if (!new RegExp(`Node\\.js ${Math.min(...node)}\\b`).test(req[1])) problems.push(`README Requirements: does not cite Node.js ${Math.min(...node)}`);
  }
  return problems;
}

const pkg = { testedWith: { claudeCode: "2.1.306", node: [22, 24] } };
const goodCi = [
  "jobs:",
  "  test:",
  "    strategy:",
  "      matrix:",
  "        os: [ubuntu-latest]",
  "        node: [22, 24]",
  "    steps:",
  "      - run: npm test",
  "  clean-install:",
  "    steps:",
  "      - uses: actions/setup-node@v4",
  "        with:",
  "          node-version: 24",
  "      - run: npm i -g @anthropic-ai/claude-code@${{ env.CLAUDE_CODE_VERSION }}",
  "",
].join("\n");
const goodReadme = "# X\n\n## Requirements\n\n- Claude Code 2.1.306 or newer.\n- Node.js 22 or newer.\n\n## Usage\n\nNode.js 18\n";

test("T1: the repository's ci.yml, README and package.json agree", () => {
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const real = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(checkPortability(ci, readme, real), []);
  assert.deepEqual(checkPortability(goodCi, goodReadme, pkg), []);
});

test("T2: a hard-coded Claude Code version in ci.yml fails", () => {
  const ci = goodCi.replace("${{ env.CLAUDE_CODE_VERSION }}", "1.2.3");
  assert.match(checkPortability(ci, goodReadme, pkg).join("\n"), /hard-codes a Claude Code version/);
});

test("T3: a Node list that differs from testedWith.node fails", () => {
  const ci = goodCi.replace("node: [22, 24]", "node: [20, 22]");
  assert.match(checkPortability(ci, goodReadme, pkg).join("\n"), /runs Node 20, 22/);
  // A list in another job does not count for the test job.
  const other = goodCi.replace("node: [22, 24]", "os: [x]").replace("  clean-install:", "  lint:\n    node: [22, 24]\n  clean-install:");
  assert.match(checkPortability(other, goodReadme, pkg).join("\n"), /no node list/);
  const low = goodCi.replace("node-version: 24", "node-version: 22");
  assert.match(checkPortability(low, goodReadme, pkg).join("\n"), /clean-install runs Node 22/);
});

test("T4: a Requirements section without the tested versions fails", () => {
  const wrongClaude = goodReadme.replace("2.1.306", "2.0.1");
  assert.match(checkPortability(goodCi, wrongClaude, pkg).join("\n"), /Claude Code 2\.1\.306/);
  const wrongNode = goodReadme.replace("Node.js 22", "Node.js 20");
  assert.match(checkPortability(goodCi, wrongNode, pkg).join("\n"), /Node\.js 22/);
  // Versions cited outside the section do not count.
  const outside = "## Requirements\n\n- Git.\n\n## Usage\n\nClaude Code 2.1.306, Node.js 22\n";
  assert.equal(checkPortability(goodCi, outside, pkg).length, 2);
});
