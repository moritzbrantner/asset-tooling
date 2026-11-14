"""Shooter combat robot parts (docs/combat-robot-kit.md): socket-grid robot parts on one procedural metal atlas.

Every part is a whole number of 20 cm cells, the cuboid of Shooter's part catalog (``cells`` = x, y, z of the part's own
frame, its base x * y). The recipe builds in that frame directly: Blender's X, Y and Z are the part's x, y and z, so
the exported glTF (+Y up) has the part's x along +X, its height z along +Y and its y along -Z. The origin is the
**mount anchor**, the centre of the base's first cell (0, 0) on the mount face (the part's -z face): the cuboid runs
from (-0.1, -0.1, 0) to (0.2 x - 0.1, 0.2 y - 0.1, 0.2 z) metres. Nothing leaves that cuboid.

Parts with sockets (chassis and beams) carry one recessed coupling per surface cell; the joints carry one flat coupling
on their moving top. Every part is a closed surface, so it renders attached or detached without tears. Socket
positions, numbering and frames are not in the mesh: the build script computes them from the catalog (src/socket-grid.ts).

The hinge, the rotor and the leg are one mesh skinned rigidly (every vertex weighted 1 to one bone) to a short bone
chain whose bones sit on the joints' pivots, point along the part's +z and have no roll, so each exported joint node
rests unrotated in the part's own axes. The leg also carries its reference walk clips (``WALK_CLIPS``), one NLA track
and one glTF animation each.

``arguments`` are ``part``, ``cells``, ``level`` (0 full detail, 1 and 2 are ``lod1`` and ``lod2``) and ``variant``
(``default``, or ``damaged`` for the armor plate). No randomness: variation is a SHA-256 of fixed keys, the textures
come from numpy's legacy ``RandomState`` through the declared input ``common`` (``kit_common.py``).

``build(part, collection, level, variant, location)`` also works in a live Blender after ``use_common(runpy.run_path(...))``.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector

RECIPE = "combat-robot-v1"
CELL = 0.2  # metres per socket cell (Shooter's CELL_MM, provisional Q2.i70.2)
MATERIAL = "robot-metal"

# The parts this recipe builds, by their Shooter catalog key: cells (x, y, z) and whether every face carries sockets.
PARTS = {
    "robot.chassis.20x40x80": ((1, 2, 4), True),
    "robot.chassis.40x40x80": ((2, 2, 4), True),
    "robot.chassis.40x60x80": ((2, 3, 4), True),
    "robot.beam.20x20x40": ((1, 1, 2), True),
    "robot.beam.20x20x80": ((1, 1, 4), True),
    "robot.core": ((1, 1, 1), False),
    "robot.sensor": ((1, 1, 1), False),
    "robot.battery": ((1, 2, 1), False),
    "robot.armor.plate": ((2, 2, 1), False),
    "robot.joint.hinge": ((1, 1, 1), False),
    "robot.joint.rotor": ((1, 1, 1), False),
    "robot.leg": ((1, 1, 4), False),
}
VARIANTS = {"robot.armor.plate": ("default", "damaged")}

# Socket recess, in metres: the painted rim each cell keeps, the wall and how deep the coupling sits.
RIM = 0.022
WALL = 0.004
RECESS = 0.012
EDGE_CHAMFER = 0.012  # the cuboid's own edges

# sRGB colours.
PAINT = np.array((0.55, 0.56, 0.53))         # chassis: pale industrial grey
BEAM_PAINT = np.array((0.32, 0.33, 0.34))    # beams: graphite
GUNMETAL = np.array((0.11, 0.115, 0.12))
STEEL = np.array((0.56, 0.57, 0.58))
RUBBER = np.array((0.035, 0.035, 0.04))
HAZARD = np.array((0.86, 0.55, 0.06))
CORE_HOT, CORE_RIM = np.array((1.0, 0.5, 0.08)), np.array((0.85, 0.06, 0.0))
LENS_GLOW = np.array((0.25, 0.85, 1.0))
CHARGE = np.array((0.35, 1.0, 0.45))
ARMOR = np.array((0.42, 0.44, 0.38))         # armor: olive drab

# Atlas: a 4 x 4 grid of 512 px cells, each with an 8 px gutter of its own edge pixels.
ATLAS_EDGE = 2048
CELL_PX = 512
GUTTER = 8
CELLS = {
    "socket": (0, 0), "socket-flat": (1, 0), "paint": (2, 0), "gunmetal": (3, 0),
    "steel": (0, 1), "socket-beam": (1, 1), "hazard": (2, 1), "vent": (3, 1),
    "core-glow": (0, 2), "lens": (1, 2), "battery": (2, 2), "armor": (3, 2),
    "armor-damaged": (0, 3), "beam-paint": (1, 3), "socket-flat-beam": (2, 3), "panel": (3, 3),
}

C = {}


def use_common(namespace):
    """Bind the shared helpers from ``kit_common.py``."""
    C.clear()
    C.update({name: namespace[name] for name in namespace["NAMES"]})


def between(lo, hi, *keys):
    return lo + (hi - lo) * C["rnd"]("combat-robot", *keys)


# ---------------------------------------------------------------- atlas

def smoothstep(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a[None, None] * (1 - t[..., None]) + b[None, None] * t[..., None]


def noise(seed, base, octaves, n, stretch=(1, 1)):
    return C["fbm"](n, base, octaves, seed, stretch)


def grid(n):
    """Pixel centres in [0, 1], x to the right and y upwards (v)."""
    yy, xx = np.mgrid[0:n, 0:n]
    return (xx + 0.5) / n, 1 - (yy + 0.5) / n


def box_mask(x, y, lo, hi, soft=0.004):
    """1 inside the square [lo, hi]^2, with a soft edge."""
    d = np.maximum(np.maximum(lo - x, x - hi), np.maximum(lo - y, y - hi))
    return 1 - smoothstep(-soft, soft, d)


def disc(x, y, cx, cy, r, soft=0.004):
    return 1 - smoothstep(r - soft, r + soft, np.hypot(x - cx, y - cy))


def painted(base, n, seed, wear=1.0):
    """A painted metal surface: low mottle, faint grime and sparse fine scratches (restrained wear)."""
    mottle = noise(seed, 3, 4, n)
    grime = noise(seed + 1, 6, 4, n)
    scratch = smoothstep(0.82, 0.9, noise(seed + 2, 40, 2, n, (0.08, 1.0))) * smoothstep(0.55, 0.75, noise(seed + 3, 4, 2, n))
    colour = base[None, None] * (0.94 + 0.1 * mottle[..., None]) * (1 - 0.12 * wear * smoothstep(0.55, 0.85, grime)[..., None])
    colour = colour * (1 - 0.6 * wear * scratch[..., None]) + STEEL[None, None] * 0.6 * wear * scratch[..., None]
    rough = 0.5 + 0.12 * mottle + 0.12 * grime - 0.2 * wear * scratch
    return colour, mottle * 0.15 - scratch * 0.2, rough, 0.6 * wear * scratch


def coupling(x, y, n, seed, plate):
    """A socket's hardpoint as seen from outside: a plate in a darker shade of the part's paint, a narrow steel collar
    round a keyed bayonet bore with a locking pin, and four countersunk screws."""
    colour, height, rough, metal = painted(plate, n, seed, 0.7)
    r = np.hypot(x - 0.5, y - 0.5)
    angle = np.arctan2(y - 0.5, x - 0.5)
    collar = smoothstep(0.125, 0.132, r) * (1 - smoothstep(0.185, 0.192, r))
    keys = (np.cos(angle * 3) > 0.94) * smoothstep(0.1, 0.105, r) * (1 - smoothstep(0.13, 0.135, r))
    bore = (1 - smoothstep(0.1, 0.106, r)) + keys
    pin = disc(x, y, 0.5, 0.5, 0.035)
    # A pressed groove round the plate, inside which the hardpoint sits.
    groove = box_mask(x, y, 0.1, 0.9, 0.006) * (1 - box_mask(x, y, 0.115, 0.885, 0.006))
    screws = sum(disc(x, y, 0.5 + dx, 0.5 + dy, 0.032, 0.005) for dx in (-0.31, 0.31) for dy in (-0.31, 0.31))
    slots = sum((np.abs((x - 0.5 - dx) - (y - 0.5 - dy)) < 0.006) * disc(x, y, 0.5 + dx, 0.5 + dy, 0.026, 0.002) for dx in (-0.31, 0.31) for dy in (-0.31, 0.31))
    steel = np.clip(collar + screws + pin, 0, 1)
    colour = colour * (1 - steel[..., None]) + mix(STEEL * 0.7, STEEL * 0.95, noise(seed + 9, 8, 3, n)) * steel[..., None]
    colour *= (1 - 0.9 * np.clip(bore, 0, 1) * (1 - pin))[..., None] * (1 - 0.5 * groove)[..., None] * (1 - 0.7 * slots)[..., None]
    height = height + collar * 0.5 - np.clip(bore, 0, 1) * 0.9 + pin * 0.8 + screws * 0.2 - slots * 0.3 - groove * 0.5
    rough = rough * (1 - steel) + 0.3 * steel
    metal = np.maximum(metal, steel * 0.95)
    return colour, height, rough, metal


def paint_socket(rim_colour, seed):
    def painter(n):
        x, y = grid(n)
        return (*coupling(x, y, n, seed, rim_colour * 0.55), None, 6.0)
    return painter


def paint_socket_flat(n, rim_colour, seed):
    """A whole cell drawn flat for lod1: the painted rim, the recess's shadowed wall, then the coupling."""
    x, y = grid(n)
    inner = 0.5 - RIM / CELL  # where the rim ends, in cell units from the centre
    lo, hi = 0.5 - inner, 0.5 + inner
    sx, sy = (x - lo) / (hi - lo), (y - lo) / (hi - lo)
    c, h, r, m = coupling(np.clip(sx, 0, 1), np.clip(sy, 0, 1), n, seed + 1, rim_colour * 0.55)
    rim_c, rim_h, rim_r, rim_m = painted(rim_colour, n, seed)
    inside = box_mask(x, y, lo, hi)
    wall = inside * (1 - box_mask(x, y, lo + 0.02, hi - 0.02))
    colour = rim_c * (1 - inside[..., None]) + c * inside[..., None] * (1 - 0.55 * wall[..., None])
    height = rim_h * (1 - inside) + (h * 0.5 - 1.0) * inside
    return colour, height, rim_r * (1 - inside) + r * inside, rim_m * (1 - inside) + m * inside, None, 5.0


