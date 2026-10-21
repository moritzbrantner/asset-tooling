"""Original Ranger headwear (#336) for the pinned Blender script backend.

Pieces: ``cap.ranger`` (soft felt cap with a leather band and a tapered plume, no peak) and ``helm.ironcrest``
(iron dome to the brow with a short neck guard, a brass rim, a nasal bar and a brass crest fin along the crown).
The owner approved both shapes on the live Ranger (2026-10-21). The style rules are docs/style-humanlike.md.

Every GLB holds one mesh node named after the piece and an empty node ``grip`` at the origin with an identity
transform. The geometry is in the male Ranger's rest model space (metres, glTF right-handed +Y up, facing +Z), fitted
around its head, so the piece attaches through the ``head.armor`` socket, which is the inverse of the ``Head`` joint's
rest transform, like the armour plates and the ``head.hair`` hairstyles. With the identity ``grip``, the holder is the
socket itself.

Geometry is authored from explicit coordinates in glTF axes and converted to Blender's Z-up once (``to_blender``), so
the exporter's +Y-up conversion gives the authored glTF coordinates back. Shells get their thickness from Blender's
Solidify modifier, applied before export. No randomness is used.
"""
import hashlib
import math

import bmesh
import bpy

COMMON = {"schemaVersion", "piece", "maxTriangles"}
PIECES = {"cap.ranger": {"segments": (12, 24, True)}, "helm.ironcrest": {"segments": (12, 24, True)}}
# Style-spec triangle ceilings (docs/style-humanlike.md); maxTriangles may only lower them.
BUDGETS = {"cap.ranger": 2000, "helm.ironcrest": 2500}
MATERIALS = {
    # name: (linear base colour, metallic, roughness); tuned under the game's environment lighting (rough, part-metallic metal: the game has little environment reflection, so full metal reads black; deep felt)
    "felt": ((.07, .13, .05), 0.0, .85),
    "leather": ((.24, .13, .06), 0.0, .75),
    "feather": ((.75, .7, .6), 0.0, .8),
    "iron": ((.30, .30, .31), .35, .65),
    "brass": ((.55, .38, .14), .45, .55),
}
PIECE_MATERIALS = {"cap.ranger": ["felt", "leather", "feather"], "helm.ironcrest": ["iron", "brass"]}
SHARP_ANGLE = math.radians(35)
# The male Ranger's skull centre in rest model space (glTF axes), measured from the composed head.
SKULL = (0.0, 1.70, .004)


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate(p, inputs):
    if type(p) is not dict or p.get("piece") not in PIECES:
        raise ValueError("headwear piece must be cap.ranger or helm.ironcrest")
    piece = p["piece"]
    if set(p) != COMMON | set(PIECES[piece]):
        raise ValueError("headwear requires exactly the declared controls")
    if inputs:
        raise ValueError("headwear recipe does not accept extra resources")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("headwear schemaVersion must be 1")
    ranges = dict(PIECES[piece], maxTriangles=(12, BUDGETS[piece], True))
    for key, (low, high, integer) in ranges.items():
        value = p[key]
        if not _number(value) or not low <= value <= high or (integer and type(value) is not int):
            raise ValueError(f"invalid headwear {key}")


def to_blender(point):
    x, y, z = point
    return (x, -z, y)


def normalize(v):
    length = math.sqrt(sum(c * c for c in v))
    return tuple(c / length for c in v)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


class Part:
    """One shell of a piece: a bmesh in glTF axes with one material, thickened by Solidify on build."""

    def __init__(self, material, thickness, offset):
        self.bm = bmesh.new()
        self.material, self.thickness, self.offset = material, thickness, offset
        self.points = []

    def vert(self, point):
        self.points.append(point)
        return self.bm.verts.new(to_blender(point))

    def quads(self, rows, cyclic):
        """Join rows of equal size; a one-point row is an apex."""
        for a, b in zip(rows, rows[1:]):
            if len(b) == 1:
                for j in range(len(a)):
                    self.bm.faces.new((a[j], a[(j + 1) % len(a)], b[0]))
                continue
            count = len(a) if cyclic else len(a) - 1
            for j in range(count):
                k = (j + 1) % len(a)
                self.bm.faces.new((a[j], a[k], b[k], b[j]))


