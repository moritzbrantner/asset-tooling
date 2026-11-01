"""Original crossbow clips authored on the Ranger rig in Blender (#419, the Redbrand Crossbowman's Crossbow Bolt).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit crossbow frames solved with two-bone arm IK on top
of the first ``Idle_Loop`` pose (no source motion is copied; Mixamo was only watched as reference):

- The crossbow rides the right hand through ``hand_r.crossbow`` (``arguments["sockets"]["crossbow"]``) for the whole
  of every clip but the reload's bolt window. Its frame follows ``ARCHERY_GRIP_CONTRACT.crossbow``: the stock along
  +Z (the bolt's flight), the groove on top (+Y), the origin at the stock's wrist.
- The left hand holds the fore-stock ``FORE`` ahead of the wrist from below: its ``hand_l.crossbow`` grip frame is the
  crossbow frame moved along the stock and turned over (180 degrees about the stock), so ``Grip_Crossbow_L`` closes
  the fist round it. On the reload it works the crank (``hand_l.weapon``, ``Grip_Crank_L``) and holds the crossbow
  alone while the right hand fetches a bolt from ``back.quiver`` on ``hand_r.arrow``.
- Every clip keeps only the ``spine_01`` subtree (the observations list the joints), so a consumer plays it over
  standing, walking or running legs. The chest turn is spread over ``spine_01``-``03``.

``Crossbow_Idle_Loop`` carries the crossbow low across the body over the whole ``Idle_Loop`` (resampled to 2 s).
``Crossbow_Aim_Loop`` sets the butt in the right shoulder with the groove under the right eye. ``Crossbow_Fire``
starts and ends in the aim pose and looses at ``releaseSeconds``. ``Crossbow_Reload`` starts and ends in the aim pose:
it lowers the crossbow muzzle down, winds the crank twice (spanned at ``spannedSeconds``), brings it level at the
waist, where the left hand holds it alone over ``leftHandSeconds`` while the right hand draws a bolt from the quiver
(``boltDrawnSeconds``) and lays it in the groove (``reloadedSeconds``), then raises it to the shoulder.

No randomness.
"""
import json
import math
import struct

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 30
UPPER_ROOT = "spine_01"
STAND = "Idle_Loop"
ARMS = {"l": ("upperarm_l", "lowerarm_l", "hand_l"), "r": ("upperarm_r", "lowerarm_r", "hand_r")}
SPINE = (("spine_01", .3), ("spine_02", .35), ("spine_03", .35))
X, Y, UP = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
POLE = {"r": Vector((-.7, .3, -.7)), "l": Vector((.5, .2, -1))}
CLIPS = ("Crossbow_Idle_Loop", "Crossbow_Aim_Loop", "Crossbow_Fire", "Crossbow_Reload")
SOCKETS = ("crossbow", "fore", "crank", "bolt", "quiver")

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up; metres. A crossbow pose names the wrist
# grip position (``g``), the stock's forward direction (``f``) and its top (``u``); the chest yaw (negative turns the
# right shoulder back) and pitch (positive bends forward).
# The fore-stock grip: along the stock ahead of the wrist and just under it.
FORE = {"along": .2, "below": .028}
# The low carry: the wrist before the right hip, the stock pointing forward, a little up and across to the left.
CARRY = {"g": (-.1, -.14, 1.08), "f": (.5, -1, .35), "u": (0, .3, 1), "yaw": 6.0, "pitch": 4.0}
IDLE = {"duration": 2.0, "sway": 2.0}
# The aim: the butt (``BUTT`` behind the wrist) in the right shoulder's pocket, the groove ``SIGHT`` under the right
# eye (``EYE`` from the Head joint), the head leaning onto the stock. The chest turns the right shoulder back.
AIM = {"yaw": -15.0, "pitch": 2.0, "headRoll": 9.0, "headPitch": 7.0}
EYE = Vector((-.035, -.085, .075))
SIGHT = .11
# The shoulder pocket the butt sits in, from the right clavicle joint: just in front of the collarbone.
POCKET = Vector((0, -.05, 0))
BUTT = .36
# The shot: the bolt looses on frame 2; the muzzle kicks up and the butt pushes back, then settles.
FIRE = {"duration": .4, "releaseFrame": 2, "kick": 7.0, "push": .035, "peak": .1}
# The reload, in fractions of its 1.6 s; the crossbow poses are relative to the stance at that moment.
RELOAD = {
    "duration": 1.6,
    "span": {"g": (-.08, -.36, 1.0), "f": (.1, -.75, -.65), "u": (0, .65, -.75), "yaw": -6.0, "pitch": 14.0},
    "load": {"g": (-.08, -.3, 1.1), "f": (.28, -1, .02), "u": (0, 0, 1), "yaw": 4.0, "pitch": 10.0},
    "lower": (0, .16), "toCrank": (.15, .2), "crank": (.2, .53), "fromCrank": (.53, .59), "level": (.53, .6),
    "free": (.6, .9), "quiver": (.6, .72), "groove": (.72, .84), "back": (.84, .9), "raise": (.9, 1.0),
    "turns": 2, "crankRadius": .065,
    # The crank's axle sits on the left (+X) of the stock behind the wrist; the handle stands out of it along +X.
    "axle": (.06, .0, -.17), "handle": .05,
}
# The bolt in the groove: its nock just ahead of the nut, its shaft along the stock.
GROOVE = (0, .03, .04)


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets", "quiverLength"}:
        raise ValueError("crossbow clips require exactly schemaVersion, clips, sockets and quiverLength")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"crossbow clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"crossbow clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    if set(inputs) != {"target"}:
        raise ValueError("crossbow clips take exactly the declared input target")


