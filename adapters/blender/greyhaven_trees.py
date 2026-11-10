"""Greyhaven broadleaf trees for mmorpg (docs/greyhaven-trees.md, #568): eight trees of the Greyhaven woods.

Each tree is grown here from a seeded branch skeleton, so every species has its own silhouette:

* the bark is a tube mesh along every branch, with a root flare buried below the ground. Its texture is one cell of a
  generated bark atlas: the catalogued CC0 Quaternius ``Bark_NormalTree`` image turned into a greyscale, tileable
  furrowed cell (oak, alder, dead oak), plus generated smooth beech and white birch cells. ``COLOR_0`` tints it per
  species and darkens the foot;
* the crown follows ``broadleaf_crown.py``: clumps on the branch tips, a metaball union of them as a dark opaque core
  (on the bark atlas's flat white cell, so its colour is ``COLOR_0`` alone), and leaf cards over it, each with the
  core's smoothed normal and a ``COLOR_0`` from deep shade to sunlit top. The leaves are generated, two cells per
  species, with ``woodland_bushes.py``'s leaf painter (the declared input ``bushes``);
* so the whole kit has two materials: the opaque bark atlas and the cut-out leaf atlas.

``level`` picks the level of detail, built from the same skeleton in the same frame. ``1`` keeps a seeded share of the
cards (grown so the crown keeps its coverage) and rebuilds the bark with half the sides and rings and without twigs;
``2`` replaces cards and core with ``nature_lod.py``'s coloured clump hull (the declared input ``lod``) and keeps only
the trunk and limbs, minus what the hull hides. A bare tree's levels only thin its bark.

The arguments are ``piece`` and ``level``. The origin is the trunk's foot on the ground. Blender coordinates are Z up;
the GLB is exported +Y up. Everything is seeded (``random.Random`` and ``numpy.random.RandomState``).
"""
import math
import random
import runpy

import bmesh
import bpy
import numpy
from mathutils import Color, Vector
from mathutils.bvhtree import BVHTree

RECIPE = "greyhaven-trees-v1"
BARK_MATERIAL = "Greyhaven_Trees_Bark"
LEAF_MATERIAL = "Greyhaven_Trees_Leaves"
BARK_ATLAS = 1024  # 2 x 2 cells: furrowed, beech, birch, flat
BARK_CELLS = ("furrowed", "beech", "birch", "flat")
BARK_GUTTER = 16  # pixels around each cell, filled with the cell's own wrapped content
LEAF_ATLAS = (1024, 512)  # 4 x 2 cells of 256 px
LEAF_GUTTER = 10
BURY = 0.3  # metres of trunk below the ground
GOLDEN_ANGLE = 2.39996
TRUNK_UPRIGHT = 0.22  # how hard each trunk segment turns back to vertical, so trunks wander but do not lean over
KEY_LIGHT = Vector((0.35, -0.45, 0.82)).normalized()


