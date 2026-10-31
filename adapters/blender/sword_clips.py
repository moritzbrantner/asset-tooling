"""Original sword-and-shield clips authored on the Ranger rig in Blender (#417, the mmorpg Warden and Redbrand).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit sword and shield grip frames solved with two-bone
arm IK on top of a seed pose (no source motion is copied; Mixamo was only watched as reference):

- The grips are the figure's ``hand_r.weapon`` and ``hand_l.shield`` sockets (``arguments["sockets"]``). A key names the
  sword grip's position, the blade's direction (the item's +Y) and, when the motion does not give it, the leading edge
  (the item's +X); the shield's position, its face (the item's +Z) and its top (the item's +Y). Between keys the
  positions and directions follow a Catmull-Rom curve.
- ``Sword_Slash_{High,Mid,Low}_{L,C,R}``, ``Sword_Heroic`` and ``Shield_Guard_{High,Mid,Low}_Loop`` are upper-body
  clips: they turn the spine and solve the arms on the first ``Idle_Shield_Loop`` pose (the guards on the whole loop),
  and the observations list the keyed joints (``spine_01`` and its descendants), so the build keeps only those and
  the consumer plays them over walking or running legs. ``L`` and ``R`` are diagonal cuts that end on the figure's
  left (a forehand) or right (a backhand); ``C`` is an overhead blow (high), a thrust (mid) or a low sweep (low).
- ``Sword_Cleave``, ``Charge_Run_Loop``, ``Charge_Impact``, ``Stun_Loop``, ``Respawn_Rise``, ``Sword_Whirl`` and
  ``Sword_Overhead_Smash`` are full-body clips. Feet stay planted by leg IK unless the clip steps. The charge sprints
  on the ``Sprint_Loop`` legs (its cycle resampled to the clip length) with the shield forward; the whirl pivots once
  round to the figure's right; the smash brings the free (left) hand onto the hilt.

Every clip starts and ends in the clip's seed pose (the guard ready pose for the strikes), so the consumer crossfades
from and back to its idle. No randomness.
"""
import json
import math
import struct

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 30
UPPER_ROOT = "spine_01"
GUARD = "Idle_Shield_Loop"
STAND = "Idle_Loop"
SPRINT = "Sprint_Loop"
LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
ARMS = {"l": ("upperarm_l", "lowerarm_l", "hand_l"), "r": ("upperarm_r", "lowerarm_r", "hand_r")}
SPINE = (("spine_01", .3), ("spine_02", .35), ("spine_03", .35))
X, Y, UP = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up. Positions are metres in armature space
# (the pelvis stands at about z 0.91, the shoulders at 1.42). A positive yaw turns the chest to the figure's left; a
# positive pitch bends it forward; a positive roll tilts it to its left.
# The ready pose the strikes start and end in: the sword grip at the right hip, blade forward and up.
READY = {"g": (-.24, -.2, 1.06), "b": (.12, -.7, .7), "e": (.25, -.6, -.6)}
# The aim cells: L and R end on the figure's left (+X) or right; a cut's keys are the wind-up, contact and follow-through
# grips (g), blades (b) and chest turns (yaw, pitch, roll). Timing: wind-up, contact, follow-through as clip fractions.
SLASH = {"duration": .6, "keys": (.3, .5, .68)}
SLASHES = {
    "High_L": [{"g": (-.36, .02, 1.72), "b": (-.2, .55, .8), "yaw": -15, "pitch": -6},
               {"g": (-.08, -.42, 1.5), "b": (.65, -.65, .3), "yaw": 30, "pitch": 4},
               {"g": (.24, -.3, 1.0), "b": (.55, .25, -.75), "yaw": 50, "pitch": 12}],
    "High_C": [{"g": (-.14, .06, 1.86), "b": (0, .75, .55), "yaw": -5, "pitch": -12},
               {"g": (-.08, -.44, 1.5), "b": (.02, -.92, .38), "yaw": 25, "pitch": 8},
               {"g": (-.06, -.36, .98), "b": (.02, -.5, -.85), "yaw": 30, "pitch": 22}],
    "High_R": [{"g": (.2, -.12, 1.7), "b": (.35, .45, .8), "yaw": 45, "pitch": -4, "shield": (.14, .04, -.08)},
               {"g": (-.12, -.44, 1.48), "b": (-.65, -.65, .3), "yaw": 10, "pitch": 4},
               {"g": (-.4, -.18, 1.0), "b": (-.6, .25, -.7), "yaw": -15, "pitch": 12}],
    "Mid_L": [{"g": (-.42, .04, 1.42), "b": (-.25, .7, .55), "yaw": -20},
              {"g": (-.06, -.5, 1.24), "b": (.72, -.62, .12), "yaw": 30, "pitch": 6},
              {"g": (.3, -.16, 1.02), "b": (.6, .5, -.4), "yaw": 50, "pitch": 10}],
    "Mid_C": [{"g": (-.24, .14, 1.22), "b": (.04, -1, .08), "e": (1, 0, 0), "yaw": -15},
              {"g": (-.08, -.58, 1.26), "b": (.06, -1, .02), "e": (1, 0, 0), "yaw": 35, "pitch": 8},
              {"g": (-.08, -.56, 1.24), "b": (.06, -1, .04), "e": (1, 0, 0), "yaw": 32, "pitch": 6}],
    "Mid_R": [{"g": (.22, -.12, 1.4), "b": (.4, .6, .6), "yaw": 45, "shield": (.16, .04, -.1)},
              {"g": (-.12, -.5, 1.22), "b": (-.72, -.62, .1), "yaw": 10, "pitch": 6},
              {"g": (-.44, -.12, 1.04), "b": (-.65, .5, -.35), "yaw": -15, "pitch": 10}],
    "Low_L": [{"g": (-.4, -.02, 1.38), "b": (-.2, .45, .85), "yaw": -15},
              {"g": (-.06, -.5, .98), "b": (.55, -.58, -.55), "yaw": 30, "pitch": 18},
              {"g": (.26, -.24, .84), "b": (.4, .2, -.88), "yaw": 45, "pitch": 22}],
    "Low_C": [{"g": (-.46, -.06, 1.08), "b": (-.5, .55, -.62), "yaw": -20, "pitch": 10},
              {"g": (-.06, -.52, .84), "b": (.4, -.8, -.45), "yaw": 25, "pitch": 24},
              {"g": (.3, -.26, .86), "b": (.75, .1, -.62), "yaw": 50, "pitch": 22}],
    "Low_R": [{"g": (.2, -.14, 1.36), "b": (.3, .4, .85), "yaw": 40, "shield": (.16, .04, -.1)},
              {"g": (-.12, -.5, .98), "b": (-.55, -.58, -.55), "yaw": 5, "pitch": 18},
              {"g": (-.42, -.2, .86), "b": (-.45, .2, -.86), "yaw": -15, "pitch": 22}],
}
AIM = {"High": "high", "Mid": "mid", "Low": "low", "L": "left", "C": "centre", "R": "right"}
# The heroic blow: a slow wind-up high over the right shoulder with the chest leaning back, a hard diagonal chop.
HEROIC = {"duration": .8, "keys": [
    (.45, {"g": (-.26, .12, 1.9), "b": (.1, .7, -.1), "yaw": -15, "pitch": -14}),
    (.53, {"g": (-.22, .02, 1.94), "b": (.1, .2, .95), "yaw": -10, "pitch": -12}),
    (.66, {"g": (-.06, -.48, 1.36), "b": (.25, -.9, .2), "yaw": 30, "pitch": 14}),
    (.78, {"g": (.04, -.34, .92), "b": (.3, -.45, -.85), "yaw": 35, "pitch": 26}),
]}
# Guard lanes: the shield grip (g), face (f) and top (t) over the whole guard loop; the chest pitch for the lane.
GUARDS = {
    "High": {"g": (.06, -.38, 1.5), "f": (-.1, -.92, .3), "t": (.03, .3, 1), "pitch": -4},
    "Mid": {"g": (.08, -.4, 1.24), "f": (-.15, -1, .05), "t": (.05, 0, 1), "pitch": 2},
    "Low": {"g": (.12, -.42, .96), "f": (-.1, -.95, -.3), "t": (0, -.25, 1), "pitch": 16},
}
GUARD_SECONDS = 2.0
# Cleave: the sword keys in armature space, the turn split between the pelvis (a third, feet planted) and the chest.
CLEAVE = {"duration": .9, "drop": .07, "keys": [
    (.36, {"g": (-.55, .16, 1.28), "b": (-.3, .95, .05), "yaw": -50}),
    (.56, {"g": (-.14, -.56, 1.16), "b": (.8, -.6, -.02), "yaw": 10}),
    (.74, {"g": (.48, -.1, 1.14), "b": (.55, .8, -.08), "yaw": 70}),
]}
# Charge: the sprint legs, the chest leaning forward, the shield ahead of the chest and the sword held back.
CHARGE = {"duration": .6, "pitch": 16, "shield": {"g": (.05, -.42, 1.24), "f": (-.1, -1, .1), "t": (-.15, .1, 1)},
          "sword": {"g": (-.3, .16, 1.0), "b": (-.05, .55, .85), "e": (0, -1, .3)}}
