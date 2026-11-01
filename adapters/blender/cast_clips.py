"""Original casting-style, staff and mace clips authored on the Ranger rig in Blender (#420, the mmorpg casters).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit hand frames solved with two-bone arm IK on top of
the first ``Idle_Loop`` pose (no source motion is copied; Mixamo was only watched as reference):

- The casters hold their staff on ``hand_r.staff`` (``arguments["sockets"]["staff"]``), the Arcanist's tome on
  ``hand_l.shield`` (``tome``) and the Cleric's mace on ``hand_r.weapon`` (``weapon``, also the Warden's sword for
  ``Warcry``). The two-handed staff strikes put the left hand on the shaft with ``hand_l.staff`` (``staffLeft``).
- A key names the right hand's item frame (``r``: grip position ``g``, the item's +Y ``y`` and a hint for its +Z ``z``)
  and the left hand's frame (``l``): either its palm (position of the wrist ``g``, the fingers ``y``, the palm's
  normal ``z``) or, for the strikes, the staff grip. Missing fields hold the previous key's value; between keys the
  frames follow a Catmull-Rom curve that starts and ends at rest. The chest turn (``yaw``, ``pitch``, ``roll``) is
  spread over ``spine_01``-``03``; ``shape`` names the left hand's casting shape (open, cup, claw, point, fist),
  keyed on its finger joints. The right hand's fingers are left to the grip pose the consumer plays.
- Every clip but ``Cast_Nova`` and ``Cast_Summon_Raise`` keeps only the ``spine_01`` subtree (the observations list
  the joints), so a consumer plays it over standing, walking or running legs. Those two are full body; the summon
  kneels and records a skirt and cape pose for the #391 chain joints (``secondaryPose``, as the traversal clips).
- The releases (``Cast_Release_*``) start in ``Cast_Charge_Loop``'s first pose and end in the idle; every other one-shot
  starts and ends in the first ``Idle_Loop`` pose. Each one-shot reports its ``releaseSeconds`` (the moment the spell
  leaves or the strike lands); the channels and casts that aim report ``channelJoint`` and ``channelPoint`` (the point
  the effect starts from, in that joint's glTF frame: the staff's head, or the palm).

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
# The casting hand shapes: degrees per finger joint (01, 02, 03) toward the palm, and a spread (degrees about the palm
# normal, + away from the middle finger) per finger.
SHAPES = {
    "open": {"curl": {"index": (4, 6, 4), "middle": (4, 6, 4), "ring": (6, 8, 4), "pinky": (8, 10, 6), "thumb": (0, 5, 5)},
             "spread": {"index": 8, "ring": 6, "pinky": 14, "thumb": 12}},
    "cup": {"curl": {"index": (28, 30, 20), "middle": (30, 34, 22), "ring": (32, 36, 22), "pinky": (34, 38, 24), "thumb": (10, 20, 20)},
            "spread": {"index": 4, "ring": 4, "pinky": 8}},
    "claw": {"curl": {"index": (20, 60, 50), "middle": (20, 62, 52), "ring": (22, 64, 52), "pinky": (24, 66, 54), "thumb": (10, 30, 35)},
             "spread": {"index": 10, "ring": 8, "pinky": 16, "thumb": 10}},
    "point": {"curl": {"index": (0, 4, 2), "middle": (80, 95, 60), "ring": (85, 95, 60), "pinky": (88, 95, 60), "thumb": (30, 40, 30)},
              "spread": {}},
    "fist": {"curl": {"index": (85, 100, 70), "middle": (88, 100, 70), "ring": (90, 100, 70), "pinky": (90, 100, 70), "thumb": (30, 45, 35)},
             "spread": {}},
}
SOCKETS = ("staff", "staffLeft", "tome", "weapon")

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up. Positions are metres in armature space
# (the pelvis stands at about z 0.91, the shoulders at 1.42). A positive yaw turns the chest to the figure's left; a
# positive pitch bends it forward. ``r`` keys the staff grip (``g``, the shaft ``y`` toward the head, the back of the
# hand ``z``); ``l`` the left palm (the wrist ``g``, the fingers ``y``, the palm's normal ``z``).
#
# The charge: the staff upright before the right of the chest, the left hand cupped before the chest facing it.
CHARGE = {"r": {"g": (-.2, -.3, 1.1), "y": (.05, -.2, 1), "z": (-.6, -.8, 0)},
          "l": {"g": (.05, -.3, 1.2), "y": (-.25, -.7, .6), "z": (-.8, 0, .3)}, "shape": "cup", "pitch": 4}
CHARGE_LOOP = {"duration": 1.0, "circle": .025, "bob": .01, "sway": 2.0}
# The releases from the charge: (fraction, key) pairs; ``release`` is the fraction where the spell leaves the hand.
PUSH = {"duration": .5, "release": .44, "keys": [
    (.2, {"l": {"g": (.08, -.2, 1.22), "y": (0, -.2, 1), "z": (0, -1, .1)}, "shape": "open", "yaw": -6}),
    (.44, {"l": {"g": (.06, -.6, 1.32), "y": (0, -.15, 1), "z": (0, -1, 0)}, "r": {"g": (-.2, -.38, 1.12)}, "yaw": 10, "pitch": 8}),
    (.62, {"l": {"g": (.07, -.56, 1.3)}, "yaw": 8, "pitch": 7}),
]}
OVERHAND = {"duration": .6, "release": .52, "keys": [
    (.3, {"l": {"g": (.3, .02, 1.62), "y": (0, -.3, 1), "z": (0, -.9, .4)}, "shape": "open", "yaw": 22, "pitch": -4}),
    (.52, {"l": {"g": (.08, -.58, 1.38), "y": (0, -.8, .5), "z": (0, -.5, -.8)}, "yaw": -14, "pitch": 12}),
    (.7, {"l": {"g": (.02, -.5, 1.18), "y": (0, -.6, -.6), "z": (0, .4, -1)}, "yaw": -16, "pitch": 14}),
]}
# The channels: a held pose and how it moves through the loop.
BEAM = {"duration": 1.5, "r": {"g": (-.14, -.42, 1.28), "y": (0, -.75, .65), "z": (-.6, .2, .6)},
        "l": {"g": (.03, -.4, 1.3), "y": (-.1, -.3, 1), "z": (-.1, -1, -.1)}, "shape": "open", "yaw": 6, "pitch": 6,
        "tremble": .006, "push": .015}
DRAIN = {"duration": 1.5, "r": {"g": (-.22, -.24, 1.02), "y": (.05, -.15, 1), "z": (-.7, -.7, 0)},
         "l": {"g": (.12, -.55, 1.32), "y": (0, -.6, .8), "z": (0, -1, -.2)}, "shape": "claw", "yaw": -8, "pitch": 4,
         "pull": .16, "pulls": 2}
SKY = {"duration": 2.0, "r": {"g": (-.3, -.24, 1.62), "y": (.05, -.1, 1), "z": (-.8, -.5, 0)},
       "l": {"g": (.3, -.28, 1.6), "y": (.2, -.3, .9), "z": (-.1, -.3, .95)}, "shape": "open", "pitch": -8,
       "circle": .04, "neck": -18}
# Self-centred and ally casts and the other one-shots, from and back to the idle.
NOVA = {"duration": .8, "release": .48, "drop": .09, "keys": [
    (.28, {"r": {"g": (-.24, -.26, 1.18), "y": (0, -.05, 1), "z": (-.7, -.7, 0)},
           "l": {"g": (.24, -.22, 1.22), "y": (0, -.3, .9), "z": (-.6, -.6, 0)}, "shape": "cup", "pitch": -4}),
    (.48, {"r": {"g": (-.26, -.26, .81), "y": (0, -.05, 1)}, "l": {"g": (.48, -.22, .98), "y": (.7, -.3, -.6), "z": (.3, 0, -1)},
           "shape": "open", "pitch": 14}),
    (.7, {"l": {"g": (.46, -.2, 1.0)}, "pitch": 12}),
]}
CONE = {"duration": .9, "release": .32, "sweep": (.32, .74), "keys": [
    (.2, {"l": {"g": (.08, -.22, 1.24), "y": (0, -.3, .9), "z": (0, -1, .1)}, "r": {"g": (-.2, -.3, 1.1)}, "shape": "open", "yaw": -10}),
    (.32, {"l": {"g": (-.02, -.56, 1.3), "y": (-.2, -.2, 1), "z": (-.3, -1, 0)}, "yaw": -28, "pitch": 6}),
    (.53, {"l": {"g": (.08, -.6, 1.3), "y": (0, -.2, 1), "z": (0, -1, 0)}, "yaw": 0, "pitch": 6}),
    (.74, {"l": {"g": (.18, -.56, 1.3), "y": (.2, -.2, 1), "z": (.3, -1, 0)}, "yaw": 28, "pitch": 6}),
]}
CURSE = {"duration": .5, "release": .5, "keys": [
    (.3, {"l": {"g": (.1, -.18, 1.36), "y": (-.2, -.4, .9), "z": (-.8, 0, -.3)}, "shape": "point", "yaw": -8}),
    (.5, {"l": {"g": (.1, -.6, 1.36), "y": (0, -1, .05), "z": (-.3, 0, -1)}, "yaw": 12, "pitch": 6}),
    (.68, {"l": {"g": (.11, -.56, 1.34)}, "yaw": 10, "pitch": 5}),
]}
GROUND = {"duration": .7, "release": .56, "keys": [
    (.3, {"l": {"g": (.16, -.32, 1.38), "y": (0, -.6, .8), "z": (0, -.4, -.9)}, "shape": "open", "pitch": -2}),
    (.56, {"l": {"g": (.12, -.56, 1.0), "y": (0, -.9, -.2), "z": (0, -.2, -1)}, "pitch": 16}),
    (.74, {"l": {"g": (.12, -.54, 1.02)}, "pitch": 14}),
]}
WARD = {"duration": .9, "release": .6, "keys": [
    (.34, {"l": {"g": (.06, -.17, 1.28), "y": (-.8, -.1, .2), "z": (0, 1, 0)}, "r": {"g": (-.18, -.25, 1.06)}, "shape": "fist",
           "pitch": 6}),
    (.6, {"l": {"g": (.5, -.2, 1.3), "y": (.8, -.3, .4), "z": (.2, -1, 0)}, "r": {"g": (-.42, -.2, 1.12), "y": (-.2, 0, 1)},
          "shape": "open", "pitch": -6}),
    (.78, {"l": {"g": (.46, -.18, 1.26)}, "r": {"g": (-.4, -.2, 1.1)}, "pitch": -5}),
]}
ALLY = {"duration": .7, "release": .48, "keys": [
    (.22, {"l": {"g": (.14, -.24, 1.24), "y": (0, -.4, .9), "z": (0, -1, .2)}, "shape": "open"}),
    (.48, {"l": {"g": (.2, -.58, 1.34), "y": (.1, -.4, .9), "z": (.1, -1, .3)}, "yaw": 8, "pitch": 4}),
    (.72, {"l": {"g": (.2, -.55, 1.32)}, "yaw": 6, "pitch": 3}),
]}
# The war cry: the sword (``hand_r.weapon``, blade ``y``, edge hint ``z``) thrust up, the left fist clenched, head back.
WARCRY = {"duration": 1.0, "release": .4, "keys": [
    (.2, {"r": {"g": (-.26, -.18, 1.32), "y": (0, -.4, .9), "z": (-1, 0, 0)}, "l": {"g": (.24, -.2, 1.0), "y": (0, -.6, -.6), "z": (-.6, 0, -.2)},
          "shape": "fist", "pitch": 8}),
    (.4, {"r": {"g": (-.24, -.1, 1.95), "y": (0, -.1, 1), "z": (-1, 0, 0)}, "l": {"g": (.3, -.12, 1.06)}, "pitch": -10, "neck": -14}),
    (.8, {"r": {"g": (-.24, -.1, 1.93)}, "pitch": -9, "neck": -12}),
]}
SUMMON = {"duration": 1.5, "kneel": .4, "down": (.0, .3), "touch": .34, "rise": (.42, .72), "release": .62, "stand": (.7, 1.0),
          "ground": (.34, -.34, .12), "risen": (.18, -.42, 1.3), "step": .5}
CALL = {"duration": 1.2, "release": .42, "keys": [
    (.3, {"l": {"g": (.04, -.16, 1.52), "y": (-.3, -.2, .9), "z": (-.6, -.7, 0)}, "shape": "point", "pitch": -4}),
    (.42, {"l": {"g": (.04, -.16, 1.53)}, "pitch": -6}),
    (.62, {"l": {"g": (.3, -.56, 1.36), "y": (.2, -.9, .2), "z": (0, 0, 1)}, "shape": "open", "yaw": 6}),
    (.78, {"l": {"g": (.16, -.32, 1.3), "y": (0, -.4, .9), "z": (0, .2, 1)}, "yaw": 2}),
]}
WALL = {"duration": 1.0, "release": .66, "keys": [
    (.3, {"l": {"g": (.18, -.42, .98), "y": (0, -.9, .1), "z": (0, 0, 1)}, "r": {"g": (-.22, -.32, .98)}, "shape": "open", "pitch": 14}),
    (.66, {"l": {"g": (.18, -.42, 1.56), "y": (0, -.5, .8), "z": (0, -.2, 1)}, "r": {"g": (-.24, -.32, 1.3)}, "pitch": -6}),
    (.82, {"l": {"g": (.18, -.42, 1.52)}, "pitch": -5}),
]}
INTERRUPTED = {"duration": .4, "keys": [
    (.25, {"l": {"g": (.26, -.1, 1.38), "y": (.3, 0, 1), "z": (0, -1, 0)}, "r": {"g": (-.24, -.18, 1.08)}, "shape": "open",
           "pitch": -12, "yaw": 6, "neck": -8}),
]}
# The two-handed staff strikes: the right hand forward on the grip, the left hand behind it on the shaft toward the head
# (``LEFT_ON_SHAFT`` metres), the staff's foot leading. ``y`` points from the right hand to the head.
LEFT_ON_SHAFT = .42
STAFF_GUARD = {"g": (-.12, -.36, 1.04), "y": (.55, .55, .62), "z": (-.4, -.6, .3)}
JAB = {"duration": .7, "release": .46, "keys": [
    (0.16, {"r": STAFF_GUARD, "yaw": 16}),
    (.3, {"r": {"g": (-.1, -.22, 1.08), "y": (.5, .7, .5)}, "yaw": 22}),
    (.46, {"r": {"g": (-.06, -.6, 1.12), "y": (.3, .9, .3)}, "yaw": -6, "pitch": 8}),
    (.64, {"r": {"g": (-.08, -.52, 1.1)}, "yaw": -2, "pitch": 6}),
    (.84, {"r": STAFF_GUARD, "yaw": 16}),
]}
SWEEP = {"duration": .7, "release": .5, "keys": [
    (.16, {"r": STAFF_GUARD, "yaw": 16}),
    (.32, {"r": {"g": (-.3, -.12, 1.0), "y": (.75, .35, .55), "z": (-.3, -.7, .3)}, "yaw": -30}),
    (.5, {"r": {"g": (-.02, -.46, 1.0), "y": (-.1, .9, .45), "z": (.4, -.6, .4)}, "yaw": 10, "pitch": 8}),
    (.66, {"r": {"g": (.18, -.32, 1.02), "y": (-.75, .45, .5), "z": (.5, -.5, .4)}, "yaw": 34, "pitch": 6}),
    (.86, {"r": STAFF_GUARD, "yaw": 16}),
]}
# The mace blows (``hand_r.weapon``: the haft ``y`` toward the head, the edge hint ``z``).
MACE_A = {"duration": .7, "release": .5, "keys": [
    (.3, {"r": {"g": (-.26, .02, 1.6), "y": (.1, .7, .6), "z": (-1, 0, 0)}, "l": {"g": (.24, -.32, 1.18), "y": (0, -.8, .4), "z": (-.6, -.3, -.4)},
          "shape": "fist", "yaw": -18, "pitch": -4}),
    (.5, {"r": {"g": (-.12, -.56, 1.2), "y": (.05, -.9, -.3), "z": (-1, 0, 0)}, "l": {"g": (.24, -.12, 1.08)}, "yaw": 14, "pitch": 14}),
    (.68, {"r": {"g": (-.04, -.42, .98), "y": (.1, -.4, -.9)}, "yaw": 18, "pitch": 16}),
]}
MACE_B = {"duration": .7, "release": .5, "keys": [
    (.3, {"r": {"g": (.16, -.22, 1.4), "y": (.6, .3, .7), "z": (0, -1, 0)}, "l": {"g": (.28, -.06, 1.08), "y": (0, -.8, -.4), "z": (-.6, 0, -.4)},
          "shape": "fist", "yaw": 26}),
    (.5, {"r": {"g": (-.22, -.56, 1.3), "y": (-.6, -.8, .1), "z": (0, 1, 0)}, "yaw": -10, "pitch": 6}),
    (.68, {"r": {"g": (-.42, -.28, 1.24), "y": (-.9, .3, .1)}, "yaw": -22, "pitch": 4}),
]}
# Which socket each hand keys per clip (staff and palm unless named).
RIGHT_WEAPON = {"Warcry", "Mace_Swing_A", "Mace_Swing_B"}
STRIKES = {"Staff_Strike_A": JAB, "Staff_Strike_B": SWEEP}
ONE_SHOTS = {"Cast_Release_Push": PUSH, "Cast_Release_Overhand": OVERHAND, "Cast_Cone": CONE, "Cast_Curse_Point": CURSE,
             "Cast_Ground_Sweep": GROUND, "Cast_Self_Ward": WARD, "Cast_Ally": ALLY, "Warcry": WARCRY, "Cast_Summon_Call": CALL,
             "Mace_Swing_A": MACE_A, "Mace_Swing_B": MACE_B, "Cast_Raise_Wall": WALL, "Cast_Interrupted": INTERRUPTED, **STRIKES}
FROM_CHARGE = {"Cast_Release_Push", "Cast_Release_Overhand", "Cast_Interrupted"}
LOOPS = {"Cast_Channel_Beam_Loop": BEAM, "Cast_Channel_Drain_Loop": DRAIN, "Cast_Channel_Sky_Loop": SKY}
FULL_BODY = {"Cast_Nova", "Cast_Summon_Raise"}
# Where each clip's effect starts: the staff's head ("staff") or the left palm ("palm").
CHANNEL = {"Cast_Charge_Loop": "palm", "Cast_Release_Push": "palm", "Cast_Release_Overhand": "palm", "Cast_Channel_Beam_Loop": "staff",
           "Cast_Channel_Drain_Loop": "palm", "Cast_Channel_Sky_Loop": "staff", "Cast_Nova": "staffFoot", "Cast_Cone": "palm",
           "Cast_Curse_Point": "palm", "Cast_Ground_Sweep": "palm", "Cast_Ally": "palm", "Cast_Raise_Wall": "palm",
           "Cast_Summon_Raise": "palm"}
CLIPS = ("Cast_Charge_Loop", "Cast_Release_Push", "Cast_Release_Overhand", "Cast_Channel_Beam_Loop", "Cast_Channel_Drain_Loop",
         "Cast_Channel_Sky_Loop", "Cast_Nova", "Cast_Cone", "Cast_Curse_Point", "Cast_Ground_Sweep", "Cast_Self_Ward", "Cast_Ally",
         "Warcry", "Cast_Summon_Raise", "Cast_Summon_Call", "Staff_Strike_A", "Staff_Strike_B", "Mace_Swing_A", "Mace_Swing_B",
         "Cast_Raise_Wall", "Cast_Interrupted")
# The #391 chain joints the kneel's secondaryPose keys, and how far the panels follow the thighs (as the traversal
# clips, #443). The kneel lifts the front thigh level, so the front panel follows further than in the traversal clips
# (share .45, at most 40 degrees) to stay over the knee; past the knee the front and side panels hang plumb
# over the shin.
CAPE = "cape_01"
SWING = {"share": .7, "front": 70.0, "sideShare": .8, "side": 75.0, "back": 20.0}
BACK = Vector((0, 1, 0))


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets", "staff"}:
        raise ValueError("cast clips require exactly schemaVersion, clips, sockets and staff")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"cast clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"cast clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    staff = p["staff"]
    if type(staff) is not dict or set(staff) != {"length", "footLength"} or not 0 < staff["footLength"] < staff["length"]:
        raise ValueError("staff needs length and footLength (the grip's height above the foot)")
    if set(inputs) != {"target"}:
        raise ValueError("cast clips take exactly the declared input target")


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


class Rig:
    def __init__(self, rig, sockets, rest_gltf):
        self.rig = rig
        self.bones = rig.pose.bones
        self.rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}
        self.rest_gltf = rest_gltf
        # The socket frame in its joint's bone frame: the frame in armature space is the bone matrix times this.
        self.socket = {}
        for name, s in sockets.items():
            joint, r = s["joint"], s["rotation"]
            local = Matrix.LocRotScale(Vector(s["translation"]), Quaternion((r[3], r[0], r[1], r[2])), Vector((1, 1, 1)))
            self.socket[name] = (joint, self.rest[joint].inverted() @ C4 @ rest_gltf[joint] @ local)
        # The palms: at the wrist, +Y along the hand toward the fingers, +Z out of the palm (down in the rest T-pose).
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
    """The finger poses: the seed's, and each casting shape keyed on top of the rest pose (local, so they hold in every
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
    """Both hands' frames, the chest turn and the left hand's shape through ``keys`` ((fraction, key) pairs), from the
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

    def shape_at(self, u):
        shapes, held = [], "seed"
        for key in self.keys:
            held = key.get("shape", held)
            shapes.append(held)
        i = max(k for k in range(len(self.times) - 1) if self.times[k] <= min(u, .999999))
        return shapes[i], shapes[i + 1], smooth((u - self.times[i]) / (self.times[i + 1] - self.times[i]))

    def at(self, u):
        frames = {}
        for side in "rl":
            g, y, z = (catmull(self.track(side, f), self.times, u) for f in "gyz")
            frames[side] = frame_of(g, y, z)
        chest = {name: catmull(self.scalars(name), self.times, u).x for name in ("yaw", "pitch", "roll", "neck")}
        return frames, chest, self.shape_at(u)


def key_of(frame):
    return {"g": tuple(frame.translation), "y": tuple(frame.to_3x3().col[1]), "z": tuple(frame.to_3x3().col[2])}


class Caster:
    """The clip-independent state: the seed pose, the hands' sockets, their seed frames and the finger shapes."""

    def __init__(self, rig, seed, clip):
        self.rig, self.seed = rig, seed
        self.sockets = {"r": "weapon" if clip in RIGHT_WEAPON else "staff", "l": "staffLeft" if clip in STRIKES else "palm_l"}
        rig.apply(seed)
        self.start = {"r": key_of(rig.grip(self.sockets["r"])), "l": key_of(rig.grip("palm_l"))}
        self.hands = Hands(rig, seed)

    def seed_key(self):
        return {"r": dict(self.start["r"]), "l": dict(self.start["l"]), "shape": "seed"}

    def pose(self, frames, chest, shape, body=None, gaze=.5):
        rig = self.rig
        rig.apply(self.seed)
        if body:
            body()
        turn_chest(rig, chest.get("yaw", 0.0), chest.get("pitch", 0.0), chest.get("roll", 0.0), chest.get("neck", 0.0), gaze)
        place_grip(rig, self.sockets["r"], frames["r"], POLE["r"])
        if self.sockets["l"] == "staffLeft":
            # The left hand on the shaft, toward the head from the right hand's grip.
            right = frames["r"]
            shaft = right.to_3x3().col[1].normalized()
            back = right.to_3x3().col[2]
            place_grip(rig, "staffLeft", frame_of(right.translation + shaft * LEFT_ON_SHAFT, shaft, Vector((-back.x, back.y, back.z))), POLE["l"])
        else:
            place_grip(rig, "palm_l", frames["l"], POLE["l"])
        rig.apply(self.hands.blend("l", *shape))
        return rig.capture()


