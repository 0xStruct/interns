#!/usr/bin/env bun
/**
 * resume-agent.ts
 * Resumes a paused influencer intern bot by re-binding its Telegram channel.
 * Uses: openclaw agents bind --agent <id> --bind telegram:<accountId>
 *
 * The accountId is the same as agentId (set at provision time via --account flag).
 * Re-binding restores the routing so Telegram messages reach the agent again.
 *
 * Usage:
 *   bun run the-interns-bot/scripts/resume-agent.ts --agent-id johndoe-intern
 *
 * Output JSON: { ok: true } | { ok: false, error }
 */

import { parseArgs } from "util";
import { spawnSync } from "child_process";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { "agent-id": { type: "string" } },
  strict: false,
});

const agentId = values["agent-id"];
if (!agentId) {
  console.log(JSON.stringify({ ok: false, error: "Missing --agent-id" }));
  process.exit(1);
}

// accountId was set to agentId at provision time (channels add --account <agentId>)
const bind = spawnSync("openclaw", [
  "agents", "bind",
  "--agent", agentId,
  "--bind",  `telegram:${agentId}`,
  "--json",
], { encoding: "utf8" });

if (bind.status !== 0) {
  console.log(JSON.stringify({ ok: false, error: `openclaw agents bind failed: ${bind.stderr}` }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, agentId, status: "active" }));
