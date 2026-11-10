"""Limestone caves (docs/limestone-caves.md): modular level-bedded cave pieces on mmorpg's 4 m grid, that join at one fixed opening.

Each module carves a signed-distance volume (passages and domed rooms with flat walking floors), roughens it with level beds and
small breaks, polygonises it, and reduces it to a game mesh. Near every opening the roughness fades to nothing, so all openings are
the same plain arch and modules join without a seam; each module runs a little past its opening plane to hide what the reduction
moves. The surface area is too large for one baked atlas, so walls and floors are two tiling materials, painted from CC0 scans
matched to mmorpg's palette, with recessed corners and broad mottling in ``COLOR_0``.

The arguments are ``piece``. Noise is value noise from ``cliff_outcrop.py`` (the declared input ``outcrop``) and tiling masks are from
``kit_common.py`` (``common``), both seeded. Blender coordinates are Z up with the module's south (-Y) towards glTF +Z; the GLB is
exported +Y up, with its origin at the module's centre on its upper floor (see ``docs/limestone-caves.md``).
"""
import math
import runpy

import bmesh
import bpy
import numpy as np

RECIPE = "limestone-caves-v1"
ROCK_MATERIAL, FLOOR_MATERIAL = "cave-rock", "cave-floor"
HALF, TALL = 2.15, 3.3  # the opening's half width and height: a 4 m wide, 3 m high clear passage plus room for the rock's bumps
CELL = 0.1  # metres per volume cell
OVERLAP = 0.25  # how far a module runs past its opening plane, to hide the gaps its reduction opens
EXTEND = 0.7  # how far a passage's centre line carries on past the opening, so the arch is whole at the plane
QUIET = (1.0, 3.0)  # within this many metres of an opening the rock's roughness fades to nothing
BED_HEIGHT = 0.58  # metres per limestone bed
TILE_EDGE = 1024
ROCK_TILE, FLOOR_TILE = 3.6, 5.2  # metres per repeat of the tiling materials
FLOOR_FLECK_LIMIT = 1.3  # how far above its mean the floor may brighten: the scan's pale stones are what its repeat is seen by
ROCK_PALETTE, GRAVEL_PALETTE, EARTH_PALETTE = 0x8b877e, 0x8f8a7c, 0x6e6554  # mmorpg's ground colours (sRGB)
SOFTEN = 0.5  # how far the rock scan is pulled towards the palette colour
NORMAL_STRENGTH = {"rock": 3.0, "floor": 2.2}
ROUGHNESS = 0.92
MIN_SURFACE_FACES = 400
RIM_SHADE = 0.78  # COLOR_0 at every opening, the same on both sides of a join
SPIKE_SEGMENTS, SPIKE_RINGS = 7, 5


def line(*points):
    return list(points)


def straight(ax, ay, bx, by, floor=0.0):
    """A level passage from (ax, ay) to (bx, by), carried on past each end."""
    length = math.hypot(bx - ax, by - ay)
    ux, uy = (bx - ax) / length, (by - ay) / length
    return [(ax - ux * EXTEND, ay - uy * EXTEND, floor), (ax, ay, floor), (bx, by, floor), (bx + ux * EXTEND, by + uy * EXTEND, floor)]


def s(side):  # south, north, east, west: unit vector out of the module
    return {"south": (0, -1), "north": (0, 1), "east": (1, 0), "west": (-1, 0)}[side]


