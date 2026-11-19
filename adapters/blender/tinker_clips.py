"""The Tinker's clips authored on the Ranger rig in Blender (#775): kneeling to set and arm a spring trap, an underhand
flask lob, an overhand bomb lob that lights the fuse first, and the ready loop with a flask in hand.

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), on top of the first ``Idle_Loop`` pose. No source motion is
copied beyond that base pose.

Every clip is full body, keyed like #773's stance clips (adapters/blender/defend_clips.py): every key is a whole stance,
the feet placed by their balls (a lifted heel turns the foot about its ball, so a planted foot stays put), the hips,
the chest and the shoulders turned over them, and each hand on a keyed frame carried with the chest or fixed on the
ground, with two-bone arm and leg IK. The throws start and end in ``Tinker_Ready_Loop``'s pose; the trap is set from
and back to the ``Idle_Loop`` stance. They record a skirt and cape pose for the #391 chain joints (``secondaryPose``)
and a ``tinker`` object: the kind, the items and sockets, ``from``/``to``, and the marks: ``placeSeconds`` (the trap
set flat; ``trapAt`` its ground frame in the root frame), ``armSeconds`` (the dog set: swap the trap to ``armed``),
``lightSeconds`` (the fuse lit: swap the bomb to ``lit``), ``releaseSeconds`` (the throw lets go; ``releaseAt`` and
``releaseDirection`` give the grip and its travel then, in the root frame) and ``drawSeconds`` (the hand at the right
hip, drawing the next flask).

No randomness.
"""
import json
import math
import struct

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 30
STAND = "Idle_Loop"
ARMS = {"l": ("upperarm_l", "lowerarm_l", "hand_l"), "r": ("upperarm_r", "lowerarm_r", "hand_r")}
LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
SPINE = (("spine_01", .3), ("spine_02", .35), ("spine_03", .35))
X, Y, UP = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
POLE = {"r": Vector((-.8, .35, -.5)), "l": Vector((.8, .35, -.5))}
KNEE = Vector((0, -1, .3))
FINGERS = ("index", "middle", "ring", "pinky", "thumb")
SOCKETS = ("weapon",)
SHAPES = {
    "open": {"curl": {"index": (4, 6, 4), "middle": (5, 6, 4), "ring": (6, 8, 5), "pinky": (7, 9, 5), "thumb": (2, 4, 4)},
             "spread": {"pinky": 8, "index": -4}},
    "grip": {"curl": {"index": (50, 70, 45), "middle": (52, 72, 46), "ring": (54, 72, 46), "pinky": (56, 74, 48), "thumb": (25, 35, 30)},
             "spread": {}},
    "fist": {"curl": {"index": (80, 95, 60), "middle": (82, 95, 60), "ring": (84, 95, 60), "pinky": (86, 95, 60), "thumb": (30, 40, 35)},
             "spread": {}},
}
PALM = Vector((0, .05, .02))

FLOOR = (.07, .02)
# The #391 chain joints the full-body clips key (as adapters/blender/strike_clips.py).
CAPE = "cape_01"
SWING = {"share": .7, "front": 70.0, "sideShare": .8, "side": 75.0, "back": 20.0}
BACK = Vector((0, 1, 0))
PLUMB = ("skirt_f_03", "skirt_l_02", "skirt_r_02")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets"}:
        raise ValueError("tinker clips require exactly schemaVersion, clips and sockets")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"tinker clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"tinker clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    if set(inputs) != {"target"}:
        raise ValueError("tinker clips take exactly the declared input target")


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
        # The palms: at the wrist, +Y along the hand toward the fingers, +Z out of the palm, offset to the middle of the
        # palm so a fist key names where the fist is.
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

    def shape(self, side, name):
        return self.shapes[side][name]


def frames_of(duration):
    return int(round(duration * FPS))


def root_point(p):
    """An armature-space point in the root's glTF axes (+Y up, +Z facing), rounded."""
    g = C4.inverted() @ p
    return [round(g.x, 4), round(g.y, 4), round(g.z, 4)]


def hermite(keys, u):
    """A curve through ``keys`` ((fraction, value) pairs, values floats or Vectors): the slope at an inner key is its
    neighbours' difference over their spacing, the ends ease in and out, and it holds past the ends."""
    if u <= keys[0][0]:
        return keys[0][1]
    if u >= keys[-1][0]:
        return keys[-1][1]
    i = max(k for k in range(len(keys) - 1) if keys[k][0] <= u)
    (t0, p0), (t1, p1) = keys[i], keys[i + 1]

    def slope(k):
        if k == 0 or k == len(keys) - 1:
            return p0 * 0
        return (keys[k + 1][1] - keys[k - 1][1]) / (keys[k + 1][0] - keys[k - 1][0])

    h = t1 - t0
    s = (u - t0) / h
    s2, s3 = s * s, s * s * s
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * h * slope(i) + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * h * slope(i + 1)


