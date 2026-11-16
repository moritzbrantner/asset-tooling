"""Original resident chore and carry clips authored on the Ranger rig in Blender (#693, #422's NPC work loops: residents
who carry a lantern, bucket, basket or tankard on ``hand_r.carry`` and do their chores).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit hand frames solved with two-bone arm IK and, for
the full-body clips, pelvis and ankle targets solved with two-bone leg IK, on top of the first ``Idle_Loop`` pose (the
walk carry starts from each ``Walk_Loop`` frame instead). No source motion is copied; the CC0 UAL1 ``Farm_*`` and
``Walk_Carry_Loop`` clips were only watched as reference.

- The carried item hangs from ``hand_r.carry`` (``arguments["sockets"]["carry"]``): the recipe keys that socket's
  frame, the item's +X down (it hangs plumb from the fist), its +Y (the bail) forward. ``Pour`` tips it toward the
  cup in the left hand; ``Farm_Water_Loop`` holds the bucket out at the right side and tips it forward.
- The broom and the hoe (adapters/blender/held_items.py) hang on ``hand_r.staff`` (``sockets["staff"]``), the shaft
  along the item's +Y: the recipe keys that frame and wraps the left palm round the shaft. The broom is held at its
  grip; the hoe's grip is too near its blade to reach the ground, so the right hand holds it near the butt and the
  clip reports the ``itemOffset`` along +Y a consumer mounts it with. The clips report the stroke or strike times,
  the broom's reach and where the hoe's blade strikes.
- ``Carry_Hang_Idle_Loop``, ``Carry_Hang_Walk_Loop``, ``Bar_Wipe_Loop`` and ``Pour`` keep only the ``spine_01``
  subtree (the observations list the joints), so a consumer plays them over standing or walking legs; the walk carry
  has ``Walk_Loop``'s length and its upper body, the carrying arm swinging less, the chest leaning away from the load.
  ``Sweep_Loop``, ``Farm_Hoe_Loop`` and ``Farm_Water_Loop`` are full body and record a skirt and cape pose for the #391
  chain joints (``secondaryPose``, as the social clips).
- The loops are periodic (their last frame is their first); ``Pour`` starts and ends in the idle.

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
ARMS = {"l": ("upperarm_l", "lowerarm_l", "hand_l"), "r": ("upperarm_r", "lowerarm_r", "hand_r")}
LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
SPINE = (("spine_01", .3), ("spine_02", .35), ("spine_03", .35))
X, Y, UP = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
POLE = {"r": Vector((-.8, .35, -.5)), "l": Vector((.8, .35, -.5))}
FINGERS = ("index", "middle", "ring", "pinky", "thumb")
SOCKETS = ("carry", "staff")
# The hand shapes: degrees per finger joint (01, 02, 03) toward the palm, and a spread (degrees about the palm normal,
# + away from the middle finger) per finger. ``grip`` wraps a bail or a shaft about 3 cm across.
SHAPES = {
    "flat": {"curl": {"index": (0, 2, 2), "middle": (0, 2, 2), "ring": (0, 2, 2), "pinky": (0, 3, 2), "thumb": (0, 4, 4)},
             "spread": {"index": 3, "ring": 3, "pinky": 6, "thumb": 8}},
    "cup": {"curl": {"index": (28, 30, 20), "middle": (30, 34, 22), "ring": (32, 36, 22), "pinky": (34, 38, 24), "thumb": (10, 20, 20)},
            "spread": {"index": 4, "ring": 4, "pinky": 8}},
    "grip": {"curl": {"index": (50, 70, 45), "middle": (52, 72, 46), "ring": (54, 72, 46), "pinky": (56, 74, 48), "thumb": (25, 35, 30)},
             "spread": {}},
}
# Points in the palm frame (the wrist, +Y toward the fingers, +Z out of the palm): the middle of the palm.
PALM = Vector((0, .05, .02))

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up; metres (the pelvis stands at about z 0.91,
# the shoulders at 1.43, the ground at 0). A positive yaw turns the chest to the figure's left; a positive pitch bends
# it forward; a positive roll leans it to its left; a positive neck tips the head down.
#
# Carrying: the fist out from the thigh (``out``) and a little forward, the chest leaning ``roll`` degrees away from
# the load, the right shoulder dropping ``drop`` degrees. The walk keeps ``walkSwing`` of the walk's own arm swing.
CARRY = {"duration": 3.0, "out": .055, "forward": -.05, "roll": 3.0, "drop": 4.0, "sway": .012, "walkSwing": .3}
# The broom (adapters/blender/held_items.py ``tool.broom`` on ``hand_r.staff``): the shaft along the item's +Y, the
# bristles ``foot`` metres below the grip and the offhand grip ``offhand`` above it. The bristles sweep the ground
# ``reach`` ahead from the figure's right to its left (``sweep`` x) and lift back, ``strokes`` per loop; the shaft
# leans up toward ``grip``, following the stroke by ``follow``.
SWEEP = {"duration": 3.0, "strokes": 3, "push": .6, "reach": .55, "sweep": (-.3, .16), "lift": .07, "grip": (-.06, -.28, .86),
         "follow": .05, "foot": .8, "offhand": .45, "pitch": 34.0, "turn": 24.0, "yaw": 10.0, "dip": .14, "shift": .03}
# The counter top ``height`` up; the right palm circles on it twice per loop, the left rests on it.
COUNTER = {"height": .98}
WIPE = {"duration": 3.0, "circles": 2, "centre": (-.1, -.3), "radius": (.09, .06), "left": (.18, -.28), "pitch": 32.0, "turn": 20.0, "yaw": 6.0}
# Pouring: the vessel up before the chest, tipped ``tip`` degrees toward the cup the left hand holds.
POUR = {"duration": 1.5, "lift": .3, "pour": (.46, .8), "tip": 78.0, "vessel": (-.08, -.3, 1.12), "cup": (.08, -.26, 1.0)}
# The hoe (held_items.py ``tool.hoe`` on ``hand_r.staff``): the blade end along the item's +Y, its plate's leading
# edge at ``edge`` (item frame). Its grip is a carrying grip 0.74 m from the blade, too low to hoe with the Ranger's
# arms, so the right hand holds the shaft at item y ``hold`` near the butt (the consumer slides the item along its +Y
# by ``-hold``) and the left hand ``offhand`` metres further down toward the blade. Keys (fraction, where the edge
# is, shaft angle below horizontal in degrees, chest pitch, pelvis dip): pulled back, raised, struck in, dragged back.
# The left foot stands ``stance`` ahead, the right behind.
HOE = {"duration": 2.0, "edge": (0, .62, .08), "hold": -.5, "offhand": .25, "strike": .52, "stance": (.16, .1), "keys": (
    (0.0, (-.04, -.72, .03), 64.0, 34.0, .1),
    (.32, (-.04, -1.0, .8), 22.0, 12.0, .02),
    (.52, (-.04, -.82, .02), 50.0, 42.0, .14),
    (.78, (-.04, -.6, .03), 62.0, 38.0, .14),
)}
# Watering: the bucket held out at the figure's right by its bail (``bucket``, the grip), clear of the thigh, tipped
# forward ``tip`` degrees once per loop while it swings ``sweep`` along the row.
WATER = {"duration": 2.0, "pour": (.3, .62), "tip": 70.0, "bucket": (-.34, -.1, 1.0), "sweep": .05, "turn": -10.0,
         "pitch": 15.0, "dip": .05, "stance": (.12, .06)}

UPPER = {"Carry_Hang_Idle_Loop", "Carry_Hang_Walk_Loop", "Bar_Wipe_Loop", "Pour"}
CLIPS = ("Carry_Hang_Idle_Loop", "Carry_Hang_Walk_Loop", "Sweep_Loop", "Bar_Wipe_Loop", "Pour", "Farm_Hoe_Loop", "Farm_Water_Loop")
# The #391 chain joints the full-body clips key, and how far the panels follow the thighs (as the social clips).
CAPE = "cape_01"
SWING = {"share": .7, "front": 70.0, "sideShare": .8, "side": 75.0, "back": 20.0}
BACK = Vector((0, 1, 0))
PLUMB = ("skirt_f_03", "skirt_l_02", "skirt_r_02")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets"}:
        raise ValueError("chore clips require exactly schemaVersion, clips and sockets")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"chore clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"chore clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    if set(inputs) != {"target"}:
        raise ValueError("chore clips take exactly the declared input target")


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


class Actor:
    """The clip-independent state: the seed pose, the seed's carry frame and feet, and the finger shapes."""

    def __init__(self, rig, seed):
        self.rig, self.seed = rig, seed
        rig.apply(seed)
        self.seed_joint = {name: rig.bones[name].matrix.copy() for name in ("pelvis", "spine_03")}
        self.seed_carry = rig.grip("carry")
        self.feet = feet_of(rig)
        self.hands = Hands(rig, seed)

    def carry(self, joint):
        """How ``joint`` has moved from where it stands in the seed (armature space)."""
        return self.rig.bones[joint].matrix @ self.seed_joint[joint].inverted()

    def pose(self, hands, chest=None, shapes=None, body=None):
        """One frame: ``body`` (pelvis, legs, shoulders, or a whole sampled pose), the chest turn, then each hand's
        socket on the frame ``hands()`` returns ({side: (socket, frame)}, read after the body moved) and the shapes."""
        rig = self.rig
        rig.apply(self.seed)
        if body:
            body()
        chest = chest or {}
        turn_chest(rig, chest.get("yaw", 0.0), chest.get("pitch", 0.0), chest.get("roll", 0.0), chest.get("neck", 0.0))
        for side, (socket, frame) in hands().items():
            place_grip(rig, socket, frame, POLE[side])
        for side, shape in (shapes or {}).items():
            rig.apply(self.hands.blend(side, *(shape if type(shape) is tuple else (shape, shape, 1.0))))
        return rig.capture()


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


