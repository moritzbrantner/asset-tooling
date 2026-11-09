"""Gravestones (docs/gravestones.md): weathered, dressed limestone headstones, a cross, a ledger, a chest tomb and a footstone.

Every piece is a set of blocks: dense worn stone, each with its own decimated game mesh so small parts keep their shape.
The blocks' weathering is painted per vertex (``wx``: moss, pale worn edges, rain streaks, surviving lettering) and baked
into the atlas, so the three strengths in ``WEATHER`` are build settings. The bake and atlas are those of
``cliff_outcrop.py`` (the declared input ``outcrop``), and two small steps come from ``limestone_rocks.py`` (the declared
input ``limestone``). The rock and moss are CC0 scans, each divided by its mean and multiplied by mmorpg's palette.

The arguments are ``part``: a piece, or ``atlas`` to pack the pieces' baked maps. Noise is ``mathutils.noise``, which holds
no random state, and the lettering comes from ``numpy``'s legacy ``RandomState``. Blender coordinates are Z up with the
front towards -Y; the GLB is exported +Y up, front towards +Z, with its origin on the ground at the footprint centre.
"""
import math
import runpy

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector, noise

RECIPE = "gravestones-v1"
# Weathering strengths, 0 to 1. Each block scales them by up to a quarter (strength), so stones in one yard differ in age.
# Light is 0.25 / 0.2 / 0.2 and heavy 0.9 / 0.85 / 0.85.
WEATHER = {"wear": 0.55, "moss": 0.5, "erosion": 0.5}
ROCK_TILE, MOSS_TILE = 0.77, 0.9  # metres per repeat of the scans
MOSS_SHADE = (0.5, 1.0)  # the broad darkening that keeps the moss muted and hides its repeat
HEAL_PASSES = 32  # how many texels a bake's empty spot may be filled across
SOFTEN = 0.5  # how far the rock scan is pulled towards the palette colour, for dressed stone
SLAB_BURY = 0.28  # how far an upright slab's foot runs below y = 0
PALE = 1.5  # how much brighter the stone is where an edge has worn
STROKE = 5  # the width of a carved letter's stroke, in pixels of the 512 px lettering image: thick enough to survive the bake
SHARP_ANGLE = math.radians(55)  # game-mesh edges above this stay hard


def slab(width, thickness, profile, seed, triangles, panel=None, tilt=(0.0, 0.0), collide="stone", grid=(56, 52, 10), **extra):
    return dict(kind="slab", width=width, thickness=thickness, profile=profile, seed=seed, triangles=triangles, panel=panel, tilt=tilt, collide=collide, grid=grid, **extra)


def box(size, base, seed, triangles, at=(0.0, 0.0), amp=0.005, chips=0.02, collide=None):
    return dict(kind="box", size=size, base=base, seed=seed, triangles=triangles, at=at, amp=amp, chips=chips, collide=collide)


