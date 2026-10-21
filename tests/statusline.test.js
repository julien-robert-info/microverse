"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, sh } = require("./helpers.js");

const SCRIPT = join(ROOT, "scripts", "statusline.js");
const DAY = 24 * 3600e3;

const newHome = () => realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-statusline-")));
const envOf = (home) => ({ HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: "" });
const dataOf = (home) => join(home, ".claude", "microverse");
const dirOf = (home) => join(dataOf(home), "statusline");

// NO_COLOR by default: the printed line is then plain text whatever the terminal.
function run(home, input, args = [], script = SCRIPT, env = {}) {
  const r = require("node:child_process").spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, NO_COLOR: "1", ...envOf(home), ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const payload = (extra = {}) => ({
  session_id: "sess-1",
  model: { display_name: "Test Model" },
  context_window: { used_percentage: 12.4 },
  rate_limits: {
    five_hour: { used_percentage: 37, resets_at: 1800000000 },
    seven_day: { used_percentage: 64.6, resets_at: 1800500000 },
  },
  ...extra,
});

const files = (home) => {
  try {
    return readdirSync(dirOf(home));
  } catch {
    return [];
  }
};

test("T1 full payload: reading written, seconds turned to ms, percentage kept, line printed", () => {
  const home = newHome();
  const r = run(home, JSON.stringify(payload()));
  assert.equal(r.code, 0);
  assert.equal(r.out, "Test Model · ctx 12 % · 5h ██░░░ 37 % · 7d ███░░ 65 %\n");
  const got = JSON.parse(readFileSync(join(dirOf(home), "sess-1.json"), "utf8"));
  assert.deepEqual(Object.keys(got).sort(), ["at", "five", "v", "week"]);
  assert.equal(got.v, 1);
  assert.deepEqual(got.five, { used: 37, resetsAt: 1800000000000 });
  assert.deepEqual(got.week, { used: 64.6, resetsAt: 1800500000000 });
  assert.ok(Math.abs(got.at - Date.now()) < 60e3);
  assert.deepEqual(files(home), ["sess-1.json"]);
});

test("T2 no rate_limits: no file, line without 5h/7d, exit 0", () => {
  const home = newHome();
  const p = payload();
  delete p.rate_limits;
  const r = run(home, JSON.stringify(p));
  assert.equal(r.code, 0);
  assert.equal(r.out, "Test Model · ctx 12 %\n");
  assert.deepEqual(files(home), []);
});

test("T3 only seven_day: week without five", () => {
  const home = newHome();
  const p = payload();
  delete p.rate_limits.five_hour;
  const r = run(home, JSON.stringify(p));
  assert.equal(r.out, "Test Model · ctx 12 % · 7d ███░░ 65 %\n");
  const got = JSON.parse(readFileSync(join(dirOf(home), "sess-1.json"), "utf8"));
  assert.ok(got.week);
  assert.equal("five" in got, false);
});

test("a window with a missing or non-finite number is not written", () => {
  const home = newHome();
  const p = payload();
  p.rate_limits.five_hour = { used_percentage: 20 };
  p.rate_limits.seven_day.resets_at = "soon";
  run(home, JSON.stringify(p));
  assert.deepEqual(files(home), []);
});

test("T6 gauge cells and colour: green below the pace, yellow up to the target, red above", () => {
  const { formatLine } = require(SCRIPT);
  const now = 1800000000000;
  // 7d window half elapsed: pace 49 % of the 98 % target; 5h window half elapsed: pace 45 % of 90.
  const at = (frac, span) => (now + (1 - frac) * span) / 1000;
  const line = (five, week) =>
    formatLine(
      { rate_limits: { five_hour: { used_percentage: five, resets_at: at(0.5, 5 * 3600e3) }, seven_day: { used_percentage: week, resets_at: at(0.5, 7 * DAY) } } },
      { now, color: true },
    );
  const paint = (code, text) => `\u001b[${code}m${text}\u001b[0m`;
  assert.equal(line(10, 20), `${paint(32, "5h █░░░░ 10 %")} · ${paint(32, "7d █░░░░ 20 %")}`);
  assert.equal(line(60, 70), `${paint(33, "5h ███░░ 60 %")} · ${paint(33, "7d ████░ 70 %")}`);
  assert.equal(line(95, 99), `${paint(31, "5h █████ 95 %")} · ${paint(31, "7d █████ 99 %")}`);
  assert.equal(line(0, 100), `${paint(32, "5h ░░░░░ 0 %")} · ${paint(31, "7d █████ 100 %")}`);
  // Mixed: each counter has its own colour; a window without reset time stays plain.
  assert.equal(line(10, 99), `${paint(32, "5h █░░░░ 10 %")} · ${paint(31, "7d █████ 99 %")}`);
  assert.equal(formatLine({ rate_limits: { five_hour: { used_percentage: 50 } } }, { now, color: true }), "5h ███░░ 50 %");
  assert.equal(formatLine({ rate_limits: { five_hour: { used_percentage: 99 }, seven_day: { used_percentage: 99, resets_at: at(0.5, 7 * DAY) } } }, { now, color: false }), "5h █████ 99 % · 7d █████ 99 %");
});

test("T6 the process colours the line unless NO_COLOR is set or the terminal is dumb", () => {
  const home = newHome();
  const input = JSON.stringify(payload());
  const colored = run(home, input, [], SCRIPT, { NO_COLOR: "", TERM: "xterm-256color" });
  assert.match(colored.out, /\u001b\[\d+m5h /);
  assert.doesNotMatch(run(home, input, [], SCRIPT, { NO_COLOR: "1", TERM: "xterm-256color" }).out, /\u001b/);
  assert.doesNotMatch(run(home, input, [], SCRIPT, { NO_COLOR: "", TERM: "dumb" }).out, /\u001b/);
});

test("T4 empty and non-JSON stdin: no data, exit 0, no file", () => {
  for (const input of ["", "not json {", "null"]) {
    const home = newHome();
    const r = run(home, input);
    assert.equal(r.code, 0);
    assert.equal(r.out, "microverse: no data\n");
    assert.deepEqual(files(home), []);
  }
});

test("T5 unsafe session_id: no file anywhere", () => {
  for (const id of ["../evil", "a/b", "a\\b", "", "x".repeat(101), "a.b", 7]) {
    const home = newHome();
    const r = run(home, JSON.stringify(payload({ session_id: id })));
    assert.equal(r.code, 0);
    assert.deepEqual(files(home), []);
    assert.equal(existsSync(join(dataOf(home), "evil.json")), false);
    assert.equal(existsSync(join(home, ".claude", "evil.json")), false);
    assert.equal(existsSync(join(home, "evil.json")), false);
  }
});

test("T6 two sessions: two files, readReadings returns both", () => {
  const home = newHome();
  run(home, JSON.stringify(payload({ session_id: "a" })));
  const p = payload({ session_id: "b" });
  delete p.rate_limits.five_hour;
  run(home, JSON.stringify(p));
  assert.deepEqual(files(home).sort(), ["a.json", "b.json"]);
  const code = `console.log(JSON.stringify(require(${JSON.stringify(SCRIPT)}).readReadings()))`;
  const r = sh(process.execPath, ["-e", code], ROOT, envOf(home));
  const got = JSON.parse(r.out).sort((x, y) => x.session.localeCompare(y.session));
  assert.deepEqual(got.map((x) => x.session), ["a", "b"]);
  assert.ok(got[0].five && got[0].week);
  assert.equal(got[1].five, undefined);
  assert.ok(got[1].week);
});

test("T7 readReadings skips bad files; prune removes only stale ones in its folder", () => {
  const home = newHome();
  const dir = dirOf(home);
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const reading = (at) => JSON.stringify({ v: 1, at, five: { used: 10, resetsAt: now + 3600e3 } });
  writeFileSync(join(dir, "ok.json"), reading(now));
  writeFileSync(join(dir, "trunc.json"), '{"v":1,"at":');
  writeFileSync(join(dir, "v2.json"), JSON.stringify({ v: 2, at: now }));
  writeFileSync(join(dir, "pending.json.123.tmp"), reading(now));
  writeFileSync(join(dir, "old.json"), reading(now - 9 * DAY));
  writeFileSync(join(dir, "recent.json"), reading(now - 7 * DAY));
  writeFileSync(join(dir, "old.json.9.tmp"), "partial");
  const past = new Date(now - 9 * DAY);
  utimesSync(join(dir, "old.json.9.tmp"), past, past);
  writeFileSync(join(dataOf(home), "foreign.json"), reading(now - 30 * DAY));

  const code = `
    const s = require(${JSON.stringify(SCRIPT)});
    const names = (r) => r.map((x) => x.session).sort();
    const before = names(s.readReadings());
    const after = names(s.readReadings({ prune: true }));
    console.log(JSON.stringify({ before, after }));`;
  const r = sh(process.execPath, ["-e", code], ROOT, envOf(home));
  const got = JSON.parse(r.out);
  assert.deepEqual(got.before, ["old", "ok", "recent"].sort());
  assert.deepEqual(got.after, ["ok", "recent"]);
  assert.deepEqual(readdirSync(dir).sort(), ["ok.json", "pending.json.123.tmp", "recent.json", "trunc.json", "v2.json"]);
  assert.ok(existsSync(join(dataOf(home), "foreign.json")));
});

test("T7b prune uses the modification time of an unreadable file", () => {
  const home = newHome();
  const dir = dirOf(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bad.json"), "{");
  const past = new Date(Date.now() - 9 * DAY);
  utimesSync(join(dir, "bad.json"), past, past);
  writeFileSync(join(dir, "fresh.json"), "{");
  sh(process.execPath, ["-e", `require(${JSON.stringify(SCRIPT)}).readReadings({ prune: true })`], ROOT, envOf(home));
  assert.deepEqual(readdirSync(dir), ["fresh.json"]);
});

test("T8 --install: identical copy, quoted forward-slash command, second run does not rewrite", () => {
  const home = newHome();
  const r = run(home, "", ["--install"]);
  assert.equal(r.code, 0);
  const setting = JSON.parse(r.out);
  const copy = join(dataOf(home), "statusline.js");
  assert.deepEqual(Object.keys(setting).sort(), ["command", "type"]);
  assert.equal(setting.type, "command");
  assert.equal(setting.command, `node "${copy.replace(/\\/g, "/")}"`);
  assert.equal(setting.command.includes("\\"), false);
  assert.ok(readFileSync(copy).equals(readFileSync(SCRIPT)));
  const t = new Date(Date.now() - 3600e3);
  utimesSync(copy, t, t);
  const m = statSync(copy).mtimeMs;
  run(home, "", ["--install"]);
  assert.equal(statSync(copy).mtimeMs, m);
});

test("T9 refreshInstalled: false and nothing created without a copy; rewrites a differing copy", () => {
  const home = newHome();
  const call = `console.log(require(${JSON.stringify(SCRIPT)}).refreshInstalled())`;
  assert.equal(sh(process.execPath, ["-e", call], ROOT, envOf(home)).out.trim(), "false");
  assert.equal(existsSync(dataOf(home)), false);
  mkdirSync(dataOf(home), { recursive: true });
  const copy = join(dataOf(home), "statusline.js");
  writeFileSync(copy, "// old\n");
  assert.equal(sh(process.execPath, ["-e", call], ROOT, envOf(home)).out.trim(), "true");
  assert.ok(readFileSync(copy).equals(readFileSync(SCRIPT)));
  assert.equal(sh(process.execPath, ["-e", call], ROOT, envOf(home)).out.trim(), "false");
});

test("T10 the installed copy, run from its own folder, writes its reading", () => {
  const home = newHome();
  run(home, "", ["--install"]);
  const copy = join(dataOf(home), "statusline.js");
  const r = require("node:child_process").spawnSync(process.execPath, [copy], {
    cwd: dataOf(home),
    encoding: "utf8",
    input: JSON.stringify(payload({ session_id: "from-copy" })),
    env: { ...process.env, ...envOf(home) },
  });
  assert.equal(r.status, 0);
  assert.deepEqual(files(home), ["from-copy.json"]);
});

test("the script has no relative require", () => {
  assert.doesNotMatch(readFileSync(SCRIPT, "utf8"), /require\(\s*["'`]\./);
});
