# The Interns Bot

AI intern bots for influencers. Each influencer gets their own Telegram bot that handles VVIP DMs, meeting bookings, X shoutouts, and fan Q&A — all in the influencer's own voice. Powered by OpenClaw + Claude + bankr.bot.

---

## How It Works

1. Influencer DMs `@the_interns_bot` on Telegram → 18-step conversational onboarding
2. Platform auto-provisions their bot (`@johndoe_intern_bot`) and registers it in OpenClaw
3. Fans message the intern bot → Claude responds in the influencer's voice
4. Paid services (VVIP DM, shoutout, meeting) go through bankr.bot wallet on Base
5. 10% of each service fee goes to the platform wallet; 90% to the influencer

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `THE_INTERNS_BOT_TOKEN` | ✅ | Telegram token for `@the_interns_bot` (get from @BotFather) |
| `PLATFORM_WALLET` | ✅ | Your bankr.bot wallet address — receives 10% platform fee |
| `INTERNS_DIR` | ✅ on server | Absolute path to this project directory |
| `BANKR_API_KEY` | ✅ | bankr.bot API key (`bk_...`) — calls Claude via [bankr LLM Gateway](https://llm.bankr.bot). Get at [bankr.bot/api](https://bankr.bot/api), enable **LLM Gateway**, top up at [bankr.bot/llm?tab=credits](https://bankr.bot/llm?tab=credits) |
| `X_BEARER_TOKEN` | optional | X/Twitter API v2 Bearer Token — improves scraping quality |
| `YOUTUBE_API_KEY` | optional | YouTube Data API v3 key — used by `scrape-youtube.ts` |
| `DEBUG` | optional | Set `true` for verbose script output |

---

## Running Locally

### Prerequisites

```bash
# 1. Install Bun
curl -fsSL https://bun.sh/install | bash

# 2. Install yt-dlp (for YouTube transcripts)
brew install yt-dlp   # macOS
# or: pip3 install yt-dlp

# 3. Install OpenClaw
# (Follow openclaw.ai installation instructions)
```

### Setup

```bash
# Clone / navigate to project
cd ~/000/_COOL/interns

# Install dependencies
bun install

# Copy and fill env
cp .env.example .env
# Edit .env — add THE_INTERNS_BOT_TOKEN, PLATFORM_WALLET, ANTHROPIC_API_KEY

# Register the management bot in OpenClaw
openclaw agents create \
  --id the-interns-bot \
  --channel telegram \
  --token "$THE_INTERNS_BOT_TOKEN" \
  --skill ~/000/_COOL/interns/the-interns-bot/SKILL.md

openclaw reload

# Start OpenClaw
openclaw start
```

### Test a script manually

```bash
# Validate a Telegram bot token
bun run the-interns-bot/scripts/validate-token.ts --token 123456:ABC...

# Load onboarding state for a chat
bun run the-interns-bot/scripts/load-state.ts --chat-id 123456789

# Send a test Telegram message
THE_INTERNS_BOT_TOKEN=xxx \
bun run scripts/send-telegram.ts \
  --token "$THE_INTERNS_BOT_TOKEN" \
  --chat-id 123456789 \
  --text "Hello from The Interns Bot!"
```

---

## Deploying on DigitalOcean (1-Click Droplet)

### 1. Create Droplet

- Go to DigitalOcean → Create → Droplet
- Choose **Ubuntu 24.04 LTS**
- Size: **Basic — $6/mo (1 vCPU, 1 GB RAM)** is enough for ~50 bots; use $12/mo for 50–200
- Enable **backups** (recommended)
- Add your SSH key

### 2. Initial Server Setup

```bash
ssh root@YOUR_DROPLET_IP

# Update system
apt update && apt upgrade -y

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Install yt-dlp
pip3 install yt-dlp || apt install yt-dlp -y

# Install OpenClaw
# (follow openclaw.ai/docs/install for Linux)
```

### 3. Deploy the Project

```bash
# On your server
cd /opt
git clone https://github.com/YOUR_REPO/interns.git
cd interns

# Install deps
bun install

# Create .env
cp .env.example .env
nano .env
# Fill in: THE_INTERNS_BOT_TOKEN, PLATFORM_WALLET, INTERNS_DIR=/opt/interns, ANTHROPIC_API_KEY
```

### 4. Set INTERNS_DIR

This is critical. All generated SKILL.md files use absolute paths.

```bash
# In .env
INTERNS_DIR=/opt/interns
```

### 5. Register and Start OpenClaw

```bash
# Source env vars
export $(grep -v '^#' .env | xargs)

# Register the management bot
openclaw agents create \
  --id the-interns-bot \
  --channel telegram \
  --token "$THE_INTERNS_BOT_TOKEN" \
  --skill /opt/interns/the-interns-bot/SKILL.md

openclaw reload
```

### 6. Run OpenClaw as a Systemd Service

```bash
# Create service file
cat > /etc/systemd/system/openclaw.service << 'EOF'
[Unit]
Description=OpenClaw Agent Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/interns
EnvironmentFile=/opt/interns/.env
ExecStart=/root/.bun/bin/openclaw start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable openclaw
systemctl start openclaw

# Check status
systemctl status openclaw
journalctl -u openclaw -f
```

### 7. Verify

```bash
# DM @the_interns_bot on Telegram — should receive a greeting
# Check OpenClaw logs
journalctl -u openclaw -n 50
```

---

## Adding a New Influencer (Automatic)

Influencers onboard themselves by DMing `@the_interns_bot`. No manual steps needed.

After they complete the 18-step flow, `provision-agent.ts` runs automatically and:
1. Creates skill files in `/opt/interns/influencers/{agentId}/`
2. Registers the agent in OpenClaw
3. Runs `openclaw reload`
4. Starts background voice enrichment

---

## File Structure

```
interns/
├── the-interns-bot/
│   ├── SKILL.md                  ← management bot conversation guide
│   └── scripts/                  ← scripts called by the management bot
├── influencers/
│   └── {agentId}/                ← created at provision time per influencer
│       ├── SKILL.md              ← fan-facing bot conversation guide
│       ├── PERSONA.md            ← voice, style, sample posts
│       ├── PRICING.md            ← service prices
│       ├── DATA.md               ← wallet, calendar, token info
│       └── CONTEXT.md            ← bio + scraped content
├── messages/
│   └── {agentId}/
│       └── {uuid}.json           ← VVIP DM and shoutout requests
├── state/
│   └── onboarding/
│       └── {hash}.json           ← per-influencer onboarding progress
├── scripts/                      ← shared scripts (relay, scrape, enrich)
├── .env.example
└── package.json
```

---

## Scaling

| Influencers | Setup |
|---|---|
| < 50 | 1 Droplet ($6–12/mo), 1 OpenClaw instance |
| 50–200 | 1 Droplet ($24/mo, 4 vCPU), monitor Telegram polling connections |
| 200+ | Multiple Droplets, shard OpenClaw (50 agents per instance), load-balance provisioning |

---

## Required API Keys Summary

| Variable | Service | Where to get it | Used for |
|---|---|---|---|
| `THE_INTERNS_BOT_TOKEN` | Telegram | @BotFather on Telegram | `@the_interns_bot` itself |
| `BANKR_API_KEY` | bankr.bot LLM Gateway | [bankr.bot/api](https://bankr.bot/api) → enable LLM Gateway | Claude voice synthesis via `enrich-persona.ts` — routes through [llm.bankr.bot](https://llm.bankr.bot) |
| `PLATFORM_WALLET` | bankr.bot wallet | [bankr.bot](https://bankr.bot) | Receiving 10% platform fees |
| `X_BEARER_TOKEN` | X/Twitter API | [developer.twitter.com](https://developer.twitter.com) | Scraping influencer tweets (optional) |
| `YOUTUBE_API_KEY` | YouTube Data API | [console.cloud.google.com](https://console.cloud.google.com) | Listing channel videos (optional) |

> **Note on `BANKR_API_KEY`:** The bankr LLM Gateway is Anthropic-SDK compatible — `enrich-persona.ts` uses the standard `@anthropic-ai/sdk` but points its `baseURL` at `https://llm.bankr.bot`. This means LLM costs are paid from your bankr wallet credits instead of a separate Anthropic account.
