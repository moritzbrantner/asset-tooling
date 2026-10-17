"""Original humanlike weapons for the existing pinned Blender script backend.

Pieces: ``sword.arming`` (bevelled blade with fuller, crossguard, wrapped grip,
pommel) and ``shield.heater`` (curved heater board, rim, boss, handle and
forearm strap). The style rules are docs/style-humanlike.md.

Every GLB holds one mesh node named after the piece and an empty node ``grip``
at the origin. The asset origin is the grip frame, in metres and glTF
right-handed +Y up:

- sword: origin at the centre of the hand's contact on the grip, blade along
  +Y, cutting edges along +X/-X, flats facing +Z/-Z;
- shield: origin at the centre of the hand handle, which runs along X; the
  face points to +Z, the point of the shield to -Y and the forearm runs from
  the handle along +Y to the strap. The back of the hand and the forearm rest
  against the board, so the palm faces -Z.

Geometry is authored from explicit coordinates in glTF axes and converted to
Blender's Z-up once (``to_blender``), so the exporter's +Y-up conversion gives
the authored glTF coordinates back. No randomness is used.
"""
import hashlib
import math

import bmesh
import bpy

COMMON = {"schemaVersion", "piece", "maxTriangles"}
# Control ranges: (minimum, maximum, integer).
PIECES = {
    "sword.arming": {
        "bladeLength": (.5, 1.0, False), "bladeWidth": (.03, .07, False), "bladeThickness": (.004, .012, False),
        "fullerLength": (0, .8, False), "guardWidth": (.12, .3, False), "gripLength": (.08, .22, False),
        "pommelRadius": (.015, .04, False), "radialSegments": (6, 24, True),
    },
    "shield.heater": {
        "width": (.36, .8, False), "height": (.45, 1.0, False), "curvature": (0, .12, False), "thickness": (.008, .04, False),
        "rimWidth": (.008, .05, False), "bossRadius": (.03, .12, False), "outlineSegments": (6, 32, True),
    },
}
# Style-spec triangle ceilings (docs/style-humanlike.md); maxTriangles may only lower them.
BUDGETS = {"sword.arming": 2500, "shield.heater": 3000}
ROLES = {"sword.arming": "one-hand-weapon", "shield.heater": "shield"}
MATERIALS = {
    # name: (linear base colour, metallic, roughness)
    "steel": ((.62, .64, .66), 1.0, .32),
    "iron": ((.29, .28, .27), 1.0, .48),
    "leather": ((.2, .1, .05), 0.0, .72),
    "wood": ((.34, .22, .12), 0.0, .78),
    "paint": ((.04, .07, .18), 0.0, .62),
}
PIECE_MATERIALS = {"sword.arming": ["steel", "iron", "leather"], "shield.heater": ["paint", "wood", "iron", "leather"]}
SHARP_ANGLE = math.radians(35)


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate(p, inputs):
    if type(p) is not dict or p.get("piece") not in PIECES:
        raise ValueError("weapon piece must be sword.arming or shield.heater")
    piece = p["piece"]
    if set(p) != COMMON | set(PIECES[piece]):
        raise ValueError("weapon requires exactly the declared controls")
    if inputs:
        raise ValueError("weapon recipe does not accept extra resources")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("weapon schemaVersion must be 1")
    ranges = dict(PIECES[piece], maxTriangles=(12, BUDGETS[piece], True))
    for key, (low, high, integer) in ranges.items():
        value = p[key]
        if not _number(value) or not low <= value <= high or (integer and type(value) is not int):
            raise ValueError(f"invalid weapon {key}")
    if piece == "sword.arming":
        if p["bladeThickness"] * 3 > p["bladeWidth"] or p["guardWidth"] < p["bladeWidth"] * 2:
            raise ValueError("sword blade must be three times as wide as thick and the guard twice as wide as the blade")
    else:
        if p["height"] < p["width"] or max(p["bossRadius"] * 4, p["rimWidth"] * 8, p["curvature"] * 4) > p["width"]:
            raise ValueError("heater shield must be taller than wide with boss, rim and curvature in proportion")


def to_blender(point):
    x, y, z = point
    return (x, -z, y)


