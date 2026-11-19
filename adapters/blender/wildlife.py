"""Greyhaven wildlife: a stag, a doe, a fox, a rabbit, a wild boar, a crow, a duck, a heron and a songbird for
Greyhaven's woods, meadows and river, and the hostile Timber Wolf, Young Boar, Grain Rat, brown bear, giant cave spider
and marsh lurker with combat clips.

The stag, doe, fox and wolf come from CC0 Quaternius *Ultimate Animated Animals* (``Stag.glb``, ``Deer.glb``,
``Fox.glb``, ``Wolf.glb``) and the rat from CC0 Quaternius *Easy Enemy* (``Rat.glb``), each the declared ``source``
input; the recipe keeps their skinned mesh, armature and the clips in ``SOURCE_CLIPS`` (``Eating`` ships as ``Eat``).
The stag's antlers are parented to its head bone in the source, so they are bound to that bone as a second skinned
mesh. No CC0 Quaternius rabbit, boar or bird exists, so those six are original: low-poly rigid parts on a small
armature, every vertex weighted fully to one bone, with scripted ``Idle``, ``Walk`` and ``Eat`` loops, and a ``Fly``
wingbeat loop on the four birds.

The wolf, boar and rat also fight (#715): a looping in-place ``Run`` and the one-shot ``Attack_A``, ``Attack_B``,
``Hit``, ``Death`` and ``Alert``. The boar's are scripted on its rig like its loops. The wolf's and rat's reuse their
authored source clips where one fits (``Gallop``, ``Death``, ``Rat_Run``, ``Rat_Death``) and otherwise are ``LAYERED``:
a source clip, re-timed by a piecewise-linear warp, with a scripted additive pose baked on every frame (a bite's shake,
a leap, a swipe, a snarl). ``CONTACT_FRAMES`` names the frame each attack lands.

The brown bear, giant cave spider and marsh lurker (#722) are hostile only and original too, since no catalogued CC0
source has them; they are built like the boar, with the full combat set scripted on their rigs. The spider's eight
legs are placed each frame by a two-bone solve (``spider_feet``) so its feet stay planted while the body rears, lunges
or leaps.

The farm-animals recipe (``farm_animals.py``) is a declared Python input named ``farm``; this recipe reuses its rig
builder, clip keying and measuring helpers and its conventions (docs/greyhaven-farm-animals.md): a root node
``greyhaven.wild.<animal>`` scales the animal to its Greyhaven height in metres (measured at the first Idle frame), turns
its head to glTF +Z and puts the centre of its footprint on the ground at the origin. Every clip loops in place. There is
no randomness.

``prepare(animal, source_path)`` also runs in a live Blender session after ``use_farm(module dict of farm_animals.py)``
(``source_path`` is ``None`` for the authored animals).
"""
import math

import bpy
from mathutils import Quaternion, Vector

FPS = 24
SHARED = ("Rig", "key_pose", "wave", "slot_for", "bounds", "principled_from_diffuse")
UAA_CLIPS = {"Idle": "Idle", "Walk": "Walk", "Eat": "Eating"}
# Shipped clip -> source clip (the source's action name after its "<armature>|" prefix), kept as authored.
SOURCE_CLIPS = {
    "stag": UAA_CLIPS, "doe": UAA_CLIPS, "fox": UAA_CLIPS,
    "wolf": {**UAA_CLIPS, "Run": "Gallop", "Death": "Death"},
    "rat": {"Idle": "Rat_Idle", "Walk": "Rat_Walk", "Run": "Rat_Run", "Death": "Rat_Death"},
}
# height: metres at the top of the idle pose, antlers and ears included. turn: degrees about Blender +Z to face glTF +Z.
ANIMALS = {
    "stag": {"format": "glb", "turn": 0.0, "height": 2.0},
    "doe": {"format": "glb", "turn": 0.0, "height": 1.45},
    "fox": {"format": "glb", "turn": 0.0, "height": 0.5},
    "wolf": {"format": "glb", "turn": 0.0, "height": 0.9},
    "rat": {"format": "glb", "turn": 0.0, "height": 0.3},
    "rabbit": {"format": "authored", "turn": -90.0, "height": 0.3},
    "boar": {"format": "authored", "turn": -90.0, "height": 0.95},
    "crow": {"format": "authored", "turn": -90.0, "height": 0.3},
    "duck": {"format": "authored", "turn": -90.0, "height": 0.36},
    "heron": {"format": "authored", "turn": -90.0, "height": 0.95},
    "songbird": {"format": "authored", "turn": -90.0, "height": 0.17},
    "bear": {"format": "authored", "turn": -90.0, "height": 1.3},
    "spider": {"format": "authored", "turn": -90.0, "height": 0.45},
    "marsh-lurker": {"format": "authored", "turn": -90.0, "height": 0.3},
}
BIRDS = ("crow", "duck", "heron", "songbird")
HOSTILE = ("wolf", "boar", "rat", "bear", "spider", "marsh-lurker")
# One-shot clips; every other clip loops.
ONE_SHOT = ("Attack_A", "Attack_B", "Hit", "Death", "Alert")


def use_farm(farm):
    """Bind the farm-animals recipe's shared helpers (its module dict) into this module."""
    globals().update({name: farm[name] for name in SHARED})


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "animal"} or p["schemaVersion"] != 1 or p["animal"] not in ANIMALS:
        raise ValueError(f"wildlife takes schemaVersion 1 and an animal of {sorted(ANIMALS)}")
    expected = {"farm"} | (set() if ANIMALS[p["animal"]]["format"] == "authored" else {"source"})
    if set(inputs) != expected:
        raise ValueError(f"wildlife animal {p['animal']} takes exactly the inputs {sorted(expected)}")


# ---------------------------------------------------------------- sourced animals

def load_source(animal, source_path):
    before_objects, before_actions = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=source_path)
    loaded = [obj for obj in bpy.data.objects if obj not in before_objects]
    armature = next(obj for obj in loaded if obj.type == "ARMATURE")
    # Bind meshes parented to a single bone (the stag's antlers) as skinned meshes weighted fully to that bone.
    for obj in [o for o in loaded if o.type == "MESH" and o.parent == armature and o.parent_type == "BONE"]:
        world = obj.matrix_world.copy()
        bone = obj.parent_bone
        obj.parent_type = "OBJECT"
        obj.matrix_world = world
        group = obj.vertex_groups.new(name=bone)
        group.add([v.index for v in obj.data.vertices], 1.0, "REPLACE")
        obj.modifiers.new("Armature", "ARMATURE").object = armature
    bpy.context.view_layer.update()
    meshes = sorted((obj for obj in loaded if obj.type == "MESH" and obj.find_armature() == armature), key=lambda o: o.name)
    if not meshes:
        raise ValueError(f"{animal}: no mesh is skinned to {armature.name}")
    keep = set(meshes) | {armature}
    parent = armature.parent
    while parent:
        keep.add(parent)
        parent = parent.parent
    for obj in loaded:
        if obj not in keep:
            bpy.data.objects.remove(obj)
    sources = {a.name.split("|")[-1]: a for a in bpy.data.actions if a not in before_actions}
    actions = {name: sources[source] for name, source in SOURCE_CLIPS[animal].items()}
    if animal in LAYERED:
        actions.update(layer_clips(animal, armature, sources))
    for action in [a for a in sources.values() if a not in actions.values()]:
        bpy.data.actions.remove(action)
    for material in {slot.material for mesh in meshes for slot in mesh.material_slots if slot.material}:
        principled_from_diffuse(material)
    return armature, meshes, actions


# ---------------------------------------------------------------- layered source clips (#715)

# Source rigs (Quaternius glTF imports) in armature space: up is -Y and the head faces -Z. Rotations name an axis:
# "P" pitches (positive tips a forward-pointing bone nose-down, a hanging leg backward), "W" yaws, "R" rolls. "loc"
# moves a bone by (forward, up, lateral) in rig heights (the spread of the rest bone heads along up).
SOURCE_AXES = {"P": (1, 0, 0), "W": (0, -1, 0), "R": (0, 0, -1)}
FORWARD, UP, LATERAL = Vector((0, 0, -1)), Vector((0, -1, 0)), Vector((1, 0, 0))
# Shipped clip -> (source clip, warp: ((frame, source frame), ...) piecewise linear from 0 to the clip's last frame).
LAYERED = {
    "wolf": {
        "Attack_A": ("Attack", ((0, 0), (10, 10), (15, 20), (21, 32))),
        "Attack_B": ("Attack", ((0, 0), (9, 5), (14, 9), (17, 20), (25, 32))),
        "Hit": ("Idle_HitReact_Left", ((0, 0), (8, 16))),
        "Alert": ("Idle", ((0, 0), (20, 20))),
    },
    "rat": {
        "Eat": ("Rat_Idle", ((0, 0), (48, 57))),
        "Attack_A": ("Rat_Attack", ((0, 0), (10, 10), (18, 16))),
        "Attack_B": ("Rat_Idle", ((0, 0), (24, 24))),
        "Hit": ("Rat_Idle", ((0, 0), (8, 8))),
        "Alert": ("Rat_Idle", ((0, 0), (20, 20))),
    },
}
# The frame each attack lands (the bite closes, the swipe or the tusks connect), for the zone's creature melee.
CONTACT_FRAMES = {
    "wolf": {"Attack_A": 9, "Attack_B": 14},
    "rat": {"Attack_A": 10, "Attack_B": 12},
    "boar": {"Attack_A": 9, "Attack_B": 15},
    "bear": {"Attack_A": 11, "Attack_B": 20},
    "spider": {"Attack_A": 9, "Attack_B": 14},
    "marsh-lurker": {"Attack_A": 8, "Attack_B": 14},
}


def curve(x, *keys):
    """Smoothstep through ``keys`` ((x, value), ...); constant outside them."""
    if x <= keys[0][0]:
        return keys[0][1]
    for (x0, v0), (x1, v1) in zip(keys, keys[1:]):
        if x <= x1:
            s = (x - x0) / (x1 - x0)
            return v0 + (v1 - v0) * s * s * (3 - 2 * s)
    return keys[-1][1]


def warped(warp, frame):
    for (t0, s0), (t1, s1) in zip(warp, warp[1:]):
        if frame <= t1:
            return s0 + (s1 - s0) * (frame - t0) / (t1 - t0)
    return warp[-1][1]