IMPACT = {"duration": .5, "hit": .2, "settle": .55}
STUN = {"duration": 1.5, "drop": .05, "sway": (.03, .02), "roll": 7.0, "pitch": 12.0, "head": 16.0}
RISE = {"duration": 1.5, "kneel": .44, "bow": 26.0, "start": .22, "end": .88}
WHIRL = {"duration": 1.2, "wind": (0, .34), "spin": (.38, .78), "back": (.8, 1.0), "windup": 42.0, "crouch": .08, "lift": .06,
         "steps": {"r": ((.4, .55), (.6, .74)), "l": ((.48, .64), (.68, .8))}}
SMASH = {"duration": 1.4, "join": .14, "raise": (.04, .5), "hold": .6, "hit": (.6, .7), "recover": (.82, 1.0), "drop": .18}
DIRECTED = tuple(f"Sword_Slash_{h}_{s}" for h in ("High", "Mid", "Low") for s in ("L", "C", "R"))
UPPER = (*DIRECTED, "Sword_Heroic", "Shield_Guard_High_Loop", "Shield_Guard_Mid_Loop", "Shield_Guard_Low_Loop")
CLIPS = (*DIRECTED, "Sword_Heroic", "Sword_Cleave", "Charge_Run_Loop", "Charge_Impact", "Shield_Guard_High_Loop",
         "Shield_Guard_Mid_Loop", "Shield_Guard_Low_Loop", "Stun_Loop", "Respawn_Rise", "Sword_Whirl", "Sword_Overhead_Smash")
