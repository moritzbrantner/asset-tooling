"""Corn appearances reusing the hash-pinned native Wheat authoring functions."""
import math
import random
import re
import runpy

KEYS = {"schemaVersion", "stage", "seed", "stemHeight", "stemRadius", "leafCount", "leafLength", "leafWidth",
        "earLength", "kernelRows", "curveSegments", "maxTriangles"}


def validate(p, inputs):
    if type(p) is not dict or set(p) != KEYS or set(inputs) != {"authoring"}:
        raise ValueError("Corn requires complete controls and its declared authoring source")
    if type(inputs["authoring"]) is not str or not inputs["authoring"]:
        raise ValueError("Corn authoring input must be a local source path")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("Corn schemaVersion must be 1")
    if type(p["seed"]) is not str or len(p["seed"]) > 10 or not re.fullmatch(r"0|[1-9][0-9]*", p["seed"]) or int(p["seed"]) > 2147483647:
        raise ValueError("invalid Corn seed")
    for key, low, high, integer in [
        ("stemHeight", .1, 2.4, False), ("stemRadius", .006, .035, False), ("leafCount", 0, 8, True),
        ("leafLength", 0, .45, False), ("leafWidth", 0, .12, False), ("earLength", 0, .3, False),
        ("kernelRows", 0, 8, True), ("curveSegments", 2, 6, True), ("maxTriangles", 100, 12000, True),
    ]:
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
        if not 2 <= p["leafCount"] <= 4 or p["leafLength"] < .1 or p["leafWidth"] < .02 or p["stemHeight"] > .6 or p["leafLength"] * .05 > p["stemHeight"] * .16 or p["earLength"] != 0 or p["kernelRows"] != 0:
            raise ValueError("early Corn requires short broad foliage without an ear")
    elif p["leafCount"] < 4 or p["leafLength"] < .2 or p["leafWidth"] < .04 or p["stemHeight"] < .8 or p["earLength"] < .12 or p["kernelRows"] < 4:
        raise ValueError("mature Corn requires broad foliage and a bounded ear")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    # The existing backend verifies this entire local input before execution or
    # cache lookup. No ambient module import, bytecode cache or acquisition.
    native = runpy.run_path(inputs["authoring"])
    import bpy
    p = arguments
    rng = random.Random(int(p["seed"]))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    colors = {"stem": (.12, .25, .03), "foliage": (.14, .30, .04), "grain": (.85, .53, .06), "tassel": (.48, .30, .07)}
    if p["stage"] == "harvested":
        colors["stem"] = (.45, .30, .10)
    materials = {role: native["author_material"]("corn", role, color) for role, color in colors.items()}
    parts = {role: [] for role in colors}

    def record(role, obj):
        obj.data.materials.clear()
        obj.data.materials.append(materials[role])
        parts[role].append(obj)
        return obj

    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=p["stemRadius"], radius2=p["stemRadius"] * .7,
                                   depth=p["stemHeight"], location=(0, 0, p["stemHeight"] / 2))
    record("stem", bpy.context.object)
    if p["leafCount"]:
        profile = native["author_leaf_profile"]("corn-leaf-profile", p["leafWidth"])
        for i in range(p["leafCount"]):
            length = p["leafLength"] * rng.uniform(.85, 1)
            base = p["stemHeight"] * (.16 + .10 * i)
            controls = [(0, 0, base), (.25 * length, 0, base + .45 * length),
                        (.65 * length, 0, base + .5 * length), (length, 0, base - .05 * length)]
            leaf = native["author_bezier_leaf"](f"corn-leaf-{i}", profile, controls, [.2, 1, .8, 0],
                                                p["curveSegments"], i * math.pi + rng.uniform(-.4, .4))
            record("foliage", leaf)
        if p["kernelRows"]:
            ear_base = p["stemHeight"] * .55
            controls = [(0, 0, ear_base), (.05, 0, ear_base + .04),
                        (.1, 0, ear_base + p["earLength"] * .5), (.08, 0, ear_base + p["earLength"] * 1.1)]
            for side in (-1, 1):
                husk = native["author_bezier_leaf"](f"corn-husk-{side}", profile, controls, [.2, .7, .5, 0], p["curveSegments"], side * .4)
                record("foliage", husk)
        bpy.data.objects.remove(profile, do_unlink=True)
    if p["kernelRows"]:
        ear_base = p["stemHeight"] * .55
        bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=p["earLength"] * .10, radius2=p["earLength"] * .07,
                                       depth=p["earLength"], location=(.06, 0, ear_base + p["earLength"] / 2))
        record("grain", bpy.context.object)
        for row in range(p["kernelRows"]):
            z = ear_base + p["earLength"] * (row + .5) / p["kernelRows"]
            for column in range(8):
                angle = column * math.tau / 8
                radius = p["earLength"] * .105
                kernel = native["author_ordered_sphere"](p["earLength"] * .055, (.06 + radius * math.cos(angle), radius * math.sin(angle), z))
                kernel.scale = (.65, .65, 1.1)
                record("grain", kernel)
        # A small authored tassel: native cones joined into a separate material
        # role, so changing leaf artwork never changes the stem, ear or tassel.
        for i in range(5):
            length = .12 if i == 0 else .09
            bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=.0025, radius2=0, depth=length,
                                           location=((i - 2) * .018, 0, p["stemHeight"] + length / 2))
            tassel = bpy.context.object
            tassel.rotation_euler.y = (i - 2) * .2
            record("tassel", tassel)
    counts, geometry = native["export_native_crop"](parts, output_path, p["maxTriangles"], .55)
    return {"authoring": "blender-authored-corn-v1", "parameters": p, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "native-root-ground-anchor", "footprint": {"width": 1.1, "depth": 1.1}, "stage": p["stage"],
            "componentCounts": counts, "componentGeometrySha256": geometry, "randomness": "isolated-seeded-authoring", "wind": "none"}