def wolf_layer(clip, t):
    feet = ("IKFrontLeg.L", "IKFrontLeg.R", "IKBackLeg.L", "IKBackLeg.R")
    if clip == "Attack_A":
        # The source lunges and bites low; the jaws close at 9 and the head shakes the prey from side to side.
        shake = curve(t, (9, 0), (10, 1), (14, 1), (16, 0)) * math.sin(math.pi * (t - 9) / 1.6)
        ears = curve(t, (0, 0), (4, -35), (16, -35), (21, 0))
        return {"Head": [("R", 24 * shake), ("W", 12 * shake)], "Neck3": [("R", 10 * shake)], "Neck1": [("P", curve(t, (0, 0), (5, -10), (8, 0)))],
                "Ear1.L": [("P", ears)], "Ear1.R": [("P", ears)]}
    if clip == "Attack_B":
        # A deeper crouch, a leap that lifts the whole body and feet, forelegs reaching, the bite on landing at 14.
        air = curve(t, (0, 0), (9, 0), (11.5, 1), (14, 0), (25, 0))
        crouch = curve(t, (0, 0), (8, 1), (10, 0))
        ears = curve(t, (0, 0), (5, -40), (18, -40), (25, 0))
        pose = {"Body": [("loc", (0, 0.32 * air - 0.05 * crouch, 0)), ("P", curve(t, (0, 0), (8, 6), (11, -8), (13, 8), (16, 0)))],
                "Ear1.L": [("P", ears)], "Ear1.R": [("P", ears)]}
        for foot in feet:
            front = "Front" in foot
            pose[foot] = [("loc", (0.22 * air if front else -0.12 * air, 0.32 * air + (0.12 if front else 0.05) * air, 0))]
        return pose
    if clip == "Hit":
        return {"Head": [("P", curve(t, (0, 0), (2, -12), (8, 0)))], "Ear1.L": [("P", curve(t, (0, 0), (2, -30), (8, 0)))],
                "Ear1.R": [("P", curve(t, (0, 0), (2, -30), (8, 0)))]}
    # Alert: lowers the head, flattens the ears, bares the muzzle and gives two snapping snarls.
    snarl = curve(t, (0, 0), (5, 1), (16, 1), (20, 0))
    snap = curve(t, (6, 0), (7, 1), (9, 0), (11, 0), (12, 1), (14, 0))
    return {"Torso": [("P", 6 * snarl)], "Neck1": [("P", 14 * snarl + 6 * snap)], "Head": [("P", -16 * snarl - 6 * snap)],
            "Ear1.L": [("P", -45 * snarl)], "Ear1.R": [("P", -45 * snarl)], "Tail1": [("P", 15 * snarl)],
            "Body": [("loc", (0.03 * snap, 0, 0))]}


def rat_layer(clip, t):
    if clip == "Eat":
        chew = wave(t / 48, 8)
        return {"Body": [("P", 8)], "Neck": [("P", 30)], "Head": [("P", 22 + 5 * chew)]}
    if clip == "Attack_A":
        return {}
    if clip == "Attack_B":
        # Rears onto its haunches, then rakes down with the right forepaw at 12 and the left after it.
        rear = curve(t, (0, 0), (6, 1), (16, 1), (24, 0))
        right = curve(t, (0, 0), (6, -1), (9, -1), (12, 1), (15, 0))
        left = curve(t, (0, 0), (9, 0), (12, -1), (15, 1), (18, 0))
        return {"Body": [("P", -32 * rear)], "Head": [("P", 18 * rear)], "Tail1": [("P", 40 * rear)], "root": [("loc", (0, 0.03 * rear, 0))],
                "FrontFoot.R": [("loc", (0.25 * right, 0.25 * rear + 0.15 * max(0.0, -right) - 0.1 * max(0.0, right), 0))],
                "FrontFoot.L": [("loc", (0.25 * left, 0.25 * rear + 0.15 * max(0.0, -left) - 0.1 * max(0.0, left), 0))]}
    if clip == "Hit":
        jolt = curve(t, (0, 0), (2, 1), (8, 0))
        return {"Body": [("P", -10 * jolt), ("R", 8 * jolt)], "Head": [("P", -15 * jolt)], "root": [("loc", (-0.06 * jolt, 0, 0))]}
    # Alert: up on the haunches, head high and thrust forward in two hisses.
    up = curve(t, (0, 0), (5, 1), (16, 1), (20, 0))
    hiss = curve(t, (6, 0), (8, 1), (10, 0.3), (12, 1), (15, 0))
    return {"Body": [("P", -18 * up)], "Neck": [("P", 10 * up)], "Head": [("P", -10 * up + 8 * hiss)],
            "Tail1": [("P", 22 * up), ("W", 12 * hiss)], "root": [("loc", (0.03 * hiss, 0.02 * up, 0))]}


def sample_pose(armature, frame):
    whole = math.floor(frame)
    bpy.context.scene.frame_set(whole, subframe=frame - whole)
    return {pb.name: (pb.location.copy(), pb.rotation_quaternion.copy(), pb.scale.copy()) for pb in armature.pose.bones}


def key_layered(armature, frame, base, pose, unit):
    """Key ``base`` (a sampled source pose) with ``pose`` added: rotations about rig axes at rest, moves in rig heights."""
    for pb in armature.pose.bones:
        location, rotation, scale = base[pb.name]
        rest = pb.bone.matrix_local.to_quaternion()
        q, offset = Quaternion(), Vector()
        for axis, value in pose.get(pb.name, ()):
            if axis == "loc":
                offset += (FORWARD * value[0] + UP * value[1] + LATERAL * value[2]) * unit
            else:
                q = Quaternion(Vector(SOURCE_AXES[axis]), math.radians(value)) @ q
        pb.rotation_quaternion = rest.inverted() @ q @ rest @ rotation
        pb.location = location + rest.inverted() @ offset
        pb.scale = scale
        for path in ("location", "rotation_quaternion", "scale"):
            pb.keyframe_insert(path, frame=frame)


def layer_clips(animal, armature, sources):
    heads = [-bone.head_local.y for bone in armature.data.bones]
    unit = max(heads) - min(heads)
    layer = {"wolf": wolf_layer, "rat": rat_layer}[animal]
    actions = {}
    for clip, (source, warp) in LAYERED[animal].items():
        slot_for(armature, sources[source])
        count = warp[-1][0]
        bases = [sample_pose(armature, warped(warp, t)) for t in range(count + 1)]
        action = bpy.data.actions.new(clip)
        slot_for(armature, action)
        for t, base in enumerate(bases):
            key_layered(armature, t, base, layer(clip, t), unit)
        actions[clip] = action
    return actions


# ---------------------------------------------------------------- authored quadrupeds (Blender axes: +X forward, +Z up)

RABBIT_PALETTE = {"fur": (0.52, 0.42, 0.32), "pale": (0.9, 0.87, 0.82), "pink": (0.8, 0.58, 0.56), "dark": (0.06, 0.05, 0.05)}


def build_rabbit(collection):
    bones = [("Body", (-0.12, 0, 0.13), (0.1, 0, 0.15), None), ("Head", (0.1, 0, 0.17), (0.2, 0, 0.19), "Body"),
             ("EarL", (0.12, 0.025, 0.24), (0.08, 0.04, 0.36), "Head"), ("EarR", (0.12, -0.025, 0.24), (0.08, -0.04, 0.36), "Head"),
             ("HindL", (-0.07, 0.06, 0.1), (-0.03, 0.06, 0.0), "Body"), ("HindR", (-0.07, -0.06, 0.1), (-0.03, -0.06, 0.0), "Body"),
             ("ForeL", (0.07, 0.04, 0.1), (0.09, 0.04, 0.0), "Body"), ("ForeR", (0.07, -0.04, 0.1), (0.09, -0.04, 0.0), "Body")]
    r = Rig("Rabbit", RABBIT_PALETTE, bones)
    r.ellipsoid("Body", "fur", (-0.02, 0, 0.13), (0.13, 0.075, 0.085), rotation=(0, 0.25, 0), segments=10, rings=6)
    r.ellipsoid("Body", "pale", (0.03, 0, 0.1), (0.07, 0.05, 0.05), segments=7, rings=4)
    r.ellipsoid("Body", "pale", (-0.15, 0, 0.13), (0.03, 0.03, 0.03), segments=6, rings=4)
    r.ellipsoid("Head", "fur", (0.14, 0, 0.2), (0.065, 0.048, 0.052), rotation=(0, 0.2, 0), segments=8, rings=5)
    r.ellipsoid("Head", "pink", (0.2, 0, 0.19), (0.012, 0.012, 0.01), segments=5, rings=3)
    for s, ear in ((1, "EarL"), (-1, "EarR")):
        r.ellipsoid(ear, "fur", (0.1, s * 0.033, 0.3), (0.022, 0.012, 0.065), rotation=(s * -0.15, -0.3, 0), segments=6, rings=4)
        r.ellipsoid(ear, "pink", (0.105, s * 0.036, 0.3), (0.014, 0.006, 0.05), rotation=(s * -0.15, -0.3, 0), segments=5, rings=3)
        r.ellipsoid("Head", "dark", (0.17, s * 0.038, 0.215), (0.011, 0.007, 0.011), segments=5, rings=3)
    for s, hind, fore in ((1, "HindL", "ForeL"), (-1, "HindR", "ForeR")):
        r.ellipsoid(hind, "fur", (-0.07, s * 0.06, 0.08), (0.06, 0.03, 0.055), rotation=(0, 0.3, 0), segments=7, rings=4)
        r.ellipsoid(hind, "fur", (-0.03, s * 0.06, 0.014), (0.065, 0.02, 0.014), segments=6, rings=3)
        r.tube(fore, "fur", (0.07, s * 0.04, 0.1), (0.09, s * 0.04, 0.01), 0.016, 0.012, 5)
        r.ellipsoid(fore, "pale", (0.1, s * 0.04, 0.008), (0.02, 0.014, 0.008), segments=5, rings=3)
    return r.finish(collection)


BOAR_PALETTE = {"coat": (0.3, 0.22, 0.16), "dark": (0.14, 0.1, 0.08), "snout": (0.42, 0.31, 0.28), "tusk": (0.9, 0.86, 0.76), "eye": (0.04, 0.03, 0.03)}
BOAR_LEGS = (("FL", 0.3, 1), ("FR", 0.3, -1), ("HL", -0.32, 1), ("HR", -0.32, -1))


def build_boar(collection):
    hip, knee = 0.42, 0.2
    bones = [("Body", (-0.45, 0, 0.55), (0.35, 0, 0.6), None), ("Head", (0.42, 0, 0.62), (0.82, 0, 0.36), "Body"),
             ("Tail", (-0.5, 0, 0.6), (-0.56, 0, 0.45), "Body")]
    for leg, x, s in BOAR_LEGS:
        bones += [(f"Leg{leg}", (x, s * 0.12, hip), (x, s * 0.12, knee), "Body"), (f"Shin{leg}", (x, s * 0.12, knee), (x, s * 0.12, 0.0), f"Leg{leg}")]
    r = Rig("Boar", BOAR_PALETTE, bones)
    r.ellipsoid("Body", "coat", (-0.08, 0, 0.53), (0.46, 0.21, 0.27), segments=12, rings=7)
    r.ellipsoid("Body", "coat", (0.2, 0, 0.6), (0.27, 0.2, 0.29), segments=10, rings=6)
    r.ellipsoid("Body", "dark", (0.12, 0, 0.8), (0.32, 0.07, 0.06), rotation=(0, -0.2, 0), segments=8, rings=4)  # bristle ridge
    r.tube("Head", "coat", (0.36, 0, 0.62), (0.76, 0, 0.42), 0.17, 0.075, 8)
    r.tube("Head", "snout", (0.75, 0, 0.425), (0.81, 0, 0.4), 0.075, 0.07, 8)
    for s in (1, -1):
        r.tube("Head", "tusk", (0.7, s * 0.06, 0.4), (0.76, s * 0.09, 0.47), 0.014, 0.004, 5)
        r.ellipsoid("Head", "dark", (0.42, s * 0.1, 0.78), (0.04, 0.025, 0.07), rotation=(s * 0.4, -0.2, 0), segments=6, rings=3)
        r.ellipsoid("Head", "eye", (0.6, s * 0.09, 0.58), (0.016, 0.012, 0.014), segments=5, rings=3)
    r.tube("Tail", "dark", (-0.52, 0, 0.6), (-0.56, 0, 0.44), 0.02, 0.008, 5)
    for leg, x, s in BOAR_LEGS:
        y = s * 0.12
        r.tube(f"Leg{leg}", "coat", (x, y, hip + 0.1), (x, y, knee - 0.01), 0.09, 0.05, 7)
        # #736: a rounded shoulder or haunch on the leg closes its flat top inside the body, so a leg swung against the
        # body (the gore's rear) never shows the tube's end.
        r.ellipsoid(f"Leg{leg}", "coat", (x, y * 0.92, hip + 0.05), (0.115, 0.09, 0.14), segments=8, rings=5)
        r.tube(f"Shin{leg}", "dark", (x, y, knee + 0.01), (x, y, 0.04), 0.045, 0.035, 6)
        r.tube(f"Shin{leg}", "eye", (x, y, 0.05), (x, y, 0.0), 0.036, 0.042, 6)
    return r.finish(collection)


