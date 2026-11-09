"""Moss (docs/moss.md): seven generic pieces of thin, feathered cushion moss to lay over stone and shady ground.

A piece is a height field over a rectangle ``(s, t)``: one set of noise fields gives its outline, height and shading. The same
fields paint the piece's cell of a shared atlas (a ragged cut-out, colour from the CC0 ``mossy_rock`` scan matched to mmorpg's
palette, and a normal map) and raise a coarse game mesh, so nothing is baked. The moss's dark cracks in the scan are painted out.

``arguments`` are ``piece`` and ``level`` (0 is full detail, 1 and 2 are ``lod1`` and ``lod2``: coarser meshes on the same
atlas). The noise is ``value noise`` from ``cliff_outcrop.py`` (the declared input ``outcrop``), seeded per piece. Pieces are
authored in glTF axes (metres, +Y up); see ``docs/moss.md`` for each kind's origin.
"""
import math
import runpy

import bmesh
import bpy
import numpy as np

RECIPE = "moss-v1"
MATERIAL = "moss"
ATLAS, DENSITY = 1024, 260  # atlas edge, and pixels per metre
SCAN_TILE = 0.59  # metres per repeat of the scan
SCAN_SHRINK = 8  # the scan is averaged down by this much first, to the atlas's own density
PALETTE = 0x667447  # mmorpg's moss (sRGB)
HOLLOW, CROWN = (0.5, 0.58, 0.38), (0.9, 1.04, 0.6)  # the colour in hollows and on crowns, as a share of the graded scan
CRACK_FLOOR = 0.42  # a texel's brightness never falls below this share of the palette's, which paints out the scan's dark cracks
NORMAL_STRENGTH = 2.2
GRAIN = 0.006  # metres of fine height added to the normal map
SURFACE_LIFT = 0.002  # metres the moss floats clear of what it lies on
ROUGHNESS = 0.98
LEVEL_CELLS = (1, 2, 4)  # the mesh cell at each level, as a multiple of the piece's own
FOLD_RADIUS = 0.03
TUCK = 0.03  # metres a strip reaches back under the block's foot

# Per piece: its rectangle, how it attaches, mesh cell, moss height, noise seed and top-left atlas pixel. Sizes are in the fit below.
PIECES = {
    "top-cap": dict(width=0.82, depth=1.7, attach="top", cell=0.07, height=0.024, seed=3, rect=(462, 380), field=("blob", 2.4)),
    "edge-drape": dict(width=1.16, depth=0.72, attach="edge", cell=0.04, height=0.022, seed=5, rect=(687, 380), field=("drape", 0.42)),
    "foot-ring": dict(width=1.36, depth=0.86, attach="foot", cell=0.06, height=0.024, seed=7, rect=(618, 8), field=("ring", 0.34, 0.09, 0.34)),
    "step-strip": dict(width=1.15, depth=0.3, attach="block-foot", cell=0.04, height=0.024, seed=11, rect=(618, 240), field=("creep",), pillow=22.0),
    "corner-strip": dict(width=0.8, depth=0.3, attach="block-foot", cell=0.04, height=0.02, seed=12, rect=(618, 326), field=("creep",), pillow=22.0),
    "ground-mat": dict(width=2.3, depth=1.4, attach="ground", cell=0.08, height=0.022, seed=14, rect=(8, 8), field=("blob", 1.5)),
    "scatter": dict(width=1.7, depth=1.25, attach="ground", cell=0.06, height=0.014, seed=41, rect=(8, 380), field=("dapple",), rough=2.4, pillow=26.0),
}
INPUTS = {"outcrop", "mossColour"}


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "piece", "level"} or arguments["schemaVersion"] != 1:
        raise ValueError("moss arguments must be {schemaVersion: 1, piece, level}")
    if arguments["piece"] not in PIECES or arguments["level"] not in (0, 1, 2):
        raise ValueError(f"moss piece must be one of {', '.join(PIECES)} and level 0, 1 or 2")
    if set(inputs) != INPUTS:
        raise ValueError(f"moss takes exactly the inputs {', '.join(sorted(INPUTS))}")


