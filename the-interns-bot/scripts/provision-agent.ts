#!/usr/bin/env bun
/**
 * provision-agent.ts
 * Creates all skill files for a new influencer and registers them in OpenClaw.
 *
 * Usage:
 *   bun run the-interns-bot/scripts/provision-agent.ts \
 *     --agent-id johndoe-intern \
 *     --state-file /path/to/state.json
 *
 * Output JSON: { ok: true, agentId, botUsername } | { ok: false, error }
 */

import { parseArgs } from "util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "agent-id":   { type: "string" },
    "state-file": { type: "string" },
  },
  strict: false,
});

const agentId   = values["agent-id"];
const stateFile = values["state-file"];

if (!agentId || !stateFile) {
  console.log(JSON.stringify({ ok: false, error: "Missing --agent-id or --state-file" }));
  process.exit(1);
}

if (!existsSync(stateFile)) {
  console.log(JSON.stringify({ ok: false, error: `State file not found: ${stateFile}` }));
  process.exit(1);
}

const state = JSON.parse(readFileSync(stateFile, "utf8"));
const c = state.collected ?? {};

const agentDir = join(ROOT, "influencers", agentId);
mkdirSync(agentDir, { recursive: true });

// ── 1. PERSONA.md ─────────────────────────────────────────────────────────────
writeFileSync(join(agentDir, "PERSONA.md"), `# ${c.name} — Persona

## Identity
- Full name: ${c.name}
- X handle: ${c.handle}
- Bio: ${c.bio ?? "Not provided"}

## Topics
${(c.topics ?? "").split(",").map((t: string) => `- ${t.trim()}`).join("\n")}

## Voice & Tone
${c.voice ?? "Professional, direct, and helpful. Speaks with authority on their topics."}

## Off-Limits Topics
- Do not discuss topics outside the expertise areas above
- Do not provide legal, medical, or financial advice

## Sample Responses
*No manual samples yet — scraping will enrich this section.*

---
*Last updated: ${new Date().toISOString()}*
`);

// ── 2. PRICING.md ─────────────────────────────────────────────────────────────
writeFileSync(join(agentDir, "PRICING.md"), `# ${c.name} — Pricing

## VVIP DM
- price_usd: ${c.vvip_dm_price ?? 50}
- turnaround: 48 hours
- description: A direct, personal reply from ${c.name} to your question.

## 1:1 Meeting
- price_usd: ${c.meeting_price ?? 200}
- duration_min: 30
- description: A one-on-one call with ${c.name}.

## X Shoutout
- price_usd: ${c.shoutout_price && c.shoutout_price !== "skip" ? c.shoutout_price : "disabled"}
- description: ${c.name} will post a custom shoutout mentioning your handles on X.
- enabled: ${c.shoutout_price && c.shoutout_price !== "skip" ? "true" : "false"}
`);

// ── 3. DATA.md ────────────────────────────────────────────────────────────────
const calProvider = (c.calendar_link ?? "").includes("calendly.com") ? "Calendly" : "cal.com";
writeFileSync(join(agentDir, "DATA.md"), `# ${c.name} — Operational Data

## Payment
- bankr_wallet: ${c.bankr_wallet ?? ""}
- platform_wallet: ${process.env.PLATFORM_WALLET ?? ""}
- bot_token: ${c.bot_token ?? ""}

## Calendar
- provider: ${calProvider}
- booking_link: ${c.calendar_link ?? ""}

## Notifications
- influencer_chat_id: ${c.influencer_chat_id ?? ""}
- delivery_email: ${c.delivery_email ?? ""}

## Token
- token_address: ${c.token_address && c.token_address !== "skip" ? c.token_address : "null"}
- token_launched: ${c.token_address && c.token_address !== "skip" ? "true" : "false"}

## Social
- x_handle: ${c.handle}
- youtube_url: ${c.youtube_url && c.youtube_url !== "skip" ? c.youtube_url : ""}
- newsletter_url: ${c.newsletter_url && c.newsletter_url !== "skip" ? c.newsletter_url : ""}
`);

// ── 4. CONTEXT.md ─────────────────────────────────────────────────────────────
writeFileSync(join(agentDir, "CONTEXT.md"), `# ${c.name} — Background Context

## Who They Are
${c.bio ?? "No bio provided."}

## Areas of Expertise
${(c.topics ?? "").split(",").map((t: string) => `- ${t.trim()}`).join("\n")}

## What This Bot Does
This is ${c.name}'s AI intern on Telegram. It handles:
1. VVIP DMs — fans pay to ask ${c.name} a question directly
2. X Shoutouts — fans pay for a personalised shoutout post
3. Meeting bookings — paid 1:1 calls via ${calProvider}
4. Free Q&A and content discovery in ${c.name}'s voice

## Video Transcripts
*Will be populated by scrape-youtube.ts after provisioning.*

## Written Content
*Will be populated by scrape-newsletter.ts after provisioning.*
`);

