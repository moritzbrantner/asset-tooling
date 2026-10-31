"""Battle Royale fortress kit (asset-tooling#445): authored, textured pieces fitted to the shared graybox collision.

One run builds one piece at one level of detail. Every piece is dressing over one authoritative collider box (or ramp
wedge, or lift pillar) of ``battle_royale_core::arena`` (docs/fortress-kit.md): it is built at exactly that box's
``size`` and never reaches outside it, so the art never changes traversal. The only places where the art sits below a
collider's top are the parapet's 0.28 m crenels and the 5 cm lift hatches in the keep roof.

Frame: metres, glTF right-handed +Y up. The origin is the base centre of the fitted box. Outward (the side facing away
from the arena centre for the south side's bodies) is -Z; ramps rise towards +Z.

Relief: wall faces stand 6 cm inside the box (``INSET``); plinths, string courses, copings, quoins, pilasters and
corbels stand flush with the box face, so the masonry reads in relief while the outer silhouette stays the box.
Openings (arrow slits, blind windows, the portcullis slot, the roof's ramp openings) are boolean cuts.

Materials: four tileable CC0 Poly Haven PBR sets (colour, OpenGL normal, roughness) declared as inputs, resized to
1024 px and shared by every piece and level, so a ``gltf-resources-v1`` bundle stores each image once:

- ``wall``: ``castle_wall_slates`` coursed rubble, the large wall faces;
- ``trim``: ``japanese_stone_wall`` ashlar, the dressings (and ``trimDark``, the same maps darker);
- ``floor``: ``stone_tiles_02`` flagstones, every walkable top;
- ``wood``: ``old_planks_02`` planks (and ``woodDark``), the bridge, the lifts, hatches and shutters.

Iron, the Marshal-blue banner cloth, its pale stripe and the dark ``void`` inside openings are plain colours.

Levels of detail (``lod``): 0 is the full piece; 1 drops quoins, corbels, slit surrounds, voussoir joints, braces and
banner trims; 2 keeps only the main masses, the walkable tops, the roof openings and the materials.

No randomness. ``build(arguments, inputs, collection)`` also runs in a live Blender session (``runpy.run_path``).
"""
import math

import bmesh
import bpy
from mathutils import Vector

RECIPE = "fortress-kit-v1"
PARTS = (
    "curtain-wall", "gate-lintel", "parapet", "corner-tower", "keep-wall-long", "keep-wall-short", "hall-wall",
    "door-lintel", "keep-roof", "central-tower", "bridge", "lift-column", "ramp-courtyard", "ramp-tower", "ramp-keep",
    "lift-courtyard", "lift-tower",
)
INSET = 0.06
TEXTURE_EDGE = 1024
JPEG_QUALITY = 88
SETS = ("wall", "trim", "floor", "wood")
MAPS = ("Colour", "Normal", "Roughness")
INPUTS = tuple(f"{s}{m}" for s in SETS for m in MAPS)
# Material -> (texture set, metres per tile, base-colour factor, roughness factor).
TEXTURED = {
    "wall": ("wall", 2.6, (0.66, 0.68, 0.72), 1.0),
    "trim": ("trim", 2.2, (0.92, 0.91, 0.88), 1.0),
    "trimDark": ("trim", 2.2, (0.52, 0.51, 0.5), 1.0),
    "floor": ("floor", 3.0, (0.82, 0.81, 0.79), 1.0),
    "wood": ("wood", 2.0, (0.9, 0.86, 0.8), 1.0),
    "woodDark": ("wood", 2.0, (0.42, 0.37, 0.33), 1.0),
}
# Material -> (linear base colour, metallic, roughness).
PLAIN = {
    "iron": ((0.035, 0.036, 0.04), 0.85, 0.55),
    "cloth": ((0.035, 0.06, 0.12), 0.0, 0.9),
    "clothTrim": ((0.5, 0.43, 0.3), 0.0, 0.85),
    "void": ((0.012, 0.011, 0.01), 0.0, 1.0),
}
MATERIALS = tuple(TEXTURED) + tuple(PLAIN)


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


# ---------------------------------------------------------------------------------------------------------------------
# Geometry: boxes (and convex prisms) in the glTF frame, gathered per layer.

def bl(p):
    """A glTF (+Y up) point in Blender's +Z-up frame."""
    return Vector((p[0], -p[2], p[1]))


