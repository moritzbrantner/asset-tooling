"""Sunken shrine and cave kit, an original scripted kit for the existing pinned Blender script backend.

One run builds one module of the kit (#345) for MMORPG's Sunken Shrine at the bottom of Stillwater
Lake (mmorpg#274 part 2). Owner answers of 2026-10-22: an ancient lake temple of pale weathered
limestone/sandstone, with rounded arches, a carved fish-and-wave frieze and fluted drum pillars; the
carving is cut geometry on the arch and the altar. Teal-green algae grows on upward faces and ochre
silt gathers towards the base, both from vertex colours (glTF COLOR_0 multiplies the base colour).
Small tileable limestone and cave-rock textures are generated here with numpy.

Frame, shared by every module: metres, glTF right-handed +Y up, origin at the module's base centre
on the floor plane (y = 0), the front towards +Z. The cave runs along +X. Grid:

- shrine walls are 4 m modules (x -2..2), 0.6 m thick (z -0.3..0.3), laid in 0.6 m courses;
- ``wall``: a broken wall module, 3.0 m at its left end falling to about 1.6 m at its right;
- ``arch``: a 4 m module, 4.0 m high, with a round arch 2.4 m wide whose springline is at 1.8 m and
  whose crown is at 3.0 m, and a carved fish-and-wave frieze above it;
- ``pillar``: a fluted drum pillar on a 0.8 m plinth, 3.0 m high; ``pillar-broken`` is its stump;
- ``floor``: a 4 x 4 m flagstone tile of the sunken plaza whose top is at y = 0, 0.2 m thick;
- ``altar``: the relic altar, 1.8 x 1.3 m, 1.04 m high, with a carved front, a teal emissive inlay
  and an empty node ``relic`` where the Sunken Relic rests;
- cave modules keep a 4 m wide, 3 m high clear passage (z -2..2, y 0..3) under a rock vault:
  ``cave-tunnel`` (x -2..2, both ends open), ``cave-mouth`` (its -X end opens through a rock face
  onto the plaza, with a faint light shaft), ``cave-end`` (its +X end is closed: the altar chamber)
  and ``air-pocket``, a wider room 8 m long (x -4..4) and 8 m wide whose ends join the tunnel;
- props: ``fallen-blocks``, ``hanging-weed`` (its origin is the anchor at the top), ``silt-drift``
  and ``shells`` (a shell and barnacle cluster on a stone).

The rock is displaced by noise that repeats every 4 m along the cave, so every cave module's open
ends share one cross-section and any sequence of them joins without seams.

No randomness: every variation comes from a SHA-256 of fixed keys or Blender's fixed Perlin noise,
and the textures from numpy's legacy ``RandomState``, which is stable across numpy versions. Every
module that uses a texture embeds the same PNG bytes, so a ``gltf-resources-v1`` bundle stores them once.

``build(part, collection, location)`` also works in a live Blender session after ``use_common(runpy.run_path('kit_common.py'))``; ``generate`` is the
script-backend entry point and returns the recipe's collision proxies and the module, opening, relic,
light, tunnel and air-pocket observations alongside the measured bounds.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector, noise

PARTS = ("wall", "arch", "pillar", "pillar-broken", "floor", "altar", "cave-mouth", "cave-tunnel", "cave-end",
         "air-pocket", "fallen-blocks", "hanging-weed", "silt-drift", "shells")
MODULE, WALL_H, WALL_T, GAP = 4.0, 3.0, 0.6, 0.012
COURSES = (0.0, 0.6, 1.2, 1.8, 2.4, 3.0)
ARCH = {"width": 2.4, "springline": 1.8, "radius": 1.2, "ring": 0.36, "frieze": (3.35, 3.75), "top": 4.0}
CAVE = {"width": 4.0, "height": 3.0, "vault": 3.6, "length": 4.0}
ROOM = {"length": 8.0, "width": 8.0, "wallHeight": 3.5, "vault": 5.0, "flat": 2.5}
TEXTURE = {"limestone": 1024, "rock": 1024}
SHARP_ANGLE = math.radians(35)
ALGAE = (0.45, 0.7, 0.6)
SILT = (0.86, 0.7, 0.46)
TEAL = (0.3, 0.95, 0.85)

# name: (sRGB base colour, metallic, roughness, emission, alpha); textured ones use the maps.
MATERIALS = {
    "limestone": ((1, 1, 1), 0.0, 1.0, 0.0, 1.0),
    "rock": ((1, 1, 1), 0.0, 1.0, 0.0, 1.0),
    "mortar": ((0.36, 0.33, 0.27), 0.0, 0.95, 0.0, 1.0),
    "inlay": (TEAL, 0.0, 0.3, 1.0, 1.0),  # emissiveFactor only: no KHR_materials_emissive_strength
    "weed": ((0.26, 0.38, 0.2), 0.0, 0.7, 0.0, 1.0),
    "shell": ((0.86, 0.8, 0.7), 0.0, 0.5, 0.0, 1.0),
    "barnacle": ((0.62, 0.6, 0.55), 0.0, 0.85, 0.0, 1.0),
    "shaft": ((0.62, 0.9, 0.85), 0.0, 1.0, 0.15, 0.06),
}
DOUBLE_SIDED = ("weed", "shaft")


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


# ---------------------------------------------------------------- textures (numpy, tileable)

def limestone_maps(size):
    """Pale, water-worn limestone with faint sandstone bedding and solution pits."""
    broad = fbm(size, 4, 5, 311)
    fine = fbm(size, 32, 3, 331)
    strata = fbm(size, 2, 4, 341, stretch=(1, 6))
    pits = np.clip((fbm(size, 24, 3, 351) - 0.7) * 6, 0, 1)
    height = broad * 0.5 + fine * 0.3 + strata * 0.2 - pits * 0.45
    shade = 0.9 + (broad - 0.5) * 0.35 + (fine - 0.5) * 0.18 + (strata - 0.5) * 0.25 - pits * 0.08
    pale = np.array([0.8, 0.75, 0.64])
    colour = np.clip(pale[None, None, :] * shade[..., None], 0, 1)
    ao = np.clip(1 - pits * 0.45, 0, 1)
    rough = np.clip(0.85 + (fine - 0.5) * 0.15 + pits * 0.08, 0, 1)
    return colour, normal_map(height, 2.5), np.stack([ao, rough, np.zeros_like(ao)], -1)


def rock_maps(size):
    """Darker, coarser lake-cave rock."""
    broad = fbm(size, 3, 5, 411)
    fine = fbm(size, 24, 3, 431)
    ridges = 1 - np.abs(fbm(size, 5, 4, 451) - 0.5) * 2
    height = broad * 0.5 + fine * 0.25 + ridges * 0.25
    shade = 0.82 + (broad - 0.5) * 0.55 + (fine - 0.5) * 0.25 + (ridges - 0.5) * 0.2
    base = np.array([0.56, 0.52, 0.45])
    colour = np.clip(base[None, None, :] * shade[..., None], 0, 1)
    ao = np.clip(0.75 + ridges * 0.25, 0, 1)
    rough = np.clip(0.9 + (fine - 0.5) * 0.1, 0, 1)
    return colour, normal_map(height, 4.0), np.stack([ao, rough, np.zeros_like(ao)], -1)


def material(name):
    existing = bpy.data.materials.get(f"shrine-{name}")
    if existing is not None:
        return existing
    colour, metallic, roughness, emission, alpha = MATERIALS[name]
    mat = bpy.data.materials.new(f"shrine-{name}")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    linear = tuple(srgb_to_linear(c) for c in colour) + (1,)
    bsdf.inputs["Base Color"].default_value = linear
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = linear
        bsdf.inputs["Emission Strength"].default_value = emission
    if alpha < 1:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.surface_render_method = "BLENDED"
    mat.use_backface_culling = name not in DOUBLE_SIDED
    vcol = nodes.new("ShaderNodeVertexColor")
    vcol.layer_name = "Col"
    mix = nodes.new("ShaderNodeMix")
    mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    links.new(vcol.outputs["Color"], mix.inputs[7])
    links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    if name in TEXTURE:
        maps = (limestone_maps if name == "limestone" else rock_maps)(TEXTURE[name])
        images = [make_image(f"shrine-{name}-{kind}", data, kind == "color") for kind, data in zip(("color", "normal", "orm"), maps)]
        tex = []
        for image in images:
            node = nodes.new("ShaderNodeTexImage")
            node.image = image
            tex.append(node)
        links.new(tex[0].outputs["Color"], mix.inputs[6])
        nmap = nodes.new("ShaderNodeNormalMap")
        links.new(tex[1].outputs["Color"], nmap.inputs["Color"])
        links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        sep = nodes.new("ShaderNodeSeparateColor")
        links.new(tex[2].outputs["Color"], sep.inputs["Color"])
        links.new(sep.outputs[1], bsdf.inputs["Roughness"])
        links.new(sep.outputs[2], bsdf.inputs["Metallic"])
    else:
        mix.inputs[6].default_value = linear
    return mat


# ---------------------------------------------------------------- geometry

class Builder:
    """One mesh in glTF axes; per face a material, UVs and a tint, finished with algae and silt colours."""

    def __init__(self, name, algae=1.0, silt=1.0, silt_height=1.2):
        self.name = name
        self.algae, self.silt, self.silt_height = algae, silt, silt_height
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.tint = self.bm.faces.layers.float.new("tint")
        self.materials = []

    def slot(self, name):
        if name not in self.materials:
            self.materials.append(name)
        return self.materials.index(name)

    def faces(self, verts, quads, mat, tint=1.0, uv_offset=(0, 0), uv_scale=0.5, uvs=None, recalc=True):
        """Faces over ``verts``; box-projected UVs unless ``uvs`` gives one per vertex."""
        bverts = [self.bm.verts.new(to_blender(p)) for p in verts]
        made = [self.bm.faces.new([bverts[i] for i in q]) for q in quads]
        if recalc:
            bmesh.ops.recalc_face_normals(self.bm, faces=made)
        for f in made:
            f.normal_update()
        for f, q in zip(made, quads):
            f.material_index = self.slot(mat)
            f[self.tint] = tint
            if uvs is not None:
                for loop, i in zip(f.loops, q):
                    loop[self.uv].uv = uvs[i]
                continue
            n = f.normal
            axis = max(range(3), key=lambda i: abs(n[i]))
            u_axis, v_axis = [(1, 2), (0, 2), (0, 1)][axis]
            for loop in f.loops:
                co = loop.vert.co
                loop[self.uv].uv = (co[u_axis] * uv_scale + uv_offset[0], co[v_axis] * uv_scale + uv_offset[1])
        return made

    def grid(self, rows, mat, orient, tint=1.0, wrap=False, uv_scale=0.5, smooth=True, box_uv=False, along_x=False):
        """Quads over ``rows`` (lists of points, all the same length). ``wrap`` closes each row into a
        loop. Faces turn so that their normals agree with ``orient(centre)`` on the whole.
        ``along_x`` maps U to x / 4 m, so cave modules carry the texture on across their joins."""
        if wrap:  # repeat the first column so the UVs run on across the seam; finish() welds it
            rows = [list(row) + [row[0]] for row in rows]
        n, m = len(rows), len(rows[0])
        verts, uvs, quads = [], [], []
        # UVs follow the surface: distances along each row and down each column, in metres.
        along = [[0.0] * m for _ in range(n)]
        for i in range(1, n):
            for j in range(m):
                along[i][j] = along[i - 1][j] + math.dist(rows[i][j], rows[i - 1][j])
        for i, row in enumerate(rows):
            across = 0.0
            for j, p in enumerate(row):
                if j:
                    across += math.dist(p, row[j - 1])
                verts.append(p)
                uvs.append((p[0] / CAVE["length"] if along_x else along[i][j] * uv_scale, across * uv_scale))
        for i in range(n - 1):
            for j in range(m - 1):
                quads.append([i * m + j, i * m + j + 1, (i + 1) * m + j + 1, (i + 1) * m + j])
        made = self.faces(verts, quads, mat, tint, uv_scale=uv_scale, uvs=None if box_uv else uvs, recalc=False)
        for f in made:
            f.normal_update()
        score = sum(f.normal.dot(to_blender(orient(blender_to_gltf(f.calc_center_median())))) for f in made)
        if score < 0:
            bmesh.ops.reverse_faces(self.bm, faces=made)
        for f in made:
            f.smooth = smooth
        return made

    def block(self, lo, hi, mat="limestone", chamfer=0.03, key="", tint=1.0, chip=0.0):
        """A box with every edge chamfered; ``chip`` enlarges some corners' chamfer."""
        h = [(hi[i] - lo[i]) / 2 for i in range(3)]
        c0 = [(hi[i] + lo[i]) / 2 for i in range(3)]
        verts, index = [], {}
        for corner in range(8):
            s = [1 if corner & (1 << i) else -1 for i in range(3)]
            c = min(chamfer * (1 + chip * 2 * rnd(key, "chip", corner) ** 3), min(h) * 0.45)
            for face_axis in range(3):
                p = [c0[i] + s[i] * (h[i] if i == face_axis else h[i] - c) for i in range(3)]
                index[(corner, face_axis)] = len(verts)
                verts.append(p)
        quads = []
        corners = lambda axis, sign: [c for c in range(8) if (1 if c & (1 << axis) else -1) == sign]
        for axis in range(3):
            for sign in (-1, 1):
                cs = corners(axis, sign)
                a, b = [i for i in range(3) if i != axis]
                ring = sorted(cs, key=lambda c: math.atan2(1 if c & (1 << b) else -1, 1 if c & (1 << a) else -1))
                quads.append([index[(c, axis)] for c in ring])
        for a in range(3):
            for b in range(a + 1, 3):
                free = 3 - a - b
                for sa in (-1, 1):
                    for sb in (-1, 1):
                        cs = [c for c in range(8) if (1 if c & (1 << a) else -1) == sa and (1 if c & (1 << b) else -1) == sb]
                        c_lo, c_hi = sorted(cs, key=lambda c: c & (1 << free))
                        quads.append([index[(c_lo, a)], index[(c_hi, a)], index[(c_hi, b)], index[(c_lo, b)]])
        for corner in range(8):
            quads.append([index[(corner, 0)], index[(corner, 1)], index[(corner, 2)]])
        return self.faces(verts, quads, mat, tint, (rnd(key, "u"), rnd(key, "v")))

    def prism(self, outline, z0, z1, mat="limestone", key="", tint=1.0):
        """Extrude a counter-clockwise (x, y) outline from z0 to z1."""
        n = len(outline)
        verts = [(x, y, z0) for x, y in outline] + [(x, y, z1) for x, y in outline]
        quads = [list(range(n - 1, -1, -1)), list(range(n, 2 * n))]
        quads += [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
        return self.faces(verts, quads, mat, tint, (rnd(key, "u"), rnd(key, "v")))

    def lathe(self, profile, centre=(0, 0, 0), segments=12, mat="limestone", tint=1.0, key="", axis=None, smooth=True, radial=None, caps=True):
        """Revolve [(radius, height)] around +Y (or around ``axis`` = (origin, direction)).
        ``radial(angle)`` scales the radius around the ring, for flutes."""
        verts, quads, rings = [], [], []
        for r, y in profile:
            ring = []
            for s in range(segments):
                a = 2 * math.pi * (s + 0.5) / segments
                rr = r * (radial(a) if radial and r > 0 else 1.0)
                ring.append(len(verts))
                verts.append((rr * math.cos(a), y, rr * math.sin(a)))
            rings.append(ring)
        for ra, rb in zip(rings, rings[1:]):
            for s in range(segments):
                t = (s + 1) % segments
                quads.append([ra[s], ra[t], rb[t], rb[s]])
        if caps and profile[0][0] > 0:
            quads.append(list(reversed(rings[0])))
        if caps and profile[-1][0] > 0:
            quads.append(rings[-1])
        if axis is None:
            verts = [(x + centre[0], y + centre[1], z + centre[2]) for x, y, z in verts]
        else:
            origin, direction = Vector(axis[0]), Vector(axis[1]).normalized()
            rot = Vector((0, 1, 0)).rotation_difference(direction).to_matrix()
            verts = [tuple(origin + rot @ Vector(v)) for v in verts]
        made = self.faces(verts, [q for q in quads if len(set(q)) >= 3], mat, tint, (rnd(key, "u"), rnd(key, "v")), uv_scale=1.0)
        for f in made:
            f.smooth = smooth
        return made

    def blob(self, centre, radius, scale=(1, 1, 1), key="", mat="rock", rough=0.3, subdivisions=2, tint=1.0):
        """A noise-displaced icosphere; returns the faces and its surface radius function."""
        tmp = bmesh.new()
        bmesh.ops.create_icosphere(tmp, subdivisions=subdivisions, radius=1.0)
        seed = Vector((rnd(key, "x") * 50, rnd(key, "y") * 50, rnd(key, "z") * 50))
        def surface(d):
            d = Vector(d).normalized()
            return radius * (1 + rough * noise.noise(d * 1.6 + seed))
        verts = []
        for v in tmp.verts:
            d = Vector((v.co.x, v.co.z, -v.co.y))
            r = surface(d)
            verts.append(tuple(centre[i] + d[i] * r * scale[i] for i in range(3)))
        quads = [[v.index for v in f.verts] for f in tmp.faces]
        tmp.free()
        made = self.faces(verts, quads, mat, tint, (rnd(key, "u"), rnd(key, "v")))
        for f in made:
            f.smooth = True
        return made, surface

    def transform(self, faces, matrix):
        """Move the vertices of ``faces`` (glTF axes) by ``matrix``."""
        for v in {v for f in faces for v in f.verts}:
            g = matrix @ Vector(blender_to_gltf(v.co))
            v.co = to_blender(g)

    def finish(self, collection, parent=None, location=(0, 0, 0)):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
        # MikkTSpace in the exporter needs triangles and quads only
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4], quad_method="BEAUTY", ngon_method="BEAUTY")
        col = bm.loops.layers.color.new("Col")
        for f in bm.faces:
            up = f.normal.z
            for loop in f.loops:
                p = loop.vert.co  # Blender axes: z is height
                n = noise.noise(Vector((p.x * 1.3, p.y * 1.3, p.z * 1.3)) + Vector((3.1, 17.7, 5.3)))
                patch = clamp(0.5 + n * 1.5)
                n2 = noise.noise(Vector((p.x * 0.9, p.y * 0.9, p.z * 0.9)) + Vector((41.0, 2.5, 9.9)))
                height = clamp(1 - (p.z + location[2]) / self.silt_height)
                a = self.algae * clamp(smoothstep(0.3, 0.75, up) * (0.35 + 0.65 * patch) + 0.06)
                s = self.silt * clamp(height * height * (0.55 + 0.45 * clamp(0.5 + n2 * 1.4)) + max(0.0, up) * height * 0.3)
                t = f[self.tint]
                c = [t * lerp(1, ALGAE[k], a) * lerp(1, SILT[k], s) for k in range(3)]
                loop[col] = (c[0], c[1], c[2], 1.0)
        mesh = bpy.data.meshes.new(f"{self.name}-geometry")
        bm.to_mesh(mesh)
        bm.free()
        mesh.attributes.remove(mesh.attributes["tint"])
        mesh.color_attributes.active_color_name = "Col"
        mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
        for name in self.materials:
            mesh.materials.append(material(name))
        mesh.set_sharp_from_angle(angle=SHARP_ANGLE)
        obj = bpy.data.objects.new(self.name, mesh)
        collection.objects.link(obj)
        obj.parent = parent
        return obj


