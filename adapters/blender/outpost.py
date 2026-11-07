"""Greyhaven Outpost building kit: the textures, wear and export over the kit's authored geometry.

The kit (#366) builds the exteriors of mmorpg's Greyhaven Outpost houses and smithy (mmorpg#420) in the
look of the scripted Greyhaven inn (docs/greyhaven-inn.md): a stone plinth, plaster panels in a dark
timber frame, plank doors, small glazed windows with shutters and a 30 degree shingle roof.

Two layers, each editable on its own:

- **Geometry** is hand-authored in Blender: ``assets/authored/outpost-kit.blend`` (the declared input
  ``kit``) holds one collection ``outpost.<part>`` per module, its root empty ``outpost.<part>`` carrying
  the descriptor's observations (proxies, openings, hinge, roof, smoke) as the JSON custom property
  ``outpost``. Its materials are untextured placeholders named ``outpost-<material>``.
- **Textures and wear** live here: small tileable plaster, timber, stone, shingle and slate maps (colour,
  normal and ORM) generated with numpy and aged by ``wear`` in [0, 1]. ``dress`` gives the placeholders
  these materials; wear never touches the geometry, so every wear variant shares the pristine meshes.

Frame of every module: metres, glTF right-handed +Y up, origin on the ground at the centre of the module's
outer face (the hinge for ``door``, the outer corner for ``corner``, the ground under the ridge for roof
modules), the outside towards +Z. docs/outpost-kit.md describes the grid the authored geometry keeps.
Roof modules take ``roof``: ``shingle`` (default) or ``slate``. ``compositions`` places the modules on the
mmorpg house (8 x 6 m) and smithy (6 x 7 m) footprints.

No randomness: variation comes from a SHA-256 of fixed keys, the textures from numpy's legacy
``RandomState``, which is stable across numpy versions. Every module that uses a texture embeds the same
PNG bytes, so a ``gltf-resources-v1`` bundle stores them once.

In a live Blender session, ``use_common(runpy.run_path('kit_common.py'))`` and
``use_geometry('assets/authored/outpost-kit.blend')`` bind the helpers and the geometry; ``build`` and
``build_composition`` then lay modules out, dressed at any wear. ``generate`` is the script-backend entry
point.
"""
import json
import math
import re

import bmesh
import bpy
import numpy as np
from mathutils import Vector

PARTS = ("wall", "wall-half", "wall-window", "wall-door", "door", "corner", "gable", "roof", "roof-half",
         "roof-verge", "chimney")
ROOFED = ("roof", "roof-half", "roof-verge")
ROOFS = ("shingle", "slate")
# The grid the compositions lay out; the authored modules keep it (docs/outpost-kit.md).
MODULE = 2.0
SPAN = 6.0
HALF_SPAN = SPAN / 2
DOOR = {"x0": -0.6, "x1": 0.6, "height": 2.2}
LEAF = {"width": 1.16, "height": 2.18, "thickness": 0.06, "z": -0.12}
TEXTURE = 512
SHARP_ANGLE = math.radians(35)

# name: (sRGB base colour factor, metallic, roughness, texture or None)
MATERIALS = {
    "plaster": ((1, 1, 1), 0.0, 1.0, "plaster"),
    "stone": ((1, 1, 1), 0.0, 1.0, "stone"),
    "timber": ((0.62, 0.56, 0.52), 0.0, 1.0, "wood"),
    "wood": ((1, 1, 1), 0.0, 1.0, "wood"),
    "shingle": ((1, 1, 1), 0.0, 1.0, "shingle"),
    "slate": ((1, 1, 1), 0.0, 1.0, "slate"),
    "iron": ((0.29, 0.28, 0.27), 1.0, 0.5, None),
    "glass": ((0.12, 0.15, 0.17), 0.0, 0.15, None),
    "soot": ((0.03, 0.03, 0.03), 0.0, 0.95, None),
}
# Wear presets the bundle ships as variants; the recipe takes any ``wear`` in [0, 1]. Wear is texture
# only: every variant shares the pristine geometry.
WEAR_PRESETS = {"weathered": 0.5, "worn": 1.0}
WEAR = 0.0              # the wear of the module being built (``build`` sets it)


def use_common(common):
    """Bind kit_common.py's shared helpers (the declared Python input ``common``) into this module."""
    globals().update({name: common[name] for name in common["NAMES"]})


# ---------------------------------------------------------------- textures (numpy, tileable)

def finish_maps(colour, height, strength, ao, rough):
    return np.clip(colour, 0, 1), normal_map(height, strength), np.stack([np.clip(ao, 0, 1), np.clip(rough, 0, 1), np.zeros_like(ao)], -1)


