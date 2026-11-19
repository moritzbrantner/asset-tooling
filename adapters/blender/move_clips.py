"""Original control-reaction, movement-spell and tanner clips authored on the Ranger rig in Blender (#767, #422's
rooted struggles for mmorpg#933 Frost Nova and #934 Entangling Roots, the pit fall, the movement spells of mmorpg#294
and the tanner's work loops).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), on top of the first ``Idle_Loop`` pose. Each clip is a list of
keys (see ``LAYOUT``): pelvis, feet, chest, clavicles and palm targets, solved with two-bone arm and leg IK. No source
motion is copied.

- ``Rooted_Struggle_Loop``, ``Rooted_Struggle_Frozen_Loop``, ``Grapple_Throw`` and ``Pull_Yank`` keep only the
  ``spine_01`` subtree (the observations list the joints), so a consumer plays them over the legs it already has. The
  others are full body and record a skirt and cape pose for the #391 chain joints (``secondaryPose``).
- The loops are periodic (their last frame is their first); the one-shots start and end in the idle, except
  ``Blink_Out`` (ends where ``Blink_In`` starts), ``Leap_Launch`` (ends in ``Leap_Air_Loop``'s first frame) and
  ``Leap_Slam`` (starts there). The game owns the travel and the pit's drop.
- No item rides a socket: the scraper, the beam, the hide frame and the hook are placed by the consumer at the recorded
  points (root frame, glTF axes).

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
# + away from the middle finger) per finger. ``grip`` wraps a haft about 3 cm across; ``pinch`` closes the thumb on
# the index (a trigger or a spring); ``cup`` is the palm under a load's edge.
SHAPES = {
    "flat": {"curl": {"index": (0, 2, 2), "middle": (0, 2, 2), "ring": (0, 2, 2), "pinky": (0, 3, 2), "thumb": (0, 4, 4)},
             "spread": {"index": 3, "ring": 3, "pinky": 6, "thumb": 8}},
    "rest": {"curl": {"index": (14, 18, 12), "middle": (16, 20, 12), "ring": (18, 22, 14), "pinky": (20, 24, 14), "thumb": (6, 10, 10)},
             "spread": {"pinky": 4}},
    "cup": {"curl": {"index": (28, 30, 20), "middle": (30, 34, 22), "ring": (32, 36, 22), "pinky": (34, 38, 24), "thumb": (10, 20, 20)},
            "spread": {"index": 4, "ring": 4, "pinky": 8}},
    "grip": {"curl": {"index": (50, 70, 45), "middle": (52, 72, 46), "ring": (54, 72, 46), "pinky": (56, 74, 48), "thumb": (25, 35, 30)},
             "spread": {}},
    "pinch": {"curl": {"index": (40, 45, 30), "middle": (50, 60, 40), "ring": (56, 66, 44), "pinky": (60, 70, 46), "thumb": (30, 30, 25)},
              "spread": {}},
}
# Points in the palm frame (the wrist, +Y toward the fingers, +Z out of the palm): the middle of the palm.
PALM = Vector((0, .05, .02))

def hand(point, fingers, normal, fixed=0.0):
    """A palm target as the channels HL and HR key it."""
    return (*point, *fingers, *normal, fixed)


# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up; metres (the pelvis stands at about z 0.91,
# the shoulders at 1.43, the ground at 0).
#
# A clip is keyed: each key is a fraction of the clip and the channels it changes, and a channel a key leaves out keeps
# the previous key's value. Between keys a Hermite curve carries every channel through, stopping only at a key where
# it turns. The channels:
# - ``P`` the pelvis moved (x, y, z) and ``T`` turned (tip forward, roll, yaw; degrees) from the seed;
# - ``L``, ``R`` each foot moved (x, y, z) and turned ``pitch`` degrees about its ball (+ lifts the heel; in the air it
#   points the toes), the ankle solved with two-bone leg IK, the knee toward the seed's plus ``KL`` or ``KR``;
# - ``C`` the chest (yaw, pitch, roll, neck, as ``turn_chest``) and ``S`` the clavicles raised (left, right; degrees);
# - ``HL``, ``HR`` a palm target (its middle, the fingers, the palm's normal, as the standing seed sees them) and how
#   much of it stays fixed in place (1) rather than carried with the chest (0); ``WL``, ``WR`` how far each palm goes to
#   its target from the seed's (0 keeps the seed arm), ``EL``, ``ER`` the elbow poles (two-bone arm IK);
# - ``G`` the hand shapes (left, right; + toward a fist, - toward a flat hand).
LAYOUT = (("P", 3), ("T", 3), ("L", 4), ("R", 4), ("C", 4), ("S", 2), ("HL", 10), ("HR", 10), ("WL", 1), ("WR", 1), ("EL", 3), ("ER", 3), ("G", 2), ("KL", 3), ("KR", 3))
NEUTRAL = {"P": (0.0,) * 3, "T": (0.0,) * 3, "L": (0.0,) * 4, "R": (0.0,) * 4, "C": (0.0,) * 4, "S": (0.0,) * 2,
           "HL": (.33, -.04, .97, 0, 0, -1, -1, 0, 0, 0), "HR": (-.29, .15, .99, 0, 0, -1, 1, 0, 0, 0), "WL": (0.0,), "WR": (0.0,),
           "EL": (.8, .35, -.5), "ER": (-.8, .35, -.5), "G": (0.0, 0.0), "KL": (0.0,) * 3, "KR": (0.0,) * 3}
# The rooted struggle loop and its frozen variant (seconds; the shivers a loop).
ROOTED = {"duration": 2.0}
FROZEN = {"duration": 2.0, "shivers": 14}
# The pit: the landing at the bottom (a fraction of the clip).
PIT = {"duration": 1.0, "land": .58}
# Hauled by a hook: the feet trail between the two fractions ``drag``.
PULLED = {"duration": 1.0, "drag": (.1, .56)}
# Slipping on ice.
SLIP = {"duration": 1.2}
# The blink: ``Blink_Out`` gathers into ``gone`` (where ``Blink_In`` starts).
BLINK = {"out": .3, "in": .4,
         "gather": {"P": (0, .02, -.12), "T": (10, 0, 0), "C": (0, 16, 0, 16), "S": (8, 8), "R": (0, 0, 0, 8), "WL": (1,), "WR": (1,), "G": (.6, .6),
                    "HL": hand((-.06, -.2, 1.22), (-1, 0, .3), (0, 1, 0)), "HR": hand((.06, -.22, 1.28), (1, 0, .3), (0, 1, 0)),
                    "EL": (.6, -.3, -.6), "ER": (-.6, -.3, -.6)},
         "gone": {"P": (0, .02, -.16), "T": (14, 0, 0), "C": (0, 22, 0, 20), "S": (12, 12), "L": (0, 0, .02, 14), "R": (0, 0, .02, 18),
                  "WL": (1,), "WR": (1,), "G": (1, 1),
                  "HL": hand((-.08, -.18, 1.24), (-1, 0, .3), (0, 1, 0)), "HR": hand((.08, -.2, 1.3), (1, 0, .3), (0, 1, 0)),
                  "EL": (.6, -.3, -.6), "ER": (-.6, -.3, -.6)}}
# The leap: the launch, the air loop and the slam (seconds); the take-off and the slam's impact (fractions).
LEAP = {"launch": .5, "air": .8, "slam": 1.0, "takeoff": .72, "impact": .36}
# In the air (``Leap_Launch``'s last frame, ``Leap_Air_Loop``, ``Leap_Slam``'s first): tucked, the arms spread.
AIR = {"P": (0, 0, 0), "T": (8, 0, 0), "C": (0, 6, 0, -10), "L": (0, -.1, .3, 30), "R": (0, -.24, .2, 36), "S": (8, 8),
       "HL": hand((.5, -.22, 1.38), (.8, -.3, .1), (0, 0, -1)), "HR": hand((-.5, -.22, 1.38), (-.8, -.3, .1), (0, 0, -1)), "WL": (1,), "WR": (1,),
       "G": (-.5, -.5), "EL": tuple(NEUTRAL["EL"]), "ER": tuple(NEUTRAL["ER"])}
# The dash (seconds).
DASH = {"duration": .4}
# The grappling hook's throw and the yank (seconds; the release and the yank as fractions).
GRAPPLE = {"duration": .8, "release": .5}
YANK = {"duration": .7, "yank": .44}
# The tanner's fleshing beam (its near and far ends under the scraper's middle), its strokes a loop and when each push
# ends; the hide frame's stretch with its grip and hook (fractions).
TANNER = {"duration": 2.4, "strokes": 2, "push": .45, "beam": ((0, -.3, 1.0), (0, -.7, .74))}
STRETCH = {"duration": 2.6, "grip": .3, "hook": .68}

UPPER = {"Rooted_Struggle_Loop", "Rooted_Struggle_Frozen_Loop", "Grapple_Throw", "Pull_Yank"}
CLIPS = ("Rooted_Struggle_Loop", "Rooted_Struggle_Frozen_Loop", "Fall_Pit", "Blink_Out", "Blink_In", "Leap_Launch", "Leap_Air_Loop",
         "Leap_Slam", "Dash_Lunge", "Grapple_Throw", "Pull_Yank", "Pulled_Drag", "Slip_Ice_Loop", "Tanner_Scrape_Loop", "Tanner_Stretch_Hide")
# The #391 chain joints the full-body clips key, and how far the panels follow the thighs (as the social clips).
CAPE = "cape_01"
SWING = {"share": .7, "front": 70.0, "sideShare": .8, "side": 75.0, "back": 20.0}
BACK = Vector((0, 1, 0))
PLUMB = ("skirt_f_03", "skirt_l_02", "skirt_r_02")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips"}:
        raise ValueError("move clips require exactly schemaVersion and clips")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"move clips must be distinct names from {CLIPS}")
    if set(inputs) != {"target"}:
        raise ValueError("move clips take exactly the declared input target")


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


def palm_frame(point, y_axis, z_hint, offset=PALM):
    """The palm (wrist) frame whose ``offset`` point lands on ``point``."""
    m = frame_of(Vector(), y_axis, z_hint)
    m.translation = point - m.to_3x3() @ offset
    return m


def cyclic(keys, t):
    """A closed Catmull-Rom curve through ``keys`` ((fraction, Vector) pairs, the first at 0) evaluated at ``t``: the
    value at 1 is the value at 0, with the same slope, so a loop has no seam."""
    n = len(keys)
    t %= 1.0
    i = max(k for k in range(n) if keys[k][0] <= t)
    start, end = keys[i][0], keys[i + 1][0] if i + 1 < n else 1.0
    s = (t - start) / (end - start)
    p0, p1, p2, p3 = (keys[(i + j) % n][1] for j in (-1, 0, 1, 2))
    s2, s3 = s * s, s * s * s
    return .5 * ((2 * p1) + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (-p0 + 3 * p1 - 3 * p2 + p3) * s3)


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



def secondary(rig, follow=0.0):
    """The #391 chain pose of this frame (as adapters/blender/social_clips.py): per chain joint it keys, its local
    rotation (glTF xyzw) under its parent (``pelvis``, ``spine_03`` for ``cape_01``, the joint above for the plumb
    joints). The front panel rides the higher thigh, each side panel follows its own thigh out and forward, and past the
    knee both hang plumb over the shin; the back panel and the cape hang but never pass into the legs or the back."""
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
    for joint in PLUMB:
        out[joint] = swings[joint[:-2] + "01"].inverted().to_quaternion()
    return {joint: [round(q.x, 5), round(q.y, 5), round(q.z, 5), round(q.w, 5)] for joint, q in out.items()}


def record_chains(rig, poses):
    chains = {}
    for pose in poses:
        rig.apply(pose)
        for joint, rotation in secondary(rig).items():
            chains.setdefault(joint, []).append(rotation)
    return {"sampleRate": FPS, "joints": chains}


def upper_joints(rig):
    return [UPPER_ROOT, *(bone.name for bone in rig.rig.data.bones[UPPER_ROOT].children_recursive)]


def root_point(p):
    """An armature-space point in the root's glTF axes (+Y up, +Z facing), rounded."""
    g = C4.inverted() @ p
    return [round(g.x, 4), round(g.y, 4), round(g.z, 4)]


