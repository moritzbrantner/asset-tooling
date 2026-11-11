"""Greyhaven deadwood for mmorpg (docs/greyhaven-deadwood.md, #573): fallen logs, stumps, an upturned root plate and
branches for the floor of the Greyhaven woods and wetland edges, made to lie under ``greyhaven-trees`` and
``greyhaven-pines``.

The recipe reuses its siblings rather than copying them. The declared inputs are:

* ``trees``: ``greyhaven_trees.py``. Its furrowed cell (the oak's bark), tileable noise, branch growth and colour
  helpers;
* ``pines``: ``greyhaven_pines.py``. Its flaky Scots pine cell and silver deadwood cell;
* ``moss``: ``moss.py``. Its scan grading (the ``mossy_rock`` scan divided by its mean and multiplied by mmorpg's moss
  palette, with the dark cracks painted out) and hollow-to-crown colours, so the moss matches the ``moss`` kit;
* ``bark``: the catalogued CC0 Quaternius ``Bark_NormalTree`` image (the trees' furrowed cell);
* ``mossColour``: the catalogued CC0 Poly Haven ``mossy_rock`` colour map;
* ``soil``: the catalogued CC0 Poly Haven ``forrest_ground_01`` colour map, for the root plate's earth.

Everything sits on one opaque atlas of eight cells (``CELLS``), coloured in the texture; ``COLOR_0`` only shades it:
dark where wood meets the ground and on undersides. The bark cells carry the moss: a log's tube is mapped so the top of
the log is the middle of its cell, and the moss grows along that middle with a ragged, wandering edge from several
tileable noise fields, feathered into speckles. A stump's cell has moss creeping down from its broken top.

``level`` picks the level of detail, built in the same frame from the same seed: ``1`` halves the sides and rings and
drops the stubs and twigs (stumps keep thinner roots; the root plate half its roots); ``2`` thins them again, drops
every root and keeps only the larger branches. Each level has at most half the triangles of the one before.

The arguments are ``piece`` and ``level``. Blender coordinates are Z up; the GLB is exported +Y up. Everything is
seeded (``random.Random`` and ``numpy.random.RandomState``).
"""
import math
import random
import runpy

import bpy
import numpy
from mathutils import Vector

RECIPE = "greyhaven-deadwood-v1"
MATERIAL = "Greyhaven_Deadwood"
ATLAS = (2048, 1024)  # 4 x 2 cells of 512 px
CELL = 512
GUTTER = 16  # pixels around each cell, filled with the cell's own wrapped content
CELLS = ("oak-log", "pine-log", "deadwood", "end-grain", "oak-stump", "pine-stump", "rotten", "soil")
INPUTS = {"trees", "pines", "moss", "bark", "mossColour", "soil"}

# Colours (sRGB). The oak bark is greyhaven-trees' oak tint; the pine's is between the Scots pine's lower and upper bark.
OAK_BARK = "#6f655a"
PINE_BARK = "#82604a"
DEADWOOD = "#a39c92"
HEARTWOOD = "#6e5f4e"  # end grain
SAPWOOD = "#80725f"
ROTTEN = "#4e3829"
SOIL = "#55443a"
SCAN_TILE = 0.59  # metres per repeat of the moss scan (moss.py)
SOIL_TILE = 1.3  # metres per repeat of the soil scan
STUMP_ASPECT = 0.45  # a stump cell's height over its width, in metres of bark
FLAKY_CONTRAST = 0.5  # share of the Scots pine plates' contrast a fallen pine keeps

# Moss on a bark cell: half-width of the band round the top (share of the circumference) and how far its edge wanders.
MOSS = {
    "oak-log": {"band": 0.15, "wander": 0.11, "ragged": 0.06, "seed": 11},
    "pine-log": {"band": 0.11, "wander": 0.1, "ragged": 0.06, "seed": 12},
    "deadwood": {"band": 0.035, "wander": 0.09, "ragged": 0.05, "seed": 13},
}
# Moss creeping down a stump from its top: reach (share of the height) and wander.
STUMP_MOSS = {"oak-stump": {"reach": 0.3, "wander": 0.22, "seed": 14}, "pine-stump": {"reach": 0.22, "wander": 0.22, "seed": 15}}
PINE_STUMP_BARK = "#6a5d52"  # the Scots pine's furrowed lower trunk (greyhaven-pines)
GROUND_DARK = (0.42, 0.55)  # COLOR_0 at the ground, and the height (m) by which it reaches 1
UNDERSIDE = 0.35  # how much darker a face looking straight down is
TONE = 0.8  # COLOR_0 at its brightest: the standing trees' bark at log height (greyhaven-trees darkens its foot the same way)

# Per piece. Logs lie along X with their footprint centre at the origin; ``length`` (m), ``radius`` (m, at the thick
# end), ``taper`` (tip radius share), ``bend`` (m of sideways bow), ``sides``, ``ring`` (m between rings), ``stubs``
# (branch stubs), ``bark`` cell, ``strip`` (share of the length from the tip that has lost its bark), ``hollow`` (inner
# radius share). Stumps stand on the origin: ``height`` (m), ``radius``, ``roots``, ``repeats`` (bark repeats round
# the stump). The root plate's disc stands in the YZ plane with the fallen trunk's stub towards +X.
PIECES = {
    "log-oak": {"kind": "log", "seed": 5731, "length": 4.6, "radius": 0.34, "taper": 0.72, "bend": 0.16, "sides": 16, "ring": 0.22,
                "stubs": 3, "bark": "oak-log", "strip": 0.0, "lump": 0.05},
    "log-pine": {"kind": "log", "seed": 5732, "length": 6.0, "radius": 0.25, "taper": 0.6, "bend": 0.08, "sides": 14, "ring": 0.26,
                 "stubs": 6, "bark": "pine-log", "strip": 0.32, "lump": 0.03},
    "log-hollow": {"kind": "log", "seed": 5733, "length": 3.4, "radius": 0.46, "taper": 0.9, "bend": 0.1, "sides": 18, "ring": 0.24,
                   "stubs": 1, "bark": "oak-log", "strip": 0.0, "lump": 0.06, "hollow": 0.68},
    "stump-oak": {"kind": "stump", "seed": 5734, "height": 0.55, "radius": 0.42, "sides": 18, "rings": 7, "roots": 5, "bark": "oak-stump", "repeats": 2, "jag": 0.5},
    "stump-pine": {"kind": "stump", "seed": 5735, "height": 0.75, "radius": 0.27, "sides": 14, "rings": 8, "roots": 4, "bark": "pine-stump", "repeats": 1, "jag": 0.9},
    "root-plate": {"kind": "plate", "seed": 5736, "width": 2.7, "height": 2.3, "thick": 0.32, "bury": 0.25, "sectors": 20, "bands": 4, "roots": 20,
                   "trunk": {"radius": 0.36, "length": 1.1}},
    "branch-pile": {"kind": "pile", "seed": 5737, "count": 21, "spread": (0.95, 0.7), "heap": 0.95, "length": (0.9, 2.3), "radius": (0.022, 0.06), "twigs": 2, "tone": 0.62},
    "branches-scatter": {"kind": "scatter", "seed": 5738, "count": 11, "spread": (1.5, 1.0), "length": (0.5, 1.7), "radius": (0.014, 0.04), "twigs": 2, "tone": 0.62},
}
LODS = {0: {"sides": 1.0, "rings": 1.0, "stubs": True, "roots": 1.0}, 1: {"sides": 0.5, "rings": 0.5, "stubs": False, "roots": 0.5},
        2: {"sides": 0.3, "rings": 0.25, "stubs": False, "roots": 0.0}}
