"""Greyhaven Outpost inn, an original scripted building for the existing pinned Blender script backend.

One run builds one part of the inn (#272, docs/greyhaven-inn.md). The style rules are
docs/style-humanlike.md: factor-only PBR materials, no textures or UVs, bevelled timber.

Frame, shared by every part: metres, glTF right-handed +Y up, origin at the footprint's base
centre, front (the door wall) facing +Z. The footprint is 14 x 10 m and the ridge is at most
6 m high, the Outpost inn collider of mmorpg (id 101).

Parts:
- ``shell``: walls with the doorway and windows, timber framing, the floor and the threshold, plus
  an empty node ``door.hinge`` where the door's hinge sits when it is closed;
- ``ceiling``: the interior ceiling and its beams, hideable for interior views;
- ``roof``: the roof slopes, gables and ridge, hideable for interior views;
- ``door``: the door leaf with its hinge axis on the origin (+Y), closed along +X, and an empty
  node ``hinge`` at the origin;
- ``furniture``: the bar counter, back shelf, tables, chairs, stools, barrels and hearth, one named
  node per item;
- ``collision``: one axis-aligned box per collider, named ``collider.<tag>.<name>`` with the tags
  ``wall``, ``floor``, ``door`` (in the door's own frame) and ``furniture``.

Geometry is authored in glTF axes and converted to Blender's Z-up once (``to_blender``). No
randomness is used.
"""
import hashlib
import math

import bmesh
import bpy

PARTS = ("shell", "ceiling", "roof", "door", "furniture", "collision")
MATERIALS = {
    # name: (linear base colour, metallic, roughness)
    "plaster": ((.62, .57, .48), 0.0, .9),
    "stone": ((.24, .23, .22), 0.0, .88),
    "timber": ((.13, .08, .045), 0.0, .78),
    "floorboard": ((.25, .16, .09), 0.0, .74),
    "wood": ((.34, .22, .12), 0.0, .76),
    "shingle": ((.16, .12, .1), 0.0, .82),
    "iron": ((.29, .28, .27), 1.0, .48),
    "glass": ((.05, .07, .08), 0.0, .2),
    "soot": ((.02, .02, .02), 0.0, .95),
    "collider": ((.8, .1, .6), 0.0, 1.0),
}
SHARP_ANGLE = math.radians(35)

# Layout (metres). Outer wall faces at x = +/-HX and z = +/-HZ.
HX, HZ, T = 6.8, 4.8, .3
IX, IZ = HX - T, HZ - T
WALL_H, STONE_H = 3.2, .5
CEILING_Y, CEILING_T = 3.0, .08
FLOOR_T = .02
RIDGE_Y, EAVE_OUT = 6.0, .2
DOOR = {"x0": -.6, "x1": .6, "height": 2.2}
WINDOW = {"width": 1.0, "sill": 1.0, "head": 2.1}
WINDOWS = {"front": [-3.8, 3.8], "back": [-3.8, .6], "left": [1.6], "right": [1.0]}
LEAF = {"width": 1.18, "height": 2.17, "thickness": .06, "gap": .01}


def to_blender(point):
    x, y, z = point
    return (x, -z, y)


def chamfer_rect(u, v, c):
    return [(u, -v + c), (u, v - c), (u - c, v), (-u + c, v), (-u, v - c), (-u, -v + c), (-u + c, -v), (u - c, -v)]


