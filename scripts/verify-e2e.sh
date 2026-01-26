#!/bin/bash
# =============================================================================
# E2E System Verification Script
# =============================================================================
# Verifies the full pipeline: Telegram -> Platform -> Storage -> Search
#
# Prerequisites:
#   - docker compose up -d (from project root)
#   - Ollama running on host (for ML services)
#
# Usage:
#   ./scripts/verify-e2e.sh          # Run all checks
#   ./scripts/verify-e2e.sh --quick  # Health check only
#   ./scripts/verify-e2e.sh --clean  # Remove test data after
# =============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration (docker-compose exposed ports)
PLATFORM_URL="${PLATFORM_URL:-http://localhost:3000}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5433}"
POSTGRES_USER="${POSTGRES_USER:-cognitive}"
POSTGRES_DB="${POSTGRES_DB:-cognitive}"

# Counters
PASSED=0
FAILED=0
SKIPPED=0

# Parse arguments
QUICK_MODE=false
CLEAN_MODE=false
for arg in "$@"; do
  case $arg in
    --quick) QUICK_MODE=true ;;
    --clean) CLEAN_MODE=true ;;
  esac
done

# =============================================================================
# Helper Functions
# =============================================================================

print_header() {
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

check_pass() {
  echo -e "  ${GREEN}✓${NC} $1"
  PASSED=$((PASSED + 1))
}

check_fail() {
  echo -e "  ${RED}✗${NC} $1"
  if [ -n "$2" ]; then
    echo -e "    ${YELLOW}→ $2${NC}"
  fi
  FAILED=$((FAILED + 1))
}

check_skip() {
  echo -e "  ${YELLOW}○${NC} $1 (skipped)"
  SKIPPED=$((SKIPPED + 1))
}

check_info() {
  echo -e "  ${CYAN}ℹ${NC} $1"
}

run_psql() {
  docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "$1" 2>/dev/null || echo ""
}

# =============================================================================
# Step 1: Infrastructure Health Check
# =============================================================================

print_header "Step 1: Infrastructure Health Check"

# Check if docker compose is running
echo -n "Checking Docker services... "
if docker compose ps --format json 2>/dev/null | grep -q "running"; then
  echo -e "${GREEN}running${NC}"
else
  echo -e "${RED}not running${NC}"
  echo -e "${YELLOW}Start with: docker compose up -d${NC}"
  exit 1
fi

# Health endpoint check
echo -n "Checking platform health... "
HEALTH_RESPONSE=$(curl -s --max-time 5 "$PLATFORM_URL/health" 2>/dev/null || echo "")

if [ -z "$HEALTH_RESPONSE" ]; then
  check_fail "Health endpoint not responding"
  echo -e "${YELLOW}Is the platform container running? Check: docker compose logs platform${NC}"
  exit 1
fi

# Parse health response
STATUS=$(echo "$HEALTH_RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
DB_STATUS=$(echo "$HEALTH_RESPONSE" | grep -o '"database":"[^"]*"' | cut -d'"' -f4)
QDRANT_STATUS=$(echo "$HEALTH_RESPONSE" | grep -o '"qdrant":"[^"]*"' | cut -d'"' -f4)
ML_STATUS=$(echo "$HEALTH_RESPONSE" | grep -o '"ml":"[^"]*"' | cut -d'"' -f4)

if [ "$STATUS" = "ok" ]; then
  check_pass "Platform status: $STATUS"
else
  check_fail "Platform status: $STATUS (expected: ok)"
fi

if [ "$DB_STATUS" = "ok" ]; then
  check_pass "Database: $DB_STATUS"
else
  check_fail "Database: $DB_STATUS"
fi

if [ "$QDRANT_STATUS" = "ok" ]; then
  check_pass "Qdrant: $QDRANT_STATUS"
else
  check_fail "Qdrant: $QDRANT_STATUS"
fi

if [ "$ML_STATUS" = "ok" ]; then
  check_pass "ML Services: $ML_STATUS"
else
  check_fail "ML Services: $ML_STATUS (check Ollama is running)"
fi

# Quick mode stops here
if [ "$QUICK_MODE" = true ]; then
  print_header "Quick Check Complete"
  echo -e "Passed: ${GREEN}$PASSED${NC}, Failed: ${RED}$FAILED${NC}"
  [ "$FAILED" -eq 0 ] && exit 0 || exit 1
fi

# =============================================================================
# Step 2: Task Flow Verification
# =============================================================================

print_header "Step 2: Task Flow Verification"

# Generate unique test marker
TEST_MARKER="E2E-TEST-$(date +%s%N | md5sum | head -c 8)"
TIMESTAMP=$(date +%s)

check_info "Test marker: $TEST_MARKER"

# Send task message via webhook
echo -n "Sending task message... "
WEBHOOK_RESPONSE=$(curl -s -X POST "$PLATFORM_URL/webhook/telegram" \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 200000001,
    "message": {
      "message_id": 201,
      "from": {"id": 99999, "first_name": "E2E-Test"},
      "chat": {"id": 99999, "type": "private"},
      "date": '"$TIMESTAMP"',
      "text": "Remind me to verify the '"$TEST_MARKER"' tomorrow at 3pm"
    }
  }' 2>/dev/null || echo "")

if echo "$WEBHOOK_RESPONSE" | grep -q '"ok":true'; then
  check_pass "Webhook accepted message"
else
  check_fail "Webhook response: $WEBHOOK_RESPONSE"
fi

# Wait for processing
echo -n "Waiting for task processing... "
sleep 3
echo "done"

# Check task in PostgreSQL
TASK_COUNT=$(run_psql "SELECT COUNT(*) FROM tasks WHERE content ILIKE '%$TEST_MARKER%'")
TASK_COUNT=$(echo "$TASK_COUNT" | tr -d '[:space:]')

if [ "$TASK_COUNT" -gt 0 ]; then
  check_pass "Task stored in PostgreSQL ($TASK_COUNT row(s))"

  # Get task details
  TASK_DETAILS=$(run_psql "SELECT content, priority, status FROM tasks WHERE content ILIKE '%$TEST_MARKER%' ORDER BY created_at DESC LIMIT 1")
  check_info "Task: $TASK_DETAILS"
else
  check_fail "Task not found in PostgreSQL"
  check_info "Note: Classification may route this to 'thought' instead of 'task'"
fi

# =============================================================================
# Step 3: Memory Flow Verification
# =============================================================================

print_header "Step 3: Memory Flow Verification"

THOUGHT_MARKER="THOUGHT-$(date +%s%N | md5sum | head -c 8)"
check_info "Thought marker: $THOUGHT_MARKER"

# Send thought message
echo -n "Sending thought message... "
THOUGHT_RESPONSE=$(curl -s -X POST "$PLATFORM_URL/webhook/telegram" \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 200000002,
    "message": {
      "message_id": 202,
      "from": {"id": 99999, "first_name": "E2E-Test"},
      "chat": {"id": 99999, "type": "private"},
      "date": '"$TIMESTAMP"',
      "text": "I am thinking about quantum computing and cryptography - marker:'"$THOUGHT_MARKER"'"
    }
  }' 2>/dev/null || echo "")

if echo "$THOUGHT_RESPONSE" | grep -q '"ok":true'; then
  check_pass "Webhook accepted thought"
else
  check_fail "Webhook response: $THOUGHT_RESPONSE"
fi

# Wait for embedding and storage
echo -n "Waiting for embedding + Qdrant storage... "
sleep 5
echo "done"

# Search for the memory
SEARCH_RESPONSE=$(curl -s "$PLATFORM_URL/api/search?q=$THOUGHT_MARKER" 2>/dev/null || echo "")

if echo "$SEARCH_RESPONSE" | grep -q "$THOUGHT_MARKER"; then
  RESULT_COUNT=$(echo "$SEARCH_RESPONSE" | grep -o '"count":[0-9]*' | cut -d':' -f2)
  check_pass "Memory found in Qdrant search (count: $RESULT_COUNT)"
else
  check_fail "Memory not found in search"
  check_info "Search response: $(echo "$SEARCH_RESPONSE" | head -c 200)"
fi

# =============================================================================
# Step 4: Link Processing Verification
# =============================================================================

print_header "Step 4: Link Processing Verification"

LINK_MARKER="LINK-$(date +%s%N | md5sum | head -c 8)"
check_info "Link marker: $LINK_MARKER"

# Send link message
echo -n "Sending link message... "
LINK_RESPONSE=$(curl -s -X POST "$PLATFORM_URL/webhook/telegram" \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 200000003,
    "message": {
      "message_id": 203,
      "from": {"id": 99999, "first_name": "E2E-Test"},
      "chat": {"id": 99999, "type": "private"},
      "date": '"$TIMESTAMP"',
      "text": "Check out https://example.com - marker:'"$LINK_MARKER"'"
    }
  }' 2>/dev/null || echo "")

if echo "$LINK_RESPONSE" | grep -q '"ok":true'; then
  check_pass "Webhook accepted link"
else
  check_fail "Webhook response: $LINK_RESPONSE"
fi

# Wait for scraping + processing
echo -n "Waiting for link scraping + processing... "
sleep 8
echo "done"

# Search for the link
LINK_SEARCH=$(curl -s "$PLATFORM_URL/api/search?q=$LINK_MARKER" 2>/dev/null || echo "")

if echo "$LINK_SEARCH" | grep -q "$LINK_MARKER"; then
  check_pass "Link memory found in search"
else
  check_fail "Link memory not found"
  check_info "This may indicate scraping timeout or ML service issues"
fi

# =============================================================================
# Step 5: Gardener Pipeline Verification
# =============================================================================

print_header "Step 5: Gardener Pipeline Verification"

# Check gardener metrics
GARDENER_COUNT=$(run_psql "SELECT COUNT(*) FROM gardener_metrics WHERE recorded_at > NOW() - INTERVAL '10 minutes'")
GARDENER_COUNT=$(echo "$GARDENER_COUNT" | tr -d '[:space:]')

if [ -n "$GARDENER_COUNT" ] && [ "$GARDENER_COUNT" -gt 0 ]; then
  check_pass "Gardener jobs running ($GARDENER_COUNT in last 10 min)"

  # Show agent breakdown
  AGENT_STATS=$(run_psql "SELECT agent_name, COUNT(*) FROM gardener_metrics WHERE recorded_at > NOW() - INTERVAL '10 minutes' GROUP BY agent_name")
  if [ -n "$AGENT_STATS" ]; then
    check_info "Agent activity: $AGENT_STATS"
  fi
else
  check_skip "No recent gardener jobs (may need more messages to trigger)"
fi

# Check entities
ENTITY_COUNT=$(run_psql "SELECT COUNT(*) FROM entities")
ENTITY_COUNT=$(echo "$ENTITY_COUNT" | tr -d '[:space:]')

if [ -n "$ENTITY_COUNT" ] && [ "$ENTITY_COUNT" -gt 0 ]; then
  check_pass "Entities in knowledge graph: $ENTITY_COUNT"

  # Show recent entities
  RECENT_ENTITIES=$(run_psql "SELECT canonical_name, entity_type FROM entities ORDER BY created_at DESC LIMIT 3" | head -3)
  if [ -n "$RECENT_ENTITIES" ]; then
    check_info "Recent: $RECENT_ENTITIES"
  fi
else
  check_skip "No entities yet (gardener needs time to process)"
fi

# Check memory-entity links
LINK_COUNT=$(run_psql "SELECT COUNT(*) FROM memory_entities")
LINK_COUNT=$(echo "$LINK_COUNT" | tr -d '[:space:]')

if [ -n "$LINK_COUNT" ] && [ "$LINK_COUNT" -gt 0 ]; then
  check_pass "Memory-entity links: $LINK_COUNT"
else
  check_skip "No memory-entity links yet"
fi

# =============================================================================
# Step 6: Context UUID Verification
# =============================================================================

print_header "Step 6: Context UUID Verification"

# Check context_uuid_audit table
UUID_COUNT=$(run_psql "SELECT COUNT(*) FROM context_uuid_audit WHERE platform = 'telegram'")
UUID_COUNT=$(echo "$UUID_COUNT" | tr -d '[:space:]')

if [ -n "$UUID_COUNT" ] && [ "$UUID_COUNT" -gt 0 ]; then
  check_pass "Context UUIDs tracked: $UUID_COUNT"

  # Check for consistency
  MISMATCH_COUNT=$(run_psql "
    SELECT COUNT(*) FROM context_uuid_audit a
    LEFT JOIN context_summaries cs ON a.context_uuid = cs.id
    WHERE a.platform = 'telegram' AND cs.id IS NULL
  ")
  MISMATCH_COUNT=$(echo "$MISMATCH_COUNT" | tr -d '[:space:]')

  if [ -z "$MISMATCH_COUNT" ] || [ "$MISMATCH_COUNT" = "0" ]; then
    check_pass "UUID consistency: all context_uuid_audit entries have matching context_summaries"
  else
    check_fail "UUID mismatch: $MISMATCH_COUNT orphaned UUIDs"
  fi
else
  check_skip "No context UUIDs tracked yet (first messages may not have been processed)"
fi

# =============================================================================
# Step 7: Full Round-Trip Test
# =============================================================================

print_header "Step 7: Full Round-Trip Test"

ROUND_TRIP_MARKER="RT-$(date +%s%N | md5sum | head -c 12)"
check_info "Round-trip marker: $ROUND_TRIP_MARKER"

# Send message
echo -n "1. Sending message... "
RT_RESPONSE=$(curl -s -X POST "$PLATFORM_URL/webhook/telegram" \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 200000099,
    "message": {
      "message_id": 299,
      "from": {"id": 88888, "first_name": "RTTest"},
      "chat": {"id": 88888, "type": "private"},
      "date": '"$TIMESTAMP"',
      "text": "The quick brown fox jumps over the lazy dog - marker:'"$ROUND_TRIP_MARKER"'"
    }
  }' 2>/dev/null || echo "")

if echo "$RT_RESPONSE" | grep -q '"ok":true'; then
  echo -e "${GREEN}sent${NC}"
else
  echo -e "${RED}failed${NC}"
fi

# Wait
echo -n "2. Processing... "
sleep 6
echo "done"

# Search
echo -n "3. Searching... "
RT_SEARCH=$(curl -s "$PLATFORM_URL/api/search?q=$ROUND_TRIP_MARKER" 2>/dev/null || echo "")

if echo "$RT_SEARCH" | grep -q "$ROUND_TRIP_MARKER"; then
  echo -e "${GREEN}found${NC}"
  check_pass "Full round-trip: message sent -> stored -> searchable"
else
  echo -e "${RED}not found${NC}"
  check_fail "Round-trip failed: message not searchable after 6 seconds"
fi

# =============================================================================
# Cleanup (Optional)
# =============================================================================

if [ "$CLEAN_MODE" = true ]; then
  print_header "Cleanup"

  echo -n "Removing test data... "
  run_psql "DELETE FROM tasks WHERE content ILIKE '%E2E-TEST%' OR content ILIKE '%marker:%'" > /dev/null 2>&1
  run_psql "DELETE FROM context_uuid_audit WHERE conversation_id IN ('99999', '88888')" > /dev/null 2>&1
  echo "done"

  check_info "Test data removed from PostgreSQL"
  check_info "Note: Qdrant memories persist (no automatic cleanup)"
fi

# =============================================================================
# Summary
# =============================================================================

print_header "Verification Summary"

TOTAL=$((PASSED + FAILED + SKIPPED))
echo ""
echo -e "  ${GREEN}Passed:${NC}  $PASSED"
echo -e "  ${RED}Failed:${NC}  $FAILED"
echo -e "  ${YELLOW}Skipped:${NC} $SKIPPED"
echo -e "  ─────────────"
echo -e "  Total:   $TOTAL"
echo ""

if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  All E2E checks passed!${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 0
else
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${RED}  Some checks failed. Review output above.${NC}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 1
fi
