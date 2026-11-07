"""Greyhaven Outpost building kit, an original scripted kit for the existing pinned Blender script backend.

One run builds one module of the kit (#366) for the exteriors of mmorpg's Greyhaven Outpost houses and
smithy (mmorpg#420). The look follows the scripted Greyhaven inn (docs/greyhaven-inn.md): a stone
plinth, plaster panels in a dark timber frame, plank doors, small glazed windows with shutters and a
30 degree shingle roof. Small tileable plaster, timber, stone, shingle and slate textures (colour,
normal and ORM) are generated here with numpy.

Frame, shared by every wall-like module: metres, glTF right-handed +Y up, origin on the ground at the
centre of the module's outer face, the outside towards +Z. The wall body lies behind the outer face
(z -0.32..0); timber stands flush with the face and the plinth 2 cm proud of it. Grid:

- walls are 2 m modules (x -1..1), 3.2 m high, on a 0.5 m stone plinth; ``wall-half`` is 1 m;
- ``wall-window``: a 0.9 x 1.0 m glazed window whose sill is at 1.2 m, with open shutters;
- ``wall-door``: a 1.2 x 2.2 m doorway (the inn's) in the module's centre, with a stone threshold;
- ``door``: the plank leaf; its origin is the hinge, the closed leaf runs along +X, empty node ``hinge``;
- ``corner``: the corner post and plinth block; its origin is the building's outer corner, and it
  covers x -0.2..0, z -0.2..0 (the front-right corner when unrotated);
- ``gable``: the plaster gable triangle of a 6 m span (x -3..3) on top of a gable wall;
- ``roof``/``roof-half``: 2 m and 1 m sections of the 6 m span roof; their origin is on the ground
  under the ridge, the ridge runs along X and the slopes fall to +-Z with a 0.35 m eave overhang;
- ``roof-verge``: the 0.3 m verge overhang beyond a gable (x 0..0.3) with its barge boards;
- ``chimney``: an outside stone chimney stack against a gable wall, with an empty node ``smoke``.

Roof modules take ``roof``: ``shingle`` (default) or ``slate``. ``compositions`` places the modules on
the mmorpg house (8 x 6 m) and smithy (6 x 7 m) footprints.

No randomness: variation comes from a SHA-256 of fixed keys, the textures from numpy's legacy
``RandomState``, which is stable across numpy versions. Every module that uses a texture embeds the same
PNG bytes, so a ``gltf-resources-v1`` bundle stores them once.

``build(part, collection, location, roof)`` also works in a live Blender session after ``use_common(runpy.run_path('kit_common.py'))``; ``generate`` is the
script-backend entry point.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector

PARTS = ("wall", "wall-half", "wall-window", "wall-door", "door", "corner", "gable", "roof", "roof-half",
         "roof-verge", "chimney")
ROOFED = ("roof", "roof-half", "roof-verge")
ROOFS = ("shingle", "slate")
MODULE = 2.0
WALL_H = 3.6
PLINTH = 0.5
WALL_T = 0.32           # wall body z -0.32..0
TIMBER = 0.18           # timber width; half of it at each module end
SPAN = 6.0
PITCH = math.radians(30)
EAVE = 0.35             # horizontal eave overhang beyond the outer wall face
VERGE = 0.3
ROOF_T = 0.1
COURSE = 0.25           # shingle course length along the slope
RAIL = (2.25, 2.41)     # the head rail every wall module carries; window and door heads meet it
WINDOW = {"x0": -0.45, "x1": 0.45, "y0": 1.15, "y1": RAIL[0]}
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
        # ``value`` is uniform per unit, so a unit is missing whole; more wear only adds missing units. The
        # tile repeats every metre and every roof module alike, so holes stay sparse or they read as a grid.
        missing = (np.random.RandomState(seed + 13).rand(64)[(value * 63).astype(int)] < 0.03 * wear).astype(float)
        colour = colour * (1 - missing[..., None]) + np.array([0.035, 0.03, 0.028]) * missing[..., None]
        height = height * (1 - missing) - 0.3 * missing
        ao, rough = ao * (1 - 0.7 * missing), rough + (0.95 - rough) * missing
    return finish_maps(colour, height, strength, ao, rough)


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
        field = fbm(size, 3, 4, 1201) * 0.65 + fbm(size, 12, 3, 1211) * 0.35
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
    elif name == "shingle":
        maps = roof_maps(TEXTURE, 811, (0.5, 0.42, 0.35), (0.11, 0.22), 4, 0.012, 4.0, wear)
    else:
        maps = roof_maps(TEXTURE, 911, (0.4, 0.42, 0.46), (0.2, 0.3), 4, 0.01, 3.0, wear)
    return weathered(name, maps, wear)


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


# ---------------------------------------------------------------- walls

T = TIMBER / 2
SILL_TOP = PLINTH + 0.16
PLATE = WALL_H - 0.18
PLASTER_Z = (-WALL_T + 0.02, -0.04)   # plaster face 4 cm behind the timber face
TIMBER_Z = (-0.12, 0.0)


def plaster(b, x0, x1, y0, y1, key):
    if x1 - x0 > 1e-6 and y1 - y0 > 1e-6:
        b.box((x0, y0, PLASTER_Z[0]), (x1, y1, PLASTER_Z[1]), "plaster", key, grain=(1, 0, 0))


def rail(b, x0, x1, key):
    """The head rail between two timbers, at the window and door head height of every module."""
    b.block((x0, RAIL[0], TIMBER_Z[0]), (x1, RAIL[1], TIMBER_Z[1]), "timber", key=key)


def clip(outline, keep):
    """Sutherland-Hodgman: ``outline`` cut by each half-plane ``keep`` (a function of a point, >= 0 inside)."""
    for inside in keep:
        out = []
        for i, p in enumerate(outline):
            q = outline[(i + 1) % len(outline)]
            fp, fq = inside(p), inside(q)
            if fp >= 0:
                out.append(p)
            if (fp >= 0) != (fq >= 0):
                t = fp / (fp - fq)
                out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
        outline = out
    return outline


def brace(b, a, c, key, bay, width=0.14):
    """A brace through ``a`` and ``c`` that fills its ``bay`` (x0, y0, x1, y1) from timber to timber:
    the bar is cut by the bay's edges, so its ends sit flush against the posts, rails and sills."""
    d = Vector((c[0] - a[0], c[1] - a[1])).normalized()
    n = Vector((-d.y, d.x)) * (width / 2)
    p0, p1 = Vector(a) - d * 2, Vector(c) + d * 2
    bar = [tuple(p0 - n), tuple(p1 - n), tuple(p1 + n), tuple(p0 + n)]
    x0, y0, x1, y1 = bay
    outline = clip(bar, [lambda p: p[0] - x0, lambda p: x1 - p[0], lambda p: p[1] - y0, lambda p: y1 - p[1]])
    outline = [p for i, p in enumerate(outline) if math.dist(p, outline[i - 1]) > 1e-4]  # corners the cut hit exactly
    if (outline[1][0] - outline[0][0]) * (outline[2][1] - outline[0][1]) - (outline[1][1] - outline[0][1]) * (outline[2][0] - outline[0][0]) < 0:
        outline.reverse()
    b.prism(outline, TIMBER_Z[0] + 0.01, TIMBER_Z[1] - 0.005, "timber", key, grain=(d.x, d.y, 0))