def paint_flat(base, seed, wear=1.0):
    def painter(n):
        c, h, r, m = painted(base, n, seed, wear)
        return c, h, r, m, None, 3.0
    return painter


def paint_steel(n):
    x, y = grid(n)
    brushed = noise(9301, 60, 2, n, (0.03, 1.0))
    colour = STEEL[None, None] * (0.88 + 0.2 * brushed[..., None])
    return colour, brushed * 0.1, 0.3 + 0.12 * brushed, np.full((n, n), 0.95), None, 1.0


def paint_hazard(n):
    x, y = grid(n)
    stripe = smoothstep(0.48, 0.52, ((x + y) * 4) % 1.0)
    c, h, r, m = painted(HAZARD, n, 9401, 0.8)
    dark = painted(GUNMETAL, n, 9402, 0.5)[0]
    colour = c * (1 - stripe[..., None]) + dark * stripe[..., None]
    return colour, h, r, m, None, 3.0


def paint_vent(n):
    x, y = grid(n)
    slot = smoothstep(0.35, 0.4, np.abs(((y * 8) % 1.0) - 0.5) * 2) * box_mask(x, y, 0.08, 0.92)
    c, h, r, m = painted(GUNMETAL, n, 9501, 0.6)
    colour = c * (1 - 0.85 * (1 - slot[..., None]) * box_mask(x, y, 0.08, 0.92)[..., None])
    return colour, slot * 0.8, r, m, None, 6.0


def paint_core(n):
    """The core's glow: a white-hot centre through amber to a deep red rim, with faint plasma banding."""
    x, y = grid(n)
    r = np.clip(np.hypot(x - 0.5, y - 0.5) * 2, 0, 1)
    bands = noise(9601, 5, 3, n, (1, 0.5))
    t = np.clip(r * 1.1 + (bands - 0.5) * 0.35, 0, 1)
    glow = mix(CORE_HOT, CORE_RIM, smoothstep(0.0, 0.9, t))
    return glow * 0.45, bands * 0.05, np.full((n, n), 0.15), np.zeros((n, n)), glow, 0.5


def paint_lens(n):
    """The sensor's lens face: a dark glass eye in a lit ring, a smaller iris inside."""
    x, y = grid(n)
    r = np.hypot(x - 0.5, y - 0.5)
    glass = mix(np.array((0.01, 0.02, 0.03)), np.array((0.05, 0.12, 0.16)), 1 - smoothstep(0.0, 0.45, r))
    ring = smoothstep(0.38, 0.4, r) * (1 - smoothstep(0.44, 0.46, r))
    iris = smoothstep(0.12, 0.13, r) * (1 - smoothstep(0.16, 0.17, r))
    housing = smoothstep(0.47, 0.48, r)
    glow = LENS_GLOW[None, None] * (ring + 0.6 * iris)[..., None]
    colour = glass * (1 - housing[..., None]) + GUNMETAL[None, None] * housing[..., None] + glow * 0.7
    rough = 0.06 * (1 - housing) + 0.5 * housing
    return colour, housing * 0.6 + ring * 0.2, rough, housing * 0.5, glow, 4.0


