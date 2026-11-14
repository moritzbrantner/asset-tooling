"""Shooter arena kit (docs/shooter-arena.md, #593): modular clean-futuristic arena modules on one procedural atlas.

The environment-kit companion of the robot (``combat_robot.py``) and weapon (``shooter_weapons.py``) kits: their palette
and painters (taken as the declared Python input ``robot``), on the environment kits' module and collision conventions.

Every module is built in its glTF frame directly (metres, +Y up, front +Z, right-handed) and converted to Blender's
+Z-up axes once, when its mesh is made. Its **placement box** (the box Shooter's ``Block`` or ``Ramp`` describes) is the
scripts' ``MODULES`` table; no vertex leaves it, so modules placed on the grid meet face to face without gaps or
overlaps. The origin is the centre of the box's base, except for the walking surfaces laid on Shooter's floor plane
(``floor``, ``jump-pad``), whose origin is the centre of their top.

Surfaces are flat-shaded polygons on one atlas. A polygon's texture either **tiles** (its cell covers ``TILE[cell]``
metres; the polygon is clipped at the tile lines, which start at the module box's minimum corner, so neighbouring
modules continue each other) or is **fitted** (its extent fills the cell). Each primitive is a closed convex solid; a
detail (``detail=True``) is left out of ``lod1``.

``arguments`` are ``part`` (``arena.<name>``), ``variant`` (``default``, or ``broken`` for the destructible pieces) and
``level`` (0 full detail, 1 ``lod1``). No randomness: jagged break lines come from SHA-256 of fixed keys and the textures
from numpy's legacy ``RandomState`` through ``kit_common.py``.

In a live Blender: ``use_sources(runpy.run_path("combat_robot.py"), runpy.run_path("kit_common.py"))``, then
``build(part, collection, variant, level, location)``.
"""
import math

import bpy
import numpy as np
from mathutils import Vector

RECIPE = "shooter-arena-v1"
MATERIAL = "arena-metal"

PARTS = (
    "arena.floor", "arena.ceiling", "arena.wall", "arena.wall-half", "arena.wall-tall", "arena.wall-corner", "arena.wall-corner-tall",
    "arena.doorway", "arena.door", "arena.cover-low", "arena.barrier", "arena.crate", "arena.platform", "arena.platform-half",
    "arena.ramp", "arena.ramp-tall", "arena.walkway", "arena.support", "arena.pillar", "arena.jump-pad", "arena.container",
    "arena.generator", "arena.pipes", "arena.hull-deck", "arena.hull-shoulder", "arena.hull-side", "arena.hull-rib", "arena.hull-mast",
)
BROKEN = ("arena.door", "arena.cover-low", "arena.barrier", "arena.crate")

# The atlas: 2048 px in 512 px cells (4 x 4). TILE is how many metres one cell covers on a tiling surface.
ATLAS_EDGE = 2048
CELL_PX = 512
GUTTER = 8
CELLS = {
    "panel": (0, 0), "panel-dark": (1, 0), "deck": (2, 0), "hull": (3, 0),
    "gunmetal": (0, 1), "steel": (1, 1), "hazard": (2, 1), "vent": (3, 1),
    "grate": (0, 2), "glow": (1, 2), "pad": (2, 2), "scorch": (3, 2),
    "crate": (0, 3), "container": (1, 3), "glow-warn": (2, 3), "hull-dark": (3, 3),
}
TILE = {
    "panel": 2.0, "panel-dark": 2.0, "deck": 2.0, "hull": 4.0, "hull-dark": 4.0, "gunmetal": 1.0, "steel": 1.0, "hazard": 1.0,
    "vent": 0.5, "grate": 1.0, "scorch": 0.5, "container": 2.0, "glow": 0.5, "glow-warn": 0.5,
}

# The palette (sRGB): the robot kit's paints (combat_robot.py) plus the arena's own pale wall and hull paints.
PALE = np.array((0.6, 0.615, 0.62))       # wall panels: a cool pale grey, a step lighter than the robot chassis
DECK = np.array((0.25, 0.26, 0.27))       # floors and platform tops
HULL = np.array((0.7, 0.7, 0.67))         # ship hull plating: warm off-white
HULL_DARK = np.array((0.2, 0.21, 0.22))   # the hull's under and inner faces
CONTAINER = np.array((0.36, 0.42, 0.46))  # cargo containers: a muted steel blue
GLOW = (0.25, 0.85, 1.0)                  # the robot kit's lens cyan, the arena's light strips
PAD_GLOW = (0.35, 1.0, 0.75)              # jump pads
WARN = (1.0, 0.55, 0.12)                  # status and warning lights

R = {}  # combat_robot.py's namespace (palette and painters)
C = {}  # kit_common.py's helpers


def use_sources(robot, common):
    R.clear()
    R.update(robot)
    R["use_common"](common)
    C.clear()
    C.update({name: common[name] for name in common["NAMES"]})


# ---------------------------------------------------------------- atlas

