"""Shooter robot locomotion (docs/robot-locomotion.md, #634): the driven wheel and the track module of Shooter's
socket-grid robots, on one procedural atlas.

The companion of the robot part kit (``combat_robot.py``, docs/combat-robot-kit.md) and the weapon kit
(``shooter_weapons.py``), built on the same convention and the same ``Part`` builder, which this recipe takes as its
declared Python input ``robot`` and binds to its own atlas. Blender's X, Y and Z are the part's x, y and z (Shooter's
frame, z the height out of the mount face); the exported glTF has x along +X, z along +Y and y along -Z. The origin is
the **mount anchor**, the centre of the base's first cell on the mount face. Nothing leaves the part's cuboid, at rest
or in any frame of its clips.

Both parts turn about their **mount normal** (the part's +z, glTF +Y), exactly as Shooter's mechanics model them
(crates/shooter-sim/src/mechanics.rs): ``robot.wheel`` (2 x 2 x 1 cells) is one wheel on an axle through the centre of its
cuboid, (0.1, 0.1, 0.1) m in the part frame, its tyre's rolling radius 0.18 m (Shooter's sphere: half the 40 cm
footprint less its 2 cm inset). ``robot.track`` (1 x 4 x 2 cells) is a track module whose two driven road wheels sit
where Shooter's are, (0, 0, 0.2) and (0, 0.6, 0.2) m, rolling radius 0.1 m; the belt runs round them in the part's
x-y plane (its length along y, its height along x, its width along z) and is 25 rigid links that scroll along it.

Each part is one mesh skinned rigidly to a short bone chain (every vertex weighted 1 to one bone; bones along +z with
no roll, so each glTF joint node rests unrotated in the part's axes): ``base`` (the bracket or frame fixed to the
parent), the wheels (``wheel``; ``sprocket``, ``road-1``..``road-3``, ``idler``) on their axles and the track's links
(``link-01``..``link-25``). The clip ``roll`` turns every wheel one full turn about +z (and moves the belt the matching
2 pi x 0.1 m, nine links); a renderer can also turn the wheel nodes from Shooter's joint angle and set the clip's time
from it (docs).

``arguments`` are ``part``, ``cells``, ``level`` (0 full detail, 1 and 2 are ``lod1`` and ``lod2``) and ``variant``
(``default`` or ``damaged``). No randomness: the textures come from numpy's legacy ``RandomState`` through
``kit_common.py``.

In a live Blender: ``use_sources(runpy.run_path("combat_robot.py"), runpy.run_path("kit_common.py"))``, then
``build(part, collection, level, variant)``.
"""
import math

import bpy
import numpy as np
from mathutils import Quaternion, Vector

RECIPE = "robot-locomotion-v1"
CELL = 0.2
MATERIAL = "locomotion-metal"
CLIP_FPS = 30
ROLL_FRAMES = 30  # the roll clip: one full wheel turn in one second

PARTS = {"robot.wheel": (2, 2, 1), "robot.track": (1, 4, 2)}
VARIANTS = ("default", "damaged")

# The wheel: its axle (the part's +z) through the cuboid's centre, Shooter's sphere radius as the tyre's rolling radius.
WHEEL_AXLE = (0.1, 0.1, 0.1)
WHEEL_RADIUS = 0.18
# The track: Shooter's two driven road wheels (radius 0.1 m) at the ends of the belt, the visual road wheels between.
TRACK_ROLLING_RADIUS = 0.1
TRACK_SPAN = 0.6  # between the two driven axles, along y
TRACK_Z = 0.2  # the axles' height out of the mount face (the belt's middle)
TRACK_WHEELS = (("sprocket", 0.0), ("road-1", 0.15), ("road-2", 0.3), ("road-3", 0.45), ("idler", 0.6))
# The belt: LINKS links whose pitch makes one wheel turn (2 pi x the rolling radius) exactly PITCHES_PER_TURN links, on a
# stadium path round the end axles at PITCH_RADIUS (the middle of the pads).
LINKS = 25
PITCHES_PER_TURN = 9
PITCH = 2 * math.pi * TRACK_ROLLING_RADIUS / PITCHES_PER_TURN
PITCH_RADIUS = (LINKS * PITCH - 2 * TRACK_SPAN) / (2 * math.pi)
BELT_Z = (0.04, 0.36)  # the pads' width along z
WHEEL_GAP = (0.172, 0.228)  # between a road wheel's two discs, where the links' guide horns run

