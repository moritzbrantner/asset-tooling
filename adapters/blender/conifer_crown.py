"""Greyhaven conifer crown (asset-tooling#450): keep the source trunk, replace its leaves with tiered needle sprigs.

The declared inputs are:

* ``source``: the imported CC0 Quaternius ``Pine_1`` GLB. Its bark primitive is kept as is, so the trunk follows the
  source. Its leaf primitive is only measured (crown base, top and radius profile), then deleted and rebuilt;
* ``needles`` and ``needleAlpha``: the CC0 Poly Haven ``fir_tree_01`` twig colour and alpha maps. Four fir sprigs on
  that atlas become the card texture, as a greyscale mask, so COLOR_0 alone sets the hue.

The crown is a stack of whorls (tiers) up the source trunk. Each whorl has drooping branches whose length follows the
source crown's radius at that height. Alpha-``MASK`` sprig cards lie along each branch, stem towards the trunk; a dark
opaque *core* (a decimated metaball stack of flattened tier discs, shrunk inward) stops the sky showing through.
Each card carries a bent normal (towards up and out of the crown) and a per-card vertex colour: deep and cool inside,
under each tier and low down, lighter and warmer at the sunlit branch tips and the top.

Everything is seeded from ``arguments["seed"]``. Blender coordinates are Z up; the GLB is exported +Y up.
"""
import math
import os
import random

import bmesh
import bpy
import numpy as np
from mathutils import Color, Vector

RECIPE = "conifer-crown-v1"
SOURCE_LEAF_MATERIAL = "Leaves_Pine"
NEEDLE_MATERIAL = "Leaves_Pine"
CORE_MATERIAL = "Leaves_Core"
ATLAS_EDGE = 1024
SKIRT_SEGMENTS = 14
SKIRT_REACH = 0.58  # skirt rim, as a share of the branch length: the needle mass overhangs it
RIM_CARDS = 12

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
NEEDLE_SHADE = (0.04, 0.1, 0.025)
NEEDLE_MID = (0.13, 0.27, 0.05)
NEEDLE_SUN = (0.44, 0.54, 0.11)
CORE = (0.025, 0.06, 0.018)


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


def tiers(crown, rng):
    """Whorl heights from the top down: closer together near the leader."""
    span = crown.zt - crown.zb
    heights = []
    z = crown.zt - 0.22
    while z > crown.zb + 0.25:
        heights.append(z)
        h = (crown.zt - z) / span
        z -= 0.3 + 0.28 * h + rng.uniform(-0.04, 0.04)
    heights.append(crown.zb + 0.3)
    return sorted(heights)


def limb(start, angle, length, sag, t):
    """A point on a branch: out and down from the trunk, with a slight upturn of the tip."""
    d = Vector((math.cos(angle), math.sin(angle), 0))
    return start + d * (length * t) + Vector((0, 0, length * (-sag * t ** 1.5 + 0.12 * t ** 4)))


def whorls(crown, rng):
    """Whorls up the trunk; each is (start, sag, [(angle, length, branch points)])."""
    out = []
    span = crown.zt - crown.zb
    phase = rng.uniform(0, 2 * math.pi)
    for z in tiers(crown, rng):
        h = (z - crown.zb) / span
        sag = 0.5 - 0.12 * h
        reach = crown.radius(z - sag * crown.radius(z) * 0.6)
        count = max(4, min(9, round(2 * math.pi * reach / 0.85)))
        phase += 2.39996  # golden angle between whorls
        start = crown.axis(z)
        arms = []
        for i in range(count):
            angle = phase + 2 * math.pi * i / count + rng.uniform(-0.25, 0.25)
            length = reach * rng.uniform(0.86, 1.04)
            arms.append((angle, length, [limb(start, angle, length, sag, s / 8) for s in range(9)]))
        out.append((start, sag, arms))
    return out


def on_curve(pts, t):
    f = t * (len(pts) - 1)
    k = min(int(f), len(pts) - 2)
    a, b = pts[k], pts[k + 1]
    return a + (b - a) * (f - k), (b - a).normalized()


def reach_at(arms, angle):
    """The whorl's branch length towards ``angle``, blended between neighbouring branches."""
    total = weight = 0.0
    for a, length, _pts in arms:
        gap = abs((angle - a + math.pi) % (2 * math.pi) - math.pi)
        w = 1.0 / (0.05 + gap) ** 2
        total += w * length
        weight += w
    return total / weight


def skirt(crown, start):
    """The skirt rim as a share of the branch length; upper skirts sit deeper inside their thinner needle mass."""
    return SKIRT_REACH * (1.0 - 0.35 * (start.z - crown.zb) / (crown.zt - crown.zb))


