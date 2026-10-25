"""Hand-modelled hair and beards for the male figure (#380), in the Greyhaven Marshal's chunky-lock style.

Every piece is a closed shell fitted to the Universal Base Characters head in its rest pose (Blender axes: Z up, front
is -Y), riding the ``Head`` bone. A shell is a grid of directions from the head centre: the inner surface lies just over
the skin (found by casting from the centre), the outer surface stands off it by a thickness that

- swells into ridges, one per lock, so the mass reads as separate locks like the Marshal's parted hair;
- thins to a millimetre at the edges that meet the skin (hairline, top of the beard on the cheeks), so no edge reads
  as a mask or a helmet rim;
- ends in pointed clumps where hair hangs free (nape, beard hem, moustache ends).

UVs run along the locks into the strand column of ``T_Hair_1`` (u 0.73-0.97), so the shared hair texture and the hair
tint apply as for the pack's own hairstyles.

Hairstyles (each a cap whose locks run from the hairline to a pole direction):

- ``hair.balding``: a horseshoe band from temple to temple round the back, with a clean tapered top edge;
- ``hair.receding``: a short cap with an M-shaped hairline (high temples);
- ``hair.swept``: short sides and a swept-back top with volume over the forehead;
- ``hair.tied``: a close cap whose locks run to the nape, gathered by a leather tie into a tail of four locks.

Beards (cylindrical grids round the head's vertical axis that hang below the chin): ``beard.full``, ``beard.long``,
``beard.short`` and ``beard.goatee``; moustaches: ``beard.moustache`` and ``beard.walrus``. Stubble is not geometry; it
is the ``stubble`` skin overlay of ``skin_overlays.py``.
"""
import math

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

CENTRE = Vector((0, .005, 1.70))  # the cranium's centre in rest model space
STRANDS = (.73, .97, .05, .95)  # the strand column of T_Hair_1: u0, u1, v0, v1

# The natural hairline of the male head as elevation (degrees) per azimuth (degrees from the front, symmetric),
# measured from the pack's Hair_Buzzed cap: forehead, temples, sideburn, over the ear, behind it and the nape.
HAIRLINE = [(0, 39), (20, 42), (35, 40), (50, 18), (62, -6), (72, -13), (80, -6), (87, 11), (100, 13), (112, 1),
            (125, -22), (140, -32), (180, -35)]


def table(points, x):
    x = abs(x)
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return points[-1][1]


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def direction(theta, phi):
    t, p = math.radians(theta), math.radians(phi)
    return Vector((math.sin(t) * math.cos(p), -math.cos(t) * math.cos(p), math.sin(p)))


def slerp(a, b, u):
    angle = a.angle(b)
    if angle < 1e-6:
        return a.copy()
    s = math.sin(angle)
    return (a * (math.sin((1 - u) * angle) / s) + b * (math.sin(u * angle) / s)).normalized()


def lock(theta, count, span=360.0):
    """0 in the valley between locks, 1 on a lock's crest."""
    return .5 + .5 * math.cos(2 * math.pi * count * theta / span)


class Head:
    def __init__(self, obj):
        m = obj.matrix_world
        verts = [m @ v.co for v in obj.data.vertices]
        self.tree = BVHTree.FromPolygons(verts, [tuple(p.vertices) for p in obj.data.polygons])

    def radial(self, origin, d):
        """Distance from origin to the skin along d."""
        hit = self.tree.ray_cast(origin, d, .4)
        if hit[0] is not None:
            return hit[3]
        near = self.tree.find_nearest(origin + d * .09)
        return (near[0] - origin).dot(d) if near[0] is not None else .09

    def skin(self, d):
        return CENTRE + d * self.radial(CENTRE, d)


