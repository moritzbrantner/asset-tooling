"""Greyhaven pines for mmorpg (docs/greyhaven-pines.md, #569): six upland conifers of the Bandit Highlands, Greyfang Ridge
and Hollowpine Reach, made to stand with the broadleaf ``greyhaven-trees``.

The recipe reuses its siblings rather than copying them. The declared inputs are:

* ``trees``: ``greyhaven_trees.py``. Its seeded branch skeleton, bark tubes (with the root flare buried below the
  ground), trunk collision tube, bark material and the clump crown (a metaball core with cards over it) grow every
  pine here. Its card cells are swapped for this kit's needle tufts;
* ``conifer``: ``conifer_crown.py``, the reworked ``greyhaven-nature`` fir. Its tiered crown (opaque drooping skirts
  under fir sprig cards) makes the spruces, on a crown profile measured from the grown trunk, with this kit's tier
  count and a darker palette. Its sprig cut-outs of the Poly Haven ``fir_tree_01`` twig atlas fill four needle cells;
* ``lod``: ``nature_lod.py``, for the far levels (cards, clump hulls and the fir envelope);
* ``bark``: the catalogued CC0 Quaternius ``Bark_NormalTree`` image, made a greyscale furrowed cell;
* ``needles`` and ``needleAlpha``: the catalogued CC0 Poly Haven ``fir_tree_01`` twig colour and alpha maps.

So the kit has two materials: the opaque bark atlas (furrowed lower bark, flaky orange upper Scots pine bark,
silvery dead wood and a flat white cell for crown cores and hulls) and the cut-out needle atlas (four fir sprigs
and four generated pine tufts). Both are greyscale and every colour comes from ``COLOR_0``.

A Scots pine reads by its trunk: grey-brown furrowed at the foot, orange-red and flaky above, bare up to a flat,
irregular crown of needle pads high up. The spruces are dense dark cones to the ground.

``level`` picks the level of detail, built from the same skeleton in the same frame: ``1`` keeps a seeded 30 % of
the cards (grown to keep the coverage) and rebuilds the bark with half the sides and rings and without twigs; ``2``
replaces cards and core with ``nature_lod.py``'s clump hull (pines) or tier envelope (spruces), and keeps only trunk
and limbs, minus what the shell hides. The snag's levels only thin its bark.

The arguments are ``piece`` and ``level``. The origin is the trunk's foot on the ground. Blender coordinates are Z up;
the GLB is exported +Y up. Everything is seeded (``random.Random`` and ``numpy.random.RandomState``).
"""
import math
import random
import runpy

import bmesh
import bpy
import numpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

RECIPE = "greyhaven-pines-v1"
BARK_MATERIAL = "Greyhaven_Pines_Bark"
NEEDLE_MATERIAL = "Greyhaven_Pines_Needles"
# The bark atlas keeps greyhaven_trees.py's 2 x 2 layout, so its tube and cell mapping work unchanged; this kit's
# cells sit in that recipe's slots.
BARK_SLOTS = {"furrowed": "furrowed", "flaky": "beech", "deadwood": "birch", "flat": "flat"}
NEEDLE_ATLAS = (1024, 512)  # 4 x 2 cells of 256 px: fir sprigs on the bottom row, pine tufts on the top
NEEDLE_GUTTER = 10
NEEDLE_CELLS = ["sprig-1", "sprig-2", "sprig-3", "sprig-4", "tuft-1", "tuft-2", "short-1", "short-2"]
# Pine tufts, painted: needles per tuft, needle length (share of the cell) and spread (radians from the shoot).
TUFTS = {"tuft": {"needles": 150, "length": (0.5, 0.9), "spread": 0.75}, "short": {"needles": 170, "length": (0.32, 0.6), "spread": 0.95}}


def level(count, span, angle, length, radius, bend, lift, sides, segs):
    return {"count": count, "span": span, "angle": angle, "length": length, "radius": radius, "bend": bend, "lift": lift, "sides": sides, "segs": segs}