# ---------------------------------------------------------------- authored hostile creatures (#722)

BEAR_PALETTE = {"fur": (0.34, 0.23, 0.15), "dark": (0.2, 0.13, 0.09), "muzzle": (0.5, 0.38, 0.27), "nose": (0.05, 0.04, 0.04),
                "claw": (0.86, 0.82, 0.72), "mouth": (0.45, 0.13, 0.13), "eye": (0.03, 0.02, 0.02)}
BEAR_LEGS = (("FL", 0.36, 1), ("FR", 0.36, -1), ("HL", -0.48, 1), ("HR", -0.48, -1))


def build_bear(collection):
    hip, knee = 0.78, 0.42
    bones = [("Body", (-0.62, 0, 0.85), (0.42, 0, 0.95), None), ("Head", (0.5, 0, 0.95), (1.0, 0, 0.82), "Body"),
             ("Jaw", (0.8, 0, 0.78), (1.04, 0, 0.72), "Head"), ("Tail", (-0.78, 0, 0.86), (-0.86, 0, 0.78), "Body")]
    for leg, x, s in BEAR_LEGS:
        bones += [(f"Leg{leg}", (x, s * 0.2, hip), (x, s * 0.2, knee), "Body"), (f"Shin{leg}", (x, s * 0.2, knee), (x, s * 0.2, 0.0), f"Leg{leg}")]
    r = Rig("Bear", BEAR_PALETTE, bones)
    r.ellipsoid("Body", "fur", (-0.12, 0, 0.8), (0.62, 0.35, 0.36), segments=12, rings=7)
    r.ellipsoid("Body", "fur", (0.28, 0, 0.9), (0.36, 0.33, 0.38), segments=10, rings=6)  # shoulder hump
    r.ellipsoid("Body", "fur", (-0.5, 0, 0.82), (0.3, 0.32, 0.34), segments=10, rings=6)
    r.ellipsoid("Head", "fur", (0.72, 0, 0.92), (0.22, 0.2, 0.19), segments=10, rings=6)
    r.tube("Head", "muzzle", (0.84, 0, 0.86), (1.06, 0, 0.82), 0.11, 0.075, 8)
    r.ellipsoid("Head", "nose", (1.07, 0, 0.83), (0.035, 0.045, 0.03), segments=6, rings=3)
    r.ellipsoid("Head", "mouth", (0.93, 0, 0.775), (0.11, 0.06, 0.03), segments=6, rings=3)
    r.tube("Jaw", "muzzle", (0.8, 0, 0.77), (1.03, 0, 0.745), 0.075, 0.05, 7)
    r.ellipsoid("Tail", "dark", (-0.8, 0, 0.84), (0.06, 0.05, 0.06), segments=6, rings=3)
    for s in (1, -1):
        r.ellipsoid("Head", "dark", (0.66, s * 0.14, 1.08), (0.045, 0.03, 0.05), segments=6, rings=3)
        r.ellipsoid("Head", "eye", (0.87, s * 0.1, 0.95), (0.018, 0.014, 0.018), segments=5, rings=3)
        r.tube("Head", "claw", (1.02, s * 0.04, 0.81), (1.02, s * 0.04, 0.765), 0.012, 0.003, 4)  # upper canines
        r.tube("Jaw", "claw", (1.0, s * 0.035, 0.755), (1.0, s * 0.035, 0.795), 0.011, 0.003, 4)
    for leg, x, s in BEAR_LEGS:
        y = s * 0.2
        r.tube(f"Leg{leg}", "fur", (x, y, hip + 0.12), (x, y, knee - 0.02), 0.17, 0.13, 8)
        r.tube(f"Shin{leg}", "dark", (x, y, knee + 0.02), (x, y, 0.05), 0.12, 0.105, 7)
        r.ellipsoid(f"Shin{leg}", "dark", (x + 0.05, y, 0.045), (0.12, 0.09, 0.045), segments=7, rings=3)
        if leg[0] == "F":
            for o in (-0.05, 0.0, 0.05):
                r.tube(f"Shin{leg}", "claw", (x + 0.14, y + o, 0.04), (x + 0.2, y + o, 0.004), 0.012, 0.003, 4)
    return r.finish(collection)


SPIDER_PALETTE = {"body": (0.17, 0.13, 0.1), "dark": (0.07, 0.06, 0.05), "band": (0.42, 0.33, 0.22), "mark": (0.62, 0.5, 0.32),
                  "eye": (0.7, 0.1, 0.07), "fang": (0.1, 0.08, 0.07)}
# Per leg pair, front to back: degrees from forward, attachment x, horizontal reach to the foot, knee height. The first and
# last pairs are the longest and reach fore and aft, so the spider stays longer than it is wide.
SPIDER_LEGS = ((25, 0.13, 0.7, 0.42), (55, 0.07, 0.42, 0.36), (115, 0.01, 0.42, 0.36), (152, -0.05, 0.66, 0.4))
SPIDER_HEAD = Vector((-0.08, 0, 0.22))  # the Body bone's head, its pivot


def spider_rest():
    """Leg name (L1..L4, R1..R4) -> (unit direction, attachment, knee, foot) at rest."""
    legs = {}
    for i, (angle, x, reach, knee) in enumerate(SPIDER_LEGS, 1):
        a = math.radians(angle)
        for side, s in (("L", 1), ("R", -1)):
            d = Vector((math.cos(a), s * math.sin(a), 0))
            attach = Vector((x, s * 0.07, 0.2))
            legs[f"{side}{i}"] = (d, attach, attach + d * reach * 0.4 + Vector((0, 0, knee - 0.2)), Vector((x, s * 0.07, 0)) + d * reach)
    return legs


SPIDER_REST = spider_rest()


def build_spider(collection):
    bones = [("Body", tuple(SPIDER_HEAD), (0.18, 0, 0.22), None), ("Abdomen", (-0.08, 0, 0.24), (-0.46, 0, 0.3), "Body"),
             ("FangL", (0.17, 0.035, 0.17), (0.19, 0.035, 0.07), "Body"), ("FangR", (0.17, -0.035, 0.17), (0.19, -0.035, 0.07), "Body")]
    for leg, (_, attach, knee, foot) in SPIDER_REST.items():
        bones += [(f"Leg{leg}", tuple(attach), tuple(knee), "Body"), (f"Shin{leg}", tuple(knee), tuple(foot), f"Leg{leg}")]
    r = Rig("Spider", SPIDER_PALETTE, bones)
    r.ellipsoid("Body", "body", (0.05, 0, 0.2), (0.14, 0.11, 0.075), segments=10, rings=6)  # cephalothorax
    r.ellipsoid("Abdomen", "body", (-0.27, 0, 0.27), (0.2, 0.16, 0.15), rotation=(0, 0.15, 0), segments=12, rings=7)
    r.ellipsoid("Abdomen", "mark", (-0.22, 0, 0.41), (0.13, 0.035, 0.02), rotation=(0, 0.15, 0), segments=6, rings=3)
    for x, z in ((-0.15, 0.4), (-0.25, 0.415), (-0.35, 0.39)):
        for s in (1, -1):
            r.ellipsoid("Abdomen", "mark", (x, s * 0.07, z - 0.015), (0.035, 0.022, 0.018), rotation=(0, 0.15, s * 0.5), segments=5, rings=3)
    for s in (1, -1):
        r.ellipsoid("Body", "eye", (0.17, s * 0.032, 0.245), (0.02, 0.018, 0.018), segments=6, rings=3)
        r.ellipsoid("Body", "eye", (0.14, s * 0.06, 0.262), (0.012, 0.011, 0.011), segments=5, rings=3)
        r.ellipsoid("Body", "dark", (0.17, s * 0.035, 0.17), (0.035, 0.028, 0.04), segments=6, rings=3)  # chelicera
        r.tube("Body", "band", (0.16, s * 0.065, 0.17), (0.24, s * 0.085, 0.09), 0.014, 0.01, 5)  # pedipalp
        fang = "FangL" if s > 0 else "FangR"
        r.tube(fang, "fang", (0.175, s * 0.035, 0.15), (0.195, s * 0.03, 0.07), 0.022, 0.004, 5)
    for leg, (_, attach, knee, foot) in SPIDER_REST.items():
        r.tube(f"Leg{leg}", "body", tuple(attach), tuple(knee), 0.032, 0.025, 5)
        r.ellipsoid(f"Shin{leg}", "band", tuple(knee), (0.032, 0.032, 0.032), segments=6, rings=3)
        r.tube(f"Shin{leg}", "dark", tuple(knee), tuple(foot), 0.025, 0.009, 5)
        r.tube(f"Shin{leg}", "band", tuple(knee.lerp(foot, 0.45)), tuple(knee.lerp(foot, 0.55)), 0.024, 0.021, 5)
    return r.finish(collection)


LURKER_PALETTE = {"back": (0.25, 0.3, 0.17), "dark": (0.12, 0.15, 0.09), "belly": (0.78, 0.45, 0.16), "eye": (0.86, 0.74, 0.2),
                  "pupil": (0.02, 0.02, 0.02), "mouth": (0.62, 0.27, 0.26), "tooth": (0.9, 0.88, 0.8)}
# Per sprawled leg: shoulder or hip x, elbow or knee x, foot x, side.
LURKER_LEGS = (("FL", 0.18, 0.2, 0.24, 1), ("FR", 0.18, 0.2, 0.24, -1), ("HL", -0.17, -0.2, -0.24, 1), ("HR", -0.17, -0.2, -0.24, -1))


