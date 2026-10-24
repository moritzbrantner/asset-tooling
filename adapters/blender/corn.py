"""Toy-like Corn appearances reusing the hash-pinned native Wheat authoring functions.

Bright-toy style (my-farm#278, asset-tooling#355): one tall, thick green stalk with broad arching
leaves, a big bright-yellow cob half-wrapped in green husk and an orange tassel, so Corn's
silhouette and colours differ from the golden Wheat sheaf at a glance.
"""
import math
import random
import re

KEYS = {"schemaVersion", "stage", "seed", "stemHeight", "stemRadius", "leafCount", "leafLength", "leafWidth",
        "earLength", "kernelRows", "curveSegments", "maxTriangles"}
BOUNDS = [
    ("stemHeight", .1, 2.4, False), ("stemRadius", .01, .08, False), ("leafCount", 0, 8, True),
    ("leafLength", 0, .55, False), ("leafWidth", 0, .2, False), ("earLength", 0, .45, False),
    ("kernelRows", 0, 8, True), ("curveSegments", 2, 6, True), ("maxTriangles", 100, 12000, True),
]
HALF_FOOTPRINT = .55
COLOURS = {
    "early": {"stem": (.30, .66, .16), "foliage": (.32, .74, .20)},
    "mature": {"stem": (.24, .58, .14), "foliage": (.26, .66, .16), "grain": (1.0, .84, .12), "tassel": (.96, .55, .16)},
    "harvested": {"stem": (.86, .66, .32)},
}


