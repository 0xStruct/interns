# interns.bot — Session Summary

Session from Claude Code project log. Covers the `interns.bot` build from initial concept through x402 payment integration. Sensitive values have been redacted.

---

## 1. Concept & Architecture

- Goal: multi-tenant platform where creators/influencers each get a personal AI intern Telegram bot
- Central management bot `@the_interns_bot` handles onboarding conversationally (no dashboard needed)
- Each influencer gets their own OpenClaw agent + dedicated Telegram bot token
- Fan-facing services: paid DMs, X shoutouts, meeting bookings, free Q&A
- Payment model: bankr.bot (Base blockchain), 90% to influencer / 10% platform fee

**Architecture decision: single OpenClaw process, multiple named agents**
- OpenClaw natively supports multiple agents via session key: `agent:[agentId]:telegram:direct:[chatId]`
- No containers per influencer — one process handles all bots
- Each influencer = one `agentId` = one Telegram bot token registered in config
- Workspace files (`SOUL.md`, `SKILL.md`, `DATA.md`) per agent drive personality + behaviour

---

## 2. Initial Implementation Plan

- Provisioning flow: influencer talks to `@the_interns_bot` → provides their own bot token → agent is created automatically
- Two concerns separated: provisioning (one-time agent creation) vs skill updates (ongoing)
- Files per influencer agent:
  - `SOUL.md` — personality, persona, pricing, links
  - `SKILL.md` — allowed tools and instructions
  - `DATA.md` — structured config (prices, wallet address, cal.com link, etc.)
  - `IDENTITY.md`, `AGENTS.md`, `BOOTSTRAP.md` — workspace identity and memory

---

## 3. LLM Gateway — Bankr

- Decision: use Bankr LLM Gateway (`https://llm.bankr.bot`) instead of direct Anthropic API key
- Bankr gateway is Anthropic-compatible; set `ANTHROPIC_BASE_URL=https://llm.bankr.bot` and `ANTHROPIC_API_KEY=[API_KEY]`
- Confirmed gateway works: supports Claude and Gemini models
- Set via `/opt/interns/.env` and injected into systemd service via `env.conf`

---

## 4. OpenClaw Setup on DigitalOcean VPS

### First Droplet (destroyed due to hanging issues)
- Errors encountered with `openclaw agents create --id` — option did not exist; correct command is `openclaw agents add`
- `Unknown channel: telegram` — telegram plugin was disabled by default; needed `openclaw plugins enable telegram`
- Gateway config missing (`~/.openclaw/openclaw.json`) — fixed with `openclaw doctor --repair`
- After `doctor --repair`: `gateway.mode` set, systemd service enabled
- Telegram plugin enabled after restart; channels showed as registered

### Second Droplet (current)
- Version: OpenClaw 2026.3.13
- Same `openclaw doctor --repair` process repeated on fresh VPS
- `openclaw channels add --channel telegram --token [BOT_TOKEN] --account the-interns-bot` — registered main bot
- `openclaw agents add the-interns-bot --bind telegram:the-interns-bot` — registered agent
- Agent bindings confirmed via `openclaw agents list --bindings`

### Access / Pairing
- Initial DM to bot: returned pairing code, required `openclaw pairing approve telegram <CODE>`
- Root cause: `dmPolicy` defaulted to `"pairing"` — fixed by setting it to `"open"` in `openclaw.json` for both channel and account level

### Auth Profile (API key)
- Error: `No API key found for provider "anthropic"` on first message
- Fix: write `~/.openclaw/agents/the-interns-bot/agent/auth-profiles.json` with `apiKey=[API_KEY]` and `baseURL=https://llm.bankr.bot`
- Verified Bankr key worked via direct `curl` to `https://llm.bankr.bot/v1/messages`
- Systemd env injection (`import-environment`) did not propagate — direct file write was the fix

### SOUL.md in Agent Dir vs Workspace
- Initial confusion: SOUL.md needed to be in `~/.openclaw/agents/the-interns-bot/agent/` not just the workspace
- After placing it there and clearing sessions, bot replied correctly with "WORKSPACE SOUL ACTIVE"

---

## 5. Slash Command Registration

- Telegram slash commands registered via `scripts/set-commands.ts` (then renamed):
  - `set-admins-commands.ts` — registers management commands for `@the_interns_bot` (influencer-facing)
  - `set-fans-commands.ts` — registers fan-facing commands for all deployed intern bots
- Ran with `bun run scripts/set-fans-commands.ts --token [BOT_TOKEN]`
- Bun not installed initially — added to bootstrap and systemd PATH
- Bot was not responding to slash commands initially — root cause: SOUL.md placement (see above)

**Fan-facing commands:**
- `/dm` — paid private message to influencer
- `/shoutout` — paid X post mention
- `/meeting` — paid calendar booking
- `/qa` — free Q&A
- `/about` — who is this bot

