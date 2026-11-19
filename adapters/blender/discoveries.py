"""Greyhaven discoveries (docs/discoveries.md, #764): three optional risk/reward sites on one procedural atlas.

- **Wolfrun hunter's cache:** ``hunter-lean-to`` (poles under stitched hides), ``hunter-chest`` and ``hunter-chest-open``
  (a lashed plank chest in its two states), ``skinning-rack`` (a pole frame with a laced, stretched hide), ``fire-ring``
  (a cold ring of stones round charred logs) and ``hunter-clue`` (a snapped bow, a torn quiver and spilled arrows: the
  sign that something went wrong).
- **Greyfang lookout:** ``lookout-platform`` (a rough plank deck on four poles with rails), ``lookout-ladder`` (a lashed
  pole ladder), ``signal-brazier`` and ``signal-brazier-lit`` (an iron basket on a pole, cold or burning),
  ``lookout-banner`` (a tattered Redbrand-red banner with its dark brand mark) and ``weapon-rack`` (a trestle with
  spears, axes and a red shield).
- **Eastwater Fen supply cache:** ``fen-punt`` (a half-sunk flat-bottomed punt), ``supply-crates`` and
  ``supply-crates-open`` (oilcloth-wrapped crates, the top one unwrapped and opened) and ``fen-marker`` (a pole with a
  strip of red cloth: the clue).

Grounded low fantasy: bandits, hunters and smugglers, no magic. The red is the Redbrand faction's. Nothing here is
gameplay: discovery, loot, lighting the brazier and opening a chest belong to the game. A piece's two states share its
frame, so a consumer swaps the mesh in place. ``SITES`` lays each site out as a composition the descriptor carries.

``arguments`` are ``piece`` and ``level`` (0 is full detail, 1 and 2 are ``lod1`` and ``lod2`` in the same frame and on
the same atlas). Variation is a SHA-256 of fixed keys and the textures come from numpy's legacy ``RandomState``, through
the declared input ``common`` (``kit_common.py``). Authored in glTF axes: metres, +Y up, facing +Z, origin on the ground
at the footprint centre.

``build(piece, collection, level, location, yaw)`` also works in a live Blender after ``use_common(...)``.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector, noise

RECIPE = "discoveries-v1"
PIECES = ("hunter-lean-to", "hunter-chest", "hunter-chest-open", "skinning-rack", "fire-ring", "hunter-clue",
          "lookout-platform", "lookout-ladder", "signal-brazier", "signal-brazier-lit", "lookout-banner", "weapon-rack",
          "fen-punt", "supply-crates", "supply-crates-open", "fen-marker")
MATERIAL = "discoveries"
BURY = 0.3  # how far posts and poles run below y = 0, for uneven ground
# The mmorpg rock palette (cliff_outcrop.py, gravestones.py) and the Redbrand faction's red (sRGB).
PALETTE = {"rock": 0x8b877e, "redbrand": (0.5, 0.09, 0.07)}

# Atlas cells, as pixels x, y (from the top left), width and height, with a gutter between them.
ATLAS_EDGE = 1024
GUTTER = 8
CELLS = {
    "wood": (8, 8, 496, 240), "pole": (520, 8, 240, 240), "rope": (776, 8, 240, 240),
    "hide": (8, 264, 240, 240), "oilcloth": (264, 264, 240, 240), "cloth": (520, 264, 240, 496), "iron": (776, 264, 240, 240),
    "stone": (8, 520, 240, 240), "char": (264, 520, 240, 240), "wet": (776, 520, 240, 240),
    "flame": (8, 776, 240, 240), "embers": (264, 776, 240, 240),
}
# Metres of surface along a cell's (u, v) edges.
TILE = {"wood": (1.8, 0.9), "pole": (0.5, 2.0), "rope": (0.4, 0.4), "hide": (1.2, 1.2), "oilcloth": (1.0, 1.0),
        "cloth": (0.7, 1.45), "iron": (0.5, 0.5), "stone": (0.6, 0.6), "char": (0.6, 0.6), "wet": (1.8, 0.9),
        "flame": (0.4, 0.6), "embers": (0.4, 0.4)}
SIDES = (8, 5, 3)  # sides of a round pole per level
# Where the lit brazier's light sits, in its frame, and its colour (linear RGB) for a consumer's point light.
BRAZIER = {"top": 3.2, "light": (0.0, 3.55, 0.0), "colour": (1.0, 0.55, 0.2)}
DECK_TOP = 2.25  # the lookout platform's walkable top

# Each site as placements of its pieces, (piece, x, y, z, yaw in radians), in a site frame on the ground (the fen
# cache's water level is y = 0, its bank rising on +X).
SITES = {
    "wolfrun-hunter-cache": [("hunter-lean-to", 0.0, 0.0, 0.0, 0.0), ("hunter-chest", -0.3, 0.0, 0.05, 0.12),
                             ("skinning-rack", 2.0, 0.0, -0.5, -0.55), ("fire-ring", 0.5, 0.0, 1.9, 0.0),
                             ("hunter-clue", -1.5, 0.0, 1.7, 0.7)],
    "greyfang-lookout": [("lookout-platform", 0.0, 0.0, 0.0, 0.0), ("lookout-ladder", 0.35, 0.0, 1.62, 0.0),
                         ("signal-brazier", -1.6, 0.0, 1.5, 0.0), ("lookout-banner", 1.55, 0.0, -1.35, 0.0),
                         ("weapon-rack", -0.3, DECK_TOP, -0.65, 0.0)],
    "eastwater-fen-cache": [("fen-punt", -1.9, 0.0, 0.4, 0.35), ("supply-crates", 1.3, 0.0, -0.3, -0.2),
                            ("fen-marker", 0.2, 0.0, 1.5, 0.0)],
}
# The open/closed and lit/unlit pairs: piece -> (node, state).
STATES = {"hunter-chest": ("hunter-chest", "closed"), "hunter-chest-open": ("hunter-chest", "open"),
          "signal-brazier": ("signal-brazier", "unlit"), "signal-brazier-lit": ("signal-brazier", "lit"),
          "supply-crates": ("supply-crates", "closed"), "supply-crates-open": ("supply-crates", "open")}

C = {}


def use_common(namespace):
    """Bind the shared helpers from ``kit_common.py``."""
    C.clear()
    C.update({name: namespace[name] for name in namespace["NAMES"]})


def between(lo, hi, *keys):
    return lo + (hi - lo) * C["rnd"]("discoveries", *keys)


# ---------------------------------------------------------------- atlas

def smoothstep(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return np.asarray(a)[None, None] * (1 - t[..., None]) + np.asarray(b)[None, None] * t[..., None]


def field(seed, base, octaves, w, h, stretch=(1, 1)):
    """Tileable fractal noise resampled to ``w`` x ``h``."""
    tile = C["fbm"](512, base, octaves, seed, stretch)
    return tile[np.ix_((np.arange(h) * 512 // h) % 512, (np.arange(w) * 512 // w) % 512)]


def zeros(w, h):
    return np.zeros((h, w))


def paint_wood(seed, w, h, base=(0.4, 0.33, 0.25), along_u=True):
    """Weathered split timber: long grain, broad tone changes, knots, silvering where it has dried out."""
    grain = field(seed, 24, 3, w, h, (0.125, 1.0) if along_u else (1.0, 0.125))
    broad = field(seed + 1, 3, 4, w, h)
    knots = smoothstep(0.8, 0.88, field(seed + 2, 6, 2, w, h))
    grey = smoothstep(0.45, 0.75, field(seed + 3, 4, 3, w, h))
    tone = 0.72 + 0.4 * broad + 0.45 * (grain - 0.5)
    colour = np.asarray(base)[None, None] * tone[..., None] * (1 - 0.45 * knots[..., None])
    colour = colour * (1 - 0.35 * grey[..., None]) + np.array((0.46, 0.45, 0.42))[None, None] * 0.35 * grey[..., None]
    return colour, grain * 0.7 + broad * 0.2 - knots * 0.5, 0.86 + 0.06 * grain, zeros(w, h), 5.0, zeros(w, h)


def paint_planks(seed, w, h):
    """``paint_wood`` with plank joints every third of the cell, so a plain board face reads as a deck."""
    colour, height, rough, metal, strength, glow = paint_wood(seed, w, h)
    v = (np.arange(h)[:, None] + 0.5) / h * np.ones((1, w))
    wobble = (field(seed + 4, 4, 2, w, h) - 0.5) * 0.02
    phase = ((v + wobble) * 3) % 1
    joint = 1 - smoothstep(0.0, 0.025, np.minimum(phase, 1 - phase))
    colour = colour * (1 - 0.65 * joint[..., None])
    return colour, height - joint * 0.8, rough, metal, strength, glow


def paint_rope(seed, w, h):
    """Twisted hemp: diagonal strands along u."""
    x, y = np.meshgrid(np.arange(w) / w, np.arange(h) / h)
    twist = 0.5 + 0.5 * np.sin(2 * np.pi * (x * 10 + y * 6))
    fibre = field(seed, 40, 2, w, h, (0.25, 1))
    colour = mix((0.3, 0.24, 0.15), (0.62, 0.52, 0.35), np.clip(twist * 0.7 + fibre * 0.4, 0, 1))
    return colour, twist * 0.8 + fibre * 0.2, 0.92 + 0.0 * x, zeros(w, h), 6.0, zeros(w, h)


def paint_hide(seed, w, h):
    """Rawhide and stitched skins: tan, blotched, with darker scraped veins and a few patches of hair left on."""
    mottle = field(seed, 5, 4, w, h)
    veins = 1 - smoothstep(0.0, 0.02, np.abs(field(seed + 1, 3, 3, w, h, (1, 0.7)) - 0.5))
    hair = smoothstep(0.62, 0.7, field(seed + 2, 4, 3, w, h)) * field(seed + 3, 48, 2, w, h)
    colour = mix((0.42, 0.3, 0.19), (0.7, 0.56, 0.39), mottle)
    colour = colour * (1 - 0.25 * veins[..., None])
    colour = colour * (1 - 0.6 * hair[..., None]) + np.array((0.2, 0.15, 0.1))[None, None] * 0.6 * hair[..., None]
    return colour, mottle * 0.3 + hair * 0.5 - veins * 0.2, 0.75 + 0.15 * hair, zeros(w, h), 3.0, zeros(w, h)


def paint_cloth(seed, w, h):
    """Redbrand wool, faded and mud-stained towards the bottom, with the band's brand burnt dark into the middle: a
    ring with a bar through it. The cell is a whole banner (v = 1 at its top)."""
    x, y = np.meshgrid((np.arange(w) + 0.5) / w - 0.5, ((np.arange(h) + 0.5) / h - 0.5) * h / w)
    weave = 0.5 + 0.25 * (np.sin(np.arange(w) * 2.1)[None, :] + np.sin(np.arange(h) * 2.1)[:, None])
    fade = field(seed, 4, 4, w, h)
    stain = smoothstep(0.55, 1.0, (np.arange(h)[:, None] / h) * np.ones((1, w)) + (field(seed + 1, 6, 3, w, h) - 0.5) * 0.4)
    red = np.asarray(PALETTE["redbrand"])
    colour = red[None, None] * (0.75 + 0.45 * fade + 0.12 * (weave - 0.5))[..., None]
    colour = colour * (1 - 0.55 * stain[..., None]) + np.array((0.22, 0.17, 0.12))[None, None] * 0.55 * stain[..., None]
    r = np.hypot(x, y + 0.15)
    brand = np.maximum(1 - smoothstep(0.025, 0.04, np.abs(r - 0.26)), (np.abs(x) < 0.035) * (np.abs(y + 0.15) < 0.34))
    brand = brand * (0.75 + 0.25 * field(seed + 2, 10, 2, w, h))
    colour = colour * (1 - 0.8 * brand[..., None]) + np.array((0.08, 0.03, 0.02))[None, None] * 0.8 * brand[..., None]
    return colour, weave * 0.4 + fade * 0.2, 0.95 + 0.0 * x, zeros(w, h), 2.0, zeros(w, h)


def paint_oilcloth(seed, w, h):
    """Waxed canvas: dark olive-brown, creased, a little glossy where the wax is thick."""
    creases = 1 - smoothstep(0.0, 0.03, np.abs(field(seed, 5, 3, w, h, (1, 0.6)) - 0.5))
    broad = field(seed + 1, 3, 4, w, h)
    colour = mix((0.15, 0.13, 0.09), (0.22, 0.19, 0.13), broad)
    colour = colour + np.array((0.06, 0.055, 0.04))[None, None] * creases[..., None]
    return colour, broad * 0.3 + creases * 0.6, 0.5 - 0.15 * creases + 0.1 * broad, zeros(w, h), 4.0, zeros(w, h)


def paint_iron(seed, w, h):
    """Black forged iron with hammer marks and rust where water stands."""
    broad = field(seed, 6, 4, w, h)
    rust = smoothstep(0.58, 0.72, field(seed + 1, 5, 4, w, h))
    colour = mix((0.07, 0.065, 0.06), (0.17, 0.16, 0.15), broad)
    colour = colour * (1 - rust[..., None]) + mix((0.28, 0.13, 0.06), (0.45, 0.24, 0.1), broad) * rust[..., None]
    return colour, broad * 0.6 + rust * 0.3, 0.55 + 0.35 * rust, np.clip(0.8 - rust, 0, 1), 4.0, zeros(w, h)


def paint_stone(seed, w, h):
    """Grey fieldstone in mmorpg's rock palette, sooted along the top of the cell."""
    base = np.array([(PALETTE["rock"] >> s) & 255 for s in (16, 8, 0)]) / 255.0
    broad = field(seed, 3, 5, w, h)
    grain = field(seed + 1, 24, 3, w, h)
    soot = smoothstep(0.55, 0.9, (1 - np.arange(h)[:, None] / h) * np.ones((1, w)) + (field(seed + 2, 6, 3, w, h) - 0.5) * 0.5)
    colour = base[None, None] * (0.7 + 0.5 * broad + 0.14 * (grain - 0.5))[..., None]
    colour = colour * (1 - 0.7 * soot[..., None])
    return colour, broad * 0.8 + grain * 0.35, 0.9 - 0.08 * grain, zeros(w, h), 6.0, zeros(w, h)


