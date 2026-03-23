/**
 * create-payment-session.ts
 *
 * Called by the fan-facing intern bot (via SOUL.md) to create an x402 payment
 * session and get back a paywall URL to send to the fan.
 *
 * Usage:
 *   bun run create-payment-session.ts \
 *     --handle 0xdeployer \
 *     --service dm \
 *     --fan-chat-id 123456789 \
 *     --message "Love your work!" \
 *     [--text "Shoutout text for X post"]
 *
 * Prints JSON to stdout:
 *   { "ref": "abc123", "paywall_url": "https://api.interns.bot/pay/...", "amount_usd": 5 }
 */

import path from "path";
import fs from "fs";

const INTERNS_DIR  = process.env.INTERNS_DIR ?? "/opt/interns";
const X402_BASE_URL = (process.env.X402_BASE_URL ?? "http://localhost:4402").replace(/\/$/, "");

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get  = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };

const handle          = get("--handle");
const service         = get("--service") as "dm" | "shoutout" | "meeting" | undefined;
const fanChatId       = get("--fan-chat-id");
const message         = get("--message");
const text            = get("--text");
const from            = get("--from");

if (!handle || !service || !["dm","shoutout","meeting"].includes(service)) {
  console.error(JSON.stringify({ error: "Required: --handle and --service (dm|shoutout|meeting)" }));
  process.exit(1);
}

// ── Read influencer Telegram credentials from DATA.md ─────────────────────────

const dataPath = path.join(INTERNS_DIR, "influencers", `${handle}-intern`, "DATA.md");
let botToken = "";
let influencerChatId = "";

if (fs.existsSync(dataPath)) {
  const data = fs.readFileSync(dataPath, "utf-8");
  const get  = (key: string) => data.match(new RegExp(`${key}:\\s*(.+)`))?.[1]?.trim() ?? "";
  botToken         = get("- bot_token")          || get("bot_token");
  influencerChatId = get("- influencer_chat_id") || get("influencer_chat_id");
}

// ── Build session payload ─────────────────────────────────────────────────────

const payload: Record<string, string> = {};
if (message)         payload.message         = message;
if (text)            payload.text            = text;
if (from)            payload.from            = from;
if (fanChatId)       payload.fanChatId       = fanChatId;
if (botToken)        payload.botToken        = botToken;
if (influencerChatId) payload.influencerChatId = influencerChatId;

// ── Create session ────────────────────────────────────────────────────────────

try {
  const res = await fetch(`${X402_BASE_URL}/sessions/${handle}/${service}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(JSON.stringify({ error: `Session creation failed (${res.status}): ${err}` }));
    process.exit(1);
  }

  const data = await res.json();
  console.log(JSON.stringify(data));
} catch (e: any) {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
}
