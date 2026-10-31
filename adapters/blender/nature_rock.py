"""Greyhaven nature rock (asset-tooling#451): one authored, detailed rock with a baked CC0 PBR material.

The declared inputs are the CC0 Poly Haven ``rock_boulder_dry`` colour, height and roughness maps (``rockColour``,
``rockHeight``, ``rockRoughness``) and the ``mossy_rock`` colour map (``mossColour``).

A rock is built in three steps:

* **Shape.** A convex block is cut from an ellipsoid by fracture planes, with a flat base (and optionally a nearly
  level cap); planar chips are knocked off its edges and corners. It is voxel-remeshed into a dense sculpt, then
  displaced: bedding layers along a tilted axis (each layer inset or proud of its neighbours, with a crack along
  every bedding joint), ridged weathering and a broad wobble. Finally it is grounded, centred and fitted to ``size``
  ([width, depth, height] in metres);
* **Material.** The sculpt gets a box-projected, colour-graded rock material. Lichen and moss grow on the up-facing
  faces, broken up by noise; the base and the cavities are darker and earthier;
* **Game mesh.** A decimated copy (about ``triangles`` triangles) is UV-unwrapped, and Cycles bakes the sculpt's
  colour, normal and roughness onto it (1024 px). The game mesh carries one material with those three maps.

The recipe also returns a collision proxy: the convex hull of the game mesh's support points in 48 directions (at
most 92 triangles), in glTF coordinates (+Y up) in the GLB's own frame.

Everything is seeded from ``arguments["seed"]``. Blender coordinates are Z up; the GLB is exported +Y up.
"""
import math
import random

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector, noise

RECIPE = "nature-rock-v1"
SHAPES = ("stratified", "boulder", "slab")
BAKE_EDGE = 1024
HULL_DIRECTIONS = 48
VOXEL = 0.022  # sculpt resolution, metres
TEXTURE_SCALE = 0.8  # rock texture repeats per metre
MOSS_SCALE = 0.7

# Per shape: fracture cuts, bedding tilt (degrees from vertical), layer thickness range (m), layer inset (m),
# joint crack depth (m), edge chip depth (m), weathering amplitude (m), moss coverage (0..1), rounding (smoothing
# iterations before displacement) and cap.
SHAPE = {
    "stratified": dict(cuts=20, tilt=6, layer=(0.18, 0.45), inset=0.22, crack=0.05, chip=0.14, weather=0.05, moss=0.75, round=3, cap=0.5),
    "boulder": dict(cuts=30, tilt=35, layer=(0.35, 0.8), inset=0.06, crack=0.04, chip=0.2, weather=0.06, moss=0.65, round=5, cap=0),
    "slab": dict(cuts=18, tilt=58, layer=(0.14, 0.32), inset=0.15, crack=0.045, chip=0.12, weather=0.04, moss=0.8, round=2, cap=0),
}
# The cap is a nearly level top cut, as a share of the ellipsoid's height above its centre (0: none).

# Colour grade (linear), tuned in Blender against the #446 broadleaf and #454 conifer.
ROCK_TINT = (0.46, 0.48, 0.49)
ROCK_SATURATION = 0.35
ROCK_GAMMA = 1.35
MOSS_TINT = (0.42, 0.56, 0.2)
DIRT = (0.075, 0.062, 0.045)


def validate(p, inputs):
    keys = {"schemaVersion", "shape", "seed", "size", "triangles"}
    if type(p) is not dict or set(p) != keys:
        raise ValueError("nature rock requires exactly schemaVersion, shape, seed, size and triangles")
    if p["schemaVersion"] != 1 or p["shape"] not in SHAPES or type(p["seed"]) is not int:
        raise ValueError(f"nature rock: schemaVersion 1, shape in {SHAPES}, integer seed")
    size = p["size"]
    if type(size) is not list or len(size) != 3 or not all(type(v) in (int, float) and 0.3 <= v <= 8 for v in size):
        raise ValueError("nature rock size is [width, depth, height] in metres, each 0.3..8")
    if type(p["triangles"]) is not int or not 300 <= p["triangles"] <= 6000:
        raise ValueError("nature rock triangles must be an integer 300..6000")
    if set(inputs) != {"rockColour", "rockHeight", "rockRoughness", "mossColour"}:
        raise ValueError("nature rock takes exactly rockColour, rockHeight, rockRoughness and mossColour")