# Per piece, in greyhaven_trees.py's skeleton format: target height (m), trunk (length, base radius, lean, bend, sides,
# rings), leader, child levels, seed. ``bark`` is the lower and upper bark (cell, sRGB tint) and the share of the trunk
# where the upper begins; limbs take the upper. ``crown`` is either a clump crown (greyhaven_trees.py's keys, with
# ``leaf`` naming the tuft cells) or ``tiers``: a fir crown from ``base`` (share of the height) with ``reach`` (m) at
# its foot, ``count`` tiers, ``cards`` sprig cards and a palette. ``wind`` shears the tree and cuts its upwind limbs.
PIECES = {
    "scots-pine": {
        "height": 17.0, "trunk": (15.6, 0.32, 0.03, 0.05, 10, 12), "leader": True, "taper": 0.2, "seed": 5691,
        "levels": [level(7, (0.78, 0.95), (78, 94), (0.2, 0.3), 0.42, 0.18, 0.04, 6, 4),
                   level(3, (0.35, 1.0), (45, 75), (0.3, 0.45), 0.5, 0.3, 0.0, 4, 2)],
        "crown": {"fill": 3, "along": 0.45, "leaderFrom": 1.0, "clump": 0.8, "card": 0.95, "cards": 1500, "core": 380, "leaf": "tuft", "shade": "#172c22", "sun": "#6f8a5a", "inset": 0.16},
        "bark": (("furrowed", "#6a5d52"), ("flaky", "#c8693e"), 0.38),
    },
    "scots-pine-windswept": {
        "height": 10.0, "trunk": (9.4, 0.28, 0.0, 0.08, 10, 10), "leader": True, "taper": 0.5, "seed": 5692, "wind": 0.32,
        "levels": [level(8, (0.55, 0.97), (74, 92), (0.22, 0.34), 0.45, 0.22, 0.02, 6, 4)],
        "crown": {"fill": 2, "along": 0.5, "leaderFrom": 0.9, "clump": 0.78, "card": 0.85, "cards": 1000, "core": 300, "leaf": "tuft", "shade": "#172c22", "sun": "#68845a", "inset": 0.14},
        "bark": (("furrowed", "#665a50"), ("flaky", "#b9643d"), 0.3),
    },
    "spruce": {
        "height": 15.0, "trunk": (14.8, 0.3, 0.0, 0.02, 9, 8), "leader": True, "seed": 5693, "levels": [],
        "crown": {"tiers": 14, "base": 0.125, "reach": 3.2, "cards": 2500,
                  "shade": (0.011, 0.034, 0.016), "mid": (0.028, 0.09, 0.04), "sun": (0.08, 0.19, 0.06), "core": (0.009, 0.028, 0.012)},
        "bark": (("furrowed", "#5f5149"), ("furrowed", "#5f5149"), 1.0),
    },
    "spruce-young": {
        "height": 5.0, "trunk": (4.9, 0.1, 0.0, 0.03, 7, 6), "leader": True, "seed": 5694, "levels": [],
        "crown": {"tiers": 7, "base": 0.17, "reach": 1.35, "cards": 1100,
                  "shade": (0.014, 0.042, 0.018), "mid": (0.036, 0.115, 0.045), "sun": (0.11, 0.25, 0.07), "core": (0.011, 0.033, 0.014)},
        "bark": (("furrowed", "#6a5a4f"), ("furrowed", "#6a5a4f"), 1.0),
    },
    "pine-dead": {
        "height": 11.0, "trunk": (11.0, 0.3, 0.03, 0.05, 10, 9), "leader": False, "seed": 5695, "broken": True,
        "levels": [level(11, (0.3, 0.95), (66, 92), (0.11, 0.2), 0.42, 0.22, 0.04, 5, 3)],
        "crown": None,
        "bark": (("furrowed", "#77706a"), ("deadwood", "#b3aca2"), 0.18),
    },
    "pine-sapling": {
        "height": 2.2, "trunk": (2.0, 0.04, 0.03, 0.08, 6, 6), "leader": True, "taper": 0.7, "seed": 5696,
        "levels": [level(10, (0.2, 0.88), (58, 72), (0.34, 0.46), 0.5, 0.2, 0.16, 4, 2)],
        "crown": {"hull": 60, "fill": 3, "along": 0.3, "leaderFrom": 0.5, "clump": 0.3, "card": 0.34, "cards": 280, "core": 90, "leaf": "short", "shade": "#203b22", "sun": "#7c9a52", "inset": 0.05},
        "bark": (("flaky", "#8a5a3e"), ("flaky", "#a2643f"), 0.5),
    },
}
LOD1 = {"keep": 0.3, "grow": 0.92, "sides": 0.5, "rings": 0.5, "minRadius": 0.045}
LOD2 = {"sides": 0.4, "maxLevel": 1, "hull": {"inflate": 0.8, "fit": 0.85, "hullTriangles": 440, "neighbours": 8, "coreShare": 0.4, "gain": 0.85, "underside": 0.6},
        "envelope": {"bands": 20, "sectors": 12, "fit": 0.8, "neighbours": 8, "coreShare": 0.4, "gain": 0.7, "underside": 0.5}}
