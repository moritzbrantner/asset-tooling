"""Original traversal clips authored on the Ranger rig in Blender (#416, mmorpg#490, mmorpg#500).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit hand and foot targets solved with two-bone IK
(no source motion is copied; Mixamo and the CC0 UAL2 ``ClimbUp_1m_RM`` were only watched as reference):

- ``Climb_*``: on a rock face in front of the body (-Y in Blender, +Z in glTF). The idle holds four holds and
  breathes with a small re-grip; the up/down loops go hand over hand at ``CLIMB["speed"]`` (diagonal limbs move
  together, feet a little after the hands); the side loops shuffle at ``SIDE_CLIMB["speed"]``, lead hand first.
  ``Climb_TopOut`` pulls onto the top and stands up; ``Climb_LetGo`` pushes off the face.
- ``Mantle_Low/Mid/High``: from the standing ``Idle_Loop`` pose facing a ledge of ``MANTLE[clip]["height"]`` to the
  standing pose on top: hands on the edge, pull (and hang, for the high ledge), press, knee over, stand.
- ``Ladder_*``: rungs every ``LADDER["rung"]`` metres; hands wrap the rungs and the balls of the feet stand on them.
- ``Rope_*``: a vertical rope in front of the chest, hand over hand, feet clamping the rope below the knees.

Every clip is in place. The travel the consumer applies (the climb speed, or a mantle's rise and forward step) is in
the observations, together with the hand and foot contacts (times and model-space positions, glTF axes) and a skirt and
cape pose for the #391 chain joints, which the consumer blends under its spring (mmorpg#498): the clips flex the hips
far enough that a hanging robe would pass through the thighs. Fingers are keyed by the clips themselves. No randomness.
"""
import json
import math
import struct

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 30
STAND = "Idle_Loop"
LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
ARMS = {"l": ("upperarm_l", "lowerarm_l", "hand_l"), "r": ("upperarm_r", "lowerarm_r", "hand_r")}
SIDE = {"l": 1.0, "r": -1.0}
LIMBS = ("hand_l", "hand_r", "foot_l", "foot_r")
UP, FWD, BACK = Vector((0, 0, 1)), Vector((0, -1, 0)), Vector((0, 1, 0))
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))

# Rock face: metres in front of the pelvis, the pelvis drop against standing, metres per second, stance fraction.
CLIMB = {"wall": .30, "drop": .06, "speed": .9, "stance": .6, "period": 1.0, "hand": (.26, .3), "foot": (.16, -.6), "toe": .17}
SIDE_CLIMB = {"speed": .75, "stance": .6, "period": 1.0}
LADDER = {"rung": .30, "wall": .36, "speed": .6, "stance": .6, "period": 1.0}
ROPE = {"wall": .20, "speed": .6, "stance": .6, "period": 1.0}
# Mantles: authored ledge height (metres), duration (seconds) and the forward step onto the top (metres).
MANTLE = {
    "Mantle_Low": {"height": .7, "duration": .6, "forward": .55, "face": .38},
    "Mantle_Mid": {"height": 1.3, "duration": .9, "forward": .6, "face": .36},
    "Mantle_High": {"height": 1.9, "duration": 1.3, "forward": .6, "face": .34},
}
TOP_OUT = {"duration": 1.0, "edge": .05, "forward": .55}
LET_GO = {"duration": .4}
CLIPS = ("Climb_Idle_Loop", "Climb_Up_Loop", "Climb_Down_Loop", "Climb_Left_Loop", "Climb_Right_Loop", "Climb_TopOut",
         "Climb_LetGo", "Mantle_Low", "Mantle_Mid", "Mantle_High", "Ladder_Idle_Loop", "Ladder_Up_Loop",
         "Ladder_Down_Loop", "Rope_Idle_Loop", "Rope_Up_Loop", "Rope_Down_Loop")
# Finger curl in degrees per joint (01, 02, 03): a crimp on a hold or an edge, a fist round a rung or a rope.
CURL = {"hold": (55, 70, 35), "wrap": (75, 95, 70), "open": (10, 15, 10)}
THUMB = {"hold": (10, 20, 20), "wrap": (35, 40, 45), "open": (5, 5, 5)}
SKIRT = ("skirt_f_01", "skirt_b_01", "skirt_l_01", "skirt_r_01")  # with CAPE, the chain joints secondaryPose keys
# The chain swing: the share of the thighs' forward lift a panel takes and its limit in degrees per panel.
SWING = {"share": .45, "front": 40.0, "side": 40.0, "back": 20.0}
CAPE = "cape_01"


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips"}:
        raise ValueError("traversal clips require exactly schemaVersion and clips")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"traversal clips must be distinct names from {CLIPS}")
    if set(inputs) != {"target"}:
        raise ValueError("traversal clips take exactly the declared input target")


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


def lerp(a, b, u):
    return a + (b - a) * u


def vec(x, y, z):
    return Vector((x, y, z)).normalized()


def to_gltf(v):
    """A Blender armature-space vector in glTF model axes (+Y up, facing +Z)."""
    return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]


