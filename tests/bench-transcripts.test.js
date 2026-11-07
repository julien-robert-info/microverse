"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { passCost, scanLeaks, passOutcome, passActivity } = require("../tools/bench/transcripts.js");
const { projectSlug } = require("../scripts/orch-lib.js");

// Synthetic values only: a fake slot, a fake source and fake hashes.
const SLOT = "C:/Work/Bench-Slot";
const SOURCE = "C:/src/Example-App";
const TIP = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const MERGE = "fedcba9876543210fedcba9876543210fedcba98";
const SESSION = "11111111-2222-3333-4444-555555555555";

// A projects folder with the slot's folder in it; `others` is another project's.
function makeProjects() {
  const projects = mkdtempSync(join(tmpdir(), "bench-transcripts-"));
  const dir = join(projects, projectSlug(SLOT));
  mkdirSync(join(dir, SESSION, "subagents"), { recursive: true });
  return { projects, dir };
}

const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

let seq = 0;
// An assistant line with usage; `usage` is the usage object as given.
function request(model, usage, { id = `msg_${++seq}`, requestId = `req_${seq}`, content = [] } = {}) {
  return { type: "assistant", timestamp: "2026-11-10T10:00:00.000Z", requestId, message: { id, model, usage, content } };
}
const use = (input, output, extra = {}) => ({ input_tokens: input, output_tokens: output, ...extra });

function addAgent(dir, id, type, lines) {
  const base = join(dir, SESSION, "subagents", `agent-${id}`);
  writeFileSync(`${base}.jsonl`, jsonl(lines));
  writeFileSync(`${base}.meta.json`, JSON.stringify({ agentType: type, description: "task" }));
}
const writeMain = (dir, lines) => writeFileSync(join(dir, `${SESSION}.jsonl`), jsonl(lines));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

// Principal Sonnet 5.5 + morty (Sonnet 5.5) + council (Opus 5.5).
// Sonnet 5.5 $/MTok: 2, 2.5, 4, 0.1, 10. Opus 5.5: 4, 5, 8, 0.2, 20.
function fixtureT1() {
  const { projects, dir } = makeProjects();
  writeMain(dir, [
    request("claude-sonnet-5-5", use(1000, 500, { cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 4000 }, cache_read_input_tokens: 10000 })),
  ]);
  addAgent(dir, "aaa1", "microverse:morty", [request("claude-sonnet-5-5", use(200, 100))]);
  addAgent(dir, "bbb2", "microverse:council", [request("claude-opus-5-5", use(500, 200, { cache_creation_input_tokens: 1000 }))]);
  return { projects, dir };
}

test("T1 cost by role and model matches the hand computation", () => {
  const { projects } = fixtureT1();
  const c = passCost({ projects, slot: SLOT, session: SESSION });
  // main: 1000*2 + 2000*2.5 + 4000*4 + 10000*0.1 + 500*10 = 2000+5000+16000+1000+5000 = 29000 / 1e6
  const main = c.byRole.orchestrator.models["claude-sonnet-5-5"];
  assert.deepEqual(main.tokens, [1000, 2000, 4000, 10000, 500]);
  close(main.usd, 0.029);
  // morty: 200*2 + 100*10 = 1400 / 1e6
  const morty = c.byRole["microverse:morty"].models["claude-sonnet-5-5"];
  assert.deepEqual(morty.tokens, [200, 0, 0, 0, 100]);
  close(morty.usd, 0.0014);
  // council: 500*4 + 1000*5 (5 min write) + 200*20 = 2000+5000+4000 = 11000 / 1e6
  const council = c.byRole["microverse:council"].models["claude-opus-5-5"];
  assert.deepEqual(council.tokens, [500, 1000, 0, 0, 200]);
  close(council.usd, 0.011);
  assert.equal(c.byRole.orchestrator.requests, 1);
  close(c.usd, 0.029 + 0.0014 + 0.011);
  assert.deepEqual(c.unpriced, []);
  assert.equal(c.usdReported, null);
});

