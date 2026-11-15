// SubagentStop hook: records each stop of an agent under the `trace_dir`
// option (docs/traces.md): the branch, head and commits of its worktree, with
// the base taken from the matching launch record. Same guarantees as
// trace-launch.js: silent, exit code 0, read-only git.
//
// A stopped agent can stop again after a SendMessage: one record per arrival.
"use strict";

const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const t = require("./trace-lib.js");

// The sub-agent's meta sits beside its transcript; without the transcript path
// it is where Claude Code keeps sub-agents of the session.
function metaFile(p) {
  if (typeof p.agent_transcript_path === "string" && p.agent_transcript_path.endsWith(".jsonl")) {
    return p.agent_transcript_path.replace(/\.jsonl$/, ".meta.json");
  }
  if (typeof p.transcript_path === "string" && p.session_id && p.agent_id) {
    const sep = p.transcript_path.includes("\\") ? "\\" : "/";
    const parts = p.transcript_path.split(/[\\/]/);
    parts.pop();
    return [...parts, p.session_id, "subagents", `agent-${p.agent_id}.meta.json`].join(sep);
  }
  return null;
}

// repo.head of the launch of the same tool call, in the folder of this session.
function launchBase(out, toolUseId) {
  if (!toolUseId) return null;
  try {
    const suffix = `-${t.safeSegment(toolUseId)}.json`;
    for (const name of readdirSync(out)) {
      if (!name.startsWith("launch-") || !name.endsWith(suffix)) continue;
      const head = t.readJson(join(out, name))?.repo?.head;
      if (typeof head === "string" && head) return head;
    }
  } catch {}
  return null;
}

function main(dir) {
  const p = t.readPayload();
  const agentId = typeof p.agent_id === "string" && p.agent_id ? p.agent_id : null;
  const meta = metaFile(p);
  const m = meta ? t.readJson(meta) : null;
  const toolUseId = typeof m?.toolUseId === "string" && m.toolUseId ? m.toolUseId : null;
  const now = new Date();
  const out = t.sessionDir(dir, p);

  const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  const wt = agentId
    ? [projectDir, cwd].map((d) => join(d, ".claude", "worktrees", `agent-${agentId}`)).find((d) => existsSync(d))
    : undefined;

  let rec = { worktree: null, branch: null, base: null, head: null, commits: null, dirty: null };
  if (wt) {
    const head = t.gitLine(wt, "rev-parse", "HEAD");
    const base = launchBase(out, toolUseId) ?? t.gitLine(wt, "merge-base", "HEAD", "main");
    const list = base && head ? t.git(wt, "rev-list", `${base}..HEAD`) : null;
    rec = {
      worktree: wt,
      branch: t.gitLine(wt, "rev-parse", "--abbrev-ref", "HEAD"),
      base,
      head,
      commits: list == null ? null : list.split(/\r?\n/).filter(Boolean),
      dirty: t.dirty(wt),
    };
  }

  const record = { v: 1, kind: "stop", at: now.toISOString(), session: p.session_id ?? null, agentId, toolUseId, ...rec };
  t.writeAtomic(join(out, `stop-${t.stamp(now)}-${t.safeSegment(agentId ?? t.hex8())}.json`), JSON.stringify(record, null, 2) + "\n");
}

t.runHook("trace-stop", main);
