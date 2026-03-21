#!/usr/bin/env bash
# bootstrap.sh — fresh VPS setup for The Interns Bot
# Run as root on a clean Ubuntu 24.04 droplet:
#   bash <(curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/interns/main/bootstrap.sh)
# Or after cloning:
#   sudo bash /opt/interns/bootstrap.sh

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/YOUR_REPO/interns.git}"
INTERNS_DIR="${INTERNS_DIR:-/opt/interns}"
NODE_VERSION="${NODE_VERSION:-22}"

log()  { echo -e "\n\033[1;34m▶ $*\033[0m"; }
ok()   { echo -e "\033[1;32m✔ $*\033[0m"; }
warn() { echo -e "\033[1;33m⚠ $*\033[0m"; }
die()  { echo -e "\033[1;31m✘ $*\033[0m"; exit 1; }

# ─────────────────────────────────────────────
# 1. System packages
# ─────────────────────────────────────────────
log "Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq
apt-get install -y -qq git curl wget python3 python3-pip unzip jq

ok "System packages ready"

# ─────────────────────────────────────────────
# 2. Node.js (via NodeSource)
# ─────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])')" -lt "$NODE_VERSION" ]]; then
  log "Installing Node.js $NODE_VERSION..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y nodejs
  ok "Node.js $(node --version) installed"
else
  ok "Node.js $(node --version) already installed"
fi

# ─────────────────────────────────────────────
# 3. Bun
# ─────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  log "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  # Make bun available in current shell
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  ok "Bun $(bun --version) installed"
else
  ok "Bun $(bun --version) already installed"
fi

# Ensure bun is in PATH for future logins
if ! grep -q 'BUN_INSTALL' ~/.bashrc; then
  echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.bashrc
  echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bashrc
fi

# ─────────────────────────────────────────────
# 4. yt-dlp
# ─────────────────────────────────────────────
log "Installing yt-dlp..."
pip3 install -q --upgrade yt-dlp 2>/dev/null || warn "pip3 install yt-dlp failed — YouTube transcript scraping may not work"
ok "yt-dlp ready"

# ─────────────────────────────────────────────
# 5. OpenClaw
# ─────────────────────────────────────────────
if ! command -v openclaw &>/dev/null; then
  log "Installing OpenClaw..."
  npm install -g openclaw
  ok "OpenClaw $(openclaw --version 2>/dev/null | head -1 || echo 'installed')"
else
  ok "OpenClaw already installed"
fi

# ─────────────────────────────────────────────
# 6. Configure OpenClaw
# ─────────────────────────────────────────────
log "Configuring OpenClaw..."

# Set gateway mode to local (required — gateway won't start without this)
openclaw config set gateway.mode local

# Enable linger so user-level systemd services survive after SSH logout
loginctl enable-linger root 2>/dev/null || true

# Run doctor to fix permissions, install systemd service, etc.
openclaw doctor --repair 2>/dev/null || true

# Enable the telegram plugin by directly writing the config
# (openclaw plugins enable telegram can be unreliable on first run)
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
if [[ -f "$OPENCLAW_CONFIG" ]]; then
  # Use python3 to safely merge the telegram plugin entry
  python3 - <<PYEOF
import json, sys

with open("$OPENCLAW_CONFIG") as f:
    cfg = json.load(f)

cfg.setdefault("plugins", {}).setdefault("entries", {})

# Remove stale @openclaw/telegram entry if present
cfg["plugins"]["entries"].pop("@openclaw/telegram", None)

# Enable telegram by ID
cfg["plugins"]["entries"]["telegram"] = {"enabled": True}

with open("$OPENCLAW_CONFIG", "w") as f:
    json.dump(cfg, f, indent=2)

print("✔ telegram plugin enabled in openclaw.json")
PYEOF
else
  warn "$OPENCLAW_CONFIG not found — openclaw doctor may not have run yet"
fi

ok "OpenClaw configured"

# ─────────────────────────────────────────────
# 7. Start OpenClaw gateway
# ─────────────────────────────────────────────
log "Starting OpenClaw gateway..."
openclaw gateway restart 2>/dev/null || openclaw gateway start 2>/dev/null || true
sleep 3