def paint_char(seed, w, h):
    """Charcoal and grey ash: black, checked into blocks by cracks, ash pale in them."""
    cracks = 1 - smoothstep(0.0, 0.03, np.abs(field(seed, 8, 3, w, h, (1, 0.4)) - 0.5))
    ash = smoothstep(0.55, 0.75, field(seed + 1, 5, 4, w, h))
    colour = mix((0.035, 0.03, 0.028), (0.09, 0.08, 0.075), field(seed + 2, 20, 2, w, h))
    colour = colour * (1 - ash[..., None]) + np.array((0.42, 0.4, 0.37))[None, None] * ash[..., None]
    colour = colour * (1 - 0.6 * cracks[..., None])
    return colour, ash * 0.3 - cracks * 0.7, 0.95 + 0.0 * ash, zeros(w, h), 6.0, zeros(w, h)


def paint_wet(seed, w, h):
    """Waterlogged planks: dark, green-brown and slimed, with algae streaks along the grain."""
    colour, height, rough, metal, strength, glow = paint_wood(seed, w, h, base=(0.2, 0.19, 0.13))
    algae = smoothstep(0.45, 0.7, field(seed + 5, 6, 3, w, h, (0.5, 1)))
    colour = colour * (1 - 0.6 * algae[..., None]) + np.array((0.12, 0.17, 0.08))[None, None] * 0.6 * algae[..., None]
    return colour, height, rough - 0.35 * algae, metal, strength, glow


def paint_flame(seed, w, h):
    """Fire, from a white-yellow root (v = 0) to deep orange-red tongues (v = 1); its own light."""
    t = (np.arange(h)[:, None] / h) * np.ones((1, w))  # 0 at the top row (v = 1)
    streak = field(seed, 6, 3, w, h, (1, 0.25))
    t = np.clip(t + (streak - 0.5) * 0.3, 0, 1)
    colour = mix((0.9, 0.22, 0.04), (1.0, 0.62, 0.16), smoothstep(0.0, 0.6, t))
    colour = colour * (1 - smoothstep(0.7, 1.0, t)[..., None]) + np.array((1.0, 0.9, 0.6))[None, None] * smoothstep(0.7, 1.0, t)[..., None]
    return colour, streak * 0.2, 1.0 + 0.0 * t, zeros(w, h), 1.0, colour


def paint_embers(seed, w, h):
    """Glowing coals: charcoal with orange heat in its cracks."""
    colour, height, rough, metal, strength, _ = paint_char(seed, w, h)
    heat = 1 - smoothstep(0.0, 0.06, np.abs(field(seed + 7, 7, 3, w, h) - 0.5))
    heat = np.clip(heat + smoothstep(0.6, 0.8, field(seed + 8, 4, 3, w, h)) * 0.6, 0, 1)
    glow = np.array((1.0, 0.36, 0.06))[None, None] * heat[..., None]
    return colour * (1 - heat[..., None]) + glow, height, rough, metal, strength, glow