def build_lurker(collection):
    bones = [("Body", (-0.22, 0, 0.2), (0.22, 0, 0.2), None), ("Head", (0.28, 0, 0.21), (0.62, 0, 0.19), "Body"),
             ("Jaw", (0.34, 0, 0.16), (0.6, 0, 0.13), "Head"), ("Tail1", (-0.24, 0, 0.2), (-0.46, 0, 0.18), "Body"),
             ("Tail2", (-0.46, 0, 0.18), (-0.66, 0, 0.15), "Tail1"), ("Tail3", (-0.66, 0, 0.15), (-0.86, 0, 0.12), "Tail2")]
    for leg, x0, x1, x2, s in LURKER_LEGS:
        bones += [(f"Leg{leg}", (x0, s * 0.12, 0.17), (x1, s * 0.3, 0.15), "Body"), (f"Shin{leg}", (x1, s * 0.3, 0.15), (x2, s * 0.32, 0.0), f"Leg{leg}")]
    r = Rig("MarshLurker", LURKER_PALETTE, bones)
    r.ellipsoid("Body", "back", (0, 0, 0.185), (0.3, 0.15, 0.085), segments=12, rings=7)
    r.ellipsoid("Body", "belly", (0, 0, 0.14), (0.27, 0.13, 0.055), segments=10, rings=5)
    r.ellipsoid("Body", "back", (0.2, 0, 0.18), (0.13, 0.13, 0.075), segments=8, rings=5)
    r.ellipsoid("Body", "dark", (-0.05, 0, 0.265), (0.3, 0.02, 0.03), segments=8, rings=3)  # dorsal crest
    for x, y in ((0.1, 0.07), (-0.08, -0.08), (-0.15, 0.06), (0.02, -0.05)):
        r.ellipsoid("Body", "dark", (x, y, 0.255), (0.035, 0.025, 0.012), segments=5, rings=3)
    r.ellipsoid("Head", "back", (0.45, 0, 0.21), (0.18, 0.13, 0.055), segments=10, rings=5)
    r.ellipsoid("Head", "mouth", (0.47, 0, 0.17), (0.14, 0.1, 0.02), segments=8, rings=3)
    r.ellipsoid("Jaw", "back", (0.47, 0, 0.145), (0.15, 0.115, 0.032), segments=10, rings=4)
    r.ellipsoid("Jaw", "belly", (0.42, 0, 0.128), (0.11, 0.09, 0.018), segments=8, rings=3)  # pale throat
    for s in (1, -1):
        r.ellipsoid("Head", "eye", (0.4, s * 0.085, 0.255), (0.035, 0.03, 0.035), segments=6, rings=4)
        r.ellipsoid("Head", "pupil", (0.43, s * 0.095, 0.27), (0.012, 0.01, 0.016), segments=5, rings=3)
        for x in (0.52, 0.58):
            r.tube("Head", "tooth", (x, s * 0.07 * (1.6 - x * 1.4), 0.175), (x, s * 0.07 * (1.6 - x * 1.4), 0.15), 0.008, 0.002, 4)
            r.tube("Jaw", "tooth", (x - 0.02, s * 0.065 * (1.6 - x * 1.4), 0.15), (x - 0.02, s * 0.065 * (1.6 - x * 1.4), 0.172), 0.007, 0.002, 4)
    for bone, centre, radii in (("Tail1", (-0.35, 0, 0.19), (0.14, 0.075, 0.075)), ("Tail2", (-0.56, 0, 0.165), (0.12, 0.05, 0.065)),
                                ("Tail3", (-0.77, 0, 0.135), (0.12, 0.028, 0.05))):
        r.ellipsoid(bone, "back", centre, radii, segments=8, rings=5)
        r.ellipsoid(bone, "dark", (centre[0], 0, centre[2] + radii[2] * 0.85), (radii[0] * 0.9, 0.012, radii[2] * 0.45), segments=6, rings=3)  # fin
    for leg, x0, x1, x2, s in LURKER_LEGS:
        r.tube(f"Leg{leg}", "back", (x0, s * 0.1, 0.17), (x1, s * 0.3, 0.15), 0.04, 0.03, 6)
        r.tube(f"Shin{leg}", "back", (x1, s * 0.3, 0.15), (x2, s * 0.32, 0.012), 0.03, 0.024, 6)
        r.ellipsoid(f"Shin{leg}", "dark", (x2 + 0.03, s * 0.33, 0.012), (0.055, 0.045, 0.012), segments=6, rings=3)
    return r.finish(collection)


# ---------------------------------------------------------------- authored birds

BIRD_SPECS = {
    # body: centre z, radii, pitch (rad; positive lifts the breast). Distances in metres before the height normalisation.
    "crow": {
        "palette": {"body": (0.09, 0.09, 0.11), "back": (0.06, 0.06, 0.08), "head": (0.09, 0.09, 0.11), "beak": (0.12, 0.12, 0.13), "leg": (0.1, 0.1, 0.11), "eye": (0.02, 0.02, 0.02)},
        "body": (0.15, (0.12, 0.065, 0.07), -0.35), "hip": 0.12, "neck": ((0.08, 0.19), (0.11, 0.24), 0.04), "head": ((0.12, 0.25), 0.045),
        "beak": (0.065, 0.017, 0.15), "tail": ((-0.1, 0.13), (-0.24, 0.1), 0.045), "wing": (0.06, 0.05, 0.19, 0.28, 0.08), "feet": 0.03,
    },
    "songbird": {
        "palette": {"body": (0.5, 0.4, 0.3), "back": (0.4, 0.3, 0.2), "head": (0.42, 0.31, 0.21), "beak": (0.2, 0.17, 0.13), "leg": (0.35, 0.28, 0.22), "eye": (0.02, 0.02, 0.02), "chest": (0.88, 0.45, 0.2)},
        "body": (0.075, (0.055, 0.04, 0.045), -0.25), "hip": 0.06, "neck": ((0.035, 0.095), (0.045, 0.115), 0.028), "head": ((0.05, 0.12), 0.03),
        "beak": (0.022, 0.007, 0.1), "tail": ((-0.04, 0.07), (-0.11, 0.07), 0.025), "wing": (0.025, 0.033, 0.088, 0.11, 0.04), "feet": 0.012,
    },
    "duck": {
        "palette": {"body": (0.62, 0.6, 0.56), "back": (0.4, 0.33, 0.25), "head": (0.12, 0.33, 0.18), "beak": (0.85, 0.72, 0.2), "leg": (0.9, 0.5, 0.15), "eye": (0.02, 0.02, 0.02),
                    "chest": (0.4, 0.2, 0.12), "ring": (0.92, 0.92, 0.9)},
        "body": (0.15, (0.17, 0.09, 0.095), -0.05), "hip": 0.1, "neck": ((0.11, 0.2), (0.14, 0.29), 0.04), "head": ((0.15, 0.3), 0.05),
        "beak": (0.06, 0.02, 0.15), "tail": ((-0.14, 0.17), (-0.21, 0.19), 0.05), "wing": (0.06, 0.07, 0.2, 0.27, 0.085), "feet": 0.04,
    },
    "heron": {
        "palette": {"body": (0.66, 0.67, 0.69), "back": (0.46, 0.48, 0.51), "head": (0.9, 0.9, 0.88), "beak": (0.85, 0.7, 0.3), "leg": (0.55, 0.47, 0.32), "eye": (0.9, 0.8, 0.2),
                    "crest": (0.08, 0.08, 0.1)},
        "body": (0.6, (0.21, 0.08, 0.095), -0.3), "hip": 0.57, "neck": ((0.13, 0.64), (0.18, 0.86), 0.03), "head": ((0.2, 0.88), 0.034),
        "beak": (0.15, 0.014, 0.08), "tail": ((-0.17, 0.56), (-0.29, 0.51), 0.05), "wing": (0.1, 0.05, 0.665, 0.42, 0.12), "feet": 0.07,
    },
}


def build_bird(animal, collection):
    spec = BIRD_SPECS[animal]
    bz, (rx, ry, rz), pitch = spec["body"]
    (n0x, n0z), (n1x, n1z), nr = spec["neck"]
    (hx, hz), hr = spec["head"]
    bl, br, droop = spec["beak"]
    (t0x, t0z), (t1x, t1z), tw = spec["tail"]
    wx, wy, wz, wl, wc = spec["wing"]
    hip, feet = spec["hip"], spec["feet"]
    legy = ry * 0.45
    bones = [("Body", (-rx, 0, bz), (rx, 0, bz), None), ("Neck", (n0x, 0, n0z), (n1x, 0, n1z), "Body"),
             ("Head", (n1x, 0, n1z), (hx + hr, 0, hz), "Neck"), ("Tail", (t0x, 0, t0z), (t1x, 0, t1z), "Body"),
             ("WingL", (wx, wy, wz), (wx - wl, wy, wz), "Body"), ("WingR", (wx, -wy, wz), (wx - wl, -wy, wz), "Body"),
             ("LegL", (0.0, legy, hip), (0.0, legy, 0.0), "Body"), ("LegR", (0.0, -legy, hip), (0.0, -legy, 0.0), "Body")]
    r = Rig(animal.capitalize(), spec["palette"], bones)
    p = spec["palette"]
    r.ellipsoid("Body", "body", (0, 0, bz), (rx, ry, rz), rotation=(0, pitch, 0), segments=10, rings=6)
    if "chest" in p:
        r.ellipsoid("Body", "chest", (rx * 0.55, 0, bz + rz * 0.15), (rx * 0.45, ry * 0.85, rz * 0.8), segments=8, rings=5)
    r.tube("Neck", "body" if animal == "heron" else "head", (n0x, 0, n0z), (n1x, 0, n1z), nr * 1.15, nr, 6)
    if "ring" in p:
        r.tube("Neck", "ring", (n0x + (n1x - n0x) * 0.3, 0, n0z + (n1z - n0z) * 0.3), (n0x + (n1x - n0x) * 0.42, 0, n0z + (n1z - n0z) * 0.42), nr * 1.12, nr * 1.08, 6)
    r.ellipsoid("Head", "head", (hx, 0, hz), (hr * 1.15, hr * 0.85, hr), segments=8, rings=5)
    if "crest" in p:
        r.tube("Head", "crest", (hx - hr * 0.2, 0, hz + hr * 0.6), (hx - hr * 3.2, 0, hz + hr * 0.1), 0.008, 0.002, 4)
    tip = Vector((hx + hr + bl * math.cos(droop), 0, hz - hr * 0.15 - bl * math.sin(droop)))
    if animal == "duck":
        r.ellipsoid("Head", "beak", ((hx + hr * 0.8 + tip.x) / 2, 0, hz - hr * 0.3), (bl / 2 + hr * 0.1, br * 1.4, br * 0.55), rotation=(0, droop, 0), segments=6, rings=3)
    else:
        r.tube("Head", "beak", (hx + hr * 0.8, 0, hz - hr * 0.15), tuple(tip), br, br * 0.15, 5)
    for s in (1, -1):
        r.ellipsoid("Head", "eye", (hx + hr * 0.55, s * hr * 0.6, hz + hr * 0.2), (hr * 0.17, hr * 0.12, hr * 0.17), segments=5, rings=3)
    # A flat fan from the rump to the tip (an ellipsoid's +X end dips by sin of a positive Y turn, hence the minus).
    r.ellipsoid("Tail", "back", ((t0x + t1x) / 2, 0, (t0z + t1z) / 2), (abs(t1x - t0x) / 2 + 0.01, tw, tw * 0.3),
                rotation=(0, -math.atan2(t0z - t1z, t0x - t1x), 0), segments=6, rings=3)
    for s, wing in ((1, "WingL"), (-1, "WingR")):
        # Folded wings lie along the back at the body's pitch, rolled down over the flank; Fly unrolls them flat and
        # sweeps them out. ``along`` places a point that far behind the shoulder on the pitched line.
        along = lambda d: wz + d * math.sin(pitch)
        r.ellipsoid(wing, "back", (wx - wl * 0.42, s * wy, along(wl * 0.42)), (wl * 0.48, wc / 2, wc * 0.12), rotation=(-s * 0.6, pitch, 0), segments=8, rings=4)
        r.ellipsoid(wing, "back", (wx - wl * 0.82, s * wy * 0.9, along(wl * 0.82) - wc * 0.05), (wl * 0.25, wc * 0.3, wc * 0.08), rotation=(-s * 0.6, pitch, 0), segments=6, rings=3)
    for s, leg in ((1, "LegL"), (-1, "LegR")):
        y = s * legy
        r.tube(leg, "leg", (0.0, y, hip), (0.0, y, 0.005), max(feet * 0.14, 0.004), max(feet * 0.1, 0.003), 5)
        if animal == "duck":
            r.ellipsoid(leg, "leg", (feet * 0.6, y, 0.006), (feet * 0.7, feet * 0.55, 0.006), segments=6, rings=3)
        else:
            for a in (-0.45, 0.0, 0.45):
                r.tube(leg, "leg", (0.0, y, 0.006), (feet * math.cos(a), y + feet * math.sin(a), 0.004), max(feet * 0.1, 0.003), max(feet * 0.06, 0.002), 4)
            r.tube(leg, "leg", (0.0, y, 0.006), (-feet * 0.6, y, 0.004), max(feet * 0.1, 0.003), max(feet * 0.06, 0.002), 4)
    return r.finish(collection)