def plinth(b, x0, x1, key):
    b.block((x0, 0.0, -WALL_T), (x1, PLINTH, 0.02), "stone", 0.03, key, grain=(1, 0, 0))


def frame(b, width, part, posts=(), gap=None):
    """Sill beam, top plate and the half posts at both module ends (they pair up with the neighbours').
    ``gap`` (x0, x1) leaves a doorway out of the sill beam."""
    hw = width / 2
    for x0, x1 in ([(-hw, hw)] if gap is None else [(-hw, gap[0]), (gap[1], hw)]):
        b.block((x0, PLINTH, TIMBER_Z[0]), (x1, SILL_TOP, TIMBER_Z[1]), "timber", key=f"{part}/sill{x0:.2f}")
    b.block((-hw, PLATE, TIMBER_Z[0]), (hw, WALL_H, TIMBER_Z[1]), "timber", key=f"{part}/plate")
    for x0, x1 in [(-hw, -hw + T), (hw - T, hw)] + list(posts):
        b.block((x0, SILL_TOP, TIMBER_Z[0]), (x1, PLATE, TIMBER_Z[1]), "timber", key=f"{part}/post{x0:.2f}")


def back(b, width, y0=PLINTH, y1=WALL_H):
    """The inner face of the wall (plaster), so a module reads as solid from both sides."""
    hw = width / 2
    b.box((-hw, y0, -WALL_T), (hw, y1, PLASTER_Z[0] + 0.001), "plaster", "back", grain=(1, 0, 0))


def solid_proxy(width):
    return [proxy("wall", "solid", (-width / 2, 0, -WALL_T), (width / 2, WALL_H, 0))]


