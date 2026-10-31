"""Greyhaven bushes (asset-tooling#462): leaf-card clumps over a dark core, at the reworked broadleaf's standard.

The declared input ``leaves`` is the CC0 Quaternius ``Leaves_NormalTree_C.png`` leaf cluster, the image the broadleaf
crown (#446) turns into its greyscale card mask, so bushes and trees share one leaf look. A bush is built from scratch:

* seeded leaf clumps fill an ellipsoid of the requested ``size`` (``shape`` sets how they spread: ``round``,
  ``spreading`` or ``upright``), with a heart clump low in the middle so the bush meets the ground;
* a metaball union of the clumps, decimated and shrunk inward, is an opaque dark *core* (``Leaves_Core``) that stops
  the ground and sky showing through; it is cut flat at the ground;
* ``cards`` leaf cards (``Leaves_Bush``, alpha ``MASK``) are scattered over the core, mostly facing outward, with the
  same greyscale mask as the broadleaf, so the colour comes from ``COLOR_0``. Their normals bend towards the bush
  volume (soft foliage shading) and their colour uses the broadleaf's palette: deep and cool near the ground, inside
  and underneath, warm yellow-green on the sunny top, with a per-clump tint and per-card hue and value jitter.

The result is one mesh node (core and cards) fitted to ``size`` (width x depth x height, metres) on the ground. There
is no bark: the core reaches the ground. Everything is seeded from ``arguments["seed"]``. Blender coordinates are Z
up; the GLB is exported +Y up.
"""
import math
import random

import bmesh
import bpy
from mathutils import Color, Vector

RECIPE = "nature-bush-v1"
LEAF_MATERIAL = "Leaves_Bush"
CORE_MATERIAL = "Leaves_Core"

# The broadleaf crown's palette (broadleaf_crown.py), so bushes and trees read as one wood.
LEAF_SHADE = (0.11, 0.25, 0.07)
LEAF_MID = (0.28, 0.47, 0.11)
LEAF_SUN = (0.56, 0.69, 0.19)
CORE = (0.07, 0.15, 0.045)

# Per shape: clump count, clump radius (share of the half width), and the share of the height the clumps climb to.
SHAPES = {
    "round": {"clumps": 9, "radius": 0.5, "climb": 0.62},
    "spreading": {"clumps": 11, "radius": 0.42, "climb": 0.55},
    "upright": {"clumps": 8, "radius": 0.55, "climb": 0.7},
}
CORE_FACES = 90
CARD_SIZE = (0.4, 0.58)  # metres, for a 1.4 m bush; scales with the bush's mean width
GROUND_DARK = 0.35  # how much darker the cards are at the ground than at mid height


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "shape", "seed", "size", "cards"}:
        raise ValueError("nature bush requires exactly schemaVersion, shape, seed, size and cards")
    if p["schemaVersion"] != 1 or p["shape"] not in SHAPES or type(p["seed"]) is not int:
        raise ValueError(f"nature bush: schemaVersion 1, shape in {sorted(SHAPES)}, integer seed")
    size = p["size"]
    if type(size) is not list or len(size) != 3 or not all(type(v) in (int, float) and 0.3 <= v <= 4 for v in size):
        raise ValueError("nature bush size is [width, depth, height] in metres, each 0.3..4")
    if type(p["cards"]) is not int or not 40 <= p["cards"] <= 1500:
        raise ValueError("nature bush cards must be an integer in 40..1500")
    if set(inputs) != {"leaves"}:
        raise ValueError("nature bush takes exactly the declared input leaves")


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def clumps(shape, size, rng):
    """Leaf clump centres, radii and tints filling the bush's ellipsoid."""
    w, d, h = size
    spec = SHAPES[shape]
    rx, ry = w / 2, d / 2
    r0 = spec["radius"] * (rx + ry) / 2
    result = [(Vector((0, 0, 0.42 * h)), 1.15 * r0, rng.uniform(-1, 1))]  # the heart, low in the middle
    tries = 0
    while len(result) < spec["clumps"] and tries < 2000:
        tries += 1
        a = rng.uniform(0, 2 * math.pi)
        reach = math.sqrt(rng.uniform(0.25, 1.0))
        z = h * rng.uniform(0.3, spec["climb"])
        # Narrow towards the top so the bush domes rather than stands as a cylinder.
        taper = 1 - 0.55 * max(0.0, (z / h - 0.35) / 0.65) ** 1.5
        x, y = math.cos(a) * reach * (rx - 0.6 * r0) * taper, math.sin(a) * reach * (ry - 0.6 * r0) * taper
        centre = Vector((x, y, z))
        radius = r0 * rng.uniform(0.75, 1.05)
        if all((centre - other).length > 0.55 * (radius + other_r) for other, other_r, _t in result):
            result.append((centre, radius, rng.uniform(-1, 1)))
    return result


