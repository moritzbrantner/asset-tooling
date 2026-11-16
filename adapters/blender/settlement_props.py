"""Greyhaven settlement props, an original scripted prop set for the existing pinned Blender script backend.

One run builds one prop (#369) for a Greyhaven Outpost public space (mmorpg#421). The props match the
Outpost building kit (docs/outpost-kit.md) and the scripted inn: dark braced timber, plain plank wood,
iron straps and hoops, coursed stone and weathered shingle. They reuse the kit's numpy textures and
materials through the kit's own ``Builder``, so the PNG bytes are identical to the kit's. Three families,
as mmorpg#421 asks:

- market: ``stall`` (counter with a striped canvas awning), ``cart`` (two-wheeled handcart), ``crate``
  and ``barrel``;
- street: ``signpost`` (hanging board sign), ``lantern-post`` and ``bench``;
- dressing: ``fence`` (2 m segment), ``planter`` and ``firewood`` (a stacked woodpile);
- a crossing (#651), in the street family: ``footbridge`` (a 9 m plank footbridge on trestles);
- village dressing for Barrowdown and Fenford (#657): ``barrel-group``, ``crate-stack``, ``grain-sacks``,
  ``wheelbarrow``, ``well``, ``fingerpost``, ``hay-bale``, ``haystack``, ``chopping-block``, ``washing-line``,
  ``flower-tub``, ``vegetable-bed`` and ``kennel``.

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

PROPS = ("stall", "cart", "crate", "barrel", "signpost", "lantern-post", "bench", "fence", "planter", "firewood", "footbridge",
         "bed", "table", "chair", "chest", "hearth",
         "barrel-group", "crate-stack", "grain-sacks", "wheelbarrow", "well", "fingerpost", "hay-bale", "haystack",
         "chopping-block", "washing-line", "flower-tub", "vegetable-bed", "kennel",
         "dresser", "settle", "rug", "cooking-pot", "jar-shelf", "spinning-wheel", "cradle", "hall-table",
         "shrine", "standing-stone", "watchtower-ruin", "bridge-railing", "stall-awning")
FAMILY = {"stall": "market", "cart": "market", "crate": "market", "barrel": "market", "signpost": "street",
          "lantern-post": "street", "bench": "street", "fence": "dressing", "planter": "dressing", "firewood": "dressing",
          "footbridge": "street", "bed": "dressing", "table": "dressing", "chair": "dressing", "chest": "dressing",
          "hearth": "dressing",
          "barrel-group": "market", "crate-stack": "market", "grain-sacks": "market", "wheelbarrow": "market",
          "well": "street", "fingerpost": "street", "hay-bale": "dressing", "haystack": "dressing",
          "chopping-block": "dressing", "washing-line": "dressing", "flower-tub": "dressing", "vegetable-bed": "dressing",
          "kennel": "dressing", **{prop: "dressing" for prop in ("dresser", "settle", "rug", "cooking-pot", "jar-shelf",
                                                                   "spinning-wheel", "cradle", "hall-table")},
          "shrine": "street", "standing-stone": "street", "watchtower-ruin": "street", "bridge-railing": "street",
          "stall-awning": "market"}

# Plain-colour materials the props add to the kit's: (sRGB base colour, metallic, roughness, texture).
EXTRA_MATERIALS = {
    "canvas": ((0.78, 0.72, 0.6), 0.0, 0.95, None),
    "dye": ((0.5, 0.2, 0.16), 0.0, 0.92, None),
    "sacking": ((0.6, 0.52, 0.38), 0.0, 1.0, None),
    "soil": ((0.2, 0.15, 0.11), 0.0, 1.0, None),
    "leaf": ((0.24, 0.33, 0.16), 0.0, 0.85, None),
    "endgrain": ((0.66, 0.53, 0.38), 0.0, 0.95, None),
    "horn": ((0.86, 0.66, 0.36), 0.0, 0.4, None),
    "straw": ((0.8, 0.67, 0.37), 0.0, 0.95, None),
    "monolith": ((0.46, 0.46, 0.43), 0.0, 0.95, None),
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


def build_barrel(b, origin=(0, 0, 0), key="barrel", segments=12, hoops=(0.06, 0.3, 0.6, 0.84)):
    """A coopered barrel with iron hoops and a sunk head; its top is at 0.9 m."""
    H, R = 0.9, 0.3
    profile = [(0.0, R * 0.84), (0.15, R * 0.94), (0.3, R * 0.99), (0.45, R), (0.6, R * 0.99), (0.75, R * 0.94), (H, R * 0.84),
               (H, R * 0.78), (H - 0.03, R * 0.78), (H - 0.03, 0)]
    placed(b, Matrix.Translation(Vector(origin)), lambda: lathe(b, profile, segments, "wood", f"{key}/body"))
    def radius(y):
        for (y0, r0), (y1, r1) in zip(profile, profile[1:7]):
            if y0 <= y <= y1:
                return r0 + (r1 - r0) * (y - y0) / (y1 - y0)
        return R * 0.84
    for y in hoops:
        r = radius(y) + 0.008
        placed(b, Matrix.Translation(Vector(origin)), lambda y=y, r=r: lathe(b, [(y - 0.025, r), (y + 0.025, r)], segments, "iron", f"{key}/hoop{y}"))
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


# ---------------------------------------------------------------- crossings

BRIDGE_LENGTH, BRIDGE_HALF_WIDTH, BRIDGE_DECK, BRIDGE_LEVEL = 9.0, 1.1, 0.55, 3.3


def build_footbridge(part, col, root):
    """A 9 m plank footbridge along Z (#651): a level 6.6 m deck 0.55 m up on two stringers and two
    braced trestles whose posts reach 1.6 m below the ends' ground into a stream bed, 1.2 m sloped
    ends down to the ground, and post-and-rail sides."""
    b = K["Builder"](f"settlement.{part}.mesh")
    L, hw, top, flat, t = BRIDGE_LENGTH, BRIDGE_HALF_WIDTH, BRIDGE_DECK, BRIDGE_LEVEL, 0.08
    end, foot = L / 2, 0.02
    slope = math.atan2(top - foot, end - flat)
    run = (end - flat) / math.cos(slope)

    def along(fn):
        # A timber drawn in its (x, y) plane, turned so its x runs along +Z; its z becomes -x.
        placed(b, Matrix.Rotation(-math.pi / 2, 4, "Y"), fn)

    # Stringers under each side: level under the deck, sloped under each end.
    for x in (-0.8, 0.8):
        for (z0, y0), (z1, y1) in (((-end, foot), (-flat, top - t)), ((-flat, top - t), (flat, top - t)), ((flat, top - t), (end, foot))):
            along(lambda z0=z0, y0=y0, z1=z1, y1=y1, x=x: b.beam(
                (z0, y0 - 0.11), (z1, y1 - 0.11), 0.2, -x - 0.09, -x + 0.09, "timber", f"bridge/stringer{x}/{z0}"))
    # Level planks across the deck, with a hairline between them.
    count = 22
    for i in range(count):
        z0 = -flat + i * (2 * flat / count)
        z1 = z0 + 2 * flat / count - 0.012
        sag = (rnd("bridge/plank", i) - 0.5) * 0.006
        b.block((-hw, top - t + sag, z0), (hw, top + sag, z1), "wood", 0.008, f"bridge/plank{i}", grain=(1, 0, 0))
    # Sloped planks on each end.
    steps = 4
    for side in (-1, 1):
        for i in range(steps):
            s = (i + 0.5) * run / steps
            z = side * (flat + s * math.cos(slope))
            y = top - t / 2 - s * math.sin(slope)
            half = run / steps / 2 - 0.008
            tilted(b, (0, y, z), side * slope, 0, lambda half=half, side=side, i=i: b.block(
                (-hw, -t / 2, -half), (hw, t / 2, half), "wood", 0.008, f"bridge/ramp{side}/{i}", grain=(1, 0, 0)))
    # Two trestles under the deck's ends: posts, a cap beam and a cross brace.
    cap = top - t - 0.22
    for z in (-flat + 0.25, flat - 0.25):
        b.block((-hw - 0.05, cap - 0.14, z - 0.11), (hw + 0.05, cap, z + 0.11), "timber", 0.012, f"bridge/cap{z}", grain=(1, 0, 0))
        for x in (-0.95, 0.95):
            b.box((x - 0.1, -1.6, z - 0.1), (x + 0.1, cap - 0.14, z + 0.1), "timber", f"bridge/post{x}/{z}", grain=(0, 1, 0))
        b.beam((-0.95, -1.35), (0.95, cap - 0.2), 0.09, z - 0.04, z + 0.04, "timber", f"bridge/brace{z}")
        b.beam((-0.95, cap - 0.2), (0.95, -1.35), 0.09, z - 0.13, z - 0.05, "timber", f"bridge/brace-back{z}")
    # Rails: posts along the level deck and at the ends' feet, a top and a middle rail.
    for x in (-hw + 0.05, hw - 0.05):
        for k in range(5):
            z = -flat + k * flat / 2
            b.box((x - 0.05, top, z - 0.05), (x + 0.05, top + 1.0, z + 0.05), "timber", f"bridge/rail-post{x}/{k}", grain=(0, 1, 0))
            b.box((x - 0.06, top + 0.96, z - 0.06), (x + 0.06, top + 1.02, z + 0.06), "iron", f"bridge/rail-cap{x}/{k}")
        for side in (-1, 1):
            b.box((x - 0.05, foot, side * (end - 0.1) - 0.05), (x + 0.05, foot + 1.0, side * (end - 0.1) + 0.05),
                  "timber", f"bridge/end-post{x}/{side}", grain=(0, 1, 0))
        for y, h in ((0.92, 0.07), (0.45, 0.06)):
            b.block((x - 0.04, top + y, -flat), (x + 0.04, top + y + h, flat), "wood", 0.008, f"bridge/rail{x}/{y}", grain=(0, 0, 1))
            for z0, y0, z1, y1 in ((-end + 0.1, foot + y, -flat, top + y), (flat, top + y, end - 0.1, foot + y)):
                along(lambda z0=z0, y0=y0, z1=z1, y1=y1, x=x, h=h, y=y: b.beam(
                    (z0, y0 + h / 2), (z1, y1 + h / 2), h, -x - 0.04, -x + 0.04, "wood", f"bridge/rail-slope{x}/{y}/{z0}"))
    b.finish(col, root)
    rail = lambda x: proxy(f"rail{'-left' if x < 0 else '-right'}", (x - 0.06, foot, -end), (x + 0.06, top + 1.02, end))
    return {"collisionProxies": [
        proxy("deck", (-hw, top - t, -flat), (hw, top, flat)),
        proxy("ramp-back", (-hw, foot, -end), (hw, top, -flat)),
        proxy("ramp-front", (-hw, foot, flat), (hw, top, end)),
        rail(-hw + 0.05), rail(hw - 0.05)]}


# ---------------------------------------------------------------- furniture (cottage interiors)

def build_bed(part, col, root):
    """A 1.0 x 2.0 m plank bed along Z, headboard at -Z: a straw mattress 0.48 m up under a dyed blanket."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hl, rail = 0.5, 1.0, 0.3
    for x in (-hw, hw - 0.07):
        for z, top in ((-hl, 0.95), (hl - 0.07, 0.55)):
            b.block((x, 0, z), (x + 0.07, top, z + 0.07), "timber", 0.008, f"bed/post{x}{z}", grain=(0, 1, 0))
    b.block((-hw + 0.07, 0.5, -hl + 0.01), (hw - 0.07, 0.9, -hl + 0.05), "wood", 0.008, "bed/headboard", grain=(1, 0, 0))
    b.block((-hw + 0.07, 0.24, hl - 0.06), (hw - 0.07, 0.5, hl - 0.02), "wood", 0.008, "bed/footboard", grain=(1, 0, 0))
    for x in (-hw, hw - 0.05):
        b.box((x, 0.18, -hl + 0.07), (x + 0.05, rail, hl - 0.07), "wood", f"bed/rail{x}", grain=(0, 0, 1))
    b.box((-hw + 0.05, 0.24, -hl + 0.07), (hw - 0.05, 0.28, hl - 0.07), "wood", "bed/slats", grain=(1, 0, 0))
    b.block((-hw + 0.06, 0.28, -hl + 0.08), (hw - 0.06, 0.44, hl - 0.08), "sacking", 0.04, "bed/mattress")
    b.block((-hw + 0.04, 0.42, -hl + 0.5), (hw - 0.04, 0.48, hl - 0.06), "dye", 0.03, "bed/blanket")
    b.block((-hw + 0.14, 0.44, -hl + 0.1), (hw - 0.14, 0.54, -hl + 0.42), "canvas", 0.04, "bed/pillow")
    b.finish(col, root)
    return {"sleep": {"height": 0.48, "head": [0.0, 0.48, -0.75]},
            "collisionProxies": [proxy("bed", (-hw, 0, -hl), (hw, 0.55, hl)), proxy("headboard", (-hw, 0, -hl), (hw, 0.95, -hl + 0.07))]}


def build_table(part, col, root):
    """A 1.4 x 0.8 m trestle table, its top 0.76 m up, with a jug and two bowls."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, top = 0.7, 0.4, 0.76
    b.block((-hw, top - 0.05, -hd), (hw, top, hd), "wood", 0.01, "table/top", grain=(1, 0, 0))
    for x in (-hw + 0.12, hw - 0.18):
        b.box((x, 0.05, -0.04), (x + 0.06, top - 0.05, 0.04), "timber", f"table/leg{x}", grain=(0, 1, 0))
        b.block((x - 0.03, 0, -hd + 0.06), (x + 0.09, 0.06, hd - 0.06), "timber", 0.01, f"table/foot{x}", grain=(0, 0, 1))
        b.box((x - 0.02, top - 0.11, -hd + 0.06), (x + 0.08, top - 0.05, hd - 0.06), "timber", f"table/bearer{x}", grain=(0, 0, 1))
    b.box((-hw + 0.18, 0.2, -0.03), (hw - 0.18, 0.27, 0.03), "timber", "table/stretcher", grain=(1, 0, 0))
    placed(b, Matrix.Translation(Vector((0.35, top, -0.1))), lambda: lathe(
        b, [(0, 0.06), (0.12, 0.08), (0.2, 0.05), (0.24, 0.035), (0.25, 0)], 10, "endgrain", "table/jug"))
    for x, z in ((-0.3, 0.12), (0.0, -0.15)):
        placed(b, Matrix.Translation(Vector((x, top, z))), lambda: lathe(
            b, [(0, 0.04), (0.04, 0.08), (0.05, 0.085), (0.05, 0)], 10, "wood", f"table/bowl{x}"))
    b.finish(col, root)
    return {"top": {"height": top, "width": 2 * hw, "depth": 2 * hd},
            "collisionProxies": [proxy("table", (-hw, 0, -hd), (hw, top, hd))]}


def build_chair(part, col, root):
    """A 0.45 m square chair, its seat 0.45 m up and its back towards -Z."""
    b = K["Builder"](f"settlement.{part}.mesh")
    h, seat = 0.225, 0.45
    for x in (-h, h - 0.045):
        for z in (-h, h - 0.045):
            top = 0.95 if z < 0 else seat - 0.04
            b.box((x, 0, z), (x + 0.045, top, z + 0.045), "timber", f"chair/leg{x}{z}", grain=(0, 1, 0))
    b.block((-h, seat - 0.04, -h), (h, seat, h), "wood", 0.008, "chair/seat", grain=(1, 0, 0))
    for y in (0.62, 0.8):
        b.box((-h + 0.045, y, -h + 0.005), (h - 0.045, y + 0.08, -h + 0.035), "wood", f"chair/slat{y}", grain=(1, 0, 0))
    b.box((-h + 0.045, 0.14, -0.02), (h - 0.045, 0.18, 0.02), "timber", "chair/stretcher", grain=(1, 0, 0))
    b.finish(col, root)
    return {"seat": {"height": seat, "length": 2 * h, "depth": 2 * h},
            "collisionProxies": [proxy("chair", (-h, 0, -h), (h, seat, h))]}


def build_chest(part, col, root):
    """A 0.9 x 0.5 m iron-bound chest 0.55 m tall, its lid slightly domed."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, h = 0.45, 0.25, 0.46
    b.block((-hw, 0, -hd), (hw, h, hd), "wood", 0.012, "chest/body", grain=(1, 0, 0))
    b.block((-hw - 0.01, h, -hd - 0.01), (hw + 0.01, h + 0.06, hd + 0.01), "wood", 0.02, "chest/lid", grain=(1, 0, 0))
    b.block((-hw + 0.02, h + 0.06, -hd + 0.04), (hw - 0.02, h + 0.09, hd - 0.04), "wood", 0.02, "chest/dome", grain=(1, 0, 0))
    for x in (-hw + 0.1, hw - 0.14):
        b.box((x, 0, -hd - 0.012), (x + 0.04, h + 0.065, hd + 0.012), "iron", f"chest/band{x}")
    b.box((-0.05, h - 0.12, hd), (0.05, h + 0.02, hd + 0.02), "iron", "chest/hasp")
    b.finish(col, root)
    return {"collisionProxies": [proxy("chest", (-hw - 0.01, 0, -hd - 0.012), (hw + 0.01, h + 0.09, hd + 0.012))]}


def build_hearth(part, col, root):
    """A 1.6 m stone fireplace against a wall at -Z: a raised firebox with logs and embers under a
    stone hood that narrows to a 2.6 m flue; its ``fire`` point is where a warm light belongs."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, d, mouth, hood = 0.8, 0.6, 0.85, 2.6
    b.block((-hw - 0.1, 0, -d), (hw + 0.1, 0.18, 0.25), "stone", 0.02, "hearth/plinth")
    for x0, x1 in ((-hw, -hw + 0.28), (hw - 0.28, hw)):
        b.block((x0, 0.18, -d), (x1, mouth, 0.0), "stone", 0.02, f"hearth/cheek{x0}")
    b.box((-hw + 0.28, 0.18, -d), (hw - 0.28, mouth, -d + 0.06), "soot", "hearth/back")
    b.block((-hw - 0.05, mouth, -d), (hw + 0.05, mouth + 0.22, 0.05), "stone", 0.02, "hearth/lintel")
    b.block((-hw + 0.1, mouth + 0.22, -d), (hw - 0.1, mouth + 0.9, -0.08), "stone", 0.02, "hearth/hood")
    b.block((-0.35, mouth + 0.9, -d), (0.35, hood, -0.25), "stone", 0.02, "hearth/flue")
    b.box((-hw + 0.1, mouth + 0.22, -0.11), (hw - 0.1, mouth + 0.28, 0.0), "timber", "hearth/mantel", grain=(1, 0, 0))
    for k, (x, ry) in enumerate(((-0.12, 0.3), (0.1, -0.25), (0.0, 1.4))):
        rod(b, (x - 0.22 * math.cos(ry), 0.26 + 0.07 * (k == 2), -0.3 - 0.22 * math.sin(ry)),
            (x + 0.22 * math.cos(ry), 0.26 + 0.07 * (k == 2), -0.3 + 0.22 * math.sin(ry)), 0.055, 7, "timber", f"hearth/log{k}", "endgrain")
    b.box((-0.25, 0.18, -0.45), (0.25, 0.22, -0.15), "horn", "hearth/embers")
    b.finish(col, root)
    return {"fire": {"position": [0.0, 0.4, -0.3]},
            "collisionProxies": [proxy("hearth", (-hw - 0.1, 0, -d), (hw + 0.1, mouth + 0.28, 0.25)),
                                 proxy("flue", (-hw + 0.1, mouth + 0.28, -d), (hw - 0.1, hood, -0.08))]}


# ---------------------------------------------------------------- village dressing (Barrowdown, Fenford)

def build_barrel_group(part, col, root):
    """Two standing barrels at the back and a third lying on wedges in front, its bung to the sky."""
    b = K["Builder"](f"settlement.{part}.mesh")
    lean = dict(segments=10, hoops=(0.08, 0.82))
    for x, z in ((-0.34, -0.32), (0.33, -0.36)):
        build_barrel(b, (x, 0, z), f"group/barrel{x}", **lean)
    R = 0.3
    placed(b, Matrix.Translation((0.45, R + 0.03, 0.32)) @ Matrix.Rotation(math.pi / 2, 4, "Z"),
           lambda: build_barrel(b, (0, 0, 0), "group/lying", **lean))
    for x in (-0.3, 0.3):
        placed(b, Matrix.Translation((x, 0, 0.32)) @ Matrix.Rotation(math.pi / 2, 4, "Y"),
               lambda x=x: b.prism([(-0.13, 0), (0.13, 0), (0.0, 0.09)], -0.05, 0.05, "timber", f"group/wedge{x}", grain=(1, 0, 0)))
    b.finish(col, root)
    return {"collisionProxies": [proxy("barrels-back", (-0.65, 0, -0.67), (0.64, 0.9, -0.03)),
                                 proxy("barrel-lying", (-0.45, 0, 0.02), (0.45, 0.63, 0.62))]}


def build_crate_stack(part, col, root):
    """Two crates side by side with a third across them and a small one beside, against a wall at -Z."""
    b = K["Builder"](f"settlement.{part}.mesh")
    build_crate(b, (-0.37, 0, -0.05), 0.7, "stack/crate-a")
    build_crate(b, (0.37, 0, -0.08), 0.7, "stack/crate-b")
    placed(b, Matrix.Translation((0.02, 0.7, -0.06)) @ Matrix.Rotation(0.18, 4, "Y"), lambda: build_crate(b, (0, 0, 0), 0.62, "stack/crate-top"))
    placed(b, Matrix.Translation((0.95, 0, 0.12)) @ Matrix.Rotation(-0.35, 4, "Y"), lambda: build_crate(b, (0, 0, 0), 0.45, "stack/crate-small"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("crates", (-0.73, 0, -0.43), (1.25, 0.7, 0.42)),
                                 proxy("crate-top", (-0.38, 0.7, -0.46), (0.42, 1.32, 0.34))]}


def build_grain_sacks(part, col, root):
    """A heap of tied grain sacks: three at the back, two in front and one lying across the front."""
    b = K["Builder"](f"settlement.{part}.mesh")
    for k, (x, z, r, h) in enumerate(((-0.36, -0.18, 0.2, 0.56), (0.0, -0.22, 0.21, 0.6), (0.36, -0.15, 0.2, 0.54),
                                       (-0.2, 0.2, 0.19, 0.5), (0.2, 0.2, 0.19, 0.5))):
        sack(b, (x, 0, z), r, h, f"sacks/{k}")
    tilted(b, (0.55, 0.19, 0.08), math.pi / 2, 0.5, lambda: sack(b, (0, 0, 0), 0.17, 0.5, "sacks/lying"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("sacks", (-0.6, 0, -0.45), (0.85, 0.6, 0.55))]}


def build_wheelbarrow(part, col, root):
    """A plank wheelbarrow, its wheel to +Z and its handles to -Z, resting on two legs with a sack in the tray."""
    b = K["Builder"](f"settlement.{part}.mesh")
    R, wz = 0.2, 0.55
    def wheel_disc():
        lathe(b, [(-0.035, 0), (-0.035, R - 0.02), (0.035, R - 0.02), (0.035, 0)], 12, "wood", "barrow/wheel")
        lathe(b, [(-0.03, R), (0.03, R)], 12, "iron", "barrow/tyre")
    placed(b, Matrix.Translation((0, R, wz)) @ Matrix.Rotation(math.pi / 2, 4, "Z"), wheel_disc)
    rod(b, (-0.08, R, wz), (0.08, R, wz), 0.025, 6, "iron", "barrow/axle")
    for s in (-1, 1):
        rod(b, (s * 0.07, R, wz), (s * 0.27, 0.55, -0.95), 0.025, 6, "timber", f"barrow/handle{s}")
        b.box((s * 0.19 - 0.025, 0, -0.32), (s * 0.19 + 0.025, 0.42, -0.27), "timber", f"barrow/leg{s}", grain=(0, 1, 0))
    # Tray: a floor, flared sides, a back board and a sloping front.
    y0, y1 = 0.45, 0.72
    b.box((-0.26, y0, -0.45), (0.26, y0 + 0.03, 0.25), "wood", "barrow/floor", grain=(0, 0, 1))
    for s in (-1, 1):
        placed(b, Matrix.Translation((s * 0.27, y0, -0.1)) @ Matrix.Rotation(s * -0.25, 4, "Z"),
               lambda s=s: b.box((-0.015, 0, -0.35), (0.015, y1 - y0, 0.35), "wood", f"barrow/side{s}", grain=(0, 0, 1)))
    b.box((-0.32, y0, -0.48), (0.32, y1, -0.45), "wood", "barrow/back", grain=(1, 0, 0))
    tilted(b, (0, y0, 0.25), 0.6, 0, lambda: b.box((-0.3, 0, -0.015), (0.3, 0.34, 0.015), "wood", "barrow/front", grain=(1, 0, 0)))
    sack(b, (0, y0 + 0.03, -0.12), 0.16, 0.34, "barrow/sack")
    b.finish(col, root)
    return {"collisionProxies": [proxy("wheelbarrow", (-0.36, 0, -0.98), (0.36, y1 + 0.05, wz + R))]}


def build_well(part, col, root):
    """A round stone well: a 1.5 m curb with dark water inside, two posts carrying a windlass with a crank,
    a rope down to a hanging bucket and a small shingle roof, its ridge along X."""
    b = K["Builder"](f"settlement.{part}.mesh")
    ro, ri, h = 0.75, 0.55, 0.75
    lathe(b, [(0, ro + 0.03), (0.12, ro + 0.03), (0.12, ro), (h - 0.06, ro), (h, ro + 0.04), (h, ri - 0.02), (0.25, ri)],
          14, "stone", "well/curb", cap_mat="soot", jitter=0.015)
    px = ro + 0.06
    for s in (-1, 1):
        b.block((s * px - 0.06, 0, -0.07), (s * px + 0.06, 2.05, 0.07), "timber", key=f"well/post{s}", grain=(0, 1, 0))
    b.block((-px - 0.1, 2.05, -0.08), (px + 0.1, 2.15, 0.08), "timber", key="well/tie", grain=(1, 0, 0))
    ay = 1.45
    rod(b, (-px + 0.06, ay, 0), (px + 0.2, ay, 0), 0.07, 8, "timber", "well/windlass", "endgrain")
    b.box((px + 0.14, ay - 0.03, -0.02), (px + 0.18, ay + 0.03, 0.26), "iron", "well/crank-arm")
    rod(b, (px + 0.16, ay, 0.24), (px + 0.36, ay, 0.24), 0.018, 6, "iron", "well/crank-handle")
    # Rope wound on the windlass and hanging to the bucket.
    b.box((-0.18, ay - 0.08, -0.08), (0.18, ay + 0.08, 0.08), "sacking", "well/rope-coil")
    by = 0.95
    b.box((-0.01, by + 0.3, 0.06), (0.01, ay - 0.07, 0.08), "sacking", "well/rope")
    placed(b, Matrix.Translation((0, by, 0.07)), lambda: lathe(b, [(0, 0.11), (0.24, 0.14), (0.24, 0.12), (0.04, 0)], 10, "wood", "well/bucket"))
    placed(b, Matrix.Translation((0, by, 0.07)), lambda: lathe(b, [(0.18, 0.138), (0.21, 0.142)], 10, "iron", "well/bucket-hoop"))
    b.box((-0.14, by + 0.22, 0.06), (0.14, by + 0.32, 0.08), "iron", "well/bail")
    # Gable roof: two shingle slopes on rafters, ridge along X.
    ridge, eave, reach = 2.55, 2.0, 0.78
    def roof():
        for s in (-1, 1):
            b.beam((s * reach, eave), (0, ridge), 0.05, -px - 0.2, px + 0.2, "shingle", f"well/roof{s}")
        b.box((-0.05, ridge - 0.02, -px - 0.22), (0.05, ridge + 0.06, px + 0.22), "timber", "well/ridge", grain=(0, 0, 1))
    placed(b, Matrix.Translation((0, 0.03, 0)) @ Matrix.Rotation(math.pi / 2, 4, "Y"), roof)
    b.finish(col, root)
    return {"collisionProxies": [proxy("curb", (-ro - 0.03, 0, -ro - 0.03), (ro + 0.03, h, ro + 0.03)),
                                 proxy("post-left", (-px - 0.06, 0, -0.07), (-px + 0.06, 2.15, 0.07)),
                                 proxy("post-right", (px - 0.06, 0, -0.07), (px + 0.06, 2.15, 0.07))]}


def build_fingerpost(part, col, root):
    """A fingerpost: a 2.5 m post on a stone footing with three pointed arms at different heights and bearings."""
    b = K["Builder"](f"settlement.{part}.mesh")
    b.block((-0.2, 0, -0.2), (0.2, 0.22, 0.2), "stone", 0.03, "finger/footing")
    b.block((-0.065, 0.22, -0.065), (0.065, 2.45, 0.065), "timber", key="finger/post", grain=(0, 1, 0))
    placed(b, Matrix.Translation((0, 2.45, 0)), lambda: lathe(b, [(0, 0.09), (0.04, 0.09), (0.16, 0)], 4, "timber", "finger/finial", phase=math.pi / 4))
    arrow = [(0.06, -0.085), (0.68, -0.085), (0.8, 0.0), (0.68, 0.085), (0.06, 0.085)]
    for k, (y, yaw) in enumerate(((2.2, 15.0), (1.96, 160.0), (1.72, -75.0))):
        def arm(k=k):
            b.prism(arrow, -0.02, 0.02, "wood", f"finger/arm{k}", grain=(1, 0, 0))
            for z in (0.02, -0.024):
                b.box((0.14, -0.035, z), (0.6, 0.035, z + 0.004), "soot", f"finger/letters{k}{z}")
        placed(b, Matrix.Translation((0, y, 0)) @ Matrix.Rotation(math.radians(yaw), 4, "Y"), arm)
    b.finish(col, root)
    return {"collisionProxies": [proxy("post", (-0.2, 0, -0.2), (0.2, 2.6, 0.2))]}


def build_hay_bale(part, col, root):
    """A 1 x 0.46 x 0.45 m rectangular hay bale tied with two twine bands; bales stack on ``stackTop``."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, h = 0.5, 0.23, 0.45
    b.block((-hw, 0, -hd), (hw, h, hd), "straw", 0.05, "bale/body", grain=(1, 0, 0))
    for x in (-0.25, 0.25):
        b.box((x - 0.015, 0.01, -hd - 0.004), (x + 0.015, h + 0.004, hd + 0.004), "sacking", f"bale/twine{x}", grain=(0, 1, 0))
    # Loose wisps along the top edge.
    for k in range(4):
        x = -0.38 + k * 0.25
        tilted(b, (x, h - 0.01, hd - 0.04), 0.5, rnd("bale/wisp", k) * 2, lambda k=k: b.prism([(-0.06, 0), (0.06, 0), (0, 0.07)], -0.004, 0.004, "straw", f"bale/wisp{k}"))
    b.finish(col, root)
    return {"stackTop": h, "collisionProxies": [proxy("bale", (-hw, 0, -hd), (hw, h, hd))]}


def build_haystack(part, col, root):
    """A rounded field haystack about 2.3 m across, built around a pole that sticks out of the top."""
    b = K["Builder"](f"settlement.{part}.mesh")
    rings = [(0, 1.0), (0.35, 1.12), (0.9, 1.08), (1.4, 0.86), (1.85, 0.55), (2.15, 0.26), (2.3, 0.08), (2.33, 0)]
    lathe(b, rings, 12, "straw", "haystack/body", jitter=0.06)
    # A loose skirt of fallen hay around the foot.
    lathe(b, [(0, 1.3), (0.08, 1.12)], 12, "straw", "haystack/skirt", jitter=0.08, phase=0.3)
    rod(b, (0.02, 2.0, -0.03), (0.05, 2.75, -0.08), 0.04, 6, "timber", "haystack/pole", "endgrain")
    b.finish(col, root)
    return {"collisionProxies": [proxy("haystack", (-1.12, 0, -1.12), (1.12, 2.3, 1.12))]}


def build_chopping_block(part, col, root):
    """A chopping block with an axe bitten into it, split pieces at its foot and a small pile of logs to its left."""
    b = K["Builder"](f"settlement.{part}.mesh")
    top = 0.5
    lathe(b, [(0, 0.26), (0.06, 0.23), (top - 0.03, 0.21), (top, 0.2)], 10, "timber", "block/stump", cap_mat="endgrain", jitter=0.04)
    def axe():
        b.prism([(-0.04, 0.04), (-0.05, -0.05), (-0.09, -0.15), (0.1, -0.15), (0.06, -0.05), (0.05, 0.04)], -0.022, 0.022, "iron", "block/axe-head")
        b.box((-0.06, -0.018, -0.016), (0.72, 0.018, 0.016), "timber", "block/axe-handle", grain=(1, 0, 0))
    placed(b, Matrix.Translation((-0.02, top + 0.09, 0.02)) @ Matrix.Rotation(math.radians(-50), 4, "Y") @ Matrix.Rotation(math.radians(28), 4, "Z"), axe)
    # Split pieces fallen around the block.
    for k, (x, z, yaw) in enumerate(((0.4, 0.15, 0.4), (0.3, 0.42, -0.9), (-0.05, 0.42, 1.6))):
        placed(b, Matrix.Translation((x, 0.06, z)) @ Matrix.Rotation(yaw, 4, "Y") @ Matrix.Rotation(math.pi / 2, 4, "Z"),
               lambda k=k: lathe(b, [(-0.17, 0.06), (0.17, 0.06)], 5, "timber", f"block/split{k}", "endgrain", phase=rnd("split", k)))
    # Unsplit logs: two on the ground and one on top, end grain to the front.
    for k, (x, y) in enumerate(((-0.95, 0.11), (-0.72, 0.11), (-0.835, 0.3))):
        rod(b, (x, y, -0.35), (x, y, 0.35), 0.11, 7, "timber", f"block/log{k}", "endgrain")
    b.finish(col, root)
    return {"collisionProxies": [proxy("block", (-0.26, 0, -0.26), (0.26, top, 0.26)), proxy("logs", (-1.06, 0, -0.35), (-0.61, 0.41, 0.35))]}


def build_washing_line(part, col, root):
    """A 3.6 m washing line along X between two T-posts, sagging under a sheet, a shirt and two cloths."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, high, low = 1.8, 1.95, 1.78
    for s in (-1, 1):
        b.box((s * hw - 0.05, 0, -0.05), (s * hw + 0.05, 2.05, 0.05), "timber", f"line/post{s}", grain=(0, 1, 0))
        b.box((s * hw - 0.04, 1.93, -0.25), (s * hw + 0.04, 2.0, 0.25), "timber", f"line/bar{s}", grain=(0, 0, 1))
    def sag(x):
        return low + (high - low) * (x / hw) ** 2
    xs = [-hw, -0.9, 0.0, 0.9, hw]
    for x0, x1 in zip(xs, xs[1:]):
        b.beam((x0, sag(x0)), (x1, sag(x1)), 0.014, -0.007, 0.007, "sacking", f"line/rope{x0}")
    for k, (x, w, h, mat) in enumerate(((-1.1, 0.8, 0.9, "canvas"), (-0.15, 0.5, 0.6, "dye"), (0.6, 0.55, 0.45, "sacking"), (1.3, 0.4, 0.5, "canvas"))):
        y = sag(x)
        b.prism([(x - w / 2, y - h), (x + w / 2, y - h * 0.97), (x + w / 2, sag(x + w / 2)), (x - w / 2, sag(x - w / 2))], -0.006, 0.006, mat, f"line/cloth{k}", grain=(1, 0, 0))
        for px in (x - w / 2 + 0.04, x + w / 2 - 0.04):
            b.box((px - 0.01, sag(px) - 0.04, -0.012), (px + 0.01, sag(px) + 0.02, 0.012), "timber", f"line/peg{k}{px}")
    # The basket the washing came in.
    placed(b, Matrix.Translation((0.5, 0, 0.55)), lambda: lathe(b, [(0, 0.2), (0.25, 0.26), (0.25, 0.23), (0.05, 0)], 10, "endgrain", "line/basket"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("post-left", (-hw - 0.05, 0, -0.25), (-hw + 0.05, 2.05, 0.25)),
                                 proxy("post-right", (hw - 0.05, 0, -0.25), (hw + 0.05, 2.05, 0.25))]}


def flower(b, center, mat, key):
    placed(b, Matrix.Translation(Vector(center)), lambda: lathe(b, [(0, 0.02), (0.04, 0.085), (0.07, 0)], 5, mat, key, phase=rnd(key, "p")))


def build_flower_tub(part, col, root):
    """A half-barrel tub of soil with leafy clumps and red, white and yellow flowers."""
    b = K["Builder"](f"settlement.{part}.mesh")
    r, h = 0.36, 0.42
    lathe(b, [(0, r - 0.05), (h * 0.5, r - 0.01), (h, r), (h, r - 0.03), (h - 0.06, r - 0.04)], 12, "wood", "tub/body", cap_mat="soil")
    for y, hr in ((0.07, r - 0.028), (h - 0.08, r + 0.006)):
        lathe(b, [(y - 0.02, hr), (y + 0.02, hr + 0.003)], 12, "iron", f"tub/hoop{y}")
    for k, (x, z, cr, ch) in enumerate(((-0.12, -0.08, 0.17, 0.3), (0.13, -0.05, 0.16, 0.26), (0.0, 0.14, 0.15, 0.24))):
        placed(b, Matrix.Translation((x, h - 0.08, z)), lambda k=k, cr=cr, ch=ch: lathe(
            b, [(0, 0), (ch * 0.15, cr * 0.8), (ch * 0.5, cr), (ch * 0.85, cr * 0.6), (ch, 0)], 7, "leaf", f"tub/clump{k}", jitter=0.18))
    colours = ("dye", "canvas", "horn")
    for k in range(9):
        a = k * 2.4
        rr = 0.06 + 0.19 * rnd("tub/flower", k)
        x, z = rr * math.cos(a), rr * math.sin(a)
        flower(b, (x, h + 0.08 + 0.14 * rnd("tub/fy", k), z), colours[k % 3], f"tub/flower{k}")
    b.finish(col, root)
    return {"collisionProxies": [proxy("tub", (-r, 0, -r), (r, h, r))]}


def build_vegetable_bed(part, col, root):
    """A 1.8 x 1.0 m raised plank bed with two rows of cabbages and a row of carrot tops."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, h, t = 0.9, 0.5, 0.26, 0.05
    for x in (-hw, hw - t):
        for z in (-hd, hd - t):
            b.box((x, 0, z), (x + t, h + 0.04, z + t), "timber", f"bed/post{x}{z}", grain=(0, 1, 0))
    b.box((-hw + t, 0, hd - 0.035), (hw - t, h, hd - 0.005), "wood", "bed/front", grain=(1, 0, 0))
    b.box((-hw + t, 0, -hd + 0.005), (hw - t, h, -hd + 0.035), "wood", "bed/back", grain=(1, 0, 0))
    b.box((-hw + 0.005, 0, -hd + t), (-hw + 0.035, h, hd - t), "wood", "bed/left", grain=(0, 0, 1))
    b.box((hw - 0.035, 0, -hd + t), (hw - 0.005, h, hd - t), "wood", "bed/right", grain=(0, 0, 1))
    b.box((-hw + 0.035, 0.02, -hd + 0.035), (hw - 0.035, h - 0.03, hd - 0.035), "soil", "bed/soil")
    for row, z in enumerate((-0.25, 0.02)):
        for k in range(4):
            x = -0.6 + k * 0.4 + (0.12 if row else 0)
            key = f"bed/cabbage{row}{k}"
            placed(b, Matrix.Translation((x, h - 0.04, z)), lambda key=key: lathe(
                b, [(0, 0), (0.05, 0.13), (0.15, 0.14), (0.21, 0)], 6, "leaf", key, jitter=0.12, phase=rnd(key, "p")))
    for k in range(7):
        x = -0.72 + k * 0.24
        key = f"bed/carrot{k}"
        placed(b, Matrix.Translation((x, h - 0.03, 0.3)), lambda key=key: lathe(b, [(0, 0.05), (0.16, 0)], 4, "leaf", key, phase=rnd(key, "p")))
    b.finish(col, root)
    return {"collisionProxies": [proxy("bed", (-hw, 0, -hd), (hw, h + 0.04, hd))]}


def build_kennel(part, col, root):
    """A plank dog kennel, 0.9 x 1.1 m, its arched-top doorway to +Z under a shingle gable, a water bowl in front."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, wall, ridge, t = 0.45, 0.55, 0.6, 0.98, 0.04
    b.block((-hw - 0.03, 0, -hd - 0.03), (hw + 0.03, 0.08, hd + 0.03), "timber", 0.01, "kennel/sill")
    for s in (-1, 1):
        b.box((s * hw - (t if s > 0 else 0), 0.08, -hd), (s * hw + (0 if s > 0 else t), wall, hd), "wood", f"kennel/side{s}", grain=(0, 0, 1))
    gable = [(-hw, 0.08), (hw, 0.08), (hw, wall), (0, ridge), (-hw, wall)]
    b.prism(gable, -hd, -hd + t, "wood", "kennel/back", grain=(1, 0, 0))
    door_w, door_h = 0.2, 0.5
    b.prism([(-hw, 0.08), (-door_w, 0.08), (-door_w, door_h), (0, door_h + 0.06), (0, ridge), (-hw, wall)], hd - t, hd, "wood", "kennel/front-left", grain=(1, 0, 0))
    b.prism([(door_w, 0.08), (hw, 0.08), (hw, wall), (0, ridge), (0, door_h + 0.06), (door_w, door_h)], hd - t, hd, "wood", "kennel/front-right", grain=(1, 0, 0))
    b.box((-door_w + 0.002, 0.08, hd - t - 0.002), (door_w - 0.002, door_h, hd - t), "soot", "kennel/dark")
    for s in (-1, 1):
        b.beam((s * (hw + 0.1), wall - 0.08), (0, ridge + 0.04), 0.04, -hd - 0.08, hd + 0.08, "shingle", f"kennel/roof{s}")
    b.box((-0.03, ridge + 0.01, -hd - 0.1), (0.03, ridge + 0.08, hd + 0.1), "timber", "kennel/ridge", grain=(0, 0, 1))
    placed(b, Matrix.Translation((0.32, 0, hd + 0.22)), lambda: lathe(b, [(0, 0.1), (0.07, 0.13), (0.07, 0.11), (0.03, 0)], 8, "iron", "kennel/bowl", cap_mat="soot"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("kennel", (-hw - 0.03, 0, -hd - 0.03), (hw + 0.03, ridge, hd + 0.03))]}


# ---------------------------------------------------------------- farmhouse and lodge interiors (#663)

def plate(b, center, radius, lean, mat, key):
    """A plate standing on its rim, its face toward +Z and leaning back by ``lean`` radians."""
    placed(b, Matrix.Translation(Vector(center)) @ Matrix.Rotation(math.pi / 2 - lean, 4, "X"),
           lambda: lathe(b, [(-0.006, radius), (0.006, radius * 0.92), (0.006, 0)], 8, mat, key))


def cup(b, center, radius, height, mat, key):
    placed(b, Matrix.Translation(Vector(center)), lambda: lathe(b, [(0, radius * 0.8), (height, radius), (height, radius * 0.85), (height * 0.3, 0)], 8, mat, key))


def build_dresser(part, col, root):
    """A 1.2 m kitchen dresser for a wall at -Z: a two-door cupboard under a worktop and open plate racks above, set
    with plates, cups and a jug."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, base, top = 0.6, 0.225, 0.85, 1.9
    b.block((-hw, 0, -hd), (hw, base, hd), "wood", 0.01, "dresser/cupboard", grain=(1, 0, 0))
    b.box((-hw + 0.02, 0, hd - 0.02), (hw - 0.02, 0.06, hd + 0.005), "timber", "dresser/plinth", grain=(1, 0, 0))
    for x0, x1 in ((-hw + 0.06, -0.02), (0.02, hw - 0.06)):
        b.box((x0, 0.12, hd), (x1, base - 0.08, hd + 0.012), "timber", f"dresser/door{x0}", grain=(0, 1, 0))
        b.box((x0 + 0.05, 0.18, hd + 0.012), (x1 - 0.05, base - 0.14, hd + 0.018), "wood", f"dresser/panel{x0}", grain=(0, 1, 0))
        kx = x1 - 0.05 if x0 < 0 else x0 + 0.05
        b.box((kx - 0.015, 0.47, hd + 0.012), (kx + 0.015, 0.5, hd + 0.04), "iron", f"dresser/knob{x0}")
    b.block((-hw - 0.03, base, -hd - 0.01), (hw + 0.03, base + 0.05, hd + 0.03), "wood", 0.01, "dresser/worktop", grain=(1, 0, 0))
    d = -hd + 0.25
    for x in (-hw, hw - 0.04):
        b.box((x, base + 0.05, -hd), (x + 0.04, top, d), "wood", f"dresser/side{x}", grain=(0, 1, 0))
    b.box((-hw + 0.04, base + 0.05, -hd), (hw - 0.04, top, -hd + 0.02), "timber", "dresser/back", grain=(0, 1, 0))
    for y in (1.25, 1.6):
        b.box((-hw + 0.04, y - 0.025, -hd + 0.02), (hw - 0.04, y, d), "wood", f"dresser/shelf{y}", grain=(1, 0, 0))
        b.box((-hw + 0.04, y + 0.02, d - 0.02), (hw - 0.04, y + 0.04, d - 0.005), "timber", f"dresser/rail{y}", grain=(1, 0, 0))
    b.block((-hw - 0.04, top, -hd - 0.01), (hw + 0.04, top + 0.06, d + 0.03), "timber", 0.01, "dresser/cornice", grain=(1, 0, 0))
    # Crockery: plates on the racks, cups and a jug on the worktop.
    for row, y in enumerate((base + 0.05, 1.25, 1.6)):
        for k, x in enumerate((-0.4, -0.15, 0.1, 0.35)):
            if row == 0 and k > 1:
                continue
            plate(b, (x, y + 0.115, -hd + 0.06), 0.11, 0.2, "canvas" if (row + k) % 2 else "dye", f"dresser/plate{row}{k}")
    for k, x in enumerate((0.15, 0.3)):
        cup(b, (x, base + 0.05, 0.08), 0.04, 0.09, "canvas", f"dresser/cup{k}")
    placed(b, Matrix.Translation(Vector((0.47, base + 0.05, 0.02))), lambda: lathe(
        b, [(0, 0.06), (0.12, 0.08), (0.2, 0.05), (0.24, 0.035), (0.25, 0)], 8, "endgrain", "dresser/jug"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("cupboard", (-hw - 0.03, 0, -hd - 0.01), (hw + 0.03, base + 0.05, hd + 0.04)),
                                 proxy("racks", (-hw - 0.04, base + 0.05, -hd - 0.01), (hw + 0.04, top + 0.06, d + 0.03))]}


def build_settle(part, col, root):
    """A 1.5 m high-backed settle for a wall at -Z: a plank seat 0.45 m up, a boarded back to 1.25 m and shaped arms."""
    b = K["Builder"](f"settlement.{part}.mesh")
    L, seat, back, depth = 1.5, 0.45, 1.25, 0.5
    hd = depth / 2
    end = [(-hd, 0), (hd, 0), (hd, 0.68), (-hd + 0.14, 0.7), (-hd + 0.1, back), (-hd, back)]  # (z, y), a shaped arm
    for x in (-L / 2, L / 2 - 0.06):
        # Drawn in its (z, y) plane, turned so the drawn x runs along +Z and the drawn z becomes -x.
        placed(b, Matrix.Rotation(-math.pi / 2, 4, "Y"), lambda x=x: b.prism(end, -x - 0.06, -x, "wood", f"settle/end{x}", grain=(0, 1, 0)))
    for k, (z0, z1) in enumerate(((-hd + 0.03, 0.0), (0.005, hd - 0.02))):
        b.block((-L / 2 + 0.06, seat - 0.05, z0), (L / 2 - 0.06, seat, z1), "wood", 0.008, f"settle/seat{k}", grain=(1, 0, 0))
    b.box((-L / 2 + 0.06, 0.1, hd - 0.06), (L / 2 - 0.06, seat - 0.05, hd - 0.03), "timber", "settle/apron", grain=(1, 0, 0))
    boards = 6
    w = (L - 0.12) / boards
    for k in range(boards):
        x0 = -L / 2 + 0.06 + k * w
        b.box((x0, seat, -hd), (x0 + w - 0.008, back - 0.06, -hd + 0.03), "wood", f"settle/board{k}", grain=(0, 1, 0))
    b.block((-L / 2, back - 0.06, -hd - 0.01), (L / 2, back, -hd + 0.05), "timber", 0.01, "settle/top-rail", grain=(1, 0, 0))
    b.block((-0.25, seat, -0.05), (0.15, seat + 0.07, 0.15), "dye", 0.03, "settle/cushion")
    b.finish(col, root)
    return {"seat": {"height": seat, "length": L - 0.12, "depth": depth - 0.05},
            "collisionProxies": [proxy("seat", (-L / 2, 0, -hd), (L / 2, seat, hd)), proxy("back", (-L / 2, seat, -hd - 0.01), (L / 2, back, -hd + 0.1))]}


def build_rug(part, col, root):
    """A 2.0 x 1.3 m woven rug lying flat: a dyed field with a light border, a centre lozenge and fringed ends."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, t = 1.0, 0.65, 0.012
    b.box((-hw, 0, -hd), (hw, t, hd), "canvas", "rug/base", grain=(1, 0, 0))
    b.box((-hw + 0.1, t, -hd + 0.1), (hw - 0.1, t + 0.002, hd - 0.1), "dye", "rug/field", grain=(1, 0, 0))
    b.box((-hw + 0.18, t + 0.002, -hd + 0.18), (hw - 0.18, t + 0.003, -hd + 0.21), "canvas", "rug/stripe-back", grain=(1, 0, 0))
    b.box((-hw + 0.18, t + 0.002, hd - 0.21), (hw - 0.18, t + 0.003, hd - 0.18), "canvas", "rug/stripe-front", grain=(1, 0, 0))
    # The centre lozenge, drawn upright and laid flat on the field (drawn z becomes height).
    placed(b, Matrix.Rotation(-math.pi / 2, 4, "X"), lambda: b.prism(
        [(0.0, -0.32), (0.45, 0.0), (0.0, 0.32), (-0.45, 0.0)], t + 0.002, t + 0.004, "sacking", "rug/lozenge"))
    for x in (-hw, hw):
        s = 1 if x > 0 else -1
        for k in range(9):
            z = -hd + 0.08 + k * (2 * hd - 0.16) / 8
            b.box((x if s > 0 else x - 0.07, 0, z - 0.012), (x + 0.07 if s > 0 else x, 0.006, z + 0.012), "canvas", f"rug/fringe{x}{k}")
    b.finish(col, root)
    return {"collisionProxies": [proxy("rug", (-hw, 0, -hd), (hw, t, hd))]}


def build_cooking_pot(part, col, root):
    """An iron cooking pot hanging by a chain from a 1.2 m iron tripod over a ring of stones, logs and embers."""
    b = K["Builder"](f"settlement.{part}.mesh")
    apex, spread = 1.2, 0.62
    for k in range(3):
        a = math.tau * k / 3 + math.pi / 6
        rod(b, (spread * math.cos(a), 0.008, -spread * math.sin(a)), (0, apex, 0), 0.016, 6, "iron", f"pot/leg{k}")
    placed(b, Matrix.Translation((0, apex, 0)), lambda: lathe(b, [(-0.03, 0.035), (0.03, 0.03), (0.06, 0)], 6, "iron", "pot/head"))
    py = 0.42
    b.box((-0.008, py + 0.36, -0.008), (0.008, apex - 0.03, 0.008), "iron", "pot/chain")
    placed(b, Matrix.Translation((0, py, 0)), lambda: lathe(
        b, [(0, 0.1), (0.05, 0.18), (0.2, 0.2), (0.3, 0.17), (0.32, 0.18), (0.32, 0.16), (0.24, 0)], 12, "iron", "pot/body", cap_mat="soot"))
    b.box((-0.19, py + 0.32, -0.006), (0.19, py + 0.36, 0.006), "iron", "pot/bail")
    for k in range(9):
        a = math.tau * k / 9
        r = 0.48
        b.block((r * math.cos(a) - 0.09, 0, -r * math.sin(a) - 0.07), (r * math.cos(a) + 0.09, 0.12 + 0.03 * rnd("pot/stone", k), -r * math.sin(a) + 0.07),
                "stone", 0.025, f"pot/stone{k}")
    for k, a in enumerate((0.3, 2.4, 4.4)):
        rod(b, (0.3 * math.cos(a), 0.06, -0.3 * math.sin(a)), (0.05 * math.cos(a + 0.5), 0.15, -0.05 * math.sin(a + 0.5)), 0.045, 6, "timber", f"pot/log{k}", "endgrain")
    b.box((-0.2, 0.0, -0.2), (0.2, 0.04, 0.2), "horn", "pot/embers")
    b.finish(col, root)
    return {"collisionProxies": [proxy("hearth", (-0.6, 0, -0.6), (0.6, 0.18, 0.6)), proxy("pot", (-0.22, 0.3, -0.22), (0.22, apex, 0.22))]}


def build_jar_shelf(part, col, root):
    """A 1.2 m freestanding shelf unit for a wall at -Z: two uprights and four shelves of jars, crocks and bottles."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, top = 0.6, 0.15, 1.8
    for x in (-hw, hw - 0.05):
        b.box((x, 0, -hd), (x + 0.05, top, hd), "wood", f"shelf/upright{x}", grain=(0, 1, 0))
    b.box((-hw + 0.05, 0.3, -hd), (hw - 0.05, top, -hd + 0.015), "timber", "shelf/back", grain=(0, 1, 0))
    levels = (0.3, 0.75, 1.2, 1.65)
    for y in levels:
        b.box((-hw + 0.05, y - 0.03, -hd), (hw - 0.05, y, hd), "wood", f"shelf/board{y}", grain=(1, 0, 0))
    b.box((-hw - 0.02, top, -hd - 0.01), (hw + 0.02, top + 0.04, hd + 0.01), "timber", "shelf/top", grain=(1, 0, 0))
    goods = ("endgrain", "horn", "canvas", "sacking", "dye")
    for row, y in enumerate(levels):
        x = -hw + 0.12
        k = 0
        while x < hw - 0.12:
            key = f"shelf/jar{row}-{k}"
            r = 0.05 + 0.03 * rnd(key, "r")
            h = 0.12 + 0.16 * rnd(key, "h")
            if x + r > hw - 0.07:
                break
            mat = goods[int(rnd(key, "m") * len(goods))]
            placed(b, Matrix.Translation((x + r, y, 0.0)), lambda r=r, h=h, mat=mat, key=key: lathe(
                b, [(0, r * 0.85), (h * 0.8, r), (h, r * 0.6), (h + 0.015, 0)], 6, mat, key))
            x += 2 * r + 0.06
            k += 1
    b.finish(col, root)
    return {"collisionProxies": [proxy("shelf", (-hw - 0.02, 0, -hd - 0.01), (hw + 0.02, top + 0.04, hd + 0.01))]}


def build_spinning_wheel(part, col, root):
    """A spinning wheel on a slanted three-legged bench: a 0.55 m spoked wheel to +X, its axle along Z, a treadle, the
    flyer at -X and a distaff of wool."""
    b = K["Builder"](f"settlement.{part}.mesh")
    tilted(b, (0, 0.38, 0), 0, 0, lambda: b.beam((-0.45, 0.0), (0.45, 0.08), 0.07, -0.09, 0.09, "wood", "spin/bench"))
    for k, (x, z) in enumerate(((-0.38, 0.0), (0.38, 0.15), (0.38, -0.15))):
        rod(b, (x, 0.4, z * 0.6), (x * 1.08, 0.0032, z), 0.018, 6, "timber", f"spin/leg{k}")
    wx, wy, R = 0.22, 0.75, 0.28
    def wheel_parts():
        ring(b, R - 0.035, R, -0.015, 0.015, 16, "wood", "spin/rim")
        for s in range(8):
            a = math.tau * s / 8
            b.beam((0.03 * math.cos(a), 0.03 * math.sin(a)), ((R - 0.03) * math.cos(a), (R - 0.03) * math.sin(a)), 0.016, -0.008, 0.008, "timber", f"spin/spoke{s}")
        rod(b, (0, 0, -0.05), (0, 0, 0.05), 0.03, 8, "timber", "spin/hub")
    placed(b, Matrix.Translation((wx, wy, 0)), wheel_parts)
    for z in (-0.05, 0.05):
        b.box((wx - 0.02, 0.42, z - 0.015), (wx + 0.02, wy + 0.02, z + 0.015), "timber", f"spin/upright{z}", grain=(0, 1, 0))
    rod(b, (wx, wy, 0), (wx, wy, 0.12), 0.01, 6, "iron", "spin/crank")
    b.box((0.05, 0.03, 0.08), (0.4, 0.05, 0.22), "wood", "spin/treadle", grain=(1, 0, 0))
    b.box((wx - 0.006, 0.05, 0.11), (wx + 0.006, wy, 0.125), "timber", "spin/footman")
    # The flyer at the other end, on its maiden, with a bobbin of yarn.
    b.box((-0.36, 0.42, -0.02), (-0.33, 0.62, 0.02), "timber", "spin/maiden", grain=(0, 1, 0))
    rod(b, (-0.42, 0.63, 0), (-0.24, 0.63, 0), 0.035, 8, "canvas", "spin/bobbin")
    # Distaff with a puff of wool.
    rod(b, (-0.3, 0.42, 0.0), (-0.38, 1.05, 0.0), 0.012, 6, "timber", "spin/distaff")
    placed(b, Matrix.Translation((-0.37, 0.88, 0)), lambda: lathe(b, [(0, 0), (0.05, 0.06), (0.16, 0.055), (0.22, 0)], 7, "canvas", "spin/wool", jitter=0.12))
    b.finish(col, root)
    return {"collisionProxies": [proxy("spinning-wheel", (-0.48, 0, -0.18), (0.52, wy + R, 0.24))]}


def build_cradle(part, col, root):
    """A 0.9 m wooden cradle on two rockers, its hooded head at -X, with a blanket."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hl, hw, y0, h = 0.45, 0.24, 0.12, 0.32
    rocker = [(-0.52, 0.06)] + [(0.52 * math.sin(math.pi * (k / 8 - 0.5)), 0.06 - 0.06 * math.cos(math.pi * (k / 8 - 0.5))) for k in range(9)] + [(0.52, 0.06)]
    outline = rocker[1:-1][::1]
    for z in (-hw + 0.03, hw - 0.06):
        b.prism([(x, y) for x, y in outline] + [(0.4, y0), (-0.4, y0)], z, z + 0.03, "timber", f"cradle/rocker{z}")
    b.box((-hl, y0, -hw), (hl, y0 + 0.03, hw), "wood", "cradle/floor", grain=(1, 0, 0))
    for z0, z1 in ((-hw, -hw + 0.025), (hw - 0.025, hw)):
        b.box((-hl, y0, z0), (hl, y0 + h, z1), "wood", f"cradle/side{z0}", grain=(1, 0, 0))
    b.box((hl - 0.025, y0, -hw + 0.025), (hl, y0 + h - 0.04, hw - 0.025), "wood", "cradle/foot", grain=(0, 0, 1))
    b.box((-hl, y0, -hw + 0.025), (-hl + 0.025, y0 + h + 0.12, hw - 0.025), "wood", "cradle/head", grain=(0, 0, 1))
    tilted(b, (-hl + 0.12, y0 + h + 0.1, 0), 0, 0, lambda: placed(b, Matrix.Rotation(-0.35, 4, "Z"),
           lambda: b.box((-0.14, 0, -hw), (0.14, 0.025, hw), "wood", "cradle/hood", grain=(1, 0, 0))))
    b.block((-hl + 0.12, y0 + 0.03, -hw + 0.03), (hl - 0.04, y0 + h - 0.06, hw - 0.03), "canvas", 0.03, "cradle/bedding")
    b.block((-0.05, y0 + h - 0.08, -hw + 0.02), (hl - 0.03, y0 + h - 0.03, hw - 0.02), "dye", 0.02, "cradle/blanket")
    b.finish(col, root)
    return {"collisionProxies": [proxy("cradle", (-0.52, 0, -hw), (0.52, y0 + h + 0.15, hw))]}


def build_hall_table(part, col, root):
    """A 3.6 m long trestle table for a lodge hall, its top 0.78 m up on three trestles, laid with platters,
    bowls, tankards and a candle."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, top = 1.8, 0.45, 0.78
    for k, (z0, z1) in enumerate(((-hd, -0.15), (-0.145, 0.145), (0.15, hd))):
        b.block((-hw, top - 0.05, z0), (hw, top, z1), "wood", 0.01, f"hall/top{k}", grain=(1, 0, 0))
    for x in (-1.45, 0.0, 1.45):
        b.block((x - 0.05, 0, -hd + 0.05), (x + 0.05, 0.07, hd - 0.05), "timber", 0.01, f"hall/foot{x}", grain=(0, 0, 1))
        b.box((x - 0.035, 0.07, -0.05), (x + 0.035, top - 0.11, 0.05), "timber", f"hall/leg{x}", grain=(0, 1, 0))
        b.box((x - 0.04, top - 0.11, -hd + 0.06), (x + 0.04, top - 0.05, hd - 0.06), "timber", f"hall/bearer{x}", grain=(0, 0, 1))
    b.box((-1.42, 0.22, -0.03), (1.42, 0.29, 0.03), "timber", "hall/stretcher", grain=(1, 0, 0))
    for k, x in enumerate((-1.2, 0.4)):
        placed(b, Matrix.Translation((x, top, 0.0)), lambda k=k: lathe(b, [(0, 0.16), (0.02, 0.2), (0.025, 0.2), (0.012, 0)], 8, "wood", f"hall/platter{k}"))
    placed(b, Matrix.Translation((-1.2, top + 0.01, 0.0)), lambda: lathe(b, [(0, 0.1), (0.08, 0.09), (0.11, 0.05), (0.12, 0)], 8, "endgrain", "hall/loaf"))
    for k, (x, z) in enumerate(((-0.8, 0.25), (-0.3, -0.25), (0.9, 0.25), (1.4, -0.25))):
        cup(b, (x, top, z), 0.045, 0.12, "endgrain", f"hall/tankard{k}")
        placed(b, Matrix.Translation((x + 0.18, top, z)), lambda k=k: lathe(b, [(0, 0.04), (0.04, 0.08), (0.05, 0.085), (0.05, 0)], 6, "wood", f"hall/bowl{k}"))
    placed(b, Matrix.Translation((0.0, top, 0.0)), lambda: lathe(b, [(0, 0.06), (0.03, 0.06), (0.03, 0.02), (0.2, 0.02), (0.2, 0.012), (0.23, 0)], 8, "canvas", "hall/candle"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("table", (-hw, 0, -hd), (hw, top, hd))]}


# ---------------------------------------------------------------- landmarks (#665)

def build_shrine(part, col, root):
    """A roadside shrine: a coursed stone pillar on a stepped plinth carrying a small gabled timber niche with a
    figure and a candle, an offering bowl of flowers on the step. It faces +Z."""
    b = K["Builder"](f"settlement.{part}.mesh")
    b.block((-0.42, 0, -0.36), (0.42, 0.2, 0.36), "stone", 0.03, "shrine/step")
    b.block((-0.28, 0.2, -0.24), (0.28, 0.4, 0.24), "stone", 0.03, "shrine/plinth")
    for k, y in enumerate((0.4, 0.75, 1.1)):
        b.block((-0.17, y, -0.15), (0.17, y + 0.35, 0.15), "stone", 0.02, f"shrine/course{k}")
    n0, n1 = 1.45, 1.95
    b.box((-0.26, n0, -0.2), (0.26, n0 + 0.05, 0.22), "timber", "shrine/sill", grain=(1, 0, 0))
    for x in (-0.24, 0.2):
        b.box((x, n0 + 0.05, -0.18), (x + 0.04, n1, -0.14), "timber", f"shrine/post-back{x}", grain=(0, 1, 0))
        b.box((x, n0 + 0.05, 0.16), (x + 0.04, n1, 0.2), "timber", f"shrine/post-front{x}", grain=(0, 1, 0))
    b.box((-0.2, n0 + 0.05, -0.17), (0.2, n1, -0.15), "wood", "shrine/back", grain=(0, 1, 0))
    for x in (-0.24, 0.2):
        b.box((x + 0.005, n0 + 0.05, -0.14), (x + 0.035, n1, 0.16), "wood", f"shrine/side{x}", grain=(0, 0, 1))
    for s in (-1, 1):
        b.beam((s * 0.34, n1 - 0.06), (0, n1 + 0.26), 0.035, -0.28, 0.3, "shingle", f"shrine/roof{s}")
    b.box((-0.025, n1 + 0.24, -0.3), (0.025, n1 + 0.3, 0.32), "timber", "shrine/ridge", grain=(0, 0, 1))
    placed(b, Matrix.Translation((0, n0 + 0.05, -0.05)), lambda: lathe(
        b, [(0, 0.06), (0.18, 0.045), (0.24, 0.04), (0.26, 0.05), (0.33, 0.035), (0.36, 0)], 7, "canvas", "shrine/figure"))
    placed(b, Matrix.Translation((0.12, n0 + 0.05, 0.08)), lambda: lathe(b, [(0, 0.02), (0.08, 0.02), (0.11, 0)], 6, "horn", "shrine/candle"))
    placed(b, Matrix.Translation((0, 0.2, 0.28)), lambda: lathe(b, [(0, 0.05), (0.04, 0.1), (0.06, 0.11), (0.06, 0.09), (0.03, 0)], 8, "stone", "shrine/bowl"))
    for k in range(5):
        a = k * 1.3
        flower(b, (0.06 * math.cos(a), 0.27, 0.28 - 0.06 * math.sin(a)), ("dye", "canvas", "horn")[k % 3], f"shrine/flower{k}")
    b.finish(col, root)
    return {"collisionProxies": [proxy("plinth", (-0.42, 0, -0.36), (0.42, 0.4, 0.36)), proxy("pillar", (-0.34, 0.4, -0.3), (0.34, n1 + 0.3, 0.32))]}


def build_standing_stone(part, col, root):
    """A 2.4 m weathered standing stone, its broad face toward +Z carved with a spiral and a column of runes, a few
    fallen stones at its foot."""
    b = K["Builder"](f"settlement.{part}.mesh")
    rings = [(0.0, 0.52), (0.6, 0.5), (1.3, 0.44), (1.9, 0.34), (2.25, 0.2), (2.4, 0.06)]
    placed(b, Matrix.Diagonal((1.0, 1.0, 0.5, 1.0)),
           lambda: lathe(b, rings, 7, "monolith", "standing/body", jitter=0.12, phase=0.2))
    # Carvings: shallow dark grooves proud of the front face (z about 0.22-0.26).
    def groove(a, c, key):
        b.beam(a, c, 0.035, 0.0, 0.045, "soot", key)
    spiral = [(0.16 * (1 - k / 14) * math.cos(k * 0.9), 1.45 + 0.16 * (1 - k / 14) * math.sin(k * 0.9)) for k in range(15)]
    def carve():
        for k, (p, q) in enumerate(zip(spiral, spiral[1:])):
            groove(p, q, f"standing/spiral{k}")
        for k, y in enumerate((0.55, 0.78, 1.0)):
            groove((-0.1, y), (0.1, y + 0.12), f"standing/rune{k}a")
            groove((0.0, y - 0.04), (0.0, y + 0.16), f"standing/rune{k}b")
    placed(b, Matrix.Translation((0.0, 0.0, 0.225)), carve)
    for k, (x, z, s) in enumerate(((0.65, 0.35, 0.22), (-0.6, 0.45, 0.16), (0.3, -0.5, 0.18))):
        b.block((x - s, 0, z - s * 0.8), (x + s, s * 0.9, z + s * 0.8), "monolith", 0.05, f"standing/rubble{k}")
    b.finish(col, root)
    return {"collisionProxies": [proxy("stone", (-0.52, 0, -0.27), (0.52, 2.4, 0.27))]}


def build_watchtower_ruin(part, col, root):
    """The stump of a round stone watchtower, 4.6 m across: a 0.55 m thick wall broken off between 1.2 and 3.6 m, a
    doorway gap toward +Z and rubble spilled around it. Its inside is open ground."""
    b = K["Builder"](f"settlement.{part}.mesh")
    R, t, n = 2.3, 0.55, 16
    proxies = []
    for k in range(n):
        if k == 12:  # the doorway, toward +Z
            continue
        a0, a1 = math.tau * k / n, math.tau * (k + 1) / n
        h = 1.2 + 2.4 * rnd("tower/height", k) ** 1.5
        h1 = 1.2 + 2.4 * rnd("tower/height", (k + 1) % n) ** 1.5
        pts = [(R * math.cos(a0), -R * math.sin(a0)), (R * math.cos(a1), -R * math.sin(a1)),
               ((R - t) * math.cos(a1), -(R - t) * math.sin(a1)), ((R - t) * math.cos(a0), -(R - t) * math.sin(a0))]
        top = min(h, h1) + 0.6 * abs(h - h1) * 0.5
        verts = [(x, 0.0, z) for x, z in pts] + [(pts[0][0], h, pts[0][1]), (pts[1][0], top, pts[1][1]), (pts[2][0], top, pts[2][1]), (pts[3][0], h, pts[3][1])]
        polys = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7], [3, 2, 1, 0]]
        bmesh.ops.recalc_face_normals(b.bm, faces=b.faces(verts, polys, "stone", f"tower/wall{k}", grain=(1, 0, 0)))
        xs, zs = [p[0] for p in pts], [p[1] for p in pts]
        proxies.append(proxy(f"wall{k}", (min(xs), 0, min(zs)), (max(xs), max(h, top), max(zs))))
    for k in range(9):
        a = math.tau * rnd("tower/rubble", k, "a")
        r = R + 0.3 + 0.7 * rnd("tower/rubble", k, "r")
        s = 0.18 + 0.15 * rnd("tower/rubble", k, "s")
        x, z = r * math.cos(a), -r * math.sin(a)
        b.block((x - s, 0, z - s * 0.7), (x + s, s, z + s * 0.7), "stone", 0.04, f"tower/rubble{k}")
    b.finish(col, root)
    return {"collisionProxies": proxies}


