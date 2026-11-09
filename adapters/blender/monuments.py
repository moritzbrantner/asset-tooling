"""Monuments (docs/monuments.md): an obelisk, a broken column and a fallen drum, an urn, a hooded statue, a memorial wall and two mausoleums.

The stone is the gravestones': the same scans, palette and medium weathering, from the helpers in ``gravestones.py`` (the
declared input ``gravestones``). Each piece is a set of blocks, each with its own decimated game mesh. Beyond the
gravestones' slabs and boxes, ``lathe`` turns or tapers a profile and ``tube`` sweeps a limb. The bake and atlas are those
of ``cliff_outcrop.py`` (``outcrop``), with two small steps from ``limestone_rocks.py`` (``limestone``).

``mausoleum-walk-in`` is a real room. Its roof and ceiling are the separate piece ``mausoleum-walk-in-roof``, in the same
frame, so a game can hide them while a character is inside; the descriptor's ``interior`` gives the room's volume.

The arguments are ``part``: a piece, or ``atlas`` to pack the pieces' baked maps. Noise is ``mathutils.noise``, which holds
no random state. Blender coordinates are Z up with the front towards -Y; blocks are authored +Y up with the front towards
+Z, and the GLB is exported +Y up, front towards +Z, with its origin on the ground at the footprint centre.
"""
import math
import runpy

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector, noise

RECIPE = "monuments-v1"
ARCH_AMP = 0.0025  # how uneven the big dressed surfaces are: more, and long edges start to wobble
DARK = (0.22, 0.26, 0.24, 1.0)  # the sealed door and the inside of the statue's hood, as a share of the stone colour
LIGHT = (1.0, 1.0, 1.0, 1.0)
SHARP_ANGLE = math.radians(55)  # game-mesh edges above this stay hard
BAKE_CAGE, BAKE_REACH = 0.1, 0.3  # metres: how far out a bake ray starts and how far it may travel
HEAL_ROUNDS = 40  # more than the widest empty patch needs, and a stop if a map ever bakes wholly black
ROOM = {"width": 4.2, "depth": 5.0, "height": 3.08, "floor": 0.28}  # the walk-in mausoleum's room, in metres
WALK_IN_CENTRE = 0.6  # the room's distance behind the origin, which is the centre of the stepped base
EAVE = 0.06  # a gable roof's thickness at its eaves: at zero its end faces collapse to lines, which the decimation can't reduce


def block(kind, seed, triangles, collide=None, moss=1.0, dark=False, at=(0.0, 0.0), rotation=None, **shape):
    return dict(kind=kind, seed=seed, triangles=triangles, collide=collide, moss=moss, dark=dark, at=at, rotation=rotation, **shape)


def box(size, base, seed, triangles, amp=0.005, chips=0.02, density=40, panel=False, **extra):
    return block("box", seed, triangles, size=size, base=base, amp=amp, chips=chips, density=density, panel=panel, **extra)


def slab(width, thickness, profile, seed, triangles, foot, grid=(56, 52, 10), panel=None, amp=0.004, **extra):
    return block("slab", seed, triangles, width=width, thickness=thickness, profile=profile, foot=foot, grid=grid, panel=panel, amp=amp, **extra)


def lathe(profile, seed, triangles, segments=72, rings=36, amp=0.004, chips=0.02, **extra):
    return block("lathe", seed, triangles, profile=profile, segments=segments, rings=rings, amp=amp, chips=chips, **extra)


def tube(path, seed, triangles, segments=16, **extra):
    return block("tube", seed, triangles, path=path, segments=segments, **extra)


def step_pair(cy, sizes, seed, triangles, density=14):
    """The two steps a mausoleum stands on, which are also its walkable floor."""
    return [box(sizes[0], -0.1, seed, triangles, density=density, amp=ARCH_AMP, at=(0.0, cy - sizes[2]), collide="floor"),
            box(sizes[1], 0.08, seed + 1, triangles, density=density, amp=ARCH_AMP, at=(0.0, cy - sizes[3]), collide="floor")]


