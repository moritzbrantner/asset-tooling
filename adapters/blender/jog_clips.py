"""Original jog-speed backward and strafe clips authored on the Ranger rig in Blender (#112, Atlas 6.1.7).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe reads the CC0 UAL1
``Jog_Fwd_Loop`` (already retargeted onto the rig) and authors one new in-place clip, named ``arguments["clip"]``:

- ``Jog_Bwd_Loop``: the forward jog played backwards with the torso leaning back instead of forward.
- ``Jog_Strafe_Left_Loop`` / ``Jog_Strafe_Right_Loop``: an authored side-gallop. The feet follow explicit in-place
  trajectories: a stance foot slides against the travel direction at the reference speed, and swing feet lift and step
  in the travel direction, the lead foot out and the trail foot in behind it. A two-bone knee solve keeps the knees
  in front, and the feet stay level. The pelvis bobs and drops as far as the spread legs need. The upper body keeps a
  damped copy of the jog's arm and spine swing, rolled slightly into the travel direction.

No Mixamo data is used; Mixamo clips were only watched as motion reference. The output GLB is the target skeleton
with its meshes and the single clip, which the build extracts and embeds like the other clips. No randomness.
"""
import math

import bpy
from mathutils import Matrix, Quaternion, Vector

CLIPS = ("Jog_Bwd_Loop", "Jog_Strafe_Left_Loop", "Jog_Strafe_Right_Loop")
SOURCE = "Jog_Fwd_Loop"
FPS = 30
LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
# Strafe gait (side-gallop), as fractions of the cycle; distances in metres, speeds in metres per second.
# "lead"/"trail" are each foot's swing (start, end) phases; it is planted for the rest of the cycle.
STRAFE = {"period": .5, "speed": 1.4, "lead": (.6, 1.0), "trail": (.3, .55), "lift": (.1, .08), "gap": .12, "lean": 6.0,
          "damp": .45, "bob": .025}
BACK_LEAN = 18.0


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clip"}:
        raise ValueError("jog clip requires exactly schemaVersion and clip")
    if p["schemaVersion"] != 1 or p["clip"] not in CLIPS:
        raise ValueError(f"jog clip must be one of {CLIPS}")
    if set(inputs) != {"target"}:
        raise ValueError("jog clip takes exactly the declared input target")


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


def foot_track(p, swing, span, lift):
    """In-place lateral offset (0 at the touchdown point) and height of one foot at cycle phase ``p``.

    ``swing`` = (start, end) phases of the swing; the foot is planted for the rest of the cycle and slides back by
    ``span`` over that time, then swings forward by ``span``.
    """
    start, end = swing
    length = (end - start) % 1.0
    into = (p - start) % 1.0
    if into < length:
        u = into / length
        return -span + span * smooth(u), lift * math.sin(math.pi * u)
    planted = (p - end) % 1.0
    return -span * planted / (1 - length), 0.0


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


def sample(rig, action, frame):
    data = rig.rig.animation_data
    data.action = action
    if hasattr(data, "action_slot") and action.slots:
        data.action_slot = action.slots[0]
    bpy.context.scene.frame_set(int(math.floor(frame)), subframe=frame - math.floor(frame))
    bpy.context.view_layer.update()
    return rig.capture()


def rotate_world(rig, name, axis, degrees):
    """Rotate a bone about an armature-space axis through its head; its children follow."""
    pb = rig.bones[name]
    m = pb.matrix.copy()
    turn = Matrix.Rotation(math.radians(degrees), 4, axis)
    head = m.translation.copy()
    m = Matrix.Translation(head) @ turn @ Matrix.Translation(-head) @ m
    pb.matrix = m
    bpy.context.view_layer.update()


def aim(rig, name, direction):
    """Point a bone (its local +Y) along ``direction`` in armature space by the minimal turn from its rest."""
    pb = rig.bones[name]
    rest = rig.rest[name]
    rest_y = (rest.to_3x3() @ Vector((0, 1, 0))).normalized()
    turn = rest_y.rotation_difference(direction.normalized()).to_matrix().to_4x4()
    m = turn @ rest.to_3x3().to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


def level(rig, name):
    """Give a bone its rest orientation in armature space, at its current head."""
    pb = rig.bones[name]
    m = rig.rest[name].to_3x3().to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


