"""Greyhaven marsh plants for mmorpg (docs/greyhaven-marsh-plants.md, #571): walk-through scatter for the Marsh-Lake
Wetlands, Eastwater Fen and Stillwater Lake's shore.

Every piece is a ragged patch of cards on one cut-out atlas, grown like the meadow's (``greyhaven_meadow.py``): along
a wandering spine whose width wanders too, with a few strays, so no outline is a round blob or a square. Reeds are
three crossed, twice-bent cards a tuft, painted dense enough that a stand reads as a wall of stems with brown plumes.
``reeds-edge`` thins towards open water, which is the patch's -Y side in Blender (+Z in the GLB). Cattails, rushes
and the sedge tussock are crossed cards; water-lily pads and their flowers lie flat; marsh marigold is tilted
kidney leaves round a few flowering stems.

The declared inputs are:

* ``grass``: the catalogued CC0 Quaternius Stylized Nature MegaKit ``Grass.png``. Its light-to-dark green strip
  shades every painted leaf, stem and pad from foot to tip (as grey, so the colour comes from ``COLOR_0``);
* ``flowers``: the catalogued CC0 Quaternius ``Flowers.png``. Its yellow flower becomes the marsh marigold and its
  peach one the white water lily, both cut out and regraded to the game's palette;
* ``meadow``: ``greyhaven_meadow.py``, whose seeded spine, placement, image and colour helpers this recipe reuses.

So the kit has one material, ``Greyhaven_Marsh``: cut-out (``MASK``), double-sided, a 1024 px atlas times
``COLOR_0``. Leaves, stems and pads are greyscale, so the game can tint them; only the reed plumes, the cattail and
rush heads and the two flowers carry their own colour (still multiplied by ``COLOR_0``). Card normals lean towards
+Z, so a patch shades like the ground it stands on.

``level`` picks the level of detail, in the same frame: ``1`` keeps a seeded 40 % of each group, grown so the patch
keeps its coverage, with every card single-segment; ``2`` is one card along the patch's long side (five grown pads
for the water lilies).

The arguments are ``piece`` and ``level``. The origin is the patch's centre on the ground (card feet run 3 cm below
it); for ``water-lilies`` it is the water line, and the pads float 1 cm above it so they don't z-fight a water plane at
the origin. Blender coordinates are Z up; the GLB is exported +Y up. Everything is seeded (``random.Random`` and
``numpy.random.RandomState``).
"""
import math
import random

import bpy
import numpy
from mathutils import Vector

RECIPE = "greyhaven-marsh-v1"
MATERIAL = "Greyhaven_Marsh"
ATLAS = 1024
GUTTER = 6
SINK = 0.03  # card feet below the ground (m)
FLOAT = 0.01  # lily pads above the water line (m)
# The meadow helpers this recipe binds from its declared input ``meadow``.
SHARED = ("srgb", "linear", "load", "down", "blade_ramp", "paint_blades", "spine", "place", "jitter", "cover")
# Atlas cells (x, y, width, height) in px, origin bottom left. Plants grow up the cell.
CELLS = {
    "reed-a": (0, 0, 256, 1024), "reed-b": (256, 0, 256, 1024),
    "reed-sparse": (512, 0, 128, 512), "cattail": (640, 0, 128, 512), "cattail-leaf": (768, 0, 128, 512),
    "rush": (896, 0, 128, 512),
    "sedge-a": (512, 512, 256, 256), "sedge-b": (512, 768, 256, 256),
    "lily-pad": (768, 512, 128, 128), "lily-pad-b": (896, 512, 128, 128),
    "lily-flower": (768, 640, 128, 128), "marigold": (896, 640, 128, 128),
    "kidney-leaf": (768, 768, 128, 128), "kidney-leaf-b": (768, 896, 128, 128),
    "marigold-stem": (896, 768, 128, 256),
}
# Painted reed cells: stems, plume share, leaves a stem, stem height share (min, max), plume length (share of height).
REEDS = {
    "reed-a": {"stems": 30, "plumes": 0.6, "leaves": (4, 7), "height": (0.62, 0.97), "plume": (0.07, 0.11)},
    "reed-b": {"stems": 34, "plumes": 0.4, "leaves": (5, 8), "height": (0.55, 0.96), "plume": (0.06, 0.1)},
    "reed-sparse": {"stems": 5, "plumes": 1.0, "leaves": (2, 4), "height": (0.7, 0.97), "plume": (0.08, 0.12)},
}
# Painted sedge cells, in the meadow's blade painter's format: arching, keeled blades; ``spike`` adds dark sedge spikes.
SEDGES = {
    "sedge-a": {"blades": 60, "height": (0.5, 0.97), "width": (5, 9), "lean": 0.55, "heads": "spike"},
    "sedge-b": {"blades": 50, "height": (0.35, 0.92), "width": (4, 8), "lean": 0.42, "heads": None},
}
# Painted colours (sRGB) of the parts that carry their own: reed plumes, cattail and rush heads.
PLUME = ("#8a6a5e", "#b39a80")  # purple-brown core, buff fringe
CATTAIL_HEAD = "#8a5a36"
RUSH_HEAD = "#a8864e"
# The Quaternius flower cut-outs (x0, y0, x1, y1 in the source, top-left origin), regraded like the meadow's heads.
SOURCE_HEADS = {
    "marigold": {"box": (652, 578, 1008, 981), "colour": "#f2c41c", "centre": "#e0a414", "centreShare": 0.12, "clip": (0.45, 1.3)},
    "lily-flower": {"box": (0, 0, 468, 440), "colour": "#f3f0e6", "centre": "#e9b62e", "centreShare": 0.15, "clip": (0.72, 1.06)},
}
# COLOR_0 palettes (sRGB): foot, middle and tip per card kind.
GREENS = {
    "reed": ("#34452a", "#6a8a48", "#a3a66a"),
    "reed-dry": ("#4c4f32", "#868a56", "#b8ad80"),
    "cattail": ("#33482b", "#6f8a4c", "#a2ad74"),
    "rush": ("#26391f", "#4b6a32", "#6f8a46"),
    "sedge": ("#33452c", "#647d4a", "#93a26a"),
    "marigold": ("#28421f", "#3f6a2c", "#5f8a3c"),
}
PADS = (("#2f5428", "#3e6a30"), ("#4a5a28", "#5c6a30"))  # green pads and a few olive, older ones


