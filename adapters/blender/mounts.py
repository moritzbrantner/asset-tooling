"""Greyhaven mounts: a tacked riding horse with a saddle seat, rein and stirrup sockets and riding gaits (#769).

The declared input ``source`` is the CC0 Quaternius Ultimate Animated Animals ``Horse.glb`` (the farm horse's source,
``AnimalArmature``). The recipe keeps its skinned mesh and armature and none of its clips: every clip is authored here.
A new root node ``greyhaven.mount.horse`` scales the horse to ``HEIGHT`` metres at the ears (withers about 1.55 m),
turns nothing (the head already faces glTF +Z) and puts the centre of its footprint on the ground at the origin.

**Tack** in Greyhaven colours (a slate-blue blanket with an ochre band, brown leather, dark iron): a saddle blanket, a
saddle with pommel, cantle and flaps, a girth, stirrup leathers and irons, a bridle (crown piece, browband, cheek
pieces, noseband, bit rings) and reins. The blanket, saddle and girth are shrink-wrapped onto the rest pose; every tack
vertex is weighted fully to the bone it rides on (``Torso2`` for the saddle, ``Head`` for the bridle) except the reins,
which blend from ``Head`` at the bit to ``Torso2`` at the hands.

**Sockets** (arguments ``tack``, metres in the seat frame: +X the horse's left, +Y up, +Z ahead): ``saddle.seat`` is
where the rider's pelvis joint sits, ``seatAbove`` over the middle of the seat; ``reins.l`` / ``reins.r`` are
the rider's hand targets on the reins; ``stirrup.l`` / ``stirrup.r`` the treads under the balls of the feet. All ride
``Torso2``, so they move rigidly together. The recipe reports each in the root frame at rest (glTF axes); the build
expresses them in the joint's frame.

**Clips** (in place, ``FPS``): every hoof is placed by the recipe and the legs are solved with two-bone IK (the fore
cannon and forearm from the elbow, the hind femur and tibia to the hock over a tilted cannon). A planted hoof slides
back at exactly the gait's speed, so it stays still once the game adds the travel back.

- ``Ride_Idle_Loop``: standing square, breathing, an ear flick, a head bob and a tail swish.
- ``Walk_Loop``: lateral four-beat walk (LH, LF, RH, RF), the head nodding twice a stride.
- ``Trot_Loop``: diagonal two-beat trot (LH with RF, RH with LF) with a suspension, the back bouncing twice a stride.
- ``Canter_Loop``: three-beat right-lead canter (LH; RH with LF; RF), rocking, then a suspension.
- ``Gallop_Loop``: four-beat right-lead transverse gallop (LH, RH, LF, RF), the neck pumping, then a suspension.
- ``Turn_L`` / ``Turn_R``: a 90 degree turn on the haunches at a walk; the body ends turned (the game applies the yaw).
- ``Rear`` (spooked): the hindquarters drop, the forehand rises onto the hind hooves with the forelegs tucked and
  pawing, then comes down where it stood.
- ``Halt``: from ``Walk_Loop``'s first frame to the idle's first frame, the body slowing to a stop over one stride.

Gait periods and speeds come from the arguments (``gaits``), shared with the Ranger's ride clips. No randomness.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

FPS = 30
HEIGHT = 2.05
ROOT = "greyhaven.mount.horse"
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
# Blender axes on the scaled horse: +X its left, -Y ahead, +Z up. Legs: (side sign, shoulder, upper, lower, hoof unit).
FORE = {"LF": (1, "FrontShoulder.L", "FrontUpperLeg.L", "FrontLowerLeg.L", "IKFrontLeg.L"),
        "RF": (-1, "FrontShoulder.R", "FrontUpperLeg.R", "FrontLowerLeg.R", "IKFrontLeg.R")}
HIND = {"LH": (1, "BackShoulder.L", "BackLeg.L", "BackUpperLeg.L", "BackLowerLeg.L", "IKBackLeg.L"),
        "RH": (-1, "BackShoulder.R", "BackLeg.R", "BackUpperLeg.R", "BackLowerLeg.R", "IKBackLeg.R")}
HOOF_TIP = {"LF": "FF.L", "RF": "FF.R", "LH": "FFB.L", "RH": "FFB.R"}
LEGS = ("LH", "LF", "RH", "RF")
NECK = ("Neck1", "Neck2", "Neck3", "Head")
TAIL = ("Tail1", "Tail2", "Tail3", "Tail4", "Tail5", "Tail6", "Tail7")
# Per gait (phases are fractions of the stride): each hoof's touchdown, the stance share (duty), the toe's swing lift
# (metres) and fold (degrees about the toe, the sole turning back), the heel lift at toe-off (degrees), the hind
# cannon's swing flex (degrees), the back's bob (metres; ``bobs`` a stride, lowest at ``low``), its pitch (degrees,
# nose up at ``up``), the neck's nod (degrees, ``nods`` a stride, head lowest at ``nodLow``) and the head carriage
# (degrees, + raises the head), the tail's lift and the shoulders' and hips' share of a leg's swing (metres per metre).
GAITS = {
    "Walk_Loop": {"touch": {"LH": 0.0, "LF": .25, "RH": .5, "RF": .75}, "duty": .62, "lift": .09, "fold": 40.0, "heel": 28.0,
                  "flex": 22.0, "bob": .012, "bobs": 2, "low": .1, "pitch": 0.8, "pitches": 2, "up": .35, "nod": 5.0, "nods": 2,
                  "nodLow": .3, "carriage": 0.0, "tail": 4.0, "reach": .5, "drop": .0},
    "Trot_Loop": {"touch": {"LH": 0.0, "RF": 0.0, "RH": .5, "LF": .5}, "duty": .4, "lift": .15, "fold": 80.0, "heel": 30.0,
                  "flex": 34.0, "bob": .03, "bobs": 2, "low": .2, "pitch": 0.6, "pitches": 2, "up": .45, "nod": 2.0, "nods": 2,
                  "nodLow": .22, "carriage": 6.0, "tail": 14.0, "reach": .5, "drop": .02},
    "Canter_Loop": {"touch": {"LH": 0.0, "RH": .28, "LF": .28, "RF": .52}, "duty": .34, "lift": .18, "fold": 90.0, "heel": 32.0,
                    "flex": 40.0, "bob": .04, "bobs": 1, "low": .44, "pitch": 5.0, "pitches": 1, "up": .12, "nod": 7.0, "nods": 1,
                    "nodLow": .62, "carriage": 2.0, "tail": 22.0, "reach": .5, "drop": .03},
    "Gallop_Loop": {"touch": {"LH": 0.0, "RH": .11, "LF": .36, "RF": .48}, "duty": .26, "lift": .2, "fold": 100.0, "heel": 34.0,
                    "flex": 46.0, "bob": .05, "bobs": 1, "low": .5, "pitch": 6.0, "pitches": 1, "up": .08, "nod": 11.0, "nods": 1,
                    "nodLow": .6, "carriage": -10.0, "tail": 30.0, "reach": .5, "drop": .06},
}
IDLE = {"duration": 4.0}
TURN = {"degrees": 90.0, "duration": 2.4, "pivot": .85}
# Leg steps of the turn: (start, end) fractions per leg; a foot lands where it stands under the body at that time.
TURN_STEPS = {"LF": ((.05, .3), (.38, .62), (.7, .94)), "RF": ((.2, .45), (.52, .78), (.8, .98)),
              "LH": ((.12, .34), (.6, .82)), "RH": ((.3, .52), (.74, .96))}
REAR = {"duration": 2.6, "crouch": .18, "up": .38, "hold": .6, "down": .82, "degrees": 42.0, "paws": 2}
HALT = {"strides": 1.0}
CLIPS = ("Ride_Idle_Loop", "Walk_Loop", "Trot_Loop", "Canter_Loop", "Gallop_Loop", "Turn_L", "Turn_R", "Rear", "Halt")
GAIT_ARGUMENTS = {"Walk_Loop", "Trot_Loop", "Canter_Loop", "Gallop_Loop"}
TACK_KEYS = {"seatAbove", "reins", "stirrup"}
PALETTE = {"blanket": (0.19, 0.25, 0.36), "band": (0.72, 0.55, 0.24), "leather": (0.36, 0.22, 0.12),
           "strap": (0.17, 0.11, 0.07), "iron": (0.32, 0.32, 0.34)}


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "gaits", "tack"} or p["schemaVersion"] != 1:
        raise ValueError("mounts takes schemaVersion 1, gaits and tack")
    gaits = p["gaits"]
    if type(gaits) is not dict or set(gaits) != GAIT_ARGUMENTS:
        raise ValueError(f"mounts gaits must be exactly {sorted(GAIT_ARGUMENTS)}")
    for name, gait in gaits.items():
        if type(gait) is not dict or set(gait) != {"seconds", "speed"} or not all(type(gait[k]) in (int, float) and gait[k] > 0 for k in gait):
            raise ValueError(f"mounts gait {name} needs positive seconds and speed")
    tack = p["tack"]
    if type(tack) is not dict or set(tack) != TACK_KEYS or type(tack["seatAbove"]) not in (int, float):
        raise ValueError(f"mounts tack must be exactly {sorted(TACK_KEYS)}")
    for key in ("reins", "stirrup"):
        if type(tack[key]) is not list or len(tack[key]) != 3 or not all(type(c) in (int, float) for c in tack[key]):
            raise ValueError(f"mounts tack {key} is one [x, y, z] in the seat frame (the left side)")
    if set(inputs) != {"source"}:
        raise ValueError("mounts takes exactly the input source")


def smooth(u):
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)


def wave(u, cycles=1.0, phase=0.0):
    return math.sin(2 * math.pi * (cycles * u + phase))


def rot(axis, degrees, pivot):
    return Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(degrees), 4, axis) @ Matrix.Translation(-pivot)


def seat_to_world(seat, p):
    """A seat-frame point (+X left, +Y up, +Z ahead) in Blender world axes."""
    return seat + Vector((p[0], -p[2], p[1]))


# ---------------------------------------------------------------- source

def slot_for(owner, action):
    animation = owner.animation_data or owner.animation_data_create()
    animation.action = action
    slots = getattr(animation, "action_suitable_slots", None)
    if action is not None and slots:
        animation.action_slot = slots[0]


def mesh_points(meshes):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for mesh in meshes:
        evaluated = mesh.evaluated_get(depsgraph)
        data = evaluated.to_mesh()
        points.extend(evaluated.matrix_world @ v.co for v in data.vertices)
        evaluated.to_mesh_clear()
    return points


def bounds(meshes):
    points = mesh_points(meshes)
    return (Vector([min(p[k] for p in points) for k in range(3)]), Vector([max(p[k] for p in points) for k in range(3)]))


def load_source(path):
    before_objects, before_actions = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    loaded = [obj for obj in bpy.data.objects if obj not in before_objects]
    armature = next(obj for obj in loaded if obj.type == "ARMATURE" and obj.name.startswith("AnimalArmature"))
    mesh = next(obj for obj in loaded if obj.type == "MESH" and obj.find_armature() == armature)
    keep = {mesh, armature}
    parent = armature.parent
    while parent:
        keep.add(parent)
        parent = parent.parent
    for obj in loaded:
        if obj not in keep:
            bpy.data.objects.remove(obj)
    for action in [a for a in bpy.data.actions if a not in before_actions]:
        bpy.data.actions.remove(action)
    if armature.animation_data:
        armature.animation_data.action = None
    for pb in armature.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.matrix_basis = Matrix.Identity(4)
    return armature, mesh


def normalise(armature, mesh):
    root = bpy.data.objects.new(ROOT, None)
    bpy.context.scene.collection.objects.link(root)
    top = armature
    while top.parent:
        top = top.parent
    top.parent = root
    bpy.context.view_layer.update()
    low, high = bounds([mesh])
    root.scale = (HEIGHT / (high.z - low.z),) * 3
    bpy.context.view_layer.update()
    low, high = bounds([mesh])
    root.location = Vector((-(low.x + high.x) / 2, -(low.y + high.y) / 2, -low.z))
    bpy.context.view_layer.update()
    return root


# ---------------------------------------------------------------- the rig in world space

class Horse:
    """Pose the armature with rigid world-space moves; lengths and points are in world metres."""

    def __init__(self, armature, mesh):
        self.arm, self.mesh = armature, mesh
        self.pb = armature.pose.bones
        self.aw = armature.matrix_world.copy()
        self.ai = self.aw.inverted()
        self.reset()
        self.rest_head = {pb.name: self.head(pb.name) for pb in self.pb}
        self.rest_matrix = {pb.name: pb.matrix.copy() for pb in self.pb}
        # Each hoof's toe (its sole's front on the ground) and the rest offset of its hoof unit from the toe.
        groups = {g.name: g.index for g in mesh.vertex_groups}
        self.toe = {}
        for leg, tip in HOOF_TIP.items():
            gi = groups[tip]
            pts = [mesh.matrix_world @ v.co for v in mesh.data.vertices if any(g.group == gi and g.weight > .5 for g in v.groups)]
            front = min(p.y for p in pts)
            self.toe[leg] = Vector((self.rest_head[self.unit(leg)].x, front, 0.0))
        self.fore_len = {leg: ((self.rest_head[up] - self.rest_head[lo]).length, (self.rest_head[lo] - self.rest_head[unit]).length)
                         for leg, (_, _, up, lo, unit) in FORE.items()}
        self.hind_len = {leg: ((self.rest_head[fe] - self.rest_head[ti]).length, (self.rest_head[ti] - self.rest_head[ca]).length)
                         for leg, (_, _, fe, ti, ca, _) in HIND.items()}
        self.reach_error = 0.0

    @staticmethod
    def unit(leg):
        return (FORE.get(leg) or HIND[leg])[-1]

    def reset(self):
        for pb in self.pb:
            pb.matrix_basis = Matrix.Identity(4)
        bpy.context.view_layer.update()

    def head(self, name):
        return self.aw @ self.pb[name].head

    def move(self, name, world):
        """Apply the rigid world transform ``world`` to bone ``name`` (its children follow)."""
        pb = self.pb[name]
        pb.matrix = self.ai @ world @ self.aw @ pb.matrix
        bpy.context.view_layer.update()

    def turn(self, name, axis, degrees, pivot=None):
        if degrees:
            self.move(name, rot(axis, degrees, self.head(name) if pivot is None else pivot))

    def aim(self, name, target):
        pb = self.pb[name]
        start = self.head(name)
        current = (self.aw.to_3x3() @ pb.matrix.to_3x3() @ Y).normalized()
        turn = current.rotation_difference((target - start).normalized()).to_matrix().to_4x4()
        self.move(name, Matrix.Translation(start) @ turn @ Matrix.Translation(-start))

    def two_bone(self, a, b, lengths, target, pole):
        root = self.head(a)
        l1, l2 = lengths
        reach = target - root
        d = max(min(reach.length, (l1 + l2) * .9999), abs(l1 - l2) + 1e-4)
        self.reach_error = max(self.reach_error, reach.length - d)
        u = reach.normalized()
        x = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
        h = math.sqrt(max(l1 * l1 - x * x, 0.0))
        side = pole - u * pole.dot(u)
        side = side.normalized() if side.length > 1e-6 else -Y
        middle = root + u * x + side * h
        # The bones' rest heads are offset from their parent's line by a few millimetres; aim each at the next joint.
        self.aim(a, middle + (self.head(a) - root))
        self.aim(b, root + u * d)

    def toe_at(self, leg):
        """Where the hoof's toe is in the current pose."""
        unit = self.unit(leg)
        return (self.aw @ self.pb[unit].matrix @ self.rest_matrix[unit].inverted() @ self.ai) @ self.toe[leg]

    def place_hoof(self, leg, toe, angle):
        """Put the hoof unit's toe at ``toe`` turned ``angle`` degrees about the toe (+ lifts the heel / folds the sole back)."""
        unit = self.unit(leg)
        rest_toe = self.toe[leg]
        world = Matrix.Translation(toe) @ Matrix.Rotation(math.radians(angle), 4, X) @ Matrix.Translation(-rest_toe)
        self.pb[unit].matrix = self.ai @ world @ self.aw @ self.rest_matrix[unit]
        bpy.context.view_layer.update()
        return self.head(unit)

    def solve_fore(self, leg, fetlock, share):
        sign, shoulder, upper, lower, _ = FORE[leg]
        l1, l2 = self.fore_len[leg]
        elbow = self.head(upper)
        # The shoulder follows the hoof forward and back (the scapula's swing), and drops only as far as the leg needs.
        shift = Vector((0, max(-.2, min(.2, share * (fetlock.y - elbow.y))), 0))
        want = elbow + shift
        flat = Vector((0, want.y - fetlock.y, 0)).length
        limit = (l1 + l2) * .995
        if (want - fetlock).length > limit:
            want.z = fetlock.z + math.sqrt(max(limit * limit - flat * flat - (want.x - fetlock.x) ** 2, 0.0))
        self.move(shoulder, Matrix.Translation(want - elbow))
        self.two_bone(upper, lower, (l1, l2), fetlock, -Y)

    def solve_hind(self, leg, fetlock, tilt, share):
        sign, hip_bone, femur, tibia, cannon, unit = HIND[leg]
        l1, l2 = self.hind_len[leg]
        hip = self.head(femur)
        shift = Vector((0, max(-.12, min(.12, share * .5 * (fetlock.y - hip.y))), 0))
        self.move(hip_bone, Matrix.Translation(shift))
        rest_cannon = self.rest_head[cannon] - self.rest_head[unit]
        hock = fetlock + Matrix.Rotation(math.radians(tilt), 3, X) @ rest_cannon
        self.two_bone(femur, tibia, (l1, l2), hock, -Y + .2 * Z)
        self.aim(cannon, fetlock)


