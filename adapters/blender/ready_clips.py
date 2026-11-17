"""Original draw, sheathe, combat idle and guard clips per weapon family, authored on the Ranger rig in Blender (#717: the
game draws and sheathes as an explicit mode, so every weapon family moves its item between a stow socket and the hand,
idles alive in the fight and holds a guard).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit hand frames solved with two-bone arm IK on top of
the ``Idle_Loop`` pose: its first pose for the draws and sheathes, the whole loop resampled to the clip for the combat
idles and guards. No source motion is copied beyond those base poses. Every clip keeps only the ``spine_01`` subtree, so
the game plays it over any lower body (#422).

- A family holds its item in one hand socket (``FAMILIES[...]["socket"]``: ``hand_r.weapon``, ``hand_r.staff`` or, for
  the bow, ``hand_l.bow``) and stows it on one socket (``stow``: ``hip_l.stowed``, ``hip_r.stowed``, ``back.stowed`` or
  ``back.bow.stowed``). A key names a hand's frame either explicitly (the grip ``g``, the item's +Y ``b`` and a hint
  for its +X ``x`` or +Z ``z``) or as the stow socket's frame (``stow``), moved ``pull`` metres along the way the item
  leaves it (``-Y`` out of a hip scabbard, ``+Z`` off the back). Between keys the grip follows a Hermite curve and the
  rotation turns at an eased rate; a hand whose key is ``None`` falls back to the idle's arm.
- A draw reaches the stow socket open-handed, closes on the item there and pulls it out into the family's ready pose; a
  sheathe is the reverse and lets go at the socket. ``swapSeconds`` is that frame: the hand socket's frame is the stow
  socket's (``swapGapMeters`` records how far apart their origins still are), so the game moves the item between the
  sockets there without a jump. Long items join the second hand on the shaft (``hand_l.staff``) once they are in front.
- The combat idles (``*_Idle_Loop``, 3 s) and guards (``*_Guard_Loop``, 2 s) hold the family's ready or guard pose over
  the breathing ``Idle_Loop``, with a sway, a bob and a slow turn of the weapon that close on themselves. A guard is
  tighter and higher than its idle. The draw ends in the family's idle pose and the sheathe starts there.

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
POLE = {"r": Vector((-.8, .35, -.5)), "l": Vector((.8, .35, -.5))}
# Over the shoulder (the back draws): the elbow rises out to the side.
OVER = {"r": Vector((-.6, .2, .9)), "l": Vector((.6, .2, .9))}
FINGERS = ("index", "middle", "ring", "pinky", "thumb")
SOCKETS = ("weapon", "offhand", "shield", "staff", "staffLeft", "bow", "hipL", "hipR", "back", "backBow")
SOCKET_IDS = {"weapon": "hand_r.weapon", "offhand": "hand_l.weapon", "shield": "hand_l.shield", "staff": "hand_r.staff",
              "staffLeft": "hand_l.staff", "bow": "hand_l.bow", "hipL": "hip_l.stowed", "hipR": "hip_r.stowed",
              "back": "back.stowed", "backBow": "back.bow.stowed"}
# The hand shapes (as the strike clips): degrees per finger joint toward the palm, and a spread per finger.
SHAPES = {
    "open": {"curl": {"index": (4, 6, 4), "middle": (5, 6, 4), "ring": (6, 8, 5), "pinky": (7, 9, 5), "thumb": (2, 4, 4)},
             "spread": {"pinky": 8, "index": -4}},
    "grip": {"curl": {"index": (50, 70, 45), "middle": (52, 72, 46), "ring": (54, 72, 46), "pinky": (56, 74, 48), "thumb": (25, 35, 30)},
             "spread": {}},
    "fist": {"curl": {"index": (80, 95, 60), "middle": (82, 95, 60), "ring": (84, 95, 60), "pinky": (86, 95, 60), "thumb": (30, 40, 35)},
             "spread": {}},
}
PALM = Vector((0, .05, .02))

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up; metres (the pelvis stands at about z 0.91,
# the shoulders at 1.43). A positive yaw turns the chest to the figure's left; a positive pitch bends it forward; a
# positive roll leans it to its left; a positive neck tips the head down.
#
# A hand key: ``s`` the hand socket (or ``palm_l``/``palm_r`` for an empty fist, ``shaft`` for the second hand on a
# long item), then ``g`` with ``b`` and ``x`` or ``z``, or ``stow`` (a socket name) with ``pull``; ``pole`` bends the
# elbow (``OVER`` above the shoulder); ``shape`` the hand (``grip`` by default, ``fist`` for a palm, ``open`` while it
# reaches).
SHIELD_GUARD = {"s": "shield", "g": (.1, -.36, 1.22), "b": (.05, 0, 1), "z": (-.15, -1, .05)}
FIST_L = {"s": "palm_l", "g": (.22, -.26, 1.14), "b": (-.3, -.6, .6), "x": (0, 0, -1), "shape": "fist"}
FIST_R = {"s": "palm_r", "g": (-.22, -.26, 1.14), "b": (.3, -.6, .6), "x": (0, 0, -1), "shape": "fist"}
DAGGER_R = {"s": "weapon", "g": (-.2, -.34, 1.06), "b": (.12, -.85, .5), "x": (0, 0, -1)}
DAGGER_L = {"s": "offhand", "g": (.17, -.32, 1.2), "b": (-.12, -.8, .6), "x": (0, 0, -1)}


def fist(side, g, b, x=(0, 0, -1)):
    """An empty fist at ``g``, the forearm along ``b``, the elbow tucked down."""
    return {"s": f"palm_{side}", "g": g, "b": b, "x": x, "shape": "fist", "pole": (.3 if side == "l" else -.3, .1, -1)}


# The families: the hand socket that holds the item, the stow socket, the item, the hand that draws it, which way it
# leaves the stow socket and how far, the second hand on a long item (metres up the shaft from the first, as the strike
# clips' ``range``), and the poses: ``idle`` (where the draw ends) and ``guard``, each a right key ``r``, a left key
# ``l`` and the chest.
FAMILIES = {
    "sword": {"item": "equipment.sword.arming", "socket": "weapon", "stow": "hipL", "hand": "r", "pull": ("-y", .62),
              "idle": {"r": {"s": "weapon", "g": (-.18, -.3, 1.08), "b": (.18, -.6, .78), "x": (-.1, -.7, -.3)},
                       "l": SHIELD_GUARD, "pitch": 6}},
    "mace": {"item": "equipment.mace.flanged", "socket": "weapon", "stow": "hipR", "hand": "r", "pull": ("-y", .36),
             "idle": {"r": {"s": "weapon", "g": (-.22, -.26, 1.06), "b": (-.02, -.35, .94), "x": (-.3, -.7, -.2)},
                      "l": FIST_L, "pitch": 5},
             "guard": {"r": {"s": "weapon", "g": (-.15, -.36, 1.24), "b": (.42, -.2, .88), "x": (0, -1, 0)},
                       "l": fist("l", (.15, -.38, 1.3), (-.25, -.5, .8)), "pitch": 9, "yaw": -6, "neck": 4}},
    "dagger": {"item": "equipment.dagger.blackened", "socket": "weapon", "stow": "hipR", "hand": "r", "pull": ("-y", .26),
               "idle": {"r": DAGGER_R, "l": DAGGER_L, "pitch": 10},
               "guard": {"r": {"s": "weapon", "g": (-.13, -.4, 1.18), "b": (.15, -.9, .4), "x": (0, 0, -1)},
                         "l": {"s": "offhand", "g": (.1, -.3, 1.3), "b": (-.45, -.55, .7), "x": (0, -.4, -1)},
                         "pitch": 14, "yaw": -10, "neck": 6}},
    "staff": {"item": "equipment.staff.quarter", "socket": "staff", "stow": "back", "hand": "r", "pull": ("+z", .16),
              "shaft": (.35, .7),
              "idle": {"r": {"s": "staff", "g": (-.2, -.2, 1.0), "b": (.45, -.25, .86), "z": (-.4, -.6, .3)}, "l": "shaft", "pitch": 4},
              "guard": {"r": {"s": "staff", "g": (-.22, -.34, 1.12), "b": (.9, -.15, .4), "z": (0, -.6, .8)}, "l": "shaft",
                        "pitch": 10, "yaw": 8, "neck": 4}},
    "spear": {"item": "equipment.spear.leaf", "socket": "staff", "stow": "back", "hand": "r", "pull": ("+z", .16),
              "shaft": (.2, .6),
              "idle": {"r": {"s": "staff", "g": (-.18, -.14, 1.02), "b": (.12, -.6, .79), "z": (-.4, -.6, .3)}, "l": "shaft", "pitch": 4},
              "guard": {"r": {"s": "staff", "g": (-.15, .04, 1.1), "b": (.18, -.95, .22), "z": (-.4, -.6, .3)}, "l": "shaft",
                        "pitch": 10, "yaw": -12, "neck": 4}},
    # The maul's left hand stays on its ``grip.offhand``, 0.22 m down the haft (as the #711 maul strikes).
    "two-hand": {"item": "equipment.warhammer.maul", "socket": "weapon", "stow": "back", "hand": "r", "pull": ("+z", .16),
                 "shaft": (-.22, -.22),
                 "idle": {"r": {"s": "weapon", "g": (-.16, -.24, 1.18), "b": (-.06, .68, .73), "x": (0, -1, 0)}, "l": "shaft",
                          "pitch": 3},
                 "guard": {"r": {"s": "weapon", "g": (-.12, -.36, 1.12), "b": (.12, -.45, .88), "x": (-.2, -.3, .9)}, "l": "shaft",
                          "pitch": 10, "yaw": -6, "neck": 4}},
    "bow": {"item": "equipment.bow.long", "socket": "bow", "stow": "backBow", "hand": "l", "pull": ("+z", .14),
            "idle": {"l": {"s": "bow", "g": (.24, -.2, 1.0), "b": (.12, -.35, .93), "z": (-.3, -.95, 0)}, "r": None, "pitch": 3}},
    "unarmed": {"item": None, "socket": None, "stow": None, "hand": None,
                "idle": {"r": fist("r", (-.17, -.3, 1.24), (.25, -.45, .86)), "l": fist("l", (.16, -.34, 1.3), (-.25, -.45, .86)),
                         "pitch": 6, "yaw": -6},
                "guard": {"r": fist("r", (-.11, -.3, 1.42), (.3, -.25, .92)), "l": fist("l", (.11, -.34, 1.46), (-.3, -.25, .92)),
                          "pitch": 10, "yaw": -4, "neck": 8}},
}
# The draws (about 0.7 s) and sheathes (about 0.8 s): (fraction, key) pairs over the drawing hand ``h``, the other
# hand ``o`` and the chest. ``"stow"`` is the stow socket's frame, ``("pull", d)`` that frame moved d of the family's
# pull out of it, ``"idle"`` the family's idle key; ``None`` lets the hand hang. ``swap`` is the key the item changes
# socket at; an ``over`` key passes the hand above the shoulder (``g``, ``b`` and ``z`` given per family below).
HIP_DRAW = [
    (0.0, {"h": None, "o": None}),
    (.3, {"h": ("stow", 0, "open"), "o": None, "yaw": 10, "pitch": 8}),
    (.38, {"h": ("stow", 0, "grip"), "swap": True}),
    (.58, {"h": ("pull", 1.0)}),
    (.84, {"h": "idle", "o": "idle"}),
    (1.0, {"h": "idle", "o": "idle"}),
]
HIP_SHEATHE = [
    (0.0, {"h": "idle", "o": "idle"}),
    (.32, {"h": ("pull", 1.0), "o": None, "yaw": 8, "pitch": 10}),
    (.56, {"h": ("stow", 0, "grip"), "yaw": 10, "pitch": 8, "swap": True}),
    (.64, {"h": ("stow", 0, "open")}),
    (1.0, {"h": None, "o": None}),
]
BACK_DRAW = [
    (0.0, {"h": None, "o": None}),
    (.32, {"h": ("stow", 0, "open"), "o": None, "yaw": 6, "pitch": -4, "neck": -2}),
    (.4, {"h": ("stow", 0, "grip"), "swap": True}),
    (.52, {"h": ("pull", 1.0)}),
    (.68, {"h": "over"}),
    (.86, {"h": "idle", "o": "idle"}),
    (1.0, {"h": "idle", "o": "idle"}),
]
BACK_SHEATHE = [
    (0.0, {"h": "idle", "o": "idle"}),
    (.26, {"h": "over", "o": None}),
    (.44, {"h": ("pull", 1.0), "yaw": 6, "pitch": -4, "neck": -2}),
    (.6, {"h": ("stow", 0, "grip"), "yaw": 6, "pitch": -4, "neck": -2, "swap": True}),
    (.68, {"h": ("stow", 0, "open")}),
    (1.0, {"h": None, "o": None}),
]
# The hand above its shoulder on the way to or from the back, the item's foot or blade still behind it.
OVER_KEY = {
    "staff": {"g": (-.2, -.08, 1.62), "b": (.55, -.35, .76), "z": (-.6, -.4, .3)},
    "spear": {"g": (-.2, -.08, 1.62), "b": (.2, -.75, .6), "z": (-.6, -.4, .3)},
    "two-hand": {"g": (-.22, -.06, 1.6), "b": (-.05, -.3, .95), "x": (-.2, -.9, .2)},
    "bow": {"g": (.22, -.1, 1.6), "b": (.3, -.35, .88), "z": (-.3, -.95, 0)},
}
ONE_SHOTS = {
    "Sword_Draw": ("sword", HIP_DRAW, .7), "Sword_Sheathe": ("sword", HIP_SHEATHE, .8),
    "Mace_Draw": ("mace", HIP_DRAW, .7), "Mace_Sheathe": ("mace", HIP_SHEATHE, .8),
    "Dagger_Draw": ("dagger", HIP_DRAW, .6), "Dagger_Sheathe": ("dagger", HIP_SHEATHE, .7),
    "Staff_Draw": ("staff", BACK_DRAW, .8), "Staff_Sheathe": ("staff", BACK_SHEATHE, .8),
    "Spear_Draw": ("spear", BACK_DRAW, .8), "Spear_Sheathe": ("spear", BACK_SHEATHE, .8),
    "TwoHand_Draw": ("two-hand", BACK_DRAW, .8), "TwoHand_Sheathe": ("two-hand", BACK_SHEATHE, .8),
    "Bow_Draw_Weapon": ("bow", BACK_DRAW, .7), "Bow_Stow": ("bow", BACK_SHEATHE, .7),
}
# The loops: the family, the pose, the length, and the motion that closes on itself: the chest's ``sway`` (yaw,
# degrees, once a loop) and ``breathe`` (pitch, twice), the hands' ``bob`` (metres up, twice, the off hand half a beat
# late) and ``turn`` (the item's tip circling, degrees, once).
LOOPS = {
    "Mace_Idle_Loop": ("mace", "idle", 3.0, {"sway": 4, "breathe": 1.5, "bob": .018, "turn": 6}),
    "Staff_Idle_Loop": ("staff", "idle", 3.0, {"sway": 4, "breathe": 1.5, "bob": .016, "turn": 4}),
    "Spear_Idle_Loop": ("spear", "idle", 3.0, {"sway": 4, "breathe": 1.5, "bob": .016, "turn": 3}),
    "TwoHand_Idle_Loop": ("two-hand", "idle", 3.0, {"sway": 4, "breathe": 1.5, "bob": .016, "turn": 4}),
    "Unarmed_Idle_Loop": ("unarmed", "idle", 3.0, {"sway": 5, "breathe": 2, "bob": .022, "turn": 0}),
    "Mace_Guard_Loop": ("mace", "guard", 2.0, {"sway": 2, "breathe": 1, "bob": .01, "turn": 3}),
    "Dagger_Guard_Loop": ("dagger", "guard", 2.0, {"sway": 3, "breathe": 1, "bob": .012, "turn": 5}),
    "Staff_Guard_Loop": ("staff", "guard", 2.0, {"sway": 2, "breathe": 1, "bob": .01, "turn": 2}),
    "Spear_Guard_Loop": ("spear", "guard", 2.0, {"sway": 2, "breathe": 1, "bob": .01, "turn": 2}),
    "TwoHand_Guard_Loop": ("two-hand", "guard", 2.0, {"sway": 2, "breathe": 1, "bob": .01, "turn": 2}),
    "Unarmed_Guard_Loop": ("unarmed", "guard", 2.0, {"sway": 3, "breathe": 1, "bob": .012, "turn": 0}),
}
CLIPS = (
    "Sword_Draw", "Sword_Sheathe", "Mace_Draw", "Mace_Sheathe", "Dagger_Draw", "Dagger_Sheathe", "Staff_Draw", "Staff_Sheathe",
    "Spear_Draw", "Spear_Sheathe", "TwoHand_Draw", "TwoHand_Sheathe", "Bow_Draw_Weapon", "Bow_Stow",
    "Mace_Idle_Loop", "Staff_Idle_Loop", "Spear_Idle_Loop", "TwoHand_Idle_Loop", "Unarmed_Idle_Loop",
    "Mace_Guard_Loop", "Dagger_Guard_Loop", "Staff_Guard_Loop", "Spear_Guard_Loop", "TwoHand_Guard_Loop", "Unarmed_Guard_Loop",
)


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets"}:
        raise ValueError("ready clips require exactly schemaVersion, clips and sockets")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"ready clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"ready clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    if set(inputs) != {"target"}:
        raise ValueError("ready clips take exactly the declared input target")


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


def item_frame(position, y_axis, x_hint):
    """A frame at ``position`` whose +Y is ``y_axis`` and +X as close to ``x_hint`` as it can be."""
    yy = y_axis.normalized()
    xx = x_hint - yy * x_hint.dot(yy)
    if xx.length < 1e-4:
        xx = (Vector((0, 0, 1)) if abs(yy.z) < .9 else Vector((1, 0, 0))).cross(yy)
    xx.normalize()
    m = Matrix((xx, yy, xx.cross(yy))).transposed().to_4x4()
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
        # The palms: at the wrist, +Y along the hand toward the fingers, +Z out of the palm (down in the rest T-pose),
        # offset to the middle of the palm so a fist key names where the fist is.
        for side in "lr":
            joint = f"hand_{side}"
            rest = self.rest[joint]
            palm = rest.inverted() @ frame_of(rest.translation, rest.to_3x3() @ Y, Vector((0, 0, -1)))
            self.socket[f"palm_{side}"] = (joint, palm @ Matrix.Translation(PALM))

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


def action_seconds(action):
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    return (action.frame_range[1] - action.frame_range[0]) / fps


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


def reach(rig, socket, frame, limit=25.0):
    """Roll the shoulder toward ``frame`` when the arm alone cannot reach it: the clavicle turns about its root by at
    most ``limit`` degrees, as far as the shortfall needs."""
    joint, local = rig.socket[socket]
    side = joint[-1]
    upper, lower, hand = ARMS[side]
    clavicle = f"clavicle_{side}"
    root, shoulder = rig.head(clavicle), rig.head(upper)
    wrist = (frame @ local.inverted()).translation
    short = (wrist - shoulder).length - (rig.length(upper, lower) + rig.length(lower, hand)) * .98
    a, b = shoulder - root, wrist - root
    if short <= 0 or a.cross(b).length < 1e-6:
        return
    angle = min(math.radians(limit), a.angle(b), math.asin(min(1.0, short / a.length)))
    rotate_world(rig, clavicle, a.cross(b).normalized(), math.degrees(angle), pivot=root)


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
    if yaw * gaze:
        rotate_world(rig, "neck_01", UP, -yaw * gaze)
    if pitch - 2 * neck:
        rotate_world(rig, "neck_01", X, -pitch * .5 + neck)


def blend(a, b, w):
    la, ra, _ = a.decompose()
    lb, rb, _ = b.decompose()
    return Matrix.LocRotScale(la.lerp(lb, w), ra.slerp(rb, w), Vector((1, 1, 1)))


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
        return {name: blend(self.shapes[side][a][name], self.shapes[side][b][name], u) for name in self.joints[side]}


def upper_joints(rig):
    return [UPPER_ROOT, *(bone.name for bone in rig.rig.data.bones[UPPER_ROOT].children_recursive)]


def frames_of(duration):
    return int(round(duration * FPS))


def arm_bones(side):
    return (f"clavicle_{side}", *ARMS[side])


# --- Keys ------------------------------------------------------------------------------------------------------------


def key_frame(key):
    """An explicit hand key's frame."""
    if "x" in key:
        return item_frame(v(key["g"]), v(key["b"]), v(key["x"]))
    return frame_of(v(key["g"]), v(key["b"]), v(key["z"]))


