"""Toy-like Wheat appearances composed by Blender's primitives, curves and exporter.

Bright-toy style (my-farm#278, asset-tooling#355; owner answers on my-farm#234): a chunky sheaf of
thick stalks with plump golden grain ears, fat rounded leaves and saturated colours, coherent with
the toy Farmhouse/Silo recipe. Every part is a native Blender primitive or a swept Bezier leaf with a
thick lens profile, smooth-shaded by angle, so the silhouette reads at the gameplay camera.
"""
import hashlib
import json
import math
import random
import re

KEYS = {"schemaVersion", "stage", "seed", "stalkCount", "stemHeight", "stemRadius", "leafCount", "leafLength",
        "leafWidth", "earLength", "grainRows", "curveSegments", "maxTriangles"}
BOUNDS = [
    ("stalkCount", 1, 7, True), ("stemHeight", .1, 1.3, False), ("stemRadius", .005, .05, False),
    ("leafCount", 0, 8, True), ("leafLength", 0, .32, False), ("leafWidth", 0, .12, False),
    ("earLength", 0, .4, False), ("grainRows", 0, 8, True), ("curveSegments", 2, 6, True),
    ("maxTriangles", 100, 20000, True),
]
HALF_FOOTPRINT = .35
SMOOTH_ANGLE = math.radians(50)

# role: (sRGB base colour by stage, roughness); saturated toy palette.
COLOURS = {
    "early": {"stem": (.36, .70, .18), "foliage": (.38, .78, .20)},
    "mature": {"stem": (.96, .74, .24), "foliage": (.46, .76, .20), "grain": (1.0, .78, .16)},
    "harvested": {"stem": (.90, .70, .34)},
}


def validate(p, inputs):
    if type(p) is not dict or set(p) != KEYS or inputs:
        raise ValueError("Wheat requires the complete declared controls and no additional inputs")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("Wheat schemaVersion must be 1")
    if type(p["seed"]) is not str or len(p["seed"]) > 10 or not re.fullmatch(r"0|[1-9][0-9]*", p["seed"]) or int(p["seed"]) > 2147483647:
        raise ValueError("invalid Wheat seed")
    for key, low, high, integer in BOUNDS:
        v = p[key]
        if type(v) not in (int, float) or not math.isfinite(v) or not low <= v <= high or (integer and type(v) is not int):
            raise ValueError(f"invalid Wheat {key}")
    stage = p["stage"]
    if type(stage) is not str or stage not in {"early", "mature", "harvested"}:
        raise ValueError("unsupported Wheat stage")
    if stage == "harvested":
        if any(p[k] != 0 for k in ("leafCount", "leafLength", "leafWidth", "earLength", "grainRows")) or p["stemHeight"] > .3:
            raise ValueError("harvested appearance requires short bare stubble")
    else:
        if p["leafCount"] < 2 or p["leafLength"] < .05 or p["leafWidth"] < .02:
            raise ValueError("early/mature Wheat requires visible leaves")
        if stage == "early" and (p["earLength"] != 0 or p["grainRows"] != 0 or p["stemHeight"] > .5):
            raise ValueError("early Wheat requires a short leafy tuft without ears")
        if stage == "mature" and (p["earLength"] < .1 or p["grainRows"] < 3):
            raise ValueError("mature Wheat requires visible plump grain ears")


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def author_material(prefix, name, color):
    """A plain material from a linear colour (shared with the Grass recipe; unchanged)."""
    import bpy
    result = bpy.data.materials.new(prefix + "-" + name)
    result.diffuse_color = (*color, 1)
    if result.node_tree is None:
        result.use_nodes = True
    node = next(n for n in result.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    node.inputs["Base Color"].default_value = (*color, 1)
    node.inputs["Roughness"].default_value = .88
    return result


def author_toy_material(prefix, name, colour, roughness=.6):
    """A plain toy material from an sRGB colour (no textures, no vertex colours)."""
    import bpy
    linear = tuple(srgb_to_linear(c) for c in colour) + (1,)
    result = bpy.data.materials.new(prefix + "-" + name)
    result.diffuse_color = linear
    if result.node_tree is None:
        result.use_nodes = True
    node = next(n for n in result.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    node.inputs["Base Color"].default_value = linear
    node.inputs["Metallic"].default_value = 0.0
    node.inputs["Roughness"].default_value = roughness
    return result


def place(obj, matrix, location=(0, 0, 0), rotation=(0, 0, 0), scale=(1, 1, 1)):
    """Set an object's world matrix to ``matrix`` applied after a local loc/rot/scale."""
    from mathutils import Euler, Matrix, Vector
    obj.matrix_world = matrix @ Matrix.LocRotScale(Vector(location), Euler(rotation), Vector(scale))
    return obj


def author_leaf_profile(name, width):
    """A thin rectangular cross-section (shared with the Grass recipe; unchanged)."""
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


def author_thick_leaf_profile(name, width):
    """A thick lens cross-section, so leaves read as chunky toy blades rather than paper."""
    import bpy
    profile = bpy.data.curves.new(name, "CURVE")
    profile.dimensions = "2D"
    spline = profile.splines.new("POLY")
    half, thick = width / 2, width * .14
    coords = [(-half, 0), (-half * .5, -thick), (half * .5, -thick), (half, 0), (half * .5, thick), (-half * .5, thick)]
    spline.points.add(len(coords) - 1)
    for point, (x, y) in zip(spline.points, coords):
        point.co = (x, y, 0, 1)
    spline.use_cyclic_u = True
    bevel = bpy.data.objects.new(name, profile)
    bpy.context.collection.objects.link(bevel)
    return bevel


def author_bezier_leaf(name, profile, controls, radii, resolution, yaw, matrix=None):
    import bpy
    from mathutils import Matrix
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = resolution
    curve.bevel_mode = "OBJECT"
    curve.bevel_object = profile
    curve.use_fill_caps = True
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(controls) - 1)
    for point, co, radius in zip(spline.bezier_points, controls, radii):
        point.co = co
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
        point.radius = radius
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    place(obj, matrix or Matrix.Identity(4), rotation=(0, 0, yaw))
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    return bpy.context.object


def author_ordered_sphere(radius, location, segments=8, rings=5):
    import bpy
    import bmesh
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=radius, location=location)
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