COLLISION_SIDES = 8
COLLISION_RINGS = 5


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "piece", "level"} or p["schemaVersion"] != 1:
        raise ValueError("greyhaven deadwood requires exactly schemaVersion 1, piece and level")
    if p["piece"] not in PIECES or p["level"] not in (0, 1, 2):
        raise ValueError(f"greyhaven deadwood: piece in {sorted(PIECES)}, level 0, 1 or 2")
    if set(inputs) != INPUTS:
        raise ValueError(f"greyhaven deadwood takes exactly the declared inputs {', '.join(sorted(INPUTS))}")


# ----------------------------------------------------------------------------------------------------------- textures


def to_linear(c):
    return numpy.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = numpy.clip(c, 0, 1)
    return numpy.where(c <= 0.0031308, c * 12.92, 1.055 * numpy.maximum(c, 1e-6) ** (1 / 2.4) - 0.055)


def smooth(lo, hi, x):
    t = numpy.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def seamless(a):
    """Make a 2D (or 2D x channels) array tile by cross-fading it with its half-shifted copy."""
    h, w = a.shape[:2]
    wy = 1 - numpy.abs(numpy.arange(h) / h * 2 - 1)
    wx = 1 - numpy.abs(numpy.arange(w) / w * 2 - 1)
    weight = numpy.minimum(wy[:, None], wx[None, :])
    weight = smooth(0.0, 0.5, weight)
    if a.ndim == 3:
        weight = weight[:, :, None]
    shifted = numpy.roll(numpy.roll(a, h // 2, 0), w // 2, 1)
    return a * weight + shifted * (1 - weight)


def tiled(texture, n, repeats_x, repeats_y, offset=(0.0, 0.0)):
    """Sample a tileable texture into an ``n`` x ``n`` cell, ``repeats`` whole times across each axis (nearest)."""
    side_y, side_x = texture.shape[:2]
    ys = ((numpy.arange(n) + 0.5) / n * repeats_y + offset[1]) * side_y
    xs = ((numpy.arange(n) + 0.5) / n * repeats_x + offset[0]) * side_x
    return texture[(ys.astype(int) % side_y)[:, None], (xs.astype(int) % side_x)[None, :]]


def moss_scan(moss, path):
    """The moss scan, graded as moss.py grades it and made tileable: linear RGB, mean 1 relative to the palette."""
    small, mean = moss["scan"](path)
    target = moss["palette_linear"]()
    weights = numpy.array([0.2126, 0.7152, 0.0722])
    rgb = small * (target / mean)
    floor = float(target @ weights) * moss["CRACK_FLOOR"]
    rgb = rgb * numpy.maximum(1.0, floor / numpy.maximum(rgb @ weights, 1e-5))[..., None]
    return seamless(rgb)


def soil_scan(path, shrink=8):
    """The forest-ground scan averaged down, tileable, in linear light divided by its mean."""
    image = bpy.data.images.load(path, check_existing=False)
    width, height = image.size
    data = numpy.empty(width * height * 4, dtype=numpy.float32)
    image.pixels.foreach_get(data)
    bpy.data.images.remove(image)
    rgb = to_linear(data.reshape(height, width, 4)[:, :, :3].astype(numpy.float64))
    side = min(width, height) // shrink
    small = rgb[:side * shrink, :side * shrink].reshape(side, shrink, side, shrink, 3).mean(axis=(1, 3))
    return seamless(small / small.reshape(-1, 3).mean(axis=0))


def hex_linear(trees, value):
    return numpy.array(trees["lin"](value))


def grey_linear(grey):
    """A greyscale bark cell (stored as sRGB values, as greyhaven-trees stores it) in linear light."""
    return to_linear(numpy.clip(grey, 0, 1))[:, :, None]


def moss_colour(moss, scan, n, metres, depth, offset):
    """Moss texels for a cell spanning ``metres``: the scan with hollow-to-crown shading by ``depth`` (0 edge, 1 deep)."""
    repeats = max(1, round(metres / SCAN_TILE))
    texel = tiled(scan, n, repeats, repeats, offset)
    hollow, crown = numpy.array(moss["HOLLOW"]), numpy.array(moss["CROWN"])
    return texel * (hollow + (crown - hollow) * depth[..., None])


def moss_cover(trees, n, rng, base, wander, ragged):
    """Positive where moss grows: ``base`` (an n x n field, positive inside) plus a wandering edge and ragged fringe."""
    broad = trees["periodic_noise"](n, (110, 110), rng) - 0.5
    mid = trees["periodic_noise"](n, (26, 26), rng) - 0.5
    fine = trees["periodic_noise"](n, (6, 6), rng) - 0.5
    return base + wander * 2 * broad + ragged * 2 * mid + 0.04 * 2 * fine


def mossed(trees, moss, scan, wood, cover, n, metres, offset, rng):
    """Lay moss over ``wood`` (linear RGB) where ``cover`` is positive, feathered into speckles at its edge."""
    speckle = trees["periodic_noise"](n, (2.5, 2.5), rng)
    rim = smooth(0.0, 0.07, cover)
    solid = rim * 2.4 > speckle + 0.05
    depth = smooth(0.0, 0.2, cover)
    green = moss_colour(moss, scan, n, metres, depth, offset)
    # Wood just outside the moss is a little darker and greener, where it stays damp.
    damp = smooth(-0.08, 0.0, cover)[..., None]
    wood = wood * (1 - 0.25 * damp) + damp * 0.06 * green
    return numpy.where(solid[..., None], green, wood)


def bark_with_band(trees, moss, scan, grey, tint, name, n, rng):
    """A log's bark: ``u`` (columns) runs round the log with the top at 0.5, ``v`` (rows) along it."""
    cfg = MOSS[name]
    wood = grey_linear(grey) * tint
    u = (numpy.arange(n) + 0.5) / n
    base = numpy.broadcast_to(cfg["band"] - numpy.abs(u - 0.5)[None, :], (n, n))
    cover = moss_cover(trees, n, rng, base, cfg["wander"], cfg["ragged"])
    return mossed(trees, moss, scan, wood, cover, n, 2.0, (0.13 * cfg["seed"], 0.29 * cfg["seed"]), rng)


def stump_bark(trees, moss, scan, grey, tint, name, n, rng):
    """A stump's bark: ``u`` round the stump, ``v`` from below the ground (0) to its broken top (1), moss from the top."""
    cfg = STUMP_MOSS[name]
    rows = numpy.clip(((numpy.arange(n) + 0.5) / n * STUMP_ASPECT * grey.shape[0]).astype(int), 0, grey.shape[0] - 1)
    wood = grey_linear(grey[rows]) * tint
    v = (numpy.arange(n) + 0.5) / n
    base = numpy.broadcast_to((v - (1 - cfg["reach"]))[:, None], (n, n)).copy()
    # Moss favours one side of the stump (the damp north side).
    u = (numpy.arange(n) + 0.5) / n
    base = base + 0.28 * numpy.cos((u - 0.25) * math.tau)[None, :] - 0.08
    cover = moss_cover(trees, n, rng, base, cfg["wander"], 0.07)
    return mossed(trees, moss, scan, wood, cover, n, 1.6, (0.2 * cfg["seed"], 0.37 * cfg["seed"]), rng)


def end_grain(trees, moss, scan, n, rng):
    """A cut through the trunk, centred in the cell: growth rings, radial checks, a dark heart and the bark rim."""
    yy, xx = (numpy.mgrid[0:n, 0:n] + 0.5) / n * 2 - 1
    r = numpy.hypot(xx, yy) / 0.96
    a = numpy.arctan2(yy, xx)
    wobble = (trees["periodic_noise"](n, (30, 30), rng) - 0.5) * 0.08
    rr = r + wobble
    rings = 0.5 + 0.5 * numpy.cos(rr * 34 * math.pi)
    fine = trees["periodic_noise"](n, (3, 3), rng)
    heart, sap = hex_linear(trees, HEARTWOOD), hex_linear(trees, SAPWOOD)
    wood = heart + (sap - heart) * smooth(0.35, 0.8, rr)[..., None]
    wood = wood * (0.82 + 0.12 * rings[..., None] + 0.1 * (fine[..., None] - 0.5))
    wood = wood * (0.55 + 0.45 * smooth(0.0, 0.25, rr))[..., None]  # the rotted, darker heart
    checks = numpy.zeros((n, n))
    for _ in range(9):
        angle = rng.uniform(-math.pi, math.pi)
        width = rng.uniform(0.015, 0.035)
        reach = rng.uniform(0.35, 0.85)
        da = numpy.abs((a - angle + math.pi) % math.tau - math.pi)
        checks = numpy.maximum(checks, (da < width * (1.2 - rr)) & (rr > 1 - reach))
    wood = wood * (1 - 0.6 * checks[..., None])
    bark = hex_linear(trees, OAK_BARK) * 0.6 * (0.8 + 0.4 * fine[..., None])
    wood = numpy.where((rr > 0.93)[..., None], bark, wood)
    # Weathered grey towards the outside, and ragged moss creeping in from part of the rim.
    wood = wood * (1 - 0.15 * smooth(0.6, 0.95, rr))[..., None] + 0.03 * smooth(0.6, 0.95, rr)[..., None]
    base = (rr - 0.9) * 0.9 + 0.06 * numpy.cos(a - 1.2) - 0.03
    cover = moss_cover(trees, n, rng, base, 0.05, 0.05)
    return mossed(trees, moss, scan, wood, cover, n, 0.9, (0.4, 0.8), rng)


def rotten_cell(trees, n, rng):
    """Punky rotten wood for hollow insides and roots: fibres along v, soft light and dark blotches."""
    fibres = trees["periodic_noise"](n, (1.5, 50), rng)
    blotch = trees["periodic_noise"](n, (40, 40), rng)
    fine = trees["periodic_noise"](n, (3, 3), rng)
    grey = 0.85 + 0.3 * (fibres - 0.5) + 0.35 * (blotch - 0.5) + 0.12 * (fine - 0.5)
    return numpy.clip(grey, 0.2, 1.4)[..., None] * hex_linear(trees, ROTTEN)


def soil_cell(trees, moss, scan, soil, n, rng):
    """The root plate's earth, planar over the plate: ``v`` 1 is the old ground surface, its moss and humus on top."""
    earth = tiled(soil, n, round(2.7 / SOIL_TILE), round(2.3 / SOIL_TILE))
    grey = earth @ numpy.array([0.2126, 0.7152, 0.0722])
    earth = (grey[..., None] * 0.8 + earth * 0.2) * hex_linear(trees, SOIL)  # the scan's leaf colours mostly out
    v = (numpy.arange(n) + 0.5) / n
    # Darker, damper earth low down; a band of black humus under the old surface.
    earth = earth * (0.7 + 0.3 * v)[:, None, None]
    humus = trees["periodic_noise"](n, (60, 6), rng) - 0.5
    band = smooth(0.06, 0.0, numpy.abs(v[:, None] - 0.83 - 0.04 * humus))
    earth = earth * (1 - 0.45 * band[..., None])
    stones = trees["periodic_noise"](n, (5, 5), rng)
    earth = numpy.where((stones > 0.8)[..., None], earth * 1.6 + 0.02, earth)
    base = numpy.broadcast_to((v - 0.87)[:, None], (n, n))
    cover = moss_cover(trees, n, rng, base, 0.05, 0.04)
    return mossed(trees, moss, scan, earth, cover, n, 2.7, (0.7, 0.1), rng)


def paint_atlas(trees, pines, moss, inputs):
    """The atlas as float RGBA rows from the bottom (Blender's order), each cell wrapped into its gutter."""
    inner = CELL - 2 * GUTTER
    rng = numpy.random.RandomState(5730)
    scan = moss_scan(moss, inputs["mossColour"])
    soil = soil_scan(inputs["soil"])
    furrowed = trees["furrowed_cell"](inputs["bark"], inner)
    flaky = pines["flaky_cell"](trees, inner, rng)
    flaky = 0.72 + (flaky - 0.72) * FLAKY_CONTRAST  # weathered: the plates' rims soften once the tree is down
    silver = pines["deadwood_cell"](trees, inner, rng)
    oak, pine, grey = hex_linear(trees, OAK_BARK), hex_linear(trees, PINE_BARK), hex_linear(trees, DEADWOOD)
    cells = {
        "oak-log": bark_with_band(trees, moss, scan, furrowed, oak, "oak-log", inner, rng),
        "pine-log": bark_with_band(trees, moss, scan, flaky, pine, "pine-log", inner, rng),
        "deadwood": bark_with_band(trees, moss, scan, silver, grey, "deadwood", inner, rng),
        "end-grain": end_grain(trees, moss, scan, inner, rng),
        "oak-stump": stump_bark(trees, moss, scan, furrowed, oak, "oak-stump", inner, rng),
        "pine-stump": stump_bark(trees, moss, scan, furrowed, hex_linear(trees, PINE_STUMP_BARK), "pine-stump", inner, rng),
        "rotten": rotten_cell(trees, inner, rng),
        "soil": soil_cell(trees, moss, scan, soil, inner, rng),
    }
    width, height = ATLAS
    pixels = numpy.ones((height, width, 4), dtype=numpy.float32)
    for index, name in enumerate(CELLS):
        row, col = divmod(index, 4)
        tile = numpy.pad(to_srgb(cells[name]), ((GUTTER, GUTTER), (GUTTER, GUTTER), (0, 0)), mode="wrap")
        pixels[row * CELL:(row + 1) * CELL, col * CELL:(col + 1) * CELL, :3] = tile
    return pixels


def atlas_image(trees, pines, moss, inputs):
    width, height = ATLAS
    image = bpy.data.images.new("greyhaven-deadwood", width, height, alpha=False)
    image.pixels.foreach_set(paint_atlas(trees, pines, moss, inputs).ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def cell_uv(cell, u, v):
    """Map ``u``, ``v`` in 0..1 into the named cell, inside its gutter."""
    row, col = divmod(CELLS.index(cell), 4)
    width, height = ATLAS
    inner = CELL - 2 * GUTTER
    return ((col * CELL + GUTTER + u * inner) / width, (row * CELL + GUTTER + v * inner) / height)


# ------------------------------------------------------------------------------------------------------------- meshes


class Buffers:
    """Vertices, faces and per-corner UVs; ``COLOR_0`` is shaded from the positions and normals at the end."""

    def __init__(self):
        self.verts, self.faces, self.uvs = [], [], []

    def add(self, point):
        self.verts.append(Vector(point))
        return len(self.verts) - 1

    def face(self, indices, uvs):
        self.faces.append(tuple(indices))
        self.uvs.append(list(uvs))


def frames(pts, fallback=Vector((1, 0, 0))):
    """Per point: direction, ``n1`` (pointing down, so angle pi is the top) and ``n2``."""
    out = []
    up = Vector((0, 0, 1))
    for i in range(len(pts)):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        down = -(up - d * up.dot(d))
        if down.length < 0.2:
            down = fallback - d * fallback.dot(d)
        down.normalize()
        out.append((d, down, d.cross(down)))
    return out


def lying_tube(buf, pts, radii, sides, cell, rng, *, lump=0.0, inward=False, caps=(None, None), cap_cell="end-grain", strip=None, v_range=None):
    """A tube along ``pts`` with its texture's middle on top; ``caps`` is ``'broken'``, ``'flat'`` or None per end.

    The texture repeats every ``max(circumference, 0.6)`` metres along the tube; faces never cross a repeat."""
    fr = frames(pts)
    circumference = math.tau * max(radii)
    span = max(circumference, 0.6)
    u_span = min(1.0, circumference / span)
    s_of = [0.0]
    for i in range(1, len(pts)):
        s_of.append(s_of[-1] + (pts[i] - pts[i - 1]).length)
    bumps = [[1.0 + lump * rng.uniform(-1, 1) for _ in range(sides)] for _ in pts]
    rings = []
    for p, r, (d, n1, n2), bump in zip(pts, radii, fr, bumps):
        ring = []
        for k in range(sides):
            a = math.tau * k / sides
            ring.append(buf.add(p + (n1 * math.cos(a) + n2 * math.sin(a)) * r * bump[k]))
        rings.append(ring)
    total = s_of[-1]
    for i in range(len(rings) - 1):
        v_a, v_b = s_of[i] / span, s_of[i + 1] / span
        base = math.floor(v_a + 1e-6)
        v0, v1 = v_a - base, v_b - base
        if v1 > 1.0:
            v0, v1 = max(0.0, 1.0 - (v_b - v_a)), 1.0
        if v_range is not None:
            # A short stub on a stump cell: its length within ``v_range``, below the stump cell's moss.
            v0, v1 = (v_range[0] + (v_range[1] - v_range[0]) * s_of[j] / total for j in (i, i + 1))
        seg_cell = cell
        if strip is not None and (s_of[i] + s_of[i + 1]) / 2 > total * (1 - strip[0]):
            seg_cell = strip[1]
        for k in range(sides):
            k2 = (k + 1) % sides
            u0, u1 = k / sides * u_span, (k + 1) / sides * u_span
            face = (rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k])
            uvs = [cell_uv(seg_cell, u0, v0), cell_uv(seg_cell, u1, v0), cell_uv(seg_cell, u1, v1), cell_uv(seg_cell, u0, v1)]
            if inward:
                face, uvs = face[::-1], uvs[::-1]
            buf.face(face, uvs)
    for end, kind in ((0, caps[0]), (len(pts) - 1, caps[1])):
        if kind:
            cap(buf, rings[end], pts[end], radii[end], fr[end][0] * (1 if end else -1), kind, sides, rng, cap_cell)
    return rings


def cap(buf, ring, centre, radius, outward, kind, sides, rng, cell):
    """Close a tube end with its own vertices (so it shades apart from the side), a jagged break or a flat face."""
    copies = []
    for k, index in enumerate(ring):
        point = buf.verts[index].copy()
        if kind == "broken":
            point += outward * radius * rng.uniform(-0.08, 0.3)
            buf.verts[index] = point.copy()
        copies.append(buf.add(point))
    lift = radius * (rng.uniform(0.05, 0.3) if kind == "broken" else 0.0)
    middle = buf.add(centre + outward * lift)
    a0 = rng.uniform(0, math.tau)
    for k in range(sides):
        k2 = (k + 1) % sides
        a, b = math.tau * k / sides + a0, math.tau * (k + 1) / sides + a0
        uv = [cell_uv(cell, 0.5 + 0.47 * math.cos(a), 0.5 + 0.47 * math.sin(a)), cell_uv(cell, 0.5 + 0.47 * math.cos(b), 0.5 + 0.47 * math.sin(b)), cell_uv(cell, 0.5, 0.5)]
        tri = (copies[k], copies[k2], middle)
        # Wind it to face ``outward``.
        n = (buf.verts[tri[1]] - buf.verts[tri[0]]).cross(buf.verts[tri[2]] - buf.verts[tri[0]])
        if n.dot(outward) < 0:
            tri, uv = tri[::-1], uv[::-1]
        buf.face(tri, uv)


def bowed_line(start, end, segs, bend, rng, lift=0.0):
    """Points from ``start`` to ``end`` bowing sideways by ``bend`` metres, with a little wander."""
    d = end - start
    side = Vector((-d.y, d.x, 0)).normalized() if Vector((d.x, d.y)).length > 1e-4 else Vector((1, 0, 0))
    phase = rng.uniform(0.3, 0.7)
    points = []
    for i in range(segs + 1):
        t = i / segs
        bow = math.sin(math.pi * t) * bend * (1 if phase > 0.5 else -1)
        wander = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)) * bend * 0.12 if 0 < i < segs else Vector()
        points.append(start + d * t + side * bow + wander + Vector((0, 0, lift * math.sin(math.pi * t))))
    return points


