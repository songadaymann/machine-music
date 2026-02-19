# Session Notes

## 2026-02-16

## Summary

Creative Session system implementation (replaces structured jam system):

Server:
- Added `CreativeSession`, `SessionParticipant`, `SessionPosition`, `CreativeSessionSnapshot` types to `server/state.ts`.
- Added session CRUD methods: `startSession`, `joinSession`, `leaveSession`, `updateSessionOutput`, `getSessionSnapshot`.
- State: `creativeSessions: Map`, `sessionByAgentId: Map`, MAX_SESSIONS=50, STAGE_EXCLUSION_RADIUS=7.4.
- Position auto-assignment outside stage ring with room awareness (center/east_wing/west_wing).
- Creator role transfers on departure; sessions auto-delete when empty.
- Added 5 REST endpoints in `server/routes.ts`: `GET /sessions`, `POST /session/start`, `POST /session/join`, `POST /session/leave`, `POST /session/output`.
- Added SSE events: `session_created`, `session_joined`, `session_left`, `session_output_updated`, `session_ended`, `session_snapshot`.
- Legacy `/jam/*` endpoints preserved as thin adapters delegating to session methods.
- Legacy `jam_*` SSE events emitted for music-type sessions during transition.
- Fixed TypeScript discriminated union narrowing across all route handlers (`!result.success` -> `result.success === false`).

Client:
- `client/js/api.js`: Added `sessionSnapshot` state, `fetchSessions()`, 6 SSE event listeners for session lifecycle.
- `client/js/music.js`: Per-session subscription model (`subscribedSessions: Set`). New exports: `subscribeSession`, `unsubscribeSession`, `toggleSessionSubscription`, `isSessionSubscribed`. Updated `buildPattern()` to include subscribed session patterns.
- `client/js/app.js`: Added `processSessionSnapshot()`, `handleSessionEvent()`, session signature tracking. Updated `syncMusicWithState()` to 3-arg form.
- `client/js/avatars.js`: Added `assignToSession()` and `removeFromSession()` exports.
- `client/js/ui.js`: Added `renderSessionPanel()` with per-session Listen buttons and type badges. Updated status bar to show session/bot counts.
- `client/index.html`: Added session panel HTML structure in left sidebar.
- `client/css/void.css`: Full session panel styling (rows, badges, listen buttons, subscribed state).

Docs:
- `docs/integration/SKILL.md`: Added Creative Session APIs section, deprecated jam section, updated heartbeat and SSE docs.
- `docs/design/status.md`, `docs/design/architecture.md`, `README.md`, `docs/design/design-hub.md`: Updated to reflect session system.

## Verification

- Server starts clean with zero TypeScript errors.
- Full API lifecycle tested via curl:
  - Bot registration -> session start -> join -> output update -> leave -> creator transfer -> auto-delete.
  - Legacy `/jam/*` backward compatibility confirmed (start/join/leave/pattern all delegate correctly).
  - Cross-endpoint visibility confirmed (`GET /sessions` and `GET /jams` both reflect session state).

---

## 2026-02-14

## Summary

Agent wayfinding Phase A (shadow mode) implementation:
- Added a typed wayfinding graph/action module (`server/wayfinding.ts`) with canonical zones/nodes/edges and shortest-path ETA support.
- Added in-memory wayfinding runtime state to `server/state.ts`:
  - per-agent nav state (`nodeId`, `zone`, `locomotionState`, queue membership, target slot)
  - per-slot queue tracking
  - recent wayfinding event log
- Added wayfinding API endpoints in `server/routes.ts`:
  - `GET /api/wayfinding/graph`
  - `GET /api/wayfinding/state` (auth)
  - `POST /api/wayfinding/action` (auth, strict typed action validation)
- Added machine-readable action rejection codes (for example `invalid_node`, `cooldown_active`, `not_queue_eligible`) and nav event SSE emissions (`bot_nav_*`, `bot_queue_*`, `bot_stage_*`).
- Synced docs (`docs/design/status.md`, `docs/design/architecture.md`) with the new API/runtime surface.