def blender_to_gltf(co):
    return (co.x, co.z, -co.y)


# ---------------------------------------------------------------- carving

def frieze_pattern(u, v, height, length):
    """Raised (0) or cut (1) at ``u`` metres along a frieze and ``v`` metres up it: a raised border,
    a running wave scroll in the lower half and swimming fish in the upper half, on a cut ground."""
    border = 0.035
    if v < border or v > height - border or u < border or u > length - border:
        return 0.0
    edge = 0.02
    band = height * 0.44  # the raised fillet between the wave band and the fish band
    if abs(v - band) < 0.012:
        return 0.0
    if v < band:
        # Breaking waves: raised below a crest line that leans forward, a cut curl in every crest.
        period = 0.3
        t = u / period
        crest = border + (band - border) * (0.22 + 0.62 * (0.5 + 0.5 * math.sin(2 * math.pi * t - 0.9 * math.sin(2 * math.pi * t))))
        raised = clamp((crest - v) / edge)
        cx, cy = (math.floor(t) + 0.62) * period, border + (band - border) * 0.55
        if abs(math.hypot((u - cx) * 1.1, v - cy) - (band - border) * 0.2) < 0.009:
            raised = 0.0
        return 1.0 - raised
    # Fish: a filled body, a forked tail, a cut eye and gill, alternately facing left and right.
    spacing = 0.62
    k = math.floor(u / spacing)
    side = 1 if k % 2 == 0 else -1
    du, dv = (u - (k + 0.5) * spacing) * side, v - (band + height - border) / 2
    half_len, half_h = 0.17, (height - border - band) * 0.36
    taper = max(0.0, 1 - (du / half_len) ** 2)
    raised = clamp((half_h * math.sqrt(taper) * (1.0 if du > -0.05 else 0.85) - abs(dv)) / edge) if abs(du) < half_len else 0.0
    if -half_len - 0.1 < du < -half_len + 0.02:
        spread = (-half_len + 0.02 - du) * 0.9
        raised = max(raised, clamp((spread * 0.45 - abs(abs(dv) - spread * 0.55)) / edge))
    if math.hypot(du - 0.1, dv - half_h * 0.2) < 0.013 or (abs(du - 0.05) < 0.005 and abs(dv) < half_h * 0.6):
        raised = 0.0
    return 1.0 - raised


