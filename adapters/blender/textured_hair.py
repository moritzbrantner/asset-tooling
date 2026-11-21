"""Textured hair kit (#557, docs/textured-hair-kit.md): curly, coily and braided hairstyles fitted to one head.

Original procedural geometry and textures; the only source is the fit target, the CC0 Universal Base Characters body
(``Superhero_<Male|Female>_FullBody``), read for its head and shoulders and never exported. Each piece is grown from the
scalp: a shell is cast outward from a point inside the skull, so it follows that head's own shape, and braids and
ringlets are draped over the head and shoulders as short ropes under gravity. Every piece sits on the same hairline
(forehead, temples, in front of, above and behind the ears, nape), placed from the head's own brows and ears.

``arguments["fit"]`` is ``male`` or ``female``; the declared inputs are ``body`` (the body glTF) and ``buffer`` (its
.bin). The output holds one static mesh object per piece at identity in the character's rest space (Blender's Z-up frame
of the glTF character), wearing ``MI_Hair_Textured`` (one shared, tintable atlas with a normal map) and, on the tied
pieces, the factor-only ``hair.tie``. The build adds the head skin and the chains (``scripts/build-textured-hair-kit.ts``).
All randomness is seeded.
"""
import json
import math
import os
import tempfile

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from numpy.random import RandomState

RECIPE = "textured-hair-kit-v1"
FITS = {"male": "Superhero_Male_FullBody", "female": "Superhero_Female_FullBody"}
HAIR = "MI_Hair_Textured"
TIE_NAME = "hair.tie"
TIE = ((.06, .03, .015, 1), .7)
ROUGHNESS = .62

# Atlas: three columns, every one tileable along V (the sampler repeats), so a strand or a shell runs any length.
ATLAS, NORMAL_SIZE = 1024, 512
COIL = (0.0, 0.5)    # two repeats of one coil tile, so any shell face up to a tile wide fits by a whole-tile shift
CURL = (0.5, 0.75)   # a ringlet's twisted strands, wrapped once round the tube
PLAIT = (0.75, 1.0)  # a three-strand plait, wrapped once round the tube
GUTTER = 4 / ATLAS
COIL_TILE_M = .045   # metres of shell per coil tile
PLAIT_PERIOD_M = .085  # metres of braid per V repeat (eight stitches)
CURL_PERIOD_M = .06

# Pieces, in output order.
PIECES = ("hair.short-coils", "hair.rounded-afro", "hair.cornrows", "hair.box-braids", "hair.box-braids-tied", "hair.loose-curls", "hair.curly-bun")


def smooth(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def unit(v):
    v = np.asarray(v, float)
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def noise3(p, seed, freq, octaves=3):
    """Smooth, seeded 3D noise in [-1, 1] from sums of random plane waves."""
    rng, out, amp, total = RandomState(seed), np.zeros(len(p)), 1.0, 0.0
    for octave in range(octaves):
        d = unit(rng.normal(size=(7, 3)))
        out += amp * np.sin(p @ d.T * freq * 2 ** octave + rng.rand(7) * math.tau).mean(axis=1)
        total += amp
        amp *= .5
    return out / total * 1.6


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "fit"} or arguments["schemaVersion"] != 1 or arguments["fit"] not in FITS:
        raise ValueError("the textured hair kit requires schemaVersion 1 and a fit of male or female")
    if set(inputs) != {"body", "buffer"}:
        raise ValueError("the textured hair kit takes exactly the inputs body and buffer")


# ---------------------------------------------------------------------------------------------------------------- head

def import_body(gltf_path, buffer_path):
    """The body without its textures (they are not inputs): images, textures and texture slots are dropped first."""
    document = json.load(open(gltf_path))
    for key in ("images", "textures", "samplers"):
        document.pop(key, None)
    for material in document.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        for key in [k for k in pbr if k.endswith("Texture")]:
            del pbr[key]
        for key in ("normalTexture", "occlusionTexture", "emissiveTexture"):
            material.pop(key, None)
    document["buffers"][0]["uri"] = os.path.abspath(buffer_path)
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "body.gltf")
        json.dump(document, open(path, "w"))
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH" and len(o.data.vertices) > 2000]
    body = max(meshes, key=lambda o: len(o.data.vertices))
    brows = next(o for o in new if o.type == "MESH" and o.name.startswith("Eyebrows"))
    return new, body, brows