def stance_body(actor, stance, dip=0.0, shift=0.0):
    """Feet planted in a stance (the left ankle ``stance[0]`` ahead, the right ``stance[1]`` behind), the pelvis
    ``dip`` lower and ``shift`` to the figure's left, the knees bending over the feet."""
    rig = actor.rig
    move_pelvis(rig, Vector((shift, (stance[1] - stance[0]) * .5 * .3, -dip)))
    planted = {}
    for side, ahead in (("l", -stance[0]), ("r", stance[1])):
        ankle, matrix, _ = actor.feet[side]
        planted[side] = (ankle + Vector((0, ahead, 0)), matrix, Vector((0, -1, .1)))
    plant_feet(rig, planted)


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


def hanging(position, swing=0.0):
    """The carry frame at ``position``: the item's +X plumb down, its +Y (the bail) forward, tipped ``swing`` degrees
    forward about the figure's side axis."""
    tilt = Matrix.Rotation(math.radians(swing), 3, X)
    return frame_of(position, tilt @ Vector((0, -1, 0)), tilt @ Vector((-1, 0, 0)))


def shaft_palm(point, shaft, around, flip=False):
    """The palm wrapped round a shaft through ``point``: the palm on the ``around`` side of the shaft facing it, the
    fingers curling across it (``flip`` sends them the other way round)."""
    shaft = shaft.normalized()
    n = (around - shaft * around.dot(shaft)).normalized()
    fingers = shaft.cross(n) * (-1 if flip else 1)
    return palm_frame(point + n * .03, fingers, -n)