def build_wall(part, col, root):
    width = MODULE if part == "wall" else MODULE / 2
    hw = width / 2
    b = Builder(f"outpost.{part}.mesh")
    plinth(b, -hw, hw, f"{part}/plinth")
    plaster(b, -hw, hw, PLINTH, WALL_H, f"{part}/plaster")
    # The head rail runs between the posts at the same height in every module, so it reads as one
    # continuous timber around the building; braces stay below it, from post to post.
    if part == "wall":
        frame(b, width, part, posts=[(-T, T)])
        rail(b, -hw + T, -T, f"{part}/rail.l")
        rail(b, T, hw - T, f"{part}/rail.r")
        # A brace in each lower bay, falling towards the module's centre post.
        brace(b, (-hw + T, RAIL[0]), (-T, SILL_TOP), f"{part}/brace.l", (-hw + T, SILL_TOP, -T, RAIL[0]), 0.16)
        brace(b, (hw - T, RAIL[0]), (T, SILL_TOP), f"{part}/brace.r", (T, SILL_TOP, hw - T, RAIL[0]), 0.16)
    else:
        frame(b, width, part)
        rail(b, -hw + T, hw - T, f"{part}/rail")
        brace(b, (-hw + T, SILL_TOP), (hw - T, RAIL[0]), f"{part}/brace", (-hw + T, SILL_TOP, hw - T, RAIL[0]), 0.16)
    b.finish(col, root)
    return {"module": {"width": width, "height": WALL_H, "depth": WALL_T}, "collisionProxies": solid_proxy(width)}


def build_wall_window(part, col, root):
    hw = MODULE / 2
    w = WINDOW
    b = Builder(f"outpost.{part}.mesh")
    plinth(b, -hw, hw, f"{part}/plinth")
    fx0, fx1, fy0, fy1 = w["x0"] - 0.1, w["x1"] + 0.1, w["y0"] - 0.1, RAIL[1]
    plaster(b, -hw, fx0, PLINTH, WALL_H, f"{part}/plaster.l")
    plaster(b, fx1, hw, PLINTH, WALL_H, f"{part}/plaster.r")
    plaster(b, fx0, fx1, PLINTH, fy0, f"{part}/plaster.b")
    plaster(b, fx0, fx1, w["y1"], WALL_H, f"{part}/plaster.t")
    frame(b, MODULE, part)
    # Window studs run from the sill beam to the top plate; the head rail is the window's head and a
    # sill rail carries it, both continuing out to the end posts. Nothing crosses the opening.
    b.block((fx0, SILL_TOP, TIMBER_Z[0]), (w["x0"], PLATE, TIMBER_Z[1]), "timber", key=f"{part}/stud.l")
    b.block((w["x1"], SILL_TOP, TIMBER_Z[0]), (fx1, PLATE, TIMBER_Z[1]), "timber", key=f"{part}/stud.r")
    for x0, x1, k in [(-hw + T, fx0, "l"), (fx1, hw - T, "r")]:  # short, so plain boxes (the triangle budget)
        b.box((x0, RAIL[0], TIMBER_Z[0]), (x1, RAIL[1], TIMBER_Z[1]), "timber", f"{part}/rail.{k}", grain=(1, 0, 0))
        b.box((x0, fy0, TIMBER_Z[0]), (x1, w["y0"], TIMBER_Z[1]), "timber", f"{part}/sillrail.{k}", grain=(1, 0, 0))
    # Between the studs the proud sill and lintel are the rails.
    b.block((fx0 - 0.06, fy0, TIMBER_Z[0]), (fx1 + 0.06, w["y0"], 0.06), "timber", key=f"{part}/sill")
    b.block((fx0 - 0.04, RAIL[0], TIMBER_Z[0]), (fx1 + 0.04, RAIL[1], 0.02), "timber", key=f"{part}/lintel")
    # Knee braces above the head rail, clear of the window and its shutters.
    brace(b, (-hw + T, PLATE), (fx0, RAIL[1]), f"{part}/brace.tl", (-hw + T, RAIL[1], fx0, PLATE))
    brace(b, (hw - T, PLATE), (fx1, RAIL[1]), f"{part}/brace.tr", (fx1, RAIL[1], hw - T, PLATE))
    # Reveal: the opening's sides are lined with timber down to the glass.
    gz = -0.16
    for x0, x1 in [(w["x0"] - 0.001, w["x0"] + 0.03), (w["x1"] - 0.03, w["x1"] + 0.001)]:
        b.box((x0, w["y0"], gz - 0.02), (x1, w["y1"], TIMBER_Z[0] + 0.001), "timber", f"{part}/reveal{x0:.2f}", grain=(0, 1, 0))
    for y0, y1 in [(w["y0"] - 0.001, w["y0"] + 0.03), (w["y1"] - 0.03, w["y1"] + 0.001)]:
        b.box((w["x0"], y0, gz - 0.02), (w["x1"], y1, TIMBER_Z[0] + 0.001), "timber", f"{part}/reveal{y0:.2f}", grain=(1, 0, 0))
    b.quad([(w["x0"], w["y0"], gz), (w["x1"], w["y0"], gz), (w["x1"], w["y1"], gz), (w["x0"], w["y1"], gz)], "glass", f"{part}/glass")
    # Mullion and transom.
    cx, cy = (w["x0"] + w["x1"]) / 2, (w["y0"] + w["y1"]) / 2 + 0.1
    b.box((cx - 0.03, w["y0"], gz - 0.01), (cx + 0.03, w["y1"], gz + 0.05), "timber", f"{part}/mullion", grain=(0, 1, 0))
    b.box((w["x0"], cy - 0.03, gz - 0.01), (w["x1"], cy + 0.03, gz + 0.05), "timber", f"{part}/transom")
    # Open shutters, flat against the wall either side of the frame: boards with two battens.
    sw = 0.34
    sy0, sy1 = fy0 + 0.02, RAIL[0] - 0.02
    for side in (-1, 1):
        x_in = fx1 + 0.02 if side > 0 else fx0 - 0.02 - sw
        b.box((x_in, sy0, 0.0), (x_in + sw, sy1, 0.035), "wood", f"{part}/shutter{side}", grain=(0, 1, 0), skip_back=True)
        for y in (sy0 + 0.2, sy1 - 0.2):
            b.box((x_in + 0.02, y - 0.04, 0.035), (x_in + sw - 0.02, y + 0.04, 0.055), "wood", f"{part}/batten{side}{y:.2f}", skip_back=True)
    back(b, MODULE, PLINTH, fy0)
    back_parts = [(-hw, fx0), (fx1, hw)]
    for x0, x1 in back_parts:
        b.box((x0, fy0, -WALL_T), (x1, RAIL[0], PLASTER_Z[0] + 0.001), "plaster", f"back{x0:.2f}", grain=(1, 0, 0))
    b.box((-hw, RAIL[0], -WALL_T), (hw, WALL_H, PLASTER_Z[0] + 0.001), "plaster", "back.top", grain=(1, 0, 0))
    b.finish(col, root)
    window = {"center": r6([cx, (w["y0"] + w["y1"]) / 2, gz]), "width": round(w["x1"] - w["x0"], 6),
              "height": round(w["y1"] - w["y0"], 6), "sill": w["y0"], "glazed": True,
              "min": r6([w["x0"], w["y0"], gz]), "max": r6([w["x1"], w["y1"], 0.0])}
    return {"module": {"width": MODULE, "height": WALL_H, "depth": WALL_T}, "window": window,
            "collisionProxies": solid_proxy(MODULE)}


