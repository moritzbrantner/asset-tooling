"""Grass appearances reuse verified native crop leaf authoring and export."""
import hashlib
import json
import math
import random
import re

KEYS = {"schemaVersion", "seed", "bladeCount", "bladeHeight", "bladeWidth", "spread", "bend", "curveSegments", "maxTriangles"}


def validate(p, inputs):
    if type(p) is not dict or set(p) != KEYS or set(inputs) != {"authoring"}:
        raise ValueError("Grass requires complete controls and its declared authoring source")
    if type(inputs["authoring"]) is not str or not inputs["authoring"]:
        raise ValueError("Grass authoring input must be a local source path")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("Grass schemaVersion must be 1")
    if type(p["seed"]) is not str or len(p["seed"]) > 10 or not re.fullmatch(r"0|[1-9][0-9]*", p["seed"]) or int(p["seed"]) > 2147483647:
        raise ValueError("invalid Grass seed")
    for key, low, high, integer in [
        ("bladeCount", 1, 32, True), ("bladeHeight", .08, 1, False), ("bladeWidth", .004, .06, False),
        ("spread", 0, .3, False), ("bend", 0, .8, False), ("curveSegments", 2, 6, True), ("maxTriangles", 16, 8000, True),
    ]:
        value = p[key]
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high or (integer and type(value) is not int):
            raise ValueError(f"invalid Grass {key}")
    if p["bladeWidth"] > p["bladeHeight"] * .25:
        raise ValueError("Grass blade width must not exceed one quarter of its height envelope")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    native = inputs.load_source("authoring")
    import bpy
    p = arguments
    rng = random.Random(int(p["seed"]))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    material = native["author_material"]("grass", "foliage", (.12, .29, .035))
    profile = native["author_leaf_profile"]("grass-blade-profile", p["bladeWidth"])
    blades, evidence = [], []
    for index in range(p["bladeCount"]):
        height = p["bladeHeight"] * rng.uniform(.85, 1)
        yaw = rng.uniform(0, math.tau)
        radius = rng.uniform(0, p["spread"])
        x, y = radius * math.cos(yaw), radius * math.sin(yaw)
        bend = p["bend"] * height
        controls = [(0, 0, 0), (0, 0, height * .35), (bend * .45, 0, height * .85),
                    (bend, 0, height * (1 - p["bend"] * .4))]
        obj = native["author_bezier_leaf"](f"grass-blade-{index:03}", profile, controls,
                                             [.25, 1, .65, 0], p["curveSegments"], yaw)
        obj.location = (x, y, 0)
        obj.data.materials.append(material)
        if any(v.co.z < -1e-6 or v.co.z > p["bladeHeight"] + 1e-6 for v in obj.data.vertices):
            raise ValueError("Grass blade exceeds its declared grounded height envelope")
        geometry = hashlib.sha256(json.dumps({"vertices": [list(v.co) for v in obj.data.vertices],
            "faces": [list(face.vertices) for face in obj.data.polygons]}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        evidence.append({"id": f"blade.{index:03}", "root": [x, 0, -y], "yawBlenderRadians": yaw,
                         "height": height, "localGeometrySha256": geometry})
        blades.append(obj)
    bpy.data.objects.remove(profile, do_unlink=True)
    half = p["spread"] + p["bladeHeight"] * p["bend"] + p["bladeWidth"]
    counts, geometry = native["export_native_crop"]({"foliage": blades}, output_path, p["maxTriangles"], half)
    return {"authoring": "blender-authored-grass-v1", "parameters": p, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "native-root-ground-anchor", "heightEnvelope": p["bladeHeight"], "footprint": {"width": 2 * half, "depth": 2 * half},
            "componentCounts": counts, "componentGeometrySha256": geometry, "blades": evidence,
            "randomness": "isolated-seeded-authoring", "wind": "none"}