# Per piece: its volume bounds (x0, x1, y0, y1, z0, z1), passages (a centre line of (x, y, floor), half width and height), rooms (x, y, floor,
# x radius, y radius, height), openings (name, x, y, floor), and its LOD0 and collision triangle targets. Openings sit on the bounds' faces.
ROOM_OPENINGS = lambda x, y: [("south", 0.0, -y, 0.0), ("north", 0.0, y, 0.0), ("east", x, 0.0, 0.0), ("west", -x, 0.0, 0.0)]
ROOM_STUBS = lambda x, y: [(straight(0, -y, 0, 0), HALF, TALL), (straight(0, y, 0, 0), HALF, TALL), (straight(x, 0, 0, 0), HALF, TALL), (straight(-x, 0, 0, 0), HALF, TALL)]
PIECES = {
    "tunnel": dict(bounds=(-5.0, 5.0, -4.0, 4.0, -1.0, 5.0), paths=[(straight(0, -4, 0, 4), HALF, TALL)], rooms=[], openings=[("south", 0.0, -4.0, 0.0), ("north", 0.0, 4.0, 0.0)], triangles=1400, collision=96, seed=31),
    "bend": dict(bounds=(-5.0, 4.0, -4.0, 5.0, -1.0, 5.0), paths=[(line((0.0, -4.7, 0.0), (0.0, -4.0, 0.0), (0.0, -1.6, 0.0), (0.55, -0.55, 0.0), (1.6, 0.0, 0.0), (4.0, 0.0, 0.0), (4.7, 0.0, 0.0)), HALF, TALL)], rooms=[], openings=[("south", 0.0, -4.0, 0.0), ("east", 4.0, 0.0, 0.0)], triangles=1800, collision=120, seed=32),
    "junction": dict(bounds=(-4.0, 4.0, -4.0, 5.0, -1.0, 5.0), paths=[(straight(0, -4, 0, 0), HALF, TALL), (straight(-4, 0, 4, 0), HALF, TALL)], rooms=[], openings=[("south", 0.0, -4.0, 0.0), ("east", 4.0, 0.0, 0.0), ("west", -4.0, 0.0, 0.0)], triangles=2400, collision=150, seed=33),
    "ramp": dict(bounds=(-5.0, 5.0, -4.0, 4.0, -5.0, 5.0), paths=[(line((0.0, -4.7, 0.0), (0.0, -3.6, 0.0), (0.0, 3.6, -4.0), (0.0, 4.7, -4.0)), HALF, TALL)], rooms=[], openings=[("south", 0.0, -4.0, 0.0), ("north", 0.0, 4.0, -4.0)], triangles=1800, collision=110, seed=34),
    "dead-end": dict(bounds=(-5.0, 5.0, -4.0, 5.0, -1.0, 5.0), paths=[(line((0.0, -4.7, 0.0), (0.0, -4.0, 0.0), (0.0, 0.6, 0.0)), HALF, TALL)], rooms=[(0.0, 0.8, 0.0, 2.7, 3.1, 3.5)], openings=[("south", 0.0, -4.0, 0.0)], triangles=1500, collision=110, seed=35),
    "cap": dict(bounds=(-4.0, 4.0, -1.0, 2.6, -1.0, 5.0), paths=[(line((0.0, -1.7, 0.0), (0.0, -1.0, 0.0), (0.0, 0.2, 0.0)), HALF, TALL)], rooms=[(0.0, 0.1, 0.0, 2.3, 1.7, 3.35)], openings=[("south", 0.0, -1.0, 0.0)], triangles=420, collision=60, seed=36),
    "room-small": dict(bounds=(-6.0, 6.0, -6.0, 6.0, -1.0, 6.2), paths=ROOM_STUBS(6, 6), rooms=[(0.0, 0.0, 0.0, 4.3, 4.2, 3.9)], openings=ROOM_OPENINGS(6.0, 6.0), triangles=3200, collision=200, seed=37),
    "room-medium": dict(bounds=(-10.0, 10.0, -10.0, 10.0, -1.0, 8.0), paths=ROOM_STUBS(10, 10), rooms=[(0.0, 0.0, 0.0, 7.6, 7.2, 5.4)], openings=ROOM_OPENINGS(10.0, 10.0), triangles=5600, collision=320, seed=38),
    "room-large": dict(bounds=(-14.0, 14.0, -10.0, 10.0, -1.0, 9.2), paths=ROOM_STUBS(14, 10), rooms=[(0.0, 0.0, 0.0, 12.0, 7.8, 6.4)], openings=ROOM_OPENINGS(14.0, 10.0), triangles=8000, collision=420, seed=39),
    "mouth": dict(bounds=(-9.5, 9.5, -8.0, 9.5, -0.7, 7.5), paths=[(line((0.0, -5.2, 0.0), (0.0, 4.0, 0.0), (0.0, 4.9, 0.0)), HALF, TALL)], rooms=[], openings=[("north", 0.0, 4.0, 0.0)], triangles=5000, collision=260, seed=40, mound=True, calm=[(0.0, -2.6), (-1.6, -2.6), (1.6, -2.6)]),
}
SPIKES = {
    "spikes-floor": dict(count=7, spread=1.25, radius=(0.12, 0.3), height=(0.8, 2.5), hanging=False, seed=51),
    "spikes-roof": dict(count=6, spread=1.25, radius=(0.1, 0.24), height=(0.7, 1.9), hanging=True, seed=52),
}
ALL_PIECES = {**PIECES, **SPIKES}
INPUTS = {"outcrop", "common", "rockColour", "rockHeight", "gravelColour", "earthColour"}


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "piece"} or arguments["schemaVersion"] != 1:
        raise ValueError("limestone caves arguments must be {schemaVersion: 1, piece}")
    if arguments["piece"] not in ALL_PIECES:
        raise ValueError(f"limestone caves piece must be one of {', '.join(ALL_PIECES)}")
    if set(inputs) != INPUTS:
        raise ValueError(f"limestone caves take exactly the inputs {', '.join(sorted(INPUTS))}")


