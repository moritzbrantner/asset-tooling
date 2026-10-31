"""Greyhaven conifer crown (asset-tooling#450, #454): keep the source trunk, replace its leaves with solid fir tiers.

The declared inputs are:

* ``source``: the imported CC0 Quaternius ``Pine_1`` GLB. Its bark primitive keeps the trunk; the bare branch stubs
  around the crown base are cut, so the trunk reads cleanly below the first whorl. Its leaf primitive is only measured
  (crown base, top and radius profile), then deleted and rebuilt;
* ``needles`` and ``needleAlpha``: the CC0 Poly Haven ``fir_tree_01`` twig colour and alpha maps. Four fir sprigs on
  that atlas become the card texture, as a greyscale mask, so COLOR_0 alone sets the hue. The alpha is closed (the
  gaps between needles filled) so a sprig stays solid in the MASK cut-out at a distance.

The crown is a stack of drooping tiers up the trunk, widest at the bottom and closer together towards the leader.
Each tier is an opaque *skirt* (a drooping cone with a thick, dark rim band and a hollow underside that reaches down
to the tier below), covered by needle sprig cards: lying on the skirt's top, hanging over its rim as a fringe, and
spraying out at the branch tips. Every card carries the skirt's smooth normal (lit top, shaded rim) like the #446
broadleaf, and a per-card vertex colour: dark and cool under and inside each tier, saturated green on the tier tops,
lighter at the outer, upward-facing edges.

Everything is seeded from ``arguments["seed"]``. Blender coordinates are Z up; the GLB is exported +Y up.
"""
import math
import os
import random

import bmesh
import bpy
import numpy as np
from mathutils import Color, Vector

RECIPE = "conifer-crown-v2"
SOURCE_LEAF_MATERIAL = "Leaves_Pine"
NEEDLE_MATERIAL = "Leaves_Pine"
CORE_MATERIAL = "Leaves_Core"
ATLAS_EDGE = 1024
TIERS = 7
CROWN_FLOOR = 0.8 # the lowest whorl, in metres above the source crown base: the trunk shows below it
STUB_REACH = 0.36  # bark further than this from the trunk axis (above 0.45 m) is a bare branch stub, and is cut
SKIRT_SEGMENTS = 12
SKIRT_REACH = 0.86  # skirt rim, as a share of the branch length: the needle fringe overhangs it
RIM_BAND = 0.2  # height of a tier's dark rim band, metres
# Card shares: on the skirt tops, hanging over the rims, at the branch tips; the rest go to the leader.
SURFACE_SHARE, FRINGE_SHARE, TIP_SHARE = 0.47, 0.28, 0.22

# Sprig regions on the 2048 px fir_tree_01 twig atlas: (left, top, right, bottom) in pixels, image y down.
# Each sprig grows upward on the atlas: its stem is at the bottom edge of the box.
SPRIGS = (
    (626, 819, 1300, 1588),
    (1320, 926, 1961, 1700),
    (1336, 82, 1921, 755),
    (387, 95, 878, 638),
)
SPRIG_WEIGHTS = (0.34, 0.34, 0.2, 0.12)

# Palette (Blender colour-attribute values), tuned in Blender against the #446 broadleaf.
NEEDLE_SHADE = (0.018, 0.055, 0.016)
NEEDLE_MID = (0.05, 0.16, 0.03)
NEEDLE_SUN = (0.17, 0.36, 0.04)
CORE = (0.016, 0.045, 0.014)


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "seed", "cards"}:
        raise ValueError("conifer crown requires exactly schemaVersion, seed and cards")
    if p["schemaVersion"] != 1 or type(p["seed"]) is not int or type(p["cards"]) is not int or not 100 <= p["cards"] <= 4000:
        raise ValueError("conifer crown: schemaVersion 1, integer seed, 100..4000 cards")
    if set(inputs) != {"source", "needles", "needleAlpha"}:
        raise ValueError("conifer crown takes exactly the declared inputs source, needles and needleAlpha")


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def palette(tone):
    """Tone 0 (deep shade) .. 1 (sunlit tip) through the needle palette."""
    tone = clamp(tone)
    return mix(NEEDLE_SHADE, NEEDLE_MID, tone / 0.5) if tone < 0.5 else mix(NEEDLE_MID, NEEDLE_SUN, (tone - 0.5) / 0.5)