class Builder:
    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.points = []
        self.materials = []

    def slot(self, material):
        if material not in self.materials:
            self.materials.append(material)
        return self.materials.index(material)

    def vert(self, point):
        self.points.append(point)
        return self.bm.verts.new(to_blender(point))

    def face(self, verts, material):
        self.bm.faces.new(verts).material_index = self.slot(material)

    def box(self, lo, hi, material):
        x0, y0, z0 = lo
        x1, y1, z1 = hi
        if not (x1 > x0 and y1 > y0 and z1 > z0):
            return
        v = [self.vert(p) for p in [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]]
        for quad in [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (0, 4, 7, 3)]:
            self.face([v[i] for i in quad], material)

    def beam(self, lo, hi, material, chamfer=.015):
        """A box whose four edges along its longest axis are chamfered."""
        size = [hi[i] - lo[i] for i in range(3)]
        axis = size.index(max(size))
        u_axis, v_axis = [i for i in range(3) if i != axis]
        cu, cv = (lo[u_axis] + hi[u_axis]) / 2, (lo[v_axis] + hi[v_axis]) / 2
        c = min(chamfer, size[u_axis] / 3, size[v_axis] / 3)
        rings = []
        for along in (lo[axis], hi[axis]):
            ring = []
            for u, v in chamfer_rect(size[u_axis] / 2, size[v_axis] / 2, c):
                point = [0.0, 0.0, 0.0]
                point[axis], point[u_axis], point[v_axis] = along, cu + u, cv + v
                ring.append(tuple(point))
            rings.append([self.vert(p) for p in ring])
        a, b = rings
        for i in range(8):
            j = (i + 1) % 8
            self.face([a[i], a[j], b[j], b[i]], material)
        self.face(list(reversed(a)), material)
        self.face(b, material)

    def cylinder(self, centre, radius, y0, y1, material, segments=12, bulge=0.0):
        """A vertical lathe; ``bulge`` widens the middle (barrels)."""
        rows = [0, .2, .5, .8, 1] if bulge else [0, 1]
        rings = []
        for t in rows:
            r = radius * (1 + bulge * math.sin(math.pi * t))
            y = y0 + (y1 - y0) * t
            rings.append([self.vert((centre[0] + r * math.cos(2 * math.pi * i / segments), y, centre[1] + r * math.sin(2 * math.pi * i / segments))) for i in range(segments)])
        for a, b in zip(rings, rings[1:]):
            for i in range(segments):
                j = (i + 1) % segments
                self.face([a[i], b[i], b[j], a[j]], material)
        self.face(list(reversed(rings[0])), material)
        self.face(rings[-1], material)

    def prism(self, outline, z0, z1, material):
        """An outline in the XY plane extruded along Z (gables)."""
        a = [self.vert((x, y, z0)) for x, y in outline]
        b = [self.vert((x, y, z1)) for x, y in outline]
        n = len(outline)
        for i in range(n):
            j = (i + 1) % n
            self.face([a[i], a[j], b[j], b[i]], material)
        self.face(list(reversed(a)), material)
        self.face(b, material)


# ----------------------------------------------------------------------- walls

def wall_spans(lo, hi, openings):
    """Columns along the wall: ``(start, end, opening or None)``."""
    edges = sorted(openings, key=lambda item: item[0])
    spans, cursor = [], lo
    for start, end, bottom, top in edges:
        spans.append((cursor, start, None))
        spans.append((start, end, (bottom, top)))
        cursor = end
    spans.append((cursor, hi, None))
    return [span for span in spans if span[1] - span[0] > 1e-6]


def wall_openings(side):
    half = WINDOW["width"] / 2
    openings = [(c - half, c + half, WINDOW["sill"], WINDOW["head"]) for c in WINDOWS[side]]
    if side == "front":
        openings.append((DOOR["x0"], DOOR["x1"], 0.0, DOOR["height"]))
    return openings


def wall_frame(side):
    """``(along axis, along range, fixed axis, fixed range)`` of each wall; side walls run between the long walls."""
    return {
        "front": (0, (-HX, HX), 2, (IZ, HZ)), "back": (0, (-HX, HX), 2, (-HZ, -IZ)),
        "left": (2, (-IZ, IZ), 0, (-HX, -IX)), "right": (2, (-IZ, IZ), 0, (IX, HX)),
    }[side]


