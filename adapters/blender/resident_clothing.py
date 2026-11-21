"""Resident clothing (docs/resident-clothing.md, #560): everyday garments for Greyhaven's adults, teenagers and children.

One run builds every piece for one fit (a figure's body and rig at rest). The adult fits are the catalogued Quaternius
``Male_Peasant`` and ``Female_Peasant`` outfits on the shared 65-joint rig; the young fits are ``Male_Peasant`` carried
to the young residents' proportions exactly as ``young_residents.py`` bakes them (its ``PROFILES``, read as a declared
Python input, and the figure's overall scale in ``YOUNG``). The body is only the fit target: it is never exported.

Every garment is original, a parametric shell fitted to the body: fitted parts are projected onto the body's surface plus
a clearance and take the skin weights of the body under them, so they move with it; skirts and the hanging parts of
tunics and aprons are lofted rings whose weights settle toward the pelvis and follow each thigh (the #376 ``SETTLE`` and
``STRIDE`` rule), and the build adds the #391 accessory chains on top. Folds, gathers, pleats and hems are geometry; the
weave, seams, patches and embroidery are in one shared atlas painted here (``paint_atlas``). Only the layers that show are
built: the shirt and the chemise are their collars and sleeves.

``arguments`` is ``{schemaVersion: 1, fit}``. Every random choice is seeded.
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

RECIPE = "resident-clothing-v1"
ATLAS_SIZE, NORMAL_SIZE, CELL = 2048, 1024, 512
GUTTER = 48
# ``scale`` is a young figure's overall scale in young_residents.py ``proportions``, measured from the young-residents
# release so the rig here lands on its published joints (within 0.01 mm); the build test compares the two.
FITS = {
    "male": {"source": "Male_Peasant", "sex": "m", "age": "adult"},
    "female": {"source": "Female_Peasant", "sex": "f", "age": "adult"},
    "teen-boy": {"source": "Male_Peasant", "sex": "m", "age": "teen", "profile": "teen_m", "scale": 0.894446},
    "teen-girl": {"source": "Male_Peasant", "sex": "f", "age": "teen", "profile": "teen_f", "scale": 0.855672},
    "child-boy": {"source": "Male_Peasant", "sex": "m", "age": "child", "profile": "child_m", "scale": 0.729154},
    "child-girl": {"source": "Male_Peasant", "sex": "f", "age": "child", "profile": "child_f", "scale": 0.724588},
}
MAIN_CHILD = {"root": "pelvis", "pelvis": "spine_01", "spine_03": "neck_01", "hand_l": "middle_01_l", "hand_r": "middle_01_r"}


def smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "fit"} or arguments["schemaVersion"] != 1 or arguments["fit"] not in FITS:
        raise ValueError("resident clothing requires schemaVersion 1 and a known fit")
    if "young" not in inputs:
        raise ValueError("resident clothing needs the declared young input")


def imported(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    for o in [x for x in new if x.type == "MESH" and x.name.startswith("Icosphere")]:
        new.remove(o)
        bpy.data.objects.remove(o)
    return new


# --- the young proportions -------------------------------------------------------------------------------------------

def young_rig(arm, meshes, profile, scale, bone_profile):
    """``young_residents.proportions`` at a fixed overall scale: new joint offsets and vertices, the rotations kept."""
    bones = arm.data.bones
    names = [b.name for b in bones]
    index = {n: i for i, n in enumerate(names)}
    pos = np.array([b.head_local for b in bones])

    def direction(bone):
        child = bones.get(MAIN_CHILD.get(bone.name, "")) or (bone.children[0] if bone.children else None)
        if child is not None:
            d = np.array(child.head_local) - np.array(bone.head_local)
            return d / np.linalg.norm(d)
        return direction(bone.parent) if bone.parent else np.array((0.0, 0.0, 1.0))

    order = [b for b in bones if b.parent is None]
    for bone in order:
        order.extend(bone.children)
    s = {}
    for bone in bones:
        width, length = (1, 1) if bone.name == "root" else bone_profile(bone.name, profile)
        d = direction(bone)
        s[bone.name] = (width * np.eye(3) + (length - width) * np.outer(d, d)) * scale
    new = pos.copy()
    for bone in order:
        if bone.parent is not None:
            p = index[bone.parent.name]
            new[index[bone.name]] = new[p] + s[bone.parent.name] @ (pos[index[bone.name]] - pos[p])
    mapped = {}
    for obj in meshes:
        w = np.zeros((len(obj.data.vertices), len(names)))
        for v in obj.data.vertices:
            for g in v.groups:
                w[v.index, index[obj.vertex_groups[g.group].name]] = g.weight
        w /= w.sum(1)[:, None]
        co = np.empty(3 * len(obj.data.vertices))
        obj.data.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        out = np.zeros_like(co)
        for i, name in enumerate(names):
            used = w[:, i] > 0
            if used.any():
                out[used] += w[used, i, None] * (new[i] + (co[used] - pos[i]) @ s[name].T)
        mapped[obj.name] = out
    low = min(m[:, 2].min() for m in mapped.values())
    lift = np.array((0, 0, -low))
    new[1:] += lift
    for obj in meshes:
        obj.data.vertices.foreach_set("co", (mapped[obj.name] + lift).ravel())
        obj.data.update()
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for e in arm.data.edit_bones:
        e.use_connect = False
    for e in arm.data.edit_bones:
        target = Vector(new[index[e.name]])
        offset = e.tail - e.head
        e.head, e.tail = target, target + offset
    bpy.ops.object.mode_set(mode="OBJECT")


# --- the fit target --------------------------------------------------------------------------------------------------

class Body:
    """The fit's body at rest: every vertex with its skin weights, and a BVH to fit garments onto it."""

    def __init__(self, arm, meshes):
        self.arm = arm
        self.joints = [b.name for b in arm.data.bones]
        self.index = {n: i for i, n in enumerate(self.joints)}
        verts, weights, tris, parts = [], [], [], []
        offset = 0
        for obj in sorted(meshes, key=lambda o: o.name):
            mesh = obj.data
            mesh.calc_loop_triangles()
            co = np.empty(3 * len(mesh.vertices))
            mesh.vertices.foreach_get("co", co)
            w = np.zeros((len(mesh.vertices), len(self.joints)))
            for v in mesh.vertices:
                for g in v.groups:
                    w[v.index, self.index[obj.vertex_groups[g.group].name]] += g.weight
            w /= np.maximum(w.sum(1), 1e-9)[:, None]
            verts.append(co.reshape(-1, 3))
            weights.append(w)
            tris += [tuple(i + offset for i in t.vertices) for t in mesh.loop_triangles]
            parts += [obj.name.rsplit("_", 1)[-1].lower()] * len(mesh.vertices)
            offset += len(mesh.vertices)
        self.co, self.w, self.tris, self.part = np.concatenate(verts), np.concatenate(weights), np.array(tris), np.array(parts)
        self.bvh = BVHTree.FromPolygons([Vector(p) for p in self.co], [tuple(t) for t in self.tris], all_triangles=True)
        self.torso_co = self.co[self.part == "body"]
        # The body without its arms: what hanging cloth takes its weights from, so a swinging arm never drags a skirt.
        core = self.tris[(self.part[self.tris] != "arms").all(1)]
        self.core_tris = core
        self.core_bvh = BVHTree.FromPolygons([Vector(p) for p in self.co], [tuple(t) for t in core], all_triangles=True)

    def joint(self, name):
        return np.array(self.arm.data.bones[name].head_local)

    def nearest(self, p, core=False):
        tris = self.core_tris if core else self.tris
        loc, normal, i, _ = (self.core_bvh if core else self.bvh).find_nearest(Vector(p))
        a, b, c = (Vector(self.co[k]) for k in tris[i])
        bary = np.array(_barycentric(loc, a, b, c))
        return np.array(loc), np.array(normal), bary @ self.w[tris[i]]

    def weights(self, mapping):
        w = np.zeros(len(self.joints))
        for name, value in mapping.items():
            w[self.index[name]] += value
        return w

    def section(self, z, band=.02, xlim=1.0, co=None):
        """The body's cross-section near ``z``: centre y and the half-widths to the side, front and back."""
        co = self.co if co is None else co
        # The source meshes are low-poly, with rows up to several centimetres apart: widen the band until it holds a row.
        for _ in range(5):
            pts = co[(np.abs(co[:, 2] - z) < band) & (np.abs(co[:, 0]) < xlim)]
            if len(pts) >= 6:
                break
            band *= 1.6
        if not len(pts):
            raise ValueError(f"no body section at {z:.3f}")
        cy = (pts[:, 1].min() + pts[:, 1].max()) / 2
        return cy, np.abs(pts[:, 0]).max(), cy - pts[:, 1].min(), pts[:, 1].max() - cy

    def radius_profile(self, z, cy, angles, band=.03, co=None):
        """The outermost horizontal body radius round (0, cy) per direction, for garments that only have to clear it."""
        co = self.co if co is None else co
        pts = co[np.abs(co[:, 2] - z) < band]
        out = np.zeros(len(angles))
        if not len(pts):
            return out
        ang = np.arctan2(pts[:, 0], -(pts[:, 1] - cy))
        rad = np.hypot(pts[:, 0], pts[:, 1] - cy)
        step = min(2 * math.pi / len(angles), .12)
        for k, a in enumerate(angles):
            d = np.abs((ang - a + math.pi) % (2 * math.pi) - math.pi)
            near = rad[d < step]
            out[k] = near.max() if len(near) else 0
        return out


def _barycentric(p, a, b, c):
    v0, v1, v2 = b - a, c - a, p - a
    d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
    den = d00 * d11 - d01 * d01
    if abs(den) < 1e-14:
        return 1.0, 0.0, 0.0
    v = (d11 * d20 - d01 * d21) / den
    w = (d00 * d21 - d01 * d20) / den
    return max(0.0, 1 - v - w), max(0.0, v), max(0.0, w)


