"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, approveProfile, makeRepo, script } = require("./helpers.js");

const tested = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).testedWith;
const tmp = (name) => mkdtempSync(join(tmpdir(), `microverse-${name}-`));
const MISSING_BIN = join(tmp("nobin"), "claude-absent.js");

// A transcript whose lines carry `versions` in order (the last one counts).
function transcript(...versions) {
  const file = join(tmp("transcript"), "session.jsonl");
  writeFileSync(file, versions.map((v) => JSON.stringify({ type: "user", version: v, message: { content: "x" } })).join("\n") + "\n");
  return file;
}

// A stand-in for `claude` that prints `version`.
function fakeClaude(version) {
  const file = join(tmp("claude"), "claude-fake.js");
  writeFileSync(file, `console.log(${JSON.stringify(`${version} (Claude Code)`)});\n`);
  return file;
}

// Runs orch-doctor in `dir` with a home of its own (HOME, USERPROFILE and
// APPDATA all point to it) and, unless `env` says otherwise, the tested Node.js
// version and no `claude` binary.
function doctor(dir, args = [], { home = tmp("home"), env = {} } = {}) {
  const r = script("orch-doctor", ["--json", ...args], dir, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    CLAUDE_PROJECT_DIR: "",
    MICROVERSE_NODE_VERSION: `${tested.node[0]}.1.0`,
    MICROVERSE_CLAUDE_BIN: MISSING_BIN,
    // Claude Code's own Bash carries these: none may leak into a test.
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    CLAUDE_CODE_USE_FOUNDRY: "",
    ANTHROPIC_BASE_URL: "",
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_ENTRYPOINT: "",
    CLAUDE_PLUGIN_OPTION_QUOTA_MODE: "",
    ...env,
  });
  let out = null;
  try {
    out = JSON.parse(r.out);
  } catch {}
  return { code: r.code, raw: r.out, out, rec: (name) => out?.records.find((x) => x.name === name) };
}

// A repository whose profile `home` has approved.
function approvedRepo(profile = {}) {
  const home = tmp("home");
  const { dir } = makeRepo(profile, { approve: false });
  approveProfile(home, dir);
  return { dir, home };
}

const all = [];
const keep = (r) => {
  all.push(r);
  return r;
};

test("T1: a tested environment, approved profile and a hook run: every control ok", () => {
  const { dir, home } = approvedRepo({ servers: ["vite"] });
  const r = keep(doctor(dir, ["--from-hook", "--transcript", transcript(tested.claudeCode)], { home }));
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out.records.map((x) => x.name), ["node", "claude-code", "git", "profile", "servers", "hooks", "counters"]);
  for (const x of r.out.records) assert.equal(x.state, "ok", `${x.name}: ${x.detail}`);
  assert.deepEqual(r.out.summary, { ok: 7, warn: 0, fix: 0 });
  assert.equal(r.out.v, 1);
  assert.match(r.rec("servers").detail, /vite/);
});

test("T2: a profile not approved is a fix that names orch-trust, and servers is not read", () => {
  const { dir } = makeRepo({ servers: ["x"] }, { approve: false });
  const r = keep(doctor(dir));
  assert.equal(r.code, 1);
  assert.equal(r.rec("profile").state, "fix");
  assert.match(r.rec("profile").action, /orch-trust/);
  assert.equal(r.rec("servers"), undefined);
});

test("T3: no profile is a warning, exit 0", () => {
  const bare = tmp("bare");
  require("node:child_process").spawnSync("git", ["init", "-q", "."], { cwd: bare });
  const r = keep(doctor(bare, ["--from-hook"]));
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.rec("profile").state, "warn");
  assert.match(r.rec("profile").action, /microverse:init/);
});

test("an invalid profile is a fix", () => {
  const { dir } = makeRepo({ setup: "npm ci" }, { approve: false });
  const r = keep(doctor(dir));
  assert.equal(r.rec("profile").state, "fix");
  assert.match(r.rec("profile").detail, /setup/);
  assert.equal(r.code, 1);
});

