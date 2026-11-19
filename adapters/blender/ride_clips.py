"""Original riding clips authored on the Ranger rig in Blender (#769): mounting, dismounting and riding the tacked horse
of the ``mounts`` release (adapters/blender/mounts.py) through its gaits.

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), on top of the first ``Idle_Loop`` pose. Each clip is a list of
keys (see ``LAYOUT``): the pelvis, the balls of the feet, the chest, the clavicles and palm targets, solved with two-bone
arm and leg IK. No source motion is copied.

**The seat frame.** The game parents the rider's root to the horse's ``saddle.seat`` socket, which rides the horse's
``Torso2`` bone with ``reins.l`` / ``reins.r`` and ``stirrup.l`` / ``stirrup.r``. In every clip the root stays at the
origin and the pelvis joint sits on it while seated, so the horse's own gait carries the rider; the arguments
``tack`` give the rein hands and the stirrup treads in that frame (metres, +X the rider's left, +Y up, +Z ahead), the
same numbers the horse recipe placed its tack with. The balls of the feet stay on the treads and the palms on the reins
(fists closed round them) in every seated frame.

- ``Ride_Idle_Loop``: seated at a halt, breathing, looking round.
- ``Ride_Walk_Loop`` / ``Ride_Trot_Loop`` / ``Ride_Canter_Loop`` / ``Ride_Gallop_Loop``: as long as the horse's
  ``Walk_Loop`` ... ``Gallop_Loop`` (arguments ``gaits``) and in phase with them (phase 0 is the left hind's
  touchdown). The walk follows the swing of the horse's back; the trot posts, rising out of the saddle for one diagonal
  beat and sitting the next; the canter's seat follows the rocking while the shoulders stay quiet; the gallop rides
  forward out of the saddle (two-point), leaning into the stride with the hands forward along the reins.
- ``Ride_Turn_L`` / ``Ride_Turn_R``: as long as the horse's ``Turn_L`` / ``Turn_R``, looking and leaning into the
  turn, the inside hand opening.
- ``Mount_Horse``: from standing on the ground at the horse's near (left) side, facing it, the left foot into the
  stirrup, a spring up, the right leg swung over the croup, seated. ``Dismount_Horse`` is the way back down. The
  ground is ``seatHeight`` below the seat; each reports where the rider stands (``standAt``, glTF, seat frame) and the
  facing.

Full body; each records a skirt and cape pose for the #391 chain joints (``secondaryPose``). No randomness.
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
FINGERS = ("index", "middle", "ring", "pinky", "thumb")
# The hand shapes (as move_clips.py): degrees per finger joint toward the palm, and a spread per finger.
SHAPES = {
    "flat": {"curl": {"index": (0, 2, 2), "middle": (0, 2, 2), "ring": (0, 2, 2), "pinky": (0, 3, 2), "thumb": (0, 4, 4)},
             "spread": {"index": 3, "ring": 3, "pinky": 6, "thumb": 8}},
    "rest": {"curl": {"index": (14, 18, 12), "middle": (16, 20, 12), "ring": (18, 22, 14), "pinky": (20, 24, 14), "thumb": (6, 10, 10)},
             "spread": {"pinky": 4}},
    "grip": {"curl": {"index": (50, 70, 45), "middle": (52, 72, 46), "ring": (54, 72, 46), "pinky": (56, 74, 48), "thumb": (25, 35, 30)},
             "spread": {}},
}
# Points in the palm frame (the wrist, +Y toward the fingers, +Z out of the palm): the middle of the palm.
PALM = Vector((0, .05, .02))
# The #391 chain joints and how far the panels follow the thighs (as the social clips).
CAPE = "cape_01"
SWING = {"share": .7, "front": 70.0, "sideShare": .8, "side": 75.0, "back": 20.0}
BACK = Vector((0, 1, 0))
PLUMB = ("skirt_f_03", "skirt_l_02", "skirt_r_02")


def hand(point, fingers, normal, fixed=1.0):
    """A palm target as the channels HL and HR key it; ``fixed`` 1 holds it in the seat frame."""
    return (*point, *fingers, *normal, fixed)


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


def blend(a, b, w):
    la, ra, _ = a.decompose()
    lb, rb, _ = b.decompose()
    return Matrix.LocRotScale(la.lerp(lb, w), ra.slerp(rb, w), Vector((1, 1, 1)))


def one_shot(duration, frame):
    count = frames_of(duration)
    return [frame(k / count) for k in range(count + 1)]


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


# --- Keyed seat-frame poses ------------------------------------------------------------------------------------------

# Blender armature axes in the seat frame: +X the rider's left, -Y ahead, +Z up; the root (and the seat) at the origin.
# A clip is keyed as in move_clips.py, but with absolute targets:
# - ``P`` the pelvis joint's position and ``T`` its turn from the seed (tip forward, roll, yaw; degrees);
# - ``L``, ``R`` each ball of the foot's position, its pitch about the ball (+ lifts the heel) and yaw (+ turns the toes
#   to the figure's left), the ankle solved with two-bone leg IK, the knee towards ``KL`` / ``KR``;
# - ``C`` the chest (yaw, pitch, roll, neck, look; as ``turn_chest``) and ``S`` the clavicles raised (left, right);
# - ``HL``, ``HR`` a palm target (its middle, the fingers, the palm's normal) and how much of it stays fixed in the seat
#   frame (1) rather than carried with the chest (0); ``WL``, ``WR`` how far each palm goes to it from the seed's,
#   ``EL``, ``ER`` the elbow poles; ``G`` the hand shapes (+ toward a fist, - toward a flat hand).
LAYOUT = (("P", 3), ("T", 3), ("L", 5), ("R", 5), ("KL", 3), ("KR", 3), ("C", 5), ("S", 2), ("HL", 10), ("HR", 10), ("WL", 1),
          ("WR", 1), ("EL", 3), ("ER", 3), ("G", 2))
# The seated pose round the tack: the pelvis tipped, heels down and toes out, knees out and forward along the flaps,
# elbows back at the sides, fists on the reins with the thumbs up.
SEATED = {"tip": -4.0, "heel": -14.0, "toeOut": 12.0, "knee": (1.6, -.85, 0.0), "elbow": (.35, .9, -.7),
          "fingers": (-.25, -.55, -.8), "normal": (-1.0, -.1, .15), "fist": .9}
# The posting trot: rising (metres up and ahead, the pelvis tipping forward) for one diagonal beat and sitting the next.
POST = {"rise": .075, "ahead": .06, "tip": 14.0, "up": (.25, .65), "peak": .45}
# Two-point at the gallop: the seat lifted back out of the saddle, the trunk folded forward, the hands forward along
# the reins and the eyes up.
TWO_POINT = {"up": .07, "back": .12, "tip": 34.0, "chest": 10.0, "neck": -32.0, "hands": .1, "pump": .012}
# How far a hip may be from its ankle, as a share of the leg (thigh and shin): a knee bent to about 145 degrees.
REACH = .96
MOUNT = {"duration": 3.0, "away": .7, "yaw": -90.0}
DISMOUNT = {"duration": 2.6}
CLIPS = ("Mount_Horse", "Dismount_Horse", "Ride_Idle_Loop", "Ride_Walk_Loop", "Ride_Trot_Loop", "Ride_Canter_Loop", "Ride_Gallop_Loop",
         "Ride_Turn_L", "Ride_Turn_R")
GAITS = {"Ride_Walk_Loop": "Walk_Loop", "Ride_Trot_Loop": "Trot_Loop", "Ride_Canter_Loop": "Canter_Loop", "Ride_Gallop_Loop": "Gallop_Loop",
         "Ride_Turn_L": "Turn_L", "Ride_Turn_R": "Turn_R", "Ride_Idle_Loop": "Ride_Idle_Loop"}
ARGUMENTS = {"schemaVersion", "clips", "gaits", "tack", "seatHeight"}


def validate(p, inputs):
    if type(p) is not dict or set(p) != ARGUMENTS:
        raise ValueError(f"ride clips require exactly {sorted(ARGUMENTS)}")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"ride clips must be distinct names from {CLIPS}")
    if type(p["gaits"]) is not dict or set(p["gaits"]) != set(GAITS.values()) or not all(
            type(g) is dict and type(g.get("seconds")) in (int, float) and g["seconds"] > 0 for g in p["gaits"].values()):
        raise ValueError(f"ride clips need the horse's {sorted(GAITS.values())} seconds")
    tack = p["tack"]
    if type(tack) is not dict or set(tack) != {"reins", "stirrup"} or not all(
            type(tack[k]) is list and len(tack[k]) == 3 and all(type(c) in (int, float) for c in tack[k]) for k in tack):
        raise ValueError("ride clips take the tack's left reins and stirrup points in the seat frame")
    if type(p["seatHeight"]) not in (int, float) or not 1.0 < p["seatHeight"] < 2.5:
        raise ValueError("ride clips take the seat's height above the ground")
    if set(inputs) != {"target"}:
        raise ValueError("ride clips take exactly the declared input target")


def seat_point(p):
    """A seat-frame point (+X left, +Y up, +Z ahead) in the rig's armature axes."""
    return Vector((p[0], -p[2], p[1]))


