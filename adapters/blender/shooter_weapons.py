"""Shooter weapons and weapon mods (docs/shooter-weapons.md, #594): socket-grid weapon parts on one procedural atlas.

The companion of the robot part kit (``combat_robot.py``, docs/combat-robot-kit.md), built on the same convention and
the same ``Part`` builder, which this recipe takes as its declared Python input ``robot`` and binds to its own atlas.
Blender's X, Y and Z are the part's x, y and z (Shooter's frame, z the height); the exported glTF has x along +X, z
along +Y and y along -Z. The origin is the **mount anchor**, the centre of the base's first cell on the mount face (the
part's -z face). A light weapon is 1 x 1 x 2 cells, a heavy one (rail gun, rocket launcher) 1 x 2 x 2; nothing leaves
that cuboid at rest.

Every weapon points out of its socket: its barrel, emitter, hook or blade runs along the part's +z, the muzzle at the
far end. Its "up" (sights, the top of the blade's swing) is the part's +y. Each weapon is one mesh skinned rigidly to a
short bone chain (every vertex weighted 1 to one bone, bones along +z with no roll, so each glTF joint node rests
unrotated in the part's axes): the moving pieces (barrel, pump, hook and claws, blade, rails, rockets) and the two
emissive channels, ``glow-charge`` and ``glow-fire``. A channel's glow geometry sits proud of a dark housing; its node's
scale is the channel's level (1 lit, as modelled; 0 hidden in its housing). The states are glTF animations, one NLA
track each (``STATES``).

Mods are small static add-ons in their own frame: the origin is the point they sit on (a weapon's ``mod-side`` or
``mod-muzzle`` anchor), their +z (glTF +Y) the anchor's outward normal and their +y (glTF -Z) the anchor's ``up``.

``arguments`` are ``part``, ``level`` (0 full detail, 1 and 2 are ``lod1`` and ``lod2``). No randomness: textures come
from numpy's legacy ``RandomState`` through ``kit_common.py``.

In a live Blender: ``use_sources(runpy.run_path("combat_robot.py"), runpy.run_path("kit_common.py"))``, then
``build(part, collection, level)``.
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

RECIPE = "shooter-weapons-v1"
CELL = 0.2
MATERIAL = "weapon-metal"
CLIP_FPS = 30

# Part key -> (cells x, y, z), or None for a mod (no cells: it sits on an anchor, not a socket).
PARTS = {
    "weapon.energy-rifle": (1, 1, 2),
    "weapon.shotgun": (1, 1, 2),
    "weapon.laser": (1, 1, 2),
    "weapon.flamethrower": (1, 1, 2),
    "weapon.grapple-hook": (1, 1, 2),
    "weapon.energy-blade": (1, 1, 2),
    "weapon.rail-gun": (1, 2, 2),
    "weapon.rocket-launcher": (1, 2, 2),
    "mod.rapid-cycler": None,
    "mod.overcharger": None,
    "mod.long-barrel": None,
    "mod.efficiency-coil": None,
}

# Shooter's weapon energy colours (crates/shooter-client/src/effects.rs `tint`, linear), one glow per weapon, so a
# weapon reads by colour as well as by silhouette.
TINT = {
    "rifle": (0.25, 0.8, 1.0), "rail": (0.75, 0.35, 1.0), "rocket": (1.0, 0.55, 0.15), "grapple": (0.45, 1.0, 0.55),
    "blade": (1.0, 0.25, 0.6), "shotgun": (1.0, 0.85, 0.3), "laser": (1.0, 0.15, 0.1), "flame": (1.0, 0.4, 0.05),
}

# The atlas: 1024 px in 128 px units. Large surfaces get 2 x 2 units, glows and small swatches one.
ATLAS_EDGE = 1024
UNIT = 128
GUTTER = 4
CELLS = {
    "paint": (0, 0, 2), "gunmetal": (2, 0, 2), "steel": (4, 0, 2), "hazard": (6, 0, 2),
    "vent": (0, 2, 2), "panel": (2, 2, 2), "olive": (4, 2, 2), "coil": (6, 2, 2),
    "glow-rifle": (0, 4, 1), "glow-rail": (1, 4, 1), "glow-rocket": (2, 4, 1), "glow-grapple": (3, 4, 1),
    "glow-blade": (4, 4, 1), "glow-shotgun": (5, 4, 1), "glow-laser": (6, 4, 1), "glow-flame": (7, 4, 1),
    "bore": (0, 5, 1), "grip": (1, 5, 1), "lens-laser": (2, 5, 1), "warhead": (3, 5, 1),
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
    # The robot's Part, cell_uv and mesh() read these module globals (the module's own dict, which runpy only copies
    # for its caller): point them at the weapon atlas.
    robot["Part"].mesh.__globals__.update({"CELLS": CELLS, "MATERIAL": MATERIAL, "cell_uv": cell_uv, "atlas_material": atlas_material})


# ---------------------------------------------------------------- atlas

def srgb(linear):
    c = np.clip(np.array(linear, dtype=float), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def paint_glow(tint):
    """A lit swatch: the weapon's energy colour, brightening to near white at the centre (the glow pieces are small)."""
    glow = srgb(tint)

    def painter(n):
        x, y = R["grid"](n)
        hot = np.clip(1 - np.hypot(x - 0.5, y - 0.5) * 1.6, 0, 1) ** 2
        g = glow[None, None] * (1 - 0.5 * hot[..., None]) + np.ones(3)[None, None] * 0.5 * hot[..., None]
        return g * 0.6, np.zeros((n, n)), np.full((n, n), 0.2), np.zeros((n, n)), g, 0.5
    return painter


def paint_blade(n):
    """The plasma blade, fitted across its width (u): a white-hot core fading to the blade's magenta edges."""
    x, y = R["grid"](n)
    core = np.clip(1 - np.abs(x - 0.5) * 2.4, 0, 1) ** 1.5
    tint = srgb(TINT["blade"])
    g = tint[None, None] * (1 - core[..., None]) + np.array((1.0, 0.9, 0.95))[None, None] * core[..., None]
    return g * 0.7, np.zeros((n, n)), np.full((n, n), 0.1), np.zeros((n, n)), g, 0.5