def porch_column(x, y, profile, seed):
    return lathe(profile, seed, 700, segments=96, rings=28, flutes=16, flute_depth=0.022, flute_range=(0.5, profile[-2][1] - 0.15), chips=0.025,
                 at=(x, y), collide=f"column-{'left' if x < 0 else 'right'}")


def sealed_mausoleum():
    cy = 0.35
    column = [(0.26, 0.26), (0.26, 0.4), (0.2, 0.46), (0.165, 2.72), (0.23, 2.84), (0.26, 3.01)]
    blocks = [*step_pair(cy, ((5.0, 0.18, 6.3), (4.5, 0.18, 5.9), 0.35, 0.35), 151, 120, density=18)]
    for side, seed in ((-1, 153), (1, 154)):
        blocks += [box((0.4, 2.75, 4.0), 0.26, seed, 250, density=20, amp=ARCH_AMP, at=(side * 1.75, cy), collide="body"),
                   box((0.95, 2.75, 0.4), 0.26, seed + 2, 200, density=20, amp=ARCH_AMP, at=(side * 1.08, cy - 1.8), collide="body"),
                   porch_column(side * 1.4, cy - 2.65, column, seed + 4)]
    return blocks + [
        box((3.1, 2.75, 0.4), 0.26, 159, 250, density=20, amp=ARCH_AMP, at=(0.0, cy + 1.8), collide="body"),
        box((1.25, 0.6, 0.4), 2.41, 160, 160, density=30, amp=ARCH_AMP, at=(0.0, cy - 1.8), panel=True, collide="body"),
        box((1.3, 2.2, 0.1), 0.26, 161, 120, density=30, chips=0.01, amp=0.002, at=(0.0, cy - 1.68), dark=True, moss=0.2, collide="body"),
        box((4.5, 0.4, 5.8), 3.01, 162, 240, density=18, amp=0.002, at=(0.0, cy - 0.3)),
        slab(4.8, 5.95, ("gable", 3.41, 0.95), 163, 320, foot=3.41 - EAVE, grid=(100, 30, 90), amp=0.002, at=(0.0, cy - 0.3)),
    ]


def walk_in_body():
    cy, floor, height = WALK_IN_CENTRE, ROOM["floor"], ROOM["height"]
    column = [(0.3, 0.26), (0.3, 0.4), (0.23, 0.46), (0.19, 3.08), (0.27, 3.2), (0.3, 3.38)]
    blocks = [*step_pair(cy, ((6.6, 0.18, 8.3), (5.9, 0.18, 7.6), 0.6, 0.45), 165, 150),
              box((4.3, 0.02, 5.1), 0.26, 171, 40, density=16, amp=0.001, chips=0.0, at=(0.0, cy), moss=0.0, collide="floor")]
    for side, label, seed in ((-1, "left", 176), (1, "right", 177)):
        blocks += [box((0.45, height, 5.9), floor, seed, 350, density=18, amp=ARCH_AMP, at=(side * 2.325, cy), moss=0.6, collide=f"side-{label}"),
                   box((1.3, height, 0.45), floor, seed + 2, 300, density=18, amp=ARCH_AMP, at=(side * 1.45, cy - 2.725), moss=0.6, collide=f"pier-{label}"),
                   porch_column(side * 1.95, cy - 3.45, column, seed + 8)]
        for index, z in enumerate((-1.7, 0.0, 1.7)):
            blocks.append(box((0.14, height, 0.4), floor, 183 + index * 2 + (side > 0), 60, density=24, amp=0.002, chips=0.012, at=(side * 2.04, cy + z), moss=0.1))
    return blocks + [
        box((4.2, height, 0.45), floor, 180, 300, density=18, amp=ARCH_AMP, at=(0.0, cy + 2.725), moss=0.6, collide="back"),
        box((1.6, 0.68, 0.45), floor + 2.4, 181, 180, density=24, amp=ARCH_AMP, at=(0.0, cy - 2.725), panel=True, moss=0.6, collide="lintel"),
        box((1.25, 0.14, 2.3), floor, 172, 100, density=30, chips=0.012, at=(0.0, cy + 0.5), moss=0.15, collide="tomb"),
        box((1.02, 0.66, 2.04), floor + 0.14, 173, 200, density=30, chips=0.012, at=(0.0, cy + 0.5), moss=0.15, collide="tomb"),
        box((1.26, 0.12, 2.3), floor + 0.8, 174, 140, density=30, chips=0.012, at=(0.0, cy + 0.5), moss=0.15, collide="tomb"),
        slab(2.6, 0.16, ("arched", 2.75, 0.25), 175, 280, foot=floor, grid=(90, 70, 8), panel=(0.75, 2.5, 1.0), at=(0.0, cy + 2.42), moss=0.1),
    ]


