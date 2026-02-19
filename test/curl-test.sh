#!/bin/bash
# Quick curl-based API test for SynthMob
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
echo "=== SynthMob -- API Smoke Test ==="
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

# 4a. Register second bot (used for jam + validator checks)
echo "4a. POST /agents (second bot)"
REG2=$(curl -s -X POST "$API/agents" -H "Content-Type: application/json" -d "{\"name\":\"$BOT2\"}")
check "second bot returns token" '"token"' "$REG2"
TOKEN2=$(echo "$REG2" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# 4b. Wayfinding arena/state/action checks
echo "4b. GET /wayfinding/arena"
WF_ARENA=$(curl -s "$API/wayfinding/arena")
check "arena has continuous_space mode" '"continuous_space"' "$WF_ARENA"
check "arena has 50m radius" '"arenaRadiusM":50' "$WF_ARENA"

echo "4c. GET /wayfinding/actions"
WF_ACTIONS=$(curl -s "$API/wayfinding/actions")
check "wayfinding actions include MOVE_TO" '"MOVE_TO"' "$WF_ACTIONS"
check "wayfinding actions include presence action" '"SET_PRESENCE_STATE"' "$WF_ACTIONS"

echo "4d. GET /wayfinding/state"
WF_STATE=$(curl -s "$API/wayfinding/state" -H "Authorization: Bearer $TOKEN")
check "wayfinding state has x coordinate" '"x":' "$WF_STATE"
check "wayfinding state has schemaVersion 2.0" '"schemaVersion":"2.0"' "$WF_STATE"

echo "4e. POST /wayfinding/action (presence)"
WF_PRESENCE=$(curl -s -X POST "$API/wayfinding/action" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"type":"SET_PRESENCE_STATE","presenceState":"dance","durationSec":5,"reason":"ambient presence"}')
check "wayfinding presence action accepted" '"ok":true' "$WF_PRESENCE"
check "wayfinding state includes presence state" '"presenceState":"dance"' "$WF_PRESENCE"

echo "4f. POST /wayfinding/action (MOVE_TO)"
WF_MOVE=$(curl -s -X POST "$API/wayfinding/action" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"type":"MOVE_TO","x":10,"z":-5,"reason":"repositioning"}')
check "wayfinding MOVE_TO accepted" '"ok":true' "$WF_MOVE"

echo "4g. POST /wayfinding/action (removed action type)"
WF_OLD=$(curl -s -X POST "$API/wayfinding/action" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"type":"JOIN_SLOT_QUEUE","slotId":2,"reason":"old bot"}')
check "removed action returns 410" '"action_type_removed"' "$WF_OLD"

echo "4h. Jam flow: start/join/pattern/leave"
JAM_START=$(curl -s -X POST "$API/jam/start" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"pattern":"s(\"bd sd hh*2\").gain(0.6)"}')
check "jam start accepted" '"ok":true' "$JAM_START"
JAM_ID=$(echo "$JAM_START" | grep -o '"id":"[^"]*"' | head -n 1 | cut -d'"' -f4)
check "jam start returns jam id" '-' "$JAM_ID"

JAM_JOIN=$(curl -s -X POST "$API/jam/join" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d "{\"jam_id\":\"$JAM_ID\",\"pattern\":\"note(\\\"a2 e2 d2\\\").s(\\\"sawtooth\\\")\"}")
check "jam join accepted" '"ok":true' "$JAM_JOIN"

JAM_PATTERN=$(curl -s -X POST "$API/jam/pattern" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d "{\"jam_id\":\"$JAM_ID\",\"pattern\":\"note(\\\"<a3 c4 e4>\\\").s(\\\"piano\\\").gain(0.4)\"}")
check "jam pattern update accepted" '"ok":true' "$JAM_PATTERN"

JAM_LEAVE=$(curl -s -X POST "$API/jam/leave" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d "{}")
check "jam leave accepted" '"ok":true' "$JAM_LEAVE"

JAMS=$(curl -s "$API/jams")
check "jam snapshot endpoint returns sessions key" '"sessions"' "$JAMS"

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
INVALID=$(curl -s -X POST "$API/slot/3" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"code":"eval(\"bad\")"}')
check "rejects eval" '"validation_failed"' "$INVALID"

# 9. Write invalid unsupported runtime function
echo "9. POST /slot/4 (invalid code - unsupported space)"
UNSUPPORTED=$(curl -s -X POST "$API/slot/4" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"code":"s(\"bd sd\").space(0.3)"}')
check "rejects unsupported space()" '"validation_failed"' "$UNSUPPORTED"

# 10. Write invalid unsupported feedback function
echo "10. POST /slot/5 (invalid code - unsupported feedback)"
UNSUPPORTED_FB=$(curl -s -X POST "$API/slot/5" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"code":"s(\"bd sd\").delay(0.2).feedback(0.5)"}')
check "rejects unsupported feedback()" '"validation_failed"' "$UNSUPPORTED_FB"

# 11. Write valid bass pattern
echo "11. POST /slot/3 (valid bass)"
BASS=$(curl -s -X POST "$API/slot/3" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"code":"note(\"<a1 e1 d1>\").s(\"sawtooth\").lpf(400)"}')
check "claims bass slot" '"claimed"' "$BASS"

# 12. Check agent status
echo "12. GET /agents/status"
STATUS=$(curl -s "$API/agents/status" -H "Authorization: Bearer $TOKEN")
check "returns agent status" '"slots_held"' "$STATUS"

# 13. Get leaderboard
echo "13. GET /leaderboard"
LB=$(curl -s "$API/leaderboard")
check "returns leaderboard" "\"$BOT1\"" "$LB"

# 14. Read updated composition
echo "14. GET /composition (after writes)"
COMP2=$(curl -s "$API/composition")
check "slot 1 has code" 'bd \[sd cp\] bd sd' "$COMP2"
check "slot 3 has code" 'a1 e1 d1' "$COMP2"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