# --- Carrying --------------------------------------------------------------------------------------------------------

def carry_offset():
    return Vector((-CARRY["out"], CARRY["forward"], 0))


def carry_idle(actor):
    """Standing with the item hanging from the right fist held out from the thigh: the chest leans away from the load,
    the right shoulder drops, and the chest breathes once per loop while the item sways a little."""
    rig = actor.rig
    base = actor.seed_carry.translation + carry_offset()

    def frame(u):
        phase = 2 * math.pi * u
        body = lambda: rotate_world(rig, "clavicle_r", Y, -CARRY["drop"])
        sway = Vector((0, CARRY["sway"] * math.sin(phase), -.004 * math.cos(2 * phase)))
        chest = {"roll": CARRY["roll"] + .5 * math.sin(phase + .4), "pitch": -1.2 * math.sin(phase), "neck": 1.0 * math.sin(phase + .6)}
        hands = lambda: {"r": ("carry", hanging(actor.carry("spine_03") @ (base + sway), 2.0 * math.sin(phase)))}
        return actor.pose(hands, chest, {"r": "grip"}, body)

    return loop(CARRY["duration"], frame), {"carrySocket": "hand_r.carry"}


def carry_walk(actor, walk):
    """The walk's upper body with the item in the right fist: the carrying arm keeps ``walkSwing`` of the walk's swing
    about the held-out hang, the item stays plumb, the chest leans away from the load."""
    rig = actor.rig
    duration = action_seconds(walk)
    rig.apply(actor.seed)
    hang = actor.seed_joint["spine_03"].inverted() @ (actor.seed_carry.translation + carry_offset())

    def frame(u):
        pose = sample(rig, walk, u * duration)

        def body():
            rig.apply(pose)
            rotate_world(rig, "clavicle_r", Y, -CARRY["drop"])

        def hands():
            swung = rig.grip("carry").translation
            held = rig.bones["spine_03"].matrix @ hang
            return {"r": ("carry", hanging(held.lerp(swung, CARRY["walkSwing"])))}

        return actor.pose(hands, {"roll": CARRY["roll"]}, {"r": "grip"}, body)

    return loop(duration, frame), {"carrySocket": "hand_r.carry", "source": WALK}


