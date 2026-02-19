# Retargeting Lab Progress Summary

Last updated: February 16, 2026

## Scope

This document tracks what has been implemented and tested in `client/retargeting-lab` so far, with concrete artifact paths.

## What We Built

- Added refine-only Meshy batch generator:
  - `client/retargeting-lab/generate-meshy-refine-batch.ts`
- Added Gemini-to-Meshy single-sample generator (image-first path):
  - `client/retargeting-lab/generate-gemini-meshy-single.ts`
  - `client/retargeting-lab/nano-banana-tpose-spec.streetwear-man.json`
- Added config-driven rig sweep runner:
  - `client/retargeting-lab/run-rig-sweep.ts`
  - `client/retargeting-lab/rig-sweep.config.json`
- Added sweep publisher for the visual sandbox:
  - `client/retargeting-lab/publish-rig-sweep-to-test-env.ts`
- Expanded the visual sandbox so we can switch models and test clip behavior:
  - `client/retargeting-lab/test-rig.html`
- Added explicit Meshy preview pose mode (`t-pose`) in all preview calls:
  - `client/retargeting-lab/generate-meshy-refine-batch.ts`
  - `server/avatar-generation.ts`
  - `test/meshy-refine-only.ts`
- Updated Blender autorig to try bone-heat skinning with fallback to distance skinning:
  - `scripts/blender-autorig.py`

## Major Runs And Artifacts

1. Refine-only batch (prompt asks for T-pose, no explicit `pose_mode` yet)
   - `output/retargeting-lab/meshy-refine-batch-2026-02-15T17-58-43-661Z`
   - Report: `output/retargeting-lab/meshy-refine-batch-2026-02-15T17-58-43-661Z/comparison-report.md`
2. First full rig sweep on that batch
   - `output/retargeting-lab/rig-sweep-2026-02-15T20-43-57-081Z`
   - Report: `output/retargeting-lab/rig-sweep-2026-02-15T20-43-57-081Z/rig-sweep-report.md`
3. Refine-only batch with explicit Meshy `pose_mode: "t-pose"`
   - `output/retargeting-lab/meshy-refine-batch-2026-02-16T00-35-38-489Z`
   - Report: `output/retargeting-lab/meshy-refine-batch-2026-02-16T00-35-38-489Z/comparison-report.md`
   - Summary: `output/retargeting-lab/meshy-refine-batch-2026-02-16T00-35-38-489Z/summary.json`
4. Full rig sweep on the explicit `pose_mode` batch
   - `output/retargeting-lab/rig-sweep-2026-02-16T00-52-31-663Z`
   - Report: `output/retargeting-lab/rig-sweep-2026-02-16T00-52-31-663Z/rig-sweep-report.md`
5. Published visual test set for sandbox model dropdown
   - `public/generated-avatars/retargeting-lab/manifest.json`
   - Viewer: `http://localhost:5555/retargeting-lab/test-rig.html`
6. Gemini (Nano Banana) image-first single sample -> Meshy image-to-3d
   - `output/retargeting-lab/gemini-meshy-single-2026-02-16T01-35-19-550Z/streetwear-man`
   - Reference image: `output/retargeting-lab/gemini-meshy-single-2026-02-16T01-35-19-550Z/streetwear-man/reference-image.png`
   - Meshy preview image: `output/retargeting-lab/gemini-meshy-single-2026-02-16T01-35-19-550Z/streetwear-man/meshy-preview.png`
   - Mesh output: `output/retargeting-lab/gemini-meshy-single-2026-02-16T01-35-19-550Z/streetwear-man/streetwear-man-image-to-3d.glb`

## Findings So Far

- Meshy refine-only outputs are structurally consistent:
  - one mesh, one primitive, one material
  - 3 images/textures
  - PBR usage includes baseColor + metallicRoughness + normal
- Mesh proportions vary significantly across prompts even when height is normalized.
- Rig sweep compatibility metrics remain flat across current rig variants:
  - required core bone coverage remains 100%
  - idle target-name coverage remains 42.3%
