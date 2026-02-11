#!/bin/bash
# Quick curl-based API test for The Music Place
# Run: bash test/curl-test.sh

API="http://localhost:4000/api"
PASS=0
FAIL=0

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  PASS: $label"
    ((PASS++))
  else
    echo "  FAIL: $label (expected '$expected', got: $actual)"
    ((FAIL++))
  fi
}

echo ""
echo "=== The Music Place -- API Smoke Test ==="
echo ""

# 1. Get composition (empty)
echo "1. GET /composition"
COMP=$(curl -s "$API/composition")
check "returns epoch" '"epoch"' "$COMP"
check "has 8 slots" '"id":8' "$COMP"

# 2. Get context
echo "2. GET /context"
CTX=$(curl -s "$API/context")
check "has bpm" '"bpm"' "$CTX"
check "has key" '"key"' "$CTX"
check "has scaleNotes" '"scaleNotes"' "$CTX"

# 3. Register agent
echo "3. POST /agents"
REG=$(curl -s -X POST "$API/agents" -H "Content-Type: application/json" -d '{"name":"test-bot-1"}')
check "returns token" '"token"' "$REG"
TOKEN=$(echo "$REG" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "   Token: ${TOKEN:0:16}..."

# 4. Register duplicate (should fail)
echo "4. POST /agents (duplicate)"
DUP=$(curl -s -X POST "$API/agents" -H "Content-Type: application/json" -d '{"name":"test-bot-1"}')
check "rejects duplicate" '"name_taken"' "$DUP"

# 5. Write to slot 1 (drums)
echo "5. POST /slot/1 (drums)"
WRITE=$(curl -s -X POST "$API/slot/1" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"code":"s(\"bd [sd cp] bd sd\").bank(\"RolandTR808\")"}')
check "claims slot" '"claimed"' "$WRITE"

# 6. Write to slot 1 again (cooldown)
echo "6. POST /slot/1 (cooldown)"
COOL=$(curl -s -X POST "$API/slot/1" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"code":"s(\"hh*8\")"}')
check "returns cooldown" '"cooldown"' "$COOL"

# 7. Write invalid code
echo "7. POST /slot/3 (invalid code - eval)"
# Register a second bot for this
REG2=$(curl -s -X POST "$API/agents" -H "Content-Type: application/json" -d '{"name":"test-bot-2"}')
TOKEN2=$(echo "$REG2" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
INVALID=$(curl -s -X POST "$API/slot/3" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"code":"eval(\"bad\")"}')
check "rejects eval" '"validation_failed"' "$INVALID"

# 8. Write valid bass pattern
echo "8. POST /slot/3 (valid bass)"
BASS=$(curl -s -X POST "$API/slot/3" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"code":"note(\"<a1 e1 d1>\").s(\"sawtooth\").lpf(400)"}')
check "claims bass slot" '"claimed"' "$BASS"

# 9. Check agent status
echo "9. GET /agents/status"
STATUS=$(curl -s "$API/agents/status" -H "Authorization: Bearer $TOKEN")
check "returns agent status" '"slots_held"' "$STATUS"

# 10. Get leaderboard
echo "10. GET /leaderboard"
LB=$(curl -s "$API/leaderboard")
check "returns leaderboard" '"test-bot-1"' "$LB"

# 11. Read updated composition
echo "11. GET /composition (after writes)"
COMP2=$(curl -s "$API/composition")
check "slot 1 has code" 'bd \[sd cp\] bd sd' "$COMP2"
check "slot 3 has code" 'a1 e1 d1' "$COMP2"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""