# ---------------------------------------------------------------- gait timing

def stance_of(t, touch, duty):
    """(planted?, progress through the stance or swing) of a hoof at stride phase ``t``."""
    since = (t - touch) % 1.0
    if since < duty:
        return True, since / duty
    return False, (since - duty) / (1 - duty)


def hoof_track(horse, leg, t, gait, span, extra=0.0):
    """A hoof's toe position and angle in a looping gait: planted from ``span``/2 ahead to ``span``/2 behind its rest
    toe (sliding back at the gait's speed), then swung forward with a lift and a fold."""
    rest = horse.toe[leg]
    planted, u = stance_of(t, gait["touch"][leg], gait["duty"])
    if planted:
        y = -span / 2 + span * u
        heel = gait["heel"] * smooth((u - .55) / .45)
        return Vector((rest.x, rest.y + y, 0.0)), heel, True
    # Swing: leave with the heel up and the sole turning back, fold most early, unfold to land flat; the toe lifts
    # early (the knee or hock flexing) and comes forward on a Hermite path that leaves and lands at the stance's own
    # backward speed, so the toe neither drags at lift-off nor skids at touchdown.
    slope = span * (1 - gait["duty"]) / gait["duty"]
    u2, u3 = u * u, u * u * u
    y = (2 * u3 - 3 * u2 + 1) * span / 2 + (u3 - 2 * u2 + u) * slope + (-2 * u3 + 3 * u2) * -span / 2 + (u3 - u2) * slope
    lift = gait["lift"] * math.sin(math.pi * u ** .8)
    fold = gait["fold"] * math.sin(math.pi * min(1.0, u * 1.25)) ** .7 if u < .8 else 0.0
    fold = max(fold, gait["heel"] * (1 - smooth(u / .2)))
    return Vector((rest.x, rest.y + y, lift + extra)), fold, False