def build_shell(name, outer, inner, uvs, closed, materials=None, extra=None):
    """A closed shell from row-major grids of outer and inner points (rows are along the locks, columns across)."""
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    rows, cols = len(outer), len(outer[0])
    vo = [[bm.verts.new(p) for p in row] for row in outer]
    vi = [[bm.verts.new(p) for p in row] for row in inner]
    span = cols if closed else cols - 1

    def face(verts, coords):
        try:
            f = bm.faces.new(verts)
        except ValueError:
            return
        f.smooth = True
        for loop, uv in zip(f.loops, coords):
            loop[uv_layer].uv = uv
        return f

    def uv(i, j):
        return uvs[i][j % cols]

    for i in range(rows - 1):
        for j in range(span):
            k = (j + 1) % cols
            a, b = uv(i, j), uv(i, k)
            c, d = uv(i + 1, k), uv(i + 1, j)
            face((vo[i][j], vo[i][k], vo[i + 1][k], vo[i + 1][j]), (a, b, c, d))
            face((vi[i + 1][j], vi[i + 1][k], vi[i][k], vi[i][j]), (d, c, b, a))
    # Bands on the open edges: the first and last rows, and the first and last columns of an open grid.
    edges = []
    for j in range(span):
        k = (j + 1) % cols
        edges.append(((0, j), (0, k), True))
        edges.append(((rows - 1, j), (rows - 1, k), False))
    if not closed:
        for i in range(rows - 1):
            edges.append(((i, 0), (i + 1, 0), False))
            edges.append(((i, cols - 1), (i + 1, cols - 1), True))
    for (i0, j0), (i1, j1), forward in edges:
        quad = (vo[i0][j0], vo[i1][j1], vi[i1][j1], vi[i0][j0])
        coords = (uv(i0, j0), uv(i1, j1), uv(i1, j1), uv(i0, j0))
        if not forward:
            quad, coords = quad[::-1], coords[::-1]
        face(quad, coords)
    if extra:
        extra(bm, uv_layer)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for m in materials or []:
        mesh.materials.append(m)
    return mesh


def strand_uv(across, along):
    """Across the locks the u coordinate runs back and forth over the strand column (no seams); along them, v."""
    u0, u1, v0, v1 = STRANDS
    return (u0 + (u1 - u0) * (1 - abs(2 * (across % 1.0) - 1)), v0 + (v1 - v0) * along)


# --- Caps ----------------------------------------------------------------------------------------------------------

def cap(head, name, edge, pole, thickness, locks, ridge=.45, theta=(-180, 180), top=None, cols=96, rows=22,
        clumps=0.0, clump_from=110, clear=.0012):
    """A hair cap: columns over azimuth ``theta``, rows from the hairline ``edge(az)`` (elevation, degrees) to the
    ``pole`` direction, or for a band to the upper edge ``top(az)``. ``thickness(az, u)`` is the lock height over the
    skin before the ridges; ``clumps`` (degrees) points the hairline down at each lock beyond ``clump_from``."""
    closed = theta == (-180, 180)
    outer, inner, uvs = [], [], []
    n = cols if closed else cols + 1
    azimuths = [theta[0] + (theta[1] - theta[0]) * j / (cols if closed else cols) for j in range(n)]
    for i in range(rows + 1):
        u = i / rows
        o_row, i_row, uv_row = [], [], []
        for raw in azimuths:
            az = (raw + 180) % 360 - 180
            crest = lock(az, locks)
            low = edge(az) - clumps * crest ** 2 * smooth((abs(az) - clump_from) / 20)
            start = direction(az, low)
            if top is not None:
                d = direction(az, low + (top(az) - low) * u)
            else:
                d = slerp(start, pole, u)
            r = head.radial(CENTRE, d)
            h = thickness(az, u) * (1 - ridge * (1 - crest))
            o_row.append(CENTRE + d * (r + clear + max(h, .0008)))
            i_row.append(CENTRE + d * (r + clear * .5))
            uv_row.append(strand_uv(locks * (raw - theta[0]) / 360 * 2, u))
        outer.append(o_row)
        inner.append(i_row)
        uvs.append(uv_row)
    return outer, inner, uvs, closed


def edge_taper(u, soft=.12):
    return .12 + .88 * smooth(u / soft)


def hairline(az):
    return table(HAIRLINE, az)


def hair_balding(head):
    def top(az):
        # A clean rounded edge: low over the ears, rising to a gentle arch over the back of the head.
        a = abs(az)
        return max(table(HAIRLINE, a) + 3, 4 + 9 * smooth((a - 80) / 70))

    def thickness(az, u):
        a = abs(az)
        end = smooth((a - 64) / 14)
        return .0075 * end * (.15 + .85 * math.sin(math.pi * min(1, u * 1.1)) ** .5)

    return cap(head, "hair.balding", hairline, None, thickness, locks=24, theta=(64, 296), top=top, cols=80, rows=12,
               clumps=5, clump_from=110)


def hair_receding(head):
    line = [(0, 41), (12, 48), (24, 60), (34, 60), (46, 32), (56, 8), (62, -4), (72, -11), (80, -6), (87, 11), (100, 13),
            (112, 1), (125, -22), (140, -32), (180, -35)]

    def thickness(az, u):
        return .0065 * edge_taper(u)
    return cap(head, "hair.receding", lambda az: table(line, az), direction(180, 55), thickness, locks=30, clumps=5, clump_from=115)