# --- The chores ------------------------------------------------------------------------------------------------------

def sweep(actor):
    """Sweeping with the broom on ``hand_r.staff``: its bristles on the ground swept from the figure's right to its left
    and lifted back, ``strokes`` times a loop; the right hand at the grip, the left on the shaft at the item's offhand
    grip above it, the hips shifting with each stroke and the chest turning with the bristles."""
    spec = SWEEP
    strokes, push = spec["strokes"], spec["push"]
    left, right = spec["sweep"]

    def head_at(u):
        s = (u * strokes) % 1.0
        if s < push:
            w = smooth(s / push)
            return Vector((left + (right - left) * w, -spec["reach"], .03)), w
        w = (s - push) / (1 - push)
        return Vector((right - (right - left) * smooth(w), -spec["reach"] + .05 * math.sin(math.pi * w), .03 + spec["lift"] * math.sin(math.pi * w))), 1 - smooth(w)

    def frame(u):
        head, w = head_at(u)
        across = w * 2 - 1
        chest = {"pitch": spec["pitch"], "yaw": spec["turn"] + spec["yaw"] * across, "neck": 8.0}
        body = lambda: stance_body(actor, (.1, .05), spec["dip"], spec["shift"] * across)

        def hands():
            # The shaft runs up from the bristles toward where the right hand would be; the grip sits ``foot`` up it.
            up = (v(spec["grip"]) + Vector((spec["follow"] * across, 0, 0)) - head).normalized()
            grip = head + up * spec["foot"]
            return {"r": ("staff", frame_of(grip, up, Vector((0, 1, 0)))),
                    "l": ("palm_l", shaft_palm(grip + up * spec["offhand"], up, Vector((.3, .3, 1))))}

        return actor.pose(hands, chest, {"r": "grip", "l": "grip"}, body)

    poses = loop(spec["duration"], frame)
    starts = [round(k * spec["duration"] / strokes, 4) for k in range(strokes)]
    return poses, {"strokeSeconds": starts, "tool": {"item": "equipment.tool.broom", "socket": "hand_r.staff", "headReachMeters": spec["reach"]}}