def gltf_rest_worlds(path):
    """World matrices (glTF axes) of every named node of the declared target, at rest."""
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


def window(u, span):
    return smooth((u - span[0]) / (span[1] - span[0]))


class Rig:
    def __init__(self, rig, sockets, rest_gltf):
        self.rig = rig
        self.bones = rig.pose.bones
        self.rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}
        # The socket frame in its joint's bone frame: the frame in armature space is the bone matrix times this.
        self.socket = {}
        for name, s in sockets.items():
            joint, r = s["joint"], s["rotation"]
            local = Matrix.LocRotScale(Vector(s["translation"]), Quaternion((r[3], r[0], r[1], r[2])), Vector((1, 1, 1)))
            self.socket[name] = (joint, self.rest[joint].inverted() @ C4 @ rest_gltf[joint] @ local)

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

    def grip(self, name):
        joint, local = self.socket[name]
        return self.bones[joint].matrix @ local

    def hand_for(self, socket, frame):
        """The hand bone matrix that puts ``socket``'s grip frame on ``frame``."""
        return frame @ self.socket[socket][1].inverted()


def sample(rig, action, seconds):
    data = rig.rig.animation_data
    data.action = action
    if hasattr(data, "action_slot") and action.slots:
        data.action_slot = action.slots[0]
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    frame = action.frame_range[0] + seconds * fps
    bpy.context.scene.frame_set(int(math.floor(frame)), subframe=frame - math.floor(frame))
    bpy.context.view_layer.update()
    pose = rig.capture()
    data.action = None
    return pose


def duration_of(action):
    return (action.frame_range[1] - action.frame_range[0]) / (bpy.context.scene.render.fps / bpy.context.scene.render.fps_base)


def rotate_world(rig, name, axis, degrees, pivot=None):
    pb = rig.bones[name]
    head = pb.matrix.translation.copy() if pivot is None else pivot
    pb.matrix = Matrix.Translation(head) @ Matrix.Rotation(math.radians(degrees), 4, axis) @ Matrix.Translation(-head) @ pb.matrix
    bpy.context.view_layer.update()


def aim(rig, name, direction):
    pb = rig.bones[name]
    current = (pb.matrix.to_3x3() @ Vector((0, 1, 0))).normalized()
    turn = current.rotation_difference(direction.normalized()).to_matrix()
    m = (turn @ pb.matrix.to_3x3()).to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


def two_bone(rig, a, b, c, target, pole):
    root = rig.head(a)
    l1, l2 = rig.length(a, b), rig.length(b, c)
    reach = target - root
    d = max(min(reach.length, (l1 + l2) * .999), abs(l1 - l2) + 1e-3)
    u = reach.normalized()
    x = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    h = math.sqrt(max(l1 * l1 - x * x, 0.0))
    side = pole - u * pole.dot(u)
    side = side.normalized() if side.length > 1e-6 else Vector((0, 0, -1))
    middle = root + u * x + side * h
    aim(rig, a, middle - root)
    aim(rig, b, (root + u * d) - middle)


