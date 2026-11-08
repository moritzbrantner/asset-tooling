"""River stones for Greyhaven's brook (docs/river-stones.md): water-worn boulders, stepping stones, cobble beds, bank stones
and gravel bars, at the width of a 2 m brook.

Every stone is rounded, with no fracture planes: low, smooth lumps on an icosphere. The bake and atlas are those of
``cliff_outcrop.py`` (the declared input ``outcrop``), and two small steps come from ``limestone_rocks.py`` (the declared
input ``limestone``). Each stone's ``Mask`` varies its tint a little and darkens it towards the waterline, so stones
read as wet below and dry above.

The arguments are ``part``: a piece, or ``atlas`` to pack the pieces' baked maps. ``numpy``'s legacy ``RandomState`` is
seeded per piece. Blender coordinates are Z up; the GLB is exported +Y up, with its origin on the ground at the
footprint centre. ``y = 0`` is the stream bed for the bed pieces and the ground for the rest.
"""
import math
import runpy

import bmesh
import bpy
import numpy as np

RECIPE = "river-stones-v1"
# Single stones: seed, half extents (x, y, z), how far the centre stands above the ground as a share of z, moss, how much
# of the height is flattened off for walking (0 for none), LOD0 triangles and baked edge.
SINGLES = {
    "boulder-1": dict(seed=5501, size=(0.86, 0.68, 0.58), rise=0.45, moss=0.5, flat=0.0, triangles=900, edge=256),
    "boulder-2": dict(seed=5502, size=(0.62, 0.52, 0.42), rise=0.45, moss=0.35, flat=0.0, triangles=700, edge=256),
    "boulder-3": dict(seed=5503, size=(0.5, 0.42, 0.34), rise=0.5, moss=0.2, flat=0.0, triangles=500, edge=256),
    "step-1": dict(seed=5504, size=(0.42, 0.36, 0.3), rise=0.4, moss=0.0, flat=0.45, triangles=420, edge=256),
    "step-2": dict(seed=5505, size=(0.36, 0.32, 0.28), rise=0.4, moss=0.0, flat=0.45, triangles=380, edge=256),
}
# Clusters: seed, radii (x, y), stone count, smallest and largest stone radius, flattening, LOD0 triangles, baked edge.
CLUSTERS = {
    "bed-1": dict(seed=5511, radii=(1.3, 0.85), stones=42, sizes=(0.05, 0.19), squash=0.6, triangles=1000, edge=256),
    "bed-2": dict(seed=5512, radii=(0.9, 0.7), stones=26, sizes=(0.05, 0.17), squash=0.6, triangles=650, edge=256),
    "bank-1": dict(seed=5513, radii=(2.0, 0.45), stones=22, sizes=(0.1, 0.34), squash=0.65, triangles=1400, edge=512),
    "bank-2": dict(seed=5514, radii=(1.3, 0.4), stones=14, sizes=(0.1, 0.3), squash=0.65, triangles=900, edge=256),
    "bar-1": dict(seed=5515, radii=(1.8, 0.7), stones=80, sizes=(0.04, 0.13), squash=0.55, triangles=1500, edge=256),
    "bar-2": dict(seed=5516, radii=(1.0, 0.5), stones=44, sizes=(0.04, 0.12), squash=0.55, triangles=850, edge=256),
}
CELLS = {**SINGLES, **CLUSTERS}
ATLAS = "atlas"
ATLAS_EDGE = 1024
# Top-left pixels of each piece's baked maps in the atlas.
ATLAS_RECTS = {
    "bank-1": (0, 0), "boulder-1": (512, 0), "boulder-2": (768, 0), "boulder-3": (512, 256), "bed-1": (768, 256),
    "bed-2": (0, 512), "bank-2": (256, 512), "bar-1": (512, 512), "bar-2": (768, 512), "step-1": (0, 768), "step-2": (256, 768),
}
SINGLE_SUBDIVISIONS, CLUSTER_SUBDIVISIONS = 5, 3
LUMP = 0.11  # how far a stone's outline wanders from an ellipsoid, as a share of its radius
WATERLINE = 0.18  # metres above y = 0 below which a stone darkens
WET = 0.55  # how dark a stone gets at the waterline's foot
BURY = 0.55  # the share of a cluster stone's height below y = 0
INPUTS = {"outcrop", "limestone", "rockColour", "rockHeight", "grassColour", "gravelColour", "mossColour"}
ATLAS_INPUTS = {"outcrop", "limestone"} | {f"{kind}{i}" for kind in ("colour", "normal", "rough") for i in range(len(CELLS))}


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "part"} or arguments["schemaVersion"] != 1:
        raise ValueError("river stones arguments must be {schemaVersion: 1, part}")
    if arguments["part"] != ATLAS and arguments["part"] not in CELLS:
        raise ValueError(f"river stones part must be one of {', '.join(CELLS)} or {ATLAS}")
    expected = ATLAS_INPUTS if arguments["part"] == ATLAS else INPUTS
    if set(inputs) != expected:
        raise ValueError(f"river stones take exactly the inputs {', '.join(sorted(expected))}")


def unit_sphere(subdivisions):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=1.0)
    points = np.array([v.co[:] for v in bm.verts])
    faces = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    return points, faces