def body_motion(horse, gait, t):
    """The torso's world transform at stride phase ``t``: a bob and a pitch about the saddle."""
    bob = -gait["bob"] * math.cos(2 * math.pi * gait["bobs"] * (t - gait["low"])) - gait["drop"]
    pitch = gait["pitch"] * math.cos(2 * math.pi * gait["pitches"] * (t - gait["up"]))
    pivot = horse.rest_head["Torso2"]
    return Matrix.Translation(Vector((0, 0, bob))) @ rot(X, -pitch, pivot), pitch


def pose_neck(horse, nod, carriage, pitch, yaw=0.0):
    """Nod the neck (+ lowers the head) and carry it (+ raises it), taking back half the body's pitch."""
    level = -carriage + nod - .5 * pitch
    for name, share in zip(NECK, (.35, .3, .2, .15)):
        horse.turn(name, X, level * share)
        if yaw:
            horse.turn(name, Z, yaw * share)


def pose_tail(horse, lift, swish, t):
    for k, name in enumerate(TAIL):
        horse.turn(name, X, lift * (1 - k / len(TAIL)) * .45)
        horse.turn(name, Z, swish * math.sin(2 * math.pi * t - k * .5) * .2)


def gait_pose(horse, gait, speed, seconds, t):
    span = speed * seconds * gait["duty"]
    horse.reset()
    motion, pitch = body_motion(horse, gait, t)
    horse.move("Body", motion)
    nod = gait["nod"] * math.cos(2 * math.pi * gait["nods"] * (t - gait["nodLow"]))
    pose_neck(horse, nod, gait["carriage"], pitch)
    pose_tail(horse, gait["tail"], 6.0, t)
    for leg in LEGS:
        toe, angle, planted = hoof_track(horse, leg, t, gait, span)
        fetlock = horse.place_hoof(leg, toe, angle)
        if leg in FORE:
            horse.solve_fore(leg, fetlock, gait["reach"])
        else:
            rest_hip = horse.rest_head[HIND[leg][2]]
            lean = math.degrees(math.atan2(toe.y - horse.toe[leg].y, rest_hip.z))
            _, u = stance_of(t, gait["touch"][leg], gait["duty"])
            flex = 0.0 if planted else -gait["flex"] * math.sin(math.pi * u)
            horse.solve_hind(leg, fetlock, .45 * lean + flex, gait["reach"])
    return capture(horse)