def chamfer_rect(u, v, c):
    """Eight-point bevelled rectangle with half sizes u, v and chamfer c."""
    return [(u, -v + c), (u, v - c), (u - c, v), (-u + c, v), (-u, v - c), (-u, -v + c), (-u + c, -v), (u - c, -v)]


def normalize(v):
    length = math.sqrt(sum(c * c for c in v))
    return tuple(c / length for c in v)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.points = []

    def vert(self, point):
        self.points.append(point)
        return self.bm.verts.new(to_blender(point))

    def face(self, verts, material):
        face = self.bm.faces.new(verts)
        face.material_index = material
        return face

    def loft(self, rings, material, cyclic=False):
        """Join rings of equal size; a one-point ring is an apex. Open ends are capped."""
        verts = [[self.vert(p) for p in ring] for ring in rings]
        pairs = list(zip(verts, verts[1:])) + ([(verts[-1], verts[0])] if cyclic else [])
        for a, b in pairs:
            if len(a) == 1 or len(b) == 1:
                apex, ring = (a[0], b) if len(a) == 1 else (b[0], a)
                for i in range(len(ring)):
                    self.face([apex, ring[i], ring[(i + 1) % len(ring)]], material)
                continue
            for i in range(len(a)):
                j = (i + 1) % len(a)
                self.face([a[i], a[j], b[j], b[i]], material)
        if not cyclic:
            for ring in (verts[0], verts[-1]):
                if len(ring) > 2:
                    self.face(ring, material)

    def sweep(self, path, section, material, up=(0, 1, 0)):
        """Sweep a 2D section (u along ``up``, v along tangent x up) along an open path."""
        rings = []
        for i, point in enumerate(path):
            a, b = path[max(i - 1, 0)], path[min(i + 1, len(path) - 1)]
            normal = normalize(cross(normalize(tuple(b[k] - a[k] for k in range(3))), up))
            rings.append([tuple(point[k] + u * up[k] + v * normal[k] for k in range(3)) for u, v in section])
        self.loft(rings, material)


def sword(builder, p):
    steel, iron, leather = range(3)
    n, grip, half_grip = p["radialSegments"], p["gripLength"], p["gripLength"] / 2
    # Wrapped grip: elliptical rings whose radius follows a helical leather wrap.
    wraps, per_wrap, rx, rz = 6, 3, .0155, .0135
    rings = []
    for k in range(wraps * per_wrap + 1):
        u = k / (wraps * per_wrap)
        swell = 1 + .06 * math.sin(math.pi * u)
        ring = []
        for i in range(n):
            angle = 2 * math.pi * i / n
            wrap = 1 - .045 * (.5 + .5 * math.cos(2 * math.pi * wraps * u - angle))
            ring.append((rx * swell * wrap * math.cos(angle), -half_grip + grip * u, rz * swell * wrap * math.sin(angle)))
        rings.append(ring)
    builder.loft(rings, leather)
    # Crossguard: bevelled bar along X whose quillons taper, swell at the ends and sweep slightly toward the blade.
    guard_base, guard_height, guard_depth, half_guard = half_grip - .002, .024, .03, p["guardWidth"] / 2
    rings = []
    for fraction, scale in [(-1, .55), (-.93, 1.0), (-.65, .8), (-.3, .85), (0, 1.2), (.3, .85), (.65, .8), (.93, 1.0), (1, .55)]:
        centre = guard_base + guard_height / 2 + .012 * fraction * fraction
        hy, hz = guard_height / 2 * scale, guard_depth / 2 * scale
        rings.append([(fraction * half_guard, centre + u, v) for u, v in chamfer_rect(hy, hz, min(hy, hz) * .4)])
    builder.loft(rings, iron)
    # Blade: bevelled edges along +/-X, a fuller in each flat, distal taper and an ogive point.
    start, length = guard_base + guard_height, p["bladeLength"]
    w0, t0 = p["bladeWidth"] / 2, p["bladeThickness"] / 2
    rings = []
    for s in [-.02, 0, .1, .25, .4, .55, .7, .82, .9, .95, .985]:
        sc = max(s, 0)
        w = w0 * (1 - .22 * min(sc, .82))
        t = t0 * (1 - .35 * sc)
        if sc > .82:
            tip = math.cos((sc - .82) / .18 * math.pi / 2) ** .75
            w, t = w * tip, t * max(tip, .25)
        e, f = .38 * w, .26 * w
        fuller = p["fullerLength"]
        depth = .5 * t * (0 if fuller == 0 else min(1, max(0, (fuller - sc) / .08)))
        y = start + length * s if s >= 0 else guard_base + guard_height * .4
        profile = [(w, 0), (w - e, t), (f, t), (f * .55, t - depth), (-f * .55, t - depth), (-f, t), (-(w - e), t),
                   (-w, 0), (-(w - e), -t), (-f, -t), (-f * .55, -(t - depth)), (f * .55, -(t - depth)), (f, -t), (w - e, -t)]
        rings.append([(x, y, z) for x, z in profile])
    rings.append([(0, start + length, 0)])
    builder.loft(rings, steel)
    # Pommel: pear-shaped lathe with a peen button, below the grip.
    r, top = p["pommelRadius"], -half_grip + .004
    profile = [(.55, 0), (.9, .25), (1, .55), (1, 1.05), (.9, 1.35), (.5, 1.6), (.28, 1.62), (.22, 1.8)]
    rings = [[(r * a * math.cos(2 * math.pi * i / n), top - r * b, r * a * math.sin(2 * math.pi * i / n)) for i in range(n)] for a, b in profile]
    rings.append([(0, top - r * 1.82, 0)])
    builder.loft(rings, iron)