def frames_of(duration):
    return int(round(duration * FPS))


def loop(duration, frame):
    """Every frame of a loop of ``duration`` seconds, as ``frame(phase)`` with phase in [0, 1); the last repeats the first."""
    count = frames_of(duration)
    return [frame((k % count) / count) for k in range(count + 1)]



def turn_chest(rig, yaw=0.0, pitch=0.0, roll=0.0, neck=0.0, gaze=.5, look=0.0):
    """Spread a chest turn over spine_01-03; the neck and head take back ``gaze`` of the yaw and half the pitch, then
    tip by ``neck`` (negative looks up) and turn ``look`` degrees more to the figure's left."""
    for joint, share in SPINE:
        if yaw:
            rotate_world(rig, joint, UP, yaw * share)
        if pitch:
            rotate_world(rig, joint, X, pitch * share)
        if roll:
            rotate_world(rig, joint, Y, -roll * share)
    if yaw * gaze - look:
        rotate_world(rig, "neck_01", UP, -yaw * gaze + look)
    if pitch - 2 * neck:
        rotate_world(rig, "neck_01", X, -pitch * .5 + neck)


class Actor:
    """The clip-independent state: the seed pose, the seed's palms, feet and balls and the
    finger shapes."""

    def __init__(self, rig, seed):
        self.rig, self.seed = rig, seed
        rig.apply(seed)
        self.seed_joint = {name: rig.bones[name].matrix.copy() for name in ("pelvis", "spine_03", "Head")}
        self.seed_palm = {side: rig.grip(f"palm_{side}") for side in "lr"}
        self.feet = feet_of(rig)
        self.balls = {side: rig.head(LEGS[side][3]) for side in "lr"}
        self.hands = Hands(rig, seed)

    def carry(self, joint):
        """How ``joint`` has moved from where it stands in the seed (armature space)."""
        return self.rig.bones[joint].matrix @ self.seed_joint[joint].inverted()

    def pose(self, hands=None, chest=None, shapes=None, body=None):
        """One frame: ``body`` (pelvis, legs, shoulders), the chest turn, then each hand's socket on the frame
        ``hands()`` returns ({side: (socket, frame[, elbow pole])}, read after the body moved) and the shapes."""
        rig = self.rig
        rig.apply(self.seed)
        if body:
            body()
        chest = chest or {}
        turn_chest(rig, chest.get("yaw", 0.0), chest.get("pitch", 0.0), chest.get("roll", 0.0), chest.get("neck", 0.0),
                   chest.get("gaze", .5), chest.get("look", 0.0))
        for side, (socket, frame, *pole) in (hands() if hands else {}).items():
            place_grip(rig, socket, frame, pole[0] if pole else POLE[side])
        for side, shape in (shapes or {}).items():
            rig.apply(self.hands.blend(side, *(shape if type(shape) is tuple else (shape, shape, 1.0))))
        return rig.capture()