class Rig:
    def __init__(self, rig):
        self.rig = rig
        self.bones = rig.pose.bones
        self.rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}
        # The palm faces down (-Z) in the rest T-pose; keep that direction in each hand bone's frame.
        self.palm = {s: self.rest[f"hand_{s}"].to_3x3().inverted() @ Vector((0, 0, -1)) for s in "lr"}

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


def sample(rig, action, frame):
    data = rig.rig.animation_data
    data.action = action
    if hasattr(data, "action_slot") and action.slots:
        data.action_slot = action.slots[0]
    bpy.context.scene.frame_set(int(math.floor(frame)), subframe=frame - math.floor(frame))
    bpy.context.view_layer.update()
    pose = rig.capture()
    data.action = None
    return pose


def blend(a, b, u):
    """Per-bone blend of two captured poses: slerped rotation, interpolated location."""
    out = {}
    for name in a:
        la, ra, _ = a[name].decompose()
        lb, rb, _ = b[name].decompose()
        if ra.dot(rb) < 0:
            rb.negate()
        out[name] = Matrix.Translation(la.lerp(lb, u)) @ ra.slerp(rb, u).to_matrix().to_4x4()
    return out


def rotate_world(rig, name, axis, degrees):
    """Rotate a bone about an armature-space axis through its head; its children follow."""
    pb = rig.bones[name]
    head = pb.matrix.translation.copy()
    pb.matrix = Matrix.Translation(head) @ Matrix.Rotation(math.radians(degrees), 4, axis) @ Matrix.Translation(-head) @ pb.matrix
    bpy.context.view_layer.update()


def aim(rig, name, direction):
    """Point a bone (its local +Y) along ``direction`` by the minimal turn from its current direction."""
    pb = rig.bones[name]
    current = (pb.matrix.to_3x3() @ Vector((0, 1, 0))).normalized()
    turn = current.rotation_difference(direction.normalized()).to_matrix()
    m = (turn @ pb.matrix.to_3x3()).to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


def place_pelvis(rig, position, lean=0.0, yaw=0.0):
    """Pelvis head at ``position``; the whole body leans ``lean`` degrees towards -Y (forward) and turns ``yaw``."""
    pelvis = rig.bones["pelvis"]
    m = pelvis.matrix.copy()
    m.translation = position
    pelvis.matrix = m
    bpy.context.view_layer.update()
    if lean:
        rotate_world(rig, "pelvis", Vector((1, 0, 0)), lean)
    if yaw:
        rotate_world(rig, "pelvis", UP, yaw)


def two_bone(rig, a, b, c, target, pole):
    """Aim ``a`` and ``b`` so the head of ``c`` lands on ``target`` (clamped to reach), the middle joint towards ``pole``."""
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


def solve_leg(rig, side, ankle, knee, toe=None):
    """Thigh and calf put the ankle on ``ankle`` with the knee towards ``knee``; the foot points along ``toe`` (level
    and forward when None)."""
    thigh, calf, foot, ball = LEGS[side]
    two_bone(rig, thigh, calf, foot, ankle, knee)
    pb = rig.bones[foot]
    m = rig.rest[foot].to_3x3().to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()
    if toe is not None:
        aim(rig, foot, toe)
    rig.bones[ball].matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


def solve_arm(rig, side, wrist, elbow, fingers, palm):
    """Upper arm and forearm put the wrist on ``wrist`` (elbow towards ``elbow``); the hand's fingers point along
    ``fingers`` with the palm facing ``palm``, and half its twist moves into the forearm."""
    upper, lower, hand = ARMS[side]
    two_bone(rig, upper, lower, hand, wrist, elbow)
    f = fingers.normalized()
    p = (palm - f * palm.dot(f)).normalized()
    local_y = Vector((0, 1, 0))
    local_p = (rig.palm[side] - local_y * rig.palm[side].dot(local_y)).normalized()
    frame_local = Matrix((local_y, local_p, local_y.cross(local_p))).transposed()
    frame_world = Matrix((f, p, f.cross(p))).transposed()
    rotation = frame_world @ frame_local.inverted()
    # Share the wrist twist about the forearm with the forearm.
    fore = rig.bones[lower]
    axis = (fore.matrix.to_3x3() @ Vector((0, 1, 0))).normalized()
    relative = (rotation @ fore.matrix.to_3x3().inverted()).to_quaternion()
    twist = Quaternion(axis, 0.0)
    projected = Vector((relative.x, relative.y, relative.z)).project(axis)
    if projected.length > 1e-9:
        twist = Quaternion((relative.w, *projected)).normalized()
    half = Quaternion().slerp(twist, .5)
    m = (half.to_matrix() @ fore.matrix.to_3x3()).to_4x4()
    m.translation = fore.head.copy()
    fore.matrix = m
    bpy.context.view_layer.update()
    m = rotation.to_4x4()
    m.translation = rig.bones[hand].head.copy()
    rig.bones[hand].matrix = m
    bpy.context.view_layer.update()