def landmarks(body):
    """Heights and widths every garment is placed from, in the fit's own rest pose."""
    j = body.joint
    torso = body.torso_co
    top = torso[:, 2].max()
    neck = torso[(torso[:, 2] > top - .025) & (np.abs(torso[:, 0]) < .12)]
    lm = {
        "pelvis": j("pelvis")[2], "pelvis_y": j("pelvis")[1], "spine1": j("spine_01")[2], "spine2": j("spine_02")[2], "chest": j("spine_03")[2], "neck": j("neck_01")[2], "head": j("Head")[2],
        "shoulder_x": j("upperarm_l")[0], "shoulder_z": j("upperarm_l")[2], "elbow_x": j("lowerarm_l")[0], "wrist_x": j("hand_l")[0],
        "hip_x": j("thigh_l")[0], "knee": j("calf_l")[2], "ankle": j("foot_l")[2],
        "neck_top": float(top), "neck_cy": float((neck[:, 1].min() + neck[:, 1].max()) / 2),
        "neck_rx": float(np.abs(neck[:, 0]).max()), "neck_ry": float((neck[:, 1].max() - neck[:, 1].min()) / 2),
    }
    lm["height"] = lm["head"] / .91  # the head joint sits about 0.91 of the standing height on this rig
    lm["armpit"] = lm["shoulder_z"] - .085 * lm["height"] / 1.76
    lm["waist"] = lm["pelvis"] + .55 * (lm["spine1"] - lm["pelvis"]) + .03 * lm["height"] / 1.76
    return {k: float(v) for k, v in lm.items()}


# --- shells ----------------------------------------------------------------------------------------------------------

def ring_angles(cols):
    """Directions round the body, starting at the back (the seam), then the right side, the front and the left."""
    return math.pi + 2 * math.pi * np.arange(cols) / cols


def hdir(angles):
    angles = np.asarray(angles)
    return np.stack([np.sin(angles), -np.cos(angles), np.zeros_like(angles)], -1)


def ellipse(angles, z, cy, rx, ryf, ryb, scale=1.0):
    d = hdir(angles)
    ry = np.where(d[:, 1] < 0, ryf, ryb)
    return np.stack([d[:, 0] * rx * scale, cy + d[:, 1] * ry * scale, np.full(len(angles), z)], -1)


class Grid:
    """A rows x cols patch of a garment: positions, skin weights, the row centres (for outward directions) and UVs in metres."""

    def __init__(self, P, W, centres, closed=True):
        self.P, self.W, self.centres, self.closed = np.asarray(P, float), np.asarray(W, float), np.asarray(centres, float), closed

    @property
    def shape(self):
        return self.P.shape[:2]


def fit_onto(body, P, clearance, only_inside=False):
    """Every point onto the body's nearest surface plus ``clearance``; ``only_inside`` leaves points already clear."""
    out, W = P.copy(), np.zeros(P.shape[:-1] + (len(body.joints),))
    for idx in np.ndindex(P.shape[:-1]):
        loc, normal, w = body.nearest(P[idx])
        W[idx] = w
        if only_inside and np.dot(P[idx] - loc, normal) >= clearance:
            continue
        out[idx] = loc + normal * clearance
    return out, W


def relax(P, iterations, fixed_rows=(), closed=True, strength=.5):
    R, C = P.shape[:2]
    for _ in range(iterations):
        Q = P.copy()
        for r in range(R):
            left = np.roll(P[r], 1, 0) if closed else np.vstack([P[r][:1], P[r][:-1]])
            right = np.roll(P[r], -1, 0) if closed else np.vstack([P[r][1:], P[r][-1:]])
            if r in fixed_rows:
                # A fixed row keeps its height and only evens out along itself.
                Q[r, :, :2] = P[r, :, :2] + strength * ((left + right)[:, :2] / 2 - P[r, :, :2])
                continue
            neigh = [left, right]
            if 0 < r < R - 1:
                neigh += [P[r - 1], P[r + 1]]
            Q[r] = P[r] + strength * (sum(neigh) / len(neigh) - P[r])
        P = Q
    return P


def torso(body, lm, cols, bottom, neckline, clearance=.008, ease=None, rows_per_m=34, top_rows=9, collar=0.0):
    """A fitted shell from ``bottom`` up over the shoulders to a neckline. ``neckline(angles)`` gives each column's drop
    below the body's neck top and how much wider than the neck it opens. Returns a Grid, rows bottom to top."""
    s = lm["height"] / 1.76
    angles = ring_angles(cols)
    z_top = lm["armpit"] + .015 * s
    zs = np.linspace(bottom, z_top, max(3, int((z_top - bottom) * rows_per_m) + 1))
    rings = []
    d = hdir(angles)
    for z in zs:
        xl = .5 if z < lm["armpit"] - .03 * s else lm["shoulder_x"] * .92
        cy, rx, ryf, ryb = body.section(z, .02 * s, xl, body.torso_co if z > lm["pelvis"] + .05 * s else None)
        ring = ellipse(angles, z, cy, rx, ryf, ryb, .85)
        # Land each column on the outermost surface, cast inward from outside (within the shoulders, so a T-posed arm
        # never catches it): the nearest surface from inside can be the far side of a thin or open section.
        for j in range(cols):
            reach = min(.45, xl / max(abs(d[j, 0]), 1e-6))
            start = np.array([0, cy, z]) + d[j] * reach
            hit, normal, _, _ = body.core_bvh.ray_cast(Vector(start), Vector(-d[j]), reach)
            if hit is not None:
                ring[j] = np.array(hit) + d[j] * clearance
        rings.append(ring)
    base = body.section(z_top, .02 * s, lm["shoulder_x"] * .92, body.torso_co)
    drop, widen = neckline(angles)
    for k in range(1, top_rows + 1):
        t = k / top_rows
        z = z_top + (lm["neck_top"] - drop - z_top) * t ** .8
        lower = ellipse(angles, 0, *base, .85)
        upper = ellipse(angles, 0, lm["neck_cy"], lm["neck_rx"], lm["neck_ry"], lm["neck_ry"], 1.0)
        upper[:, 0] *= 1 + widen
        upper[:, 1] = lm["neck_cy"] + (upper[:, 1] - lm["neck_cy"]) * (1 + widen)
        ring = lower + (upper - lower) * t
        ring[:, 2] = z
        rings.append(ring)
    P = np.array(rings)
    P[len(zs):], _ = fit_onto(body, P[len(zs):], clearance)
    P, _ = fit_onto(body, P, clearance, only_inside=True)
    # Smooth away the folds and lacing of the outfit underneath: the shell rests on it, it does not copy it.
    for _ in range(5):
        P = relax(P, 3, fixed_rows=(0,), strength=.6)
        P, _ = fit_onto(body, P, clearance, only_inside=True)
    P, W = fit_onto(body, P, clearance, only_inside=True)
    centres = np.array([[0, ring[:, 1].mean(), ring[:, 2].mean()] for ring in P])
    if ease is not None:
        for r in range(len(P)):
            e = ease(P[r, :, 2], angles)
            P[r] += hdir(angles) * e[:, None]
    if collar:
        top, w_top = P[-1], W[-1]
        centre = np.array([0, lm["neck_cy"], 0])
        extra = []
        for k in (1, 2):
            ring = centre + (top - centre) * (1 - .04 * k)
            ring[:, 2] = top[:, 2] + collar * k / 2
            extra.append(ring)
        P = np.concatenate([P, extra])
        W = np.concatenate([W, [w_top, w_top]])
        centres = np.concatenate([centres, [[0, lm["neck_cy"], ring[:, 2].mean()] for ring in extra]])
    return Grid(P, W, centres)


def skirt_weights(body, x, z, top, hem, stride, width, calf=0.0):
    """Below a waist the weights settle on the pelvis and each side follows its thigh, more toward the hem (#376 STRIDE).
    Between the legs the sides blend over ``width`` either side of the middle, so the cloth can't tear there; long skirts
    blend over the whole front and back, so they don't split between the legs. Below the knee a long skirt hands ``calf``
    of that share to the calves, so a bent knee carries the lower skirt back with the boot instead of pushing through it."""
    t = min(1.0, max(0.0, (top - z) / max(top - hem, 1e-6)))
    share = stride * t ** .5
    side = 1 if body.joint("thigh_l")[0] > 0 else -1
    to_left = smooth(-width, width, x * side)
    knee = body.joint("calf_l")[2]
    lower = share * calf * smooth(knee, knee - .25 * (knee - hem), z) if calf else 0.0
    upper = share - lower
    return body.weights({"pelvis": 1 - share, "thigh_l": upper * to_left, "thigh_r": upper * (1 - to_left),
                         "calf_l": lower * to_left, "calf_r": lower * (1 - to_left)})


def skirt(body, lm, top_ring, top_w, hem, flare, folds=None, stride=.7, rows=12, clear=.03, hem_lift=None, power=.8, blend=.6, calf=0.0):
    """Rings hanging from ``top_ring`` (one point per column) to ``hem``. ``flare(t)`` widens the radius, ``folds(angles, t)``
    multiplies it, ``hem_lift(angles)`` raises the hem per column. The top ring keeps its fitted weights and the rings below
    blend into skirt weights; every ring clears the legs and boots under it."""
    cols = len(top_ring)
    angles = ring_angles(cols)
    s = lm["height"] / 1.76
    cy = top_ring[:, 1].mean()
    z0 = top_ring[:, 2]
    v0 = top_ring[:, :2] - np.array([0, cy])
    r0 = np.linalg.norm(v0, axis=1)
    d = hdir(angles)
    lift = hem_lift(angles) if hem_lift else np.zeros(cols)
    core = body.co[body.part != "arms"]
    P, W, centres = [top_ring.copy()], [top_w.copy()], [np.array([0, cy, z0.mean()])]
    width = lm["hip_x"] * blend
    base = r0.copy()
    for k in range(1, rows + 1):
        t = k / rows
        z = z0 + (hem + lift - z0) * t ** power
        need = body.radius_profile(float(z.mean()), cy, angles, .03 * s, core) + clear * s
        m = folds(angles, t) if folds is not None else np.ones(cols)
        # Hanging cloth never narrows going down: past the seat or the belly it falls straight instead of tucking back in.
        base = np.maximum(np.maximum(r0 + flare(t), need / np.minimum(m, 1)), base)
        r = base * m
        ring = np.stack([d[:, 0] * r, cy + d[:, 1] * r, z], -1)
        P.append(ring)
        # Above the hips (a smock hung from its yoke) the cloth follows the trunk under it; from the hips down it settles on
        # the pelvis and the thighs.
        hip = lm["pelvis"] + .02 * s
        top_z = min(float(z0.mean()), hip)
        blend = smooth(0, .25, t) if z0.mean() <= hip + .03 * s else 1.0
        row = []
        for j in range(cols):
            p = ring[j]
            if p[2] > hip:
                _, _, trunk = body.nearest(np.array([p[0] * .5, cy + (p[1] - cy) * .5, p[2]]), core=True)
                w = trunk * smooth(hip, hip + .08 * s, p[2]) + skirt_weights(body, p[0], hip, top_z, hem, stride, width, calf) * (1 - smooth(hip, hip + .08 * s, p[2]))
            else:
                w = skirt_weights(body, p[0], p[2], top_z, hem, stride, width, calf)
            row.append((1 - blend) * top_w[j] + blend * w)
        W.append(np.array(row))
        centres.append(np.array([0, cy, z.mean()]))
    return Grid(np.array(P[::-1]), np.array(W[::-1]), np.array(centres[::-1]))