def smooth(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.maximum(c, 1e-6) ** (1 / 2.4) - 0.055)


def palette_linear():
    return to_linear(np.array([(PALETTE >> 16 & 255) / 255, (PALETTE >> 8 & 255) / 255, (PALETTE & 255) / 255]))


# ---------------------------------------------------------------- the fields

def outline(cfg, s, t, wave):
    """Positive inside the piece, before the noise that frays it."""
    width, depth, kind = cfg["width"], cfg["depth"], cfg["field"][0]
    def blob(power, w=width, d=depth, tt=t):
        u, v = np.abs((s - w / 2) / (w / 2)), np.abs((tt - d / 2) / (d / 2))
        return (1 - (u ** power + v ** power) ** (1 / power)) * 2.1 - 0.15
    if kind == "blob":
        return blob(cfg["field"][1])
    if kind == "drape":  # the top lobe, shrinking as it hangs over the edge
        return blob(2.4, width, 1.2, t + 0.3) * 0.95 - 0.02 - smooth(cfg["field"][1], depth, t) * 0.6
    if kind == "ring":  # strongest against the stone, gone at its reach
        _, half_x, half_z, reach = cfg["field"]
        dx, dz = np.abs(s - width / 2) - half_x, np.abs(t - depth / 2) - half_z
        outside = np.hypot(np.maximum(dx, 0), np.maximum(dz, 0))
        return np.where(np.maximum(dx, dz) < -0.015, -1.0, (1 - outside / reach) * 1.5 - 0.22)
    if kind == "creep":  # out from a block's foot at t = 0: the far edge wanders and both ends taper to nothing
        seed = cfg["seed"]
        along = np.stack([s, np.full_like(s, seed), np.zeros_like(s)], -1)
        wander = np.clip(0.5 + 0.5 * wave(along, 3.4) * 1.6, 0, 1)
        reach = 0.05 + 0.13 * wander + 0.025 * wave(along + np.array([0.0, 0.0, 3.0]), 11.0)
        taper = smooth(0.0, 0.3, np.minimum(s, width - s) / width)
        return (1 - np.maximum(t - TUCK, 0.0) / np.maximum(reach * taper, 0.005)) * 1.3 * (0.35 + 0.65 * taper) - 0.05
    if kind == "dapple":  # a soft envelope for the noise to break up: fragments, with no outline of its own
        return (1 - np.hypot((s - width / 2) / (width / 2), (t - depth / 2) / (depth / 2))) * 0.9 - 0.34
    raise ValueError(f"unknown field {kind}")


def fields(cfg, s, t, o):
    """Per sample: ``m`` (positive inside), height in metres, hollow-to-crown shade and rim (how solid the edge is)."""
    table = o["lattice"](cfg["seed"])
    wave = lambda points, frequency: (o["vnoise"](points, frequency, table) - 0.5) * 1.7
    seed = cfg["seed"]
    p = np.stack([s + seed * 1.7, t + seed * 0.9, np.full_like(s, seed * 2.3)], -1)
    rough = cfg.get("rough", 1.0)
    m = outline(cfg, s, t, wave) + rough * (wave(p, 3.2) * 0.42 + wave(p, 11.0) * 0.2 + wave(p, 29.0) * 0.07)
    body = smooth(0.0, 1.05, m) ** 1.15  # a long, thin feather out to nothing
    cushions = 0.45 + 1.1 * smooth(-0.3, 0.45, wave(p, cfg.get("pillow", 8.5)))
    height = cfg["height"] * body * cushions + 0.004 * body * wave(p, 38.0)
    shade = np.minimum(1.0, 0.25 + 0.6 * cushions * (0.4 + 0.6 * body))
    return m, height, shade, smooth(0.0, 0.42, m), p, wave


# ---------------------------------------------------------------- the atlas

