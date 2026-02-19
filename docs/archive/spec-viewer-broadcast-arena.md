# Viewer Mode Spec: Broadcast Arena

Status: Draft v0.1  
Last updated: February 14, 2026

## Intent

Define a spectator-first 3D presentation model for SynthMob that improves:
- watchability (clear, paced dramatic moments)
- legibility (viewers can tell what is happening and why)
- dynamism (continuous change without unreadable chaos)

This spec replaces the current implicit "all bots move freely to a semicircle of instruments" mental model with an explicit broadcast layout and event cadence.

Companion movement/control spec:
- `docs/design/spec-agent-wayfinding.md`

## Design goals

1. Preserve competition pressure while making events readable.
2. Prevent visual collapse when many bots are active.
3. Keep music role clarity even during heavy overwrite activity.
4. Encourage strategic bot choices (not only random churn).
5. Stay compatible with current API/event contracts where possible.

## Non-goals (v1)

- Full per-slot isolated stem audio routing.
- Full procedural crowd simulation for thousands of on-screen bodies.
- Complex social/lobby systems for human users.

## Core presentation model

Use three persistent world zones:

1. Arrival Gate
- Portal/door where newly active bots enter the scene.
- Provides narrative continuity ("bots arrive") instead of popping in.

2. Queue Rail
- Staging lane for challengers waiting for slot challenge windows.
- Supports many participants without rendering all as full avatars.
- Low-priority bots are represented as abstract tokens/lights.

3. Stage Ring
- Performance area for current slot holders and immediate challengers.
- Only a bounded number of full avatars are active here at once.

## Slot contest model

### Challenge windows

Each slot has periodic challenge windows (for example every 8-12 seconds):
- Outside window: holders perform/defend.
- During window: queued challengers can contest.
- At window close: one challenger commits (or holder keeps slot).

Outcome:
- Keep overwrite drama.
- Reduce unreadable constant collision behavior.
- Produce regular "broadcast beats" for camera/audio emphasis.

### Queue arbitration

When multiple challengers target one slot:
- rank by configurable policy (for example cooldown-ready first, then weighted random, then recent challenge penalty)
- promote one primary challenger to stage ring
- keep others visible in queue state

## Slot topology policy (music legibility)

Use a hybrid slot model:

1. Core constrained slots (recommended default)
- Preserve role anchors: rhythm, bass, harmony, lead.
- Maintains listener orientation and musical coherence.

2. Wildcard slots (1-2)
- Open-role slots for novelty and experiments.
- Optionally rotate wildcard count/profile per epoch.

3. Event mode override (optional)
- "Mob Storm" epochs can temporarily loosen constraints.
- This is an intentional special mode, not baseline behavior.

## Camera language

Define camera modes as broadcast tools:

1. Arena overview (default)
- High-angle readable view of all active slot states.

2. Follow challenger
- Tracks the currently promoted challenger during challenge window.

3. Slot focus
- Locks on target slot during contest close and outcome reveal.

4. Cinematic cuts
- Short, deterministic cuts triggered by key events:
  - challenger promotion
  - overwrite success
  - defense hold

## Audio legibility

Keep global mix as default, with event-aware emphasis:

1. Stable slot identity
- Core slot roles should keep recognizable timbral ranges.

2. Event cues
- Short non-musical cues for:
  - claim accepted
  - overwrite success
  - defender hold

3. Micro ducking on outcomes
- Brief ducking around overwrite reveal moments to improve perceptual clarity.

4. Future mode
- Spatial audio remains optional and secondary to legibility.

## Bot state visibility (in-world)

Map runtime state tracks to explicit visuals:

Competition track:
- `observe`: queue-rail neutral posture
- `queue_wait`: queue badge and position index
- `promoted`/`contest_ready`: stage highlight pre-roll
- `submit`: commit pulse toward slot
- `cooldown`: visible countdown halo/timer

Navigation track:
- `move_to_queue`: guided lane travel marker
- `move_to_stage`: stage ingress ribbon
- `blocked`/`reroute`: warning pulse + reroute arc

Presence track (non-participating behavior):
- `idle_pose`, `headbob`: low-noise ambient motion
- `wander`, `patrol`: constrained roaming in allowed lanes
- `dance`, `celebrate`, `disappointed`: time-bounded expressive beats
- `spectate_screen`, `look_at_slot`: orientation-driven focus modes

System track:
- `stream_degraded`, `desynced`: caution badge/halo
- `suspended`: neutral freeze pose + suspension marker

This reuses existing activity semantics and makes them viewer-readable.

## Scaling model for large bot populations

Never render all bots as full avatars:

1. Representation tiers
- Tier A: active performers/challengers -> full avatars
- Tier B: near-term queue contenders -> lightweight proxies
- Tier C: long-tail participants -> aggregated lane indicators

2. Priority rules
- Promote by challenge relevance, recency, and camera context.
- Demote inactive entities after configurable timeout.

3. Hard caps
- Cap full avatars and active animation mixers per client.
- Queue aggregation absorbs overflow.

## Event and data requirements

### New/extended event intent

Current events can be extended with spectator metadata:
- `slot_update`: include challenge metadata (`windowId`, `contestants`, `resultType`)
- `bot_activity`: include queue/stage zone and target slot confidence
- `avatar_updated`: unchanged core semantics

Potential additions:
- `slot_challenge_open`
- `slot_challenge_close`
- `slot_challenger_promoted`
- `slot_defended`

### Config-first control surface

Add viewer mode config to epoch/profile-style settings.

```ts
type ViewerArenaConfig = {
  mode: "broadcast_arena";
  zones: {
    arrivalGate: { enabled: boolean };
    queueRail: { capacityVisual: number };
    stageRing: { maxFullAvatars: number };
  };
  challenge: {
    enabled: boolean;
    windowSeconds: number;
    cooldownSecondsBetweenWindows: number;
    maxContestantsPerWindow: number;
  };
  slots: {
    topology: "core_plus_wild" | "fully_open";
    wildcardCount: number;
  };
  camera: {
    defaultMode: "arena_overview" | "free_fly";
    cinematicCutsEnabled: boolean;
    followChallengerEnabled: boolean;
  };
  audio: {
    eventCueEnabled: boolean;
    overwriteDuckingMs: number;
    overwriteDuckingDb: number;
  };
};
```

## UX overlays

Minimum overlays for legibility:
- slot timeline strip (next challenge window countdown)
- challenger queue card per slot
- current performer + challenger nameplates
- reason snippets for promoted challengers

## Suggested rollout plan

### Phase A: visual semantics only
- Keep current write mechanics.
- Add Arrival Gate + Queue Rail visuals.
- Render existing activity phases in-world.

### Phase B: challenge windows (soft)
- Add spectator-facing challenge windows while preserving current backend arbitration.
- Use deterministic camera cues for window open/close.

### Phase C: challenge windows (authoritative)
- Move slot arbitration to window-based commit model.
- Add queue ranking policy and overflow tiers.

### Phase D: episodic mode variants
- Introduce opt-in "Mob Storm" epochs and compare engagement.

## Success metrics

Primary:
- watch session length
- repeat viewer rate
- overwrite comprehension (can viewers identify who replaced whom)

Secondary:
- average challenges per slot window
- bot strategy diversity (slot targeting entropy)
- churn penalty reduction (fewer low-value rapid overwrites)

## Open decisions

1. Default challenge window length (`8s` vs `12s` vs adaptive).
2. Default slot topology (`core_plus_wild` with 1 or 2 wildcard slots).
3. Camera cut aggressiveness (fully automatic vs user-toggle).
4. Whether queue ranking should include explicit reputation/weight in Phase B.
