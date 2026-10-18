"""Original bow clips authored on the Ranger rig in Blender (#277, owner answer 2026-10-18: original keyframes).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors one in-place clip,
named ``arguments["clip"]``, from explicit archery targets:

- ``Bow_Aim_Loop``: the bow raised toward the target, an arrow nocked and the string set (partly drawn).
- ``Bow_Draw``: from the aim pose to full draw, the string hand coming to an anchor under the right cheek.
- ``Bow_Hold_Loop``: held at full draw.
- ``Bow_Release``: the string hand releases, flies back past the anchor and opens; the bow arm follows through.
- ``Bow_Recovery``: from the follow-through, the string hand reaches the back quiver, then nocks and sets again.
- ``Bow_Cancel``: from full draw, the string is let down to the aim pose.

The archer stands side-on: the pelvis turns 40 degrees and the chest about 85 degrees, so the left shoulder points
at the target, and the head turns back to face it. The bow sits in the left hand through the ``hand_l.bow`` socket
and the arrow's nock in the right through ``hand_r.arrow``; both arms are placed with a two-bone solve whose elbow
hinges about the joint's local X axis. The idle clip ``Idle_Loop`` (CC0 UAL1, already on the rig) supplies the
breathing of the loops; the one-shots use its first frame. Fingers take the grip of ``Idle_Shield_Loop`` (bow hand)
and ``Sword_Idle`` (string hand, eased toward rest as a hook).

The returned observations hold, for every frame, the string draw in metres: the arrow socket's distance behind the
bow's braced string along the bow's draw axis (``BOW_DRAW_CONTRACT``), so a consumer can drive the bow's ``nock``
joint. No Mixamo data is used; Mixamo clips were only watched as motion reference. No randomness.
"""
import math

import bpy
from mathutils import Matrix, Quaternion, Vector

CLIPS = ("Bow_Aim_Loop", "Bow_Draw", "Bow_Hold_Loop", "Bow_Release", "Bow_Recovery", "Bow_Cancel")
BASE = "Idle_Loop"
FPS = 30
# Stance, in degrees and metres (Blender world: +Z up, the character faces -Y, its left is +X).
# The spine turns from ``spineSet`` (aim pose) to ``spineFull`` (full draw) per spine joint; neck and head turn back by
# the total so the face stays on the target.
STANCE = {"pelvisYaw": -40.0, "spineSet": -5.0, "spineFull": -15.0, "headShare": .6, "headPitch": 4.0,
          "footSpread": 1.45, "pelvisDrop": .02, "bowCant": 10.0}
# The arrow's nock at full draw, from the Head joint: right (-X), forward (-Y) and up (+Z).
ANCHOR = Vector((-.045, -.075, -.015))
DURATIONS = {"Bow_Draw": .7, "Bow_Release": .45, "Bow_Recovery": 1.1, "Bow_Cancel": .6}
# Finger curl toward the palm, in degrees per joint (01, 02, 03): a fist on the bow's grip, a three-finger hook on
# the string, and the relaxed hand after the release.
GRIPS = {
    "fist": {"index": (65, 95, 60), "middle": (70, 95, 60), "ring": (72, 95, 60), "pinky": (75, 95, 60), "thumb": (15, 35, 35)},
    "hook": {"index": (20, 75, 45), "middle": (20, 75, 45), "ring": (25, 75, 45), "pinky": (60, 90, 60), "thumb": (25, 45, 35)},
    "open": {"index": (8, 15, 10), "middle": (8, 15, 10), "ring": (10, 18, 10), "pinky": (12, 20, 12), "thumb": (5, 10, 10)},
}
LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def validate(p, inputs):
    keys = {"schemaVersion", "clip", "sockets", "braceHeight", "arrowLength", "quiverLength"}
    if type(p) is not dict or set(p) != keys:
        raise ValueError(f"bow clip requires exactly {sorted(keys)}")
    if p["schemaVersion"] != 1 or p["clip"] not in CLIPS:
        raise ValueError(f"bow clip must be one of {CLIPS}")
    if set(p["sockets"]) != {"bow", "arrow", "quiver"}:
        raise ValueError("bow clip sockets must be bow, arrow and quiver")
    if set(inputs) != {"target"}:
        raise ValueError("bow clip takes exactly the declared input target")


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