# Each piece: its blocks, its seed for the scan offset and tint, and its baked edge. A slab's ``panel`` is where the lettering
# sits (lowest and highest y, and half its width); ``profile`` is the shape of its top edge.
PIECES = {
    "headstone-round": dict(edge=512, blocks=[slab(0.66, 0.12, ("round", 0.76, 0.2), 1, 700, panel=(0.2, 0.84, 0.3))]),
    "headstone-shoulder": dict(edge=512, blocks=[slab(0.8, 0.13, ("shoulder", 1.08, 0.82), 2, 760, panel=(0.2, 0.92, 0.32))]),
    "headstone-pointed": dict(edge=512, blocks=[slab(0.6, 0.12, ("pointed", 0.92, 0.34), 3, 620, panel=(0.18, 0.95, 0.26))]),
    "headstone-leaning": dict(edge=512, blocks=[slab(0.72, 0.13, ("round", 0.8, 0.24), 8, 720, panel=(0.2, 0.85, 0.32), tilt=(0.3, 0.1))]),
    "headstone-broken": dict(edge=512, blocks=[
        slab(0.7, 0.13, ("broken", 0.5, 9.3), 9, 620, panel=(0.04, 0.68, 0.32)),
        # The fallen top lies flat beside the stump. It is small rubble, so it has no collision.
        slab(0.68, 0.12, ("round", 0.28, 0.18), 10, 300, collide=None, foot=0.02, at=(0.9, -0.65, 0.06), rotation=(math.radians(86), 0.05, 0.9)),
    ]),
    "cross": dict(edge=512, blocks=[
        box((0.78, 0.16, 0.62), -0.08, 4, 120, collide="plinth"),
        box((0.54, 0.22, 0.42), 0.08, 5, 120),
        box((0.2, 1.42, 0.16), 0.28, 6, 240, chips=0.024, collide="shaft"),
        box((0.74, 0.19, 0.15), 1.12, 7, 180, chips=0.024, collide="arm"),
    ]),
    "ledger": dict(edge=512, blocks=[
        box((1.06, 0.14, 2.1), -0.04, 11, 260, amp=0.004, chips=0.03, collide="ledger"),
        box((0.86, 0.12, 1.86), 0.1, 12, 300, amp=0.004, chips=0.028, collide="ledger"),
    ]),
    "chest-tomb": dict(edge=1024, blocks=[
        box((1.25, 0.14, 2.3), -0.05, 28, 200, collide="tomb"),
        box((1.02, 0.66, 2.04), 0.09, 33, 300, collide="tomb"),
        box((1.12, 0.08, 2.15), 0.73, 39, 120, collide="tomb"),
        box((1.26, 0.11, 2.3), 0.81, 45, 240, collide="tomb"),
        *[box((0.03, 0.5, 0.52), 0.17, 40 + offset, 40, at=(side * 0.515, z), amp=0.002, chips=0.01)
          for side in (-1, 1) for offset, z in ((-6, -0.68), (0, 0.0), (6, 0.68))],
        *[box((0.11, 0.7, 0.11), 0.08, seed, 70, at=at) for seed, at in ((61, (-0.51, -1.0)), (62, (0.51, -1.0)), (63, (-0.51, 1.0)), (64, (0.51, 1.0)))],
    ]),
    # A footstone is low enough to step over, so it has no collision.
    "footstone": dict(edge=256, blocks=[slab(0.34, 0.08, ("round", 0.2, 0.12), 13, 300, collide=None, grid=(26, 20, 6))]),
}
ATLAS = "atlas"
ATLAS_EDGE = 2048
# Top-left pixels of each piece's baked maps in the atlas.
ATLAS_RECTS = {
    "chest-tomb": (0, 0), "headstone-round": (1024, 0), "headstone-shoulder": (1536, 0), "headstone-pointed": (1024, 512), "headstone-leaning": (1536, 512),
    "headstone-broken": (0, 1024), "cross": (512, 1024), "ledger": (1024, 1024), "footstone": (1536, 1024),
}
CELLS = {part: {"edge": cfg["edge"]} for part, cfg in PIECES.items()}
INPUTS = {"outcrop", "limestone", "rockColour", "rockHeight", "mossColour"}
ATLAS_INPUTS = {"outcrop", "limestone"} | {f"{kind}{i}" for kind in ("colour", "normal", "rough") for i in range(len(PIECES))}
PALETTE = {"rock": 0x8b877e, "moss": 0x667447}


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "part"} or arguments["schemaVersion"] != 1:
        raise ValueError("gravestones arguments must be {schemaVersion: 1, part}")
    if arguments["part"] != ATLAS and arguments["part"] not in PIECES:
        raise ValueError(f"gravestones part must be one of {', '.join(PIECES)} or {ATLAS}")
    expected = ATLAS_INPUTS if arguments["part"] == ATLAS else INPUTS
    if set(inputs) != expected:
        raise ValueError(f"gravestones take exactly the inputs {', '.join(sorted(expected))}")


def smooth(lo, hi, x):
    t = max(0.0, min(1.0, (x - lo) / (hi - lo)))
    return t * t * (3 - 2 * t)


def strength(seed):
    """How weathered a block is compared with ``WEATHER``, 0.75 to 1.25."""
    return 0.75 + 0.5 * ((seed * 0.618034) % 1)


# ---------------------------------------------------------------- shapes