def walk_in_roof():
    cy, top = WALK_IN_CENTRE, ROOM["floor"] + ROOM["height"]
    return [box((5.6, 0.42, 7.0), top, 182, 260, density=14, amp=0.002, at=(0.0, cy - 0.35)),
            slab(6.0, 7.15, ("gable", 3.78, 1.1), 192, 340, foot=3.78 - EAVE, grid=(100, 30, 100), amp=0.002, at=(0.0, cy - 0.35))]


def statue():
    bowed = (0.3, 2.36)
    cowl = [(0.118 * math.sin(a), 2.61 + 0.158 * math.cos(a), 0.158 + 0.016 * math.cos(a), 0.02) for a in (math.tau * i / 16 for i in range(17))]
    blocks = [
        box((1.05, 0.18, 1.05), -0.08, 131, 80, collide="pedestal"),
        box((0.8, 0.7, 0.8), 0.1, 132, 100, collide="pedestal"),
        box((0.92, 0.08, 0.92), 0.8, 133, 80, collide="pedestal"),
        lathe([(0.33, 0.88), (0.43, 0.92), (0.41, 1.2), (0.33, 1.72), (0.3, 2.0), (0.33, 2.2), (0.3, 2.33), (0.2, 2.42), (0.1, 2.46)], 134, 1400,
              segments=132, rings=44, folds=0.06, fold_top=2.3, squash=0.74, chips=0.012, amp=0.003, collide="figure"),
        lathe([(0.17, 2.3), (0.215, 2.46), (0.22, 2.62), (0.19, 2.76), (0.12, 2.87), (0.04, 2.94), (0.012, 2.96)], 139, 400,
              segments=64, rings=50, folds=0.018, fold_top=3.1, squash=0.86, chips=0.008, amp=0.002, bow=bowed, moss=0.25, collide="figure"),
        lathe([(0.02, 2.47), (0.1, 2.5), (0.125, 2.61), (0.1, 2.73), (0.02, 2.77)], 137, 60, segments=40, rings=60, squash=0.22, shift=(0.0, 0.178), chips=0.0, amp=0.0005, bow=bowed, dark=True, moss=0.0),
        tube(cowl, 138, 200, segments=12, bow=bowed, moss=0.25),
    ]
    for side, seed in ((-1, 135), (1, 136)):
        blocks += [tube([(side * 0.27, 2.24, 0.0, 0.1), (side * 0.33, 1.98, 0.02, 0.105), (side * 0.32, 1.78, 0.08, 0.1), (side * 0.2, 1.68, 0.24, 0.095), (side * 0.07, 1.64, 0.32, 0.098), (side * 0.0, 1.63, 0.345, 0.075)], seed, 350, segments=20, moss=0.25),
                   tube([(side * 0.3, 1.72, 0.11, 0.075), (side * 0.3, 1.5, 0.14, 0.075), (side * 0.29, 1.28, 0.15, 0.05)], seed, 100, segments=14, moss=0.25)]
    return blocks


def memorial_wall():
    blocks = [box((4.0, 0.2, 0.74), -0.1, 141, 160, density=24, collide="wall"),
              slab(3.4, 0.32, ("memorial", 1.72, 0.34), 142, 900, foot=0.1, grid=(110, 70, 12), panel=(0.24, 1.62, 0.72), collide="wall")]
    for side, seed in ((-1, 143), (1, 145)):
        blocks += [box((0.5, 1.95, 0.52), 0.1, seed, 200, density=30, at=(side * 1.85, 0.0), collide="wall"),
                   box((0.62, 0.12, 0.64), 2.05, seed + 1, 100, density=30, at=(side * 1.85, 0.0), collide="wall")]
    return blocks


