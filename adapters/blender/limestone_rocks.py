"""Limestone rocks for Greyhaven (docs/limestone-rocks.md): low, level-bedded outcrops, square-edged blocks and scree.

The sculpt, bake and atlas machinery is ``cliff_outcrop.py`` (the declared input ``outcrop``), whose noise, strata,
rubble, terrain-matched material, decimation, Cycles bake and map packing this recipe reuses unchanged. Limestone
differs in what the tables below set:

* the rock is low and blocky: it barely tapers, its top is flat, and the foot and apron scale with its height, so a
  1 m block is still a block and not a pancake;
* scree is a separate kind of piece, a patch of loose angular stones with nothing between them, so it lies on any
  terrain with no edge to hide.

The arguments are ``part``: a piece, or ``atlas`` to pack the pieces' baked maps. ``numpy``'s legacy ``RandomState`` is
seeded per piece. Blender coordinates are Z up; the GLB is exported +Y up, with its origin on the ground at the
footprint centre.
"""
import math
import runpy

import bmesh
import bpy
import numpy as np

RECIPE = "limestone-rocks-v1"
# Per piece: seed, radii (x, y), height, lean (x, y metres at the top), how far it tapers, LOD0 triangles, baked edge.
ROCKS = {
    "outcrop-1": dict(seed=5401, radii=(4.6, 2.9), height=4.4, lean=(0.3, -0.1), taper=0.2, triangles=6000, edge=1024),
    "outcrop-2": dict(seed=5402, radii=(3.6, 2.3), height=3.2, lean=(-0.2, 0.15), taper=0.24, triangles=5000, edge=1024),
    "ledge": dict(seed=5403, radii=(4.4, 2.0), height=1.8, lean=(0.0, 0.1), taper=0.16, triangles=3500, edge=512, cell=0.06),
    "block-1": dict(seed=5404, radii=(1.9, 1.5), height=2.2, lean=(0.1, 0.0), taper=0.14, triangles=2200, edge=512),
    "block-2": dict(seed=5405, radii=(1.4, 1.1), height=1.4, lean=(-0.08, 0.05), taper=0.14, triangles=1500, edge=512),
    "block-3": dict(seed=5406, radii=(0.95, 0.8), height=0.9, lean=(0.0, 0.0), taper=0.12, triangles=900, edge=512),
}
# Per patch: seed, radii (x, y), stone count, largest stone radius in metres, LOD0 triangles, baked edge.
SCREE = {
    "scree-1": dict(seed=5411, radii=(3.6, 2.3), stones=70, largest=0.34, triangles=1800, edge=512),
    "scree-2": dict(seed=5412, radii=(2.2, 1.6), stones=42, largest=0.26, triangles=1100, edge=512),
}
CELLS = {**ROCKS, **SCREE}
ATLAS = "atlas"
ATLAS_EDGE = 2048
# Top-left pixels of each piece's baked maps in the atlas.
ATLAS_RECTS = {
    "outcrop-1": (0, 0), "outcrop-2": (1024, 0), "ledge": (0, 1024), "block-1": (512, 1024),
    "block-2": (1024, 1024), "block-3": (1536, 1024), "scree-1": (0, 1536), "scree-2": (512, 1536),
}
UV_INSET = 0.02  # the share of a cell kept empty on each side, so mip levels don't bleed in from its neighbours
CELL_SIZE = 0.03  # sculpt grid spacing in metres unless a piece sets its own ``cell``: a long thin rock needs a coarser
                  # grid, or decimating it collapses the body
LOBES = (0.13, 0.09)  # how far the plan's second and third harmonics push it off an ellipse, so a rock is no drum
TOP_SLOPE = 0.14  # how far the top falls away on one side, as a share of the height
BARE_TOP = (0.4, 0.62)  # the broad noise range over which a flat top turns from bare rock to grass
SPLINTER_FACES = 8  # a separate island of fewer faces is a stone the decimation destroyed
SKIRT, CROWN = 0.09, 0.84  # where along v the buried foot ends and the flat top begins
BURY = 0.4  # how far below the ground the foot reaches, metres
RISE = 0.18  # the foot's height as a share of the rock's, up to 0.5 m
APRON = 0.35  # how far the foot spreads, as a share of the radius
SCREE_BURY = 0.3  # how much of a stone is below the ground, as a share of its radius
INPUTS = {"outcrop", "rockColour", "rockHeight", "grassColour", "gravelColour", "mossColour"}
ATLAS_INPUTS = {"outcrop"} | {f"{kind}{i}" for kind in ("colour", "normal", "rough") for i in range(len(CELLS))}


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "part"} or arguments["schemaVersion"] != 1:
        raise ValueError("limestone rocks arguments must be {schemaVersion: 1, part}")
    if arguments["part"] != ATLAS and arguments["part"] not in CELLS:
        raise ValueError(f"limestone rocks part must be one of {', '.join(CELLS)} or {ATLAS}")
    expected = ATLAS_INPUTS if arguments["part"] == ATLAS else INPUTS
    if set(inputs) != expected:
        raise ValueError(f"limestone rocks take exactly the inputs {', '.join(sorted(expected))}")


