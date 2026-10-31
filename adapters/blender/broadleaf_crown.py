"""Greyhaven broadleaf crown (asset-tooling#446): keep the source trunk, replace its leaves with a soft leaf canopy.

The declared input ``source`` is the imported CC0 Quaternius ``CommonTree_1`` GLB. Its bark primitive is kept as is.
Its leaf primitive is deleted and rebuilt:

* clumps sit on the branch tips of the source trunk, so the canopy follows the real branching;
* a metaball union of the clumps, decimated, is an opaque, dark *core* that stops the sky showing through;
* leaf cards are scattered over that core, mostly facing outward, with the source's leaf-cluster image as a
  greyscale alpha mask. Each card carries the smoothed core normal (no flat card shading) and a per-card
  vertex colour (COLOR_0): deeper and cooler inside and below, warmer and lighter at the sunny top, with per-card
  hue jitter.

Everything is seeded from ``arguments["seed"]``. Blender coordinates are Z up; the GLB is exported +Y up.
"""
import math
import random

import bmesh
import bpy
from mathutils import Color, Vector

RECIPE = "broadleaf-crown-v1"
LEAF_MATERIAL = "Leaves_NormalTree"
CORE_MATERIAL = "Leaves_Core"

# Palette (Blender colour-attribute values), tuned in Blender and in the mmorpg woods view.
LEAF_SHADE = (0.11, 0.25, 0.07)
LEAF_MID = (0.28, 0.47, 0.11)
LEAF_SUN = (0.56, 0.69, 0.19)
CORE = (0.08, 0.17, 0.05)


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "seed", "cards"}:
        raise ValueError("broadleaf crown requires exactly schemaVersion, seed and cards")
    if p["schemaVersion"] != 1 or type(p["seed"]) is not int or type(p["cards"]) is not int or not 100 <= p["cards"] <= 4000:
        raise ValueError("broadleaf crown: schemaVersion 1, integer seed, 100..4000 cards")
    if set(inputs) != {"source"}:
        raise ValueError("broadleaf crown takes exactly the declared input source")