URN = [(0.12, 0.89), (0.2, 0.93), (0.16, 0.96), (0.13, 1.0), (0.3, 1.25), (0.36, 1.46), (0.32, 1.66), (0.16, 1.8), (0.2, 1.84), (0.22, 1.9), (0.18, 1.93), (0.04, 2.08), (0.02, 2.12)]
COLUMN = [(0.46, 1.01), (0.52, 1.05), (0.52, 1.13), (0.44, 1.19), (0.4, 1.22), (0.39, 2.18), (0.372, 2.2), (0.39, 2.22), (0.375, 3.0), (0.358, 3.02), (0.375, 3.04), (0.36, 3.75)]
# Each piece: its blocks and its baked edge. Pieces with ``recenter: False`` share one frame and are authored about its origin.
PIECES = {
    "obelisk": dict(edge=512, blocks=[
        box((1.9, 0.22, 1.9), -0.1, 101, 120, density=24, collide="base"), box((1.4, 0.3, 1.4), 0.12, 102, 120, density=24, collide="base"),
        box((1.0, 0.62, 1.0), 0.42, 103, 150, density=30, collide="base"),
        lathe([(0.42, 1.04), (0.3, 4.3), (0.02, 4.78)], 104, 300, square=True, segments=96, rings=26, chips=0.03, collide="shaft"),
    ]),
    "broken-column": dict(edge=512, blocks=[
        box((1.5, 0.24, 1.5), -0.1, 111, 120, density=24, collide="pedestal"), box((1.04, 0.75, 1.04), 0.14, 112, 150, density=30, collide="pedestal"),
        box((1.22, 0.12, 1.22), 0.89, 113, 100, density=30, collide="pedestal"),
        lathe(COLUMN, 114, 1400, segments=120, rings=30, flutes=20, flute_depth=0.03, flute_range=(1.26, 3.8), broken_top=0.2, chips=0.03, collide="shaft"),
    ]),
    "column-drum": dict(edge=256, blocks=[
        lathe([(0.39, -0.36), (0.39, 0.36)], 115, 700, segments=120, rings=30, flutes=20, flute_depth=0.03, flute_range=(-0.4, 0.4), chips=0.03, at=(0.0, 0.0, 0.39), rotation=(math.radians(88), 0.03, 1.35), collide="drum"),
    ]),
    "urn": dict(edge=256, blocks=[
        box((0.74, 0.12, 0.74), -0.06, 121, 60, collide="urn"), box((0.5, 0.75, 0.5), 0.06, 122, 80, collide="urn"), box((0.62, 0.08, 0.62), 0.81, 123, 60, collide="urn"),
        lathe(URN, 124, 700, chips=0.012, collide="urn"),
    ]),
    "statue": dict(edge=512, blocks=statue()),
    "memorial-wall": dict(edge=512, blocks=memorial_wall()),
    "mausoleum-sealed": dict(edge=1024, blocks=sealed_mausoleum()),
    "mausoleum-walk-in": dict(edge=1024, blocks=walk_in_body(), recenter=False, interior=True),
    "mausoleum-walk-in-roof": dict(edge=512, blocks=walk_in_roof(), recenter=False),
}
ATLAS = "atlas"
ATLAS_EDGE = 2048
# Top-left pixels of each piece's baked maps in the atlas.
ATLAS_RECTS = {
    "mausoleum-walk-in": (0, 0), "mausoleum-sealed": (0, 1024), "mausoleum-walk-in-roof": (1024, 0), "memorial-wall": (1536, 0), "statue": (1024, 512),
    "obelisk": (1536, 512), "broken-column": (1024, 1024), "urn": (1536, 1024), "column-drum": (1792, 1024),
}
CELLS = {part: {"edge": cfg["edge"]} for part, cfg in PIECES.items()}
INPUTS = {"outcrop", "limestone", "gravestones", "rockColour", "rockHeight", "mossColour"}
ATLAS_INPUTS = {"outcrop", "limestone", "gravestones"} | {f"{kind}{i}" for kind in ("colour", "normal", "rough") for i in range(len(PIECES))}


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "part"} or arguments["schemaVersion"] != 1:
        raise ValueError("monuments arguments must be {schemaVersion: 1, part}")
    if arguments["part"] != ATLAS and arguments["part"] not in PIECES:
        raise ValueError(f"monuments part must be one of {', '.join(PIECES)} or {ATLAS}")
    expected = ATLAS_INPUTS if arguments["part"] == ATLAS else INPUTS
    if set(inputs) != expected:
        raise ValueError(f"monuments take exactly the inputs {', '.join(sorted(expected))}")


