"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { ROOT } = require("./helpers.js");

// On a POSIX pipe stdout is written asynchronously, so `process.exit` right
// after a write cuts the output (a JSON cut at 8192 bytes is invalid). The
// failure cannot be reproduced on Windows, where pipes are synchronous, hence
// a check of the sources rather than of the output.
//   scripts/orch-lib.js: `fail` exits mid-flow for its callers, after a
//   synchronous write of its message to stderr.
const ALLOWED = new Set(["scripts/orch-lib.js"]);

function sources() {
  const files = [];
  for (const dir of ["scripts", "bin"]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (dir === "scripts" && !name.endsWith(".js")) continue;
      files.push(`${dir}/${name}`);
    }
  }
  return files;
}

test("no script ends the process with process.exit() once it may have written", () => {
  const offenders = [];
  for (const file of sources()) {
    if (ALLOWED.has(file)) continue;
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .forEach((l, i) => {
        if (/\bprocess\.exit\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)) offenders.push(`${file}:${i + 1}`);
      });
  }
  assert.deepEqual(offenders, [], "use process.exitCode and return: process.exit cuts a pipe's pending output");
});

test("the exemption of orch-lib is the synchronous write of fail()", () => {
  const src = readFileSync(join(ROOT, "scripts", "orch-lib.js"), "utf8");
  const body = /function fail\(message\) \{([\s\S]*?)\n\}/.exec(src)[1];
  assert.match(body, /writeSync\(2,/);
  assert.doesNotMatch(body, /console\.\w+\(/);
  assert.equal(src.match(/\bprocess\.exit\s*\(/g).length, 1);
});

test("fail() still prints its message and exits with 2", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "orch-trust"), "--commands", "bogus"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: orch-trust --commands setup\|checks/);
});
