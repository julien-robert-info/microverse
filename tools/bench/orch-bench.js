"use strict";

// Maintainer tool (not on the plugin users' PATH, hence not in bin/): measures
// an organisation of agents on fixed tasks.
// node tools/bench/orch-bench.js prepare|validate|grade --suite <file> [--task <id>] [--org <id>] [--json]
//   prepare <task>  builds the throwaway copy at the suite's `slot`: one commit of the
//                   tree at the task's fork, no remote, the brief and a synthetic state
//                   file laid over it. `--org` also writes that organisation's file.
//                   The tree comes from `git archive`: a file marked `export-ignore`
//                   in .gitattributes is not in the copy.
//   validate        per task: the hidden oracle fails at the base, passes at the tip,
//                   the profile checks at the tip, the brief holds no forbidden pattern.
//   grade <task>    scores what the copy's `main` delivers (oracle, checks, scope, size).
// The suite file, its briefs and its results live outside any repository.

const { failAsJson, fail, parseArgs } = require("../../scripts/orch-lib.js");
const { prepare } = require("./copy.js");
const { grade, validate } = require("./grade.js");
const { loadSuite } = require("./suite.js");

const USAGE = "usage: orch-bench.js prepare|validate|grade --suite <file> [--task <id>] [--org <id>] [--json]";

function main(argv) {
  const opts = parseArgs(argv, { flags: ["json"] });
  if (opts.json) failAsJson();
  const [command] = opts._;
  const task = typeof opts.task === "string" ? opts.task : opts._[1];
  if (!["prepare", "validate", "grade"].includes(command)) fail(command ? `${command}: not available in this tool yet\n${USAGE}` : USAGE);
  if (typeof opts.suite !== "string") fail(`--suite <file> is required\n${USAGE}`);
  if ((command === "prepare" || command === "grade") && !task) fail(`${command} needs a task id\n${USAGE}`);

  let result;
  let text;
  try {
    const suite = loadSuite(opts.suite);
    if (command === "prepare") {
      result = prepare(suite, task, { org: typeof opts.org === "string" ? opts.org : null });
      text = `prepared ${result.task} in ${result.slot} (base ${result.base})`;
    } else if (command === "validate") {
      result = validate(suite, { task });
      text = result.tasks.map((t) => `${t.id}: ${t.ok ? "ok" : "FAIL"}${t.problems.length ? ` (${t.problems.join("; ")})` : ""}`).join("\n");
      if (!result.ok) process.exitCode = 1;
    } else {
      result = grade(suite, task);
      text = [
        `oracle: ${result.oracle.pass} pass, ${result.oracle.fail} fail`,
        `checks: ${Object.entries(result.checks).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`,
        `files ${result.filesChanged} (outside zone ${result.outsideZone}), +${result.added} -${result.deleted} (reference +${result.refAdded} -${result.refDeleted}), uncommitted ${result.uncommitted}`,
      ].join("\n");
    }
  } catch (e) {
    fail(e.message);
  }
  console.log(opts.json ? JSON.stringify(command === "prepare" ? { v: 1, ...result } : command === "grade" ? { v: 1, task, quality: result } : result) : text);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