# The atlas: 1024 px in 128 px units; large surfaces get 2 x 2 units.
ATLAS_EDGE = 1024
UNIT = 128
GUTTER = 4
CELLS = {
    "paint": (0, 0, 2), "gunmetal": (2, 0, 2), "steel": (4, 0, 2), "hazard": (6, 0, 2),
    "rubber": (0, 2, 2), "tyre": (2, 2, 2), "pad": (4, 2, 2), "hub": (6, 2, 2),
    "hub-damaged": (0, 4, 2), "scorch": (2, 4, 2), "paint-damaged": (4, 4, 2), "tyre-damaged": (6, 4, 2),
    "panel": (0, 6, 2), "vent": (2, 6, 2), "pad-worn": (4, 6, 2), "sprocket": (6, 6, 2),
}

R = {}  # combat_robot.py's namespace, bound to this atlas
C = {}  # kit_common.py's helpers


def use_sources(robot, common):
    """Bind the robot recipe (its Part builder and painters) to this kit's atlas, and the shared helpers."""
    R.clear()
    R.update(robot)
    R["use_common"](common)
    C.clear()
    C.update({name: common[name] for name in common["NAMES"]})
    # The robot's Part, cell_uv and mesh() read these module globals: point them at this kit's atlas.
    robot["Part"].mesh.__globals__.update({"CELLS": CELLS, "MATERIAL": MATERIAL, "cell_uv": cell_uv, "atlas_material": atlas_material})


# ---------------------------------------------------------------- atlas

def scorched(c, h, r, m, n, seed, amount=1.0):
    """Burn a surface: dark soot patches with a few bare-metal flecks (the damaged variants)."""
    soot = R["smoothstep"](0.42, 0.72, R["noise"](seed, 3, 4, n)) * amount
    fleck = R["smoothstep"](0.86, 0.93, R["noise"](seed + 1, 24, 2, n)) * amount
    c = c * (1 - 0.82 * soot[..., None])
    c = c * (1 - fleck[..., None]) + R["STEEL"][None, None] * 0.75 * fleck[..., None]
    return c, h - 0.3 * fleck, np.clip(r + 0.25 * soot - 0.2 * fleck, 0, 1), np.maximum(m, fleck * 0.9)


def paint_rubber(n, seed=9601, worn=False):
    """Tyre sidewall and road-wheel rubber: near-black, matte, faint moulding rings."""
    x, y = R["grid"](n)
    mottle = R["noise"](seed, 4, 3, n)
    colour = R["RUBBER"][None, None] * (1.5 + 0.6 * mottle[..., None])
    h = mottle * 0.1
    if worn:
        dust = R["smoothstep"](0.5, 0.8, R["noise"](seed + 3, 5, 3, n))
        colour = colour * (1 - dust[..., None]) + np.array((0.16, 0.15, 0.13))[None, None] * dust[..., None]
    return colour, h, np.full((n, n), 0.88), np.zeros((n, n)), None, 2.0


def tread(n, seed, damaged):
    """One tread block, fitted to one face of the tyre (u around the tyre, v across it): a chevron of sipes, worn
    lighter at its edges; the damaged tyre is cut and scorched."""
    x, y = R["grid"](n)
    c, h, r, m, _, _ = paint_rubber(n, seed, worn=True)
    chevron = np.abs(((x + np.abs(y - 0.5) * 0.8) * 3) % 1.0 - 0.5) < 0.06
    groove = chevron * R["box_mask"](x, y, 0.05, 0.95)
    edge = 1 - R["box_mask"](x, y, 0.06, 0.94, 0.03)
    c = c * (1 - 0.6 * groove[..., None]) + np.array((0.12, 0.12, 0.12))[None, None] * 0.6 * edge[..., None]
    h = h - groove * 0.8
    if damaged:
        cuts = R["smoothstep"](0.84, 0.9, R["noise"](seed + 7, 18, 2, n, (1.0, 0.15)))
        c, h, r, m = scorched(c * (1 - 0.7 * cuts[..., None]), h - cuts, r, m, n, seed + 11)
    return c, h, r, m, None, 5.0


def paint_pad(n, seed=9701, worn=False):
    """A track pad from outside, fitted per link (u along the belt, v across it): a steel shoe with a rubber insert
    each side of the guide slot, two bolt heads and polished wear on its edges."""
    x, y = R["grid"](n)
    c, h, r, m = R["painted"](R["GUNMETAL"] * 1.4, n, seed, 0.9)
    insert = R["box_mask"](x, y, 0.18, 0.82) * (np.abs(y - 0.5) > 0.08)
    c = c * (1 - insert[..., None]) + R["RUBBER"][None, None] * 1.8 * insert[..., None]
    bolts = sum(R["disc"](x, y, 0.5, cy, 0.05) for cy in (0.28, 0.72))
    edge = 1 - R["box_mask"](x, y, 0.05, 0.95, 0.02)
    shine = np.clip(bolts + edge * 0.7, 0, 1)
    c = c * (1 - shine[..., None]) + R["STEEL"][None, None] * 0.8 * shine[..., None]
    h = h + insert * 0.3 + bolts * 0.6 - edge * 0.3
    r = r * (1 - insert) + 0.9 * insert - 0.2 * shine
    m = np.maximum(m * (1 - insert), shine * 0.9)
    if worn:
        c, h, r, m = scorched(c, h, r, m, n, seed + 5, 0.8)
    return c, h, np.clip(r, 0.05, 1), m, None, 4.0