def keyed(caster, spec, start, end, body=None):
    motion = Motion(start, spec["keys"], end)
    frames = int(round(spec["duration"] * FPS))
    poses = []
    for k in range(frames + 1):
        u = k / frames
        poses.append(caster.pose(*motion.at(u), body=(lambda: body(u)) if body else None))
    return poses


def charge_key():
    return {"r": dict(CHARGE["r"]), "l": dict(CHARGE["l"]), "shape": CHARGE["shape"], "pitch": CHARGE["pitch"]}


def held(spec):
    return {"r": spec["r"], "l": spec["l"], "shape": spec["shape"],
            **{name: spec[name] for name in ("yaw", "pitch", "roll", "neck") if name in spec}}


def loop(caster, spec, offsets):
    """A held pose moving through a loop: ``offsets(phase)`` gives each hand's offset and the chest's turn on top."""
    base = held(spec)
    frames = int(round(spec["duration"] * FPS))
    poses = []
    for k in range(frames + 1):
        phase = 2 * math.pi * (k % frames) / frames
        moves, turn = offsets(phase)
        out = {}
        for side in "rl":
            key = base[side]
            out[side] = frame_of(v(key["g"]) + moves.get(side, Vector()), v(key["y"]), v(key["z"]))
        chest = {name: base.get(name, 0.0) + turn.get(name, 0.0) for name in ("yaw", "pitch", "roll", "neck")}
        poses.append(caster.pose(out, chest, (spec["shape"], spec["shape"], 1.0)))
    return poses


