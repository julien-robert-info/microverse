"use strict";

// What a pass delivered, kept as a diff (`keepDiff`) and made fit for a judge
// who must not know which organisation wrote it (`anonymise`).

const { createHash } = require("node:crypto");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { gitIn } = require("./suite.js");
const { readMarker } = require("./grade.js");
const { pathPatterns } = require("./transcripts.js");

const ANONYMISER = "a1";
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_CHARS = 150000;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const SESSION = /^[A-Za-z0-9-]+$/;

// R-juge, diff gardé. The options leave git nothing of the copy's configuration
// to run: the agent wrote `diff.external` and the `textconv` drivers of
// `.gitattributes` there. Only what is committed on `main` counts. Writes
// `diffs/<session>.diff` under `campaignDir` and nothing in the slot.
function keepDiff({ suite, campaignDir, session }) {
  if (!SESSION.test(session ?? "")) throw new Error("keepDiff: invalid session id");
  let marker;
  try {
    marker = readMarker(suite.slot);
  } catch {
    return { diff: null, diffError: "no-marker" };
  }
  const args = [
    "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative",
    "--src-prefix=a/", "--dst-prefix=b/", marker.base, "refs/heads/main", "--",
  ];
  const r = gitIn(suite.slot, args, suite.cmdEnv, { encoding: "buffer", maxBuffer: MAX_DIFF_BYTES + 64 * 1024 * 1024 });
  if (r.code !== 0) return { diff: null, diffError: "git-error" };
  const bytes = r.out;
  if (bytes.length > MAX_DIFF_BYTES) return { diff: null, diffError: "too-large" };
  const file = `diffs/${session}.diff`;
  mkdirSync(join(campaignDir, "diffs"), { recursive: true });
  writeFileSync(join(campaignDir, file), bytes);
  const files = bytes.toString("utf8").split("\n").filter((l) => l.startsWith("diff --git ")).length;
  return { diff: { file, sha256: sha256(bytes), bytes: bytes.length, files }, diffError: null };
}

// --- anonymisation ---------------------------------------------------------

// Identifier -> expression, searched without case. A line of the diff that
// holds one is dropped; in the brief the text found becomes `[redacted]`.
// Organisation ids O0 to O3 are in none of them on purpose.
const PATTERNS = {
  morty: /morty/i,
  rick: /\brick\b/i,
  council: /council/i,
  meeseeks: /meeseeks/i,
  microverse: /microverse/i,
  orchestrat: /orchestrat\w*/i,
  worktree: /worktrees?/i,
  subagent: /sub-?agents?/i,
  orchCommand: /orch-[a-z]+/i,
  agentTool: /agent-(?:check|cleanup|model-guard)/i,
  quotaGuard: /quota-guard/i,
  claudeDir: /\.claude[\\/]/i,
  claudeMd: /CLAUDE(?:\.local)?\.md/i,
  homePath: /[a-z]:[\\/]+Users[\\/]+[^\\/\s"']+|\/Users\/[^/\s"']+|\/home\/[^/\s"']+/i,
  uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  agentId: /agent-[0-9a-f]{8,}/i,
  conflict: /^[ +-]?(?:<{7}|>{7})/,
};

// The slot path under the forms of `pathPatterns`, with any run of separators
// standing for one and every case accepted, so that it also finds the text
// as written (D:\x\y, d:/x//y).
function slotPatterns(slot) {
  const out = {};
  [["slot", slot], ["slotPlugin", `${slot.replace(/[\\/]+$/, "")}-plugin`]].forEach(([id, p]) => {
    const sources = pathPatterns(p).map((re) => re.source.replaceAll("\\/", "[\\\\/]+"));
    out[id] = new RegExp(sources.join("|"), "i");
  });
  return out;
}