def wood_maps(size):
    """Wood grain along U, 1 m per tile: streaks, growth lines and a few knots."""
    streak = fbm(size, 2, 4, 611, stretch=(1, 12))
    lines = fbm(size, 4, 3, 621, stretch=(1, 40))
    ring = np.abs(np.sin(lines * 40.0))
    height = streak * 0.5 + ring * 0.3 + lines * 0.2
    shade = 0.88 + (streak - 0.5) * 0.45 - ring * 0.12
    base = np.array([0.56, 0.42, 0.29])
    return finish_maps(base * shade[..., None], height, 2.0, 1 - ring * 0.15, 0.76 + ring * 0.1)


def stones(size, rows, seed, widths, gap, horizontal=True):
    """Running-bond units on a 1 m tile: per pixel the joint factor (0 in a joint, 1 inside a unit,
    ``gap`` metres of falloff) and a per-unit value. ``horizontal`` also joints the rows."""
    ys = np.arange(size) / size
    xs = np.arange(size) / size
    state = np.random.RandomState(seed)
    row = np.minimum((ys * rows).astype(int), rows - 1)
    fy = ys * rows - row
    edge = np.zeros((size, size))
    value = np.zeros((size, size))
    for r in range(rows):
        cuts = [0.0]
        while cuts[-1] < 1.0:
            cuts.append(cuts[-1] + widths[0] + state.rand() * (widths[1] - widths[0]))
        cuts = np.array(cuts) / cuts[-1]  # units fill the row exactly, so it tiles
        u = (xs + state.rand()) % 1.0
        k = np.minimum(np.searchsorted(cuts, u, side="right") - 1, len(cuts) - 2)
        dx = np.minimum(u - cuts[k], cuts[k + 1] - u)
        mask = row == r
        dy = np.minimum(fy[mask], 1 - fy[mask]) / rows if horizontal else np.full(mask.sum(), 1.0)
        vals = state.rand(len(cuts))
        edge[mask] = np.minimum(dx[None, :], dy[:, None])
        value[mask] = vals[k][None, :]
    joint = np.clip(edge / gap, 0, 1)
    return joint, value


def stone_maps(size):
    """Coursed rubble, 1 m per tile: four courses of irregular grey-brown stones in dark mortar."""
    joint, value = stones(size, 4, 711, (0.16, 0.42), 0.03)
    rough_n = fbm(size, 16, 3, 721)
    bulge = np.sqrt(joint)
    height = bulge * 0.7 + rough_n * 0.3
    tone = np.array([0.56, 0.54, 0.5]) * (0.82 + value[..., None] * 0.3) + np.array([0.04, 0.02, -0.02]) * (value[..., None] - 0.5)
    mortar = np.array([0.36, 0.33, 0.29])
    colour = mortar * (1 - joint[..., None]) + tone * (0.9 + rough_n[..., None] * 0.2) * joint[..., None]
    return finish_maps(colour, height, 5.0, 0.55 + bulge * 0.45, 0.88 + (1 - joint) * 0.08)


def roof_maps(size, seed, base, widths, rows, gap, strength, wear=0.0):
    """Overlapping roof units, 1 m per tile, ``rows`` courses: each unit is thickest at its lower edge.
    With ``wear`` some units are missing: a dark, flat recess where the boards show through."""
    ys = np.arange(size) / size
    joint, value = stones(size, rows, seed, widths, gap, horizontal=False)
    fy = (ys * rows) % 1.0  # 0 at a course's top edge (image rows run down the slope)
    taper = (0.35 + 0.65 * fy)[:, None]
    grain = fbm(size, 4, 3, seed + 7, stretch=(6, 1))
    height = joint * taper + grain * 0.15
    shade = (0.78 + value * 0.32)[..., None] * (0.92 + grain[..., None] * 0.16) * (0.75 + 0.25 * taper[..., None])
    colour = np.array(base) * shade * (0.35 + 0.65 * joint[..., None])
    ao, rough = 0.6 + 0.4 * joint * taper, 0.8 + (1 - joint) * 0.1
    if wear > 0:
        # ``value`` is distinct per unit, so a unit is missing whole. A tile holds only a few dozen units, so
        # a fixed share of them goes, at least one, in a hashed order: more wear only adds missing units. The
        # tile repeats every metre and every roof module alike, so holes stay sparse or they read as a grid.
        rank, count = unit_rank(value)
        missing = (rank < math.ceil(count * MISSING_SHARE * wear)).astype(float)
        colour = colour * (1 - missing[..., None]) + np.array([0.035, 0.03, 0.028]) * missing[..., None]
        height = height * (1 - missing) - 0.3 * missing
        ao, rough = ao * (1 - 0.7 * missing), rough + (0.95 - rough) * missing
    return finish_maps(colour, height, strength, ao, rough)


MISSING_SHARE = 0.07     # of the roof units, missing at full wear
# Roof textures: seed, base colour, unit widths, courses, joint falloff and normal strength.
ROOF_MAPS = {
    "shingle": (811, (0.5, 0.42, 0.35), (0.11, 0.22), 4, 0.012, 4.0),
    "slate": (911, (0.4, 0.42, 0.46), (0.2, 0.3), 4, 0.01, 3.0),
}