def smooth(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.maximum(c, 1e-6) ** (1 / 2.4) - 0.055)


def palette(colour):
    return to_linear(np.array([(colour >> 16 & 255) / 255, (colour >> 8 & 255) / 255, (colour & 255) / 255]))


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


# ---------------------------------------------------------------- the volume

def rounded(path, passes=3):
    for _ in range(passes):
        out = [path[0]]
        for a, b in zip(path, path[1:]):
            out += [tuple(0.75 * p + 0.25 * q for p, q in zip(a, b)), tuple(0.25 * p + 0.75 * q for p, q in zip(a, b))]
        path = out + [path[-1]]
    return path


def along(path, gx, gy):
    """Per column: the distance to a centre line of (x, y, floor) and the floor at its nearest point."""
    points = np.array(path, dtype=float)
    best, floor = np.full(gx.shape, 1e9), np.zeros(gx.shape)
    for (ax, ay, af), (bx, by, bf) in zip(points, points[1:]):
        dx, dy = bx - ax, by - ay
        t = np.clip(((gx - ax) * dx + (gy - ay) * dy) / max(dx * dx + dy * dy, 1e-9), 0, 1)
        dist = np.hypot(gx - (ax + t * dx), gy - (ay + t * dy))
        closer = dist < best
        best, floor = np.where(closer, dist, best), np.where(closer, af + (bf - af) * t, floor)
    return best, floor


