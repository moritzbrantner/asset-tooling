"""Greyhaven forest floor for mmorpg (docs/greyhaven-forest-floor.md, #572): walk-through scatter for the floor under
the Vale woods, Wolfrun Woods and Hollowpine Reach.

Every piece is a ragged patch on one cut-out atlas, grown like the meadow's (``greyhaven_meadow.py``): along a
wandering spine whose width wanders too, with a few strays, so no outline is a round blob or a square. Ferns are
crowns of arching frond strips; bracken is a stand of stalks, each holding one near-horizontal triangular frond, some
of them browning; bluebells and wood anemones are low drifts; mushrooms are a small cluster of low-poly caps; leaf
litter is a few flat, ragged quads of fallen leaves lying 1 cm above the ground.

The declared inputs are:

* ``grass``: the catalogued CC0 Quaternius Stylized Nature MegaKit ``Grass.png``. Its light-to-dark green strip
  shades every painted frond, stalk and leaf from foot to tip (as grey, so the colour comes from ``COLOR_0``);
* ``flowers``: the catalogued CC0 Quaternius ``Flowers.png``. Its peach flower becomes the wood anemone, cut out and
  regraded to white;
* ``leaves``: the catalogued CC0 Quaternius ``Leaves_NormalTree_C.png``, the broadleaf trees' own leaf texture. Its
  leaves are cut out one by one, turned, shrunk and regraded to autumn browns for the leaf litter;
* ``meadow``: ``greyhaven_meadow.py``, whose seeded spine, placement, image and colour helpers this recipe reuses;
* ``marsh``: ``greyhaven_marsh.py``, whose stroke painters, card builder and material this recipe reuses.

So the kit has one material, ``Greyhaven_Forest_Floor``: cut-out (``MASK``), double-sided, a 1024 px atlas times
``COLOR_0``. Fronds, stalks, strap leaves, anemone leaves and mushroom caps are greyscale, so the game can tint them;
only the bluebells, the anemone flowers, the leaf litter and the far mushroom card carry their own colour (still
multiplied by ``COLOR_0``). The palettes are darker than the meadow's, for shade.

``level`` picks the level of detail, in the same frame: ``1`` keeps a seeded 40 % of each group, grown so the patch
keeps its coverage, with fronds bent once and caps with fewer sides; ``2`` is one card along the patch's long side
(one flat quad for the leaf litter).

The arguments are ``piece`` and ``level``. The origin is the patch's centre on the ground; card feet run 3 cm below
it, so a patch stays rooted on uneven ground. ``leaf-litter`` lies flat 1 cm above it (with a millimetre between
overlapping quads), so it doesn't z-fight the terrain. Blender coordinates are Z up; the GLB is exported +Y up.
Everything is seeded (``random.Random`` and ``numpy.random.RandomState``).
"""
import math
import random

import bpy
import numpy
from mathutils import Vector

RECIPE = "greyhaven-forest-floor-v1"
MATERIAL = "Greyhaven_Forest_Floor"
ATLAS = 1024
GUTTER = 6
SINK = 0.03  # card feet below the ground (m)
FLOAT = 0.01  # leaf litter above the ground (m)
# The helpers this recipe binds from its declared inputs ``meadow`` and ``marsh``.
SHARED_MEADOW = ("srgb", "linear", "load", "down", "blade_ramp", "paint_blades", "spine", "place", "jitter", "cover")
SHARED_MARSH = ("stamp", "stroke", "curve", "finish", "regrade", "gradient", "Cards", "material")
# Atlas cells (x, y, width, height) in px, origin bottom left. Fronds and stems grow up the cell.
CELLS = {
    "frond-a": (0, 0, 128, 512), "frond-b": (0, 512, 128, 512), "frond-c": (128, 0, 128, 512),
    "stalk": (128, 512, 64, 512),
    "bracken-a": (256, 0, 256, 256), "bracken-b": (256, 256, 256, 256), "strap": (256, 512, 256, 256),
    "litter-a": (512, 0, 256, 256), "litter-b": (512, 256, 256, 256), "litter-c": (512, 512, 256, 256),
    "litter-d": (256, 768, 256, 256),
    "mushroom-card": (512, 768, 128, 128), "cap": (640, 768, 128, 128), "gills": (512, 896, 128, 128),
    "cap-b": (640, 896, 128, 128),
    "bluebell": (768, 0, 128, 256), "bluebell-b": (896, 0, 128, 256),
    "anemone-leaf": (768, 256, 128, 128), "anemone-leaf-b": (896, 256, 128, 128), "anemone": (768, 384, 128, 128),
    "bracken-c": (768, 512, 256, 256),
}
# Painted fronds: pinnae a side, bare stipe share, pinna angle from the rachis (rad), pinna width (px), droop, and
# ``shape``: ``lance`` (widest a third up, as male and lady fern) or ``triangle`` (widest at the foot, as bracken);
# ``lobes`` scallops the pinnae; a non-zero ``pinnules`` paints each pinna as a little frond of its own, with pinnules
# that long (share of the pinna).
FRONDS = {
    "frond-a": {"pinnae": 22, "stipe": 0.1, "angle": (1.0, 1.2), "pinna": 4.2, "droop": 0.12, "shape": "lance", "lobes": True, "pinnules": 0},
    "frond-b": {"pinnae": 19, "stipe": 0.12, "angle": (0.9, 1.1), "pinna": 4.8, "droop": 0.2, "shape": "lance", "lobes": True, "pinnules": 0},
    "frond-c": {"pinnae": 17, "stipe": 0.08, "angle": (1.05, 1.25), "pinna": 2.0, "droop": 0.1, "shape": "lance", "lobes": False, "pinnules": 0.16},
    "bracken-a": {"pinnae": 11, "stipe": 0.04, "angle": (1.0, 1.2), "pinna": 1.5, "droop": 0.06, "shape": "triangle", "lobes": False, "pinnules": 0.11},
    "bracken-b": {"pinnae": 10, "stipe": 0.05, "angle": (0.95, 1.15), "pinna": 1.6, "droop": 0.1, "shape": "triangle", "lobes": False, "pinnules": 0.12},
    "bracken-c": {"pinnae": 12, "stipe": 0.04, "angle": (1.05, 1.3), "pinna": 1.4, "droop": 0.04, "shape": "triangle", "lobes": False, "pinnules": 0.1},
}
# The bluebell's broad strap leaves, in the meadow's blade painter's format.
STRAP = {"blades": 16, "height": (0.5, 0.97), "width": (13, 19), "lean": 0.55, "heads": None}
# Painted colours (sRGB): bluebell stem and bells (top, body, mouth), the far mushroom card, and the litter browns.
BLUEBELL = {"stem": "#3b5a2c", "bells": ("#2e2c66", "#45428e", "#6866ae")}
MUSHROOM_CARD = {"cap": "#7a5636", "rim": "#a77e52", "stem": "#d8ccb0"}
LITTER = ["#4e4026", "#5c4a2e", "#6a5634", "#73603c", "#463a28", "#56522e", "#3a3222", "#5e4a2c"]
# The leaves of Leaves_NormalTree_C.png (x0, y0, x1, y1, top-left origin) and a pixel inside each.
SOURCE_LEAVES = [
    ((436, 133, 613, 392), (540, 255)), ((678, 163, 818, 319), (812, 221)), ((203, 260, 392, 438), (319, 330)),
    ((634, 342, 864, 568), (725, 453)), ((104, 448, 299, 597), (249, 554)), ((326, 468, 541, 761), (475, 631)),
    ((704, 606, 893, 706), (779, 675)), ((524, 640, 711, 890), (540, 712)), ((126, 655, 274, 803), (188, 745)),
    ((415, 778, 492, 921), (430, 848)),
]
# The Quaternius flower cut-out, regraded like the meadow's heads (read by the marsh's ``regrade``).
SOURCE_HEADS = {
    "anemone": {"box": (0, 0, 468, 440), "colour": "#f4f1ea", "centre": "#e3c43c", "centreShare": 0.14, "clip": (0.74, 1.06)},
}
# COLOR_0 palettes (sRGB): foot, middle and tip per kind. Darker than the meadow's: this is shade.
GREENS = {
    "fern": ("#1d3318", "#36592a", "#5d8040"),
    "fern-lush": ("#1a3017", "#2f5426", "#4f7a36"),
    "bracken": ("#2a3f1e", "#486a2c", "#6e8a3c"),
    "bracken-turning": ("#3c3e1c", "#6c6a2c", "#9a7a34"),
    "bracken-dead": ("#4a3420", "#7a5230", "#9c6a3a"),
    "stalk": ("#3a2e1e", "#4f5a2a", "#5f6e32"),
    "bluebell": ("#1e3418", "#2f5025", "#4a6e34"),
    "anemone": ("#22381a", "#3a5c2a", "#557a38"),
    "cap": ("#6a4a2e", "#8a6640", "#a8875a"),
    "cap-pale": ("#8a7656", "#a8946c", "#c2ae84"),
    "stem": ("#b8ab8e", "#cfc3a6", "#ddd2b8"),
}