def tuft(cells, height, width, cards, segs, green, share=1.0):
    return {"cells": cells, "height": height, "width": width, "cards": cards, "segs": segs, "green": green, "share": share}


# Per piece: patch length and width (m), tufts, strays and seed, plus the piece's own extras.
PIECES = {
    "reeds-stand": {"length": 3.4, "width": 1.6, "tufts": 26, "strays": 4, "seed": 5711,
                    "kinds": [tuft(["reed-a", "reed-b"], (1.9, 2.6), (0.62, 0.86), (2, 3), 2, "reed", 0.85),
                              tuft(["reed-b"], (1.5, 1.9), (0.5, 0.66), (2, 2), 2, "reed-dry", 0.15)]},
    "reeds-edge": {"length": 3.2, "width": 1.8, "tufts": 22, "strays": 6, "seed": 5712, "edge": True,
                   "kinds": [tuft(["reed-a", "reed-b"], (1.8, 2.5), (0.6, 0.8), (2, 3), 2, "reed"),
                             tuft(["reed-sparse"], (1.6, 2.3), (0.26, 0.34), (2, 2), 2, "reed")]},
    "cattails": {"length": 1.6, "width": 0.9, "tufts": 8, "strays": 2, "seed": 5713,
                 "kinds": [tuft(["cattail-leaf"], (1.15, 1.55), (0.34, 0.42), (2, 2), 2, "cattail")],
                 "heads": tuft(["cattail"], (1.5, 1.95), (0.36, 0.44), (1, 2), 2, "cattail")},
    "sedge-tussock": {"clump": {"radius": 0.18, "cards": 14, "inner": 5, "height": (0.55, 0.78), "width": (0.4, 0.5)},
                      "length": 1.1, "width": 0.7, "tufts": 5, "strays": 2, "seed": 5714,
                      "kinds": [tuft(["sedge-b"], (0.26, 0.4), (0.24, 0.3), (2, 2), 1, "sedge")]},
    "rushes": {"length": 1.7, "width": 0.8, "tufts": 10, "strays": 2, "seed": 5715,
               "kinds": [tuft(["rush"], (0.7, 1.0), (0.3, 0.38), (3, 3), 1, "rush")]},
    "water-lilies": {"length": 1.9, "width": 1.1, "pads": 17, "strays": 3, "flowers": 3, "seed": 5716,
                     "pad": (0.2, 0.34)},
    "marsh-marigold": {"length": 1.3, "width": 0.7, "clumps": 3, "strays": 0, "seed": 5717,
                       "leaves": 9, "stems": 3, "leaf": (0.1, 0.16), "flower": 0.055},
}
LOD1 = {"keep": 0.4, "grow": 0.85}
LOD2 = {"length": 0.8, "height": 0.8, "pads": 5, "padGrow": 1.6}


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "piece", "level"} or p["schemaVersion"] != 1:
        raise ValueError("greyhaven marsh requires exactly schemaVersion 1, piece and level")
    if p["piece"] not in PIECES or p["level"] not in (0, 1, 2):
        raise ValueError(f"greyhaven marsh: piece in {sorted(PIECES)}, level 0, 1 or 2")
    if set(inputs) != {"grass", "flowers", "meadow"}:
        raise ValueError("greyhaven marsh takes exactly the declared inputs grass, flowers and meadow")


def use_meadow(meadow):
    """Bind greyhaven_meadow.py's helpers (the declared Python input ``meadow``) into this module."""
    globals().update({name: meadow[name] for name in SHARED})


def palette(name):
    return [linear(srgb(c)) for c in GREENS[name]]


# ----------------------------------------------------------------------------------------------------------- textures


def stamp(rgb, alpha, x, y, r, colour):
    """A filled disc of ``colour`` at (x, y), radius ``r`` px, painted over what is there."""
    H, W = alpha.shape
    x0, x1 = max(int(x - r - 1), 0), min(int(x + r + 2), W)
    y0, y1 = max(int(y - r - 1), 0), min(int(y + r + 2), H)
    if x0 >= x1 or y0 >= y1:
        return
    yy, xx = numpy.mgrid[y0:y1, x0:x1]
    inside = (xx - x) ** 2 + (yy - y) ** 2 <= r * r
    rgb[y0:y1, x0:x1][inside] = colour
    alpha[y0:y1, x0:x1][inside] = 1.0