def unit(rng):
    z = rng.uniform(-1, 1)
    a = rng.uniform(0, 2 * math.pi)
    r = math.sqrt(1 - z * z)
    return Vector((r * math.cos(a), r * math.sin(a), z))


def fibonacci(n):
    out = []
    for i in range(n):
        z = 1 - 2 * (i + 0.5) / n
        r = math.sqrt(1 - z * z)
        a = i * math.pi * (3 - math.sqrt(5))
        out.append(Vector((r * math.cos(a), r * math.sin(a), z)))
    return out


def fracture_planes(rng, half, cfg):
    """Fracture planes (normal, offset) around an ellipsoid with semi-axes ``half``, plus the flat base."""
    planes = []
    for direction in fibonacci(cfg["cuts"]):
        n = (direction + unit(rng) * 0.35).normalized()
        if n.z < -0.3:  # the base is one flat cut
            continue
        support = math.sqrt(sum((h * c) ** 2 for h, c in zip(half, n)))
        planes.append((n, support * rng.uniform(0.66, 0.97)))
    if cfg["cap"]:  # a weathered, nearly level top
        n = (Vector((0, 0, 1)) + unit(rng) * 0.15).normalized()
        planes.append((n, half[2] * cfg["cap"]))
    planes.append((Vector((0, 0, -1)), half[2] * 0.62))  # the flat base stays last
    return planes


