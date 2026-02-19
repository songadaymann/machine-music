"""
Headless Blender script: auto-rig a GLB mesh with a Mixamo-compatible skeleton.

Usage:
  blender --background --python scripts/blender-autorig.py -- input.glb output.glb [config.json]

Takes a static (un-rigged) GLB, creates a humanoid armature with mixamorig: bone names,
skins the mesh to it with automatic weights, and exports a rigged GLB with textures intact.
"""

import bpy
import sys
import os
import math
import json
from mathutils import Vector, Matrix

# ---------------------------------------------------------------------------
# Parse CLI args (everything after "--")
# ---------------------------------------------------------------------------
argv = sys.argv
if "--" in argv:
    args = argv[argv.index("--") + 1:]
else:
    args = []

if len(args) < 2:
    print("Usage: blender --background --python blender-autorig.py -- <input.glb> <output.glb> [config.json]")
    sys.exit(1)

INPUT_GLB = os.path.abspath(args[0])
OUTPUT_GLB = os.path.abspath(args[1])
CONFIG_PATH = os.path.abspath(args[2]) if len(args) >= 3 else None

config = {}
if CONFIG_PATH:
    print(f"[autorig] Config: {CONFIG_PATH}")
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            loaded = json.load(f)
            if isinstance(loaded, dict):
                config = loaded
            else:
                print("[autorig] WARNING: config is not a JSON object; ignoring")
    except Exception as e:
        print(f"[autorig] WARNING: Failed to read config ({e}); using defaults")

def cfg_number(key, default):
    v = config.get(key, default)
    try:
        return float(v)
    except Exception:
        return float(default)

def cfg_int(key, default):
    v = config.get(key, default)
    try:
        return int(v)
    except Exception:
        return int(default)

def cfg_text(key, default):
    v = config.get(key, default)
    if v is None:
        return str(default)
    return str(v)

def cfg_bool(key, default):
    v = config.get(key, default)
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s in {"1", "true", "yes", "y", "on"}:
            return True
        if s in {"0", "false", "no", "n", "off"}:
            return False
    return bool(default)

print(f"[autorig] Input:  {INPUT_GLB}")
print(f"[autorig] Output: {OUTPUT_GLB}")

# ---------------------------------------------------------------------------
# Clear default scene
# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------------------------------------------------------------------------
# Import GLB
# ---------------------------------------------------------------------------
print("[autorig] Importing GLB...")
bpy.ops.import_scene.gltf(filepath=INPUT_GLB)

# Gather all mesh objects
meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
if not meshes:
    print("[autorig] ERROR: No mesh objects found in GLB")
    sys.exit(1)

print(f"[autorig] Found {len(meshes)} mesh(es): {[m.name for m in meshes]}")

# ---------------------------------------------------------------------------
# Measure the model bounding box to position bones correctly
# ---------------------------------------------------------------------------
# Evaluate all meshes in world space to get overall bounds
all_min = Vector((float('inf'), float('inf'), float('inf')))
all_max = Vector((float('-inf'), float('-inf'), float('-inf')))

depsgraph = bpy.context.evaluated_depsgraph_get()
for mesh_obj in meshes:
    eval_obj = mesh_obj.evaluated_get(depsgraph)
    eval_mesh = eval_obj.to_mesh()
    world_matrix = mesh_obj.matrix_world
    for vert in eval_mesh.vertices:
        co = world_matrix @ vert.co
        for i in range(3):
            if co[i] < all_min[i]:
                all_min[i] = co[i]
            if co[i] > all_max[i]:
                all_max[i] = co[i]
    eval_obj.to_mesh_clear()

model_height = all_max[2] - all_min[2]  # Blender imports GLTF with Z-up
model_center_x = (all_min[0] + all_max[0]) / 2
model_center_y = (all_min[1] + all_max[1]) / 2
model_bottom_z = all_min[2]

print(f"[autorig] Model bounds: min={all_min}, max={all_max}")
print(f"[autorig] Model height: {model_height:.4f}")
print(f"[autorig] Model center XY: ({model_center_x:.4f}, {model_center_y:.4f})")
print(f"[autorig] Model bottom Z: {model_bottom_z:.4f}")

if model_height < 0.01:
    print("[autorig] ERROR: Model height too small")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Build Mixamo-compatible armature
# ---------------------------------------------------------------------------
# Proportional bone positions (fraction of total height, from bottom)
# These are approximate humanoid proportions
H = model_height
CX = model_center_x
CY = model_center_y
BZ = model_bottom_z  # base Z offset

# Tunable proportions (for sweep experiments)
hips_h = cfg_number("hips_height_frac", 0.48)
spine_h = cfg_number("spine_height_frac", 0.52)
spine1_h = cfg_number("spine1_height_frac", 0.58)
spine2_h = cfg_number("spine2_height_frac", 0.64)
neck_h = cfg_number("neck_height_frac", 0.72)
head_h = cfg_number("head_height_frac", 0.78)
head_top_h = cfg_number("head_top_height_frac", 0.95)
head_end_h = cfg_number("head_end_height_frac", 1.0)

shoulder_h = cfg_number("shoulder_height_frac", 0.72)
shoulder_inner = cfg_number("shoulder_inner_offset_frac", 0.02)
shoulder_outer = cfg_number("shoulder_outer_offset_frac", 0.08)
upper_arm_end = cfg_number("upper_arm_end_offset_frac", 0.20)
forearm_end = cfg_number("forearm_end_offset_frac", 0.32)
hand_end = cfg_number("hand_end_offset_frac", 0.37)