def place(axis, a, b, fixed_axis, fixed, y0, y1):
    lo, hi = [0.0, y0, 0.0], [0.0, y1, 0.0]
    lo[axis], hi[axis] = a, b
    lo[fixed_axis], hi[fixed_axis] = fixed
    return tuple(lo), tuple(hi)


def walls(b):
    for side in ("front", "back", "left", "right"):
        axis, (lo, hi), fixed_axis, fixed = wall_frame(side)
        for start, end, opening in wall_spans(lo, hi, wall_openings(side)):
            bands = [(0, WALL_H)] if opening is None else [(0, opening[0]), (opening[1], WALL_H)]
            for y0, y1 in bands:
                # Stone plinth below STONE_H, plaster above.
                if y0 < STONE_H:
                    b.box(*place(axis, start, end, fixed_axis, fixed, y0, min(y1, STONE_H)), "stone")
                if y1 > STONE_H:
                    b.box(*place(axis, start, end, fixed_axis, fixed, max(y0, STONE_H), y1), "plaster")
        # Timber: a top plate and a sill rail proud of the outer face, plus the opening frames.
        outer = fixed[1] if fixed[1] > 0 else fixed[0]
        proud = (outer - .02, outer + .03) if outer > 0 else (outer - .03, outer + .02)
        for y0, y1 in [(WALL_H - .2, WALL_H), (STONE_H, STONE_H + .12)]:
            for start, end, opening in wall_spans(lo, hi, wall_openings(side)):
                if opening is not None and opening[0] < y1 and opening[1] > y0:
                    continue
                b.beam(*place(axis, start, end, fixed_axis, proud, y0, y1), "timber")
        for start, end, bottom, top in wall_openings(side):
            depth = (fixed[0] - .01, fixed[1] + .01)
            post = .1
            b.beam(*place(axis, start - post, start, fixed_axis, depth, bottom, top), "timber")
            b.beam(*place(axis, end, end + post, fixed_axis, depth, bottom, top), "timber")
            b.beam(*place(axis, start - post, end + post, fixed_axis, depth, top, top + .14), "timber")
            if bottom > 0:
                b.beam(*place(axis, start - post, end + post, fixed_axis, depth, bottom - .08, bottom), "timber")
                mid = (fixed[0] + fixed[1]) / 2
                pane = (mid - .01, mid + .01)
                b.box(*place(axis, start, end, fixed_axis, pane, bottom, top), "glass")
                centre = (start + end) / 2
                bar = (mid - .03, mid + .03)
                b.beam(*place(axis, centre - .025, centre + .025, fixed_axis, bar, bottom, top), "timber")
                b.beam(*place(axis, start, end, fixed_axis, bar, (bottom + top) / 2 - .025, (bottom + top) / 2 + .025), "timber")
    # Corner posts and a mid-wall post on each long wall.
    def span(edge, sign, inward, outward):
        a, c = edge - sign * inward, edge + sign * outward
        return min(a, c), max(a, c)

    for x, z in [(-HX, -HZ), (HX, -HZ), (-HX, HZ), (HX, HZ)]:
        (x0, x1), (z0, z1) = span(x, 1 if x > 0 else -1, .34, .02), span(z, 1 if z > 0 else -1, .34, .02)
        b.beam((x0, 0, z0), (x1, WALL_H, z1), "timber")
    for z, side in ((HZ, "front"), (-HZ, "back")):
        z0, z1 = span(z, 1 if z > 0 else -1, .02, .03)
        for x in (-1.9, 1.9):
            if not any(start - .2 < x < end + .2 for start, end, _, _ in wall_openings(side)):
                b.beam((x - .09, STONE_H, z0), (x + .09, WALL_H, z1), "timber")