def build_wall_door(part, col, root):
    hw = MODULE / 2
    d = DOOR
    b = Builder(f"outpost.{part}.mesh")
    fx0, fx1, top = d["x0"] - 0.16, d["x1"] + 0.16, RAIL[1]
    plinth(b, -hw, fx0, f"{part}/plinth.l")
    plinth(b, fx1, hw, f"{part}/plinth.r")
    plaster(b, -hw, fx0, PLINTH, WALL_H, f"{part}/plaster.l")
    plaster(b, fx1, hw, PLINTH, WALL_H, f"{part}/plaster.r")
    plaster(b, fx0, fx1, top, WALL_H, f"{part}/plaster.t")
    frame(b, MODULE, part, gap=(fx0 + 0.01, fx1 - 0.01))
    # Door posts stand on stone pads; the head beam carries the wall above the doorway.
    for x0, x1, k in [(fx0, d["x0"], "l"), (d["x1"], fx1, "r")]:
        pad = (x0 - 0.04, x1) if k == "l" else (x0, x1 + 0.04)  # wider outwards only: the doorway stays clear
        b.block((pad[0], 0.0, -WALL_T), (pad[1], 0.22, 0.03), "stone", 0.02, f"{part}/pad.{k}")
        b.block((x0, 0.22, -WALL_T + 0.01), (x1, top, TIMBER_Z[1]), "timber", key=f"{part}/doorpost.{k}")
    b.block((fx0 - 0.08, d["height"], -WALL_T + 0.01), (fx1 + 0.08, top, 0.02), "timber", key=f"{part}/head")
    rail(b, -hw + T, fx0 - 0.08, f"{part}/rail.l")
    rail(b, fx1 + 0.08, hw - T, f"{part}/rail.r")
    # The bays beside the door posts are too narrow to brace; two braces rise from the post heads
    # to meet under the plate over the doorway's centre.
    brace(b, (fx0, top), (0, PLATE), f"{part}/brace.l", (fx0, top, 0, PLATE))
    brace(b, (fx1, top), (0, PLATE), f"{part}/brace.r", (0, top, fx1, PLATE))
    # Threshold: top flush with the ground, proud of the face.
    b.block((d["x0"] - 0.02, -0.08, -WALL_T), (d["x1"] + 0.02, 0.0, 0.22), "stone", 0.02, f"{part}/threshold", grain=(1, 0, 0))
    for x0, x1 in [(-hw, fx0), (fx1, hw)]:
        b.box((x0, PLINTH, -WALL_T), (x1, WALL_H, PLASTER_Z[0] + 0.001), "plaster", f"back{x0:.2f}", grain=(1, 0, 0))
    b.box((fx0, top, -WALL_T), (fx1, WALL_H, PLASTER_Z[0] + 0.001), "plaster", "back.top", grain=(1, 0, 0))
    hinge = (d["x0"] + (d["x1"] - d["x0"] - LEAF["width"]) / 2, 0.01, LEAF["z"])
    empty("door.hinge", col, root, hinge)
    b.finish(col, root)
    depth_z = (-WALL_T, 0.0)
    doorway = {"center": r6([0, d["height"] / 2, (depth_z[0] + depth_z[1]) / 2]), "width": d["x1"] - d["x0"],
               "height": d["height"], "depth": WALL_T, "min": r6([d["x0"], 0, depth_z[0]]), "max": r6([d["x1"], d["height"], depth_z[1]])}
    proxies = [proxy("left-jamb", "solid", (-hw, 0, -WALL_T), (d["x0"], WALL_H, 0)),
               proxy("right-jamb", "solid", (d["x1"], 0, -WALL_T), (hw, WALL_H, 0)),
               proxy("lintel", "solid", (d["x0"], d["height"], -WALL_T), (d["x1"], WALL_H, 0))]
    return {"module": {"width": MODULE, "height": WALL_H, "depth": WALL_T}, "doorway": doorway,
            "mount": {"key": "outpost.kit.door", "node": "door.hinge", "translation": r6(hinge)}, "collisionProxies": proxies}


