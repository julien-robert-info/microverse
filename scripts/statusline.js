#!/usr/bin/env node
"use strict";

// Status line command of the microverse plugin. Claude Code pipes it a JSON
// payload on each update; it records the quota counters (`rate_limits`) so
// that orch-quota can read them without the VS Code extension, and prints one
// line for the status bar. It also appends the rising readings to a 15-day
// history (statusline-history/), which orch-quota reads for the usage at the
// start of a period and for the calibration.
//
//   node statusline.js            read the payload on stdin, record, print
//   node statusline.js --install  copy this file to the data folder, print the
//                                 `statusLine` setting that points at the copy
//
// Self-contained on purpose: a plugin cannot ship `statusLine`, and the
// setting must not hold a plugin path that changes on update, so this file runs
// from a copy in the data folder. Only `node:` modules, no relative require.

const {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

// Not CLAUDE_PLUGIN_DATA: neither the status line command nor the Bash tool
// receives it, only hooks do. One fixed folder avoids two of them.
const dataDir = () => join(homedir(), ".claude", "microverse");
const readingsDir = () => join(dataDir(), "statusline");
// Its own folder: the pruning of readingsDir() must never reach it.
const historyDir = () => join(dataDir(), "statusline-history");
const HISTORY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

// The reading of a payload, or null when it carries no counter. A window that
// is missing or malformed is left out: it is not 0.
function readingOf(input, now = Date.now()) {
  const limits = input && typeof input === "object" ? input.rate_limits : null;
  if (!limits || typeof limits !== "object") return null;
  const window = (w) =>
    w && isNum(w.used_percentage) && isNum(w.resets_at)
      ? { used: w.used_percentage, resetsAt: w.resets_at * 1000 }
      : undefined;
  const five = window(limits.five_hour);
  const week = window(limits.seven_day);
  if (!five && !week) return null;
  return { v: 1, at: now, ...(five && { five }), ...(week && { week }) };
}

const pct = (n) => `${Math.round(n)} %`;

function formatLine(input) {
  if (!input || typeof input !== "object") return "microverse: no data";
  const parts = [];
  const model = input.model && input.model.display_name;
  if (typeof model === "string" && model) parts.push(model);
  const ctx = input.context_window && input.context_window.used_percentage;
  if (isNum(ctx)) parts.push(`ctx ${pct(ctx)}`);
  const limits = input.rate_limits || {};
  if (limits.five_hour && isNum(limits.five_hour.used_percentage)) parts.push(`5h ${pct(limits.five_hour.used_percentage)}`);
  if (limits.seven_day && isNum(limits.seven_day.used_percentage)) parts.push(`7d ${pct(limits.seven_day.used_percentage)}`);
  return parts.length ? parts.join(" · ") : "microverse: no data";
}

// Writes the reading of one session; false when the id is not a safe file name
// or the write failed. The temp name carries the pid: Claude Code cancels a
// running script when the next update fires, so two can overlap.
function writeReading(session, reading) {
  if (typeof session !== "string" || !SESSION_ID.test(session)) return false;
  const dir = readingsDir();
  const file = join(dir, `${session}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(reading));
    renameSync(tmp, file);
    return true;
  } catch {
    // On Windows the rename throws EPERM/EBUSY when a reader has the file open.
    try {
      unlinkSync(tmp);
    } catch {}
    return false;
  }
}

// The readings of all sessions: [{ session, at, five?, week? }]. Truncated,
// foreign-version and temp files are skipped. `prune` deletes the readings and
// temp files older than 8 days (by `at`, else by modification time) from this
// folder only.
function readReadings({ now = Date.now(), prune = false } = {}) {
  const dir = readingsDir();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const isTmp = name.endsWith(".tmp");
    if (!isTmp && !name.endsWith(".json")) continue;
    const file = join(dir, name);
    let data = null;
    if (!isTmp) {
      try {
        data = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
    }
    const valid = data && typeof data === "object" && data.v === 1 && isNum(data.at);
    if (prune) {
      let at = valid ? data.at : NaN;
      if (!isNum(at)) {
        try {
          at = statSync(file).mtimeMs;
        } catch {}
      }
      if (isNum(at) && now - at > 8 * DAY) {
        try {
          unlinkSync(file);
        } catch {}
        continue;
      }
    }
    if (!valid) continue;
    const window = (w) => (w && isNum(w.used) && isNum(w.resetsAt) ? { used: w.used, resetsAt: w.resetsAt } : undefined);
    const five = window(data.five);
    const week = window(data.week);
    out.push({ session: name.slice(0, -".json".length), at: data.at, ...(five && { five }), ...(week && { week }) });
  }
  return out;
}

// The counters of `reading` worth a history line given the session's previous
// reading (null when it had none): a counter the previous one lacked, a new
// window (reset moved by an hour or more), or a higher value. Values are
// compared as the integers stored, so a repeat of 64.6 appends nothing.
function historyLines(reading, previous) {
  const out = [];
  for (const [type, key] of [["five-hour", "five"], ["seven-day", "week"]]) {
    const cur = reading[key];
    if (!cur) continue;
    const used = Math.min(100, Math.max(0, Math.round(cur.used)));
    const prev = previous && previous.v === 1 ? previous[key] : null;
    const known = prev && isNum(prev.used) && isNum(prev.resetsAt);
    if (known && Math.abs(cur.resetsAt - prev.resetsAt) < HOUR && used <= Math.round(prev.used)) continue;
    out.push({ v: 1, at: reading.at, type, used, resetsAt: cur.resetsAt });
  }
  return out;
}

// Appends the lines to the file of the UTC day of `at`. One write per line:
// two renders can append at once on Windows, and a torn line is skipped by the
// reader. False when nothing could be written.
function appendHistory(lines) {
  let ok = true;
  for (const line of lines) {
    try {
      const day = new Date(line.at).toISOString().slice(0, 10);
      mkdirSync(historyDir(), { recursive: true });
      appendFileSync(join(historyDir(), `${day}.jsonl`), JSON.stringify(line) + "\n");
    } catch {
      ok = false;
    }
  }
  return ok;
}

// The history as observations, oldest and newest included: the dated files of
// the last `days` days (by the UTC date in the name). Torn, foreign-version and
// non-numeric lines are skipped. `prune` deletes the dated files older than
// that, never today's, and nothing else.
function readHistory({ now = Date.now(), days = 15, prune = false } = {}) {
  let names;
  try {
    names = readdirSync(historyDir());
  } catch {
    return [];
  }
  const today = Math.floor(now / DAY);
  const out = [];
  for (const name of names.sort()) {
    const m = HISTORY_FILE.exec(name);
    if (!m) continue;
    const dayNo = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY);
    if (!Number.isFinite(dayNo)) continue;
    const file = join(historyDir(), name);
    if (today - dayNo > days) {
      if (prune && dayNo < today) {
        try {
          unlinkSync(file);
        } catch {}
      }
      continue;
    }
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n")) {
      let d;
      try {
        d = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!d || d.v !== 1 || !isNum(d.at) || !isNum(d.used) || !isNum(d.resetsAt)) continue;
      if (d.type !== "five-hour" && d.type !== "seven-day") continue;
      out.push({ periodType: d.type, usedFraction: d.used / 100, resetAt: d.resetsAt, observedAt: d.at, source: "statusline" });
    }
  }
  return out;
}

const installedPath = () => join(dataDir(), "statusline.js");

const same = (a, b) => {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

// Copies the running file to the data folder when absent or different, and
// returns the `statusLine` setting that runs the copy. No refreshInterval: it
// would rerun the script with the same rate_limits and make `at` look recent.
function install() {
  const dest = installedPath();
  if (dest !== __filename && !same(__filename, dest)) {
    mkdirSync(dataDir(), { recursive: true });
    copyFileSync(__filename, dest);
  }
  // Forward slashes and quotes: the command runs through Git Bash or PowerShell.
  return { type: "command", command: `node "${dest.replace(/\\/g, "/")}"` };
}

// Updates the copy only when it already exists and differs; true if it wrote.
function refreshInstalled() {
  const dest = installedPath();
  if (dest === __filename || !existsSync(dest) || same(__filename, dest)) return false;
  try {
    copyFileSync(__filename, dest);
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (process.argv.includes("--install")) {
    process.stdout.write(JSON.stringify(install(), null, 2) + "\n");
    return;
  }
  let input = null;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  try {
    const reading = readingOf(input);
    if (reading) {
      // The previous reading is read before anything is written; the history
      // goes first so that a failing session file does not lose it.
      let previous = null;
      try {
        previous = JSON.parse(readFileSync(join(readingsDir(), `${input.session_id}.json`), "utf8"));
      } catch {}
      if (typeof input.session_id === "string" && SESSION_ID.test(input.session_id)) {
        try {
          appendHistory(historyLines(reading, previous));
        } catch {}
      }
      writeReading(input.session_id, reading);
    }
  } catch {}
  process.stdout.write(formatLine(input) + "\n");
}

if (require.main === module) {
  try {
    main();
  } catch {}
  process.exitCode = 0;
}

module.exports = { dataDir, readingsDir, historyDir, historyLines, appendHistory, readHistory, readingOf, formatLine, writeReading, readReadings, install, refreshInstalled };