def bar_wipe(actor):
    """The innkeeper wipes the counter: the right palm flat on it circling twice a loop, the left palm resting on it,
    the chest bent over it and turning a little with the circles."""
    spec, h = WIPE, COUNTER["height"]
    cx, cy = spec["centre"]
    rx, ry = spec["radius"]

    def frame(u):
        phase = 2 * math.pi * spec["circles"] * u
        at = Vector((cx + rx * math.cos(phase), cy + ry * math.sin(phase), h))
        chest = {"pitch": spec["pitch"], "yaw": spec["turn"] - spec["yaw"] * math.cos(phase) * .5, "neck": 6.0}
        hands = lambda: {"r": ("palm_r", palm_frame(at, Vector((.25 + .15 * math.sin(phase), -1, 0)), Vector((0, 0, -1)))),
                         "l": ("palm_l", palm_frame(Vector((*spec["left"], h)), Vector((-.3, -1, 0)), Vector((0, 0, -1))))}
        return actor.pose(hands, chest, {"r": "flat", "l": "flat"})

    return loop(spec["duration"], frame), {"counterHeightMeters": h, "circleSeconds": [round(k * spec["duration"] / spec["circles"], 4) for k in range(spec["circles"])]}


def pour(actor):
    """Pour from the vessel in the right fist: lift it before the chest, tip it toward the cup the left hand holds,
    hold the pour, set it upright and lower it back to the idle."""
    spec = POUR
    rig = actor.rig
    start, end = spec["pour"]
    seed_carry = actor.seed_carry
    up = hanging(v(spec["vessel"]))
    rig.apply(actor.seed)
    seed_left = rig.grip("palm_l")
    cup = palm_frame(v(spec["cup"]), Vector((-.3, -1, 0)), Vector((0, 0, 1)))

    def blend(a, b, w):
        la, ra, _ = a.decompose()
        lb, rb, _ = b.decompose()
        return Matrix.LocRotScale(la.lerp(lb, w), ra.slerp(rb, w), Vector((1, 1, 1)))

    def frame(k, count):
        u = k / count
        lifted = window(u, 0, spec["lift"]) * (1 - window(u, end + .04, 1.0))
        tipped = window(u, spec["lift"] - .04, start) * (1 - window(u, end, end + .1))
        vessel = blend(seed_carry, up, lifted)
        # Tip the vessel about its own +Y (forward), its mouth turning toward the cup at the figure's left.
        vessel = vessel @ Matrix.Rotation(math.radians(-spec["tip"] * tipped), 4, Y)
        left = blend(seed_left, cup, window(u, .08, spec["lift"]) * (1 - window(u, end + .04, .98)))
        hands = lambda: {"r": ("carry", vessel), "l": ("palm_l", left)}
        shapes = {"r": ("seed", "grip", window(u, 0, .12) if u < .5 else 1 - window(u, .9, 1.0)), "l": ("seed", "cup", lifted)}
        return actor.pose(hands, {"pitch": 4.0 * lifted, "neck": 10.0 * lifted}, shapes)

    count = frames_of(spec["duration"])
    poses = [frame(k, count) for k in range(count + 1)]
    return poses, {"carrySocket": "hand_r.carry", "pourSeconds": [round(start * spec["duration"], 4), round(end * spec["duration"], 4)]}