Wayfinding future-proofing docs pass:
- Upgraded `docs/design/spec-agent-wayfinding.md` to a multi-track state model:
  - `competitionState`
  - `navigationState`
  - `presenceState` (including non-participation behaviors like `wander`, `dance`, `spectate_screen`)
  - `systemState`
- Added explicit priority/override rules and transition matrices by track.
- Added planned extension actions for expressive presence control (`SET_PRESENCE_STATE`, `CLEAR_PRESENCE_STATE`).
- Synced related design docs so viewer semantics and design hub language match the multi-track model:
  - `docs/design/spec-viewer-broadcast-arena.md`
  - `docs/design/design-hub.md`
  - `docs/design/architecture.md`

## Verification

- `bun run typecheck` passed.
- `bun run test:smoke` passed (26/26).
- Manual endpoint probe passed:
  - `/api/wayfinding/graph` returned graph payload.
  - `/api/wayfinding/state` returned per-agent state after registration.
  - `JOIN_SLOT_QUEUE` action accepted and updated queue index.
  - invalid stage claim correctly rejected with `reason_code = not_queue_eligible`.

## Follow-up pass (2026-02-14)

Wayfinding action-surface expansion for broader bot behavior:
- Added a discoverable action catalog endpoint (`GET /api/wayfinding/actions`) listing action type, category, and payload fields.
- Expanded supported `POST /api/wayfinding/action` types beyond slot-competition mechanics to include:
  - presence actions (`SET_PRESENCE_STATE`, `CLEAR_PRESENCE_STATE`)
  - system/planning actions (`SET_SYSTEM_STATE`, `CLEAR_SYSTEM_STATE`, `REQUEST_REPLAN`, `OBSERVE_WORLD`, `FOCUS_SLOT`, `EMIT_INTENT`)
- Upgraded wayfinding state payload to `schemaVersion: "1.1"` with multi-track state fields:
  - `competitionState`, `navigationState`, `presenceState`, `systemState`, and `lastIntent`
  - policy output (`allowedPresenceStates`, `presenceEnabled`, `nonParticipationBehaviorEnabled`)
- Added guardrails for non-competition behavior:
  - presence-state policy enforcement by competition/system posture
  - self-settable system-state restrictions (`suspended` remains disallowed via action API)

Verification:
- `bun run test:smoke` passed with new checks for:
  - `GET /api/wayfinding/actions`
  - `SET_PRESENCE_STATE` accepted and reflected in returned wayfinding state.

## Refactor pass (2026-02-14, later)

Wayfinding/state modularity pass:
- Extracted SSE listener management into `server/event-bus.ts` and delegated from `server/state.ts` (`addSSEListener`, `removeSSEListener`, `broadcast`, `sseListenerCount`).
- Split wayfinding runtime concerns:
  - transition/reducer logic stays in `server/wayfinding-runtime.ts`
  - state response shaping moved to `server/wayfinding-view-builder.ts`
  - shared runtime/view contracts moved to `server/wayfinding-runtime-types.ts`
- Kept compatibility for existing imports by exporting `WayfindingRuntime` as an alias of the reducer class.
- Synced architecture/status docs to reflect these runtime boundaries.

Verification:
- `bun run typecheck` passed.
- `bun run test:smoke` passed (30/30).

## Avatar diagnostics pass (2026-02-14, later)

Meshy avatar pipeline validation and texture triage:
- Reconfirmed local text-to-3D flow is running in two explicit stages before rigging:
  - preview (`mode: "preview"`)
  - refine (`mode: "refine"`, `enable_pbr: true`)
- Reconfirmed rigging requests receive a bounded avatar height and forward it to Meshy `height_meters` (`0.8..3.2`, default `1.7`).
- Used stage-level debugging path in-scene:
  - assigned preview output directly to verify geometry before texturing
  - assigned refine output directly to verify textured mesh before rigging
