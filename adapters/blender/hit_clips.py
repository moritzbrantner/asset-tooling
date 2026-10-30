"""Original hit reactions authored on the Ranger rig in Blender (#399, Atlas 6.1.7).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe starts from the first
``Idle_Loop`` pose (CC0 UAL1, already retargeted onto the rig) and authors one new in-place clip, named
``arguments["clip"]``, from explicit joint rotations:

- ``Hit_Upper_Front`` / ``_Back`` / ``_Left`` / ``_Right``: a one-shot of about 0.35 s on the ``spine_01`` subtree only.
  The side names where the hit lands: the torso snaps away from it (back for a hit from the front, sideways and twisted
  for a side hit), the head lags and the arms are thrown the other way, then everything eases back to the idle pose.
  The observations list the keyed joints (``spine_01`` and its descendants); the build keeps only their rotations, so
  pelvis and legs stay free for the walking or running clip underneath.
- ``Hit_Shove_Spin``: a full-body shove that spins the figure once round to its right on the spot in four pivot steps,
  arms flung out, then a crouch to catch its balance and a recovery into the idle pose. It ends facing the way it
  started.

No Mixamo data is used; Mixamo clips were only watched as motion reference. The output GLB is the target skeleton with
its meshes and the single clip, which the build extracts and embeds like the other clips. No randomness.
"""
import math

import bpy
from mathutils import Matrix, Vector

LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
FPS = 30
STAND = "Idle_Loop"
UPPER_ROOT = "spine_01"
X, Y, UP = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
# Upper-body hits: length (s), the peak's place in the clip, and per side the (joint, armature axis, degrees) turns at
# the peak, applied root to tip. Blender axes: +X is the figure's left, +Y behind it, +Z up. About X, a negative turn
# leans the spine back and swings a hanging arm forward; about Y, a negative turn tilts the spine to the figure's
# right and swings a hanging arm out to its left; about Z, a positive turn draws the left shoulder back.
UPPER = {"duration": .35, "peak": .2}
HITS = {
    "Hit_Upper_Front": [("spine_01", X, -5), ("spine_02", X, -7), ("spine_03", X, -4), ("neck_01", X, -8), ("Head", X, -4),
                        ("upperarm_l", X, -14), ("upperarm_r", X, -14), ("lowerarm_l", X, -10), ("lowerarm_r", X, -10)],
    "Hit_Upper_Back": [("spine_01", X, 6), ("spine_02", X, 8), ("spine_03", X, 4), ("neck_01", X, -6), ("Head", X, -4),
                       ("upperarm_l", X, 12), ("upperarm_r", X, 12)],
    "Hit_Upper_Left": [("spine_01", Y, -7), ("spine_02", Y, -9), ("spine_02", UP, 12), ("spine_03", Y, -4), ("neck_01", Y, 7),
                       ("clavicle_l", X, -6), ("upperarm_l", Y, -14), ("upperarm_r", Y, -6)],
    "Hit_Upper_Right": [("spine_01", Y, 7), ("spine_02", Y, 9), ("spine_02", UP, -12), ("spine_03", Y, 4), ("neck_01", Y, -7),
                        ("clavicle_r", X, -6), ("upperarm_r", Y, 14), ("upperarm_l", Y, 6)],
}
# The shove: length (s), the spin's yaw (negative: to the figure's right) and its window, each foot's two pivot steps
# (fractions), the step lift (m), the arm fling and torso lag (degrees), and the balance crouch (m) and its window.
SHOVE = {"duration": 1.8, "degrees": -360.0, "spin": (.05, .62), "steps": {"r": ((.07, .24), (.34, .5)), "l": ((.18, .36), (.46, .64))},
         "lift": .06, "fling": 45.0, "lag": 16.0, "jolt": -12.0, "crouch": .06, "catch": (.5, .72, 1.0)}
CLIPS = (*HITS, "Hit_Shove_Spin")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clip"}:
        raise ValueError("hit clip requires exactly schemaVersion and clip")
    if p["schemaVersion"] != 1 or p["clip"] not in CLIPS:
        raise ValueError(f"hit clip must be one of {CLIPS}")
    if set(inputs) != {"target"}:
        raise ValueError("hit clip takes exactly the declared input target")