def core_mesh(centres, collection, faces):
    meta = bpy.data.metaballs.new("bush_meta")
    meta.resolution = meta.render_resolution = 0.08
    meta.threshold = 0.6
    for centre, radius, _tint in centres:
        element = meta.elements.new()
        element.co = centre
        element.radius = radius * 1.6
        element.type = "ELLIPSOID"
        element.size_x = element.size_y = 1.0
        element.size_z = 0.8
    ball = bpy.data.objects.new("bush_meta", meta)
    collection.objects.link(ball)
    bpy.context.view_layer.update()
    mesh = bpy.data.meshes.new_from_object(ball.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(ball)
    bpy.data.metaballs.remove(meta)
    # Cut flat at the ground: nothing below it is seen, and the bush stands on its footprint.
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-4,
                           plane_co=(0, 0, 0), plane_no=(0, 0, 1), clear_inner=True)
    bm.to_mesh(mesh)
    bm.free()
    core = bpy.data.objects.new("bush_core", mesh)
    collection.objects.link(core)
    decimate = core.modifiers.new("decimate", "DECIMATE")
    decimate.ratio = min(1.0, faces / max(1, len(mesh.polygons)))
    decimate.use_collapse_triangulate = True
    with bpy.context.temp_override(object=core, active_object=core):
        bpy.ops.object.modifier_apply(modifier=decimate.name)
    for polygon in core.data.polygons:
        polygon.use_smooth = True
    return core


def leaf_image(path):
    """The leaf cluster as a bright greyscale mask, exactly as the broadleaf crown makes it: COLOR_0 sets the hue."""
    source = bpy.data.images.load(path)
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
        g = 0.55 + 0.45 * g
        out[i] = out[i + 1] = out[i + 2] = g
        out[i + 3] = a
    bpy.data.images.remove(source)
    image = bpy.data.images.new("Leaves_Bush", w, h, alpha=True)
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


def sample_surface(core, count, rng, floor):
    """``count`` area-weighted points (with smooth normals) on the core, none lower than ``floor``."""
    mesh = core.data
    mesh.calc_loop_triangles()
    tris, total = [], 0.0
    for tri in mesh.loop_triangles:
        if max(mesh.vertices[i].co.z for i in tri.vertices) < floor:
            continue
        total += tri.area
        tris.append((total, tri))
    out = []
    while len(out) < count:
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
        v = [mesh.vertices[i] for i in tri.vertices]
        point = v[0].co * (1 - a - b) + v[1].co * a + v[2].co * b
        if point.z < floor:
            continue
        normal = (v[0].normal * (1 - a - b) + v[1].normal * a + v[2].normal * b).normalized()
        out.append((point, normal))
    return out


def colour_core(core, height):
    mesh = core.data
    layer = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for loop in mesh.loops:
        t = max(0.0, min(1.0, mesh.vertices[loop.vertex_index].co.z / height))
        layer.data[loop.index].color = (*mix(CORE, LEAF_SHADE, 0.55 * t), 1.0)