# ---------------------------------------------------------------- authored clips

X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)


def rabbit_pose(clip, u):
    if clip == "Idle":
        twitch = 1.0 if (u % 0.25) < 0.06 else 0.0
        return {"Body": [("loc", (0, 0, 0.002 * wave(u, 2)))], "Head": [(Z, 18 * wave(u, 1, 0.1)), (Y, 4 * twitch)],
                "EarL": [(X, 8 * wave(u, 3)), (Y, -6 * twitch)], "EarR": [(X, -8 * wave(u, 3, 0.2)), (Y, -6 * twitch)]}
    if clip == "Walk":
        # One hop: push off with the hind feet, land on the fore paws.
        lift = max(0.0, wave(u, 1)) ** 1.5
        return {"Body": [("loc", (0, 0, 0.05 * lift)), (Y, -10 * wave(u, 1, 0.1))], "Head": [(Y, 8 * wave(u, 1, 0.15))],
                "HindL": [(Y, 45 * lift)], "HindR": [(Y, 45 * lift)], "ForeL": [(Y, -35 * lift)], "ForeR": [(Y, -35 * lift)],
                "EarL": [(Y, -12 * lift)], "EarR": [(Y, -12 * lift)]}
    chew = wave(u, 8)
    return {"Body": [(Y, 12)], "Head": [(Y, 35 + 3 * chew)], "ForeL": [(Y, -12)], "ForeR": [(Y, -12)],
            "EarL": [(Y, -10), (X, 6 * wave(u, 2))], "EarR": [(Y, -10), (X, -6 * wave(u, 2, 0.3))]}


def quad_gait(pose, u, legs, swing_deg, knee_deg, prefix=("Leg", "Shin")):
    for leg, phase in zip(legs, (0.0, 0.25, 0.5, 0.75)):
        pose[f"{prefix[0]}{leg}"] = [(Y, -swing_deg * wave(u, 1, phase))]
        pose[f"{prefix[1]}{leg}"] = [(Y, knee_deg * max(0.0, wave(u, 1, phase + 0.25)))]
    return pose


BOAR_PIVOT, BOAR_HIP, BOAR_THIGH, BOAR_SHIN = (-0.45, 0.55), 0.42, 0.22, 0.2  # the Body bone's head (x, z); the leg bones


def boar_hips(loc, pitch):
    """Where each hip (x, z) is once the Body moves by ``loc`` (x, z) and pitches ``pitch`` degrees about its head."""
    a = math.radians(pitch)
    px, pz = BOAR_PIVOT
    hips = {}
    for leg, x, _ in BOAR_LEGS:
        dx, dz = x - px, BOAR_HIP - pz
        hips[leg] = (px + loc[0] + dx * math.cos(a) + dz * math.sin(a), pz + loc[1] - dx * math.sin(a) + dz * math.cos(a))
    return hips


def boar_legs(pose, hips, pitch, feet):
    """Two-bone legs from each hip to its foot (x, z on the ground plane's side view), the knee forward of the line,
    as ``Leg``/``Shin`` rotations about Y under the Body's ``pitch``. A foot out of reach ends a straight leg."""
    def towards(dx, dz):  # the angle about Y that turns a leg hanging straight down onto (dx, dz)
        return math.degrees(math.atan2(-dx, -dz))

    for leg, (fx, fz) in feet.items():
        hx, hz = hips[leg]
        d = min(max(math.hypot(fx - hx, fz - hz), 0.05), BOAR_THIGH + BOAR_SHIN - 1e-4)
        bend = math.degrees(math.acos((BOAR_THIGH ** 2 + d ** 2 - BOAR_SHIN ** 2) / (2 * BOAR_THIGH * d)))
        thigh = towards(fx - hx, fz - hz) - bend
        t = math.radians(thigh)
        kx, kz = hx - BOAR_THIGH * math.sin(t), hz - BOAR_THIGH * math.cos(t)
        pose[f"Leg{leg}"] = [(Y, thigh - pitch)]
        pose[f"Shin{leg}"] = [(Y, towards(fx - kx, fz - kz) - thigh)]
    return pose


def boar_pose(clip, u):
    if clip == "Idle":
        return {"Body": [("loc", (0, 0, 0.004 * wave(u, 2)))], "Head": [(Z, 10 * wave(u, 1, 0.1)), (Y, 4 * wave(u, 2))],
                "Tail": [(X, 30 * wave(u, 4))]}
    if clip == "Walk":
        pose = {"Body": [("loc", (0, 0, 0.012 * abs(wave(u, 1)))), (X, 1.5 * wave(u, 1))], "Head": [(Y, 3 * wave(u, 2, 0.25))],
                "Tail": [(X, 20 * wave(u, 2))]}
        return quad_gait(pose, u, ("HL", "FL", "HR", "FR"), 22, 30)
    if clip == "Eat":
        # Rooting, snout ploughing the ground in short shoves.
        shove = max(0.0, wave(u, 3)) ** 2
        return {"Body": [(Y, 6), ("loc", (0, 0, -0.02))], "Head": [(Y, 28 + 8 * shove), (Z, 6 * wave(u, 1.5))],
                "LegFL": [(Y, -8)], "LegFR": [(Y, -8)], "Tail": [(X, 25 * wave(u, 6))]}
    return boar_combat(clip, u)


def boar_combat(clip, u):
    if clip == "Run":
        # A bounding gallop: the hind pair then the fore pair, the back rocking over them.
        pose = {"Body": [("loc", (0, 0, 0.04 * max(0.0, wave(u, 1, 0.1)))), (Y, 5 * wave(u, 1))], "Head": [(Y, -5 * wave(u, 1, 0.25))],
                "Tail": [(Y, -40), (X, 15 * wave(u, 2))]}
        for leg, phase in (("HL", 0.0), ("HR", 0.08), ("FL", 0.5), ("FR", 0.58)):
            pose[f"Leg{leg}"] = [(Y, -38 * wave(u, 1, phase))]
            pose[f"Shin{leg}"] = [(Y, 45 * max(0.0, wave(u, 1, phase + 0.25)))]
        return pose
    if clip == "Attack_A":
        # Tusk gore (#736): the head drops and the weight sinks back onto the haunches, then the boar drives off its
        # planted hind feet and rears, forelegs tucked under the chest, as the head rips upward (lands at 9/20); the
        # forefeet come down a stride ahead and step back under the shoulders. The legs are solved to their feet.
        k = lambda *keys: curve(u, (0, 0), *keys, (1, 0))
        loc = (k((0.3, -0.05), (0.45, 0.06), (0.6, 0.05)), k((0.3, -0.03), (0.45, -0.04), (0.6, -0.03)))
        pitch = k((0.3, 4), (0.45, -12), (0.6, -6))
        pose = {"Body": [("loc", (loc[0], 0, loc[1])), (Y, pitch)],
                "Head": [(Y, k((0.3, 32), (0.45, -38), (0.6, -30))), (X, k((0.45, 12), (0.6, 8)))],
                "Tail": [(Y, k((0.2, -50), (0.7, -50)))]}
        hips = boar_hips(loc, pitch)
        rear = curve(u, (0.28, 0), (0.4, 1), (0.6, 1), (0.72, 0))
        step = curve(u, (0.3, 0), (0.62, 0.1), (0.78, 0.1), (0.94, 0))
        lift = 0.05 * curve(u, (0.78, 0), (0.86, 1), (0.94, 0))
        feet = {}
        for leg, x, _ in BOAR_LEGS:
            if leg[0] == "H":
                feet[leg] = (x, 0.0)
            else:
                # Tucked: the forefoot drawn up and back under the rising shoulder, the knee forward.
                hx, hz = hips[leg]
                planted = (x + step, lift)
                feet[leg] = (planted[0] + (hx - 0.04 - planted[0]) * rear, planted[1] + (hz - 0.27 - planted[1]) * rear)
        return boar_legs(pose, hips, pitch, feet)
    if clip == "Attack_B":
        # Charge and toss: head down, a stamp of the forefoot, a short charge, then a full toss of the head (15/24).
        k = lambda *keys: curve(u, (0, 0), *keys, (1, 0))
        stamp = curve(u, (0.05, 0), (0.12, 1), (0.18, 0), (0.24, 1), (0.3, 0))
        stride = wave(u, 4) * curve(u, (0.3, 0), (0.35, 1), (0.55, 1), (0.62, 0))
        pose = {"Body": [("loc", (k((0.3, -0.06), (0.55, 0.16), (0.65, 0.2), (0.8, 0.12)), 0, k((0.55, 0.01), (0.65, 0.05), (0.75, 0.02)))),
                         (Y, k((0.55, 0), (0.65, -14), (0.8, -6)))],
                "Head": [(Y, k((0.25, 38), (0.55, 40), (0.65, -48), (0.8, -30))), (X, k((0.65, -14), (0.8, -6)))],
                "Tail": [(Y, k((0.2, -55), (0.85, -55)))]}
        for leg, sign in (("FL", 1), ("FR", -1), ("HL", -1), ("HR", 1)):
            pose[f"Leg{leg}"] = [(Y, -30 * stride * sign + (-35 * stamp if leg == "FR" else 0))]
        pose["ShinFR"] = [(Y, 50 * stamp)]
        return pose
    if clip == "Hit":
        jolt = curve(u, (0, 0), (0.25, 1), (1, 0))
        return {"Body": [("loc", (-0.05 * jolt, 0, 0.015 * jolt)), (X, 7 * jolt)], "Head": [(Y, -18 * jolt), (Z, 12 * jolt)], "Tail": [(Y, -30 * jolt)]}
    if clip == "Death":
        # Stagger, the forelegs buckle, a heavy roll onto the right side; ends lying still with the legs out.
        fall = curve(u, (0.25, 0), (0.6, 1))
        settle = curve(u, (0.6, 0), (0.68, 1), (0.76, 0))
        buckle = curve(u, (0.1, 0), (0.35, 1), (0.6, 0.3))
        # The body rolls about its spine, 0.55 m up: sink it by the lower of its hooves and its flank, so neither dips.
        roll = math.radians(90 * fall)
        lowest = min(0.55 - 0.12 * math.sin(roll) - 0.55 * math.cos(roll), 0.55 - math.hypot(0.21 * math.sin(roll), 0.27 * math.cos(roll)))
        pose = {"Body": [("loc", (0, 0, -lowest + 0.02 * settle)), (X, 90 * fall - 4 * settle)],
                "Head": [(Y, curve(u, (0, 0), (0.15, -25), (0.5, 10), (0.8, 25))), (Z, curve(u, (0.1, 0), (0.25, 15), (0.5, 0)))],
                "Tail": [(Y, curve(u, (0, 0), (0.6, -10), (1, 0)))]}
        for leg in ("FL", "FR"):
            pose[f"Leg{leg}"] = [(Y, 35 * buckle)]
            pose[f"Shin{leg}"] = [(Y, -40 * buckle + 20 * fall)]
        for leg in ("HL", "HR"):
            pose[f"Leg{leg}"] = [(Y, -15 * fall)]
            pose[f"Shin{leg}"] = [(Y, 15 * fall)]
        return pose
    # Alert: head up with a huff and a shake of the tusks, a stamp of the forefoot, bristles up.
    up = curve(u, (0, 0), (0.2, 1), (0.8, 1), (1, 0))
    shake = math.sin(2 * math.pi * 3 * u) * curve(u, (0.2, 0), (0.3, 1), (0.55, 1), (0.65, 0))
    stamp = curve(u, (0.55, 0), (0.65, 1), (0.75, 0))
    return {"Body": [("loc", (0, 0, 0.012 * up)), (Y, -3 * up)], "Head": [(Y, -18 * up), (Z, 16 * shake)],
            "LegFR": [(Y, -30 * stamp)], "ShinFR": [(Y, 45 * stamp)], "Tail": [(Y, -60 * up)]}