def core_mesh(crown, levels, collection, rng, segments=SKIRT_SEGMENTS):
    """One opaque, closed skirt per whorl, inside its needle mass: a shallow cone on top, a hollow under it."""
    verts, faces, colours = [], [], []
    span = crown.zt - crown.zb
    below = crown.zb
    for start, sag, arms in levels:
        h = (start.z - crown.zb) / span
        top = len(verts)
        verts.append(start + Vector((0, 0, 0.06)))
        colours.append(CORE)
        ring = len(verts)
        reach = max(length for _a, length, _p in arms)
        for k in range(segments):
            angle = 2 * math.pi * k / segments
            length = reach_at(arms, angle) * skirt(crown, start) * rng.uniform(0.82, 1.08)
            verts.append(limb(start, angle, length, sag, 1.0) + Vector((0, 0, rng.uniform(-0.08, 0.08))))
            colours.append(mix(NEEDLE_SHADE, NEEDLE_MID, 0.15 + 0.35 * h))
        # The underside steps in to a waist that sits on the whorl below, so no sky shows between whorls.
        depth = min(below + 0.04, start.z - sag * reach * 0.42)
        waist = len(verts)
        for k in range(segments):
            angle = 2 * math.pi * (k + 0.5) / segments
            verts.append(crown.axis(depth) + Vector((math.cos(angle), math.sin(angle), 0)) * reach * 0.72 * skirt(crown, start))
            colours.append(mix(CORE, NEEDLE_SHADE, h))
        under = len(verts)
        verts.append(crown.axis(depth - 0.05))
        colours.append(CORE)
        below = start.z
        # The rim is lit on top but in shadow underneath: underside faces see it in the underside colour.
        shadow = {ring + k: mix(CORE, NEEDLE_SHADE, 0.5 * h) for k in range(segments)}
        for k in range(segments):
            a, b = ring + k, ring + (k + 1) % segments
            w, w2 = waist + k, waist + (k + 1) % segments
            faces.append(((top, a, b), {}))
            faces.append(((a, w, b), shadow))
            faces.append(((b, w, w2), shadow))
            faces.append(((under, w2, w), {}))
    mesh = bpy.data.meshes.new("crown_core")
    mesh.from_pydata([tuple(v) for v in verts], [], [f for f, _c in faces])
    # Each whorl is a closed shell; point every face outward for back-face culling.
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    layer = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for polygon, (_face, override) in zip(mesh.polygons, faces):
        polygon.use_smooth = True
        for li in polygon.loop_indices:
            v = mesh.loops[li].vertex_index
            layer.data[li].color = (*override.get(v, colours[v]), 1.0)
    core = bpy.data.objects.new("crown_core", mesh)
    collection.objects.link(core)
    return core


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
    g = 0.5 + 0.5 * np.clip(lum / max(hi, 1e-6), 0.0, 1.0)
    out = np.empty((w * h, 4), dtype=np.float32)
    out[:, 0] = out[:, 1] = out[:, 2] = g
    # A little extra coverage keeps thin needles from vanishing in the MASK cut-out at a distance.
    out[:, 3] = np.clip(a * 1.35, 0.0, 1.0)
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
    levels = whorls(crown, rng)
    core = core_mesh(crown, levels, collection, rng)
    core.data.materials.append(core_material())

    limbs = [pts for _start, _sag, arms in levels for _a, _length, pts in arms]
    # Upper whorls have fewer, shorter branches; they still need a full needle mass over their skirt.
    weights = [length ** 0.4 / len(arms) ** 0.85 for _start, _sag, arms in levels for _a, length, _pts in arms]
    total = sum(weights)
    apex = 14
    cover = round(cards * 0.3) - RIM_CARDS * len(levels)
    budget = cards - apex - cover - RIM_CARDS * len(levels)
    sprigs = [sprig_uv(region) for region in SPRIGS]
    span = crown.zt - crown.zb
    up = Vector((0, 0, 1))
    sun = Vector((0.35, -0.45, 0.82)).normalized()

    verts, faces, normals, colours, uvs = [], [], [], [], []

    def card(base, along, size, roll, tint, depth):
        """One sprig card: stem at ``base``, growing along ``along``; ``depth`` 0 inside .. 1 at the tip."""
        side = along.cross(up)
        if side.length < 1e-3:
            side = Vector((1, 0, 0))
        side.normalize()
        flat = side.cross(along).normalized()  # card normal before roll, roughly up
        side = side * math.cos(roll) + flat * math.sin(roll)
        normal = along.cross(side).normalized()
        if normal.z < 0:
            normal = -normal
        (u0, v0, u1, v1), aspect = sprigs[pick_sprig()]
        width = size * aspect
        start = len(verts)
        for su, sv, uv in ((-0.5, 0.0, (u0, v0)), (0.5, 0.0, (u1, v0)), (0.5, 1.0, (u1, v1)), (-0.5, 1.0, (u0, v1))):
            corner = base + side * (su * width) + along * (sv * size)
            verts.append(corner)
            out = corner - crown.axis(corner.z)
            out.z = 0
            out = out.normalized() if out.length > 1e-3 else Vector((0, 0, 0))
            normals.append((normal * 0.35 + out * 0.55 + up * 0.45).normalized())
            uvs.append(uv)
        faces.append((start, start + 1, start + 2, start + 3))
        centre = base + along * (size * 0.5)
        h = clamp((centre.z - crown.zb) / span)
        lit = max(0.0, normal.dot(sun))
        tone = -0.25 + 0.45 * h + 0.65 * depth ** 1.5 + 0.18 * lit + 0.1 * tint + rng.uniform(-0.08, 0.08)
        tone = clamp(tone)
        rgb = mix(NEEDLE_SHADE, NEEDLE_MID, tone / 0.55) if tone < 0.55 else mix(NEEDLE_MID, NEEDLE_SUN, (tone - 0.55) / 0.45)
        hsv = Color(rgb)
        hsv.h = (hsv.h + 0.015 * tint + rng.uniform(-0.012, 0.012)) % 1.0
        hsv.v *= rng.uniform(0.9, 1.08)
        colours.append((hsv.r, hsv.g, hsv.b))

    def pick_sprig():
        x = rng.random()
        for i, w in enumerate(SPRIG_WEIGHTS):
            x -= w
            if x <= 0:
                return i
        return len(SPRIG_WEIGHTS) - 1

    for pts, weight in zip(limbs, weights):
        n = max(2, round(budget * weight / total))
        length = (pts[-1] - pts[0]).length
        tint = rng.uniform(-1, 1)
        for k in range(n):
            # Cards march from the inner branch to the tip; the last one carries the tip itself.
            t = 0.12 + 0.88 * ((k + rng.uniform(0.0, 0.8)) / n) ** 0.8
            base, along = on_curve(pts, min(t, 0.97))
            size = clamp(length * 0.42, 0.55, 1.25) * rng.uniform(0.75, 1.1) * (1.0 - 0.3 * t)
            # Fan sideways from the branch and lift slightly, so cards spread into a needle mass.
            fan = rng.uniform(-0.75, 0.75)
            side = along.cross(up)
            side = side.normalized() if side.length > 1e-3 else Vector((1, 0, 0))
            direction = (along + side * fan + up * rng.uniform(-0.15, 0.3)).normalized()
            base = base + side * rng.uniform(-0.12, 0.12) * length * 0.3 + up * rng.uniform(-0.05, 0.08)
            card(base, direction, size, rng.uniform(-1.1, 1.1), tint, t)
    # Sprigs lying on each skirt between the branches, so no bare skirt shows from above or up close.
    shares = [max(length for _a, length, _p in arms) ** 0.7 for _start, _sag, arms in levels]
    for (start, sag, arms), share in zip(levels, shares):
        n = max(4, round(cover * share / sum(shares)))
        for _ in range(n):
            angle = rng.uniform(0, 2 * math.pi)
            length = reach_at(arms, angle) * skirt(crown, start)
            t = 0.2 + 0.75 * math.sqrt(rng.random())
            # The skirt's top is a straight cone from just above the whorl to its rim.
            inner = start + Vector((0, 0, 0.06))
            rim = limb(start, angle, length, sag, 1.0)
            base = inner.lerp(rim, t) + Vector((0, 0, 0.1))
            along = (rim - inner).normalized()
            side = along.cross(up)
            side = side.normalized() if side.length > 1e-3 else Vector((1, 0, 0))
            direction = (along + side * rng.uniform(-0.6, 0.6) + up * rng.uniform(0.0, 0.25)).normalized()
            size = clamp(length * 0.5, 0.5, 1.1) * rng.uniform(0.8, 1.1)
            card(base - direction * size * 0.3, direction, size, rng.uniform(-0.4, 0.4), rng.uniform(-1, 1), 0.35 + 0.6 * t)
        # A fringe over the skirt's rim, hanging out and down, so its edge never shows.
        for k in range(RIM_CARDS):
            angle = 2 * math.pi * (k + rng.uniform(-0.3, 0.3)) / RIM_CARDS
            length = reach_at(arms, angle) * skirt(crown, start)
            rim = limb(start, angle, length, sag, 1.0)
            out = Vector((math.cos(angle), math.sin(angle), 0))
            direction = (out + Vector((0, 0, -0.35 - 0.3 * rng.random()))).normalized()
            size = clamp(length * 0.55, 0.5, 1.0) * rng.uniform(0.85, 1.1)
            card(rim - direction * size * 0.35 + Vector((0, 0, 0.04)), direction, size, rng.uniform(-0.5, 0.5), rng.uniform(-1, 1), 0.85)
    # The leader: upright sprigs around the top of the trunk.
    top = crown.axis(crown.zt - 0.55)
    for i in range(apex):
        a = 2 * math.pi * i / apex + rng.uniform(-0.2, 0.2)
        out = Vector((math.cos(a), math.sin(a), 0))
        lift = 0.35 + 0.45 * (i % 3) / 2
        direction = (out * (1 - lift) + up * (0.6 + lift)).normalized()
        card(top + up * rng.uniform(-0.25, 0.2), direction, rng.uniform(0.5, 0.75), rng.uniform(-0.5, 0.5), 0.3, 0.9)

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
    bm = bmesh.new()
    bm.from_mesh(tree.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index == slot], context="FACES")
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
