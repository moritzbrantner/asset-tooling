"""Woodland-edge bushes for mmorpg (docs/woodland-bushes.md): six shrubs of one habitat, dark and dense.

A bush is leaf cards over a dark opaque core, as in ``nature_bush.py`` (the declared input ``bush``), whose core,
surface sampling, materials and fit it reuses. What differs is here:

* every leaf is original: one generated 1024 px greyscale atlas holds two leaf-cluster cells per kind plus a berry and
  a blossom cell, each cell with a transparent gutter, so all pieces share one cut-out material;
* each kind has its own footprint, palette and leaf shape, in the tables below;
* clumps climb from the soil to the crown, so the foliage reaches the ground and no stem shows;
* a fruiting kind adds a few proud cards of its fruit cell, coloured through ``COLOR_0``.

The arguments are ``kind`` and ``variant`` (1 or 2); the variant only changes the seed. The result is one mesh node,
fitted to the kind's size on the ground and centred on its footprint. Blender coordinates are Z up; the GLB is
exported +Y up. Everything is seeded (``numpy.random.RandomState`` and ``random.Random``), so builds are repeatable.
"""
import math
import random
import runpy

import bpy
import numpy
from mathutils import Vector

RECIPE = "woodland-bushes-v1"
# nature_lod.py recognises these two by prefix, and they stay the same at every level.
LEAF_MATERIAL = "Leaves_Bush_Woodland"
CORE_MATERIAL = "Leaves_Core_Woodland"
ATLAS = 1024
CELLS = 4  # per side
GUTTER = 14  # transparent pixels around each cell's content, clean down to mip 3
CORE_FACES = 90
CLUMPS = 7
FRUIT_CARDS = 44  # sampled; those low on the bush are dropped, leaving about 26
FRUIT_FLOOR = 0.38  # share of the height below which a bush carries no fruit
GOLDEN_ANGLE = 2.39996
CORE_SHADE = 0.8  # the core's colour as a share of the kind's shadow colour: gaps read as shade, not as a dark ball
CORE_INSET = 0.06  # how far the core shrinks inward, as a share of the bush's mean width


