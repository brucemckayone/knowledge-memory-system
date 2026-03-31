# Cognitive Platform - Development Commands
.PHONY: dev dev-named up down logs rebuild clean tunnel health ml help

# Default target
help:
	@echo "Cognitive Platform - Available Commands"
	@echo ""
	@echo "  make dev         - Start with Cloudflare Quick Tunnel + Docker"
	@echo "  make dev-named   - Start with named Cloudflare Tunnel + Docker"
	@echo "  make up          - Start Docker infra (postgres, qdrant, platform)"
	@echo "  make ml          - Start ML services on host (run separately)"
	@echo "  make down        - Stop all services"
	@echo "  make logs        - Follow Docker logs"
	@echo "  make rebuild     - Rebuild and restart services"
	@echo "  make clean       - Stop services and remove volumes"
	@echo "  make tunnel      - Start quick tunnel only (for debugging)"
	@echo "  make health      - Check service health"
	@echo ""

# Full development environment with quick tunnel (default)
dev:
	@./scripts/dev.sh

# Development with named/persistent tunnel
dev-named:
	@TUNNEL_MODE=named ./scripts/dev.sh

# Docker only (polling mode)
up:
	docker compose up --build

# Background mode
up-d:
	docker compose up --build -d

# Stop services
down:
	docker compose down

# Follow logs
logs:
	docker compose logs -f

# Platform logs only
logs-platform:
	docker compose logs -f platform

# Rebuild and restart
rebuild:
	docker compose down
	docker compose up --build

# Clean everything (including volumes)
clean:
	docker compose down -v

# Start quick tunnel only (for debugging)
tunnel:
	@echo "Starting Cloudflare Quick Tunnel on port 3000..."
	@echo "Press Ctrl+C to stop"
	cloudflared tunnel --url http://localhost:3000

# Start ML services on host
# Uses uv to manage a Python 3.11 venv (avoids Python 3.14 wheel incompatibilities)
# --http h11: required on Windows (httptools hangs for native HTTP clients)
ml:
	cd ml-services && uv venv --python 3.11 .venv
	cd ml-services && uv pip install --python .venv/Scripts/python.exe -r requirements.txt --quiet
	cd ml-services && set PYTHONIOENCODING=utf-8 && .venv\Scripts\uvicorn app.main:app --host 0.0.0.0 --port 8000 --http h11 --reload

# Health check
health:
	@echo "Platform:"
	@curl -s http://localhost:3001/health | jq . 2>/dev/null || echo "  Not responding"
	@echo ""
	@echo "ML Services:"
	@curl -s http://localhost:8000/health | jq . 2>/dev/null || echo "  Not responding"
	@echo ""
	@echo "Ollama:"
	@curl -s http://localhost:11434/ 2>/dev/null && ollama list 2>/dev/null || echo "  Not responding"
	@echo ""
	@echo "PostgreSQL:"
	@pg_isready -h 127.0.0.1 -p 5433 -U cognitive 2>/dev/null || echo "  Not responding"
	@echo ""
	@echo "Qdrant:"
	@curl -s http://localhost:6335/collections | jq .result.collections 2>/dev/null || echo "  Not responding"
