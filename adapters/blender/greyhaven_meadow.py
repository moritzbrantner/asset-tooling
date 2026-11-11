"""Greyhaven meadow grass and flowers for mmorpg (docs/greyhaven-meadow.md, #570): walk-through scatter for the Vale's
meadows, the farmland's verges and the downs.

Every piece is a ragged patch of cards on one cut-out atlas. A patch grows along a wandering spine whose width
wanders too, with a few strays outside it, so no outline is a round blob or a square. Each tuft is two or three
crossed cards; tall cards bend once. Flowers are a stem card with one to three small heads on top.

The declared inputs are:

* ``grass``: the catalogued CC0 Quaternius Stylized Nature MegaKit ``Grass.png``. Its light-to-dark green strip
  gives every painted blade its tip-to-base shading (as grey, so the colour comes from ``COLOR_0``);
* ``flowers``: the catalogued CC0 Quaternius ``Flowers.png``. Its yellow flower becomes the buttercup and its red
  one the red campion, both cut out and regraded to the game's palette. The ox-eye daisy and the clover heads are
  painted here.

So the kit has one material, ``Greyhaven_Meadow``: cut-out (``MASK``), double-sided, a 1024 px atlas times
``COLOR_0``. The grass, stem and clover cells are greyscale, so the game can tint them; only the buttercup, campion
and daisy heads carry their own colour. Card normals lean towards +Z, so a patch shades like the ground it stands on.

``level`` picks the level of detail, in the same frame: ``1`` keeps a seeded 40 % of the tufts and flowers, grown so
the patch keeps its coverage, with every card single-segment; ``2`` is one card along the patch's long side.

The arguments are ``piece`` and ``level``. The origin is the patch's centre on the ground; card feet run 3 cm below
it, so a patch stays rooted on uneven ground. Blender coordinates are Z up; the GLB is exported +Y up. Everything is
seeded (``random.Random`` and ``numpy.random.RandomState``).
"""
import math
import random

import bpy
import numpy
from mathutils import Vector

RECIPE = "greyhaven-meadow-v1"
MATERIAL = "Greyhaven_Meadow"
ATLAS = 1024
GUTTER = 6
SINK = 0.03  # card feet below the ground (m)
# Atlas cells (x, y, width, height) in px, origin bottom left. Blades grow up the cell.
CELLS = {
    "tall-a": (0, 0, 256, 512), "tall-b": (0, 512, 256, 512),
    "dry-a": (256, 0, 256, 512), "short-a": (256, 512, 256, 256), "short-b": (256, 768, 256, 256),
    "clump": (512, 0, 256, 256), "dry-b": (512, 256, 256, 256),
    "stem": (512, 512, 128, 256), "clover-leaf": (640, 512, 128, 256),
    "buttercup": (768, 512, 128, 128), "daisy": (896, 512, 128, 128),
    "campion": (768, 640, 128, 128), "clover": (896, 640, 128, 128),
    "short-c": (512, 768, 256, 256),
}
# Painted grass cells: blades, height share (min, max), base width (px at 256), lean (share of cell width), seed heads.
BLADES = {
    "short-a": {"blades": 46, "height": (0.45, 0.95), "width": (5, 9), "lean": 0.22, "heads": None},
    "short-b": {"blades": 40, "height": (0.35, 0.9), "width": (5, 10), "lean": 0.3, "heads": None},
    "short-c": {"blades": 34, "height": (0.4, 0.92), "width": (4, 8), "lean": 0.26, "heads": "spray"},
    "tall-a": {"blades": 40, "height": (0.35, 0.97), "width": (4, 8), "lean": 0.18, "heads": "spike"},
    "tall-b": {"blades": 44, "height": (0.3, 0.97), "width": (4, 8), "lean": 0.22, "heads": "panicle"},
    "dry-a": {"blades": 34, "height": (0.3, 0.97), "width": (3, 6), "lean": 0.24, "heads": "spray"},
    "dry-b": {"blades": 38, "height": (0.35, 0.95), "width": (3, 6), "lean": 0.3, "heads": None},
    "clump": {"blades": 56, "height": (0.55, 0.97), "width": (5, 9), "lean": 0.42, "heads": None},
}
# The Quaternius flower cut-outs (x0, y0, x1, y1 in the source, top-left origin) and the sRGB palette they are
# regraded to: the grey of the cut-out divided by its mean, times the colour. The centre keeps its own warm tone.
SOURCE_HEADS = {
    "buttercup": {"box": (652, 578, 1008, 981), "colour": "#e9be1c", "centre": "#d79a12"},
    "campion": {"box": (0, 557, 439, 978), "colour": "#c9416f", "centre": "#7a2346"},
}
# COLOR_0 palettes (sRGB): base and tip per card kind; flowers carry their head tint.
GREENS = {
    "meadow": ("#2b4a1f", "#7fa34a"),
    "lush": ("#244420", "#6c9840"),
    "tall": ("#34502a", "#97aa5a"),
    "dry": ("#646a3a", "#d4c98f"),
    "stem": ("#2f4c22", "#6f8f42"),
}
HEADS = {
    "buttercup": {"cell": "buttercup", "size": 0.045, "tint": "#ffffff", "stem": "stem", "height": (0.25, 0.42), "heads": (1, 2), "tilt": (25, 55)},
    "daisy": {"cell": "daisy", "size": 0.075, "tint": "#ffffff", "stem": "stem", "height": (0.32, 0.5), "heads": (1, 1), "tilt": (15, 40)},
    "campion": {"cell": "campion", "size": 0.042, "tint": "#ffffff", "stem": "stem", "height": (0.38, 0.58), "heads": (2, 3), "tilt": (35, 70)},
    "clover-red": {"cell": "clover", "size": 0.034, "tint": "#c2557e", "stem": "clover-leaf", "height": (0.1, 0.17), "heads": (1, 1), "tilt": (10, 40)},
    "clover-white": {"cell": "clover", "size": 0.03, "tint": "#f2eee0", "stem": "clover-leaf", "height": (0.08, 0.14), "heads": (1, 1), "tilt": (10, 40)},
}