SOCKETS = ("weapon", "shield")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets"}:
        raise ValueError("sword clips require exactly schemaVersion, clips and sockets")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"sword clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"sword clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    if set(inputs) != {"target"}:
        raise ValueError("sword clips take exactly the declared input target")


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


class Rig:
    def __init__(self, rig, sockets, rest_gltf):
        self.rig = rig
        self.bones = rig.pose.bones
        self.rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}
        # The socket frame in each hand bone's frame: the grip frame in armature space is the bone matrix times this.
        self.socket = {}
        for name, s in sockets.items():
            joint, r = s["joint"], s["rotation"]
            local = Matrix.LocRotScale(Vector(s["translation"]), Quaternion((r[3], r[0], r[1], r[2])), Vector((1, 1, 1)))
            self.socket[name] = (joint, self.rest[joint].inverted() @ C4 @ rest_gltf[joint] @ local)

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


def duration_of(action):
    return (action.frame_range[1] - action.frame_range[0]) / (bpy.context.scene.render.fps / bpy.context.scene.render.fps_base)


def blend(a, b, u):
    out = {}
    for name in a:
        la, ra, _ = a[name].decompose()
        lb, rb, _ = b[name].decompose()
        if ra.dot(rb) < 0:
            rb.negate()
        out[name] = Matrix.Translation(la.lerp(lb, u)) @ ra.slerp(rb, u).to_matrix().to_4x4()
    return out


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


def item_frame(position, y_axis, x_hint):
    """A grip frame at ``position`` whose +Y is ``y_axis`` and +X as close to ``x_hint`` as it can be."""
    yy = y_axis.normalized()
    xx = x_hint - yy * x_hint.dot(yy)
    if xx.length < 1e-4:
        xx = (Vector((0, 0, 1)) if abs(yy.z) < .9 else Vector((1, 0, 0))).cross(yy)
    xx.normalize()
    m = Matrix((xx, yy, xx.cross(yy))).transposed().to_4x4()
    m.translation = position
    return m


def place_grip(rig, socket, frame, pole):
    """Solve the arm holding ``socket`` so its grip frame lands on ``frame``; half the hand's twist goes to the forearm."""
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


