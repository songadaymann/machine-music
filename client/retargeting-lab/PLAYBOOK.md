# Retargeting Lab Playbook

Last updated: February 15, 2026

## Purpose

This playbook incorporates our current strategy for programmatic rigging and Mixamo retargeting.
It is intentionally scoped to lab work, not runtime integration.

## Executive summary

- Mixamo reuse is mainly a skeleton compatibility problem, not an FBX import problem.
- High quality depends on:
  - stable humanoid skeleton contract (bones, hierarchy, rest pose, joint orientation)
  - deterministic retargeting (bone map, rest-pose offsets, translation policy)
  - deformation quality controls (weights, twist handling, correctives)
- For production, prefer offline preprocessing and baking. Runtime retargeting should be limited to onboarding or diagnostics.

## Hard requirements

- Canonical humanoid skeleton definition:
  - required bone list
  - canonical hierarchy
  - canonical rest pose
  - joint orientation convention
- Deterministic retargeting inputs:
  - `boneMap` source to target
  - source and target rest transforms
  - root translation policy
  - scale compensation policy
- Deformation validation:
  - max influences per vertex
  - weight normalization
  - shoulder/elbow/wrist QA poses

## Non-obvious constraints to capture per experiment

- Avatar is humanoid vs non-humanoid.
- Avatar is pre-rigged vs unrigged.
- Finger bones and facial blendshapes present or absent.
- Tool/runtime versions used (for reproducibility).
- OS/runtime environment (Linux/macOS/Windows, headless availability).

## Retargeting algorithm baseline

Use rest-pose delta retargeting, not absolute rotation copying.

For each mapped bone:

1. Compute source delta rotation relative to source rest pose.
2. Apply that delta on top of target rest pose.
3. Apply per-bone orientation correction offset if needed.
4. Keep non-root translation at rest translation unless explicitly trusted.
5. Handle root translation separately using a defined scale policy.

This is the default baseline for all experiments.

## Translation and scale policy

- Root motion:
  - preserve trajectory, with optional scale by character ratio.
- Non-root translation:
  - default to rest translation.
- Proportion mismatch handling:
  - leg-length scaling for locomotion.
  - optional stride warping.
  - optional IK for foot and hand contact.

## IK policy

- IK is for contact correction after FK retarget.
- Primary use cases:
  - foot locking
  - hand target alignment
- Solver options:
  - two-bone analytic IK for arms/legs
  - FABRIK or CCD for longer chains
- If runtime cost is high, bake IK corrections offline.

## Deformation quality policy

Most visual failures come from skinning/weights.

Minimum quality controls:

- normalize and prune weights
- enforce influence limit
- add forearm/upper-arm twist handling
- shoulder volume correction strategy (corrective shapes or helper bones)

Optional higher quality:

- dual quaternion skinning where supported
- pose-space corrective deformation

## Interop and format policy

- Mixamo source usually arrives as FBX.
- Web distribution target should be GLB.
- Convert early to canonical format for downstream stability.
- Keep canonical intermediate artifacts for reprocessing.

## Performance policy

- Prefer offline bake and compression.
- Reduce bone counts for distant LODs.
- Limit influences for web/mobile targets.
- Use per-bone compression thresholds.

## Licensing and distribution guardrail

- Treat Mixamo files as licensed source assets used inside shipped experiences.
- Do not build product flows that redistribute raw Mixamo libraries as standalone downloadable assets.
- If product behavior resembles an animation CDN, escalate for legal review before shipping.

## Recommended pipeline shapes

### A) Game engine + many UGC avatars

- Ingest -> normalize -> rig/canonicalize -> retarget offline -> bake -> engine-native package.
- Runtime should mostly play preprocessed clips.

### B) WebGL/three.js real-time avatars

- Standardize on GLB for delivery.
- Prefer canonical skeleton at ingest.
- Keep runtime retarget minimal; use lab-proven fallback only.

### C) Offline studio content

- Use DCC-heavy workflow, cleanup and correctives, then export baked deliverables.

## Failure signatures and likely causes

- 90-degree limb twists:
  - local/global frame mismatch or joint orientation mismatch.
- Feet sliding:
  - root motion policy mismatch or scale mismatch.
- Elbow/shoulder collapse:
  - weak weights and missing twist/correctives.
- Fingers static:
  - missing keys or incomplete finger mapping.
- Face broken after conversion:
  - blendshape path dropped in export/import.

## What must be true before runtime integration

- Same input set passes twice with identical outputs.
- Bone-map and policy are versioned.
- Core clips (`idle`, `walk`, slot motions, drama motions) pass visual QA.
- Failure mode is bounded and logged for outlier rigs.