def tuft(cells, height, width, cards, segs, green, share=1.0):
    return {"cells": cells, "height": height, "width": width, "cards": cards, "segs": segs, "green": green, "share": share}


# Per piece: patch length and width (m), how much the width wanders, tufts per tuft kind, strays, flowers per kind and
# seed. ``tufts`` lists the tuft kinds with their share of the tufts. A clump piece grows round one tussock instead.
PIECES = {
    "grass-short": {"length": 1.7, "width": 0.8, "tufts": 30, "strays": 4, "seed": 5701,
                    "kinds": [tuft(["short-a", "short-b", "short-c"], (0.16, 0.3), (0.26, 0.36), (2, 3), 1, "meadow", 0.85),
                              tuft(["tall-a", "tall-b"], (0.34, 0.48), (0.16, 0.22), (2, 2), 1, "tall", 0.15)], "flowers": {}},
    "grass-tall": {"length": 1.5, "width": 0.75, "tufts": 22, "strays": 3, "seed": 5702,
                   "kinds": [tuft(["tall-a", "tall-b"], (0.55, 0.85), (0.2, 0.28), (2, 3), 2, "tall", 0.75),
                             tuft(["short-a", "short-b"], (0.2, 0.32), (0.2, 0.28), (2, 2), 1, "lush", 0.25)], "flowers": {}},
    "grass-clump": {"clump": {"radius": 0.16, "cards": 16, "inner": 6, "height": (0.36, 0.52), "width": (0.26, 0.34)},
                    "length": 0.9, "width": 0.6, "tufts": 5, "strays": 2, "seed": 5703,
                    "kinds": [tuft(["short-a", "short-b"], (0.14, 0.24), (0.18, 0.24), (2, 2), 1, "lush")], "flowers": {}},
    "grass-dry": {"length": 1.9, "width": 0.8, "tufts": 26, "strays": 5, "seed": 5704,
                  "kinds": [tuft(["dry-a"], (0.3, 0.5), (0.22, 0.3), (2, 2), 1, "dry", 0.45),
                            tuft(["dry-b"], (0.14, 0.26), (0.26, 0.34), (2, 3), 1, "dry", 0.55)], "flowers": {}},
    "flowers-yellow": {"length": 1.6, "width": 0.75, "tufts": 22, "strays": 3, "seed": 5705,
                       "kinds": [tuft(["short-a", "short-b", "short-c"], (0.16, 0.28), (0.26, 0.34), (2, 2), 1, "meadow")],
                       "flowers": {"buttercup": 16}},
    "flowers-white": {"length": 1.6, "width": 0.75, "tufts": 22, "strays": 3, "seed": 5706,
                      "kinds": [tuft(["short-a", "short-b", "short-c"], (0.16, 0.28), (0.26, 0.34), (2, 2), 1, "meadow")],
                      "flowers": {"daisy": 10, "clover-white": 8}},
    "flowers-red": {"length": 1.6, "width": 0.75, "tufts": 22, "strays": 3, "seed": 5707,
                    "kinds": [tuft(["short-a", "short-b", "short-c"], (0.16, 0.28), (0.26, 0.34), (2, 2), 1, "meadow")],
                    "flowers": {"campion": 9, "clover-red": 8}},
    "flowers-mixed": {"length": 1.8, "width": 0.8, "tufts": 20, "strays": 4, "seed": 5708,
                      "kinds": [tuft(["short-a", "short-b", "short-c"], (0.16, 0.28), (0.26, 0.34), (2, 2), 1, "meadow", 0.8),
                                tuft(["tall-a", "tall-b"], (0.4, 0.6), (0.18, 0.24), (2, 2), 1, "tall", 0.2)],
                      "flowers": {"buttercup": 6, "daisy": 4, "campion": 3, "clover-red": 4, "clover-white": 3}},
}
LOD1 = {"keep": 0.4, "grow": 0.85}
LOD2 = {"length": 0.8, "height": 0.7}


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "piece", "level"} or p["schemaVersion"] != 1:
        raise ValueError("greyhaven meadow requires exactly schemaVersion 1, piece and level")
    if p["piece"] not in PIECES or p["level"] not in (0, 1, 2):
        raise ValueError(f"greyhaven meadow: piece in {sorted(PIECES)}, level 0, 1 or 2")
    if set(inputs) != {"grass", "flowers"}:
        raise ValueError("greyhaven meadow takes exactly the declared inputs grass and flowers")


