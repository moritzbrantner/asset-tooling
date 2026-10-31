"""Battle Royale fortress kit (asset-tooling#445, pass 2 #459): authored pieces over the shared graybox collision.

One run builds one piece at one level of detail. Every piece dresses one authoritative collider box (or ramp wedge,
or lift pillar) of ``battle_royale_core::arena`` (docs/fortress-kit.md), built in that box's frame at its ``size``.

The fit rule (#459): what a character stands on or is blocked by matches the collider within 5 cm. Walkable tops and
ramp slopes are flush with the box, nothing stands in the 2.2 m of head room above them, and the blocking wall faces
lie within 5 cm of the box faces (the rubble face is 4 cm in, ``INSET``; openings such as arrow slits and windows are
cut deeper). Decoration may leave the box where it cannot mislead play: full-height merlons above the parapet,
battered plinths, buttresses and rubble at the wall feet, corbels and machicolations below the walks, timber
hoardings outside the parapet, pavilion roofs above head height, the gatehouse's flanking towers and machicolated
gallery, bartizans at the keep's corners, the bridges' deep stringers, and moss and streak decals. A drop never
gets a drawn barrier the collider does not have: the tower tops and the keep roof stay open at their edges.

Frame: metres, glTF right-handed +Y up. The origin is the base centre of the fitted box. Outward (the side facing away
from the arena centre for the south side's bodies) is -Z; ramps rise towards +Z.

Materials: four tileable CC0 Poly Haven PBR sets (colour, OpenGL normal, roughness) declared as inputs, resized to
1024 px and shared by every piece and level, so a ``gltf-resources-v1`` bundle stores each image once:

- ``wall``: ``broken_wall`` grey rubble, the large wall faces;
- ``trim``: ``japanese_stone_wall`` ashlar, the dressings (and ``trimDark``, the same maps darker);
- ``floor``: ``stone_tiles_02`` flagstones, every walkable top;
- ``wood``: ``old_planks_02`` planks (``woodDark`` and the shingle ``roof`` darker), timber, hoardings and roofs.

The rubble and ashlar colour maps have their mortar darkened and their proud stone edges lifted from the sets'
displacement maps (inputs ``wallHeight`` and ``trimHeight``, used at build time only). Repetition is broken by
COLOR_0, which glTF multiplies into the base colour: block-scale tint per shell, large soft value-noise patches,
damp darkening and moss at the wall feet, moss on upward ledges and rain streaks on the faces. Large faces are cut
on a 2 m grid at LOD0 so the vertex colour has the resolution for it. ``grime`` decals (one generated RGBA atlas
of streaks and moss, alpha blended) add sharper streaks under the drip courses and slits and moss on the plinths.

Levels of detail (``lod``): 0 is the full piece; 1 drops rubble, decals, quoins, corbels, slit surrounds, voussoir
joints, braces and the colour grid; 2 keeps only the main masses, the walkable tops, the roofs, the roof openings and
the materials.

No randomness: variation comes from SHA-256 of fixed keys, Blender's fixed Perlin noise and numpy's legacy
``RandomState``. ``build(arguments, inputs, collection)`` also runs in a live Blender session (``runpy.run_path``).
"""
import hashlib
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector, noise

RECIPE = "fortress-kit-v2"
PARTS = (
    "curtain-wall", "gate-lintel", "parapet", "corner-tower", "keep-wall-long", "keep-wall-short", "hall-wall",
    "door-lintel", "keep-roof", "central-tower", "bridge", "lift-column", "ramp-courtyard", "ramp-tower", "ramp-keep",
    "lift-courtyard", "lift-tower",
)
# Where the arena ground (y = 0) lies in each piece's frame: drives damp and moss at the wall feet.
GROUND = {"gate-lintel": -6.0, "parapet": -8.0, "central-tower": -8.0, "keep-roof": -7.5, "bridge": -7.5,
          "ramp-tower": -8.0, "lift-tower": -99.0, "lift-courtyard": -99.0, "door-lintel": -6.0}
INSET = 0.04
TEXTURE_EDGE = 1024
GRIME_EDGE = 512
JPEG_QUALITY = 88
SETS = ("wall", "trim", "floor", "wood")
MAPS = ("Colour", "Normal", "Roughness")
HEIGHTS = ("wallHeight", "trimHeight")
INPUTS = tuple(f"{s}{m}" for s in SETS for m in MAPS) + HEIGHTS
# Material -> (texture set, metres per tile, colour factor (into COLOR_0), stone?).
TEXTURED = {
    "wall": ("wall", 3.4, (0.9, 0.88, 0.85), True),
    "trim": ("trim", 2.6, (0.95, 0.93, 0.88), True),
    "trimDark": ("trim", 2.6, (0.55, 0.54, 0.52), True),
    "floor": ("floor", 3.0, (0.74, 0.72, 0.68), True),
    "wood": ("wood", 2.0, (0.86, 0.78, 0.68), False),
    "woodDark": ("wood", 2.0, (0.42, 0.36, 0.3), False),
    "roof": ("wood", 1.0, (0.4, 0.33, 0.29), False),
}
# Material -> (linear base colour, metallic, roughness).
PLAIN = {
    "iron": ((0.035, 0.036, 0.04), 0.85, 0.55),
    "cloth": ((0.035, 0.06, 0.12), 0.0, 0.9),
    "clothTrim": ((0.5, 0.43, 0.3), 0.0, 0.85),
    "void": ((0.012, 0.011, 0.01), 0.0, 1.0),
}
MATERIALS = tuple(TEXTURED) + tuple(PLAIN) + ("grime",)
MOSS = (0.36, 0.42, 0.2)
DAMP = (0.62, 0.6, 0.56)


def validate(p, inputs):
    keys = {"schemaVersion", "part", "lod", "size"}
    if type(p) is not dict or not keys <= set(p) or not set(p) <= keys | {"holes", "hatches"}:
        raise ValueError("fortress kit takes schemaVersion, part, lod and size (and holes, hatches for the keep roof)")
    if p["schemaVersion"] != 1 or p["part"] not in PARTS or p["lod"] not in (0, 1, 2):
        raise ValueError(f"fortress kit: schemaVersion 1, part in {PARTS}, lod 0..2")
    size = p["size"]
    if type(size) is not list or len(size) != 3 or not all(type(v) in (int, float) and 0.05 <= v <= 200 for v in size):
        raise ValueError("fortress kit size is [width, height, depth] in metres")
    for key in ("holes", "hatches"):
        if key in p and (p["part"] != "keep-roof" or type(p[key]) is not list
                         or not all(type(r) is list and len(r) == 4 for r in p[key])):
            raise ValueError(f"fortress kit {key} are [x0, z0, x1, z1] rectangles of the keep roof")
    if set(inputs) != set(INPUTS):
        raise ValueError(f"fortress kit takes exactly the inputs {INPUTS}")


