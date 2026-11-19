"""Held items: weapon variety and residents' hand tools for the humanoid equipment kit, an original scripted recipe.

One run builds one item (``{schemaVersion: 1, item}``) for the pinned Blender script backend. The items follow the
weapon recipes' grip contract (docs/weapon-recipes.md) so they attach through the existing humanoid sockets
(docs/humanoid-sockets.md) with the roles those sockets already accept:

- ``one-hand-weapon`` (``hand_r.weapon``): the grip frame is the centre of the hand's contact on the grip, the business
  end runs along +Y, edges and striking faces along +X (the fingers) and flats face ±Z. Carried items that hang from
  the fist (lantern, bucket, basket) hang along +X with their bail or handle along Y; the tankard's body sits on the +X
  side of its handle.
- ``staff`` (``hand_r.staff``): the shaft runs along +Y through the grip, its foot ``FOOT`` (0.8 m) below the grip so it
  stands beside the leg in the hanging-arm idle. Long tools and spears use it.
- ``shield`` (``hand_l.shield``): the grip frame is the centre of the hand handle along Y, the face points to +Z, the
  point to -Y and the forearm strap lies along +X.
- ``book`` (``hand_l.shield``): the grip frame is the middle of the back cover, the spine along +Y, the book toward +Z.

Every GLB has one mesh node named after the item and an empty ``grip`` node at the origin. Materials are the weapon
recipes' factor-only PBR colours (same names), with no UVs or textures; ``ember`` glows. Geometry is built from explicit
vertex lists and triangulated here, in a fixed order, so a rebuild is byte-identical. There is no randomness.
"""
import hashlib
import math
from contextlib import contextmanager

import bpy
from mathutils import Matrix, Vector, geometry

FOOT = 0.8
MATERIALS = {
    # name: (linear base colour, metallic, roughness); the weapon recipes' values.
    "steel": ((.62, .64, .66), 1.0, .32),
    "iron": ((.29, .28, .27), 1.0, .48),
    "leather": ((.2, .1, .05), 0.0, .72),
    "wood": ((.34, .22, .12), 0.0, .78),
    "wood.dark": ((.07, .036, .018), 0.0, .85),
    "paint": ((.04, .07, .18), 0.0, .62),
    "paint.red": ((.42, .045, .03), 0.0, .55),
    "brass": ((.62, .44, .16), 1.0, .38),
    "gold": ((.83, .58, .17), 1.0, .3),
    "parchment": ((.7, .62, .45), 0.0, .9),
    "bone": ((.79, .74, .58), 0.0, .62),
    "cork": ((.42, .27, .14), 0.0, .9),
    "fuse": ((.5, .38, .2), 0.0, .95),
    "glass": ((.62, .8, .66), 0.0, .06),
    "ember": ((1.0, .32, .04), 0.0, .2),
    # #760: the hunter's spear's pale ash shaft, and the archery recipe's feather (same name and values).
    "wood.ash": ((.52, .4, .25), 0.0, .74),
    "feather": ((.66, .62, .55), 0.0, .9),
}
ALPHA = {"glass": .32}
EMISSIVE = {"ember"}
SHARP_ANGLE = math.radians(35)


class Builder:
    """Vertices in glTF axes under a transform stack; faces as vertex-index loops with a material name."""

    def __init__(self):
        self.verts, self.faces, self.m = [], [], Matrix.Identity(4)

    @contextmanager
    def at(self, matrix):
        old = self.m
        self.m = old @ matrix
        try:
            yield
        finally:
            self.m = old

    def add(self, points):
        start = len(self.verts)
        self.verts += [self.m @ Vector(p) for p in points]
        return list(range(start, len(self.verts)))

    def face(self, loop, mat):
        self.faces.append((list(loop), mat))

    def loft(self, rings, mat, cap_mat=None, caps=(True, True)):
        """Rings of equal length (or single apex points), each wound like ``lathe`` (x = r cos a, z = -r sin a), along
        their travel direction; quads between neighbours, caps at open ends."""
        index = [self.add(ring) for ring in rings]
        for lo, hi in zip(index, index[1:]):
            if len(lo) == 1:
                n = len(hi)
                for s in range(n):
                    self.face([lo[0], hi[(s + 1) % n], hi[s]], mat)
            elif len(hi) == 1:
                n = len(lo)
                for s in range(n):
                    self.face([lo[s], lo[(s + 1) % n], hi[0]], mat)
            else:
                n = len(lo)
                for s in range(n):
                    self.face([lo[s], lo[(s + 1) % n], hi[(s + 1) % n], hi[s]], mat)
        bottom, top = cap_mat if isinstance(cap_mat, tuple) else (cap_mat, cap_mat)
        if caps[0] and len(index[0]) > 1:
            self.face(list(reversed(index[0])), bottom or mat)
        if caps[1] and len(index[-1]) > 1:
            self.face(index[-1], top or mat)

    def lathe(self, profile, n, mat, cap_mat=None, phase=0.0, caps=(True, True)):
        """A solid of revolution about +Y from ``profile`` [(y, r)], bottom to top; r = 0 is a pole."""
        rings = []
        for y, r in profile:
            if r <= 1e-9:
                rings.append([(0.0, y, 0.0)])
            else:
                rings.append([(r * math.cos(phase + 2 * math.pi * s / n), y, -r * math.sin(phase + 2 * math.pi * s / n)) for s in range(n)])
        self.loft(rings, mat, cap_mat, caps)

    def prism(self, outline, z0, z1, mat, cap_mat=None):
        """A counter-clockwise (x, y) outline extruded from z0 (back) to z1 (front); ``cap_mat`` paints the front."""
        back = self.add([(x, y, z0) for x, y in outline])
        front = self.add([(x, y, z1) for x, y in outline])
        n = len(outline)
        for i in range(n):
            self.face([back[i], back[(i + 1) % n], front[(i + 1) % n], front[i]], mat)
        self.face(front, cap_mat or mat)
        self.face(list(reversed(back)), mat)

    def box(self, lo, hi, mat):
        with self.at(Matrix.Identity(4)):
            self.prism([(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])], lo[2], hi[2], mat)

    def rod(self, a, c, r0, r1, n, mat, cap_mat=None):
        a, c = Vector(a), Vector(c)
        d = c - a
        turn = Vector((0, 1, 0)).rotation_difference(d.normalized()).to_matrix().to_4x4()
        with self.at(Matrix.Translation(a) @ turn):
            self.lathe([(0, r0), (d.length, r1)], n, mat, cap_mat)

    def ball(self, centre, radius, mat, n=8, rows=4, squash=(1, 1, 1)):
        profile = [(-radius, 0)] + [(-radius * math.cos(math.pi * k / rows), radius * math.sin(math.pi * k / rows)) for k in range(1, rows)] + [(radius, 0)]
        with self.at(Matrix.Translation(centre) @ Matrix.Diagonal((*squash, 1))):
            self.lathe(profile, n, mat)


def rot(axis, degrees):
    return Matrix.Rotation(math.radians(degrees), 4, axis)


def T(x, y, z):
    return Matrix.Translation((x, y, z))


# ---------------------------------------------------------------- blades and hafts

def blade(b, length, width, thickness, mat, base=0.0, tip=0.18, curve=0.0, single=False, widen=1.0):
    """A lozenge-section blade along +Y from ``base``: edges along ±X, a point over its last ``tip`` fraction.
    ``curve`` bends it toward +X; ``single`` makes the back (-X) edge blunt; ``widen`` scales the width at the tip."""
    rings, steps = [], 6
    for k in range(steps + 1):
        u = k / steps
        y = base + length * u
        w = width * (1 + (widen - 1) * u)
        if u > 1 - tip:
            w *= max(0.0, (1 - u) / tip) ** 0.7
        x0 = curve * length * u * u
        t = thickness * (1 - 0.5 * u)
        if k == steps:
            rings.append([(x0 + (width * 0.3 if single else 0), y, 0)])
            continue
        back = -w * 0.55 if single else -w
        rings.append([(x0 + w, y, 0), (x0, y, -t), (x0 + back, y, 0), (x0, y, t)])
    b.loft(rings, mat)