def socket_matrix(socket):
    t, r = socket["translation"], socket["rotation"]
    return Matrix.LocRotScale(Vector(t), Quaternion((r[3], r[0], r[1], r[2])), Vector((1, 1, 1)))


def gltf_rest_worlds(path):
    """World matrices (glTF axes) of every named node of the declared target, at rest."""
    import json
    import struct
    data = open(path, "rb").read()
    doc = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]] if data[:4] == b"glTF" else data)
    nodes, worlds = doc["nodes"], {}

    def local(node):
        if "matrix" in node:
            m = node["matrix"]
            return Matrix([m[0:4], m[4:8], m[8:12], m[12:16]]).transposed()
        r = node.get("rotation", [0, 0, 0, 1])
        return Matrix.LocRotScale(Vector(node.get("translation", [0, 0, 0])), Quaternion((r[3], r[0], r[1], r[2])),
                                  Vector(node.get("scale", [1, 1, 1])))

    def walk(index, parent):
        world = parent @ local(nodes[index])
        if "name" in nodes[index]:
            worlds[nodes[index]["name"]] = world
        for child in nodes[index].get("children", []):
            walk(child, world)

    for root in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        walk(root, Matrix.Identity(4))
    return worlds


class Rig:
    """Pose access in the glTF joint frames (the frames the sockets are declared in), in Blender world space."""

    def __init__(self, rig, gltf_worlds):
        self.rig = rig
        self.bones = rig.pose.bones
        self.rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}
        world = rig.matrix_world
        # Constant offset from Blender's bone frame to the glTF joint frame.
        self.offset = {b.name: (world @ b.matrix_local).inverted() @ C4 @ gltf_worlds[b.name] for b in rig.data.bones}
        self.length = {b.name: (gltf_worlds[b.name].inverted() @ gltf_worlds[b.children[0].name]).translation.length
                       for b in rig.data.bones if b.children}

    def capture(self):
        return {pb.name: pb.matrix_basis.copy() for pb in self.bones}

    def apply(self, pose):
        for name, basis in pose.items():
            self.bones[name].matrix_basis = basis
        bpy.context.view_layer.update()

    def joint(self, name):
        return self.rig.matrix_world @ self.bones[name].matrix @ self.offset[name]

    def set_joint(self, name, world):
        self.bones[name].matrix = self.rig.matrix_world.inverted() @ world @ self.offset[name].inverted()
        bpy.context.view_layer.update()

    def head(self, name):
        return self.joint(name).translation.copy()

    def turn(self, name, axis, degrees, pivot=None):
        """Rotate a joint (and its children) about a world axis through its head or ``pivot``."""
        world = self.joint(name)
        centre = world.translation.copy() if pivot is None else pivot
        rotation = Matrix.Translation(centre) @ Matrix.Rotation(math.radians(degrees), 4, axis) @ Matrix.Translation(-centre)
        self.set_joint(name, rotation @ world)


def sample(rig, action, seconds):
    data = rig.rig.animation_data
    data.action = action
    if hasattr(data, "action_slot") and action.slots:
        data.action_slot = action.slots[0]
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    frame = action.frame_range[0] + seconds * fps
    bpy.context.scene.frame_set(int(math.floor(frame)), subframe=frame - math.floor(frame))
    bpy.context.view_layer.update()
    return rig.capture()


def frame_from(x, y, z, origin):
    m = Matrix((x.normalized(), y.normalized(), z.normalized())).transposed().to_4x4()
    m.translation = origin
    return m