def stub_branches(buf, spec, pts, radii, rng, sides):
    """Short snapped branch stubs on the upper half of a log."""
    count = spec["stubs"]
    for _ in range(count):
        i = rng.randint(1, len(pts) - 3)
        d = (pts[i + 1] - pts[i]).normalized()
        a = rng.uniform(math.pi * 0.55, math.pi * 1.45)  # round the top half (pi is the top)
        _, n1, n2 = frames(pts)[i]
        out = (n1 * math.cos(a) + n2 * math.sin(a)).normalized()
        direction = (out + d * rng.uniform(0.2, 0.7)).normalized()
        r0 = radii[i] * rng.uniform(0.22, 0.35)
        start = pts[i] + out * radii[i] * 0.6
        length = r0 * rng.uniform(2.0, 4.5) + radii[i] * 0.4
        stub = [start + direction * length * t for t in (0.0, 0.5, 1.0)]
        lying_tube(buf, stub, [r0 * 1.2, r0 * 0.85, r0 * 0.7], max(3, sides), spec["bark"].replace("log", "stump"), rng, caps=(None, "broken"), v_range=(0.05, 0.4))


def build_log(buf, spec, share, rng):
    length, radius = spec["length"], spec["radius"]
    rings = max(3, round(length / spec["ring"] * share["rings"]))
    sides = max(5, round(spec["sides"] * share["sides"]))
    start, end = Vector((-length / 2, 0, 0)), Vector((length / 2, 0, 0))
    pts = bowed_line(start, end, rings, spec["bend"], rng)
    radii = []
    for p in pts:
        t = (p.x + length / 2) / length
        radii.append(radius * (1 - (1 - spec["taper"]) * t) * (1 + 0.04 * math.sin(t * 17 + spec["seed"])))
    # Rest on the ground: each ring sinks a little into it.
    for p, r in zip(pts, radii):
        p.z = r * 0.88
    strip = (spec["strip"], "deadwood") if spec["strip"] else None
    hollow = spec.get("hollow")
    lying_tube(buf, pts, radii, sides, spec["bark"], rng, lump=spec["lump"] * share["sides"], strip=strip,
               caps=(None, None) if hollow else ("broken", "broken"))
    if hollow:
        inner = [r * hollow for r in radii]
        inner_pts = [p + Vector((0, 0, -r * 0.08)) for p, r in zip(pts, radii)]
        lying_tube(buf, inner_pts, inner, sides, "rotten", rng, lump=0.08, inward=True)
        rims(buf, pts, radii, inner_pts, inner, sides)
    if share["stubs"]:
        stub_branches(buf, spec, pts, radii, rng, round(6 * share["sides"]))
    return pts, radii