class Head:
    """The fit target's head: landmarks, a scalp to cast onto and the body to drape against."""

    def __init__(self, body, brows):
        dg = bpy.context.evaluated_depsgraph_get()
        mesh = body.evaluated_get(dg).to_mesh()
        M = body.matrix_world
        co = np.array([tuple(M @ v.co) for v in mesh.vertices])
        group = body.vertex_groups["Head"].index
        head = np.array([sum(g.weight for g in v.groups if g.group == group) > .5 for v in body.data.vertices])
        tris = []
        mesh.calc_loop_triangles()
        for t in mesh.loop_triangles:
            tris.append(tuple(t.vertices))
        self.bvh = BVHTree.FromPolygons([Vector(c) for c in co], tris)
        body.evaluated_get(dg).to_mesh_clear()
        P = co[head]
        B = np.array([tuple(brows.matrix_world @ v.co) for v in brows.data.vertices])
        self.top = float(P[:, 2].max())
        self.brow = float(B[:, 2].max())
        reach = np.abs(P[:, 0]).max()
        ear = P[(np.abs(P[:, 0]) > .86 * reach) & (P[:, 2] > self.brow - .1)]
        self.ear_top, self.ear_bottom = float(ear[:, 2].max()), float(ear[:, 2].min())
        band = P[np.abs(P[:, 2] - (self.brow + .02)) < .008]
        self.center = np.array([0.0, float(band[:, 1].min() + band[:, 1].max()) / 2, self.brow - .004])
        azimuth = np.degrees(np.arctan2(np.abs(ear[:, 0]), -(ear[:, 1] - self.center[1])))
        self.ear_front, self.ear_back = float(np.percentile(azimuth, 3)), float(np.percentile(azimuth, 97))
        # The face's half width by height, in front of the ears, to keep strands off the cheeks.
        front = P[P[:, 1] < self.center[1] - .01]
        self.face_z = np.linspace(self.brow - .16, self.brow + .05, 22)
        self.face_w = np.array([np.abs(front[np.abs(front[:, 2] - z) < .006, 0]).max(initial=.04) for z in self.face_z])
        self.neck = self.ear_bottom - .065
        et, eb, f0, f1 = self.ear_top - self.brow, self.ear_bottom - self.brow, self.ear_front, self.ear_back
        # The hairline: height above the brows by angle round the head (0 the forehead, 180 the nape).
        self.hairline = np.array([
            (0, .05), (26, .048), (46, .04), (f0 - 26, .018), (f0 - 15, et - .014), (f0 - 8, et - .024), (f0 - 3, et - .004),
            (f0 + 2, et + .008), ((f0 + f1) / 2, et + .011), (f1 - 1, et + .008), (f1 + 6, et - .006), (f1 + 16, eb + .012),
            (148, eb - .01), (180, eb - .022)])
        # Smoothed over a few degrees, so the line round the ear curves instead of stepping.
        fine = np.arange(-30, 211)
        raw = np.interp(np.abs(((fine + 180) % 360) - 180), self.hairline[:, 0], self.hairline[:, 1])
        kernel = np.hanning(13)
        self.fine = np.convolve(raw, kernel / kernel.sum(), mode="same")[30:211]

    def line(self, phi):
        return self.brow + np.interp(np.abs(phi), np.arange(181), self.fine)

    def direction(self, a, e):
        """Unit direction from the centre: `a` degrees round the head (0 front, +90 the figure's left, +x), `e` up."""
        a, e = np.radians(a), np.radians(e)
        return np.stack([np.sin(a) * np.cos(e), -np.cos(a) * np.cos(e), np.sin(e) * np.ones_like(a)], axis=-1)

    def cast(self, d):
        """The scalp point and normal in direction `d` from the centre."""
        hit, normal, _, distance = self.bvh.ray_cast(Vector(self.center), Vector(d))
        if hit is None:
            raise ValueError(f"no scalp in direction {d}")
        n = np.array(normal)
        if n @ d < 0:
            n = -n
        return np.array(hit), n, distance

    def edge_elevation(self, a, lift=0.0):
        """The elevation at which the scalp, in column `a`, reaches the hairline (raised by `lift` metres)."""
        target = self.line(a) + lift
        lo, hi = -70.0, 89.0
        for _ in range(26):
            mid = (lo + hi) / 2
            if self.cast(self.direction(a, mid))[0][2] < target:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2

    def margin_at(self, p):
        """How far outside the body a hanging strand keeps: clothes on the shoulders, little on the skin."""
        return .016 if p[2] < self.neck else .004

    def outside(self, p, margin):
        """`p` pushed out of the body to at least `margin`, and off the face."""
        loc, normal, _, _ = self.bvh.find_nearest(Vector(p))
        # Only the head, neck and upper back push: the body is in a T-pose, and its shoulders move with the arms anyway.
        if loc is not None and (loc[2] > self.neck - .035 or abs(loc[0]) < .085):
            loc, normal = np.array(loc), np.array(normal)
            if (p - loc) @ normal < margin:
                p = loc + normal * margin
        if p[2] < self.neck + .02:
            # Below the jaw: round the neck and the collar, whatever the arms are doing.
            axis = np.array([0.0, self.center[1] + .012])
            rel = p[:2] - axis
            reach, need = np.linalg.norm(rel), .066 + margin
            if reach < need:
                p = p.copy()
                p[:2] = axis + (rel / reach if reach > 1e-9 else np.array([0, 1.0])) * need
        if p[1] < self.center[1] - .02 and self.face_z[0] < p[2] < self.line(0) - .004:
            half = np.interp(p[2], self.face_z, self.face_w) + margin
            if abs(p[0]) < half:
                p = p.copy()
                p[0] = math.copysign(half, p[0] if p[0] else 1.0)
        return p


# --------------------------------------------------------------------------------------------------------- geometry

class Piece:
    def __init__(self, name):
        self.name, self.v, self.f, self.uv, self.mat, self.n, self.tie_point = name, [], [], [], [], 0, None

    def add(self, verts, faces, uvs, material=0):
        """`faces` index `verts`; `uvs` is one (u, v) per face corner, in the same nesting as `faces`."""
        self.v.append(np.asarray(verts, float))
        for face, uv in zip(faces, uvs):
            self.f.append([i + self.n for i in face])
            self.uv.append(uv)
            self.mat.append(material)
        self.n += len(verts)

    def finish(self, materials):
        V = np.concatenate(self.v)
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(V.tolist(), [], self.f)
        me.validate(clean_customdata=False)
        layer = me.uv_layers.new(name="UVMap")
        uvs = [c for face in self.uv for c in face]
        layer.data.foreach_set("uv", np.array(uvs, float).ravel())
        me.polygons.foreach_set("material_index", self.mat)
        me.polygons.foreach_set("use_smooth", [True] * len(self.f))
        for m in materials:
            me.materials.append(m)
        # Triangulate here, on a fixed diagonal, so the exporter's own split cannot vary from run to run.
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="FIXED", ngon_method="EAR_CLIP")
        bm.to_mesh(me)
        bm.free()
        me.update()
        obj = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def coil_uv(face_uv):
    """Shift one shell face by whole coil tiles so it lies in the coil column (two tiles wide)."""
    tile = (COIL[1] - COIL[0]) / 2
    us = [u for u, _ in face_uv]
    span, room = max(us) - min(us), tile - 2 * GUTTER
    if span > room:
        # A rare long face (at a pole's seam): squeeze it across, about its middle, to fit one tile.
        mid = (max(us) + min(us)) / 2
        face_uv = [(mid + (u - mid) * room / span, v) for u, v in face_uv]
        us = [u for u, _ in face_uv]
    shift = -math.floor((min(us) - COIL[0] - GUTTER) / tile) * tile
    return [(u + shift, v) for u, v in face_uv]


