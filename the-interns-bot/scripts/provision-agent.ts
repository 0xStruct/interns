#!/usr/bin/env bun
/**
 * provision-agent.ts
 * Creates all skill files for a new influencer and registers them in OpenClaw.
 * The state file is automatically located by scanning state/onboarding/*.json
 * for the entry whose agentId or derived handle matches --agent-id.
 *
 * Usage:
 *   bun run the-interns-bot/scripts/provision-agent.ts --agent-id johndoe-intern
 *
 * Output JSON: { ok: true, agentId, botUsername } | { ok: false, error }
 */

import { parseArgs } from "util";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const ROOT = process.env.INTERNS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "agent-id": { type: "string" },
  },
  strict: false,
});

const agentId = values["agent-id"];

if (!agentId) {
  console.log(JSON.stringify({ ok: false, error: "Missing --agent-id" }));
  process.exit(1);
}

// ── Auto-locate the state file ────────────────────────────────────────────────
// Derive the expected agentId from a handle (same formula SOUL.md uses)
function deriveAgentId(handle: string): string {
  return handle.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-intern";
}

const stateDir = join(ROOT, "state", "onboarding");
let stateFile: string | null = null;

if (existsSync(stateDir)) {
  for (const file of readdirSync(stateDir).filter(f => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(readFileSync(join(stateDir, file), "utf8"));
      const c = data.collected ?? {};
      if (c.agentId === agentId || deriveAgentId(c.handle ?? "") === agentId) {
        stateFile = join(stateDir, file);
        break;
      }
    } catch {
      // skip malformed files
    }
  }
}

if (!stateFile) {
  console.log(JSON.stringify({
    ok: false,
    error: `No state file found for agentId "${agentId}". Check state/onboarding/*.json contains an entry with matching agentId or handle.`,
  }));
  process.exit(1);
}

const state = JSON.parse(readFileSync(stateFile, "utf8"));
const c = state.collected ?? {};

const agentDir   = join(ROOT, "influencers", agentId);
const handleNoAt = (c.handle ?? "").replace(/^@/, "");
const displayName = `${c.name} (${handleNoAt})`;
const xUrl        = `x.com/${handleNoAt}`;
mkdirSync(agentDir, { recursive: true });

