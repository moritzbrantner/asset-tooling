"""Original raid, repair, push, trap and knockdown clips authored on the Ranger rig in Blender (#705, #422's night
raids, repairs, pushables, traps and knockdowns: a raider carrying a torch and hacking a palisade, a resident carrying a
crate, hammering a board, pushing a cart, pulling a lever, setting and disarming a trap, and anyone knocked down,
lying and getting up).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit hand frames solved with two-bone arm IK and, for
the full-body clips, pelvis and ankle targets solved with two-bone leg IK, on top of the first ``Idle_Loop`` pose (the
walking clips on each ``Walk_Loop`` frame instead). No source motion is copied; the CC0 UAL1 seeds were only watched as
reference.

- The torch, the battle axe and the hammer hang on ``hand_r.weapon`` (``arguments["sockets"]["weapon"]``), as
  adapters/blender/held_items.py builds them: the business end along the item's +Y, the edge or striking face along
  +X. Each is held at its own grip, so none needs an ``itemOffset``.
- The two-handed load (a crate or a sack) rides ``chest.carry`` (``arguments["sockets"]["carry"]``) on ``spine_03``:
  the middle of the load's face against the chest, +Y up, +Z away from the chest. The palms hold the sides of a
  reference load ``LOAD["size"]`` across.
- ``Raid_Torch_Carry_Loop``, ``Raid_Hack_Structure_Loop``, ``Carry_Idle_Loop`` and ``Carry_Walk_Loop`` keep only the
  ``spine_01`` subtree (the observations list the joints), so a consumer plays them over standing or walking legs;
  ``Carry_Walk_Loop`` has ``Walk_Loop``'s length and its upper body. The others are full body and record a skirt and
  cape pose for the #391 chain joints (``secondaryPose``, as the social clips); ``Push_Loop`` walks on ``Walk_Loop``'s
  legs.
- The loops are periodic (their last frame is their first); the one-shots start and end in the idle, except
  ``Push_Start`` (ends in ``Push_Loop``'s first frame), ``Knockdown_Fall`` (ends in ``Lie_Loop``'s first frame) and
  ``GetUp`` (starts there).
- #823: ``Carry_Run_Loop`` is the loaded run's upper body over ``Heavy_Run_Fwd_Loop`` (gait_clips.py), of its length:
  ``Sprint_Loop``'s pelvis at the same phase under the idle's still spine, the trunk stood up against the load and
  the palms braced on its sides.

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
WALK = "Walk_Loop"
SPRINT = "Sprint_Loop"
ARMS = {"l": ("upperarm_l", "lowerarm_l", "hand_l"), "r": ("upperarm_r", "lowerarm_r", "hand_r")}
LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
SPINE = (("spine_01", .3), ("spine_02", .35), ("spine_03", .35))
X, Y, UP = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
POLE = {"r": Vector((-.8, .35, -.5)), "l": Vector((.8, .35, -.5))}
FINGERS = ("index", "middle", "ring", "pinky", "thumb")
SOCKETS = ("weapon", "carry")
# The hand shapes: degrees per finger joint (01, 02, 03) toward the palm, and a spread (degrees about the palm normal,
# + away from the middle finger) per finger. ``grip`` wraps a haft about 3 cm across; ``pinch`` closes the thumb on
# the index (a trigger or a spring); ``cup`` is the palm under a load's edge; ``brace`` is the open hand flat on the
# side of a load, the thumb laid back along the face (#740: ``cup`` curled the fingers and thumb into the load).
SHAPES = {
    "flat": {"curl": {"index": (0, 2, 2), "middle": (0, 2, 2), "ring": (0, 2, 2), "pinky": (0, 3, 2), "thumb": (0, 4, 4)},
             "spread": {"index": 3, "ring": 3, "pinky": 6, "thumb": 8}},
    "rest": {"curl": {"index": (14, 18, 12), "middle": (16, 20, 12), "ring": (18, 22, 14), "pinky": (20, 24, 14), "thumb": (6, 10, 10)},
             "spread": {"pinky": 4}},
    "cup": {"curl": {"index": (28, 30, 20), "middle": (30, 34, 22), "ring": (32, 36, 22), "pinky": (34, 38, 24), "thumb": (10, 20, 20)},
            "spread": {"index": 4, "ring": 4, "pinky": 8}},
    "grip": {"curl": {"index": (50, 70, 45), "middle": (52, 72, 46), "ring": (54, 72, 46), "pinky": (56, 74, 48), "thumb": (25, 35, 30)},
             "spread": {}},
    "brace": {"curl": {"index": (6, 8, 6), "middle": (6, 8, 6), "ring": (8, 10, 6), "pinky": (8, 10, 8), "thumb": (-40, -6, 0)},
              "spread": {"index": 2, "ring": 2, "pinky": 5, "thumb": 6}},
    "pinch": {"curl": {"index": (40, 45, 30), "middle": (50, 60, 40), "ring": (56, 66, 44), "pinky": (60, 70, 46), "thumb": (30, 30, 25)},
              "spread": {}},
}
# Points in the palm frame (the wrist, +Y toward the fingers, +Z out of the palm): the middle of the palm.
PALM = Vector((0, .05, .02))

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up; metres (the pelvis stands at about z 0.91,
# the shoulders at 1.43, the ground at 0). A positive yaw turns the chest to the figure's left; a positive pitch bends
# it forward; a positive roll leans it to its left; a positive neck tips the head down.
#
# A swung tool's frame on ``hand_r.weapon``: the haft (+Y) ``angle`` degrees from straight up toward the front (0 up,
# 90 straight ahead, -90 straight back), the edge or face (+X) leading the swing.
#
# The raised torch (held_items.py ``tool.torch``, the flame ``flame`` up the haft): the fist at ``grip`` beside the
# head, the haft ``angle`` degrees forward, circling ``sway`` metres once a loop while the chest breathes.
TORCH = {"duration": 2.0, "grip": (-.3, -.14, 1.6), "angle": 12.0, "sway": .025, "flame": .45}
# Hacking a palisade (held_items.py ``axe.battle``: the head ``head`` up the haft, its edge ``edge`` out along +X):
# keys (fraction, haft angle, grip point, chest yaw, chest pitch) drawn back over the right shoulder, struck into a
# wall ahead (``strike``; the wall stands where the edge lands), wrenched free and drawn back; the left arm braced.
HACK = {"duration": 1.5, "head": .54, "edge": .19, "strike": .45,
        "keys": ((0.0, -95.0, (-.22, .0, 1.55), -16.0, -3.0),
                 (.3, -40.0, (-.2, -.16, 1.5), -8.0, 2.0),
                 (.45, 40.0, (-.12, -.3, 1.06), 8.0, 14.0),
                 (.58, 32.0, (-.13, -.28, 1.1), 6.0, 12.0),
                 (.8, -60.0, (-.21, -.1, 1.52), -12.0, 0.0))}
# The load: a crate ``size`` (width, height, depth) on ``chest.carry``; the palms on its sides ``hold`` (up from the
# socket, out from the chest, ``gap`` off the face for the skin) with the fingers ``fingers`` (socket frame) toward the
# bottom front edge, the chest leaning ``lean`` degrees back. The idle breathes once a loop; the walk keeps the load
# still against the chest.
LOAD = {"idle": 3.0, "size": (.36, .26, .26), "hold": (-.08, .12), "gap": .012, "fingers": (0, -.3, 1), "lean": -4.0}
# A crouch (``crouch_body``): the feet ``ahead`` and ``wide`` apart, the pelvis ``drop`` lower, ``back`` behind and
# tipped ``hip`` degrees forward, so the chest hinges at the hips.
#
# Repairing: crouched over a board (``board``, its top's middle) on a trestle, the left palm holding it and a nail
# beside the strike, the hammer (held_items.py ``tool.hammer``, its face ``face`` out along +X ``head`` up the haft)
# raised and struck down on the nail ``strikes`` a loop; keys (fraction of a stroke, haft angle, grip point).
REPAIR = {"duration": 1.5, "crouch": {"drop": .4, "back": .04, "hip": 28.0, "ahead": .14, "wide": .1}, "head": .27, "face": .07,
          "board": (-.06, -.48, .4), "hold": (.12, -.44, .4), "strikes": 2, "strike": .4, "pitch": 12.0, "neck": 18.0,
          "keys": ((0.0, 30.0, (-.12, -.22, .82)), (.4, 92.0, (-.1, -.2, .5)), (.55, 80.0, (-.11, -.21, .54)))}
# Pushing: both palms flat on a crate's face ``hands`` (the right's; x mirrored) ahead, the pelvis ``drop`` lower and
# ``forward``, tipped ``hip`` degrees, the chest pitched ``pitch``; the loop walks on ``Walk_Loop``'s legs with the
# feet ``back`` behind them. ``Push_Start`` leans in from the idle over ``Push_Loop``'s first frame.
PUSH = {"start": .6, "hands": (-.2, -.6, 1.04), "drop": .08, "forward": -.12, "hip": 22.0, "pitch": 14.0, "back": .22}
# The lever: its pivot ``pivot`` ahead, the handle bar ``length`` up it, pulled from ``angles[0]`` to ``angles[1]``
# degrees (from straight up, toward the figure) between ``pull[0]`` and ``pull[1]``; both hands on the bar ``span``
# apart, the body leaning back as it pulls.
LEVER = {"duration": 1.2, "pivot": (0, -.45, .75), "length": .5, "angles": (-10.0, 30.0), "span": .18, "pull": (.3, .62),
         "reach": (.12, .3), "release": (.72, .9)}
# Kneeling on the right knee (``kneel_body``, as the social and cast kneels): the pelvis ``drop`` lower and tipped
# ``hip`` degrees, the left foot ``step`` forward.
KNEEL = {"drop": .44, "step": .3, "hip": 40.0}
# The trap: set down ahead with both palms, ``at`` the middle of its open jaws; disarmed with the left palm holding its
# jaw and the right fingers working the spring, ``probes`` a loop.
TRAP = {"place": 1.5, "disarm": 3.0, "at": (-.12, -.32, .1), "width": .2, "carry": (-.08, -.28, .95), "down": (.2, .75), "set": .52,
        "pitch": 40.0, "neck": 10.0, "probes": 3, "reach": (40.0, 20.0)}
# The knockdown: the body tips back about the ankles and lands on its back (``land``), the pelvis ``lie`` (its back,
# height) behind the origin, tipped ``tip`` degrees back, the feet ``feet`` ahead with the knees a little bent.
DOWN = {"fall": .8, "lie": 3.0, "getUp": 1.5, "land": .72, "pelvis": (.42, .13), "tip": -86.0, "feet": (-.42, .07)}

UPPER = {"Raid_Torch_Carry_Loop", "Raid_Hack_Structure_Loop", "Carry_Idle_Loop", "Carry_Walk_Loop", "Carry_Run_Loop"}
CLIPS = ("Raid_Torch_Carry_Loop", "Raid_Hack_Structure_Loop", "Carry_Idle_Loop", "Carry_Walk_Loop", "Repair_Hammer_Loop", "Push_Start",
         "Push_Loop", "Lever_Pull", "Trap_Place", "Trap_Disarm_Loop", "Knockdown_Fall", "Lie_Loop", "GetUp", "Carry_Run_Loop")
# The #391 chain joints the full-body clips key, and how far the panels follow the thighs (as the social clips).
CAPE = "cape_01"
SWING = {"share": .7, "front": 70.0, "sideShare": .8, "side": 75.0, "back": 20.0}
BACK = Vector((0, 1, 0))
PLUMB = ("skirt_f_03", "skirt_l_02", "skirt_r_02")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets"}:
        raise ValueError("raid clips require exactly schemaVersion, clips and sockets")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"raid clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"raid clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    if set(inputs) != {"target"}:
        raise ValueError("raid clips take exactly the declared input target")


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


def kneel_body(rig, feet, down, reach=(0.0, 0.0)):
    """Kneel on the right knee as the social and cast kneels (#443): the pelvis drops ``drop``, the left foot steps
    ``step`` forward under the left knee, the right knee goes down behind with the toes on the ground; the shoulders
    roll ``reach`` (right, left) degrees forward to bring the hands to the ground (the idle holds the right one back)."""
    if down <= 0:
        return
    left_ankle, left_matrix, _ = feet["l"]
    right_ankle, right_matrix, _ = feet["r"]
    move_pelvis(rig, Vector((0, .1 * down, -KNEEL["drop"] * down)))
    rotate_world(rig, "pelvis", X, KNEEL["hip"] * down)
    la = left_ankle + Vector((0, -KNEEL["step"], 0)) * window(down, .0, .6)
    ra = right_ankle + Vector((0, .3, .06)) * window(down, .2, 1.0)
    plant_feet(rig, {"l": (la, left_matrix, Vector((0, -1, .2))), "r": (ra, right_matrix, Vector((0, -.6, -1)))})
    if down > 1e-3:
        rotate_world(rig, "foot_r", X, -50 * window(down, .2, 1.0))
    for side in "lr":
        sign = 1 if side == "r" else -1
        rotate_world(rig, f"clavicle_{side}", UP, sign * reach[side == "l"] * down)
        rotate_world(rig, f"clavicle_{side}", Y, -sign * .5 * reach[side == "l"] * down)


def blend_poses(a, b, w):
    return {name: blend(a[name], b[name], w) for name in a}


# --- Raiding ---------------------------------------------------------------------------------------------------------

def torch(actor):
    """The torch raised beside the head in the right fist, circling a little while the chest breathes."""
    spec = TORCH

    def held(u):
        a = 2 * math.pi * u
        sway = spec["sway"]
        grip = v(spec["grip"]) + Vector((sway * math.cos(a), .5 * sway * math.sin(a), .4 * sway * math.sin(2 * a)))
        return swung(spec["angle"] + 3.0 * math.sin(a), grip)

    def frame(u):
        a = 2 * math.pi * u
        hands = lambda: {"r": ("weapon", actor.carry("spine_03") @ held(u))}
        return actor.pose(hands, {"pitch": -1.0 * math.sin(a), "neck": -2.0 + 1.5 * math.sin(a + .6), "yaw": 2.0 * math.sin(a)}, {"r": "grip"})

    return loop(spec["duration"], frame), {
        "tool": {"item": "equipment.tool.torch", "socket": "hand_r.weapon", "flameAt": root_point(held(0.0) @ Vector((0, spec["flame"], 0)))}}


def hack(actor):
    """Hacking a palisade with the battle axe, one-handed: drawn back over the right shoulder, struck into the wall
    ahead, wrenched free and drawn back again, once a loop."""
    spec = HACK
    keys = swing_keys(spec["keys"])
    edge_point = Vector((spec["edge"], spec["head"], 0))
    strike = spec["strike"]

    def frame(u):
        weapon, yaw, pitch = swing_at(keys, u)
        return actor.pose(lambda: {"r": ("weapon", weapon)}, {"yaw": yaw, "pitch": pitch, "neck": 4.0}, {"r": "grip", "l": "rest"})

    edge = swing_at(keys, strike)[0] @ edge_point
    return loop(spec["duration"], frame), {"strikeSeconds": round(strike * spec["duration"], 4), "contactSeconds": round(strike * spec["duration"], 4),
                                           "tool": {"item": "equipment.axe.battle", "socket": "hand_r.weapon", "edgeAt": root_point(edge)}}


# --- Carrying a load -------------------------------------------------------------------------------------------------

def load_hands(actor, gap=LOAD["gap"]):
    """Both palms flat on the sides of the load on ``chest.carry``, the fingers toward its bottom front edge."""
    width = LOAD["size"][0]
    up, out = LOAD["hold"]
    load = actor.rig.grip("carry")
    turn = load.to_3x3()
    hands = {}
    for side, sign in (("r", -1), ("l", 1)):
        inward = turn @ Vector((-sign, 0, 0))
        hands[side] = ("palm_" + side, palm_frame(load @ Vector((sign * (width * .5 + gap), up, out)), turn @ v(LOAD["fingers"]), inward))
    return hands


def load_observation():
    return {"load": {"socket": "chest.carry", "sizeMeters": list(LOAD["size"])}}


def carry_idle(actor):
    """The load held against the chest in both hands, the chest leaning back from it and breathing once a loop."""
    def frame(u):
        a = 2 * math.pi * u
        chest = {"pitch": LOAD["lean"] - 1.2 * math.sin(a), "neck": 2.0 + 1.0 * math.sin(a + .6)}
        return actor.pose(lambda: load_hands(actor), chest, {"r": "brace", "l": "brace"})

    return loop(LOAD["idle"], frame), load_observation()


def carry_walk(actor, walk):
    """The walk's upper body with the load against the chest: the arms hold it still, the chest leans back."""
    rig = actor.rig
    duration = action_seconds(walk)

    def frame(u):
        pose = sample(rig, walk, u * duration)
        return actor.pose(lambda: load_hands(actor), {"pitch": LOAD["lean"]}, {"r": "brace", "l": "brace"}, lambda: rig.apply(pose))

    return loop(duration, frame), {**load_observation(), "source": WALK}


# #823: the loaded run's upper body, over ``Heavy_Run_Fwd_Loop``'s legs (gait_clips.py) and of its length ``period``,
# sampled on ``Sprint_Loop`` at the same phase (``HEAVY``'s ``source`` and ``period``) for the pelvis it stands on. A
# loaded trunk does not twist with the stride: the spine is the idle's, its small of the back hauled ``lumbar`` degrees
# back against the load's weight and the upper chest curled ``over`` it, so the load's bottom stands off the belly and
# the driving thighs; the chest gives forward at each footfall (``give``) as the weight lands, and the head ``neck`` up
# to see over the load. Both palms brace the load's sides, ``gap`` off them (the running wrists turn in further than the
# walking ones).
RUN_LOAD = {"period": 16 / 30, "trunk": 9.0, "over": -14.0, "give": 2.5, "neck": -6.0, "gap": .04}
RUN_SPINE = ("spine_01", "spine_02", "spine_03", "neck_01", "Head")
# The elbows held out wide of the load, so the forearms clear its sides.
ELBOWS_OUT = {"r": Vector((-1, .15, -.1)), "l": Vector((1, .15, -.1))}


def carry_run(actor, sprint):
    """The heavy run's upper body with the load against the chest, the chest leaning back against it."""
    rig = actor.rig
    duration = action_seconds(sprint)

    def frame(u):
        pose = sample(rig, sprint, u * duration)
        pose["root"] = Matrix.Identity(4)

        def body():
            # The run's pelvis, under the idle's still spine: a loaded trunk does not twist with the stride.
            rig.apply({**pose, **{joint: actor.seed[joint] for joint in RUN_SPINE}})
            # The run's pelvis tips well forward; the small of the back stands the trunk up to ``trunk`` degrees.
            rise = rig.head("neck_01") - rig.head("pelvis")
            rotate_world(rig, "spine_01", X, RUN_LOAD["trunk"] - math.degrees(math.atan2(-rise.y, rise.z)))
            rotate_world(rig, "spine_03", X, RUN_LOAD["over"])

        # Each footfall (phase 0 and 0.5) lands the load's weight: the chest gives forward and recovers.
        give = RUN_LOAD["give"] * max(0.0, math.cos(4 * math.pi * u)) ** 2
        chest = {"pitch": give, "neck": RUN_LOAD["neck"]}
        return actor.pose(lambda: {side: (*hold, ELBOWS_OUT[side]) for side, hold in load_hands(actor, RUN_LOAD["gap"]).items()}, chest,
                          {"r": "brace", "l": "brace"}, body)

    return loop(RUN_LOAD["period"], frame), {**load_observation(), "source": SPRINT, "stride": "Heavy_Run_Fwd_Loop"}


# --- Repairing -------------------------------------------------------------------------------------------------------

def repair(actor):
    """Crouched over a board, the left palm holding it and the hammer raised and struck down on a nail ``strikes``
    times a loop."""
    spec = REPAIR
    keys = [(u, Vector((angle, *grip))) for u, angle, grip in spec["keys"]]
    face_point = Vector((spec["face"], spec["head"], 0))
    hold = palm_frame(v(spec["hold"]), Vector((-.3, -1, 0)), Vector((0, 0, -1)))

    def hammer(u):
        k = cyclic(keys, (u * spec["strikes"]) % 1.0)
        return swung(k[0], Vector(k[1:4]))

    def frame(u):
        hands = lambda: {"r": ("weapon", hammer(u)), "l": ("palm_l", hold)}
        return actor.pose(hands, {"pitch": spec["pitch"], "neck": spec["neck"], "yaw": -4.0}, {"r": "grip", "l": "flat"},
                          lambda: crouch_body(actor, 1.0, spec["crouch"]))

    strikes = [round((k + spec["strike"]) / spec["strikes"] * spec["duration"], 4) for k in range(spec["strikes"])]
    face = hammer(spec["strike"] / spec["strikes"]) @ face_point
    return loop(spec["duration"], frame), {"strikeSeconds": strikes, "contactSeconds": strikes[0], "boardAt": root_point(v(spec["board"])),
                                           "tool": {"item": "equipment.tool.hammer", "socket": "hand_r.weapon", "faceAt": root_point(face)}}


# --- Pushing and pulling ---------------------------------------------------------------------------------------------

def push_palms():
    right = palm_frame(v(PUSH["hands"]), Vector((.15, -.1, 1)), Vector((0, -1, 0)))
    left = palm_frame(mirror(v(PUSH["hands"])), Vector((-.15, -.1, 1)), Vector((0, -1, 0)))
    return {"r": right, "l": left}


def push_body(actor, pose, w, lift=None):
    """``pose``'s legs leaning ``w`` of the way into the push: the pelvis lower, forward and tipped, the feet planted
    where ``pose`` has them, ``back`` further behind, and each raised by ``lift`` (metres per side) as it steps."""
    rig = actor.rig
    rig.apply(pose)
    if not w and not any((lift or {}).values()):
        return
    feet = feet_of(rig)
    move_pelvis(rig, Vector((0, PUSH["forward"] * w, -PUSH["drop"] * w)))
    rotate_world(rig, "pelvis", X, PUSH["hip"] * w)
    plant_feet(rig, {side: (ankle + Vector((0, PUSH["back"] * w, (lift or {}).get(side, 0.0))), matrix, Vector((0, -1, .1)))
                     for side, (ankle, matrix, _) in feet.items()})


def push_loop(actor, walk):
    """Leaning into a crate or a cart, both palms flat on it, walking on ``Walk_Loop``'s legs."""
    rig = actor.rig
    duration = action_seconds(walk)
    palms = push_palms()

    def frame(u):
        pose = sample(rig, walk, u * duration)
        hands = lambda: {side: ("palm_" + side, palms[side]) for side in "rl"}
        return actor.pose(hands, {"pitch": PUSH["pitch"], "neck": -6.0}, {"r": "flat", "l": "flat"}, lambda: push_body(actor, pose, 1.0))

    return loop(duration, frame), push_observation(walk)


def push_start(actor, walk):
    """From the idle into ``Push_Loop``'s first frame: the hands come up flat on the crate and the body leans in."""
    rig = actor.rig
    palms = push_palms()
    first = sample(rig, walk, 0.0)
    # Each foot steps from the idle stance to its place in the walk's first frame, the left first, the right after it.
    steps = {"l": (0.0, .5), "r": (.35, .85)}

    def frame(u):
        w = smooth(u / .85)
        lift = {side: .07 * math.sin(math.pi * min(1.0, max(0.0, (u - a) / (b - a)))) for side, (a, b) in steps.items()}
        hands = lambda: {side: ("palm_" + side, blend(actor.seed_palm[side], palms[side], smooth(u / .7))) for side in "rl"} if u > 0 else {}
        shape = {side: ("seed", "flat", smooth(u / .7)) for side in "rl"}
        return actor.pose(hands, {"pitch": PUSH["pitch"] * w, "neck": -6.0 * w}, shape,
                          lambda: push_body(actor, blend_poses(actor.seed, first, w), w, lift))

    return one_shot(PUSH["start"], frame), {**push_observation(walk), "source": STAND, "to": "Push_Loop"}


def push_observation(walk):
    palms = push_palms()
    return {"source": WALK, "pushHandsAt": {side: root_point(palms[side] @ PALM) for side in "rl"}}


def lever(actor):
    """Pulling a lever: reaching to its handle bar ahead, both hands round it, pulling it down toward the body while
    leaning back, letting go and standing."""
    spec = LEVER
    pivot = v(spec["pivot"])
    (r0, r1), (p0, p1), (l0, l1) = spec["reach"], spec["pull"], spec["release"]

    def handle(angle):
        a = math.radians(angle)
        return pivot + Vector((0, math.sin(a), math.cos(a))) * spec["length"]

    def bar_palm(angle, side):
        a = math.radians(angle)
        around = Vector((0, .5 * math.cos(a) + .3, .8))
        point = handle(angle) + Vector((spec["span"] * .5 * (-1 if side == "r" else 1), 0, 0))
        return shaft_palm(point, X, around)

    def frame(u):
        angle = spec["angles"][0] + (spec["angles"][1] - spec["angles"][0]) * window(u, p0, p1)
        hold = window(u, r0 - .1, r0 + .1) * (1 - window(u, l0, l1))
        lean = 10.0 * window(u, 0, r1) - 18.0 * window(u, p0, p1) + 8.0 * window(u, l0, 1.0)
        step = .08 * window(u, 0, r1) - .14 * window(u, p0, p1) + .06 * window(u, l0, 1.0)
        hands = lambda: {side: ("palm_" + side, blend(actor.seed_palm[side], bar_palm(angle, side), hold)) for side in "rl"} if hold > 0 else {}
        brace = window(u, 0, r1) * (1 - window(u, .85, 1.0))

        def body():
            dip = .05 * window(u, p0, p1) * (1 - window(u, l0, 1.0))
            if max(brace, abs(step), dip) < 1e-6:
                return
            stance_body(actor, (.12 * brace, .06 * brace), dip)
            move_pelvis(actor.rig, Vector((0, -step, 0)))

        chest = {"pitch": lean, "neck": 6.0 * hold}
        shapes = {side: ("seed", "grip", hold) for side in "rl"}
        return actor.pose(hands, chest, shapes, body)

    return one_shot(spec["duration"], frame), {
        "leverSeconds": [round(p0 * spec["duration"], 4), round(p1 * spec["duration"], 4)], "leverPivotAt": root_point(pivot),
        "leverLengthMeters": spec["length"], "leverDegrees": list(spec["angles"])}


# --- Traps -----------------------------------------------------------------------------------------------------------

def trap_palms(at, lift=0.0):
    """Both palms on the trap's sides at ``at``, the fingers down round its rim."""
    out = {}
    for side, sign in (("r", -1), ("l", 1)):
        point = at + Vector((sign * TRAP["width"] * .5, 0, lift))
        out[side] = palm_frame(point, Vector((sign * .2, -.6, -1)), Vector((-sign, 0, 0)))
    return out


def trap_place(actor):
    """Kneeling to set a trap down: both hands carry it from before the belly to the ground ahead, let go and the body
    stands again."""
    spec, rig = TRAP, actor.rig
    at, carry = v(spec["at"]), v(spec["carry"])
    d0, d1 = spec["down"]

    def frame(u):
        down = window(u, 0, d0 + .1) * (1 - window(u, d1, 1.0))
        place = window(u, .08, spec["set"])
        hold = window(u, 0, .12) * (1 - window(u, spec["set"] + .04, d1))
        trap = carry.lerp(at, place)
        palms = trap_palms(trap, .06 * window(u, spec["set"], spec["set"] + .1))
        hands = lambda: {side: ("palm_" + side, blend(actor.carry("spine_03") @ actor.seed_palm[side], palms[side], hold)) for side in "rl"} if hold > 0 else {}
        chest = {"pitch": spec["pitch"] * down, "neck": spec["neck"] * down}
        return actor.pose(hands, chest, {side: ("seed", "cup", hold) for side in "rl"}, lambda: kneel_body(rig, actor.feet, down, spec["reach"]))

    return one_shot(spec["place"], frame), {"setSeconds": round(spec["set"] * spec["place"], 4), "trapAt": root_point(at)}


def trap_disarm(actor):
    """Kneeling over a set trap: the left palm holds its jaw down while the right fingers work at the spring,
    ``probes`` times a loop, the head bent close."""
    spec, rig = TRAP, actor.rig
    at = v(spec["at"])
    jaw = palm_frame(at + Vector((.08, -.02, .02)), Vector((-.2, -1, -.2)), Vector((0, 0, -1)))

    def frame(u):
        a = 2 * math.pi * u * spec["probes"]
        point = at + Vector((-.05 + .02 * math.cos(a), -.03 + .015 * math.sin(a), .03 + .02 * max(0.0, math.sin(a))))
        right = palm_frame(point, Vector((.3, -1, -.6)), Vector((.2, 0, -1)))
        pinch = .5 + .5 * math.sin(a + .8)
        hands = lambda: {"r": ("palm_r", right), "l": ("palm_l", jaw)}
        chest = {"pitch": spec["pitch"] + 2.0 * math.sin(a), "neck": spec["neck"], "yaw": 3.0 * math.sin(2 * math.pi * u)}
        return actor.pose(hands, chest, {"r": ("rest", "pinch", pinch), "l": "flat"}, lambda: kneel_body(rig, actor.feet, 1.0, spec["reach"]))

    probes = [round((k + .1) / spec["probes"] * spec["disarm"], 4) for k in range(spec["probes"])]
    return loop(spec["disarm"], frame), {"probeSeconds": probes, "trapAt": root_point(at)}


# --- Knockdown -------------------------------------------------------------------------------------------------------

def lying(actor, k):
    """A body between standing and lying on its back: ``k`` (tip, pelvis y, pelvis z, chest pitch, neck, ankle y,
    ankle z, foot tip, knee lift, planted) with the pelvis at (0, y, z) tipped ``tip`` degrees back about its hip
    joints, the ankles at (y, z) under the hips, or ``planted`` of the way to where they stand in the idle, turned
    ``foot tip``, the knees toward ``knee lift`` (0 ahead, 1 up). The idle itself (``stand_keys``) moves nothing."""
    rig = actor.rig
    tip, py, pz, pitch, neck, ay, az, foot, knee, planted = k
    head = actor.seed_joint["pelvis"].translation

    def body():
        if all(abs(a - b) < 1e-5 for a, b in zip(k, stand_keys(actor))):
            return
        rotate_world(rig, "pelvis", X, tip)
        move_pelvis(rig, Vector((0, py - head.y, pz - head.z)))
        feet = {}
        for side, (ankle, matrix, bend) in actor.feet.items():
            turned = (Matrix.Rotation(math.radians(foot), 3, X) @ matrix.to_3x3()).to_4x4()
            pole = Vector((0, -1, .1)).lerp(Vector((0, -.2, 1)), knee).lerp(bend, planted)
            feet[side] = (Vector((ankle.x, ay, az)).lerp(ankle, planted), turned, pole)
        plant_feet(rig, feet)

    return body, {"pitch": pitch, "neck": neck}


def stand_keys(actor):
    ankle = actor.feet["l"][0]
    head = actor.seed_joint["pelvis"].translation
    return (0.0, head.y, head.z, 0.0, 0.0, ankle.y, ankle.z, 0.0, 0.0, 1.0)


def lie_keys():
    py, pz = DOWN["pelvis"]
    ay, az = DOWN["feet"]
    return (DOWN["tip"], py, pz, 0.0, 4.0, ay, az, DOWN["tip"], .7, 0.0)


def keyed(keys, u):
    return tuple(track([(t, Vector(k)) for t, k in keys], u))


def flail(actor, lift):
    """The palms carried with the chest, ``lift`` of the way forward and up from where they hang; at 0 the arms keep
    the seed pose (no IK), which the chest already carries."""
    if lift <= 0:
        return {}
    out = {}
    for side in "rl":
        offset = Matrix.Translation(Vector((.06 * (1 if side == "l" else -1), -.32, .42)) * lift)
        out[side] = ("palm_" + side, actor.carry("spine_03") @ offset @ actor.seed_palm[side])
    return out


def knockdown(actor):
    """Knocked off the feet: staggering back, tipping back about the ankles with the arms thrown forward, landing on
    the back and settling into ``Lie_Loop``'s first frame."""
    land = DOWN["land"]
    stand, lie = stand_keys(actor), lie_keys()
    keys = [(0.0, stand), (.22, (-14.0, stand[1] + .1, stand[2] - .05, -8.0, -10.0, stand[5], stand[6], 0.0, 0.0, 1.0)),
            (.5, (-48.0, .3, .5, -2.0, 14.0, -.05, .07, -20.0, .3, .3)),
            (land, (lie[0] - 4.0, lie[1], lie[2] + .02, 6.0, 16.0, *lie[5:])),
            (.86, (lie[0] + 3.0, lie[1], lie[2] + .02, 2.0, 8.0, *lie[5:])), (1.0, lie)]

    def frame(u):
        body, chest = lying(actor, keyed(keys, u))
        lift = window(u, .1, .45) * (1 - window(u, land - .05, 1.0))
        return actor.pose(lambda: flail(actor, lift), chest, {side: ("seed" if u < .5 else "rest", "flat", lift) for side in "rl"}, body)

    return one_shot(DOWN["fall"], frame), {"landSeconds": round(land * DOWN["fall"], 4), "to": "Lie_Loop"}


def lie(actor):
    """Lying on the back, breathing slowly, the head rolling a little."""
    def frame(u):
        a = 2 * math.pi * u
        k = list(lie_keys())
        k[3] += 1.5 * math.sin(a)
        k[4] += 2.0 * math.sin(a)
        body, chest = lying(actor, tuple(k))
        chest["look"] = 4.0 * math.sin(a)
        return actor.pose(lambda: flail(actor, 0.0), chest, {"r": "rest", "l": "rest"}, body)

    return loop(DOWN["lie"], frame), {"from": "Knockdown_Fall"}


def get_up(actor):
    """From ``Lie_Loop``'s first frame: sitting up, the feet drawn in, the arms swung forward as the body rocks over
    the feet, and standing up into the idle."""
    stand, lie = stand_keys(actor), lie_keys()
    keys = [(0.0, lie), (.25, (-38.0, .34, .14, 34.0, 10.0, -.36, .07, -50.0, .9, 0.0)),
            (.45, (-14.0, .24, .2, 44.0, 8.0, -.06, .07, 0.0, .8, .2)),
            (.66, (24.0, .1, .5, 22.0, 4.0, stand[5], stand[6], 0.0, .2, 1.0)), (1.0, stand)]

    def frame(u):
        body, chest = lying(actor, keyed(keys, u))
        swing = window(u, .2, .5) * (1 - window(u, .62, .92))
        return actor.pose(lambda: flail(actor, swing), chest, {side: ("rest" if u < .5 else "seed", "flat", swing) for side in "rl"}, body)

    return one_shot(DOWN["getUp"], frame), {"from": "Lie_Loop"}


AUTHORS = {"Raid_Torch_Carry_Loop": torch, "Raid_Hack_Structure_Loop": hack, "Carry_Idle_Loop": carry_idle, "Repair_Hammer_Loop": repair,
           "Lever_Pull": lever, "Trap_Place": trap_place, "Trap_Disarm_Loop": trap_disarm, "Knockdown_Fall": knockdown, "Lie_Loop": lie,
           "GetUp": get_up}
WALKING = {"Carry_Walk_Loop": carry_walk, "Push_Start": push_start, "Push_Loop": push_loop}


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    seed = sample(rig, actions[STAND], 0.0)
    actor = Actor(rig, seed)
    if clip == "Carry_Run_Loop":
        poses, observations = carry_run(actor, actions[SPRINT])
    else:
        poses, observations = WALKING[clip](actor, actions[WALK]) if clip in WALKING else AUTHORS[clip](actor)
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
    for name in (STAND, WALK, SPRINT):
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
    return {"recipe": "raid-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
