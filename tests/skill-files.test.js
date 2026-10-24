"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { ROOT } = require("./helpers.js");

const dir = join(ROOT, "skills", "orchestration");
const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
const others = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "SKILL.md");

// The sub-files are read with the Read tool: only SKILL.md gets its
// ${CLAUDE_PLUGIN_ROOT} and ${user_config.*} substituted, so a pointer to a
// missing file, or a file nobody points to, silently loses its text.
test("every sub-file named in SKILL.md exists", () => {
  const named = [...skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/orchestration\/([\w.-]+\.md)/g)];
  assert.ok(named.length > 0);
  for (const [, name] of named) assert.ok(existsSync(join(dir, name)), name);
});

test("every sub-file is named in SKILL.md", () => {
  assert.ok(others.length > 0);
  for (const name of others) {
    assert.ok(skill.includes(`\${CLAUDE_PLUGIN_ROOT}/skills/orchestration/${name}`), name);
  }
});

test("sub-files hold no substituted placeholder", () => {
  for (const name of others) {
    const text = readFileSync(join(dir, name), "utf8");
    assert.ok(!text.includes("${CLAUDE_PLUGIN_ROOT}"), name);
    assert.ok(!text.includes("${user_config."), name);
  }
});

test("SKILL.md keeps its numbered sections 1 to 8", () => {
  for (let n = 1; n <= 8; n++) {
    assert.match(skill, new RegExp(`^## ${n}\\. `, "m"), `## ${n}.`);
  }
});
