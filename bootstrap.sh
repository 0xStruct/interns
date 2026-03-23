#!/usr/bin/env bash
# bootstrap.sh — idempotent setup script for The Interns Bot on a fresh Ubuntu VPS
# Run as root on a clean Ubuntu 24.04 droplet:
#
#   Option A — clone first, then bootstrap:
#     cd /opt && git clone https://github.com/0xstruct/interns.git && cd interns
#     cp .env.example .env && nano .env   # fill in vars
#     bash bootstrap.sh
#
#   Option B — one-liner (pulls repo for you):
#     REPO_URL=https://github.com/0xstruct/interns.git bash <(curl -fsSL https://raw.githubusercontent.com/0xstruct/interns/main/bootstrap.sh)
#
# Safe to re-run after pulling new code or changing .env

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/0xstruct/interns.git}"
INTERNS_DIR="${INTERNS_DIR:-/opt/interns}"
NODE_VERSION="${NODE_VERSION:-22}"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"

log()  { echo -e "\n\033[1;34m>> $*\033[0m"; }
ok()   { echo -e "\033[1;32m[OK] $*\033[0m"; }
warn() { echo -e "\033[1;33m[WARN] $*\033[0m"; }
die()  { echo -e "\033[1;31m[ERR] $*\033[0m"; exit 1; }

# ---------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------
log "Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get upgrade -y -qq
apt-get install -y -qq git curl wget python3 python3-pip unzip jq
ok "System packages ready"

# ---------------------------------------------------------
# 2. Node.js (via NodeSource)
# ---------------------------------------------------------
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])')" -lt "$NODE_VERSION" ]]; then
  log "Installing Node.js $NODE_VERSION..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y nodejs
  ok "Node.js $(node --version) installed"
else
  ok "Node.js $(node --version) already installed"
fi

# ---------------------------------------------------------
# 3. Bun
# ---------------------------------------------------------
if ! command -v bun &>/dev/null; then
  log "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  ok "Bun $(bun --version) installed"
else
  ok "Bun $(bun --version) already installed"
fi

# Ensure bun is in PATH for future logins
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! grep -q 'BUN_INSTALL' ~/.bashrc 2>/dev/null; then
  echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.bashrc
  echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bashrc
fi

# ---------------------------------------------------------
# 4. yt-dlp
# ---------------------------------------------------------
log "Installing yt-dlp..."
pip3 install -q --upgrade yt-dlp 2>/dev/null || warn "pip3 install yt-dlp failed — YouTube transcript scraping may not work"
ok "yt-dlp ready"

# ---------------------------------------------------------
# 5. OpenClaw
# ---------------------------------------------------------
if ! command -v openclaw &>/dev/null; then
  log "Installing OpenClaw..."
  npm install -g openclaw
  ok "OpenClaw installed"
else
  ok "OpenClaw already installed"
fi

if ! command -v bankr &>/dev/null; then
  log "Installing Bankr CLI..."
  npm install -g @bankr/cli
  ok "Bankr CLI installed"
else
  ok "Bankr CLI already installed"
fi

# ---------------------------------------------------------
# 6. Configure OpenClaw
#
# Order matters:
#   a) doctor --repair  — creates ~/.openclaw, sessions dir, installs systemd service
#   b) config set gateway.mode local  — required or gateway refuses to start
#   c) fix telegram plugin in JSON  — the CLI `enable` command writes the wrong key
#   d) set dmPolicy to "open" with allowFrom: ["*"] for public bots
#   e) configure bankr LLM gateway as a named provider + set agent default model
#      IMPORTANT: setting ANTHROPIC_API_KEY env var only configures the built-in
#      Anthropic provider (api.anthropic.com). bankr uses a different base URL and
#      a bk_... key, so it must be declared as a separate provider in openclaw.json.
#   f) loginctl enable-linger  — keeps user systemd services alive after SSH logout
#   g) set bun in PATH for systemd service (so SOUL.md bun run commands work)
#   h) set global workspace SOUL.md to defer to agent workspace files
#
# Load .env early so BANKR_API_KEY and other vars are available for OpenClaw config.
# (Full .env setup/creation happens in step 10; this just pre-loads if the file exists.)
if [[ -f "$INTERNS_DIR/.env" ]]; then
  set -o allexport
  # shellcheck source=/dev/null
  source "$INTERNS_DIR/.env"
  set +o allexport
fi

# ---------------------------------------------------------
log "Configuring OpenClaw..."

