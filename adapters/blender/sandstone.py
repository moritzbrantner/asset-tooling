"""The red sandstone building kit for mmorpg (docs/sandstone-kit.md): buff-trimmed masonry walls on a 2 m grid,
round-arched doors and windows, stepped gables above a slate roof, on 6 m and 8 m spans. An original kit with no
third-party assets, deliberately unlike the plaster and timber Greyhaven Outpost (docs/outpost-kit.md).

- **Geometry** is hand-authored in ``assets/authored/sandstone-kit.blend`` (the declared input ``kit``): one
  collection ``sandstone.<part>`` per module with one root empty, whose JSON custom property ``sandstone`` holds the
  descriptor's observations, and placeholder materials ``sandstone-<material>``.
- **Textures** live here: tileable ashlar, plinth, dressed-stone, slate and wood maps (colour, normal, ORM). Their
  helpers come from the Outpost recipe (the declared input ``outpost``).

Every module is in glTF axes: metres, +Y up, the outside towards +Z, its origin at the base centre of the outer face
(the hinge for ``door``, the outer corner for ``corner``, the ground under the ridge for roof modules). In a live
Blender session, bind the sources with ``use_sources(runpy.run_path("adapters/blender/outpost.py"),
runpy.run_path("adapters/blender/kit_common.py"))`` and ``use_geometry("assets/authored/sandstone-kit.blend")``, then
call ``build`` or ``build_composition``. ``generate`` is the script-backend entry point.
"""
import json
import math
import re

import bpy
import numpy as np

PARTS = ("wall", "wall-half", "wall-window", "wall-door", "door", "corner", "gable-6", "gable-8", "roof-6", "roof-6-half",
         "roof-8", "roof-8-half", "chimney")
MODULE = 2.0
HEIGHT = 4.0
SPANS = (6.0, 8.0)
ROOF_LIFT = 0.1          # the roof's top surface above the wall top, at the outer wall face
PITCH = math.tan(math.radians(42.0))
GABLE_ABOVE_ROOF = 0.39  # the gable's apex coping above the roof surface at the ridge
CHIMNEY_SEAT = 0.5       # how far a chimney sinks into the gable's apex
MOUNT = (-0.68, 0.02, -0.24)
# Atlas resolutions to choose from. ``edge`` is the atlas size in pixels; ``gutter`` is how far (pixels) each cell's tile
# continues past its edge, so mip levels do not pick up its neighbours. Density follows from the edge.
ATLAS_MODES = {
    "2048": {"edge": 2048, "gutter": 8},
    "1024": {"edge": 1024, "gutter": 4},
}
DEFAULT_ATLAS = "2048"
LAYOUT_EDGE = 2048       # CELLS and SWATCHES are laid out for this atlas edge, at 320 pixels per metre
ATLAS, TEXTURE, GUTTER, SCALE, MODE = 2048, 320, 8, 1.0, DEFAULT_ATLAS   # set by use_atlas
# The whole kit is one material: one atlas holds every surface, so a kit piece adds no draw call of its own.
# Tiled surfaces: name -> atlas x, y of the cell's top left (pixels at LAYOUT_EDGE), its width and height (metres).
CELLS = {
    "ashlar": (16, 16, 2, 4), "plinth": (16, 1312, 2, 1), "slate": (672, 16, 2, 2), "dressed": (672, 672, 2, 2), "wood": (672, 1328, 3, 2),
}
# Flat surfaces: name -> atlas x, y of a small swatch, sRGB colour, metallic, roughness.
SWATCHES = {
    "iron": (1344, 16, (0.2, 0.2, 0.21), 1.0, 0.5),
    "glass": (1392, 16, (0.09, 0.11, 0.14), 0.0, 0.2),
    "soot": (1440, 16, (0.03, 0.03, 0.03), 0.0, 0.95),
}
SWATCH = 32              # swatch edge, pixels
WOOD_TINT = (0.72, 0.6, 0.52)
# Each surface's repeat in metres (u, v) and how far u is shifted so a 2 m module (x -1..1) starts a repeat. A module
# seam then falls on a whole repeat, and 1 m pieces only meet their neighbour at a joint or a change of stone.
PERIODS = {"ashlar": (2, 4, 1.0), "plinth": (2, 1, 1.0), "slate": (2, 2, 1.0), "dressed": (1, 1, 0.0), "wood": (1, 1, 0.0)}
# The look of the walls and roof: change these to adjust them.
ASHLAR = {
    "seed": 41, "courses": 13, "courseHeight": (0.26, 0.36),  # metres; level courses of slightly different heights
    "blockRatio": (1.7, 3.0),                                 # block length as a multiple of its course height
    "stagger": (0.3, 0.55),                                   # metres each course's joints move along from the last
    "tone": (0.5, 0.31, 0.26), "mortar": (0.43, 0.36, 0.31), "jointWidth": 0.012,
    "blockShade": 0.12,                                       # brightness difference between blocks
}
PLINTH = {"seed": 47, "tone": (0.33, 0.21, 0.18), "mortar": (0.24, 0.18, 0.15), "jointWidth": 0.016, "blockShade": 0.1}
DRESSED = {"seed": 43, "tone": (0.66, 0.57, 0.44)}
SLATE = {
    "seed": 901, "courses": 16, "courseHeight": (0.115, 0.135), "width": (0.2, 0.32), "tone": (0.22, 0.24, 0.29),
    "blockShade": 0.16, "lowerEdge": 0.25,                    # how uneven each slate's lower edge is, as a share of its course
}

