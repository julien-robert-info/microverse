// PostToolUse hook on Bash and PowerShell: after a `git merge` that left a merge
// commit whose subject starts with `merge:`, records the merge under the
// `trace_dir` option (docs/traces.md): merge sha, the branch's commits, the
// check that covered its head and the council's reviews. Same guarantees as
// trace-launch.js: silent, exit code 0, read-only git.
//
// Detection looks at the final state of the repository, not at the command's
// result: a PowerShell command often chains `git merge ...; git branch -d ...`.
"use strict";

const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join, resolve } = require("node:path");
const t = require("./trace-lib.js");

// Shell words of one command line, split into the segments between `;`, `&&`,
// `||`, `|`, `&` and line breaks. Quotes group a word and are dropped; no
// variable or escape is interpreted (the line is only inspected, never run).
// An `&` next to `>` or `<` (`2>&1`, `>&2`, `&>file`) belongs to its word.
function segments(command) {
  const out = [[]];
  let word = null;
  let quote = null;
  const endWord = () => {
    if (word !== null) out[out.length - 1].push(word);
    word = null;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= "";
    } else if (/\s/.test(c) && c !== "\n") endWord();
    else if (c === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) word = (word ?? "") + c;
    else if (c === ";" || c === "&" || c === "|" || c === "\n") {
      endWord();
      if (out[out.length - 1].length) out.push([]);
    } else word = (word ?? "") + c;
  }
  endWord();
  return out.filter((s) => s.length);
}

// Options of `git merge` that take the next word as their value.
const VALUE_OPTS = new Set(["-m", "-F", "-s", "-X", "--message", "--file", "--strategy", "--strategy-option", "--into-name"]);
// Global git options that take the next word as their value.
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

// Start of a redirection word: `>f`, `2>f`, `>>f`, `<f`, `&>f`, `2>&1`, `>&2`.
const REDIRECT = /^(?:\d*|&)(?:>>?|<)&?/;

// The last `git [global options] merge [options] <branch>` of the command, as
// { dir, branch }: `dir` from the `-C` options, `branch` the last word that is
// neither an option nor an option's value. null when no such command, or when
// it only stops or aborts a merge.
function parseMerge(command, cwd) {
  let found = null;
  for (const words of segments(command)) {
    const g = words.findIndex((w) => /^git(\.exe)?$/i.test(w.split(/[\\/]/).pop()));
    if (g < 0) continue;
    let dir = cwd;
    let i = g + 1;
    while (i < words.length && words[i].startsWith("-")) {
      if (words[i] === "-C" && i + 1 < words.length) dir = resolve(dir, words[i + 1]);
      i += GIT_VALUE_OPTS.has(words[i]) ? 2 : 1;
    }
    if (words[i] !== "merge") continue;
    const rest = words.slice(i + 1);
    if (rest.includes("--abort") || rest.includes("--quit")) continue;
    let branch = null;
    for (let j = 0; j < rest.length; j++) {
      if (rest[j].startsWith("-")) {
        if (VALUE_OPTS.has(rest[j])) j++;
      } else if (REDIRECT.test(rest[j])) {
        // A bare operator (`>`, `2>`, `&>`) takes the next word as its target.
        if (rest[j].replace(REDIRECT, "") === "") j++;
      } else branch = rest[j];
    }
    found = { dir, branch };
  }
  return found;
}

// The last `(<id>)` of the subject.
function missionOf(subject) {
  const all = [...subject.matchAll(/\(([A-Za-z0-9][\w.-]*)\)/g)];
  return all.length ? all[all.length - 1][1] : null;
}

// A merge record of this session folder already carries this sha.
function alreadyRecorded(out, mergeSha) {
  try {
    const tail = `-${mergeSha.slice(0, 12)}.json`;
    return readdirSync(out).some((n) => n.startsWith("merge-") && n.endsWith(tail) && t.readJson(join(out, n))?.mergeSha === mergeSha);
  } catch {
    return false;
  }
}

// Id of the latest check of the project whose head is `head`; null when none.
function checkFor(dir, slug, head) {
  try {
    const root = join(dir, t.safeSegment(slug), "checks");
    const ids = readdirSync(root)
      .filter((n) => n.endsWith(`-${head.slice(0, 12)}`))
      .sort()
      .reverse();
    return ids.find((id) => t.readJson(join(root, id, "check.json"))?.head === head) ?? null;
  } catch {
    return null;
  }
}

// notes/<mission>.review*.md of the repository root, copied beside the record.
function copyReviews(top, mission, mergeSha, out) {
  if (!mission) return [];
  let names;
  try {
    names = readdirSync(join(top, "notes")).filter((n) => n.startsWith(`${mission}.review`) && n.endsWith(".md"));
  } catch {
    return [];
  }
  const reviews = [];
  for (const name of names.sort()) {
    const src = join(top, "notes", name);
    if (!statSync(src).isFile()) continue;
    const data = readFileSync(src);
    const file = `reviews/${mergeSha}/${name}`;
    t.writeAtomic(join(out, file), data);
    reviews.push({ rel: `notes/${name}`, sha256: t.sha256(data), file });
  }
  return reviews;
}

function main(dir) {
  const p = t.readPayload();
  const command = p.tool_input && typeof p.tool_input.command === "string" ? p.tool_input.command : "";
  if (!command) return;
  const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : process.cwd();
  const m = parseMerge(command, cwd);
  if (!m) return;

  const line = t.gitLine(m.dir, "rev-list", "--parents", "-n", "1", "HEAD");
  const [mergeSha, ...parents] = line ? line.split(/\s+/) : [];
  if (!mergeSha || parents.length !== 2) return;
  const subject = t.gitLine(m.dir, "log", "-1", "--format=%s", "HEAD");
  if (!subject || !subject.startsWith("merge:")) return;

  const out = t.sessionDir(dir, p);
  if (alreadyRecorded(out, mergeSha)) return;

  const side = t.git(m.dir, "rev-list", `${parents[0]}..${parents[1]}`);
  const top = t.gitLine(m.dir, "rev-parse", "--show-toplevel");
  const mission = missionOf(subject);
  const now = new Date();
  const record = {
    v: 1,
    kind: "merge",
    at: now.toISOString(),
    session: p.session_id ?? null,
    branch: m.branch,
    mergeSha,
    parents,
    sideCommits: side == null ? null : side.split(/\r?\n/).filter(Boolean),
    mission,
    check: checkFor(dir, t.projectSlug(t.mainRootOf(m.dir) ?? top ?? m.dir), parents[1]),
    reviews: top ? copyReviews(top, mission, mergeSha, out) : [],
  };
  t.writeAtomic(join(out, `merge-${t.stamp(now)}-${mergeSha.slice(0, 12)}.json`), JSON.stringify(record, null, 2) + "\n");
}

t.runHook("trace-merge", main);
