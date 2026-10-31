"""Original directional gait, start/stop and turn clips authored on the Ranger rig in Blender (#112, #399, Atlas 6.1.7).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe reads the CC0 UAL1
``Jog_Fwd_Loop``, ``Walk_Loop`` and ``Idle_Loop`` (already retargeted onto the rig) and authors new in-place clips,
every name in ``arguments["clips"]``, in one run (#425). The jog and walk clips are one matched family (#399): each speed has a backward loop and a
strafe pair built the same way, so a consumer blends walk and jog by angle and by speed.

- ``Jog_Bwd_Loop`` / ``Walk_Bwd_Loop``: the forward loop played backwards with the torso leaning back by the forward
  loop's extra lean, so both stand like the idle. The left foot plants at phase 0, as in the forward loops.
- ``Jog_Strafe_*_Loop`` / ``Walk_Strafe_*_Loop``: an authored side-step. The feet follow explicit in-place
  trajectories: a stance foot slides against the travel direction at the reference speed, and swing feet lift and step
  in the travel direction, the lead foot out and the trail foot in behind it. Both speeds use the same swing phases
  (the lead foot plants at phase 0, the trail foot at 0.55) and the same foot spans; the walk has a longer period, so
  it is slower, with lower lifts, less bob and lean. A two-bone knee solve keeps the knees in front, and the feet stay
  level. The upper body keeps a damped copy of the source loop's arm and spine swing.
- ``Walk_Start``: from the first ``Idle_Loop`` pose into ``Walk_Loop``, ending exactly at its phase 0.
- ``Walk_Stop``: from ``Walk_Loop`` phase 0 into the first ``Idle_Loop`` pose.
- ``Turn_Left`` / ``Turn_Right``: a 90 degree turn on the spot in two steps, the inside foot first. The head and chest
  lead the turn. The body ends rotated (owner answer #112 Q2).

Travelling clips report the horizontal travel they would cover (glTF x, z: +x is the figure's left, +z ahead) as
``removedTravel``. No Mixamo data is used; Mixamo clips were only watched as motion reference. The output GLB is the
target skeleton with its meshes and one action per clip, which the build extracts by name and embeds. No
randomness.
"""
import math

import bpy
from mathutils import Matrix, Quaternion, Vector

LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
FPS = 30
STAND = "Idle_Loop"
UP = Vector((0, 0, 1))
# Per speed: the forward source loop, the back lean that cancels its extra forward lean (degrees), and the strafe gait.
# Strafe: "lead"/"trail" are each foot's swing (start, end) phases; it is planted for the rest of the cycle. Distances
# in metres, speeds in metres per second, angles in degrees; "damp" is how much of the source upper-body swing is kept.
GAITS = {
    "Jog": {"source": "Jog_Fwd_Loop", "backLean": 18.0,
            "strafe": {"period": .5, "speed": 1.4, "lead": (.6, 1.0), "trail": (.3, .55), "lift": (.1, .08), "gap": .12,
                       "lean": 6.0, "damp": .45, "bob": .025}},
    # Same phases and foot spans (speed x period) as the jog, a slower cadence.
    "Walk": {"source": "Walk_Loop", "backLean": 2.0,
             "strafe": {"period": .8, "speed": .875, "lead": (.6, 1.0), "trail": (.3, .55), "lift": (.06, .045), "gap": .12,
                        "lean": 3.0, "damp": .45, "bob": .012}},
}
TRANSITION = {"Walk_Start": .8, "Walk_Stop": .8}
# Turn: total yaw, duration, the inside then the outside foot's step window (fractions), the step lift, how far the
# head and chest lead the pelvis.
TURN = {"degrees": 90.0, "duration": .9333, "steps": ((.12, .5), (.45, .85)), "lift": .05, "lead": 14.0}
CLIPS = ("Jog_Bwd_Loop", "Jog_Strafe_Left_Loop", "Jog_Strafe_Right_Loop", "Walk_Bwd_Loop", "Walk_Strafe_Left_Loop",
         "Walk_Strafe_Right_Loop", "Walk_Start", "Walk_Stop", "Turn_Left", "Turn_Right")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips"}:
        raise ValueError("gait clips require exactly schemaVersion and clips")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"gait clips must be distinct names from {CLIPS}")
    if set(inputs) != {"target"}:
        raise ValueError("gait clip takes exactly the declared input target")


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