def shell(objects):
    b = Builder("inn.walls")
    walls(b)
    objects.append(b)
    floor = Builder("inn.floor")
    floor.box((-IX, 0, -IZ), (IX, FLOOR_T, IZ), "floorboard")
    # Board seams: thin dark strips along X every 0.25 m.
    z = -IZ + .25
    while z < IZ - .1:
        floor.box((-IX, FLOOR_T, z - .004), (IX, FLOOR_T + .002, z + .004), "timber")
        z += .25
    floor.box((DOOR["x0"], 0, IZ), (DOOR["x1"], FLOOR_T, HZ + .12), "stone")
    objects.append(floor)
    # The hinge sits just inside the room's face of the doorway, so the open leaf lies along the inner wall.
    hinge = (DOOR["x0"], 0.0, IZ + .03)
    return [("door.hinge", hinge)]


def ceiling(objects):
    b = Builder("inn.ceiling")
    b.box((-IX, CEILING_Y, -IZ), (IX, CEILING_Y + CEILING_T, IZ), "wood")
    x = -IX + .8
    while x < IX - .4:
        b.beam((x - .08, CEILING_Y - .2, -IZ), (x + .08, CEILING_Y, IZ), "timber")
        x += 1.6
    objects.append(b)
    return []


def roof(objects):
    b = Builder("inn.roof")
    run = HZ + EAVE_OUT
    thickness = .12
    # The underside meets the outer wall face at WALL_H and continues to the eave.
    eave_y = WALL_H - (RIDGE_Y - thickness - WALL_H) * EAVE_OUT / HZ
    x0, x1 = -HX - EAVE_OUT, HX + EAVE_OUT
    for sign in (-1, 1):
        # Slab from the eave to the ridge: lower and upper surfaces.
        lower = [(x0, eave_y, sign * run), (x1, eave_y, sign * run), (x1, RIDGE_Y - thickness, 0), (x0, RIDGE_Y - thickness, 0)]
        upper = [(x, y + thickness, z) for x, y, z in lower]
        lv, uv = [b.vert(p) for p in lower], [b.vert(p) for p in upper]
        b.face(lv[::-1] if sign > 0 else lv, "shingle")
        b.face(uv if sign > 0 else uv[::-1], "shingle")
        for i in range(4):
            j = (i + 1) % 4
            b.face([lv[i], lv[j], uv[j], uv[i]], "shingle")
        # Shingle courses: shallow steps across the slope.
        for k in range(1, 9):
            t = k / 9
            z = sign * run * (1 - t)
            y = eave_y + (RIDGE_Y - thickness - eave_y) * t + thickness
            b.beam((x0, y - .01, min(z, z + sign * .05)), (x1, y + .025, max(z, z + sign * .05)), "shingle", chamfer=.008)
    # Gables: plaster triangles above the side walls with a timber edge.
    for x in (-HX, HX):
        outline = [(-HZ, WALL_H), (HZ, WALL_H), (0, RIDGE_Y - thickness)]
        x0g, x1g = (x, x + T) if x < 0 else (x - T, x)
        a = [b.vert((x0g, y, z)) for z, y in outline]
        c = [b.vert((x1g, y, z)) for z, y in outline]
        b.face(a, "plaster")
        b.face(c[::-1], "plaster")
        for i in range(3):
            j = (i + 1) % 3
            b.face([a[i], a[j], c[j], c[i]], "plaster")
        b.beam((x - .2, WALL_H, -.1), (x + .2, RIDGE_Y - thickness - .05, .1), "timber")
    b.beam((x0, RIDGE_Y - .16, -.1), (x1, RIDGE_Y, .1), "timber")
    objects.append(b)
    return []


