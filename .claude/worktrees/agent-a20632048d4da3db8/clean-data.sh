#!/bin/bash
# Simple script to clean all data from Postgres and Qdrant
# Usage: ./clean-data.sh

set -e

cd "$(dirname "$0")"

echo "🧹 Cleaning all data..."

echo "📦 Stopping containers..."
docker compose down -v

echo "🗑️  Removing volumes..."
docker volume rm knowledge-memory-system_postgres-data 2>/dev/null || true
docker volume rm knowledge-memory-system_qdrant-data 2>/dev/null || true
docker volume rm knowledge-memory-system_ml-models 2>/dev/null || true

echo "🚀 Starting containers with fresh data..."
docker compose up -d

echo "⏳ Waiting for database to be ready..."
sleep 5

echo "📊 Running migrations..."
cd platform
npm run db:migrate

echo "✅ Data clean complete!"