def build_door(part, col, root):
    """Plank leaf: hinge at the origin, the closed leaf along +X, its face towards +Z."""
    L = LEAF
    b = Builder(f"outpost.{part}.mesh")
    planks = 5
    pw = L["width"] / planks
    t = L["thickness"]
    for k in range(planks):
        x0 = k * pw
        b.box((x0 + 0.004, 0.0, -t / 2), (x0 + pw - 0.004, L["height"], t / 2), "wood", f"door/plank{k}", grain=(0, 1, 0))
    b.box((0.01, 0.02, -t / 2 + 0.01), (L["width"] - 0.01, L["height"] - 0.02, t / 2 - 0.01), "soot", "door/gaps")
    for y in (0.35, 1.85):  # battens on the inside
        b.box((0.05, y - 0.07, -t / 2 - 0.035), (L["width"] - 0.05, y + 0.07, -t / 2 + 0.001), "wood", f"door/batten{y}")
    b.beam((0.08, 0.42), (L["width"] - 0.08, 1.78), 0.12, -t / 2 - 0.035, -t / 2 + 0.001, "wood", "door/brace")
    for y in (0.35, 1.85):  # strap hinges on the outside
        b.box((-0.01, y - 0.03, t / 2 - 0.002), (0.75, y + 0.03, t / 2 + 0.008), "iron", f"door/strap{y}")
    b.box((0.98, 1.0, t / 2), (1.03, 1.16, t / 2 + 0.03), "iron", "door/latch")
    b.box((0.94, 1.06, t / 2 + 0.03), (1.07, 1.1, t / 2 + 0.05), "iron", "door/handle")
    b.finish(col, root)
    empty("hinge", col, root)
    leaf = {"min": [0, 0, round(-t / 2 - 0.035, 6)], "max": r6([L["width"], L["height"], t / 2 + 0.05])}
    return {"hinge": {"node": "hinge", "axis": [0, 1, 0], "closedAngle": 0, "openAngle": round(math.pi / 2, 6), "swing": "inward",
                      "note": "rotating +90 degrees about +Y turns the leaf from +X to -Z, into the building"},
            "leafBounds": leaf,
            "collisionProxies": [proxy("leaf", "dynamic-door", (0, 0, -t / 2), (L["width"], L["height"], t / 2))]}


def build_corner(part, col, root):
    """The building's outer corner at the origin; the post covers both walls' end posts."""
    b = Builder(f"outpost.{part}.mesh")
    b.block((-0.38, 0.0, -0.38), (0.04, PLINTH + 0.04, 0.04), "stone", 0.03, "corner/plinth")
    b.block((-0.22, PLINTH + 0.04, -0.22), (0.02, WALL_H + 0.02, 0.02), "timber", 0.02, "corner/post", grain=(0, 1, 0))
    b.finish(col, root)
    return {"collisionProxies": [proxy("corner", "solid", (-0.38, 0, -0.38), (0.04, WALL_H, 0.04))]}


# ---------------------------------------------------------------- gable and roof

HALF_SPAN = SPAN / 2
UNDER_RIDGE = WALL_H + HALF_SPAN * math.tan(PITCH)   # roof underside over the span's centre


def roof_under(z):
    """Height of the roof underside at distance z from the ridge line (positive both ways)."""
    return UNDER_RIDGE - abs(z) * math.tan(PITCH)


