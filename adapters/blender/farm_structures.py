"""Toy-like Farmhouse and Silo, an original scripted recipe for the existing pinned Blender script backend.

One run builds one My Farm structure (asset-tooling#353, consumer my-farm#234, Atlas Decision 1.2.2
colourful toy-like 3D). Owner answers of 2026-10-22: a procedural Blender recipe; a **bright toy**
look with rounded chunky shapes, a saturated red/white farmhouse with a dark roof and a pale silo
with a dome; a **generous** footprint, so the visuals may be up to about 40 % bigger than the 2 x 2
tile gameplay footprint.

Frame: metres (one My Farm tile is 1 m), glTF right-handed +Y up, origin at the centre of the
footprint on the ground plane (y = 0), the front (the farmhouse door, the silo hatch) towards +Z.
Each part is one mesh node ``farm.<part>`` with plain-colour materials (no textures, no vertex
colours), so the GLB is small and self-contained.

- ``farmhouse``: a red house with white trim, corner posts and windows, its door and a round attic
  window in the front gable, on a pale plinth under a dark slate gable roof (ridge front to back)
  with a white chimney;
- ``silo``: a pale cream silo on a stone ring, with pale blue-grey hoops, a dome, a red cap, a red
  hatch and a dark ladder.

Every shape is a beveled box or a lathe of a rounded profile, built directly into one BMesh, so the
face order is fixed and there is no randomness. ``build(part, collection, location)`` also works in a
live Blender session; ``generate`` is the script-backend entry point.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

PARTS = ("farmhouse", "silo")
FOOTPRINT = {"farmhouse": (2.0, 2.0), "silo": (2.0, 2.0)}  # gameplay tiles (x, z), unchanged by the visual
MAX_SCALE = 1.4  # the owner's generous allowance: visuals may exceed the footprint by about 40 %
SHARP_ANGLE = math.radians(40)
SEGMENTS = 32

# name: (sRGB base colour, roughness)
MATERIALS = {
    "red": ((0.85, 0.16, 0.13), 0.6),
    "white": ((0.97, 0.95, 0.9), 0.55),
    "roof": ((0.22, 0.24, 0.3), 0.7),
    "glass": ((0.62, 0.84, 0.95), 0.25),
    "door": ((0.55, 0.12, 0.1), 0.6),
    "stone": ((0.78, 0.74, 0.68), 0.85),
    "cream": ((0.96, 0.92, 0.82), 0.5),
    "hoop": ((0.66, 0.76, 0.84), 0.45),
    "dome": ((0.88, 0.9, 0.92), 0.4),
    "dark": ((0.2, 0.22, 0.26), 0.7),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(name):
    existing = bpy.data.materials.get(f"farm-{name}")
    if existing is not None:
        return existing
    colour, roughness = MATERIALS[name]
    mat = bpy.data.materials.new(f"farm-{name}")
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = tuple(srgb_to_linear(c) for c in colour) + (1,)
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = tuple(srgb_to_linear(c) for c in colour) + (1,)
    return mat


class Builder:
    """One mesh in Blender axes (Z up, front towards -Y), one material slot per colour."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.materials = []

    def slot(self, mat):
        if mat not in self.materials:
            self.materials.append(mat)
        return self.materials.index(mat)

    def _merge(self, piece, mat, matrix):
        bmesh.ops.transform(piece, matrix=matrix, verts=piece.verts)
        index = self.slot(mat)
        for face in piece.faces:
            face.material_index = index
            face.smooth = True
        mesh = bpy.data.meshes.new("farm-piece")
        piece.to_mesh(mesh)
        piece.free()
        self.bm.from_mesh(mesh)
        bpy.data.meshes.remove(mesh)

    def box(self, mat, size, center, radius=0.05, segments=3, rotation=None):
        """A box of ``size`` (x, y, z) whose edges are rounded by ``radius``."""
        piece = bmesh.new()
        bmesh.ops.create_cube(piece, size=1.0)
        bmesh.ops.scale(piece, vec=Vector(size), verts=piece.verts)
        if radius > 0:
            bmesh.ops.bevel(piece, geom=list(piece.edges) + list(piece.verts), offset=min(radius, min(size) * 0.49),
                            segments=segments, affect="EDGES", profile=0.5)
        matrix = Matrix.Translation(Vector(center)) @ (rotation or Matrix.Identity(4))
        self._merge(piece, mat, matrix)

    def lathe(self, mat, profile, center=(0, 0, 0), rotation=None, segments=SEGMENTS):
        """Revolve ``profile`` [(radius, height), ...], bottom to top, about local Z."""
        piece = bmesh.new()
        rings = []
        for r, z in profile:
            if r <= 1e-9:
                rings.append([piece.verts.new((0, 0, z))])
            else:
                rings.append([piece.verts.new((r * math.cos(2 * math.pi * i / segments), r * math.sin(2 * math.pi * i / segments), z))
                              for i in range(segments)])
        for a, b in zip(rings, rings[1:]):
            for i in range(segments):
                j = (i + 1) % segments
                if len(a) == 1 and len(b) == 1:
                    continue
                if len(a) == 1:
                    piece.faces.new((a[0], b[j], b[i]))
                elif len(b) == 1:
                    piece.faces.new((a[i], a[j], b[0]))
                else:
                    piece.faces.new((a[i], a[j], b[j], b[i]))
        matrix = Matrix.Translation(Vector(center)) @ (rotation or Matrix.Identity(4))
        self._merge(piece, mat, matrix)

    def finish(self, collection, parent):
        mesh = bpy.data.meshes.new(self.name)
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for name in self.materials:
            mesh.materials.append(material(name))
        mesh.set_sharp_from_angle(angle=SHARP_ANGLE)
        obj = bpy.data.objects.new(self.name, mesh)
        collection.objects.link(obj)
        obj.parent = parent
        return obj