leg_x = cfg_number("leg_x_offset_frac", 0.06)
upper_leg_h = cfg_number("upper_leg_end_height_frac", 0.27)
lower_leg_h = cfg_number("lower_leg_end_height_frac", 0.06)
foot_forward = cfg_number("foot_forward_offset_frac", 0.06)
foot_h = cfg_number("foot_height_frac", 0.02)
toe_forward = cfg_number("toe_forward_offset_frac", 0.10)
toe_h = cfg_number("toe_height_frac", 0.0)

weight_top_n = max(1, min(cfg_int("weight_top_n", 4), 8))
weight_falloff = max(0.1, cfg_number("weight_falloff_strength", 2.0))
min_weight = max(0.0, cfg_number("min_weight_threshold", 0.01))
max_influences = max(1, min(cfg_int("max_influences", 4), 8))
skinning_method = cfg_text("skinning_method", "distance").strip().lower()
distance_use_anatomy_masks = cfg_bool("distance_use_anatomy_masks", True)
distance_calibrate_from_armature = cfg_bool("distance_calibrate_from_armature", True)
distance_weight_bone_scope = cfg_text("distance_weight_bone_scope", "core").strip().lower()
mesh_proportional_fit = cfg_bool("mesh_proportional_fit", True)
script_dir = os.path.dirname(os.path.abspath(__file__))
default_template_mixamo_glb = os.path.abspath(os.path.join(script_dir, "..", "public", "animations", "idle.glb"))
rig_source = cfg_text("rig_source", "mixamo_template").strip().lower()
template_mixamo_glb = cfg_text("template_mixamo_glb", default_template_mixamo_glb).strip()
if skinning_method not in {"bone_heat", "distance"}:
    print(f"[autorig] WARNING: unknown skinning_method='{skinning_method}', falling back to bone_heat")
    skinning_method = "bone_heat"
if rig_source not in {"mixamo_template", "synthetic"}:
    print(f"[autorig] WARNING: unknown rig_source='{rig_source}', falling back to synthetic")
    rig_source = "synthetic"
if distance_weight_bone_scope not in {"core", "all"}:
    print(f"[autorig] WARNING: unknown distance_weight_bone_scope='{distance_weight_bone_scope}', falling back to core")
    distance_weight_bone_scope = "core"

print("[autorig] Sweep params:")
print(f"  shoulder_h={shoulder_h}, shoulder_outer={shoulder_outer}, upper_arm_end={upper_arm_end}, forearm_end={forearm_end}")
print(f"  leg_x={leg_x}, upper_leg_h={upper_leg_h}, lower_leg_h={lower_leg_h}, foot_forward={foot_forward}")
print(f"  weight_top_n={weight_top_n}, weight_falloff={weight_falloff}, min_weight={min_weight}, max_influences={max_influences}")
print(f"  skinning_method={skinning_method}")
print(f"  distance_use_anatomy_masks={distance_use_anatomy_masks}")
print(f"  distance_calibrate_from_armature={distance_calibrate_from_armature}")
print(f"  distance_weight_bone_scope={distance_weight_bone_scope}")
print(f"  rig_source={rig_source}")
print(f"  mesh_proportional_fit={mesh_proportional_fit}")
if rig_source == "mixamo_template":
    print(f"  template_mixamo_glb={template_mixamo_glb}")

def pos(x_off, y_off, height_frac):
    return Vector((CX + x_off * H, CY + y_off * H, BZ + height_frac * H))