def rnd(*keys):
    """A deterministic float in [0, 1) for the given keys."""
    digest = hashlib.sha256("/".join(str(k) for k in keys).encode("ascii")).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def smoothstep(e0, e1, v):
    t = min(1.0, max(0.0, (v - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def clamp(v, lo=0.0, hi=1.0):
    return min(hi, max(lo, v))


# ---------------------------------------------------------------------------------------------------------------------
# Geometry: closed shells in the glTF frame, gathered per layer, plus open decal quads.

def bl(p):
    """A glTF (+Y up) point in Blender's +Z-up frame."""
    return Vector((p[0], -p[2], p[1]))


def gl(v):
    return (v.x, v.z, -v.y)


class Kit:
    def __init__(self, lod, part):
        self.lod = lod
        self.part = part
        self.solid = []    # unioned
        self.cuts = []     # subtracted from the union
        self.details = []  # joined as separate shells
        self.decals = []   # (four corners, uv rect), single-sided quads facing their winding
        self.count = 0

    def shell(self, layer, corners, faces, tint=None):
        """Add a closed shell; each gets a block tint and a UV offset so neighbouring blocks never repeat exactly."""
        self.count += 1
        key = (self.part, layer, self.count)
        t = tint if tint is not None else (1.0 if layer == "solid" else 0.84 + 0.3 * rnd(*key, "tint"))
        getattr(self, layer).append((corners, faces, t, (rnd(*key, "u"), rnd(*key, "v"))))

    def box(self, lo, hi, side, top=None, bottom=None, layer="solid", chamfer=0.0, tint=None):
        if any(hi[i] - lo[i] <= 1e-6 for i in range(3)):
            return
        if chamfer > 0 and self.lod == 0:
            self.chamfered(lo, hi, side, top or side, bottom or side, chamfer, layer, tint)
            return
        x0, y0, z0 = lo
        x1, y1, z1 = hi
        corners = [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), (x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)]
        faces = [((0, 1, 2, 3), bottom or side), ((4, 7, 6, 5), top or side), ((0, 4, 5, 1), side), ((1, 5, 6, 2), side),
                 ((2, 6, 7, 3), side), ((3, 7, 4, 0), side)]
        self.shell(layer, corners, faces, tint)

    def chamfered(self, lo, hi, side, top, bottom, chamfer, layer, tint):
        """A box with every edge chamfered: the bevel catches the light like worn stone."""
        h = [(hi[i] - lo[i]) / 2 for i in range(3)]
        c0 = [(hi[i] + lo[i]) / 2 for i in range(3)]
        c = min(chamfer, min(h) * 0.4)
        verts, index = [], {}
        for corner in range(8):
            s = [1 if corner & (1 << i) else -1 for i in range(3)]
            for face_axis in range(3):
                index[(corner, face_axis)] = len(verts)
                verts.append(tuple(c0[i] + s[i] * (h[i] if i == face_axis else h[i] - c) for i in range(3)))
        faces = []
        sgn = lambda c_, axis: 1 if c_ & (1 << axis) else -1
        for axis in range(3):
            for sign in (-1, 1):
                cs = [c_ for c_ in range(8) if sgn(c_, axis) == sign]
                a, b = [i for i in range(3) if i != axis]
                ring = sorted(cs, key=lambda c_: math.atan2(sgn(c_, b), sgn(c_, a)))
                material = side if axis != 1 else (top if sign > 0 else bottom)
                faces.append((tuple(index[(c_, axis)] for c_ in ring), material))
        for a in range(3):
            for b in range(a + 1, 3):
                free = 3 - a - b
                for sa in (-1, 1):
                    for sb in (-1, 1):
                        cs = [c_ for c_ in range(8) if sgn(c_, a) == sa and sgn(c_, b) == sb]
                        c_lo, c_hi = sorted(cs, key=lambda c_: c_ & (1 << free))
                        faces.append(((index[(c_lo, a)], index[(c_hi, a)], index[(c_hi, b)], index[(c_lo, b)]), side))
        for corner in range(8):
            faces.append(((index[(corner, 0)], index[(corner, 1)], index[(corner, 2)]), side))
        self.shell(layer, verts, faces, tint)

    def prism(self, section, x0, x1, materials, layer="solid", tint=None):
        """A prism along X from a (z, y) section; ``materials`` per section edge, then the ends (or one material)."""
        n = len(section)
        if isinstance(materials, str):
            materials = [materials] * (n + 1)
        corners = [(x0, y, z) for z, y in section] + [(x1, y, z) for z, y in section]
        faces = [(tuple(reversed(range(n))), materials[n]), (tuple(range(n, 2 * n)), materials[n])]
        for i in range(n):
            j = (i + 1) % n
            faces.append(((i, j, n + j, n + i), materials[i]))
        self.shell(layer, corners, faces, tint)

    def frustum(self, bottom, top, y0, y1, side, cap=None, base=None, layer="details", tint=None):
        """A vertical frustum between two (x, z) outlines with the same vertex count (a prism when they agree)."""
        n = len(bottom)
        corners = [(x, y0, z) for x, z in bottom] + [(x, y1, z) for x, z in top]
        faces = [(tuple(range(n)), base or side), (tuple(range(n, 2 * n)), cap or side)]
        for i in range(n):
            j = (i + 1) % n
            faces.append(((i, j, n + j, n + i), side))
        self.shell(layer, corners, faces, tint)

    def pyramid(self, outline, y0, apex, material, base="woodDark", layer="details"):
        n = len(outline)
        corners = [(x, y0, z) for x, z in outline] + [apex]
        faces = [(tuple(range(n)), base)] + [((i, (i + 1) % n, n), material) for i in range(n)]
        self.shell(layer, corners, faces)

    def beam(self, a, b, width, material="woodDark", layer="details", up=(0, 1, 0)):
        """A square-section beam from a to b (glTF points)."""
        a, b = Vector(a), Vector(b)
        d = (b - a).normalized()
        ref = Vector(up) if abs(d.dot(Vector(up))) < 0.95 else Vector((1, 0, 0))
        s = d.cross(ref).normalized() * (width / 2)
        t = d.cross(s).normalized() * (width / 2)
        corners = [tuple(p) for p in (a - s - t, a + s - t, a + s + t, a - s + t, b - s - t, b + s - t, b + s + t, b - s + t)]
        faces = [((0, 3, 2, 1), material), ((4, 5, 6, 7), material), ((0, 1, 5, 4), material), ((1, 2, 6, 5), material),
                 ((2, 3, 7, 6), material), ((3, 0, 4, 7), material)]
        self.shell(layer, corners, faces)

    def rock(self, centre, size, key, material="wall"):
        """A rubble stone: a chamfered block with its corners pushed about, partly sunk into the ground."""
        if self.lod != 0:
            return
        lo = [centre[i] - size[i] / 2 for i in range(3)]
        hi = [centre[i] + size[i] / 2 for i in range(3)]
        start = len(self.details)
        if max(size) < 0.4:  # small stones stay plain blocks: their chamfers would not show
            self.box(lo, hi, material, layer="details", tint=0.7 + 0.35 * rnd(key, "t"))
        else:
            self.chamfered(lo, hi, material, material, material, min(size) * 0.3, "details", 0.7 + 0.35 * rnd(key, "t"))
        corners, faces, t, uv = self.details[start]
        moved = []
        for k, p in enumerate(corners):
            moved.append(tuple(p[i] + (rnd(key, k, i) - 0.5) * size[i] * 0.22 for i in range(3)))
        self.details[start] = (moved, faces, t, uv)

    def decal(self, centre, axis, sign, width, height, kind, key):
        """A grime decal on the face normal to ``axis`` (0: x, 2: z) facing ``sign``, 1.5 cm off it.

        ``kind`` "streak" hangs from its top edge (centre is the top centre); "moss" is centred."""
        if self.lod != 0:
            return
        cx, cy, cz = centre
        y0, y1 = (cy - height, cy) if kind == "streak" else (cy - height / 2, cy + height / 2)
        y0 = max(y0, GROUND.get(self.part, 0.0) + 0.03)  # never below the ground
        if y1 - y0 < 0.2:
            return
        off = 0.015 * sign
        if axis == 2:
            a, b = (cx - width / 2, cx + width / 2) if sign < 0 else (cx + width / 2, cx - width / 2)
            quad = [(a, y0, cz + off), (b, y0, cz + off), (b, y1, cz + off), (a, y1, cz + off)]
        else:
            a, b = (cz + width / 2, cz - width / 2) if sign < 0 else (cz - width / 2, cz + width / 2)
            quad = [(cx + off, y0, a), (cx + off, y0, b), (cx + off, y1, b), (cx + off, y1, a)]
        variant = int(rnd(key, "variant") * 2)
        u0 = (0.0 if kind == "streak" else 0.5) + variant * 0.25
        self.decals.append((quad, (u0, 0.0, u0 + 0.25, 1.0)))

    def moss_on_top(self, x, y, z, width, depth, key):
        """A moss decal lying on an upward ledge."""
        if self.lod != 0:
            return
        y += 0.012
        quad = [(x - width / 2, y, z + depth / 2), (x + width / 2, y, z + depth / 2), (x + width / 2, y, z - depth / 2),
                (x - width / 2, y, z - depth / 2)]
        variant = int(rnd(key, "variant") * 2)
        u0 = 0.5 + variant * 0.25
        self.decals.append((quad, (u0, 0.0, u0 + 0.25, 1.0)))


def mesh_object(name, shells, materials, collection):
    mesh = bpy.data.meshes.new(name)
    for material in materials:
        mesh.materials.append(material)
    index = {m["fortressMaterial"]: i for i, m in enumerate(materials)}
    bm = bmesh.new()
    tint = bm.faces.layers.float.new("tint")
    uvu = bm.faces.layers.float.new("uvu")
    uvv = bm.faces.layers.float.new("uvv")
    for corners, faces, t, (ou, ov) in shells:
        verts = [bm.verts.new(bl(c)) for c in corners]
        for loop, material in faces:
            face = bm.faces.new([verts[i] for i in loop])
            face.material_index = index[material]
            face[tint], face[uvu], face[uvv] = t, ou, ov
    # Every shell is closed: point all its faces outward whatever order they were listed in.
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def boolean(target, operand, operation):
    modifier = target.modifiers.new("fortress", "BOOLEAN")
    modifier.operation = operation
    modifier.solver = "EXACT"
    modifier.material_mode = "TRANSFER"
    if operand is None:
        modifier.operand_type = "COLLECTION"
        modifier.collection = None
        modifier.use_self = True
    else:
        modifier.object = operand
        modifier.use_self = True
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = target.evaluated_get(depsgraph)
    mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
    old = target.data
    target.modifiers.clear()
    target.data = mesh
    bpy.data.meshes.remove(old)


def assemble(kit, name, materials, collection):
    """Union the solid shells, subtract the cuts, join the details, colour, unwrap, then add the decals."""
    if not kit.solid:
        kit.solid, kit.details = kit.details, []
        obj = mesh_object(name, kit.solid, materials, collection)
    else:
        obj = mesh_object(name, kit.solid, materials, collection)
        if len(kit.solid) > 1:
            boolean(obj, None, "UNION")
    if kit.cuts:
        cutter = mesh_object(f"{name}.cut", kit.cuts, materials, collection)
        boolean(obj, cutter, "DIFFERENCE")
        bpy.data.objects.remove(cutter)
    if kit.details:
        extra = mesh_object(f"{name}.details", kit.details, materials, collection)
        with bpy.context.temp_override(active_object=obj, selected_editable_objects=[obj, extra]):
            bpy.ops.object.join()
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-5)
    if kit.lod == 0 and not kit.part.startswith(("ramp-", "lift-")):
        grid(bm, 2.0)
    # Triangles, so the observed triangle count is what ships.
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="BEAUTY", ngon_method="BEAUTY")
    colour_and_unwrap(bm, kit, materials)
    bm.to_mesh(obj.data)
    bm.free()
    if kit.decals:
        add_decals(obj, kit, materials)
    mesh = obj.data
    mesh.color_attributes.active_color_name = "Col"
    mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
    for key in ("tint", "uvu", "uvv"):
        if key in mesh.attributes:
            mesh.attributes.remove(mesh.attributes[key])
    for polygon in mesh.polygons:
        polygon.use_smooth = False
    return obj


def grid(bm, step):
    """Cut faces larger than a grid cell on a ``step`` grid in X and Z and a 1 m grid in Y, for the vertex colour."""
    for axis, spacing in ((0, step), (1, 1.0), (2, step)):
        big = [f for f in bm.faces if f.calc_area() > step * 1.2 and f.material_index >= 0]
        if not big:
            return
        coords = [v.co for f in big for v in f.verts]
        # glTF axis -> Blender axis and sign: x -> x, y -> z, z -> -y.
        b_axis = (0, 2, 1)[axis]
        lo = min(c[b_axis] for c in coords)
        hi = max(c[b_axis] for c in coords)
        k = math.floor(lo / spacing) + 1
        normal = Vector([1.0 if i == b_axis else 0.0 for i in range(3)])
        while k * spacing < hi - 1e-4:
            plane = k * spacing
            k += 1
            faces = [f for f in bm.faces if f.calc_area() > step * 1.2
                     and min(v.co[b_axis] for v in f.verts) < plane - 1e-4 < plane + 1e-4 < max(v.co[b_axis] for v in f.verts)]
            if not faces:
                continue
            geom = list({e for f in faces for e in f.edges}) + faces + list({v for f in faces for v in f.verts})
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=normal * plane, plane_no=normal)