test("T4: Claude Code older is a fix, a later patch is ok, a later minor or major is a warning", () => {
  const { dir, home } = approvedRepo();
  const [maj, min, patch] = tested.claudeCode.split(".").map(Number);
  const at = (v) => keep(doctor(dir, ["--from-hook", "--transcript", transcript(v)], { home })).rec("claude-code");
  assert.equal(at(`${maj}.${min}.${patch - 1}`).state, "fix");
  assert.match(at(`${maj}.${min}.${patch - 1}`).action, /claude update/);
  assert.equal(at(`${maj}.${min - 1}.999`).state, "fix");
  assert.equal(at(`${maj}.${min}.${patch + 10}`).state, "ok");
  assert.equal(at(`${maj}.${min + 1}.0`).state, "warn");
  assert.equal(at(`${maj + 1}.0.0`).state, "warn");
  // Numeric, not textual: 2.1.1000 is after 2.1.306 and 2.1.99 is before it.
  assert.equal(at(`${maj}.${min}.1000`).state, "ok");
  assert.equal(at(`${maj}.${min}.99`).state, "fix");
});

test("T4: the last version of the transcript wins; without a transcript the binary answers; without both the version is unknown", () => {
  const { dir, home } = approvedRepo();
  const [maj, min, patch] = tested.claudeCode.split(".").map(Number);
  const r1 = keep(doctor(dir, ["--transcript", transcript(`${maj}.${min}.1`, tested.claudeCode)], { home }));
  assert.equal(r1.rec("claude-code").state, "ok");
  const r2 = keep(doctor(dir, [], { home, env: { MICROVERSE_CLAUDE_BIN: fakeClaude(`${maj}.${min + 1}.0`) } }));
  assert.equal(r2.rec("claude-code").state, "warn");
  assert.match(r2.rec("claude-code").detail, new RegExp(`${maj}\\.${min + 1}\\.0`));
  const r3 = keep(doctor(dir, [], { home }));
  assert.equal(r3.rec("claude-code").state, "warn");
  assert.match(r3.rec("claude-code").detail, /unknown/);
  // A transcript without a version falls back on the binary.
  const empty = join(tmp("t"), "s.jsonl");
  writeFileSync(empty, '{"type":"user"}\n');
  const r4 = keep(doctor(dir, ["--transcript", empty], { home, env: { MICROVERSE_CLAUDE_BIN: fakeClaude(`${maj}.${min}.${patch - 1}`) } }));
  assert.equal(r4.rec("claude-code").state, "fix");
});

test("T4b: Node.js versions against testedWith.node", () => {
  const { dir, home } = approvedRepo();
  const at = (v) => keep(doctor(dir, [], { home, env: { MICROVERSE_NODE_VERSION: v } })).rec("node");
  const [lo, hi] = tested.node;
  assert.equal(at("20.18.0").state, "fix");
  assert.match(at("20.18.0").action, new RegExp(`^Install Node.js ${lo} or newer$`));
  assert.equal(at(`${lo}.5.0`).state, "ok");
  assert.equal(at(`${hi}.1.0`).state, "ok");
  assert.equal(at(`${hi + 1}.0.0`).state, "warn");
  assert.match(at(`${hi + 1}.0.0`).detail, /untested Node.js version/);
});

test("T5: without the hook, disableAllHooks is a fix and its absence a warning", () => {
  const { dir, home } = approvedRepo();
  const plain = keep(doctor(dir, [], { home }));
  assert.equal(plain.rec("hooks").state, "warn");
  assert.match(plain.rec("hooks").action, /reload-plugins/);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: true }));
  const off = keep(doctor(dir, [], { home }));
  assert.equal(off.rec("hooks").state, "fix");
  assert.match(off.rec("hooks").action, /^Remove disableAllHooks from .*settings\.json$/);
  assert.equal(off.code, 1);
  // The project's settings.local.json counts too; false does not.
  const other = approvedRepo();
  mkdirSync(join(other.dir, ".claude"), { recursive: true });
  writeFileSync(join(other.dir, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
  assert.equal(keep(doctor(other.dir, [], { home: other.home })).rec("hooks").state, "fix");
  writeFileSync(join(other.dir, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: false }));
  assert.equal(keep(doctor(other.dir, [], { home: other.home })).rec("hooks").state, "warn");
  // From the hook the answer is ok whatever the settings say.
  assert.equal(keep(doctor(dir, ["--from-hook"], { home })).rec("hooks").state, "ok");
});

