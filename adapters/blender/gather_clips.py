"""Original gathering loops, a chest opening and social emotes authored on the Ranger rig in Blender (#701, #422's
gathering and emotes: players and residents chopping, mining, picking herbs and skinning, opening a chest, nodding,
shaking the head, shrugging, clapping and cheering).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit hand frames solved with two-bone arm IK and, for
the full-body clips, pelvis and ankle targets solved with two-bone leg IK, on top of the first ``Idle_Loop`` pose. No
source motion is copied; the CC0 UAL1 seeds were only watched as reference.

- The tools hang on ``hand_r.weapon`` (``arguments["sockets"]["weapon"]``), as adapters/blender/held_items.py builds
  them: the business end along the item's +Y, the edge or striking face along +X. The wood axe is two-handed, the
  left hand on its ``grip.offhand`` frame below the right; the hammer (the pick) and the knife are one-handed. Their
  grips need no ``itemOffset``: each is held where held_items.py puts its grip.
- ``Gather_Chop_Loop``, ``Gather_Mine_Loop``, ``Gather_Herb_Loop``, ``Gather_Skin_Loop`` and ``Chest_Open`` are full
  body and record a skirt and cape pose for the #391 chain joints (``secondaryPose``, as the social clips). The
  emotes keep only the ``spine_01`` subtree (the observations list the joints), so a consumer plays them over standing
  or walking legs.
- ``Emote_Wave`` and ``Emote_Cheer`` already exist (#421, adapters/blender/social_clips.py, a one-armed cheer);
  ``Emote_Cheer_Both`` is the both-arms cheer.
- The loops are periodic (their last frame is their first); the one-shots start and end in the idle.

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
SOCKETS = ("weapon",)
# The hand shapes: degrees per finger joint (01, 02, 03) toward the palm, and a spread (degrees about the palm normal,
# + away from the middle finger) per finger. ``grip`` wraps a haft about 3 cm across; ``pinch`` closes the thumb on
# the index (a stem); ``cup`` is the palm under a lid or open in a shrug.
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
    "fist": {"curl": {"index": (80, 95, 60), "middle": (82, 95, 60), "ring": (84, 95, 60), "pinky": (86, 95, 60), "thumb": (30, 40, 35)},
             "spread": {}},
}
# Points in the palm frame (the wrist, +Y toward the fingers, +Z out of the palm): the middle of the palm.
PALM = Vector((0, .05, .02))

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up; metres (the pelvis stands at about z 0.91,
# the shoulders at 1.43, the ground at 0). A positive yaw turns the chest to the figure's left; a positive pitch bends
# it forward; a positive roll leans it to its left; a positive neck tips the head down; a negative gaze lets the head
# turn further than the chest.
#
# A swung tool's frame on ``hand_r.weapon``: the haft (+Y) ``angle`` degrees from straight up toward the front (0 up,
# 90 straight ahead, -90 straight back), the edge or face (+X) leading the swing.
#
# Chopping (held_items.py ``tool.wood-axe``: the head's middle ``head`` up the haft, its edge ``edge`` out along +X,
# the left hand on ``grip.offhand``, ``offhand`` below the right): keys (fraction, haft angle, grip point, chest pitch,
# pelvis dip) raised over the head, swung down, struck into a log on a block ahead (``strike``), wrenched free and
# raised. The left foot stands ``stance[0]`` ahead, the right ``stance[1]`` behind.
CHOP = {"duration": 2.0, "head": .55, "edge": .16, "offhand": -.12, "strike": .42, "stance": (.14, .1),
        "keys": ((0.0, -25.0, (-.05, -.02, 1.62), -6.0, .0),
                 (.3, 55.0, (-.04, -.3, 1.28), 14.0, .04),
                 (.42, 115.0, (-.04, -.38, .88), 40.0, .14),
                 (.56, 110.0, (-.04, -.36, .9), 38.0, .14),
                 (.78, 25.0, (-.05, -.16, 1.42), 6.0, .03))}
# Mining (held_items.py ``tool.hammer`` as the pick: the head ``head`` up the haft, its face ``face`` out along +X):
# keys (fraction, haft angle, grip point, chest yaw, chest pitch) drawn back over the right shoulder, swung, struck
# flat into a rock face ahead at chest height (``strike``; the rock stands where the face lands) and recoiling; the
# left palm braced on the rock at ``brace`` (x and height).
MINE = {"duration": 2.0, "head": .27, "face": .07, "strike": .46, "stance": (.16, .08), "brace": (.2, -.5, 1.1),
        "keys": ((0.0, -105.0, (-.2, .02, 1.5), -14.0, -2.0),
                 (.3, -45.0, (-.17, -.18, 1.42), -6.0, 4.0),
                 (.46, 2.0, (-.13, -.34, 1.08), 4.0, 12.0),
                 (.58, -10.0, (-.14, -.3, 1.14), 2.0, 10.0),
                 (.8, -70.0, (-.19, -.08, 1.48), -10.0, 2.0))}
# A crouch (``crouch_body``): the feet ``ahead`` and ``wide`` apart, the pelvis ``drop`` lower, ``back`` behind and
# tipped ``hip`` degrees forward, so the chest hinges at the hips (the spine pitch alone pivots too high to reach the
# ground with the Ranger's short arms).
#
# Picking herbs: crouched (``crouch``); each hand in turn reaches to a stem low on the ground (``reach``, the right
# hand's; the left's mirrored), pinches it and pulls it up to ``lift``, twice a loop each.
HERB = {"duration": 3.0, "crouch": {"drop": .54, "back": .08, "hip": 46.0, "ahead": .18, "wide": .06}, "reach": (-.12, -.36, .14),
        "lift": (-.07, -.28, .38), "pitch": 30.0, "neck": 6.0, "picks": ((0.0, "r"), (.25, "l"), (.5, "r"), (.75, "l"))}
# Skinning: kneeling on the right knee over a carcass ahead (the pelvis ``kneel`` lower and tipped ``hip`` degrees,
# the left foot ``step`` forward), the left hand pulling the hide up at ``hold``, the right drawing the knife
# (held_items.py ``dagger.plain``, blade along +Y pointing down into the hide, edge along +X leading) along ``stroke``,
# lifting it ``lift`` back, ``strokes`` a loop.
SKIN = {"duration": 3.0, "kneel": .42, "step": .3, "strokes": 2, "hold": (.12, -.46, .36), "stroke": ((-.12, -.36, .48), (-.02, -.48, .44)),
        "lift": .07, "hip": 40.0, "pitch": 24.0, "neck": 16.0}
# The chest: its lid's front edge ``front`` ahead at ``height``, ``width`` across, the hinge ``depth`` behind it. The
# figure crouches (``crouch``), puts both palms under the lid's edge, lifts it from ``lift[0]`` to ``lift[1]`` up to
# ``reach`` degrees, lets go (the lid falls on to ``open``) and stands.
CHEST = {"duration": 1.5, "front": -.38, "height": .55, "depth": .36, "width": .3, "open": 100.0, "reach": 65.0, "pitch": 16.0,
         "crouch": {"drop": .38, "back": .06, "hip": 40.0, "ahead": .1, "wide": .06}, "lift": (.3, .62)}
# The emotes: nods and shakes (fraction, value) blended smoothly.
YES = {"duration": 1.2, "keys": ((0.0, 0.0), (.15, 0.0), (.3, 14.0), (.45, -2.0), (.6, 12.0), (.76, 0.0), (1.0, 0.0))}
NO = {"duration": 1.2, "keys": ((0.0, 0.0), (.12, 0.0), (.26, 20.0), (.42, -20.0), (.58, 18.0), (.74, -14.0), (.88, 0.0), (1.0, 0.0))}
# The shrug: the forearms out, palms up (``hands``, the right's, in the chest's frame at the seed), the shoulders up
# ``shrug`` degrees and the head tilted ``tilt``, held from ``hold[0]`` to ``hold[1]``.
SHRUG = {"duration": 1.2, "hold": (.3, .66), "hands": (-.3, -.22, 1.1), "shrug": 9.0, "tilt": 8.0}
# The clap: the palms meet before the chest at ``at`` (the chest's frame at the seed), ``claps`` times, opening
# ``open`` metres apart between claps.
CLAP = {"duration": 2.0, "at": (0, -.3, 1.18), "claps": 4, "open": .12, "start": .2, "end": .8}
# The cheer: both fists overhead (``fist``, the right's, the left's mirrored) pumped ``pumps`` times, the head back.
CHEER = {"duration": 1.5, "fist": (-.2, -.04, 1.9), "pump": .07, "pumps": 2, "hold": (.24, .8), "neck": -14.0, "pitch": -5.0}

UPPER = {"Emote_Yes", "Emote_No", "Emote_Shrug", "Emote_Clap", "Emote_Cheer_Both"}
CLIPS = ("Gather_Chop_Loop", "Gather_Mine_Loop", "Gather_Herb_Loop", "Gather_Skin_Loop", "Chest_Open", "Emote_Yes", "Emote_No",
         "Emote_Shrug", "Emote_Clap", "Emote_Cheer_Both")
# The #391 chain joints the full-body clips key, and how far the panels follow the thighs (as the social clips).
CAPE = "cape_01"
SWING = {"share": .7, "front": 70.0, "sideShare": .8, "side": 75.0, "back": 20.0}
BACK = Vector((0, 1, 0))
PLUMB = ("skirt_f_03", "skirt_l_02", "skirt_r_02")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets"}:
        raise ValueError("gather clips require exactly schemaVersion, clips and sockets")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"gather clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"gather clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    if set(inputs) != {"target"}:
        raise ValueError("gather clips take exactly the declared input target")


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
    """The clip-independent state: the seed pose, the seed's palms and feet, the right palm in the weapon frame and the
    finger shapes."""

    def __init__(self, rig, seed):
        self.rig, self.seed = rig, seed
        rig.apply(seed)
        self.seed_joint = {name: rig.bones[name].matrix.copy() for name in ("pelvis", "spine_03", "Head")}
        self.seed_palm = {side: rig.grip(f"palm_{side}") for side in "lr"}
        self.weapon_palm = rig.grip("weapon").inverted() @ rig.grip("palm_r")
        self.feet = feet_of(rig)
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


def kneel_body(rig, feet, down):
    """Kneel on the right knee as the social and cast kneels (#443): the pelvis drops ``kneel``, the left foot steps
    ``step`` forward under the left knee, the right knee goes down behind with the toes on the ground."""
    left_ankle, left_matrix, _ = feet["l"]
    right_ankle, right_matrix, _ = feet["r"]
    move_pelvis(rig, Vector((0, .1 * down, -SKIN["kneel"] * down)))
    rotate_world(rig, "pelvis", X, SKIN["hip"] * down)
    la = left_ankle + Vector((0, -SKIN["step"], 0)) * window(down, .0, .6)
    ra = right_ankle + Vector((0, .3, .06)) * window(down, .2, 1.0)
    plant_feet(rig, {"l": (la, left_matrix, Vector((0, -1, .2))), "r": (ra, right_matrix, Vector((0, -.6, -1)))})
    if down > 1e-3:
        rotate_world(rig, "foot_r", X, -50 * window(down, .2, 1.0))


def stance_body(actor, stance, dip=0.0, shift=0.0):
    """Feet planted in a stance (the left ankle ``stance[0]`` ahead, the right ``stance[1]`` behind), the pelvis
    ``dip`` lower and ``shift`` to the figure's left, the knees bending over the feet (as the chore clips)."""
    rig = actor.rig
    move_pelvis(rig, Vector((shift, (stance[1] - stance[0]) * .5 * .3, -dip)))
    planted = {}
    for side, ahead in (("l", -stance[0]), ("r", stance[1])):
        ankle, matrix, _ = actor.feet[side]
        planted[side] = (ankle + Vector((0, ahead, 0)), matrix, Vector((0, -1, .1)))
    plant_feet(rig, planted)


def crouch_body(actor, w, crouch):
    """Crouching ``w`` of the way (0 stands): the feet step ``ahead`` and ``wide`` apart, the pelvis drops ``drop``,
    moves ``back`` and tips ``hip`` degrees forward (the chest hinges at the hips), the knees splay out over the feet."""
    rig = actor.rig
    move_pelvis(rig, Vector((0, crouch["back"] * w, -crouch["drop"] * w)))
    rotate_world(rig, "pelvis", X, crouch["hip"] * w)
    plant_feet(rig, {side: (ankle + w * Vector((crouch["wide"] * (1 if side == "l" else -1), -crouch["ahead"], 0)), matrix,
                            Vector((.35 if side == "l" else -.35, -1, .2)))
                     for side, (ankle, matrix, _) in actor.feet.items()})


def shaft_palm(point, shaft, around, flip=False):
    """The palm wrapped round a shaft through ``point``: the palm on the ``around`` side of the shaft facing it, the
    fingers curling across it (``flip`` sends them the other way round)."""
    shaft = shaft.normalized()
    n = (around - shaft * around.dot(shaft)).normalized()
    fingers = shaft.cross(n) * (-1 if flip else 1)
    return palm_frame(point + n * .03, fingers, -n)


def swung(angle, grip):
    """The ``hand_r.weapon`` frame of a swung tool at ``grip``: the haft (+Y) ``angle`` degrees from straight up toward
    the front, the edge or face (+X) leading a forward swing."""
    a = math.radians(angle)
    haft = Vector((0, -math.sin(a), math.cos(a)))
    edge = Vector((0, -math.cos(a), -math.sin(a)))
    return frame_of(grip, haft, edge.cross(haft))


def swing_keys(keys):
    """The keys of a swing as (fraction, Vector(angle, grip x, y, z, a, b)) for ``cyclic``."""
    return [(u, Vector((angle, *grip, a, b))) for u, angle, grip, a, b in keys]


def swing_at(keys, u):
    k = cyclic(keys, u)
    return swung(k[0], Vector(k[1:4])), k[4], k[5]


def mirror(p):
    return Vector((-p.x, p.y, p.z))


# --- Gathering -------------------------------------------------------------------------------------------------------

def chop(actor):
    """Chopping a log with the wood axe in both hands, the left below the right on its ``grip.offhand``: raised over
    the head, swung down into the log ahead, wrenched free and raised again, once a loop; the pelvis dips into the
    strike."""
    spec = CHOP
    keys = swing_keys(spec["keys"])
    edge_point = Vector((spec["edge"], spec["head"], 0))

    def frame(u):
        weapon, pitch, dip = swing_at(keys, u)
        haft = weapon.to_3x3().col[1]
        palm = weapon @ actor.weapon_palm @ PALM
        around = palm - weapon.translation
        hands = lambda: {"r": ("weapon", weapon), "l": ("palm_l", shaft_palm(weapon.translation + haft * spec["offhand"], haft, around, True))}
        return actor.pose(hands, {"pitch": pitch, "neck": 8.0 + pitch * .2}, {"r": "grip", "l": "grip"},
                          lambda: stance_body(actor, spec["stance"], dip))

    poses = loop(spec["duration"], frame)
    strike = spec["strike"]
    edge = swing_at(keys, strike)[0] @ edge_point
    return poses, {"strikeSeconds": round(strike * spec["duration"], 4), "contactSeconds": round(strike * spec["duration"], 4),
                   "tool": {"item": "equipment.tool.wood-axe", "socket": "hand_r.weapon", "offhand": "grip.offhand", "edgeAt": root_point(edge)}}


def mine(actor):
    """Mining a rock face at chest height with the hammer as the pick, one-handed: drawn back over the right shoulder,
    swung and struck flat into the rock, recoiling, once a loop; the left palm braced on the rock beside the strike."""
    spec = MINE
    keys = swing_keys(spec["keys"])
    face_point = Vector((spec["face"], spec["head"], 0))
    strike = spec["strike"]
    face = swing_at(keys, strike)[0] @ face_point
    brace = Vector((spec["brace"][0], face.y, spec["brace"][2]))

    def frame(u):
        weapon, yaw, pitch = swing_at(keys, u)
        hands = lambda: {"r": ("weapon", weapon), "l": ("palm_l", palm_frame(brace, Vector((-.25, 0, 1)), Vector((0, -1, 0))))}
        return actor.pose(hands, {"yaw": yaw, "pitch": pitch, "neck": 4.0}, {"r": "grip", "l": "flat"},
                          lambda: stance_body(actor, spec["stance"], .04))

    poses = loop(spec["duration"], frame)
    return poses, {"strikeSeconds": round(strike * spec["duration"], 4), "contactSeconds": round(strike * spec["duration"], 4),
                   "tool": {"item": "equipment.tool.hammer", "socket": "hand_r.weapon", "faceAt": root_point(face)}}


def herb(actor):
    """Picking herbs crouched: each hand in turn reaches down to a stem, pinches it and pulls it up, twice a loop each;
    the chest bent over the ground and the head looking down."""
    spec, rig = HERB, actor.rig
    reach, lift = v(spec["reach"]), v(spec["lift"])

    body = lambda: crouch_body(actor, 1.0, spec["crouch"])

    def hand(side, u):
        start = next(s for s, who in spec["picks"] if who == side)
        p = ((u - start) % .5) / .5
        down = window(p, 0, .35) * (1 - window(p, .5, .85))
        pinch = window(p, .3, .4) * (1 - window(p, .85, .95))
        at = lift.lerp(reach, down)
        sign = 1 if side == "r" else -1
        frame = palm_frame(at if side == "r" else mirror(at), Vector((0, -.5, -1)), Vector((sign, 0, 0)))
        return ("palm_" + side, frame), ("cup", "pinch", pinch)

    def frame(u):
        held = {side: hand(side, u) for side in "rl"}
        return actor.pose(lambda: {side: grip for side, (grip, _) in held.items()}, {"pitch": spec["pitch"], "neck": spec["neck"]},
                          {side: shape for side, (_, shape) in held.items()}, body)

    picks = [round((start + .5 * k + .35) % 1.0 * spec["duration"], 4) for k in (0, 1) for start, _ in spec["picks"][:2]]
    return loop(spec["duration"], frame), {"pickSeconds": sorted(picks)}


def skin(actor):
    """Skinning a carcass, kneeling on the right knee over it: the left hand pulls the hide up, the right draws the
    knife along it and lifts it back, ``strokes`` a loop."""
    spec, rig = SKIN, actor.rig
    a, b = (v(p) for p in spec["stroke"])
    along = (b - a).normalized()

    def frame(u):
        phase = (u * spec["strokes"]) % 1.0
        draw = smooth(phase / .6) if phase < .6 else 1 - smooth((phase - .6) / .4)
        rise = spec["lift"] * math.sin(math.pi * (phase - .6) / .4) if phase >= .6 else 0.0
        blade = Vector((0, -.5, -1)).normalized()
        knife = frame_of(a.lerp(b, draw) + UP * rise, blade, along.cross(blade))
        hide = palm_frame(v(spec["hold"]) + UP * .03 * draw, Vector((0, -.4, -1)), Vector((-1, 0, 0)))
        hands = lambda: {"r": ("weapon", knife), "l": ("palm_l", hide)}
        chest = {"pitch": spec["pitch"] + 2.0 * draw, "yaw": -4.0 * draw, "neck": spec["neck"]}
        return actor.pose(hands, chest, {"r": "grip", "l": "grip"}, lambda: kneel_body(rig, actor.feet, 1.0))

    starts = [round(k * spec["duration"] / spec["strokes"], 4) for k in range(spec["strokes"])]
    return loop(spec["duration"], frame), {"strokeSeconds": starts, "kneelDropMeters": spec["kneel"],
                                           "tool": {"item": "equipment.dagger.plain", "socket": "hand_r.weapon"}}


def chest_open(actor):
    """Opening a chest: crouching, the palms under the lid's front edge, lifting it about its hinge until it falls
    open, letting go and standing again."""
    spec, rig = CHEST, actor.rig
    start, end = spec["lift"]
    hinge = Vector((0, spec["front"] - spec["depth"], spec["height"]))
    reach = spec["reach"]

    def lid(angle, side):
        """The palm under the lid's front edge on ``side`` with the lid ``angle`` degrees open."""
        a = math.radians(angle)
        f = Vector((0, math.cos(a), math.sin(a)))
        n = Vector((0, -math.sin(a), math.cos(a)))
        edge = hinge + f * spec["depth"] + Vector((spec["width"] * .5 * (-1 if side == "r" else 1), 0, 0))
        return palm_frame(edge - n * .03 - f * .03, -f, n)

    def frame(u):
        crouch = window(u, 0, .28) * (1 - window(u, .62, 1.0))
        hold = window(u, .1, start) * (1 - window(u, end, end + .14))
        angle = reach * window(u, start, end)

        body = lambda: crouch_body(actor, crouch, spec["crouch"])

        hands = lambda: {side: ("palm_" + side, blend(actor.seed_palm[side], lid(angle, side), hold)) for side in "rl"}
        chest = {"pitch": spec["pitch"] * crouch, "neck": 10.0 * crouch}
        return actor.pose(hands, chest, {side: ("seed", "cup", hold) for side in "rl"}, body)

    return one_shot(spec["duration"], frame), {
        "lidSeconds": [round(start * spec["duration"], 4), round(end * spec["duration"], 4)], "lidHingeAt": root_point(hinge),
        "lidDepthMeters": spec["depth"], "lidOpenDegrees": spec["open"]}


# --- Emotes ----------------------------------------------------------------------------------------------------------

def nod(actor):
    """Yes: two nods."""
    spec = YES

    def frame(u):
        n = track(spec["keys"], u)
        return actor.pose(None, {"neck": n, "pitch": .15 * n})

    return one_shot(spec["duration"], frame), {}


def shake(actor):
    """No: the head shakes twice."""
    spec = NO
    return one_shot(spec["duration"], lambda u: actor.pose(None, {"look": track(spec["keys"], u)})), {}


def shrug(actor):
    """The shrug: the forearms out with the palms up, the shoulders up and the head tilted; held and lowered."""
    spec, rig = SHRUG, actor.rig
    start, end = spec["hold"]
    right = palm_frame(v(spec["hands"]), Vector((-.45, -1, .05)), UP)
    left = palm_frame(mirror(v(spec["hands"])), Vector((.45, -1, .05)), UP)

    def frame(u):
        w = track(((0.0, 0.0), (start, 1.0), (end, 1.0), (1.0, 0.0)), u)

        def body():
            rotate_world(rig, "clavicle_r", Y, spec["shrug"] * w)
            rotate_world(rig, "clavicle_l", Y, -spec["shrug"] * w)
            rotate_world(rig, "neck_01", Y, -spec["tilt"] * w)

        hands = lambda: {"r": ("palm_r", blend(actor.seed_palm["r"], actor.carry("spine_03") @ right, w)),
                         "l": ("palm_l", blend(actor.seed_palm["l"], actor.carry("spine_03") @ left, w))}
        return actor.pose(hands, {"pitch": -2.0 * w}, {"r": ("seed", "cup", w), "l": ("seed", "cup", w)}, body)

    return one_shot(spec["duration"], frame), {}


def clap(actor):
    """Clapping ``claps`` times before the chest, the palms meeting and opening between claps."""
    spec = CLAP
    at = v(spec["at"])
    start, end, claps = spec["start"], spec["end"], spec["claps"]

    def frame(u):
        w = track(((0.0, 0.0), (start, 1.0), (end, 1.0), (1.0, 0.0)), u)
        s = min(1.0, max(0.0, (u - start) / (end - start)))
        gap = .03 + spec["open"] * abs(math.cos(math.pi * claps * s))
        right = palm_frame(at + Vector((-gap / 2, 0, 0)), Vector((0, -.6, 1)), X)
        left = palm_frame(at + Vector((gap / 2, 0, 0)), Vector((0, -.6, 1)), -X)
        hands = lambda: {"r": ("palm_r", blend(actor.seed_palm["r"], actor.carry("spine_03") @ right, w)),
                         "l": ("palm_l", blend(actor.seed_palm["l"], actor.carry("spine_03") @ left, w))}
        return actor.pose(hands, {"pitch": 2.0 * w, "neck": 3.0 * w}, {"r": ("seed", "flat", w), "l": ("seed", "flat", w)})

    seconds = [round((start + (k + .5) / claps * (end - start)) * spec["duration"], 4) for k in range(claps)]
    return one_shot(spec["duration"], frame), {"clapSeconds": seconds}


def cheer(actor):
    """Cheering with both arms up: the fists thrown overhead and pumped, the head back; held and lowered."""
    spec = CHEER
    start, end = spec["hold"]

    def frame(u):
        w = track(((0.0, 0.0), (start, 1.0), (end, 1.0), (1.0, 0.0)), u)
        s = min(1.0, max(0.0, (u - start) / (end - start)))
        lift = UP * (-spec["pump"] * abs(math.sin(math.pi * spec["pumps"] * s)))
        right = palm_frame(v(spec["fist"]) + lift, Vector((.15, -.1, 1)), Vector((0, -1, 0)))
        left = palm_frame(mirror(v(spec["fist"])) + lift, Vector((-.15, -.1, 1)), Vector((0, -1, 0)))
        hands = lambda: {"r": ("palm_r", blend(actor.seed_palm["r"], actor.carry("spine_03") @ right, w)),
                         "l": ("palm_l", blend(actor.seed_palm["l"], actor.carry("spine_03") @ left, w))}
        return actor.pose(hands, {"pitch": spec["pitch"] * w, "neck": spec["neck"] * w}, {"r": ("seed", "fist", w), "l": ("seed", "fist", w)})

    return one_shot(spec["duration"], frame), {}


AUTHORS = {"Gather_Chop_Loop": chop, "Gather_Mine_Loop": mine, "Gather_Herb_Loop": herb, "Gather_Skin_Loop": skin, "Chest_Open": chest_open,
           "Emote_Yes": nod, "Emote_No": shake, "Emote_Shrug": shrug, "Emote_Clap": clap, "Emote_Cheer_Both": cheer}


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    seed = sample(rig, actions[STAND], 0.0)
    poses, observations = AUTHORS[clip](Actor(rig, seed))
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
    return {"recipe": "gather-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