def hilt(b, grip, guard, pommel, n=6, mats=("leather", "iron", "iron"), guard_depth=0.025, pommel_kind="ball"):
    """A grip from -grip*0.6 to +grip*0.4 around the hand, a crossguard bar above it and a pommel below."""
    g0, g1 = -grip * 0.6, grip * 0.4
    b.lathe([(g0, 0.014), (g0 + grip * 0.5, 0.016), (g1, 0.014)], n, mats[0])
    b.box((-guard / 2, g1, -guard_depth / 2), (guard / 2, g1 + 0.022, guard_depth / 2), mats[1])
    if pommel_kind == "ball":
        b.ball((0, g0 - pommel * 0.9, 0), pommel, mats[2], n, 4)
    else:  # wheel
        with b.at(T(0, g0 - pommel, 0) @ rot("X", 90)):
            b.lathe([(-0.01, pommel), (0.01, pommel)], 10, mats[2])
    return g1 + 0.022


def sword(b, length, width, grip, guard, pommel, curve=0.0, single=False, widen=1.0, pommel_kind="ball"):
    top = hilt(b, grip, guard, pommel, pommel_kind=pommel_kind)
    blade(b, length, width / 2, 0.006, "steel", base=top, curve=curve, single=single, widen=widen)


def haft(b, y0, y1, r, mat="wood", n=6, grip=None):
    b.lathe([(y0, r * 0.95), (y1, r)], n, mat)
    if grip:
        b.lathe([(-grip / 2, r + 0.003), (grip / 2, r + 0.003)], n, "leather")


def axe_head(b, y, outline, thickness, mat="steel", socket=0.022):
    """An axe head in the X-Y plane (blade toward +X) centred on the haft at height ``y``."""
    with b.at(T(0, y, 0)):
        b.prism(outline, -thickness / 2, thickness / 2, mat)
        b.lathe([(-0.035, socket), (0.035, socket)], 6, "iron")


# ---------------------------------------------------------------- weapons

def sword_footman(b):
    sword(b, 0.72, 0.05, 0.11, 0.18, 0.024)


def sword_falchion(b):
    sword(b, 0.62, 0.05, 0.1, 0.16, 0.022, curve=0.06, single=True, widen=1.45)


def sword_longsword(b):
    sword(b, 0.95, 0.05, 0.24, 0.24, 0.03, pommel_kind="wheel")


def sword_bastard(b):
    sword(b, 0.85, 0.055, 0.18, 0.22, 0.028)


def dagger_plain(b):
    top = hilt(b, 0.09, 0.08, 0.016)
    blade(b, 0.24, 0.018, 0.005, "steel", base=top)


def dagger_seax(b):
    top = hilt(b, 0.1, 0.03, 0.014, mats=("wood.dark", "brass", "brass"), guard_depth=0.02)
    blade(b, 0.28, 0.02, 0.005, "steel", base=top, single=True, widen=1.3, tip=0.25)


def axe_battle(b):
    haft(b, -0.14, 0.62, 0.016, grip=0.14)
    axe_head(b, 0.54, [(-0.02, -0.03), (0.05, -0.04), (0.16, -0.11), (0.19, -0.02), (0.19, 0.06), (0.15, 0.1), (0.05, 0.04), (-0.02, 0.035)], 0.014)
    b.lathe([(0.62, 0.017), (0.64, 0.0)], 6, "iron")


def axe_bearded(b):
    haft(b, -0.14, 0.6, 0.016, mat="wood.dark", grip=0.14)
    axe_head(b, 0.5, [(-0.02, -0.02), (0.06, -0.025), (0.1, -0.13), (0.16, -0.16), (0.17, -0.05), (0.16, 0.06), (0.05, 0.035), (-0.02, 0.03)], 0.013)


def axe_hand(b):
    haft(b, -0.1, 0.32, 0.013)
    axe_head(b, 0.26, [(-0.015, -0.02), (0.04, -0.025), (0.1, -0.06), (0.11, 0.0), (0.1, 0.05), (0.04, 0.025), (-0.015, 0.02)], 0.012)


def mace_studded(b):
    haft(b, -0.12, 0.42, 0.015, mat="wood.dark", grip=0.13)
    b.ball((0, 0.47, 0), 0.05, "iron", n=8, rows=4)
    for k in range(6):
        a = math.tau * k / 6
        b.ball((0.05 * math.cos(a), 0.47, -0.05 * math.sin(a)), 0.012, "steel", n=4, rows=2)


def mace_morningstar(b):
    haft(b, -0.12, 0.44, 0.016, grip=0.13)
    centre = Vector((0, 0.5, 0))
    b.ball(centre, 0.055, "iron", n=8, rows=4)
    for k, (a, e) in enumerate([(a, e) for e in (-35, 15) for a in range(0, 360, 60)] + [(0, 90)]):
        d = Vector((math.cos(math.radians(e)) * math.cos(math.radians(a + (30 if e > 0 else 0))), math.sin(math.radians(e)),
                    -math.cos(math.radians(e)) * math.sin(math.radians(a + (30 if e > 0 else 0)))))
        b.rod(centre + d * 0.045, centre + d * 0.1, 0.012, 0.0, 4, "steel")


def warhammer_horseman(b):
    haft(b, -0.12, 0.56, 0.015, grip=0.13)
    with b.at(T(0, 0.5, 0)):
        b.box((-0.03, -0.025, -0.022), (0.08, 0.025, 0.022), "steel")
        b.box((0.08, -0.03, -0.028), (0.1, 0.03, 0.028), "steel")
        b.rod((-0.03, 0, 0), (-0.14, -0.03, 0), 0.018, 0.0, 4, "steel")
    b.rod((0, 0.56, 0), (0, 0.66, 0), 0.012, 0.0, 4, "steel")


def warhammer_maul(b):
    haft(b, -0.3, 0.72, 0.019, grip=0.4)
    with b.at(T(0, 0.68, 0)):
        b.box((-0.11, -0.06, -0.055), (0.11, 0.06, 0.055), "iron")
        for x in (-0.11, 0.11):
            b.box((x - 0.012 if x > 0 else x - 0.006, -0.068, -0.062), (x + 0.006 if x > 0 else x + 0.012, 0.068, 0.062), "steel")


def spear_leaf(b):
    haft(b, -FOOT, 1.15, 0.016)
    b.lathe([(1.12, 0.019), (1.2, 0.016)], 6, "iron")
    blade(b, 0.26, 0.026, 0.006, "steel", base=1.2, tip=0.45, widen=0.9)
    b.lathe([(-FOOT - 0.03, 0.0), (-FOOT, 0.017)], 6, "iron", caps=(False, True))


def spear_boar(b):
    haft(b, -FOOT, 1.1, 0.018, mat="wood.dark")
    b.lathe([(1.06, 0.021), (1.16, 0.017)], 6, "iron")
    b.box((-0.07, 1.12, -0.008), (0.07, 1.14, 0.008), "iron")
    blade(b, 0.3, 0.035, 0.007, "steel", base=1.16, tip=0.4)


def staff_quarter(b):
    haft(b, -FOOT, 1.0, 0.019, n=7)
    for y0, y1 in ((-FOOT, -FOOT + 0.08), (0.92, 1.0)):
        b.lathe([(y0, 0.021), (y1, 0.021)], 7, "iron")
    b.lathe([(-0.06, 0.022), (0.06, 0.022)], 7, "leather")


def staff_crook(b):
    haft(b, -FOOT, 0.7, 0.017, n=6)
    path = [(0.0, 0.7)] + [(0.09 - 0.09 * math.cos(math.pi * k / 6), 0.7 + 0.11 * math.sin(math.pi * k / 6)) for k in range(1, 7)] + [(0.18, 0.62)]
    for (x0, y0), (x1, y1) in zip(path, path[1:]):
        b.rod((x0, y0, 0), (x1, y1, 0), 0.0165, 0.0165, 6, "wood")


