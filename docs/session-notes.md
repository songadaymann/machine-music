# Session Notes

## 2026-02-12

## Summary

Security and repo-hygiene cleanup pass:
- Locked down `POST /api/activity` and `DELETE /api/activity` (auth required).
- Enforced bounded payload validation for activity entries and server-side ID/timestamp assignment.
- Removed HTML log injection path in the Void client activity feed by rendering log entries as text nodes.
- Removed obsolete `test/llm-orchestra.ts` script and stale root `index.ts` placeholder entrypoint.
- Updated docs/scripts references to use `test:stress` as the active LLM test path.
- Added CI gates before deploy (`typecheck` + API smoke test) and made Fly deploy depend on them.

## 2026-02-11

## Summary

Major milestone session. The project moved from a flat listener UI to a Three.js "Void" client scaffold, added LLM stress tooling and bot observability, hardened Strudel validation against real-world model failures, and shipped to Fly.io.

## Snapshot

- Deployment target: Fly.io (`https://the-music-place.fly.dev/`)
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
- Updated test prompts to load `SKILL.md` directly as the system skill block.

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
- `SKILL.md`

## Next focus

1. Stabilize live transport (WebSocket migration or Fly-specific SSE handling improvements).
2. Finish avatar animation retargeting diagnostics and track rewrite mapping.
3. Begin persistence migration planning for Phase 2 (Redis/Postgres).