class Ready:
    """One family on the rig: its keys resolved to frames, the shaft hand and the finger shapes."""

    def __init__(self, rig, seed, family):
        self.rig, self.seed, self.name = rig, seed, family
        self.spec = FAMILIES[family]
        self.hands = Hands(rig, seed)

    def stow_frame(self, chest, pull):
        """The stow socket's frame (with the chest turned as at its key), moved ``pull`` of the family's way out."""
        rig = self.rig
        rig.apply(self.seed)
        turn_chest(rig, *chest)
        m = rig.grip(self.spec["stow"]).copy()
        axis, length = self.spec["pull"]
        way = {"-y": -m.to_3x3().col[1], "+z": m.to_3x3().col[2]}[axis].normalized()
        m.translation = m.translation + way * length * pull
        rig.apply(self.seed)
        return m

    def side_key(self, side, key, chest):
        """A hand key as (socket, frame, pole, shape), ``"shaft"`` for the second hand on a long item, or None."""
        if key is None:
            return None
        if key == "shaft":
            return "shaft"
        pole = POLE[side]
        if isinstance(key, tuple):
            kind, amount = key[0], key[1]
            shape = key[2] if len(key) > 2 else "grip"
            if self.spec["stow"] in ("back", "backBow"):
                pole = OVER[side]
            return (self.spec["socket"], self.stow_frame(chest, amount if kind == "pull" else 0.0), pole, shape)
        if key == "over":
            return (self.spec["socket"], key_frame(OVER_KEY[self.name]), OVER[side], "grip")
        return (key["s"], key_frame(key), v(key["pole"]) if "pole" in key else pole, key.get("shape", "grip"))

    def pose_key(self, pose):
        """The family's idle or guard pose as hand keys."""
        spec = self.spec[pose]
        chest = tuple(float(spec.get(n, 0.0)) for n in ("yaw", "pitch", "roll", "neck"))
        return {side: self.side_key(side, spec.get(side), chest) for side in "rl"}, chest

    def place(self, base, keys, chest, shapes):
        """The base pose with the chest turned and each keyed hand on its frame. ``keys`` maps a side to (socket,
        frame, pole, shape), ``"shaft"`` or None; ``shapes`` overrides a side's finger shape (a, b, u)."""
        rig = self.rig
        rig.apply(base)
        turn_chest(rig, *chest)
        main = None
        for side in "rl":
            key = keys.get(side)
            if key is None or key == "shaft":
                continue
            socket, frame, pole, _ = key
            reach(rig, socket, frame)
            place_grip(rig, socket, frame, pole)
            main = frame
        for side in "rl":
            if keys.get(side) == "shaft":
                shaft = main.to_3x3().col[1].normalized()
                back = main.to_3x3().col[2]
                want = rig.head(f"upperarm_{side}") + Vector((0, -.3, -.2))
                low, high = self.spec["shaft"]
                along = min(high, max(low, (want - main.translation).dot(shaft)))
                frame = frame_of(main.translation + shaft * along, shaft, Vector((-back.x, back.y, back.z)))
                socket = "staffLeft"
                reach(rig, socket, frame)
                place_grip(rig, socket, frame, POLE[side])
        for side in "rl":
            a, b, u = shapes[side]
            rig.apply(self.hands.blend(side, a, b, u))
        return rig.capture()


