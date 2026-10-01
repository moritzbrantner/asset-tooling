"""Authored Wheat appearances composed by Blender's primitives, curves and exporter."""
import hashlib
import json
import math
import random
import re

KEYS = {"schemaVersion", "stage", "seed", "stemHeight", "stemRadius", "leafCount", "leafLength", "leafWidth",
        "earLength", "grainPairs", "curveSegments", "maxTriangles"}


def validate(p, inputs):
    if type(p) is not dict or set(p) != KEYS or inputs:
        raise ValueError("Wheat requires the complete declared controls and no additional inputs")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("Wheat schemaVersion must be 1")
    if type(p["seed"]) is not str or len(p["seed"]) > 10 or not re.fullmatch(r"0|[1-9][0-9]*", p["seed"]) or int(p["seed"]) > 2147483647:
        raise ValueError("invalid Wheat seed")
    for key, low, high, integer in [
        ("stemHeight", .1, 1.3, False), ("stemRadius", .003, .025, False), ("leafCount", 0, 6, True),
        ("leafLength", 0, .3, False), ("leafWidth", 0, .08, False), ("earLength", 0, .3, False),
        ("grainPairs", 0, 8, True), ("curveSegments", 2, 6, True), ("maxTriangles", 100, 20000, True),
    ]:
        v = p[key]
        if type(v) not in (int, float) or not math.isfinite(v) or not low <= v <= high or (integer and type(v) is not int):
            raise ValueError(f"invalid Wheat {key}")
    stage = p["stage"]
    if type(stage) is not str or stage not in {"early", "mature", "harvested"}:
        raise ValueError("unsupported Wheat stage")
    if stage == "harvested":
        if any(p[k] != 0 for k in ("leafCount", "leafLength", "leafWidth", "earLength", "grainPairs")) or p["stemHeight"] > .3:
            raise ValueError("harvested appearance requires a short bare stem")
    else:
        if p["leafCount"] < 2 or p["leafLength"] < .05 or p["leafWidth"] < .008:
            raise ValueError("early/mature Wheat requires visible leaves")
        if stage == "early" and (p["earLength"] != 0 or p["grainPairs"] != 0 or p["stemHeight"] > .5 or p["leafCount"] > 4):
            raise ValueError("early Wheat requires a short leafy stem without an ear")
        if stage == "mature" and (p["earLength"] < .08 or p["grainPairs"] < 4):
            raise ValueError("mature Wheat requires a visible bounded grain ear")



def author_material(prefix, name, color):
    import bpy
    result = bpy.data.materials.new(prefix + "-" + name)
    result.diffuse_color = (*color, 1)
    if result.node_tree is None:
        result.use_nodes = True
    node = result.node_tree.nodes.get("Principled BSDF")
    node.inputs["Base Color"].default_value = (*color, 1)
    node.inputs["Roughness"].default_value = .88
    return result

def author_leaf_profile(name, width):
    import bpy
    profile = bpy.data.curves.new(name, "CURVE")
    profile.dimensions = "2D"
    spline = profile.splines.new("POLY")
    spline.points.add(3)
    half = width / 2
    for point, co in zip(spline.points, [(-half, -.0005, 0, 1), (half, -.0005, 0, 1),
                                        (half, .0005, 0, 1), (-half, .0005, 0, 1)]):
        point.co = co
    spline.use_cyclic_u = True
    bevel = bpy.data.objects.new(name, profile)
    bpy.context.collection.objects.link(bevel)
    return bevel

def author_bezier_leaf(name, profile, controls, radii, resolution, yaw):
    import bpy
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = resolution
    curve.bevel_mode = "OBJECT"
    curve.bevel_object = profile
    curve.use_fill_caps = True
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(3)
    for point, co, radius in zip(spline.bezier_points, controls, radii):
        point.co = co
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
        point.radius = radius
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.rotation_euler.z = yaw
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    return bpy.context.object

def author_ordered_sphere(radius, location):
    import bpy
    import bmesh
    bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=4, radius=radius, location=location)
    obj = bpy.context.object
    # Blender's UV-sphere operator emits faces in varying order.
    # Order the existing BMesh faces without changing their loops,
    # coordinates or UV layers before Blender joins and exports them.
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        bm.verts.index_update()
        ordered = sorted(bm.faces, key=lambda face: tuple(vertex.index for vertex in face.verts))
        for index, face in enumerate(ordered):
            face.index = index
        bm.faces.sort()
        bm.to_mesh(obj.data)
    finally:
        bm.free()
    return obj