test("T1b points need their ratios, which are copied to the output", () => {
  const { projects } = fixtureT1();
  const none = passCost({ projects, slot: SLOT, session: SESSION });
  assert.equal(none.weekPts, null);
  assert.equal(none.fiveHourPts, null);
  assert.equal(none.ratios, null);
  const c = passCost({ projects, slot: SLOT, session: SESSION, ratios: { ratio7: 0.375, ratio5: 3.12 } });
  close(c.weekPts, c.usd * 0.375);
  close(c.fiveHourPts, c.usd * 3.12);
  assert.deepEqual(c.ratios, { ratio7: 0.375, ratio5: 3.12 });
  assert.throws(() => passCost({ projects, slot: SLOT, session: SESSION, ratios: { ratio7: 0.4 } }), /ratio5/);
});

test("T1c usdReported is the total_cost_usd of the last result, not the first", () => {
  const { projects } = fixtureT1();
  const stream = [
    { type: "result", subtype: "success", total_cost_usd: 1.5 },
    { type: "result", subtype: "success", total_cost_usd: 2.5 },
    { type: "result", subtype: "success", total_cost_usd: 4.25 },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  const c = passCost({ projects, slot: SLOT, session: SESSION, stream });
  assert.equal(c.usdReported, 4.25);
  close(c.usd, 0.0414); // the computed cost is kept next to it, never replaced
});

test("T1d Haiku 5.5 is priced by the size of each step", () => {
  const { projects, dir } = makeProjects();
  // Small tier $/MTok 0.1 / 0.5 and large tier 0.5 / 2.5; the sum (151000) would be large.
  const steps = [
    { type: "message", ...use(150000, 100) },
    { type: "message", ...use(1000, 100) },
  ];
  writeMain(dir, [request("claude-haiku-5-5", use(151000, 200, { iterations: steps }))]);
  const c = passCost({ projects, slot: SLOT, session: SESSION });
  // 150000*0.5 + 100*2.5 + 1000*0.1 + 100*0.5 = 75000+250+100+50 = 75400 / 1e6
  close(c.byRole.orchestrator.models["claude-haiku-5-5"].usd, 0.0754);
});

test("T2 an advisor_message step is counted to the advisor role with its model", () => {
  const { projects, dir } = makeProjects();
  const iterations = [
    { type: "message", ...use(100, 50) },
    { type: "advisor_message", model: "claude-opus-5-5", ...use(3000, 400) },
  ];
  writeMain(dir, [request("claude-sonnet-5-5", use(100, 50, { iterations }))]);
  const c = passCost({ projects, slot: SLOT, session: SESSION });
  // advisor: 3000*4 + 400*20 = 20000 / 1e6
  const adv = c.byRole.advisor.models["claude-opus-5-5"];
  assert.deepEqual(adv.tokens, [3000, 0, 0, 0, 400]);
  close(adv.usd, 0.02);
  assert.equal(c.byRole.advisor.requests, 1);
  // executor: 100*2 + 50*10 = 700 / 1e6, without the advisor's tokens
  const exec = c.byRole.orchestrator.models["claude-sonnet-5-5"];
  assert.deepEqual(exec.tokens, [100, 0, 0, 0, 50]);
  close(exec.usd, 0.0007);
  close(c.usd, 0.0207);
});

test("T3 a model without a price is listed, keeps its tokens and costs nothing in the total", () => {
  const { projects, dir } = makeProjects();
  writeMain(dir, [request("claude-sonnet-5-5", use(1000, 0)), request("claude-mystery-9", use(7000, 300))]);
  const c = passCost({ projects, slot: SLOT, session: SESSION });
  assert.deepEqual(c.unpriced, ["claude-mystery-9"]);
  const m = c.byRole.orchestrator.models["claude-mystery-9"];
  assert.deepEqual(m.tokens, [7000, 0, 0, 0, 300]);
  assert.equal(m.usd, null);
  close(c.usd, 0.002);
});

test("T4 two lines of the same streamed message count once, at the maximum", () => {
  const { projects, dir } = makeProjects();
  const ids = { id: "msg_dup", requestId: "req_dup" };
  writeMain(dir, [
    request("claude-sonnet-5-5", use(1000, 10), ids),
    request("claude-sonnet-5-5", use(1000, 400, { cache_read_input_tokens: 5000 }), ids),
    request("claude-sonnet-5-5", use(900, 20), ids),
  ]);
  const c = passCost({ projects, slot: SLOT, session: SESSION });
  assert.equal(c.byRole.orchestrator.requests, 1);
  assert.deepEqual(c.byRole.orchestrator.models["claude-sonnet-5-5"].tokens, [1000, 0, 0, 5000, 400]);
});

test("a missing transcript is an error that does not name the slot", () => {
  const { projects } = makeProjects();
  assert.throws(
    () => passCost({ projects, slot: SLOT, session: "99999999-0000-0000-0000-000000000000" }),
    (e) => /not found/.test(e.message) && !/bench-slot/i.test(e.message),
  );
});

// --- leaks ----------------------------------------------------------------

const call = (input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: `tu_${++seq}`, name: "Bash", input }] } });
const result = (content) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content }] } });
const scan = (projects, extra = {}) =>
  scanLeaks({ projects, slot: SLOT, session: SESSION, source: SOURCE, forbiddenPaths: ["C:/Backups/Suite"], hashes: { tip: TIP, merge: MERGE }, ...extra });

