#!/usr/bin/env bun
/**
 * set-admins-commands.ts
 * Registers the slash command menu for @the_interns_bot (management bot).
 * Reads token from THE_INTERNS_BOT_TOKEN env var or --token flag.
 *
 * Usage:
 *   bun run set-admins-commands.ts
 *   bun run set-admins-commands.ts --token 123456:ABC...
 *
 * Output JSON: { ok: true, commandCount, commands } | { ok: false, error }
 */

import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    token: { type: "string" },
  },
  strict: false,
});

const token = values["token"] ?? process.env.THE_INTERNS_BOT_TOKEN;

if (!token) {
  console.log(JSON.stringify({ ok: false, error: "Missing --token or THE_INTERNS_BOT_TOKEN env var" }));
  process.exit(1);
}

const MANAGEMENT_COMMANDS = [
  { command: "settings",    description: "View your current bot configuration" },
  { command: "setprice",    description: "Update service prices (DM, meeting, shoutout)" },
  { command: "setcal",      description: "Update your booking link (cal.com or Calendly)" },
  { command: "persona",     description: "Update your bot's voice and personality" },
  { command: "rescrape",    description: "Refresh voice training from your latest posts" },
  { command: "pause",       description: "Temporarily pause your intern bot" },
  { command: "resume",      description: "Re-enable your paused intern bot" },
  { command: "buyback",     description: "Buy back your token using earned fees" },
  { command: "launchtoken", description: "Launch a token on bankr.bot (one-time)" },
];

const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ commands: MANAGEMENT_COMMANDS }),
});

const result = await res.json() as { ok: boolean; description?: string };

if (!result.ok) {
  console.log(JSON.stringify({ ok: false, error: result.description ?? "setMyCommands failed" }));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  commandCount: MANAGEMENT_COMMANDS.length,
  commands: MANAGEMENT_COMMANDS.map(c => `/${c.command}`),
}));