def paint_battery(n):
    """The charge window along the battery: eight green bars behind dark glass."""
    x, y = grid(n)
    bars = (((x * 8) % 1.0) > 0.18) * box_mask(x, y, 0.04, 0.96) * (np.abs(y - 0.5) < 0.3)
    c, h, r, m = painted(RUBBER, n, 9701, 0.3)
    glow = CHARGE[None, None] * bars[..., None] * (0.75 + 0.25 * y[..., None])
    return c * (1 - bars[..., None]) + glow, bars * 0.1, r * (1 - bars) + 0.1 * bars, m, glow, 2.0


def armor_surface(n, seed, damaged):
    x, y = grid(n)
    c, h, r, m = painted(ARMOR, n, seed, 1.2 if damaged else 1.0)
    # Panel lines and a stencil block.
    seam = (np.abs(x - 0.5) < 0.004) | (np.abs(y - 0.33) < 0.004)
    stencil = box_mask(x, y, 0.0, 1.0) * (np.abs(x - 0.2) < 0.1) * (np.abs(y - 0.8) < 0.02) * ((x * 30) % 1.0 > 0.35)
    c = c * (1 - 0.5 * seam[..., None]) * (1 - 0.45 * stencil[..., None])
    h = h - seam * 0.5
    e = np.zeros((n, n, 3))
    if damaged:
        scorch = smoothstep(0.45, 0.75, noise(seed + 11, 3, 4, n)) * smoothstep(0.3, 0.7, 1 - np.hypot(x - 0.62, y - 0.42) * 1.6)
        c = c * (1 - 0.85 * scorch[..., None])
        holes = np.zeros((n, n))
        rim = np.zeros((n, n))
        for i in range(7):
            cx, cy = between(0.15, 0.85, "hole", i, "x"), between(0.15, 0.85, "hole", i, "y")
            rr = between(0.012, 0.03, "hole", i, "r")
            holes += disc(x, y, cx, cy, rr, 0.003)
            rim += disc(x, y, cx, cy, rr * 2.4, 0.01) * (1 - disc(x, y, cx, cy, rr, 0.003))
        holes, rim = np.clip(holes, 0, 1), np.clip(rim, 0, 1)
        gouge = smoothstep(0.86, 0.92, noise(seed + 12, 30, 2, n, (1.0, 0.07))) * smoothstep(0.5, 0.7, noise(seed + 13, 3, 2, n))
        bare = np.clip(rim * 0.8 + gouge, 0, 1)
        c = c * (1 - bare[..., None]) + STEEL[None, None] * 0.7 * bare[..., None]
        c = c * (1 - 0.95 * holes[..., None])
        h = h - holes * 1.5 + rim * 0.4 - gouge * 0.4
        r = r * (1 - bare) + 0.35 * bare + 0.2 * scorch
        m = np.maximum(m, bare * 0.9)
        e = np.array((1.0, 0.35, 0.05))[None, None] * (holes * smoothstep(0.4, 0.8, scorch))[..., None] * 0.6  # still glowing
    return c, h, r, m, e, 4.0


def paint_panel(n):
    """Closed housings (core base, sensor, battery cradle): gunmetal with a recessed panel line."""
    x, y = grid(n)
    c, h, r, m = painted(np.array((0.3, 0.31, 0.32)), n, 9901)
    seam = box_mask(x, y, 0.08, 0.92) * (1 - box_mask(x, y, 0.09, 0.91))
    return c * (1 - 0.6 * seam[..., None]), h - seam * 0.6, r, m, None, 4.0


PAINTERS = {
    "socket": paint_socket(PAINT, 9101),
    "socket-beam": paint_socket(BEAM_PAINT, 9131),
    "socket-flat": lambda n: paint_socket_flat(n, PAINT, 9111),
    "socket-flat-beam": lambda n: paint_socket_flat(n, BEAM_PAINT, 9121),
    "paint": paint_flat(PAINT, 9201),
    "beam-paint": paint_flat(BEAM_PAINT, 9211),
    "gunmetal": paint_flat(GUNMETAL, 9221, 0.6),
    "steel": paint_steel,
    "hazard": paint_hazard,
    "vent": paint_vent,
    "core-glow": paint_core,
    "lens": paint_lens,
    "battery": paint_battery,
    "armor": lambda n: armor_surface(n, 9801, False),
    "armor-damaged": lambda n: armor_surface(n, 9801, True),
    "panel": paint_panel,
}