def carve(cfg, o):
    """The solid field (negative in rock) and the lookups the mesh needs."""
    x0, x1, y0, y1, z0, z1 = cfg["bounds"]
    nx, ny, nz = round((x1 - x0 + 2 * OVERLAP) / CELL) + 1, round((y1 - y0 + 2 * OVERLAP) / CELL) + 1, round((z1 - z0) / CELL) + 1
    origin = np.array([x0 - OVERLAP, y0 - OVERLAP, z0])
    xs, ys, zs = origin[0] + np.arange(nx) * CELL, origin[1] + np.arange(ny) * CELL, z0 + np.arange(nz) * CELL
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    table = o["lattice"](cfg["seed"])
    wave = lambda p, f, offset=0.0: (o["vnoise"](p + offset, f, table) - 0.5) * 1.7
    cave = None
    floor_map, reach = np.full(gx.shape, -99.0), np.full(gx.shape, 1e9)
    for path, half, tall in cfg["paths"]:
        dist, floor = along(rounded(path), gx, gy)
        field = np.empty((nx, ny, nz), dtype=np.float32)
        for k, z in enumerate(zs):
            rise = np.maximum(z - floor, 0.0)
            field[:, :, k] = np.maximum((np.sqrt((dist / half) ** 2 + (rise / tall) ** 2) - 1.0) * min(half, tall), floor - z)
        cave = field if cave is None else smin(cave, field, 0.7)
        closer = dist - half < reach
        floor_map, reach = np.where(closer, floor, floor_map), np.where(closer, dist - half, reach)
    for cx, cy, floor, rx, ry, tall in cfg["rooms"]:
        r = np.sqrt(((gx - cx) / rx) ** 2 + ((gy - cy) / ry) ** 2)
        field = np.empty((nx, ny, nz), dtype=np.float32)
        for k, z in enumerate(zs):
            rise = max(z - floor, 0.0)
            field[:, :, k] = np.maximum((np.sqrt(r ** 2 + (rise / tall) ** 2) - 1.0) * min(rx, ry, tall), floor - z)
        cave = smin(cave, field, 1.1)
        closer = (r - 1.0) * min(rx, ry) < reach
        floor_map, reach = np.where(closer, floor, floor_map), np.where(closer, (r - 1.0) * min(rx, ry), reach)
    plain = cave.copy() if cfg.get("mound") else None
    index = np.nonzero(np.abs(cave) < 0.9)
    points = np.stack([xs[index[0]], ys[index[1]], zs[index[2]]], -1)
    # Roughness fades to nothing at the openings, so all of them are the same plain arch.
    anchors = [(ox, oy) for _, ox, oy, _ in cfg["openings"]] + cfg.get("calm", [])  # plus the mouth's face, where bed recesses would break through the thin rock
    calm = np.min([np.hypot(points[:, 0] - ox, points[:, 1] - oy) for ox, oy in anchors], axis=0)
    quiet = smooth(*QUIET, calm)
    wobble = wave(points * np.array([1.0, 1.0, 0.0]), 0.9)
    level = (points[:, 2] + wobble * 0.1) / BED_HEIGHT
    bed = np.floor(level)
    inside_bed = level - bed
    recess = wave(np.stack([points[:, 0] * 0.35, points[:, 1] * 0.35, bed * 7.3], -1), 1.0) * 0.44
    joints = smooth(0.0, 0.07, inside_bed) * smooth(0.0, 0.07, 1 - inside_bed)
    lumps = wave(points, 1.1) * 0.16 + wave(points * np.array([1.0, 1.0, 3.2]), 3.2, 3.3) * 0.12 + wave(points, 11.0, 7.1) * 0.035
    height_above = np.clip((points[:, 2] - floor_map[index[0], index[1]]) / 0.9, 0, 1)
    cave[index] += ((lumps + (recess - 0.11 * (1 - joints)) * height_above) * smooth(0.0, 0.8, height_above) * quiet).astype(np.float32)
    if cfg.get("mound"):
        solid = np.maximum(mound_field(cfg, gx, gy, xs, ys, zs, plain, wave), -cave)
    else:
        solid = -cave
    # A slight blur removes the pinched spots in the raw surface, which otherwise stop the mesh reduction well short of its target.
    for axis in range(3):
        solid = (solid * 2 + np.roll(solid, 1, axis) + np.roll(solid, -1, axis)) / 4
    return solid.astype(np.float32), origin, np.where(reach < 2.0, floor_map, -99.0), cave


def mound_field(cfg, gx, gy, xs, ys, zs, cave, wave):
    """The low rocky outcrop round the entrance: enough rock over the passage, and a skirt that runs into the ground."""
    ground = np.stack([gx, gy, np.full_like(gx, 7.0)], -1)
    front = -2.6 + wave(np.stack([gx, np.zeros_like(gx), np.full_like(gx, 3.0)], -1), 0.28) * 0.5
    outcrop = 1 - smooth(1.5, 7.5, np.hypot(gx * 0.82, (gy + 0.4) * 1.05) + wave(ground, 0.5) * 1.3)
    raw = (4.9 + wave(ground, 0.3) * 1.2) * outcrop * smooth(-0.3, 1.2, gy - front)
    beds = raw * 0.66 + np.round((raw + wave(ground, 0.2) * 0.5) / 0.9) * 0.9 * 0.34
    carved = cave < 0
    top = zs[0] + (len(zs) - 1 - np.argmax(carved[:, :, ::-1], axis=2)) * CELL
    guard = np.where(carved.any(axis=2), top + 1.3, -0.6)
    for _ in range(10):
        guard = np.maximum.reduce([guard, np.roll(guard, 1, 0), np.roll(guard, -1, 0), np.roll(guard, 1, 1), np.roll(guard, -1, 1)])
    for _ in range(14):
        guard = (guard * 2 + np.roll(guard, 1, 0) + np.roll(guard, -1, 0) + np.roll(guard, 1, 1) + np.roll(guard, -1, 1)) / 6
    cover = smooth(-1.4, -0.2, gy - front)  # the rock over the passage starts ahead of the mound's face, so the arch stays whole
    base = np.where(raw > 0.02, beds, -0.6)  # outside the outcrop the surface drops below the ground and is cut away
    hill = np.maximum(base, guard * cover * (wave(ground, 0.9) * 0.08 + 1.0) - 0.6 * (1 - cover))
    field = np.empty((len(xs), len(ys), len(zs)), dtype=np.float32)
    for k, z in enumerate(zs):
        field[:, :, k] = z - hill
    return field