def paint_hub(n, seed=9801, damaged=False):
    """A wheel's face, fitted to the disc: a gunmetal dish with five spoke windows, a steel centre with five lug
    bolts, a steel rim ring and one hazard wedge, so a turning wheel reads at a distance."""
    x, y = R["grid"](n)
    dx, dy = x - 0.5, y - 0.5
    rr = np.hypot(dx, dy) * 2  # 0 at the centre, 1 at the rim
    angle = np.arctan2(dy, dx)
    c, h, r, m = R["painted"](R["GUNMETAL"] * 1.3, n, seed, 0.6)
    windows = (np.cos(5 * angle) > 0.35) * R["smoothstep"](0.42, 0.46, rr) * (1 - R["smoothstep"](0.74, 0.78, rr))
    rim = R["smoothstep"](0.82, 0.85, rr) * (1 - R["smoothstep"](0.97, 0.99, rr))
    centre = 1 - R["smoothstep"](0.27, 0.3, rr)
    lugs = sum(R["disc"](x, y, 0.5 + 0.1 * math.cos(2 * math.pi * k / 5), 0.5 + 0.1 * math.sin(2 * math.pi * k / 5), 0.022) for k in range(5))
    wedge = (np.abs(np.angle(np.exp(1j * (angle - math.pi / 5)))) < 0.22) * R["smoothstep"](0.78, 0.8, rr) * (1 - R["smoothstep"](0.82, 0.84, rr))
    wedge = wedge + (np.abs(np.angle(np.exp(1j * (angle - math.pi / 5)))) < 0.32) * R["smoothstep"](0.5, 0.52, rr) * (1 - R["smoothstep"](0.74, 0.76, rr)) * (np.cos(5 * angle) <= 0.35)
    steel = np.clip(rim + centre + lugs, 0, 1)
    hazard = R["painted"](R["HAZARD"], n, seed + 3, 0.7)[0]
    c = c * (1 - steel[..., None]) + R["STEEL"][None, None] * (0.85 + 0.15 * lugs[..., None]) * steel[..., None]
    c = c * (1 - np.clip(wedge, 0, 1)[..., None]) + hazard * np.clip(wedge, 0, 1)[..., None]
    c = c * (1 - 0.85 * windows[..., None])
    h = h - windows * 0.9 + rim * 0.4 + centre * 0.5 + lugs * 0.6
    r = r * (1 - steel) + 0.3 * steel
    m = np.maximum(m, steel * 0.95)
    if damaged:
        crack = (np.abs(angle - 2.2) < 0.02 + 0.03 * rr) * (rr > 0.3) * (rr < 0.9)
        c, h, r, m = scorched(c * (1 - 0.9 * crack[..., None]), h - crack, r, m, n, seed + 9)
    return c, h, np.clip(r, 0.05, 1), m, None, 5.0


def paint_sprocket(n):
    """The drive sprocket's face: bare steel with a dark hub and six lightening holes."""
    x, y = R["grid"](n)
    dx, dy = x - 0.5, y - 0.5
    rr = np.hypot(dx, dy) * 2
    angle = np.arctan2(dy, dx)
    c, h, r, m, _, _ = R["paint_steel"](n)
    holes = sum(R["disc"](x, y, 0.5 + 0.28 * math.cos(2 * math.pi * k / 6), 0.5 + 0.28 * math.sin(2 * math.pi * k / 6), 0.07) for k in range(6))
    hub = 1 - R["smoothstep"](0.2, 0.23, rr)
    dark = np.clip(holes + hub * 0.8, 0, 1)
    marker = (np.abs(angle) < 0.12) * (rr > 0.72) * (rr < 0.9)
    c = c * (1 - 0.88 * dark[..., None])
    c = c * (1 - marker[..., None]) + R["HAZARD"][None, None] * marker[..., None]
    return c, h - holes * 0.9 + hub * 0.3, r + 0.3 * dark, m * (1 - 0.5 * dark), None, 4.0


