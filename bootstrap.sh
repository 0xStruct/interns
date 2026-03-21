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

# ---------------------------------------------------------
# 6. Configure OpenClaw
#
# Order matters:
#   a) doctor --repair  — creates ~/.openclaw, sessions dir, installs systemd service
#   b) config set gateway.mode local  — required or gateway refuses to start
#   c) fix telegram plugin in JSON  — the CLI `enable` command writes the wrong key
#   d) configure bankr LLM gateway as a named provider + set agent default model
#      IMPORTANT: setting ANTHROPIC_API_KEY env var only configures the built-in
#      Anthropic provider (api.anthropic.com). bankr uses a different base URL and
#      a bk_... key, so it must be declared as a separate provider in openclaw.json.
#   e) loginctl enable-linger  — keeps user systemd services alive after SSH logout
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

# 6c. Enable telegram plugin directly in JSON.
#     IMPORTANT: `openclaw plugins enable telegram` has a known bug — it writes
#     "@openclaw/telegram" (npm package name) as the key instead of "telegram"
#     (the plugin ID). This causes "Unknown channel: telegram" even after enabling.
#     Directly editing the JSON is the reliable fix.
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

# ── bankr LLM gateway provider ───────────────────────────────────────────────
# ANTHROPIC_API_KEY env var only reaches the built-in Anthropic provider.
# bankr needs its own named provider block pointing at llm.bankr.bot, with the
# bk_... key inline. The agent default must reference "bankr/claude-sonnet-4-5"
# so requests are routed through the bankr gateway instead of api.anthropic.com.
bankr_key = os.environ.get("BANKR_API_KEY", "")
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
                "id": "claude-sonnet-4-5",
                "name": "Claude Sonnet 4.5",
                "contextWindow": 200000,
                "maxTokens": 16000,
                "api": "anthropic-messages",
                "cost": {"input": 3.0, "output": 15.0}
            }
        ]
    }
    # Set as default model for all agents
    agents_cfg = cfg.setdefault("agents", {})
    agents_cfg.setdefault("defaults", {}).setdefault("model", {})["primary"] = "bankr/claude-sonnet-4-5"
    print("  bankr LLM provider: configured (model: bankr/claude-sonnet-4-5)")
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

# 6d. Keep user systemd services alive after SSH logout
loginctl enable-linger root 2>/dev/null || true

# 6e. Ensure bun is in PATH for the OpenClaw systemd service.
#     Without this, SKILL.md commands like `bun run ...` fail silently
#     because systemd services don't inherit the user's shell PATH.
SYSTEMD_DROP_IN="$HOME/.config/systemd/user/openclaw-gateway.service.d/env.conf"
mkdir -p "$(dirname "$SYSTEMD_DROP_IN")"
if ! grep -q 'BUN_INSTALL' "$SYSTEMD_DROP_IN" 2>/dev/null; then
  cat >> "$SYSTEMD_DROP_IN" << 'ENVEOF'
Environment=PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENVEOF
  systemctl --user daemon-reload 2>/dev/null || true
  ok "Bun added to systemd service PATH"
else
  ok "Bun already in systemd service PATH"
fi

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
  bun run "$INTERNS_DIR/the-interns-bot/scripts/set-commands.ts" \
    --token "$THE_INTERNS_BOT_TOKEN" \
    --type management \
  && ok "Slash commands registered" \
  || warn "set-commands.ts failed — run manually: bun run $INTERNS_DIR/the-interns-bot/scripts/set-commands.ts --token \$THE_INTERNS_BOT_TOKEN --type management"
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
echo "    1. DM @the_interns_bot on Telegram — it should reply"
echo "    2. Update code:  cd $INTERNS_DIR && git pull && bun install && openclaw gateway restart"
echo "    3. View logs:    journalctl --user -u openclaw-gateway.service -f"
echo ""
echo "  Troubleshooting:"
echo "    openclaw gateway status"
echo "    openclaw channels list"
echo "    openclaw agents list"
echo "=================================================="