class Kit:
    def __init__(self, lod):
        self.lod = lod
        self.solid = []    # unioned
        self.cuts = []     # subtracted from the union
        self.details = []  # joined as separate shells

    def box(self, lo, hi, side, top=None, bottom=None, layer="solid"):
        if any(hi[i] - lo[i] <= 1e-6 for i in range(3)):
            return
        x0, y0, z0 = lo
        x1, y1, z1 = hi
        corners = [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), (x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)]
        faces = [((0, 1, 2, 3), bottom or side), ((4, 7, 6, 5), top or side), ((0, 4, 5, 1), side), ((1, 5, 6, 2), side),
                 ((2, 6, 7, 3), side), ((3, 7, 4, 0), side)]
        getattr(self, layer).append((corners, faces))

    def prism(self, section, x0, x1, materials, layer="solid"):
        """A convex prism along X from a counter-clockwise (z, y) section; ``materials`` per section edge, then ends."""
        n = len(section)
        corners = [(x0, y, z) for z, y in section] + [(x1, y, z) for z, y in section]
        faces = [((tuple(reversed(range(n)))), materials[n])] + [(tuple(range(n, 2 * n)), materials[n])]
        for i in range(n):
            j = (i + 1) % n
            faces.append(((i, j, n + j, n + i), materials[i]))
        getattr(self, layer).append((corners, faces))

    def beam(self, a, b, width, depth_axis, material, layer="details"):
        """A square-section beam from a to b (glTF points) lying in the plane normal to ``depth_axis``."""
        a, b = Vector(a), Vector(b)
        d = (b - a).normalized()
        n = Vector([1.0 if i == depth_axis else 0.0 for i in range(3)])
        s = d.cross(n).normalized() * (width / 2)
        t = n * (width / 2)
        corners = [tuple(p) for p in (a - s - t, a + s - t, a + s + t, a - s + t, b - s - t, b + s - t, b + s + t, b - s + t)]
        faces = [((0, 3, 2, 1), material), ((4, 5, 6, 7), material), ((0, 1, 5, 4), material), ((1, 2, 6, 5), material),
                 ((2, 3, 7, 6), material), ((3, 0, 4, 7), material)]
        getattr(self, layer).append((corners, faces))


def mesh_object(name, shells, materials, collection):
    mesh = bpy.data.meshes.new(name)
    for material in materials:
        mesh.materials.append(material)
    index = {m["fortressMaterial"]: i for i, m in enumerate(materials)}
    bm = bmesh.new()
    for corners, faces in shells:
        verts = [bm.verts.new(bl(c)) for c in corners]
        for loop, material in faces:
            face = bm.faces.new([verts[i] for i in loop])
            face.material_index = index[material]
    # Every shell is a closed convex solid: point all its faces outward whatever order they were listed in.
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
        # Cutters may touch or overlap one another (a hatch beside a ramp opening).
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
    """Union the solid boxes, subtract the cuts, then join the details (shells that only touch, never overlap)."""
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
    # Triangles, so the observed triangle count is what ships.
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="BEAUTY", ngon_method="BEAUTY")
    bm.to_mesh(obj.data)
    bm.free()
    unwrap(obj, materials)
    for polygon in obj.data.polygons:
        polygon.use_smooth = False
    return obj


def unwrap(obj, materials):
    """World-scale UVs: horizontal faces map X/Z, the others their horizontal tangent and its upward partner."""
    mesh = obj.data
    layer = mesh.uv_layers.new(name="UVMap") if not mesh.uv_layers else mesh.uv_layers[0]
    tiles = [TEXTURED.get(m["fortressMaterial"], (None, 1.0))[1] for m in materials]
    up = Vector((0, 0, 1))
    for polygon in mesh.polygons:
        n = polygon.normal
        scale = 1.0 / tiles[polygon.material_index]
        if abs(n.z) > 0.9:
            u_axis, v_axis = Vector((1, 0, 0)), Vector((0, 1, 0)) * (1 if n.z > 0 else -1)
        else:
            u_axis = up.cross(n).normalized()
            v_axis = n.cross(u_axis).normalized()
        for loop in polygon.loop_indices:
            co = mesh.vertices[mesh.loops[loop].vertex_index].co
            layer.data[loop].uv = (co.dot(u_axis) * scale, co.dot(v_axis) * scale)


# ---------------------------------------------------------------------------------------------------------------------
# Materials.

def load_image(path, colour):
    image = bpy.data.images.load(path, check_existing=True)
    image.colorspace_settings.is_data = not colour
    if tuple(image.size) != (TEXTURE_EDGE, TEXTURE_EDGE):
        image.scale(TEXTURE_EDGE, TEXTURE_EDGE)
    return image