def sleeve(body, lm, side, cols, start, end, clearance=.01, ease=None, rows_per_m=30):
    """A tube along the arm (T-pose rest) from ``start`` to ``end`` (fractions: 0 the shoulder joint, 1 the elbow, 2 the
    wrist). ``ease(f)`` adds fullness. Rows run from the shoulder to the cuff."""
    j = body.joint
    sfx = "l" if side > 0 else "r"
    knots = np.array([j(f"upperarm_{sfx}"), j(f"lowerarm_{sfx}"), j(f"hand_{sfx}")])
    if side > 0 and knots[0, 0] < 0 or side < 0 and knots[0, 0] > 0:
        raise ValueError("sleeve side does not match the rig")

    def axis(f):
        f = min(max(f, -1.0), 2.0)
        if f < 0:
            return knots[0] + (knots[0] - knots[1]) * -f
        k = min(int(f), 1)
        return knots[k] + (knots[k + 1] - knots[k]) * (f - k)

    length = abs(axis(end)[0] - axis(start)[0])
    fs = np.linspace(start, end, max(3, int(length * rows_per_m) + 1))
    a = 2 * math.pi * np.arange(cols) / cols
    arms = body.co[np.abs(body.co[:, 0]) > lm["shoulder_x"] * .5]
    rings, centres = [], []
    for f in fs:
        c = axis(f)
        near = arms[np.abs(arms[:, 0] - c[0]) < .015]
        dist = np.hypot(near[:, 1] - c[1], near[:, 2] - c[2])
        r = np.percentile(dist[dist < .14], 90) if (dist < .14).any() else .05
        dirs = np.stack([np.zeros(cols), -np.cos(a), np.sin(a) * side], -1)
        rings.append(c + dirs * r * .8)
        centres.append(c)
    P = np.array(rings)
    P, _ = fit_onto(body, P, clearance)
    for _ in range(4):
        P = relax(P, 3, strength=.55)
        P, _ = fit_onto(body, P, clearance, only_inside=True)
    P, W = fit_onto(body, P, clearance, only_inside=True)
    centres = np.array(centres)
    if ease is not None:
        for r, f in enumerate(fs):
            out = P[r] - centres[r]
            out[:, 0] = 0
            out /= np.maximum(np.linalg.norm(out, axis=1), 1e-9)[:, None]
            P[r] += out * ease(f)
    return Grid(P, W, centres)


# --- the atlas -------------------------------------------------------------------------------------------------------

# One 2048 px atlas of 4 x 4 cells, each a 448 px tile wrapped into a 32 px gutter. Wool and linen tiles are pale so the
# consumer's dye tint (``cloth.dyed``) gives their colour; ``cloth`` shows them as they are.
CELLS = ("wool", "wool.poor", "wool.fine", "linen", "linen.poor", "linen.fine", "leather", "leather.dark",
         "trim.embroidery", "trim.braid", "rope", "brass", "smocking", "lacing", "trim.madder", "trim.woad")
REPEAT = {"wool": .7, "wool.poor": .7, "wool.fine": .7, "linen": .5, "linen.poor": .5, "linen.fine": .5, "leather": .5, "leather.dark": .5,
          "rope": .06, "brass": .05, "smocking": .16, "lacing": .25}
MAX_SQUEEZED = .02  # share of a piece's faces that may be squeezed into their cell (atlas_uv) before the build fails


def cell_origin(name):
    k = CELLS.index(name)
    return (k % 4) * CELL, (k // 4) * CELL


def atlas_uv(face_uv, cell):
    """Cell units (a tile is 1 x 1, repeating) to atlas coordinates, and whether the face had to be squeezed. The face is
    moved by whole repeats into the tile and may hang into the wrapped gutter. A face that still overhangs (a stretched
    face under a T-posed arm) is squeezed about its centre until it fits; ``Piece.mesh`` fails if that is more than a few."""
    f = np.asarray(face_uv, float)
    slack = GUTTER / (CELL - 2 * GUTTER)
    # Per axis: the whole repeat that leaves the least overhang (a face straddling a tile edge hangs into the gutter).
    low, high = f.min(0), f.max(0)
    shift = np.where(high - np.floor(low + slack) <= 1 + slack, np.floor(low + slack), np.floor(f.mean(0)))
    f = f - shift
    squeezed = bool(f.min() < -slack - 1e-6 or f.max() > 1 + slack + 1e-6)
    if squeezed:
        lo, span = f.min(0), np.maximum(f.max(0) - f.min(0), 1e-9)
        scale = np.minimum(1, 1 / span)
        f = (f - lo) * scale + (1 - span * scale) / 2
    ox, oy = cell_origin(cell)
    return [((ox + GUTTER + u * (CELL - 2 * GUTTER)) / ATLAS_SIZE, (oy + GUTTER + v * (CELL - 2 * GUTTER)) / ATLAS_SIZE) for u, v in f], squeezed


# --- pieces ----------------------------------------------------------------------------------------------------------

class Piece:
    """One garment: vertices with skin weights, and faces with their atlas cell and material."""

    def __init__(self, body, name):
        self.body, self.name = body, name
        self.verts, self.weights, self.faces = [], [], []

    def add(self, grid, cell, material, facings=(), facing_depth=.03, u_scale=None, v_scale=None, flip=None, band=None):
        """Faces between the grid's rows; ``facings`` ("bottom", "top") turn the open edge back inside by ``facing_depth``,
        so hems, cuffs and necklines show a thickness. ``band`` maps v across the tile once (trims)."""
        P, W, C = grid.P, grid.W, grid.centres
        R, N = grid.shape
        base = len(self.verts)
        self.verts += list(P.reshape(-1, 3))
        self.weights += list(W.reshape(-1, W.shape[-1]))
        repeat = REPEAT.get(cell, .25)
        us, vs = u_scale or 1 / repeat, v_scale or 1 / repeat
        seg = np.linalg.norm(np.roll(P, -1, 1) - P, axis=2) if grid.closed else np.linalg.norm(np.diff(P, axis=1), axis=2)
        # Arc length along each ring, as a fraction of that ring times the grid's mean ring: rings of different lengths
        # then keep their columns aligned, so no face shears across the tile.
        arc = np.concatenate([np.zeros((R, 1)), np.cumsum(seg, 1)], 1)
        U = arc / np.maximum(arc[:, -1:], 1e-9) * arc[:, -1].mean() * us
        V = np.concatenate([np.zeros((1, N)), np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=2), 0)], 0) * vs
        if band is not None:
            V = np.linspace(band[0], band[1], R)[:, None] * np.ones((1, N))
        if flip is None:
            r, c = R // 2, N // 2
            n = np.cross(P[r, (c + 1) % N] - P[r, c], P[r + 1 if r + 1 < R else r - 1, c] - P[r, c]) * (1 if r + 1 < R else -1)
            flip = np.dot(n, P[r, c] - C[r]) < 0
        cols = N if grid.closed else N - 1
        for r in range(R - 1):
            for c in range(cols):
                c2 = (c + 1) % N
                ids = [(r, c), (r, c2), (r + 1, c2), (r + 1, c)]
                uv = [(U[r, c], V[r, c]), (U[r, c + 1], V[r, c2]), (U[r + 1, c + 1], V[r + 1, c2]), (U[r + 1, c], V[r + 1, c])]
                vid = [base + i * N + j for i, j in ids]
                if flip:
                    vid, uv = vid[::-1], uv[::-1]
                self.faces.append((vid, uv, cell, material))
        for which in facings:
            r0, r1 = (0, 1) if which == "bottom" else (R - 1, R - 2)
            out = P[r0] - C[r0]
            inward = P[r1] - P[r0]
            inward /= np.maximum(np.linalg.norm(inward, axis=1), 1e-9)[:, None]
            out -= inward * np.sum(out * inward, 1)[:, None]
            out /= np.maximum(np.linalg.norm(out, axis=1), 1e-9)[:, None]
            inner = P[r0] + inward * facing_depth - out * .004
            ring = np.array([P[r0], inner]) if which == "bottom" else np.array([inner, P[r0]])
            g = Grid(ring, np.array([W[r0], W[r0]]), np.array([C[r0], C[r0]]), grid.closed)
            self.add(g, cell, material, flip=not self._outward(g), u_scale=us, v_scale=vs)

    @staticmethod
    def _outward(g):
        P, C = g.P, g.centres
        n = np.cross(P[0, 1] - P[0, 0], P[1, 0] - P[0, 0])
        return np.dot(n, P[0, 0] - C[0]) >= 0

    def mesh(self, arm, materials):
        bm = bmesh.new()
        verts = [bm.verts.new(p) for p in self.verts]
        uv_layer = bm.loops.layers.uv.new("UVMap")
        names = list(materials)
        self.squeezed = 0
        for vid, uv, cell, material in self.faces:
            if len(set(vid)) < 3:
                continue
            try:
                face = bm.faces.new([verts[i] for i in vid])
            except ValueError:
                continue
            face.material_index = names.index(material)
            face.smooth = True
            mapped, squeezed = atlas_uv(uv, cell)
            self.squeezed += squeezed
            for loop, t in zip(face.loops, mapped):
                loop[uv_layer].uv = t
        if self.squeezed > MAX_SQUEEZED * len(self.faces):
            raise ValueError(f"{self.name}: {self.squeezed} of {len(self.faces)} faces do not fit their atlas cells")
        mesh = bpy.data.meshes.new(self.name)
        bm.to_mesh(mesh)
        bm.free()
        for name in names:
            mesh.materials.append(materials[name])
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        W = np.array(self.weights)
        groups = {}
        for i, w in enumerate(W):
            top = np.argsort(-w)[:4]
            total = w[top].sum()
            for j in top:
                if w[j] / total > 1e-3:
                    name = self.body.joints[j]
                    if name not in groups:
                        groups[name] = obj.vertex_groups.new(name=name)
                    groups[name].add([i], float(round(w[j] / total, 5)), "REPLACE")
        obj.parent = arm
        obj.modifiers.new("Armature", "ARMATURE").object = arm
        return obj


