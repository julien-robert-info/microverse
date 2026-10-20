"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, isAbsolute, join, sep } = require("node:path");
const { bin } = require("./helpers.js");

const POSIX = process.platform !== "win32";
const TEXT = "Déjà réglé, à côté, ça va. Quarante pour cent.";

// A stand-in for edge-tts: answers --version, notes its argv and the content
// of the -f file in $FAKE_LOG, then behaves as $FAKE_MODE says.
const FAKE = `
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a.includes("--version")) { console.log("edge-tts 7.3.1"); process.exit(0); }
const arg = (k) => a[a.indexOf(k) + 1];
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: a, text: fs.readFileSync(arg("-f"), "utf8") }));
const out = arg("--write-media");
const mode = process.env.FAKE_MODE || "ok";
if (mode === "ok") { fs.writeFileSync(out, Buffer.from("fake-mp3-bytes")); process.exit(0); }
if (mode === "empty") process.exit(0);
if (mode === "hang") { fs.writeFileSync(out, ""); setInterval(() => {}, 1000); return; }
fs.writeFileSync(out, "");
if (mode === "hostile") { console.error("Error: bad " + String.fromCharCode(27, 93) + "52;c;QQ" + String.fromCharCode(7, 0x2028, 0xe9) + "end"); process.exit(1); }
console.error("Traceback (most recent call last):");
console.error("edge_tts.exceptions.NoAudioReceived: No audio was received. Please verify that your parameters are correct.");
console.error("Exception ignored in: <function _ProactorBasePipeTransport.__del__>");
console.error("RuntimeError: Event loop is closed");
process.exit(1);
`;

function setup() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-speak-test-")));
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  const fake = join(dir, "fake-edge-tts.js");
  writeFileSync(fake, FAKE);
  const log = join(dir, "log.json");
  // Real temp folders are never touched: the script's own tmpdir() is `tmp`.
  const env = { MICROVERSE_EDGE_TTS: fake, FAKE_LOG: log, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const speak = (args, { input = "", env: extra = {}, drop = [] } = {}) => {
    // `drop` first: on Windows the PATH key is `Path`, and a second spelling would be a duplicate.
    const full = { ...process.env, ...env };
    for (const k of Object.keys(full)) if (drop.includes(k.toUpperCase())) delete full[k];
    Object.assign(full, extra);
    const r = spawnSync(process.execPath, [bin("orch-speak"), ...args], { encoding: "utf8", input, env: full, timeout: 60000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const called = () => (existsSync(log) ? JSON.parse(readFileSync(log, "utf8")) : null);
  return { dir, tmp, fake, log, speak, called, speakDir: join(tmp, "microverse-speak") };
}

const leftovers = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => /\.(mp3|part)$/.test(f)) : []);

test("stdin text goes to the engine through -f and the path is printed", () => {
  const t = setup();
  const r = t.speak([], { input: TEXT });
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.ok(isAbsolute(lines[0]));
  assert.equal(dirname(lines[0]), t.speakDir);
  assert.match(lines[0], /report-\d{8}-\d{6}\.mp3$/);
  assert.equal(readFileSync(lines[0], "utf8"), "fake-mp3-bytes");
  const c = t.called();
  assert.equal(c.text, TEXT);
  assert.equal(c.argv[0], "-f");
  assert.ok(c.argv.includes("--write-media"));
  assert.match(c.argv[c.argv.indexOf("--write-media") + 1], /\.mp3\.part$/);
  assert.deepEqual(leftovers(t.speakDir), [lines[0].split(sep).pop()]);
});

test("--file with a BOM and --out in a new folder", () => {
  const t = setup();
  const file = join(t.dir, "in.txt");
  writeFileSync(file, `\ufeff${TEXT}`);
  const out = join(t.dir, "deep", "sub", "a.mp3");
  const r = t.speak(["--file", file, "--out", out]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), out);
  assert.ok(existsSync(out));
  assert.equal(t.called().text, TEXT);
});

test("voice, rate, pitch and volume reach the engine in the = form, signs added", () => {
  const t = setup();
  const r = t.speak(["--voice", "fr-FR-DeniseNeural", "--rate", "20%", "--pitch", "-5Hz", "--volume", "+25%"], { input: TEXT });
  assert.equal(r.code, 0, r.err);
  const a = t.called().argv;
  for (const x of ["--voice=fr-FR-DeniseNeural", "--rate=+20%", "--pitch=-5Hz", "--volume=+25%"]) assert.ok(a.includes(x), x);
});

test("unset options (empty or literal) take the defaults", () => {
  const t = setup();
  const r = t.speak(["--voice", "${user_config.speak_voice}", "--rate", "", "--pitch", "${user_config.speak_pitch}", "--volume", ""], { input: TEXT });
  assert.equal(r.code, 0, r.err);
  const a = t.called().argv;
  for (const x of ["--voice=fr-FR-HenriNeural", "--rate=+10%", "--pitch=+0Hz", "--volume=+0%"]) assert.ok(a.includes(x), x);
});

test("invalid values are refused before the engine runs", () => {
  const cases = [["--rate", "fast"], ["--pitch", "-5%"], ["--voice", "Henri"], ["--volume", "loud"], ["--timeout", "0"], ["--timeout", "601"], ["--name", "a b"], ["--name", "../x"]];
  for (const args of cases) {
    const t = setup();
    const r = t.speak(args, { input: TEXT });
    assert.equal(r.code, 2, args.join(" "));
    assert.ok(r.err.includes(args[1]), r.err);
    assert.equal(t.called(), null, args.join(" "));
  }
});