def arc(cx, cz, r, a0, a1, steps):
    """Points of a profile arc around (cx, cz), angles in degrees."""
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * k / steps)), cz + r * math.sin(math.radians(a0 + (a1 - a0) * k / steps)))
            for k in range(steps + 1)]


def rounded_disc(radius, z0, z1, fillet):
    """A closed lathe profile for a disc/cylinder from z0 to z1 with rounded rims."""
    return ([(0, z0)] + arc(radius - fillet, z0 + fillet, fillet, -90, 0, 3)
            + arc(radius - fillet, z1 - fillet, fillet, 0, 90, 3) + [(0, z1)])


def ring(radius, thickness, z, height):
    """A rounded hoop that sits proud of a cylinder of ``radius``."""
    r0, r1, f = radius - 0.02, radius + thickness, min(thickness, height / 2) * 0.9
    return ([(r0, z)] + arc(r1 - f, z + f, f, -90, 0, 3) + arc(r1 - f, z + height - f, f, 0, 90, 3) + [(r0, z + height)])


ROT_X = Matrix.Rotation(math.pi / 2, 4, "X")
ROT_Y = Matrix.Rotation(math.pi / 2, 4, "Y")


# ---------------------------------------------------------------- farmhouse

HOUSE = {"width": 1.7, "depth": 1.8, "plinth": 0.16, "wall": 1.0, "roofRise": 0.78, "overhang": 0.18, "roofThickness": 0.15}


def window(b, center, facing, size=(0.34, 0.36)):
    """A white-framed window with a cross mullion and a sill on a wall facing ``facing`` (-y, +y, +x, -x)."""
    w, h = size
    x, y, z = center
    s = 1 if facing[0] == "+" else -1
    for mat, out, (along, thick, up), radius, segments, dz in (
        ("white", 0.01, (w + 0.1, 0.08, h + 0.1), 0.03, 3, 0),
        ("glass", 0.04, (w - 0.02, 0.06, h - 0.02), 0.015, 2, 0),
        ("white", 0.065, (0.04, 0.05, h), 0.012, 1, 0),
        ("white", 0.065, (w, 0.05, 0.04), 0.012, 1, 0),
        ("white", 0.05, (w + 0.16, 0.12, 0.06), 0.025, 3, -h / 2 - 0.06),
    ):
        if facing[1] == "y":
            b.box(mat, (along, thick, up), (x, y + s * out, z + dz), radius, segments)
        else:
            b.box(mat, (thick, along, up), (x + s * out, y, z + dz), radius, segments)


def slab_center(apex, s, slope, half, t, y=0.0, out=0.0):
    """Centre of a roof slab of slope length ``half`` hanging from ``apex`` towards ``s`` * X."""
    offset = Vector((s * half / 2, 0, t / 2 + out))
    offset.rotate(Matrix.Rotation(s * slope, 4, "Y"))
    return tuple(Vector((0, y, apex)) + offset - Vector((0, 0, t * 0.6)))