def shield_round(b, radius=0.3, face="paint.red", rim="iron", boss="iron", planks=True):
    with b.at(T(0, 0, 0.03) @ rot("X", 90)):
        b.lathe([(0, radius), (0.016, radius), (0.016, radius - 0.02), (0.02, radius - 0.03)], 16, "wood", cap_mat=(None, face))
        b.lathe([(-0.002, radius + 0.006), (0.024, radius + 0.006)], 16, rim, caps=(False, False))
        b.lathe([(0.02, 0.07), (0.04, 0.06), (0.06, 0.03), (0.065, 0)], 10, boss)
    if planks:
        for x in (-0.1, 0.1):
            b.box((x - 0.004, -radius * 0.9, 0.0495), (x + 0.004, radius * 0.9, 0.0515), "wood.dark")
    b.box((-0.012, -0.06, -0.012), (0.012, 0.06, 0.012), "leather")
    for y in (-0.06, 0.06):
        b.box((-0.012, y - 0.008, -0.012), (0.012, y + 0.008, 0.03), "leather")
    b.box((0.13, -0.06, 0.012), (0.17, 0.06, 0.03), "leather")


def shield_buckler(b):
    with b.at(T(0, 0, 0.025) @ rot("X", 90)):
        b.lathe([(0, 0.17), (0.01, 0.17), (0.03, 0.14), (0.045, 0.06), (0.06, 0.0)], 14, "steel")
        b.lathe([(-0.002, 0.176), (0.012, 0.176)], 14, "brass", caps=(False, False))
    b.box((-0.012, -0.05, -0.012), (0.012, 0.05, 0.012), "leather")
    for y in (-0.05, 0.05):
        b.box((-0.012, y - 0.008, -0.012), (0.012, y + 0.008, 0.027), "leather")


def shield_kite(b):
    w, top, point = 0.25, 0.32, -0.62
    outline = [(0.0, point)]
    for k in range(1, 6):
        u = k / 6
        outline.append((w * math.sin(u * math.pi / 2) ** 0.8, point + (top - 0.06 - point) * u))
    outline += [(w, top - 0.06), (w * 0.7, top), (-w * 0.7, top), (-w, top - 0.06)]
    for k in range(5, 0, -1):
        u = k / 6
        outline.append((-w * math.sin(u * math.pi / 2) ** 0.8, point + (top - 0.06 - point) * u))
    b.prism(outline, 0.03, 0.05, "wood", cap_mat="paint")
    b.box((-0.03, point + 0.1, 0.05), (0.03, top - 0.02, 0.054), "paint.red")
    b.box((-w * 0.75, 0.05, 0.05), (w * 0.75, 0.11, 0.054), "paint.red")
    b.box((-0.012, -0.06, -0.012), (0.012, 0.06, 0.012), "leather")
    for y in (-0.06, 0.06):
        b.box((-0.012, y - 0.008, -0.012), (0.012, y + 0.008, 0.03), "leather")
    b.box((0.13, -0.06, 0.012), (0.17, 0.06, 0.03), "leather")


# ---------------------------------------------------------------- tools and carried items

def hanging(b, fn):
    """Build ``fn`` upright with its bail or handle top at the origin along X; hang it along +X from a fist."""
    with b.at(rot("Z", 90)):
        fn()


def lantern(b):
    def build():
        b.rod((-0.05, 0, 0), (0.05, 0, 0), 0.008, 0.008, 5, "iron")
        for x in (-0.05, 0.05):
            b.rod((x, 0, 0), (x * 0.6, -0.07, 0), 0.004, 0.004, 4, "iron")
        b.lathe([(-0.1, 0.075), (-0.085, 0.075), (-0.07, 0.0)], 4, "iron", phase=math.pi / 4)
        b.box((-0.05, -0.3, -0.05), (0.05, -0.1, 0.05), "glass")
        for dx in (-0.055, 0.055):
            for dz in (-0.055, 0.055):
                b.box((dx - 0.006, -0.3, dz - 0.006), (dx + 0.006, -0.1, dz + 0.006), "iron")
        b.box((-0.065, -0.32, -0.065), (0.065, -0.3, 0.065), "iron")
        b.lathe([(-0.29, 0.012), (-0.25, 0.012)], 5, "parchment")
        b.lathe([(-0.25, 0.012), (-0.2, 0.0)], 5, "ember")
    hanging(b, build)


def torch(b):
    haft(b, -0.18, 0.3, 0.016, mat="wood.dark")
    b.lathe([(0.24, 0.022), (0.27, 0.03), (0.34, 0.028), (0.36, 0.02)], 6, "fuse")
    b.lathe([(0.355, 0.024), (0.42, 0.028), (0.5, 0.012), (0.56, 0.0)], 6, "ember", phase=0.4)


def pitchfork(b):
    haft(b, -FOOT, 0.95, 0.016)
    b.box((-0.09, 0.95, -0.012), (0.09, 0.98, 0.012), "iron")
    b.lathe([(0.93, 0.02), (0.99, 0.018)], 6, "iron")
    for x in (-0.08, 0.0, 0.08):
        b.rod((x, 0.98, 0), (x * 1.1, 1.24, 0.015), 0.007, 0.002, 4, "iron")


def hoe(b):
    haft(b, -FOOT, 0.72, 0.016)
    b.lathe([(0.66, 0.02), (0.74, 0.02)], 6, "iron")
    b.rod((0, 0.71, 0), (0, 0.71, 0.08), 0.011, 0.011, 5, "iron")
    b.box((-0.08, 0.6, 0.075), (0.08, 0.73, 0.085), "iron")


def shovel(b):
    haft(b, -0.55, 0.42, 0.016)
    b.box((-0.06, 0.42, -0.012), (0.06, 0.44, 0.012), "wood")
    for x in (-0.06, 0.06):
        b.box((x - 0.012, 0.42, -0.012), (x + 0.012, 0.52, 0.012), "wood")
    b.box((-0.07, 0.5, -0.013), (0.07, 0.525, 0.013), "wood")
    b.lathe([(-0.6, 0.021), (-0.52, 0.018)], 6, "iron")
    b.prism([(-0.11, -0.62), (0.0, -0.66), (0.11, -0.62), (0.115, -FOOT + 0.06), (0.06, -FOOT), (-0.06, -FOOT), (-0.115, -FOOT + 0.06)][::-1],
            -0.004, 0.004, "iron")


def fishing_rod(b):
    b.lathe([(-0.32, 0.015), (0.08, 0.014)], 6, "cork")
    b.lathe([(0.08, 0.011), (1.2, 0.007), (2.3, 0.003)], 5, "wood")
    b.lathe([(-0.06, 0.03), (-0.02, 0.03)], 8, "brass")
    b.rod((0.003, 2.3, 0), (0.12, 1.9, 0.02), 0.0015, 0.0015, 3, "parchment")
    b.ball((0.12, 1.88, 0.02), 0.014, "paint.red", n=6, rows=3)


def wood_axe(b):
    haft(b, -0.16, 0.62, 0.017)
    axe_head(b, 0.55, [(-0.04, -0.03), (0.06, -0.035), (0.15, -0.07), (0.16, 0.0), (0.15, 0.07), (0.06, 0.035), (-0.04, 0.03)], 0.03, mat="iron", socket=0.024)


def hammer(b):
    haft(b, -0.1, 0.27, 0.013)
    with b.at(T(0, 0.27, 0)):
        b.box((-0.05, -0.016, -0.016), (0.05, 0.016, 0.016), "iron")
    with b.at(T(0.05, 0.27, 0) @ rot("Z", -90)):  # the round striking face, toward +X
        b.lathe([(0, 0.02), (0.02, 0.02)], 6, "iron")


def bucket(b):
    def build():
        b.rod((-0.15, 0, 0), (0.15, 0, 0), 0.006, 0.006, 4, "iron")
        for x in (-0.15, 0.15):
            b.rod((x, 0, 0), (x * 1.05, -0.12, 0), 0.005, 0.005, 4, "iron")
        b.lathe([(-0.42, 0.11), (-0.12, 0.155), (-0.12, 0.145), (-0.16, 0.0)], 10, "wood", cap_mat="wood.dark")
        for y, r in ((-0.38, 0.118), (-0.17, 0.152)):
            b.lathe([(y - 0.012, r), (y + 0.012, r + 0.002)], 10, "iron", caps=(False, False))
    with b.at(T(-0.04, 0, 0)):
        hanging(b, build)


