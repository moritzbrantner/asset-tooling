"""Greyhaven settlement props, an original scripted prop set for the existing pinned Blender script backend.

One run builds one prop (#369) for a Greyhaven Outpost public space (mmorpg#421). The props match the
Outpost building kit (docs/outpost-kit.md) and the scripted inn: dark braced timber, plain plank wood,
iron straps and hoops, coursed stone and weathered shingle. They reuse the kit's numpy textures and
materials through the kit's own ``Builder``, so the PNG bytes are identical to the kit's. Three families,
as mmorpg#421 asks:

- market: ``stall`` (counter with a striped canvas awning), ``cart`` (two-wheeled handcart), ``crate``
  and ``barrel``;
- street: ``signpost`` (hanging board sign), ``lantern-post`` and ``bench``;
- dressing: ``fence`` (2 m segment), ``planter`` and ``firewood`` (a stacked woodpile).

Frame: metres, glTF right-handed +Y up, origin on the ground at the centre of the prop's footprint, its
front towards +Z. ``fence`` follows the kit's wall convention: a 2 m module (x -1..1) with half a post
at each end, so neighbouring segments share one post.

The kit recipe (``outpost.py``) is a declared Python input named ``outpost``, and its shared helpers (``kit_common.py``) one named ``common``. No randomness: variation
comes from a SHA-256 of fixed keys (the kit's ``rnd``).

``build(prop, collection, location, yaw)`` and ``build_composition(name, collection, location)`` also
work in a live Blender session after ``use_kit(namespace)``; ``generate`` is the script-backend entry point.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

PROPS = ("stall", "cart", "crate", "barrel", "signpost", "lantern-post", "bench", "fence", "planter", "firewood")
FAMILY = {"stall": "market", "cart": "market", "crate": "market", "barrel": "market", "signpost": "street",
          "lantern-post": "street", "bench": "street", "fence": "dressing", "planter": "dressing", "firewood": "dressing"}

# Plain-colour materials the props add to the kit's: (sRGB base colour, metallic, roughness, texture).
EXTRA_MATERIALS = {
    "canvas": ((0.78, 0.72, 0.6), 0.0, 0.95, None),
    "dye": ((0.5, 0.2, 0.16), 0.0, 0.92, None),
    "sacking": ((0.6, 0.52, 0.38), 0.0, 1.0, None),
    "soil": ((0.2, 0.15, 0.11), 0.0, 1.0, None),
    "leaf": ((0.24, 0.33, 0.16), 0.0, 0.85, None),
    "endgrain": ((0.66, 0.53, 0.38), 0.0, 0.95, None),
    "horn": ((0.86, 0.66, 0.36), 0.0, 0.4, None),
}

K = {}


def use_kit(namespace):
    """Bind the Outpost kit recipe's namespace (its Builder, materials and textures)."""
    K.clear()
    K.update(namespace)
    K["MATERIALS"].update(EXTRA_MATERIALS)


def rnd(*keys):
    return K["rnd"]("settlement", *keys)


def proxy(name, lo, hi, tag="solid"):
    return K["proxy"](name, tag, lo, hi)


def r6(v):
    return [round(c, 6) for c in v]


# ---------------------------------------------------------------- shape helpers (glTF axes)

def placed(b, matrix, fn):
    """Run ``fn`` and move the faces it made by ``matrix`` (glTF axes)."""
    before = set(b.bm.faces)
    fn()
    b.transform([f for f in b.bm.faces if f not in before], matrix)


def lathe(b, rings, segments, mat, key, cap_mat=None, jitter=0.0, phase=0.0):
    """A solid of revolution about +Y: ``rings`` [(y, r)] bottom to top. A ring of radius 0 is a pole;
    otherwise the ends are capped (``cap_mat``, default ``mat``). ``jitter`` scales each vertex radially."""
    verts, index = [], []
    for k, (y, r) in enumerate(rings):
        if r <= 1e-9:
            index.append([len(verts)])
            verts.append((0.0, y, 0.0))
            continue
        row = []
        for s in range(segments):
            a = phase + 2 * math.pi * s / segments
            j = 1 + (rnd(key, k, s) - 0.5) * 2 * jitter if jitter else 1
            row.append(len(verts))
            verts.append((r * j * math.cos(a), y, -r * j * math.sin(a)))
        index.append(row)
    side, caps = [], []
    for lo, hi in zip(index, index[1:]):
        if len(lo) == 1 and len(hi) == 1:
            continue
        if len(lo) == 1:
            side += [[lo[0], hi[(s + 1) % segments], hi[s]] for s in range(segments)]
        elif len(hi) == 1:
            side += [[lo[s], lo[(s + 1) % segments], hi[0]] for s in range(segments)]
        else:
            side += [[lo[s], lo[(s + 1) % segments], hi[(s + 1) % segments], hi[s]] for s in range(segments)]
    if len(index[0]) > 1:
        caps.append(list(reversed(index[0])))
    if len(index[-1]) > 1:
        caps.append(list(index[-1]))
    made = b.faces(verts, side, mat, key, grain=(0, 1, 0))
    if caps:
        made += b.faces(verts, caps, cap_mat or mat, key + "/cap", grain=(1, 0, 0))
    return made  # wound outwards: angles run counter-clockwise seen from +Y