def unpack(flat):
    out, k = {}, 0
    for name, size in LAYOUT:
        out[name] = flat[k:k + size]
        k += size
    return out


def flatten(keys, base):
    """``keys`` [(fraction, {channel: values})] as [(fraction, [floats])], each key filling what it leaves out from
    the key before (the first from ``base``)."""
    state, out = dict(base), []
    for u, changes in keys:
        unknown = set(changes) - set(state)
        if unknown:
            raise ValueError(f"unknown channels {sorted(unknown)}")
        state = {**state, **{name: tuple(float(x) for x in value) for name, value in changes.items()}}
        out.append((u, [x for name, _ in LAYOUT for x in state[name]]))
    return out


class Rider(Actor):
    """The actor in the seat frame: the seed's ankle-from-ball offsets and pelvis frame, and the tack."""

    def __init__(self, rig, seed, tack, ground):
        super().__init__(rig, seed)
        self.ground = ground
        self.stirrup = {"l": seat_point(tack["stirrup"]), "r": seat_point((-tack["stirrup"][0], *tack["stirrup"][1:]))}
        self.reins = {"l": seat_point(tack["reins"]), "r": seat_point((-tack["reins"][0], *tack["reins"][1:]))}
        rig.apply(seed)
        self.pelvis_seed = rig.bones["pelvis"].matrix.copy()
        self.ankle_from_ball = {side: self.feet[side][0] - self.balls[side] for side in "lr"}
        self.leg = {side: rig.length(LEGS[side][0], LEGS[side][1]) + rig.length(LEGS[side][1], LEGS[side][2]) for side in "lr"}

    def rein_hand(self, side, along=0.0, out=0.0):
        """A fist on the rein at the hand point, ``along`` metres down the rein toward the bit (ahead and a little down),
        ``out`` to the side."""
        s = 1 if side == "l" else -1
        point = self.reins[side] + Vector((s * out, -along, -.35 * along))
        fx, fy, fz = SEATED["fingers"]
        nx, ny, nz = SEATED["normal"]
        return hand(point, (s * fx, fy, fz), (s * nx, ny, nz), 1.0)

    def seated(self, **over):
        """The seated state, with ``over`` replacing channels."""
        state = {"P": (0.0, 0.0, 0.0), "T": (SEATED["tip"], 0.0, 0.0), "C": (0.0,) * 5, "S": (0.0, 0.0),
                 "L": (*self.stirrup["l"], SEATED["heel"], SEATED["toeOut"]), "R": (*self.stirrup["r"], SEATED["heel"], -SEATED["toeOut"]),
                 "KL": SEATED["knee"], "KR": (-SEATED["knee"][0], *SEATED["knee"][1:]),
                 "HL": self.rein_hand("l"), "HR": self.rein_hand("r"), "WL": (1.0,), "WR": (1.0,),
                 "EL": SEATED["elbow"], "ER": (-SEATED["elbow"][0], *SEATED["elbow"][1:]), "G": (SEATED["fist"], SEATED["fist"])}
        state.update(over)
        return state

    def standing(self, at, yaw, **over):
        """Standing on the ground with the pelvis over ``at`` (x, y), turned ``yaw`` degrees, arms at the seed's."""
        turn = Matrix.Rotation(math.radians(yaw), 3, UP)
        pelvis = self.pelvis_seed.translation
        place = Vector((at[0], at[1], self.ground + pelvis.z))
        feet = {}
        for side in "lr":
            ball = place + turn @ (self.balls[side] - pelvis)
            feet[side] = (ball.x, ball.y, ball.z, 0.0, yaw)
        knee = turn @ Vector((0, -1, 0))
        state = self.seated(P=tuple(place), T=(0.0, 0.0, yaw), L=feet["l"], R=feet["r"], KL=tuple(knee), KR=tuple(knee),
                            WL=(0.0,), WR=(0.0,), G=(0.0, 0.0), EL=tuple(POLE["l"]), ER=tuple(POLE["r"]))
        state.update(over)
        return state