def rims(buf, pts, radii, inner_pts, inner, sides):
    """The hollow log's two open ends: a broken ring of end grain between the bark and the rotten inside."""
    for end, sign in ((0, -1), (len(pts) - 1, 1)):
        fr = frames(pts)[end]
        d, n1, n2 = fr
        outer_ring, inner_ring = [], []
        for k in range(sides):
            a = math.tau * k / sides
            jag = (0.5 + 0.5 * math.sin(k * 2.7 + end)) * 0.12 * radii[end]
            outer_ring.append(buf.add(pts[end] + (n1 * math.cos(a) + n2 * math.sin(a)) * radii[end] + d * sign * jag))
            inner_ring.append(buf.add(inner_pts[end] + (n1 * math.cos(a) + n2 * math.sin(a)) * inner[end] + d * sign * jag * 0.4))
        for k in range(sides):
            k2 = (k + 1) % sides
            a, b = math.tau * k / sides, math.tau * (k + 1) / sides
            face = [outer_ring[k], outer_ring[k2], inner_ring[k2], inner_ring[k]]
            uvs = [cell_uv("end-grain", 0.5 + 0.47 * math.cos(a), 0.5 + 0.47 * math.sin(a)), cell_uv("end-grain", 0.5 + 0.47 * math.cos(b), 0.5 + 0.47 * math.sin(b)),
                   cell_uv("end-grain", 0.5 + 0.33 * math.cos(b), 0.5 + 0.33 * math.sin(b)), cell_uv("end-grain", 0.5 + 0.33 * math.cos(a), 0.5 + 0.33 * math.sin(a))]
            n = (buf.verts[face[1]] - buf.verts[face[0]]).cross(buf.verts[face[3]] - buf.verts[face[0]])
            if n.dot(d * sign) < 0:
                face, uvs = face[::-1], uvs[::-1]
            buf.face(face, uvs)