const allPatterns = (slot) => ({ ...PATTERNS, ...slotPatterns(slot) });
const globalOf = (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
// Paths under these folders and these files at the root are the pass's own working files.
const DROP_PATH = /^(?:\.claude\/|\.claude-plugin\/|notes\/|(?:CLAUDE|CLAUDE\.local)\.md$|\.worktreeinclude$|\.bench-slot$)/;
const DROP_KIND = (p) => {
  if (p.startsWith(".claude-plugin/")) return "claudePlugin";
  if (p.startsWith(".claude/")) return "claudeDir";
  if (p.startsWith("notes/")) return "notes";
  return "workFile";
};
const TRANSCRIPT_LINE = /"sessionId"|"tool_use"|"parentUuid"/;
const INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+/;

const count = (obj, id, n = 1) => {
  obj[id] = (obj[id] ?? 0) + n;
};

// Splits a diff into sections that start at `diff --git `; text before the
// first one is a preamble of its own.
function sectionsOf(diff) {
  return diff.split(/^(?=diff --git )/m).filter((s) => s !== "");
}

// The path a section is about, from its `diff --git a/<p> b/<p>` line (quoted
// by git when it holds unusual characters).
function sectionPath(section) {
  const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?\r?$/.exec(section.split("\n", 1)[0]);
  return m ? m[2] : null;
}

// Header lines: everything before the first hunk.
function headerOf(section) {
  const lines = section.split("\n");
  const hunk = lines.findIndex((l) => l.startsWith("@@"));
  return hunk < 0 ? lines : lines.slice(0, hunk);
}

function cleanDiff(diff, patterns, dropped, words) {
  const kept = [];
  for (let section of sectionsOf(diff)) {
    const path = section.startsWith("diff --git ") ? sectionPath(section) : null;
    if (path !== null && DROP_PATH.test(path)) {
      count(dropped, DROP_KIND(path));
      continue;
    }
    const lines = section.split("\n");
    if (path !== null && LOCKFILES.has(path.split("/").at(-1))) {
      const body = lines.slice(headerOf(section).length);
      const plus = body.filter((l) => l.startsWith("+")).length;
      const minus = body.filter((l) => l.startsWith("-")).length;
      count(dropped, "lockfile");
      kept.push(`[lockfile: +${plus} -${minus} lines]\n`);
      continue;
    }
    if (lines.some((l) => l.startsWith("+") && !l.startsWith("+++") && TRANSCRIPT_LINE.test(l))) {
      count(dropped, "transcript");
      continue;
    }
    // A pattern in a file's name or header drops the whole section.
    const header = headerOf(section).filter((l) => !INDEX_LINE.test(l));
    const hit = Object.entries(patterns).find(([, re]) => header.some((l) => re.test(l)));
    if (hit) {
      count(dropped, "headerPattern");
      continue;
    }
    const out = cleanSection(lines, patterns, dropped, words);
    if (out !== null) kept.push(out);
  }
  return kept.join("");
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const rangeText = (start, n) => (n === 1 ? `${start}` : `${start},${n}`);

// Counts the patterns a line holds; the line goes when it holds one.
function holdsPattern(line, patterns, words) {
  const ids = Object.entries(patterns).filter(([, re]) => re.test(line)).map(([id]) => id);
  for (const id of ids) count(words, id);
  return ids.length > 0;
}

// Lines of one section without the ones that hold a pattern, and with the
// hunk headers written again as if those lines had never existed: a trace of
// what was removed (a count that does not match the body, a hunk with no
// change, a start shifted) would be seen by the judge for one organisation
// only. Returns null when every hunk of the section disappears.
function cleanSection(allLines, patterns, dropped, words) {
  const trailing = allLines.at(-1) === "" ? [""] : [];
  const lines = trailing.length ? allLines.slice(0, -1) : allLines;
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  const plain = (l) => {
    if (INDEX_LINE.test(l)) {
      count(dropped, "indexLine");
      return false;
    }
    return !holdsPattern(l, patterns, words);
  };
  if (firstHunk < 0) return [...lines.filter(plain), ...trailing].join("\n");

  const out = lines.slice(0, firstHunk).filter((l) => {
    if (!INDEX_LINE.test(l)) return true;
    count(dropped, "indexLine");
    return false;
  });
  let removedOld = 0; // old-side lines removed from earlier hunks
  let shift = 0; // sum of (new count - old count) over the hunks kept so far
  let hunks = 0;
  let kept = 0;
  for (let i = firstHunk; i < lines.length; ) {
    let end = i + 1;
    while (end < lines.length && !lines[end].startsWith("@@")) end++;
    const head = lines[i];
    const body = lines.slice(i + 1, end);
    i = end;
    hunks++;
    const m = HUNK_HEADER.exec(head);
    if (!m) {
      // Not a plain unified hunk: keep what holds no pattern.
      kept++;
      out.push(...[head, ...body].filter(plain));
      continue;
    }
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    // Header context text that holds a pattern: the ranges stay, the text goes.
    const context = holdsPattern(m[5], patterns, words) ? "" : m[5];
    const keep = [];
    let removedHere = 0;
    let prevKept = true;
    for (const l of body) {
      if (l.startsWith("\\")) {
        if (prevKept) keep.push(l);
        continue;
      }
      prevKept = !holdsPattern(l, patterns, words);
      if (prevKept) keep.push(l);
      else if (l[0] !== "+") removedHere++;
    }
    const changed = keep.some((l) => l[0] === "+" || l[0] === "-");
    if (changed) {
      const b = keep.filter((l) => l[0] === " " || l[0] === "-").length;
      const d = keep.filter((l) => l[0] === " " || l[0] === "+").length;
      // The first old line of the hunk, where git counts an empty range from the line before.
      const first = (oldCount === 0 ? oldStart + 1 : oldStart) - removedOld;
      const a = b === 0 ? first - 1 : first;
      const c = d === 0 ? first + shift - 1 : first + shift;
      out.push(`@@ -${rangeText(a, b)} +${rangeText(c, d)} @@${context}`, ...keep);
      shift += d - b;
      kept++;
    }
    removedOld += removedHere;
  }
  if (kept === 0 && hunks > 0) {
    count(dropped, "emptyHunks");
    return null;
  }
  return [...out, ...trailing].join("\n");
}

function cleanBrief(brief, patterns, replaced) {
  let text = brief;
  for (const [id, re] of Object.entries(patterns)) {
    // The conflict marker is line-anchored: apply it per line.
    const g = globalOf(re);
    text = text
      .split("\n")
      .map((line) => line.replace(g, () => (count(replaced, id), "[redacted]")))
      .join("\n");
  }
  return text;
}

const checksText = (checks) => Object.entries(checks ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, v]) => `- ${n}: ${v}`).join("\n") || "(none)";