test("T5 the source path is found in its three forms, in any case", () => {
  const { projects, dir } = makeProjects();
  writeMain(dir, [
    { type: "summary" },
    call({ command: "cat C:/SRC/example-app/a.ts" }),
    call({ command: "type C:\\Src\\EXAMPLE-APP\\b.ts" }),
    result("read /c/src/Example-App/c.ts"),
    result([{ type: "text", text: "nothing here C:/src/Example-App-Bench/x" }]),
  ]);
  const f = scan(projects);
  assert.deepEqual(f, [
    { needle: "source", file: `${SESSION}.jsonl`, line: 2 },
    { needle: "source", file: `${SESSION}.jsonl`, line: 3 },
    { needle: "source", file: `${SESSION}.jsonl`, line: 4 },
  ]);
});

test("T5b a forbidden folder and a subagent transcript are scanned", () => {
  const { projects, dir } = makeProjects();
  writeMain(dir, [call({ command: "ls" })]);
  addAgent(dir, "ccc3", "microverse:morty", [call({ command: "cat c:\\backups\\suite\\old.sql" })]);
  assert.deepEqual(scan(projects), [{ needle: "forbidden:0", file: `${SESSION}/subagents/agent-ccc3.jsonl`, line: 1 }]);
});

test("T5c the slot's own project folder is allowed, another project's is flagged", () => {
  const { projects, dir } = makeProjects();
  const root = "Z:/fakehome/.claude/projects";
  const own = `${root}/${projectSlug(SLOT)}/${SESSION}.jsonl`;
  const other = `${root}/${projectSlug(SOURCE)}/zzz.jsonl`;
  writeMain(dir, [call({ command: `node orch-usage ${own}` }), result(`ls ${other}`), call({ command: `ls ${root}/` })]);
  assert.deepEqual(scan(projects), [{ needle: "project", file: `${SESSION}.jsonl`, line: 2 }]);
});

test("T5d a hash is found whole, in full and as a 10-character prefix", () => {
  const { projects, dir } = makeProjects();
  writeMain(dir, [
    call({ command: `git show ${TIP}:tests/a.test.js` }),
    result(`commit ${MERGE.slice(0, 10)} (HEAD)`),
    call({ command: `git show ${TIP.slice(0, 10)}..${MERGE.toUpperCase()}` }),
  ]);
  assert.deepEqual(
    scan(projects).map((x) => `${x.line}:${x.needle}`),
    ["1:tip", "2:merge10", "3:tip10", "3:merge"],
  );
});

test("T5e a hash inside a longer word is not found; a prefix of digits only is ignored", () => {
  const { projects, dir } = makeProjects();
  writeMain(dir, [call({ command: `echo x${TIP.slice(0, 10)}y ${MERGE}00 ${TIP}beef` }), call({ command: "echo 0285480123 and 0285480123456789" })]);
  assert.deepEqual(scan(projects), []);
  // A hash whose first 10 characters are digits: only the full hash is searched.
  const digits = "0123456789abcdef0123456789abcdef01234567";
  writeMain(dir, [call({ command: "echo 0123456789 then 0123456789 sequence" }), call({ command: `git show ${digits}` })]);
  assert.deepEqual(scan(projects, { hashes: { tip: digits } }), [{ needle: "tip", file: `${SESSION}.jsonl`, line: 2 }]);
});

test("T5f text outside tool calls and results is not scanned", () => {
  const { projects, dir } = makeProjects();
  writeMain(dir, [{ type: "assistant", message: { content: [{ type: "text", text: `I will not read ${SOURCE}` }] } }]);
  assert.deepEqual(scan(projects), []);
});