def validate(p, inputs):
    if type(p) is not dict or set(p) != KEYS or set(inputs) != {"authoring"}:
        raise ValueError("Corn requires complete controls and its declared authoring source")
    if type(inputs["authoring"]) is not str or not inputs["authoring"]:
        raise ValueError("Corn authoring input must be a local source path")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("Corn schemaVersion must be 1")
    if type(p["seed"]) is not str or len(p["seed"]) > 10 or not re.fullmatch(r"0|[1-9][0-9]*", p["seed"]) or int(p["seed"]) > 2147483647:
        raise ValueError("invalid Corn seed")
    for key, low, high, integer in BOUNDS:
        v = p[key]
        if type(v) not in (int, float) or not math.isfinite(v) or not low <= v <= high or (integer and type(v) is not int):
            raise ValueError(f"invalid Corn {key}")
    stage = p["stage"]
    if type(stage) is not str or stage not in {"early", "mature", "harvested"}:
        raise ValueError("unsupported Corn stage")
    if stage == "harvested":
        if any(p[k] != 0 for k in ("leafCount", "leafLength", "leafWidth", "earLength", "kernelRows")) or p["stemHeight"] > .3:
            raise ValueError("harvested Corn requires a short bare stalk")
    elif stage == "early":
        if not 2 <= p["leafCount"] <= 4 or p["leafLength"] < .1 or p["leafWidth"] < .04 or p["stemHeight"] > .6 or p["earLength"] != 0 or p["kernelRows"] != 0:
            raise ValueError("early Corn requires short broad foliage without an ear")
    elif p["leafCount"] < 4 or p["leafLength"] < .2 or p["leafWidth"] < .08 or p["stemHeight"] < .8 or p["earLength"] < .15 or p["kernelRows"] < 4:
        raise ValueError("mature Corn requires broad foliage and a big cob")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    # The existing backend verifies this entire local input before execution or
    # cache lookup. No ambient module import, bytecode cache or acquisition.
    native = inputs.load_source("authoring")
    import bpy
    from mathutils import Matrix
    p = arguments
    stage = p["stage"]
    rng = random.Random(int(p["seed"]))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    materials = {role: native["author_toy_material"]("corn", role, colour) for role, colour in COLOURS[stage].items()}
    parts = {role: [] for role in COLOURS[stage]}
    place, cone, sphere = native["place"], native["author_cone"], native["author_ordered_sphere"]
    identity = Matrix.Identity(4)

    def record(role, obj):
        obj.data.materials.clear()
        obj.data.materials.append(materials[role])
        parts[role].append(obj)
        return obj

    r, h = p["stemRadius"], p["stemHeight"]
    record("stem", cone(r, r * (.9 if stage == "harvested" else .7), h, vertices=12))
    if stage == "harvested":
        # Two dry leaves flop from the cut stalk, so the stump still reads as Corn and not as Wheat stubble.
        profile = native["author_thick_leaf_profile"]("corn-dry-profile", r * 2.2)
        for i, yaw in enumerate((.6, .6 + math.pi * .95)):
            length = h * 2.4
            controls = [(0, 0, h * .55), (.35 * length, 0, h * .55 + .25 * length),
                        (.7 * length, 0, h * .2 + .1 * length), (length, 0, r * .4)]
            leaf = native["author_bezier_leaf"](f"corn-dry-leaf-{i}", profile, controls, [.5, 1, .8, .3], p["curveSegments"], yaw)
            record("stem", leaf)
        bpy.data.objects.remove(profile, do_unlink=True)
    else:
        # Chunky stalk nodes: flattened rings that read as a segmented toy stalk.
        for z in (.3, .55, .8)[: 1 if stage == "early" else 3]:
            node = sphere(r * 1.3, (0, 0, 0), segments=12, rings=4)
            record("stem", place(node, identity, location=(0, 0, h * z), scale=(1, 1, .45)))
    if p["leafCount"]:
        profile = native["author_thick_leaf_profile"]("corn-leaf-profile", p["leafWidth"])
        for i in range(p["leafCount"]):
            length = p["leafLength"] * rng.uniform(.88, 1)
            base = h * (.12 + (.62 / max(1, p["leafCount"] - 1)) * i) if stage == "mature" else h * (.2 + .25 * i) + p["leafWidth"] * .4
            rise = .55 if stage == "early" else .35
            controls = [(0, 0, base), (.3 * length, 0, base + rise * length),
                        (.7 * length, 0, base + rise * length), (length, 0, base - .08 * length)]
            leaf = native["author_bezier_leaf"](f"corn-leaf-{i}", profile, controls, [.45, 1, .85, .25],
                                                p["curveSegments"], i * (math.pi * .9) + rng.uniform(-.3, .3))
            record("foliage", leaf)
        if p["kernelRows"]:
            # Two husk leaves cup the lower half of the cob.
            ear = cob_matrix(h, r, p["earLength"])
            husk_profile = native["author_thick_leaf_profile"]("corn-husk-profile", p["earLength"] * .42)
            for side in (-1, 1):
                controls = [(0, side * .01, 0), (side * .02, side * .04, p["earLength"] * .3),
                            (side * .015, side * .05, p["earLength"] * .6), (0, side * .03, p["earLength"] * .8)]
                husk = native["author_bezier_leaf"](f"corn-husk-{side}", husk_profile, controls, [.6, 1, .8, .2],
                                                    p["curveSegments"], 0, ear @ Matrix.Rotation(side * .3, 4, "Z"))
                record("foliage", husk)
            bpy.data.objects.remove(husk_profile, do_unlink=True)
        bpy.data.objects.remove(profile, do_unlink=True)
    if p["kernelRows"]:
        ear, length = cob_matrix(h, r, p["earLength"]), p["earLength"]
        radius = length * .26  # a fat cob dominates the mature silhouette (owner, #355)
        record("grain", place(cone(radius * .9, radius * .7, length, vertices=10), ear))
        record("grain", place(sphere(radius * .75, (0, 0, 0), segments=10, rings=5), ear, location=(0, 0, length), scale=(1, 1, .9)))
        for row in range(p["kernelRows"]):
            z = length * (row + .5) / p["kernelRows"]
            ring = radius * (.92 - .2 * row / p["kernelRows"])
            for column in range(8):
                angle = column * math.tau / 8 + (row % 2) * math.pi / 8
                kernel = sphere(radius * .34, (0, 0, 0), segments=6, rings=4)
                place(kernel, ear, location=(ring * math.cos(angle), ring * math.sin(angle), z), rotation=(0, 0, angle), scale=(.8, 1, 1.15))
                record("grain", kernel)
        # A fanned orange tassel crowns the stalk.
        for i in range(7):
            yaw = i * math.tau / 7
            spike = cone(r * .22, 0, h * (.16 if i else .2), vertices=6)
            record("tassel", place(spike, identity, location=(0, 0, h - r * .2), rotation=(0, 0 if i == 0 else .7, yaw)))
    counts, geometry = native["export_native_crop"](parts, output_path, p["maxTriangles"], HALF_FOOTPRINT, native["SMOOTH_ANGLE"])
    return {"authoring": "blender-authored-toy-corn", "parameters": p, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "native-root-ground-anchor", "footprint": {"width": 1.1, "depth": 1.1}, "stage": stage,
            "componentCounts": counts, "componentGeometrySha256": geometry, "randomness": "isolated-seeded-authoring", "wind": "none"}


def cob_matrix(height, radius, length):
    """The cob grows from the stalk at mid height, leaning 30 degrees outwards towards +X."""
    from mathutils import Matrix
    return Matrix.Translation((radius * .9, 0, height * .48)) @ Matrix.Rotation(.52, 4, "Y")