def unit_rank(value):
    """Per pixel the rank of its roof unit in the hashed order units go missing in, and the unit count."""
    units = np.unique(value)
    order = units[np.argsort((units * 9973.0) % 1.0)]
    rank = np.empty(len(units), dtype=int)
    rank[np.searchsorted(units, order)] = np.arange(len(units))
    return rank[np.searchsorted(units, value)], len(units)


def plaster_fall(size):
    """The field plaster falls away along: a pixel has fallen once it exceeds ``0.8 - 0.2 * wear``."""
    return fbm(size, 3, 4, 1201) * 0.65 + fbm(size, 12, 3, 1211) * 0.35


def daub_maps(size, metres):
    """Wattle and daub, ``metres`` per tile: woven rods under clay. Returns colour, height and roughness."""
    ys = np.arange(size) / size
    xs = np.arange(size) / size
    stake = np.floor(xs * 4 * metres)                            # four stakes per metre
    weave = np.sin((ys[:, None] * 12 * metres + 0.5 * (stake[None, :] % 2)) * 2 * math.pi)
    rods = np.clip(np.abs(weave) * 1.2, 0, 1)
    clay = fbm(size, 8, 4, 1011)
    cover = np.clip((clay - 0.38) * 3, 0, 1)                     # clay still clinging over the rods
    height = rods * (1 - cover) * 0.7 + clay * 0.5
    colour = (np.array([0.27, 0.22, 0.17]) * (0.75 + rods[..., None] * 0.35) * (1 - cover[..., None])
              + np.array([0.45, 0.41, 0.35]) * (0.85 + clay[..., None] * 0.2) * cover[..., None])
    return colour, height, 0.95 + 0 * rods


def plaster_maps(size, wear=0.0):
    """Lime plaster, 2 m per tile: broad blotches, trowel waves and a fine grain. With ``wear`` patches
    have fallen away to a recessed wattle and daub; more wear widens them."""
    broad = fbm(size, 3, 4, 511)
    trowel = fbm(size, 6, 3, 521, stretch=(1, 2))
    fine = fbm(size, 48, 2, 531)
    height = broad * 0.3 + trowel * 0.4 + fine * 0.3
    shade = 0.95 + (broad - 0.5) * 0.22 + (fine - 0.5) * 0.08
    colour = np.array([0.82, 0.77, 0.67]) * shade[..., None]
    ao, rough = 1 - (1 - broad) * 0.1, 0.9 + (fine - 0.5) * 0.1
    if wear > 0:
        field = plaster_fall(size)
        fallen = np.clip((field - (0.8 - 0.2 * wear)) * 14, 0, 1)
        rim = np.clip((field - (0.8 - 0.2 * wear) + 0.03) * 14, 0, 1) - fallen     # a broken plaster edge
        d_colour, d_height, d_rough = daub_maps(size, TILE["plaster"])
        colour = colour * (1 - fallen[..., None]) * (1 - 0.25 * rim[..., None]) + d_colour * 0.85 * fallen[..., None]
        height = height * (1 - fallen) + (d_height * 0.4 - 0.9) * fallen
        ao, rough = ao * (1 - 0.35 * fallen), rough * (1 - fallen) + d_rough * fallen
    return finish_maps(colour, height, 1.5, ao, rough)


def weathered(name, maps, wear):
    """``maps`` aged by ``wear`` in [0, 1]: grime and rain streaks on plaster, greyed and checked
    timber, moss in the stone joints and on the roof. The normal map stays as it is."""
    colour, normal, orm = maps
    if wear <= 0:
        return maps
    size = colour.shape[0]
    grime = fbm(size, 3, 4, 1101)
    streak = fbm(size, 10, 3, 1111, stretch=(12, 1))
    lum = colour.mean(axis=-1, keepdims=True)
    if name == "plaster":
        stain = np.clip((grime - 0.45) * 2.5, 0, 1) * 0.25 + np.clip((streak - 0.5) * 3, 0, 1) * 0.2
        tint = np.array([0.66, 0.6, 0.5]) * lum / 0.75
        colour = (colour * (1 - wear * 0.35) + tint * wear * 0.35) * (1 - wear * stain[..., None])
    elif name == "wood":
        grey = lum * np.array([0.92, 0.93, 0.96]) * 1.1
        colour = (colour * (1 - wear * 0.55) + grey * wear * 0.55) * (1 - wear * 0.18 * grime[..., None])
    else:
        # Moss and lichen settle where the surface is dark (joints, butts) and the noise allows.
        moss_n = fbm(size, 5, 4, 1121)
        dark = np.clip((0.55 - lum[..., 0] / max(lum.max(), 1e-6)) * 2.5, 0, 1)
        moss = np.clip((moss_n - 0.62 + 0.3 * wear) * 4, 0, 1) * (0.35 + 0.65 * dark) * wear
        green = np.array([0.24, 0.3, 0.13]) * (0.75 + 0.5 * moss_n[..., None])
        colour = colour * (1 - wear * 0.12 * grime[..., None])
        colour = colour * (1 - moss[..., None] * 0.85) + green * moss[..., None] * 0.85
        orm = orm.copy()
        orm[..., 1] = np.clip(orm[..., 1] + moss * 0.1, 0, 1)
    return np.clip(colour, 0, 1), normal, orm