test("empty or blank text exits 2 without running the engine", () => {
  for (const input of ["", " \n\t\n"]) {
    const t = setup();
    const r = t.speak([], { input });
    assert.equal(r.code, 2);
    assert.equal(t.called(), null);
  }
});

test("engine failure: one line ending on the real error, no file left", () => {
  const t = setup();
  const r = t.speak([], { input: TEXT, env: { FAKE_MODE: "fail" } });
  assert.equal(r.code, 1);
  const lines = r.err.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^orch-speak: edge-tts failed: edge_tts\.exceptions\.NoAudioReceived: /);
  assert.ok(!r.err.includes("RuntimeError"));
  assert.deepEqual(leftovers(t.speakDir), []);
});

test("engine stderr is cleaned of terminal control sequences", () => {
  const t = setup();
  const r = t.speak([], { input: TEXT, env: { FAKE_MODE: "hostile" } });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028]/);
  assert.match(r.err, /Error: bad \]52;c;QQéend/);
});

test("engine that writes nothing: no audio, no file left", () => {
  const t = setup();
  const r = t.speak([], { input: TEXT, env: { FAKE_MODE: "empty" } });
  assert.equal(r.code, 1);
  assert.match(r.err, /produced no audio/);
  assert.deepEqual(leftovers(t.speakDir), []);
});

test("engine that hangs is stopped at the timeout, no file left", () => {
  const t = setup();
  const start = Date.now();
  const r = t.speak(["--timeout", "1"], { input: TEXT, env: { FAKE_MODE: "hang" } });
  assert.equal(r.code, 1);
  assert.match(r.err, /timed out after 1 s/);
  assert.ok(Date.now() - start < 15000);
  assert.deepEqual(leftovers(t.speakDir), []);
});

test("no engine anywhere: exit 3 with the install command", () => {
  const t = setup();
  const empty = join(t.dir, "empty");
  mkdirSync(empty);
  const r = t.speak([], { input: TEXT, drop: ["PATH", "MICROVERSE_EDGE_TTS"], env: { PATH: empty } });
  assert.equal(r.code, 3);
  assert.equal(r.err.trim().split(/\r?\n/).length, 1);
  assert.match(r.err, /pip install --user edge-tts/);
});

test("MICROVERSE_EDGE_TTS pointing nowhere: exit 3 naming the variable", () => {
  const t = setup();
  const r = t.speak([], { input: TEXT, env: { MICROVERSE_EDGE_TTS: join(t.dir, "nope.js") } });
  assert.equal(r.code, 3);
  assert.match(r.err, /MICROVERSE_EDGE_TTS/);
});

// A shell stand-in, with `node` given by absolute path so PATH can be just its folder.
function shim(t, name, body) {
  const bindir = join(t.dir, "shims");
  mkdirSync(bindir, { recursive: true });
  const file = join(bindir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return bindir;
}
const node = (t) => `"${process.execPath}" "${t.fake}"`;

test("edge-tts found on PATH", { skip: !POSIX }, () => {
  const t = setup();
  const bindir = shim(t, "edge-tts", `exec ${node(t)} "$@"`);
  const r = t.speak([], { input: TEXT, drop: ["PATH", "MICROVERSE_EDGE_TTS"], env: { PATH: bindir } });
  assert.equal(r.code, 0, r.err);
  assert.equal(t.called().text, TEXT);
});

test("python -m edge_tts as fallback; module missing means exit 3", { skip: !POSIX }, () => {
  const t = setup();
  const good = shim(t, "python3", `shift 2\nexec ${node(t)} "$@"`);
  const ok = t.speak([], { input: TEXT, drop: ["PATH", "MICROVERSE_EDGE_TTS"], env: { PATH: good } });
  assert.equal(ok.code, 0, ok.err);
  const t2 = setup();
  const bad = shim(t2, "python3", 'echo "/usr/bin/python3: No module named edge_tts" >&2\nexit 1');
  const no = t2.speak([], { input: TEXT, drop: ["PATH", "MICROVERSE_EDGE_TTS"], env: { PATH: bad } });
  assert.equal(no.code, 3);
  assert.match(no.err, /pip install --user edge-tts/);
});

test("purge removes old mp3 and part files of the default folder only", () => {
  const t = setup();
  mkdirSync(t.speakDir, { recursive: true });
  const day = 24 * 3600;
  const make = (dir, name, ageDays) => {
    const f = join(dir, name);
    writeFileSync(f, "x");
    const when = Date.now() / 1000 - ageDays * day;
    utimesSync(f, when, when);
    return f;
  };
  const oldMp3 = make(t.speakDir, "old.mp3", 8);
  const oldPart = make(t.speakDir, "old.mp3.part", 8);
  const newMp3 = make(t.speakDir, "new.mp3", 1);
  const oldTxt = make(t.speakDir, "old.txt", 8);
  const elsewhere = join(t.dir, "mine");
  mkdirSync(elsewhere);
  const outMp3 = make(elsewhere, "keep.mp3", 30);
  const r = t.speak(["--out", join(elsewhere, "b.mp3")], { input: TEXT });
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(oldMp3) && !existsSync(oldPart));
  assert.ok(existsSync(newMp3) && existsSync(oldTxt) && existsSync(outMp3));
});

test("two runs in the same second give two files", () => {
  const t = setup();
  const a = t.speak(["--name", "questions"], { input: TEXT });
  const b = t.speak(["--name", "questions"], { input: TEXT });
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.notEqual(a.out.trim(), b.out.trim());
  assert.match(a.out.trim().split(sep).pop(), /^questions-/);
  assert.match(b.out.trim().split(sep).pop(), /^questions-/);
  assert.equal(leftovers(t.speakDir).length, 2);
});