def blend(a, b, u):
    """Per-bone blend of two captured poses: slerped rotation, interpolated location."""
    out = {}
    for name in a:
        la, ra, _ = a[name].decompose()
        lb, rb, _ = b[name].decompose()
        if ra.dot(rb) < 0:
            rb.negate()
        out[name] = Matrix.Translation(la.lerp(lb, u)) @ ra.slerp(rb, u).to_matrix().to_4x4()
    return out


def rotate_world(rig, name, axis, degrees, pivot=None):
    """Rotate a bone about an armature-space axis through its head (or ``pivot``); its children follow."""
    pb = rig.bones[name]
    m = pb.matrix.copy()
    head = (pivot if pivot is not None else m.translation).copy()
    pb.matrix = Matrix.Translation(head) @ Matrix.Rotation(math.radians(degrees), 4, axis) @ Matrix.Translation(-head) @ m
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


def level(rig, name, yaw=0.0):
    """Give a bone its rest orientation in armature space turned ``yaw`` degrees about the vertical, at its head."""
    pb = rig.bones[name]
    m = Matrix.Rotation(math.radians(yaw), 4, UP) @ rig.rest[name].to_3x3().to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


def solve_leg(rig, side, ankle, forward, yaw=0.0):
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
    level(rig, foot, yaw)
    rig.bones[ball].matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


def loop_source(name):
    source = action(name)
    start, end = source.frame_range
    import_fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    return source, start, (end - start) / import_fps, import_fps


def backward(rig, clip):
    gait = GAITS[clip.split("_")[0]]
    source, start, duration, import_fps = loop_source(gait["source"])
    frames = int(round(duration * FPS))
    poses = []
    for k in range(frames + 1):
        t = k / FPS
        source_time = (duration - t) % duration if k < frames else 0.0
        rig.apply(sample(rig, source, start + source_time * import_fps))
        # Back lean: rotate the lowest spine joint about the lateral axis so the head moves backwards (+Y in Blender).
        rotate_world(rig, "spine_01", Vector((1, 0, 0)), -gait["backLean"])
        poses.append(rig.capture())
    return poses, {"source": gait["source"], "reversed": True, "backLeanDegrees": gait["backLean"]}


