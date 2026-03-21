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
npm install -g openclaw
```

### Setup

```bash
# Clone / navigate to project
cd ~/000/_COOL/interns

# Install dependencies
bun install

# Copy and fill env
cp .env.example .env
# Edit .env — add THE_INTERNS_BOT_TOKEN, PLATFORM_WALLET, BANKR_API_KEY

# Configure OpenClaw (one-time)
openclaw config set gateway.mode local
openclaw plugins enable telegram
openclaw gateway start

# Register the management bot in OpenClaw (two steps)
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

### Test a script manually

```bash
# Validate a Telegram bot token
bun run the-interns-bot/scripts/validate-token.ts --token 123456:ABC...

# Load onboarding state for a chat
bun run the-interns-bot/scripts/load-state.ts --chat-id 123456789

# Send a test Telegram message
bun run scripts/send-telegram.ts \
  --token "$THE_INTERNS_BOT_TOKEN" \
  --chat-id 123456789 \
  --text "Hello from The Interns Bot!"
```

---

## Deploying on a VPS (DigitalOcean / any Ubuntu 24.04)

### 1. Create Droplet

- Choose **Ubuntu 24.04 LTS**
- Size: **2 vCPU / 2 GB RAM** minimum (1 GB is too small for OpenClaw + Node.js)
- Enable **backups** (recommended)
- Add your SSH key

### 2. One-command Bootstrap

The `bootstrap.sh` script handles everything: system packages, Node.js, Bun, yt-dlp, OpenClaw install + config, git clone, `bun install`, and management bot registration.

```bash
ssh root@YOUR_DROPLET_IP

# Option A — clone first, then bootstrap
cd /opt
git clone https://github.com/YOUR_REPO/interns.git
cd interns
cp .env.example .env
nano .env          # fill in all required vars (see Environment Variables above)
bash bootstrap.sh

# Option B — bootstrap pulls the repo for you (set REPO_URL first)
REPO_URL=https://github.com/YOUR_REPO/interns.git bash <(curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/interns/main/bootstrap.sh)
```

`bootstrap.sh` is **idempotent** — safe to re-run after updating `.env` or pulling new code.

### 3. What bootstrap.sh does (step by step)

| Step | What |
|---|---|
| 1 | `apt upgrade`, installs git / curl / python3 / jq |
| 2 | Installs Node.js 22 via NodeSource |
| 3 | Installs Bun |
| 4 | Installs yt-dlp via pip3 |
| 5 | Installs OpenClaw via `npm install -g openclaw` |
| 6 | Runs `openclaw config set gateway.mode local`, enables telegram plugin, runs `openclaw doctor --repair` |
| 7 | Starts OpenClaw gateway via systemd |
| 8 | Clones / pulls the repo |
| 9 | Runs `bun install` |
| 10 | Creates `.env` from `.env.example` if missing |
| 11 | Registers `@the_interns_bot` in OpenClaw (skipped if `THE_INTERNS_BOT_TOKEN` not set) |

### 4. Pulling updated code

```bash
cd /opt/interns
git pull --ff-only
bun install           # only needed if package.json changed
bash bootstrap.sh     # re-registers bot / re-applies config if needed
```

Or just:

```bash
cd /opt/interns && git pull && bun install
```

SKILL.md changes are **live immediately** — OpenClaw reads the file fresh on each conversation, no restart needed.

### 5. OpenClaw service management

OpenClaw manages its own systemd user service. Use these commands — **not** `systemctl restart openclaw`:

```bash
# Status
openclaw gateway status

# Restart
openclaw gateway restart

# Logs
journalctl --user -u openclaw-gateway.service -f
journalctl --user -u openclaw-gateway.service -n 100 --no-pager

# List registered channels and agents
openclaw channels list
openclaw agents list
```

### 6. Verify

```bash
# Should show: Runtime: running, RPC probe: ok
openclaw gateway status

# Should list: the-interns-bot
openclaw channels list
openclaw agents list

# Then DM @the_interns_bot on Telegram — should reply
```

### 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `Unknown channel: telegram` | Plugin not enabled. Run: `openclaw plugins enable telegram && openclaw gateway restart` |
| Gateway won't start | Run: `openclaw config set gateway.mode local && openclaw gateway restart` |
| Gateway token mismatch | Old process on port 18789. Run: `openclaw gateway stop && openclaw gateway start` |
| Commands hang | Gateway may be stuck. Run: `openclaw gateway status` — if port in use by stale pid, kill it first |
| `openclaw agents create` error | Wrong command. Use `openclaw agents add` (see Step 11 above) |
| `systemctl restart openclaw` hangs | OpenClaw runs as a **user** service, not system. Use `openclaw gateway restart` instead |

---

## Updating the Server

### Pull latest code and restart

```bash
cd /opt/interns

# 1. Pull latest code
git pull --ff-only

# 2. Install any new dependencies
bun install

# 3. Restart OpenClaw gateway (picks up any SKILL.md / config changes)
openclaw gateway restart

# 4. Verify it's healthy
openclaw gateway status
```

### What requires a gateway restart vs. what doesn't

| Change | Restart needed? |
|---|---|
| `SKILL.md` edited | ❌ No — read fresh on every conversation |
| `PERSONA.md` / `PRICING.md` / `DATA.md` edited | ❌ No — same, read fresh |
| New influencer provisioned | ❌ No — `provision-agent.ts` registers the agent live |
| `.env` vars changed | ✅ Yes — `openclaw gateway restart` |
| OpenClaw updated (`npm install -g openclaw`) | ✅ Yes — `openclaw gateway restart` |
| New package added to `package.json` | ❌ No — only `bun install` needed |

### Full update + restart (safe one-liner)

```bash
cd /opt/interns && git pull --ff-only && bun install && openclaw gateway restart && openclaw gateway status
```

### If the gateway is stuck or unhealthy after update

```bash
# Stop cleanly
openclaw gateway stop
sleep 2

# Start fresh
openclaw gateway start
sleep 3

# Confirm running
openclaw gateway status
openclaw channels list
openclaw agents list
```

---

## Adding a New Influencer (Automatic)

Influencers onboard themselves by DMing `@the_interns_bot`. No manual steps needed.

After they complete the 18-step flow, `provision-agent.ts` runs automatically and:
1. Creates skill files in `/opt/interns/influencers/{agentId}/`
2. Registers the agent in OpenClaw (`openclaw channels add` + `openclaw agents add`)
3. Starts background voice enrichment

No restart required — OpenClaw picks up new agents immediately.

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
