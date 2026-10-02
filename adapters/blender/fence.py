"""Modular fence pieces for the existing pinned Blender script backend.

One piece occupies one square grid cell centred on the origin. A post stands at
the cell centre and rails run from it to each declared port at the cell edge.
Neighbouring pieces therefore meet rail-end to rail-end at the shared edge.
"""
import hashlib
import math

import bpy

KEYS = {"schemaVersion", "piece", "cellSize", "postWidth", "postHeight", "railCount", "railHeight", "railDepth", "maxTriangles"}
# Port directions at rotation 0 in Blender's Z-up frame: east=+X, north=+Y (glTF -Z).
PORTS = {"end": ["east"], "straight": ["east", "west"], "corner": ["east", "north"], "tee": ["east", "north", "west"]}
DIRECTIONS = {"east": (1, 0), "north": (0, 1), "west": (-1, 0), "south": (0, -1)}


def validate(p, inputs):
    if type(p) is not dict or set(p) != KEYS:
        raise ValueError("fence requires exactly the declared controls")
    if inputs:
        raise ValueError("fence recipe does not accept extra resources")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("fence schemaVersion must be 1")
    if p["piece"] not in PORTS:
        raise ValueError("fence piece must be end, straight, corner or tee")
    for key, low, high, integer in [
        ("cellSize", .5, 8, False), ("postWidth", .02, .5, False), ("postHeight", .2, 3, False),
        ("railCount", 1, 3, True), ("railHeight", .01, .4, False), ("railDepth", .01, .4, False), ("maxTriangles", 12, 1000, True),
    ]:
        value = p[key]
        if type(value) not in (int, float) or isinstance(value, bool) or not math.isfinite(value) or not low <= value <= high or (integer and type(value) is not int):
            raise ValueError(f"invalid fence {key}")
    if p["postWidth"] > p["cellSize"] / 2 or p["railDepth"] > p["postWidth"]:
        raise ValueError("fence post must fit half a cell and rails must not be deeper than the post")
    if p["railCount"] * p["railHeight"] > p["postHeight"] / 2:
        raise ValueError("fence rails must occupy at most half the post height")


def box(name, minimum, maximum, material):
    size = [maximum[i] - minimum[i] for i in range(3)]
    bpy.ops.mesh.primitive_cube_add(size=1, location=tuple((minimum[i] + maximum[i]) / 2 for i in range(3)), scale=tuple(size))
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material)
    return obj


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    p = arguments
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    material = bpy.data.materials.new("fence-wood")
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (.32, .2, .1, 1)
    shader.inputs["Roughness"].default_value = .8
    half, post, depth = p["cellSize"] / 2, p["postWidth"] / 2, p["railDepth"] / 2
    parts = [box("post", (-post, -post, 0), (post, post, p["postHeight"]), material)]
    rails = []
    for direction in PORTS[p["piece"]]:
        dx, dy = DIRECTIONS[direction]
        for index in range(p["railCount"]):
            centre = p["postHeight"] * (index + 1) / (p["railCount"] + 1)
            z = (centre - p["railHeight"] / 2, centre + p["railHeight"] / 2)
            # A rail starts inside the post and ends exactly on the cell edge.
            if dx:
                lo, hi = (0, -depth) if dx > 0 else (-half, -depth), (half, depth) if dx > 0 else (0, depth)
            else:
                lo, hi = (-depth, 0) if dy > 0 else (-depth, -half), (depth, half) if dy > 0 else (depth, 0)
            parts.append(box(f"rail-{direction}-{index}", (lo[0], lo[1], z[0]), (hi[0], hi[1], z[1]), material))
            rails.append({"direction": direction, "index": index, "centreHeight": centre})
    bpy.ops.object.select_all(action="DESELECT")
    for obj in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.join()
    fence = bpy.context.object
    fence.name = f"fence-{p['piece']}"
    fence.data.name = f"fence-{p['piece']}-geometry"
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.quads_convert_to_tris()
    bpy.ops.object.mode_set(mode="OBJECT")
    triangles = len(fence.data.polygons)
    if triangles != 12 * len(parts):
        raise ValueError("authoritative box topology differs from the declared budget")
    if triangles > p["maxTriangles"]:
        raise ValueError("fence piece exceeds its maxTriangles budget")
    geometry = b"".join(float(c).hex().encode("ascii") + b"\n" for v in fence.data.vertices for c in v.co)
    geometry += b"".join((",".join(str(i) for i in f.vertices) + "\n").encode("ascii") for f in fence.data.polygons)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "fence-v1", "parameters": p, "unit": "meter", "axes": "right-handed-y-up", "origin": "cell-center-ground",
            "piece": p["piece"], "ports": PORTS[p["piece"]], "rails": rails, "triangleCount": triangles,
            "geometrySha256": hashlib.sha256(geometry).hexdigest(), "materialSlot": "fence-wood"}
