"""Gatherables (docs/gatherables.md, #762): Greyhaven's first crafting materials on one procedural atlas.

- ``ore-vein`` and ``ore-vein-depleted``: an iron-streaked outcrop of Greyfang Ridge rock in its two states. Both share the
  same rock; the full vein runs a rust-stained seam across it with dark ore nodules standing proud, and the depleted vein
  has the seam chipped out to pale fresh stone, with a few chips at its foot. The rock is the crag and limestone kits'
  grey (``PALETTE``), so it sits on the ridge beside them.
- ``iron-ore``, ``boar-hide`` and ``boar-tusk``: small drop meshes of the three materials, lying on the ground. Their level-0
  run also renders the item's inventory icon (``ICON_EDGE`` px, transparent PNG) and returns it base64-encoded as the
  observation ``icon``.

Nothing here is gameplay: gathering, depletion timers, loot and crafting belong to the game. ``arguments`` are ``piece``
and ``level`` (0 is full detail, 1 and 2 are ``lod1`` and ``lod2`` in the same frame and on the same atlas). Shapes use
``mathutils.noise``, which holds no random state; variation is a SHA-256 of fixed keys and the textures come from numpy's
legacy ``RandomState``, through the declared input ``common`` (``kit_common.py``). Authored in glTF axes: metres, +Y up,
origin on the ground at the footprint centre.

``build(piece, collection, level, location)`` also works in a live Blender after ``use_common(...)``.
"""
import base64
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector, noise

RECIPE = "gatherables-v1"
PIECES = ("ore-vein", "ore-vein-depleted", "iron-ore", "boar-hide", "boar-tusk")
ITEMS = ("iron-ore", "boar-hide", "boar-tusk")
MATERIAL = "gatherables"
BURY = 0.22  # how far the outcrop's foot runs below y = 0, for uneven ground
# The mmorpg rock palette (cliff_outcrop.py, gravestones.py): the atlas's rock is scaled to its mean.
PALETTE = {"rock": 0x8b877e}

# Atlas cells, as pixels x, y (from the top left), width and height, with a gutter between them.
ATLAS_EDGE = 1024
GUTTER = 8
CELLS = {
    "rock": (8, 8, 496, 496),
    "seam": (520, 8, 496, 496),
    "chipped": (8, 520, 240, 240),
    "hide": (264, 520, 496, 240),
    "flesh": (776, 520, 240, 240),
    "tusk": (8, 776, 240, 240),
    "ore": (264, 776, 240, 240),
}
ROCK_TILE = 1.1  # metres of rock along a rock cell's edge
# Outcrop shape: half-extents (x, y, z) in glTF axes, and the icosphere subdivisions per level.
OUTCROP = {"radii": (0.95, 0.8, 0.7), "subdivisions": (4, 3, 2)}
# The seam: a slab through the rock, its normal (glTF axes), offset from the centre and half-width, in metres.
SEAM = {"normal": (0.82, 0.12, -0.56), "offset": 0.08, "half": 0.17, "proud": 0.04, "gouge": 0.13}
ICON_EDGE = 256
ICON_SAMPLES = 48

C = {}


def use_common(namespace):
    """Bind the shared helpers from ``kit_common.py``."""
    C.clear()
    C.update({name: namespace[name] for name in namespace["NAMES"]})


def between(lo, hi, *keys):
    return lo + (hi - lo) * C["rnd"]("gatherables", *keys)


def colour_of(hex_value):
    return np.array([(hex_value >> 16) & 255, (hex_value >> 8) & 255, hex_value & 255]) / 255.0


# ---------------------------------------------------------------- atlas