def door(objects):
    b = Builder("inn.door")
    w, h, t, gap = LEAF["width"], LEAF["height"], LEAF["thickness"], LEAF["gap"]
    planks = 6
    for i in range(planks):
        x0 = gap + w * i / planks
        b.beam((x0 + .002, FLOOR_T, -t / 2), (x0 + w / planks - .002, FLOOR_T + h, t / 2), "wood", chamfer=.006)
    for y in (.35, h - .35):
        b.beam((gap + .04, FLOOR_T + y - .07, t / 2), (gap + w - .04, FLOOR_T + y + .07, t / 2 + .03), "timber")
        b.beam((gap, FLOOR_T + y - .03, -t / 2 - .008), (gap + w * .8, FLOOR_T + y + .03, -t / 2), "iron", chamfer=.003)
        b.beam((gap, FLOOR_T + y - .03, t / 2 + .03), (gap + w * .8, FLOOR_T + y + .03, t / 2 + .038), "iron", chamfer=.003)
    b.cylinder((gap + w - .14, t / 2 + .05), .035, FLOOR_T + 1.0, FLOOR_T + 1.08, "iron", segments=10)
    b.cylinder((gap + w - .14, -t / 2 - .05), .035, FLOOR_T + 1.0, FLOOR_T + 1.08, "iron", segments=10)
    objects.append(b)
    return [("hinge", (0.0, 0.0, 0.0))]


# ------------------------------------------------------------------- furniture

TABLES = [(-4.3, -2.2), (-4.3, 1.4), (-1.6, -1.2)]
TABLE = (1.4, .8, .76)
CHAIR = (.44, .44, .46, .96)
BAR = [((2.2, -3.4), (6.0, -2.8)), ((2.2, -2.8), (2.8, -1.6))]
BAR_H = 1.08
SHELF = ((2.4, -IZ), (6.3, -IZ + .32), 2.3)
STOOLS = [(3.2, -2.35), (4.2, -2.35), (5.2, -2.35)]
BARRELS = [(6.0, -1.9), (6.0, -1.1), (-6.0, 4.0), (-5.25, 4.05)]
BARREL = (.34, .9)
HEARTH = ((-IX, -1.0), (-IX + .6, 1.0), 1.25)


def chair_positions():
    out = []
    for t, (x, z) in enumerate(TABLES, start=1):
        for k, (dx, dz, facing) in enumerate([(-.38, -.62, 1), (.38, -.62, 1), (-.38, .62, -1), (.38, .62, -1)], start=1):
            out.append((f"chair.{t}.{k}", x + dx, z + dz, facing))
    return out


def furniture_items():
    """``(name, collider box min, collider box max)`` of every furniture item."""
    items = []
    for i, ((x0, z0), (x1, z1)) in enumerate(BAR, start=1):
        items.append((f"bar-counter.{i}", (x0, 0, z0), (x1, BAR_H + .04, z1)))
    (sx0, sz0), (sx1, sz1), sh = SHELF
    items.append(("back-shelf", (sx0, 0, sz0), (sx1, sh, sz1)))
    for t, (x, z) in enumerate(TABLES, start=1):
        w, d, h = TABLE
        items.append((f"table.{t}", (x - w / 2, 0, z - d / 2), (x + w / 2, h, z + d / 2)))
    for name, x, z, _ in chair_positions():
        w, d, _, back = CHAIR
        items.append((name, (x - w / 2, 0, z - d / 2), (x + w / 2, back, z + d / 2)))
    for i, (x, z) in enumerate(STOOLS, start=1):
        items.append((f"stool.{i}", (x - .19, 0, z - .19), (x + .19, .72, z + .19)))
    r, h = BARREL
    for i, (x, z) in enumerate(BARRELS, start=1):
        items.append((f"barrel.{i}", (x - r * 1.08, 0, z - r * 1.08), (x + r * 1.08, h, z + r * 1.08)))
    (hx0, hz0), (hx1, hz1), hh = HEARTH
    items.append(("hearth", (hx0, 0, hz0), (hx1, hh, hz1)))
    return items