def shield_frame(g, face, top):
    """The shield grip frame: its face (+Z) towards ``face`` and its top (+Y) towards ``top``."""
    zz = face.normalized()
    yy = (top - zz * top.dot(zz)).normalized()
    m = Matrix((yy.cross(zz), yy, zz)).transposed().to_4x4()
    m.translation = g
    return m


def turn_chest(rig, yaw=0.0, pitch=0.0, roll=0.0, gaze=.5):
    """Spread a chest turn over spine_01-03; the neck and head take back ``gaze`` of the yaw and half the pitch."""
    for joint, share in SPINE:
        if yaw:
            rotate_world(rig, joint, UP, yaw * share)
        if pitch:
            rotate_world(rig, joint, X, pitch * share)
        if roll:
            rotate_world(rig, joint, Y, -roll * share)
    if yaw:
        rotate_world(rig, "neck_01", UP, -yaw * gaze)
    if pitch:
        rotate_world(rig, "neck_01", X, -pitch * .5)


def plant_feet(rig, feet):
    """Put each ankle back on its planted position and orientation, the knee towards its planted direction."""
    for side, (ankle, matrix, knee) in feet.items():
        thigh, calf, foot, ball = LEGS[side]
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


def move_pelvis(rig, offset=Vector(), yaw=0.0, pivot=None):
    pelvis = rig.bones["pelvis"]
    m = pelvis.matrix.copy()
    m.translation += offset
    pelvis.matrix = m
    bpy.context.view_layer.update()
    if yaw:
        rotate_world(rig, "pelvis", UP, yaw, pivot)


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


def track(keys, field, default, t):
    times = [k for k, _ in keys]
    values = [key.get(field, default) for _, key in keys]
    if isinstance(default, tuple):
        return catmull([v(x) for x in values], times, t)
    return catmull([Vector((x, 0, 0)) for x in values], times, t).x


class Strike:
    """A sword path from and back to the ready pose: keyed grip positions, blades and chest turns. Key ``contact`` is
    where the blade meets the aim and the next key ends the cut. Before contact the leading edge faces a point just
    past the contact along the cut, through the cut it faces along the cut, then it returns to READY's. When every key
    names its edge ``e`` (the thrust), that edge is kept."""

    def __init__(self, keys, contact):
        self.keys = [(0.0, dict(READY)), *keys, (1.0, dict(READY))]
        self.contact = contact + 1
        self.explicit = all("e" in key for _, key in keys)

    def at(self, u):
        g = track(self.keys, "g", READY["g"], u)
        b = track(self.keys, "b", READY["b"], u).normalized()
        if self.explicit:
            edge = track(self.keys, "e", READY["e"], u)
        else:
            (uc, kc), (uf, kf) = self.keys[self.contact], self.keys[self.contact + 1]
            cut = (v(kf["g"]) - v(kc["g"])).normalized()
            edge = v(kc["g"]) + cut * .25 - g if u <= uc else cut.lerp(v(READY["e"]).normalized(), window(u, uf, 1.0))
        chest = {name: track(self.keys, name, 0.0, u) for name in ("yaw", "pitch", "roll")}
        return item_frame(g, b, edge), chest, track(self.keys, "shield", (0.0, 0.0, 0.0), u)


SHIELD_OPEN = (.22, .08, -.06)
SWORD_POLE = Vector((-.8, .35, -.5))
SHIELD_POLE = Vector((.8, .3, -.6))


def guard_shield(rig):
    """The seed's shield grip frame as (position, face, top)."""
    m = rig.grip("shield")
    return m.translation.copy(), (m.to_3x3() @ Vector((0, 0, 1))), (m.to_3x3() @ Vector((0, 1, 0)))


def upper_strike(rig, seed, strike, duration):
    rig.apply(seed)
    # The shield turns with the chest: its grip frame is kept relative to spine_03.
    shield = rig.bones["spine_03"].matrix.inverted() @ rig.grip("shield")
    frames = int(round(duration * FPS))
    poses = []
    for k in range(frames + 1):
        u = k / frames
        frame, chest, shift = strike.at(u)
        rig.apply(seed)
        turn_chest(rig, chest["yaw"], chest["pitch"], chest["roll"])
        # The shield opens out to the left while the sword swings past it.
        shift += v(SHIELD_OPEN) * math.sin(math.pi * window(u, .12, .9))
        place_grip(rig, "shield", Matrix.Translation(shift) @ rig.bones["spine_03"].matrix @ shield, SHIELD_POLE)
        place_grip(rig, "weapon", frame, SWORD_POLE)
        poses.append(rig.capture())
    return poses