- The target-name coverage gap is dominated by missing finger chains in our generated rig (expected with current 23-bone setup).
- Visual deformation improved when using rest-pose-delta retargeting in the sandbox versus direct rotation copy, but many non-locomotion clips are still far off.
- Bone-heat skinning is unreliable for many generated meshes; fallback distance skinning is often used.
- Prompted T-pose alone was not reliable; explicit `pose_mode: "t-pose"` is now wired in.
- Gemini image generation with JSON-constrained prompt produced a clean, full-body, neutral-background T-pose reference image in the first sample.

## Follow-up Rigging Pass (February 16, 2026)

- Updated autorig implementation to support meaningful policy variables for template-rig sweeps:
  - `distance_weight_bone_scope` (`core` vs `all`)
  - `max_influences` (configurable influence cap)
  - `distance_calibrate_from_armature` (derive gating refs from the actual fitted rig)
- Added mesh cleanup when merge-retrying bone-heat (`delete_loose`, `dissolve_degenerate`).
- Replaced sweep variants with policy-driven cases instead of shoulder-offset-only variants:
  - `template-heat`
  - `template-distance-core`
  - `template-distance-full`
  - `template-distance-tight`
  - `synthetic-distance-control`

Latest sweep:

- `output/retargeting-lab/rig-sweep-2026-02-16T02-24-14-764Z`

Key outcomes:

- Template variants now retain 53 joints and 100% target-name coverage.
- Synthetic control reproduces the old failure mode:
  - 23 joints
  - 42.3% idle coverage
  - visible deformation mismatch in the viewer.
- `template-distance-full` shows the expected finger-chain instability (severe hand artifacts), confirming variant differences are now real and not metric illusions.
- Visual comparison artifacts:
  - `output/retargeting-lab/visual-check-2026-02-16T02-24-59-511Z`

## Mesh-Proportional Bone Fitting (February 16, 2026 afternoon)

Added mesh silhouette analysis + per-limb-chain proportional bone adjustment to `scripts/blender-autorig.py`:

- `analyze_mesh_silhouette()` slices the mesh into 100 horizontal bands to detect arm tips, hip width, shoulder junction, and torso depth.
- `adjust_armature_proportions()` scales arm/leg bone chain X positions in edit mode to match detected mesh proportions (arm_scale, hip_scale).
- Controlled by config flag `mesh_proportional_fit` (default: true).
- Integration order: `fit_armature_to_model()` -> `adjust_armature_proportions()` -> `ensure_required_end_bones()` -> `calibrate_anatomy_refs_from_armature()`.

Sweep with proportional fit:

- `output/retargeting-lab/rig-sweep-2026-02-16T16-44-53-212Z`

Results:

- arm_scale=1.27 (skeleton arms stretched 27% wider to match mesh)
- hip_scale=2.38 (legs spread significantly to match actual hip width)
- calibrated leg_x improved from 0.044 to 0.106
- All variants still pass: 53 joints, 100% core coverage, 100% idle coverage
- **Visual verdict: minimal visible improvement.** The proportional fit corrects bone positions but does not fix the underlying deformation quality problem. The core issue is skin weight quality, not skeleton placement.

## Decision: Abandon Custom Blender Autorig for Rigging Quality

After exhaustive experimentation across multiple rigging approaches (synthetic armature, template armature, bone-heat skinning, distance skinning, proportional fitting, anatomy masks, influence capping), the conclusion is:

**Programmatic rigging in Blender cannot match Mixamo's auto-rig quality for arbitrary generated meshes.** The gap is in ML-based body landmark detection and heat-diffusion weight painting that Mixamo does server-side. No amount of geometric heuristics in our script closes this gap to gameplay-acceptable levels.

## Next Direction: Automate Mixamo via REST API

Research completed on automating Mixamo (mixamo.com) for programmatic rigging. Key findings:

### The Mixamo internal API still works

- Base URL: `https://www.mixamo.com/api/v1/`
- Auth: Adobe IMS OAuth bearer token + `X-Api-Key: mixamo2`
- Upload: `POST /characters` (multipart/form-data with mesh file)
- Poll: `GET /characters/{id}/monitor` until `status: "completed"`
- Export: `POST /animations/export` then poll monitor for download URL
- Token lifetime: 24 hours, extracted from `localStorage.access_token` after browser login

### Existing open-source projects