def grid_box(nx, ny, nz):
    """A closed grid box with u, w in [-1, 1] and v in [0, 1], its rows bunched towards the sides so curves stay round."""
    bm = bmesh.new()
    us = [math.sin(math.pi * (i / nx - 0.5)) for i in range(nx + 1)]
    vs = [j / ny for j in range(ny + 1)]
    ws = [math.sin(math.pi * (k / nz - 0.5)) for k in range(nz + 1)]

    def grid(a, b, make):
        rows = [[bm.verts.new(make(x, y)) for x in a] for y in b]
        for j in range(len(b) - 1):
            for i in range(len(a) - 1):
                bm.faces.new((rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]))

    grid(us, vs, lambda u, v: (u, v, -1))
    grid(us, vs, lambda u, v: (u, v, 1))
    grid(ws, vs, lambda w, v: (-1, v, w))
    grid(ws, vs, lambda w, v: (1, v, w))
    grid(us, ws, lambda u, w: (u, 1, w))
    grid(us, ws, lambda u, w: (u, 0, w))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def top_edge(profile):
    """The height of a slab's top as a function of u in [-1, 1]."""
    kind, a, b = profile
    if kind == "round":
        return lambda u: a + b * math.sqrt(max(0.0, 1 - u * u))
    if kind == "pointed":
        return lambda u: a + b * (1 - abs(u) ** 1.25)
    if kind == "shoulder":
        def shouldered(u):
            u = abs(u)
            if u < 0.52:
                return b + (a - b) * 0.25 + (a - b) * 0.75 * math.cos(u / 0.52 * math.pi * 0.5)
            return b - 0.03 * smooth(0.52, 0.72, u) + 0.05 * math.cos((u - 0.52) / 0.48 * math.pi * 0.5) * (1 - smooth(0.9, 1.0, u)) - 0.04
        return shouldered
    if kind == "broken":
        def snapped(u):  # one diagonal break with a small step
            n = noise.noise(Vector((u * 2.2 + b, b, 0))) * 0.06 + noise.noise(Vector((u * 9 + b, 0, b))) * 0.018
            return a + n + 0.15 * u + (0.05 if u > 0.12 else 0.0) - 0.07 * smooth(0.82, 1.0, u)  # the taper keeps the high corner from ending in a sliver
        return snapped
    raise ValueError(f"unknown profile {kind}")


def worn(position, normal, edge, seed, amp, chips):
    """Displacement along the normal: unevenness, chipped edges, erosion's rounding and pits, and hairline cracks."""
    s = strength(seed)
    wear, erosion = min(1.0, WEATHER["wear"] * s), min(1.0, WEATHER["erosion"] * s)
    p = position * 3.5 + Vector((seed, seed * 1.7, seed * 2.3))
    broad = (noise.noise(p) * amp + noise.noise(p * 2.7) * amp * 0.45) * (1 + 2.5 * erosion)
    q = position * 11 + Vector((seed * 3.1, 0, seed))
    chip = smooth(0.12 - 0.2 * wear, 0.4, noise.noise(q)) * smooth(0.86, 0.99, edge) * chips * (0.5 + 1.6 * wear)
    rounding = 0.035 * erosion * smooth(0.72, 1.0, edge) ** 2
    pits = smooth(0.25, 0.55, noise.noise(position * 22 + Vector((seed, 3, seed)))) * 0.009 * erosion
    r = position * 5 + Vector((0, seed * 2.1, seed))
    crack = (1 - smooth(0.0, 0.025, abs(noise.noise(r)))) * smooth(0.05, 0.3, noise.noise(r * 0.4 + Vector((9, 0, 0)))) * 0.006 * wear
    return normal * (broad - chip - rounding - pits - crack)


def paint(bm, edges, seed):
    """Fill ``wx`` (R moss, G pale edge, B rain streak, A lettering that survives) and lift the moss slightly proud of the stone."""
    s = strength(seed)
    wear, moss, erosion = (min(1.0, WEATHER[key] * s) for key in ("wear", "moss", "erosion"))
    bm.normal_update()
    colours = {}
    offset = Vector((seed * 1.3, seed * 0.7, seed * 2.9))
    for vert in bm.verts:
        p, n = vert.co, vert.normal
        up, back = smooth(0.25, 0.9, n.y), smooth(0.0, 0.9, -n.z)
        foot = 1 - smooth(0.02, 0.45, p.y)
        affinity = max(up, back * 0.75, foot * 0.85) + 0.12
        field = 0.5 + 0.8 * (noise.noise(p * 4.5 + offset) * 0.7 + noise.noise(p * 15 + offset) * 0.3)
        density = moss * (0.35 + affinity)
        moss_mask = 1 - smooth(density - 0.12, density + 0.06, field)
        pale = smooth(0.9, 0.995, edges[vert]) * wear * (0.5 + 0.5 * smooth(-0.2, 0.3, noise.noise(p * 9 + offset)))
        vertical = 1 - smooth(0.5, 0.9, abs(n.y))
        run = noise.noise(Vector((p.x * 14, p.y * 1.2, p.z * 14)) + offset)
        streak = vertical * wear * smooth(-0.05, 0.4, run) * (0.45 + 0.55 * smooth(0.0, 0.9, p.y))
        letters = max(0.05, 1 - erosion * (0.45 + 0.9 * smooth(-0.4, 0.5, noise.noise(p * 7 + offset))))
        colours[vert] = (moss_mask, pale, streak, letters)
        vert.co += n * 0.006 * moss_mask
    layer = bm.loops.layers.float_color.new("wx")
    for face in bm.faces:
        for loop in face.loops:
            loop[layer] = colours[loop.vert]