def track(keys, u):
    """``keys`` ((fraction, value) pairs, values floats or Vectors) eased between neighbours, held past the ends."""
    if u <= keys[0][0]:
        return keys[0][1]
    for (a, va), (b, vb) in zip(keys, keys[1:]):
        if u <= b:
            return va + (vb - va) * smooth((u - a) / (b - a))
    return keys[-1][1]


def blend(a, b, w):
    la, ra, _ = a.decompose()
    lb, rb, _ = b.decompose()
    return Matrix.LocRotScale(la.lerp(lb, w), ra.slerp(rb, w), Vector((1, 1, 1)))


def one_shot(duration, frame):
    count = frames_of(duration)
    return [frame(k / count) for k in range(count + 1)]


# --- Keyed whole-body poses ------------------------------------------------------------------------------------------

def unpack(flat):
    out, k = {}, 0
    for name, size in LAYOUT:
        out[name] = flat[k:k + size]
        k += size
    return out


def flatten(keys):
    """``keys`` [(fraction, {channel: values})] as [(fraction, [floats])], each key filling what it leaves out from
    the key before (the first from ``NEUTRAL``)."""
    state, out = dict(NEUTRAL), []
    for u, changes in keys:
        unknown = set(changes) - set(state)
        if unknown:
            raise ValueError(f"unknown channels {sorted(unknown)}")
        state = {**state, **{name: tuple(float(x) for x in value) for name, value in changes.items()}}
        out.append((u, [x for name, _ in LAYOUT for x in state[name]]))
    return out


def curve(keys, u, cyclic_=False):
    """A Hermite curve through flattened ``keys`` at ``u``: each channel flows through a key that lies between its
    neighbours and stops at one that turns (no overshoot past a held or extreme key). A one-shot starts and ends at
    rest; a cyclic curve wraps (its keys from 0 to below 1)."""
    if cyclic_:
        n = len(keys)
        u %= 1.0
        ext = [(t - 1, p) for t, p in keys[-2:]] + list(keys) + [(t + 1, p) for t, p in keys[:2]]
        i = 2 + max(k for k in range(n) if keys[k][0] <= u)
    else:
        if u <= keys[0][0]:
            return list(keys[0][1])
        if u >= keys[-1][0]:
            return list(keys[-1][1])
        ext = [keys[0]] + list(keys) + [keys[-1]]
        i = 1 + max(k for k in range(len(keys) - 1) if keys[k][0] <= u)
    (t0, p0), (t1, p1), (t2, p2), (t3, p3) = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
    h = t2 - t1
    s = (u - t1) / h

    def slope(ta, pa, tb, pb, tc, pc):
        if tc - ta <= 1e-9 or (pb - pa) * (pc - pb) <= 0:
            return 0.0
        return (pc - pa) / (tc - ta)

    out = []
    for a, b, c, d in zip(p0, p1, p2, p3):
        m1, m2 = slope(t0, a, t1, b, t2, c) * h, slope(t1, b, t2, c, t3, d) * h
        s2, s3 = s * s, s * s * s
        out.append((2 * s3 - 3 * s2 + 1) * b + (s3 - 2 * s2 + s) * m1 + (-2 * s3 + 3 * s2) * c + (s3 - s2) * m2)
    return out


def rest_body(s):
    return all(abs(x) < 1e-6 for name in ("P", "T", "L", "R", "S") for x in s[name])