def action_curves(action):
    curves = list(getattr(action, "fcurves", None) or [])
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                curves.extend(bag.fcurves)
    return curves


def smooth(u):
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)


def window(u, start, end):
    return smooth((u - start) / (end - start))


class Rig:
    def __init__(self, rig):
        self.rig = rig
        self.bones = rig.pose.bones
        self.rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}

    def capture(self):
        return {pb.name: pb.matrix_basis.copy() for pb in self.bones}

    def apply(self, pose):
        for name, basis in pose.items():
            self.bones[name].matrix_basis = basis
        bpy.context.view_layer.update()

    def head(self, name):
        return self.bones[name].head.copy()

    def length(self, a, b):
        return (self.rest[b].translation - self.rest[a].translation).length


def action(name):
    found = bpy.data.actions.get(name)
    if found is None:
        raise ValueError(f"the target GLB has no {name} clip")
    return found


def sample(rig, source, frame):
    data = rig.rig.animation_data
    data.action = source
    if hasattr(data, "action_slot") and source.slots:
        data.action_slot = source.slots[0]
    bpy.context.scene.frame_set(int(math.floor(frame)), subframe=frame - math.floor(frame))
    bpy.context.view_layer.update()
    return rig.capture()


def rotate_world(rig, name, axis, degrees, pivot=None):
    """Rotate a bone about an armature-space axis through its head (or ``pivot``); its children follow."""
    pb = rig.bones[name]
    m = pb.matrix.copy()
    head = (pivot if pivot is not None else m.translation).copy()
    pb.matrix = Matrix.Translation(head) @ Matrix.Rotation(math.radians(degrees), 4, axis) @ Matrix.Translation(-head) @ m
    bpy.context.view_layer.update()


def aim(rig, name, direction):
    pb = rig.bones[name]
    rest = rig.rest[name]
    rest_y = (rest.to_3x3() @ Vector((0, 1, 0))).normalized()
    m = rest_y.rotation_difference(direction.normalized()).to_matrix().to_4x4() @ rest.to_3x3().to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


def solve_leg(rig, side, ankle, forward, yaw):
    """Two-bone leg solve to ``ankle`` with the knee towards ``forward``; the foot keeps its rest pose turned by ``yaw``."""
    thigh, calf, foot, ball = LEGS[side]
    hip = rig.head(thigh)
    l1, l2 = rig.length(thigh, calf), rig.length(calf, foot)
    reach = ankle - hip
    d = min(reach.length, (l1 + l2) * .999)
    u = reach.normalized()
    a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    knee = hip + u * a + (forward - u * forward.dot(u)).normalized() * h
    aim(rig, thigh, knee - hip)
    aim(rig, calf, (hip + u * d) - knee)
    pb = rig.bones[foot]
    m = Matrix.Rotation(math.radians(yaw), 4, UP) @ rig.rest[foot].to_3x3().to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    rig.bones[ball].matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


def upper_hit(rig, clip, stand):
    frames = int(round(UPPER["duration"] * FPS))
    peak = UPPER["peak"]
    poses = []
    for k in range(frames + 1):
        u = k / frames
        # A fast snap to the peak, then a slower ease back to the idle pose.
        weight = smooth(u / peak) if u < peak else 1.0 - smooth((u - peak) / (1 - peak))
        rig.apply(stand)
        for joint, axis, degrees in HITS[clip]:
            rotate_world(rig, joint, axis, degrees * weight)
        poses.append(rig.capture())
    joints = [UPPER_ROOT, *(bone.name for bone in rig.rig.data.bones[UPPER_ROOT].children_recursive)]
    return poses, {"source": STAND, "durationSeconds": round(frames / FPS, 4), "peakSeconds": round(peak * frames / FPS, 4),
                   "layer": UPPER_ROOT, "joints": joints}