def texture_maps(name, wear=0.0):
    if name == "plaster":
        maps = plaster_maps(TEXTURE, wear)
    elif name == "wood":
        maps = wood_maps(TEXTURE)
    elif name == "stone":
        maps = stone_maps(TEXTURE)
    else:
        maps = roof_maps(TEXTURE, *ROOF_MAPS[name], wear)
    return weathered(name, maps, wear)


def wear_mask(name):
    """The wear of texture ``name`` as data for a shader that ages the pristine maps at any ``wear`` in
    [0, 1] (docs/outpost-kit.md#wear-masks), so every wear level shares one material. Linear RGB in [0, 1]:

    - R, reveal: the wear from which the pixel shows what lies beneath (plaster fallen to wattle and daub,
      a roof unit missing); 1 never.
    - G, grime: how much full wear darkens the pixel (rain streaks and stains, grime).
    - B, plaster: the wattle and daub beneath, from its dark rods (0) to its pale clay (1). Stone and roofs:
      the wear from which moss settles; 1 never. Wood: 1.
    """
    size = TEXTURE
    reveal, moss = np.ones((size, size)), np.ones((size, size))
    grime = fbm(size, 3, 4, 1101)
    if name == "plaster":
        reveal = np.clip((0.8 - plaster_fall(size)) / 0.2, 1 / 255, 1)
        streak = fbm(size, 10, 3, 1111, stretch=(12, 1))
        grime = np.clip((grime - 0.45) * 2.5, 0, 1) * 0.25 + np.clip((streak - 0.5) * 3, 0, 1) * 0.2
        d_colour = daub_maps(size, TILE["plaster"])[0].mean(axis=-1)
        rods, clay = np.mean([0.27, 0.22, 0.17]) * 0.75, np.mean([0.45, 0.41, 0.35]) * 1.05
        moss = np.clip((d_colour - rods) / (clay - rods), 0, 1)
    elif name == "wood":
        grime = grime * 0.18
    else:
        if name in ROOF_MAPS:
            seed, _, widths, rows, gap, _ = ROOF_MAPS[name]
            rank, count = unit_rank(stones(size, rows, seed, widths, gap, horizontal=False)[1])
            reveal = np.clip(rank / (count * MISSING_SHARE), 1 / 255, 1)
        lum = texture_maps(name)[0].mean(axis=-1)
        dark = np.clip((0.55 - lum / max(lum.max(), 1e-6)) * 2.5, 0, 1)
        # ``weathered``'s moss at full wear, as the wear it starts from: the more, the sooner.
        full = np.clip((fbm(size, 5, 4, 1121) - 0.32) * 4, 0, 1) * (0.35 + 0.65 * dark)
        moss = 1 - full
        grime = grime * 0.12
    return np.clip(np.stack([reveal, grime, moss], -1), 0, 1)


WEAR_TEXTURES = ("plaster", "wood", "stone", "shingle", "slate")
WEAR_MASKS = "wear-masks"   # the part that builds them


def build_wear_masks(collection):
    """One 1 m quad per texture, its material ``outpost-wear-<texture>`` carrying the mask as its base colour
    (Non-Color): the bundle's ``outpost.kit.wear-masks`` entry, which ships the masks beside the modules."""
    mesh = bpy.data.meshes.new("outpost.wear-masks")
    obj = bpy.data.objects.new("outpost.wear-masks", mesh)
    collection.objects.link(obj)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    for index, name in enumerate(WEAR_TEXTURES):
        mat = bpy.data.materials.new(f"outpost-wear-{name}")
        mat.use_nodes = True
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = make_image(f"outpost-wear-{name}", wear_mask(name), False)
        links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        mesh.materials.append(mat)
        corners = [to_blender((index * 1.5 + x, 0, -y)) for x, y in ((0, 0), (1, 0), (1, 1), (0, 1))]
        face = bm.faces.new([bm.verts.new(c) for c in corners])
        face.material_index = index
        for loop, coord in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            loop[uv].uv = coord
    bm.to_mesh(mesh)
    bm.free()
    return obj


def wear_tag():
    """The suffix of materials and images at the current wear (none when pristine)."""
    return "" if WEAR <= 0 else f"@wear{round(WEAR * 100):03d}"