def smoothstep(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a[None, None] * (1 - t[..., None]) + b[None, None] * t[..., None]


def sheet(seed, base, octaves, w, h, stretch=(1, 1)):
    """Tileable fractal noise resampled to ``w`` x ``h``."""
    tile = C["fbm"](512, base, octaves, seed, stretch)
    return tile[np.ix_((np.arange(h) * 512 // h) % 512, (np.arange(w) * 512 // w) % 512)]


def paint_rock(seed, w, h):
    """Weathered grey ridge stone: broad mottling, fine grain, lichen-pale flecks and dark cracks."""
    base = colour_of(PALETTE["rock"])
    broad = sheet(seed, 3, 5, w, h)
    grain = sheet(seed + 1, 24, 3, w, h)
    cracks = 1 - smoothstep(0.0, 0.012, np.abs(sheet(seed + 2, 4, 3, w, h, (1, 0.6)) - 0.5))
    flecks = smoothstep(0.8, 0.86, sheet(seed + 3, 18, 2, w, h))
    shade = 0.7 + 0.5 * broad + 0.14 * (grain - 0.5)
    colour = base[None, None] * shade[..., None]
    colour = colour * (1 - 0.18 * cracks[..., None]) + np.array((0.7, 0.72, 0.62))[None, None] * 0.15 * flecks[..., None]
    height = broad * 0.8 + grain * 0.35 - cracks * 0.6
    return colour, height, 0.9 - 0.08 * grain, np.zeros((h, w)), 6.0


def paint_seam(seed, w, h):
    """The ore seam: the rock under rust stain, with dark glinting iron lenses and specks."""
    colour, height, rough, metal, strength = paint_rock(seed, w, h)
    iron = smoothstep(0.52, 0.66, sheet(seed + 11, 6, 4, w, h, (1, 0.35)) * 0.7 + (sheet(seed + 10, 3, 3, w, h, (1, 0.5)) - 0.5) * 0.8 + 0.15)
    rust = smoothstep(0.15, 0.55, sheet(seed + 12, 4, 4, w, h) * 0.7 + iron * 0.5)
    specks = smoothstep(0.8, 0.86, sheet(seed + 13, 40, 2, w, h))
    rust_colour = mix(np.array((0.3, 0.16, 0.08)), np.array((0.52, 0.3, 0.14)), sheet(seed + 14, 12, 3, w, h))
    colour = colour * (1 - 0.9 * rust[..., None]) + rust_colour * 0.9 * rust[..., None]
    ore = mix(np.array((0.1, 0.09, 0.09)), np.array((0.3, 0.27, 0.26)), sheet(seed + 15, 20, 3, w, h))
    colour = colour * (1 - iron[..., None]) + ore * iron[..., None]
    colour = colour * (1 - specks[..., None]) + np.array((0.55, 0.52, 0.5))[None, None] * specks[..., None]
    metal = np.clip(iron * 0.6 + specks * 0.8, 0, 1)
    return colour, height + iron * 0.5, rough * (1 - 0.35 * iron), metal, strength


def paint_chipped(seed, w, h):
    """Freshly broken stone where the ore was cut out: paler than the weathered face, with tool scars and rust traces."""
    base = colour_of(PALETTE["rock"]) * 1.18 * np.array((1.05, 1.0, 0.92))
    grain = sheet(seed, 16, 3, w, h)
    scars = smoothstep(0.62, 0.72, sheet(seed + 1, 7, 2, w, h, (1, 0.25)))
    rust = smoothstep(0.62, 0.8, sheet(seed + 2, 5, 3, w, h))
    colour = base[None, None] * (0.85 + 0.3 * grain)[..., None] * (1 - 0.25 * scars[..., None])
    colour = colour * (1 - 0.5 * rust[..., None]) + np.array((0.55, 0.3, 0.14))[None, None] * 0.5 * rust[..., None]
    return colour, grain * 0.6 - scars * 0.8, 0.85 + 0.0 * grain, np.zeros((h, w)), 8.0


def paint_hide(seed, w, h):
    """Boar hide, hair side: short coarse bristles in tufts, grizzled grey-brown, darkest along the spine (the cell's
    middle row, which the hide's length follows), lighter towards the belly edges."""
    v = (np.arange(h)[:, None] + 0.5) / h * np.ones((1, w))
    bristle = sheet(seed, 64, 2, w, h, (0.3, 1))
    tufts = sheet(seed + 1, 14, 3, w, h)
    clumps = sheet(seed + 2, 5, 4, w, h)
    spine = 1 - smoothstep(0.04, 0.16, np.abs(v - 0.5) + (clumps - 0.5) * 0.08)
    belly = smoothstep(0.32, 0.48, np.abs(v - 0.5))
    tone = np.clip(0.45 + (bristle - 0.5) * 1.3 + (tufts - 0.5) * 0.9 - spine * 0.35 + belly * 0.25, 0, 1)
    colour = mix(np.array((0.06, 0.045, 0.035)), np.array((0.42, 0.34, 0.26)), tone)
    grey = smoothstep(0.75, 0.92, bristle) * 0.35 * (1 - spine)
    colour = colour * (1 - grey[..., None]) + np.array((0.55, 0.52, 0.47))[None, None] * grey[..., None]
    return colour, bristle * 0.7 + tufts * 0.6, 0.92 + 0.0 * bristle, np.zeros((h, w)), 10.0


def paint_flesh(seed, w, h):
    """The hide's scraped flesh side: pale tan with darker blotches."""
    mottle = sheet(seed, 5, 4, w, h)
    colour = mix(np.array((0.5, 0.36, 0.25)), np.array((0.76, 0.6, 0.45)), mottle)
    return colour, mottle * 0.3, 0.7 + 0.0 * mottle, np.zeros((h, w)), 3.0


def paint_tusk(seed, w, h):
    """Ivory from the root (v = 0, stained brown) to the polished tip (v = 1), with fine growth lines across it."""
    v = (1 - (np.arange(h)[:, None] + 0.5) / h) * np.ones((1, w))
    lines = sheet(seed, 30, 2, w, h, (1, 0.05))
    stain = 1 - smoothstep(0.05, 0.45, v + (lines - 0.5) * 0.1)
    colour = mix(np.array((0.78, 0.7, 0.55)), np.array((0.93, 0.89, 0.8)), np.clip(v * 0.7 + lines * 0.3, 0, 1))
    colour = colour * (1 - stain[..., None]) + np.array((0.42, 0.3, 0.18))[None, None] * stain[..., None]
    return colour, lines * 0.4, 0.55 - 0.25 * v, np.zeros((h, w)), 2.5


def paint_ore(seed, w, h):
    """Iron ore lumps: dark red-brown haematite with metallic grey crystals and rust."""
    broad = sheet(seed, 4, 4, w, h)
    crystals = smoothstep(0.66, 0.72, sheet(seed + 1, 40, 2, w, h))
    colour = mix(np.array((0.1, 0.07, 0.065)), np.array((0.3, 0.17, 0.11)), broad)
    colour = colour * (1 - crystals[..., None]) + np.array((0.46, 0.46, 0.48))[None, None] * crystals[..., None]
    return colour, broad * 0.6 + crystals * 0.5, 0.75 - 0.4 * crystals, crystals * 0.8, 7.0


PAINTERS = {"rock": lambda w, h: paint_rock(8100, w, h), "seam": lambda w, h: paint_seam(8100, w, h),
            "chipped": lambda w, h: paint_chipped(8200, w, h), "hide": lambda w, h: paint_hide(8300, w, h),
            "flesh": lambda w, h: paint_flesh(8400, w, h), "tusk": lambda w, h: paint_tusk(8500, w, h),
            "ore": lambda w, h: paint_ore(8600, w, h)}


def paint_atlas():
    edge = ATLAS_EDGE
    colour, normal, orm = np.zeros((edge, edge, 3)), np.zeros((edge, edge, 3)), np.ones((edge, edge, 3))
    normal[..., 2] = 1
    normal = normal * 0.5 + 0.5
    orm[..., 2] = 0
    for name, (x, y, w, h) in CELLS.items():
        cell_colour, height, rough, metal, strength = PAINTERS[name](w, h)
        cell_normal = C["normal_map"](height, strength * 0.3)
        cell_orm = np.stack([np.ones((h, w)), np.clip(rough, 0, 1), np.clip(metal, 0, 1)], -1)
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
    tree.links.new(texture("gatherables-colour", colour, True).outputs["Color"], bsdf.inputs["Base Color"])
    normal_node = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(texture("gatherables-normal", normal, False).outputs["Color"], normal_node.inputs["Color"])
    tree.links.new(normal_node.outputs["Normal"], bsdf.inputs["Normal"])
    separate = tree.nodes.new("ShaderNodeSeparateColor")
    tree.links.new(texture("gatherables-orm", orm, False).outputs["Color"], separate.inputs["Color"])
    tree.links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    tree.links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    return mat


def cell_uv(cell, u, v):
    """A cell-local (u, v) in [0, 1], with v = 1 at the cell's top edge, as an atlas coordinate."""
    x, y, w, h = CELLS[cell]
    return ((x + u * w) / ATLAS_EDGE, 1 - (y + (1 - v) * h) / ATLAS_EDGE)


# ---------------------------------------------------------------- mesh

class Part:
    """One piece's mesh at one level, gathered in glTF axes as polygons with their atlas coordinates."""

    def __init__(self, piece, level):
        self.piece, self.level = piece, level
        self.points, self.faces, self.uvs, self.smooth = [], [], [], []

    def add(self, points, faces, uvs, smooth=True):
        """Append ``points`` and ``faces`` (indices into ``points``), each face with its own per-corner ``uvs``."""
        start = len(self.points)
        self.points.extend(tuple(p) for p in points)
        for face, face_uvs in zip(faces, uvs):
            self.faces.append([start + i for i in face])
            self.uvs.extend(face_uvs)
            self.smooth.append(smooth if not callable(smooth) else smooth(face))

    def mesh(self, name, collection):
        data = bpy.data.meshes.new(name)
        data.from_pydata([tuple(C["to_blender"](p)) for p in self.points], [], self.faces)
        data.uv_layers.new(name="UVMap")
        data.uv_layers[0].data.foreach_set("uv", np.array(self.uvs, dtype=np.float32).ravel())
        data.polygons.foreach_set("use_smooth", np.array(self.smooth, dtype=bool))
        data.update()
        data.materials.append(atlas_material())
        obj = bpy.data.objects.new(name, data)
        collection.objects.link(obj)
        return obj


def icosphere(subdivisions):
    """Unit icosphere vertices and triangles, in a fixed order."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=1.0)
    bm.verts.ensure_lookup_table()
    points = [Vector(v.co) for v in bm.verts]
    faces = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    return points, faces


def box_uvs(cell, corners, normal, tile, key):
    """Planar atlas coordinates for one face: projected along its dominant axis, ``tile`` metres to the cell, moved by
    whole repeats (the cells tile) so the face starts inside the cell and clamped to it."""
    axis = max(range(3), key=lambda k: abs(normal[k]))
    a, b = [k for k in range(3) if k != axis]
    offset = (between(0, 1, key, axis, "u"), between(0, 1, key, axis, "v"))
    uv = [((p[a] / tile + offset[0]), (p[b] / tile + offset[1])) for p in corners]
    shift = [math.floor(min(c[k] for c in uv)) for k in (0, 1)]
    uv = [(c[0] - shift[0], c[1] - shift[1]) for c in uv]
    over = [max(max(c[k] for c in uv) - 1, 0) for k in (0, 1)]
    return [cell_uv(cell, min(max(c[0] - over[0], 0), 1), min(max(c[1] - over[1], 0), 1)) for c in uv]


def lump(centre, radii, subdivisions, key, rough=0.18, scale=2.2):
    """A noise-displaced ellipsoid: its points (glTF axes) and triangles."""
    points, faces = icosphere(subdivisions)
    seed = Vector((between(0, 50, key, "x"), between(0, 50, key, "y"), between(0, 50, key, "z")))
    out = []
    for p in points:
        n = noise.fractal(p * scale + seed, 0.5, 2.0, 4) * rough
        d = Vector((p.x * radii[0], p.y * radii[1], p.z * radii[2])) * (1 + n)
        out.append(Vector(centre) + d)
    return out, faces


def face_normal(points):
    a, b, c = points[0], points[1], points[2]
    n = (b - a).cross(c - a)
    return n.normalized() if n.length > 1e-12 else Vector((0, 1, 0))


def seam_distance(p):
    """Signed distance of glTF point ``p`` from the seam's middle plane."""
    return Vector(p).dot(Vector(SEAM["normal"]).normalized()) - SEAM["offset"]


# ---------------------------------------------------------------- pieces

def outcrop_shape(sub, depleted):
    """The outcrop's points and triangles at icosphere subdivision ``sub``: the same surface at every level."""
    rx, ry, rz = OUTCROP["radii"]
    points, faces = lump((0, ry * 0.62 - BURY, 0), (rx, ry, rz), sub, "outcrop", rough=0.22, scale=1.6)
    # Flatten the top a little and splay the foot, so it sits like bedrock rather than a ball.
    for v in points:
        if v.y > ry * 0.9:
            v.y = ry * 0.9 + (v.y - ry * 0.9) * 0.45
        if v.y < 0.15:
            t = (0.15 - v.y) / 0.6
            v.x *= 1 + 0.25 * t
            v.z *= 1 + 0.25 * t
        v.y = max(v.y, -BURY)
    half = SEAM["half"]
    # The seam stands proud on the full vein and is cut back on the depleted one, fading out at its edges.
    for v in points:
        d = seam_distance(v)
        if abs(d) < half * 1.6 and v.y > 0.0:
            fall = 1 - smooth_t(abs(d) / (half * 1.6))
            outward = Vector((v.x, (v.y - ry * 0.3) * 0.6, v.z)).normalized()
            v += outward * (-SEAM["gouge"] if depleted else SEAM["proud"]) * fall
    return points, faces


def outcrop(p, depleted):
    """The ridge outcrop: a flattened, bulging boulder buried at its foot, the seam slanting across its face."""
    rx, ry, rz = OUTCROP["radii"]
    points, faces = outcrop_shape(OUTCROP["subdivisions"][p.level], depleted)
    in_seam = lambda v: abs(seam_distance(v)) < SEAM["half"] and v.y > 0.02
    uvs = []
    for f in faces:
        corners = [points[i] for i in f]
        centre = sum(corners, Vector()) / len(corners)
        cell = ("chipped" if depleted else "seam") if in_seam(centre) else "rock"
        uvs.append(box_uvs(cell, corners, face_normal(corners), ROCK_TILE if cell != "chipped" else 0.5, "outcrop"))
    p.add(points, faces, uvs)
    if not depleted:
        # Dark ore nodules bulge from the seam.
        count = (10, 5, 0)[p.level]
        for k in range(count):
            spot = seam_spot(points, k)
            if spot is None:
                continue
            r = between(0.07, 0.12, "nodule", k)
            nod, nf = lump(spot, (r, r * 0.8, r), 1, f"nodule{k}", rough=0.3)
            p.add(nod, nf, [box_uvs("ore", [nod[i] for i in f], face_normal([nod[i] for i in f]), 0.3, f"nodule{k}") for f in nf], smooth=False)
    elif p.level == 0:
        # Broken chips of the seam at the foot of the face (+Z).
        for k in range(5):
            a = between(-0.9, 0.9, "chip", k)
            d = between(0.95, 1.2, "chip-d", k)
            r = between(0.04, 0.08, "chip-r", k)
            centre = (math.sin(a) * d * rx, r * 0.35, math.cos(a) * d * rz)
            chip, cf = lump(centre, (r, r * 0.6, r * 0.8), 1, f"chip{k}", rough=0.35)
            cell = "chipped" if k % 2 else "seam"
            p.add(chip, cf, [box_uvs(cell, [chip[i] for i in f], face_normal([chip[i] for i in f]), 0.4, f"chip{k}") for f in cf], smooth=False)
    return {"collisionMesh": hull(outcrop_shape(2, depleted)[0])}


def smooth_t(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def seam_spot(points, k):
    """A point on the seam's surface for nodule ``k``: the outermost rock vertex in that direction within the seam."""
    a = between(-1.4, 1.4, "nodule-a", k)
    direction = Vector((math.sin(a), between(0.1, 0.6, "nodule-up", k), math.cos(a))).normalized()
    best = None
    for v in points:
        if abs(seam_distance(v)) < SEAM["half"] * 0.6 and v.y > 0.1:
            score = Vector(v).normalized().dot(direction)
            if best is None or score > best[0]:
                best = (score, v)
    return None if best is None else best[1] * 0.97


def hull(points):
    """A closed convex collision mesh of the outcrop above its buried foot, in glTF axes, wound outward."""
    bm = bmesh.new()
    for v in points:
        bm.verts.new((v.x, max(v.y, -BURY), v.z))
    result = bmesh.ops.convex_hull(bm, input=list(bm.verts))
    for v in result["geom_interior"] + result["geom_unused"]:
        if isinstance(v, bmesh.types.BMVert) and v.is_valid:
            bm.verts.remove(v)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.normal_update()
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    vertices = [[round(v.co.x, 3), round(v.co.y, 3), round(v.co.z, 3)] for v in bm.verts]
    triangles = []
    middle = sum((v.co for v in bm.verts), Vector()) / len(bm.verts)
    for f in bm.faces:
        idx = [v.index for v in f.verts]
        centre = f.calc_center_median()
        if f.normal.dot(centre - middle) < 0:  # the hull is convex, so outward points away from its middle
            idx.reverse()
        triangles.append(idx)
    bm.free()
    if len(triangles) > 240:
        raise ValueError(f"the outcrop's collision mesh has {len(triangles)} triangles, more than 240")
    return {"shape": "triangle-mesh", "vertices": vertices, "triangles": triangles}


def ore_vein(p):
    return outcrop(p, depleted=False)


def ore_vein_depleted(p):
    return outcrop(p, depleted=True)


def iron_ore(p):
    """Three fist-sized lumps of iron ore, one resting on the other two."""
    sub = (2, 1, 1)[p.level]
    lumps = [((-0.045, 0.035, 0.01), (0.055, 0.04, 0.05)), ((0.05, 0.03, -0.015), (0.05, 0.035, 0.045)), ((0.0, 0.075, 0.0), (0.045, 0.035, 0.04))]
    if p.level == 2:
        lumps = lumps[:1]
    for k, (centre, radii) in enumerate(lumps):
        pts, faces = lump(centre, radii, sub, f"ore{k}", rough=0.3, scale=3.0)
        for v in pts:
            v.y = max(v.y, 0.0)
        p.add(pts, faces, [box_uvs("ore", [pts[i] for i in f], face_normal([pts[i] for i in f]), 0.25, f"ore{k}") for f in faces], smooth=p.level == 0)
    return {"collision": "none"}


def boar_hide(p):
    """A skinned boar hide lying flat, hair side up: a rough oval with four leg flaps and a neck, rumpled, its flesh side
    showing where the edge curls."""
    rings, sectors = ((4, 40), (2, 20), (1, 10))[p.level]
    def bump(a, centre, width):
        return math.exp(-(math.atan2(math.sin(a - centre), math.cos(a - centre)) / width) ** 2)
    def radius(a):
        # A pinched body, four leg flaps reaching out past the flanks, the neck to -Z and a short tail stub to +Z.
        r = 0.86 + 0.08 * abs(math.cos(a))
        for centre in (0.62, 2.52, 3.76, 5.66):
            r += 0.42 * bump(a, centre, 0.2)
        return r + 0.3 * bump(a, math.pi * 1.5, 0.32) + 0.14 * bump(a, math.pi * 0.5, 0.1)
    rx, rz = 0.2, 0.28
    def top(k, s):
        a = 2 * math.pi * s / sectors
        t = k / rings
        x, z = math.cos(a) * rx * radius(a) * t, math.sin(a) * rz * radius(a) * t
        rumple = noise.noise(Vector((x * 7, z * 7, 3.1))) * 0.02
        lift = 0.03 * (1 - t * t) + rumple * (0.4 + t)
        return Vector((x, 0.012 + lift, z))
    grid = [[top(k, s) for s in range(sectors)] for k in range(1, rings + 1)]
    centre = top(0, 0)
    pts = [centre] + [v for ring in grid for v in ring]
    idx = lambda k, s: 1 + (k - 1) * sectors + s % sectors
    uv_of = lambda v: (0.5 + v.z, 0.5 + v.x / 0.75)  # the hide runs along the cell's width
    faces, uvs = [], []
    for s in range(sectors):
        faces.append([0, idx(1, s + 1), idx(1, s)])
    for k in range(1, rings):
        for s in range(sectors):
            faces.append([idx(k, s), idx(k, s + 1), idx(k + 1, s + 1), idx(k + 1, s)])
    for f in faces:
        uvs.append([cell_uv("hide", *uv_of(pts[i])) for i in f])
    p.add(pts, faces, uvs)
    # The flesh side: the same outline a little lower, facing down, and a rim joining the two.
    below = [Vector((v.x, max(v.y - 0.016, 0.0), v.z)) for v in pts]
    p.add(below, [list(reversed(f)) for f in faces], [[cell_uv("flesh", *uv_of(pts[i])) for i in reversed(f)] for f in faces])
    rim = [grid[-1][s] for s in range(sectors)] + [Vector((v.x, max(v.y - 0.016, 0.0), v.z)) for v in grid[-1]]
    rim_faces = [[s, (s + 1) % sectors, sectors + (s + 1) % sectors, sectors + s] for s in range(sectors)]
    p.add(rim, rim_faces, [[cell_uv("flesh", 0.1 + 0.8 * ((f[0] % sectors) / sectors), 0.5)] * 4 for f in rim_faces], smooth=False)
    return {"collision": "none"}


def boar_tusk(p):
    """A curved boar tusk lying on its side: a tapering arc from a hollow-looking brown root to an ivory point."""
    rings, sides = ((9, 8), (5, 5), (3, 3))[p.level]
    length, root = 0.21, 0.022
    def centre(t):
        a = t * 1.9  # how far it curls, in radians
        r = length / 1.9
        return Vector((r * math.sin(a) - length * 0.35, root, r * (1 - math.cos(a)) - 0.04))
    pts, faces, uvs = [], [], []
    for k in range(rings + 1):
        t = k / rings
        c = centre(t)
        tangent = (centre(min(t + 0.01, 1)) - centre(max(t - 0.01, 0))).normalized()
        up = Vector((0, 1, 0))
        side = tangent.cross(up).normalized()
        rad = root * (1 - 0.92 * t ** 1.3)
        for s in range(sides):
            a = 2 * math.pi * s / sides
            # A tusk is triangular in section: flatten it a little across its curl.
            pts.append(c + (up * math.cos(a) * 1.0 + side * math.sin(a) * 0.78) * rad)
    for k in range(rings):
        for s in range(sides):
            n = (s + 1) % sides
            faces.append([k * sides + s, k * sides + n, (k + 1) * sides + n, (k + 1) * sides + s])
            uvs.append([cell_uv("tusk", s / sides, k / rings), cell_uv("tusk", (s + 1) / sides, k / rings),
                        cell_uv("tusk", (s + 1) / sides, (k + 1) / rings), cell_uv("tusk", s / sides, (k + 1) / rings)])
    tip = len(pts)
    pts.append(centre(1.0) + (centre(1.0) - centre(0.98)).normalized() * 0.006)
    for s in range(sides):
        faces.append([rings * sides + s, rings * sides + (s + 1) % sides, tip])
        uvs.append([cell_uv("tusk", s / sides, 0.98), cell_uv("tusk", (s + 1) / sides, 0.98), cell_uv("tusk", (s + 0.5) / sides, 1.0)])
    faces.append(list(reversed(range(sides))))
    uvs.append([cell_uv("tusk", 0.5 + 0.4 * math.cos(2 * math.pi * s / sides), 0.04) for s in reversed(range(sides))])
    # Lift it so its lowest point touches the ground.
    low = min(v.y for v in pts)
    pts = [v - Vector((0, low, 0)) for v in pts]
    p.add(pts, faces, uvs)
    return {"collision": "none"}


BUILDERS = {"ore-vein": ore_vein, "ore-vein-depleted": ore_vein_depleted, "iron-ore": iron_ore, "boar-hide": boar_hide, "boar-tusk": boar_tusk}


def build(piece, collection, level=0, location=(0, 0, 0)):
    """One piece as one mesh object at ``location`` (glTF axes)."""
    part = Part(piece, level)
    info = BUILDERS[piece](part)
    obj = part.mesh(f"gatherables.{piece}", collection)
    obj.location = C["to_blender"](location)
    return obj, info


# ---------------------------------------------------------------- icon

def render_icon(obj, path):
    """A transparent ``ICON_EDGE`` px inventory icon of ``obj``: three-quarter view from above, key and rim light."""
    scene = bpy.context.scene
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector([min(c[k] for c in corners) for k in range(3)])
    hi = Vector([max(c[k] for c in corners) for k in range(3)])
    centre, size = (lo + hi) / 2, max((hi - lo).length, 1e-3)
    camera = bpy.data.objects.new("icon-camera", bpy.data.cameras.new("icon-camera"))
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = size * 1.02
    direction = Vector((0.55, -0.75, 0.9)).normalized()
    camera.location = centre + direction * size * 3
    camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(camera)
    scene.camera = camera
    for name, energy, rotation in (("icon-key", 4.0, (0.75, 0.15, 0.9)), ("icon-rim", 2.0, (-0.9, 0.0, 3.6))):
        light = bpy.data.objects.new(name, bpy.data.lights.new(name, "SUN"))
        light.data.energy = energy
        light.rotation_euler = rotation
        scene.collection.objects.link(light)
    world = bpy.data.worlds.new("icon-world")
    world.use_nodes = True
    background = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    background.inputs[0].default_value = (0.55, 0.55, 0.58, 1.0)
    background.inputs[1].default_value = 0.7
    scene.world = world
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = ICON_SAMPLES
    scene.cycles.seed = 0
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.use_denoising = False
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 1
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = ICON_EDGE
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.compression = 100
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    with open(path, "rb") as handle:
        data = handle.read()
    os.remove(path)
    return base64.b64encode(data).decode("ascii")


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or set(arguments) != {"schemaVersion", "piece", "level"}:
        raise ValueError("gatherables arguments must be {schemaVersion: 1, piece, level}")
    if arguments["piece"] not in PIECES:
        raise ValueError(f"gatherables piece must be one of {', '.join(PIECES)}")
    if arguments["level"] not in (0, 1, 2):
        raise ValueError("gatherables level must be 0, 1 or 2")
    if set(inputs) != {"common"}:
        raise ValueError("gatherables recipe takes exactly the input 'common' (kit_common.py)")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_common(inputs.load_source("common"))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    piece, level = arguments["piece"], arguments["level"]
    obj, info = build(piece, bpy.context.scene.collection, level)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO",
        export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    triangles = sum(len(polygon.vertices) - 2 for polygon in obj.data.polygons)
    result = {"recipe": RECIPE, "piece": piece, "level": level, "unit": "meter", "axes": "right-handed-y-up", "origin": "footprint-base-center",
              "facing": "+Z", "triangleCount": triangles, **info}
    if piece.startswith("ore-vein"):
        result["bury"] = BURY
    if piece in ITEMS and level == 0:
        result["icon"] = render_icon(obj, os.path.join(os.path.dirname(output_path), f"{piece}.icon.png"))
    return result