def lin(value):
    """A hex sRGB colour as linear RGB."""
    channels = [int(value[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels)


# Per leaf kind: leaves in a cluster, leaf length and width (shares of the cell and of the length) and outline.
LEAVES = {
    "oak": {"count": 30, "length": 0.3, "width": 0.42, "outline": "lobed"},
    "beech": {"count": 34, "length": 0.26, "width": 0.4, "outline": "plain"},
    "birch": {"count": 46, "length": 0.17, "width": 0.5, "outline": "spiked"},
    "alder": {"count": 28, "length": 0.25, "width": 0.62, "outline": "plain"},
}
LEAF_CELLS = [f"{kind}-{n}" for kind in LEAVES for n in (1, 2)]

# Branch levels, from the trunk out. Each child level grows from its parent between ``span`` (shares of its length),
# ``count`` children per parent, at ``angle`` degrees from the parent's direction, ``length`` and ``radius`` as shares
# of the parent's, bending by ``bend`` per segment and curving up (``lift`` > 0) or drooping (< 0). ``sides`` and
# ``segs`` set the tube's resolution at full detail.
def level(count, span, angle, length, radius, bend, lift, sides, segs):
    return {"count": count, "span": span, "angle": angle, "length": length, "radius": radius, "bend": bend, "lift": lift, "sides": sides, "segs": segs}


# Per piece: target height (m), trunk (length, base radius, lean, bend, sides, rings), whether the trunk runs on as a
# leader to the top, child levels, crown (clump radius, card edge, card count, core faces, leaf kind, palette), bark
# cell and tint (sRGB), and the seed.
PIECES = {
    "oak": {
        "height": 12.0, "trunk": (3.4, 0.46, 0.05, 0.12, 12, 6), "leader": False, "seed": 5681,
        "levels": [level(5, (0.86, 1.0), (58, 72), (1.9, 2.2), 0.58, 0.3, 0.14, 9, 6),
                   level(3, (0.35, 1.0), (34, 58), (0.42, 0.55), 0.5, 0.35, 0.18, 6, 3)],
        "crown": {"fill": 22, "along": 0.3, "leaderFrom": 1.0, "clump": 1.55, "card": 1.0, "cards": 1250, "core": 380, "leaf": "oak", "shade": "#1f3d16", "sun": "#7d8f33", "inset": 0.22},
        "bark": ("furrowed", "#6f655a"),
    },
    "oak-young": {
        "height": 7.0, "trunk": (2.0, 0.17, 0.04, 0.15, 9, 5), "leader": False, "seed": 5682,
        "levels": [level(3, (0.85, 1.0), (40, 56), (1.6, 1.9), 0.62, 0.32, 0.15, 7, 5),
                   level(2, (0.4, 1.0), (35, 55), (0.42, 0.55), 0.5, 0.35, 0.2, 5, 3)],
        "crown": {"fill": 7, "along": 0.3, "leaderFrom": 1.0, "clump": 1.0, "card": 0.78, "cards": 620, "core": 220, "leaf": "oak", "shade": "#22421a", "sun": "#82953a", "inset": 0.14},
        "bark": ("furrowed", "#77695b"),
    },
    "beech": {
        "height": 16.0, "trunk": (6.4, 0.4, 0.02, 0.04, 12, 6), "leader": False, "seed": 5683,
        "levels": [level(4, (0.9, 1.0), (22, 34), (1.25, 1.45), 0.62, 0.16, 0.05, 9, 6),
                   level(3, (0.3, 1.0), (30, 50), (0.4, 0.52), 0.5, 0.25, 0.08, 6, 3)],
        "crown": {"fill": 24, "along": 0.35, "leaderFrom": 1.0, "clump": 1.65, "card": 1.0, "cards": 1250, "core": 380, "leaf": "beech", "shade": "#1d4317", "sun": "#86a53a", "inset": 0.22},
        "bark": ("beech", "#8e9089"),
    },
    "beech-young": {
        "height": 8.0, "trunk": (7.4, 0.11, 0.01, 0.05, 8, 7), "leader": True, "seed": 5684,
        "levels": [level(9, (0.18, 0.92), (68, 80), (0.3, 0.4), 0.5, 0.18, 0.04, 5, 3)],
        "crown": {"fill": 6, "along": 0.15, "leaderFrom": 0.2, "clump": 0.95, "card": 0.8, "cards": 560, "core": 200, "leaf": "beech", "shade": "#21481a", "sun": "#8aa83f", "inset": 0.12},
        "bark": ("beech", "#8f928a"),
    },
    "birch": {
        "height": 13.0, "trunk": (12.2, 0.17, 0.03, 0.07, 9, 8), "leader": True, "seed": 5685,
        "levels": [level(15, (0.32, 0.96), (38, 55), (0.13, 0.2), 0.4, 0.22, -0.12, 4, 4)],
        "crown": {"fill": 6, "along": 0.25, "leaderFrom": 0.32, "clump": 0.72, "card": 0.7, "cards": 760, "core": 260, "leaf": "birch", "shade": "#35511c", "sun": "#a7b54c", "inset": 0.2},
        "bark": ("birch", "#ecebe4"),
    },
    "alder": {
        "height": 11.0, "trunk": (10.4, 0.22, 0.015, 0.03, 10, 8), "leader": True, "taper": 0.75, "seed": 5686,
        "levels": [level(13, (0.2, 0.94), (64, 80), (0.24, 0.34), 0.4, 0.15, 0.02, 5, 3)],
        "crown": {"fill": 10, "cone": True, "along": 0.15, "leaderFrom": 0.25, "clump": 1.05, "card": 0.85, "cards": 820, "core": 280, "leaf": "alder", "shade": "#142f14", "sun": "#4c6b2a", "inset": 0.16},
        "bark": ("furrowed", "#4d4a46"),
    },
    "dead-oak": {
        "height": 8.0, "trunk": (4.2, 0.55, 0.06, 0.16, 12, 7), "leader": False, "seed": 5687,
        "levels": [level(4, (0.62, 1.0), (40, 70), (0.7, 0.95), 0.62, 0.34, 0.06, 9, 6),
                   level(2, (0.3, 0.8), (35, 60), (0.25, 0.4), 0.5, 0.4, 0.05, 6, 3)],
        "crown": None, "broken": True,
        "bark": ("furrowed", "#9a948a"),
    },
    "sapling": {
        "height": 2.6, "trunk": (2.3, 0.035, 0.03, 0.12, 6, 5), "leader": True, "seed": 5688,
        "levels": [level(4, (0.35, 0.85), (45, 60), (0.3, 0.38), 0.55, 0.25, 0.15, 4, 2)],
        "crown": {"hull": 60, "fill": 2, "along": 0.2, "leaderFrom": 0.35, "clump": 0.36, "card": 0.42, "cards": 110, "core": 60, "leaf": "beech", "shade": "#2a5320", "sun": "#94b04a", "inset": 0.05},
        "bark": ("beech", "#7a6f62"),
    },
}
# Level of detail: share of card kept, share of tube sides and rings, and the thinnest branch kept (m radius).
LOD1 = {"keep": 0.3, "grow": 0.92, "sides": 0.5, "rings": 0.5, "minRadius": 0.045}
LOD2 = {"sides": 0.4, "maxLevel": 1, "hull": {"inflate": 1.0, "fit": 0.9, "hullTriangles": 260, "neighbours": 8, "coreShare": 0.4, "gain": 0.85, "underside": 0.6}}
BARE_LODS = {1: {"sides": 0.5, "rings": 0.5, "minRadius": 0.06}, 2: {"sides": 0.34, "rings": 0.34, "minRadius": 0.12}}
COLLISION_SIDES = 8
COLLISION_TOP = 3.0  # metres: the trunk's collision tube stops here or at the first fork


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "piece", "level"} or p["schemaVersion"] != 1:
        raise ValueError("greyhaven trees require exactly schemaVersion 1, piece and level")
    if p["piece"] not in PIECES or p["level"] not in (0, 1, 2):
        raise ValueError(f"greyhaven trees: piece in {sorted(PIECES)}, level 0, 1 or 2")
    if set(inputs) != {"bark", "bushes", "lod"}:
        raise ValueError("greyhaven trees take exactly the declared inputs bark, bushes and lod")


# ----------------------------------------------------------------------------------------------------------- skeleton


def perpendicular(d):
    p = d.cross(Vector((0, 0, 1)))
    if p.length < 1e-4:
        p = d.cross(Vector((1, 0, 0)))
    return p.normalized()


def grow(start, direction, length, radius, tip, segs, bend, lift, rng):
    """A branch polyline: points and radii from ``start`` along ``direction``, bending and lifting per segment."""
    points, radii = [start.copy()], [radius]
    d = direction.normalized()
    step = length / segs
    for i in range(1, segs + 1):
        wobble = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        d = (d + wobble * bend + Vector((0, 0, lift))).normalized()
        points.append(points[-1] + d * step)
        t = i / segs
        radii.append(radius + (tip - radius) * t ** 0.8)
    return {"points": points, "radii": radii}


def skeleton(spec, rng):
    """Every branch of the tree, trunk first, each with its level and tube resolution."""
    length, radius, lean, bend, sides, segs = spec["trunk"]
    angle = rng.uniform(0, math.tau)
    direction = Vector((math.cos(angle) * lean, math.sin(angle) * lean, 1))
    tip = radius * (0.12 if spec["leader"] else 0.55)
    trunk = grow(Vector((0, 0, -BURY)), direction, length + BURY, radius, tip, segs, bend, TRUNK_UPRIGHT, rng)
    trunk.update(level=0, sides=sides, broken=bool(spec.get("broken")))
    branches, parents = [trunk], [trunk]
    for depth, lv in enumerate(spec["levels"], start=1):
        children = []
        for parent in parents:
            count = lv["count"]
            phase = rng.uniform(0, math.tau)
            pts, rad = parent["points"], parent["radii"]
            plen = sum((pts[i + 1] - pts[i]).length for i in range(len(pts) - 1))
            for c in range(count):
                share = lv["span"][0] + (lv["span"][1] - lv["span"][0]) * ((c + 0.5) / count if count > 1 else 1.0)
                share = min(1.0, max(0.0, share + rng.uniform(-0.04, 0.04)))
                f = share * (len(pts) - 1)
                i = min(len(pts) - 2, int(f))
                at = pts[i].lerp(pts[i + 1], f - i)
                pr = rad[i] + (rad[i + 1] - rad[i]) * (f - i)
                axis = (pts[i + 1] - pts[i]).normalized()
                around = phase + c * GOLDEN_ANGLE + rng.uniform(-0.3, 0.3)
                p1 = perpendicular(axis)
                p2 = axis.cross(p1)
                side = p1 * math.cos(around) + p2 * math.sin(around)
                a = math.radians(rng.uniform(*lv["angle"]))
                d = axis * math.cos(a) + side * math.sin(a)
                base_len = plen if depth == 1 else plen
                clen = base_len * rng.uniform(*lv["length"]) * (1.0 - spec.get("taper", 0.35) * share if spec["leader"] and depth == 1 else 1.0)
                cr = pr * lv["radius"]
                child = grow(at, d, clen, cr, cr * 0.2, lv["segs"], lv["bend"], lv["lift"], rng)
                child.update(level=depth, sides=lv["sides"], broken=False)
                if spec.get("broken"):
                    # A snag: every limb snaps off short, leaving a blunt jagged end that its own children grow from.
                    keep = max(2, round(len(child["points"]) * rng.uniform(0.55, 0.85)))
                    child["points"], child["radii"] = child["points"][:keep], child["radii"][:keep]
                    child["broken"] = depth == 1
                children.append(child)
        branches += children
        parents = children
    return branches


def scale_tree(branches, clumps, factor):
    for b in branches:
        b["points"] = [Vector((p.x * factor, p.y * factor, (p.z + BURY) * factor - BURY)) for p in b["points"]]
        b["radii"] = [r * factor for r in b["radii"]]
    return [(Vector((c.x * factor, c.y * factor, (c.z + BURY) * factor - BURY)), r * factor, t) for c, r, t in clumps]


def crown_clumps(spec, branches, rng):
    """Clump centres, radii and tints on every outermost branch tip, plus a heart clump on each limb."""
    crown = spec["crown"]
    top_level = max(b["level"] for b in branches)
    result = []
    for b in branches:
        leafy = b["level"] >= max(1, top_level - 1) or (spec["leader"] and b["level"] == 0)
        if not leafy:
            continue
        # Clumps along the outer part of every leafy branch, growing towards its tip, so the crown is one mass that
        # follows the branching instead of separate balls.
        start = crown["along"] if b["level"] else crown["leaderFrom"]
        pts = b["points"]
        for i in range(1, len(pts)):
            share = i / (len(pts) - 1)
            if share < start:
                continue
            grow_t = (share - start) / max(1e-6, 1 - start)
            radius = crown["clump"] * (0.75 + 0.3 * grow_t) * rng.uniform(0.85, 1.15)
            at = pts[i]
            if i == len(pts) - 1:
                at = at + (pts[i] - pts[i - 1]).normalized() * crown["clump"] * 0.25
            result.append((at, radius, rng.uniform(-1, 1)))
    # Fill the crown's inside: clumps scattered in the envelope of the branch clumps (an ellipsoid, or a cone that
    # narrows to the top), so the outline stays lobed but no gaps open between the branches.
    lo = [min(c[k] for c, _r, _t in result) for k in range(3)]
    hi = [max(c[k] for c, _r, _t in result) for k in range(3)]
    mid = Vector([(lo[k] + hi[k]) / 2 for k in range(3)])
    half = Vector([max(0.3, (hi[k] - lo[k]) / 2) * 0.8 for k in range(3)])
    added = 0
    while added < crown["fill"]:
        p = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        if crown.get("cone"):
            # Wide at the base, a point at the top.
            reach = 1.0 - (p.z + 1) / 2
            if p.xy.length > reach:
                continue
        elif p.length > 1:
            continue
        at = Vector((mid.x + p.x * half.x, mid.y + p.y * half.y, mid.z + p.z * half.z))
        result.append((at, crown["clump"] * rng.uniform(1.15, 1.4), rng.uniform(-1, 1)))
        added += 1
    return result


# ------------------------------------------------------------------------------------------------------------- bark


def bark_cell_uv(cell, u, v):
    """Map ``u``, ``v`` in 0..1 into the named bark cell, inside its gutter."""
    index = BARK_CELLS.index(cell)
    row, col = divmod(index, 2)
    size = BARK_ATLAS / 2
    inner = (size - 2 * BARK_GUTTER) / BARK_ATLAS
    x0 = (col * size + BARK_GUTTER) / BARK_ATLAS
    y0 = (row * size + BARK_GUTTER) / BARK_ATLAS
    return (x0 + u * inner, y0 + v * inner)


def tube(branch, sides, ring_share, cell, tint, rng, buffers, flare):
    """Append one branch's tube to ``buffers``; faces never cross a texture repeat, so each stays inside its cell."""
    verts, faces, uvs, colours = buffers
    pts, rad = branch["points"], branch["radii"]
    # Fewer rings for far levels: keep every n-th point and the last.
    n = max(1, round(1 / ring_share))
    keep = list(range(0, len(pts), n))
    if keep[-1] != len(pts) - 1:
        keep.append(len(pts) - 1)
    pts, rad = [pts[i] for i in keep], [rad[i] for i in keep]
    circumference = max(0.25, math.tau * rad[0])
    s_total, s = [0.0], 0.0
    for i in range(1, len(pts)):
        s += (pts[i] - pts[i - 1]).length
        s_total.append(s)
    frames = []
    normal = perpendicular((pts[1] - pts[0]).normalized())
    for i in range(len(pts)):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        normal = (normal - d * normal.dot(d)).normalized()
        frames.append((d, normal, d.cross(normal)))
    u_span = min(1.0, circumference / max(0.25, math.tau * branch["radii"][0])) if branch["level"] else 1.0
    lobes = flare and branch["level"] == 0
    rings = []
    for i, (p, r, (d, n1, n2)) in enumerate(zip(pts, rad, frames)):
        ring = []
        for k in range(sides):
            a = math.tau * k / sides
            rr = r
            if lobes:
                # Root flare: wider and lobed at the foot, fading out by 1.2 m up.
                fade = max(0.0, 1.0 - (p.z + BURY) / (1.2 + BURY))
                rr = r * (1.0 + 0.55 * fade ** 2 * (0.75 + 0.25 * math.cos(5 * a + 0.7)))
            ring.append(len(verts))
            verts.append(p + (n1 * math.cos(a) + n2 * math.sin(a)) * rr)
        rings.append(ring)
    v_of = [st / circumference for st in s_total]
    def shade(z):
        foot = max(0.0, min(1.0, (z + BURY) / 1.6))
        return tuple(c * (0.55 + 0.45 * foot) for c in tint)
    for i in range(len(rings) - 1):
        base = math.floor(v_of[i] + 1e-6)
        v0, v1 = v_of[i] - base, v_of[i + 1] - base
        if v1 > 1.0:
            # Squeeze a segment that would cross a repeat into the cell: a slight stretch, no seam out of the cell.
            v0, v1 = max(0.0, 1.0 - (v_of[i + 1] - v_of[i])), 1.0
        for k in range(sides):
            k2 = (k + 1) % sides
            u0, u1 = k / sides * u_span, (k + 1) / sides * u_span
            face = (rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k])
            faces.append(face)
            uvs.append([bark_cell_uv(cell, u0, v0), bark_cell_uv(cell, u1, v0), bark_cell_uv(cell, u1, v1), bark_cell_uv(cell, u0, v1)])
            colours.append([shade(verts[j].z) for j in face])
    # Close the end: a point for a living tip, a jagged flat break for a snag.
    last = rings[-1]
    centre = pts[-1] + frames[-1][0] * (rad[-1] * (0.4 if not branch["broken"] else 0.0))
    ci = len(verts)
    verts.append(centre)
    for k in range(sides):
        if branch["broken"]:
            v = verts[last[k]]
            verts[last[k]] = v + frames[-1][0] * rad[-1] * rng.uniform(-0.6, 0.9)
        k2 = (k + 1) % sides
        faces.append((last[k], last[k2], ci))
        uvs.append([bark_cell_uv(cell, k / sides * u_span, 0.9), bark_cell_uv(cell, (k + 1) / sides * u_span, 0.9), bark_cell_uv(cell, (k + 0.5) / sides * u_span, 1.0)])
        colours.append([shade(verts[j].z) for j in (last[k], last[k2], ci)])