def body_of(actor, s):
    """Move the pelvis, plant the feet (each turned about its ball) and raise the clavicles."""
    rig = actor.rig

    def body():
        if rest_body(s):
            return
        move_pelvis(rig, Vector(s["P"]))
        tip, roll, yaw = s["T"]
        for axis, degrees in ((X, tip), (Y, roll), (UP, yaw)):
            if degrees:
                rotate_world(rig, "pelvis", axis, degrees)
        feet = {}
        for side, channel in (("l", "L"), ("r", "R")):
            ankle, matrix, bend = actor.feet[side]
            *offset, pitch = s[channel]
            ball = actor.balls[side] + Vector(offset)
            turn = Matrix.Rotation(math.radians(pitch), 3, X)
            feet[side] = (ball + turn @ (ankle - actor.balls[side]), (turn @ matrix.to_3x3()).to_4x4(), bend + Vector(s["K" + side.upper()]))
        plant_feet(rig, feet)
        for side, raised in zip("lr", s["S"]):
            if raised:
                rotate_world(rig, f"clavicle_{side}", Y, -raised if side == "l" else raised)

    return body


def frame_at(actor, s):
    """One frame of the state ``s``."""
    carry = actor.carry

    def hands():
        out = {}
        for side in "lr":
            w = s["W" + side.upper()][0]
            if w < 1e-4:
                continue
            h = s["H" + side.upper()]
            target = palm_frame(Vector(h[0:3]), Vector(h[3:6]), Vector(h[6:9]))
            chest = carry("spine_03")
            placed = blend(chest @ target, target, min(1.0, max(0.0, h[9])))
            out[side] = ("palm_" + side, blend(chest @ actor.seed_palm[side], placed, min(1.0, w)), Vector(s["E" + side.upper()]))
        return out

    shapes = {side: ("rest", "grip", min(1.0, g)) if g >= 0 else ("rest", "flat", min(1.0, -g)) for side, g in zip("lr", s["G"])}
    yaw, pitch, roll, neck = s["C"]
    return actor.pose(hands, {"yaw": yaw, "pitch": pitch, "roll": roll, "neck": neck}, shapes, body_of(actor, s))


def keyed_clip(actor, duration, keys, cyclic_=False, overlay=None):
    """Every frame of a clip keyed by ``keys``; ``overlay(u, state)`` may add a procedural layer (a shiver, a sway)."""
    flat = flatten(keys)

    def frame(u):
        s = unpack(curve(flat, u, cyclic_))
        if overlay:
            overlay(u, s)
        return frame_at(actor, s)

    return loop(duration, frame) if cyclic_ else one_shot(duration, frame)


def add(s, channel, *deltas):
    s[channel] = [a + b for a, b in zip(s[channel], deltas)] + list(s[channel][len(deltas):])


def seconds(u, duration):
    return round(u * duration, 4)


# --- Control reactions -----------------------------------------------------------------------------------------------

def rooted(actor):
    """Feet held fast: the upper body heaves against the hold twice a loop, each time bent over one thigh with both
    fists hauling at it, then straining up and back with a twist the other way, the head down at the feet."""
    sp = ROOTED

    def heave(sign):
        x = .1 * sign
        fist = lambda dx, y, z: hand((x + dx, y, z), (0, -.3, -1), (-sign * .2, 1, 0))
        down = {"C": (22 * sign, 36, -8 * sign, 26), "HL": fist(.07, -.24, .72), "HR": fist(-.07, -.24, .72), "WL": (1,), "WR": (1,),
                "G": (.85, .85), "S": (2, 2)}
        up = {"C": (-20 * sign, -10, 10 * sign, 14), "HL": fist(.14, -.1, 1.02), "HR": fist(-.02, -.1, 1.04), "G": (1, 1), "S": (14, 14)}
        return down, up

    l_down, l_up = heave(1)
    r_down, r_up = heave(-1)
    keys = [(0.0, l_down), (.18, l_up), (.32, {**l_up, "C": (-4, 2, 2, 16)}), (.5, r_down), (.68, r_up), (.82, {**r_up, "C": (4, 2, -2, 16)})]
    return keyed_clip(actor, sp["duration"], keys, cyclic_=True), {"heaveSeconds": [seconds(.18, sp["duration"]), seconds(.68, sp["duration"])]}


def frozen(actor):
    """Frozen in place: hunched, the shoulders up and the arms clamped across the chest, the whole upper body
    shivering; once a loop it strains stiffly against the ice, a small twist that barely moves."""
    sp = FROZEN
    hug = {"C": (0, 14, 0, 16), "S": (12, 12), "WL": (1,), "WR": (1,), "G": (.55, .55),
           "HL": hand((-.16, -.12, 1.27), (-.8, .3, .1), (-.2, .9, -.1)), "HR": hand((.16, -.1, 1.22), (.8, .3, .1), (.2, .9, -.1)),
           "EL": (.6, -.4, -.6), "ER": (-.6, -.4, -.6)}
    keys = [(0.0, hug), (.3, {**hug, "C": (-7, 17, 3, 18), "S": (15, 13)}), (.55, {**hug, "C": (6, 15, -3, 17), "S": (13, 15)}), (.8, hug)]
    cycles = sp["shivers"]

    def shiver(u, s):
        a = 2 * math.pi * cycles * u
        add(s, "C", 1.4 * math.sin(a), .8 * math.sin(1.7 * a + 1), 1.2 * math.sin(a + 2), 1.5 * math.sin(1.3 * a))
        add(s, "S", .9 * math.sin(a + .5), .9 * math.sin(a + 1.4))

    return keyed_clip(actor, sp["duration"], keys, cyclic_=True, overlay=shiver), {"shiversPerSecond": round(cycles / sp["duration"], 2)}