def furniture(objects):
    for name, lo, hi in furniture_items():
        b = Builder(name)
        kind = name.split(".")[0]
        if kind == "bar-counter":
            b.box((lo[0] + .06, 0, lo[2] + .06), (hi[0] - .06, BAR_H, hi[2] - .06), "wood")
            b.beam((lo[0], BAR_H, lo[2]), (hi[0], BAR_H + .04, hi[2]), "timber", chamfer=.01)
            b.beam((lo[0] + .04, 0, lo[2] + .04), (hi[0] - .04, .1, hi[2] - .04), "timber")
        elif kind == "back-shelf":
            b.box((lo[0], 0, lo[2]), (hi[0], .9, hi[2]), "wood")
            for y in (1.4, 1.85, hi[1] - .04):
                b.beam((lo[0], y, lo[2]), (hi[0], y + .04, hi[2]), "timber", chamfer=.008)
            for x in (lo[0], hi[0] - .05):
                b.beam((x, .9, lo[2]), (x + .05, hi[1], hi[2]), "timber", chamfer=.008)
            for i in range(8):
                x = lo[0] + .3 + i * .45
                b.cylinder((x, lo[2] + .16), .045, 1.44, 1.64, "glass", segments=8)
        elif kind == "table":
            b.beam((lo[0], hi[1] - .05, lo[2]), (hi[0], hi[1], hi[2]), "wood", chamfer=.012)
            for x in (lo[0] + .08, hi[0] - .16):
                for z in (lo[2] + .08, hi[2] - .16):
                    b.beam((x, 0, z), (x + .08, hi[1] - .05, z + .08), "timber", chamfer=.01)
            b.beam((lo[0] + .1, .12, (lo[2] + hi[2]) / 2 - .03), (hi[0] - .1, .18, (lo[2] + hi[2]) / 2 + .03), "timber", chamfer=.008)
        elif kind == "chair":
            facing = next(f for n, _, _, f in chair_positions() if n == name)
            w, d, seat, back = CHAIR
            b.beam((lo[0], seat - .04, lo[2]), (hi[0], seat, hi[2]), "wood", chamfer=.008)
            for x in (lo[0] + .03, hi[0] - .08):
                for z in (lo[2] + .03, hi[2] - .08):
                    b.beam((x, 0, z), (x + .05, seat - .04, z + .05), "timber", chamfer=.008)
            # Backrest on the side away from the table.
            z0 = lo[2] if facing > 0 else hi[2] - .05
            for x in (lo[0] + .03, hi[0] - .08):
                b.beam((x, seat, z0), (x + .05, back, z0 + .05), "timber", chamfer=.008)
            for y in (seat + .22, back - .1):
                b.beam((lo[0] + .03, y, z0), (hi[0] - .03, y + .08, z0 + .04), "wood", chamfer=.006)
        elif kind == "stool":
            x, z = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
            b.cylinder((x, z), .19, .68, .72, "wood", segments=12)
            for dx, dz in [(-.1, -.1), (.1, -.1), (-.1, .1), (.1, .1)]:
                b.beam((x + dx - .025, 0, z + dz - .025), (x + dx + .025, .68, z + dz + .025), "timber", chamfer=.008)
        elif kind == "barrel":
            r, h = BARREL
            x, z = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
            b.cylinder((x, z), r, 0, h, "wood", segments=16, bulge=.08)
            for y in (.12, h / 2, h - .12):
                b.cylinder((x, z), r * (1 + .08 * math.sin(math.pi * y / h)) + .006, y - .025, y + .025, "iron", segments=16)
        elif kind == "hearth":
            b.box((lo[0], 0, lo[2]), (hi[0], hi[1], lo[2] + .45), "stone")
            b.box((lo[0], 0, hi[2] - .45), (hi[0], hi[1], hi[2]), "stone")
            b.box((lo[0], 0, lo[2] + .45), (hi[0] - .25, hi[1], hi[2] - .45), "soot")
            b.box((lo[0], .9, lo[2] + .45), (hi[0], hi[1], hi[2] - .45), "stone")
            b.beam((lo[0], hi[1], lo[2] - .1), (hi[0] + .1, hi[1] + .1, hi[2] + .1), "timber")
            b.box((lo[0], hi[1] + .1, lo[2] + .2), (lo[0] + .45, CEILING_Y, hi[2] - .2), "stone")
        objects.append(b)
    return []