def bear_pose(clip, u):
    t = u * CLIP_FRAMES["bear"][clip]
    if clip == "Idle":
        sniff = curve(u, (0.5, 0), (0.58, 1), (0.75, 1), (0.83, 0))
        return {"Body": [("loc", (0, 0, 0.006 * wave(u, 2)))], "Head": [(Z, 12 * wave(u, 1, 0.1) * (1 - sniff)), (Y, -14 * sniff + 3 * wave(u, 2))],
                "Jaw": [(Y, 3 * sniff * max(0.0, wave(u, 16)))]}
    if clip == "Walk":
        pose = {"Body": [("loc", (0, 0, 0.015 * abs(wave(u, 1)))), (X, 3 * wave(u, 1))], "Head": [(Z, 5 * wave(u, 1)), (Y, 4 * wave(u, 2, 0.25))]}
        return quad_gait(pose, u, ("HL", "FL", "HR", "FR"), 20, 30)
    if clip == "Eat":
        # Forages: snout down, one forepaw raking the ground, the jaw working.
        rake = max(0.0, wave(u, 2))
        return {"Body": [(Y, 2), ("loc", (0, 0, -0.01))], "Head": [(Y, 36 + 5 * wave(u, 4)), (Z, 8 * wave(u, 1))],
                "Jaw": [(Y, 8 * max(0.0, wave(u, 4)))], "LegFL": [(Y, -8)], "LegFR": [(Y, -8 - 28 * rake)], "ShinFR": [(Y, 35 * rake)]}
    if clip == "Run":
        # A heavy bounding gallop, the hump rolling over the forelegs.
        pose = {"Body": [("loc", (0, 0, 0.06 * max(0.0, wave(u, 1, 0.1)))), (Y, 7 * wave(u, 1))], "Head": [(Y, -6 * wave(u, 1, 0.25))]}
        for leg, phase in (("HL", 0.0), ("HR", 0.08), ("FL", 0.5), ("FR", 0.58)):
            pose[f"Leg{leg}"] = [(Y, -40 * wave(u, 1, phase))]
            pose[f"Shin{leg}"] = [(Y, 50 * max(0.0, wave(u, 1, phase + 0.25)))]
        return pose
    if clip == "Attack_A":
        # Paw swipe: the weight rocks back and right while the right forepaw rises and cocks out, then the paw rakes across
        # and down as the body twists in (lands at 11/22), the jaw open in a roar.
        k = lambda *keys: curve(t, (0, 0), *keys, (22, 0))
        return {"Body": [("loc", (k((7, -0.06), (11, 0.12), (14, 0.1)), 0, k((7, 0.03), (11, -0.02)))), (Z, k((7, -10), (11, 12), (14, 9))), (Y, k((7, -9), (11, 0)))],
                "Head": [(Z, k((7, -12), (11, 16), (14, 12))), (Y, k((7, -6), (11, 10), (14, 6)))], "Jaw": [(Y, k((5, 10), (9, 30), (13, 28), (16, 0)))],
                "LegFR": [(Y, k((7, -100), (11, -55), (13, -30), (16, -5))), (X, k((7, -40), (11, 18), (13, 25), (16, 0)))],
                "ShinFR": [(Y, k((7, 55), (10, -15), (13, 10), (16, 0)))],
                "LegFL": [(Y, k((7, 8), (11, -10))), (X, k((11, 6)))], "LegHL": [(Y, k((7, 10), (11, -12)))], "LegHR": [(Y, k((7, 10), (11, -12)))]}
    if clip == "Attack_B":
        # Rear-up double slam: a dip, the bear rears onto its hind legs and roars with its forepaws up, then slams both down
        # together as it lunges (lands at 20/34). The hind legs stay upright under the rearing body.
        k = lambda *keys: curve(t, (0, 0), *keys, (34, 0))
        pitch = k((3, 0), (11, -50), (15, -54), (19, 2), (20, 2), (24, 1))
        x = k((15, 0), (20, 0.26), (24, 0.24))
        sink = 0.14 * math.sin(math.radians(max(0.0, -pitch)))
        pose = {"Body": [("loc", (x, 0, k((3, -0.04), (8, 0)) - sink - 0.02 * curve(t, (18, 0), (20, 1), (24, 0)))), (Y, pitch)],
                "Head": [(Y, k((11, 32), (15, 36), (18, 8), (20, 6), (24, 0)))], "Jaw": [(Y, k((8, 0), (11, 34), (15, 34), (18, 8), (20, 24), (24, 0)))],
                "Tail": [(Y, k((11, -30)))]}
        for leg in ("FL", "FR"):
            pose[f"Leg{leg}"] = [(Y, k((3, 0), (11, -40), (15, -48), (18, -30), (20, -6), (24, 0)))]
            pose[f"Shin{leg}"] = [(Y, k((4, 0), (11, 70), (15, 80), (18, 20), (20, -6), (23, 0)))]
        for leg in ("HL", "HR"):
            pose[f"Leg{leg}"] = [(Y, -pitch + math.degrees(math.asin(x / 0.78)) + k((11, -12)))]
            pose[f"Shin{leg}"] = [(Y, k((11, 14)))]
        return pose
    if clip == "Hit":
        jolt = curve(t, (0, 0), (2, 1), (8, 0))
        return {"Body": [("loc", (-0.06 * jolt, 0, 0.02 * jolt)), (X, 5 * jolt), (Y, -4 * jolt)], "Head": [(Y, -20 * jolt), (Z, 14 * jolt)],
                "Jaw": [(Y, 18 * jolt)]}
    if clip == "Death":
        # Rears in pain, staggers, the forelegs buckle and the bear crashes onto its right side; ends lying still.
        fall = curve(t, (12, 0), (24, 1))
        settle = curve(t, (24, 0), (27, 1), (30, 0))
        rear = curve(t, (0, 0), (5, 1), (10, 0))
        buckle = curve(t, (8, 0), (14, 1), (24, 0.3))
        roll = math.radians(88 * fall)
        lowest = min(0.85 - 0.2 * math.sin(roll) - 0.82 * math.cos(roll), 0.85 - math.hypot(0.35 * math.sin(roll), 0.38 * math.cos(roll)))
        pose = {"Body": [("loc", (0, 0, -lowest + 0.09 * math.sin(2 * roll) + 0.02 * settle)), (Y, -18 * rear + 3 * buckle * (1 - fall)), (X, 88 * fall - 3 * settle)],
                "Head": [(Y, curve(t, (0, 0), (5, -30), (12, 12), (24, 25), (36, 20))), (Z, curve(t, (6, 0), (12, 18), (20, 0)))],
                "Jaw": [(Y, curve(t, (0, 0), (5, 32), (12, 10), (24, 6)))]}
        for leg in ("FL", "FR"):
            pose[f"Leg{leg}"] = [(Y, -30 * rear + 40 * buckle)]
            pose[f"Shin{leg}"] = [(Y, 40 * rear - 50 * buckle + 25 * fall)]
        for leg in ("HL", "HR"):
            pose[f"Leg{leg}"] = [(Y, 18 * rear - 15 * fall)]
            pose[f"Shin{leg}"] = [(Y, 15 * fall)]
        return pose
    # Alert: head up to sniff, then a low head and a bluff: two jaw-popping huffs with both forepaws slapping the ground.
    sniff = curve(t, (0, 0), (3, 1), (7, 1), (9, 0))
    low = curve(t, (7, 0), (10, 1), (20, 1), (24, 0))
    slap = curve(t, (9, 0), (11, 1), (12.5, 0), (14, 0), (16, 1), (17.5, 0))
    pop = curve(t, (11, 0), (12, 1), (13.5, 0), (16, 0), (17, 1), (18.5, 0))
    pose = {"Body": [("loc", (0.05 * slap, 0, 0.04 * slap)), (Y, -6 * slap)], "Head": [(Y, -22 * sniff + 18 * low), (Z, 10 * wave(t / 24, 2) * low)],
            "Jaw": [(Y, 4 * sniff * max(0.0, wave(t / 24, 20)) + 26 * pop)]}
    for leg in ("FL", "FR"):
        pose[f"Leg{leg}"] = [(Y, -35 * slap)]
        pose[f"Shin{leg}"] = [(Y, 40 * slap)]
    return pose


def spider_feet(pose, feet):
    """Plant each foot at its rest spot plus ``feet[leg]`` (metres) by a two-bone solve through the posed body, knees up."""
    q, offset = Quaternion(), Vector()
    for axis, value in pose.get("Body", ()):
        if axis == "loc":
            offset += Vector(value)
        else:
            q = Quaternion(Vector(axis), math.radians(value)) @ q
    for leg, (d, attach, knee, foot) in SPIDER_REST.items():
        hip = q @ (attach - SPIDER_HEAD) + SPIDER_HEAD + offset
        l1, l2 = (knee - attach).length, (foot - knee).length
        reach = foot + Vector(feet.get(leg, (0, 0, 0))) - hip
        dist = min(reach.length, (l1 + l2) * 0.999)
        along = reach.normalized()
        a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
        pole = Vector((0, 0, 1)) + d * 0.3
        pole = (pole - along * pole.dot(along)).normalized()
        bend = hip + along * a + pole * math.sqrt(max(0.0, l1 * l1 - a * a))
        q1 = (knee - attach).rotation_difference(q.inverted() @ (bend - hip))
        q2 = (foot - knee).rotation_difference((q @ q1).inverted() @ (hip + along * dist - bend))
        for bone, rotation in ((f"Leg{leg}", q1), (f"Shin{leg}", q2)):
            axis, angle = rotation.to_axis_angle()
            pose[bone] = [(tuple(axis), math.degrees(angle))]
    return pose


def spider_gait(u, stride, lift, cycles=1):
    """Alternating tetrapod: L1, R2, L3 and R4 step together, then the other four."""
    feet = {}
    for leg in SPIDER_REST:
        theta = 2 * math.pi * (cycles * u + (0.0 if (leg[0] == "L") == (int(leg[1]) % 2 == 1) else 0.5))
        feet[leg] = (-stride * math.cos(theta), 0, lift * max(0.0, math.sin(theta)))
    return feet


def fangs(spread, strike):
    """Fangs out to the sides by ``spread`` degrees and swung forward under the head by ``strike``."""
    return {"FangL": [(X, spread), (Y, -strike)], "FangR": [(X, -spread), (Y, -strike)]}