def surface_nets(values):
    """Vertices (in grid units) and quads of the zero surface of ``values``, its faces looking out of the solid (negative) side."""
    inside = values < 0
    ids, sums, quads = [], [], []
    shape = np.array(values.shape)
    sizes = np.array([shape[1] * shape[2], shape[2], 1], dtype=np.int64)
    cell_id = lambda i, j, k: i * sizes[0] + j * sizes[1] + k
    for axis in range(3):
        b, c = (axis + 1) % 3, (axis + 2) % 3
        low, high = range(0, shape[axis] - 1), range(1, shape[axis])
        a0, a1 = np.take(inside, low, axis), np.take(inside, high, axis)
        change = np.nonzero(a0 != a1)
        v0, v1 = np.take(values, low, axis)[change], np.take(values, high, axis)[change]
        t = v0 / (v0 - v1)
        idx = np.stack(change, -1).astype(np.int64)
        keep = (idx[:, b] > 0) & (idx[:, c] > 0) & (idx[:, b] < shape[b] - 1) & (idx[:, c] < shape[c] - 1)
        idx, t, solid_first = idx[keep], t[keep], a0[change][keep]
        position = idx.astype(np.float64)
        position[:, axis] += t
        cells = []
        for db, dc in ((0, 0), (-1, 0), (-1, -1), (0, -1)):
            at = idx.copy()
            at[:, b] += db
            at[:, c] += dc
            cells.append(cell_id(at[:, 0], at[:, 1], at[:, 2]))
        block = np.stack(cells, -1)
        ids.append(block.ravel())
        sums.append(np.repeat(position, 4, axis=0))
        quads.append(np.where(~solid_first[:, None], block[:, ::-1], block))  # that order faces +axis, the way a solid-to-air edge looks
    all_ids = np.concatenate(ids)
    unique, inverse = np.unique(all_ids, return_inverse=True)
    counts = np.bincount(inverse)
    positions = np.concatenate(sums)
    verts = np.stack([np.bincount(inverse, weights=positions[:, i]) / counts for i in range(3)], -1)
    return verts, np.searchsorted(unique, np.concatenate(quads))


# ---------------------------------------------------------------- the tiles

def scan(path):
    """A scan at the tile's size, in linear light, with rows from the top."""
    image = bpy.data.images.load(path, check_existing=True)
    width, height = image.size
    data = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(data)
    rgb = data.reshape(height, width, 4)[::-1, :, :3].astype(np.float64)
    shrink = min(width, height) // TILE_EDGE
    side = TILE_EDGE
    return rgb[:side * shrink, :side * shrink].reshape(side, shrink, side, shrink, 3).mean(axis=(1, 3))


def tile_normal(height, metres, strength):
    """A tiling tangent-space normal map from a height field of metres over its width. +Y points up the image."""
    per_pixel = metres / TILE_EDGE
    ds = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / (2 * per_pixel)
    dt = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / (2 * per_pixel)
    n = np.dstack([-ds * strength, dt * strength, np.ones_like(ds)])
    return n / np.linalg.norm(n, axis=-1, keepdims=True) * 0.5 + 0.5


