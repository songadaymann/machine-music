"""
Blender headless script: compute 7 Mixamo marker positions from a GLB mesh.

Usage:
  blender --background --python scripts/compute-mixamo-markers.py -- input.glb output.json

Outputs a JSON file with the 7 marker positions (chin, larm, rarm, lelbow, relbow,
lknee, rknee, groin) derived from mesh vertex analysis.

The coordinates are in the mesh's own space (Blender Z-up). The calling pipeline
is responsible for any coordinate-space transform needed for Mixamo's API.
"""

import bpy
import sys
import os
import json
from mathutils import Vector

# ---------------------------------------------------------------------------
# Parse CLI args
# ---------------------------------------------------------------------------
argv = sys.argv
if "--" in argv:
    args = argv[argv.index("--") + 1:]
else:
    args = []

if len(args) < 2:
    print("Usage: blender --background --python compute-mixamo-markers.py -- <input.glb> <output.json>")
    sys.exit(1)

INPUT_GLB = os.path.abspath(args[0])
OUTPUT_JSON = os.path.abspath(args[1])

# ---------------------------------------------------------------------------
# Clean scene and import
# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=INPUT_GLB)

mesh_objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not mesh_objects:
    print("[markers] ERROR: No mesh objects found in", INPUT_GLB)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Gather all world-space vertices
# ---------------------------------------------------------------------------
all_verts = []
depsgraph = bpy.context.evaluated_depsgraph_get()
for mesh_obj in mesh_objects:
    eval_obj = mesh_obj.evaluated_get(depsgraph)
    eval_mesh = eval_obj.to_mesh()
    wm = mesh_obj.matrix_world
    for vert in eval_mesh.vertices:
        all_verts.append((wm @ vert.co).copy())
    eval_obj.to_mesh_clear()

print(f"[markers] {len(all_verts)} vertices from {len(mesh_objects)} mesh object(s)")

# ---------------------------------------------------------------------------
# Compute bounding box
# ---------------------------------------------------------------------------
x_coords = [v.x for v in all_verts]
y_coords = [v.y for v in all_verts]
z_coords = [v.z for v in all_verts]

x_min, x_max = min(x_coords), max(x_coords)
y_min, y_max = min(y_coords), max(y_coords)
z_min, z_max = min(z_coords), max(z_coords)

# In Blender's Z-up space: X = left/right, Y = front/back, Z = up/down
height = z_max - z_min
width = x_max - x_min
center_x = (x_min + x_max) / 2.0
center_y = (y_min + y_max) / 2.0

print(f"[markers] Bounds: x=[{x_min:.4f}, {x_max:.4f}], y=[{y_min:.4f}, {y_max:.4f}], z=[{z_min:.4f}, {z_max:.4f}]")
print(f"[markers] Height={height:.4f}, Width={width:.4f}")

# ---------------------------------------------------------------------------
# Slice into horizontal bands for silhouette analysis
# ---------------------------------------------------------------------------
num_bands = 200
band_h = height / num_bands

class Band:
    __slots__ = ('x_min', 'x_max', 'y_min', 'y_max', 'count')
    def __init__(self):
        self.x_min = float('inf')
        self.x_max = float('-inf')
        self.y_min = float('inf')
        self.y_max = float('-inf')
        self.count = 0

bands = [Band() for _ in range(num_bands)]

for v in all_verts:
    idx = int((v.z - z_min) / band_h)
    idx = max(0, min(idx, num_bands - 1))
    b = bands[idx]
    if v.x < b.x_min: b.x_min = v.x
    if v.x > b.x_max: b.x_max = v.x
    if v.y < b.y_min: b.y_min = v.y
    if v.y > b.y_max: b.y_max = v.y
    b.count += 1

def band_z(idx):
    """Center Z of a band."""
    return z_min + (idx + 0.5) * band_h

def band_width(idx):
    b = bands[idx]
    if b.count == 0:
        return 0
    return b.x_max - b.x_min

# ---------------------------------------------------------------------------
# CHIN: top of head minus a small offset (~95% of height)
# ---------------------------------------------------------------------------
chin_z = z_min + height * 0.95
chin_x = center_x

# ---------------------------------------------------------------------------
# ARM TIPS (wrists): find the widest bands in the 50-85% height range
# ---------------------------------------------------------------------------
arm_lo = int(num_bands * 0.50)
arm_hi = int(num_bands * 0.85)

width_entries = []
for i in range(arm_lo, arm_hi):
    b = bands[i]
    if b.count < 3:
        continue
    w = b.x_max - b.x_min
    width_entries.append((w, i, b.x_min, b.x_max))

width_entries.sort(reverse=True)
top_n = min(5, len(width_entries))