def frond_kind(cells, length, width, rise, cards, green, share=1.0):
    return {"cells": cells, "length": length, "width": width, "rise": rise, "cards": cards, "green": green, "share": share}


# Per piece: patch length and width (m), seed, and the piece's own makeup.
PIECES = {
    # Low ferns: three or four crowns of arching fronds strung along the spine, a few single fronds between.
    "fern": {"length": 1.7, "width": 0.8, "seed": 5721, "crowns": 4, "strays": 3,
             "crown": frond_kind(["frond-a", "frond-b"], (0.4, 0.58), (0.22, 0.27), (1.05, 1.3), (8, 10), "fern")},
    # Big shuttlecock crowns of male and lady fern, knee to waist high, and a small one.
    "fern-large": {"length": 2.0, "width": 1.1, "seed": 5722, "crowns": 3, "strays": 2, "big": 2,
                   "crown": frond_kind(["frond-a", "frond-c"], (0.95, 1.2), (0.36, 0.42), (1.2, 1.4), (10, 12), "fern-lush")},
    # A spreading stand: stalks with one near-horizontal triangular frond each; a third turning, a few dead.
    "bracken": {"length": 3.0, "width": 1.6, "seed": 5723, "plants": 26, "strays": 3, "height": (0.45, 1.15),
                "frond": (0.7, 1.0), "turning": 0.3, "dead": 0.12},
    # Drifts of strap-leaf clumps with arching, one-sided stems of blue bells.
    "bluebells": {"length": 1.9, "width": 0.9, "seed": 5724, "clumps": 17, "strays": 3, "leaves": (0.18, 0.28),
                  "stems": (2, 3), "stem": (0.3, 0.42)},
    # A low carpet: whorls of three-parted leaves, most under a nodding-open white flower.
    "wood-anemone": {"length": 1.7, "width": 0.9, "seed": 5725, "plants": 30, "strays": 4, "flowering": 0.8,
                     "height": (0.1, 0.17), "leaf": (0.07, 0.1), "flower": 0.05},
    # A small cluster of brown caps on pale stems, growing along a buried root or log line.
    "mushrooms": {"length": 0.5, "width": 0.24, "seed": 5726, "caps": 6, "radius": (0.028, 0.06), "height": (0.04, 0.11),
                  "sides": 7},
    # Flat, ragged quads of fallen leaves overlapping into one patch.
    "leaf-litter": {"length": 2.2, "width": 1.2, "seed": 5727, "quads": 11, "strays": 2, "size": (0.5, 0.75)},
}
LOD1 = {"keep": 0.4, "grow": 0.85, "frondSegs": 2, "capSides": 5}
LOD2 = {"length": 0.8, "height": 0.8, "litter": 1.4}


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "piece", "level"} or p["schemaVersion"] != 1:
        raise ValueError("greyhaven forest floor requires exactly schemaVersion 1, piece and level")
    if p["piece"] not in PIECES or p["level"] not in (0, 1, 2):
        raise ValueError(f"greyhaven forest floor: piece in {sorted(PIECES)}, level 0, 1 or 2")
    if set(inputs) != {"grass", "flowers", "leaves", "meadow", "marsh"}:
        raise ValueError("greyhaven forest floor takes exactly the declared inputs grass, flowers, leaves, meadow and marsh")


def use_sources(meadow, marsh):
    """Bind the meadow's and the marsh's helpers (the declared Python inputs) into this module. The marsh module is a
    fresh copy, so pointing its card builder and flower regrader at this atlas leaves the marsh recipe untouched."""
    marsh["use_meadow"](meadow)
    marsh_globals = marsh["use_meadow"].__globals__
    marsh_globals["cell_uv"] = cell_uv
    marsh_globals["SOURCE_HEADS"] = SOURCE_HEADS
    globals().update({name: meadow[name] for name in SHARED_MEADOW})
    globals().update({name: marsh[name] for name in SHARED_MARSH})