def image_from(name, rgb, data):
    image = bpy.data.images.new(name, TILE_EDGE, TILE_EDGE, alpha=False)
    image.colorspace_settings.is_data = data  # before the pixels: changing it regenerates a generated image
    rgba = np.dstack([rgb, np.ones(rgb.shape[:2])])[::-1].astype(np.float32)
    image.pixels.foreach_set(rgba.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def textures(inputs, common):
    """The rock and floor tiles: (colour, normal) images for each."""
    rock_lin = to_linear(scan(inputs["rockColour"]))
    target = palette(ROCK_PALETTE)
    rock = rock_lin * (target / rock_lin.mean(axis=(0, 1)))
    rock = rock + (target - rock) * SOFTEN
    rock_height = scan(inputs["rockHeight"]).mean(axis=-1) * 0.05
    gravel_lin, earth_lin = to_linear(scan(inputs["gravelColour"])), to_linear(scan(inputs["earthColour"]))
    gravel = gravel_lin * (palette(GRAVEL_PALETTE) / gravel_lin.mean(axis=(0, 1)))
    earth = earth_lin * (palette(EARTH_PALETTE) / earth_lin.mean(axis=(0, 1)))
    patches = smooth(0.48, 0.68, common["fbm"](TILE_EDGE, 3, 4, 77))[..., None]
    floor = earth + (gravel - earth) * patches
    floor = np.minimum(floor, floor.mean(axis=(0, 1)) * FLOOR_FLECK_LIMIT)
    floor_height = floor.mean(axis=-1) * 0.05
    return (image_from("cave-rock-colour", to_srgb(np.clip(rock, 0, 1)), False), image_from("cave-rock-normal", tile_normal(rock_height, ROCK_TILE, NORMAL_STRENGTH["rock"]), True),
            image_from("cave-floor-colour", to_srgb(np.clip(floor, 0, 1)), False), image_from("cave-floor-normal", tile_normal(floor_height, FLOOR_TILE, NORMAL_STRENGTH["floor"]), True))


def surface_material(name, colour, normal):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = colour
    shade = nodes.new("ShaderNodeVertexColor")
    shade.layer_name = "Col"
    multiply = nodes.new("ShaderNodeMix")
    multiply.data_type, multiply.blend_type = "RGBA", "MULTIPLY"
    multiply.inputs[0].default_value = 1.0
    links.new(tex.outputs["Color"], multiply.inputs[6])
    links.new(shade.outputs["Color"], multiply.inputs[7])
    links.new(multiply.outputs[2], bsdf.inputs["Base Color"])
    normal_tex = nodes.new("ShaderNodeTexImage")
    normal_tex.image = normal
    normal_map = nodes.new("ShaderNodeNormalMap")
    links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value, bsdf.inputs["Metallic"].default_value = ROUGHNESS, 0.0
    mat.use_backface_culling = False  # a cave is looked at from inside, a mouth from outside as well
    return mat


# ---------------------------------------------------------------- the meshes

def reduce_mesh(mesh, target, collection):
    obj = bpy.data.objects.new("reduce", mesh)
    collection.objects.link(obj)
    mesh.calc_loop_triangles()
    obj.modifiers.new("decimate", "DECIMATE").ratio = min(1.0, target / max(1, len(mesh.loop_triangles)))
    bpy.context.view_layer.update()
    reduced = bpy.data.meshes.new_from_object(obj.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(obj)
    return reduced


def main_surfaces(faces, count):
    """Only the large connected surfaces. The roughness leaves specks of floating rock, which waste the triangle budget and can't be reduced."""
    parent = list(range(count))
    def root(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for a, b, c, d in faces.tolist():
        ra = root(a)
        for other in (b, c, d):
            parent[root(other)] = ra
    labels = np.array([root(a) for a in faces[:, 0].tolist()])
    values, inverse, counts = np.unique(labels, return_inverse=True, return_counts=True)
    return faces[counts[inverse] >= max(MIN_SURFACE_FACES, counts.max() * 0.05)]


def opening_frame(opening, point):
    """Where ``point`` sits relative to an opening: past its plane, across it, and how far ahead of it (0 at the plane)."""
    name, ox, oy, _ = opening
    dx, dy = s(name)
    return (point[0] - ox) * dx + (point[1] - oy) * dy, (point[0] - ox) * -dy + (point[1] - oy) * dx


def snap_rims(bm, cfg):
    """Puts every open edge at an opening exactly on the arch at the module's overlap, so neighbours meet whatever the reduction did."""
    for vert in bm.verts:
        if not vert.is_boundary:
            continue
        for opening in cfg["openings"]:
            name, ox, oy, floor = opening
            ahead, across = opening_frame(opening, vert.co)
            if abs(ahead - OVERLAP) > 0.5 or abs(across) > HALF + 0.6:
                continue
            dx, dy = s(name)
            rise = max(vert.co.z - floor, 0.0)
            if rise < 0.06:
                rise, across = 0.0, max(-HALF, min(HALF, across))
            else:
                reach = math.hypot(across / HALF, rise / TALL)
                across, rise = across / reach, rise / reach
            vert.co.x = ox + dx * OVERLAP - dy * across
            vert.co.y = oy + dy * OVERLAP + dx * across
            vert.co.z = floor + rise
            break


def cave_mesh(piece, cfg, o, common, inputs, collection):
    solid, origin, floor_map, cave = carve(cfg, o)
    grid, faces = surface_nets(solid)
    verts = grid * CELL + origin
    centres = verts[faces].mean(axis=1)
    keep = np.ones(len(faces), dtype=bool)
    if cfg.get("mound"):
        keep &= verts[faces].max(axis=1)[:, 2] > -0.3  # the skirt below the ground goes
        at = np.clip(((centres - origin) / CELL).astype(int), 0, np.array(cave.shape) - 1)
        keep &= ~((centres[:, 1] > cfg["openings"][0][2] + OVERLAP) & (np.abs(cave[at[:, 0], at[:, 1], at[:, 2]]) < 0.4))  # past the opening, the passage's own walls go
    kept = main_surfaces(faces[keep], len(verts))
    dense = bpy.data.meshes.new("dense")
    dense.from_pydata(verts.tolist(), [], kept.tolist())
    dense.update()
    low = reduce_mesh(dense, cfg["triangles"], collection)
    collision = reduce_mesh(dense, cfg["collision"], collection)
    rock_colour, rock_normal, floor_colour, floor_normal = textures(inputs, common)
    low.materials.append(surface_material(ROCK_MATERIAL, rock_colour, rock_normal))
    low.materials.append(surface_material(FLOOR_MATERIAL, floor_colour, floor_normal))
    table = o["lattice"](cfg["seed"] + 100)
    bm = bmesh.new()
    bm.from_mesh(low)
    snap_rims(bm, cfg)
    bm.normal_update()
    uv = bm.loops.layers.uv.new("UVMap")
    colour = bm.loops.layers.float_color.new("Col")
    shape = np.array(solid.shape)
    def field_at(point):
        i, j, k = np.clip(((np.array(point) - origin) / CELL).astype(int), 0, shape - 1)
        return float(solid[i, j, k])
    def floor_at(x, y):
        i, j = np.clip(((np.array((x, y)) - origin[:2]) / CELL).astype(int), 0, shape[:2] - 1)
        return float(floor_map[i, j])
    for face in bm.faces:
        centre = face.calc_center_median()
        is_floor = face.normal.z > 0.6 and centre.z - floor_at(centre.x, centre.y) < 0.55
        face.material_index = 1 if is_floor else 0
        face.smooth = True
        n = face.normal
        tile = FLOOR_TILE if is_floor else ROCK_TILE
        for loop in face.loops:
            p = loop.vert.co
            axis = np.argmax(np.abs(np.array(n)))
            u, v = (p.y, p.z) if axis == 0 else (p.x, p.z) if axis == 1 else (p.x, p.y)
            loop[uv].uv = (u / tile, v / tile)
    shades = {}
    for vert in bm.verts:
        # Recesses are darker: how much open air is a little way out from the surface.
        open_air = np.clip(field_at(vert.co + vert.normal * 0.5) / 0.5, 0.0, 1.0)
        mottle = (o["vnoise"](np.array([vert.co[:]]), 0.6, table)[0] - 0.5) * 0.3
        value = float(np.clip((0.52 + 0.48 * open_air) * (1.0 + mottle), 0.0, 1.0))
        # Near an opening every module fades to the same shade, so neighbours match across the join.
        near = min(abs(opening_frame(opening, vert.co)[0]) for opening in cfg["openings"]) if any(abs(opening_frame(opening, vert.co)[1]) < HALF + 1.0 for opening in cfg["openings"]) else 9.0
        blend = float(smooth(0.3, 1.4, near))
        shades[vert] = RIM_SHADE + (value - RIM_SHADE) * blend
    for face in bm.faces:
        for loop in face.loops:
            value = shades[loop.vert]
            loop[colour] = (value, value, value, 1.0)
    bm.to_mesh(low)
    bm.free()
    colours = low.color_attributes
    colours.active_color = colours["Col"]
    colours.render_color_index = colours.active_color_index
    obj = bpy.data.objects.new("cave", low)
    collection.objects.link(obj)
    collision.calc_loop_triangles()
    observation = {
        "collisionMesh": {"shape": "triangle-mesh", "vertices": [[round(v.co.x, 3), round(v.co.z, 3), round(-v.co.y, 3)] for v in collision.vertices], "triangles": [list(t.vertices) for t in collision.loop_triangles]},
        "openings": [{"name": name, "position": [ox, floor, -oy], "facing": [s(name)[0], 0, -s(name)[1]], "width": 4.0, "height": 3.0} for name, ox, oy, floor in cfg["openings"]],
    }
    return obj, observation


def spike_mesh(cfg, inputs, common, collection):
    rng = np.random.RandomState(cfg["seed"])
    sign = -1.0 if cfg["hanging"] else 1.0
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    colour = bm.loops.layers.float_color.new("Col")
    boxes = []
    for _ in range(cfg["count"]):
        x, y = rng.uniform(-cfg["spread"], cfg["spread"], 2)
        radius, height = rng.uniform(*cfg["radius"]), rng.uniform(*cfg["height"])
        twist = rng.uniform(0, math.tau)
        lean = rng.uniform(-0.1, 0.1, 2)
        rows = []
        for ring in range(SPIKE_RINGS + 1):
            share = ring / SPIKE_RINGS
            r = radius * (1 - share) ** 1.5 + 0.008
            z = -0.25 * sign + share * height * sign  # the root runs into the ground or roof
            cx, cy = x + lean[0] * share * height, y + lean[1] * share * height
            rows.append([bm.verts.new((cx + r * rng.uniform(0.8, 1.2) * math.cos(twist + a), cy + r * rng.uniform(0.8, 1.2) * math.sin(twist + a), z)) for a in (k * math.tau / SPIKE_SEGMENTS for k in range(SPIKE_SEGMENTS))])
        for ring, (lower, upper) in enumerate(zip(rows, rows[1:])):
            for k in range(SPIKE_SEGMENTS):
                corners = (lower[k], lower[(k + 1) % SPIKE_SEGMENTS], upper[(k + 1) % SPIKE_SEGMENTS], upper[k])
                if cfg["hanging"]:
                    corners = corners[::-1]
                face = bm.faces.new(corners)
                face.smooth = True
                for loop in face.loops:
                    p = loop.vert.co
                    loop[uv].uv = (math.atan2(p.y - y, p.x - x) * radius / ROCK_TILE, p.z / ROCK_TILE)
                    value = 0.55 + 0.45 * ring / SPIKE_RINGS
                    loop[colour] = (value, value, value, 1.0)
        boxes.append((x, y, radius, height))
    mesh = bpy.data.meshes.new("spikes")
    bm.to_mesh(mesh)
    bm.free()
    rock_colour, rock_normal, _, _ = textures(inputs, common)
    mesh.materials.append(surface_material(ROCK_MATERIAL, rock_colour, rock_normal))
    colours = mesh.color_attributes
    colours.active_color = colours["Col"]
    colours.render_color_index = colours.active_color_index
    obj = bpy.data.objects.new("spikes", mesh)
    collection.objects.link(obj)
    if cfg["hanging"]:
        return obj, {"collision": "none"}
    proxies = [{"name": f"spike-{i}", "tag": "solid", "center": [round(x, 3), round(height / 2, 3), round(-y, 3)], "size": [round(radius * 1.6, 3), round(height, 3), round(radius * 1.6, 3)]} for i, (x, y, radius, height) in enumerate(boxes) if height > 1.2]
    return obj, {"collisionProxies": proxies}


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    o = runpy.run_path(inputs["outcrop"])
    common = runpy.run_path(inputs["common"])
    piece = arguments["piece"]
    collection = bpy.context.scene.collection
    if piece in SPIKES:
        obj, observation = spike_mesh(SPIKES[piece], inputs, common, collection)
    else:
        obj, observation = cave_mesh(piece, PIECES[piece], o, common, inputs, collection)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_image_format="AUTO",
        export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    obj.data.calc_loop_triangles()
    return {"recipe": RECIPE, "piece": piece, "triangles": len(obj.data.loop_triangles), **observation}