def fall_pit(actor):
    """The ground gives way: the knees buckle, the arms fly up and the legs dangle and kick through the drop (the game
    moves the body down), then a hard landing at the bottom, both palms to the ground, and up into the idle."""
    sp = PIT
    up = lambda side, x, z: hand((x, -.08, z), (0, .1, 1), (-1 if side == "l" else 1, 0, 0))
    keys = [(0.0, {}),
            (.1, {"P": (0, .02, -.1), "T": (-6, 0, 0), "C": (0, -6, 0, 18), "L": (0, 0, .04, 12), "R": (0, 0, 0, 8),
                  "HL": up("l", .45, 1.35), "HR": up("r", -.45, 1.35), "WL": (.6,), "WR": (.6,), "G": (-.6, -.6), "S": (6, 6)}),
            (.24, {"P": (0, 0, .02), "T": (-10, 3, 0), "C": (4, -12, -3, -14), "L": (0, -.04, .16, 30), "R": (0, -.08, .24, 34),
                   "HL": up("l", .42, 1.86), "HR": up("r", -.38, 1.8), "WL": (1,), "WR": (1,), "S": (24, 22), "G": (-1, -1),
                   "EL": (.9, .3, -.2), "ER": (-.9, .3, -.2)}),
            (.4, {"P": (0, 0, .02), "T": (-6, -3, 0), "C": (-5, -8, 4, -10), "L": (0, -.12, .26, 34), "R": (0, -.02, .14, 28),
                  "HL": up("l", .5, 1.74), "HR": up("r", -.46, 1.86), "S": (20, 24)}),
            (sp["land"], {"P": (0, .04, -.4), "T": (28, 0, 0), "C": (0, 18, 0, -4), "L": (0, 0, 0, 0), "R": (0, 0, 0, 22),
                          "HL": hand((.24, -.42, .1), (0, -1, -.05), (0, 0, 1), 1), "HR": hand((-.22, -.4, .1), (0, -1, -.05), (0, 0, 1), 1),
                          "WL": (.9,), "WR": (.9,), "S": (0, 0), "G": (-1, -1), "EL": tuple(POLE["l"]), "ER": tuple(POLE["r"])}),
            (.68, {"P": (0, .05, -.44), "T": (32, 0, 0), "C": (0, 20, 0, 0)}),
            (.84, {"P": (0, .02, -.16), "T": (12, 0, 0), "C": (0, 8, 0, 4), "R": (0, 0, 0, 0), "WL": (.2,), "WR": (.2,), "G": (0, 0)}),
            (1.0, {"P": (0, 0, 0), "T": (0, 0, 0), "C": (0, 0, 0, 0), "WL": (0,), "WR": (0,)})]
    return keyed_clip(actor, sp["duration"], keys), {"landSeconds": seconds(sp["land"], sp["duration"]), "drop": "game"}


def pulled(actor):
    """Hooked and hauled forward: the chest is snatched ahead with the head whipping back, the feet trail on their
    toes, the arms reach out to catch the fall, a stumbling step catches the weight and the body rights itself."""
    sp = PULLED
    keys = [(0.0, {}),
            (.1, {"P": (0, -.06, -.03), "T": (14, 0, 0), "C": (0, 24, 0, -24), "L": (0, 0, .03, 26), "R": (0, 0, 0, 20),
                  "HL": hand((.34, .26, 1.08), (.2, .5, -.8), (0, -1, 0)), "HR": hand((-.34, .26, 1.08), (-.2, .5, -.8), (0, -1, 0)),
                  "WL": (1,), "WR": (1,), "G": (-.8, -.8)}),
            (.3, {"P": (0, -.16, -.08), "T": (26, 0, 0), "C": (0, 18, 0, -18), "L": (0, .14, 0, 46), "R": (0, .12, 0, 50),
                  "HL": hand((.32, -.5, 1.2), (.1, -1, -.1), (0, 0, -1)), "HR": hand((-.3, -.52, 1.18), (-.1, -1, -.1), (0, 0, -1)), "G": (-1, -1)}),
            (sp["drag"][1] - .1, {"L": (0, -.06, .1, 20)}),
            (sp["drag"][1], {"P": (0, -.1, -.12), "T": (16, 0, 0), "C": (0, 12, 0, -8), "L": (0, -.22, 0, 0), "R": (0, .12, 0, 44),
                             "HL": hand((.36, -.36, 1.1), (.3, -1, -.2), (0, 0, -1)), "HR": hand((-.36, -.34, 1.06), (-.3, -1, -.2), (0, 0, -1)),
                             "WL": (.8,), "WR": (.8,)}),
            # The trailing right foot swings through to a stance, then the left steps back under the body.
            (.7, {"R": (0, .02, .1, 20), "P": (0, -.07, -.08), "T": (8, 0, 0)}),
            (.8, {"P": (0, -.03, -.04), "T": (4, 0, 0), "C": (0, 4, 0, 0), "R": (0, 0, 0, 0), "WL": (.3,), "WR": (.3,), "G": (0, 0)}),
            (.9, {"L": (0, -.1, .06, 0), "P": (0, -.01, -.02)}),
            (1.0, {"P": (0, 0, 0), "T": (0, 0, 0), "C": (0, 0, 0, 0), "L": (0, 0, 0, 0), "WL": (0,), "WR": (0,)})]
    return keyed_clip(actor, sp["duration"], keys), {"dragSeconds": [seconds(u, sp["duration"]) for u in sp["drag"]]}


def slip_ice(actor):
    """Losing the footing on ice: the feet skate forward and back against each other, the hips drop and wobble and
    the arms windmill out to the sides to catch the balance."""
    sp = SLIP
    keys = []
    for k in range(8):
        u = k / 8
        a = 2 * math.pi * u
        arm = lambda side, phase: hand(((.62 if side == "l" else -.62), -.05 - .18 * math.sin(a + phase), 1.32 + .16 * math.cos(a + phase)),
                                       ((1 if side == "l" else -1), 0, .1), (0, -.3 * math.cos(a + phase), -1))
        keys.append((u, {"P": (.03 * math.sin(a), .02 * math.cos(a), -.09 - .03 * math.sin(2 * a)), "T": (6 + 5 * math.cos(a), 7 * math.sin(a), 4 * math.sin(a)),
                         "L": (.03 * math.sin(a), -.13 * math.sin(a), .015 * max(0.0, math.cos(a)), 6 * max(0.0, -math.sin(a))),
                         "R": (-.03 * math.sin(a), .11 * math.sin(a), .015 * max(0.0, -math.cos(a)), 8 * max(0.0, math.sin(a))),
                         "C": (-6 * math.sin(a), 4 - 6 * math.cos(a), -8 * math.sin(a), 6), "S": (10 + 6 * math.cos(a), 10 - 6 * math.cos(a)),
                         "HL": arm("l", 0.0), "HR": arm("r", math.pi), "WL": (1,), "WR": (1,), "G": (-.9, -.9),
                         "EL": (.3, .4, -1), "ER": (-.3, .4, -1)}))
    return keyed_clip(actor, sp["duration"], keys, cyclic_=True), {"slides": True}


