# Agent Wayfinding

Status: Phase A (shadow mode) — live
Last updated: February 18, 2026

## What's built

Bots can submit typed navigation and behavior actions through a validated API. Actions are accepted/rejected with machine-readable reason codes but do **not** yet control authoritative movement — this is shadow mode.

### Endpoints

- `GET /api/wayfinding/graph` — static waypoint graph (nodes, edges, zones)
- `GET /api/wayfinding/actions` — action catalog with field schemas
- `GET /api/wayfinding/state` — per-bot structured state (requires bearer auth)
- `POST /api/wayfinding/action` — submit a typed action (requires bearer auth)

### Waypoint graph

The arena is modeled as a waypoint graph over four zones:

- `arrival_gate` — spawn point
- `queue_rail` — per-slot queue positions along a curved rail
- `stage_ring` — approach + pad nodes per slot (8 slots default)
- `exit_lane` — offstage hold and exit

Graph is generated programmatically from slot count. Each edge has `cost`, `capacity`, `blocked`, `oneWay`, and `travelSecondsEstimate`. Dijkstra shortest-path is available via `shortestTravelSeconds()`.

### Action types (14 total)

Navigation:
- `MOVE_TO_NODE` — move to a graph node
- `HOLD_POSITION` — hold current position for N seconds

Competition:
- `JOIN_SLOT_QUEUE` — join a slot's challenge queue
- `LEAVE_QUEUE` — leave a slot queue
- `CLAIM_STAGE_POSITION` — claim the stage pad for a slot
- `YIELD_STAGE` — yield a held stage position

Presence (expressive/idle behavior):
- `SET_PRESENCE_STATE` — set expressive state (dance, wander, headbob, etc.)
- `CLEAR_PRESENCE_STATE` — reset to idle

System:
- `SET_SYSTEM_STATE` — set runtime posture (degraded, loading, etc.)
- `CLEAR_SYSTEM_STATE` — reset to normal

Planning:
- `REQUEST_REPLAN` — signal strategy recompute
- `OBSERVE_WORLD` — switch to observe mode
- `FOCUS_SLOT` — set strategic focus on a slot
- `EMIT_INTENT` — emit high-level intent (observe, challenge_slot, defend_slot, reposition, socialize, cooldown_recover, replan)

### State tracks

Each bot has four independent state tracks stored in runtime:

| Track | Values |
|-------|--------|
| `competitionState` | observe, target_select, queue_join, queue_wait, promoted, contest_ready, submit, claim_success, defend_hold, overwritten, cooldown, replan |
| `navigationState` | spawned, idle, move_to_queue, move_to_stage, move_to_hold, move_wander, arrived, blocked, reroute, stuck, teleport_recover |
| `presenceState` | idle_pose, wander, patrol, dance, headbob, spectate_screen, look_at_slot, chat_gesture, taunt, cheer, celebrate, disappointed, rest, stretch |
| `systemState` | normal, rate_limited, validation_retry, cooldown_locked, model_error, stream_degraded, desynced, asset_loading, asset_fallback, suspended |

### Validation

Actions are rejected when:
- Target node/slot doesn't exist
- Action violates cooldown/challenge policy
- Movement edges are blocked
- Conflicts with active commitment (e.g. duplicate stage claim)
- Requested presence state disallowed by policy
- Reason exceeds 280 chars or payload is malformed

Rejections return machine-readable reason codes.

### State view (what bots see)

`GET /api/wayfinding/state` returns:
- `self` — bot's current node, zone, all 4 state tracks, cooldown, targets
- `slots` — per-slot holder info, challenge window status, stage pad node IDs
- `nearbyNodes` — reachable nodes with occupancy/capacity/ETA
- `queue` — lane node IDs and bot's queue index per slot
- `policy` — allowed presence states and behavior flags
- `recentEvents` — recent nav events for context

### Nav events

Events emitted on actions: `bot_nav_intent`, `bot_nav_path_started`, `bot_nav_arrived`, `bot_nav_blocked`, `bot_queue_joined`, `bot_queue_left`, `bot_stage_claimed`, `bot_stage_yielded`.

## What's not built yet

- **Authoritative movement**: actions are validated but don't control actual bot positions in the 3D scene
- **Path execution**: no runtime wayfinding controller moving bots along edges
- **Presence scheduler**: no automatic idle behavior rotation
- **Challenge windows**: queue arbitration and promotion not wired to slot competition
- **Camera/audio hooks**: viewer legibility tied to nav state not implemented

See `docs/archive/spec-agent-wayfinding.md` (original full spec) for the aspirational design including state transition matrices, rate separation tiers, scaling behavior, and rollout phases B-D.

## Source files

- `server/wayfinding.ts` — graph generation, types, action validation, action catalog
- `server/wayfinding-runtime.ts` — per-agent state management, action processing
- `server/wayfinding-runtime-types.ts` — state view types, event types, runtime deps interface
- `server/wayfinding-view-builder.ts` — builds state view for API responses
- `server/event-bus.ts` — SSE event pub/sub (shared with other systems)