test("T6: a servers pattern of two characters is a warning; an unapproved profile gives no servers record", () => {
  const { dir, home } = approvedRepo({ servers: ["vite", "ab"] });
  const r = keep(doctor(dir, [], { home }));
  assert.equal(r.rec("servers").state, "warn");
  assert.match(r.rec("servers").detail, /"ab"/);
  assert.doesNotMatch(r.rec("servers").detail, /vite/);
  assert.equal(r.code, 0);
  const unapproved = makeRepo({ servers: ["ab"] }, { approve: false });
  assert.equal(keep(doctor(unapproved.dir)).rec("servers"), undefined);
});

test("a directory outside any git repository is a fix", () => {
  const r = keep(doctor(tmp("plain")));
  assert.equal(r.rec("git").state, "fix");
  assert.match(r.rec("git").action, /repository/);
  assert.equal(r.code, 1);
});

test("the project is --project, else CLAUDE_PROJECT_DIR, else the current directory", () => {
  const { dir, home } = approvedRepo();
  const elsewhere = tmp("elsewhere");
  assert.equal(keep(doctor(elsewhere, ["--project", dir], { home })).rec("profile").state, "ok");
  assert.equal(keep(doctor(elsewhere, [], { home, env: { CLAUDE_PROJECT_DIR: dir } })).rec("profile").state, "ok");
  assert.equal(keep(doctor(dir, [], { home })).rec("profile").state, "ok");
  assert.equal(keep(doctor(elsewhere, [], { home })).rec("git").state, "fix");
});