def monotone(keys, u):
    """A scalar curve through ``keys`` that never overshoots them (as strike_clips.py's, #737): flat at a key that is a
    turn or a hold, else the harmonic mean of the slopes beside it, so two equal keys hold the value exactly between them."""
    if u <= keys[0][0]:
        return keys[0][1]
    if u >= keys[-1][0]:
        return keys[-1][1]
    i = max(k for k in range(len(keys) - 1) if keys[k][0] <= u)
    (t0, p0), (t1, p1) = keys[i], keys[i + 1]

    def slope(k):
        if k == 0 or k == len(keys) - 1:
            return 0.0
        a = (keys[k][1] - keys[k - 1][1]) / (keys[k][0] - keys[k - 1][0])
        b = (keys[k + 1][1] - keys[k][1]) / (keys[k + 1][0] - keys[k][0])
        return 0.0 if a * b <= 0 else 2 * a * b / (a + b)

    h = t1 - t0
    s = (u - t0) / h
    s2, s3 = s * s, s * s * s
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * h * slope(i) + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * h * slope(i + 1)


def interpolate(track, u):
    """Position (Hermite through the keys) and rotation (eased slerp per span) of (fraction, frame) keys."""
    if u <= track[0][0]:
        return track[0][1]
    if u >= track[-1][0]:
        return track[-1][1]
    i = max(k for k in range(len(track) - 1) if track[k][0] <= u)
    (t0, m0), (t1, m1) = track[i], track[i + 1]
    position = hermite([(t, m.translation) for t, m in track], u)
    q0, q1 = m0.to_quaternion(), m1.to_quaternion()
    if q0.dot(q1) < 0:
        q1.negate()
    m = q0.slerp(q1, smooth((u - t0) / (t1 - t0))).to_matrix().to_4x4()
    m.translation = position
    return m


def key_frame(key):
    """An explicit hand key's frame."""
    if "x" in key:
        return item_frame(v(key["g"]), v(key["b"]), v(key["x"]))
    return frame_of(v(key["g"]), v(key["b"]), v(key["z"]))



def lift(rig, root, joints, floor):
    """Swing ``root`` up about its head until the lowest of ``joints`` is no lower than ``floor``."""
    for _ in range(4):
        z, low = min((rig.head(name).z, name) for name in joints)
        if z >= floor - 1e-3:
            return
        arm = rig.head(low) - rig.head(root)
        flat = Vector((arm.x, arm.y, 0))
        if flat.length < 1e-3:
            return
        rotate_world(rig, root, flat.normalized().cross(UP), math.degrees(min(.6, (floor - z) / max(flat.length, .1))))


def floor_feet(rig, ahead):
    """Keep the feet out of the ground: an ankle below ``FLOOR[0]`` is lifted on to it and a ball below ``FLOOR[1]`` is
    turned up about the ankle. A knee, hand or finger in the ground first swings its whole leg or arm up."""
    for side in "lr":
        lift(rig, LEGS[side][0], [LEGS[side][1]], FLOOR[0])
        fingers = [f"{f}_{k}_{side}" for f in FINGERS for k in ("01", "02", "03")]
        lift(rig, ARMS[side][0], [ARMS[side][1], ARMS[side][2], *fingers], FLOOR[1])
    for side in "lr":
        thigh, calf, foot, ball = LEGS[side]
        hip, knee, ankle = rig.head(thigh), rig.head(calf), rig.head(foot)
        if ankle.z < FLOOR[0]:
            line = (ankle - hip).normalized()
            bend = (knee - hip) - line * (knee - hip).dot(line)
            turn = rig.bones[foot].matrix.to_3x3()
            two_bone(rig, thigh, calf, foot, Vector((ankle.x, ankle.y, FLOOR[0])), bend.normalized() if bend.length > 1e-5 else ahead)
            f = turn.to_4x4()
            f.translation = rig.head(foot)
            rig.bones[foot].matrix = f
            bpy.context.view_layer.update()
        ankle, toe = rig.head(foot), rig.head(ball)
        along = toe - ankle
        flat = Vector((along.x, along.y, 0))
        if toe.z < FLOOR[1] and flat.length > 1e-5:
            rise = FLOOR[1] - ankle.z
            if abs(rise) < along.length:
                want = flat.normalized() * math.sqrt(along.length ** 2 - rise ** 2) + Vector((0, 0, rise))
                pb = rig.bones[foot]
                m = (along.rotation_difference(want).to_matrix() @ pb.matrix.to_3x3()).to_4x4()
                m.translation = pb.head.copy()
                pb.matrix = m
                bpy.context.view_layer.update()