def relief(b, x0, x1, y0, y1, z_ground, depth, key, step=0.015, pattern=frieze_pattern, mat="limestone"):
    """A carved panel on the +Z face: its raised surface is at ``z_ground + depth``, its cut ground at
    ``z_ground``; skirts close its edges back to the ground plane."""
    nx, ny = max(2, round((x1 - x0) / step)), max(2, round((y1 - y0) / step))
    height, length = y1 - y0, x1 - x0
    rows = []
    for i in range(nx + 1):
        x = x0 + length * i / nx
        # The cut ground stands 4 mm proud of the stone face behind it, so the two never z-fight.
        rows.append([(x, y0 + height * j / ny, z_ground + 0.004 + depth * (1 - pattern(x - x0, height * j / ny, height, length)))
                     for j in range(ny + 1)])
    made = b.grid(rows, mat, lambda c: (0, 0, 1), smooth=False)
    for f in made:  # darken the cut ground and the cut walls so the carving reads at a distance
        cut = 1 - (blender_to_gltf(f.calc_center_median())[2] - z_ground - 0.004) / depth
        f[b.tint] = 1.0 - 0.4 * clamp(cut)
    edge = [rows[0][j] for j in range(ny + 1)] + [rows[i][ny] for i in range(1, nx + 1)] + \
           [rows[nx][j] for j in range(ny - 1, -1, -1)] + [rows[i][0] for i in range(nx - 1, 0, -1)]
    skirt = [edge + edge[:1], [(x, y, z_ground - 0.002) for x, y, _ in edge + edge[:1]]]
    made += b.grid(skirt, mat, lambda c: (c[0] - (x0 + x1) / 2, c[1] - (y0 + y1) / 2, 0), smooth=False)
    return made