def capture(horse):
    return {pb.name: pb.matrix_basis.copy() for pb in horse.pb}


def gait_clip(horse, name, gaits):
    gait = GAITS[name]
    seconds, speed = gaits[name]["seconds"], gaits[name]["speed"]
    count = int(round(seconds * FPS))
    poses = [gait_pose(horse, gait, speed, seconds, (k % count) / count) for k in range(count + 1)]
    footfalls = {leg: {"touchdown": gait["touch"][leg], "liftoff": round((gait["touch"][leg] + gait["duty"]) % 1.0, 4)} for leg in LEGS}
    return poses, {"strideSeconds": round(count / FPS, 4), "speedMetersPerSecond": speed, "footfalls": footfalls,
                   "strideMeters": round(speed * count / FPS, 4)}


# ---------------------------------------------------------------- idle, turn, rear, halt

def stand(horse, offsets=None, angles=None):
    """Plant every hoof at its rest toe (plus ``offsets``) and solve the legs."""
    for leg in LEGS:
        toe = horse.toe[leg] + (offsets or {}).get(leg, Vector())
        fetlock = horse.place_hoof(leg, toe, (angles or {}).get(leg, 0.0))
        if leg in FORE:
            horse.solve_fore(leg, fetlock, .5)
        else:
            horse.solve_hind(leg, fetlock, 0.0, .5)


def idle_pose(horse, u):
    horse.reset()
    breath = .006 * wave(u, 3)
    sway = .01 * wave(u, 1, .25)
    horse.move("Body", Matrix.Translation(Vector((sway, 0, breath))))
    nod = 4.0 * wave(u, 2, .1) + 3.0 * wave(u, 1)
    look = 6.0 * wave(u, 1, .3)
    pose_neck(horse, nod, 0.0, 0.0, look)
    flick = 25.0 * max(0.0, wave(u, 4, .1)) ** 6
    horse.turn("Ear1.L", Y, -flick)
    horse.turn("Ear1.R", Y, 8.0 * max(0.0, wave(u, 2, .6)) ** 4)
    pose_tail(horse, 0.0, 18.0 * max(0.0, wave(u, 1, .15)) ** 2, u * 2)
    stand(horse)
    return capture(horse)


def idle_clip(horse):
    count = int(round(IDLE["duration"] * FPS))
    return [idle_pose(horse, (k % count) / count) for k in range(count + 1)], {}


def turn_clip(horse, sign):
    """Turn on the haunches: the forehand steps round the hindquarters, the hind feet stepping nearly in place."""
    sp = TURN
    count = int(round(sp["duration"] * FPS))
    pivot = Vector((0, horse.toe["LH"].y - .1, 0))
    total = sign * sp["degrees"]
    yaw_at = lambda u: total * smooth(u)
    poses = []
    for k in range(count + 1):
        u = k / count
        horse.reset()
        yaw = yaw_at(u)
        turn = rot(Z, yaw, pivot)
        horse.move("Body", turn @ Matrix.Translation(Vector((0, 0, -.01 * math.sin(math.pi * u)))))
        pose_neck(horse, 3.0 * wave(u, 3), 2.0, 0.0, sign * 14.0 * math.sin(math.pi * u))
        pose_tail(horse, 3.0, 5.0, u)
        for leg in LEGS:
            steps = TURN_STEPS[leg]
            # Where the foot is planted before, during and after each step: under the body at the step's end.
            placed = 0.0
            lift, fold = 0.0, 0.0
            for start, end in steps:
                landing = total if end == steps[-1][1] else yaw_at(end)
                if u >= end:
                    placed = landing
                elif u > start:
                    w = (u - start) / (end - start)
                    placed = placed + (landing - placed) * smooth(w)
                    lift = .06 * math.sin(math.pi * w)
                    fold = 35.0 * math.sin(math.pi * w)
                    break
                else:
                    break
            toe = rot(Z, placed, pivot) @ horse.toe[leg]
            toe.z = lift
            fetlock = place_turned(horse, leg, toe, fold, placed)
            if leg in FORE:
                horse.solve_fore(leg, fetlock, .3)
            else:
                horse.solve_hind(leg, fetlock, 0.0, .3)
        poses.append(capture(horse))
    return poses, {"turnDegrees": total}