def place_hand(rig, side, want, pole):
    """Solve the arm so the hand bone takes ``want`` (armature space); half the hand's twist goes to the forearm."""
    upper, lower, hand = ARMS[side]
    two_bone(rig, upper, lower, hand, want.translation, pole)
    rotation = want.to_3x3()
    fore = rig.bones[lower]
    axis = (fore.matrix.to_3x3() @ Vector((0, 1, 0))).normalized()
    relative = (rotation @ fore.matrix.to_3x3().inverted()).to_quaternion()
    projected = Vector((relative.x, relative.y, relative.z)).project(axis)
    if projected.length > 1e-9:
        twist = Quaternion((relative.w, *projected)).normalized()
        m = (Quaternion().slerp(twist, .5).to_matrix() @ fore.matrix.to_3x3()).to_4x4()
        m.translation = fore.head.copy()
        fore.matrix = m
        bpy.context.view_layer.update()
    m = rotation.to_4x4()
    m.translation = rig.bones[hand].head.copy()
    rig.bones[hand].matrix = m
    bpy.context.view_layer.update()


def blend(a, b, w):
    """A frame between ``a`` and ``b``: positions lerped, rotations slerped."""
    if w <= 0:
        return a.copy()
    if w >= 1:
        return b.copy()
    m = a.to_quaternion().slerp(b.to_quaternion(), w).to_matrix().to_4x4()
    m.translation = a.translation.lerp(b.translation, w)
    return m


def crossbow_frame(g, f, u):
    """The crossbow's grip frame at ``g``: +Z along ``f``, +Y as close to ``u`` as it can be."""
    zz = Vector(f).normalized()
    yy = Vector(u) - zz * Vector(u).dot(zz)
    yy.normalize()
    m = Matrix((yy.cross(zz), yy, zz)).transposed().to_4x4()
    m.translation = Vector(g)
    return m


def turn_chest(rig, yaw=0.0, pitch=0.0, gaze=.5):
    """Spread a chest turn over spine_01-03; the neck and head take back ``gaze`` of the yaw and half the pitch."""
    for joint, share in SPINE:
        if yaw:
            rotate_world(rig, joint, UP, yaw * share)
        if pitch:
            rotate_world(rig, joint, X, pitch * share)
    if yaw:
        rotate_world(rig, "neck_01", UP, -yaw * gaze)
    if pitch:
        rotate_world(rig, "neck_01", X, -pitch * .5)


def fore_frame(crossbow):
    """The left hand's ``hand_l.crossbow`` grip frame on the fore-stock, ahead of the wrist and just under it."""
    return crossbow @ Matrix.Translation((0, -FORE["below"], FORE["along"]))


class Stance:
    """The chest turn (yaw, pitch) and head lean of a moment, applied over the seed pose."""

    def __init__(self, yaw=0.0, pitch=0.0, head_roll=0.0, head_pitch=0.0):
        self.yaw, self.pitch, self.head_roll, self.head_pitch = yaw, pitch, head_roll, head_pitch

    def mix(self, other, w):
        return Stance(*(a + (b - a) * w for a, b in zip(self.values(), other.values())))

    def values(self):
        return (self.yaw, self.pitch, self.head_roll, self.head_pitch)

    def apply(self, rig, seed):
        rig.apply(seed)
        turn_chest(rig, self.yaw, self.pitch, gaze=.9)
        if self.head_roll:
            rotate_world(rig, "Head", Y, self.head_roll)
        if self.head_pitch:
            rotate_world(rig, "Head", X, self.head_pitch)


def carry_stance():
    return Stance(CARRY["yaw"], CARRY["pitch"])


def aim_stance():
    return Stance(AIM["yaw"], AIM["pitch"], AIM["headRoll"], AIM["headPitch"])


def aim_crossbow(rig):
    """The aim frame for the current (aim) stance: the groove under the right eye, the butt in the shoulder, level."""
    eye = rig.head("Head") + EYE
    pocket = rig.head("clavicle_r") + POCKET
    forward = Vector((0, -1, 0))
    grip = Vector((eye.x, pocket.y, eye.z - SIGHT)) + forward * BUTT
    return crossbow_frame(grip, forward, UP)


def pose_crossbow(rig, seed, stance, crossbow, left=None, right=None):
    """Pose the stance, the right hand on the crossbow (or on ``right``, a hand matrix) and the left on the fore-stock
    (or ``left``)."""
    stance.apply(rig, seed)
    place_hand(rig, "r", right if right is not None else rig.hand_for("crossbow", crossbow), POLE["r"])
    place_hand(rig, "l", left if left is not None else rig.hand_for("fore", fore_frame(crossbow)), POLE["l"])
    return rig.capture()