def paint_atlas():
    edge, n = ATLAS_EDGE, CELL_PX - 2 * GUTTER
    colour = np.zeros((edge, edge, 3))
    normal = np.zeros((edge, edge, 3)) + np.array((0.5, 0.5, 1.0))
    orm = np.ones((edge, edge, 3))
    emissive = np.zeros((edge, edge, 3))
    for name, (cx, cy) in CELLS.items():
        c, height, rough, metal, glow, strength = PAINTERS[name](n)
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
    tree.links.new(texture("robot-metal-colour", colour, True).outputs["Color"], bsdf.inputs["Base Color"])
    normal_node = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(texture("robot-metal-normal", normal, False).outputs["Color"], normal_node.inputs["Color"])
    tree.links.new(normal_node.outputs["Normal"], bsdf.inputs["Normal"])
    separate = tree.nodes.new("ShaderNodeSeparateColor")
    tree.links.new(texture("robot-metal-orm", orm, False).outputs["Color"], separate.inputs["Color"])
    tree.links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    tree.links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    tree.links.new(texture("robot-metal-emissive", emissive, True).outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    return mat


def cell_uv(cell, u, v):
    """A cell-local (u, v) in [0, 1] (v up) as an atlas coordinate, inside the cell's gutter."""
    cx, cy = CELLS[cell]
    inner = CELL_PX - 2 * GUTTER
    return ((cx * CELL_PX + GUTTER + u * inner) / ATLAS_EDGE, 1 - (cy * CELL_PX + GUTTER + (1 - v) * inner) / ATLAS_EDGE)


# ---------------------------------------------------------------- mesh

FIT, PLANAR = "fit", "planar"


def face_axes(normal):
    """Two in-plane axes for a face, from its dominant normal axis, so u x v follows the normal."""
    k = max(range(3), key=lambda i: abs(normal[i]))
    s = 1 if normal[k] > 0 else -1
    if k == 0:
        return Vector((0, s, 0)), Vector((0, 0, 1))
    if k == 1:
        return Vector((-s, 0, 0)), Vector((0, 0, 1))
    return Vector((1, 0, 0)), Vector((0, s, 0))


class Part:
    """One part at one level, gathered in one bmesh in the part frame (Blender axes = the part's x, y, z)."""

    def __init__(self, key, cells, level, variant):
        self.key, self.cells, self.level, self.variant = key, cells, level, variant
        self.bm = bmesh.new()
        self.surface = self.bm.faces.layers.int.new("surface")
        self.mode = self.bm.faces.layers.int.new("mode")
        # Articulated parts (the joints, the leg) are one mesh skinned rigidly to a chain of bones: every face belongs to
        # exactly one bone, so turning a joint moves whole pieces and never stretches or tears the surface.
        self.bone_layer = self.bm.faces.layers.int.new("bone")
        self.bones = [("base", (0.0, 0.0, 0.0), None)]
        self.current = 0
        self.names = list(CELLS)
        self.lo = Vector((-CELL / 2, -CELL / 2, 0))
        self.hi = Vector((cells[0] * CELL - CELL / 2, cells[1] * CELL - CELL / 2, cells[2] * CELL))
        # Planar surfaces: by default 2 m round the mount anchor fill a cell (every part sits within it).
        self.planar_centre, self.planar_span = Vector((0, 0, 0)), 2.0

    def tag(self, faces, cell, mode=PLANAR):
        for f in faces:
            f[self.surface] = self.names.index(cell)
            f[self.mode] = 0 if mode == FIT else 1
            f[self.bone_layer] = self.current

    def bone(self, name, head, parent):
        """Start a bone: everything built from now on moves with it. ``head`` is its pivot in the part frame."""
        self.bones.append((name, tuple(head), parent))
        self.current = len(self.bones) - 1

    # -- primitives -----------------------------------------------------

    def box(self, lo, hi, cell, mode=PLANAR, bevel=0.0, top=None):
        """An axis-aligned box from ``lo`` to ``hi``; ``top`` tags its +z face with another cell."""
        ret = bmesh.ops.create_cube(self.bm, size=1.0)
        verts = ret["verts"]
        lo, hi = Vector(lo), Vector(hi)
        for v in verts:
            v.co = Vector(lo[i] if v.co[i] < 0 else hi[i] for i in range(3))
        faces = list(dict.fromkeys(f for v in verts for f in v.link_faces))
        self.tag(faces, cell, mode)
        if top:
            self.tag([f for f in faces if f.normal_update() or f.normal.z > 0.9], top, FIT)
        if bevel:
            edges = list(dict.fromkeys(e for f in faces for e in f.edges))
            res = bmesh.ops.bevel(self.bm, geom=edges + verts, offset=bevel, segments=1, affect="EDGES", profile=0.5, clamp_overlap=True)
            self.tag(res["faces"], cell, PLANAR)
        return faces

    def cylinder(self, centre, axis, radius, length, sides, cell, mode=PLANAR, cap=None, radius2=None):
        """A capped cylinder (or frustum, with ``radius2`` at its far end) along ``axis`` from ``centre``."""
        axis = Vector(axis).normalized()
        ref = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
        a = axis.cross(ref).normalized()
        b = axis.cross(a)
        r2 = radius if radius2 is None else radius2
        rings = []
        for end, r in ((0, radius), (1, r2)):
            rings.append([self.bm.verts.new(Vector(centre) + axis * length * end + (a * math.cos(t) + b * math.sin(t)) * r)
                          for t in (2 * math.pi * s / sides for s in range(sides))])
        sides_faces = [self.bm.faces.new((rings[0][s], rings[0][(s + 1) % sides], rings[1][(s + 1) % sides], rings[1][s])) for s in range(sides)]
        caps = [self.bm.faces.new(list(reversed(rings[0]))), self.bm.faces.new(rings[1])]
        self.tag(sides_faces, cell, mode)
        self.tag(caps, cap or cell, FIT if cap else mode)
        return sides_faces, caps

    def sphere(self, centre, radius, segments, rings, cell):
        ret = bmesh.ops.create_uvsphere(self.bm, u_segments=segments, v_segments=rings, radius=radius)
        for v in ret["verts"]:
            v.co += Vector(centre)
        faces = list(dict.fromkeys(f for v in ret["verts"] for f in v.link_faces))
        self.tag(faces, cell, PLANAR)
        return faces

    # -- socket cuboids -------------------------------------------------

    def socket_cuboid(self, rim_cell, socket_cell, flat_cell, edge_cell):
        """The part's whole cuboid with one cell per socket on every face: recessed couplings at full detail, a flat
        painted coupling per cell at lod1, a plain box at lod2."""
        lo, hi, n = self.lo, self.hi, self.cells
        if self.level == 2:
            self.box(lo, hi, flat_cell, FIT)  # one coupling drawn per face keeps the average tone of lod1
            return
        verts = {}

        def vert(i, j, k):
            key = (i, j, k)
            if key not in verts:
                verts[key] = self.bm.verts.new(Vector((lo.x + i * CELL, lo.y + j * CELL, lo.z + k * CELL)))
            return verts[key]
        cells = []
        for axis in range(3):
            a1, a2 = [i for i in range(3) if i != axis]
            for side in (0, n[axis]):
                for p in range(n[a1]):
                    for q in range(n[a2]):
                        corners = []
                        for dp, dq in ((0, 0), (1, 0), (1, 1), (0, 1)):
                            idx = [0, 0, 0]
                            idx[axis], idx[a1], idx[a2] = side, p + dp, q + dq
                            corners.append(vert(*idx))
                        f = self.bm.faces.new(corners)
                        cells.append(f)
        bmesh.ops.recalc_face_normals(self.bm, faces=cells)
        self.tag(cells, flat_cell if self.level == 1 else socket_cell, FIT)
        outline = [e for e in self.bm.edges if e.calc_face_angle(0) > 0.1]
        if self.level == 0:
            rim = bmesh.ops.inset_individual(self.bm, faces=cells, thickness=RIM, depth=0, use_even_offset=True)
            self.tag(rim["faces"], rim_cell, PLANAR)
            wall = bmesh.ops.inset_individual(self.bm, faces=cells, thickness=WALL, depth=-RECESS, use_even_offset=True)
            self.tag(wall["faces"], edge_cell, PLANAR)
        # The cuboid's own edges, chamfered last so the chamfer eats into the rim, not the couplings.
        res = bmesh.ops.bevel(self.bm, geom=outline + list(dict.fromkeys(v for e in outline for v in e.verts)), offset=EDGE_CHAMFER, segments=1, affect="EDGES", profile=0.5, clamp_overlap=True)
        self.tag(res["faces"], edge_cell, PLANAR)

    # -- output ----------------------------------------------------------

    def mesh(self, name, collection):
        bm = self.bm
        bm.normal_update()
        uv = bm.loops.layers.uv.new("UVMap")
        for f in bm.faces:
            cell = self.names[f[self.surface]]
            u_axis, v_axis = face_axes(f.normal)
            if f[self.mode] == 0:  # fit the face's extent to the whole cell
                us = [l.vert.co.dot(u_axis) for l in f.loops]
                vs = [l.vert.co.dot(v_axis) for l in f.loops]
                u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
                for l, uu, vv in zip(f.loops, us, vs):
                    l[uv].uv = cell_uv(cell, (uu - u0) / max(u1 - u0, 1e-6), (vv - v0) / max(v1 - v0, 1e-6))
            else:  # a planar projection: ``planar_span`` metres round ``planar_centre`` fill the cell
                for l in f.loops:
                    d = l.vert.co - self.planar_centre
                    l[uv].uv = cell_uv(cell, min(max(d.dot(u_axis) / self.planar_span + 0.5, 0), 1), min(max(d.dot(v_axis) / self.planar_span + 0.5, 0), 1))
        # bmesh operators (bevel, inset) emit faces and loops in an order that changes between runs, so the mesh is
        # rebuilt canonically: fixed triangulation, each triangle starting at its smallest corner, triangles sorted.
        bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method="FIXED", ngon_method="EAR_CLIP")
        tris = []
        for f in bm.faces:
            corners = [(tuple(round(c, 6) + 0.0 for c in l.vert.co), tuple(round(c, 6) + 0.0 for c in l[uv].uv)) for l in f.loops]
            k = corners.index(min(corners))
            if len({co for co, _ in corners}) == 3:  # drop triangles that collapse at 1 µm
                tris.append((f[self.bone_layer],) + tuple(corners[k:] + corners[:k]))
        bm.free()
        tris.sort()
        # A vertex is a position on one bone: pieces on different bones never share a vertex, so they part cleanly.
        points, faces, uvs = {}, [], []
        for bone, *tri in tris:
            faces.append([points.setdefault((co, bone), len(points)) for co, _ in tri])
            uvs.extend(t for _, t in tri)
        data = bpy.data.meshes.new(name)
        data.from_pydata([co for co, _ in points], [], faces)
        data.uv_layers.new(name="UVMap")
        data.uv_layers[0].data.foreach_set("uv", np.array(uvs, dtype=np.float32).ravel())
        data.polygons.foreach_set("use_smooth", np.zeros(len(faces), dtype=bool))
        data.update()
        data.materials.append(atlas_material())
        obj = bpy.data.objects.new(name, data)
        collection.objects.link(obj)
        if len(self.bones) > 1:
            self.skin(obj, collection, [bone for _, bone in points])
        return obj

    def skin(self, obj, collection, vertex_bones):
        """An armature of ``self.bones`` (each pointing along +z with no roll, so its glTF node starts unrotated, its
        axes the part's) and one vertex group per bone, every vertex weighted 1 to its own bone."""
        rig = bpy.data.objects.new(f"{obj.name}.rig", bpy.data.armatures.new(f"{obj.name}.rig"))
        collection.objects.link(rig)
        view_layer = bpy.context.view_layer
        previous = view_layer.objects.active
        view_layer.objects.active = rig
        bpy.ops.object.mode_set(mode="EDIT")
        for name, head, parent in self.bones:
            edit = rig.data.edit_bones.new(name)
            edit.head = Vector(head)
            edit.tail = Vector(head) + Vector((0, 0, 0.05))
            edit.roll = 0.0
            if parent:
                edit.parent = rig.data.edit_bones[parent]
        bpy.ops.object.mode_set(mode="OBJECT")
        view_layer.objects.active = previous
        for index, (name, _, _) in enumerate(self.bones):
            group = obj.vertex_groups.new(name=name)
            group.add([i for i, bone in enumerate(vertex_bones) if bone == index], 1.0, "REPLACE")
        obj.parent = rig
        obj.modifiers.new("rig", "ARMATURE").object = rig
        for pose in rig.pose.bones:
            pose.rotation_mode = "QUATERNION"