def spider_pose(clip, u):
    t = u * CLIP_FRAMES["spider"][clip]
    if clip == "Idle":
        tap = max(0.0, wave(u, 3)) ** 3
        pose = {"Body": [("loc", (0, 0, 0.006 * wave(u, 2))), (Z, 4 * wave(u, 1))], "Abdomen": [(Y, 4 * wave(u, 1, 0.3))], **fangs(6 * max(0.0, wave(u, 4)), 0)}
        return spider_feet(pose, {"L1": (0, 0, 0.05 * tap), "R1": (0, 0, 0.05 * max(0.0, wave(u, 3, 0.5)) ** 3)})
    if clip in ("Walk", "Run"):
        run = clip == "Run"
        pose = {"Body": [("loc", (0, 0, (-0.03 if run else 0) + 0.008 * wave(u, 2))), (X, 2 * wave(u, 1))], "Abdomen": [(Y, 5 * wave(u, 2, 0.2))]}
        return spider_feet(pose, spider_gait(u, 0.11 if run else 0.07, 0.08 if run else 0.06))
    if clip == "Eat":
        # Hunched over a kill: the forelegs hold it under the head, the fangs work in turn, the abdomen pulses.
        pose = {"Body": [("loc", (0, 0, -0.03)), (Y, 6)], "Abdomen": [(Y, 10 + 4 * wave(u, 2))],
                "FangL": [(Y, -18 * max(0.0, wave(u, 4)))], "FangR": [(Y, -18 * max(0.0, wave(u, 4, 0.5)))]}
        hold = {f"{side}1": (Vector((0.36, s * 0.07, 0.05)) - SPIDER_REST[f"{side}1"][3]).to_tuple() for side, s in (("L", 1), ("R", -1))}
        return spider_feet(pose, hold)
    if clip == "Attack_A":
        # Fang strike: rears with the forelegs high and the fangs spread, then drops and lunges, forelegs hooking down and
        # in, fangs driving under the head (lands at 9/18).
        k = lambda *keys: curve(t, (0, 0), *keys, (18, 0))
        pose = {"Body": [("loc", (k((6, -0.05), (9, 0.14), (11, 0.12)), 0, k((6, 0.06), (9, -0.04)))), (Y, k((6, -36), (9, 12), (11, 9)))],
                "Abdomen": [(Y, k((6, 16), (9, -8)))], **fangs(k((5, 32), (8, 32), (9, -4), (12, 0)), k((5, -22), (8, -10), (9, 38), (12, 28)))}
        feet = {}
        for side, s in (("L", 1), ("R", -1)):
            feet[f"{side}1"] = (k((6, -0.3), (9, 0.16), (11, 0.14)), s * k((6, 0.1), (9, -0.1), (11, -0.08)), k((6, 0.55), (8, 0.4), (9, 0.0)))
            feet[f"{side}2"] = (k((6, -0.08), (9, 0.08)), 0, k((6, 0.2), (9, 0.0)))
        return spider_feet(pose, feet)
    if clip == "Attack_B":
        # Leap: a deep crouch, a jump forward with the forelegs reaching, a landing that stabs down with the forelegs and
        # fangs (lands at 14/24), then a skitter back to the start.
        k = lambda *keys: curve(t, (0, 0), *keys, (24, 0))
        x = k((7, -0.04), (12, 0.3), (14, 0.32), (17, 0.3))
        z = k((5, -0.08), (8, -0.08), (11, 0.24), (14, -0.03), (16, 0))
        pose = {"Body": [("loc", (x, 0, z)), (Y, k((8, 6), (10, -14), (13, 10), (16, 0)))], "Abdomen": [(Y, k((8, -6), (11, 18), (14, -6), (17, 0)))],
                **fangs(k((9, 30), (13, 30), (14, -4), (17, 0)), k((9, -20), (13, -10), (14, 36), (18, 0)))}
        follow, air = curve(t, (8, 0), (10, 1)), max(0.0, z) * 0.85
        feet = {}
        for leg in SPIDER_REST:
            step = 0.045 * max(0.0, math.sin(2 * math.pi * ((t - 15) / 4 + (0.25 if leg in ("L1", "R2", "L3", "R4") else 0.75)))) if 15 <= t <= 23 else 0
            feet[leg] = (x * follow, 0, air + step)
            if leg[1] == "1":
                feet[leg] = (x * follow + k((9, 0), (11, 0.16), (14, 0.04), (17, 0)), 0, air + step + k((9, 0), (11, 0.14), (13, 0.06), (14, 0)))
        return spider_feet(pose, feet)
    if clip == "Hit":
        jolt = curve(t, (0, 0), (2, 1), (8, 0))
        pose = {"Body": [("loc", (-0.05 * jolt, 0, 0.02 * jolt)), (Y, -10 * jolt), (X, 6 * jolt)], "Abdomen": [(Y, 14 * jolt)], **fangs(24 * jolt, 0)}
        return spider_feet(pose, {f"{side}1": (-0.03 * jolt, 0, 0.12 * jolt) for side in "LR"})
    if clip == "Death":
        # Twitches, curls every leg in tight under itself, rolls onto its back and lies still, the curled legs up.
        raise_, curl = curve(t, (2, 0), (7, 1)), curve(t, (5, 0), (12, 1))
        flip = curve(t, (9, 0), (20, 1))
        settle = curve(t, (20, 0), (23, 1), (26, 0))
        twitch = math.sin(2 * math.pi * t / 3) * curve(t, (0, 0), (2, 1), (8, 0))
        roll = math.radians(180 * flip)
        pose = {"Body": [("loc", (0, 0, 0.1 * curl * (1 - flip) + 0.14 * math.sin(roll) - 0.05 * flip + 0.015 * settle)), (Y, 8 * twitch), (X, 180 * flip)],
                "Abdomen": [(Y, -12 * curl)], **fangs(10 * twitch + 15 * curl, 20 * curl)}
        for leg, (d, *_rest) in SPIDER_REST.items():
            lift = Vector(d).cross(Vector((0, 0, 1))).to_tuple()  # positive about this axis raises the leg
            pose[f"Leg{leg}"] = [(lift, 20 * abs(twitch) + 40 * raise_ - 125 * flip)]
            pose[f"Shin{leg}"] = [(lift, -45 * curl + 8 * settle)]
        return pose
    # Alert: rears into a threat display, forelegs raised high and spread, fangs flared, abdomen up, swaying.
    up = curve(t, (0, 0), (5, 1), (16, 1), (20, 0))
    sway = wave(t / 20, 2) * up
    pose = {"Body": [("loc", (0, 0, 0.03 * up)), (Y, -22 * up), (Z, 6 * sway)], "Abdomen": [(Y, 14 * up)], **fangs(30 * up, -10 * up)}
    feet = {}
    for side, s in (("L", 1), ("R", -1)):
        feet[f"{side}1"] = (-0.12 * up, s * 0.12 * up, (0.42 + 0.05 * sway * s) * up)
        feet[f"{side}2"] = (0, s * 0.04 * up, (0.14 + 0.04 * wave(t / 20, 3, 0.25 * s)) * up)
    return spider_feet(pose, feet)


def lurker_legs(pose, u, sweep, lift, cycles=1):
    """Sprawling diagonal gait: the upper leg sweeps about the vertical and lifts outward, the shin flexes with it."""
    for leg, phase in (("FL", 0.0), ("HR", 0.0), ("FR", 0.5), ("HL", 0.5)):
        s = 1 if leg[1] == "L" else -1
        theta = 2 * math.pi * (cycles * u + phase)
        up = max(0.0, math.sin(theta))
        pose[f"Leg{leg}"] = [(Z, s * sweep * math.cos(theta)), (X, s * lift * up)]
        pose[f"Shin{leg}"] = [(X, s * lift * 0.6 * up)]
    return pose


def lurker_spine(pose, u, bend, cycles=1):
    """A travelling side-to-side wave from the head down the tail."""
    pose.setdefault("Body", []).append((Z, bend * wave(u, cycles)))
    pose.setdefault("Head", []).append((Z, -1.2 * bend * wave(u, cycles)))
    for i, bone in enumerate(("Tail1", "Tail2", "Tail3"), 1):
        pose.setdefault(bone, []).append((Z, -bend * (1 + 0.3 * i) * wave(u, cycles, 0.1 * i)))
    return pose


def lurker_pose(clip, u):
    t = u * CLIP_FRAMES["marsh-lurker"][clip]
    if clip == "Idle":
        look = curve(u, (0.3, 0), (0.4, 1), (0.6, 1), (0.7, 0))
        pose = {"Body": [("loc", (0, 0, 0.004 * wave(u, 2)))], "Head": [(Z, 14 * look), (Y, -3 * look)], "Jaw": [(Y, 3 * max(0.0, wave(u, 6)))]}
        return lurker_spine(pose, u, 3)
    if clip in ("Walk", "Run"):
        run = clip == "Run"
        pose = {"Body": [("loc", (0, 0, 0.006 * abs(wave(u, 2))))], "Head": [(Y, -4 if run else 0)]}
        return lurker_legs(lurker_spine(pose, u, 12 if run else 8), u, 32 if run else 24, 26 if run else 18)
    if clip == "Eat":
        # Snapping up small prey from the mud: the head dips, the jaw gulps.
        gulp = max(0.0, wave(u, 3)) ** 2
        pose = {"Body": [(Y, 2)], "Head": [(Y, 6 + 6 * gulp), (Z, 6 * wave(u, 1))], "Jaw": [(Y, 22 * gulp)]}
        return lurker_spine(pose, u, 2)
    if clip == "Attack_A":
        # Snapping bite: the head draws back and up with the jaw gaping, then the lurker lunges and the jaw slams shut
        # (lands at 8/18) with a shake of the head.
        k = lambda *keys: curve(t, (0, 0), *keys, (18, 0))
        shake = math.sin(2 * math.pi * (t - 8) / 3) * curve(t, (8, 0), (9, 1), (11, 1), (12.5, 0))
        reach = k((5, -1), (8, 1), (11, 0.8))
        return {"Body": [("loc", (k((5, -0.06), (8, 0.16), (11, 0.13)), 0, k((5, 0.02), (8, 0.0)))), (Y, k((5, -10), (8, 1), (11, 0)))],
                "Head": [(Y, k((5, -24), (8, 4), (11, 2))), (X, 16 * shake)], "Jaw": [(Y, k((3, 30), (6, 46), (7.2, 40), (8, 0)))],
                "Tail1": [(Z, k((5, 14), (8, -8))), (Y, k((5, 10)))], "Tail2": [(Z, k((5, 12), (9, -10)))],
                "LegFL": [(Z, -22 * reach)], "LegFR": [(Z, 22 * reach)], "LegHL": [(Z, 10 * reach)], "LegHR": [(Z, -10 * reach)]}
    if clip == "Attack_B":
        # Tail lash: coils, tail cocked right, then whips the body round so the tail cracks across to the front-left
        # (lands at 14/26), and unwinds.
        k = lambda *keys: curve(t, (0, 0), *keys, (26, 0))
        pose = {"Body": [(Z, k((8, 22), (11, -12), (14, -52), (17, -44))), ("loc", (0, 0, k((8, 0.02), (14, 0.01))))],
                "Head": [(Z, k((8, -16), (14, 40), (17, 34))), (Y, k((14, -8)))], "Jaw": [(Y, k((10, 0), (13, 24), (17, 0)))]}
        for i, bone in enumerate(("Tail1", "Tail2", "Tail3")):
            pose[bone] = [(Z, k((8, 22), (11 + i * 0.7, 10), (12.5 + i * 0.7, -48 - 8 * i), (17 + i, -32), (21, -8))), (Y, k((8, 8 + 4 * i), (14, 4)))]
        pose["LegFL"] = [(Z, k((8, 12), (14, -16))), (X, k((14, -6)))]
        pose["LegFR"] = [(Z, k((8, -10), (14, 18)))]
        return pose
    if clip == "Hit":
        jolt = curve(t, (0, 0), (2, 1), (8, 0))
        return {"Body": [("loc", (-0.05 * jolt, 0, 0.025 * jolt)), (X, -6 * jolt)], "Head": [(Y, -16 * jolt), (Z, -14 * jolt)], "Jaw": [(Y, 14 * jolt)],
                "Tail1": [(Z, 20 * jolt)], "Tail2": [(Z, 18 * jolt)]}
    if clip == "Death":
        # Thrashes, then rolls belly-up and goes limp, jaw slack and tail curled.
        thrash = math.sin(2 * math.pi * t / 4) * curve(t, (0, 0), (2, 1), (8, 1), (11, 0))
        flip = curve(t, (8, 0), (20, 1))
        settle = curve(t, (20, 0), (23, 1), (26, 0))
        roll = math.radians(175 * flip)
        pose = {"Body": [("loc", (0, 0, 0.26 * math.sin(roll) - 0.095 * flip + 0.012 * settle)), (Z, 14 * thrash), (X, -175 * flip)],
                "Head": [(Z, -18 * thrash), (Y, -10 * flip)], "Jaw": [(Y, curve(t, (0, 0), (4, 30), (10, 18), (20, 22)))]}
        for i, bone in enumerate(("Tail1", "Tail2", "Tail3"), 1):
            pose[bone] = [(Z, -20 * thrash * i * 0.6 + 14 * flip * i)]
        for leg in ("FL", "FR", "HL", "HR"):
            s = 1 if leg[1] == "L" else -1
            pose[f"Leg{leg}"] = [(X, s * (22 * flip - 15 * settle * 0.3)), (Z, s * 10 * thrash)]
            pose[f"Shin{leg}"] = [(X, -s * 30 * flip)]
        return pose
    # Alert: rises on its forelegs, head up, jaw gaping in a trembling hiss, tail raised and lashing.
    up = curve(t, (0, 0), (5, 1), (16, 1), (20, 0))
    tremble = math.sin(2 * math.pi * t / 2) * up
    pose = {"Body": [(Y, -12 * up), ("loc", (0, 0, 0.03 * up))], "Head": [(Y, -14 * up)], "Jaw": [(Y, 34 * up + 3 * tremble)],
            "Tail1": [(Y, 14 * up)], "Tail2": [(Y, 10 * up), (Z, 22 * wave(t / 20, 2) * up)], "Tail3": [(Z, 26 * wave(t / 20, 2, 0.15) * up)],
            "LegFL": [(X, -10 * up)], "LegFR": [(X, 10 * up)]}
    return pose