def charge_loop(caster):
    spec = {**CHARGE, "duration": CHARGE_LOOP["duration"]}
    radius, bob, sway = CHARGE_LOOP["circle"], CHARGE_LOOP["bob"], CHARGE_LOOP["sway"]
    return loop(caster, spec, lambda p: (
        {"l": Vector((radius * math.sin(p), -radius * .5 * math.sin(2 * p), radius * (1 - math.cos(p)) * .8)),
         "r": Vector((0, 0, bob * math.sin(p)))},
        {"yaw": sway * math.sin(p)}))


def beam_loop(caster):
    t, push = BEAM["tremble"], BEAM["push"]
    return loop(caster, BEAM, lambda p: (
        {"r": Vector((t * math.sin(3 * p), -push * (1 - math.cos(p)) * .5, t * math.sin(5 * p))),
         "l": Vector((t * math.sin(4 * p), -push * (1 - math.cos(p)) * .5, t * math.cos(3 * p) - t))},
        {"pitch": 1.5 * math.sin(p)}))


def drain_loop(caster):
    n, pull = DRAIN["pulls"], DRAIN["pull"]
    return loop(caster, DRAIN, lambda p: (
        {"l": Vector((0, pull * .5 * (1 - math.cos(n * p)), -.02 * (1 - math.cos(n * p)))),
         "r": Vector((0, 0, .008 * math.sin(n * p)))},
        {"pitch": -3 * (1 - math.cos(n * p)) * .5, "yaw": -2 * (1 - math.cos(n * p)) * .5}))