def create_synthetic_armature():
    bone_defs = [
        ("mixamorig:Hips",           pos(0, 0, hips_h),     pos(0, 0, spine_h),    None),
        ("mixamorig:Spine",          pos(0, 0, spine_h),    pos(0, 0, spine1_h),   "mixamorig:Hips"),
        ("mixamorig:Spine1",         pos(0, 0, spine1_h),   pos(0, 0, spine2_h),   "mixamorig:Spine"),
        ("mixamorig:Spine2",         pos(0, 0, spine2_h),   pos(0, 0, neck_h),     "mixamorig:Spine1"),
        ("mixamorig:Neck",           pos(0, 0, neck_h),     pos(0, 0, head_h),     "mixamorig:Spine2"),
        ("mixamorig:Head",           pos(0, 0, head_h),     pos(0, 0, head_top_h), "mixamorig:Neck"),
        ("mixamorig:HeadTop_End",    pos(0, 0, head_top_h), pos(0, 0, head_end_h), "mixamorig:Head"),
        ("mixamorig:LeftShoulder",   pos(shoulder_inner, 0, shoulder_h), pos(shoulder_outer, 0, shoulder_h), "mixamorig:Spine2"),
        ("mixamorig:LeftArm",        pos(shoulder_outer, 0, shoulder_h), pos(upper_arm_end, 0, shoulder_h),  "mixamorig:LeftShoulder"),
        ("mixamorig:LeftForeArm",    pos(upper_arm_end, 0, shoulder_h),  pos(forearm_end, 0, shoulder_h),    "mixamorig:LeftArm"),
        ("mixamorig:LeftHand",       pos(forearm_end, 0, shoulder_h),     pos(hand_end, 0, shoulder_h),       "mixamorig:LeftForeArm"),
        ("mixamorig:RightShoulder",  pos(-shoulder_inner, 0, shoulder_h), pos(-shoulder_outer, 0, shoulder_h), "mixamorig:Spine2"),
        ("mixamorig:RightArm",       pos(-shoulder_outer, 0, shoulder_h), pos(-upper_arm_end, 0, shoulder_h),  "mixamorig:RightShoulder"),
        ("mixamorig:RightForeArm",   pos(-upper_arm_end, 0, shoulder_h),  pos(-forearm_end, 0, shoulder_h),    "mixamorig:RightArm"),
        ("mixamorig:RightHand",      pos(-forearm_end, 0, shoulder_h),     pos(-hand_end, 0, shoulder_h),       "mixamorig:RightForeArm"),
        ("mixamorig:LeftUpLeg",      pos(leg_x, 0, hips_h),         pos(leg_x, 0, upper_leg_h),           "mixamorig:Hips"),
        ("mixamorig:LeftLeg",        pos(leg_x, 0, upper_leg_h),    pos(leg_x, 0, lower_leg_h),           "mixamorig:LeftUpLeg"),
        ("mixamorig:LeftFoot",       pos(leg_x, 0, lower_leg_h),    pos(leg_x, foot_forward, foot_h),     "mixamorig:LeftLeg"),
        ("mixamorig:LeftToeBase",    pos(leg_x, foot_forward, foot_h), pos(leg_x, toe_forward, toe_h),    "mixamorig:LeftFoot"),
        ("mixamorig:RightUpLeg",     pos(-leg_x, 0, hips_h),         pos(-leg_x, 0, upper_leg_h),          "mixamorig:Hips"),
        ("mixamorig:RightLeg",       pos(-leg_x, 0, upper_leg_h),    pos(-leg_x, 0, lower_leg_h),          "mixamorig:RightUpLeg"),
        ("mixamorig:RightFoot",      pos(-leg_x, 0, lower_leg_h),    pos(-leg_x, foot_forward, foot_h),    "mixamorig:RightLeg"),
        ("mixamorig:RightToeBase",   pos(-leg_x, foot_forward, foot_h), pos(-leg_x, toe_forward, toe_h),   "mixamorig:RightFoot"),
    ]

    print(f"[autorig] Creating synthetic armature with {len(bone_defs)} bones...")
    armature_data = bpy.data.armatures.new("Armature")
    armature_obj = bpy.data.objects.new("Armature", armature_data)
    bpy.context.scene.collection.objects.link(armature_obj)

    bpy.context.view_layer.objects.active = armature_obj
    bpy.ops.object.mode_set(mode='EDIT')
    bone_map = {}
    for bone_name, head, tail, parent_name in bone_defs:
        bone = armature_data.edit_bones.new(bone_name)
        bone.head = head
        bone.tail = tail
        if parent_name and parent_name in bone_map:
            bone.parent = bone_map[parent_name]
            bone.use_connect = False
        bone_map[bone_name] = bone
    bpy.ops.object.mode_set(mode='OBJECT')
    return armature_obj

def compute_armature_bounds(arm_obj):
    min_v = Vector((float('inf'), float('inf'), float('inf')))
    max_v = Vector((float('-inf'), float('-inf'), float('-inf')))
    for bone in arm_obj.data.bones:
        for local in (bone.head_local, bone.tail_local):
            w = arm_obj.matrix_world @ local
            for i in range(3):
                if w[i] < min_v[i]:
                    min_v[i] = w[i]
                if w[i] > max_v[i]:
                    max_v[i] = w[i]
    return min_v, max_v

def fit_armature_to_model(arm_obj):
    min_v, max_v = compute_armature_bounds(arm_obj)
    rig_height = max(max_v[2] - min_v[2], 1e-6)
    scale = H / rig_height
    arm_obj.scale = Vector((scale, scale, scale))
    bpy.context.view_layer.update()

    min_v, max_v = compute_armature_bounds(arm_obj)
    cx = (min_v[0] + max_v[0]) / 2
    cy = (min_v[1] + max_v[1]) / 2
    arm_obj.location += Vector((CX - cx, CY - cy, BZ - min_v[2]))
    bpy.context.view_layer.update()

    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    arm_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.context.view_layer.update()