PAINTERS = {"wood": lambda w, h: paint_planks(9100, w, h), "pole": lambda w, h: paint_wood(9200, w, h, (0.5, 0.42, 0.32), along_u=False),
            "rope": lambda w, h: paint_rope(9300, w, h), "hide": lambda w, h: paint_hide(9400, w, h),
            "oilcloth": lambda w, h: paint_oilcloth(9500, w, h), "cloth": lambda w, h: paint_cloth(9600, w, h),
            "iron": lambda w, h: paint_iron(9700, w, h), "stone": lambda w, h: paint_stone(9800, w, h),
            "char": lambda w, h: paint_char(9900, w, h), "wet": lambda w, h: paint_wet(10000, w, h),
            "flame": lambda w, h: paint_flame(10100, w, h), "embers": lambda w, h: paint_embers(10200, w, h)}


def paint_atlas():
    edge = ATLAS_EDGE
    colour, normal, orm, emission = np.zeros((edge, edge, 3)), np.zeros((edge, edge, 3)), np.ones((edge, edge, 3)), np.zeros((edge, edge, 3))
    normal[..., 2] = 1
    normal = normal * 0.5 + 0.5
    orm[..., 2] = 0
    for name, (x, y, w, h) in CELLS.items():
        cell_colour, height, rough, metal, strength, glow = PAINTERS[name](w, h)
        cell_normal = C["normal_map"](height, strength * 0.3)
        cell_orm = np.stack([np.ones((h, w)), np.clip(rough, 0, 1), np.clip(metal, 0, 1)], -1)
        cell_glow = glow if glow.ndim == 3 else np.zeros((h, w, 3))
        for target, pixels in ((colour, cell_colour), (normal, cell_normal), (orm, cell_orm), (emission, cell_glow)):
            pad = np.pad(pixels, ((GUTTER, GUTTER), (GUTTER, GUTTER), (0, 0)), mode="edge")
            y0, y1, x0, x1 = max(y - GUTTER, 0), min(y + h + GUTTER, edge), max(x - GUTTER, 0), min(x + w + GUTTER, edge)
            target[y0:y1, x0:x1] = pad[y0 - (y - GUTTER):y1 - (y - GUTTER), x0 - (x - GUTTER):x1 - (x - GUTTER)]
    return np.clip(colour, 0, 1), normal, orm, np.clip(emission, 0, 1)


