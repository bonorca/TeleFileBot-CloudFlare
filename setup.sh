#!/usr/bin/env bash
# =============================================================================
# TeleFileBot — One-Click Setup Script
# =============================================================================
# This script will:
#   1. Check prerequisites (Node.js, npm, wrangler)
#   2. Install dependencies
#   3. Create a Cloudflare D1 database
#   4. Initialize the database schema
#   5. Collect and set secrets (BOT_TOKEN, BOT_SECRET, CHANNEL_ID, ADMIN_ID)
#   6. Deploy the Worker
#   7. Register the Telegram webhook
# =============================================================================

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# --- Helpers ---
info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✔${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✖${NC}  $*"; exit 1; }
step()    { echo -e "\n${CYAN}${BOLD}▸ $*${NC}"; }

# --- Banner ---
echo -e "${BOLD}"
cat << 'EOF'

  ╔═══════════════════════════════════════╗
  ║   📦 TeleFileBot — Setup     ║
  ╚═══════════════════════════════════════╝

EOF
echo -e "${NC}"

# =============================================================================
#  Step 1: Check prerequisites
# =============================================================================
step "Step 1/7: Checking prerequisites..."

command -v node  >/dev/null 2>&1 || error "Node.js is required. Install it from https://nodejs.org"
command -v npm   >/dev/null 2>&1 || error "npm is required. Install it with Node.js."

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  error "Node.js >= 18 required (found $(node -v)). Please upgrade."
fi
success "Node.js $(node -v)"

# Check or install wrangler
if ! command -v wrangler >/dev/null 2>&1; then
  warn "Wrangler CLI not found. Installing globally..."
  npm install -g wrangler
fi
success "Wrangler $(wrangler --version 2>/dev/null | head -1)"

# =============================================================================
#  Step 2: Install dependencies
# =============================================================================
step "Step 2/7: Installing dependencies..."

if [ ! -f "package.json" ]; then
  npm init -y > /dev/null 2>&1
fi
npm install --save-dev wrangler > /dev/null 2>&1
success "Dependencies installed"

# =============================================================================
#  Step 3: Cloudflare login check
# =============================================================================
step "Step 3/7: Checking Cloudflare authentication..."

if ! wrangler whoami >/dev/null 2>&1; then
  info "Please log in to Cloudflare:"
  wrangler login
fi
success "Authenticated with Cloudflare"

# =============================================================================
#  Step 4: Create D1 database
# =============================================================================
step "Step 4/7: Setting up D1 database..."

DB_NAME="telefilebot-cloudflare-db"

# Check if database already exists
EXISTING_DB=$(wrangler d1 list 2>/dev/null | grep "$DB_NAME" | head -1 || true)

if [ -n "$EXISTING_DB" ]; then
  info "Database '$DB_NAME' already exists."
  DB_ID=$(echo "$EXISTING_DB" | awk '{print $1}')
else
  info "Creating D1 database '$DB_NAME'..."
  CREATE_OUTPUT=$(wrangler d1 create "$DB_NAME" 2>&1)
  DB_ID=$(echo "$CREATE_OUTPUT" | grep -oP '"database_id":\s*"\K[^"]+' || \
          echo "$CREATE_OUTPUT" | grep -oP 'database_id\s*=\s*"\K[^"]+' || \
          echo "$CREATE_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
fi

if [ -z "${DB_ID:-}" ]; then
  error "Failed to extract database ID. Please create it manually:\n  wrangler d1 create $DB_NAME"
fi

success "Database ID: $DB_ID"

# Update wrangler.jsonc with the real database ID
if [ -f "wrangler.jsonc" ]; then
  sed -i "s/YOUR_DATABASE_ID_HERE/$DB_ID/g" wrangler.jsonc
  success "Updated wrangler.jsonc"
fi

# Initialize schema
info "Applying database schema..."
wrangler d1 execute "$DB_NAME" --file=schema.sql --remote 2>/dev/null || \
  wrangler d1 execute "$DB_NAME" --file=schema.sql 2>/dev/null || \
  warn "Schema may need to be applied manually: wrangler d1 execute $DB_NAME --file=schema.sql --remote"
success "Database schema applied"

# =============================================================================
#  Step 5: Collect secrets
# =============================================================================
step "Step 5/7: Configuring secrets..."

echo ""
echo -e "${BOLD}You'll need the following information:${NC}"
echo "  1. Bot Token     — from @BotFather on Telegram"
echo "  2. Channel ID    — your private channel ID (e.g. -100xxxxxxxxxx)"
echo "  3. Admin ID      — your Telegram user ID (get from @userinfobot)"
echo ""

# BOT_TOKEN
read -rp "$(echo -e "${CYAN}Enter your Bot Token:${NC} ")" BOT_TOKEN
if [ -z "$BOT_TOKEN" ]; then
  error "Bot Token cannot be empty."
fi

# Validate token format
if [[ ! "$BOT_TOKEN" =~ ^[0-9]+:[a-zA-Z0-9_-]+$ ]]; then
  warn "Token format looks unusual. Continuing anyway..."
fi

# CHANNEL_ID
read -rp "$(echo -e "${CYAN}Enter your Channel ID:${NC} ")" CHANNEL_ID
if [ -z "$CHANNEL_ID" ]; then
  error "Channel ID cannot be empty."
fi

# ADMIN_ID
read -rp "$(echo -e "${CYAN}Enter your Admin (Telegram User) ID:${NC} ")" ADMIN_ID
if [ -z "$ADMIN_ID" ]; then
  error "Admin ID cannot be empty."
fi

# Generate random BOT_SECRET
BOT_SECRET=$(openssl rand -hex 32 2>/dev/null || \
             head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 64 || \
             date +%s%N | sha256sum | head -c 64)

info "Generated random webhook secret."

# Set secrets
echo "$BOT_TOKEN"  | wrangler secret put BOT_TOKEN  2>/dev/null
echo "$BOT_SECRET" | wrangler secret put BOT_SECRET 2>/dev/null
echo "$CHANNEL_ID" | wrangler secret put CHANNEL_ID 2>/dev/null
echo "$ADMIN_ID"   | wrangler secret put ADMIN_ID   2>/dev/null
success "All secrets configured"

# =============================================================================
#  Step 6: Deploy
# =============================================================================
step "Step 6/7: Deploying to Cloudflare Workers..."

DEPLOY_OUTPUT=$(wrangler deploy 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract worker URL
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oP 'https://[^\s]+\.workers\.dev' | head -1 || true)

if [ -z "$WORKER_URL" ]; then
  WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oP 'https://[^\s]+' | head -1 || true)
fi

if [ -z "$WORKER_URL" ]; then
  error "Could not determine worker URL. Deploy may have failed."
fi

success "Deployed to: $WORKER_URL"

# =============================================================================
#  Step 7: Register webhook
# =============================================================================
step "Step 7/7: Registering Telegram webhook..."

WEBHOOK_RESULT=$(curl -s "${WORKER_URL}/registerWebhook")
echo "$WEBHOOK_RESULT"

if echo "$WEBHOOK_RESULT" | grep -q '"ok":true'; then
  success "Webhook registered successfully!"
else
  warn "Webhook registration response above. Check if it succeeded."
fi

# =============================================================================
#  Done!
# =============================================================================
echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  🎉 Setup complete!                       ${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Worker URL:${NC}  $WORKER_URL"
echo -e "  ${BOLD}Health:${NC}      $WORKER_URL/health"
echo ""
echo -e "  Open your bot on Telegram and send ${BOLD}/start${NC} to begin!"
echo ""
echo -e "  ${YELLOW}Useful commands:${NC}"
echo "    wrangler tail              — View live logs"
echo "    wrangler secret list       — List configured secrets"
echo "    wrangler d1 execute $DB_NAME --command 'SELECT COUNT(*) FROM files' --remote"
echo ""