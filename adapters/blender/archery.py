"""Original humanlike archery gear for the existing pinned Blender script backend (#113 bow slice).

Pieces, in metres and glTF right-handed +Y up, origin at each piece's attach frame:

- ``bow.long``: a braced longbow. The origin is the centre of the hand's contact on the riser, the
  limbs run along +Y/-Y and the arrow leaves toward +Z, so the string is on the -Z side. The bow is
  skinned to two joints: ``grip`` (the root, at the origin) and ``nock`` (at the middle of the string,
  at rest at [0, 0, -braceHeight]). Moving ``nock`` toward -Z draws the string: every string vertex
  is weighted linearly between ``grip`` at the tips and ``nock`` at the middle, so both string halves
  stay straight. The limbs do not bend.
- ``arrow``: the origin is the arrow's nock and the shaft runs toward +Z to the broadhead.
- ``quiver.back``: the origin is the centre of the tube. The tube's opening points to +Y and its back
  (the side worn against the body) faces -Z. Five arrow tails stand out of the opening.

The style rules are docs/style-humanlike.md: factor-only PBR materials, no textures or UVs.
Geometry is authored in glTF axes and converted to Blender's Z-up once (``to_blender``). No
randomness is used.
"""
import hashlib
import math

import bmesh
import bpy
from mathutils import Vector

COMMON = {"schemaVersion", "piece", "maxTriangles"}
PIECES = {
    "bow.long": {"length": (1.2, 1.9, False), "braceHeight": (.12, .24, False), "limbWidth": (.02, .05, False), "limbSegments": (6, 24, True)},
    "arrow": {"length": (.55, .95, False), "shaftRadius": (.003, .007, False), "radialSegments": (5, 12, True)},
    "quiver.back": {"length": (.35, .7, False), "radius": (.035, .08, False), "arrows": (0, 8, True), "radialSegments": (8, 24, True)},
    "crossbow": {"length": (.6, .95, False), "prodSpan": (.45, .8, False), "prodOffset": (.25, .5, False), "radialSegments": (6, 12, True)},
}
BUDGETS = {"bow.long": 2500, "arrow": 800, "quiver.back": 6000, "crossbow": 2500}
ROLES = {"bow.long": "bow", "arrow": "arrow", "quiver.back": "quiver", "crossbow": "crossbow"}
MATERIALS = {
    "wood": ((.34, .22, .12), 0.0, .76),
    "horn": ((.55, .48, .36), 0.0, .5),
    "leather": ((.2, .1, .05), 0.0, .72),
    "string": ((.6, .56, .46), 0.0, .8),
    "iron": ((.29, .28, .27), 1.0, .48),
    "feather": ((.66, .62, .55), 0.0, .9),
}
PIECE_MATERIALS = {"bow.long": ["wood", "horn", "leather", "string"], "arrow": ["wood", "iron", "feather"],
                   "quiver.back": ["leather", "wood", "iron", "feather"], "crossbow": ["wood", "iron", "leather", "string"]}


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate(p, inputs):
    if type(p) is not dict or p.get("piece") not in PIECES:
        raise ValueError("archery piece must be bow.long, arrow, quiver.back or crossbow")
    piece = p["piece"]
    if set(p) != COMMON | set(PIECES[piece]):
        raise ValueError("archery piece requires exactly the declared controls")
    if inputs:
        raise ValueError("archery recipe does not accept extra resources")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("archery schemaVersion must be 1")
    ranges = dict(PIECES[piece], maxTriangles=(12, BUDGETS[piece], True))
    for key, (low, high, integer) in ranges.items():
        value = p[key]
        if not _number(value) or not low <= value <= high or (integer and type(value) is not int):
            raise ValueError(f"invalid archery {key}")


def to_blender(point):
    x, y, z = point
    return (x, -z, y)