def palette(name):
    return [linear(srgb(c)) for c in GREENS[name]]


# ----------------------------------------------------------------------------------------------------------- textures


def cstroke(rgb, alpha, points, widths, colours):
    """A tapered stroke in colour: one disc per point."""
    for (x, y), w, c in zip(points, widths, colours):
        stamp(rgb, alpha, x, y, w, c)


def envelope(v, shape):
    """Pinna length along the blade (0 at the foot of the blade, 1 at the tip), as a share of the longest."""
    if shape == "triangle":
        return (1 - v) ** 0.9
    return min(1.0, 0.5 + v / 0.32 * 0.5) if v < 0.32 else ((1 - v) / 0.68) ** 0.8


def paint_frond(w, h, spec, ramp, rng):
    """A fern frond seen from above, its tip at the top of the cell: a rachis with alternate pinnae; scalloped
    (``lobes``) or each pinna a small frond of pinnules (``pinnules``). Grey, darker at the foot."""
    S = 2
    W, H = w * S, h * S
    rgb = numpy.zeros((H, W, 3), dtype=numpy.float32)
    alpha = numpy.zeros((H, W), dtype=numpy.float32)
    shade = lambda t: float(numpy.interp(t, numpy.linspace(0, 1, len(ramp)), ramp))
    top = H * 0.985
    steps = int(top / (1.2 * S))
    t = numpy.linspace(0, 1, steps)
    xs = W / 2 + rng.uniform(-0.05, 0.05) * W * t ** 2
    ys = t * top
    stroke(rgb, alpha, list(zip(xs, ys)), 1.5 * S * (1 - t) + 0.6 * S, [shade(0.2 + 0.6 * v) * 0.82 for v in t], rib=False)
    stipe, n = spec["stipe"], spec["pinnae"]
    reach = (W / 2 - 2 * S)
    for i in range(n):
        for side in (-1, 1):
            u = stipe + (1 - stipe) * (i + (0.25 if side < 0 else 0.75)) / n
            v = (u - stipe) / (1 - stipe)
            ang = side * rng.uniform(*spec["angle"])
            length = envelope(v, spec["shape"]) * reach / max(math.sin(abs(ang)), 0.5) * rng.uniform(0.88, 1.0)
            if length < 3 * S:
                continue
            k = min(int(u * (steps - 1)), steps - 1)
            m = max(int(length / (1.2 * S)), 4)
            pts = curve(xs[k], ys[k], ang, length, spec["droop"], m)
            s = numpy.linspace(0, 1, m)
            tone = shade(0.25 + 0.7 * u) * rng.uniform(0.86, 1.0)
            if spec["pinnules"]:  # a fine pinna stalk with pinnules angled towards its tip
                stroke(rgb, alpha, pts, numpy.full(m, 0.7 * S), [tone * 0.9] * m, rib=False)
                dx, dy = math.sin(ang), math.cos(ang)
                for j in range(1, m - 1, 2):
                    px, py = pts[j]
                    size = (1 - s[j]) ** 0.8 * length * spec["pinnules"] + S
                    for side2 in (-1, 1):
                        a2 = math.atan2(dx, dy) + side2 * 0.85
                        q = max(int(size / (1.0 * S)), 2)
                        sub = curve(px, py, a2, size, 0.0, q)
                        stroke(rgb, alpha, sub, spec["pinna"] * S * (1 - numpy.linspace(0, 0.8, q)) * (1 - 0.6 * s[j]) + 0.5 * S,
                               [tone * (0.95 + 0.08 * s[j])] * q, rib=False)
            else:
                widths = spec["pinna"] * S * (1 - s) ** 0.6 * (0.6 + 0.4 * envelope(v, spec["shape"])) + 0.6 * S
                stroke(rgb, alpha, pts, widths, [tone * (0.94 + 0.1 * x) for x in s], rib=False)
                if spec["lobes"]:  # scallops along the pinna
                    nx, ny = math.cos(ang), -math.sin(ang)
                    for j in range(2, m - 2, 3):
                        px, py = pts[j]
                        for side2 in (-1, 1):
                            stamp(rgb, alpha, px + side2 * nx * widths[j] * 0.75, py + side2 * ny * widths[j] * 0.75,
                                  widths[j] * 0.55, numpy.full(3, tone * 0.9))
    return finish(rgb, alpha, S)


def paint_stalk(w, h, ramp, rng):
    """A bare, slightly curved stalk, grey."""
    S = 2
    W, H = w * S, h * S
    rgb = numpy.zeros((H, W, 3), dtype=numpy.float32)
    alpha = numpy.zeros((H, W), dtype=numpy.float32)
    steps = int(H / (1.2 * S))
    t = numpy.linspace(0, 1, steps)
    xs = W / 2 + 0.12 * W * numpy.sin(t * 2.4)
    shades = numpy.interp(t, numpy.linspace(0, 1, len(ramp)), ramp)
    stroke(rgb, alpha, list(zip(xs, t * (H - 2 * S))), 3.2 * S * (1 - 0.45 * t), shades * 0.95, rib=False)
    return finish(rgb, alpha, S)


