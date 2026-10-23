"""Undead crypt environment kit, an original scripted kit for the existing pinned Blender script backend.

One run builds one module of the kit (#269). Style: docs/style-humanlike.md (bevelled hard
edges, real-world proportions), plus small tileable textures generated here with numpy, because
the crypt bundle ships game-resolution textures. Cold grey-blue stone, mossy green grime from
vertex colours (glTF COLOR_0 multiplies the base colour) and warm candle accents.

Frame, shared by every module: metres, glTF right-handed +Y up, origin at the module's base
centre on the floor plane (y = 0), the wall's front face towards +Z. Grid:

- walls are 3.0 m high and 0.5 m thick (z -0.25..0.25), built from 6 stone courses whose joints
  are shared by every wall module, so neighbours line up;
- ``wall``: one 2 m module (x -1..1);
- ``doorway-narrow``: a 2 m module with a 1.0 x 2.2 m opening and a lintel up to 2.6 m;
- ``doorway-wide``: a 4 m module (x -2..2) with a 2.0 x 2.6 m opening and a lintel up to 3.0 m;
- ``door``: the leaf for the narrow doorway, 0.98 x 2.18 x 0.07 m. Its hinge axis is the origin
  (+Y), the leaf is closed along +X and the GLB has an empty node ``hinge`` at the origin. It
  mounts in ``doorway-narrow`` at (-0.49, 0.01, 0);
- ``floor``: a 2 x 2 m tile (x, z -1..1) of flagstones whose top is at y = 0, 0.2 m thick;
- ``pillar``: 0.8 x 0.8 m, 3.0 m high;
- ``sarcophagus``: a 2.3 x 1.05 m plinth, 1.18 m high; the lid is a separate node ``lid``, a
  little askew;
- ``candles``: a cluster of candles on a wax puddle, with an empty node ``flame.<n>`` at every
  flame for the consumer's point lights;
- ``bones``: a pile of skulls and long bones.

No randomness: every variation comes from a SHA-256 of fixed keys, and the textures from numpy's
legacy ``RandomState``, which is stable across numpy versions. Every module that uses stone embeds
the same stone PNG bytes, so a ``gltf-resources-v1`` bundle stores them once.

``build(part, collection, location)`` also works in a live Blender session; ``generate`` is the
script-backend entry point and returns the recipe's collision proxies, doorway, hinge, mount and
light observations alongside the measured bounds.
"""
import hashlib
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector, noise

PARTS = ("wall", "doorway-narrow", "doorway-wide", "door", "floor", "pillar", "sarcophagus", "candles", "bones")
WALL_H, WALL_T, GAP = 3.0, 0.5, 0.012
COURSES = (0.0, 0.55, 1.1, 1.65, 2.2, 2.6, 3.0)
DOORWAYS = {
    "doorway-narrow": {"module": 2.0, "width": 1.0, "height": 2.2, "lintelTop": 2.6},
    "doorway-wide": {"module": 4.0, "width": 2.0, "height": 2.6, "lintelTop": 3.0},
}
LEAF = {"width": 0.98, "height": 2.18, "thickness": 0.07, "mount": (-0.49, 0.01, 0.0)}
TEXTURE = {"stone": 1024, "wood": 512}
SHARP_ANGLE = math.radians(35)

# name: (sRGB base colour, metallic, roughness, emission strength); textured ones use the maps.
MATERIALS = {
    "stone": ((1, 1, 1), 0.0, 1.0, 0.0),
    "mortar": ((0.16, 0.17, 0.17), 0.0, 0.95, 0.0),
    "wood": ((1, 1, 1), 0.0, 1.0, 0.0),
    "iron": ((0.22, 0.21, 0.2), 1.0, 0.55, 0.0),
    "bone": ((0.78, 0.73, 0.6), 0.0, 0.7, 0.0),
    "wax": ((0.86, 0.8, 0.64), 0.0, 0.45, 0.0),
    "wick": ((0.04, 0.03, 0.03), 0.0, 0.9, 0.0),
    "flame": ((1.0, 0.62, 0.22), 0.0, 1.0, 1.0),  # emissiveFactor only: no KHR_materials_emissive_strength
}