def sky_loop(caster):
    radius = SKY["circle"]
    return loop(caster, SKY, lambda p: (
        {"r": Vector((radius * math.sin(p), radius * math.cos(p) - radius, .01 * math.sin(2 * p))),
         "l": Vector((.015 * math.sin(p + 1), 0, .015 * math.sin(2 * p)))},
        {"yaw": 2 * math.sin(p)}))


def plant_feet(rig, feet):
    """Put each ankle back on its planted position and orientation, the knee towards its planted direction."""
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


def nova(caster):
    """The staff lifted and stamped down beside the right foot, its foot on the ground at ``release``; the knees bend
    into the stamp (the feet stay planted) and the left arm sweeps out low."""
    rig = caster.rig
    rig.apply(caster.seed)
    feet = feet_of(rig)
    spec = NOVA

    def body(u):
        dip = window(u, spec["release"] - .2, spec["release"]) * (1 - window(u, spec["release"] + .12, 1.0))
        move_pelvis(rig, Vector((0, .02 * dip, -spec["drop"] * dip)))
        plant_feet(rig, feet)

    return keyed(caster, spec, caster.seed_key(), caster.seed_key(), body)


def summon_raise(caster):
    """Kneel on the right knee with the staff planted, the left palm down on the ground; the palm turns up and rises
    (the summon at ``release``) while the caster stands back up. The left foot steps ``step`` forward (#443): far
    enough that the front thigh slopes down to the knee and the shin slants forward under the robe's front, where a
    level thigh would lift the robe off the shin."""
    rig, spec = caster.rig, SUMMON
    rig.apply(caster.seed)
    feet = feet_of(rig)
    left_ankle, left_matrix, _ = feet["l"]
    right_ankle, right_matrix, _ = feet["r"]
    d0, d1 = spec["down"]
    s0, s1 = spec["stand"]
    start = caster.seed_key()
    kneel_staff = {"g": (-.3, -.3, .62), "y": (.05, -.1, 1), "z": (-.7, -.7, 0)}
    ground = {"g": spec["ground"], "y": (0, -.9, -.1), "z": (0, 0, -1)}
    motion = Motion(start, [
        (spec["touch"], {"r": kneel_staff, "l": ground, "shape": "open", "pitch": 46}),
        (spec["rise"][0], {"l": {"g": tuple(v(spec["ground"]) + Vector((0, 0, .03))), "y": (0, -.9, .2), "z": (0, -.1, 1)}, "pitch": 42}),
        (spec["rise"][1], {"r": {"g": (-.26, -.3, .9)}, "l": {"g": spec["risen"], "y": (0, -.5, .8), "z": (0, -.2, 1)}, "pitch": 4, "neck": -8}),
        (.86, {"r": {"g": (-.24, -.28, 1.0)}, "l": {"g": (.2, -.4, 1.28)}, "pitch": 0, "neck": -4}),
    ], caster.seed_key())
    frames = int(round(spec["duration"] * FPS))
    poses, chains = [], {}
    for k in range(frames + 1):
        u = k / frames
        down = window(u, d0, d1) * (1 - window(u, s0, s1))

        def body(down=down):
            move_pelvis(rig, Vector((0, .1 * down, -spec["kneel"] * down)))
            la = left_ankle + Vector((0, -spec["step"], 0)) * window(down, .0, .6)
            ra = right_ankle + Vector((0, .3, .06)) * window(down, .2, 1.0)
            plant_feet(rig, {"l": (la, left_matrix, Vector((0, -1, .2))), "r": (ra, right_matrix, Vector((0, -.6, -1)))})
            if down > 1e-3:
                rotate_world(rig, "foot_r", X, -50 * window(down, .2, 1.0))

        frames_now, chest, shape = motion.at(u)
        chest["pitch"] = chest["pitch"] * max(down, window(u, 0, spec["touch"]) * (1 - window(u, s0, s1)))
        poses.append(caster.pose(frames_now, chest, shape, body=body, gaze=.3))
        for joint, rotation in secondary(rig).items():
            chains.setdefault(joint, []).append(rotation)
    observations = {"kneelSeconds": [round(d1 * spec["duration"], 4), round(s0 * spec["duration"], 4)],
                    "secondaryPose": {"sampleRate": FPS, "joints": chains}}
    return poses, observations


