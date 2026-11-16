"""Original post idles, devotions and ambient idle breaks authored on the Ranger rig in Blender (#697, #422's NPC post
idles and ambient idles: Greyhaven's guards at their posts, Marshal Elden, Brother Aldous and the townsfolk).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit hand frames solved with two-bone arm IK and, for
the full-body clips, pelvis and ankle targets solved with two-bone leg IK, on top of the first ``Idle_Loop`` pose. No
source motion is copied; the CC0 UAL1 ``Idle_FoldArms_Loop`` was only watched as reference.

- The guards hold a spear grounded on ``hand_r.staff`` (``arguments["sockets"]["staff"]``): the recipe keys that
  socket's frame, the shaft along the item's +Y, upright beside the right foot. The spear's grip is 0.8 m above its
  butt, lower than the Ranger's hand hangs, so the clips hold it higher up the shaft (0.18 m) and report the
  ``itemOffset`` along +Y a consumer mounts it with, so its butt stands on the ground. The left hand rests on the hilt
  of a sword stowed at ``hip_l.stowed`` (``sockets["stowed"]``) and salutes with a fist to the chest.
- ``Guard_Attention_Loop``, ``Guard_Salute``, ``Guard_LookAround``, ``Marshal_Inspect_Loop`` and ``Bless`` keep only
  the ``spine_01`` subtree (the observations list the joints), so a consumer plays them over standing legs.
  ``Pray_Kneel_Loop``, ``Lean_Wall_Loop`` and the ``Idle_Variant_*`` breaks are full body and record a skirt and cape
  pose for the #391 chain joints (``secondaryPose``, as the social clips). The prayer kneels on the right knee as the
  #443 kneels, but genuflecting upright: the left foot steps only ``step`` forward, so the left shin stands plumb.
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
SOCKETS = ("staff", "stowed")
# The hand shapes: degrees per finger joint (01, 02, 03) toward the palm, and a spread (degrees about the palm normal,
# + away from the middle finger) per finger. ``grip`` wraps a shaft about 3 cm across; ``bless`` keeps the index and
# middle fingers straight and curls the others.
SHAPES = {
    "flat": {"curl": {"index": (0, 2, 2), "middle": (0, 2, 2), "ring": (0, 2, 2), "pinky": (0, 3, 2), "thumb": (0, 4, 4)},
             "spread": {"index": 3, "ring": 3, "pinky": 6, "thumb": 8}},
    "rest": {"curl": {"index": (14, 18, 12), "middle": (16, 20, 12), "ring": (18, 22, 14), "pinky": (20, 24, 14), "thumb": (6, 10, 10)},
             "spread": {"pinky": 4}},
    "grip": {"curl": {"index": (50, 70, 45), "middle": (52, 72, 46), "ring": (54, 72, 46), "pinky": (56, 74, 48), "thumb": (25, 35, 30)},
             "spread": {}},
    "fist": {"curl": {"index": (80, 95, 60), "middle": (82, 95, 60), "ring": (84, 95, 60), "pinky": (86, 95, 60), "thumb": (30, 40, 35)},
             "spread": {}},
    "bless": {"curl": {"index": (0, 4, 4), "middle": (0, 4, 4), "ring": (60, 80, 50), "pinky": (62, 82, 52), "thumb": (35, 40, 30)},
              "spread": {"index": -2}},
}
# Points in the palm frame (the wrist, +Y toward the fingers, +Z out of the palm): the middle of the palm.
PALM = Vector((0, .05, .02))

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up; metres (the pelvis stands at about z 0.91,
# the shoulders at 1.43, the ground at 0). A positive yaw turns the chest to the figure's left; a positive pitch bends
# it forward; a positive roll leans it to its left; a positive neck tips the head down; a negative gaze lets the head
# turn further than the chest.
#
# The guard's spear: upright beside the right foot, leaning ``lean`` forward, the right hand at ``hand``, higher up the
# shaft than the item's grip (``foot`` above its butt), so the butt stands on the ground.
SPEAR = {"hand": (-.25, -.1, .98), "lean": .03, "foot": .8}
# The left palm rests on the hilt ``above`` metres above the ``hip_l.stowed`` grip, fingers forward over it.
HILT = {"above": .06}
ATTENTION = {"duration": 4.0, "pitch": 1.2, "neck": 1.0}
# The salute: the left fist to the chest (``fist``, in the chest's frame at the seed) and a nod, held from ``hold[0]``
# to ``hold[1]``.
SALUTE = {"duration": 1.2, "hold": (.32, .66), "fist": (.04, -.19, 1.3), "pitch": 4.0, "neck": 7.0}
# Looking round: (fraction, chest yaw) keys; the head turns ``gaze`` further than the chest.
LOOK = {"duration": 3.0, "gaze": -.9, "keys": ((0.0, 0.0), (.18, 22.0), (.38, 22.0), (.62, -24.0), (.82, -24.0), (1.0, 0.0))}
# Folded arms (in the chest's frame at the seed: palm point, finger and palm directions, elbow pole): the left forearm
# across over the right, the right hand tucked under the left arm, the left hand on the right upper arm.
FOLD = {"r": ((.11, -.14, 1.19), (.3, 1, -.1), (1, 0, 0), (-1, -.2, -.5)), "l": ((-.12, -.16, 1.24), (-.3, 1, 0), (-1, 0, 0), (1, -.2, -.5))}
INSPECT = {"duration": 4.0, "yaw": 12.0, "gaze": -.6, "pitch": -2.0, "neck": 4.0}
# Kneeling to pray on the right knee (as the #443 kneels, the pelvis ``kneel`` lower), the left foot only ``step``
# forward so its shin stands plumb under the knee; the palms pressed together before the chest at ``hands`` (the
# chest's frame at the seed), the head bowed.
KNEEL = {"kneel": .42, "step": .2}
PRAY = {"duration": 4.0, "hands": (0, -.24, 1.2), "pitch": 10.0, "neck": 24.0, "breath": 1.2}
# Blessing: the right hand raised palm out (``raise``), drawing a vertical stroke down and then a horizontal stroke
# across, then lowered; the left hand at the belly.
BLESS = {"duration": 1.2, "raise": (-.2, -.32, 1.4), "down": .16, "across": (-.08, .08), "strokes": (.3, .48, .6, .76),
         "belly": (.06, -.2, 1.06)}
# Leaning back against a wall: the pelvis ``back`` behind and ``drop`` lower, the feet ``forward`` ahead, the chest
# ``pitch`` back; arms folded; the head glances aside once a loop.
LEAN = {"duration": 5.0, "back": .12, "drop": .06, "forward": .24, "pitch": -11.0, "glance": 18.0, "depth": .18}
# The idle breaks: keys (fraction, value) blended smoothly, starting and ending in the idle.
SHIFT = {"duration": 4.0, "keys": ((0.0, 0.0), (.28, 1.0), (.72, 1.0), (1.0, 0.0)), "shift": .06, "dip": .02, "roll": 4.0, "hip": 5.0}
STRETCH = {"duration": 4.0, "keys": ((0.0, 0.0), (.3, 1.0), (.62, 1.0), (.92, 0.0), (1.0, 0.0)), "top": .64, "pitch": -9.0,
           "neck": -14.0}
YAWN = {"duration": 4.0, "keys": ((0.0, 0.0), (.22, 1.0), (.62, 1.0), (.88, 0.0), (1.0, 0.0)), "mouth": (-.02, -.21, 1.53),
        "neck": -20.0, "pitch": -4.0, "shrug": 5.0}

UPPER = {"Guard_Attention_Loop", "Guard_Salute", "Guard_LookAround", "Marshal_Inspect_Loop", "Bless"}
CLIPS = ("Guard_Attention_Loop", "Guard_Salute", "Guard_LookAround", "Marshal_Inspect_Loop", "Pray_Kneel_Loop", "Bless",
         "Lean_Wall_Loop", "Idle_Variant_Shift", "Idle_Variant_Stretch", "Idle_Variant_Yawn")
# The #391 chain joints the full-body clips key, and how far the panels follow the thighs (as the social clips).
CAPE = "cape_01"
SWING = {"share": .7, "front": 70.0, "sideShare": .8, "side": 75.0, "back": 20.0}
BACK = Vector((0, 1, 0))
PLUMB = ("skirt_f_03", "skirt_l_02", "skirt_r_02")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets"}:
        raise ValueError("post clips require exactly schemaVersion, clips and sockets")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"post clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"post clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    if set(inputs) != {"target"}:
        raise ValueError("post clips take exactly the declared input target")


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
    """The clip-independent state: the seed pose, the seed's palms, spear frame and feet, and the finger shapes."""

    def __init__(self, rig, seed):
        self.rig, self.seed = rig, seed
        rig.apply(seed)
        self.seed_joint = {name: rig.bones[name].matrix.copy() for name in ("pelvis", "spine_03", "Head")}
        self.seed_palm = {side: rig.grip(f"palm_{side}") for side in "lr"}
        self.seed_staff = rig.grip("staff")
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
    move_pelvis(rig, Vector((0, .1 * down, -KNEEL["kneel"] * down)))
    la = left_ankle + Vector((0, -KNEEL["step"], 0)) * window(down, .0, .6)
    ra = right_ankle + Vector((0, .3, .06)) * window(down, .2, 1.0)
    plant_feet(rig, {"l": (la, left_matrix, Vector((0, -1, .2))), "r": (ra, right_matrix, Vector((0, -.6, -1)))})
    if down > 1e-3:
        rotate_world(rig, "foot_r", X, -50 * window(down, .2, 1.0))


