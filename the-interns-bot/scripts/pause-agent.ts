#!/usr/bin/env bun
/**
 * pause-agent.ts
 * Pauses an influencer's intern bot by unbinding its Telegram channel.
 * Uses: openclaw agents unbind --agent <id> --bind telegram:<accountId>
 *
 * The accountId is the same as agentId (set at provision time via --account flag).
 * Unbinding removes the routing so Telegram messages no longer reach the agent.
 * The agent workspace and data files are untouched — resume restores it instantly.
 *
 * Usage:
 *   bun run the-interns-bot/scripts/pause-agent.ts --agent-id johndoe-intern
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
const unbind = spawnSync("openclaw", [
  "agents", "unbind",
  "--agent", agentId,
  "--bind",  `telegram:${agentId}`,
], { encoding: "utf8" });

if (unbind.status !== 0) {
  console.log(JSON.stringify({ ok: false, error: `openclaw agents unbind failed: ${unbind.stderr}` }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, agentId, status: "paused" }));