# ---------------------------------------------------------------- shrine masonry

def course_joints(part, module, course, lo=None, hi=None):
    """Block joints of one course across a module: lengths 0.6..1.3 m, staggered by course."""
    lo = -module / 2 if lo is None else lo
    hi = module / 2 if hi is None else hi
    joints, x, i = [lo], lo + (0.35 + 0.5 * rnd(part, course, "first")) * (1 if course % 2 else 1.6), 0
    while x < hi - 0.45:
        joints.append(x)
        i += 1
        x += 0.6 + 0.7 * rnd(part, course, i)
    joints.append(hi)
    return joints


def ashlar(b, part, course, y0, y1, x0, x1, top=None, chip=1.0):
    """One course of limestone blocks from x0 to x1; ``top(x)`` breaks blocks off above it."""
    half_t = WALL_T / 2
    joints = course_joints(part, MODULE, course, x0, x1)
    kept = []
    for a0, a1 in zip(joints, joints[1:]):
        key = f"{part}/{course}/{a0:.3f}"
        if top is not None and y1 > top((a0 + a1) / 2) + 1e-6:
            continue
        out = (rnd(key, "out") - 0.5) * 0.03
        tint = 0.86 + 0.2 * rnd(key, "tint")
        b.block((a0 + GAP / 2, y0 + GAP / 2, -half_t + out * 0.5), (a1 - GAP / 2, y1 - GAP / 2, half_t + out),
                "limestone", 0.03 + 0.03 * rnd(key, "c"), key, tint, chip)
        kept.append((a0, a1, y1))
    return kept


def wall_break(x):
    """The broken wall's top: 3.0 m at the left end, falling to about 1.6 m at the right."""
    return 3.15 - 1.5 * smoothstep(-1.2, 1.8, x) + 0.2 * (rnd("wall", "break", round(x * 2)) - 0.5)


def build_wall(part, col, root):
    b = Builder(f"shrine.{part}.mesh")
    b.block((-MODULE / 2 + 0.02, 0.0, -WALL_T / 2 + 0.04), (MODULE / 2 - 0.02, 1.15, WALL_T / 2 - 0.04), "mortar", 0.005, "core")
    tops = []
    for course, (y0, y1) in enumerate(zip(COURSES, COURSES[1:])):
        tops += ashlar(b, part, course, y0, y1, -MODULE / 2, MODULE / 2, wall_break, chip=1.0 + course * 0.4)
    b.finish(col, root)
    h = WALL_T / 2 + 0.02
    proxies = []
    for i in range(4):  # one box per metre, as high as the wall stands over it
        x0, x1 = -2 + i, -1 + i
        top = max([y1 for a0, a1, y1 in tops if a0 < x1 and a1 > x0] + [0.6])
        proxies.append(proxy(f"wall.{i}", "solid", (x0, 0, -h), (x1, top, h)))
    return {"module": {"width": MODULE, "height": WALL_H, "depth": WALL_T}, "collisionProxies": proxies}


def build_arch(part, col, root):
    a = ARCH
    w2, spring, r_in = a["width"] / 2, a["springline"], a["radius"]
    r_out = r_in + a["ring"]
    f0, f1 = a["frieze"]
    top = a["top"]
    half_t = WALL_T / 2
    b = Builder(f"shrine.{part}.mesh")
    # Jambs: ashlar courses up to the springline, capped by a projecting impost.
    for course, (y0, y1) in enumerate(zip(COURSES[:4], COURSES[1:4])):
        y1 = min(y1, spring - 0.1)
        for side in (-1, 1):
            lo, hi = sorted((side * (w2 + GAP / 2), side * (MODULE / 2 + GAP / 2)))  # the jamb face is the opening
            ashlar(b, f"{part}/{side}", course, y0, y1, lo, hi)
    for side in (-1, 1):
        lo, hi = sorted((side * w2, side * MODULE / 2))
        b.block((lo, spring - 0.1, -half_t - 0.05), (hi, spring, half_t + 0.05), "limestone", 0.02, f"impost{side}", 0.95, 0.5)
    # Voussoirs round the arch, a proud keystone at the crown.
    stones = 9
    for i in range(stones):
        a0, a1 = math.pi * (1 - i / stones), math.pi * (1 - (i + 1) / stones)
        g = GAP / 2 / r_in
        key_stone = i == stones // 2
        ro = r_out + (0.1 if key_stone else 0.0)
        pts = [(r_in * math.cos(a0 - g), spring + r_in * math.sin(a0 - g)), (ro * math.cos(a0 - g), spring + ro * math.sin(a0 - g)),
               (ro * math.cos(a1 + g), spring + ro * math.sin(a1 + g)), (r_in * math.cos(a1 + g), spring + r_in * math.sin(a1 + g))]
        if i == 0 or i == stones - 1:  # the springers sit level on the impost
            pts = [(p[0], max(p[1], spring)) for p in pts]
        out = 0.035 if key_stone else 0.0
        b.prism(list(reversed(pts)), -half_t - out, half_t + out, "limestone", f"voussoir{i}", 0.9 + 0.15 * rnd("vt", i))
    # Spandrels: two stones each side between the ring and the frieze.
    split = spring + 0.75
    for side in (-1, 1):
        for lo_y, hi_y in ((spring, split), (split, f0)):
            arc = []
            for k in range(13):
                y = lerp(lo_y, hi_y, k / 12)
                dy = y - spring
                if dy >= r_out:
                    break
                arc.append((side * (math.sqrt(r_out * r_out - dy * dy) + GAP / 2), y))
            outline = [(side * (MODULE / 2 - GAP / 2), lo_y + GAP / 2)] + [(x, max(y, lo_y + GAP / 2)) for x, y in arc]
            if hi_y - spring > r_out:
                outline += [(GAP / 2 * side, hi_y - GAP / 2)]
            else:
                outline[-1] = (outline[-1][0], hi_y - GAP / 2)
            outline += [(side * (MODULE / 2 - GAP / 2), hi_y - GAP / 2)]
            if side > 0:
                outline = list(reversed(outline))
            b.prism(outline, -half_t + 0.01, half_t - 0.01, "limestone", f"spandrel{side}{lo_y}", 0.9 + 0.1 * rnd("sp", side, lo_y))
    # The frieze: two long stones, the front carved with fish and waves.
    for i, (x0, x1) in enumerate(((-MODULE / 2, -0.35), (-0.35, MODULE / 2))):
        b.block((x0 + GAP / 2, f0 + GAP / 2, -half_t), (x1 - GAP / 2, f1 - GAP / 2, half_t), "limestone", 0.015, f"frieze{i}", 0.95)
    relief(b, -MODULE / 2 + 0.04, MODULE / 2 - 0.04, f0 + 0.02, f1 - 0.02, half_t, 0.04, "arch-frieze")
    # A cornice of three stones, the right one broken short.
    for i, (x0, x1) in enumerate(((-MODULE / 2 - 0.05, -0.7), (-0.7, 0.85), (0.85, 1.55))):
        b.block((x0 + GAP / 2, f1, -half_t - 0.07), (x1 - GAP / 2, top, half_t + 0.07), "limestone", 0.03, f"cornice{i}", 0.92, 2.5 if i == 2 else 0.8)
    b.finish(col, root)
    h = half_t + 0.07
    crown = spring + r_in
    return {"module": {"width": MODULE, "height": top, "depth": WALL_T},
            "opening": {"shape": "round-arch", "width": a["width"], "springline": spring, "crown": crown, "depth": WALL_T,
                        "min": [-w2, 0, -half_t], "max": [w2, crown, half_t]},
            "collisionProxies": [proxy("left-jamb", "solid", (-MODULE / 2, 0, -h), (-w2, top, h)),
                                 proxy("right-jamb", "solid", (w2, 0, -h), (MODULE / 2, top, h)),
                                 proxy("crown", "solid", (-w2, crown, -h), (w2, top, h))]}