def curl(rig, side, grip, amount=1.0):
    """Close the fingers of hand ``side`` by ``grip`` (a CURL key), scaled by ``amount``."""
    hand = rig.bones[f"hand_{side}"].matrix.to_3x3()
    palm = (hand @ rig.palm[side]).normalized()
    for finger in ("index", "middle", "ring", "pinky", "thumb"):
        joints = [f"{finger}_0{k}_{side}" for k in (1, 2, 3)]
        degrees = (THUMB if finger == "thumb" else CURL)[grip]
        along = (rig.head(joints[1]) - rig.head(joints[0])).normalized()
        axis = along.cross(palm).normalized()
        for joint, angle in zip(joints, degrees):
            rotate_world(rig, joint, axis, -angle * amount)


class Pose:
    """One frame's targets: the pelvis, the lean, each limb's position and grip, and contacts."""

    def __init__(self, pelvis, lean=0.0):
        self.pelvis, self.lean = pelvis, lean
        self.hands, self.feet, self.planted, self.arms = {}, {}, set(), 1.0


def hold_hand(side, hold, wall_y):
    """A crimp on a rock hold at ``hold`` on a face at ``wall_y``: wrist below and off the face."""
    s = SIDE[side]
    return (Vector((hold.x, wall_y + .05, hold.z - .07)), vec(-s * .15, -.35, 1), vec(0, -1, -.1), "hold")


def edge_hand(side, edge, top):
    """Hand flat on the top of a ledge, just behind ``edge`` (the edge's y), fingers forward."""
    s = SIDE[side]
    return (Vector((edge.x, edge.y - .07, top + .035)), vec(-s * .2, -1, -.1), vec(0, 0, -1), "hold")


def rung_hand(side, x, y, z):
    """Fingers over a rung along X at height ``z`` and depth ``y``."""
    return (Vector((x, y + .05, z - .02)), vec(0, -.8, .6), vec(0, -.6, -.8), "wrap")


def rope_hand(side, x, y, z):
    """A fist round a vertical rope at depth ``y``; the hand reaches round it from its own side."""
    s = SIDE[side]
    return (Vector((x + s * .05, y + .045, z)), vec(-s, -.25, 0), vec(-s * .2, -1, 0), "wrap")


def pose_from(rig, stand, targets):
    """Solve a Pose on top of the standing pose."""
    rig.apply(stand)
    place_pelvis(rig, targets.pelvis, targets.lean)
    for side, (ankle, knee, toe) in targets.feet.items():
        solve_leg(rig, side, ankle, knee, toe)
    for side, (wrist, fingers, palm, grip, *rest) in targets.hands.items():
        amount = rest[0] if rest else 1.0
        s = SIDE[side]
        solve_arm(rig, side, wrist, vec(s * .8, .5, -.6), fingers, palm)
        curl(rig, side, grip, amount)


class Track:
    """A limb that slides with the face while planted and steps between plants: phase ``offset``, stance fraction,
    the step vector (the travel of one cycle, in armature space) and a lift off the face while swinging."""

    def __init__(self, centre, step, offset, stance, lift):
        self.centre, self.step, self.offset, self.stance, self.lift = centre, step, offset, stance, lift

    def at(self, p):
        q = (p - self.offset) % 1.0
        span = self.step * self.stance
        if q < self.stance:
            # Planted: the hold moves against the body's travel.
            return self.centre + span * (.5 - q / self.stance), True, q / self.stance
        u = (q - self.stance) / (1 - self.stance)
        return self.centre + span * (-.5 + smooth(u)) + BACK * self.lift * math.sin(math.pi * u), False, u


def climb_tracks(rig, base, travel, stance):
    """The four limb tracks on a rock face for a cycle travel ``travel`` (armature space)."""
    wall = base["hips"].y - CLIMB["wall"]
    shoulder = base["shoulder"]
    hx, hz = CLIMB["hand"]
    fx, fz = CLIMB["foot"]
    tracks = {}
    lead = travel.normalized()
    for side, hand_offset, foot_offset in (("r", 0.0, .15), ("l", .5, .65)):
        s = SIDE[side]
        sideways = abs(lead.x) > .5
        if sideways:
            # Shuffling: the hand on the travelling side leads, the feet follow the hands.
            first = (s * lead.x) > 0
            hand_offset, foot_offset = (0.0, .25) if first else (.5, .75)
        tracks[f"hand_{side}"] = Track(Vector((s * hx, wall, shoulder.z + hz)), travel, hand_offset, stance, .06)
        tracks[f"foot_{side}"] = Track(Vector((s * fx, wall + CLIMB["toe"], base["hips"].z + fz)), travel, foot_offset, stance, .08)
    return tracks