# --- Movement spells -------------------------------------------------------------------------------------------------

def blink_out(actor):
    """Gathering inward to vanish: a sharp dip, the arms snapped across the chest and the head tucked, up onto the
    toes at the instant the body disappears (the last frame, where ``Blink_In`` starts)."""
    keys = [(0.0, {}), (.45, BLINK["gather"]), (1.0, BLINK["gone"])]
    return keyed_clip(actor, BLINK["out"], keys), {"to": "Blink_In", "vanishSeconds": BLINK["out"]}


def blink_in(actor):
    """Appearing from ``Blink_Out``'s last frame: the body bursts open, arms flung out and down and the chest lifted,
    lands its weight with a small dip and settles into the idle."""
    open_ = {"P": (0, 0, -.05), "T": (-4, 0, 0), "C": (0, -8, 0, -8), "L": (0, 0, 0, 0), "R": (0, 0, 0, 0), "S": (6, 6),
             "HL": hand((.6, -.16, 1.02), (.8, -.2, -.5), (0, -1, 0)), "HR": hand((-.6, -.16, 1.02), (-.8, -.2, -.5), (0, -1, 0)), "G": (-1, -1),
             "EL": tuple(POLE["l"]), "ER": tuple(POLE["r"])}
    keys = [(0.0, BLINK["gone"]), (.3, open_), (.62, {"P": (0, .01, -.07), "T": (4, 0, 0), "C": (0, 4, 0, 2), "WL": (.4,), "WR": (.4,), "S": (0, 0),
                                                       "G": (-.3, -.3)}),
            (1.0, {"P": (0, 0, 0), "T": (0, 0, 0), "C": (0, 0, 0, 0), "WL": (0,), "WR": (0,), "G": (0, 0)})]
    return keyed_clip(actor, BLINK["in"], keys), {"from": "Blink_Out", "appearSeconds": 0.0}


def leap_launch(actor):
    """A spell-powered leap: a deep load with the arms swung back, the drive up through the toes with the arms swung
    forward and up, and the feet tucked as the body leaves the ground (``Leap_Air_Loop``'s first frame)."""
    sp = LEAP
    keys = [(0.0, {}),
            (.45, {"P": (0, .06, -.3), "T": (30, 0, 0), "C": (0, 16, 0, -14), "S": (0, 0),
                   "HL": hand((.28, .3, .96), (.1, .4, -1), (-1, 0, 0)), "HR": hand((-.28, .3, .96), (-.1, .4, -1), (1, 0, 0)),
                   "WL": (1,), "WR": (1,), "G": (.3, .3)}),
            (sp["takeoff"], {"P": (0, -.02, .04), "T": (-4, 0, 0), "C": (0, -6, 0, -8), "L": (0, 0, .03, 38), "R": (0, 0, .03, 40), "S": (14, 14),
                             "HL": hand((.26, -.36, 1.62), (0, -.4, 1), (-.3, -1, 0)), "HR": hand((-.26, -.36, 1.62), (0, -.4, 1), (.3, -1, 0)), "G": (-.6, -.6)}),
            (1.0, AIR)]
    return keyed_clip(actor, sp["launch"], keys), {"takeoffSeconds": seconds(sp["takeoff"], sp["launch"]), "to": "Leap_Air_Loop"}


def leap_air(actor):
    """In the air: tucked, the arms spread for balance, the legs paddling a little against each other."""
    sp = LEAP
    keys = []
    for k in range(4):
        u = k / 4
        a = 2 * math.pi * u
        s = {name: tuple(value) for name, value in AIR.items()}
        s["L"] = (AIR["L"][0], AIR["L"][1] - .04 * math.sin(a), AIR["L"][2] + .04 * math.cos(a), AIR["L"][3])
        s["R"] = (AIR["R"][0], AIR["R"][1] + .04 * math.sin(a), AIR["R"][2] - .04 * math.cos(a), AIR["R"][3])
        s["C"] = (3 * math.sin(a), AIR["C"][1] + 2 * math.cos(a), 2 * math.sin(a), AIR["C"][3])
        keys.append((u, s))
    return keyed_clip(actor, sp["air"], keys, cyclic_=True), {"from": "Leap_Launch", "to": "Leap_Slam"}


def leap_slam(actor):
    """From the air: both fists raised high over the head as the legs reach down, a crashing landing on the left foot
    and the right knee with the right fist driven into the ground, held, and up into the idle."""
    sp = LEAP
    impact = sp["impact"]
    raised = {"P": (0, 0, 0), "T": (-8, 0, 0), "C": (0, -12, 0, -6), "L": (0, -.06, .06, 16), "R": (0, 0, .1, 22), "S": (22, 22),
              "HL": hand((.08, -.12, 1.94), (-.2, 0, 1), (-1, 0, 0)), "HR": hand((-.06, -.12, 1.92), (.2, 0, 1), (1, 0, 0)), "G": (1, 1),
              "EL": (.9, .4, 0), "ER": (-.9, .4, 0)}
    land = {"P": (0, .04, -.5), "T": (36, 0, 6), "C": (-8, 40, 0, -26), "L": (.04, -.18, 0, 0), "R": (.02, .12, .02, 58), "S": (0, -22),
            "HR": hand((-.17, -.33, .15), (0, -.2, -1), (0, 1, 0), 1), "HL": hand((.62, .1, 1.1), (.9, .3, -.2), (0, -.3, -1)), "G": (-.8, 1),
            "EL": tuple(POLE["l"]), "ER": (-.5, .6, -.2), "KL": (.3, 0, 0), "KR": (.6, -.2, -1.2)}
    keys = [(0.0, AIR), (.24, raised), (impact - .06, {**land, "P": (0, .02, -.3), "T": (20, 0, 4), "C": (-6, 24, 0, -18)}), (impact, land),
            (.52, {**land, "P": (0, .05, -.52), "C": (-8, 42, 0, -24)}),
            # Up off the knee on the planted feet, then the right foot and the left step back under the body.
            (.66, {"P": (0, .03, -.24), "T": (16, 0, 3), "C": (-3, 14, 0, -6), "R": (.02, .12, 0, 40), "WL": (.3,), "WR": (.3,), "S": (0, 0),
                   "G": (0, .5), "HR": hand((-.3, -.1, .96), (0, 0, -1), (1, 0, 0), 0), "KL": (.15, 0, 0), "KR": (.3, -.1, -.6)}),
            (.78, {"P": (0, .01, -.1), "T": (6, 0, 1), "C": (0, 5, 0, -2), "R": (.01, .05, .07, 12), "KR": (0, 0, 0)}),
            (.87, {"P": (0, 0, -.05), "T": (3, 0, 0), "R": (0, 0, 0, 0), "L": (.02, -.09, .06, 0), "KL": (0, 0, 0)}),
            (1.0, {"P": (0, 0, 0), "T": (0, 0, 0), "C": (0, 0, 0, 0), "L": (0, 0, 0, 0), "WL": (0,), "WR": (0,), "G": (0, 0)})]
    return keyed_clip(actor, sp["slam"], keys), {"from": "Leap_Air_Loop", "contactSeconds": seconds(impact, sp["slam"]), "landSeconds": seconds(impact - .06, sp["slam"])}