def basket(b):
    def build():
        arch = [(-0.17 + 0.34 * k / 6, -0.02 - 0.18 * (1 - math.sin(math.pi * k / 6))) for k in range(7)]
        for (x0, y0), (x1, y1) in zip(arch, arch[1:]):
            b.rod((x0, y0, 0), (x1, y1, 0), 0.008, 0.008, 4, "fuse")
        b.lathe([(-0.34, 0.14), (-0.2, 0.18), (-0.2, 0.17), (-0.3, 0.0)], 10, "fuse", cap_mat="cork")
        b.lathe([(-0.215, 0.181), (-0.195, 0.184)], 10, "cork", caps=(False, False))
        b.ball((0.05, -0.22, 0.03), 0.05, "paint.red", n=6, rows=3)
        b.ball((-0.06, -0.225, -0.02), 0.045, "parchment", n=6, rows=3)
    hanging(b, build)


def tankard(b):
    with b.at(T(0.075, 0, 0)):
        b.lathe([(-0.07, 0.048), (0.07, 0.052), (0.07, 0.046), (-0.06, 0.0)], 10, "wood", cap_mat="cork")
        for y in (-0.05, 0.05):
            b.lathe([(y - 0.008, 0.052 + y * 0.03), (y + 0.008, 0.053 + y * 0.03)], 10, "brass", caps=(False, False))
    for y0, y1 in ((0.05, 0.05), (-0.05, -0.05)):
        b.box((-0.005, y0 - 0.01, -0.01), (0.03, y1 + 0.01, 0.01), "wood")
    b.box((-0.012, -0.06, -0.01), (0.0, 0.06, 0.01), "wood")


def ledger(b):
    w, h, t = 0.16, 0.22, 0.045
    b.box((-w / 2, -h / 2, 0.0), (w / 2, h / 2, 0.006), "leather")
    b.box((-w / 2 + 0.006, -h / 2 + 0.006, 0.006), (w / 2 - 0.004, h / 2 - 0.006, t - 0.006), "parchment")
    b.box((-w / 2, -h / 2, t - 0.006), (w / 2, h / 2, t), "leather")
    b.box((-w / 2 - 0.004, -h / 2, 0.0), (-w / 2 + 0.006, h / 2, t), "leather")
    b.box((w / 2 - 0.004, -0.015, -0.002), (w / 2 + 0.006, 0.015, t + 0.002), "brass")


def broom(b):
    haft(b, -0.5, 0.65, 0.015)
    b.lathe([(-0.52, 0.03), (-0.47, 0.025)], 6, "fuse")
    b.lathe([(-FOOT, 0.09), (-0.62, 0.075), (-0.5, 0.03)], 8, "fuse")
    b.lathe([(-0.57, 0.062), (-0.55, 0.058)], 8, "leather", caps=(False, False))


def walking_stick(b):
    haft(b, -0.85, 0.16, 0.014, mat="wood.dark")
    b.ball((0, 0.18, 0), 0.026, "wood", n=6, rows=3)
    b.lathe([(-0.88, 0.0), (-0.85, 0.015)], 5, "iron", caps=(False, True))


def pickaxe(b):
    haft(b, -0.16, 0.64, 0.017)
    with b.at(T(0, 0.58, 0)):
        b.lathe([(-0.04, 0.024), (0.04, 0.024)], 6, "iron")
        for side in (1, -1):  # a pointed pick each way along X, curving down toward the hand
            path = [(0.02, 0.0, 0.022), (0.1, -0.008, 0.018), (0.17, -0.03, 0.012), (0.22, -0.065, 0.0)]
            for (x0, y0, r0), (x1, y1, r1) in zip(path, path[1:]):
                b.rod((side * x0, y0, 0), (side * x1, y1, 0), r0, r1, 4, "iron")


def sickle(b):
    b.lathe([(-0.08, 0.0), (-0.075, 0.016), (0.05, 0.015)], 6, "wood")
    b.lathe([(0.05, 0.017), (0.075, 0.015)], 6, "iron")
    # A crescent in the X-Y plane from the ferrule, over the top and round toward +X; the edge is on the inside.
    cx, cy, radius, steps = 0.12, 0.09, 0.12, 9
    outer, inner = [], []
    for k in range(steps + 1):
        u = k / steps
        a = math.pi - u * math.pi * 1.05
        w = 0.036 * (1 - u) ** 0.6 + 0.004 * (1 - u)
        outer.append((cx + radius * math.cos(a), cy + 0.02 + radius * math.sin(a)))
        inner.append((cx + (radius - w) * math.cos(a), cy + 0.02 + (radius - w) * math.sin(a)))
    with b.at(T(0, -0.04, 0)):
        b.prism(outer[::-1] + inner[1:-1], -0.002, 0.002, "steel")


def skinning_knife(b):
    b.lathe([(-0.065, 0.0), (-0.06, 0.014), (-0.02, 0.016), (0.03, 0.014), (0.05, 0.015)], 6, "bone")
    b.lathe([(0.05, 0.016), (0.06, 0.014)], 6, "iron")
    blade(b, 0.12, 0.016, 0.004, "steel", base=0.06, tip=0.35, curve=0.25, single=True, widen=1.5)


def hand_saw(b):
    # An open pistol handle round the grip; the blade tapers along +Y, its teeth on the +X edge.
    b.prism([(-0.022, -0.075), (0.02, -0.08), (0.03, -0.06), (0.024, 0.045), (0.1, 0.06), (0.1, 0.11), (-0.03, 0.11), (-0.035, 0.03),
             (-0.016, 0.0)], -0.012, 0.012, "wood")
    edge = [(0.095 - 0.045 * k / 12, 0.11 + 0.38 * k / 12) for k in range(13)]
    teeth = []
    for k, (x, y) in enumerate(edge):
        teeth.append((x + (0.008 if k % 2 else 0.0), y))
    b.prism([(-0.02, 0.1)] + teeth + [(0.0, 0.49)], -0.0012, 0.0012, "steel")
    for y in (0.07, 0.095):
        with b.at(T(0.04, y, 0) @ rot("X", 90)):
            b.lathe([(-0.014, 0.006), (0.014, 0.006)], 5, "brass")


def mallet(b):
    haft(b, -0.12, 0.27, 0.014)
    with b.at(T(0, 0.31, 0) @ rot("Z", -90)):  # the head's end-grain faces toward ±X
        b.lathe([(-0.075, 0.042), (-0.07, 0.046), (0.07, 0.046), (0.075, 0.042)], 8, "wood", cap_mat="wood.dark")


def rake(b):
    haft(b, -FOOT, 0.95, 0.016)
    b.box((-0.26, 0.95, -0.016), (0.26, 0.985, 0.016), "wood")
    for x in (-0.1, 0.1):
        b.rod((0, 0.75, 0), (x, 0.96, 0), 0.008, 0.008, 4, "wood")
    for k in range(9):  # the teeth point to +Z, like the hoe's blade
        x = -0.22 + 0.055 * k
        b.rod((x, 0.967, 0.012), (x, 0.94, 0.1), 0.006, 0.0, 4, "wood")


def scythe(b):
    haft(b, -FOOT, 0.72, 0.017)
    for y in (0.06, 0.55):  # the two nibs toward +Z; the lower sits just above the fist
        b.rod((0, y, 0.012), (0, y, 0.13), 0.012, 0.011, 5, "wood")
    b.lathe([(-FOOT - 0.01, 0.022), (-FOOT + 0.06, 0.02)], 6, "iron")
    # The blade at the foot runs out along +X, flat in the X-Z plane, curving toward +Z, the edge on its +Z side.
    spine, edge, steps = [], [], 10
    for k in range(steps + 1):
        u = k / steps
        x = 0.02 + 0.66 * u
        z = 0.14 * u * u
        w = 0.07 * (1 - u) ** 0.7 + 0.01 * (1 - u)
        spine.append((x, z))
        edge.append((x, z + w))
    with b.at(T(0, -FOOT + 0.015, 0) @ rot("X", 90)):
        b.prism(spine + edge[-2::-1], -0.003, 0.003, "steel")


# ---------------------------------------------------------------- heavy weapons (#719)
# The two-handers ride hand_r.weapon like the maul: the right hand under the head, the left on ``grip.offhand`` 0.22 m
# below, where the TwoHand clips hold it. The polearms ride hand_r.staff like the spears, the foot ``FOOT`` below.

