"""Climbing kit (#394): timber ladders, a knotted hanging rope and climbing ivy for mmorpg's climbable surfaces.

One run builds one part at one level of detail (``lod`` 0, 1 or 2) in the part's own frame: metres, glTF
right-handed +Y up, origin on the ground (or the joint) at the centre of the part's back, where it meets the face it
climbs. The climber faces the part from +Z. The parts match the Ranger's traversal clips (asset-tooling#416/#443,
``adapters/blender/traversal_clips.py``):

- ladders: two rails 0.6 m wide over all, 0.1 m deep (z 0..0.1), round rungs 38 mm thick every 0.30 m
  (``Ladder_*``: ``rungSpacingMeters`` 0.3, the rung plane 0.36 m in front of the pelvis, the hands wrapping rungs
  0.19 m either side of the centre). ``ladder-3m``/``-6m``/``-9m`` stand on the ground with the first rung at 0.3 m.
  ``ladder-section`` is a 1.2 m tile (rungs at 0.15, 0.45, 0.75 and 1.05 m) that stacks to any height on the same
  pitch; ``ladder-top`` continues it with two rungs and hooks the rails back over a parapet whose top is at 1.0 m;
- ropes: a 50 mm three-strand rope, its axis 0.30 m in front of the face (``Rope_*``: the rope 0.30 m in front of
  the pelvis), with a knot every 0.6 m, hanging from an iron ring on a timber beam stub. ``rope-4m``/``-8m``/``-12m``
  are whole ropes from the ground to the beam; ``rope-section`` (1.2 m, two knots), ``rope-anchor`` (the beam, ring
  and rope down to y = 0) and ``rope-end`` (the stopper knot and frayed tail up to y = 0.6) stack to any height;
- vines: climbing ivy on a face, about 1 m wide, stems and cut-out leaf cards. ``vine-strip`` is a 2 m tile that
  repeats vertically without a seam, ``vine-top`` its ragged upper end, ``vine-3m``/``-6m`` whole covers rooted on
  the ground. The declared input ``leaves`` is the CC0 Quaternius ``T_VineLeaf`` ivy-leaf cluster, a grey mask whose
  colour comes from ``COLOR_0``, like the Greyhaven bushes (#462).

Each part carries two empty nodes, ``climb.bottom`` and ``climb.top``, at the ends of its grip line (the rung centre
line, the rope's axis, or the face's centre line), and returns its ``climb`` metadata and box ``collisionProxies``.
The textures (wood, rope, ivy stem) are generated here with numpy and tile; iron is a plain factor.

No randomness: variation comes from a SHA-256 of fixed keys (``rnd``). ``build(part, lod, collection, leaves)``
also works in a live Blender session after ``use_common(runpy.run_path('kit_common.py'))``; ``generate`` is the
script-backend entry point.
"""
import math

import bpy
import numpy as np
from mathutils import Vector

LADDERS = {"ladder-3m": 3.0, "ladder-6m": 6.0, "ladder-9m": 9.0}
ROPES = {"rope-4m": 4.0, "rope-8m": 8.0, "rope-12m": 12.0}
VINES = {"vine-3m": 3.0, "vine-6m": 6.0}
PARTS = (*LADDERS, "ladder-section", "ladder-top", *ROPES, "rope-section", "rope-anchor", "rope-end",
         "vine-strip", "vine-top", *VINES)
LODS = (0, 1, 2)

# Ladder: rungs every RUNG metres (the clips' rungSpacingMeters), rails 0.6 m over all and DEPTH deep.
RUNG = 0.30
LADDER = {"width": 0.6, "depth": 0.1, "rail": (0.065, 0.09), "rungRadius": 0.019, "tile": 1.2, "parapet": 1.0}
# Rope: radius, distance of its axis from the face, knot pitch and knot bulge; the beam stub that holds the ring.
ROPE = {"radius": 0.025, "standOff": 0.30, "knot": 0.6, "knotRadius": 0.046, "knotLength": 0.11, "tile": 1.2,
        "beam": 0.16, "ring": 0.075, "ringWire": 0.013}
VINE = {"width": 1.0, "tile": 2.0, "depth": 0.14}
# The clips' stand-off: the rung plane, rope or face is this far in front of the pelvis (traversal_clips.py).
STAND_OFF = {"ladder": 0.36, "rope": 0.30, "face": 0.36}
CLIPS = {"ladder": "Ladder_*", "rope": "Rope_*", "face": "Climb_*"}
TEXTURE = 512
SHARP_ANGLE = math.radians(40)

# name: (sRGB base colour factor, metallic, roughness, texture or None, alpha cut-out)
MATERIALS = {
    "wood": ((1, 1, 1), 0.0, 1.0, "wood", False),
    "endgrain": ((0.62, 0.52, 0.42), 0.0, 1.0, "wood", False),
    "iron": ((0.23, 0.22, 0.21), 1.0, 0.55, None, False),
    "rope": ((1, 1, 1), 0.0, 1.0, "rope", False),
    "stem": ((1, 1, 1), 0.0, 1.0, "stem", False),
    "leaf": ((1, 1, 1), 0.0, 0.62, "leaf", True),
}
# The ivy palette (linear), deep near the face and low down, glossy mid green, a yellow-green on young tips.
IVY_SHADE = (0.025, 0.06, 0.02)
IVY_MID = (0.06, 0.14, 0.035)
IVY_SUN = (0.15, 0.26, 0.05)
IVY_YOUNG = (0.27, 0.36, 0.08)


def use_common(common):
    """Bind kit_common.py's shared helpers (the declared Python input ``common``) into this module."""
    globals().update({name: common[name] for name in common["NAMES"]})


def lerp(a, b, t):
    return a + (b - a) * t