def analyze_mesh_silhouette(mesh_objects):
    """Analyze mesh vertex distribution to detect body landmark positions."""
    all_verts = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for mesh_obj in mesh_objects:
        eval_obj = mesh_obj.evaluated_get(depsgraph)
        eval_mesh = eval_obj.to_mesh()
        wm = mesh_obj.matrix_world
        for vert in eval_mesh.vertices:
            all_verts.append((wm @ vert.co).copy())
        eval_obj.to_mesh_clear()

    if not all_verts:
        return None

    z_min = min(v.z for v in all_verts)
    z_max = max(v.z for v in all_verts)
    height = z_max - z_min
    if height < 0.01:
        return None

    # Slice into horizontal bands (1% of height each)
    num_bands = 100
    band_h = height / num_bands
    bands = [None] * num_bands
    for v in all_verts:
        idx = int((v.z - z_min) / band_h)
        idx = max(0, min(idx, num_bands - 1))
        b = bands[idx]
        if b is None:
            bands[idx] = [v.x, v.x, v.y, v.y, 1]
        else:
            if v.x < b[0]: b[0] = v.x
            if v.x > b[1]: b[1] = v.x
            if v.y < b[2]: b[2] = v.y
            if v.y > b[3]: b[3] = v.y
            b[4] += 1

    # Detect arm tips: average the top-5 widest bands in the 50-95% height range
    arm_lo = int(num_bands * 0.50)
    arm_hi = int(num_bands * 0.95)
    width_entries = []
    for i in range(arm_lo, arm_hi):
        b = bands[i]
        if b is None or b[4] < 3:
            continue
        width_entries.append((b[1] - b[0], i, b[0], b[1]))
    width_entries.sort(reverse=True)

    top_n = min(5, len(width_entries))
    if top_n == 0:
        return None

    top = width_entries[:top_n]
    arm_x_min = sum(e[2] for e in top) / top_n
    arm_x_max = sum(e[3] for e in top) / top_n
    arm_band_idx = top[0][1]  # band of widest extent
    arm_height_z = z_min + (arm_band_idx + 0.5) * band_h

    # Hip width: average X extent across the 44-52% height range
    hip_lo = int(num_bands * 0.44)
    hip_hi = int(num_bands * 0.52)
    hip_x_mins, hip_x_maxs = [], []
    for i in range(hip_lo, min(hip_hi + 1, num_bands)):
        b = bands[i]
        if b is not None and b[4] > 0:
            hip_x_mins.append(b[0])
            hip_x_maxs.append(b[1])
    hip_left_x = sum(hip_x_mins) / len(hip_x_mins) if hip_x_mins else 0
    hip_right_x = sum(hip_x_maxs) / len(hip_x_maxs) if hip_x_maxs else 0

    # Torso width: median width in the 55-70% height range (for shoulder junction detection)
    torso_widths = []
    for i in range(int(num_bands * 0.55), int(num_bands * 0.70)):
        b = bands[i]
        if b is not None and b[4] > 0:
            torso_widths.append(b[1] - b[0])
    median_torso_w = sorted(torso_widths)[len(torso_widths) // 2] if torso_widths else 0

    # Shoulder junction: scan downward from widest band to find where width contracts
    shoulder_z = arm_height_z
    threshold = median_torso_w * 1.5
    for i in range(arm_band_idx, int(num_bands * 0.55), -1):
        b = bands[i]
        if b is not None and b[4] > 0 and (b[1] - b[0]) < threshold:
            shoulder_z = z_min + (i + 0.5) * band_h
            break

    mesh_cx = (arm_x_min + arm_x_max) / 2.0
    result = {
        'arm_tip_left_x': arm_x_min,
        'arm_tip_right_x': arm_x_max,
        'arm_height_z': arm_height_z,
        'arm_height_frac': (arm_height_z - z_min) / height,
        'hip_left_x': hip_left_x,
        'hip_right_x': hip_right_x,
        'hip_half_width': (hip_right_x - hip_left_x) / 2.0,
        'shoulder_junction_z': shoulder_z,
        'mesh_center_x': mesh_cx,
    }

    print("[autorig] Mesh silhouette analysis:")
    print(f"  arm tips: left_x={arm_x_min:.4f}, right_x={arm_x_max:.4f}")
    print(f"  arm height: z={arm_height_z:.4f}, frac={(arm_height_z - z_min) / height:.4f}")
    print(f"  hip width: left={hip_left_x:.4f}, right={hip_right_x:.4f}")
    print(f"  shoulder junction z={shoulder_z:.4f}")
    print(f"  median torso width={median_torso_w:.4f}")
    return result

def adjust_armature_proportions(arm_obj, landmarks):
    """Scale arm/leg bone chain X positions to match mesh proportions."""
    if landmarks is None:
        print("[autorig] No mesh landmarks, skipping proportion adjustment")
        return

    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    arm_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj

    wm = arm_obj.matrix_world
    wm_inv = wm.inverted()

    def bone_world_head(name):
        b = arm_obj.data.bones.get(name)
        return wm @ b.head_local if b else None

    def bone_world_tail(name):
        b = arm_obj.data.bones.get(name)
        return wm @ b.tail_local if b else None

    # Current skeleton arm extent from spine center to hand tip
    spine2_head = bone_world_head("mixamorig:Spine2")
    left_hand_tail = bone_world_tail("mixamorig:LeftHand")
    right_hand_tail = bone_world_tail("mixamorig:RightHand")
    left_upleg_head = bone_world_head("mixamorig:LeftUpLeg")
    right_upleg_head = bone_world_head("mixamorig:RightUpLeg")

    if not all([spine2_head, left_hand_tail, right_hand_tail]):
        print("[autorig] Missing arm chain bones, skipping proportion adjustment")
        return

    spine_cx = spine2_head.x
    mesh_cx = landmarks['mesh_center_x']

    # Arm scale: mesh arm extent vs skeleton arm extent
    skel_left_extent = abs(left_hand_tail.x - spine_cx)
    skel_right_extent = abs(right_hand_tail.x - spine_cx)
    mesh_left_extent = abs(landmarks['arm_tip_left_x'] - mesh_cx)
    mesh_right_extent = abs(landmarks['arm_tip_right_x'] - mesh_cx)

    left_arm_s = mesh_left_extent / max(skel_left_extent, 0.001)
    right_arm_s = mesh_right_extent / max(skel_right_extent, 0.001)
    arm_scale = (left_arm_s + right_arm_s) / 2.0
    arm_scale = max(0.3, min(arm_scale, 5.0))

    # Hip scale
    hip_scale = 1.0
    if left_upleg_head and right_upleg_head:
        skel_hip_half = abs(left_upleg_head.x - spine_cx)
        mesh_hip_half = landmarks['hip_half_width']
        if skel_hip_half > 0.001 and mesh_hip_half > 0.001:
            hip_scale = mesh_hip_half / skel_hip_half
            hip_scale = max(0.3, min(hip_scale, 5.0))

    print(f"[autorig] Proportion adjustment: arm_scale={arm_scale:.4f}, hip_scale={hip_scale:.4f}")
    print(f"  skeleton arm extent: L={skel_left_extent:.4f}, R={skel_right_extent:.4f}")
    print(f"  mesh arm extent:     L={mesh_left_extent:.4f}, R={mesh_right_extent:.4f}")

    if abs(arm_scale - 1.0) < 0.02 and abs(hip_scale - 1.0) < 0.02:
        print("[autorig] Proportions already match (within 2%), skipping bone adjustment")
        return

    # Enter edit mode and adjust bone positions
    bpy.ops.object.mode_set(mode='EDIT')
    edit_bones = arm_obj.data.edit_bones

    def scale_bone_x(bone_name, pivot_x, scale_factor):
        eb = edit_bones.get(bone_name)
        if eb is None:
            return
        hw = wm @ eb.head
        tw = wm @ eb.tail
        new_hx = pivot_x + (hw.x - pivot_x) * scale_factor
        new_tx = pivot_x + (tw.x - pivot_x) * scale_factor
        eb.head = wm_inv @ Vector((new_hx, hw.y, hw.z))
        eb.tail = wm_inv @ Vector((new_tx, tw.y, tw.z))

    # Arm chains + finger bones
    LEFT_ARM = ["mixamorig:LeftShoulder", "mixamorig:LeftArm",
                "mixamorig:LeftForeArm", "mixamorig:LeftHand"]
    RIGHT_ARM = ["mixamorig:RightShoulder", "mixamorig:RightArm",
                 "mixamorig:RightForeArm", "mixamorig:RightHand"]
    left_fingers = [b.name for b in edit_bones
                    if b.name.startswith("mixamorig:LeftHand") and b.name != "mixamorig:LeftHand"]
    right_fingers = [b.name for b in edit_bones
                     if b.name.startswith("mixamorig:RightHand") and b.name != "mixamorig:RightHand"]

    for name in LEFT_ARM + left_fingers:
        scale_bone_x(name, spine_cx, arm_scale)
    for name in RIGHT_ARM + right_fingers:
        scale_bone_x(name, spine_cx, arm_scale)

    # Leg chains
    LEFT_LEG = ["mixamorig:LeftUpLeg", "mixamorig:LeftLeg",
                "mixamorig:LeftFoot", "mixamorig:LeftToeBase"]
    RIGHT_LEG = ["mixamorig:RightUpLeg", "mixamorig:RightLeg",
                 "mixamorig:RightFoot", "mixamorig:RightToeBase"]

    for name in LEFT_LEG:
        scale_bone_x(name, spine_cx, hip_scale)
    for name in RIGHT_LEG:
        scale_bone_x(name, spine_cx, hip_scale)

    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.update()
    print("[autorig] Proportion adjustment applied")

def import_template_armature(template_path):
    if not os.path.exists(template_path):
        raise RuntimeError(f"Template rig not found: {template_path}")

    before_objects = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=template_path)
    after_objects = set(bpy.context.scene.objects)
    new_objects = [obj for obj in after_objects if obj not in before_objects]
    armatures = [obj for obj in new_objects if obj.type == 'ARMATURE']
    if not armatures:
        raise RuntimeError(f"No armature found in template: {template_path}")
    armature_obj = max(armatures, key=lambda a: len(a.data.bones))

    if armature_obj.parent:
        armature_obj.matrix_world = armature_obj.parent.matrix_world @ armature_obj.matrix_world
        armature_obj.parent = None

    for obj in list(new_objects):
        if obj == armature_obj:
            continue
        bpy.data.objects.remove(obj, do_unlink=True)

    armature_obj.name = "Armature"
    armature_obj.data.name = "Armature"
    armature_obj.data.pose_position = 'REST'
    armature_obj.animation_data_clear()
    return armature_obj