- Inspected exported texture maps and confirmed refine outputs include expected PBR channels (`baseColor`, `metallic/roughness`, `normal`).
- Confirmed visual mismatch appears primarily after rigging for some generations (washed-out, white, or dark/black materials depending on channel interpretation).
- Hardened runtime rendering behavior for custom avatars:
  - non-rigged GLBs are allowed as static meshes (diagnostic path)
  - Meshy material normalization clamps emissive/specular extremes to improve readability
- Logged remaining gap: robust Mixamo-to-Meshy slot/drama animation mapping is still incomplete and remains an active follow-up track.

## 2026-02-13

## Summary

Avatar generation + assignment slice:
- Added Meshy-backed generation pipeline (`server/avatar-generation.ts`) for text prompt -> preview -> refine -> auto-rig -> local GLB persistence.
- Added avatar APIs:
  - `POST /api/avatar/generate`
  - `GET /api/avatar/order/:id`
  - `GET /api/avatar/orders`
  - `POST /api/avatar/assign`
  - `GET /api/avatar/me`
  - `DELETE /api/avatar/assign`
- Added runtime bot-avatar assignment state, including `agent.avatarGlbUrl` in composition and slot-update payloads.
- Added avatar SSE events and client handling (`avatar_generating`, `avatar_updated`) for live progress and hot-swap.
- Added static serving for generated artifacts via `/generated-avatars/*` and ignored `public/generated-avatars/` in git.
- Added request JSON hardening for avatar routes (`invalid_json` handling).

Real output-metering update:
- Switched listener metering from synthetic activity pulses to real analyzer-derived audio data.
- Void scene instrument meters now track smoothed RMS from Strudel analyzer output.
- Classic listener visualization now uses real analyzer frequency bins instead of random bars.
- Extended `render_game_to_text` output with `outputRms` and `outputRmsDb` for test/automation visibility.
- Documented scope explicitly: metering is based on master output (single analyzer bus), not per-slot isolated stems.

## Verification

- Meshy local E2E succeeded:
  - generation reached `complete`
  - rigged GLB persisted under `public/generated-avatars/`
  - assignment succeeded and composition payload exposed `agent.avatarGlbUrl`
- Playwright checks:
  - `output/web-game-avatar-slice/state-0.json`
  - `output/web-game-avatar-custom/state-0.json`
- Playwright run (Void): `output/web-game-rms-active/state-1.json` reported non-zero RMS while playing.
- Playwright run (classic): `output/web-game-rms-classic/shot-1.png` showed active analyzer-driven bars.
- CI remained green: `bun run ci:verify` (typecheck + smoke).

## Current limitation

- Meshy-generated rigs do not yet fully use the existing Mixamo/slot animation set.
- Current behavior: use embedded clips when available, otherwise fallback motion.
- Next step is animation retarget/mapping for slot/drama actions.

## Follow-up pass (2026-02-13)

Skill/doc alignment:
- Compared `docs/integration/SKILL.md` against Anthropic Agent Skills best practices and tightened structure/usage guidance.
- Kept skill guidance focused on SynthMob realities (safe Strudel output, slot-claim behavior, iteration strategy).

World/design spec pass:
- Added/expanded `docs/design/spec-viewer-broadcast-arena.md` to define a more legible, watchable broadcast staging model.
- Added/expanded `docs/design/spec-agent-wayfinding.md` for future autonomous movement/scene navigation (spec only, not implemented yet).
- Added/expanded `docs/design/spec-visual-philosophy.md` for site/world identity direction.
- Removed the anti-skeuomorphic branch from the visual philosophy plan (kept focus project-specific).

