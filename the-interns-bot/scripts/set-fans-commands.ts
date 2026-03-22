#!/usr/bin/env bun
/**
 * set-fans-commands.ts
 * Registers slash command menus for fan-facing influencer bots.
 * Reads bot token, name, handle, and owner chat ID from each influencer's
 * DATA.md and PERSONA.md. Processes all influencers by default, or one
 * specific bot with --agent-id.
 *
 * Usage:
 *   bun run set-fans-commands.ts                           # update all fan bots
 *   bun run set-fans-commands.ts --agent-id johndoe-intern # update one bot
 *
 * Output JSON: { ok: true, results: [...] } | { ok: false, error }
 */

import { parseArgs } from "util";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "agent-id": { type: "string" },
  },
  strict: false,
});

const targetAgentId = values["agent-id"];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract a markdown list field value: "- key: value" → "value" */
function parseField(content: string, field: string): string {
  const match = content.match(new RegExp(`^- ${field}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

/** Call Telegram setMyCommands, optionally with a scope */
async function setCommands(
  token: string,
  cmds: { command: string; description: string }[],
  scope?: { type: string; chat_id?: number },
): Promise<{ ok: boolean; description?: string }> {
  const body: Record<string, unknown> = { commands: cmds };
  if (scope) body.scope = scope;
  const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; description?: string };
}

// ── Command lists ─────────────────────────────────────────────────────────────

function fanCommands(displayName: string) {
  return [
    { command: "start",    description: `What can ${displayName || "this bot"} do for you?` },
    { command: "dm",       description: `Send a paid direct message to ${displayName || "the creator"}` },
    { command: "shoutout", description: `Request a paid X shoutout from ${displayName || "the creator"}` },
    { command: "meeting",  description: `Book a paid 1:1 call with ${displayName || "the creator"}` },
    { command: "qa",       description: `Ask a free question, answered in ${displayName || "the creator"}'s voice by AI` },
  ];
}

const OWNER_COMMAND = {
  command: "owner",
  description: "[Owner] Bot overview, fan engagement & manage via @the_interns_bot",
};

// ── Process one agent ─────────────────────────────────────────────────────────

type AgentResult = { agentId: string; ok: boolean; error?: string; ownerCommandSet?: boolean };

async function processAgent(agentId: string): Promise<AgentResult> {
  const agentDir   = join(ROOT, "influencers", agentId);
  const dataPath   = join(agentDir, "DATA.md");
  const personaPath = join(agentDir, "PERSONA.md");

  if (!existsSync(dataPath) || !existsSync(personaPath)) {
    return { agentId, ok: false, error: "Missing DATA.md or PERSONA.md" };
  }

  const dataContent    = readFileSync(dataPath, "utf8");
  const personaContent = readFileSync(personaPath, "utf8");

  const botToken    = parseField(dataContent, "bot_token");
  const ownerChatId = parseField(dataContent, "influencer_chat_id");

  if (!botToken || botToken === "") {
    return { agentId, ok: false, error: "No bot_token in DATA.md" };
  }

  // Full name is stored as "Name (handle)" — split into parts for displayName
  const fullName       = parseField(personaContent, "Full name");
  const nameMatch      = fullName.match(/^(.+?)\s+\(([^)]+)\)$/);
  const rawName        = nameMatch?.[1]?.trim() ?? fullName;
  const handleFromName = nameMatch?.[2]?.trim() ?? "";

  // Also try X profile line as fallback for handle
  const xProfile = parseField(personaContent, "X profile");
  const handle   = handleFromName || xProfile.replace(/^x\.com\//, "");

  const displayName = handle ? `${rawName} (${handle})` : rawName;
  const cmds        = fanCommands(displayName);

  // Set default fan commands (visible to all users)
  const defaultResult = await setCommands(botToken, cmds);
  if (!defaultResult.ok) {
    return { agentId, ok: false, error: defaultResult.description ?? "setMyCommands failed" };
  }

  // Set owner-scoped commands (visible only to the influencer)
  let ownerCommandSet = false;
  const chatIdNum = ownerChatId && ownerChatId !== "" && ownerChatId !== "skip"
    ? Number(ownerChatId) : NaN;

  if (!isNaN(chatIdNum)) {
    const ownerResult = await setCommands(
      botToken,
      [OWNER_COMMAND, ...cmds],
      { type: "chat", chat_id: chatIdNum },
    );
    ownerCommandSet = ownerResult.ok;
  }

  return { agentId, ok: true, ownerCommandSet };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const influencersDir = join(ROOT, "influencers");

let agentIds: string[];
if (targetAgentId) {
  agentIds = [targetAgentId];
} else {
  if (!existsSync(influencersDir)) {
    console.log(JSON.stringify({ ok: true, results: [], note: "No influencers directory found" }));
    process.exit(0);
  }
  agentIds = readdirSync(influencersDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(influencersDir, d.name, "DATA.md")))
    .map(d => d.name);
}

if (agentIds.length === 0) {
  console.log(JSON.stringify({ ok: true, results: [], note: "No fan bots found" }));
  process.exit(0);
}

const results = await Promise.all(agentIds.map(processAgent));
const allOk   = results.every(r => r.ok);

console.log(JSON.stringify({ ok: allOk, results }));
if (!allOk) process.exit(1);