def shape_of(key):
    if key is None:
        return "seed"
    if key == "shaft":
        return "grip"
    return key[3]


def interpolate(track, u):
    """Position (Hermite through the keys, eased ends) and rotation (eased slerp per span) of (fraction, frame) keys."""
    if u <= track[0][0]:
        return track[0][1]
    if u >= track[-1][0]:
        return track[-1][1]
    i = max(k for k in range(len(track) - 1) if track[k][0] <= u)
    (t0, m0), (t1, m1) = track[i], track[i + 1]
    p = [m.translation for _, m in track]

    def slope(k):
        if k == 0 or k == len(track) - 1:
            return p[k] * 0
        return (p[k + 1] - p[k - 1]) / (track[k + 1][0] - track[k - 1][0])

    h = t1 - t0
    s = (u - t0) / h
    s2, s3 = s * s, s * s * s
    position = (2 * s3 - 3 * s2 + 1) * p[i] + (s3 - 2 * s2 + s) * h * slope(i) + (-2 * s3 + 3 * s2) * p[i + 1] + (s3 - s2) * h * slope(i + 1)
    q0, q1 = m0.to_quaternion(), m1.to_quaternion()
    if q0.dot(q1) < 0:
        q1.negate()
    m = q0.slerp(q1, smooth(s)).to_matrix().to_4x4()
    m.translation = position
    return m