RAILING_MODULE = 3.0


def build_bridge_railing(part, col, root):
    """A 3 m weathered timber railing segment along X for a bridge deck edge: half a post at each end, a sagging top
    rail, a mid rail broken in the middle and a leaning centre post."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, top = RAILING_MODULE / 2, 1.05
    for x0, x1 in ((-hw, -hw + 0.07), (hw - 0.07, hw)):
        b.box((x0, 0, -0.07), (x1, top, 0.07), "timber", f"railing/post{x0}", grain=(0, 1, 0))
    tilted(b, (0.0, 0, 0), 0.06, 0, lambda: b.box((-0.06, 0.004, -0.06), (0.06, top - 0.04, 0.06), "timber", "railing/mid-post", grain=(0, 1, 0)))
    b.beam((-hw + 0.07, top - 0.02), (0.0, top - 0.07), 0.09, -0.04, 0.04, "wood", "railing/top-left")
    b.beam((0.0, top - 0.07), (hw - 0.07, top - 0.03), 0.09, -0.04, 0.04, "wood", "railing/top-right")
    b.beam((-hw + 0.07, 0.52), (-0.25, 0.5), 0.08, -0.03, 0.03, "wood", "railing/mid-left")
    b.beam((-0.25, 0.5), (-0.05, 0.36), 0.08, -0.03, 0.03, "wood", "railing/mid-broken")
    b.beam((0.06, 0.5), (hw - 0.07, 0.53), 0.08, -0.03, 0.03, "wood", "railing/mid-right")
    for x in (-hw + 0.035, 0.0, hw - 0.035):
        b.box((x - 0.05, top - 0.12, 0.04), (x + 0.05, top - 0.09, 0.05), "iron", f"railing/strap{x}")
    b.finish(col, root)
    return {"module": {"width": RAILING_MODULE, "height": top},
            "collisionProxies": [proxy("railing", (-hw, 0, -0.08), (hw, top, 0.08))]}


def build_stall_awning(part, col, root):
    """A market stall variant under a gable awning: a 2.4 x 1.2 m trestle counter of produce baskets and loaves, four
    poles and a red canvas gable with a light valance, its ridge along X."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, counter = 1.2, 0.6, 0.85
    b.block((-hw, counter - 0.05, -hd), (hw, counter, hd), "wood", 0.01, "awning/counter", grain=(1, 0, 0))
    for x in (-0.95, 0.95):
        b.block((x - 0.05, 0, -hd + 0.05), (x + 0.05, 0.06, hd - 0.05), "timber", 0.01, f"awning/foot{x}", grain=(0, 0, 1))
        b.box((x - 0.035, 0.06, -0.04), (x + 0.035, counter - 0.05, 0.04), "timber", f"awning/leg{x}", grain=(0, 1, 0))
    b.box((-hw + 0.2, counter - 0.11, hd - 0.04), (hw - 0.2, counter - 0.05, hd), "timber", "awning/apron", grain=(1, 0, 0))
    eave, ridge = 2.05, 2.6
    for x in (-hw - 0.05, hw + 0.05):
        for z in (-hd - 0.1, hd + 0.1):
            b.box((x - 0.04, 0, z - 0.04), (x + 0.04, eave, z + 0.04), "timber", f"awning/pole{x}{z}", grain=(0, 1, 0))
        rod(b, (x, eave - 0.02, -hd - 0.1), (x, ridge, 0), 0.025, 6, "timber", f"awning/rafter-back{x}")
        rod(b, (x, eave - 0.02, hd + 0.1), (x, ridge, 0), 0.025, 6, "timber", f"awning/rafter-front{x}")
    def gable():
        for s in (-1, 1):
            b.beam((s * (hd + 0.3), eave - 0.12), (0, ridge + 0.03), 0.02, -hw - 0.25, hw + 0.25, "dye", f"awning/canvas{s}")
            for k in range(6):
                z0 = -hw - 0.25 + k * (2 * hw + 0.5) / 6
                z1 = z0 + (2 * hw + 0.5) / 6
                zc = (z0 + z1) / 2
                ex, ey = s * (hd + 0.3), eave - 0.12
                b.prism([(ex - 0.006, ey), (ex + 0.006, ey), (ex + 0.006, ey - 0.16), (ex - 0.006, ey - 0.16)], z0, z1, "canvas", f"awning/valance{s}{k}")
                b.prism([(ex - 0.006, ey - 0.16), (ex + 0.006, ey - 0.16), (ex, ey - 0.24)], zc - 0.06, zc + 0.06, "canvas", f"awning/point{s}{k}")
    placed(b, Matrix.Rotation(math.pi / 2, 4, "Y"), gable)
    # Goods: baskets of produce and loaves on the counter, a crate below.
    for k, x in enumerate((-0.8, -0.3, 0.25)):
        # A basket heaped with greens (its top cap), three apples or onions on top.
        placed(b, Matrix.Translation((x, counter, 0.15)), lambda k=k: lathe(b, [(0, 0.14), (0.14, 0.2), (0.12, 0.19)], 8, "endgrain", f"awning/basket{k}", cap_mat="leaf"))
        for j in range(3):
            flower(b, (x + 0.08 * math.cos(j * 2.1), counter + 0.11, 0.15 - 0.08 * math.sin(j * 2.1)), ("dye", "horn", "dye")[(k + j) % 3], f"awning/produce{k}{j}")
    for k, x in enumerate((0.7, 0.85, 1.0)):
        b.block((x - 0.06, counter, -0.05), (x + 0.06, counter + 0.08, 0.15), "endgrain", 0.03, f"awning/loaf{k}")
    build_crate(b, (0.5, 0, -0.2), 0.45, "awning/crate")
    b.finish(col, root)
    return {"collisionProxies": [proxy("counter", (-hw - 0.09, 0, -hd - 0.14), (hw + 0.09, counter, hd + 0.14)),
                                 proxy("awning", (-hw - 0.3, eave - 0.36, -hd - 0.32), (hw + 0.3, ridge + 0.05, hd + 0.32))]}


