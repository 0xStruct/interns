#!/usr/bin/env bun
/**
 * pause-agent.ts
 * Disables an influencer's intern bot (openclaw agents disable + reload).
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

const disable = spawnSync("openclaw", ["agents", "disable", "--id", agentId], { encoding: "utf8" });
if (disable.status !== 0) {
  console.log(JSON.stringify({ ok: false, error: `openclaw agents disable failed: ${disable.stderr}` }));
  process.exit(1);
}

const reload = spawnSync("openclaw", ["reload"], { encoding: "utf8" });
if (reload.status !== 0) {
  console.log(JSON.stringify({ ok: false, error: `openclaw reload failed: ${reload.stderr}` }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, agentId, status: "paused" }));