def strafe(rig, clip):
    gait = GAITS[clip.split("_")[0]]
    source, start, duration, import_fps = loop_source(gait["source"])
    s = gait["strafe"]
    period = s["period"]
    frames = int(round(period * FPS))
    direction = 1.0 if "_Left_" in clip else -1.0
    lead, trail = ("l", "r") if direction > 0 else ("r", "l")
    pelvis = rig.bones["pelvis"]
    rest_pose = {name: Matrix.Identity(4) for name in rig.rest}
    upper = [name for name in rig.rest if name not in {"root", "pelvis"} and not any(name in leg for leg in LEGS.values())]
    rig.apply(rest_pose)
    rest_ankle = {side: rig.head(LEGS[side][2]) for side in LEGS}
    rest_hips = rig.head("pelvis")
    hip_offset = {side: rig.head(LEGS[side][0]) - rest_hips for side in LEGS}
    leg_length = {side: rig.length(LEGS[side][0], LEGS[side][1]) + rig.length(LEGS[side][1], LEGS[side][2]) for side in LEGS}
    swings = {lead: s["lead"], trail: s["trail"]}
    # A planted foot slides back at the reference speed for the time it is planted.
    spans = {side: s["speed"] * period * (1 - (swings[side][1] - swings[side][0]) % 1.0) for side in LEGS}
    lift = {lead: s["lift"][0], trail: s["lift"][1]}
    # Place the two touchdown points so the trail foot lands `gap` short of the lead foot (no crossing).
    lead_at_trail_landing = foot_track(s["trail"][1], swings[lead], spans[lead], 0)[0]
    separation = s["gap"] - lead_at_trail_landing
    touchdown = {lead: direction * separation / 2, trail: -direction * separation / 2}
    forward = Vector((0, -1, 0))
    # The source loop's mean upper-body pose over its cycle; the strafe keeps that posture with a damped swing around it.
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
    poses = []
    for k in range(frames + 1):
        p = (k % frames) / frames
        swing_pose = sample(rig, source, start + (p * duration) * import_fps)
        pose = dict(rest_pose)
        for name in upper:
            pose[name] = mean[name].slerp(swing_pose[name].to_quaternion(), s["damp"]).to_matrix().to_4x4()
        rig.apply(pose)
        targets = {}
        for side in (lead, trail):
            offset, height = foot_track(p, swings[side], spans[side], lift[side])
            ankle = rest_ankle[side].copy()
            ankle.x = touchdown[side] + direction * offset
            ankle.z += height
            targets[side] = ankle
        # The pelvis drops as far as the spread legs need (knees kept slightly bent) and bobs with the step.
        reach = min(targets[side].z - hip_offset[side].z + math.sqrt(max((leg_length[side] * .95) ** 2
                    - (targets[side].x - rest_hips.x - hip_offset[side].x) ** 2 - (targets[side].y - rest_hips.y - hip_offset[side].y) ** 2, 0.0))
                    for side in LEGS)
        bob = s["bob"] * math.cos(2 * math.pi * (p - .15))
        height = min(rest_hips.z, reach + .02) - s["bob"] + bob
        m = pelvis.matrix.copy()
        m.translation = Vector((rest_hips.x, rest_hips.y, height))
        pelvis.matrix = m
        bpy.context.view_layer.update()
        rotate_world(rig, "spine_01", Vector((0, 1, 0)), -direction * s["lean"])
        for side in LEGS:
            solve_leg(rig, side, targets[side], forward)
        poses.append(rig.capture())
    travel = direction * s["speed"] * period
    return poses, {"source": gait["source"], "gait": "side-step", "periodSeconds": period, "referenceSpeedMetersPerSecond": s["speed"],
                   "direction": "left" if direction > 0 else "right", "removedTravel": [round(travel, 4), 0.0]}


def walk_speed(rig, source, start, duration, import_fps):
    """The walk's ground speed: how fast the planted left foot moves back between phases 0.1 and 0.35."""
    rig.apply(sample(rig, source, start + .1 * duration * import_fps))
    y0 = rig.head("foot_l").y
    rig.apply(sample(rig, source, start + .35 * duration * import_fps))
    y1 = rig.head("foot_l").y
    return (y1 - y0) / (.25 * duration)


def transition(rig, clip):
    source, start, duration, import_fps = loop_source("Walk_Loop")
    stand_action = action(STAND)
    stand = sample(rig, stand_action, stand_action.frame_range[0])
    speed = walk_speed(rig, source, start, duration, import_fps)
    length = TRANSITION[clip]
    frames = int(round(length * FPS))
    starting = clip == "Walk_Start"
    poses = []
    travel = 0.0
    for k in range(frames + 1):
        u = k / frames
        t = u * length
        # Walk_Start's walk phase runs up to exactly 0 at its end, so Walk_Loop continues from its first frame.
        phase = (((t - length) if starting else t) / duration) % 1.0
        weight = smooth(u) if starting else 1.0 - smooth(u)
        poses.append(blend(stand, sample(rig, source, start + phase * duration * import_fps), weight))
        if k < frames:
            mid = smooth((k + .5) / frames)
            travel += speed * (mid if starting else 1.0 - mid) * length / frames
    return poses, {"source": "Walk_Loop", "from": "stand" if starting else "Walk_Loop", "to": "Walk_Loop" if starting else "stand",
                   "durationSeconds": length, "walkSpeedMetersPerSecond": round(speed, 4), "removedTravel": [0.0, round(travel, 4)]}