def heavy_haft(b, y0, y1, r, mat="wood", grip=(-0.3, 0.06)):
    """A thick two-hand haft with a leather wrap over both hands and an iron butt cap."""
    b.lathe([(y0, r * 0.95), (y1, r)], 6, mat)
    if grip:
        b.lathe([(grip[0], r + 0.003), (grip[1], r + 0.003)], 6, "leather")
    b.lathe([(y0 - 0.03, 0.0), (y0, r + 0.002)], 6, "iron", caps=(False, True))


def langets(b, y0, y1, r):
    """Iron strips down both edges (±X) of a haft below a head."""
    for x in (-r, r):
        b.box((x - 0.005, y0, -0.008), (x + 0.005, y1, 0.008), "iron")


def sword_great(b):
    # A zweihänder: a long grip for both hands, a wide guard with upswept quillons, a leather-wrapped ricasso with
    # parrying lugs and a broad blade.
    b.lathe([(-0.34, 0.016), (-0.12, 0.019), (0.1, 0.017)], 6, "leather")
    b.ball((0, -0.37, 0), 0.032, "iron", n=6, rows=4, squash=(1, 1.3, 1))
    b.box((-0.2, 0.1, -0.016), (0.2, 0.13, 0.016), "iron")
    for side in (1, -1):
        b.rod((side * 0.19, 0.115, 0), (side * 0.25, 0.17, 0), 0.016, 0.009, 4, "iron")
    b.box((-0.024, 0.13, -0.012), (0.024, 0.27, 0.012), "leather")
    b.prism([(0.024, 0.27), (0.085, 0.3), (0.024, 0.31)], -0.007, 0.007, "steel")
    b.prism([(-0.024, 0.27), (-0.024, 0.31), (-0.085, 0.3)], -0.007, 0.007, "steel")
    blade(b, 0.92, 0.034, 0.009, "steel", base=0.27, tip=0.12)


def axe_great(b):
    # A long-hafted bearded great axe: a wide steel head toward +X with a deep beard, a back spike and a top spike.
    heavy_haft(b, -0.33, 1.0, 0.019)
    langets(b, 0.72, 0.84, 0.019)
    with b.at(T(0, 0.9, 0)):
        b.prism([(-0.03, -0.05), (0.07, -0.05), (0.14, -0.2), (0.25, -0.27), (0.28, -0.1), (0.28, 0.05), (0.25, 0.13), (0.12, 0.07),
                 (0.05, 0.05), (-0.03, 0.05)], -0.011, 0.011, "steel")
        b.lathe([(-0.07, 0.025), (0.07, 0.025)], 6, "iron")
        b.rod((-0.02, 0, 0), (-0.13, -0.02, 0), 0.02, 0.0, 4, "iron")
    b.rod((0, 0.97, 0), (0, 1.1, 0), 0.017, 0.0, 4, "iron")


def hammer_great(b):
    # A lucerne hammer: a four-pronged hammer face toward +X, a long fluke curving down behind and a top spike.
    heavy_haft(b, -0.33, 1.02, 0.019)
    langets(b, 0.72, 0.88, 0.019)
    with b.at(T(0, 0.95, 0)):
        b.lathe([(-0.08, 0.026), (0.08, 0.026)], 6, "iron")
        b.box((0.02, -0.04, -0.04), (0.11, 0.04, 0.04), "steel")
        for dy in (-0.025, 0.025):
            for dz in (-0.025, 0.025):
                b.rod((0.11, dy, dz), (0.15, dy * 1.2, dz * 1.2), 0.013, 0.0, 4, "steel")
        path = [(-0.02, 0.0, 0.026), (-0.1, -0.01, 0.02), (-0.17, -0.04, 0.012), (-0.22, -0.09, 0.0)]
        for (x0, y0, r0), (x1, y1, r1) in zip(path, path[1:]):
            b.rod((x0, y0, 0), (x1, y1, 0), r0, r1, 4, "steel")
    b.rod((0, 1.0, 0), (0, 1.2, 0), 0.02, 0.0, 4, "steel")


def polearm_halberd(b):
    # An axe blade toward +X, a back hook toward -X and a spike on top, on a long haft with langets.
    haft(b, -FOOT, 1.12, 0.019)
    b.lathe([(-FOOT - 0.06, 0.0), (-FOOT, 0.02)], 6, "iron", caps=(False, True))
    langets(b, 0.78, 0.96, 0.019)
    with b.at(T(0, 1.03, 0)):
        b.prism([(0.0, -0.1), (0.06, -0.1), (0.21, -0.18), (0.23, -0.05), (0.23, 0.08), (0.21, 0.15), (0.06, 0.06), (0.0, 0.06)],
                -0.008, 0.008, "steel")
        b.lathe([(-0.11, 0.024), (0.09, 0.024)], 6, "iron")
        path = [(-0.02, 0.0, 0.018), (-0.1, 0.01, 0.014), (-0.17, 0.05, 0.008), (-0.2, 0.11, 0.0)]
        for (x0, y0, r0), (x1, y1, r1) in zip(path, path[1:]):
            b.rod((x0, y0, 0), (x1, y1, 0), r0, r1, 4, "steel")
    blade(b, 0.26, 0.022, 0.008, "steel", base=1.12, tip=0.5)


def polearm_glaive(b):
    # A long single-edged blade on a pole, curving toward its +X edge, with a back spur at its base.
    haft(b, -FOOT, 0.88, 0.019, mat="wood.dark")
    b.lathe([(-FOOT - 0.03, 0.0), (-FOOT, 0.02)], 6, "iron", caps=(False, True))
    langets(b, 0.66, 0.82, 0.019)
    b.lathe([(0.8, 0.024), (0.9, 0.021)], 6, "iron")
    b.rod((-0.015, 0.92, 0), (-0.09, 0.97, 0), 0.016, 0.0, 4, "steel")
    blade(b, 0.42, 0.036, 0.009, "steel", base=0.9, tip=0.3, curve=0.12, single=True, widen=1.35)


def spear_pike(b):
    # A long ash pike: a shaft tapering to a small leaf head with long langets, an iron butt cap.
    b.lathe([(-FOOT, 0.018), (1.78, 0.013)], 6, "wood")
    b.lathe([(-FOOT - 0.03, 0.0), (-FOOT, 0.019)], 6, "iron", caps=(False, True))
    langets(b, 1.5, 1.76, 0.0135)
    b.lathe([(1.74, 0.017), (1.84, 0.014)], 6, "iron")
    blade(b, 0.2, 0.021, 0.006, "steel", base=1.84, tip=0.5, widen=0.9)


# ---------------------------------------------------------------- carried loads (#735)
# Two-handed loads on chest.carry (docs/humanoid-sockets.md): the origin is the middle of the load's face against the
# chest, +Y up, +Z out of the chest. Carry_Idle_Loop and Carry_Walk_Loop put the palms on the load's sides at
# (±0.18, −0.08, 0.12), so every load is 0.36 m wide there and only flares above the forearms.


def oval(y, ax, az, n, cz, power=2.5, wobble=0.0, lobes=5, phase=0.0):
    """A ring at height ``y`` round (0, y, cz), wound like ``lathe``: a superellipse with half-widths ``ax`` (X) and
    ``az`` (Z), its radius rippled by ``wobble`` with ``lobes`` waves."""
    ring = []
    for s in range(n):
        a = 2 * math.pi * s / n
        c, d = math.cos(a), math.sin(a)
        k = (abs(c) ** power + abs(d) ** power) ** (-1 / power) * (1 + wobble * math.sin(lobes * a + phase))
        ring.append((ax * c * k, y, cz - az * d * k))
    return ring


def apples(b, spots, mats=("paint.red",)):
    for k, (x, y, z, r) in enumerate(spots):
        b.ball((x, y, z), r, mats[k % len(mats)], n=8, rows=4, squash=(1, 0.88, 1))


def load_crate(b):
    # A slatted crate, 0.36 × 0.26 × 0.26 m like the clips' reference crate, heaped with apples.
    w, h, d = 0.18, 0.13, 0.26
    for x in (-w + 0.015, w - 0.015):
        for z in (0.015, d - 0.015):
            b.box((x - 0.015, -h, z - 0.015), (x + 0.015, h, z + 0.015), "wood.dark")
    for y in (-0.085, 0.0, 0.085):
        for x in (-w, w - 0.012):
            b.box((x, y - 0.026, 0.03), (x + 0.012, y + 0.026, d - 0.03), "wood")
        for z in (0.0, d - 0.012):
            b.box((-w + 0.03, y - 0.026, z), (w - 0.03, y + 0.026, z + 0.012), "wood")
    b.box((-w + 0.012, -h + 0.005, 0.012), (w - 0.012, 0.1, d - 0.012), "wood.dark")
    apples(b, [(-0.1, 0.125, 0.07, 0.045), (0.0, 0.135, 0.08, 0.048), (0.1, 0.125, 0.065, 0.045), (-0.09, 0.13, 0.18, 0.046),
               (0.015, 0.14, 0.17, 0.05), (0.11, 0.125, 0.19, 0.044), (-0.04, 0.17, 0.125, 0.044)])