// The judge's input from the three sources it may see and nothing else: the
// brief, the checks of `validate.json` and the diff. `afterReplace` is text
// added to the brief once the replacements are done, to test the final check.
// Status `ok`, `too-large` (150 000 characters) or `anonymisation-failed`: in
// both failures there is no input and the judge is not called.
function anonymise({ diff, brief, checks = {}, slot, afterReplace = "" }) {
  const patterns = allPatterns(slot);
  const redactions = { dropped: {}, words: {}, brief: {} };
  const cleanedDiff = cleanDiff(String(diff), patterns, redactions.dropped, redactions.words);
  const cleanedBrief = cleanBrief(String(brief), patterns, redactions.brief) + afterReplace;
  const input = `## Task\n\n${cleanedBrief.trim()}\n\n## Checks\n\n${checksText(checks)}\n\n## Submission\n\n${cleanedDiff}`;
  // Fail closed on the whole input, the headings and the check names included.
  const left = input.split("\n").some((l) => Object.values(patterns).some((re) => re.test(l)));
  if (left) return { input: null, redactions, status: "anonymisation-failed" };
  if (input.length > MAX_INPUT_CHARS) return { input: null, redactions, status: "too-large" };
  return { input, redactions, status: "ok" };
}

module.exports = { keepDiff, anonymise, PATTERNS, ANONYMISER, MAX_DIFF_BYTES, MAX_INPUT_CHARS };
