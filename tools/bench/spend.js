"use strict";

// What a campaign has spent, in points of the quota counters, and the guard
// that stops it before the next call would cross a cap. Pure readers: they
// write nothing and call no model.

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const FIVE_HOURS = 5 * 3600 * 1000;
const NOT_JUDGEABLE = new Set(["contaminated", "misconfigured"]);

function readLines(file) {
  if (!existsSync(file)) return [];
  const out = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((text, i) => {
      if (!text.trim()) return;
      try {
        out.push(JSON.parse(text));
      } catch (e) {
        // A line that cannot be read hides a cost: stop rather than undercount.
        throw new Error(`${file} line ${i + 1} is not JSON (${e.message})`);
      }
    });
  return out;
}

// A pass worth a judgment: it kept a diff with at least one file and did not
// end contaminated or misconfigured.
const judgeable = (p) => p?.diff != null && p.diff.files >= 1 && !NOT_JUDGEABLE.has(p.outcome);

// Sums of `cost.weekPts` and of the five-hour points of the last five hours,
// over the passes and the judgments (every attempt, a shared judgment once: it
// is one line). A cost that is missing, or whose points are null, makes the sum
// null: unknown is never zero. A judgment that made no call has `cost: null`
// and costs nothing.
// `unjudged`: judgeable passes without any link line.
function spent({ campaignDir, now = Date.now() }) {
  const passes = readLines(join(campaignDir, "passes.jsonl"));
  const judge = readLines(join(campaignDir, "judge.jsonl"));
  let weekPts = 0;
  let fiveHourPts = 0;
  const add = (cost, end) => {
    const week = cost?.weekPts;
    const five = cost?.fiveHourPts;
    weekPts = weekPts === null || !Number.isFinite(week) ? null : weekPts + week;
    if (end === null || now - end < FIVE_HOURS) fiveHourPts = fiveHourPts === null || !Number.isFinite(five) ? null : fiveHourPts + five;
  };
  const endOf = (startedAt, ms) => {
    const t = Date.parse(startedAt);
    // An unreadable start cannot be placed out of the window: count it in.
    return Number.isFinite(t) && Number.isFinite(ms) ? t + ms : null;
  };
  for (const p of passes) add(p.cost, endOf(p.startedAt, p.minutes * 60000));
  for (const j of judge) if (j.kind === "judgment" && j.cost) add(j.cost, endOf(j.startedAt, j.seconds * 1000));
  const linked = new Set(judge.filter((j) => j.kind === "link").map((j) => j.pass));
  return { weekPts, fiveHourPts, unjudged: passes.filter((p) => judgeable(p) && !linked.has(p.session)).length };
}

// `{ ok, reason }`. The week cap counts the judge reserve (`reserveUsd`, for
// the passes of a campaign not judged yet) and the next call (`nextUsd`), both
// converted by `ratios.ratio7`; the five-hour cap counts the next call only.
// A missing ratio or an unknown spend refuses: without them there is no guard.
function guard({ spent: s, reserveUsd = 0, nextUsd, ratios, capWeek, capFive }) {
  const r7 = ratios?.ratio7;
  const r5 = ratios?.ratio5;
  if (![r7, r5].every((r) => Number.isFinite(r) && r > 0)) return { ok: false, reason: "no ratio" };
  if (s?.weekPts == null || s?.fiveHourPts == null) return { ok: false, reason: "spend unknown" };
  if (s.weekPts + (reserveUsd + nextUsd) * r7 > capWeek) {
    return { ok: false, reason: s.weekPts + nextUsd * r7 > capWeek ? "week cap" : "week cap (judge reserve)" };
  }
  if (s.fiveHourPts + nextUsd * r5 > capFive) return { ok: false, reason: "five-hour cap" };
  return { ok: true, reason: null };
}

module.exports = { spent, guard, judgeable, readLines };
