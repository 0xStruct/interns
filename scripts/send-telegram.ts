#!/usr/bin/env bun
/**
 * send-telegram.ts
 * Low-level helper: send a Telegram message to any chatId via any bot token.
 *
 * Usage:
 *   bun run scripts/send-telegram.ts --token <BOT_TOKEN> --chat-id <chatId> --text "hello"
 *
 * Output JSON: { ok: true } | { ok: false, error: string }
 */

import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    token:    { type: "string" },
    "chat-id": { type: "string" },
    text:     { type: "string" },
  },
  strict: false,
});

const token  = values["token"]   ?? process.env.BOT_TOKEN;
const chatId = values["chat-id"] ?? process.env.CHAT_ID;
const text   = values["text"]    ?? process.env.MESSAGE_TEXT;

if (!token || !chatId || !text) {
  console.log(JSON.stringify({ ok: false, error: "Missing --token, --chat-id, or --text" }));
  process.exit(1);
}

async function sendMessage() {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });

  const data = await res.json() as { ok: boolean; description?: string };
  if (!data.ok) {
    console.log(JSON.stringify({ ok: false, error: data.description ?? "Telegram API error" }));
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true }));
}

sendMessage().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});