test("T5g findings never carry the text found", () => {
  const { projects, dir } = makeProjects();
  writeMain(dir, [call({ command: `cat ${SOURCE}/secret.ts ${TIP}` }), result(`Z:/fakehome/.claude/projects/${projectSlug(SOURCE)}/a.jsonl`)]);
  const f = scan(projects);
  assert.ok(f.length >= 3);
  const text = JSON.stringify(f).toLowerCase();
  for (const bit of ["example-app", "secret", TIP.slice(0, 10), projectSlug(SOURCE)]) assert.ok(!text.includes(bit), bit);
  for (const x of f) assert.deepEqual(Object.keys(x), ["needle", "file", "line"]);
  // An invalid hash is refused without echoing it.
  assert.throws(
    () => scan(projects, { hashes: { tip: "not-a-hash-zzzzzzzzzz" } }),
    (e) => !e.message.includes("zzzzzzzzzz"),
  );
});

// --- outcome ----------------------------------------------------------------

const res = (extra) => ({ type: "result", subtype: "success", is_error: false, result: "Merged.", permission_denials: [], total_cost_usd: 1, ...extra });
const lines = (...events) => events.map((e) => JSON.stringify(e)).join("\n");
const guardReason =
  "Quota: no new agent: 13 points left before the 5h limit, 0 running and about 15 per agent. 5h 87 % (reading 3 min old), week 33 %, 0 running, ~15 points per agent. Confirm to launch anyway.";

test("T6 budget, quota abort, no-merge, done and the last of three results", () => {
  assert.equal(passOutcome({ stream: lines(res({ subtype: "error_max_budget_usd", is_error: true })), mainAdvanced: false }), "budget");

  const refused = result(guardReason);
  assert.equal(passOutcome({ stream: lines(refused, res({ result: "Stopped." })), mainAdvanced: false }), "aborted-quota");

  assert.equal(passOutcome({ stream: lines(res()), mainAdvanced: false }), "no-merge");
  assert.equal(passOutcome({ stream: lines(res()), mainAdvanced: true }), "done");

  // The last result decides, not the first nor the middle one.
  const three = lines(res({ subtype: "error_max_budget_usd" }), res({ subtype: "error_during_execution", is_error: true }), res());
  assert.equal(passOutcome({ stream: three, mainAdvanced: true }), "done");
  const three2 = lines(res(), res(), res({ subtype: "error_max_budget_usd" }));
  assert.equal(passOutcome({ stream: three2, mainAdvanced: true }), "budget");
});

test("T6b asked, error, a hook note that is not a refusal, no result", () => {
  assert.equal(passOutcome({ stream: lines(res({ result: "Shall I merge it?" })), mainAdvanced: false }), "asked");
  const denied = res({ permission_denials: [{ tool_name: "AskUserQuestion", tool_input: {} }] });
  assert.equal(passOutcome({ stream: lines(denied), mainAdvanced: false }), "asked");
  assert.equal(passOutcome({ stream: lines(res({ subtype: "error_during_execution", is_error: true })), mainAdvanced: false }), "error");
  assert.equal(passOutcome({ stream: "", mainAdvanced: false }), "error");
  assert.equal(passOutcome({ stream: lines(result("Quota: smooth out: no new agent until the counter drops back under the line."), res()), mainAdvanced: false }), "no-merge");
  assert.throws(() => passOutcome({ stream: lines(res()), mainAdvanced: "yes" }), /boolean/);
});

// --- activity ---------------------------------------------------------------

test("T7 SendMessage calls, agents by type and permission denials", () => {
  const { projects, dir } = makeProjects();
  const send = (id) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "SendMessage", input: { to: "a" } }] } });
  writeMain(dir, [send("tu_a"), send("tu_a"), send("tu_b"), call({ command: "ls" })]);
  addAgent(dir, "ddd4", "microverse:morty", [send("tu_c")]);
  addAgent(dir, "eee5", "microverse:morty", [call({ command: "ls" })]);
  addAgent(dir, "fff6", "microverse:council", [call({ command: "ls" })]);
  const stream = lines(res({ permission_denials: [{}] }), res({ permission_denials: [{}, {}] }));
  assert.deepEqual(passActivity({ projects, slot: SLOT, session: SESSION, stream }), {
    agents: { "microverse:morty": 2, "microverse:council": 1 },
    sendMessages: 3,
    permissionDenials: 2,
  });
  assert.equal(passActivity({ projects, slot: SLOT, session: SESSION }).permissionDenials, null);
});
