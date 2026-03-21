#!/usr/bin/env bun
/**
 * relay-shoutout.ts
 * Records an X shoutout request from a fan and notifies the influencer via the_interns_bot.
 * The influencer replies APPROVE or DECLINE in the_interns_bot.
 *
 * Usage:
 *   bun run scripts/relay-shoutout.ts \
 *     --agent-id johndoe-intern \
 *     --fan-chat-id 987654321 \
 *     --fan-username fanhandle \
 *     --text "Shout out to my crypto journey!" \
 *     --handles "@alice @bob @carol" \
 *     --rt-url "https://x.com/someone/status/123" \
 *     --message-id abc123uuid \
 *     --paid-amount 100
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
    "text":        { type: "string" },
    "handles":     { type: "string" },
    "rt-url":      { type: "string" },
    "message-id":  { type: "string" },
    "paid-amount": { type: "string" },
  },
  strict: false,
});

const agentId    = values["agent-id"];
const fanChatId  = values["fan-chat-id"];
const fanUsername= values["fan-username"] ?? "unknown";
const text       = values["text"];
const handles    = values["handles"] ?? "";
const rtUrl      = values["rt-url"] ?? "";
const messageId  = values["message-id"] ?? crypto.randomUUID();
const paidAmount = Number(values["paid-amount"] ?? 0);

if (!agentId || !fanChatId || !text) {
  console.log(JSON.stringify({ ok: false, error: "Missing required flags" }));
  process.exit(1);
}

// Validate handles: max 3
const handleList = handles.split(/\s+/).filter(h => h.startsWith("@")).slice(0, 3);

// ── 1. Write shoutout record ──────────────────────────────────────────────────
const msgDir = join(ROOT, "messages", agentId);
mkdirSync(msgDir, { recursive: true });

const record = {
  messageId,
  type: "shoutout",
  agentId,
  fanChatId,
  fanUsername,
  shoutoutText: text,
  handles: handleList,
  rtUrl: rtUrl || null,
  paidAmount,
  status: "pending",
  createdAt: new Date().toISOString(),
};

writeFileSync(join(msgDir, `${messageId}.json`), JSON.stringify(record, null, 2));

// ── 2. Read influencer_chat_id ────────────────────────────────────────────────
const dataPath = join(ROOT, "influencers", agentId, "DATA.md");
let influencerChatId = "";
try {
  const data = readFileSync(dataPath, "utf8");
  const match = data.match(/influencer_chat_id:\s*(\d+)/);
  influencerChatId = match?.[1] ?? "";
} catch {}

if (!influencerChatId) {
  console.log(JSON.stringify({ ok: true, messageId, notified: false, note: "No influencer_chat_id set" }));
  process.exit(0);
}

// ── 3. Build formatted notification ──────────────────────────────────────────
const lines = [
  `📣 <b>X Shoutout Request</b> from @${fanUsername}`,
  ``,
  `<b>Message:</b> ${text}`,
  handleList.length ? `<b>Tag:</b> ${handleList.join(" ")}` : null,
  rtUrl ? `<b>RT:</b> ${rtUrl}` : null,
  `<b>Paid:</b> $${paidAmount}`,
  ``,
  `Reply <code>APPROVE</code> or <code>DECLINE [reason]</code>`,
  `[messageId:${messageId}]`,
].filter(Boolean).join("\n");

const result = spawnSync("bun", [
  "run", join(ROOT, "scripts", "send-telegram.ts"),
  "--token", INTERNS_BOT_TOKEN,
  "--chat-id", influencerChatId,
  "--text", lines,
], { encoding: "utf8" });

let sendResult: { ok: boolean; error?: string } = { ok: false };
try { sendResult = JSON.parse(result.stdout); } catch {}

if (!sendResult.ok) {
  console.log(JSON.stringify({ ok: false, error: `Notification failed: ${sendResult.error}` }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, messageId, notified: true }));