def hair_swept(head):
    def thickness(az, u):
        front = 1 - smooth((abs(az) - 25) / 70)
        volume = .006 + .016 * front * math.sin(math.pi * min(1, u * 1.4)) ** .7
        sides = 1 - .35 * smooth((abs(az) - 60) / 30) * (1 - smooth((abs(az) - 120) / 30))
        return volume * sides * edge_taper(u, .1)
    return cap(head, "hair.swept", hairline, direction(180, -20), thickness, locks=28, ridge=.5, clumps=6, clump_from=120)


GATHER = (180, -12)  # where the tied hair is gathered at the nape: azimuth, elevation


def hair_tied(head):
    def thickness(az, u):
        return (.0045 + .002 * u) * edge_taper(u, .1)
    return cap(head, "hair.tied", hairline, direction(*GATHER), thickness, locks=32, ridge=.4)


def tail(head, material_index):
    """The tie and the tail for hair.tied: a leather band round the gathered hair and four tapering locks."""
    d = direction(*GATHER)
    root = CENTRE + d * (head.radial(CENTRE, d) + .012)
    down = Vector((0, .35, -1)).normalized()

    def extra(bm, uv_layer):
        def tube(path, radii, sides, mat, uv_across, flat=.75):
            rings = []
            for k, (c, r) in enumerate(zip(path, radii)):
                t = (path[min(k + 1, len(path) - 1)] - path[max(k - 1, 0)]).normalized()
                x = Vector((1, 0, 0))
                y = t.cross(x).normalized()
                x = y.cross(t).normalized()
                rings.append([bm.verts.new(c + (x * math.cos(a) + y * math.sin(a) * flat) * max(r, 1e-4))
                              for a in (2 * math.pi * j / sides for j in range(sides))])
            for k in range(len(rings) - 1):
                for j in range(sides):
                    f = bm.faces.new((rings[k][j], rings[k][(j + 1) % sides], rings[k + 1][(j + 1) % sides], rings[k + 1][j]))
                    f.smooth, f.material_index = True, mat
                    for loop, (a, b) in zip(f.loops, ((j, k), (j + 1, k), (j + 1, k + 1), (j, k + 1))):
                        loop[uv_layer].uv = strand_uv(uv_across + .25 * a / sides, b / (len(rings) - 1))
            cap_face = bm.faces.new(rings[0][::-1])
            cap_face.material_index = mat
        # Four locks leave the tie side by side and fan out a little toward their points.
        for n, (sx, sy) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
            spread = Vector((sx * .0065, sy * .005, 0))
            path, radii = [], []
            for k in range(9):
                t = k / 8
                bend = Vector((0, -.02 * t * t, 0))
                path.append(root + down * (.012 + .15 * t) + spread * (1 + .9 * t) + bend)
                radii.append(.013 * (1 - t ** 2.2) + .0008)
            tube(path, radii, 8, 0, .25 * n)
        # The leather tie: a short band round all four.
        band = [root + down * (.002 + .007 * k) for k in range(4)]
        tube(band, [.0175, .019, .019, .0175], 14, material_index, 0, flat=.85)
    return extra


# --- Beards ---------------------------------------------------------------------------------------------------------

# Heights in metres at the front and at the sides (by |azimuth| / reach), the reach in degrees, the full lock height
# ``depth``, the hanging slope below the chin, how far the clumps point down, and the lock count over the reach.
BEARDS = {
    "beard.full": {"reach": 96, "top": (1.6, 1.7), "hem": (1.5, 1.6), "depth": .013, "slope": .25, "clump": .02, "locks": 8},
    "beard.long": {"reach": 96, "top": (1.6, 1.7), "hem": (1.39, 1.58), "depth": .017, "slope": .3, "clump": .035, "locks": 8},
    "beard.short": {"reach": 94, "top": (1.6, 1.69), "hem": (1.55, 1.605), "depth": .007, "slope": .9, "clump": .008, "locks": 11},
    "beard.goatee": {"reach": 36, "top": (1.599, 1.6), "hem": (1.52, 1.565), "depth": .01, "slope": .45, "clump": .014, "locks": 3},
}
MOUSTACHES = {
    "beard.moustache": {"reach": 42, "rows": (1.616, 1.646), "droop": .03, "depth": .007, "clump": .006, "locks": 5},
    "beard.walrus": {"reach": 52, "rows": (1.6, 1.648), "droop": .04, "depth": .011, "clump": .012, "locks": 7},
}