def solve_arm(rig, side, hand_world, pole):
    """Place upperarm and lowerarm so the hand joint lands on ``hand_world`` (clamped to reach), elbow toward ``pole``.

    The elbow hinges about the joint's local X axis, bending toward local +Z. The hand takes ``hand_world``'s rotation;
    half of its twist about the forearm moves into the forearm so the wrist does not wrap.
    """
    upper, lower, hand = f"upperarm_{side}", f"lowerarm_{side}", f"hand_{side}"
    shoulder = rig.head(upper)
    l1, l2 = rig.length[upper], rig.length[lower]
    reach = hand_world.translation - shoulder
    d = min(reach.length, (l1 + l2) * .999)
    u = reach.normalized()
    a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    side_dir = (pole - u * pole.dot(u))
    side_dir = side_dir.normalized() if side_dir.length > 1e-6 else Vector((0, 0, -1))
    elbow = shoulder + u * a + side_dir * h
    wrist = shoulder + u * d
    y1 = (elbow - shoulder).normalized()
    y2 = (wrist - elbow).normalized()
    bend = (y2 - y1 * y2.dot(y1))
    bend = bend.normalized() if bend.length > 1e-6 else -side_dir
    x = y1.cross(bend).normalized()
    rig.set_joint(upper, frame_from(x, y1, x.cross(y1), shoulder))
    rig.set_joint(lower, frame_from(x, y2, x.cross(y2), elbow))
    target = hand_world.copy()
    target.translation = wrist
    # Share the wrist twist with the forearm.
    forearm = rig.joint(lower)
    relative = forearm.to_3x3().inverted() @ target.to_3x3()
    hand_y = relative @ Vector((0, 1, 0))
    swing = Vector((0, 1, 0)).rotation_difference(hand_y)
    twist = swing.inverted() @ relative.to_quaternion()
    axis, angle = twist.to_axis_angle()
    angle = angle if axis.y >= 0 else -angle
    angle = (angle + math.pi) % (2 * math.pi) - math.pi
    rig.set_joint(lower, forearm @ Matrix.Rotation(angle / 2, 4, "Y"))
    rig.set_joint(hand, target)
    return (hand_world.translation - wrist).length


def place_feet(rig, base_ankles, base_pelvis, yaw):
    """Spread and turn the feet with the pelvis yaw; knees solve toward the turned forward."""
    turn = Matrix.Rotation(math.radians(yaw), 3, "Z")
    forward = turn @ Vector((0, -1, 0))
    for side, (thigh, calf, foot, ball) in LEGS.items():
        offset = base_ankles[side] - base_pelvis
        offset.x *= STANCE["footSpread"]
        target = base_pelvis + turn @ Vector((offset.x, offset.y, 0))
        target.z = base_ankles[side].z
        hip = rig.head(thigh)
        l1, l2 = rig.length[thigh], rig.length[calf]
        reach = target - hip
        d = min(reach.length, (l1 + l2) * .999)
        u = reach.normalized()
        a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
        h = math.sqrt(max(l1 * l1 - a * a, 0.0))
        knee = hip + u * a + (forward - u * forward.dot(u)).normalized() * h
        ankle = hip + u * d
        for name, start, end in ((thigh, hip, knee), (calf, knee, ankle)):
            world = rig.joint(name)
            y = world.to_3x3() @ Vector((0, 1, 0))
            swing = y.rotation_difference((end - start).normalized()).to_matrix().to_4x4()
            m = swing @ world.to_3x3().to_4x4()
            m.translation = start
            rig.set_joint(name, m)
        # Feet keep their rest orientation, turned with the stance.
        rest_foot = rig.rig.matrix_world @ rig.rest[foot] @ rig.offset[foot]
        m = Matrix.Rotation(math.radians(yaw), 4, "Z") @ rest_foot.to_3x3().to_4x4()
        m.translation = ankle
        rig.set_joint(foot, m)
        rig.bones[ball].matrix_basis = Matrix.Identity(4)
        bpy.context.view_layer.update()