def ride_body(rider, s):
    """Put the pelvis on its target, turned; plant each ball on its target and raise the clavicles."""
    rig = rider.rig

    def body():
        m = rider.pelvis_seed.copy()
        m.translation = Vector(s["P"])
        rig.bones["pelvis"].matrix = m
        bpy.context.view_layer.update()
        tip, roll, yaw = s["T"]
        for axis, degrees in ((X, tip), (Y, roll), (UP, yaw)):
            if degrees:
                rotate_world(rig, "pelvis", axis, degrees)
        # Keep a bent knee: lower the pelvis until no hip is further from its ankle than ``REACH`` of the leg (a shorter
        # figure rises a little less out of the saddle on the same stirrups).
        drop = 0.0
        for side, channel in (("l", "L"), ("r", "R")):
            bx, by, bz, pitch, turn_ = s[channel]
            turn = Matrix.Rotation(math.radians(turn_), 3, UP) @ Matrix.Rotation(math.radians(pitch), 3, X)
            ankle = Vector((bx, by, bz)) + turn @ rider.ankle_from_ball[side]
            hip = rig.head(LEGS[side][0])
            flat = (hip - ankle).xy.length
            limit = REACH * rider.leg[side]
            if (hip - ankle).length > limit and flat < limit:
                drop = max(drop, (hip.z - ankle.z) - math.sqrt(limit * limit - flat * flat))
        if drop:
            move_pelvis(rig, Vector((0, 0, -drop)))
        feet = {}
        for side, channel in (("l", "L"), ("r", "R")):
            ankle, matrix, _ = rider.feet[side]
            bx, by, bz, pitch, turn_ = s[channel]
            turn = Matrix.Rotation(math.radians(turn_), 3, UP) @ Matrix.Rotation(math.radians(pitch), 3, X)
            feet[side] = (Vector((bx, by, bz)) + turn @ rider.ankle_from_ball[side], (turn @ matrix.to_3x3()).to_4x4(), Vector(s["K" + side.upper()]))
        plant_feet(rig, feet)
        for side, raised in zip("lr", s["S"]):
            if raised:
                rotate_world(rig, f"clavicle_{side}", Y, -raised if side == "l" else raised)

    return body