def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def smoothstep(e0, e1, v):
    t = clamp((v - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)


def mix3(a, b, t):
    return tuple(lerp(a[k], b[k], t) for k in range(3))


# ---------------------------------------------------------------- textures (numpy, tileable)

def wood_maps(size):
    """Weathered pine, grain along V (the length of a rail or rung), 0.6 m per tile."""
    streak = fbm(size, 2, 4, 3941, stretch=(14, 1))
    lines = fbm(size, 4, 3, 3942, stretch=(40, 1))
    ring = np.abs(np.sin(lines * 38.0))
    crack = np.clip((fbm(size, 3, 3, 3943, stretch=(30, 1)) - 0.72) * 8, 0, 1)
    height = streak * 0.5 + ring * 0.3 + lines * 0.2 - crack * 0.6
    shade = 0.9 + (streak - 0.5) * 0.5 - ring * 0.12 - crack * 0.35
    base = np.array([0.5, 0.39, 0.27])
    colour = np.clip(base * shade[..., None], 0, 1)
    ao = np.clip(1 - ring * 0.15 - crack * 0.5, 0, 1)
    rough = np.clip(0.8 + ring * 0.1 + crack * 0.1, 0, 1)
    return colour, normal_map(height, 2.2), np.stack([ao, rough, np.zeros_like(ao)], -1)


def rope_maps(size):
    """Three-strand hemp: U runs round the rope, V along one lay (0.15 m); each strand turns once per tile."""
    u = np.arange(size) / size
    v = np.arange(size) / size
    phase = (3 * u[None, :] + 3 * v[:, None]) % 1.0  # rows are V, columns U
    strand = np.sin(np.pi * phase) ** 0.6  # rounded strand, a dark groove between strands
    fibre = fbm(size, 8, 3, 3951, stretch=(1, 6))
    fine = fbm(size, 48, 2, 3952)
    height = strand * 0.8 + fibre * 0.15 + fine * 0.05
    shade = 0.62 + strand * 0.42 + (fibre - 0.5) * 0.22 + (fine - 0.5) * 0.1
    base = np.array([0.56, 0.46, 0.31])
    colour = np.clip(base * shade[..., None], 0, 1)
    ao = np.clip(0.45 + strand * 0.55, 0, 1)
    rough = np.clip(0.88 + (fine - 0.5) * 0.1, 0, 1)
    return colour, normal_map(height, 5.0), np.stack([ao, rough, np.zeros_like(ao)], -1)


def stem_maps(size):
    """Grey-brown ivy bark with fine climbing rootlets, along V."""
    streak = fbm(size, 3, 4, 3961, stretch=(10, 1))
    fine = fbm(size, 32, 3, 3962)
    rootlets = np.clip((fbm(size, 24, 2, 3963, stretch=(1, 3)) - 0.6) * 4, 0, 1)
    height = streak * 0.6 + fine * 0.2 + rootlets * 0.4
    shade = 0.85 + (streak - 0.5) * 0.4 + (fine - 0.5) * 0.2 - rootlets * 0.2
    base = np.array([0.36, 0.3, 0.23])
    colour = np.clip(base * shade[..., None], 0, 1)
    ao = np.clip(1 - rootlets * 0.3, 0, 1)
    rough = np.clip(0.85 + (fine - 0.5) * 0.1, 0, 1)
    return colour, normal_map(height, 2.0), np.stack([ao, rough, np.zeros_like(ao)], -1)


def leaf_image(path):
    """The ivy-leaf cluster as a bright grey mask, the way the bushes treat their leaves: COLOR_0 sets the hue.
    The leaf veins come through as a little darker grey."""
    existing = bpy.data.images.get("climbing-leaf")
    if existing is not None:
        return existing
    source = bpy.data.images.load(path)
    w, h = source.size
    px = np.array(source.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(source)
    lum = px[..., 0] * 0.2126 + px[..., 1] * 0.7152 + px[..., 2] * 0.0722
    solid = px[..., 3] > 0.5
    hi = np.quantile(lum[solid], 0.97) if solid.any() else 1.0
    g = np.where(px[..., 3] > 0.02, np.clip(lum / hi, 0, 1), 0.85)
    g = 0.6 + 0.4 * g
    out = np.stack([g, g, g, px[..., 3]], -1).astype(np.float32)
    image = bpy.data.images.new("climbing-leaf", w, h, alpha=True)
    image.pixels.foreach_set(out.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


MAPS = {"wood": wood_maps, "rope": rope_maps, "stem": stem_maps}


def material(name, leaves=None):
    existing = bpy.data.materials.get(f"climbing-{name}")
    if existing is not None:
        return existing
    colour, metallic, roughness, texture, cutout = MATERIALS[name]
    mat = bpy.data.materials.new(f"climbing-{name}")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    linear = tuple(srgb_to_linear(c) for c in colour) + (1,)
    bsdf.inputs["Base Color"].default_value = linear
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    mat.use_backface_culling = not cutout
    # COLOR_0 tints every textured material (a glTF viewer multiplies it in), so the shader does the same.
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    if texture is None:
        mul = nodes.new("ShaderNodeMix")
        mul.data_type, mul.blend_type = "RGBA", "MULTIPLY"
        mul.inputs[0].default_value = 1.0
        mul.inputs[6].default_value = linear
        links.new(attr.outputs["Color"], mul.inputs[7])
        links.new(mul.outputs[2], bsdf.inputs["Base Color"])
        return mat
    if texture == "leaf":
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = leaf_image(leaves)
        mul = nodes.new("ShaderNodeMix")
        mul.data_type, mul.blend_type = "RGBA", "MULTIPLY"
        mul.inputs[0].default_value = 1.0
        links.new(tex.outputs["Color"], mul.inputs[6])
        links.new(attr.outputs["Color"], mul.inputs[7])
        links.new(mul.outputs[2], bsdf.inputs["Base Color"])
        # Round(alpha) exports as glTF alphaMode MASK.
        rnd_node = nodes.new("ShaderNodeMath")
        rnd_node.operation = "ROUND"
        links.new(tex.outputs["Alpha"], rnd_node.inputs[0])
        links.new(rnd_node.outputs[0], bsdf.inputs["Alpha"])
        return mat
    images = []
    for kind, data in zip(("color", "normal", "orm"), MAPS[texture](TEXTURE)):
        image = bpy.data.images.get(f"climbing-{texture}-{kind}") or make_image(f"climbing-{texture}-{kind}", data, kind == "color")
        images.append(image)
    tex = []
    for image in images:
        node = nodes.new("ShaderNodeTexImage")
        node.image = image
        tex.append(node)
    mul = nodes.new("ShaderNodeMix")
    mul.data_type, mul.blend_type = "RGBA", "MULTIPLY"
    mul.inputs[0].default_value = 1.0
    links.new(tex[0].outputs["Color"], mul.inputs[6])
    links.new(attr.outputs["Color"], mul.inputs[7])
    if colour != (1, 1, 1):
        tint = nodes.new("ShaderNodeMix")
        tint.data_type, tint.blend_type = "RGBA", "MULTIPLY"
        tint.inputs[0].default_value = 1.0
        links.new(mul.outputs[2], tint.inputs[6])
        tint.inputs[7].default_value = linear
        links.new(tint.outputs[2], bsdf.inputs["Base Color"])
    else:
        links.new(mul.outputs[2], bsdf.inputs["Base Color"])
    nmap = nodes.new("ShaderNodeNormalMap")
    links.new(tex[1].outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    sep = nodes.new("ShaderNodeSeparateColor")
    links.new(tex[2].outputs["Color"], sep.inputs["Color"])
    links.new(sep.outputs[1], bsdf.inputs["Roughness"])
    links.new(sep.outputs[2], bsdf.inputs["Metallic"])
    return mat


# ---------------------------------------------------------------- mesh builder (glTF axes)

class Mesh:
    """One mesh in glTF axes: per face a material, per corner a UV, a colour and optionally a custom normal."""

    def __init__(self, name):
        self.name = name
        self.verts, self.faces = [], []

    def add(self, points):
        base = len(self.verts)
        self.verts.extend(Vector(p) for p in points)
        return base

    def face(self, idx, mat, uvs, colour=(1, 1, 1), normals=None, smooth=True):
        cols = colour if isinstance(colour, list) else [colour] * len(idx)
        if len(idx) > 4:
            # Fan a convex cap into triangles: the exporter's MikkTSpace takes triangles and quads only.
            for k in range(1, len(idx) - 1):
                pick = [0, k, k + 1]
                self.faces.append((tuple(idx[i] for i in pick), mat, [uvs[i] for i in pick], [cols[i] for i in pick],
                                   [normals[i] for i in pick] if isinstance(normals, list) else normals, smooth))
            return
        self.faces.append((tuple(idx), mat, list(uvs), cols, normals, smooth))

    def sweep(self, path, profile, mat, v_tile, colour=(1, 1, 1), closed=False, caps=(False, False), up=(0, 0, 1),
              scale=None, cap_mat=None, u_tile=1.0, smooth=True):
        """Sweep the closed 2D ``profile`` [(side, normal)] along ``path`` (glTF points). ``scale(i)`` widens
        ring i; ``closed`` joins the last ring to the first. U runs round the profile (``u_tile`` turns per tile),
        V along the path in tiles of ``v_tile`` metres. ``colour`` is one RGB or a function of the ring index."""
        n, m = len(path), len(profile)
        frames = []
        prev = Vector(up)
        for i in range(n):
            a = Vector(path[max(i - 1, 0)] if not closed else path[(i - 1) % n])
            b = Vector(path[min(i + 1, n - 1)] if not closed else path[(i + 1) % n])
            t = (b - a).normalized()
            side = prev.cross(t)
            if side.length < 1e-6:
                side = Vector((1, 0, 0)).cross(t)
            side.normalize()
            normal = t.cross(side).normalized()
            prev = normal
            frames.append((side, normal))
        rings, s, lengths = [], 0.0, []
        for i in range(n):
            if i:
                s += (Vector(path[i]) - Vector(path[i - 1])).length
            lengths.append(s)
            side, normal = frames[i]
            k = scale(i) if scale else 1.0
            rings.append(self.add([Vector(path[i]) + side * (p[0] * k) + normal * (p[1] * k) for p in profile]))
        col = (lambda i: colour(i)) if callable(colour) else (lambda i: colour)
        segments = n if closed else n - 1
        for i in range(segments):
            j = (i + 1) % n
            v0, v1 = lengths[i] / v_tile, (lengths[i] + (Vector(path[j]) - Vector(path[i])).length) / v_tile
            for q in range(m):
                r = (q + 1) % m
                u0, u1 = q / m * u_tile, (q + 1) / m * u_tile
                self.face((rings[i] + q, rings[i] + r, rings[j] + r, rings[j] + q), mat,
                          [(u0, v0), (u1, v0), (u1, v1), (u0, v1)], [col(i), col(i), col(j), col(j)], smooth=smooth)
        if not closed:
            for end, ring, flip in ((0, rings[0], True), (1, rings[-1], False)):
                if not caps[end]:
                    continue
                idx = [ring + q for q in range(m)]
                if flip:
                    idx.reverse()
                uvs = [(0.5 + 0.5 * profile[q][0] / 0.05, 0.5 + 0.5 * profile[q][1] / 0.05) for q in range(m)]
                if flip:
                    uvs.reverse()
                self.face(idx, cap_mat or mat, uvs, col(0 if end == 0 else n - 1), smooth=False)
        return rings

    def box(self, lo, hi, mat, tile=0.6, colour=(1, 1, 1), grain=1):
        """An axis-aligned box; on its long faces the texture's V runs along axis ``grain`` (0 x, 1 y, 2 z)."""
        x0, y0, z0 = lo
        x1, y1, z1 = hi
        corners = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        base = self.add(corners)
        quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 4, 7, 3), (1, 2, 6, 5), (0, 1, 5, 4), (3, 7, 6, 2)]
        for quad in quads:
            pts = [corners[k] for k in quad]
            axes = [k for k in range(3) if len({round(p[k], 9) for p in pts}) > 1]
            ua, va = (axes[0], axes[1]) if axes[1] == grain else (axes[1], axes[0]) if axes[0] == grain else (axes[0], axes[1])
            self.face([base + k for k in quad], mat, [(p[ua] / tile, p[va] / tile) for p in pts], colour, smooth=False)

    def finish(self, collection, parent, materials):
        mesh = bpy.data.meshes.new(f"{self.name}-geometry")
        blender = [Vector((p.x, -p.z, p.y)) for p in self.verts]
        mesh.from_pydata(blender, [], [f[0] for f in self.faces])
        mesh.update()
        uv = mesh.uv_layers.new(name="UVMap")
        col = mesh.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
        order = {}
        for name in materials:
            order[name] = len(mesh.materials)
            mesh.materials.append(materials[name])
        custom = []
        any_custom = False
        for poly, (idx, mat, uvs, cols, normals, smooth) in zip(mesh.polygons, self.faces):
            poly.material_index = order[mat]
            poly.use_smooth = smooth
            for k, loop in enumerate(poly.loop_indices):
                uv.data[loop].uv = uvs[k]
                c = cols[k]
                col.data[loop].color = (c[0], c[1], c[2], 1.0)
            for k in range(len(idx)):
                if normals is not None:
                    n = normals[k] if isinstance(normals, list) else normals
                    custom.append(Vector((n[0], -n[2], n[1])).normalized())
                    any_custom = True
                else:
                    custom.append(None)
        mesh.color_attributes.active_color = col
        mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
        if any_custom:
            mesh.update()
            mesh.set_sharp_from_angle(angle=SHARP_ANGLE)
            corner = mesh.corner_normals
            mesh.normals_split_custom_set([tuple(c) if c is not None else tuple(corner[i].vector) for i, c in enumerate(custom)])
        else:
            mesh.set_sharp_from_angle(angle=SHARP_ANGLE)
        obj = bpy.data.objects.new(self.name, mesh)
        collection.objects.link(obj)
        obj.parent = parent
        return obj


def circle(r, sides, phase=0.5):
    return [(r * math.cos(2 * math.pi * (q + phase) / sides), r * math.sin(2 * math.pi * (q + phase) / sides)) for q in range(sides)]


def chamfered(w, d, c):
    """A w x d rectangle (side x normal) with c-metre chamfers, counter-clockwise."""
    hw, hd = w / 2, d / 2
    return [(hw, -hd + c), (hw, hd - c), (hw - c, hd), (-hw + c, hd), (-hw, hd - c), (-hw, -hd + c), (-hw + c, -hd), (hw - c, -hd)]


def wood_tint(*keys, low=0.82, high=1.06):
    t = lerp(low, high, rnd(*keys))
    warm = 0.03 * (rnd(*keys, "warm") - 0.5)
    return (t * (1 + warm), t, t * (1 - warm))


def grime(y, tint=(1, 1, 1), ground=True):
    """Darker and greener near the ground, where rain splashes and moss starts."""
    if not ground:
        return tint
    g = smoothstep(0.6, 0.0, y)
    return (tint[0] * (1 - 0.35 * g), tint[1] * (1 - 0.25 * g), tint[2] * (1 - 0.4 * g))


# ---------------------------------------------------------------- ladders

def ladder_rungs(part):
    """Rung heights of a ladder part."""
    if part in LADDERS:
        length = LADDERS[part]
        return [round(RUNG * (k + 1), 6) for k in range(int(round(length / RUNG)) - 1)]
    if part == "ladder-section":
        return [round(RUNG / 2 + RUNG * k, 6) for k in range(4)]
    return [round(RUNG / 2, 6), round(RUNG / 2 + RUNG, 6)]  # ladder-top


def rail_path(part, x, lod):
    """The centre line of one rail: straight, or for the top cap over the parapet and down behind it."""
    d = LADDER["depth"]
    if part in LADDERS:
        return [(x, 0.0, d / 2), (x, LADDERS[part], d / 2)]
    if part == "ladder-section":
        return [(x, 0.0, d / 2), (x, LADDER["tile"], d / 2)]
    # The top cap: up past the parapet top, an arc of radius r back over it, down 0.25 m behind the face.
    top, r = LADDER["parapet"] + 0.12, 0.22
    steps = (10, 6, 3)[lod]
    path = [(x, 0.0, d / 2), (x, top, d / 2)]
    cz = d / 2 - r
    for k in range(1, steps + 1):
        a = math.pi * k / steps
        path.append((x, top + r * math.sin(a), cz + r * math.cos(a)))
    path.append((x, top - 0.25, d / 2 - 2 * r))
    return path


def build_ladder(part, lod, col, root, leaves):
    m = Mesh(f"climbing.{part}.mesh")
    w, d = LADDER["width"], LADDER["depth"]
    rw, rd = LADDER["rail"]
    rx = w / 2 - rw / 2
    rungs = ladder_rungs(part)
    ground = part in LADDERS or part == "ladder-section"
    for side in (-1, 1):
        x = side * rx
        path = rail_path(part, x, lod)
        profile = chamfered(rw, rd, 0.008) if lod == 0 else [(rw / 2, -rd / 2), (rw / 2, rd / 2), (-rw / 2, rd / 2), (-rw / 2, -rd / 2)]
        tint = wood_tint(part, "rail", side)
        m.sweep(path, [(p[0], p[1]) for p in profile], "wood", 0.6, colour=lambda i, p=path, t=tint: grime(p[i][1], t, ground),
                caps=(True, True), up=(0, 0, 1), cap_mat="endgrain", u_tile=0.5, smooth=False)
    sides = (10, 6, 4)[lod]
    r = LADDER["rungRadius"]
    for k, y in enumerate(rungs):
        # Each rung runs through both rails; at LOD0 its tenon ends show 1 cm proud of the rails.
        reach = w / 2 + (0.01 if lod == 0 else -rw / 2)
        tint = wood_tint(part, "rung", k, low=0.86, high=1.1)
        # Worn lighter on top where hands and boots rub.
        prof = circle(r, sides)
        m.sweep([(-reach, y, d / 2), (reach, y, d / 2)], prof, "wood", 0.6, colour=grime(y, tint, ground),
                caps=(lod == 0, lod == 0), up=(0, 1, 0), cap_mat="endgrain", smooth=True)
        if lod == 0:
            # A wedge nail through each rail into the rung.
            for side in (-1, 1):
                m.box((side * rx - 0.006, y - 0.006, d - 0.004), (side * rx + 0.006, y + 0.006, d + 0.003), "iron", colour=(1, 1, 1))
    if part in LADDERS and lod == 0:
        # Rounded rail tops: a short iron cap band at the head of each rail.
        for side in (-1, 1):
            m.sweep([(side * rx, LADDERS[part] - 0.07, d / 2), (side * rx, LADDERS[part] - 0.04, d / 2)],
                    [(p[0] * 1.08, p[1] * 1.08) for p in chamfered(rw, rd, 0.008)], "iron", 1.0, smooth=False)
    m.finish(col, root, {name: material(name) for name in ("wood", "endgrain", "iron")})
    top = rungs[-1]
    height = LADDERS.get(part, LADDER["tile"] if part == "ladder-section" else LADDER["parapet"] + 0.12 + 0.22)
    climb = {
        "grip": "ladder", "clips": CLIPS["ladder"], "approach": "+Z", "standOff": STAND_OFF["ladder"],
        "gripLine": {"from": [0, rungs[0], d / 2], "to": [0, top, d / 2]},
        "rungs": {"spacing": RUNG, "first": rungs[0], "count": len(rungs), "radius": r, "span": round(w - 2 * rw, 6),
                  "z": d / 2},
    }
    if part == "ladder-section":
        climb["tile"] = {"axis": "+Y", "pitch": LADDER["tile"]}
    if part == "ladder-top":
        climb["topOut"] = {"parapetTop": LADDER["parapet"], "hooks": "-Z",
                           "note": "Place the cap on the last section; the rails hook over a parapet whose top is at y = parapetTop."}
    proxies = [proxy("ladder", "climbable", (-w / 2, 0.0, 0.0), (w / 2, min(height, LADDER["parapet"] + 0.12), d))]
    return {"footprint": {"width": w, "depth": d, "height": round(height, 6)}, "climb": climb, "collisionProxies": proxies,
            "gripEnds": ((0, rungs[0], d / 2), (0, top, d / 2))}


# ---------------------------------------------------------------- ropes

def rope_profile(y, knots, lod):
    """The rope's radius at height y: a smooth bulge at each knot."""
    r = ROPE["radius"]
    best = 0.0
    for k in knots:
        t = abs(y - k) / (ROPE["knotLength"] / 2)
        if t < 1:
            best = max(best, (1 - t * t) ** 1.5)
    return r + (ROPE["knotRadius"] - r) * best


def rope_strand(m, y0, y1, knots, lod, key, taper=None):
    """A plumb rope from y0 to y1 on its axis (x 0, z standOff), V in 0.15 m lays continuous in absolute y."""
    z = ROPE["standOff"]
    sides = (10, 6, 4)[lod]
    step = (0.06, 0.15, 0.3)[lod]
    ys = [y0]
    y = y0
    while y < y1 - 1e-6:
        y = min(y1, y + step)
        ys.append(y)
    # Rings on each knot's flanks and crest, so the bulge reads at every level.
    for k in knots:
        if y0 < k < y1:
            for off in (-0.5, -0.25, 0.0, 0.25, 0.5) if lod < 2 else (0.0,):
                ys.append(k + off * ROPE["knotLength"])
    ys = sorted({round(v, 5) for v in ys if y0 - 1e-9 <= v <= y1 + 1e-9})
    path = [(0.0, v, z) for v in ys]

    def scale(i):
        r = rope_profile(ys[i], knots, lod)
        if taper:
            r *= taper(ys[i])
        return r / ROPE["radius"]

    tint = wood_tint(key, "rope", low=0.92, high=1.04)
    # V starts at the absolute height of y0 so stacked pieces continue the lay.
    rings = m.sweep(path, circle(ROPE["radius"], sides, 0.0), "rope", 0.15, colour=lambda i: grime(ys[i], tint, ys[0] < 0.5),
                    scale=scale, up=(0, 0, 1), smooth=True)
    for f in range(len(m.faces) - (len(ys) - 1) * sides, len(m.faces)):
        idx, mat, uvs, cols, normals, smooth = m.faces[f]
        m.faces[f] = (idx, mat, [(u, v + y0 / 0.15) for u, v in uvs], cols, normals, smooth)
    return rings


def rope_knots(y0, y1, phase=0.3):
    """Knot heights every ROPE["knot"] metres, on the absolute grid phase + k * knot."""
    out = []
    k = math.ceil((y0 - phase) / ROPE["knot"] - 1e-9)
    while phase + k * ROPE["knot"] < y1 - 1e-9:
        y = phase + k * ROPE["knot"]
        if y0 + 0.08 < y < y1 - 0.08:
            out.append(round(y, 6))
        k += 1
    return out


def rope_anchor(m, y_ring, lod):
    """A timber beam stub out of the face above the rope, an iron eye and ring, the rope looped through it."""
    z = ROPE["standOff"]
    b = ROPE["beam"]
    beam_y = y_ring + ROPE["ring"] + 0.03
    end = z + 0.14
    m.box((-b / 2, beam_y, -0.05), (b / 2, beam_y + b, end), "wood", tile=0.6, colour=wood_tint("beam", low=0.7, high=0.8), grain=2)
    # Iron strap round the beam's end.
    if lod < 2:
        m.box((-b / 2 - 0.006, beam_y - 0.006, end - 0.1), (b / 2 + 0.006, beam_y + b + 0.006, end - 0.06), "iron")
    # The eye bolt under the beam and the ring hanging from it, in the plane x = 0.
    ring_sides, wire = ((20, 8), (12, 5), (8, 4))[lod]
    rr, rw = ROPE["ring"], ROPE["ringWire"]
    centre_y = y_ring + rr * 0.0
    path = [(0.0, centre_y + rr * math.cos(2 * math.pi * k / ring_sides), z + rr * math.sin(2 * math.pi * k / ring_sides))
            for k in range(ring_sides)]
    m.sweep(path, circle(rw, wire), "iron", 1.0, closed=True, up=(1, 0, 0), smooth=True)
    m.sweep([(0.0, centre_y + rr - 0.01, z), (0.0, beam_y + 0.01, z)], circle(0.009, wire), "iron", 1.0, up=(0, 0, 1), smooth=True)
    # The rope rises from the joint, loops over the ring's bottom wire (through the ring) and its tail runs back
    # down beside it, lashed to it below the ring.
    sides = (10, 6, 4)[lod]
    loop = (12, 7, 4)[lod]
    rope_r = ROPE["radius"] * 0.9
    lr = rw + rope_r
    wire_y = centre_y - rr
    path = [(0.0, y_ring - 0.16, z), (-0.6 * lr, wire_y - 0.06, z)]
    for k in range(loop + 1):
        a = math.pi - math.pi * k / loop
        path.append((lr * math.cos(a), wire_y + lr * math.sin(a), z))
    path += [(0.6 * lr, wire_y - 0.06, z), (0.022, y_ring - 0.17, z)]
    m.sweep(path, circle(rope_r, sides, 0.0), "rope", 0.15, up=(0, 0, 1), smooth=True, caps=(False, True))
    # The lashing: a whipped band binding the tail to the standing part.
    if lod < 2:
        m.sweep([(0.011, y_ring - 0.15, z), (0.011, y_ring - 0.09, z)], circle(0.038, sides),
                "rope", 0.05, smooth=True, caps=(True, True), u_tile=2.0)
    return beam_y + b


def rope_end(m, lod):
    """The stopper knot and frayed tail; the rope above starts at y = 0.6."""
    z = ROPE["standOff"]
    tip = 0.18
    stopper = 0.3

    def taper(y):
        return 1.0 if y > tip + 0.04 else lerp(0.75, 1.0, (y - tip) / 0.04)

    rope_strand(m, tip, 0.6, [stopper], lod, "end", taper=taper)
    if lod < 2:
        # Frayed fibres: thin tapering tufts spreading from the whipped tip.
        tufts = (9, 5)[lod]
        for k in range(tufts):
            a = 2 * math.pi * (k + 0.3 * rnd("tuft", k)) / tufts
            length = 0.07 + 0.06 * rnd("tuft", k, "l")
            spread = 0.012 + 0.012 * rnd("tuft", k, "s")
            start = (0.012 * math.cos(a), tip + 0.01, z + 0.012 * math.sin(a))
            endp = (start[0] + spread * math.cos(a), tip - length, start[2] + spread * math.sin(a))
            mid = tuple(lerp(start[i], endp[i], 0.5) for i in range(3))
            m.sweep([start, mid, endp], circle(0.006, 4), "rope", 0.15, scale=lambda i: (1.0, 0.7, 0.15)[i], up=(1, 0, 0),
                    colour=grime(0.0, (0.9, 0.86, 0.8)))
        # A whipping band at the tip.
        m.sweep([(0.0, tip + 0.005, z), (0.0, tip + 0.035, z)], circle(ROPE["radius"] * 0.85, (10, 6)[lod]), "rope", 0.05,
                u_tile=2.0, colour=(0.7, 0.64, 0.55))
    return tip - 0.13


def build_rope(part, lod, col, root, leaves):
    m = Mesh(f"climbing.{part}.mesh")
    z = ROPE["standOff"]
    climb = {"grip": "rope", "clips": CLIPS["rope"], "approach": "+Z", "standOff": STAND_OFF["rope"], "radius": ROPE["radius"]}
    proxies = []
    if part in ROPES:
        length = ROPES[part]
        y_ring = length - (ROPE["ring"] + 0.03 + ROPE["beam"])
        bottom = rope_end(m, lod)
        rope_strand(m, 0.6, y_ring - 0.16, rope_knots(0.6, y_ring - 0.16), lod, part)
        top = rope_anchor(m, y_ring, lod)
        knots = [0.3] + rope_knots(0.6, y_ring - 0.16)
        grip = (0.18, y_ring - 0.16)
        height = top
        proxies.append(proxy("beam", "solid", (-ROPE["beam"] / 2, y_ring + ROPE["ring"] + 0.03, 0.0),
                             (ROPE["beam"] / 2, top, z + 0.14)))
    elif part == "rope-section":
        knots = rope_knots(0.0, ROPE["tile"])
        rope_strand(m, 0.0, ROPE["tile"], knots, lod, part)
        grip, height, bottom = (0.0, ROPE["tile"]), ROPE["tile"], 0.0
        climb["tile"] = {"axis": "+Y", "pitch": ROPE["tile"]}
    elif part == "rope-anchor":
        # The ring sits 0.16 m above the joint at y = 0.
        y_ring = 0.16
        top = rope_anchor(m, y_ring, lod)
        knots, grip, height, bottom = [], (0.0, 0.0), top, 0.0
        climb["joins"] = {"below": "rope-section", "at": 0.0}
        proxies.append(proxy("beam", "solid", (-ROPE["beam"] / 2, y_ring + ROPE["ring"] + 0.03, 0.0),
                             (ROPE["beam"] / 2, top, z + 0.14)))
    else:  # rope-end
        bottom = rope_end(m, lod)
        knots, grip, height = [0.3], (0.18, 0.6), 0.6
        climb["joins"] = {"above": "rope-section", "at": 0.6}
    climb["gripLine"] = {"from": [0, round(grip[0], 6), z], "to": [0, round(grip[1], 6), z]}
    climb["knots"] = [round(k, 6) for k in knots]
    if grip[1] > grip[0]:
        proxies.insert(0, proxy("rope", "climbable", (-0.04, max(bottom, 0.0), z - 0.04), (0.04, grip[1], z + 0.04)))
    m.finish(col, root, {name: material(name) for name in ("rope", "wood", "iron")})
    return {"footprint": {"width": ROPE["beam"] if part != "rope-section" and part != "rope-end" else 2 * ROPE["knotRadius"],
                          "depth": round(z + 0.14, 6), "height": round(height, 6)},
            "climb": climb, "collisionProxies": proxies, "gripEnds": ((0, grip[0], z), (0, grip[1], z))}


# ---------------------------------------------------------------- vines

def stem_x(i, y, period):
    """Main stem i's x at height y, periodic in ``period``."""
    x0 = (-0.33, -0.1, 0.12, 0.34)[i] + 0.06 * (rnd("stem", i, "x") - 0.5)
    w = 2 * math.pi / period
    a1, a2 = 0.07 + 0.05 * rnd("stem", i, "a1"), 0.03 + 0.03 * rnd("stem", i, "a2")
    p1, p2 = 2 * math.pi * rnd("stem", i, "p1"), 2 * math.pi * rnd("stem", i, "p2")
    return x0 + a1 * math.sin(w * y + p1) + a2 * math.sin(2 * w * y + p2)


def vine_layout(part):
    """(height, periodic, rooted, stem ends): a strip tiles; the top thins out; whole covers root on the ground."""
    if part == "vine-strip":
        return VINE["tile"], True, False, [VINE["tile"]] * 4
    if part == "vine-top":
        return 1.0, True, False, [0.55 + 0.4 * rnd("top", i) for i in range(4)]
    h = VINES[part]
    return h, False, True, [h - 0.15 - 0.55 * rnd(part, "end", i) for i in range(4)]


def stem_path(i, part, height, rooted, end, step):
    """Points (glTF) of main stem i from y = 0 to its end, hugging the face."""
    pts = []
    n = max(2, int(math.ceil(end / step)))
    root_x = 0.05 * (i - 1.5)
    for k in range(n + 1):
        y = end * k / n
        x = stem_x(i, y, VINE["tile"])
        if rooted:
            x = lerp(root_x, x, smoothstep(0.0, 0.9, y))
        zz = 0.018 + 0.006 * math.sin(7.3 * y + i)
        pts.append((x, y, zz))
    return pts


def vine_branches(part, height, rooted, ends, periodic):
    """Side shoots: (start point, direction, length) off the main stems."""
    out = []
    count = int(round(height * 7))
    for k in range(count):
        i = int(rnd(part if not periodic else "strip", "branch", k, "s") * 4) % 4
        y = (k + rnd(part if not periodic else "strip", "branch", k, "y")) / count * height
        if part == "vine-top":
            y = rnd("top", "branch", k) * ends[i]
        if y > ends[i] - 0.1 or (rooted and y < 0.3):
            continue
        x = stem_x(i, y, VINE["tile"])
        if rooted:
            x = lerp(0.05 * (i - 1.5), x, smoothstep(0.0, 0.9, y))
        side = -1 if rnd(part, "branch", k, "side") < 0.5 else 1
        if abs(x) > 0.3:
            side = -1 if x > 0 else 1
        a = math.radians(25 + 40 * rnd(part, "branch", k, "a"))
        length = 0.18 + 0.3 * rnd(part, "branch", k, "l")
        out.append(((x, y, 0.016), (side * math.sin(a), math.cos(a)), length, k))
    return out


def leaf_cards(part, height, periodic, rooted, ends, branches):
    """Leaf-card centres with a size, a facing and a youth (0 old .. 1 young tip), along stems, shoots and in gaps."""
    cards = []
    density = 34  # cards per metre of main stem at LOD0
    for i in range(4):
        n = int(ends[i] * density)
        for k in range(n):
            key = (part if not periodic else "strip", "card", i, k)
            y = (k + rnd(*key, "y")) / density
            if y > ends[i]:
                continue
            if rooted and y < 0.25 * rnd(*key, "root"):
                continue
            x = stem_x(i, y, VINE["tile"])
            if rooted:
                x = lerp(0.05 * (i - 1.5), x, smoothstep(0.0, 0.9, y))
            x += 0.16 * (rnd(*key, "dx") - 0.5)
            youth = smoothstep(ends[i] - 0.5, ends[i], y) if ends[i] < height - 1e-6 or not periodic else 0.0
            cards.append((x, y, youth, key))
    for (x, y, _), (dx, dy), length, k in branches:
        n = max(2, int(length * 22))
        for j in range(1, n + 1):
            t = j / n
            key = (part, "shoot", k, j)
            cards.append((x + dx * length * t + 0.06 * (rnd(*key, "dx") - 0.5), y + dy * length * t, smoothstep(0.5, 1.0, t), key))
    # Fill cards between the stems so the face reads as a cover from a distance.
    fill = int(height * 16)
    for k in range(fill):
        key = (part if not periodic else "strip", "fill", k)
        y = rnd(*key, "y") * height
        x = (rnd(*key, "x") - 0.5) * 0.85
        reach = max(ends) if not rooted else max(ends) - 0.1
        if y > reach or (rooted and y < 0.4):
            continue
        cards.append((x, y, 0.0, key))
    return cards


def build_vine(part, lod, col, root, leaves):
    m = Mesh(f"climbing.{part}.mesh")
    height, periodic, rooted, ends = vine_layout(part)
    step = (0.08, 0.16, 0.3)[lod]
    sides = (6, 4, 3)[lod]
    for i in range(4):
        path = stem_path(i, part, height, rooted, ends[i], step)
        end = ends[i]
        base_r = 0.011 + 0.004 * rnd("stem", i, "r")

        def scale(k, path=path, end=end, base_r=base_r):
            y = path[k][1]
            r = base_r * (1.0 if periodic and end >= height - 1e-6 else lerp(1.0, 0.25, smoothstep(end - 0.6, end, y)))
            if rooted:
                r *= lerp(1.6, 1.0, smoothstep(0.0, 0.5, y))
            return r / 0.01

        m.sweep(path, circle(0.01, sides), "stem", 0.5, colour=lambda k, p=path: grime(p[k][1], (1, 1, 1), rooted),
                scale=scale, up=(0, 0, 1), smooth=True)
    branches = vine_branches(part, height, rooted, ends, periodic)
    if lod < 2:
        for (x, y, z), (dx, dy), length, k in branches:
            n = (5, 3)[lod]
            path = [(x + dx * length * t / n, y + dy * length * t / n, z + 0.012 * (t / n)) for t in range(n + 1)]
            m.sweep(path, circle(0.005, (4, 3)[lod]), "stem", 0.5, scale=lambda j, n=n: lerp(1.0, 0.35, j / n), up=(0, 0, 1))
    if rooted and lod < 2:
        # A gnarled root clump where the stems meet the ground.
        for k in range(5):
            a = math.pi * (0.1 + 0.8 * k / 4)
            length = 0.14 + 0.1 * rnd(part, "root", k)
            pts = [(0.0, 0.03, 0.02), (math.cos(a) * length * 0.5, 0.015, 0.03), (math.cos(a) * length, -0.01, 0.02 + 0.05 * math.sin(a))]
            m.sweep(pts, circle(0.012, sides), "stem", 0.5, scale=lambda j: (1.3, 0.9, 0.4)[j], up=(0, 0, 1), colour=grime(0.0))
    cards = leaf_cards(part, height, periodic, rooted, ends, branches)
    keep, grow = ((1.0, 1.0), (0.4, 0.85), (0.14, 0.78))[lod]
    for x, y, youth, key in cards:
        if lod and rnd(*key, "keep") >= keep:
            continue
        size = (0.2 + 0.1 * rnd(*key, "size")) * lerp(1.0, 0.7, youth) * (grow / math.sqrt(keep) if lod else 1.0)
        # Facing mostly out of the face, a little up to the sky, leaves hanging tip-down.
        tilt_x = math.radians(-8 + 40 * rnd(*key, "tx"))
        tilt_s = math.radians(30 * (rnd(*key, "ts") - 0.5))
        n = Vector((math.sin(tilt_s), math.sin(tilt_x), math.cos(tilt_x) * math.cos(tilt_s))).normalized()
        roll = math.radians(50 * (rnd(*key, "roll") - 0.5))
        up = Vector((math.sin(roll), math.cos(roll), 0.0))
        v = (up - n * up.dot(n)).normalized()
        u = v.cross(n).normalized()
        half = size / 2
        lift = abs(v.z) * half + 0.012
        cz = max(lift, 0.025 + 0.07 * rnd(*key, "z"))
        if lod == 2:
            cz = max(lift, 0.05)
        c = Vector((x, y, cz))
        corners = [c - u * half - v * half, c + u * half - v * half, c + u * half + v * half, c - u * half + v * half]
        # Colour: deep near the face and low down, sunnier on top and outward, young tips yellow-green.
        sun = clamp(0.35 + 0.45 * (cz / 0.1) + 0.25 * n.y + 0.2 * (rnd(*key, "sun") - 0.5))
        base = mix3(IVY_SHADE, IVY_MID, smoothstep(0.0, 0.6, sun))
        base = mix3(base, IVY_SUN, smoothstep(0.55, 1.0, sun))
        base = mix3(base, IVY_YOUNG, youth * 0.8)
        jitter = 0.85 + 0.3 * rnd(*key, "v")
        hue = 0.06 * (rnd(*key, "h") - 0.5)
        colour = (base[0] * jitter * (1 + hue * 2), base[1] * jitter, base[2] * jitter * (1 - hue * 2))
        if rooted:
            colour = grime(y, colour)
        bent = (n + Vector((0, 0.15, 1.0)) * 0.6).normalized()
        base_idx = m.add(corners)
        m.face([base_idx, base_idx + 1, base_idx + 2, base_idx + 3], "leaf", [(0, 0), (1, 0), (1, 1), (0, 1)], colour,
               normals=[tuple(bent)] * 4)
    m.finish(col, root, {"stem": material("stem"), "leaf": material("leaf", leaves)})
    w, depth = VINE["width"], VINE["depth"]
    climb = {"grip": "face", "clips": CLIPS["face"], "approach": "+Z", "standOff": STAND_OFF["face"],
             "face": {"normal": [0, 0, 1], "z": 0.0, "width": w},
             "gripLine": {"from": [0, 0.0, 0.0], "to": [0, round(height, 6), 0.0]},
             "note": "A cover over a climbable face: the climber holds the face beneath (mmorpg Grip::Rock or Grip::Timber)."}
    if periodic and part == "vine-strip":
        climb["tile"] = {"axis": "+Y", "pitch": VINE["tile"]}
    if part == "vine-top":
        climb["joins"] = {"below": "vine-strip", "at": 0.0}
    proxies = [proxy("vine", "climbable", (-w / 2, 0.0, 0.0), (w / 2, height, depth))]
    return {"footprint": {"width": w, "depth": depth, "height": round(height, 6)}, "climb": climb,
            "collisionProxies": proxies, "gripEnds": ((0, 0.0, 0.0), (0, height, 0.0))}


# ---------------------------------------------------------------- entry points

def build(part, lod, collection, leaves, location=(0, 0, 0)):
    """Build one part at one level under an empty root ``climbing.<part>`` at ``location`` (glTF axes)."""
    if part not in PARTS or lod not in LODS:
        raise ValueError(f"climbing part must be one of {', '.join(PARTS)} and lod 0, 1 or 2")
    root = bpy.data.objects.new(f"climbing.{part}", None)
    root.empty_display_size = 0.3
    collection.objects.link(root)
    builder = build_ladder if part.startswith("ladder") else build_rope if part.startswith("rope") else build_vine
    info = builder(part, lod, collection, root, leaves)
    lo, hi = info.pop("gripEnds")
    empty("climb.bottom", collection, root, lo)
    empty("climb.top", collection, root, hi)
    root.location = to_blender(location)
    return root, info


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or set(arguments) != {"schemaVersion", "part", "lod"} or arguments["schemaVersion"] != 1:
        raise ValueError("climbing arguments must be exactly {schemaVersion: 1, part, lod}")
    if arguments["part"] not in PARTS or arguments["lod"] not in LODS:
        raise ValueError(f"climbing part must be one of {', '.join(PARTS)} and lod 0, 1 or 2")
    if set(inputs) != {"common", "leaves"}:
        raise ValueError("climbing recipe takes exactly kit_common.py as 'common' and the ivy-leaf PNG as 'leaves'")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_common(inputs.load_source("common"))
    part, lod = arguments["part"], arguments["lod"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    root, info = build(part, lod, bpy.context.scene.collection, inputs["leaves"])
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
        export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_animations=False, export_skins=False,
        export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "climbing-kit-v1", "part": part, "lod": lod, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "back-base-center", "facing": "+Z", "triangleCount": triangles, "bounds": bounds, **info}