def bark_mesh(spec, branches, sides_share, ring_share, min_radius, max_level, rng):
    cell, tint_hex = spec["bark"]
    tint = lin(tint_hex)
    buffers = ([], [], [], [])
    for b in branches:
        if b["level"] > max_level or (b["level"] and b["radii"][0] < min_radius):
            continue
        sides = max(3, round(b["sides"] * sides_share))
        tube(b, sides, ring_share, cell, tint, rng, buffers, flare=True)
    verts, faces, uvs, colours = buffers
    mesh = bpy.data.meshes.new("bark")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    uv = mesh.uv_layers.new(name="UVMap")
    col = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for poly, fuv, fcol in zip(mesh.polygons, uvs, colours):
        poly.use_smooth = True
        for li, puv, pcol in zip(poly.loop_indices, fuv, fcol):
            uv.data[li].uv = puv
            col.data[li].color = (*pcol, 1.0)
    return mesh


def collision_mesh(branches):
    """The trunk as a closed, outward-wound tube up to its first fork (or COLLISION_TOP), in glTF coordinates."""
    trunk = branches[0]
    forks = [b["points"][0].z for b in branches if b["level"] == 1]
    top = min([COLLISION_TOP, trunk["points"][-1].z] + [z for z in forks if z > 1.0])
    rings = []
    for p, r in zip(trunk["points"], trunk["radii"]):
        if p.z <= top:
            rings.append((p, r))
    if rings[-1][0].z < top - 0.05:
        i = len(rings) - 1
        a, b = trunk["points"][i], trunk["points"][i + 1]
        t = (top - a.z) / max(1e-6, b.z - a.z)
        rings.append((a.lerp(b, t), trunk["radii"][i] + (trunk["radii"][i + 1] - trunk["radii"][i]) * t))
    rings[0] = (Vector((rings[0][0].x, rings[0][0].y, -BURY)), rings[0][1] * 1.3)
    verts = []
    for p, r in rings:
        for k in range(COLLISION_SIDES):
            a = math.tau * k / COLLISION_SIDES
            verts.append((p.x + math.cos(a) * r, p.y + math.sin(a) * r, p.z))
    tris = []
    for i in range(len(rings) - 1):
        for k in range(COLLISION_SIDES):
            a, b = i * COLLISION_SIDES + k, i * COLLISION_SIDES + (k + 1) % COLLISION_SIDES
            c, d = a + COLLISION_SIDES, b + COLLISION_SIDES
            tris += [[a, b, d], [a, d, c]]
    bottom, top_i = len(verts), len(verts) + 1
    verts.append((rings[0][0].x, rings[0][0].y, rings[0][0].z))
    verts.append((rings[-1][0].x, rings[-1][0].y, rings[-1][0].z))
    last = (len(rings) - 1) * COLLISION_SIDES
    for k in range(COLLISION_SIDES):
        k2 = (k + 1) % COLLISION_SIDES
        tris.append([bottom, k2, k])
        tris.append([top_i, last + k, last + k2])
    return {"shape": "triangle-mesh", "vertices": [[round(x, 3), round(z, 3), round(-y, 3)] for x, y, z in verts], "triangles": tris}