def turn(rig, clip):
    sign = 1.0 if clip == "Turn_Left" else -1.0
    inside, outside = ("l", "r") if sign > 0 else ("r", "l")
    stand_action = action(STAND)
    stand = sample(rig, stand_action, stand_action.frame_range[0])
    rig.apply(stand)
    pivot = rig.head("pelvis")
    pivot.z = 0.0
    ankles = {side: rig.head(LEGS[side][2]) for side in LEGS}
    steps = {inside: TURN["steps"][0], outside: TURN["steps"][1]}
    total = sign * TURN["degrees"]
    frames = int(round(TURN["duration"] * FPS))
    poses = []
    for k in range(frames + 1):
        u = k / frames
        rig.apply(stand)
        rotate_world(rig, "pelvis", UP, total * window(u, .08, .88), pivot)
        # The head and chest lead the pelvis into the turn and settle back by the end.
        lead = sign * TURN["lead"] * math.sin(math.pi * window(u, 0.0, .9))
        rotate_world(rig, "spine_02", UP, lead * .5)
        rotate_world(rig, "neck_01", UP, lead * .5)
        for side in LEGS:
            yaw = total * window(u, *steps[side])
            heading = Matrix.Rotation(math.radians(yaw), 4, UP)
            ankle = pivot + heading @ (ankles[side] - pivot)
            into = (u - steps[side][0]) / (steps[side][1] - steps[side][0])
            if 0.0 < into < 1.0:
                ankle.z += TURN["lift"] * math.sin(math.pi * into)
            solve_leg(rig, side, ankle, heading @ Vector((0, -1, 0)), yaw)
        poses.append(rig.capture())
    return poses, {"source": STAND, "degrees": total, "durationSeconds": TURN["duration"], "firstStep": inside}


def author(rig, clip):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    if clip.endswith("_Bwd_Loop"):
        return backward(rig, clip)
    if "_Strafe_" in clip:
        return strafe(rig, clip)
    if clip in TRANSITION:
        return transition(rig, clip)
    return turn(rig, clip)


def imported_state(rig_object):
    """The rig's state right after import: its action, slot, pose and the scene frame and rate."""
    data = rig_object.animation_data
    scene = bpy.context.scene
    return {"action": data.action if data else None, "slot": getattr(data, "action_slot", None) if data else None,
            "pose": {pb.name: pb.matrix_basis.copy() for pb in rig_object.pose.bones},
            "frame": scene.frame_current, "fps": (scene.render.fps, scene.render.fps_base)}


def restore_state(rig_object, state):
    data = rig_object.animation_data
    if data is not None:
        data.action = state["action"]
        if state["action"] is not None and state["slot"] is not None and hasattr(data, "action_slot"):
            data.action_slot = state["slot"]
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = state["fps"]
    scene.frame_set(state["frame"])
    for name, basis in state["pose"].items():
        rig_object.pose.bones[name].matrix_basis = basis


def write_actions(rig_object, clips):
    """Replace every action with one LINEAR action per clip, keyed at FPS from frame 0."""
    data = rig_object.animation_data or rig_object.animation_data_create()
    data.action = None
    for other in list(bpy.data.actions):
        bpy.data.actions.remove(other)
    bpy.context.scene.render.fps, bpy.context.scene.render.fps_base = FPS, 1
    for clip, poses in clips.items():
        new = bpy.data.actions.new(clip)
        data.action = new
        for frame, pose in enumerate(poses):
            for name, basis in pose.items():
                pb = rig_object.pose.bones[name]
                pb.matrix_basis = basis
                pb.keyframe_insert("location", frame=frame)
                pb.keyframe_insert("rotation_quaternion", frame=frame)
        for curve in action_curves(new):
            for key in curve.keyframe_points:
                key.interpolation = "LINEAR"
        new.use_fake_user = True
        data.action = None
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = 0, max(len(poses) for poses in clips.values()) - 1


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=inputs["target"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
    target_objects = [o for o in bpy.context.scene.objects if o not in before]
    rigs = [o for o in target_objects if o.type == "ARMATURE"]
    if len(rigs) != 1:
        raise ValueError("the target GLB must have one armature")
    # Every clip starts from the imported state, as it would in a run of its own.
    fresh = imported_state(rigs[0])
    authored = {}
    for clip in arguments["clips"]:
        restore_state(rigs[0], fresh)
        authored[clip] = author(Rig(rigs[0]), clip)
    write_actions(rigs[0], {clip: poses for clip, (poses, _) in authored.items()})
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
    return {"recipe": "gait-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