def rod(b, a, c, radius, segments, mat, key, cap_mat=None):
    """A cylinder from glTF point ``a`` to ``c``."""
    a, c = Vector(a), Vector(c)
    d = c - a
    rotation = Vector((0, 1, 0)).rotation_difference(d.normalized()).to_matrix().to_4x4()
    placed(b, Matrix.Translation(a) @ rotation, lambda: lathe(b, [(0, radius), (d.length, radius)], segments, mat, key, cap_mat))


def ring(b, r0, r1, z0, z1, segments, mat, key):
    """An annulus in the XY plane, extruded from z0 to z1 (a wheel rim or a hoop)."""
    verts, polys = [], []
    for s in range(segments):
        a = 2 * math.pi * s / segments
        for r in (r0, r1):
            for z in (z0, z1):
                verts.append((r * math.cos(a), r * math.sin(a), z))
    for s in range(segments):
        i, j = 4 * s, 4 * ((s + 1) % segments)
        # vertex order per segment: (r0,z0) (r0,z1) (r1,z0) (r1,z1)
        polys += [[i + 2, j + 2, j + 3, i + 3], [i, i + 1, j + 1, j], [i + 1, i + 3, j + 3, j + 1], [i, j, j + 2, i + 2]]
    return b.faces(verts, polys, mat, key, grain=(0, 0, 1))  # wound outwards


def slab(b, lo, hi, mat, key, grain=None):
    return b.box(lo, hi, mat, key, grain)


def tilted(b, center, rx, ry, fn):
    """Build with ``fn`` about the origin, then turn by ``rx`` about X and ``ry`` about Y and move to ``center``."""
    m = Matrix.Translation(Vector(center)) @ Matrix.Rotation(ry, 4, "Y") @ Matrix.Rotation(rx, 4, "X")
    placed(b, m, fn)


def sack(b, center, radius, height, key):
    """A tied grain sack: a jittered lathe with a neck."""
    rings = [(0, radius * 0.7), (0.06, radius), (height * 0.55, radius * 1.02), (height * 0.85, radius * 0.6),
             (height * 0.92, radius * 0.22), (height, radius * 0.3), (height + 0.03, 0)]
    placed(b, Matrix.Translation(Vector(center)), lambda: lathe(b, rings, 8, "sacking", key, jitter=0.08))


def clump(b, center, radius, height, key):
    """A low leafy shrub: a jittered, flattened sphere."""
    rings = [(0, 0), (height * 0.12, radius * 0.75), (height * 0.4, radius), (height * 0.7, radius * 0.85), (height * 0.92, radius * 0.45), (height, 0)]
    placed(b, Matrix.Translation(Vector(center)), lambda: lathe(b, rings, 9, "leaf", key, jitter=0.16, phase=rnd(key, "p") * 6))


# ---------------------------------------------------------------- market

def build_crate(b, origin=(0, 0, 0), size=0.7, key="crate"):
    """A plank crate with a timber frame and braced sides; its top is at ``size``."""
    s, h, t = size, size / 2, 0.06
    ox, oy, oz = origin
    def at(lo, hi):
        return (lo[0] + ox, lo[1] + oy, lo[2] + oz), (hi[0] + ox, hi[1] + oy, hi[2] + oz)
    # Plank body, inset behind the frame.
    b.box(*at((-h + 0.02, 0.0, -h + 0.02), (h - 0.02, s, h - 0.02)), "wood", f"{key}/body", grain=(1, 0, 0))
    for x in (-h, h - t):  # corner posts
        for z in (-h, h - t):
            b.box(*at((x, 0, z), (x + t, s, z + t)), "timber", f"{key}/post{x}{z}", grain=(0, 1, 0))
    for y in (0.0, s - t):  # rims, front/back and sides
        for z in (-h - 0.005, h - t + 0.005):
            b.box(*at((-h + t, y, z), (h - t, y + t, z + t)), "timber", f"{key}/rimx{y}{z}", grain=(1, 0, 0))
        for x in (-h - 0.005, h - t + 0.005):
            b.box(*at((x, y, -h + t), (x + t, y + t, h - t)), "timber", f"{key}/rimz{y}{x}", grain=(0, 0, 1))
    # One diagonal brace on the front and on the right side.
    a, c = (-h + t + ox, t + oy), (h - t + ox, s - t + oy)
    b.beam(a, c, 0.07, h + oz - 0.03, h + oz + 0.008, "timber", f"{key}/brace-front")
    tilted(b, (h + ox, oy, oz), 0, math.pi / 2, lambda: b.beam((-h + t, t), (h - t, s - t), 0.07, -0.03, 0.008, "timber", f"{key}/brace-side"))
    return s