def paint_bluebell(w, h, rng):
    """A bluebell stem: rising, then nodding over at the top, its narrow blue bells hanging from one side."""
    S = 2
    W, H = w * S, h * S
    rgb = numpy.zeros((H, W, 3), dtype=numpy.float32)
    alpha = numpy.zeros((H, W), dtype=numpy.float32)
    stem = srgb(BLUEBELL["stem"])
    top_c, body_c, mouth_c = (srgb(c) for c in BLUEBELL["bells"])
    steps = 260
    t = numpy.linspace(0, 1, steps)
    x0 = W * rng.uniform(0.18, 0.24)
    xs = x0 + W * 0.52 * t ** 2.2
    ys = (H - 3 * S) * numpy.sin(t * math.pi / 2 * 0.92) ** 0.9
    cstroke(rgb, alpha, list(zip(xs, ys)), 1.5 * S * (1 - 0.4 * t) + 0.4 * S, [stem * (0.8 + 0.25 * v) for v in t])
    bells = rng.randint(6, 9)
    for b in range(bells):  # top bells first, so the lower ones hang in front
        u = 0.98 - 0.5 * (b + rng.uniform(0.3, 0.7)) / bells
        i = min(int(u * (steps - 1)), steps - 1)
        px, py = xs[i], ys[i]
        hang = rng.uniform(0.25, 0.6)  # leans out from straight down, away from the stem
        dx, dy = math.sin(hang), -math.cos(hang)
        ped = 6 * S
        cstroke(rgb, alpha, [(px + dx * ped * s, py + dy * ped * s) for s in numpy.linspace(0, 1, 8)], numpy.full(8, 0.7 * S), [stem] * 8)
        length = rng.uniform(11, 14) * S
        bx, by = px + dx * ped, py + dy * ped
        for s in numpy.linspace(0, 1, 14):
            r = (2.3 + 1.9 * s ** 1.5) * S
            c = top_c * (1 - s) + body_c * s
            stamp(rgb, alpha, bx + dx * length * s, by + dy * length * s, r, numpy.clip(c * rng.uniform(0.95, 1.05), 0, 1))
        mx, my = bx + dx * length, by + dy * length
        for side in (-1, 1):  # the flared, curled-back tips
            stamp(rgb, alpha, mx + side * 4.0 * S * math.cos(hang) - dx * S, my + side * 4.0 * S * math.sin(hang) - dy * S, 1.6 * S, mouth_c)
    return finish(rgb, alpha, S)


def paint_anemone_leaf(size, rng, wide):
    """A wood-anemone leaf whorl seen from above: three deeply toothed leaflets; grey."""
    yy, xx = (numpy.mgrid[0:size, 0:size] + 0.5 - size / 2) / (size / 2)
    r, a = numpy.hypot(xx, yy), numpy.arctan2(yy, xx) + rng.uniform(0, math.tau)
    lobes = numpy.abs(numpy.cos(1.5 * a)) ** (0.45 if wide else 0.6)
    teeth = 0.82 + 0.18 * numpy.abs(numpy.cos(7.5 * a))
    edge = 0.95 * lobes * teeth
    inside = (r < edge) & (r < 0.97)
    veins = numpy.abs(numpy.sin(1.5 * a)) < 0.06
    grey = 0.6 + 0.24 * (r / 0.95) + 0.1 * veins - 0.08 * (r > edge - 0.06)
    return numpy.repeat(numpy.clip(grey, 0, 1)[..., None], 3, axis=2), inside.astype(numpy.float32)


def paint_cap(size, rng, scaly):
    """A mushroom cap from above: darker at the crown, fine radial fibrils, a few flecks (``scaly``); grey."""
    yy, xx = (numpy.mgrid[0:size, 0:size] + 0.5 - size / 2) / (size / 2)
    r, a = numpy.hypot(xx, yy), numpy.arctan2(yy, xx)
    grey = 0.58 + 0.34 * r ** 0.7 + 0.035 * numpy.sin(a * 70 + rng.uniform(0, 6)) * r
    if scaly:
        flecks = numpy.zeros_like(r, dtype=bool)
        for _ in range(26):
            fa, fr = rng.uniform(0, math.tau), math.sqrt(rng.uniform(0.05, 0.75))
            flecks |= (xx - fr * math.cos(fa)) ** 2 + (yy - fr * math.sin(fa)) ** 2 < 0.004
        grey = numpy.where(flecks, grey * 0.72, grey)
    grey -= 0.12 * (r > 0.9)
    return numpy.repeat(numpy.clip(grey, 0, 1)[..., None], 3, axis=2), (r < 0.98).astype(numpy.float32)


def paint_gills(size, rng):
    """A cap's underside: dense radial gills round the stem; grey."""
    yy, xx = (numpy.mgrid[0:size, 0:size] + 0.5 - size / 2) / (size / 2)
    r, a = numpy.hypot(xx, yy), numpy.arctan2(yy, xx)
    gills = numpy.abs(((a * 48 / math.tau) % 1) - 0.5) < 0.22
    grey = numpy.where(gills, 0.78, 0.55) * (0.8 + 0.2 * r)
    grey = numpy.where(r < 0.2, 0.86, grey)
    return numpy.repeat(numpy.clip(grey, 0, 1)[..., None], 3, axis=2), (r < 0.98).astype(numpy.float32)


def paint_mushroom_card(size, rng):
    """The far card: three mushrooms side on, in colour."""
    S = 2
    n = size * S
    yy, xx = numpy.mgrid[0:n, 0:n] + 0.5
    rgb = numpy.zeros((n, n, 3), dtype=numpy.float32)
    alpha = numpy.zeros((n, n), dtype=bool)
    cap, rim, stem = (srgb(MUSHROOM_CARD[k]) for k in ("cap", "rim", "stem"))
    for cx, height, radius in ((0.3, 0.55, 0.2), (0.62, 0.78, 0.25), (0.84, 0.4, 0.14)):
        cx, top, rad = cx * n, height * n, radius * n
        sw = rad * 0.28
        s_in = (numpy.abs(xx - cx) < sw * (1 + 0.2 * (1 - yy / top))) & (yy < top - rad * 0.3)
        rgb[s_in] = stem * (0.85 + 0.15 * yy[s_in, None] / top)
        alpha |= s_in
        dome = (((xx - cx) / rad) ** 2 + ((yy - (top - rad * 0.35)) / (rad * 0.7)) ** 2 < 1) & (yy > top - rad * 0.35)
        f = ((xx - cx) / rad) ** 2
        rgb[dome] = (cap * (1 - f[dome, None]) + rim * f[dome, None])
        alpha |= dome
    a = down(alpha.astype(numpy.float32), S)
    c = down(rgb * alpha[..., None], S) / numpy.maximum(a, 1e-6)[..., None]
    return numpy.clip(c, 0, 1), numpy.where(a > 0.35, 1.0, 0.0)