def secondary(rig):
    """The #391 chain pose of this frame (as adapters/blender/traversal_clips.py, without a face): per chain joint it
    keys, its local rotation (glTF xyzw) under its parent (``pelvis``, ``spine_03`` for ``cape_01``, the joint above
    for the plumb joints). The front panel rides the higher thigh, each side panel follows its own thigh out and
    forward, and past the knee both hang plumb over the shin; the back panel and the cape hang but never pass
    into the legs or the back."""
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
    out, swings = {}, {}
    for joint, direction in directions.items():
        parent = "spine_03" if joint == CAPE else "pelvis"
        delta = (rig.bones[parent].matrix.to_3x3() @ rig.rest[parent].to_3x3().inverted())
        parent_world = gltf(delta) @ rig.rest_gltf[parent].to_3x3()
        swings[joint] = gltf(down.rotation_difference(direction).to_matrix())
        out[joint] = (parent_world.inverted() @ swings[joint]).to_quaternion()
    # The chain joints rest with no rotation in the world, so a joint hanging plumb under a turned first joint (the
    # joints between keep its turn) takes its inverse turn: the front panel from its third joint, past the knee.
    for joint in ("skirt_f_03", "skirt_l_02", "skirt_r_02"):
        out[joint] = swings[joint[:-2] + "01"].inverted().to_quaternion()
    return {joint: [round(q.x, 5), round(q.y, 5), round(q.z, 5), round(q.w, 5)] for joint, q in out.items()}