def build_barrel(b, origin=(0, 0, 0), key="barrel"):
    """A coopered barrel with three iron hoops and a sunk head; its top is at 0.9 m."""
    H, R = 0.9, 0.3
    profile = [(0.0, R * 0.84), (0.15, R * 0.94), (0.3, R * 0.99), (0.45, R), (0.6, R * 0.99), (0.75, R * 0.94), (H, R * 0.84),
               (H, R * 0.78), (H - 0.03, R * 0.78), (H - 0.03, 0)]
    placed(b, Matrix.Translation(Vector(origin)), lambda: lathe(b, profile, 12, "wood", f"{key}/body"))
    def radius(y):
        for (y0, r0), (y1, r1) in zip(profile, profile[1:7]):
            if y0 <= y <= y1:
                return r0 + (r1 - r0) * (y - y0) / (y1 - y0)
        return R * 0.84
    for y in (0.06, 0.3, 0.6, 0.84):
        r = radius(y) + 0.008
        placed(b, Matrix.Translation(Vector(origin)), lambda y=y, r=r: lathe(b, [(y - 0.025, r), (y + 0.025, r)], 12, "iron", f"{key}/hoop{y}"))
    return H


def build_stall(part, col, root):
    """A 2.4 x 1.4 m market stall: plank counter, four posts and a striped canvas awning sloping to the front."""
    b = K["Builder"](f"settlement.{part}.mesh")
    W, D, hw, hd = 2.4, 1.4, 1.2, 0.7
    post = 0.12
    front_top, back_top = 2.25, 2.55
    for x in (-hw, hw - post):
        b.block((x, 0, hd - post), (x + post, front_top, hd), "timber", key=f"stall/post-front{x}", grain=(0, 1, 0))
        b.block((x, 0, -hd), (x + post, back_top, -hd + post), "timber", key=f"stall/post-back{x}", grain=(0, 1, 0))
    # Counter: plank front, a proud top board and a lower shelf.
    for k in range(5):
        y0 = 0.08 + k * 0.17
        b.box((-hw + post, y0, hd - 0.1), (hw - post, y0 + 0.16, hd - 0.06), "wood", f"stall/front{k}", grain=(1, 0, 0))
    b.block((-hw - 0.04, 0.93, hd - 0.62), (hw + 0.04, 0.98, hd + 0.08), "wood", 0.01, "stall/counter")
    b.box((-hw + post, 0.3, -hd + post), (hw - post, 0.34, hd - 0.1), "wood", "stall/shelf", grain=(1, 0, 0))
    for x in (-hw, hw - post):  # side rails
        b.box((x, 0.9, -hd + post), (x + post, 0.98, hd - post), "timber", f"stall/side{x}", grain=(0, 0, 1))
    b.box((-hw + post, 0.9, -hd), (hw - post, 0.98, -hd + post), "timber", "stall/back-rail", grain=(1, 0, 0))
    # Top frame the awning rests on.
    b.box((-hw - 0.02, front_top - 0.1, hd - post), (hw + 0.02, front_top, hd), "timber", "stall/lintel-front", grain=(1, 0, 0))
    b.box((-hw - 0.02, back_top - 0.1, -hd), (hw + 0.02, back_top, -hd + post), "timber", "stall/lintel-back", grain=(1, 0, 0))
    # Canvas: eight stripes from the back lintel to 0.35 m beyond the front, with a scalloped valance.
    z_back, z_front = -hd - 0.08, hd + 0.35
    slope = (front_top - back_top) / (D - post)
    y_back = back_top + 0.02 + slope * (z_back + hd - post / 2)
    y_front = back_top + 0.02 + slope * (z_front + hd - post / 2)
    stripes, x0 = 8, -hw - 0.1
    sw = (W + 0.2) / stripes
    for k in range(stripes):
        mat = "dye" if k % 2 else "canvas"
        xa, xc = x0 + k * sw, x0 + (k + 1) * sw
        top = [(xa, y_back, z_back), (xc, y_back, z_back), (xc, y_front, z_front), (xa, y_front, z_front)]
        under = [(p[0], p[1] - 0.015, p[2]) for p in top]
        verts = top + under
        polys = [[0, 3, 2, 1], [4, 5, 6, 7], [3, 7, 6, 2], [0, 1, 5, 4], [0, 4, 7, 3], [1, 2, 6, 5]]
        bmesh.ops.recalc_face_normals(b.bm, faces=b.faces(verts, polys, mat, f"stall/canvas{k}"))
        # valance flap: a short hanging strip with a pointed hem
        flap = [(xa, y_front - 0.02), (xc, y_front - 0.02), (xc, y_front - 0.2), ((xa + xc) / 2, y_front - 0.3), (xa, y_front - 0.2)]
        b.prism(flap, z_front - 0.012, z_front, mat, f"stall/flap{k}", grain=(1, 0, 0))
    for x in (-hw - 0.1, hw + 0.1):  # awning poles under the front edge
        rod(b, (x * 0.96, front_top - 0.1, hd - post / 2), (x * 0.96, y_front - 0.02, z_front - 0.02), 0.025, 6, "timber", f"stall/pole{x}")
    # Goods: a crate on the counter, a barrel and two sacks beside the stall.
    build_crate(b, (-0.55, 0.98, 0.25), 0.4, "stall/crate")
    sack(b, (0.4, 0.98, 0.3), 0.16, 0.36, "stall/sack-a")
    sack(b, (0.75, 0.98, 0.2), 0.14, 0.3, "stall/sack-b")
    b.box((-0.1, 0.98, 0.1), (0.15, 1.03, 0.45), "wood", "stall/board", grain=(1, 0, 0))
    b.finish(col, root)
    return {"collisionProxies": [proxy("counter", (-hw - 0.04, 0, -hd), (hw + 0.04, 1.0, hd + 0.08)),
                                 proxy("awning", (-hw - 0.1, front_top - 0.1, z_back), (hw + 0.1, back_top + 0.05, z_front))]}