def bedded_arrays(cfg, o):
    """The sculpt's grid and blend masks: ``sculpt_arrays`` of cliff_outcrop.py, proportioned for low blocky rock."""
    smoothstep, vnoise, grid_normals, blur = o["smoothstep"], o["vnoise"], o["grid_normals"], o["blur"]
    rng = np.random.RandomState(cfg["seed"])
    noise = [o["lattice"](cfg["seed"] + i) for i in range(6)]
    height = cfg["height"]
    cell = cfg.get("cell", CELL_SIZE)
    cols = int(np.clip(math.tau * max(cfg["radii"]) * 1.4 / cell, 300, 1200))
    rows = int(np.clip((height + BURY + 2 * max(cfg["radii"])) / (cell * 0.75), 300, 1200))
    theta = np.linspace(0, math.tau, cols, endpoint=False)[None, :].repeat(rows, 0)
    v = np.linspace(0, 1, rows)[:, None].repeat(cols, 1)
    face = np.clip((v - SKIRT) / (CROWN - SKIRT), 0, 1)
    top, rise = height * 0.94, min(0.5, RISE * height)
    y = np.where(v < SKIRT, -BURY + (BURY + rise) * smoothstep(0, SKIRT, v), rise + (top - rise) * face)
    taper = 1.0 + 0.03 * np.sin(face * 2.3) - cfg["taper"] * face ** 1.6
    phases = rng.uniform(0, math.tau, 3)
    lobes = 1 + LOBES[0] * np.sin(2 * theta + phases[0]) + LOBES[1] * np.sin(3 * theta + phases[1])
    r = o["radius_field"](theta, y, cfg, rng, noise) * taper * lobes
    y = y - TOP_SLOPE * height * (0.5 + 0.5 * np.sin(theta + phases[2])) * face ** 3
    r = o["blur_rows"](r, 2)
    r = np.minimum(r, o["window_rows"](r, int(2.4 / (height / rows))) * 1.08)
    calm = smoothstep(SKIRT * 0.45, SKIRT * 1.5, v)
    r = blur(r, 60) * (1 - calm) + r * calm
    r *= 1.0 + APRON * (1 - smoothstep(0.0, SKIRT * 1.25, v)) ** 1.6
    crown = np.clip((v - CROWN) / (1 - CROWN), 0, 1)
    r *= np.sqrt(np.maximum(1 - crown ** 4.0, 0))  # the higher the power, the flatter the top
    y = y + (height - top) * np.sin(crown * math.pi / 2)
    lean = np.maximum(y / height, 0) ** 1.25
    p = np.stack([r * np.cos(theta) + cfg["lean"][0] * lean, r * np.sin(theta) + cfg["lean"][1] * lean, y], -1)
    n = grid_normals(p)
    flat = p.reshape(-1, 3)
    ridge = lambda f, t: (1 - np.abs(2 * vnoise(flat, f, noise[t]) - 1)).reshape(rows, cols)
    scale = min(1.0, height / 8.0)
    relief = 0.2 * scale * ridge(0.55, 2) + 0.09 * ridge(1.7, 3) + 0.04 * ridge(4.6, 4) + 0.015 * ridge(13.0, 5)
    keep = smoothstep(0.0, SKIRT, v)
    p = p + n * ((relief - 0.17 * scale - 0.07) * keep)[..., None]
    n = grid_normals(p)
    centre = np.stack([cfg["lean"][0] * np.maximum(p[..., 2] / height, 0) ** 1.25, cfg["lean"][1] * np.maximum(p[..., 2] / height, 0) ** 1.25], -1)
    radial = np.linalg.norm(p[..., :2] - centre, axis=-1)
    k = max(0.25, min(1.0, height / 5.0))  # the blends at the foot shrink with the rock
    cavity = np.clip((blur(radial, 14) - radial) * 5.0, 0, 1) * smoothstep(0.3 * k, 1.8 * k, p[..., 2])
    edge = vnoise(flat, 0.7, noise[1]).reshape(rows, cols) * 0.6 + vnoise(flat, 3.1, noise[2]).reshape(rows, cols) * 0.4
    up = n[..., 2]
    foot = 1 - smoothstep(0.5 * k, 2.6 * k, p[..., 2] + (edge - 0.5) * 2.6 * k)
    grass_foot = 1 - smoothstep(0.15 * k, 1.5 * k, p[..., 2] + (edge - 0.5) * 2.2 * k)
    broad = vnoise(flat, 0.28, noise[3]).reshape(rows, cols)
    ledge = smoothstep(0.55, 0.85, up)
    moss = np.clip(smoothstep(0.15, 0.6, up) * smoothstep(0.4, 0.6, edge) + ledge * 0.5, 0, 1) * 0.9
    crown_grass = smoothstep(CROWN - 0.02, CROWN + 0.05, v + (edge - 0.5) * 0.07) * smoothstep(0.25, 0.45, up + edge * 0.3) * smoothstep(*BARE_TOP, broad)
    grass = np.maximum.reduce([grass_foot, crown_grass, ledge * smoothstep(0.56, 0.68, broad)])
    gravel = np.clip(foot, 0, 1) * (1 - grass)
    return p, np.stack([gravel, grass, moss, cavity], -1), rise