def chamfer_rect(u, v, c):
    return [(u, -v + c), (u, v - c), (u - c, v), (-u + c, v), (-u, v - c), (-u, -v + c), (-u + c, -v), (u - c, -v)]


def circle(radius, n, phase=0.0):
    return [(radius * math.cos(phase + 2 * math.pi * i / n), radius * math.sin(phase + 2 * math.pi * i / n)) for i in range(n)]


class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.points = []
        self.weights = []  # nock weight per vertex (skinned pieces)

    def vert(self, point, nock=0.0):
        self.points.append(point)
        self.weights.append(nock)
        return self.bm.verts.new(to_blender(point))

    def face(self, verts, material):
        self.bm.faces.new(verts).material_index = material

    def loft(self, rings, material, weights=None, caps=True):
        """Join rings of equal size (lists of 3D points); a one-point ring is an apex."""
        verts = [[self.vert(p, (weights or [0.0] * len(rings))[k]) for p in ring] for k, ring in enumerate(rings)]
        for a, b in zip(verts, verts[1:]):
            if len(a) == 1 or len(b) == 1:
                apex, ring = (a[0], b) if len(a) == 1 else (b[0], a)
                for i in range(len(ring)):
                    self.face([apex, ring[i], ring[(i + 1) % len(ring)]], material)
                continue
            for i in range(len(a)):
                j = (i + 1) % len(a)
                self.face([a[i], a[j], b[j], b[i]], material)
        if caps:
            for ring in (verts[0], verts[-1]):
                if len(ring) > 2:
                    self.face(ring, material)


def ring_y(section, y, z):
    """A section (u along X, v along Z) at height y, centred at z."""
    return [(u, y, z + v) for u, v in section]


def ring_z(section, z, x=0.0, y=0.0):
    """A section (u along X, v along Y) at depth z."""
    return [(x + u, y + v, z) for u, v in section]


def bow(builder, p):
    wood, horn, leather, string = range(4)
    half, brace, width, n = p["length"] / 2, p["braceHeight"], p["limbWidth"], p["limbSegments"]
    riser = .11
    tip = half - .015

    def limb_z(y):
        t = max(0.0, (abs(y) - riser) / (tip - riser))
        return -brace * t ** 1.6

    # Riser: a thicker block with a leather grip wrap around the origin.
    rings = []
    for y, w, t in [(-riser, .62, 1.0), (-.06, 1.0, 1.35), (.06, 1.0, 1.35), (riser, .62, 1.0)]:
        rings.append(ring_y(chamfer_rect(width / 2 * w * 1.1, .016 * t, .006), y, .004))
    builder.loft(rings, wood)
    builder.loft([ring_y(chamfer_rect(width / 2 * 1.12, .024, .009), y, .004) for y in (-.05, .05)], leather)
    # Limbs: tapered, chamfered sections along a curve that bends toward the string at the tips.
    for sign in (-1, 1):
        rings = []
        for k in range(n + 1):
            y = sign * (riser + (tip - riser) * k / n)
            t = k / n
            hw, ht = width / 2 * (1 - .55 * t), .011 * (1 - .45 * t)
            rings.append(ring_y(chamfer_rect(hw, ht, min(hw, ht) * .4), y, limb_z(y)))
        builder.loft(rings, wood)
        # Horn nock at the tip, where the string loops.
        y0, y1 = sign * tip, sign * half
        rings = [ring_y(chamfer_rect(width * .26, .007, .003), y, limb_z(y0)) for y in (y0 - sign * .025, y0)]
        rings.append([(0.0, y1, limb_z(y0))])
        builder.loft(rings, horn)
    # String: two straight halves from the tips to the nock point, weighted linearly to ``nock``.
    z = limb_z(tip)
    section = chamfer_rect(.0018, .0018, .0006)
    for sign in (-1, 1):
        rings, weights = [], []
        steps = 8
        for k in range(steps + 1):
            t = k / steps  # 0 at the tip, 1 at the nock point
            rings.append(ring_y(section, sign * (tip - .01) * (1 - t), z))
            weights.append(t)
        builder.loft(rings, string, weights, caps=False)
    # A serving wrap at the nock point (weighted fully to ``nock``).
    builder.loft([ring_y(chamfer_rect(.003, .003, .001), y, z) for y in (-.035, .035)], string, [1.0, 1.0])
    return z