def scan(path):
    """The scan averaged down to the atlas's density, in linear light, with its mean."""
    image = bpy.data.images.load(path, check_existing=True)
    width, height = image.size
    data = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(data)
    rgb = to_linear(data.reshape(height, width, 4)[::-1, :, :3].astype(np.float64))
    shrink = SCAN_SHRINK
    side = min(width, height) // shrink
    small = rgb[:side * shrink, :side * shrink].reshape(side, shrink, side, shrink, 3).mean(axis=(1, 3))
    return small, rgb.mean(axis=(0, 1))


def paint_atlas(inputs, o):
    """The colour-and-cut-out image and the normal image, as float rows from the top."""
    small, mean = scan(inputs["mossColour"])
    target = palette_linear()
    weights = np.array([0.2126, 0.7152, 0.0722])
    floor = float(target @ weights) * CRACK_FLOOR
    colour = np.tile((*to_srgb(target * 0.9), 0.0), (ATLAS, ATLAS, 1)).astype(np.float32)
    normal = np.tile((0.5, 0.5, 1.0, 1.0), (ATLAS, ATLAS, 1)).astype(np.float32)
    hollow, crown = np.array(HOLLOW), np.array(CROWN)
    for index, (name, cfg) in enumerate(PIECES.items()):
        left, top = cfg["rect"]
        w, h = round(cfg["width"] * DENSITY), round(cfg["depth"] * DENSITY)
        rows, cols = np.mgrid[0:h, 0:w]
        s, t = (cols + 0.5) / DENSITY, (rows + 0.5) / DENSITY
        m, height, shade, rim, p, wave = fields(cfg, s, t, o)
        # The scan, offset per piece, as detail round the game's palette colour.
        side = small.shape[0]
        offset = (index * 0.37, index * 0.61)
        ix = ((s / SCAN_TILE + offset[0]) * side).astype(int) % side
        iy = ((t / SCAN_TILE + offset[1]) * side).astype(int) % side
        texel = small[iy, ix]
        grain = (texel @ weights) / float(mean @ weights)
        rgb = texel * (target / mean)
        brightness = np.maximum(rgb @ weights, 1e-5)
        rgb = rgb * np.maximum(1.0, floor / brightness)[..., None]
        rgb = rgb * (hollow + (crown - hollow) * shade[..., None])
        speckle = (o["vnoise"](p, 85.0, o["lattice"](cfg["seed"] + 500)) * 0.6 + o["vnoise"](p, 170.0, o["lattice"](cfg["seed"] + 501)) * 0.4)
        solid = (rim * 3.0 > speckle) & (m > 0)
        cell = np.dstack([to_srgb(np.clip(rgb, 0, 1)), solid.astype(np.float64)])
        cell[~solid, :3] = to_srgb(target * 0.9)  # what mip levels bleed from the empty texels
        colour[top:top + h, left:left + w] = cell
        # Tangent space: +X is along s, and +Y points up the image, which is against t.
        bumps = height + GRAIN * (grain - 1.0) + 0.0015 * wave(p, 80.0)
        dt, ds = np.gradient(bumps, 1.0 / DENSITY)
        n = np.dstack([-ds * NORMAL_STRENGTH, dt * NORMAL_STRENGTH, np.ones_like(ds)])
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
        normal[top:top + h, left:left + w] = np.dstack([n * 0.5 + 0.5, np.ones_like(ds)])
    return colour, normal