def rnd(*keys):
    """A deterministic float in [0, 1) for the given keys."""
    digest = hashlib.sha256("/".join(str(k) for k in keys).encode("ascii")).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def lerp(a, b, t):
    return a + (b - a) * t


def to_blender(point):
    x, y, z = point
    return Vector((x, -z, y))


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


# ---------------------------------------------------------------- textures (numpy, tileable)

def periodic_noise(size, cells, seed):
    """Smooth value noise on a torus: tiles in both directions."""
    grid = np.random.RandomState(seed).rand(cells[1], cells[0])
    def axis(n, c):
        t = np.arange(n) * c / n
        i0 = np.floor(t).astype(int)
        f = t - i0
        return i0 % c, (i0 + 1) % c, f * f * (3 - 2 * f)
    x0, x1, fx = axis(size, cells[0])
    y0, y1, fy = axis(size, cells[1])
    a = grid[np.ix_(y0, x0)] * (1 - fx) + grid[np.ix_(y0, x1)] * fx
    b = grid[np.ix_(y1, x0)] * (1 - fx) + grid[np.ix_(y1, x1)] * fx
    return a * (1 - fy)[:, None] + b * fy[:, None]


def fbm(size, base, octaves, seed, stretch=(1, 1)):
    total, weight, amp = np.zeros((size, size)), 0.0, 1.0
    for o in range(octaves):
        c = base * 2**o
        total += amp * periodic_noise(size, (c * stretch[0], c * stretch[1]), seed + o)
        weight += amp
        amp *= 0.5
    return total / weight