def lin(value):
    """A hex sRGB colour as linear RGB."""
    channels = [int(value[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels)


# Per kind: width, depth and height in metres, card edge in metres, card count, the shadow and sun leaf colours, and
# the fruit cell with its colour. The colours are the ones the owner approved in the mockup.
KINDS = {
    "hazel": {"size": (2.9, 2.7, 1.7), "card": 1.0, "cards": 270, "shade": "#264d21", "sun": "#5c873c"},
    "holly": {"size": (1.9, 1.9, 2.1), "card": 0.76, "cards": 270, "shade": "#14351d", "sun": "#3a6930", "fruit": ("berry", "#a32323")},
    "bramble": {"size": (2.2, 2.2, 1.05), "card": 0.66, "cards": 260, "shade": "#1e4221", "sun": "#4c7735", "fruit": ("berry", "#8f2626")},
    "hawthorn": {"size": (3.2, 2.8, 2.0), "card": 0.9, "cards": 280, "shade": "#274b24", "sun": "#5d853f", "fruit": ("blossom", "#ddd8c6")},
    "juniper": {"size": (1.4, 1.4, 2.4), "card": 0.74, "cards": 260, "shade": "#183728", "sun": "#46704c"},
    "elder": {"size": (2.6, 2.6, 2.1), "card": 0.96, "cards": 270, "shade": "#29522a", "sun": "#658f45"},
}
# Per kind: leaves in a cluster, leaf length and width (share of the cell, share of the length) and outline.
LEAVES = {
    "hazel": {"count": 24, "length": 0.34, "width": 0.34, "outline": "plain"},
    "holly": {"count": 28, "length": 0.27, "width": 0.3, "outline": "spiked"},
    "bramble": {"count": 30, "length": 0.25, "width": 0.3, "outline": "plain"},
    "hawthorn": {"count": 42, "length": 0.18, "width": 0.38, "outline": "lobed"},
    "juniper": {"count": 110, "length": 0.3, "width": 0.05, "outline": "plain"},
    "elder": {"count": 32, "length": 0.3, "width": 0.2, "outline": "plain"},
}
# Round marks painted in place of leaves: mark count and radius (share of the cell).
MARKS = {"berry": (12, 0.055), "blossom": (22, 0.05)}
CELL_NAMES = [f"{kind}-{n}" for kind in KINDS for n in (1, 2)] + list(MARKS)


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "kind", "variant"} or p["schemaVersion"] != 1:
        raise ValueError("woodland bushes require exactly schemaVersion 1, kind and variant")
    if p["kind"] not in KINDS or p["variant"] not in (1, 2):
        raise ValueError(f"woodland bushes: kind in {sorted(KINDS)}, variant 1 or 2")
    if set(inputs) != {"bush"}:
        raise ValueError("woodland bushes take exactly the declared input bush")


def outline(u, shape):
    """The leaf's half width at ``u`` along it, as a share of its widest."""
    body = numpy.sin(math.pi * numpy.clip(u, 0, 1)) ** 0.8
    if shape == "spiked":
        return body * (0.68 + 0.32 * numpy.sign(numpy.sin(u * 18)))
    if shape == "lobed":
        return body * (0.68 + 0.32 * numpy.abs(numpy.sin(u * 9)))
    return body


def paint_leaves(tone, alpha, spec, rng):
    """A cluster of leaves radiating from the cell's middle into ``tone`` and ``alpha`` (one cell, coordinates 0..1)."""
    n = tone.shape[0]
    y, x = numpy.mgrid[0:n, 0:n] / n
    for _ in range(spec["count"]):
        a = rng.uniform(0, math.tau)
        reach = rng.uniform(0.05, 0.36)
        cx, cy = 0.5 + math.cos(a) * reach, 0.5 + math.sin(a) * reach
        turn = a + rng.uniform(-0.6, 0.6)
        length = spec["length"] * rng.uniform(0.8, 1.15)
        dx, dy = x - cx, y - cy
        u = (dx * math.cos(turn) + dy * math.sin(turn)) / length + 0.5
        v = -dx * math.sin(turn) + dy * math.cos(turn)
        mask = (u >= 0) & (u <= 1) & (numpy.abs(v) < spec["width"] * length * outline(u, spec["outline"]))
        shade = rng.uniform(0.62, 1.0)
        tone[mask] = (shade * numpy.where(v > 0, 1.0, 0.9) * numpy.where(numpy.abs(v) < 0.007, 0.72, 1.0))[mask]
        alpha[mask] = 1.0


def paint_marks(tone, alpha, count, radius, rng):
    n = tone.shape[0]
    y, x = numpy.mgrid[0:n, 0:n] / n
    for _ in range(count):
        cx, cy = rng.uniform(0.15, 0.85, 2)
        distance = numpy.hypot(x - cx, y - cy) / radius
        mask = distance < 1
        tone[mask] = (1.0 - 0.3 * distance)[mask]
        alpha[mask] = 1.0


def leaf_atlas():
    """The whole atlas as a Blender image: grey in RGB, so ``COLOR_0`` sets the hue, and a cut-out alpha."""
    size = ATLAS // CELLS
    pixels = numpy.zeros((ATLAS, ATLAS, 4), dtype=numpy.float32)
    pixels[:, :, :3] = 0.85  # the colour that mip levels bleed from the empty gutters
    for index, name in enumerate(CELL_NAMES):
        row, col = divmod(index, CELLS)
        inner = size - 2 * GUTTER
        tone, alpha = numpy.full((inner, inner), 0.85, dtype=numpy.float32), numpy.zeros((inner, inner), dtype=numpy.float32)
        rng = numpy.random.RandomState(1000 + index)
        if name in MARKS:
            paint_marks(tone, alpha, *MARKS[name], rng)
        else:
            paint_leaves(tone, alpha, LEAVES[name.rsplit("-", 1)[0]], rng)
        y, x = row * size + GUTTER, col * size + GUTTER
        pixels[y:y + inner, x:x + inner, :3] = (0.55 + 0.45 * tone)[:, :, None]
        pixels[y:y + inner, x:x + inner, 3] = alpha
    image = bpy.data.images.new("woodland-bush-leaves", ATLAS, ATLAS, alpha=True)
    image.pixels.foreach_set(pixels.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def cell_uvs(name):
    """The card's four corner UVs over the named cell."""
    row, col = divmod(CELL_NAMES.index(name), CELLS)
    return [((col + du) / CELLS, (row + dv) / CELLS) for du, dv in ((0, 0), (1, 0), (1, 1), (0, 1))]


def clump_centres(size, rng):
    """Clump centres, radii and tints climbing from the soil to the crown."""
    w, d, h = size
    r0 = 0.13 * (w + d)
    # A heart low in the middle, then a spiral: random angles leave a tall narrow bush leaning like a worm.
    centres = [(Vector((0, 0, 0.35 * h)), 1.15 * r0, rng.uniform(-1, 1))]
    narrow = min(1.0, 1.3 * (w + d) / (2 * h))
    phase = rng.uniform(0, math.tau)
    for i in range(CLUMPS):
        f = i / (CLUMPS - 1)
        a = phase + i * GOLDEN_ANGLE + rng.uniform(-0.25, 0.25)
        inset = (0.46 - 0.2 * f) * narrow
        centres.append((Vector((math.cos(a) * w / 2 * inset, math.sin(a) * d / 2 * inset, h * (0.2 + 0.62 * f))), r0 * rng.uniform(0.85, 1.1), rng.uniform(-1, 1)))
    return centres


def colour_core(core, shade):
    mesh = core.data
    layer = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    colour = (*[c * CORE_SHADE for c in shade], 1.0)
    for loop in mesh.loops:
        layer.data[loop.index].color = colour


def add_card(buffers, point, normal, edge, facing_jitter, uvs, rgb, centre, rng):
    verts, faces, normals, colours, uv_out = buffers
    jitter = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
    facing = (normal + jitter * facing_jitter + Vector((0, 0, 0.2))).normalized()
    tangent = facing.cross(Vector((0, 0, 1)))
    if tangent.length < 1e-3:
        tangent = Vector((1, 0, 0))
    tangent.normalize()
    bitangent = facing.cross(tangent).normalized()
    roll = rng.uniform(0, math.tau)
    u = tangent * math.cos(roll) + bitangent * math.sin(roll)
    v = facing.cross(u).normalized()
    half = edge / 2
    base = len(verts)
    for (su, sv), uv in zip(((-1, -1), (1, -1), (1, 1), (-1, 1)), uvs):
        corner = point + u * (su * half) + v * (sv * half)
        corner.z = max(corner.z, 0.01)
        verts.append(corner)
        radial = corner - centre
        radial.z *= 0.7
        normals.append((normal * 0.6 + radial.normalized() * 0.4).normalized())
        uv_out.append(uv)
    faces.append((base, base + 1, base + 2, base + 3))
    colours.append(rgb)


def build_bush(kind, variant, collection, bush):
    spec = KINDS[kind]
    seed = 5320 + 10 * list(KINDS).index(kind) + variant
    rng = random.Random(seed)
    size = spec["size"]
    w, d, h = size
    centres = clump_centres(size, rng)
    core = bush["core_mesh"](centres, collection, CORE_FACES)
    # Fit the core inside the size less the cards' overhang, so the final fit stays near 1 and the cards keep their shape.
    over = spec["card"] * 0.35
    target = (w - 2 * over, d - 2 * over, h - over)
    lo = [min(v.co[k] for v in core.data.vertices) for k in range(3)]
    hi = [max(v.co[k] for v in core.data.vertices) for k in range(3)]
    mid = Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0))
    factor = Vector([target[k] / max(1e-6, hi[k] - (lo[k] if k < 2 else 0)) for k in range(3)])
    for v in core.data.vertices:
        v.co = (v.co - mid) * factor
    core.data.update()
    zmax = max(v.co.z for v in core.data.vertices)
    samples = bush["sample_surface"](core, spec["cards"] + FRUIT_CARDS, rng, floor=0.04 * h)
    shrink = CORE_INSET * (w + d) / 2
    for v in core.data.vertices:
        v.co = v.co - v.normal * shrink * min(1.0, v.co.z / (0.25 * h))
    shade, sun = lin(spec["shade"]), lin(spec["sun"])
    colour_core(core, shade)
    core_mat = bush["core_material"]()
    core_mat.name = CORE_MATERIAL
    core.data.materials.append(core_mat)
    # The cards' UV layer has the same name, so the join keeps one TEXCOORD_0 (the core ignores it).
    core.data.uv_layers.new(name="UVMap")

    centre = Vector((0, 0, 0.4 * h))
    key_light = Vector((0.35, -0.45, 0.82)).normalized()
    buffers = ([], [], [], [], [])
    for index, (point, normal) in enumerate(samples):
        fruit = spec.get("fruit") if index >= spec["cards"] else None
        if index >= spec["cards"] and (not fruit or point.z < FRUIT_FLOOR * h):
            continue
        depth = rng.random()  # 0: tucked into the core, 1: standing proud
        place = point + normal * (spec["card"] * (0.12 if fruit else -0.06 + 0.16 * depth))
        if fruit:
            add_card(buffers, place, normal, 0.5, 0.3, cell_uvs(fruit[0]), lin(fruit[1]), centre, rng)
            continue
        t = max(0.0, min(1.0, place.z / zmax))
        lit = max(0.0, normal.dot(key_light))
        tone = 0.15 + 0.3 * t + 0.2 * lit + 0.35 * depth * depth - 0.3 * max(0.0, -normal.z) - 0.25 * max(0.0, 1 - t / 0.4)
        tone = max(0.0, min(1.0, tone + rng.uniform(-0.1, 0.1)))
        rgb = bush["mix"](shade, sun, tone)
        add_card(buffers, place, normal, spec["card"] * rng.uniform(0.85, 1.15), 0.55, cell_uvs(f"{kind}-{rng.randint(1, 2)}"), rgb, centre, rng)
    verts, faces, normals, colours, uvs = buffers
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
    leaf_mat = bush["leaf_material"](leaf_atlas())
    leaf_mat.name = LEAF_MATERIAL
    mesh.materials.append(leaf_mat)
    leaves = bpy.data.objects.new("bush_leaves", mesh)
    collection.objects.link(leaves)
    return core, leaves, seed


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bush = runpy.run_path(inputs["bush"])
    kind, variant = arguments["kind"], arguments["variant"]
    core, leaves, seed = build_bush(kind, variant, bpy.context.scene.collection, bush)
    factor = bush["fit"]((core, leaves), [float(v) for v in KINDS[kind]["size"]])
    core_triangles, leaf_triangles = bush["triangles"](core), bush["triangles"](leaves)
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
        export_all_vertex_colors=False, export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "kind": kind, "variant": variant, "seed": seed, "fit": [round(f, 4) for f in factor],
            "coreTriangles": core_triangles, "leafTriangles": leaf_triangles, "triangles": bush["triangles"](core)}
