"""Greyhaven wildlife: a stag, a doe, a fox, a rabbit, a wild boar, a crow, a duck, a heron and a songbird for
Greyhaven's woods, meadows and river, and the hostile Timber Wolf, Young Boar, Grain Rat, brown bear, giant cave spider
and marsh lurker with combat clips, and a forest lynx and a marsh adder with their own clip sets.

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

The forest lynx and marsh adder (#778) are hostile and original too (the only catalogued CC0 cat is a house cat with
an idle and a walk, and there is no snake). Each has its own clip set: the lynx stalks and pounces in three chained clips
(``Pounce_Windup``, ``Pounce_Lunge``, ``Pounce_Recover``) with every leg solved to its paw each frame (``lynx_assemble``);
the adder is one smooth tube on a fourteen-bone spine posed from joint positions (``adder_assemble``), resting coiled,
slithering along a fixed path, rearing to warn and striking. ``root_motion`` names how far a consumer moves the root under
their travelling clips.

The farm-animals recipe (``farm_animals.py``) is a declared Python input named ``farm``; this recipe reuses its rig
builder, clip keying and measuring helpers and its conventions (docs/greyhaven-farm-animals.md): a root node
``greyhaven.wild.<animal>`` scales the animal to its Greyhaven height in metres (measured at the first Idle frame), turns
its head to glTF +Z and puts the centre of its footprint on the ground at the origin. Every clip loops in place. There is
no randomness.

``prepare(animal, source_path)`` also runs in a live Blender session after ``use_farm(module dict of farm_animals.py)``
(``source_path`` is ``None`` for the authored animals).
"""
import bisect
import math

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 24
SHARED = ("Rig", "key_pose", "wave", "slot_for", "bounds", "principled_from_diffuse")
UAA_CLIPS = {"Idle": "Idle", "Walk": "Walk", "Eat": "Eating"}
# Shipped clip -> source clip (the source's action name after its "<armature>|" prefix), kept as authored.
SOURCE_CLIPS = {
    "stag": {**UAA_CLIPS, "Run": "Gallop"}, "doe": UAA_CLIPS, "fox": UAA_CLIPS,
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
    "lynx": {"format": "authored", "turn": -90.0, "height": 0.8},
    # Authored at life size (scale 1); it rests coiled and moves by Slither_Loop.
    "marsh-adder": {"format": "authored", "turn": -90.0, "height": None, "rest": "Idle_Coil_Loop", "move": "Slither_Loop"},
    "highland-ram": {"format": "authored", "turn": -90.0, "height": 1.0},
}
BIRDS = ("crow", "duck", "heron", "songbird")
HOSTILE = ("wolf", "boar", "rat", "bear", "spider", "marsh-lurker", "lynx", "marsh-adder")
# One-shot clips; every other clip loops.
ONE_SHOT = ("Attack_A", "Attack_B", "Hit", "Death", "Alert", "Pounce_Windup", "Pounce_Lunge", "Pounce_Recover", "Strike", "Strike_Recover")


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
# Shipped clip -> (source clip, warp: ((frame, source frame), ...) piecewise linear from 0 to the clip's last frame). A warp
# key may name its own source clip, (frame, source frame, source clip); between keys of two clips the base pose blends
# from one to the other (#782).
LAYERED = {
    "wolf": {
        "Attack_A": ("Attack", ((0, 0), (10, 10), (15, 20), (21, 32))),
        "Attack_B": ("Attack", ((0, 0), (9, 5), (14, 9), (17, 20), (25, 32))),
        "Hit": ("Idle_HitReact_Left", ((0, 0), (8, 16))),
        "Alert": ("Idle", ((0, 0), (20, 20))),
    },
    "stag": {
        "Attack_A": ("Attack_Headbutt", ((0, 0), (8, 6), (11, 10), (22, 19))),
        "Attack_B": ("Idle", ((0, 0, "Idle"), (6, 6, "Idle"), (8, 0, "Gallop"), (15, 11, "Gallop"), (17, 0, "Idle"), (32, 15, "Idle"))),
        "Hit": ("Idle_HitReact_Left", ((0, 0), (8, 11))),
        "Alert": ("Idle", ((0, 0), (24, 24))),
        "Death": ("Death", ((0, 0), (26, 26))),
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
    "stag": {"Attack_A": 11, "Attack_B": 15},
    "highland-ram": {"Attack_A": 11, "Attack_B": 13},
    "boar": {"Attack_A": 9, "Attack_B": 15},
    "bear": {"Attack_A": 11, "Attack_B": 20},
    "spider": {"Attack_A": 9, "Attack_B": 14},
    "marsh-lurker": {"Attack_A": 8, "Attack_B": 14},
    "lynx": {"Pounce_Lunge": 8},
    "marsh-adder": {"Strike": 5},
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


def stag_layer(clip, t):
    """The stag's fights (#782). Its hooves are the source rig's root-level IK bones, so the body and feet move freely and
    ``STAG_LEGS`` re-solves each leg onto its hoof every frame: planted hooves stay planted while the body drives."""
    if clip == "Attack_A":
        # Antler sweep: the weight rocks back and the head cocks right with the antlers tipped low, then the whole body
        # twists left behind a sharp sideways rake of the antlers across the front (lands at 11/22), the right forefoot
        # stepping in to drive it; a follow-through and recovery to the stance.
        k = lambda *keys: curve(t, (0, 0), *keys, (22, 0))
        sweep = k((5, -1), (8, -1.1), (11, 0.55), (13, 0.85), (17, 0.3))
        step = curve(t, (6, 0), (9, 1), (16, 1), (21, 0))
        lift = curve(t, (6, 0), (7.5, 1), (9, 0), (16, 0), (18.5, 1), (21, 0))
        return {"Body": [("loc", (k((7, -0.035), (11, 0.05), (14, 0.04)), k((7, -0.012), (11, -0.02)), -0.025 * sweep)), ("W", 8 * sweep), ("R", -4 * sweep)],
                "Torso": [("W", 6 * sweep)], "Torso3": [("W", 6 * sweep)], "Neck1": [("W", 14 * sweep), ("P", k((7, -4), (11, 12), (14, 10)))],
                "Neck3": [("W", 10 * sweep)], "Head": [("W", 14 * sweep), ("R", 26 * sweep), ("P", k((7, 6), (11, 16), (14, 12)))],
                "Tail1": [("P", k((5, -30), (17, -30)))],
                "IKFrontLeg.R": [("loc", (0.07 * step, 0.05 * lift, -0.01 * step))]}
    if clip == "Attack_B":
        # Forward charge: antlers lowered at the threat, a forefoot scrape, then a lowered-head gallop (the consumer moves
        # the root from 8 to 15), the lowered antlers driven in at the contact (15/32) braced on both forefeet, a hard
        # upward hook, the recoil, and an exposed, head-shaking recovery.
        k = lambda *keys: curve(t, (0, 0), *keys, (32, 0))
        low = curve(t, (0, 0), (5, 1), (15, 1), (16.5, 0), (32, 0))
        hook = curve(t, (15, 0), (16.5, 1), (19, 0.4), (23, 0))
        scrape = curve(t, (1, 0), (2.5, 1), (4, 0), (5.5, 1), (7, 0))
        brace = curve(t, (13, 0), (15, 1), (19, 1), (24, 0))
        shake = math.sin(2 * math.pi * (t - 18) / 4) * curve(t, (17, 0), (19, 1), (24, 1), (27, 0))
        pose = {"Body": [("loc", (k((5, -0.035), (8, -0.02), (15, 0.045), (18, -0.03), (24, 0)), k((5, -0.03), (8, -0.01), (15, -0.025), (18, 0)), 0)),
                         ("P", k((5, 4), (14, 6), (15, 0), (18, -5), (23, 0)))],
                "Neck1": [("P", 26 * low - 10 * hook - 6 * curve(t, (17, 0), (19, 1), (26, 0)))], "Neck3": [("P", 8 * low)],
                "Head": [("P", 55 * low - 25 * hook), ("R", 14 * shake), ("W", 8 * shake)],
                "Tail1": [("P", k((3, -40), (24, -40)))],
                "IKFrontLeg.R": [("loc", (0.05 * scrape, 0.035 * scrape, 0))]}
        for foot in ("IKFrontLeg.L", "IKFrontLeg.R"):
            pose.setdefault(foot, []).append(("loc", (0.05 * brace, 0, 0)))
        return pose
    if clip == "Death":
        # The source collapse onto its side, with the head turned as it lands so the antlers lie along the ground
        # instead of spearing into it, and the body and hooves raised out of the ground the source sinks them into.
        fall = curve(t, (7, 0), (15, 1))
        pose = {"Body": [("loc", (0, 0.064 * curve(t, (5, 0), (12, 1)), 0))], "Neck3": [("R", STAG_DEATH_ROLL * 0.4 * fall)],
                "Head": [("R", STAG_DEATH_ROLL * fall)]}
        for foot in ("IKFrontLeg.L", "IKFrontLeg.R", "IKBackLeg.L", "IKBackLeg.R"):
            pose[foot] = [("loc", (0, 0.045 * curve(t, (0, 0), (12, 1)), 0))]
        return pose
    if clip == "Hit":
        # Struck: a jolt back and away, the head and antlers snapping up and aside.
        jolt = curve(t, (0, 0), (2, 1), (8, 0))
        return {"Body": [("loc", (-0.03 * jolt, 0.008 * jolt, 0.012 * jolt)), ("R", 5 * jolt)], "Neck1": [("P", -10 * jolt)],
                "Head": [("P", -16 * jolt), ("R", -12 * jolt)], "Tail1": [("P", -35 * jolt)]}
    # Alert: the head snaps up in alarm, then the antlers drop at the threat and thrash twice as the right forefoot
    # stamps the ground twice; the tail flags up throughout.
    up = curve(t, (0, 0), (3, 1), (6, 1), (8, 0))
    low = curve(t, (6, 0), (9, 1), (20, 1), (24, 0))
    thrash = math.sin(2 * math.pi * (t - 9) / 4) * curve(t, (9, 0), (10, 1), (17, 1), (19, 0))
    stamp = curve(t, (10, 0), (11.5, 1), (12.5, 0), (15, 0), (16.5, 1), (17.5, 0))
    return {"Body": [("loc", (0.012 * low, 0.015 * up - 0.01 * low, 0))], "Neck1": [("P", -20 * up + 22 * low)], "Neck3": [("W", 12 * thrash)],
            "Head": [("P", -16 * up + 40 * low), ("R", 24 * thrash)], "Tail1": [("P", -40 * max(up, low))],
            "IKFrontLeg.R": [("loc", (0.04 * stamp, 0.09 * stamp, 0))]}


STAG_DEATH_ROLL = 60.0
# The stag's legs (#782): the two bones solved onto each IK hoof, upper and lower. The hind legs keep their thigh.
STAG_LEGS = (("FrontUpperLeg.L", "FrontLowerLeg.L", "IKFrontLeg.L"), ("FrontUpperLeg.R", "FrontLowerLeg.R", "IKFrontLeg.R"),
             ("BackUpperLeg.L", "BackLowerLeg.L", "IKBackLeg.L"), ("BackUpperLeg.R", "BackLowerLeg.R", "IKBackLeg.R"))
LAYERS = {"wolf": (wolf_layer, ()), "rat": (rat_layer, ()), "stag": (stag_layer, STAG_LEGS)}


def sample_pose(armature, frame):
    whole = math.floor(frame)
    bpy.context.scene.frame_set(whole, subframe=frame - whole)
    return {pb.name: (pb.location.copy(), pb.rotation_quaternion.copy(), pb.scale.copy()) for pb in armature.pose.bones}


def blend_pose(a, b, s):
    return {name: (a[name][0].lerp(b[name][0], s), a[name][1].slerp(b[name][1], s), a[name][2].lerp(b[name][2], s)) for name in a}


def layered_bases(armature, sources, source, warp):
    """The source pose under each frame of a layered clip: one clip re-timed, or several blended key to key."""
    count = warp[-1][0]
    if len(warp[0]) == 2:
        slot_for(armature, sources[source])
        return [sample_pose(armature, warped(warp, t)) for t in range(count + 1)]

    def at(clip, frame):
        slot_for(armature, sources[clip])
        return sample_pose(armature, frame)

    bases = []
    for t in range(count + 1):
        (t0, f0, c0), (t1, f1, c1) = next(pair for pair in zip(warp, warp[1:]) if t <= pair[1][0])
        s = (t - t0) / (t1 - t0)
        if c0 == c1:
            bases.append(at(c0, f0 + (f1 - f0) * s))
        else:
            bases.append(blend_pose(at(c0, f0), at(c1, f1), s * s * (3 - 2 * s)))
    return bases


def solve_legs(armature, legs):
    """Turn each leg's upper and lower bone so the lower one ends on its hoof bone, keeping the knee's side (#782)."""
    rest = armature.data.bones
    for upper, lower, foot in legs:
        u, l, f = (armature.pose.bones[name] for name in (upper, lower, foot))
        a = (rest[lower].head_local - rest[upper].head_local).length
        b = (rest[foot].head_local - rest[lower].head_local).length
        hip, knee, target = u.head.copy(), l.head.copy(), f.head.copy()
        reach = target - hip
        d = min(max(reach.length, abs(a - b) + 1e-6), a + b - 1e-6)
        normal = (knee - hip).cross(reach)
        if normal.length < 1e-9:
            continue
        along = reach.normalized()
        side = normal.normalized().cross(along)
        if side.dot(knee - hip) < 0:
            side = -side
        x = (a * a - b * b + d * d) / (2 * d)
        bent = hip + along * x + side * math.sqrt(max(a * a - x * x, 0.0))
        turn = (knee - hip).rotation_difference(bent - hip).to_matrix().to_4x4()
        u.matrix = Matrix.Translation(hip) @ turn @ Matrix.Translation(-hip) @ u.matrix
        bpy.context.view_layer.update()
        knee = l.head.copy()
        end = l.matrix @ (rest[lower].matrix_local.inverted() @ rest[foot].head_local)
        turn = (end - knee).rotation_difference(target - knee).to_matrix().to_4x4()
        l.matrix = Matrix.Translation(knee) @ turn @ Matrix.Translation(-knee) @ l.matrix
        bpy.context.view_layer.update()


def key_layered(armature, frame, base, pose, unit, legs=()):
    """Key ``base`` (a sampled source pose) with ``pose`` added: rotations about rig axes at rest, moves in rig heights.
    With ``legs``, each leg is solved onto its hoof before keying."""
    if legs:
        action = armature.animation_data.action
        armature.animation_data.action = None
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
        if not legs:
            for path in ("location", "rotation_quaternion", "scale"):
                pb.keyframe_insert(path, frame=frame)
    if legs:
        bpy.context.view_layer.update()
        solve_legs(armature, legs)
        slot_for(armature, action)
        for pb in armature.pose.bones:
            for path in ("location", "rotation_quaternion", "scale"):
                pb.keyframe_insert(path, frame=frame)


def layer_clips(animal, armature, sources):
    heads = [-bone.head_local.y for bone in armature.data.bones]
    unit = max(heads) - min(heads)
    layer, legs = LAYERS[animal]
    before = {pb.name: (pb.location.copy(), pb.rotation_quaternion.copy(), pb.scale.copy()) for pb in armature.pose.bones}
    actions = {}
    for clip, (source, warp) in LAYERED[animal].items():
        bases = layered_bases(armature, sources, source, warp)
        action = bpy.data.actions.new(clip)
        slot_for(armature, action)
        for t, base in enumerate(bases):
            key_layered(armature, t, base, layer(clip, t), unit, legs)
        actions[clip] = action
    if legs:
        # Bones a source clip leaves unkeyed would otherwise keep the last layered pose when the idle is measured.
        for pb in armature.pose.bones:
            pb.location, pb.rotation_quaternion, pb.scale = before[pb.name]
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


def body_hips(loc, pitch, pivot, hip, legs):
    """Where each hip (x, z) is once the Body moves by ``loc`` (x, z) and pitches ``pitch`` degrees about its head."""
    a = math.radians(pitch)
    px, pz = pivot
    hips = {}
    for leg, x, _ in legs:
        dx, dz = x - px, hip - pz
        hips[leg] = (px + loc[0] + dx * math.cos(a) + dz * math.sin(a), pz + loc[1] - dx * math.sin(a) + dz * math.cos(a))
    return hips


def two_bone_legs(pose, hips, pitch, feet, thigh_length, shin_length):
    """Two-bone legs from each hip to its foot (x, z on the ground plane's side view), the knee forward of the line,
    as ``Leg``/``Shin`` rotations about Y under the Body's ``pitch``. A foot out of reach ends a straight leg."""
    def towards(dx, dz):  # the angle about Y that turns a leg hanging straight down onto (dx, dz)
        return math.degrees(math.atan2(-dx, -dz))

    for leg, (fx, fz) in feet.items():
        hx, hz = hips[leg]
        d = min(max(math.hypot(fx - hx, fz - hz), 0.05), thigh_length + shin_length - 1e-4)
        bend = math.degrees(math.acos((thigh_length ** 2 + d ** 2 - shin_length ** 2) / (2 * thigh_length * d)))
        thigh = towards(fx - hx, fz - hz) - bend
        t = math.radians(thigh)
        kx, kz = hx - thigh_length * math.sin(t), hz - thigh_length * math.cos(t)
        pose[f"Leg{leg}"] = [(Y, thigh - pitch)]
        pose[f"Shin{leg}"] = [(Y, towards(fx - kx, fz - kz) - thigh)]
    return pose


def boar_hips(loc, pitch):
    return body_hips(loc, pitch, BOAR_PIVOT, BOAR_HIP, BOAR_LEGS)


def boar_legs(pose, hips, pitch, feet):
    return two_bone_legs(pose, hips, pitch, feet, BOAR_THIGH, BOAR_SHIN)


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


# ---------------------------------------------------------------- forest lynx and marsh adder (#778)

LYNX_PALETTE = {"coat": (0.6, 0.5, 0.37), "pale": (0.87, 0.82, 0.72), "spot": (0.27, 0.2, 0.14), "dark": (0.06, 0.05, 0.05),
                "eye": (0.8, 0.64, 0.2), "mouth": (0.5, 0.16, 0.16), "tooth": (0.92, 0.89, 0.8)}
# The lynx's legs, in the side view (x forward, z up). Per kind (F fore, H hind): the shoulder or hip joint at rest, the
# upper and lower bone lengths, the ball of the foot's home x, the wrist or hock above the ball, and which way the joint
# bends (+1 the elbow behind the line, -1 the stifle ahead of it). Every leg is placed each frame by a two-bone solve to
# its foot, so a planted paw stays exactly where it is while the body moves over it.
LYNX_PIVOT, LYNX_CHEST = (-0.28, 0.54), (0.0, 0.55)  # the Hips bone's head and the Chest bone's head
LYNX_JOINT = {"F": (0.2, 0.47), "H": (-0.24, 0.5)}
LYNX_BONES = {"F": (0.2, 0.22), "H": (0.2, 0.2)}
LYNX_HOME = {"F": 0.24, "H": -0.21}
LYNX_ANKLE = {"F": (-0.02, 0.07), "H": (-0.03, 0.15)}
LYNX_BEND = {"F": 1, "H": -1}
LYNX_SIDE = {"F": 0.085, "H": 0.09}
LYNX_LEGS = (("FL", "F", 1), ("FR", "F", -1), ("HL", "H", 1), ("HR", "H", -1))


def ry(v, degrees):
    """(x, z) rotated about Blender +Y: positive tips a forward vector down and a hanging one back."""
    a = math.radians(degrees)
    return (v[0] * math.cos(a) + v[1] * math.sin(a), -v[0] * math.sin(a) + v[1] * math.cos(a))


def towards(dx, dz):
    """The angle about +Y that turns a bone hanging straight down onto (dx, dz)."""
    return math.degrees(math.atan2(-dx, -dz))


def lynx_joints(body):
    """Shoulder and hip joints (x, z) once the body is ``(x, z, hip pitch, chest pitch)``."""
    x, z, hip, chest = body
    px, pz = LYNX_PIVOT
    hx, hz = ry((LYNX_JOINT["H"][0] - px, LYNX_JOINT["H"][1] - pz), hip)
    cx, cz = ry((LYNX_CHEST[0] - px, LYNX_CHEST[1] - pz), hip)
    fx, fz = ry((LYNX_JOINT["F"][0] - LYNX_CHEST[0], LYNX_JOINT["F"][1] - LYNX_CHEST[1]), hip + chest)
    return {"H": (px + x + hx, pz + z + hz), "F": (px + x + cx + fx, pz + z + cz + fz)}


def lynx_solve(kind, joint, ball, tilt):
    """Thigh and shin angles (about +Y, from hanging) that reach the wrist or hock over ``ball`` with the paw tilted."""
    a, b = LYNX_BONES[kind]
    ax, az = ry(LYNX_ANKLE[kind], tilt)
    ankle = (ball[0] + ax, ball[1] + az)
    dx, dz = ankle[0] - joint[0], ankle[1] - joint[1]
    d = min(max(math.hypot(dx, dz), 0.05), a + b - 1e-4)
    bend = math.degrees(math.acos((a * a + d * d - b * b) / (2 * a * d)))
    thigh = towards(dx, dz) + LYNX_BEND[kind] * bend
    t = math.radians(thigh)
    knee = (joint[0] - a * math.sin(t), joint[1] - a * math.cos(t))
    return thigh, towards(ankle[0] - knee[0], ankle[1] - knee[1]), knee, ankle


def lynx_rest():
    """Leg name -> (joint, knee, ankle, ball, thigh, shin) at rest."""
    joints = lynx_joints((0, 0, 0, 0))
    rest = {}
    for leg, kind, _ in LYNX_LEGS:
        ball = (LYNX_HOME[kind], 0.0)
        thigh, shin, knee, ankle = lynx_solve(kind, joints[kind], ball, 0)
        rest[leg] = (joints[kind], knee, ankle, ball, thigh, shin)
    return rest


LYNX_REST = lynx_rest()


def build_lynx(collection):
    bones = [("Hips", (*LYNX_PIVOT[:1], 0, LYNX_PIVOT[1]), (0.0, 0, 0.55), None), ("Chest", (0.0, 0, 0.55), (0.24, 0, 0.56), "Hips"),
             ("Neck", (0.22, 0, 0.57), (0.31, 0, 0.66), "Chest"), ("Head", (0.31, 0, 0.66), (0.47, 0, 0.63), "Neck"),
             ("Jaw", (0.37, 0, 0.615), (0.46, 0, 0.6), "Head"), ("EarL", (0.35, 0.05, 0.71), (0.34, 0.06, 0.8), "Head"),
             ("EarR", (0.35, -0.05, 0.71), (0.34, -0.06, 0.8), "Head"), ("Tail", (-0.36, 0, 0.58), (-0.45, 0, 0.47), "Hips")]
    for leg, kind, s in LYNX_LEGS:
        (jx, jz), (kx, kz), (ax, az), (bx, bz), _, _ = LYNX_REST[leg]
        y = s * LYNX_SIDE[kind]
        bones += [(f"Leg{leg}", (jx, y, jz), (kx, y, kz), "Hips" if kind == "H" else "Chest"),
                  (f"Shin{leg}", (kx, y, kz), (ax, y, az), f"Leg{leg}"), (f"Paw{leg}", (ax, y, az), (bx + 0.04, y, bz), f"Shin{leg}")]
    r = Rig("Lynx", LYNX_PALETTE, bones)
    # Torso: haunch and chest overlap at the Chest bone's head, so the spine can flex without a gap.
    r.ellipsoid("Hips", "coat", (-0.16, 0, 0.53), (0.21, 0.115, 0.13), segments=12, rings=7)
    r.ellipsoid("Chest", "coat", (0.1, 0, 0.53), (0.2, 0.12, 0.14), segments=12, rings=7)
    r.ellipsoid("Chest", "pale", (0.1, 0, 0.45), (0.17, 0.085, 0.07), segments=8, rings=4)  # pale chest and belly
    r.ellipsoid("Hips", "pale", (-0.12, 0, 0.45), (0.15, 0.08, 0.06), segments=8, rings=4)
    # Spots: a fixed golden-angle scatter over the flanks and haunches, half sunk into the coat.
    for i in range(26):
        a = 2.39996 * i
        x = -0.32 + 0.6 * ((i * 0.618034) % 1.0)
        bone, (cx, rx) = ("Hips", (-0.16, 0.21)) if x < -0.02 else ("Chest", (0.1, 0.2))
        e = max(0.0, 1 - ((x - cx) / rx) ** 2)
        theta = -0.45 + 1.3 * ((i * 0.754878) % 1.0)  # up from the flank's equator
        side = 1 if math.sin(a) >= 0 else -1
        y, z = side * 0.112 * math.sqrt(e) * math.cos(theta), 0.53 + 0.128 * math.sqrt(e) * math.sin(theta)
        r.ellipsoid(bone, "spot", (x, y, z), (0.026, 0.02, 0.022), segments=5, rings=3)
    r.tube("Neck", "coat", (0.17, 0, 0.55), (0.33, 0, 0.66), 0.085, 0.065, 8)
    r.ellipsoid("Neck", "pale", (0.27, 0, 0.56), (0.08, 0.06, 0.06), segments=7, rings=4)  # throat
    r.ellipsoid("Head", "coat", (0.37, 0, 0.665), (0.085, 0.078, 0.072), segments=10, rings=6)
    r.ellipsoid("Head", "pale", (0.44, 0, 0.635), (0.05, 0.048, 0.035), segments=8, rings=4)  # muzzle
    r.ellipsoid("Head", "dark", (0.485, 0, 0.645), (0.014, 0.018, 0.012), segments=5, rings=3)  # nose
    r.ellipsoid("Head", "mouth", (0.43, 0, 0.61), (0.045, 0.035, 0.012), segments=6, rings=3)
    r.ellipsoid("Jaw", "pale", (0.42, 0, 0.6), (0.05, 0.036, 0.016), segments=7, rings=3)
    for s in (1, -1):
        r.ellipsoid("Head", "pale", (0.34, s * 0.075, 0.625), (0.05, 0.035, 0.065), rotation=(s * 0.35, 0.3, 0), segments=7, rings=4)  # ruff
        r.ellipsoid("Head", "dark", (0.33, s * 0.095, 0.62), (0.035, 0.012, 0.012), rotation=(0, 0.6, 0), segments=5, rings=3)  # ruff stripe
        r.ellipsoid("Head", "eye", (0.435, s * 0.042, 0.685), (0.016, 0.014, 0.013), segments=6, rings=3)
        r.ellipsoid("Head", "dark", (0.448, s * 0.043, 0.686), (0.006, 0.008, 0.009), segments=4, rings=3)
        r.tube("Head", "tooth", (0.47, s * 0.018, 0.618), (0.47, s * 0.018, 0.596), 0.006, 0.0015, 4)  # fangs
        ear = "EarL" if s > 0 else "EarR"
        r.ellipsoid(ear, "coat", (0.35, s * 0.055, 0.755), (0.026, 0.012, 0.05), rotation=(s * -0.12, -0.08, 0), segments=6, rings=4)
        r.ellipsoid(ear, "dark", (0.345, s * 0.058, 0.79), (0.02, 0.013, 0.02), segments=5, rings=3)  # dark back of the tip
        r.tube(ear, "dark", (0.343, s * 0.058, 0.795), (0.338, s * 0.064, 0.87), 0.008, 0.0015, 4)  # tuft
    r.tube("Tail", "coat", (-0.34, 0, 0.59), (-0.43, 0, 0.49), 0.045, 0.038, 7)
    r.ellipsoid("Tail", "dark", (-0.445, 0, 0.475), (0.036, 0.034, 0.036), segments=6, rings=4)  # black tip
    for leg, kind, s in LYNX_LEGS:
        (jx, jz), (kx, kz), (ax, az), (bx, bz), _, _ = LYNX_REST[leg]
        y = s * LYNX_SIDE[kind]
        hind = kind == "H"
        r.tube(f"Leg{leg}", "coat", (jx, y, jz + 0.06), (kx, y, kz), 0.075 if hind else 0.06, 0.045 if hind else 0.042, 7)
        # A rounded shoulder or haunch closes the leg's top inside the body (#736).
        r.ellipsoid(f"Leg{leg}", "coat", (jx, y * 0.95, jz + 0.02), (0.1 if hind else 0.08, 0.075, 0.12 if hind else 0.1), segments=8, rings=5)
        r.ellipsoid(f"Shin{leg}", "coat", (kx, y, kz), (0.045, 0.042, 0.045), segments=6, rings=4)  # knee or elbow
        r.tube(f"Shin{leg}", "coat", (kx, y, kz), (ax, y, az), 0.04, 0.03, 6)
        r.tube(f"Paw{leg}", "coat", (ax, y, az), (bx, y, bz + 0.02), 0.03, 0.03, 6)
        r.ellipsoid(f"Paw{leg}", "pale", (bx + 0.02, y, 0.022), (0.05, 0.036, 0.022), segments=7, rings=4)  # the broad paw
        if not hind:
            r.ellipsoid(f"Shin{leg}", "spot", (kx - 0.01, y + s * 0.035, kz - 0.06), (0.016, 0.012, 0.016), segments=5, rings=3)
    return r.finish(collection)


def lynx_feet(u, duty, stride, lift, phases, home=None):
    """A gait's paw targets (x, z, paw tilt) at ``u``: each paw slides back at an even speed while planted, so with the
    root moving at ``stride / (duty × clip seconds)`` it stays still on the ground, then swings forward in an arc."""
    feet = {}
    for leg, kind, _ in LYNX_LEGS:
        h = (home or LYNX_HOME)[kind]
        c = (u - phases[leg]) % 1.0
        if c < duty:
            feet[leg] = (h + stride / 2 - stride * c / duty, 0.0, 0.0)
        else:
            s = (c - duty) / (1 - duty)
            e = s * s * (3 - 2 * s)
            feet[leg] = (h - stride / 2 + stride * e, lift * math.sin(math.pi * s), 45 * math.sin(math.pi * s))
    return feet


def lynx_assemble(body, feet, roll=0.0, neck=0.0, head=None, yaw=0.0, jaw=0.0, ears=0.0, tail=(0.0, 0.0), relax=None, relaxed=0.0):
    """The lynx's pose: the body, every leg solved to its paw, and the head kept at world pitch ``head`` (degrees, nose
    down positive) when given. ``relax`` blends the solved legs towards loose angles by ``relaxed`` (the death roll)."""
    x, z, hip, chest = body
    pose = {"Hips": [("loc", (x, 0, z)), (Y, hip), (X, roll)], "Chest": [(Y, chest)], "Neck": [(Y, neck)],
            "Head": [(Y, (head - hip - chest - neck) if head is not None else 0.0), (Z, yaw)], "Jaw": [(Y, jaw)],
            "EarL": [(Y, ears)], "EarR": [(Y, ears)], "Tail": [(Y, tail[0]), (Z, tail[1])]}
    joints = lynx_joints(body)
    for leg, kind, _ in LYNX_LEGS:
        bx, bz, tilt = feet[leg]
        thigh, shin, _, _ = lynx_solve(kind, joints[kind], (bx, bz), tilt)
        rest_thigh, rest_shin = LYNX_REST[leg][4:]
        parent = hip + (chest if kind == "F" else 0.0)
        angles = (thigh - rest_thigh - parent, shin - rest_shin - (thigh - rest_thigh), tilt - (shin - rest_shin))
        if relax:
            angles = tuple(a + (b - a) * relaxed for a, b in zip(angles, relax.get(leg, relax[kind])))
        pose[f"Leg{leg}"], pose[f"Shin{leg}"], pose[f"Paw{leg}"] = ([(Y, a)] for a in angles)
        # Undo the body's roll in the leg so a planted paw stays put while the hips sway (not while it falls over).
        counter = roll * (1 - relaxed)
        if counter:
            pose[f"Leg{leg}"] = [(Y, parent + angles[0]), (X, -counter), (Y, -parent)]
    return pose


# Per looping gait: frames, duty factor, stride (m), paw lift (m), each paw's phase. Walk and stalk are a cat's lateral
# sequence; the run is a rotary gallop with a gathered suspension.
LYNX_GAITS = {
    "Walk": (24, 0.62, 0.4, 0.08, {"HL": 0.0, "FL": 0.25, "HR": 0.5, "FR": 0.75}),
    "Crouch_Stalk_Loop": (36, 0.76, 0.26, 0.07, {"HL": 0.0, "FL": 0.25, "HR": 0.5, "FR": 0.75}),
    "Run": (10, 0.3, 0.4, 0.15, {"HL": 0.0, "HR": 0.1, "FR": 0.42, "FL": 0.52}),
}
LYNX_CROUCH = (-0.07, -0.17, 5, 6)  # the loaded pounce crouch: weight back, chest low
LYNX_POUNCE = {"takeoff": 3, "land": 8, "distance": 1.5}  # Pounce_Lunge's flight, when the consumer moves the root


def lynx_pose(clip, u):
    t = u * CLIP_FRAMES["lynx"][clip]
    home = {leg: (LYNX_HOME[kind], 0.0, 0.0) for leg, kind, _ in LYNX_LEGS}
    if clip == "Idle":
        look = curve(u, (0.2, 0), (0.28, 26), (0.45, 26), (0.52, 0), (0.7, 0), (0.76, -18), (0.88, -18), (0.94, 0))
        flick = curve(u, (0.6, 0), (0.62, -25), (0.66, 0))
        body = (0.008 * wave(u, 1), 0.003 * wave(u, 4), 0, 0.8 * wave(u, 4))
        return lynx_assemble(body, home, neck=-4, head=-2, yaw=look, ears=flick,
                             tail=(-8 + 10 * curve(u, (0.3, 0), (0.33, 1), (0.37, 0), (0.8, 0), (0.83, 1), (0.87, 0)), 8 * wave(u, 2)))
    if clip in LYNX_GAITS:
        frames, duty, stride, lift, phases = LYNX_GAITS[clip]
        if clip == "Walk":
            body = (0, -0.012 + 0.007 * math.cos(4 * math.pi * u), 1.5 * wave(u, 2), -1.5 * wave(u, 2))
            return lynx_assemble(body, lynx_feet(u, duty, stride, lift, phases), roll=2 * wave(u, 1), neck=2, head=2,
                                 yaw=3 * wave(u, 1), tail=(-12, 8 * wave(u, 1, 0.2)))
        if clip == "Crouch_Stalk_Loop":
            body = (-0.02, -0.14 + 0.004 * math.cos(4 * math.pi * u), 3, 5)
            return lynx_assemble(body, lynx_feet(u, duty, stride, lift, phases, {"F": 0.25, "H": -0.2}), roll=1.5 * wave(u, 1),
                                 neck=24, head=-2, ears=14, tail=(-22, 12 * wave(u, 2)))
        flex = math.cos(2 * math.pi * u)  # gathered at the hind footfall, stretched at the fore footfall
        air = curve((u - 0.8) % 1.0, (0.0, 0), (0.1, 1), (0.22, 0))  # the gathered suspension, across the loop seam
        body = (0.02 * flex, -0.035 + 0.06 * air, -9 * flex, 18 * flex)
        return lynx_assemble(body, lynx_feet(u, duty, stride, lift, phases, {"F": 0.25, "H": -0.24}), neck=-6, head=0,
                             ears=-25, tail=(-20 + 12 * flex, 0))
    if clip == "Pounce_Windup":
        # A readable crouch: the lynx sinks back onto its haunches, chest low, eyes fixed ahead, treads its hind paws
        # under itself and wiggles its rump before the spring. Ends loaded, in Pounce_Lunge's first pose.
        sink = curve(t, (0, 0), (6, 1))
        body = tuple(v * sink for v in LYNX_CROUCH)
        feet = dict(home)
        for leg, start, end in (("HL", 1, 4), ("HR", 3.5, 6.5)):
            s = curve(t, (start, 0), (end, 1))
            feet[leg] = (LYNX_HOME["H"] + 0.05 * s, 0.05 * math.sin(math.pi * s), 30 * math.sin(math.pi * s))
        for leg, at in (("HL", 7), ("HR", 8.5), ("HL", 10)):
            tread = curve(t, (at - 0.75, 0), (at, 1), (at + 0.75, 0))
            x, z, tilt = feet[leg]
            feet[leg] = (x, z + 0.018 * tread, tilt + 12 * tread)
        wiggle = math.sin(2 * math.pi * (t - 6) / 2.5) * curve(t, (6, 0), (7, 1), (10.5, 1), (11.5, 0))
        return lynx_assemble(body, feet, roll=5 * wiggle, neck=-4 + 16 * sink, head=-2 - 2 * sink, ears=16 * sink,
                             tail=(-8 - 14 * sink, 20 * wiggle))
    if clip == "Pounce_Lunge":
        # Takes off at 3 off the planted hind paws, flies with the forelegs reaching (the consumer moves the root
        # LYNX_POUNCE["distance"] metres from 3 to 8), strikes down with both forepaws and the bite at 8, and lands the
        # hind paws far back, stretched low over its catch.
        k = lambda *keys: curve(t, *keys)
        body = (k((0, LYNX_CROUCH[0]), (3, 0.08), (8, 0.0), (12, -0.06)), k((0, LYNX_CROUCH[1]), (3, -0.02), (5.5, 0.08), (8, -0.08), (12, -0.12)),
                k((0, LYNX_CROUCH[2]), (3, -16), (5.5, -8), (8, 12), (12, 8)), k((0, LYNX_CROUCH[3]), (3, -8), (5.5, -10), (8, 4), (12, 2)))
        joints = lynx_joints(body)
        feet = {}
        for leg, kind, s in LYNX_LEGS:
            jx, jz = joints[kind]
            if kind == "H":
                planted = (LYNX_HOME["H"] + 0.05, 0.0)
                trail = (jx - 0.36, jz - 0.24)
                landed = (-0.36, 0.0)
                a, b = curve(t, (3, 0), (4.5, 1)), curve(t, (8, 0), (11, 1))
                x = planted[0] + (trail[0] - planted[0]) * a + (landed[0] - trail[0]) * b
                z = planted[1] + (trail[1] - planted[1]) * a + (landed[1] - trail[1]) * b
                feet[leg] = (x, max(0.0, z), 55 * a * (1 - b))
            else:
                tuck = (jx + 0.05, jz - 0.27)
                reach = (jx + 0.3, jz - 0.32)
                strike = (0.26 + (0.015 if s > 0 else -0.015), 0.0)
                a, b, c = curve(t, (0, 0), (2.5, 1)), curve(t, (3, 0), (6, 1)), curve(t, (6, 0), (8, 1))
                x = home[leg][0] + (tuck[0] - home[leg][0]) * a + (reach[0] - tuck[0]) * b + (strike[0] - reach[0]) * c
                z = (tuck[1]) * a + (reach[1] - tuck[1]) * b + (strike[1] - reach[1]) * c
                feet[leg] = (x, max(0.0, z), 60 * a - 95 * b + 35 * c)
        return lynx_assemble(body, feet, neck=k((0, 12), (3, -4), (8, 24), (12, 30)), head=k((0, -4), (3, -10), (6, -6), (8, 40), (12, 48)),
                             jaw=k((0, 0), (3, 22), (6, 38), (7.3, 34), (8, 2), (12, 4)), ears=k((0, 16), (3, -35), (12, -30)),
                             tail=(k((0, -22), (3, 10), (8, 0), (12, -20)), 0))
    if clip == "Pounce_Recover":
        # Exposed: it stays stretched low over the catch with its head down, shaking it, broadside and slow; then it
        # gathers its hind paws forward one at a time, rises and settles back into the idle stance.
        start = (-0.06, -0.12, 8, 2)
        rise = curve(t, (7, 0), (19, 1))
        body = tuple(a + (0 - a) * rise for a in start)
        feet = {}
        for leg, kind, s in LYNX_LEGS:
            if kind == "H":
                a, b = (8, 12) if s > 0 else (11, 15)
                p = curve(t, (a, 0), (b, 1))
                feet[leg] = (-0.36 + (LYNX_HOME["H"] + 0.36) * p, 0.06 * math.sin(math.pi * p), 40 * math.sin(math.pi * p))
            else:
                a, b = (14, 16.5) if s > 0 else (16, 18.5)
                p = curve(t, (a, 0), (b, 1))
                x0 = 0.26 + (0.015 if s > 0 else -0.015)
                feet[leg] = (x0 + (LYNX_HOME["F"] - x0) * p, 0.035 * math.sin(math.pi * p), 30 * math.sin(math.pi * p))
        shake = math.sin(2 * math.pi * t / 3) * curve(t, (0, 0), (1, 1), (6, 1), (7.5, 0))
        return lynx_assemble(body, feet, neck=30 * (1 - rise) - 4 * rise, head=48 + (-2 - 48) * rise, yaw=14 * shake, jaw=4 * (1 - rise),
                             ears=-30 * (1 - curve(t, (10, 0), (18, 1))), tail=(-20 * (1 - rise) - 8 * rise, 6 * shake))
    if clip == "Hit":
        jolt = curve(t, (0, 0), (2, 1), (8, 0))
        return lynx_assemble((-0.04 * jolt, 0.015 * jolt, -5 * jolt, -4 * jolt), home, roll=7 * jolt, neck=-8 * jolt, head=-20 * jolt,
                             yaw=16 * jolt, jaw=18 * jolt, ears=-35 * jolt, tail=(15 * jolt, 0))
    # Death: flinches up with a snarl, the hind legs buckle, then it rolls onto its right side and lies still.
    flinch = curve(t, (0, 0), (3, 1), (8, 0))
    buckle = curve(t, (5, 0), (12, 1))
    fall = curve(t, (10, 0), (22, 1))
    settle = curve(t, (22, 0), (24.5, 1), (27, 0))
    roll = 86 * fall - 3 * settle
    # The body rides up over its folding legs mid-roll so nothing digs into the ground.
    body = (-0.03 * flinch, 0.02 * flinch - 0.16 * buckle * (1 - fall) - 0.39 * fall + 0.24 * math.sin(math.pi * fall) ** 1.5 + 0.012 * settle, -6 * flinch - 12 * buckle * (1 - fall), -4 * flinch)
    feet = {leg: (LYNX_HOME[kind], 0.0, 0.0) for leg, kind, _ in LYNX_LEGS}
    relax = {"F": (30, -38, 25), "H": (-25, 35, 30), "FR": (45, -85, 40), "HR": (-50, 95, 40)}  # the lower legs fold in
    return lynx_assemble(body, feet, roll=roll, neck=-14 * flinch + 8 * fall, head=None, yaw=10 * flinch, jaw=30 * flinch + 10 * fall,
                         ears=-35 * flinch - 10 * fall, tail=(10 * flinch - 12 * fall, 0), relax=relax, relaxed=fall)


ADDER_PALETTE = {"scale": (0.47, 0.43, 0.33), "zig": (0.07, 0.06, 0.05), "belly": (0.2, 0.2, 0.2), "eye": (0.72, 0.2, 0.1),
                 "mouth": (0.78, 0.5, 0.5), "tongue": (0.12, 0.05, 0.06), "fang": (0.92, 0.9, 0.82)}
# The adder's spine: ADDER_SEGMENTS equal bones running back from the neck joint at ADDER_NECK_X, with the head forward
# of it. The body's radius along its length (metres from the neck); it lies slightly flattened on the ground.
ADDER_SEGMENTS, ADDER_SEG, ADDER_NECK_X, ADDER_FLAT = 14, 0.093, 0.62, 0.85
ADDER_LENGTH = ADDER_SEGMENTS * ADDER_SEG


def adder_radius(s):
    return curve(s, (0.0, 0.021), (0.12, 0.024), (0.45, 0.037), (0.85, 0.036), (1.06, 0.026), (ADDER_LENGTH, 0.004))


def adder_rest():
    """Spine joints (neck first) at rest: lying straight back along -X."""
    return [Vector((ADDER_NECK_X - i * ADDER_SEG, 0, ADDER_FLAT * adder_radius(i * ADDER_SEG))) for i in range(ADDER_SEGMENTS + 1)]


ADDER_REST = adder_rest()


def adder_body(r, rings=82, around=14):
    """The body as one smooth tube along the rest spine, each ring weighted between the two nearest spine bones, with
    the dark dorsal zigzag, the lateral spots and the belly as face materials."""
    bm, deform = r.bm, r.deform
    group = {name: r.groups.index(name) for name in r.groups}
    ring_verts = []
    for k in range(rings + 1):
        s = ADDER_LENGTH * k / rings
        rad = adder_radius(s)
        centre = Vector((ADDER_NECK_X - s, 0, ADDER_FLAT * rad))
        c = s / ADDER_SEG - 0.5  # position in bone-centre units
        i0 = min(max(int(math.floor(c)), 0), ADDER_SEGMENTS - 1)
        i1 = min(i0 + 1, ADDER_SEGMENTS - 1)
        w1 = min(max(c - i0, 0.0), 1.0) if i1 != i0 else 0.0
        ring = []
        for j in range(around):
            a = 2 * math.pi * j / around
            v = bm.verts.new(centre + Vector((0, rad * math.sin(a), ADDER_FLAT * rad * math.cos(a))))
            v[deform][group[f"Spine{i0 + 1}"]] = 1 - w1
            if w1 > 0:
                v[deform][group[f"Spine{i1 + 1}"]] = w1
            ring.append(v)
        ring_verts.append(ring)
    period = 0.075
    for k in range(rings):
        s = ADDER_LENGTH * (k + 0.5) / rings
        zig = 0.55 * (1 - 4 * abs((s / period) % 1.0 - 0.5))  # triangle wave, radians either side of the spine
        for j in range(around):
            a = 2 * math.pi * (j + 0.5) / around
            a = (a + math.pi) % (2 * math.pi) - math.pi  # 0 on top, +-pi underneath
            face = bm.faces.new((ring_verts[k][j], ring_verts[k][(j + 1) % around], ring_verts[k + 1][(j + 1) % around], ring_verts[k + 1][j]))
            if abs(a) > 2.3:
                key = "belly"
            elif s > 0.03 and abs(a - zig) < 0.36:
                key = "zig"
            elif 0.06 < s < 1.2 and abs(abs(a) - 1.45) < 0.2 and (s / period + (0.5 if a > 0 else 0.0)) % 1.0 < 0.4:
                key = "zig"  # flank spots between the zigzag's points
            else:
                key = "scale"
            face.material_index = r.index[key]
    for k, (end, s) in enumerate(((ring_verts[0], 0.0), (ring_verts[-1], ADDER_LENGTH))):
        tip = bm.verts.new(Vector((ADDER_NECK_X - s - (0.012 if k else 0.0), 0, ADDER_FLAT * adder_radius(s))))
        tip[deform][group["Spine1" if k == 0 else f"Spine{ADDER_SEGMENTS}"]] = 1.0
        for j in range(around):
            a, b = end[j], end[(j + 1) % around]
            face = bm.faces.new((a, tip, b) if k == 0 else (b, tip, a))
            face.material_index = r.index["scale"]


def build_adder(collection):
    rest = ADDER_REST
    n, h = rest[0], ADDER_FLAT * adder_radius(0.0)
    bones = [(f"Spine{i + 1}", tuple(rest[i]), tuple(rest[i + 1]), f"Spine{i}" if i else None) for i in range(ADDER_SEGMENTS)]
    bones += [("Head", tuple(n), (n.x + 0.06, 0, h), "Spine1"), ("Jaw", (n.x + 0.005, 0, h - 0.008), (n.x + 0.06, 0, h - 0.012), "Head"),
              ("Tongue", (n.x + 0.03, 0, h - 0.004), (n.x + 0.07, 0, h - 0.004), "Head")]
    r = Rig("Adder", ADDER_PALETTE, bones)
    adder_body(r)
    x = n.x
    # A broad, flat, slightly triangular viper head over the neck, with the dark crown mark and eye stripe.
    r.ellipsoid("Head", "scale", (x + 0.03, 0, h + 0.004), (0.045, 0.03, 0.017), segments=10, rings=5)
    r.ellipsoid("Head", "scale", (x + 0.062, 0, h + 0.0), (0.018, 0.019, 0.012), segments=7, rings=4)  # snout
    r.ellipsoid("Head", "mouth", (x + 0.035, 0, h - 0.008), (0.035, 0.022, 0.005), segments=7, rings=3)
    r.ellipsoid("Jaw", "belly", (x + 0.033, 0, h - 0.013), (0.038, 0.022, 0.006), segments=8, rings=3)
    for s in (1, -1):
        r.ellipsoid("Head", "zig", (x + 0.02, s * 0.012, h + 0.019), (0.022, 0.006, 0.003), rotation=(0, 0, s * 0.5), segments=5, rings=3)  # crown V
        r.ellipsoid("Head", "zig", (x + 0.012, s * 0.026, h + 0.004), (0.03, 0.006, 0.006), rotation=(0, 0, s * -0.2), segments=5, rings=3)  # eye stripe
        r.ellipsoid("Head", "eye", (x + 0.045, s * 0.022, h + 0.01), (0.008, 0.006, 0.007), segments=5, rings=3)
        r.tube("Head", "fang", (x + 0.06, s * 0.009, h - 0.006), (x + 0.064, s * 0.009, h - 0.02), 0.0025, 0.0006, 4)
        r.tube("Tongue", "tongue", (x + 0.06, 0, h - 0.004), (x + 0.075, s * 0.006, h - 0.004), 0.0018, 0.0008, 4)  # fork
    r.tube("Tongue", "tongue", (x + 0.025, 0, h - 0.004), (x + 0.06, 0, h - 0.004), 0.0025, 0.0018, 4)
    return r.finish(collection)


def frame_of(direction, up):
    d = direction.normalized()
    side = up.cross(d)
    side = side.normalized() if side.length > 1e-6 else Vector((0, 1, 0))
    return Matrix((d, side, d.cross(side))).transposed()  # columns: along, side, up


def adder_assemble(points, head=None, roll=0.0, twist=0.0, jaw=0.0, tongue=0.0, flick=0.0):
    """The adder's pose from its spine joints (neck first, armature space): the neck bone set by a look-at frame (rolled
    ``roll`` degrees, then ``twist`` more spread down the body), every later bone by parallel transport, so a coil or a
    roll never flips the pattern. ``head`` is the snout's world direction (default: along the neck)."""
    pose = {"Spine1": [("loc", tuple(points[0] - ADDER_REST[0]))]}
    world, parent = [], None
    for i in range(ADDER_SEGMENTS):
        rest_dir = ADDER_REST[i + 1] - ADDER_REST[i]
        new_dir = points[i + 1] - points[i]
        if parent is None:
            spin = Quaternion(new_dir.normalized(), math.radians(roll))
            w = (spin.to_matrix() @ frame_of(new_dir, Vector((0, 0, 1))) @ frame_of(rest_dir, Vector((0, 0, 1))).inverted()).to_quaternion()
        else:
            moved = parent @ rest_dir
            w = moved.rotation_difference(new_dir) @ parent
            if twist:
                w = Quaternion(new_dir.normalized(), math.radians(twist / ADDER_SEGMENTS)) @ w
        local = (parent.inverted() @ w) if parent is not None else w
        axis, angle = local.to_axis_angle()
        pose.setdefault(f"Spine{i + 1}", []).append((tuple(axis), math.degrees(angle)))
        world.append(w)
        parent = w
    neck = world[0]
    snout = neck @ Vector((1, 0, 0)) if head is None else Vector(head)
    rest_head = Vector((1, 0, 0))
    w_head = (neck @ rest_head).rotation_difference(snout) @ neck
    axis, angle = (neck.inverted() @ w_head).to_axis_angle()
    pose["Head"] = [(tuple(axis), math.degrees(angle))]
    pose["Jaw"] = [(Y, jaw)]
    pose["Tongue"] = [("loc", (tongue, 0, 0)), (Z, flick)]
    return pose


def adder_ground(points):
    """Rest each joint on the ground at its body radius."""
    return [Vector((p.x, p.y, ADDER_FLAT * adder_radius(i * ADDER_SEG))) for i, p in enumerate(points)]


def adder_turtle(start, heading, turns):
    """Joints on the ground from the neck back: each bone ADDER_SEG long, its heading (degrees about +Z, 180 = straight
    back) turned by ``turns[i]``."""
    points, h = [Vector(start)], heading
    for i in range(ADDER_SEGMENTS):
        h += turns[i]
        a = math.radians(h)
        points.append(points[-1] + ADDER_SEG * Vector((math.cos(a), math.sin(a), 0)))
    return points


def adder_raise(points, heights, anchor):
    """Raise joints ``0 .. anchor - 1`` by ``heights`` (neck first) above the ground, working forward from the joint
    ``anchor``, which stays put: each bone keeps its length, so a raised neck draws the head back along the body."""
    out = [Vector(p) for p in points]
    for i in range(anchor - 1, -1, -1):
        z = ADDER_FLAT * adder_radius(i * ADDER_SEG) + (heights[i] if i < len(heights) else 0.0)
        flat = (points[i] - points[i + 1]).to_2d()
        dz = z - out[i + 1].z
        run = math.sqrt(max(ADDER_SEG * ADDER_SEG - dz * dz, 1e-6))
        step = flat.normalized() * run
        out[i] = Vector((out[i + 1].x + step.x, out[i + 1].y + step.y, z))
    return out


ADDER_SLITHER = {"wavelength": 0.46, "amplitude": 0.065}


def adder_slither(u):
    """Lateral undulation: the joints lie on one fixed sine path in the world and slide along it, so with the root
    moving forward a wavelength per loop every part of the body follows the path the head took."""
    lam, amp, ds = ADDER_SLITHER["wavelength"], ADDER_SLITHER["amplitude"], 0.002
    top = ADDER_NECK_X + lam + 0.1
    pts = [Vector((top - i * ds, amp * math.sin(2 * math.pi * (top - i * ds) / lam), 0)) for i in range(int((lam + 1.9) / ds))]
    arc = [0.0]
    for a, b in zip(pts, pts[1:]):
        arc.append(arc[-1] + (a - b).length)
    neck_index, one_wave = round((lam + 0.1) / ds), round(0.1 / ds)
    per = arc[neck_index] - arc[one_wave]
    joints = []
    for i in range(ADDER_SEGMENTS + 1):
        target = arc[neck_index] - per * u + i * ADDER_SEG
        j = min(bisect.bisect_right(arc, target) - 1, len(arc) - 2)
        p = pts[j].lerp(pts[j + 1], (target - arc[j]) / (arc[j + 1] - arc[j]))
        joints.append(Vector((p.x - lam * u, p.y, 0)))
    return adder_ground(joints)


def adder_coil():
    """The resting coil: the body spirals out flat on the ground, rings a body's width apart, and the neck rises from
    the inner ring to hold the head over the coil, facing forward."""
    turns, radius = [0.0, 40.0], 0.11
    for _ in range(2, ADDER_SEGMENTS):
        turns.append(math.degrees(ADDER_SEG / radius))
        radius += 0.096 * ADDER_SEG / (2 * math.pi * radius)
    pts = adder_ground(adder_turtle(Vector((0.1, -0.1, 0.0)), 180.0, turns))
    return adder_raise(pts, [0.15, 0.085, 0.025], 3)


# The warning posture's horizontal bends (degrees per bone, neck first). Joint ADDER_ANCHOR and everything behind it
# stay where they are through the warning, the strike and the recovery.
ADDER_BEND = (0.0, 18.0, 22.0, 14.0, -30.0, -40.0, -38.0, -20.0, 22.0, 30.0, 24.0, 12.0, 0.0, 0.0)
ADDER_ANCHOR = 8
ADDER_WARN = adder_ground(adder_turtle(Vector((0.12, 0.0, 0.0)), 180.0, ADDER_BEND))


def adder_warn(sway=0.0, coil=0.0, strike=0.0):
    """The forebody raised in an S, head level and forward, the rest lying in a horizontal S behind. ``coil`` raises it
    and draws the head back (the strike's cock); ``strike`` (0..1) straightens the forebody forward and down along the
    ground from the anchored joint; ``sway`` (degrees) swings the raised part side to side."""
    a = ADDER_ANCHOR
    heading = 180.0 + sum(ADDER_BEND[:a + 1])
    total = sum(ADDER_BEND[1:a + 1])
    turns = [(1 - strike) * ADDER_BEND[i] + strike * total / a for i in range(a + 1)]
    turns[1] += sway
    turns[3] -= sway
    pts = [Vector(p) for p in ADDER_WARN]
    for i in range(a - 1, -1, -1):
        heading -= turns[i + 1]
        h = math.radians(heading)
        pts[i] = pts[i + 1] - ADDER_SEG * Vector((math.cos(h), math.sin(h), 0))
    lift = (0.2 + 0.04 * coil, 0.25 + 0.04 * coil, 0.17 + 0.02 * coil, 0.075, 0.018)
    heights = [v * (1 - strike) for v in lift]
    heights[0] += 0.035 * strike  # the struck head stays just off the ground
    return adder_raise(adder_ground(pts), heights, a)
def adder_pose(clip, u):
    t = u * CLIP_FRAMES["marsh-adder"][clip]
    if clip == "Idle_Coil_Loop":
        flicks = sum(curve(u, (c - 0.02, 0), (c, 1), (c + 0.02, 0)) for c in (0.3, 0.35, 0.4, 0.76, 0.81))
        pts = adder_coil()
        pts[0] = pts[0] + Vector((0.004 * wave(u, 1), 0.01 * wave(u, 1, 0.25), 0.003 * wave(u, 2)))
        look = curve(u, (0.45, 0), (0.52, 1), (0.66, 1), (0.72, 0))
        return adder_assemble(pts, head=(math.cos(math.radians(25 * look)), math.sin(math.radians(25 * look)), -0.05), tongue=0.03 * flicks,
                              flick=10 * wave(u, 24) * flicks)
    if clip == "Slither_Loop":
        pts = adder_slither(u)
        direction = (pts[0] - pts[2]).normalized().lerp(Vector((1, 0, 0)), 0.5)
        direction.z = -0.05
        flick = curve(u, (0.5, 0), (0.55, 1), (0.62, 0))
        return adder_assemble(pts, head=tuple(direction), tongue=0.03 * flick, flick=12 * wave(u, 12) * flick)
    if clip == "Warn_Hiss_Loop":
        sway = 7 * wave(u, 1)
        hiss = max(0.0, wave(u, 2, -0.1)) ** 0.7
        pts = adder_warn(sway=sway, coil=0.25 + 0.15 * hiss)
        return adder_assemble(pts, head=(1, 0.1 * wave(u, 1), -0.08), jaw=8 + 34 * hiss, tongue=0.035 * (1 - hiss) * max(0.0, wave(u, 4)),
                              flick=10 * wave(u, 16))
    if clip == "Strike":
        # Cocks back for two frames, then the S whips straight: the head shoots forward and down, the jaw gaping to the
        # bite at 5 (contact), and the body ends stretched along the ground.
        coil = curve(t, (0, 0.25), (2, 1), (3, 1), (4, 0))
        strike = curve(t, (2, 0), (5, 1))
        pts = adder_warn(coil=coil, strike=strike)
        jaw = curve(t, (0, 8), (2, 30), (4, 70), (4.7, 70), (5.2, 10), (10, 6))
        return adder_assemble(pts, head=(1, 0, -0.08 - 0.12 * strike), jaw=jaw)
    if clip == "Strike_Recover":
        # Exposed: lies stretched out with its head down for a beat, then slowly gathers the S back up into the warning
        # posture it started from.
        back = curve(t, (6, 0), (19, 1))
        pts = adder_warn(coil=0.25 * back, strike=1 - back)
        return adder_assemble(pts, head=(1, 0, -0.2 + 0.12 * back), jaw=6 + 2 * back)
    if clip == "Hit":
        jolt = curve(t, (0, 0), (2, 1), (8, 0))
        pts = adder_warn(sway=-14 * jolt, coil=0.25 + 0.6 * jolt)
        return adder_assemble(pts, head=(1, -0.3 * jolt, -0.08 + 0.3 * jolt), jaw=8 + 40 * jolt, roll=12 * jolt)
    # Death: writhes, rolls belly-up along its length and goes limp, stretched out.
    thrash = curve(t, (0, 0), (2, 1), (12, 1), (18, 0))
    writhe = math.sin(2 * math.pi * t / 6) * thrash
    fall = curve(t, (4, 0), (20, 1))
    pts = adder_warn(sway=22 * writhe, coil=0.25 * (1 - fall), strike=fall * 0.85)
    for i, p in enumerate(pts):
        p.y += 0.05 * writhe * math.sin(i * 0.9) * (1 - fall)
        ground = ADDER_FLAT * adder_radius(i * ADDER_SEG)
        # Rolled, the wider side is down; mid-roll the body rides up a little over its own turning flank.
        p.z = max(p.z * (1 - fall) + ground * fall, ground) + 0.15 * ground * fall + 0.006 * fall + 0.02 * math.sin(math.pi * fall) + 0.014 * thrash
    return adder_assemble(pts, head=(1, 0.2 * writhe, -0.06 + 0.06 * fall), jaw=20 * (1 - fall) + 6, roll=150 * fall, twist=40 * fall)


# ---------------------------------------------------------------- highland ram (#782)

# A blackface hill ram: the farm goat's rig and part shapes (farm_animals.build_goat) as its source, rebuilt stout and low
# with a shaggy cream fleece hanging in a fringe, a black face and legs and heavy horns curling back, down and forward
# around the ears.
RAM_PALETTE = {"wool": (0.8, 0.74, 0.62), "fringe": (0.64, 0.58, 0.47), "face": (0.11, 0.09, 0.08), "muzzle": (0.46, 0.42, 0.38),
               "horn": (0.6, 0.54, 0.43), "hoof": (0.1, 0.08, 0.07), "eye": (0.72, 0.56, 0.22)}
RAM_LEGS = (("FL", 0.24, 1), ("FR", 0.24, -1), ("HL", -0.27, 1), ("HR", -0.27, -1))
RAM_PIVOT, RAM_HIP, RAM_THIGH, RAM_SHIN = (-0.36, 0.6), 0.44, 0.22, 0.22  # the Body bone's head (x, z); the leg bones
RAM_HORN = (0.43, 0.78)  # the horns' curl centre (x, z) beside the head


def ram_horn(s, f):
    """A point on the horn curling round the ear on side ``s`` at ``f`` (0 at the skull, 1 at the tip), and its radius:
    up and back from the poll, swinging out clear of the neck, down behind the ear and forward past the cheek."""
    phi = math.radians(75 + 345 * f)
    r = 0.075 + 0.06 * f
    return Vector((RAM_HORN[0] + r * math.cos(phi), s * (0.06 + 0.15 * (1 - (1 - f) ** 2)), RAM_HORN[1] + r * math.sin(phi))), 0.052 - 0.04 * f


def build_ram(collection):
    hip, knee = RAM_HIP, RAM_HIP - RAM_THIGH
    bones = [("Body", (*RAM_PIVOT[:1], 0, RAM_PIVOT[1]), (0.3, 0, 0.64), None), ("Neck", (0.26, 0, 0.66), (0.42, 0, 0.8), "Body"),
             ("Head", (0.42, 0, 0.8), (0.62, 0, 0.66), "Neck"), ("Tail", (-0.42, 0, 0.64), (-0.48, 0, 0.52), "Body")]
    for leg, x, s in RAM_LEGS:
        bones += [(f"Leg{leg}", (x, s * 0.12, hip), (x, s * 0.12, knee), "Body"), (f"Shin{leg}", (x, s * 0.12, knee), (x, s * 0.12, 0.0), f"Leg{leg}")]
    r = Rig("Ram", RAM_PALETTE, bones)
    r.ellipsoid("Body", "wool", (-0.03, 0, 0.6), (0.45, 0.27, 0.27), segments=12, rings=7)
    r.ellipsoid("Body", "wool", (0.2, 0, 0.6), (0.26, 0.26, 0.27), segments=10, rings=6)
    # The shaggy fringe hanging off the flanks and the tufted back and rump.
    for i in range(9):
        x = -0.38 + i * 0.085
        for s in (1, -1):
            # Two staggered, overlapping rows of uneven locks, so the fringe hangs ragged rather than in a row of beads.
            for row, (dx, dy, z) in enumerate(((0.0, 0.215, 0.44), (0.043, 0.235, 0.49))):
                if row and i == 8:
                    continue
                jitter = math.sin(i * 2.9 + s + 1.3 * row)
                r.ellipsoid("Body", "fringe", (x + dx + 0.012 * jitter, s * (dy + 0.01 * jitter), z + 0.025 * math.sin(i * 1.7 + s + row)),
                            (0.062 + 0.012 * jitter, 0.05, 0.1 + 0.025 * jitter), rotation=(s * 0.3, 0.25 * math.sin(i * 2.3 + row), 0.2 * jitter),
                            segments=6, rings=4)
            if i % 2 == 0:
                wobble = math.sin(i * 1.9 + 2 * s)
                r.ellipsoid("Body", "wool", (x + 0.03 + 0.02 * wobble, s * (0.13 + 0.02 * wobble), 0.8 + 0.01 * wobble), (0.1 + 0.015 * wobble, 0.08, 0.05),
                            rotation=(s * 0.45, 0.2 * wobble, 0.3 * wobble), segments=6, rings=4)
    r.ellipsoid("Body", "fringe", (-0.42, 0, 0.5), (0.1, 0.2, 0.14), segments=7, rings=4)
    r.tube("Neck", "wool", (0.22, 0, 0.62), (0.44, 0, 0.8), 0.16, 0.085, 8)
    r.ellipsoid("Neck", "fringe", (0.32, 0, 0.57), (0.14, 0.15, 0.12), segments=7, rings=4)  # the ruff under the throat
    # The black face, the pale muzzle and the forelock.
    r.ellipsoid("Head", "face", (0.5, 0, 0.79), (0.135, 0.085, 0.09), rotation=(0, 0.55, 0), segments=8, rings=5)
    r.tube("Head", "face", (0.52, 0, 0.765), (0.655, 0, 0.655), 0.07, 0.05, 7)
    r.ellipsoid("Head", "muzzle", (0.66, 0, 0.645), (0.04, 0.046, 0.04), segments=6, rings=4)
    r.ellipsoid("Head", "wool", (0.45, 0, 0.89), (0.075, 0.07, 0.04), segments=6, rings=3)
    for s in (1, -1):
        r.ellipsoid("Head", "eye", (0.565, s * 0.072, 0.8), (0.017, 0.013, 0.015), segments=5, rings=3)
        r.ellipsoid("Head", "face", (0.45, s * 0.12, 0.74), (0.05, 0.02, 0.022), rotation=(s * 0.3, 0, -s * 0.6), segments=6, rings=3)
        # Each horn: tapered segments along the curl, a knuckle at each joint so the bends stay closed.
        steps = 14
        for k in range(steps):
            (a, ra), (b, rb) = ram_horn(s, k / steps), ram_horn(s, (k + 1) / steps)
            r.tube("Head", "horn", tuple(a), tuple(b), ra, rb, 7)
            if k:
                r.ellipsoid("Head", "horn", tuple(a), (ra * 0.97,) * 3, segments=7, rings=3)
    r.ellipsoid("Tail", "wool", (-0.46, 0, 0.58), (0.05, 0.05, 0.09), segments=6, rings=3)
    for leg, x, s in RAM_LEGS:
        y = s * 0.12
        r.tube(f"Leg{leg}", "wool", (x, y, hip + 0.06), (x, y, knee - 0.01), 0.075, 0.055, 7)
        r.ellipsoid(f"Leg{leg}", "wool", (x, y * 0.9, hip + 0.04), (0.12, 0.09, 0.13), segments=8, rings=5)
        r.tube(f"Shin{leg}", "face", (x, y, knee + 0.02), (x, y, 0.045), 0.031, 0.026, 6)
        r.tube(f"Shin{leg}", "hoof", (x, y, 0.05), (x, y, 0.0), 0.029, 0.036, 6)
    armature, mesh = r.finish(collection)
    # Smooth-shaded, so the fleece reads as soft locks instead of faceted stone; the hooves stay crisp.
    hoof = list(RAM_PALETTE).index("hoof")
    for poly in mesh.data.polygons:
        poly.use_smooth = poly.material_index != hoof
    return armature, mesh


def ram_hips(loc, pitch):
    return body_hips(loc, pitch, RAM_PIVOT, RAM_HIP, RAM_LEGS)


def ram_legs(pose, hips, pitch, feet):
    return two_bone_legs(pose, hips, pitch, feet, RAM_THIGH, RAM_SHIN)


def ram_gallop(pose, u, amount=1.0):
    """A bounding gallop: the hind pair then the fore pair."""
    for leg, phase in (("HL", 0.0), ("HR", 0.07), ("FL", 0.5), ("FR", 0.57)):
        pose.setdefault(f"Leg{leg}", []).append((Y, -40 * amount * wave(u, 1, phase)))
        pose.setdefault(f"Shin{leg}", []).append((Y, 55 * amount * max(0.0, wave(u, 1, phase + 0.25))))
    return pose


# The stag's and ram's charges (#782): (first frame, contact frame, metres) the consumer moves the root in a straight line
# while the clip gallops in place.
CHARGES = {("stag", "Attack_B"): (8, 15, 2.0), ("highland-ram", "Attack_B"): (6, 13, 1.6)}


def ram_pose(clip, u):
    t = u * CLIP_FRAMES["highland-ram"][clip]
    if clip == "Idle":
        # Chews the cud, looks slowly round, flicks its tail.
        return {"Body": [("loc", (0, 0, 0.004 * wave(u, 2)))], "Neck": [(Z, 14 * wave(u, 1, 0.1)), (Y, -4 * wave(u, 1))],
                "Head": [(Y, 2.5 * wave(u, 16)), (X, 3 * wave(u, 2, 0.3))], "Tail": [(X, 25 * wave(u, 6) * max(0.0, wave(u, 1)))]}
    if clip == "Walk":
        pose = {"Body": [("loc", (0, 0, 0.012 * abs(wave(u, 1)))), (X, 2 * wave(u, 1))], "Neck": [(Y, 4 * wave(u, 2, 0.25))], "Tail": [(X, 10 * wave(u, 2))]}
        return quad_gait(pose, u, ("HL", "FL", "HR", "FR"), 22, 30)
    if clip == "Eat":
        # Grazes: the forefeet a little forward, the shoulders down and the head in the grass, cropping in short tugs.
        tug = max(0.0, wave(u, 3)) ** 2
        pose = {"Body": [("loc", (0, 0, -0.03)), (Y, 8)], "Neck": [(Y, 70 + 3 * wave(u, 1.5))], "Head": [(Y, 18 - 10 * tug), (Z, 6 * wave(u, 1))],
                "Tail": [(X, 15 * wave(u, 4))]}
        return ram_legs(pose, ram_hips((0, -0.03), 8), 8, {leg: (x + (0.05 if leg[0] == "F" else 0.0), 0.0) for leg, x, _ in RAM_LEGS})
    if clip == "Run":
        pose = {"Body": [("loc", (0, 0, 0.05 * max(0.0, wave(u, 1, 0.1)))), (Y, 6 * wave(u, 1))], "Neck": [(Y, -5 * wave(u, 1, 0.25))], "Tail": [(Y, -20)]}
        return ram_gallop(pose, u)
    if clip == "Alert":
        # The warning: the head drops to present the horns, the weight rocks back, the right forefoot stamps twice and the
        # left once, and a snort shakes the head.
        low = curve(t, (0, 0), (5, 1), (20, 1), (24, 0))
        stamps = {"FR": curve(t, (6, 0), (8, 1), (9.5, 0), (12, 0), (14, 1), (15.5, 0)), "FL": curve(t, (15.5, 0), (17, 1), (18.5, 0))}
        snort = math.sin(2 * math.pi * (t - 18) / 3) * curve(t, (17, 0), (18, 1), (21, 1), (22, 0))
        loc, pitch = (-0.04 * low, -0.025 * low), 4 * low
        pose = {"Body": [("loc", (loc[0], 0, loc[1])), (Y, pitch)], "Neck": [(Y, 28 * low)],
                "Head": [(Y, 38 * low), (Z, 10 * snort), (X, 6 * snort)], "Tail": [(Y, -25 * low)]}
        feet = {leg: (x + 0.05 * stamps.get(leg, 0.0), 0.11 * stamps.get(leg, 0.0)) for leg, x, _ in RAM_LEGS}
        return ram_legs(pose, ram_hips(loc, pitch), pitch, feet)
    if clip == "Attack_A":
        # Rear and butt: the ram rocks back and rears onto its hind legs, forelegs tucked and the head drawn back, then
        # throws its whole weight forward and down so the horns smash in at 11/22, forefeet landing braced a stride ahead,
        # hind legs driving straight behind; it shakes it off and steps back.
        k = lambda *keys: curve(t, (0, 0), *keys, (22, 0))
        rear = curve(t, (0, 0), (2, 0.1), (6.5, 1), (8, 1), (10.5, 0))
        pitch = k((2, 3), (6.5, -36), (8, -36), (10.5, 6), (11, 10), (13, 6), (17, 0))
        loc = (k((2, 0.03), (6.5, -0.08), (8, -0.07), (11, 0.13), (13, 0.11), (18, 0.03)), k((2, -0.02), (6.5, -0.11), (8, -0.11), (11, -0.045), (13, -0.03), (17, 0)))
        pose = {"Body": [("loc", (loc[0], 0, loc[1])), (Y, pitch)],
                "Neck": [(Y, k((2, 6), (6.5, -18), (8, -14), (10.5, 30), (11, 36), (14, 26), (19, 4)))],
                "Head": [(Y, k((6.5, -14), (10.5, 34), (11, 42), (14, 30), (19, 4))), (Z, 10 * math.sin(2 * math.pi * (t - 14) / 3) * curve(t, (13, 0), (14, 1), (17, 1), (18, 0)))],
                "Tail": [(Y, k((3, -40), (16, -40)))]}
        hips = ram_hips(loc, pitch)
        reach = curve(t, (8, 0), (10.5, 1), (15, 1), (19, 0))
        lift = 0.05 * curve(t, (15, 0), (17, 1), (19, 0))
        feet = {}
        for leg, x, _ in RAM_LEGS:
            if leg[0] == "H":
                feet[leg] = (x, 0.0)
            else:
                hx, hz = hips[leg]
                planted = (x + 0.15 * reach, lift)
                feet[leg] = (planted[0] + (hx + 0.02 - planted[0]) * rear, planted[1] + (hz - 0.3 - planted[1]) * rear)
        return ram_legs(pose, hips, pitch, feet)
    if clip == "Attack_B":
        # The short charge: head lowered and a forefoot scrape, a bounding rush with the horns level (the consumer moves the
        # root from 6 to 13), the head driven in at the contact (13/30) with the forelegs braced and the hind legs thrust
        # out, a recoil, and an exposed, dazed head-shaking recovery.
        k = lambda *keys: curve(t, (0, 0), *keys, (30, 0))
        low = curve(t, (0, 0), (4, 1), (13, 1), (16, 0.3), (24, 0))
        rush = curve(t, (5, 0), (6.5, 1), (11.5, 1), (12.5, 0))
        brace = curve(t, (11.5, 0), (13, 1), (16, 1), (20, 0))
        scrape = curve(t, (0.5, 0), (2, 1), (3.5, 0))
        daze = math.sin(2 * math.pi * (t - 17) / 4) * curve(t, (16, 0), (18, 1), (24, 1), (27, 0))
        bound = 0.045 * rush * max(0.0, wave((t - 6) / 7, 1, 0.1))
        loc = (k((4, -0.05), (6, -0.04), (12, 0.03), (13, 0.12), (16, -0.04), (21, 0)), k((4, -0.03), (6, -0.01), (13, -0.02), (16, 0)) + bound)
        pitch = k((4, 4), (12, 5), (13, 9), (16, -4), (21, 0)) + 5 * rush * wave((t - 6) / 7, 1)
        pose = {"Body": [("loc", (loc[0], 0, loc[1])), (Y, pitch), (X, 4 * daze)],
                "Neck": [(Y, 26 * low + 10 * brace - k((15, 0), (16, 12), (20, 0)))],
                "Head": [(Y, 36 * low + 8 * brace - k((15, 0), (16, 16), (20, 0))), (Z, 16 * daze), (X, 8 * daze)],
                "Tail": [(Y, k((2, -35), (22, -35)))]}
        # Feet: planted, the right forefoot scraping, a bounding gallop through the rush, then braced: forefeet a stride
        # ahead, hind feet thrust back.
        feet = {}
        for leg, x, _ in RAM_LEGS:
            phase = {"HL": 0.0, "HR": 0.07, "FL": 0.5, "FR": 0.57}[leg]
            p = ((t - 6) / 7 + phase) % 1
            stride, lift = (0.14 - 0.28 * p / 0.4, 0.0) if p < 0.4 else (-0.14 + 0.28 * (p - 0.4) / 0.6, 0.12 * math.sin(math.pi * (p - 0.4) / 0.6))
            braced = (0.12 if leg[0] == "F" else -0.1) * brace + (-0.04 if leg[0] == "H" else 0.0) * curve(t, (2, 0), (4, 1), (6, 0))
            feet[leg] = (x + loc[0] * rush + stride * rush + braced + (0.06 * scrape if leg == "FR" else 0.0),
                         lift * rush + (0.06 * scrape if leg == "FR" else 0.0))
        return ram_legs(pose, ram_hips(loc, pitch), pitch, feet)
    if clip == "Hit":
        jolt = curve(t, (0, 0), (2, 1), (8, 0))
        return {"Body": [("loc", (-0.05 * jolt, 0, 0.015 * jolt)), (X, 7 * jolt)], "Neck": [(Y, -14 * jolt)], "Head": [(Y, -14 * jolt), (Z, 12 * jolt)],
                "Tail": [(Y, -30 * jolt)]}
    # Death: staggers, the forelegs buckle onto the knees, then a heavy roll onto the right side; lies still.
    fall = curve(t, (10, 0), (21, 1))
    settle = curve(t, (21, 0), (24, 1), (27, 0))
    buckle = curve(t, (3, 0), (10, 1), (21, 0.3))
    roll = math.radians(90 * fall)
    # The spine rolls 0.6 m up: sink it by the lower of its hooves and the fringe hanging off its flank.
    lowest = min(0.6 - 0.12 * math.sin(roll) - 0.6 * math.cos(roll), 0.6 - max(0.3 * math.sin(roll) + 0.2 * math.cos(roll), 0.27))
    pose = {"Body": [("loc", (0, 0, -lowest - 0.02 * buckle * (1 - fall) + 0.02 * settle)), (Y, 4 * buckle * (1 - fall)), (X, 90 * fall - 4 * settle)],
            "Neck": [(Y, curve(t, (0, 0), (4, -20), (12, 20), (24, 10)))], "Head": [(Y, curve(t, (0, 0), (4, -15), (12, 10), (24, 20))), (Z, curve(t, (2, 0), (6, 14), (12, 0)))],
            "Tail": [(Y, curve(t, (0, 0), (24, -10)))]}
    for leg in ("FL", "FR"):
        pose[f"Leg{leg}"] = [(Y, 30 * buckle)]
        pose[f"Shin{leg}"] = [(Y, -60 * buckle + 20 * fall)]
    for leg in ("HL", "HR"):
        pose[f"Leg{leg}"] = [(Y, -15 * fall)]
        pose[f"Shin{leg}"] = [(Y, 15 * fall)]
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
    "lynx": {"Idle": 96, "Walk": 24, "Run": 10, "Crouch_Stalk_Loop": 36, "Pounce_Windup": 12, "Pounce_Lunge": 12, "Pounce_Recover": 20,
             "Hit": 8, "Death": 32},
    "marsh-adder": {"Idle_Coil_Loop": 96, "Slither_Loop": 24, "Warn_Hiss_Loop": 32, "Strike": 10, "Strike_Recover": 20, "Hit": 8, "Death": 30},
    "highland-ram": {"Idle": 96, "Walk": 28, "Eat": 72, "Run": 14, "Attack_A": 22, "Attack_B": 30, "Hit": 8, "Death": 32, "Alert": 24},
}


def build_authored(animal, collection):
    if animal in BIRDS:
        armature, mesh = build_bird(animal, collection)
        pose_of = lambda clip, u: bird_pose(animal, clip, u)
    else:
        armature, mesh = {"rabbit": build_rabbit, "boar": build_boar, "bear": build_bear, "spider": build_spider, "marsh-lurker": build_lurker,
                          "lynx": build_lynx, "marsh-adder": build_adder, "highland-ram": build_ram}[animal](collection)
        pose_of = {"rabbit": rabbit_pose, "boar": boar_pose, "bear": bear_pose, "spider": spider_pose, "marsh-lurker": lurker_pose,
                   "lynx": lynx_pose, "marsh-adder": adder_pose, "highland-ram": ram_pose}[animal]
    actions = {}
    for clip, count in CLIP_FRAMES[animal].items():
        action = bpy.data.actions.new(clip)
        slot_for(armature, action)
        # The lynx and adder key every frame: their planted paws and path-following body are solved per frame.
        every = count <= 16 or clip in ONE_SHOT or animal in ("lynx", "marsh-adder")
        for frame in range(0, count + 1, 1 if every else 2):
            key_pose(armature, frame, pose_of(clip, frame / count))
        actions[clip] = action
    for action in actions.values():
        for fcurve in getattr(action, "fcurves", ()):
            for point in fcurve.keyframe_points:
                point.interpolation = "LINEAR"
    return armature, [mesh], actions


# ---------------------------------------------------------------- organic surface (#782, #779)

# Material -> (detail, metres per texture repeat, roughness); detail None keeps a plain colour. Every animal lists every
# material and every material ships nonmetallic: the Quaternius GLBs author metallic 0.4 and roughness 0.415, which a PBR
# renderer draws as dull metal. Each detailed material multiplies its colour by a small tileable greyscale detail texture
# (glTF baseColorTexture times baseColorFactor), so coats read as hair or wool, the lurker as warty hide, the spider as
# bristled chitin, the adder as scales and the birds as feathers at the game camera rather than smooth plastic or metal.
# The textures are shared by kind, so the bundle carries each once.
EYE = (None, 0, 0.3)
COAT = lambda tile=0.3, roughness=0.9: ("hair", tile, roughness)
FEATHERS = lambda palette, animal: {f"{animal.capitalize()}-{key}": (("feather", 0.05 if animal == "songbird" else 0.1, 0.9) if key not in ("beak", "leg", "eye")
                                                                       else EYE if key == "eye" else ("skin", 0.04, 0.7) if key == "leg" else (None, 0, 0.55))
                                    for key in palette}
ORGANIC = {
    "stag": {"Material.002": COAT(), "Material.003": COAT(), "Material.010": COAT(), "Material.001": ("antler", 0.2, 0.7), "Material.011": EYE},
    "doe": {"Main": COAT(), "Main_Light": COAT(), "Main_Dark": COAT(), "Hooves": (None, 0, 0.7), "Eye_Lighter": EYE, "Eye_Black": EYE, "Eye_White": EYE},
    "fox": {"Main": COAT(0.16), "Main_Light": COAT(0.16), "Grey": COAT(0.16), "Black": COAT(0.16), "Eyes": EYE},
    "wolf": {"Main": COAT(0.22), "Main_Light": COAT(0.22), "Eyes_Black": EYE, "Nose": (None, 0, 0.5)},
    "rat": {"Grey": COAT(0.1), "Pink": ("skin", 0.06, 0.7)},
    "rabbit": {"Rabbit-fur": COAT(0.1), "Rabbit-pale": COAT(0.1), "Rabbit-pink": ("skin", 0.06, 0.7), "Rabbit-dark": EYE},
    "boar": {"Boar-coat": COAT(0.2, 0.95), "Boar-dark": COAT(0.2, 0.95), "Boar-snout": ("skin", 0.12, 0.7), "Boar-tusk": ("horn", 0.06, 0.55),
             "Boar-eye": EYE},
    "bear": {"Bear-fur": COAT(0.3, 0.95), "Bear-dark": COAT(0.3, 0.95), "Bear-muzzle": COAT(0.16), "Bear-nose": (None, 0, 0.45),
             "Bear-claw": ("horn", 0.05, 0.55), "Bear-mouth": ("skin", 0.1, 0.6), "Bear-eye": EYE},
    "spider": {"Spider-body": ("chitin", 0.16, 0.6), "Spider-dark": ("chitin", 0.16, 0.6), "Spider-band": ("chitin", 0.16, 0.6),
               "Spider-mark": ("chitin", 0.16, 0.6), "Spider-eye": (None, 0, 0.2), "Spider-fang": ("horn", 0.04, 0.45)},
    "marsh-lurker": {"MarshLurker-back": ("hide", 0.14, 0.6), "MarshLurker-dark": ("hide", 0.14, 0.6), "MarshLurker-belly": ("skin", 0.1, 0.55),
                     "MarshLurker-eye": (None, 0, 0.25), "MarshLurker-pupil": EYE, "MarshLurker-mouth": ("skin", 0.06, 0.5),
                     "MarshLurker-tooth": (None, 0, 0.5)},
    "lynx": {"Lynx-coat": COAT(0.16), "Lynx-pale": COAT(0.16), "Lynx-spot": COAT(0.16), "Lynx-dark": COAT(0.16), "Lynx-eye": EYE,
             "Lynx-mouth": ("skin", 0.06, 0.6), "Lynx-tooth": (None, 0, 0.5)},
    "marsh-adder": {"Adder-scale": ("scales", 0.08, 0.6), "Adder-zig": ("scales", 0.08, 0.6), "Adder-belly": ("scales", 0.08, 0.55),
                    "Adder-eye": (None, 0, 0.25), "Adder-mouth": ("skin", 0.04, 0.5), "Adder-tongue": (None, 0, 0.5), "Adder-fang": (None, 0, 0.45)},
    "highland-ram": {"Ram-wool": ("wool", 0.24, 0.95), "Ram-fringe": ("wool", 0.2, 0.95), "Ram-face": ("hair", 0.16, 0.8),
                     "Ram-muzzle": ("hair", 0.16, 0.8), "Ram-horn": ("horn", 0.08, 0.6), "Ram-hoof": (None, 0, 0.8), "Ram-eye": (None, 0, 0.8)},
    **{bird: FEATHERS(BIRD_SPECS[bird]["palette"], bird) for bird in BIRDS},
}
# The authored animals built from rigid parts shade smooth within SMOOTH_ANGLE and keep sharp creases (tube caps) beyond
# it, so their ellipsoids read as rounded bodies rather than faceted, polished solids. The ram sets its own smoothing.
SMOOTH_ANGLE = 75.0
DETAIL_SIZE = 128
HORN_RINGS = 20  # growth rings along a whole curl of the ram's horn


def lattice(ix, iy, seed):
    h = (ix * 374761393 + iy * 668265263 + seed * 982451653) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def tile_noise(x, y, cells_x, cells_y, seed):
    """Smooth value noise over the unit square that tiles: ``cells_x`` by ``cells_y`` lattice cells."""
    fx, fy = x * cells_x, y * cells_y
    ix, iy = math.floor(fx), math.floor(fy)
    sx, sy = fx - ix, fy - iy
    sx, sy = sx * sx * (3 - 2 * sx), sy * sy * (3 - 2 * sy)
    at = lambda a, b: lattice(a % cells_x, b % cells_y, seed)
    top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx
    bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx
    return top + (bottom - top) * sy


def detail_texel(kind, x, y):
    """The linear multiplier (r, g, b) of a detail texture at (x, y) in the unit square; about 0.9 on average."""
    if kind == "hair":  # streaked tufts of short strands along v over a soft mottle, coarse enough to read at the game camera
        n = 0.45 * tile_noise(x, y, 24, 4, 1) + 0.35 * tile_noise(x, y, 48, 8, 2) + 0.2 * tile_noise(x, y, 96, 16, 3)
        b = (0.88 + 0.65 * (n - 0.5)) * (0.88 + 0.22 * tile_noise(x, y, 6, 6, 4))
        return b, b, b * 0.97
    if kind == "wool":  # clumped locks, darker and warmer in the creases between them
        c = 0.5 * tile_noise(x, y, 16, 16, 5) + 0.3 * tile_noise(x, y, 32, 32, 6) + 0.2 * tile_noise(x, y, 64, 64, 7)
        s = min(max((c - 0.25) / 0.5, 0.0), 1.0)
        b = 0.68 + 0.34 * s * s * (3 - 2 * s)
        return b, b * (0.95 + 0.05 * b), b * (0.86 + 0.14 * b)
    if kind == "horn":  # growth rings across v, a little uneven, with fine grain
        ring = 0.5 + 0.5 * math.cos(2 * math.pi * (8 * y + 0.3 * tile_noise(x, y, 4, 8, 8)))
        b = 0.8 + 0.16 * ring + 0.22 * (tile_noise(x, y, 32, 16, 9) - 0.5)
        return b, b * 0.98, b * 0.93
    if kind == "antler":  # grooves along v and a rough burr
        b = 0.66 + 0.4 * tile_noise(x, y, 24, 3, 10) + 0.14 * (tile_noise(x, y, 64, 64, 11) - 0.5)
        return b, b, b * 0.98
    if kind == "skin":  # soft blotches, ruddier where darker, with a fine pore grain
        m = tile_noise(x, y, 6, 6, 12)
        b = 0.9 + 0.16 * (m - 0.5) + 0.08 * (tile_noise(x, y, 48, 48, 13) - 0.5)
        return b * (1.0 + 0.04 * (0.5 - m)), b, b * (0.97 + 0.06 * m)
    if kind == "feather":  # overlapping rows of round-tipped feathers, darker at each tip's rim, with barbs along v
        row = math.floor(y * 8)
        fx = x * 6 + 0.5 * (row % 2)
        cx, cy = fx - math.floor(fx) - 0.5, y * 8 - row
        rim = smoothstep(0.7, 0.95, cy + 1.2 * cx * cx)
        b = (0.98 - 0.3 * rim + 0.1 * (tile_noise(x, y, 48, 6, 14) - 0.5)) * (0.9 + 0.16 * tile_noise(x, y, 4, 4, 15))
        return b, b * 0.98, b * 0.95
    if kind == "hide":  # the lurker's warty amphibian hide: raised pale-topped warts with dark rims over large mottling
        w = 0.65 * tile_noise(x, y, 14, 14, 16) + 0.35 * tile_noise(x, y, 28, 28, 17)
        wart, rim = smoothstep(0.58, 0.7, w), smoothstep(0.5, 0.58, w) - smoothstep(0.58, 0.66, w)
        b = (0.92 + 0.22 * wart - 0.22 * rim) * (0.78 + 0.34 * tile_noise(x, y, 3, 3, 18))
        return b * (1.0 - 0.04 * wart), b, b * (0.92 + 0.06 * wart)
    if kind == "chitin":  # the spider's segmented plates with dark seams across v, a dull sheen mottle and fine bristles
        seam = smoothstep(0.82, 0.97, 0.5 + 0.5 * math.cos(2 * math.pi * (6 * y + 0.25 * tile_noise(x, y, 3, 6, 19))))
        bristle = 0.5 * tile_noise(x, y, 64, 8, 20) + 0.5 * tile_noise(x, y, 128, 16, 21)
        b = (0.95 - 0.45 * seam + 0.42 * (bristle - 0.5)) * (0.86 + 0.26 * tile_noise(x, y, 4, 4, 22))
        return b, b * 0.97, b * 0.92
    # scales: staggered rows of keeled oval scales across v, each darker at its rim, with a slight per-scale tint
    row = math.floor(y * 10)
    fx = x * 8 + 0.5 * (row % 2)
    cell = math.floor(fx)
    cx, cy = fx - cell - 0.5, y * 10 - row - 0.5
    rim = smoothstep(0.32, 0.5, math.hypot(cx * 1.15, cy))
    tint = lattice(cell % 8, row % 10, 23)
    b = (1.0 - 0.36 * rim + 0.12 * (0.5 - abs(cx)) - 0.06) * (0.9 + 0.14 * tint)
    return b, b * 0.98, b * 0.93


def smoothstep(a, b, v):
    s = min(max((v - a) / (b - a), 0.0), 1.0)
    return s * s * (3 - 2 * s)


def detail_image(name, kind):
    image = bpy.data.images.new(name, DETAIL_SIZE, DETAIL_SIZE, alpha=False)
    srgb = lambda v: 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055
    pixels = []
    for j in range(DETAIL_SIZE):
        for i in range(DETAIL_SIZE):
            pixels += [round(srgb(min(c, 1.0)) * 255) / 255 for c in detail_texel(kind, i / DETAIL_SIZE, j / DETAIL_SIZE)] + [1.0]
    image.pixels = pixels
    image.pack()
    return image


def organic_surface(animal, meshes):
    """UV-map ``meshes`` (box-projected at the shipped size; the ram's horns along their curl), give every material its
    ``ORGANIC`` roughness, metallic 0 and detail texture, and smooth the authored animals' rigid parts."""
    spec = ORGANIC[animal]
    missing = sorted({s.material.name for obj in meshes for s in obj.material_slots if s.material} - set(spec))
    if missing:
        raise ValueError(f"{animal}: ORGANIC lists no surface for {missing}")
    zs = [(obj.matrix_world @ v.co).z for obj in meshes for v in obj.data.vertices]
    height = ANIMALS[animal]["height"]
    metre = height / (max(zs) - min(zs)) if height else 1.0  # metres per world unit once shipped
    for obj in meshes:
        mesh = obj.data
        if ANIMALS[animal]["format"] == "authored" and animal != "highland-ram":
            mesh.shade_smooth()
            mesh.set_sharp_from_angle(angle=math.radians(SMOOTH_ANGLE))
        layer = mesh.uv_layers.get("UVMap") or mesh.uv_layers.new(name="UVMap")
        normals = obj.matrix_world.to_3x3().inverted().transposed()
        for poly in mesh.polygons:
            material = obj.material_slots[poly.material_index].material if obj.material_slots else None
            kind, tile, _ = spec.get(material.name if material else "", ("hair", 0.3, 0.8))
            tile = tile or 0.3
            points = [obj.matrix_world @ mesh.vertices[mesh.loops[i].vertex_index].co for i in poly.loop_indices]
            if kind == "horn" and animal == "highland-ram":
                # Rings follow the angle round the curl's centre, unwrapped about the face's own angle.
                centre = sum(points, Vector((0, 0, 0))) / len(points)
                mid = math.atan2(centre.z - RAM_HORN[1], centre.x - RAM_HORN[0])
                for i, p in zip(poly.loop_indices, points):
                    phi = math.atan2(p.z - RAM_HORN[1], p.x - RAM_HORN[0])
                    phi = mid + (phi - mid + math.pi) % (2 * math.pi) - math.pi
                    layer.data[i].uv = ((abs(p.y) + math.hypot(p.x - RAM_HORN[0], p.z - RAM_HORN[1])) * metre / tile, phi * HORN_RINGS / (16 * math.pi))
                continue
            n = normals @ poly.normal
            axis = max(range(3), key=lambda k: abs(n[k]))
            for i, p in zip(poly.loop_indices, points):
                a, b = (p[k] for k in range(3) if k != axis)
                layer.data[i].uv = (a * metre / tile, b * metre / tile)
    images = {}
    materials = {slot.material.name: slot.material for obj in meshes for slot in obj.material_slots if slot.material}
    for name in sorted(materials):
        kind, _, roughness = spec[name]
        tree = materials[name].node_tree
        shader = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Metallic"].default_value = 0.0
        if kind is None:
            continue
        if kind not in images:
            images[kind] = detail_image(f"{animal}-{kind}", kind)
        texture = tree.nodes.new("ShaderNodeTexImage")
        texture.image = images[kind]
        mix = tree.nodes.new("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs[7].default_value = shader.inputs["Base Color"].default_value
        tree.links.new(texture.outputs["Color"], mix.inputs[6])
        tree.links.new(mix.outputs[2], shader.inputs["Base Color"])


# ---------------------------------------------------------------- shared

def root_motion(animal, clip, scale):
    """How a consumer moves the root under the lynx's and adder's travelling clips, in metres at the shipped scale: a
    gait's even ``travelSpeed`` keeps every planted paw (or the adder's body on its path) still on the ground, and the
    pounce's ``rootTravel`` carries the lynx through its flight in a straight line."""
    if animal == "lynx" and clip in LYNX_GAITS:
        frames, duty, stride = LYNX_GAITS[clip][:3]
        return {"travelSpeed": round(scale * stride / (duty * frames / FPS), 4)}
    if animal == "lynx" and clip == "Pounce_Lunge":
        return {"rootTravel": {"metres": round(scale * LYNX_POUNCE["distance"], 4), "startSeconds": round(LYNX_POUNCE["takeoff"] / FPS, 5),
                               "endSeconds": round(LYNX_POUNCE["land"] / FPS, 5)}}
    if (animal, clip) in CHARGES:
        start, end, metres = CHARGES[animal, clip]
        return {"rootTravel": {"metres": metres, "startSeconds": round(start / FPS, 5), "endSeconds": round(end / FPS, 5)}}
    if animal == "marsh-adder" and clip == "Slither_Loop":
        return {"travelSpeed": round(scale * ADDER_SLITHER["wavelength"] / (CLIP_FRAMES[animal][clip] / FPS), 4)}
    return {}


def prepare(animal, source_path):
    """Load or build ``animal`` into the current scene, normalised; return its root and measurements."""
    spec = ANIMALS[animal]
    collection = bpy.context.scene.collection
    if spec["format"] == "authored":
        armature, meshes, actions = build_authored(animal, collection)
    else:
        armature, meshes, actions = load_source(animal, source_path)
    if animal in ORGANIC:
        organic_surface(animal, meshes)
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
    rest, move = spec.get("rest", "Idle"), spec.get("move", "Walk")
    slot_for(armature, actions[rest])
    scene = bpy.context.scene
    scene.frame_set(int(actions[rest].frame_range[0]))
    bpy.context.view_layer.update()
    low, high = bounds(meshes)
    root.scale = ((spec["height"] / (high.z - low.z)) if spec["height"] else 1.0,) * 3
    bpy.context.view_layer.update()
    low, high = bounds(meshes)
    root.location = Vector((-(low.x + high.x) / 2, -(low.y + high.y) / 2, -low.z))
    bpy.context.view_layer.update()
    low, high = bounds(meshes)

    # In-place check: the walk's horizontal travel of the mesh centre over the clip, in metres.
    slot_for(armature, actions[move])
    start, end = (int(round(v)) for v in actions[move].frame_range)
    centres = []
    for frame in (start, end):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        a, b = bounds(meshes)
        centres.append(((a.x + b.x) / 2, (a.y + b.y) / 2))
    slot_for(armature, actions[rest])
    scene.frame_set(int(actions[rest].frame_range[0]))
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
                         **({"contactSeconds": round(CONTACT_FRAMES[animal][name] / FPS, 5)} if name in CONTACT_FRAMES.get(animal, {}) else {}),
                         **root_motion(animal, name, root.scale.x)}
                  for name, frames in measured["frames"].items()},
        "walkTravel": round(measured["travel"], 4),
        "restClip": ANIMALS[animal].get("rest", "Idle"), "moveClip": ANIMALS[animal].get("move", "Walk"),
        **({"length": round(ADDER_LENGTH + 0.092, 4)} if animal == "marsh-adder" else {}),
    }
