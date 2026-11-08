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
//   judge           blind Opus judgment of the passes of results/<id> (--id), in a seeded
//                   random order, under the spend guard (--cap-week, --cap-five points).
//   run             one pass of `claude -p` in the copy, nobody present: time limit, kept diff,
//                   grade, cost; one line appended to results/<id>/passes.jsonl.
//   campaign        the grid tasks x organisations x passes, one pass after the other under
//                   the same caps; resumes where passes.jsonl stops; never calls the judge.
//   report          tables of a campaign folder (--results), against another with --compare.
// The suite file, its briefs and its results live outside any repository.

const { join } = require("node:path");
const { failAsJson, fail, loadCalibration, parseArgs } = require("../../scripts/orch-lib.js");
const { runCampaign } = require("./campaign.js");
const { prepare } = require("./copy.js");
const { grade, validate } = require("./grade.js");
const { judgeCampaign } = require("./judge.js");
const { buildReport, renderMarkdown } = require("./report.js");
const { runPass } = require("./run.js");
const { loadSuite } = require("./suite.js");

const USAGE = [
  "usage: orch-bench.js prepare|validate|grade --suite <file> [--task <id>] [--org <id>] [--json]",
  "       orch-bench.js run --suite <file> --task <id> --org <id> [--id <campaign>] [--model sonnet] [--timeout-minutes 120] [--claude <exe>] [--json]",
  "       orch-bench.js campaign --suite <file> --id <campaign> [--tasks a,b] [--orgs O0,O1] [--passes n] [--cap-week 10] [--cap-five 90] [--claude <exe>] [--json]",
  "       orch-bench.js report --results <campaign dir> [--compare <dir>] [--json]",
  "       orch-bench.js judge --suite <file> --id <campaign> [--cap-week 10] [--cap-five 90] [--seed <hex>] [--claude <exe>] [--projects <dir>] [--json]",
].join("\n");

// Blind judge of a campaign's passes. Prints one line per judgment (task,
// status, overall, usd) and the total, never the organisation.
async function judgeCommand(opts) {
  if (typeof opts.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(opts.id)) fail(`--id <campaign> is required\n${USAGE}`);
  const num = (k, d) => {
    if (opts[k] === undefined) return d;
    const n = Number(opts[k]);
    if (!Number.isFinite(n) || n <= 0) fail(`--${k} must be a positive number`);
    return n;
  };
  let res;
  try {
    const suite = loadSuite(opts.suite);
    res = await judgeCampaign({
      suite,
      campaignDir: join(suite.results, opts.id),
      capWeek: num("cap-week", 10),
      capFive: num("cap-five", 90),
      seed: typeof opts.seed === "string" ? opts.seed : undefined,
      claude: typeof opts.claude === "string" ? opts.claude : undefined,
      projects: typeof opts.projects === "string" ? opts.projects : undefined,
      // Test hook, not in the usage: it moves the home folder the judge folder is checked against.
      home: typeof opts.home === "string" ? opts.home : undefined,
    });
  } catch (e) {
    fail(e.message);
  }
  // A pass left without a judgment because its kept diff is gone is a failure to report, not a quiet gap.
  if (res.stopped || res.judgments.some((j) => j.status === "skipped")) process.exitCode = 1;
  if (opts.json) {
    console.log(JSON.stringify({ v: 1, ...res }));
    return;
  }
  const lines = res.judgments.map((j) => (j.status === "skipped" ? `${j.task} skipped: ${j.reason}` : `${j.task} ${j.status} overall=${j.overall ?? "-"} usd=${j.usd.toFixed(3)}`));
  lines.push(`total usd=${res.totalUsd.toFixed(3)}${res.stopped ? ` (stopped: ${res.stopped})` : ""}`);
  console.log(lines.join("\n"));
}

const str = (v) => (typeof v === "string" ? v : undefined);