def climb_loop(rig, stand, base, clip):
    """Climb_Up/Down/Left/Right_Loop, Climb_Idle_Loop: the targets of each frame and the cycle's contacts."""
    wall = base["hips"].y - CLIMB["wall"]
    if clip in ("Climb_Left_Loop", "Climb_Right_Loop"):
        speed, period, stance = SIDE_CLIMB["speed"], SIDE_CLIMB["period"], SIDE_CLIMB["stance"]
        direction = Vector((1 if clip == "Climb_Left_Loop" else -1, 0, 0))
    else:
        speed, period, stance = CLIMB["speed"], CLIMB["period"], CLIMB["stance"]
        direction = UP
    tracks = climb_tracks(rig, base, direction * speed * period, stance)
    frames = int(round(period * FPS))
    out = []
    for k in range(frames + 1):
        p = (k % frames) / frames
        if clip == "Climb_Idle_Loop":
            t = Pose(base["hips"] + Vector((0, -CLIMB["wall"] * .1, -CLIMB["drop"] + .008 * math.sin(2 * math.pi * p))), 4.0)
            for name, track in tracks.items():
                side = name[-1]
                # Holds staggered a little; the right hand re-grips once a cycle.
                at = track.centre + UP * (.08 if side == "r" else -.04) * (1 if name.startswith("hand") else .5)
                if name.startswith("hand"):
                    lift = math.sin(math.pi * min(1.0, max(0.0, (p - .45) / .3))) if side == "r" else 0.0
                    wrist, fingers, palm, grip = hold_hand(side, at + BACK * .03 * lift, wall)
                    t.hands[side] = (wrist, fingers, palm, grip, 1 - .8 * lift)
                    if lift == 0:
                        t.planted.add(name)
                else:
                    t.feet[side] = (at, vec(SIDE[side] * .45, -.9, .1), vec(0, -1, -.35))
                    t.planted.add(name)
        else:
            if direction.z > 0:
                # Hips rise as the legs push (twice a cycle); the body sways towards the stepping hand.
                bob = .025 * math.cos(4 * math.pi * p)
                sway = .03 * math.sin(2 * math.pi * p)
            else:
                bob, sway = .01 * math.cos(4 * math.pi * p), .05 * direction.x * (.5 - abs(.5 - p))
            t = Pose(base["hips"] + Vector((sway, -CLIMB["wall"] * .1, -CLIMB["drop"] + bob)), 4.0)
            for name, track in tracks.items():
                side = name[-1]
                at, planted, u = track.at(p)
                if planted:
                    t.planted.add(name)
                if name.startswith("hand"):
                    wrist, fingers, palm, grip = hold_hand(side, at, wall)
                    t.hands[side] = (wrist, fingers, palm, grip, 1.0 if planted else 1 - .9 * math.sin(math.pi * u))
                else:
                    t.feet[side] = (at, vec(SIDE[side] * .45, -.9, .1), vec(0, -1, -.35))
        out.append(t)
    return out, {"periodSeconds": period, **({} if clip == "Climb_Idle_Loop" else {"climbSpeedMetersPerSecond": speed})}


def ladder_loop(rig, base, clip):
    """Ladder_*: rungs every LADDER["rung"] m; hands and feet move two rungs a step (Up and Down are one cycle)."""
    rung, period, stance = LADDER["rung"], LADDER["period"], LADDER["stance"]
    y = base["hips"].y - LADDER["wall"]
    climb = clip != "Ladder_Idle_Loop"
    step = UP * (LADDER["speed"] * period if climb else 0)
    hips_z = base["hips"].z - CLIMB["drop"]
    # Rungs lie on a grid relative to the hips at phase 0; the hands hold rungs near the shoulders, the feet near the knees.
    first = base["shoulder"].z + .3
    tracks = {}
    for side, hand_offset, foot_offset in (("r", 0.0, .1), ("l", .5, .6)):
        hand_z = round((first - hips_z) / rung) * rung + hips_z + (0 if side == "r" else -rung)
        foot_z = hand_z - 4 * rung
        tracks[f"hand_{side}"] = Track(Vector((SIDE[side] * .19, y, hand_z)), step, hand_offset, stance, .05)
        tracks[f"foot_{side}"] = Track(Vector((SIDE[side] * .13, y + .06, foot_z)), step, foot_offset, stance, .07)
    frames = int(round(period * FPS))
    out = []
    for k in range(frames + 1):
        p = (k % frames) / frames
        t = Pose(Vector((0, y + LADDER["wall"] * .9, hips_z + (.015 * math.cos(4 * math.pi * p) if climb else .006 * math.sin(2 * math.pi * p)))), 3.0)
        for name, track in tracks.items():
            side = name[-1]
            at, planted, u = track.at(p) if climb else (track.centre, True, 0.0)
            if planted:
                t.planted.add(name)
            if name.startswith("hand"):
                wrist, fingers, palm, grip = rung_hand(side, at.x, at.y, at.z)
                t.hands[side] = (wrist, fingers, palm, grip, 1.0 if planted else 1 - .9 * math.sin(math.pi * u))
            else:
                # The ball of the foot on the rung, heel below it.
                t.feet[side] = (at + Vector((0, .1, .04)), vec(SIDE[side] * .3, -1, .2), vec(0, -1, -.15))
        out.append(t)
    return out, {"periodSeconds": period, "rungSpacingMeters": rung, **({"climbSpeedMetersPerSecond": LADDER["speed"]} if climb else {})}