Amphitheater environment integration:
- Converted and optimized `/Users/jonathanmann/Downloads/Amphitheater.fbx` to GLB variants under `output/asset-pipeline/amphitheater/`.
- Wired the optimized amphitheater model into runtime at `public/environments/amphitheater.glb` (served via `/models/environments/amphitheater.glb`).
- Added environment switching in the Void client (`shell` vs `amphitheater`) with HUD toggle (`Env: ...`) and persistence.
- Added per-environment camera presets and included current environment mode in `render_game_to_text`.

Verification:
- Typecheck remained clean after scene/refactor changes.
- Playwright captures confirmed both environment modes and state output.
- Current status: amphitheater is visible and functional; camera framing/composition is the next tuning pass.

Scene reset + procedural indoor arena pass:
- Reset scene visuals back to a clean baseline and removed the prior amphitheater/skybox presentation path from the active runtime scene.
- Built a fully programmatic enclosed indoor arena in `client/js/scene.js`:
  - event floor + perimeter railings
  - multi-tier seating bowl on all four sides
  - enclosed walls/ceiling volume with truss lights and hanging speaker clusters
- Corrected east/west riser orientation so all sections face inward.
- Fixed white-floor z-fighting by separating coplanar floor/border geometry.
- Added a center scale-reference avatar and then switched the source to the stable runtime rig (`/models/animations/idle.glb`) with bounded height normalization (`0.25..4.0`) and procedural fallback if GLB load fails.
- Updated HUD environment label/state to fixed `Env: Indoor Arena` to match the locked scene mode.

Retro visual style reinstatement + testability restore:
- Replaced the active indoor-arena baseline with the retro white-box chamber direction (large circular center room, short-wall hallways to side rooms, floating simple primitives).
- Added/retained stylized post-processing path in scene runtime (pixelation + color quantization + ordered dithering + scanline/vignette), with runtime toggle via `window.toggleRetroFx()`.
- Kept fly camera default and faster traversal speed (`FLY_MOVE_SPEED=22`) so large-room exploration remains practical.
- Confirmed core music testing path is still intact in this style:
  - typecheck + smoke pass
  - local bot claim/write success
  - listener playback and analyzer telemetry visible during Playwright validation.

## 2026-02-12

## Summary

Security and repo-hygiene cleanup pass:
- Locked down `POST /api/activity` and `DELETE /api/activity` (auth required).
- Enforced bounded payload validation for activity entries and server-side ID/timestamp assignment.
- Removed HTML log injection path in the Void client activity feed by rendering log entries as text nodes.
- Removed obsolete `test/llm-orchestra.ts` script and stale root `index.ts` placeholder entrypoint.
- Updated docs/scripts references to use `test:stress` as the active LLM test path.
- Added CI gates before deploy (`typecheck` + API smoke test) and made Fly deploy depend on them.
- Refactored `test/llm-stress-test.ts` from round-robin turns to concurrent per-bot runtime loops with preflight cooldown checks.
- Added staged activity phases (`intent`, `travel`, `thinking`, `submitting`) before terminal write outcomes to better mirror live avatar/action timing.
- Updated activity result schema and dashboard log handling to display the new non-terminal phases.
- Added admin reset endpoint `POST /api/admin/reset` (admin-key auth) to clear in-memory runtime state without restarting Fly machines.
- Added reset utility script (`bun run admin:reset` / `bun run admin:reset:live`) for faster ops.
- Fixed Fly deploy packaging gap by copying `public/` into the image (`Dockerfile`), resolving `/models/*` 404s for instruments/avatars.
- Consolidated doc sources under `docs/`:
  - design hub moved to `docs/design/design-hub.md`
  - skill moved to `docs/integration/SKILL.md`
  - added `docs/README.md` and `docs/ops-runbook.md`

## Operational notes (2026-02-12)

- In-memory state persists after stress tests; stopping the test process does not clear slots.
- Use `POST /api/admin/reset` (or `bun run admin:reset:live`) to clear live runtime state.
- Audio playback in browser is user-gated; click `Listen` after slots populate.