def load_sack(b):
    # A slumped burlap grain sack, gathered and tied at the neck with a tuft above the cord.
    n, cz = 12, 0.14
    profile = [(-0.21, 0.135, 0.085, 0.02), (-0.18, 0.185, 0.11, 0.05), (-0.08, 0.18, 0.13, 0.04), (0.0, 0.163, 0.12, 0.06),
               (0.08, 0.122, 0.098, 0.06), (0.15, 0.062, 0.05, 0.02), (0.185, 0.035, 0.03, 0.0), (0.2, 0.035, 0.03, 0.0)]
    rings = [oval(y, ax, az, n, cz + 0.08 * max(0.0, y) + 0.35 * max(0.0, -0.08 - y), wobble=wob, lobes=3, phase=y * 9) for y, ax, az, wob in profile]
    b.loft(rings, "parchment", caps=(True, False))
    top = cz + 0.016
    b.loft([oval(0.2, 0.035, 0.03, n, top), oval(0.225, 0.065, 0.055, n, top + 0.005, wobble=0.15, lobes=4),
            oval(0.245, 0.045, 0.04, n, top + 0.01, wobble=0.2, lobes=4), [(0.0, 0.252, top + 0.01)]], "parchment", caps=(False, False))
    b.loft([oval(0.178, 0.046, 0.04, 8, cz + 0.015, power=2), oval(0.204, 0.046, 0.04, 8, cz + 0.016, power=2)], "fuse", caps=(False, False))


def load_firewood(b):
    # A bundle of split logs, ends out from the chest, tied with two ropes.
    logs = [(-0.12, -0.1, 0.05), (-0.04, -0.105, 0.05), (0.04, -0.1, 0.05), (0.12, -0.105, 0.05),
            (-0.085, -0.015, 0.048), (0.0, -0.02, 0.05), (0.085, -0.015, 0.048), (-0.04, 0.07, 0.046), (0.045, 0.068, 0.046)]
    for k, (x, y, r) in enumerate(logs):
        turn = 0.7 * k
        if k % 3 == 1:  # a split quarter: the bark arc and the two split faces
            outline = [(x + 0.35 * r * math.cos(turn + math.pi), y + 0.35 * r * math.sin(turn + math.pi))]
            outline += [(x + r * math.cos(turn + a), y + r * math.sin(turn + a)) for a in (-1.3, -0.45, 0.45, 1.3)]
        else:
            outline = [(x + r * (0.82 + 0.18 * ((3 * i + k) % 4) / 3) * math.cos(turn + 2 * math.pi * i / 6),
                        y + r * (0.82 + 0.18 * ((3 * i + k) % 4) / 3) * math.sin(turn + 2 * math.pi * i / 6)) for i in range(6)]
        b.prism(outline, 0.01 + 0.02 * (k % 3), 0.47 + 0.025 * ((2 * k) % 3), "wood", cap_mat="parchment")
    for z in (0.22, 0.4):
        with b.at(T(0, -0.02, z) @ rot("X", 90) @ Matrix.Diagonal((0.178, 1, 0.142, 1))):
            b.lathe([(-0.012, 1.0), (0.012, 1.0)], 10, "fuse", caps=(False, False))


def load_hay(b):
    # An armful of loose hay: narrow where the hands hold it, bulging wide across the forearms with a ragged outline,
    # and tufts of flat stalks fanning out of the bulge and drooping at their tips.
    n, cz = 18, 0.15
    profile = [(-0.13, 0.11, 0.08, 0.04), (-0.105, 0.165, 0.12, 0.05), (-0.08, 0.172, 0.135, 0.03), (-0.04, 0.19, 0.145, 0.06),
               (0.01, 0.225, 0.15, 0.1), (0.06, 0.255, 0.142, 0.12), (0.11, 0.21, 0.115, 0.12), (0.15, 0.12, 0.07, 0.1)]
    rings = [oval(y, ax, az, n, cz, power=2.2, wobble=wob, lobes=7 + 2 * (k % 2), phase=1.7 * k) for k, (y, ax, az, wob) in enumerate(profile)]
    b.loft(rings + [[(0.0, 0.17, cz)]], "fuse", cap_mat="fuse")
    for k in range(16):
        a = 2 * math.pi * k / 16 + 0.2
        if math.sin(a) > 0.3:  # none toward the chest
            continue
        y = 0.0 + 0.05 * ((5 * k) % 3)
        base = Vector((0.2 * math.cos(a), y, cz - 0.12 * math.sin(a)))
        length = 0.11 + 0.03 * ((7 * k) % 3)
        for s in (-1, 0, 1):
            turn = a + 0.22 * s
            out = Vector((math.cos(turn), -0.3 + 0.15 * s * s, -0.8 * math.sin(turn))).normalized()
            side = Vector((0, 1, 0)).cross(out).normalized() * 0.014
            b.face(b.add([base - side, base + side, base + out * length]), "parchment" if (k + s) % 2 else "fuse")


def load_basket_large(b):
    # A two-handled oval wicker harvest basket: narrow at the base where the hands hold it, flaring to a rolled rim,
    # heaped with apples and turnips.
    n, cz = 16, 0.16

    def wall(y):
        u = (y + 0.14) / 0.22
        return oval(y, 0.15 + 0.075 * u, 0.1 + 0.05 * u, n, cz)
    heights = [-0.14, -0.1, -0.06, -0.02, 0.02, 0.06]
    for k, (y0, y1) in enumerate(zip(heights, heights[1:])):
        b.loft([wall(y0), wall(y1)], "fuse" if k % 2 == 0 else "cork", caps=(False, False))
    b.face(list(reversed(b.add(wall(-0.14)))), "cork")
    b.loft([wall(0.06), oval(0.075, 0.232, 0.156, n, cz), oval(0.085, 0.222, 0.146, n, cz), oval(0.07, 0.212, 0.138, n, cz)], "cork", caps=(False, False))
    b.face(b.add(oval(0.062, 0.21, 0.138, n, cz)), "wood.dark")
    apples(b, [(-0.12, 0.08, 0.13, 0.045), (-0.05, 0.09, 0.09, 0.047), (0.03, 0.085, 0.12, 0.045), (0.11, 0.08, 0.17, 0.046),
               (-0.07, 0.085, 0.21, 0.044), (0.02, 0.095, 0.21, 0.048), (0.13, 0.075, 0.09, 0.042), (-0.01, 0.125, 0.15, 0.046)],
           ("paint.red", "parchment", "paint.red", "bone"))
    for side in (1, -1):
        loop = [(side * 0.215, 0.075, 0.115), (side * 0.245, 0.08, 0.125), (side * 0.255, 0.085, 0.16), (side * 0.245, 0.08, 0.195), (side * 0.215, 0.075, 0.205)]
        for p, q in zip(loop, loop[1:]):
            b.rod(p, q, 0.011, 0.011, 4, "fuse")


def load_water_jug(b):
    # A big unglazed clay jug hugged to the chest: a round belly, a narrow neck with a lip and stopper, two pale slip
    # bands and a strap handle on the far side.
    cz = 0.185
    with b.at(T(0, 0, cz)):
        b.lathe([(-0.2, 0.0), (-0.2, 0.11), (-0.16, 0.158), (-0.08, 0.185), (0.0, 0.178), (0.07, 0.14), (0.115, 0.075), (0.14, 0.046),
                 (0.185, 0.044), (0.198, 0.056), (0.205, 0.05)], 12, "cork", caps=(False, True))
        for y, r in ((-0.02, 0.184), (0.03, 0.165)):
            b.lathe([(y - 0.008, r + 0.002), (y + 0.008, r + 0.001)], 12, "bone", caps=(False, False))
        b.lathe([(0.195, 0.036), (0.232, 0.032)], 8, "wood")
    handle = [(0, 0.17, cz + 0.042), (0, 0.18, cz + 0.1), (0, 0.15, cz + 0.145), (0, 0.085, cz + 0.155)]
    for p, q in zip(handle, handle[1:]):
        b.rod(p, q, 0.013, 0.013, 5, "cork")


