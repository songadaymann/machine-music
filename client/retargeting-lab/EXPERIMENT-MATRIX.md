# Retargeting Lab Experiment Matrix

Last updated: February 16, 2026

## Goal

Establish one repeatable retarget path from Mixamo animations to arbitrary humanoid avatars with measurable pass/fail criteria.

## Core test set

- Avatar A: Mixamo-native rig (control)
- Avatar B: Meshy rigged output
- Avatar C: Non-Mixamo humanoid rig with naming differences
- Clips:
  - `idle`
  - `walk`
  - slot clip (for example `drums`)
  - drama clip (for example `punch` or `fallingDown`)

## Experiment 1: Bone map only

- Setup:
  - static bone map, no IK, no corrective deformation.
- Pass criteria:
  - no major explosions or detached limbs.
  - orientation errors less than obvious 90/180 degree failures.
- Fail signatures:
  - persistent limb roll offsets
  - incorrect root orientation

## Experiment 2: Rest-pose delta method

- Setup:
  - apply rest-pose delta retarget per mapped bone.
- Pass criteria:
  - improved shoulder and elbow orientation vs experiment 1.
  - no systematic pose bias (for example constant bent arms).
- Fail signatures:
  - whole-body lean/offset in all clips
  - fixed-angle limb offset in all frames

## Experiment 3: Translation policy variants

- Setup:
  - compare root-only translation vs copied limb translations.
- Pass criteria:
  - root-only policy reduces drift and preserves contact better.
- Fail signatures:
  - feet floating
  - locomotion scale mismatch

## Experiment 4: IK foot lock

- Setup:
  - FK retarget followed by foot contact correction.
- Pass criteria:
  - reduced stance-phase foot slide on walk cycle.
- Fail signatures:
  - knee popping
  - foot jitter from unstable target normals

## Experiment 5: Weight cleanup and deformation checks

- Setup:
  - normalize/prune weights and enforce influence cap.
- Pass criteria:
  - visible reduction of elbow/shoulder collapse.
- Fail signatures:
  - candy-wrapper forearm twist
  - shoulder volume collapse at arm raise

## Required metrics

- Foot slide distance during contact windows.
- Clip-level failure count by category:
  - orientation
  - translation
  - deformation
- Determinism check:
  - same input pair yields same output hash/signature.

## Promotion gate to production runtime

All items must be true:

- The same retarget config passes all three avatars in core test set.
- Walk and at least one slot clip pass without critical visual failures.
- Retarget outputs are deterministic across two runs.
- Policy and mapping are documented and versioned in this folder.

## Execution harness

- Refine-only batch input: `generate-meshy-refine-batch.ts`
- Rig sweep runner: `run-rig-sweep.ts`
- Variable definitions: `rig-sweep.config.json`

The sweep report provides per-variant, per-sample metrics:

- rig success/failure
- required Mixamo core bone coverage
- clip target-name coverage (`idle`, `walk`, selected action clips)
- non-uniform/negative scale node checks

## Baseline findings (February 15, 2026)

### Meshy refine-only batch (5 samples, no rigging)

Artifacts:

- `output/retargeting-lab/meshy-refine-batch-2026-02-15T17-58-43-661Z/comparison-report.md`
- `output/retargeting-lab/meshy-refine-batch-2026-02-15T17-58-43-661Z/summary.json`

Consistent across all 5:

- 1 mesh, 1 primitive, 1 material
- 3 textures/images at max 2048
- PBR channels present: baseColor + metallicRoughness + normal
- PBR channels absent: occlusion + emissive
- UV0 + normals present, tangents absent
- bounds height = 2.0
- no skin, no animation, no non-uniform or negative node scale

Inconsistent across samples:

- vertices: 11,101 to 12,500
- triangles: 9,951 to 9,995
- width (X): 0.671587 to 1.564103
- depth (Z): 0.417561 to 1.033219

Implication:

- Meshy preview/refine output is structurally consistent, but silhouette/proportions vary heavily. Any retarget path must be robust to large width/depth differences even when nominal height is fixed.

### Rig sweep (5 variants x 5 samples)

Artifacts:

- `output/retargeting-lab/rig-sweep-2026-02-15T20-43-57-081Z/rig-sweep-report.md`
- `output/retargeting-lab/rig-sweep-2026-02-15T20-43-57-081Z/rig-sweep-summary.json`

Observed:

- all 25 runs succeeded
- all variants produced 23-joint skins
- required Mixamo core coverage: 100% in all runs
- idle/walk/drums target-name coverage stayed flat at 42.3% (22/52)
- punch coverage stayed flat at 52.4% (22/42)
- coverage gap is entirely finger chains (`Left/RightHandThumb/Index/Middle/Ring/Pinky*`)

Implication:

- Current sweep variables (arm placement and weight falloff) do not change compatibility metrics.
- Next phase needs metrics that capture deformation/contact quality, not just skeleton-name coverage.

## Unknowns to turn into controllable variables

Priority order for next lab iteration:

1. **Rest pose alignment**
   - variables: shoulder elevation, arm angle, elbow pre-bend, wrist orientation.
   - success metric: reduced constant offset in first frame of retargeted `idle`.
2. **Joint orientation conventions**
   - variables: per-limb local axis correction offsets.
   - success metric: reduced 90/180 degree twist failures in `punch`.
3. **Translation policy**
   - variables: root-only translation vs selected child translation copying.
   - success metric: lower foot drift in `walk`.
4. **Weight/deformation policy**
   - variables: influence cap, twist distribution, cleanup threshold.
   - success metric: lower elbow/shoulder collapse score on extreme poses.
5. **Optional IK correction**
   - variables: foot lock enable, contact window threshold, IK blend weight.
   - success metric: lower stance-phase slide without knee popping.

## Latest visual verdict (February 16, 2026)

### Template-rig 3-way sweep (single Gemini T-pose sample)

Artifacts:

- `output/retargeting-lab/rig-sweep-2026-02-16T16-06-25-627Z/rig-sweep-report.md`
- `output/retargeting-lab/rig-sweep-2026-02-16T16-06-25-627Z/rig-sweep-summary.json`
- `output/retargeting-lab/visual-check-2026-02-16T16-08-50-345Z`

Variants evaluated:

- `template-distance-core`
- `template-distance-tight`
- `template-distance-full`

Observed:

- All 3 variants are structurally valid in metrics:
  - 53-bone skin
  - 100% required core coverage
  - 100% target-name clip coverage for tested clips
- All 3 variants still fail visual acceptance for gameplay use.
- `template-distance-full` remains worst due to obvious hand/finger artifacts.
- `template-distance-core` and `template-distance-tight` are less broken but still visibly off in posture/deformation.

Conclusion:

- We are blocked on visual retarget quality, not naming coverage.
- The next pass must prioritize rest-pose and joint-orientation alignment (not additional coverage-based sweep variants).