def material(name):
    existing = bpy.data.materials.get(f"outpost-{name}{wear_tag()}")
    if existing is not None:
        return existing
    colour, metallic, roughness, texture = MATERIALS[name]
    mat = bpy.data.materials.new(f"outpost-{name}{wear_tag()}")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    linear = tuple(srgb_to_linear(c) for c in colour) + (1,)
    bsdf.inputs["Base Color"].default_value = linear
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    mat.use_backface_culling = True
    if texture is None:
        return mat
    images = []
    for kind, data in zip(("color", "normal", "orm"), texture_maps(texture, WEAR)):
        image_name = f"outpost-{texture}-{kind}{wear_tag()}"
        image = bpy.data.images.get(image_name) or make_image(image_name, data, kind == "color")
        images.append(image)
    tex = []
    for image in images:
        node = nodes.new("ShaderNodeTexImage")
        node.image = image
        tex.append(node)
    if colour != (1, 1, 1):
        mix = nodes.new("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        links.new(tex[0].outputs["Color"], mix.inputs[6])
        mix.inputs[7].default_value = linear
        links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    else:
        links.new(tex[0].outputs["Color"], bsdf.inputs["Base Color"])
    nmap = nodes.new("ShaderNodeNormalMap")
    links.new(tex[1].outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    sep = nodes.new("ShaderNodeSeparateColor")
    links.new(tex[2].outputs["Color"], sep.inputs["Color"])
    links.new(sep.outputs[1], bsdf.inputs["Roughness"])
    links.new(sep.outputs[2], bsdf.inputs["Metallic"])
    return mat


# ---------------------------------------------------------------- geometry

# Metres per texture tile.
TILE = {"plaster": 2.0, "stone": 1.0, "timber": 1.0, "wood": 1.0, "shingle": 1.0, "slate": 1.0}


class Builder:
    """One mesh in glTF axes; per face a material and UVs (planar, with an optional grain direction)."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.materials = []

    def slot(self, name):
        if name not in self.materials:
            self.materials.append(name)
        return self.materials.index(name)

    def faces(self, verts, polys, mat, key="", grain=None, uvs=None):
        """Faces over ``verts``. UVs are planar per face: U along ``grain`` (a glTF direction) when it
        lies in the face, otherwise along the face's dominant box axes; ``uvs`` overrides per vertex."""
        bverts = [self.bm.verts.new(to_blender(p)) for p in verts]
        made = [self.bm.faces.new([bverts[i] for i in q]) for q in polys]
        scale = 1.0 / TILE.get(mat, 1.0)
        offset = (rnd(key, "u"), rnd(key, "v"))
        for f, q in zip(made, polys):
            f.normal_update()
            f.material_index = self.slot(mat)
            n = Vector((f.normal.x, f.normal.z, -f.normal.y))  # glTF axes
            if uvs is not None:
                for loop, i in zip(f.loops, q):
                    loop[self.uv].uv = uvs[i]
                continue
            g = Vector(grain).normalized() if grain is not None else None
            if g is None or abs(g.dot(n)) > 0.7:
                axis = max(range(3), key=lambda i: abs(n[i]))
                u_axis, v_axis = [(2, 1), (0, 2), (0, 1)][axis]
                u_dir, v_dir = Vector([1 if i == u_axis else 0 for i in range(3)]), Vector([1 if i == v_axis else 0 for i in range(3)])
            else:
                u_dir = (g - n * g.dot(n)).normalized()
                v_dir = n.cross(u_dir)
            for loop, i in zip(f.loops, q):
                p = Vector(verts[i])
                loop[self.uv].uv = (p.dot(u_dir) * scale + offset[0], p.dot(v_dir) * scale + offset[1])
        return made

    def block(self, lo, hi, mat, chamfer=0.015, key="", grain=None):
        """A box with every edge chamfered; ``grain`` defaults to its longest axis."""
        h = [(hi[i] - lo[i]) / 2 for i in range(3)]
        c0 = [(hi[i] + lo[i]) / 2 for i in range(3)]
        if grain is None:
            longest = max(range(3), key=lambda i: h[i])
            grain = [1 if i == longest else 0 for i in range(3)]
        c = min(chamfer, min(h) * 0.45)
        verts, index = [], {}
        for corner in range(8):
            s = [1 if corner & (1 << i) else -1 for i in range(3)]
            for face_axis in range(3):
                index[(corner, face_axis)] = len(verts)
                verts.append([c0[i] + s[i] * (h[i] if i == face_axis else h[i] - c) for i in range(3)])
        polys = []
        for axis in range(3):
            for sign in (-1, 1):
                cs = [k for k in range(8) if (1 if k & (1 << axis) else -1) == sign]
                a, b = [i for i in range(3) if i != axis]
                ring = sorted(cs, key=lambda k: math.atan2(1 if k & (1 << b) else -1, 1 if k & (1 << a) else -1))
                polys.append([index[(k, axis)] for k in ring])
        for a in range(3):
            for b in range(a + 1, 3):
                free = 3 - a - b
                for sa in (-1, 1):
                    for sb in (-1, 1):
                        cs = [k for k in range(8) if (1 if k & (1 << a) else -1) == sa and (1 if k & (1 << b) else -1) == sb]
                        lo_k, hi_k = sorted(cs, key=lambda k: k & (1 << free))
                        polys.append([index[(lo_k, a)], index[(hi_k, a)], index[(hi_k, b)], index[(lo_k, b)]])
        for corner in range(8):
            polys.append([index[(corner, 0)], index[(corner, 1)], index[(corner, 2)]])
        made = self.faces(verts, polys, mat, key, grain)
        bmesh.ops.recalc_face_normals(self.bm, faces=made)
        return made

    def box(self, lo, hi, mat, key="", grain=None, skip_back=False):
        """A plain box (12 triangles) for small trim that needs no chamfer."""
        outline = [(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])]
        if grain is None:
            grain = (1, 0, 0) if hi[0] - lo[0] >= hi[1] - lo[1] else (0, 1, 0)
        made = self.prism(outline, lo[2], hi[2], mat, key, grain)
        if skip_back:  # the face against the wall is never seen
            bmesh.ops.delete(self.bm, geom=[f for f in made if f.normal.y > 0.99], context="FACES_ONLY")
        return made

    def prism(self, outline, z0, z1, mat, key="", grain=None):
        """Extrude a counter-clockwise (x, y) outline from z0 (back) to z1 (front)."""
        n = len(outline)
        verts = [(x, y, z0) for x, y in outline] + [(x, y, z1) for x, y in outline]
        polys = [list(range(n - 1, -1, -1)), list(range(n, 2 * n))]
        polys += [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
        made = self.faces(verts, polys, mat, key, grain)
        bmesh.ops.recalc_face_normals(self.bm, faces=made)
        return made

    def beam(self, a, b, width, z0, z1, mat="timber", key=""):
        """A straight timber from (x, y) ``a`` to ``b`` in the wall plane, ``width`` across."""
        d = Vector((b[0] - a[0], b[1] - a[1]))
        n = Vector((-d.y, d.x)).normalized() * (width / 2)
        outline = [(a[0] - n.x, a[1] - n.y), (b[0] - n.x, b[1] - n.y), (b[0] + n.x, b[1] + n.y), (a[0] + n.x, a[1] + n.y)]
        if (outline[1][0] - outline[0][0]) * (outline[2][1] - outline[0][1]) - (outline[1][1] - outline[0][1]) * (outline[2][0] - outline[0][0]) < 0:
            outline.reverse()
        return self.prism(outline, z0, z1, mat, key, grain=(d.x, d.y, 0))

    def quad(self, points, mat, key="", grain=None):
        return self.faces(points, [[0, 1, 2, 3]], mat, key, grain)

    def transform(self, faces, matrix):
        for v in {v for f in faces for v in f.verts}:
            g = matrix @ Vector((v.co.x, v.co.z, -v.co.y))
            v.co = to_blender(g)

    def finish(self, collection, parent=None):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4], quad_method="BEAUTY", ngon_method="BEAUTY")
        mesh = bpy.data.meshes.new(f"{self.name}-geometry")
        bm.to_mesh(mesh)
        bm.free()
        for name in self.materials:
            mesh.materials.append(material(name))
        mesh.set_sharp_from_angle(angle=SHARP_ANGLE)
        obj = bpy.data.objects.new(self.name, mesh)
        collection.objects.link(obj)
        obj.parent = parent
        return obj