def carry_frame(seed_offset=Vector()):
    return crossbow_frame(Vector(CARRY["g"]) + seed_offset, CARRY["f"], CARRY["u"])


def idle_loop(rig, stand_action):
    """The low carry over the whole ``Idle_Loop`` resampled to the clip: the crossbow rides the breathing chest."""
    source = duration_of(stand_action)
    frames = int(round(IDLE["duration"] * FPS))
    rig.apply(sample(rig, stand_action, 0.0))
    chest0 = rig.head("spine_03")
    poses = []
    for k in range(frames + 1):
        phase = 2 * math.pi * (k % frames) / frames
        seed = sample(rig, stand_action, (k % frames) / frames * source)
        rig.apply(seed)
        breathe = rig.head("spine_03") - chest0
        stance = Stance(CARRY["yaw"] + IDLE["sway"] * math.sin(phase), CARRY["pitch"])
        poses.append(pose_crossbow(rig, seed, stance, carry_frame(breathe)))
    return poses, {"seedSeconds": round(source, 4)}


def aim_loop(rig, stand_action):
    """The aim held over the whole ``Idle_Loop`` resampled to 2 s: the breathing moves the chest and head, the
    crossbow follows the eye."""
    source = duration_of(stand_action)
    frames = int(round(IDLE["duration"] * FPS))
    poses = []
    for k in range(frames + 1):
        seed = sample(rig, stand_action, (k % frames) / frames * source)
        aim_stance().apply(rig, seed)
        poses.append(pose_crossbow(rig, seed, aim_stance(), aim_crossbow(rig)))
    return poses, {"seedSeconds": round(source, 4)}


def fire(rig, seed):
    """From the aim pose: loose at the release frame, the muzzle kicks up about the butt and the stock pushes back."""
    frames = int(round(FIRE["duration"] * FPS))
    poses = []
    for k in range(frames + 1):
        t = k / FPS
        aim_stance().apply(rig, seed)
        frame = aim_crossbow(rig)
        r = FIRE["releaseFrame"] / FPS
        if t > r:
            s = t - r
            rise = math.sin(min(1.0, s / (FIRE["peak"] - r)) * math.pi / 2) if s < FIRE["peak"] - r else 1 - smooth((s - (FIRE["peak"] - r)) / (FIRE["duration"] - FIRE["peak"]))
            butt = frame @ Vector((0, 0, -BUTT))
            kick = Matrix.Translation(butt) @ Matrix.Rotation(math.radians(-FIRE["kick"] * rise), 4, frame.col[0].xyz) @ Matrix.Translation(-butt)
            frame = Matrix.Translation(frame.col[2].xyz * -FIRE["push"] * rise) @ kick @ frame
            stance = Stance(AIM["yaw"] - 3 * rise, AIM["pitch"] - 3 * rise, AIM["headRoll"], AIM["headPitch"] - 2 * rise)
        else:
            stance = aim_stance()
        poses.append(pose_crossbow(rig, seed, stance, frame))
    return poses, {"releaseSeconds": round(FIRE["releaseFrame"] / FPS, 4)}


def crank_frame(crossbow, phase):
    """The crank handle's grip frame (``hand_l.weapon``): on a circle about the axle (the stock's X), standing out to +X."""
    spec = RELOAD
    axle = crossbow @ Vector(spec["axle"])
    xs, ys, zs = (crossbow.col[i].xyz.normalized() for i in range(3))
    arm = ys * math.cos(phase) + zs * math.sin(phase)
    position = axle + arm * spec["crankRadius"] + xs * spec["handle"] * .5
    # The handle (the item's +Y) along the axle; the item's +X toward the axle's centre.
    yy = xs
    xx = -arm
    m = Matrix((xx, yy, xx.cross(yy))).transposed().to_4x4()
    m.translation = position
    return m


def bolt_frames(rig, crossbow):
    """The bolt (``hand_r.arrow``: nock at the origin, shaft along +Z) drawn from the quiver and laid in the groove."""
    quiver = rig.grip("quiver")
    opening = quiver @ Vector((0, rig.quiver_length / 2 + .08, 0))
    down = -(quiver.to_3x3() @ Y).normalized()
    drawn = crossbow_frame(opening, down, Vector((1, 0, 0)).cross(down) if abs(down.x) < .9 else Y)
    laid = crossbow @ Matrix.Translation(GROOVE)
    return drawn, laid


