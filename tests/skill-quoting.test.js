"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { ROOT } = require("./helpers.js");

const skill = (name) => readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf8");

// A plugin option or the command's arguments are substituted into the text
// before the model writes the command: with single quotes around the value, an
// apostrophe in it closes the quote early unless the model is told to escape it.
test("every skill that quotes a substituted value tells how to write an apostrophe", () => {
  for (const name of ["status", "orchestration"]) {
    const text = skill(name);
    assert.match(text, /'\$\{user_config\.quota_file\}'/, name);
    assert.ok(text.includes("`'\\''`"), `${name}: no apostrophe rule`);
  }
  const orchestration = skill("orchestration");
  assert.match(orchestration, /--voice '\$\{user_config\.speak_voice\}'/);
  assert.match(orchestration, /same quoting rule/);
});
