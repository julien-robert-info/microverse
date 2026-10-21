// PreToolUse hook (matcher Agent|Task): keeps the agent/model combinations of
// the orchestration skill ("Roles and models") enforced. A launch of a
// `microverse:` agent with no model, or a model its role does not allow, is
// denied with the list of allowed models.
//
// It runs on every Agent call of every project where the plugin is enabled:
// anything it does not recognise (other agent types, unreadable input) passes
// silently, and no error can turn into a block.
"use strict";

const { readFileSync } = require("node:fs");

const ALLOWED = {
  rick: ["opus", "sonnet"],
  morty: ["sonnet"],
  council: ["opus"],
  meeseeks: ["haiku", "sonnet"],
};

function main() {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  if (payload.tool_name !== "Agent" && payload.tool_name !== "Task") return;
  const input = payload.tool_input;
  const type = input && input.subagent_type;
  if (typeof type !== "string" || !type.startsWith("microverse:")) return;

  const role = type.slice("microverse:".length);
  const allowed = Object.hasOwn(ALLOWED, role) ? ALLOWED[role] : null;
  if (!allowed) return;

  const model = typeof input.model === "string" ? input.model.trim().toLowerCase() : "";
  if (allowed.includes(model)) return;

  const given = model ? `model "${input.model}"` : "no model";
  const reason = `${type} was launched with ${given}. Allowed models for ${type}: ${allowed.join(", ")}. Pass \`model\` explicitly (see "Roles and models" in the orchestration skill).`;
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