BARE_LODS = {1: {"sides": 0.5, "rings": 0.5, "minRadius": 0.06}, 2: {"sides": 0.34, "rings": 0.34, "minRadius": 0.12}}


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "piece", "level"} or p["schemaVersion"] != 1:
        raise ValueError("greyhaven pines require exactly schemaVersion 1, piece and level")
    if p["piece"] not in PIECES or p["level"] not in (0, 1, 2):
        raise ValueError(f"greyhaven pines: piece in {sorted(PIECES)}, level 0, 1 or 2")
    if set(inputs) != {"trees", "conifer", "lod", "bark", "needles", "needleAlpha"}:
        raise ValueError("greyhaven pines take exactly the declared inputs trees, conifer, lod, bark, needles and needleAlpha")


# ----------------------------------------------------------------------------------------------------------- textures


def flaky_cell(trees, size, rng):
    """Scots pine upper bark: thin papery plates, each a little lighter or darker, with fine dark rims between them."""
    plates = trees["periodic_noise"](size, (70, 30), rng)
    fine = trees["periodic_noise"](size, (8, 4), rng)
    steps = numpy.floor(plates * 7) / 7
    edge = numpy.abs(plates * 7 - numpy.round(plates * 7)) < 0.08
    grey = 0.78 + 0.32 * (steps - 0.5) + 0.1 * (fine - 0.5)
    return numpy.clip(numpy.where(edge, grey * 0.5, grey), 0, 1)


def deadwood_cell(trees, size, rng):
    """Weathered silver wood: grain streaks along the trunk and a few dark checks."""
    streaks = trees["periodic_noise"](size, (2, 90), rng)
    mottle = trees["periodic_noise"](size, (20, 20), rng)
    grey = 0.82 + 0.16 * (streaks - 0.5) + 0.06 * (mottle - 0.5)
    yy, xx = numpy.mgrid[0:size, 0:size] / size
    for _ in range(9):
        cx, cy = rng.uniform(0, 1, 2)
        dx = (xx - cx + 0.5) % 1 - 0.5
        dy = (yy - cy + 0.5) % 1 - 0.5
        grey = numpy.where((numpy.abs(dx) < 0.004) & (numpy.abs(dy) < rng.uniform(0.08, 0.3)), grey * 0.45, grey)
    return numpy.clip(grey, 0, 1)