def place_turned(horse, leg, toe, angle, yaw):
    unit = horse.unit(leg)
    rest_toe = horse.toe[leg]
    world = Matrix.Translation(toe) @ Matrix.Rotation(math.radians(yaw), 4, Z) @ Matrix.Rotation(math.radians(angle), 4, X) @ Matrix.Translation(-rest_toe)
    horse.pb[unit].matrix = horse.ai @ world @ horse.aw @ horse.rest_matrix[unit]
    bpy.context.view_layer.update()
    return horse.head(unit)


def rear_clip(horse):
    """Spooked: the hindquarters drop and the forehand rises about the hind hooves, forelegs tucked and pawing; then
    down onto the forelegs where they stood."""
    sp = REAR
    count = int(round(sp["duration"] * FPS))
    pivot = Vector((0, horse.toe["LH"].y - .15, .35))
    poses = []
    for k in range(count + 1):
        u = k / count
        horse.reset()
        crouch = smooth(u / sp["crouch"]) * (1 - smooth((u - sp["down"]) / (1 - sp["down"])))
        rise = smooth((u - sp["crouch"]) / (sp["up"] - sp["crouch"])) * (1 - smooth((u - sp["hold"]) / (sp["down"] - sp["hold"])))
        angle = sp["degrees"] * rise
        horse.move("Body", rot(X, -angle, pivot) @ Matrix.Translation(Vector((0, .06 * crouch, -.06 * crouch))))
        toss = 10.0 * wave(u, 3) * rise
        pose_neck(horse, -14.0 * rise + toss - 4.0 * crouch, 0.0, angle * .3)
        pose_tail(horse, -10.0 * rise, 10.0, u)
        paw = rise * max(0.0, wave((u - sp["up"]) / (sp["hold"] - sp["up"] + 1e-6), sp["paws"] / 2))
        for leg in LEGS:
            if leg in HIND:
                fetlock = horse.place_hoof(leg, horse.toe[leg], 0.0)
                horse.solve_hind(leg, fetlock, 0.0, .0)
                continue
            # The foreleg hangs tucked under the raised chest: the hoof carried with the body, folded, pawing forward.
            carried = rot(X, -angle, pivot) @ horse.toe[leg]
            ground = horse.toe[leg]
            hang = Vector((0, -.05 - .12 * paw * (1 if leg == "LF" else .6), .2 + .1 * paw))
            tucked = carried + rot(X, -angle, Vector()) @ Vector((0, .25, .3)) + hang
            w = smooth(rise * 1.6)
            toe = ground.lerp(tucked, w) if rise > 0 else ground.copy()
            toe.z = max(toe.z, 0.0)
            fetlock = horse.place_hoof(leg, toe, 95.0 * w)
            horse.solve_fore(leg, fetlock, .2)
        poses.append(capture(horse))
    return poses, {"riseSeconds": round(sp["up"] * sp["duration"], 4), "landSeconds": round(sp["down"] * sp["duration"], 4),
                   "rearDegrees": sp["degrees"]}


def halt_clip(horse, gaits):
    """From ``Walk_Loop``'s first frame: one more stride of footfalls, slowing to a stand. Each hoof's next landing is
    its rest place under the stopped body; the body's travel is reported."""
    gait = GAITS["Walk_Loop"]
    seconds, speed = gaits["Walk_Loop"]["seconds"], gaits["Walk_Loop"]["speed"]
    duration = seconds * HALT["strides"]
    count = int(round(duration * FPS))
    span = speed * seconds * gait["duty"]
    travel = lambda tt: speed * (tt - tt * tt / (2 * duration)) if tt < duration else speed * duration / 2
    total = travel(duration)
    poses = []
    for k in range(count + 1):
        tt = k / FPS
        u = tt / duration
        horse.reset()
        fade = 1 - smooth(u)
        motion, pitch = body_motion(horse, {**gait, "bob": gait["bob"] * fade, "pitch": gait["pitch"] * fade}, u)
        horse.move("Body", motion)
        pose_neck(horse, gait["nod"] * fade * math.cos(2 * math.pi * gait["nods"] * (u - gait["nodLow"])), -3.0 * smooth(u), pitch)
        pose_tail(horse, gait["tail"] * fade, 6.0 * fade, u)
        for leg in LEGS:
            touch = gait["touch"][leg]
            landing = touch if touch > 0 else 1.0
            # World positions: the rest place under the stopped body, at the clip's frame (minus the body's travel).
            final = horse.toe[leg] - Vector((0, total - travel(tt), 0))
            planted, w = stance_of(u, touch, gait["duty"])
            if u >= landing - 1e-9:
                toe, angle = final, 0.0
            elif planted:
                # Still on the stance it had at the walk's first frame: planted, sliding back as the body passes.
                since = (0 - touch) % 1.0
                y0 = horse.toe[leg].y - span / 2 + span * since / gait["duty"]
                toe = Vector((horse.toe[leg].x, y0 + travel(tt), 0.0))
                angle = gait["heel"] * smooth((w - .55) / .45)
            else:
                # The walk's swing, bent to land on the stopped place instead of the walk's touchdown.
                toe, angle, _ = hoof_track(horse, leg, u, gait, span)
                walk_land = Vector((horse.toe[leg].x, horse.toe[leg].y - span / 2, 0.0))
                toe = toe + (final - walk_land) * smooth(w)
            fetlock = horse.place_hoof(leg, toe, angle)
            if leg in FORE:
                horse.solve_fore(leg, fetlock, gait["reach"])
            else:
                lean = math.degrees(math.atan2(toe.y - horse.toe[leg].y, horse.rest_head[HIND[leg][2]].z))
                horse.solve_hind(leg, fetlock, .45 * lean, gait["reach"])
        poses.append(capture(horse))
    return poses, {"travelMeters": round(total, 4), "from": "Walk_Loop", "to": "Ride_Idle_Loop"}


# ---------------------------------------------------------------- tack