def shell(piece, head, outer, seed, cols=44, rows=14, lift=None, uv_scale=1.0, tuck=.0022, pole=(180, 82)):
    """A cap from the hairline to the crown. `outer(points, normals, a, s)` gives the outer offset from the scalp along
    the normal for scalp points in columns `a` (degrees) at `s` (0 on the hairline, 1 at the crown pole)."""
    a = np.linspace(-180, 180, cols, endpoint=False) + 180 / cols
    s = np.concatenate([[0, .03, .075], np.linspace(.14, .93, rows - 3)])
    pole_dir = head.direction(np.array(pole[0]), np.array(pole[1]))
    grid, normals, scalp = np.zeros((len(s), cols, 3)), np.zeros((len(s), cols, 3)), np.zeros((len(s), cols, 3))
    for j, aj in enumerate(a):
        e0 = head.edge_elevation(aj, 0.0 if lift is None else lift(aj))
        d0 = head.direction(aj, e0)
        for i, si in enumerate(s):
            # Great-circle path from the hairline to the pole, so the cap closes at the crown's whorl.
            omega = math.acos(np.clip(d0 @ pole_dir, -1, 1))
            t = si
            d = (math.sin((1 - t) * omega) * d0 + math.sin(t * omega) * pole_dir) / math.sin(omega)
            p, n, _ = head.cast(unit(d))
            scalp[i, j], normals[i, j] = p, n
    off = outer(scalp.reshape(-1, 3), normals.reshape(-1, 3), np.tile(a, len(s)), np.repeat(s, cols)).reshape(len(s), cols)
    grid = scalp + normals * off[..., None]
    pole_p, pole_n, _ = head.cast(pole_dir)
    pole_off = outer(pole_p[None], pole_n[None], np.array([0.0]), np.array([1.0]))[0]
    tip = pole_p + pole_n * pole_off
    lip = scalp[0] - normals[0] * tuck
    verts = np.concatenate([lip, grid.reshape(-1, 3), [tip]])
    rows_idx = [np.arange(cols)] + [cols + i * cols + np.arange(cols) for i in range(len(s))]
    tip_i = len(verts) - 1
    # Equal-area UVs round the pole: shell faces keep their size, and the coil stays round.
    rel = verts - head.center
    k = unit(rel)
    theta = np.arccos(np.clip(k @ pole_dir, -1, 1))
    east = unit(np.cross(pole_dir, np.array([0, 0, 1.0])) if abs(pole_dir[2]) < .99 else np.array([1.0, 0, 0]))
    north = np.cross(east, pole_dir)
    ang = np.arctan2(k @ east, k @ north)
    radius = 2 * np.sin(theta / 2) * .1 / COIL_TILE_M * uv_scale * (COIL[1] - COIL[0]) / 2
    UV = np.stack([radius * np.sin(ang), radius * np.cos(ang)], axis=1)
    faces, uvs = [], []
    for r in range(len(rows_idx) - 1):
        lo, hi = rows_idx[r], rows_idx[r + 1]
        for j in range(cols):
            q = [lo[j], lo[(j + 1) % cols], hi[(j + 1) % cols], hi[j]]
            faces.append(q)
            uvs.append(coil_uv([tuple(UV[x]) for x in q]))
    last = rows_idx[-1]
    for j in range(cols):
        q = [last[j], last[(j + 1) % cols], tip_i]
        faces.append(q)
        uvs.append(coil_uv([tuple(UV[x]) for x in q]))
    piece.add(verts, faces, uvs)
    return {"scalp": scalp, "normals": normals, "offset": off, "a": a, "s": s, "grid": grid}


def frames(path):
    """Parallel-transport frames along a polyline."""
    t = unit(np.gradient(path, axis=0))
    ref = np.array([0, 0, 1.0]) if abs(t[0][2]) < .9 else np.array([1.0, 0, 0])
    u = unit(np.cross(t[0], ref))
    us = [u]
    for i in range(1, len(path)):
        u = us[-1] - t[i] * (us[-1] @ t[i])
        us.append(unit(u))
    us = np.array(us)
    return t, us, np.cross(t, us)


def resample(path, step):
    seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
    arc = np.concatenate([[0], np.cumsum(seg)])
    n = max(2, int(round(arc[-1] / step)) + 1)
    target = np.linspace(0, arc[-1], n)
    return np.stack([np.interp(target, arc, path[:, k]) for k in range(3)], axis=1), arc[-1]