// The options the run and the campaign share. `--allow-port` and `--projects`
// are test hooks, not in the usage.
function runOptions(opts) {
  const num = (k) => {
    if (opts[k] === undefined) return undefined;
    const n = Number(opts[k]);
    if (!Number.isFinite(n) || n <= 0) fail(`--${k} must be a positive number`);
    return n;
  };
  return {
    claude: str(opts.claude), projects: str(opts.projects), model: str(opts.model), timeoutMinutes: num("timeout-minutes"),
    allowPort: Boolean(opts["allow-port"]), capWeek: num("cap-week"), capFive: num("cap-five"), passes: num("passes"),
  };
}

// One pass. Prints task, organisation, outcome, usd and minutes.
async function runCommand(opts) {
  const task = str(opts.task);
  const org = str(opts.org);
  if (!task || !org) fail(`run needs --task <id> and --org <id>\n${USAGE}`);
  let line;
  try {
    const suite = loadSuite(opts.suite);
    const cal = loadCalibration();
    const id = str(opts.id) ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    if (!/^[A-Za-z0-9._-]+$/.test(id)) fail("--id may only hold letters, digits, dot, dash and underscore");
    const o = runOptions(opts);
    line = await runPass({ suite, taskId: task, orgId: org, campaignDir: join(suite.results, id), ratios: { ratio7: cal?.ratio7 ?? null, ratio5: cal?.ratio5 ?? null }, ...o });
  } catch (e) {
    fail(e.message);
  }
  if (opts.json) {
    console.log(JSON.stringify({ v: 1, pass: line }));
    return;
  }
  console.log(`${line.task} ${line.org} ${line.outcome} $${Number.isFinite(line.cost?.usd) ? line.cost.usd.toFixed(3) : "?"} ${line.minutes.toFixed(1)} min`);
}

// A grid under the quota cap; prints one line per pass, then what is left to judge.
async function campaignCommand(opts) {
  if (typeof opts.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(opts.id)) fail(`--id <campaign> is required\n${USAGE}`);
  const list = (v) => (typeof v === "string" ? v.split(",").filter(Boolean) : undefined);
  let res;
  try {
    const suite = loadSuite(opts.suite);
    res = await runCampaign({ suite, id: opts.id, campaignDir: join(suite.results, opts.id), tasks: list(opts.tasks), orgs: list(opts.orgs), ...runOptions(opts), log: opts.json ? undefined : (l) => console.log(l) });
  } catch (e) {
    fail(e.message);
  }
  if (res.stopped) process.exitCode = 1;
  if (opts.json) console.log(JSON.stringify({ v: 1, ...res }));
}

// Report of a campaign folder (and optionally the comparison with another).
function reportCommand(opts) {
  const dir = str(opts.results);
  if (!dir) fail(`report needs --results <campaign dir>\n${USAGE}`);
  let report;
  try {
    report = buildReport({ dir, compareDir: str(opts.compare) });
  } catch (e) {
    fail(e.message);
  }
  console.log(opts.json ? JSON.stringify({ v: 1, ...report }) : renderMarkdown(report));
}

function main(argv) {
  const opts = parseArgs(argv, { flags: ["json", "allow-port"] });
  if (opts.json) failAsJson();
  const [command] = opts._;
  const task = typeof opts.task === "string" ? opts.task : opts._[1];
  if (!["prepare", "validate", "grade", "judge", "run", "campaign", "report"].includes(command)) fail(command ? `${command}: not available in this tool yet\n${USAGE}` : USAGE);
  if (command === "report") return reportCommand(opts);
  if (typeof opts.suite !== "string") fail(`--suite <file> is required\n${USAGE}`);
  if ((command === "prepare" || command === "grade") && !task) fail(`${command} needs a task id\n${USAGE}`);
  if (command === "judge") return judgeCommand(opts);
  if (command === "run") return runCommand(opts);
  if (command === "campaign") return campaignCommand(opts);

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