- **gnuton/mixamo_anims_downloader** (JS, browser console): includes `upload&download.js` with the character upload flow. Closest to what we need.
- **paulpierre/MixamoHarvester** (Python): full REST API client, bulk animation download, 5 concurrent threads, retry logic.
- **juanjo4martinez/mixamo-downloader** (Python/PySide2): embedded browser for token capture, REST API for downloads.

### Proposed pipeline

1. **Playwright** for Adobe OAuth login + bearer token capture (one-time, cached 24h)
2. **REST API** for upload -> auto-rig -> download loop (no browser needed per-character)
3. Converts FBX output back to GLB (via Blender headless or fbx2gltf)
4. Drop-in replacement for `scripts/blender-autorig.py` in the rig sweep pipeline

### Key unknown — RESOLVED (February 16, 2026)

Marker placement IS required. Confirmed via Playwright API intercept (`client/retargeting-lab/mixamo-intercept.ts`).

The full flow captured from a live session:

1. `POST /api/v1/characters` — upload mesh as multipart form (FBX)
   - Returns `{ uuid, job_type: "character_mapper" }`
2. `GET /api/v1/characters/{uuid}/monitor` — poll until `status: "completed"`
   - Character status becomes `"needs_rigging"`
3. `PUT /api/v1/characters/{uuid}/rig` — submit 7 marker coordinates as JSON:
   ```json
   {
     "rigging_inputs": {
       "chin":   { "x": -0.095, "y": 67.64, "z": 294.56 },
       "larm":   { "x": -71.33, "y": 57.91, "z": 294.56 },
       "rarm":   { "x": 71.14,  "y": 57.91, "z": 294.56 },
       "lelbow": { "x": -46.42, "y": 55.97, "z": 294.56 },
       "relbow": { "x": 46.23,  "y": 55.97, "z": 294.56 },
       "lknee":  { ... },
       "rknee":  { ... },
       "groin":  { ... }
     }
   }
   ```
   - Returns `{ uuid, job_type: "character_rigger" }`
4. `GET /api/v1/characters/{uuid}/monitor` — poll until `status: "completed"`
   - Character status becomes `"ready"`
5. `POST /api/v1/animations/stream` — request retargeted animation:
   ```json
   {
     "gms_hash": [{ "model-id": 118060902, "mirror": false, "trim": [0,100], "overdrive": 0, "params": "0,0", "arm-space": 0, "inplace": false }],
     "character_id": "{uuid}",
     "retargeting_payload": "CharacterSpace,motion;TposeAutofix,on;",
     "target_type": "skin"
   }
   ```

Key observations:
- All z values are identical (~294.56) — markers are 2D front-projection coordinates, not 3D mesh positions
- x values are symmetric around 0 for a centered T-pose mesh
- Coordinates appear to be in Mixamo's internal viewport space, not raw mesh local space
- The 7 marker field names are: `chin`, `larm`, `rarm`, `lelbow`, `relbow`, `lknee`, `rknee`, `groin`

### Risks

- Mixamo is in maintenance-only mode at Adobe. Service broke for 3+ days in June 2025 with zero notice.
- No official API documentation or support. Endpoints are reverse-engineered.
- Adobe TOS does not explicitly authorize programmatic access.
- Token refresh is undocumented; may need daily re-auth.

### Why this is the right path

- Mixamo's auto-rigger is purpose-built for exactly this use case (arbitrary humanoid mesh -> Mixamo-compatible rig)
- The existing Mixamo animation library (idle, walk, drums, bass, guitar, piano, punch, etc.) already works perfectly with Mixamo-rigged characters
- No retargeting needed when source rig and animation rig are both native Mixamo
- Eliminates the entire rest-pose-delta / bone-orientation / weight-quality problem stack

## Current Known Issues

- Many generated characters still do not hold a clean canonical T-pose suitable for robust retarget.
- Action/drama clips (for example punch/fall) still show significant artifacts after current retarget changes.
- Coverage metrics currently emphasize naming/structure, not deformation quality or contact quality.
- Custom Blender autorig is not viable for gameplay-quality rigging (see decision above).

## Repro Commands

Generate a 5-sample refine-only batch:

