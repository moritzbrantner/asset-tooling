"""Wooden spike traps (docs/spike-traps.md): hand-cut stakes in six static pieces on one procedural wood atlas.

Every stake reads the same way along its length: bark, an axe-hewn taper, then a fire-hardened tip. The pieces are
``stake-cluster``, ``stake-row`` (a 2 m module along X, its spikes towards +Z), ``cheval`` (a log carrying crossed
double-pointed stakes), ``pit-bed`` (a 2 x 2 m bed of upright stakes), ``spike-board`` (a low studded plank) and
``swing-log`` (hung on two ropes from its ``pivot`` node).

Nothing here is gameplay: damage, triggers and placement belong to the game. ``arguments`` are ``piece`` and ``level``
(0 is full detail, 1 and 2 are ``lod1`` and ``lod2`` in the same frame and on the same atlas). All variation is a SHA-256
of fixed keys, the same at every level; the textures come from numpy's legacy ``RandomState``, through the declared
input ``common`` (``kit_common.py``). Authored in glTF axes: metres, +Y up, origin on the ground at the footprint centre.

``build(piece, collection, level, location, yaw)`` also works in a live Blender after ``use_common(runpy.run_path(...))``.
"""
import math

import bpy
import numpy as np
from mathutils import Vector

RECIPE = "spike-traps-v1"
PIECES = ("stake-cluster", "stake-row", "cheval", "pit-bed", "spike-board", "swing-log")
MATERIAL = "spike-wood"
BURY = 0.18  # how far a stake's foot runs below y = 0, for uneven ground

# Sides around a section at levels 0, 1 and 2.
SIDES = {"stake": (7, 5, 3), "peg": (5, 3, 3), "log": (10, 6, 4), "pole": (7, 4, 3), "rope": (5, 3, 3), "lash": (8, 0, 0)}

# Atlas cells, as pixels x, y (from the top left), width and height, with a gutter between them.
ATLAS_EDGE = 2048
GUTTER = 8
STAKE_CELLS = 6
CELLS = {
    **{f"stake-{i}": (8 + i * 208, 8, 192, 1008) for i in range(STAKE_CELLS)},
    "plank": (1256, 8, 784, 256),
    "end-bark": (1256, 280, 240, 240),
    "end-pale": (1512, 280, 240, 240),
    "lash": (1768, 280, 128, 128),
    "rope": (8, 1032, 2032, 32),
    "log-bark": (8, 1080, 2032, 240),
    "log-peeled": (8, 1336, 2032, 240),
}
LOG_CELL_LENGTH = 4.0  # metres of log or rope along a cell's width

# Where a stake cell changes, as a share of its height: bark, then hewn wood, then the charred tip.
BARK_END = 0.56
CHAR_START = 0.89
# sRGB colours.
BARK_DARK, BARK_LIGHT = np.array((0.13, 0.10, 0.07)), np.array((0.43, 0.35, 0.26))
HEWN_DARK, HEWN_LIGHT = np.array((0.38, 0.28, 0.18)), np.array((0.62, 0.49, 0.33))
CHAR_DARK, CHAR_LIGHT = np.array((0.06, 0.05, 0.045)), np.array((0.27, 0.22, 0.18))
PLANK_DARK, PLANK_LIGHT = np.array((0.27, 0.20, 0.14)), np.array((0.52, 0.41, 0.29))
PEELED_DARK, PEELED_LIGHT = np.array((0.35, 0.27, 0.18)), np.array((0.60, 0.48, 0.33))
HEMP_DARK, HEMP_LIGHT = np.array((0.27, 0.21, 0.13)), np.array((0.66, 0.56, 0.38))

C = {}


def use_common(namespace):
    """Bind the shared helpers from ``kit_common.py``."""
    C.clear()
    C.update({name: namespace[name] for name in namespace["NAMES"]})


def between(lo, hi, *keys):
    return lo + (hi - lo) * C["rnd"]("spike-traps", *keys)


# ---------------------------------------------------------------- atlas