# 6a. Repair (creates config dir, sessions dir, systemd service)
openclaw doctor --repair 2>&1 | grep -E '(Created|Tightened|Installed|CRITICAL)' || true

# 6b. Set gateway mode
openclaw config set gateway.mode local

# 6c–e. Enable telegram plugin, set dmPolicy, configure bankr provider — all in one JSON edit
if [[ -f "$OPENCLAW_CONFIG" ]]; then
  python3 - <<PYEOF
import json, os

with open("$OPENCLAW_CONFIG") as f:
    cfg = json.load(f)

# ── Telegram plugin ──────────────────────────────────────────────────────────
entries = cfg.setdefault("plugins", {}).setdefault("entries", {})
if "@openclaw/telegram" in entries:
    del entries["@openclaw/telegram"]
    print("  Removed stale @openclaw/telegram entry")
entries["telegram"] = {"enabled": True}
print("  telegram plugin: enabled")

# ── DM policy: open (public bots, no pairing wall) ──────────────────────────
tg = cfg.setdefault("channels", {}).setdefault("telegram", {})
tg["dmPolicy"] = "open"
tg["allowFrom"] = ["*"]
print("  dmPolicy: open (allowFrom: *)")

# ── bankr LLM gateway provider ───────────────────────────────────────────────
bankr_key = os.environ.get("BANKR_API_KEY", "")
llm_model = os.environ.get("LLM_MODEL", "gemini-3-flash")
if bankr_key:
    models_cfg = cfg.setdefault("models", {})
    models_cfg["mode"] = "merge"
    providers = models_cfg.setdefault("providers", {})
    providers["bankr"] = {
        "baseUrl": "https://llm.bankr.bot",
        "apiKey": bankr_key,
        "api": "anthropic-messages",
        "models": [
            {
                "id": "gemini-3-flash",
                "name": "Gemini 3 Flash",
                "contextWindow": 1000000,
                "maxTokens": 8192,
                "api": "anthropic-messages",
                "cost": {"input": 0.15, "output": 0.60}
            },
            {
                "id": "claude-sonnet-4-5",
                "name": "Claude Sonnet 4.5",
                "contextWindow": 200000,
                "maxTokens": 16000,
                "api": "anthropic-messages",
                "cost": {"input": 3.0, "output": 15.0}
            },
            {
                "id": "claude-haiku-3-5",
                "name": "Claude Haiku 3.5",
                "contextWindow": 200000,
                "maxTokens": 8192,
                "api": "anthropic-messages",
                "cost": {"input": 0.25, "output": 1.25}
            }
        ]
    }
    # Set default model (configurable via LLM_MODEL env var)
    agents_cfg = cfg.setdefault("agents", {})
    agents_cfg.setdefault("defaults", {}).setdefault("model", {})["primary"] = f"bankr/{llm_model}"
    print(f"  bankr LLM provider: configured (model: bankr/{llm_model})")
else:
    print("  WARN: BANKR_API_KEY not set — bankr LLM provider not configured")
    print("        Set BANKR_API_KEY in .env and re-run bootstrap.sh")

with open("$OPENCLAW_CONFIG", "w") as f:
    json.dump(cfg, f, indent=2)
PYEOF
else
  warn "$OPENCLAW_CONFIG not found after doctor --repair — something went wrong"
  exit 1
fi

# 6f. Keep user systemd services alive after SSH logout
loginctl enable-linger root 2>/dev/null || true

# 6g. Ensure bun is in PATH for the OpenClaw systemd service.
#     Without this, SOUL.md commands like `bun run ...` fail silently
#     because systemd services don't inherit the user's shell PATH.
#     We write the FULL env.conf each time (idempotent) to avoid duplicate lines.
SYSTEMD_DROP_IN="$HOME/.config/systemd/user/openclaw-gateway.service.d/env.conf"
mkdir -p "$(dirname "$SYSTEMD_DROP_IN")"
cat > "$SYSTEMD_DROP_IN" << 'ENVEOF'
[Service]
Environment=PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENVEOF
systemctl --user daemon-reload 2>/dev/null || true
ok "Systemd PATH configured"

# 6h. Set global workspace SOUL.md to defer to agent workspace files.
#     OpenClaw reads SOUL.md (NOT SKILL.md) as the system prompt.
#     The global workspace SOUL.md is included for ALL agents, so we make it
#     minimal — each agent's workspace SOUL.md provides the real instructions.
GLOBAL_WORKSPACE="$HOME/.openclaw/workspace"
mkdir -p "$GLOBAL_WORKSPACE"
cat > "$GLOBAL_WORKSPACE/SOUL.md" << 'EOF'
# SOUL.md
You are an AI assistant. Follow your workspace SOUL.md for specific instructions.
Be helpful, direct, and concise.
EOF