def scree_mesh(name, cfg, collection):
    """Loose angular stones, largest in the middle, with the sculpt's ``Mask`` attribute: rock with a little grit and moss."""
    rng = np.random.RandomState(cfg["seed"])
    rx, ry = cfg["radii"]
    bm = bmesh.new()
    for _ in range(cfg["stones"]):
        a, d = rng.uniform(0, math.tau), math.sqrt(rng.uniform(0, 1))
        size = cfg["largest"] * (1 - 0.72 * d) * rng.uniform(0.55, 1.0)
        centre = (rx * d * math.cos(a), ry * d * math.sin(a), size * (0.4 - SCREE_BURY))
        made = bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
        directions = rng.normal(size=(9, 3))
        directions /= np.linalg.norm(directions, axis=1, keepdims=True)
        offsets = rng.uniform(0.62, 1.0, 9)
        stretch = rng.uniform(0.85, 1.4, 3) * np.array([1.0, 1.0, 0.62])
        for vert in made["verts"]:
            point = np.array(vert.co)
            shaped = point * np.min(np.where(directions @ point > 0.05, offsets / (directions @ point), 1.6)) * stretch * size
            vert.co = (shaped[0] + centre[0], shaped[1] + centre[1], shaped[2] + centre[2])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    count = len(mesh.vertices)
    grit, moss = rng.uniform(0.05, 0.3, count), rng.uniform(0, 0.18, count)
    data = np.stack([grit, np.zeros(count), moss, np.full(count, 0.15)], -1)
    mesh.color_attributes.new("Mask", "FLOAT_COLOR", "POINT").data.foreach_set("color", data.ravel())
    mesh.polygons.foreach_set("use_smooth", np.zeros(len(mesh.polygons), dtype=bool))
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def drop_splinters(obj):
    """Delete the separate islands a decimation reduced to a few faces: they bake black and float as shards."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    seen, doomed = set(), []
    for start in bm.faces:
        if start.index in seen:
            continue
        island, stack = [], [start]
        seen.add(start.index)
        while stack:
            face = stack.pop()
            island.append(face)
            for edge in face.edges:
                for other in edge.link_faces:
                    if other.index not in seen:
                        seen.add(other.index)
                        stack.append(other)
        if len(island) < SPLINTER_FACES:
            doomed.extend(island)
    bmesh.ops.delete(bm, geom=doomed, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return len(doomed)


def inset_uvs(obj):
    """Pull every UV in from the cell's border, leaving a gutter the bake's margin fills."""
    layer = obj.data.uv_layers.active.data
    uv = np.empty(len(layer) * 2)
    layer.foreach_get("uv", uv)
    layer.foreach_set("uv", UV_INSET + uv * (1 - 2 * UV_INSET))


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    o = runpy.run_path(inputs["outcrop"])
    part = arguments["part"]
    if part == ATLAS:
        # generate_atlas packs the table it finds in its own module, so it is pointed at this kit's.
        o["generate_atlas"].__globals__.update(OUTCROPS=CELLS, ATLAS_EDGE=ATLAS_EDGE, ATLAS_RECTS=ATLAS_RECTS)
        return {**o["generate_atlas"](output_path, inputs), "recipe": RECIPE}
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    cfg = CELLS[part]
    collection = bpy.context.scene.collection
    name = f"limestone_{part}"
    collision, fit, bury = None, {"radii": list(cfg["radii"])}, SCREE_BURY * cfg.get("largest", 0)
    if part in ROCKS:
        p, masks, rise = bedded_arrays(cfg, o)
        # collision_mesh reads these two from its own module; a low rock's foot starts lower than a tall one's.
        o["collision_mesh"].__globals__.update(BURY=BURY, COLLISION_FOOT=max(0.2, rise * 1.5))
        collision = o["collision_mesh"](p, cfg)
        sculpted = o["grid_mesh"](f"{name}_sculpt", p, masks, collection, cfg, np.random.RandomState(cfg["seed"] + 99))
        fit, bury = {"radii": list(cfg["radii"]), "height": cfg["height"], "lean": [cfg["lean"][0], -cfg["lean"][1]]}, BURY
    else:
        sculpted = scree_mesh(f"{name}_sculpt", cfg, collection)
    sculpted.data.materials.append(o["sculpt_material"](f"{name}_sculpt", inputs))
    low = o["game_mesh"](sculpted, cfg["triangles"], collection)
    splinters = drop_splinters(low)
    inset_uvs(low)
    o["bake"](sculpted, low, name, cfg["edge"])
    bpy.data.objects.remove(sculpted)
    low.name = low.data.name = name
    for attribute in list(low.data.color_attributes):
        low.data.color_attributes.remove(attribute)
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO",
        export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "part": part, "triangles": o["triangles"](low), "bakeEdge": cfg["edge"], "bury": bury, "collisionMesh": collision, "fit": fit, "splinterFaces": splinters}