# --------------------------------------------------------------------------------------------------------- textures


def periodic_noise(size, scale, rng):
    """Tileable smooth noise in 0..1: random phases filtered in frequency space."""
    spectrum = rng.normal(size=(size, size)) + 1j * rng.normal(size=(size, size))
    fy = numpy.fft.fftfreq(size)[:, None]
    fx = numpy.fft.fftfreq(size)[None, :]
    falloff = numpy.exp(-((fx * scale[0]) ** 2 + (fy * scale[1]) ** 2))
    field = numpy.real(numpy.fft.ifft2(spectrum * falloff))
    field -= field.min()
    return field / max(1e-6, field.max())


def furrowed_cell(path, size):
    """The source bark as a tileable greyscale cell, normalised to a mean of 0.75 so COLOR_0 sets the colour."""
    image = bpy.data.images.load(path, check_existing=False)
    if image.size[0] != image.size[1]:
        raise ValueError("bark source must be square")
    image.scale(size, size)
    px = numpy.empty(size * size * 4, dtype=numpy.float32)
    image.pixels.foreach_get(px)
    px = px.reshape(size, size, 4)
    grey = px[:, :, :3] @ numpy.array([0.2126, 0.7152, 0.0722], dtype=numpy.float32)
    grey = grey / max(1e-6, float(grey.mean()))
    bpy.data.images.remove(image)
    # Deepen the furrows a little: the source is soft for a stylised look.
    return numpy.clip(0.75 * grey ** 1.6, 0, 1)