def tube(piece, path, radius, column, period, sides=4, cap=True, twist=0.0, phase=0.0, material=0, v0=0.0, up=None):
    """A closed tube along `path` (radius per point), wrapping `column` once round, V along the length in `period`s."""
    path = np.asarray(path, float)
    radius = np.broadcast_to(np.asarray(radius, float), len(path))
    t, u, w = frames(path)
    if up is not None:
        u = unit(up - t * np.sum(up * t, axis=1, keepdims=True))
        w = np.cross(t, u)
    arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])
    ring = []
    for i in range(len(path)):
        th = phase + twist * arc[i] + np.linspace(0, math.tau, sides, endpoint=False) + math.pi / sides
        ring.append(path[i] + radius[i] * (np.cos(th)[:, None] * u[i] + np.sin(th)[:, None] * w[i]))
    V = np.concatenate(ring)
    left, right = column[0] + GUTTER, column[1] - GUTTER
    faces, uvs = [], []
    for i in range(len(path) - 1):
        for k in range(sides):
            a, b = i * sides + k, i * sides + (k + 1) % sides
            q = [a, b, b + sides, a + sides]
            u0, u1 = left + (right - left) * k / sides, left + (right - left) * (k + 1) / sides
            va, vb = v0 + arc[i] / period, v0 + arc[i + 1] / period
            faces.append(q)
            uvs.append([(u0, va), (u1, va), (u1, vb), (u0, vb)])
    if cap:
        end = len(path) - 1
        V = np.concatenate([V, [path[-1] + t[-1] * radius[-1] * .4]])
        tip = len(V) - 1
        for k in range(sides):
            q = [end * sides + k, end * sides + (k + 1) % sides, tip]
            u0, u1 = left + (right - left) * k / sides, left + (right - left) * (k + 1) / sides
            vv = v0 + arc[-1] / period
            faces.append(q)
            uvs.append([(u0, vv), (u1, vv), ((u0 + u1) / 2, vv + .02)])
    piece.add(V, faces, uvs, material)


def drape(head, start, direction, length, seg, margin, steps=160, pinned=2, extra=None):
    """A rope hanging from `start`, leaving it along `direction`, settled under gravity outside the body."""
    n = max(3, int(round(length / seg)) + 1)
    d = unit(direction)
    p = start + np.outer(np.arange(n), d) * seg
    prev = p.copy()
    g = np.array([0, 0, -.0016])
    for _ in range(steps):
        vel = (p - prev) * .9
        prev = p.copy()
        p[pinned:] += vel[pinned:] + g
        for _ in range(4):
            for i in range(1, n):
                delta = p[i] - p[i - 1]
                dist = np.linalg.norm(delta)
                if dist > 1e-9:
                    corr = delta * (1 - seg / dist)
                    if i - 1 < pinned:
                        if i >= pinned:
                            p[i] -= corr
                    elif i < pinned:
                        p[i - 1] += corr
                    else:
                        p[i - 1] += corr * .5
                        p[i] -= corr * .5
            # Stiffness: a braid bends but does not fold.
            for i in range(max(2, pinned), n):
                delta = p[i] - p[i - 2]
                dist = np.linalg.norm(delta)
                if 1e-9 < dist < 1.7 * seg:
                    p[i] = p[i - 2] + delta / dist * 1.7 * seg
            for i in range(pinned, n):
                p[i] = head.outside(p[i], margin(p[i]) if callable(margin) else margin)
                if extra is not None:
                    p[i] = extra(p[i])
    return p


def cut_at(path, z):
    """`path` cut where it first falls to height `z`."""
    below = np.nonzero(path[:, 2] <= z)[0]
    below = below[below > 1]
    if not len(below):
        return path
    i = below[0]
    a, b = path[i - 1], path[i]
    f = (a[2] - z) / max(a[2] - b[2], 1e-9)
    return np.concatenate([path[:i], [a + (b - a) * f]])


# ------------------------------------------------------------------------------------------------------------ pieces

def lumps(points, seed, freq, amp):
    return amp * noise3(points, seed, freq)


def short_coils(head, seed):
    piece = Piece("hair.short-coils")

    def outer(p, n, a, s):
        phi = np.abs(a)
        side = smooth(55, 95, phi) * (1 - smooth(120, 170, phi))
        t = .0095 - .0035 * side - .0045 * smooth(130, 180, phi) * (1 - smooth(.25, .6, s))
        t = t * (.2 + .8 * smooth(0, .16, s)) + lumps(p, seed, 95, .0012)
        return np.maximum(t, .0005)
    shell(piece, head, outer, seed, cols=40, rows=13)
    return piece


def rounded_afro(head, seed):
    piece = Piece("hair.rounded-afro")
    c = head.center + np.array([0, .014, .012])
    radii = np.array([.117, .136, head.top + .052 - c[2]])

    def outer(p, n, a, s):
        phi = np.abs(a)
        base = .006 + .004 * (1 - smooth(110, 180, phi))
        # The round outline, measured along the normal from the scalp point to the ellipsoid.
        q = (p - c) / radii
        nn = n / radii
        A = np.sum(nn * nn, axis=1)
        B = 2 * np.sum(q * nn, axis=1)
        C = np.sum(q * q, axis=1) - 1
        reach = (-B + np.sqrt(np.maximum(B * B - 4 * A * C, 0))) / (2 * A)
        nape = smooth(head.ear_bottom - .005, head.ear_bottom + .045, p[:, 2])
        ears = 1 - .45 * smooth(70, 100, phi) * (1 - smooth(118, 140, phi)) * (1 - smooth(head.ear_top + .01, head.ear_top + .05, p[:, 2]))
        # The outline rounds in towards the hairline instead of overhanging it.
        rise = smooth(0, .3, s) ** .8 * (.55 + .45 * smooth(head.ear_top, head.ear_top + .06, p[:, 2]))
        t = base + np.maximum(reach - base, 0) * rise * nape * ears
        t = t * (.3 + .7 * smooth(0, .09, s)) + lumps(p, seed, 48, .0032) + lumps(p, seed + 1, 140, .0011)
        return np.maximum(t, .0006)
    shell(piece, head, outer, seed, cols=56, rows=18, uv_scale=.75)
    return piece