if openclaw gateway status 2>/dev/null | grep -q "running"; then
  ok "OpenClaw gateway is running"
else
  warn "Gateway may not be running yet — check: openclaw gateway status"
fi

# ─────────────────────────────────────────────
# 8. Clone / update project
# ─────────────────────────────────────────────
if [[ -d "$INTERNS_DIR/.git" ]]; then
  log "Pulling latest code from git..."
  cd "$INTERNS_DIR"
  git pull --ff-only
  ok "Code updated"
elif [[ "$REPO_URL" != *"YOUR_REPO"* ]]; then
  log "Cloning repo to $INTERNS_DIR..."
  git clone "$REPO_URL" "$INTERNS_DIR"
  cd "$INTERNS_DIR"
  ok "Repo cloned"
else
  warn "Skipping git clone — REPO_URL not set. Copy your project to $INTERNS_DIR manually."
  mkdir -p "$INTERNS_DIR"
  cd "$INTERNS_DIR"
fi

# ─────────────────────────────────────────────
# 9. Install project dependencies
# ─────────────────────────────────────────────
if [[ -f "$INTERNS_DIR/package.json" ]]; then
  log "Installing project dependencies..."
  cd "$INTERNS_DIR"
  bun install
  ok "Dependencies installed"
fi

# ─────────────────────────────────────────────
# 10. .env setup
# ─────────────────────────────────────────────
if [[ ! -f "$INTERNS_DIR/.env" ]]; then
  if [[ -f "$INTERNS_DIR/.env.example" ]]; then
    cp "$INTERNS_DIR/.env.example" "$INTERNS_DIR/.env"
    warn ".env created from .env.example — fill it in before registering the bot:"
    warn "  nano $INTERNS_DIR/.env"
  else
    warn "No .env.example found — create $INTERNS_DIR/.env manually"
  fi
else
  ok ".env already exists"
fi

# ─────────────────────────────────────────────
# 11. Register management bot in OpenClaw
# ─────────────────────────────────────────────
if [[ -f "$INTERNS_DIR/.env" ]]; then
  set -a
  source "$INTERNS_DIR/.env"
  set +a
fi

if [[ -z "${THE_INTERNS_BOT_TOKEN:-}" ]]; then
  warn "THE_INTERNS_BOT_TOKEN is not set — skipping OpenClaw bot registration."
  warn "Once you fill in .env, run:"
  warn "  source $INTERNS_DIR/.env"
  warn "  openclaw channels add --channel telegram --token \"\$THE_INTERNS_BOT_TOKEN\" --account the-interns-bot --name 'The Interns Bot'"
  warn "  openclaw agents add the-interns-bot --workspace $INTERNS_DIR/the-interns-bot --bind telegram:the-interns-bot --non-interactive --json"
else
  log "Registering management bot in OpenClaw..."

  # Register Telegram channel
  if openclaw channels add \
      --channel telegram \
      --token "$THE_INTERNS_BOT_TOKEN" \
      --account the-interns-bot \
      --name "The Interns Bot" 2>&1; then
    ok "Telegram channel registered"
  else
    warn "Channel registration failed — try manually after checking: openclaw gateway status"
  fi

  # Register agent
  if openclaw agents add the-interns-bot \
      --workspace "$INTERNS_DIR/the-interns-bot" \
      --bind "telegram:the-interns-bot" \
      --non-interactive \
      --json 2>&1; then
    ok "Management bot agent registered"
  else
    warn "Agent registration failed — try manually"
  fi
fi

# ─────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Bootstrap complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Next steps:"
echo "  1. Fill in your env vars:   nano $INTERNS_DIR/.env"
echo "  2. Re-run registration:     bash $INTERNS_DIR/bootstrap.sh"
echo "     (safe to run again — it skips already-done steps)"
echo ""
echo "  Verify:"
echo "    openclaw gateway status"
echo "    openclaw channels list"
echo "    openclaw agents list"
echo ""
echo "  Logs:"
echo "    journalctl --user -u openclaw-gateway.service -f"
echo ""