def build_gable(part, col, root):
    """The gable triangle in a gable wall's frame (x -3..3 across the span), from the wall top to the roof."""
    b = Builder(f"outpost.{part}.mesh")
    top = roof_under(0) - 0.01
    inset = 0.02
    edge = HALF_SPAN - inset
    outline = [(-edge, WALL_H), (edge, WALL_H), (0, top)]
    b.prism(outline, PLASTER_Z[0], PLASTER_Z[1], "plaster", "gable/plaster", grain=(1, 0, 0))
    b.prism(outline, -WALL_T, PLASTER_Z[0] + 0.001, "plaster", "gable/back", grain=(1, 0, 0))
    # Rafters follow both roof edges from the plate to the apex, so every gable timber ends on one.
    w = 0.16
    rise = top - WALL_H
    across = w / math.sin(math.atan2(rise, edge))     # a rafter's horizontal width
    def inner(y):
        """x of the rafters' inner edge at height y."""
        return edge * (1 - (y - WALL_H) / rise) - across
    for side in (-1, 1):
        ring = [(side * edge, WALL_H), (0, top), (0, top - rise * across / edge), (side * (edge - across), WALL_H)]
        if side < 0:
            ring.reverse()
        b.prism(ring, TIMBER_Z[0] + 0.005, TIMBER_Z[1] - 0.002, "timber", f"gable/rafter{side}", grain=(-side * edge, rise, 0))
    # A collar cut to the rafters; two posts under it stand over the gable wall's module joints, clear of
    # the window below; the king post rises from the collar to the apex.
    c0, c1 = WALL_H + rise * 0.4 - 0.08, WALL_H + rise * 0.4 + 0.08
    b.prism([(-inner(c0), c0), (inner(c0), c0), (inner(c1), c1), (-inner(c1), c1)], TIMBER_Z[0], TIMBER_Z[1], "timber", "gable/collar", grain=(1, 0, 0))
    for x in (-1.0, 1.0):
        b.block((x - 0.08, WALL_H, TIMBER_Z[0]), (x + 0.08, c0, TIMBER_Z[1]), "timber", key=f"gable/post{x:.0f}", grain=(0, 1, 0))
    y_meet = WALL_H + rise * (1 - (0.08 + across) / edge)   # where the king post's sides reach the rafters
    b.prism([(-0.08, c1), (0.08, c1), (0.08, y_meet), (0, top - rise * across / edge), (-0.08, y_meet)],
            TIMBER_Z[0], TIMBER_Z[1], "timber", "gable/kingpost", grain=(0, 1, 0))
    # A small louvred vent each side of the king post, above the collar.
    vy = c1 + 0.2
    for x0 in (-0.4, 0.14):
        b.box((x0, vy - 0.14, -0.12), (x0 + 0.26, vy + 0.14, -0.03), "soot", f"gable/vent{x0}")
        for k in range(3):
            y = vy - 0.09 + k * 0.09
            b.box((x0, y - 0.022, -0.06), (x0 + 0.26, y + 0.022, -0.01), "wood", f"gable/louvre{x0}{k}")
    b.finish(col, root)
    return {"span": SPAN, "collisionProxies": [proxy("gable", "solid", (-HALF_SPAN, WALL_H, -WALL_T), (HALF_SPAN, top, 0))]}


