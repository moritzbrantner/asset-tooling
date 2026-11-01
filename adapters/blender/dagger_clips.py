"""Original dagger, throw, flourish and bandage clips authored on the Ranger rig in Blender (#418, the mmorpg Rogue).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit grip frames solved with two-bone arm IK on top of
the first ``Idle_Loop`` pose (no source motion is copied; Mixamo was only watched as reference):

- The Rogue fights with two daggers: the main one on ``hand_r.weapon`` and the off-hand one on ``hand_l.weapon``
  (``arguments["sockets"]`` ``weapon`` and ``offhand``). Knives, flasks and bombs are drawn from ``belt.throwable``
  (``belt``). A key names a hand's grip position (``g``), the blade's direction (``b``, the item's +Y) and the edge
  (``e``, the item's +X); between keys they follow a Catmull-Rom curve that starts and ends in the ready pose. A cut
  turns its edge along the hand's motion.
- Every clip keeps only the ``spine_01`` subtree (the observations list the joints), so a consumer plays it over
  standing, walking or running legs. The chest turn is spread over ``spine_01``-``03``.
- ``Dagger_Idle_Loop`` is the low twin-dagger ready stance over the whole ``Idle_Loop`` (resampled to 2 s). The strikes
  start and end in its first pose. ``Throw_Knife`` and ``Throw_Lob`` reach the belt socket at ``drawSeconds`` and let
  go at ``releaseSeconds``. At the draw the hand's grip origin is the belt socket's origin, so the item stays where it
  hangs when it passes from the belt into the hand and only turns. The belt holds the item upright (#470), which the hand cannot reach at
  belt height, so the hand takes it in its own draw frame: the item's +Y turned ``DRAW_TILT`` from the socket's +Y
  out of the belt (toward its +Z), the fingers down. The cork, fuse or handle points up and out while it is held.

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
HAND = {"r": "weapon", "l": "offhand"}
POLE = {"r": Vector((-.8, .35, -.5)), "l": Vector((.8, .35, -.5))}

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up. Positions are metres in armature space
# (the pelvis stands at about z 0.91, the shoulders at 1.42). A positive yaw turns the chest to the figure's left; a
# positive pitch bends it forward.
# The ready stance: the chest bent forward, the main dagger low before the right hip pointing forward and up, the
# off-hand dagger higher before the left of the chest; both edges down.
READY = {
    "r": {"g": (-.2, -.34, 1.06), "b": (.12, -.85, .5), "e": (0, 0, -1)},
    "l": {"g": (.17, -.32, 1.2), "b": (-.12, -.8, .6), "e": (0, 0, -1)},
    "pitch": 10.0,
}
IDLE = {"duration": 2.0, "sway": 3.0, "bob": .012}
# The strikes: (fraction, key) pairs; a key names a hand's g, b and e (else the ready value) and the chest's yaw,
# pitch (added to the stance's) and roll. ``cut`` names the hands whose edge follows their motion; ``contact`` the key
# where the blade meets the target.
STAB = {"duration": .4, "contact": 1, "keys": [
    (.3, {"r": {"g": (-.24, -.1, 1.14), "b": (.06, -.9, .42), "e": (0, 0, -1)}, "l": {"g": (.12, -.26, 1.26)}, "yaw": -14}),
    (.52, {"r": {"g": (-.1, -.62, 1.24), "b": (.04, -1, .05), "e": (0, 0, -1)}, "l": {"g": (.13, -.24, 1.28)}, "yaw": 20, "pitch": 6}),
    (.7, {"r": {"g": (-.13, -.56, 1.2), "b": (.04, -1, .08), "e": (0, 0, -1)}, "yaw": 16, "pitch": 4}),
]}
SLASH_L = {"duration": .4, "contact": 1, "cut": "l", "keys": [
    (.3, {"l": {"g": (.34, -.12, 1.44), "b": (.45, -.4, .8)}, "r": {"g": (-.22, -.24, 1.1)}, "yaw": 20, "pitch": -2}),
    (.52, {"l": {"g": (.04, -.52, 1.24), "b": (-.7, -.7, .1)}, "yaw": -14, "pitch": 6}),
    (.7, {"l": {"g": (-.18, -.36, 1.04), "b": (-.6, .2, -.75)}, "yaw": -28, "pitch": 10}),
]}
SINISTER = {"duration": .6, "contact": 1, "keys": [
    (.14, {"r": {"g": (-.24, -.1, 1.16), "b": (.06, -.9, .42), "e": (0, 0, -1)}, "yaw": -12}),
    (.32, {"r": {"g": (-.1, -.62, 1.26), "b": (.04, -1, .06), "e": (0, 0, -1)}, "yaw": 22, "pitch": 6}),
    (.47, {"r": {"g": (-.2, -.3, 1.1)}, "l": {"g": (.24, -.08, 1.2), "b": (-.06, -.9, .42), "e": (0, 0, -1)}, "yaw": 10}),
    (.64, {"l": {"g": (.08, -.62, 1.24), "b": (-.04, -1, .06), "e": (0, 0, -1)}, "yaw": -20, "pitch": 6}),
    (.8, {"l": {"g": (.13, -.52, 1.22), "b": (-.04, -1, .1), "e": (0, 0, -1)}, "yaw": -12, "pitch": 4}),
]}
# The coat: the off hand holds up the vial (the off-hand dagger turned up out of the way), the main blade lies across it
# and is drawn back to the right, then winds up and slashes.
POISON = {"duration": .8, "contact": 3, "cut": "r", "keys": [
    (.15, {"l": {"g": (.05, -.33, 1.18), "b": (-.15, -.35, .92), "e": (0, -1, 0)},
           "r": {"g": (-.03, -.37, 1.27), "b": (.95, -.2, .2), "e": (0, 0, -1)}, "pitch": 8}),
    (.33, {"l": {"g": (.05, -.33, 1.18), "b": (-.15, -.35, .92), "e": (0, -1, 0)},
           "r": {"g": (-.2, -.35, 1.26), "b": (.95, -.2, .2), "e": (0, 0, -1)}, "pitch": 8}),
    (.52, {"l": {"g": (.24, -.2, 1.18)}, "r": {"g": (-.3, -.08, 1.38), "b": (-.3, .4, .85)}, "yaw": -12}),
    (.68, {"r": {"g": (-.02, -.56, 1.2), "b": (.7, -.7, .1)}, "yaw": 24, "pitch": 6}),
    (.84, {"r": {"g": (.2, -.34, 1.02), "b": (.55, .2, -.8)}, "yaw": 32, "pitch": 12}),
]}
# The gouge: the main dagger turned so the pommel leads, a jab at face height.
GOUGE = {"duration": .5, "contact": 1, "keys": [
    (.3, {"r": {"g": (-.24, -.12, 1.3), "b": (.08, .45, -.9), "e": (0, -1, -.4)}, "yaw": -16, "pitch": -2}),
    (.5, {"r": {"g": (-.06, -.58, 1.5), "b": (0, .35, -.94), "e": (0, -1, -.4)}, "yaw": 24, "pitch": -6}),
    (.7, {"r": {"g": (-.1, -.5, 1.42), "b": (0, .3, -.95), "e": (0, -1, -.4)}, "yaw": 18, "pitch": -4}),
]}
# The knife throw: down to the belt, a sidearm cock to the right and back, a flat flick forward; the off hand aims.
KNIFE = {"duration": .5, "draw": .18, "release": .56, "keys": [
    (.36, {"r": {"g": (-.46, .02, 1.2), "b": (-.2, .9, .35), "e": (0, 0, -1)}, "l": {"g": (.2, -.5, 1.32), "b": (0, -1, .1)},
           "yaw": -26}),
    (.56, {"r": {"g": (-.18, -.6, 1.26), "b": (0, -1, .02), "e": (0, 0, -1)}, "l": {"g": (.24, -.36, 1.22)}, "yaw": 22, "pitch": 4}),
    (.74, {"r": {"g": (.06, -.48, 1.1), "b": (.45, -.8, -.4), "e": (0, 0, -1)}, "yaw": 30, "pitch": 8}),
]}
# The lob: down to the belt, an underarm swing back past the hip and up, let go before the face; the off hand aims.
# #470: through the backswing the thumb leads, so a flask's cork points forward, never down.
LOB = {"duration": .8, "draw": .2, "release": .62, "keys": [
    (.42, {"r": {"g": (-.3, .24, .94), "b": (0, -.95, .3), "e": (0, -.3, -.95)}, "l": {"g": (.22, -.48, 1.32), "b": (0, -1, .2)},
           "yaw": -20, "pitch": 8}),
    (.62, {"r": {"g": (-.16, -.52, 1.42), "b": (0, -.6, .8), "e": (0, -.8, -.6)}, "l": {"g": (.24, -.4, 1.24)}, "yaw": 12, "pitch": -6}),
    (.8, {"r": {"g": (-.1, -.42, 1.6), "b": (0, -.2, 1), "e": (0, -1, 0)}, "yaw": 10, "pitch": -8}),
]}
# #470: how far (degrees) the hand turns the item at the draw from the belt socket's upright +Y out of the belt. At 45
# the arm reaches the belt with the grip within 2 cm of the socket; nearer upright it falls short (6 cm at 0).
DRAW_TILT = 45.0
# The flourish: both blades come up before the chest, their tips circle twice (in opposite senses), they cross, back.
FLOURISH = {"duration": .7, "spin": (.14, .7), "turns": 2, "cone": 55.0, "circle": .035,
            "r": (-.15, -.42, 1.3), "l": (.15, -.42, 1.3), "cross": .82}
# The bandage: the left forearm raised across the body, the right hand wraps round it three times and tugs the knot.
BANDAGE = {"duration": 1.5, "raise": .12, "wrap": (.2, .78), "turns": 3, "radius": .075, "tug": (.8, .9),
           "hand": (.02, -.38, 1.18), "elbow": (.27, -.2, 1.04), "pitch": 16.0}
CLIPS = ("Dagger_Idle_Loop", "Dagger_Stab_R", "Dagger_Slash_L", "Dagger_Sinister", "Dagger_Poison", "Dagger_Gouge",
         "Flourish_Haste", "Throw_Knife", "Throw_Lob", "Bandage_Self")
STRIKES = {"Dagger_Stab_R": STAB, "Dagger_Slash_L": SLASH_L, "Dagger_Sinister": SINISTER, "Dagger_Poison": POISON,
           "Dagger_Gouge": GOUGE}
SOCKETS = ("weapon", "offhand", "belt")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets"}:
        raise ValueError("dagger clips require exactly schemaVersion, clips and sockets")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"dagger clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"dagger clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    if set(inputs) != {"target"}:
        raise ValueError("dagger clips take exactly the declared input target")


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


def window(u, start, end):
    return smooth((u - start) / (end - start))


def v(t):
    return Vector(t)


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


def sample(rig, action, seconds):
    """The pose of ``action`` at ``seconds`` from its start."""
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


def rotate_world(rig, name, axis, degrees):
    pb = rig.bones[name]
    head = pb.matrix.translation.copy()
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


def item_frame(position, y_axis, x_hint):
    """A grip frame at ``position`` whose +Y is ``y_axis`` and +X as close to ``x_hint`` as it can be."""
    yy = y_axis.normalized()
    xx = x_hint - yy * x_hint.dot(yy)
    if xx.length < 1e-4:
        xx = (Vector((0, 0, 1)) if abs(yy.z) < .9 else Vector((1, 0, 0))).cross(yy)
    xx.normalize()
    m = Matrix((xx, yy, xx.cross(yy))).transposed().to_4x4()
    m.translation = position
    return m


def place_grip(rig, socket, frame, pole):
    """Solve the arm holding ``socket`` so its grip frame lands on ``frame``; half the hand's twist goes to the forearm."""
    joint, local = rig.socket[socket]
    side = joint[-1]
    upper, lower, hand = ARMS[side]
    want = frame @ local.inverted()
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