def bark_atlas(trees, bark_path):
    """greyhaven_trees.py's 2 x 2 atlas layout with this kit's cells, each wrapped into its gutter."""
    atlas, gutter = trees["BARK_ATLAS"], trees["BARK_GUTTER"]
    size = atlas // 2
    inner = size - 2 * gutter
    rng = numpy.random.RandomState(5690)
    cells = {
        "furrowed": trees["furrowed_cell"](bark_path, inner),
        "flaky": flaky_cell(trees, inner, rng),
        "deadwood": deadwood_cell(trees, inner, rng),
        "flat": numpy.ones((inner, inner), dtype=numpy.float32),
    }
    pixels = numpy.ones((atlas, atlas, 4), dtype=numpy.float32)
    for name, slot in BARK_SLOTS.items():
        row, col = divmod(trees["BARK_CELLS"].index(slot), 2)
        tile = numpy.pad(cells[name], gutter, mode="wrap")
        pixels[row * size:(row + 1) * size, col * size:(col + 1) * size, :3] = tile[:, :, None]
    image = bpy.data.images.new("greyhaven-pines-bark", atlas, atlas, alpha=False)
    image.pixels.foreach_set(pixels.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def resample(a, h, w):
    """Bilinear resample of a 2D array to ``h`` x ``w``."""
    ys = numpy.clip((numpy.arange(h) + 0.5) * a.shape[0] / h - 0.5, 0, a.shape[0] - 1)
    xs = numpy.clip((numpy.arange(w) + 0.5) * a.shape[1] / w - 0.5, 0, a.shape[1] - 1)
    y0, x0 = numpy.floor(ys).astype(int), numpy.floor(xs).astype(int)
    y1, x1 = numpy.minimum(y0 + 1, a.shape[0] - 1), numpy.minimum(x0 + 1, a.shape[1] - 1)
    fy, fx = (ys - y0)[:, None], (xs - x0)[None, :]
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bottom = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return top * (1 - fy) + bottom * fy


def sprig_box(conifer, index):
    """Where fir sprig ``index`` sits in its cell, in pixels: as tall as the cell, as wide as its aspect allows."""
    left, top, right, bottom = conifer["SPRIGS"][index]
    inner = NEEDLE_ATLAS[0] // 4 - 2 * NEEDLE_GUTTER
    w = round(inner * (right - left) / (bottom - top))
    x = index * (NEEDLE_ATLAS[0] // 4) + NEEDLE_GUTTER + (inner - w) // 2
    return x, NEEDLE_GUTTER, w, inner


def paint_tuft(blur, size, kind, rng):
    """A pine shoot seen from the side: long needles fanning up from a short stem, with the gaps closed so the tuft
    stays solid in the cut-out as it mips down."""
    p = TUFTS[kind]
    tone = numpy.zeros((size, size), dtype=numpy.float32)
    alpha = numpy.zeros((size, size), dtype=numpy.float32)
    for _ in range(p["needles"]):
        s = rng.uniform(0, 1)
        start = numpy.array([0.5 + rng.uniform(-0.03, 0.03), 0.05 + 0.4 * s])
        a = numpy.clip(rng.normal(0, p["spread"] * 0.55), -p["spread"] * 1.6, p["spread"] * 1.6) * (0.6 + 0.6 * s)
        length = rng.uniform(*p["length"]) * (1 - 0.45 * s) * (1 - 0.25 * abs(a))
        direction = numpy.array([math.sin(a), math.cos(a)])
        steps = max(2, int(length * size * 2))
        t = numpy.linspace(0, 1, steps)[:, None]
        pts = (start[None, :] + direction[None, :] * length * t) * (size - 1)
        shade = 0.62 + 0.25 * rng.uniform() + 0.13 * t[:, 0]
        for ox, oy in ((0, 0), (1, 0), (0, 1)):
            xi = numpy.clip(numpy.round(pts[:, 0]).astype(int) + ox, 0, size - 1)
            yi = numpy.clip(numpy.round(pts[:, 1]).astype(int) + oy, 0, size - 1)
            numpy.maximum.at(tone, (yi, xi), shade)
            alpha[yi, xi] = 1.0
    filled = blur(blur(alpha, 3), 3) > 0.3
    coverage = numpy.maximum(alpha, filled.astype(numpy.float32))
    return numpy.where(alpha > 0, tone, 0.5), coverage


def needle_atlas(conifer, needles, needle_alpha):
    """Four fir sprigs (conifer_crown.py's cut-outs, aspect kept) and four painted pine tufts, greyscale with alpha."""
    width, height = NEEDLE_ATLAS
    size = width // 4
    inner = size - 2 * NEEDLE_GUTTER
    pixels = numpy.zeros((height, width, 4), dtype=numpy.float32)
    pixels[:, :, :3] = 0.5
    twig = conifer["needle_image"](needles, needle_alpha)
    edge = twig.size[0]
    px = numpy.empty(edge * edge * 4, dtype=numpy.float32)
    twig.pixels.foreach_get(px)
    px = px.reshape(edge, edge, 4)
    bpy.data.images.remove(twig)
    k = edge / 2048
    for index, (left, top, right, bottom) in enumerate(conifer["SPRIGS"]):
        crop = px[round(edge - bottom * k):round(edge - top * k), round(left * k):round(right * k)]
        x, y, w, h = sprig_box(conifer, index)
        for channel in (0, 3):
            block = resample(crop[:, :, channel], h, w)
            if channel == 0:
                pixels[y:y + h, x:x + w, :3] = block[:, :, None]
            else:
                pixels[y:y + h, x:x + w, 3] = block
    for index, name in enumerate(NEEDLE_CELLS[4:]):
        tone, alpha = paint_tuft(conifer["blur"], inner, name.split("-")[0], numpy.random.RandomState(5700 + index))
        x, y = index * size + NEEDLE_GUTTER, size + NEEDLE_GUTTER
        pixels[y:y + inner, x:x + inner, :3] = tone[:, :, None]
        pixels[y:y + inner, x:x + inner, 3] = alpha
    image = bpy.data.images.new("greyhaven-pines-needles", width, height, alpha=True)
    image.pixels.foreach_set(pixels.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def tuft_cell_uvs(name):
    """greyhaven_trees.py's card corners for a tuft cell (its ``leaf_cell_uvs``, on this atlas)."""
    row, col = divmod(NEEDLE_CELLS.index(name), 4)
    return [((col + du) / 4, (row + dv) / 2) for du, dv in ((0, 0), (1, 0), (1, 1), (0, 1))]


# ------------------------------------------------------------------------------------------------------------- shape


def windswept(spec, branches, rng):
    """Cut the upwind limbs short and lean the tree downwind (+X), more towards the top: a crag pine's flag shape."""
    for b in branches[1:]:
        reach = b["points"][-1] - b["points"][0]
        if reach.x < -0.25 * reach.xy.length:
            keep = rng.uniform(0.3, 0.55)
            start = b["points"][0]
            b["points"] = [start + (p - start) * keep for p in b["points"]]
            b["radii"] = [r * (0.6 + 0.4 * keep) for r in b["radii"]]


def shear(branches, clumps, wind, height):
    def move(p):
        return Vector((p.x + wind * height * max(0.0, p.z / height) ** 1.6, p.y, p.z))
    for b in branches:
        b["points"] = [move(p) for p in b["points"]]
    return [(move(c), r, t) for c, r, t in clumps]


def split_trunk(spec, branches):
    """Give every branch its bark: the trunk changes from the lower to the upper bark at the split; limbs take the
    upper. The trunk becomes two tubes meeting at one ring."""
    lower, upper, share = spec["bark"]
    trunk = branches[0]
    out = []
    pts, rad = trunk["points"], trunk["radii"]
    cut = round(share * (len(pts) - 1))
    if 0 < cut < len(pts) - 1:
        out.append(dict(trunk, points=pts[:cut + 1], radii=rad[:cut + 1], broken=False, bark=lower))
        out.append(dict(trunk, points=pts[cut:], radii=rad[cut:], bark=upper))
    else:
        out.append(dict(trunk, bark=lower if cut else upper))
    return out + [dict(b, bark=upper) for b in branches[1:]]


def bark_mesh(trees, branches, sides_share, ring_share, min_radius, max_level, rng):
    """greyhaven_trees.py's bark tubes, each branch on its own cell and tint."""
    buffers = ([], [], [], [])
    for b in branches:
        if b["level"] > max_level or (b["level"] and b["radii"][0] < min_radius):
            continue
        cell, tint = b["bark"]
        sides = max(3, round(b["sides"] * sides_share))
        trees["tube"](b, sides, ring_share, BARK_SLOTS[cell], trees["lin"](tint), rng, buffers, True)
    verts, faces, uvs, colours = buffers
    mesh = bpy.data.meshes.new("bark")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    uv = mesh.uv_layers.new(name="UVMap")
    col = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for poly, fuv, fcol in zip(mesh.polygons, uvs, colours):
        poly.use_smooth = True
        for li, puv, pcol in zip(poly.loop_indices, fuv, fcol):
            uv.data[li].uv = puv
            col.data[li].color = (*pcol, 1.0)
    return mesh


class FirCrown:
    """The crown profile conifer_crown.py's tiers read (its ``Crown``), measured from the grown trunk: a cone from the
    crown base to the top."""

    def __init__(self, trunk, base, top, reach):
        self.points = trunk["points"]
        self.zb, self.zt, self.reach = base, top, reach
        self.radii = [reach]

    def axis(self, z):
        pts = self.points
        for a, b in zip(pts, pts[1:]):
            if b.z >= z:
                t = (z - a.z) / max(1e-6, b.z - a.z)
                return Vector((a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, z))
        return Vector((pts[-1].x, pts[-1].y, z))

    def radius(self, z):
        h = max(0.0, min(1.0, (z - self.zb) / (self.zt - self.zb)))
        return self.reach * (1.0 - h) ** 0.9 + 0.15


def fir_crown(conifer, trees, spec, trunk, collection, bark_mat, needle_mat, needle_image, seed):
    """conifer_crown.py's tiered crown with this kit's tier count, palette and needle cells; the skirts go on the bark
    atlas's flat cell."""
    crown = spec["crown"]
    g = conifer["build_crown"].__globals__
    g.update(TIERS=crown["tiers"], CROWN_FLOOR=0.0, NEEDLE_SHADE=crown["shade"], NEEDLE_MID=crown["mid"], NEEDLE_SUN=crown["sun"], CORE=crown["core"])
    g["sprig_uv"] = lambda region: fir_sprig_uv(conifer, region)
    profile = FirCrown(trunk, spec["height"] * crown["base"], spec["height"] - 0.1, crown["reach"])
    core, needles = conifer["build_crown"](profile, needle_image, seed, crown["cards"], collection)
    for obj, mat in ((core, bark_mat), (needles, needle_mat)):
        old = list(obj.data.materials)
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for m in old:
            if m and m.users == 0:
                bpy.data.materials.remove(m)
    flat = trees["bark_cell_uv"]("flat", 0.5, 0.5)
    uv = core.data.uv_layers.new(name="UVMap")
    for item in uv.data:
        item.uv = flat
    return core, needles


def fir_sprig_uv(conifer, region):
    """conifer_crown.py's ``sprig_uv`` on this atlas: the sprig's box in its cell, with the sprig's own aspect."""
    index = conifer["SPRIGS"].index(region)
    left, top, right, bottom = region
    x, y, w, h = sprig_box(conifer, index)
    width, height = NEEDLE_ATLAS
    return (x / width, y / height, (x + w) / width, (y + h) / height), (right - left) / (bottom - top)


# -------------------------------------------------------------------------------------------------------------- build


def build(piece, lod_level, collection, inputs):
    """Build one piece at one level into ``collection``; return its objects (bark first) and observations."""
    spec = PIECES[piece]
    trees = runpy.run_path(inputs["trees"])
    conifer = runpy.run_path(inputs["conifer"])
    trees["build_crown"].__globals__["leaf_cell_uvs"] = tuft_cell_uvs
    rng = random.Random(spec["seed"])
    branches = trees["skeleton"](spec, rng)
    if spec.get("wind"):
        windswept(spec, branches, rng)
    crown = spec["crown"]
    tufted = bool(crown) and "tiers" not in crown
    clumps = trees["crown_clumps"](spec, branches, rng) if tufted else []
    bury = trees["BURY"]
    if clumps:
        top = max(c.z + r * 1.05 for c, r, _t in clumps) + crown["card"] * 0.3
    else:
        top = max(p.z for b in branches for p in b["points"])
    clumps = trees["scale_tree"](branches, clumps, (spec["height"] + bury) / (top + bury))
    if spec.get("wind"):
        clumps = shear(branches, clumps, spec["wind"], spec["height"])
    bark_mat = trees["bark_material"](bark_atlas(trees, inputs["bark"]), BARK_MATERIAL)
    observations = {"recipe": RECIPE, "piece": piece, "level": lod_level, "seed": spec["seed"], "branches": len(branches)}
    collision = trees["collision_mesh"](branches) if lod_level == 0 else None
    barked = split_trunk(spec, branches)
    bark_rng = random.Random(spec["seed"] + 1)
    if lod_level == 0:
        bark = bark_mesh(trees, barked, 1.0, 1.0, 0.0, 99, bark_rng)
    elif not crown:
        p = BARE_LODS[lod_level]
        bark = bark_mesh(trees, barked, p["sides"], p["rings"], p["minRadius"], 99, bark_rng)
    elif lod_level == 1:
        bark = bark_mesh(trees, barked, LOD1["sides"], LOD1["rings"], LOD1["minRadius"], 99, bark_rng)
    else:
        bark = bark_mesh(trees, barked, LOD2["sides"], 0.5, 0.0, LOD2["maxLevel"], bark_rng)
    bark.materials.append(bark_mat)
    bark_obj = bpy.data.objects.new(piece, bark)
    collection.objects.link(bark_obj)
    objects = [bark_obj]
    if crown:
        needle_image = needle_atlas(conifer, inputs["needles"], inputs["needleAlpha"])
        needle_mat = trees["leaf_material"](needle_image)
        needle_mat.name = NEEDLE_MATERIAL
        if tufted:
            core, leaves = trees["build_crown"](spec, clumps, random.Random(spec["seed"] + 2), collection, bark_mat, needle_mat)
        else:
            core, leaves = fir_crown(conifer, trees, spec, branches[0], collection, bark_mat, needle_mat, needle_image, spec["seed"] + 2)
        observations.update(coreTriangles=trees["triangles"](core), cardsBefore=len(leaves.data.polygons))
        if lod_level == 0:
            objects += [core, leaves]
        else:
            lod = runpy.run_path(inputs["lod"])
            cards = lod["read_cards"](leaves)
            if lod_level == 1:
                keep_rng = random.Random(spec["seed"] + 3)
                kept = [card for card in cards if keep_rng.random() < LOD1["keep"]]
                lod["write_cards"](leaves, kept, LOD1["grow"] / math.sqrt(LOD1["keep"]))
                observations["cardsAfter"] = len(kept)
                objects += [core, leaves]
            else:
                grey = lod["card_grey"](leaves)
                if tufted:
                    p = dict(LOD2["hull"], hullTriangles=crown.get("hull", LOD2["hull"]["hullTriangles"]))
                    shell = lod["inflated_core"](cards, core, p, collection)
                else:
                    p = LOD2["envelope"]
                    shell = lod["envelope"](cards, core, p, collection)
                    flat = trees["bark_cell_uv"]("flat", 0.5, 0.5)
                    uv = shell.data.uv_layers.new(name="UVMap")
                    for item in uv.data:
                        item.uv = flat
                lod["colour_hull"](shell, cards, core, p, grey)
                observations["hullTriangles"] = trees["triangles"](shell)
                # Bark wholly inside the shell is never seen.
                bm = bmesh.new()
                bm.from_mesh(shell.data)
                bvh = BVHTree.FromBMesh(bm)
                bm.free()
                bm = bmesh.new()
                bm.from_mesh(bark)
                hidden = [f for f in bm.faces if all(lod["inside"](bvh, v.co) for v in f.verts)]
                bmesh.ops.delete(bm, geom=hidden, context="FACES")
                bm.to_mesh(bark)
                bm.free()
                for gone in (leaves, core):
                    bpy.data.objects.remove(gone)
                objects.append(shell)
    observations["barkTriangles"] = trees["triangles"](bark_obj)
    if collision:
        observations["collisionMesh"] = collision
    return objects, observations


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    piece, lod_level = arguments["piece"], arguments["level"]
    objects, observations = build(piece, lod_level, bpy.context.scene.collection, inputs)
    result = objects[0]
    if len(objects) > 1:
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = result
        with bpy.context.temp_override(active_object=result, selected_editable_objects=objects):
            bpy.ops.object.join()
    result.name = piece
    colours = result.data.color_attributes
    colours.active_color = colours["Col"]
    colours.render_color_index = colours.active_color_index
    result.data.calc_loop_triangles()
    observations["triangles"] = len(result.data.loop_triangles)
    bpy.ops.object.select_all(action="DESELECT")
    result.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False, export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return observations
