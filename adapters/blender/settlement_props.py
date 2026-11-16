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
- farmstead dressing for the Greyhaven farms and hamlets (#695): ``scarecrow`` and ``weather-vane``, whose
  sleeves, hat and vane are their own nodes animated by the named loop clips ``Sway_Loop`` and ``Turn_Loop``
  (node animation, no skin), ``beehive-skeps``, ``water-trough``, ``feed-trough``, ``hen-coop`` and ``plough``.
- village machinery (#699): ``watermill``, ``water-wheel``, ``windmill``, ``forge`` and ``well-windlass``, whose
  wheels, sails, bellows and windlass drum are their own nodes turned by the loop clips ``Turn_Loop``, ``Pump_Loop``
  and ``Crank_Loop``; the forge's coal bed glows (emissive ``ember``).

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
from bpy_extras import anim_utils
from mathutils import Matrix, Vector

PROPS = ("stall", "cart", "crate", "barrel", "signpost", "lantern-post", "bench", "fence", "planter", "firewood", "footbridge",
         "bed", "table", "chair", "chest", "hearth",
         "barrel-group", "crate-stack", "grain-sacks", "wheelbarrow", "well", "fingerpost", "hay-bale", "haystack",
         "chopping-block", "washing-line", "flower-tub", "vegetable-bed", "kennel",
         "dresser", "settle", "rug", "cooking-pot", "jar-shelf", "spinning-wheel", "cradle", "hall-table",
         "shrine", "standing-stone", "watchtower-ruin", "bridge-railing", "stall-awning",
         "bread-basket", "cheese-board", "fish-crate", "apple-crate", "hanging-meats", "cask-rack", "merchant-scale",
         "cloth-bolts", "pottery", "anvil", "grindstone", "cooper-barrel",
         "table-set", "candles", "candelabra", "inn-sign", "stool", "bar-counter", "log-stack", "wall-shield", "wall-trophy",
         "rowing-boat", "jetty", "fishing-nets",
         "banner-outpost", "banner-village", "pennant-outpost", "pennant-village", "bunting",
         "scarecrow", "weather-vane", "beehive-skeps", "water-trough", "feed-trough", "hen-coop", "plough",
         "watermill", "water-wheel", "windmill", "forge", "well-windlass")
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
          "stall-awning": "market",
          **{prop: "market" for prop in ("bread-basket", "cheese-board", "fish-crate", "apple-crate", "hanging-meats",
                                         "cask-rack", "merchant-scale", "cloth-bolts", "pottery")},
          "anvil": "dressing", "grindstone": "dressing", "cooper-barrel": "dressing",
          **{prop: "dressing" for prop in ("table-set", "candles", "candelabra", "stool", "bar-counter", "log-stack",
                                           "wall-shield", "wall-trophy")},
          "inn-sign": "street", "rowing-boat": "dressing", "jetty": "street", "fishing-nets": "dressing",
          **{prop: "street" for prop in ("banner-outpost", "banner-village", "pennant-outpost", "pennant-village", "bunting")},
          **{prop: "dressing" for prop in ("scarecrow", "weather-vane", "beehive-skeps", "water-trough", "feed-trough", "hen-coop", "plough")},
          **{prop: "dressing" for prop in ("watermill", "water-wheel", "windmill", "forge", "well-windlass")}}

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
    "clay": ((0.66, 0.38, 0.24), 0.0, 0.85, None),
    "indigo": ((0.16, 0.24, 0.42), 0.0, 0.9, None),
    "ochre": ((0.74, 0.54, 0.2), 0.0, 0.9, None),
    "ember": ((0.9, 0.3, 0.08), 0.0, 0.9, None),
    "leather": ((0.36, 0.22, 0.13), 0.0, 0.8, None),
}
# Materials that also glow: their emissive colour (sRGB), set on the material after the kit makes it.
EMISSIVE = {"ember": (1.0, 0.36, 0.08)}

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


# ---------------------------------------------------------------- market goods, food and workshops (#669)

def lying(b, center, yaw, length, fn, squash=(1.0, 1.0)):
    """Run ``fn`` (a lathe about +Y from 0 to ``length``) and lay it along X, centred on ``center`` and turned by
    ``yaw`` about Y; ``squash`` scales its height and depth."""
    m = (Matrix.Translation(Vector(center)) @ Matrix.Rotation(yaw, 4, "Y") @ Matrix.Diagonal((1.0, squash[0], squash[1], 1.0))
         @ Matrix.Translation((-length / 2, 0, 0)) @ Matrix.Rotation(-math.pi / 2, 4, "Z"))
    placed(b, m, fn)


def loaf(b, center, length, radius, yaw, key):
    """A long loaf lying along X turned by ``yaw``; ``center`` is its middle, ``0.75 * radius`` above its base."""
    rings = [(0, 0), (length * 0.12, radius * 0.75), (length * 0.5, radius), (length * 0.88, radius * 0.75), (length, 0)]
    lying(b, center, yaw, length, lambda: lathe(b, rings, 7, "endgrain", key), squash=(0.75, 1.0))


def bun(b, center, radius, key):
    """A round loaf or bun, ``center`` on its base."""
    placed(b, Matrix.Translation(Vector(center)), lambda: lathe(
        b, [(0, radius * 0.85), (radius * 0.35, radius), (radius * 0.75, radius * 0.7), (radius, 0)], 7, "endgrain", key, phase=rnd(key, "p")))


def fruit(b, center, radius, mat, key):
    """An apple-sized ball, ``center`` on its base."""
    placed(b, Matrix.Translation(Vector(center)), lambda: lathe(
        b, [(0, 0), (radius * 0.3, radius * 0.85), (radius, radius), (radius * 1.7, radius * 0.75), (radius * 1.9, 0)], 5, mat, key, phase=rnd(key, "p")))


def open_box(b, lo, hi, t, mat, key, slats=1):
    """An open-topped plank box from ``lo`` to ``hi`` with walls ``t`` thick; ``slats`` > 1 gaps the long walls."""
    (x0, y0, z0), (x1, y1, z1) = lo, hi
    b.box((x0, y0, z0), (x1, y0 + t, z1), mat, f"{key}/floor", grain=(1, 0, 0))
    gap = (y1 - y0 - t) / slats
    for k in range(slats):
        ya, yb = y0 + t + k * gap, y0 + t + (k + 1) * gap - (0.025 if slats > 1 and k < slats - 1 else 0)
        for z in ((z0, z0 + t), (z1 - t, z1)):
            b.box((x0, ya, z[0]), (x1, yb, z[1]), mat, f"{key}/long{k}{z[0]}", grain=(1, 0, 0))
    for x in ((x0, x0 + t), (x1 - t, x1)):
        b.box((x[0], y0 + t, z0 + t), (x[1], y1, z1 - t), "timber", f"{key}/end{x[0]}", grain=(0, 0, 1))


def build_bread_basket(part, col, root):
    """A wide, shallow wicker bread basket, 0.56 m across, heaped with round loaves and two long ones."""
    b = K["Builder"](f"settlement.{part}.mesh")
    lathe(b, [(0, 0.2), (0.05, 0.24), (0.16, 0.28), (0.18, 0.28), (0.18, 0.255), (0.05, 0.19)], 12, "straw", "bread/basket")
    for k, (x, z) in enumerate(((-0.1, -0.08), (0.09, -0.1), (0.0, 0.1), (-0.14, 0.1), (0.15, 0.08))):
        bun(b, (x, 0.05, z), 0.085 + 0.015 * rnd("bread/bun", k), f"bread/bun{k}")
    loaf(b, (0.0, 0.17, -0.02), 0.34, 0.06, 0.4, "bread/long0")
    loaf(b, (0.02, 0.2, 0.05), 0.3, 0.055, -0.5, "bread/long1")
    b.finish(col, root)
    return {"collisionProxies": [proxy("basket", (-0.28, 0, -0.28), (0.28, 0.24, 0.28))]}


def cheese(b, center, radius, height, key, segments=10):
    placed(b, Matrix.Translation(Vector(center)), lambda: lathe(
        b, [(0, radius * 0.94), (height * 0.12, radius), (height * 0.88, radius), (height, radius * 0.94), (height, 0)], segments, "horn", key))