def stroke(rgb, alpha, points, widths, shades, rib=True):
    """A tapered stroke through ``points`` (px), its half-widths and grey shades; a lighter midrib when wide."""
    for (x, y), w, s in zip(points, widths, shades):
        stamp(rgb, alpha, x, y, w, numpy.full(3, s * 0.93))
        if rib and w > 2.5:
            stamp(rgb, alpha, x, y, w * 0.3, numpy.full(3, min(s * 1.07, 1.0)))


def curve(x, y, angle, length, droop, steps):
    """Points from (x, y) leaving at ``angle`` from vertical, sagging by ``droop`` (share of length) at the end."""
    s = numpy.linspace(0, 1, steps)
    px = x + numpy.sin(angle) * length * s
    py = y + numpy.cos(angle) * length * s - droop * length * s ** 2
    return list(zip(px, py))


def finish(rgb, alpha, S):
    a = down(alpha, S)
    c = down(rgb * alpha[..., None], S) / numpy.maximum(a, 1e-6)[..., None]
    return numpy.clip(c, 0, 1), numpy.where(a > 0.35, 1.0, 0.0)


def paint_reeds(w, h, spec, ramp, rng):
    """Common reed: straight stems with long leaves held out and drooping, most topped by a nodding plume."""
    S = 2
    W, H = w * S, h * S
    rgb = numpy.zeros((H, W, 3), dtype=numpy.float32)
    alpha = numpy.zeros((H, W), dtype=numpy.float32)
    shade = lambda t: numpy.interp(t, numpy.linspace(0, 1, len(ramp)), ramp)
    stems = sorted(((rng.uniform(*spec["height"]), rng.uniform(0.12, 0.88), rng.uniform(-1, 1)) for _ in range(spec["stems"])),
                   key=lambda s: -s[0])
    for height, foot, lean in stems:
        top = H * height - 2 * S
        steps = int(top / (1.5 * S))
        t = numpy.linspace(0, 1, steps)
        xs = foot * W + (foot - 0.5) * 0.25 * W * t + lean * 0.06 * W * t ** 2
        ys = t * top
        tone = rng.uniform(0.85, 1.0)
        stroke(rgb, alpha, list(zip(xs, ys)), 0.75 * S + 0.6 * S * (1 - t), shade(t * height) * tone * 0.92, rib=False)
        for _ in range(rng.randint(*spec["leaves"])):  # leaves from nodes up the stem, alternate sides
            k = rng.uniform(0.12, 0.8)
            i = int(k * (steps - 1))
            side = rng.choice([-1, 1])
            length = H * rng.uniform(0.12, 0.24)
            n = int(length / (1.5 * S))
            pts = curve(xs[i], ys[i], side * rng.uniform(0.35, 0.95), length, rng.uniform(0.15, 0.55), n)
            u = numpy.linspace(0, 1, n)
            widths = S * rng.uniform(2.2, 3.4) * numpy.sin(numpy.clip(u * 1.15 + 0.08, 0, 1) * math.pi * 0.95) + 0.3 * S
            stroke(rgb, alpha, pts, widths, shade(k * height + 0.15 * u) * tone)
        if height > 0.78 and rng.uniform() < spec["plumes"]:
            plume(rgb, alpha, xs[-1], ys[-1], H * rng.uniform(*spec["plume"]), lean, rng, S)
    return finish(rgb, alpha, S)


def plume(rgb, alpha, x, y, length, lean, rng, S):
    """A nodding reed panicle: a feathery teardrop of specks, purple-brown inside, buff at the fringe."""
    core, fringe = (srgb(c) for c in PLUME)
    droop = 0.35 + 0.3 * abs(lean)
    side = 1 if lean >= 0 else -1
    for _ in range(int(length * 1.7)):
        s = rng.uniform() ** 0.8
        cx = x + side * droop * length * 0.45 * s ** 2
        cy = y + length * (0.9 * s - droop * 0.35 * s ** 2)
        spread = length * 0.13 * math.sin(min(s * 1.25, 1) * math.pi) + S
        px, py = cx + rng.normal(0, spread * 0.5), cy + rng.normal(0, 1.2 * S)
        edge = min(abs(px - cx) / (spread + 1e-6), 1)
        colour = (core * (1 - edge) + fringe * edge) * rng.uniform(0.8, 1.08)
        stamp(rgb, alpha, px, py, rng.uniform(0.9, 1.5) * S, numpy.clip(colour, 0, 1))