def rope_loop(rig, base, clip):
    """Rope_*: hand over hand on a vertical rope; the feet clamp it, release and clamp higher once a cycle."""
    period, stance = ROPE["period"], ROPE["stance"]
    y = base["hips"].y - ROPE["wall"]
    climb = clip != "Rope_Idle_Loop"
    step = UP * (ROPE["speed"] * period if climb else 0)
    hips_z = base["hips"].z - CLIMB["drop"]
    shoulder = base["shoulder"].z
    tracks = {
        "hand_r": Track(Vector((0, y, shoulder + .32)), step, 0.0, stance, .05),
        "hand_l": Track(Vector((0, y, shoulder + .08)), step, .5, stance, .05),
    }
    clamp = Track(Vector((0, y + .1, hips_z - .58)), step, .3, .55, 0.0)
    frames = int(round(period * FPS))
    out = []
    for k in range(frames + 1):
        p = (k % frames) / frames
        sway = .015 * math.sin(2 * math.pi * p)
        t = Pose(Vector((sway, y + ROPE["wall"], hips_z + (.03 * math.cos(2 * math.pi * (p - .3)) if climb else .006 * math.sin(2 * math.pi * p)))), -4.0)
        for name, track in tracks.items():
            side = name[-1]
            at, planted, u = track.at(p) if climb else (track.centre, True, 0.0)
            if planted:
                t.planted.add(name)
            wrist, fingers, palm, grip = rope_hand(side, at.x, at.y, at.z)
            t.hands[side] = (wrist, fingers, palm, grip, 1.0 if planted else 1 - .9 * math.sin(math.pi * u))
        at, planted, u = clamp.at(p) if climb else (clamp.centre, True, 0.0)
        for side in "lr":
            s = SIDE[side]
            # Right instep under the rope, left sole pressing on it from above.
            ankle = at + Vector((s * .045, 0, .05 if side == "l" else 0))
            t.feet[side] = (ankle, vec(s * .5, -1, .2), vec(-s * .5, -1, -.2))
            if planted:
                t.planted.add(f"foot_{side}")
        out.append(t)
    return out, {"periodSeconds": period, **({"climbSpeedMetersPerSecond": ROPE["speed"]} if climb else {})}


def keyed(keys, t):
    """Interpolate a list of (time, value) keys with smoothstep between them."""
    if t <= keys[0][0]:
        return keys[0][1]
    for (t0, a), (t1, b) in zip(keys, keys[1:]):
        if t <= t1:
            u = smooth((t - t0) / (t1 - t0))
            return a.lerp(b, u) if isinstance(a, Vector) else lerp(a, b, u)
    return keys[-1][1]