**Admin command (for owner viewing fan-facing bot):**
- `/owner` — shows engagement summary + directs to `@the_interns_bot` for settings

---

## 6. Onboarding Flow (the_interns_bot)

- 18-step conversational flow: collects influencer name, X handle, bot token, wallet address, prices, cal.com link, persona description
- After collection: runs `scripts/provision-agent.ts --agent-id <agentId>` to create the agent
- Creates workspace at `/opt/interns/influencers/<handle>-intern/`
- Registers OpenClaw agent, channel binding, copies SOUL/SKILL templates
- Sends confirmation with link to new fan-facing bot

**Issue:** Bot said "Setting up your intern bot now..." then went silent
- Root cause: provision script errors were swallowed; improved error logging
- Also: sessions not cleared after provisioning — bot remembered old incomplete state

---

## 7. Fan-Facing Bot Behaviour

- First message from new user triggered pairing prompt (`dmPolicy` not set to `open`)
- Fix: `provision-agent.ts` now sets `dmPolicy: open` in `openclaw.json` for each provisioned agent
- Bot persona read from `SOUL.md` in agent workspace
- Name/X handle displayed as: `Name (XHandle)` — e.g. `Steve (steve55)` (no `@` prefix)

**Booking link security** — discussion of options:
- Option chosen: generate per-payment unique cal.com links (not implemented yet) OR use cal.com + payment reference to validate
- Simpler: payment happens first → booking link delivered only after confirmed payment

**Vulgarity check** — added to `/dm` and `/shoutout` flow before creating payment session

**Owner detection** — if influencer talks to their own fan-facing bot:
- Shows `/owner` command only
- `/owner` gives engagement stats summary + link to `@the_interns_bot` for settings

---

## 8. Model Selection

- Default: `bankr/claude-sonnet-4-5` (set at provisioning)
- Discussion: Gemini 3 Flash confirmed supported by Bankr gateway — lower cost for fan-facing bots
- Decision: use `gemini-3-flash` as default model for fan-facing bots (cost-effective)
- Updated in `provision-agent.ts` and `bootstrap.sh`

---

## 9. HTML Tags in Telegram Responses

- Bot was outputting raw HTML tags (`<b>`, `<code>`, etc.) in Telegram messages
- Root cause: OpenClaw's Telegram plugin renders Markdown → Telegram HTML by default; SOUL.md was using HTML directly
- Fix: update SOUL.md prompt to instruct the agent to use plain Markdown (not HTML tags)

---

## 10. Scripts Refactoring

- Renamed `set-commands.ts` → split into `set-admins-commands.ts` and `set-fans-commands.ts`
- `provision-agent.ts` simplified: only requires `--agent-id`; `STATE_FILE` path derived automatically from agent ID
- README updated with instructions for re-running commands and re-provisioning

---

## 11. x402 Payment Integration

### Goal
- Make `/dm`, `/shoutout`, `/meeting` payable via x402 protocol
- Supports both human fans (via browser wallet) and AI agent-to-agent payments
- Verifiable on-chain; no manual payment confirmation needed

### x402 Server (`x402-server.ts`)
- Bun HTTP server listening on port `4402`
- Run as systemd user service: `interns-x402.service`
- Endpoints:
  - `GET /` — platform discovery (lists all influencer agents)
  - `GET /agents/:handle` — agent service catalog (DM, shoutout, meeting prices + endpoints)
  - `GET /agents/:handle/:service` (no payment) → returns `402` with `X-Payment-Required` header
  - `GET /agents/:handle/:service` (with `X-PAYMENT` header) → verify → settle → notify
  - `GET /pay/:handle/:service` — returns OnchainKit paywall HTML page for browser payment
  - `GET /success/:handle/:service` — success confirmation page after payment
  - `GET /.well-known/x402.json` — machine-readable service discovery for agent crawlers

### Payment Session Flow
1. Fan sends `/shoutout` in Telegram → bot collects text + target
2. Bot calls `create-payment-session.ts` → stores session in `state/sessions/<ref>.json` with `{message, from, fanChatId, influencerToken, influencerChatId}`
3. Bot sends paywall URL: `https://api.interns.bot/pay/:handle/:service?ref=<uuid>`
4. Fan opens URL in browser → OnchainKit wallet connect UI → signs EIP-712 payment → sends GET with `X-PAYMENT` header
5. x402 server: decode header → verify with `https://x402.org/facilitator` → settle (transfer on-chain) → notify fan + influencer via Telegram

### DNS & Nginx Setup
- `api.interns.bot` A record pointing to VPS IP
- Nginx reverse proxy: port 443 → `localhost:4402`
- Certbot SSL for `api.interns.bot`

### Debugging Journey

**Issue 1: Paywall showing success but bot not notified**
- Root cause: OnchainKit paywall sends `GET` with `X-PAYMENT` header (not POST)
- Our handler returned `200` immediately for any GET, skipping all verify/settle/notify logic
- Fix: handle GET+`X-PAYMENT` through the full verify → settle → deliver → notify path