def arrow(builder, p):
    wood, iron, feather = range(3)
    length, r, n = p["length"], p["shaftRadius"], p["radialSegments"]
    head = .055
    shaft_end = length - head
    builder.loft([ring_z(circle(r * .8, n), 0.0), ring_z(circle(r, n), .012), ring_z(circle(r, n), shaft_end)], wood)
    # Nock slot block at the origin.
    builder.loft([ring_z(chamfer_rect(r * 1.1, r * .55, r * .2), z) for z in (-.008, .012)], wood)
    # Broadhead: a flat diamond blade with a socket.
    builder.loft([ring_z(circle(r * 1.2, n), shaft_end - .012), ring_z(circle(r * 1.2, n), shaft_end + .006)], iron)
    blade = [ring_z(chamfer_rect(.016, .0015, .0007), shaft_end), ring_z(chamfer_rect(.011, .0012, .0005), shaft_end + head * .6), [(0.0, 0.0, length)]]
    builder.loft(blade, iron)
    # Three fletchings, 120 degrees apart.
    for k in range(3):
        a = math.pi / 2 + 2 * math.pi * k / 3
        ca, sa = math.cos(a), math.sin(a)
        outline = [(.03, r), (.13, r), (.12, r + .012), (.05, r + .014)]
        points = [(ca * d, sa * d, z) for z, d in outline]
        builder.face([builder.vert(q) for q in points], feather)
        builder.face([builder.vert(q) for q in reversed(points)], feather)


def quiver(builder, p):
    leather, wood, iron, feather = range(4)
    length, r, n = p["length"], p["radius"], p["radialSegments"]
    lo, hi = -length / 2, length / 2

    def ring(radius, y):
        return [(x, y, z) for x, z in circle(radius, n)]

    # Tube: an open leather cylinder, slightly flared at the mouth, with a wooden base.
    outer = [ring(r * .94, lo + .02), ring(r, lo + .05), ring(r, hi - .04), ring(r * 1.06, hi)]
    builder.loft(outer, leather, caps=False)
    builder.loft([ring(r * 1.06, hi), ring(r * .98, hi), ring(r * .92, hi - .04), ring(r * .92, lo + .05)], leather, caps=False)
    builder.loft([ring(r * .96, lo), ring(r * .96, lo + .025)], wood)
    for y in (hi - .015, lo + .1):
        builder.loft([ring(r * 1.07, y - .008), ring(r * 1.07, y + .008)], iron, caps=False)
    # Strap loops on the back (-Z side).
    for y in (hi - .1, lo + .14):
        builder.loft([ring_y(chamfer_rect(.025, .004, .0015), y + d, -r - .004) for d in (-.012, .012)], leather)
    # Arrow tails standing out of the opening: shafts with three-vane fletchings.
    count = p["arrows"]
    for k in range(count):
        a = 2 * math.pi * k / max(count, 1)
        cx, cz = r * .5 * math.cos(a), r * .5 * math.sin(a)
        top = hi + .1 + .025 * (k % 2)
        builder.loft([[(cx + u, hi - .12, cz + v) for u, v in circle(.0045, 6)], [(cx + u, top, cz + v) for u, v in circle(.0045, 6)]], wood)
        for m in range(3):
            b = a + 2 * math.pi * m / 3
            cb, sb = math.cos(b), math.sin(b)
            outline = [(top - .015, .0045), (top - .1, .0045), (top - .09, .017), (top - .03, .019)]
            points = [(cx + cb * d, y, cz + sb * d) for y, d in outline]
            builder.face([builder.vert(q) for q in points], feather)
            builder.face([builder.vert(q) for q in reversed(points)], feather)