def ride_frame(rider, s):
    carry = rider.carry

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
            out[side] = ("palm_" + side, blend(chest @ rider.seed_palm[side], placed, min(1.0, w)), Vector(s["E" + side.upper()]))
        return out

    shapes = {side: ("rest", "grip", min(1.0, g)) if g >= 0 else ("rest", "flat", min(1.0, -g)) for side, g in zip("lr", s["G"])}
    yaw, pitch, roll, neck, look = s["C"]
    return rider.pose(hands, {"yaw": yaw, "pitch": pitch, "roll": roll, "neck": neck, "look": look}, shapes, ride_body(rider, s))


def ride_clip(rider, duration, keys, cyclic_=False, overlay=None):
    flat = flatten(keys, rider.seated())

    def frame(u):
        s = unpack(curve(flat, u, cyclic_))
        if overlay:
            overlay(u, s)
        return ride_frame(rider, s)

    return loop(duration, frame) if cyclic_ else one_shot(duration, frame)


def add(s, channel, *deltas):
    s[channel] = [a + b for a, b in zip(s[channel], deltas)] + list(s[channel][len(deltas):])


def seconds(u, duration):
    return round(u * duration, 4)


# --- Riding ---------------------------------------------------------------------------------------------------------

def ride_idle(rider, duration):
    """Seated at a halt: breathing, a look to each side, the hands still on the reins."""
    base = rider.seated()
    keys = [(0.0, base), (.25, {"C": (6, 0, 0, 0, 22), "S": (2, 1)}), (.5, {"C": (0, 1, 0, 2, 0), "S": (0, 0)}),
            (.75, {"C": (-5, 0, 0, -2, -18), "S": (1, 2)})]

    def breathe(u, s):
        add(s, "C", 0, .8 * math.sin(4 * math.pi * u))
        add(s, "S", .6 * math.sin(4 * math.pi * u), .6 * math.sin(4 * math.pi * u))

    return ride_clip(rider, duration, keys, cyclic_=True, overlay=breathe), {"horseClip": "Ride_Idle_Loop"}