**Issue 2: `Missing paymentPayload or paymentRequirements`**
- Root cause: sending `paymentHeader` (raw base64) to facilitator instead of `paymentPayload` (decoded JSON object)
- Fix: decode the base64 header, pass parsed JSON as `paymentPayload`

**Issue 3: `No facilitator registered for scheme: exact and network: base`**
- Root cause: `x402.org/facilitator` is testnet-only; does not support Base mainnet
- Fix: set `X402_NETWORK=base-sepolia` in `.env`; use Base Sepolia testnet USDC for testing
- Note: mainnet requires self-hosted facilitator (open-source, needs ETH for gas)

**Issue 4: `invalid_exact_evm_missing_eip712_domain`**
- Root cause: facilitator needs explicit EIP-712 domain fields (`name`, `version`) in payment requirements
- Fix: add `extra: { name: "USDC", version: "2" }` for base-sepolia (or `"USD Coin"` for mainnet)

**Issue 5: Influencer notification using wrong bot token**
- Root cause: `notifyPayment` used the fan-facing bot token to message the influencer — but influencer never initiated a chat with that bot, so `chat not found` (400)
- Fix: use `TELEGRAM_BOT_TOKEN` (main `@the_interns_bot` token) for influencer notifications, since they have chatted with that bot during onboarding

### Final Working Flow (Base Sepolia)
1. Fan → `/shoutout` in fan bot ✅
2. Bot → creates payment session → sends paywall link ✅
3. Fan pays via OnchainKit (Coinbase Wallet, Base Sepolia USDC) ✅
4. x402 server verifies + settles on-chain (`txHash` confirmed) ✅
5. Fan receives "Payment confirmed!" Telegram message with `txHash` ✅
6. Influencer receives "New paid shoutout request" via `@the_interns_bot` ✅

---

## 12. Agent-to-Agent Discovery

- `GET https://api.interns.bot/` returns JSON list of all active influencer agents
- `GET https://api.interns.bot/agents/:handle` returns full service catalog with endpoints, prices, payment requirements
- `GET https://api.interns.bot/.well-known/x402.json` — machine-readable x402 discovery
- AI agents can autonomously discover, pay, and consume intern bot services without human involvement

---

## 13. Submission Preparation (Synthesis Hackathon)

**Prizes identified as eligible:**
- Bankr — primary integration (LLM gateway + bankr wallet payments)
- x402 / Coinbase — x402 payment protocol, agent-to-agent flow
- MoonPay — potential addition for fiat on-ramp (card/Apple Pay for non-crypto fans)
- OpenClaw — core platform

**Submission materials produced:**
- `PITCH.md` — 10-slide deck outline (problem, solution, x402, agent economy, revenue model, roadmap)
- `index.html` — landing page with CTAs for creators and fans, links to `@the_interns_bot` and demo bots
- Video script (3-min demo walkthrough) covering: onboarding flow, fan experience, payment confirmation, agent discovery
- Moltbook post drafted and published (link to repo, track descriptions, project overview)

---

## 14. Key Files

- `/opt/interns/bootstrap.sh` — full VPS setup: installs OpenClaw, bun, configures systemd, sets env
- `/opt/interns/x402-server.ts` — x402 payment server (moved to repo root from scripts/)
- `/opt/interns/the-interns-bot/SKILL.md` — central bot skill (onboarding + management)
- `/opt/interns/influencers/<handle>-intern/` — per-influencer workspace
- `/opt/interns/scripts/provision-agent.ts` — provisions a new influencer agent
- `/opt/interns/scripts/set-admins-commands.ts` — registers slash commands for `@the_interns_bot`
- `/opt/interns/scripts/set-fans-commands.ts` — registers slash commands for all fan-facing bots
- `/opt/interns/scripts/create-payment-session.ts` — called by fan bot SKILL to create x402 session
- `/opt/interns/state/sessions/` — per-payment session files (fan message, chat IDs, service type)
- `/opt/interns/README.md` — ops guide (bootstrap, update, re-provision, x402 notes)
- `/opt/interns/PITCH.md` — hackathon pitch deck outline
- `/opt/interns/index.html` — landing page

---

## 15. Environment Variables (redacted)

```
THE_INTERNS_BOT_TOKEN=[BOT_TOKEN]
BANKR_API_KEY=[API_KEY]
ANTHROPIC_API_KEY=[API_KEY]          # same value as BANKR_API_KEY
ANTHROPIC_BASE_URL=https://llm.bankr.bot
X402_BASE_URL=https://api.interns.bot
X402_NETWORK=base-sepolia
X402_FACILITATOR_URL=https://x402.org/facilitator
CDP_CLIENT_KEY=[API_KEY]             # Coinbase Developer Platform (OnchainKit)
TELEGRAM_BOT_TOKEN=[BOT_TOKEN]       # same as THE_INTERNS_BOT_TOKEN, used by x402 server
```
