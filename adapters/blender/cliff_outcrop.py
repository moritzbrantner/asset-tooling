"""Freestanding cliff outcrops for Greyhaven (docs/crag-kit.md#outcrops): sculpted rock with a baked CC0 PBR material.

The declared inputs are CC0 Poly Haven scans, mostly Greyhaven's terrain layers: ``rock_face_03`` (``rockColour``,
``rockHeight``), ``forrest_ground_01`` (``grassColour``), ``rocks_ground_02`` (``gravelColour``) and ``mossy_rock``
(``mossColour``), so an outcrop's foot and crown use the very scans the terrain around it uses.

An outcrop is built in three steps:

* **Shape.** A polar grid (angle round the rock, ``v`` from the buried foot over the face to the crown's centre) gives
  each height a radius. Bedded strata carry their own fracture planes, so each stratum has flat faces with sharp
  arrises and stands proud of or back from its neighbours, with cracks along the bedding and vertical joints. Ridged
  noise roughens it, and rubble blocks gather at the foot;
* **Material.** The sculpt blends rock into moss on the ledges, into gravel and then grass at the foot, and into grass
  on the crown, along noisy edges;
* **Game mesh.** A decimated copy is UV-unwrapped and Cycles bakes the sculpt's colour, normal and roughness onto it.

No randomness beyond ``numpy``'s legacy ``RandomState``, seeded per outcrop. Blender coordinates are Z up; the GLB is
exported +Y up, with its origin on the ground at the footprint centre.
"""
import math

import bmesh
import bpy
import numpy as np

RECIPE = "cliff-outcrop-v1"
# Per outcrop: seed, radii (x, y), height, lean (x, y metres at the top), LOD0 triangles and baked texture edge.
OUTCROPS = {
    "buttress-1": dict(seed=7101, radii=(3.9, 4.7), height=14.0, lean=(-3.5, -1.5), triangles=9000, edge=2048),
    "buttress-2": dict(seed=7102, radii=(3.1, 3.9), height=11.0, lean=(-1.5, 2.8), triangles=7500, edge=2048),
    "spire": dict(seed=7103, radii=(2.6, 2.8), height=13.2, lean=(0.5, -0.4), triangles=7000, edge=2048),
    "talus-1": dict(seed=7104, radii=(1.8, 2.2), height=5.2, lean=(-0.8, 0.4), triangles=3500, edge=1024),
    "talus-2": dict(seed=7105, radii=(1.3, 1.6), height=3.4, lean=(0.3, -0.5), triangles=2500, edge=1024),
}
CELL = 0.03              # sculpt grid spacing, metres; every rock gets a grid its decimation can reduce cleanly
SKIRT, CROWN = 0.09, 0.84  # where along v the buried foot ends and the crown begins
BURY = 0.9               # how far below the ground the foot reaches, metres
TILE = {"rock": 2.7, "grass": 2.0, "gravel": 2.0, "moss": 1.6}  # metres per repeat, as the terrain's layers
# mmorpg's ground palette (sRGB): the clients divide each scan by its mean and multiply by these.
PALETTE = {"rock": 0x8b877e, "grass": 0x667d46, "gravel": 0x8f8a7c, "moss": 0x667447}


def lattice(seed, size=64):
    return np.random.RandomState(seed & 0x7fffffff).rand(size, size, size)


def vnoise(p, freq, table):
    """Trilinear value noise of points ``p`` (n, 3) at ``freq`` cells per metre, in [0, 1]."""
    q = p * freq + 512.0
    i = np.floor(q).astype(int)
    f = q - i
    f = f * f * (3 - 2 * f)
    i %= table.shape[0]
    j = (i + 1) % table.shape[0]
    sample = lambda a, b, c: table[a[..., 0], b[..., 1], c[..., 2]]
    x00 = sample(i, i, i) * (1 - f[..., 0]) + sample(j, i, i) * f[..., 0]
    x10 = sample(i, j, i) * (1 - f[..., 0]) + sample(j, j, i) * f[..., 0]
    x01 = sample(i, i, j) * (1 - f[..., 0]) + sample(j, i, j) * f[..., 0]
    x11 = sample(i, j, j) * (1 - f[..., 0]) + sample(j, j, j) * f[..., 0]
    y0 = x00 * (1 - f[..., 1]) + x10 * f[..., 1]
    y1 = x01 * (1 - f[..., 1]) + x11 * f[..., 1]
    return y0 * (1 - f[..., 2]) + y1 * f[..., 2]


