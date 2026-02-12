#!/bin/bash
# Quick curl-based API test for The Music Place
# Run: bash test/curl-test.sh

set -u

API="${API:-http://localhost:4000/api}"
RAW_SUFFIX="${TEST_SUFFIX:-$RANDOM}"
# Agent names must match ^[a-zA-Z0-9._-]{1,20}$.
SUFFIX="$(printf '%s' "$RAW_SUFFIX" | tr -cd '[:alnum:]' | cut -c1-6)"
if [[ -z "$SUFFIX" ]]; then
  SUFFIX="$RANDOM"
fi
BOT1="tb1_$SUFFIX"
BOT2="tb2_$SUFFIX"
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
REG=$(curl -s -X POST "$API/agents" -H "Content-Type: application/json" -d "{\"name\":\"$BOT1\"}")
check "returns token" '"token"' "$REG"
TOKEN=$(echo "$REG" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "   Token: ${TOKEN:0:16}..."

# 4. Register duplicate (should fail)
echo "4. POST /agents (duplicate)"
DUP=$(curl -s -X POST "$API/agents" -H "Content-Type: application/json" -d "{\"name\":\"$BOT1\"}")
check "rejects duplicate" '"name_taken"' "$DUP"

# 5. Activity auth checks
echo "5. POST /activity (auth checks)"
ACT_NOAUTH=$(curl -s -X POST "$API/activity" \
  -H "Content-Type: application/json" \
  -d '{"model":"haiku","personality":"test","strategy":"test","targetSlot":1,"targetSlotType":"drums","reasoning":"test","pattern":"s(\"bd\")","result":"claimed"}')
check "activity rejects unauthenticated write" '"unauthorized"' "$ACT_NOAUTH"

ACT_AUTH=$(curl -s -X POST "$API/activity" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"botName\":\"$BOT1\",\"model\":\"haiku\",\"personality\":\"test\",\"strategy\":\"test\",\"targetSlot\":1,\"targetSlotType\":\"drums\",\"reasoning\":\"test\",\"pattern\":\"s(\\\"bd\\\")\",\"result\":\"claimed\"}")
check "activity accepts authenticated write" '"ok":true' "$ACT_AUTH"

DEL_NOAUTH=$(curl -s -X DELETE "$API/activity")
check "activity rejects unauthenticated delete" '"unauthorized"' "$DEL_NOAUTH"

DEL_AUTH=$(curl -s -X DELETE "$API/activity" -H "Authorization: Bearer $TOKEN")
check "activity accepts authenticated delete" '"ok":true' "$DEL_AUTH"

# 6. Write to slot 1 (drums)
echo "6. POST /slot/1 (drums)"
WRITE=$(curl -s -X POST "$API/slot/1" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"code":"s(\"bd [sd cp] bd sd\").bank(\"RolandTR808\")"}')
check "claims slot" '"claimed"' "$WRITE"

# 7. Write to slot 1 again (cooldown)
echo "7. POST /slot/1 (cooldown)"
COOL=$(curl -s -X POST "$API/slot/1" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"code":"s(\"hh*8\")"}')
check "returns cooldown" '"cooldown"' "$COOL"

# 8. Write invalid code
echo "8. POST /slot/3 (invalid code - eval)"
# Register a second bot for this
REG2=$(curl -s -X POST "$API/agents" -H "Content-Type: application/json" -d "{\"name\":\"$BOT2\"}")
TOKEN2=$(echo "$REG2" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
INVALID=$(curl -s -X POST "$API/slot/3" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"code":"eval(\"bad\")"}')
check "rejects eval" '"validation_failed"' "$INVALID"

# 9. Write valid bass pattern
echo "9. POST /slot/3 (valid bass)"
BASS=$(curl -s -X POST "$API/slot/3" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"code":"note(\"<a1 e1 d1>\").s(\"sawtooth\").lpf(400)"}')
check "claims bass slot" '"claimed"' "$BASS"

# 10. Check agent status
echo "10. GET /agents/status"
STATUS=$(curl -s "$API/agents/status" -H "Authorization: Bearer $TOKEN")
check "returns agent status" '"slots_held"' "$STATUS"

# 11. Get leaderboard
echo "11. GET /leaderboard"
LB=$(curl -s "$API/leaderboard")
check "returns leaderboard" "\"$BOT1\"" "$LB"

# 12. Read updated composition
echo "12. GET /composition (after writes)"
COMP2=$(curl -s "$API/composition")
check "slot 1 has code" 'bd \[sd cp\] bd sd' "$COMP2"
check "slot 3 has code" 'a1 e1 d1' "$COMP2"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
