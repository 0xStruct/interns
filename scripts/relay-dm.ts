#!/usr/bin/env bun
/**
 * relay-dm.ts
 * Records a fan's paid VVIP DM and notifies the influencer via the_interns_bot.
 *
 * Usage:
 *   bun run scripts/relay-dm.ts \
 *     --agent-id johndoe-intern \
 *     --fan-chat-id 987654321 \
 *     --fan-username fanhandle \
 *     --message "What's your advice on building in public?" \
 *     --message-id abc123uuid \
 *     --paid-amount 50
 *
 * Output JSON: { ok: true, messageId } | { ok: false, error }
 */

import { parseArgs } from "util";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const INTERNS_BOT_TOKEN = process.env.THE_INTERNS_BOT_TOKEN ?? "";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "agent-id":    { type: "string" },
    "fan-chat-id": { type: "string" },
    "fan-username":{ type: "string" },
    "message":     { type: "string" },
    "message-id":  { type: "string" },
    "paid-amount": { type: "string" },
  },
  strict: false,
});

const agentId    = values["agent-id"];
const fanChatId  = values["fan-chat-id"];
const fanUsername= values["fan-username"] ?? "unknown";
const message    = values["message"];
const messageId  = values["message-id"] ?? crypto.randomUUID();
const paidAmount = Number(values["paid-amount"] ?? 0);

if (!agentId || !fanChatId || !message) {
  console.log(JSON.stringify({ ok: false, error: "Missing required flags" }));
  process.exit(1);
}

// ── 1. Write message record ──────────────────────────────────────────────────
const msgDir = join(ROOT, "messages", agentId);
mkdirSync(msgDir, { recursive: true });

const record = {
  messageId,
  type: "vvip_dm",
  agentId,
  fanChatId,
  fanUsername,
  message,
  paidAmount,
  status: "pending",
  createdAt: new Date().toISOString(),
};

writeFileSync(join(msgDir, `${messageId}.json`), JSON.stringify(record, null, 2));

// ── 2. Read influencer_chat_id from DATA.md ──────────────────────────────────
const dataPath = join(ROOT, "influencers", agentId, "DATA.md");
let influencerChatId = "";
try {
  const data = readFileSync(dataPath, "utf8");
  const match = data.match(/influencer_chat_id:\s*(\d+)/);
  influencerChatId = match?.[1] ?? "";
} catch {
  console.log(JSON.stringify({ ok: false, error: `Could not read DATA.md for ${agentId}` }));
  process.exit(1);
}

if (!influencerChatId) {
  // No notification chat configured — still saved, just no notification
  console.log(JSON.stringify({ ok: true, messageId, notified: false, note: "No influencer_chat_id set" }));
  process.exit(0);
}

// ── 3. Notify influencer via the_interns_bot ─────────────────────────────────
const text = `💬 <b>VVIP DM</b> from @${fanUsername}:\n\n${message}\n\n<i>Paid: $${paidAmount} · Reply to respond</i>\n[messageId:${messageId}]`;

const result = spawnSync("bun", [
  "run", join(ROOT, "scripts", "send-telegram.ts"),
  "--token", INTERNS_BOT_TOKEN,
  "--chat-id", influencerChatId,
  "--text", text,
], { encoding: "utf8" });

let sendResult: { ok: boolean; error?: string } = { ok: false };
try { sendResult = JSON.parse(result.stdout); } catch {}

if (!sendResult.ok) {
  console.log(JSON.stringify({ ok: false, error: `Notification failed: ${sendResult.error}` }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, messageId, notified: true }));