def ledge_clip(rig, stand, base, clip):
    """Mantle_* and Climb_TopOut: keyed world-space targets (the ledge is fixed) minus the root's travel, blended from
    and into the standing pose."""
    hips, shoulder = base["hips"], base["shoulder"]
    if clip == "Climb_TopOut":
        # The edge is just above the climbing pose's high hold.
        spec = {"height": shoulder.z - CLIMB["drop"] + CLIMB["hand"][1] + TOP_OUT["edge"],
                "duration": TOP_OUT["duration"], "forward": TOP_OUT["forward"], "face": CLIMB["wall"]}
    else:
        spec = MANTLE[clip]
    h, duration, face_y = spec["height"], spec["duration"], hips.y - spec["face"]
    forward = spec["forward"]
    # World pelvis keys: (t, height above the start root, lean) per clip; the feet: (t, side, ankle) keys.
    stand_h = hips.z
    if clip == "Mantle_Low":
        pelvis = [(0, stand_h), (.3, stand_h - .1), (.6, h + stand_h - .3), (1, h + stand_h)]
        lean = [(0, 0.0), (.3, 25.0), (.6, 35.0), (1, 0.0)]
        hands_on, hands_off = .18, .7
        right = [(0, Vector((-.09, hips.y, .09))), (.35, Vector((-.09, hips.y, .09))), (.55, Vector((-.1, face_y - .12, h + .12))), (1, Vector((-.09, face_y - forward + .0, h + .09)))]
        left = [(0, Vector((.09, hips.y, .09))), (.45, Vector((.09, hips.y, .1))), (.75, Vector((.12, face_y - .1, h + .2))), (1, Vector((.09, face_y - forward + .0, h + .09)))]
    elif clip == "Mantle_Mid":
        pelvis = [(0, stand_h), (.15, stand_h - .12), (.4, h - .3), (.65, h + stand_h - .35), (1, h + stand_h)]
        lean = [(0, 0.0), (.15, 12.0), (.4, 10.0), (.65, 40.0), (1, 0.0)]
        hands_on, hands_off = .12, .78
        right = [(0, Vector((-.09, hips.y, .09))), (.15, Vector((-.09, hips.y, .09))), (.4, Vector((-.12, face_y + .12, h - .7))), (.65, Vector((-.1, face_y - .12, h + .12))), (1, Vector((-.09, face_y - forward, h + .09)))]
        left = [(0, Vector((.09, hips.y, .09))), (.2, Vector((.09, hips.y, .1))), (.45, Vector((.14, face_y + .14, h - .9))), (.8, Vector((.12, face_y - .1, h + .2))), (1, Vector((.09, face_y - forward, h + .09)))]
    elif clip == "Mantle_High":
        pelvis = [(0, stand_h), (.12, stand_h - .15), (.25, h - .88), (.4, h - .95), (.62, h - .5), (.8, h + stand_h - .38), (1, h + stand_h)]
        lean = [(0, 0.0), (.12, 10.0), (.25, -4.0), (.4, -2.0), (.62, 8.0), (.8, 40.0), (1, 0.0)]
        hands_on, hands_off = .2, .86
        right = [(0, Vector((-.09, hips.y, .09))), (.12, Vector((-.09, hips.y, .09))), (.25, Vector((-.1, face_y + .2, h - 1.62))), (.4, Vector((-.12, face_y + .12, h - 1.5))), (.62, Vector((-.13, face_y + .12, h - 1.2))), (.8, Vector((-.1, face_y - .12, h + .12))), (1, Vector((-.09, face_y - forward, h + .09)))]
        left = [(0, Vector((.09, hips.y, .09))), (.12, Vector((.09, hips.y, .1))), (.25, Vector((.1, face_y + .25, h - 1.75))), (.4, Vector((.13, face_y + .13, h - 1.72))), (.62, Vector((.15, face_y + .14, h - 1.45))), (.88, Vector((.12, face_y - .1, h + .2))), (1, Vector((.09, face_y - forward, h + .09)))]
    else:
        # Topping out from the climbing pose: the hands are already on the edge.
        start_h = hips.z - CLIMB["drop"]
        pelvis = [(0, start_h), (.35, h - .45), (.62, h + stand_h - .38), (1, h + stand_h)]
        lean = [(0, 4.0), (.35, 12.0), (.62, 40.0), (1, 0.0)]
        hands_on, hands_off = 0.0, .78
        fx, fz = CLIMB["foot"]
        right = [(0, Vector((-fx, face_y + .1, start_h + fz))), (.3, Vector((-fx, face_y + .12, start_h + fz + .25))), (.62, Vector((-.1, face_y - .12, h + .12))), (1, Vector((-.09, face_y - forward, h + .09)))]
        left = [(0, Vector((fx, face_y + .1, start_h + fz))), (.45, Vector((fx, face_y + .12, h - .7))), (.85, Vector((.12, face_y - .1, h + .2))), (1, Vector((.09, face_y - forward, h + .09)))]
    pelvis_y = [(0, hips.y), (pelvis[-2][0] * .9, face_y + .2), (1, face_y - forward)]
    frames = int(round(duration * FPS))
    travel = hips.y - (face_y - forward)
    rise = pelvis[-2][0]
    out, samples = [], []
    for k in range(frames + 1):
        t = k / frames
        z = keyed(pelvis, t)
        # The root (the consumer's capsule) rises with the pelvis, then steps forward; the body is authored relative
        # to it, so the ledge sinks and comes closer in the clip.
        root = Vector((0, keyed([(0, 0.0), (rise * .8, 0.0), (1, -travel)], t), keyed([(0, 0.0), (rise, h * .85), (1, h)], t)))
        samples.append(to_gltf(root))
        world_pelvis = Vector((0, keyed(pelvis_y, t), z))
        pose = Pose(world_pelvis - root, keyed(lean, t))
        on = smooth((t - hands_on) / .1) if hands_on > 0 else 1.0
        pose.arms = min(on, 1 - smooth((t - hands_off) / .14))
        for side, foot_keys in (("r", right), ("l", left)):
            ankle = keyed(foot_keys, t) - root
            on_ground = (keyed(foot_keys, t - .03) - keyed(foot_keys, t + .03)).length < .02
            world_z = ankle.z + root.z
            # Toes against the face while walking it; level on the ground and on the top.
            toe = vec(0, -1, -.35) if .3 < world_z < h - .05 else None
            pose.feet[side] = (ankle, vec(SIDE[side] * .5, -1, .1), toe)
            if on_ground:
                pose.planted.add(f"foot_{side}")
            s = SIDE[side]
            hang = keyed([(0, 1.0), (.62, 1.0), (.8, 0.0), (1, 0.0)], t)
            edge = Vector((s * .22, face_y, h))
            wrist, fingers, palm, grip = edge_hand(side, edge, h)
            if hang > 0:
                # Hanging and pulling: the hands curl over the edge, palms to the face.
                over = (Vector((s * .22, face_y + .05, h - .07)), vec(-s * .1, -.6, 1), vec(0, -1, -.4))
                wrist = over[0].lerp(wrist, 1 - hang)
                fingers = over[1].lerp(fingers, 1 - hang).normalized()
                palm = over[2].lerp(palm, 1 - hang).normalized()
            pose.hands[side] = (wrist - root, fingers, palm, grip)
            if pose.arms > .99:
                pose.planted.add(f"hand_{side}")
        out.append((pose, t))
    observations = {"durationSeconds": duration, "travel": [0.0, round(h, 4), round(travel, 4)], "travelSamples": samples}
    if clip == "Climb_TopOut":
        observations.update({"from": "Climb_Idle_Loop", "to": "stand", "edgeHeightMeters": round(h, 4)})
    else:
        observations.update({"from": "stand", "to": "stand", "ledgeHeightMeters": round(h, 4)})
    return out, observations