def cornrows(head, seed, count=20):
    """Straight-back rows of three-strand plaits from the whole hairline, short braided ends at the nape."""
    piece = Piece("hair.cornrows")
    rng = RandomState(seed)
    # Rows are lines of constant latitude about the ear-to-ear axis through the centre: straight back over the top,
    # curving round above the ears at the sides.
    lat = np.linspace(-1, 1, count) * 64
    for r, beta in enumerate(lat):
        start_b, end_b = beta, beta * .55
        lon = np.linspace(-30, 230, 280)  # longitude about the ear axis: 0 front horizontal, 90 up, 180 back
        pts, nrm = [], []
        for L in lon:
            b = start_b + (end_b - start_b) * smooth(110, 205, L)
            Lr, br = math.radians(L), math.radians(b)
            d = np.array([math.sin(br), -math.cos(br) * math.cos(Lr), math.cos(br) * math.sin(Lr)])
            p, n, _ = head.cast(unit(d))
            pts.append(p)
            nrm.append(n)
        pts, nrm = np.array(pts), np.array(nrm)
        phi = np.degrees(np.arctan2(np.abs(pts[:, 0]), -(pts[:, 1] - head.center[1])))
        inside = pts[:, 2] >= head.line(phi) + .002
        idx = np.nonzero(inside)[0]
        if len(idx) < 4:
            continue
        # The longest run inside the hairline.
        runs = np.split(idx, np.nonzero(np.diff(idx) > 1)[0] + 1)
        run = max(runs, key=len)
        path, norm = pts[run], nrm[run]
        path_r, length = resample(path, .0135)
        norm_r = unit(np.stack([np.interp(np.linspace(0, 1, len(path_r)), np.linspace(0, 1, len(norm)), norm[:, k]) for k in range(3)], axis=1))
        t = unit(np.gradient(path_r, axis=0))
        side = unit(np.cross(norm_r, t))
        x = np.linspace(0, 1, len(path_r))
        width = .0062 * (.55 + .45 * smooth(0, .12, x)) * (1 + .1 * np.sin(x * length / .009 * math.pi))
        height = .0042 * (.6 + .4 * smooth(0, .1, x))
        across = np.linspace(0, math.pi, 4)
        V, faces, uvs = [], [], []
        for i in range(len(path_r)):
            for th in across:
                V.append(path_r[i] + side[i] * math.cos(th) * width[i] + norm_r[i] * (math.sin(th) * height[i] - .0012))
        arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(path_r, axis=0), axis=1))])
        left, right = PLAIT[0] + GUTTER, PLAIT[1] - GUTTER
        for i in range(len(path_r) - 1):
            for k in range(len(across) - 1):
                a, b = i * len(across) + k, i * len(across) + k + 1
                q = [a, a + len(across), b + len(across), b]
                u0 = left + (right - left) * (.15 + .7 * k / (len(across) - 1))
                u1 = left + (right - left) * (.15 + .7 * (k + 1) / (len(across) - 1))
                faces.append(q)
                uvs.append([(u0, arc[i] / PLAIT_PERIOD_M), (u0, arc[i + 1] / PLAIT_PERIOD_M), (u1, arc[i + 1] / PLAIT_PERIOD_M), (u1, arc[i] / PLAIT_PERIOD_M)])
        piece.add(V, faces, uvs)
        # The short braided end: off the scalp at the nape, lying down the neck a few centimetres. Rows that end in
        # front of the ears just stop at the hairline.
        end = path_r[-1]
        if end[1] < head.center[1] + .03:
            continue
        out = unit(t[-1] + np.array([0, 0, -.8]))
        rope = drape(head, end + norm_r[-1] * .003, out, .036 + rng.uniform(0, .014), .012, .0055)
        tube(piece, rope, np.linspace(.0042, .003, len(rope)), PLAIT, PLAIT_PERIOD_M * .7, sides=4, v0=arc[-1] / PLAIT_PERIOD_M)
    return piece


def braid_roots(head, rows=6, per_side=4, behind=.014):
    """Square-parted roots either side of a centre part: (point, normal, latitude, longitude)."""
    roots = []
    for i in range(rows):
        lon = 42 + i * (172 - 42) / (rows - 1)
        for side in (-1, 1):
            for k in range(per_side):
                beta = side * (8 + k * 56 / (per_side - 1)) * (1 - .3 * smooth(140, 175, lon))
                Lr, br = math.radians(lon), math.radians(beta)
                d = np.array([math.sin(br), -math.cos(br) * math.cos(Lr), math.cos(br) * math.sin(Lr)])
                p, n, _ = head.cast(unit(d))
                phi = math.degrees(math.atan2(abs(p[0]), -(p[1] - head.center[1])))
                if p[2] < head.line(phi) + behind:
                    continue
                roots.append((p, n, beta, lon))
    return roots


def underlayer(piece, head, seed, t=.0042):
    def outer(p, n, a, s):
        return np.maximum(t * (.25 + .75 * smooth(0, .14, s)) + lumps(p, seed, 120, .0006), .0005)
    return shell(piece, head, outer, seed, cols=36, rows=9)