def hoe(actor):
    """Hoeing with the hoe on ``hand_r.staff``, its blade end down: from the pulled-back pose the hoe is raised, struck
    into the ground ahead and dragged back, once a loop; the right hand near the butt (the item slid along its +Y), the
    left lower down the shaft toward the blade, the pelvis dipping into the strike."""
    spec = HOE
    keys = spec["keys"]
    edges = [(u, v(edge)) for u, edge, *_ in keys]
    rest = [(u, Vector((angle, pitch, dip))) for u, _, angle, pitch, dip in keys]

    def item(u):
        """The staff frame at ``u``: +Y down the shaft to the blade, +Z (the blade's side) back toward the feet, the
        grip placed so the blade's edge is where the keys put it."""
        angle = math.radians(cyclic(rest, u).x)
        m = frame_of(Vector(), Vector((0, -math.cos(angle), -math.sin(angle))), Vector((0, math.sin(angle), -math.cos(angle))))
        m.translation = cyclic(edges, u) - m.to_3x3() @ (v(spec["edge"]) - Vector((0, spec["hold"], 0)))
        return m

    def frame(u):
        _, pitch, dip = cyclic(rest, u)
        staff = item(u)
        shaft = staff.to_3x3().col[1]
        body = lambda: stance_body(actor, spec["stance"], dip)
        hands = lambda: {"r": ("staff", staff), "l": ("palm_l", shaft_palm(staff.translation + shaft * spec["offhand"], shaft, Vector((.4, .3, 1))))}
        return actor.pose(hands, {"pitch": pitch, "yaw": -6.0, "neck": 10.0}, {"r": "grip", "l": "grip"}, body)

    poses = loop(spec["duration"], frame)
    strike = spec["strike"]
    blade = item(strike) @ (v(spec["edge"]) - Vector((0, spec["hold"], 0)))
    return poses, {"strikeSeconds": round(strike * spec["duration"], 4), "contactSeconds": round(strike * spec["duration"], 4),
                   "tool": {"item": "equipment.tool.hoe", "socket": "hand_r.staff", "itemOffset": [0, -spec["hold"], 0], "bladeAt": root_point(blade)}}


def water(actor):
    """Watering a row from the bucket: held out at the figure's right by its bail, clear of the thigh, swung forward
    and tipped (its bottom swinging back past the thigh) once a loop; the chest turns toward the row, the left arm
    hangs."""
    spec = WATER
    start, end = spec["pour"]

    def frame(u):
        tipped = window(u, start - .18, start) * (1 - window(u, end, end + .22))
        along = math.sin(2 * math.pi * u)
        at = v(spec["bucket"]) + Vector((0, spec["sweep"] * along - .08 * tipped, .08 * tipped))
        body = lambda: stance_body(actor, spec["stance"], spec["dip"], -.02 * tipped)
        hands = lambda: {"r": ("carry", hanging(at, spec["tip"] * tipped))}
        chest = {"pitch": spec["pitch"] + 4.0 * tipped, "yaw": spec["turn"], "roll": -3.0 * tipped, "neck": 12.0}
        return actor.pose(hands, chest, {"r": "grip"}, body)

    poses = loop(spec["duration"], frame)
    return poses, {"carrySocket": "hand_r.carry", "pourSeconds": [round(start * spec["duration"], 4), round(end * spec["duration"], 4)]}


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    seed = sample(rig, actions[STAND], 0.0)
    actor = Actor(rig, seed)
    observations = {}
    if clip == "Carry_Hang_Idle_Loop":
        poses, observations = carry_idle(actor)
    elif clip == "Carry_Hang_Walk_Loop":
        poses, observations = carry_walk(actor, actions[WALK])
    elif clip == "Sweep_Loop":
        poses, observations = sweep(actor)
    elif clip == "Bar_Wipe_Loop":
        poses, observations = bar_wipe(actor)
    elif clip == "Pour":
        poses, observations = pour(actor)
    elif clip == "Farm_Hoe_Loop":
        poses, observations = hoe(actor)
    else:
        poses, observations = water(actor)
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
    for name in (STAND, WALK):
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
    return {"recipe": "chore-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