def wheel(b, center, key):
    """A 0.9 m spoked wheel in the YZ plane, its axle along X."""
    R = 0.45
    def make():
        ring(b, R - 0.06, R, -0.03, 0.03, 16, "wood", f"{key}/felloe")
        ring(b, R, R + 0.012, -0.032, 0.032, 16, "iron", f"{key}/tyre")
        for s in range(8):
            a = 2 * math.pi * (s + 0.5) / 8
            b.beam((0.07 * math.cos(a), 0.07 * math.sin(a)), ((R - 0.05) * math.cos(a), (R - 0.05) * math.sin(a)), 0.035, -0.015, 0.015, "wood", f"{key}/spoke{s}")
        placed(b, Matrix.Rotation(math.pi / 2, 4, "X") @ Matrix.Translation((0, -0.07, 0)), lambda: lathe(b, [(0, 0.08), (0.14, 0.08)], 8, "wood", f"{key}/hub", "iron"))
    placed(b, Matrix.Translation(Vector(center)) @ Matrix.Rotation(math.pi / 2, 4, "Y"), make)


def build_cart(part, col, root):
    """A two-wheeled handcart resting level on a prop leg; the shafts point to +Z."""
    b = K["Builder"](f"settlement.{part}.mesh")
    R, bed_y = 0.462, 0.52  # the iron tyre's outer radius, so the wheels touch the ground
    hw, z0, z1 = 0.5, -0.8, 0.5
    # Bed: planks along Z on two runners, with plank sides and stakes.
    for x in (-0.36, 0.36):
        b.block((x - 0.05, bed_y - 0.1, z0), (x + 0.05, bed_y, z1 + 1.1), "timber", key=f"cart/shaft{x}", grain=(0, 0, 1))
    b.box((-hw, bed_y, z0), (hw, bed_y + 0.04, z1), "wood", "cart/floor", grain=(0, 0, 1))
    for x in (-hw, hw - 0.04):
        for k in range(2):
            b.box((x, bed_y + 0.04 + k * 0.15, z0), (x + 0.04, bed_y + 0.18 + k * 0.15, z1), "wood", f"cart/side{x}{k}", grain=(0, 0, 1))
        for z in (z0, (z0 + z1) / 2, z1 - 0.05):
            b.box((x - 0.012 if x < 0 else x + 0.04, bed_y - 0.02, z), (x if x < 0 else x + 0.052, bed_y + 0.36, z + 0.05), "timber", f"cart/stake{x}{z}", grain=(0, 1, 0))
    b.box((-hw, bed_y + 0.04, z0 - 0.04), (hw, bed_y + 0.3, z0), "wood", "cart/tailboard", grain=(1, 0, 0))
    b.box((-hw, bed_y + 0.04, z1), (hw, bed_y + 0.3, z1 + 0.04), "wood", "cart/headboard", grain=(1, 0, 0))
    # Axle and wheels under the bed's centre of mass, a prop leg under the front.
    b.box((-0.62, R - 0.04, -0.2 - 0.04), (0.62, R + 0.04, -0.2 + 0.04), "timber", "cart/axle", grain=(1, 0, 0))
    for x in (-0.6, 0.6):
        wheel(b, (x, R, -0.2), f"cart/wheel{x}")
    for x in (-0.36, 0.36):
        b.box((x - 0.03, 0, z1 + 0.55), (x + 0.03, bed_y - 0.1, z1 + 0.61), "timber", f"cart/leg{x}", grain=(0, 1, 0))
    b.box((-0.36, bed_y - 0.09, z1 + 1.0), (0.36, bed_y - 0.03, z1 + 1.05), "timber", "cart/handle", grain=(1, 0, 0))
    # Load: a sack and a small crate.
    sack(b, (-0.2, bed_y + 0.04, -0.4), 0.17, 0.4, "cart/sack")
    build_crate(b, (0.18, bed_y + 0.04, 0.1), 0.42, "cart/crate")
    b.finish(col, root)
    return {"collisionProxies": [proxy("cart", (-0.68, 0, z0 - 0.04), (0.68, bed_y + 0.36, z1 + 1.1))]}