def upper_joints(rig):
    return [UPPER_ROOT, *(bone.name for bone in rig.rig.data.bones[UPPER_ROOT].children_recursive)]


def slash(rig, seed, clip):
    cell = clip.removeprefix("Sword_Slash_")
    keys = list(zip(SLASH["keys"], SLASHES[cell]))
    poses = upper_strike(rig, seed, Strike(keys, 1), SLASH["duration"])
    height, side = cell.split("_")
    return poses, {"aim": {"height": AIM[height], "side": AIM[side]}, "contactFraction": SLASH["keys"][1]}


def heroic(rig, seed):
    return upper_strike(rig, seed, Strike(HEROIC["keys"], 2), HEROIC["duration"]), {"contactFraction": HEROIC["keys"][2][0]}


def guard_loop(rig, guard_action, lane):
    """The guard loop over ``GUARD_SECONDS``: the seed loop resampled, the shield in the lane and the chest pitched."""
    spec = GUARDS[lane]
    source = duration_of(guard_action)
    frames = int(round(GUARD_SECONDS * FPS))
    rig.apply(sample(rig, guard_action, 0.0))
    chest0 = rig.head("spine_03")
    poses = []
    for k in range(frames + 1):
        t = (k % frames) / frames
        rig.apply(sample(rig, guard_action, t * source))
        turn_chest(rig, 0.0, spec["pitch"])
        breathe = rig.head("spine_03") - chest0
        place_grip(rig, "shield", shield_frame(v(spec["g"]) + breathe, v(spec["f"]), v(spec["t"])), SHIELD_POLE)
        poses.append(rig.capture())
    return poses, {"lane": lane.lower(), "seedSeconds": round(source, 4)}


def cleave(rig, seed):
    rig.apply(seed)
    feet = feet_of(rig)
    shield = guard_shield(rig)
    pivot = rig.head("pelvis")
    strike = Strike(CLEAVE["keys"], 1)
    frames = int(round(CLEAVE["duration"] * FPS))
    poses = []
    for k in range(frames + 1):
        u = k / frames
        frame, chest, _ = strike.at(u)
        yaw = chest["yaw"]
        # A third of the turn in the pelvis (the feet stay planted), the rest in the chest; the body frame turns with it.
        body = Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(yaw), 4, UP) @ Matrix.Translation(-pivot)
        drop = CLEAVE["drop"] * math.sin(math.pi * window(u, .15, .9))
        rig.apply(seed)
        move_pelvis(rig, Vector((0, 0, -drop)), yaw / 3, pivot)
        plant_feet(rig, feet)
        turn_chest(rig, yaw * 2 / 3, 8 * math.sin(math.pi * u), 0.0, gaze=.3)
        sh = body @ shield_frame(shield[0] + Vector((-.04, .1, -.08)) * math.sin(math.pi * u), shield[1], shield[2])
        place_grip(rig, "shield", sh, SHIELD_POLE)
        place_grip(rig, "weapon", frame, SWORD_POLE)
        poses.append(rig.capture())
    return poses, {"degrees": CLEAVE["keys"][-1][1]["yaw"] - CLEAVE["keys"][0][1]["yaw"], "contactFraction": CLEAVE["keys"][1][0]}


def charge_pose(rig, sprint, t, chest0):
    rig.apply(sample(rig, sprint, t))
    turn_chest(rig, 6.0, CHARGE["pitch"], 0.0, gaze=.4)
    bob = rig.head("spine_03") - chest0
    s = CHARGE["shield"]
    place_grip(rig, "shield", shield_frame(v(s["g"]) + bob, v(s["f"]), v(s["t"])), SHIELD_POLE)
    w = CHARGE["sword"]
    place_grip(rig, "weapon", item_frame(v(w["g"]) + bob, v(w["b"]), v(w["e"])), SWORD_POLE)


def charge_loop(rig, sprint, seed):
    rig.apply(seed)
    chest0 = rig.head("spine_03")
    source = duration_of(sprint)
    frames = int(round(CHARGE["duration"] * FPS))
    poses = []
    for k in range(frames + 1):
        charge_pose(rig, sprint, (k % frames) / frames * source, chest0)
        poses.append(rig.capture())
    return poses, {"seed": SPRINT, "seedSeconds": round(source, 4)}