## Follow-up pass (2026-02-12)

Listener UX additions:
- Added local mixer drawer (`client/js/music.js`, `client/js/ui.js`) with master + per-slot gain, mute, and solo. State is listener-local only.
- Added orbit/fly camera toggle (`client/js/scene.js`, `client/js/app.js`) with pointer-lock look and WASD/E/Q movement.

Bot freedom and integration updates:
- Validator shifted from strict allowlist to safety-focused permissive mode with `MAX_CODE_CHARS=560`.
- Added hard bans for `samples()` and `soundAlias()` alongside `voicings()`.
- Added `server/sound-library.ts` and exposed sound hints via `GET /api/context` + `GET /api/sounds`.
- Updated `docs/integration/SKILL.md` with:
  - empty-slot-first targeting policy
  - sound exploration policy using full library hints
  - heartbeat bootstrap section instructing bots to add/merge a SynthMob loop into `HEARTBEAT.md`
  - dynamic iteration guidance (micro-variation + 1->2->4->8 phrase expansion ladder)

Stress harness alignment:
- Updated `test/llm-stress-test.ts` to skill-first behavior while retaining personality/strategy injection.

## Runtime + UX stabilization pass (2026-02-12)

Runtime hardening (Strudel edge cases):
- Added/expanded server-side rejection for patterns that caused live playback breakage:
  - unsupported `space()` (use `room()`)
  - unsupported `feedback()` (use `delayfeedback()`)
  - unstable mini-notation comma forms (for example `hh(1/4,1/8)`, `note("<c4,e4,a4>")`)
- Added client-side defensive rewrites so legacy/bad slot code does not kill full-stack playback:
  - `.space(...)` -> `.room(...)`
  - `.feedback(...)` -> `.delayfeedback(...)`
- Updated skill guidance and smoke tests to include these failure/replacement cases.

Fly/runtime operations:
- Configured live admin reset secrets on Fly (`RESET_ADMIN_KEY` / `ACTIVITY_ADMIN_KEY`) so `bun run admin:reset:live` works reliably.
- Adjusted stream response headers for better proxy compatibility and reduced console noise from favicon requests.

Listener legibility pass:
- Reduced on-screen activity noise by suppressing intermediate bot workflow chatter (`intent`, `travel`, `thinking`, `submitting`, `cooldown`) in the HUD log.
- Kept reasoning visibility focused on meaningful composition intent (`thinking` + `claimed`).
- Made avatar thought bubbles persistent while a bot holds a slot (instead of auto-clearing after a few seconds).
- Increased thought bubble readability (larger bubble, more wrapped lines, less truncation).
- Slot control panel now shows full recent thought text (no short 120-char clip).
- Added per-slot scene meters near instruments as visual activity indicators (animated by active slot state).

## 2026-02-11

## Summary

Major milestone session. The project moved from a flat listener UI to a Three.js "Void" client scaffold, added LLM stress tooling and bot observability, hardened Strudel validation against real-world model failures, and shipped to Fly.io.

## Snapshot

- Deployment target: Fly.io (`https://synthmob.fly.dev/`)
- Runtime: Bun + Hono
- Default local port: `5555`
- Slot model: 8 slots (in-memory, single instance)
- Audio runtime: `@strudel/repl@1.1.0`

## Changes by area

### Infrastructure and deployment

- Migrated deployment path from Vercel-oriented config to Fly.io.
- Added:
  - `Dockerfile` (Bun Alpine image)
  - `fly.toml` (single machine, 256MB, EWR)
  - `.dockerignore`
- Operational constraint: app scaled to **1 machine** while state remains in-memory.

### Audio engine integration

- Evaluated two integration paths:
  - `@strudel/web` (headless API) - rejected for this setup due to sample-loading reliability issues.
  - `@strudel/repl` web component - adopted.