def ride_walk(rider, duration):
    """The seat swings with the horse's back, a hip forward with each hind step; the shoulders and head stay quiet."""
    def swing(u, s):
        a = 2 * math.pi * u
        add(s, "T", 0, 3.0 * math.sin(2 * a), 3.0 * math.sin(2 * a + .6))
        add(s, "P", .006 * math.sin(2 * a), -.012 * math.cos(2 * a))
        add(s, "C", -2.0 * math.sin(2 * a + .6), 0, -2.5 * math.sin(2 * a), 0, 0)

    keys = [(0.0, rider.seated()), (.5, rider.seated())]
    return ride_clip(rider, duration, keys, cyclic_=True, overlay=swing), {"horseClip": "Walk_Loop"}


def ride_trot(rider, duration):
    """Posting: up out of the saddle (ahead and tipped forward, the knees taking the weight on the stirrups) through
    one diagonal beat, down to sit through the next."""
    sp = POST
    up = rider.seated(P=(0, -sp["ahead"], sp["rise"]), T=(SEATED["tip"] + sp["tip"], 0, 0), C=(0, 4, 0, -4, 0), KL=(2.0, -.8, 0), KR=(-2.0, -.8, 0))
    down = rider.seated()
    keys = [(0.0, down), (sp["up"][0], down), (sp["peak"], up), (sp["up"][1], down)]
    return ride_clip(rider, duration, keys, cyclic_=True), {"horseClip": "Trot_Loop", "riseSeconds": seconds(sp["up"][0], duration),
                                                            "sitSeconds": seconds(sp["up"][1], duration)}


def ride_canter(rider, duration):
    """The seat follows the rocking stride, scooping forward as the forehand comes down; the trunk counters the
    horse's pitch so the shoulders stay over the hips."""
    def rock(u, s):
        a = 2 * math.pi * (u - .12)
        add(s, "T", 6.0 * math.cos(a))
        add(s, "P", 0, -.025 * math.sin(a), .01 * math.cos(a))
        add(s, "C", 0, -2.5 * math.cos(a), 0, 2.0 * math.cos(a), 0)

    keys = [(0.0, rider.seated(T=(SEATED["tip"] + 4, 0, 0))), (.5, {})]
    return ride_clip(rider, duration, keys, cyclic_=True, overlay=rock), {"horseClip": "Canter_Loop"}


def ride_gallop(rider, duration):
    """Two-point: the seat up and back out of the saddle, the trunk folded forward into the stride, the eyes up and
    the hands forward along the reins; the knees and ankles take the stride's pump."""
    sp = TWO_POINT
    base = rider.seated(P=(0, sp["back"], sp["up"]), T=(SEATED["tip"] + sp["tip"], 0, 0), C=(0, sp["chest"], 0, sp["neck"], 0),
                        HL=rider.rein_hand("l", sp["hands"]), HR=rider.rein_hand("r", sp["hands"]), S=(4, 4), KL=(2.4, -.6, 0), KR=(-2.4, -.6, 0))

    def pump(u, s):
        a = 2 * math.pi * (u - .5)
        add(s, "P", 0, .01 * math.sin(a), sp["pump"] * math.cos(a))
        add(s, "T", 3.0 * math.sin(a))

    return ride_clip(rider, duration, [(0.0, base), (.5, {})], cyclic_=True, overlay=pump), {"horseClip": "Gallop_Loop", "handsAlongReinsMeters": sp["hands"]}


def ride_turn(rider, duration, sign):
    """Looking and leaning into the turn; the inside hand opens a little to lead the horse round."""
    side = "l" if sign > 0 else "r"
    into = rider.seated(C=(sign * 12, 0, sign * 4, 0, sign * 26), T=(SEATED["tip"], sign * 3, sign * 6),
                        **{"H" + side.upper(): rider.rein_hand(side, .02, .05)})
    keys = [(0.0, rider.seated()), (.2, into), (.8, into), (1.0, rider.seated())]
    return ride_clip(rider, duration, keys), {"horseClip": "Turn_L" if sign > 0 else "Turn_R"}