def charge_impact(rig, sprint, seed):
    """From the charge's first pose: the shield and left shoulder drive forward, the body brakes, back to the guard."""
    rig.apply(seed)
    chest0 = rig.head("spine_03")
    ready_feet = feet_of(rig)
    guard = guard_shield(rig)
    charge_pose(rig, sprint, 0.0, chest0)
    start = rig.capture()
    frames = int(round(IMPACT["duration"] * FPS))
    hit = IMPACT["hit"]
    s = CHARGE["shield"]
    poses = []
    for k in range(frames + 1):
        u = k / frames
        # Legs: from the stride into the braced guard stance by the hit; the pelvis dips with the brake.
        legs = smooth(u / hit)
        rig.apply(blend(start, seed, legs))
        move_pelvis(rig, Vector((0, -.06 * (1 - legs), -.07 * math.sin(math.pi * window(u, 0, IMPACT["settle"])))))
        if legs > .5:
            plant_feet(rig, ready_feet)
        drive = math.sin(math.pi * window(u, 0, hit * 2)) if u < hit else 1 - window(u, hit, IMPACT["settle"])
        back = window(u, IMPACT["settle"] * .8, 1.0)
        turn_chest(rig, (6 - 26 * drive) * (1 - back), (CHARGE["pitch"] + 8 * drive) * (1 - back), 0.0, gaze=.5)
        g =v(s["g"]).lerp(guard[0], back) + Vector((0, -.2, .04)) * drive
        f = v(s["f"]).lerp(guard[1], back)
        top = v(s["t"]).lerp(guard[2], back)
        place_grip(rig, "shield", shield_frame(g, f, top), SHIELD_POLE)
        w = CHARGE["sword"]
        frame = item_frame(v(w["g"]).lerp(v(READY["g"]), back), v(w["b"]).lerp(v(READY["b"]), back), v(w["e"]).lerp(v(READY["e"]), back))
        place_grip(rig, "weapon", frame, SWORD_POLE)
        poses.append(rig.capture())
    return poses, {"contactFraction": hit}


def stun_loop(rig, stand):
    rig.apply(stand)
    feet = feet_of(rig)
    frames = int(round(STUN["duration"] * FPS))
    sx, sy = STUN["sway"]
    poses = []
    for k in range(frames + 1):
        phase = 2 * math.pi * (k % frames) / frames
        rig.apply(stand)
        move_pelvis(rig, Vector((sx * math.sin(phase), sy * math.sin(2 * phase), -STUN["drop"] - .015 * math.cos(2 * phase))))
        plant_feet(rig, feet)
        turn_chest(rig, 4 * math.sin(phase - .6), STUN["pitch"] + 3 * math.cos(2 * phase), STUN["roll"] * math.sin(phase - .4), gaze=0)
        # The head lolls behind the chest; the arms hang heavy and swing a little.
        rotate_world(rig, "neck_01", Y, -STUN["head"] * math.sin(phase - 1.1))
        rotate_world(rig, "neck_01", X, 10 + 5 * math.cos(2 * phase - .8))
        for side, s in (("l", 1), ("r", -1)):
            rotate_world(rig, f"upperarm_{side}", X, 6 * math.sin(phase - 1.4 + s * .3))
            rotate_world(rig, f"upperarm_{side}", Y, s * 4 * math.sin(phase - 1.0))
        poses.append(rig.capture())
    return poses, {}


