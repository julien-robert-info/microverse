---
name: doctor
description: Checks what the plugin needs on this machine (Node.js, Claude Code and Git versions, orchestration profile and its approval, hooks, quota counters) and says what to do about each problem, without a model request.
disable-model-invocation: true
allowed-tools: Bash(orch-doctor *)
---

The hook that prints this report did not answer. Run `orch-doctor --mode '${user_config.quota_mode}'` with the Bash tool. Show its output unchanged in a code block, adding nothing.