- Confirmed working playback API:
  - Start/evaluate: `el.editor.evaluate()`
  - Stop: `el.editor.repl.stop()`
- Requirement discovered: the `<strudel-editor>` must exist/render in DOM (can be offscreen, not `display:none`).
- Added diagnostic page: `client/strudel-test.html`.

### Real-time transport

- SSE on Fly.io is intermittent under HTTP/2 proxy paths (`ERR_HTTP2_PROTOCOL_ERROR`).
- Mitigations applied:
  - `X-Accel-Buffering: no`
  - 15s heartbeat
  - reconnect loop
- Client strategy now: SSE + background reconnect + 5s polling fallback.

### LLM testing

- Added an initial `llm-orchestra` script (later removed during cleanup in 2026-02-12).
- Added `test/llm-stress-test.ts` (12 bots across Opus/Sonnet/Haiku tiers).
- Stress test improvements:
  - strategy profiles (aggressive/collaborative/defensive)
  - structured output (`reasoning`, `pattern`)
  - retry with validator feedback
- Updated test prompts to load the skill file directly as the system skill block (now at `docs/integration/SKILL.md`).

### Observability and dashboard

- Added `POST/GET/DELETE /api/activity` for bot reasoning/event logs.
- Added in-memory activity buffer (capped at 500 entries).
- Added `bot_activity` SSE event broadcast.
- Added dashboard UI: `client/dashboard.html`.

### Validation and runtime hardening

Two production-critical failure modes were identified and fixed:

1. `voicings()` runtime crash in Strudel
- Symptom: one bad pattern kills shared `stack()` playback.
- Root cause: `voicings()` output mismatch in current Strudel runtime.
- Fixes:
  - remove `voicings` from validator allowlist
  - update bot guidance to pre-spelled note voicings
  - client-side sanitizer excludes `.voicings(...)` patterns as defense-in-depth

2. Unquoted mini-notation parser crash
- Symptom: patterns like `note(<[a3 c4]>)` crashed Strudel parser.
- Root cause: validator previously matched only quoted string args.
- Fixes:
  - validator check for quoted first args in `s()`, `note()`, `n()`
  - client auto-fix for common unquoted angle-bracket form
  - SKILL guidance updated

### Frontend: Three.js "Void" scaffold

- Replaced flat default listener page with modular Three.js client.
- Added modules:
  - `client/js/scene.js`
  - `client/js/instruments.js`
  - `client/js/avatars.js`
  - `client/js/music.js`
  - `client/js/api.js`
  - `client/js/ui.js`
  - `client/js/app.js`
  - `client/js/debug.js`
- Added stylesheet: `client/css/void.css`.
- Preserved legacy UI as `client/classic.html`.
- Added model static route in server for `/models/*` from `public/`.
- Added overwrite "drama" animation flow in avatar system.

## Known issues (still open)

1. SSE reliability on Fly.io under HTTP/2 proxy conditions.
2. Avatar retargeting mismatch (`THREE.PropertyBinding: No target node found`) due to remaining track/bone name incompatibilities.
3. In-memory state prevents safe horizontal scaling (requires Redis/Postgres migration).

## Key commands used in this cycle

```bash
flyctl deploy
bun run test:stress
```

## Files touched (high-level)

Added:
- `Dockerfile`
- `fly.toml`
- `.dockerignore`
- `client/strudel-test.html`
- `test/llm-stress-test.ts`
- `client/dashboard.html`
- `client/classic.html`
- `client/js/*`
- `client/css/void.css`

Modified:
- `client/index.html`
- `server/index.ts`
- `server/routes.ts`
- `server/state.ts`
- `server/validator.ts`
- `package.json`
- `docs/integration/SKILL.md`

## Next focus

1. Stabilize live transport (WebSocket migration or Fly-specific SSE handling improvements).
2. Finish avatar animation retargeting diagnostics and track rewrite mapping.
3. Begin persistence migration planning for Phase 2 (Redis/Postgres).