def smooth(lo, hi, x):
    t = max(0.0, min(1.0, (x - lo) / (hi - lo)))
    return t * t * (3 - 2 * t)


def top_edge(profile):
    kind, a, b = profile
    if kind == "gable":
        return lambda u: a + b * (1 - abs(u))
    if kind == "arched":
        return lambda u: a - b * abs(u) ** 2
    if kind == "memorial":
        return lambda u: a + b * (1 - smooth(0.36, 0.5, abs(u)))
    raise ValueError(f"unknown profile {kind}")


def paint(bm, edges, cfg, G):
    """``wx`` as in the gravestones (R moss, G pale edge, B rain streak, A lettering), with streaks in patches so a long wall isn't striped."""
    seed = cfg["seed"]
    s = G["strength"](seed)
    weather = G["WEATHER"]
    wear, moss, erosion = min(1.0, weather["wear"] * s), min(1.0, weather["moss"] * s) * cfg["moss"], min(1.0, weather["erosion"] * s)
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
        run = noise.noise(Vector((p.x * 7, p.y * 0.9, p.z * 7)) + offset)
        patchy = smooth(0.0, 0.45, noise.noise(p * 0.9 + offset * 0.3))
        streak = vertical * wear * smooth(-0.05, 0.4, run) * (0.45 + 0.55 * smooth(0.0, 0.9, p.y)) * patchy
        letters = max(0.05, 1 - erosion * (0.45 + 0.9 * smooth(-0.4, 0.5, noise.noise(p * 7 + offset))))
        colours[vert] = (moss_mask, pale, streak, letters)
        vert.co += n * 0.006 * moss_mask
    layer = bm.loops.layers.float_color.new("wx")
    for face in bm.faces:
        for loop in face.loops:
            loop[layer] = colours[loop.vert]


def bow_verts(bm, bow):
    """Lean a part forward (towards authored +Z) about the X axis through height ``pivot``; ``bow`` is (angle, pivot)."""
    if not bow:
        return
    angle, pivot = bow
    c, s = math.cos(angle), math.sin(angle)
    for vert in bm.verts:
        y, z = vert.co.y - pivot, vert.co.z
        vert.co.y, vert.co.z = pivot + y * c - z * s, y * s + z * c