def paint_coil(n):
    """Copper windings across v, in a dark frame."""
    x, y = R["grid"](n)
    turns = np.abs(((y * 14) % 1.0) - 0.5) * 2
    copper = np.array((0.72, 0.4, 0.2))
    colour = copper[None, None] * (0.7 + 0.3 * turns[..., None])
    return colour, turns * 0.6, 0.3 + 0.1 * turns, np.full((n, n), 0.95), None, 3.0


def paint_bore(n):
    """A gun's bore or a tube's dark interior: near black, rough, with a faint steel ring at the edge."""
    x, y = R["grid"](n)
    r = np.hypot(x - 0.5, y - 0.5)
    ring = R["smoothstep"](0.38, 0.42, r)
    colour = np.array((0.02, 0.02, 0.025))[None, None] * (1 - ring[..., None]) + R["STEEL"][None, None] * 0.5 * ring[..., None]
    return colour, -0.5 * (1 - ring), 0.7 - 0.4 * ring, ring * 0.9, None, 2.0


def paint_grip(n):
    """Ribbed rubber grip."""
    x, y = R["grid"](n)
    ribs = np.abs(((y * 10) % 1.0) - 0.5) * 2
    colour = R["RUBBER"][None, None] * (1.4 + 1.2 * ribs[..., None])
    return colour, ribs * 0.8, np.full((n, n), 0.85), np.zeros((n, n)), None, 4.0


def paint_lens(n):
    """The laser's focusing lens: dark red glass with a lit core and a ring."""
    x, y = R["grid"](n)
    r = np.hypot(x - 0.5, y - 0.5)
    tint = srgb(TINT["laser"])
    core = np.clip(1 - r * 3.2, 0, 1) ** 1.5
    ring = R["smoothstep"](0.3, 0.33, r) * (1 - R["smoothstep"](0.37, 0.4, r))
    glow = tint[None, None] * (core + 0.7 * ring)[..., None] + np.ones(3)[None, None] * 0.6 * (core ** 3)[..., None]
    glass = np.array((0.08, 0.01, 0.01))
    return glass[None, None] + glow * 0.6, ring * 0.2, np.full((n, n), 0.08), np.zeros((n, n)), np.clip(glow, 0, 1), 1.0


def paint_warhead(n):
    """A rocket's warhead: orange-red paint with a black band."""
    x, y = R["grid"](n)
    band = (np.abs(y - 0.3) < 0.06)
    c, h, r, m = R["painted"](np.array((0.8, 0.22, 0.06)), n, 9951, 0.6)
    return c * (1 - 0.9 * band[..., None]), h, r, m, None, 3.0