def roof_slope(b, x0, x1, roof, key, verge_end=None):
    """Both slopes between x0 and x1: overlapping courses of ``roof`` material, eave fascia, rafter tails
    and the ridge cap. ``verge_end`` (an x) adds the barge boards on that end."""
    tan = math.tan(PITCH)
    run = HALF_SPAN + EAVE                        # horizontal run from the ridge to the eave
    slope_len = run / math.cos(PITCH)
    n = int(math.ceil(slope_len / COURSE))
    normal_off = ROOF_T                            # roof thickness perpendicular to the slope
    # A point on the slope at distance s down from the ridge, lifted ``off`` along the slope normal.
    def point(x, s, off, side):
        z = s * math.cos(PITCH) - off * math.sin(PITCH)
        y = UNDER_RIDGE - s * math.sin(PITCH) + off * math.cos(PITCH)
        return (x, y, side * z)
    for side in (-1, 1):
        for k in range(n):
            s0 = k * COURSE
            s1 = min(slope_len, s0 + COURSE + 0.06)  # each course laps over the one below
            lift = normal_off + 0.012 * (k % 2)      # courses alternate slightly, so their butts read
            tilt = 0.02
            pts = [point(x0, s0, normal_off - 0.02, side), point(x1, s0, normal_off - 0.02, side),
                   point(x1, s1, lift + tilt, side), point(x0, s1, lift + tilt, side),
                   point(x0, s0, normal_off - 0.06, side), point(x1, s0, normal_off - 0.06, side),
                   point(x1, s1, lift + tilt - 0.035, side), point(x0, s1, lift + tilt - 0.035, side)]
            polys = [[0, 1, 2, 3], [7, 6, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 5, 6, 2]]
            # One texture row (a quarter of the tile) per course, so every course shows whole shingles
            # with their butts at its lower edge. Each course starts at its own offset, so joints break
            # between courses and worn textures' missing units do not line up in a grid.
            v0, v1 = 1 - (k % 4) / 4, 1 - (k % 4 + 1) / 4 + 0.004
            shift = 0.5 * (k % 2) + 0.4 * rnd(key, "course", side, k)
            u0, u1 = x0 + shift, x1 + shift
            uvs = [(u0, v0), (u1, v0), (u1, v1), (u0, v1), (u0, v0), (u1, v0), (u1, v1 + 0.02), (u0, v1 + 0.02)]
            made = b.faces(pts, polys + [[1, 0, 4, 5]], roof, f"{key}/course{side}{k}", uvs=uvs)
            bmesh.ops.recalc_face_normals(b.bm, faces=made)
            # Hidden faces: the upper edge (under the course above) and the ends that meet the
            # neighbouring module; only a verge keeps its outer end.
            hidden = [made[1], made[5]] + [made[i] for i, xe in ((3, x0), (4, x1)) if xe != verge_end]
            bmesh.ops.delete(b.bm, geom=hidden, context="FACES_ONLY")
        # Roof boards underneath, the timber underside seen under the eaves.
        under = [point(x0, 0, 0.0, side), point(x1, 0, 0.0, side), point(x1, slope_len, 0.0, side), point(x0, slope_len, 0.0, side),
                 point(x0, 0, normal_off - 0.02, side), point(x1, 0, normal_off - 0.02, side), point(x1, slope_len, normal_off - 0.02, side), point(x0, slope_len, normal_off - 0.02, side)]
        made = b.faces(under, [[3, 2, 1, 0], [0, 1, 5, 4], [2, 3, 7, 6], [4, 5, 6, 7]], "wood", f"{key}/boards{side}", grain=(1, 0, 0))
        bmesh.ops.recalc_face_normals(b.bm, faces=made)
        # Fascia board along the eave.
        e0, e1 = point(x0, slope_len - 0.02, -0.06, side), point(x1, slope_len, normal_off + 0.04, side)
        lo = [x0, min(e0[1], e1[1]) - 0.02, min(e0[2], e1[2])]
        hi = [x1, max(e0[1], e1[1]) - 0.06, max(e0[2], e1[2]) + 0.0]
        b.block(lo, hi, "timber", 0.01, f"{key}/fascia{side}", grain=(1, 0, 0))
        # Rafter tails under the overhang, one per 0.5 m.
        step = 0.5
        x = math.floor(x0 / step) * step + step / 2
        while x < x1:
            if x - 0.05 >= x0 and x + 0.05 <= x1:
                a = point(x, HALF_SPAN / math.cos(PITCH) - 0.05, 0.0, side)
                c = point(x, slope_len - 0.04, 0.0, side)
                ring = [(a[1], a[2]), (c[1], c[2]), (c[1] - 0.12, c[2]), (a[1] - 0.12, a[2])]
                pts = [(x - 0.05, y, z) for y, z in ring] + [(x + 0.05, y, z) for y, z in ring]
                polys = [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]
                made = b.faces(pts, polys, "timber", f"{key}/rafter{side}{x:.2f}", grain=(0, -math.sin(PITCH), side * math.cos(PITCH)))
                bmesh.ops.recalc_face_normals(b.bm, faces=made)
            x += step
    # Ridge cap: two boards meeting over the ridge.
    top = UNDER_RIDGE + ROOF_T / math.cos(PITCH)
    for side in (-1, 1):
        outline = [(0.0, top + 0.07), (side * 0.2, top - 0.2 * math.tan(PITCH) + 0.0), (side * 0.2, top - 0.2 * math.tan(PITCH) - 0.05), (0.0, top + 0.01)]
        pts = [(x0, y, z) for z, y in outline] + [(x1, y, z) for z, y in outline]
        polys = [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]
        made = b.faces(pts, polys, "timber", f"{key}/ridge{side}", grain=(1, 0, 0))
        bmesh.ops.recalc_face_normals(b.bm, faces=made)
    if verge_end is not None:
        xb = verge_end
        for side in (-1, 1):
            a, c = point(xb, -0.05, normal_off + 0.05, side), point(xb, slope_len + 0.02, normal_off + 0.05, side)
            a2, c2 = point(xb, -0.05, -0.12, side), point(xb, slope_len + 0.02, -0.12, side)
            pts = [a, c, c2, a2]
            pts = [(xb - 0.05, p[1], p[2]) for p in pts] + [(xb + 0.0, p[1], p[2]) for p in pts]
            polys = [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]
            made = b.faces(pts, polys, "timber", f"{key}/barge{side}", grain=(0, -math.sin(PITCH), side * math.cos(PITCH)))
            bmesh.ops.recalc_face_normals(b.bm, faces=made)
    return top + 0.07