def atlas_material():
    """The kit's single opaque material, its fire lit by an emissive map; the atlas is painted once per Blender session."""
    existing = bpy.data.materials.get(MATERIAL)
    if existing is not None:
        return existing
    colour, normal, orm, emission = paint_atlas()
    mat = bpy.data.materials.new(MATERIAL)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    def texture(name, pixels, is_colour):
        node = tree.nodes.new("ShaderNodeTexImage")
        node.image = C["make_image"](name, pixels, is_colour)
        return node
    tree.links.new(texture("discoveries-colour", colour, True).outputs["Color"], bsdf.inputs["Base Color"])
    normal_node = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(texture("discoveries-normal", normal, False).outputs["Color"], normal_node.inputs["Color"])
    tree.links.new(normal_node.outputs["Normal"], bsdf.inputs["Normal"])
    separate = tree.nodes.new("ShaderNodeSeparateColor")
    tree.links.new(texture("discoveries-orm", orm, False).outputs["Color"], separate.inputs["Color"])
    tree.links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    tree.links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    tree.links.new(texture("discoveries-emission", emission, True).outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    return mat


def cell_uv(cell, u, v):
    """A cell-local (u, v) in [0, 1], with v = 1 at the cell's top edge, as an atlas coordinate."""
    x, y, w, h = CELLS[cell]
    u, v = min(max(u, 0.0), 1.0), min(max(v, 0.0), 1.0)
    return ((x + u * w) / ATLAS_EDGE, 1 - (y + (1 - v) * h) / ATLAS_EDGE)


def fit(cell, uv):
    """Cell coordinates for one face from its surface coordinates in cell repeats: moved by whole repeats into the cell
    (the cells tile), and squeezed along an axis only when the face is longer than one repeat."""
    out = []
    shifts = []
    for k in (0, 1):
        lo, hi = min(c[k] for c in uv), max(c[k] for c in uv)
        if hi - lo > 1:
            shifts.append((lo, 1 / (hi - lo)))
        else:
            start = math.floor(lo)
            shifts.append((start if hi - start <= 1 else lo, 1.0))
    for c in uv:
        out.append(cell_uv(cell, (c[0] - shifts[0][0]) * shifts[0][1], (c[1] - shifts[1][0]) * shifts[1][1]))
    return out


# ---------------------------------------------------------------- mesh

class Part:
    """One piece's mesh at one level, gathered in glTF axes as polygons with their atlas coordinates."""

    def __init__(self, piece, level):
        self.piece, self.level = piece, level
        self.points, self.faces, self.uvs, self.smooth = [], [], [], []

    def add(self, points, faces, uvs, smooth=False):
        """Append the ``points`` that ``faces`` use (indices into ``points``), each face with its own per-corner ``uvs``."""
        used = {}
        for face in faces:
            for i in face:
                if i not in used:
                    used[i] = len(self.points)
                    self.points.append(tuple(points[i]))
        for k, (face, face_uvs) in enumerate(zip(faces, uvs)):
            self.faces.append([used[i] for i in face])
            self.uvs.extend(face_uvs)
            self.smooth.append(smooth(k) if callable(smooth) else smooth)

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


def place(origin=(0, 0, 0), yaw=0.0, pitch=0.0, roll=0.0):
    """A glTF-axes transform: roll about Z, then pitch about X, then yaw about Y, then the move to ``origin``."""
    return (Matrix.Translation(Vector(origin)) @ Matrix.Rotation(yaw, 4, "Y") @ Matrix.Rotation(pitch, 4, "X")
            @ Matrix.Rotation(roll, 4, "Z"))


BOX_QUADS = ((4, 6, 7, 5), (0, 1, 3, 2), (2, 3, 7, 6), (0, 4, 5, 1), (1, 5, 7, 3), (0, 2, 6, 4))
BOX_AXES = (0, 0, 1, 1, 2, 2)


def box(p, size, cell, at=None, key="box", grain=None, skip=()):
    """A box of ``size`` (x, y, z) centred on the origin of ``at``; its faces map the cell along the box's longest
    axis (or ``grain``) in metres of ``TILE``. ``skip`` lists face indices (+X, -X, +Y, -Y, +Z, -Z) to leave out."""
    at = at or Matrix()
    half = [s / 2 for s in size]
    local = [Vector((sx * half[0], sy * half[1], sz * half[2])) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    grain = max(range(3), key=lambda k: size[k]) if grain is None else grain
    tile = TILE[cell]
    faces, uvs = [], []
    for index, (quad, axis) in enumerate(zip(BOX_QUADS, BOX_AXES)):
        if index in skip:
            continue
        a, b = [k for k in range(3) if k != axis]
        if b == grain:
            a, b = b, a
        off = (between(0, 1, key, index, "u"), between(0, 1, key, index, "v"))
        faces.append(list(quad))
        uvs.append(fit(cell, [(local[i][a] / tile[0] + off[0], local[i][b] / tile[1] + off[1]) for i in quad]))
    p.add([at @ v for v in local], faces, uvs)


def rod(p, a, b, radius, cell, sides, key, end_radius=None, caps=(True, True), smooth=True):
    """A round pole from ``a`` to ``b``, its grain along its length; ``caps`` closes the ``a`` and ``b`` ends."""
    a, b = Vector(a), Vector(b)
    end_radius = radius if end_radius is None else end_radius
    d = (b - a).normalized()
    length = (b - a).length
    ref = Vector((0, 1, 0)) if abs(d.y) < 0.9 else Vector((1, 0, 0))
    s1 = d.cross(ref).normalized()
    s2 = d.cross(s1)
    twist = between(0, 2 * math.pi, key, "twist")
    def ring(centre, r):
        return [centre + (s1 * math.cos(twist + 2 * math.pi * k / sides) + s2 * math.sin(twist + 2 * math.pi * k / sides)) * r for k in range(sides)]
    points = ring(a, radius) + ring(b, end_radius)
    tile = TILE[cell]
    us = min(2 * math.pi * max(radius, end_radius) / tile[0], 1.0)
    vs = length / tile[1]
    u0, v0 = between(0, 1 - us, key, "u"), between(0, 1, key, "v")
    faces, uvs = [], []
    for k in range(sides):
        n = k + 1
        faces.append([k, n % sides, sides + n % sides, sides + k])
        uvs.append(fit(cell, [(u0 + us * k / sides, v0), (u0 + us * n / sides, v0), (u0 + us * n / sides, v0 + vs), (u0 + us * k / sides, v0 + vs)]))
    p.add(points, faces, uvs, smooth=smooth)
    for end, (closed, start, r) in enumerate(zip(caps, (0, sides), (radius, end_radius))):
        if not closed:
            continue
        ring_ids = list(range(start, start + sides))
        cap = list(reversed(ring_ids)) if end == 0 else ring_ids
        scale = min(r * 2 / tile[0], 1.0)
        uv = [cell_uv(cell, 0.5 + 0.5 * scale * math.cos(twist + 2 * math.pi * (i - start) / sides),
                      0.5 + 0.5 * scale * math.sin(twist + 2 * math.pi * (i - start) / sides)) for i in cap]
        p.add(points, [cap], [uv])


def path(p, points, radius, cell, sides, key, caps=True):
    """A bent pole through ``points``, one rod per span."""
    for k in range(len(points) - 1):
        rod(p, points[k], points[k + 1], radius, cell, sides, f"{key}-{k}", caps=(caps and k == 0, caps and k == len(points) - 2))


def icosphere(subdivisions):
    """Unit icosphere vertices and triangles, in a fixed order (subdivision 1 is the 20-face icosahedron)."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=1.0)
    bm.verts.ensure_lookup_table()
    points = [Vector(v.co) for v in bm.verts]
    faces = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    return points, faces


def lump(p, centre, radii, subdivisions, cell, key, rough=0.2, scale=2.0, at=None, floor=None, smooth=False):
    """A noise-displaced ellipsoid (a stone, a coal, a bundle, a flame tongue); ``floor`` flattens it at that height."""
    at = at or Matrix()
    points, faces = icosphere(subdivisions)
    seed = Vector((between(0, 50, key, "x"), between(0, 50, key, "y"), between(0, 50, key, "z")))
    out = []
    for v in points:
        n = noise.fractal(v * scale + seed, 0.5, 2.0, 3) * rough
        q = at @ (Vector(centre) + Vector((v.x * radii[0], v.y * radii[1], v.z * radii[2])) * (1 + n))
        if floor is not None:
            q.y = max(q.y, floor)
        out.append(q)
    tile = TILE[cell]
    uvs = []
    if cell == "flame":
        # Fire runs its cell's gradient from the tongue's root (v = 0) to its tip (v = 1), u round it.
        lo, hi = min(q.y for q in out), max(q.y for q in out)
        middle = sum(out, Vector()) / len(out)
        def flame_uv(q):
            return cell_uv(cell, 0.5 + 0.45 * math.atan2(q.z - middle.z, q.x - middle.x) / math.pi, (q.y - lo) / max(hi - lo, 1e-6))
        p.add(out, faces, [[flame_uv(out[i]) for i in f] for f in faces], smooth=smooth)
        return
    for f in faces:
        corners = [out[i] for i in f]
        normal = (corners[1] - corners[0]).cross(corners[2] - corners[0])
        axis = max(range(3), key=lambda k: abs(normal[k]))
        a, b = [k for k in range(3) if k != axis]
        uvs.append(fit(cell, [(c[a] / tile[0] + between(0, 1, key, "u"), c[b] / tile[1] + between(0, 1, key, "v")) for c in corners]))
    p.add(out, faces, uvs, smooth=smooth)


def sheet(p, shape, nu, nv, cell, key, rect=(0, 0, 1, 1), keep=None, two_sided=True):
    """A cloth or hide surface: ``shape(u, v)`` gives the point at grid coordinates in [0, 1], ``rect`` the cell area
    (u0, v0, u1, v1) the grid covers, and ``keep(i, j)`` drops tattered or cut-away quads. Single-sided materials need
    both sides, so ``two_sided`` adds the reversed copy."""
    points = [shape(i / nu, j / nv) for j in range(nv + 1) for i in range(nu + 1)]
    index = lambda i, j: j * (nu + 1) + i
    uv_of = lambda i, j: cell_uv(cell, rect[0] + (rect[2] - rect[0]) * i / nu, rect[1] + (rect[3] - rect[1]) * j / nv)
    faces, uvs = [], []
    for j in range(nv):
        for i in range(nu):
            if keep is not None and not keep(i, j):
                continue
            corners = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
            faces.append([index(*c) for c in corners])
            uvs.append([uv_of(*c) for c in corners])
    p.add(points, faces, uvs, smooth=True)
    if two_sided:
        p.add(points, [list(reversed(f)) for f in faces], [list(reversed(u)) for u in uvs], smooth=True)


def binding(p, centre, axis, radius, key, width=0.05):
    """A few turns of rope round a joint: a short fat rope rod along ``axis`` (dropped below full detail)."""
    if p.level > 0:
        return
    c, d = Vector(centre), Vector(axis).normalized()
    rod(p, c - d * width / 2, c + d * width / 2, radius, "rope", 6, key)


def proxy(name, lo, hi, tag="solid"):
    return C["proxy"](name, tag, lo, hi)


def proxies_of(boxes):
    return {"collisionProxies": [proxy(*b) for b in boxes]}


# ---------------------------------------------------------------- Wolfrun hunter's cache

def hunter_lean_to(p):
    """Two forked uprights and a ridge pole, rafters raked back to the ground, three stitched hides over them."""
    L, n = p.level, SIDES[p.level]
    front, back, half, ridge = 0.55, -1.05, 1.15, 1.65
    for side in (-1, 1):
        x = side * half
        rod(p, (x, -BURY, front), (x + side * 0.02, ridge + 0.12, front), 0.055, "pole", n, f"upright{side}")
        if L == 0:
            rod(p, (x, ridge - 0.04, front), (x + side * 0.13, ridge + 0.22, front + 0.02), 0.03, "pole", 5, f"fork{side}")
    rod(p, (-half - 0.28, ridge, front), (half + 0.32, ridge + 0.03, front), 0.05, "pole", n, "ridge")
    rafters = (5, 3, 2)[L]
    for k in range(rafters):
        x = -1.0 + 2.0 * k / (rafters - 1)
        rod(p, (x, ridge + 0.05, front + 0.12), (x * 1.04, -0.06, back - 0.08), 0.035, "pole", max(n - 1, 3), f"rafter{k}",
            caps=(L == 0, False))
        binding(p, (x, ridge, front), (1, 0, 0), 0.068, f"lash{k}")
    def roof(u, v):
        x = -1.15 + 2.3 * u
        fold = (u * 3) % 1
        y = ridge + 0.1 - v * (ridge + 0.1) - 0.06 * math.sin(math.pi * v) - 0.03 * math.sin(math.pi * fold) * math.sin(math.pi * v)
        z = front + 0.22 + v * (back - front - 0.22)
        return Vector((x, y + noise.noise(Vector((x * 3, v * 4, 0.7))) * 0.015, z))
    nu, nv = ((12, 6), (6, 3), (3, 2))[L]
    keep = lambda i, j: not ((i == 0 or i == nu - 1) and j == 0 and between(0, 1, "roof-edge", i) < 0.6) if L == 0 else True
    sheet(p, roof, nu, nv, "hide", "roof", keep=keep)
    return proxies_of([("shelter", (-1.2, 0, back - 0.1), (1.2, 0.7, -0.45)),
                       ("upright-left", (-half - 0.08, 0, front - 0.08), (-half + 0.08, ridge + 0.15, front + 0.08)),
                       ("upright-right", (half - 0.08, 0, front - 0.08), (half + 0.08, ridge + 0.15, front + 0.08))])


CHEST = {"width": 0.84, "depth": 0.52, "height": 0.46, "lid": 0.1, "wall": 0.04, "open": math.radians(-108)}


def chest_body(p, key):
    """The plank chest's open-topped body: a floor and four walls, so its inside shows when the lid is up."""
    w, d, wall = CHEST["width"], CHEST["depth"], CHEST["wall"]
    h = CHEST["height"] - CHEST["lid"]
    if p.level == 2:
        box(p, (w, h, d), "wood", place((0, h / 2, 0)), f"{key}-solid", grain=0)
        return
    box(p, (w, wall, d), "wood", place((0, wall / 2, 0)), f"{key}-floor")
    for side in (-1, 1):
        box(p, (w, h, wall), "wood", place((0, h / 2, side * (d - wall) / 2)), f"{key}-wall-z{side}", grain=0)
        box(p, (wall, h, d - 2 * wall), "wood", place((side * (w - wall) / 2, h / 2, 0)), f"{key}-wall-x{side}", grain=2)


def chest_lid(p, at, key):
    w, d, lid = CHEST["width"], CHEST["depth"], CHEST["lid"]
    box(p, (w + 0.02, lid, d + 0.02), "wood", at @ place((0, lid / 2, d / 2)), f"{key}-lid", grain=0)
    if p.level == 0:
        for x in (-0.28, 0.28):
            box(p, (0.05, lid + 0.012, d + 0.035), "iron", at @ place((x, lid / 2, d / 2)), f"{key}-strap{x}", grain=2)


def chest_straps(p, key):
    if p.level > 0:
        return
    w, d, h = CHEST["width"], CHEST["depth"], CHEST["height"] - CHEST["lid"]
    for x in (-0.28, 0.28):
        box(p, (0.05, h, d + 0.012), "iron", place((x, h / 2, 0)), f"{key}-band{x}", grain=1, skip=(3,))


def hunter_chest(p, opened=False):
    """A plank chest bound with iron, lashed shut with rope; open, the rope is cut and lies slack, the lid stands back on
    its hinge and a rolled pelt and a pouch show inside."""
    w, d, h, lid = CHEST["width"], CHEST["depth"], CHEST["height"], CHEST["lid"]
    body_h = h - lid
    chest_body(p, "chest")
    chest_straps(p, "chest")
    hinge = Vector((0, body_h, -d / 2))
    if opened:
        chest_lid(p, Matrix.Translation(hinge) @ Matrix.Rotation(CHEST["open"], 4, "X"), "chest")
        if p.level < 2:
            rod(p, (-0.22, body_h - 0.12, -0.05), (0.26, body_h - 0.1, 0.02), 0.075, "hide", SIDES[p.level], "pelt")
        if p.level == 0:
            lump(p, (-0.2, body_h - 0.16, 0.12), (0.09, 0.07, 0.08), 2, "hide", "pouch", rough=0.25)
            for k, x in enumerate((-0.18, 0.2)):
                path(p, [(x, 0.012, d / 2 + 0.08), (x + 0.12, 0.012, d / 2 + 0.3), (x + 0.05, 0.012, d / 2 + 0.5)], 0.012, "rope", 4, f"cut{k}")
    else:
        chest_lid(p, Matrix.Translation(hinge), "chest")
        if p.level == 0:
            for k, z in enumerate((-0.12, 0.12)):
                y0, y1, x0 = 0.01, h + 0.012, w / 2 + 0.012
                rod(p, (-x0, y1, z), (x0, y1, z), 0.012, "rope", 4, f"lash{k}-top", caps=(False, False))
                for side in (-1, 1):
                    rod(p, (side * x0, y0, z), (side * x0, y1, z), 0.012, "rope", 4, f"lash{k}-{side}", caps=(False, False))
            lump(p, (0.0, h + 0.02, 0.12), (0.03, 0.02, 0.025), 1, "rope", "knot", rough=0.3)
    return proxies_of([("chest", (-w / 2 - 0.02, 0, -d / 2 - 0.02), (w / 2 + 0.02, h + 0.02, d / 2 + 0.02))])


def skinning_rack(p):
    """A pole frame propped from behind, a hide stretched in it on rope laces."""
    L, n = p.level, SIDES[p.level]
    half, top, bottom = 0.78, 1.72, 0.32
    for side in (-1, 1):
        x = side * half
        rod(p, (x, -BURY, 0), (x, top + 0.14, 0), 0.045, "pole", n, f"upright{side}")
        rod(p, (x, top - 0.1, -0.02), (x * 1.05, -BURY * 0.5, -0.72), 0.035, "pole", max(n - 1, 3), f"prop{side}", caps=(L == 0, False))
        binding(p, (x, top, 0), (0, 1, 0), 0.06, f"lash-top{side}")
    for name, y in (("top", top), ("bottom", bottom)):
        rod(p, (-half - 0.16, y, 0.03), (half + 0.14, y + 0.02, 0.03), 0.035, "pole", n, f"bar-{name}")
    hx, y0, y1 = 0.56, bottom + 0.12, top - 0.12
    def pelt(u, v):
        # A deer pelt: a body narrowing to the neck at the top, the legs stretched out to the corners.
        x = (u - 0.5) * 2 * hx * (0.82 + 0.18 * math.cos(math.pi * (2 * v - 1)))
        y = y0 + (y1 - y0) * v
        return Vector((x, y, 0.035 + 0.035 * math.sin(math.pi * u) * math.sin(math.pi * v)))
    nu, nv = ((8, 10), (4, 5), (2, 3))[L]
    def keep(i, j):
        cu, cv = (i + 0.5) / nu - 0.5, (j + 0.5) / nv - 0.5
        corner = abs(cu) > 0.3 and abs(cv) > 0.3
        leg = abs(abs(cu) - abs(cv)) < 0.12
        return L > 0 or not corner or leg
    sheet(p, pelt, nu, nv, "hide", "pelt", keep=keep)
    if L == 0:
        laces = [(-hx, y0 + 0.3), (-hx, y1 - 0.3), (hx, y0 + 0.3), (hx, y1 - 0.3)]
        for k, (x, y) in enumerate(laces):
            rod(p, (x * 0.92, y, 0.035), (x / abs(x) * half, y + 0.05, 0.0), 0.007, "rope", 3, f"lace-side{k}")
        for k, x in enumerate((-0.35, 0.0, 0.35)):
            rod(p, (x, y1 - 0.02, 0.035), (x * 1.1, top, 0.03), 0.007, "rope", 3, f"lace-top{k}")
            rod(p, (x, y0 + 0.02, 0.035), (x * 1.1, bottom, 0.03), 0.007, "rope", 3, f"lace-bottom{k}")
    return proxies_of([("rack", (-half - 0.1, 0, -0.76), (half + 0.1, top + 0.15, 0.1))])


def fire_ring(p):
    """A cold fire: a ring of sooted fieldstones round the charred ends of three logs and a bed of ash."""
    L = p.level
    count, sub = ((9, 2), (9, 1), (5, 1))[L]
    for k in range(count):
        a = 2 * math.pi * (k + between(-0.2, 0.2, "stone-a", k)) / count
        r = between(0.1, 0.14, "stone-r", k)
        centre = (math.cos(a) * 0.44, r * 0.45, math.sin(a) * 0.44)
        lump(p, centre, (r, r * 0.75, r * 0.85), sub, "stone", f"stone{k}", rough=0.3, at=place(yaw=-a), floor=-0.02)
    if L < 2:
        lump(p, (0, 0.0, 0), (0.34, 0.035, 0.34), (2, 1, 1)[L], "char", "ash", rough=0.15, floor=-0.01)
    for k in range((3, 3, 2)[L]):
        a = 2 * math.pi * k / 3 + 0.4
        rod(p, (math.cos(a) * 0.36, 0.05, math.sin(a) * 0.36), (math.cos(a) * 0.04, 0.09, math.sin(a) * 0.04),
            0.045, "char", (6, 4, 3)[L], f"log{k}", end_radius=0.03)
    return {"collision": "none"}


def hunter_clue(p):
    """What went wrong: a hunting bow snapped in two, its string loose, and a quiver torn open with its arrows spilled."""
    L = p.level
    segs = (4, 2, 1)[L]
    def limb(t0, t1, key, at):
        pts = []
        for k in range(segs + 1):
            t = t0 + (t1 - t0) * k / segs
            pts.append(at @ Vector((t * 0.78, 0.02, 0.12 * (1 - (2 * t) ** 2))))
        path(p, pts, 0.022, "pole", (5, 4, 3)[L], key)
    limb(-0.5, 0.04, "limb-a", place((0.1, 0, 0.1), yaw=0.2))
    limb(0.0, 0.5, "limb-b", place((0.25, 0, -0.18), yaw=-0.5))
    if L < 2:
        path(p, [(-0.28, 0.008, 0.25), (-0.05, 0.008, 0.38), (0.2, 0.008, 0.3)], 0.003, "rope", 3, "string", caps=False)
    # The torn quiver: a leather tube on its side, its mouth ripped back, with arrows fanned out of it.
    q = place((-0.35, 0.065, -0.3), yaw=0.9, roll=math.pi / 2)
    rod(p, q @ Vector((0, -0.25, 0)), q @ Vector((0, 0.22, 0)), 0.06, "hide", SIDES[L], "quiver", end_radius=0.065, caps=(True, False))
    if L == 0:
        sheet(p, lambda u, v: q @ Vector((0.06 * math.cos(u * 2.2), 0.22 + v * 0.14, 0.06 * math.sin(u * 2.2) + v * 0.05)), 3, 2, "hide", "flap")
    for k in range((5, 3, 0)[L]):
        a = between(-0.6, 0.6, "arrow", k)
        start = q @ Vector((between(-0.03, 0.03, "arrow-x", k), 0.1, 0))
        d = Vector((math.sin(0.9 + a + 1.57), 0, math.cos(0.9 + a + 1.57)))
        length = 0.7 if k != 2 else 0.38  # one is snapped
        end = start + d * length
        end.y = 0.012
        rod(p, start, end, 0.006, "pole", 3, f"shaft{k}", caps=(False, False), smooth=False)
        if L == 0:
            if k != 2:
                lump(p, end + d * 0.03, (0.012, 0.006, 0.012), 1, "iron", f"head{k}", rough=0.0)
            box(p, (0.05, 0.002, 0.11), "rope", place(start - d * 0.02 + Vector((0, 0.01, 0)), yaw=math.atan2(d.x, d.z)), f"fletch{k}", skip=(0, 1, 4, 5))
    return {"collision": "none"}


# ---------------------------------------------------------------- Greyfang lookout

def lookout_platform(p):
    """A Redbrand watch post: four poles bury into the rock shelf, a plank deck at ``DECK_TOP`` with rails on three sides
    (the ladder side, +Z, is open), X-braced, a strip of red cloth tied to a rail post."""
    L, n = p.level, SIDES[p.level]
    corner, rail = 1.1, DECK_TOP + 0.95
    for sx in (-1, 1):
        for sz in (-1, 1):
            rod(p, (sx * corner, -BURY, sz * corner), (sx * corner, rail + 0.12, sz * corner), 0.075, "pole", n, f"post{sx}{sz}")
    for sz in (-1, 1) if L < 2 else ():
        box(p, (2.55, 0.14, 0.12), "wood", place((0, DECK_TOP - 0.12, sz * corner)), f"bearer{sz}")
    if L == 0:
        x = -1.24
        k = 0
        while x < 1.22:
            width = between(0.18, 0.26, "plank-w", k)
            x1 = min(x + width, 1.24)
            length = 2.5 + between(-0.1, 0.12, "plank-l", k)
            box(p, (x1 - x - 0.012, 0.05, length), "wood", place(((x + x1) / 2, DECK_TOP - 0.025, between(-0.05, 0.05, "plank-z", k)), yaw=between(-0.01, 0.01, "plank-yaw", k)), f"plank{k}", grain=2)
            x, k = x1, k + 1
    else:
        box(p, (2.5, 0.05, 2.5), "wood", place((0, DECK_TOP - 0.025, 0)), "deck", grain=2)
    for name, a, b in (("back", (-corner, rail, -corner), (corner, rail, -corner)),
                       ("left", (-corner, rail, -corner), (-corner, rail, corner)),
                       ("right", (corner, rail, -corner), (corner, rail, corner))):
        rod(p, Vector(a) + (Vector(a) - Vector(b)).normalized() * 0.12, Vector(b) + (Vector(b) - Vector(a)).normalized() * 0.12, 0.04, "pole", max(n - 1, 3), f"rail-{name}")
        if L == 0:
            mid = Vector((0, -0.45, 0))
            rod(p, Vector(a) + mid, Vector(b) + mid, 0.03, "pole", 4, f"midrail-{name}")
            binding(p, Vector(a), Vector(b) - Vector(a), 0.09, f"lash-{name}-a")
            binding(p, Vector(b), Vector(b) - Vector(a), 0.09, f"lash-{name}-b")
    if L < 2:
        for sx in (-1, 1):
            rod(p, (sx * corner, 0.25, -corner), (sx * corner, DECK_TOP - 0.25, corner), 0.035, "pole", max(n - 2, 3), f"brace{sx}a")
            if L == 0:
                rod(p, (sx * corner, 0.25, corner), (sx * corner, DECK_TOP - 0.25, -corner), 0.035, "pole", 4, f"brace{sx}b")
    if L == 0:
        tie = Vector((corner, rail - 0.1, corner + 0.08))
        sheet(p, lambda u, v: tie + Vector((0.06 * u + v * 0.18, -v * 0.42, 0.04 * math.sin(v * 5))), 1, 4, "cloth", "strip", rect=(0.02, 0.05, 0.14, 0.4))
    top = DECK_TOP
    return proxies_of([("deck", (-1.26, top - 0.2, -1.26), (1.26, top, 1.26), "walkable")]
                      + [(f"post-{sx}{sz}", (sx * corner - 0.08, 0, sz * corner - 0.08), (sx * corner + 0.08, rail + 0.12, sz * corner + 0.08))
                         for sx in (-1, 1) for sz in (-1, 1)]
                      + [("rail-back", (-corner, top, -corner - 0.05), (corner, rail + 0.05, -corner + 0.05)),
                         ("rail-left", (-corner - 0.05, top, -corner), (-corner + 0.05, rail + 0.05, corner)),
                         ("rail-right", (corner - 0.05, top, -corner), (corner + 0.05, rail + 0.05, corner))])


LADDER = {"length": 2.75, "half": 0.23, "rungs": 0.3, "lean": 0.7}


def lookout_ladder(p):
    """Two poles with rungs lashed across them, leaning: the foot on the ground at +Z, the top at -Z resting against the
    deck edge of the lookout platform."""
    L, n = p.level, SIDES[p.level]
    rise = math.sqrt(LADDER["length"] ** 2 - LADDER["lean"] ** 2)
    foot, head = LADDER["lean"] / 2, -LADDER["lean"] / 2
    for side in (-1, 1):
        x = side * LADDER["half"]
        rod(p, (x, -0.05, foot), (x * 0.94, rise, head), 0.04, "pole", max(n - 1, 3), f"rail{side}")
    count = int(rise / LADDER["rungs"])
    for k in range(1, count + 1, (1, 1, 3)[L]):
        t = k * LADDER["rungs"] / rise
        y, z = rise * t, foot + (head - foot) * t
        w = LADDER["half"] * (1 - 0.06 * t) + 0.06
        rod(p, (-w, y, z + 0.035), (w, y, z + 0.035), 0.022, "pole", (5, 3, 3)[L], f"rung{k}", caps=(L == 0, L == 0))
        if L == 0:
            for side in (-1, 1):
                binding(p, (side * LADDER["half"] * (1 - 0.06 * t), y, z + 0.02), (0, 1, 0), 0.05, f"lash{k}{side}", width=0.06)
    return proxies_of([("ladder", (-LADDER["half"] - 0.06, 0, head - 0.06), (LADDER["half"] + 0.06, rise, foot + 0.06), "ladder")])


def signal_brazier(p, lit=False):
    """An iron basket on a stout pole: cold, it holds charred logs and ash; lit, the coals glow and flames rise from it."""
    L, n = p.level, SIDES[p.level]
    top = BRAZIER["top"]
    rod(p, (0, -BURY, 0), (0, top, 0), 0.075, "pole", n, "pole", caps=(False, True))
    rod(p, (0, top - 0.02, 0), (0, top + 0.04, 0), 0.19, "iron", n, "pan")
    bars = (8, 6, 0)[L]
    if bars:
        for k in range(bars):
            a = 2 * math.pi * k / bars
            rod(p, (math.cos(a) * 0.17, top, math.sin(a) * 0.17), (math.cos(a) * 0.32, top + 0.42, math.sin(a) * 0.32), 0.014, "iron", 3, f"bar{k}", smooth=False)
        hoop = [(math.cos(2 * math.pi * k / bars) * 0.32, top + 0.4, math.sin(2 * math.pi * k / bars) * 0.32) for k in range(bars + 1)]
        path(p, hoop, 0.016, "iron", 3, "hoop", caps=False)
    else:
        rod(p, (0, top, 0), (0, top + 0.42, 0), 0.17, "iron", 4, "basket", end_radius=0.32, caps=(False, False))
    if L == 0:
        for k, a in enumerate((0.3, 2.4, 4.5)):
            rod(p, (math.cos(a) * 0.07, top - 0.5, math.sin(a) * 0.07), (math.cos(a) * 0.19, top, math.sin(a) * 0.19), 0.015, "iron", 3, f"stay{k}")
    for k in range((4, 3, 2)[L]):
        a = 2 * math.pi * k / 4 + 0.3
        rod(p, (math.cos(a) * 0.22, top + 0.1, math.sin(a) * 0.22), (-math.cos(a) * 0.12, top + 0.22, -math.sin(a) * 0.12),
            0.05, "char" if not lit else "embers", (6, 4, 3)[L], f"log{k}", end_radius=0.035)
    lump(p, (0, top + 0.06, 0), (0.22, 0.06, 0.22), (2, 1, 1)[L], "embers" if lit else "char", "bed", rough=0.25)
    info = proxies_of([("pole", (-0.1, 0, -0.1), (0.1, top + 0.45, 0.1))])
    if lit:
        tongues = (7, 4, 2)[L]
        for k in range(tongues):
            a = 2 * math.pi * k / tongues + between(-0.3, 0.3, "tongue-a", k)
            r = 0.0 if k == 0 else between(0.08, 0.16, "tongue-r", k)
            height = between(0.32, 0.5, "tongue-h", k) * (1.3 if k == 0 else 1.0)
            lump(p, (math.cos(a) * r, top + 0.18 + height * 0.45, math.sin(a) * r), (0.09, height * 0.55, 0.09), (2, 1, 1)[L],
                 "flame", f"tongue{k}", rough=0.35, scale=3.0, at=place((0, top, 0), roll=between(-0.15, 0.15, "lean", k)) @ place((0, -top, 0)), smooth=True)
        info["light"] = {"position": list(BRAZIER["light"]), "colour": list(BRAZIER["colour"])}
    return info


def lookout_banner(p):
    """A tall pole with a crossbar and a tattered Redbrand banner hanging from it: the band's dark brand in its middle,
    its foot torn into rags and holed."""
    L, n = p.level, SIDES[p.level]
    height, bar = 3.4, 3.25
    rod(p, (0, -BURY, 0), (0, height, 0), 0.05, "pole", n, "pole", caps=(False, True))
    rod(p, (-0.06, bar, 0), (0.86, bar - 0.02, 0), 0.03, "pole", max(n - 1, 3), "bar")
    if L == 0:
        lump(p, (0, height + 0.06, 0), (0.03, 0.09, 0.03), 1, "iron", "spike", rough=0.0)
        binding(p, (0, bar, 0), (1, 0, 0), 0.07, "lash")
    nu, nv = ((8, 14), (4, 7), (2, 4))[L]
    def cloth(u, v):
        x = 0.06 + 0.72 * u
        drop = 1.4 * (1 - v)
        sway = 0.07 * math.sin(math.pi * (1 - v) * 1.4 + u * 2.4) * (1 - v) + 0.02 * math.sin(u * 9)
        # Fray the lower half: each grid point there drops or rises a little, so the rags tear on the slant.
        fray = between(-0.06, 0.06, "fray", round(u * nu), round(v * nv)) * max(0.0, 1 - v * 2) if L < 2 else 0.0
        return Vector((x + fray * 0.5, bar - 0.03 - drop + fray, sway))
    def keep(i, j):
        # v runs up the banner (j = 0 at its foot): rags at the foot, a V notch in the middle and a couple of holes.
        u = (i + 0.5) / nu
        foot = 0.08 + 0.22 * between(0, 1, "rag", i) + (0.2 if abs(u - 0.5) < 0.2 else 0.0)
        hole = L == 0 and (i, j) in ((1, 5), (6, 8), (5, 9))
        return (j + 0.5) / nv > foot and not hole if L < 2 else True
    sheet(p, cloth, nu, nv, "cloth", "banner", keep=keep)
    return proxies_of([("pole", (-0.08, 0, -0.08), (0.08, height, 0.08))])


def weapon_rack(p):
    """A trestle of crossed poles with a top and a bottom rail, spears and axes leaning on it and a red shield against
    its foot."""
    L, n = p.level, SIDES[p.level]
    half = 0.75
    for side in (-1, 1):
        x = side * half
        rod(p, (x, 0, -0.38), (x, 1.15, 0.24), 0.04, "pole", max(n - 1, 3), f"leg{side}a")
        rod(p, (x, 0, 0.38), (x, 1.15, -0.24), 0.04, "pole", max(n - 1, 3), f"leg{side}b")
        binding(p, (x, 0.85, 0), (1, 0, 0), 0.06, f"lash{side}")
    rod(p, (-half - 0.12, 0.85, 0), (half + 0.12, 0.85, 0), 0.04, "pole", n, "rail-top")
    if L < 2:
        rod(p, (-half, 0.3, -0.18), (half, 0.3, -0.18), 0.03, "pole", max(n - 2, 3), "rail-bottom")
    spears = (4, 3, 2)[L]
    for k in range(spears):
        x = -0.55 + 1.1 * k / max(spears - 1, 1) + between(-0.04, 0.04, "spear-x", k)
        foot, head = Vector((x, 0, 0.42)), Vector((x + between(-0.06, 0.06, "spear-lean", k), 1.95, -0.2))
        rod(p, foot, head, 0.018, "pole", (5, 3, 3)[L], f"spear{k}", smooth=L == 0)
        d = (head - foot).normalized()
        rod(p, head, head + d * 0.26, 0.026, "iron", (4, 3, 3)[L], f"spearhead{k}", end_radius=0.001, caps=(L == 0, False), smooth=False)
    if L < 2:
        for k, x in enumerate((-0.32, 0.38)):
            foot, top = Vector((x, 0, -0.4)), Vector((x + 0.05, 0.98, 0.08))
            rod(p, foot, top, 0.022, "pole", 4, f"axe{k}")
            d = (top - foot).normalized()
            box(p, (0.03, 0.14, 0.2), "iron", place(top - d * 0.06 + Vector((0, 0, -0.1)), pitch=-math.atan2(d.z, d.y)), f"axehead{k}", grain=2)
    if L == 0:
        shield = place((0.1, 0.42, 0.5), pitch=-1.35)
        rod(p, shield @ Vector((0, -0.025, 0)), shield @ Vector((0, 0.025, 0)), 0.4, "cloth", 12, "shield")
        lump(p, (0, 0.04, 0), (0.08, 0.05, 0.08), 1, "iron", "boss", rough=0.0, at=shield)
        rod(p, shield @ Vector((0, -0.01, 0)), shield @ Vector((0, 0.035, 0)), 0.415, "iron", 12, "rim", caps=(False, False))
    return proxies_of([("rack", (-half - 0.12, 0, -0.42), (half + 0.12, 1.2, 0.42))])


# ---------------------------------------------------------------- Eastwater Fen supply cache

PUNT = {"length": 4.0, "beam": 1.1, "side": 0.36, "pitch": math.radians(-6.5), "roll": math.radians(7), "sink": -0.2}


def fen_punt(p):
    """A flat-bottomed punt of broad planks with raked ends and two thwarts, swamped stern-first: its frame's y = 0 is the
    water level, the stern and the bilge under it, the bow riding clear, a punting pole across the thwarts."""
    L, n = p.level, SIDES[p.level]
    length, beam, side = PUNT["length"], PUNT["beam"], PUNT["side"]
    hull = place((0, PUNT["sink"], 0), pitch=PUNT["pitch"], roll=PUNT["roll"])
    flat = length - 0.8
    box(p, (beam - 0.1, 0.05, flat), "wet", hull @ place((0, 0.025, 0)), "bottom", grain=2)
    for end in (-1, 1):
        rake = math.radians(28)
        if L < 2:
            box(p, (beam - 0.1, 0.05, 0.46), "wet", hull @ place((0, 0.025 + 0.1, end * (flat / 2 + 0.2)), pitch=-end * rake), f"rake{end}", grain=2)
        box(p, (beam - 0.06, side * 0.7, 0.05), "wood", hull @ place((0, 0.2 + side * 0.35, end * (length / 2 - 0.02))), f"transom{end}", grain=0, skip=(3,) if L == 2 else ())
    for s in (-1, 1):
        box(p, (0.045, side, length), "wet" if L > 0 else "wood", hull @ place((s * (beam / 2 - 0.02), side / 2 + 0.03, 0), roll=-s * 0.12), f"side{s}", grain=2, skip=(3,) if L == 2 else ())
        if L == 0:
            box(p, (0.07, 0.05, length - 0.1), "wood", hull @ place((s * (beam / 2 + 0.005), side + 0.04, 0), roll=-s * 0.12), f"gunwale{s}", grain=2)
            for k in range(5):
                z = -1.4 + 0.7 * k
                box(p, (0.05, side - 0.04, 0.06), "wood", hull @ place((s * (beam / 2 - 0.08), side / 2 + 0.05, z), roll=-s * 0.12), f"rib{s}{k}", grain=1)
    for k, z in enumerate((-0.9, 0.8)[:(2, 2, 0)[L]]):
        box(p, (beam - 0.12, 0.05, 0.24), "wood", hull @ place((0, side - 0.04, z)), f"thwart{k}", grain=0)
    if L < 2:
        rod(p, hull @ Vector((-0.55, side + 0.04, -1.6)), hull @ Vector((0.5, side + 0.06, 1.7)), 0.03, "pole", max(n - 2, 3), "pole")
    if L == 0:
        lump(p, (0, 0, 0), (0.18, 0.1, 0.22), 1, "oilcloth", "sack", rough=0.3, at=hull @ place((0.15, side - 0.02, 1.25)))
    # Collision: the hull's box above its keel, in the punt's frame.
    corners = [hull @ Vector((sx * beam / 2, y, sz * length / 2)) for sx in (-1, 1) for y in (0, side + 0.07) for sz in (-1, 1)]
    lo = [min(c[k] for c in corners) for k in range(3)]
    hi = [max(c[k] for c in corners) for k in range(3)]
    info = proxies_of([("hull", lo, hi)])
    info["draft"] = round(-lo[1], 3)
    return info


CRATE = (0.7, 0.55, 0.5)
CRATES = [((-0.38, 0.0, 0.0), 0.04), ((0.38, 0.0, 0.05), -0.06), ((0.0, CRATE[1] + 0.02, -0.02), 0.14)]


def wrapped_crate(p, at, key):
    """A crate wrapped in oilcloth and tied twice with rope."""
    w, h, d = CRATE
    box(p, (w + 0.03, h + 0.02, d + 0.03), "oilcloth", at @ place((0, h / 2 + 0.01, 0)), f"{key}-wrap", grain=0)
    if p.level == 0:
        for side in (-1, 1):
            box(p, (0.1, 0.012, d + 0.01), "oilcloth", at @ place((side * (w / 2 + 0.03), h * 0.82, 0), roll=side * 0.6), f"{key}-fold{side}", grain=2)
    if p.level < 2:
        for k, x in enumerate((-0.18, 0.18)):
            box(p, (0.035, h + 0.035, d + 0.045), "rope", at @ place((x, h / 2 + 0.01, 0)), f"{key}-rope{k}", grain=1, skip=(3,))
        if p.level == 0:
            lump(p, (0.18, h + 0.035, 0.05), (0.03, 0.02, 0.03), 1, "rope", f"{key}-knot", rough=0.3, at=at)


def open_crate(p, at, key):
    """The top crate cut free: bare planks, its lid off and its contents, wrapped bundles and small casks, showing."""
    w, h, d = CRATE
    wall = 0.035
    if p.level == 2:
        box(p, (w, h, d), "wood", at @ place((0, h / 2, 0)), f"{key}-solid", grain=0)
        return
    box(p, (w, wall, d), "wood", at @ place((0, wall / 2, 0)), f"{key}-floor", grain=0)
    for side in (-1, 1):
        box(p, (w, h, wall), "wood", at @ place((0, h / 2, side * (d - wall) / 2)), f"{key}-wall-z{side}", grain=0)
        box(p, (wall, h, d - 2 * wall), "wood", at @ place((side * (w - wall) / 2, h / 2, 0)), f"{key}-wall-x{side}", grain=2)
    if p.level < 2:
        for k, x in enumerate((-0.17, 0.15)):
            rod(p, at @ Vector((x, h - 0.12, -0.13)), at @ Vector((x, h - 0.12, 0.13)), 0.1, "wood", SIDES[p.level], f"{key}-cask{k}")
        lump(p, (0.0, h - 0.08, 0.06), (0.14, 0.08, 0.1), (2, 1, 1)[p.level], "oilcloth", f"{key}-bundle", rough=0.25, at=at)
    if p.level == 0:
        # The oilcloth thrown back off the stack behind it.
        def drape(u, v):
            x = (u - 0.5) * (w + 0.1)
            back = -d / 2 - 0.04
            return at @ Vector((x, h + 0.02 - v * (h + 0.55) + 0.04 * math.sin(u * 7), back - 0.1 * math.sin(math.pi * min(v * 1.3, 1)) - 0.02 * v))
        sheet(p, drape, 5, 6, "oilcloth", f"{key}-drape")


def supply_crates(p, opened=False):
    """Three oilcloth-wrapped crates on a mud bank, two below and one on top; open, the top crate is unwrapped and
    opened and its lid leans against the stack."""
    boxes = []
    for k, (offset, yaw) in enumerate(CRATES):
        at = place(offset, yaw=yaw)
        if opened and k == 2:
            open_crate(p, at, f"crate{k}")
        else:
            wrapped_crate(p, at, f"crate{k}")
        corners = [at @ Vector((sx * CRATE[0] / 2, y, sz * CRATE[2] / 2)) for sx in (-1, 1) for y in (0, CRATE[1]) for sz in (-1, 1)]
        boxes.append((f"crate{k}", [min(c[i] for c in corners) for i in range(3)], [max(c[i] for c in corners) for i in range(3)]))
    if opened:
        box(p, (CRATE[0], 0.035, CRATE[2]), "wood", place((0.95, 0.35, 0.32), yaw=-0.5, roll=1.25), "lid", grain=0)
    return proxies_of(boxes)


def fen_marker(p):
    """A pole pushed into the mud with a strip of red cloth knotted near its top: the smugglers' mark."""
    L, n = p.level, SIDES[p.level]
    top = Vector((0.12, 2.15, 0.05))
    rod(p, (0, -BURY, 0), top, 0.035, "pole", n, "pole", caps=(False, True))
    tie = Vector((0.11, 1.95, 0.045))
    if L == 0:
        lump(p, tie, (0.05, 0.03, 0.05), 1, "cloth", "knot", rough=0.2)
    strip = (6, 3, 1)[L]
    sheet(p, lambda u, v: tie + Vector((0.035 + 0.38 * v, -0.06 * u - 0.42 * v + 0.05 * v * v, 0.05 * math.sin(v * 6.0 + u))), 1, strip,
          "cloth", "strip", rect=(0.03, 0.02, 0.16, 0.42))
    return proxies_of([("pole", (-0.06, 0, -0.06), (0.18, 2.2, 0.11))])


BUILDERS = {
    "hunter-lean-to": hunter_lean_to, "hunter-chest": hunter_chest, "hunter-chest-open": lambda p: hunter_chest(p, opened=True),
    "skinning-rack": skinning_rack, "fire-ring": fire_ring, "hunter-clue": hunter_clue,
    "lookout-platform": lookout_platform, "lookout-ladder": lookout_ladder, "signal-brazier": signal_brazier,
    "signal-brazier-lit": lambda p: signal_brazier(p, lit=True), "lookout-banner": lookout_banner, "weapon-rack": weapon_rack,
    "fen-punt": fen_punt, "supply-crates": supply_crates, "supply-crates-open": lambda p: supply_crates(p, opened=True),
    "fen-marker": fen_marker,
}


def build(piece, collection, level=0, location=(0, 0, 0), yaw=0.0):
    """One piece as one mesh object at ``location`` (glTF axes), turned ``yaw`` about +Y."""
    part = Part(piece, level)
    info = BUILDERS[piece](part)
    obj = part.mesh(f"discoveries.{piece}", collection)
    obj.location = C["to_blender"](location)
    obj.rotation_euler = (0.0, 0.0, yaw)
    return obj, info


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or set(arguments) != {"schemaVersion", "piece", "level"}:
        raise ValueError("discoveries arguments must be {schemaVersion: 1, piece, level}")
    if arguments["piece"] not in PIECES:
        raise ValueError(f"discoveries piece must be one of {', '.join(PIECES)}")
    if arguments["level"] not in (0, 1, 2):
        raise ValueError("discoveries level must be 0, 1 or 2")
    if set(inputs) != {"common"}:
        raise ValueError("discoveries recipe takes exactly the input 'common' (kit_common.py)")


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
    if piece in STATES:
        result["node"], result["state"] = STATES[piece]
    if piece == PIECES[0] and level == 0:
        result["sites"] = {name: [{"piece": entry[0], "position": [entry[1], entry[2], entry[3]], "yaw": entry[4]} for entry in placements]
                           for name, placements in SITES.items()}
    return result
