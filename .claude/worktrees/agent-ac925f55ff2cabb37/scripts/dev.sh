#!/bin/bash
# Development startup script
# Starts Cloudflare Tunnel + Docker Compose together

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the project root (parent of scripts dir)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo -e "${BLUE}Starting Cognitive Platform Development Environment${NC}"
echo ""

TUNNEL_PID=""

# Check if cloudflared is installed
SKIP_TUNNEL=""
if ! command -v cloudflared &> /dev/null; then
    echo -e "${YELLOW}cloudflared not installed. Running without webhooks (polling mode).${NC}"
    echo -e "${YELLOW}Install with: brew install cloudflared${NC}"
    SKIP_TUNNEL=true
fi

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down...${NC}"

    # Stop Docker Compose
    docker compose down 2>/dev/null || true

    # Stop cloudflared tunnel
    if [ -n "$TUNNEL_PID" ]; then
        echo -e "${YELLOW}Stopping Cloudflare Tunnel...${NC}"
        kill "$TUNNEL_PID" 2>/dev/null || true
        wait "$TUNNEL_PID" 2>/dev/null || true
    fi

    echo -e "${GREEN}Shutdown complete${NC}"
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Start Cloudflare Tunnel
if [ -z "$SKIP_TUNNEL" ]; then
    # Check if named tunnel config exists
    if [ -f "$HOME/.cloudflared/config.yml" ]; then
        echo -e "${BLUE}Starting Cloudflare Tunnel (named)...${NC}"

        # Start named tunnel in background
        cloudflared tunnel run > /dev/null 2>&1 &
        TUNNEL_PID=$!
        sleep 2

        # Check if tunnel started
        if kill -0 "$TUNNEL_PID" 2>/dev/null; then
            # Get webhook URL from .env if set
            if [ -n "$WEBHOOK_URL" ]; then
                echo -e "${GREEN}Cloudflare Tunnel active: ${WEBHOOK_URL}${NC}"
            else
                echo -e "${GREEN}Cloudflare Tunnel started${NC}"
                echo -e "${YELLOW}Set WEBHOOK_URL in .env for webhook mode${NC}"
            fi
        else
            echo -e "${YELLOW}Tunnel failed to start. Continuing without webhooks.${NC}"
            TUNNEL_PID=""
        fi
    else
        echo -e "${YELLOW}No cloudflared config found. Running without webhooks.${NC}"
        echo -e "${YELLOW}Create a tunnel: cloudflared tunnel create cognitive-dev${NC}"
    fi
else
    echo -e "${YELLOW}Skipping Cloudflare Tunnel (not available)${NC}"
fi

echo ""

# Start Docker Compose
echo -e "${BLUE}Starting Docker services...${NC}"
echo ""

# Run docker compose in foreground
docker compose up --build

# If docker compose exits, clean up
cleanup