test("the text form: one line per record and an arrow line for each action", () => {
  const { dir } = makeRepo({}, { approve: false });
  const home = tmp("home");
  const r = script("orch-doctor", ["--from-hook"], dir, { HOME: home, USERPROFILE: home, APPDATA: home, CLAUDE_PROJECT_DIR: "", MICROVERSE_NODE_VERSION: `${tested.node[0]}.0.0`, MICROVERSE_CLAUDE_BIN: MISSING_BIN });
  const lines = r.out.trimEnd().split("\n");
  assert.match(lines[0], /^ok node {2}Node\.js /);
  const i = lines.findIndex((l) => l.startsWith("fix profile  "));
  assert.ok(i > 0, r.out);
  assert.match(lines[i + 1], /^ {5}-> Approve it: run `orch-trust /);
  assert.equal(r.code, 1);
});

// A status line reading of `home` taken `ageMs` ago, week counter at 40 %.
function statuslineReading(home, ageMs) {
  const dir = join(home, ".claude", "microverse", "statusline");
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  writeFileSync(join(dir, "s1.json"), JSON.stringify({ v: 1, at: now - ageMs, week: { used: 40, resetsAt: now + 3 * 86400e3 } }));
}

const counters = (args, env, readingAge) => {
  const { dir, home } = approvedRepo();
  if (readingAge !== undefined) statuslineReading(home, readingAge);
  return keep(doctor(dir, args, { home, env }));
};

test("E36a2 T1: quota_mode off is ok whatever the environment", () => {
  const r = counters(["--mode", "off"], { CLAUDE_CODE_ENTRYPOINT: "cli" });
  assert.equal(r.rec("counters").state, "ok");
  assert.equal(r.rec("counters").detail, "quota off (quota_mode is off): agents are not paced");
  assert.equal(r.code, 0);
});

test("E36a2 T2: no source in the terminal CLI is a warning that names /microverse:init", () => {
  const r = counters([], { CLAUDE_CODE_ENTRYPOINT: "cli" });
  assert.equal(r.rec("counters").state, "warn");
  assert.equal(r.rec("counters").action, "Set up the status line with /microverse:init");
  assert.equal(r.code, 0);
  assert.equal(counters([], { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }).rec("counters").action, "Open the Board (/board) or let the orchestrator read get_usage");
  const other = counters([], { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" });
  assert.equal(other.rec("counters").state, "ok");
});

test("E36a2 T3: no source with Bedrock is ok", () => {
  const r = counters([], { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_USE_BEDROCK: "1" });
  assert.equal(r.rec("counters").state, "ok");
  assert.match(r.rec("counters").detail, /^quota off \(no counter source\)/);
});

test("E36a2 T4: a fresh reading is ok and says where it comes from and its age", () => {
  const r = counters([], { CLAUDE_CODE_ENTRYPOINT: "cli" }, 10 * 60e3);
  assert.equal(r.rec("counters").state, "ok");
  assert.equal(r.rec("counters").detail, "status line, 10 min ago");
});

test("E36a2 T5: a reading 3 h old in VS Code is a warning that names the extension", () => {
  const r = counters([], { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }, 3 * 3600e3);
  assert.equal(r.rec("counters").state, "warn");
  assert.match(r.rec("counters").detail, /^status line, 3 h ago/);
  assert.match(r.rec("counters").action, /"Claude Code Usage" \(growthjack\)/);
});

test("E36a2 T6: a gateway with counted mode is a warning that names orch-reading --none", () => {
  const r = counters([], { ANTHROPIC_BASE_URL: "https://llm.example.test/v1", CLAUDE_CODE_ENTRYPOINT: "cli" }, 3 * 3600e3);
  assert.equal(r.rec("counters").state, "warn");
  assert.match(r.rec("counters").action, /^No quota windows with a gateway \(llm\.example\.test\): run orch-reading --none or set quota_mode to off$/);
  const key = counters([], { ANTHROPIC_API_KEY: "sk-test" }, 3 * 3600e3);
  assert.match(key.rec("counters").action, /^No quota windows with an API key: run orch-reading --none/);
});

test("E36a2 T7: an unknown quota_mode is a fix, exit 1; unset, empty and the unexpanded setting are auto", () => {
  const r = counters(["--mode", "banana"], {});
  assert.equal(r.rec("counters").state, "fix");
  assert.equal(r.rec("counters").action, "quota_mode must be auto or off");
  assert.equal(r.code, 1);
  for (const v of ["", "${user_config.quota_mode}", "AUTO"]) assert.notEqual(counters(["--mode", v], {}).rec("counters").state, "fix", v);
});

test("E36a2 T8: ANTHROPIC_BASE_URL on api.anthropic.com alone is no gateway", () => {
  const r = counters([], { ANTHROPIC_BASE_URL: "https://api.anthropic.com", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, 3 * 3600e3);
  assert.equal(r.rec("counters").state, "warn");
  assert.match(r.rec("counters").action, /^Open the Board/);
});

test("E36a2: the counters control reads without pruning or writing", () => {
  const { dir, home } = approvedRepo();
  statuslineReading(home, 20 * 86400e3);
  const { readdirSync } = require("node:fs");
  const list = () => readdirSync(home, { recursive: true }).sort().join("|");
  const before = list();
  keep(doctor(dir, [], { home }));
  assert.equal(list(), before);
});

test("doctor writes nothing: the home and the project are unchanged", () => {
  const { dir, home } = approvedRepo({ servers: ["vite"] });
  const { readdirSync } = require("node:fs");
  const list = (d) => readdirSync(d, { recursive: true }).sort().join("|");
  const before = [list(home), list(dir)];
  keep(doctor(dir, [], { home }));
  keep(doctor(dir, ["--from-hook"], { home }));
  assert.deepEqual([list(home), list(dir)], before);
});

test("T7: every warn and fix record has an action, and ok has none", () => {
  assert.ok(all.length > 10);
  for (const r of all) {
    for (const x of r.out.records) {
      if (x.state === "ok") assert.equal(x.action, "", `${x.name}`);
      else assert.ok(x.action.length > 0, `${x.name}: ${x.detail}`);
    }
  }
});

test("T9: an unknown option, a positional argument or a missing value is a usage error", () => {
  const { dir } = makeRepo({});
  for (const args of [["--bogus"], ["extra"], ["--project"], ["--transcript"], ["--mode"]]) {
    const r = script("orch-doctor", args, dir);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.out, /^usage: orch-doctor/);
  }
});

// ---- audio and quota settings ----

// A synthetic settings file with the given plugin options (or raw text).
function writeSettings(file, content) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}
const withOptions = (options, key = "microverse@microverse") => ({ pluginConfigs: { [key]: { options } } });
const QUOTA_KEYS = { week_target: 90, weekday_reserve: 20, five_hour_limit: 80 };

// A project and a home with a status line reading, so the quota mode is metered.
function meteredRepo() {
  const { dir, home } = approvedRepo();
  statuslineReading(home, 10 * 60e3);
  return { dir, home };
}
const audioLine = (dir, line) => writeFileSync(join(dir, "CLAUDE.local.md"), `# State\n\n${line}\n`);
const fakeEngine = () => {
  const file = join(tmp("engine"), "fake-edge-tts.js");
  writeFileSync(file, 'console.log("edge-tts 7.0.0");\n');
  return file;
};

test("E36f2 T1: audio off or no line: no audio record", () => {
  const { dir, home } = approvedRepo();
  assert.equal(keep(doctor(dir, [], { home })).rec("audio"), undefined);
  audioLine(dir, "Audio report: off");
  assert.equal(keep(doctor(dir, [], { home, env: { MICROVERSE_EDGE_TTS: fakeEngine() } })).rec("audio"), undefined);
});

test("E36f2 T2: audio on with an engine: ok, names the voice", () => {
  const { dir, home } = approvedRepo();
  audioLine(dir, "Audio report: on, voice en-GB-SoniaNeural");
  const r = keep(doctor(dir, [], { home, env: { MICROVERSE_EDGE_TTS: fakeEngine() } }));
  assert.equal(r.rec("audio").state, "ok");
  assert.match(r.rec("audio").detail, /voice \S+/);
});

test("E36f2 T3: audio on without an engine: warn that names pip", () => {
  const { dir, home } = approvedRepo();
  audioLine(dir, "Audio report: on");
  const r = keep(doctor(dir, [], { home, env: { MICROVERSE_EDGE_TTS: join(tmp("noengine"), "missing.js") } }));
  assert.equal(r.rec("audio").state, "warn");
  assert.match(r.rec("audio").action, /pip/);
});

test("E36f2 T4: metered mode and no quota key: one warn per file, naming the three", () => {
  const { dir, home } = meteredRepo();
  writeSettings(join(home, ".claude", "settings.json"), withOptions({ quota_mode: "auto" }));
  writeSettings(join(dir, ".claude", "settings.local.json"), {});
  const r = keep(doctor(dir, [], { home }));
  const warns = r.out.records.filter((x) => x.name === "settings");
  assert.equal(warns.length, 2);
  for (const w of warns) {
    assert.equal(w.state, "warn");
    for (const k of Object.keys(QUOTA_KEYS)) assert.ok(w.detail.includes(k), w.detail);
    assert.match(w.action, /even identical/);
  }
  // A file that does not exist says nothing.
  assert.ok(warns.every((w) => !w.detail.includes("settings.json") || w.detail.includes(".claude")));
});

test("E36f2 T4b: a partial file names only the absent settings, whatever the plugin key suffix", () => {
  const { dir, home } = meteredRepo();
  writeSettings(join(dir, ".claude", "settings.json"), withOptions({ week_target: 98 }, "microverse@somewhere"));
  const w = keep(doctor(dir, [], { home })).rec("settings");
  assert.equal(w.state, "warn");
  assert.ok(!w.detail.includes("week_target") && w.detail.includes("weekday_reserve") && w.detail.includes("five_hour_limit"), w.detail);
});

test("E36f2 T5: the three keys set: ok", () => {
  const { dir, home } = meteredRepo();
  writeSettings(join(home, ".claude", "settings.json"), withOptions(QUOTA_KEYS));
  const r = keep(doctor(dir, [], { home }));
  assert.equal(r.rec("settings").state, "ok");
  assert.equal(r.out.records.filter((x) => x.name === "settings").length, 1);
});

test("E36f2 T6: quota mode off: no settings record", () => {
  const { dir, home } = approvedRepo();
  writeSettings(join(home, ".claude", "settings.json"), {});
  assert.equal(keep(doctor(dir, ["--mode", "off"], { home })).rec("settings"), undefined);
  assert.equal(keep(doctor(dir, [], { home })).rec("settings"), undefined);
});

test("E36f2 T7: an invalid settings.json gives no record; the valid one still does", () => {
  const { dir, home } = meteredRepo();
  writeSettings(join(home, ".claude", "settings.json"), "{ not json");
  assert.equal(keep(doctor(dir, [], { home })).rec("settings"), undefined);
  writeSettings(join(dir, ".claude", "settings.json"), {});
  const warns = keep(doctor(dir, [], { home })).out.records.filter((x) => x.name === "settings");
  assert.equal(warns.length, 1);
  assert.ok(warns[0].detail.includes(join(dir, ".claude", "settings.json")));
});

test("E36f2 T8: the init skill names the three settings and the command that changes them", () => {
  const text = readFileSync(join(ROOT, "skills", "init", "SKILL.md"), "utf8");
  for (const k of ["week_target", "weekday_reserve", "five_hour_limit", "claude plugin configure microverse", "orch-quota --no-write"]) assert.ok(text.includes(k), k);
});