def reload(rig, seed):
    spec = RELOAD
    duration = spec["duration"]
    frames = int(round(duration * FPS))
    poses = []
    span_stance = Stance(spec["span"]["yaw"], spec["span"]["pitch"])
    load_stance = Stance(spec["load"]["yaw"], spec["load"]["pitch"])
    for k in range(frames + 1):
        u = k / frames
        # The stance and the crossbow frame: aim -> span (lower) -> load (level) -> aim (raise).
        w_lower, w_level, w_raise = window(u, spec["lower"]), window(u, spec["level"]), window(u, spec["raise"])
        stance = aim_stance().mix(span_stance, w_lower).mix(load_stance, w_level).mix(aim_stance(), w_raise)
        aim_stance().apply(rig, seed)
        aimed = aim_crossbow(rig)
        stance.apply(rig, seed)
        span = crossbow_frame(spec["span"]["g"], spec["span"]["f"], spec["span"]["u"])
        load = crossbow_frame(spec["load"]["g"], spec["load"]["f"], spec["load"]["u"])
        frame = blend(blend(blend(aimed, span, w_lower), load, w_level), aimed, w_raise)
        # The left hand: fore-stock -> crank (two turns) -> fore-stock.
        on_crank = window(u, spec["toCrank"]) * (1 - window(u, spec["fromCrank"]))
        phase = 2 * math.pi * spec["turns"] * window(u, spec["crank"])
        fore = rig.hand_for("fore", fore_frame(frame))
        left = blend(fore, rig.hand_for("crank", crank_frame(frame, phase)), on_crank)
        # The right hand: on the wrist, except in the free window: to the quiver, the bolt to the groove, back.
        right = None
        free = spec["free"]
        if free[0] < u < free[1]:
            drawn, laid = bolt_frames(rig, frame)
            wrist = rig.hand_for("crossbow", frame)
            to_quiver, to_groove, back = window(u, spec["quiver"]), window(u, spec["groove"]), window(u, spec["back"])
            bolt = blend(drawn, laid, to_groove)
            right = blend(blend(wrist, rig.hand_for("bolt", bolt), to_quiver), wrist, back)
        poses.append(pose_crossbow(rig, seed, stance, frame, left=left, right=right))
    d = duration
    return poses, {
        "spannedSeconds": round(spec["crank"][1] * d, 4), "leftHandSeconds": [round(spec["free"][0] * d, 4), round(spec["free"][1] * d, 4)],
        "boltDrawnSeconds": round(spec["quiver"][1] * d, 4), "reloadedSeconds": round(spec["groove"][1] * d, 4),
        "crankSeconds": [round(spec["crank"][0] * d, 4), round(spec["crank"][1] * d, 4)], "turns": spec["turns"],
    }


def upper_joints(rig):
    return [UPPER_ROOT, *(bone.name for bone in rig.rig.data.bones[UPPER_ROOT].children_recursive)]


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    stand = sample(rig, actions[STAND], 0.0)
    if clip == "Crossbow_Idle_Loop":
        poses, observations = idle_loop(rig, actions[STAND])
    elif clip == "Crossbow_Aim_Loop":
        poses, observations = aim_loop(rig, actions[STAND])
    elif clip == "Crossbow_Fire":
        poses, observations = fire(rig, stand)
    else:
        poses, observations = reload(rig, stand)
    return poses, {"source": STAND, "durationSeconds": round((len(poses) - 1) / FPS, 4), **observations,
                   "layer": UPPER_ROOT, "joints": upper_joints(rig)}


def imported_state(rig_object):
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


def author_all(rig_object, arguments, target_path):
    """Author every requested clip on ``rig_object`` (each from the imported state); {clip: (poses, observations)}."""
    found = bpy.data.actions.get(STAND)
    if found is None:
        raise ValueError(f"the target GLB has no {STAND} clip")
    actions = {STAND: found}
    rest_gltf = gltf_rest_worlds(target_path)
    fresh = imported_state(rig_object)
    authored = {}
    for clip in arguments["clips"]:
        restore_state(rig_object, fresh)
        rig = Rig(rig_object, arguments["sockets"], rest_gltf)
        rig.quiver_length = arguments["quiverLength"]
        authored[clip] = author(rig, clip, actions)
    restore_state(rig_object, fresh)
    return authored


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
    authored = author_all(rigs[0], arguments, inputs["target"])
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
    return {"recipe": "crossbow-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
