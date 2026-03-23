# interns.bot

AI intern bots for creators. Each creator gets their own Telegram bot that handles paid DMs, meeting bookings, X shoutouts, and fan Q&A — in the creator's own voice. Every service is also payable by AI agents via [x402](https://github.com/coinbase/x402) (USDC on Base).

📄 [Full pitch deck → PITCH.md](./PITCH.md)
📄 [Summary of Agent session → SESSION.md](./SESSION.md)

---

## How It Works

1. Creator DMs `@the_interns_bot` → completes a conversational onboarding flow
2. Platform auto-provisions their bot (`@steve55_intern_bot`) with persona, pricing, and wallet
3. Fans message the intern bot → it responds in the creator's voice, 24/7
4. Paid services (/dm, /shoutout, /meeting) go through a browser paywall (OnchainKit) or direct x402 HTTP payment
5. Creator receives USDC on Base; 10% platform fee deducted automatically

---

## Environment Variables

Copy `.env.example` to `.env`:

| Variable | Required | Description |
|---|---|---|
| `THE_INTERNS_BOT_TOKEN` | Yes | Telegram token for `@the_interns_bot` (from @BotFather) |
| `TELEGRAM_BOT_TOKEN` | Yes | Same token — used by x402 server for influencer notifications |
| `PLATFORM_WALLET` | Yes | Your wallet address — receives 10% platform fee |
| `BANKR_API_KEY` | Yes | bankr.bot API key (`bk_...`) for LLM inference via [llm.bankr.bot](https://llm.bankr.bot) |
| `CDP_CLIENT_KEY` | Yes | Coinbase Developer Platform key — powers the OnchainKit browser paywall |
| `X402_BASE_URL` | Yes | Public URL of x402 server, e.g. `https://api.interns.bot` |
| `X402_NETWORK` | Yes | `base-sepolia` (testnet) or `base` (mainnet) |
| `LLM_MODEL` | optional | Default: `gemini-3-flash`. Options: `gemini-3-flash`, `claude-haiku-3-5`, `claude-sonnet-4-5` |
| `X_BEARER_TOKEN` | optional | X/Twitter API Bearer Token — improves tweet scraping |
| `YOUTUBE_API_KEY` | optional | YouTube Data API v3 key |
| `DEBUG` | optional | Set `true` for verbose script output |

> `BANKR_API_KEY` routes through the bankr LLM Gateway — an Anthropic-SDK-compatible proxy at `https://llm.bankr.bot`. Get it at [bankr.bot/api](https://bankr.bot/api).

---

## Running Locally

### Prerequisites

```bash
curl -fsSL https://bun.sh/install | bash   # Bun
brew install yt-dlp                         # yt-dlp (macOS)
npm install -g openclaw                     # OpenClaw
```

### Setup

```bash
cd ~/000/_COOL/interns
bun install
cp .env.example .env
# fill in .env

openclaw config set gateway.mode local
openclaw plugins enable telegram
openclaw gateway start

source .env
openclaw channels add \
  --channel telegram \
  --token "$THE_INTERNS_BOT_TOKEN" \
  --account the-interns-bot \
  --name "The Interns Bot"

openclaw agents add the-interns-bot \
  --workspace "$(pwd)/the-interns-bot" \
  --bind telegram:the-interns-bot \
  --non-interactive \
  --json
```

---

## Deploying on a VPS (Ubuntu 24.04)

### 1. Create Droplet

- **Ubuntu 24.04 LTS**, 2 vCPU / 2 GB RAM minimum
- Add your SSH key

### 2. Bootstrap

```bash
ssh root@YOUR_DROPLET_IP
cd /opt
git clone https://github.com/0xstruct/interns.git && cd interns
cp .env.example .env
nano .env          # fill in all required vars
bash bootstrap.sh
```

`bootstrap.sh` is **idempotent** — safe to re-run after updating `.env` or pulling new code.

### What bootstrap.sh does

| Step | What |
|---|---|
| 1–4 | apt upgrade, installs git / Node.js 22 / Bun / yt-dlp |
| 5 | Installs OpenClaw globally |
| 6a–f | Configures OpenClaw: local gateway mode, telegram plugin, open dmPolicy, bankr LLM provider, bun in PATH, minimal global SOUL.md |
| 7 | Starts OpenClaw gateway via systemd |
| 8–10 | Clones/pulls repo, `bun install`, creates `.env` if missing |
| 11 | Registers `@the_interns_bot`, runs `set-admins-commands.ts` + `set-fans-commands.ts` |
| 11b | Installs `interns-x402` systemd user service (x402 payment server on port 4402) |
| 12 | Clears stale sessions, restarts gateway |

### Pulling updates

```bash
cd /opt/interns && git pull && bun install && bash bootstrap.sh
```

Or quick update (no session clear):

```bash
cd /opt/interns && git pull && bun install && openclaw gateway restart && systemctl --user restart interns-x402.service
```

### Service management

```bash
# OpenClaw gateway
openclaw gateway status
openclaw gateway restart
journalctl --user -u openclaw-gateway.service -f

# x402 payment server
systemctl --user restart interns-x402.service
journalctl --user -u interns-x402.service -f

# List registered agents
openclaw channels list
openclaw agents list --bindings
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Unknown channel: telegram` | Re-run bootstrap.sh |
| Gateway won't start | `openclaw config set gateway.mode local && openclaw gateway restart` |
| Bot shows pairing code | `dmPolicy` not set — re-run bootstrap.sh |
| Bot ignores SOUL.md | Stale session. Clear: `rm -f ~/.openclaw/agents/the-interns-bot/sessions/*.jsonl ~/.openclaw/agents/the-interns-bot/sessions/sessions.json && openclaw gateway restart` |
| `HTTP 401: invalid x-api-key` | Check `BANKR_API_KEY` in `.env`, re-run bootstrap.sh |
| `systemctl restart openclaw` hangs | Use `openclaw gateway restart` (user service) |

---

## DNS + HTTPS for `api.interns.bot`

The x402 payment server runs on port `4402`. To expose it publicly:

### 1. Add DNS A record

| Type | Name | Value |
|------|------|-------|
| A | `api` | `YOUR_DROPLET_IP` |

Verify: `dig api.interns.bot`

### 2. nginx + certbot

```bash
apt install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/api.interns.bot`:

```nginx
server {
    listen 80;
    server_name api.interns.bot;
    location / {
        proxy_pass         http://127.0.0.1:4402;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/api.interns.bot /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d api.interns.bot
```

### 3. Update `.env`

```
X402_BASE_URL=https://api.interns.bot
X402_NETWORK=base-sepolia    # or base for mainnet (requires self-hosted facilitator)
```

```bash
systemctl --user restart interns-x402.service
curl https://api.interns.bot/
```

---

## x402 — Agent-to-Agent Payments

Every intern bot service is an HTTP endpoint payable via [x402](https://github.com/coinbase/x402) — USDC on Base, no API keys, no OAuth.

### Discovery

```bash
# Machine-readable: all intern bots + payable services (x402 format)
curl https://api.interns.bot/.well-known/x402.json

# Agent discovery convention
curl https://api.interns.bot/.well-known/agents.json

# Human-readable index
curl https://api.interns.bot/

# One creator's service catalog
curl https://api.interns.bot/agents/steve55
```

### Paying as an AI agent

```bash
# 1. Call endpoint → receive 402 with payment requirements
curl -s -X POST https://api.interns.bot/agents/steve55/dm \
  -H "Content-Type: application/json" \
  -d '{"message": "Love your work!", "from": "agent_alice"}'
# → 402  { "x402Version":1, "accepts":[{ "maxAmountRequired":"1000000", "payTo":"0x...", ... }] }

# 2. Sign USDC transferWithAuthorization (EIP-3009) using x402 client library
# 3. Retry with X-PAYMENT header
curl -s -X POST https://api.interns.bot/agents/steve55/dm \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <base64_signed_payment>" \
  -d '{"message": "Love your work!", "from": "agent_alice"}'
# → 200  { "success":true, "txHash":"0x...", "delivered":true }
```

### Endpoints

| Method | Endpoint | Service | Body fields |
|--------|----------|---------|-------------|
| POST | `/agents/:handle/dm` | Paid DM | `message`, `from` |
| POST | `/agents/:handle/shoutout` | X shoutout | `text`, `from` |
| POST | `/agents/:handle/meeting` | Meeting booking | `from` |
| GET | `/pay/:handle/:service` | Browser paywall (OnchainKit) | — |
| POST | `/sessions/:handle/:service` | Create Telegram fan session | `message`/`text`, `from`, `fanChatId`, `botToken`, `influencerChatId` |
| GET | `/sessions/:ref/status` | Poll session payment status | — |

> **Network note:** The [x402.org public facilitator](https://x402.org/facilitator) supports Base Sepolia. For Base mainnet, run the [x402 facilitator](https://github.com/coinbase/x402) yourself and set `X402_FACILITATOR_URL`.

---

## OpenClaw File Architecture

```
~/.openclaw/
├── openclaw.json                 ← global config (plugins, channels, providers)
├── workspace/                    ← global workspace (included for ALL agents — keep minimal)
│   └── SOUL.md
└── agents/{agentId}/
    ├── config.json               ← routing config
    ├── sessions/                 ← conversation history (clear to reset behavior)
    └── agent/
        └── SKILL.md              ← tool permissions (allowed-tools frontmatter only)

/opt/interns/the-interns-bot/     ← management bot workspace
├── SOUL.md                       ← system prompt
└── scripts/

/opt/interns/influencers/{agentId}/  ← fan-facing bot workspace (created at provision time)
├── SOUL.md                          ← system prompt
├── SKILL.md                         ← tool permissions
├── PERSONA.md                       ← voice, style, sample posts
├── PRICING.md                       ← service prices
├── DATA.md                          ← wallet, calendar info
└── CONTEXT.md                       ← bio + scraped content
```

**Key rules:**
- `SOUL.md` in the agent workspace = the system prompt Claude follows
- `SKILL.md` = `allowed-tools` frontmatter only; body is not used as a system prompt
- Global workspace files apply to ALL agents — keep them minimal
- Clear sessions after editing `SOUL.md`: stale sessions cache old behavior

### What requires a restart

| Change | Gateway restart? | Session clear? |
|---|---|---|
| `SOUL.md` edited | Yes | Yes |
| `PERSONA.md` / `PRICING.md` / `DATA.md` edited | No | No |
| New influencer provisioned | No | No |
| `.env` vars changed | Yes | No |
| x402-server.ts changed | `systemctl --user restart interns-x402.service` | No |

---

## Managing Influencer Bots

### Onboarding (automatic)

Influencers DM `@the_interns_bot` and complete the flow. `provision-agent.ts` runs automatically and:
1. Creates skill files in `influencers/{agentId}/`
2. Registers the agent in OpenClaw
3. Sets `dmPolicy: open` for fans
4. Registers slash commands

### Re-provisioning (after template changes)

```bash
cd /opt/interns

# Single bot
bun run the-interns-bot/scripts/provision-agent.ts --agent-id steve55-intern

# All bots
for agent_id in influencers/*/; do
  agent_id="${agent_id%/}"; agent_id="${agent_id#influencers/}"
  bun run the-interns-bot/scripts/provision-agent.ts --agent-id "$agent_id"
done

# Clear sessions + restart
rm -f ~/.openclaw/agents/*/sessions/*.jsonl ~/.openclaw/agents/*/sessions/sessions.json
sleep 20 && openclaw gateway restart
```

### Updating slash commands

```bash
# Management bot (@the_interns_bot)
bun run the-interns-bot/scripts/set-admins-commands.ts

# All fan-facing bots
bun run the-interns-bot/scripts/set-fans-commands.ts

# Single fan bot
bun run the-interns-bot/scripts/set-fans-commands.ts --agent-id steve55-intern
```

> `bootstrap.sh` runs both automatically on every run.

---

## File Structure

```
interns/
├── x402-server.ts                ← x402 HTTP payment server (port 4402)
├── the-interns-bot/
│   ├── SOUL.md                   ← management bot system prompt
│   ├── SKILL.md
│   └── scripts/                  ← provision-agent.ts, create-payment-session.ts, etc.
├── influencers/{agentId}/        ← created per creator at provision time
├── messages/{agentId}/           ← queued DM and shoutout requests
├── state/onboarding/             ← per-creator onboarding state
├── bootstrap.sh
├── .env.example
├── PITCH.md                      ← product pitch
└── package.json
```

---

## Scaling

| Creators | Setup |
|---|---|
| < 50 | 1 Droplet ($6–12/mo), 1 OpenClaw instance |
| 50–200 | 1 Droplet ($24/mo, 4 vCPU) |
| 200+ | Multiple Droplets, shard OpenClaw (50 agents per instance) |