# --- folds and hems --------------------------------------------------------------------------------------------------

def tube_folds(count, depth, seed, pleats=0, pleat_depth=0.0, pleat_until=.3):
    """Radius multiplier of a gathered skirt: ``count`` tubular folds, round outside and creased in the valleys, growing
    toward the hem; ``pleats`` small cartridge pleats at the waist that relax into them."""
    rng = np.random.RandomState(seed)
    phase = rng.uniform(-.25, .25, count)
    amp = rng.uniform(.75, 1.2, count)

    def folds(angles, t):
        x = (angles - math.pi) / (2 * math.pi) * count
        k = np.floor(x).astype(int) % count
        local = x - np.floor(x) + phase[k] * .3
        shape = 2 * np.abs(np.cos(math.pi * local)) - 1
        m = 1 + depth * (.25 + .75 * t ** .7) * amp[k] * shape
        if pleats:
            m += pleat_depth * (1 - smooth(0, pleat_until, t)) * (2 * np.abs(np.cos(math.pi * (angles - math.pi) / (2 * math.pi) * pleats)) - 1)
        return m

    def valleys(angles):
        x = (angles - math.pi) / (2 * math.pi) * count
        k = np.floor(x).astype(int) % count
        local = x - np.floor(x) + phase[k] * .3
        return (1 - np.abs(np.cos(math.pi * local))) * amp[k]

    return folds, valleys


def ragged(seed, depth, count=23):
    """An uneven, frayed hem: a few long dips and many short notches."""
    rng = np.random.RandomState(seed)
    long_phase, notch = rng.uniform(0, 2 * math.pi, 3), rng.uniform(0, 1, count)

    def lift(angles):
        a = angles - math.pi
        wave = .5 + .25 * np.sin(2 * a + long_phase[0]) + .15 * np.sin(5 * a + long_phase[1])
        k = (a / (2 * math.pi) * count).astype(int) % count
        return depth * (wave + .35 * notch[k])

    return lift


# --- garments --------------------------------------------------------------------------------------------------------

def neck_round(drop_front, drop_back, widen):
    def neckline(angles):
        front = np.maximum(0, -np.cos(angles - math.pi)) ** 2
        return drop_back + (drop_front - drop_back) * front, widen * (.6 + .4 * front)
    return neckline


def neck_scoop(depth, width, back):
    def neckline(angles):
        front = np.maximum(0, -np.cos(angles - math.pi)) ** 1.5
        return back + (depth - back) * front, width * (.45 + .55 * front)
    return neckline


def blouse(lm, base, bag, peak):
    """Ease above a belt: ``base`` everywhere, plus ``bag`` blousing out just above the belt."""
    def ease(z, angles):
        return base + bag * np.exp(-((z - peak) / (.06 * lm["height"] / 1.76)) ** 2)
    return ease


def constant(value):
    return lambda z, angles: np.full(np.shape(z), value)


def sleeve_pair(piece, body, lm, cell, material, start, end, clearance, ease, cols=16, cuff=None):
    """Both sleeves; ``cuff`` is a trim cell for a band round the cuff (the better-off finish)."""
    grids = []
    for side in (1, -1):
        grid = sleeve(body, lm, side, cols, start, end, clearance, ease)
        piece.add(grid, cell, material, facings=("top",), facing_depth=.025)
        grids.append(grid)
        if cuff:
            piece.add(edge_band(grid, "top", .035 * lm["height"] / 1.76, .0025), cuff, "cloth", u_scale=1 / .2, band=(0, 1))
    return grids


def edge_band(grid, which, height, out):
    """A trim strip along a grid's top or bottom edge, laid on the surface ``out`` metres proud of it."""
    P, C = grid.P, grid.centres
    r0, r1 = (0, 1) if which == "bottom" else (len(P) - 1, len(P) - 2)
    toward = P[r1] - P[r0]
    length = np.linalg.norm(toward, axis=1)
    toward /= np.maximum(length, 1e-9)[:, None]
    f = np.minimum(height / np.maximum(length, 1e-9), 1)[:, None]
    lower, upper = P[r0], P[r0] + (P[r1] - P[r0]) * f
    rings = np.array([lower, upper] if which == "bottom" else [upper, lower])
    for k in range(2):
        o = rings[k] - C[r0]
        o -= toward * np.sum(o * toward, 1)[:, None]
        rings[k] += o / np.maximum(np.linalg.norm(o, axis=1), 1e-9)[:, None] * out
    W = np.array([grid.W[r0], grid.W[r0]])
    return Grid(rings, W, np.array([C[r0], C[r0]]), grid.closed)


def tunic(body, lm, finish, cut, ctx):
    s = lm["height"] / 1.76
    poor, fine = finish == "poor", finish == "fine"
    cell = {"plain": "wool", "poor": "wool.poor", "fine": "wool.fine"}[finish]
    long = cut == "long"
    piece = Piece(body, "tunic")
    waist = lm["waist"]
    neck = neck_round(.02 * s, .006 * s, .42) if fine else neck_round(.03 * s, .004 * s, .3)
    top = torso(body, lm, 64, waist, neck, clearance=.009, ease=blouse(lm, .006, .022 * s, waist + .07 * s))
    hem = lm["ankle"] + .45 * (lm["knee"] - lm["ankle"]) if long else lm["knee"] - .02 * s
    folds, _ = tube_folds(14 if long else 11, .07 if long else .05, 7, pleats=40, pleat_depth=.03, pleat_until=.35)
    lower = skirt(body, lm, top.P[0], top.W[0], hem + (.03 * s if poor else 0), lambda t: (.11 if long else .075) * s * t ** .9, folds,
                  stride=.85 if long else .9, rows=15 if long else 11, blend=1.15 if long else .6, calf=.7 if long else 0, clear=.05 if long else .03, hem_lift=ragged(11, .045 * s) if poor else None)
    piece.add(lower, cell, "cloth.dyed", facings=("bottom",))
    piece.add(top, cell, "cloth.dyed", facings=("top",))
    sleeve_pair(piece, body, lm, cell, "cloth.dyed", -.2, 1.96, .009, lambda f: .003 + .007 * smooth(.6, 1.5, f) * (1 - smooth(1.8, 1.96, f)),
                cuff="trim.madder" if fine else None)
    if fine:
        piece.add(edge_band(lower, "bottom", .06 * s, .003), "trim.embroidery", "cloth", u_scale=1 / .24, band=(0, 1))
        piece.add(edge_band(top, "top", .025 * s, .002), "trim.madder", "cloth", u_scale=1 / .2, band=(0, 1))
    return piece, {"hem": hem, "chains": "skirt"}


def kirtle(body, lm, finish, cut, ctx):
    s = lm["height"] / 1.76
    poor, fine = finish == "poor", finish == "fine"
    teen, gown = cut == "teen", cut == "gown"
    cell = {"plain": "wool", "poor": "wool.poor", "fine": "wool.fine"}[finish]
    piece = Piece(body, "kirtle")
    waist = lm["waist"]
    neck = neck_scoop(.014 * s, .12, .004 * s) if teen else neck_scoop(.085 * s, .55, .02 * s)
    top = torso(body, lm, 120 if gown else 96, waist, neck, clearance=.009, ease=constant(.012 if teen else .003))
    ctx["neckline"] = top
    if gown:
        hem, flare, count, depth = lm["ankle"] - .07 * s, .2, 22, .1
    else:
        hem, flare, count, depth = lm["ankle"] + .02 * s, .13, 17, .085
    folds, valleys = tube_folds(count, depth, 5 if gown else 3, pleats=72, pleat_depth=.045, pleat_until=.25)
    lift = (lambda a: .02 * s * valleys(a) + ragged(13, .06 * s)(a)) if poor else (lambda a: .018 * s * valleys(a))
    lower = skirt(body, lm, top.P[0], top.W[0], hem + (.06 * s if poor else 0), lambda t: flare * s * t ** .7, folds, stride=.85, rows=16, hem_lift=lift, blend=1.15, calf=.7, clear=.05)
    piece.add(lower, cell, "cloth.dyed", facings=("bottom",))
    piece.add(top, cell, "cloth.dyed", facings=("top",))
    if teen:
        sleeve_pair(piece, body, lm, cell, "cloth.dyed", -.2, 1.88, .012, lambda f: .01 * (1 - smooth(1.7, 1.88, f)), cuff="trim.woad" if fine else None)
    elif gown:
        sleeve_pair(piece, body, lm, cell, "cloth.dyed", -.2, 1.05, .013, lambda f: .004 + .05 * smooth(.3, 1.05, f) ** 1.6, cuff="trim.madder")
    else:
        sleeve_pair(piece, body, lm, cell, "cloth.dyed", -.2, .95, .013, lambda f: .004 + .008 * smooth(.4, .95, f), cuff="trim.braid" if fine else None)
    if fine:
        piece.add(edge_band(lower, "bottom", (.07 if gown else .05) * s, .003), "trim.embroidery", "cloth", u_scale=1 / .24, band=(0, 1))
        piece.add(edge_band(top, "top", .022 * s, .002), "trim.madder" if gown else "trim.braid", "cloth", u_scale=1 / .2, band=(0, 1))
    # The front lacing of the bodice, from the neckline to the waist.
    piece.add(front_strip(top, .028 * s, .0015), "lacing", "cloth", u_scale=1 / (.028 * s), v_scale=1 / .24)
    return piece, {"hem": hem, "chains": "skirt"}