def turn_chest(rig, yaw=0.0, pitch=0.0, roll=0.0, gaze=.5):
    """Spread a chest turn over spine_01-03; the neck and head take back ``gaze`` of the yaw and half the pitch."""
    for joint, share in SPINE:
        if yaw:
            rotate_world(rig, joint, UP, yaw * share)
        if pitch:
            rotate_world(rig, joint, X, pitch * share)
        if roll:
            rotate_world(rig, joint, Y, -roll * share)
    if yaw:
        rotate_world(rig, "neck_01", UP, -yaw * gaze)
    if pitch:
        rotate_world(rig, "neck_01", X, -pitch * .5)


def ease(i, count, s):
    """The curve parameter in segment ``i`` of ``count``: the first segment starts and the last ends at rest."""
    if count == 1:
        return smooth(s)
    if i == 0:
        return s * s * (2 - s)
    if i == count - 1:
        r = 1 - s
        return 1 - r * r * (2 - r)
    return s


def catmull(points, times, t):
    """A Catmull-Rom curve through ``points`` at ``times``, at rest at both ends, evaluated at ``t``."""
    if t <= times[0]:
        return points[0].copy()
    if t >= times[-1]:
        return points[-1].copy()
    i = max(k for k in range(len(times) - 1) if times[k] <= t)
    p0, p1, p2, p3 = points[max(i - 1, 0)], points[i], points[i + 1], points[min(i + 2, len(points) - 1)]
    s = ease(i, len(points) - 1, (t - times[i]) / (times[i + 1] - times[i]))
    s2, s3 = s * s, s * s * s
    return .5 * ((2 * p1) + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (-p0 + 3 * p1 - 3 * p2 + p3) * s3)


