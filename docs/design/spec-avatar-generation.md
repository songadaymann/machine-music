# Avatar Generation (Meshy Pipeline)

Status: Phase A — backend pipeline live (no payment)
Last updated: February 21, 2026

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

## Animation retargeting experiments (Retargeting Lab)

The `client/retargeting-lab/` directory contains experiments to auto-rig Meshy-generated meshes for animation playback. Goal: take a static Meshy GLB and produce a rigged, animated character.

### Approaches tested

1. **Blender auto-rig** — Abandoned. Cannot match Mixamo-quality skeleton placement regardless of parameter tuning.

2. **Mixamo REST API** — Abandoned. Marker coordinate space is opaque and mesh-dependent. Upload must be FBX (not GLB). Rigging landmark positions don't generalize across different body shapes.

3. **Mixamo Vision-Rig** (`mixamo-vision-rig.ts`) — Works end-to-end via Playwright + vision LLM, but arm marker placement accuracy is poor. Knees and groin land correctly; wrists and elbows consistently miss (land outside the WebGL canvas area). Root cause: dialog screenshot includes sidebar/panel zones that are wider than the 3D viewport. 6+ successful runs completed with intercepted rig payloads captured.

4. **Anything World "Animate Anything" API** (`anything-world-rig.ts`) — **Current best approach. Works end-to-end.** Upload GLB → auto-rig → download rigged FBX + animation GLBs. Rigging completes in ~4 minutes with full skeleton (including finger bones). 7 animations included: idle, walk, run, jump, jump_start, jump_fall, jump_end. Animation GLBs are ~3.4 MB each. Free tier has monthly credit limits. Env var: `ANIMATE_ANYTHING` in `.env`.

### Current status

Anything World produces high-quality rigs but is not yet integrated into the server pipeline. Next step: test animation quality in Three.js viewer and integrate as an alternative to Meshy's built-in rigging.

### Lab files

- `client/retargeting-lab/anything-world-rig.ts` — Anything World API pipeline (best results)
- `client/retargeting-lab/mixamo-vision-rig.ts` — Vision LLM + Playwright pipeline
- `client/retargeting-lab/mixamo-intercept.ts` — Playwright API traffic capture
- `client/retargeting-lab/mixamo-rig-pipeline.ts` — REST API pipeline (abandoned)
- `client/retargeting-lab/PROGRESS-SUMMARY.md` — Detailed experiment log
- `client/retargeting-lab/EXPERIMENT-MATRIX.md` — Comparison of rig approaches

## What's not built yet

- Payment flow (USDC/ETH)
- Persistent storage (R2/IPFS)
- Client-facing generation UI (modal, wallet connect, progress polling)
- NFT minting on first avatar
- Prompt moderation / safety filter
- Animation library mapping (Meshy has 586+ animations, we use idle + walk)
- Full Mixamo animation retargeting onto Meshy-rigged characters
- Anything World rig integration into server pipeline (experimental, works locally)

See `docs/archive/spec-avatar-generation.md` (original full spec) for the aspirational design including payment contracts, database schema, R2/IPFS storage, client UI flow, NFT integration, and cost projections.

## Source files

- `server/avatar-generation.ts` — Meshy API integration, order management
- `server/routes.ts` — avatar API endpoints
- `client/js/avatars.js` — runtime avatar loading, animation retargeting, procedural fallback
- `client/retargeting-lab/` — animation retargeting experiments (see above)