def build_farmhouse(part, col, root):
    """Front gable towards -Y (glTF +Z) and the ridge front to back, so the elevated camera sees the
    door, the gable and one long side under the roof."""
    h = HOUSE
    w, d, p, wall = h["width"], h["depth"], h["plinth"], h["wall"]
    b = Builder(f"farm.{part}.mesh")
    b.box("stone", (w + 0.24, d + 0.24, p), (0, 0, p / 2), 0.06)
    top = p + wall
    b.box("red", (w, d, wall), (0, 0, p + wall / 2), 0.07)
    rise = h["roofRise"]
    # red gable prism under the roof: its triangles face -Y and +Y
    gable = bmesh.new()
    near = [gable.verts.new(v) for v in ((-w / 2 + 0.03, -d / 2 + 0.03, 0), (w / 2 - 0.03, -d / 2 + 0.03, 0), (0, -d / 2 + 0.03, rise - 0.06))]
    far = [gable.verts.new((v.co.x, d / 2 - 0.03, v.co.z)) for v in near]
    gable.faces.new(near)
    gable.faces.new(far[::-1])
    for i in range(3):
        j = (i + 1) % 3
        gable.faces.new((near[j], near[i], far[i], far[j]))
    bmesh.ops.recalc_face_normals(gable, faces=gable.faces)
    bmesh.ops.bevel(gable, geom=list(gable.edges) + list(gable.verts), offset=0.03, segments=2, affect="EDGES", profile=0.5)
    b._merge(gable, "red", Matrix.Translation((0, 0, top - 0.02)))
    # white corner posts and eave trims along the long sides
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.box("white", (0.15, 0.15, wall + 0.04), (sx * (w / 2 - 0.02), sy * (d / 2 - 0.02), p + wall / 2), 0.05)
        b.box("white", (0.1, d + 0.08, 0.1), (sx * (w / 2 - 0.01), 0, top - 0.04), 0.04)
    # roof: two chunky slabs meeting at a rounded ridge along Y, white bargeboards on the front rake
    slope = math.atan2(rise, w / 2)
    half = (w / 2 + h["overhang"]) / math.cos(slope)
    t = h["roofThickness"]
    length = d + 2 * h["overhang"] + 0.1
    apex = top + rise - 0.02
    for s in (-1, 1):
        rotation = Matrix.Rotation(s * slope, 4, "Y")
        b.box("roof", (half, length, t), slab_center(apex, s, slope, half, t), 0.06, 3, rotation)
        b.box("white", (half + 0.02, 0.07, t + 0.06), slab_center(apex, s, slope, half, t, -length / 2 + 0.02, 0.01), 0.03, 2, rotation)
    b.lathe("roof", rounded_disc(0.1, -length / 2 - 0.02, length / 2 + 0.02, 0.05), (0, 0, apex), ROT_X, 16)
    # chimney through the back half of the +X slope
    cx, cy = w / 4, d / 4
    cz = top + rise * (1 - cx / (w / 2))
    b.box("white", (0.26, 0.26, 0.7), (cx, cy, cz + 0.2), 0.06)
    b.box("white", (0.34, 0.34, 0.1), (cx, cy, cz + 0.56), 0.04)
    b.box("dark", (0.17, 0.17, 0.04), (cx, cy, cz + 0.615), 0.015, 1)
    # front (-Y): door with a frame, a step, a window each side and a round attic window
    fy = -d / 2
    b.box("white", (0.5, 0.08, 0.74), (0, fy - 0.01, p + 0.37), 0.04)
    b.box("door", (0.38, 0.08, 0.66), (0, fy - 0.035, p + 0.34), 0.04)
    b.box("white", (0.3, 0.06, 0.05), (0, fy - 0.07, p + 0.44), 0.02, 1)
    b.lathe("white", rounded_disc(0.035, 0, 0.04, 0.015), (0.12, fy - 0.08, p + 0.3), ROT_X, 12)
    b.box("stone", (0.66, 0.28, 0.1), (0, fy - 0.2, 0.05), 0.04)
    for x in (-0.53, 0.53):
        window(b, (x, fy, p + 0.56), "-y", (0.26, 0.34))
    b.lathe("white", rounded_disc(0.17, 0.0, 0.07, 0.03), (0, fy + 0.04, top + 0.27), ROT_X, 24)
    b.lathe("glass", rounded_disc(0.12, 0.0, 0.1, 0.02), (0, fy + 0.04, top + 0.27), ROT_X, 24)
    # long sides: two windows each; back: one
    for sx, facing in ((1, "+x"), (-1, "-x")):
        for y in (-0.42, 0.42):
            window(b, (sx * w / 2, y, p + 0.56), facing)
    window(b, (0, d / 2, p + 0.56), "+y")
    b.finish(col, root)
    return {"structure": {"kind": "farmhouse", "wall": [w, d, wall], "eaves": round(top, 6), "ridge": round(top + rise + 0.08, 6)}}