class Motion:
    """Both hands' grip frames and the chest turn through ``keys`` ((fraction, key) pairs), from and back to READY.
    The hands in ``cut`` turn their edge along their motion where they move fast."""

    def __init__(self, keys, cut=""):
        self.times = [0.0, *(u for u, _ in keys), 1.0]
        self.keys = [{}, *(key for _, key in keys), {}]
        self.cut = cut

    def hand(self, side, field):
        return [v(key.get(side, {}).get(field, READY[side][field])) for key in self.keys]

    def scalar(self, field):
        return [Vector((key.get(field, 0.0), 0, 0)) for key in self.keys]

    def at(self, u):
        frames = {}
        for side in "rl":
            g = catmull(self.hand(side, "g"), self.times, u)
            b = catmull(self.hand(side, "b"), self.times, u)
            e = catmull(self.hand(side, "e"), self.times, u)
            if side in self.cut:
                du = 1.0 / 60
                travel = catmull(self.hand(side, "g"), self.times, min(u + du, 1.0)) - catmull(self.hand(side, "g"), self.times, max(u - du, 0.0))
                speed = travel.length / (2 * du)
                if speed > 1e-3:
                    e = e.normalized().lerp(travel.normalized(), min(1.0, speed / 2.5))
            frames[side] = item_frame(g, b, e)
        chest = {name: catmull(self.scalar(name), self.times, u).x for name in ("yaw", "pitch", "roll")}
        return frames, chest