def ensure_required_end_bones(armature_obj):
    required_name = "mixamorig:HeadTop_End"
    if required_name in armature_obj.data.bones:
        return
    if "mixamorig:Head" not in armature_obj.data.bones:
        return

    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    armature_obj.select_set(True)
    bpy.context.view_layer.objects.active = armature_obj
    bpy.ops.object.mode_set(mode='EDIT')

    edit_bones = armature_obj.data.edit_bones
    head_bone = edit_bones.get("mixamorig:Head")
    if not head_bone:
        bpy.ops.object.mode_set(mode='OBJECT')
        return

    new_bone = edit_bones.new(required_name)
    new_bone.head = head_bone.tail.copy()
    axis = head_bone.tail - head_bone.head
    if axis.length < 1e-6:
        axis = Vector((0.0, 0.0, max(H * 0.03, 0.03)))
    else:
        axis = axis.normalized() * max(axis.length * 0.3, H * 0.03)
    new_bone.tail = new_bone.head + axis
    new_bone.parent = head_bone
    new_bone.use_connect = False

    bpy.ops.object.mode_set(mode='OBJECT')

def _bone_world_pos(armature_obj, bone_name, use_tail=False):
    bone = armature_obj.data.bones.get(bone_name)
    if not bone:
        return None
    local = bone.tail_local if use_tail else bone.head_local
    return armature_obj.matrix_world @ local