class Crown:
    """The source crown, measured: trunk axis, crown base and top, and the radius profile."""

    def __init__(self, tree, leaf_slot):
        mesh = tree.data
        leaf = {v for p in mesh.polygons if p.material_index == leaf_slot for v in p.vertices}
        bark = {v for p in mesh.polygons if p.material_index != leaf_slot for v in p.vertices}
        base = [mesh.vertices[i].co for i in bark if mesh.vertices[i].co.z < 0.3]
        self.root = sum(base, Vector()) / len(base)
        top = max((mesh.vertices[i].co for i in bark), key=lambda co: co.z)
        self.top_bark = top.copy()
        points = [mesh.vertices[i].co.copy() for i in leaf]
        self.zb = min(p.z for p in points)
        self.zt = max(p.z for p in points)
        # Radius profile: the 90th-percentile leaf radius per 0.3 m band, made non-increasing upward.
        bands = {}
        for p in points:
            bands.setdefault(int((p.z - self.zb) / 0.3), []).append((p - self.axis(p.z)).xy.length)
        count = int((self.zt - self.zb) / 0.3) + 1
        radii = []
        for k in range(count):
            values = sorted(bands.get(k, [0.0]))
            radii.append(values[int(0.9 * (len(values) - 1))])
        for k in range(count - 2, -1, -1):
            radii[k] = max(radii[k], radii[k + 1])
        self.radii = radii

    def axis(self, z):
        t = (z - self.root.z) / max(1e-6, self.top_bark.z - self.root.z)
        return Vector((self.root.x + (self.top_bark.x - self.root.x) * t, self.root.y + (self.top_bark.y - self.root.y) * t, z))

    def radius(self, z):
        f = clamp((z - self.zb) / 0.3, 0.0, len(self.radii) - 1.0)
        k = min(int(f), len(self.radii) - 2) if len(self.radii) > 1 else 0
        if len(self.radii) == 1:
            return self.radii[0]
        return self.radii[k] + (self.radii[k + 1] - self.radii[k]) * (f - k)


def limb(start, angle, length, sag, t):
    """A point on a branch: out and down from the trunk, drooping more towards the tip."""
    d = Vector((math.cos(angle), math.sin(angle), 0))
    return start + d * (length * t) + Vector((0, 0, -length * sag * t ** 1.8))


def slope(angle, length, sag, t):
    """The unit tangent of ``limb`` at ``t``, pointing out along the branch."""
    d = Vector((math.cos(angle), math.sin(angle), 0))
    return (d + Vector((0, 0, -sag * 1.8 * max(t, 0.05) ** 0.8))).normalized()


def surface_normal(angle, length, sag, t):
    """The smooth skirt normal at ``t`` along a branch direction: up and out, tilting outward towards the rim."""
    d = Vector((math.cos(angle), math.sin(angle), 0))
    tangent = slope(angle, length, sag, t)
    side = Vector((-d.y, d.x, 0))
    n = side.cross(tangent).normalized()
    if n.z < 0:
        n = -n
    return n


class Tier:
    """One whorl: its branches, and a slight tilt and droop wobble so no two tiers are the same disc."""

    def __init__(self, start, sag, h, arms, rng):
        self.start, self.sag, self.h, self.arms = start, sag, h, arms
        self.reach = max(length for _a, length in arms)
        self.tilt, self.tilt_to = rng.uniform(0.04, 0.1), rng.uniform(0, 2 * math.pi)
        self.wobble, self.wobble_phase = rng.uniform(0.12, 0.25), rng.uniform(0, 2 * math.pi)

    def at(self, angle, length, t):
        """A point ``t`` of the way along a branch of ``length`` towards ``angle``."""
        lift = self.tilt * t * math.cos(angle - self.tilt_to) - self.sag * self.wobble * t ** 1.8 * math.sin(3 * angle + self.wobble_phase)
        return limb(self.start, angle, length, self.sag, t) + Vector((0, 0, length * lift))

    def length(self, angle):
        """The tier's branch length towards ``angle``: blended between branches, dipping between them (lobes)."""
        total = weight = 0.0
        nearest = math.pi
        for a, length in self.arms:
            gap = abs((angle - a + math.pi) % (2 * math.pi) - math.pi)
            nearest = min(nearest, gap)
            w = 1.0 / (0.05 + gap) ** 2
            total += w * length
            weight += w
        half = math.pi / len(self.arms)
        return total / weight * (1.0 - 0.3 * clamp(nearest / half) ** 1.5)

    def point(self, angle, t, reach=SKIRT_REACH):
        return self.at(angle, self.length(angle) * reach, t)