def fluted(b, y0, y1, r0, r1, key, flutes=20, segments=80, depth=0.1, twist=0.0, tint=1.0, top_profile=None):
    """A fluted drum: concave channels separated by sharp arrises, chamfered at both beds."""
    def radial(a):
        phi = ((a + twist) * flutes) % (2 * math.pi)
        return 1 - depth * math.sqrt(max(0.0, 1 - ((phi - math.pi) / (math.pi * 0.92)) ** 2))
    prof = [(0.0, y0), (r0 - 0.015, y0 + 0.004), (r0, y0 + 0.02), (r1, y1 - 0.02), (r1 - 0.015, y1 - 0.004)]
    prof += top_profile if top_profile else [(0.0, y1)]
    return b.lathe(prof, (0, 0, 0), segments, "limestone", tint, key, radial=radial, smooth=True)


def pillar_base(b):
    b.block((-0.4, 0, -0.4), (0.4, 0.22, 0.4), "limestone", 0.03, "plinth", 0.88, 1.2)
    b.lathe([(0.0, 0.22), (0.34, 0.22), (0.36, 0.26), (0.34, 0.31), (0.29, 0.33), (0.3, 0.37), (0.27, 0.4), (0.0, 0.4)],
            (0, 0, 0), 32, "limestone", 0.92, key="torus")


def build_pillar(part, col, root):
    b = Builder(f"shrine.{part}.mesh", silt_height=1.0)
    pillar_base(b)
    drums = [0.4, 1.12, 1.84, 2.56]
    for i, (y0, y1) in enumerate(zip(drums, drums[1:])):
        r0, r1 = lerp(0.27, 0.24, (y0 - 0.4) / 2.16), lerp(0.27, 0.24, (y1 - 0.4) / 2.16)
        fluted(b, y0, y1, r0, r1, f"drum{i}", twist=0.012 * (rnd("drum", i) - 0.5), tint=0.88 + 0.16 * rnd("drumt", i))
    b.lathe([(0.0, 2.56), (0.245, 2.56), (0.26, 2.6), (0.33, 2.68), (0.37, 2.76), (0.0, 2.76)], (0, 0, 0), 32, "limestone", 0.92, key="echinus")
    b.block((-0.4, 2.76, -0.4), (0.4, 3.0, 0.4), "limestone", 0.03, "abacus", 0.9, 1.2)
    b.finish(col, root)
    return {"footprint": {"width": 0.8, "depth": 0.8, "height": WALL_H},
            "collisionProxies": [proxy("pillar", "solid", (-0.4, 0, -0.4), (0.4, WALL_H, 0.4))]}


def build_pillar_broken(part, col, root):
    b = Builder(f"shrine.{part}.mesh", silt_height=1.0)
    pillar_base(b)
    fluted(b, 0.4, 1.12, 0.27, 0.26, "drum0", tint=0.9)
    # The second drum snapped off in a slanting, jagged break.
    break_top = [(0.26 * (1 - k / 6) ** 0.7, 1.6 + 0.04 * (1 - k / 6)) for k in range(1, 7)]
    drum = fluted(b, 1.12, 1.6, 0.26, 0.255, "drum1", tint=0.85, top_profile=break_top)
    for v in {v for f in drum for v in f.verts}:
        x, y, z = blender_to_gltf(v.co)
        if y > 1.5:  # tilt the break down towards +X and roughen it
            lift = (y - 1.5) / 0.14
            y += lift * (-0.32 * x / 0.26 + 0.07 * noise.noise(Vector((x * 9, z * 9, 2.2))))
            v.co = to_blender((x, y, z))
    b.finish(col, root)
    return {"footprint": {"width": 0.8, "depth": 0.8, "height": 1.95},
            "collisionProxies": [proxy("pillar", "solid", (-0.4, 0, -0.4), (0.4, 1.75, 0.4))]}


def build_floor(part, col, root):
    b = Builder(f"shrine.{part}.mesh", algae=0.35, silt=0.7, silt_height=0.6)
    b.block((-1.99, -0.2, -1.99), (1.99, -0.06, 1.99), "mortar", 0.005, "bed")
    z_rows = [-2.0, -1.05, -0.1, 0.95, 2.0]
    for r, (z0, z1) in enumerate(zip(z_rows, z_rows[1:])):
        xs = course_joints(part, MODULE, r)
        for x0, x1 in zip(xs, xs[1:]):
            key = f"floor/{r}/{x0:.3f}"
            top = -0.015 * rnd(key, "top")
            b.block((x0 + GAP / 2, -0.16, z0 + GAP / 2), (x1 - GAP / 2, top, z1 - GAP / 2), "limestone", 0.025, key, 0.82 + 0.2 * rnd(key, "t"), 1.2)
    b.finish(col, root)
    return {"module": {"width": MODULE, "depth": MODULE, "height": 0.2, "top": 0.0},
            "collisionProxies": [proxy("floor", "floor", (-2, -0.2, -2), (2, 0, 2))]}


def build_altar(part, col, root):
    b = Builder(f"shrine.{part}.mesh", algae=0.7, silt=0.9, silt_height=0.8)
    b.block((-0.9, 0, -0.65), (0.9, 0.16, 0.65), "limestone", 0.03, "dais", 0.86, 1.4)
    b.block((-0.7, 0.16, -0.45), (0.7, 0.86, 0.45), "limestone", 0.025, "body", 0.94, 0.6)
    relief(b, -0.62, 0.62, 0.26, 0.76, 0.45, 0.03, "altar-front")
    b.transform(relief(b, -0.62, 0.62, 0.26, 0.76, 0.45, 0.03, "altar-back"), rotation(math.pi))
    b.block((-0.78, 0.86, -0.53), (0.78, 1.0, 0.53), "limestone", 0.03, "top", 0.92, 1.0)
    # The relic dish with its teal inlay ring and the inlaid wave line along the front of the top.
    b.lathe([(0.0, 1.0), (0.3, 1.0), (0.3, 1.025), (0.27, 1.04), (0.2, 1.03), (0.0, 1.015)], (0, 0, 0), 32, "limestone", 0.95, key="dish")
    b.lathe([(0.205, 1.031), (0.255, 1.036), (0.255, 1.042), (0.205, 1.037), (0.205, 1.031)], (0, 0, 0), 32, "inlay", key="ring", caps=False)
    for i in range(24):
        x0, x1 = -0.7 + 1.4 * i / 24, -0.7 + 1.4 * (i + 1) / 24
        y0 = 0.93 + 0.025 * math.sin(i * math.pi / 3)
        y1 = 0.93 + 0.025 * math.sin((i + 1) * math.pi / 3)
        b.faces([(x0, y0 - 0.008, 0.531), (x1, y1 - 0.008, 0.531), (x1, y1 + 0.008, 0.531), (x0, y0 + 0.008, 0.531)],
                [[0, 1, 2, 3]], "inlay", recalc=False)
    b.finish(col, root)
    relic = [0.0, 1.03, 0.0]
    empty("relic", col, root, relic)
    return {"footprint": {"width": 1.8, "depth": 1.3, "height": 1.04},
            "relic": {"node": "relic", "position": relic},
            "lights": [{"node": "relic", "kind": "point", "position": relic, "color": list(TEAL), "suggestedIntensityCandela": 6,
                        "suggestedRange": 8}],
            "collisionProxies": [proxy("altar", "solid", (-0.9, 0, -0.65), (0.9, 1.0, 0.65))]}