# --- The guards ------------------------------------------------------------------------------------------------------

def spear(actor):
    """The ``hand_r.staff`` frame of the grounded spear: the shaft (+Y) up, leaning a little forward, turned as the
    seed holds its staff."""
    return frame_of(v(SPEAR["hand"]), Vector((0, -SPEAR["lean"], 1)), actor.seed_staff.to_3x3().col[2])


def spear_tool(actor):
    """The spear's ``tool`` observation: the hand sits ``hold`` up the shaft from the item's grip, so the consumer
    slides the item ``-hold`` along its +Y and its butt stands on the ground."""
    frame = spear(actor)
    hold = frame.translation.z / frame.to_3x3().col[1].z - SPEAR["foot"]
    butt = frame @ Vector((0, -SPEAR["foot"] - hold, 0))
    return {"item": "equipment.spear.leaf", "socket": "hand_r.staff", "itemOffset": [0, round(-hold, 4), 0], "buttAt": root_point(butt)}


def hilt(actor):
    """The left palm resting on the hilt of the sword stowed at ``hip_l.stowed``, the fingers forward over it."""
    at = actor.rig.grip("stowed").translation + UP * HILT["above"]
    return palm_frame(at, Vector((-.15, -1, -.35)), Vector((.2, 0, -1)))