def tube(builder, a, b, section, material, up=(0, 1, 0), caps=True):
    """A straight bar of ``section`` (u across, v toward ``up``) from point ``a`` to point ``b``."""
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    side = d.cross(Vector(up)).normalized()
    top = side.cross(d).normalized()
    builder.loft([[tuple(c + side * u + top * v) for u, v in section] for c in (a, b)], material, caps=caps)


def crossbow(builder, p):
    """A spanned crossbow (#389). The stock runs along Z through the grip at the origin, the bolt leaves toward +Z and
    the top of the stock (the bolt groove) faces +Y. The steel prod spans X at ``prodOffset`` ahead of the grip, its
    tips swept back by the spanned string, which the nut on the stock holds. A stirrup loops ahead of the prod and a
    long trigger lever runs back under the stock to the hand."""
    wood, iron, leather, string = range(4)
    length, span, zp, n = p["length"], p["prodSpan"], p["prodOffset"], p["radialSegments"]
    butt = zp + .045 - length
    # Stock: a deep butt that drops below the grip, a slim wrist at the grip and a straight tiller to the prod.
    rings = []
    for z, hw, hh, y in [(butt, .022, .05, -.03), (butt + .03, .026, .052, -.028), (-.12, .02, .036, -.012), (-.05, .017, .026, -.004),
                         (.05, .017, .024, 0.0), (zp - .02, .019, .022, 0.0), (zp + .045, .016, .018, 0.0)]:
        rings.append(ring_z(chamfer_rect(hw, hh, min(hw, hh) * .45), z, 0.0, y))
    builder.loft(rings, wood)
    # Leather wrap at the grip.
    builder.loft([ring_z(chamfer_rect(.0195, .028, .008), z, 0.0, -.003) for z in (-.045, .045)], leather)
    # Iron band where the prod is seated.
    builder.loft([ring_z(chamfer_rect(.024, .026, .007), z) for z in (zp - .02, zp + .02)], iron)
    # Prod: two tapered limbs from the stock to the tips, swept back by the spanned string.
    half, sweep = span / 2, .075

    def prod_z(t):
        return zp - sweep * t ** 1.7
    for sign in (-1, 1):
        rings = []
        for k in range(n + 1):
            t = k / n
            hy, hz = .016 * (1 - .4 * t), .009 * (1 - .35 * t)
            x = sign * (.02 + (half - .02) * t)
            rings.append([(x, y, prod_z(t) + z) for y, z in chamfer_rect(hy, hz, min(hy, hz) * .4)])
        builder.loft(rings, iron)
    # Nut: the drum on top of the stock that holds the spanned string.
    nut_z = zp - length * .42
    builder.loft([[(x, .024 + v, nut_z + u) for u, v in circle(.011, n)] for x in (-.014, .014)], iron)
    # String: two straight halves from the prod tips to the nut.
    for sign in (-1, 1):
        tube(builder, (sign * (half - .01), 0.0, prod_z(1.0)), (sign * .012, .03, nut_z + .002), chamfer_rect(.0018, .0018, .0006),
             string, caps=False)
    # Stirrup: an iron loop ahead of the prod for the foot when spanning.
    loop = [(.045 * math.cos(math.pi * k / 8), 0.0, zp + .03 + .1 * math.sin(math.pi * k / 8)) for k in range(9)]
    for a, b in zip(loop, loop[1:]):
        tube(builder, a, b, circle(.005, 6), iron)
    # Trigger lever: a long bar under the stock from its pivot behind the nut back past the hand.
    builder.loft([ring_z(chamfer_rect(.004, .005, .0015), z, 0.0, y) for z, y in ((nut_z - .02, -.03), (nut_z - .08, -.04), (-.16, -.05))],
                 iron)