def respawn_rise(rig, stand):
    """From kneeling on the right knee, head bowed, to the standing pose."""
    rig.apply(stand)
    feet = feet_of(rig)
    frames = int(round(RISE["duration"] * FPS))
    left_ankle, left_matrix, _ = feet["l"]
    right_ankle, right_matrix, _ = feet["r"]
    poses = []
    for k in range(frames + 1):
        u = k / frames
        up = window(u, RISE["start"], RISE["end"])
        down = 1 - up
        breath = .01 * math.sin(2 * math.pi * min(u / RISE["start"], 1.0)) * down
        rig.apply(stand)
        move_pelvis(rig, Vector((0, .1 * down, -RISE["kneel"] * down + breath)))
        # The left foot steps forward to kneel on; the right knee rests on the ground, its toes tucked.
        la = left_ankle + Vector((0, -.26, 0)) * window(down, .0, .6)
        ra = right_ankle + Vector((0, .3, .06)) * window(down, .2, 1.0)
        plant_feet(rig, {"l": (la, left_matrix, Vector((0, -1, .2))), "r": (ra, right_matrix, Vector((0, -.6, -1)))})
        if down > 1e-3:
            rotate_world(rig, "foot_r", X, -50 * window(down, .2, 1.0))
        turn_chest(rig, 0.0, RISE["bow"] * window(down, .3, 1.0), 0.0)
        rotate_world(rig, "neck_01", X, 18 * window(down, .2, 1.0))
        for side in "lr":
            rotate_world(rig, f"upperarm_{side}", X, -14 * window(down, .2, 1.0))
        poses.append(rig.capture())
    return poses, {"kneelSeconds": round(RISE["start"] * RISE["duration"], 4)}


def whirl(rig, seed):
    """A telegraphed spin: wind to the left in a crouch, sweep once round to the right with the blade out, recover."""
    rig.apply(seed)
    pivot = rig.head("pelvis")
    pivot.z = 0.0
    feet = feet_of(rig)
    shield = guard_shield(rig)
    frames = int(round(WHIRL["duration"] * FPS))
    poses = []
    out_frame = {"g": (-.6, -.3, 1.18), "b": (-.75, -.62, -.05), "e": (0, -1, 0)}
    tuck = {"g": (.2, -.08, 1.12), "b": (-.1, .9, .3), "e": (0, 0, 1)}
    for k in range(frames + 1):
        u = k / frames
        wind = window(u, *WHIRL["wind"]) * (1 - window(u, *WHIRL["spin"]))
        spin = window(u, *WHIRL["spin"])
        back = window(u, *WHIRL["back"])
        yaw = WHIRL["windup"] * wind - 360.0 * spin
        crouch = WHIRL["crouch"] * (window(u, *WHIRL["wind"]) - back)
        heading = Matrix.Rotation(math.radians(yaw), 4, UP)
        body = Matrix.Translation(pivot) @ heading @ Matrix.Translation(-pivot)
        rig.apply(seed)
        move_pelvis(rig, Vector((0, 0, -crouch)), yaw, pivot)
        stepped = {}
        for side, (ankle, matrix, knee) in feet.items():
            # Each foot pivots with the body in two steps during the spin.
            (a0, a1), (b0, b1) = WHIRL["steps"][side]
            turned = WHIRL["windup"] * wind * .5 - 360.0 * .5 * (window(u, a0, a1) + window(u, b0, b1))
            h = Matrix.Rotation(math.radians(turned), 4, UP)
            at = pivot + h @ (ankle - pivot)
            for start, end in ((a0, a1), (b0, b1)):
                into = (u - start) / (end - start)
                if 0.0 < into < 1.0:
                    at.z += WHIRL["lift"] * math.sin(math.pi * into)
            stepped[side] = (at, h @ matrix, h @ knee)
        plant_feet(rig, stepped)
        lag = math.sin(math.pi * spin)
        turn_chest(rig, 18 * wind - 14 * lag, 10 * wind + 4 * lag, 0.0, gaze=.2)
        reach = math.sin(math.pi * window(u, WHIRL["wind"][1] * .8, WHIRL["back"][0]))
        cocked = wind * (1 - reach)
        key = {name: tuple(lerp3(lerp3(READY[name], tuck[name], cocked), out_frame[name], reach)) for name in ("g", "b", "e")}
        place_grip(rig, "weapon", body @ item_frame(v(key["g"]), v(key["b"]), v(key["e"])), SWORD_POLE)
        place_grip(rig, "shield", body @ shield_frame(shield[0] + Vector((.06, .08, -.06)) * reach, shield[1], shield[2]), SHIELD_POLE)
        poses.append(rig.capture())
    return poses, {"degrees": -360.0, "spinSeconds": [round(t * WHIRL["duration"], 4) for t in WHIRL["spin"]]}


def lerp3(a, b, u):
    return tuple(x + (y - x) * u for x, y in zip(a, b))