def calibrate_anatomy_refs_from_armature(armature_obj):
    global hips_h, spine_h, spine1_h, neck_h, shoulder_h, shoulder_outer, leg_x

    def _height_frac(point):
        return (point.z - BZ) / max(H, 1e-6)

    hips = _bone_world_pos(armature_obj, "mixamorig:Hips")
    spine = _bone_world_pos(armature_obj, "mixamorig:Spine")
    spine1 = _bone_world_pos(armature_obj, "mixamorig:Spine1")
    neck = _bone_world_pos(armature_obj, "mixamorig:Neck")
    l_shoulder = _bone_world_pos(armature_obj, "mixamorig:LeftShoulder")
    l_upleg = _bone_world_pos(armature_obj, "mixamorig:LeftUpLeg")

    if hips:
        hips_h = _height_frac(hips)
    if spine:
        spine_h = _height_frac(spine)
    if spine1:
        spine1_h = _height_frac(spine1)
    if neck:
        neck_h = _height_frac(neck)
    if l_shoulder:
        shoulder_h = _height_frac(l_shoulder)
        shoulder_outer = max(abs((l_shoulder.x - CX) / max(H, 1e-6)), 0.04)
    if l_upleg:
        leg_x = max(abs((l_upleg.x - CX) / max(H, 1e-6)), 0.02)

    print("[autorig] Calibrated anatomy refs from armature:")
    print(f"  hips_h={hips_h:.4f}, spine_h={spine_h:.4f}, spine1_h={spine1_h:.4f}, neck_h={neck_h:.4f}")
    print(f"  shoulder_h={shoulder_h:.4f}, shoulder_outer={shoulder_outer:.4f}, leg_x={leg_x:.4f}")

armature_obj = None
if rig_source == "mixamo_template":
    try:
        armature_obj = import_template_armature(template_mixamo_glb)
        print(f"[autorig] Imported Mixamo template armature ({len(armature_obj.data.bones)} bones)")
    except Exception as e:
        print(f"[autorig] WARNING: Failed to import template rig ({e}); using synthetic rig")
        armature_obj = None

if armature_obj is None:
    armature_obj = create_synthetic_armature()

fit_armature_to_model(armature_obj)
if mesh_proportional_fit:
    mesh_landmarks = analyze_mesh_silhouette(meshes)
    adjust_armature_proportions(armature_obj, mesh_landmarks)
ensure_required_end_bones(armature_obj)
if distance_calibrate_from_armature:
    calibrate_anatomy_refs_from_armature(armature_obj)

print(f"[autorig] Armature ready with {len(armature_obj.data.bones)} bones")
print(f"[autorig] Bone names: {[b.name for b in armature_obj.data.bones][:16]}{' ...' if len(armature_obj.data.bones) > 16 else ''}")

# ---------------------------------------------------------------------------
# Skin meshes to armature
# ---------------------------------------------------------------------------
print("[autorig] Skinning meshes to armature...")

# Build a lookup: bone name -> (head world pos, tail world pos)
bone_positions = {}
for bone in armature_obj.data.bones:
    bone_positions[bone.name] = {
        'head': armature_obj.matrix_world @ bone.head_local,
        'tail': armature_obj.matrix_world @ bone.tail_local,
    }

def closest_point_on_segment(point, seg_a, seg_b):
    """Return the closest point on line segment [seg_a, seg_b] to point."""
    ab = seg_b - seg_a
    length_sq = ab.length_squared
    if length_sq < 1e-12:
        return seg_a.copy()
    t = max(0.0, min(1.0, (point - seg_a).dot(ab) / length_sq))
    return seg_a + ab * t

def distance_to_bone(point, bone_name):
    bp = bone_positions[bone_name]
    closest = closest_point_on_segment(point, bp['head'], bp['tail'])
    return (point - closest).length

def verify_weights(mesh_obj):
    # Count groups that have at least one assigned vertex weight.
    used_group_indices = set()
    for vert in mesh_obj.data.vertices:
        for group in vert.groups:
            if group.weight > 0:
                used_group_indices.add(group.group)
    return len(used_group_indices)

def clamp01(value):
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value

LEFT_ARM_BONES = {
    "mixamorig:LeftShoulder",
    "mixamorig:LeftArm",
    "mixamorig:LeftForeArm",
    "mixamorig:LeftHand",
}
RIGHT_ARM_BONES = {
    "mixamorig:RightShoulder",
    "mixamorig:RightArm",
    "mixamorig:RightForeArm",
    "mixamorig:RightHand",
}
LEFT_LEG_BONES = {
    "mixamorig:LeftUpLeg",
    "mixamorig:LeftLeg",
    "mixamorig:LeftFoot",
    "mixamorig:LeftToeBase",
}
RIGHT_LEG_BONES = {
    "mixamorig:RightUpLeg",
    "mixamorig:RightLeg",
    "mixamorig:RightFoot",
    "mixamorig:RightToeBase",
}
HEAD_BONES = {
    "mixamorig:Neck",
    "mixamorig:Head",
    "mixamorig:HeadTop_End",
}
TORSO_BONES = {
    "mixamorig:Hips",
    "mixamorig:Spine",
    "mixamorig:Spine1",
    "mixamorig:Spine2",
}
PRIMARY_WEIGHT_BONES = LEFT_ARM_BONES | RIGHT_ARM_BONES | LEFT_LEG_BONES | RIGHT_LEG_BONES | TORSO_BONES | HEAD_BONES