# ---------------------------------------------------------------- Greyhaven named finds (#760)
# Recognisable named weapons on their family's grip and role, each with its own silhouette and materials, no glow.

def wrapped(b, y0, y1, r, mat, step=0.03, n=6):
    """A wrap of raised turns around a haft or grip from ``y0`` to ``y1``."""
    turns = max(1, round((y1 - y0) / step))
    profile = []
    for k in range(turns + 1):
        y = y0 + (y1 - y0) * k / turns
        profile += [(y, r + 0.0015)] if k in (0, turns) else [(y - 0.004, r + 0.0035), (y + 0.004, r + 0.0015)]
    b.lathe(profile, n, mat)


def feather(b, length, width):
    """A flat feather along +Y from the origin, a thin lozenge section widest a third of the way out."""
    rings = [[(w, length * u, 0), (0, length * u, -0.0015), (-w, length * u, 0), (0, length * u, 0.0015)]
             for u, w in ((0.0, 0.002), (0.35, width), (0.8, width * 0.7))]
    b.loft(rings + [[(0, length, 0)]], "feather")


def garricks_cleaver(b):
    """Garrick Redbrand's falchion: a broad chopping blade with a straight, thick iron-shod back, two notches in the
    edge from hard use and a clipped point; a red-wrapped grip under a short, heavy guard."""
    wrapped(b, -0.075, 0.05, 0.015, "paint.red", step=0.025)
    b.box((-0.06, 0.05, -0.017), (0.07, 0.074, 0.017), "iron")
    with b.at(T(0, -0.09, 0) @ rot("X", 90)):
        b.lathe([(-0.012, 0.026), (0.012, 0.026)], 8, "iron")
    top, length, back = 0.074, 0.6, -0.014
    notches = (0.38, 0.66)
    us = sorted({k / 12 for k in range(13)} | {c + d for c in notches for d in (-0.025, 0.0, 0.025)})
    rings = []
    for u in us:
        edge = 0.036 + 0.075 * min(1.0, u / 0.8) ** 0.8
        edge -= sum(0.016 * max(0.0, 1 - abs(u - c) / 0.025) for c in notches)
        spine = back if u <= 0.86 else back + (edge - 0.012 - back) * ((u - 0.86) / 0.14) ** 1.3
        if u == 1.0:
            edge -= 0.004
        mid = spine + (edge - spine) * 0.4
        y = top + length * u
        rings.append([(edge, y, 0), (mid, y, -0.006), (spine, y, -0.008), (spine, y, 0.008), (mid, y, 0.006)])
    b.loft(rings, "steel")
    b.box((back - 0.004, top, -0.0095), (back + 0.007, top + length * 0.84, 0.0095), "iron")


def hollowpine_spear(b):
    """A hunter's spear: a long pale ash shaft, a broad leaf blade above a crossguard of two bound boar tusks, and
    feather tufts hanging from the socket on leather thongs."""
    b.lathe([(-FOOT, 0.0165), (1.2, 0.0145)], 7, "wood.ash")
    b.lathe([(-FOOT - 0.025, 0.0), (-FOOT, 0.018)], 7, "iron", caps=(False, True))
    wrapped(b, -0.12, 0.1, 0.016, "leather", step=0.055, n=7)
    b.lathe([(1.18, 0.0175), (1.28, 0.0135)], 7, "iron")
    wrapped(b, 1.15, 1.205, 0.017, "leather", step=0.018, n=7)
    for s in (-1, 1):  # the tusks curve out along ±X and up toward the blade
        path = [(0.012 * s, 1.18), (0.06 * s, 1.165), (0.105 * s, 1.185), (0.13 * s, 1.235)]
        radii = [0.013, 0.011, 0.007, 0.0]
        for (p, q), r0, r1 in zip(zip(path, path[1:]), radii, radii[1:]):
            b.rod((p[0], p[1], 0), (q[0], q[1], 0), r0, r1, 5, "bone")
    rings, length, width = [], 0.36, 0.044
    for k in range(9):
        u = k / 8
        y = 1.28 + length * u
        if k == 8:
            rings.append([(0, y, 0)])
            continue
        w = width * math.sin(math.pi * min(1.0, (u + 0.08) / 1.05) ** 0.75) + 0.008 * (1 - u)
        t = 0.008 * (1 - 0.6 * u)
        rings.append([(w, y, 0), (0, y, -t), (-w, y, 0), (0, y, t)])
    b.loft(rings, "steel")
    for s in (-1, 1):  # two thongs, each ending in a tuft of three feathers
        knot = (0.028 * s, 1.07, 0.0)
        b.rod((0.014 * s, 1.16, 0), knot, 0.003, 0.003, 4, "leather")
        for k, lean in enumerate((-14, 0, 14)):
            with b.at(T(*knot) @ rot("Z", 180 + s * (8 + lean)) @ rot("Y", 60 * k)):
                feather(b, 0.13, 0.012)


def millbrook_mace(b):
    """The Millbrook smith's mace: a tall head of seven stepped steel flanges on an iron core, a short finial, a brass
    plate struck with the smithy's stamp, and a haft wrapped in leather from pommel to collar."""
    b.lathe([(-0.15, 0.0), (-0.14, 0.022), (-0.115, 0.024), (-0.105, 0.016)], 7, "iron", caps=(False, True))
    wrapped(b, -0.105, 0.315, 0.016, "leather", step=0.05, n=6)
    b.lathe([(0.31, 0.021), (0.37, 0.024)], 7, "iron")
    b.box((-0.014, 0.322, 0.022), (0.014, 0.356, 0.028), "brass")
    b.box((-0.006, 0.33, 0.028), (0.006, 0.348, 0.0305), "iron")  # the stamp: a struck anvil mark
    b.lathe([(0.37, 0.022), (0.55, 0.02), (0.56, 0.0)], 7, "iron", caps=(True, False))
    outline = [(0.0, 0.37), (0.035, 0.38), (0.07, 0.43), (0.05, 0.47), (0.072, 0.53), (0.0, 0.55)]
    for k in range(7):
        with b.at(rot("Y", 360 * k / 7)):
            b.prism(outline, -0.005, 0.005, "steel")
    b.lathe([(0.55, 0.012), (0.6, 0.0)], 5, "steel", caps=(True, False))
# ---------------------------------------------------------------- catalogue

