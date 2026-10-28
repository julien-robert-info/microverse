"use strict";

// Maintainer script (not on the plugin users' PATH, hence not in bin/):
// node tools/release.js <x.y.z> [--skip-checks]
// Prepares a release in the current repository: CHANGELOG, plugin.json, tests,
// commit, tag, validation. Prints the push and publish commands, runs none.

const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATED = /^\[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/;

// Returns the list of problems between a CHANGELOG and a plugin manifest.
function checkRelease(changelog, pluginJson) {
  const problems = [];
  const headings = changelog.split(/\r?\n/).filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim());
  if (!headings.includes("Unreleased")) problems.push("no Unreleased section");
  const versions = [];
  for (const h of headings) {
    if (h === "Unreleased") continue;
    const m = DATED.exec(h);
    if (!m) { problems.push(`heading without [x.y.z] - YYYY-MM-DD: ${h}`); continue; }
    if (!SEMVER.test(m[1])) problems.push(`not SemVer: ${m[1]}`);
    versions.push(m[1]);
  }
  if (versions.length === 0) problems.push("no dated version");
  const { version } = JSON.parse(pluginJson);
  if (!SEMVER.test(String(version))) problems.push(`plugin.json version is not SemVer: ${version}`);
  if (versions.length && versions[0] !== version) problems.push(`first version ${versions[0]} != plugin.json ${version}`);
  return problems;
}

function isGreater(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

// Splits the CHANGELOG at `## Unreleased`: `body` is its content up to the next
// `## ` heading, `before` and `after` the lines around it. LF or CRLF input.
function splitUnreleased(changelog) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "## Unreleased");
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  return { before: lines.slice(0, start), body: lines.slice(start + 1, end), after: lines.slice(end) };
}

const hasEntry = (body) => body.some((l) => l.trim() !== "" && !l.startsWith("### "));

// Moves the Unreleased body under the dated heading; returns the new text (LF)
// and the section of the new version.
function moveUnreleased(changelog, version, date) {
  const parts = splitUnreleased(changelog);
  const body = [...parts.body];
  while (body.length && body[0].trim() === "") body.shift();
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  const section = [`## [${version}] - ${date}`, "", ...body];
  const lines = [...parts.before, "## Unreleased", "", ...section];
  if (parts.after.some((l) => l.trim() !== "")) lines.push("", ...parts.after);
  return { text: lines.join("\n").replace(/\n*$/, "\n"), section: section.join("\n") + "\n" };
}

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), error: r.error };
}

function refuse(reason) {
  console.error(`release refused: ${reason}`);
  process.exit(1);
}

function main(argv) {
  const skipChecks = argv.includes("--skip-checks");
  const version = argv.find((a) => !a.startsWith("--"));
  if (!version || !SEMVER.test(version)) refuse(`"${version ?? ""}" is not a x.y.z version`);

  const top = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  if (top.code !== 0) refuse("not inside a git repository");
  const root = top.out.trim();
  const git = (...args) => run("git", args, root);
  const changelogPath = join(root, "CHANGELOG.md");
  const pluginPath = join(root, ".claude-plugin", "plugin.json");

  const plugin = readFileSync(pluginPath, "utf8");
  const current = JSON.parse(plugin).version;
  if (!isGreater(version, String(current))) refuse(`${version} is not greater than plugin.json's ${current}`);
  if (git("status", "--porcelain").out.trim() !== "") refuse("the working tree is not clean");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").out.trim();
  if (branch !== "main") refuse(`the current branch is ${branch}, not main`);
  if (git("rev-parse", "-q", "--verify", `refs/tags/v${version}`).code === 0) refuse(`tag v${version} already exists`);
  const changelog = readFileSync(changelogPath, "utf8");
  const parts = splitUnreleased(changelog);
  if (!parts || !hasEntry(parts.body)) refuse("## Unreleased has no entry");

  const moved = moveUnreleased(changelog, version, localDate());
  // Only the value changes: the file's formatting and line endings stay.
  const newPlugin = plugin.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  const problems = checkRelease(moved.text, newPlugin);
  if (problems.length) refuse(`checkRelease: ${problems.join("; ")}`);
  writeFileSync(changelogPath, moved.text);
  writeFileSync(pluginPath, newPlugin);

  const abort = (msg) => {
    git("checkout", "--", "CHANGELOG.md", ".claude-plugin/plugin.json");
    refuse(msg);
  };

  if (skipChecks) {
    console.log("--skip-checks: tests and plugin validation skipped");
  } else {
    const home = mkdtempSync(join(tmpdir(), "microverse-release-home-"));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const t = spawnSync(process.execPath, ["--test"], { cwd: root, env, encoding: "utf8" });
    rmSync(home, { recursive: true, force: true });
    if (t.status !== 0) {
      process.stdout.write((t.stdout ?? "").split("\n").slice(-40).join("\n"));
      abort("tests failed; CHANGELOG.md and plugin.json restored");
    }
    console.log("tests passed");
  }

  git("add", "CHANGELOG.md", ".claude-plugin/plugin.json");
  const c = git("commit", "-q", "-m", `chore(release): v${version}`, "--", "CHANGELOG.md", ".claude-plugin/plugin.json");
  if (c.code !== 0) abort(`commit failed: ${c.out.trim()}`);
  const tg = git("tag", "-a", `v${version}`, "-m", `v${version}`);
  if (tg.code !== 0) refuse(`tag failed: ${tg.out.trim()}; the commit is in place`);
  console.log(`committed and tagged v${version}`);

  if (!skipChecks) {
    // An export of the commit: untracked files of the working tree (a
    // CLAUDE.local.md) would be warnings under --strict.
    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "microverse-release-")));
    mkdirSync(join(tmp, "src"));
    const a = git("archive", "-o", join(tmp, "release.tar"), "HEAD");
    // Relative paths: GNU tar reads "C:" in an archive path as a remote host.
    const x = a.code === 0 ? run("tar", ["-xf", "release.tar", "-C", "src"], tmp) : a;
    if (x.code !== 0) refuse(`export failed: ${x.out.trim()}`);
    const cmd = `claude plugin validate --strict ${join(tmp, "src")}`;
    const v = run("claude", ["plugin", "validate", "--strict", join(tmp, "src")], root);
    if (v.error && v.error.code === "ENOENT") {
      console.log(`claude not found; run it yourself: ${cmd}`);
    } else if (v.code !== 0) {
      console.error(v.out.trim());
      console.error(`validation failed. To undo the release, run:\n  git tag -d v${version}\n  git reset --hard HEAD~1`);
      process.exit(1);
    } else {
      console.log("plugin validate --strict passed");
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "microverse-notes-"));
  const notes = join(dir, `release-v${version}.md`);
  writeFileSync(notes, moved.section);
  console.log("Run when ready:");
  console.log("  git push origin main");
  console.log(`  git push origin v${version}`);
  console.log(`  gh release create v${version} --title v${version} --notes-file ${notes} --verify-tag`);
}

module.exports = { checkRelease };

if (require.main === module) main(process.argv.slice(2));