def pose_hands(rig, seed, frames, chest, gaze=.5):
    rig.apply(seed)
    turn_chest(rig, chest.get("yaw", 0.0), READY["pitch"] + chest.get("pitch", 0.0), chest.get("roll", 0.0), gaze)
    for side, frame in frames.items():
        place_grip(rig, HAND[side], frame, POLE[side])
    return rig.capture()


def run(rig, seed, motion, duration):
    frames = int(round(duration * FPS))
    return [pose_hands(rig, seed, *motion.at(k / frames)) for k in range(frames + 1)]


def ready_frames():
    return {side: item_frame(v(READY[side]["g"]), v(READY[side]["b"]), v(READY[side]["e"])) for side in "rl"}


def idle_loop(rig, stand_action):
    """The ready stance over the whole ``Idle_Loop`` resampled to the clip: the hands ride the breathing chest, which
    sways a little from side to side."""
    source = duration_of(stand_action)
    frames = int(round(IDLE["duration"] * FPS))
    rig.apply(sample(rig, stand_action, 0.0))
    chest0 = rig.head("spine_03")
    poses = []
    for k in range(frames + 1):
        phase = 2 * math.pi * (k % frames) / frames
        seed = sample(rig, stand_action, (k % frames) / frames * source)
        rig.apply(seed)
        breathe = rig.head("spine_03") - chest0 + Vector((0, 0, IDLE["bob"] * math.sin(2 * phase)))
        frames_now = {side: Matrix.Translation(breathe) @ frame for side, frame in ready_frames().items()}
        poses.append(pose_hands(rig, seed, frames_now, {"yaw": IDLE["sway"] * math.sin(phase)}))
    return poses, {"seedSeconds": round(source, 4)}


def strike(rig, seed, clip):
    spec = STRIKES[clip]
    poses = run(rig, seed, Motion(spec["keys"], spec.get("cut", "")), spec["duration"])
    return poses, {"contactFraction": spec["keys"][spec["contact"]][0]}


def belt_key(rig, seed):
    """The right hand's key at the belt (#470): its grip origin is the belt socket's origin in the stance, the item's +Y
    the socket's +Y turned ``DRAW_TILT`` out of the belt, the fingers (+X) down."""
    rig.apply(seed)
    turn_chest(rig, 0.0, READY["pitch"])
    m = rig.grip("belt")
    tilt = math.radians(DRAW_TILT)
    up, out = m.to_3x3() @ Y, m.to_3x3() @ Vector((0, 0, 1))
    return {"g": tuple(m.translation), "b": tuple(up * math.cos(tilt) + out * math.sin(tilt)), "e": tuple(-UP)}


def throw(rig, seed, spec):
    keys = [(spec["draw"], {"r": belt_key(rig, seed), "pitch": 14, "yaw": -8}), *spec["keys"]]
    poses = run(rig, seed, Motion(keys), spec["duration"])
    d = spec["duration"]
    return poses, {"drawSeconds": round(spec["draw"] * d, 4), "releaseSeconds": round(spec["release"] * d, 4)}