cat > "$GLOBAL_WORKSPACE/AGENTS.md" << 'EOF'
# AGENTS.md
Follow your workspace SOUL.md. That is your complete instruction set.
Do not run bootstrap sequences, do not update memory files.
EOF

printf '# Initialized\n' > "$GLOBAL_WORKSPACE/BOOTSTRAP.md"
printf '# See SOUL.md\n' > "$GLOBAL_WORKSPACE/IDENTITY.md"

ok "OpenClaw configured"

# ---------------------------------------------------------
# 7. Start OpenClaw gateway
# ---------------------------------------------------------
log "Starting OpenClaw gateway..."

# Stop any stale process on port 18789 before starting
STALE_PID=$(ss -tlnp 2>/dev/null | grep ':18789' | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [[ -n "$STALE_PID" ]]; then
  warn "Killing stale process on port 18789 (pid $STALE_PID)..."
  kill "$STALE_PID" 2>/dev/null || true
  sleep 2
fi

openclaw gateway start 2>/dev/null || openclaw gateway restart 2>/dev/null || true

# Wait up to 30 seconds for the gateway to be healthy
READY=0
for i in {1..15}; do
  if openclaw gateway status 2>/dev/null | grep -q "RPC probe: ok"; then
    READY=1
    break
  fi
  sleep 2
done

if [[ $READY -eq 1 ]]; then
  ok "OpenClaw gateway is running and healthy"
else
  warn "Gateway may not be ready — check: openclaw gateway status"
  warn "Logs: journalctl --user -u openclaw-gateway.service -n 50 --no-pager"
fi

# ---------------------------------------------------------
# 8. Clone / update project
# ---------------------------------------------------------
if [[ -d "$INTERNS_DIR/.git" ]]; then
  log "Pulling latest code..."
  cd "$INTERNS_DIR"
  git pull --ff-only 2>/dev/null || warn "git pull skipped (local changes or already up to date)"
  ok "Code up to date"
else
  log "Cloning repo to $INTERNS_DIR..."
  git clone "$REPO_URL" "$INTERNS_DIR"
  cd "$INTERNS_DIR"
  ok "Repo cloned"
fi

# ---------------------------------------------------------
# 9. Install project dependencies
# ---------------------------------------------------------
log "Installing project dependencies..."
cd "$INTERNS_DIR"
bun install
ok "Dependencies installed"

# ---------------------------------------------------------
# 10. .env setup
# ---------------------------------------------------------
if [[ ! -f "$INTERNS_DIR/.env" ]]; then
  cp "$INTERNS_DIR/.env.example" "$INTERNS_DIR/.env"
  warn ".env created from .env.example"
  warn "Fill it in now:  nano $INTERNS_DIR/.env"
  warn "Then re-run:     bash $INTERNS_DIR/bootstrap.sh"
  exit 0
fi

ok ".env already exists"

# Load .env
set -o allexport
# shellcheck source=/dev/null
source "$INTERNS_DIR/.env"
set +o allexport

# ---------------------------------------------------------
# 11. Register management bot in OpenClaw
# ---------------------------------------------------------
if [[ -z "${THE_INTERNS_BOT_TOKEN:-}" ]]; then
  warn "THE_INTERNS_BOT_TOKEN not set in .env — skipping bot registration"
  warn "Once filled in, re-run: bash $INTERNS_DIR/bootstrap.sh"
else
  # Check if already registered
  if openclaw channels list 2>/dev/null | grep -q "the-interns-bot"; then
    ok "@the_interns_bot already registered in OpenClaw — skipping"
  else
    log "Registering @the_interns_bot Telegram channel..."
    openclaw channels add \
      --channel telegram \
      --token "$THE_INTERNS_BOT_TOKEN" \
      --account the-interns-bot \
      --name "The Interns Bot"

    log "Adding management bot agent..."
    openclaw agents add the-interns-bot \
      --workspace "$INTERNS_DIR/the-interns-bot" \
      --bind "telegram:the-interns-bot" \
      --non-interactive \
      --json

    ok "@the_interns_bot registered and bound"
  fi

  # Register slash commands with Telegram (idempotent — safe to re-run)
  log "Setting Telegram slash commands for @the_interns_bot..."
  bun run "$INTERNS_DIR/the-interns-bot/scripts/set-admins-commands.ts" \
    --token "$THE_INTERNS_BOT_TOKEN" \
  && ok "Slash commands registered" \
  || warn "set-admins-commands.ts failed — run manually: bun run $INTERNS_DIR/the-interns-bot/scripts/set-admins-commands.ts"

  # Refresh fan-facing slash commands for any already-provisioned bots
  if [[ -d "$INTERNS_DIR/influencers" ]] && ls "$INTERNS_DIR/influencers"/*/DATA.md &>/dev/null; then
    log "Refreshing fan bot slash commands..."
    bun run "$INTERNS_DIR/the-interns-bot/scripts/set-fans-commands.ts" \
    && ok "Fan bot commands updated" \
    || warn "set-fans-commands.ts failed — run manually: bun run $INTERNS_DIR/the-interns-bot/scripts/set-fans-commands.ts"
  fi
fi

# ---------------------------------------------------------
# 11b. x402 payment server (systemd user service)
# ---------------------------------------------------------
log "Setting up x402 payment server..."

X402_SERVICE="$HOME/.config/systemd/user/interns-x402.service"
_X402_PORT="${X402_PORT:-4402}"
_X402_BASE_URL="${X402_BASE_URL:-http://localhost:${_X402_PORT}}"

mkdir -p "$(dirname "$X402_SERVICE")"
cat > "$X402_SERVICE" << SVCEOF
[Unit]
Description=interns.bot x402 Payment Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${INTERNS_DIR}
EnvironmentFile=${INTERNS_DIR}/.env
Environment=PATH=${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${HOME}/.bun/bin/bun run ${INTERNS_DIR}/x402-server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SVCEOF

systemctl --user daemon-reload
systemctl --user enable interns-x402.service 2>/dev/null || true
systemctl --user restart interns-x402.service 2>/dev/null || true
sleep 2
if systemctl --user is-active interns-x402.service &>/dev/null; then
  ok "x402 server running on port ${_X402_PORT} — discovery: ${_X402_BASE_URL}/"
else
  warn "x402 server failed to start — check: journalctl --user -u interns-x402.service -n 20"
fi

# ---------------------------------------------------------
# 12. Clear stale sessions + restart gateway
#     After code updates, old conversation sessions may have
#     cached bot behavior that conflicts with new SOUL.md.
#     Clearing sessions forces a fresh start with new instructions.
# ---------------------------------------------------------
log "Clearing stale sessions and restarting gateway..."
# Clear ALL agent sessions — after code updates, old conversation history
# may have cached bot behavior that conflicts with new SOUL.md instructions.
for _sess_dir in "$HOME/.openclaw/agents"/*/sessions; do
  if [[ -d "$_sess_dir" ]]; then
    rm -f "$_sess_dir"/*.jsonl "$_sess_dir"/sessions.json
  fi
done
ok "Stale sessions cleared (all agents)"

openclaw gateway restart 2>/dev/null || true

# Wait for healthy restart
sleep 3
if openclaw gateway status 2>/dev/null | grep -q "RPC probe: ok"; then
  ok "Gateway restarted and healthy"
else
  warn "Gateway may need a moment — check: openclaw gateway status"
fi

# ---------------------------------------------------------
# Done
# ---------------------------------------------------------
echo ""
echo "=================================================="
echo "  Bootstrap complete!"
echo "=================================================="
echo ""
echo "  Gateway:  $(openclaw gateway status 2>/dev/null | grep 'Runtime:' | sed 's/.*Runtime: //' | xargs || echo 'unknown')"
echo "  Agents:   $(openclaw agents list 2>/dev/null | grep -c '^\-' || echo 0) registered"
echo ""
echo "  Next steps:"
echo "    1. DM @the_interns_bot on Telegram — it should reply with the onboarding flow"
echo "    2. Update code:  cd $INTERNS_DIR && git pull && bun install && bash bootstrap.sh"
echo "    3. Gateway logs: journalctl --user -u openclaw-gateway.service -f"
echo "    4. x402 logs:    journalctl --user -u interns-x402.service -f"
echo "    5. x402 API:     curl \${X402_BASE_URL:-http://localhost:4402}/"
echo ""
echo "  Troubleshooting:"
echo "    openclaw gateway status"
echo "    openclaw channels list"
echo "    openclaw agents list --bindings"
echo "=================================================="