def material(name, srgb, roughness=.7, metallic=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    node = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    node.inputs["Base Color"].default_value = (*(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb), 1.0)
    node.inputs["Roughness"].default_value = roughness
    node.inputs["Metallic"].default_value = metallic
    return m


class Tack:
    """Tack parts in one bmesh; every vertex carries its bone weights."""

    def __init__(self, horse, materials):
        self.horse = horse
        self.materials = materials
        self.index = {key: i for i, key in enumerate(materials)}
        self.bm = bmesh.new()
        self.deform = self.bm.verts.layers.deform.verify()
        self.groups = []
        points = mesh_points([horse.mesh])
        depsgraph = bpy.context.evaluated_depsgraph_get()
        evaluated = horse.mesh.evaluated_get(depsgraph)
        data = evaluated.to_mesh()
        self.bvh = BVHTree.FromPolygons([evaluated.matrix_world @ v.co for v in data.vertices], [tuple(p.vertices) for p in data.polygons])
        evaluated.to_mesh_clear()
        self.points = points

    def group(self, name):
        if name not in self.groups:
            self.groups.append(name)
        return self.groups.index(name)

    def weigh(self, verts, weights):
        for v in verts:
            for bone, w in (weights(v) if callable(weights) else weights).items():
                if w > 0:
                    v[self.deform][self.group(bone)] = w

    def faces(self, verts, mat):
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = self.index[mat]

    def surface(self, centre, direction, offset, reach=.7):
        """Where a ray from ``reach`` out along ``direction`` back towards ``centre`` meets the horse, raised by ``offset``."""
        origin = centre + direction.normalized() * reach
        hit, normal, _, _ = self.bvh.ray_cast(origin, -direction.normalized(), reach)
        if hit is None:
            return centre + direction.normalized() * offset
        if normal.dot(direction) < 0:
            normal = -normal
        return hit + direction.normalized() * offset

    def sheet(self, rows, mat, weights, thickness=0.0):
        """A grid of points (rows of columns) as a surface, thickened inward by ``thickness`` along its normals."""
        grid = [[self.bm.verts.new(p) for p in row] for row in rows]
        made = [v for row in grid for v in row]
        for a, b in zip(grid, grid[1:]):
            for i in range(len(a) - 1):
                self.bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
        if thickness:
            self.bm.normal_update()
            under = [[self.bm.verts.new(v.co - v.normal * thickness) for v in row] for row in grid]
            for a, b in zip(under, under[1:]):
                for i in range(len(a) - 1):
                    self.bm.faces.new((b[i], b[i + 1], a[i + 1], a[i]))
            # Close the four edges.
            ring = lambda g: [g[0][i] for i in range(len(g[0]))] + [g[j][-1] for j in range(1, len(g))] + \
                [g[-1][i] for i in range(len(g[0]) - 2, -1, -1)] + [g[j][0] for j in range(len(g) - 2, 0, -1)]
            top, bottom = ring(grid), ring(under)
            for i in range(len(top)):
                j = (i + 1) % len(top)
                self.bm.faces.new((top[j], top[i], bottom[i], bottom[j]))
            made += [v for row in under for v in row]
        self.weigh(made, weights)
        self.faces(made, mat)
        return grid

    def tube(self, path, radius, mat, weights, sides=6, closed=False, flat=1.0):
        """A tube along ``path`` (Vectors); ``flat`` squashes it into a strap (the short side along the path's normal)."""
        rings = []
        n = len(path)
        for k, p in enumerate(path):
            a = path[(k - 1) % n] if closed or k > 0 else path[k]
            b = path[(k + 1) % n] if closed or k < n - 1 else path[k]
            t = (b - a).normalized()
            side = t.cross(Z if abs(t.z) < .9 else X).normalized()
            up = side.cross(t).normalized()
            ring = [self.bm.verts.new(p + side * radius * math.cos(2 * math.pi * i / sides) + up * radius * flat * math.sin(2 * math.pi * i / sides))
                    for i in range(sides)]
            rings.append(ring)
        pairs = list(zip(rings, rings[1:] + ([rings[0]] if closed else [])))
        for a, b in pairs:
            for i in range(sides):
                j = (i + 1) % sides
                self.bm.faces.new((a[i], a[j], b[j], b[i]))
        if not closed:
            self.bm.faces.new(list(reversed(rings[0])))
            self.bm.faces.new(rings[-1])
        made = [v for ring in rings for v in ring]
        self.weigh(made, weights)
        self.faces(made, mat)
        return rings

    def box(self, centre, size, mat, weights, rotation=None):
        made = bmesh.ops.create_cube(self.bm, size=1.0, matrix=Matrix.Translation(centre) @ (rotation or Matrix.Identity(4)) @ Matrix.Diagonal((*size, 1)))["verts"]
        self.weigh(made, weights)
        self.faces(made, mat)

    def finish(self, collection):
        mesh = bpy.data.meshes.new("Tack")
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces[:])
        bmesh.ops.triangulate(self.bm, faces=self.bm.faces[:], quad_method="BEAUTY", ngon_method="BEAUTY")
        centre = lambda f: tuple(round(sum(v.co[k] for v in f.verts), 5) for k in range(3))
        order = sorted(self.bm.faces, key=lambda f: (f.material_index, centre(f), sorted(tuple(round(c, 5) for c in v.co) for v in f.verts)))
        rank = {f: i for i, f in enumerate(order)}
        self.bm.faces.sort(key=lambda f: rank[f])
        self.bm.faces.index_update()
        uv = self.bm.loops.layers.uv.new("UVMap")
        for face in self.bm.faces:
            for loop in face.loops:
                loop[uv].uv = (loop.vert.co.y, loop.vert.co.z)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for m in self.materials.values():
            mesh.materials.append(m)
        obj = bpy.data.objects.new("Tack", mesh)
        collection.objects.link(obj)
        for name in self.groups:
            obj.vertex_groups.new(name=name)
        arm = self.horse.arm
        obj.parent = arm
        obj.matrix_parent_inverse = arm.matrix_world.inverted()
        obj.modifiers.new("Armature", "ARMATURE").object = arm
        for poly in mesh.polygons:
            poly.use_smooth = False
        return obj


REIN_CHAIN = ("Head", "Neck3", "Neck2", "Neck1", "Torso3", "Torso2")


def rein_weights(rest_head, point, start, end):
    """A rein point follows the neck bone it lies beside (by its place along the neck), blending into ``Torso2`` over
    the last quarter towards the hands, so the rein bends with the neck instead of swinging about the head."""
    f = min(1.0, max(0.0, (point - start).dot(end - start) / (end - start).length_squared))
    ys = [rest_head[name].y for name in REIN_CHAIN]
    weights = {REIN_CHAIN[0]: 1.0} if point.y <= ys[0] else {REIN_CHAIN[-1]: 1.0}
    for (a, ya), (b, yb) in zip(zip(REIN_CHAIN, ys), zip(REIN_CHAIN[1:], ys[1:])):
        if ya <= point.y < yb:
            w = (point.y - ya) / (yb - ya)
            weights = {a: 1 - w, b: w}
    hand = smooth((f - .75) / .25)
    out = {name: w * (1 - hand) for name, w in weights.items()}
    out["Torso2"] = out.get("Torso2", 0.0) + hand
    return out