def paint_cattail(w, h, ramp, rng, heads):
    """Bulrush: strap leaves from the foot and, on ``cattail``, two or three stems with brown heads and a spike."""
    S = 2
    W, H = w * S, h * S
    rgb = numpy.zeros((H, W, 3), dtype=numpy.float32)
    alpha = numpy.zeros((H, W), dtype=numpy.float32)
    shade = lambda t: numpy.interp(t, numpy.linspace(0, 1, len(ramp)), ramp)
    leaves = 5 if heads else 13
    for _ in range(leaves):
        foot = rng.uniform(0.3, 0.7) * W
        length = H * rng.uniform(0.55 if heads else 0.6, 0.85 if heads else 0.97)
        angle = rng.uniform(-0.28, 0.28)
        droop = rng.uniform(0.0, 0.5) if rng.uniform() < 0.35 else rng.uniform(0, 0.08)
        n = int(length / (1.5 * S))
        pts = curve(foot, 0, angle, length, droop, n)
        u = numpy.linspace(0, 1, n)
        widths = S * rng.uniform(4.2, 5.6) * (1 - u) ** 0.5 + 0.4 * S
        stroke(rgb, alpha, pts, widths, shade(u * 0.95) * rng.uniform(0.85, 1.0))
    if heads:
        brown = srgb(CATTAIL_HEAD)
        for j in range(rng.randint(2, 3)):
            x = W * (0.3 + 0.4 * j / 2 + rng.uniform(-0.06, 0.06))
            top = H * rng.uniform(0.82, 0.96)
            steps = int(top / (1.5 * S))
            t = numpy.linspace(0, 1, steps)
            xs = x + rng.uniform(-0.05, 0.05) * W * t ** 2
            stroke(rgb, alpha, list(zip(xs, t * top)), numpy.full(steps, 1.3 * S), shade(t * 0.9) * 0.95, rib=False)
            length, r = H * rng.uniform(0.11, 0.14), W * rng.uniform(0.055, 0.07)
            y0 = top * rng.uniform(0.72, 0.78)
            for y in numpy.arange(y0, y0 + length, S * 0.8):
                u = (y - y0) / length
                rr = r * (0.75 + 0.25 * math.sin(min(u * 1.1, 1) * math.pi))
                for k in range(3):
                    stamp(rgb, alpha, xs[int(y / top * (steps - 1))] + (k - 1) * rr * 0.4, y, rr * 0.75,
                          numpy.clip(brown * (0.82 + 0.25 * (k == 2) - 0.12 * (k == 0)) * rng.uniform(0.92, 1.05), 0, 1))
    return finish(rgb, alpha, S)


def paint_rush(w, h, ramp, rng):
    """Soft rush: dozens of fine, straight, dark stems from a narrow foot, a few with a brown flower tuft on one side."""
    S = 2
    W, H = w * S, h * S
    rgb = numpy.zeros((H, W, 3), dtype=numpy.float32)
    alpha = numpy.zeros((H, W), dtype=numpy.float32)
    shade = lambda t: numpy.interp(t, numpy.linspace(0, 1, len(ramp)), ramp)
    head = srgb(RUSH_HEAD)
    for _ in range(64):
        foot = rng.uniform(0.38, 0.62) * W
        height = H * rng.uniform(0.5, 0.97)
        spread = rng.uniform(-0.42, 0.42) * W
        steps = int(height / (1.5 * S))
        t = numpy.linspace(0, 1, steps)
        xs = foot + spread * t ** 1.3
        ys = t * height
        stroke(rgb, alpha, list(zip(xs, ys)), 0.55 * S + 0.45 * S * (1 - t), shade(t * 0.9) * rng.uniform(0.78, 1.0), rib=False)
        if rng.uniform() < 0.3:  # the flower tuft sits on the side, about three quarters up
            i = int(steps * rng.uniform(0.68, 0.8))
            side = 1 if rng.uniform() < 0.5 else -1
            for _ in range(14):
                stamp(rgb, alpha, xs[i] + side * abs(rng.normal(0, 2.4 * S)), ys[i] + rng.normal(0, 3 * S), 0.9 * S,
                      numpy.clip(head * rng.uniform(0.8, 1.1), 0, 1))
    return finish(rgb, alpha, S)


def paint_pad(size, rng, ragged):
    """A water-lily pad seen from above: round, a notch to the centre, fine radial veins, a darker rim; grey."""
    yy, xx = (numpy.mgrid[0:size, 0:size] + 0.5 - size / 2) / (size / 2)
    r, a = numpy.hypot(xx, yy), numpy.arctan2(yy, xx)
    notch = rng.uniform(-math.pi, math.pi)
    gap = 0.26 + 0.08 * rng.uniform()
    d = numpy.abs((a - notch + math.pi) % math.tau - math.pi)
    edge = 0.94 + (0.02 * numpy.sin(a * 5 + rng.uniform(0, 6)) + 0.008 * numpy.sin(a * 17) if ragged else 0.0)
    inside = (r < edge) & ~((d < gap * (r + 0.05)) & (r > 0.04))
    veins = numpy.abs(((a * 22 / math.tau) % 1) - 0.5) < 0.07
    grey = 0.62 + 0.18 * (1 - r) + 0.05 * veins * (r > 0.12) - 0.1 * (r > edge - 0.08)
    grey *= 0.94 + 0.06 * numpy.sin(xx * 9 + yy * 5 + rng.uniform(0, 6))
    return numpy.repeat(numpy.clip(grey, 0, 1)[..., None], 3, axis=2), inside.astype(numpy.float32)


def paint_kidney(size, rng, wide):
    """A marsh-marigold leaf: kidney-shaped with a notch at the stalk, crenate edge, palmate veins; grey."""
    yy, xx = (numpy.mgrid[0:size, 0:size] + 0.5 - size / 2) / (size / 2)
    yy = yy + 0.12  # stalk notch at the bottom
    sx = 1.18 if wide else 1.05
    r, a = numpy.hypot(xx / sx, yy), numpy.arctan2(xx, yy)
    lobe = 0.8 + 0.025 * numpy.cos(a * 16)
    d = numpy.abs(numpy.abs(a) - math.pi)
    inside = (r < lobe) & ~((d < 0.55) & (yy < 0) & (r > 0.04))
    veins = numpy.abs(((a * 9 / math.tau) % 1) - 0.5) < 0.06
    grey = 0.66 + 0.2 * (1 - r) + 0.1 * veins - 0.1 * (r > lobe - 0.07)
    return numpy.repeat(numpy.clip(grey, 0, 1)[..., None], 3, axis=2), inside.astype(numpy.float32)