```bash
set -a; source .env; set +a
bun run client/retargeting-lab/generate-meshy-refine-batch.ts
```

Generate one Gemini image-first sample (Nano Banana -> Meshy image-to-3d):

```bash
set -a; source .env; set +a
bun run client/retargeting-lab/generate-gemini-meshy-single.ts
```

Run rig sweep against a chosen refine batch:

```bash
BLENDER_BIN=/Applications/Blender.app/Contents/MacOS/Blender \
MESHY_REFINEMENT_BATCH_DIR=output/retargeting-lab/meshy-refine-batch-<timestamp> \
bun run client/retargeting-lab/run-rig-sweep.ts
```

Publish latest (or selected) sweep to sandbox viewer:

```bash
RIG_SWEEP_DIR=output/retargeting-lab/rig-sweep-<timestamp> \
bun run client/retargeting-lab/publish-rig-sweep-to-test-env.ts
```

## Pipeline Progress (February 16, 2026 evening)

### What was built

- `client/retargeting-lab/mixamo-intercept.ts` — Playwright script that opens Mixamo, lets user complete the full flow (login → upload → markers → rig), and captures all API traffic. Successfully reverse-engineered the entire Mixamo API flow.
- `scripts/compute-mixamo-markers.py` — Blender headless script that analyzes a GLB mesh and computes 7 body landmark positions (chin, wrists, elbows, knees, groin) from vertex silhouette analysis.
- `client/retargeting-lab/mixamo-rig-pipeline.ts` — End-to-end pipeline: auth → Blender markers → GLB-to-FBX conversion → REST API upload → submit markers → poll → download rigged result.

### What worked

- API intercept captured the full Mixamo rig flow including the exact `PUT /api/v1/characters/{uuid}/rig` payload with `rigging_inputs` JSON.
- GLB→FBX conversion via Blender + FBX upload to Mixamo both succeed (`character_mapper` job completes).
- Auth token capture and reuse across runs works.
- Blender landmark detection produces reasonable body positions from vertex analysis.

### What failed: marker coordinate space

The `character_rigger` job fails when we submit computed markers. Two attempts:

1. **Scale 75.5** (calibrated from captured session): produced negative y values for knees/groin because our mesh is centered at origin (z_min=-1.0). Rig job failed.
2. **Scale 100 with y-offset** (shift mesh bottom to y=0, FBX cm scale): all-positive values but rig job still failed. The coordinate space is wrong.

Root cause: Mixamo's marker coordinates are in its internal viewer's projection space, which we cannot reverse-engineer from first principles. The captured coordinates were from a different mesh, so we can't calibrate a universal transform. The relationship between the uploaded FBX geometry and Mixamo's viewer coordinate system is opaque and possibly mesh-dependent (Mixamo may normalize/center meshes differently based on their bounding box).

### Decision: abandon computed-marker REST API approach

Trying to reverse-engineer Mixamo's internal viewport coordinate system is a dead end. Even if we got it right for one mesh, it might break for differently-proportioned meshes.

## Next Focus: Vision LLM + Playwright click automation

Instead of computing marker coordinates and submitting via REST API, use a **vision LLM to visually identify landmarks** and **Playwright to click them** directly on Mixamo's canvas. This eliminates the coordinate space problem entirely.

### Proposed flow (`client/retargeting-lab/mixamo-vision-rig.ts`)

1. **Playwright**: login → navigate to Mixamo → upload FBX via file input
2. **Playwright**: wait for marker placement screen to appear (the screen with crosshair markers and the 3D mesh preview)
3. **Screenshot**: capture the marker placement canvas
4. **Gemini Vision** (or Claude Vision): send screenshot with prompt like "Identify the pixel coordinates of: chin, left wrist, right wrist, left elbow, right elbow, left knee, right knee, groin on this humanoid character"
5. **Playwright**: click each returned position on the canvas element, in the order Mixamo expects
6. **Playwright**: click "Next" to trigger rigging
7. **Wait**: poll or watch for rigging completion
8. **Download**: either via REST API export endpoint or Playwright download button click

### Why this should work

