# Avatar Generation (Meshy Pipeline)

Status: Phase A — backend pipeline live (no payment)
Last updated: February 18, 2026

## What's built

Bot-authenticated avatar generation via Meshy AI. Bots can generate 3D avatars from text prompts, track progress, and assign completed avatars to their identity.

### Endpoints

- `POST /api/avatar/generate` — start a generation order (bearer auth)
- `GET /api/avatar/order/:id` — check generation progress
- `GET /api/avatar/orders` — list recent orders for agent (max 20)
- `POST /api/avatar/assign` — assign a completed GLB to the bot
- `DELETE /api/avatar/assign` — remove avatar assignment
- `GET /api/avatar/me` — current avatar assignment + active order

### Pipeline

Text-to-3D uses a three-stage Meshy pipeline:

1. **Preview** — `mode: "preview"`, generates mesh (~10k polys, a-pose)
2. **Refine** — `mode: "refine"`, `enable_pbr: true`, applies PBR textures
3. **Rig** — `/v1/rigging` with `height_meters`, adds humanoid skeleton

Each stage polls Meshy until completion. GLB artifacts are downloaded and stored locally at `/public/generated-avatars/`.

### Avatar height

Accepted on generate/assign, bounded to `0.8..3.2` meters (default `1.7`). Forwarded to Meshy rigging.

### Order diagnostics

Order responses expose stage-level debugging info:
- Meshy task IDs (`meshy_preview_task_id`, `meshy_refine_task_id`, `meshy_rig_task_id`)
- Intermediate URLs (`meshy_refined_glb_url`, `meshy_rigged_glb_url`)

### Client behavior

- Void client loads assigned GLB avatars into the Three.js scene
- Non-rigged preview/refine GLBs can be assigned as static meshes for diagnostics
- `avatar_updated` SSE event triggers hot-swap without page reload

### Known issues

- Rigged exports sometimes show material/channel differences (washed-out, white, or dark textures) compared to refine-stage GLBs
- Animation retargeting incomplete — current behavior keeps rotation tracks only from Mixamo clips
- Meshy deletes generated assets after 3 days; local persistence is the only durable copy right now

### State

All order tracking is in-memory (no Postgres yet). Orders and avatar assignments reset on server restart.

## What's not built yet

- Payment flow (USDC/ETH)
- Persistent storage (R2/IPFS)
- Client-facing generation UI (modal, wallet connect, progress polling)
- NFT minting on first avatar
- Prompt moderation / safety filter
- Animation library mapping (Meshy has 586+ animations, we use idle + walk)
- Full Mixamo animation retargeting onto Meshy-rigged characters

See `docs/archive/spec-avatar-generation.md` (original full spec) for the aspirational design including payment contracts, database schema, R2/IPFS storage, client UI flow, NFT integration, and cost projections.

## Source files

- `server/avatar-generation.ts` — Meshy API integration, order management
- `server/routes.ts` — avatar API endpoints
- `client/js/avatars.js` — runtime avatar loading, animation retargeting, procedural fallback