def paint_branching_stem(w, h, ramp, rng):
    """A marsh-marigold flowering stem: a hollow, curving stalk that forks twice, with a small stem leaf; grey."""
    S = 2
    W, H = w * S, h * S
    rgb = numpy.zeros((H, W, 3), dtype=numpy.float32)
    alpha = numpy.zeros((H, W), dtype=numpy.float32)
    shade = lambda t: numpy.interp(t, numpy.linspace(0, 1, len(ramp)), ramp)
    for x0, y0, ang, length in ((0.5, 0.0, 0.05, 0.95), (0.5, 0.45, -0.5, 0.5), (0.5, 0.6, 0.55, 0.38)):
        n = int(H * length / (1.5 * S))
        pts = curve(W * x0 + (y0 * 0.04 * W), H * y0, ang, H * length * 0.95, 0.08, n)
        u = numpy.linspace(0, 1, n)
        stroke(rgb, alpha, pts, numpy.full(n, 1.9 * S) * (1 - 0.3 * u), shade(y0 + u * (1 - y0)) * 0.95, rib=False)
    leaf = curve(W * 0.5, H * 0.3, 0.9, W * 0.38, 0.1, 30)
    stroke(rgb, alpha, leaf, S * 7 * numpy.sin(numpy.linspace(0.1, 1, 30) * math.pi) + S, numpy.full(30, 0.86))
    return finish(rgb, alpha, S)


def regrade(flowers, name, size):
    """A Quaternius flower cut-out fitted into ``size`` px: its grey over its mean, times the palette colour."""
    spec = SOURCE_HEADS[name]
    x0, y0, x1, y1 = spec["box"]
    h = flowers.shape[0]
    crop = flowers[h - y1:h - y0, x0:x1]  # .pixels rows run bottom up
    side = max(crop.shape[:2])
    pad = numpy.zeros((side, side, 4), dtype=numpy.float32)
    oy, ox = (side - crop.shape[0]) // 2, (side - crop.shape[1]) // 2
    pad[oy:oy + crop.shape[0], ox:ox + crop.shape[1]] = crop
    idx = ((numpy.arange(size) + 0.5) * side / size).astype(int)
    small = pad[idx][:, idx]
    lum = small[..., :3] @ numpy.array([0.2126, 0.7152, 0.0722])
    mask = small[..., 3] > 0.5
    grey = numpy.clip(lum / lum[mask].mean(), *spec["clip"])
    yy, xx = numpy.mgrid[0:size, 0:size]
    centre = numpy.hypot(yy - size / 2, xx - size / 2) < size * spec["centreShare"]
    colour = numpy.where(centre[..., None], srgb(spec["centre"]), srgb(spec["colour"]))
    return numpy.clip(colour * grey[..., None], 0, 1), mask.astype(numpy.float32)


def build_atlas(inputs):
    grass = load(inputs["grass"])
    flowers = load(inputs["flowers"])
    ramp = blade_ramp(grass)
    pixels = numpy.zeros((ATLAS, ATLAS, 4), dtype=numpy.float32)
    pixels[..., :3] = 0.6
    for index, (name, (x, y, w, h)) in enumerate(CELLS.items()):
        rng = numpy.random.RandomState(5720 + index)
        iw, ih = w - 2 * GUTTER, h - 2 * GUTTER
        if name in REEDS:
            rgb, alpha = paint_reeds(iw, ih, REEDS[name], ramp, rng)
        elif name in SEDGES:
            grey, alpha = paint_blades(iw, ih, SEDGES[name], ramp, rng)
            rgb = numpy.repeat(grey[..., None], 3, axis=2)
        elif name in ("cattail", "cattail-leaf"):
            rgb, alpha = paint_cattail(iw, ih, ramp, rng, name == "cattail")
        elif name == "rush":
            rgb, alpha = paint_rush(iw, ih, ramp, rng)
        elif name.startswith("lily-pad"):
            rgb, alpha = paint_pad(iw, rng, name.endswith("-b"))
        elif name.startswith("kidney-leaf"):
            rgb, alpha = paint_kidney(iw, rng, not name.endswith("-b"))
        elif name == "marigold-stem":
            rgb, alpha = paint_branching_stem(iw, ih, ramp, rng)
        else:
            rgb, alpha = regrade(flowers, name, iw)
        # Transparent texels take the cell's mean colour, so mips don't fringe dark.
        mean = rgb[alpha > 0].mean(axis=0) if alpha.any() else numpy.full(3, 0.6)
        rgb = numpy.where(alpha[..., None] > 0, rgb, mean)
        pixels[y:y + h, x:x + w, :3] = mean
        pixels[y + GUTTER:y + GUTTER + ih, x + GUTTER:x + GUTTER + iw, :3] = rgb
        pixels[y + GUTTER:y + GUTTER + ih, x + GUTTER:x + GUTTER + iw, 3] = alpha
    image = bpy.data.images.new("greyhaven-marsh", ATLAS, ATLAS, alpha=True)
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
    bsdf.inputs["Roughness"].default_value = 0.9
    mat.use_backface_culling = False
    return mat