def scalar(track, u):
    if u <= track[0][0]:
        return track[0][1]
    if u >= track[-1][0]:
        return track[-1][1]
    i = max(k for k in range(len(track) - 1) if track[k][0] <= u)
    (t0, a), (t1, b) = track[i], track[i + 1]
    return a + (b - a) * smooth((u - t0) / (t1 - t0))


# --- The clips -------------------------------------------------------------------------------------------------------


def one_shot(rig, seed, clip):
    """A draw or a sheathe: the drawing hand's keys (the stow socket, the pull, the idle), the other hand's, the chest."""
    family, keys, duration = ONE_SHOTS[clip]
    ready = Ready(rig, seed, family)
    hand = ready.spec["hand"]
    other = "l" if hand == "r" else "r"
    idle_keys, idle_chest = ready.pose_key("idle")
    chest_track = {n: [] for n in ("yaw", "pitch", "roll", "neck")}
    tracks = {"r": [], "l": []}
    weights = {"r": [], "l": []}
    shapes = {"r": [], "l": []}
    swap = None
    for u, key in keys:
        idle = key.get("h") == "idle"
        chest = tuple(float(key.get(n, idle_chest[k] if idle else 0.0)) for k, n in enumerate(("yaw", "pitch", "roll", "neck")))
        for k, n in enumerate(("yaw", "pitch", "roll", "neck")):
            chest_track[n].append((u, chest[k]))
        for side, slot in ((hand, "h"), (other, "o")):
            if slot not in key:
                continue
            value = key[slot]
            resolved = idle_keys[side] if value == "idle" else ready.side_key(side, value, chest)
            weights[side].append((u, 0.0 if resolved is None else 1.0))
            shapes[side].append((u, shape_of(resolved)))
            if resolved is not None and resolved != "shaft":
                tracks[side].append((u, resolved))
            elif resolved == "shaft":
                tracks[side].append((u, "shaft"))
        if key.get("swap"):
            swap = u
    count = frames_of(duration)
    poses = []
    for k in range(count + 1):
        u = k / count
        chest = tuple(scalar(chest_track[n], u) for n in ("yaw", "pitch", "roll", "neck"))
        placed, side_weight, shape_now = {}, {}, {}
        for side in "rl":
            side_weight[side] = scalar(weights[side], u) if weights[side] else 0.0
            track = tracks[side]
            if track and side_weight[side] > 0:
                if track[0][1] == "shaft":
                    placed[side] = "shaft"
                else:
                    frames = [(t, key[1]) for t, key in track]
                    nearest = min(track, key=lambda item: abs(item[0] - u))[1]
                    placed[side] = (nearest[0], interpolate(frames, u), nearest[2], nearest[3])
            else:
                placed[side] = None
            spans = shapes[side]
            i = max([j for j in range(len(spans)) if spans[j][0] <= u] or [0])
            j = min(i + 1, len(spans) - 1)
            span = spans[j][0] - spans[i][0]
            shape_now[side] = (spans[i][1], spans[j][1], smooth((u - spans[i][0]) / span) if span > 0 else 0.0)
        struck = ready.place(seed, placed, chest, shape_now)
        pose = dict(struck)
        for side in "rl":
            w = side_weight[side]
            if w < 1 and placed[side] is not None:
                for name in arm_bones(side):
                    pose[name] = blend(seed[name], struck[name], w)
        poses.append(pose)
    hit = int(round(swap * count))
    rig.apply(poses[hit])
    held = rig.grip(ready.spec["socket"]).translation
    stowed = ready.stow_frame(tuple(scalar(chest_track[n], swap) for n in ("yaw", "pitch", "roll", "neck")), 0.0).translation
    draw = clip.endswith("Draw") or clip == "Bow_Draw_Weapon"
    return poses, {"ready": {
        "family": family, "kind": "draw" if draw else "sheathe", **({"item": ready.spec["item"]} if ready.spec["item"] else {}),
        "socket": SOCKET_IDS[ready.spec["socket"]], "stowSocket": SOCKET_IDS[ready.spec["stow"]],
        "swapSeconds": round(hit / FPS, 4), "swapGapMeters": round((held - stowed).length, 4),
        "endsIn" if draw else "startsIn": f"{family}.ready",
    }}


