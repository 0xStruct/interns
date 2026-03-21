#!/usr/bin/env bun
/**
 * reply-dm.ts
 * Sends the influencer's reply back to the fan via the intern bot.
 * Called by the_interns_bot SKILL.md when the influencer replies to a VVIP DM notification.
 *
 * Usage:
 *   bun run scripts/reply-dm.ts \
 *     --message-id abc123uuid \
 *     --reply-text "Here's my advice: ..."
 *
 * Output JSON: { ok: true } | { ok: false, error }
 */

import { parseArgs } from "util";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "message-id":  { type: "string" },
    "reply-text":  { type: "string" },
  },
  strict: false,
});

const messageId = values["message-id"];
const replyText = values["reply-text"];

if (!messageId || !replyText) {
  console.log(JSON.stringify({ ok: false, error: "Missing --message-id or --reply-text" }));
  process.exit(1);
}

// ── 1. Find the message record (scan all agent dirs) ─────────────────────────
let record: {
  messageId: string; agentId: string; fanChatId: string;
  fanUsername?: string; status: string;
} | null = null;
let recordPath = "";

const messagesRoot = join(ROOT, "messages");
if (existsSync(messagesRoot)) {
  const { readdirSync } = await import("fs");
  for (const agentId of readdirSync(messagesRoot)) {
    const candidate = join(messagesRoot, agentId, `${messageId}.json`);
    if (existsSync(candidate)) {
      try {
        record = JSON.parse(readFileSync(candidate, "utf8"));
        recordPath = candidate;
      } catch {}
      break;
    }
  }
}

if (!record) {
  console.log(JSON.stringify({ ok: false, error: `Message ${messageId} not found` }));
  process.exit(1);
}

// ── 2. Read intern bot token from DATA.md ────────────────────────────────────
const dataPath = join(ROOT, "influencers", record.agentId, "DATA.md");
let botToken = "";
try {
  const data = readFileSync(dataPath, "utf8");
  const match = data.match(/bot_token:\s*(\S+)/);
  botToken = match?.[1] ?? "";
} catch {}

if (!botToken) {
  console.log(JSON.stringify({ ok: false, error: `No bot_token found for ${record.agentId}` }));
  process.exit(1);
}

// ── 3. Send reply to fan ──────────────────────────────────────────────────────
const result = spawnSync("bun", [
  "run", join(ROOT, "scripts", "send-telegram.ts"),
  "--token", botToken,
  "--chat-id", record.fanChatId,
  "--text", replyText,
], { encoding: "utf8" });

let sendResult: { ok: boolean; error?: string } = { ok: false };
try { sendResult = JSON.parse(result.stdout); } catch {}

if (!sendResult.ok) {
  console.log(JSON.stringify({ ok: false, error: `Send failed: ${sendResult.error}` }));
  process.exit(1);
}

// ── 4. Update record status ───────────────────────────────────────────────────
const updated = { ...record, status: "replied", repliedAt: new Date().toISOString(), replyText };
writeFileSync(recordPath, JSON.stringify(updated, null, 2));

console.log(JSON.stringify({ ok: true, messageId, fanChatId: record.fanChatId }));