def build_crate_part(part, col, root):
    b = K["Builder"](f"settlement.{part}.mesh")
    top = build_crate(b)
    b.finish(col, root)
    return {"stackTop": top, "collisionProxies": [proxy("crate", (-0.355, 0, -0.355), (0.355, top, 0.355))]}


def build_barrel_part(part, col, root):
    b = K["Builder"](f"settlement.{part}.mesh")
    top = build_barrel(b)
    b.finish(col, root)
    return {"stackTop": top, "collisionProxies": [proxy("barrel", (-0.31, 0, -0.31), (0.31, top, 0.31))]}


# ---------------------------------------------------------------- street

def build_signpost(part, col, root):
    """A timber post on a stone footing with a braced arm and a hanging painted board facing +Z."""
    b = K["Builder"](f"settlement.{part}.mesh")
    b.block((-0.22, 0, -0.22), (0.22, 0.25, 0.22), "stone", 0.03, "sign/footing")
    b.block((-0.08, 0.25, -0.08), (0.08, 2.9, 0.08), "timber", key="sign/post", grain=(0, 1, 0))
    b.block((-0.1, 2.9, -0.1), (0.1, 2.96, 0.1), "timber", key="sign/cap")
    b.block((0.08, 2.58, -0.05), (1.15, 2.68, 0.05), "timber", key="sign/arm", grain=(1, 0, 0))
    b.beam((0.08, 2.1), (0.62, 2.6), 0.07, -0.035, 0.035, "timber", "sign/brace")
    board = {"x0": 0.32, "x1": 1.06, "y0": 1.72, "y1": 2.3}
    for x in (board["x0"] + 0.06, board["x1"] - 0.06):  # iron hangers
        b.box((x - 0.012, board["y1"], -0.012), (x + 0.012, 2.58, 0.012), "iron", f"sign/hanger{x}")
    b.block((board["x0"], board["y0"], -0.025), (board["x1"], board["y1"], 0.025), "wood", 0.01, "sign/board", grain=(1, 0, 0))
    for z in (0.025, -0.025):  # painted panel on both faces, with a dark border
        s = 1 if z > 0 else -1
        b.box((board["x0"] + 0.05, board["y0"] + 0.05, z if s > 0 else z - 0.004), (board["x1"] - 0.05, board["y1"] - 0.05, z + 0.004 if s > 0 else z), "soot", f"sign/border{z}")
        b.box((board["x0"] + 0.08, board["y0"] + 0.08, z if s > 0 else z - 0.007), (board["x1"] - 0.08, board["y1"] - 0.08, z + 0.007 if s > 0 else z), "dye", f"sign/paint{z}")
    b.finish(col, root)
    K["empty"]("sign", col, root, ((board["x0"] + board["x1"]) / 2, (board["y0"] + board["y1"]) / 2, 0))
    return {"sign": {"node": "sign", "board": {"min": [board["x0"], board["y0"], -0.025], "max": [board["x1"], board["y1"], 0.025]}},
            "collisionProxies": [proxy("post", (-0.22, 0, -0.22), (0.22, 2.96, 0.22))]}