def lettering_uvs(bm, panel):
    """UVs onto the lettering image on the front face only; every other face reads outside it, which is blank."""
    layer = bm.loops.layers.uv.new("ins")
    for face in bm.faces:
        for loop in face.loops:
            if panel and face.normal.z > 0.7:
                low, high, half = panel
                loop[layer].uv = (0.5 + loop.vert.co.x / (2 * half), (loop.vert.co.y - low) / (high - low))
            else:
                loop[layer].uv = (-1.0, -1.0)


def block_mesh(name, cfg):
    """One block's dense mesh in piece space (Blender axes)."""
    edges = {}
    if cfg["kind"] == "slab":
        bm = grid_box(*cfg["grid"])
        top = top_edge(cfg["profile"])
        foot = -cfg.get("foot", SLAB_BURY)
        for vert in bm.verts:
            u, v, w = vert.co
            vert.co = Vector((u * cfg["width"] / 2, foot + (top(u) - foot) * v, w * cfg["thickness"] / 2))
            edges[vert] = sorted((abs(u), abs(w), v))[1]
        amp, chips = 0.004, 0.02
    else:
        x, y, z = cfg["size"]
        bm = grid_box(max(10, int(x * 48)), max(6, int(y * 48)), max(8, int(z * 48)))
        for vert in bm.verts:
            u, v, w = vert.co
            vert.co = Vector((u * x / 2, cfg["base"] + v * y, w * z / 2))
            edges[vert] = sorted((abs(u), abs(w), abs(2 * v - 1)))[1]
        amp, chips = cfg["amp"], cfg["chips"]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    for vert in bm.verts:
        vert.co += worn(vert.co, vert.normal, edges[vert], cfg["seed"], amp, chips)
    paint(bm, edges, cfg["seed"])
    bm.normal_update()
    lettering_uvs(bm, cfg.get("panel"))
    for vert in bm.verts:  # authored +Y up, front +Z; Blender Z up, front -Y
        y, z = vert.co.y, vert.co.z
        vert.co.y, vert.co.z = -z, y
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    at = cfg.get("at", (0.0, 0.0))
    location = (at[0], at[1], at[2] if len(at) > 2 else 0.0)
    rotation = cfg.get("rotation", (*cfg.get("tilt", (0.0, 0.0)), 0.0))
    mesh.transform(Matrix.Translation(location) @ Euler(rotation).to_matrix().to_4x4())
    return mesh


def combined(name, meshes, shift):
    """One mesh of ``meshes``, moved by ``shift``, smooth shaded."""
    bm = bmesh.new()
    for mesh in meshes:
        bm.from_mesh(mesh)
    result = bpy.data.meshes.new(name)
    bm.to_mesh(result)
    bm.free()
    result.transform(Matrix.Translation(shift))
    result.polygons.foreach_set("use_smooth", np.ones(len(result.polygons), dtype=bool))
    result.update()
    return result