def beard(head, spec, cols=None, rows=24):
    reach = spec["reach"]
    cols = cols or max(24, int(reach * 2 / 2.5))
    axis_y = CENTRE.y
    thetas = [-reach + 2 * reach * j / cols for j in range(cols + 1)]
    grid_o, grid_i, uvs = [], [], []
    # Radii on a fine height table per column, hung below the chin.
    zs = [spec["hem"][0] - spec["clump"] - .01 + .003 * k for k in range(int((1.725 - spec["hem"][0] + spec["clump"] + .01) / .003) + 1)]
    columns = []
    for az in thetas:
        h = Vector((math.sin(math.radians(az)), -math.cos(math.radians(az)), 0))
        skin = [head.radial(Vector((0, axis_y, z)), h) for z in zs]
        columns.append((h, skin))
    for i in range(rows + 1):
        v = i / rows
        o_row, i_row, uv_row = [], [], []
        for j, az in enumerate(thetas):
            k = min(1.0, abs(az) / reach)
            crest = lock(az + reach, spec["locks"], 2 * reach)
            hem = spec["hem"][0] + (spec["hem"][1] - spec["hem"][0]) * k ** .7 - spec["clump"] * crest ** 2 * (1 - .6 * k)
            top = spec["top"][0] + (spec["top"][1] - spec["top"][0]) * k ** 1.6
            z = hem + (top - hem) * v
            h, skin = columns[j]
            # Lock height: full over the jaw and the hanging part, thinning to a millimetre at the top edge on the
            # cheeks and at the sides of the reach, ridged per lock.
            depth = spec["depth"] * (1 - smooth((v - .5) / .5) * .93) * (1 - .8 * smooth((k - .85) / .15))
            depth *= 1 - .45 * (1 - crest)
            radii = []
            for zz, s in zip(zs, skin):
                radii.append(s + .0012 + depth)
            # Hang below the chin: the beard loses at most slope metres of radius per metre downward.
            for n in range(len(zs) - 2, -1, -1):
                radii[n] = max(radii[n], radii[n + 1] - spec["slope"] * (zs[n + 1] - zs[n]))
            r = interp(z, zs, radii)
            s = interp(z, zs, skin)
            inner = max(s + .0006, r - max(depth, .02 * (1 - smooth((v - .3) / .3))))
            base = Vector((0, axis_y, z))
            o_row.append(base + h * r)
            i_row.append(base + h * min(inner, r - .0004))
            uv_row.append(strand_uv(spec["locks"] * (az + reach) / (2 * reach) + .5, v))
        grid_o.append(o_row)
        grid_i.append(i_row)
        uvs.append(uv_row)
    return grid_o, grid_i, uvs, False


def moustache(head, spec, cols=26, rows=8):
    reach = spec["reach"]
    low, high = spec["rows"]
    grid_o, grid_i, uvs = [], [], []
    for i in range(rows + 1):
        v = i / rows
        o_row, i_row, uv_row = [], [], []
        for j in range(cols + 1):
            az = -reach + 2 * reach * j / cols
            k = abs(az) / reach
            crest = lock(az + reach, spec["locks"], 2 * reach)
            bottom = low - spec["droop"] * k ** 2 - spec["clump"] * crest ** 2
            z = bottom + (high - (spec["droop"] * .35) * k ** 2 - bottom) * v
            h = Vector((math.sin(math.radians(az)), -math.cos(math.radians(az)), 0))
            base = Vector((0, CENTRE.y, z))
            s = head.radial(base, h)
            depth = spec["depth"] * (1 - .9 * smooth((v - .55) / .45)) * (1 - .5 * k) * (1 - .4 * (1 - crest))
            o_row.append(base + h * (s + .0012 + depth))
            i_row.append(base + h * (s + .0006))
            uv_row.append(strand_uv(spec["locks"] * (az + reach) / (2 * reach) + .5, v))
        grid_o.append(o_row)
        grid_i.append(i_row)
        uvs.append(uv_row)
    return grid_o, grid_i, uvs, False


def interp(x, xs, ys):
    if x <= xs[0]:
        return ys[0]
    for n in range(len(xs) - 1):
        if x <= xs[n + 1]:
            t = (x - xs[n]) / (xs[n + 1] - xs[n])
            return ys[n] + (ys[n + 1] - ys[n]) * t
    return ys[-1]


# --- Assembly --------------------------------------------------------------------------------------------------------

HAIRSTYLES = {"hair.balding": hair_balding, "hair.receding": hair_receding, "hair.swept": hair_swept, "hair.tied": hair_tied}