# ---------------------------------------------------------------- silo

SILO = {"radius": 0.74, "base": 0.18, "body": 1.66, "dome": 0.66}


def build_silo(part, col, root):
    s = SILO
    r, base, body = s["radius"], s["base"], s["body"]
    b = Builder(f"farm.{part}.mesh")
    b.lathe("stone", rounded_disc(r + 0.14, 0, base, 0.06))
    top = base + body
    b.lathe("cream", [(0, base - 0.01), (r, base - 0.01), (r, top), (0, top)])
    for z in (base + 0.32, base + 0.82, base + 1.32):
        b.lathe("hoop", ring(r, 0.045, z, 0.09))
    b.lathe("hoop", ring(r, 0.07, top - 0.1, 0.14))
    # dome: a flattened hemisphere with a red cap and a little vent ball
    dome = s["dome"]
    profile = [(r + 0.04, top - 0.02)] + [((r + 0.04) * math.cos(math.radians(a)), top + dome * math.sin(math.radians(a))) for a in range(10, 91, 10)]
    profile[-1] = (0, top + dome)
    b.lathe("dome", profile)
    b.lathe("red", rounded_disc(0.17, top + dome - 0.06, top + dome + 0.06, 0.05))
    b.lathe("red", [(0, top + dome + 0.04)] + arc(0, top + dome + 0.14, 0.1, -90, 90, 6)[1:-1] + [(0, top + dome + 0.24)], segments=16)
    # front (-Y) hatch, ladder up the +X side of the front
    b.box("white", (0.42, 0.12, 0.6), (0, -r + 0.02, base + 0.36), 0.05)
    b.box("red", (0.32, 0.12, 0.5), (0, -r - 0.01, base + 0.36), 0.05)
    b.box("white", (0.36, 0.06, 0.05), (0, -r - 0.07, base + 0.36), 0.02, 1)
    angle = math.radians(-50)
    lx, ly = (r + 0.1) * math.cos(angle), (r + 0.1) * math.sin(angle)
    rotation = Matrix.Rotation(angle + math.pi / 2, 4, "Z")
    for side in (-0.11, 0.11):
        offset = Vector((side, 0, 0))
        offset.rotate(rotation)
        b.lathe("dark", rounded_disc(0.025, 0, top - base + 0.06, 0.02), (lx + offset.x, ly + offset.y, base + 0.1), None, 8)
    for k in range(9):
        b.box("dark", (0.24, 0.035, 0.035), (lx, ly, base + 0.3 + k * 0.17), 0.012, 1, rotation)
    b.finish(col, root)
    return {"structure": {"kind": "silo", "radius": r, "bodyTop": round(top, 6), "domeTop": round(top + dome, 6)}}


BUILDERS = {"farmhouse": build_farmhouse, "silo": build_silo}


def build(part, collection, location=(0, 0, 0)):
    """Build one structure under an empty root ``farm.<part>`` at ``location`` (glTF axes)."""
    if part not in BUILDERS:
        raise ValueError(f"farm structure part must be one of {', '.join(PARTS)}")
    root = bpy.data.objects.new(f"farm.{part}", None)
    root.empty_display_size = 0.3
    collection.objects.link(root)
    info = BUILDERS[part](part, collection, root)
    x, y, z = location
    root.location = Vector((x, -z, y))
    return root, info


def generate(output_path, arguments, inputs):
    if not isinstance(arguments, dict) or set(arguments) != {"schemaVersion", "part"} or arguments["schemaVersion"] != 1:
        raise ValueError("farm structure arguments must be exactly {schemaVersion: 1, part}")
    if inputs:
        raise ValueError("farm structure recipe does not accept extra resources")
    part = arguments["part"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    root, info = build(part, bpy.context.scene.collection)
    objects = [root] + list(root.children_recursive)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    triangles = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects if o.type == "MESH")
    bpy.context.view_layer.update()
    points = [o.matrix_world @ v.co for o in objects if o.type == "MESH" for v in o.data.vertices]
    gltf = [(p.x, p.z, -p.y) for p in points]
    bounds = {"min": [round(min(p[i] for p in gltf), 6) for i in range(3)], "max": [round(max(p[i] for p in gltf), 6) for i in range(3)]}
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_vertex_color="NONE", export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    width, depth = FOOTPRINT[part]
    return {"recipe": "farm-structures-v1", "part": part, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "footprint-ground-center", "facing": "+Z", "triangleCount": triangles, "bounds": bounds,
            "gameplayFootprint": {"width": width, "depth": depth}, "maxVisualScale": MAX_SCALE, **info}