# ---------------------------------------------------------------- parts

def chassis(p):
    p.socket_cuboid("paint", "socket", "socket-flat", "gunmetal")


def beam(p):
    p.socket_cuboid("beam-paint", "socket-beam", "socket-flat-beam", "gunmetal")


def core(p):
    """The control core, the kill target: a white-hot reactor sphere in an open armoured cage on a hazard-striped base."""
    lvl = p.level
    p.box((-0.1, -0.1, 0), (0.1, 0.1, 0.035), "hazard", bevel=0.006 if lvl == 0 else 0, top="panel")
    if lvl < 2:
        for sx in (-1, 1):
            for sy in (-1, 1):
                p.box((sx * 0.1 - (0.02 if sx > 0 else 0), sy * 0.1 - (0.02 if sy > 0 else 0), 0.035),
                      (sx * 0.1 + (0.02 if sx < 0 else 0), sy * 0.1 + (0.02 if sy < 0 else 0), 0.184), "gunmetal", bevel=0.004 if lvl == 0 else 0)
        # The top frame: four bars round an open square, so the glow shows from above too.
        for lo, hi in (((-0.1, -0.1, 0.184), (0.1, -0.08, 0.2)), ((-0.1, 0.08, 0.184), (0.1, 0.1, 0.2)),
                       ((-0.1, -0.08, 0.184), (-0.08, 0.08, 0.2)), ((0.08, -0.08, 0.184), (0.1, 0.08, 0.2))):
            p.box(lo, hi, "gunmetal", bevel=0.003 if lvl == 0 else 0)
        p.sphere((0, 0, 0.11), 0.074, 20 if lvl == 0 else 10, 12 if lvl == 0 else 6, "core-glow")
        if lvl == 0:
            # Containment rings: one round the equator, two meridians. Each is a closed thin disc whose middle hides
            # inside the sphere, so only the ring shows and no open edge does from any side.
            for axis in ((0, 0, 1), (1, 0, 0), (0, 1, 0)):
                p.cylinder(Vector((0, 0, 0.11)) - Vector(axis) * 0.005, axis, 0.077, 0.01, 24, "steel")
            p.cylinder((0, 0, 0.035), (0, 0, 1), 0.03, 0.012, 12, "steel")
    else:
        p.box((-0.07, -0.07, 0.04), (0.07, 0.07, 0.18), "core-glow")
    return {}


def sensor(p):
    """A sensor head: a housing with a large lens looking along +x, side vents and a neck collar."""
    lvl = p.level
    p.box((-0.085, -0.085, 0), (0.085, 0.085, 0.03), "gunmetal", bevel=0.004 if lvl == 0 else 0)
    p.box((-0.095, -0.095, 0.03), (0.07, 0.095, 0.19), "paint", bevel=0.012 if lvl == 0 else 0)
    if lvl < 2:
        p.cylinder((0.07, 0, 0.11), (1, 0, 0), 0.07, 0.022, 20 if lvl == 0 else 10, "gunmetal", cap="lens", radius2=0.062)
        for sy in (-1, 1):
            y0, y1 = sorted((sy * 0.09, sy * 0.099))  # proud of the housing, so it never fights its face
            p.box((-0.07, y0, 0.06), (0.04, y1, 0.16), "vent", FIT)
        if lvl == 0:
            p.box((-0.08, -0.03, 0.19), (-0.02, 0.03, 0.2), "gunmetal")  # top hatch
            p.cylinder((-0.05, 0.06, 0.19), (0, 0, 1), 0.006, 0.01, 6, "steel")
    else:
        p.box((0.07, -0.06, 0.05), (0.1, 0.06, 0.17), "gunmetal", FIT, top=None)
    return {}