def build_tack(horse, tack_args, collection):
    """The tack on the rest pose, and the sockets (seat frame and the left-side offsets mirrored)."""
    mats = {key: material(f"Greyhaven_Tack_{key.capitalize()}", rgb, .45 if key == "iron" else .75, .6 if key == "iron" else 0.0)
            for key, rgb in PALETTE.items()}
    t = Tack(horse, mats)
    rh = horse.rest_head
    back = {"Torso2": 1.0}
    head = {"Head": 1.0}
    # The barrel's axis under the saddle: midway between the withers (Torso3) and the loin (Torso).
    saddle_y = rh["Torso2"].y - .04
    axis_z = rh["Torso2"].z

    def around(y, angle, offset, z=axis_z):
        return t.surface(Vector((0, y, z)), Vector((math.sin(math.radians(angle)), 0, math.cos(math.radians(angle)))), offset)

    # Blanket: a pad from the withers to the loin, down each side, with an ochre band along its edge.
    ys = [saddle_y - .3 + .6 * k / 10 for k in range(11)]
    angles = [-62 + 124 * k / 16 for k in range(17)]
    t.sheet([[around(y, a, .012) for a in angles] for y in ys], "blanket", back, thickness=.01)
    for side in (1, -1):
        edge = [around(y, side * 63, .016) for y in ys]
        t.tube(edge, .012, "band", back, sides=4, flat=.5)
    t.tube([around(ys[0] - .005, a, .016) for a in angles], .01, "band", back, sides=4, flat=.5)
    t.tube([around(ys[-1] + .005, a, .016) for a in angles], .01, "band", back, sides=4, flat=.5)

    # Saddle: the seat dishes between a raised pommel and cantle; flaps hang over the blanket each side.
    seat_ys = [saddle_y - .21 + .42 * k / 12 for k in range(13)]
    seat_angles = [-38 + 76 * k / 10 for k in range(11)]

    def seat_height(y, a):
        f = (y - (saddle_y - .21)) / .42  # 0 at the pommel, 1 at the cantle
        dish = .03 + .09 * smooth((.14 - f) / .14) + .1 * smooth((f - .8) / .2)
        return dish * (1 - .55 * smooth(abs(a) / 38)) + .03

    t.sheet([[around(y, a, seat_height(y, a)) for a in seat_angles] for y in seat_ys], "leather", back, thickness=.035)
    # The seat: the middle of the flat between the pommel's and the cantle's rise, on the saddle's top.
    seat_mid = saddle_y - .21 + .42 * .52
    seat_top = around(seat_mid, 0.0, seat_height(seat_mid, 0.0))
    for side in (1, -1):
        flap = [[around(y, side * a, .03) for a in ([36 + 30 * k / 6 for k in range(7)] if side > 0 else [36 + 30 * k / 6 for k in range(6, -1, -1)])]
                for y in [saddle_y - .14 + .26 * k / 6 for k in range(7)]]
        t.sheet(flap, "leather", back, thickness=.012)
    # Girth: round the barrel behind the elbows, and its buckles.
    girth_y = saddle_y - .12
    girth = [around(girth_y, a, .02) for a in range(-180, 181, 12)]
    t.tube(girth, .035, "strap", back, sides=4, flat=.18, closed=False)

    seat = Vector((0, seat_top.y, seat_top.z + tack_args["seatAbove"]))
    sockets = {"saddle.seat": seat}
    for side, name in ((1, "l"), (-1, "r")):
        sx, sy, sz = tack_args["stirrup"]
        stirrup = seat_to_world(seat, (side * sx, sy, sz))
        rx, ry, rz = tack_args["reins"]
        reins = seat_to_world(seat, (side * rx, ry, rz))
        sockets[f"stirrup.{name}"], sockets[f"reins.{name}"] = stirrup, reins
        # Stirrup leather from under the flap's top to the iron, and the iron: two sides and a tread under the ball.
        hang = around(stirrup.y, side * 40, .045)
        iron_top = stirrup + Vector((0, 0, .13))
        t.tube([hang, hang.lerp(iron_top, .5) + Vector((side * .01, 0, 0)), iron_top], .016, "strap", back, sides=4, flat=.25)
        loop = [iron_top + Vector((0, .055 * math.sin(math.radians(a)), -.13 * (1 - math.cos(math.radians(a))) / 2)) for a in range(-180, 181, 20)]
        t.tube(loop, .008, "iron", back, sides=5, closed=False)
        t.box(stirrup + Vector((0, 0, -.004)), (.09, .11, .012), "iron", back)

    # Bridle: rings of straps round the head at fixed points along the bridge, crown behind the ears, bit rings.
    head_bone = rh["Head"]
    # The head's long axis: from the poll down the face to the muzzle.
    pts = [p for p in t.points if p.y < head_bone.y - .02 and p.z > head_bone.z - .5 and abs(p.x) < .2]
    muzzle = min(pts, key=lambda p: p.y)
    poll = head_bone + Vector((0, .02, .03))
    face_axis = (Vector((0, muzzle.y, muzzle.z)) - Vector((0, poll.y, poll.z))).normalized()
    across = X.cross(face_axis).normalized()

    def strap_ring(f, offset=.012, tilt=0.0, arc=(0, 360)):
        centre = Vector((0, poll.y, poll.z)) + face_axis * f * (Vector((0, muzzle.y, muzzle.z)) - Vector((0, poll.y, poll.z))).length
        normal = (face_axis + across * tilt).normalized()
        u = X
        v = normal.cross(u).normalized()
        ring = []
        for a in range(arc[0], arc[1] + 1, 15):
            d = u * math.cos(math.radians(a)) + v * math.sin(math.radians(a))
            ring.append(t.surface(centre, d, offset, .3))
        return ring, centre

    crown, _ = strap_ring(.04, tilt=.9)
    t.tube(crown, .016, "strap", head, sides=4, flat=.3, closed=True)
    brow, _ = strap_ring(.1, tilt=-.3, arc=(-80, 260))
    t.tube(brow, .012, "strap", head, sides=4, flat=.3, closed=True)
    nose, _ = strap_ring(.72, tilt=.15)
    t.tube(nose, .016, "strap", head, sides=4, flat=.3, closed=True)
    bit_centre = Vector((0, poll.y, poll.z)) + face_axis * .86 * (Vector((0, muzzle.y, muzzle.z)) - Vector((0, poll.y, poll.z))).length
    rings = {}
    for side, name in ((1, "l"), (-1, "r")):
        cheek_top = t.surface(Vector((0, poll.y, poll.z)) + face_axis * .05, Vector((side, 0, 0)), .014, .3)
        bit = t.surface(bit_centre, Vector((side, 0, -.25)), .02, .3)
        mid = t.surface((cheek_top + bit) / 2 * Vector((0, 1, 1)), Vector((side, 0, 0)), .014, .3)
        t.tube([cheek_top, mid, bit], .014, "strap", head, sides=4, flat=.3)
        ring = [bit + Vector((side * .006, .03 * math.cos(math.radians(a)), .03 * math.sin(math.radians(a)))) for a in range(0, 360, 30)]
        t.tube(ring, .006, "iron", head, sides=4, closed=True)
        rings[name] = bit + Vector((side * .01, 0, -.02))

    # Reins: from each bit ring, sagging below the neck's line, to the rider's hand; a bight joins the two hands.
    for name in ("l", "r"):
        start, end = rings[name], sockets[f"reins.{name}"]
        path = []
        for k in range(13):
            f = k / 12
            p = start.lerp(end, f) + Vector((0, 0, -.12 * math.sin(math.pi * f)))
            side = 1 if name == "l" else -1
            # Keep the rein outside the neck: never closer to the midline than the neck's surface plus a margin.
            surface = t.surface(Vector((0, p.y, p.z)), Vector((side, 0, 0)), .02)
            if abs(p.x) < abs(surface.x):
                p.x = surface.x
            path.append(p)
        t.tube(path, .007, "strap", lambda v, s=start, e=end: rein_weights(rh, v.co, s, e), sides=4, flat=.35)
    left, right = sockets["reins.l"], sockets["reins.r"]
    bight = [left.lerp(right, k / 8) + Vector((0, .04 * math.sin(math.pi * k / 8), -.08 * math.sin(math.pi * k / 8))) for k in range(9)]
    bight = [t.surface(Vector((0, p.y, p.z - .3)), Z, .03) if p.z < t.surface(Vector((0, p.y, p.z - .3)), Z, .03).z else p for p in bight]
    t.tube(bight, .007, "strap", back, sides=4, flat=.35)
    obj = t.finish(collection)
    return obj, sockets