def solve_leg(rig, side, ankle, forward):
    thigh, calf, foot, ball = LEGS[side]
    hip = rig.head(thigh)
    l1 = (rig.rest[calf].translation - rig.rest[thigh].translation).length
    l2 = (rig.rest[foot].translation - rig.rest[calf].translation).length
    reach = ankle - hip
    d = min(reach.length, (l1 + l2) * .999)
    u = reach.normalized()
    a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    bend = (forward - u * forward.dot(u)).normalized()
    knee = hip + u * a + bend * h
    aim(rig, thigh, knee - hip)
    aim(rig, calf, (hip + u * d) - knee)
    level(rig, foot)
    rig.bones[ball].matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


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
    source = bpy.data.actions.get(SOURCE)
    if source is None:
        raise ValueError(f"the target GLB has no {SOURCE} clip")
    import_fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    start, end = source.frame_range
    duration = (end - start) / import_fps
    rig = Rig(rigs[0])
    pelvis = rig.bones["pelvis"]
    rest_pose = {name: Matrix.Identity(4) for name in rig.rest}
    upper = [name for name in rig.rest if name not in {"root", "pelvis"} and not any(name in leg for leg in LEGS.values())]

    if clip == "Jog_Bwd_Loop":
        period = duration
    else:
        period = STRAFE["period"]
    frames = int(round(period * FPS))
    poses = []
    observations = {}
    if clip == "Jog_Bwd_Loop":
        # Back lean: rotate the lowest spine joint about the lateral axis so the head moves backwards (+Y in Blender).
        for k in range(frames + 1):
            t = k / FPS
            source_time = (duration - t) % duration if k < frames else 0.0
            pose = sample(rig, source, start + source_time * import_fps)
            rig.apply(pose)
            rotate_world(rig, "spine_01", Vector((1, 0, 0)), -BACK_LEAN)
            poses.append(rig.capture())
        observations = {"source": SOURCE, "reversed": True, "backLeanDegrees": BACK_LEAN}
    else:
        direction = 1.0 if clip == "Jog_Strafe_Left_Loop" else -1.0
        lead, trail = ("l", "r") if direction > 0 else ("r", "l")
        rig.apply(rest_pose)
        rest_ankle = {side: rig.head(LEGS[side][2]) for side in LEGS}
        rest_hips = rig.head("pelvis")
        hip_offset = {side: rig.head(LEGS[side][0]) - rest_hips for side in LEGS}
        leg_length = {side: (rig.rest[LEGS[side][1]].translation - rig.rest[LEGS[side][0]].translation).length
                      + (rig.rest[LEGS[side][2]].translation - rig.rest[LEGS[side][1]].translation).length for side in LEGS}
        swings = {lead: STRAFE["lead"], trail: STRAFE["trail"]}
        # A planted foot slides back at the reference speed for the time it is planted.
        spans = {side: STRAFE["speed"] * period * (1 - (swings[side][1] - swings[side][0]) % 1.0) for side in LEGS}
        lift = {lead: STRAFE["lift"][0], trail: STRAFE["lift"][1]}
        # Place the two touchdown points so the trail foot lands `gap` short of the lead foot (no crossing).
        lead_at_trail_landing = foot_track(STRAFE["trail"][1], swings[lead], spans[lead], 0)[0]
        separation = STRAFE["gap"] - lead_at_trail_landing
        touchdown = {lead: direction * separation / 2, trail: -direction * separation / 2}
        forward = Vector((0, -1, 0))
        # The jog's mean upper-body pose over its cycle; the strafe keeps that posture with a damped swing around it.
        cycle = [sample(rig, source, start + duration * i / 24 * import_fps) for i in range(24)]
        mean = {}
        for name in upper:
            total = [0.0, 0.0, 0.0, 0.0]
            reference = cycle[0][name].to_quaternion()
            for pose in cycle:
                q = pose[name].to_quaternion()
                if q.dot(reference) < 0:
                    q.negate()
                total = [t + c for t, c in zip(total, q)]
            norm = math.sqrt(sum(c * c for c in total))
            mean[name] = Quaternion(tuple(c / norm for c in total))
        for k in range(frames + 1):
            p = (k % frames) / frames
            jog = sample(rig, source, start + (p * duration) * import_fps)
            pose = dict(rest_pose)
            for name in upper:
                q = jog[name].to_quaternion()
                pose[name] = mean[name].slerp(q, STRAFE["damp"]).to_matrix().to_4x4()
            rig.apply(pose)
            targets = {}
            for side in (lead, trail):
                offset, height = foot_track(p, swings[side], spans[side], lift[side])
                ankle = rest_ankle[side].copy()
                ankle.x = touchdown[side] + direction * offset
                ankle.z += height
                targets[side] = ankle
            # The pelvis drops as far as the spread legs need (knees kept slightly bent) and bobs with the gallop.
            reach = min(targets[side].z - hip_offset[side].z + math.sqrt(max((leg_length[side] * .95) ** 2
                        - (targets[side].x - rest_hips.x - hip_offset[side].x) ** 2 - (targets[side].y - rest_hips.y - hip_offset[side].y) ** 2, 0.0))
                        for side in LEGS)
            bob = STRAFE["bob"] * math.cos(2 * math.pi * (p - .15))
            height = min(rest_hips.z, reach + .02) - STRAFE["bob"] + bob
            m = pelvis.matrix.copy()
            m.translation = Vector((rest_hips.x, rest_hips.y, height))
            pelvis.matrix = m
            bpy.context.view_layer.update()
            rotate_world(rig, "spine_01", Vector((0, 1, 0)), -direction * STRAFE["lean"])
            for side in LEGS:
                solve_leg(rig, side, targets[side], forward)
            poses.append(rig.capture())
        observations = {"source": SOURCE, "gait": "side-gallop", "periodSeconds": period,
                        "referenceSpeedMetersPerSecond": STRAFE["speed"], "direction": "left" if direction > 0 else "right"}

    data = rig.rig.animation_data
    data.action = None
    for other in list(bpy.data.actions):
        bpy.data.actions.remove(other)
    action = bpy.data.actions.new(clip)
    data.action = action
    bpy.context.scene.render.fps, bpy.context.scene.render.fps_base = FPS, 1
    for frame, pose in enumerate(poses):
        for name, basis in pose.items():
            pb = rig.bones[name]
            pb.matrix_basis = basis
            pb.keyframe_insert("location", frame=frame)
            pb.keyframe_insert("rotation_quaternion", frame=frame)
    for curve in action_curves(action):
        for key in curve.keyframe_points:
            key.interpolation = "LINEAR"
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = 0, len(poses) - 1

    bpy.ops.object.select_all(action="DESELECT")
    for item in target_objects:
        if item.name in bpy.data.objects:
            item.select_set(True)
    bpy.context.view_layer.objects.active = rig.rig
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=False, export_tangents=False, export_materials="NONE",
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=False, export_optimize_animation_keep_anim_armature=True,
        export_skins=True, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "jog-clip-v1", "clip": clip, "fps": FPS, "frames": len(poses), **observations}