def build_bush(shape, size, seed, cards, leaves_path, collection):
    rng = random.Random(seed)
    w, d, h = size
    centres = clumps(shape, size, rng)
    core = core_mesh(centres, collection, CORE_FACES)
    # Fit the core inside the requested size less the cards' overhang, so the final fit stays close to 1 and the
    # cards keep their shape.
    scale = (w + d) / 2 / 1.4
    over = scale * 0.32
    target = (w - 2 * over, d - 2 * over, h - over)
    lo = [min(v.co[k] for v in core.data.vertices) for k in range(3)]
    hi = [max(v.co[k] for v in core.data.vertices) for k in range(3)]
    mid = Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0))
    factor = Vector([target[k] / max(1e-6, hi[k] - (lo[k] if k < 2 else 0)) for k in range(3)])
    for v in core.data.vertices:
        v.co = (v.co - mid) * factor
    centres = [((c - mid) * factor, r, t) for c, r, t in centres]
    core.data.update()
    zmax = max(v.co.z for v in core.data.vertices)
    samples = sample_surface(core, cards, rng, floor=0.12 * h)
    # Shrink the core so card silhouettes, not the core, form the bush's edge (but keep it on the ground).
    shrink = 0.03 * (w + d) / 2
    for v in core.data.vertices:
        v.co = v.co - v.normal * shrink * min(1.0, v.co.z / (0.25 * h))
    colour_core(core, zmax)
    core.data.materials.append(core_material())
    # The cards' UV layer has the same name, so the join keeps one TEXCOORD_0 (the core ignores it).
    core.data.uv_layers.new(name="UVMap")

    centre = Vector((0, 0, 0.4 * h))
    sun = Vector((0.35, -0.45, 0.82)).normalized()
    verts, faces, normals, colours, uvs = [], [], [], [], []
    for point, normal in samples:
        size_card = scale * rng.uniform(*CARD_SIZE)
        depth = rng.random()  # 0: tucked into the core, 1: standing proud
        offset = scale * (-0.06 + 0.16 * depth)
        c = point + normal * offset
        jitter = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        facing = (normal + jitter * 0.55 + Vector((0, 0, 0.2))).normalized()
        tangent = facing.cross(Vector((0, 0, 1)))
        if tangent.length < 1e-3:
            tangent = Vector((1, 0, 0))
        tangent.normalize()
        bitangent = facing.cross(tangent).normalized()
        roll = rng.uniform(0, 2 * math.pi)
        u = tangent * math.cos(roll) + bitangent * math.sin(roll)
        v = facing.cross(u).normalized()
        half = size_card / 2
        base = len(verts)
        for su, sv, uv in ((-1, -1, (0, 0)), (1, -1, (1, 0)), (1, 1, (1, 1)), (-1, 1, (0, 1))):
            corner = c + u * (su * half) + v * (sv * half)
            corner.z = max(corner.z, 0.01)
            verts.append(corner)
            radial = corner - centre
            radial.z *= 0.7
            normals.append((normal * 0.6 + radial.normalized() * 0.4).normalized())
            uvs.append(uv)
        faces.append((base, base + 1, base + 2, base + 3))
        t = max(0.0, min(1.0, c.z / zmax))
        lit = max(0.0, normal.dot(sun))
        up = max(0.0, normal.z)
        down = max(0.0, -normal.z)
        _, _, tint = min(centres, key=lambda item: (item[0] - c).length / item[1])
        tone = (-0.2 + 0.3 * t * t + 0.15 * lit + 0.15 * up - 0.3 * down + 0.45 * depth * depth
                + 0.12 * tint - GROUND_DARK * max(0.0, 1 - t / 0.45))
        tone = max(0.0, min(1.0, tone + rng.uniform(-0.1, 0.1)))
        rgb = mix(LEAF_SHADE, LEAF_MID, min(1.0, tone * 1.6)) if tone < 0.62 else mix(LEAF_MID, LEAF_SUN, (tone - 0.62) / 0.38)
        hsv = Color(rgb)
        hsv.h = (hsv.h + 0.02 * tint + rng.uniform(-0.02, 0.02)) % 1.0
        hsv.s = min(1.0, hsv.s * 1.08)
        hsv.v *= rng.uniform(0.88, 1.06)
        colours.append((hsv.r, hsv.g, hsv.b))
    mesh = bpy.data.meshes.new("bush_leaves")
    mesh.from_pydata([tuple(p) for p in verts], [], faces)
    uv_layer = mesh.uv_layers.new(name="UVMap")
    col = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for poly, rgb in zip(mesh.polygons, colours):
        poly.use_smooth = True
        for li in poly.loop_indices:
            uv_layer.data[li].uv = uvs[mesh.loops[li].vertex_index]
            col.data[li].color = (*rgb, 1.0)
    mesh.normals_split_custom_set_from_vertices([tuple(n) for n in normals])
    mesh.materials.append(leaf_material(leaf_image(leaves_path)))
    leaves = bpy.data.objects.new("bush_leaves", mesh)
    collection.objects.link(leaves)
    return core, leaves


def fit(objects, size):
    """Scale about the footprint centre so the bush spans ``size`` exactly, standing on z = 0."""
    corners = [o.matrix_world @ v.co for o in objects for v in o.data.vertices]
    lo = Vector([min(c[k] for c in corners) for k in range(3)])
    hi = Vector([max(c[k] for c in corners) for k in range(3)])
    factor = [size[k] / max(1e-6, hi[k] - lo[k]) for k in range(3)]
    mid = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    for o in objects:
        for v in o.data.vertices:
            p = v.co - mid
            v.co = Vector((p.x * factor[0], p.y * factor[1], p.z * factor[2]))
    return factor


def triangles(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    shape, size = arguments["shape"], [float(v) for v in arguments["size"]]
    core, leaves = build_bush(shape, size, arguments["seed"], arguments["cards"], inputs["leaves"], bpy.context.scene.collection)
    # Custom normals survive the near-unit fit; the fit only corrects the clumps' overshoot.
    factor = fit((core, leaves), size)
    core_triangles, leaf_triangles = triangles(core), triangles(leaves)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (core, leaves):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = core
    bpy.ops.object.join()
    core.name = core.data.name = "bush"
    colours = core.data.color_attributes
    colours.active_color = colours["Col"]
    colours.render_color_index = colours.active_color_index
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "shape": shape, "seed": arguments["seed"], "cards": arguments["cards"],
            "fit": [round(f, 4) for f in factor], "coreTriangles": core_triangles, "leafTriangles": leaf_triangles,
            "triangles": triangles(core)}