def battery(p):
    """A battery: one large cell along y in a cradle, terminal caps at both ends and a lit charge window on top."""
    lvl = p.level
    ly = p.hi.y
    p.box((-0.1, -0.1, 0), (0.1, ly, 0.03), "gunmetal", bevel=0.005 if lvl == 0 else 0)
    if lvl < 2:
        sides = 20 if lvl == 0 else 10
        p.cylinder((0, -0.085, 0.11), (0, 1, 0), 0.085, ly + 0.07, sides, "paint")
        for y in (-0.1, ly - 0.015):
            p.cylinder((0, y, 0.11), (0, 1, 0), 0.06, 0.015, sides, "steel", cap="steel")
        p.box((-0.03, -0.04, 0.192), (0.03, ly - 0.04, 0.2), "battery", FIT)
        if lvl == 0:
            for y in (0.0, ly - 0.1):  # clamp bands
                p.box((-0.092, y, 0.02), (0.092, y + 0.03, 0.15), "gunmetal", bevel=0.003)
                p.cylinder((0, y - 0.001, 0.11), (0, 1, 0), 0.09, 0.032, sides, "gunmetal")
    else:
        p.box((-0.085, -0.1, 0.03), (0.085, ly, 0.195), "paint", top="battery")
    return {}


def armor_plate(p):
    """A 40 x 40 cm armor plate on two low brackets: a thick faceted slab whose top slopes to bevelled edges. The damaged
    variant keeps the outline but loses a corner, is dented and holed, and is scorched."""
    lvl, damaged = p.level, p.variant == "damaged"
    lo, hi = p.lo, p.hi
    cell = "armor-damaged" if damaged else "armor"
    # The armor cells are painted for one plate: its 40 cm fill the cell.
    p.planar_centre, p.planar_span = (lo + hi) / 2, 0.42
    if lvl == 2:
        p.box((lo.x + 0.004, lo.y + 0.004, 0.0), (hi.x - 0.004, hi.y - 0.004, 0.14), cell)
        return {}
    for x in (lo.x + 0.07, hi.x - 0.13):
        p.box((x, lo.y + 0.03, 0), (x + 0.06, hi.y - 0.03, 0.045), "gunmetal", bevel=0.004 if lvl == 0 else 0)
    # The slab: an inner top grid over an outer bottom ring; full detail subdivides the top to dent it.
    div = 4 if lvl == 0 else 1
    inset = 0.055
    bottom = [Vector((lo.x + 0.004, lo.y + 0.004, 0.045)), Vector((hi.x - 0.004, lo.y + 0.004, 0.045)),
              Vector((hi.x - 0.004, hi.y - 0.004, 0.045)), Vector((lo.x + 0.004, hi.y - 0.004, 0.045))]
    mid = [Vector((v.x, v.y, 0.095)) for v in bottom]
    tx0, tx1, ty0, ty1 = lo.x + inset, hi.x - inset, lo.y + inset, hi.y - inset
    top = [[p.bm.verts.new(Vector((tx0 + (tx1 - tx0) * i / div, ty0 + (ty1 - ty0) * j / div, 0.15))) for j in range(div + 1)] for i in range(div + 1)]
    if damaged:  # impacts dent the inner top
        for i in range(1, div):
            for j in range(1, div):
                top[i][j].co.z -= 0.018 * between(0, 1, "dent", i, j) ** 2
    vb = [p.bm.verts.new(v) for v in bottom]
    vm = [p.bm.verts.new(v) for v in mid]
    if damaged:  # the torn corner: the slab's +x +y corner is shot away, the top bent down towards it
        for v in (vb[2], vm[2]):
            v.co.x -= 0.07
            v.co.y -= 0.07
        vm[2].co.z -= 0.02
        top[div][div].co.x -= 0.05
        top[div][div].co.y -= 0.05
        top[div][div].co.z -= 0.035
        if div > 1:
            top[div - 1][div].co.z -= 0.015
            top[div][div - 1].co.z -= 0.015
            top[div - 1][div - 1].co.z -= 0.01
    ring = [top[i][0] for i in range(div)] + [top[div][j] for j in range(div)] + [top[i][div] for i in range(div, 0, -1)] + [top[0][j] for j in range(div, 0, -1)]
    tops = [p.bm.faces.new((top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1])) for i in range(div) for j in range(div)]
    p.tag(tops, cell, PLANAR)
    # Slopes from the top's edge ring down to the mid ring, one fan per side.
    corners_at = [0, div, 2 * div, 3 * div]
    slopes = []
    for side in range(4):
        a, b = vm[side], vm[(side + 1) % 4]
        seg = [ring[(corners_at[side] + k) % (4 * div)] for k in range(div + 1)]
        slopes.append(p.bm.faces.new([a, b] + list(reversed(seg))))
        slopes.append(p.bm.faces.new((vb[side], vb[(side + 1) % 4], b, a)))
    p.bm.faces.new(list(reversed(vb)))
    bmesh.ops.recalc_face_normals(p.bm, faces=list(p.bm.faces))
    p.tag(slopes, cell, PLANAR)
    p.tag([f for f in p.bm.faces if f[p.surface] == 0 and f not in tops and f not in slopes], "gunmetal")
    if lvl == 0:
        for sx, sy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            if damaged and (sx, sy) == (1, 1):
                continue
            x = tx0 + 0.02 if sx == 0 else tx1 - 0.02
            y = ty0 + 0.02 if sy == 0 else ty1 - 0.02
            p.cylinder((x, y, 0.148), (0, 0, 1), 0.012, 0.008, 8, "steel", cap="steel")
    return {}


# ---------------------------------------------------------------- joints and the leg
#
# A joint's pivot is a knuckle (a cylinder round the axis) on the moving side, held between clevis cheeks on the fixed
# side, so turning it never opens a gap or pushes one piece through another inside its clearance range. Every axis
# runs through the part's centre line: the hinge's and the leg's along the part's x, the rotor's along its z.

HINGE_PIVOT = (0.0, 0.0, 0.1)
ROTOR_PIVOT = (0.0, 0.0, 0.1)
# The leg's joints along its length (z from the hip mount, 0, to the sole, 0.8) and its segments' lengths.
LEG_HIP, LEG_KNEE, LEG_ANKLE, LEG_SOLE = 0.08, 0.43, 0.73, 0.8
LEG_THIGH, LEG_SHIN = LEG_KNEE - LEG_HIP, LEG_ANKLE - LEG_KNEE


def knuckle(p, z, half_width, radius, sides, cell="gunmetal"):
    """A pivot knuckle along x at height ``z``."""
    p.cylinder((-half_width, 0, z), (1, 0, 0), radius, 2 * half_width, sides, cell)


