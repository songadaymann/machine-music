# Retargeting Lab

This folder is intentionally isolated from the runtime avatar system.

Use it to test different animation retargeting approaches without changing `client/js/avatars.js`.

## Lab docs

- `PLAYBOOK.md`: core strategy for rigging + retargeting Mixamo animations to arbitrary avatars.
- `EXPERIMENT-MATRIX.md`: concrete experiments, acceptance criteria, and fail-signatures.
- `PROGRESS-SUMMARY.md`: running log of implemented changes, runs, findings, and next steps.
- `bone-map.mixamo-core.json`: starter bone-map template for deterministic tests.
- `generate-meshy-refine-batch.ts`: batch generator + consistency auditor for 5 refine-only Meshy outputs.
- `generate-gemini-meshy-single.ts`: single-sample pipeline using Gemini image generation (Nano Banana) as Meshy image-to-3d input.
- `mixamo-vision-rig.ts`: Vision LLM + Playwright auto-rig pipeline — uploads mesh to Mixamo, screenshots the marker screen, uses Gemini Vision to identify body landmarks, clicks them via Playwright.
- `mixamo-rig-pipeline.ts`: REST API pipeline (upload works, marker coords abandoned — see vision-rig).
- `mixamo-intercept.ts`: Playwright API traffic capture for reverse-engineering Mixamo's flow.
- `nano-banana-tpose-spec.streetwear-man.json`: JSON character spec used to force neutral-background full-body T-pose references.
- `rig-sweep.config.json`: variable sets for autorig sweep experiments.
- `run-rig-sweep.ts`: runs variants against refine outputs and scores rig/clip compatibility.
- `publish-rig-sweep-to-test-env.ts`: publishes rig sweep outputs into `/generated-avatars/retargeting-lab/` and writes viewer manifest.

## Sandbox files

- `test-rig.html`: standalone Three.js rig/animation sandbox.

## How to run

1. Start the app (`bun run dev`).
2. Open `http://localhost:5555/retargeting-lab/`.
3. Run experiments in `test-rig.html`.
4. Keep all failures and fixes in this folder until behavior is repeatable.
5. Promote only proven logic into runtime code.

## Batch generation command

```bash
set -a; source .env; bun run client/retargeting-lab/generate-meshy-refine-batch.ts
```

## Gemini image -> Meshy single-sample command

```bash
set -a; source .env; set +a
bun run client/retargeting-lab/generate-gemini-meshy-single.ts
```

Optional:

- `RETARGETING_LAB_CHARACTER_SPEC=client/retargeting-lab/nano-banana-tpose-spec.streetwear-man.json`
- `RETARGETING_LAB_OUTPUT_DIR=output/retargeting-lab/gemini-meshy-single-...`

## Rig sweep command

```bash
set -a; source .env
bun run client/retargeting-lab/run-rig-sweep.ts
```

Optional:

- `MESHY_REFINEMENT_BATCH_DIR=output/retargeting-lab/meshy-refine-batch-...`
- `BLENDER_BIN=/Applications/Blender.app/Contents/MacOS/Blender`
- `RIG_SWEEP_LIMIT_VARIANTS=1 RIG_SWEEP_LIMIT_SAMPLES=1` for fast smoke checks

## Vision-Rig (Mixamo auto-rig via Vision LLM + Playwright)

```bash
set -a; source .env; set +a
bun run client/retargeting-lab/mixamo-vision-rig.ts
```

Optional:

- `MIXAMO_INPUT_GLB=path/to/mesh.glb`
- `BLENDER_BIN=/Applications/Blender.app/Contents/MacOS/Blender`
- `GEMINI_VISION_MODEL=gemini-2.5-flash` (default)
- `MIXAMO_VISION_MAX_RETRIES=2` (default)
- `MIXAMO_KEEP_BROWSER=1` (keep browser open for debugging)
- `MIXAMO_TOKEN=...` or `MIXAMO_TOKEN_FILE=...` (skip interactive login)

## Publish to test viewer

```bash
bun run client/retargeting-lab/publish-rig-sweep-to-test-env.ts
```

Optional:

- `RIG_SWEEP_DIR=output/retargeting-lab/rig-sweep-...`
