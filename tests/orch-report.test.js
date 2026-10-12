"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { git, makeRepo, script } = require("./helpers.js");

const HOUR = 3600e3;

function commit(dir, file, message) {
  writeFileSync(join(dir, file), `${message}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-qm", message);
}

// A feature branch of two commits merged with a merge commit.
function merge(dir, name, files) {
  git(dir, "checkout", "-q", "-b", `feat/${name}`);
  for (const f of files) commit(dir, `${f}.txt`, `feat: ${f}`);
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "--no-ff", "-q", "-m", `merge: ${name}`, `feat/${name}`);
}

const head = (dir) => git(dir, "rev-parse", "--short", "HEAD").out.trim();

// A repository whose `--since` commit is followed by two merges and a direct
// commit, after a commit that must not appear.
function series() {
  const { dir } = makeRepo({});
  commit(dir, "before.txt", "chore: before");
  const since = head(dir);
  merge(dir, "one", ["a1", "a2"]);
  commit(dir, "direct.txt", "fix: direct");
  merge(dir, "two", ["b1"]);
  return { dir, since };
}

const emptyHome = () => {
  const home = mkdtempSync(join(tmpdir(), "microverse-home-"));
  return { HOME: home, USERPROFILE: home };
};

function quotaFile(week, five) {
  const now = Date.now();
  const file = join(mkdtempSync(join(tmpdir(), "microverse-quota-")), "quota.json");
  writeFileSync(
    file,
    JSON.stringify({
      observations: [
        { periodType: "seven-day", usedFraction: week, resetAt: now + 48 * HOUR, observedAt: now },
        { periodType: "five-hour", usedFraction: five, resetAt: now + 2 * HOUR, observedAt: now },
      ],
    }),
  );
  return file;
}

test("lists the merges with their commits and the direct commits, oldest first", () => {
  const { dir, since } = series();
  const r = script("orch-report", ["--since", since, "--file", quotaFile(0.1, 0.1)], dir, emptyHome());
  assert.equal(r.code, 0, r.out);
  const section = r.out.split("## Agents")[0];
  const items = section.split("\n").filter((l) => l.startsWith("-") || l.startsWith("  -"));
  assert.match(section, new RegExp(`## Merged since ${since}`));
  assert.equal(items.length, 6, section);
  assert.match(items[0], /^- \w+ merge: one$/);
  assert.match(items[1], /^ {2}- \w+ feat: a1$/);
  assert.match(items[2], /^ {2}- \w+ feat: a2$/);
  assert.match(items[3], /^- \w+ fix: direct$/);
  assert.match(items[4], /^- \w+ merge: two$/);
  assert.match(items[5], /^ {2}- \w+ feat: b1$/);
  assert.doesNotMatch(section, /chore: before/);
});

test("says nothing when nothing was merged since the commit", () => {
  const { dir, since } = series();
  const r = script("orch-report", ["--since", head(dir), "--file", quotaFile(0.1, 0.1)], dir, emptyHome());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /## Merged since \w+\s+nothing/);
  assert.notEqual(since, head(dir));
});

test("an agent run of the fake home appears under Agents with the total", () => {
  const { dir, since } = series();
  const home = mkdtempSync(join(tmpdir(), "microverse-home-"));
  const slug = dir.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
  const sessions = join(home, ".claude", "projects", slug);
  const subagents = join(sessions, "sess1", "subagents");
  mkdirSync(subagents, { recursive: true });
  const ts = new Date(Date.now() + 60e3).toISOString();
  const line = (id, model, input) =>
    JSON.stringify({ timestamp: ts, requestId: `r-${id}`, message: { id, model, usage: { input_tokens: input, output_tokens: 0 } } }) + "\n";
  writeFileSync(join(sessions, "sess1.jsonl"), line("m1", "claude-opus-5-5", 1e6));
  writeFileSync(join(subagents, "agent-a1.jsonl"), line("m2", "claude-sonnet-5-5", 1.5e6));
  writeFileSync(join(subagents, "agent-a1.meta.json"), JSON.stringify({ agentType: "microverse:morty", description: "Add the thing" }));
  const r = script("orch-report", ["--since", since, "--file", quotaFile(0.1, 0.1)], dir, { HOME: home, USERPROFILE: home });
  assert.equal(r.code, 0, r.out);
  const agents = r.out.split("## Agents")[1].split("## Quota")[0];
  assert.match(agents, /microverse:morty\tclaude-sonnet-5-5\t1\t3\.00\tAdd the thing/);
  assert.match(agents, /Total: \$3\.00/);
  assert.doesNotMatch(agents, /Advisor:/);
});

test("advisor calls of conversations and agents are summed under Agents", () => {
  const { dir, since } = series();
  const home = mkdtempSync(join(tmpdir(), "microverse-home-"));
  const slug = dir.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
  const sessions = join(home, ".claude", "projects", slug);
  const subagents = join(sessions, "sess1", "subagents");
  mkdirSync(subagents, { recursive: true });
  const ts = new Date(Date.now() + 60e3).toISOString();
  const line = (id, advisorInput) =>
    JSON.stringify({
      timestamp: ts,
      requestId: `r-${id}`,
      message: {
        id,
        model: "claude-sonnet-5-5",
        usage: {
          input_tokens: 1e6,
          output_tokens: 0,
          iterations: [
            { type: "message", input_tokens: 1e6, output_tokens: 0 },
            { type: "advisor_message", model: "claude-opus-5-5", input_tokens: advisorInput, output_tokens: 0 },
          ],
        },
      },
    }) + "\n";
  // 0.25M + 0.5M + 0.25M advisor input tokens at $4 per MTok: 4 dollars.
  writeFileSync(join(sessions, "sess1.jsonl"), line("m1", 250000));
  writeFileSync(join(subagents, "agent-a1.jsonl"), line("m2", 500000) + line("m3", 250000));
  writeFileSync(join(subagents, "agent-a1.meta.json"), JSON.stringify({ agentType: "microverse:morty", description: "Add the thing" }));
  const r = script("orch-report", ["--since", since, "--file", quotaFile(0.1, 0.1)], dir, { HOME: home, USERPROFILE: home });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out.split("## Agents")[1].split("## Quota")[0], /Advisor: 3 calls, 4\.00 \$/);
});

test("without transcripts the error of orch-usage is printed and the report goes on", () => {
  const { dir, since } = series();
  const r = script("orch-report", ["--since", since, "--file", quotaFile(0.1, 0.1)], dir, emptyHome());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out.split("## Agents")[1].split("## Quota")[0], /no conversation for/);
  assert.match(r.out, /## Context[\s\S]*no conversation for/);
});

test("the quota file option reaches orch-quota", () => {
  const { dir, since } = series();
  const r = script("orch-report", ["--since", since, "--file", quotaFile(0.99, 0.1)], dir, emptyHome());
  assert.match(r.out.split("## Quota")[1].split("## Context")[0], /Advice: stop/);
});

test("a missing or unknown --since is a usage error", () => {
  const { dir } = series();
  assert.equal(script("orch-report", [], dir, emptyHome()).code, 2);
  assert.equal(script("orch-report", ["--since", "does-not-exist"], dir, emptyHome()).code, 2);
});