def lathe_shape(cfg, bm, edges):
    """A turned or tapered stone round +Y; the profile is (radius, height) from the bottom up."""
    profile, segments, rings, seed = cfg["profile"], cfg["segments"], cfg["rings"], cfg["seed"]
    flutes, depth, span = cfg.get("flutes", 0), cfg.get("flute_depth", 0.0), cfg.get("flute_range", (0.0, 0.0))
    folds, fold_top, squash, shift = cfg.get("folds", 0.0), cfg.get("fold_top", 0.0), cfg.get("squash", 1.0), cfg.get("shift", (0.0, 0.0))
    square, broken_top = cfg.get("square", False), cfg.get("broken_top", 0.0)
    points = []
    for (r0, y0), (r1, y1) in zip(profile, profile[1:]):
        steps = max(1, int(math.hypot(r1 - r0, y1 - y0) * rings))
        points += [(r0 + (r1 - r0) * s / steps, y0 + (y1 - y0) * s / steps) for s in range(steps)]
    points.append(profile[-1])
    sharp = [profile[-1], *([profile[0]] if cfg["rotation"] else [])]  # an upright stone's foot isn't worn; a lying one's end is
    for a, b, c in zip(profile, profile[1:], profile[2:]):
        turn = abs(math.atan2(c[1] - b[1], c[0] - b[0]) - math.atan2(b[1] - a[1], b[0] - a[0]))
        if min(turn, math.tau - turn) > math.radians(25):
            sharp.append(b)
    top_y = profile[-1][1]
    rows = []
    for r, y in points:
        ring_edge = 0.97 if any(math.hypot(r - p[0], y - p[1]) < 0.022 for p in sharp) else 0.0
        row = []
        for j in range(segments):
            angle = math.tau * j / segments
            c, s = math.cos(angle), math.sin(angle)
            radius = r / max(abs(c), abs(s)) if square else r
            if flutes:
                radius -= depth * (0.5 + 0.5 * math.cos(flutes * angle)) ** 2 * smooth(span[0], span[0] + 0.08, y) * (1 - smooth(span[1] - 0.08, span[1], y))
            if folds:  # two waves, so the folds aren't evenly spaced
                ripple = math.sin(13 * angle + y * 1.4) + 0.55 * math.sin(7 * angle - y * 0.9 + 1.3)
                radius *= 1 + folds * ripple * (1 - smooth(fold_top - 0.6, fold_top, y)) * (0.45 + 0.55 * (1 - smooth(0.9, 2.0, y)))
            height = y
            if broken_top and y > top_y - 0.35:
                jag = noise.noise(Vector((c * 2.1 + seed, s * 2.1, seed))) + noise.noise(Vector((c * 6 + seed, s * 6, seed))) * 0.35
                height += jag * broken_top * smooth(top_y - 0.35, top_y, y)
            vert = bm.verts.new((radius * c + shift[0], height, radius * s * squash + shift[1]))
            corner = 0.97 * (1 - smooth(0.0, 0.05, abs(abs(c) - abs(s)))) if square else 0.0
            edges[vert] = max(ring_edge, corner)
            row.append(vert)
        rows.append(row)
    return rows, segments


def tube_shape(cfg, bm, edges):
    """A limb swept along (x, y, z, radius) points, its corners rounded by three passes of corner cutting."""
    path = cfg["path"]
    for _ in range(3):
        cut = [path[0]]
        for a, b in zip(path, path[1:]):
            cut.append(tuple(0.75 * p + 0.25 * q for p, q in zip(a, b)))
            cut.append(tuple(0.25 * p + 0.75 * q for p, q in zip(a, b)))
        cut.append(path[-1])
        path = cut
    segments = cfg["segments"]
    rows = []
    for i, point in enumerate(path):
        here = Vector(point[:3])
        ahead = (Vector(path[min(i + 1, len(path) - 1)][:3]) - Vector(path[max(i - 1, 0)][:3])).normalized()
        side = ahead.cross(Vector((0.0, 0.0, 1.0)) if abs(ahead.z) < 0.9 else Vector((1.0, 0.0, 0.0))).normalized()
        other = ahead.cross(side)
        row = []
        for j in range(segments):
            angle = math.tau * j / segments
            vert = bm.verts.new(here + (side * math.cos(angle) + other * math.sin(angle)) * point[3])
            edges[vert] = 0.0
            row.append(vert)
        rows.append(row)
    return rows, segments