def flourish(rig, seed):
    """Both blades up before the chest, their tips circling twice in opposite senses, crossed, back to the stance."""
    spec = FLOURISH
    frames = int(round(spec["duration"] * FPS))
    s0, s1 = spec["spin"]
    cone = math.radians(spec["cone"])
    poses = []
    for k in range(frames + 1):
        u = k / frames
        up = window(u, 0, s0 + .08) * (1 - window(u, spec["cross"], 1.0))
        phase = 2 * math.pi * spec["turns"] * window(u, s0, s1)
        cross = window(u, s1 - .08, spec["cross"]) * (1 - window(u, spec["cross"] + .06, 1.0))
        out = {}
        for side, sense in (("r", 1), ("l", -1)):
            ready = READY[side]
            # The tip circles round the forward axis; the hand follows the tip on a small circle.
            ring = (Vector((0, 0, 1)) * math.cos(phase) + Vector((-sense, 0, 0)) * math.sin(phase))
            spin = window(u, s0, s0 + .1) * (1 - window(u, s1 - .1, s1))
            blade = (Vector((0, -1, 0)) * math.cos(cone) + ring * math.sin(cone) * spin + Vector((0, -.2, 1)) * (1 - spin)).normalized()
            g = v(spec[side]) + ring * spec["circle"] * spin + Vector((-sense * .06, 0, .04)) * cross
            blade = blade.lerp(Vector((sense * .6, -.3, .75)).normalized(), cross).normalized()
            g = v(ready["g"]).lerp(g, up)
            blade = v(ready["b"]).normalized().lerp(blade, up).normalized()
            out[side] = item_frame(g, blade, v(ready["e"]).lerp(ring, spin * up))
        poses.append(pose_hands(rig, seed, out, {"pitch": -6 * up, "yaw": 4 * math.sin(phase) * up}))
    return poses, {"turns": spec["turns"], "spinSeconds": [round(t * spec["duration"], 4) for t in spec["spin"]]}


def bandage(rig, seed):
    """The left forearm raised across the body; the right hand wraps round it and tugs the knot tight."""
    spec = BANDAGE
    frames = int(round(spec["duration"] * FPS))
    hand, elbow = v(spec["hand"]), v(spec["elbow"])
    axis = (hand - elbow).normalized()
    across = axis.cross(UP).normalized()
    over = across.cross(axis).normalized()
    w0, w1 = spec["wrap"]
    poses = []
    for k in range(frames + 1):
        u = k / frames
        up = window(u, 0, spec["raise"] + .08) * (1 - window(u, .9, 1.0))
        wrap = window(u, w0, w1)
        working = window(u, spec["raise"], w0) * (1 - window(u, spec["tug"][1], .96))
        phase = 2 * math.pi * spec["turns"] * wrap
        # The wrap creeps from the wrist up the forearm; the tug pulls the end out to the right.
        centre = hand.lerp(elbow, .25 + .3 * wrap)
        tug = math.sin(math.pi * window(u, *spec["tug"]))
        g = centre + (over * math.cos(phase) + across * math.sin(phase)) * spec["radius"] + Vector((-.14, -.04, -.02)) * tug
        ready_l, ready_r = READY["l"], READY["r"]
        left = item_frame(v(ready_l["g"]).lerp(hand, up), v(ready_l["b"]).lerp(Vector((0, 0, 1)), up), v(ready_l["e"]).lerp(-axis, up))
        right_g = v(ready_r["g"]).lerp(g, working)
        right = item_frame(right_g, v(ready_r["b"]).lerp(axis, working), v(ready_r["e"]).lerp(-(g - centre), working))
        poses.append(pose_hands(rig, seed, {"r": right, "l": left}, {"pitch": (spec["pitch"] - READY["pitch"]) * up}, gaze=.2))
    return poses, {"turns": spec["turns"], "wrapSeconds": [round(t * spec["duration"], 4) for t in spec["wrap"]]}


def upper_joints(rig):
    return [UPPER_ROOT, *(bone.name for bone in rig.rig.data.bones[UPPER_ROOT].children_recursive)]


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    stand = sample(rig, actions[STAND], 0.0)
    if clip == "Dagger_Idle_Loop":
        poses, observations = idle_loop(rig, actions[STAND])
    elif clip in STRIKES:
        poses, observations = strike(rig, stand, clip)
    elif clip == "Flourish_Haste":
        poses, observations = flourish(rig, stand)
    elif clip == "Throw_Knife":
        poses, observations = throw(rig, stand, KNIFE)
    elif clip == "Throw_Lob":
        poses, observations = throw(rig, stand, LOB)
    else:
        poses, observations = bandage(rig, stand)
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
        authored[clip] = author(Rig(rig_object, arguments["sockets"], rest_gltf), clip, actions)
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
    return {"recipe": "dagger-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