BUILDERS = {"stall": build_stall, "cart": build_cart, "crate": build_crate_part, "barrel": build_barrel_part,
            "signpost": build_signpost, "lantern-post": build_lantern_post, "bench": build_bench,
            "fence": build_fence, "planter": build_planter, "firewood": build_firewood,
            "footbridge": build_footbridge, "bed": build_bed, "table": build_table, "chair": build_chair,
            "chest": build_chest, "hearth": build_hearth,
            "barrel-group": build_barrel_group, "crate-stack": build_crate_stack, "grain-sacks": build_grain_sacks,
            "wheelbarrow": build_wheelbarrow, "well": build_well, "fingerpost": build_fingerpost, "hay-bale": build_hay_bale,
            "haystack": build_haystack, "chopping-block": build_chopping_block, "washing-line": build_washing_line,
            "flower-tub": build_flower_tub, "vegetable-bed": build_vegetable_bed, "kennel": build_kennel,
            "dresser": build_dresser, "settle": build_settle, "rug": build_rug, "cooking-pot": build_cooking_pot,
            "jar-shelf": build_jar_shelf, "spinning-wheel": build_spinning_wheel, "cradle": build_cradle, "hall-table": build_hall_table,
            "shrine": build_shrine, "standing-stone": build_standing_stone, "watchtower-ruin": build_watchtower_ruin,
            "bridge-railing": build_bridge_railing, "stall-awning": build_stall_awning}


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