def build_cheese_board(part, col, root):
    """A 0.8 x 0.45 m plank cheese board for a counter or table: two stacked wheels, a smaller wheel with a wedge
    cut out lying beside it, and a knife."""
    b = K["Builder"](f"settlement.{part}.mesh")
    t = 0.04
    b.block((-0.4, 0, -0.225), (0.4, t, 0.225), "wood", 0.01, "cheese/board", grain=(1, 0, 0))
    cheese(b, (-0.18, t, -0.02), 0.16, 0.1, "cheese/wheel0")
    cheese(b, (-0.17, t + 0.1, -0.03), 0.14, 0.09, "cheese/wheel1")
    # The cut wheel: three-quarters of a drum, the wedge lying on its side in front.
    r, h = 0.12, 0.08
    verts, polys = [], []
    arc = [math.radians(a) for a in range(0, 271, 45)]
    for y in (t, t + h):
        verts.append((0.17, y, 0.02))
        verts += [(0.17 + r * math.cos(a), y, 0.02 - r * math.sin(a)) for a in arc]
    n = len(arc) + 1
    polys.append(list(range(n - 1, -1, -1)))
    polys.append(list(range(n, 2 * n)))
    polys += [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    bmesh.ops.recalc_face_normals(b.bm, faces=b.faces(verts, polys, "horn", "cheese/cut"))
    placed(b, Matrix.Translation((0.2, t, 0.17)) @ Matrix.Rotation(0.4, 4, "Y"), lambda: b.prism(
        [(0, 0), (0.11, 0.0), (0.08, 0.075)], -0.04, 0.04, "horn", "cheese/wedge-placed"))
    b.box((-0.05, t, 0.15), (0.13, t + 0.005, 0.175), "iron", "cheese/blade", grain=(1, 0, 0))
    b.box((-0.15, t, 0.152), (-0.05, t + 0.02, 0.173), "timber", "cheese/handle", grain=(1, 0, 0))
    b.finish(col, root)
    return {"collisionProxies": [proxy("board", (-0.4, 0, -0.225), (0.4, t + 0.19, 0.225))]}


def fish(b, center, length, yaw, key):
    """A whole fish lying on its side along X turned by ``yaw``, tail toward −X; ``center`` is its middle."""
    r = length * 0.14
    rings = [(0, 0), (length * 0.03, r * 0.5), (length * 0.12, r * 0.25), (length * 0.18, r * 0.35), (length * 0.45, r),
             (length * 0.8, r * 0.75), (length * 0.97, r * 0.3), (length, 0)]
    lying(b, center, yaw, length, lambda: lathe(b, rings, 6, "monolith", key), squash=(0.45, 1.0))


def build_fish_crate(part, col, root):
    """A shallow 0.7 x 0.45 m plank fish crate on straw, heaped with a dozen silvery fish."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, h = 0.35, 0.225, 0.24
    open_box(b, (-hw, 0, -hd), (hw, h, hd), 0.025, "wood", "fishcrate/box")
    b.box((-hw + 0.025, 0.025, -hd + 0.025), (hw - 0.025, h - 0.07, hd - 0.025), "straw", "fishcrate/straw")
    for k in range(12):
        layer = k // 6
        x = -0.2 + 0.08 * (k % 6) + 0.03 * rnd("fishcrate/x", k)
        z = -0.1 + 0.2 * rnd("fishcrate/z", k)
        yaw = (1.2 if k % 2 else -1.2) + 0.6 * (rnd("fishcrate/yaw", k) - 0.5) if layer == 0 else 0.3 * (rnd("fishcrate/yaw", k) - 0.5)
        fish(b, (x * (1 if layer == 0 else 0.6), h - 0.06 + 0.035 * layer, z * (1 if layer == 0 else 0.4)), 0.3 + 0.06 * rnd("fishcrate/l", k), yaw, f"fishcrate/fish{k}")
    b.finish(col, root)
    return {"collisionProxies": [proxy("crate", (-hw, 0, -hd), (hw, h, hd))]}


def build_apple_crate(part, col, root):
    """A slatted 0.6 x 0.4 m apple crate heaped with red, yellow and green apples, a few rolled out in front."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, h = 0.3, 0.2, 0.34
    open_box(b, (-hw, 0, -hd), (hw, h, hd), 0.022, "wood", "applecrate/box", slats=3)
    b.box((-hw + 0.022, 0.022, -hd + 0.022), (hw - 0.022, h - 0.06, hd - 0.022), "soil", "applecrate/fill")
    colours = ("dye", "dye", "horn", "leaf")
    k = 0
    for row in range(3):
        for col_ in range(5):
            x, z = -0.22 + 0.11 * col_ + 0.02 * rnd("apple/x", k), -0.12 + 0.12 * row + 0.02 * rnd("apple/z", k)
            y = h - 0.045 + 0.05 * (1 - abs(col_ - 2) / 2) * (1 - abs(row - 1) * 0.6)
            fruit(b, (x, y, z), 0.037, colours[k % 4], f"apple/{k}")
            k += 1
    for j, (x, z) in enumerate(((0.12, hd + 0.12), (-0.2, hd + 0.08))):
        fruit(b, (x, 0, z), 0.037, colours[j], f"apple/loose{j}")
    b.finish(col, root)
    return {"collisionProxies": [proxy("crate", (-hw, 0, -hd), (hw, h + 0.03, hd))]}


def build_hanging_meats(part, col, root):
    """A 1.5 m timber hanging frame for a butcher's or smokehouse front: two hams and three strings of sausages
    hang on cords from the crossbar at 1.9 m."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, top = 0.75, 1.9
    for s in (-1, 1):
        x = s * hw
        b.block((x - 0.08, 0, -0.25), (x + 0.08, 0.08, 0.25), "timber", 0.015, f"meats/foot{s}", grain=(0, 0, 1))
        b.box((x - 0.045, 0.08, -0.045), (x + 0.045, top + 0.08, 0.045), "timber", f"meats/post{s}", grain=(0, 1, 0))
        b.beam((x, 0.08), (x - s * 0.25, 0.45), 0.05, -0.03, 0.03, "timber", f"meats/brace{s}")
    b.block((-hw - 0.1, top, -0.05), (hw + 0.1, top + 0.08, 0.05), "timber", 0.012, "meats/bar", grain=(1, 0, 0))
    # Hams hang shank up; sausages hang in strings of linked casings.
    for k, x in enumerate((-0.45, 0.35)):
        cord = top - 0.22
        b.box((x - 0.006, cord, -0.006), (x + 0.006, top, 0.006), "sacking", f"meats/cord-ham{k}")
        rings = [(0, 0.015), (0.07, 0.035), (0.2, 0.09), (0.33, 0.12), (0.42, 0.1), (0.46, 0)]
        placed(b, Matrix.Translation((x, cord, 0)) @ Matrix.Rotation(math.pi, 4, "X"), lambda k=k, rings=rings: lathe(
            b, rings, 8, "dye", f"meats/ham{k}", jitter=0.05))
    for k, x in enumerate((-0.15, 0.0, 0.6)):
        y = top
        b.box((x - 0.005, top - 0.08, -0.005), (x + 0.005, top, 0.005), "sacking", f"meats/cord-sausage{k}")
        y = top - 0.08
        for j in range(4 - k % 2):
            length = 0.16
            rings = [(0, 0), (0.02, 0.022), (length - 0.02, 0.022), (length, 0)]
            placed(b, Matrix.Translation((x + 0.015 * (j % 2), y, 0)) @ Matrix.Rotation(math.pi, 4, "X"), lambda k=k, j=j, rings=rings: lathe(
                b, rings, 6, "clay", f"meats/sausage{k}{j}"))
            y -= length + 0.005
    b.finish(col, root)
    return {"collisionProxies": [proxy("frame", (-hw - 0.1, 0, -0.25), (hw + 0.1, top + 0.08, 0.25))]}


def cask(b, center, scale, key):
    """A cask on its side, head toward +Z; ``center`` is its middle."""
    placed(b, Matrix.Translation(Vector(center)) @ Matrix.Rotation(math.pi / 2, 4, "X") @ Matrix.Diagonal((scale, scale, scale, 1.0))
           @ Matrix.Translation((0, -0.45, 0)), lambda: build_barrel(b, (0, 0, 0), key, 10, hoops=(0.08, 0.3, 0.6, 0.82)))


def build_cask_rack(part, col, root):
    """A 1.4 m timber gantry of wine and ale casks lying head-out toward +Z: two on the rails, one in the groove
    between them, the lower two with wooden taps."""
    b = K["Builder"](f"settlement.{part}.mesh")
    s = 0.8
    R, L = 0.3 * s, 0.9 * s
    rail = 0.24
    for z in (-0.22, 0.22):
        b.block((-0.7, rail - 0.08, z - 0.05), (0.7, rail, z + 0.05), "timber", 0.012, f"rack/rail{z}", grain=(1, 0, 0))
    for k, x in enumerate((-0.6, 0.0, 0.6)):
        b.block((x - 0.06, 0, -0.32), (x + 0.06, rail - 0.08, 0.32), "timber", 0.012, f"rack/sleeper{k}", grain=(0, 0, 1))
    cy = rail + R * 0.86
    for k, x in enumerate((-0.3, 0.3)):
        cask(b, (x, cy, 0), s, f"rack/cask{k}")
        b.box((x - 0.015, cy - R * 0.6, L / 2), (x + 0.015, cy - R * 0.5, L / 2 + 0.08), "timber", f"rack/tap{k}", grain=(0, 0, 1))
        b.box((x - 0.015, cy - R * 0.6 - 0.04, L / 2 + 0.05), (x + 0.015, cy - R * 0.6, L / 2 + 0.08), "timber", f"rack/spout{k}", grain=(0, 1, 0))
    cask(b, (0, cy + math.sqrt((2 * R * 0.95) ** 2 - 0.3 ** 2), 0), s, "rack/cask-top")
    b.finish(col, root)
    top = cy + math.sqrt((2 * R * 0.95) ** 2 - 0.3 ** 2) + R
    return {"collisionProxies": [proxy("rack", (-0.7, 0, -0.36), (0.7, top, 0.36))]}


def build_merchant_scale(part, col, root):
    """A merchant's balance, 1.25 m tall: a turned post on a stepped base, an iron beam with two pans on chains
    and a row of weights on the base."""
    b = K["Builder"](f"settlement.{part}.mesh")
    b.block((-0.25, 0, -0.2), (0.25, 0.06, 0.2), "timber", 0.012, "scale/base")
    b.block((-0.12, 0.06, -0.1), (0.12, 0.12, 0.1), "timber", 0.01, "scale/step")
    lathe(b, [(0.12, 0.035), (0.2, 0.03), (1.08, 0.025), (1.1, 0.035), (1.14, 0.0)], 6, "wood", "scale/post")
    beam_y, arm = 1.12, 0.36
    b.box((-arm, beam_y - 0.012, -0.012), (arm, beam_y + 0.012, 0.012), "iron", "scale/beam", grain=(1, 0, 0))
    b.prism([(-0.02, beam_y + 0.01), (0.02, beam_y + 0.01), (0, beam_y + 0.12)], -0.008, 0.008, "iron", "scale/needle")
    pan_y = 0.62
    for s in (-1, 1):
        x = s * (arm - 0.02)
        for k in range(3):
            a = math.tau * k / 3
            rod(b, (x, beam_y - 0.01, 0), (x + 0.09 * math.cos(a), pan_y + 0.03, 0.09 * math.sin(a)), 0.004, 3, "iron", f"scale/chain{s}{k}")
        placed(b, Matrix.Translation((x, pan_y, 0)), lambda s=s: lathe(b, [(0, 0.05), (0.03, 0.11), (0.035, 0.1), (0.01, 0)], 10, "horn", f"scale/pan{s}"))
    for k, (x, r, h) in enumerate(((-0.17, 0.03, 0.05), (-0.1, 0.025, 0.04), (0.12, 0.02, 0.03), (0.17, 0.016, 0.025))):
        placed(b, Matrix.Translation((x, 0.06, 0.13)), lambda k=k, r=r, h=h: lathe(b, [(0, r), (h, r), (h, r * 0.5), (h + 0.01, 0)], 6, "iron", f"scale/weight{k}"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("scale", (-0.25, 0, -0.2), (0.25, beam_y + 0.12, 0.2))]}


def build_cloth_bolts(part, col, root):
    """A draper's 1.2 m trestle table stacked with folded bolts of cloth in four colours, two more bolts leaning
    against it."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, top = 0.6, 0.3, 0.72
    b.block((-hw, top - 0.04, -hd), (hw, top, hd), "wood", 0.01, "cloth/top", grain=(1, 0, 0))
    for x in (-0.45, 0.45):
        for s in (-1, 1):
            b.beam((x + s * 0.12, 0.0043), (x, top - 0.04), 0.05, -0.2, -0.15, "timber", f"cloth/leg{x}{s}back")
            b.beam((x + s * 0.12, 0.0043), (x, top - 0.04), 0.05, 0.15, 0.2, "timber", f"cloth/leg{x}{s}front")
    colours = ("dye", "canvas", "leaf", "sacking", "canvas", "dye", "leaf")
    stacks = ((-0.36, 3), (-0.08, 2), (0.2, 3), (0.44, 1))
    k = 0
    for x, n in stacks:
        for j in range(n):
            w, d, h = 0.24, 0.5, 0.075
            dx = 0.012 * (rnd("cloth/dx", k) - 0.5)
            b.block((x - w / 2 + dx, top + j * h, -d / 2), (x + w / 2 + dx, top + (j + 1) * h - 0.004, d / 2), colours[k % len(colours)], 0.025, f"cloth/bolt{k}", grain=(0, 0, 1))
            k += 1
    for j, x in enumerate((-0.25, 0.1)):
        tilted(b, (x, 0.016, hd + 0.16), -0.36, 0.1 * (j - 0.5), lambda j=j: b.block(
            (-0.12, 0, -0.04), (0.12, 0.55, 0.04), ("leaf", "dye")[j], 0.02, f"cloth/leaning{j}", grain=(0, 1, 0)))
    b.finish(col, root)
    return {"collisionProxies": [proxy("table", (-hw, 0, -hd), (hw, top + 0.23, hd + 0.2))]}


def build_pottery(part, col, root):
    """A potter's or market group of terracotta ware, about 1.1 x 0.7 m: a tall storage jar, two handled jugs, a
    wide pot, a pitcher and a stack of bowls."""
    b = K["Builder"](f"settlement.{part}.mesh")
    def ware(x, z, rings, key, segments=10):
        placed(b, Matrix.Translation((x, 0, z)), lambda: lathe(b, rings, segments, "clay", key))
    ware(-0.35, -0.12, [(0, 0.12), (0.12, 0.2), (0.35, 0.22), (0.55, 0.14), (0.62, 0.09), (0.66, 0.1), (0.66, 0.0)], "pottery/jar")
    for k, (x, z, h) in enumerate(((0.05, -0.15, 0.36), (0.25, 0.05, 0.3))):
        ware(x, z, [(0, 0.07), (h * 0.35, 0.11), (h * 0.7, 0.08), (h * 0.88, 0.045), (h, 0.055), (h, 0.0)], f"pottery/jug{k}", 9)
        placed(b, Matrix.Translation((x + 0.1, h * 0.62, z)), lambda k=k: ring(b, 0.04, 0.055, -0.012, 0.012, 6, "clay", f"pottery/handle{k}"))
    ware(-0.05, 0.2, [(0, 0.1), (0.1, 0.17), (0.2, 0.18), (0.24, 0.15), (0.24, 0.0)], "pottery/pot", 12)
    ware(0.42, -0.2, [(0, 0.06), (0.15, 0.09), (0.27, 0.06), (0.3, 0.075), (0.3, 0.0)], "pottery/pitcher", 9)
    for j in range(4):
        y = j * 0.035
        placed(b, Matrix.Translation((-0.42, y, 0.22)), lambda j=j: lathe(b, [(0, 0.05), (0.06, 0.13), (0.065, 0.12), (0.015, 0.0)], 10, "clay", f"pottery/bowl{j}"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("jar", (-0.57, 0, -0.34), (-0.13, 0.66, 0.1)), proxy("ware", (-0.55, 0, -0.3), (0.55, 0.36, 0.38))]}


def build_anvil(part, col, root):
    """A blacksmith's anvil on an elm stump, its horn toward +X, a hammer and tongs leaning on the stump and a
    quench bucket beside it."""
    b = K["Builder"](f"settlement.{part}.mesh")
    sh = 0.5
    lathe(b, [(0, 0.27), (0.04, 0.25), (sh, 0.24)], 10, "wood", "anvil/stump", cap_mat="endgrain", jitter=0.05)
    y = sh
    outline = [(-0.17, 0), (0.17, 0), (0.17, 0.04), (0.08, 0.08), (0.08, 0.17), (0.2, 0.2), (0.2, 0.28), (-0.26, 0.28),
               (-0.26, 0.2), (-0.12, 0.17), (-0.12, 0.08), (-0.17, 0.04)]
    b.prism([(x, y + v) for x, v in outline], -0.075, 0.075, "iron", "anvil/body")
    b.box((-0.18, y, -0.13), (0.18, y + 0.035, 0.13), "iron", "anvil/foot")
    lying(b, (0.31, y + 0.25, 0), 0.0, 0.22, lambda: lathe(b, [(0, 0.0), (0.22, 0.05), (0.22, 0.0)], 7, "iron", "anvil/horn"), squash=(0.7, 0.8))
    # Hammer and tongs lean against the stump's front.
    tilted(b, (0.1, 0.01, 0.3), -0.3, 0, lambda: (b.box((-0.015, 0, -0.015), (0.015, 0.36, 0.015), "timber", "anvil/hammer-handle", grain=(0, 1, 0)),
                                                b.box((-0.06, 0.34, -0.025), (0.06, 0.39, 0.025), "iron", "anvil/hammer-head")))
    for s in (-1, 1):
        tilted(b, (-0.1, 0.005, 0.29), -0.32, s * 0.08, lambda s=s: b.box((-0.008, 0, -0.008), (0.008, 0.48, 0.008), "iron", f"anvil/tong{s}", grain=(0, 1, 0)))
    placed(b, Matrix.Translation((0.5, 0, 0.15)), lambda: lathe(b, [(0, 0.17), (0.32, 0.2), (0.32, 0.18), (0.27, 0.18)], 10, "wood", "anvil/bucket", cap_mat="soot"))
    for yy in (0.06, 0.26):
        placed(b, Matrix.Translation((0.5, 0, 0.15)), lambda yy=yy: lathe(b, [(yy - 0.015, 0.177 + 0.03 * yy / 0.32), (yy + 0.015, 0.179 + 0.03 * yy / 0.32)], 10, "iron", f"anvil/hoop{yy}"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("anvil", (-0.27, 0, -0.27), (0.42, y + 0.28, 0.27)), proxy("bucket", (0.3, 0, -0.05), (0.7, 0.32, 0.35))]}


def build_grindstone(part, col, root):
    """A treadle-less grindstone, 1.1 m long: a 0.8 m sandstone wheel on an iron axle between two timber
    uprights, a crank to +X, a water trough below the wheel and splayed legs."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, axle = 0.32, 0.78
    R, w = 0.38, 0.12
    for z in (-0.22, 0.22):
        b.block((-0.55, 0.32, z - 0.05), (0.55, 0.42, z + 0.05), "timber", 0.012, f"grind/rail{z}", grain=(1, 0, 0))
        for x in (-0.45, 0.45):
            for s in (-1, 1):
                b.beam((x, 0.36), (x + s * 0.1, 0.0087), 0.06, z - 0.03, z + 0.03, "timber", f"grind/leg{x}{z}{s}")
    b.box((-0.4, 0.42, -0.17), (0.4, 0.46, 0.17), "wood", "grind/trough-floor", grain=(1, 0, 0))
    open_box(b, (-0.42, 0.42, -0.17), (0.42, 0.6, 0.17), 0.03, "wood", "grind/trough")
    b.box((-0.38, 0.5, -0.14), (0.38, 0.52, 0.14), "soot", "grind/water")
    for x in (-0.14, 0.14):
        b.box((x - 0.04, 0.42, -0.2), (x + 0.04, axle + 0.08, -0.12), "timber", f"grind/upright{x}back", grain=(0, 1, 0))
        b.box((x - 0.04, 0.42, 0.12), (x + 0.04, axle + 0.08, 0.2), "timber", f"grind/upright{x}front", grain=(0, 1, 0))
    placed(b, Matrix.Translation((0, axle, 0)) @ Matrix.Rotation(math.pi / 2, 4, "X"), lambda: lathe(
        b, [(-w / 2, 0), (-w / 2, R * 0.97), (-w / 2 + 0.015, R), (w / 2 - 0.015, R), (w / 2, R * 0.97), (w / 2, 0)], 16, "monolith", "grind/wheel"))
    rod(b, (0, axle, -0.24), (0, axle, 0.3), 0.02, 6, "iron", "grind/axle")
    rod(b, (0, axle, 0.3), (0.0, axle - 0.2, 0.3), 0.015, 5, "iron", "grind/crank")
    rod(b, (0.0, axle - 0.2, 0.3), (0.0, axle - 0.2, 0.42), 0.02, 6, "timber", "grind/handle")
    b.finish(col, root)
    return {"collisionProxies": [proxy("grindstone", (-0.6, 0, -0.27), (0.6, axle + R, 0.45))]}


def build_cooper_barrel(part, col, root):
    """A cooper's barrel being raised: fourteen staves gathered in two hoops at the foot and splayed open at the
    top, loose staves and a spare hoop on the ground beside it."""
    b = K["Builder"](f"settlement.{part}.mesh")
    n, H, r0, r1 = 14, 0.85, 0.27, 0.36
    tilt = math.atan2(r1 - r0, H)
    for k in range(n):
        a = math.tau * k / n
        rm = (r0 + r1) / 2
        tilted(b, (rm * math.sin(a), H / 2, rm * math.cos(a)), tilt, a, lambda k=k: b.box(
            (-0.055, -H / 2, -0.012), (0.055, H / 2, 0.012), "wood", f"cooper/stave{k}", grain=(0, 1, 0)))
    for y in (0.08, 0.26):
        r = r0 + (r1 - r0) * y / H + 0.014
        lathe(b, [(y - 0.025, r), (y + 0.025, r + 0.006)], n, "iron", f"cooper/hoop{y}")
    for j, (x, z, yaw) in enumerate(((0.55, 0.15, 0.3), (0.62, 0.0, 0.2), (-0.5, 0.35, -0.6))):
        placed(b, Matrix.Translation((x, 0.012, z)) @ Matrix.Rotation(yaw, 4, "Y"), lambda j=j: b.box(
            (-0.42, -0.012, -0.055), (0.42, 0.012, 0.055), "wood", f"cooper/loose{j}", grain=(1, 0, 0)))
    placed(b, Matrix.Translation((-0.35, 0.0965, -0.5)) @ Matrix.Rotation(0.25 - math.pi / 2, 4, "X"), lambda: ring(
        b, 0.29, 0.31, -0.02, 0.02, 14, "iron", "cooper/spare-hoop"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("barrel", (-r1, 0, -r1), (r1, H, r1))]}


# ---------------------------------------------------------------- inn and hall clutter (#671)

def tankard(b, center, mat, key, handle_yaw=0.0):
    """A lidless tankard 0.13 m tall, ``center`` on its base, its handle turned ``handle_yaw`` from +X."""
    placed(b, Matrix.Translation(Vector(center)), lambda: lathe(
        b, [(0, 0.045), (0.012, 0.047), (0.12, 0.042), (0.13, 0.044), (0.13, 0.036), (0.03, 0)], 7, mat, f"{key}/body"))
    placed(b, Matrix.Translation(Vector(center)) @ Matrix.Rotation(handle_yaw, 4, "Y") @ Matrix.Translation((0.05, 0.07, 0)),
           lambda: ring(b, 0.028, 0.04, -0.008, 0.008, 5, mat, f"{key}/handle"))


def platter(b, center, radius, mat, key):
    placed(b, Matrix.Translation(Vector(center)), lambda: lathe(
        b, [(0, radius * 0.75), (0.012, radius), (0.016, radius * 0.95), (0.008, 0)], 8, mat, key))


def build_table_set(part, col, root):
    """Inn table dressing for a 1.2 x 0.6 m tabletop, its origin on the top: four places of plates and tankards (two
    pewter, two turned wood), a jug, a loaf on a board and a candle stub. Place it on any table."""
    b = K["Builder"](f"settlement.{part}.mesh")
    for k, (x, z, mat) in enumerate(((-0.4, 0.18, "iron"), (0.35, 0.17, "timber"), (-0.3, -0.18, "timber"), (0.42, -0.17, "iron"))):
        platter(b, (x, 0, z), 0.11, "endgrain", f"set/plate{k}")
        bun(b, (x + 0.02, 0.01, z - 0.01), 0.04, f"set/food{k}")
        tankard(b, (x + (0.16 if x < 0 else -0.16), 0, z + (0.06 if z > 0 else -0.06)), mat, f"set/tankard{k}", handle_yaw=math.pi if x > 0 else 0.0)
    placed(b, Matrix.Translation((0.02, 0, 0.0)), lambda: lathe(
        b, [(0, 0.06), (0.1, 0.08), (0.17, 0.05), (0.21, 0.04), (0.24, 0.05), (0.24, 0.0)], 9, "clay", "set/jug"))
    b.block((-0.16, 0, -0.06), (-0.02, 0.02, 0.06), "wood", 0.005, "set/board")
    loaf(b, (-0.09, 0.02 + 0.045, 0.0), 0.16, 0.06, 0.2, "set/loaf")
    placed(b, Matrix.Translation((0.14, 0, 0.0)), lambda: lathe(b, [(0, 0.04), (0.012, 0.04), (0.012, 0)], 6, "iron", "set/candle-dish"))
    placed(b, Matrix.Translation((0.14, 0.012, 0.0)), lambda: lathe(b, [(0, 0.016), (0.07, 0.015), (0.075, 0.0)], 6, "canvas", "set/candle"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("set", (-0.6, 0, -0.3), (0.6, 0.24, 0.3))]}


def candle(b, x, y, z, height, key):
    """A wax candle standing at (x, y, z) with a small flame; returns the flame's position."""
    placed(b, Matrix.Translation((x, y, z)), lambda: lathe(b, [(0, 0.018), (height, 0.016), (height + 0.006, 0.0)], 6, "canvas", f"{key}/wax"))
    placed(b, Matrix.Translation((x, y + height + 0.004, z)), lambda: lathe(b, [(0, 0.0), (0.012, 0.009), (0.035, 0.0)], 5, "horn", f"{key}/flame"))
    return (x, y + height + 0.02, z)


def build_candles(part, col, root):
    """Three candles of different heights on a pewter dish with a ring handle, 0.25 m across, for a table, shelf or
    mantel. Its ``light`` node is at the tallest flame."""
    b = K["Builder"](f"settlement.{part}.mesh")
    lathe(b, [(0, 0.1), (0.012, 0.12), (0.02, 0.118), (0.008, 0.0)], 10, "iron", "candles/dish")
    placed(b, Matrix.Translation((0.14, 0.01, 0)) @ Matrix.Rotation(math.pi / 2, 4, "X"), lambda: ring(b, 0.02, 0.032, -0.005, 0.005, 6, "iron", "candles/ring"))
    flames = [candle(b, x, 0.012, z, h, f"candles/c{k}") for k, (x, z, h) in enumerate(((-0.03, -0.02, 0.2), (0.04, 0.0, 0.13), (-0.01, 0.05, 0.08)))]
    b.finish(col, root)
    light = r6(flames[0])
    K["empty"]("light", col, root, tuple(light))
    return {"light": {"node": "light", "position": light}, "collisionProxies": [proxy("dish", (-0.12, 0, -0.12), (0.12, 0.24, 0.12))]}


def build_candelabra(part, col, root):
    """A 1.5 m wrought-iron floor candelabrum for a hall: three splayed feet, a twisted shaft and a crossarm of three
    drip cups with candles. Its ``light`` node is at the middle flame."""
    b = K["Builder"](f"settlement.{part}.mesh")
    for k in range(3):
        a = math.tau * k / 3 + math.pi / 2
        rod(b, (0, 0.18, 0), (0.28 * math.cos(a), 0.0135, -0.28 * math.sin(a)), 0.016, 5, "iron", f"candelabra/foot{k}")
        placed(b, Matrix.Translation((0.28 * math.cos(a), 0, -0.28 * math.sin(a))), lambda k=k: lathe(b, [(0, 0.035), (0.02, 0.03), (0.03, 0.0)], 6, "iron", f"candelabra/pad{k}"))
    lathe(b, [(0.15, 0.04), (0.2, 0.025), (1.3, 0.018), (1.33, 0.03), (1.36, 0.018), (1.42, 0.02)], 6, "iron", "candelabra/shaft")
    b.box((-0.32, 1.36, -0.014), (0.32, 1.39, 0.014), "iron", "candelabra/arm", grain=(1, 0, 0))
    flames = []
    for k, x in enumerate((-0.3, 0.0, 0.3)):
        y = 1.42 if x == 0 else 1.39
        placed(b, Matrix.Translation((x, y, 0)), lambda k=k: lathe(b, [(0, 0.01), (0.015, 0.05), (0.025, 0.055), (0.025, 0.0)], 8, "iron", f"candelabra/cup{k}"))
        flames.append(candle(b, x, y + 0.02, 0, 0.18 if x == 0 else 0.14, f"candelabra/c{k}"))
        if x:
            rod(b, (x * 0.55, 1.38, 0), (x, 1.39, 0), 0.01, 4, "iron", f"candelabra/scroll{k}")
    b.finish(col, root)
    light = r6(flames[1])
    K["empty"]("light", col, root, tuple(light))
    return {"light": {"node": "light", "position": light}, "collisionProxies": [proxy("candelabrum", (-0.3, 0, -0.3), (0.3, light[1] + 0.03, 0.3))]}


def build_inn_sign(part, col, root):
    """A blank hanging inn sign for a wall at −Z: a timber wall plate and a braced iron bracket reaching 1.1 m out
    toward +Z, a 0.7 x 0.55 m board hanging edge-on to the wall so it faces ±X, blank inside a dark painted border.
    The origin is the foot of the wall plate; mount it on a wall about 2.4 m up. Its ``sign`` node is at the
    board's centre for a consumer's painted emblem."""
    b = K["Builder"](f"settlement.{part}.mesh")
    b.block((-0.09, 0, 0), (0.09, 0.9, 0.05), "timber", 0.01, "inn/plate", grain=(0, 1, 0))
    arm_y, reach = 0.8, 1.1
    b.box((-0.018, arm_y, 0.05), (0.018, arm_y + 0.04, reach), "iron", "inn/arm", grain=(0, 0, 1))
    tilted(b, (0, 0, 0), 0, -math.pi / 2, lambda: b.beam((0.05, 0.12), (0.7, arm_y), 0.03, -0.014, 0.014, "iron", "inn/stay"))
    placed(b, Matrix.Translation((0, arm_y + 0.02, reach)), lambda: lathe(b, [(0, 0.025), (0.03, 0.0)], 5, "iron", "inn/finial"))
    board = {"z0": 0.32, "z1": 1.02, "y0": 0.1, "y1": 0.65}
    for z in (board["z0"] + 0.06, board["z1"] - 0.06):
        b.box((-0.01, board["y1"], z - 0.01), (0.01, arm_y, z + 0.01), "iron", f"inn/hanger{z}")
    b.block((-0.025, board["y0"], board["z0"]), (0.025, board["y1"], board["z1"]), "wood", 0.01, "inn/board", grain=(0, 0, 1))
    for s in (-1, 1):
        x0, x1 = (0.025, 0.031) if s > 0 else (-0.031, -0.025)
        b.box((x0, board["y0"] + 0.04, board["z0"] + 0.04), (x1, board["y1"] - 0.04, board["z1"] - 0.04), "soot", f"inn/border{s}", grain=(0, 0, 1))
        x0, x1 = (0.027, 0.034) if s > 0 else (-0.034, -0.027)
        b.box((x0, board["y0"] + 0.065, board["z0"] + 0.065), (x1, board["y1"] - 0.065, board["z1"] - 0.065), "canvas", f"inn/blank{s}", grain=(0, 0, 1))
    b.finish(col, root)
    centre = (0.0, (board["y0"] + board["y1"]) / 2, (board["z0"] + board["z1"]) / 2)
    K["empty"]("sign", col, root, centre)
    return {"sign": {"node": "sign", "board": {"min": [-0.034, board["y0"], board["z0"]], "max": [0.034, board["y1"], board["z1"]]}},
            "collisionProxies": [proxy("bracket", (-0.09, 0, 0), (0.09, arm_y + 0.06, reach + 0.03))]}


def build_stool(part, col, root):
    """A three-legged round tavern stool, its seat 0.45 m up and 0.32 m across, with a stretcher ring."""
    b = K["Builder"](f"settlement.{part}.mesh")
    seat = 0.45
    lathe(b, [(seat - 0.045, 0.15), (seat - 0.01, 0.16), (seat, 0.155), (seat, 0.0)], 12, "wood", "stool/seat", cap_mat="endgrain")
    for k in range(3):
        a = math.tau * k / 3 + 0.3
        rod(b, (0.08 * math.cos(a), seat - 0.04, -0.08 * math.sin(a)), (0.17 * math.cos(a), 0.0042, -0.17 * math.sin(a)), 0.02, 6, "timber", f"stool/leg{k}")
        c = math.tau * (k + 1) / 3 + 0.3
        rod(b, (0.135 * math.cos(a), 0.16, -0.135 * math.sin(a)), (0.135 * math.cos(c), 0.16, -0.135 * math.sin(c)), 0.012, 5, "timber", f"stool/rung{k}")
    b.finish(col, root)
    return {"seat": {"height": seat, "length": 0.32, "depth": 0.32}, "collisionProxies": [proxy("stool", (-0.17, 0, -0.17), (0.17, seat, 0.17))]}


BAR_MODULE = 2.0


def build_bar_counter(part, col, root):
    """A 2 m inn bar counter segment along X: a panelled front toward the room at +Z, a 1.05 m oak top overhanging
    it, a footrail, and behind it (−Z) a pot shelf with a few tankards. Segments chain end to end."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, top, d = BAR_MODULE / 2, 1.05, 0.6
    b.block((-hw, top - 0.05, -d / 2), (hw, top, d / 2 + 0.06), "wood", 0.012, "bar/top", grain=(1, 0, 0))
    b.box((-hw, 0, d / 2 - 0.04), (hw, top - 0.05, d / 2), "wood", "bar/front", grain=(0, 1, 0))
    for k in range(5):
        x = -hw + k * BAR_MODULE / 4
        x0, x1 = (x, x + 0.04) if k == 0 else ((x - 0.04, x) if k == 4 else (x - 0.035, x + 0.035))
        b.box((x0, 0.0, d / 2), (x1, top - 0.05, d / 2 + 0.025), "timber", f"bar/stile{k}", grain=(0, 1, 0))
    for y0, y1 in ((0.0, 0.12), (top - 0.17, top - 0.05)):
        b.box((-hw, y0, d / 2), (hw, y1, d / 2 + 0.03), "timber", f"bar/rail{y0}", grain=(1, 0, 0))
    b.box((-hw, 0, -d / 2), (hw, 0.08, d / 2 - 0.04), "timber", "bar/plinth", grain=(1, 0, 0))
    for x in (-hw + 0.03, 0.0, hw - 0.03):
        b.box((x - 0.03, 0.08, -d / 2), (x + 0.03, top - 0.05, -d / 2 + 0.06), "timber", f"bar/post{x}", grain=(0, 1, 0))
    shelf = 0.55
    b.box((-hw, shelf - 0.03, -d / 2), (hw, shelf, d / 2 - 0.04), "wood", "bar/shelf", grain=(1, 0, 0))
    for k, x in enumerate((-0.7, -0.55, 0.3, 0.45, 0.6)):
        tankard(b, (x, shelf, -0.1), ("iron", "timber")[k % 2], f"bar/tankard{k}")
    for x in (-0.75, 0.75):
        b.box((x - 0.02, 0.12, d / 2 + 0.03), (x + 0.02, 0.2, d / 2 + 0.16), "iron", f"bar/rail-bracket{x}", grain=(0, 0, 1))
    rod(b, (-hw, 0.18, d / 2 + 0.14), (hw, 0.18, d / 2 + 0.14), 0.02, 6, "iron", "bar/footrail")
    b.finish(col, root)
    return {"module": {"width": BAR_MODULE, "height": top},
            "collisionProxies": [proxy("counter", (-hw, 0, -d / 2), (hw, top, d / 2 + 0.06))]}


def build_log_stack(part, col, root):
    """Firewood stacked by a hearth: about 0.9 x 0.45 m of split logs between two iron log-dogs on the floor, and a
    kindling basket beside it toward +X."""
    b = K["Builder"](f"settlement.{part}.mesh")
    L = 0.45
    for k in range(4):
        x = -0.36 + 0.24 * k
        b.box((x - 0.015, 0, -L / 2 + 0.02), (x + 0.015, 0.03, L / 2 - 0.02), "iron", f"logs/dog{k}", grain=(0, 0, 1))
    rows = ((0.03, (-0.33, -0.17, -0.01, 0.15)), (0.17, (-0.25, -0.09, 0.07)), (0.31, (-0.17, 0.0)))
    for r_, (y, xs) in enumerate(rows):
        for j, x in enumerate(xs):
            key = f"logs/log{r_}{j}"
            r = 0.07 + 0.01 * rnd(key, "r")
            placed(b, Matrix.Translation((x, y + r * 0.95, -L / 2)) @ Matrix.Rotation(math.pi / 2, 4, "X") @ Matrix.Rotation(rnd(key, "a") * 6, 4, "Y"),
                   lambda key=key, r=r: lathe(b, [(0, r), (L, r * 0.95)], 6, "wood", key, cap_mat="endgrain", jitter=0.08))
    placed(b, Matrix.Translation((0.48, 0, 0.0)), lambda: lathe(b, [(0, 0.13), (0.3, 0.17), (0.3, 0.155), (0.04, 0.12)], 10, "straw", "logs/basket"))
    for k in range(5):
        a = k * 1.25
        tilted(b, (0.48 + 0.06 * math.cos(a), 0.05, 0.06 * math.sin(a)), 0.12 * math.sin(a), 0.12 * math.cos(a), lambda k=k: b.box(
            (-0.015, 0, -0.015), (0.015, 0.36, 0.015), "timber", f"logs/kindling{k}", grain=(0, 1, 0)))
    b.finish(col, root)
    return {"collisionProxies": [proxy("logs", (-0.42, 0, -L / 2), (0.66, 0.45, L / 2))]}


def build_wall_shield(part, col, root):
    """A round painted shield over two crossed spears, 1.4 m across, for a wall at −Z (its back at z = 0, facing
    +Z). The origin is the bottom of its back; mount it on the wall at the height you want."""
    b = K["Builder"](f"settlement.{part}.mesh")
    cy, R = 0.7, 0.36
    for s in (-1, 1):
        rod(b, (s * 0.62, 0.0099, 0.03), (-s * 0.62, cy + 0.62, 0.03), 0.014, 5, "timber", f"shield/spear{s}")
        placed(b, Matrix.Translation((-s * 0.62, cy + 0.62, 0.03)) @ Matrix.Rotation(s * math.pi / 4, 4, "Z"),
               lambda s=s: lathe(b, [(0, 0.018), (0.06, 0.035), (0.16, 0.0)], 4, "iron", f"shield/head{s}"))
    placed(b, Matrix.Translation((0, cy, 0.05)) @ Matrix.Rotation(math.pi / 2, 4, "X"), lambda: lathe(
        b, [(-0.02, R), (0.0, R + 0.01), (0.02, R), (0.035, R * 0.9), (0.05, 0.0)], 14, "dye", "shield/face", cap_mat="dye"))
    placed(b, Matrix.Translation((0, cy, 0.05)), lambda: ring(
        b, R - 0.015, R + 0.015, -0.025, 0.025, 14, "iron", "shield/rim"))
    for k, (dx, dy) in enumerate(((0.0, 1.0), (1.0, 0.0))):
        b.box((-0.03 if dx == 0 else -R + 0.02, cy - (R - 0.02 if dx == 0 else 0.03), 0.085), (0.03 if dx == 0 else R - 0.02, cy + (R - 0.02 if dx == 0 else 0.03), 0.095), "canvas", f"shield/cross{k}")
    placed(b, Matrix.Translation((0, cy, 0.09)) @ Matrix.Rotation(math.pi / 2, 4, "X"), lambda: lathe(
        b, [(0, 0.08), (0.04, 0.06), (0.06, 0.0)], 8, "iron", "shield/boss"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("shield", (-0.62, 0, 0), (0.62, cy + 0.78, 0.16))]}


def build_wall_trophy(part, col, root):
    """A stag's antlers on a carved oak plaque for a wall at −Z (its back at z = 0, facing +Z), 0.95 m across. The
    origin is the bottom of the plaque's back; mount it on the wall at the height you want."""
    b = K["Builder"](f"settlement.{part}.mesh")
    b.prism([(-0.16, 0.0), (0.16, 0.0), (0.2, 0.18), (0.16, 0.42), (0.0, 0.48), (-0.16, 0.42), (-0.2, 0.18)], 0.0, 0.05, "wood", "trophy/plaque", grain=(0, 1, 0))
    placed(b, Matrix.Translation((0, 0.24, 0.05)) @ Matrix.Rotation(math.pi / 2, 4, "X"), lambda: lathe(
        b, [(0, 0.08), (0.06, 0.075), (0.1, 0.05), (0.12, 0.0)], 8, "canvas", "trophy/skull"))
    for s in (-1, 1):
        pts = [(s * 0.05, 0.3, 0.12), (s * 0.18, 0.42, 0.14), (s * 0.3, 0.6, 0.12), (s * 0.4, 0.8, 0.08), (s * 0.44, 0.98, 0.05)]
        for k, (a, c) in enumerate(zip(pts, pts[1:])):
            rod(b, a, c, 0.022 - 0.004 * k, 5, "horn", f"trophy/beam{s}{k}")
        for k, (i, dx, dy) in enumerate(((1, 0.02, 0.16), (2, -0.1, 0.14), (3, 0.06, 0.15), (3, -0.1, 0.12))):
            p = pts[i]
            rod(b, p, (p[0] + s * dx, p[1] + dy, p[2] + 0.03), 0.013, 4, "horn", f"trophy/tine{s}{k}")
    b.finish(col, root)
    return {"collisionProxies": [proxy("trophy", (-0.5, 0, 0), (0.5, 1.12, 0.2))]}


# ---------------------------------------------------------------- river and lake (#675)

def oriented_faces(b, verts, polys, mat, key, outward, grain=None):
    """``b.faces`` with each polygon wound so its normal points along ``outward(centre)`` (a glTF direction)."""
    fixed = []
    for poly in polys:
        p = [Vector(verts[i]) for i in poly]
        normal = (p[1] - p[0]).cross(p[2] - p[0])
        if normal.length < 1e-12 and len(p) > 3:
            normal = (p[2] - p[1]).cross(p[3] - p[1])
        centre = sum(p, Vector()) / len(p)
        fixed.append(poly if normal.dot(Vector(outward(centre))) >= 0 else list(reversed(poly)))
    return b.faces(verts, fixed, mat, key, grain)


BOAT = {"length": 3.6, "beam": 1.2, "sheer": 0.5, "rise": 0.14, "transom": 0.55}


def hull_section(x):
    """Half-breadth and sheer height of the rowing boat at ``x`` along its length (bow toward +X)."""
    L, W = BOAT["length"], BOAT["beam"] / 2
    t = 2 * x / L  # -1 at the transom, +1 at the stem
    w = W * (1 - max(t, 0) ** 1.8) ** 0.75 if t > 0 else W * (1 - (1 - BOAT["transom"]) * (-t) ** 3)
    return max(w, 0.0), BOAT["sheer"] + BOAT["rise"] * t * t


def build_rowing_boat(part, col, root):
    """A 3.6 m clinker-look rowing boat drawn up on the bank, bow toward +X: a lofted plank hull with a
    transom stern, a gunwale, three thwarts, two oars laid along the thwarts and a mooring ring at the stem.
    Its keel is on the ground (y = 0)."""
    b = K["Builder"](f"settlement.{part}.mesh")
    L = BOAT["length"]
    stations = [-L / 2 + L * 0.993 * k / 12 for k in range(13)]
    profile = [(0.0, 0.0), (0.45, 0.04), (0.82, 0.16), (0.97, 0.34), (1.0, 1.0)]  # (share of half-breadth, share of sheer)
    def ring(x, inset):
        w, h = hull_section(x)
        pts = []
        for s in (1, -1):
            row = [(x, inset + (h - inset) * fh if fh < 1 else h, s * max(w * fw - inset, 0.0)) for fw, fh in profile]
            pts.append(row if s > 0 else list(reversed(row)))
        return pts[1] + pts[0][1:]  # starboard gunwale ... keel ... port gunwale
    for skin, inset, mat in (("outer", 0.0, "wood"), ("inner", 0.035, "wood")):
        verts, polys = [], []
        rings = [ring(x, inset) for x in stations]
        n = len(rings[0])
        for r in rings:
            verts += r
        for i in range(len(rings) - 1):
            for j in range(n - 1):
                polys.append([i * n + j, i * n + j + 1, (i + 1) * n + j + 1, (i + 1) * n + j])
        sign = 1 if skin == "outer" else -1
        oriented_faces(b, verts, polys, mat, f"boat/{skin}", lambda c, sign=sign: (0, sign * (c.y - 0.35), sign * 2 * c.z), grain=(1, 0, 0))
    # Gunwale cap and the transom: close the two skins along the sheer and across the stern.
    verts, top, outside, inside = [], [], [], []
    for x in stations:
        w, h = hull_section(x)
        for s in (1, -1):
            verts += [(x, h, s * w), (x, h, s * max(w - 0.035, 0.0)), (x, h + 0.03, s * w), (x, h + 0.03, s * max(w - 0.035, 0.0))]
    for i in range(len(stations) - 1):
        for s in range(2):
            a, c = (i * 2 + s) * 4, ((i + 1) * 2 + s) * 4
            top.append([a + 2, a + 3, c + 3, c + 2])
            outside.append([a, a + 2, c + 2, c])
            inside.append([a + 1, c + 1, c + 3, a + 3])
    oriented_faces(b, verts, top, "timber", "boat/gunwale-top", lambda c: (0, 1, 0), grain=(1, 0, 0))
    oriented_faces(b, verts, outside, "timber", "boat/gunwale-out", lambda c: (0, 0, c.z), grain=(1, 0, 0))
    oriented_faces(b, verts, inside, "timber", "boat/gunwale-in", lambda c: (0, 0, -c.z), grain=(1, 0, 0))
    x0 = stations[0]
    outer, inner = ring(x0, 0.0), ring(x0, 0.035)
    transom = [(x0, y, z) for _, y, z in outer] + [(x0 + 0.035, y, z) for _, y, z in inner]
    n = len(outer)
    polys = [list(range(n)), list(range(n, 2 * n))]
    oriented_faces(b, transom, polys, "timber", "boat/transom", lambda c: (-1, 0, 0) if c.x < x0 + 0.02 else (1, 0, 0), grain=(0, 0, 1))
    b.block((-L / 2 + 0.02, 0.0, -0.04), (L / 2 - 0.12, 0.05, 0.04), "timber", 0.01, "boat/keel", grain=(1, 0, 0))
    for k, x in enumerate((-1.25, -0.2, 0.75)):
        w, h = hull_section(x)
        b.block((x - 0.12, h - 0.14, -w + 0.05), (x + 0.12, h - 0.1, w - 0.05), "wood", 0.008, f"boat/thwart{k}", grain=(0, 0, 1))
    for s in (1, -1):
        rod(b, (-1.5, 0.42, s * 0.28), (1.0, 0.42, s * 0.3), 0.02, 5, "timber", f"boat/oar{s}")
        b.block((-1.5, 0.405, s * 0.29 - 0.07), (-1.0, 0.425, s * 0.29 + 0.07), "wood", 0.005, f"boat/blade{s}", grain=(1, 0, 0))
    placed(b, Matrix.Translation((L / 2 - 0.06, hull_section(L / 2 - 0.06)[1] - 0.08, 0)) @ Matrix.Rotation(math.pi / 2, 4, "Y"),
           lambda: ring_part(b))
    b.finish(col, root)
    hb, hs = BOAT["beam"] / 2, BOAT["sheer"] + BOAT["rise"] + 0.03
    return {"collisionProxies": [proxy("hull", (-L / 2, 0, -hb), (L / 2, hs, hb))]}


def ring_part(b):
    ring(b, 0.03, 0.04, -0.008, 0.008, 6, "iron", "boat/mooring-ring")


JETTY_MODULE = 3.0


def build_jetty(part, col, root):
    """A 3 m plank jetty segment along X for a river or lake bank: a 1.6 m deck 0.5 m above the water line (y = 0)
    on two stringers and cross-bearers, carried by pairs of round piles 1.5 m apart that reach 1.2 m down into
    the bed. The pile pairs sit 0.75 m in from each end, so chained segments (``module`` width 3) keep the 1.5 m
    spacing."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, deck, bed = JETTY_MODULE / 2, 0.8, 0.5, -1.2
    t = 0.05
    for k in range(12):
        x0 = -hw + k * JETTY_MODULE / 12 + 0.006
        x1 = x0 + JETTY_MODULE / 12 - 0.012
        sag = 0.006 * rnd("jetty/plank", k)
        b.box((x0, deck - t - sag, -hd + 0.02 * rnd("jetty/l", k)), (x1, deck - sag, hd - 0.02 * rnd("jetty/r", k)), "wood", f"jetty/plank{k}", grain=(0, 0, 1))
    for z in (-0.6, 0.6):
        b.block((-hw, deck - t - 0.16, z - 0.06), (hw, deck - t, z + 0.06), "timber", 0.01, f"jetty/stringer{z}", grain=(1, 0, 0))
    for x in (-0.75, 0.75):
        b.block((x - 0.07, deck - t - 0.3, -hd + 0.02), (x + 0.07, deck - t - 0.16, hd - 0.02), "timber", 0.01, f"jetty/bearer{x}", grain=(0, 0, 1))
        for z in (-0.7, 0.7):
            placed(b, Matrix.Translation((x, bed, z)), lambda x=x, z=z: lathe(
                b, [(0, 0.08), (deck - t - 0.16 - bed, 0.09), (deck - t - 0.16 - bed + 0.04, 0.0)], 8, "timber", f"jetty/pile{x}{z}", cap_mat="endgrain", jitter=0.06))
        b.block((x - 0.03, deck - t - 0.3, -hd + 0.05), (x + 0.03, -0.1, -hd + 0.09), "timber", 0.008, f"jetty/brace{x}", grain=(0, 1, 0))
    for x in (-hw + 0.35, hw - 0.35):
        placed(b, Matrix.Translation((x, deck, hd - 0.12)), lambda x=x: lathe(b, [(0, 0.06), (0.22, 0.06), (0.26, 0.04), (0.26, 0.0)], 7, "timber", f"jetty/bollard{x}", cap_mat="endgrain"))
    b.finish(col, root)
    return {"module": {"width": JETTY_MODULE, "height": deck},
            "collisionProxies": [proxy("deck", (-hw, deck - t - 0.3, -hd), (hw, deck, hd)), proxy("piles", (-hw + 0.6, bed, -0.8), (hw - 0.6, deck - t - 0.3, 0.8))]}


def build_fishing_nets(part, col, root):
    """Fishing nets hung to dry: two 2.2 m poles 2.4 m apart along X with a cross pole, a sagging net between
    them with cork floats along its head rope, a second net heaped over a trestle, and a creel."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, top = 1.2, 2.2
    for x in (-hw, hw):
        rod(b, (x, 0.0, 0.0), (x * 1.02, top, 0.0), 0.045, 7, "timber", f"nets/pole{x}")
        b.block((x - 0.12, 0, -0.12), (x + 0.12, 0.05, 0.12), "stone", 0.02, f"nets/footing{x}")
    rod(b, (-hw - 0.1, top - 0.08, 0), (hw + 0.1, top - 0.08, 0), 0.03, 6, "timber", "nets/cross-pole")
    def sag(u):
        return 0.14 * math.sin(math.pi * u)
    rows, cols = 6, 11
    head, foot = top - 0.12, 0.55
    for i in range(rows):  # horizontal cords, sagging more toward the head rope's middle
        y = head - (head - foot) * i / (rows - 1)
        pts = [(-hw + 2 * hw * j / (cols - 1), y - sag(j / (cols - 1)) * (0.5 + i / rows), 0.01 * math.sin(j * 1.7 + i)) for j in range(cols)]
        for j, (a, c) in enumerate(zip(pts, pts[1:])):
            b.beam((a[0], a[1]), (c[0], c[1]), 0.012 if i else 0.022, -0.006, 0.006, "sacking", f"nets/cord{i}{j}")
    for j in range(cols):
        x = -hw + 2 * hw * j / (cols - 1)
        u = j / (cols - 1)
        b.beam((x, head - sag(u) * 0.5), (x, foot - sag(u) * 1.5), 0.012, -0.006, 0.006, "sacking", f"nets/mesh{j}")
    for j in range(1, cols - 1, 2):
        x, u = -hw + 2 * hw * j / (cols - 1), j / (cols - 1)
        placed(b, Matrix.Translation((x, head - sag(u) * 0.5 - 0.05, 0)), lambda j=j: lathe(b, [(0, 0.0), (0.02, 0.04), (0.08, 0.04), (0.1, 0.0)], 6, "endgrain", f"nets/float{j}"))
    # A second net heaped over a low trestle in front, and a wicker creel.
    tz = 0.9
    for x in (-0.55, 0.55):
        b.beam((x - 0.15, 0.0071), (x, 0.55), 0.05, tz - 0.25, tz - 0.2, "timber", f"nets/trestle{x}a")
        b.beam((x + 0.15, 0.0071), (x, 0.55), 0.05, tz - 0.25, tz - 0.2, "timber", f"nets/trestle{x}b")
    b.block((-0.75, 0.55, tz - 0.27), (0.75, 0.6, tz - 0.18), "timber", 0.01, "nets/trestle-bar", grain=(1, 0, 0))
    lying(b, (0.0, 0.62, tz - 0.22), 0.0, 1.5, lambda: lathe(b, [(0, 0.0), (0.1, 0.12), (0.75, 0.16), (1.4, 0.12), (1.5, 0.0)], 7, "sacking", "nets/heap", jitter=0.15), squash=(0.7, 1.4))
    placed(b, Matrix.Translation((0.9, 0, tz)), lambda: lathe(b, [(0, 0.14), (0.32, 0.18), (0.32, 0.16), (0.04, 0.12)], 9, "straw", "nets/creel"))
    b.finish(col, root)
    return {"collisionProxies": [proxy("poles", (-hw - 0.12, 0, -0.12), (hw + 0.12, top + 0.02, 0.12)), proxy("trestle", (-0.75, 0, tz - 0.45), (1.1, 0.75, tz + 0.18))]}


# ---------------------------------------------------------------- banners and heraldry (#677)

# Liveries: field and charge colours. The Outpost flies the Marshal's indigo with ochre heraldry (as the fortress
# kit's banners and mmorpg's fortifications); a village flies undyed linen with madder-red stripes.
LIVERY = {"outpost": ("indigo", "ochre"), "village": ("canvas", "dye")}


def cloth(b, mat, key, x0, x1, top, bottom, fold, nu=8, nv=5, z0=0.0, thick=0.008, u_range=(0.0, 1.0), v_range=(0.0, 1.0)):
    """A thin hanging cloth sheet, both faces: columns from ``x0`` to ``x1``, each hanging from ``top(u)`` down to
    ``bottom(u)`` (u in 0..1 across), its surface waved out of the XY plane by ``fold(u, v)`` metres. ``u_range``
    and ``v_range`` cut a patch out of the same sheet, so charges and stripes lie on the field's folds."""
    def point(u, v, side):
        x = x0 + (x1 - x0) * u
        y = top(u) + (bottom(u) - top(u)) * v
        return (x, y, z0 + fold(u, v) + side * thick / 2)
    us = [u_range[0] + (u_range[1] - u_range[0]) * i / nu for i in range(nu + 1)]
    vs = [v_range[0] + (v_range[1] - v_range[0]) * j / nv for j in range(nv + 1)]
    verts, front, back = [], [], []
    for side in (1, -1):
        for u in us:
            for v in vs:
                verts.append(point(u, v, side))
    m = nv + 1
    half = len(us) * m
    for i in range(nu):
        for j in range(nv):
            a, c = i * m + j, (i + 1) * m + j
            front.append([a, c, c + 1, a + 1])
            back.append([half + a, half + a + 1, half + c + 1, half + c])
    made = b.faces(verts, front + back, mat, key, grain=(1, 0, 0))
    for f in made[:len(front)]:
        if f.normal.y > 0:  # glTF +Z is Blender -Y: make the front face out toward +Z
            f.normal_flip()
    for f in made[len(front):]:
        if f.normal.y < 0:
            f.normal_flip()
    return made


def flagpole(b, height, key, finial=True):
    b.block((-0.18, 0, -0.18), (0.18, 0.12, 0.18), "stone", 0.02, f"{key}/footing")
    rod(b, (0, 0.12, 0), (0, height, 0), 0.04, 7, "timber", f"{key}/pole")
    if finial:
        placed(b, Matrix.Translation((0, height, 0)), lambda: lathe(b, [(0, 0.05), (0.04, 0.06), (0.12, 0.0)], 6, "iron", f"{key}/finial"))


def build_banner(livery):
    field, charge = LIVERY[livery]

    def build(part, col, root):
        """A 3.6 m banner pole on a stone footing with a crossbar carrying a 0.8 x 1.5 m swallow-tailed banner in
        the {livery} livery, hanging in gentle folds and facing ±Z."""
        b = K["Builder"](f"settlement.{part}.mesh")
        H, w, top, h, notch = 3.6, 0.8, 3.3, 1.5, 0.3
        flagpole(b, H, "banner")
        rod(b, (-w / 2 - 0.08, top + 0.03, 0.05), (w / 2 + 0.08, top + 0.03, 0.05), 0.022, 6, "timber", "banner/crossbar")
        for x in (-w / 2 - 0.08, w / 2 + 0.08):
            placed(b, Matrix.Translation((x, top + 0.03, 0.05)) @ Matrix.Rotation(-math.pi / 2, 4, "Z"),
                   lambda x=x: lathe(b, [(0, 0.03), (0.04, 0.0)], 6, "iron", f"banner/knob{x}"))
        top_f = lambda u: top
        bottom_f = lambda u: top - h + notch * (1 - abs(2 * u - 1))
        fold = lambda u, v: 0.05 + 0.035 * math.sin(u * 3 * math.pi) * (0.3 + v)
        cloth(b, field, "banner/field", -w / 2, w / 2, top_f, bottom_f, fold)
        lift = lambda u, v: fold(u, v) + 0.006
        sink = lambda u, v: fold(u, v) - 0.006
        if livery == "outpost":
            # An ochre pale down the middle and a band across the head, both faces.
            for f, s in ((lift, "front"), (sink, "back")):
                cloth(b, charge, f"banner/pale-{s}", -w / 2, w / 2, top_f, bottom_f, f, nu=2, nv=5, thick=0.002, u_range=(0.4, 0.6), v_range=(0.16, 1.0))
                cloth(b, charge, f"banner/band-{s}", -w / 2, w / 2, top_f, bottom_f, f, nu=8, nv=1, thick=0.002, u_range=(0.0, 1.0), v_range=(0.06, 0.16))
        else:
            for f, s in ((lift, "front"), (sink, "back")):
                for k, (v0, v1) in enumerate(((0.12, 0.24), (0.36, 0.48))):
                    cloth(b, charge, f"banner/stripe{k}-{s}", -w / 2, w / 2, top_f, bottom_f, f, nu=8, nv=1, thick=0.002, u_range=(0.0, 1.0), v_range=(v0, v1))
        b.finish(col, root)
        return {"collisionProxies": [proxy("pole", (-0.18, 0, -0.18), (0.18, H + 0.12, 0.18))]}

    build.__doc__ = build.__doc__.format(livery=livery)
    return build


def build_pennant(livery):
    field, charge = LIVERY[livery]

    def build(part, col, root):
        """A 4.2 m pole on a stone footing flying a 1.8 m tapering pennant in the {livery} livery from its head,
        streaming toward +X in shallow waves."""
        b = K["Builder"](f"settlement.{part}.mesh")
        H, L, hoist = 4.2, 1.8, 0.45
        flagpole(b, H, "pennant")
        y0 = H - 0.08
        top_f = lambda u: y0 - 0.05 * u
        bottom_f = lambda u: y0 - hoist * (1 - u) - 0.05 * u - 0.01
        wave = lambda u, v: 0.12 * math.sin(u * 2.2 * math.pi) * u
        cloth(b, field, "pennant/field", 0.04, 0.04 + L, top_f, bottom_f, wave, nu=10, nv=2)
        lift, sink = (lambda u, v: wave(u, v) + 0.006), (lambda u, v: wave(u, v) - 0.006)
        for f, s in ((lift, "front"), (sink, "back")):
            cloth(b, charge, f"pennant/hoist-{s}", 0.04, 0.04 + L, top_f, bottom_f, f, nu=2, nv=2, thick=0.002, u_range=(0.0, 0.18), v_range=(0.0, 1.0))
        b.finish(col, root)
        return {"collisionProxies": [proxy("pole", (-0.18, 0, -0.18), (0.18, H + 0.12, 0.18))]}

    build.__doc__ = build.__doc__.format(livery=livery)
    return build


def build_bunting(part, col, root):
    """A market bunting line: two 3.2 m poles 6 m apart along X with a sagging cord between them hung with 18
    triangular flags in red, linen, indigo, ochre and green."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, H = 3.0, 3.2
    for x in (-hw, hw):
        b.block((x - 0.14, 0, -0.14), (x + 0.14, 0.1, 0.14), "stone", 0.02, f"bunting/footing{x}")
        rod(b, (x, 0.1, 0), (x, H, 0), 0.035, 6, "timber", f"bunting/pole{x}")
    cord = lambda x: H - 0.12 - 0.45 * (1 - (x / hw) ** 2)
    n = 24
    pts = [(-hw + 2 * hw * k / n, cord(-hw + 2 * hw * k / n)) for k in range(n + 1)]
    for k, (a, c) in enumerate(zip(pts, pts[1:])):
        b.beam(a, c, 0.012, -0.006, 0.006, "sacking", f"bunting/cord{k}")
    colours = ("dye", "canvas", "indigo", "ochre", "leaf")
    flags = 18
    for k in range(flags):
        x = -hw + 0.25 + (2 * hw - 0.5) * (k + 0.5) / flags
        w, h = 0.24, 0.3
        y = cord(x) - 0.005
        top_f = lambda u, x=x, w=w: cord(x - w / 2 + w * u) - 0.005
        bottom_f = lambda u, x=x, w=w, h=h: cord(x - w / 2 + w * u) - 0.005 - h * (1 - abs(2 * u - 1))
        flutter = lambda u, v, k=k: 0.02 * math.sin(k * 1.3) * v
        cloth(b, colours[k % len(colours)], f"bunting/flag{k}", x - w / 2, x + w / 2, top_f, bottom_f, flutter, nu=2, nv=1)
    b.finish(col, root)
    return {"collisionProxies": [proxy(f"pole{s}", (s * hw - 0.14, 0, -0.14), (s * hw + 0.14, H, 0.14)) for s in (-1, 1)]}


# ---------------------------------------------------------------- farmstead (#695)

CLIP_FPS = 24


def pivoted(b, col, root, pivot):
    """Finish ``b`` as its own node under ``root`` with its origin at the glTF point ``pivot``, so a clip can turn it there."""
    obj = b.finish(col, root)
    p = K["to_blender"](pivot)
    obj.data.transform(Matrix.Translation(-p))
    obj.location = p
    return obj


def loop_clip(name, seconds, tracks, linear=False):
    """One named node-animation clip of ``seconds`` that loops: ``tracks`` is [(node, turn)], where ``turn(t)``
    gives the node's rotation about the glTF X, Y and Z axes (radians) at phase t in [0, 1]. Every ``turn`` must
    be periodic in t, up to whole turns, so the clip's last key equals its first. ``linear`` keys a steady spin
    without easing at the loop seam. One action with a slot per node exports as one glTF animation."""
    action = bpy.data.actions.new(name)
    frames = round(seconds * CLIP_FPS)
    for obj, turn in tracks:
        obj.animation_data_create()
        slot = action.slots.new(id_type="OBJECT", name=obj.name)
        obj.animation_data.action = action
        obj.animation_data.action_slot = slot
        obj.rotation_mode = "XYZ"
        for f in range(0, frames + 1, 2):
            rx, ry, rz = turn(f / frames)
            obj.rotation_euler = (rx, -rz, ry)  # glTF axes to Blender's
            obj.keyframe_insert("rotation_euler", frame=f)
        if linear:
            for fc in anim_utils.action_get_channelbag_for_slot(action, slot).fcurves:
                for key in fc.keyframe_points:
                    key.interpolation = "LINEAR"
    return {"name": name, "duration": round(frames / CLIP_FPS, 6), "nodes": sorted(obj.name for obj, _ in tracks)}


def build_scarecrow(part, col, root):
    """A scarecrow on a 2.2 m cross pole: a patched coat with a rope belt, a stitched sacking head, straw at the
    cuffs and hem, and a wide straw hat. Its sleeves and hat are their own nodes, which ``Sway_Loop`` (4 s) flutters."""
    b = K["Builder"](f"settlement.{part}.mesh")
    lathe(b, [(0, 0.3), (0.05, 0.22), (0.08, 0)], 9, "soil", "scarecrow/mound", jitter=0.12)
    b.block((-0.045, 0, -0.045), (0.045, 2.0, 0.045), "timber", key="scarecrow/pole", grain=(0, 1, 0))
    b.block((-0.72, 1.5, -0.035), (0.72, 1.57, 0.035), "timber", key="scarecrow/crossbar", grain=(1, 0, 0))
    lathe(b, [(0.82, 0.3), (0.86, 0.28), (1.1, 0.2), (1.12, 0.17), (1.35, 0.2), (1.55, 0.22), (1.6, 0.12), (1.64, 0.06)],
          10, "dye", "scarecrow/coat", cap_mat="straw", jitter=0.07)
    lathe(b, [(1.08, 0.19), (1.13, 0.19)], 10, "sacking", "scarecrow/belt")
    b.box((-0.16, 1.2, 0.18), (-0.04, 1.34, 0.215), "canvas", "scarecrow/patch")
    for k in range(7):  # straw hanging under the hem
        a = 2 * math.pi * (k + rnd("hem", k)) / 7
        placed(b, Matrix.Translation((0.25 * math.cos(a), 0.83, -0.25 * math.sin(a))),
               lambda k=k: lathe(b, [(-0.12 - 0.06 * rnd("hem-l", k), 0), (0, 0.05)], 4, "straw", f"scarecrow/hem{k}"))
    lathe(b, [(1.62, 0.05), (1.68, 0.11), (1.78, 0.14), (1.88, 0.12), (1.95, 0.06), (1.97, 0)], 9, "sacking", "scarecrow/head", jitter=0.06)
    for s in (-1, 1):
        b.box((s * 0.05 - 0.018, 1.8, 0.128), (s * 0.05 + 0.018, 1.82, 0.142), "soot", f"scarecrow/eye{s}")
    b.box((-0.05, 1.71, 0.125), (0.05, 1.725, 0.138), "soot", "scarecrow/mouth")
    b.finish(col, root)

    sleeves = []
    for s, side in ((-1, "left"), (1, "right")):
        sb = K["Builder"](f"settlement.{part}.sleeve-{side}")
        turn = Matrix.Translation((s * 0.16, 1.535, 0)) @ Matrix.Rotation(-s * math.pi / 2, 4, "Z") @ Matrix.Rotation(-0.08, 4, "X")
        placed(sb, turn, lambda sb=sb, side=side: lathe(sb, [(0, 0.1), (0.3, 0.09), (0.52, 0.11)], 8, "dye", f"scarecrow/sleeve-{side}", cap_mat="straw", jitter=0.06))
        placed(sb, turn, lambda sb=sb, side=side: lathe(sb, [(0.5, 0.08), (0.64, 0)], 5, "straw", f"scarecrow/cuff-{side}", jitter=0.2))
        sleeves.append((pivoted(sb, col, root, (s * 0.16, 1.535, 0)), s))
    hb = K["Builder"](f"settlement.{part}.hat")
    lathe(hb, [(1.9, 0), (1.9, 0.29), (1.925, 0.3), (1.94, 0.13), (2.06, 0.11), (2.09, 0.08), (2.1, 0)], 12, "straw", "scarecrow/hat", jitter=0.04)
    lathe(hb, [(1.94, 0.132), (1.98, 0.125)], 12, "dye", "scarecrow/hat-band")
    hat = pivoted(hb, col, root, (0, 1.9, 0))
    tau = 2 * math.pi
    clip = loop_clip("Sway_Loop", 4.0, [
        *[(obj, lambda t, s=s: (0.22 * math.sin(tau * t + (0.0 if s < 0 else 1.9)) + 0.07 * math.sin(3 * tau * t + s),
                                0.0, s * 0.1 * math.sin(2 * tau * t + 0.7 * s))) for obj, s in sleeves],
        (hat, lambda t: (0.05 * math.sin(2 * tau * t + 0.4), 0.04 * math.sin(tau * t), 0.07 * math.sin(tau * t + 1.1))),
    ])
    return {"clips": [clip],
            "collisionProxies": [proxy("pole", (-0.06, 0, -0.06), (0.06, 2.0, 0.06)), proxy("body", (-0.25, 0.85, -0.25), (0.25, 1.97, 0.25))]}


GLYPHS = {  # compass letters as strokes in a 0.6 x 1 cell
    "N": [((0, 0), (0, 1)), ((0, 1), (0.6, 0)), ((0.6, 0), (0.6, 1))],
    "E": [((0, 0), (0, 1)), ((0, 1), (0.55, 1)), ((0, 0.5), (0.45, 0.5)), ((0, 0), (0.55, 0))],
    "S": [((0.6, 1), (0, 1)), ((0, 1), (0, 0.5)), ((0, 0.5), (0.6, 0.5)), ((0.6, 0.5), (0.6, 0)), ((0.6, 0), (0, 0))],
    "W": [((0, 1), (0.15, 0)), ((0.15, 0), (0.3, 0.6)), ((0.3, 0.6), (0.45, 0)), ((0.45, 0), (0.6, 1))],
}


def build_weather_vane(part, col, root):
    """A rooster weather vane for a roof ridge or a post top: an iron spindle on a 0.2 m mounting plate, compass
    arms lettered N (-Z), E (+X), S (+Z) and W (-X), and a gilt rooster on an arrow, which ``Turn_Loop`` (8 s)
    veers slowly back and forth about the spindle. The origin is the foot of the plate."""
    b = K["Builder"](f"settlement.{part}.mesh")
    b.block((-0.1, 0, -0.1), (0.1, 0.03, 0.1), "iron", key="vane/plate")
    rod(b, (0, 0.03, 0), (0, 1.0, 0), 0.016, 6, "iron", "vane/spindle")
    lathe(b, [(0.7, 0), (0.72, 0.035), (0.76, 0.04), (0.8, 0.035), (0.82, 0)], 8, "iron", "vane/collar")
    arm = 0.34
    rod(b, (-arm, 0.76, 0), (arm, 0.76, 0), 0.008, 4, "iron", "vane/arm-x")
    rod(b, (0, 0.76, -arm), (0, 0.76, arm), 0.008, 4, "iron", "vane/arm-z")
    for letter, yaw, end in (("N", math.pi, (0, 0.76, -arm)), ("E", math.pi / 2, (arm, 0.76, 0)), ("S", 0.0, (0, 0.76, arm)), ("W", -math.pi / 2, (-arm, 0.76, 0))):
        placed(b, Matrix.Translation(end), lambda letter=letter: lathe(b, [(-0.02, 0), (-0.014, 0.016), (0.014, 0.016), (0.02, 0)], 6, "iron", f"vane/ball-{letter}"))
        def glyph(letter=letter):
            for k, (a, c) in enumerate(GLYPHS[letter]):
                b.beam((a[0] * 0.1 - 0.03, a[1] * 0.1), (c[0] * 0.1 - 0.03, c[1] * 0.1), 0.012, -0.004, 0.004, "iron", f"vane/{letter}{k}")
        placed(b, Matrix.Translation((end[0] * 0.85, 0.78, end[2] * 0.85)) @ Matrix.Rotation(yaw, 4, "Y"), glyph)
    b.finish(col, root)

    vb = K["Builder"](f"settlement.{part}.vane")
    lathe(vb, [(0.96, 0.024), (1.08, 0.024), (1.1, 0)], 8, "iron", "vane/sleeve")
    rod(vb, (-0.42, 1.06, 0), (0.42, 1.06, 0), 0.01, 5, "iron", "vane/arrow")
    vb.prism([(0.42, 1.0), (0.58, 1.06), (0.42, 1.12)], -0.005, 0.005, "iron", "vane/head")
    vb.prism([(-0.62, 0.96), (-0.4, 1.04), (-0.4, 1.08), (-0.62, 1.16), (-0.55, 1.06)], -0.005, 0.005, "ochre", "vane/tail")
    rooster = [(-0.03, 0.0), (0.03, 0.0), (0.04, 0.06), (0.12, 0.1), (0.15, 0.17), (0.14, 0.24), (0.17, 0.29), (0.22, 0.28),
               (0.17, 0.31), (0.16, 0.35), (0.13, 0.37), (0.11, 0.34), (0.09, 0.36), (0.07, 0.31), (0.06, 0.22), (-0.02, 0.17),
               (-0.1, 0.3), (-0.18, 0.37), (-0.17, 0.26), (-0.21, 0.24), (-0.14, 0.14), (-0.08, 0.07), (-0.04, 0.06)]
    vb.prism([(x * 1.25, 1.065 + y * 1.25) for x, y in rooster], -0.006, 0.006, "ochre", "vane/rooster")
    vane = pivoted(vb, col, root, (0, 1.0, 0))
    tau = 2 * math.pi
    clip = loop_clip("Turn_Loop", 8.0, [(vane, lambda t: (0.0, 0.55 * math.sin(tau * t) + 0.15 * math.sin(3 * tau * t + 0.7), 0.0))])
    return {"clips": [clip], "collisionProxies": [proxy("spindle", (-0.1, 0, -0.1), (0.1, 1.0, 0.1))]}


def build_beehive_skeps(part, col, root):
    """Three coiled straw skeps on a plank bench, each with an entrance at its foot facing +Z; the middle one wears a straw hackle."""
    b = K["Builder"](f"settlement.{part}.mesh")
    top = 0.46
    b.block((-0.7, top - 0.05, -0.2), (0.7, top, 0.2), "wood", key="skeps/bench", grain=(1, 0, 0))
    for s in (-1, 1):
        b.block((s * 0.55 - 0.05, 0, -0.18), (s * 0.55 + 0.05, top - 0.05, 0.18), "timber", key=f"skeps/leg{s}", grain=(0, 1, 0))
    b.block((-0.5, 0.12, -0.03), (0.5, 0.18, 0.03), "timber", key="skeps/stretcher", grain=(1, 0, 0))
    for k, x in enumerate((-0.46, 0.0, 0.46)):
        R, H = 0.19 + 0.02 * rnd("skep-r", k), 0.38 + 0.05 * rnd("skep-h", k)
        rings = [(0, R * 0.95)]
        for i in range(1, 9):
            y = H * i / 9.5
            rings.append((y, R * math.sqrt(1 - (y / H) ** 2) * (1.0 + 0.05 * (i % 2))))
        rings += [(H, R * 0.12), (H + 0.01, 0)]
        placed(b, Matrix.Translation((x, top, 0)), lambda rings=rings, k=k: lathe(b, rings, 10, "straw", f"skeps/skep{k}", phase=rnd("skep-p", k)))
        b.box((x - 0.045, top, R * 0.9), (x + 0.045, top + 0.045, R * 0.97), "soot", f"skeps/entrance{k}")
        if k == 1:
            placed(b, Matrix.Translation((x, top + H * 0.72, 0)), lambda R=R, H=H: lathe(b, [(0, R * 0.78), (0.03, R * 0.74), (H * 0.42, 0)], 8, "straw", "skeps/hackle", jitter=0.1))
    b.finish(col, root)
    return {"collisionProxies": [proxy("bench", (-0.7, 0, -0.22), (0.7, top + 0.45, 0.22))]}


def build_water_trough(part, col, root):
    """A hewn stone trough, 1.6 x 0.62 m and 0.55 m high, half full of dark water."""
    b = K["Builder"](f"settlement.{part}.mesh")
    L, W, H, t = 0.8, 0.31, 0.55, 0.1
    b.block((-L, 0, -W), (L, 0.14, W), "monolith", key="trough/bottom", chamfer=0.03)
    for s in (-1, 1):
        b.block((-L, 0.1, s * W - (t if s > 0 else 0)), (L, H, s * W + (t if s < 0 else 0)), "monolith", key=f"trough/side{s}", chamfer=0.03)
        b.block((s * L - (t if s > 0 else 0), 0.1, -W + t), (s * L + (t if s < 0 else 0), H, W - t), "monolith", key=f"trough/end{s}", chamfer=0.03)
    b.quad([(-L + t, 0.34, W - t), (L - t, 0.34, W - t), (L - t, 0.34, -W + t), (-L + t, 0.34, -W + t)], "soot", "trough/water")
    b.finish(col, root)
    return {"collisionProxies": [proxy("trough", (-L, 0, -W), (L, H, W))]}


def build_feed_trough(part, col, root):
    """A low plank trough on splayed trestle legs for pigs and sheep, 1.5 m along X, its rim 0.44 m up, with mash in the bottom."""
    b = K["Builder"](f"settlement.{part}.mesh")
    def trough():  # drawn with x as depth and z as length, then turned to run along X
        b.box((-0.11, 0.2, -0.72), (0.11, 0.24, 0.72), "wood", "feed/bottom", grain=(0, 0, 1))
        for s in (-1, 1):
            b.beam((s * 0.1, 0.22), (s * 0.25, 0.44), 0.03, -0.72, 0.72, "wood", f"feed/side{s}")
            b.prism([(-0.12, 0.18), (0.12, 0.18), (0.28, 0.45), (-0.28, 0.45)], s * 0.75 - 0.03 * (s > 0), s * 0.75 + 0.03 * (s < 0), "timber", f"feed/end{s}")
            for side in (-1, 1):
                b.prism([(side * x, y) for x, y in ((0.06, 0.2), (0.22, 0.0), (0.27, 0.0), (0.11, 0.2))], s * 0.58 - 0.025, s * 0.58 + 0.025, "timber", f"feed/leg{s}{side}")
        b.box((-0.1, 0.24, -0.7), (0.1, 0.29, 0.7), "straw", "feed/mash", grain=(0, 0, 1))
    placed(b, Matrix.Rotation(math.pi / 2, 4, "Y"), trough)
    b.finish(col, root)
    return {"collisionProxies": [proxy("trough", (-0.78, 0, -0.28), (0.78, 0.45, 0.28))]}


def build_hen_coop(part, col, root):
    """A small hen coop raised on four legs: a plank house under a shingle gable (ridge along X), a pop hole to +Z
    and a cleated ramp down to the ground in front."""
    b = K["Builder"](f"settlement.{part}.mesh")
    oz = -0.33  # centres the footprint, ramp included
    def coop():
        for x in (-0.47, 0.41):
            for z in (-0.32, 0.26):
                b.block((x, 0, z), (x + 0.06, 1.05, z + 0.06), "timber", key=f"coop/leg{x}{z}", grain=(0, 1, 0))
        b.box((-0.5, 0.45, -0.35), (0.5, 0.5, 0.35), "timber", "coop/floor")
        b.box((-0.48, 0.5, -0.33), (0.48, 1.05, 0.33), "wood", "coop/walls", grain=(1, 0, 0))
        b.box((0.12, 0.5, 0.33), (0.34, 0.76, 0.34), "soot", "coop/pop-hole")
        b.box((-0.36, 0.62, 0.33), (-0.06, 0.9, 0.345), "wood", "coop/hatch", grain=(0, 1, 0))
        for k, y in enumerate((0.64, 0.88)):
            b.box((-0.36, y, 0.345), (-0.06, y + 0.02, 0.355), "iron", f"coop/hinge{k}")
        ridge, eave, reach = 1.36, 1.0, 0.46
        def roof():  # ridge along Z, turned to run along X
            for s in (-1, 1):
                b.beam((s * reach, eave), (0, ridge), 0.04, -0.56, 0.56, "shingle", f"coop/roof{s}")
                b.prism([(-0.33, 1.05), (0.33, 1.05), (0, 1.33)], s * 0.48 - 0.02 * (s > 0), s * 0.48 + 0.02 * (s < 0), "wood", f"coop/gable{s}")
            b.box((-0.04, ridge - 0.02, -0.58), (0.04, ridge + 0.04, 0.58), "timber", "coop/ridge", grain=(0, 0, 1))
        placed(b, Matrix.Rotation(math.pi / 2, 4, "Y"), roof)
        length, angle = math.hypot(0.5, 0.75), math.atan2(0.5, 0.75)
        def ramp():
            b.box((-0.11, -0.025, 0), (0.11, 0, length), "wood", "coop/ramp", grain=(0, 0, 1))
            for k in range(1, 6):
                b.box((-0.1, 0, k * 0.15), (0.1, 0.02, k * 0.15 + 0.03), "timber", f"coop/cleat{k}")
        placed(b, Matrix.Translation((0.23, 0.5 + 0.025 * math.cos(angle), 0.35)) @ Matrix.Rotation(angle, 4, "X"), ramp)
    placed(b, Matrix.Translation((0, 0, oz)), coop)
    b.finish(col, root)
    return {"collisionProxies": [proxy("coop", (-0.5, 0, -0.47 + oz), (0.5, 1.4, 0.47 + oz)),
                                 proxy("ramp", (0.12, 0, 0.35 + oz), (0.34, 0.5, 1.12 + oz))]}


def build_plough(part, col, root):
    """A wooden mouldboard plough along Z, resting level: a beam on a small front wheel (+Z) with a hitch ring, an
    iron coulter and share, a curved board turning the furrow to +X, and two handles reaching back (-Z) with a rung."""
    b = K["Builder"](f"settlement.{part}.mesh")
    oz = -0.21  # centres the footprint
    def plough():
        b.block((-0.05, 0, -0.55), (0.05, 0.08, 0.28), "timber", key="plough/sole", grain=(0, 0, 1))
        b.block((-0.07, 0, 0.26), (0.07, 0.06, 0.42), "iron", key="plough/share")
        placed(b, Matrix.Translation((0, 0.03, 0.42)) @ Matrix.Rotation(math.pi / 2, 4, "X"), lambda: lathe(b, [(0, 0.03), (0.14, 0)], 4, "iron", "plough/point", phase=math.pi / 4))
        verts, polys = [], []
        for i in range(5):  # the mouldboard twists out to +X as it runs back
            u = i / 4
            for v in (0.0, 1.0):
                verts.append((0.05 + 0.24 * u * (0.35 + 0.65 * v), 0.04 + 0.34 * v, 0.36 - 0.75 * u))
        polys = [[2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1] for i in range(4)]
        b.faces(verts, polys, "wood", "plough/mouldboard", grain=(0, 0, 1))
        b.faces([(x - 0.015, y, z) for x, y, z in verts], [q[::-1] for q in polys], "wood", "plough/mouldboard-back", grain=(0, 0, 1))
        b.block((-0.045, 0.06, 0.02), (0.045, 0.42, 0.14), "timber", key="plough/sheath", grain=(0, 1, 0))
        rod(b, (0, 0.33, -0.62), (0, 0.5, 1.44), 0.05, 6, "timber", "plough/beam", "endgrain")
        rod(b, (0, 0.44, 0.62), (0, 0.06, 0.46), 0.018, 4, "iron", "plough/coulter")
        for s in (-1, 1):
            rod(b, (s * 0.05, 0.06, -0.5), (s * 0.3, 0.92, -1.15), 0.028, 6, "timber", f"plough/handle{s}")
            b.block((s * 0.07 - 0.02, 0.0, 1.4), (s * 0.07 + 0.02, 0.5, 1.46), "timber", key=f"plough/fork{s}", grain=(0, 1, 0))
        rod(b, (-0.21, 0.62, -0.92), (0.21, 0.62, -0.92), 0.02, 5, "timber", "plough/rung")
        def wheel():
            ring(b, 0.19, 0.23, -0.025, 0.025, 12, "timber", "plough/rim")
            for k in range(3):
                a = math.pi * k / 3
                b.beam((-0.2 * math.cos(a), -0.2 * math.sin(a)), (0.2 * math.cos(a), 0.2 * math.sin(a)), 0.03, -0.015, 0.015, "wood", f"plough/spoke{k}")
        placed(b, Matrix.Translation((0, 0.23, 1.43)) @ Matrix.Rotation(math.pi / 2, 4, "Y"), wheel)
        rod(b, (-0.1, 0.23, 1.43), (0.1, 0.23, 1.43), 0.02, 6, "iron", "plough/axle")
        placed(b, Matrix.Translation((0, 0.5, 1.6)) @ Matrix.Rotation(math.pi / 2, 4, "Y"), lambda: ring(b, 0.035, 0.05, -0.008, 0.008, 8, "iron", "plough/hitch"))
    placed(b, Matrix.Translation((0, 0, oz)), plough)
    b.finish(col, root)
    return {"collisionProxies": [proxy("plough", (-0.33, 0, -1.18 + oz), (0.33, 0.95, 1.66 + oz))]}


# ---------------------------------------------------------------- village machinery (#699)

def glow(name):
    """Make the kit material ``name`` emissive in its ``EMISSIVE`` colour (the glTF ``emissiveFactor``)."""
    bsdf = next(n for n in bpy.data.materials[f"outpost-{name}"].node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in EMISSIVE[name]]
    bsdf.inputs["Emission Color"].default_value = (*linear, 1)
    bsdf.inputs["Emission Strength"].default_value = 1.0


def two_sided_loft(b, lower, upper, mat, key, thickness=0.05):
    """A hood or a funnel: the sides between two rings of glTF corners (same count, open ends), with an inner skin
    ``thickness`` in from the outer one so it reads from inside too."""
    n = len(lower)
    def skin(rings, inward):
        verts = [p for ring_ in rings for p in ring_]
        cx, cz = sum(p[0] for p in verts) / len(verts), sum(p[2] for p in verts) / len(verts)
        polys = []
        for i in range(n):
            q = [i, (i + 1) % n, n + (i + 1) % n, n + i]
            a, c, d = (Vector(verts[q[k]]) for k in (0, 1, 3))
            mid = sum((Vector(verts[k]) for k in q), Vector()) / 4
            if ((c - a).cross(d - a)).dot(mid - Vector((cx, mid.y, cz))) < 0:
                q.reverse()
            polys.append(q[::-1] if inward else q)
        b.faces(verts, polys, mat, key)
    skin((lower, upper), False)
    def shrink(ring_):
        cx, cz = sum(p[0] for p in ring_) / n, sum(p[2] for p in ring_) / n
        out = []
        for x, y, z in ring_:
            d = math.hypot(x - cx, z - cz)
            out.append((cx + (x - cx) * (1 - thickness / d), y, cz + (z - cz) * (1 - thickness / d)))
        return out
    skin((shrink(lower), shrink(upper)), True)


def mill_wheel(b, center, radius, width, key, floats=12, spokes=6):
    """An undershot mill wheel on an axle along X through ``center``: two spoked rims ``width`` apart joined by
    ``floats`` radial paddles, which reach ``radius`` + 0.12."""
    def make():  # drawn in XY with the axle along Z, then turned
        for s in (-1, 1):
            z = s * width / 2
            ring(b, radius - 0.1, radius, z - 0.035, z + 0.035, 16, "wood", f"{key}/rim{s}")
            for k in range(spokes):
                a = 2 * math.pi * k / spokes
                b.beam((0.12 * math.cos(a), 0.12 * math.sin(a)), ((radius - 0.06) * math.cos(a), (radius - 0.06) * math.sin(a)),
                       0.07, z - 0.025, z + 0.025, "timber", f"{key}/spoke{s}{k}")
        for k in range(floats):
            a = 2 * math.pi * (k + 0.5) / floats
            b.beam(((radius - 0.32) * math.cos(a), (radius - 0.32) * math.sin(a)), ((radius + 0.12) * math.cos(a), (radius + 0.12) * math.sin(a)),
                   0.035, -width / 2 - 0.04, width / 2 + 0.04, "wood", f"{key}/float{k}")
        placed(b, Matrix.Translation((0, 0, -width / 2 - 0.12)) @ Matrix.Rotation(math.pi / 2, 4, "X"),
               lambda: lathe(b, [(0, 0.15), (width + 0.24, 0.15)], 8, "timber", f"{key}/hub", "endgrain"))
    placed(b, Matrix.Translation(Vector(center)) @ Matrix.Rotation(math.pi / 2, 4, "Y"), make)


def bearing_post(b, x, hub, key):
    """A braced timber post on a sill along Z, its bearing block carrying an axle along X at height ``hub``."""
    b.block((x - 0.08, 0, -0.9), (x + 0.08, 0.16, 0.9), "timber", key=f"{key}/sill", grain=(0, 0, 1))
    b.block((x - 0.07, 0.16, -0.07), (x + 0.07, hub - 0.15, 0.07), "timber", key=f"{key}/post", grain=(0, 1, 0))
    for side in (-1, 1):
        rod(b, (x, 0.16, side * 0.75), (x, hub - 0.5, side * 0.05), 0.04, 5, "timber", f"{key}/brace{side}")
    b.block((x - 0.1, hub - 0.17, -0.13), (x + 0.1, hub - 0.07, 0.13), "timber", key=f"{key}/bearing", grain=(0, 0, 1))


def build_water_wheel(part, col, root):
    """An undershot water wheel to set into a stream beside a building: a 2.7 m wheel of twelve floats on a timber
    axle between two braced bearing posts on sills along Z. The wheel and its axle are one node, which ``Turn_Loop``
    (6 s a turn) turns about the axle (X), the floats at the bottom moving to +Z, downstream. The floats reach the
    ground plane, so set the origin at the stream's water line."""
    b = K["Builder"](f"settlement.{part}.mesh")
    R, w = 1.25, 0.6
    hub, px = R + 0.12, w / 2 + 0.28
    for s in (-1, 1):
        bearing_post(b, s * px, hub, f"wheel/post{s}")
    b.finish(col, root)
    wb = K["Builder"](f"settlement.{part}.wheel")
    mill_wheel(wb, (0, hub, 0), R, w, "wheel")
    rod(wb, (-px - 0.18, hub, 0), (px + 0.18, hub, 0), 0.07, 8, "timber", "wheel/axle", "endgrain")
    wheel = pivoted(wb, col, root, (0, hub, 0))
    clip = loop_clip("Turn_Loop", 6.0, [(wheel, lambda t: (-2 * math.pi * t, 0.0, 0.0))], linear=True)
    return {"clips": [clip], "collisionProxies": [proxy(f"post-{side}", (s * px - 0.1, 0, -0.9), (s * px + 0.1, hub, 0.9)) for s, side in ((-1, "left"), (1, "right"))]
            + [proxy("wheel", (-w / 2 - 0.04, 0, -hub), (w / 2 + 0.04, 2 * hub, hub))]}


def build_watermill(part, col, root):
    """A timber watermill: a plank mill house in a braced frame on a stone footing under a shingle gable (ridge
    along X), with a door, steps and a shuttered window to +Z and sacks by the door, and an undershot wheel on its
    +X side between the wall and an outer bearing post. The wheel and its axle are one node, which ``Turn_Loop``
    (6 s a turn) turns about the axle (X), the floats at the bottom moving to +Z, downstream."""
    b = K["Builder"](f"settlement.{part}.mesh")
    hw, hd, plinth, eave, ridge = 1.9, 1.6, 0.45, 2.9, 4.4
    R, w = 1.35, 0.55
    hub = R + 0.12
    wx = hw + 0.3 + w / 2  # the wheel's centre
    post_x = wx + w / 2 + 0.3
    ox = -((post_x + 0.18) + (-hw - 0.3)) / 2  # centres the footprint, from the roof's overhang to the axle's end
    def house():
        b.block((-hw - 0.08, 0, -hd - 0.08), (hw + 0.08, plinth, hd + 0.08), "stone", 0.03, "mill/footing")
        b.box((-hw, plinth, -hd), (hw, eave, hd), "wood", "mill/walls", grain=(0, 1, 0))
        for sx in (-1, 1):
            for sz in (-1, 1):
                b.block((sx * hw - 0.09, plinth, sz * hd - 0.09), (sx * hw + 0.09, eave, sz * hd + 0.09), "timber", key=f"mill/corner{sx}{sz}", grain=(0, 1, 0))
        for y in (plinth, 1.62, eave - 0.14):
            for s in (-1, 1):
                b.block((-hw, y, s * hd - 0.05), (hw, y + 0.14, s * hd + 0.05), "timber", key=f"mill/rail-z{s}{y}", grain=(1, 0, 0))
                b.block((s * hw - 0.05, y, -hd), (s * hw + 0.05, y + 0.14, hd), "timber", key=f"mill/rail-x{s}{y}", grain=(0, 0, 1))
        for s in (-1, 1):  # braces in the long walls
            for x0, x1 in ((-hw + 0.1, -hw + 0.9), (hw - 0.1, hw - 0.9)):
                placed(b, Matrix.Translation((0, 0, s * (hd + 0.03))), lambda x0=x0, x1=x1, s=s: b.beam((x0, 1.76), (x1, eave - 0.14), 0.1, -0.03, 0.03, "timber", f"mill/brace{s}{x0}"))
        b.box((-1.0, plinth, hd + 0.02), (-0.2, 2.25, hd + 0.07), "timber", "mill/door", grain=(0, 1, 0))
        for k, y in enumerate((0.75, 1.9)):
            b.box((-0.98, y, hd + 0.07), (-0.45, y + 0.05, hd + 0.085), "iron", f"mill/hinge{k}")
        b.block((-1.15, 0, hd + 0.08), (-0.05, 0.22, hd + 0.62), "stone", 0.02, "mill/step-low")
        b.block((-1.15, 0.22, hd + 0.08), (-0.05, plinth, hd + 0.34), "stone", 0.02, "mill/step-high")
        b.box((0.6, 1.5, hd + 0.02), (1.2, 2.1, hd + 0.04), "soot", "mill/window")
        b.box((0.55, 1.44, hd + 0.02), (1.25, 1.5, hd + 0.14), "timber", "mill/sill")
        for s, x in ((-1, 0.6), (1, 1.2)):
            b.box((x + (s - 1) * 0.15, 1.5, hd + 0.05), (x + (s + 1) * 0.15, 2.1, hd + 0.09), "wood", f"mill/shutter{s}", grain=(0, 1, 0))
        b.box((-hw - 0.02, 1.6, -0.35), (-hw - 0.01, 2.1, 0.35), "soot", "mill/end-window")
        for k, x in enumerate((0.15, 0.52)):
            sack(b, (x, 0, hd + 0.32 + 0.06 * k), 0.19, 0.55, f"mill/sack{k}")
        reach = hd + 0.35
        def roof():  # ridge along Z, turned to run along X
            for s in (-1, 1):
                b.beam((s * reach, eave - 0.25), (0, ridge), 0.07, -hw - 0.3, hw + 0.3, "shingle", f"mill/roof{s}")
                b.prism([(-hd, eave), (hd, eave), (0, ridge - 0.05)], s * hw - 0.04 * (s > 0), s * hw + 0.04 * (s < 0), "wood", f"mill/gable{s}")
            b.box((-0.06, ridge - 0.03, -hw - 0.32), (0.06, ridge + 0.06, hw + 0.32), "timber", "mill/ridge", grain=(0, 0, 1))
        placed(b, Matrix.Rotation(math.pi / 2, 4, "Y"), roof)
        b.block((hw, hub - 0.17, -0.15), (hw + 0.14, hub - 0.07, 0.15), "timber", key="mill/wall-bearing", grain=(0, 0, 1))
        bearing_post(b, post_x, hub, "mill/post")
    placed(b, Matrix.Translation((ox, 0, 0)), house)
    b.finish(col, root)
    wb = K["Builder"](f"settlement.{part}.wheel")
    mill_wheel(wb, (wx + ox, hub, 0), R, w, "mill-wheel")
    rod(wb, (hw - 0.1 + ox, hub, 0), (post_x + 0.18 + ox, hub, 0), 0.07, 8, "timber", "mill/axle", "endgrain")
    wheel = pivoted(wb, col, root, (wx + ox, hub, 0))
    clip = loop_clip("Turn_Loop", 6.0, [(wheel, lambda t: (-2 * math.pi * t, 0.0, 0.0))], linear=True)
    return {"clips": [clip],
            "collisionProxies": [proxy("house", (-hw - 0.08 + ox, 0, -hd - 0.08), (hw + 0.08 + ox, ridge, hd + 0.08)),
                                 proxy("steps", (-1.15 + ox, 0, hd + 0.08), (-0.05 + ox, plinth, hd + 0.62)),
                                 proxy("wheel", (wx - w / 2 - 0.04 + ox, 0, -0.9), (post_x + 0.1 + ox, 2 * hub, 0.9))]}


def build_windmill(part, col, root):
    """A small post mill: a weatherboarded body under a shingle gable (ridge along Z) on a crown tree, turning on a
    main post braced by four quarter bars from crossed sills on stone piers, a door and ladder to the back (-Z) and
    four lattice sails with canvas on a windshaft to the front (+Z). The sails, shaft and hub are one node, which
    ``Turn_Loop`` (8 s a turn) turns about the shaft (Z), anticlockwise seen from the front."""
    b = K["Builder"](f"settlement.{part}.mesh")
    y0, y1, ridge = 3.2, 6.0, 6.8
    bw, bd = 1.15, 1.45
    hub_y, hub_z, arm = 5.4, 2.05, 4.4
    ladder_z = -3.1
    oz = -(ladder_z + hub_z + 0.25) / 2  # centres the footprint, from the ladder's foot to the hub
    def mill():
        for k, (x, z) in enumerate(((-1.3, 0), (1.3, 0), (0, -1.3), (0, 1.3))):
            b.block((x - 0.22, 0, z - 0.22), (x + 0.22, 0.4, z + 0.22), "stone", 0.03, f"windmill/pier{k}")
        b.block((-1.45, 0.4, -0.13), (1.45, 0.64, 0.13), "timber", key="windmill/sill-x", grain=(1, 0, 0))
        b.block((-0.13, 0.4, -1.45), (0.13, 0.64, 1.45), "timber", key="windmill/sill-z", grain=(0, 0, 1))
        b.block((-0.18, 0.64, -0.18), (0.18, y0 - 0.25, 0.18), "timber", key="windmill/post", grain=(0, 1, 0))
        for k, (x, z) in enumerate(((-1, 0), (1, 0), (0, -1), (0, 1))):
            rod(b, (1.2 * x, 0.6, 1.2 * z), (0.17 * x, 2.1, 0.17 * z), 0.07, 6, "timber", f"windmill/quarter-bar{k}")
        b.block((-1.25, y0 - 0.25, -0.2), (1.25, y0, 0.2), "timber", key="windmill/crown-tree", grain=(1, 0, 0))
        b.box((-bw, y0, -bd), (bw, y1, bd), "wood", "windmill/body", grain=(0, 1, 0))
        for sx in (-1, 1):
            for sz in (-1, 1):
                b.block((sx * bw - 0.08, y0 - 0.05, sz * bd - 0.08), (sx * bw + 0.08, y1, sz * bd + 0.08), "timber", key=f"windmill/corner{sx}{sz}", grain=(0, 1, 0))
        for y in (y0, y1 - 0.14):
            for s in (-1, 1):
                b.block((-bw, y, s * bd - 0.05), (bw, y + 0.14, s * bd + 0.05), "timber", key=f"windmill/rail-z{s}{y}", grain=(1, 0, 0))
                b.block((s * bw - 0.05, y, -bd), (s * bw + 0.05, y + 0.14, bd), "timber", key=f"windmill/rail-x{s}{y}", grain=(0, 0, 1))
        b.box((-0.4, y0 + 0.14, -bd - 0.06), (0.4, y0 + 1.95, -bd - 0.01), "timber", "windmill/door", grain=(0, 1, 0))
        for s in (-1, 1):
            b.box((s * (bw + 0.01) - 0.01, 4.7, -0.3), (s * (bw + 0.01) + 0.01, 5.2, 0.2), "soot", f"windmill/window{s}")
        b.block((-0.6, hub_y - 0.3, bd), (0.6, hub_y - 0.16, bd + 0.16), "timber", key="windmill/breast-beam", grain=(1, 0, 0))
        for s in (-1, 1):
            b.beam((s * (bw + 0.25), y1 - 0.15), (0, ridge), 0.07, -bd - 0.2, bd + 0.2, "shingle", f"windmill/roof{s}")
            b.prism([(-bw, y1), (bw, y1), (0, ridge - 0.05)], s * bd - 0.04 * (s > 0), s * bd + 0.04 * (s < 0), "wood", f"windmill/gable{s}")
        b.box((-0.06, ridge - 0.03, -bd - 0.22), (0.06, ridge + 0.06, bd + 0.22), "timber", "windmill/ridge", grain=(0, 0, 1))
        for s in (-1, 1):
            rod(b, (s * 0.32, 0.04, ladder_z), (s * 0.32, y0 + 0.05, -bd - 0.05), 0.04, 5, "timber", f"windmill/stringer{s}")
        for k in range(1, 10):
            u = k / 10
            y, z = u * (y0 + 0.05), ladder_z + u * (-bd - 0.05 - ladder_z)
            b.box((-0.32, y - 0.02, z - 0.08), (0.32, y + 0.02, z + 0.08), "wood", f"windmill/tread{k}", grain=(1, 0, 0))
    placed(b, Matrix.Translation((0, 0, oz)), mill)
    b.finish(col, root)

    sb = K["Builder"](f"settlement.{part}.sails")
    def sails():  # about the hub, the shaft along Z
        rod(sb, (0, 0, bd - 0.2 - hub_z), (0, 0, 0.0), 0.13, 8, "timber", "windmill/shaft", "endgrain")
        placed(sb, Matrix.Rotation(math.pi / 2, 4, "X"), lambda: lathe(sb, [(-0.02, 0.22), (0.24, 0.22), (0.3, 0.12), (0.32, 0)], 8, "timber", "windmill/hub", "iron"))
        for k in range(4):
            def stock(k=k):
                sb.block((-0.07, 0.18, 0.1), (0.07, arm, 0.22), "timber", key=f"windmill/stock{k}", grain=(0, 1, 0))
                sb.box((0.07, 1.0, 0.13), (0.8, arm - 0.1, 0.15), "canvas", f"windmill/sail{k}", grain=(0, 1, 0))
                sb.box((0.8, 0.95, 0.12), (0.86, arm - 0.05, 0.2), "timber", f"windmill/hemlath{k}", grain=(0, 1, 0))
                for i in range(7):
                    y = 1.0 + (arm - 1.1) * i / 6
                    sb.box((0.0, y - 0.025, 0.15), (0.86, y + 0.025, 0.19), "timber", f"windmill/bar{k}{i}")
            placed(sb, Matrix.Rotation(k * math.pi / 2 + math.pi / 4, 4, "Z"), stock)
    placed(sb, Matrix.Translation((0, hub_y, hub_z + oz)), sails)
    sails_node = pivoted(sb, col, root, (0, hub_y, hub_z + oz))
    clip = loop_clip("Turn_Loop", 8.0, [(sails_node, lambda t: (0.0, 0.0, 2 * math.pi * t))], linear=True)
    return {"clips": [clip],
            "collisionProxies": [proxy("trestle", (-1.52, 0, -1.52 + oz), (1.52, y0, 1.52 + oz)),
                                 proxy("body", (-bw - 0.1, y0, -bd - 0.1 + oz), (bw + 0.1, ridge, bd + 0.16 + oz)),
                                 proxy("ladder", (-0.38, 0, ladder_z + oz), (0.38, y0, -bd + oz))]}


def build_forge(part, col, root):
    """A village forge: a waist-high stone hearth with a glowing coal bed (emissive ``ember``) in a stone rim, a back
    wall at -Z under a hood narrowing to a chimney, a quench tub to +X and a lever bellows to -X on a plank stand,
    its nozzle into the hearth. The bellows' top board, leather and lever are one node, hinged at the nozzle, which
    ``Pump_Loop`` (2 s) lifts and lets fall; ``fire`` is where a warm light belongs."""
    b = K["Builder"](f"settlement.{part}.mesh")
    top = 0.8
    x0, x1, z0, z1 = -0.3, 1.1, -0.55, 0.45
    ox, oz = -((-1.92) + 1.67) / 2, -((-0.8) + 0.62) / 2  # centres the footprint, from the lever to the tub
    def forge():
        b.block((x0, 0, z0), (x1, top, z1), "stone", 0.02, "forge/hearth")
        for k, (lo, hi) in enumerate((((x0, top, z0), (x1, top + 0.09, z0 + 0.1)), ((x0, top, z1 - 0.1), (x1, top + 0.09, z1)),
                                       ((x0, top, z0 + 0.1), (x0 + 0.1, top + 0.09, z1 - 0.1)), ((x1 - 0.1, top, z0 + 0.1), (x1, top + 0.09, z1 - 0.1)))):
            b.block(lo, hi, "stone", 0.015, f"forge/rim{k}")
        b.box((x0 + 0.1, top, z0 + 0.1), (x1 - 0.1, top + 0.04, z1 - 0.1), "ember", "forge/coals")
        for k in range(9):
            cx, cz = x0 + 0.2 + 1.0 * rnd("coal-x", k), z0 + 0.2 + 0.6 * rnd("coal-z", k)
            placed(b, Matrix.Translation((cx, top + 0.03, cz)), lambda k=k: lathe(b, [(0, 0.045), (0.035, 0.05), (0.06, 0)], 5, "soot", f"forge/coal{k}", jitter=0.3, phase=rnd("coal-p", k)))
        b.block((x0 - 0.05, 0, -0.8), (x1 + 0.05, 1.9, z0), "stone", 0.02, "forge/back-wall")
        hood_y0, hood_y1 = 1.75, 2.55
        lower = [(x0 - 0.05, hood_y0, z1 + 0.05), (x1 + 0.05, hood_y0, z1 + 0.05), (x1 + 0.05, hood_y0, -0.8), (x0 - 0.05, hood_y0, -0.8)]
        upper = [(0.15, hood_y1, -0.35), (0.65, hood_y1, -0.35), (0.65, hood_y1, -0.8), (0.15, hood_y1, -0.8)]
        two_sided_loft(b, lower, upper, "stone", "forge/hood")
        b.block((x0 - 0.08, hood_y0 - 0.1, z1 - 0.02), (x1 + 0.08, hood_y0 + 0.02, z1 + 0.1), "timber", key="forge/hood-beam", grain=(1, 0, 0))
        b.block((0.12, hood_y1, -0.83), (0.68, 3.5, -0.32), "stone", 0.02, "forge/chimney")
        # quench tub
        placed(b, Matrix.Translation((1.4, 0, 0.35)), lambda: lathe(b, [(0, 0.24), (0.5, 0.27), (0.5, 0.23), (0.12, 0.21)], 10, "wood", "forge/tub", cap_mat="soot"))
        for k, y in enumerate((0.1, 0.4)):
            placed(b, Matrix.Translation((1.4, 0, 0.35)), lambda y=y, k=k: lathe(b, [(y, 0.25 + 0.06 * y), (y + 0.04, 0.25 + 0.06 * y + 0.006)], 10, "iron", f"forge/tub-hoop{k}"))
        # bellows: a plank stand, the fixed bottom board and the nozzle into the hearth
        b.block((-1.58, 0, -0.38), (-0.62, 0.58, 0.28), "wood", 0.015, "forge/stand")
        board(b, 0.58, 0.62, 0.0, "timber", "forge/bottom-board")
        b.block((-0.66, 0.58, -0.16), (-0.5, 0.82, 0.06), "timber", key="forge/nozzle-block")
        rod(b, (-0.52, 0.71, -0.05), (x0 + 0.05, 0.71, -0.05), 0.035, 6, "iron", "forge/tuyere")
    placed(b, Matrix.Translation((ox, 0, oz)), forge)
    b.finish(col, root)
    glow("ember")

    lb = K["Builder"](f"settlement.{part}.bellows")
    def bellows():
        board(lb, 0.82, 0.86, 0.0, "timber", "forge/top-board")
        board(lb, 0.42, 0.82, 0.025, "leather", "forge/leather")
        lb.block((-1.15, 0.86, -0.17), (-0.9, 0.98, 0.07), "stone", 0.02, "forge/weight")
        lb.box((-1.5, 0.86, -0.08), (-0.75, 0.87, -0.02), "iron", "forge/strap")
        rod(lb, (-1.45, 0.86, -0.05), (-1.86, 1.48, -0.05), 0.03, 6, "timber", "forge/lever")
        rod(lb, (-1.86, 1.48, -0.25), (-1.86, 1.48, 0.15), 0.025, 6, "timber", "forge/grip")
    placed(lb, Matrix.Translation((ox, 0, oz)), bellows)
    hinge = (-0.6 + ox, 0.72, -0.05 + oz)
    node = pivoted(lb, col, root, hinge)
    tau = 2 * math.pi
    clip = loop_clip("Pump_Loop", 2.0, [(node, lambda t: (0.0, 0.0, -0.14 * (0.5 - 0.5 * math.cos(tau * t))))])
    return {"clips": [clip], "fire": {"position": r6((0.4 + ox, top + 0.15, -0.05 + oz))},
            "collisionProxies": [proxy("hearth", (x0 - 0.05 + ox, 0, -0.8 + oz), (x1 + 0.05 + ox, top + 0.09, z1 + oz)),
                                 proxy("chimney", (x0 - 0.05 + ox, top + 0.09, -0.8 + oz), (x1 + 0.05 + ox, 3.5, z0 + oz)),
                                 proxy("bellows", (-1.58 + ox, 0, -0.38 + oz), (-0.5 + ox, 0.9, 0.28 + oz)),
                                 proxy("tub", (1.13 + ox, 0, 0.08 + oz), (1.67 + ox, 0.5, 0.62 + oz))]}


BELLOWS = [(-0.6, 0.09), (-0.8, 0.19), (-1.05, 0.27), (-1.3, 0.3), (-1.48, 0.25), (-1.56, 0.12)]


def board(b, y0, y1, inset, mat, key):
    """The pear-shaped outline of the forge bellows along -X (nozzle end at x -0.6), from ``y0`` to ``y1``, ``inset`` in."""
    zc = -0.05
    outline = [(x, -(zc + h - inset)) for x, h in BELLOWS] + [(x, -(zc - h + inset)) for x, h in reversed(BELLOWS)]
    placed(b, Matrix.Rotation(-math.pi / 2, 4, "X"), lambda: b.prism(outline, y0, y1, mat, key, grain=(1, 0, 0)))


def build_well_windlass(part, col, root):
    """A windlass to set over a well curb like the ``well``'s (1.5 m): two A-frame trestles on sills along Z, 1.9 m
    apart, under a tie beam, carrying a drum along X with a rope coil, a rope hanging down the shaft and an iron
    crank to +X. The drum, axle and crank are one node, which ``Crank_Loop`` (3 s a turn) winds, the rope side
    rising. The origin is the well's centre on the ground."""
    b = K["Builder"](f"settlement.{part}.mesh")
    px, ay = 0.95, 1.3
    for s in (-1, 1):
        x = s * px
        b.block((x - 0.07, 0, -0.62), (x + 0.07, 0.12, 0.62), "timber", key=f"windlass/sill{s}", grain=(0, 0, 1))
        for side in (-1, 1):
            rod(b, (x, 0.08, side * 0.5), (x, ay + 0.16, side * 0.04), 0.05, 6, "timber", f"windlass/leg{s}{side}")
        b.block((x - 0.08, ay + 0.1, -0.14), (x + 0.08, ay + 0.24, 0.14), "timber", key=f"windlass/cap{s}", grain=(0, 0, 1))
    b.block((-px - 0.14, ay + 0.24, -0.07), (px + 0.14, ay + 0.36, 0.07), "timber", key="windlass/tie", grain=(1, 0, 0))
    b.box((-0.012, 0.3, 0.125), (0.012, ay, 0.15), "sacking", "windlass/rope")
    b.finish(col, root)
    db = K["Builder"](f"settlement.{part}.drum")
    rod(db, (-px - 0.12, ay, 0), (px + 0.2, ay, 0), 0.04, 6, "iron", "windlass/axle")
    rod(db, (-px + 0.1, ay, 0), (px - 0.1, ay, 0), 0.11, 8, "timber", "windlass/drum", "endgrain")
    for k, x in enumerate((-px + 0.14, px - 0.14)):
        rod(db, (x - 0.025, ay, 0), (x + 0.025, ay, 0), 0.12, 8, "iron", f"windlass/band{k}")
    rings = [(0.025 * i, 0.128 + 0.014 * (i % 2)) for i in range(21)]  # turns of rope
    placed(db, Matrix.Translation((-0.25, ay, 0)) @ Matrix.Rotation(-math.pi / 2, 4, "Z"), lambda: lathe(db, rings, 8, "sacking", "windlass/coil", jitter=0.04))
    db.box((px + 0.14, ay - 0.03, -0.02), (px + 0.19, ay + 0.03, 0.3), "iron", "windlass/crank-arm")
    rod(db, (px + 0.16, ay, 0.28), (px + 0.38, ay, 0.28), 0.02, 6, "iron", "windlass/crank-handle")
    drum = pivoted(db, col, root, (0, ay, 0))
    clip = loop_clip("Crank_Loop", 3.0, [(drum, lambda t: (-2 * math.pi * t, 0.0, 0.0))], linear=True)
    return {"clips": [clip], "collisionProxies": [proxy(f"frame-{side}", (s * px - 0.1, 0, -0.62), (s * px + 0.1, ay + 0.36, 0.62)) for s, side in ((-1, "left"), (1, "right"))]}


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
            "bridge-railing": build_bridge_railing, "stall-awning": build_stall_awning,
            "bread-basket": build_bread_basket, "cheese-board": build_cheese_board, "fish-crate": build_fish_crate,
            "apple-crate": build_apple_crate, "hanging-meats": build_hanging_meats, "cask-rack": build_cask_rack,
            "merchant-scale": build_merchant_scale, "cloth-bolts": build_cloth_bolts, "pottery": build_pottery,
            "anvil": build_anvil, "grindstone": build_grindstone, "cooper-barrel": build_cooper_barrel,
            "table-set": build_table_set, "candles": build_candles, "candelabra": build_candelabra, "inn-sign": build_inn_sign,
            "stool": build_stool, "bar-counter": build_bar_counter, "log-stack": build_log_stack, "wall-shield": build_wall_shield,
            "wall-trophy": build_wall_trophy,
            "rowing-boat": build_rowing_boat, "jetty": build_jetty, "fishing-nets": build_fishing_nets,
            "banner-outpost": build_banner("outpost"), "banner-village": build_banner("village"),
            "pennant-outpost": build_pennant("outpost"), "pennant-village": build_pennant("village"), "bunting": build_bunting,
            "scarecrow": build_scarecrow, "weather-vane": build_weather_vane, "beehive-skeps": build_beehive_skeps,
            "water-trough": build_water_trough, "feed-trough": build_feed_trough, "hen-coop": build_hen_coop, "plough": build_plough,
            "watermill": build_watermill, "water-wheel": build_water_wheel, "windmill": build_windmill, "forge": build_forge,
            "well-windlass": build_well_windlass}


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
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = CLIP_FPS, 1.0
    root, info = build(prop, bpy.context.scene.collection)
    objects = [root] + list(root.children_recursive)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    triangles = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects if o.type == "MESH")
    scene.frame_set(0)  # the rest pose is the clips' first key
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=True,
        export_vertex_color="NONE", export_animations=bool(info.get("clips")), export_animation_mode="ACTIONS",
        export_skins=False, export_morph=False,         export_cameras=False, export_lights=False, export_extras=False)
    result = {"recipe": "settlement-props-v1", "prop": prop, "family": FAMILY[prop], "unit": "meter",
              "axes": "right-handed-y-up", "origin": "footprint-base-center", "facing": "+Z", "triangleCount": triangles, **info}
    if prop == "stall":
        result["compositions"] = compositions()
    return result