def dash_lunge(actor):
    """A burst forward: a quick dip, the left foot thrown a long stride ahead and the right leg driving straight
    behind, the body low and the arms swept back, then the feet gathered under the body again."""
    sp = DASH
    keys = [(0.0, {}),
            (.18, {"P": (0, .02, -.07), "T": (8, 0, 0), "C": (0, 8, 0, -4), "R": (0, 0, 0, 16), "WL": (.4,), "WR": (.4,),
                   "HL": hand((.3, .22, .98), (.1, .3, -1), (-1, 0, 0)), "HR": hand((-.3, .22, .98), (-.1, .3, -1), (1, 0, 0))}),
            (.32, {"L": (0, -.2, .07, 0)}),
            (.48, {"P": (0, -.16, -.17), "T": (24, 0, 0), "C": (0, 14, 0, -16), "L": (0, -.36, 0, 0), "R": (0, 0, 0, 52), "WL": (1,), "WR": (1,),
                   "HL": hand((.32, .34, 1.06), (.2, .5, -.8), (-1, 0, 0)), "HR": hand((-.32, .34, 1.06), (-.2, .5, -.8), (1, 0, 0)), "G": (-.8, -.8)}),
            (.64, {"P": (0, -.12, -.15), "T": (18, 0, 0)}),
            # The rear ball stays put while its heel drops; the front foot lifts and steps back under the body.
            (.8, {"L": (0, -.16, .06, 0), "R": (0, 0, 0, 18), "P": (0, -.04, -.06), "T": (6, 0, 0), "C": (0, 4, 0, -2), "WL": (.3,), "WR": (.3,), "G": (0, 0)}),
            (.92, {"L": (0, -.02, .03, 0), "R": (0, 0, 0, 4)}),
            (1.0, {"P": (0, 0, 0), "T": (0, 0, 0), "C": (0, 0, 0, 0), "L": (0, 0, 0, 0), "R": (0, 0, 0, 0), "WL": (0,), "WR": (0,)})]
    return keyed_clip(actor, sp["duration"], keys), {"strideSeconds": [seconds(.32, sp["duration"]), seconds(.48, sp["duration"])]}


def grapple_throw(actor):
    """A grappling hook thrown overhand: the left hand points at the mark while the right winds back above the
    shoulder with the chest turned away, then the whole chest whips round and the arm throws long, the fist opening
    at the release, and settles."""
    sp = GRAPPLE
    rel = sp["release"]
    keys = [(0.0, {}),
            (.36, {"C": (-28, -4, -6, -6), "S": (4, 18), "WL": (1,), "WR": (1,), "G": (-1, 1),
                   "HL": hand((.2, -.48, 1.42), (0, -1, .05), (0, 0, -1)), "HR": hand((-.36, .26, 1.62), (-.2, .4, 1), (0, -1, 0)),
                   "ER": (-.6, .6, -.4)}),
            (rel, {"C": (22, 12, 4, -2), "S": (0, 10), "G": (.4, -1),
                   "HL": hand((.12, -.16, 1.16), (-.4, -.3, -.6), (-.6, .7, 0)), "HR": hand((-.12, -.6, 1.52), (0, -1, .3), (0, .1, -1)),
                   "ER": (-.8, .2, -.6)}),
            (.7, {"C": (26, 16, 2, 2), "S": (0, 4), "HR": hand((.0, -.46, 1.16), (.2, -1, -.4), (0, 0, -1)), "WL": (.6,)}),
            (1.0, {"C": (0, 0, 0, 0), "S": (0, 0), "WL": (0,), "WR": (0,), "G": (0, 0)})]
    return keyed_clip(actor, sp["duration"], keys), {"releaseSeconds": seconds(rel, sp["duration"])}


def pull_yank(actor):
    """Both fists on a line running out ahead, then a hard yank back to the right hip with the chest thrown back and
    turned, held for a beat and let go."""
    sp = YANK
    reach = {"C": (8, 14, 0, 2), "S": (6, 6), "WL": (1,), "WR": (1,), "G": (1, 1),
             "HL": hand((.02, -.62, 1.28), (-1, 0, -.2), (0, .3, -1)), "HR": hand((-.04, -.48, 1.26), (1, 0, -.2), (0, .3, -1)),
             "EL": (.8, .2, -.6), "ER": (-.8, .2, -.6)}
    yank = {"C": (-34, -16, -6, 6), "S": (-4, -8),
            "HL": hand((-.14, -.2, 1.06), (-1, 0, -.2), (0, .3, -1)), "HR": hand((-.32, .1, .98), (1, 0, -.2), (0, .3, -1))}
    keys = [(0.0, {}), (.2, reach), (.3, {**reach, "C": (10, 18, 0, 4)}), (sp["yank"], yank), (.66, {**yank, "C": (-30, -14, -5, 6)}),
            (1.0, {"C": (0, 0, 0, 0), "S": (0, 0), "WL": (0,), "WR": (0,), "G": (0, 0)})]
    return keyed_clip(actor, sp["duration"], keys), {"yankSeconds": seconds(sp["yank"], sp["duration"])}


# --- The tanner ------------------------------------------------------------------------------------------------------