def colour_and_unwrap(bm, kit, materials):
    """World-scale UVs (offset per shell) and the COLOR_0 weathering, both in the piece frame."""
    uv_layer = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.new("UVMap")
    col = bm.loops.layers.color.new("Col")
    tint = bm.faces.layers.float.get("tint")
    uvu = bm.faces.layers.float.get("uvu")
    uvv = bm.faces.layers.float.get("uvv")
    names = [m["fortressMaterial"] for m in materials]
    ground = GROUND.get(kit.part, 0.0)
    ledge = 0.0 if kit.part.startswith("ramp-") else 1.0
    up = Vector((0, 0, 1))
    for f in bm.faces:
        name = names[f.material_index]
        n = f.normal
        tile = TEXTURED.get(name, (None, 1.0))[1]
        if abs(n.z) > 0.9:
            u_axis, v_axis = Vector((1, 0, 0)), Vector((0, 1, 0)) * (1 if n.z > 0 else -1)
        else:
            u_axis = up.cross(n).normalized()
            v_axis = n.cross(u_axis).normalized()
        t = f[tint] if tint is not None else 1.0
        t = t if t > 0 else 1.0
        ou = f[uvu] if uvu is not None else 0.0
        ov = f[uvv] if uvv is not None else 0.0
        factor, stone = (TEXTURED[name][2], TEXTURED[name][3]) if name in TEXTURED else ((1.0, 1.0, 1.0), False)
        upward = max(0.0, n.z)
        for loop in f.loops:
            co = loop.vert.co
            u, v = co.dot(u_axis) / tile + ou, co.dot(v_axis) / tile + ov
            # The planks run along V in the image: turned on the roofs they lie in horizontal courses like shingles.
            loop[uv_layer].uv = (v, u) if name == "roof" else (u, v)
            loop[col] = weather(co, n, upward, factor, stone, t, ground, name, ledge)


def weather(co, n, upward, factor, stone, t, ground, name, ledge):
    """COLOR_0 at a point (Blender frame): tint x macro patches x damp and moss at the feet x moss on ledges x streaks."""
    if name in PLAIN or name == "grime":
        return (1.0, 1.0, 1.0, 1.0)
    p = co
    macro = 0.86 + 0.26 * noise.noise(p * 0.16 + Vector((7.1, 3.3, 1.9))) + 0.12 * noise.noise(p * 0.55 + Vector((2.0, 9.0, 4.0)))
    c = [factor[k] * t * macro for k in range(3)]
    if not stone:
        return (*[clamp(v, 0, 1) for v in c], 1.0)
    height = p.z - ground
    feet = smoothstep(1.9, 0.0, height)
    patch = clamp(0.5 + 1.4 * noise.noise(p * 0.9 + Vector((31.0, 5.0, 12.0))))
    damp = feet * (0.75 + 0.25 * patch)
    moss = clamp(feet * feet * patch * 0.85 + upward * smoothstep(0.2, 0.7, patch) * ledge * (0.4 if name != "floor" else 0.08))
    vertical = 1.0 - abs(n.z)
    s = noise.noise(Vector((p.x * 1.7 + p.y * 1.7, p.z * 0.06, 3.7)))
    streak = vertical * smoothstep(0.1, 0.5, s) * (0.22 + 0.18 * smoothstep(2.0, 7.0, height))
    out = []
    for k in range(3):
        v = c[k]
        v *= 1.0 + (DAMP[k] - 1.0) * damp
        v *= 1.0 + (MOSS[k] / 0.4 - 1.0) * moss * 0.8
        v *= 1.0 - streak
        out.append(clamp(v, 0.0, 1.0))
    return (*out, 1.0)


def add_decals(obj, kit, materials):
    """The grime decals as open quads with atlas UVs and white COLOR_0, joined to the piece."""
    index = [m["fortressMaterial"] for m in materials].index("grime")
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv["UVMap"]
    col = bm.loops.layers.color["Col"]
    for quad, (u0, v0, u1, v1) in kit.decals:
        verts = [bm.verts.new(bl(p)) for p in quad]
        for tri, uvs in (((0, 1, 2), ((u0, v0), (u1, v0), (u1, v1))), ((0, 2, 3), ((u0, v0), (u1, v1), (u0, v1)))):
            face = bm.faces.new([verts[i] for i in tri])
            face.material_index = index
            for loop, coord in zip(face.loops, uvs):
                loop[uv].uv = coord
                loop[col] = (1.0, 1.0, 1.0, 1.0)
    bm.to_mesh(obj.data)
    bm.free()


# ---------------------------------------------------------------------------------------------------------------------
# Materials.

def load_pixels(path, colour):
    image = bpy.data.images.load(path, check_existing=False)
    image.colorspace_settings.is_data = not colour
    if tuple(image.size) != (TEXTURE_EDGE, TEXTURE_EDGE):
        image.scale(TEXTURE_EDGE, TEXTURE_EDGE)
    return image


def darken_mortar(colour, height, dark, lift):
    """Darken the joints of a stone colour map and lift its proud edges from the set's displacement map."""
    c = np.empty(TEXTURE_EDGE * TEXTURE_EDGE * 4, dtype=np.float32)
    colour.pixels.foreach_get(c)
    h = np.empty_like(c)
    height.pixels.foreach_get(h)
    c = c.reshape(-1, 4)
    d = h.reshape(-1, 4)[:, 0]
    lo, hi = np.percentile(d, 2), np.percentile(d, 98)
    d = np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1)
    t = np.clip((d - 0.15) / 0.3, 0, 1)
    t = t * t * (3 - 2 * t)
    shade = dark + (1 - dark) * t
    shade *= 1 + lift * np.clip((d - 0.8) / 0.2, 0, 1)
    c[:, :3] *= shade[:, None]
    colour.pixels.foreach_set(np.clip(c, 0, 1).ravel())
    colour.update()


def grime_atlas():
    """One RGBA atlas, four cells across: two rain streaks (u 0..0.5) and two moss patches (u 0.5..1)."""
    size = GRIME_EDGE
    rs = np.random.RandomState(459)
    cell = size // 4
    rgba = np.zeros((size, size, 4), dtype=np.float32)
    v = np.linspace(1, 0, size)[:, None]  # image rows top-down: v = 1 at the top
    u = np.linspace(0, 1, cell)[None, :]
    for k in range(2):
        cols = np.interp(np.linspace(0, 23, cell), np.arange(24), rs.rand(24))
        cols = np.clip((cols - 0.35) * 2.2, 0, 1)
        drip = np.interp(np.linspace(0, 23, cell), np.arange(24), 0.35 + 0.65 * rs.rand(24))
        fade = np.clip((v - (1 - drip[None, :])) / np.maximum(drip[None, :], 1e-3), 0, 1) ** 1.6
        edge = np.clip(np.minimum(u, 1 - u) * 6, 0, 1)
        alpha = cols[None, :] * fade * edge * 0.75
        x0 = k * cell
        rgba[:, x0:x0 + cell, 0] = 0.11
        rgba[:, x0:x0 + cell, 1] = 0.1
        rgba[:, x0:x0 + cell, 2] = 0.085
        rgba[:, x0:x0 + cell, 3] = alpha
    yy, xx = np.mgrid[0:size, 0:cell]
    for k in range(2):
        blobs = np.zeros((size, cell), dtype=np.float32)
        for _ in range(14):
            cx, cy = rs.rand() * cell * 0.6 + cell * 0.2, rs.rand() * size * 0.7 + size * 0.15
            r = (0.12 + 0.18 * rs.rand()) * cell
            blobs = np.maximum(blobs, np.clip(1 - ((xx - cx) ** 2 + ((yy - cy) * cell / size * 2) ** 2) / r ** 2, 0, 1))
        speckle = rs.rand(size, cell).astype(np.float32)
        alpha = np.clip(blobs * 1.6 - 0.25, 0, 1) * (0.55 + 0.45 * speckle) * 0.9
        x0 = 2 * cell + k * cell
        green = 0.75 + 0.25 * speckle
        rgba[:, x0:x0 + cell, 0] = 0.16 * green
        rgba[:, x0:x0 + cell, 1] = 0.21 * green
        rgba[:, x0:x0 + cell, 2] = 0.07 * green
        rgba[:, x0:x0 + cell, 3] = alpha
    image = bpy.data.images.new("fortress-grime", size, size, alpha=True)
    image.colorspace_settings.name = "sRGB"
    image.pixels.foreach_set(rgba[::-1].ravel())
    image.file_format = "PNG"
    image.alpha_mode = "STRAIGHT"
    image.pack()
    return image


def make_materials(inputs):
    images = {}
    for s in SETS:
        images[s] = {m: load_pixels(inputs[f"{s}{m}"], m == "Colour") for m in MAPS}
    for s, key, dark, lift in (("wall", "wallHeight", 0.4, 0.18), ("trim", "trimHeight", 0.55, 0.1)):
        height = load_pixels(inputs[key], False)
        darken_mortar(images[s]["Colour"], height, dark, lift)
        bpy.data.images.remove(height)
    materials = []
    for name in MATERIALS:
        material = bpy.data.materials.new(f"fortress.{name}")
        material["fortressMaterial"] = name
        material.use_nodes = True
        material.use_backface_culling = True
        tree = material.node_tree
        bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
        vcol = tree.nodes.new("ShaderNodeVertexColor")
        vcol.layer_name = "Col"
        mix = tree.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        tree.links.new(vcol.outputs["Color"], mix.inputs[7])
        tree.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
        bsdf.inputs["Metallic"].default_value = 0.0
        if name in TEXTURED:
            maps = images[TEXTURED[name][0]]
            colour = tree.nodes.new("ShaderNodeTexImage")
            colour.image = maps["Colour"]
            tree.links.new(colour.outputs["Color"], mix.inputs[6])
            rough = tree.nodes.new("ShaderNodeTexImage")
            rough.image = maps["Roughness"]
            separate = tree.nodes.new("ShaderNodeSeparateColor")
            tree.links.new(rough.outputs["Color"], separate.inputs["Color"])
            tree.links.new(separate.outputs[1], bsdf.inputs["Roughness"])
            normal = tree.nodes.new("ShaderNodeTexImage")
            normal.image = maps["Normal"]
            normal_map = tree.nodes.new("ShaderNodeNormalMap")
            tree.links.new(normal.outputs["Color"], normal_map.inputs["Color"])
            tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
        elif name == "grime":
            atlas = tree.nodes.new("ShaderNodeTexImage")
            atlas.image = grime_atlas()
            tree.links.new(atlas.outputs["Color"], mix.inputs[6])
            tree.links.new(atlas.outputs["Alpha"], bsdf.inputs["Alpha"])
            bsdf.inputs["Roughness"].default_value = 1.0
            material.surface_render_method = "BLENDED"
        else:
            colour, metallic, roughness = PLAIN[name]
            mix.inputs[6].default_value = (*colour, 1.0)
            bsdf.inputs["Metallic"].default_value = metallic
            bsdf.inputs["Roughness"].default_value = roughness
        materials.append(material)
    return materials