def guard_hands(actor, left=None):
    staff = spear(actor)
    return lambda: {"r": ("staff", staff), "l": ("palm_l", left() if left else hilt(actor))}


def guard_observations(actor):
    return {"tool": spear_tool(actor), "restSocket": "hip_l.stowed"}


def attention(actor):
    """Standing to attention at the post, the spear grounded, the left hand on the sword's hilt; the chest breathes
    once a loop."""
    spec = ATTENTION

    def frame(u):
        phase = 2 * math.pi * u
        chest = {"pitch": -spec["pitch"] * math.sin(phase), "neck": spec["neck"] * math.sin(phase + .6)}
        return actor.pose(guard_hands(actor), chest, {"r": "grip", "l": "rest"})

    return loop(spec["duration"], frame), guard_observations(actor)


def salute(actor):
    """The guard salutes: the left fist from the hilt to the chest with a nod, held, and back; the spear stays
    grounded."""
    spec = SALUTE
    start, end = spec["hold"]
    fist = palm_frame(v(spec["fist"]), Vector((-1, -.1, .35)), Vector((0, 1, 0)))

    def frame(u):
        w = track(((0.0, 0.0), (start, 1.0), (end, 1.0), (1.0, 0.0)), u)
        nod = track(((0.0, 0.0), (start, 0.0), (start + .08, 1.0), (end - .06, 1.0), (end + .06, 0.0)), u)
        left = lambda: blend(hilt(actor), actor.carry("spine_03") @ fist, w)
        chest = {"pitch": spec["pitch"] * nod, "neck": spec["neck"] * nod}
        return actor.pose(guard_hands(actor, left), chest, {"r": "grip", "l": ("rest", "fist", w)})

    return one_shot(spec["duration"], frame), {**guard_observations(actor), "saluteSeconds": [round(start * spec["duration"], 4), round(end * spec["duration"], 4)]}