def linked(name, mesh, collection):
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def decimated(mesh, target, collection):
    """A copy of ``mesh`` reduced to about ``target`` triangles."""
    obj = linked(f"{mesh.name}_reduce", mesh, collection)
    mesh.calc_loop_triangles()
    obj.modifiers.new("decimate", "DECIMATE").ratio = min(1.0, target / max(1, len(mesh.loop_triangles)))
    bpy.context.view_layer.update()
    reduced = bpy.data.meshes.new_from_object(obj.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(obj)
    return reduced


def collision(name, meshes, shift):
    """A box round the part of ``meshes`` above the ground, in glTF axes: {name, tag, center, size} (see ``kit_common.proxy``)."""
    points = np.concatenate([np.array([v.co[:] for v in mesh.vertices]) for mesh in meshes]) + np.array(shift[:])
    above = points[points[:, 2] >= 0]
    floor = float(above[:, 2].min())  # blocks that reach the ground start exactly on it; a cross's arm does not
    lo = (float(above[:, 0].min()), 0.0 if floor < 0.02 else floor, float(-above[:, 1].max()))
    hi = (float(above[:, 0].max()), float(above[:, 2].max()), float(-above[:, 1].min()))
    return {"name": name, "tag": "solid", "center": [round((lo[i] + hi[i]) / 2, 3) for i in range(3)], "size": [round(hi[i] - lo[i], 3) for i in range(3)]}


# ---------------------------------------------------------------- material

def lettering(seed=11, size=512):
    """Worn, unreadable carved lines under a ring-and-cross placeholder: a mask, 1 where the stone is cut."""
    rng = np.random.RandomState(seed)
    mask = np.zeros((size, size), dtype=np.float32)
    yy, xx = np.mgrid[0:size, 0:size]
    mask[np.abs(np.hypot(xx - size / 2, yy - size * 0.2) - size * 0.095) < 5] = 1
    mask[(np.abs(xx - size / 2) < 4.5) & (np.abs(yy - size * 0.2) < size * 0.085) | (np.abs(yy - size * 0.2) < 4.5) & (np.abs(xx - size / 2) < size * 0.085)] = 1
    for row, y in enumerate(np.linspace(0.42, 0.86, 5)):
        half = (0.36 if row % 2 == 0 else 0.27) * size
        x = size / 2 - half
        while x < size / 2 + half:
            x_end = x + rng.randint(10, 18)
            top, height = int(y * size), rng.randint(26, 36)
            kind = rng.randint(3)
            if kind == 0:
                mask[top:top + height, int(x):int(x) + STROKE] = 1
            elif kind == 1:
                mask[top:top + STROKE, int(x):int(x_end)] = 1
                mask[top:top + height, int(x):int(x) + STROKE] = 1
            else:
                for k in range(height):
                    mask[top + k, int(x + k * 0.4):int(x + k * 0.4) + STROKE] = 1
            x = x_end + rng.randint(7, 13) + (22 if rng.rand() < 0.15 else 0)
    wear = rng.rand(size // 16 + 1, size // 16 + 1)
    mask *= np.clip(wear[np.ix_(np.arange(size) // 16, np.arange(size) // 16)] * 1.6, 0.25, 1)
    image = bpy.data.images.new("gravestone-lettering", size, size, float_buffer=True)
    image.colorspace_settings.is_data = True  # before the pixels: changing it regenerates a generated image
    image.pixels.foreach_set(np.dstack([mask, mask, mask, np.ones_like(mask)])[::-1].astype(np.float32).ravel())
    image.update()
    image.pack()
    return image


def sculpt_material(name, inputs, seed, o):
    """The bake source. The scans are offset per piece, so no crack repeats down a row."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    n, l = tree.nodes, tree.links
    bsdf = next(node for node in n if node.type == "BSDF_PRINCIPLED")
    rng = np.random.RandomState(seed)
    coords = n.new("ShaderNodeTexCoord")

    def math_node(operation, *values):
        node = n.new("ShaderNodeMath")
        node.operation = operation
        for socket, value in zip(node.inputs, values):
            if isinstance(value, float):
                socket.default_value = value
            else:
                l.new(value, socket)
        return node.outputs[0]

    def vector_node(operation, a, b):
        node = n.new("ShaderNodeVectorMath")
        node.operation = operation
        l.new(a, node.inputs[0])
        if isinstance(b, tuple):
            node.inputs[1].default_value = b
        elif operation == "SCALE":
            l.new(b, node.inputs["Scale"])
        else:
            l.new(b, node.inputs[1])
        return node.outputs[0]

    def mix(factor, a, b):
        node = n.new("ShaderNodeMix")
        node.data_type = "RGBA"
        if isinstance(factor, float):
            node.inputs["Factor"].default_value = factor
        else:
            l.new(factor, node.inputs["Factor"])
        l.new(a, node.inputs[6])
        if isinstance(b, tuple):
            node.inputs[7].default_value = b
        else:
            l.new(b, node.inputs[7])
        return node.outputs[2]

    def scan(path, tile, colour):
        mapping = n.new("ShaderNodeMapping")
        mapping.inputs["Location"].default_value = tuple(float(v) for v in rng.uniform(0, 17, 3))
        mapping.inputs["Scale"].default_value = (1 / tile, 1 / tile, 1 / tile)
        l.new(coords.outputs["Object"], mapping.inputs["Vector"])
        texture = n.new("ShaderNodeTexImage")
        texture.image = bpy.data.images.load(path, check_existing=True)
        texture.image.colorspace_settings.is_data = not colour
        texture.projection, texture.projection_blend = "BOX", 0.3
        l.new(mapping.outputs["Vector"], texture.inputs["Vector"])
        return texture

    def palette(key):
        c = PALETTE[key]
        return o["srgb_to_linear"](np.array([(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255]))

    def graded(texture, key):
        return vector_node("MULTIPLY", texture.outputs["Color"], tuple(float(v) for v in palette(key) / o["mean_linear"](texture.image)))

    wx = n.new("ShaderNodeVertexColor")
    wx.layer_name = "wx"
    channels = n.new("ShaderNodeSeparateColor")
    l.new(wx.outputs["Color"], channels.inputs[0])
    moss_f, pale_f, streak_f = channels.outputs[0], channels.outputs[1], channels.outputs[2]
    uv = n.new("ShaderNodeUVMap")
    uv.uv_map = "ins"
    letters = n.new("ShaderNodeTexImage")
    letters.image, letters.extension = lettering(), "CLIP"
    l.new(uv.outputs["UV"], letters.inputs["Vector"])
    cut = math_node("MULTIPLY", letters.outputs["Color"], wx.outputs["Alpha"])

    rock_colour = scan(inputs["rockColour"], ROCK_TILE, True)
    rock_height = scan(inputs["rockHeight"], ROCK_TILE, False)
    moss_colour = scan(inputs["mossColour"], MOSS_TILE, True)
    rock = palette("rock")
    stone = mix(SOFTEN, graded(rock_colour, "rock"), (*(float(v) for v in rock), 1.0))
    stone = vector_node("SCALE", stone, math_node("MULTIPLY_ADD", cut, -0.58, 1.0))
    # The foot is darker, up to an uneven line.
    separate = n.new("ShaderNodeSeparateXYZ")
    l.new(coords.outputs["Object"], separate.inputs[0])
    wobble = n.new("ShaderNodeTexNoise")
    wobble.inputs["Scale"].default_value = 7.0
    l.new(coords.outputs["Object"], wobble.inputs["Vector"])
    foot = n.new("ShaderNodeMapRange")
    foot.interpolation_type = "SMOOTHSTEP"
    l.new(math_node("SUBTRACT", separate.outputs["Z"], math_node("MULTIPLY_ADD", wobble.outputs["Fac"], 0.16, -0.03)), foot.inputs["Value"])
    foot.inputs["From Min"].default_value, foot.inputs["From Max"].default_value = 0.0, 0.2
    foot.inputs["To Min"].default_value, foot.inputs["To Max"].default_value = 0.42, 1.0
    stone = vector_node("SCALE", stone, foot.outputs[0])
    # Rain streaks darken, worn edges show paler stone, and moss sits on top of everything.
    stone = vector_node("SCALE", stone, math_node("MULTIPLY_ADD", streak_f, -0.55, 1.0))
    stone = mix(math_node("MULTIPLY", pale_f, 0.6), stone, (*(float(v) * PALE for v in rock), 1.0))
    patches = n.new("ShaderNodeTexNoise")
    patches.inputs["Scale"].default_value = 3.0
    l.new(coords.outputs["Object"], patches.inputs["Vector"])
    shade = n.new("ShaderNodeMapRange")
    l.new(patches.outputs["Fac"], shade.inputs["Value"])
    shade.inputs["From Min"].default_value, shade.inputs["From Max"].default_value = 0.3, 0.7
    shade.inputs["To Min"].default_value, shade.inputs["To Max"].default_value = MOSS_SHADE
    moss = vector_node("SCALE", graded(moss_colour, "moss"), shade.outputs[0])
    l.new(mix(moss_f, stone, moss), bsdf.inputs["Base Color"])
    bsdf.inputs["Metallic"].default_value = 0.0
    roughness = n.new("ShaderNodeMapRange")
    l.new(moss_f, roughness.inputs["Value"])
    roughness.inputs["To Min"].default_value, roughness.inputs["To Max"].default_value = 0.9, 1.0
    l.new(roughness.outputs[0], bsdf.inputs["Roughness"])
    moss_lift = math_node("MULTIPLY", moss_f, moss_colour.outputs["Color"])
    height = math_node("MULTIPLY_ADD", moss_lift, 1.6, math_node("SUBTRACT", rock_height.outputs["Color"], cut))
    bump = n.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value, bump.inputs["Distance"].default_value = 0.5, 0.03
    l.new(height, bump.inputs["Height"])
    l.new(bump.outputs[0], bsdf.inputs["Normal"])
    return mat


# ---------------------------------------------------------------- build

def heal(image):
    """Fill black texels, where the bake's rays found no surface, from their neighbours; returns how many were found."""
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    pixels = pixels.reshape(height, width, 4)
    empty = pixels[..., :3].sum(-1) < 0.012
    found = int(empty.sum())
    for _ in range(HEAL_PASSES):
        if not empty.any():
            break
        solid = ~empty
        total = np.zeros_like(pixels)
        count = np.zeros((height, width), dtype=np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            total += np.roll(pixels * solid[..., None], (dy, dx), (0, 1))
            count += np.roll(solid, (dy, dx), (0, 1))
        fill = empty & (count > 0)
        pixels[fill] = total[fill] / count[fill][:, None]
        empty[fill] = False
    image.pixels.foreach_set(pixels.ravel())
    return found


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
    cfg = PIECES[part]
    collection = bpy.context.scene.collection
    name = f"gravestone_{part}"
    blocks = [(block, block_mesh(f"{name}_{i}", block)) for i, block in enumerate(cfg["blocks"])]

    # The origin goes to the centre of the footprint.
    points = np.concatenate([np.array([v.co[:] for v in mesh.vertices]) for _, mesh in blocks])
    shift = Vector((-float(points[:, 0].min() + points[:, 0].max()) / 2, -float(points[:, 1].min() + points[:, 1].max()) / 2, 0.0))
    sculpted = linked(f"{name}_sculpt", combined(f"{name}_sculpt", [mesh for _, mesh in blocks], shift), collection)
    sculpted.data.materials.append(sculpt_material(f"{name}_sculpt", inputs, cfg["blocks"][0]["seed"], o))

    reduced = combined(f"{name}_reduced", [decimated(mesh, block["triangles"], collection) for block, mesh in blocks], shift)
    while reduced.uv_layers:
        reduced.uv_layers.remove(reduced.uv_layers[0])
    while reduced.color_attributes:
        reduced.color_attributes.remove(reduced.color_attributes[0])
    reduced_object = linked(f"{name}_reduced", reduced, collection)
    low = o["game_mesh"](reduced_object, o["triangles"](reduced_object), collection)  # already at its target: this unwraps it
    bpy.data.objects.remove(reduced_object)
    low.data.set_sharp_from_angle(angle=SHARP_ANGLE)
    splinters = limestone["drop_splinters"](low)
    limestone["inset_uvs"](low)
    o["bake"](sculpted, low, name, cfg["edge"])
    empty_texels = {label: heal(bpy.data.images[f"{name}_{label}"]) for label in ("colour", "normal", "roughness")}
    bury = float(-points[:, 2].min())
    names = list(dict.fromkeys(block["collide"] for block, _ in blocks if block["collide"]))  # blocks sharing a name share one box
    proxies = [collision(box_name, [mesh for block, mesh in blocks if block["collide"] == box_name], shift) for box_name in names]
    bpy.data.objects.remove(sculpted)
    low.name = low.data.name = name
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO",
        export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "part": part, "triangles": o["triangles"](low), "bakeEdge": cfg["edge"], "bury": round(bury, 3), "fit": {"blocks": len(blocks), "weather": WEATHER}, "splinterFaces": splinters, "emptyTexels": empty_texels,
            **({"collisionProxies": proxies} if proxies else {})}