# ---------------------------------------------------------------------------------------------------------------------
# Shared dressings.

def dressed(kit, lo, hi, plinth=0.6, strings=(), coping=0.4, top="floor", wall="wall", quoins=(True, True), inset=INSET,
            bottom="trimDark"):
    """A masonry block: plinth, string courses and coping flush with the box, the rubble face inset, quoins at the ends.

    ``quoins`` says whether the -X and +X ends get quoins (an end buried in another piece gets none)."""
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    kit.box((x0, y0, z0), (x1, y0 + plinth, z1), "trim", "trimDark", bottom)
    bands = sorted([(s, s + 0.28) for s in strings] + [(y1 - coping, y1)])
    if kit.lod == 2:
        bands = [(y1 - coping, y1)]
    y = y0 + plinth
    for b0, b1 in bands:
        kit.box((x0 + inset, y, z0 + inset), (x1 - inset, b0, z1 - inset), wall, "trimDark")
        kit.box((x0, b0, z0), (x1, b1, z1), "trim", top if b1 == y1 else "trimDark", "trimDark")
        y = b1
    if kit.lod == 0:
        for end, (enabled, x) in enumerate(zip(quoins, (x0, x1))):
            if not enabled:
                continue
            sign = 1 if end == 0 else -1
            course, h = 0, y0 + plinth
            for b0, b1 in bands:
                while h + 0.05 < b0:
                    top_h = min(h + 0.5, b0)
                    long_x = 0.8 if course % 2 == 0 else 0.48
                    long_z = 0.48 if course % 2 == 0 else 0.8
                    for z, zs in ((z0, 1), (z1, -1)):
                        xa, xb = sorted((x, x + sign * long_x))
                        za, zb = sorted((z, z + zs * long_z))
                        kit.box((xa, h, za), (xb, top_h - 0.02, zb), "trim", "trimDark", "trimDark", layer="details",
                                chamfer=0.03)
                    course += 1
                    h = top_h
                h = b1


def slit(kit, centre, face, width=0.12, height=1.3, depth=0.9, surround=True):
    """A deep arrow slit cut into the face (+-z or +-x, glTF) at ``centre`` (the slit's centre on the box face), with an
    outer splay and a dressed surround flush with the box face."""
    if kit.lod == 2:
        return
    cx, cy, cz = centre
    axis = 2 if face in ("-z", "+z") else 0
    sign = -1 if face[0] == "-" else 1
    other = 0 if axis == 2 else 2

    def cut(w, h, d0, d1):
        lo, hi = list(centre), list(centre)
        lo[1], hi[1] = cy - h / 2, cy + h / 2
        lo[other], hi[other] = centre[other] - w / 2, centre[other] + w / 2
        lo[axis], hi[axis] = sorted((centre[axis] - sign * d0, centre[axis] + sign * d1))
        kit.box(tuple(lo), tuple(hi), "void", layer="cuts")

    cut(width, height, depth, 0.2)
    cut(width + 0.16, height + 0.1, 0.12, 0.2)  # the splay: a wider, shallow mouth
    if kit.lod == 0 and surround:
        w, h = width + 0.16, height + 0.1
        for (a0, a1), (b0, b1) in (((-w / 2 - 0.18, -w / 2), (-h / 2 - 0.2, h / 2 + 0.2)),
                                   ((w / 2, w / 2 + 0.18), (-h / 2 - 0.2, h / 2 + 0.2)),
                                   ((-w / 2, w / 2), (-h / 2 - 0.2, -h / 2)),
                                   ((-w / 2, w / 2), (h / 2, h / 2 + 0.2))):
            lo, hi = [0, 0, 0], [0, 0, 0]
            lo[other], hi[other] = centre[other] + a0, centre[other] + a1
            lo[1], hi[1] = cy + b0, cy + b1
            lo[axis], hi[axis] = sorted((centre[axis], centre[axis] - sign * (INSET + 0.1)))
            kit.box(tuple(lo), tuple(hi), "trim", "trimDark", "trimDark", layer="details", chamfer=0.02)
        key = (kit.part, "slit", round(cx, 2), round(cy, 2), round(cz, 2))
        below = list(centre)
        below[1] = cy - h / 2 - 0.2
        kit.decal(tuple(below), axis, sign, 0.7, 1.4 + rnd(key) * 1.4, "streak", key)


def banner(kit, x, y0, y1, face_z, sign, width=1.3):
    """A Marshal-blue banner hanging in the relief on a z face (sign -1: the -z face) from y1 down to y0."""
    if kit.lod == 2:
        return
    back = face_z - sign * INSET          # the inset wall face
    za, zb = sorted((back, back + sign * 0.025))
    kit.box((x - width / 2, y0 + 0.35, za), (x + width / 2, y1, zb), "cloth", layer="details", tint=1.0)
    for tip in (-1, 1):
        xa = x + (tip - 1) * width / 4 if tip < 0 else x
        kit.box((xa, y0, za), (xa + width / 2, y0 + 0.35, zb), "cloth", layer="details", tint=1.0)
    if kit.lod == 0:
        za2, zb2 = sorted((back + sign * 0.025, back + sign * 0.03))
        kit.box((x - width / 2 + 0.12, y1 - 1.0, za2), (x + width / 2 - 0.12, y1 - 0.85, zb2), "clothTrim", layer="details")
        kit.box((x - 0.08, y0 + 0.6, za2), (x + 0.08, y1 - 1.25, zb2), "clothTrim", layer="details")
        zp0, zp1 = sorted((back, back + sign * 0.07))
        kit.box((x - width / 2 - 0.12, y1, zp0), (x + width / 2 + 0.12, y1 + 0.07, zp1), "woodDark", layer="details")


def turned(kit, build, face):
    """Run ``build(sub)`` on the -z face of a sub-kit and turn its details (and cuts) onto ``face`` of a square piece."""
    sub = Kit(kit.lod, kit.part)
    sub.count = kit.count + 1000 * "-z+z-x+x".index(face)
    build(sub)
    turn = {"-z": lambda x, z: (x, z), "+z": lambda x, z: (-x, -z), "-x": lambda x, z: (z, -x), "+x": lambda x, z: (-z, x)}[face]
    for layer in ("solid", "cuts", "details"):
        for corners, faces, t, uv in getattr(sub, layer):
            moved = [(turn(cx, cz)[0], cy, turn(cx, cz)[1]) for cx, cy, cz in corners]
            getattr(kit, layer).append((moved, faces, t, uv))
    for quad, uv in sub.decals:
        kit.decals.append(([(turn(cx, cz)[0], cy, turn(cx, cz)[1]) for cx, cy, cz in quad], uv))
    kit.count = sub.count


def corbel_row(kit, x0, x1, face_z, sign, y_top, depth=0.5, spacing=0.75, width=0.3, skip=()):
    """Two-step corbels under a projecting band on a z face (sign -1: -z face), from x0 to x1."""
    if kit.lod != 0:
        return
    count = max(1, int((x1 - x0) / spacing))
    step = (x1 - x0) / count
    for i in range(count + 1):
        c = x0 + i * step
        if any(a <= c <= b for a, b in skip):
            continue
        for d, y0, y1 in ((depth * 0.55, y_top - 0.95, y_top - 0.5), (depth, y_top - 0.5, y_top)):
            za, zb = sorted((face_z - sign * 0.15, face_z + sign * d))
            kit.box((c - width / 2, y0, za), (c + width / 2, y1, zb), "trim", "trimDark", "trimDark", layer="details",
                    chamfer=0.02)


def merlons(kit, x0, x1, z0, z1, y0, height, period=2.6, merlon=1.6, slits=True, layer="solid"):
    """Merlons along X between x0 and x1 on top of y0, with a chamfered coping on each."""
    count = int((x1 - x0) / period)
    if count < 1:
        return
    start = (x0 + x1) / 2 - count * period / 2
    for i in range(count):
        a = start + i * period + (period - merlon) / 2
        kit.box((a, y0 - 0.01, z0), (a + merlon, y0 + height, z1), "trim", "trimDark", "trimDark", layer=layer)
        if kit.lod == 0:
            kit.box((a - 0.04, y0 + height, z0 - 0.04), (a + merlon + 0.04, y0 + height + 0.12, z1 + 0.04), "trim",
                    "trim", "trimDark", layer="details", chamfer=0.03)
            if slits and i % 2 == 0 and layer == "solid":
                m = a + merlon / 2
                kit.box((m - 0.05, y0 + 0.3, z0 - 0.1), (m + 0.05, y0 + height - 0.3, z1 + 0.1), "void", layer="cuts")


def arch(kit, half, spring, crown, top, z, sign, depth=0.45):
    """A segmental arch of voussoirs on the face at z (sign -1: -z face) spanning x -half..half, springing at
    ``spring`` and rising to ``crown`` at the middle; the voussoirs fill up to ``top`` (the lintel's underside or
    above). Decoration in the opening's upper corners, above head height."""
    rise = crown - spring
    radius = (half * half + rise * rise) / (2 * rise)
    cy = crown - radius
    a0 = math.asin(half / radius)
    count = 9 if kit.lod == 0 else 3
    za, zb = sorted((z, z - sign * depth))
    gap = 0.015 if kit.lod == 0 else 0.0
    for i in range(count):
        t0 = -a0 + 2 * a0 * i / count
        t1 = -a0 + 2 * a0 * (i + 1) / count
        p0 = (radius * math.sin(t0), cy + radius * math.cos(t0))
        p1 = (radius * math.sin(t1), cy + radius * math.cos(t1))
        key_stone = i == count // 2
        section_top = top + (0.25 if key_stone else 0.0)
        # The keystone stands 5 cm proud, clear of the dressed face it overlaps.
        ka, kb = (za - 0.05, zb) if key_stone and sign < 0 else ((za, zb + 0.05) if key_stone else (za, zb))
        corners = [(p0[0] + gap, p0[1], ka), (p1[0] - gap, p1[1], ka), (p1[0] - gap, section_top, ka), (p0[0] + gap, section_top, ka),
                   (p0[0] + gap, p0[1], kb), (p1[0] - gap, p1[1], kb), (p1[0] - gap, section_top, kb), (p0[0] + gap, section_top, kb)]
        faces = [((0, 1, 2, 3), "trim"), ((4, 7, 6, 5), "trim"), ((0, 4, 5, 1), "trimDark"), ((1, 5, 6, 2), "trim"),
                 ((2, 6, 7, 3), "trim"), ((3, 7, 4, 0), "trim")]
        kit.shell("details", corners, faces)