def names_index(piece, name):
    names = PIECE_MATERIALS[piece]
    return names.index(name) if name in names else -1


def material(name):
    colour, metallic, roughness = MATERIALS[name]
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*colour, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    return result


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    p, piece = arguments, arguments["piece"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    builder = Builder()
    nock_z = {"bow.long": bow, "arrow": arrow, "quiver.back": quiver, "crossbow": crossbow}[piece](builder, p)
    bm = builder.bm
    # Vanes are authored two-sided (one face per side); recalculating would merge their orientation.
    bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces if f.material_index != names_index(piece, "feather")])
    weights = list(builder.weights)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="FIXED", ngon_method="EAR_CLIP")
    for face in bm.faces:
        face.smooth = False
    triangles = len(bm.faces)
    if triangles > p["maxTriangles"]:
        bm.free()
        raise ValueError("archery piece exceeds its maxTriangles budget")
    mesh = bpy.data.meshes.new(f"{piece}-geometry")
    bm.to_mesh(mesh)
    bm.free()
    names = PIECE_MATERIALS[piece]
    for name in names:
        mesh.materials.append(material(name))
    obj = bpy.data.objects.new(piece, mesh)
    bpy.context.scene.collection.objects.link(obj)
    selected = [obj]
    joints = []
    if piece == "bow.long":
        armature = bpy.data.armatures.new("bow.long.rig")
        rig = bpy.data.objects.new("bow.long.rig", armature)
        bpy.context.scene.collection.objects.link(rig)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.mode_set(mode="EDIT")
        grip = armature.edit_bones.new("grip")
        grip.head, grip.tail = to_blender((0, 0, 0)), to_blender((0, .1, 0))
        nock = armature.edit_bones.new("nock")
        nock.head, nock.tail = to_blender((0, 0, nock_z)), to_blender((0, .1, nock_z))
        nock.parent = grip
        for bone in (grip, nock):
            bone.roll = 0.0
        bpy.ops.object.mode_set(mode="OBJECT")
        groups = {name: obj.vertex_groups.new(name=name) for name in ("grip", "nock")}
        for index, weight in enumerate(weights):
            if weight < 1:
                groups["grip"].add([index], 1 - weight, "REPLACE")
            if weight > 0:
                groups["nock"].add([index], weight, "REPLACE")
        obj.parent = rig
        modifier = obj.modifiers.new("rig", "ARMATURE")
        modifier.object = rig
        selected.append(rig)
        joints = ["grip", "nock"]
    else:
        grip = bpy.data.objects.new("grip", None)
        bpy.context.scene.collection.objects.link(grip)
        selected.append(grip)
    bpy.ops.object.select_all(action="DESELECT")
    for item in selected:
        item.select_set(True)
    bpy.context.view_layer.objects.active = obj
    lows = [min(point[i] for point in builder.points) for i in range(3)]
    highs = [max(point[i] for point in builder.points) for i in range(3)]
    geometry = b"".join(float(c).hex().encode("ascii") + b"\n" for v in mesh.vertices for c in v.co)
    geometry += b"".join((",".join(str(i) for i in f.vertices) + ":" + str(f.material_index) + "\n").encode("ascii") for f in mesh.polygons)
    geometry += b"".join(float(w).hex().encode("ascii") + b"\n" for w in weights)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_animations=False, export_skins=piece == "bow.long", export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    result = {"recipe": "archery-v1", "parameters": p, "piece": piece, "role": ROLES[piece], "unit": "meter",
              "axes": "right-handed-y-up", "origin": "grip", "triangleCount": triangles,
              "bounds": {"min": [round(c, 6) for c in lows], "max": [round(c, 6) for c in highs]},
              "materials": names, "geometrySha256": hashlib.sha256(geometry).hexdigest()}
    if joints:
        result["joints"] = joints
        result["nockRest"] = [0, 0, round(nock_z, 6)]
        result["drawAxis"] = [0, 0, -1]
    return result
