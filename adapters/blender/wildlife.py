"""Greyhaven wildlife: a stag, a doe, a fox, a rabbit, a wild boar, a crow, a duck, a heron and a songbird for
Greyhaven's woods, meadows and river.

The stag, doe and fox come from CC0 Quaternius *Ultimate Animated Animals* (``Stag.glb``, ``Deer.glb``, ``Fox.glb``),
each the declared ``source`` input; the recipe keeps their skinned mesh, armature and the ``Idle``, ``Walk`` and
``Eating`` clips (shipped as ``Eat``). The stag's antlers are parented to its head bone in the source, so they are bound
to that bone as a second skinned mesh. No CC0 Quaternius rabbit, boar or bird exists, so those six are original:
low-poly rigid parts on a small armature, every vertex weighted fully to one bone, with scripted ``Idle``, ``Walk`` and
``Eat`` loops, and a ``Fly`` wingbeat loop on the four birds.

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
from mathutils import Vector

FPS = 24
SHARED = ("Rig", "key_pose", "wave", "slot_for", "bounds", "principled_from_diffuse")
UAA_CLIPS = {"Idle": "AnimalArmature|Idle", "Walk": "AnimalArmature|Walk", "Eat": "AnimalArmature|Eating"}
# height: metres at the top of the idle pose, antlers and ears included. turn: degrees about Blender +Z to face glTF +Z.
ANIMALS = {
    "stag": {"format": "glb", "turn": 0.0, "height": 2.0},
    "doe": {"format": "glb", "turn": 0.0, "height": 1.45},
    "fox": {"format": "glb", "turn": 0.0, "height": 0.5},
    "rabbit": {"format": "authored", "turn": -90.0, "height": 0.3},
    "boar": {"format": "authored", "turn": -90.0, "height": 0.95},
    "crow": {"format": "authored", "turn": -90.0, "height": 0.3},
    "duck": {"format": "authored", "turn": -90.0, "height": 0.36},
    "heron": {"format": "authored", "turn": -90.0, "height": 0.95},
    "songbird": {"format": "authored", "turn": -90.0, "height": 0.17},
}
BIRDS = ("crow", "duck", "heron", "songbird")


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
    armature = next(obj for obj in loaded if obj.type == "ARMATURE" and obj.name.startswith("AnimalArmature"))
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
    actions = {name: next(a for a in bpy.data.actions if a not in before_actions and a.name == source) for name, source in UAA_CLIPS.items()}
    for action in [a for a in bpy.data.actions if a not in before_actions and a not in actions.values()]:
        bpy.data.actions.remove(action)
    for material in {slot.material for mesh in meshes for slot in mesh.material_slots if slot.material}:
        principled_from_diffuse(material)
    return armature, meshes, actions


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
        r.tube(f"Shin{leg}", "dark", (x, y, knee + 0.01), (x, y, 0.04), 0.045, 0.035, 6)
        r.tube(f"Shin{leg}", "eye", (x, y, 0.05), (x, y, 0.0), 0.036, 0.042, 6)
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


def boar_pose(clip, u):
    if clip == "Idle":
        return {"Body": [("loc", (0, 0, 0.004 * wave(u, 2)))], "Head": [(Z, 10 * wave(u, 1, 0.1)), (Y, 4 * wave(u, 2))],
                "Tail": [(X, 30 * wave(u, 4))]}
    if clip == "Walk":
        pose = {"Body": [("loc", (0, 0, 0.012 * abs(wave(u, 1)))), (X, 1.5 * wave(u, 1))], "Head": [(Y, 3 * wave(u, 2, 0.25))],
                "Tail": [(X, 20 * wave(u, 2))]}
        return quad_gait(pose, u, ("HL", "FL", "HR", "FR"), 22, 30)
    # Eat: rooting, snout ploughing the ground in short shoves.
    shove = max(0.0, wave(u, 3)) ** 2
    return {"Body": [(Y, 6), ("loc", (0, 0, -0.02))], "Head": [(Y, 28 + 8 * shove), (Z, 6 * wave(u, 1.5))],
            "LegFL": [(Y, -8)], "LegFR": [(Y, -8)], "Tail": [(X, 25 * wave(u, 6))]}


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
    "rabbit": {"Idle": 72, "Walk": 14, "Eat": 48}, "boar": {"Idle": 96, "Walk": 28, "Eat": 72},
    "crow": {"Idle": 72, "Walk": 16, "Eat": 48, "Fly": 16}, "songbird": {"Idle": 48, "Walk": 10, "Eat": 32, "Fly": 8},
    "duck": {"Idle": 72, "Walk": 18, "Eat": 56, "Fly": 10}, "heron": {"Idle": 96, "Walk": 36, "Eat": 64, "Fly": 28},
}


def build_authored(animal, collection):
    if animal in BIRDS:
        armature, mesh = build_bird(animal, collection)
        pose_of = lambda clip, u: bird_pose(animal, clip, u)
    else:
        armature, mesh = {"rabbit": build_rabbit, "boar": build_boar}[animal](collection)
        pose_of = {"rabbit": rabbit_pose, "boar": boar_pose}[animal]
    actions = {}
    for clip, count in CLIP_FRAMES[animal].items():
        action = bpy.data.actions.new(clip)
        slot_for(armature, action)
        for frame in range(0, count + 1, 1 if count <= 16 else 2):
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
        "clips": {name: {"frames": frames, "fps": scene.render.fps} for name, frames in measured["frames"].items()},
        "walkTravel": round(measured["travel"], 4),
    }