BURY = 0.25  # metres of stump and root plate below the ground


def build_stump(buf, spec, share, rng):
    """An upright stump with a lobed root flare buried below the ground and a jagged, splintered break on top."""
    height, radius = spec["height"], spec["radius"]
    sides = max(6, round(spec["sides"] * share["sides"]))
    sides -= sides % spec["repeats"]
    rings = max(3, round(spec["rings"] * share["rings"]))
    per = sides // spec["repeats"]
    lean = Vector((rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04), 0))
    jag = [rng.uniform(0, 1) ** 2 for _ in range(sides)]
    for spike in rng.sample(range(sides), 2):
        jag[spike] = 1.0
        for near in (spike - 1, (spike + 1) % sides):
            jag[near] = max(jag[near], rng.uniform(0.4, 0.65))
    grid = []
    for i in range(rings + 1):
        t = i / rings
        z = -BURY + (height + BURY) * t
        ring = []
        for k in range(sides):
            a = math.tau * k / sides
            fade = max(0.0, 1.0 - (z + BURY) / (0.45 + BURY))
            r = radius * (1 + 0.6 * fade ** 2 * (0.7 + 0.3 * math.cos(spec["roots"] * a + 0.4))) * (1 + 0.04 * rng.uniform(-1, 1))
            top = z + (jag[k] * spec["jag"] * radius if i == rings else 0.0)
            ring.append(buf.add(Vector((math.cos(a) * r, math.sin(a) * r, top)) + lean * (z + BURY)))
        grid.append(ring)
    top_z = height + spec["jag"] * radius
    for i in range(rings):
        for k in range(sides):
            k2 = (k + 1) % sides
            u0, u1 = (k % per) / per, (k % per + 1) / per
            za, zb = [(buf.verts[grid[j][k]].z + BURY) / (top_z + BURY) for j in (i, i + 1)]
            zc, zd = [(buf.verts[grid[j][k2]].z + BURY) / (top_z + BURY) for j in (i, i + 1)]
            buf.face((grid[i][k], grid[i][k2], grid[i + 1][k2], grid[i + 1][k]),
                     [cell_uv(spec["bark"], u0, za), cell_uv(spec["bark"], u1, zc), cell_uv(spec["bark"], u1, zd), cell_uv(spec["bark"], u0, zb)])
    # The broken top: an inner ring of splinters, then the low centre where the wood tore.
    centre = Vector((0, 0, height)) + lean * (height + BURY)
    cap(buf, grid[-1], centre, radius, Vector((0, 0, 1)), "flat", sides, rng, "end-grain")
    if share["roots"]:
        roots(buf, spec, rng, sides)
    return grid