def build_lantern_post(part, col, root):
    """A 3 m timber lamp post on a stone footing with an iron bracket and a horn-paned lantern."""
    b = K["Builder"](f"settlement.{part}.mesh")
    b.block((-0.2, 0, -0.2), (0.2, 0.3, 0.2), "stone", 0.03, "lamp/footing")
    b.block((-0.075, 0.3, -0.075), (0.075, 3.0, 0.075), "timber", key="lamp/post", grain=(0, 1, 0))
    b.block((-0.095, 3.0, -0.095), (0.095, 3.06, 0.095), "timber", key="lamp/cap")
    # Iron bracket towards +Z with a scroll-like stay.
    b.box((-0.015, 2.82, 0.075), (0.015, 2.86, 0.62), "iron", "lamp/arm", grain=(0, 0, 1))
    tilted(b, (0, 0, 0), 0, -math.pi / 2, lambda: b.beam((0.075, 2.5), (0.42, 2.84), 0.025, -0.012, 0.012, "iron", "lamp/stay"))
    lx, ly, lz = 0.0, 2.36, 0.55
    b.box((lx - 0.008, ly + 0.36, lz - 0.008), (lx + 0.008, 2.83, lz + 0.008), "iron", "lamp/hook")
    # Lantern: base plate, four corner bars, horn panes, a pyramid hood and a ring.
    b.box((lx - 0.12, ly, lz - 0.12), (lx + 0.12, ly + 0.03, lz + 0.12), "iron", "lamp/base")
    for dx in (-0.1, 0.1):
        for dz in (-0.1, 0.1):
            b.box((lx + dx - 0.012, ly + 0.03, lz + dz - 0.012), (lx + dx + 0.012, ly + 0.3, lz + dz + 0.012), "iron", f"lamp/bar{dx}{dz}")
    b.box((lx - 0.095, ly + 0.03, lz - 0.095), (lx + 0.095, ly + 0.3, lz + 0.095), "horn", "lamp/panes")
    placed(b, Matrix.Translation((lx, ly + 0.3, lz)), lambda: lathe(b, [(0, 0.15), (0.02, 0.15), (0.1, 0.03), (0.1, 0)], 4, "iron", "lamp/hood", phase=math.pi / 4))
    b.finish(col, root)
    light = (lx, round(ly + 0.17, 6), lz)
    K["empty"]("light", col, root, light)
    return {"light": {"node": "light", "position": r6(light)},
            "collisionProxies": [proxy("post", (-0.2, 0, -0.2), (0.2, 3.06, 0.2))]}


def build_bench(part, col, root):
    """A 1.6 m plank bench on two trestle legs with a stretcher; the seat is at 0.46 m."""
    b = K["Builder"](f"settlement.{part}.mesh")
    L, seat = 1.6, 0.46
    for z0, z1 in ((-0.19, -0.005), (0.005, 0.19)):
        b.block((-L / 2, seat - 0.05, z0), (L / 2, seat, z1), "wood", 0.008, f"bench/seat{z0}", grain=(1, 0, 0))
    for x in (-0.58, 0.58):
        b.box((x - 0.04, 0.06, -0.17), (x + 0.04, seat - 0.05, 0.17), "wood", f"bench/leg{x}", grain=(0, 1, 0))
        b.block((x - 0.05, 0, -0.21), (x + 0.05, 0.07, 0.21), "timber", 0.01, f"bench/foot{x}", grain=(0, 0, 1))
        b.box((x - 0.05, seat - 0.11, -0.19), (x + 0.05, seat - 0.05, 0.19), "timber", f"bench/bearer{x}", grain=(0, 0, 1))
    b.box((-0.54, 0.16, -0.03), (0.54, 0.24, 0.03), "timber", "bench/stretcher", grain=(1, 0, 0))
    for x in (-0.58, 0.58):
        b.box((x - 0.05 if x < 0 else x - 0.01, 0.15, -0.035), (x + 0.01 if x < 0 else x + 0.05, 0.25, 0.035), "timber", f"bench/wedge{x}")
    b.finish(col, root)
    return {"seat": {"height": seat, "length": L, "depth": 0.38},
            "collisionProxies": [proxy("bench", (-L / 2, 0, -0.21), (L / 2, seat, 0.21))]}


# ---------------------------------------------------------------- dressing

FENCE_MODULE = 2.0