def author_cone(radius1, radius2, depth, vertices=10):
    """A native cone standing on the local origin, pointing up +Z."""
    import bpy
    from mathutils import Matrix
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius1, radius2=radius2, depth=depth, location=(0, 0, 0))
    obj = bpy.context.object
    obj.data.transform(Matrix.Translation((0, 0, depth / 2)))
    return obj


def stalk_matrix(x, y, yaw, tilt, radius=0.0):
    """Base at (x, y), leaning ``tilt`` radians outwards along ``yaw``, lifted so a stalk of
    ``radius`` keeps its whole base on or above the ground."""
    from mathutils import Matrix
    lift = radius * math.sin(tilt) + 1e-4 if tilt else 0
    return Matrix.Translation((x, y, lift)) @ Matrix.Rotation(yaw, 4, "Z") @ Matrix.Rotation(tilt, 4, "Y")


def export_native_crop(parts, output_path, max_triangles, half_footprint, smooth_angle=None):
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
        # Toy crops: rounded parts shade smoothly; cut ends and creases stay crisp. Grass keeps flat blades.
        if smooth_angle is not None:
            bpy.ops.object.shade_smooth_by_angle(angle=smooth_angle)
        obj.data.calc_loop_triangles()
        if any(not math.isfinite(v) for vertex in obj.data.vertices for v in vertex.co):
            raise ValueError("non-finite Crop geometry")
        reach = max(max(abs(v.co.x), abs(v.co.y)) for v in obj.data.vertices)
        if min(v.co.z for v in obj.data.vertices) < -1e-6 or reach > half_footprint:
            raise ValueError(f"Crop {role} exceeds its ground/footprint contract (reach {reach:.3f} m)")
        counts[role] = {"vertices": len(obj.data.vertices), "triangles": len(obj.data.loop_triangles)}
        geometry[role] = hashlib.sha256(json.dumps({"vertices": [list(v.co) for v in obj.data.vertices],
            "faces": [list(f.vertices) for f in obj.data.polygons]}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if sum(c["triangles"] for c in counts.values()) > max_triangles:
        raise ValueError("Crop exceeds maxTriangles")
    bpy.ops.object.select_all(action="SELECT")
    # use_active_scene: a live multi-scene session must not leak other scenes' selections.
    bpy.ops.export_scene.gltf(filepath=output_path, export_format="GLB", use_selection=True, use_active_scene=True, export_yup=True,
                              export_animations=False, export_cameras=False, export_lights=False)
    return counts, geometry


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    import bpy
    p = arguments
    stage = p["stage"]
    rng = random.Random(int(p["seed"]))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    materials = {role: author_toy_material("wheat", role, colour) for role, colour in COLOURS[stage].items()}
    parts = {role: [] for role in ("stem", "foliage", "grain")}

    def record(role, obj):
        obj.data.materials.clear()
        obj.data.materials.append(materials[role])
        parts[role].append(obj)
        return obj

    # A sheaf: one upright centre stalk, the rest fanned evenly around it.
    r, h = p["stemRadius"], p["stemHeight"]
    stalks = []
    for i in range(p["stalkCount"]):
        if i == 0:
            stalks.append((stalk_matrix(0, 0, 0, 0), h))
            continue
        yaw = (i - 1) * math.tau / (p["stalkCount"] - 1) + rng.uniform(-.25, .25)
        spread = r * 2.2
        stalks.append((stalk_matrix(spread * math.cos(yaw), spread * math.sin(yaw), yaw, rng.uniform(.18, .26), r),
                       h * rng.uniform(.82, .94)))

    for matrix, height in stalks:
        stem = author_cone(r, r * (.85 if stage == "harvested" else .7), height, vertices=10)
        record("stem", place(stem, matrix))

    if p["grainRows"]:
        # A plump braided ear: alternating rows of four fat kernels around a short core.
        k = p["earLength"] / p["grainRows"]
        for s, (matrix, height) in enumerate(stalks):
            core = author_cone(r * 1.1, r * .6, p["earLength"], vertices=8)
            record("grain", place(core, matrix, location=(0, 0, height)))
            for row in range(p["grainRows"]):
                z = height + k * (row + .5)
                taper = 1 - .35 * (row / max(1, p["grainRows"] - 1)) ** 2
                for column in range(4):
                    angle = column * math.pi / 2 + (row % 2) * math.pi / 4
                    radial = k * .55 * taper
                    grain = author_ordered_sphere(k * .62 * taper, (0, 0, 0), segments=6, rings=4)
                    place(grain, matrix, location=(radial * math.cos(angle), radial * math.sin(angle), z),
                          rotation=(0, 0, angle), scale=(1, .9, 1.25))
                    record("grain", grain)
            tip = author_ordered_sphere(k * .5, (0, 0, 0))
            record("grain", place(tip, matrix, location=(0, 0, height + p["earLength"] + k * .2), scale=(1, 1, 1.3)))
            # Three short chunky awns crown each ear: the classic wheat read.
            for a in range(3):
                angle = a * math.tau / 3 + s
                awn = author_cone(r * .32, r * .08, p["earLength"] * .42, vertices=6)
                place(awn, matrix, location=(k * .3 * math.cos(angle), k * .3 * math.sin(angle), height + p["earLength"] * .9),
                      rotation=(0, .4, angle))
                record("grain", awn)

    if p["leafCount"]:
        # Fat rounded blades fanning from the base of the tuft.
        bevel = author_thick_leaf_profile("wheat-leaf-profile", p["leafWidth"])
        for i in range(p["leafCount"]):
            length = p["leafLength"] * rng.uniform(.85, 1)
            lift = 1.7 if stage == "early" else .9  # young Wheat: an upright grassy tuft
            base = p["leafWidth"] * .4  # keep the thick blade root above the ground
            controls = [(0, 0, base), (.22 * length, 0, base + .55 * length * lift),
                        (.55 * length, 0, base + .72 * length * lift), (.82 * length, 0, base + .5 * length * lift)]
            leaf = author_bezier_leaf(f"wheat-leaf-{i}", bevel, controls, [.55, 1, .8, .2], p["curveSegments"],
                                      i * math.tau / p["leafCount"] + rng.uniform(-.3, .3))
            record("foliage", leaf)
        bpy.data.objects.remove(bevel, do_unlink=True)

    counts, geometry = export_native_crop(parts, output_path, p["maxTriangles"], HALF_FOOTPRINT, SMOOTH_ANGLE)
    return {"authoring": "blender-authored-toy-wheat", "parameters": p, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "native-root-ground-anchor", "footprint": {"width": .7, "depth": .7}, "stage": stage,
            "componentCounts": counts, "componentGeometrySha256": geometry, "randomness": "isolated-seeded-authoring", "wind": "none"}