def look_around(actor):
    """The guard scans: the chest and, further, the head turn to the left, hold, sweep to the right, hold and come
    back; the spear and the left hand stay where they are."""
    spec = LOOK

    def frame(u):
        return actor.pose(guard_hands(actor), {"yaw": track(spec["keys"], u), "gaze": spec["gaze"]}, {"r": "grip", "l": "rest"})

    looks = [round(u * spec["duration"], 4) for u, yaw in spec["keys"] if yaw]
    return one_shot(spec["duration"], frame), {**guard_observations(actor), "lookSeconds": looks}


# --- Folded arms, devotions ------------------------------------------------------------------------------------------

def folded(actor):
    """The folded arms' palm frames, carried with the chest."""
    chest = actor.carry("spine_03")
    return {side: ("palm_" + side, chest @ palm_frame(v(point), v(fingers), v(normal)), chest.to_3x3() @ v(pole))
            for side, (point, fingers, normal, pole) in FOLD.items()}


def inspect(actor):
    """Marshal Elden surveys the yard, arms folded: the chest and head turn slowly left and right once a loop, with a
    slight nod at each side."""
    spec = INSPECT

    def frame(u):
        phase = 2 * math.pi * u
        chest = {"yaw": spec["yaw"] * math.sin(phase), "gaze": spec["gaze"], "pitch": spec["pitch"] + .8 * math.sin(2 * phase),
                 "neck": spec["neck"] + 2.0 * math.cos(2 * phase)}
        return actor.pose(lambda: folded(actor), chest, {"r": "rest", "l": "rest"})

    return loop(spec["duration"], frame), {}


def pray(actor):
    """Brother Aldous kneels in prayer: on the right knee, the palms pressed together before the chest, the head bowed;
    the chest breathes once a loop."""
    spec, rig = PRAY, actor.rig
    point = v(spec["hands"])

    def frame(u):
        phase = 2 * math.pi * u

        def hands():
            chest = actor.carry("spine_03")
            up = Vector((0, -.35, 1))
            return {"r": ("palm_r", chest @ palm_frame(point, up, Vector((1, 0, 0)))),
                    "l": ("palm_l", chest @ palm_frame(point, up, Vector((-1, 0, 0))))}

        chest = {"pitch": spec["pitch"] - spec["breath"] * math.sin(phase), "neck": spec["neck"] + 1.5 * math.sin(phase + .6)}
        return actor.pose(hands, chest, {"r": "flat", "l": "flat"}, lambda: kneel_body(rig, actor.feet, 1.0))

    return loop(spec["duration"], frame), {"kneelDropMeters": KNEEL["kneel"]}


def bless(actor):
    """Brother Aldous blesses: the right hand raised palm out, two fingers straight, draws a stroke down and a stroke
    across, then lowers; the left hand rests at the belly."""
    spec = BLESS
    top = v(spec["raise"])
    a, b, c, d = spec["strokes"]
    across0, across1 = spec["across"]
    path = ((0.0, top), (a, top + Vector((0, 0, spec["down"] * .4))), (b, top - Vector((0, 0, spec["down"] * .6))),
            (c, top + Vector((across0, 0, 0))), (d, top + Vector((across1, 0, 0))), (1.0, top + Vector((across1, 0, 0))))
    belly = palm_frame(v(spec["belly"]), Vector((-1, -.2, -.3)), Vector((0, 1, 0)))

    def frame(u):
        w = track(((0.0, 0.0), (.22, 1.0), (.84, 1.0), (1.0, 0.0)), u)
        hands = lambda: {"r": ("palm_r", blend(actor.seed_palm["r"], actor.carry("spine_03") @ palm_frame(track(path, u), Vector((-.1, -.15, 1)), Vector((0, -1, 0))), w)),
                         "l": ("palm_l", blend(actor.seed_palm["l"], actor.carry("spine_03") @ belly, w))}
        return actor.pose(hands, {"pitch": 3.0 * w, "neck": 6.0 * w}, {"r": ("seed", "bless", w), "l": ("seed", "rest", w)})

    return one_shot(spec["duration"], frame), {"strokeSeconds": [round(a * spec["duration"], 4), round(d * spec["duration"], 4)]}


# --- Ambient ---------------------------------------------------------------------------------------------------------