def source_leaves(leaves):
    """Each leaf of Leaves_NormalTree_C.png as (grey over its mean, mask), flood-filled from a pixel inside it."""
    h = leaves.shape[0]
    out = []
    for (x0, y0, x1, y1), (sx, sy) in SOURCE_LEAVES:
        crop = leaves[h - y1:h - y0, x0:x1][::-1]  # top row first
        solid = crop[..., 3] > 0.5
        mask = numpy.zeros_like(solid)
        mask[sy - y0, sx - x0] = True
        while True:
            grown = mask.copy()
            grown[1:] |= mask[:-1]
            grown[:-1] |= mask[1:]
            grown[:, 1:] |= mask[:, :-1]
            grown[:, :-1] |= mask[:, 1:]
            grown &= solid
            if (grown == mask).all():
                break
            mask = grown
        lum = crop[..., :3] @ numpy.array([0.2126, 0.7152, 0.0722])
        out.append((numpy.clip(lum / lum[mask].mean(), 0.7, 1.25), mask))
    return out


def paint_litter(w, h, shapes, rng):
    """Fallen leaves: the source leaves turned, shrunk and regraded to browns, densest in a ragged middle, with a few
    twigs. Linear-ish sRGB colour; the outline is the leaves themselves."""
    S = 2
    W, H = w * S, h * S
    rgb = numpy.zeros((H, W, 3), dtype=numpy.float32)
    alpha = numpy.zeros((H, W), dtype=numpy.float32)
    phases = rng.uniform(0, math.tau, 3)
    for _ in range(int(rng.uniform(170, 210))):
        while True:
            x, y = rng.uniform(-1, 1, 2)
            r, a = math.hypot(x, y), math.atan2(y, x)
            reach = 0.72 + 0.14 * math.sin(3 * a + phases[0]) + 0.08 * math.sin(5 * a + phases[1]) + 0.05 * math.sin(9 * a + phases[2])
            if r < reach and rng.uniform() > (r / reach) ** 2.5:
                break
        grey, mask = shapes[rng.randint(len(shapes))]
        length = rng.uniform(0.1, 0.17) * W
        scale = length / max(mask.shape)
        turn = rng.uniform(0, math.tau)
        cx, cy = W / 2 + x * W / 2 * 0.92, H / 2 + y * H / 2 * 0.92
        half = int(length * 0.75) + 2
        yy, xx = numpy.mgrid[-half:half, -half:half].astype(numpy.float32)
        c, s = math.cos(turn), math.sin(turn)
        u = (c * xx + s * yy) / scale + mask.shape[1] / 2
        v = (-s * xx + c * yy) / scale + mask.shape[0] / 2
        ok = (u >= 0) & (v >= 0) & (u < mask.shape[1] - 1) & (v < mask.shape[0] - 1)
        ui, vi = u.astype(int).clip(0, mask.shape[1] - 1), v.astype(int).clip(0, mask.shape[0] - 1)
        hit = ok & mask[vi, ui]
        X, Y = (xx + cx).astype(int), (yy + cy).astype(int)
        hit &= (X >= 0) & (Y >= 0) & (X < W) & (Y < H)
        colour = srgb(LITTER[rng.randint(len(LITTER))]) * rng.uniform(0.85, 1.1)
        lit = numpy.clip(colour[None, :] * grey[vi[hit], ui[hit], None], 0, 1)
        rgb[Y[hit], X[hit]] = lit
        alpha[Y[hit], X[hit]] = 1.0
    twig = srgb("#3e3020")
    for _ in range(rng.randint(2, 4)):  # a few dark twigs across the leaves
        x, y, ang = rng.uniform(0.25, 0.75) * W, rng.uniform(0.25, 0.75) * H, rng.uniform(0, math.tau)
        length = rng.uniform(0.2, 0.4) * W
        pts = [(x + math.cos(ang) * length * s, y + math.sin(ang) * length * s + 2 * S * math.sin(s * 5)) for s in numpy.linspace(-0.5, 0.5, 60)]
        cstroke(rgb, alpha, pts, numpy.full(60, 1.1 * S), [twig * rng.uniform(0.9, 1.1)] * 60)
    return finish(rgb, alpha, S)