def anatomy_gate(bone_name, x_norm, z_norm):
    # Use broad regional gates to avoid catastrophic cross-limb assignments when
    # automatic heat weights fail and we must estimate weights from distances.
    side_width = max(shoulder_outer * 1.6, 0.08)
    leg_width = max(leg_x * 2.4, 0.10)
    arm_min_z = max(spine_h - 0.03, 0.35)
    leg_max_z = min(hips_h + 0.10, 0.72)

    if bone_name in LEFT_ARM_BONES:
        if x_norm <= -0.01 or z_norm < arm_min_z:
            return 0.0
        side_gate = clamp01((x_norm + 0.01) / side_width)
        height_gate = clamp01((z_norm - arm_min_z) / (1.0 - arm_min_z))
        return max(0.001, side_gate * height_gate)

    if bone_name in RIGHT_ARM_BONES:
        if x_norm >= 0.01 or z_norm < arm_min_z:
            return 0.0
        side_gate = clamp01((-x_norm + 0.01) / side_width)
        height_gate = clamp01((z_norm - arm_min_z) / (1.0 - arm_min_z))
        return max(0.001, side_gate * height_gate)

    if bone_name in LEFT_LEG_BONES:
        if x_norm <= -0.01 or z_norm > leg_max_z:
            return 0.0
        side_gate = clamp01((x_norm + 0.01) / leg_width)
        height_gate = clamp01((leg_max_z - z_norm) / max(leg_max_z, 0.001))
        return max(0.001, side_gate * height_gate)

    if bone_name in RIGHT_LEG_BONES:
        if x_norm >= 0.01 or z_norm > leg_max_z:
            return 0.0
        side_gate = clamp01((-x_norm + 0.01) / leg_width)
        height_gate = clamp01((leg_max_z - z_norm) / max(leg_max_z, 0.001))
        return max(0.001, side_gate * height_gate)

    center_gate = 1.0 - clamp01((abs(x_norm) - 0.05) / max(shoulder_outer * 2.0, 0.25))
    if bone_name in TORSO_BONES:
        if z_norm < 0.20:
            # Keep upper spine influence off feet/ground fringe.
            return 1.0 if bone_name == "mixamorig:Hips" else 0.0
        if bone_name == "mixamorig:Hips":
            return max(0.001, 0.6 + 0.4 * clamp01((hips_h + 0.08 - z_norm) / max(hips_h + 0.08, 0.001)))
        if bone_name == "mixamorig:Spine":
            return max(0.001, center_gate * clamp01((z_norm - (hips_h - 0.05)) / 0.35))
        if bone_name == "mixamorig:Spine1":
            return max(0.001, center_gate * clamp01((z_norm - (spine_h - 0.10)) / 0.35))
        if bone_name == "mixamorig:Spine2":
            return max(0.001, center_gate * clamp01((z_norm - (spine1_h - 0.10)) / 0.30))

    if bone_name in HEAD_BONES:
        if z_norm < neck_h - 0.06:
            return 0.0
        return max(0.001, center_gate * clamp01((z_norm - (neck_h - 0.06)) / max(1.0 - (neck_h - 0.06), 0.001)))

    return 1.0

def prepare_mesh_for_skinning(mesh_obj, merge_vertices=False):
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_obj

    # Apply non-translation transforms so skinning works in a stable basis.
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    # Light cleanup improves bone-heat robustness on generated meshes.
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    if merge_vertices:
        try:
            bpy.ops.mesh.merge_by_distance(distance=1e-6)
        except Exception:
            try:
                bpy.ops.mesh.remove_doubles(threshold=1e-6)
            except Exception:
                pass
        try:
            bpy.ops.mesh.delete_loose()
        except Exception:
            pass
        try:
            bpy.ops.mesh.dissolve_degenerate(threshold=1e-6)
        except Exception:
            pass
    try:
        bpy.ops.mesh.normals_make_consistent(inside=False)
    except Exception:
        pass
    bpy.ops.object.mode_set(mode='OBJECT')

def clamp_vertex_influences(mesh_obj, max_influences=4):
    if max_influences < 1:
        return
    group_lookup = {vg.index: vg for vg in mesh_obj.vertex_groups}
    for vert in mesh_obj.data.vertices:
        influences = [(g.group, g.weight) for g in vert.groups if g.weight > 0.0]
        if len(influences) <= max_influences:
            continue

        influences.sort(key=lambda item: item[1], reverse=True)
        keep = influences[:max_influences]
        total = sum(weight for _, weight in keep)
        if total < 1e-9:
            continue

        for group_idx, _ in influences:
            vg = group_lookup.get(group_idx)
            if vg:
                vg.add([vert.index], 0.0, 'REPLACE')

        for group_idx, weight in keep:
            vg = group_lookup.get(group_idx)
            if vg:
                vg.add([vert.index], weight / total, 'REPLACE')