# ----------------------------------------------------------------------------------------------------------- layout


def gradient(colours, t):
    """Foot, middle and tip colours at height share ``t``."""
    foot, mid, tip = colours
    return foot + (mid - foot) * (t / 0.5) if t <= 0.5 else mid + (tip - mid) * ((t - 0.5) / 0.5)


class Cards:
    """Accumulates quads (one or more segments) with UVs, per-corner colour and up-leaning normals."""

    def __init__(self):
        self.verts, self.faces, self.uvs, self.cols, self.normals = [], [], [], [], []

    def card(self, foot, yaw, width, height, cell, colours, lean=(0.0, 0.0), segs=1, mirror=False, sink=SINK):
        u0, v0, u1, v1 = cell_uv(cell)
        if mirror:
            u0, u1 = u1, u0
        d = Vector((math.cos(yaw), math.sin(yaw), 0))
        n = Vector((-d.y, d.x, 0))
        lean = Vector((lean[0], lean[1], 0))
        start = len(self.verts)
        for k in range(segs + 1):
            t = k / segs
            centre = Vector(foot) + Vector((0, 0, -sink + (height + sink) * t)) + lean * (t ** 1.5)
            self.verts += [centre - d * width / 2, centre + d * width / 2]
        for k in range(segs):
            a = start + 2 * k
            self.faces.append((a, a + 1, a + 3, a + 2))
            for (s, t) in ((0, k / segs), (1, k / segs), (1, (k + 1) / segs), (0, (k + 1) / segs)):
                self.uvs.append((u0 + (u1 - u0) * s, v0 + (v1 - v0) * t))
                self.cols.append(tuple(gradient(colours, t)))
                up = Vector((0, 0, 1)) * 0.8 + n * (0.2 if (k % 2 == 0) else -0.2)
                self.normals.append(up.normalized())
        return segs * 2

    def flat(self, centre, yaw, size, cell, colour, tilt=0.0, normal_up=True):
        """A square of side ``size`` facing up, tilted ``tilt`` degrees towards ``yaw``."""
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
        shading = Vector((0, 0, 1)) if normal_up else (Vector((0, 0, 1)) + normal).normalized()
        for a, b in ((0, 0), (1, 0), (1, 1), (0, 1)):
            self.uvs.append((u0 + (u1 - u0) * a, v0 + (v1 - v0) * b))
            self.cols.append(tuple(colour))
            self.normals.append(shading)
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


def build(piece, lod_level, collection, inputs):
    """Builds ``piece`` at ``lod_level`` into ``collection``; returns the object and its observations."""
    spec = PIECES[piece]
    rng = random.Random(spec["seed"])
    nrng = numpy.random.RandomState(spec["seed"])
    mat = material(build_atlas(inputs))
    keep = LOD1["keep"] if lod_level == 1 else 1.0
    grow = LOD1["grow"] / math.sqrt(keep) if lod_level == 1 else 1.0
    cards = Cards()
    tri = {"leaves": 0, "flowers": 0}
    feet = []
    chosen = {}
    counts = {"plumes": 0, "flowers": 0, "pads": 0}

    def kept(group, index, total):
        """lod1 keeps exactly a seeded share of each group; every level draws the same random numbers first."""
        if lod_level == 0:
            return True
        if group not in chosen:
            chosen[group] = set(random.Random(spec["seed"] * 31 + len(chosen)).sample(range(total), max(1, int(total * keep))))
        return index in chosen[group]

    def crossed(x, y, kind, keep_it, scale=1.0):
        n = rng.randint(*kind["cards"])
        yaw0 = rng.uniform(0, math.pi)
        height = rng.uniform(*kind["height"]) * scale
        colours = [c * t for c, t in zip(palette(kind["green"]), [jitter(numpy.ones(3), rng, 0.1)] * 3)]
        for k in range(n):
            yaw = yaw0 + k * math.pi / n + rng.uniform(-0.25, 0.25)
            h = height * rng.uniform(0.88, 1.08)
            w = rng.uniform(*kind["width"]) * grow * (0.6 + 0.4 * scale)
            lean_dir = rng.uniform(0, math.tau)
            lean = (math.cos(lean_dir) * h * 0.08, math.sin(lean_dir) * h * 0.08)
            foot = (x + rng.uniform(-0.04, 0.04), y + rng.uniform(-0.04, 0.04), 0)
            cell, mirror = rng.choice(kind["cells"]), rng.random() < 0.5
            if keep_it:
                tri["leaves"] += cards.card(foot, yaw, w, h, cell, colours, lean, kind["segs"] if lod_level == 0 else 1, mirror)
                feet.append((foot[0], foot[1], w / 2))
                if cell.startswith("reed") or cell == "cattail":
                    counts["plumes"] += 1

    if lod_level == 2:
        return far(piece, spec, mat, collection)

    if piece == "water-lilies":
        return lilies(piece, spec, rng, nrng, kept, grow, lod_level, mat, collection)
    if piece == "marsh-marigold":
        return marigolds(piece, spec, rng, nrng, kept, grow, lod_level, mat, collection)

    if "clump" in spec:  # one tussock: arching cards fanning out from a tight foot, upright ones inside
        c = spec["clump"]
        colours = palette("sedge")
        for k in range(c["cards"] + c["inner"]):
            inner = k >= c["cards"]
            ang = k * math.tau / c["cards"] + rng.uniform(-0.2, 0.2) if not inner else rng.uniform(0, math.tau)
            r = c["radius"] * (0.3 if inner else rng.uniform(0.6, 1.0))
            foot = (math.cos(ang) * r, math.sin(ang) * r * 0.8, 0)
            h = rng.uniform(*c["height"]) * (1.15 if inner else 1.0)
            out = 0.06 if inner else rng.uniform(0.2, 0.34)
            lean = (math.cos(ang) * out, math.sin(ang) * out)
            tint = jitter(numpy.ones(3), rng, 0.08)
            w = rng.uniform(*c["width"]) * grow
            cell = "sedge-a" if (k % 3) else "sedge-b"
            if not kept("clump", k, c["cards"] + c["inner"]):
                continue
            tri["leaves"] += cards.card(foot, ang + math.pi / 2, w, h, cell, [col * tint for col in colours], lean,
                                        2 if lod_level == 0 else 1, k % 2 == 0)
            feet.append((foot[0], foot[1], w / 2))

    kinds = spec["kinds"]
    if spec.get("edge"):
        spots = edge_spots(spec, rng, nrng)
    else:
        spots = [(x, y, 1.0) for x, y in place(spec, rng, nrng, spec["tufts"], spec["strays"])]
    for index, (x, y, land) in enumerate(spots):
        roll, acc = rng.random(), 0.0
        kind = kinds[-1]
        if spec.get("edge"):
            kind = kinds[0] if land > 0.42 else kinds[1]
        else:
            for candidate in kinds:
                acc += candidate["share"]
                if roll < acc:
                    kind = candidate
                    break
        crossed(x, y, kind, kept("tufts", index, len(spots)), 0.62 + 0.38 * land if spec.get("edge") else 1.0)

    if "heads" in spec:  # cattail stems stand among the leaves
        heads = place({"length": spec["length"] * 0.8, "width": spec["width"] * 0.7}, rng, nrng, spec["tufts"] - 2, 0)
        for index, (x, y) in enumerate(heads):
            crossed(x, y, spec["heads"], kept("heads", index, len(heads)))

    obj = cards.mesh(piece, mat, collection)
    return obj, observe(piece, lod_level, cards, tri, counts, feet)