def build_roof(part, col, root, roof="shingle"):
    b = Builder(f"outpost.{part}.mesh")
    if part == "roof-verge":
        x0, x1 = 0.0, VERGE
        top = roof_slope(b, x0, x1, roof, part, verge_end=VERGE)
    else:
        length = MODULE if part == "roof" else MODULE / 2
        x0, x1 = -length / 2, length / 2
        top = roof_slope(b, x0, x1, roof, part)
    b.finish(col, root)
    run = HALF_SPAN + EAVE
    eave_y = roof_under(run) - 0.12
    info = {"roof": {"span": SPAN, "pitchDegrees": round(math.degrees(PITCH), 6), "eaveOverhang": EAVE,
                     "length": round(x1 - x0, 6), "wallTop": WALL_H, "ridgeTop": round(top, 6), "eaveHeight": round(eave_y, 6)},
            "collisionProxies": [proxy("roof", "roof", (x0, WALL_H, -HALF_SPAN), (x1, round(UNDER_RIDGE, 6), HALF_SPAN))]}
    if part == "roof-verge":
        info["roof"]["vergeOverhang"] = VERGE
    return info


def build_chimney(part, col, root):
    """An outside stone stack against a gable wall (outer face z = 0), clear above the ridge."""
    b = Builder(f"outpost.{part}.mesh")
    ridge = UNDER_RIDGE + ROOF_T / math.cos(PITCH) + 0.07
    top = ridge + 0.75
    b.block((-0.6, 0.0, -0.02), (0.6, 0.45, 0.82), "stone", 0.04, "chimney/foot")
    b.block((-0.52, 0.45, -0.02), (0.52, 2.6, 0.74), "stone", 0.03, "chimney/breast", grain=(1, 0, 0))
    # Sloped shoulders up to the stack.
    outline = [(-0.52, 2.6), (0.52, 2.6), (0.34, 3.1), (-0.34, 3.1)]
    b.prism(outline, -0.02, 0.74, "stone", "chimney/shoulder", grain=(1, 0, 0))
    b.block((-0.34, 3.1, -0.02), (0.34, top, 0.6), "stone", 0.03, "chimney/stack", grain=(1, 0, 0))
    b.block((-0.42, top, -0.08), (0.42, top + 0.12, 0.68), "stone", 0.03, "chimney/cap")
    b.block((-0.22, top + 0.12, 0.06), (0.22, top + 0.13, 0.46), "soot", 0.004, "chimney/flue")
    b.finish(col, root)
    smoke = (0.0, round(top + 0.13, 6), 0.26)
    empty("smoke", col, root, smoke)
    return {"smoke": {"node": "smoke", "position": r6(smoke)},
            "collisionProxies": [proxy("chimney", "solid", (-0.6, 0, -0.02), (0.6, top + 0.12, 0.82))]}


BUILDERS = {"wall": build_wall, "wall-half": build_wall, "wall-window": build_wall_window, "wall-door": build_wall_door,
            "door": build_door, "corner": build_corner, "gable": build_gable, "roof": build_roof, "roof-half": build_roof,
            "roof-verge": build_roof, "chimney": build_chimney}


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
    """Build one module under an empty root ``outpost.<part>`` at ``location`` (glTF axes), aged by
    ``wear`` in [0, 1]: 0 is the pristine kit, ``WEAR_PRESETS`` names the bundle's worn variants."""
    global WEAR
    if part not in BUILDERS:
        raise ValueError(f"outpost part must be one of {', '.join(PARTS)}")
    if roof not in ROOFS:
        raise ValueError(f"outpost roof must be one of {', '.join(ROOFS)}")
    if not 0 <= wear <= 1:
        raise ValueError("outpost wear must be in [0, 1]")
    WEAR = float(wear)
    root = bpy.data.objects.new(f"outpost.{part}", None)
    root.empty_display_size = 0.3
    collection.objects.link(root)
    builder = BUILDERS[part]
    info = builder(part, collection, root, roof) if part in ROOFED else builder(part, collection, root)
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
    if arguments["part"] not in PARTS:
        raise ValueError(f"outpost part must be one of {', '.join(PARTS)}")
    if "roof" in arguments and (arguments["part"] not in ROOFED or arguments["roof"] not in ROOFS):
        raise ValueError("outpost roof applies to roof modules only and must be shingle or slate")
    if set(inputs) != {"common"}:
        raise ValueError("outpost recipe takes exactly kit_common.py as its input 'common'")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_common(inputs.load_source("common"))
    part = arguments["part"]
    roof = arguments.get("roof", "shingle")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    wear = float(arguments.get("wear", 0))
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