class Archer:
    def __init__(self, rig, arguments):
        self.rig = rig
        self.args = arguments
        self.sockets = {name: socket_matrix(value) for name, value in arguments["sockets"].items()}
        self.joints = {name: value["joint"] for name, value in arguments["sockets"].items()}
        self.base_action = bpy.data.actions.get(BASE)
        if self.base_action is None:
            raise ValueError(f"the target GLB has no {BASE} clip")
        self.base_duration = (self.base_action.frame_range[1] - self.base_action.frame_range[0]) / FPS_IMPORT()
        # The palm faces down (-Z) in the rest T-pose; keep that direction in each hand's joint frame.
        self.palm = {side: (rig.rig.matrix_world @ rig.rest[f"hand_{side}"] @ rig.offset[f"hand_{side}"]).to_3x3().inverted()
                     @ Vector((0, 0, -1)) for side in "lr"}
        self.arrow_roll = None

    def stance(self, seconds, loop, twist):
        rig = self.rig
        base = sample(rig, self.base_action, (seconds % self.base_duration) if loop else 0.0)
        rig.apply(base)
        ankles = {side: rig.head(LEGS[side][2]) for side in LEGS}
        pelvis = rig.head("pelvis")
        up = Vector((0, 0, 1))
        rig.turn("pelvis", up, STANCE["pelvisYaw"])
        m = rig.joint("pelvis")
        m.translation.z -= STANCE["pelvisDrop"]
        rig.set_joint("pelvis", m)
        spine = STANCE["spineSet"] + (STANCE["spineFull"] - STANCE["spineSet"]) * twist
        for name in ("spine_01", "spine_02", "spine_03"):
            rig.turn(name, up, spine)
        total = STANCE["pelvisYaw"] + 3 * spine
        rig.turn("neck_01", up, -total * (1 - STANCE["headShare"]))
        rig.turn("Head", up, -total * STANCE["headShare"])
        rig.turn("Head", Vector((1, 0, 0)), -STANCE["headPitch"])
        place_feet(rig, ankles, pelvis, STANCE["pelvisYaw"])

    def aim_frames(self, bow_drop=0.0):
        """The bow frame (origin at the grip) and the full-draw nock point, for the current stance."""
        rig = self.rig
        head = rig.joint("Head")
        anchor = head.translation + ANCHOR
        aim = Vector((0, -1, 0))
        cant = math.radians(STANCE["bowCant"])
        bow_y = Vector((-math.sin(cant), 0, math.cos(cant)))
        # The grip lies along the aim line ahead of the anchor, as far as the left arm reaches (nearly straight).
        reach = (rig.length["upperarm_l"] + rig.length["lowerarm_l"]) * .985
        shoulder = rig.head("upperarm_l")
        grip_to_hand = self.sockets["bow"].inverted()
        length = self.args["arrowLength"] - .06
        for _ in range(40):
            grip = anchor + aim * length
            bow = frame_from(bow_y.cross(aim), bow_y, aim, grip)
            if bow_drop:
                bow = Matrix.Translation(grip) @ Matrix.Rotation(math.radians(bow_drop), 4, bow.col[0].xyz) @ Matrix.Translation(-grip) @ bow
            hand = bow @ grip_to_hand
            if (hand.translation - shoulder).length <= reach:
                break
            length -= .01
        return bow, anchor, length

    def string_hand(self, bow, nock, roll):
        aim = bow.col[2].xyz.normalized()
        up = Matrix.Rotation(math.radians(roll), 3, aim) @ Vector((0, 0, 1))
        arrow = frame_from(up.cross(aim), up, aim, nock)
        return arrow @ self.sockets["arrow"].inverted()

    def calibrate(self):
        """The arrow roll (at full draw) and the set draw (the least the string arm reaches at the aim pose)."""
        self.stance(0.0, False, 1.0)
        bow, _, full = self.aim_frames()
        solve_arm(self.rig, "l", bow @ self.sockets["bow"].inverted(), Vector((.2, .3, -1)))
        self.arrow_roll = self.best_roll(bow, bow.translation - bow.col[2].xyz.normalized() * full)
        self.stance(0.0, False, 0.0)
        bow, _, full = self.aim_frames()
        solve_arm(self.rig, "l", bow @ self.sockets["bow"].inverted(), Vector((.2, .3, -1)))
        self.set_fraction = self.set_draw(bow, full)

    def pose(self, seconds, loop, draw, *, twist=None, release=0.0, quiver=0.0, bow_drop=0.0, hook=1.0):
        """``draw`` is 0 at the set (aim) pose and 1 at full draw, and the chest turns with it unless ``twist`` is
        given; ``release`` moves the open hand back past the anchor; ``quiver`` (0..1) takes the string hand to the
        back quiver."""
        rig = self.rig
        if self.arrow_roll is None:
            self.calibrate()
        self.stance(seconds, loop, draw if twist is None else twist)
        bow, anchor, full = self.aim_frames(bow_drop)
        brace = self.args["braceHeight"]
        aim = bow.col[2].xyz.normalized()
        solve_arm(rig, "l", bow @ self.sockets["bow"].inverted(), Vector((.2, .3, -1)))
        span = (full - brace)
        pulled = brace + span * (self.set_fraction + (1 - self.set_fraction) * draw)
        nock = bow.translation - aim * pulled
        nock += -aim * .12 * release + Vector((-.05, 0, .01)) * release
        hand = self.string_hand(bow, nock, self.arrow_roll)
        if quiver > 0:
            reach_target = self.quiver_point()
            target = hand.copy()
            target.translation = hand.translation.lerp(reach_target, quiver)
            hand = target
        solve_arm(rig, "r", hand, Vector((-.6, .5, .45)))
        self.curl("l", GRIPS["fist"], 1.0)
        self.curl("r", GRIPS["hook"], hook, GRIPS["open"])
        # The arrow socket's distance behind the braced string, along the bow's draw axis (clamped at the string).
        arrow_socket = rig.joint(self.joints["arrow"]) @ self.sockets["arrow"]
        behind = (bow.inverted() @ arrow_socket.translation).z
        return rig.capture(), max(0.0, -behind - brace) if quiver == 0 and release == 0 else 0.0

    def curl(self, side, grip, weight=1.0, other=None):
        """Curl each finger toward the palm, joint by joint from the knuckle; ``weight`` blends from ``other``."""
        rig = self.rig
        for finger, angles in grip.items():
            for k, angle in enumerate(angles, start=1):
                if other is not None:
                    angle = other[finger][k - 1] + (angle - other[finger][k - 1]) * weight
                name = f"{finger}_{k:02d}_{side}"
                palm = rig.joint(f"hand_{side}").to_3x3() @ self.palm[side]
                joint = rig.joint(name)
                direction = joint.to_3x3() @ Vector((0, 1, 0))
                axis = direction.cross(palm)
                if axis.length < 1e-6:
                    continue
                rig.turn(name, axis.normalized(), angle)

    def set_draw(self, bow, full):
        """The smallest draw (fraction of full) the string arm reaches at the aim pose."""
        rig = self.rig
        shoulder = rig.head("upperarm_r")
        reach = (rig.length["upperarm_r"] + rig.length["lowerarm_r"]) * .97
        brace = self.args["braceHeight"]
        aim = bow.col[2].xyz.normalized()
        for k in range(0, 101):
            f = .25 + .0075 * k
            nock = bow.translation - aim * (brace + (full - brace) * f)
            hand = self.string_hand(bow, nock, self.arrow_roll)
            if (hand.translation - shoulder).length <= reach:
                return f
        return 1.0

    def best_roll(self, bow, nock):
        """The arrow roll (about the shaft) whose hand needs the least wrist bend against the solved forearm."""
        rig = self.rig
        best, best_bend = 0.0, None
        for roll in range(-180, 180, 10):
            hand = self.string_hand(bow, nock, roll)
            solve_arm(rig, "r", hand, Vector((-.6, .5, .45)))
            forearm = rig.joint("lowerarm_r").to_quaternion()
            bend = forearm.rotation_difference(hand.to_quaternion()).angle
            if best_bend is None or bend < best_bend:
                best, best_bend = float(roll), bend
        return best

    def quiver_point(self):
        quiver = self.rig.joint(self.joints["quiver"]) @ self.sockets["quiver"]
        # The quiver's opening is at +Y; the hand takes an arrow just above it.
        return quiver @ Vector((0, self.args["quiverLength"] / 2 + .06, 0))