def overhead_smash(rig, seed):
    """A long, readable wind-up with both hands on the hilt high over the head, a slam to the ground, a slow recovery."""
    rig.apply(seed)
    feet = feet_of(rig)
    frames = int(round(SMASH["duration"] * FPS))
    raised = {"g": (-.06, .1, 1.98), "b": (.02, .55, -.83), "e": (0, -1, 0)}
    hit = {"g": (-.04, -.58, .7), "b": (.02, -.62, -.78), "e": (0, 0, -1)}
    poses = []
    for k in range(frames + 1):
        u = k / frames
        up = window(u, *SMASH["raise"]) * (1 - window(u, *SMASH["hit"]))
        down = window(u, *SMASH["hit"]) * (1 - window(u, *SMASH["recover"]))
        rest = 1 - window(u, *SMASH["raise"]) if u < SMASH["hold"] else window(u, *SMASH["recover"])
        quiver = .006 * math.sin(2 * math.pi * 9 * u) * window(u, .45, SMASH["hold"]) * (1 - window(u, *SMASH["hit"]))
        rig.apply(seed)
        move_pelvis(rig, Vector((0, -.04 * down, .03 * up - SMASH["drop"] * down)))
        plant_feet(rig, feet)
        turn_chest(rig, -8 * up + 4 * down, -16 * up + 34 * down, 0.0, gaze=.4)
        key = {name: tuple(lerp3(lerp3(READY[name], raised[name], up), hit[name], down)) for name in ("g", "b", "e")}
        frame = item_frame(v(key["g"]) + Vector((0, 0, quiver)), v(key["b"]), v(key["e"]))
        place_grip(rig, "weapon", frame, Vector((-.9, -.2, -.3)) if up > .3 else SWORD_POLE)
        # The free hand joins below the right hand on the hilt, palm the other way; the shield arm drops while it can.
        join = window(u, SMASH["join"], SMASH["raise"][0] + .3) * (1 - window(u, *SMASH["recover"]))
        blade = frame.to_3x3() @ Vector((0, 1, 0))
        left = item_frame(frame.translation - blade * .09, blade, -(frame.to_3x3() @ Vector((1, 0, 0))))
        if join > 1e-3:
            joint, local = rig.socket["shield"]
            hold = rig.grip("shield")
            blended = Matrix.Translation(hold.translation.lerp(left.translation, join)) @ hold.to_quaternion().slerp(left.to_quaternion(), join).to_matrix().to_4x4()
            place_grip(rig, "shield", blended, Vector((.9, -.2, -.3)))
        poses.append(rig.capture())
    return poses, {"contactFraction": SMASH["hit"][1]}


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    guard = sample(rig, actions[GUARD], 0.0)
    stand = sample(rig, actions[STAND], 0.0)
    # The ready pose: the guard with the sword grip at READY.
    rig.apply(guard)
    place_grip(rig, "weapon", item_frame(v(READY["g"]), v(READY["b"]), v(READY["e"])), SWORD_POLE)
    ready = rig.capture()
    seed = GUARD
    if clip in DIRECTED:
        poses, observations = slash(rig, ready, clip)
    elif clip == "Sword_Heroic":
        poses, observations = heroic(rig, ready)
    elif clip.startswith("Shield_Guard_"):
        poses, observations = guard_loop(rig, actions[GUARD], clip.split("_")[2])
    elif clip == "Sword_Cleave":
        poses, observations = cleave(rig, ready)
    elif clip == "Charge_Run_Loop":
        poses, observations = charge_loop(rig, actions[SPRINT], ready)
        seed = SPRINT
    elif clip == "Charge_Impact":
        poses, observations = charge_impact(rig, actions[SPRINT], ready)
        seed = SPRINT
    elif clip == "Stun_Loop":
        poses, observations = stun_loop(rig, stand)
        seed = STAND
    elif clip == "Respawn_Rise":
        poses, observations = respawn_rise(rig, stand)
        seed = STAND
    elif clip == "Sword_Whirl":
        poses, observations = whirl(rig, ready)
    else:
        poses, observations = overhead_smash(rig, ready)
    observations = {"source": seed, "durationSeconds": round((len(poses) - 1) / FPS, 4), **observations}
    if clip in UPPER:
        observations.update({"layer": UPPER_ROOT, "joints": upper_joints(rig)})
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


def author_all(rig_object, arguments, target_path):
    """Author every requested clip on ``rig_object`` (each from the imported state); {clip: (poses, observations)}."""
    actions = {}
    for name in (GUARD, STAND, SPRINT):
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
    return {"recipe": "sword-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