def edge_spots(spec, rng, nrng):
    """Reeds thinning towards open water at -Y: a ragged band whose land side is dense and tall, then single stems."""
    xs, ys, widths = spine(spec, nrng)
    spots = []
    for _ in range(spec["tufts"]):
        i = rng.randint(0, len(xs) - 1)
        land = rng.random() ** 0.55  # 1 at the land side, 0 at the water side; most tufts stand landward
        x = xs[i] + rng.uniform(-0.5, 0.5) * (xs[1] - xs[0])
        y = ys[i] * 0.5 + (land - 0.45) * (widths[i] * 1.6 + 0.35)
        spots.append((x, y, land))
    for _ in range(spec["strays"]):  # single stems out in the water
        i = rng.randint(2, len(xs) - 3)
        spots.append((xs[i] + rng.uniform(-0.1, 0.1), ys[i] * 0.5 - 0.45 * (widths[i] * 1.6 + 0.35) - rng.uniform(0.1, 0.45), 0.0))
    return spots


def lilies(piece, spec, rng, nrng, kept, grow, lod_level, mat, collection):
    """Flat pads in a loose, wandering raft, a few overlapping, and two or three open flowers on them."""
    cards = Cards()
    tri = {"leaves": 0, "flowers": 0}
    feet = []
    counts = {"plumes": 0, "flowers": 0, "pads": 0}
    spots = place(spec, rng, nrng, spec["pads"], spec["strays"])
    order = []
    for index, (x, y) in enumerate(spots):
        size = rng.uniform(*spec["pad"])
        colour = jitter(linear(srgb(rng.choice(PADS[1] if rng.random() < 0.2 else PADS[0]))), rng, 0.08)
        order.append((index, x, y, size, rng.uniform(0, math.tau), colour, rng.random() < 0.4))
    for index, x, y, size, yaw, colour, ragged in order:
        if not kept("pads", index, len(order)):
            continue
        z = FLOAT + 0.0006 * (index % 8)  # overlapping pads stay apart
        tri["leaves"] += cards.flat((x, y, z), yaw, size * (grow ** 0.5), "lily-pad-b" if ragged else "lily-pad", colour)
        feet.append((x, y, size / 2))
        counts["pads"] += 1
    flowers = rng.sample(range(len(order)), spec["flowers"])
    for j, index in enumerate(flowers):
        _, x, y, size, yaw, _, _ = order[index]
        c = Vector((x + rng.uniform(-0.03, 0.03), y + rng.uniform(-0.03, 0.03), FLOAT + 0.02))
        twist = rng.uniform(0, math.tau)
        if not kept("flowers", j, len(flowers)):
            continue
        white = linear(srgb("#ffffff"))
        # An open cup: a wide flat layer and a smaller, higher one turned half a petal.
        tri["flowers"] += cards.flat(c, twist, 0.15, "lily-flower", white * 0.92)
        tri["flowers"] += cards.flat(c + Vector((0, 0, 0.025)), twist + 0.6, 0.1, "lily-flower", white)
        counts["flowers"] += 1
    obj = cards.mesh(piece, mat, collection)
    return obj, observe(piece, lod_level, cards, tri, counts, feet)