def dome(part, rx, rz, rh, base, crown, segments, rings, back_drop):
    """Ellipsoid shell around the skull from height ``base`` (dropping by ``back_drop`` toward the back, -Z) up to
    ``crown``; where the ellipsoid closes before ``crown`` the top ring is an apex."""
    cx, cy, cz = SKULL
    rows = []
    for i in range(rings + 1):
        t = i / rings
        row = []
        for j in range(segments):
            a = 2 * math.pi * j / segments
            back = max(0.0, -math.cos(a))
            rim = base - back_drop * back ** 1.5
            y = rim + (crown - rim) * math.sin(t * math.pi / 2) ** 1.3
            k = math.sqrt(max(0.0, 1 - ((y - cy) / rh) ** 2)) if y > cy else 1.0
            k = max(k, .08 if i < rings else 0.0)
            row.append((cx + rx * k * math.sin(a), y, cz + rz * k * math.cos(a)))
        if all(math.hypot(p[0] - cx, p[2] - cz) < 1e-9 for p in row):
            row = [(cx, row[0][1], cz)]
        rows.append([part.vert(p) for p in row])
    part.quads(rows, cyclic=True)


def strip(part, inner, outer):
    """An open strip between two point lists of equal length."""
    part.quads([[part.vert(p) for p in inner], [part.vert(p) for p in outer]], cyclic=False)


def box(part, centre, half, tilt):
    """A box of half sizes ``half`` rotated by ``tilt`` radians about +X, at ``centre``."""
    c, s = math.cos(tilt), math.sin(tilt)
    corners = []
    for x in (-1, 1):
        for y in (-1, 1):
            for z in (-1, 1):
                px, py, pz = x * half[0], y * half[1], z * half[2]
                corners.append(part.vert((centre[0] + px, centre[1] + py * c - pz * s, centre[2] + py * s + pz * c)))
    for face in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        part.bm.faces.new([corners[i] for i in face])


def cap(p):
    felt, band, plume = Part(0, .008, 1), Part(1, .008, 1), Part(2, .003, -1)
    n = p["segments"]
    dome(felt, .104, .126, .125, 1.728, 1.835, n, 6, .035)
    dome(band, .106, .128, .2, 1.726, 1.748, n, 1, .035)
    # The plume: a tapered blade tucked into the band on the left, sweeping up and back.
    base, tip = (-.109, 1.742, -.035), (-.122, 1.87, -.17)
    direction = normalize(tuple(tip[k] - base[k] for k in range(3)))
    side = normalize(cross((0, 1, .35), direction))
    left, right = [], []
    for i in range(9):
        t = i / 8
        point = tuple(base[k] + (tip[k] - base[k]) * t for k in range(3))
        point = (point[0] - .012 * math.sin(math.pi * t), point[1], point[2])
        width = .016 * math.sin(math.pi * min(1.0, t * 1.15)) ** .7 + .001
        left.append(tuple(point[k] - side[k] * width for k in range(3)))
        right.append(tuple(point[k] + side[k] * width for k in range(3)))
    strip(plume, left, right)
    return [felt, band, plume]