def make_materials(inputs):
    images = {}
    for s in SETS:
        images[s] = {m: load_image(inputs[f"{s}{m}"], m == "Colour") for m in MAPS}
    materials = []
    for name in MATERIALS:
        material = bpy.data.materials.new(f"fortress.{name}")
        material["fortressMaterial"] = name
        material.use_nodes = True
        material.use_backface_culling = True
        tree = material.node_tree
        bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
        if name in TEXTURED:
            texture_set, _, factor, _ = TEXTURED[name]
            maps = images[texture_set]
            colour = tree.nodes.new("ShaderNodeTexImage")
            colour.image = maps["Colour"]
            mix = tree.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs["Factor"].default_value = 1.0
            mix.inputs[7].default_value = (*factor, 1.0)
            tree.links.new(colour.outputs["Color"], mix.inputs[6])
            tree.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
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
            bsdf.inputs["Metallic"].default_value = 0.0
        else:
            colour, metallic, roughness = PLAIN[name]
            bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
            bsdf.inputs["Metallic"].default_value = metallic
            bsdf.inputs["Roughness"].default_value = roughness
        materials.append(material)
    return materials


# ---------------------------------------------------------------------------------------------------------------------
# Shared dressings.

def dressed(kit, lo, hi, plinth=0.6, strings=(), coping=0.4, top="floor", wall="wall", quoins=(True, True), inset=INSET,
            bottom="trimDark"):
    """A masonry block: plinth, string courses and coping flush with the box, the wall face inset, quoins at the ends.

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
                        kit.box((xa, h, za), (xb, top_h - 0.02, zb), "trim", "trimDark", "trimDark")
                    course += 1
                    h = top_h
                h = b1


def slit(kit, centre, face, width=0.14, height=1.2, depth=0.45):
    """An arrow slit cut into the face (+-z or +-x, glTF) at ``centre`` (the slit's centre on the box face)."""
    if kit.lod == 2:
        return
    cx, cy, cz = centre
    axis = 2 if face in ("-z", "+z") else 0
    sign = -1 if face[0] == "-" else 1
    lo, hi = list(centre), list(centre)
    lo[1], hi[1] = cy - height / 2, cy + height / 2
    other = 0 if axis == 2 else 2
    lo[other], hi[other] = centre[other] - width / 2, centre[other] + width / 2
    lo[axis], hi[axis] = sorted((centre[axis] - sign * depth, centre[axis] + sign * 0.1))
    kit.box(tuple(lo), tuple(hi), "void", layer="cuts")
    if kit.lod == 0:
        # A dressed surround flush with the box face.
        for (a0, a1), (b0, b1) in (((-width / 2 - 0.16, -width / 2), (-height / 2 - 0.16, height / 2 + 0.16)),
                                   ((width / 2, width / 2 + 0.16), (-height / 2 - 0.16, height / 2 + 0.16)),
                                   ((-width / 2, width / 2), (-height / 2 - 0.16, -height / 2)),
                                   ((-width / 2, width / 2), (height / 2, height / 2 + 0.16))):
            lo, hi = [0, 0, 0], [0, 0, 0]
            lo[other], hi[other] = centre[other] + a0, centre[other] + a1
            lo[1], hi[1] = cy + b0, cy + b1
            lo[axis], hi[axis] = sorted((centre[axis], centre[axis] - sign * (INSET + 0.1)))
            kit.box(tuple(lo), tuple(hi), "trim", "trimDark", "trimDark")


def banner(kit, x, y0, y1, face_z, sign, width=1.3):
    """A Marshal-blue banner hanging in the relief on a z face (sign -1: the -z face) from y1 down to y0."""
    if kit.lod == 2:
        return
    back = face_z - sign * INSET          # the inset wall face
    za, zb = sorted((back, back + sign * 0.025))
    kit.box((x - width / 2, y0 + 0.35, za), (x + width / 2, y1, zb), "cloth", layer="details")
    # The swallow-tail: two narrowing tips.
    for k, tip in enumerate((-1, 1)):
        xa = x + (tip - 1) * width / 4 if tip < 0 else x
        kit.box((xa, y0, za), (xa + width / 2, y0 + 0.35, zb), "cloth", layer="details")
    if kit.lod == 0:
        za2, zb2 = sorted((back + sign * 0.025, back + sign * 0.03))
        kit.box((x - width / 2 + 0.12, y1 - 1.0, za2), (x + width / 2 - 0.12, y1 - 0.85, zb2), "clothTrim", layer="details")
        kit.box((x - 0.08, y0 + 0.6, za2), (x + 0.08, y1 - 1.25, zb2), "clothTrim", layer="details")
        zp0, zp1 = sorted((back, back + sign * 0.055))
        kit.box((x - width / 2 - 0.12, y1, zp0), (x + width / 2 + 0.12, y1 + 0.07, zp1), "woodDark", layer="details")


def corbels(kit, lo, hi, y0, y1, faces, spacing=0.7, width=0.26):
    """A corbel table: blocks flush with the box face between y0 and y1 on the given z/x faces."""
    if kit.lod != 0:
        return
    x0, _, z0 = lo
    x1, _, z1 = hi
    for face in faces:
        along = (x0, x1) if face in ("-z", "+z") else (z0, z1)
        length = along[1] - along[0] - 1.6
        count = max(1, int(length / spacing))
        step = length / count
        for i in range(count + 1):
            c = along[0] + 0.8 + i * step
            if face in ("-z", "+z"):
                z = z0 if face == "-z" else z1
                za, zb = sorted((z, z + (INSET + 0.08) * (1 if face == "-z" else -1)))
                kit.box((c - width / 2, y0, za), (c + width / 2, y1, zb), "trim", "trimDark", "trimDark")
            else:
                x = x0 if face == "-x" else x1
                xa, xb = sorted((x, x + (INSET + 0.08) * (1 if face == "-x" else -1)))
                kit.box((xa, y0, c - width / 2), (xb, y1, c + width / 2), "trim", "trimDark", "trimDark")


def hatch(kit, x0, z0, x1, z1, top, depth=0.05):
    """A plank hatch recessed ``depth`` below ``top``, with iron straps."""
    kit.box((x0, top - depth, z0), (x1, top + 0.1, z1), "wood", layer="cuts")
    if kit.lod == 0:
        for k in range(1, 3):
            z = z0 + (z1 - z0) * k / 3
            kit.box((x0 + 0.04, top - depth, z - 0.04), (x1 - 0.04, top - depth + 0.012, z + 0.04), "iron", layer="details")


def voussoirs(kit, x0, x1, y0, y1, z, sign, key_height):
    """A flat arch of voussoirs on the face at z (sign -1: -z face), flush with the box face, with a raised keystone."""
    za, zb = sorted((z, z - sign * (INSET + 0.1)))
    if kit.lod != 0:
        kit.box((x0, y0, za), (x1, y1, zb), "trim", "trimDark", "trim")
        kit.box((-0.35, y0, za), (0.35, key_height, zb), "trim", "trimDark", "trim")
        return
    count = max(5, int(round((x1 - x0) / 0.6)) | 1)
    width = (x1 - x0) / count
    for i in range(count):
        a, b = x0 + i * width + 0.012, x0 + (i + 1) * width - 0.012
        middle = i == count // 2
        kit.box((a, y0, za), (b, key_height if middle else y1, zb), "trim", "trimDark", "trim")


# ---------------------------------------------------------------------------------------------------------------------
# Pieces. Each takes the fitted box size (w, h, d) and builds inside x -w/2..w/2, y 0..h, z -d/2..d/2.

def curtain_wall(kit, w, h, d):
    lo, hi = (-w / 2, 0, -d / 2), (w / 2, h, d / 2)
    dressed(kit, lo, hi, plinth=0.9, strings=(4.6,), coping=0.45)
    if kit.lod < 2:
        # Pilasters on the courtyard face, one per 8 m module.
        for i in range(-5, 6):
            x = i * 8.0
            kit.box((x - 0.45, 0.9, d / 2 - INSET - 0.2), (x + 0.45, 4.6, d / 2), "trim", "trimDark")
            kit.box((x - 0.45, 4.88, d / 2 - INSET - 0.2), (x + 0.45, h - 0.45, d / 2), "trim", "trimDark")
    corbels(kit, lo, hi, h - 0.85, h - 0.45, ("-z",), spacing=0.9)
    for i in range(-7, 8):
        x = i * 6.0
        if abs(x + 3.0) < w / 2 - 1.5:
            slit(kit, (x + 3.0, 2.9, -d / 2), "-z")
        if abs(x) < w / 2 - 1.5:
            slit(kit, (x, 6.4, -d / 2), "-z", height=1.0)


def gate_lintel(kit, w, h, d):
    kit.box((-w / 2, 0, -d / 2 + INSET), (w / 2, h - 0.4, d / 2 - INSET), "trimDark", "trimDark", "trim")
    kit.box((-w / 2, h - 0.4, -d / 2), (w / 2, h, d / 2), "trim", "floor", "trimDark")
    for z, sign in ((-d / 2, -1), (d / 2, 1)):
        voussoirs(kit, -w / 2, w / 2, 0, h - 0.62, z, sign, h - 0.4)
    if kit.lod < 2:
        # The raised portcullis in its slot under the lintel: iron bars ending flush with the underside.
        kit.box((-w / 2 + 0.1, -0.1, -d / 2 + 0.75), (w / 2 - 0.1, 0.7, -d / 2 + 1.05), "void", layer="cuts")
        for i in range(int((w - 0.4) / 0.32) + 1):
            x = -w / 2 + 0.2 + i * 0.32
            kit.box((x - 0.035, 0.0, -d / 2 + 0.86), (x + 0.035, 0.7, -d / 2 + 0.94), "iron", layer="details")
        kit.box((-w / 2 + 0.1, 0.18, -d / 2 + 0.84), (w / 2 - 0.1, 0.26, -d / 2 + 0.96), "iron", layer="details")
        for x in (-1.4, 1.4):
            kit.box((x - 0.22, -0.1, 0.2), (x + 0.22, 0.4, 0.64), "void", layer="cuts")


def parapet(kit, w, h, d):
    if kit.lod == 2:
        kit.box((-w / 2, 0, -d / 2), (w / 2, h, d / 2), "trim", "trimDark")
        return
    base = h - 0.28
    kit.box((-w / 2, 0, -d / 2), (w / 2, base, d / 2), "trim", "trimDark")
    period, merlon = 2.4, 1.5
    count = int(w / period)
    start = -count * period / 2
    for i in range(count):
        a = start + i * period + (period - merlon) / 2
        kit.box((a, base - 0.01, -d / 2), (a + merlon, h, d / 2), "trim", "trimDark", "trimDark")
        if kit.lod == 0 and i % 2 == 0:
            m = a + merlon / 2
            kit.box((m - 0.04, base - 0.4, -d / 2 - 0.1), (m + 0.04, h - 0.08, d / 2 + 0.1), "void", layer="cuts")


def tower(kit, w, h, d, strings, slits, banners, plinth):
    lo, hi = (-w / 2, 0, -d / 2), (w / 2, h, d / 2)
    dressed(kit, lo, hi, plinth=plinth, strings=strings, coping=0.5)
    corbels(kit, lo, hi, h - 1.05, h - 0.5, ("-z", "+z", "-x", "+x"), spacing=0.75)
    for y, height in slits:
        for face, centre in (("-z", (0, y, -d / 2)), ("+z", (0, y, d / 2)), ("-x", (-w / 2, y, 0)), ("+x", (w / 2, y, 0))):
            slit(kit, centre, face, height=height)
    for face, y0, y1 in banners:
        offset = w / 4
        if face in ("-z", "+z"):
            sign = -1 if face == "-z" else 1
            for x in (-offset, offset):
                banner(kit, x, y0, y1, sign * d / 2, sign)
        else:
            # Build on the -z face of a square tower and turn a quarter about +Y: -z -> -x is (x, z) -> (z, -x),
            # -z -> +x is (x, z) -> (-z, x). Both are proper rotations, so the faces keep their winding.
            sub = Kit(kit.lod)
            for x in (-offset, offset):
                banner(sub, x, y0, y1, -d / 2, -1)
            turn = (lambda x, z: (z, -x)) if face == "-x" else (lambda x, z: (-z, x))
            for corners, faces in sub.details:
                turned = []
                for cx, cy, cz in corners:
                    tx, tz = turn(cx, cz)
                    turned.append((tx, cy, tz))
                kit.details.append((turned, faces))
    hatch(kit, -0.6, -0.6, 0.6, 0.6, h)


def corner_tower(kit, w, h, d):
    tower(kit, w, h, d, strings=(7.72, 12.0), slits=((3.6, 1.3), (10.0, 1.3), (13.6, 1.0)),
          banners=(("-z", 8.4, 11.8), ("-x", 8.4, 11.8)), plinth=1.2)


def central_tower(kit, w, h, d):
    tower(kit, w, h, d, strings=(4.0,), slits=((2.4, 1.1), (5.6, 1.1)),
          banners=(("-z", 0.7, 3.8), ("+z", 0.7, 3.8), ("-x", 0.7, 3.8), ("+x", 0.7, 3.8)), plinth=0.5)


def keep_wall(kit, w, h, d, buried, windows, banner_at):
    x0 = -w / 2 + (d if buried else 0)
    lo, hi = (x0, 0, -d / 2), (w / 2, h, d / 2)
    dressed(kit, lo, hi, plinth=0.6, strings=(3.7,), coping=0.32, top="trim", quoins=(not buried, True))
    for x in windows:
        for z, sign in ((-d / 2, -1), (d / 2, 1)):
            if kit.lod == 2:
                continue
            za, zb = sorted((z - sign * 0.2, z + sign * 0.1))
            kit.box((x - 0.45, 4.5, za), (x + 0.45, 6.1, zb), "woodDark", layer="cuts")
            sa, sb = sorted((z, z - sign * (INSET + 0.14)))
            kit.box((x - 0.62, 4.32, sa), (x + 0.62, 4.5, sb), "trim", "trimDark", "trimDark")
            if kit.lod == 0:
                kit.box((x - 0.62, 6.1, sa), (x + 0.62, 6.3, sb), "trim", "trimDark", "trimDark")
                ia, ib = sorted((z - sign * 0.2, z - sign * 0.17))
                kit.box((x - 0.03, 4.5, ia), (x + 0.03, 6.1, ib), "iron", layer="details")
    if banner_at is not None:
        banner(kit, banner_at, 0.75, 3.55, -d / 2, -1, width=1.2)


def door_lintel(kit, w, h, d):
    kit.box((-w / 2, 0, -d / 2 + INSET), (w / 2, h - 0.32, d / 2 - INSET), "trimDark", "trimDark", "trim")
    kit.box((-w / 2, h - 0.32, -d / 2), (w / 2, h, d / 2), "trim", "trim", "trimDark")
    for z, sign in ((-d / 2, -1), (d / 2, 1)):
        voussoirs(kit, -w / 2, w / 2, 0, h - 0.5, z, sign, h - 0.32)


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


def bridge(kit, w, h, d):
    deck = h - 0.12
    kit.box((-w / 2, deck, -d / 2), (w / 2, h, d / 2), "woodDark", "wood", "woodDark")
    stringer = 0.3
    kit.box((-w / 2 + 0.03, 0, -d / 2), (-w / 2 + stringer, deck, d / 2), "woodDark", "woodDark", "woodDark")
    kit.box((w / 2 - stringer, 0, -d / 2), (w / 2 - 0.03, deck, d / 2), "woodDark", "woodDark", "woodDark")
    kit.box((-w / 2 + stringer, 0.1 if kit.lod < 2 else 0, -d / 2), (w / 2 - stringer, deck, d / 2), "wood", "wood", "wood")
    if kit.lod < 2:
        z = -d / 2 + 0.6
        while z < d / 2 - 0.3:
            kit.box((-w / 2 + stringer, 0, z - 0.1), (w / 2 - stringer, 0.1, z + 0.1), "woodDark")
            z += 1.2
    if kit.lod == 0:
        z = -d / 2 + 1.5
        while z < d / 2 - 1:
            for x0, x1 in ((-w / 2, -w / 2 + 0.03), (w / 2 - 0.03, w / 2)):
                kit.box((x0, 0.02, z - 0.06), (x1, deck - 0.02, z + 0.06), "iron", layer="details")
            z += 3.0


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
            for face_z, axis in ((-d / 2 + 0.06, 2), (d / 2 - 0.06, 2)):
                kit.beam((-w / 2 + post, a + 0.18, face_z), (w / 2 - post, b, face_z), 0.12, axis, "woodDark")
            for face_x in (-w / 2 + 0.06, w / 2 - 0.06):
                kit.beam((face_x, a + 0.18, -d / 2 + post), (face_x, b, d / 2 - post), 0.12, 0, "woodDark")


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
                  layer="details")
    # Kerbs: one ashlar strip along each edge, the full slope.
    for xa, xb in ((-w / 2, -w / 2 + kerb), (w / 2 - kerb, w / 2)):
        kit.prism([(z0, 0), (z1, 0), (z1, h)], xa, xb, ["trimDark", "trim", "trim", "wall"], layer="details")


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
    kit = Kit(arguments["lod"])
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
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE",
        export_image_format="JPEG", export_image_quality=JPEG_QUALITY,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "part": arguments["part"], "lod": arguments["lod"], "size": arguments["size"],
            "triangles": triangles, "bounds": bounds, "materials": [m["fortressMaterial"] for m in obj.data.materials]}