# Per bird: wingbeat degrees, walk style ("hop" or "step"), how far the neck dips to feed.
BIRD_MOTION = {"crow": (55, "step", 70), "songbird": (60, "hop", 60), "duck": (50, "step", 55), "heron": (40, "step", 60)}


def bird_pose(animal, clip, u):
    flap, gait, dip = BIRD_MOTION[animal]
    if clip == "Idle":
        look = 35 * wave(u, 1) if (u % 0.5) < 0.38 else 0
        return {"Body": [("loc", (0, 0, 0.002 * wave(u, 2)))], "Neck": [(Z, look), (Y, 5 * wave(u, 3))], "Head": [(Y, 6 * wave(u, 2, 0.2))],
                "Tail": [(Y, 6 * wave(u, 4))], "WingL": [(X, 2 * wave(u, 2))], "WingR": [(X, -2 * wave(u, 2))]}
    if clip == "Walk":
        if gait == "hop":
            lift = max(0.0, wave(u, 1))
            return {"Body": [("loc", (0, 0, 0.03 * lift))], "Neck": [(Y, 8 * wave(u, 1, 0.2))], "Tail": [(Y, -12 * lift)],
                    "LegL": [(Y, 25 * lift)], "LegR": [(Y, 25 * lift)]}
        return {"Body": [("loc", (0, 0, 0.004 * abs(wave(u, 1)))), (X, 5 * wave(u, 1))], "Neck": [(Y, 10 * wave(u, 2))],
                "Head": [(Y, -6 * wave(u, 2))], "LegL": [(Y, -26 * wave(u, 1))], "LegR": [(Y, 26 * wave(u, 1))],
                "Tail": [(Z, 8 * wave(u, 1))]}
    if clip == "Eat":
        peck = max(0.0, wave(u, 2)) ** 2
        return {"Body": [(Y, 22 + 5 * peck)], "Neck": [(Y, dip * 0.55 + dip * 0.45 * peck)], "Head": [(Y, 15 * peck)], "Tail": [(Y, -14)],
                "LegL": [(Y, -14)], "LegR": [(Y, -14)]}
    # Fly: wings unrolled flat and swept out, beating; legs tucked back; the body rises and falls against each stroke.
    beat = wave(u, 1)
    pose = {"Body": [("loc", (0, 0, -0.01 * beat))], "Neck": [(Y, -25 if animal == "heron" else 8)], "Tail": [(Y, -6 * beat)],
            "LegL": [(Y, 80)], "LegR": [(Y, 80)]}
    for s, wing in ((1, "WingL"), (-1, "WingR")):
        pose[wing] = [(Y, -math.degrees(BIRD_SPECS[animal]["body"][2])), (X, s * 34), (Z, -s * 88), (X, s * flap * beat)]
    return pose


CLIP_FRAMES = {
    "rabbit": {"Idle": 72, "Walk": 14, "Eat": 48},
    "boar": {"Idle": 96, "Walk": 28, "Eat": 72, "Run": 16, "Attack_A": 20, "Attack_B": 24, "Hit": 8, "Death": 32, "Alert": 20},
    "crow": {"Idle": 72, "Walk": 16, "Eat": 48, "Fly": 16}, "songbird": {"Idle": 48, "Walk": 10, "Eat": 32, "Fly": 8},
    "duck": {"Idle": 72, "Walk": 18, "Eat": 56, "Fly": 10}, "heron": {"Idle": 96, "Walk": 36, "Eat": 64, "Fly": 28},
    "bear": {"Idle": 96, "Walk": 32, "Eat": 72, "Run": 18, "Attack_A": 22, "Attack_B": 34, "Hit": 8, "Death": 36, "Alert": 24},
    "spider": {"Idle": 48, "Walk": 12, "Eat": 48, "Run": 10, "Attack_A": 18, "Attack_B": 24, "Hit": 8, "Death": 28, "Alert": 20},
    "marsh-lurker": {"Idle": 72, "Walk": 24, "Eat": 48, "Run": 14, "Attack_A": 18, "Attack_B": 26, "Hit": 8, "Death": 30, "Alert": 20},
}


def build_authored(animal, collection):
    if animal in BIRDS:
        armature, mesh = build_bird(animal, collection)
        pose_of = lambda clip, u: bird_pose(animal, clip, u)
    else:
        armature, mesh = {"rabbit": build_rabbit, "boar": build_boar, "bear": build_bear, "spider": build_spider, "marsh-lurker": build_lurker}[animal](collection)
        pose_of = {"rabbit": rabbit_pose, "boar": boar_pose, "bear": bear_pose, "spider": spider_pose, "marsh-lurker": lurker_pose}[animal]
    actions = {}
    for clip, count in CLIP_FRAMES[animal].items():
        action = bpy.data.actions.new(clip)
        slot_for(armature, action)
        for frame in range(0, count + 1, 1 if count <= 16 or clip in ONE_SHOT else 2):
            key_pose(armature, frame, pose_of(clip, frame / count))
        actions[clip] = action
    for action in actions.values():
        for fcurve in getattr(action, "fcurves", ()):
            for point in fcurve.keyframe_points:
                point.interpolation = "LINEAR"
    return armature, [mesh], actions


# ---------------------------------------------------------------- shared

def prepare(animal, source_path):
    """Load or build ``animal`` into the current scene, normalised; return its root and measurements."""
    spec = ANIMALS[animal]
    collection = bpy.context.scene.collection
    if spec["format"] == "authored":
        armature, meshes, actions = build_authored(animal, collection)
    else:
        armature, meshes, actions = load_source(animal, source_path)
    for name, action in actions.items():
        action.name = name
        action.use_fake_user = True

    root = bpy.data.objects.new(f"greyhaven.wild.{animal}", None)
    collection.objects.link(root)
    top = armature
    while top.parent:
        top = top.parent
    top.parent = root
    root.rotation_euler = (0.0, 0.0, math.radians(spec["turn"]))
    slot_for(armature, actions["Idle"])
    scene = bpy.context.scene
    scene.frame_set(int(actions["Idle"].frame_range[0]))
    bpy.context.view_layer.update()
    low, high = bounds(meshes)
    root.scale = (spec["height"] / (high.z - low.z),) * 3
    bpy.context.view_layer.update()
    low, high = bounds(meshes)
    root.location = Vector((-(low.x + high.x) / 2, -(low.y + high.y) / 2, -low.z))
    bpy.context.view_layer.update()
    low, high = bounds(meshes)

    # In-place check: the walk's horizontal travel of the mesh centre over the clip, in metres.
    slot_for(armature, actions["Walk"])
    start, end = (int(round(v)) for v in actions["Walk"].frame_range)
    centres = []
    for frame in (start, end):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        a, b = bounds(meshes)
        centres.append(((a.x + b.x) / 2, (a.y + b.y) / 2))
    slot_for(armature, actions["Idle"])
    scene.frame_set(int(actions["Idle"].frame_range[0]))
    travel = math.dist(centres[0], centres[1])
    return root, armature, meshes, actions, {
        "low": low, "high": high, "travel": travel,
        "frames": {name: [int(round(v)) for v in action.frame_range] for name, action in actions.items()},
    }


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_farm(inputs.load_source("farm"))
    animal = arguments["animal"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = FPS, 1.0
    root, armature, meshes, actions, measured = prepare(animal, inputs.get("source"))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [root, *root.children_recursive]:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=False, export_optimize_animation_keep_anim_armature=True,
        export_skins=True, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    low, high = measured["low"], measured["high"]
    gltf = lambda v: [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]  # glTF axes
    return {
        "recipe": "wildlife-v1", "animal": animal, "root": root.name, "armature": armature.name,
        "joints": len(armature.data.bones), "meshes": sorted(m.name for m in meshes),
        "materials": sorted({s.material.name for m in meshes for s in m.material_slots if s.material}),
        "idleBounds": {"min": gltf(Vector((low.x, high.y, low.z))), "max": gltf(Vector((high.x, low.y, high.z)))},
        "scale": round(root.scale.x, 6), "turnDegrees": ANIMALS[animal]["turn"],
        "clips": {name: {"frames": frames, "fps": scene.render.fps, "loop": name not in ONE_SHOT,
                         **({"contactSeconds": round(CONTACT_FRAMES[animal][name] / FPS, 5)} if name in CONTACT_FRAMES.get(animal, {}) else {})}
                  for name, frames in measured["frames"].items()},
        "walkTravel": round(measured["travel"], 4),
    }