def clevis(p, z, inner, outer, half_depth, below, radius, sides, cell="gunmetal", bevel=0.0):
    """Two cheeks round a pivot along x at height ``z``, from ``inner`` to ``outer`` either side, reaching ``below``
    towards the part's base (or away from it, if ``below`` > ``z``), rounded round the axis."""
    for sx in (-1, 1):
        x0, x1 = sorted((sx * inner, sx * outer))
        z0, z1 = sorted((below, z))
        p.box((x0, -half_depth, z0), (x1, half_depth, z1), cell, bevel=bevel)
        p.cylinder((x0, 0, z), (1, 0, 0), radius, x1 - x0, sides, cell)


def hinge(p):
    """A hinge servo: a clevis bracket on the mount face holds a knuckle on x through the cell's centre; the knuckle
    carries the moving plate, whose top is the joint's one socket. The plate clears the bracket a quarter turn either
    way."""
    lvl = p.level
    sides = 16 if lvl == 0 else 8
    z = HINGE_PIVOT[2]
    if lvl == 2:
        p.box((-0.1, -0.045, 0), (0.1, 0.045, 0.145), "gunmetal")
        p.bone("hinge", HINGE_PIVOT, "base")
        p.box((-0.1, -0.1, 0.155), (0.1, 0.1, 0.2), "paint", top="socket-flat")
        return {}
    bevel = 0.004 if lvl == 0 else 0.0
    p.box((-0.1, -0.045, 0), (0.1, 0.045, 0.03), "gunmetal", bevel=bevel)
    clevis(p, z, 0.06, 0.096, 0.045, 0.03, 0.045, sides, "paint", bevel)
    for sx in (-1, 1):  # the servo's drive caps on the axis
        p.cylinder((sx * 0.096, 0, z), (sx, 0, 0), 0.028, 0.004, sides, "hazard" if sx > 0 else "steel", cap="steel")
    p.bone("hinge", HINGE_PIVOT, "base")
    knuckle(p, z, 0.058, 0.043, sides)
    p.box((-0.055, -0.03, z), (0.055, 0.03, 0.156), "gunmetal", bevel=bevel)
    p.box((-0.1, -0.1, 0.155), (0.1, 0.1, 0.2), "paint", bevel=bevel, top="socket-flat")
    return {}


def rotor(p):
    """A continuous rotor: a square flange and a drum on the mount face, a steel bearing ring, and the moving turntable
    with hazard stripes round its rim (so a turn reads) and the joint's one socket on top."""
    lvl = p.level
    sides = 24 if lvl == 0 else 12
    if lvl == 2:
        p.box((-0.1, -0.1, 0), (0.1, 0.1, 0.09), "gunmetal")
        p.bone("rotor", ROTOR_PIVOT, "base")
        p.box((-0.085, -0.085, 0.09), (0.085, 0.085, 0.2), "hazard", top="socket-flat")
        return {}
    bevel = 0.004 if lvl == 0 else 0.0
    p.box((-0.1, -0.1, 0), (0.1, 0.1, 0.025), "gunmetal", bevel=bevel)
    p.cylinder((0, 0, 0.025), (0, 0, 1), 0.094, 0.06, sides, "paint")
    if lvl == 0:
        for sx in (-1, 1):  # flange bolts
            for sy in (-1, 1):
                p.cylinder((sx * 0.082, sy * 0.082, 0.025), (0, 0, 1), 0.008, 0.005, 6, "steel", cap="steel")
    p.bone("rotor", ROTOR_PIVOT, "base")
    p.cylinder((0, 0, 0.08), (0, 0, 1), 0.08, 0.035, sides, "steel")
    p.cylinder((0, 0, 0.115), (0, 0, 1), 0.098, 0.045, sides, "hazard")
    p.cylinder((0, 0, 0.16), (0, 0, 1), 0.098, 0.04, sides, "paint", cap="socket")
    return {}


def leg(p):
    """The self-contained 80 cm leg, hip at the mount face, sole at the far end: a clevis hip bracket, a pale thigh
    with a steel actuator behind it, a graphite shin with an olive guard in front, and a foot whose toe points along
    the part's +y. Hip, knee and ankle turn about x; a positive knee angle folds the shin back (the knee forward)."""
    lvl = p.level
    if lvl == 2:
        p.box((-0.1, -0.1, 0), (0.1, 0.1, 0.03), "gunmetal")
        p.bone("hip", (0, 0, LEG_HIP), "base")
        p.box((-0.06, -0.065, 0.035), (0.06, 0.055, LEG_KNEE), "paint")
        p.bone("knee", (0, 0, LEG_KNEE), "hip")
        p.box((-0.05, -0.045, LEG_KNEE), (0.05, 0.06, LEG_ANKLE), "beam-paint")
        p.bone("ankle", (0, 0, LEG_ANKLE), "knee")
        p.box((-0.085, -0.08, LEG_ANKLE), (0.085, 0.1, LEG_SOLE), "gunmetal")
        return {}
    sides = 16 if lvl == 0 else 8
    bevel = 0.004 if lvl == 0 else 0.0
    # The hip bracket (fixed to the parent).
    p.box((-0.1, -0.1, 0), (0.1, 0.1, 0.03), "gunmetal", bevel=bevel)
    clevis(p, LEG_HIP, 0.06, 0.095, 0.05, 0.03, 0.05, sides, "paint", bevel)
    if lvl == 0:
        p.box((-0.07, 0.06, 0.03), (0.07, 0.1, 0.04), "hazard")  # the front edge, so a leg's facing reads
    # The thigh.
    p.bone("hip", (0, 0, LEG_HIP), "base")
    knuckle(p, LEG_HIP, 0.058, 0.045, sides)
    p.box((-0.055, -0.06, 0.13), (0.055, 0.05, 0.385), "paint", bevel=0.008 if lvl == 0 else 0.0)
    p.box((-0.04, -0.03, LEG_HIP), (0.04, 0.03, 0.135), "gunmetal")
    clevis(p, LEG_KNEE, 0.06, 0.09, 0.045, 0.37, 0.045, sides, "gunmetal", bevel)
    p.box((-0.09, -0.045, 0.37), (0.09, 0.03, 0.39), "gunmetal")  # the bridge joining the knee cheeks
    if lvl == 0:
        p.cylinder((0, -0.075, 0.14), (0, 0, 1), 0.013, 0.24, 8, "steel", cap="steel")  # the knee actuator
        p.box((-0.02, -0.08, 0.13), (0.02, -0.06, 0.15), "gunmetal")
        p.box((-0.02, -0.08, 0.37), (0.02, -0.06, 0.39), "gunmetal")
        p.box((-0.056, 0.05, 0.16), (0.056, 0.056, 0.35), "vent", FIT)
    # The shin.
    p.bone("knee", (0, 0, LEG_KNEE), "hip")
    knuckle(p, LEG_KNEE, 0.058, 0.042, sides)
    p.box((-0.05, -0.045, 0.45), (0.05, 0.045, 0.70), "beam-paint", bevel=0.006 if lvl == 0 else 0.0)
    p.box((-0.035, -0.03, LEG_KNEE), (0.035, 0.03, 0.455), "gunmetal")
    p.box((-0.045, 0.045, 0.46), (0.045, 0.062, 0.68), "armor", bevel=0.003 if lvl == 0 else 0.0)
    p.box((-0.035, -0.025, 0.695), (0.035, 0.025, LEG_ANKLE), "gunmetal")
    knuckle(p, LEG_ANKLE, 0.052, 0.03, sides)
    # The foot (its clevis holds the shin's ankle knuckle).
    p.bone("ankle", (0, 0, LEG_ANKLE), "knee")
    clevis(p, LEG_ANKLE, 0.056, 0.085, 0.035, 0.765, 0.035, sides, "gunmetal", bevel)
    p.box((-0.085, -0.075, 0.765), (0.085, 0.1, 0.785), "paint", bevel=bevel)
    p.box((-0.09, -0.08, 0.785), (0.09, 0.1, LEG_SOLE), "panel")
    if lvl == 0:
        p.box((-0.07, 0.065, 0.758), (0.07, 0.095, 0.765), "hazard")  # the toe
    return {}


