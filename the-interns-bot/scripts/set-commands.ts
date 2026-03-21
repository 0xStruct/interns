#!/usr/bin/env bun
/**
 * set-commands.ts
 * Registers the slash command menu for a Telegram bot via setMyCommands API.
 * Run once after bot registration (called from bootstrap.sh + provision-agent.ts).
 *
 * Usage:
 *   bun run set-commands.ts --token <BOT_TOKEN> --type management
 *   bun run set-commands.ts --token <BOT_TOKEN> --type fan --name "John Doe"
 *
 * --type management  → commands for @the_interns_bot (influencer management)
 * --type fan         → commands for a provisioned influencer bot (fan-facing)
 *
 * Output JSON: { ok: true } | { ok: false, error: "..." }
 */

import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    token: { type: "string" },
    type:  { type: "string", default: "management" },
    name:  { type: "string", default: "" },
  },
  strict: false,
});

const token = values["token"];
const type  = values["type"];
const name  = values["name"];

if (!token) {
  console.log(JSON.stringify({ ok: false, error: "Missing --token" }));
  process.exit(1);
}

// ── Command lists ─────────────────────────────────────────────────────────────

const MANAGEMENT_COMMANDS = [
  { command: "settings",    description: "View your current bot configuration" },
  { command: "setprice",    description: "Update service prices (VVIP DM, meeting, shoutout)" },
  { command: "setcal",      description: "Update your booking link (cal.com or Calendly)" },
  { command: "persona",     description: "Update your bot's voice and personality" },
  { command: "rescrape",    description: "Refresh voice training from your latest posts" },
  { command: "pause",       description: "Temporarily pause your intern bot" },
  { command: "resume",      description: "Re-enable your paused intern bot" },
  { command: "buyback",     description: "Buy back your token using earned fees" },
  { command: "launchtoken", description: "Launch a token on bankr.bot (one-time)" },
];

const FAN_COMMANDS = [
  { command: "start",    description: `What can ${name || "this bot"} do for you?` },
  { command: "vvip",     description: `Send a paid direct message to ${name || "the creator"}` },
  { command: "shoutout", description: `Request a paid X shoutout from ${name || "the creator"}` },
  { command: "meeting",  description: `Book a 1:1 call with ${name || "the creator"}` },
  { command: "qa",       description: "Ask a question (free Q&A)" },
];

const commands = type === "fan" ? FAN_COMMANDS : MANAGEMENT_COMMANDS;

// ── Call setMyCommands ────────────────────────────────────────────────────────

const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ commands }),
});

const data = await res.json() as { ok: boolean; description?: string };

if (!data.ok) {
  console.log(JSON.stringify({ ok: false, error: data.description ?? "setMyCommands failed" }));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  type,
  commandCount: commands.length,
  commands: commands.map(c => `/${c.command}`),
}));