def normal_map(height, strength):
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * strength
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * strength
    n = np.stack([-dx, -dy, np.ones_like(height)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def stone_maps(size):
    broad = fbm(size, 4, 5, 11)
    fine = fbm(size, 32, 3, 31)
    pits = np.clip((fbm(size, 16, 3, 51) - 0.62) * 6, 0, 1)
    cracks = np.clip(1 - np.abs(fbm(size, 6, 4, 71) - 0.5) * 40, 0, 1) * np.clip((fbm(size, 3, 2, 91) - 0.45) * 5, 0, 1)
    height = broad * 0.6 + fine * 0.4 - pits * 0.5 - cracks * 0.6
    shade = 0.82 + (broad - 0.5) * 0.5 + (fine - 0.5) * 0.25 - pits * 0.25 - cracks * 0.35
    cold = np.array([0.47, 0.5, 0.55])
    speckle = (periodic_noise(size, (256, 256), 101) > 0.9) * 0.06
    colour = np.clip(cold[None, None, :] * shade[..., None] + speckle[..., None], 0, 1)
    ao = np.clip(1 - pits * 0.5 - cracks * 0.6, 0, 1)
    rough = np.clip(0.82 + (fine - 0.5) * 0.2 + pits * 0.1, 0, 1)
    orm = np.stack([ao, rough, np.zeros_like(ao)], -1)
    return colour, normal_map(height, 3.0), orm


def wood_maps(size):
    grain = fbm(size, 2, 5, 211, stretch=(8, 1))
    streak = periodic_noise(size, (48, 2), 231)
    knots = np.clip((fbm(size, 4, 2, 251) - 0.7) * 5, 0, 1)
    shade = 0.75 + (grain - 0.5) * 0.7 + (streak - 0.5) * 0.25 - knots * 0.3
    base = np.array([0.3, 0.21, 0.14])
    colour = np.clip(base[None, None, :] * shade[..., None], 0, 1)
    height = grain * 0.6 + streak * 0.4 - knots * 0.3
    rough = np.clip(0.78 + (streak - 0.5) * 0.2, 0, 1)
    orm = np.stack([np.ones_like(rough), rough, np.zeros_like(rough)], -1)
    return colour, normal_map(height, 2.0), orm


def make_image(name, pixels, colour):
    size = pixels.shape[0]
    image = bpy.data.images.get(name)
    if image is None or tuple(image.size) != (size, size):
        if image is not None:
            bpy.data.images.remove(image)
        image = bpy.data.images.new(name, size, size, alpha=False)
    image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    rgba = np.concatenate([pixels, np.ones(pixels.shape[:2] + (1,))], -1).astype(np.float32)
    image.pixels.foreach_set(rgba[::-1].ravel())  # Blender rows run bottom-up
    image.file_format = "PNG"
    image.pack()
    return image


def material(name):
    existing = bpy.data.materials.get(f"crypt-{name}")
    if existing is not None:
        return existing
    colour, metallic, roughness, emission = MATERIALS[name]
    mat = bpy.data.materials.new(f"crypt-{name}")
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
    vcol = nodes.new("ShaderNodeVertexColor")
    vcol.layer_name = "Col"
    if name in TEXTURE:
        maps = (stone_maps if name == "stone" else wood_maps)(TEXTURE[name])
        images = [make_image(f"crypt-{name}-{kind}", data, kind == "color") for kind, data in zip(("color", "normal", "orm"), maps)]
        tex = []
        for image in images:
            node = nodes.new("ShaderNodeTexImage")
            node.image = image
            tex.append(node)
        mix = nodes.new("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        links.new(tex[0].outputs["Color"], mix.inputs[6])
        links.new(vcol.outputs["Color"], mix.inputs[7])
        links.new(mix.outputs[2], bsdf.inputs["Base Color"])
        nmap = nodes.new("ShaderNodeNormalMap")
        links.new(tex[1].outputs["Color"], nmap.inputs["Color"])
        links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        sep = nodes.new("ShaderNodeSeparateColor")
        links.new(tex[2].outputs["Color"], sep.inputs["Color"])
        links.new(sep.outputs[1], bsdf.inputs["Roughness"])
        links.new(sep.outputs[2], bsdf.inputs["Metallic"])
    elif name not in ("flame", "wick"):
        mix = nodes.new("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs[6].default_value = linear
        links.new(vcol.outputs["Color"], mix.inputs[7])
        links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    return mat


# ---------------------------------------------------------------- geometry

class Builder:
    """One mesh in glTF axes; per face a material, box-projected UVs and a grime weight."""

    def __init__(self, name, moss=1.0):
        self.name = name
        self.moss = moss
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.tint = self.bm.faces.layers.float.new("tint")
        self.materials = []

    def slot(self, name):
        if name not in self.materials:
            self.materials.append(name)
        return self.materials.index(name)

    def faces(self, verts, quads, mat, tint=1.0, uv_offset=(0, 0), uv_scale=0.6):
        bverts = [self.bm.verts.new(to_blender(p)) for p in verts]
        made = [self.bm.faces.new([bverts[i] for i in q]) for q in quads]
        bmesh.ops.recalc_face_normals(self.bm, faces=made)
        for f in made:
            f.material_index = self.slot(mat)
            f[self.tint] = tint
            n = f.normal
            axis = max(range(3), key=lambda i: abs(n[i]))
            u_axis, v_axis = [(1, 2), (0, 2), (0, 1)][axis]
            for loop in f.loops:
                co = loop.vert.co
                loop[self.uv].uv = (co[u_axis] * uv_scale + uv_offset[0], co[v_axis] * uv_scale + uv_offset[1])
        return made

    def block(self, lo, hi, mat="stone", chamfer=0.03, key="", tint=1.0, chip=0.0):
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

    def lathe(self, profile, centre=(0, 0, 0), segments=12, mat="stone", tint=1.0, key="", axis=None, smooth=True):
        """Revolve [(radius, height)] around +Y (or around ``axis`` = (origin, direction))."""
        verts, quads, rings = [], [], []
        for r, y in profile:
            ring = []
            for s in range(segments):
                a = 2 * math.pi * (s + 0.5) / segments
                ring.append(len(verts))
                verts.append((r * math.cos(a), y, r * math.sin(a)))
            rings.append(ring)
        for ra, rb in zip(rings, rings[1:]):
            for s in range(segments):
                t = (s + 1) % segments
                quads.append([ra[s], ra[t], rb[t], rb[s]])
        if profile[0][0] > 0:
            quads.append(list(reversed(rings[0])))
        if profile[-1][0] > 0:
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
                n = noise.noise(Vector((p.x * 1.7, p.y * 1.7, p.z * 1.7)) + Vector((13.1, 7.7, 3.3)))
                patch = max(0.0, min(1.0, 0.5 + n * 1.4))
                height = max(0.0, 1 - (p.z + location[2]) / 1.6)
                m = self.moss * min(1.0, height * height * 0.7 * patch + max(0.0, up) * 0.45 * patch + 0.08)
                grime = 1 - 0.18 * max(0.0, 1 - (p.z + location[2]) / 0.4) * self.moss
                t = f[self.tint] * grime
                moss = (0.55, 0.72, 0.42)
                loop[col] = (t * lerp(1, moss[0], m), t * lerp(1, moss[1], m), t * lerp(1, moss[2], m), 1.0)
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


def empty(name, collection, parent, point=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 0.15
    obj.location = to_blender(point)
    collection.objects.link(obj)
    obj.parent = parent
    return obj


def course_joints(part, module, course):
    """Block joints of one course across a module: lengths 0.55..1.25 m, staggered by course."""
    joints, x, i = [-module / 2], -module / 2 + (0.35 + 0.5 * rnd(part, course, "first")) * (1 if course % 2 else 1.6), 0
    while x < module / 2 - 0.4:
        joints.append(x)
        i += 1
        x += 0.55 + 0.7 * rnd(part, course, i)
    joints.append(module / 2)
    return joints


def wall_blocks(b, part, module, opening=None):
    """Courses of ashlar blocks, cut around ``opening`` = (x0, x1, top, lintel top)."""
    half_t = WALL_T / 2
    core = [(-module / 2 + 0.02, module / 2 - 0.02, 0.0)]
    if opening:
        ox0, ox1, top, lintel = opening
        core = [(-module / 2 + 0.02, ox0 - 0.02, 0.0), (ox1 + 0.02, module / 2 - 0.02, 0.0), (ox0 - 0.02, ox1 + 0.02, top + 0.02)]
    for i, (x0, x1, y0) in enumerate(core):
        b.block((x0, y0, -half_t + 0.03), (x1, WALL_H - 0.02, half_t - 0.03), "mortar", 0.005, f"{part}/core{i}")

    def outside(spans, lo, hi):
        rest = []
        for x0, x1 in spans:
            for a0, a1 in ((x0, min(x1, lo)), (max(x0, hi), x1)):
                if a1 - a0 > 0.04:
                    rest.append((a0, a1))
        return rest

    for course, (y0, y1) in enumerate(zip(COURSES, COURSES[1:])):
        joints = course_joints(part, module, course)
        spans = list(zip(joints, joints[1:]))
        if opening:
            if y1 <= top + 1e-6:  # jamb courses: dressed quoins, alternating long and short
                quoin = 0.45 if course % 2 else 0.3
                q0, q1 = ox0 - quoin, ox1 + quoin
                q0 = -module / 2 if q0 + module / 2 < 0.18 else q0  # no slivers at the module edge
                q1 = module / 2 if module / 2 - q1 < 0.18 else q1
                spans = sorted(outside(spans, q0, q1) + [(q0, ox0), (ox1, q1)])
            elif y1 <= lintel + 1e-6:  # the lintel course
                lx0, lx1 = max(ox0 - 0.35, -module / 2), min(ox1 + 0.35, module / 2)
                spans = outside(spans, lx0, lx1)
                b.block((lx0 + GAP / 2, y0 + GAP / 2, -half_t - 0.02), (lx1 - GAP / 2, y1 - GAP / 2, half_t + 0.02),
                        "stone", 0.04, f"{part}/lintel", 0.92, 0.6)
        for x0, x1 in spans:
            key = f"{part}/{course}/{x0:.3f}"
            out = (rnd(key, "out") - 0.5) * 0.03
            tint = 0.8 + 0.3 * rnd(key, "tint")
            b.block((x0 + GAP / 2, y0 + GAP / 2, -half_t + out * 0.5), (x1 - GAP / 2, y1 - GAP / 2, half_t + out),
                    "stone", 0.025 + 0.02 * rnd(key, "c"), key, tint, 1.0)


def proxy(name, tag, lo, hi):
    return {"name": name, "tag": tag, "center": [round((lo[i] + hi[i]) / 2, 6) for i in range(3)],
            "size": [round(hi[i] - lo[i], 6) for i in range(3)]}


def build_wall(part, col, root):
    module = 2.0
    b = Builder(f"crypt.{part}.mesh")
    wall_blocks(b, part, module)
    b.finish(col, root)
    h = WALL_T / 2 + 0.02
    return {"module": {"width": module, "height": WALL_H, "depth": WALL_T},
            "collisionProxies": [proxy("wall", "solid", (-1, 0, -h), (1, WALL_H, h))]}


def build_doorway(part, col, root):
    d = DOORWAYS[part]
    module, w = d["module"], d["width"]
    b = Builder(f"crypt.{part}.mesh")
    wall_blocks(b, part, module, (-w / 2, w / 2, d["height"], d["lintelTop"]))
    b.finish(col, root)
    h = WALL_T / 2 + 0.02
    proxies = [proxy("left-jamb", "solid", (-module / 2, 0, -h), (-w / 2, WALL_H, h)),
               proxy("right-jamb", "solid", (w / 2, 0, -h), (module / 2, WALL_H, h)),
               proxy("lintel", "solid", (-w / 2, d["height"], -h), (w / 2, WALL_H, h))]
    out = {"module": {"width": module, "height": WALL_H, "depth": WALL_T},
           "doorway": {"center": [0, d["height"] / 2, 0], "width": w, "height": d["height"], "depth": WALL_T,
                       "min": [-w / 2, 0, -WALL_T / 2], "max": [w / 2, d["height"], WALL_T / 2]},
           "collisionProxies": proxies}
    if part == "doorway-narrow":
        out["mount"] = {"door": "crypt.kit.door", "translation": list(LEAF["mount"])}
    return out


def build_door(part, col, root):
    W, H, T = LEAF["width"], LEAF["height"], LEAF["thickness"]
    b = Builder("crypt.door.mesh", moss=0.5)
    planks = 5
    for i in range(planks):
        x0, x1 = W * i / planks, W * (i + 1) / planks
        key = f"door/{i}"
        b.block((x0 + 0.003, 0, -T / 2), (x1 - 0.003, H - 0.01 * rnd(key, "h"), T / 2), "wood", 0.008, key, 0.85 + 0.25 * rnd(key, "t"))
    for y in (0.3, H - 0.35):
        b.block((-0.04, y, T / 2), (W - 0.06, y + 0.07, T / 2 + 0.012), "iron", 0.004, f"strap{y}")
        b.block((-0.04, y, -T / 2 - 0.012), (W - 0.06, y + 0.07, -T / 2), "iron", 0.004, f"strapb{y}")
        b.lathe([(0.0, y - 0.01), (0.022, y - 0.01), (0.022, y + 0.08), (0.0, y + 0.08)], (0, 0, 0), 10, "iron", key=f"knuckle{y}")
        for k in range(6):
            x = 0.08 + k * (W - 0.2) / 5
            b.lathe([(0.012, 0), (0.012, 0.008), (0.0, 0.016)], (0, 0, 0), 6, "iron", key=f"stud{y}{k}",
                    axis=((x, y + 0.035, T / 2 + 0.01), (0, 0, 1)))
    ring_c = (W - 0.16, 1.0, T / 2 + 0.02)
    b.block((ring_c[0] - 0.04, ring_c[1] - 0.04, T / 2), (ring_c[0] + 0.04, ring_c[1] + 0.04, T / 2 + 0.012), "iron", 0.006, "plate")
    seg = 14
    for k in range(seg):
        a0, a1 = 2 * math.pi * k / seg, 2 * math.pi * (k + 1) / seg
        p0 = (ring_c[0] + 0.06 * math.sin(a0), ring_c[1] - 0.06 + 0.06 * math.cos(a0), ring_c[2] + 0.01)
        p1 = (ring_c[0] + 0.06 * math.sin(a1), ring_c[1] - 0.06 + 0.06 * math.cos(a1), ring_c[2] + 0.01)
        length = math.dist(p0, p1)
        b.lathe([(0.008, 0), (0.008, length)], (0, 0, 0), 6, "iron", key=f"ring{k}", axis=(p0, tuple(p1[i] - p0[i] for i in range(3))))
    b.finish(col, root)
    empty("hinge", col, root)
    lo, hi = (-0.03, 0, -T / 2 - 0.02), (W, H, T / 2 + 0.03)
    return {"hinge": {"node": "hinge", "position": [0, 0, 0], "axis": [0, 1, 0], "closedAlong": "+X",
                      "opensTowards": "-Z", "openAngle": round(math.pi / 2, 6)},
            "mount": {"parent": "crypt.kit.doorway-narrow", "translation": list(LEAF["mount"])},
            "collisionProxies": [proxy("door", "dynamic-door", lo, hi)]}


def build_floor(part, col, root):
    b = Builder("crypt.floor.mesh", moss=0.5)
    b.block((-0.99, -0.2, -0.99), (0.99, -0.05, 0.99), "mortar", 0.005, "bed")
    rows = [(-1.0, 0.1, (-1.0, -0.25, 1.0)), (0.1, 1.0, (-1.0, 0.4, 1.0))]
    for r, (z0, z1, xs) in enumerate(rows):
        for x0, x1 in zip(xs, xs[1:]):
            key = f"floor/{r}/{x0}"
            top = -0.012 * rnd(key, "top")
            b.block((x0 + GAP / 2, -0.15, z0 + GAP / 2), (x1 - GAP / 2, top, z1 - GAP / 2), "stone", 0.02, key, 0.75 + 0.25 * rnd(key, "t"), 1.0)
    b.finish(col, root)
    return {"module": {"width": 2.0, "depth": 2.0, "height": 0.2, "top": 0.0},
            "collisionProxies": [proxy("floor", "floor", (-1, -0.2, -1), (1, 0, 1))]}


def build_pillar(part, col, root):
    b = Builder("crypt.pillar.mesh")
    b.block((-0.4, 0, -0.4), (0.4, 0.3, 0.4), "stone", 0.03, "plinth", 0.85, 1.0)
    b.block((-0.32, 0.3, -0.32), (0.32, 0.45, 0.32), "stone", 0.04, "torus", 0.9, 1.0)
    drums = [0.45, 1.15, 1.85, 2.55]
    for i, (y0, y1) in enumerate(zip(drums, drums[1:])):
        r0, r1 = lerp(0.25, 0.22, (y0 - 0.45) / 2.1), lerp(0.25, 0.22, (y1 - 0.45) / 2.1)
        b.lathe([(r0 - 0.012, y0 + 0.004), (r0, y0 + 0.016), (r1, y1 - 0.016), (r1 - 0.012, y1 - 0.004)], (0, 0, 0), 8, "stone",
                0.8 + 0.25 * rnd("drum", i), key=f"drum{i}", smooth=False)
    b.lathe([(0.23, 2.55), (0.3, 2.62), (0.34, 2.75)], (0, 0, 0), 8, "stone", 0.9, key="capital", smooth=False)
    b.block((-0.4, 2.75, -0.4), (0.4, 3.0, 0.4), "stone", 0.03, "abacus", 0.85, 1.0)
    b.finish(col, root)
    return {"footprint": {"width": 0.8, "depth": 0.8, "height": WALL_H},
            "collisionProxies": [proxy("pillar", "solid", (-0.4, 0, -0.4), (0.4, WALL_H, 0.4))]}


def build_sarcophagus(part, col, root):
    b = Builder("crypt.sarcophagus.mesh", moss=0.8)
    b.block((-1.15, 0, -0.525), (1.15, 0.14, 0.525), "stone", 0.03, "s-plinth", 0.8, 1.0)
    b.block((-1.05, 0.14, -0.45), (1.05, 0.8, 0.45), "stone", 0.025, "s-chest", 0.95, 0.5)
    b.block((-1.09, 0.72, -0.49), (1.09, 0.82, 0.49), "stone", 0.02, "s-band", 0.9, 1.0)
    for i, x in enumerate((-0.68, 0.0, 0.68)):  # recessed-looking raised panels
        b.block((x - 0.26, 0.26, 0.45), (x + 0.26, 0.64, 0.47), "stone", 0.012, f"s-panel{i}", 0.85)
        b.block((x - 0.26, 0.26, -0.47), (x + 0.26, 0.64, -0.45), "stone", 0.012, f"s-panelb{i}", 0.85)
    b.finish(col, root)
    lid = Builder("crypt.sarcophagus.lid", moss=0.8)
    lid.block((-1.12, 0, -0.5), (1.12, 0.14, 0.5), "stone", 0.03, "lid", 0.9, 1.0)
    # a low gabled top: ridge along X
    ridge = [(-1.0, 0.14, -0.42), (1.0, 0.14, -0.42), (1.0, 0.14, 0.42), (-1.0, 0.14, 0.42), (-0.92, 0.36, 0.0), (0.92, 0.36, 0.0)]
    lid.faces(ridge, [[0, 1, 2, 3], [0, 4, 5, 1], [3, 2, 5, 4], [0, 3, 4], [1, 5, 2]], "stone", 0.88, (0.3, 0.6))
    lid_root = lid.finish(col, root, location=(0, 0, 0.82))
    lid_root.name = "lid"
    lid_root.location = to_blender((0.06, 0.82, 0.03))
    lid_root.rotation_euler = (0, 0, math.radians(-3))
    return {"footprint": {"width": 2.3, "depth": 1.05, "height": 1.18},
            "lid": {"node": "lid", "translation": [0.06, 0.82, 0.03], "yawDegrees": -3},
            "collisionProxies": [proxy("sarcophagus", "solid", (-1.15, 0, -0.525), (1.15, 1.18, 0.525))]}


CANDLES = [  # x, z, radius, height
    (0.0, 0.0, 0.04, 0.32), (0.09, 0.05, 0.032, 0.22), (-0.08, 0.06, 0.03, 0.18),
    (0.05, -0.09, 0.028, 0.14), (-0.1, -0.06, 0.035, 0.26), (0.15, -0.03, 0.022, 0.09)]


def build_candles(part, col, root):
    b = Builder("crypt.candles.mesh", moss=0.0)
    b.lathe([(0.0, 0.0), (0.2, 0.0), (0.185, 0.01), (0.1, 0.02), (0.0, 0.026)], (0.02, 0, 0), 16, "wax", key="puddle")
    flames = []
    for i, (x, z, r, h) in enumerate(CANDLES):
        drip = 1.12 + 0.1 * rnd("candle", i)
        b.lathe([(r * drip, 0.0), (r * drip, 0.02), (r, 0.04), (r, h - 0.01), (r * 0.85, h), (r * 0.55, h - 0.008), (0.0, h - 0.008)],
                (x, 0, z), 10, "wax", key=f"candle{i}")
        b.lathe([(0.003, h - 0.01), (0.003, h + 0.015)], (x, 0, z), 4, "wick", key=f"wick{i}")
        f0 = h + 0.012
        b.lathe([(0.0, f0), (0.009, f0 + 0.012), (0.011, f0 + 0.025), (0.006, f0 + 0.045), (0.0, f0 + 0.065)], (x, 0, z), 8, "flame", key=f"flame{i}")
        flames.append([x, round(f0 + 0.025, 6), z])
    b.finish(col, root)
    for i, p in enumerate(flames):
        empty(f"flame.{i}", col, root, p)
    return {"footprint": {"width": 0.5, "depth": 0.5, "height": 0.4},
            "lights": [{"node": f"flame.{i}", "position": p, "color": [1.0, 0.62, 0.3], "suggestedIntensityCandela": 3,
                        "suggestedRange": 6} for i, p in enumerate(flames)],
            "collisionProxies": []}


def skull(b, centre, yaw, key):
    """A skull built facing +Z around its base, then turned by ``yaw`` and moved to ``centre``."""
    prof = [(0.0, 0.0), (0.05, 0.01), (0.075, 0.05), (0.08, 0.09), (0.07, 0.13), (0.04, 0.155), (0.0, 0.16)]
    faces = b.lathe(prof, (0, 0, -0.01), 10, "bone", 0.95, key=key)
    cranium = {v for f in faces for v in f.verts}
    for v in cranium:  # longer front to back, narrower side to side (Blender -Y is glTF +Z)
        v.co.y *= 1.15
        v.co.x *= 0.9
    faces += b.block((-0.045, 0.0, 0.03), (0.045, 0.055, 0.105), "bone", 0.015, key + "jaw", 0.9)
    for side in (-1, 1):
        faces += b.lathe([(0.0, -0.016), (0.017, -0.01), (0.019, 0.0), (0.017, 0.01), (0.0, 0.016)], (0, 0, 0), 8, "wick",
                         key=key + f"eye{side}", axis=((side * 0.03, 0.085, 0.08), (0, 0, 1)))
    faces += b.lathe([(0.0, -0.01), (0.009, 0.0), (0.0, 0.01)], (0, 0, 0), 5, "wick", key=key + "nose",
                     axis=((0.0, 0.055, 0.085), (0, 0, 1)))
    turn = Vector((0, 0, 1)).rotation_difference(Vector((math.sin(yaw), 0, math.cos(yaw))))
    for v in {v for f in faces for v in f.verts}:
        g = turn @ Vector((v.co.x, v.co.z, -v.co.y)) + Vector(centre)
        v.co = to_blender(g)


def build_bones(part, col, root):
    b = Builder("crypt.bones.mesh", moss=0.35)
    for i in range(14):
        a = 2 * math.pi * rnd("bone", i, "a")
        d = 0.26 * math.sqrt(rnd("bone", i, "d"))
        length = 0.3 + 0.18 * rnd("bone", i, "l")
        yaw = math.pi * rnd("bone", i, "y")
        layer = 0.03 + 0.035 * (i // 5)
        cx, cz = d * math.cos(a), d * math.sin(a)
        dx, dz = math.cos(yaw) * length / 2, math.sin(yaw) * length / 2
        tilt = 0.04 * (rnd("bone", i, "t") - 0.5)
        p0 = (cx - dx, layer - tilt, cz - dz)
        direction = (2 * dx, 2 * tilt, 2 * dz)
        r = 0.014 + 0.006 * rnd("bone", i, "r")
        prof = [(0.0, 0.0), (r * 1.9, 0.01), (r * 2.1, 0.035), (r, 0.07), (r * 0.9, length / 2), (r, length - 0.07),
                (r * 2.1, length - 0.035), (r * 1.9, length - 0.01), (0.0, length)]
        b.lathe(prof, (0, 0, 0), 7, "bone", 0.82 + 0.2 * rnd("bone", i, "t2"), key=f"bone{i}", axis=(p0, direction))
    for i, (x, z, yaw, y) in enumerate([(0.04, 0.03, 0.3, 0.06), (-0.22, 0.14, -0.6, 0.0), (0.24, -0.16, 1.0, 0.0)]):
        skull(b, (x, y, z), yaw, f"skull{i}")
    b.finish(col, root)
    return {"footprint": {"width": 0.9, "depth": 0.9, "height": 0.3}, "collisionProxies": []}


BUILDERS = {"wall": build_wall, "doorway-narrow": build_doorway, "doorway-wide": build_doorway, "door": build_door,
            "floor": build_floor, "pillar": build_pillar, "sarcophagus": build_sarcophagus, "candles": build_candles,
            "bones": build_bones}


def build(part, collection, location=(0, 0, 0)):
    """Build one module under an empty root ``crypt.<part>`` at ``location`` (glTF axes)."""
    if part not in BUILDERS:
        raise ValueError(f"crypt part must be one of {', '.join(PARTS)}")
    root = bpy.data.objects.new(f"crypt.{part}", None)
    root.empty_display_size = 0.3
    collection.objects.link(root)
    info = BUILDERS[part](part, collection, root)
    root.location = to_blender(location)
    return root, info


def generate(output_path, arguments, inputs):
    if not isinstance(arguments, dict) or set(arguments) != {"schemaVersion", "part"} or arguments["schemaVersion"] != 1:
        raise ValueError("crypt arguments must be exactly {schemaVersion: 1, part}")
    if inputs:
        raise ValueError("crypt recipe does not accept extra resources")
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
    return {"recipe": "crypt-v1", "part": part, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "module-base-center", "facing": "+Z", "triangleCount": triangles, "bounds": bounds, **info}