# ---------------------------------------------------------------- cave

PROFILE_SAMPLES = 96
SPLITS = (0.28, 0.46, 0.82)  # floor | left wall | vault | right wall


def profile_point(u, half_width, wall_height, vault):
    """A point on the passage's cross-section (z, y), u in [0, 1): the floor from +z to -z, the
    left wall up, the vault over and the right wall down."""
    f, l, v = SPLITS
    if u < f:
        return (lerp(half_width, -half_width, u / f), 0.0)
    if u < l:
        return (-half_width, wall_height * (u - f) / (l - f))
    if u < v:
        t = (u - l) / (v - l)
        return (-half_width * math.cos(math.pi * t), wall_height + (vault - wall_height) * math.sin(math.pi * t))
    return (half_width, wall_height * (1 - (u - v) / (1 - v)))


def rock_amplitude(u):
    """Displacement amplitude: small on the floor, full on the walls and vault."""
    f = SPLITS[0]
    g = min(u - f, 1.0 - u) if u >= f else 0.0
    if u < f:
        g = 0.0
    return 0.06 + 0.46 * smoothstep(0.0, 0.05, g)


def rock_displacement(u, phase):
    """Outward displacement; periodic in both u and the 4 m cave phase (a torus in noise space)."""
    th, ph = 2 * math.pi * u, phase
    big, small = 2.4, 0.7
    p = Vector(((big + small * math.cos(ph)) * math.cos(th), (big + small * math.cos(ph)) * math.sin(th), small * math.sin(ph)))
    n = noise.noise(p * 1.25 + Vector((7.3, 1.1, 4.4))) + 0.45 * noise.noise(p * 2.9 + Vector((2.2, 9.5, 0.7)))
    return rock_amplitude(u) * clamp(0.5 + n * 0.85)


def section(x, half_width, wall_height, vault, offset=None, origin=-2.0):
    """One ring of the cave at ``x`` (glTF), displaced outward; ``offset`` replaces the noise."""
    pts = [profile_point(i / PROFILE_SAMPLES, half_width, wall_height, vault) for i in range(PROFILE_SAMPLES)]
    phase = 2 * math.pi * (x - origin) / CAVE["length"]  # every open end sits at a whole period: phase 0
    ring = []
    for i, (z, y) in enumerate(pts):
        zp, yp = pts[i - 1]
        zn, yn = pts[(i + 1) % PROFILE_SAMPLES]
        tz, ty = zn - zp, yn - yp
        nz, ny = -ty, tz  # outward for this winding (floor normal points down)
        ln = math.hypot(nz, ny) or 1.0
        nz, ny = nz / ln, ny / ln
        d = offset if offset is not None else rock_displacement(i / PROFILE_SAMPLES, phase)
        ring.append((x, y + ny * d, z + nz * d))
    return ring


def passage(b, xs, shape, open_ends=(True, True), origin=-2.0):
    """A rock passage over ``xs`` whose cross-section ``shape(x)`` gives (half width, wall, vault):
    an inner displaced surface, an outer shell 0.8 m beyond the profile and caps at open ends."""
    inner = [section(x, *shape(x), origin=origin) for x in xs]
    outer = [section(x, *shape(x), offset=0.8) for x in xs]
    axis = lambda c, s: (0, s * (shape(c[0])[1] * 0.5 - c[1]), -s * c[2])
    b.grid(inner, "rock", lambda c: axis(c, 1), wrap=True, uv_scale=0.25, along_x=True)
    b.grid(outer, "rock", lambda c: axis(c, -1), wrap=True, uv_scale=0.25, along_x=True, smooth=False)
    for end, x, inn, out in ((0, xs[0], inner[0], outer[0]), (1, xs[-1], inner[-1], outer[-1])):
        if open_ends[end]:
            b.grid([inn, out], "rock", lambda c, s=(1 if end else -1): (s, 0, 0), wrap=True, uv_scale=0.35, smooth=False)
    return inner, outer


def tunnel_shape(_x):
    return CAVE["width"] / 2, CAVE["height"], CAVE["vault"]


def cave_proxies(x0, x1, half_width=2.0, wall=3.0, vault=3.6):
    return [proxy("floor", "floor", (x0, -0.3, -half_width - 0.5), (x1, 0, half_width + 0.5)),
            proxy("north-wall", "solid", (x0, 0, -half_width - 0.5), (x1, wall, -half_width)),
            proxy("south-wall", "solid", (x0, 0, half_width), (x1, wall, half_width + 0.5)),
            proxy("roof", "solid", (x0, wall, -half_width - 0.5), (x1, vault + 0.5, half_width + 0.5))]


def tunnel_info(x0, x1, ends):
    return {"axis": "+X", "length": round(x1 - x0, 6), "ends": ends,
            "clear": {"min": [x0, 0, -CAVE["width"] / 2], "max": [x1, CAVE["height"], CAVE["width"] / 2]}}


XS = [-2 + 4 * i / 16 for i in range(17)]


def build_cave_tunnel(part, col, root):
    b = Builder(f"shrine.{part}.mesh", algae=0.5, silt=1.0, silt_height=0.9)
    passage(b, XS, tunnel_shape)
    b.finish(col, root)
    return {"module": {"width": CAVE["length"], "height": CAVE["vault"], "depth": CAVE["width"]},
            "tunnel": tunnel_info(-2, 2, ["-X", "+X"]), "collisionProxies": cave_proxies(-2, 2)}