def secondary(rig):
    """The #391 chain pose of this frame (as adapters/blender/strike_clips.py): per chain joint it keys, its local
    rotation (glTF xyzw) under its parent. The front panel rides the higher thigh, each side panel follows its own
    thigh, and past the knee both hang plumb; the back panel and the cape hang but never pass into the legs or back."""
    down = Vector((0, 0, -1))
    thigh = {s: (rig.bones[LEGS[s][1]].head - rig.bones[LEGS[s][0]].head).normalized() for s in "lr"}
    lift_of = {s: math.degrees(math.atan2(max(0.0, -thigh[s].y), max(1e-6, -thigh[s].z))) if thigh[s].z < 0 else 90.0 for s in "lr"}
    reach_of = max(0.0, *(math.degrees(math.asin(max(0.0, min(1.0, thigh[s].y)))) for s in "lr"))
    turn = lambda degrees: Matrix.Rotation(math.radians(degrees), 3, Vector((1, 0, 0))) @ down

    def toward(direction, share, limit):
        angle = min(limit, share * math.degrees(down.angle(direction)))
        axis = down.cross(direction)
        return Matrix.Rotation(math.radians(angle), 3, axis.normalized()) @ down if axis.length > 1e-6 else down

    directions = {
        "skirt_f_01": turn(-min(SWING["front"], SWING["share"] * max(lift_of.values()))),
        "skirt_b_01": turn(min(SWING["back"], SWING["share"] * reach_of)),
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


# --- The Tinker's clips ------------------------------------------------------------------------------------------------
#
# Full-body clips keyed as #773's stance clips (adapters/blender/defend_clips.py): every key is a whole stance. The
# pelvis shifts ``sx``/``sy``/``pz``, pitches ``tip``, rolls ``lean`` and turns ``spin`` (positive to the figure's
# left) about its own head; the chest turns by ``yaw``/``pitch``/``roll``/``neck``/``look`` and the clavicles rise
# ``cl``/``cr``. Each foot is placed by its ball: ``lx``/``ly``/``lz`` from where the idle's ball stands, carried round
# the pelvis's ground point by ``lr`` degrees, turned ``lt`` degrees about its ball and its heel raised ``lh`` degrees
# about the ball (``r...`` for the right foot). Every key adds to its family's stance (``STANCE``). The tracks never
# overshoot a key (``monotone``), so a ball keyed in one place stays exactly there.
#
# The hands are keyed frames (``L``, ``R``: the socket ``s``, the grip ``g``, the item's +Y ``b`` and a hint for its
# +Z ``z`` or +X ``x``, the hand shape) in the stance's own space, each carried with the chest (``spine_03``) from
# where it stands in the stance, or fixed in place (``"on": "ground"``) for a hand on the set trap. ``"ready"`` is the
# family's ready hand and ``"seed"`` the hand as the idle holds it. A hand with no keys keeps the idle's arm.
STANCE_FIELDS = ("sx", "sy", "pz", "tip", "lean", "spin", "yaw", "pitch", "roll", "neck", "look", "cl", "cr",
                 "lx", "ly", "lz", "lr", "lt", "lh", "lk", "rx", "ry", "rz", "rr", "rt", "rh", "rk")
# The Tinker's ready stance: the feet a little wider and the right one back, the knees soft, the throwing (right)
# shoulder turned back and the chest over the hips. Placing the trap starts and ends in the idle's own stance.
STANCE = {
    "ready": {"pz": -.04, "ly": -.03, "ry": .05, "rt": -6, "spin": -8, "tip": 3, "yaw": 2, "pitch": 3},
    "trap": {},
}
R_READY = "ready"
# The flask held up at the belt in front of the right hip, the neck up; the free left fist loose in front of the belt.
READY_HANDS = {
    "ready": {"R": {"s": "weapon", "g": (-.25, -.24, 1.1), "b": (.05, -.08, 1), "x": (.45, -1, 0), "shape": "grip"},
              "L": {"s": "palm_l", "g": (.2, -.21, .99), "b": (-.3, -.7, -.45), "x": (0, .1, -1), "shape": "fist", "pole": (.4, .1, -1)}},
}
# #775's trap item: its grip on the D-handle's bar; set down, the bar lies across the figure (item +Y back, +Z up) and
# its ground frame, under the trap's middle, is at TRAP_GROUND in the item frame.
TRAP_GROUND = Vector((.19, 0, -.055))
SET = (-.12, -.5)
TRAP_HANDLE = {"s": "weapon", "on": "ground", "g": (SET[0] - .19, SET[1], .055), "b": (0, 1, 0), "z": (0, 0, 1), "shape": "grip"}
TINKER = {
    # Kneel, set the trap, arm it: the weight goes to the right foot and the head looks down at the spot; the left foot
    # steps forward and the body sinks on to the right knee, the chest folding over the left thigh while the trap
    # swings forward and down and the left hand steadies its far side; it is set flat (``placeSeconds``). Both palms
    # press the jaws open, the shoulders bearing down, the right hand sets the dog (``armSeconds``) and the hands lift
    # off; the body rises over the left foot, which steps back to the idle.
    "Tinker_Place_Trap": {"family": "trap", "duration": 2.6, "kind": "place-trap", "place": .4, "arm": .66, "keys": [
        (0, {"R": "seed"}),
        (.07, {"sx": -.03, "pz": -.01, "neck": 10, "look": 4, "lh": 6}),
        (.13, {"ly": -.16, "lz": .07, "lh": 2, "sy": -.03, "pz": -.04, "tip": 4, "pitch": 6, "neck": 16}),
        (.2, {"ly": -.38, "lx": .04, "lz": 0, "lh": 0, "sx": -.01, "sy": -.1, "pz": -.14, "tip": 8, "pitch": 12, "rh": 25, "rk": .6, "rt": 20,
              "R": {"s": "weapon", "on": "ground", "g": (-.3, -.3, .5), "b": (0, 1, 0), "z": (1, 0, 0), "shape": "grip"}}),
        (.32, {"sy": -.05, "pz": -.555, "tip": 26, "pitch": 40, "roll": -4, "neck": 14, "rh": 80, "rk": 1, "rt": 35,
               "R": {"s": "weapon", "on": "ground", "g": (SET[0] - .19, SET[1] + .02, .14), "b": (0, 1, 0), "z": (.3, 0, 1), "shape": "grip"},
               "L": {"s": "palm_l", "on": "ground", "g": (SET[0] + .2, SET[1], .12), "b": (0, -.4, -1), "z": (-1, 0, 0), "shape": "open"}}),
        (.4, {"pz": -.565, "tip": 32, "pitch": 52, "neck": 2, "cr": -8, "R": TRAP_HANDLE,
              "L": {"s": "palm_l", "on": "ground", "g": (SET[0] + .2, SET[1], .08), "b": (0, -.4, -1), "z": (-1, 0, 0), "shape": "open"}}),
        (.47, {"pitch": 48, "neck": 0, "cr": -4,
               "R": {"s": "palm_r", "on": "ground", "g": (SET[0] - .1, SET[1] - .04, .1), "b": (.15, -.6, -.8), "z": (0, 0, -1), "shape": "open"},
               "L": {"s": "palm_l", "on": "ground", "g": (SET[0] + .1, SET[1] - .04, .1), "b": (-.15, -.6, -.8), "z": (0, 0, -1), "shape": "open"}}),
        (.56, {"pz": -.575, "tip": 32, "pitch": 52, "cl": -6, "cr": -6,
               "R": {"s": "palm_r", "on": "ground", "g": (SET[0] - .12, SET[1] - .05, .05), "b": (.2, -.6, -.8), "z": (0, 0, -1), "shape": "open"},
               "L": {"s": "palm_l", "on": "ground", "g": (SET[0] + .12, SET[1] - .05, .05), "b": (-.2, -.6, -.8), "z": (0, 0, -1), "shape": "open"}}),
        (.66, {"pz": -.565, "tip": 31, "pitch": 50, "cl": -4, "cr": -5,
               "R": {"s": "palm_r", "on": "ground", "g": (SET[0], SET[1] - .1, .08), "b": (.1, -.6, -.8), "z": (0, 0, -1), "shape": "grip"},
               "L": {"s": "palm_l", "on": "ground", "g": (SET[0] + .12, SET[1] - .05, .055), "b": (-.2, -.6, -.8), "z": (0, 0, -1), "shape": "open"}}),
        (.75, {"pz": -.53, "tip": 20, "pitch": 30, "cl": 0, "cr": 0, "neck": 16,
               "R": {"s": "palm_r", "on": "ground", "g": (-.2, -.42, .36), "b": (.1, -.5, -.85), "z": (-.3, 0, -1), "shape": "open"},
               "L": {"s": "palm_l", "on": "ground", "g": (.14, -.4, .42), "b": (-.1, -.5, -.85), "z": (.3, 0, -1), "shape": "open"}}),
        (.86, {"sy": -.08, "pz": -.16, "tip": 8, "pitch": 10, "roll": 0, "neck": 8, "rh": 26, "rk": .4, "rt": 15, "R": "seed", "L": "seed"}),
        (.92, {"ly": -.16, "lx": .02, "lz": .07, "sy": -.02, "pz": -.04, "tip": 3, "pitch": 4, "rh": 6, "rk": 0, "rt": 0}),
        (.97, {"ly": 0, "lx": 0, "lz": 0, "sy": 0, "pz": -.01, "tip": 0, "pitch": 1, "neck": 2, "rh": 0, "sx": 0, "look": 0}),
        (1, {"pz": 0, "pitch": 0, "neck": 0, "R": "seed", "L": "seed"})]},
    # An underhand lob: the weight rocks back on to the right foot as the flask swings down and back past the hip and
    # the left hand points at the target; the left foot steps in, the hips and chest turn through and the arm swings
    # up and out, letting the flask go in front of the chest (``releaseSeconds``) with the fingers opening; the body
    # follows over the front foot, the hand draws a fresh flask from the right hip (``drawSeconds``) and the left foot
    # steps back into the ready stance.
    "Tinker_Throw_Flask": {"family": "ready", "duration": 1.2, "kind": "throw-flask", "release": .45, "draw": .78, "keys": [
        (0, {"R": R_READY, "L": R_READY}),
        (.22, {"sy": .05, "pz": -.03, "tip": -2, "spin": -12, "yaw": -6, "pitch": 1, "look": 6, "lh": 12, "cr": -2,
               "R": {"s": "weapon", "g": (-.3, .16, .78), "b": (-.15, .6, .75), "x": (-.3, .6, -.5), "shape": "grip"},
               "L": {"s": "palm_l", "g": (.26, -.5, 1.24), "b": (-.1, -1, .25), "z": (-.2, 0, -1), "shape": "open", "pole": (.8, .2, -.6)}}),
        (.31, {"ly": -.08, "lz": .05, "lh": 4}),
        (.38, {"ly": -.18, "lz": 0, "lh": 0, "sy": -.02, "spin": -2, "yaw": -1, "pz": -.06, "rh": 8}),
        (.45, {"sy": -.08, "pz": -.06, "tip": 6, "spin": 8, "yaw": 6, "pitch": 6, "look": 0, "rh": 22, "cr": 4,
               "R": {"s": "weapon", "g": (-.3, -.46, 1.1), "b": (-.05, -.55, .85), "x": (.2, -.6, -.75), "shape": "grip"},
               "L": {"s": "palm_l", "g": (.3, -.22, 1.05), "b": (-.2, -.5, -.7), "x": (0, .1, -1), "shape": "fist"}}),
        (.55, {"sy": -.1, "pz": -.07, "tip": 8, "spin": 10, "yaw": 8, "pitch": 8, "rh": 26,
               "R": {"s": "palm_r", "g": (-.27, -.5, 1.4), "b": (-.05, -.4, .9), "z": (.2, -.9, -.1), "shape": "open"}}),
        (.68, {"sy": -.06, "pz": -.05, "tip": 4, "spin": 4, "yaw": 3, "pitch": 4, "rh": 14, "cr": 0,
               "R": {"s": "palm_r", "g": (-.3, -.34, 1.14), "b": (.1, -.3, -.95), "z": (-.6, -.4, -.2), "shape": "open"}}),
        (.78, {"sy": -.03, "spin": 0, "yaw": 0, "rh": 6,
               "R": {"s": "weapon", "g": (-.27, -.05, .97), "b": (0, -.1, 1), "x": (.3, -1, 0), "shape": "grip"}}),
        (.86, {"ly": -.08, "lz": .05, "sy": 0, "pz": -.03, "tip": 1, "pitch": 1, "rh": 0}),
        (.93, {"ly": 0, "lz": 0, "pz": -.01, "tip": 0, "pitch": 0}),
        (1, {"sy": 0, "pz": 0, "R": R_READY, "L": R_READY})]},
    # An overhand lob that lights the fuse first: the bomb comes up in front of the chest and the left hand strikes a
    # flint along the fuse (``lightSeconds``, the head bent over it); the weight goes back on the right foot, the bomb
    # is cocked high behind the head and the left arm points; the left foot steps in, the hips, chest and shoulder
    # whip through and the bomb leaves the hand high in front of the head (``releaseSeconds``), the arm following down
    # across the body; the hand draws a flask from the hip (``drawSeconds``) and the stance resets.
    "Tinker_Throw_Bomb": {"family": "ready", "duration": 1.6, "kind": "throw-bomb", "light": .24, "release": .565, "draw": .82, "keys": [
        (0, {"R": R_READY, "L": R_READY}),
        (.14, {"pitch": 6, "neck": 18, "look": -4, "pz": -.05,
               "R": {"s": "weapon", "g": (-.1, -.32, 1.18), "b": (.4, -.2, .9), "x": (.6, -.8, -.2), "shape": "grip"},
               "L": {"s": "palm_l", "g": (.09, -.31, 1.27), "b": (-.6, -.2, -.3), "x": (0, -.3, -1), "shape": "fist", "pole": (.9, .2, -.5)}}),
        (.24, {"pitch": 7, "neck": 20,
               "L": {"s": "palm_l", "g": (.17, -.36, 1.3), "b": (-.7, -.3, .1), "x": (0, -.3, -1), "shape": "fist", "pole": (.9, .2, -.5)}}),
        (.32, {"neck": 4, "pitch": 2, "L": {"s": "palm_l", "g": (.22, -.3, 1.16), "b": (-.3, -.6, -.4), "x": (0, .1, -1), "shape": "fist"}}),
        (.44, {"sy": .06, "pz": -.03, "tip": -4, "spin": -16, "yaw": -10, "pitch": -4, "neck": -2, "look": 10, "lh": 14, "cr": 6,
               "R": {"s": "weapon", "g": (-.3, .14, 1.62), "b": (-.2, .6, .75), "x": (-.2, -.6, .7), "shape": "grip", "pole": (-.7, .5, -.3)},
               "L": {"s": "palm_l", "g": (.14, -.54, 1.42), "b": (-.1, -1, .35), "z": (-.2, 0, -1), "shape": "open", "pole": (.8, .2, -.6)}}),
        (.5, {"ly": -.08, "lz": .05, "lh": 4}),
        (.55, {"ly": -.2, "lz": 0, "lh": 0, "sy": .0, "spin": -6, "yaw": -4, "pz": -.06, "rh": 10}),
        (.58, {"sy": -.06, "pz": -.07, "tip": 4, "spin": 4, "yaw": 4, "pitch": 6, "look": 2, "rh": 20, "cr": 2,
               "R": {"s": "weapon", "g": (-.3, -.4, 1.74), "b": (.0, -.85, .5), "x": (-.1, -.5, -.85), "shape": "grip", "pole": (-.7, .5, -.3)},
               "L": {"s": "palm_l", "g": (.3, -.2, 1.08), "b": (-.2, -.5, -.7), "x": (0, .1, -1), "shape": "fist"}}),
        (.66, {"sy": -.11, "pz": -.09, "tip": 9, "spin": 12, "yaw": 9, "pitch": 14, "look": 0, "rh": 30, "cr": 0,
               "R": {"s": "palm_r", "g": (.02, -.5, 1.1), "b": (.3, -.5, -.7), "z": (.6, .2, -.5), "shape": "open"}}),
        (.74, {"sy": -.08, "pz": -.07, "tip": 6, "spin": 8, "yaw": 6, "pitch": 10, "rh": 22,
               "R": {"s": "palm_r", "g": (.04, -.38, .92), "b": (.2, -.2, -.95), "z": (.6, .4, -.3), "shape": "open"}}),
        (.82, {"sy": -.04, "spin": 0, "yaw": 0, "pitch": 3, "rh": 8,
               "R": {"s": "weapon", "g": (-.27, -.05, .97), "b": (0, -.1, 1), "x": (.3, -1, 0), "shape": "grip"}}),
        (.89, {"ly": -.1, "lz": .05, "sy": 0, "pz": -.03, "tip": 1, "pitch": 1, "rh": 0}),
        (.95, {"ly": 0, "lz": 0, "pz": -.01, "tip": 0, "pitch": 0}),
        (1, {"sy": 0, "pz": 0, "R": R_READY, "L": R_READY})]},
    # Ready with a flask: the weight rocks from foot to foot, the chest breathes, the head watches left and right, and
    # the right hand weighs the flask, bouncing it once in the palm.
    "Tinker_Ready_Loop": {"family": "ready", "duration": 2.4, "kind": "ready", "loop": True, "keys": [
        (0, {"R": R_READY, "L": R_READY}),
        (.2, {"sx": .012, "pz": -.006, "lh": 0, "rh": 4, "look": 8, "pitch": 1, "R": R_READY}),
        (.32, {"R": {"s": "weapon", "g": (-.25, -.25, 1.15), "b": (.08, -.1, 1), "x": (.45, -1, 0), "shape": "grip"}}),
        (.42, {"R": R_READY}),
        (.5, {"sx": 0, "pz": 0, "rh": 0, "look": 0, "pitch": -.5, "cl": 1, "cr": 1.5}),
        (.75, {"sx": -.012, "pz": -.006, "lh": 4, "look": -8, "pitch": 1, "cl": 0, "cr": 0}),
        (1, {"sx": 0, "pz": 0, "lh": 0, "look": 0, "pitch": 0, "R": R_READY, "L": R_READY})]},
}
CLIPS = tuple(TINKER)
# The items the clips hold: the flask, the bomb and the trap on the right hand's weapon socket.
ITEMS = {"Tinker_Place_Trap": {"trap": {"item": "equipment.tinker.trap", "socket": "hand_r.weapon"}},
         "Tinker_Throw_Flask": {"flask": {"item": "equipment.tinker.flask", "socket": "hand_r.weapon"}},
         "Tinker_Throw_Bomb": {"bomb": {"item": "equipment.tinker.bomb", "socket": "hand_r.weapon"}},
         "Tinker_Ready_Loop": {"flask": {"item": "equipment.tinker.flask", "socket": "hand_r.weapon"}}}


def stance_tracks(spec):
    """Every field's keys (each holding what a key leaves out at the previous key's value), plus the family's stance."""
    stance = STANCE[spec["family"]]
    held, tracks = {name: 0.0 for name in STANCE_FIELDS}, {name: [] for name in STANCE_FIELDS}
    for u, key in spec["keys"]:
        held.update({name: value for name, value in key.items() if name in STANCE_FIELDS})
        for name in STANCE_FIELDS:
            tracks[name].append((u, float(held[name]) + stance.get(name, 0.0)))
    return tracks


def stance_pose(rig, seed, idle, k):
    """The body of one frame: the pelvis moved and turned, each foot on its ball's key, the chest and clavicles."""
    rig.apply(seed)
    pelvis = rig.bones["pelvis"]
    head = rig.head("pelvis")
    for axis, degrees in ((UP, k["spin"]), (X, k["tip"]), (Y, k["lean"])):
        if degrees:
            rotate_world(rig, "pelvis", axis, degrees)
    m = pelvis.matrix.copy()
    m.translation = head + Vector((k["sx"], k["sy"], k["pz"]))
    pelvis.matrix = m
    bpy.context.view_layer.update()
    ground = Vector((head.x, head.y, 0))
    for side in "lr":
        thigh, calf, foot, _ = LEGS[side]
        ankle, turn, ball, bend = idle[side]
        around = Matrix.Rotation(math.radians(k[side + "r"]), 3, UP)
        yaw = Matrix.Rotation(math.radians(k[side + "r"] + k[side + "t"]), 3, UP)
        heel_axis = (ankle - ball).cross(UP).normalized()
        heel = Matrix.Rotation(math.radians(k[side + "h"]), 3, heel_axis)
        at = ground + around @ (ball + Vector((k[side + "x"], k[side + "y"], k[side + "z"])) - ground)
        target = at + yaw @ heel @ (ankle - ball)
        knee = (bend * (1 - k[side + "k"]) + KNEE * k[side + "k"]).normalized()
        two_bone(rig, thigh, calf, foot, target, yaw @ knee)
        f = (yaw @ heel @ turn.to_matrix()).to_4x4()
        f.translation = rig.head(foot)
        rig.bones[foot].matrix = f
        bpy.context.view_layer.update()
    turn_chest(rig, k["yaw"], k["pitch"], k["roll"], k["neck"], look=k["look"])
    for side in "lr":
        raised = k["c" + side]
        if raised:
            rotate_world(rig, f"clavicle_{side}", Y, -raised if side == "l" else raised)


def hand_key(value, ready, seed_frames, side):
    """A keyed hand as (socket, frame in the stance's space, the joint carrying it, pole, shape)."""
    if value == R_READY:
        value = ready[side]
    if value == "seed":
        socket, frame = seed_frames[side]
        return socket, frame, "spine_03", POLE[side.lower()], "seed"
    pole = v(value["pole"]) if "pole" in value else POLE[side.lower()]
    return value["s"], key_frame(value), value.get("on", "spine_03"), pole, value.get("shape", "grip")


def seed_fingers(seed, hands, side):
    return {name: seed[name].copy() for name in hands.joints[side]}


def tinker_clip(rig, seed, clip):
    spec = TINKER[clip]
    family = spec["family"]
    hands = Hands(rig, seed)
    rig.apply(seed)
    idle = {}
    for side in "lr":
        thigh, calf, foot, ball = LEGS[side]
        hip, knee, ankle = rig.head(thigh), rig.head(calf), rig.head(foot)
        line = (ankle - hip).normalized()
        bend = (knee - hip) - line * (knee - hip).dot(line)
        idle[side] = (ankle, rig.bones[foot].matrix.to_quaternion(), rig.head(ball), bend.normalized() if bend.length > .02 else KNEE)
    # The idle's own hands, as the sockets the clip's keys name: the right hand's weapon socket (the trap hangs from
    # it), the free hand's palm.
    seed_frames = {"R": ("weapon", rig.grip("weapon")), "L": ("palm_l", rig.grip("palm_l"))}
    tracks = stance_tracks(spec)
    # The stance itself, from which every hand key is carried.
    stance_pose(rig, seed, idle, {name: STANCE[family].get(name, 0.0) for name in STANCE_FIELDS})
    reference = rig.bones["spine_03"].matrix.copy()
    ready = READY_HANDS.get(family, {})
    keyed = {side: [(u, hand_key(key[side], ready, seed_frames, side)) for u, key in spec["keys"] if side in key] for side in "LR"}
    count = frames_of(spec["duration"])
    poses, grips = [], []
    for frame in range(count + 1):
        u = frame / count
        stance_pose(rig, seed, idle, {name: monotone(track, u) for name, track in tracks.items()})
        carry = {"spine_03": rig.bones["spine_03"].matrix @ reference.inverted(), "ground": Matrix.Identity(4)}
        shapes = {}
        for side in "RL":
            track = keyed[side]
            if not track:
                continue
            # Each key is carried with its joint as it stands now, then the keys are interpolated.
            frames = [(t, carry[on] @ frame_) for t, (_, frame_, on, _, _) in track]
            nearest = min(track, key=lambda item: abs(item[0] - u))[1]
            socket, pole = nearest[0], nearest[3]
            placed = interpolate(frames, u)
            reach(rig, socket, placed)
            place_grip(rig, socket, placed, pole)
            shapes[side.lower()] = nearest[4]
        for side, shape in shapes.items():
            rig.apply(seed_fingers(seed, hands, side) if shape == "seed" else hands.shape(side, shape))
        floor_feet(rig, Vector((0, -1, 0)))
        poses.append(rig.capture())
        grips.append(rig.grip("weapon"))
    rest = STAND if family == "trap" else "Tinker_Ready_Loop"
    observed = {"kind": spec["kind"], "items": ITEMS[clip], "from": rest, "to": rest}
    marks = {}
    for mark, field in (("place", "placeSeconds"), ("arm", "armSeconds"), ("light", "lightSeconds"), ("release", "releaseSeconds"),
                        ("draw", "drawSeconds")):
        if mark in spec:
            marks[mark] = int(round(spec[mark] * count))
            observed[field] = round(marks[mark] / FPS, 4)
    if "place" in marks:
        # Where the trap's ground frame is as it is set down: the consumer leaves the trap there.
        observed["trapAt"] = root_point(grips[marks["place"]] @ TRAP_GROUND)
    if "release" in marks:
        # The item's grip at the release and its direction of travel over the frame before, in the root frame.
        at, before = grips[marks["release"]].translation, grips[marks["release"] - 1].translation
        observed["releaseAt"] = root_point(at)
        direction = C4.inverted().to_3x3() @ (at - before).normalized()
        observed["releaseDirection"] = [round(c, 4) for c in direction]
    return poses, {"tinker": observed}


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS; the loop repeats its first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    poses, observations = tinker_clip(rig, sample(rig, actions[STAND], 0.0), clip)
    observations["secondaryPose"] = record_chains(rig, poses)
    return poses, {"source": STAND, "durationSeconds": round((len(poses) - 1) / FPS, 4), **observations}


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
    return {"recipe": "tinker-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