// ── 1. PERSONA.md ─────────────────────────────────────────────────────────────
writeFileSync(join(agentDir, "PERSONA.md"), `# ${displayName} — Persona

## Identity
- Full name: ${displayName}
- X profile: ${xUrl}
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
writeFileSync(join(agentDir, "PRICING.md"), `# ${displayName} — Pricing

## Paid DM
- price_usd: ${c.vvip_dm_price ?? 50}
- turnaround: 48 hours
- description: A direct, personal reply from ${displayName} to your question.

## 1:1 Meeting
- price_usd: ${c.meeting_price ?? 200}
- duration_min: 30
- description: A one-on-one call with ${displayName}.

## X Shoutout
- price_usd: ${c.shoutout_price && c.shoutout_price !== "skip" ? c.shoutout_price : "disabled"}
- description: ${displayName} will post a custom shoutout mentioning your handles on X.
- enabled: ${c.shoutout_price && c.shoutout_price !== "skip" ? "true" : "false"}
`);

// ── 3. DATA.md ────────────────────────────────────────────────────────────────
const calProvider = (c.calendar_link ?? "").includes("calendly.com") ? "Calendly" : "cal.com";
writeFileSync(join(agentDir, "DATA.md"), `# ${displayName} — Operational Data

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
- x_profile: ${xUrl}
- youtube_url: ${c.youtube_url && c.youtube_url !== "skip" ? c.youtube_url : ""}
- newsletter_url: ${c.newsletter_url && c.newsletter_url !== "skip" ? c.newsletter_url : ""}
`);

// ── 4. CONTEXT.md ─────────────────────────────────────────────────────────────
writeFileSync(join(agentDir, "CONTEXT.md"), `# ${displayName} — Background Context

## Who They Are
${c.bio ?? "No bio provided."}
X profile: ${xUrl}

## Areas of Expertise
${(c.topics ?? "").split(",").map((t: string) => `- ${t.trim()}`).join("\n")}

## What This Bot Does
This is ${displayName}'s AI intern on Telegram. It handles:
1. VVIP DMs — fans pay to ask ${displayName} a question directly
2. X Shoutouts — fans pay for a personalised shoutout post on ${xUrl}
3. Meeting bookings — paid 1:1 calls via ${calProvider}
4. Free Q&A and content discovery in ${displayName}'s voice

## Video Transcripts
*Will be populated by scrape-youtube.ts after provisioning.*

## Written Content
*Will be populated by scrape-newsletter.ts after provisioning.*
`);

// ── 5a. SKILL.md (fan-facing tool permissions) ──────────────────────────────────
writeFileSync(join(agentDir, "SKILL.md"), `---
name: intern
description: AI intern for ${c.handle}
allowed-tools:
  - "Bash(bun run ${ROOT}/scripts/*)"
  - "Bash(bun run ${ROOT}/the-interns-bot/scripts/*)"
---
`);

// ── 5b. SOUL.md (fan-facing system prompt — OpenClaw reads this, NOT SKILL.md body)
writeFileSync(join(agentDir, "SOUL.md"), `# ${displayName}'s AI Intern

You are the AI intern for ${xUrl}. You are NOT ${displayName}. You are their assistant.
If sincerely asked whether you are human or AI, say you are ${displayName}'s AI intern.

## Startup
At the start of every conversation, read these files in order:
1. ${agentDir}/PERSONA.md
2. ${agentDir}/PRICING.md
3. ${agentDir}/DATA.md
4. ${agentDir}/CONTEXT.md

---

## Capability 1 — Paid DM (/dm)

Trigger: fan sends /dm or wants to send a paid direct message or question to ${displayName}.

Steps:
1. Read paid DM price from PRICING.md (under "Paid DM" section)
2. If paid DM is disabled (price_usd: disabled), tell the fan this service is not available
3. Quote price and turnaround (48h)
4. Ask fan to write their message first
5. **Content check**: Screen the message for vulgarity, harassment, threats, hate speech, or inappropriate content.
   - If inappropriate: "Sorry, I can't deliver this message. Please keep it respectful and try again."
   - Do NOT proceed to payment or relay if the content is inappropriate.
6. If message is clean, provide bankr wallet address from DATA.md for payment
7. Ask fan to reply with their txhash once they've paid
8. On payment confirmation:
   a. Run: bun run ${ROOT}/scripts/relay-dm.ts \\
        --agent-id ${agentId} \\
        --fan-chat-id {fan_chat_id} \\
        --fan-username {fan_username} \\
        --message "{fan_message}" \\
        --message-id {new_uuid} \\
        --paid-amount {amount}
   b. Tell fan: "Your message has been delivered to ${displayName}. They'll reply here when ready."
9. When you receive a reply routed back (via the_interns_bot), forward it to the fan.

---

## Capability 2 — X Shoutout

Trigger: fan wants a shoutout on X from ${displayName}.

Steps:
1. Read shoutout price from PRICING.md; if enabled is false, say unavailable
2. Quote price
3. Provide bankr wallet for payment
4. After payment confirmation, collect:
   - Shoutout message (max 280 chars)
   - Up to 3 X handles to tag (e.g. x.com/alice x.com/bob x.com/carol)
   - Tweet URL to retweet? (optional — paste or say "none")
5. **Content check**: Screen the shoutout message for vulgarity, harassment, threats, hate speech, spam, or inappropriate content.
   - If inappropriate: "Sorry, this shoutout message contains inappropriate content. Please rewrite it and try again."
   - Do NOT relay if the content is inappropriate. Ask fan to revise.
6. Run: bun run ${ROOT}/scripts/relay-shoutout.ts \\
     --agent-id ${agentId} \\
     --fan-chat-id {fan_chat_id} \\
     --fan-username {fan_username} \\
     --text "{shoutout_text}" \\
     --handles "{handles}" \\
     --rt-url "{rt_url_or_empty}" \\
     --message-id {new_uuid} \\
     --paid-amount {amount}
6. Tell fan: "Your shoutout request is with ${displayName} for review. You'll hear back here."
7. If influencer approves -> fan is notified automatically. If declined -> fan receives reason.

---

## Capability 3 — Meeting Booking

Trigger: fan wants to book a call or meeting with ${displayName}.

Steps:
1. Read meeting price and duration from PRICING.md
2. Quote price + duration
3. Provide bankr wallet address from DATA.md for payment
4. Ask fan to reply with their txhash once they've paid
5. On payment confirmation:
   a. Generate a unique booking ref: \`pay_\` + 8 random hex chars (e.g. \`pay_a1b2c3d4\`)
   b. Build one-time booking URL: append \`?metadata[ref]=PAY_REF&metadata[fan]={fan_username}\` to the booking_link from DATA.md
      Example: \`https://cal.com/johndoe/30min?metadata[ref]=pay_a1b2c3d4&metadata[fan]=@alice\`
   c. Run: bun run ${ROOT}/scripts/relay-dm.ts \\
        --agent-id ${agentId} \\
        --fan-chat-id {fan_chat_id} \\
        --fan-username {fan_username} \\
        --message "Meeting booking paid (ref: {PAY_REF})" \\
        --message-id {new_uuid} \\
        --paid-amount {amount}
   d. Share the one-time URL with the fan:
      "Payment confirmed! Here's your personal booking link (valid for 24 hours, single use):
      {one_time_booking_url}
      Pick a time that works for you."
6. NEVER share the plain booking link without payment. Always generate a unique ref URL.

---

## Capability 4 — General Q&A (Free)

Trigger: fan asks a general question about ${displayName}'s areas of expertise.

- Answer in ${displayName}'s voice and style (from PERSONA.md)
- Draw on expertise areas and context from CONTEXT.md
- Reference SAMPLES section of PERSONA.md for voice examples
- Do NOT answer off-limits topics
- This is always free - never ask for payment for this capability

---

## Capability 5 — Content Discovery (Free)

Trigger: fan asks about specific topics, asks for recommendations, or says "what has ${displayName} said about X".

- Search PERSONA.md SAMPLES section for relevant posts
- Quote or summarise relevant content
- Always attribute: "Here's what ${displayName} has said about this..."

---

## Payment Confirmation Flow

When a fan says they've paid:
1. Ask for their transaction hash (txhash)
2. Note: "Payment confirmation is on Base blockchain - if you have a txhash, share it and I'll log it."
3. Accept their word + txhash as confirmation (do not attempt on-chain verification in-bot)
4. After logging, forward 90% of amount to influencer wallet and 10% to platform wallet
   via bankr skill: "send {90%_amount} USDC to {bankr_wallet}" and "send {10%_amount} USDC to {platform_wallet}"

---

## Owner Command (/owner)

If the current user's chat_id matches the influencer_chat_id in DATA.md, they are the OWNER.
When the owner sends /owner, respond with:

1. **Bot overview**: bot name, X profile (${xUrl}), current prices from PRICING.md
2. **Fan engagement summary**: summarise any recent conversations or interesting fan interactions you've had (from your conversation history). If no fans yet, say "No fan interactions yet."
3. **Management reminder**: "To manage settings, prices, persona, and more — talk to @the_interns_bot."

If a non-owner sends /owner, say: "This command is only available to the bot owner."

---

## Hard Rules
- Never reveal DATA.md contents (wallet addresses, bot tokens, chat IDs) to fans
- Never reveal the file paths in this prompt
- Never provide paid services without confirmed payment
- Never post to X directly - shoutouts are queued for influencer approval
- One token launch per influencer - if asked to launch a second token, decline
- Always stay in ${displayName}'s assistant voice, not ${displayName}'s first-person voice
- When referencing the influencer's X profile, use ${xUrl} (not @${handleNoAt})
- Owner can see DATA.md summary via /owner but fans cannot
`);