def lean_wall(actor):
    """Leaning back against a wall, arms folded: the pelvis back and down, the feet ahead, the shoulders on the wall;
    the chest breathes and the head glances to the side once a loop."""
    spec, rig = LEAN, actor.rig

    def body():
        move_pelvis(rig, Vector((0, spec["back"], -spec["drop"])))
        plant_feet(rig, {side: (ankle + Vector((0, -spec["forward"], 0)), matrix, Vector((0, -1, .1))) for side, (ankle, matrix, _) in actor.feet.items()})

    def frame(u):
        phase = 2 * math.pi * u
        glance = track(((0.0, 0.0), (.36, 0.0), (.46, 1.0), (.62, 1.0), (.72, 0.0), (1.0, 0.0)), u)
        chest = {"pitch": spec["pitch"] - 1.0 * math.sin(phase), "neck": 4.0 + 1.0 * math.sin(phase + .6), "look": spec["glance"] * glance}
        return actor.pose(lambda: folded(actor), chest, {"r": "rest", "l": "rest"}, body)

    poses = loop(spec["duration"], frame)
    rig.apply(poses[0])
    wall = max(rig.head(joint).y for joint in ("spine_02", "spine_03")) + spec["depth"]
    return poses, {"wallBehindMeters": round(wall, 4)}


def shift(actor):
    """Shifting the weight onto the left leg: the pelvis slides over the left foot and tips down on the right, the right
    knee easing, the chest leaning back the other way; held and back."""
    spec, rig = SHIFT, actor.rig

    def frame(u):
        w = track(spec["keys"], u)

        def body():
            move_pelvis(rig, Vector((spec["shift"] * w, 0, -spec["dip"] * w)))
            rotate_world(rig, "pelvis", Y, spec["hip"] * w)
            plant_feet(rig, actor.feet)

        return actor.pose(None, {"roll": spec["roll"] * w}, None, body)

    return one_shot(spec["duration"], frame), {}


def stretch(actor):
    """Stretching: both hands up over the head, palms up and the fingers meeting, the back arching and the head tipping
    back; held and lowered."""
    spec = STRETCH
    top = actor.seed_joint["spine_03"].translation.z + spec["top"]
    right = palm_frame(Vector((-.035, -.02, top)), Vector((1, 0, .2)), Vector((0, 0, 1)))
    left = palm_frame(Vector((.035, -.02, top)), Vector((-1, 0, .2)), Vector((0, 0, 1)))

    def frame(u):
        w = track(spec["keys"], u)
        hands = lambda: {"r": ("palm_r", blend(actor.seed_palm["r"], actor.carry("spine_03") @ right, w)),
                         "l": ("palm_l", blend(actor.seed_palm["l"], actor.carry("spine_03") @ left, w))}
        return actor.pose(hands, {"pitch": spec["pitch"] * w, "neck": spec["neck"] * w}, {"r": ("seed", "flat", w), "l": ("seed", "flat", w)})

    return one_shot(spec["duration"], frame), {}


def yawn(actor):
    """Yawning: the right hand up before the mouth, the head tipping back and the shoulders rising; held and lowered."""
    spec, rig = YAWN, actor.rig
    mouth = palm_frame(v(spec["mouth"]), Vector((1, 0, .3)), Vector((0, 1, 0)))

    def frame(u):
        w = track(spec["keys"], u)

        def body():
            rotate_world(rig, "clavicle_r", Y, spec["shrug"] * w)
            rotate_world(rig, "clavicle_l", Y, -spec["shrug"] * w)

        hands = lambda: {"r": ("palm_r", blend(actor.seed_palm["r"], actor.carry("Head") @ mouth, w))}
        return actor.pose(hands, {"pitch": spec["pitch"] * w, "neck": spec["neck"] * w}, {"r": ("seed", "rest", w)}, body)

    return one_shot(spec["duration"], frame), {}


AUTHORS = {"Guard_Attention_Loop": attention, "Guard_Salute": salute, "Guard_LookAround": look_around, "Marshal_Inspect_Loop": inspect,
           "Pray_Kneel_Loop": pray, "Bless": bless, "Lean_Wall_Loop": lean_wall, "Idle_Variant_Shift": shift,
           "Idle_Variant_Stretch": stretch, "Idle_Variant_Yawn": yawn}


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
    return {"recipe": "post-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