def smoothstep(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def blur_rows(a, passes):
    """Smooth along v only (the angle wraps nowhere here), keeping the first and last rows."""
    for _ in range(passes):
        b = a.copy()
        b[1:-1] = (a[:-2] + 2 * a[1:-1] + a[2:]) / 4
        a = b
    return a


def window_rows(a, size):
    """The moving average of ``size`` rows along v, with the ends held."""
    half = max(1, size // 2)
    padded = np.concatenate([np.repeat(a[:1], half + 1, 0), a, np.repeat(a[-1:], half, 0)], 0)
    total = np.cumsum(padded, 0)
    return (total[2 * half + 1:] - total[:-(2 * half + 1)]) / (2 * half + 1)


def blur(a, passes):
    for _ in range(passes):
        b = (np.roll(a, 1, 1) + np.roll(a, -1, 1) + 2 * a) / 4
        b[1:-1] = (b[:-2] + 2 * b[1:-1] + b[2:]) / 4
        a = b
    return a


def grid_normals(p):
    du = np.roll(p, -1, 1) - np.roll(p, 1, 1)
    dv = np.zeros_like(p)
    dv[1:-1] = p[2:] - p[:-2]
    dv[0], dv[-1] = dv[1], dv[-2]
    n = np.cross(du, dv)
    return n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)


def radius_field(theta, y, cfg, rng, noise):
    """Radius per grid point on the unit profile: strata with their own fracture planes, inset ledges and joints."""
    rx, rz = cfg["radii"]
    height = cfg["height"]
    ellipse = lambda a: 1.0 / np.sqrt((np.cos(a) / rx) ** 2 + (np.sin(a) / rz) ** 2)
    circle = np.stack([np.cos(theta) * 1.4, np.sin(theta) * 1.4, y * 0.1], -1)
    body = ellipse(theta) * (0.86 + 0.34 * vnoise(circle, 1.0, noise[0]))
    scale = min(1.0, height / 10.0)
    # Bedding: a dipping, warped height splits the rock into strata; a few strata share one set of fractures.
    dip = rng.uniform(-0.3, 0.3, 2)
    warp = (vnoise(np.stack([np.cos(theta) * 2, np.sin(theta) * 2, y * 0.25], -1), 1.0, noise[1]) - 0.5) * 0.9
    bed = y + (np.cos(theta) * dip[0] + np.sin(theta) * dip[1]) * body + warp
    bounds = [-6.0]
    while bounds[-1] < height + 6:
        bounds.append(bounds[-1] + rng.uniform(0.45, 1.5) * (0.55 + 0.45 * scale))
    bounds = np.array(bounds)
    band = np.clip(np.searchsorted(bounds, bed) - 1, 0, len(bounds) - 2)
    insets = rng.uniform(-0.12, 0.42, len(bounds)) * (0.5 + 0.5 * scale)
    group_of = np.cumsum(rng.rand(len(bounds)) < 0.42)
    r = body.copy()
    for group in np.unique(group_of):
        mask = group_of[band] == group
        if not mask.any():
            continue
        limit = np.full(mask.sum(), np.inf)
        count = rng.randint(8, 13)
        spin = rng.uniform(0, math.tau)
        for k in range(count):
            phi = spin + math.tau * (k + rng.uniform(-0.3, 0.3)) / count
            reach = ellipse(np.array(phi)) * rng.uniform(0.66, 0.98)
            c = np.cos(theta[mask] - phi)
            with np.errstate(divide="ignore"):
                limit = np.minimum(limit, np.where(c > 0.12, reach / c, np.inf))
        r[mask] = np.minimum(r[mask], limit)
        # Vertical joints: narrow V-grooves at this group's own angles.
        for _ in range(rng.randint(5, 10)):
            at, depth, width = rng.uniform(0, math.tau), rng.uniform(0.08, 0.4) * scale, rng.uniform(0.012, 0.045)
            delta = np.abs((theta[mask] - at + math.pi) % math.tau - math.pi)
            r[mask] -= depth * np.clip(1 - delta / width, 0, 1) ** 1.5
    r -= insets[band]
    joint = np.min(np.abs(bed[..., None] - bounds[(band[..., None] + np.array([0, 1])).clip(0, len(bounds) - 1)]), axis=-1)
    r -= 0.16 * scale * (1 - np.clip(joint / 0.07, 0, 1)) ** 2
    return r


def sculpt_arrays(cfg):
    """The sculpt's grid: points (rows, cols, 3) in Blender axes and the blend masks."""
    rng = np.random.RandomState(cfg["seed"])
    noise = [lattice(cfg["seed"] + i) for i in range(6)]
    height = cfg["height"]
    cols = int(np.clip(math.tau * max(cfg["radii"]) * 1.4 / CELL, 300, 1200))
    rows = int(np.clip((height + BURY + 2 * max(cfg["radii"])) / (CELL * 0.75), 300, 1200))
    theta = np.linspace(0, math.tau, cols, endpoint=False)[None, :].repeat(rows, 0)
    v = np.linspace(0, 1, rows)[:, None].repeat(cols, 1)
    face = np.clip((v - SKIRT) / (CROWN - SKIRT), 0, 1)
    # The face's rise and taper.
    top = height * 0.94
    y = np.where(v < SKIRT, -BURY + (BURY + 0.5) * smoothstep(0, SKIRT, v), 0.5 + (top - 0.5) * face)
    taper = 1.0 + 0.06 * np.sin(face * 2.3) - 0.62 * face ** 1.25
    r = radius_field(theta, y, cfg, rng, noise) * taper
    r = blur_rows(r, 2)
    # No stratum juts far past those around it, so the upper rock never grows a hooded beak.
    r = np.minimum(r, window_rows(r, int(2.4 / (height / rows))) * 1.08)
    # Towards the ground the fractures die out and the foot spreads into a low, soft apron that meets the terrain.
    calm = smoothstep(SKIRT * 0.45, SKIRT * 1.5, v)
    r = blur(r, 60) * (1 - calm) + r * calm
    r *= 1.0 + 0.75 * (1 - smoothstep(0.0, SKIRT * 1.25, v)) ** 1.6
    crown = np.clip((v - CROWN) / (1 - CROWN), 0, 1)
    r *= np.sqrt(np.maximum(1 - crown ** 2.2, 0))
    y = y + (height - top) * np.sin(crown * math.pi / 2)
    lean = np.maximum(y / height, 0) ** 1.25
    p = np.stack([r * np.cos(theta) + cfg["lean"][0] * lean, r * np.sin(theta) + cfg["lean"][1] * lean, y], -1)
    # Roughness: ridged weathering at three scales, along the surface normal.
    n = grid_normals(p)
    flat = p.reshape(-1, 3)
    ridge = lambda f, t: (1 - np.abs(2 * vnoise(flat, f, noise[t]) - 1)).reshape(rows, cols)
    scale = min(1.0, height / 8.0)
    relief = 0.2 * scale * ridge(0.55, 2) + 0.09 * ridge(1.7, 3) + 0.04 * ridge(4.6, 4) + 0.015 * ridge(13.0, 5)
    keep = smoothstep(0.0, SKIRT, v)  # the buried foot stays smooth
    p = p + n * ((relief - 0.17 * scale - 0.07) * keep)[..., None]
    n = grid_normals(p)
    # How recessed a point is relative to its neighbourhood.
    radial = np.linalg.norm(p[..., :2] - np.stack([cfg["lean"][0] * np.maximum(p[..., 2] / height, 0) ** 1.25, cfg["lean"][1] * np.maximum(p[..., 2] / height, 0) ** 1.25], -1), axis=-1)
    cavity = np.clip((blur(radial, 14) - radial) * 5.0, 0, 1) * smoothstep(0.3, 1.8, p[..., 2])  # the apron stays the ground's colour
    # Blend masks: noisy, so no edge is a straight line round the rock.
    edge = vnoise(flat, 0.7, noise[1]).reshape(rows, cols) * 0.6 + vnoise(flat, 3.1, noise[2]).reshape(rows, cols) * 0.4
    up = n[..., 2]
    foot = 1 - smoothstep(0.5, 2.6, p[..., 2] + (edge - 0.5) * 2.6)
    grass_foot = 1 - smoothstep(0.15, 1.5, p[..., 2] + (edge - 0.5) * 2.2)
    broad = vnoise(flat, 0.28, noise[3]).reshape(rows, cols)
    ledge = smoothstep(0.55, 0.85, up)
    moss = np.clip(smoothstep(0.15, 0.6, up) * smoothstep(0.4, 0.6, edge) + ledge * 0.5, 0, 1) * 0.9
    crown_grass = smoothstep(CROWN - 0.02, CROWN + 0.05, v + (edge - 0.5) * 0.07) * smoothstep(0.25, 0.45, up + edge * 0.3)
    grass = np.maximum.reduce([grass_foot, crown_grass, ledge * smoothstep(0.56, 0.68, broad)])
    gravel = np.clip(foot, 0, 1) * (1 - grass)
    return p, np.stack([gravel, grass, moss, cavity], -1)


def rubble(cfg, rng):
    """Boulders half-buried round the foot, so the rock does not meet the grass along one clean line."""
    rx, rz = cfg["radii"]
    bm = bmesh.new()
    count = int(14 + 18 * min(1.0, cfg["height"] / 12))
    for _ in range(count):
        a = rng.uniform(0, math.tau)
        d = 0.92 + rng.uniform(0, 1) ** 1.8 * 0.5
        size = (0.75 - (d - 0.92) * 1.0) * rng.uniform(0.35, 1.0) * min(1.0, cfg["height"] / 9 + 0.35)
        centre = (rx * d * math.cos(a), rz * d * math.sin(a), size * rng.uniform(-0.45, 0.0))
        made = bmesh.ops.create_icosphere(bm, subdivisions=4, radius=1.0)
        # Angular: every vertex is pulled onto the nearest of a few random fracture planes.
        directions = rng.normal(size=(9, 3))
        directions /= np.linalg.norm(directions, axis=1, keepdims=True)
        offsets = rng.uniform(0.62, 1.0, 9)
        stretch = rng.uniform(0.75, 1.4, 3)
        for vert in made["verts"]:
            point = np.array(vert.co)
            shaped = point * np.min(np.where(directions @ point > 0.05, offsets / (directions @ point), 1.6)) * stretch * size
            vert.co = (shaped[0] + centre[0], shaped[1] + centre[1], shaped[2] + centre[2])
    mesh = bpy.data.meshes.new("rubble")
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def grid_mesh(name, p, masks, collection, cfg, rng):
    rows, cols = p.shape[:2]
    index = lambda r, c: r * cols + c % cols
    r0 = np.arange(rows - 1)[:, None].repeat(cols, 1).ravel()
    c0 = np.arange(cols)[None, :].repeat(rows - 1, 0).ravel()
    quads = np.stack([index(r0, c0), index(r0, c0 + 1), index(r0 + 1, c0 + 1), index(r0 + 1, c0)], -1)
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(rows * cols)
    mesh.vertices.foreach_set("co", p.reshape(-1))
    mesh.loops.add(quads.size)
    mesh.polygons.add(len(quads))
    mesh.loops.foreach_set("vertex_index", quads.ravel())
    mesh.polygons.foreach_set("loop_start", np.arange(len(quads)) * 4)
    mesh.update(calc_edges=True)
    colours = np.concatenate([masks.reshape(-1, 4)], 0)
    attr = mesh.color_attributes.new("Mask", "FLOAT_COLOR", "POINT")
    attr.data.foreach_set("color", colours.ravel())
    mesh.polygons.foreach_set("use_smooth", np.ones(len(quads), dtype=bool))
    # Rubble joins the sculpt with the foot's mask: gravel and grass in its creases, moss on top.
    extra = rubble(cfg, rng)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    start = len(bm.verts)
    bm.from_mesh(extra)
    bm.to_mesh(mesh)
    bm.free()
    bpy.data.meshes.remove(extra)
    count = len(mesh.vertices)
    if count > start:
        co = np.empty(count * 3)
        mesh.vertices.foreach_get("co", co)
        z = co.reshape(-1, 3)[start:, 2]
        data = np.empty(count * 4)
        mesh.color_attributes["Mask"].data.foreach_get("color", data)
        data = data.reshape(-1, 4)
        data[start:] = np.stack([0.5 * (1 - smoothstep(0.0, 0.5, z)), 1 - smoothstep(-0.05, 0.28, z), smoothstep(0.1, 0.5, z) * 0.45, np.full(count - start, 0.2)], -1)
        mesh.color_attributes["Mask"].data.foreach_set("color", data.ravel())
        mesh.polygons.foreach_set("use_smooth", np.ones(len(mesh.polygons), dtype=bool))
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def sculpt(name, part, collection):
    cfg = OUTCROPS[part]
    p, masks = sculpt_arrays(cfg)
    return grid_mesh(name, p, masks, collection, cfg, np.random.RandomState(cfg["seed"] + 99))


def projected(tree, path, colour, tile):
    nodes, links = tree.nodes, tree.links
    coords = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (1 / tile, 1 / tile, 1 / tile)
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(path, check_existing=True)
    texture.image.colorspace_settings.is_data = not colour
    texture.projection = "BOX"
    texture.projection_blend = 0.35
    links.new(coords.outputs["Object"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    return texture


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def mean_linear(image):
    """The scan's mean colour in linear light (``Image.pixels`` of a byte image is sRGB-encoded)."""
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    return srgb_to_linear(pixels.reshape(-1, 4)[::7, :3].astype(float)).mean(axis=0)


def graded(tree, path, tile, palette):
    """A scan as detail round the game's palette colour: the texture divided by its mean, as the clients do."""
    texture = projected(tree, path, True, tile)
    grade = tree.nodes.new("ShaderNodeMix")
    grade.data_type, grade.blend_type = "RGBA", "MULTIPLY"
    grade.inputs["Factor"].default_value = 1.0
    target = srgb_to_linear(np.array([(palette >> 16 & 255) / 255, (palette >> 8 & 255) / 255, (palette & 255) / 255]))
    grade.inputs[7].default_value = (*(target / mean_linear(texture.image)).tolist(), 1)
    tree.links.new(texture.outputs["Color"], grade.inputs[6])
    return grade.outputs[2]


def mix(tree, factor, a, b):
    node = tree.nodes.new("ShaderNodeMix")
    node.data_type = "RGBA"
    tree.links.new(factor, node.inputs["Factor"])
    tree.links.new(a, node.inputs[6])
    tree.links.new(b, node.inputs[7])
    return node.outputs[2]


def sculpt_material(name, inputs):
    """The bake source: rock, moss, gravel and grass, blended by the sculpt's ``Mask`` attribute."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    links = tree.links
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    rock = graded(tree, inputs["rockColour"], TILE["rock"], PALETTE["rock"])
    grass = graded(tree, inputs["grassColour"], TILE["grass"], PALETTE["grass"])
    gravel = graded(tree, inputs["gravelColour"], TILE["gravel"], PALETTE["gravel"])
    moss = graded(tree, inputs["mossColour"], TILE["moss"], PALETTE["moss"])
    mask = tree.nodes.new("ShaderNodeVertexColor")
    mask.layer_name = "Mask"
    parts = tree.nodes.new("ShaderNodeSeparateColor")
    links.new(mask.outputs["Color"], parts.inputs["Color"])
    gravel_f, grass_f, moss_f = parts.outputs[0], parts.outputs[1], parts.outputs[2]
    colour = mix(tree, moss_f, rock, moss)
    colour = mix(tree, gravel_f, colour, gravel)
    colour = mix(tree, grass_f, colour, grass)
    shade = tree.nodes.new("ShaderNodeMix")
    shade.data_type, shade.blend_type = "RGBA", "MULTIPLY"
    shade.inputs[7].default_value = (0.18, 0.17, 0.16, 1)
    links.new(mask.outputs["Alpha"], shade.inputs["Factor"])
    links.new(colour, shade.inputs[6])
    links.new(shade.outputs[2], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    bsdf.inputs["Metallic"].default_value = 0.0
    height = projected(tree, inputs["rockHeight"], False, TILE["rock"]).outputs["Color"]
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.85
    bump.inputs["Distance"].default_value = 0.09
    links.new(height, bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def triangles(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def game_mesh(sculpted, target, collection):
    """A decimated, UV-unwrapped copy of the sculpt."""
    low = sculpted.copy()
    low.data = sculpted.data.copy()
    low.name = f"{sculpted.name}_low"
    collection.objects.link(low)
    decimate = low.modifiers.new("decimate", "DECIMATE")
    decimate.ratio = target / max(1, triangles(sculpted))
    bpy.context.view_layer.objects.active = low
    with bpy.context.temp_override(object=low, active_object=low):
        bpy.ops.object.modifier_apply(modifier=decimate.name)
    low.data.materials.clear()
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.004, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    return low


def bake(sculpted, low, name, edge):
    """Cycles bakes the sculpt's colour, normal and roughness onto the game mesh; returns the game material."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 4
    scene.cycles.use_denoising = False
    scene.cycles.seed = 0
    mat = bpy.data.materials.new(f"{name}_rock")
    mat.use_nodes = True
    low.data.materials.append(mat)
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    target = tree.nodes.new("ShaderNodeTexImage")
    settings = scene.render.bake
    settings.use_selected_to_active = True
    settings.cage_extrusion = 0.5
    settings.max_ray_distance = 1.0
    settings.margin = 8
    images = {}
    for kind, label, colour, size in (("DIFFUSE", "colour", True, edge), ("NORMAL", "normal", False, edge), ("ROUGHNESS", "roughness", False, edge // 2)):
        image = bpy.data.images.new(f"{name}_{label}", size, size, alpha=False, float_buffer=False)
        image.colorspace_settings.is_data = not colour
        target.image = image
        tree.nodes.active = target
        bpy.ops.object.select_all(action="DESELECT")
        sculpted.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low
        if kind == "DIFFUSE":
            settings.use_pass_direct = False
            settings.use_pass_indirect = False
            settings.use_pass_color = True
        bpy.ops.object.bake(type=kind, normal_space="TANGENT")
        images[label] = image
    tree.nodes.remove(target)
    colour = tree.nodes.new("ShaderNodeTexImage")
    colour.image = images["colour"]
    tree.links.new(colour.outputs["Color"], bsdf.inputs["Base Color"])
    rough = tree.nodes.new("ShaderNodeTexImage")
    rough.image = images["roughness"]
    tree.links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    normal = tree.nodes.new("ShaderNodeTexImage")
    normal.image = images["normal"]
    normal_map = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(normal.outputs["Color"], normal_map.inputs["Color"])
    tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


INPUTS = {"rockColour", "rockHeight", "grassColour", "gravelColour", "mossColour"}
# part "atlas" packs every outcrop's baked maps into one set, so all of them draw with one material. Inputs ``colour<i>``,
# ``normal<i>`` and ``rough<i>`` are the baked PNGs of OUTCROPS' i-th rock.
ATLAS = "atlas"
ATLAS_EDGE = 4096
ATLAS_RECTS = {"buttress-1": (0, 0), "buttress-2": (2048, 0), "spire": (0, 2048), "talus-1": (2048, 2048), "talus-2": (3072, 2048)}  # top-left pixels
ATLAS_INPUTS = {f"{kind}{i}" for kind in ("colour", "normal", "rough") for i in range(len(OUTCROPS))}


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "part"} or arguments["schemaVersion"] != 1:
        raise ValueError("cliff outcrop arguments must be {schemaVersion: 1, part}")
    if arguments["part"] != ATLAS and arguments["part"] not in OUTCROPS:
        raise ValueError(f"cliff outcrop part must be one of {', '.join(OUTCROPS)} or {ATLAS}")
    expected = ATLAS_INPUTS if arguments["part"] == ATLAS else INPUTS
    if set(inputs) != expected:
        raise ValueError(f"cliff outcrop takes exactly the inputs {', '.join(sorted(expected))}")


def pack_map(name, inputs, kind, edge, colour):
    """One atlas image from the rocks' baked ``kind`` maps; ``edge`` is the atlas edge in pixels."""
    pixels = np.ones((edge, edge, 4), dtype=np.float32)
    scale = edge / ATLAS_EDGE
    for i, part in enumerate(OUTCROPS):
        source = bpy.data.images.load(inputs[f"{kind}{i}"], check_existing=True)
        width, height = source.size
        data = np.empty(width * height * 4, dtype=np.float32)
        source.pixels.foreach_get(data)
        x, y = (int(c * scale) for c in ATLAS_RECTS[part])
        expected = int(OUTCROPS[part]["edge"] * scale)
        if (width, height) != (expected, expected):
            raise ValueError(f"{part}'s baked {kind} map is {width} x {height}, not {expected} x {expected}")
        # Blender's rows run bottom-up.
        pixels[edge - y - height:edge - y, x:x + width] = data.reshape(height, width, 4)
    image = bpy.data.images.new(name, edge, edge, alpha=False)
    image.colorspace_settings.is_data = not colour
    image.pixels.foreach_set(pixels.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def generate_atlas(output_path, inputs):
    """A quad carrying the packed maps; the build moves every outcrop's UVs onto them."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    mesh = bpy.data.meshes.new("outcrop-atlas")
    mesh.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
    mesh.uv_layers.new(name="UVMap")
    mesh.update()
    mat = bpy.data.materials.new("outcrop-rock")
    mat.use_nodes = True
    tree = mat.node_tree
    links = tree.links
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    def texture(image):
        node = tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        return node
    links.new(texture(pack_map("outcrop-atlas-colour", inputs, "colour", ATLAS_EDGE, True)).outputs["Color"], bsdf.inputs["Base Color"])
    normal = tree.nodes.new("ShaderNodeNormalMap")
    links.new(texture(pack_map("outcrop-atlas-normal", inputs, "normal", ATLAS_EDGE, False)).outputs["Color"], normal.inputs["Color"])
    links.new(normal.outputs["Normal"], bsdf.inputs["Normal"])
    channels = tree.nodes.new("ShaderNodeSeparateColor")
    links.new(texture(pack_map("outcrop-atlas-rough", inputs, "rough", ATLAS_EDGE // 2, False)).outputs["Color"], channels.inputs["Color"])
    links.new(channels.outputs[1], bsdf.inputs["Roughness"])
    links.new(channels.outputs[2], bsdf.inputs["Metallic"])
    mesh.materials.append(mat)
    obj = bpy.data.objects.new("outcrop-atlas", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=output_path, export_format="GLB", use_selection=True, export_yup=True, export_texcoords=True, export_normals=True,
                              export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO", export_animations=False, export_skins=False,
                              export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "part": ATLAS, "edge": ATLAS_EDGE,
            "rects": {part: {"x": ATLAS_RECTS[part][0], "y": ATLAS_RECTS[part][1], "edge": OUTCROPS[part]["edge"]} for part in OUTCROPS}}


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    if arguments["part"] == ATLAS:
        return generate_atlas(output_path, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    part = arguments["part"]
    cfg = OUTCROPS[part]
    collection = bpy.context.scene.collection
    name = f"outcrop_{part}"
    sculpted = sculpt(f"{name}_sculpt", part, collection)
    sculpted.data.materials.append(sculpt_material(f"{name}_sculpt", inputs))
    low = game_mesh(sculpted, cfg["triangles"], collection)
    bake(sculpted, low, name, cfg["edge"])
    bpy.data.objects.remove(sculpted)
    low.name = name
    low.data.name = name
    for attribute in list(low.data.color_attributes):
        low.data.color_attributes.remove(attribute)
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO",
        export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "part": part, "triangles": triangles(low), "bakeEdge": cfg["edge"], "bury": BURY,
            "fit": {"radii": list(cfg["radii"]), "height": cfg["height"], "lean": [cfg["lean"][0], -cfg["lean"][1]]}}