# item: (builder, roles, frames beyond grip as {name: (x, y, z)}, triangle budget)
ITEMS = {
    "sword.footman": (sword_footman, ["one-hand-weapon"], {}, 400),
    "sword.falchion": (sword_falchion, ["one-hand-weapon"], {}, 400),
    "sword.longsword": (sword_longsword, ["one-hand-weapon", "two-hand-weapon"], {"grip.offhand": (0, -0.13, 0)}, 400),
    "sword.bastard": (sword_bastard, ["one-hand-weapon", "two-hand-weapon"], {"grip.offhand": (0, -0.1, 0)}, 400),
    "dagger.plain": (dagger_plain, ["one-hand-weapon"], {}, 300),
    "dagger.seax": (dagger_seax, ["one-hand-weapon"], {}, 300),
    "axe.battle": (axe_battle, ["one-hand-weapon"], {}, 300),
    "axe.bearded": (axe_bearded, ["one-hand-weapon"], {}, 300),
    "axe.hand": (axe_hand, ["one-hand-weapon"], {}, 300),
    "mace.studded": (mace_studded, ["one-hand-weapon"], {}, 500),
    "mace.morningstar": (mace_morningstar, ["one-hand-weapon"], {}, 500),
    "warhammer.horseman": (warhammer_horseman, ["one-hand-weapon"], {}, 300),
    "warhammer.maul": (warhammer_maul, ["one-hand-weapon", "two-hand-weapon"], {"grip.offhand": (0, -0.22, 0)}, 300),
    "spear.leaf": (spear_leaf, ["staff", "spear"], {"grip.offhand": (0, 0.45, 0)}, 300),
    "spear.boar": (spear_boar, ["staff", "spear"], {"grip.offhand": (0, 0.45, 0)}, 300),
    "staff.quarter": (staff_quarter, ["staff"], {"grip.offhand": (0, 0.55, 0)}, 300),
    "staff.crook": (staff_crook, ["staff"], {}, 400),
    "shield.round": (shield_round, ["shield"], {}, 600),
    "shield.buckler": (shield_buckler, ["shield"], {}, 400),
    "shield.kite": (shield_kite, ["shield"], {}, 300),
    "tool.lantern": (lantern, ["one-hand-weapon", "carried"], {}, 400),
    "tool.torch": (torch, ["one-hand-weapon", "tool"], {}, 200),
    "tool.pitchfork": (pitchfork, ["staff", "tool"], {"grip.offhand": (0, 0.5, 0)}, 200),
    "tool.hoe": (hoe, ["staff", "tool"], {"grip.offhand": (0, 0.5, 0)}, 200),
    "tool.shovel": (shovel, ["staff", "tool"], {"grip.offhand": (0, 0.47, 0)}, 300),
    "tool.fishing-rod": (fishing_rod, ["staff", "tool"], {}, 200),
    "tool.wood-axe": (wood_axe, ["one-hand-weapon", "tool"], {"grip.offhand": (0, -0.12, 0)}, 200),
    "tool.hammer": (hammer, ["one-hand-weapon", "tool"], {}, 200),
    "tool.bucket": (bucket, ["one-hand-weapon", "carried"], {}, 400),
    "tool.basket": (basket, ["one-hand-weapon", "carried"], {}, 400),
    "tool.tankard": (tankard, ["one-hand-weapon", "carried"], {}, 300),
    "book.ledger": (ledger, ["book"], {}, 100),
    "tool.broom": (broom, ["staff", "tool"], {"grip.offhand": (0, 0.45, 0)}, 200),
    "tool.walking-stick": (walking_stick, ["staff", "tool"], {}, 100),
    "tool.pickaxe": (pickaxe, ["one-hand-weapon", "tool"], {"grip.offhand": (0, -0.12, 0)}, 300),
    "tool.sickle": (sickle, ["one-hand-weapon", "tool"], {}, 200),
    "tool.skinning-knife": (skinning_knife, ["one-hand-weapon", "tool"], {}, 200),
    "tool.hand-saw": (hand_saw, ["one-hand-weapon", "tool"], {}, 300),
    "tool.mallet": (mallet, ["one-hand-weapon", "tool"], {}, 200),
    "tool.rake": (rake, ["staff", "tool"], {"grip.offhand": (0, 0.5, 0)}, 300),
    "tool.scythe": (scythe, ["staff", "tool"], {"grip.offhand": (0, 0.55, 0.07)}, 300),
    "sword.great": (sword_great, ["one-hand-weapon", "two-hand-weapon"], {"grip.offhand": (0, -0.22, 0)}, 400),
    "axe.great": (axe_great, ["one-hand-weapon", "two-hand-weapon"], {"grip.offhand": (0, -0.22, 0)}, 300),
    "hammer.great": (hammer_great, ["one-hand-weapon", "two-hand-weapon"], {"grip.offhand": (0, -0.22, 0)}, 400),
    "polearm.halberd": (polearm_halberd, ["staff", "spear"], {"grip.offhand": (0, 0.45, 0)}, 400),
    "polearm.glaive": (polearm_glaive, ["staff", "spear"], {"grip.offhand": (0, 0.45, 0)}, 300),
    "spear.pike": (spear_pike, ["staff", "spear"], {"grip.offhand": (0, 0.45, 0)}, 300),
    "load.crate": (load_crate, ["load"], {}, 600),
    "load.sack": (load_sack, ["load"], {}, 400),
    "load.firewood": (load_firewood, ["load"], {}, 400),
    "load.hay": (load_hay, ["load"], {}, 400),
    "load.basket-large": (load_basket_large, ["load"], {}, 800),
    "load.water-jug": (load_water_jug, ["load"], {}, 400),
    # #760: Greyhaven's named finds, on their family's sockets.
    "sword.garricks-cleaver": (garricks_cleaver, ["one-hand-weapon"], {}, 500),
    "spear.hollowpine-hunter": (hollowpine_spear, ["staff", "spear"], {"grip.offhand": (0, 0.45, 0)}, 600),
    "mace.millbrook-smith": (millbrook_mace, ["one-hand-weapon"], {}, 600),
}


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "item"} or arguments["schemaVersion"] != 1 or arguments["item"] not in ITEMS:
        raise ValueError(f"held items takes schemaVersion 1 and an item of {sorted(ITEMS)}")
    if inputs:
        raise ValueError("held items takes no inputs")


def material(name):
    colour, metallic, roughness = MATERIALS[name]
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = next(n for n in result.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = (*colour, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    if name in ALPHA:
        shader.inputs["Alpha"].default_value = ALPHA[name]
        result.surface_render_method = "BLENDED"
    if name in EMISSIVE:
        shader.inputs["Emission Color"].default_value = (*colour, 1)
        shader.inputs["Emission Strength"].default_value = 1.0
    return result


def triangles(builder):
    """Triangulate every face in order: fans for quads and triangles, ``tessellate_polygon`` for larger loops (wound
    like the loop's own Newell normal)."""
    out = []
    for loop, mat in builder.faces:
        pts = [builder.verts[i] for i in loop]
        if len(loop) <= 4:
            tris = [(0, k, k + 1) for k in range(1, len(loop) - 1)]
        else:
            normal = Vector()
            for a, c in zip(pts, pts[1:] + pts[:1]):
                normal += Vector(((a.y - c.y) * (a.z + c.z), (a.z - c.z) * (a.x + c.x), (a.x - c.x) * (a.y + c.y)))
            tris = []
            for t in geometry.tessellate_polygon([pts]):
                if (pts[t[1]] - pts[t[0]]).cross(pts[t[2]] - pts[t[0]]).dot(normal) < 0:
                    t = (t[0], t[2], t[1])
                tris.append(tuple(t))
        out += [([loop[i] for i in t], mat) for t in tris]
    return out


def build(item):
    builder = Builder()
    ITEMS[item][0](builder)
    tris = triangles(builder)
    names = sorted({mat for _, mat in tris}, key=list(MATERIALS).index)
    mesh = bpy.data.meshes.new(f"{item}-geometry")
    mesh.from_pydata([(v.x, -v.z, v.y) for v in builder.verts], [], [t for t, _ in tris])
    for name in names:
        mesh.materials.append(material(name))
    for polygon, (_, mat) in zip(mesh.polygons, tris):
        polygon.material_index = names.index(mat)
        polygon.use_smooth = True
    mesh.set_sharp_from_angle(angle=SHARP_ANGLE)
    mesh.validate()
    return mesh, builder.verts, len(tris), names


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    item = arguments["item"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    mesh, verts, count, names = build(item)
    budget = ITEMS[item][3]
    if count > budget:
        raise ValueError(f"held item {item} has {count} triangles, over its budget of {budget}")
    obj = bpy.data.objects.new(item, mesh)
    grip = bpy.data.objects.new("grip", None)
    for o in (obj, grip):
        bpy.context.scene.collection.objects.link(o)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    grip.select_set(True)
    bpy.context.view_layer.objects.active = obj
    lows = [min(v[i] for v in verts) for i in range(3)]
    highs = [max(v[i] for v in verts) for i in range(3)]
    geometry_bytes = b"".join(float(c).hex().encode("ascii") + b"\n" for v in mesh.vertices for c in v.co)
    geometry_bytes += b"".join((",".join(str(i) for i in f.vertices) + ":" + str(f.material_index) + "\n").encode("ascii") for f in mesh.polygons)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    _, roles, frames, _ = ITEMS[item]
    return {"recipe": "held-items-v1", "item": item, "roles": roles, "frames": {k: list(v) for k, v in frames.items()},
            "unit": "meter", "axes": "right-handed-y-up", "origin": "grip", "gripNode": "grip", "triangleCount": count,
            "bounds": {"min": [round(c, 6) for c in lows], "max": [round(c, 6) for c in highs]},
            "materials": names, "geometrySha256": hashlib.sha256(geometry_bytes).hexdigest()}