def skin_mesh_with_distance_weights(mesh_obj):
    # Clear any existing vertex groups
    mesh_obj.vertex_groups.clear()

    # Create a vertex group for each bone
    for bone in armature_obj.data.bones:
        mesh_obj.vertex_groups.new(name=bone.name)

    # Assign weights based on proximity to bones
    mesh_data = mesh_obj.data
    world_matrix = mesh_obj.matrix_world
    all_bone_names = [b.name for b in armature_obj.data.bones]
    if distance_weight_bone_scope == "all":
        bone_names = all_bone_names
    else:
        bone_names = [name for name in all_bone_names if name in PRIMARY_WEIGHT_BONES]
        if not bone_names:
            bone_names = all_bone_names

    for vert in mesh_data.vertices:
        co_world = world_matrix @ vert.co
        x_norm = (co_world.x - CX) / max(H, 1e-6)
        z_norm = (co_world.z - BZ) / max(H, 1e-6)

        distances = []
        for bname in bone_names:
            gate = 1.0
            if distance_use_anatomy_masks:
                gate = anatomy_gate(bname, x_norm, z_norm)
                if gate <= 0.0:
                    continue
            d = distance_to_bone(co_world, bname)
            distances.append((bname, d, gate))

        if not distances:
            # Fallback guard: if all bones were masked out for this vertex,
            # use raw nearest bones to avoid leaving unweighted vertices.
            for bname in bone_names:
                d = distance_to_bone(co_world, bname)
                distances.append((bname, d, 1.0))

        distances.sort(key=lambda x: x[1])
        top = distances[:max(1, min(weight_top_n, len(distances)))]

        min_dist = max(top[0][1], 0.001)
        raw_weights = []
        for bname, d, gate in top:
            w = math.exp(-((d / min_dist - 1.0) ** 2) * weight_falloff) * gate
            raw_weights.append((bname, w))

        total = sum(w for _, w in raw_weights)
        if total < 1e-9:
            # Absolute fallback: assign full weight to nearest candidate.
            nearest = top[0][0]
            vg = mesh_obj.vertex_groups[nearest]
            vg.add([vert.index], 1.0, 'REPLACE')
            continue

        for bname, w in raw_weights:
            normalized_w = w / total
            if normalized_w > min_weight:
                vg = mesh_obj.vertex_groups[bname]
                vg.add([vert.index], normalized_w, 'REPLACE')

    # Ensure armature modifier exists and mesh is parented
    has_arm_mod = any(mod.type == 'ARMATURE' for mod in mesh_obj.modifiers)
    if not has_arm_mod:
        mod = mesh_obj.modifiers.new(name='Armature', type='ARMATURE')
        mod.object = armature_obj
        mod.use_vertex_groups = True
    mesh_obj.parent = armature_obj

def skin_mesh_with_bone_heat(mesh_obj):
    # Remove existing armature modifiers so parent_set can set a clean binding.
    for mod in list(mesh_obj.modifiers):
        if mod.type == 'ARMATURE':
            mesh_obj.modifiers.remove(mod)

    mesh_obj.vertex_groups.clear()

    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    armature_obj.select_set(True)
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = armature_obj
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')

for mesh_obj in meshes:
    prepare_mesh_for_skinning(mesh_obj, merge_vertices=False)

    # Try preferred skinning method first, then fall back to distance weights.
    method_used = skinning_method
    try:
        if skinning_method == "bone_heat":
            skin_mesh_with_bone_heat(mesh_obj)
            # Bone heat may fail without throwing (empty groups). Detect and fallback.
            if verify_weights(mesh_obj) == 0:
                print(f"[autorig] WARNING: bone_heat produced zero weighted groups for '{mesh_obj.name}', retrying with merge_by_distance")
                prepare_mesh_for_skinning(mesh_obj, merge_vertices=True)
                skin_mesh_with_bone_heat(mesh_obj)
                if verify_weights(mesh_obj) == 0:
                    print(f"[autorig] WARNING: bone_heat retry still empty for '{mesh_obj.name}', falling back to distance")
                    method_used = "distance_fallback"
                    skin_mesh_with_distance_weights(mesh_obj)
        else:
            skin_mesh_with_distance_weights(mesh_obj)
    except Exception as e:
        print(f"[autorig] WARNING: skinning '{skinning_method}' failed for '{mesh_obj.name}': {e}")
        print("[autorig] Falling back to distance skinning")
        method_used = "distance"
        skin_mesh_with_distance_weights(mesh_obj)

    clamp_vertex_influences(mesh_obj, max_influences=max_influences)

    non_empty_groups = verify_weights(mesh_obj)

    print(f"[autorig] Mesh '{mesh_obj.name}': {len(mesh_obj.vertex_groups)} vertex groups, "
          f"{non_empty_groups} with actual weights, "
          f"method={method_used}")

# ---------------------------------------------------------------------------
# Export rigged GLB
# ---------------------------------------------------------------------------
print(f"[autorig] Exporting rigged GLB to {OUTPUT_GLB}...")

# Make sure output directory exists
os.makedirs(os.path.dirname(OUTPUT_GLB), exist_ok=True)

bpy.ops.export_scene.gltf(
    filepath=OUTPUT_GLB,
    export_format='GLB',
    use_selection=False,
    export_apply=False,
    export_texcoords=True,
    export_normals=True,
    export_attributes=True,
    export_materials='EXPORT',
    export_image_format='AUTO',
    export_skins=True,
    export_morph=True,
    export_animations=False,  # No animations embedded; client loads them separately
)

print(f"[autorig] Export complete!")
print(f"[autorig] Output: {OUTPUT_GLB}")
print(f"[autorig] Output size: {os.path.getsize(OUTPUT_GLB)} bytes")