def srgb(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def islands(mesh):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    seen, found = set(), []
    for start in bm.verts:
        if start.index in seen:
            continue
        stack, group = [start], []
        seen.add(start.index)
        while stack:
            a = stack.pop()
            group.append(a.co.copy())
            for edge in a.link_edges:
                b = edge.other_vert(a)
                if b.index not in seen:
                    seen.add(b.index)
                    stack.append(b)
        found.append(group)
    bm.free()
    return found


def clumps(trunk, rng):
    """Leaf clump centres and radii on the source trunk's branch tips."""
    parts = islands(trunk.data)
    height = max(v.z for group in parts for v in group)
    tips = []
    for group in parts:
        top = max(group, key=lambda v: v.z)
        if len(group) >= 40 and top.z > 0.4 * height:
            tips.append(top)
    tips.sort(key=lambda v: (round(v.z, 3), round(v.x, 3), round(v.y, 3)))
    merged = []
    for tip in tips:
        if all((tip - other).length > 0.5 for other in merged):
            merged.append(tip)
    result = []
    for tip in merged:
        out = Vector((tip.x, tip.y, 0))
        out = out.normalized() if out.length > 1e-3 else Vector((0, 0, 0))
        centre = tip + out * 0.35 + Vector((0, 0, 0.3))
        result.append((centre, 0.95 + 0.3 * rng.random(), rng.uniform(-1, 1)))
    # A crowning clump over the leader and a lower skirt keep the silhouette rounded rather than lumpy.
    top = max(merged, key=lambda v: v.z)
    result.append((Vector((top.x, top.y, top.z + 0.35)), 1.05, rng.uniform(-1, 1)))
    # A heart clump on the leader fills the gaps between branch clumps, so no bare trunk shows through the crown.
    low = min(v.z for v in merged)
    result.append((Vector((top.x, top.y, (low + top.z) / 2 + 0.3)), 1.2, rng.uniform(-1, 1)))
    return result, height


def core_mesh(centres, collection, faces):
    meta = bpy.data.metaballs.new("crown_meta")
    meta.resolution = 0.14
    meta.render_resolution = 0.14
    meta.threshold = 0.6
    for centre, radius, _tint in centres:
        element = meta.elements.new()
        element.co = centre
        element.radius = radius * 1.25
        element.type = "ELLIPSOID"
        element.size_x = element.size_y = 1.0
        element.size_z = 0.85
    ball = bpy.data.objects.new("crown_meta", meta)
    collection.objects.link(ball)
    bpy.context.view_layer.update()
    mesh = bpy.data.meshes.new_from_object(ball.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(ball)
    bpy.data.metaballs.remove(meta)
    core = bpy.data.objects.new("crown_core", mesh)
    collection.objects.link(core)
    decimate = core.modifiers.new("decimate", "DECIMATE")
    decimate.ratio = min(1.0, faces / max(1, len(mesh.polygons)))
    decimate.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = core
    with bpy.context.temp_override(object=core, active_object=core):
        bpy.ops.object.modifier_apply(modifier=decimate.name)
    for polygon in core.data.polygons:
        polygon.use_smooth = True
    return core


def leaf_image(source):
    """The source leaf cluster as a bright greyscale mask, so COLOR_0 alone sets the hue."""
    w, h = source.size
    px = list(source.pixels[:])
    lum = []
    for i in range(0, len(px), 4):
        if px[i + 3] > 0.5:
            lum.append(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])
    lum.sort()
    hi = lum[int(len(lum) * 0.97)] if lum else 1.0
    out = [0.0] * len(px)
    for i in range(0, len(px), 4):
        a = px[i + 3]
        g = min(1.0, (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / hi) if a > 0.02 else 0.85
        g = 0.55 + 0.45 * g  # keep the painted strokes, but soft
        out[i] = out[i + 1] = out[i + 2] = g
        out[i + 3] = a
    image = bpy.data.images.new("Leaves_Broadleaf", w, h, alpha=True)
    image.pixels[:] = out
    image.file_format = "PNG"
    image.pack()
    return image


def leaf_material(image):
    mat = bpy.data.materials.new(LEAF_MATERIAL)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    mul = nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs[0].default_value = 1.0
    links.new(tex.outputs["Color"], mul.inputs[6])
    links.new(attr.outputs["Color"], mul.inputs[7])
    links.new(mul.outputs[2], bsdf.inputs["Base Color"])
    # Round(alpha) exports as glTF alphaMode MASK.
    rnd = nodes.new("ShaderNodeMath")
    rnd.operation = "ROUND"
    links.new(tex.outputs["Alpha"], rnd.inputs[0])
    links.new(rnd.outputs[0], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.use_backface_culling = False
    return mat


def core_material():
    mat = bpy.data.materials.new(CORE_MATERIAL)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    mat.use_backface_culling = True
    return mat


def sample_surface(core, count, rng):
    mesh = core.data
    mesh.calc_loop_triangles()
    tris = []
    total = 0.0
    for tri in mesh.loop_triangles:
        total += tri.area
        tris.append((total, tri))
    out = []
    for _ in range(count):
        pick = rng.random() * total
        lo, hi = 0, len(tris) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if tris[mid][0] < pick:
                lo = mid + 1
            else:
                hi = mid
        tri = tris[lo][1]
        a, b = rng.random(), rng.random()
        if a + b > 1:
            a, b = 1 - a, 1 - b
        ids = tri.vertices
        v = [mesh.vertices[i] for i in ids]
        point = v[0].co * (1 - a - b) + v[1].co * a + v[2].co * b
        normal = (v[0].normal * (1 - a - b) + v[1].normal * a + v[2].normal * b).normalized()
        out.append((point, normal))
    return out


def colour_core(core, zmin, zmax):
    mesh = core.data
    layer = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for loop in mesh.loops:
        v = mesh.vertices[loop.vertex_index]
        t = max(0.0, min(1.0, (v.co.z - zmin) / (zmax - zmin)))
        c = mix(CORE, LEAF_SHADE, 0.6 * t)
        layer.data[loop.index].color = (*c, 1.0)


def build_crown(trunk, source_leaf_image, seed, cards, collection):
    rng = random.Random(seed)
    centres, _height = clumps(trunk, rng)
    core = core_mesh(centres, collection, faces=420)
    # Shrink the core so card silhouettes, not the core, form the crown edge.
    centre = sum((c for c, _r, _t in centres), Vector()) / len(centres)
    zs = [v.co.z for v in core.data.vertices]
    zmin, zmax = min(zs), max(zs)
    samples = sample_surface(core, cards, rng)
    for v in core.data.vertices:
        v.co = v.co - v.normal * 0.18
    colour_core(core, zmin, zmax)
    core.data.materials.append(core_material())

    verts, faces, normals, colours, uvs = [], [], [], [], []
    sun = Vector((0.35, -0.45, 0.82)).normalized()
    for point, normal in samples:
        size = 0.62 + 0.3 * rng.random()
        offset = -0.05 + 0.22 * rng.random()
        c = point + normal * offset
        jitter = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        facing = (normal + jitter * 0.55 + Vector((0, 0, 0.25))).normalized()
        tangent = facing.cross(Vector((0, 0, 1)))
        if tangent.length < 1e-3:
            tangent = Vector((1, 0, 0))
        tangent.normalize()
        bitangent = facing.cross(tangent).normalized()
        roll = rng.uniform(0, 2 * math.pi)
        u = tangent * math.cos(roll) + bitangent * math.sin(roll)
        w = facing.cross(u).normalized()
        half = size / 2
        base = len(verts)
        for su, sv, uv in ((-1, -1, (0, 0)), (1, -1, (1, 0)), (1, 1, (1, 1)), (-1, 1, (0, 1))):
            corner = c + u * (su * half) + w * (sv * half)
            verts.append(corner)
            # Bend card normals to the crown volume: soft, rounded shading instead of flat planes.
            radial = (corner - centre)
            radial.z *= 0.7
            normals.append((normal * 0.65 + radial.normalized() * 0.35).normalized())
            uvs.append(uv)
        faces.append((base, base + 1, base + 2, base + 3))
        # Colour: height and sun exposure lift the tone; depth inside the crown and the underside deepen it.
        t = max(0.0, min(1.0, (c.z - zmin) / (zmax - zmin)))
        lit = max(0.0, normal.dot(sun))
        up = max(0.0, normal.z)
        _, _, tint = min(centres, key=lambda item: (item[0] - c).length / item[1])
        down = max(0.0, -normal.z)
        tone = 0.1 + 0.35 * t * t + 0.2 * lit + 0.25 * up - 0.35 * down + 0.8 * max(0.0, offset) + 0.12 * tint
        tone = max(0.0, min(1.0, tone + rng.uniform(-0.1, 0.1)))
        rgb = mix(LEAF_SHADE, LEAF_MID, min(1.0, tone * 1.6)) if tone < 0.62 else mix(LEAF_MID, LEAF_SUN, (tone - 0.62) / 0.38)
        hsv = Color(rgb)
        hsv.h = (hsv.h + 0.02 * tint + rng.uniform(-0.02, 0.02)) % 1.0
        hsv.v *= rng.uniform(0.9, 1.08)
        colours.append((hsv.r, hsv.g, hsv.b))
    mesh = bpy.data.meshes.new("crown_leaves")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    uv = mesh.uv_layers.new(name="UVMap")
    col = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for poly, rgb in zip(mesh.polygons, colours):
        poly.use_smooth = True
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[mesh.loops[li].vertex_index]
            col.data[li].color = (*rgb, 1.0)
    mesh.normals_split_custom_set_from_vertices([tuple(n) for n in normals])
    mesh.materials.append(leaf_material(leaf_image(source_leaf_image)))
    leaves = bpy.data.objects.new("crown_leaves", mesh)
    collection.objects.link(leaves)
    return core, leaves


def triangles(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=inputs["source"])
    tree = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    slot = next(i for i, m in enumerate(tree.data.materials) if m and m.name.startswith(LEAF_MATERIAL))
    leaf_source = next(n.image for n in tree.data.materials[slot].node_tree.nodes if n.type == "TEX_IMAGE")
    bm = bmesh.new()
    bm.from_mesh(tree.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index == slot], context="FACES")
    bm.to_mesh(tree.data)
    bm.free()
    bpy.data.materials.remove(tree.data.materials.pop(index=slot))
    for attribute in list(tree.data.color_attributes):
        tree.data.color_attributes.remove(attribute)
    trunk_triangles = triangles(tree)
    core, leaves = build_crown(tree, leaf_source, arguments["seed"], arguments["cards"], bpy.context.scene.collection)
    core_triangles, leaf_triangles = triangles(core), triangles(leaves)
    # The bark keeps its look: COLOR_0 is white there (glTF multiplies it into the base colour).
    white = tree.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for item in white.data:
        item.color = (1.0, 1.0, 1.0, 1.0)
    # One mesh node, as before: trunk, core and leaves join into the source's node.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (core, leaves, tree):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = tree
    bpy.ops.object.join()
    colours = tree.data.color_attributes
    colours.active_color = colours["Col"]
    colours.render_color_index = colours.active_color_index
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "seed": arguments["seed"], "cards": arguments["cards"],
            "trunkTriangles": trunk_triangles, "coreTriangles": core_triangles, "leafTriangles": leaf_triangles,
            "triangles": triangles(tree)}