def image_from(name, rows, data):
    image = bpy.data.images.new(name, ATLAS, ATLAS, alpha=True)
    image.colorspace_settings.is_data = data  # before the pixels: changing it regenerates a generated image
    image.pixels.foreach_set(rows[::-1].astype(np.float32).ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def material(inputs, o):
    colour, normal = paint_atlas(inputs, o)
    mat = bpy.data.materials.new(MATERIAL)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image_from("moss-colour", colour, False)
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    # Round(alpha) exports as glTF alphaMode MASK.
    cut = nodes.new("ShaderNodeMath")
    cut.operation = "ROUND"
    links.new(tex.outputs["Alpha"], cut.inputs[0])
    links.new(cut.outputs[0], bsdf.inputs["Alpha"])
    normal_tex = nodes.new("ShaderNodeTexImage")
    normal_tex.image = image_from("moss-normal", normal, True)
    normal_map = nodes.new("ShaderNodeNormalMap")
    links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value, bsdf.inputs["Metallic"].default_value = ROUGHNESS, 0.0
    mat.use_backface_culling = True
    return mat


# ---------------------------------------------------------------- the mesh

def place(cfg, s, t, h):
    """``(s, t, h)`` to glTF points; see ``docs/moss.md`` for each attachment's origin."""
    width, depth, attach = cfg["width"], cfg["depth"], cfg["attach"]
    lift = h + SURFACE_LIFT
    if attach in ("top", "ground", "foot"):
        return np.stack([s - width / 2, lift, t - depth / 2], -1)
    if attach == "block-foot":
        return np.stack([s - width / 2, lift, t - TUCK], -1)
    over = cfg["field"][1]
    bend = t - over
    arc = np.clip(bend / FOLD_RADIUS, 0, math.pi / 2)
    round_length = FOLD_RADIUS * math.pi / 2
    y = np.where(bend < 0, lift, np.where(bend < round_length, -FOLD_RADIUS + (FOLD_RADIUS + lift) * np.cos(arc), -FOLD_RADIUS - (bend - round_length)))
    z = np.where(bend < 0, bend, np.where(bend < round_length, (FOLD_RADIUS + lift) * np.sin(arc), FOLD_RADIUS + lift))
    return np.stack([s - width / 2, y, z], -1)


def build_mesh(piece, level, mat, collection, o):
    cfg = PIECES[piece]
    width, depth = cfg["width"], cfg["depth"]
    left, top = cfg["rect"]
    cell = cfg["cell"] * LEVEL_CELLS[level]
    nx, ny = max(1, math.ceil(width / cell)), max(1, math.ceil(depth / cell))
    # Each mesh cell is kept if any of its finer samples is moss, so the cut-out always has a surface to live on.
    sub = 6
    ft, fs = np.mgrid[0:ny * sub + 1, 0:nx * sub + 1]
    fine = fields(cfg, fs * width / (nx * sub), ft * depth / (ny * sub), o)[0]
    tv, sv = np.mgrid[0:ny + 1, 0:nx + 1]
    s, t = sv * width / nx, tv * depth / ny
    height = np.maximum(fields(cfg, s, t, o)[1], 0.0)
    points = place(cfg, s, t, height)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    verts = {}
    def vert(i, j):
        if (i, j) not in verts:
            x, y, z = points[j, i]
            verts[(i, j)] = bm.verts.new((float(x), float(-z), float(y)))
        return verts[(i, j)]
    for j in range(ny):
        for i in range(nx):
            if fine[j * sub:(j + 1) * sub + 1, i * sub:(i + 1) * sub + 1].max() <= 0:
                continue
            corners = ((i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j))  # wound to face up
            face = bm.faces.new([vert(a, b) for a, b in corners])
            face.smooth = True
            for loop, (a, b) in zip(face.loops, corners):
                u = (left + s[b, a] * DENSITY) / ATLAS
                row = (top + t[b, a] * DENSITY) / ATLAS
                loop[uv_layer].uv = (u, 1 - row)
    if not bm.faces:
        raise ValueError(f"{piece} level {level} has no faces")
    mesh = bpy.data.meshes.new("moss")
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mat)
    obj = bpy.data.objects.new("moss", mesh)
    collection.objects.link(obj)
    mesh.calc_loop_triangles()
    return obj, len(mesh.loop_triangles)


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    o = runpy.run_path(inputs["outcrop"])
    piece, level = arguments["piece"], arguments["level"]
    mat = material(inputs, o)
    obj, count = build_mesh(piece, level, mat, bpy.context.scene.collection, o)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO",
        export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    cfg = PIECES[piece]
    kind = cfg["field"]
    fit = {"halfWidth": kind[1], "halfDepth": kind[2]} if cfg["attach"] == "foot" else {"over": kind[1]} if cfg["attach"] == "edge" else None
    return {"recipe": RECIPE, "piece": piece, "level": level, "attach": cfg["attach"], "triangles": count, **({"fit": fit} if fit else {})}