def r6(v):
    return [round(c, 6) for c in v]


# ---------------------------------------------------------------- authored geometry

GEOMETRY = {"path": None}
PLACEHOLDER = re.compile(r"^outpost-([a-z]+)")


def use_geometry(path):
    """Bind the kit's authored geometry, ``assets/authored/outpost-kit.blend`` (the declared input ``kit``)."""
    GEOMETRY["path"] = str(path)


def dress(objects, roof="shingle"):
    """Give ``objects``' placeholder materials (``outpost-<material>``) the kit's textured materials at the
    current ``WEAR``; a roof module's shingle becomes ``roof``."""
    for obj in objects:
        if obj.type != "MESH":
            continue
        materials = obj.data.materials
        for i, placeholder in enumerate(materials):
            match = PLACEHOLDER.match(placeholder.name) if placeholder else None
            if match is None or match.group(1) not in MATERIALS:
                raise ValueError(f"{obj.name}: material {placeholder and placeholder.name} is not an outpost-<material> placeholder")
            name = roof if match.group(1) == "shingle" else match.group(1)
            materials[i] = material(name)
            if placeholder.users == 0:
                bpy.data.materials.remove(placeholder)


def load_module(part, collection):
    """Append module ``part`` from the authored geometry into ``collection``, undressed; its root and the
    observations stored on the root."""
    if GEOMETRY["path"] is None:
        raise RuntimeError("bind the authored geometry with use_geometry(path) first")
    name = f"outpost.{part}"
    with bpy.data.libraries.load(GEOMETRY["path"], link=False) as (source, target):
        if name not in source.collections:
            raise ValueError(f"{GEOMETRY['path']} has no collection {name}")
        target.collections = [name]
    loaded = target.collections[0]
    objects = list(loaded.all_objects)
    for obj in objects:
        collection.objects.link(obj)
    bpy.data.collections.remove(loaded)
    roots = [o for o in objects if o.parent is None]
    if len(roots) != 1 or roots[0].type != "EMPTY" or "outpost" not in roots[0]:
        raise ValueError(f"{name} must hold one root empty with the 'outpost' observations")
    # Placeholders are renamed so ``material`` never mistakes one for a dressed material.
    for obj in objects:
        if obj.type == "MESH":
            for placeholder in obj.data.materials:
                if placeholder and not placeholder.name.endswith(".authored"):
                    match = PLACEHOLDER.match(placeholder.name)
                    placeholder.name = f"outpost-{match.group(1) if match else placeholder.name}.authored"
    return roots[0], json.loads(roots[0]["outpost"])