def upper_joints(rig):
    return [UPPER_ROOT, *(bone.name for bone in rig.rig.data.bones[UPPER_ROOT].children_recursive)]


def channel_of(rig, clip, staff):
    where = CHANNEL.get(clip)
    if where is None:
        return {}
    if where == "palm":
        # The middle of the palm: 4.5 cm along the hand, 2 cm out of the palm.
        joint, point = rig.point_in_joint("palm_l", (0, .045, .02))
    elif where == "staff":
        joint, point = rig.point_in_joint("staff", (0, staff["length"] - staff["footLength"], 0))
    else:
        joint, point = rig.point_in_joint("staff", (0, -staff["footLength"], 0))
    return {"channelJoint": joint, "channelPoint": point}


def author(rig, clip, actions, staff):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    seed = sample(rig, actions[STAND], 0.0)
    caster = Caster(rig, seed, clip)
    observations = {}
    if clip == "Cast_Charge_Loop":
        poses = charge_loop(caster)
    elif clip in LOOPS:
        poses = {"Cast_Channel_Beam_Loop": beam_loop, "Cast_Channel_Drain_Loop": drain_loop, "Cast_Channel_Sky_Loop": sky_loop}[clip](caster)
        if clip == "Cast_Channel_Drain_Loop":
            observations["pulseSeconds"] = [round(DRAIN["duration"] * (k + .5) / DRAIN["pulls"], 4) for k in range(DRAIN["pulls"])]
    elif clip == "Cast_Nova":
        poses = nova(caster)
        observations["releaseSeconds"] = round(NOVA["release"] * NOVA["duration"], 4)
    elif clip == "Cast_Summon_Raise":
        poses, observations = summon_raise(caster)
        observations["releaseSeconds"] = round(SUMMON["release"] * SUMMON["duration"], 4)
    else:
        spec = ONE_SHOTS[clip]
        start = charge_key() if clip in FROM_CHARGE else caster.seed_key()
        poses = keyed(caster, spec, start, caster.seed_key())
        if "release" in spec:
            observations["releaseSeconds"] = round(spec["release"] * spec["duration"], 4)
        if clip in FROM_CHARGE:
            observations["startsFrom"] = "Cast_Charge_Loop"
        if clip == "Cast_Cone":
            observations["sweepSeconds"] = [round(t * CONE["duration"], 4) for t in CONE["sweep"]]
    observations.update(channel_of(rig, clip, staff))
    return poses, {"source": STAND, "durationSeconds": round((len(poses) - 1) / FPS, 4), **observations,
                   **({} if clip in FULL_BODY else {"layer": UPPER_ROOT, "joints": upper_joints(rig)})}


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
        authored[clip] = author(Rig(rig_object, arguments["sockets"], rest_gltf), clip, actions, arguments["staff"])
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
    return {"recipe": "cast-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
