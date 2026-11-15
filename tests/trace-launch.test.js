"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ROOT, git } = require("./helpers.js");

const HOOK = join(ROOT, "scripts", "trace-launch.js");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-trace-")));

// A repository with one commit and an empty home, so that no real settings are read.
function fixture() {
  const repo = tmp();
  const home = tmp();
  const traces = tmp();
  git(repo, "init", "-q", "-b", "main", ".");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "f.txt"), "f\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "chore: init");
  const head = git(repo, "rev-parse", "HEAD").out.trim();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PROJECT_DIR: repo,
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_PLUGIN_OPTION_TRACE_DIR: traces,
  };
  const input = (prompt, extra = {}) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_01ABC",
    session_id: "sess-1",
    transcript_path: join(home, ".claude", "projects", "proj-slug", "sess-1.jsonl").replace(/\//g, "\\"),
    cwd: repo,
    tool_input: { subagent_type: "microverse:morty", model: "sonnet", description: "do it", run_in_background: true, prompt },
    ...extra,
  });
  return { repo, home, traces, head, env, input, session: join(traces, "proj-slug", "sess-1") };
}

const run = (f, input, env = f.env, cwd) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8", env, cwd });
const records = (dir, kind = "launch") => readdirSync(dir).filter((n) => n.startsWith(`${kind}-`));
const readRecord = (f) => JSON.parse(readFileSync(join(f.session, records(f.session)[0]), "utf8"));

test("T1 an empty option records nothing, prints nothing, exits 0", () => {
  const f = fixture();
  // Run from an empty folder: an empty path must not turn into a relative one.
  const where = tmp();
  for (const value of ["", "  ", undefined, "${user_config.trace_dir}"]) {
    const r = run(f, f.input("brief"), { ...f.env, CLAUDE_PLUGIN_OPTION_TRACE_DIR: value }, where);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  }
  assert.deepEqual(readdirSync(f.traces), []);
  assert.deepEqual(readdirSync(where), []);
});

test("T2 launch record: format fields, exact head, brief copy with the same fingerprint", () => {
  const f = fixture();
  const brief = "Mission: do é the thing\nsecond line\n";
  const r = run(f, f.input(brief));
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
  assert.deepEqual(readdirSync(f.session).sort(), ["brief", records(f.session)[0]].sort());
  const rec = readRecord(f);
  assert.equal(rec.v, 1);
  assert.equal(rec.kind, "launch");
  assert.equal(rec.session, "sess-1");
  assert.equal(rec.toolUseId, "toolu_01ABC");
  assert.equal(rec.cwd, f.repo);
  assert.equal(rec.repo.head, f.head);
  assert.equal(rec.repo.branch, "main");
  assert.equal(rec.repo.dirty, false);
  assert.deepEqual(rec.agent, { type: "microverse:morty", model: "sonnet", background: true, description: "do it" });
  assert.deepEqual(rec.brief, { file: "brief/toolu_01ABC.md", sha256: sha(brief), chars: brief.length });
  const copy = readFileSync(join(f.session, rec.brief.file), "utf8");
  assert.equal(copy, brief);
  assert.equal(sha(copy), rec.brief.sha256);
  assert.deepEqual(rec.notes, []);
  assert.equal(rec.config.plugin.name, "microverse");
  assert.match(rec.config.plugin.version, /^\d+\.\d+\.\d+/);
  for (const k of ["userSettingsSha", "projectSettingsSha", "profileSha"]) assert.equal(rec.config[k], null);
  assert.match(rec.at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  // No ":" in a file name (Windows), stamp of the form AAAAMMJJTHHMMSSmmmZ.
  assert.match(records(f.session)[0], /^launch-\d{8}T\d{9}Z-toolu_01ABC\.json$/);
});

test("T2 a dirty repository is flagged", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "f.txt"), "changed\n");
  run(f, f.input("b"));
  assert.equal(readRecord(f).repo.dirty, true);
});

test("T3 cited notes: copied, absent, outside, once, too-big", () => {
  const f = fixture();
  mkdirSync(join(f.repo, "notes"));
  writeFileSync(join(f.repo, "notes", "ok.md"), "kept as at launch\n");
  writeFileSync(join(f.repo, "x.md"), "not a note\n");
  const brief = "read notes/ok.md and notes/missing.md and notes/../x.md; again notes/ok.md";
  run(f, f.input(brief));
  const rec = readRecord(f);
  assert.deepEqual(rec.notes, [
    { rel: "notes/ok.md", sha256: sha("kept as at launch\n"), copied: true, reason: null },
    { rel: "notes/missing.md", sha256: null, copied: false, reason: "absent" },
    { rel: "notes/../x.md", sha256: null, copied: false, reason: "outside" },
  ]);
  assert.equal(readFileSync(join(f.session, "notes", "toolu_01ABC", "notes", "ok.md"), "utf8"), "kept as at launch\n");
  assert.throws(() => readFileSync(join(f.session, "notes", "toolu_01ABC", "x.md")));

  // 1.5 MB fits, the next 1 MB does not (2 MB cumulated), and one alone over 2 MB never does.
  writeFileSync(join(f.repo, "notes", "a.md"), "a".repeat(1.5 * 1024 * 1024));
  writeFileSync(join(f.repo, "notes", "b.md"), "b".repeat(1024 * 1024));
  writeFileSync(join(f.repo, "notes", "huge.md"), "h".repeat(2.1 * 1024 * 1024));
  const traces2 = tmp();
  const env = { ...f.env, CLAUDE_PLUGIN_OPTION_TRACE_DIR: traces2 };
  run(f, f.input("notes/a.md notes/b.md notes/huge.md"), env);
  const session2 = join(traces2, "proj-slug", "sess-1");
  const big = JSON.parse(readFileSync(join(session2, records(session2)[0]), "utf8"));
  assert.deepEqual(
    big.notes.map((n) => [n.rel, n.copied, n.reason]),
    [["notes/a.md", true, null], ["notes/b.md", false, "too-big"], ["notes/huge.md", false, "too-big"]],
  );
});