def beech_cell(size, rng):
    """Smooth grey beech bark: soft mottling, faint horizontal rings and a few dark eye scars."""
    mottle = periodic_noise(size, (40, 25), rng)
    fine = periodic_noise(size, (6, 12), rng)
    grey = 0.86 + 0.12 * (mottle - 0.5) + 0.05 * (fine - 0.5)
    y = numpy.arange(size)[:, None] / size
    grey = grey - 0.025 * (numpy.sin(y * math.tau * 9) > 0.92)
    yy, xx = numpy.mgrid[0:size, 0:size] / size
    for _ in range(3):
        cx, cy = rng.uniform(0, 1, 2)
        dx = (xx - cx + 0.5) % 1 - 0.5
        dy = (yy - cy + 0.5) % 1 - 0.5
        eye = (dx / 0.05) ** 2 + (dy / 0.02) ** 2
        grey = numpy.where(eye < 1, grey * (0.55 + 0.4 * eye), grey)
    return numpy.clip(grey, 0, 1)


def birch_cell(size, rng):
    """White birch bark: horizontal dark lenticel dashes and a few black patches, all tiling."""
    grey = 0.93 + 0.06 * (periodic_noise(size, (30, 30), rng) - 0.5)
    yy, xx = numpy.mgrid[0:size, 0:size] / size
    for _ in range(70):
        cx, cy = rng.uniform(0, 1, 2)
        w, h = rng.uniform(0.04, 0.16), rng.uniform(0.004, 0.009)
        dx = (xx - cx + 0.5) % 1 - 0.5
        dy = (yy - cy + 0.5) % 1 - 0.5
        mask = (dx / w) ** 2 + (dy / h) ** 2 < 1
        grey = numpy.where(mask, 0.18 + 0.15 * rng.uniform(), grey)
    for _ in range(4):
        cx, cy = rng.uniform(0, 1, 2)
        w, h = rng.uniform(0.08, 0.18), rng.uniform(0.04, 0.09)
        dx = (xx - cx + 0.5) % 1 - 0.5
        dy = (yy - cy + 0.5) % 1 - 0.5
        mask = numpy.abs(dx / w) + numpy.abs(dy / h) < 1
        grey = numpy.where(mask, 0.12, grey)
    return numpy.clip(grey, 0, 1)