ARM_JOINTS = ("upperarm", "lowerarm", "hand", "index", "middle", "ring", "pinky", "thumb")


def solve_ledge(rig, stand, frames, start_pose):
    """Poses for keyed ledge frames: the arms blend from the standing arms into the solved ones by the frame's arm
    weight, and the whole pose blends from ``start_pose`` (the stand, or the climbing pose) and into the stand."""
    arms = [name for name in rig.bones.keys() if name.startswith(ARM_JOINTS)]
    poses = []
    for pose, t in frames:
        pose_from(rig, stand, pose)
        pose_now = rig.capture()
        if pose.arms < 1:
            hands, pose.hands = pose.hands, {}
            pose_from(rig, stand, pose)
            pose.hands = hands
            free = rig.capture()
            pose_now.update(blend({n: free[n] for n in arms}, {n: pose_now[n] for n in arms}, pose.arms))
        start = smooth(1 - t / .12)
        end = smooth((t - .82) / .18)
        if start > 0:
            pose_now = blend(pose_now, start_pose, start)
        if end > 0:
            pose_now = blend(pose_now, stand, end)
        poses.append(pose_now)
    return poses


def let_go(rig, stand, base, climbing):
    """Climb_LetGo: from the climbing pose the hands open, the arms and legs push away from the face and the body
    leans back, ending in a tucked fall pose."""
    duration = LET_GO["duration"]
    frames = int(round(duration * FPS))
    fall = Pose(base["hips"] + Vector((0, .05, -.02)), -12.0)
    for side in "lr":
        s = SIDE[side]
        fall.feet[side] = (Vector((s * .14, base["hips"].y - .2, base["hips"].z - .7)), vec(s * .4, -1, 0), None)
        fall.hands[side] = (Vector((s * .45, base["hips"].y - .05, base["shoulder"].z + .25)), vec(s * .6, -.3, .8), vec(0, 1, 0), "open")
    pose_from(rig, stand, fall)
    pushed = rig.capture()
    poses = []
    for k in range(frames + 1):
        u = k / frames
        poses.append(blend(climbing, pushed, smooth(u / .7)))
    return poses, {"durationSeconds": duration, "from": "Climb_Idle_Loop", "to": "fall"}


def secondary(rig, rest_gltf):
    """The #391 chain pose of this frame: per chain's first joint, its local rotation (glTF xyzw) under the pelvis
    (``cape_01`` under ``spine_03``). The skirt panels ride the thighs (front both, sides their own), the back panel
    and the cape hang but never pass into the legs or the back."""
    down = Vector((0, 0, -1))
    thigh = {s: (rig.bones[LEGS[s][1]].head - rig.bones[LEGS[s][0]].head).normalized() for s in "lr"}
    # Only a panel's pelvis share swings; its hem already follows the thighs. The front and side panels turn forward
    # by part of the higher thigh's (their own thigh's) forward lift, the back panel back by part of a thigh's
    # backward reach, each within SWING degrees. A positive turn about +X moves -Z towards +Y (back).
    lift = {s: math.degrees(math.atan2(max(0.0, -thigh[s].y), max(1e-6, -thigh[s].z))) if thigh[s].z < 0 else 90.0 for s in "lr"}
    reach = max(0.0, *(math.degrees(math.asin(max(0.0, min(1.0, thigh[s].y)))) for s in "lr"))
    turn = lambda degrees: Matrix.Rotation(math.radians(degrees), 3, Vector((1, 0, 0))) @ down
    directions = {
        "skirt_f_01": turn(-min(SWING["front"], SWING["share"] * max(lift.values()))),
        "skirt_b_01": turn(min(SWING["back"], SWING["share"] * reach)),
        "skirt_l_01": turn(-min(SWING["side"], SWING["share"] * lift["l"])),
        "skirt_r_01": turn(-min(SWING["side"], SWING["share"] * lift["r"])),
    }
    spine = rig.bones["spine_03"].matrix.to_3x3()
    back = (spine @ rig.rest["spine_03"].to_3x3().inverted() @ BACK).normalized()
    cape = down.copy()
    if cape.dot(back) < .1:
        cape = (cape + back * (.1 - cape.dot(back))).normalized()
    directions[CAPE] = cape
    out = {}
    for joint, direction in directions.items():
        parent = "spine_03" if joint == CAPE else "pelvis"
        # The parent joint's world rotation in glTF: its rest frame turned by its pose's rotation from rest.
        delta = (rig.bones[parent].matrix.to_3x3() @ rig.rest[parent].to_3x3().inverted())
        parent_world = (C4.to_3x3().inverted() @ delta @ C4.to_3x3()) @ rest_gltf[parent].to_3x3()
        swing = C4.to_3x3().inverted() @ down.rotation_difference(direction).to_matrix() @ C4.to_3x3()
        local = (parent_world.inverted() @ swing).to_quaternion()
        out[joint] = [round(local.x, 5), round(local.y, 5), round(local.z, 5), round(local.w, 5)]
    return out