def damaged_flat(base, seed):
    def painter(n):
        c, h, r, m = R["painted"](base, n, seed, 1.3)
        dents = R["smoothstep"](0.62, 0.8, R["noise"](seed + 2, 6, 3, n))
        c, h, r, m = scorched(c, h - 0.6 * dents, r, m, n, seed + 4)
        return c, h, r, m, None, 4.0
    return painter


PAINTERS = {
    "paint": lambda n: R["paint_flat"](R["PAINT"], 9201)(n),
    "gunmetal": lambda n: R["paint_flat"](R["GUNMETAL"], 9221, 0.6)(n),
    "steel": lambda n: R["paint_steel"](n),
    "hazard": lambda n: R["paint_hazard"](n),
    "panel": lambda n: R["paint_panel"](n),
    "vent": lambda n: R["paint_vent"](n),
    "rubber": paint_rubber,
    "tyre": lambda n: tread(n, 9611, False),
    "tyre-damaged": lambda n: tread(n, 9611, True),
    "pad": paint_pad,
    "pad-worn": lambda n: paint_pad(n, 9701, worn=True),
    "hub": paint_hub,
    "hub-damaged": lambda n: paint_hub(n, 9801, damaged=True),
    "sprocket": paint_sprocket,
    "scorch": lambda n: damaged_flat(R["GUNMETAL"] * 1.2, 9901)(n),
    "paint-damaged": lambda n: damaged_flat(R["PAINT"], 9911)(n),
}


def paint_atlas():
    edge = ATLAS_EDGE
    colour = np.zeros((edge, edge, 3))
    normal = np.zeros((edge, edge, 3)) + np.array((0.5, 0.5, 1.0))
    orm = np.ones((edge, edge, 3))
    emissive = np.zeros((edge, edge, 3))
    for name, (ux, uy, size) in CELLS.items():
        px = size * UNIT
        n = px - 2 * GUTTER
        c, height, rough, metal, glow, strength = PAINTERS[name](n)
        nm = C["normal_map"](height, strength * 0.3)
        o = np.ones((n, n, 3))
        o[..., 1] = np.clip(rough, 0.04, 1)
        o[..., 2] = np.clip(metal, 0, 1)
        g = np.zeros((n, n, 3)) if glow is None else glow
        x0, y0 = ux * UNIT, uy * UNIT
        for target, pixels in ((colour, c), (normal, nm), (orm, o), (emissive, g)):
            target[y0:y0 + px, x0:x0 + px] = np.pad(pixels, ((GUTTER, GUTTER), (GUTTER, GUTTER), (0, 0)), mode="edge")
    return np.clip(colour, 0, 1), normal, orm, np.clip(emissive, 0, 1)


def atlas_material():
    """The kit's single opaque material, ``locomotion-metal``; the atlas is painted once per Blender session."""
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
    ux, uy, size = CELLS[cell]
    px = size * UNIT
    inner = px - 2 * GUTTER
    return ((ux * UNIT + GUTTER + u * inner) / ATLAS_EDGE, 1 - (uy * UNIT + GUTTER + (1 - v) * inner) / ATLAS_EDGE)


# ---------------------------------------------------------------- geometry helpers