def build_fence(part, col, root):
    """A 2 m post-and-rail fence segment along X with half a post at each end."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, p, top = FENCE_MODULE / 2, 0.07, 1.1
    for x0, x1 in ((-hw, -hw + p), (hw - p, hw)):
        b.box((x0, 0, -0.07), (x1, top, 0.07), "timber", f"fence/post{x0}", grain=(0, 1, 0))
        b.box((x0, top, -0.08), (x1, top + 0.04, 0.08), "timber", f"fence/cap{x0}")
    for y, h in ((0.42, 0.1), (0.86, 0.1)):
        b.block((-hw + p, y, -0.03), (hw - p, y + h, 0.04), "wood", 0.01, f"fence/rail{y}", grain=(1, 0, 0))
    b.box((-0.04, 0, -0.04), (0.04, 0.98, 0.04), "timber", "fence/stake", grain=(0, 1, 0))
    b.beam((-hw + p, 0.52), (-0.04, 0.86), 0.06, -0.025, 0.035, "wood", "fence/brace-left")
    b.beam((0.04, 0.86), (hw - p, 0.52), 0.06, -0.025, 0.035, "wood", "fence/brace-right")
    b.finish(col, root)
    return {"module": {"width": FENCE_MODULE, "height": top + 0.04},
            "collisionProxies": [proxy("fence", (-hw, 0, -0.08), (hw, top + 0.04, 0.08))]}


def build_planter(part, col, root):
    """A 1.2 x 0.5 m timber planter box with soil and three leafy shrubs."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, h, t = 0.6, 0.25, 0.45, 0.06
    for x in (-hw, hw - t):
        for z in (-hd, hd - t):
            b.box((x, 0, z), (x + t, h + 0.04, z + t), "timber", f"planter/post{x}{z}", grain=(0, 1, 0))
    for k in range(3):
        y0 = 0.03 + k * 0.14
        b.box((-hw + t, y0, hd - 0.04), (hw - t, y0 + 0.13, hd - 0.005), "wood", f"planter/front{k}", grain=(1, 0, 0))
        b.box((-hw + t, y0, -hd + 0.005), (hw - t, y0 + 0.13, -hd + 0.04), "wood", f"planter/back{k}", grain=(1, 0, 0))
        b.box((-hw + 0.005, y0, -hd + t), (-hw + 0.04, y0 + 0.13, hd - t), "wood", f"planter/left{k}", grain=(0, 0, 1))
        b.box((hw - 0.04, y0, -hd + t), (hw - 0.005, y0 + 0.13, hd - t), "wood", f"planter/right{k}", grain=(0, 0, 1))
    b.box((-hw + 0.04, 0.03, -hd + 0.04), (hw - 0.04, h - 0.04, hd - 0.04), "soil", "planter/soil")
    for x, r, height in ((-0.33, 0.18, 0.38), (0.03, 0.21, 0.46), (0.36, 0.17, 0.34)):
        clump(b, (x, h - 0.08, 0.0), r, height, f"planter/shrub{x}")
    b.finish(col, root)
    return {"collisionProxies": [proxy("planter", (-hw, 0, -hd), (hw, h + 0.04, hd))]}