def build_atlas(inputs):
    grass = load(inputs["grass"])
    flowers = load(inputs["flowers"])
    shapes = source_leaves(load(inputs["leaves"]))
    ramp = blade_ramp(grass)
    pixels = numpy.zeros((ATLAS, ATLAS, 4), dtype=numpy.float32)
    pixels[..., :3] = 0.5
    for index, (name, (x, y, w, h)) in enumerate(CELLS.items()):
        rng = numpy.random.RandomState(5730 + index)
        iw, ih = w - 2 * GUTTER, h - 2 * GUTTER
        if name in FRONDS:
            rgb, alpha = paint_frond(iw, ih, FRONDS[name], ramp, rng)
        elif name == "stalk":
            rgb, alpha = paint_stalk(iw, ih, ramp, rng)
        elif name == "strap":
            grey, alpha = paint_blades(iw, ih, STRAP, ramp, rng)
            rgb = numpy.repeat(grey[..., None], 3, axis=2)
        elif name.startswith("litter"):
            rgb, alpha = paint_litter(iw, ih, shapes, rng)
        elif name == "mushroom-card":
            rgb, alpha = paint_mushroom_card(iw, rng)
        elif name.startswith("cap"):
            rgb, alpha = paint_cap(iw, rng, name.endswith("-b"))
        elif name == "gills":
            rgb, alpha = paint_gills(iw, rng)
        elif name.startswith("bluebell"):
            rgb, alpha = paint_bluebell(iw, ih, rng)
        elif name.startswith("anemone-leaf"):
            rgb, alpha = paint_anemone_leaf(iw, rng, name.endswith("-b"))
        else:
            rgb, alpha = regrade(flowers, name, iw)
        # Transparent texels take the cell's mean colour, so mips don't fringe dark.
        mean = rgb[alpha > 0].mean(axis=0) if alpha.any() else numpy.full(3, 0.5)
        rgb = numpy.where(alpha[..., None] > 0, rgb, mean)
        pixels[y:y + h, x:x + w, :3] = mean
        pixels[y + GUTTER:y + GUTTER + ih, x + GUTTER:x + GUTTER + iw, :3] = rgb
        pixels[y + GUTTER:y + GUTTER + ih, x + GUTTER:x + GUTTER + iw, 3] = alpha
    image = bpy.data.images.new("greyhaven-forest-floor", ATLAS, ATLAS, alpha=True)
    image.pixels.foreach_set(pixels.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def cell_uv(name):
    x, y, w, h = CELLS[name]
    g = GUTTER + 1
    return (x + g) / ATLAS, (y + g) / ATLAS, (x + w - g) / ATLAS, (y + h - g) / ATLAS


def floor_material(image):
    """The marsh's material (the atlas times COLOR_0, cut-out, double-sided) under this kit's name."""
    mat = material(image)
    mat.name = MATERIAL
    return mat


# ----------------------------------------------------------------------------------------------------------- layout


def floor_cards():
    """The marsh's card builder plus arching frond strips and low-poly mushroom caps."""

    class FloorCards(Cards):
        def frond(self, foot, yaw, length, width, rise, cell, colours, segs, droop=1.0):
            """A strip leaving ``foot`` towards ``yaw`` at ``rise`` rad above level, arching over by ``droop`` rad; its
            width lies level across it, so a fern reads from above. The cell's foot is at the crown."""
            u0, v0, u1, v1 = cell_uv(cell)
            d = Vector((math.cos(yaw), math.sin(yaw), 0))
            side = Vector((-d.y, d.x, 0))
            p = Vector(foot)
            start = len(self.verts)
            step = length / segs
            rows = [p.copy()]
            for k in range(segs):
                pitch = rise - droop * (k + 0.5) / segs
                p = p + d * math.cos(pitch) * step + Vector((0, 0, math.sin(pitch) * step))
                rows.append(p.copy())
            for k, centre in enumerate(rows):
                taper = 1.0 - 0.15 * k / segs
                self.verts += [centre - side * width * taper / 2, centre + side * width * taper / 2]
            for k in range(segs):
                a = start + 2 * k
                self.faces.append((a, a + 1, a + 3, a + 2))
                for (s, t) in ((0, k / segs), (1, k / segs), (1, (k + 1) / segs), (0, (k + 1) / segs)):
                    self.uvs.append((u0 + (u1 - u0) * s, v0 + (v1 - v0) * t))
                    self.cols.append(tuple(gradient(colours, t)))
                    self.normals.append((Vector((0, 0, 1)) * 0.85 + d * 0.25 * (0.5 - t)).normalized())
            return segs * 2

        def cap(self, centre, radius, height, stem_height, sides, cap_cell, colours, stem_colours, tilt, dome):
            """A mushroom: a cap over ``cap_cell`` (domed with a shoulder ring when ``dome``, else a cone), a gill fan
            under it and a tapered stem on the gills cell's pale middle."""
            cx, cy = centre
            lean = Vector((math.cos(tilt[0]), math.sin(tilt[0]), 0)) * tilt[1]
            at = lambda r, a, z: Vector((cx + math.cos(a) * r, cy + math.sin(a) * r, z)) + lean * z
            angles = [k * math.tau / sides for k in range(sides)]
            rim_z = stem_height - height * 0.15
            rings = [(1.0, rim_z)] + ([(0.62, stem_height + height * 0.72)] if dome else [])
            apex_z = stem_height + height
            tris = 0

            def corner(cell, share, ang, colour, normal):
                u0, v0, u1, v1 = cell_uv(cell)
                cu, cv, ru, rv = (u0 + u1) / 2, (v0 + v1) / 2, (u1 - u0) / 2 * 0.98, (v1 - v0) / 2 * 0.98
                self.uvs.append((cu + math.cos(ang) * ru * share, cv + math.sin(ang) * rv * share))
                self.cols.append(tuple(colour))
                self.normals.append(tuple(normal.normalized()))

            def vertex(share, z, ang):
                self.verts.append(at(radius * share, ang, z) if share else at(0, 0, z))
                return len(self.verts) - 1

            # Top: bands between the rings (outer first), then a fan to the apex.
            top = colours[1]
            for (s0, z0), (s1, z1) in zip(rings, rings[1:]):
                for k, a in enumerate(angles):
                    b = angles[(k + 1) % sides]
                    quad = [(s0, z0, a), (s0, z0, b), (s1, z1, b), (s1, z1, a)]
                    self.faces.append(tuple(vertex(*q) for q in quad))
                    for s, z, ang in quad:
                        corner(cap_cell, s, ang, top, Vector((math.cos(ang), math.sin(ang), 0.9)))
                    tris += 2
            s_in, z_in = rings[-1]
            for k, a in enumerate(angles):
                b = angles[(k + 1) % sides]
                tri = [(0, apex_z, a), (s_in, z_in, a), (s_in, z_in, b)]
                self.faces.append(tuple(vertex(*q) for q in tri))
                for s, z, ang in tri:
                    corner(cap_cell, s, ang, top * (0.85 if s == 0 else 1.0),
                           Vector((0, 0, 1)) if s == 0 else Vector((math.cos(ang), math.sin(ang), 1.6)))
                tris += 1
            # Underneath: a gill fan from the rim to the top of the stem, facing down.
            hub_z = stem_height + height * 0.1
            for k, a in enumerate(angles):
                b = angles[(k + 1) % sides]
                tri = [(0, hub_z, a), (1.0, rim_z, b), (1.0, rim_z, a)]
                self.faces.append(tuple(vertex(*q) for q in tri))
                for s, z, ang in tri:
                    corner("gills", s, ang, colours[0] * 0.8, Vector((math.cos(ang) * s, math.sin(ang) * s, -1.5)))
                tris += 1
            # The stem: a tapered tube, its foot sunk like the cards', on the gills cell's solid, pale middle.
            u0, v0, u1, v1 = cell_uv("gills")
            cu, cv, du, dv = (u0 + u1) / 2, (v0 + v1) / 2, (u1 - u0) * 0.06, (v1 - v0) * 0.06
            n = 4 if sides > 5 else 3
            r0, r1 = radius * 0.36, radius * 0.27
            base = len(self.verts)
            for a in (k * math.tau / n for k in range(n)):
                self.verts.append(Vector((cx + math.cos(a) * r0, cy + math.sin(a) * r0, -SINK)))
                self.verts.append(at(r1, a, stem_height))
            for k in range(n):
                a, b = base + 2 * k, base + 2 * ((k + 1) % n)
                self.faces.append((a, b, b + 1, a + 1))
                ang = (k + 0.5) * math.tau / n
                for (s, t) in ((0, 0), (1, 0), (1, 1), (0, 1)):
                    self.uvs.append((cu + du * (2 * s - 1), cv + dv * (2 * t - 1)))
                    self.cols.append(tuple(gradient(stem_colours, t)))
                    self.normals.append(tuple(Vector((math.cos(ang), math.sin(ang), 0.3)).normalized()))
                tris += 2
            return tris

    return FloorCards()


def build(piece, lod_level, collection, inputs):
    """Builds ``piece`` at ``lod_level`` into ``collection``; returns the object and its observations."""
    spec = PIECES[piece]
    rng = random.Random(spec["seed"])
    nrng = numpy.random.RandomState(spec["seed"])
    mat = floor_material(build_atlas(inputs))
    keep = LOD1["keep"] if lod_level == 1 else 1.0
    grow = LOD1["grow"] / math.sqrt(keep) if lod_level == 1 else 1.0
    cards = floor_cards()
    feet = []
    chosen = {}
    counts = {"fronds": 0, "flowers": 0, "caps": 0, "quads": 0}

    def kept(group, index, total):
        """lod1 keeps exactly a seeded share of each group; every level draws the same random numbers first."""
        if lod_level == 0:
            return True
        if group not in chosen:
            chosen[group] = set(random.Random(spec["seed"] * 31 + len(chosen)).sample(range(total), max(1, int(total * keep))))
        return index in chosen[group]

    if lod_level == 2:
        return far(piece, spec, cards, mat, collection)
    segs = 3 if lod_level == 0 else LOD1["frondSegs"]

    def crown(x, y, kind, scale, group, index_base, total):
        n = rng.randint(*kind["cards"])
        yaw0 = rng.uniform(0, math.tau)
        colours = [c * t for c, t in zip(palette(kind["green"]), [jitter(numpy.ones(3), rng, 0.1)] * 3)]
        for k in range(n):
            yaw = yaw0 + k * math.tau / n + rng.uniform(-0.3, 0.3)
            length = rng.uniform(*kind["length"]) * scale
            width = rng.uniform(*kind["width"]) * scale * grow ** 0.5
            rise = rng.uniform(*kind["rise"])
            cell = rng.choice(kind["cells"])
            foot = (x + math.cos(yaw) * 0.03, y + math.sin(yaw) * 0.03, -0.01)
            if kept(group, index_base + k, total):
                cards.frond(foot, yaw, length, width, rise, cell, colours, segs, droop=rise * 0.85)
                feet.append((x + math.cos(yaw) * length * 0.5, y + math.sin(yaw) * length * 0.5, width / 2))
                counts["fronds"] += 1

    if piece in ("fern", "fern-large"):
        kind = spec["crown"]
        xs, ys, _ = spine(spec, nrng)
        picks = [int((k + 0.5) / spec["crowns"] * len(xs)) for k in range(spec["crowns"])]
        centres = [(xs[i] + rng.uniform(-0.1, 0.1), ys[i] + rng.uniform(-0.08, 0.08)) for i in picks]
        scales = [1.0 if k < spec.get("big", spec["crowns"]) else rng.uniform(0.45, 0.6) for k in range(len(centres))]
        if "big" in spec:  # the small crown sits between the big ones' ends, not in the middle
            rng.shuffle(scales)
        total = kind["cards"][1] * len(centres)
        for c, ((x, y), scale) in enumerate(zip(centres, scales)):
            crown(x, y, kind, scale * rng.uniform(0.85, 1.1), "fronds", c * kind["cards"][1], total)
        for index, (x, y) in enumerate(place(spec, rng, nrng, 0, spec["strays"])):  # single young fronds
            colours = palette(kind["green"])
            yaw = rng.uniform(0, math.tau)
            length = kind["length"][0] * rng.uniform(0.5, 0.7)
            if kept("strays", index, spec["strays"]):
                cards.frond((x, y, -0.01), yaw, length, kind["width"][0] * 0.7 * grow ** 0.5, rng.uniform(0.9, 1.2),
                            kind["cells"][0], colours, segs, droop=1.2)
                feet.append((x, y, 0.08))
                counts["fronds"] += 1

    elif piece == "bracken":
        spots = place(spec, rng, nrng, spec["plants"], spec["strays"])
        for index, (x, y) in enumerate(spots):
            roll = rng.random()
            green = "bracken-dead" if roll < spec["dead"] else "bracken-turning" if roll < spec["dead"] + spec["turning"] else "bracken"
            colours = [c * t for c, t in zip(palette(green), [jitter(numpy.ones(3), rng, 0.1)] * 3)]
            height = rng.uniform(*spec["height"])
            length = rng.uniform(*spec["frond"])
            yaw = rng.uniform(0, math.tau)
            lean = rng.uniform(0.04, 0.12)
            top = (x + math.cos(yaw) * lean, y + math.sin(yaw) * lean, height)
            rise = rng.uniform(0.35, 0.8)
            cell = rng.choice(["bracken-a", "bracken-b", "bracken-c"])
            if not kept("plants", index, len(spots)):
                continue
            # The stalk rises to the frond's foot; the frond holds out level and arches down.
            tilt = (top[0] - x, top[1] - y)
            cards.card((x, y, 0), yaw + math.pi / 2, 0.05, height, "stalk", palette("stalk"), tilt, 1)
            cards.frond((top[0], top[1], height - 0.02), yaw, length * grow ** 0.5, length * 0.85 * grow ** 0.5, rise, cell,
                        colours, segs, droop=rise + 0.7)
            feet.append((x + math.cos(yaw) * length * 0.4, y + math.sin(yaw) * length * 0.4, length * 0.4))
            counts["fronds"] += 1

    elif piece == "bluebells":
        leaf = palette("bluebell")
        spots = place(spec, rng, nrng, spec["clumps"], spec["strays"])
        for index, (x, y) in enumerate(spots):
            yaw0 = rng.uniform(0, math.pi)
            h = rng.uniform(*spec["leaves"])
            tint = jitter(numpy.ones(3), rng, 0.1)
            stems = [(rng.uniform(0, math.tau), rng.uniform(*spec["stem"]), rng.choice(["bluebell", "bluebell-b"]), rng.random() < 0.5)
                     for _ in range(rng.randint(*spec["stems"]))]
            if not kept("clumps", index, len(spots)):
                continue
            for k in range(2):
                yaw = yaw0 + k * math.pi / 2
                lean = (math.cos(yaw0 + 1) * 0.04, math.sin(yaw0 + 1) * 0.04)
                cards.card((x, y, 0), yaw, 0.26 * grow, h, "strap", [c * tint for c in leaf], lean, 1, k == 1)
            for yaw, sh, cell, mirror in stems:
                cards.card((x + math.cos(yaw) * 0.03, y + math.sin(yaw) * 0.03, 0), yaw, 0.2 * grow ** 0.5, sh, cell,
                           [numpy.ones(3) * 0.85, numpy.ones(3) * 0.95, numpy.ones(3)], (0.0, 0.0), 1, mirror)
                counts["flowers"] += 1
            feet.append((x, y, 0.14 * grow))

    elif piece == "wood-anemone":
        leaf = palette("anemone")
        spots = place(spec, rng, nrng, spec["plants"], spec["strays"])
        for index, (x, y) in enumerate(spots):
            h = rng.uniform(*spec["height"])
            flowering = rng.random() < spec["flowering"]
            tint = jitter(numpy.ones(3), rng, 0.1)
            whorl = (rng.uniform(0, math.tau), rng.uniform(*spec["leaf"]), rng.uniform(5, 25), h * rng.uniform(0.5, 0.7))
            extra = (rng.uniform(0, math.tau), rng.uniform(*spec["leaf"]) * 0.9, rng.uniform(15, 40), h * rng.uniform(0.25, 0.4),
                     rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04))
            flower = (rng.uniform(0, math.tau), rng.uniform(5, 30), jitter(numpy.ones(3), rng, 0.04))
            if not kept("plants", index, len(spots)):
                continue
            yaw, size, tilt, z = whorl
            cards.flat((x, y, z), yaw, size * 2 * grow ** 0.5, "anemone-leaf" if index % 2 else "anemone-leaf-b",
                       leaf[1] * tint, tilt, normal_up=False)
            yaw, size, tilt, z, ox, oy = extra
            cards.flat((x + ox, y + oy, z), yaw, size * 2 * grow ** 0.5, "anemone-leaf-b", leaf[1] * tint * 0.9, tilt, normal_up=False)
            if flowering:
                yaw, tilt, colour = flower
                cards.card((x, y, 0), yaw, 0.024, h, "stalk", leaf, (0.0, 0.0), 1)
                cards.flat((x, y, h), yaw, spec["flower"] * grow ** 0.5, "anemone", colour, tilt, normal_up=False)
                counts["flowers"] += 1
            feet.append((x, y, 0.08 * grow ** 0.5))

    elif piece == "mushrooms":
        sides = spec["sides"] if lod_level == 0 else LOD1["capSides"]
        xs, ys, widths = spine(spec, nrng)
        caps = []
        for k in range(spec["caps"]):
            i = rng.randint(0, len(xs) - 1)
            radius = rng.uniform(*spec["radius"])
            height = rng.uniform(*spec["height"])
            pale = rng.random() < 0.25
            caps.append(((xs[i] + rng.uniform(-0.03, 0.03), ys[i] + rng.gauss(0, 0.4) * widths[i]), radius, height,
                         "cap-b" if pale else "cap", jitter(numpy.ones(3), rng, 0.08), pale,
                         (rng.uniform(0, math.tau), rng.uniform(0.0, 0.25))))
        caps.sort(key=lambda c: -c[1])  # lod1 keeps the biggest
        for index, (centre, radius, height, cell, tint, pale, tilt) in enumerate(caps):
            if lod_level == 1 and index >= max(1, int(len(caps) * LOD1["keep"])):
                continue
            colours = [c * tint for c in palette("cap-pale" if pale else "cap")]
            cards.cap(centre, radius * (grow ** 0.5 if lod_level else 1), radius * 0.45, height, sides, cell, colours,
                      palette("stem"), tilt, lod_level == 0)
            feet.append((centre[0], centre[1], radius))
            counts["caps"] += 1

    elif piece == "leaf-litter":
        spots = place(spec, rng, nrng, spec["quads"], spec["strays"])
        for index, (x, y) in enumerate(spots):
            size = rng.uniform(*spec["size"]) * (0.7 if index >= spec["quads"] else 1.0)
            yaw = rng.uniform(0, math.tau)
            cell = ["litter-a", "litter-b", "litter-c", "litter-d"][index % 4]
            colour = jitter(numpy.ones(3) * 0.9, rng, 0.08)
            if not kept("quads", index, len(spots)):
                continue
            z = FLOAT + 0.001 * (index % 10)  # overlapping quads stay apart
            cards.flat((x, y, z), yaw, size * grow ** 0.5, cell, colour)
            feet.append((x, y, size * 0.4))
            counts["quads"] += 1

    obj = cards.mesh(piece, mat, collection)
    return obj, observe(piece, lod_level, cards, counts, feet)