def srgb(hex_colour):
    return numpy.array([int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)])


def linear(c):
    c = numpy.asarray(c, dtype=float)
    return numpy.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# ----------------------------------------------------------------------------------------------------------- textures


def load(path):
    image = bpy.data.images.load(path, check_existing=False)
    w, h = image.size
    pixels = numpy.empty(w * h * 4, dtype=numpy.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels.reshape(h, w, 4)  # bottom row first; 8-bit images give their stored (sRGB) values


def blade_ramp(grass):
    """The tip-to-base grey of Quaternius' light-to-dark green strip (x 84-112), as a function of height share."""
    strip = grass[:, 86:110, :3].mean(axis=1)  # bottom row first: dark at the foot, light at the tip
    lum = strip @ numpy.array([0.2126, 0.7152, 0.0722])
    lum = lum / lum.max()
    return numpy.interp(numpy.linspace(0, 1, 256), numpy.linspace(0, 1, len(lum)), lum)


def down(a, f=2):
    h, w = a.shape[:2]
    return a.reshape(h // f, f, w // f, f, *a.shape[2:]).mean(axis=(1, 3))


def paint_blades(w, h, spec, ramp, rng):
    """Blades as tapered curves, row by row (each blade rises monotonically), at 2x and averaged down."""
    S = 2
    W, H = w * S, h * S
    grey = numpy.zeros((H, W), dtype=numpy.float32)
    alpha = numpy.zeros((H, W), dtype=numpy.float32)
    X = numpy.arange(W)[None, :]
    order = []
    for _ in range(spec["blades"]):
        order.append((rng.uniform(*spec["height"]), rng.uniform(0.18, 0.82), rng.uniform(*spec["width"]), rng.uniform(-1, 1)))
    order.sort(key=lambda b: -b[0])  # tall blades behind, short ones in front
    for height, foot, width, lean in order:
        top = int(H * height) - 2 * S
        rows = numpy.arange(top)
        t = rows / max(top - 1, 1)
        bend = lean * spec["lean"] * W * t ** 1.6
        xc = foot * W + (foot - 0.5) * 0.35 * W * t + bend
        hw = 0.5 * width * S * (1 - t) ** 0.8 + 0.4
        shade = numpy.interp(t * height, numpy.linspace(0, 1, len(ramp)), ramp) * rng.uniform(0.82, 1.0)
        window = numpy.abs(X - xc[:, None]) < hw[:, None]
        rib = numpy.abs(X - xc[:, None]) < hw[:, None] * 0.35
        tone = shade[:, None] * numpy.where(rib, 1.06, 0.92)
        grey[:top] = numpy.where(window, tone, grey[:top])
        alpha[:top] = numpy.maximum(alpha[:top], window)
        if spec["heads"] and height > 0.6 and rng.uniform() < 0.75:
            head(grey, alpha, spec["heads"], xc[-1], top, bend[-1] - bend[-2] if top > 2 else 0, S, rng)
    a = down(alpha, S)
    g = numpy.where(a > 0, down(grey * alpha, S) / numpy.maximum(a, 1e-6), 0.7)
    return numpy.clip(g, 0, 1), numpy.where(a > 0.35, 1.0, 0.0)


def head(grey, alpha, kind, x, y, slope, S, rng):
    H, W = grey.shape
    yy, xx = numpy.mgrid[0:H, 0:W]
    if kind == "spike":  # timothy: a slim, dense cylinder at the top of the stem, speckled
        length, radius = rng.uniform(20, 32) * S, rng.uniform(2.2, 2.8) * S
        inside = (numpy.abs(xx - x - slope * (yy - y)) < radius) & (yy >= y - 2) & (yy < y + length)
        tone = 0.5 + 0.2 * rng.uniform(size=grey.shape)
    else:  # panicle (cocksfoot) or spray (bent and fescue): many tiny seeds on hair-fine branches
        inside = numpy.zeros_like(grey, dtype=bool)
        count = 7 if kind == "panicle" else 9
        for _ in range(count):
            ang = rng.uniform(-0.8, 0.8)
            reach = rng.uniform(8, 20) * S
            for s in numpy.linspace(0, 1, 12):
                bx, by = x + math.sin(ang) * reach * s, y + math.cos(ang) * reach * 0.9 * s
                r = (1.5 if s > 0.55 else 0.7) * S if kind == "panicle" else (1.1 if s > 0.6 else 0.6) * S
                inside |= (xx - bx) ** 2 + (yy - by) ** 2 < r * r
        tone = 0.62 if kind == "panicle" else 0.8
    grey[inside] = tone if numpy.isscalar(tone) else tone[inside]
    alpha[inside] = 1.0


def paint_stem(w, h, rng, clover):
    """A flower stem with narrow leaves (``stem``) or a short stalk with trefoil leaves (``clover-leaf``), grey."""
    S = 2
    W, H = w * S, h * S
    yy, xx = numpy.mgrid[0:H, 0:W].astype(numpy.float32)
    alpha = numpy.zeros((H, W), dtype=bool)
    grey = numpy.full((H, W), 0.7, dtype=numpy.float32)
    cx = W / 2
    if not clover:
        alpha |= (numpy.abs(xx - cx - 4 * S * numpy.sin(yy / H * 2.2)) < 2.2 * S) & (yy < H - 3 * S)
        for i in range(5):
            y0 = H * (0.08 + 0.13 * i)
            side = 1 if i % 2 else -1
            length = W * rng.uniform(0.32, 0.44) * (1 - 0.12 * i)
            t = (xx - cx) * side / length
            centre = y0 + t * length * 0.55
            width = 5 * S * numpy.sin(numpy.clip(t, 0, 1) * math.pi) + 0.5
            alpha |= (t > 0) & (t < 1) & (numpy.abs(yy - centre) < width)
        grey = 0.62 + 0.38 * yy / H
    else:
        alpha |= (numpy.abs(xx - cx) < 1.8 * S) & (yy < H * 0.55)
        for _ in range(3):  # three trefoil leaves at different heights
            lx, ly = cx + rng.uniform(-0.28, 0.28) * W, H * rng.uniform(0.15, 0.4)
            alpha |= (numpy.abs(xx - (cx + (lx - cx) * (yy / ly).clip(0, 1))) < 1.4 * S) & (yy < ly)
            for k in range(3):
                ang = math.pi / 2 + (k - 1) * 2.1
                ox, oy = lx + math.cos(ang) * 9 * S, ly + math.sin(ang) * 9 * S
                alpha |= ((xx - ox) / (10 * S)) ** 2 + ((yy - oy) / (8 * S)) ** 2 < 1
            ring = numpy.abs(numpy.hypot(xx - lx, yy - ly) - 9 * S) < 1.3 * S
            grey = numpy.where(ring, 0.98, grey)
        grey = numpy.where(grey > 0.9, 0.98, 0.66 + 0.18 * yy / H)
    a = down(alpha.astype(numpy.float32), S)
    return down(grey, S), numpy.where(a > 0.35, 1.0, 0.0)


def regrade_head(flowers, name, size):
    """A Quaternius flower cut-out, fitted into ``size`` px and regraded: grey / mean grey, times the palette colour."""
    spec = SOURCE_HEADS[name]
    x0, y0, x1, y1 = spec["box"]
    h = flowers.shape[0]
    crop = flowers[h - y1:h - y0, x0:x1]  # .pixels rows run bottom up
    side = max(crop.shape[:2])
    pad = numpy.zeros((side, side, 4), dtype=numpy.float32)
    oy, ox = (side - crop.shape[0]) // 2, (side - crop.shape[1]) // 2
    pad[oy:oy + crop.shape[0], ox:ox + crop.shape[1]] = crop
    idx = (numpy.arange(size) + 0.5) * side / size
    small = pad[idx.astype(int)][:, idx.astype(int)]
    lum = small[..., :3] @ numpy.array([0.2126, 0.7152, 0.0722])
    mask = small[..., 3] > 0.5
    mean = lum[mask].mean()
    grey = numpy.clip(lum / mean, 0.4, 1.35)
    yy, xx = numpy.mgrid[0:size, 0:size]
    centre = numpy.hypot(yy - size / 2, xx - size / 2) < size * 0.13
    colour = numpy.where(centre[..., None], srgb(spec["centre"]), srgb(spec["colour"]))
    rgb = numpy.clip(colour * grey[..., None], 0, 1)
    return rgb, mask.astype(numpy.float32)


def paint_daisy(size, rng):
    """Ox-eye daisy: about twenty narrow white rays round a yellow disc, linear RGB."""
    yy, xx = (numpy.mgrid[0:size, 0:size] + 0.5 - size / 2) / (size / 2)
    r, a = numpy.hypot(xx, yy), numpy.arctan2(yy, xx)
    rays = 21
    phase = (a * rays / math.tau + rng.uniform()) % 1
    ray = (numpy.abs(phase - 0.5) < 0.36 * (1 - r ** 3)) & (r < 0.94) & (r > 0.2)
    disc = r < 0.27
    rgb = numpy.zeros((size, size, 3))
    rgb[ray] = srgb("#f3f1e6") * (0.86 + 0.14 * r[ray])[:, None]
    rgb[disc] = srgb("#e3a91c") * (0.8 + 0.2 * (1 - r[disc] / 0.27))[:, None]
    return rgb, (ray | disc).astype(numpy.float32)


def paint_clover(size, rng):
    """A clover head: a ball of small florets, grey, darker at the foot; COLOR_0 tints it pink or white."""
    S = 2
    n = size * S
    yy, xx = numpy.mgrid[0:n, 0:n] + 0.5
    grey = numpy.zeros((n, n))
    alpha = numpy.zeros((n, n), dtype=bool)
    for _ in range(70):
        ang, rad = rng.uniform(0, math.tau), math.sqrt(rng.uniform()) * 0.34 * n
        cx, cy = n / 2 + math.cos(ang) * rad, n / 2 + math.sin(ang) * rad
        f = (xx - cx) ** 2 + (yy - cy) ** 2 < (0.07 * n) ** 2
        grey[f] = 0.62 + 0.38 * (cy / n) * rng.uniform(0.85, 1.0)
        alpha |= f
    a = down(alpha.astype(numpy.float32), S)
    return numpy.repeat(down(grey, S)[..., None], 3, axis=2), numpy.where(a > 0.35, 1.0, 0.0)


def build_atlas(inputs):
    grass = load(inputs["grass"])
    flowers = load(inputs["flowers"])
    ramp = blade_ramp(grass)
    pixels = numpy.zeros((ATLAS, ATLAS, 4), dtype=numpy.float32)
    pixels[..., :3] = 0.6
    for index, (name, (x, y, w, h)) in enumerate(CELLS.items()):
        rng = numpy.random.RandomState(5710 + index)
        iw, ih = w - 2 * GUTTER, h - 2 * GUTTER
        if name in BLADES:
            grey, alpha = paint_blades(iw, ih, BLADES[name], ramp, rng)
            rgb = numpy.repeat(grey[..., None], 3, axis=2)
        elif name in ("stem", "clover-leaf"):
            grey, alpha = paint_stem(iw, ih, rng, name == "clover-leaf")
            rgb = numpy.repeat(grey[..., None], 3, axis=2)
        elif name in SOURCE_HEADS:
            rgb, alpha = regrade_head(flowers, name, iw)
        elif name == "daisy":
            rgb, alpha = paint_daisy(iw, rng)
        else:
            rgb, alpha = paint_clover(iw, rng)
        # Transparent texels take the cell's mean colour, so mips don't fringe dark.
        mean = rgb[alpha > 0].mean(axis=0) if alpha.any() else numpy.full(3, 0.6)
        rgb = numpy.where(alpha[..., None] > 0, rgb, mean)
        pixels[y:y + h, x:x + w, :3] = mean
        pixels[y + GUTTER:y + GUTTER + ih, x + GUTTER:x + GUTTER + iw, :3] = rgb
        pixels[y + GUTTER:y + GUTTER + ih, x + GUTTER:x + GUTTER + iw, 3] = alpha
    image = bpy.data.images.new("greyhaven-meadow", ATLAS, ATLAS, alpha=True)
    image.pixels.foreach_set(pixels.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def cell_uv(name):
    x, y, w, h = CELLS[name]
    g = GUTTER + 1
    return (x + g) / ATLAS, (y + g) / ATLAS, (x + w - g) / ATLAS, (y + h - g) / ATLAS


def material(image):
    """The atlas times COLOR_0; Round(alpha) exports as glTF alphaMode MASK. Double-sided for cards."""
    mat = bpy.data.materials.new(MATERIAL)
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
    rnd = nodes.new("ShaderNodeMath")
    rnd.operation = "ROUND"
    links.new(tex.outputs["Alpha"], rnd.inputs[0])
    links.new(rnd.outputs[0], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.92
    mat.use_backface_culling = False
    return mat


# ----------------------------------------------------------------------------------------------------------- layout


class Cards:
    """Accumulates quads (one or two segments) with UVs, per-corner colour and up-leaning normals."""

    def __init__(self):
        self.verts, self.faces, self.uvs, self.cols, self.normals = [], [], [], [], []

    def card(self, foot, yaw, width, height, cell, base, tip, lean=(0.0, 0.0), segs=1, mirror=False):
        u0, v0, u1, v1 = cell_uv(cell)
        if mirror:
            u0, u1 = u1, u0
        d = Vector((math.cos(yaw), math.sin(yaw), 0))
        n = Vector((-d.y, d.x, 0))
        lean = Vector((lean[0], lean[1], 0))
        rows = []
        for k in range(segs + 1):
            t = k / segs
            centre = Vector(foot) + Vector((0, 0, -SINK + (height + SINK) * t)) + lean * (t ** 1.5)
            rows.append((centre - d * width / 2, centre + d * width / 2, t))
        start = len(self.verts)
        for left, right, t in rows:
            self.verts += [left, right]
        for k in range(segs):
            a = start + 2 * k
            self.faces.append((a, a + 1, a + 3, a + 2))
            for (i, s, t) in ((a, 0, k / segs), (a + 1, 1, k / segs), (a + 3, 1, (k + 1) / segs), (a + 2, 0, (k + 1) / segs)):
                self.uvs.append((u0 + (u1 - u0) * s, v0 + (v1 - v0) * t))
                self.cols.append(tuple(base + (tip - base) * t))
                up = Vector((0, 0, 1)) * 0.8 + n * (0.2 if (k % 2 == 0) else -0.2)
                self.normals.append(up.normalized())
        return segs * 2

    def head(self, centre, yaw, tilt, size, cell, colour):
        """A small square facing up, tilted ``tilt`` degrees towards ``yaw``."""
        u0, v0, u1, v1 = cell_uv(cell)
        d = Vector((math.cos(yaw), math.sin(yaw), 0))
        side = Vector((-d.y, d.x, 0))
        t = math.radians(tilt)
        normal = Vector((0, 0, 1)) * math.cos(t) + d * math.sin(t)
        fwd = normal.cross(side).normalized()
        c = Vector(centre)
        start = len(self.verts)
        for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            self.verts.append(c + side * a * size / 2 + fwd * b * size / 2)
        self.faces.append((start, start + 1, start + 2, start + 3))
        for a, b in ((0, 0), (1, 0), (1, 1), (0, 1)):
            self.uvs.append((u0 + (u1 - u0) * a, v0 + (v1 - v0) * b))
            self.cols.append(tuple(colour))
            self.normals.append((Vector((0, 0, 1)) + normal).normalized())
        return 2

    def mesh(self, name, mat, collection):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([tuple(v) for v in self.verts], [], self.faces)
        uv = mesh.uv_layers.new(name="UVMap")
        for i, item in enumerate(uv.data):
            item.uv = self.uvs[i]
        col = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        for i, item in enumerate(col.data):
            item.color = (*self.cols[i], 1.0)
        mesh.materials.append(mat)
        mesh.normals_split_custom_set([tuple(n) for n in self.normals])
        obj = bpy.data.objects.new(name, mesh)
        collection.objects.link(obj)
        return obj


def spine(spec, nrng):
    """A wandering centre line along X and a wandering half-width, so the outline is ragged, not a blob."""
    n = 24
    xs = numpy.linspace(-spec["length"] / 2, spec["length"] / 2, n)
    walk = numpy.cumsum(nrng.normal(0, 1, n))
    walk -= numpy.linspace(walk[0], walk[-1], n)
    ys = walk / (numpy.abs(walk).max() + 1e-6) * spec["width"] * 0.35
    widths = numpy.convolve(nrng.uniform(0.15, 1.0, n + 4), numpy.ones(5) / 5, mode="valid")[:n]
    widths *= numpy.sin(numpy.linspace(0.15, math.pi - 0.15, n)) ** 0.6 * spec["width"] / 2
    return xs, ys, widths


def place(spec, rng, nrng, count, strays):
    xs, ys, widths = spine(spec, nrng)
    spots = []
    for _ in range(count):
        i = rng.randint(0, len(xs) - 1)
        x = xs[i] + rng.uniform(-0.5, 0.5) * (xs[1] - xs[0])
        spots.append((x, ys[i] + rng.gauss(0, 0.45) * widths[i]))
    for _ in range(strays):  # a few strays outside the band, nearer the ends
        i = rng.choice([rng.randint(0, 6), rng.randint(len(xs) - 7, len(xs) - 1), rng.randint(0, len(xs) - 1)])
        side = rng.choice([-1, 1])
        spots.append((xs[i] + rng.uniform(-0.1, 0.1), ys[i] + side * (widths[i] + rng.uniform(0.08, 0.22))))
    return spots


def jitter(colour, rng, amount=0.08):
    return numpy.clip(colour * rng.uniform(1 - amount, 1 + amount) * (1 + numpy.array([rng.uniform(-0.04, 0.04) for _ in range(3)])), 0, 1)


def build(piece, lod_level, collection, inputs):
    """Builds ``piece`` at ``lod_level`` into ``collection``; returns the object and its observations."""
    spec = PIECES[piece]
    rng = random.Random(spec["seed"])
    nrng = numpy.random.RandomState(spec["seed"])
    mat = material(build_atlas(inputs))
    keep = LOD1["keep"] if lod_level == 1 else 1.0
    grow = LOD1["grow"] / math.sqrt(keep) if lod_level == 1 else 1.0
    cards = Cards()
    tri = {"grass": 0, "flowers": 0}
    feet = []
    chosen = {}

    def kept(group, index, total):
        """lod1 keeps exactly a seeded share of each group; every level draws the same random numbers first."""
        if lod_level == 0:
            return True
        if group not in chosen:
            chosen[group] = set(random.Random(spec["seed"] * 31 + len(chosen)).sample(range(total), max(1, int(total * keep))))
        return index in chosen[group]

    def grass_tuft(x, y, kind, keep_it):
        n = rng.randint(*kind["cards"])
        yaw0 = rng.uniform(0, math.pi)
        height = rng.uniform(*kind["height"])
        base_c, tip_c = (linear(srgb(c)) for c in GREENS[kind["green"]])
        tint = jitter(numpy.ones(3), rng, 0.1)
        for k in range(n):
            yaw = yaw0 + k * math.pi / n + rng.uniform(-0.25, 0.25)
            h = height * rng.uniform(0.85, 1.1)
            w = rng.uniform(*kind["width"]) * grow
            lean_dir = rng.uniform(0, math.tau)
            lean = (math.cos(lean_dir) * h * 0.18, math.sin(lean_dir) * h * 0.18)
            foot = (x + rng.uniform(-0.03, 0.03), y + rng.uniform(-0.03, 0.03), 0)
            cell, mirror = rng.choice(kind["cells"]), rng.random() < 0.5
            if keep_it:
                tri["grass"] += cards.card(foot, yaw, w, h, cell, base_c * tint * 0.95, tip_c * tint,
                                           lean, kind["segs"] if lod_level == 0 else 1, mirror)
                feet.append((foot[0], foot[1], w / 2))

    if lod_level == 2:
        return far_card(piece, spec, inputs, mat, collection)

    if "clump" in spec:  # one tussock: arching cards fanning out from a tight foot, upright ones inside
        c = spec["clump"]
        base_c, tip_c = (linear(srgb(col)) for col in GREENS["lush"])
        for k in range(c["cards"] + c["inner"]):
            inner = k >= c["cards"]
            ang = k * math.tau / c["cards"] + rng.uniform(-0.2, 0.2) if not inner else rng.uniform(0, math.tau)
            r = c["radius"] * (0.3 if inner else rng.uniform(0.6, 1.0))
            foot = (math.cos(ang) * r, math.sin(ang) * r * 0.8, 0)
            h = rng.uniform(*c["height"]) * (1.15 if inner else 1.0)
            out = 0.06 if inner else rng.uniform(0.18, 0.3)
            lean = (math.cos(ang) * out, math.sin(ang) * out)
            tint = jitter(numpy.ones(3), rng, 0.08)
            w = rng.uniform(*c["width"]) * grow
            if not kept("clump", k, c["cards"] + c["inner"]):
                continue
            tri["grass"] += cards.card(foot, ang + math.pi / 2, w, h, "clump", base_c * tint * 0.9, tip_c * tint, lean,
                                       2 if lod_level == 0 else 1, k % 2 == 0)
            feet.append((foot[0], foot[1], w / 2))

    kinds = spec["kinds"]
    spots = place(spec, rng, nrng, spec["tufts"], spec["strays"])
    for index, (x, y) in enumerate(spots):
        roll, acc = rng.random(), 0.0
        kind = kinds[-1]
        for candidate in kinds:
            acc += candidate["share"]
            if roll < acc:
                kind = candidate
                break
        grass_tuft(x, y, kind, kept("tufts", index, len(spots)))

    # Flowers drift in two or three small groups along the patch, not evenly over it.
    flower_count = 0
    for name, count in spec["flowers"].items():
        f = HEADS[name]
        drifts = place({"length": spec["length"] * 0.8, "width": spec["width"] * 0.6}, rng, nrng, rng.randint(2, 3), 0)
        for i in range(count):
            dx, dy = drifts[i % len(drifts)]
            x, y = dx + rng.gauss(0, 0.13), dy + rng.gauss(0, 0.09)
            h = rng.uniform(*f["height"])
            lean = (rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06))
            heads = rng.randint(*f["heads"])
            tints = [jitter(linear(srgb(f["tint"])), rng, 0.06) for _ in range(heads)]
            yaws = [rng.uniform(0, math.tau) for _ in range(heads + 1)]
            tilts = [rng.uniform(*f["tilt"]) for _ in range(heads)]
            offsets = [(rng.uniform(-0.035, 0.035), rng.uniform(-0.035, 0.035), -rng.uniform(0, 0.08) * j) for j in range(heads)]
            if not kept(name, i, count):
                continue
            flower_count += 1
            base_c, tip_c = (linear(srgb(c)) for c in GREENS["stem"])
            stem_w = (0.11 if f["stem"] == "stem" else 0.12) * (grow if lod_level == 1 else 1) ** 0.5
            tri["flowers"] += cards.card((x, y, 0), yaws[0], stem_w, h, f["stem"], base_c, tip_c, lean)
            top = Vector((x + lean[0], y + lean[1], h - 0.01))
            for j in range(heads):
                o = offsets[j]
                size = f["size"] * (grow if lod_level == 1 else 1) ** 0.5
                tri["flowers"] += cards.head(top + Vector(o), yaws[j + 1], tilts[j], size, f["cell"], tints[j])
            feet.append((x, y, 0.06))

    obj = cards.mesh(piece, mat, collection)
    return obj, {"recipe": RECIPE, "piece": piece, "level": lod_level, "cards": len(cards.faces),
                 "grassTriangles": tri["grass"], "flowerTriangles": tri["flowers"], "flowers": flower_count,
                 "coverM2": cover(feet)}


def far_card(piece, spec, inputs, mat, collection):
    """The last level: one card along the patch's long side, coloured as its mean."""
    kind = spec["kinds"][0]
    base_c, tip_c = (linear(srgb(c)) for c in GREENS["dry" if "dry" in piece else "meadow"])
    if spec["flowers"]:
        tip_c = tip_c * 0.85 + 0.15 * numpy.mean([linear(srgb("#e9be1c")) if n == "buttercup" else linear(srgb("#c9416f")) if "campion" in n or n == "clover-red" else numpy.ones(3) for n in spec["flowers"]], axis=0)
    height = (sum(kind["height"]) / 2) * LOD2["height"]
    if "clump" in spec:
        height = sum(spec["clump"]["height"]) / 2 * LOD2["height"]
    cards = Cards()
    cell = "clump" if "clump" in spec else ("dry-b" if "dry" in piece else "short-a")
    length = (spec["width"] if "clump" in spec else spec["length"]) * LOD2["length"]
    cards.card((0, 0, 0), 0.0, length, height, cell, base_c, tip_c)
    obj = cards.mesh(piece, mat, collection)
    return obj, {"recipe": RECIPE, "piece": piece, "level": 2, "cards": 1, "grassTriangles": 2, "flowerTriangles": 0, "flowers": 0,
                 "coverM2": None}


def cover(feet, cell=0.05):
    """The ground a patch covers (m²): 5 cm cells within each card's half-width of its foot."""
    if not feet:
        return 0
    pts = numpy.array(feet)
    lo, hi = pts[:, :2].min(axis=0) - 0.3, pts[:, :2].max(axis=0) + 0.3
    gx, gy = numpy.meshgrid(numpy.arange(lo[0], hi[0], cell), numpy.arange(lo[1], hi[1], cell))
    covered = numpy.zeros(gx.shape, dtype=bool)
    for x, y, r in pts:
        covered |= (gx - x) ** 2 + (gy - y) ** 2 < max(r, 0.08) ** 2
    return round(float(covered.sum()) * cell * cell, 3)


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    obj, observations = build(arguments["piece"], arguments["level"], bpy.context.scene.collection, inputs)
    colours = obj.data.color_attributes
    colours.active_color = colours["Col"]
    colours.render_color_index = colours.active_color_index
    obj.data.calc_loop_triangles()
    observations["triangles"] = len(obj.data.loop_triangles)
    observations["collision"] = "none"
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False, export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return observations