def shield(builder, p):
    paint, wood, iron, leather = range(4)
    width, height, curve, thick, rim, m = p["width"], p["height"], p["curvature"], p["thickness"], p["rimWidth"], p["outlineSegments"]
    top, columns, standoff = .44 * height, 12, .075

    def back(x):
        return standoff - curve * (2 * x / width) ** 2

    def half_width(t):
        return width / 2 * (1 - t ** 2.2)

    grid = []
    for k in range(m):
        t, row = k / m, []
        hw = half_width(t)
        for j in range(columns):
            x = -hw + 2 * hw * j / (columns - 1)
            y = top - t * height + (.03 * height * (1 - (x / hw) ** 2) if k == 0 else 0)
            row.append((x, y))
        grid.append(row)
    apex = (0, top - height)
    # Board: front (paint) and back (wood) grids, joined by a wooden side wall along the outline.
    front = [[builder.vert((x, y, back(x) + thick)) for x, y in row] for row in grid]
    rear = [[builder.vert((x, y, back(x))) for x, y in row] for row in grid]
    front_apex, rear_apex = builder.vert((apex[0], apex[1], back(0) + thick)), builder.vert((apex[0], apex[1], back(0)))
    for verts, tip, material in [(front, front_apex, paint), (rear, rear_apex, wood)]:
        for k in range(m - 1):
            for j in range(columns - 1):
                builder.face([verts[k][j], verts[k][j + 1], verts[k + 1][j + 1], verts[k + 1][j]], material)
        for j in range(columns - 1):
            builder.face([verts[m - 1][j], verts[m - 1][j + 1], tip], material)
    loop = [(0, j) for j in range(columns)] + [(k, columns - 1) for k in range(1, m)] + [None] + [(k, 0) for k in range(m - 1, 0, -1)]
    pick = (lambda verts, tip, key: tip if key is None else verts[key[0]][key[1]])
    for a, b in zip(loop, loop[1:] + loop[:1]):
        builder.face([pick(front, front_apex, a), pick(front, front_apex, b), pick(rear, rear_apex, b), pick(rear, rear_apex, a)], wood)
    # Rim: a bevelled iron band swept around the outline, wrapping the front edge.
    outline = [apex if key is None else grid[key[0]][key[1]] for key in loop]
    section = [(.004, -.003), (.004, thick + .004), (-.003, thick + .008), (-rim, thick + .0045), (-rim - .004, thick - .001), (-rim * .6, -.003)]
    rings = []
    for i, point in enumerate(outline):
        prev, nxt = outline[i - 1], outline[(i + 1) % len(outline)]
        normals = []
        for a, b in [(prev, point), (point, nxt)]:
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            normals.append((-dy / length, dx / length))  # outward for the clockwise outline
        nx, ny = normals[0][0] + normals[1][0], normals[0][1] + normals[1][1]
        length = math.hypot(nx, ny)
        nx, ny = nx / length, ny / length
        miter = min(2.0, 1 / max(.5, nx * normals[0][0] + ny * normals[0][1]))
        ring = []
        for o, dz in section:
            x, y = point[0] + nx * o * miter, point[1] + ny * o * miter
            ring.append((x, y, back(x) + dz))
        rings.append(ring)
    builder.loft(rings, iron, cyclic=True)
    # Boss: a lathed dome on the face over the handle.
    r, base, n = p["bossRadius"], back(0) + thick, 16
    # (radius fraction, height above the face); the flange rings follow the face's curvature.
    profile = [(1, -.003, True), (1, .005, True), (.8, .008, True), (.7, .22 * r, False), (.5, .36 * r, False), (.25, .43 * r, False)]
    rings = []
    for a, dz, follow in profile:
        ring = []
        for i in range(n):
            x, y = r * a * math.cos(2 * math.pi * i / n), r * a * math.sin(2 * math.pi * i / n)
            ring.append((x, y, (back(x) + thick if follow else base) + dz))
        rings.append(ring)
    rings.append([(0, 0, base + .45 * r)])
    builder.loft(rings, iron)
    # Hand handle along X through the origin, its ends set into the board.
    ends = .065
    handle = [(-ends, 0, back(-ends) + .003), (-.06, 0, .012), (-.045, 0, 0), (.045, 0, 0), (.06, 0, .012), (ends, 0, back(ends) + .003)]
    builder.sweep(handle, chamfer_rect(.011, .011, .004), leather)
    # Forearm strap toward +Y around a ~5 cm forearm (with bracer) whose back rests against the board.
    strap_y, radius, centre = .16, .048, .028
    strap = [(-radius, strap_y, back(-radius) + .003)]
    strap += [(radius * math.cos(math.pi + math.pi * i / 6), strap_y, centre + radius * math.sin(math.pi + math.pi * i / 6)) for i in range(7)]
    strap.append((radius, strap_y, back(radius) + .003))
    builder.sweep(strap, chamfer_rect(.018, .003, .0015), leather)


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
    (sword if piece == "sword.arming" else shield)(builder, p)
    bm = builder.bm
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="FIXED", ngon_method="EAR_CLIP")
    for face in bm.faces:
        face.smooth = True
    for edge in bm.edges:
        faces = edge.link_faces
        edge.smooth = len(faces) == 2 and faces[0].material_index == faces[1].material_index and edge.calc_face_angle(math.pi) < SHARP_ANGLE
    triangles = len(bm.faces)
    if triangles > p["maxTriangles"]:
        bm.free()
        raise ValueError("weapon piece exceeds its maxTriangles budget")
    mesh = bpy.data.meshes.new(f"{piece}-geometry")
    bm.to_mesh(mesh)
    bm.free()
    names = PIECE_MATERIALS[piece]
    for name in names:
        mesh.materials.append(material(name))
    obj = bpy.data.objects.new(piece, mesh)
    grip = bpy.data.objects.new("grip", None)
    for item in (obj, grip):
        bpy.context.scene.collection.objects.link(item)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    grip.select_set(True)
    bpy.context.view_layer.objects.active = obj
    lows = [min(point[i] for point in builder.points) for i in range(3)]
    highs = [max(point[i] for point in builder.points) for i in range(3)]
    geometry = b"".join(float(c).hex().encode("ascii") + b"\n" for v in mesh.vertices for c in v.co)
    geometry += b"".join((",".join(str(i) for i in f.vertices) + ":" + str(f.material_index) + "\n").encode("ascii") for f in mesh.polygons)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "weapon-v1", "parameters": p, "piece": piece, "role": ROLES[piece], "unit": "meter",
            "axes": "right-handed-y-up", "origin": "grip", "gripNode": "grip", "triangleCount": triangles,
            "bounds": {"min": [round(c, 6) for c in lows], "max": [round(c, 6) for c in highs]},
            "materials": names, "geometrySha256": hashlib.sha256(geometry).hexdigest()}