def box_braids(head, seed, tied=False):
    piece = Piece("hair.box-braids-tied" if tied else "hair.box-braids")
    rng = RandomState(seed + (7 if tied else 0))
    under = .0042
    underlayer(piece, head, seed, under)
    roots = braid_roots(head)
    radius = .0054
    end_z = head.ear_bottom - .16
    crown, _, _ = head.cast(head.direction(np.array(180.0), np.array(72.0)))
    gather = None
    if tied:
        gp, gn, _ = head.cast(head.direction(np.array(180.0), np.array(math.degrees(math.asin(np.clip((head.ear_bottom + .004 - head.center[2]) / .1, -1, 1))))))
        gather = gp + gn * (under + .012)
        piece.tie_point = gather
    # Braids from the crown lie over those from lower down.
    order = sorted(range(len(roots)), key=lambda r: roots[r][3])
    for layer, r in enumerate(sorted(order, key=lambda r: -abs(roots[r][2]))):
        p, n, beta, lon = roots[r]
        lift = under + radius + .001 + .0016 * (1 - abs(beta) / 70)
        start = p - n * .0015  # the open end hides under the scalp
        if tied:
            # Straight back over the scalp to the tie at the nape, then into the tail.
            path = [start]
            d0, d1 = unit(p - head.center), unit(gather - head.center)
            omega = math.acos(np.clip(d0 @ d1, -1, 1))
            for f in np.linspace(0, 1, 16)[1:]:
                d = (math.sin((1 - f) * omega) * d0 + math.sin(f * omega) * d1) / max(math.sin(omega), 1e-6)
                q, qn, _ = head.cast(unit(d))
                path.append(q + qn * (lift * smooth(0, .2, f) + .0005) + (gather - q) * smooth(.75, 1, f) * .6)
            path = np.array(path)
            path[-1] = gather + rng.normal(0, .003, 3)
            tube(piece, resample(path, .021)[0], radius, PLAIT, PLAIT_PERIOD_M, sides=4, cap=False, phase=rng.uniform(0, 1))
            continue
        # Each braid leaves its root away from the crown, and away from the part.
        away = unit(p - crown) + np.array([math.copysign(.7, beta) * (1 - smooth(20, 50, abs(beta))) * (1 - smooth(120, 160, lon)), 0, 0])
        away = away + rng.normal(0, .12, 3)
        tangent = unit(away - n * (away @ n))

        def margin(q, lift=lift):
            phi = math.degrees(math.atan2(abs(q[0]), -(q[1] - head.center[1])))
            return lift if q[2] > head.line(phi) - .004 else radius + head.margin_at(q)
        rope = drape(head, start, tangent, .5, .016, margin)
        rope = cut_at(rope, end_z + rng.uniform(-.012, .012))
        path = resample(rope, .026)[0]
        taper = np.full(len(path), radius)
        taper[-2:] = [radius * .92, radius * .75]
        tube(piece, path, taper, PLAIT, PLAIT_PERIOD_M, sides=4, phase=rng.uniform(0, 1))
    if tied:
        axis = unit(np.array([0, .22, -1.0]))
        side_axis = np.array([1.0, 0, 0])
        back_axis = unit(np.cross(side_axis, axis))
        # The tail: braids bundled at the tie, loosening into a fan below it, two layers deep.
        for k in range(12):
            ang = (k + .5) / 12 * math.tau
            ring = math.cos(ang) * side_axis + math.sin(ang) * back_axis
            start = gather + axis * .016 + ring * .0105 + rng.normal(0, .0008, 3)
            spread = unit(axis + ring * .07 + rng.normal(0, .015, 3))
            length = .2 + rng.uniform(-.02, .015)
            path = np.array([start + spread * f * length + ring * .008 * f for f in np.linspace(0, 1, 10)])
            path = np.array([head.outside(q, radius + .003) for q in path])
            path = resample(path, .024)[0]
            taper = np.full(len(path), radius)
            taper[-1] = radius * .75
            tube(piece, path, taper, PLAIT, PLAIT_PERIOD_M, sides=4, phase=rng.uniform(0, 1))
        # The leather tie round the gathered braids.
        ring = np.array([gather + axis * (.008 + .012 * f) for f in np.linspace(0, 1, 3)])
        tube(piece, ring, .0175, (0, 1), .05, sides=8, cap=False, material=1, up=np.tile(side_axis, (3, 1)))
    return piece


def loose_curls(head, seed, count=30):
    piece = Piece("hair.loose-curls")
    rng = RandomState(seed + 3)

    def outer(p, n, a, s):
        phi = np.abs(a)
        t = .028 + .01 * smooth(.3, .9, s) - .004 * smooth(60, 100, phi) * (1 - smooth(120, 160, phi))
        t = t * (.22 + .78 * smooth(0, .2, s)) + lumps(p, seed, 55, .005) + lumps(p, seed + 5, 150, .0014)
        return np.maximum(t, .0006)
    cap = shell(piece, head, outer, seed, cols=40, rows=13, uv_scale=.85)
    # Ringlets spill from under the cap's lower edge round the sides and back: jaw length at the sides, to the nape
    # behind, two staggered tiers so the curls read as one curly mass.
    a = cap["a"]
    for k in range(count):
        tier = k % 2
        signed = (36 + 288 * (k + rng.uniform(.25, .75)) / count + 180) % 360 - 180
        phi_abs = abs(signed)
        col = int(np.argmin(np.abs((a - signed + 180) % 360 - 180)))
        row = 3 + 2 * tier + rng.randint(0, 2)
        radius = rng.uniform(.0075, .0092)
        root = cap["grid"][row, col] - cap["normals"][row, col] * (cap["offset"][row, col] * .55)
        out = unit(cap["normals"][row, col] * .5 + np.array([0, 0, -1.0]))
        length = .045 + .05 * smooth(70, 165, phi_abs) + .015 * tier + rng.uniform(-.008, .01)
        rope = drape(head, root, out, length, .012, lambda q, r=radius: r + .007 + head.margin_at(q) * .5, pinned=1)
        centre, _ = resample(rope, .0065)
        t, u, w = frames(centre)
        arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(centre, axis=0), axis=1))])
        turn = rng.uniform(.028, .036)
        ang = arc / turn * math.tau + rng.uniform(0, math.tau)
        coil = .0036 * (.5 + .5 * smooth(0, .02, arc))
        helix = centre + coil[:, None] * (np.cos(ang)[:, None] * u + np.sin(ang)[:, None] * w)
        r = radius * (1 - .5 * smooth(.55, 1, arc / arc[-1]))
        tube(piece, helix, r, CURL, CURL_PERIOD_M, sides=4, phase=rng.uniform(0, 1))
    return piece