def cut_block(planes, half, rng, chip):
    """Cut the convex block, then knock planar chips off its edges and corners (the chip cuts join ``planes``)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * half[0] * 3, v.co.y * half[1] * 3, v.co.z * half[2] * 3))

    def cut(n, d):
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        result = bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=n * d, plane_no=n, clear_outer=True)
        edges = [e for e in result["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        if edges:
            bmesh.ops.edgeloop_fill(bm, edges=edges)

    for n, d in planes:
        cut(n, d)
    base = -planes[-1][1]
    chips = []
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.normal_update()
    for e in bm.edges:
        if len(e.link_faces) != 2 or e.calc_face_angle(0) < math.radians(25) or e.calc_length() < 0.2:
            continue
        a, b = e.verts[0].co.copy(), e.verts[1].co.copy()
        if max(a.z, b.z) < base + 0.3:
            continue  # leave the footprint edge alone
        normal = (e.link_faces[0].normal + e.link_faces[1].normal).normalized()
        for _ in range(1 + int(e.calc_length() / 0.9)):
            if rng.random() > 0.75:
                continue
            p = a.lerp(b, rng.uniform(0.1, 0.9))
            n = (normal + unit(rng) * 0.45).normalized()
            chips.append((n, p.dot(n) - chip * rng.uniform(0.35, 1.2)))
    for v in bm.verts:
        if v.co.z > base + 0.1 and rng.random() < 0.8:
            n = sum((f.normal for f in v.link_faces), Vector()).normalized()
            n = (n + unit(rng) * 0.3).normalized()
            chips.append((n, v.co.dot(n) - chip * rng.uniform(0.8, 1.8)))
    for n, d in chips:
        cut(n, d)
    planes.extend(chips)
    return bm


def sculpt(name, arguments, collection):
    """The dense, displaced sculpt (Z up, base near z = 0)."""
    cfg = SHAPE[arguments["shape"]]
    rng = random.Random(arguments["seed"])
    w, d, h = arguments["size"]
    half = (w / 2, d / 2, h / 1.62)  # the base cut removes the lower part of the ellipsoid
    planes = fracture_planes(rng, half, cfg)
    bm = cut_block(planes, half, rng, cfg["chip"])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    remesh = obj.modifiers.new("remesh", "REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = VOXEL
    smooth = obj.modifiers.new("round", "SMOOTH")
    smooth.factor = 0.8
    smooth.iterations = cfg["round"]
    bpy.context.view_layer.objects.active = obj
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=remesh.name)
        bpy.ops.object.modifier_apply(modifier=smooth.name)

    # Bedding layers along a tilted axis: each layer is inset or proud, blended over a few centimetres.
    tilt = math.radians(cfg["tilt"])
    spin = rng.uniform(0, 2 * math.pi)
    bed = Vector((math.sin(tilt) * math.cos(spin), math.sin(tilt) * math.sin(spin), math.cos(tilt)))
    reach = max(half) * 2.2
    bounds, insets = [-reach], [0.0]
    while bounds[-1] < reach:
        bounds.append(bounds[-1] + rng.uniform(*cfg["layer"]))
        insets.append(rng.uniform(-0.35, 1.0) * cfg["inset"])
    bounds, insets = np.array(bounds), np.array(insets)
    offset = rng.uniform(0, 10)
    shift = Vector((offset, offset * 0.7, offset * 1.3))
    mesh = obj.data
    count = len(mesh.vertices)
    cos = np.empty(count * 3)
    mesh.vertices.foreach_get("co", cos)
    nos = np.empty(count * 3)
    mesh.vertices.foreach_get("normal", nos)
    cos, nos = cos.reshape(-1, 3), nos.reshape(-1, 3)
    points = [Vector(c) for c in cos]
    warp = np.array([noise.noise(p * 1.3 + shift) for p in points])
    hb = cos @ np.array(bed) + warp * 0.06
    side = 1 - np.abs(nos @ np.array(bed))
    edge = 0.035
    inset = np.full(count, insets[0])
    for j in range(1, len(bounds)):
        t = np.clip((hb - bounds[j] + edge) / (2 * edge), 0, 1)
        inset += (insets[j] - insets[j - 1]) * t * t * (3 - 2 * t)
    joint = np.min(np.abs(hb[:, None] - bounds[None, :]), axis=1)
    crackle = np.array([0.5 + 0.5 * noise.noise(p * 3 + shift) for p in points])
    crack = cfg["crack"] * (1 - np.clip(joint / 0.045, 0, 1)) ** 2 * crackle
    rise = cos[:, 2] - cos[:, 2].min()
    fade = np.clip((rise - 0.12) / 0.35, 0, 1)  # the lowest layer meets the ground without a plinth
    disp = -(inset * side ** 1.5) * fade - crack * side
    # Weathering: ridged fine detail and a broad wobble.
    for i, p in enumerate(points):
        disp[i] -= cfg["weather"] * noise.ridged_multi_fractal(p * 3.0 + shift, 0.9, 2.2, 4, 0.0, 2.0) * 0.5
        disp[i] += 0.11 * noise.noise(p * 0.5 + shift) + 0.06 * noise.noise(p * 1.3 + shift) + 0.02 * noise.noise(p * 3.1 + shift)
    disp[cos[:, 2] < -half[2] * 0.62 + 0.06] *= 0.15  # keep the base flat
    shaped = cos + nos * disp[:, None]
    mesh.vertices.foreach_set("co", shaped.reshape(-1))
    # Ground it: base at z = 0, footprint centred on the origin.
    # Ground it (base at z = 0, footprint centred) and fit it to the requested size.
    lo, hi = shaped.min(axis=0), shaped.max(axis=0)
    mesh.transform(Matrix.Diagonal((w / (hi[0] - lo[0]), d / (hi[1] - lo[1]), h / (hi[2] - lo[2]), 1.0))
                   @ Matrix.Translation((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2])))
    mesh.update()
    return obj


def image_node(tree, path, colour, scale, blend=0.5):
    """A box-projected image texture in object space, ``scale`` repeats per metre."""
    nodes, links = tree.nodes, tree.links
    coords = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (scale, scale, scale)
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(path, check_existing=True)
    texture.image.colorspace_settings.is_data = not colour
    texture.projection = "BOX"
    texture.projection_blend = blend
    links.new(coords.outputs["Object"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    return texture


def node(tree, kind, **inputs):
    item = tree.nodes.new(kind)
    for key, value in sorted(inputs.items(), key=lambda pair: not pair[0].startswith("_")):
        if key.startswith("_"):
            setattr(item, key[1:], value)
        else:
            item.inputs[key].default_value = value
    return item


def sculpt_material(name, inputs, cfg, seed):
    """The bake source: graded rock, lichen and moss on the tops, dirt at the base and in the cavities."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    links = tree.links
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    rock = image_node(tree, inputs["rockColour"], True, TEXTURE_SCALE)
    height = image_node(tree, inputs["rockHeight"], False, TEXTURE_SCALE)
    rough = image_node(tree, inputs["rockRoughness"], False, TEXTURE_SCALE)
    moss = image_node(tree, inputs["mossColour"], True, MOSS_SCALE)
    grade = node(tree, "ShaderNodeHueSaturation", Saturation=ROCK_SATURATION, Value=1.0)
    links.new(rock.outputs["Color"], grade.inputs["Color"])
    contrast = node(tree, "ShaderNodeGamma", Gamma=ROCK_GAMMA)
    links.new(grade.outputs["Color"], contrast.inputs["Color"])
    tint = node(tree, "ShaderNodeMix", _data_type="RGBA", _blend_type="MULTIPLY", Factor=1.0)
    tint.inputs[7].default_value = (*ROCK_TINT, 1)
    links.new(contrast.outputs["Color"], tint.inputs[6])
    # Moss: up-facing, broken into patches by noise.
    geometry = node(tree, "ShaderNodeNewGeometry")
    up = node(tree, "ShaderNodeSeparateXYZ")
    links.new(geometry.outputs["Normal"], up.inputs["Vector"])
    facing = node(tree, "ShaderNodeMapRange", **{"From Min": 0.3, "From Max": 0.65})
    links.new(up.outputs["Z"], facing.inputs["Value"])
    patches = node(tree, "ShaderNodeTexNoise", Scale=1.6, Detail=8.0, Roughness=0.62, W=seed % 97, _noise_dimensions="4D")
    patch = node(tree, "ShaderNodeMapRange", **{"From Min": 0.58 - 0.3 * cfg["moss"], "From Max": 0.62 - 0.3 * cfg["moss"]})
    links.new(patches.outputs["Fac"], patch.inputs["Value"])
    mask = node(tree, "ShaderNodeMath", _operation="MULTIPLY")
    links.new(facing.outputs["Result"], mask.inputs[0])
    links.new(patch.outputs["Result"], mask.inputs[1])
    moss_grade = node(tree, "ShaderNodeMix", _data_type="RGBA", _blend_type="MULTIPLY", Factor=1.0)
    moss_grade.inputs[7].default_value = (*MOSS_TINT, 1)
    links.new(moss.outputs["Color"], moss_grade.inputs[6])
    mossy = node(tree, "ShaderNodeMix", _data_type="RGBA")
    links.new(mask.outputs["Value"], mossy.inputs["Factor"])
    links.new(tint.outputs[2], mossy.inputs[6])
    links.new(moss_grade.outputs[2], mossy.inputs[7])
    # Dirt: earthy towards the base, darker in the cavities.
    position = node(tree, "ShaderNodeSeparateXYZ")
    links.new(geometry.outputs["Position"], position.inputs["Vector"])
    base = node(tree, "ShaderNodeMapRange", **{"From Min": 0.45, "From Max": 0.0})
    links.new(position.outputs["Z"], base.inputs["Value"])
    dirty = node(tree, "ShaderNodeMix", _data_type="RGBA")
    dirty.inputs[7].default_value = (*DIRT, 1)
    links.new(base.outputs["Result"], dirty.inputs["Factor"])
    links.new(mossy.outputs[2], dirty.inputs[6])
    occlusion = node(tree, "ShaderNodeAmbientOcclusion", Distance=0.35, _samples=16)
    cavity = node(tree, "ShaderNodeMix", _data_type="RGBA", _blend_type="MULTIPLY")
    cavity.inputs[7].default_value = (0.22, 0.21, 0.19, 1)
    invert = node(tree, "ShaderNodeMath", _operation="SUBTRACT", _use_clamp=True)
    invert.inputs[0].default_value = 1.0
    links.new(occlusion.outputs["AO"], invert.inputs[1])
    links.new(invert.outputs["Value"], cavity.inputs["Factor"])
    links.new(dirty.outputs[2], cavity.inputs[6])
    links.new(cavity.outputs[2], bsdf.inputs["Base Color"])
    # Roughness: the rock's, rougher under moss. Normal: the rock's height as bump, softened under moss.
    rougher = node(tree, "ShaderNodeMix", _data_type="FLOAT")
    rougher.inputs[3].default_value = 0.95
    links.new(mask.outputs["Value"], rougher.inputs["Factor"])
    links.new(rough.outputs["Color"], rougher.inputs[2])
    links.new(rougher.outputs[0], bsdf.inputs["Roughness"])
    bump = node(tree, "ShaderNodeBump", Strength=0.6, Distance=0.04)
    links.new(height.outputs["Color"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Metallic"].default_value = 0.0
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
    for poly in low.data.polygons:
        poly.use_smooth = True
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.004, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    return low


def bake(sculpted, low, name):
    """Cycles bakes the sculpt's colour, normal and roughness onto the game mesh; returns the game material."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.cycles.seed = 0
    images = {}
    mat = bpy.data.materials.new(f"{name}_rock")
    mat.use_nodes = True
    low.data.materials.append(mat)
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    target = tree.nodes.new("ShaderNodeTexImage")
    bake_settings = scene.render.bake
    bake_settings.use_selected_to_active = True
    bake_settings.cage_extrusion = 0.06
    bake_settings.max_ray_distance = 0.15
    bake_settings.margin = 6
    for kind, label, colour in (("DIFFUSE", "colour", True), ("NORMAL", "normal", False), ("ROUGHNESS", "roughness", False)):
        image = bpy.data.images.new(f"{name}_{label}", BAKE_EDGE, BAKE_EDGE, alpha=False, float_buffer=False)
        image.colorspace_settings.is_data = not colour
        target.image = image
        tree.nodes.active = target
        bpy.ops.object.select_all(action="DESELECT")
        sculpted.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low
        if kind == "DIFFUSE":
            bake_settings.use_pass_direct = False
            bake_settings.use_pass_indirect = False
            bake_settings.use_pass_color = True
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


def collision_hull(low):
    """Convex hull of the game mesh's support points in HULL_DIRECTIONS directions, in glTF axes (+Y up)."""
    co = np.empty(len(low.data.vertices) * 3)
    low.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    support = sorted({int(np.argmax(co @ np.array(d))) for d in fibonacci(HULL_DIRECTIONS)})
    bm = bmesh.new()
    for i in support:
        bm.verts.new(co[i])
    bmesh.ops.convex_hull(bm, input=bm.verts[:])
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.verts.index_update()
    vertices = [[round(v.co.x, 4), round(v.co.z, 4), round(-v.co.y, 4)] for v in bm.verts]
    faces = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    return {"shape": "convex-hull", "vertices": vertices, "triangles": faces}


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    collection = bpy.context.scene.collection
    name = f"rock_{arguments['shape']}"
    sculpted = sculpt(f"{name}_sculpt", arguments, collection)
    sculpted.data.materials.append(sculpt_material(f"{name}_sculpt", inputs, SHAPE[arguments["shape"]], arguments["seed"]))
    low = game_mesh(sculpted, arguments["triangles"], collection)
    bake(sculpted, low, name)
    hull = collision_hull(low)
    bpy.data.objects.remove(sculpted)
    low.name = name
    low.data.name = name
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    if output_path:
        bpy.ops.export_scene.gltf(
            filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
            export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE",
            export_image_format="AUTO",
            export_animations=False, export_skins=False, export_morph=False,
            export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "shape": arguments["shape"], "seed": arguments["seed"], "triangles": triangles(low),
            "bakeEdge": BAKE_EDGE, "collisionProxy": hull}