def helm(p):
    iron, rim, nasal, crest = Part(0, .008, 1), Part(1, .008, 1), Part(0, 0, 0), Part(1, .012, 0)
    n = p["segments"]
    dome(iron, .108, .13, .13, 1.722, 1.842, n, 6, .05)
    dome(rim, .111, .133, .2, 1.716, 1.734, n, 1, .05)
    box(nasal, (0, 1.69, SKULL[2] + .112), (.008, .025, .004), math.radians(-14))
    # The crest fin: from over the brow, across the crown, to the back, tallest at the crown.
    cx, cy, cz = SKULL
    inner, outer = [], []
    for i in range(13):
        a = math.radians(-62 + 140 * i / 12)
        point = (cx, cy + .142 * math.cos(a), cz - .132 * math.sin(a))
        normal = normalize((0, math.cos(a) / .142, -math.sin(a) / .132))
        height = .028 * math.sin(math.pi * i / 12) ** .6 + .004
        inner.append(tuple(point[k] - normal[k] * .006 for k in range(3)))
        outer.append(tuple(point[k] + normal[k] * height for k in range(3)))
    strip(crest, inner, outer)
    return [iron, rim, nasal, crest]


def material(name):
    colour, metallic, roughness = MATERIALS[name]
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = next(node for node in result.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = (*colour, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    return result


def build(parts, names):
    """Thicken every part, then join them into one mesh with one material slot per name."""
    materials = [material(name) for name in names]
    objects = []
    for index, part in enumerate(parts):
        mesh = bpy.data.meshes.new(f"part-{index}")
        part.bm.to_mesh(mesh)
        part.bm.free()
        mesh.materials.append(materials[part.material])
        obj = bpy.data.objects.new(f"part-{index}", mesh)
        bpy.context.scene.collection.objects.link(obj)
        if part.thickness:
            modifier = obj.modifiers.new("solidify", "SOLIDIFY")
            modifier.thickness, modifier.offset = part.thickness, part.offset
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        objects.append(obj)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    # Joining keeps one slot per source mesh; collapse them to one slot per material, in `names` order.
    # Read the indices first: removing slots resets them.
    slots = [slot.material for slot in joined.material_slots]
    indices = [materials.index(slots[polygon.material_index]) for polygon in joined.data.polygons]
    joined.data.materials.clear()
    for item in materials:
        joined.data.materials.append(item)
    for polygon, index in zip(joined.data.polygons, indices):
        polygon.material_index = index
    return joined


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    p, piece = arguments, arguments["piece"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    parts = (cap if piece == "cap.ranger" else helm)(p)
    points = [point for part in parts for point in part.points]
    names = PIECE_MATERIALS[piece]
    obj = build(parts, names)
    obj.name = piece
    obj.data.name = f"{piece}-geometry"
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="FIXED", ngon_method="EAR_CLIP")
    for face in bm.faces:
        face.smooth = True
    for edge in bm.edges:
        faces = edge.link_faces
        edge.smooth = len(faces) == 2 and faces[0].material_index == faces[1].material_index and edge.calc_face_angle(math.pi) < SHARP_ANGLE
    triangles = len(bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    if triangles > p["maxTriangles"]:
        raise ValueError("headwear piece exceeds its maxTriangles budget")
    grip = bpy.data.objects.new("grip", None)
    bpy.context.scene.collection.objects.link(grip)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    grip.select_set(True)
    bpy.context.view_layer.objects.active = obj
    mesh = obj.data
    lows = [min(point[i] for point in points) for i in range(3)]
    highs = [max(point[i] for point in points) for i in range(3)]
    geometry = b"".join(float(c).hex().encode("ascii") + b"\n" for v in mesh.vertices for c in v.co)
    geometry += b"".join((",".join(str(i) for i in f.vertices) + ":" + str(f.material_index) + "\n").encode("ascii") for f in mesh.polygons)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "headwear-v1", "parameters": p, "piece": piece, "role": "armor", "socket": "head.armor",
            "unit": "meter", "axes": "right-handed-y-up", "origin": "grip", "gripNode": "grip", "space": "rest-model",
            "triangleCount": triangles,
            "bounds": {"min": [round(c, 6) for c in lows], "max": [round(c, 6) for c in highs]},
            "materials": names, "geometrySha256": hashlib.sha256(geometry).hexdigest()}
