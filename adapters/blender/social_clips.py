"""Original social and interaction clips authored on the Ranger rig in Blender (#421, the mmorpg emotes, doors, loot,
talk, trade, sitting and sleeping).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit hand frames solved with two-bone arm IK and
explicit pelvis and ankle targets solved with two-bone leg IK, on top of the first ``Idle_Loop`` pose (no source motion
is copied; Mixamo and the CC0 UAL1 ``Interact``, ``Fixing_Kneeling``, ``Idle_Talking_Loop`` and ``Sitting_*`` clips were
only watched as reference):

- A key names each hand's palm: the middle of the palm ``p`` (for the knock, the knuckles), the fingers ``y`` and the
  palm's normal ``z``. Missing fields hold the previous key's value; between keys the frames follow a Catmull-Rom curve
  that starts and ends at rest. A hand listed in a clip's ``rel`` is keyed in its joint's frame as it stands in the
  idle (the hand on the chest rides the bow, the hands on the thighs ride the pelvis as it sits). The chest turn
  (``yaw``, ``pitch``, ``roll``, ``neck``) is spread over ``spine_01``-``03``; ``rshape`` and ``lshape`` name the hand
  shapes (open, point, fist, grip, cup, claw), keyed on the finger joints.
- The emotes but the bow, the door and knock clips, the talk clips and the handover keep only the ``spine_01`` subtree
  (the observations list the joints), so a consumer plays them over standing or walking legs. The bow, the loot kneel,
  sitting and sleeping are full body and record a skirt and cape pose for the #391 chain joints (``secondaryPose``,
  as the cast and traversal clips): the panels follow the thighs; lying down they follow the body.
- ``*_Enter`` ends in its ``*_Loop``'s first pose, and ``*_Exit`` / ``Sleep_Bed_Wake`` is its enter played backwards,
  so the three chain without a blend. The door clips report where the hand meets the door (``contactPoint`` in the
  hand's glTF frame and ``contactAt`` in the root's, glTF axes, at the contact); the furniture clips report the seat or
  bed they assume.

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
LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
SPINE = (("spine_01", .3), ("spine_02", .35), ("spine_03", .35))
X, Y, UP = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
POLE = {"r": Vector((-.8, .35, -.5)), "l": Vector((.8, .35, -.5))}
FINGERS = ("index", "middle", "ring", "pinky", "thumb")
# The hand shapes: degrees per finger joint (01, 02, 03) toward the palm, and a spread (degrees about the palm normal,
# + away from the middle finger) per finger. ``grip`` wraps a door handle about 3 cm across.
SHAPES = {
    "open": {"curl": {"index": (4, 6, 4), "middle": (4, 6, 4), "ring": (6, 8, 4), "pinky": (8, 10, 6), "thumb": (0, 5, 5)},
             "spread": {"index": 8, "ring": 6, "pinky": 14, "thumb": 12}},
    "flat": {"curl": {"index": (0, 2, 2), "middle": (0, 2, 2), "ring": (0, 2, 2), "pinky": (0, 3, 2), "thumb": (0, 4, 4)},
             "spread": {"index": 3, "ring": 3, "pinky": 6, "thumb": 8}},
    "cup": {"curl": {"index": (28, 30, 20), "middle": (30, 34, 22), "ring": (32, 36, 22), "pinky": (34, 38, 24), "thumb": (10, 20, 20)},
            "spread": {"index": 4, "ring": 4, "pinky": 8}},
    "claw": {"curl": {"index": (20, 60, 50), "middle": (20, 62, 52), "ring": (22, 64, 52), "pinky": (24, 66, 54), "thumb": (10, 30, 35)},
             "spread": {"index": 10, "ring": 8, "pinky": 16, "thumb": 10}},
    "point": {"curl": {"index": (0, 4, 2), "middle": (80, 95, 60), "ring": (85, 95, 60), "pinky": (88, 95, 60), "thumb": (30, 40, 30)},
              "spread": {}},
    "fist": {"curl": {"index": (85, 100, 70), "middle": (88, 100, 70), "ring": (90, 100, 70), "pinky": (90, 100, 70), "thumb": (30, 45, 35)},
             "spread": {}},
    "grip": {"curl": {"index": (50, 70, 45), "middle": (52, 72, 46), "ring": (54, 72, 46), "pinky": (56, 74, 48), "thumb": (25, 35, 30)},
             "spread": {}},
}
# Points in the palm frame (the wrist, +Y toward the fingers, +Z out of the palm): the middle of the palm, and the
# knuckles of the curled fingers a knock lands with.
PALM = Vector((0, .05, .02))
KNUCKLES = Vector((0, .09, .015))

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up; metres (the pelvis stands at about z 0.91,
# the shoulders at 1.43, the ground at 0). A positive yaw turns the chest to the figure's left; a positive pitch bends
# it forward; a positive neck tips the head down.
#
# The furniture and the door the clips assume (standing defaults, #421): the door leaf 0.42 m ahead of the figure,
# the handle 1.0 m up, the knock at 1.42 m; a chair seat 0.45 m up, a bed 0.5 m up whose edge is 0.05 m behind the
# heels, the figure lying along it with its head to its left.
DOOR = {"distance": .34, "handle": 1.0, "knock": 1.42}
SEAT = {"height": .45, "pelvis": (0, .22, -.4), "ankles": {"l": (.17, -.2, .08), "r": (-.17, -.18, .085)}}
GROUND_SEAT = {"pelvis": (0, .1, -.76), "ankles": {"l": (-.06, -.3, .08), "r": (.08, -.22, .1)},
               "knees": {"l": Vector((1, -.4, .5)), "r": Vector((-1, -.4, .5))}}
BED = {"height": .5, "pelvis": (0, .2, -.36), "lying": (.02, .52, .62), "ankles": {"l": (.16, -.16, .08), "r": (-.16, -.14, .085)}}

WAVE = {"duration": 1.6, "gesture": (.28, .76), "hands": "r", "keys": [
    (.22, {"r": {"p": (-.3, -.14, 1.62), "y": (-.15, 0, 1), "z": (0, -1, 0)}, "rshape": "open", "roll": 3, "neck": -3}),
    *((u, {"r": {"p": (-.3 + dx, -.14, 1.62), "y": (dy, 0, 1)}}) for u, dx, dy in
      ((.34, -.04, -.5), (.46, .03, .2), (.58, -.04, -.5), (.7, .03, .2))),
    (.8, {"r": {"p": (-.3, -.14, 1.6), "y": (-.15, 0, 1)}}),
]}
POINT = {"duration": 1.2, "point": .32, "hands": "r", "keys": [
    (.32, {"r": {"p": (-.2, -.62, 1.4), "y": (.05, -1, .05), "z": (.3, 0, -1)}, "rshape": "point", "yaw": 8, "pitch": 3}),
    (.74, {"r": {"p": (-.2, -.61, 1.39)}, "yaw": 7, "pitch": 3}),
]}
BOW = {"duration": 1.8, "bow": (.38, .62), "hands": "r", "rel": {"r": "spine_03"}, "pitch": 24.0, "hip": 24.0, "back": .05, "keys": [
    (.2, {"r": {"p": (-.07, -.17, 1.3), "y": (.9, 0, .25), "z": (.1, 1, 0)}, "rshape": "flat"}),
    (.38, {"neck": 30}),
    (.62, {"neck": 30}),
    (.8, {"r": {"p": (-.07, -.17, 1.3)}, "neck": 0}),
]}
CHEER = {"duration": 1.8, "pumps": (.24, .44, .64), "hands": "rl", "keys": [
    (.24, {"r": {"p": (-.2, -.1, 2.0), "y": (0, -.1, 1), "z": (.7, -.7, 0)}, "rshape": "fist",
           "l": {"p": (.2, -.24, 1.12), "y": (0, -.5, .8), "z": (-.8, 0, 0)}, "lshape": "fist", "pitch": -6, "neck": -10}),
    (.34, {"r": {"p": (-.24, -.12, 1.8)}, "pitch": -3, "neck": -6}),
    (.44, {"r": {"p": (-.2, -.1, 2.0)}, "pitch": -6, "neck": -10}),
    (.54, {"r": {"p": (-.24, -.12, 1.8)}, "pitch": -3, "neck": -6}),
    (.64, {"r": {"p": (-.2, -.1, 2.0)}, "pitch": -6, "neck": -10}),
    (.8, {"r": {"p": (-.21, -.11, 1.96)}, "pitch": -5, "neck": -8}),
]}
LAUGH = {"duration": 2.0, "gesture": (.2, .8), "hands": "rl", "rel": {"r": "spine_01", "l": "spine_01"},
         "shake": {"amp": 2.5, "hz": 4.5, "span": (.18, .82)}, "keys": [
    (.16, {"r": {"p": (-.09, -.2, 1.04), "y": (.9, -.1, -.2), "z": (0, 1, 0)}, "rshape": "open",
           "l": {"p": (.1, -.19, 1.0), "y": (-.9, -.1, -.2), "z": (0, 1, 0)}, "lshape": "open", "pitch": -10, "neck": -18}),
    (.4, {"pitch": -7, "neck": -14}),
    (.62, {"pitch": 16, "neck": 8}),
    (.84, {"pitch": 10, "neck": 4}),
]}
PUSH = {"duration": .6, "contact": .38, "push": (.38, .72), "hands": "r", "keys": [
    (.38, {"r": {"p": (-.14, -DOOR["distance"], DOOR["handle"]), "y": (-.25, -.3, .9), "z": (0, -1, .25)}, "rshape": "flat",
           "pitch": 14, "yaw": 14}),
    (.72, {"r": {"p": (-.14, -DOOR["distance"] - .14, DOOR["handle"] + .04)}, "pitch": 18, "yaw": 18}),
]}
PULL = {"duration": .6, "contact": .38, "pull": (.38, .72), "hands": "r", "keys": [
    (.28, {"r": {"p": (-.15, -DOOR["distance"] + .04, DOOR["handle"] + .02), "y": (.3, -1, 0), "z": (1, .3, 0)}, "rshape": "open",
           "pitch": 14, "yaw": 14}),
    (.38, {"r": {"p": (-.14, -DOOR["distance"], DOOR["handle"])}, "rshape": "grip", "pitch": 14, "yaw": 14}),
    (.72, {"r": {"p": (-.24, -.22, DOOR["handle"]), "y": (.6, -.8, 0)}, "rshape": "grip", "pitch": -3, "yaw": 0}),
    (.84, {"rshape": "open"}),
]}
KNOCK = {"duration": 1.2, "knocks": (.3, .42, .54), "hands": "r", "point": "knuckles", "keys": [
    (.22, {"r": {"p": (-.13, -DOOR["distance"] + .07, DOOR["knock"]), "y": (0, -1, .25), "z": (.6, 0, -.8)}, "rshape": "fist",
           "pitch": 2}),
    *((u, {"r": {"p": (-.13, -DOOR["distance"] + dy, DOOR["knock"])}}) for u, dy in
      ((.3, 0), (.36, .06), (.42, 0), (.48, .06), (.54, 0), (.6, .07))),
    (.78, {"r": {"p": (-.18, -.2, 1.15)}, "pitch": -6, "neck": -3}),
]}
TALK_LOOP = {"duration": 3.0, "hands": "rl", "base": {
    "r": {"p": (-.18, -.3, 1.06), "y": (.25, -.9, .3), "z": (.3, 0, .95)}, "rshape": "open"}}
EXPLAIN = {"duration": 1.5, "beats": (.36, .6), "hands": "rl", "keys": [
    (.2, {"r": {"p": (-.13, -.36, 1.12), "y": (.3, -.9, .2), "z": (.6, 0, .8)}, "rshape": "open",
          "l": {"p": (.13, -.36, 1.12), "y": (-.3, -.9, .2), "z": (-.6, 0, .8)}, "lshape": "open", "pitch": 3}),
    (.36, {"r": {"p": (-.24, -.4, 1.08)}, "l": {"p": (.24, -.4, 1.08)}, "pitch": 5, "neck": 4}),
    (.48, {"r": {"p": (-.14, -.36, 1.14)}, "l": {"p": (.14, -.36, 1.14)}, "pitch": 3, "neck": 0}),
    (.6, {"r": {"p": (-.26, -.42, 1.06)}, "l": {"p": (.26, -.42, 1.06)}, "pitch": 5, "neck": 4}),
    (.78, {"r": {"p": (-.2, -.34, 1.08)}, "l": {"p": (.2, -.34, 1.08)}, "pitch": 3}),
]}
DIRECT = {"duration": 1.5, "point": .36, "hands": "l", "gaze": -.4, "keys": [
    (.36, {"l": {"p": (.5, -.42, 1.38), "y": (.65, -.75, .05), "z": (-.2, 0, -1)}, "lshape": "point", "yaw": 16, "pitch": 2}),
    (.72, {"l": {"p": (.5, -.42, 1.37)}, "yaw": 15}),
]}
SHRUG = {"duration": 1.5, "shrug": (.34, .64), "hands": "rl", "lift": 12.0, "keys": [
    (.34, {"r": {"p": (-.36, -.28, 1.02), "y": (-.5, -.85, 0), "z": (0, 0, 1)}, "rshape": "open",
           "l": {"p": (.36, -.28, 1.02), "y": (.5, -.85, 0), "z": (0, 0, 1)}, "lshape": "open", "roll": 4, "neck": -2}),
    (.64, {"r": {"p": (-.37, -.28, 1.03)}, "l": {"p": (.37, -.28, 1.03)}, "roll": 4}),
]}
HANDOVER = {"duration": .8, "handover": .45, "hands": "r", "keys": [
    (.45, {"r": {"p": (-.1, -.5, 1.16), "y": (.15, -1, .05), "z": (0, 0, 1)}, "rshape": "cup", "pitch": 6, "neck": 6}),
    (.62, {"r": {"p": (-.11, -.48, 1.15)}, "pitch": 5}),
]}
KNEEL = {"duration": .5, "kneel": .4, "step": .5, "pitch": 48.0, "yaw": -12.0,
         "hands": {"r": {"p": (-.22, -.46, .34), "y": (0, -.6, -.8), "z": (0, 0, -1)},
                   "l": {"p": (-.0, -.5, .37), "y": (-.2, -.6, -.8), "z": (0, 0, -1)}}}
RUMMAGE = {"duration": 2.0, "pickups": (.3, .8), "lift": .1}
SIT_ENTER = {"duration": .8, "seated": .85, "pitch": 28.0}
SLEEP_ENTER = {"duration": 1.5, "seated": .42}
BREATH = {"pitch": 1.2, "neck": 1.0}

# Which clips keep only the spine_01 subtree, and the hand that meets the door.
UPPER = {"Emote_Wave", "Emote_Point", "Emote_Cheer", "Emote_Laugh", "Door_Push", "Door_Pull", "Door_Knock", "Talk_Idle_Loop",
         "Talk_Gesture_A", "Talk_Gesture_B", "Talk_Gesture_C", "Trade_Handover"}
ONE_SHOTS = {"Emote_Wave": WAVE, "Emote_Point": POINT, "Emote_Bow": BOW, "Emote_Cheer": CHEER, "Emote_Laugh": LAUGH,
             "Door_Push": PUSH, "Door_Pull": PULL, "Door_Knock": KNOCK, "Talk_Gesture_A": EXPLAIN, "Talk_Gesture_B": DIRECT,
             "Talk_Gesture_C": SHRUG, "Trade_Handover": HANDOVER}
# The chains: enter, loop, exit (the exit is the enter backwards).
CHAINS = {"Loot_Kneel": ("Loot_Kneel_Enter", "Loot_Kneel_Loop", "Loot_Kneel_Exit"),
          "Sit_Chair": ("Sit_Chair_Enter", "Sit_Chair_Loop", "Sit_Chair_Exit"),
          "Sleep_Bed": ("Sleep_Bed_Enter", "Sleep_Bed_Loop", "Sleep_Bed_Wake")}
CLIPS = ("Emote_Wave", "Emote_Point", "Emote_Bow", "Emote_Cheer", "Emote_Laugh", "Door_Push", "Door_Pull", "Door_Knock",
         "Loot_Kneel_Enter", "Loot_Kneel_Loop", "Loot_Kneel_Exit", "Talk_Idle_Loop", "Talk_Gesture_A", "Talk_Gesture_B",
         "Talk_Gesture_C", "Trade_Handover", "Sit_Chair_Enter", "Sit_Chair_Loop", "Sit_Chair_Exit", "Sit_Ground_Loop",
         "Sleep_Bed_Enter", "Sleep_Bed_Loop", "Sleep_Bed_Wake")
# The #391 chain joints the full-body clips key, and how far the panels follow the thighs (as the cast kneel, #443).
CAPE = "cape_01"
SWING = {"share": .7, "front": 70.0, "sideShare": .8, "side": 75.0, "back": 20.0}
BACK = Vector((0, 1, 0))
PLUMB = ("skirt_f_03", "skirt_l_02", "skirt_r_02")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips"}:
        raise ValueError("social clips require exactly schemaVersion and clips")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"social clips must be distinct names from {CLIPS}")
    if set(inputs) != {"target"}:
        raise ValueError("social clips take exactly the declared input target")


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


def frame_of(position, y_axis, z_hint):
    """A frame at ``position`` whose +Y is ``y_axis`` and +Z as close to ``z_hint`` as it can be."""
    yy = y_axis.normalized()
    zz = z_hint - yy * z_hint.dot(yy)
    if zz.length < 1e-4:
        zz = (Vector((1, 0, 0)) if abs(yy.x) < .9 else Vector((0, 0, 1))).cross(yy)
    zz.normalize()
    m = Matrix((yy.cross(zz), yy, zz)).transposed().to_4x4()
    m.translation = position
    return m


def palm_frame(point, y_axis, z_hint, offset):
    """The palm (wrist) frame whose ``offset`` point lands on ``point``."""
    m = frame_of(Vector(), y_axis, z_hint)
    m.translation = point - m.to_3x3() @ offset
    return m


class Rig:
    def __init__(self, rig, rest_gltf):
        self.rig = rig
        self.bones = rig.pose.bones
        self.rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}
        self.rest_gltf = rest_gltf
        # The palms: at the wrist, +Y along the hand toward the fingers, +Z out of the palm (down in the rest T-pose).
        self.socket = {}
        for side in "lr":
            joint = f"hand_{side}"
            rest = self.rest[joint]
            self.socket[f"palm_{side}"] = (joint, rest.inverted() @ frame_of(rest.translation, rest.to_3x3() @ Y, Vector((0, 0, -1))))

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

    def point_in_joint(self, socket, point):
        """``point`` (metres in the socket's frame) in its joint's glTF frame, rounded."""
        joint, local = self.socket[socket]
        p = C4.inverted() @ self.rest[joint] @ local @ Vector(point)
        p = self.rest_gltf[joint].inverted() @ p
        return joint, [round(p.x, 4), round(p.y, 4), round(p.z, 4)]


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


def rotate_world(rig, name, axis, degrees, pivot=None):
    pb = rig.bones[name]
    head = (pivot if pivot is not None else pb.matrix.translation).copy()
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


def place_grip(rig, socket, frame, pole):
    """Solve the arm holding ``socket`` so its frame lands on ``frame``; half the hand's twist goes to the forearm."""
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


def turn_chest(rig, yaw=0.0, pitch=0.0, roll=0.0, neck=0.0, gaze=.5):
    """Spread a chest turn over spine_01-03; the neck and head take back ``gaze`` of the yaw and half the pitch, then
    tip by ``neck`` (negative looks up)."""
    for joint, share in SPINE:
        if yaw:
            rotate_world(rig, joint, UP, yaw * share)
        if pitch:
            rotate_world(rig, joint, X, pitch * share)
        if roll:
            rotate_world(rig, joint, Y, -roll * share)
    if yaw:
        rotate_world(rig, "neck_01", UP, -yaw * gaze)
    if pitch - 2 * neck:
        rotate_world(rig, "neck_01", X, -pitch * .5 + neck)


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


class Hands:
    """The finger poses: the seed's, and each hand shape keyed on top of the rest pose (local, so they hold in every
    arm pose)."""

    def __init__(self, rig, seed):
        self.joints = {side: [f"{f}_{k}_{side}" for f in FINGERS for k in ("01", "02", "03")] for side in "lr"}
        self.shapes = {side: {"seed": {n: seed[n].copy() for n in self.joints[side]}} for side in "lr"}
        rig.apply({name: Matrix.Identity(4) for name in rig.rest})
        palm = Vector((0, 0, -1))
        for side in "lr":
            for shape, spec in SHAPES.items():
                rig.apply({n: Matrix.Identity(4) for n in self.joints[side]})
                for finger in FINGERS:
                    chain = [f"{finger}_{k}_{side}" for k in ("01", "02", "03")]
                    along = (rig.bones[chain[1]].head - rig.bones[chain[0]].head).normalized()
                    hinge = along.cross(palm).normalized()
                    spread = spec["spread"].get(finger, 0.0)
                    if spread:
                        middle = (rig.bones[f"middle_02_{side}"].head - rig.bones[f"middle_01_{side}"].head).normalized()
                        away = 1.0 if along.cross(middle).dot(palm) > 0 else -1.0
                        rotate_world(rig, chain[0], palm, -away * spread)
                    for k, joint in enumerate(chain):
                        rotate_world(rig, joint, hinge, spec["curl"][finger][k])
                self.shapes[side][shape] = {n: rig.bones[n].matrix_basis.copy() for n in self.joints[side]}
        rig.apply(seed)

    def blend(self, side, a, b, u):
        out = {}
        for name in self.joints[side]:
            la, ra, _ = self.shapes[side][a][name].decompose()
            lb, rb, _ = self.shapes[side][b][name].decompose()
            if ra.dot(rb) < 0:
                rb.negate()
            out[name] = Matrix.Translation(la.lerp(lb, u)) @ ra.slerp(rb, u).to_matrix().to_4x4()
        return out


class Motion:
    """Both hands' palm frames, the chest turn and the hand shapes through ``keys`` ((fraction, key) pairs), from the
    ``start`` key and back to the ``end`` key; a missing field holds the previous key's value."""

    def __init__(self, start, keys, end):
        self.times = [0.0, *(u for u, _ in keys), 1.0]
        self.keys = [start, *(key for _, key in keys), end]

    def track(self, side, field):
        out, held = [], None
        for key in self.keys:
            value = key.get(side, {}).get(field)
            held = v(value) if value is not None else held
            out.append(held)
        return out

    def scalars(self, field):
        out, held = [], 0.0
        for key in self.keys:
            held = key.get(field, held)
            out.append(Vector((held, 0, 0)))
        return out

    def shape_at(self, side, u):
        shapes, held = [], "seed"
        for key in self.keys:
            held = key.get(f"{side}shape", held)
            shapes.append(held)
        i = max(k for k in range(len(self.times) - 1) if self.times[k] <= min(u, .999999))
        return shapes[i], shapes[i + 1], smooth((u - self.times[i]) / (self.times[i + 1] - self.times[i]))

    def at(self, u):
        points = {side: tuple(catmull(self.track(side, f), self.times, u) for f in "pyz") for side in "rl"}
        chest = {name: catmull(self.scalars(name), self.times, u).x for name in ("yaw", "pitch", "roll", "neck")}
        return points, chest, {side: self.shape_at(side, u) for side in "rl"}


class Actor:
    """The clip-independent state: the seed pose, the palms' seed points and the finger shapes."""

    def __init__(self, rig, seed):
        self.rig, self.seed = rig, seed
        rig.apply(seed)
        self.seed_joint = {name: rig.bones[name].matrix.copy() for name in ("pelvis", "spine_01", "spine_03")}
        self.start = {side: self.key_of(rig.grip(f"palm_{side}"), PALM) for side in "rl"}
        self.hands = Hands(rig, seed)

    @staticmethod
    def key_of(frame, offset):
        r = frame.to_3x3()
        return {"p": tuple(frame.translation + r @ offset), "y": tuple(r.col[1]), "z": tuple(r.col[2])}

    def seed_key(self, offset=PALM):
        self.rig.apply(self.seed)
        return {side: self.key_of(self.rig.grip(f"palm_{side}"), offset) for side in "rl"} | {"rshape": "seed", "lshape": "seed"}

    def carry(self, joint):
        """How ``joint`` has moved from where it stands in the seed (armature space)."""
        return self.rig.bones[joint].matrix @ self.seed_joint[joint].inverted()

    def pose(self, points, chest, shapes, hands="rl", rel=None, offset=PALM, body=None, after=None, gaze=.5, hang=0.0):
        """One frame: the body (pelvis, legs, shoulders), the chest turn, the keyed hands on their palm points (a hand
        in ``rel`` keyed in its joint's seed frame), the shapes, then ``after`` (a rigid turn of the whole figure)."""
        rig = self.rig
        rig.apply(self.seed)
        if body:
            body()
        turn_chest(rig, chest.get("yaw", 0.0), chest.get("pitch", 0.0), chest.get("roll", 0.0), chest.get("neck", 0.0), gaze)
        for side in "rl":
            if side in hands:
                p, y, z = points[side]
                frame = palm_frame(p, y, z, offset if side == "r" else PALM)
                if rel and side in rel:
                    frame = self.carry(rel[side]) @ frame
                place_grip(rig, f"palm_{side}", frame, POLE[side])
            elif hang:
                # The free arm hangs plumb from a bent chest.
                rotate_world(rig, ARMS[side][0], X, -hang)
            rig.apply(self.hands.blend(side, *shapes[side]))
        if after:
            after()
        return rig.capture()


def keyed(actor, spec, start, end, body=None, after=None, chest_extra=None):
    motion = Motion(start, spec["keys"], end)
    frames = int(round(spec["duration"] * FPS))
    poses = []
    offset = KNUCKLES if spec.get("point") == "knuckles" else PALM
    for k in range(frames + 1):
        u = k / frames
        points, chest, shapes = motion.at(u)
        if chest_extra:
            for name, value in chest_extra(u).items():
                chest[name] = chest.get(name, 0.0) + value
        poses.append(actor.pose(points, chest, shapes, hands=spec.get("hands", "rl"), rel=spec.get("rel"), offset=offset,
                                body=(lambda u=u: body(u)) if body else None, after=(lambda u=u: after(u)) if after else None,
                                gaze=spec.get("gaze", .5)))
    return poses


def plant_feet(rig, feet):
    """Put each ankle on its target position and orientation, the knee towards its direction."""
    for side, (ankle, matrix, knee) in feet.items():
        thigh, calf, foot, _ = LEGS[side]
        two_bone(rig, thigh, calf, foot, ankle, knee)
        m = matrix.copy()
        m.translation = rig.bones[foot].head.copy()
        rig.bones[foot].matrix = m
        bpy.context.view_layer.update()


def feet_of(rig):
    out = {}
    for side, (thigh, calf, foot, _) in LEGS.items():
        hip, knee, ankle = rig.head(thigh), rig.head(calf), rig.head(foot)
        u = (ankle - hip).normalized()
        bend = (knee - hip) - u * (knee - hip).dot(u)
        out[side] = (ankle, rig.bones[foot].matrix.copy(), bend.normalized() if bend.length > 1e-5 else Vector((0, -1, 0)))
    return out


def move_pelvis(rig, offset):
    pelvis = rig.bones["pelvis"]
    m = pelvis.matrix.copy()
    m.translation += offset
    pelvis.matrix = m
    bpy.context.view_layer.update()


def blend_pose(a, b, u):
    """Per joint, the local rotations slerped and the translations lerped from ``a`` to ``b``."""
    out = {}
    for name, ma in a.items():
        la, ra, _ = ma.decompose()
        lb, rb, _ = b[name].decompose()
        if ra.dot(rb) < 0:
            rb.negate()
        out[name] = Matrix.Translation(la.lerp(lb, u)) @ ra.slerp(rb, u).to_matrix().to_4x4()
    return out


def secondary(rig, follow=0.0):
    """The #391 chain pose of this frame (as adapters/blender/cast_clips.py): per chain joint it keys, its local
    rotation (glTF xyzw) under its parent (``pelvis``, ``spine_03`` for ``cape_01``, the joint above for the plumb
    joints). The front panel rides the higher thigh, each side panel follows its own thigh out and forward, and past the
    knee both hang plumb over the shin; the back panel and the cape hang but never pass into the legs or the back.
    ``follow`` (lying down) turns every joint back toward its rest under its parent, so the robe lies along the body."""
    down = Vector((0, 0, -1))
    thigh = {s: (rig.bones[LEGS[s][1]].head - rig.bones[LEGS[s][0]].head).normalized() for s in "lr"}
    lift = {s: math.degrees(math.atan2(max(0.0, -thigh[s].y), max(1e-6, -thigh[s].z))) if thigh[s].z < 0 else 90.0 for s in "lr"}
    reach = max(0.0, *(math.degrees(math.asin(max(0.0, min(1.0, thigh[s].y)))) for s in "lr"))
    turn = lambda degrees: Matrix.Rotation(math.radians(degrees), 3, Vector((1, 0, 0))) @ down

    def toward(direction, share, limit):
        angle = min(limit, share * math.degrees(down.angle(direction)))
        axis = down.cross(direction)
        return Matrix.Rotation(math.radians(angle), 3, axis.normalized()) @ down if axis.length > 1e-6 else down

    directions = {
        "skirt_f_01": turn(-min(SWING["front"], SWING["share"] * max(lift.values()))),
        "skirt_b_01": turn(min(SWING["back"], SWING["share"] * reach)),
        "skirt_l_01": toward(thigh["l"], SWING["sideShare"], SWING["side"]),
        "skirt_r_01": toward(thigh["r"], SWING["sideShare"], SWING["side"]),
    }
    spine = rig.bones["spine_03"].matrix.to_3x3()
    back = (spine @ rig.rest["spine_03"].to_3x3().inverted() @ BACK).normalized()
    cape = down.copy()
    if cape.dot(back) < .1:
        cape = (cape + back * (.1 - cape.dot(back))).normalized()
    directions[CAPE] = cape
    gltf = lambda m: C4.to_3x3().inverted() @ m @ C4.to_3x3()
    out, swings, parents = {}, {}, {}
    for joint, direction in directions.items():
        parent = "spine_03" if joint == CAPE else "pelvis"
        parents[joint] = parent
        delta = (rig.bones[parent].matrix.to_3x3() @ rig.rest[parent].to_3x3().inverted())
        parent_world = gltf(delta) @ rig.rest_gltf[parent].to_3x3()
        swings[joint] = gltf(down.rotation_difference(direction).to_matrix())
        out[joint] = (parent_world.inverted() @ swings[joint]).to_quaternion()
    # The chain joints rest with no rotation in the world, so a joint hanging plumb under a turned first joint (the
    # joints between keep its turn) takes its inverse turn: the front panel from its third joint, past the knee.
    for joint in PLUMB:
        out[joint] = swings[joint[:-2] + "01"].inverted().to_quaternion()
        parents[joint] = joint[:-1] + str(int(joint[-1]) - 1)
    if follow > 0:
        for joint, q in out.items():
            parent = parents[joint]
            if joint in rig.rest_gltf and parent in rig.rest_gltf:
                rest = (rig.rest_gltf[parent].to_3x3().inverted() @ rig.rest_gltf[joint].to_3x3()).to_quaternion()
            else:
                rest = (rig.rest_gltf[parent].to_3x3().inverted()).to_quaternion() if parent in rig.rest_gltf else Quaternion()
            if q.dot(rest) < 0:
                rest.negate()
            out[joint] = q.slerp(rest, follow)
    return {joint: [round(q.x, 5), round(q.y, 5), round(q.z, 5), round(q.w, 5)] for joint, q in out.items()}


def upper_joints(rig):
    return [UPPER_ROOT, *(bone.name for bone in rig.rig.data.bones[UPPER_ROOT].children_recursive)]


def root_point(p):
    """An armature-space point in the root's glTF axes (+Y up, +Z facing), rounded."""
    g = C4.inverted() @ p
    return [round(g.x, 4), round(g.y, 4), round(g.z, 4)]


# --- The one-shots ---------------------------------------------------------------------------------------------------

def shrug_body(rig, lift):
    """Raise both shoulders by ``lift`` degrees at the clavicles."""
    if lift:
        rotate_world(rig, "clavicle_r", Y, lift)
        rotate_world(rig, "clavicle_l", Y, -lift)


def bow_body(rig, feet, spec):
    """Tip the pelvis forward over the hips by ``hip`` degrees (shifting it back for balance), feet planted."""
    def body(u):
        down = window(u, .14, spec["bow"][0]) * (1 - window(u, spec["bow"][1], .9))
        hips = (rig.head("thigh_l") + rig.head("thigh_r")) * .5
        rotate_world(rig, "pelvis", X, spec["hip"] * down, pivot=hips)
        move_pelvis(rig, Vector((0, spec["back"] * down, 0)))
        plant_feet(rig, feet)
    return body


def one_shot(actor, clip):
    rig, spec = actor.rig, ONE_SHOTS[clip]
    start = actor.seed_key(KNUCKLES if spec.get("point") == "knuckles" else PALM)
    obs = {}
    body, extra = None, None
    if clip == "Emote_Bow":
        rig.apply(actor.seed)
        body = bow_body(rig, feet_of(rig), spec)
        extra = lambda u: {"pitch": spec["pitch"] * window(u, .14, spec["bow"][0]) * (1 - window(u, spec["bow"][1], .9))}
    elif clip == "Talk_Gesture_C":
        body = lambda u: shrug_body(rig, spec["lift"] * window(u, .1, spec["shrug"][0]) * (1 - window(u, spec["shrug"][1], .9)))
    elif clip == "Emote_Laugh":
        s = spec["shake"]
        extra = lambda u: {"pitch": s["amp"] * math.sin(2 * math.pi * s["hz"] * u * spec["duration"])
                           * window(u, s["span"][0] - .06, s["span"][0]) * (1 - window(u, s["span"][1], s["span"][1] + .08))}
    # The keyed points of a hand in ``rel`` are in its joint's seed frame, which is where the seed key already is.
    poses = keyed(actor, spec, start, start, body=body, chest_extra=extra)
    if clip == "Emote_Bow":
        obs["secondaryPose"] = record_chains(rig, poses)
    d = spec["duration"]
    at = lambda u: round(u * d, 4)
    if "gesture" in spec:
        obs["gestureSeconds"] = [at(u) for u in spec["gesture"]]
    if "point" in spec and spec["point"] != "knuckles":
        obs["pointSeconds"] = at(spec["point"])
    if "bow" in spec:
        obs["bowSeconds"] = [at(u) for u in spec["bow"]]
    if "pumps" in spec:
        obs["pumpSeconds"] = [at(u) for u in spec["pumps"]]
    if "beats" in spec:
        obs["gestureSeconds"] = [at(u) for u in spec["beats"]]
    if "shrug" in spec:
        obs["gestureSeconds"] = [at(u) for u in spec["shrug"]]
    if "handover" in spec:
        obs["handoverSeconds"] = at(spec["handover"])
        obs["contactSeconds"] = at(spec["handover"])
    if clip.startswith("Door_"):
        contact = spec["knocks"][0] if clip == "Door_Knock" else spec["contact"]
        obs["contactSeconds"] = at(contact)
        if clip == "Door_Knock":
            obs["knockSeconds"] = [at(u) for u in spec["knocks"]]
            obs["knockHeightMeters"] = DOOR["knock"]
        else:
            obs["doorPushSeconds" if clip == "Door_Push" else "doorPullSeconds"] = [at(u) for u in spec["push" if clip == "Door_Push" else "pull"]]
            obs["handleHeightMeters"] = DOOR["handle"]
        obs["doorDistanceMeters"] = DOOR["distance"]
        point = KNUCKLES if clip == "Door_Knock" else PALM
        joint, local = rig.socket["palm_r"]
        obs["contactJoint"] = joint
        obs["contactPoint"] = rig.point_in_joint("palm_r", tuple(point))[1]
        rig.apply(poses[int(round(contact * d * FPS))])
        obs["contactAt"] = root_point(rig.bones[joint].matrix @ local @ point)
    return poses, obs


# --- The chains: kneel, sit, sleep -----------------------------------------------------------------------------------

def record_chains(rig, poses, follow=None):
    chains = {}
    for k, pose in enumerate(poses):
        rig.apply(pose)
        for joint, rotation in secondary(rig, follow(k) if follow else 0.0).items():
            chains.setdefault(joint, []).append(rotation)
    return {"sampleRate": FPS, "joints": chains}


def reverse_chain(chain):
    return {"sampleRate": chain["sampleRate"], "joints": {joint: list(reversed(rots)) for joint, rots in chain["joints"].items()}}


def kneel_body(rig, feet, down):
    """Kneel on the right knee as the cast summon (#443): the pelvis drops ``kneel``, the left foot steps ``step``
    forward so the front thigh slopes down to the knee and the robe's front covers the shin, the right knee goes down
    behind with the toes on the ground."""
    left_ankle, left_matrix, _ = feet["l"]
    right_ankle, right_matrix, _ = feet["r"]
    move_pelvis(rig, Vector((0, .1 * down, -KNEEL["kneel"] * down)))
    la = left_ankle + Vector((0, -KNEEL["step"], 0)) * window(down, .0, .6)
    ra = right_ankle + Vector((0, .3, .06)) * window(down, .2, 1.0)
    plant_feet(rig, {"l": (la, left_matrix, Vector((0, -1, .2))), "r": (ra, right_matrix, Vector((0, -.6, -1)))})
    if down > 1e-3:
        rotate_world(rig, "foot_r", X, -50 * window(down, .2, 1.0))


def kneel_key():
    hands = KNEEL["hands"]
    return {"r": dict(hands["r"]), "l": dict(hands["l"]), "rshape": "cup", "lshape": "cup", "pitch": KNEEL["pitch"], "yaw": KNEEL["yaw"]}


def loot_enter(actor):
    rig = actor.rig
    rig.apply(actor.seed)
    feet = feet_of(rig)
    spec = {"duration": KNEEL["duration"], "hands": "rl", "keys": [
        (.45, {"r": {"p": (-.24, -.36, .7), "y": (0, -.6, -.8), "z": (0, 0, -1)}, "l": {"p": (.08, -.38, .74), "y": (-.2, -.6, -.8), "z": (0, 0, -1)},
               "rshape": "open", "lshape": "open", "pitch": 22, "yaw": -6}),
    ]}
    body = lambda u: kneel_body(rig, feet, window(u, 0, .85))
    return keyed(actor, spec, actor.seed_key(), kneel_key(), body=body)


def loot_loop(actor):
    """Kneeling, both hands rummage on the corpse ahead; the right hand lifts something at the first pickup, the left
    at the second."""
    rig = actor.rig
    rig.apply(actor.seed)
    feet = feet_of(rig)
    k = kneel_key()
    r, l = v(k["r"]["p"]), v(k["l"]["p"])
    lift = RUMMAGE["lift"]
    p1, p2 = RUMMAGE["pickups"]
    up = Vector((0, 0, lift))
    keys = [
        (.12, {"r": {"p": tuple(r + Vector((.05, -.04, -.02)))}, "l": {"p": tuple(l + Vector((-.03, .03, .02)))}, "rshape": "claw", "yaw": -14}),
        (p1, {"r": {"p": tuple(r + Vector((.02, .02, -.03)))}, "rshape": "fist", "yaw": -12}),
        (p1 + .12, {"r": {"p": tuple(r + up + Vector((.02, .06, 0)))}, "l": {"p": tuple(l + Vector((.04, -.03, -.02)))}, "lshape": "claw", "pitch": KNEEL["pitch"] - 4}),
        (.6, {"r": {"p": tuple(r + Vector((-.02, .01, .02)))}, "rshape": "cup", "yaw": -10, "pitch": KNEEL["pitch"]}),
        (p2, {"l": {"p": tuple(l + Vector((.0, .02, -.03)))}, "lshape": "fist"}),
        (p2 + .1, {"l": {"p": tuple(l + up + Vector((0, .06, 0)))}, "pitch": KNEEL["pitch"] - 4}),
        (.96, {"l": {"p": tuple(l)}, "lshape": "cup", "pitch": KNEEL["pitch"]}),
    ]
    spec = {"duration": RUMMAGE["duration"], "hands": "rl", "keys": keys}
    poses = keyed(actor, spec, k, k, body=lambda u: kneel_body(rig, feet, 1.0))
    return poses


def sit_body(rig, feet, seat, u_down, u_back, u_feet):
    """Lower the pelvis onto a seat behind (``seat`` pelvis offset), the feet stepping to their seated places."""
    move_pelvis(rig, Vector((0, seat["pelvis"][1] * u_back, seat["pelvis"][2] * u_down)))
    planted = {}
    for side in "lr":
        ankle, matrix, _ = feet[side]
        target = v(seat["ankles"][side])
        a = ankle.lerp(target, u_feet) + Vector((0, 0, .05 * math.sin(math.pi * u_feet)))
        planted[side] = (a, matrix, Vector((0, -1, .1)))
    plant_feet(rig, planted)


def thigh_hands(rig):
    """Palm keys resting on top of both thighs, toward the knees (in the current pose)."""
    out = {}
    for side, sign in (("r", -1), ("l", 1)):
        hip, knee = rig.head(LEGS[side][0]), rig.head(LEGS[side][1])
        along = (knee - hip).normalized()
        p = hip.lerp(knee, .72) + Vector((0, 0, .075)) + Vector((sign * .015, 0, 0))
        out[side] = {"p": tuple(p), "y": tuple(along + Vector((0, 0, -.25))), "z": (0, 0, -1)}
    return out


def seated_key(actor, seat, chest, hands_at):
    """The seated pose's key: the hands placed by ``hands_at`` in the seated body, keyed in the pelvis' seed frame."""
    rig = actor.rig
    rig.apply(actor.seed)
    feet = feet_of(rig)
    sit_body(rig, feet, seat, 1.0, 1.0, 1.0)
    turn_chest(rig, **chest)
    hands = hands_at(rig)
    carry = actor.carry("pelvis").inverted()
    key = {"rshape": "flat", "lshape": "flat", **chest}
    for side, h in hands.items():
        f = carry @ frame_of(v(h["p"]), v(h["y"]), v(h["z"]))
        key[side] = {"p": tuple(f.translation), "y": tuple(f.to_3x3().col[1]), "z": tuple(f.to_3x3().col[2])}
    return key, feet


def sit_enter(actor, seat=SEAT, spec=SIT_ENTER, hands_at=thigh_hands, chest=None):
    rig = actor.rig
    chest = chest or {"pitch": 6.0}
    key, feet = seated_key(actor, seat, chest, hands_at)
    s = spec["seated"]
    keys = [(s * .5, {"pitch": spec.get("pitch", 28.0), "neck": -8})]
    motion_spec = {"duration": spec["duration"], "hands": "rl", "rel": {"r": "pelvis", "l": "pelvis"}, "keys": keys}
    body = lambda u: sit_body(rig, feet, seat, window(u, .1, s), window(u, .18, s), window(u, 0, .5))
    end = {**key, "neck": 0}
    return keyed(actor, motion_spec, actor.seed_key(), end, body=body), key, feet


def breathing(actor, key, body, duration, after=None, follow_neck=True):
    """A held pose breathing: the chest lifts ``BREATH`` once per loop, the head a little with it."""
    rig = actor.rig
    frames = int(round(duration * FPS))
    poses = []
    motion = Motion(key, [], key)
    points, chest, shapes = motion.at(0.0)
    for k in range(frames + 1):
        phase = 2 * math.pi * (k % frames) / frames
        c = dict(chest)
        c["pitch"] = c.get("pitch", 0.0) - BREATH["pitch"] * math.sin(phase)
        if follow_neck:
            c["neck"] = c.get("neck", 0.0) + BREATH["neck"] * math.sin(phase + .6)
        poses.append(actor.pose(points, c, shapes, hands="rl", rel={"r": "pelvis", "l": "pelvis"}, body=body, after=after))
    return poses


def ground_body(rig):
    """Cross-legged on the ground: the pelvis down, the knees out, the shins crossed in front, the feet on their edges."""
    seat = GROUND_SEAT
    move_pelvis(rig, Vector(seat["pelvis"]))
    for side in "lr":
        thigh, calf, foot, _ = LEGS[side]
        two_bone(rig, thigh, calf, foot, v(seat["ankles"][side]), seat["knees"][side])
        across = Vector((-1 if side == "l" else 1, -.35, 0))
        aim(rig, foot, across)
        # The sole turns up and in, onto the foot's outer edge.
        rotate_world(rig, foot, across.normalized(), 70 if side == "l" else -70)


def knee_hands(rig):
    out = {}
    for side, sign in (("r", -1), ("l", 1)):
        knee = rig.head(LEGS[side][1])
        out[side] = {"p": tuple(knee + Vector((-sign * .03, -.02, .07))), "y": (sign * .3, -1, -.3), "z": (0, 0, -1)}
    return out


def sit_ground(actor):
    rig = actor.rig
    chest = {"pitch": 10.0}
    rig.apply(actor.seed)
    ground_body(rig)
    turn_chest(rig, **chest)
    hands = knee_hands(rig)
    carry = actor.carry("pelvis").inverted()
    key = {"rshape": "open", "lshape": "open", **chest}
    for side, h in hands.items():
        f = carry @ frame_of(v(h["p"]), v(h["y"]), v(h["z"]))
        key[side] = {"p": tuple(f.translation), "y": tuple(f.to_3x3().col[1]), "z": tuple(f.to_3x3().col[2])}
    return breathing(actor, key, lambda: ground_body(rig), 3.0)


def bed_hands(rig):
    """Both palms on the bed beside the hips, taking the weight."""
    out = {}
    for side, sign in (("r", -1), ("l", 1)):
        hip = rig.head(LEGS[side][0])
        out[side] = {"p": (hip.x + sign * .2, hip.y + .02, BED["height"] + .02), "y": (sign * .2, -1, 0), "z": (0, 0, -1)}
    return out


def lying_turn(rig):
    """Lay the upright figure on the bed: turn it about the pelvis so its head points to its left (+X) and its face
    up, and put the pelvis on the bed (``BED["lying"]``)."""
    turn = Matrix(((0, 0, 1), (-1, 0, 0), (0, -1, 0))).to_4x4()
    pelvis = rig.bones["pelvis"]
    head = pelvis.head.copy()
    pelvis.matrix = Matrix.Translation(v(BED["lying"])) @ turn @ Matrix.Translation(-head) @ pelvis.matrix
    bpy.context.view_layer.update()


def lying_body(rig, feet):
    """The upright body the lying pose turns: legs straight and together under the hips, the toes forward."""
    planted = {}
    for side in "lr":
        hip = rig.head(LEGS[side][0])
        planted[side] = (Vector((hip.x * .9, hip.y - .02, .085)), feet[side][1], Vector((0, -1, 0)))
    plant_feet(rig, planted)
    for side in "lr":
        aim(rig, LEGS[side][2], Vector((0, -1, -.7)))


def lying_key(actor):
    """The lying pose's key (upright before the turn): the right hand at the side, the left on the belly, the head
    tipped forward onto the pillow."""
    return {"r": {"p": (-.27, -.04, .9), "y": (.1, -.1, -1), "z": (1, 0, 0)}, "l": {"p": (.06, -.21, 1.04), "y": (-.9, -.1, -.3), "z": (0, 1, 0)},
            "rshape": "open", "lshape": "flat", "neck": 12.0}


def lying_pose(actor, feet, phase=0.0):
    rig = actor.rig
    key = lying_key(actor)
    chest = {"pitch": -BREATH["pitch"] * math.sin(phase), "neck": key["neck"] + BREATH["neck"] * math.sin(phase + .6)}
    points = {side: (v(key[side]["p"]), v(key[side]["y"]), v(key[side]["z"])) for side in "rl"}
    shapes = {side: (key[f"{side}shape"], key[f"{side}shape"], 1.0) for side in "rl"}
    return actor.pose(points, chest, shapes, body=lambda: lying_body(rig, feet), after=lambda: lying_turn(rig))


def sleep_enter(actor):
    """Sit on the bed's edge (``seated``), then lie back and swing the legs up: a blend from the seated pose to the
    lying one."""
    rig = actor.rig
    duration, seated = SLEEP_ENTER["duration"], SLEEP_ENTER["seated"]
    sit_spec = {"duration": duration * seated, "seated": .9, "pitch": 24.0}
    sit_poses, _, feet = sit_enter(actor, seat=BED, spec=sit_spec, hands_at=bed_hands, chest={"pitch": 4.0})
    lying = lying_pose(actor, feet)
    frames = int(round(duration * FPS))
    first = len(sit_poses) - 1
    poses = sit_poses[:]
    for k in range(first + 1, frames + 1):
        u = smooth((k - first) / (frames - first))
        poses.append(blend_pose(sit_poses[-1], lying, u))
    follow = lambda k: 0.0 if k <= first else smooth((k - first) / (frames - first))
    return poses, record_chains(rig, poses, follow), round(first / FPS, 4)


def sleep_loop(actor):
    rig = actor.rig
    rig.apply(actor.seed)
    feet = feet_of(rig)
    frames = int(round(4.0 * FPS))
    poses = [lying_pose(actor, feet, 2 * math.pi * (k % frames) / frames) for k in range(frames + 1)]
    return poses, record_chains(rig, poses, lambda k: 1.0)


def chain_clip(actor, clip):
    """The enter, loop or exit of a chain, its chain pose and its markers."""
    rig = actor.rig
    family = next(name for name, clips in CHAINS.items() if clip in clips)
    enter, loop_clip, exit_clip = CHAINS[family]
    obs = {}
    if family == "Loot_Kneel":
        if clip == loop_clip:
            poses = loot_loop(actor)
            obs["pickupSeconds"] = [round(u * RUMMAGE["duration"], 4) for u in RUMMAGE["pickups"]]
        else:
            poses = loot_enter(actor)
            # The knee is down at 85% of the enter, so the exit (the enter backwards) lifts it at 15%.
            obs["kneelSeconds" if clip == enter else "standSeconds"] = round((.85 if clip == enter else .15) * KNEEL["duration"], 4)
        chain = record_chains(rig, poses)
    elif family == "Sit_Chair":
        rig.apply(actor.seed)
        if clip == loop_clip:
            key, feet = seated_key(actor, SEAT, {"pitch": 6.0}, thigh_hands)
            poses = breathing(actor, key, lambda: sit_body(rig, feet, SEAT, 1.0, 1.0, 1.0), 3.0)
        else:
            poses, _, _ = sit_enter(actor)
            t = round(SIT_ENTER["seated"] * SIT_ENTER["duration"], 4)
            obs["seatedSeconds" if clip == enter else "standSeconds"] = t if clip == enter else round(SIT_ENTER["duration"] - t, 4)
        chain = record_chains(rig, poses)
        obs["seatHeightMeters"] = SEAT["height"]
        obs["seatPelvis"] = root_point(actor.seed_joint["pelvis"].translation + v(SEAT["pelvis"]))
    else:
        if clip == loop_clip:
            poses, chain = sleep_loop(actor)
        else:
            poses, chain, seated = sleep_enter(actor)
            d = SLEEP_ENTER["duration"]
            obs.update({"seatedSeconds": seated, "lieSeconds": d} if clip == enter else {"sitUpSeconds": round(d - seated, 4), "standSeconds": d})
        obs["bedHeightMeters"] = BED["height"]
        obs["lyingPelvis"] = root_point(v(BED["lying"]))
    if clip == exit_clip:
        poses = list(reversed(poses))
        chain = reverse_chain(chain)
        obs["startsFrom"] = loop_clip
    elif clip == enter:
        obs["next"] = loop_clip
    obs["secondaryPose"] = chain
    return poses, obs


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    seed = sample(rig, actions[STAND], 0.0)
    actor = Actor(rig, seed)
    if clip in ONE_SHOTS:
        poses, observations = one_shot(actor, clip)
    elif clip == "Talk_Idle_Loop":
        poses, observations = talk_loop(actor), {}
    elif clip == "Sit_Ground_Loop":
        rig.apply(seed)
        poses = sit_ground(actor)
        observations = {"seatHeightMeters": 0.0, "secondaryPose": record_chains(rig, poses)}
    else:
        poses, observations = chain_clip(actor, clip)
    return poses, {"source": STAND, "durationSeconds": round((len(poses) - 1) / FPS, 4), **observations,
                   **({"layer": UPPER_ROOT, "joints": upper_joints(rig)} if clip in UPPER else {})}


def talk_loop(actor):
    """A conversational idle: the right hand turned up before the waist circling a little, the left hand at rest,
    the chest swaying and the head nodding twice."""
    spec = TALK_LOOP
    start = actor.seed_key()
    base = {**start, **spec["base"]}
    frames = int(round(spec["duration"] * FPS))
    poses = []
    for k in range(frames + 1):
        phase = 2 * math.pi * (k % frames) / frames
        p = v(base["r"]["p"]) + Vector((.03 * math.sin(phase), -.02 * math.sin(2 * phase), .025 * math.sin(2 * phase + .5)))
        y = v(base["r"]["y"]) + Vector((.15 * math.sin(2 * phase), 0, 0))
        points = {"r": (p, y, v(base["r"]["z"])), "l": (v(start["l"]["p"]), v(start["l"]["y"]), v(start["l"]["z"]))}
        chest = {"yaw": 3 * math.sin(phase), "roll": 1.5 * math.sin(phase + 1), "neck": 4 * max(0.0, math.sin(2 * phase)) ** 2}
        shapes = {"r": ("open", "open", 1.0), "l": ("seed", "seed", 1.0)}
        poses.append(actor.pose(points, chest, shapes, hands="rl"))
    return poses


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
        authored[clip] = author(Rig(rig_object, rest_gltf), clip, actions)
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
    return {"recipe": "social-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
