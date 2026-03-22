#!/usr/bin/env bun
/**
 * set-commands.ts
 * Registers the slash command menu for a Telegram bot via setMyCommands API.
 * Run once after bot registration (called from bootstrap.sh + provision-agent.ts).
 *
 * Usage:
 *   bun run set-commands.ts --token <BOT_TOKEN> --type management
 *   bun run set-commands.ts --token <BOT_TOKEN> --type fan --name "John Doe"
 *   bun run set-commands.ts --token <BOT_TOKEN> --type fan --name "John Doe" --owner-chat-id 123456789
 *
 * --type management    → commands for @the_interns_bot (influencer management)
 * --type fan           → commands for a provisioned influencer bot (fan-facing)
 * --owner-chat-id      → if provided, sets owner-only /owner command scoped to this chat
 *
 * Output JSON: { ok: true } | { ok: false, error: "..." }
 */

import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    token:           { type: "string" },
    type:            { type: "string", default: "management" },
    name:            { type: "string", default: "" },
    "owner-chat-id": { type: "string", default: "" },
  },
  strict: false,
});

const token       = values["token"];
const type        = values["type"];
const name        = values["name"];
const ownerChatId = values["owner-chat-id"];

if (!token) {
  console.log(JSON.stringify({ ok: false, error: "Missing --token" }));
  process.exit(1);
}

// ── Command lists ─────────────────────────────────────────────────────────────

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

const FAN_COMMANDS = [
  { command: "start",    description: `What can ${name || "this bot"} do for you?` },
  { command: "dm",       description: `Send a paid direct message to ${name || "the creator"}` },
  { command: "shoutout", description: `Request a paid X shoutout from ${name || "the creator"}` },
  { command: "meeting",  description: `Book a 1:1 call with ${name || "the creator"}` },
  { command: "qa",       description: "Ask a question (free Q&A)" },
];

// Owner sees fan commands + /owner
const OWNER_COMMANDS_ON_FAN_BOT = [
  ...FAN_COMMANDS,
  { command: "owner", description: "[Owner] Bot overview, fan engagement & manage via @the_interns_bot" },
];

const commands = type === "fan" ? FAN_COMMANDS : MANAGEMENT_COMMANDS;

// ── Helper: call setMyCommands with optional scope ──────────────────────────

async function setCommands(
  cmds: { command: string; description: string }[],
  scope?: { type: string; chat_id?: number },
) {
  const body: Record<string, unknown> = { commands: cmds };
  if (scope) body.scope = scope;

  const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; description?: string };
}

// ── Set default commands (for all users) ────────────────────────────────────

const defaultResult = await setCommands(commands);
if (!defaultResult.ok) {
  console.log(JSON.stringify({ ok: false, error: defaultResult.description ?? "setMyCommands failed" }));
  process.exit(1);
}

// ── Set owner-scoped commands (if owner chat ID provided) ───────────────────

let ownerResult = null;
if (type === "fan" && ownerChatId) {
  ownerResult = await setCommands(
    OWNER_COMMANDS_ON_FAN_BOT,
    { type: "chat", chat_id: Number(ownerChatId) },
  );
}

console.log(JSON.stringify({
  ok: true,
  type,
  commandCount: commands.length,
  commands: commands.map(c => `/${c.command}`),
  ownerCommands: ownerResult?.ok
    ? OWNER_COMMANDS_ON_FAN_BOT.map(c => `/${c.command}`)
    : null,
}));