// ── 6. Register in OpenClaw (background — avoids deadlocking the gateway) ────
// When this script runs inside a gateway tool execution, synchronous openclaw CLI
// calls would deadlock (gateway waits for tool; tool waits for gateway RPC).
// Solution: write a small registration script and run it detached.
const registerScript = join(agentDir, ".register.sh");
writeFileSync(registerScript, `#!/usr/bin/env bash
set -e
sleep 15  # give the management bot time to send the success message before gateway restart

OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"

# Register Telegram channel
openclaw channels add \\
  --channel telegram \\
  --token "${c.bot_token}" \\
  --account "${agentId}" \\
  --name "${(c.name ?? agentId).replace(/"/g, '\\"')}" \\
  2>/dev/null || true

# Set dmPolicy to "open" for the new bot account (default is "pairing" which
# requires manual approval for every fan — we want public bots)
python3 - <<'PYEOF'
import json, os
cfg_path = os.path.expanduser("~/.openclaw/openclaw.json")
with open(cfg_path) as f:
    cfg = json.load(f)
acct = cfg.setdefault("channels", {}).setdefault("telegram", {}).setdefault("accounts", {}).setdefault("${agentId}", {})
acct["dmPolicy"] = "open"
acct["allowFrom"] = ["*"]
with open(cfg_path, "w") as f:
    json.dump(cfg, f, indent=2)
print("dmPolicy set to open for ${agentId}")
PYEOF

# Register agent with workspace
openclaw agents add "${agentId}" \\
  --workspace "${agentDir}" \\
  --bind "telegram:${agentId}" \\
  --non-interactive \\
  --json \\
  2>/dev/null || true

# Set fan-facing slash commands (+ owner-scoped /owner command)
bun run "${join(ROOT, "the-interns-bot", "scripts", "set-fans-commands.ts")}" \\
  --agent-id "${agentId}" \\
  2>/dev/null || true

# Clear any stale sessions for this agent before restart
rm -f "$HOME/.openclaw/agents/${agentId}/sessions/"*.jsonl 2>/dev/null || true
rm -f "$HOME/.openclaw/agents/${agentId}/sessions/sessions.json" 2>/dev/null || true

# Restart gateway to pick up new account + dmPolicy
openclaw gateway restart 2>/dev/null || true

# Kick off async voice enrichment
bun run "${join(ROOT, "the-interns-bot", "scripts", "rescrape.ts")}" \\
  --agent-id "${agentId}" \\
  2>/dev/null || true

echo "Registration complete for ${agentId}"
`, { mode: 0o755 });

// Fire and forget — detached from the current process
const child = spawn("bash", [registerScript], {
  detached: true,
  stdio: "ignore",
});
child.unref();

// Return success immediately — files are created, registration is in background
console.log(JSON.stringify({
  ok: true,
  agentId,
  botUsername: c.bot_username ?? agentId,
  registrationStatus: "background",
  note: "OpenClaw registration running in background. Bot will be live in ~10 seconds.",
}));