def tiers(crown, rng):
    """The whorls, bottom up: widest at the bottom, closer together towards the leader."""
    base, top = crown.zb + CROWN_FLOOR, crown.zt - 0.4
    span = crown.zt - crown.zb
    out = []
    phase = rng.uniform(0, 2 * math.pi)
    for i in range(TIERS):
        x = i / (TIERS - 1)
        z = base + (top - base) * (1.0 - (1.0 - x) ** 1.3) + (rng.uniform(-0.04, 0.04) if 0 < i < TIERS - 1 else 0.0)
        h = (z - crown.zb) / span
        sag = 0.42 - 0.1 * h
        reach = crown.radius(z - sag * crown.radius(z) * 0.5) * (1.02 - 0.06 * h) * rng.uniform(0.93, 1.05)
        count = max(5, min(9, round(2 * math.pi * reach / 0.8)))
        phase += 2.39996  # golden angle between whorls
        arms = [(phase + 2 * math.pi * k / count + rng.uniform(-0.2, 0.2), reach * rng.uniform(0.85, 1.08)) for k in range(count)]
        out.append(Tier(crown.axis(z), sag, h, arms, rng))
    return out


def core_mesh(crown, levels, collection, rng, segments=SKIRT_SEGMENTS):
    """One opaque, closed skirt per tier: a drooping cone, a dark rim band, and a hollow reaching to the tier below."""
    verts, colours, faces = [], [], []
    for i, tier in enumerate(levels):
        h = tier.h
        collar = len(verts)
        verts.append(tier.start + Vector((0, 0, 0.12)))
        colours.append(CORE)
        rim = len(verts)
        angles = [2 * math.pi * k / segments + rng.uniform(-0.08, 0.08) for k in range(segments)]
        for a in angles:
            verts.append(tier.point(a, 1.0))
            colours.append(palette(0.15 + 0.3 * h))
        band = len(verts)
        for a in angles:
            verts.append(tier.point(a, 0.94) - Vector((0, 0, RIM_BAND)))
            colours.append(mix(CORE, NEEDLE_SHADE, 0.6))
        # The hollow under the tier: it narrows to a waist that meets the tier below (or the trunk at the bottom),
        # so no sky shows between tiers.
        lower = levels[i - 1] if i else None
        waist = len(verts)
        for a in angles:
            if lower:
                r = 0.4 * lower.length(a) * SKIRT_REACH
                p = lower.at(a, r, 1.0) + Vector((0, 0, 0.1))
            else:
                r = 0.3 * tier.length(a) * SKIRT_REACH
                p = tier.start + Vector((math.cos(a) * r, math.sin(a) * r, -tier.sag * tier.reach * 0.45))
            verts.append(p)
            colours.append(CORE)
        under = len(verts)
        verts.append(crown.axis(verts[waist].z - 0.05))
        colours.append(CORE)
        for k in range(segments):
            n = (k + 1) % segments
            faces.append((collar, rim + k, rim + n))
            faces.append((rim + k, band + k, band + n))
            faces.append((rim + k, band + n, rim + n))
            faces.append((band + k, waist + k, waist + n))
            faces.append((band + k, waist + n, band + n))
            faces.append((under, waist + n, waist + k))
    mesh = bpy.data.meshes.new("crown_core")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    # Each tier is a closed shell; point every face outward for back-face culling.
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    layer = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for polygon in mesh.polygons:
        polygon.use_smooth = True
        for li in polygon.loop_indices:
            layer.data[li].color = (*colours[mesh.loops[li].vertex_index], 1.0)
    core = bpy.data.objects.new("crown_core", mesh)
    collection.objects.link(core)
    return core