def lumped(dirs, size, table, offset, flat, o):
    """A stone on unit directions ``dirs``: a smooth lumpy ellipsoid, its top cut flat when ``flat`` is set."""
    n = o["vnoise"](dirs * 1.3 + offset, 1.0, table) - 0.5
    fine = o["vnoise"](dirs * 3.1 + offset, 1.0, table) - 0.5
    points = dirs * (1 + LUMP * 2 * n + LUMP * 0.5 * fine)[:, None] * np.asarray(size)
    if flat:
        top = size[2] * (1 - flat)
        points[:, 2] = np.minimum(points[:, 2], top + 0.08 * (points[:, 2] - top))
    return points


def masks(points_z, dirs, tint, dark, moss, offset, table, o):
    """Per vertex: gravel tint, no grass, moss on the top, and wet darkening below the waterline."""
    smoothstep = o["smoothstep"]
    moss_f = moss * smoothstep(0.45, 0.85, dirs[:, 2]) * smoothstep(0.45, 0.62, o["vnoise"](dirs * 2.5 + offset, 1.0, table))
    wet = WET * (1 - smoothstep(-0.05, WATERLINE, points_z))
    return np.stack([np.full(len(dirs), tint), np.zeros(len(dirs)), moss_f, np.clip(wet + dark, 0, 1)], -1)


def stones_mesh(name, stones, collection):
    """One mesh of ``stones``: (points, faces, mask) per stone, with the sculpt's ``Mask`` attribute."""
    points, faces, colours, offset = [], [], [], 0
    for p, f, m in stones:
        points.append(p)
        faces.extend([[i + offset for i in face] for face in f])
        colours.append(m)
        offset += len(p)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(np.concatenate(points).tolist(), [], faces)
    mesh.color_attributes.new("Mask", "FLOAT_COLOR", "POINT").data.foreach_set("color", np.concatenate(colours).ravel())
    mesh.polygons.foreach_set("use_smooth", np.ones(len(mesh.polygons), dtype=bool))
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def single_stone(name, cfg, collection, o):
    rng = np.random.RandomState(cfg["seed"])
    table = o["lattice"](cfg["seed"])
    offset = rng.uniform(-10, 10, 3)
    size = np.array(cfg["size"])
    lift = cfg["rise"] * size[2]
    dirs, faces = unit_sphere(SINGLE_SUBDIVISIONS)
    points = lumped(dirs, size, table, offset, cfg["flat"], o) + np.array([0, 0, lift])
    mask = masks(points[:, 2], dirs, rng.uniform(0.05, 0.3), rng.uniform(0, 0.08), cfg["moss"], offset, table, o)
    obj = stones_mesh(name, [(points, faces, mask)], collection)
    # The collision shape is the same stone on a coarse sphere, in glTF axes (+Y up), wound outward.
    coarse, coarse_faces = unit_sphere(2)
    hull = lumped(coarse, size, table, offset, cfg["flat"], o) + np.array([0, 0, lift])
    collision = {"shape": "triangle-mesh", "vertices": [[round(float(x), 3), round(float(z), 3), round(float(-y), 3)] for x, y, z in hull], "triangles": coarse_faces}
    return obj, collision, float(-points[:, 2].min())


def cluster(name, cfg, collection, o):
    rng = np.random.RandomState(cfg["seed"])
    table = o["lattice"](cfg["seed"])
    rx, ry = cfg["radii"]
    dirs, faces = unit_sphere(CLUSTER_SUBDIVISIONS)
    stones, low = [], 0.0
    for _ in range(cfg["stones"]):
        a, d = rng.uniform(0, math.tau), math.sqrt(rng.uniform(0, 1))
        s = rng.uniform(*cfg["sizes"]) * (1 - 0.35 * d)
        size = np.array([s * rng.uniform(1.0, 1.4), s, s * cfg["squash"]])
        offset = rng.uniform(-10, 10, 3)
        spin = rng.uniform(0, math.tau)
        points = lumped(dirs, size, table, offset, 0.0, o)
        points[:, :2] = np.c_[points[:, 0] * math.cos(spin) - points[:, 1] * math.sin(spin), points[:, 0] * math.sin(spin) + points[:, 1] * math.cos(spin)]
        points += np.array([rx * d * math.cos(a), ry * d * math.sin(a), size[2] * (1 - 2 * BURY)])
        low = min(low, float(points[:, 2].min()))
        stones.append((points, faces, masks(points[:, 2], dirs, rng.uniform(0.0, 0.45), rng.uniform(0, 0.2), 0.0, offset, table, o)))
    return stones_mesh(name, stones, collection), -low


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    o = runpy.run_path(inputs["outcrop"])
    part = arguments["part"]
    if part == ATLAS:
        # generate_atlas packs the table it finds in its own module, so it is pointed at this kit's.
        o["generate_atlas"].__globals__.update(OUTCROPS=CELLS, ATLAS_EDGE=ATLAS_EDGE, ATLAS_RECTS=ATLAS_RECTS)
        return {**o["generate_atlas"](output_path, inputs), "recipe": RECIPE}
    limestone = runpy.run_path(inputs["limestone"])
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    cfg = CELLS[part]
    collection = bpy.context.scene.collection
    name = f"river_{part}"
    collision = None
    if part in SINGLES:
        sculpted, collision, bury = single_stone(f"{name}_sculpt", cfg, collection, o)
        fit = {"size": list(cfg["size"]), "flat": cfg["flat"]}
    else:
        sculpted, bury = cluster(f"{name}_sculpt", cfg, collection, o)
        fit = {"radii": list(cfg["radii"])}
    sculpted.data.materials.append(o["sculpt_material"](f"{name}_sculpt", inputs))
    low = o["game_mesh"](sculpted, cfg["triangles"], collection)
    splinters = limestone["drop_splinters"](low)
    limestone["inset_uvs"](low)
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
