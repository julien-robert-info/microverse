"use strict";

// Runs a sibling script of bin/ with --json and gives its object without `v`,
// or { error } when it failed. orch-quota and orch-usage print their JSON error
// on stdout, with a non-zero exit code, so stdout is parsed whatever the code.
const { join } = require("node:path");
const { run, sanitize } = require("./orch-lib.js");

function siblingJson(name, args, cwd) {
  const r = run(process.execPath, [join(__dirname, "..", "bin", name), ...args, "--json"], { cwd });
  let data = null;
  try {
    data = JSON.parse(r.out);
  } catch {
    // not JSON: the message is whatever the script printed
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { error: sanitize((r.out + r.err).trim()) || `${name} exited with code ${r.code}` };
  const { v, ...rest } = data;
  if (r.code !== 0 && typeof rest.error !== "string") return { error: `${name} exited with code ${r.code}` };
  return rest;
}

module.exports = { siblingJson };