def bark_atlas(bark_path):
    """The opaque atlas: four greyscale cells, each wrapped into its gutter so mips never bleed across cells."""
    size = BARK_ATLAS // 2
    inner = size - 2 * BARK_GUTTER
    rng = numpy.random.RandomState(5680)
    cells = {
        "furrowed": furrowed_cell(bark_path, inner),
        "beech": beech_cell(inner, rng),
        "birch": birch_cell(inner, rng),
        "flat": numpy.ones((inner, inner), dtype=numpy.float32),
    }
    pixels = numpy.ones((BARK_ATLAS, BARK_ATLAS, 4), dtype=numpy.float32)
    for index, name in enumerate(BARK_CELLS):
        row, col = divmod(index, 2)
        tile = numpy.pad(cells[name], BARK_GUTTER, mode="wrap")
        pixels[row * size:(row + 1) * size, col * size:(col + 1) * size, :3] = tile[:, :, None]
    image = bpy.data.images.new("greyhaven-trees-bark", BARK_ATLAS, BARK_ATLAS, alpha=False)
    image.pixels.foreach_set(pixels.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def leaf_atlas(paint_leaves):
    width, height = LEAF_ATLAS
    size = width // 4
    inner = size - 2 * LEAF_GUTTER
    pixels = numpy.zeros((height, width, 4), dtype=numpy.float32)
    pixels[:, :, :3] = 0.85
    for index, name in enumerate(LEAF_CELLS):
        row, col = divmod(index, 4)
        tone = numpy.full((inner, inner), 0.85, dtype=numpy.float32)
        alpha = numpy.zeros((inner, inner), dtype=numpy.float32)
        paint_leaves(tone, alpha, LEAVES[name.rsplit("-", 1)[0]], numpy.random.RandomState(5690 + index))
        y, x = row * size + LEAF_GUTTER, col * size + LEAF_GUTTER
        pixels[y:y + inner, x:x + inner, :3] = (0.55 + 0.45 * tone)[:, :, None]
        pixels[y:y + inner, x:x + inner, 3] = alpha
    image = bpy.data.images.new("greyhaven-trees-leaves", width, height, alpha=True)
    image.pixels.foreach_set(pixels.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def leaf_cell_uvs(name):
    row, col = divmod(LEAF_CELLS.index(name), 4)
    return [((col + du) / 4, (row + dv) / 2) for du, dv in ((0, 0), (1, 0), (1, 1), (0, 1))]


def leaf_material(image):
    """The greyscale leaf atlas times COLOR_0; Round(alpha) exports as glTF alphaMode MASK."""
    mat = bark_material(image, LEAF_MATERIAL)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    tex = next(n for n in nodes if n.type == "TEX_IMAGE")
    rnd = nodes.new("ShaderNodeMath")
    rnd.operation = "ROUND"
    links.new(tex.outputs["Alpha"], rnd.inputs[0])
    links.new(rnd.outputs[0], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.9
    mat.use_backface_culling = False
    return mat


def bark_material(image, name=BARK_MATERIAL):
    mat = bpy.data.materials.new(name)
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
    bsdf.inputs["Roughness"].default_value = 0.92
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.use_backface_culling = True
    return mat


# -------------------------------------------------------------------------------------------------------------- crown


def core_mesh(centres, collection, faces, resolution):
    meta = bpy.data.metaballs.new("crown_meta")
    meta.resolution = meta.render_resolution = resolution
    meta.threshold = 0.6
    for centre, radius, _tint in centres:
        element = meta.elements.new()
        element.co = centre
        element.radius = radius * 1.25
        element.type = "ELLIPSOID"
        element.size_x = element.size_y = 1.0
        element.size_z = 0.85
    ball = bpy.data.objects.new("crown_meta", meta)
    collection.objects.link(ball)
    bpy.context.view_layer.update()
    mesh = bpy.data.meshes.new_from_object(ball.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(ball)
    bpy.data.metaballs.remove(meta)
    core = bpy.data.objects.new("crown_core", mesh)
    collection.objects.link(core)
    decimate = core.modifiers.new("decimate", "DECIMATE")
    decimate.ratio = min(1.0, faces / max(1, len(mesh.polygons)))
    decimate.use_collapse_triangulate = True
    with bpy.context.temp_override(object=core, active_object=core):
        bpy.ops.object.modifier_apply(modifier=decimate.name)
    for polygon in core.data.polygons:
        polygon.use_smooth = True
    return core


def sample_surface(core, count, rng):
    mesh = core.data
    mesh.calc_loop_triangles()
    tris, total = [], 0.0
    for tri in mesh.loop_triangles:
        total += tri.area
        tris.append((total, tri))
    out = []
    for _ in range(count):
        pick = rng.random() * total
        lo, hi = 0, len(tris) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if tris[mid][0] < pick:
                lo = mid + 1
            else:
                hi = mid
        tri = tris[lo][1]
        a, b = rng.random(), rng.random()
        if a + b > 1:
            a, b = 1 - a, 1 - b
        v = [mesh.vertices[i] for i in tri.vertices]
        point = v[0].co * (1 - a - b) + v[1].co * a + v[2].co * b
        normal = (v[0].normal * (1 - a - b) + v[1].normal * a + v[2].normal * b).normalized()
        out.append((point, normal))
    return out


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def build_crown(spec, clumps, rng, collection, material, leaf_mat):
    crown = spec["crown"]
    shade, sun = lin(crown["shade"]), lin(crown["sun"])
    resolution = max(0.08, crown["clump"] * 0.12)
    core = core_mesh(clumps, collection, crown["core"], resolution)
    zs = [v.co.z for v in core.data.vertices]
    zmin, zmax = min(zs), max(zs)
    centre = sum((c for c, _r, _t in clumps), Vector()) / len(clumps)
    samples = sample_surface(core, crown["cards"], rng)
    for v in core.data.vertices:
        v.co = v.co - v.normal * crown["inset"]
    layer = core.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for loop in core.data.loops:
        t = max(0.0, min(1.0, (core.data.vertices[loop.vertex_index].co.z - zmin) / max(1e-6, zmax - zmin)))
        layer.data[loop.index].color = (*mix(tuple(c * 0.55 for c in shade), shade, 0.6 * t), 1.0)
    # The core's UVs all sit in the bark atlas's flat white cell.
    flat = bark_cell_uv("flat", 0.5, 0.5)
    uv = core.data.uv_layers.new(name="UVMap")
    for item in uv.data:
        item.uv = flat
    core.data.materials.append(material)

    verts, faces, normals, colours, uvs = [], [], [], [], []
    leaf = crown["leaf"]
    for point, normal in samples:
        size = crown["card"] * rng.uniform(0.82, 1.15)
        offset = crown["card"] * (-0.05 + 0.22 * rng.random())
        c = point + normal * offset
        jitter = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        facing = (normal + jitter * 0.55 + Vector((0, 0, 0.25))).normalized()
        tangent = facing.cross(Vector((0, 0, 1)))
        if tangent.length < 1e-3:
            tangent = Vector((1, 0, 0))
        tangent.normalize()
        bitangent = facing.cross(tangent).normalized()
        roll = rng.uniform(0, math.tau)
        u = tangent * math.cos(roll) + bitangent * math.sin(roll)
        w = facing.cross(u).normalized()
        half = size / 2
        base = len(verts)
        cell = leaf_cell_uvs(f"{leaf}-{rng.randint(1, 2)}")
        for (su, sv), cuv in zip(((-1, -1), (1, -1), (1, 1), (-1, 1)), cell):
            corner = c + u * (su * half) + w * (sv * half)
            verts.append(corner)
            radial = corner - centre
            radial.z *= 0.7
            normals.append((normal * 0.65 + radial.normalized() * 0.35).normalized())
            uvs.append(cuv)
        faces.append((base, base + 1, base + 2, base + 3))
        t = max(0.0, min(1.0, (c.z - zmin) / max(1e-6, zmax - zmin)))
        lit = max(0.0, normal.dot(KEY_LIGHT))
        up, down = max(0.0, normal.z), max(0.0, -normal.z)
        _, _, tint = min(clumps, key=lambda item: (item[0] - c).length / item[1])
        tone = 0.1 + 0.35 * t * t + 0.2 * lit + 0.22 * up - 0.35 * down + 0.6 * max(0.0, offset / crown["card"]) + 0.1 * tint
        tone = max(0.0, min(1.0, tone + rng.uniform(-0.1, 0.1)))
        hsv = Color(mix(shade, sun, tone))
        hsv.h = (hsv.h + 0.015 * tint + rng.uniform(-0.015, 0.015)) % 1.0
        hsv.v *= rng.uniform(0.9, 1.08)
        colours.append((hsv.r, hsv.g, hsv.b))
    mesh = bpy.data.meshes.new("crown_leaves")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    uv_layer = mesh.uv_layers.new(name="UVMap")
    col = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for poly, rgb in zip(mesh.polygons, colours):
        poly.use_smooth = True
        for li in poly.loop_indices:
            uv_layer.data[li].uv = uvs[mesh.loops[li].vertex_index]
            col.data[li].color = (*rgb, 1.0)
    mesh.normals_split_custom_set_from_vertices([tuple(n) for n in normals])
    mesh.materials.append(leaf_mat)
    leaves = bpy.data.objects.new("crown_leaves", mesh)
    collection.objects.link(leaves)
    return core, leaves


# -------------------------------------------------------------------------------------------------------------- build


def triangles(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def build(piece, lod_level, collection, inputs):
    """Build one piece at one level into ``collection``; return its objects (bark first) and observations."""
    spec = PIECES[piece]
    rng = random.Random(spec["seed"])
    branches = skeleton(spec, rng)
    clumps = crown_clumps(spec, branches, rng) if spec["crown"] else []
    # Fit the tree to its height: the crown's top (clumps plus a card's overhang) or the snag's tallest point.
    if clumps:
        top = max(c.z + r * 1.05 for c, r, _t in clumps) + spec["crown"]["card"] * 0.3
    else:
        top = max(p.z for b in branches for p in b["points"])
    clumps = scale_tree(branches, clumps, (spec["height"] + BURY) / (top + BURY))
    bark_mat = bark_material(bark_atlas(inputs["bark"]))
    observations = {"recipe": RECIPE, "piece": piece, "level": lod_level, "seed": spec["seed"], "branches": len(branches)}
    if lod_level == 0:
        bark = bark_mesh(spec, branches, 1.0, 1.0, 0.0, 99, random.Random(spec["seed"] + 1))
    elif not spec["crown"]:
        p = BARE_LODS[lod_level]
        bark = bark_mesh(spec, branches, p["sides"], p["rings"], p["minRadius"], 99, random.Random(spec["seed"] + 1))
    elif lod_level == 1:
        bark = bark_mesh(spec, branches, LOD1["sides"], LOD1["rings"], LOD1["minRadius"], 99, random.Random(spec["seed"] + 1))
    else:
        bark = bark_mesh(spec, branches, LOD2["sides"], 0.5, 0.0, LOD2["maxLevel"], random.Random(spec["seed"] + 1))
    bark.materials.append(bark_mat)
    bark_obj = bpy.data.objects.new(piece, bark)
    collection.objects.link(bark_obj)
    objects = [bark_obj]
    if spec["crown"]:
        bushes = runpy.run_path(inputs["bushes"])
        leaf_mat = leaf_material(leaf_atlas(bushes["paint_leaves"]))
        core, leaves = build_crown(spec, clumps, random.Random(spec["seed"] + 2), collection, bark_mat, leaf_mat)
        observations.update(coreTriangles=triangles(core), cardsBefore=len(leaves.data.polygons))
        if lod_level == 0:
            objects += [core, leaves]
        else:
            lod = runpy.run_path(inputs["lod"])
            cards = lod["read_cards"](leaves)
            if lod_level == 1:
                keep_rng = random.Random(spec["seed"] + 3)
                kept = [card for card in cards if keep_rng.random() < LOD1["keep"]]
                lod["write_cards"](leaves, kept, LOD1["grow"] / math.sqrt(LOD1["keep"]))
                observations["cardsAfter"] = len(kept)
                objects += [core, leaves]
            else:
                grey = lod["card_grey"](leaves)
                hull = dict(LOD2["hull"], hullTriangles=spec["crown"].get("hull", LOD2["hull"]["hullTriangles"]))
                shell = lod["inflated_core"](cards, core, hull, collection)
                lod["colour_hull"](shell, cards, core, hull, grey)
                observations["hullTriangles"] = triangles(shell)
                # Bark wholly inside the hull is never seen.
                bm = bmesh.new()
                bm.from_mesh(shell.data)
                bvh = BVHTree.FromBMesh(bm)
                bm.free()
                bm = bmesh.new()
                bm.from_mesh(bark)
                hidden = [f for f in bm.faces if all(lod["inside"](bvh, v.co) for v in f.verts)]
                bmesh.ops.delete(bm, geom=hidden, context="FACES")
                bm.to_mesh(bark)
                bm.free()
                for gone in (leaves, core):
                    bpy.data.objects.remove(gone)
                objects.append(shell)
    observations["barkTriangles"] = triangles(bark_obj)
    if lod_level == 0:
        observations["collisionMesh"] = collision_mesh(branches)
    return objects, observations


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    piece, lod_level = arguments["piece"], arguments["level"]
    objects, observations = build(piece, lod_level, bpy.context.scene.collection, inputs)
    result = objects[0]
    if len(objects) > 1:
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = result
        with bpy.context.temp_override(active_object=result, selected_editable_objects=objects):
            bpy.ops.object.join()
    result.name = piece
    colours = result.data.color_attributes
    colours.active_color = colours["Col"]
    colours.render_color_index = colours.active_color_index
    observations["triangles"] = triangles(result)
    bpy.ops.object.select_all(action="DESELECT")
    result.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False, export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return observations