def cantle(rider):
    """A palm on the back of the saddle, fingers forward over the cantle (the right hand while mounting)."""
    return hand((.0, .2, .02), (0, -.6, -.8), (0, .2, -1), 1.0)


def neck(rider):
    """The left fist with the reins on the side of the neck in front of the withers (from the ground)."""
    return hand((.25, -.4, -.04), (-.2, -.6, -.8), (-1, 0, .2), 1.0)


def pommel(rider, side):
    s = 1 if side == "l" else -1
    return hand((s * .05, -.24, .08), (0, -.5, -.8), (s * -.6, 0, -.8), 1.0)


def mount(rider):
    """From the ground beside the near shoulder, facing the horse: the left hand takes the reins at the withers and
    the right the cantle, the left foot goes up into the stirrup; a spring up to stand in it over the saddle; the right
    hand moves to the pommel and the right leg sweeps up and back over the croup, then down the far side; the seat
    lowers into the saddle and the right foot finds its stirrup."""
    sp = MOUNT
    away, yaw = sp["away"], sp["yaw"]
    stand = rider.standing((away, .02), yaw)
    l_stir = (*rider.stirrup["l"], -10.0, yaw + 30)
    keys = [
        (0.0, stand),
        (.12, rider.standing((away - .04, .02), yaw, HL=neck(rider), HR=cantle(rider), WL=(1,), WR=(1,), G=(.9, .6),
                             EL=(1.0, .2, -.6), ER=(-.4, .6, -.6), C=(0, 8, 0, 0, 0))),
        (.26, rider.standing((away - .1, .04), yaw, P=(away - .1, .04, rider.ground + .84), T=(14, 0, yaw), L=l_stir, KL=(.3, -.6, .8),
                             HL=neck(rider), HR=cantle(rider), WL=(1,), WR=(1,), G=(.9, .6), EL=(1.0, .2, -.6), ER=(-.4, .6, -.6),
                             C=(0, 14, 0, 0, 0))),
        # Up: standing in the left stirrup beside the saddle, leaning over it; the right leg hangs.
        (.42, rider.seated(P=(.36, .02, .06), T=(24, 0, yaw + 30), L=l_stir, R=(.44, .14, -.72, 30.0, yaw + 30), KL=(.6, -.6, 0), KR=(.6, -.4, 0), HL=neck(rider),
                           HR=cantle(rider), C=(0, 12, 0, -6, 0), G=(.9, .6), ER=(-.4, .6, -.6))),
        # The right leg out behind the rump, over the croup, and down the far side as the seat comes round.
        (.54, {"P": (.26, .04, .12), "T": (30, 0, yaw + 50), "R": (.36, .62, -.12, 40.0, yaw + 60), "KR": (.2, .4, 1),
               "HR": pommel(rider, "r"), "C": (0, 16, 0, -8, 0)}),
        (.64, {"P": (.12, .02, .14), "T": (28, 0, -20), "R": (-.06, .66, .3, 40.0, -10.0), "KR": (0, .2, 1), "HL": rider.rein_hand("l")}),
        (.74, {"P": (.04, 0, .1), "T": (18, 0, -6), "R": (-.46, .3, -.1, 30.0, -12.0), "KR": (-1, -.2, .3)}),
        (.86, {"P": (0, 0, .02), "T": (6, 0, 0), "L": rider.seated()["L"], "KL": SEATED["knee"], "R": (-.42, -.04, -.62, 0.0, -12.0),
               "KR": (-1, -.6, .1), "HR": rider.rein_hand("r"), "G": (.9, .9), "ER": (-SEATED["elbow"][0], *SEATED["elbow"][1:]), "C": (0, 4, 0, 0, 0)}),
        (1.0, rider.seated())]
    return ride_clip(rider, sp["duration"], keys), {"horseClip": "Ride_Idle_Loop", "from": "ground", "to": "Ride_Idle_Loop", **stand_info(rider, away, yaw)}