def blur(a, r):
    """A separable box blur of a 2D array, radius ``r`` pixels."""
    for axis in (0, 1):
        pad = np.pad(a, [(r + 1, r) if k == axis else (0, 0) for k in (0, 1)], mode="edge")
        c = np.cumsum(pad, axis=axis, dtype=np.float64)
        hi = np.take(c, range(2 * r + 1, c.shape[axis]), axis=axis)
        lo = np.take(c, range(0, c.shape[axis] - 2 * r - 1), axis=axis)
        a = ((hi - lo) / (2 * r + 1)).astype(np.float32)
    return a


def needle_image(colour_path, alpha_path):
    """The fir twig atlas as a bright greyscale mask at ATLAS_EDGE, so COLOR_0 alone sets the hue."""
    colour = bpy.data.images.load(os.path.abspath(colour_path))
    alpha = bpy.data.images.load(os.path.abspath(alpha_path))
    alpha.colorspace_settings.is_data = True
    w, h = colour.size
    if tuple(alpha.size) != (w, h):
        raise ValueError("needle colour and alpha maps differ in size")
    rgb = np.empty(w * h * 4, dtype=np.float32)
    colour.pixels.foreach_get(rgb)
    a = np.empty(w * h * 4, dtype=np.float32)
    alpha.pixels.foreach_get(a)
    rgb = rgb.reshape(-1, 4)
    a = a.reshape(-1, 4)[:, 0]
    lum = 0.2126 * rgb[:, 0] + 0.7152 * rgb[:, 1] + 0.0722 * rgb[:, 2]
    inside = lum[a > 0.5]
    hi = float(np.percentile(inside, 97)) if inside.size else 1.0
    # Close the alpha: fill the gaps between needles, so a sprig reads as a solid fan in the MASK cut-out and does not
    # thin out as the texture mips down. The filled gaps take the darkest mask value: they read as needle shadow.
    needles = np.clip(a * 1.35, 0.0, 1.0)
    filled = (blur(blur(a.reshape(h, w), w // 340), w // 340).ravel() > 0.3).astype(np.float32)
    coverage = np.maximum(needles, filled)
    g = np.where(a > 0.5, 0.62 + 0.38 * np.clip(lum / max(hi, 1e-6), 0.0, 1.0), 0.5)
    out = np.empty((w * h, 4), dtype=np.float32)
    out[:, 0] = out[:, 1] = out[:, 2] = g
    out[:, 3] = coverage
    image = bpy.data.images.new("Needles_Conifer", w, h, alpha=True)
    image.pixels.foreach_set(out.ravel())
    image.scale(ATLAS_EDGE, ATLAS_EDGE)
    image.file_format = "PNG"
    image.pack()
    bpy.data.images.remove(colour)
    bpy.data.images.remove(alpha)
    return image


def needle_material(image):
    mat = bpy.data.materials.new(NEEDLE_MATERIAL)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    mul = nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs[0].default_value = 1.0
    links.new(tex.outputs["Color"], mul.inputs[6])
    links.new(attr.outputs["Color"], mul.inputs[7])
    links.new(mul.outputs[2], bsdf.inputs["Base Color"])
    # Round(alpha) exports as glTF alphaMode MASK.
    rnd = nodes.new("ShaderNodeMath")
    rnd.operation = "ROUND"
    links.new(tex.outputs["Alpha"], rnd.inputs[0])
    links.new(rnd.outputs[0], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.use_backface_culling = False
    return mat


def core_material():
    mat = bpy.data.materials.new(CORE_MATERIAL)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    mat.use_backface_culling = True
    return mat


def sprig_uv(region):
    left, top, right, bottom = region
    return (left / 2048, 1 - bottom / 2048, right / 2048, 1 - top / 2048), (right - left) / (bottom - top)


def build_crown(crown, image, seed, cards, collection):
    rng = random.Random(seed)
    levels = tiers(crown, rng)
    core = core_mesh(crown, levels, collection, rng)
    core.data.materials.append(core_material())

    sprigs = [sprig_uv(region) for region in SPRIGS]
    up = Vector((0, 0, 1))
    verts, faces, normals, colours, uvs = [], [], [], [], []

    def pick_sprig():
        x = rng.random()
        for i, w in enumerate(SPRIG_WEIGHTS):
            x -= w
            if x <= 0:
                return i
        return len(SPRIG_WEIGHTS) - 1

    def card(base, along, size, roll, normal, tone):
        """One sprig card: stem at ``base``, growing along ``along``, shaded with the smooth ``normal``."""
        side = along.cross(up)
        if side.length < 1e-3:
            side = Vector((1, 0, 0))
        side.normalize()
        flat = side.cross(along).normalized()  # card plane normal before roll, roughly up
        side = side * math.cos(roll) + flat * math.sin(roll)
        (u0, v0, u1, v1), aspect = sprigs[pick_sprig()]
        width = size * aspect
        start = len(verts)
        for su, sv, uv in ((-0.5, 0.0, (u0, v0)), (0.5, 0.0, (u1, v0)), (0.5, 1.0, (u1, v1)), (-0.5, 1.0, (u0, v1))):
            verts.append(base + side * (su * width) + along * (sv * size))
            normals.append(normal)
            uvs.append(uv)
        faces.append((start, start + 1, start + 2, start + 3))
        hsv = Color(palette(tone + rng.uniform(-0.06, 0.06)))
        hsv.h = (hsv.h + rng.uniform(-0.012, 0.012)) % 1.0
        hsv.v *= rng.uniform(0.92, 1.06)
        colours.append((hsv.r, hsv.g, hsv.b))

    def fan(direction, amount, lift):
        side = direction.cross(up)
        side = side.normalized() if side.length > 1e-3 else Vector((1, 0, 0))
        return (direction + side * rng.uniform(-amount, amount) + up * lift).normalized()

    areas = [tier.reach ** 1.6 for tier in levels]
    rims = [tier.reach for tier in levels]
    surface = round(cards * SURFACE_SHARE)
    fringe = round(cards * FRINGE_SHARE)
    tips = round(cards * TIP_SHARE)
    apex = cards - surface - fringe - tips
    for tier, area, rim in zip(levels, areas, rims):
        size_scale = clamp(tier.reach * 0.38, 0.5, 0.95)
        # Sprigs lying on the skirt's top, pointing downslope: the lit, needled tier surface.
        for _ in range(max(6, round(surface * area / sum(areas)))):
            angle = rng.uniform(0, 2 * math.pi)
            t = 0.12 + 0.86 * math.sqrt(rng.random())
            length = tier.length(angle) * SKIRT_REACH
            base = tier.at(angle, length, t) + up * 0.05
            normal = surface_normal(angle, length, tier.sag, t)
            direction = fan(slope(angle, length, tier.sag, t), 0.55, rng.uniform(-0.05, 0.12))
            size = size_scale * rng.uniform(0.8, 1.1)
            tone = 0.3 + 0.48 * t ** 2 + 0.2 * tier.h + 0.1 * normal.z
            card(base - direction * size * 0.2, direction, size, rng.uniform(-0.3, 0.3), normal, tone)
        # A fringe hanging over the rim, out and down: the tier's soft edge and its shadowed band.
        for _ in range(max(6, round(fringe * rim / sum(rims)))):
            angle = rng.uniform(0, 2 * math.pi)
            length = tier.length(angle) * SKIRT_REACH
            t = rng.uniform(0.72, 0.96)
            base = tier.at(angle, length, t)
            out = Vector((math.cos(angle), math.sin(angle), 0))
            direction = fan(out + Vector((0, 0, -rng.uniform(0.45, 1.0))), 0.45, 0.0)
            normal = (out * 0.85 + up * 0.35).normalized()
            size = size_scale * rng.uniform(0.75, 1.25)
            tone = 0.15 * tier.h + rng.uniform(-0.05, 0.06)
            card(base, direction, size, rng.uniform(-0.5, 0.5), normal, tone)
        # Sprays at the branch tips, past the rim, so the silhouette is a fir's, not a cone's.
        share = max(2, round(tips * rim / sum(rims) / len(tier.arms)))
        for angle, arm in tier.arms:
            for _ in range(share):
                t = rng.uniform(0.8, 1.0)
                base = tier.at(angle, arm, t) + up * 0.04
                direction = fan(slope(angle, arm, tier.sag, t), 0.6, rng.uniform(-0.25, 0.1))
                normal = surface_normal(angle, arm, tier.sag, 1.0)
                size = size_scale * rng.uniform(0.7, 0.95)
                tone = 0.55 + 0.3 * tier.h + rng.uniform(-0.05, 0.1)
                card(base - direction * size * 0.3, direction, size, rng.uniform(-0.6, 0.6), normal, tone)
    # The leader: upright sprigs around the top of the trunk.
    top = crown.axis(crown.zt - 0.6)
    for i in range(apex):
        a = 2 * math.pi * i / apex + rng.uniform(-0.2, 0.2)
        out = Vector((math.cos(a), math.sin(a), 0))
        lift = 0.5 + 0.5 * (i % 3) / 2
        direction = (out * (1 - lift) + up * (0.6 + lift)).normalized()
        normal = (out * 0.6 + up * 0.8).normalized()
        card(top + up * rng.uniform(-0.3, 0.2), direction, rng.uniform(0.4, 0.6), rng.uniform(-0.5, 0.5), normal, 0.75)

    mesh = bpy.data.meshes.new("crown_needles")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    uv = mesh.uv_layers.new(name="UVMap")
    col = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for poly, rgb in zip(mesh.polygons, colours):
        poly.use_smooth = True
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[mesh.loops[li].vertex_index]
            col.data[li].color = (*rgb, 1.0)
    mesh.normals_split_custom_set_from_vertices([tuple(n) for n in normals])
    mesh.materials.append(needle_material(image))
    needles = bpy.data.objects.new("crown_needles", mesh)
    collection.objects.link(needles)
    return core, needles


def triangles(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=inputs["source"])
    tree = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    slot = next(i for i, m in enumerate(tree.data.materials) if m and m.name.startswith(SOURCE_LEAF_MATERIAL))
    crown = Crown(tree, slot)
    # Drop the leaves, and the bare branch stubs around the crown base: the trunk shows cleanly below the first tier.
    bm = bmesh.new()
    bm.from_mesh(tree.data)
    cut = [f for f in bm.faces if f.material_index == slot or (
        f.calc_center_median().z > 0.45 and any((v.co - crown.axis(v.co.z)).xy.length > STUB_REACH for v in f.verts))]
    bmesh.ops.delete(bm, geom=cut, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(tree.data)
    bm.free()
    leaf_material = tree.data.materials.pop(index=slot)
    for node in leaf_material.node_tree.nodes if leaf_material.use_nodes else []:
        if node.type == "TEX_IMAGE" and node.image:
            bpy.data.images.remove(node.image)
    bpy.data.materials.remove(leaf_material)
    for attribute in list(tree.data.color_attributes):
        tree.data.color_attributes.remove(attribute)
    trunk_triangles = triangles(tree)
    image = needle_image(inputs["needles"], inputs["needleAlpha"])
    core, needles = build_crown(crown, image, arguments["seed"], arguments["cards"], bpy.context.scene.collection)
    core_triangles, needle_triangles = triangles(core), triangles(needles)
    # The bark keeps its look: COLOR_0 is white there (glTF multiplies it into the base colour).
    white = tree.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for item in white.data:
        item.color = (1.0, 1.0, 1.0, 1.0)
    # One mesh node, as before: trunk, core and needles join into the source's node.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (core, needles, tree):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = tree
    bpy.ops.object.join()
    colours = tree.data.color_attributes
    colours.active_color = colours["Col"]
    colours.render_color_index = colours.active_color_index
    if output_path:
        bpy.ops.export_scene.gltf(
            filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
            export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
            export_all_vertex_colors=False,
            export_animations=False, export_skins=False, export_morph=False,
            export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "seed": arguments["seed"], "cards": arguments["cards"],
            "trunkTriangles": trunk_triangles, "coreTriangles": core_triangles, "needleTriangles": needle_triangles,
            "triangles": triangles(tree)}