def far(piece, spec, cards, mat, collection):
    """The last level: one card along the patch's long side; for the leaf litter, one flat, grown quad."""
    counts = {"fronds": 0, "flowers": 0, "caps": 0, "quads": 0}
    if piece == "leaf-litter":
        cards.flat((0, 0, FLOAT), 0.3, sum(spec["size"]) / 2 * LOD2["litter"], "litter-a", numpy.ones(3) * 0.9)
        counts["quads"] = 1
    else:
        cell, green, height = {
            "fern": ("bracken-a", "fern", 0.38), "fern-large": ("bracken-b", "fern-lush", 0.8), "bracken": ("bracken-c", "bracken-turning", 1.0),
            "bluebells": ("strap", "bluebell", 0.28), "wood-anemone": ("strap", "anemone", 0.14), "mushrooms": ("mushroom-card", "stem", 0.12),
        }[piece]
        colours = palette(green)
        if piece == "bluebells":
            colours[2] = colours[2] * 0.4 + 0.6 * linear(srgb("#4a4dbb"))
        elif piece == "wood-anemone":
            colours[2] = colours[2] * 0.4 + 0.6 * linear(srgb("#e8e6dc"))
        elif piece == "mushrooms":
            colours = [numpy.ones(3)] * 3
        length = spec["length"] * LOD2["length"]
        cards.card((0, 0, 0), 0.0, length, height * LOD2["height"], cell, colours)
    obj = cards.mesh(piece, mat, collection)
    return obj, observe(piece, 2, cards, counts, None)


def observe(piece, level, cards, counts, feet):
    return {"recipe": RECIPE, "piece": piece, "level": level, "cards": len(cards.faces), "fronds": counts["fronds"],
            "flowers": counts["flowers"], "caps": counts["caps"], "litterQuads": counts["quads"],
            "coverM2": cover(feet) if feet else None}


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_sources(inputs.load_source("meadow"), inputs.load_source("marsh"))
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