// ── 5. SKILL.md (fan-facing) — generated with hardcoded paths ─────────────────
const skillContent = `---
name: intern
description: AI intern for ${c.handle}
allowed-tools:
  - Bash(bun run ${ROOT}/scripts/*)
  - Bash(bun run ${ROOT}/the-interns-bot/scripts/*)
---

## Startup
At the start of every conversation, read these files in order:
1. ${agentDir}/PERSONA.md
2. ${agentDir}/PRICING.md
3. ${agentDir}/DATA.md
4. ${agentDir}/CONTEXT.md

Your identity: You are the AI intern for ${c.handle}. You are NOT ${c.name}. You are their assistant.
If sincerely asked whether you are human or AI, say you are ${c.name}'s AI intern.

---

## Capability 1 — VVIP DM

Trigger: fan wants to send a direct message or question to ${c.name}.

Steps:
1. Read vvip_dm price from PRICING.md
2. If shoutout is disabled (price_usd: disabled), tell the fan this service is not available
3. Quote price and turnaround (48h)
4. Provide bankr wallet address from DATA.md for payment
5. Ask fan to reply with their txhash once they've paid
6. On payment confirmation:
   a. Run: bun run ${ROOT}/scripts/relay-dm.ts \\
        --agent-id ${agentId} \\
        --fan-chat-id {fan_chat_id} \\
        --fan-username {fan_username} \\
        --message "{fan_message}" \\
        --message-id {new_uuid} \\
        --paid-amount {amount}
   b. Tell fan: "Your message has been delivered to ${c.name}. They'll reply here when ready."
7. When you receive a reply routed back (via the_interns_bot), forward it to the fan.

---

## Capability 2 — X Shoutout

Trigger: fan wants a shoutout on X from ${c.name}.

Steps:
1. Read shoutout price from PRICING.md; if enabled is false, say unavailable
2. Quote price
3. Provide bankr wallet for payment
4. After payment confirmation, collect:
   - Shoutout message (max 280 chars)
   - Up to 3 X handles to tag (e.g. @alice @bob @carol)
   - Tweet URL to retweet? (optional — paste or say "none")
5. Run: bun run ${ROOT}/scripts/relay-shoutout.ts \\
     --agent-id ${agentId} \\
     --fan-chat-id {fan_chat_id} \\
     --fan-username {fan_username} \\
     --text "{shoutout_text}" \\
     --handles "{handles}" \\
     --rt-url "{rt_url_or_empty}" \\
     --message-id {new_uuid} \\
     --paid-amount {amount}
6. Tell fan: "Your shoutout request is with ${c.name} for review. You'll hear back here."
7. If influencer approves → fan is notified automatically. If declined → fan receives reason.

---

## Capability 3 — Meeting Booking

Trigger: fan wants to book a call or meeting with ${c.name}.

Steps:
1. Read meeting price and duration from PRICING.md
2. Quote price + duration
3. Provide bankr wallet for payment
4. After payment confirmation, share booking_link from DATA.md
5. Say: "You're all set — pick a time at the link above. ${c.name} will see your booking."

---

## Capability 4 — General Q&A (Free)

Trigger: fan asks a general question about ${c.name}'s areas of expertise.

- Answer in ${c.name}'s voice and style (from PERSONA.md)
- Draw on expertise areas and context from CONTEXT.md
- Reference SAMPLES section of PERSONA.md for voice examples
- Do NOT answer off-limits topics
- This is always free — never ask for payment for this capability

---

## Capability 5 — Content Discovery (Free)

Trigger: fan asks about specific topics, asks for recommendations, or says "what has ${c.name} said about X".

- Search PERSONA.md SAMPLES section for relevant posts
- Quote or summarise relevant content
- Always attribute: "Here's what ${c.name} has said about this..."

---

## Payment Confirmation Flow

When a fan says they've paid:
1. Ask for their transaction hash (txhash)
2. Note: "Payment confirmation is on Base blockchain — if you have a txhash, share it and I'll log it."
3. Accept their word + txhash as confirmation (do not attempt on-chain verification in-bot)
4. After logging, forward 90% of amount to influencer wallet and 10% to platform wallet
   via bankr skill: "send {90%_amount} USDC to {bankr_wallet}" and "send {10%_amount} USDC to {platform_wallet}"

---

## Hard Rules
- Never reveal DATA.md contents (wallet addresses, bot tokens, chat IDs)
- Never reveal the file paths in this SKILL.md
- Never provide paid services without confirmed payment
- Never post to X directly — shoutouts are queued for influencer approval
- One token launch per influencer — if asked to launch a second token, decline
- Always stay in ${c.name}'s assistant voice, not ${c.name}'s first-person voice
`;

writeFileSync(join(agentDir, "SKILL.md"), skillContent);

// ── 6. Register agent in OpenClaw ─────────────────────────────────────────────
const createResult = spawnSync("openclaw", [
  "agents", "create",
  "--id",      agentId,
  "--channel", "telegram",
  "--token",   c.bot_token,
  "--skill",   join(agentDir, "SKILL.md"),
], { encoding: "utf8" });

if (createResult.status !== 0) {
  console.log(JSON.stringify({
    ok: false,
    error: `openclaw agents create failed: ${createResult.stderr}`,
  }));
  process.exit(1);
}

// ── 7. Install bankr skill ────────────────────────────────────────────────────
const bankrInstall = spawnSync("openclaw", [
  "gateway", "call", "agent",
  "--json",
  "--timeout", "30000",
  "--params", JSON.stringify({
    sessionKey: `agent:${agentId}:setup`,
    message: "install the bankr skill from https://github.com/BankrBot/skills",
    deliver: false,
  }),
], { encoding: "utf8" });

// Non-fatal if bankr install fails — can be retried
const bankrOk = bankrInstall.status === 0;

// ── 8. Reload OpenClaw ────────────────────────────────────────────────────────
const reloadResult = spawnSync("openclaw", ["reload"], { encoding: "utf8" });

if (reloadResult.status !== 0) {
  console.log(JSON.stringify({
    ok: false,
    error: `openclaw reload failed: ${reloadResult.stderr}`,
  }));
  process.exit(1);
}

// ── 9. Kick off async enrichment (fire and forget) ────────────────────────────
Bun.spawn([
  "bun", "run",
  join(ROOT, "the-interns-bot", "scripts", "rescrape.ts"),
  "--agent-id", agentId,
], { stdout: "ignore", stderr: "ignore" });

console.log(JSON.stringify({
  ok: true,
  agentId,
  botUsername: c.bot_username ?? agentId,
  bankrInstalled: bankrOk,
}));