def loop(rig, stand, clip):
    """A combat idle or guard: the family's pose over the whole ``Idle_Loop`` resampled to the clip, swaying, breathing
    and bobbing in cycles that close on themselves."""
    family, pose_name, duration, motion = LOOPS[clip]
    seed = sample(rig, stand, 0.0)
    ready = Ready(rig, seed, family)
    keys, chest0 = ready.pose_key(pose_name)
    source = action_seconds(stand)
    count = frames_of(duration)
    rig.apply(seed)
    chest_rest = rig.head("spine_03")
    poses = []
    for k in range(count + 1):
        phase = 2 * math.pi * (k % count) / count
        base = sample(rig, stand, (k % count) / count * source)
        rig.apply(base)
        breathe = rig.head("spine_03") - chest_rest
        chest = (chest0[0] + motion["sway"] * math.sin(phase), chest0[1] + motion["breathe"] * math.sin(2 * phase), chest0[2], chest0[3])
        placed = {}
        for side in "rl":
            key = keys[side]
            if key is None or key == "shaft":
                placed[side] = key
                continue
            socket, frame, pole, shape = key
            late = 0.0 if side == "r" else math.pi / 2
            lift = Vector((0, 0, motion["bob"] * math.sin(2 * phase - late))) + breathe
            # The chest's sway carries the hands round the spine; the tip circles slowly about the grip.
            turn = Matrix.Rotation(math.radians(motion["sway"] * math.sin(phase)) * .6, 4, UP)
            spin = Matrix.Rotation(math.radians(motion["turn"] * math.sin(phase)), 4, X) @ Matrix.Rotation(math.radians(motion["turn"] * math.cos(phase)), 4, UP)
            pivot = rig.head("spine_01")
            moved = Matrix.Translation(pivot) @ turn @ Matrix.Translation(-pivot) @ frame
            m = (spin.to_3x3() @ moved.to_3x3()).to_4x4()
            m.translation = moved.translation + lift
            placed[side] = (socket, m, pole, shape)
        shapes = {side: (shape_of(placed[side]),) * 2 + (1.0,) if placed[side] is not None else ("seed", "seed", 1.0) for side in "rl"}
        poses.append(ready.place(base, placed, chest, shapes))
    return poses, {"ready": {"family": family, "kind": "idle" if pose_name == "idle" else "guard",
                             **({"socket": SOCKET_IDS[ready.spec["socket"]]} if ready.spec["socket"] else {})},
                   "seedSeconds": round(source, 4)}


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    if clip in LOOPS:
        poses, observations = loop(rig, actions[STAND], clip)
    else:
        poses, observations = one_shot(rig, sample(rig, actions[STAND], 0.0), clip)
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
    return {"recipe": "ready-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