def blind_arch(kit, cx, half, spring, crown, z, sign, ring=0.45, depth=0.12):
    """A relieving arch on a z face (sign +1: the +z face): a ring of wedge voussoirs flush with the box face, the
    rubble face 4 cm behind it. Relief only, so the face stays within 5 cm of the collider."""
    if kit.lod == 2:
        return
    rise = crown - spring
    radius = (half * half + rise * rise) / (2 * rise)
    cy = crown - radius
    a0 = math.asin(half / radius)
    count = 11 if kit.lod == 0 else 5
    za, zb = sorted((z, z - sign * depth))
    gap = 0.02 if kit.lod == 0 else 0.0
    for i in range(count):
        t0 = -a0 + 2 * a0 * i / count + gap / radius
        t1 = -a0 + 2 * a0 * (i + 1) / count - gap / radius
        ro = radius + ring + (0.12 if i == count // 2 else 0.0)
        pts = [(cx + radius * math.sin(t0), cy + radius * math.cos(t0)), (cx + radius * math.sin(t1), cy + radius * math.cos(t1)),
               (cx + ro * math.sin(t1), cy + ro * math.cos(t1)), (cx + ro * math.sin(t0), cy + ro * math.cos(t0))]
        corners = [(x, y, za) for x, y in pts] + [(x, y, zb) for x, y in pts]
        faces = [((0, 1, 2, 3), "trim"), ((4, 7, 6, 5), "trim"), ((0, 4, 5, 1), "trimDark"), ((1, 5, 6, 2), "trim"),
                 ((2, 6, 7, 3), "trim"), ((3, 7, 4, 0), "trim")]
        kit.shell("details", corners, faces, tint=1.12 + 0.1 * rnd(kit.part, "arch", cx, i))  # paler than the rubble


def pavilion_roof(kit, half, base_y, eave_y, apex_y, overhang=0.9, post=0.32, skip_posts=False):
    """A pyramidal shingle roof on corner posts and knee braces, eaves above head height, outside the walk below it.

    ``half`` is the half-width of the tower top; the posts stand just outside its corners."""
    o = half + post / 2 + 0.06
    if kit.lod < 2 and not skip_posts:
        for sx in (-1, 1):
            for sz in (-1, 1):
                kit.box((sx * o - post / 2, base_y, sz * o - post / 2), (sx * o + post / 2, eave_y, sz * o + post / 2),
                        "woodDark", layer="details")
        # Wall plates along the four edges, outside the top.
        for sz in (-1, 1):
            kit.box((-o - post / 2, eave_y - 0.26, sz * o - post / 2), (o + post / 2, eave_y, sz * o + post / 2), "woodDark",
                    layer="details")
        for sx in (-1, 1):
            kit.box((sx * o - post / 2, eave_y - 0.26, -o + post / 2), (sx * o + post / 2, eave_y, o - post / 2), "woodDark",
                    layer="details")
        if kit.lod == 0:
            for sx in (-1, 1):
                for sz in (-1, 1):
                    for along in (0, 2):
                        a = [sx * o, eave_y - 1.1, sz * o]
                        b = [sx * o, eave_y - 0.26, sz * o]
                        b[along] -= (sx if along == 0 else sz) * 0.8
                        kit.beam(tuple(a), tuple(b), 0.14)
    # A bellcast eave course, then shingle courses up a steep pyramid, each lapping 6 cm over the one below.
    square = lambda r_: [(-r_, -r_), (r_, -r_), (r_, r_), (-r_, r_)]
    r = half + overhang
    rise = apex_y - eave_y
    flare_r, body_r, body_y = r, r - 0.35, eave_y + 0.32
    kit.frustum(square(flare_r), square(body_r), eave_y, body_y, "roof", cap="roof", base="woodDark")
    levels = 4 if kit.lod == 0 else (2 if kit.lod == 1 else 1)
    lap = 0.06 if kit.lod == 0 else 0.0
    y, rr = body_y, body_r
    for k in range(1, levels):
        f = k / levels
        y_next = body_y + (apex_y - body_y) * f
        r_next = body_r * (1 - f)
        kit.frustum(square(rr + (lap if k > 1 else 0.0)), square(r_next), y, y_next, "roof", cap="roof", base="roof")
        y, rr = y_next, r_next
    kit.pyramid(square(rr + lap), y, (0, apex_y, 0), "roof", base="roof")
    del rise
    if kit.lod < 2:
        kit.box((-0.05, apex_y - 0.4, -0.05), (0.05, apex_y + 1.3, 0.05), "iron", layer="details")
        kit.box((-0.11, apex_y + 0.75, -0.11), (0.11, apex_y + 0.97, 0.11), "iron", layer="details")


def rubble_line(kit, x0, x1, face_z, sign, key, density=0.8, big=0.55, reach=0.9, skip=()):
    """Fallen stones at the foot of a z face (sign -1: -z face), between x0 and x1."""
    if kit.lod != 0:
        return
    x = x0
    i = 0
    while x < x1:
        i += 1
        r = rnd(key, i)
        step = (0.4 + 1.6 * rnd(key, i, "step")) / density
        x += step
        if x >= x1 or any(a <= x <= b for a, b in skip):
            continue
        cluster = 1 + int(r * 3)
        for j in range(cluster):
            s = big * (0.35 + 0.65 * rnd(key, i, j, "s"))
            off = 0.05 + reach * rnd(key, i, j, "o") ** 1.5
            cx = x + (rnd(key, i, j, "x") - 0.5) * 0.9
            size = (s * (0.9 + 0.6 * rnd(key, i, j, "w")), s * (0.45 + 0.35 * rnd(key, i, j, "h")), s * (0.8 + 0.4 * rnd(key, i, j, "d")))
            kit.rock((cx, size[1] * 0.3, face_z + sign * (off + size[2] / 2)), size, (key, i, j), "wall" if j else "trim")


# ---------------------------------------------------------------------------------------------------------------------
# Pieces. Each takes the fitted box size (w, h, d) and builds in x -w/2..w/2, y 0..h, z -d/2..d/2 (decoration aside).

def curtain_wall(kit, w, h, d):
    lo, hi = (-w / 2, 0, -d / 2), (w / 2, h, d / 2)
    dressed(kit, lo, hi, plinth=0.9, strings=(4.6,), coping=0.45)
    # Both ends are alike: one meets a corner tower (which hides the last 5.6 m), the other the gatehouse's flanking
    # tower (from 4.3 m in). The outer dressings keep within |x| <= reach.
    reach = w / 2 - 4.6
    front, back = -d / 2, d / 2
    # Battered talus along the outer foot, and a low chamfered plinth step on the courtyard side.
    kit.prism([(front - 0.8, 0), (front + 0.1, 0), (front + 0.1, 2.0), (front, 2.0)], -reach, reach, "trim", layer="details", tint=0.95)
    if kit.lod < 2:
        kit.prism([(back - 0.1, 0), (back + 0.32, 0), (back + 0.32, 0.32), (back, 0.62), (back - 0.1, 0.62)], -w / 2 + 5.4,
                  w / 2 - 0.02,["trimDark", "trim", "trim", "trim", "trim", "trim"], layer="details", tint=0.9)
    buttresses = [-30.0, -20.0, -10.0, 0.0, 10.0, 20.0, 30.0]
    if kit.lod < 2:
        for x in buttresses:
            section = [(front - 1.25, 0), (front + 0.1, 0), (front + 0.1, 6.7), (front, 6.7), (front - 0.6, 5.7),
                       (front - 0.6, 3.6), (front - 1.25, 2.9)]
            kit.prism(section, x - 0.75, x + 0.75, ["trimDark", "wall", "trim", "trim", "wall", "trim", "wall", "wall"],
                      layer="details", tint=0.92 + 0.12 * rnd("buttress", x))
    # A drip course under the parapet on the outer face, and putlog holes on both faces.
    if kit.lod < 2:
        kit.box((-reach, 7.42, front - 0.14), (reach, 7.6, front + 0.05), "trim", "trimDark", "trimDark", layer="details")
    if kit.lod == 0:
        for face_z, sign in ((front, -1), (back, 1)):
            for row, y in enumerate((3.4, 6.1)):
                x = -w / 2 + 6.5 + row * 1.3
                while x < w / 2 - 1.5:
                    if sign > 0 or (abs(x) < reach - 0.5 and all(abs(x - b) > 1.2 for b in buttresses)):
                        za, zb = sorted((face_z - sign * 0.25, face_z + sign * 0.1))
                        kit.box((x - 0.11, y - 0.11, za), (x + 0.11, y + 0.11, zb), "void", layer="cuts")
                    x += 2.6
    # Arrow slits between the buttresses, two rows.
    for x in (-25.0, -15.0, -5.0, 5.0, 15.0, 25.0):
        slit(kit, (x, 2.9, front), "-z", height=1.4)
        slit(kit, (x + 2.5, 6.0, front), "-z", height=1.1)
    # Pilasters on the courtyard face, one per 8 m module.
    if kit.lod < 2:
        for i in range(-4, 5):
            x = i * 8.0 + 4.0
            kit.box((x - 0.45, 0.9, back - INSET - 0.2), (x + 0.45, 4.6, back), "trim", "trimDark")
            kit.box((x - 0.45, 4.88, back - INSET - 0.2), (x + 0.45, h - 0.45, back), "trim", "trimDark")
        # Relieving arches between the pilasters, under the string course.
        for i in range(-4, 4):
            blind_arch(kit, i * 8.0 + 8.0, 3.55, 2.3, 3.95, back, 1)
    hoardings(kit, w, h, d)
    rubble_line(kit, -reach, reach, front - 0.8, -1, "rubble-out", density=0.9, big=0.6, reach=1.2,
                skip=[(b - 0.8, b + 0.8) for b in buttresses])
    rubble_line(kit, -w / 2 + 6, w / 2 - 1.0, back + 0.32, 1, "rubble-in", density=0.35, big=0.38, reach=0.5)
    # Grime: streaks under the drip course and moss along both feet.
    if kit.lod == 0:
        x = -reach + 0.6
        i = 0
        while x < reach - 0.6:
            i += 1
            if all(abs(x - b) > 1.1 for b in buttresses):
                kit.decal((x, 7.42, front), 2, -1, 1.0 + rnd("st", i) * 0.8, 1.8 + 2.6 * rnd("sl", i), "streak", ("st", i))
            x += 1.1 + 2.2 * rnd("sx", i)
        for face_z, sign, x0, x1 in ((front - 0.8, -1, -reach, reach), (back + 0.32, 1, -w / 2 + 6, w / 2 - 1)):
            x = x0 + 0.8
            i = 0
            while x < x1 - 0.8:
                i += 1
                if sign > 0 or all(abs(x - b) > 1.2 for b in buttresses):
                    hgt = 0.9 + rnd("mh", sign, i) * 1.1
                    z = back if sign > 0 else front
                    kit.decal((x, hgt / 2 + (2.0 if sign < 0 else 0.62) - 0.15, z), 2, sign, 1.6 + rnd("mw", sign, i), hgt, "moss",
                              ("mo", sign, i))
                x += 2.0 + 3.0 * rnd("mx", sign, i)


def hoardings(kit, w, h, d):
    """Timber hoardings (brattices) outside the parapet: a covered gallery on putlog beams, two runs per wall."""
    if kit.lod == 2:
        return
    front = -d / 2
    out = front - 1.6
    for x0, x1 in ((-27.0, -13.0), (11.0, 25.0)):
        # Putlogs and their struts.
        x = x0
        while x <= x1 + 1e-6:
            kit.box((x - 0.12, h - 0.62, out - 0.2), (x + 0.12, h - 0.38, front + 0.3), "woodDark", layer="details")
            if kit.lod == 0:
                kit.beam((x, h - 2.3, front - 0.02), (x, h - 0.6, out + 0.1), 0.16, up=(1, 0, 0))
            x += 2.0
        # Floor, front and side boarding, roof.
        kit.box((x0 - 0.2, h - 0.38, out), (x1 + 0.2, h - 0.26, front - 0.02), "wood", "wood", "woodDark", layer="details")
        kit.box((x0 - 0.2, h - 0.26, out), (x1 + 0.2, h + 2.05, out + 0.1), "wood", layer="details")
        for xe in (x0 - 0.2, x1 + 0.1):
            kit.box((xe, h - 0.26, out + 0.1), (xe + 0.1, h + 2.05, front - 0.02), "wood", layer="details")
        if kit.lod == 0:
            # Dark loops in the boarding and posts at every bay.
            x = x0 + 1.0
            while x < x1:
                kit.box((x - 0.2, h + 0.55, out - 0.012), (x + 0.2, h + 1.05, out + 0.02), "void", layer="details", tint=1.0)
                x += 2.0
            x = x0
            while x <= x1 + 1e-6:
                kit.box((x - 0.09, h - 0.26, out - 0.07), (x + 0.09, h + 2.1, out), "woodDark", layer="details")
                x += 2.0
        # Lean-to roof from above the merlons down over the boarding.
        kit.prism([(front + 0.2, h + 3.0), (front + 0.2, h + 3.16), (out - 0.45, h + 1.96), (out - 0.45, h + 1.8)],
                  x0 - 0.45, x1 + 0.45, ["roof", "roof", "woodDark", "woodDark", "woodDark"], layer="details", tint=1.0)


def gate_lintel(kit, w, h, d):
    """The gatehouse: the lintel over the gate passage (the collider), a segmental arch on both faces, flanking towers
    and a machicolated gallery on the outer face, all decoration below or outside the walk."""
    ground = -6.0
    kit.box((-w / 2, 0, -d / 2 + INSET), (w / 2, h - 0.4, d / 2 - INSET), "trimDark", "trimDark", "trim")
    kit.box((-w / 2, h - 0.4, -d / 2), (w / 2, h, d / 2), "trim", "floor", "trimDark")
    for z, sign in ((-d / 2, -1), (d / 2, 1)):
        arch(kit, w / 2, -1.9, 0.0 - 0.02, 0.0, z, sign)
        kit.box((-w / 2, 0.0, min(z, z - sign * 0.5)), (w / 2, h - 0.4, max(z, z - sign * 0.5)), "trim", "trimDark", "trimDark",
                layer="details")
    front = -d / 2
    # Flanking towers: a chamfered plan from the wall face outwards, battered at the foot.
    for sx in (-1, 1):
        xa, xb = sorted((sx * (w / 2 + 0.15), sx * (w / 2 + 4.6)))
        plan = [(xa, front + 0.1), (xa, front - 1.5), (xa + 0.8, front - 2.3), (xb - 0.8, front - 2.3), (xb, front - 1.5), (xb, front + 0.1)]
        outer = xb if sx > 0 else xa

        def grow(points, by):
            # Flare the outer side and the front, never the side facing the gate passage.
            return [(x + (by * sx if x == outer else 0.0), z - (by if z < front - 1 else 0.0)) for x, z in points]

        kit.frustum(plan, plan, ground, h + 4.4, "wall", cap="floor", base="trimDark", layer="solid")
        kit.frustum(grow(plan, 0.55), grow(plan, 0.02), ground, ground + 2.2, "trim", cap="trim", base="trimDark")
        for y in (ground + 2.2, h - 0.3):
            ring = grow(plan, 0.06)
            kit.frustum(ring, ring, y, y + 0.28, "trim", cap="trimDark", base="trimDark")
        cx = (xa + xb) / 2
        merlons(kit, xa + 0.05, xb - 0.05, front - 2.3, front - 1.75, h + 4.4, 1.3, period=1.8, merlon=1.0, slits=False)
        merlons(kit, xa + 0.05, xb - 0.05, front - 0.45, front + 0.1, h + 4.4, 1.3, period=1.8, merlon=1.0, slits=False)
        corbel_row(kit, xa + 0.6, xb - 0.6, front - 2.3, -1, h + 4.4, depth=0.35, spacing=0.7)
        for y in (ground + 3.6, ground + 7.4, h + 2.2):
            slit(kit, (cx, y, front - 2.3), "-z", height=1.2, depth=0.8)
        kit.decal((cx, h + 4.3, front - 2.3), 2, -1, 2.2, 3.5, "streak", ("gt", sx))
        kit.decal((cx, ground + 2.9, front - 2.3 - 0.55), 2, -1, 2.6, 1.3, "moss", ("gm", sx))
        rubble_line(kit, xa - 0.6, xb + 0.6, front - 2.85, -1, ("gate-rubble", sx), density=1.2, big=0.5, reach=0.9)
    # The machicolated gallery between the towers, carried on corbels over the arch; murder holes between them.
    gx = w / 2 + 0.2
    out = front - 1.25
    kit.box((-gx, h - 0.6, out), (gx, h + 2.4, out + 0.4), "trim", "trimDark", "trimDark")
    merlons(kit, -gx, gx, out, out + 0.4, h + 2.4, 1.2, period=1.6, merlon=0.95, slits=False)
    if kit.lod < 2:
        kit.box((-gx, h - 0.66, out + 0.4), (gx, h - 0.6, front + 0.05), "void", "woodDark", "void", layer="details", tint=1.0)
        n = 7
        for i in range(n + 1):
            x = -gx + 0.2 + i * (2 * gx - 0.4) / n
            for dz, y0, y1 in ((0.7, h - 1.6, h - 1.1), (1.25, h - 1.1, h - 0.6)):
                kit.box((x - 0.16, y0, front - dz), (x + 0.16, y1, front + 0.1), "trim", "trimDark", "trimDark", layer="details",
                        chamfer=0.02)
        kit.decal((0, h - 0.66, out), 2, -1, 5.6, 2.0, "streak", "gallery")
    # The raised portcullis in its slot under the lintel: iron bars ending a hand below the underside.
    if kit.lod < 2:
        kit.box((-w / 2 + 0.1, -0.1, -d / 2 + 0.75), (w / 2 - 0.1, 0.7, -d / 2 + 1.05), "void", layer="cuts")
        for i in range(int((w - 0.4) / 0.32) + 1):
            x = -w / 2 + 0.2 + i * 0.32
            kit.box((x - 0.035, -0.25, -d / 2 + 0.86), (x + 0.035, 0.7, -d / 2 + 0.94), "iron", layer="details")
            kit.box((x - 0.05, -0.4, -d / 2 + 0.85), (x + 0.05, -0.25, -d / 2 + 0.95), "iron", layer="details")
        kit.box((-w / 2 + 0.1, 0.18, -d / 2 + 0.84), (w / 2 - 0.1, 0.26, -d / 2 + 0.96), "iron", layer="details")
        for x in (-1.4, 1.4):
            kit.box((x - 0.22, -0.1, 0.2), (x + 0.22, 0.4, 0.64), "void", layer="cuts")


def parapet(kit, w, h, d):
    """The parapet (the collider, 1 m) with full-height merlons above it; none inside the corner towers' ends."""
    if kit.lod == 2:
        kit.box((-w / 2, 0, -d / 2), (w / 2, h, d / 2), "trim", "trimDark")
        return
    kit.box((-w / 2, 0, -d / 2 + INSET), (w / 2, h - 0.18, d / 2 - INSET), "wall", "trimDark")
    kit.box((-w / 2, h - 0.18, -d / 2), (w / 2, h, d / 2), "trim", "trimDark", "trimDark")
    reach = w / 2 - 5.9
    merlons(kit, -reach, reach, -d / 2, d / 2, h, 1.6)
    if kit.lod == 0:
        i = 0
        x = -reach
        while x < reach:
            i += 1
            if rnd("pmoss", i) < 0.25:
                kit.moss_on_top(x + 1.3, h, 0, 0.9, 0.5, ("pm", i))
            x += 2.6


def tower_body(kit, w, h, d, plinth, strings, slits_at, banners, batter, crown_y, roof, gaps):
    """A square tower: dressings, a battered foot, deep slits, a machicolated crown below its open top and a roof.

    ``gaps`` per face ("+x" etc.): spans along the face kept clear of the crown (where ramps or lifts arrive)."""
    lo, hi = (-w / 2, 0, -d / 2), (w / 2, h, d / 2)
    dressed(kit, lo, hi, plinth=plinth, strings=strings, coping=0.5)
    s = w / 2
    if batter and kit.lod < 2:
        flare = 0.85
        bottom = [(-s - flare, -s - flare), (s + flare, -s - flare), (s + flare, s + flare), (-s - flare, s + flare)]
        top = [(-s - 0.02, -s - 0.02), (s + 0.02, -s - 0.02), (s + 0.02, s + 0.02), (-s - 0.02, s + 0.02)]
        kit.frustum(bottom, top, 0, batter, "trim", cap="trim", base="trimDark", tint=0.95)
    for face in ("-z", "+z", "-x", "+x"):
        def build(sub, face=face):
            for y, height in slits_at:
                slit(sub, (0, y, -s), "-z", height=height)
            span = gaps.get(face, ())
            # The crown: corbels and a projecting band whose top stays 15 cm below the walk.
            corbel_row(sub, -s + 0.2, s - 0.2, -s, -1, crown_y, depth=0.55, spacing=0.72, skip=span)
            if sub.lod < 2:
                # Each face's band owns the corner at its -x end, so neighbouring bands never overlap.
                runs = [(-s - 0.6, s - 0.1)]
                for a, b in span:
                    runs = [r for run in runs for r in ((run[0], min(run[1], a)), (max(run[0], b), run[1])) if r[1] - r[0] > 0.05]
                for a, b in runs:
                    sub.box((a, crown_y, -s - 0.6), (b, h - 0.15, -s + 0.1), "trim", "trimDark", "trimDark", layer="details")
            if face in banners and sub.lod < 2:
                for x in (-s / 2, s / 2):
                    banner(sub, x, banners[face][0], banners[face][1], -s, -1, width=1.0)
            if sub.lod == 0:
                sub.decal((0.0, crown_y, -s - 0.6), 2, -1, w * 0.8, 2.6, "streak", (sub.part, face, "crown"))
                sub.decal((-s * 0.55, crown_y - 1.0, -s), 2, -1, 1.2, 3.5, "streak", (sub.part, face, "c2"))
        turned(kit, build, face)
    if roof:
        pavilion_roof(kit, s, h - 0.15, h + 2.6, h + roof, overhang=0.7)
    hatch(kit, -0.6, -0.6, 0.6, 0.6, h)


def corner_tower(kit, w, h, d):
    s = w / 2
    # The wall walks' ramps reach the top on the +X and +Z faces over [-1.4, 2.0] (the curtain wall's walk).
    span = [(-1.7, 2.3)]
    tower_body(kit, w, h, d, plinth=1.2, strings=(7.72, 12.0), slits_at=((3.6, 1.4), (10.0, 1.4)),
               banners={"-z": (8.4, 11.8), "-x": (8.4, 11.8)}, batter=2.6, crown_y=h - 1.0, roof=10.0,
               gaps={"+x": span, "+z": [(-2.3, 1.7)]})
    if kit.lod == 0:
        for face_x, face_z in ((0, -s - 0.85), (-s - 0.85, 0)):
            if face_x == 0:
                rubble_line(kit, -s - 0.9, s - 1.0, -s - 0.85, -1, ("tower-rubble", "z"), density=1.0, big=0.55, reach=0.8)
            else:
                start = len(kit.details)
                rubble_line(kit, -s + 1.0, s + 0.9, -s - 0.85, -1, ("tower-rubble", "x"), density=1.0, big=0.55, reach=0.8)
                for k in range(start, len(kit.details)):
                    corners, faces, t, uv = kit.details[k]
                    kit.details[k] = ([(cz, cy, -cx) for cx, cy, cz in corners], faces, t, uv)


def central_tower(kit, w, h, d):
    # The tower lifts arrive at the top beside each face (a 2.7 m pillar); keep their spans clear.
    tower_body(kit, w, h, d, plinth=0.5, strings=(4.0,), slits_at=((2.4, 1.2),),
               banners={"-z": (2.4, 5.9), "+z": (2.4, 5.9), "-x": (2.4, 5.9), "+x": (2.4, 5.9)}, batter=0, crown_y=h - 1.0,
               roof=10.5, gaps={"-z": [(-5.6, -2.4)], "+x": [(-5.6, -2.4)], "+z": [(-5.6, -2.4)], "-x": [(-5.6, -2.4)]})


def keep_wall(kit, w, h, d, buried, windows, banner_at):
    x0 = -w / 2 + (d if buried else 0)
    lo, hi = (x0, 0, -d / 2), (w / 2, h, d / 2)
    dressed(kit, lo, hi, plinth=0.6, strings=(3.7,), coping=0.32, top="trim", quoins=(not buried, True))
    front = -d / 2
    if kit.lod < 2:
        kit.prism([(front - 0.3, 0), (front + 0.1, 0), (front + 0.1, 0.62), (front, 0.62), (front - 0.3, 0.3)], x0, w / 2,
                  ["trimDark", "trim", "trim", "trim", "trim", "trim"], layer="details", tint=0.9)
    for x in windows:
        for z, sign in ((-d / 2, -1), (d / 2, 1)):
            if kit.lod == 2:
                continue
            za, zb = sorted((z - sign * 0.32, z + sign * 0.1))
            kit.box((x - 0.4, 4.5, za), (x + 0.4, 6.1, zb), "woodDark", layer="cuts")
            kit.box((x - 0.12, 6.1, za), (x + 0.12, 6.35, zb), "void", layer="cuts")
            sa, sb = sorted((z, z - sign * (INSET + 0.14)))
            kit.box((x - 0.6, 4.32, sa), (x + 0.6, 4.5, sb), "trim", "trimDark", "trimDark", layer="details", chamfer=0.02)
            if kit.lod == 0:
                kit.box((x - 0.6, 6.35, sa), (x + 0.6, 6.55, sb), "trim", "trimDark", "trimDark", layer="details", chamfer=0.02)
                ia, ib = sorted((z - sign * 0.32, z - sign * 0.29))
                kit.box((x - 0.03, 4.5, ia), (x + 0.03, 6.1, ib), "iron", layer="details")
                kit.decal((x, 4.32, z), 2, sign, 1.0, 2.2, "streak", ("kw", x, sign))
    if banner_at is not None:
        banner(kit, banner_at, 0.75, 3.55, -d / 2, -1, width=1.2)
    rubble_line(kit, x0 + 0.3, w / 2 - 0.3, front - 0.3, -1, ("keep-rubble", w), density=0.45, big=0.4, reach=0.5)
    if kit.lod == 0:
        x = x0 + 0.8
        i = 0
        while x < w / 2 - 0.8:
            i += 1
            kit.decal((x, 1.05, front), 2, -1, 1.5, 1.0, "moss", ("km", w, i))
            x += 2.4 + 2.0 * rnd("kmx", w, i)


def door_lintel(kit, w, h, d):
    kit.box((-w / 2, 0, -d / 2 + INSET), (w / 2, h - 0.32, d / 2 - INSET), "trimDark", "trimDark", "trim")
    kit.box((-w / 2, h - 0.32, -d / 2), (w / 2, h, d / 2), "trim", "trim", "trimDark")
    for z, sign in ((-d / 2, -1), (d / 2, 1)):
        arch(kit, w / 2, -1.3, -0.02, 0.0, z, sign, depth=0.3)
        kit.box((-w / 2, 0.0, min(z, z - sign * 0.3)), (w / 2, h - 0.32, max(z, z - sign * 0.3)), "trim", "trimDark",
                "trimDark", layer="details")


def keep_roof(kit, w, h, d, holes, hatches):
    beam_h = 0.12 if kit.lod < 2 else 0
    kit.box((-w / 2, beam_h, -d / 2), (w / 2, h, d / 2), "trim", "floor", "woodDark")
    if beam_h:
        kit.box((-w / 2, 0, -d / 2), (w / 2, beam_h, -d / 2 + 0.3), "trim", "trimDark", "trimDark")
        kit.box((-w / 2, 0, d / 2 - 0.3), (w / 2, beam_h, d / 2), "trim", "trimDark", "trimDark")
        kit.box((-w / 2, 0, -d / 2), (-w / 2 + 0.3, beam_h, d / 2), "trim", "trimDark", "trimDark")
        kit.box((w / 2 - 0.3, 0, -d / 2), (w / 2, beam_h, d / 2), "trim", "trimDark", "trimDark")
        z = -d / 2 + 1.4
        while z < d / 2 - 0.5:
            kit.box((-w / 2 + 0.3, 0, z - 0.14), (w / 2 - 0.3, beam_h, z + 0.14), "wood", "wood", "wood")
            z += 1.4
    for x0, z0, x1, z1 in holes:
        kit.box((x0, -0.2, z0), (x1, h + 0.2, z1), "trim", layer="cuts")
    for x0, z0, x1, z1 in hatches:
        hatch(kit, x0, z0, x1, z1, h)
    if kit.lod == 0:
        # Drains: shallow gutters along the edge, cut 3 cm.
        for i in range(-3, 4):
            c = i * 3.4
            kit.box((c - 0.12, h - 0.03, -d / 2 - 0.1), (c + 0.12, h + 0.1, -d / 2 + 0.6), "trimDark", layer="cuts")
    s = w / 2
    # A corbelled cornice under the roof's edge on every face, clear of the bridges (|x| < 1.8), and a bartizan
    # hung on each corner below the roof's level: the roof itself stays open at its edges.
    for face in ("-z", "+z", "-x", "+x"):
        def build(sub, face=face):
            if sub.lod < 2:
                for a, b in ((-s - 0.45, -1.8), (1.8, s - 0.05)):
                    sub.box((a, h - 0.62, -s - 0.45), (b, h - 0.2, -s + 0.05), "trim", "trimDark", "trimDark", layer="details")
            corbel_row(sub, -s + 0.6, s - 0.6, -s, -1, h - 0.62, depth=0.4, spacing=0.9, skip=[(-2.2, 2.2)])
            if sub.lod == 0:
                sub.decal((-s / 2, h - 0.62, -s - 0.45), 2, -1, 4.0, 2.4, "streak", ("roof", face, 1))
                sub.decal((s / 2 + 1.0, h - 0.62, -s - 0.45), 2, -1, 3.0, 1.8, "streak", ("roof", face, 2))
            if sub.lod < 2:
                # The bartizan on this face's -x corner: an octagonal turret corbelled out below the roof line.
                cx, cz, r = -s - 0.47, -s - 0.47, 0.6  # small enough that it and its roof stay clear of the walk
                ring = lambda rr: [(cx + rr * math.cos(math.pi / 8 + k * math.pi / 4), cz + rr * math.sin(math.pi / 8 + k * math.pi / 4))
                                   for k in range(8)]
                sub.frustum(ring(0.15), ring(r), h - 3.4, h - 1.6, "trim", cap="trim", base="trim")
                sub.frustum(ring(r), ring(r), h - 1.6, h + 1.2, "wall", cap="trimDark", base="trim")
                sub.frustum(ring(r + 0.04), ring(r + 0.04), h + 1.0, h + 1.25, "trim", cap="trimDark", base="trimDark")
                sub.frustum(ring(r + 0.02), ring(0.04), h + 1.25, h + 3.6, "roof", cap="roof", base="woodDark")
                if sub.lod == 0:
                    sub.box((cx - 0.04, h + 3.4, cz - 0.04), (cx + 0.04, h + 4.2, cz + 0.04), "iron", layer="details")
                    for k in range(8):
                        if k in (0, 3, 6):
                            a = math.pi / 8 + k * math.pi / 4 + math.pi / 8
                            px, pz = cx + r * math.cos(a), cz + r * math.sin(a)
                            sub.box((px - 0.05, h - 0.2, pz - 0.05), (px + 0.05, h + 0.6, pz + 0.05), "void", layer="details",
                                    tint=1.0)
        turned(kit, build, face)


def hatch(kit, x0, z0, x1, z1, top, depth=0.05):
    """A plank hatch recessed ``depth`` below ``top``, with iron straps."""
    kit.box((x0, top - depth, z0), (x1, top + 0.1, z1), "wood", layer="cuts")
    if kit.lod == 0:
        for k in range(1, 3):
            z = z0 + (z1 - z0) * k / 3
            kit.box((x0 + 0.04, top - depth, z - 0.04), (x1 - 0.04, top - depth + 0.012, z + 0.04), "iron", layer="details")


def bridge(kit, w, h, d):
    deck = h - 0.12
    kit.box((-w / 2, deck, -d / 2), (w / 2, h, d / 2), "woodDark", "wood", "woodDark")
    stringer = 0.32
    # Deep stringers hang below the collider (decoration above head height over the courtyard).
    low = -0.75 if kit.lod < 2 else 0
    kit.box((-w / 2 + 0.03, low, -d / 2), (-w / 2 + stringer, deck, d / 2), "woodDark", "woodDark", "woodDark")
    kit.box((w / 2 - stringer, low, -d / 2), (w / 2 - 0.03, deck, d / 2), "woodDark", "woodDark", "woodDark")
    kit.box((-w / 2 + stringer, 0.1 if kit.lod < 2 else 0, -d / 2), (w / 2 - stringer, deck, d / 2), "wood", "wood", "wood")
    if kit.lod < 2:
        z = -d / 2 + 0.6
        while z < d / 2 - 0.3:
            kit.box((-w / 2 + stringer, -0.2, z - 0.1), (w / 2 - stringer, 0.1, z + 0.1), "woodDark")
            z += 1.2
    if kit.lod == 0:
        z = -d / 2 + 1.5
        while z < d / 2 - 1:
            for x0, x1 in ((-w / 2, -w / 2 + 0.03), (w / 2 - 0.03, w / 2)):
                kit.box((x0, low + 0.04, z - 0.06), (x1, deck - 0.02, z + 0.06), "iron", layer="details")
            z += 3.0
        z = -d / 2 + 3.0
        while z < d / 2 - 2:
            kit.beam((-w / 2 + stringer, low + 0.1, z - 1.4), (w / 2 - stringer, -0.15, z + 1.4), 0.12, up=(0, 0, 1))
            kit.beam((w / 2 - stringer, low + 0.1, z - 1.4), (-w / 2 + stringer, -0.15, z + 1.4), 0.12, up=(0, 0, 1))
            z += 6.0


def lift_column(kit, w, h, d):
    s = 0.1  # stands 10 cm inside its box, clear of the lift pillar that shares its footprint
    lo, hi = (-w / 2 + s, 0, -d / 2 + s), (w / 2 - s, h, d / 2 - s)
    dressed(kit, lo, hi, plinth=0.5, strings=(3.6,), coping=0.3, top="trimDark")


def lift(kit, w, h, d):
    top = h - 0.18
    kit.box((-w / 2, top, -d / 2), (w / 2, h, d / 2), "iron", "wood", "woodDark")
    kit.box((-w / 2 + INSET, 0, -d / 2 + INSET), (w / 2 - INSET, top, d / 2 - INSET), "wood", "woodDark", "woodDark")
    post = 0.26
    for sx in (-1, 1):
        for sz in (-1, 1):
            xa, xb = sorted((sx * w / 2, sx * (w / 2 - post)))
            za, zb = sorted((sz * d / 2, sz * (d / 2 - post)))
            kit.box((xa, 0, za), (xb, top, zb), "woodDark")
    if kit.lod == 2:
        return
    rails = [0.0] + [top - 0.2 - i * 1.3 for i in range(0, 7) if top - 0.2 - i * 1.3 > 0.5]
    for y in rails:
        kit.box((-w / 2, y, -d / 2), (w / 2, y + 0.18, d / 2), "woodDark", "woodDark", "woodDark")
    if kit.lod == 0:
        levels = sorted(rails)
        for a, b in zip(levels, levels[1:]):
            for face_z in (-d / 2 + 0.06, d / 2 - 0.06):
                kit.beam((-w / 2 + post, a + 0.18, face_z), (w / 2 - post, b, face_z), 0.12, up=(0, 0, 1))
            for face_x in (-w / 2 + 0.06, w / 2 - 0.06):
                kit.beam((face_x, a + 0.18, -d / 2 + post), (face_x, b, d / 2 - post), 0.12, up=(1, 0, 0))


def ramp(kit, w, h, d):
    """A 34 degree wedge rising to +Z: ashlar treads with dark nosings on the slope, kerbs along both edges."""
    z0, z1 = -d / 2, d / 2
    y_at = lambda z: h * (z - z0) / (z1 - z0)
    if kit.lod == 2:
        kit.prism([(z0, 0), (z1, 0), (z1, h)], -w / 2, w / 2, ["wall", "trim", "trim", "wall"])
        return
    kerb = 0.32 if w > 3.2 else 0.26
    tread, nosing = 0.44, 0.08
    cuts = [z0]
    z = z0
    while z < z1 - 1e-6:
        for step in (tread, nosing):
            z = min(z + step, z1)
            cuts.append(z)
    for i, (a, b) in enumerate(zip(cuts, cuts[1:])):
        top = "trim" if i % 2 == 0 else "trimDark"
        section = [(a, 0), (b, 0), (b, y_at(b)), (a, y_at(a))]
        if a == z0:
            section = [(a, 0), (b, 0), (b, y_at(b))]
        kit.prism(section, -w / 2 + kerb, w / 2 - kerb, (["wall", "trim", top] if len(section) == 3 else ["wall", "trim", top, "trim"]) + ["wall"],
                  layer="details", tint=1.0)
    for xa, xb in ((-w / 2, -w / 2 + kerb), (w / 2 - kerb, w / 2)):
        kit.prism([(z0, 0), (z1, 0), (z1, h)], xa, xb, ["trimDark", "trim", "trim", "wall"], layer="details", tint=1.0)


def build_piece(kit, part, size, arguments):
    w, h, d = size
    if part == "curtain-wall":
        curtain_wall(kit, w, h, d)
    elif part == "gate-lintel":
        gate_lintel(kit, w, h, d)
    elif part == "parapet":
        parapet(kit, w, h, d)
    elif part == "corner-tower":
        corner_tower(kit, w, h, d)
    elif part == "central-tower":
        central_tower(kit, w, h, d)
    elif part == "keep-wall-long":
        keep_wall(kit, w, h, d, buried=True, windows=(-3.6, 0.6), banner_at=w / 2 - 1.3)
    elif part == "keep-wall-short":
        keep_wall(kit, w, h, d, buried=False, windows=(1.0,), banner_at=-w / 2 + 1.3)
    elif part == "hall-wall":
        keep_wall(kit, w, h, d, buried=True, windows=(), banner_at=None)
    elif part == "door-lintel":
        door_lintel(kit, w, h, d)
    elif part == "keep-roof":
        keep_roof(kit, w, h, d, arguments.get("holes", []), arguments.get("hatches", []))
    elif part == "bridge":
        bridge(kit, w, h, d)
    elif part == "lift-column":
        lift_column(kit, w, h, d)
    elif part in ("lift-courtyard", "lift-tower"):
        lift(kit, w, h, d)
    elif part.startswith("ramp-"):
        ramp(kit, w, h, d)


def build(arguments, inputs, collection):
    kit = Kit(arguments["lod"], arguments["part"])
    build_piece(kit, arguments["part"], arguments["size"], arguments)
    materials = make_materials(inputs)
    name = f"fortress.{arguments['part']}"
    obj = assemble(kit, name, materials, collection)
    # Drop unused material slots so the GLB carries only what it draws.
    used = sorted({p.material_index for p in obj.data.polygons})
    remap = {old: new for new, old in enumerate(used)}
    kept = [obj.data.materials[i] for i in used]
    indices = [remap[polygon.material_index] for polygon in obj.data.polygons]
    obj.data.materials.clear()
    for material in kept:
        obj.data.materials.append(material)
    obj.data.polygons.foreach_set("material_index", indices)
    obj.data.update()
    return obj


def measure(obj):
    points = [obj.matrix_world @ v.co for v in obj.data.vertices]
    gltf = [(p.x, p.z, -p.y) for p in points]
    return {"min": [round(min(p[i] for p in gltf), 6) for i in range(3)],
            "max": [round(max(p[i] for p in gltf), 6) for i in range(3)]}


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    obj = build(arguments, inputs, bpy.context.scene.collection)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    triangles = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    bounds = measure(obj)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False, export_image_format="JPEG", export_image_quality=JPEG_QUALITY,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "part": arguments["part"], "lod": arguments["lod"], "size": arguments["size"],
            "triangles": triangles, "bounds": bounds, "materials": [m["fortressMaterial"] for m in obj.data.materials]}