def ball(segments, rings):
    """A unit UV sphere, built here in a fixed order (Blender's primitive merges its seam in no fixed order)."""
    verts = [(0.0, 0.0, -1.0)]
    for r in range(1, rings):
        theta = math.pi * r / rings
        for s in range(segments):
            phi = math.tau * s / segments
            verts.append((math.sin(theta) * math.cos(phi), math.sin(theta) * math.sin(phi), -math.cos(theta)))
    verts.append((0.0, 0.0, 1.0))
    top = len(verts) - 1
    ring = lambda r, s: 1 + (r - 1) * segments + s % segments
    faces = [[0, ring(1, s + 1), ring(1, s)] for s in range(segments)]
    for r in range(1, rings - 1):
        faces += [[ring(r, s), ring(r, s + 1), ring(r + 1, s + 1), ring(r + 1, s)] for s in range(segments)]
    faces += [[ring(rings - 1, s), ring(rings - 1, s + 1), top] for s in range(segments)]
    return np.array(verts), faces


def curly_bun(head, seed):
    piece = Piece("hair.curly-bun")

    def outer(p, n, a, s):
        t = .0042 * (.25 + .75 * smooth(0, .14, s)) + lumps(p, seed, 110, .0007)
        return np.maximum(t, .0005)
    shell(piece, head, outer, seed, cols=32, rows=11, uv_scale=1.1)
    # The puff: a lumpy ball on the crown, a little back, its foot sunk into the cap.
    axis = unit(head.direction(np.array(180.0), np.array(68.0)))
    foot, fn, _ = head.cast(axis)
    centre = foot + fn * .049
    V, F = ball(18, 12)
    k = unit(V)
    R = np.array([.05, .046, .042]) * (1 + lumps(k * 1.0, seed + 9, 3.2, .1)[:, None] + lumps(k, seed + 11, 8, .045)[:, None])
    V = centre + V * R
    # Equal-area UVs round the ball's top for the coil.
    theta = np.arccos(np.clip(k[:, 2], -1, 1))
    ang = np.arctan2(k[:, 0], k[:, 1])
    rad = 2 * np.sin(theta / 2) * .05 / COIL_TILE_M * (COIL[1] - COIL[0]) / 2 * 1.4
    UV = np.stack([rad * np.sin(ang), rad * np.cos(ang)], axis=1)
    faces, uvs = [], []
    for f in F:
        uv = [tuple(UV[i]) for i in f]
        us = [u for u, _ in uv]
        if max(us) - min(us) > (COIL[1] - COIL[0]) / 2 - 2 * GUTTER:
            # A face across the bottom pole's seam: give it its own small patch.
            c = np.mean(V[f], axis=0)
            uv = [((V[i] - c)[0] * 4 + .1, (V[i] - c)[1] * 4) for i in f]
        faces.append(f)
        uvs.append(coil_uv(uv))
    piece.add(V, faces, uvs)
    # The hair gathered up from the cap into the tie, then the tie: a band round the puff's foot.
    tie_axis = fn
    up = unit(np.cross(tie_axis, np.array([1.0, 0, 0])))
    gathered = np.array([foot + tie_axis * h for h in (-.003, .004, .009)])
    tube(piece, gathered, np.array([.036, .026, .021]), CURL, CURL_PERIOD_M, sides=10, cap=False, up=np.tile(up, (3, 1)))
    ring = np.array([foot + tie_axis * (.007 + .008 * f) for f in np.linspace(0, 1, 3)])
    tube(piece, ring, .0225, (0, 1), .05, sides=10, cap=False, material=1, up=np.tile(up, (3, 1)))
    return piece


# ---------------------------------------------------------------------------------------------------------- textures

def periodic_distance(size, cx, cy):
    x = np.arange(size)
    dx = np.minimum(np.abs(x - cx), size - np.abs(x - cx))
    dy = np.minimum(np.abs(x - cy), size - np.abs(x - cy))
    return dx[None, :], dy[:, None]


def coil_height(size, seed):
    """A tileable field of tight coils: overlapping small rings, each with a strand gap, some fibre noise."""
    rng = RandomState(seed)
    H = np.zeros((size, size))
    for _ in range(int(size * size / 230)):
        cx, cy = rng.uniform(0, size, 2)
        r, w = rng.uniform(.018, .03) * size, rng.uniform(.006, .009) * size
        dx, dy = periodic_distance(size, cx, cy)
        sx = np.where(np.abs(np.arange(size) - cx) <= size / 2, np.arange(size) - cx, np.arange(size) - cx - np.sign(np.arange(size) - cx) * size)[None, :]
        sy = np.where(np.abs(np.arange(size) - cy) <= size / 2, np.arange(size) - cy, np.arange(size) - cy - np.sign(np.arange(size) - cy) * size)[:, None]
        d = np.sqrt(dx * dx + dy * dy)
        ring = np.clip(1 - ((d - r) / w) ** 2, 0, 1)
        gap = .65 + .35 * np.cos(np.arctan2(sy, sx) + rng.uniform(0, math.tau))
        H = np.maximum(H, ring * gap * rng.uniform(.75, 1))
    return H


def curl_height(h, w, seed):
    """Twisted strands of a ringlet, wrapped once round the tube (u) and repeating along it (v)."""
    u = np.arange(w)[None, :] / w
    v = np.arange(h)[:, None] / h
    phase = math.tau * (2 * u + 10 * v)
    strands = (.5 + .5 * np.cos(phase)) ** .7
    fibres = .5 + .5 * np.sin(math.tau * (14 * u + 70 * v) + 2.5 * np.sin(math.tau * 3 * u))
    return np.clip(.15 + .7 * strands + .15 * fibres * strands, 0, 1)