def block_mesh(name, cfg, G):
    """One block's dense mesh in piece space (Blender axes)."""
    edges = {}
    kind = cfg["kind"]
    if kind in ("lathe", "tube"):
        bm = bmesh.new()
        rows, segments = (lathe_shape if kind == "lathe" else tube_shape)(cfg, bm, edges)
        for lower, upper in zip(rows, rows[1:]):
            for j in range(segments):
                bm.faces.new((lower[j], lower[(j + 1) % segments], upper[(j + 1) % segments], upper[j]))
        for row in (rows[0], rows[-1]):
            centre = bm.verts.new(sum((v.co for v in row), Vector()) / segments)
            edges[centre] = 0.0
            for j in range(segments):
                bm.faces.new((row[j], row[(j + 1) % segments], centre))
        amp, chips = (cfg["amp"], cfg["chips"]) if kind == "lathe" else (0.002, 0.006)
    elif kind == "slab":
        bm = G["grid_box"](*cfg["grid"])
        top = top_edge(cfg["profile"])
        for vert in bm.verts:
            u, v, w = vert.co
            vert.co = Vector((u * cfg["width"] / 2, cfg["foot"] + (top(u) - cfg["foot"]) * v, w * cfg["thickness"] / 2))
            edges[vert] = sorted((abs(u), abs(w), v))[1]
        amp, chips = cfg["amp"], 0.02
    else:
        x, y, z = cfg["size"]
        density = cfg["density"]
        bm = G["grid_box"](max(10, int(x * density)), max(6, int(y * density)), max(8, int(z * density)))
        for vert in bm.verts:
            u, v, w = vert.co
            vert.co = Vector((u * x / 2, cfg["base"] + v * y, w * z / 2))
            edges[vert] = sorted((abs(u), abs(w), v))[1]  # v, not |2v - 1|: a block's foot sits on something, and a worn foot is a dark chamfer no light reaches
        amp, chips = cfg["amp"], cfg["chips"]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    for vert in bm.verts:
        vert.co += G["worn"](vert.co, vert.normal, edges[vert], cfg["seed"], amp, chips)
    paint(bm, edges, cfg, G)
    bow_verts(bm, cfg.get("bow"))
    bm.normal_update()
    panel = cfg.get("panel")
    if panel is True:
        panel = (cfg["base"] + 0.25 * cfg["size"][1], cfg["base"] + 0.9 * cfg["size"][1], cfg["size"][0] * 0.45)
    G["lettering_uvs"](bm, panel or None)
    shade = bm.loops.layers.float_color.new("shade")
    for face in bm.faces:
        for loop in face.loops:
            loop[shade] = DARK if cfg["dark"] else LIGHT
    for vert in bm.verts:  # authored +Y up, front +Z; Blender Z up, front -Y
        y, z = vert.co.y, vert.co.z
        vert.co.y, vert.co.z = -z, y
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    at = cfg["at"]
    transform = Matrix.Translation((at[0], at[1], at[2] if len(at) > 2 else 0.0))
    if cfg["rotation"]:
        transform = transform @ Euler(cfg["rotation"]).to_matrix().to_4x4()
    mesh.transform(transform)
    return mesh


def shaded_material(name, inputs, seed, o, G):
    """The gravestones' bake source, darkened where a block's ``shade`` attribute says so."""
    mat = G["sculpt_material"](name, inputs, seed, o)
    tree = mat.node_tree
    bsdf = next(node for node in tree.nodes if node.type == "BSDF_PRINCIPLED")
    source = bsdf.inputs["Base Color"].links[0].from_socket
    shade = tree.nodes.new("ShaderNodeVertexColor")
    shade.layer_name = "shade"
    darkened = tree.nodes.new("ShaderNodeVectorMath")
    darkened.operation = "MULTIPLY"
    tree.links.new(source, darkened.inputs[0])
    tree.links.new(shade.outputs["Color"], darkened.inputs[1])
    tree.links.new(darkened.outputs[0], bsdf.inputs["Base Color"])
    return mat