- The vision LLM sees exactly what a human sees — a front-view rendering of the character
- Playwright clicks in pixel coordinates on the browser canvas — no coordinate transform needed
- Gemini and Claude are both very good at identifying body landmarks on humanoid figures
- Even if the LLM is off by a few pixels, Mixamo's auto-rigger is tolerant of approximate marker placement (humans aren't pixel-perfect either)
- Works for any mesh regardless of proportions, scale, or coordinate origin

### Key implementation details

- Mixamo's marker placement UI might require markers in a specific order (chin first, then wrists, etc.) — need to observe the UI flow
- The canvas element needs to be located by Playwright selector (likely a `<canvas>` inside a specific container)
- May need to wait for the 3D preview to finish rendering before screenshotting
- Gemini Vision API: `GEMINI_API_KEY` already in `.env`
- Return format: ask the LLM for JSON with pixel x,y for each landmark

### Existing assets to reuse

- `mixamo-rig-pipeline.ts` — GLB→FBX conversion, auth token capture, polling logic
- `mixamo-intercept.ts` — Playwright browser setup, Mixamo navigation patterns
- `.env` — `GEMINI_API_KEY` for vision API calls

### Risks

- Mixamo's UI could change (it's a React SPA, selectors may be fragile)
- Vision LLM might misidentify landmarks on unusual mesh shapes
- Slower per-character than pure REST (requires browser session per rig)
- Canvas click coordinates might need adjustment for element offset/scroll

## Implementation: Vision-Rig Pipeline (February 16, 2026)

`client/retargeting-lab/mixamo-vision-rig.ts` — full Playwright pipeline:

- **Playwright**: browser launch, auth token injection, upload via browser UI, marker screen, canvas click
- **Gemini Vision**: screenshot → structured prompt → JSON landmark coordinates → validation → retry
- **REST** (for post-rig steps): poll character_rigger, export/download rigged FBX, convert FBX→GLB

### Architecture decisions

1. **Full browser upload (not REST)**: The `update_primary` trick (REST upload → set as primary → reload) does NOT work. The SPA shows "SOMETHING WENT WRONG" when it tries to render a `needs_rigging` character set via REST. The marker placement screen only appears when uploading through the browser's own upload flow.
2. **Request interception**: `page.on("request")` captures the `PUT /rig` payload the browser fires, saving it as `intercepted-rig-payload.json` for debugging. Character UUID extracted from the rig URL or upload response.
3. **Geometric validation**: 8 sanity checks (bounds, vertical ordering, left/right mirroring, arm symmetry, knee symmetry) catch bad Vision LLM outputs before clicking.
4. **Retry with escalating prompts**: Up to 3 vision attempts with increasingly specific prompts on failure.

### Mixamo upload UI flow (discovered February 16, 2026)

The "UPLOAD CHARACTER" button does NOT directly open a file chooser. Instead:

1. Click "UPLOAD CHARACTER" button → opens a **modal dialog** titled "UPLOAD A CHARACTER"
2. Modal contains: instructions text, format badges (FBX, OBJ, ZIP), and a dashed-border drop zone
3. Inside the drop zone: **"Select character file"** link (orange text) triggers the actual file input
4. Alternatively: drag-and-drop a file onto the drop zone

**Current bug**: The script waits for `page.waitForEvent("filechooser")` after clicking "UPLOAD CHARACTER", but the file chooser only fires after clicking "Select character file" inside the modal. Fix needed in `uploadAndWaitForMarkerScreen()`:
- After clicking "UPLOAD CHARACTER", wait for the modal to appear
- Find the "Select character file" link inside the modal
- Set up `waitForEvent("filechooser")` THEN click that link
- Continue with `fileChooser.setFiles(absoluteFbxPath)`

### Selectors discovered

- Upload button: `button:has-text("UPLOAD CHARACTER")`
- Modal title: text "UPLOAD A CHARACTER"
- File select link: look for `a:has-text("Select character file")` or an element containing that text inside the modal drop zone
- The modal has a close "×" button in the top-right corner

### Key unknowns still to resolve

- Marker placement UI mechanics: guided (one at a time) vs. all-at-once? Click-to-place vs. drag-and-drop?
- Exact selectors for "Next" button on the marker screen (Mixamo uses minified React classes)
- Export download flow: does `POST /animations/export` return a monitor URL with download link?
