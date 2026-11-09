"""Ivy (docs/ivy.md): seven generic pieces of dark, sparse English ivy to lay over stone, one habitat on purpose.

Vines grow up a rectangle ``(s, t)`` and carry leaf-cluster cards; a ragged outline and noise gaps let the stone and stems
show. Each piece maps that rectangle onto its surface: a wall, a wall's top edge, the ground, a column or a corner. Every
leaf is original: one generated greyscale atlas holds the clusters, and ``COLOR_0`` tints each card from shade to sun. The
cards are one cut-out material and the stems one small opaque one.

``arguments`` are ``piece`` and ``level`` (0 is full detail, 1 and 2 are ``lod1`` and ``lod2``: the same growth with fewer,
larger cards and fewer stem segments, on the same atlas). Vines and cards come from ``numpy``'s legacy ``RandomState`` and
``mathutils.noise``, which holds no random state. Pieces are authored in glTF axes (metres, +Y up); see ``docs/ivy.md`` for
each kind's origin.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector, noise

RECIPE = "ivy-v1"
LEAF_MATERIAL, STEM_MATERIAL = "ivy-leaves", "ivy-stem"
ATLAS, CELLS, GUTTER = 1024, 2, 14  # px, cells per side, transparent px around each cell's content
LEAVES_PER_CELL = 74
LEAF_LENGTH = (0.075, 0.12)  # a share of the cell's edge, so about 3.5-9 cm on a card
# Per level: how many cards survive, how much larger they get to keep the coverage, and the stem segment length in vine steps (0 for no stems).
LEVELS = ({"keep": 1.0, "grow": 1.0, "ring": 4}, {"keep": 0.5, "grow": 1.28, "ring": 0}, {"keep": 0.13, "grow": 2.2, "ring": 0})
STEP = 0.06  # metres a vine advances per step
STEM_SIDES = 3
STEM_RADIUS = (0.011, 0.004)  # at a vine's root and its tip
CARD_EVERY = 4  # vine steps between cards
SHADE, SUN = 0x1c3a1e, 0x4c7438  # leaf colours (sRGB) in deep shade and in sun
STEM_COLOUR = 0x3a2a1c

# Table of pieces. attach: wall (origin on the wall's face at the bottom centre, leaves towards +Z), wall-top (origin at the top of
# the wall's front face, hanging down it, with ``over`` metres crossing the top behind), ground (origin at the patch's centre, vines
# from the -Z edge), column (origin on the axis at the foot, facing +Z) or corner (origin on the corner's foot: across a +Z face, then back along a +X face).
PIECES = {
    "wall-patch": dict(attach="wall", width=1.9, height=1.72, roots=4, root_seed=21, seed=31),
    "curtain": dict(attach="wall-top", width=1.2, height=1.5, over=0.33, roots=3, root_seed=22, seed=32, reach=1.25),
    "ground-creeper": dict(attach="ground", width=3.0, height=1.6, roots=5, root_seed=23, seed=33, tilt=(0.02, 0.13), lift=(0.008, 0.05)),
    "pedestal-patch": dict(attach="wall", width=1.0, height=0.76, roots=2, root_seed=24, seed=34, size=(0.34, 0.52)),
    "column-wrap": dict(attach="column", width=1.26, height=2.3, radius=0.42, roots=3, root_seed=25, seed=35, size=(0.38, 0.6)),
    "corner-wrap": dict(attach="corner", width=2.9, height=2.6, front=1.32, roots=4, root_seed=26, seed=36),
    "runner": dict(attach="wall", width=0.5, height=2.6, roots=1, root_seed=27, seed=37, size=(0.34, 0.5)),
}


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "piece", "level"} or arguments["schemaVersion"] != 1:
        raise ValueError("ivy arguments must be {schemaVersion: 1, piece, level}")
    if arguments["piece"] not in PIECES or arguments["level"] not in (0, 1, 2):
        raise ValueError(f"ivy piece must be one of {', '.join(PIECES)} and level 0, 1 or 2")
    if inputs:
        raise ValueError("ivy takes no inputs")


def smooth(lo, hi, x):
    t = max(0.0, min(1.0, (x - lo) / (hi - lo)))
    return t * t * (3 - 2 * t)


def linear(colour):
    c = np.array([(colour >> 16 & 255) / 255, (colour >> 8 & 255) / 255, (colour & 255) / 255])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_blender(point):
    return (point[0], -point[2], point[1])


# ---------------------------------------------------------------- atlas

def paint_cell(tone, alpha, rng):
    """One cluster of broad five-lobed ivy leaves, back to front, as linear grey."""
    size = tone.shape[0]
    yy, xx = np.mgrid[0:size, 0:size]
    for _ in range(LEAVES_PER_CELL):
        spread = rng.rand() ** 0.6 * 0.36
        turn = rng.rand() * math.tau
        centre = (0.5 + spread * math.cos(turn)) * size, (0.5 + spread * math.sin(turn)) * size
        length = rng.uniform(*LEAF_LENGTH) * size
        heading = rng.normal(0, 0.7) + (0 if rng.rand() < 0.75 else math.pi)  # most leaves hang: row numbers grow downwards
        lx0, ly0 = (xx - centre[0]) / length, (yy - centre[1]) / length
        c, s = math.cos(heading), math.sin(heading)
        lx, ly = lx0 * c + ly0 * s, -lx0 * s + ly0 * c
        r = np.hypot(lx, ly)
        angle = np.arctan2(lx, ly)  # 0 at the leaf's tip
        side = np.abs(angle)
        reach = 0.46 + 0.52 * np.exp(-(side / 0.46) ** 2) + 0.3 * np.exp(-((side - 1.2) / 0.42) ** 2) + 0.16 * np.exp(-((side - 2.25) / 0.42) ** 2)
        inside = r < reach
        base = rng.uniform(0.5, 0.92)
        shade = base * (0.86 + 0.14 * np.clip(1 - r / np.maximum(reach, 1e-3), 0, 1)) * (0.92 + 0.08 * (lx > 0))
        for vein in (0.0, 1.2, -1.2, 2.25, -2.25):
            near = (np.abs(angle - vein) * r < 0.02) & (r < reach * 0.86)
            shade = np.where(near, np.minimum(1.0, base * 1.45), shade)
        tone[inside] = shade[inside]
        alpha[inside] = 1.0


def leaf_atlas():
    """The atlas as a Blender image: grey in RGB (``COLOR_0`` sets the hue) and a cut-out alpha."""
    cell = ATLAS // CELLS
    pixels = np.zeros((ATLAS, ATLAS, 4), dtype=np.float32)
    pixels[:, :, :3] = 0.85  # the colour that mip levels bleed from the empty gutters
    for row in range(CELLS):
        for col in range(CELLS):
            inner = cell - 2 * GUTTER
            tone, alpha = np.full((inner, inner), 0.7, dtype=np.float32), np.zeros((inner, inner), dtype=np.float32)
            paint_cell(tone, alpha, np.random.RandomState(9000 + row * CELLS + col))
            y, x = row * cell + GUTTER, col * cell + GUTTER
            srgb = np.where(tone <= 0.0031308, tone * 12.92, 1.055 * tone ** (1 / 2.4) - 0.055)
            pixels[y:y + inner, x:x + inner, :3] = srgb[:, :, None]
            pixels[y:y + inner, x:x + inner, 3] = alpha
    image = bpy.data.images.new("ivy-leaves", ATLAS, ATLAS, alpha=True)
    image.pixels.foreach_set(pixels.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def leaf_material():
    mat = bpy.data.materials.new(LEAF_MATERIAL)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = leaf_atlas()
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    multiply = nodes.new("ShaderNodeMix")
    multiply.data_type, multiply.blend_type = "RGBA", "MULTIPLY"
    multiply.inputs[0].default_value = 1.0
    links.new(tex.outputs["Color"], multiply.inputs[6])
    links.new(attr.outputs["Color"], multiply.inputs[7])
    links.new(multiply.outputs[2], bsdf.inputs["Base Color"])
    # Round(alpha) exports as glTF alphaMode MASK.
    cut = nodes.new("ShaderNodeMath")
    cut.operation = "ROUND"
    links.new(tex.outputs["Alpha"], cut.inputs[0])
    links.new(cut.outputs[0], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value, bsdf.inputs["Metallic"].default_value = 0.66, 0.0
    mat.use_backface_culling = False
    return mat


def stem_material():
    mat = bpy.data.materials.new(STEM_MATERIAL)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value, bsdf.inputs["Metallic"].default_value = 0.9, 0.0
    mat.use_backface_culling = True
    return mat


# ---------------------------------------------------------------- growth

def mapper(cfg):
    """``(s, t)`` to (point, outward normal, direction of growth), in glTF axes."""
    attach, width, height = cfg["attach"], cfg["width"], cfg["height"]
    if attach == "wall":
        return lambda s, t: (Vector((s - width / 2, t, 0.0)), Vector((0, 0, 1)), Vector((0, 1, 0)))
    if attach == "wall-top":
        over = cfg["over"]
        def top(s, t):
            if t < over:
                return Vector((s - width / 2, 0.0, t - over)), Vector((0, 1, 0)), Vector((0, 0, 1))
            return Vector((s - width / 2, over - t, 0.0)), Vector((0, 0, 1)), Vector((0, -1, 0))
        return top
    if attach == "ground":
        return lambda s, t: (Vector((s - width / 2, 0.0, t - height / 2)), Vector((0, 1, 0)), Vector((0, 0, 1)))
    if attach == "column":
        radius = cfg["radius"]
        def around(s, t):
            angle = (s - width / 2) / radius
            normal = Vector((math.sin(angle), 0.0, math.cos(angle)))
            return normal * radius + Vector((0, t, 0)), normal, Vector((0, 1, 0))
        return around
    front = cfg["front"]
    def corner(s, t):
        if s < front:
            return Vector((s - front, t, 0.0)), Vector((0, 0, 1)), Vector((0, 1, 0))
        return Vector((0.0, t, -(s - front))), Vector((1, 0, 0)), Vector((0, 1, 0))
    return corner


def grow(width, height, roots, rng, reach):
    """Vines in a width x height rectangle, each a list of (s, t) points growing towards +t."""
    vines = []
    pending = [(s, 0.0, math.pi / 2, 0) for s in roots]
    while pending and len(vines) < 46:
        s, t, heading, depth = pending.pop(0)
        points = [(s, t)]
        length = rng.uniform(0.9, 1.5) * height * reach * (0.85 ** depth)
        run = 0.0
        while run < length:
            heading += rng.normal(0, 0.28) + (math.pi / 2 - heading) * 0.12
            s += math.cos(heading) * STEP
            t += math.sin(heading) * STEP
            run += STEP
            if not (0 <= s <= width and 0 <= t <= height) or rng.rand() < 0.004:
                break
            points.append((s, t))
            if rng.rand() < 0.075 and depth < 5:
                pending.append((s, t, heading + rng.choice((-1, 1)) * rng.uniform(0.5, 1.25), depth + 1))
        if len(points) > 3:
            vines.append(points)
    return vines


def build(piece, level, collection):
    """The piece's leaf cards and stems as one mesh object; returns it and the card count."""
    cfg = PIECES[piece]
    width, height, seed = cfg["width"], cfg["height"], cfg["seed"]
    rng = np.random.RandomState(seed)
    roots = np.random.RandomState(cfg["root_seed"]).uniform(width * 0.1, width * 0.9, cfg["roots"]).tolist()
    place = mapper(cfg)
    vines = grow(width, height, roots, rng, cfg.get("reach", 1.0))
    tilt, lift, size = cfg.get("tilt", (0.1, 0.65)), cfg.get("lift", (0.012, 0.075)), cfg.get("size", (0.46, 0.78))
    keep, grow_by, ring = LEVELS[level]["keep"], LEVELS[level]["grow"], LEVELS[level]["ring"]
    shade, sun, stem = linear(SHADE), linear(SUN), linear(STEM_COLOUR)
    inset = GUTTER / ATLAS * 0.5
    cell = 1.0 / CELLS
    cards, stems = [], []
    survivors = np.random.RandomState(seed + 7)  # one draw a card, whatever the level, so a lower level's cards are a subset
    for vine in vines:
        count = len(vine)
        rows = []
        for i, (s, t) in enumerate(vine):
            share = i / max(1, count - 1)
            if ring and (i % ring == 0 or i == count - 1):
                point, normal, along = place(s, t)
                side = along.cross(normal).normalized()
                radius = STEM_RADIUS[0] * (1 - share) + STEM_RADIUS[1]
                centre = point + normal * (radius * 1.2)
                rows.append([centre + (side * math.cos(a) + normal * math.sin(a)) * radius for a in (k * math.tau / STEM_SIDES for k in range(STEM_SIDES))])
            if i % CARD_EVERY and i != count - 1:
                continue
            # A ragged outline with holes, so the stone and the stems show.
            border = min(s, width - s, t * 1.5, height - t) / (min(width, height) * 0.3)
            field = noise.noise(Vector((s * 1.5 + seed, t * 1.5, seed * 0.7))) + noise.noise(Vector((s * 4.2, t * 4.2 + seed, seed))) * 0.4
            gate = rng.rand()
            offset = rng.normal(0, 0.09, 2)
            edge = rng.uniform(*size) * (0.75 + 0.25 * (1 - share))
            turn = rng.normal(0, 0.75)
            lean, height_off, glow = rng.uniform(*tilt), rng.uniform(*lift), float(np.clip(rng.normal(0.42, 0.22) + 0.25 * share, 0, 1))
            col, row = int(rng.randint(CELLS)), int(rng.randint(CELLS))
            survive = survivors.rand()
            if field < -0.2 or gate > smooth(-0.15, 0.62, border * 0.85 + field * 0.75):
                continue
            p, n, a = place(float(np.clip(s + offset[0], 0, width)), float(np.clip(t + offset[1], 0, height)))
            world_up = Vector((0, 1, 0))
            flat_up = world_up - n * world_up.dot(n)
            base = flat_up.normalized() if flat_up.length > 0.3 else a  # leaves hang from whichever way is up on this surface
            across = n.cross(base).normalized()
            u = (base * math.cos(turn) + across * math.sin(turn)).normalized()
            w = n.cross(u).normalized()
            half = edge * grow_by / 2
            up = (u * math.cos(lean) + n * math.sin(lean)) * half
            middle = p + n * height_off
            right = w * half
            # Wound so the face looks along +n, with texture rows running down from the card's top.
            corners = [middle + right - up, middle - right - up, middle - right + up, middle + right + up]
            u0, v0, u1, v1 = col * cell + inset, row * cell + inset, (col + 1) * cell - inset, (row + 1) * cell - inset
            cards.append((survive, corners, ((u0, v0), (u1, v0), (u1, v1), (u0, v1)), tuple(shade + (sun - shade) * glow)))
        for lower, upper in zip(rows, rows[1:]):
            for k in range(STEM_SIDES):
                stems.append((lower[k], lower[(k + 1) % STEM_SIDES], upper[(k + 1) % STEM_SIDES], upper[k]))
    if not cards:
        raise ValueError(f"{piece} has no cards")
    cards = [card for card in cards if card[0] < keep] or [min(cards, key=lambda card: card[0])]  # a small piece keeps at least one

    leaf_material_ = leaf_material()
    stem_material_ = stem_material()
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    colour_layer = bm.loops.layers.float_color.new("Col")
    for _, corners, uvs, tint in cards:
        face = bm.faces.new([bm.verts.new(to_blender(c)) for c in corners])
        face.material_index = 0
        for loop, uv in zip(face.loops, uvs):
            loop[uv_layer].uv = uv
            loop[colour_layer] = (*tint, 1.0)
    for quad in stems:
        face = bm.faces.new([bm.verts.new(to_blender(c)) for c in quad])
        face.material_index, face.smooth = 1, True
        for loop in face.loops:
            loop[uv_layer].uv = (0.0, 0.0)
            loop[colour_layer] = (*stem, 1.0)
    bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces if f.material_index == 1])
    mesh = bpy.data.meshes.new("ivy")
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(leaf_material_)
    mesh.materials.append(stem_material_)
    colours = mesh.color_attributes
    colours.active_color = colours["Col"]
    colours.render_color_index = colours.active_color_index
    obj = bpy.data.objects.new("ivy", mesh)
    collection.objects.link(obj)
    return obj, len(cards)


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    piece, level = arguments["piece"], arguments["level"]
    obj, cards = build(piece, level, bpy.context.scene.collection)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False, export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    cfg = PIECES[piece]
    mesh = obj.data
    mesh.calc_loop_triangles()
    fit = {key: cfg[key] for key in ("radius", "front", "over") if key in cfg}
    return {"recipe": RECIPE, "piece": piece, "level": level, "attach": cfg["attach"], "cards": cards, "triangles": len(mesh.loop_triangles), **({"fit": fit} if fit else {})}