# Reference walk cycles for one leg (preview only: Shooter moves legs physically). Per clip: seconds per cycle, the
# stride (how far the sole travels back along the leg's -y while planted), the planted fraction of the cycle, the
# swing's lift and the hip-to-ankle distance while planted. Phases per leg are in the docs.
CLIP_FPS = 30
WALK_CLIPS = {
    "walk-biped": {"seconds": 1.0, "stride": 0.36, "duty": 0.6, "lift": 0.07, "depth": 0.6},
    "walk-quadruped": {"seconds": 0.8, "stride": 0.28, "duty": 0.7, "lift": 0.05, "depth": 0.6},
}


def leg_pose(clip, phase):
    """Hip, knee and ankle angles (radians about x) at ``phase`` in [0, 1): the ankle follows a planted line back, then
    a lifted swing forward; two-link IK places the knee forward and the ankle keeps the sole level."""
    c = WALK_CLIPS[clip]
    stride, duty, lift, depth = c["stride"], c["duty"], c["lift"], c["depth"]
    if phase < duty:
        s = phase / duty
        y, z = stride * (0.5 - s), depth
    else:
        s = (phase - duty) / (1 - duty)
        y, z = stride * (-0.5 + (1 - math.cos(math.pi * s)) / 2), depth - lift * math.sin(math.pi * s)
    d = math.hypot(y, z)
    psi = math.atan2(-y, z)
    beta = math.acos((LEG_THIGH ** 2 + d * d - LEG_SHIN ** 2) / (2 * LEG_THIGH * d))
    gamma = math.acos((LEG_THIGH ** 2 + LEG_SHIN ** 2 - d * d) / (2 * LEG_THIGH * LEG_SHIN))
    hip_angle, knee_angle = psi - beta, math.pi - gamma
    return {"hip": hip_angle, "knee": knee_angle, "ankle": -(hip_angle + knee_angle)}


def add_clips(obj):
    """Bake each walk cycle on the leg's rig, one keyframe a frame, as its own NLA track (one glTF animation each)."""
    rig = obj.parent
    rig.animation_data_create()
    for name, clip in WALK_CLIPS.items():
        action = bpy.data.actions.new(name)
        rig.animation_data.action = action
        frames = round(clip["seconds"] * CLIP_FPS)
        for frame in range(frames + 1):
            angles = leg_pose(name, (frame % frames) / frames)
            for bone, angle in angles.items():
                pose = rig.pose.bones[bone]
                pose.rotation_quaternion = (math.cos(angle / 2), math.sin(angle / 2), 0, 0)
                pose.keyframe_insert("rotation_quaternion", frame=frame, group=bone)
        rig.animation_data.action = None
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, action)
    for pose in rig.pose.bones:
        pose.rotation_quaternion = (1, 0, 0, 0)


BUILDERS = {
    "robot.chassis.20x40x80": chassis, "robot.chassis.40x40x80": chassis, "robot.chassis.40x60x80": chassis,
    "robot.beam.20x20x40": beam, "robot.beam.20x20x80": beam,
    "robot.core": core, "robot.sensor": sensor, "robot.battery": battery, "robot.armor.plate": armor_plate,
    "robot.joint.hinge": hinge, "robot.joint.rotor": rotor, "robot.leg": leg,
}


def build(key, collection, level=0, variant="default", location=(0, 0, 0)):
    """One part as one mesh object whose origin is the part's mount anchor, placed at ``location`` (Blender axes).
    Articulated parts come as a mesh skinned to an armature (``obj.parent``), which is what ``location`` moves."""
    cells, _ = PARTS[key]
    part = Part(key, cells, level, variant)
    info = BUILDERS[key](part) or {}
    obj = part.mesh(key, collection)
    (obj.parent or obj).location = location
    if obj.parent:
        info["bones"] = [{"name": name, "head": [round(c, 6) for c in head], "parent": parent} for name, head, parent in part.bones]
    if key == "robot.leg":
        add_clips(obj)
        info["clips"] = sorted(WALK_CLIPS)
    return obj, info


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or set(arguments) != {"schemaVersion", "part", "cells", "level", "variant"}:
        raise ValueError("combat-robot arguments must be {schemaVersion: 1, part, cells, level, variant}")
    if arguments["part"] not in PARTS:
        raise ValueError(f"combat-robot part must be one of {', '.join(PARTS)}")
    if list(arguments["cells"]) != list(PARTS[arguments["part"]][0]):
        raise ValueError(f"{arguments['part']} is {PARTS[arguments['part']][0]} cells, not {arguments['cells']}")
    if arguments["level"] not in (0, 1, 2):
        raise ValueError("combat-robot level must be 0, 1 or 2")
    if arguments["variant"] not in VARIANTS.get(arguments["part"], ("default",)):
        raise ValueError(f"{arguments['part']} has no variant {arguments['variant']}")
    if set(inputs) != {"common"}:
        raise ValueError("combat-robot recipe takes exactly the input 'common' (kit_common.py)")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_common(inputs.load_source("common"))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    key, level, variant = arguments["part"], arguments["level"], arguments["variant"]
    obj, info = build(key, bpy.context.scene.collection, level, variant)
    bpy.context.scene.render.fps = CLIP_FPS
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    rig = obj.parent
    if rig:
        # glTF ignores a skinned mesh's parents, so the mesh is exported as a root node beside its skeleton.
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
    return {"recipe": RECIPE, "part": key, "level": level, "variant": variant, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "mount-anchor", "triangleCount": triangles, **info}