def dismount(rider):
    """The way back down: the right foot out of its stirrup, a lean forward over the withers with the right hand on the
    pommel, the right leg swept back over the croup, standing in the left stirrup on the near side, the right foot down
    to the ground and the left out of the stirrup, facing the horse."""
    sp = DISMOUNT
    away, yaw = MOUNT["away"], MOUNT["yaw"]
    l_stir = (*rider.stirrup["l"], -10.0, yaw + 30)
    keys = [
        (0.0, rider.seated()),
        (.14, {"T": (14, 0, 0), "R": (-.42, .02, -.8, 20.0, -16.0), "KR": (-1.3, -.6, .1), "HR": pommel(rider, "r"), "G": (.9, .6),
               "C": (0, 10, 0, 0, 0)}),
        (.3, {"P": (.04, 0, .12), "T": (26, 0, -6), "R": (-.48, .4, -.1, 30.0, -12.0), "KR": (-1, .2, .4)}),
        (.42, {"P": (.12, .02, .15), "T": (30, 0, -20), "R": (-.06, .68, .3, 40.0, -10.0), "KR": (0, .2, 1)}),
        (.52, {"P": (.26, .04, .12), "T": (30, 0, yaw + 50), "L": l_stir, "KL": (.6, -.6, 0), "R": (.4, .62, -.14, 40.0, yaw + 60), "KR": (.2, .4, 1), "HL": neck(rider)}),
        (.64, {"P": (.36, .02, .05), "T": (22, 0, yaw + 30), "R": (.46, .14, -.74, 30.0, yaw + 30), "KR": (.6, -.4, 0), "HR": cantle(rider),
               "ER": (-.4, .6, -.6)}),
        (.8, rider.standing((away - .06, .04), yaw, P=(away - .06, .04, rider.ground + .8), T=(12, 0, yaw), L=l_stir, KL=(.3, -.6, .8),
                            HL=neck(rider), HR=cantle(rider), WL=(1,), WR=(1,), G=(.9, .6), EL=(1.0, .2, -.6), ER=(-.4, .6, -.6),
                            C=(0, 10, 0, 0, 0))),
        (.9, rider.standing((away - .02, .03), yaw, HL=neck(rider), WL=(.6,), WR=(.3,), G=(.6, .3), C=(0, 4, 0, 0, 0))),
        (1.0, rider.standing((away, .02), yaw))]
    # The right foot, stepping down at .8, must reach the ground: it keeps the standing pose's place from there on.
    return ride_clip(rider, sp["duration"], keys), {"horseClip": "Ride_Idle_Loop", "from": "Ride_Idle_Loop", "to": "ground", **stand_info(rider, away, yaw)}


def stand_info(rider, away, yaw):
    """Where the rider stands off the horse: its root (glTF, seat frame), the facing and the ground below the seat."""
    facing = Matrix.Rotation(math.radians(yaw), 3, UP) @ Vector((0, -1, 0))
    return {"standAt": root_point(Vector((away, .02, rider.ground))), "standFacing": root_point(facing),
            "groundBelowSeatMeters": round(-rider.ground, 4)}


def author(rig, clip, actions, arguments):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    seed = sample(rig, actions[STAND], 0.0)
    rider = Rider(rig, seed, arguments["tack"], -arguments["seatHeight"])
    gaits = arguments["gaits"]
    makers = {
        "Mount_Horse": lambda: mount(rider), "Dismount_Horse": lambda: dismount(rider),
        "Ride_Idle_Loop": lambda: ride_idle(rider, gaits["Ride_Idle_Loop"]["seconds"]),
        "Ride_Walk_Loop": lambda: ride_walk(rider, gaits["Walk_Loop"]["seconds"]),
        "Ride_Trot_Loop": lambda: ride_trot(rider, gaits["Trot_Loop"]["seconds"]),
        "Ride_Canter_Loop": lambda: ride_canter(rider, gaits["Canter_Loop"]["seconds"]),
        "Ride_Gallop_Loop": lambda: ride_gallop(rider, gaits["Gallop_Loop"]["seconds"]),
        "Ride_Turn_L": lambda: ride_turn(rider, gaits["Turn_L"]["seconds"], 1),
        "Ride_Turn_R": lambda: ride_turn(rider, gaits["Turn_R"]["seconds"], -1),
    }
    poses, observations = makers[clip]()
    observations = {"mount": "horse", "seat": "saddle.seat", **observations, "secondaryPose": record_chains(rig, poses)}
    return poses, {"source": STAND, "durationSeconds": round((len(poses) - 1) / FPS, 4), **observations}


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
        authored[clip] = author(Rig(rig_object, {}, rest_gltf), clip, actions, arguments)
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
    return {"recipe": "ride-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