def front_strip(grid, width, out, z_min=-1.0, skip_top=1):
    """A narrow vertical strip down the front centre of a closed grid (lacing, a placket)."""
    P, C = grid.P, grid.centres
    R, N = grid.shape
    front = N // 2
    rows, weights, centres = [], [], []
    for r in [r for r in range(R - skip_top) if grid.P[r, N // 2, 2] >= z_min]:
        p, w = P[r, front], grid.W[r, front]
        o = p - C[r]
        o[2] = 0
        o /= max(np.linalg.norm(o), 1e-9)
        side = np.array([1.0, 0, 0])
        rows.append([p - side * width / 2 + o * out, p + side * width / 2 + o * out])
        weights.append([w, w])
        centres.append(C[r])
    g = Grid(np.array(rows), np.array(weights), np.array(centres), closed=False)
    return g


def chemise(body, lm, finish, cut, ctx):
    """The linen under the kirtle, built only where it shows: the yoke above the kirtle's neckline and the forearms."""
    s = lm["height"] / 1.76
    cell = "linen.poor" if finish == "poor" else "linen"
    piece = Piece(body, "chemise")
    teen = cut == "teen"
    bottom = lm["armpit"] - (.0 if teen else .05) * s
    neck = neck_round(.006 * s, .002 * s, .06) if teen else neck_round(.012 * s, .003 * s, .12)
    yoke = torso(body, lm, 72, bottom, neck, clearance=.0045, collar=.012 * s if teen else 0)
    piece.add(yoke, cell, "cloth", facings=("top",), facing_depth=.015)
    start = 1.75 if teen else .78
    sleeve_pair(piece, body, lm, cell, "cloth", start, 1.97, .006, lambda f: .004 + .006 * smooth(start, 1.5, f) * (1 - smooth(1.85, 1.97, f)))
    return piece, {}


def shirt(body, lm, finish, cut, ctx):
    """The linen shirt under the jerkin: its collar, yoke and sleeves; the body under the jerkin is left out."""
    s = lm["height"] / 1.76
    cell = "linen.poor" if finish == "poor" else "linen"
    piece = Piece(body, "shirt")
    yoke = torso(body, lm, 64, lm["armpit"] - .07 * s, neck_round(.01 * s, .002 * s, .16), clearance=.0055, collar=.03 * s)
    piece.add(yoke, cell, "cloth", facings=("top",), facing_depth=.015)
    sleeve_pair(piece, body, lm, cell, "cloth", -.25, 1.96, .007, lambda f: .003 + .01 * smooth(.6, 1.6, f) * (1 - smooth(1.8, 1.96, f)))
    return piece, {}


def jerkin(body, lm, finish, cut, ctx):
    """Sleeveless leather, a standing collar, front lacing and a short skirt pointed at the front."""
    s = lm["height"] / 1.76
    piece = Piece(body, "jerkin")
    bottom = lm["pelvis"] - .05 * s
    grid = torso(body, lm, 64, bottom, neck_round(.008 * s, 0, .2), clearance=.017, ease=constant(.004), collar=.024 * s)
    angles = ring_angles(64)
    front = np.maximum(0, -np.cos(angles - math.pi)) ** 6
    P = grid.P.copy()
    for r, depth in ((0, 1.0), (1, .55), (2, .2)):
        P[r, :, 2] -= .075 * s * front * depth
    P[:3], _ = fit_onto(body, P[:3], .02, only_inside=True)
    grid = Grid(P, grid.W, grid.centres)
    piece.add(grid, "leather", "cloth", facings=("bottom", "top"), facing_depth=.02)
    piece.add(front_strip(grid, .03 * s, .002, z_min=lm["pelvis"], skip_top=3), "lacing", "cloth", u_scale=1 / (.03 * s), v_scale=1 / .24)
    return piece, {}


def smock(body, lm, finish, cut, ctx):
    """A child's smock: a fitted yoke with a smocked band, the body gathered from it into deep folds, full sleeves into
    cuffs. The long cut is the smock dress, to mid-calf."""
    s = lm["height"] / 1.76
    poor, fine = finish == "poor", finish == "fine"
    cell = {"plain": "linen", "poor": "linen.poor", "fine": "linen.fine"}[finish]
    long = cut == "long"
    piece = Piece(body, "smock.long" if long else "smock")
    yoke_bottom = lm["armpit"] - .02 * s
    yoke = torso(body, lm, 72, yoke_bottom, neck_round(.02 * s, .004 * s, .2), clearance=.01, ease=constant(.004))
    hem = lm["ankle"] + .45 * (lm["knee"] - lm["ankle"]) if long else lm["knee"] + .07 * s
    folds, valleys = tube_folds(13 if long else 11, .06, 17 if long else 19, pleats=48, pleat_depth=.03, pleat_until=.2)
    lift = (lambda a: ragged(23, .05 * s)(a) + .012 * s * valleys(a)) if poor else (lambda a: .012 * s * valleys(a))
    body_grid = skirt(body, lm, yoke.P[0], yoke.W[0], hem + (.03 * s if poor else 0), lambda t: (.07 + .05 * long) * s * t ** .8, folds,
                      stride=.85 if long else .8, rows=16 if long else 12, hem_lift=lift, power=1.0, blend=1.15 if long else .8, calf=.7 if long else 0, clear=.05 if long else .03)
    piece.add(body_grid, cell, "cloth.dyed", facings=("bottom",))
    piece.add(yoke, cell, "cloth.dyed", facings=("top",))
    piece.add(edge_band(yoke, "bottom", .045 * s, .002), "smocking", "cloth.dyed", u_scale=1 / .3, band=(0, 1))
    sleeve_pair(piece, body, lm, cell, "cloth.dyed", -.2, 1.94, .011, lambda f: .008 + .022 * smooth(.5, 1.4, f) * (1 - smooth(1.72, 1.9, f)),
                cuff="trim.embroidery" if fine else None)
    if fine:
        piece.add(edge_band(body_grid, "bottom", .045 * s, .003), "trim.embroidery", "cloth", u_scale=1 / .24, band=(0, 1))
    return piece, {"hem": hem, "chains": "skirt" if long else None}


# --- layers over the garments: aprons, the pinafore and belts --------------------------------------------------------

class Layers:
    """Everything under an apron or a belt (the body and the garments it is fitted over), for clearance."""

    def __init__(self, body, pieces):
        self.body = body
        co = [body.co]
        faces = [body.core_tris]
        offset = len(body.co)
        for piece in pieces:
            co.append(np.array(piece.verts))
            faces.append(np.array([f[0][:3] for f in piece.faces] + [[f[0][0], f[0][2], f[0][3]] for f in piece.faces]) + offset)
            offset += len(piece.verts)
        self.co = np.concatenate(co)
        tris = np.concatenate(faces)
        self.bvh = BVHTree.FromPolygons([Vector(p) for p in self.co], [tuple(t) for t in tris], all_triangles=True)
        self.garment_co = np.concatenate(co[1:]) if len(co) > 1 else body.co

    def radius(self, z, cy, angles, band):
        core = self.body.co[self.body.part != "arms"]
        return np.maximum(self.body.radius_profile(z, cy, angles, band, core), self.body.radius_profile(z, cy, angles, band, self.garment_co))

    def onto(self, p, out):
        loc, normal, _, _ = self.bvh.find_nearest(Vector(p))
        loc, normal = np.array(loc), np.array(normal)
        if np.dot(p - loc, normal) >= out:
            return p
        return loc + normal * out


def hanging_panel(body, lm, layers, top, hem, half_angle, cols, rows, clear, stride, flare=0.0, folds=None, waist_w=None):
    """A front panel (apron) from height ``top`` to ``hem``, hanging straight: going down it never narrows, so it falls
    clear of the legs instead of following them."""
    s = lm["height"] / 1.76
    angles = -half_angle + 2 * half_angle * np.arange(cols) / (cols - 1)
    cy = body.section(lm["pelvis"], .03 * s, .5, None)[0]
    d = np.stack([np.sin(angles), -np.cos(angles), np.zeros(cols)], -1)
    zs = np.linspace(top, hem, rows + 1)
    need = np.array([layers.radius(z, cy, angles, .025 * s) for z in zs]) + clear
    for k in range(1, len(zs)):
        need[k] = np.maximum(need[k], need[k - 1] * (1 - .02))
    width = lm["hip_x"] * .6
    P, W, C = [], [], []
    for k, z in enumerate(zs):
        t = k / rows
        r = need[k] + flare * t
        if folds is not None:
            r = r * folds(angles, t)
        ring = np.stack([d[:, 0] * r, cy + d[:, 1] * r, np.full(cols, z)], -1)
        P.append(ring)
        W.append([skirt_weights(body, p[0], p[2], top, hem, stride, width) * smooth(0, .15, t) + (1 - smooth(0, .15, t)) * body.nearest(p * [.6, 1, 1], core=True)[2] for p in ring])
        C.append([0, cy, z])
    return Grid(np.array(P[::-1]), np.array(W[::-1]), np.array(C[::-1]), closed=False)


def strap(body, lm, layers, path, width, out, samples=24):
    """A flat strap along ``path`` (points round the body), laid over the layers ``out`` metres proud."""
    path = np.asarray(path, float)
    seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
    t = np.concatenate([[0], np.cumsum(seg)]) / seg.sum()
    ts = np.linspace(0, 1, samples)
    pts = np.array([np.interp(ts, t, path[:, i]) for i in range(3)]).T
    for _ in range(3):
        pts = np.array([layers.onto(p, out) for p in pts])
        pts[1:-1] = pts[1:-1] * .5 + (pts[:-2] + pts[2:]) * .25
    pts = np.array([layers.onto(p, out) for p in pts])
    rows, weights, centres = [], [], []
    for i, p in enumerate(pts):
        tangent = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        tangent /= max(np.linalg.norm(tangent), 1e-9)
        loc, normal, _, _ = layers.bvh.find_nearest(Vector(p))
        normal = np.array(normal)
        side = np.cross(tangent, normal)
        side /= max(np.linalg.norm(side), 1e-9)
        rows.append([p - side * width / 2, p + side * width / 2])
        weights.append([body.nearest(p, core=True)[2]] * 2)
        centres.append(p - normal * .05)
    return Grid(np.array(rows), np.array(weights), np.array(centres), closed=False)


def ring_band(body, lm, layers, z, height, out, cols=64, thickness=.0, cy=None):
    """A closed band round everything at height ``z`` (a belt or apron ties), ``out`` metres clear of it."""
    s = lm["height"] / 1.76
    angles = ring_angles(cols)
    cy = body.section(z, .03 * s, .5, body.torso_co)[0] if cy is None else cy
    d = hdir(angles)
    lo = layers.radius(z - height / 2, cy, angles, .012 * s)
    hi = layers.radius(z + height / 2, cy, angles, .012 * s)
    r = np.maximum(lo, hi)
    r = np.maximum(r, (np.roll(r, 1) + np.roll(r, -1) + r) / 3) + out
    rows = [np.stack([d[:, 0] * r, cy + d[:, 1] * r, np.full(cols, z + dz)], -1) for dz in (-height / 2, height / 2)]
    W = [[body.nearest(np.array([p[0] * .7, cy + (p[1] - cy) * .7, p[2]]), core=True)[2] for p in rows[0]]] * 2
    return Grid(np.array(rows), np.array(W), np.array([[0, cy, z - height / 2], [0, cy, z + height / 2]])), r, cy


def tube(points, radius, sides, closed_path=False):
    """A round tube along a path (rope)."""
    pts = np.asarray(points, float)
    n = len(pts)
    rings, centres = [], []
    for i in range(n + (1 if closed_path else 0)):
        p = pts[i % n]
        a, b = pts[(i - 1) % n] if (closed_path or i > 0) else pts[0], pts[(i + 1) % n] if (closed_path or i < n - 1) else pts[-1]
        t = b - a
        t /= max(np.linalg.norm(t), 1e-9)
        u = np.cross(t, [0, 0, 1]) if abs(t[2]) < .9 else np.cross(t, [1, 0, 0])
        u /= np.linalg.norm(u)
        v = np.cross(t, u)
        ring = [p + radius * (math.cos(2 * math.pi * k / sides) * u + math.sin(2 * math.pi * k / sides) * v) for k in range(sides)]
        rings.append(ring)
        centres.append(p)
    return np.array(rings), np.array(centres)


def apron_leather(body, lm, finish, cut, ctx):
    """The smith's heavy leather bib apron, to the knee, with a neck strap and waist ties."""
    s = lm["height"] / 1.76
    layers = ctx["layers"]
    piece = Piece(body, "apron.leather")
    waist = lm["waist"]
    hem = lm["knee"] - .03 * s
    lower = hanging_panel(body, lm, layers, waist, hem, .95, 18, 9, .012, .5, flare=.02)
    piece.add(lower, "leather.dark", "cloth", facings=("bottom",), facing_depth=.012)
    # The bib: from the waist to the chest, laid over the front.
    top = lm["armpit"] + .02 * s
    cy = body.section(lm["chest"], .03 * s, .3, body.torso_co)[0]
    rows, weights, centres = [], [], []
    for z in np.linspace(waist, top, 7):
        half = .62 if z < waist + .1 * s else .62 - .2 * smooth(waist + .1 * s, top, z)
        a = -half + 2 * half * np.arange(12) / 11
        d = np.stack([np.sin(a), -np.cos(a), np.zeros(12)], -1)
        ring = np.array([[0, cy, z] + di * (layers.radius(z, cy, np.array([ai]), .02 * s)[0] + .012) for di, ai in zip(d, a)])
        rows.append(ring)
        weights.append([body.nearest(p * [.5, 1, 1], core=True)[2] for p in ring])
        centres.append([0, cy, z])
    bib = Grid(np.array(rows), np.array(weights), np.array(centres), closed=False)
    piece.add(bib, "leather.dark", "cloth", facings=("top",), facing_depth=.012)
    # The neck strap, from the bib's top corners round the back of the neck.
    left, right = bib.P[-1, -1], bib.P[-1, 0]
    nz = lm["neck_top"] - .015 * s
    back = [0, lm["neck_cy"] + lm["neck_ry"] + .03 * s, nz - .01 * s]
    path = [left, [lm["neck_rx"] + .035 * s, lm["neck_cy"] - .01, nz], back, [-lm["neck_rx"] - .035 * s, lm["neck_cy"] - .01, nz], right]
    piece.add(strap(body, lm, layers, path, .022 * s, .006, 30), "leather", "cloth", u_scale=1 / .5, v_scale=1)
    ties, _, _ = ring_band(body, lm, layers, waist, .022 * s, .004)
    piece.add(ties, "leather", "cloth")
    return piece, {"chains": "apron"}


def apron_half(body, lm, finish, cut, ctx):
    """The innkeeper's linen half-apron, from the waist to above the knee, with ties round the waist."""
    s = lm["height"] / 1.76
    layers = ctx["layers"]
    piece = Piece(body, "apron.half")
    waist = lm["waist"]
    hem = lm["knee"] + .06 * s
    folds, _ = tube_folds(7, .025, 29)
    lower = hanging_panel(body, lm, layers, waist, hem, 1.05, 22, 8, .01, .55, flare=.015, folds=lambda a, t: folds(a * 3.2, t))
    piece.add(lower, "linen.fine", "cloth", facings=("bottom",), facing_depth=.02)
    ties, _, _ = ring_band(body, lm, layers, waist, .03 * s, .003)
    piece.add(ties, "linen.fine", "cloth")
    return piece, {"chains": "apron"}


def pinafore(body, lm, finish, cut, ctx):
    """A tied linen pinafore over the smock dress: a bib, a front skirt to just above the dress's hem, shoulder straps."""
    s = lm["height"] / 1.76
    layers = ctx["layers"]
    piece = Piece(body, "pinafore")
    waist = lm["waist"]
    hem = ctx.get("hem", lm["knee"]) + .07 * s
    lower = hanging_panel(body, lm, layers, waist, hem, 1.1, 22, 10, .01, .55, flare=.03)
    piece.add(lower, "linen.fine", "cloth", facings=("bottom",), facing_depth=.02)
    cy = body.section(lm["chest"], .03 * s, .3, body.torso_co)[0]
    top = lm["armpit"] - .01 * s
    rows, weights, centres = [], [], []
    for z in np.linspace(waist, top, 6):
        a = -.55 + 1.1 * np.arange(10) / 9
        d = np.stack([np.sin(a), -np.cos(a), np.zeros(10)], -1)
        ring = np.array([[0, cy, z] + di * (layers.radius(z, cy, np.array([ai]), .02 * s)[0] + .009) for di, ai in zip(d, a)])
        rows.append(ring)
        weights.append([body.nearest(p * [.5, 1, 1], core=True)[2] for p in ring])
        centres.append([0, cy, z])
    bib = Grid(np.array(rows), np.array(weights), np.array(centres), closed=False)
    piece.add(bib, "linen.fine", "cloth", facings=("top",), facing_depth=.012)
    for corner, sx in ((bib.P[-1, -1], 1), (bib.P[-1, 0], -1)):
        x = abs(corner[0])
        path = [corner, [sx * x * 1.05, cy, lm["shoulder_z"] + .04 * s], [sx * x * 1.05, cy + .12 * s, lm["armpit"]], [sx * x * .8, cy + .12 * s, waist]]
        piece.add(strap(body, lm, layers, path, .025 * s, .007, 20), "linen.fine", "cloth", u_scale=1 / .5, v_scale=1)
    ties, _, _ = ring_band(body, lm, layers, waist, .025 * s, .004)
    piece.add(ties, "linen.fine", "cloth")
    return piece, {"chains": "apron"}


def belt_rope(body, lm, finish, cut, ctx):
    """A rope belt, knotted at the front left with two hanging ends."""
    s = lm["height"] / 1.76
    layers = ctx["layers"]
    piece = Piece(body, "belt.rope")
    rad = .0065 * s
    band, r, cy = ring_band(body, lm, layers, lm["waist"], .02 * s, rad + .002, cols=40)
    path = band.P.mean(0)
    rings, centres = tube(path, rad, 8, closed_path=True)
    W = np.array([band.W[0][k % len(path)] for k in range(len(rings))])
    W = np.repeat(W[:, None, :], 8, 1)
    piece.add(Grid(rings, W, centres, closed=True), "rope", "cloth", u_scale=1 / .05, v_scale=1 / .2)
    knot = path[len(path) * 5 // 8]
    for k, (dx, length) in enumerate(((-.012, .2), (.014, .16))):
        out = knot - np.array([0, cy, knot[2]])
        out[2] = 0
        out /= np.linalg.norm(out)
        pts = [knot + out * (rad * 1.5) + [dx * s, 0, -length * s * t] + out * .02 * s * t * t for t in np.linspace(0, 1, 7)]
        pts = [layers.onto(np.array(p), rad + .003) for p in pts]
        rings, centres = tube(pts, rad * .9, 8)
        w = body.weights({"pelvis": 1.0})
        piece.add(Grid(rings, np.repeat(np.repeat(w[None, None, :], len(rings), 0), 8, 1), centres, closed=True), "rope", "cloth", u_scale=1 / .05, v_scale=1 / .2,
                  facings=("top",), facing_depth=.003)
    return piece, {}


def belt_leather(body, lm, finish, cut, ctx):
    """A leather belt with a brass buckle at the front and a pouch at the right hip."""
    s = lm["height"] / 1.76
    layers = ctx["layers"]
    piece = Piece(body, "belt.leather")
    height = .034 * s
    band, r, cy = ring_band(body, lm, layers, lm["waist"], height, .004, cols=48)
    piece.add(band, "leather", "cloth", u_scale=1 / .5, v_scale=1 / .5, facings=("top", "bottom"), facing_depth=.004)
    front = band.P[:, len(r) // 2].mean(0)
    w = band.W[0, len(r) // 2]
    out = np.array([0, -1.0, 0])
    piece.add(box(front + out * .006, (.05 * s, .006, height * 1.25), w), "brass", "cloth", u_scale=1 / .3, v_scale=1 / .3)
    k = int(len(r) * .62)
    side = band.P[:, k].mean(0)
    o = side - np.array([0, cy, side[2]])
    o[2] = 0
    o /= np.linalg.norm(o)
    centre = side + o * .028 * s - np.array([0, 0, .05 * s])
    pouch = box(centre, (.1 * s, .045 * s, .11 * s), band.W[0, k], facing=o)
    piece.add(pouch, "leather.dark", "cloth", u_scale=1 / .5, v_scale=1 / .5)
    return piece, {}


def box(centre, size, weight, facing=(0, -1, 0)):
    """A rounded-off box as one closed grid (5 rings over its height), skinned rigidly with ``weight``."""
    sx, sy, sz = size
    f = np.asarray(facing, float)
    f /= np.linalg.norm(f)
    side = np.cross([0, 0, 1], f)
    rings, centres = [], []
    for k, (h, scale) in enumerate(((-.5, .0), (-.5, .9), (-.35, 1), (.4, 1), (.5, .85), (.5, .0))):
        ring = []
        for a in np.linspace(0, 2 * math.pi, 12, endpoint=False):
            cx, cyy = math.cos(a), math.sin(a)
            m = max(abs(cx), abs(cyy)) ** .35
            ring.append(centre + side * cx / m * sx / 2 * scale - f * cyy / m * sy / 2 * scale + np.array([0, 0, h * sz]))
        rings.append(ring)
        centres.append(centre + np.array([0, 0, h * sz]))
    W = np.repeat(np.repeat(np.asarray(weight)[None, None, :], len(rings), 0), 12, 1)
    return Grid(np.array(rings), W, np.array(centres))


# --- what each fit wears ---------------------------------------------------------------------------------------------

# (piece, finishes, cut). Finishes share the cut except where the cut says otherwise: the better-off adults' long tunic
# and gown are the two distinct silhouettes (owner decision on #560 Q3). Aprons and belts come after the garments they
# are fitted over (``OVER``).
PIECES = {
    "male": [("shirt", ("plain", "poor"), "adult"), ("jerkin", ("plain",), "adult"), ("tunic", ("plain", "poor"), "regular"), ("tunic", ("fine",), "long"),
             ("apron.leather", ("plain",), "adult"), ("apron.half", ("plain",), "adult"), ("belt.rope", ("plain",), "adult"), ("belt.leather", ("plain",), "adult")],
    "female": [("chemise", ("plain", "poor"), "adult"), ("kirtle", ("plain", "poor"), "regular"), ("kirtle", ("fine",), "gown"),
               ("apron.leather", ("plain",), "adult"), ("apron.half", ("plain",), "adult"), ("belt.rope", ("plain",), "adult"), ("belt.leather", ("plain",), "adult")],
    "teen-boy": [("shirt", ("plain", "poor"), "teen"), ("jerkin", ("plain",), "teen"), ("tunic", ("plain", "poor", "fine"), "regular"),
                 ("belt.rope", ("plain",), "teen"), ("belt.leather", ("plain",), "teen")],
    "teen-girl": [("chemise", ("plain", "poor"), "teen"), ("kirtle", ("plain", "poor", "fine"), "teen"), ("smock.long", ("plain", "poor", "fine"), "long"),
                  ("pinafore", ("plain",), "teen"), ("belt.rope", ("plain",), "teen"), ("belt.leather", ("plain",), "teen")],
    "child-boy": [("smock", ("plain", "poor", "fine"), "regular"), ("belt.rope", ("plain",), "child")],
    "child-girl": [("smock", ("plain", "poor", "fine"), "regular"), ("smock.long", ("plain", "poor", "fine"), "long"), ("pinafore", ("plain",), "child"),
                   ("belt.rope", ("plain",), "child")],
}
# The garment nodes each layer is fitted over, in its fit; it clears all of them.
OVER = {
    "apron.leather": ("tunic", "tunic.poor", "jerkin", "kirtle", "kirtle.poor"),
    "apron.half": ("tunic", "tunic.poor", "tunic.fine", "jerkin", "kirtle", "kirtle.poor"),
    "pinafore": ("smock.long", "smock.long.poor", "smock.long.fine"),
    "belt.rope": ("tunic", "tunic.poor", "tunic.fine", "kirtle", "kirtle.poor", "kirtle.fine", "jerkin", "smock", "smock.poor", "smock.fine",
                  "smock.long", "smock.long.poor", "smock.long.fine"),
}
OVER["belt.leather"] = OVER["belt.rope"]
BUILDERS = {"tunic": tunic, "kirtle": kirtle, "chemise": chemise, "shirt": shirt, "jerkin": jerkin, "smock": smock, "smock.long": smock,
            "apron.leather": apron_leather, "apron.half": apron_half, "pinafore": pinafore, "belt.rope": belt_rope, "belt.leather": belt_leather}



# --- painting the atlas ----------------------------------------------------------------------------------------------

TILE = CELL - 2 * GUTTER
# Base colours (sRGB 0..1). Wool and linen are pale: ``cloth.dyed`` takes its colour from the consumer's tint.
PALETTE = {
    "wool": (.8, .78, .74), "wool.poor": (.74, .72, .67), "wool.fine": (.86, .85, .82),
    "linen": (.83, .79, .69), "linen.poor": (.68, .65, .57), "linen.fine": (.92, .9, .85),
    "leather": (.36, .21, .11), "leather.dark": (.2, .12, .07), "rope": (.62, .52, .34), "brass": (.72, .56, .26),
    "madder": (.56, .13, .08), "woad": (.15, .25, .45), "weld": (.78, .64, .2), "green": (.25, .36, .18),
}


def tile_noise(rng, scale, size=TILE):
    """Tileable smooth noise in -1..1: white noise low-passed in the frequency domain (``scale`` is the feature size in
    pixels)."""
    f = np.fft.fft2(rng.standard_normal((size, size)))
    k = np.fft.fftfreq(size)
    r2 = k[:, None] ** 2 + k[None, :] ** 2
    out = np.real(np.fft.ifft2(f * np.exp(-r2 * (scale ** 2) * 2)))
    return out / max(np.abs(out).max(), 1e-9)


def grid_xy(size=TILE):
    y, x = np.mgrid[0:size, 0:size].astype(float)
    return x, y


def weave(kind, threads):
    """Height of a woven surface: plain (tabby) linen or twill wool, ``threads`` per tile."""
    x, y = grid_xy()
    u, v = x / TILE * threads * 2 * math.pi, y / TILE * threads * 2 * math.pi
    if kind == "twill":
        return .5 + .25 * np.sin(u + v) + .15 * np.cos(u) * np.cos(v)
    return .5 + .35 * np.cos(u) * np.cos(v) * np.sign(np.sin(u / 2) * np.sin(v / 2) + 1e-9) * .5 + .15 * (np.cos(u) + np.cos(v))


def stitches(mask_edge, spacing=6):
    """A dashed stitch line along a boolean edge mask."""
    x, y = grid_xy()
    return mask_edge & (((x + y) // spacing) % 2 == 0)


def patches(rng, count, sizes):
    """Sewn-on patches: a value shift inside each, a dark stitched border and a raised seam."""
    x, y = grid_xy()
    shade, height, line = np.zeros((TILE, TILE)), np.zeros((TILE, TILE)), np.zeros((TILE, TILE), bool)
    for _ in range(count):
        cx, cy = rng.uniform(0, TILE, 2)
        w, h = rng.uniform(*sizes, 2)
        a = rng.uniform(-.3, .3)
        dx = (x - cx + TILE / 2) % TILE - TILE / 2
        dy = (y - cy + TILE / 2) % TILE - TILE / 2
        px, py = dx * math.cos(a) + dy * math.sin(a), -dx * math.sin(a) + dy * math.cos(a)
        inside = (np.abs(px) < w / 2) & (np.abs(py) < h / 2)
        edge = inside & ((np.abs(px) > w / 2 - 3) | (np.abs(py) > h / 2 - 3))
        shade[inside] = rng.choice([-.16, .12, -.1])
        height[inside] += .25
        line |= stitches(edge)
    return shade, height, line


def darns(rng, count):
    """Darned holes: a small cross-hatched oval."""
    x, y = grid_xy()
    out = np.zeros((TILE, TILE))
    for _ in range(count):
        cx, cy = rng.uniform(0, TILE, 2)
        dx = (x - cx + TILE / 2) % TILE - TILE / 2
        dy = (y - cy + TILE / 2) % TILE - TILE / 2
        r = (dx / 14) ** 2 + (dy / 9) ** 2
        out += (r < 1) * (.5 + .5 * np.sign(np.sin(dx * 1.4) * np.sin(dy * 1.4)))
    return np.clip(out, 0, 1)


def cloth_tile(rng, name):
    base = np.array(PALETTE[name])
    kind = "twill" if name.startswith("wool") else "plain"
    threads = {"wool": 96, "wool.poor": 84, "wool.fine": 128, "linen": 110, "linen.poor": 96, "linen.fine": 140}[name]
    h = weave(kind, threads)
    blotch = tile_noise(rng, 40)
    slub = tile_noise(rng, 3) * (tile_noise(rng, 20) > .3)
    value = 1 + .05 * blotch + .07 * (h - .5) + (.04 * slub if kind == "plain" else 0)
    colour = base[None, None, :] * value[..., None]
    height = h * .6 + .1 * slub
    if name.endswith(".poor"):
        fade = tile_noise(rng, 70)
        colour *= (1 + .1 * fade)[..., None]
        shade, ph, line = patches(rng, 3, (50, 110))
        colour *= (1 + shade)[..., None]
        colour[line] *= .45
        height += ph + line * .3
        d = darns(rng, 3)
        colour *= (1 - .18 * d)[..., None]
        height += d * .3
        stain = np.clip(tile_noise(rng, 25) - .55, 0, 1) * 1.6
        colour *= (1 - .25 * stain)[..., None] * np.array([1, .97, .9])
    return colour, height


def leather_tile(rng, name):
    base = np.array(PALETTE[name])
    grain = tile_noise(rng, 2.5)
    mottle = tile_noise(rng, 30)
    colour = base[None, None, :] * (1 + .12 * mottle + .06 * grain)[..., None]
    height = .5 + .25 * grain
    x, y = grid_xy()
    for _ in range(14):
        cx, cy, a = rng.uniform(0, TILE), rng.uniform(0, TILE), rng.uniform(0, math.pi)
        d = np.abs(((x - cx + TILE / 2) % TILE - TILE / 2) * math.sin(a) - ((y - cy + TILE / 2) % TILE - TILE / 2) * math.cos(a))
        along = np.abs(((x - cx + TILE / 2) % TILE - TILE / 2) * math.cos(a) + ((y - cy + TILE / 2) % TILE - TILE / 2) * math.sin(a))
        scratch = (d < 1.2) & (along < rng.uniform(15, 50))
        colour[scratch] *= 1.25
        height[scratch] -= .2
    if name == "leather.dark":
        scorch = np.clip(tile_noise(rng, 18) - .4, 0, 1) * 1.6
        colour *= (1 - .45 * scorch)[..., None]
    return colour, height


def band_tile(rng, name):
    """Trim bands: v runs across the band once, u along it."""
    x, y = grid_xy()
    u, v = x / TILE, y / TILE
    edge = (v < .12) | (v > .88)
    height = .5 + .2 * weave("plain", 70) - .3 * edge
    if name == "trim.embroidery":
        colour = np.ones((TILE, TILE, 3)) * np.array(PALETTE["madder"])
        # A row of diamonds in weld yellow, woad dots between them, and a cream stitched border.
        cu = (u * 4) % 1 - .5
        diamond = np.abs(cu) * 1.6 + np.abs(v - .5) * 2.2 < .62
        inner = np.abs(cu) * 1.6 + np.abs(v - .5) * 2.2 < .32
        dot = ((((u * 4) + .5) % 1 - .5) ** 2 + ((v - .5) * .9) ** 2) < .012
        colour[diamond] = PALETTE["weld"]
        colour[inner] = PALETTE["green"]
        colour[dot] = PALETTE["woad"]
        colour[edge] = PALETTE["linen.fine"]
        height += .25 * diamond + .15 * dot
    elif name == "trim.braid":
        chevron = ((u * 10 + np.abs(v - .5) * 3) % 1) < .5
        colour = np.where(chevron[..., None], np.array(PALETTE["madder"]), np.array(PALETTE["weld"]) * .9)
        height += .3 * chevron
    else:
        colour = np.ones((TILE, TILE, 3)) * np.array(PALETTE["madder" if name == "trim.madder" else "woad"])
        colour[edge] *= 1.35
        line = (np.abs(v - .2) < .02) | (np.abs(v - .8) < .02)
        colour[line & ((x // 5) % 2 == 0)] = PALETTE["linen.fine"]
    colour *= (1 + .05 * tile_noise(rng, 6))[..., None]
    return colour, height


def special_tile(rng, name):
    x, y = grid_xy()
    u, v = x / TILE, y / TILE
    noise = tile_noise(rng, 4)
    if name == "rope":
        s = (u * 3 + v * 3) % 1
        height = np.abs(np.sin(s * math.pi)) + .1 * noise
        colour = np.array(PALETTE["rope"])[None, None, :] * (.55 + .5 * height)[..., None]
    elif name == "brass":
        height = .5 + .1 * noise
        colour = np.array(PALETTE["brass"])[None, None, :] * (1 + .15 * tile_noise(rng, 30) + .05 * noise)[..., None]
    elif name == "smocking":
        # Honeycomb smocking: gathered diamonds with a stitch at each crossing.
        cu, cv = (u * 8) % 1 - .5, (v * 4) % 1 - .5
        cell = np.abs(cu) + np.abs(cv) * 1.2
        height = 1 - np.clip(cell * 1.6, 0, 1)
        knot = (np.abs(np.abs(cu) - .5) < .07) & (np.abs(cv) < .07)
        colour = np.array(PALETTE["linen"])[None, None, :] * (.7 + .35 * height)[..., None]
        colour[knot] *= .6
    else:  # lacing: a leather thong criss-crossing a dark slit, u across the strip, v along it
        cv = (v * 6) % 1
        slit = np.abs(u - .5) < .07
        thong = (np.abs((u - .5) - (cv - .5) * .8) < .09) | (np.abs((u - .5) + (cv - .5) * .8) < .09)
        eyelet = ((np.abs(u - .5) - .38) ** 2 + (cv - .5) ** 2 * .4) < .004
        colour = np.ones((TILE, TILE, 3)) * np.array(PALETTE["leather"]) * 1.1
        colour[slit] = (.08, .05, .03)
        colour[thong] = np.array(PALETTE["leather"]) * 1.5
        colour[eyelet] = (.1, .07, .04)
        height = .4 + .5 * thong - .3 * slit
    return colour, height


def paint_atlas():
    """The shared cloth atlas (2048 px, sRGB) and its normal map (1024 px), seeded, one tile per cell."""
    rng = np.random.RandomState(560)
    rgb = np.zeros((ATLAS_SIZE, ATLAS_SIZE, 3))
    hgt = np.zeros((ATLAS_SIZE, ATLAS_SIZE))
    for name in CELLS:
        if name.startswith(("wool", "linen")):
            colour, height = cloth_tile(rng, name)
        elif name.startswith("leather"):
            colour, height = leather_tile(rng, name)
        elif name.startswith("trim"):
            colour, height = band_tile(rng, name)
        else:
            colour, height = special_tile(rng, name)
        ox, oy = cell_origin(name)
        band = name.startswith("trim")
        pad = ((GUTTER, GUTTER), (GUTTER, GUTTER))
        if band:  # wrap along the band (u), stretch its edges across (v)
            colour = np.pad(np.pad(colour, ((0, 0), (GUTTER, GUTTER), (0, 0)), mode="wrap"), ((GUTTER, GUTTER), (0, 0), (0, 0)), mode="edge")
            height = np.pad(np.pad(height, ((0, 0), (GUTTER, GUTTER)), mode="wrap"), ((GUTTER, GUTTER), (0, 0)), mode="edge")
        else:
            colour = np.pad(colour, pad + ((0, 0),), mode="wrap")
            height = np.pad(height, pad, mode="wrap")
        rgb[oy:oy + CELL, ox:ox + CELL] = colour
        hgt[oy:oy + CELL, ox:ox + CELL] = height
    rgb = np.clip(rgb, 0, 1)
    atlas = bpy.data.images.new("resident-clothing.basecolor", ATLAS_SIZE, ATLAS_SIZE, alpha=False)
    atlas.pixels.foreach_set(np.concatenate([rgb, np.ones((ATLAS_SIZE, ATLAS_SIZE, 1))], -1).astype(np.float32).ravel())
    # Normals from the height, at half size: x right, y up (OpenGL, as glTF expects).
    h = hgt.reshape(NORMAL_SIZE, 2, NORMAL_SIZE, 2).mean((1, 3))
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 1.4
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 1.4
    n = np.stack([-gx, -gy, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    normal = bpy.data.images.new("resident-clothing.normal", NORMAL_SIZE, NORMAL_SIZE, alpha=False)
    normal.pixels.foreach_set(np.concatenate([n * .5 + .5, np.ones((NORMAL_SIZE, NORMAL_SIZE, 1))], -1).astype(np.float32).ravel())
    for image in (atlas, normal):
        image.file_format = "PNG"
        image.pack()
    return atlas, normal

def materials(atlas, normal):
    """``cloth`` and the tintable ``cloth.dyed`` share the atlas and its normal map; only the dyed one is tinted."""
    out = {}
    for name in ("cloth", "cloth.dyed"):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        tree = m.node_tree
        bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Roughness"].default_value = .9
        bsdf.inputs["Metallic"].default_value = 0
        if atlas is not None:
            tex = tree.nodes.new("ShaderNodeTexImage")
            tex.image = atlas
            tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
            ntex = tree.nodes.new("ShaderNodeTexImage")
            ntex.image = normal
            normal.colorspace_settings.name = "Non-Color"
            nmap = tree.nodes.new("ShaderNodeNormalMap")
            tree.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
            tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        out[name] = m
    return out


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    fit_name = arguments["fit"]
    fit = FITS[fit_name]
    files = {os.path.basename(str(p)): os.path.abspath(str(p)) for p in inputs.values()}
    young = inputs.load_source("young")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    parts = imported(files[fit["source"] + ".gltf"])
    arm = next(o for o in parts if o.type == "ARMATURE")
    meshes = [o for o in parts if o.type == "MESH"]
    for o in meshes:
        o.data.transform(o.matrix_world)
        o.matrix_world.identity()
    if "profile" in fit:
        young_rig(arm, meshes, young["PROFILES"][fit["profile"]], fit["scale"], young["bone_profile"])
    body = Body(arm, meshes)
    lm = landmarks(body)
    atlas, normal = paint_atlas()
    mats = materials(atlas, normal)
    built, ctx = [], {}
    for name, finishes, cut in PIECES[fit_name]:
        for finish in finishes:
            node = f"{name}.{finish}" if finish != "plain" else name
            if name in OVER:
                ctx["layers"] = Layers(body, [p for n, p, _ in built if n in OVER[name]])
            piece, info = BUILDERS[name](body, lm, finish, cut, ctx)
            if "hem" in info and name.startswith("smock.long"):
                ctx["hem"] = max(ctx.get("hem", 0), info["hem"])
            piece.name = node
            built.append((node, piece, {"piece": name, "finish": finish, "cut": cut, **info}))
    objects = [(piece.mesh(arm, mats), {**info, "squeezedFaces": piece.squeezed}) for _, piece, info in built]
    for o in meshes:
        bpy.data.objects.remove(o)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    for obj, _ in objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_skins=True, export_morph=False, export_animations=False, export_cameras=False, export_lights=False, export_extras=False, export_def_bones=False,
        export_apply=False, export_image_format="AUTO")
    return {
        "recipe": RECIPE, "fit": fit_name, "landmarks": {k: round(v, 5) for k, v in lm.items()},
        "pieces": [{"node": o.name, **{k: v for k, v in info.items() if k != "hem"}, **({"hem": round(info["hem"], 5)} if "hem" in info else {}),
                    "triangles": sum(len(p.vertices) - 2 for p in o.data.polygons)} for o, info in objects],
    }