def bake(sculpted, low, name, edge):
    """Cycles bakes colour, normal and roughness onto the game mesh, as ``cliff_outcrop.bake`` does for rocks but with a short
    reach: a building's rays must not start inside the walls and columns beside the surface they are baking."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device, scene.cycles.samples, scene.cycles.use_denoising, scene.cycles.seed = "CPU", 4, False, 0
    mat = bpy.data.materials.new(f"{name}_rock")
    mat.use_nodes = True
    low.data.materials.append(mat)
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    target = tree.nodes.new("ShaderNodeTexImage")
    settings = scene.render.bake
    settings.use_selected_to_active, settings.cage_extrusion, settings.max_ray_distance, settings.margin = True, BAKE_CAGE, BAKE_REACH, 8
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
            settings.use_pass_direct, settings.use_pass_indirect, settings.use_pass_color = False, False, True
        bpy.ops.object.bake(type=kind, normal_space="TANGENT")
        images[label] = image
    tree.nodes.remove(target)
    colour, rough, normal = tree.nodes.new("ShaderNodeTexImage"), tree.nodes.new("ShaderNodeTexImage"), tree.nodes.new("ShaderNodeTexImage")
    colour.image, rough.image, normal.image = images["colour"], images["roughness"], images["normal"]
    tree.links.new(colour.outputs["Color"], bsdf.inputs["Base Color"])
    tree.links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    normal_map = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(normal.outputs["Color"], normal_map.inputs["Color"])
    tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def heal_all(G, image):
    """Fill every empty texel. Surfaces hidden under walls bake nothing, in patches wider than one ``heal`` reaches, and show where a worn edge exposes them."""
    found = G["heal"](image)
    for _ in range(HEAL_ROUNDS):
        if not G["heal"](image):
            break
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
    G = runpy.run_path(inputs["gravestones"])
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    cfg = PIECES[part]
    collection = bpy.context.scene.collection
    name = f"monument_{part}"
    blocks = [(entry, block_mesh(f"{name}_{i}", entry, G)) for i, entry in enumerate(cfg["blocks"])]

    points = np.concatenate([np.array([v.co[:] for v in mesh.vertices]) for _, mesh in blocks])
    shift = Vector((0.0, 0.0, 0.0))
    if cfg.get("recenter", True):
        shift = Vector((-float(points[:, 0].min() + points[:, 0].max()) / 2, -float(points[:, 1].min() + points[:, 1].max()) / 2, 0.0))
    sculpted = G["linked"](f"{name}_sculpt", G["combined"](f"{name}_sculpt", [mesh for _, mesh in blocks], shift), collection)
    sculpted.data.materials.append(shaded_material(f"{name}_sculpt", inputs, cfg["blocks"][0]["seed"], o, G))

    reduced = G["combined"](f"{name}_reduced", [G["decimated"](mesh, entry["triangles"], collection) for entry, mesh in blocks], shift)
    while reduced.uv_layers:
        reduced.uv_layers.remove(reduced.uv_layers[0])
    while reduced.color_attributes:
        reduced.color_attributes.remove(reduced.color_attributes[0])
    reduced_object = G["linked"](f"{name}_reduced", reduced, collection)
    low = o["game_mesh"](reduced_object, o["triangles"](reduced_object), collection)  # already at its target: this unwraps it
    bpy.data.objects.remove(reduced_object)
    low.data.set_sharp_from_angle(angle=SHARP_ANGLE)
    splinters = limestone["drop_splinters"](low)
    limestone["inset_uvs"](low)
    bake(sculpted, low, name, cfg["edge"])
    empty_texels = {label: heal_all(G, bpy.data.images[f"{name}_{label}"]) for label in ("colour", "normal", "roughness")}
    bury = float(-points[:, 2].min())
    names = list(dict.fromkeys(entry["collide"] for entry, _ in blocks if entry["collide"]))  # blocks sharing a name share one box
    proxies = [G["collision"](box_name, [mesh for entry, mesh in blocks if entry["collide"] == box_name], shift) for box_name in names]
    bpy.data.objects.remove(sculpted)
    low.name = low.data.name = name
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO",
        export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    result = {"recipe": RECIPE, "part": part, "triangles": o["triangles"](low), "bakeEdge": cfg["edge"], "bury": round(bury, 3), "fit": {"blocks": len(blocks), "weather": G["WEATHER"]},
              "splinterFaces": splinters, "emptyTexels": empty_texels, **({"collisionProxies": proxies} if proxies else {})}
    if cfg.get("interior"):
        result["interior"] = {"roof": "mausoleum-walk-in-roof", "volume": {
            "center": [0.0, round(ROOM["floor"] + ROOM["height"] / 2, 3), round(-WALK_IN_CENTRE, 3)], "size": [ROOM["width"], ROOM["height"], ROOM["depth"]]}}
    return result