def build_firewood(part, col, root):
    """A 1.6 m woodpile of split billets between end stakes, on two sleepers, under a short shingle cover."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, depth = 0.8, 0.44
    for z in (-0.14, 0.14):
        b.box((-hw, 0, z - 0.05), (hw, 0.08, z + 0.05), "timber", f"wood/sleeper{z}", grain=(1, 0, 0))
    for x in (-hw - 0.07, hw):
        for z in (-0.2, 0.13):
            b.box((x, 0, z), (x + 0.07, 1.2, z + 0.07), "timber", f"wood/stake{x}{z}", grain=(0, 1, 0))
    rows, y = 5, 0.08
    r = 0.085
    for row in range(rows):
        n = 9 if row % 2 == 0 else 8
        x0 = -hw + r + (0 if row % 2 == 0 else r)
        for k in range(n):
            key = f"wood/billet{row}-{k}"
            rr = r * (0.85 + 0.25 * rnd(key, "r"))
            cx = x0 + k * 2 * r
            # A split billet: six-sided, lying along Z with its end grain to the front and back.
            m = Matrix.Translation((cx, y + r * 0.9, -depth / 2 + (rnd(key, "z") - 0.5) * 0.06)) @ Matrix.Rotation(math.pi / 2, 4, "X")
            placed(b, m, lambda rr=rr, key=key: lathe(b, [(0, rr), (depth, rr)], 6, "timber", key, "endgrain", phase=rnd(key, "a") * math.pi))
        y += r * 1.75
    top = y + 0.12
    # A short lean-to cover of shingle boards on two rafters.
    for x in (-hw - 0.05, hw - 0.02):
        tilted(b, (x, top, 0), -0.25, 0, lambda x=x: b.box((0, -0.03, -0.38), (0.07, 0.03, 0.38), "timber", f"wood/rafter{x}", grain=(0, 0, 1)))
    tilted(b, (0, top + 0.05, 0), -0.25, 0, lambda: b.box((-hw - 0.15, 0, -0.42), (hw + 0.15, 0.04, 0.42), "shingle", "wood/cover", grain=(1, 0, 0)))
    b.finish(col, root)
    return {"collisionProxies": [proxy("woodpile", (-hw - 0.07, 0, -0.42), (hw + 0.07, top + 0.2, 0.42))]}


BUILDERS = {"stall": build_stall, "cart": build_cart, "crate": build_crate_part, "barrel": build_barrel_part,
            "signpost": build_signpost, "lantern-post": build_lantern_post, "bench": build_bench,
            "fence": build_fence, "planter": build_planter, "firewood": build_firewood}


# ---------------------------------------------------------------- composition

def yaw_point(p, degrees):
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    return (p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c)


def compositions():
    """A working layout for one small Outpost market corner (12 x 9 m, centre-ground frame, the open
    square towards +Z): two stalls with stacked goods, a handcart, a bench under a lantern, a signpost,
    a fenced edge with a planter and a woodpile against it. Every item stays out of a 3 m wide
    walkway along X through the middle (z -1.5..1.5)."""
    items = []
    def add(prop, t, yaw=0.0):
        items.append({"key": f"settlement.props.{prop}", "variant": "default", "translation": r6(t), "yawDegrees": yaw})
    add("stall", (-3.2, 0, -3.0))
    add("stall", (0.0, 0, -3.0))
    add("crate", (-4.9, 0, -2.6), 12)
    add("crate", (-4.9, 0.7, -2.6), 30)
    add("crate", (-4.95, 0, -3.5), -8)
    add("barrel", (1.6, 0, -2.3))
    add("barrel", (1.65, 0, -3.0))
    add("cart", (2.75, 0, -3.3))
    for x in (-5.0, -3.0, -1.0, 1.0, 3.0, 5.0):
        add("fence", (x, 0, -4.3))
    add("firewood", (4.9, 0, -3.75))
    add("lantern-post", (-1.6, 0, 2.3), 180)
    add("bench", (0.0, 0, 2.4), 180)
    add("planter", (1.7, 0, 2.5), 180)
    add("barrel", (-3.6, 0, 2.6))
    add("signpost", (4.4, 0, 2.2), 180)
    add("crate", (-4.4, 0, 2.5), 25)
    return {"square": {"footprint": {"width": 12.0, "depth": 9.0}, "walkway": {"min": [-6.0, 0.0, -1.5], "max": [6.0, 3.5, 1.5]}, "items": items}}


# ---------------------------------------------------------------- entry points

def build(prop, collection, location=(0, 0, 0), yaw=0.0):
    """Build one prop under an empty root ``settlement.<prop>`` at ``location`` (glTF axes)."""
    if prop not in BUILDERS:
        raise ValueError(f"settlement prop must be one of {', '.join(PROPS)}")
    root = bpy.data.objects.new(f"settlement.{prop}", None)
    root.empty_display_size = 0.3
    collection.objects.link(root)
    info = BUILDERS[prop](prop, collection, root)
    root.location = K["to_blender"](location)
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
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or set(arguments) != {"schemaVersion", "prop"}:
        raise ValueError("settlement-props arguments must be {schemaVersion: 1, prop}")
    if arguments["prop"] not in PROPS:
        raise ValueError(f"settlement prop must be one of {', '.join(PROPS)}")
    if set(inputs) != {"outpost", "common"}:
        raise ValueError("settlement-props recipe takes exactly the inputs 'outpost' (outpost.py) and 'common' (kit_common.py)")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    outpost = inputs.load_source("outpost")
    outpost["use_common"](inputs.load_source("common"))
    use_kit(outpost)
    prop = arguments["prop"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    root, info = build(prop, bpy.context.scene.collection)
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
    result = {"recipe": "settlement-props-v1", "prop": prop, "family": FAMILY[prop], "unit": "meter",
              "axes": "right-handed-y-up", "origin": "footprint-base-center", "facing": "+Z", "triangleCount": triangles, **info}
    if prop == "stall":
        result["compositions"] = compositions()
    return result