def build_cave_mouth(part, col, root):
    b = Builder(f"shrine.{part}.mesh", algae=0.8, silt=1.0, silt_height=0.9)
    inner, _ = passage(b, XS, tunnel_shape, open_ends=(False, True))
    # A rock face round the mouth, bulging out towards the plaza (-X), down to a skirt in the silt.
    ring = inner[0]
    rings = [ring]
    # The outline is a lumpy ellipse; the face bulges towards the plaza and its rim curls back (+X)
    # into the lake bed, so no straight edge shows.
    for k in range(1, 9):
        t = k / 8
        row = []
        for i, (x, y, z) in enumerate(ring):
            dz, dy = z, y - 1.5
            angle = math.atan2(dy, dz)
            reach = 1 + 0.18 * noise.noise(Vector((math.cos(angle) * 1.5, math.sin(angle) * 1.5, 7.7)))
            s = (math.hypot(dz / 4.6, dy / (4.0 if dy > 0 else 1.6)) or 1.0) / reach
            pz, py = lerp(z, dz / s, t), lerp(y, 1.5 + dy / s, t)
            if dy < 0:  # the floor apron slopes gently down into the plaza silt
                py = min(py, 0.0) - 0.35 * t * t
            bulge = math.sin(math.pi * min(1.0, t * 1.3)) * (0.3 + 0.6 * clamp(0.5 + noise.noise(Vector((pz * 0.7, py * 0.7, 3.3)))))
            row.append((-2 - bulge + 1.6 * t ** 3 * (0.0 if dy < 0 else 1.0), py, pz))
        rings.append(row)
    b.grid(rings, "rock", lambda c: (-1, 0.3, 0), wrap=True, uv_scale=0.35)
    b.finish(col, root)
    # The light shaft: a faint, open-ended slanting beam falling onto the plaza in front of the mouth.
    s = Builder(f"shrine.{part}.shaft", algae=0.0, silt=0.0)
    top = [(-4.6, 7.0, -0.6), (-4.0, 7.0, -0.6), (-4.0, 7.0, 0.6), (-4.6, 7.0, 0.6)]
    bottom = [(-3.6, 0.02, -1.1), (-2.4, 0.02, -1.1), (-2.4, 0.02, 1.1), (-3.6, 0.02, 1.1)]
    s.faces(top + bottom, [[i, (i + 1) % 4, 4 + (i + 1) % 4, 4 + i] for i in range(4)], "shaft", recalc=False)
    s.finish(col, root)
    empty("light-shaft", col, root, (-4.3, 7.0, 0.0))
    return {"module": {"width": CAVE["length"], "height": CAVE["vault"], "depth": CAVE["width"]},
            "tunnel": tunnel_info(-2, 2, ["+X"]),
            "lights": [{"node": "light-shaft", "kind": "spot", "position": [-4.3, 7.0, 0.0], "direction": [0.33, -0.94, 0.0],
                        "color": [0.62, 0.9, 0.85], "suggestedIntensityCandela": 40, "suggestedRange": 10}],
            "collisionProxies": cave_proxies(-2, 2)}


def build_cave_end(part, col, root):
    b = Builder(f"shrine.{part}.mesh", algae=0.4, silt=1.0, silt_height=0.9)
    inner, _ = passage(b, XS, tunnel_shape, open_ends=(True, False))
    ring = inner[-1]
    rings = [ring]
    # A rough half dome on the floor: every ring shrinks towards the floor's centre line.
    for k in range(1, 9):
        a = math.pi / 2 * (k / 8) * 0.97
        row = []
        for x, y, z in ring:
            py, pz = y * math.cos(a), z * math.cos(a)
            bump = 0.75 + 0.6 * clamp(0.5 + noise.noise(Vector((pz * 1.1, py * 1.1, 9.1))))
            row.append((2 + 1.2 * math.sin(a) * bump, py, pz))
        rings.append(row)
    b.grid(rings, "rock", lambda c: (-1, 0, 0), wrap=True, uv_scale=0.35, box_uv=True)
    tip = rings[-1]
    centre = tuple(sum(p[i] for p in tip) / len(tip) for i in range(3))
    b.faces(tip + [centre], [[i, (i + 1) % len(tip), len(tip)] for i in range(len(tip))], "rock")
    b.finish(col, root)
    return {"module": {"width": CAVE["length"], "height": CAVE["vault"], "depth": CAVE["width"]},
            "tunnel": tunnel_info(-2, 2, ["-X"]),
            "collisionProxies": cave_proxies(-2, 2) + [proxy("end-wall", "solid", (2, 0, -2.5), (3.2, CAVE["vault"], 2.5))]}


def room_blend(x):
    return 1 - smoothstep(ROOM["flat"], ROOM["length"] / 2, abs(x))


def room_shape(x):
    t = room_blend(x)
    return lerp(CAVE["width"] / 2, ROOM["width"] / 2, t), lerp(CAVE["height"], ROOM["wallHeight"], t), lerp(CAVE["vault"], ROOM["vault"], t)


def build_air_pocket(part, col, root):
    b = Builder(f"shrine.{part}.mesh", algae=0.6, silt=1.0, silt_height=0.9)
    half = ROOM["length"] / 2
    xs = [-half + ROOM["length"] * i / 32 for i in range(33)]
    passage(b, xs, room_shape, origin=0.0)
    b.finish(col, root)
    flat, w2 = ROOM["flat"], ROOM["width"] / 2
    proxies = [proxy("floor", "floor", (-half, -0.3, -w2 - 0.5), (half, 0, w2 + 0.5)),
               proxy("north-wall", "solid", (-flat, 0, -w2 - 0.5), (flat, ROOM["wallHeight"], -w2)),
               proxy("south-wall", "solid", (-flat, 0, w2), (flat, ROOM["wallHeight"], w2 + 0.5)),
               proxy("roof", "solid", (-half, ROOM["vault"], -w2 - 0.5), (half, ROOM["vault"] + 0.5, w2 + 0.5))]
    for side, name in ((-1, "west"), (1, "east")):  # the shoulders where the room narrows to the tunnel
        lo, hi = sorted((side * (flat + 0.75), side * half))
        proxies += [proxy(f"{name}-north-shoulder", "solid", (lo, 0, -w2 - 0.5), (hi, ROOM["wallHeight"], -CAVE["width"] / 2 - 0.4)),
                    proxy(f"{name}-south-shoulder", "solid", (lo, 0, CAVE["width"] / 2 + 0.4), (hi, ROOM["wallHeight"], w2 + 0.5))]
    return {"module": {"width": ROOM["length"], "height": ROOM["vault"], "depth": ROOM["width"]},
            "tunnel": {"axis": "+X", "length": ROOM["length"], "ends": ["-X", "+X"],
                       "clear": {"min": [-half, 0, -CAVE["width"] / 2], "max": [half, CAVE["height"], CAVE["width"] / 2]}},
            "airPocket": {"min": [-flat, 0, -w2], "max": [flat, ROOM["wallHeight"], w2]},
            "collisionProxies": proxies}


# ---------------------------------------------------------------- props

def rotation(yaw=0.0, pitch=0.0, roll=0.0, at=(0, 0, 0)):
    """glTF axes: yaw about +Y, pitch about +X, roll about +Z, then translate."""
    m = Matrix.Rotation(yaw, 4, "Y") @ Matrix.Rotation(pitch, 4, "X") @ Matrix.Rotation(roll, 4, "Z")
    return Matrix.Translation(Vector(at)) @ m


def build_fallen_blocks(part, col, root):
    b = Builder(f"shrine.{part}.mesh", algae=1.0, silt=1.0, silt_height=0.5)
    proxies = []
    blocks = [((1.1, 0.6, 0.6), (-0.7, 0.25, 0.2), 0.4, 0.0, 0.12), ((0.8, 0.6, 0.55), (0.5, 0.2, -0.45), -0.9, 0.18, 0.0),
              ((0.9, 0.42, 0.75), (0.35, 0.12, 0.6), 1.3, 0.0, -0.32)]
    for i, (size, at, yaw, pitch, roll) in enumerate(blocks):
        h = [s / 2 for s in size]
        made = b.block((-h[0], -h[1], -h[2]), (h[0], h[1], h[2]), "limestone", 0.04, f"fallen{i}", 0.85 + 0.15 * rnd("ft", i), 3.0)
        b.transform(made, rotation(yaw, pitch, roll, at))
        r = max(size) / 2
        proxies.append(proxy(f"block.{i}", "solid", (at[0] - r * 0.8, 0, at[2] - r * 0.8), (at[0] + r * 0.8, at[1] + h[1], at[2] + r * 0.8)))
    drum = fluted(b, -0.36, 0.36, 0.26, 0.26, "fallen-drum", tint=0.9)
    b.transform(drum, rotation(0.35, 0.0, math.pi / 2, (-0.35, 0.2, -0.75)))
    proxies.append(proxy("drum", "solid", (-0.75, 0, -1.05), (0.05, 0.46, -0.45)))
    b.finish(col, root)
    return {"footprint": {"width": 2.4, "depth": 2.2, "height": 0.9}, "collisionProxies": proxies}