if top_n > 0:
    top = width_entries[:top_n]
    larm_x = sum(e[2] for e in top) / top_n  # leftmost extent
    rarm_x = sum(e[3] for e in top) / top_n  # rightmost extent
    arm_band_idx = top[0][1]
    arm_z = band_z(arm_band_idx)
else:
    # Fallback: use bounding box
    larm_x = x_min
    rarm_x = x_max
    arm_z = z_min + height * 0.70

# ---------------------------------------------------------------------------
# ELBOWS: midpoint between shoulder and wrist on each side
# ---------------------------------------------------------------------------
# Shoulder junction: where width contracts from arm-band downward
torso_widths = []
for i in range(int(num_bands * 0.55), int(num_bands * 0.75)):
    b = bands[i]
    if b.count > 0:
        torso_widths.append(b.x_max - b.x_min)

median_torso_w = sorted(torso_widths)[len(torso_widths) // 2] if torso_widths else width * 0.3
threshold = median_torso_w * 1.3

shoulder_z = arm_z
if top_n > 0:
    for i in range(arm_band_idx, int(num_bands * 0.55), -1):
        b = bands[i]
        if b.count > 0 and (b.x_max - b.x_min) < threshold:
            shoulder_z = band_z(i)
            break

# Shoulder X positions (where the arm meets the torso)
shoulder_band = bands[min(int((shoulder_z - z_min) / band_h), num_bands - 1)]
if shoulder_band.count > 0:
    shoulder_left_x = shoulder_band.x_min
    shoulder_right_x = shoulder_band.x_max
else:
    shoulder_left_x = center_x - median_torso_w / 2
    shoulder_right_x = center_x + median_torso_w / 2

# Elbows at midpoint between shoulder and wrist
lelbow_x = (shoulder_left_x + larm_x) / 2.0
relbow_x = (shoulder_right_x + rarm_x) / 2.0
elbow_z = (shoulder_z + arm_z) / 2.0

# ---------------------------------------------------------------------------
# GROIN: approximately 47% of height
# ---------------------------------------------------------------------------
groin_z = z_min + height * 0.47
groin_x = center_x

# ---------------------------------------------------------------------------
# KNEES: approximately halfway between groin and feet
# ---------------------------------------------------------------------------
knee_z = (groin_z + z_min) / 2.0

# Find hip width at groin level for knee X placement
groin_band_idx = int((groin_z - z_min) / band_h)
groin_band_idx = max(0, min(groin_band_idx, num_bands - 1))
gb = bands[groin_band_idx]
if gb.count > 0:
    lknee_x = (gb.x_min + center_x) / 2.0
    rknee_x = (gb.x_max + center_x) / 2.0
else:
    lknee_x = center_x - width * 0.08
    rknee_x = center_x + width * 0.08

# ---------------------------------------------------------------------------
# Build output (in Blender Z-up space: x=left/right, z=up)
# We output in a "front view" format: x stays x, y becomes z (height)
# The calling code will handle any further transforms for Mixamo
# ---------------------------------------------------------------------------
markers = {
    "chin":   {"x": round(chin_x, 6),   "y": round(chin_z, 6)},
    "larm":   {"x": round(larm_x, 6),   "y": round(arm_z, 6)},
    "rarm":   {"x": round(rarm_x, 6),   "y": round(arm_z, 6)},
    "lelbow": {"x": round(lelbow_x, 6), "y": round(elbow_z, 6)},
    "relbow": {"x": round(relbow_x, 6), "y": round(elbow_z, 6)},
    "lknee":  {"x": round(lknee_x, 6),  "y": round(knee_z, 6)},
    "rknee":  {"x": round(rknee_x, 6),  "y": round(knee_z, 6)},
    "groin":  {"x": round(groin_x, 6),  "y": round(groin_z, 6)},
}

# Also include raw bounds for the pipeline to compute scale factors
output = {
    "markers": markers,
    "bounds": {
        "x_min": round(x_min, 6),
        "x_max": round(x_max, 6),
        "y_min": round(y_min, 6),
        "y_max": round(y_max, 6),
        "z_min": round(z_min, 6),
        "z_max": round(z_max, 6),
        "height": round(height, 6),
        "width": round(width, 6),
        "center_x": round(center_x, 6),
    },
    "coordinate_space": "blender_z_up",
    "note": "x = left/right, y = height (mapped from Blender Z). Pipeline must transform to Mixamo viewport space."
}

print("[markers] Computed markers:")
for name, pos in markers.items():
    print(f"  {name}: x={pos['x']:.4f}, y={pos['y']:.4f}")

os.makedirs(os.path.dirname(OUTPUT_JSON) or ".", exist_ok=True)
with open(OUTPUT_JSON, "w") as f:
    json.dump(output, f, indent=2)

print(f"[markers] Written to {OUTPUT_JSON}")