def srgb(linear):
    c = np.clip(np.array(linear, dtype=float), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def seams(x, y, count, width=0.006):
    """Recessed panel joints: the cell's own border and ``count`` - 1 lines between, both ways."""
    fx, fy = (x * count) % 1.0, (y * count) % 1.0
    d = np.minimum(np.minimum(fx, 1 - fx), np.minimum(fy, 1 - fy)) / count
    return 1 - R["smoothstep"](width * 0.5, width, d)


def paint_panel(base, seed, rivets=True):
    def painter(n):
        x, y = R["grid"](n)
        c, h, r, m = R["painted"](base, n, seed, 0.6)
        seam = seams(x, y, 1, 0.005)
        mid = 1 - R["smoothstep"](0.002, 0.004, np.abs(y - 0.5))  # a fine joint at mid height (1 m)
        dots = sum(R["disc"](x, y, px, py, 0.008) for px in (0.03, 0.97) for py in (0.03, 0.47, 0.53, 0.97)) if rivets else 0 * x
        c = c * (1 - 0.55 * seam[..., None]) * (1 - 0.3 * mid[..., None])
        c = c * (1 - dots[..., None]) + R["STEEL"][None, None] * 0.7 * dots[..., None]
        return c, h - seam * 0.8 - mid * 0.3 + dots * 0.3, r, np.maximum(m, dots * 0.9), None, 3.0
    return painter


def paint_deck(n):
    """Floor plate: dark anti-slip dimples in staggered rows, a joint round the 2 m plate and one across it."""
    x, y = R["grid"](n)
    c, h, r, m = R["painted"](DECK, n, 7101, 0.8)
    rows = 40
    gx, gy = x * rows, y * rows
    gx = gx + 0.5 * (np.floor(gy) % 2)
    dimple = 1 - R["smoothstep"](0.16, 0.24, np.hypot((gx % 1.0) - 0.5, (gy % 1.0) - 0.5))
    seam = seams(x, y, 2, 0.006)
    c = c * (1 + 0.12 * dimple[..., None]) * (1 - 0.5 * seam[..., None])
    return c, h + dimple * 0.6 - seam, r - 0.12 * dimple, m + 0.3 * dimple, None, 3.0


def paint_hull(base, seed):
    """Hull plating: 1 m plates in rows that break joint, rivet lines along the joints, faint vertical grime streaks."""
    def painter(n):
        x, y = R["grid"](n)
        c, h, r, m = R["painted"](base, n, seed, 0.9)
        plates = 4
        row = np.floor(y * plates)
        sx = (x * plates / 2 + 0.5 * (row % 2)) % 1.0
        sy = (y * plates) % 1.0
        d = np.minimum(np.minimum(sx, 1 - sx), np.minimum(sy, 1 - sy)) / plates
        seam = 1 - R["smoothstep"](0.0012, 0.0025, d)
        line = (1 - R["smoothstep"](0.006, 0.009, d)) * (1 - seam)
        rivet = line * (1 - R["smoothstep"](0.18, 0.28, np.abs((x * plates * 8) % 1.0 - 0.5)))
        streak = R["smoothstep"](0.6, 0.9, R["noise"](seed + 5, 6, 3, n, (6, 0.4))) * 0.12
        c = c * (1 - 0.45 * seam[..., None]) * (1 - streak[..., None]) * (1 - 0.15 * rivet[..., None])
        return c, h - seam * 0.9 + rivet * 0.25, r + streak * 0.5, m, None, 3.0
    return painter


def paint_grate(n):
    """Ramp and walkway grip: transverse steel ribs, eight to the metre, between dark gaps."""
    x, y = R["grid"](n)
    rib = R["smoothstep"](0.25, 0.4, np.abs(((y * 8) % 1.0) - 0.5) * 2)
    c, h, r, m = R["painted"](np.array((0.34, 0.35, 0.36)), n, 7201, 0.7)
    c = c * (0.35 + 0.65 * rib[..., None])
    return c, rib * 0.8, r - 0.15 * rib, np.maximum(m, rib * 0.7), None, 5.0


def paint_glow(tint, seed):
    glow = srgb(tint)

    def painter(n):
        x, y = R["grid"](n)
        flicker = 0.92 + 0.08 * R["noise"](seed, 4, 2, n)
        g = glow[None, None] * flicker[..., None]
        return g * 0.6, np.zeros((n, n)), np.full((n, n), 0.25), np.zeros((n, n)), g, 0.5
    return painter


def paint_pad(n):
    """The jump pad's plate, fitted: a dark disc with two glowing rings and four inward chevrons."""
    x, y = R["grid"](n)
    c, h, r, m = R["painted"](R["GUNMETAL"], n, 7301, 0.6)
    rr = np.hypot(x - 0.5, y - 0.5)
    rings = (R["smoothstep"](0.37, 0.38, rr) * (1 - R["smoothstep"](0.405, 0.415, rr))
             + R["smoothstep"](0.2, 0.21, rr) * (1 - R["smoothstep"](0.225, 0.235, rr)))
    angle = np.arctan2(y - 0.5, x - 0.5)
    sector = np.abs(((angle / (np.pi / 2)) % 1.0) - 0.5)
    chevron = (np.abs(rr - 0.3 + sector * 0.12) < 0.02) * (sector < 0.22) * 1.0
    lit = np.clip(rings + chevron, 0, 1)
    hub = 1 - R["smoothstep"](0.09, 0.1, rr)
    frame = 1 - R["box_mask"](x, y, 0.04, 0.96)
    stripe = R["smoothstep"](0.48, 0.52, ((x + y) * 10) % 1.0) * frame
    glow = srgb(PAD_GLOW)
    c = c * (1 - lit[..., None]) + glow[None, None] * 0.7 * lit[..., None]
    c = c * (1 - 0.4 * hub[..., None])
    c = c * (1 - stripe[..., None]) + R["HAZARD"][None, None] * stripe[..., None]
    g = glow[None, None] * lit[..., None]
    return c, lit * 0.3 - hub * 0.5 - frame * 0.2, r, m, g, 3.0


def paint_scorch(n):
    """A torn, blast-blackened edge: burnt metal with heat tint and a ragged dark core."""
    x, y = R["grid"](n)
    burn = R["noise"](7401, 8, 4, n)
    tint = R["noise"](7402, 3, 3, n)
    base = np.array((0.09, 0.085, 0.08))
    heat = np.array((0.32, 0.22, 0.28))
    c = base[None, None] * (0.7 + 0.6 * burn[..., None]) * (1 - tint[..., None] * 0.3) + heat[None, None] * 0.35 * (tint[..., None] ** 3)
    return c, burn * 1.2, 0.75 + 0.2 * burn, 0.4 * tint, None, 6.0


def paint_crate(n):
    """A crate face, fitted: a pale frame, a recessed centre with a dark diagonal brace and a hazard label."""
    x, y = R["grid"](n)
    c, h, r, m = R["painted"](np.array((0.5, 0.5, 0.46)), n, 7501, 0.8)
    inner = R["box_mask"](x, y, 0.1, 0.9)
    brace = (np.abs(x - y) < 0.05) * inner
    label = R["box_mask"](x, y, 0.62, 0.86) * (y > 0.12) * (y < 0.22) * 1.0
    c = c * (1 - 0.25 * inner[..., None]) * (1 - 0.35 * brace[..., None])
    c = c * (1 - label[..., None]) + R["HAZARD"][None, None] * label[..., None]
    return c, -inner * 0.6 + brace * 0.4, r, m, None, 4.0


def paint_container(n):
    """Corrugated container sides: vertical ribs every 25 cm (a 2 m tile), muted steel blue."""
    x, y = R["grid"](n)
    c, h, r, m = R["painted"](CONTAINER, n, 7601, 1.0)
    wave = np.cos(x * 8 * 2 * np.pi)
    c = c * (0.9 + 0.1 * wave[..., None])
    return c, wave * 0.6, r, m, None, 6.0


PAINTERS = {
    "panel": paint_panel(PALE, 7001), "panel-dark": None,
    "deck": paint_deck, "hull": paint_hull(HULL, 7801), "hull-dark": paint_hull(HULL_DARK, 7811),
    "gunmetal": None, "steel": None, "hazard": None, "vent": None,  # the robot kit's own painters (bound in paint_atlas)
    "grate": paint_grate, "glow": paint_glow(GLOW, 7901), "pad": paint_pad, "scorch": paint_scorch,
    "crate": paint_crate, "container": paint_container, "glow-warn": paint_glow(WARN, 7911),
}


def painter(name):
    if name == "gunmetal":
        return R["paint_flat"](R["GUNMETAL"] * 1.6, 7021, 0.6)
    if name == "steel":
        return R["paint_steel"]
    if name == "hazard":
        return R["paint_hazard"]
    if name == "vent":
        return R["paint_vent"]
    if name == "panel-dark":
        return paint_panel(R["BEAM_PAINT"], 7011, rivets=False)
    return PAINTERS[name]


def paint_atlas():
    edge, n = ATLAS_EDGE, CELL_PX - 2 * GUTTER
    colour = np.zeros((edge, edge, 3))
    normal = np.zeros((edge, edge, 3)) + np.array((0.5, 0.5, 1.0))
    orm = np.ones((edge, edge, 3))
    emissive = np.zeros((edge, edge, 3))
    for name, (cx, cy) in CELLS.items():
        c, height, rough, metal, glow, strength = painter(name)(n)
        nm = C["normal_map"](height, strength * 0.3)
        o = np.ones((n, n, 3))
        o[..., 1] = np.clip(rough, 0.04, 1)
        o[..., 2] = np.clip(metal, 0, 1)
        g = np.zeros((n, n, 3)) if glow is None else glow
        x0, y0 = cx * CELL_PX, cy * CELL_PX
        for target, pixels in ((colour, c), (normal, nm), (orm, o), (emissive, g)):
            target[y0:y0 + CELL_PX, x0:x0 + CELL_PX] = np.pad(pixels, ((GUTTER, GUTTER), (GUTTER, GUTTER), (0, 0)), mode="edge")
    return np.clip(colour, 0, 1), normal, orm, np.clip(emissive, 0, 1)


def atlas_material():
    """The kit's single opaque material; the atlas is painted once per Blender session."""
    existing = bpy.data.materials.get(MATERIAL)
    if existing is not None:
        return existing
    colour, normal, orm, emissive = paint_atlas()
    mat = bpy.data.materials.new(MATERIAL)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")

    def texture(name, pixels, is_colour):
        node = tree.nodes.new("ShaderNodeTexImage")
        node.image = C["make_image"](name, pixels, is_colour)
        return node
    tree.links.new(texture(f"{MATERIAL}-colour", colour, True).outputs["Color"], bsdf.inputs["Base Color"])
    normal_node = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(texture(f"{MATERIAL}-normal", normal, False).outputs["Color"], normal_node.inputs["Color"])
    tree.links.new(normal_node.outputs["Normal"], bsdf.inputs["Normal"])
    separate = tree.nodes.new("ShaderNodeSeparateColor")
    tree.links.new(texture(f"{MATERIAL}-orm", orm, False).outputs["Color"], separate.inputs["Color"])
    tree.links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    tree.links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    tree.links.new(texture(f"{MATERIAL}-emissive", emissive, True).outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    return mat


def cell_uv(cell, u, v):
    """A cell-local (u, v) in [0, 1] (v up) as an atlas coordinate, inside the cell's gutter."""
    cx, cy = CELLS[cell]
    inner = CELL_PX - 2 * GUTTER
    u, v = min(max(u, 0.0), 1.0), min(max(v, 0.0), 1.0)
    return ((cx * CELL_PX + GUTTER + u * inner) / ATLAS_EDGE, 1 - (cy * CELL_PX + GUTTER + (1 - v) * inner) / ATLAS_EDGE)


# ---------------------------------------------------------------- geometry

TILED, FIT = "tile", "fit"
UP = Vector((0, 1, 0))


def face_axes(normal):
    """In-plane axes (u, v) of a face in the glTF frame, u x v = normal: u horizontal (+X on a top face), v up the face."""
    if abs(normal.y) > 0.999:
        return Vector((1, 0, 0)), (Vector((0, 0, -1)) if normal.y > 0 else Vector((0, 0, 1)))
    u = UP.cross(normal).normalized()
    return u, normal.cross(u).normalized()


def clip(points, axis, c, keep_below):
    """Sutherland-Hodgman: the part of a convex polygon of (co, u, v) on one side of the line ``axis`` (1 u, 2 v) = c."""
    out = []
    for i, a in enumerate(points):
        b = points[(i + 1) % len(points)]
        ina = a[axis] <= c + 1e-9 if keep_below else a[axis] >= c - 1e-9
        inb = b[axis] <= c + 1e-9 if keep_below else b[axis] >= c - 1e-9
        if ina:
            out.append(a)
        if ina != inb:
            t = (c - a[axis]) / (b[axis] - a[axis])
            out.append((a[0].lerp(b[0], t), a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t))
    return out


def area(points):
    total = Vector((0, 0, 0))
    for i in range(1, len(points) - 1):
        total += (points[i][0] - points[0][0]).cross(points[i + 1][0] - points[0][0])
    return total.length / 2


class Module:
    """One module at one level: polygons gathered per node in the glTF frame, triangulated canonically when meshed."""

    def __init__(self, key, variant, level, box):
        self.key, self.variant, self.level = key, variant, level
        self.lo, self.hi = Vector(box[0]), Vector(box[1])
        self.tris = {}
        self.node = "body"

    def poly(self, points, cell, mode=TILED, detail=False, outward=None):
        """A convex planar polygon (glTF points); ``outward`` (a point inside the solid) fixes its winding."""
        if detail and self.level > 0:
            return
        pts = [Vector(p) for p in points]
        normal = (pts[1] - pts[0]).cross(pts[2] - pts[0])
        if outward is not None and normal.dot(pts[0] - Vector(outward)) < 0:
            pts.reverse()
            normal = -normal
        if normal.length < 1e-12:
            return
        normal.normalize()
        u_axis, v_axis = face_axes(normal)
        ring = [(p, p.dot(u_axis), p.dot(v_axis)) for p in pts]
        if mode == FIT:
            us, vs = [r[1] for r in ring], [r[2] for r in ring]
            u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
            self.emit(ring, cell, lambda u, v: ((u - u0) / max(u1 - u0, 1e-9), (v - v0) / max(v1 - v0, 1e-9)))
            return
        tile = TILE[cell]
        ua, va = self.lo.dot(u_axis), self.lo.dot(v_axis)
        # The module's minimum corner starts the tile lines; an axis that runs backwards counts from the maximum.
        if u_axis.x + u_axis.y + u_axis.z < 0:
            ua = self.hi.dot(u_axis)
        if v_axis.x + v_axis.y + v_axis.z < 0:
            va = self.hi.dot(v_axis)
        pieces = [[(p, (u - ua) / tile, (v - va) / tile) for p, u, v in ring]]
        for axis in (1, 2):
            split = []
            for piece in pieces:
                lo_k = math.floor(min(p[axis] for p in piece) + 1e-6)
                hi_k = math.ceil(max(p[axis] for p in piece) - 1e-6)
                rest = piece
                for k in range(lo_k + 1, hi_k):
                    below = clip(rest, axis, k, True)
                    rest = clip(rest, axis, k, False)
                    if len(below) >= 3:
                        split.append(below)
                if len(rest) >= 3:
                    split.append(rest)
            pieces = split
        for piece in pieces:
            cu = math.floor(sum(p[1] for p in piece) / len(piece))
            cv = math.floor(sum(p[2] for p in piece) / len(piece))
            self.emit(piece, cell, lambda u, v, cu=cu, cv=cv: (u - cu, v - cv))

    def emit(self, ring, cell, local):
        if len(ring) < 3 or area(ring) < 1e-10:
            return
        corners = [(p, cell_uv(cell, *local(u, v))) for p, u, v in ring]
        for i in range(1, len(corners) - 1):
            tri = (corners[0], corners[i], corners[i + 1])
            if (tri[1][0] - tri[0][0]).cross(tri[2][0] - tri[0][0]).length < 1e-10:
                continue
            self.tris.setdefault(self.node, []).append(tri)

    # -- solids ---------------------------------------------------------

    def box(self, lo, hi, cell, sides=None, mode=TILED, detail=False, skip=()):
        """An axis-aligned box; ``sides`` maps a face (``+x``, ``-x``, ``+y``, ``-y``, ``+z``, ``-z``) to another cell."""
        lo, hi = Vector(lo), Vector(hi)
        centre = (lo + hi) / 2
        sides = sides or {}
        for axis in range(3):
            a1, a2 = [i for i in range(3) if i != axis]
            for sign, value in (("-", lo[axis]), ("+", hi[axis])):
                face = f"{sign}{'xyz'[axis]}"
                if face in skip:
                    continue
                pts = []
                for d1, d2 in ((0, 0), (1, 0), (1, 1), (0, 1)):
                    p = [0.0, 0.0, 0.0]
                    p[axis] = value
                    p[a1] = (lo, hi)[d1][a1]
                    p[a2] = (lo, hi)[d2][a2]
                    pts.append(p)
                face_cell = sides.get(face, cell)
                self.poly(pts, face_cell, FIT if face_cell in ("crate", "pad") else mode, detail, outward=centre)

    def prism(self, axis, profile, start, end, cell, caps=None, sides=None, detail=False):
        """A convex profile extruded along ``axis`` ('x': profile in (z, y); 'z': profile in (x, y)) from start to end.
        ``sides`` maps a profile edge index (edge i runs from point i to i + 1) to another cell."""
        def point(a, b, t):
            return (t, b, a) if axis == "x" else (a, b, t)
        sides = sides or {}
        n = len(profile)
        ca = sum(p[0] for p in profile) / n
        cb = sum(p[1] for p in profile) / n
        centre = point(ca, cb, (start + end) / 2)
        for i in range(n):
            (a0, b0), (a1, b1) = profile[i], profile[(i + 1) % n]
            self.poly([point(a0, b0, start), point(a1, b1, start), point(a1, b1, end), point(a0, b0, end)], sides.get(i, cell), TILED, detail, outward=centre)
        for t in (start, end):
            self.poly([point(a, b, t) for a, b in profile], caps or cell, TILED, detail, outward=centre)

    def cylinder(self, centre, axis, radius, length, sides, cell, cap=None, detail=False):
        """A capped cylinder along a principal ``axis`` ('x', 'y' or 'z') starting at ``centre``."""
        k = "xyz".index(axis)
        a1, a2 = [i for i in range(3) if i != k]
        ring0, ring1 = [], []
        for s in range(sides):
            t = 2 * math.pi * (s + 0.5) / sides
            p = list(centre)
            p[a1] += math.cos(t) * radius
            p[a2] += math.sin(t) * radius
            ring0.append(tuple(p))
            q = list(p)
            q[k] += length
            ring1.append(tuple(q))
        mid = list(centre)
        mid[k] += length / 2
        for s in range(sides):
            self.poly([ring0[s], ring0[(s + 1) % sides], ring1[(s + 1) % sides], ring1[s]], cell, TILED, detail, outward=mid)
        self.poly(ring0, cap or cell, TILED, detail, outward=mid)
        self.poly(ring1, cap or cell, TILED, detail, outward=mid)

    def jagged(self, x0, x1, z0, z1, y0, lo, hi, cell, seed, width=0.1, top=True, detail=False):
        """A broken edge along x: columns ``width`` wide from y0 up (top) or down to a ragged line between lo and hi."""
        count = max(1, round((x1 - x0) / width))
        step = (x1 - x0) / count
        for i in range(count):
            h = lo + (hi - lo) * C["rnd"](self.key, seed, i)
            a, b = x0 + i * step, x0 + (i + 1) * step
            if top:
                self.box((a, y0, z0), (b, h, z1), cell, {"+y": "scorch"})
            else:
                self.box((a, h, z0), (b, y0, z1), cell, {"-y": "scorch"})

    # -- output ---------------------------------------------------------

    def meshes(self, collection):
        """One flat-shaded mesh object per node, rebuilt canonically: each triangle from its smallest corner, sorted."""
        out = []
        for node in sorted(self.tris):
            tris = []
            for tri in self.tris[node]:
                corners = [(tuple(round(c, 6) + 0.0 for c in (p.x, -p.z, p.y)), tuple(round(c, 6) + 0.0 for c in uv)) for p, uv in tri]
                k = corners.index(min(corners))
                if len({co for co, _ in corners}) == 3:
                    tris.append(tuple(corners[k:] + corners[:k]))
            tris.sort()
            points, faces, uvs = {}, [], []
            for tri in tris:
                faces.append([points.setdefault(co, len(points)) for co, _ in tri])
                uvs.extend(t for _, t in tri)
            data = bpy.data.meshes.new(node)
            data.from_pydata(list(points), [], faces)
            data.uv_layers.new(name="UVMap")
            data.uv_layers[0].data.foreach_set("uv", np.array(uvs, dtype=np.float32).ravel())
            data.polygons.foreach_set("use_smooth", np.zeros(len(faces), dtype=bool))
            data.update()
            data.materials.append(atlas_material())
            obj = bpy.data.objects.new(node if len(self.tris) > 1 else self.key, data)
            collection.objects.link(obj)
            out.append(obj)
        return out


# ---------------------------------------------------------------- modules
# Each builder draws inside its placement box (MODULES), in the glTF frame.

T = 0.3     # half the wall thickness (0.6 m, Shooter's inner walls)
FIELD = 0.26  # the recessed panel field's face
PLINTH = 0.45
CAP = 0.3


def wall_run(m, x0, x1, y0, y1, ends=(True, True), cap=True, plinth=True, light=True):
    """A stretch of wall from x0 to x1 and y0 to y1: graphite plinth, pale recessed panel field, gunmetal cap and end ribs
    (half a rib at each module edge, so two neighbours make one), and a cyan light strip under the cap."""
    yb = y0 + (PLINTH if plinth and y0 == 0 else 0)
    yt = y1 - (CAP if cap else 0)
    m.box((x0, yb, -FIELD), (x1, yt, FIELD), "panel", {"+x": "gunmetal", "-x": "gunmetal", "+y": "gunmetal", "-y": "gunmetal"})
    if yb > y0:
        m.box((x0, y0, -T), (x1, yb, T), "panel-dark", {"+y": "gunmetal"})
    if cap:
        m.box((x0, yt, -T), (x1, y1, T), "gunmetal")
    for x, ok in ((x0, ends[0]), (x1, ends[1])):
        if not ok:
            continue
        a, b = (x, x + 0.06) if x == x0 else (x - 0.06, x)
        for z0, z1 in ((FIELD, T), (-T, -FIELD)):
            m.box((a, yb, z0), (b, yt, z1), "gunmetal", skip=("-y", "+y"))
    if light and yt - yb > 2.5:
        for z0, z1 in ((FIELD, FIELD + 0.012), (-FIELD - 0.012, -FIELD)):
            m.box((x0 + (0.06 if ends[0] else 0), yt - 0.14, z0), (x1 - (0.06 if ends[1] else 0), yt - 0.1, z1), "glow", detail=True)
            m.box((x0 + (0.06 if ends[0] else 0), yb + 1.2, z0), (x1 - (0.06 if ends[1] else 0), yb + 1.28, z1), "gunmetal", detail=True)


def wall(width, height):
    def build(m):
        wall_run(m, -width / 2, width / 2, 0, height)
    return build


def corner(height):
    def build(m):
        m.box((-0.28, PLINTH, -0.28), (0.28, height - CAP, 0.28), "panel-dark")
        m.box((-T, 0, -T), (T, PLINTH, T), "panel-dark", {"+y": "gunmetal"})
        m.box((-T, height - CAP, -T), (T, height, T), "gunmetal")
        for sx in (-1, 1):
            for sz in (-1, 1):
                m.box((min(sx * 0.3, sx * 0.22), PLINTH, min(sz * 0.3, sz * 0.22)), (max(sx * 0.3, sx * 0.22), height - CAP, max(sz * 0.3, sz * 0.22)), "gunmetal", skip=("-y", "+y"))
        for sz in (-1, 1):
            m.box((-0.08, PLINTH + 0.4, min(sz * 0.28, sz * 0.295)), (0.08, height - CAP - 0.4, max(sz * 0.28, sz * 0.295)), "glow", detail=True)
    return build


DOOR_W, DOOR_H = 2.0, 3.0


def doorway(m):
    wall_run(m, -2, -DOOR_W / 2, 0, 4, ends=(True, False))
    wall_run(m, DOOR_W / 2, 2, 0, 4, ends=(False, True))
    # The lintel over the opening: panel field and cap, no plinth.
    wall_run(m, -DOOR_W / 2, DOOR_W / 2, DOOR_H, 4, ends=(False, False), plinth=False, light=False)
    # A gunmetal frame on both faces round the opening and a light over it.
    for z0, z1 in ((FIELD, T), (-T, -FIELD)):
        m.box((-DOOR_W / 2 - 0.16, PLINTH, z0), (-DOOR_W / 2, DOOR_H, z1), "gunmetal")
        m.box((DOOR_W / 2, PLINTH, z0), (DOOR_W / 2 + 0.16, DOOR_H, z1), "gunmetal")
        m.box((-DOOR_W / 2 - 0.16, DOOR_H, z0), (DOOR_W / 2 + 0.16, DOOR_H + 0.16, z1), "gunmetal")
        m.box((-0.5, DOOR_H + 0.22, z0), (0.5, DOOR_H + 0.28, z1), "glow", detail=True)


def door(m):
    """Two sliding leaves (nodes ``leaf-left`` and ``leaf-right``) that close the doorway's opening, each lapping 5 cm into
    its jamb and the lintel. Broken: a blast hole across the meeting seam, its torn edges scorched."""
    for name, side in (("leaf-left", -1), ("leaf-right", 1)):
        m.node = name
        outer, inner = side * 1.05, 0.0
        x0, x1 = min(outer, inner), max(outer, inner)
        if m.variant == "default":
            m.box((x0, 0, -0.05), (x1, 3.05, 0.05), "panel", {"+x": "gunmetal", "-x": "gunmetal", "+y": "gunmetal", "-y": "gunmetal"})
            seam_x = (inner + side * 0.12, inner)
            for z0, z1 in ((0.05, 0.07), (-0.07, -0.05)):
                m.box((min(seam_x), 0.35, z0), (max(seam_x), 3.05, z1), "gunmetal")
                m.box((x0, 0, z0), (x1, 0.35, z1), "hazard")
                m.box((min(outer, outer - side * 0.25), 0.35, z0), (max(outer, outer - side * 0.25), 3.05, z1), "gunmetal", detail=True)
                m.box((min(side * 0.12, side * 0.75) + inner, 1.45, z0), (max(side * 0.12, side * 0.75) + inner, 1.52, z1), "glow", detail=True)
        else:
            # The outer strip stands; below and above the hole the leaf ends in a ragged line.
            strip = (min(outer, side * 0.56), max(outer, side * 0.56))
            m.box((strip[0], 0, -0.05), (strip[1], 3.05, 0.05), "panel", {"+x": "gunmetal", "-x": "gunmetal", "+y": "gunmetal", "-y": "gunmetal"})
            hole = (min(side * 0.56, inner), max(side * 0.56, inner))
            m.jagged(hole[0], hole[1], -0.05, 0.05, 0, 0.8, 1.0, "panel", f"{name}.lower")
            m.jagged(hole[0], hole[1], -0.05, 0.05, 3.05, 2.25, 2.4, "panel", f"{name}.upper", top=False)
            for z0, z1 in ((0.05, 0.07), (-0.07, -0.05)):
                m.box((strip[0], 0, z0), (strip[1], 0.35, z1), "hazard")
                m.box((hole[0], 0, z0), (hole[1], 0.35, z1), "hazard")
                m.box((min(outer, outer - side * 0.25), 0.35, z0), (max(outer, outer - side * 0.25), 3.05, z1), "gunmetal", detail=True)
    m.node = "body"


def cover(height, broken_low, broken_high, stub, seed):
    """A free-standing barrier with a chamfered top, a graphite base band, a hazard edge and small warning lights.
    Broken: a stub stands at one end; the rest is torn down to a ragged line."""
    chamfer = 0.25

    def body(m, x0, x1, y1, flat=False):
        top = y1 if flat else y1 - chamfer
        profile = [(-0.28, 0.15), (0.28, 0.15), (0.28, top), (0.14, y1), (-0.14, y1), (-0.28, top)] if not flat else [(-0.28, 0.15), (0.28, 0.15), (0.28, y1), (-0.28, y1)]
        m.prism("x", profile, x0, x1, "panel", caps="gunmetal", sides={3: "gunmetal"} if not flat else {2: "scorch"})

    def build(m):
        m.box((-1, 0, -T), (1, 0.15, T), "panel-dark", {"+y": "gunmetal"})
        if m.variant == "default":
            body(m, -0.97, 0.97, height)
            for x0, x1 in ((-1, -0.97), (0.97, 1)):
                m.prism("x", [(-T, 0.15), (T, 0.15), (T, height - chamfer), (0.15, height), (-0.15, height), (-T, height - chamfer)], x0, x1, "gunmetal")
            for z0, z1 in ((0.28, 0.295), (-0.295, -0.28)):
                m.box((-0.8, 0.15, z0), (0.8, 0.27, z1), "hazard", detail=True)
                for x in (-0.6, 0.6):
                    m.box((x - 0.08, height - chamfer - 0.12, z0), (x + 0.08, height - chamfer - 0.08, z1), "glow-warn", detail=True)
        else:
            s0, s1 = (-1, stub) if stub < 0 else (stub, 1)
            body(m, s0 + (0.03 if s0 == -1 else 0), s1 - (0.03 if s1 == 1 else 0), height)
            for x0, x1 in (((-1, -0.97),) if s0 == -1 else ((0.97, 1),)):
                m.prism("x", [(-T, 0.15), (T, 0.15), (T, height - chamfer), (0.15, height), (-0.15, height), (-T, height - chamfer)], x0, x1, "gunmetal")
            r0, r1 = (stub, 0.97) if stub < 0 else (-0.97, stub)
            m.jagged(r0, r1, -0.28, 0.28, 0.15, broken_low, broken_high, "panel", seed)
            for z0, z1 in ((0.28, 0.295), (-0.295, -0.28)):
                m.box((-0.8, 0.15, z0), (0.8, 0.27, z1), "hazard", detail=True)
    return build


def crate(m):
    """An 80 cm cargo crate: fitted faces in a gunmetal edge frame. Broken: the lid gone, the sides torn to a ragged rim."""
    e = 0.06
    if m.variant == "default":
        m.box((-0.38, 0.02, -0.38), (0.38, 0.78, 0.38), "crate")
        for a in range(3):
            for s1 in (-1, 1):
                for s2 in (-1, 1):
                    lo, hi = [0.0] * 3, [0.0] * 3
                    o1, o2 = [i for i in range(3) if i != a]
                    lo[a], hi[a] = -0.4, 0.4
                    lo[o1], hi[o1] = sorted((s1 * 0.4, s1 * (0.4 - e)))
                    lo[o2], hi[o2] = sorted((s2 * 0.4, s2 * (0.4 - e)))
                    lo[1] += 0.4
                    hi[1] += 0.4
                    m.box(lo, hi, "gunmetal")
        return
    m.box((-0.38, 0.02, -0.38), (0.38, 0.06, 0.38), "crate")
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.box((min(sx * 0.4, sx * (0.4 - e)), 0, min(sz * 0.4, sz * (0.4 - e))), (max(sx * 0.4, sx * (0.4 - e)), 0.46 + 0.1 * C["rnd"]("crate", sx, sz), max(sz * 0.4, sz * (0.4 - e))), "gunmetal", {"+y": "scorch"})
    m.box((-0.4, 0, -0.4), (0.4, e, 0.4), "gunmetal", skip=("+y",))
    for k, (x0, x1, z0, z1) in enumerate(((-0.34, 0.34, 0.34, 0.38), (-0.34, 0.34, -0.38, -0.34))):
        m.jagged(x0, x1, z0, z1, e, 0.46, 0.6, "crate", f"side-{k}", width=0.085)
    for k, x in enumerate((0.34, -0.38)):
        for i in range(8):
            z0 = -0.34 + i * 0.085
            h = 0.46 + 0.14 * C["rnd"]("crate", "end", k, i)
            m.box((x, e, z0), (x + 0.04, h, z0 + 0.085), "crate", {"+y": "scorch"})


def platform(height):
    def build(m):
        m.box((-0.97, 0.15, -0.97), (0.97, height, 0.97), "panel-dark", {"+y": "deck"}, skip=("-y",))
        m.box((-1, 0, -1), (1, 0.15, 1), "gunmetal", skip=("-y",))
        for x0, x1, z0, z1 in ((-1, 1, 0.97, 1), (-1, 1, -1, -0.97), (0.97, 1, -0.97, 0.97), (-1, -0.97, -0.97, 0.97)):
            m.box((x0, height - 0.12, z0), (x1, height, z1), "gunmetal", skip=("-y",))
        for x0, x1, z0, z1 in ((-0.6, 0.6, 0.97, 0.985), (-0.6, 0.6, -0.985, -0.97), (0.97, 0.985, -0.6, 0.6), (-0.985, -0.97, -0.6, 0.6)):
            m.box((x0, height - 0.2, z0), (x1, height - 0.16, z1), "glow", detail=True)
    return build


def ramp(rise, run):
    """A 1:4 (14 degree) ramp two metres wide rising toward -Z: a grip deck, gunmetal kerbs flush with it and graphite sides."""
    def build(m):
        h = run / 2
        m.prism("x", [(h, 0), (-h, rise), (-h, 0)], -0.97, 0.97, "panel-dark", sides={0: "grate"})
        for x0, x1 in ((-1, -0.97), (0.97, 1)):
            m.prism("x", [(h, 0), (-h, rise), (-h, 0)], x0, x1, "gunmetal")
        # Guide lights along both sides, just under the deck line.
        slope = rise / run
        for i in range(int(run // 2)):
            z = h - 1 - 2 * i
            y = (h - z) * slope
            for x0, x1 in ((-0.997, -0.97), (0.97, 0.997)):
                m.box((x0, max(y - 0.22, 0.02), z - 0.15), (x1, max(y - 0.16, 0.06), z + 0.15), "glow", detail=True)
    return build


def walkway(m):
    m.box((-1, 0.02, -1.92), (1, 0.4, 1.92), "panel-dark", {"+y": "grate"})
    for z0, z1, zl0, zl1 in ((1.92, 1.985, 1.985, 2.0), (-1.985, -1.92, -2.0, -1.985)):
        m.box((-1, 0, z0), (1, 0.4, z1), "gunmetal")
        m.box((-1, 0.17, zl0), (1, 0.23, zl1), "glow", detail=True)
    m.box((-0.15, 0, -1.92), (0.15, 0.02, 1.92), "gunmetal", detail=True)


def support(m):
    m.box((-0.3, 0.3, -0.3), (0.3, 2.2, 0.3), "panel-dark", skip=("-y", "+y"))
    m.box((-0.5, 0, -0.5), (0.5, 0.3, 0.5), "gunmetal", skip=("-y",))
    m.prism("x", [(-0.3, 2.2), (0.3, 2.2), (0.5, 2.45), (0.5, 2.6), (-0.5, 2.6), (-0.5, 2.45)], -0.5, 0.5, "gunmetal")
    for sx in (-1, 1):
        m.box((min(sx * 0.3, sx * 0.32), 0.6, -0.06), (max(sx * 0.3, sx * 0.32), 1.9, 0.06), "glow", detail=True)


def pillar(m):
    m.box((-0.45, 0.4, -0.45), (0.45, 3.7, 0.45), "panel-dark", skip=("-y", "+y"))
    m.box((-0.6, 0, -0.6), (0.6, 0.4, 0.6), "gunmetal", skip=("-y",))
    m.box((-0.6, 3.7, -0.6), (0.6, 4.0, 0.6), "gunmetal")
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.box((min(sx * 0.45, sx * 0.6), 0.4, min(sz * 0.45, sz * 0.6)), (max(sx * 0.45, sx * 0.6), 3.7, max(sz * 0.45, sz * 0.6)), "gunmetal", skip=("-y", "+y"))
    for axis, s in (("x", -1), ("x", 1), ("z", -1), ("z", 1)):
        if axis == "x":
            m.box((min(s * 0.45, s * 0.465), 0.8, -0.05), (max(s * 0.45, s * 0.465), 3.3, 0.05), "glow", detail=True)
        else:
            m.box((-0.05, 0.8, min(s * 0.45, s * 0.465)), (0.05, 3.3, max(s * 0.45, s * 0.465)), "glow", detail=True)


def jump_pad(m):
    """A 1.6 m plate flush with the floor (its top 2 cm up, its body sunk 5 cm): a gunmetal frame round the glowing pad."""
    m.box((-0.72, -0.05, -0.72), (0.72, 0.015, 0.72), "pad", skip=("-y",))
    for x0, x1, z0, z1 in ((-0.8, 0.8, 0.72, 0.8), (-0.8, 0.8, -0.8, -0.72), (0.72, 0.8, -0.72, 0.72), (-0.8, -0.72, -0.72, 0.72)):
        m.box((x0, -0.05, z0), (x1, 0.02, z1), "gunmetal", skip=("-y",))


def container(m):
    """An 8 x 3 m cargo container, 2 m high: corrugated sides between gunmetal corner posts and rails, hazard-striped doors."""
    m.box((-3.85, 0.1, -1.4), (3.85, 1.88, 1.4), "container", {"+x": "panel-dark", "-x": "panel-dark", "+y": "deck"}, skip=("-y",))
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.box((min(sx * 3.85, sx * 4), 0, min(sz * 1.35, sz * 1.5)), (max(sx * 3.85, sx * 4), 2, max(sz * 1.35, sz * 1.5)), "gunmetal", skip=("-y",))
    for sz in (-1, 1):
        m.box((-3.85, 0, min(sz * 1.4, sz * 1.5)), (3.85, 0.14, max(sz * 1.4, sz * 1.5)), "gunmetal", skip=("-y",))
        m.box((-3.85, 1.88, min(sz * 1.35, sz * 1.5)), (3.85, 2, max(sz * 1.35, sz * 1.5)), "gunmetal")
    for sx in (-1, 1):
        m.box((min(sx * 3.85, sx * 4), 1.88, -1.35), (max(sx * 3.85, sx * 4), 2, 1.35), "gunmetal")
        m.box((min(sx * 3.85, sx * 3.9), 0.1, -0.02), (max(sx * 3.85, sx * 3.9), 1.88, 0.02), "gunmetal", detail=True)
        m.box((min(sx * 3.85, sx * 3.88), 0.2, -1.3), (max(sx * 3.85, sx * 3.88), 0.45, 1.3), "hazard", detail=True)
    m.box((-1.2, 1.4, 1.4), (1.2, 1.6, 1.43), "steel", detail=True)
    m.box((-1.2, 1.4, -1.43), (1.2, 1.6, -1.4), "steel", detail=True)


def generator(m):
    """A power unit on a skid: a panelled housing with vents, a cylindrical drum on top, pipes and status lights."""
    m.box((-1, 0, -0.6), (1, 0.15, 0.6), "gunmetal", skip=("-y",))
    m.box((-0.9, 0.15, -0.5), (0.9, 1.15, 0.5), "panel", {"+y": "gunmetal"})
    m.cylinder((-0.85, 1.2, 0), "x", 0.36, 1.7, 16, "steel", cap="gunmetal")
    for x in (-0.6, 0.6):
        m.box((x - 0.12, 1.15, -0.4), (x + 0.12, 1.25, 0.4), "gunmetal")
    for z0, z1 in ((0.5, 0.52), (-0.52, -0.5)):
        m.box((-0.75, 0.3, z0), (-0.05, 0.95, z1), "vent", mode=FIT, detail=True)
        m.box((0.2, 0.75, z0), (0.6, 0.82, z1), "glow-warn", detail=True)
        m.box((0.2, 0.62, z0), (0.6, 0.69, z1), "glow", detail=True)
    for z in (-0.38, 0.38):
        m.cylinder((0.9, 0.5, z), "x", 0.06, 0.1, 8, "steel", detail=True)
    m.box((0.9, 0.3, -0.2), (1.0, 0.9, 0.2), "hazard", detail=True)


def pipes(m):
    """A 2 m run of two pipes on brackets, its back against a wall (z = -0.25)."""
    for y, r in ((0.35, 0.14), (0.85, 0.1)):
        m.cylinder((-1, y, 0), "x", r, 2, 12, "steel")
    for x in (-0.8, 0.8):
        m.box((x - 0.06, 0.1, -0.25), (x + 0.06, 1.1, -0.15), "gunmetal")
        for y, r in ((0.35, 0.16), (0.85, 0.12)):
            m.box((x - 0.05, y - r, -0.15), (x + 0.05, y + r, r), "gunmetal")
    m.cylinder((0.2, 0.85, 0.1), "z", 0.04, 0.12, 8, "hazard", detail=True)
    m.cylinder((0.2, 0.85, 0.22), "z", 0.1, 0.03, 12, "hazard", detail=True)


def hull_deck(m):
    m.box((-2, 0, -2), (2, 0.5, 2), "hull-dark", {"+y": "hull"}, skip=("-y",))


def hull_shoulder(m):
    """The 45 degree chamfer from the deck's edge down to the side plating, rising toward -Z."""
    m.prism("x", [(1, 0), (-1, 2), (-1, 0)], -2, 2, "hull-dark", sides={0: "hull"})


def hull_side(m):
    m.box((-1.94, 0, -0.25), (1.94, 2, 0.22), "hull", {"-z": "hull-dark", "+y": "hull-dark", "-y": "hull-dark"})
    for x0, x1 in ((-2, -1.94), (1.94, 2)):
        m.box((x0, 0, -0.25), (x1, 2, 0.25), "gunmetal")
    m.box((-1.94, 0.85, 0.22), (1.94, 1.1, 0.25), "gunmetal", detail=True)
    m.box((-1.94, 1.12, 0.22), (1.94, 1.16, 0.25), "glow-warn", detail=True)


def hull_rib(m):
    """A structural frame band across the deck, 80 cm: cover to crouch behind, with marker lights."""
    m.prism("x", [(-0.3, 0), (0.3, 0), (0.3, 0.6), (0.15, 0.8), (-0.15, 0.8), (-0.3, 0.6)], -2, 2, "steel", caps="gunmetal", sides={3: "hazard"})
    for x in (-1.5, 0, 1.5):
        m.box((x - 0.1, 0.45, 0.28), (x + 0.1, 0.5, 0.3), "glow-warn", detail=True)
        m.box((x - 0.1, 0.45, -0.3), (x + 0.1, 0.5, -0.28), "glow-warn", detail=True)


def hull_mast(m):
    """A sensor mast: a gunmetal foot, a steel mast and, near its top, the grapple ring with a beacon above."""
    m.box((-0.5, 0, -0.5), (0.5, 0.3, 0.5), "gunmetal", skip=("-y",))
    m.prism("x", [(-0.3, 0.3), (0.3, 0.3), (0.2, 0.55), (-0.2, 0.55)], -0.3, 0.3, "gunmetal")
    m.cylinder((0, 0.55, 0), "y", 0.12, 2.25, 12, "steel")
    m.cylinder((0, 2.6, 0), "y", 0.28, 0.12, 16, "hazard", cap="gunmetal")
    m.cylinder((0, 2.8, 0), "y", 0.06, 0.2, 8, "glow-warn")


def floor(m):
    m.box((-1, -0.1, -1), (1, 0, 1), "panel-dark", {"+y": "deck"}, skip=("-y",))


def ceiling(m):
    m.box((-1, 0.04, -1), (1, 0.2, 1), "panel-dark", {"+y": "gunmetal"})
    for x0, x1 in ((-0.55, -0.45), (0.45, 0.55)):
        m.box((x0, 0.0, -0.9), (x1, 0.04, 0.9), "glow", detail=True)
    for x0, x1, z0, z1 in ((-1, 1, 0.94, 1), (-1, 1, -1, -0.94)):
        m.box((x0, 0, z0), (x1, 0.04, z1), "gunmetal", detail=True)


BUILDERS = {
    "arena.floor": floor, "arena.ceiling": ceiling,
    "arena.wall": wall(2, 4), "arena.wall-half": wall(1, 4), "arena.wall-tall": wall(2, 5),
    "arena.wall-corner": corner(4), "arena.wall-corner-tall": corner(5),
    "arena.doorway": doorway, "arena.door": door,
    "arena.cover-low": cover(1.2, 0.56, 0.76, -0.4, "cover-low"), "arena.barrier": cover(2.0, 1.0, 1.25, 0.5, "barrier"),
    "arena.crate": crate, "arena.platform": platform(2), "arena.platform-half": platform(1),
    "arena.ramp": ramp(2, 8), "arena.ramp-tall": ramp(3, 12), "arena.walkway": walkway, "arena.support": support, "arena.pillar": pillar,
    "arena.jump-pad": jump_pad, "arena.container": container, "arena.generator": generator, "arena.pipes": pipes,
    "arena.hull-deck": hull_deck, "arena.hull-shoulder": hull_shoulder, "arena.hull-side": hull_side, "arena.hull-rib": hull_rib, "arena.hull-mast": hull_mast,
}

# Each module's placement box (glTF min, max), as the build script's MODULES declares it.
BOXES = {
    "arena.floor": ((-1, -0.1, -1), (1, 0, 1)), "arena.ceiling": ((-1, 0, -1), (1, 0.2, 1)),
    "arena.wall": ((-1, 0, -T), (1, 4, T)), "arena.wall-half": ((-0.5, 0, -T), (0.5, 4, T)), "arena.wall-tall": ((-1, 0, -T), (1, 5, T)),
    "arena.wall-corner": ((-T, 0, -T), (T, 4, T)), "arena.wall-corner-tall": ((-T, 0, -T), (T, 5, T)),
    "arena.doorway": ((-2, 0, -T), (2, 4, T)), "arena.door": ((-1.05, 0, -0.07), (1.05, 3.05, 0.07)),
    "arena.cover-low": ((-1, 0, -T), (1, 1.2, T)), "arena.barrier": ((-1, 0, -T), (1, 2, T)), "arena.crate": ((-0.4, 0, -0.4), (0.4, 0.8, 0.4)),
    "arena.platform": ((-1, 0, -1), (1, 2, 1)), "arena.platform-half": ((-1, 0, -1), (1, 1, 1)),
    "arena.ramp": ((-1, 0, -4), (1, 2, 4)), "arena.ramp-tall": ((-1, 0, -6), (1, 3, 6)), "arena.walkway": ((-1, 0, -2), (1, 0.4, 2)),
    "arena.support": ((-0.5, 0, -0.5), (0.5, 2.6, 0.5)), "arena.pillar": ((-0.6, 0, -0.6), (0.6, 4, 0.6)),
    "arena.jump-pad": ((-0.8, -0.05, -0.8), (0.8, 0.02, 0.8)), "arena.container": ((-4, 0, -1.5), (4, 2, 1.5)),
    "arena.generator": ((-1, 0, -0.6), (1, 1.6, 0.6)), "arena.pipes": ((-1, 0, -0.25), (1, 1.2, 0.25)),
    "arena.hull-deck": ((-2, 0, -2), (2, 0.5, 2)), "arena.hull-shoulder": ((-2, 0, -1), (2, 2, 1)), "arena.hull-side": ((-2, 0, -0.25), (2, 2, 0.25)),
    "arena.hull-rib": ((-2, 0, -T), (2, 0.8, T)), "arena.hull-mast": ((-0.5, 0, -0.5), (0.5, 3, 0.5)),
}


def build(key, collection, variant="default", level=0, location=(0, 0, 0)):
    """One module as one mesh object (or, for the door, one per leaf), its origin the module's origin."""
    m = Module(key, variant, level, BOXES[key])
    BUILDERS[key](m)
    objects = m.meshes(collection)
    for obj in objects:
        obj.location = location
    return objects


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or set(arguments) != {"schemaVersion", "part", "variant", "level"}:
        raise ValueError("shooter-arena arguments must be {schemaVersion: 1, part, variant, level}")
    if arguments["part"] not in PARTS:
        raise ValueError(f"shooter-arena part must be one of {', '.join(PARTS)}")
    if arguments["variant"] not in ("default", "broken") or (arguments["variant"] == "broken" and arguments["part"] not in BROKEN):
        raise ValueError(f"{arguments['part']} has no variant {arguments['variant']}")
    if arguments["level"] not in (0, 1):
        raise ValueError("shooter-arena level must be 0 or 1")
    if set(inputs) != {"common", "robot"}:
        raise ValueError("shooter-arena takes exactly the inputs 'common' (kit_common.py) and 'robot' (combat_robot.py)")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_sources(inputs.load_source("robot"), inputs.load_source("common"))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    key, variant, level = arguments["part"], arguments["variant"], arguments["level"]
    objects = build(key, bpy.context.scene.collection, variant, level)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO",
        export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    triangles = sum(len(polygon.vertices) - 2 for obj in objects for polygon in obj.data.polygons)
    return {"recipe": RECIPE, "part": key, "variant": variant, "level": level, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "module-anchor", "triangleCount": triangles, "nodes": sorted(obj.name for obj in objects)}