# ------------------------------------------------------------------- colliders

def collision(objects):
    def collider(tag, name, lo, hi):
        b = Builder(f"collider.{tag}.{name}")
        b.box(lo, hi, "collider")
        objects.append(b)

    collider("wall", "front.left", (-HX, 0, IZ), (DOOR["x0"], WALL_H, HZ))
    collider("wall", "front.right", (DOOR["x1"], 0, IZ), (HX, WALL_H, HZ))
    collider("wall", "front.lintel", (DOOR["x0"], DOOR["height"], IZ), (DOOR["x1"], WALL_H, HZ))
    collider("wall", "back", (-HX, 0, -HZ), (HX, WALL_H, -IZ))
    collider("wall", "left", (-HX, 0, -IZ), (-IX, WALL_H, IZ))
    collider("wall", "right", (IX, 0, -IZ), (HX, WALL_H, IZ))
    collider("floor", "interior", (-IX, 0, -IZ), (IX, FLOOR_T, IZ))
    w, h, t, gap = LEAF["width"], LEAF["height"], LEAF["thickness"], LEAF["gap"]
    collider("door", "leaf", (gap, FLOOR_T, -t / 2), (gap + w, FLOOR_T + h, t / 2))
    for name, lo, hi in furniture_items():
        collider("furniture", name, lo, hi)
    return []


BUILDERS = {"shell": shell, "ceiling": ceiling, "roof": roof, "door": door, "furniture": furniture, "collision": collision}


def material(name):
    colour, metallic, roughness = MATERIALS[name]
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*colour, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    return result


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "part"}:
        raise ValueError("inn requires exactly schemaVersion and part")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("inn schemaVersion must be 1")
    if p["part"] not in PARTS:
        raise ValueError("inn part must be one of " + ", ".join(PARTS))
    if inputs:
        raise ValueError("inn recipe does not accept extra resources")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    part = arguments["part"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    materials = {}
    builders = []
    empties = BUILDERS[part](builders)
    bpy.ops.object.select_all(action="DESELECT")
    triangles, geometry, lows, highs, nodes = 0, b"", [math.inf] * 3, [-math.inf] * 3, []
    for builder in builders:
        bm = builder.bm
        if part != "collision":
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="FIXED", ngon_method="EAR_CLIP")
        for face in bm.faces:
            face.smooth = False
        triangles += len(bm.faces)
        mesh = bpy.data.meshes.new(f"{builder.name}-geometry")
        bm.to_mesh(mesh)
        bm.free()
        for name in builder.materials:
            mesh.materials.append(materials.setdefault(name, material(name)))
        obj = bpy.data.objects.new(builder.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        for point in builder.points:
            for i in range(3):
                lows[i], highs[i] = min(lows[i], point[i]), max(highs[i], point[i])
        geometry += builder.name.encode("ascii") + b"\n"
        geometry += b"".join(float(c).hex().encode("ascii") + b"\n" for v in mesh.vertices for c in v.co)
        geometry += b"".join((",".join(str(i) for i in f.vertices) + ":" + str(f.material_index) + "\n").encode("ascii") for f in mesh.polygons)
        nodes.append(builder.name)
    for name, point in empties:
        empty = bpy.data.objects.new(name, None)
        empty.location = to_blender(point)
        bpy.context.scene.collection.objects.link(empty)
        empty.select_set(True)
        nodes.append(name)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "greyhaven-inn-v1", "parameters": arguments, "part": part, "unit": "meter",
            "axes": "right-handed-y-up", "origin": "footprint-base-center", "facing": "+Z",
            "triangleCount": triangles, "nodes": sorted(nodes),
            "bounds": {"min": [round(c, 6) for c in lows], "max": [round(c, 6) for c in highs]},
            "materials": sorted(materials), "geometrySha256": hashlib.sha256(geometry).hexdigest()}
