// PreToolUse hook (matcher Agent|Task): records each agent launch under the
// `trace_dir` option (docs/traces.md), at no token cost: the exact base of the
// repository, the brief, the notes it cites as they are at launch, and the
// configuration in force. Placed after the guards, so a launch they refuse is
// still recorded; the analysis counts it as an orphan.
//
// Silent and harmless by construction: no output, exit code 0, and only the
// trace folder is written. Settings are read for the name of each hook's
// program alone, never its arguments or environment.
"use strict";

const { copyFileSync, mkdirSync, realpathSync, renameSync, statSync }= require("node:fs");
const { homedir } = require("node:os");
const { basename, dirname, isAbsolute, join, relative, resolve } = require("node:path");
const t = require("./trace-lib.js");

const NOTES_MAX = 2 * 1024 * 1024;

// First word of a hook command that names a program: leading VAR=value words
// are skipped; for node, the script it runs. Arguments are never kept.
function programOf(h) {
  if (!h || typeof h.command !== "string") return null;
  const words = (h.command.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
  const rest = Array.isArray(h.args) ? words.concat(h.args.map(String)) : words;
  let i = 0;
  while (i < rest.length && /^[A-Za-z_]\w*=/.test(rest[i])) i++;
  if (i >= rest.length) return null;
  const name = (w) => basename(w.replace(/\\/g, "/")).replace(/\.(exe|cmd|bat)$/i, "");
  const prog = name(rest[i]);
  if (prog.toLowerCase() !== "node") return prog;
  const script = rest.slice(i + 1).find((w) => !w.startsWith("-"));
  return script ? basename(script.replace(/\\/g, "/")) : prog;
}

function hooksOf(file) {
  const hooks = t.readJson(file)?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        out.push({ event, matcher: typeof g.matcher === "string" ? g.matcher : null, program: programOf(h) });
      }
    }
  }
  return out;
}

function config(projectDir) {
  const root = process.env.CLAUDE_PLUGIN_ROOT || resolve(__dirname, "..");
  const manifest = t.readJson(join(root, ".claude-plugin", "plugin.json")) ?? {};
  const rtk = t.call("rtk", ["--version"]);
  const userSettings = join(homedir(), ".claude", "settings.json");
  const projectSettings = join(projectDir, ".claude", "settings.json");
  const localSettings = join(projectDir, ".claude", "settings.local.json");
  return {
    plugin: { name: manifest.name ?? null, version: manifest.version ?? null, commit: t.gitLine(root, "rev-parse", "HEAD") },
    rtk: { version: rtk ? rtk.split(/\r?\n/)[0].trim() || null : null },
    hooks: [userSettings, projectSettings, localSettings].flatMap(hooksOf),
    userSettingsSha: t.fileSha(userSettings),
    projectSettingsSha: t.fileSha(projectSettings),
    profileSha: t.fileSha(join(projectDir, ".claude", "orchestration", "profile.json")),
  };
}

// Notes the brief cites, copied once each. A path that climbs with ".." is
// refused even when it lands back inside the repository: the brief names notes,
// not arbitrary files.
function copyNotes(brief, top, outDir) {
  const rels = [...new Set(brief.match(/notes\/[\w./-]+\.md/g) ?? [])];
  let total = 0;
  return rels.map((rel) => {
    const entry = (copied, reason, sha) => ({ rel, sha256: sha, copied, reason });
    const src = resolve(top, rel);
    if (rel.split("/").includes("..") || isAbsolute(relative(top, src)) || relative(top, src).startsWith("..")) {
      return entry(false, "outside", null);
    }
    let size;
    try {
      // Symlinks are followed, so one that leaves the repository counts as outside.
      const real = realpathSync(src);
      const rr = relative(realpathSync(top), real);
      if (rr.startsWith("..") || isAbsolute(rr)) return entry(false, "outside", null);
      size = statSync(real).size;
    } catch {
      return entry(false, "absent", null);
    }
    if (total + size > NOTES_MAX) return entry(false, "too-big", null);
    total += size;
    const sha = t.fileSha(src);
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, `${dest}.tmp`);
    renameSync(`${dest}.tmp`, dest);
    return entry(true, null, sha);
  });
}

function main(dir) {
  const p = t.readPayload();
  if (p.tool_name !== "Agent" && p.tool_name !== "Task") return;
  const input = p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {};
  const toolUseId = typeof p.tool_use_id === "string" && p.tool_use_id ? p.tool_use_id : null;
  const id = t.safeSegment(toolUseId ?? t.hex8());
  const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  const now = new Date();
  const out = t.sessionDir(dir, p);

  // One git call for the three values (a spawn costs more than the answer);
  // a repository with no commit yet answers the root alone.
  const [headTop, headSha, headBranch] = (t.git(cwd, "rev-parse", "--show-toplevel", "HEAD", "--abbrev-ref", "HEAD") ?? "").split(/\r?\n/);
  const top = headTop || t.gitLine(cwd, "rev-parse", "--show-toplevel");
  const repo = {
    top,
    branch: headBranch || null,
    head: headSha || null,
    dirty: top ? t.dirty(cwd) : null,
  };

  const prompt = typeof input.prompt === "string" ? input.prompt : null;
  let brief = { file: null, sha256: null, chars: null };
  let notes = [];
  if (prompt !== null) {
    brief = { file: `brief/${id}.md`, sha256: t.sha256(prompt), chars: prompt.length };
    t.writeAtomic(join(out, brief.file), prompt);
    notes = copyNotes(prompt, top ?? cwd, join(out, "notes", id));
  }

  const record = {
    v: 1,
    kind: "launch",
    at: now.toISOString(),
    session: p.session_id ?? null,
    toolUseId,
    cwd: p.cwd ?? null,
    repo,
    agent: {
      type: input.subagent_type ?? null,
      model: input.model ?? null,
      background: typeof input.run_in_background === "boolean" ? input.run_in_background : null,
      description: input.description ?? null,
    },
    brief,
    notes,
    config: config(projectDir),
  };
  t.writeAtomic(join(out, `launch-${t.stamp(now)}-${id}.json`), JSON.stringify(record, null, 2) + "\n");
}

t.runHook("trace-launch", main);