def build_hanging_weed(part, col, root):
    b = Builder(f"shrine.{part}.mesh", algae=0.0, silt=0.0)
    for i in range(9):
        a = 2 * math.pi * rnd("weed", i, "a")
        d = 0.12 * math.sqrt(rnd("weed", i, "d"))
        x, z = d * math.cos(a), d * math.sin(a)
        length = 0.7 + 0.9 * rnd("weed", i, "l")
        width = 0.04 + 0.04 * rnd("weed", i, "w")
        turn = 2 * math.pi * rnd("weed", i, "t")
        sway = 0.12 + 0.12 * rnd("weed", i, "s")
        rows = []
        for k in range(13):
            t = k / 12
            y = -length * t
            off = sway * math.sin(t * math.pi * 1.6 + turn) * t
            yaw = turn + 1.2 * t
            cx, cz = x + off * math.cos(turn), z + off * math.sin(turn)
            w = width * (0.6 + 0.6 * math.sin(math.pi * min(1.0, t * 1.15)))
            rows.append([(cx - w * math.cos(yaw), y, cz - w * math.sin(yaw)), (cx + w * math.cos(yaw), y, cz + w * math.sin(yaw))])
        b.grid(rows, "weed", lambda c: (0, 0, 1), tint=0.8 + 0.3 * rnd("weed", i, "c"), uv_scale=1.0)
    b.lathe([(0.0, 0.0), (0.14, 0.0), (0.1, -0.05), (0.0, -0.07)], (0, 0, 0), 10, "weed", 0.55, key="holdfast")
    b.finish(col, root)
    return {"footprint": {"width": 0.9, "depth": 0.9, "height": 1.6},
            "anchor": {"at": "top", "position": [0, 0, 0], "hangs": "-Y"}, "collisionProxies": []}


def build_silt_drift(part, col, root):
    b = Builder(f"shrine.{part}.mesh", algae=0.15, silt=1.0, silt_height=5.0)
    lx, lz, rings, around = 2.8, 1.8, 14, 48
    rows = []
    for i in range(rings + 1):  # rings of a lumpy ellipse from the crest out to a rim sunk below y = 0
        r = 0.02 + 0.98 * i / rings
        row = []
        for j in range(around):
            a = 2 * math.pi * j / around
            edge = 1 + 0.15 * noise.noise(Vector((math.cos(a) * 1.4, math.sin(a) * 1.4, 6.6)))
            x, z = math.cos(a) * r * edge * lx / 2, math.sin(a) * r * edge * lz / 2
            lump = 0.65 + 0.35 * noise.noise(Vector((x * 1.1, z * 1.1, 4.2)))
            ripple = 0.06 * math.sin(x * 11 + 2.5 * noise.noise(Vector((x, z, 1.7))))
            row.append((x, -0.04 + 0.3 * (1 - r * r) ** 1.5 * (lump + ripple), z))
        rows.append(row)
    b.grid(rows, "limestone", lambda c: (0, 1, 0), wrap=True, uv_scale=0.5, box_uv=True)
    crest = rows[0]
    top = tuple(sum(p[k] for p in crest) / len(crest) for k in range(3))
    b.faces(crest + [top], [[j, (j + 1) % around, around] for j in range(around)], "limestone")
    b.finish(col, root)
    return {"footprint": {"width": lx, "depth": lz, "height": 0.3}, "collisionProxies": []}


def build_shells(part, col, root):
    b = Builder(f"shrine.{part}.mesh", algae=0.7, silt=0.6, silt_height=0.3)
    stone, surface = b.blob((0, 0.12, 0), 0.24, (1.3, 0.75, 1.0), "shell-stone", "rock", 0.25)
    for i in range(16):  # barnacles on the stone's upper half
        a = 2 * math.pi * rnd("barnacle", i, "a")
        e = 0.25 + 1.0 * rnd("barnacle", i, "e")
        d = Vector((math.cos(a) * math.cos(e), math.sin(e), math.sin(a) * math.cos(e))).normalized()
        r = surface(d)
        p = Vector((d.x * r * 1.3, 0.12 + d.y * r * 0.75, d.z * r))
        s = 0.6 + 0.6 * rnd("barnacle", i, "s")
        b.lathe([(0.026 * s, -0.01), (0.026 * s, 0.0), (0.012 * s, 0.03 * s), (0.008 * s, 0.022 * s), (0.0, 0.018 * s)],
                (0, 0, 0), 8, "barnacle", 0.9, key=f"barnacle{i}", axis=(tuple(p), tuple(d)))
    for i in range(5):  # clam shells round the stone's foot
        a = 2 * math.pi * (i + rnd("clam", i, "a") * 0.6) / 5
        R = 0.06 + 0.04 * rnd("clam", i, "r")
        rows = []
        for k in range(9):
            t = k / 8
            row = []
            for j in range(13):
                f = math.radians(-70 + 140 * j / 12)
                h = R * 0.45 * (1 - t * t) * (1 + 0.12 * math.cos(9 * f * 2))
                row.append((t * R * math.sin(f), h, t * R * math.cos(f)))
            rows.append(row)
        made = b.grid(rows, "shell", lambda c: (0, 1, 0), uv_scale=2.0)
        dist = 0.36 + 0.06 * rnd("clam", i, "d")
        b.transform(made, rotation(a + math.pi / 2 + rnd("clam", i, "y"), 0.25 * (rnd("clam", i, "p") - 0.5), 0.0,
                                   (dist * math.cos(a), 0.0, dist * math.sin(a))))
    b.finish(col, root)
    return {"footprint": {"width": 0.9, "depth": 0.8, "height": 0.3}, "collisionProxies": []}


BUILDERS = {"wall": build_wall, "arch": build_arch, "pillar": build_pillar, "pillar-broken": build_pillar_broken,
            "floor": build_floor, "altar": build_altar, "cave-mouth": build_cave_mouth, "cave-tunnel": build_cave_tunnel,
            "cave-end": build_cave_end, "air-pocket": build_air_pocket, "fallen-blocks": build_fallen_blocks,
            "hanging-weed": build_hanging_weed, "silt-drift": build_silt_drift, "shells": build_shells}


def build(part, collection, location=(0, 0, 0)):
    """Build one module under an empty root ``shrine.<part>`` at ``location`` (glTF axes)."""
    if part not in BUILDERS:
        raise ValueError(f"shrine part must be one of {', '.join(PARTS)}")
    root = bpy.data.objects.new(f"shrine.{part}", None)
    root.empty_display_size = 0.3
    collection.objects.link(root)
    info = BUILDERS[part](part, collection, root)
    root.location = to_blender(location)
    return root, info


def generate(output_path, arguments, inputs):
    if not isinstance(arguments, dict) or set(arguments) != {"schemaVersion", "part"} or arguments["schemaVersion"] != 1:
        raise ValueError("shrine arguments must be exactly {schemaVersion: 1, part}")
    if set(inputs) != {"common"}:
        raise ValueError("shrine recipe takes exactly kit_common.py as its input 'common'")
    use_common(inputs.load_source("common"))
    part = arguments["part"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    root, info = build(part, bpy.context.scene.collection)
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
        export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "shrine-v1", "part": part, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "module-base-center", "facing": "+Z", "triangleCount": triangles, "bounds": bounds, **info}