K = {}                   # the Outpost recipe's namespace (texture helpers)
GEOMETRY = {"path": None}
PLACEHOLDER = re.compile(r"^sandstone-([a-z]+)")


def use_sources(outpost, common):
    """Bind the Outpost recipe's texture helpers and kit_common.py's shared helpers."""
    outpost["use_common"](common)
    K.clear()
    K.update(outpost)
    globals().update({name: common[name] for name in common["NAMES"]})


def use_atlas(mode):
    """Select one of ``ATLAS_MODES`` for the materials built from here on."""
    global ATLAS, TEXTURE, GUTTER, SCALE, MODE
    if mode not in ATLAS_MODES:
        raise ValueError(f"sandstone atlas must be one of {', '.join(ATLAS_MODES)}")
    MODE, ATLAS, GUTTER = mode, ATLAS_MODES[mode]["edge"], ATLAS_MODES[mode]["gutter"]
    SCALE = ATLAS / LAYOUT_EDGE
    TEXTURE = int(320 * SCALE)


def use_geometry(path):
    """Bind the kit's authored geometry, ``assets/authored/sandstone-kit.blend`` (the declared input ``kit``)."""
    GEOMETRY["path"] = str(path)


# ---------------------------------------------------------------- textures (numpy, tileable)

def smooth(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def field(cols, rows, base, octaves, seed, stretch=(1, 1)):
    """Tileable noise over a ``rows`` x ``cols`` image whose sides are multiples of the shorter one."""
    side = min(cols, rows)
    return np.tile(fbm(side, base, octaves, seed, stretch=stretch), (rows // side, cols // side))


def courses(width, height, heights, lengths, offsets, rng):
    """Level courses of bonded units over a ``width`` x ``height`` m image (top-down rows), wrapping along its width.

    Per pixel: metres to the nearest joint of any kind, metres to the nearest vertical joint, the unit's random value,
    and the height up its course in [0, 1]."""
    cols, rows = int(width * TEXTURE), int(height * TEXTURE)
    y = (rows - 1 - np.arange(rows) + 0.5) / TEXTURE
    x = (np.arange(cols) + 0.5) / TEXTURE
    bounds = np.concatenate([[0.0], np.cumsum(heights)])
    course = np.clip(np.searchsorted(bounds, y, side="right") - 1, 0, len(heights) - 1)
    edge, side, value, up = (np.ones((rows, cols)) for _ in range(4))
    for c, (units, offset) in enumerate(zip(lengths, offsets)):
        cuts = np.sort((offset + np.cumsum([0.0] + list(units[:-1]))) % width)
        values = rng.rand(len(cuts))
        d = np.abs(x[:, None] - cuts[None, :])
        across = np.min(np.minimum(d, width - d), axis=1)
        unit = (np.searchsorted(cuts, x, side="right") - 1) % len(cuts)
        mask = course == c
        below, above = y[mask] - bounds[c], bounds[c + 1] - y[mask]
        edge[mask] = np.minimum(across[None, :], np.minimum(below, above)[:, None])
        side[mask] = across
        value[mask] = values[unit]
        up[mask] = (below / (bounds[c + 1] - bounds[c]))[:, None]
    return edge, side, value, up


def fill(total, pick):
    """Unit lengths from ``pick()`` that add up to exactly ``total``."""
    units = []
    while sum(units) < total - 0.15:
        units.append(pick())
    return [unit * total / sum(units) for unit in units]


def stone_colour(edge, value, cols, rows, cfg):
    """Quiet stone: a little difference between blocks, bedding lines along each block and a broad weathering wash."""
    grain = field(cols, rows, 24, 3, cfg["seed"] + 10)
    bedding = field(cols, rows, 6, 3, cfg["seed"] + 11, stretch=(1, 14))
    wash = field(cols, rows, 3, 3, cfg["seed"] + 12)
    v = value[..., None]
    stone = np.array(cfg["tone"]) * (1 + (v - 0.5) * cfg["blockShade"]) * (0.95 + bedding[..., None] * 0.1) * (0.94 + wash[..., None] * 0.12)
    stone = stone * (0.94 + grain[..., None] * 0.12)
    joint = np.clip(edge / cfg["jointWidth"], 0, 1)[..., None]
    return np.array(cfg["mortar"]) * (1 - joint) + stone * joint, grain


def ashlar_maps():
    """Coursed sandstone 2 x 4 m: level courses, joints broken course to course, no repeat within a wall's height."""
    cfg = ASHLAR
    rng = np.random.RandomState(cfg["seed"])
    heights = rng.uniform(*cfg["courseHeight"], cfg["courses"])
    heights = heights * 4.0 / heights.sum()
    lengths = [fill(2.0, lambda: h * rng.uniform(*cfg["blockRatio"])) for h in heights]
    offsets = np.cumsum(rng.uniform(*cfg["stagger"], cfg["courses"]))
    edge, _, value, _ = courses(2, 4, heights, lengths, offsets, rng)
    colour, grain = stone_colour(edge, value, 2 * TEXTURE, 4 * TEXTURE, cfg)
    joint = np.clip(edge / cfg["jointWidth"], 0, 1)
    pillow = np.clip(edge / 0.05, 0, 1) ** 0.5
    return K["finish_maps"](colour, joint * (0.6 + 0.4 * pillow) + grain * 0.1, 3.2 * SCALE, 0.65 + 0.35 * pillow, 0.88 + (1 - joint) * 0.08)


def plinth_maps():
    """One course of long, heavy footing blocks 0.55 m high, a joint on every metre so modules meet at a joint."""
    cfg = PLINTH
    rng = np.random.RandomState(cfg["seed"])
    edge, _, value, _ = courses(2, 1, [0.55, 0.45], [[1.0, 1.0], [1.0, 1.0]], [0.0, 0.0], rng)
    colour, grain = stone_colour(edge, value, 2 * TEXTURE, TEXTURE, cfg)
    joint = np.clip(edge / cfg["jointWidth"], 0, 1)
    pillow = np.clip(edge / 0.07, 0, 1) ** 0.5
    return K["finish_maps"](colour, joint * (0.6 + 0.4 * pillow) + grain * 0.1, 3.2 * SCALE, 0.6 + 0.4 * pillow, 0.9 + (1 - joint) * 0.06)


def dressed_maps():
    """Tooled buff stone with no drawn joints: the quoins, arches and copings are separate stones in the geometry."""
    cfg = DRESSED
    grain = fbm(TEXTURE, 30, 3, cfg["seed"])
    tooling = fbm(TEXTURE, 8, 2, cfg["seed"] + 1, stretch=(14, 1))
    wash = fbm(TEXTURE, 3, 3, cfg["seed"] + 2)
    colour = np.array(cfg["tone"]) * (0.9 + grain[..., None] * 0.12 + tooling[..., None] * 0.05 + wash[..., None] * 0.08)
    return K["finish_maps"](colour, grain * 0.5 + tooling * 0.5, 1.2 * SCALE, 0.95 + 0 * grain, 0.86 + 0 * grain)


def slate_maps():
    """Roofing slate 2 x 2 m: straight courses, each slate broken over the joint below, the top of each course shaded
    by the slates lapping it. Only the course's lower edge is a strong line; the side joints stay faint."""
    cfg = SLATE
    rng = np.random.RandomState(cfg["seed"])
    heights = rng.uniform(*cfg["courseHeight"], cfg["courses"])
    heights = heights * 2.0 / heights.sum()
    lengths = [fill(2.0, lambda: rng.uniform(*cfg["width"])) for _ in heights]
    offsets = np.arange(cfg["courses"]) * 0.13 + rng.uniform(0, 0.04, cfg["courses"])
    _, side, value, up = courses(2, 2, heights, lengths, offsets, rng)
    cols, rows = 2 * TEXTURE, 2 * TEXTURE
    # Each slate's lower edge sits a little higher or lower than its neighbours'.
    lift = (value * 37.0 % 1.0 - 0.5) * cfg["lowerEdge"]
    along = np.clip(up - lift, 0, 1)
    grain = field(cols, rows, 28, 3, cfg["seed"] + 10)
    wash = field(cols, rows, 3, 3, cfg["seed"] + 12)
    v = value[..., None]
    rust = (v > 0.97) * np.array([1.05, 1.0, 0.93]) + (v <= 0.97) * np.array([1.0, 1.0, 1.0])  # a rare warmer slate
    colour = np.array(cfg["tone"]) * rust * (1 +(v - 0.5) * cfg["blockShade"]) * (0.93 + grain[..., None] * 0.14) * (0.95 + wash[..., None] * 0.1)
    # The lap above shades the top of each slate; a side joint is only a thin, faint line.
    colour = colour * (1 - 0.42 * smooth(0.8, 1.0, along)[..., None]) * (0.86 + 0.14 * np.clip(side / 0.006, 0, 1)[..., None])
    height = (1 - along) * 0.75 + grain * 0.12 + np.clip(side / 0.012, 0, 1) * 0.08
    return K["finish_maps"](colour, height, 2.0 * SCALE, 1 - 0.4 * smooth(0.8, 1.0, along), 0.74 + grain * 0.1)


def texture_maps(name):
    """A surface's colour, normal and ORM over one repeat (``PERIODS``), in top-down rows."""
    if name == "wood":
        colour, normal, orm = K["wood_maps"](TEXTURE)
        return colour * np.array(WOOD_TINT), normal, orm
    return {"ashlar": ashlar_maps, "plinth": plinth_maps, "dressed": dressed_maps, "slate": slate_maps}[name]()


def atlas_maps():
    """The kit's atlas: colour, tangent-space normal and ORM, top-down rows as ``make_image`` takes them."""
    colour = np.full((ATLAS, ATLAS, 3), 0.2)
    normal = np.full((ATLAS, ATLAS, 3), 0.5)
    normal[..., 2] = 1.0
    orm = np.ones((ATLAS, ATLAS, 3))
    orm[..., 2] = 0.0
    for name, (x, y, width, height) in CELLS.items():
        x, y = int(x * SCALE), int(y * SCALE)
        w, h = width * TEXTURE, height * TEXTURE
        ys, xs = np.arange(y - GUTTER, y + h + GUTTER), np.arange(x - GUTTER, x + w + GUTTER)
        # A cell's bottom row is v = 0 of the repeat, so UVs in metres land on it whatever the cell's height.
        repeat_u, repeat_v, _ = PERIODS[name]
        repeat_rows, repeat_cols = repeat_v * TEXTURE, repeat_u * TEXTURE
        rows = repeat_rows - 1 - ((h - 1 - (ys - y)) % repeat_rows)
        cols = (xs - x) % repeat_cols
        for target, source in zip((colour, normal, orm), texture_maps(name)):
            target[np.ix_(ys, xs)] = source[np.ix_(rows, cols)]
    edge = int(SWATCH * SCALE)
    for x, y, rgb, metallic, roughness in SWATCHES.values():
        x, y = int(x * SCALE), int(y * SCALE)
        colour[y:y + edge, x:x + edge] = rgb
        orm[y:y + edge, x:x + edge] = (1.0, roughness, metallic)
    return np.clip(colour, 0, 1), normal, orm


def material():
    """The kit's one material, over the atlas of the selected mode."""
    name = "sandstone-kit" if MODE == DEFAULT_ATLAS else f"sandstone-kit-{MODE}"
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    mat.use_backface_culling = True
    tex = []
    for kind, data in zip(("color", "normal", "orm"), atlas_maps()):
        node = nodes.new("ShaderNodeTexImage")
        image_name = f"sandstone-atlas-{MODE}-{kind}"
        node.image = bpy.data.images.get(image_name) or make_image(image_name, data, kind == "color")
        tex.append(node)
    links.new(tex[0].outputs["Color"], bsdf.inputs["Base Color"])
    nmap = nodes.new("ShaderNodeNormalMap")
    links.new(tex[1].outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    sep = nodes.new("ShaderNodeSeparateColor")
    links.new(tex[2].outputs["Color"], sep.inputs["Color"])
    links.new(sep.outputs[1], bsdf.inputs["Roughness"])
    links.new(sep.outputs[2], bsdf.inputs["Metallic"])
    return mat


# ---------------------------------------------------------------- authored geometry

def atlas_uvs(obj, names):
    """Move each face's UVs (metres) into the atlas cell or swatch of its surface, ``names`` by slot.

    A face moves by whole repeats, so neighbours stay continuous across it. A thin face that straddles a cell edge slides
    to the cell's start instead. A face larger than its cell fails: a hand edit must split it."""
    mesh = obj.data
    uv = mesh.uv_layers[0].data
    for polygon in mesh.polygons:
        name = names[polygon.material_index]
        loops = list(polygon.loop_indices)
        if name in SWATCHES:
            x, y, *_ = SWATCHES[name]
            centre = ((x + SWATCH / 2) / LAYOUT_EDGE, 1 - (y + SWATCH / 2) / LAYOUT_EDGE)
            for loop in loops:
                uv[loop].uv = centre
            continue
        x, y, width, height = CELLS[name]
        x, y = int(x * SCALE), int(y * SCALE)
        points = np.array([uv[loop].uv for loop in loops], dtype=float)
        repeat_u, repeat_v, phase = PERIODS[name]
        points[:, 0] += phase
        repeat = np.array([repeat_u, repeat_v], dtype=float)
        points -= np.floor(points.min(axis=0) / repeat + 1e-6) * repeat
        limit = np.array([width, height], dtype=float)
        over = points.max(axis=0) > limit + 1e-4
        points[:, over] -= points[:, over].min(axis=0)
        if (points.max(axis=0) > limit + 1e-4).any():
            raise ValueError(f"{obj.name}: a {name} face spans {np.ptp(points, axis=0).round(2).tolist()} m, more than its {width} x {height} m atlas cell")
        bottom = 1 - (y + height * TEXTURE) / ATLAS
        for loop, point in zip(loops, points):
            uv[loop].uv = (x / ATLAS + point[0] * TEXTURE / ATLAS, bottom + point[1] * TEXTURE / ATLAS)


def load_module(part, collection):
    """Append module ``part`` from the authored geometry into ``collection``, dressed; its root and observations."""
    if GEOMETRY["path"] is None:
        raise RuntimeError("bind the authored geometry with use_geometry(path) first")
    name = f"sandstone.{part}"
    with bpy.data.libraries.load(GEOMETRY["path"], link=False) as (source, target):
        if name not in source.collections:
            raise ValueError(f"{GEOMETRY['path']} has no collection {name}")
        target.collections = [name]
    loaded = target.collections[0]
    objects = list(loaded.all_objects)
    for obj in objects:
        collection.objects.link(obj)
    bpy.data.collections.remove(loaded)
    roots = [o for o in objects if o.parent is None]
    if len(roots) != 1 or roots[0].type != "EMPTY" or "sandstone" not in roots[0]:
        raise ValueError(f"{name} must hold one root empty with the 'sandstone' observations")
    for obj in objects:
        if obj.type != "MESH":
            continue
        placeholders = list(obj.data.materials)
        names = []
        for placeholder in placeholders:
            match = PLACEHOLDER.match(placeholder.name) if placeholder else None
            if match is None or (match.group(1) not in CELLS and match.group(1) not in SWATCHES):
                raise ValueError(f"{obj.name}: material {placeholder and placeholder.name} is not a sandstone-<material> placeholder")
            names.append(match.group(1))
        atlas_uvs(obj, names)
        obj.data.materials.clear()
        obj.data.materials.append(material())
        obj.data.polygons.foreach_set("material_index", np.zeros(len(obj.data.polygons), dtype=np.int32))
        obj.data.update()
        for placeholder in placeholders:
            if placeholder.users == 0:
                bpy.data.materials.remove(placeholder)
    return roots[0], json.loads(roots[0]["sandstone"])


# ---------------------------------------------------------------- compositions

def r6(v):
    return [round(c, 6) for c in v]


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


def composition(length, span, front, back, left, right, chimneys, building_yaw=0):
    """A building with its ridge along X, ``length`` long over ``span``, turned by ``building_yaw``. The eave walls are
    ``front`` (+Z) and ``back`` (-Z), the gable walls ``right`` (+X) and ``left`` (-X). Every ``wall-door`` gets its door
    leaf, so a door can stand in an eave wall, a gable wall, or several of either; not in a run's end module, whose
    surround would meet the corner stones."""
    items = []
    def add(key, t, yaw):
        items.append({"key": f"sandstone.kit.{key}", "variant": "default", "translation": t, "yawDegrees": yaw})
    size = int(span)
    apex = HEIGHT + ROOF_LIFT + span / 2 * PITCH + GABLE_ABOVE_ROOF
    half = span / 2
    sides = [("front", front, (0, 0, half), 0, length), ("back", back, (0, 0, -half), 180, length),
             ("right", right, (length / 2, 0, 0), 90, span), ("left", left, (-length / 2, 0, 0), -90, span)]
    for name, modules, origin, yaw, run in sides:
        for module, u in layout(modules, run):
            t = yaw_point((u, 0, 0), yaw)
            t = (t[0] + origin[0], 0, t[2] + origin[2])
            add(module, t, yaw)
            if module == "wall-door":
                hinge = yaw_point(MOUNT, yaw)
                add("door", (t[0] + hinge[0], hinge[1], t[2] + hinge[2]), yaw)
        if name in ("right", "left"):
            add(f"gable-{size}", origin, yaw)
        if name in chimneys:
            add("chimney", (origin[0], apex - CHIMNEY_SEAT, origin[2]), yaw)
    for x, z, yaw in [(length / 2, half, 0), (-length / 2, half, -90), (-length / 2, -half, 180), (length / 2, -half, 90)]:
        add("corner", (x, 0, z), yaw)
    x = -length / 2
    for m in [f"roof-{size}"] * int(length // MODULE) + ([f"roof-{size}-half"] if length % MODULE else []):
        w = MODULE / 2 if m.endswith("half") else MODULE
        add(m, (x + w / 2, 0, 0), 0)
        x += w
    for item in items:
        t = yaw_point(item["translation"], building_yaw)
        item["translation"] = r6(t)
        item["yawDegrees"] = round(((item["yawDegrees"] + building_yaw + 180) % 360) - 180, 6)
    return items


def compositions():
    """Example buildings in a footprint-base-centre frame whose +Z side has a door."""
    W, H_, N, D = "wall", "wall-half", "wall-window", "wall-door"
    def entry(width, depth, items):
        return {"footprint": {"width": width, "depth": depth}, "items": items}
    return {
        # Door in the middle of the long side.
        "cottage": entry(8.0, 6.0, composition(8.0, 6.0, [N, H_, D, H_, N], [W, N, N, W], [W, N, W], [W, W, W], ("right",))),
        # Door off-centre in the long side.
        "merchant": entry(10.0, 6.0, composition(10.0, 6.0, [H_, D, N, N, W, H_], [W, N, W, N, W], [W, N, W], [W, N, W], ("left",))),
        # An odd length, with half a roof module.
        "workshop": entry(7.0, 6.0, composition(7.0, 6.0, [N, H_, D, N], [W, W, H_, N], [W, W, W], [W, N, W], ("left",))),
        # Two doors in one long side.
        "longhouse": entry(14.0, 6.0, composition(14.0, 6.0, [N, D, N, W, N, D, N], [W, N, W, N, W, N, W], [W, N, W], [W, N, W], ("left", "right"))),
        # The ridge runs away from the door, which stands in the gable end.
        "gable-house": entry(6.0, 10.0, composition(10.0, 6.0, [W, N, N, N, W], [W, N, N, N, W], [W, W, W], [N, D, N], ("left",), -90)),
        # The wide span.
        "hall": entry(12.0, 8.0, composition(12.0, 8.0, [N, N, H_, D, H_, N, N], [W, N, N, N, N, W], [W, N, N, W], [W, N, N, W], ("right",))),
    }


# ---------------------------------------------------------------- entry points

def build(part, collection, location=(0, 0, 0), yaw=0.0):
    """Place one authored module under its root ``sandstone.<part>`` at ``location`` (glTF axes)."""
    if part not in PARTS:
        raise ValueError(f"sandstone part must be one of {', '.join(PARTS)}")
    root, info = load_module(part, collection)
    root.location = to_blender(location)
    root.rotation_euler = (0, 0, math.radians(yaw))
    return root, info


def build_composition(name, collection, location=(0, 0, 0)):
    """Lay a composition out in a live session (review only)."""
    roots = []
    for item in compositions()[name]["items"]:
        t = item["translation"]
        root, _ = build(item["key"].split(".")[-1], collection, (t[0] + location[0], t[1] + location[1], t[2] + location[2]), item["yawDegrees"])
        roots.append(root)
    return roots


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or "part" not in arguments or set(arguments) - {"schemaVersion", "part", "atlas"}:
        raise ValueError("sandstone arguments must be {schemaVersion: 1, part, atlas?}")
    if arguments["part"] not in PARTS:
        raise ValueError(f"sandstone part must be one of {', '.join(PARTS)}")
    if arguments.get("atlas", DEFAULT_ATLAS) not in ATLAS_MODES:
        raise ValueError(f"sandstone atlas must be one of {', '.join(ATLAS_MODES)}")
    if set(inputs) != {"common", "outpost", "kit"}:
        raise ValueError("sandstone recipe takes exactly the inputs 'common' (kit_common.py), 'outpost' (outpost.py) and 'kit' (sandstone-kit.blend)")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_sources(inputs.load_source("outpost"), inputs.load_source("common"))
    use_geometry(inputs["kit"])
    use_atlas(arguments.get("atlas", DEFAULT_ATLAS))
    part = arguments["part"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    root, info = build(part, bpy.context.scene.collection)
    objects = [root] + list(root.children_recursive)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    triangles = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects if o.type == "MESH")
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=True,
        export_vertex_color="NONE", export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    result = {"recipe": "sandstone-kit-v1", "part": part, "unit": "meter", "axes": "right-handed-y-up", "facing": "+Z", "triangleCount": triangles, **info}
    if part == "wall":
        result["compositions"] = compositions()
    return result