def marigolds(piece, spec, rng, nrng, kept, grow, lod_level, mat, collection):
    """Two or three clumps along the patch: tilted kidney leaves on low stalks round forking flower stems."""
    cards = Cards()
    tri = {"leaves": 0, "flowers": 0}
    feet = []
    counts = {"plumes": 0, "flowers": 0, "pads": 0}
    foot, mid, tip = palette("marigold")
    xs, ys, _ = spine(spec, nrng)  # clumps strung out along the wandering spine, not heaped together
    picks = [int((k + 0.5) / spec["clumps"] * len(xs)) for k in range(spec["clumps"])]
    centres = [(xs[i] + rng.uniform(-0.08, 0.08), ys[i] + rng.uniform(-0.1, 0.1)) for i in picks]
    index = 0
    for c_index, (cx, cy) in enumerate(centres):
        for k in range(spec["leaves"]):
            ang = k * math.tau / spec["leaves"] + rng.uniform(-0.3, 0.3)
            r = rng.uniform(0.04, 0.17)
            z = rng.uniform(0.06, 0.2) * (1.15 - r * 2)
            size = rng.uniform(*spec["leaf"])
            colour = jitter(mid * 0.6 + tip * 0.4, rng, 0.1)
            tilt = rng.uniform(15, 45)
            cell = "kidney-leaf" if k % 2 else "kidney-leaf-b"
            index += 1
            if not kept("leaves", index, spec["leaves"] * len(centres)):
                continue
            centre = (cx + math.cos(ang) * r, cy + math.sin(ang) * r, z)
            tri["leaves"] += cards.flat(centre, ang, size * (grow ** 0.5), cell, colour, tilt, normal_up=False)
            feet.append((centre[0], centre[1], size / 2))
        for k in range(spec["stems"]):
            h = rng.uniform(0.26, 0.4)
            x, y = cx + rng.uniform(-0.08, 0.08), cy + rng.uniform(-0.08, 0.08)
            yaw = rng.uniform(0, math.pi)
            heads = [(rng.uniform(-0.06, 0.06), rng.uniform(-0.06, 0.06), -rng.uniform(0, 0.08), rng.uniform(0, math.tau), rng.uniform(10, 45))
                     for _ in range(rng.randint(1, 3))]
            if not kept("stems", c_index * spec["stems"] + k, spec["stems"] * len(centres)):
                continue
            tri["leaves"] += cards.card((x, y, 0), yaw, 0.16 * grow ** 0.5, h, "marigold-stem", [foot, mid, tip])
            for ox, oy, oz, hyaw, tilt in heads:
                tri["flowers"] += cards.flat((x + ox, y + oy, h + oz), hyaw, spec["flower"] * grow ** 0.5, "marigold",
                                             numpy.ones(3), tilt, normal_up=False)
                counts["flowers"] += 1
            feet.append((x, y, 0.08))
    obj = cards.mesh(piece, mat, collection)
    return obj, observe(piece, lod_level, cards, tri, counts, feet)


def far(piece, spec, mat, collection):
    """The last level: one card along the patch's long side; for the lilies, five grown pads."""
    cards = Cards()
    counts = {"plumes": 0, "flowers": 0, "pads": 0}
    if piece == "water-lilies":
        rng = random.Random(spec["seed"] + 1)
        colour = linear(srgb(PADS[0][0]))
        for k in range(LOD2["pads"]):
            x = (k / (LOD2["pads"] - 1) - 0.5) * spec["length"] * 0.7
            cards.flat((x, rng.uniform(-0.2, 0.2) * spec["width"], FLOAT + 0.0006 * k), rng.uniform(0, math.tau),
                       sum(spec["pad"]) / 2 * LOD2["padGrow"], "lily-pad", colour)
            counts["pads"] += 1
    else:
        cell, green, height = {
            "reeds-stand": ("reed-a", "reed", 2.2), "reeds-edge": ("reed-a", "reed", 1.9), "cattails": ("cattail", "cattail", 1.5),
            "sedge-tussock": ("sedge-a", "sedge", 0.6), "rushes": ("rush", "rush", 0.8), "marsh-marigold": ("sedge-b", "marigold", 0.3),
        }[piece]
        colours = palette(green)
        if piece == "marsh-marigold":
            colours[2] = colours[2] * 0.7 + 0.3 * linear(srgb("#f2c41c"))
        length = (spec["width"] if "clump" in spec else spec["length"]) * LOD2["length"]
        y = 0.25 * spec["width"] if piece == "reeds-edge" else 0.0  # the dense, landward side
        cards.card((0, y, 0), 0.0, length, height * LOD2["height"], cell, colours)
    obj = cards.mesh(piece, mat, collection)
    return obj, observe(piece, 2, cards, {"leaves": 2 * len(cards.faces), "flowers": 0}, counts, None)


def observe(piece, level, cards, tri, counts, feet):
    return {"recipe": RECIPE, "piece": piece, "level": level, "cards": len(cards.faces), "leafTriangles": tri["leaves"],
            "flowerTriangles": tri["flowers"], "flowers": counts["flowers"], "plumeCards": counts["plumes"], "pads": counts["pads"],
            "coverM2": cover(feet) if feet else None}


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_meadow(inputs.load_source("meadow"))
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