def smoothstep(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a[None, None] * (1 - t[..., None]) + b[None, None] * t[..., None]


def sheet(seed, base, octaves, stretch, w, h):
    """Tileable fractal noise resampled to ``w`` x ``h``; it still tiles along both axes."""
    tile = C["fbm"](1024, base, octaves, seed, tuple(max(s, 1.01 / base) for s in stretch))  # at least one cell along each axis
    return tile[np.ix_((np.arange(h) * 1024 // h) % 1024, (np.arange(w) * 1024 // w) % 1024)]


def furrows(seed, w, h, stretch):
    """Bark: long ridges with dark furrows between them, in [0, 1]."""
    f = sheet(seed, 7, 4, stretch, w, h)
    return np.clip(np.abs(f - 0.5) * 4.2, 0, 1) ** 0.75


def paint_stake(index, w, h):
    v = np.broadcast_to((1 - (np.arange(h)[:, None] + 0.5) / h), (h, w))
    seed = 7100 + index * 10
    tint = 0.9 + 0.2 * np.random.RandomState(seed).rand()
    ragged = sheet(seed + 1, 8, 3, (1, 1), w, h) - 0.5
    ridges = furrows(seed + 2, w, h, (1, 0.3))
    mottle = sheet(seed + 3, 4, 4, (1, 0.8), w, h)
    streak = sheet(seed + 4, 12, 3, (1, 0.06), w, h)
    crackle = sheet(seed + 5, 26, 3, (1, 1), w, h)
    cracks = smoothstep(0.7, 0.78, sheet(seed + 6, 30, 2, (0.3, 2.0), w, h))  # short lenticels across the grain
    # Each axe stroke ends in its own tongue, one per side of a section at full detail.
    tongue = np.abs(np.sin(((np.arange(w) + 0.5) / w) * math.pi * SIDES["stake"][0]))[None, :]

    bark = mix(BARK_DARK, BARK_LIGHT, np.clip(ridges * 0.7 + (mottle - 0.5) * 1.4, 0, 1)) * tint
    bark *= (1 - 0.3 * cracks[..., None])
    hewn = mix(HEWN_DARK, HEWN_LIGHT, np.clip((streak - 0.32) * 2.6, 0, 1))
    char = mix(CHAR_DARK, CHAR_LIGHT, smoothstep(0.55, 0.8, crackle))
    to_hewn = smoothstep(BARK_END - 0.008, BARK_END + 0.008, v + ragged * 0.13 + tongue * 0.09 - 0.045)
    # Scorching climbs unevenly: the hewn wood browns before it blackens.
    scorch = smoothstep(CHAR_START - 0.2, CHAR_START + 0.04, v + ragged * 0.14)
    to_char = smoothstep(CHAR_START - 0.02, CHAR_START + 0.06, v + ragged * 0.16)
    colour = bark * (1 - to_hewn[..., None]) + hewn * to_hewn[..., None]
    colour *= (1 - 0.6 * scorch[..., None] * to_hewn[..., None])
    colour = colour * (1 - to_char[..., None]) + char * to_char[..., None]
    colour *= (0.5 + 0.5 * smoothstep(0.04, 0.2, v + ragged * 0.07))[..., None]  # earth stain at the foot

    height = (ridges * 1.0 + mottle * 0.3 - cracks * 0.5) * (1 - to_hewn) + (streak * 0.25 + 1.1) * to_hewn
    height = height * (1 - to_char) + (crackle * 0.5 + 0.9) * to_char
    rough = (0.92 - 0.04 * mottle) * (1 - to_hewn) + 0.78 * to_hewn
    rough = rough * (1 - to_char) + (0.62 + 0.3 * crackle) * to_char
    return colour, height, rough, 7.0


def paint_log(seed, w, h, peeled):
    ridges = furrows(seed, w, h, (0.08, 1))
    mottle = sheet(seed + 1, 4, 4, (0.4, 1), w, h)
    streak = sheet(seed + 2, 10, 3, (0.05, 1), w, h)
    knots = smoothstep(0.78, 0.9, sheet(seed + 3, 7, 2, (0.35, 1), w, h))
    if peeled:
        colour = mix(PEELED_DARK, PEELED_LIGHT, np.clip((streak - 0.3) * 2.2 + (mottle - 0.5) * 0.5, 0, 1))
        patches = smoothstep(0.55, 0.62, mottle)[..., None]  # strips of bark left on the pole
        colour = colour * (1 - patches) + mix(BARK_DARK, BARK_LIGHT, ridges) * patches
        height = streak * 0.3 + patches[..., 0] * (ridges * 0.7 + 0.4)
        return colour, height, 0.8 + 0.1 * patches[..., 0], 5.0
    colour = mix(BARK_DARK, BARK_LIGHT, np.clip(ridges * 0.85 + (mottle - 0.5) * 0.8, 0, 1))
    colour *= (1 - 0.25 * knots[..., None])
    return colour, ridges * 1.1 + mottle * 0.5 - knots * 0.3, 0.93 - 0.05 * mottle, 8.0


def paint_plank(w, h):
    streak = sheet(7301, 14, 4, (0.06, 1), w, h)
    mottle = sheet(7302, 4, 3, (0.5, 1), w, h)
    colour = mix(PLANK_DARK, PLANK_LIGHT, np.clip((streak - 0.3) * 2.2 + (mottle - 0.5) * 0.6, 0, 1))
    return colour, streak * 0.8, 0.86 - 0.08 * mottle, 4.0


def paint_end(seed, w, h, rim, dark, light):
    yy, xx = np.mgrid[0:h, 0:w]
    wobble = sheet(seed, 5, 3, (1, 1), w, h)
    r = np.hypot((xx + 0.5) / w - 0.5, (yy + 0.5) / h - 0.5) * 2 + (wobble - 0.5) * 0.14
    rings = 0.5 + 0.5 * np.sin(r * 46)
    colour = mix(dark, light, rings * 0.6 + 0.3 * wobble)
    edge = smoothstep(rim - 0.05, rim, r)[..., None]
    colour = colour * (1 - edge) + BARK_DARK[None, None] * edge
    return colour, rings * 0.35, 0.88, 2.0


def paint_rope(w, h, period, dark, light):
    """Twisted strands that run along the cell's width."""
    yy, xx = np.mgrid[0:h, 0:w]
    twist = 0.5 + 0.5 * np.sin((xx / period + yy / h) * 2 * math.pi * 3)
    colour = mix(dark, light, np.clip(twist * 0.9 + (sheet(7401, 30, 2, (1, 1), w, h) - 0.5) * 0.5, 0, 1))
    return colour, twist, 0.95, 3.0


def paint_lash(w, h):
    """Rope wound round a joint: turns stacked across the cell's height."""
    yy, xx = np.mgrid[0:h, 0:w]
    turn = 4 * (yy + 0.5) / h
    profile = np.sin(math.pi * (turn % 1)) ** 0.6
    twist = 0.5 + 0.5 * np.sin((xx / w * 18 + turn * 2) * 2 * math.pi)
    colour = mix(HEMP_DARK, HEMP_LIGHT, np.clip(profile * (0.55 + 0.45 * twist), 0, 1))
    return colour, profile + twist * 0.15, 0.95, 5.0


def paint_atlas():
    edge = ATLAS_EDGE
    colour, normal, orm = np.zeros((edge, edge, 3)), np.zeros((edge, edge, 3)), np.ones((edge, edge, 3))
    normal[..., 2] = 1
    normal = normal * 0.5 + 0.5
    orm[..., 2] = 0  # no metal
    painters = {
        **{f"stake-{i}": (lambda w, h, i=i: paint_stake(i, w, h)) for i in range(STAKE_CELLS)},
        "plank": paint_plank,
        "end-bark": lambda w, h: paint_end(7501, w, h, 0.9, HEWN_DARK, HEWN_LIGHT),
        "end-pale": lambda w, h: paint_end(7502, w, h, 0.96, PEELED_DARK, HEWN_LIGHT),
        "lash": paint_lash,
        "rope": lambda w, h: paint_rope(w, h, 24.0, HEMP_DARK, HEMP_LIGHT),
        "log-bark": lambda w, h: paint_log(7601, w, h, False),
        "log-peeled": lambda w, h: paint_log(7611, w, h, True),
    }
    for name, (x, y, w, h) in CELLS.items():
        cell_colour, height, rough, strength = painters[name](w, h)
        cell_normal = C["normal_map"](height, strength * 0.3)
        cell_orm = np.ones((h, w, 3))
        cell_orm[..., 1] = rough
        cell_orm[..., 2] = 0
        for target, pixels in ((colour, cell_colour), (normal, cell_normal), (orm, cell_orm)):
            pad = np.pad(pixels, ((GUTTER, GUTTER), (GUTTER, GUTTER), (0, 0)), mode="edge")
            y0, y1, x0, x1 = max(y - GUTTER, 0), min(y + h + GUTTER, edge), max(x - GUTTER, 0), min(x + w + GUTTER, edge)
            target[y0:y1, x0:x1] = pad[y0 - (y - GUTTER):y1 - (y - GUTTER), x0 - (x - GUTTER):x1 - (x - GUTTER)]
    return np.clip(colour, 0, 1), normal, orm


def atlas_material():
    """The kit's single opaque material; the atlas is painted once per Blender session."""
    existing = bpy.data.materials.get(MATERIAL)
    if existing is not None:
        return existing
    colour, normal, orm = paint_atlas()
    mat = bpy.data.materials.new(MATERIAL)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    def texture(name, pixels, is_colour):
        node = tree.nodes.new("ShaderNodeTexImage")
        node.image = C["make_image"](name, pixels, is_colour)
        return node
    tree.links.new(texture("spike-wood-colour", colour, True).outputs["Color"], bsdf.inputs["Base Color"])
    normal_node = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(texture("spike-wood-normal", normal, False).outputs["Color"], normal_node.inputs["Color"])
    tree.links.new(normal_node.outputs["Normal"], bsdf.inputs["Normal"])
    separate = tree.nodes.new("ShaderNodeSeparateColor")
    tree.links.new(texture("spike-wood-orm", orm, False).outputs["Color"], separate.inputs["Color"])
    tree.links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    tree.links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    return mat


def cell_uv(cell, u, v):
    """A cell-local (u, v), with v = 1 at the cell's top edge, as an atlas coordinate."""
    x, y, w, h = CELLS[cell]
    return ((x + u * w) / ATLAS_EDGE, 1 - (y + (1 - v) * h) / ATLAS_EDGE)


# ---------------------------------------------------------------- mesh

class Part:
    """One piece's mesh at one level, gathered in glTF axes."""

    def __init__(self, piece, level):
        self.piece, self.level = piece, level
        self.points, self.faces, self.uvs, self.smooth = [], [], [], []

    def sides(self, kind):
        return SIDES[kind][self.level]

    def vertex(self, point):
        self.points.append(tuple(point))
        return len(self.points) - 1

    def face(self, indices, uvs, smooth):
        self.faces.append(list(indices))
        self.uvs.extend(uvs)
        self.smooth.append(smooth)

    def tube(self, centres, radii, sides, uv, smooth=lambda k: True, start_cap=None, end_cap=None, apex=None, apex_uv=None, scale=None):
        """Rings round a polyline, each given a radius. ``uv(k, s)`` is the atlas coordinate of ring k, side s; ``s`` runs to
        ``sides`` so a section's seam stays continuous. ``apex`` closes the end in a point; caps name an end-grain cell."""
        count = len(centres)
        tangents = [(centres[min(k + 1, count - 1)] - centres[max(k - 1, 0)]).normalized() for k in range(count)]
        hint = Vector((0, 1, 0)) if abs(tangents[0].y) < 0.9 else Vector((1, 0, 0))
        across = (hint - tangents[0] * hint.dot(tangents[0])).normalized()
        rings = []
        for k in range(count):
            across = (across - tangents[k] * across.dot(tangents[k])).normalized()
            side = tangents[k].cross(across)
            rings.append([])
            for s in range(sides):
                a = 2 * math.pi * s / sides
                factor = scale(k, s) if scale else 1.0
                rings[k].append(self.vertex(centres[k] + (across * math.cos(a) + side * math.sin(a)) * radii[k] * factor))
        for k in range(count - 1):
            for s in range(sides):
                n = (s + 1) % sides
                self.face([rings[k][s], rings[k][n], rings[k + 1][n], rings[k + 1][s]],
                          [uv(k, s), uv(k, s + 1), uv(k + 1, s + 1), uv(k + 1, s)], smooth(k))
        if apex is not None:
            k = count - 1
            for s in range(sides):
                top = self.vertex(apex)
                self.face([rings[k][s], rings[k][(s + 1) % sides], top], [uv(k, s), uv(k, s + 1), apex_uv(s)], False)
        disc = lambda cell, s: cell_uv(cell, 0.5 + 0.48 * math.cos(2 * math.pi * s / sides), 0.5 + 0.48 * math.sin(2 * math.pi * s / sides))
        if start_cap:
            self.face(list(reversed(rings[0])), [disc(start_cap, s) for s in reversed(range(sides))], False)
        if end_cap:
            self.face(rings[-1], [disc(end_cap, s) for s in range(sides)], False)

    def stake(self, base, tip, radius, hew, key, kind="stake", bend=0.07):
        """A cut stake from ``base`` to ``tip``: a bent shaft in bark with a lopped branch stub, then a faceted, charred point ``hew`` metres long."""
        base, tip = Vector(base), Vector(tip)
        length = (tip - base).length
        th = 1 - min(hew, 0.8 * length) / length
        cell = f"stake-{int(between(0, STAKE_CELLS, key, 'cell'))}"
        rings = {0: [0, th / 3, 2 * th / 3, th, th + (1 - th) / 2], 1: [0, th, th + (1 - th) / 2], 2: [0, th]}[self.level]
        direction = (tip - base).normalized()
        off = Vector((1, 0, 0)) if abs(direction.x) < 0.9 else Vector((0, 0, 1))
        turn = between(0, math.tau, key, "bend-dir")
        sideways = (off.cross(direction) * math.cos(turn) + direction.cross(off.cross(direction)) * math.sin(turn)).normalized()
        amount = bend * length * between(0.4, 1.0, key, "bend")
        at = lambda t: base + (tip - base) * t + sideways * amount * 4 * t * (1 - t)
        centres = [at(t) for t in rings]
        radii = [radius * (1 - 0.16 * min(t, th) / th) * (1 if t <= th else 0.6) for t in rings]
        def v(k):
            t = rings[k]
            return BARK_END * t / th if t <= th else BARK_END + (1 - BARK_END) * (t - th) / (1 - th)
        uv = lambda k, s: cell_uv(cell, s / len_sides, v(k))
        len_sides = self.sides(kind)
        def scale(k, s):
            # Bark is nearly round; each axe stroke leaves its own facet in the taper.
            spread = 0.3 if rings[k] > th else 0.08
            return 1 + between(-spread, spread, key, "section", s, 0 if rings[k] > th else k)
        self.tube(centres, radii, len_sides, uv, smooth=lambda k: rings[k + 1] <= th, scale=scale,
                  apex=at(1.0) + sideways * radius * between(-0.35, 0.35, key, "apex"), apex_uv=lambda s: cell_uv(cell, (s + 0.5) / len_sides, 1.0))
        if self.level == 0 and kind == "stake" and length > 0.6:
            t = between(0.2, 0.7, key, "stub") * th
            out = (sideways * math.cos(1.1) + direction * math.sin(1.1)).normalized()
            stub = at(t) + out * radius * 0.7
            self.tube([stub, stub + out * radius * between(1.0, 1.7, key, "stub-l")], [radius * 0.42, radius * 0.34], 4,
                      lambda k, s: cell_uv(cell, s / 4, BARK_END * 0.3), start_cap=None, end_cap="end-pale")

    def peg(self, base, tip, radius, key):
        if self.level == 2:
            base, tip = Vector(base), Vector(tip)
            cell = "stake-0"
            first = [self.vertex(base + Vector((radius * math.cos(a), 0, radius * math.sin(a)))) for a in (0, 2.1, 4.2)]
            for s in range(3):
                top = self.vertex(tip)
                self.face([first[(s + 1) % 3], first[s], top], [cell_uv(cell, 0, CHAR_START), cell_uv(cell, 0.3, CHAR_START), cell_uv(cell, 0.15, 1.0)], False)
            return
        self.stake(base, tip, radius, 0.1, key, kind="peg", bend=0.0)

    def pole(self, a, c, radius, key, cell="log-peeled", kind="pole", end="end-pale", segments=1):
        a, c = Vector(a), Vector(c)
        length = (c - a).length
        share = length / LOG_CELL_LENGTH
        start = between(0, 1 - share, key, "start")
        sides = self.sides(kind)
        rings = [i / segments for i in range(segments + 1)]
        self.tube([a + (c - a) * t for t in rings], [radius] * (segments + 1), sides,
                  lambda k, s: cell_uv(cell, start + rings[k] * share, 1 - s / sides),
                  start_cap=end, end_cap=end, scale=lambda k, s: 1 + between(-0.06, 0.06, key, k, s))

    def rope(self, a, c, radius, key):
        a, c = Vector(a), Vector(c)
        share = (c - a).length / LOG_CELL_LENGTH
        start = between(0, 1 - share, key, "start")
        sides = self.sides("rope")
        self.tube([a, c], [radius, radius], sides, lambda k, s: cell_uv("rope", start + k * share, 1 - s / sides))

    def lash(self, centre, axis, radius, width, key):
        """Rope wound round a joint; only full detail shows it."""
        if self.level:
            return
        axis, centre = Vector(axis).normalized(), Vector(centre)
        sides = self.sides("lash")
        self.tube([centre - axis * width / 2, centre, centre + axis * width / 2], [radius, radius + 0.012, radius], sides,
                  lambda k, s: cell_uv("lash", s / sides, k / 2),
                  scale=lambda k, s: 1 + between(-0.05, 0.05, key, k, s))

    def box(self, lo, hi, cell, grain_u=(1, 0, 0), key=""):
        """A plank; each long face uses its own strip of ``cell``, its grain along ``grain_u`` (X or Z)."""
        (x0, y0, z0), (x1, y1, z1) = lo, hi
        corners = [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), (x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)]
        ids = [self.vertex(p) for p in corners]
        length = max(x1 - x0, z1 - z0)
        share = min(length / 1.6, 1.0)
        u0, v0 = between(0, 1 - share, key, "u"), between(0, 0.72, key, "v")
        def strip(a, b, c, d, band):
            v_lo, v_hi = v0 + band[0], v0 + band[1]
            self.face([ids[a], ids[b], ids[c], ids[d]], [cell_uv(cell, u0, v_lo), cell_uv(cell, u0 + share, v_lo), cell_uv(cell, u0 + share, v_hi), cell_uv(cell, u0, v_hi)], False)
        wide, thin = (0.0, 0.22), (0.22, 0.27)
        strip(3, 2, 6, 7, thin)  # +Z
        strip(1, 0, 4, 5, thin)  # -Z
        if grain_u[0] > 0:
            strip(7, 6, 5, 4, wide)  # top
        else:
            strip(4, 7, 6, 5, wide)
        strip(0, 1, 2, 3, wide)  # bottom
        strip(0, 3, 7, 4, thin)  # -X
        strip(2, 1, 5, 6, thin)  # +X

    def mesh(self, name, collection):
        data = bpy.data.meshes.new(name)
        to_blender = C["to_blender"]
        data.from_pydata([tuple(to_blender(p)) for p in self.points], [], self.faces)
        data.uv_layers.new(name="UVMap")
        data.uv_layers[0].data.foreach_set("uv", np.array(self.uvs, dtype=np.float32).ravel())
        data.polygons.foreach_set("use_smooth", np.array(self.smooth, dtype=bool))
        data.update()
        data.materials.append(atlas_material())
        obj = bpy.data.objects.new(name, data)
        collection.objects.link(obj)
        return obj


# ---------------------------------------------------------------- pieces

def stake_cluster(p):
    """Nine stakes driven in together and tied across two ground poles, leaning out from the middle."""
    p.pole((-0.62, 0.07, 0.1), (0.62, 0.07, -0.1), 0.06, "cluster/pole-a")
    p.pole((-0.1, 0.1, -0.62), (0.1, 0.1, 0.62), 0.055, "cluster/pole-b")
    for i in range(3):
        a = i * 2.09 + 0.5
        x, z = 0.1 * math.cos(a), 0.1 * math.sin(a)
        height = between(1.05, 1.32, "cluster/centre", i)
        p.stake((x, -BURY, z), (x * 1.6, height, z * 1.6), 0.07, 0.3, f"cluster/centre{i}")
    for i in range(6):
        a = i * math.tau / 6 + between(-0.18, 0.18, "cluster/ring-a", i)
        d = between(0.28, 0.36, "cluster/ring-d", i)
        lean = between(0.32, 0.5, "cluster/ring-lean", i)
        x, z = d * math.cos(a), d * math.sin(a)
        height = between(0.62, 0.92, "cluster/ring-h", i)
        p.stake((x, -BURY, z), (x + math.cos(a) * lean * height, height, z + math.sin(a) * lean * height), 0.062, 0.26, f"cluster/ring{i}")
    return {"collisionProxies": [C["proxy"]("cluster", "solid", (-0.72, 0, -0.72), (0.72, 1.15, 0.72))]}


def stake_row(p):
    """A 2 m module along X: stakes leaning to +Z over a waist rail and a ground rail, which end flush so modules line up."""
    p.pole((-1, 0.56, -0.06), (1, 0.56, -0.06), 0.07, "row/rail", segments=2)
    p.pole((-1, 0.07, -0.46), (1, 0.07, -0.46), 0.065, "row/ground", segments=2)
    count = 7
    for i in range(count):
        x = -1 + (i + 0.5) * 2 / count + between(-0.03, 0.03, "row/x", i)
        high = i % 2 == 0
        reach = between(0.62, 0.76, "row/reach", i) if high else between(0.42, 0.56, "row/reach", i)
        height = between(1.42, 1.62, "row/h", i) if high else between(1.08, 1.26, "row/h", i)
        p.stake((x, -BURY, -0.62), (x + between(-0.05, 0.05, "row/tx", i), height, reach), 0.066, 0.32, f"row/stake{i}", bend=0.02)
        p.lash((x, 0.56, -0.06), (1, 0, 0), 0.08, 0.12, f"row/lash{i}")
    return {"module": {"axis": "x", "length": 2.0}, "collisionProxies": [C["proxy"]("row", "solid", (-1, 0, -0.68), (1, 1.3, 0.68))]}


def cheval(p):
    """A cheval-de-frise: a 3 m log carrying five crossed pairs of stakes, pointed at both ends and resting on their low points."""
    y, length = 0.74, 3.0
    p.pole((-length / 2, y, 0), (length / 2, y, 0), 0.115, "cheval/log", cell="log-bark", kind="log", end="end-bark", segments=3)
    for i, x in enumerate((-1.25, -0.625, 0.0, 0.625, 1.25)):
        angle = math.radians(45 + between(-4, 4, "cheval/angle", i))
        for sign, nudge in ((1, -0.045), (-1, 0.045)):
            dz, dy = sign * math.sin(angle), math.cos(angle)
            reach = between(1.02, 1.2, "cheval/up", i, sign)
            below = (y + 0.02) / dy
            sx = x + nudge
            key = f"cheval/{i}/{sign}"
            p.stake((sx, y, 0), (sx, y + dy * reach, dz * reach), 0.062, 0.3, f"{key}/up", bend=0.02)
            p.stake((sx, y, 0), (sx, y - dy * below, -dz * below), 0.062, 0.26, f"{key}/down", bend=0.02)
        p.lash((x, y, 0), (1, 0, 0), 0.125, 0.16, f"cheval/lash{i}")
    return {"collisionProxies": [C["proxy"]("cheval", "solid", (-1.5, 0, -0.78), (1.5, 1.42, 0.78))]}


def pit_bed(p):
    """A 2 x 2 m bed of upright stakes on a pole frame, for the floor of a pit or an open field of spikes."""
    for z, key in ((-0.72, "a"), (0.72, "c")):
        p.pole((-0.92, 0.05, z), (0.92, 0.05, z), 0.05, f"bed/rail-{key}", cell="log-bark", end="end-bark")
    for x, key in ((-0.72, "a"), (0.72, "b")):
        p.pole((x, 0.11, -0.92), (x, 0.11, 0.92), 0.045, f"bed/tie-{key}", cell="log-bark", end="end-bark")
    rows, columns = 4, 5
    for r in range(rows):
        for c in range(columns):
            x = -0.8 + 1.6 * (c + (0.25 if r % 2 else -0.25) + 0.5) / columns + between(-0.04, 0.04, "bed/x", r, c)
            z = -0.78 + 1.56 * (r + 0.5) / rows + between(-0.04, 0.04, "bed/z", r, c)
            height = between(0.7, 1.05, "bed/h", r, c)
            p.stake((x, -BURY, z), (x + between(-0.1, 0.1, "bed/tx", r, c), height, z + between(-0.1, 0.1, "bed/tz", r, c)), 0.058, 0.26, f"bed/stake{r}.{c}", bend=0.03)
    return {"collisionProxies": [C["proxy"]("bed", "solid", (-1, 0, -1), (1, 0.9, 1))]}


def spike_board(p):
    """A low plank studded with pegs driven up through it, to lie under leaves on a path."""
    W, D, t = 1.0, 0.7, 0.036
    y = 0.04
    planks = 3 if p.level < 2 else 1
    for i in range(planks):
        z0 = -D / 2 + i * D / planks
        p.box((-W / 2, y, z0 + 0.003), (W / 2, y + t, z0 + D / planks - 0.003), "plank", key=f"board/plank{i}")
    if p.level < 2:
        for x in (-0.34, 0.34):
            p.box((x - 0.04, 0, -D / 2 - 0.02), (x + 0.04, y, D / 2 + 0.02), "plank", grain_u=(0, 0, 1), key=f"board/cleat{x}")
    for i in range(3):
        for j in range(5):
            x = -0.38 + j * 0.19 + (0.05 if i % 2 else -0.05) + between(-0.015, 0.015, "board/x", i, j)
            z = -0.22 + i * 0.22 + between(-0.015, 0.015, "board/z", i, j)
            top = y + t + between(0.15, 0.22, "board/h", i, j)
            p.peg((x, y + t - 0.01, z), (x + between(-0.025, 0.025, "board/tx", i, j), top, z + between(-0.025, 0.025, "board/tz", i, j)), 0.024, f"board/peg{i}.{j}")
    return {"collision": "none"}


def swing_log(p):
    """A spiked log hung on two ropes in a V from ``pivot``; rotating the piece about X through ``pivot`` swings it along Z."""
    length, radius, y = 1.7, 0.15, 1.05
    pivot = (0.0, 3.6, 0.0)
    p.pole((-length / 2, y, 0), (length / 2, y, 0), radius, "swing/log", cell="log-bark", kind="log", end="end-bark", segments=3)
    for x, key in ((-0.62, "l"), (0.62, "r")):
        p.rope((x, y + radius * 0.9, 0), pivot, 0.02, f"swing/rope-{key}")
        p.lash((x, y, 0), (1, 0, 0), radius + 0.008, 0.1, f"swing/lash-{key}")
    for ring, tilt in enumerate((-32, 0, 32)):
        count = 5 if ring == 1 else 4
        for i in range(count):
            x = -0.62 + 1.24 * (i + 0.5) / count + (0.05 if ring % 2 else -0.05)
            a = math.radians(tilt + between(-5, 5, "swing/a", ring, i))
            direction = Vector((between(-0.08, 0.08, "swing/dx", ring, i), math.sin(a), math.cos(a))).normalized()
            base = Vector((x, y, 0))
            reach = between(0.52, 0.62, "swing/reach", ring, i) + radius
            p.stake(base, base + direction * reach, 0.056, 0.28, f"swing/spike{ring}.{i}", bend=0.0)
    return {"pivot": list(pivot), "collisionProxies": [C["proxy"]("log", "moving", (-length / 2, y - radius, -radius), (length / 2, y + radius, radius + 0.55))]}


BUILDERS = {"stake-cluster": stake_cluster, "stake-row": stake_row, "cheval": cheval, "pit-bed": pit_bed, "spike-board": spike_board, "swing-log": swing_log}


def build(piece, collection, level=0, location=(0, 0, 0), yaw=0.0):
    """One piece as one mesh object at ``location`` (glTF axes), plus its ``pivot`` empty when it has one."""
    part = Part(piece, level)
    info = BUILDERS[piece](part)
    obj = part.mesh(f"spike-traps.{piece}", collection)
    obj.location = C["to_blender"](location)
    obj.rotation_euler = (0, 0, math.radians(yaw))
    if "pivot" in info:
        C["empty"]("pivot", collection, obj, info["pivot"])
    return obj, info


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or set(arguments) != {"schemaVersion", "piece", "level"}:
        raise ValueError("spike-traps arguments must be {schemaVersion: 1, piece, level}")
    if arguments["piece"] not in PIECES:
        raise ValueError(f"spike-traps piece must be one of {', '.join(PIECES)}")
    if arguments["level"] not in (0, 1, 2):
        raise ValueError("spike-traps level must be 0, 1 or 2")
    if set(inputs) != {"common"}:
        raise ValueError("spike-traps recipe takes exactly the input 'common' (kit_common.py)")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_common(inputs.load_source("common"))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    piece, level = arguments["piece"], arguments["level"]
    obj, info = build(piece, bpy.context.scene.collection, level)
    bpy.ops.object.select_all(action="DESELECT")
    for selected in [obj] + list(obj.children_recursive):
        selected.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO",
        export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    triangles = sum(len(polygon.vertices) - 2 for polygon in obj.data.polygons)
    return {"recipe": RECIPE, "piece": piece, "level": level, "unit": "meter", "axes": "right-handed-y-up", "origin": "footprint-base-center",
            "facing": "+Z", "bury": BURY, "triangleCount": triangles, **info}