# ---------------------------------------------------------------- compositions

def yaw_point(p, degrees):
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    return (p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c)


def layout(modules, length):
    """Centres of ``modules`` (each 2 or 1 m wide) laid end to end over ``length``, from -length/2."""
    widths = [MODULE / 2 if m == "wall-half" else MODULE for m in modules]
    if abs(sum(widths) - length) > 1e-9:
        raise ValueError(f"modules {modules} do not fill {length} m")
    x, out = -length / 2, []
    for m, w in zip(modules, widths):
        out.append((m, x + w / 2))
        x += w
    return out


def composition(length, front, back_side, left, right, door_side, chimney_side, roof, building_yaw):
    """A ridge-frame building (ridge along X, ``length`` long, 6 m span along Z) turned by ``building_yaw``.
    The eave walls are ``front`` (+Z) and ``back_side`` (-Z), the gable walls ``right`` (+X) and ``left`` (-X)."""
    items = []
    def add(key, t, yaw, variant="default"):
        items.append({"key": f"outpost.kit.{key}", "variant": variant, "translation": t, "yawDegrees": yaw})
    sides = [("front", front, (0, 0, HALF_SPAN), 0, length), ("back", back_side, (0, 0, -HALF_SPAN), 180, length),
             ("right", right, (length / 2, 0, 0), 90, SPAN), ("left", left, (-length / 2, 0, 0), -90, SPAN)]
    door = None
    for name, modules, origin, yaw, run in sides:
        for module, u in layout(modules, run):
            t = yaw_point((u, 0, 0), yaw)
            t = (t[0] + origin[0], 0, t[2] + origin[2])
            add(module, t, yaw)
            if module == "wall-door" and name == door_side:
                hinge = yaw_point((DOOR["x0"] + (DOOR["x1"] - DOOR["x0"] - LEAF["width"]) / 2, 0.01, LEAF["z"]), yaw)
                door = ((t[0] + hinge[0], hinge[1], t[2] + hinge[2]), yaw)
        if name in ("right", "left"):
            add("gable", origin, yaw)
        if name == chimney_side:
            add("chimney", origin, yaw)
    if door:
        add("door", door[0], door[1])
    for x, z, yaw in [(length / 2, HALF_SPAN, 0), (-length / 2, HALF_SPAN, -90), (-length / 2, -HALF_SPAN, 180), (length / 2, -HALF_SPAN, 90)]:
        add("corner", (x, 0, z), yaw)
    variant = "default" if roof == "shingle" else roof  # the bundle variant of that roofing
    roof_modules = ["roof"] * int(length // MODULE) + (["roof-half"] if length % MODULE else [])
    x = -length / 2
    for m in roof_modules:
        w = MODULE if m == "roof" else MODULE / 2
        add(m, (x + w / 2, 0, 0), 0, variant)
        x += w
    add("roof-verge", (length / 2, 0, 0), 0, variant)
    add("roof-verge", (-length / 2, 0, 0), 180, variant)
    for item in items:
        t = yaw_point(item["translation"], building_yaw)
        item["translation"] = r6([t[0], t[1], t[2]])
        item["yawDegrees"] = round(((item["yawDegrees"] + building_yaw + 180) % 360) - 180, 6)
    return items


def compositions():
    """Working placements for mmorpg's Outpost house (8 x 6 m, colliders 103-106) and smithy (6 x 7 m,
    collider 102), in a footprint-base-centre frame whose +Z side has the door."""
    house = composition(8.0, ["wall-window", "wall-half", "wall-door", "wall-half", "wall-window"],
                        ["wall", "wall-window", "wall-window", "wall"], ["wall", "wall-window", "wall"],
                        ["wall", "wall-window", "wall"], "front", "right", "shingle", 0)
    # The smithy's ridge runs along its 7 m depth; its door is in the front gable wall.
    smithy = composition(7.0, ["wall-half", "wall-window", "wall", "wall-window"], ["wall-window", "wall", "wall-window", "wall-half"],
                         ["wall", "wall", "wall"], ["wall", "wall-door", "wall"], "right", "left", "slate", -90)
    return {"house": {"footprint": {"width": 8.0, "depth": 6.0}, "items": house},
            "smithy": {"footprint": {"width": 6.0, "depth": 7.0}, "items": smithy}}


# ---------------------------------------------------------------- entry points

def build(part, collection, location=(0, 0, 0), roof="shingle", yaw=0.0, wear=0.0):
    """Place one authored module under its root ``outpost.<part>`` at ``location`` (glTF axes), dressed
    at ``wear`` in [0, 1]: 0 is the pristine kit, ``WEAR_PRESETS`` names the bundle's worn variants."""
    global WEAR
    if part not in PARTS:
        raise ValueError(f"outpost part must be one of {', '.join(PARTS)}")
    if roof not in ROOFS:
        raise ValueError(f"outpost roof must be one of {', '.join(ROOFS)}")
    if not 0 <= wear <= 1:
        raise ValueError("outpost wear must be in [0, 1]")
    WEAR = float(wear)
    root, info = load_module(part, collection)
    dress([root] + list(root.children_recursive), roof if part in ROOFED else "shingle")
    root.location = to_blender(location)
    root.rotation_euler = (0, 0, math.radians(yaw))
    return root, info


def build_composition(name, collection, location=(0, 0, 0), wear=0.0):
    """Lay a composition out in a live session (review only)."""
    roots = []
    for item in compositions()[name]["items"]:
        part = item["key"].split(".")[-1]
        t = item["translation"]
        roof = item["variant"] if item["variant"] in ROOFS else "shingle"
        root, _ = build(part, collection, (t[0] + location[0], t[1] + location[1], t[2] + location[2]), roof, item["yawDegrees"], wear)
        roots.append(root)
    return roots


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or "part" not in arguments:
        raise ValueError("outpost arguments must be {schemaVersion: 1, part, roof?, wear?}")
    if set(arguments) - {"schemaVersion", "part", "roof", "wear"}:
        raise ValueError("outpost arguments must be {schemaVersion: 1, part, roof?, wear?}")
    wear = arguments.get("wear", 0)
    if isinstance(wear, bool) or not isinstance(wear, (int, float)) or not 0 <= wear <= 1:
        raise ValueError("outpost wear must be a number in [0, 1]")
    if arguments["part"] not in PARTS + (WEAR_MASKS,):
        raise ValueError(f"outpost part must be one of {', '.join(PARTS + (WEAR_MASKS,))}")
    if arguments["part"] == WEAR_MASKS and "wear" in arguments:
        raise ValueError("the outpost wear masks take no wear")
    if "roof" in arguments and (arguments["part"] not in ROOFED or arguments["roof"] not in ROOFS):
        raise ValueError("outpost roof applies to roof modules only and must be shingle or slate")
    if set(inputs) != {"common", "kit"}:
        raise ValueError("outpost recipe takes exactly the inputs 'common' (kit_common.py) and 'kit' (outpost-kit.blend)")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_common(inputs.load_source("common"))
    use_geometry(inputs["kit"])
    part = arguments["part"]
    roof = arguments.get("roof", "shingle")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    wear = float(arguments.get("wear", 0))
    if part == WEAR_MASKS:
        obj = build_wear_masks(bpy.context.scene.collection)
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.ops.export_scene.gltf(
            filepath=output_path, export_format="GLB", use_selection=True, export_yup=True, export_texcoords=True,
            export_normals=True, export_vertex_color="NONE", export_animations=False, export_skins=False,
            export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
        return {"recipe": "outpost-kit-v1", "part": part, "textures": list(WEAR_TEXTURES)}
    root, info = build(part, bpy.context.scene.collection, roof=roof, wear=wear)
    objects = [root] + list(root.children_recursive)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    triangles = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects if o.type == "MESH")
    bpy.context.view_layer.update()
    points = [o.matrix_world @ v.co for o in objects if o.type == "MESH" for v in o.data.vertices]
    gltf = [(p.x, p.z, -p.y) for p in points]
    bounds = {"min": [round(min(p[i] for p in gltf), 6) for i in range(3)], "max": [round(max(p[i] for p in gltf), 6) for i in range(3)]}
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=True,
        export_vertex_color="NONE", export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    result = {"recipe": "outpost-kit-v1", "part": part, "roofMaterial": roof if part in ROOFED else "none", "wear": wear, "unit": "meter",
              "axes": "right-handed-y-up", "origin": "module-base-center", "facing": "+Z", "triangleCount": triangles,
              "bounds": bounds, **info}
    if part == "wall":
        result["compositions"] = compositions()
    return result
