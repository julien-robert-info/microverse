// PreToolUse hook (matcher PowerShell): denies a PowerShell command that runs
// one of the plugin's `bin/` scripts by name. They are extensionless Node
// scripts: on Windows, PowerShell and cmd.exe hand them to the shell, which
// opens an "Open with" dialog instead of running them. Bash resolves them
// through the shebang.
//
// Anything it does not recognise (other tools, unreadable input) passes
// silently, and no error can turn into a block.
"use strict";

const { readFileSync } = require("node:fs");

// A script name in command position: start of the command, after `; & | ( {`
// or a newline, optionally behind `&` (call operator), quotes or a path.
const INVOCATION =
  /(?:^|[;&|({\n])\s*["']?(?:[^\s;&|"']*[\\/])?(orch-(?:report|speak|status|quota|trust|usage)|agent-check|agent-cleanup)(?![\w.-])/;

function main() {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  if (payload.tool_name !== "PowerShell") return;
  const command = payload.tool_input && payload.tool_input.command;
  if (typeof command !== "string") return;
  const found = INVOCATION.exec(command);
  if (!found) return;

  const reason = `\`${found[1]}\` is an extensionless Node script: PowerShell cannot run it and Windows opens an "Open with" dialog. Run it from the Bash tool, or as \`node "<plugin dir>/bin/${found[1]}" <args>\`.`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }),
  );
}

try {
  main();
} catch {}
// Not process.exit: on a pipe stdout is flushed asynchronously and exit cuts it.
process.exitCode = 0;