def roots(buf, spec, rng, sides):
    """Root tubes running out from the flare and down into the ground."""
    radius = spec["radius"]
    for j in range(spec["roots"]):
        a = math.tau * j / spec["roots"] + 0.4 / spec["roots"] + rng.uniform(-0.1, 0.1)
        out = Vector((math.cos(a), math.sin(a), 0))
        length = radius * rng.uniform(1.1, 1.8)
        r0 = radius * rng.uniform(0.3, 0.38)
        side = Vector((-out.y, out.x, 0)) * rng.uniform(-0.25, 0.25) * length
        pts = [out * radius * 0.75 + Vector((0, 0, 0.14)), out * (radius + length * 0.4) + side * 0.5 + Vector((0, 0, 0.0)),
               out * (radius + length) + side + Vector((0, 0, -0.16))]
        lying_tube(buf, pts, [r0, r0 * 0.6, r0 * 0.3], max(4, round(6 * sides / spec["sides"])), spec["bark"].replace("stump", "log"), rng)


def build_plate(buf, spec, share, rng):
    """The upturned root plate: a lumpy disc of earth standing in the YZ plane, roots snapped off round its rim, and
    the stub of the fallen trunk leaving towards +X."""
    width, height, thick, bury = spec["width"], spec["height"], spec["thick"], spec["bury"]
    sectors = max(8, round(spec["sectors"] * share["sides"]))
    bands = max(2, round(spec["bands"] * share["rings"] * 2) // 2)
    cy, cz = 0.0, height / 2 - bury
    rim = [1 + 0.12 * math.sin(3 * math.tau * k / sectors + 1) + 0.08 * rng.uniform(-1, 1) for k in range(sectors)]

    def point(face_sign, band, k):
        a = math.tau * k / sectors
        t = band / bands
        jitter = 1 + (0.1 * rng.uniform(-1, 1) if 0 < band < bands else 0.0)
        ry, rz = width / 2 * rim[k] * t * jitter, height / 2 * rim[k] * t * jitter
        y, z = cy + math.cos(a) * ry, cz + math.sin(a) * rz
        bulge = thick * (0.5 + 0.5 * (1 - t ** 2)) * (1 + 0.25 * rng.uniform(-1, 1))
        return Vector((face_sign * bulge, y, max(-bury, z)))

    def uv(p):
        return cell_uv("soil", min(1, max(0, (p.y + width / 2) / width)), min(1, max(0, (p.z + bury) / height)))

    rims_ = {}
    for face_sign in (-1, 1):
        centre = buf.add(point(face_sign, 0, 0))
        grid = [[buf.add(point(face_sign, b, k)) for k in range(sectors)] for b in range(1, bands + 1)]
        rims_[face_sign] = grid[-1]
        for k in range(sectors):
            k2 = (k + 1) % sectors
            tri = [centre, grid[0][k], grid[0][k2]]
            if face_sign > 0:
                tri = tri[::-1]
            buf.face(tri, [uv(buf.verts[i]) for i in tri])
            for b in range(bands - 1):
                quad = [grid[b][k], grid[b + 1][k], grid[b + 1][k2], grid[b][k2]]
                if face_sign > 0:
                    quad = quad[::-1]
                buf.face(quad, [uv(buf.verts[i]) for i in quad])
    # The rim joins the two faces; the earth there is torn and ragged. The soil cell tiles across, so the rim runs
    # along ``u`` by its own length, every face kept inside one repeat.
    along = 0.0
    for k in range(sectors):
        k2 = (k + 1) % sectors
        quad = [rims_[-1][k2], rims_[1][k2], rims_[1][k], rims_[-1][k]]
        step = (buf.verts[rims_[1][k2]] - buf.verts[rims_[1][k]]).length / width
        u0 = along - math.floor(along)
        u1 = u0 + step
        if u1 > 1.0:
            u0, u1 = 1.0 - step, 1.0
        along += step

        def rim_uv(index, u):
            p = buf.verts[index]
            return cell_uv("soil", u, min(1, max(0, (p.z + bury) / height + p.x / height * 0.6)))
        buf.face(quad, [rim_uv(quad[0], u1), rim_uv(quad[1], u1), rim_uv(quad[2], u0), rim_uv(quad[3], u0)])
    # Roots: half sunk into either face, running out from near the middle, curving, past the rim where they snapped
    # and droop. Faraway levels keep the thickest.
    root_sides = max(3, round(5 * share["sides"]))
    segs = max(2, round(5 * share["rings"]))
    count = round(spec["roots"] * share["roots"])
    made = 0
    for j in range(spec["roots"]):
        a = math.tau * (j + rng.uniform(-0.35, 0.35)) / spec["roots"]
        face_sign = 1 if j % 3 == 0 else -1
        r0 = rng.uniform(0.035, 0.085) * (1.3 if j < count // 2 else 1.0)
        reach = rng.uniform(1.0, 1.3)
        curl = rng.uniform(-0.5, 0.5)
        start_t = rng.uniform(0.15, 0.4)
        if made >= count or math.sin(a) * height / 2 * reach + cz < 0.1:
            continue
        made += 1
        pts, radii = [], []
        for i in range(segs + 1):
            t = start_t + (reach - start_t) * i / segs
            aa = a + curl * (t - start_t)
            y, z = cy + math.cos(aa) * width / 2 * t, cz + math.sin(aa) * height / 2 * t
            beyond = max(0.0, t - 0.95)
            bulge = thick * (0.5 + 0.5 * (1 - min(t, 1.0) ** 2))
            pts.append(Vector((face_sign * (bulge + r0 * 0.1 - beyond * 0.6), y, z - beyond * 1.4)))
            radii.append(r0 * (1 - 0.7 * i / segs))
        lying_tube(buf, pts, radii, root_sides, "rotten", rng, caps=(None, "broken"))
    # The trunk's stub: from inside the plate out towards +X, snapped where the trunk tore away.
    trunk = spec["trunk"]
    rings = max(2, round(4 * share["rings"]))
    stub = [Vector((thick * 0.2 + trunk["length"] * i / rings, 0, cz - 0.15 - 0.15 * i / rings)) for i in range(rings + 1)]
    radii = [trunk["radius"] * (1.25 - 0.25 * i / rings) for i in range(rings + 1)]
    lying_tube(buf, stub, radii, max(6, round(14 * share["sides"])), "oak-log", rng, caps=(None, "broken"))
    return (cy, cz, rim, sectors)


def build_branches(buf, spec, share, rng, level):
    """A pile (heaped, crossing) or a scatter (flat on the ground) of fallen branches with forked twigs."""
    pile = spec["kind"] == "pile"
    items = []
    for _ in range(spec["count"]):
        length = rng.uniform(*spec["length"])
        radius = rng.uniform(*spec["radius"])
        sx, sy = spec["spread"]
        angle = rng.uniform(0, math.pi)
        cx, cy = rng.uniform(-sx, sx) * 0.7, rng.uniform(-sy, sy) * 0.7
        items.append((length, radius, angle, cx, cy, rng.random(), rng.random(), [rng.random() for _ in range(8)]))
    # Thick branches first: they lie at the bottom of the pile.
    items.sort(key=lambda item: -item[1])
    if level == 2:
        items = items[:max(3, len(items) * 2 // 5)]
    for n, (length, radius, angle, cx, cy, tilt, pick, r) in enumerate(items):
        local = random.Random(int(r[0] * 1e6))
        d = Vector((math.cos(angle), math.sin(angle), 0))
        centre = Vector((cx, cy, 0))
        if pile:
            # Higher in the middle of the heap and for later (thinner) branches; each tilts across it.
            rise = spec["heap"] * (1 - min(1.0, centre.length / max(spec["spread"]))) * (0.3 + 0.7 * n / len(items))
            a = centre - d * length / 2 + Vector((0, 0, rise * (0.4 + 0.6 * tilt)))
            b = centre + d * length / 2 + Vector((0, 0, rise * (1.2 - 0.6 * tilt)))
            a.z, b.z = max(a.z, radius), max(b.z, radius)
        else:
            a, b = centre - d * length / 2 + Vector((0, 0, radius)), centre + d * length / 2 + Vector((0, 0, radius))
        segs = max(1, round(4 * share["rings"]))
        pts = bowed_line(a, b, segs, length * 0.09, local)
        radii = [radius * (1 - 0.5 * i / segs) for i in range(segs + 1)]
        sides = max(3, round(6 * share["sides"]))
        cell = "deadwood" if pick < 0.35 else "oak-log"
        lying_tube(buf, pts, radii, sides, cell, local, caps=("broken", None) if level == 0 else (None, None))
        if share["stubs"]:
            for t in range(spec["twigs"]):
                i = local.randint(1, max(1, segs - 1))
                side = Vector((-d.y, d.x, 0)) * (1 if t % 2 else -1)
                fork = (d * local.uniform(0.6, 1.0) + side * local.uniform(0.5, 0.9) + Vector((0, 0, 0.15 if pile else 0.0))).normalized()
                tl = length * local.uniform(0.25, 0.45)
                start = pts[i]
                end = start + fork * tl
                if not pile:
                    end.z = radii[i] * 0.5
                lying_tube(buf, [start, start.lerp(end, 0.5), end], [radii[i] * 0.55, radii[i] * 0.4, radii[i] * 0.2], 3, cell, local)


# ------------------------------------------------------------------------------------------------------------ collision


def tube_collision(centres, radii):
    """A closed, outward-wound 8-sided tube through ``centres`` (Blender axes) as glTF vertices and triangles."""
    verts, tris = [], []
    for c, (d, n1, n2), r in zip(centres, frames(centres, Vector((0, 1, 0))), radii):
        for k in range(COLLISION_SIDES):
            a = math.tau * k / COLLISION_SIDES
            verts.append(c + (n1 * math.cos(a) + n2 * math.sin(a)) * r)
    for i in range(len(centres) - 1):
        for k in range(COLLISION_SIDES):
            a, b = i * COLLISION_SIDES + k, i * COLLISION_SIDES + (k + 1) % COLLISION_SIDES
            c, d = a + COLLISION_SIDES, b + COLLISION_SIDES
            tris += [[a, b, d], [a, d, c]]
    first, last = len(verts), len(verts) + 1
    verts += [centres[0].copy(), centres[-1].copy()]
    end = (len(centres) - 1) * COLLISION_SIDES
    for k in range(COLLISION_SIDES):
        k2 = (k + 1) % COLLISION_SIDES
        tris += [[first, k2, k], [last, end + k, end + k2]]
    return verts, tris


def oriented(verts, tris):
    """Flip every triangle if the closed mesh encloses negative volume (so it winds outward)."""
    volume = sum(verts[a].dot(verts[b].cross(verts[c])) for a, b, c in tris)
    return tris if volume > 0 else [[a, c, b] for a, b, c in tris]


def gltf_mesh(parts):
    verts, tris = [], []
    for v, t in parts:
        t = oriented(v, t)
        base = len(verts)
        verts += v
        tris += [[a + base, b + base, c + base] for a, b, c in t]
    return {"shape": "triangle-mesh", "vertices": [[round(p.x, 3), round(p.z, 3), round(-p.y, 3)] for p in verts], "triangles": tris}


def sample(points, values, count):
    """``count`` evenly spaced samples along a polyline (by index) and its per-point values."""
    out_p, out_v = [], []
    for i in range(count):
        t = i / (count - 1) * (len(points) - 1)
        j = min(int(t), len(points) - 2)
        f = t - j
        out_p.append(points[j].lerp(points[j + 1], f))
        out_v.append(values[j] + (values[j + 1] - values[j]) * f)
    return out_p, out_v


def collision_for(spec, shape):
    kind = spec["kind"]
    if kind == "log":
        pts, radii = shape
        centres, rr = sample(pts, radii, COLLISION_RINGS)
        # A little inside the bark, and flattened onto the ground at the bottom.
        return gltf_mesh([tube_collision(centres, [r * 0.95 for r in rr])])
    if kind == "stump":
        height, radius = spec["height"], spec["radius"]
        centres = [Vector((0, 0, -BURY)), Vector((0, 0, 0.1)), Vector((0, 0, height))]
        return gltf_mesh([tube_collision(centres, [radius * 1.35, radius * 1.15, radius * 0.98])])
    if kind == "plate":
        cy, cz, rim, sectors = shape
        width, height, thick, bury = spec["width"], spec["height"], spec["thick"], spec["bury"]
        ring = []
        for k in range(COLLISION_SIDES):
            a = math.tau * k / COLLISION_SIDES
            j = round(k * sectors / COLLISION_SIDES) % sectors
            ring.append((cy + math.cos(a) * width / 2 * rim[j] * 0.92, max(-bury, cz + math.sin(a) * height / 2 * rim[j] * 0.92)))
        verts = [Vector((x, y, z)) for x in (-thick * 0.75, thick * 0.75) for y, z in ring]
        n = COLLISION_SIDES
        tris = []
        for k in range(n):
            k2 = (k + 1) % n
            tris += [[k, k2, n + k2], [k, n + k2, n + k]]
        for k in range(1, n - 1):
            tris += [[0, k + 1, k], [n, n + k, n + k + 1]]
        trunk = spec["trunk"]
        stub = tube_collision([Vector((0.0, 0, cz - 0.15)), Vector((thick * 0.2 + trunk["length"], 0, cz - 0.3))], [trunk["radius"] * 1.2, trunk["radius"]])
        return gltf_mesh([(verts, tris), stub])
    return None


# -------------------------------------------------------------------------------------------------------------- build


def shade(mesh, tone=1.0):
    """``COLOR_0``: dark where the wood meets the ground and on undersides; greyscale, so the atlas keeps its colour."""
    col = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    lo, reach = GROUND_DARK
    for poly in mesh.polygons:
        under = max(0.0, -poly.normal.z)
        for li in poly.loop_indices:
            z = mesh.vertices[mesh.loops[li].vertex_index].co.z
            g = lo + (1 - lo) * min(1.0, max(0.0, z / reach)) ** 0.8
            g *= tone * (1 - UNDERSIDE * under)
            col.data[li].color = (g, g, g, 1.0)
    return col


def material(image):
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
    bsdf.inputs["Roughness"].default_value = 0.93
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.use_backface_culling = True
    return mat


def triangles(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def build(piece, lod_level, collection, inputs, mat=None):
    """Build one piece at one level into ``collection``; return its object and observations."""
    spec = PIECES[piece]
    share = LODS[lod_level]
    rng = random.Random(spec["seed"])
    buf = Buffers()
    kind = spec["kind"]
    if kind == "log":
        shape = build_log(buf, spec, share, rng)
    elif kind == "stump":
        shape = build_stump(buf, spec, share, rng)
    elif kind == "plate":
        shape = build_plate(buf, spec, share, rng)
    else:
        shape = build_branches(buf, spec, share, rng, lod_level)
    mesh = bpy.data.meshes.new(piece)
    mesh.from_pydata([tuple(v) for v in buf.verts], [], buf.faces)
    mesh.validate(clean_customdata=False)
    uv = mesh.uv_layers.new(name="UVMap")
    for poly, fuv in zip(mesh.polygons, buf.uvs):
        poly.use_smooth = True
        for li, puv in zip(poly.loop_indices, fuv):
            uv.data[li].uv = puv
    shade(mesh, spec.get("tone", TONE))
    if mat is None:
        trees, pines, moss = (runpy.run_path(inputs[name]) for name in ("trees", "pines", "moss"))
        mat = material(atlas_image(trees, pines, moss, inputs))
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(piece, mesh)
    collection.objects.link(obj)
    observations = {"recipe": RECIPE, "piece": piece, "level": lod_level, "seed": spec["seed"], "triangles": triangles(obj)}
    if lod_level == 0:
        collision = collision_for(spec, shape)
        if collision:
            observations["collisionMesh"] = collision
    return obj, observations


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    obj, observations = build(arguments["piece"], arguments["level"], bpy.context.scene.collection, inputs)
    colours = obj.data.color_attributes
    colours.active_color = colours["Col"]
    colours.render_color_index = colours.active_color_index
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False, export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return observations