# ---------------------------------------------------------------- export

def action_curves(action):
    curves = list(getattr(action, "fcurves", None) or [])
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                curves.extend(bag.fcurves)
    return curves


def write_actions(horse, clips):
    arm = horse.arm
    data = arm.animation_data or arm.animation_data_create()
    data.action = None
    for clip, poses in clips.items():
        action = bpy.data.actions.new(clip)
        slot_for(arm, action)
        for frame, pose in enumerate(poses):
            for name, basis in pose.items():
                pb = arm.pose.bones[name]
                pb.matrix_basis = basis
                pb.keyframe_insert("location", frame=frame)
                pb.keyframe_insert("rotation_quaternion", frame=frame)
                pb.keyframe_insert("scale", frame=frame)
        for curve in action_curves(action):
            for key in curve.keyframe_points:
                key.interpolation = "LINEAR"
        action.use_fake_user = True
        data.action = None
    horse.reset()


def hoof_slide(horse, poses, speed):
    """The worst summed ground slide of a toe while it stays planted (under 1 cm), the speed added back."""
    worst = 0.0
    tracks = {leg: [] for leg in LEGS}
    for pose in poses:
        for name, basis in pose.items():
            horse.pb[name].matrix_basis = basis
        bpy.context.view_layer.update()
        for leg in LEGS:
            tracks[leg].append(horse.toe_at(leg))
    for leg, pts in tracks.items():
        span = 0.0
        for k, (a, b) in enumerate(zip(pts, pts[1:])):
            planted = a.z < .01 and b.z < .01
            moved = (b - a) - Vector((0, speed / FPS, 0))
            span = span + moved.xy.length if planted else 0.0
            worst = max(worst, span)
    horse.reset()
    return round(worst, 4)


def author(horse, arguments):
    gaits = arguments["gaits"]
    clips, observed = {}, {}
    makers = {
        "Ride_Idle_Loop": lambda: idle_clip(horse),
        "Turn_L": lambda: turn_clip(horse, 1),
        "Turn_R": lambda: turn_clip(horse, -1),
        "Rear": lambda: rear_clip(horse),
        "Halt": lambda: halt_clip(horse, gaits),
    }
    for name in CLIPS:
        horse.reach_error = 0.0
        poses, info = gait_clip(horse, name, gaits) if name in GAIT_ARGUMENTS else makers[name]()
        speed = info.get("speedMetersPerSecond", 0.0)
        info = {**info, "durationSeconds": round((len(poses) - 1) / FPS, 4), "loop": name.endswith("_Loop"),
                "reachErrorMeters": round(horse.reach_error, 4)}
        if name != "Halt" and name != "Rear":
            info["hoofSlideMeters"] = hoof_slide(horse, poses, speed)
        clips[name], observed[name] = poses, info
    return clips, observed


def gltf(v):
    return [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]


def prepare(source_path, arguments):
    """Load, normalise, author and tack the horse in the current scene; return what ``generate`` exports."""
    armature, mesh = load_source(source_path)
    root = normalise(armature, mesh)
    horse = Horse(armature, mesh)
    clips, observed = author(horse, arguments)
    write_actions(horse, clips)
    tack, sockets = build_tack(horse, arguments["tack"], bpy.context.scene.collection)
    return root, horse, tack, sockets, clips, observed


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = FPS, 1.0
    root, horse, tack, sockets, clips, observed = prepare(inputs["source"], arguments)
    low, high = bounds([horse.mesh, tack])
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [root, *root.children_recursive]:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=False, export_optimize_animation_keep_anim_armature=True,
        export_skins=True, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {
        "recipe": "mounts-v1", "fps": FPS, "root": root.name, "joints": len(horse.arm.data.bones),
        "meshes": sorted([horse.mesh.name, tack.name]),
        "materials": sorted({s.material.name for m in (horse.mesh, tack) for s in m.material_slots if s.material}),
        "restBounds": {"min": gltf(Vector((low.x, high.y, low.z))), "max": gltf(Vector((high.x, low.y, high.z)))},
        "scale": round(root.scale.x, 6),
        "sockets": {name: {"bone": "Torso2", "at": gltf(p)} for name, p in sorted(sockets.items())},
        "seatHeightMeters": round(sockets["saddle.seat"].z, 4),
        "clips": observed,
    }