PAINTERS = {
    "paint": lambda n: R["paint_flat"](R["PAINT"], 9201)(n),
    "gunmetal": lambda n: R["paint_flat"](R["GUNMETAL"], 9221, 0.6)(n),
    "steel": lambda n: R["paint_steel"](n),
    "hazard": lambda n: R["paint_hazard"](n),
    "vent": lambda n: R["paint_vent"](n),
    "panel": lambda n: R["paint_panel"](n),
    "olive": lambda n: R["paint_flat"](R["ARMOR"], 9811)(n),
    "coil": paint_coil,
    "bore": paint_bore,
    "grip": paint_grip,
    "lens-laser": paint_lens,
    "warhead": paint_warhead,
    "glow-blade": paint_blade,
    **{f"glow-{name}": paint_glow(tint) for name, tint in TINT.items() if name != "blade"},
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
    """The kit's single opaque material, ``weapon-metal``; the atlas is painted once per Blender session."""
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
    tree.links.new(texture("weapon-metal-colour", colour, True).outputs["Color"], bsdf.inputs["Base Color"])
    normal_node = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(texture("weapon-metal-normal", normal, False).outputs["Color"], normal_node.inputs["Color"])
    tree.links.new(normal_node.outputs["Normal"], bsdf.inputs["Normal"])
    separate = tree.nodes.new("ShaderNodeSeparateColor")
    tree.links.new(texture("weapon-metal-orm", orm, False).outputs["Color"], separate.inputs["Color"])
    tree.links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    tree.links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    tree.links.new(texture("weapon-metal-emissive", emissive, True).outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    return mat


def cell_uv(cell, u, v):
    """A cell-local (u, v) in [0, 1] (v up) as an atlas coordinate, inside the cell's gutter."""
    ux, uy, size = CELLS[cell]
    px = size * UNIT
    inner = px - 2 * GUTTER
    return ((ux * UNIT + GUTTER + u * inner) / ATLAS_EDGE, 1 - (uy * UNIT + GUTTER + (1 - v) * inner) / ATLAS_EDGE)


# ---------------------------------------------------------------- geometry helpers

def new_part(key, level):
    cells = PARTS[key] or (1, 1, 1)
    p = R["Part"](key, cells, level, "default")
    # Planar surfaces: half a metre round the part's middle fills a large cell (about 470 px a metre).
    p.planar_centre, p.planar_span = Vector((0, 0.1 if cells[1] == 2 else 0, 0.2)), 0.5
    return p


def use(p, name):
    """Build the following geometry on bone ``name``."""
    p.current = [b[0] for b in p.bones].index(name)


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


def prism(p, rings, cell, mode="fit", tip=None, caps=("bore", "bore")):
    """A closed loft through ``rings`` (each a list of the same number of points), capped at both ends or closed to
    the point ``tip`` at the far end."""
    verts = [[p.bm.verts.new(Vector(pt)) for pt in ring] for ring in rings]
    n = len(rings[0])
    sides = []
    for a, b in zip(verts, verts[1:]):
        for s in range(n):
            sides.append(p.bm.faces.new((a[s], a[(s + 1) % n], b[(s + 1) % n], b[s])))
    start = p.bm.faces.new(list(reversed(verts[0])))
    p.tag(sides, cell, mode)
    p.tag([start], caps[0], "fit")
    if tip is None:
        end = p.bm.faces.new(verts[-1])
        p.tag([end], caps[1], "fit")
    else:
        t = p.bm.verts.new(Vector(tip))
        ends = [p.bm.faces.new((verts[-1][s], verts[-1][(s + 1) % n], t)) for s in range(n)]
        p.tag(ends, cell, mode)


def mount(p, y_hi=0.1, neck=0.05):
    """The mount plate on the mount face and a short neck: every weapon's breech end."""
    lvl = p.level
    bevel = 0.004 if lvl == 0 else 0.0
    light = y_hi < 0.2
    if lvl == 2:  # one block up to where the body starts
        p.box((-0.085, -0.085, 0), (0.085, y_hi - 0.015, neck if light else 0.02), "gunmetal")
        return
    p.box((-0.085, -0.085, 0), (0.085, y_hi - 0.015, 0.02), "gunmetal", bevel=bevel)
    cy = (y_hi - 0.1) / 2
    p.cylinder((0, cy, 0.02), (0, 0, 1), 0.05, 0.012, 16 if lvl == 0 else 8, "steel")
    if light:
        p.box((-0.035, -0.045, 0.02), (0.035, 0.045, neck), "gunmetal")


def mod_rail(p, x, y, z, length=0.11):
    """The mod hardpoint on the weapon's -x side: a dark rail the side mods clamp to."""
    if p.level == 2:
        return
    p.box((x - 0.006, y - 0.03, z - length / 2), (x, y + 0.03, z + length / 2), "panel")
    if p.level == 0:
        for dz in (-length / 2 + 0.012, length / 2 - 0.012):
            p.box((x - 0.008, y - 0.022, z + dz - 0.005), (x - 0.005, y + 0.022, z + dz + 0.005), "steel")


def sides_for(lvl, full=16):
    return full if lvl == 0 else max(6, full // 2) if lvl == 1 else 4


# ---------------------------------------------------------------- weapons
#
# Each builder returns the weapon's bones (via p.bone), and STATES below names its clips. Coordinates are the part frame
# in metres: light weapons x, y in [-0.1, 0.1], heavy ones y in [-0.1, 0.3]; z from 0 (the mount face) to 0.4. The side
# mods sit on a rail whose outer face is at x = -0.05 (a mod is at most 0.05 deep); the muzzle mod continues the barrel.

def energy_rifle(p):
    """A slim energy rifle: a short pale receiver with a sight on top and a lit energy cell on its +x side, a long vented
    gunmetal shroud with cooling fins round a steel barrel, a cyan muzzle ring. Fire kicks the barrel back."""
    lvl = p.level
    s = sides_for(lvl)
    bevel = 0.006 if lvl == 0 else 0.0
    mount(p)
    p.box((-0.045, -0.055, 0.05), (0.045, 0.06, 0.165), "paint", bevel=bevel)
    if lvl < 2:
        p.box((-0.012, 0.06, 0.07), (0.012, 0.08, 0.2), "gunmetal")  # the sight along the top, past the receiver
        p.box((0.045, -0.035, 0.065), (0.06, 0.035, 0.155), "panel")  # the cell housing
    if lvl == 0:
        p.cylinder((0, 0.08, 0.18), (0, 1, 0), 0.01, 0.006, 8, "steel", cap="glow-rifle")  # the sight's lens
        p.box((-0.046, -0.04, 0.055), (-0.04, 0.04, 0.068), "hazard")
    mod_rail(p, -0.044, 0, 0.105, 0.09)
    p.bone("glow-charge", (0.06, 0, 0.075), "base")
    p.box((0.055, -0.02, 0.075), (0.065, 0.02, 0.145), "glow-rifle", "fit")
    p.bone("barrel", (0, 0, 0.165), "base")
    p.cylinder((0, 0, 0.155), (0, 0, 1), 0.032, 0.125, s, "gunmetal", cap="gunmetal")
    if lvl < 2:
        for x in (-1, 1):  # cooling fins either side of the shroud
            x0, x1 = sorted((x * 0.03, x * 0.044))
            p.box((x0, -0.005, 0.17), (x1, 0.005, 0.27), "gunmetal")
    if lvl == 0:
        for z in (0.185, 0.21, 0.235, 0.26):
            p.box((-0.006, -0.034, z), (0.006, 0.034, z + 0.01), "vent", "fit")
    p.cylinder((0, 0, 0.17), (0, 0, 1), 0.017, 0.14, s, "steel", cap="bore")
    p.bone("glow-fire", (0, 0, 0.3), "barrel")
    p.cylinder((0, 0, 0.295), (0, 0, 1), 0.023, 0.014, s, "glow-rifle", cap="bore")
    return {}


def shotgun(p):
    """A pump shotgun: a chunky gunmetal receiver with a hazard band, two stacked wide barrels (the second above the
    first along +y), a ribbed pump forend round them, yellow shell lights and muzzle rings. Fire kicks, then pumps."""
    lvl = p.level
    s = sides_for(lvl, 14)
    bevel = 0.006 if lvl == 0 else 0.0
    mount(p)
    p.box((-0.045, -0.072, 0.05), (0.06, 0.072, 0.19), "gunmetal", bevel=bevel)
    if lvl < 2:
        p.box((-0.046, -0.073, 0.15), (0.061, 0.073, 0.17), "hazard")
        p.box((0.06, -0.05, 0.07), (0.072, 0.05, 0.16), "panel")
    mod_rail(p, -0.044, 0, 0.115, 0.1)
    p.bone("glow-charge", (0.07, 0, 0.08), "base")
    for k in range(4 if lvl < 2 else 1):
        z0 = 0.08 + k * 0.02 if lvl < 2 else 0.08
        p.box((0.066, -0.035, z0), (0.076, 0.035, z0 + (0.014 if lvl < 2 else 0.07)), "glow-shotgun", "fit")
    p.bone("barrel", (0, 0, 0.19), "base")
    for y in (-0.03, 0.03):
        p.cylinder((0, y, 0.18), (0, 0, 1), 0.028, 0.18, s, "gunmetal", cap="bore")
    if lvl < 2:
        p.box((-0.006, -0.004, 0.19), (0.006, 0.004, 0.355), "steel")  # the rib between the barrels
    p.bone("pump", (0, 0, 0.24), "barrel")
    p.box((-0.042, -0.07, 0.215), (0.042, 0.07, 0.29), "grip", bevel=bevel)
    if lvl == 0:
        for z in (0.225, 0.25, 0.275):
            p.box((-0.044, -0.072, z), (0.044, 0.072, z + 0.006), "gunmetal")
    p.bone("glow-fire", (0, 0, 0.355), "barrel")
    for y in (-0.03, 0.03):
        p.cylinder((0, y, 0.35), (0, 0, 1), 0.031, 0.012, s, "glow-shotgun", cap="bore")
    return {}


def laser(p):
    """A laser emitter: a round finned body, a flared head with a red lens and three focusing prongs on a ring that
    turns while the beam is on."""
    lvl = p.level
    s = sides_for(lvl, 20)
    mount(p)
    p.cylinder((0, 0, 0.05), (0, 0, 1), 0.05, 0.15, s, "paint", cap="paint")
    if lvl < 2:
        for z in (0.07, 0.1, 0.13, 0.16):
            p.cylinder((0, 0, z), (0, 0, 1), 0.066, 0.012, s, "gunmetal", cap="gunmetal")
    p.cylinder((0, 0, 0.2), (0, 0, 1), 0.05, 0.05, s, "gunmetal", radius2=0.07, cap="gunmetal")
    p.cylinder((0, 0, 0.25), (0, 0, 1), 0.07, 0.035, s, "steel", cap="steel")
    p.bone("glow-charge", (0, 0.054, 0.07), "base")
    p.box((-0.012, 0.045, 0.07), (0.012, 0.058, 0.19), "glow-laser", "fit")
    p.bone("emitter", (0, 0, 0.27), "base")
    p.cylinder((0, 0, 0.27), (0, 0, 1), 0.074, 0.012, s, "hazard", cap="hazard")
    if lvl < 2:
        for k in range(3):
            a = 2 * math.pi * k / 3 + math.pi / 2
            radial = Vector((math.cos(a), math.sin(a), 0))
            tangent = Vector((-math.sin(a), math.cos(a), 0))
            # Each prong leans in towards the beam's axis.
            lean = (Vector((0, 0, 1)) - radial * 0.35).normalized()
            out = tangent.cross(lean)
            obox(p, Vector((0, 0, 0.3)) + radial * 0.058, (tangent, out, lean), (0.008, 0.007, 0.03), "gunmetal")
    p.bone("glow-fire", (0, 0, 0.285), "base")
    p.cylinder((0, 0, 0.283), (0, 0, 1), 0.052, 0.012, s, "steel", cap="lens-laser")
    return {}


def flamethrower(p):
    """A flamethrower: a pale body, a striped fuel tank along its +x side with a lit fuel gauge, a feed pipe to a
    flared steel nozzle and an orange pilot light at its lip."""
    lvl = p.level
    s = sides_for(lvl)
    bevel = 0.006 if lvl == 0 else 0.0
    mount(p)
    p.box((-0.045, -0.065, 0.05), (0.02, 0.065, 0.19), "paint", bevel=bevel)
    p.cylinder((0.055, 0, 0.04), (0, 0, 1), 0.038, 0.19, s, "olive", cap="steel")
    if lvl < 2:
        p.cylinder((0.055, 0, 0.09), (0, 0, 1), 0.04, 0.02, s, "hazard", cap="hazard")
        p.cylinder((0.055, 0, 0.23), (0, 0, 1), 0.016, 0.02, 8, "steel", cap="steel")
    if lvl == 0:
        p.cylinder((0.055, 0, 0.245), (-1, 0, 0), 0.008, 0.07, 8, "gunmetal")  # the feed into the nozzle
    p.cylinder((-0.012, 0, 0.19), (0, 0, 1), 0.026, 0.12, s, "gunmetal", cap="gunmetal")
    p.bone("glow-charge", (0.09, 0, 0.12), "base")
    p.box((0.085, -0.012, 0.12), (0.095, 0.012, 0.2), "glow-flame", "fit")
    p.bone("nozzle", (-0.012, 0, 0.3), "base")
    p.cylinder((-0.012, 0, 0.3), (0, 0, 1), 0.028, 0.065, s, "steel", radius2=0.046, cap="bore")
    if lvl < 2:
        p.box((-0.05, -0.012, 0.31), (-0.03, 0.012, 0.35), "gunmetal")  # the igniter housing
    p.bone("glow-fire", (-0.012, 0, 0.36), "nozzle")
    p.cylinder((-0.012, 0, 0.358), (0, 0, 1), 0.047, 0.008, s, "glow-flame", radius2=0.044, cap="bore")
    return {}


CLAWS = 3


def grapple(p):
    """A grapple launcher: a pale housing with a cable winch on its -x side, a hazard-striped launch tube and the hook
    in its mouth: a steel spike with a green band and three claws folded back, which open as it launches."""
    lvl = p.level
    s = sides_for(lvl)
    bevel = 0.006 if lvl == 0 else 0.0
    mount(p)
    p.box((-0.05, -0.06, 0.05), (0.055, 0.06, 0.17), "paint", bevel=bevel)
    p.cylinder((0, 0, 0.17), (0, 0, 1), 0.045, 0.11, s, "hazard", cap="hazard")
    if lvl < 2:
        p.cylinder((0, 0, 0.275), (0, 0, 1), 0.049, 0.008, s, "steel", cap="bore")
        p.box((-0.075, -0.035, 0.07), (-0.05, 0.035, 0.15), "gunmetal")  # the winch frame
    p.bone("glow-charge", (0.055, 0, 0.08), "base")
    p.box((0.052, -0.02, 0.08), (0.062, 0.02, 0.16), "glow-grapple", "fit")
    p.bone("spool", (-0.07, 0, 0.11), "base")
    p.cylinder((-0.095, 0, 0.11), (1, 0, 0), 0.04, 0.045, s, "coil" if lvl < 2 else "steel", cap="steel")
    p.bone("hook", (0, 0, 0.28), "base")
    p.cylinder((0, 0, 0.24), (0, 0, 1), 0.013, 0.12, sides_for(lvl, 10), "steel", cap="steel")
    p.cylinder((0, 0, 0.36), (0, 0, 1), 0.024, 0.04, sides_for(lvl, 10), "steel", radius2=0.003, cap="steel")
    p.bone("glow-fire", (0, 0, 0.3), "hook")
    p.cylinder((0, 0, 0.3), (0, 0, 1), 0.016, 0.02, sides_for(lvl, 10), "glow-grapple", cap="glow-grapple")
    for k in range(CLAWS):
        a = 2 * math.pi * k / CLAWS
        radial = Vector((math.cos(a), math.sin(a), 0))
        tangent = Vector((-math.sin(a), math.cos(a), 0))
        hinge = Vector((0, 0, 0.35)) + radial * 0.018
        p.bone(f"claw-{k + 1}", tuple(hinge), "hook")
        # Folded: the fluke runs back down the shaft, its barb turned outwards.
        lean = (Vector((0, 0, -1)) + radial * 0.12).normalized()
        out = tangent.cross(lean)
        obox(p, hinge + lean * 0.035, (tangent, out, lean), (0.006, 0.005, 0.035), "steel")
        if lvl == 0:
            obox(p, hinge + lean * 0.068 + radial * 0.008, (tangent, radial, Vector((0, 0, 1))), (0.006, 0.01, 0.005), "steel")
    return {}


def energy_blade(p):
    """An energy blade: a gunmetal hilt with grip rings, a pale guard and a steel emitter, and the magenta plasma blade
    (flat, its edge along the part's x, its flat facing y). It extends and retracts from the emitter; the whole hilt
    swings about the wrist on the part's x."""
    lvl = p.level
    s = sides_for(lvl, 14)
    mount(p, neck=0.045)
    p.bone("wrist", (0, 0, 0.045), "base")
    if lvl < 2:
        p.cylinder((-0.04, 0, 0.055), (1, 0, 0), 0.022, 0.08, s, "steel", cap="hazard")  # the wrist knuckle
    grip = 0.06 if lvl < 2 else 0.045  # lod2 has no knuckle: the grip reaches down to the mount
    p.cylinder((0, 0, grip), (0, 0, 1), 0.032, 0.16 - grip, s, "grip" if lvl < 2 else "gunmetal", cap="gunmetal")
    if lvl == 0:
        for z in (0.07, 0.14):
            p.cylinder((0, 0, z), (0, 0, 1), 0.036, 0.01, s, "steel", cap="steel")
    p.box((-0.075, -0.026, 0.16), (0.075, 0.026, 0.185), "paint", bevel=0.005 if lvl == 0 else 0.0)
    p.cylinder((0, 0, 0.185), (0, 0, 1), 0.03, 0.02, s, "steel", radius2=0.022, cap="bore")
    p.bone("glow-charge", (0.065, 0, 0.162), "wrist")
    p.box((0.05, -0.028, 0.164), (0.07, -0.024, 0.181), "glow-blade", "fit")
    if lvl < 2:
        p.box((-0.07, -0.028, 0.164), (-0.05, -0.024, 0.181), "glow-blade", "fit")
    p.bone("blade", (0, 0, 0.195), "wrist")
    # The blade: a flat hexagonal section, tapering slightly, to a point.
    def section(z, w, t):
        return [(w, 0, z), (w * 0.55, t, z), (-w * 0.55, t, z), (-w, 0, z), (-w * 0.55, -t, z), (w * 0.55, -t, z)]
    if lvl == 2:
        prism(p, [section(0.195, 0.024, 0.007), section(0.37, 0.02, 0.006)], "glow-blade", tip=(0, 0, 0.4))
    else:
        prism(p, [section(0.195, 0.024, 0.007), section(0.29, 0.023, 0.0065), section(0.36, 0.02, 0.006)], "glow-blade", tip=(0.006, 0, 0.4))
    return {}


def rail_gun(p):
    """A rail gun over two cells: a pale capacitor block with vents, two gunmetal rails along +z with violet braces,
    the charge glowing up the channel between them, and a muzzle frame with a lit ring. Fire kicks the rails back."""
    lvl = p.level
    s = sides_for(lvl)
    bevel = 0.006 if lvl == 0 else 0.0
    mount(p, 0.3)
    p.box((-0.045, -0.08, 0.02), (0.08, 0.28, 0.13), "paint", bevel=bevel)
    if lvl < 2:
        p.box((0.08, -0.05, 0.035), (0.088, 0.25, 0.115), "vent", "fit")
        p.box((-0.046, 0.18, 0.04), (0.081, 0.2, 0.13), "hazard")
    mod_rail(p, -0.044, 0.1, 0.075, 0.08)
    if lvl < 2:
        for y in (0.03, 0.17):  # capacitor drums on the block's top, either side of the rails
            p.cylinder((0.055, y, 0.13), (0, 0, 1), 0.02, 0.04, s, "coil", cap="steel")
    p.bone("rails", (0, 0.1, 0.13), "base")
    for y0, y1 in ((0.02, 0.065), (0.135, 0.18)):
        p.box((-0.03, y0, 0.12), (0.03, y1, 0.31), "gunmetal", bevel=0.004 if lvl == 0 else 0.0)
        if lvl < 2:
            inner = (y1 - 0.004, y1 + 0.001) if y0 < 0.1 else (y0 - 0.001, y0 + 0.004)
            p.box((-0.02, inner[0], 0.13), (0.02, inner[1], 0.3), "steel")
            # Collars round each rail on its outer side only, so the channel between them stays open.
            outer = (y0 - 0.008, y1 - 0.01) if y0 < 0.1 else (y0 + 0.01, y1 + 0.008)
            for z in (0.17, 0.235):
                p.box((-0.038, outer[0], z), (0.038, outer[1], z + 0.022), "paint", bevel=0.003 if lvl == 0 else 0.0)
    p.box((-0.04, 0.015, 0.295), (0.04, 0.032, 0.31), "gunmetal")
    p.box((-0.04, 0.168, 0.295), (0.04, 0.185, 0.31), "gunmetal")
    p.bone("glow-charge", (0, 0.1, 0.13), "rails")
    p.box((-0.014, 0.075, 0.13), (0.014, 0.125, 0.295), "glow-rail", "fit")
    p.bone("glow-fire", (0, 0.1, 0.305), "rails")
    p.cylinder((0, 0.1, 0.302), (0, 0, 1), 0.03, 0.01, s, "glow-rail", cap="bore")
    return {}


ROCKET_X = 0.008
TUBES = {"rocket-a": 0.0, "rocket-b": 0.2}


def rocket_launcher(p):
    """A twin rocket pod over two cells: a gunmetal cradle, two olive tubes with hazard bands, a red warhead nose
    showing in each, orange ready lights on the cradle. Each tube fires and reloads on its own rocket node."""
    lvl = p.level
    s = sides_for(lvl, 18)
    bevel = 0.006 if lvl == 0 else 0.0
    mount(p, 0.3)
    p.box((-0.045, -0.07, 0.02), (0.075, 0.27, 0.1), "gunmetal", bevel=bevel)
    if lvl < 2:
        p.cylinder((-0.046, 0.1, 0.06), (1, 0, 0), 0.03, 0.122, s, "steel", cap="steel")  # the elevation trunnion
    mod_rail(p, -0.044, 0.1, 0.17, 0.08)
    for y in TUBES.values():
        p.cylinder((ROCKET_X, y, 0.1), (0, 0, 1), 0.072, 0.25, s, "olive", cap="bore")
        if lvl < 2:
            p.cylinder((ROCKET_X, y, 0.29), (0, 0, 1), 0.074, 0.025, s, "hazard", cap="hazard")
            p.cylinder((ROCKET_X, y, 0.345), (0, 0, 1), 0.075, 0.008, s, "steel", cap="bore")
    p.bone("glow-charge", (0.075, 0.1, 0.03), "base")
    for y in (0.03, 0.17):
        p.box((0.072, y - 0.02, 0.03), (0.082, y + 0.02, 0.09), "glow-rocket", "fit")
    p.bone("glow-fire", (ROCKET_X, 0.1, 0.1), "base")
    p.box((ROCKET_X - 0.02, 0.085, 0.1), (ROCKET_X + 0.02, 0.115, 0.11), "glow-rocket", "fit")
    for name, y in TUBES.items():
        p.bone(name, (ROCKET_X, y, 0.3), "base")
        p.cylinder((ROCKET_X, y, 0.27), (0, 0, 1), 0.045, 0.08, sides_for(lvl, 12), "paint", cap="paint")
        p.cylinder((ROCKET_X, y, 0.35), (0, 0, 1), 0.045, 0.048, sides_for(lvl, 12), "warhead", radius2=0.006, cap="warhead")
    return {}


# ---------------------------------------------------------------- mods
#
# A side mod sits on the -x rail: its own z is out of the rail (at most 0.05), y along the barrel (+z of the weapon)
# and x across it. The long barrel sits on the muzzle: its z continues the barrel.

def rapid_cycler(p):
    """A rotary cycler: a steel drum with dark flutes and a hazard band between two bearing blocks."""
    lvl = p.level
    s = sides_for(lvl, 12)
    p.box((-0.032, -0.06, 0), (0.032, 0.06, 0.008), "gunmetal")
    if lvl < 2:
        for y in (-0.06, 0.045):
            p.box((-0.026, y, 0.008), (0.026, y + 0.015, 0.042), "gunmetal", bevel=0.003 if lvl == 0 else 0.0)
    p.cylinder((0, -0.05, 0.026), (0, 1, 0), 0.022, 0.1, s, "vent" if lvl < 2 else "steel", cap="steel")
    if lvl < 2:
        p.cylinder((0, -0.008, 0.026), (0, 1, 0), 0.0235, 0.016, s, "hazard", cap="hazard")
    return {}


def overcharger(p):
    """An overcharger: a pale capacitor block with hazard edges and two red-hot coils on top."""
    lvl = p.level
    s = sides_for(lvl, 12)
    p.box((-0.034, -0.055, 0), (0.034, 0.055, 0.022), "paint", bevel=0.004 if lvl == 0 else 0.0)
    if lvl < 2:
        p.box((-0.035, -0.056, 0.012), (0.035, -0.044, 0.023), "hazard")
    for x in (-0.017, 0.017):
        p.cylinder((x, -0.045, 0.034), (0, 1, 0), 0.012, 0.09, s, "glow-laser", cap="steel")
        if lvl < 2:
            for y in (-0.03, 0.025):
                p.cylinder((x, y, 0.034), (0, 1, 0), 0.0135, 0.008, s, "gunmetal", cap="gunmetal")
    return {}


def efficiency_coil(p):
    """An efficiency coil: a copper winding between steel end caps on a cradle, with a green charge window."""
    lvl = p.level
    s = sides_for(lvl, 14)
    p.box((-0.03, -0.055, 0), (0.03, 0.055, 0.01), "gunmetal")
    p.cylinder((0, -0.045, 0.026), (0, 1, 0), 0.022, 0.09, s, "coil", cap="steel")
    if lvl == 0:
        for y in (-0.055, 0.045):
            p.cylinder((0, y, 0.026), (0, 1, 0), 0.024, 0.01, s, "steel", cap="steel")
    if lvl < 2:
        p.box((-0.008, -0.03, 0.045), (0.008, 0.03, 0.0495), "glow-grapple", "fit")
    return {}


def long_barrel(p):
    """A barrel extension for the muzzle: a steel collar, a fluted gunmetal barrel with a sleeve, and a slotted
    muzzle brake; its own muzzle is 0.09 out (a muzzle 0.31 out ends on the 2-cell cuboid's top)."""
    lvl = p.level
    s = sides_for(lvl, 14)
    p.cylinder((0, 0, 0), (0, 0, 1), 0.026, 0.012, s, "steel", cap="steel")
    p.cylinder((0, 0, 0.012), (0, 0, 1), 0.018, 0.062, s, "gunmetal", cap="gunmetal")
    if lvl < 2:
        p.cylinder((0, 0, 0.03), (0, 0, 1), 0.022, 0.025, s, "vent" if lvl == 0 else "gunmetal", cap="gunmetal")
    p.box((-0.024, -0.018, 0.07), (0.024, 0.018, 0.09), "vent" if lvl < 2 else "gunmetal", "fit", top="bore")
    return {}


BUILDERS = {
    "weapon.energy-rifle": energy_rifle, "weapon.shotgun": shotgun, "weapon.laser": laser, "weapon.flamethrower": flamethrower,
    "weapon.grapple-hook": grapple, "weapon.energy-blade": energy_blade, "weapon.rail-gun": rail_gun,
    "weapon.rocket-launcher": rocket_launcher,
    "mod.rapid-cycler": rapid_cycler, "mod.overcharger": overcharger, "mod.long-barrel": long_barrel, "mod.efficiency-coil": efficiency_coil,
}


# ---------------------------------------------------------------- states
#
# Each state is one clip: a list of keys (frame at 30 fps, bone, and any of ``loc`` (part-frame offset), ``rot`` (an
# angle about a part-frame ``axis``) and ``scale`` (part-frame factors)). Bones not keyed stay at rest. A channel bone's
# scale is its level: 1 lit as modelled, 0 hidden in its housing.

def keys_pulse(bone, frames, peak):
    """A channel flash: rest, ``peak``, rest."""
    return [(frames[0], bone, {"scale": (1, 1, 1)}), (frames[1], bone, {"scale": peak}), (frames[2], bone, {"scale": (1, 1, 1)})]


def fill(bone, frames, axis=2):
    """A channel filling along its length (a charge bar) over ``frames``."""
    empty = [1, 1, 1]
    empty[axis] = 0.0
    return [(frames[0], bone, {"scale": tuple(empty)}), (frames[1], bone, {"scale": (1, 1, 1)})]


def recoil(bone, back, frames):
    return [(frames[0], bone, {"loc": (0, 0, 0)}), (frames[1], bone, {"loc": (0, 0, -back)}), (frames[2], bone, {"loc": (0, 0, 0)})]


def spin(bone, turn, frames, axis=(0, 0, 1)):
    """Turn ``bone`` by ``turn`` radians from ``frames[0]`` to ``frames[-1]``, keyed at least every quarter turn so the
    quaternions never jump across half a turn."""
    steps = max(2, math.ceil(abs(turn) / (math.pi / 2)))
    first, last = frames[0], frames[-1]
    return [(round(first + (last - first) * i / steps), bone, {"rot": (turn * i / steps, axis)}) for i in range(steps + 1)]


def claw_keys(frame, angle):
    out = []
    for k in range(CLAWS):
        a = 2 * math.pi * k / CLAWS
        tangent = (-math.sin(a), math.cos(a), 0)
        out.append((frame, f"claw-{k + 1}", {"rot": (angle, tangent)}))
    return out


STATES = {
    "weapon.energy-rifle": {
        "fire": {"loop": False, "use": "fire", "keys": recoil("barrel", 0.025, (0, 2, 6)) + keys_pulse("glow-fire", (0, 1, 6), (1.6, 1.6, 1.0))
                 + [(0, "glow-charge", {"scale": (1, 1, 1)}), (1, "glow-charge", {"scale": (1, 1, 0.3)}), (6, "glow-charge", {"scale": (1, 1, 1)})]},
    },
    "weapon.shotgun": {
        "fire": {"loop": False, "use": "fire", "keys": recoil("barrel", 0.02, (0, 2, 5)) + keys_pulse("glow-fire", (0, 1, 5), (1.15, 1.15, 1.0))
                 + [(5, "pump", {"loc": (0, 0, 0)}), (10, "pump", {"loc": (0, 0, -0.05)}), (16, "pump", {"loc": (0, 0, 0)})]
                 + [(0, "glow-charge", {"scale": (1, 1, 1)}), (2, "glow-charge", {"scale": (1, 1, 0.0)}), (16, "glow-charge", {"scale": (1, 1, 0.0)}), (18, "glow-charge", {"scale": (1, 1, 1)})]},
    },
    "weapon.laser": {
        "beam": {"loop": True, "use": "continuous-fire", "keys": spin("emitter", 2 * math.pi / 3, (0, 15))
                 + [(0, "glow-fire", {"scale": (1.15, 1.15, 1)}), (7, "glow-fire", {"scale": (1.3, 1.3, 1)}), (15, "glow-fire", {"scale": (1.15, 1.15, 1)})]},
    },
    "weapon.flamethrower": {
        "fire": {"loop": True, "use": "continuous-fire", "keys": [(0, "glow-fire", {"scale": (1.0, 1.0, 1)}), (3, "glow-fire", {"scale": (1.2, 1.2, 1)}),
                                                                  (6, "glow-fire", {"scale": (1.05, 1.05, 1)}), (9, "glow-fire", {"scale": (1.25, 1.25, 1)}), (12, "glow-fire", {"scale": (1.0, 1.0, 1)})]
                 + [(0, "nozzle", {"loc": (0, 0, 0)}), (3, "nozzle", {"loc": (0.0015, 0, -0.002)}), (6, "nozzle", {"loc": (-0.001, 0.001, 0)}),
                    (9, "nozzle", {"loc": (0.001, -0.0015, -0.002)}), (12, "nozzle", {"loc": (0, 0, 0)})]},
    },
    "weapon.grapple-hook": {
        "launch": {"loop": False, "use": "launch", "keys": [(0, "hook", {"loc": (0, 0, 0)}), (6, "hook", {"loc": (0, 0, 0.12)})]
                   + claw_keys(0, 0.0) + claw_keys(5, -1.9) + spin("spool", -2 * math.pi, (0, 6), (1, 0, 0)) + keys_pulse("glow-fire", (0, 2, 6), (1.6, 1.6, 1.6))
                   + [(0, "glow-charge", {"scale": (1, 1, 1)}), (6, "glow-charge", {"scale": (1, 1, 0.0)})]},
        "retract": {"loop": False, "use": "retract", "keys": [(0, "hook", {"loc": (0, 0, 0.12)}), (12, "hook", {"loc": (0, 0, 0)})]
                    + claw_keys(0, -1.9) + claw_keys(12, 0.0) + spin("spool", 2 * math.pi, (0, 12), (1, 0, 0))
                    + [(0, "glow-charge", {"scale": (1, 1, 0.0)}), (12, "glow-charge", {"scale": (1, 1, 1)})]},
    },
    "weapon.energy-blade": {
        "extend": {"loop": False, "use": "extend", "keys": [(0, "blade", {"scale": (0.4, 0.4, 0.02)}), (6, "blade", {"scale": (1, 1, 1)})]},
        "retract": {"loop": False, "use": "retract", "keys": [(0, "blade", {"scale": (1, 1, 1)}), (6, "blade", {"scale": (0.4, 0.4, 0.02)})]},
        "swing": {"loop": False, "use": "swing", "keys": [(0, "wrist", {"rot": (0.0, (1, 0, 0))}), (3, "wrist", {"rot": (-0.9, (1, 0, 0))}),
                                                          (8, "wrist", {"rot": (0.9, (1, 0, 0))}), (14, "wrist", {"rot": (0.0, (1, 0, 0))})]},
    },
    "weapon.rail-gun": {
        "charge": {"loop": False, "use": "charge", "keys": fill("glow-charge", (0, 30)) + [(0, "glow-fire", {"scale": (0.0, 0.0, 0.0)}), (24, "glow-fire", {"scale": (0.0, 0.0, 0.0)}), (30, "glow-fire", {"scale": (1, 1, 1)})]},
        "fire": {"loop": False, "use": "fire", "keys": recoil("rails", 0.03, (0, 2, 9)) + keys_pulse("glow-fire", (0, 1, 9), (1.8, 1.8, 1.0))
                 + [(0, "glow-charge", {"scale": (1, 1, 1)}), (2, "glow-charge", {"scale": (1, 1, 0.0)}), (9, "glow-charge", {"scale": (1, 1, 0.0)})]},
    },
    "weapon.rocket-launcher": {
        **{f"fire-{tube[-1]}": {"loop": False, "use": "fire", "keys": [(0, tube, {"loc": (0, 0, 0), "scale": (1, 1, 1)}), (4, tube, {"loc": (0, 0, 0.12), "scale": (1, 1, 1)}),
                                                                       (5, tube, {"loc": (0, 0, 0.12), "scale": (0.0, 0.0, 0.0)})] + keys_pulse("glow-fire", (0, 2, 8), (2.0, 2.0, 2.0))}
           for tube in TUBES},
        "reload": {"loop": False, "use": "reload", "keys": [(f, tube, k) for tube in TUBES for f, k in (
            (0, {"loc": (0, 0, -0.2), "scale": (1, 1, 1)}), (24, {"loc": (0, 0, 0), "scale": (1, 1, 1)}))]
                   + [(0, "glow-charge", {"scale": (1, 1, 0.0)}), (24, "glow-charge", {"scale": (1, 1, 0.0)}), (25, "glow-charge", {"scale": (1, 1, 1)})]},
    },
}


def bone_frame(v):
    """A part-frame vector in a bone's own axes (bones run along +z with no roll: X = x, Y = z, Z = -y)."""
    return Vector((v[0], v[2], -v[1]))


def add_states(obj, key):
    """Bake each state as its own action and NLA track on the weapon's rig (one glTF animation each)."""
    rig = obj.parent
    rig.animation_data_create()
    for name, state in STATES.get(key, {}).items():
        action = bpy.data.actions.new(name)
        rig.animation_data.action = action
        for frame, bone, values in sorted(state["keys"], key=lambda k: (k[0], k[1])):
            pose = rig.pose.bones[bone]
            if "loc" in values:
                pose.location = bone_frame(values["loc"])
                pose.keyframe_insert("location", frame=frame, group=bone)
            if "rot" in values:
                angle, axis = values["rot"]
                pose.rotation_quaternion = Quaternion(bone_frame(axis).normalized(), angle)
                pose.keyframe_insert("rotation_quaternion", frame=frame, group=bone)
            if "scale" in values:
                sx, sy, sz = values["scale"]
                pose.scale = (sx, sz, sy)
                pose.keyframe_insert("scale", frame=frame, group=bone)
        for curve in getattr(action, "fcurves", []):
            for point in curve.keyframe_points:
                point.interpolation = "LINEAR"
        rig.animation_data.action = None
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, action)
        for pose in rig.pose.bones:
            pose.location, pose.rotation_quaternion, pose.scale = (0, 0, 0), (1, 0, 0, 0), (1, 1, 1)


def build(key, collection, level=0, location=(0, 0, 0)):
    """One weapon or mod as one mesh object whose origin is its mount anchor (a weapon, skinned to its rig, comes back
    as the mesh with ``obj.parent`` the armature, which is what ``location`` moves)."""
    p = new_part(key, level)
    info = BUILDERS[key](p) or {}
    obj = p.mesh(key, collection)
    (obj.parent or obj).location = location
    if obj.parent:
        info["bones"] = [{"name": name, "head": [round(c, 6) for c in head], "parent": parent} for name, head, parent in p.bones]
        add_states(obj, key)
        info["states"] = sorted(STATES.get(key, {}))
    return obj, info


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or set(arguments) != {"schemaVersion", "part", "cells", "level"}:
        raise ValueError("shooter-weapons arguments must be {schemaVersion: 1, part, cells, level}")
    if arguments["part"] not in PARTS:
        raise ValueError(f"shooter-weapons part must be one of {', '.join(PARTS)}")
    expected = PARTS[arguments["part"]]
    if (None if arguments["cells"] is None else tuple(arguments["cells"])) != expected:
        raise ValueError(f"{arguments['part']} is {expected} cells, not {arguments['cells']}")
    if arguments["level"] not in (0, 1, 2):
        raise ValueError("shooter-weapons level must be 0, 1 or 2")
    if set(inputs) != {"common", "robot"}:
        raise ValueError("shooter-weapons takes exactly the inputs 'common' (kit_common.py) and 'robot' (combat_robot.py)")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_sources(inputs.load_source("robot"), inputs.load_source("common"))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    key, level = arguments["part"], arguments["level"]
    obj, info = build(key, bpy.context.scene.collection, level)
    bpy.context.scene.render.fps = CLIP_FPS
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    rig = obj.parent
    if rig:
        obj.parent = None
        rig.select_set(True)
    animated = bool(rig and rig.animation_data and rig.animation_data.nla_tracks)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO",
        export_animations=animated, export_skins=bool(rig), export_morph=False, export_cameras=False, export_lights=False, export_extras=False,
        **({"export_animation_mode": "NLA_TRACKS", "export_force_sampling": True, "export_frame_step": 1, "export_optimize_animation_size": True,
            "export_reset_pose_bones": True} if animated else {}))
    triangles = sum(len(polygon.vertices) - 2 for polygon in obj.data.polygons)
    return {"recipe": RECIPE, "part": key, "level": level, "unit": "meter", "axes": "right-handed-y-up", "origin": "mount-anchor",
            "triangleCount": triangles, **info}