def tanner_scrape(actor):
    """Fleshing a hide over a sloped beam: both fists on the scraper's handles push it down and away along the beam,
    the weight rolling onto the front foot and the back heel lifting, then draw it back up for the next stroke."""
    sp = TANNER
    near, far = Vector(sp["beam"][0]), Vector(sp["beam"][1])
    grip = lambda at, side: hand((at.x + (.2 if side == "l" else -.2), at.y, at.z), ((-.5 if side == "l" else .5), -.4, -.7), (0, .6, -.8), 1)
    pull = {"P": (0, .03, -.06), "T": (10, 0, 0), "C": (0, 14, 0, 18), "L": (0, -.1, 0, 0), "R": (0, .04, 0, 0), "WL": (1,), "WR": (1,), "G": (.9, .9),
            "HL": grip(near, "l"), "HR": grip(near, "r"), "EL": (.6, .6, -.4), "ER": (-.6, .6, -.4)}
    push = {**pull, "P": (0, -.12, -.12), "T": (24, 0, 0), "C": (0, 34, 0, 14), "R": (0, .04, 0, 20), "HL": grip(far, "l"), "HR": grip(far, "r")}
    lifted = lambda at: {**pull, "P": (0, -.02, -.07), "T": (14, 0, 0), "C": (0, 20, 0, 16), "HL": grip(at, "l"), "HR": grip(at, "r")}
    mid = near.lerp(far, .5) + Vector((0, 0, .06))
    keys = []
    for k in range(sp["strokes"]):
        o = k / sp["strokes"]
        f = 1 / sp["strokes"]
        keys += [(o, pull), (o + f * sp["push"], push), (o + f * (sp["push"] + .1), {**push, "C": (0, 32, 0, 14)}), (o + f * .8, lifted(mid))]
    return keyed_clip(actor, sp["duration"], keys, cyclic_=True), {
        "strokeSeconds": [seconds((k + sp["push"]) / sp["strokes"], sp["duration"]) for k in range(sp["strokes"])],
        "beamAt": [root_point(near), root_point(far)]}


def tanner_stretch(actor):
    """Stretching a hide on an upright frame: up on the toes to take the top corners, a pull out and down with the
    weight sinking back, a push to hook it on the pegs, and back into the idle."""
    sp = STRETCH
    corner = lambda side, x, z, y=-.46: hand(((x if side == "l" else -x), y, z), (0, -.2, 1), ((-.4 if side == "l" else .4), -1, 0), 1)
    keys = [(0.0, {}),
            (.12, {"C": (0, -4, 0, -10), "S": (8, 8), "WL": (.6,), "WR": (.6,), "HL": corner("l", .34, 1.6), "HR": corner("r", .34, 1.6), "G": (-.6, -.6)}),
            (sp["grip"], {"P": (0, -.04, .02), "T": (-2, 0, 0), "C": (0, -8, 0, -16), "L": (0, 0, .02, 22), "R": (0, 0, .02, 24), "S": (20, 20),
                          "WL": (1,), "WR": (1,), "HL": corner("l", .42, 1.82), "HR": corner("r", .42, 1.82), "G": (.9, .9),
                          "EL": (.9, .4, -.3), "ER": (-.9, .4, -.3)}),
            (.56, {"P": (0, .05, -.1), "T": (-6, 0, 0), "C": (0, -10, 0, -4), "L": (0, 0, 0, 0), "R": (0, 0, 0, 0), "S": (8, 8),
                   "HL": corner("l", .66, 1.24), "HR": corner("r", .66, 1.24), "EL": tuple(POLE["l"]), "ER": tuple(POLE["r"])}),
            (sp["hook"], {"P": (0, -.02, -.06), "T": (6, 0, 0), "C": (0, 8, 0, 4), "HL": corner("l", .66, 1.2, -.52), "HR": corner("r", .66, 1.2, -.52)}),
            (.8, {"P": (0, 0, -.03), "T": (2, 0, 0), "C": (0, 2, 0, 4), "WL": (.5,), "WR": (.5,), "G": (-.4, -.4), "S": (0, 0),
                  "HL": corner("l", .5, 1.1, -.36), "HR": corner("r", .5, 1.1, -.36)}),
            (1.0, {"P": (0, 0, 0), "T": (0, 0, 0), "C": (0, 0, 0, 0), "WL": (0,), "WR": (0,), "G": (0, 0)})]
    return keyed_clip(actor, sp["duration"], keys), {"gripSeconds": seconds(sp["grip"], sp["duration"]), "hookSeconds": seconds(sp["hook"], sp["duration"]),
                                                     "frameAt": root_point(Vector((0, -.46, 1.5)))}


AUTHORS = {"Rooted_Struggle_Loop": rooted, "Rooted_Struggle_Frozen_Loop": frozen, "Fall_Pit": fall_pit, "Blink_Out": blink_out,
           "Blink_In": blink_in, "Leap_Launch": leap_launch, "Leap_Air_Loop": leap_air, "Leap_Slam": leap_slam, "Dash_Lunge": dash_lunge,
           "Grapple_Throw": grapple_throw, "Pull_Yank": pull_yank, "Pulled_Drag": pulled, "Slip_Ice_Loop": slip_ice,
           "Tanner_Scrape_Loop": tanner_scrape, "Tanner_Stretch_Hide": tanner_stretch}


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    seed = sample(rig, actions[STAND], 0.0)
    actor = Actor(rig, seed)
    poses, observations = AUTHORS[clip](actor)
    if clip not in UPPER:
        observations["secondaryPose"] = record_chains(rig, poses)
    return poses, {"source": STAND, "durationSeconds": round((len(poses) - 1) / FPS, 4), **observations,
                   **({"layer": UPPER_ROOT, "joints": upper_joints(rig)} if clip in UPPER else {})}


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
    actions = {}
    for name in (STAND,):
        found = bpy.data.actions.get(name)
        if found is None:
            raise ValueError(f"the target GLB has no {name} clip")
        actions[name] = found
    rest_gltf = gltf_rest_worlds(target_path)
    fresh = imported_state(rig_object)
    authored = {}
    for clip in arguments["clips"]:
        restore_state(rig_object, fresh)
        authored[clip] = author(Rig(rig_object, {}, rest_gltf), clip, actions)
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
    return {"recipe": "move-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