def plait_height(h, w, stitches=8):
    """A three-strand plait seen round a tube: chevrons of tilted lobes, alternating, repeating `stitches` times."""
    u = np.arange(w)[None, :] / w
    v = np.arange(h)[:, None] / h * stitches
    H = np.zeros((h, w))
    for lane in range(4):
        uc = (lane + .5) / 4
        for off, tilt in ((0.0, 1), (.5, -1)):
            vv = (v + off + (lane % 2) * .5) % 1 - .5
            du = (u - uc + .5) % 1 - .5
            x = du * 4 * .5
            a = math.radians(32) * tilt
            ru = x * math.cos(a) - vv * math.sin(a)
            rv = x * math.sin(a) + vv * math.cos(a)
            lobe = np.clip(1 - (ru / .5) ** 2 - (rv / .26) ** 2, 0, 1) ** .6
            fibre = .85 + .15 * np.sin(ru * 90)
            H = np.maximum(H, lobe * fibre * (1 - .5 * (tilt < 0) * 0))
    return H


def blur_wrap(H, r):
    out = H.copy()
    for axis in (0, 1):
        acc = np.zeros_like(out)
        for k in range(-r, r + 1):
            acc += np.roll(out, k, axis=axis)
        out = acc / (2 * r + 1)
    return out


def atlas():
    """The shared atlas: grey base colour (the tint is the material's factor) and a tangent-space normal map."""
    S = ATLAS
    Hc = coil_height(S // 4, 557)
    coil = np.tile(Hc, (4, 2))
    curl = curl_height(S, S // 4, 558)
    plait = plait_height(S, S // 4)
    H = np.concatenate([coil, curl, plait], axis=1)
    cavity = np.clip(H - blur_wrap(H, 6) + .5, 0, 1)
    base = np.clip(.42 + .5 * H ** .8 + .2 * (cavity - .5), 0, 1)
    jitter = np.tile(blur_wrap(RandomState(9).rand(S // 8, S // 8), 1), (8, 8))
    base = np.clip(base * (.92 + .16 * jitter), 0, 1)
    # Normal map at half size from the height gradients (wrapping, so the tiles stay seamless along V).
    Hs = H.reshape(NORMAL_SIZE, 2, NORMAL_SIZE, 2).mean(axis=(1, 3))
    gx = (np.roll(Hs, -1, axis=1) - np.roll(Hs, 1, axis=1)) * 2.2
    gy = (np.roll(Hs, -1, axis=0) - np.roll(Hs, 1, axis=0)) * 2.2
    N = unit(np.stack([-gx, -gy, np.ones_like(Hs)], axis=-1))
    return base, N * .5 + .5


def image(name, rgb, colourspace):
    h, w = rgb.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = colourspace
    px = np.ones((h, w, 4), np.float32)
    px[..., :3] = rgb if rgb.ndim == 3 else rgb[..., None]
    img.pixels.foreach_set(px.ravel())
    img.file_format = "PNG"
    img.pack()
    return img


def hair_material():
    base, normal = atlas()
    mat = bpy.data.materials.new(HAIR)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image("T_TexturedHair_BaseColor", base, "sRGB")
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    ntex = tree.nodes.new("ShaderNodeTexImage")
    ntex.image = image("T_TexturedHair_Normal", normal, "Non-Color")
    nmap = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
    tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = ROUGHNESS
    bsdf.inputs["Metallic"].default_value = 0
    return mat


def tie_material():
    mat = bpy.data.materials.new(TIE_NAME)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = TIE[0]
    bsdf.inputs["Roughness"].default_value = TIE[1]
    return mat


# -------------------------------------------------------------------------------------------------------------- main

def build(head, seed=557):
    return {
        "hair.short-coils": short_coils(head, seed),
        "hair.rounded-afro": rounded_afro(head, seed + 1),
        "hair.cornrows": cornrows(head, seed + 2),
        "hair.box-braids": box_braids(head, seed + 3),
        "hair.box-braids-tied": box_braids(head, seed + 3, tied=True),
        "hair.loose-curls": loose_curls(head, seed + 4),
        "hair.curly-bun": curly_bun(head, seed + 5),
    }


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    imported, body, brows = import_body(inputs["body"], inputs["buffer"])
    head = Head(body, brows)
    hair, tie = hair_material(), tie_material()
    built = build(head)
    objects, pieces = [], []
    for name in PIECES:
        piece = built[name]
        uses_tie = 1 in piece.mat
        obj = piece.finish([hair, tie] if uses_tie else [hair])
        objects.append(obj)
        record = {"node": name, "materials": [HAIR, TIE_NAME] if uses_tie else [HAIR], "triangles": sum(len(p.vertices) - 2 for p in obj.data.polygons)}
        if piece.tie_point is not None:
            # Where the tail leaves the tie, in the glTF frame (+Y up, +Z front).
            x, y, z = piece.tie_point
            record["tie"] = [round(float(x), 5), round(float(z), 5), round(float(-y), 5)]
        pieces.append(record)
    for o in imported:
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True, export_texcoords=True,
        export_normals=True, export_tangents=False, export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False, export_image_format="AUTO")
    landmarks = {"brow": head.brow, "top": head.top, "earTop": head.ear_top, "earBottom": head.ear_bottom, "neck": head.neck}
    return {"recipe": RECIPE, "fit": arguments["fit"], "pieces": pieces, "landmarks": {k: round(v, 5) for k, v in landmarks.items()}}