def contacts_of(planted_frames, positions, loop):
    """Contact intervals per limb: start and end seconds and the model-space position (glTF) at the start."""
    out = []
    count = len(planted_frames)
    for limb in LIMBS:
        flags = [limb in planted for planted in planted_frames]
        if all(flags):
            out.append({"limb": limb, "startSeconds": 0.0, "endSeconds": round((count - 1) / FPS, 4), "position": positions[0][limb]})
            continue
        k = 0
        while k < count:
            if flags[k] and (k == 0 or not flags[k - 1]):
                end = k
                while end + 1 < count and flags[end + 1]:
                    end += 1
                if not (loop and k == 0 and flags[-1]):
                    stop = end
                    if loop and end == count - 1:
                        # Wraps into the next cycle.
                        extra = 0
                        while extra < count and flags[extra]:
                            extra += 1
                        stop = end + extra
                    out.append({"limb": limb, "startSeconds": round(k / FPS, 4), "endSeconds": round(stop / FPS, 4), "position": positions[k][limb]})
                k = end + 1
            else:
                k += 1
    return sorted(out, key=lambda c: (c["startSeconds"], c["limb"]))


def author(rig, clip, stand_action, rest_gltf):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rest_pose = {name: Matrix.Identity(4) for name in rig.rest}
    rig.apply(rest_pose)
    stand = sample(rig, stand_action, stand_action.frame_range[0])
    rig.apply(stand)
    base = {"hips": rig.head("pelvis"), "shoulder": (rig.head("upperarm_l") + rig.head("upperarm_r")) / 2}
    planted, loop = [], clip.endswith("_Loop")
    if clip.startswith("Climb_") and loop:
        source = "Climb_Up_Loop" if clip == "Climb_Down_Loop" else clip
        targets, observations = climb_loop(rig, stand, base, source)
    elif clip.startswith("Ladder_"):
        targets, observations = ladder_loop(rig, base, "Ladder_Up_Loop" if clip == "Ladder_Down_Loop" else clip)
    elif clip.startswith("Rope_"):
        targets, observations = rope_loop(rig, base, "Rope_Up_Loop" if clip == "Rope_Down_Loop" else clip)
    else:
        targets = None
    poses = []
    if targets is not None:
        for target in targets:
            pose_from(rig, stand, target)
            poses.append(rig.capture())
            planted.append(target.planted)
        if clip.endswith("_Down_Loop"):
            # Climbing down is climbing up played backwards.
            poses.reverse()
            planted.reverse()
            observations["reverseOf"] = clip.replace("_Down_", "_Up_")
    elif clip == "Climb_LetGo":
        climbing, _ = climb_loop(rig, stand, base, "Climb_Idle_Loop")
        pose_from(rig, stand, climbing[0])
        poses, observations = let_go(rig, stand, base, rig.capture())
        planted = [set(LIMBS) if k == 0 else set() for k in range(len(poses))]
    else:
        frames, observations = ledge_clip(rig, stand, base, clip)
        start = stand
        if clip == "Climb_TopOut":
            climbing, _ = climb_loop(rig, stand, base, "Climb_Idle_Loop")
            pose_from(rig, stand, climbing[0])
            start = rig.capture()
        poses = solve_ledge(rig, stand, frames, start)
        planted = [pose.planted for pose, _ in frames]
    # Contacts and the chain pose from the final poses.
    positions, chains = [], {}
    for pose in poses:
        rig.apply(pose)
        positions.append({limb: to_gltf(rig.head(limb)) for limb in LIMBS})
        for joint, rotation in secondary(rig, rest_gltf).items():
            chains.setdefault(joint, []).append(rotation)
    observations["contacts"] = contacts_of(planted, positions, loop)
    observations["secondaryPose"] = {"sampleRate": FPS, "joints": chains}
    return poses, observations


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
    stand = bpy.data.actions.get(STAND)
    if stand is None:
        raise ValueError(f"the target GLB has no {STAND} clip")
    rest_gltf = gltf_rest_worlds(inputs["target"])
    fresh = imported_state(rigs[0])
    authored = {}
    for clip in arguments["clips"]:
        restore_state(rigs[0], fresh)
        authored[clip] = author(Rig(rigs[0]), clip, stand, rest_gltf)
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
    return {"recipe": "traversal-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