def shove(rig, stand):
    rig.apply(stand)
    pivot = rig.head("pelvis")
    pivot.z = 0.0
    ankles = {side: rig.head(LEGS[side][2]) for side in LEGS}
    frames = int(round(SHOVE["duration"] * FPS))
    total = SHOVE["degrees"]
    catch_in, catch_low, catch_out = SHOVE["catch"]
    poses = []
    for k in range(frames + 1):
        u = k / frames
        rig.apply(stand)
        rotate_world(rig, "pelvis", UP, total * window(u, *SHOVE["spin"]), pivot)
        # Balance crouch after the spin.
        drop = SHOVE["crouch"] * (window(u, catch_in, catch_low) - window(u, catch_low, catch_out))
        pelvis = rig.bones["pelvis"]
        m = pelvis.matrix.copy()
        m.translation.z -= drop
        pelvis.matrix = m
        bpy.context.view_layer.update()
        # The impact jolts the torso back; the chest lags the spin and the arms fling out while it turns.
        jolt = SHOVE["jolt"] * (window(u, 0.0, .04) - window(u, .04, .3))
        spinning = math.sin(math.pi * window(u, *SHOVE["spin"]))
        rotate_world(rig, "spine_01", X, jolt + 10.0 * (window(u, catch_in, catch_low) - window(u, catch_low, catch_out)))
        rotate_world(rig, "spine_02", UP, -math.copysign(SHOVE["lag"], total) * spinning)
        rotate_world(rig, "neck_01", UP, -math.copysign(SHOVE["lag"] * .5, total) * spinning)
        rotate_world(rig, "upperarm_l", Y, -SHOVE["fling"] * spinning)
        rotate_world(rig, "upperarm_r", Y, SHOVE["fling"] * spinning)
        for side in LEGS:
            (a0, a1), (b0, b1) = SHOVE["steps"][side]
            yaw = total * .5 * (window(u, a0, a1) + window(u, b0, b1))
            heading = Matrix.Rotation(math.radians(yaw), 4, UP)
            ankle = pivot + heading @ (ankles[side] - pivot)
            for start, end in ((a0, a1), (b0, b1)):
                into = (u - start) / (end - start)
                if 0.0 < into < 1.0:
                    ankle.z += SHOVE["lift"] * math.sin(math.pi * into)
            solve_leg(rig, side, ankle, heading @ Vector((0, -1, 0)), yaw)
        poses.append(rig.capture())
    return poses, {"source": STAND, "durationSeconds": SHOVE["duration"], "degrees": total}


def author(rig, clip):
    """The clip's poses (one per frame at FPS) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    stand_action = action(STAND)
    stand = sample(rig, stand_action, stand_action.frame_range[0])
    if clip in HITS:
        return upper_hit(rig, clip, stand)
    return shove(rig, stand)


def write_action(rig_object, clip, poses):
    data = rig_object.animation_data or rig_object.animation_data_create()
    data.action = None
    for other in list(bpy.data.actions):
        bpy.data.actions.remove(other)
    new = bpy.data.actions.new(clip)
    data.action = new
    bpy.context.scene.render.fps, bpy.context.scene.render.fps_base = FPS, 1
    for frame, pose in enumerate(poses):
        for name, basis in pose.items():
            pb = rig_object.pose.bones[name]
            pb.matrix_basis = basis
            pb.keyframe_insert("location", frame=frame)
            pb.keyframe_insert("rotation_quaternion", frame=frame)
    for curve in action_curves(new):
        for key in curve.keyframe_points:
            key.interpolation = "LINEAR"
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = 0, len(poses) - 1


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    clip = arguments["clip"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=inputs["target"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
    target_objects = [o for o in bpy.context.scene.objects if o not in before]
    rigs = [o for o in target_objects if o.type == "ARMATURE"]
    if len(rigs) != 1:
        raise ValueError("the target GLB must have one armature")
    poses, observations = author(Rig(rigs[0]), clip)
    write_action(rigs[0], clip, poses)
    bpy.ops.object.select_all(action="DESELECT")
    for item in target_objects:
        if item.name in bpy.data.objects:
            item.select_set(True)
    bpy.context.view_layer.objects.active = rigs[0]
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=False, export_tangents=False, export_materials="NONE",
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=False, export_optimize_animation_keep_anim_armature=True,
        export_skins=True, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "hit-clip-v1", "clip": clip, "fps": FPS, "frames": len(poses), **observations}