def export_native_crop(parts, output_path, max_triangles, half_footprint):
    import bpy
    counts, geometry = {}, {}
    for role, objects in parts.items():
        if not objects:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = role
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        obj.data.calc_loop_triangles()
        if any(not math.isfinite(v) for vertex in obj.data.vertices for v in vertex.co):
            raise ValueError("non-finite Crop geometry")
        if any(vertex.co.z < -1e-6 or abs(vertex.co.x) > half_footprint or abs(vertex.co.y) > half_footprint for vertex in obj.data.vertices):
            raise ValueError("Crop exceeds its ground/footprint contract")
        counts[role] = {"vertices": len(obj.data.vertices), "triangles": len(obj.data.loop_triangles)}
        geometry[role] = hashlib.sha256(json.dumps({"vertices": [list(v.co) for v in obj.data.vertices],
            "faces": [list(f.vertices) for f in obj.data.polygons]}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if sum(c["triangles"] for c in counts.values()) > max_triangles:
        raise ValueError("Crop exceeds maxTriangles")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
                              export_animations=False, export_cameras=False, export_lights=False)
    return counts, geometry


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    import bpy
    p = arguments
    rng = random.Random(int(p["seed"]))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    stem_color = (.20, .30, .06) if p["stage"] == "early" else (.55, .36, .10)
    materials = {"stem": author_material("wheat", "stem", stem_color), "foliage": author_material("wheat", "foliage", (.14, .28, .04)),
                 "grain": author_material("wheat", "grain", (.72, .47, .13))}
    parts = {"stem": [], "foliage": [], "grain": []}

    def record(role, obj):
        obj.data.materials.clear()
        obj.data.materials.append(materials[role])
        parts[role].append(obj)
        return obj

    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=p["stemRadius"], radius2=p["stemRadius"] * .7,
                                   depth=p["stemHeight"], location=(0, 0, p["stemHeight"] / 2))
    record("stem", bpy.context.object)

    if p["leafCount"]:
        # An authored thin rectangular bevel profile; Blender owns its sweep,
        # taper, interpolation, UVs, normals, triangulation and export.
        bevel = author_leaf_profile("wheat-leaf-profile", p["leafWidth"])
        for i in range(p["leafCount"]):
            length = p["leafLength"] * rng.uniform(.85, 1)
            base = p["stemHeight"] * (.18 + .12 * i)
            controls = [(0, 0, base), (.25 * length, 0, base + .4 * length),
                        (.6 * length, 0, base + .5 * length), (length, 0, base + .15 * length)]
            author_bezier_leaf(f"wheat-leaf-{i}", bevel, controls, [.15, 1, .7, 0], p["curveSegments"],
                               i * math.pi + rng.uniform(-.45, .45))
            record("foliage", bpy.context.object)
        bpy.data.objects.remove(bevel, do_unlink=True)

    if p["grainPairs"]:
        bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=p["stemRadius"] * .55, radius2=.001,
                                       depth=p["earLength"], location=(0, 0, p["stemHeight"] + p["earLength"] / 2))
        record("grain", bpy.context.object)
        for i in range(p["grainPairs"]):
            z = p["stemHeight"] + p["earLength"] * (i + .5) / p["grainPairs"]
            for side in (-1, 1):
                grain = author_ordered_sphere(p["earLength"] * .07, (side * p["earLength"] * .045, 0, z))
                grain.scale = (.8, .65, 1.4)
                grain.rotation_euler.y = side * .45
                record("grain", grain)
                awn = bpy.data.curves.new(f"wheat-awn-{i}-{side}", "CURVE")
                awn.dimensions = "3D"
                awn.bevel_depth = p["stemRadius"] * .035
                awn.bevel_resolution = 0
                spline = awn.splines.new("POLY")
                spline.points.add(1)
                spline.points[0].co = (side * p["earLength"] * .1, 0, z, 1)
                spline.points[1].co = (side * p["earLength"] * .2, 0, z + p["earLength"] * .4, 1)
                obj = bpy.data.objects.new(f"wheat-awn-{i}-{side}", awn)
                bpy.context.collection.objects.link(obj)
                bpy.ops.object.select_all(action="DESELECT")
                obj.select_set(True)
                bpy.context.view_layer.objects.active = obj
                bpy.ops.object.convert(target="MESH")
                record("grain", bpy.context.object)

    counts, geometry = export_native_crop(parts, output_path, p["maxTriangles"], .35)
    return {"authoring": "blender-authored-wheat-v1", "parameters": p, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "native-root-ground-anchor", "footprint": {"width": .7, "depth": .7}, "stage": p["stage"],
            "componentCounts": counts, "componentGeometrySha256": geometry, "randomness": "isolated-seeded-authoring", "wind": "none"}