def sides_for(lvl, full):
    return full if lvl == 0 else max(6, full // 2) if lvl == 1 else max(4, full // 4)


def lathe(p, centre, profile, sides, cells, radius=None):
    """A closed solid of revolution about the part's +z through ``centre`` (x, y): ``profile`` is a closed loop of
    (r, z) points, ``cells`` the cell of each profile segment (a cell name, or (cell, "fit")). ``radius(k, i, r)``
    may change point i's radius at angle k (tread lugs, damage)."""
    cx, cy = centre
    rings = []
    for k in range(sides):
        a = 2 * math.pi * k / sides
        ring = []
        for i, (r, z) in enumerate(profile):
            rad = radius(k, i, r) if radius else r
            ring.append(p.bm.verts.new(Vector((cx + rad * math.cos(a), cy + rad * math.sin(a), z))))
        rings.append(ring)
    n = len(profile)
    for i in range(n):
        cell, mode = cells[i] if isinstance(cells[i], tuple) else (cells[i], "planar")
        faces = []
        for k in range(sides):
            a, b = rings[k], rings[(k + 1) % sides]
            faces.append(p.bm.faces.new((a[i], b[i], b[(i + 1) % n], a[(i + 1) % n])))
        p.tag(faces, cell, mode)


def star_disc(p, centre, z0, z1, teeth, r_root, r_tip, side_cell, cap_cell):
    """A toothed disc (a sprocket) between z0 and z1 about the part's +z through ``centre``."""
    pts = []
    for t in range(teeth):
        for f, r in ((0.0, r_root), (0.2, r_tip), (0.5, r_tip), (0.7, r_root)):
            a = 2 * math.pi * (t + f) / teeth
            pts.append((centre[0] + r * math.cos(a), centre[1] + r * math.sin(a)))
    lo = [p.bm.verts.new(Vector((x, y, z0))) for x, y in pts]
    hi = [p.bm.verts.new(Vector((x, y, z1))) for x, y in pts]
    n = len(pts)
    p.tag([p.bm.faces.new((lo[s], lo[(s + 1) % n], hi[(s + 1) % n], hi[s])) for s in range(n)], side_cell)
    p.tag([p.bm.faces.new(list(reversed(lo))), p.bm.faces.new(hi)], cap_cell, "fit")


def obox(p, centre, axes, half, cell, mode="planar"):
    """A box at ``centre`` with unit ``axes`` (three orthogonal vectors) and half sizes ``half``."""
    import bmesh
    ret = bmesh.ops.create_cube(p.bm, size=2.0)
    for v in ret["verts"]:
        c = v.co.copy()
        v.co = Vector(centre) + sum((Vector(axes[i]) * c[i] * half[i] for i in range(3)), Vector())
    faces = list(dict.fromkeys(f for v in ret["verts"] for f in v.link_faces))
    p.tag(faces, cell, mode)
    return faces


def use(p, name):
    """Build the following geometry on bone ``name``."""
    p.current = [b[0] for b in p.bones].index(name)


# ---------------------------------------------------------------- the wheel

LUGS = 12


def wheel(p):
    """A 40 cm driven wheel: a square bracket on the mount cell and a bearing housing round the axle (fixed to the
    parent), then the turning wheel: a steel axle, a gunmetal rim with a five-spoke face and a hazard wedge, and a
    chunky lugged tyre whose outer radius is Shooter's 0.18 m. The damaged wheel has a scorched, cracked face, a torn
    tread sector and a dented rim."""
    lvl, damaged = p.level, p.variant == "damaged"
    ax, ay, az = WHEEL_AXLE
    s = sides_for(lvl, 48 if lvl == 0 else 32)
    bevel = 0.004 if lvl == 0 else 0.0
    hub = "hub-damaged" if damaged else "hub"
    # The base: the mount bracket over the socket cell and the bearing housing on the axle.
    p.planar_centre, p.planar_span = Vector((ax, ay, az)), 0.5
    if lvl == 2:
        p.box((-0.085, -0.085, 0), (0.085, 0.085, 0.03), "gunmetal")
    else:
        p.box((-0.088, -0.088, 0), (0.088, 0.088, 0.02), "scorch" if damaged else "gunmetal", bevel=bevel)
        p.cylinder((ax, ay, 0.0), (0, 0, 1), 0.058, 0.038, sides_for(lvl, 20), "paint-damaged" if damaged else "paint", cap="steel")
        p.cylinder((ax, ay, 0.022), (0, 0, 1), 0.061, 0.01, sides_for(lvl, 20), "hazard")
        if lvl == 0:
            for sx, sy in ((-1, -1), (1, -1), (-1, 1)):
                p.cylinder((sx * 0.066, sy * 0.066, 0.02), (0, 0, 1), 0.008, 0.005, 6, "steel", cap="steel")
    p.bone("wheel", WHEEL_AXLE, "base")
    if lvl == 2:
        p.cylinder((ax, ay, 0.045), (0, 0, 1), WHEEL_RADIUS, 0.15, s, "rubber", cap=hub)
        return {}
    p.cylinder((ax, ay, 0.03), (0, 0, 1), 0.026, 0.03, sides_for(lvl, 12), "steel")
    # The rim, inside the tyre, with a wheel face either side.
    p.cylinder((ax, ay, 0.05), (0, 0, 1), 0.124, 0.138, sides_for(lvl, 32), "gunmetal", cap=hub)
    # The tyre: a lathe of its cross-section; at full detail the tread is LUGS blocks.
    profile = [(0.118, 0.045), (0.16, 0.045), (0.174, 0.054), (WHEEL_RADIUS, 0.068), (WHEEL_RADIUS, 0.172), (0.174, 0.186), (0.16, 0.195), (0.118, 0.195)]
    cells = ["rubber", "rubber", "rubber", ("tyre-damaged" if damaged else "tyre", "fit"), "rubber", "rubber", "rubber", "gunmetal"]
    torn = set(range(int(s * 0.1), int(s * 0.32))) if damaged else set()

    def radius(k, i, r):
        if r < 0.165:
            return r
        groove = lvl == 0 and (k // 2) % 2 == 1
        cut = k in torn
        return r - (0.009 if groove else 0.0) - (0.016 if cut else 0.0)
    lathe(p, (ax, ay), profile, s, cells, radius)
    if lvl == 0:
        # The hub cap and five lug nuts on the outer face.
        p.cylinder((ax, ay, 0.188), (0, 0, 1), 0.04, 0.01, 16, "steel", cap="steel")
        for k in range(5):
            if damaged and k == 2:
                continue
            a = 2 * math.pi * k / 5 + 0.3
            p.cylinder((ax + 0.062 * math.cos(a), ay + 0.062 * math.sin(a), 0.188), (0, 0, 1), 0.008, 0.006, 6, "steel", cap="steel")
        if damaged:  # a dent knocked into the rim's outer lip
            obox(p, (ax + 0.1, ay - 0.06, 0.17), ((0.86, -0.51, 0), (0.51, 0.86, 0), (0, 0, 1)), (0.012, 0.03, 0.012), "scorch")
    return {}


# ---------------------------------------------------------------- the track

def belt_length():
    return 2 * TRACK_SPAN + 2 * math.pi * PITCH_RADIUS


def belt_point(s):
    """The belt's path at arc length ``s``: position (x, y) in the part frame and the tangent's angle about +z. The belt
    runs anticlockwise seen from +z (up the +x side, down the -x side), so a positive turn of the wheels about +z moves
    every link forward along it."""
    s %= belt_length()
    rp, span = PITCH_RADIUS, TRACK_SPAN
    arc = math.pi * rp
    if s < span:
        return (rp, s), math.pi / 2
    s -= span
    if s < arc:
        phi = s / rp
        return (rp * math.cos(phi), span + rp * math.sin(phi)), phi + math.pi / 2
    s -= arc
    if s < span:
        return (-rp, span - s), -math.pi / 2
    s -= span
    phi = math.pi + s / rp
    return (rp * math.cos(phi), rp * math.sin(phi)), phi + math.pi / 2


def link_axes(angle):
    """A link's (outward, along, across) axes in the part frame at a tangent angle."""
    t = Vector((math.cos(angle), math.sin(angle), 0))
    return (Vector((t.y, -t.x, 0)), t, Vector((0, 0, 1)))


def track(p):
    """An 80 cm track module: a frame plate on the mount face with axle housings, the drive sprocket and the idler on
    Shooter's two driven axles, three road wheels between (each two rubber-tyred discs with a gap for the guide horns),
    and a belt of 25 steel-shod links with grousers and centre guide horns. The damaged track has a scorched, dented
    frame, a road wheel with its outer disc shot away, a cracked idler and worn, burnt pads."""
    lvl, damaged = p.level, p.variant == "damaged"
    bevel = 0.004 if lvl == 0 else 0.0
    p.planar_centre, p.planar_span = Vector((0, 0.3, 0.2)), 0.9
    frame = "scorch" if damaged else "gunmetal"
    hub = "hub-damaged" if damaged else "hub"
    span = TRACK_SPAN
    # The frame: a plate along the mount face (inside the belt's loop, below its width) with an axle housing per wheel.
    if lvl == 2:
        p.box((-0.08, -0.08, 0), (0.08, span + 0.08, 0.035), frame)
    else:
        p.box((-0.082, -0.082, 0), (0.082, span + 0.082, 0.026), frame, bevel=bevel)
        p.box((-0.05, 0.04, 0.026), (0.05, span - 0.04, 0.034), "paint-damaged" if damaged else "paint", bevel=bevel / 2)
        for _, y in TRACK_WHEELS:
            p.cylinder((0, y, 0.02), (0, 0, 1), 0.034, 0.018, sides_for(lvl, 8), "steel", cap="steel")
        if lvl == 0:
            for y in (-0.06, span + 0.045):
                p.box((-0.07, y, 0.026), (0.07, y + 0.015, 0.032), "hazard")
            if damaged:  # the frame's end bent and torn by a hit
                obox(p, (0.05, span + 0.06, 0.03), ((0.94, 0.34, 0), (-0.34, 0.94, 0), (0, 0, 1)), (0.025, 0.012, 0.008), "scorch")
    # The wheels: Shooter's two driven ones at the ends (sprocket, idler) and three road wheels between.
    for name, y in TRACK_WHEELS:
        p.bone(name, (0, y, TRACK_Z), "base")
        driven = name in ("sprocket", "idler")
        if lvl == 2:
            if driven:
                p.cylinder((0, y, 0.05), (0, 0, 1), 0.07, 0.29, 6, "gunmetal", cap="sprocket" if name == "sprocket" else hub)
            continue
        s = sides_for(lvl, 12)
        p.cylinder((0, y, 0.034), (0, 0, 1), 0.024, 0.32, 6, "steel", cap="steel")
        if lvl == 1:
            cap = "sprocket" if name == "sprocket" else hub
            p.cylinder((0, y, 0.05), (0, 0, 1), 0.07, 0.29, s, "gunmetal" if driven else "rubber", cap=cap)
            continue
        shot_away = damaged and name == "road-2"
        for z0, z1 in ((0.05, WHEEL_GAP[0]), (WHEEL_GAP[1], 0.342)):
            if shot_away and z0 > 0.1:
                p.cylinder((0, y, z0), (0, 0, 1), 0.04, 0.02, 8, "scorch", cap="scorch")  # the stub left on the hub
                continue
            if name == "sprocket":
                star_disc(p, (0, y), z0, z1, 9, 0.064, 0.0735, "steel", "sprocket")
            else:
                cap = "hub-damaged" if (damaged and name == "idler") else hub
                p.cylinder((0, y, z0), (0, 0, 1), 0.07, z1 - z0, s, "gunmetal" if name == "idler" else "rubber", cap=cap)
        if not shot_away:
            p.cylinder((0, y, 0.342), (0, 0, 1), 0.026, 0.012, 6, "steel", cap="steel")
    # The belt: LINKS rigid links, each on its own bone at its pad's middle on the pitch line.
    pad, grouser, horn = "pad-worn" if damaged else "pad", "gunmetal", "steel"
    for i in range(LINKS):
        (x, y), angle = belt_point(i * PITCH)
        p.bone(f"link-{i + 1:02d}", (x, y, TRACK_Z), "base")
        if lvl == 2:
            continue
        out, along, across = link_axes(angle)
        centre = Vector((x, y, (BELT_Z[0] + BELT_Z[1]) / 2))
        half_width = (BELT_Z[1] - BELT_Z[0]) / 2
        # The shoe: inner face 0.0788 from the axle, outer 0.0908; the grouser to 0.0985 (inside the cuboid on the arcs).
        p_in, p_out = -0.008, 0.004
        shoe = obox(p, centre + out * ((p_in + p_out) / 2), (out, along, across), ((p_out - p_in) / 2, PITCH * 0.43, half_width), grouser)
        p.tag([f for f in shoe if f.normal_update() or f.normal.dot(out) > 0.9], pad, "fit")
        if lvl == 1:
            continue
        # Full detail: the grouser bar across the shoe and the guide horn on its inside.
        obox(p, centre + out * (p_out + 0.00385), (out, along, across), (0.00385, PITCH * 0.13, half_width - 0.01), grouser)
        obox(p, Vector((x, y, TRACK_Z)) + out * (p_in - 0.0075), (out, along, across), (0.0075, PITCH * 0.22, 0.016), horn)
    if lvl == 2:
        # Far away the belt is one closed band on the frame (the link nodes stay, without geometry).
        use(p, "base")
        band(p, pad)
    return {}


def band(p, cell):
    """The belt as one closed stadium band: four arc points round each end axle, the straights between."""
    pts = []
    for centre, start in (((0.0, TRACK_SPAN), 0.0), ((0.0, 0.0), math.pi)):
        for k in range(6):
            a = start + math.pi * k / 5
            pts.append((centre, a))
    verts = []
    for (cx, cy), a in pts:
        ring = []
        for r, z in ((PITCH_RADIUS - 0.008, BELT_Z[0]), (PITCH_RADIUS + 0.0115, BELT_Z[0]), (PITCH_RADIUS + 0.0115, BELT_Z[1]), (PITCH_RADIUS - 0.008, BELT_Z[1])):
            ring.append(p.bm.verts.new(Vector((cx + r * math.cos(a), cy + r * math.sin(a), z))))
        verts.append(ring)
    n = len(verts)
    for k in range(n):
        a, b = verts[k], verts[(k + 1) % n]
        p.tag([p.bm.faces.new((a[i], b[i], b[(i + 1) % 4], a[(i + 1) % 4])) for i in range(4)], cell)


BUILDERS = {"robot.wheel": wheel, "robot.track": track}


# ---------------------------------------------------------------- the roll clip

def bone_frame(v):
    """A part-frame vector in a bone's own axes (bones run along +z with no roll: X = x, Y = z, Z = -y)."""
    return Vector((v[0], v[2], -v[1]))


def roll_keys(key):
    """Per frame of the roll clip (one full wheel turn about +z): each wheel's angle, and each link's offset and turn
    from its rest place, the belt moving 2 pi x the rolling radius (PITCHES_PER_TURN links)."""
    frames = []
    for f in range(ROLL_FRAMES + 1):
        t = f / ROLL_FRAMES
        angle = 2 * math.pi * t
        keys = {}
        wheels = ["wheel"] if key == "robot.wheel" else [name for name, _ in TRACK_WHEELS]
        for name in wheels:
            keys[name] = {"rot": angle}
        if key == "robot.track":
            shift = PITCHES_PER_TURN * PITCH * t
            for i in range(LINKS):
                (x0, y0), a0 = belt_point(i * PITCH)
                (x1, y1), a1 = belt_point(i * PITCH + shift)
                # About the link's own pivot: turn by the tangent's change, then move the pivot along the path.
                keys[f"link-{i + 1:02d}"] = {"rot": a1 - a0, "loc": (x1 - x0, y1 - y0, 0.0)}
        frames.append(keys)
    return frames


def add_roll(obj, key):
    """Bake the roll clip as one NLA track (one glTF animation): rotations keyed every frame, each quaternion kept on
    the same hemisphere as the one before, so nothing flips between samples."""
    rig = obj.parent
    rig.animation_data_create()
    action = bpy.data.actions.new("roll")
    rig.animation_data.action = action
    previous = {}
    for frame, keys in enumerate(roll_keys(key)):
        for bone, values in keys.items():
            pose = rig.pose.bones[bone]
            q = Quaternion(bone_frame((0, 0, 1)), values["rot"])
            if bone in previous and previous[bone].dot(q) < 0:
                q.negate()
            previous[bone] = q
            pose.rotation_quaternion = q
            pose.keyframe_insert("rotation_quaternion", frame=frame, group=bone)
            if "loc" in values:
                pose.location = bone_frame(values["loc"])
                pose.keyframe_insert("location", frame=frame, group=bone)
    for curve in getattr(action, "fcurves", []):
        for point in curve.keyframe_points:
            point.interpolation = "LINEAR"
    rig.animation_data.action = None
    track = rig.animation_data.nla_tracks.new()
    track.name = "roll"
    track.strips.new("roll", 0, action)
    for pose in rig.pose.bones:
        pose.location, pose.rotation_quaternion, pose.scale = (0, 0, 0), (1, 0, 0, 0), (1, 1, 1)


def build(key, collection, level=0, variant="default", location=(0, 0, 0)):
    """One part as one mesh skinned to its armature (``obj.parent``, which ``location`` moves), origin at its mount
    anchor, with its roll clip as an NLA track."""
    p = R["Part"](key, PARTS[key], level, variant)
    info = BUILDERS[key](p) or {}
    obj = p.mesh(key, collection)
    obj.parent.location = location
    info["bones"] = [{"name": name, "head": [round(c, 6) for c in head], "parent": parent} for name, head, parent in p.bones]
    add_roll(obj, key)
    info["states"] = ["roll"]
    return obj, info


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or set(arguments) != {"schemaVersion", "part", "cells", "level", "variant"}:
        raise ValueError("robot-locomotion arguments must be {schemaVersion: 1, part, cells, level, variant}")
    if arguments["part"] not in PARTS:
        raise ValueError(f"robot-locomotion part must be one of {', '.join(PARTS)}")
    if tuple(arguments["cells"]) != PARTS[arguments["part"]]:
        raise ValueError(f"{arguments['part']} is {PARTS[arguments['part']]} cells, not {arguments['cells']}")
    if arguments["level"] not in (0, 1, 2):
        raise ValueError("robot-locomotion level must be 0, 1 or 2")
    if arguments["variant"] not in VARIANTS:
        raise ValueError(f"robot-locomotion variant must be one of {', '.join(VARIANTS)}")
    if set(inputs) != {"common", "robot"}:
        raise ValueError("robot-locomotion takes exactly the inputs 'common' (kit_common.py) and 'robot' (combat_robot.py)")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_sources(inputs.load_source("robot"), inputs.load_source("common"))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    key, level, variant = arguments["part"], arguments["level"], arguments["variant"]
    obj, info = build(key, bpy.context.scene.collection, level, variant)
    bpy.context.scene.render.fps = CLIP_FPS
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    rig = obj.parent
    obj.parent = None  # glTF ignores a skinned mesh's parents: the mesh is a root node beside its skeleton
    rig.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO",
        export_animations=True, export_skins=True, export_morph=False, export_cameras=False, export_lights=False, export_extras=False,
        export_animation_mode="NLA_TRACKS", export_force_sampling=True, export_frame_step=1, export_optimize_animation_size=True,
        export_reset_pose_bones=True)
    triangles = sum(len(polygon.vertices) - 2 for polygon in obj.data.polygons)
    return {"recipe": RECIPE, "part": key, "level": level, "variant": variant, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "mount-anchor", "triangleCount": triangles, **info}