def FPS_IMPORT():
    return bpy.context.scene.render.fps / bpy.context.scene.render.fps_base


def author(archer, clip):
    """The poses and string draw (metres) of ``clip``, one per frame at FPS, the last frame closing a loop."""
    base = archer.base_duration
    if clip in ("Bow_Aim_Loop", "Bow_Hold_Loop"):
        frames = int(round(base * FPS))
        draw = 0.0 if clip == "Bow_Aim_Loop" else 1.0
        keys = [archer.pose(k / FPS, True, draw) for k in range(frames + 1)]
        return keys, {"loopSeconds": round(base, 4)}
    duration = DURATIONS[clip]
    frames = int(round(duration * FPS))
    keys = []
    marks = {}
    for k in range(frames + 1):
        t = k / FPS
        u = t / duration
        if clip == "Bow_Draw":
            keys.append(archer.pose(t, False, smooth(u)))
        elif clip == "Bow_Cancel":
            keys.append(archer.pose(t, False, 1 - smooth(u)))
        elif clip == "Bow_Release":
            # Released at the second frame: the hand flies back fast, then settles; the bow arm drops a little.
            fly = 0.0 if k == 0 else min(1.0, t / .12)
            settle = smooth((t - .12) / (duration - .12))
            keys.append(archer.pose(t, False, 1.0, release=math.sin(fly * math.pi / 2) * (1 - .3 * settle),
                                    bow_drop=4.0 * math.sin(min(1.0, t / .2) * math.pi / 2), hook=1.0 if k == 0 else .25))
            marks["releaseSeconds"] = round(1 / FPS, 4)
        elif clip == "Bow_Recovery":
            # From the follow-through to the quiver (0.45 s), then back to the set string.
            reach = smooth(u / .4) if u < .4 else 1 - smooth((u - .55) / .45) if u > .55 else 1.0
            back = 1 - smooth(u / .3)
            keys.append(archer.pose(t, False, 0.0 if u > .55 else 1.0, twist=1 - smooth((u - .2) / .7), release=.7 * back * (1 - reach), quiver=reach,
                                    bow_drop=4.0 * (1 - smooth(u / .5)) + 6.0 * math.sin(math.pi * u), hook=.25 + .75 * smooth((u - .5) / .4)))
            marks["arrowDrawnSeconds"] = round(.45 * duration, 4)
            marks["nockedSeconds"] = round(duration, 4)
    return keys, marks


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
    rig = Rig(rigs[0], gltf_rest_worlds(inputs["target"]))
    archer = Archer(rig, arguments)
    keys, marks = author(archer, clip)
    poses = [pose for pose, _ in keys]
    draws = [round(draw, 4) for _, draw in keys]

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
    return {"recipe": "bow-clip-v1", "clip": clip, "fps": FPS, "frames": len(poses), "arrowRoll": archer.arrow_roll,
            "drawMeters": draws, **marks}