def tie_material():
    material = bpy.data.materials.get("hair.tie") or bpy.data.materials.new("hair.tie")
    material.use_nodes = True
    shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = (.06, .03, .015, 1)
    shader.inputs["Roughness"].default_value = .7
    return material


def make(head_obj, rig, hair_material, collection, names=None):
    """Builds every hairstyle and beard (or only ``names``) as objects riding rig's Head bone; returns them by name."""
    head = Head(head_obj)
    made = {}
    jobs = {**{k: (lambda f=f: f(head)) for k, f in HAIRSTYLES.items()},
            **{k: (lambda s=s: beard(head, s)) for k, s in BEARDS.items()},
            **{k: (lambda s=s: moustache(head, s)) for k, s in MOUSTACHES.items()}}
    for name, job in jobs.items():
        if names and name not in names:
            continue
        outer, inner, uvs, closed = job()
        materials = [hair_material]
        extra = None
        if name == "hair.tied":
            materials.append(tie_material())
            extra = tail(head, 1)
        mesh = build_shell(name, outer, inner, uvs, closed, materials, extra)
        obj = bpy.data.objects.new(name, mesh)
        collection.objects.link(obj)
        if rig is not None:
            world = obj.matrix_world.copy()
            obj.parent, obj.parent_type, obj.parent_bone = rig, "BONE", "Head"
            bpy.context.view_layer.update()
            obj.matrix_world = world
        made[name] = obj
    return made


# --- Recipe --------------------------------------------------------------------------------------------------------

BEARD_ENTRY = "facial-hair.beards"
PIECES = (*HAIRSTYLES, BEARD_ENTRY)


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "piece"} or p["schemaVersion"] != 1 or p["piece"] not in PIECES:
        raise ValueError(f"hair and beards take schemaVersion 1 and a piece of {PIECES}")
    if set(inputs) != {"body", "material", "variety", "face"}:
        raise ValueError("hair and beards take exactly the inputs body, material, variety and face")


def generate(output_path, arguments, inputs):
    """One hairstyle, or every beard and moustache as one entry, fitted to ``body``'s head, with the build keys (and
    for facial hair the age keys) of ``male_variety.py``. ``material`` is the pack's Hair_Buzzed, whose ``MI_Hair_1``
    (T_Hair_1 base colour and normal map) the pieces wear. The pieces are static meshes in the rest model space."""
    validate(arguments, inputs)
    variety = inputs.load_source("variety")
    face = inputs.load_source("face")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    body = variety["import_glb"](inputs["body"])
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    rig = next(o for o in body if o.type == "ARMATURE")
    rig.data.pose_position = "REST"
    bpy.context.view_layer.update()
    source = variety["import_glb"](inputs["material"])
    hair_material = next(m for o in source if o.type == "MESH" for m in o.data.materials if m and m.name.startswith("MI_Hair_1"))
    for other in bpy.data.materials:
        if other is not hair_material and other.name == "MI_Hair_1":
            other.name = "body.MI_Hair_1"
    hair_material.name = "MI_Hair_1"
    for o in source:
        bpy.data.objects.remove(o)
    named = {o.name: o for o in body if o.type == "MESH"}
    piece = arguments["piece"]
    names = set(BEARDS) | set(MOUSTACHES) if piece == BEARD_ENTRY else {piece}
    made = make(named["SuperHero_Male"], None, hair_material, bpy.context.scene.collection, names)
    pieces = list(made.values())
    body_meshes = [o for o in body if o.type == "MESH" and o.name.split(".")[0] in variety["BODY_MESHES"]]
    lm, age = variety["add_age_keys"](named["SuperHero_Male"], named["Eyes"], named["Eyebrows"], face["landmarks"],
                                      keyed=pieces if piece == BEARD_ENTRY else [])
    build = variety["add_build_keys"](rig, pieces, lm, body=body_meshes)
    bpy.ops.object.select_all(action="DESELECT")
    for o in pieces:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True, export_texcoords=True,
        export_normals=True, export_tangents=False, export_animations=False, export_skins=False, export_morph=True,
        export_morph_normal=True, export_cameras=False, export_lights=False, export_extras=False, export_image_format="AUTO")
    return {"recipe": "hair-beards-v1", "piece": piece,
            "pieces": [{"node": o.name, "triangles": sum(len(p.vertices) - 2 for p in o.data.polygons),
                        "materials": [m.name for m in o.data.materials]} for o in sorted(pieces, key=lambda o: o.name)],
            "age": age, "build": build}