test("T5 an unwritable trace_dir: exit 0, no output, no exception", () => {
  const f = fixture();
  const blocker = join(f.traces, "file");
  writeFileSync(blocker, "x");
  const r = run(f, f.input("b"), { ...f.env, CLAUDE_PLUGIN_OPTION_TRACE_DIR: join(blocker, "sub") });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("T5 a failure leaves one line in errors.log, without the hook input", () => {
  const f = fixture();
  // The session folder cannot be created: its name is taken by a file.
  mkdirSync(join(f.traces, "proj-slug"));
  writeFileSync(join(f.traces, "proj-slug", "sess-1"), "x");
  const r = run(f, f.input("secret brief text"));
  assert.equal(r.status, 0);
  const lines = readFileSync(join(f.traces, "errors.log"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(e), ["at", "script", "message"]);
  assert.equal(e.script, "trace-launch");
  assert.doesNotMatch(lines[0], /secret brief text/);
});

test("T6 privacy: only the program name of a hook is kept, no argument, no environment", () => {
  const f = fixture();
  mkdirSync(join(f.home, ".claude"), { recursive: true });
  writeFileSync(
    join(f.home, ".claude", "settings.json"),
    JSON.stringify({
      env: { TOKEN_VALUE: "tok-123" },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude --flag ZZQ9" }] }],
        Stop: [{ hooks: [{ type: "command", command: "node", args: ["C:\\tools\\notify.js", "--secret-arg"] }] }],
      },
    }),
  );
  mkdirSync(join(f.repo, ".claude"));
  writeFileSync(
    join(f.repo, ".claude", "settings.local.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'SECRET=1 "C:/Program Files/x/tool.exe" --a b' }] }] } }),
  );
  const r = run(f, f.input("b"), { ...f.env, SECRET: "1", LEAK_ME: "env-leak-value" });
  assert.equal(r.status, 0);
  const text = readFileSync(join(f.session, records(f.session)[0]), "utf8");
  assert.deepEqual(JSON.parse(text).config.hooks, [
    { event: "PreToolUse", matcher: "Bash", program: "rtk" },
    { event: "Stop", matcher: null, program: "notify.js" },
    { event: "SessionStart", matcher: null, program: "tool" },
  ]);
  for (const s of ["--flag", "ZZQ9", "SECRET", "--secret-arg", "tok-123", "env-leak-value", "--a"]) assert.ok(!text.includes(s), s);
  assert.equal(JSON.parse(text).config.userSettingsSha, sha(readFileSync(join(f.home, ".claude", "settings.json"))));
});

test("T7 two launches at once: two valid files, no .tmp left", async () => {
  const f = fixture();
  const start = (id) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [HOOK], { env: f.env, stdio: ["pipe", "ignore", "ignore"] });
      p.on("close", resolve);
      p.stdin.end(JSON.stringify({ ...f.input(`brief ${id}`), tool_use_id: id }));
    });
  const codes = await Promise.all([start("toolu_A"), start("toolu_B")]);
  assert.deepEqual(codes, [0, 0]);
  const files = records(f.session);
  assert.equal(files.length, 2);
  const ids = files.map((n) => JSON.parse(readFileSync(join(f.session, n), "utf8")).toolUseId).sort();
  assert.deepEqual(ids, ["toolu_A", "toolu_B"]);
  const all = [...readdirSync(f.session), ...readdirSync(join(f.session, "brief"))];
  assert.deepEqual(all.filter((n) => n.endsWith(".tmp")), []);
  assert.equal(readFileSync(join(f.session, "brief", "toolu_A.md"), "utf8"), "brief toolu_A");
});

test("T8 without tool_use_id: toolUseId null, a random id names the files", () => {
  const f = fixture();
  const input = f.input("some brief");
  delete input.tool_use_id;
  const r = run(f, input);
  assert.equal(r.status, 0);
  const rec = readRecord(f);
  assert.equal(rec.toolUseId, null);
  const m = records(f.session)[0].match(/^launch-\d{8}T\d{9}Z-([0-9a-f]{8})\.json$/);
  assert.ok(m, records(f.session)[0]);
  assert.equal(rec.brief.file, `brief/${m[1]}.md`);
  assert.equal(readFileSync(join(f.session, rec.brief.file), "utf8"), "some brief");
});

test("a missing field is null, never an error; other tools and malformed input are ignored", () => {
  const f = fixture();
  const r = run(f, { tool_name: "Agent", tool_input: {} });
  assert.equal(r.status, 0);
  const dir = join(f.traces, "unknown", "unknown");
  const rec = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith("launch-"))), "utf8"));
  assert.deepEqual(rec.brief, { file: null, sha256: null, chars: null });
  assert.equal(rec.agent.type, null);
  assert.equal(rec.session, null);

  const g = fixture();
  assert.equal(run(g, g.input("b", { tool_name: "Bash" })).status, 0);
  assert.equal(spawnSync(process.execPath, [HOOK], { input: "not json", env: g.env }).status, 0);
  assert.deepEqual(readdirSync(g.traces), []);
});
