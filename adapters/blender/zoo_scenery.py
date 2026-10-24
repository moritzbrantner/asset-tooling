"""Toy-style, flat-colour Zoo scenery (tree, bush, rock), an original scripted recipe for the pinned Blender script backend.

One run builds one scenery piece (asset-tooling#357, consumer zoo#59 slice S2 / zoo#86). Owner answer of
2026-10-24 on zoo#59: a small flat-colour, toy-style scenery set in the ``farm-structures`` format, loaded
through 3d-lab's untextured ``static-glb`` loader with no 3d-lab change. Zoo scatters these many times
outside the park fence as instance batches, so the meshes stay small.

Frame: metres (one Zoo tile is 1 m), glTF right-handed +Y up, front +Z, origin at the centre of the
footprint on the ground plane (y = 0). Each piece is one mesh node ``zoo.<kind>.<variant>.mesh`` with
plain-colour materials (no textures, no vertex colours). The palette follows Zoo's code-built scenery
(``apps/web/src/park-scene.ts``), a touch brighter for the toy look.

- ``tree`` / ``round``: a tapered brown trunk under a chunky three-ball leaf crown;
- ``tree`` / ``pine``: a short trunk under three stacked rounded cones and a ball tip;
- ``bush`` / ``round``: three overlapping leaf domes with a few red berries;
- ``rock`` / ``round``: a lumpy grey boulder with a small pebble beside it.

Every shape is a lathe of a rounded profile (the rocks with a fixed analytic lumpiness), built directly
into one BMesh, so the face order is fixed and there is no randomness. ``build(kind, variant, collection,
location)`` also works in a live Blender session; ``generate`` is the script-backend entry point.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

PIECES = (("tree", "round"), ("tree", "pine"), ("bush", "round"), ("rock", "round"))
SHARP_ANGLE = math.radians(48)

# name: (sRGB base colour, roughness)
MATERIALS = {
    "trunk": ((0.48, 0.33, 0.21), 0.8),
    "leaf": ((0.33, 0.62, 0.27), 0.7),
    "leaf-light": ((0.42, 0.7, 0.33), 0.7),
    "pine": ((0.18, 0.47, 0.29), 0.7),
    "pine-light": ((0.23, 0.55, 0.36), 0.7),
    "bush": ((0.36, 0.63, 0.28), 0.7),
    "bush-light": ((0.44, 0.7, 0.34), 0.7),
    "berry": ((0.86, 0.2, 0.18), 0.45),
    "rock": ((0.6, 0.6, 0.55), 0.85),
    "rock-light": ((0.69, 0.68, 0.62), 0.85),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(name):
    existing = bpy.data.materials.get(f"zoo-{name}")
    if existing is not None:
        return existing
    colour, roughness = MATERIALS[name]
    mat = bpy.data.materials.new(f"zoo-{name}")
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

    def lathe(self, mat, profile, center=(0, 0, 0), segments=12, scale=(1, 1, 1), lump=None):
        """Revolve ``profile`` [(radius, height), ...], bottom to top, about local Z. ``lump(angle, height)``
        scales the radius of each ring vertex for an irregular, still deterministic outline."""
        piece = bmesh.new()
        rings = []
        for r, z in profile:
            if r <= 1e-9:
                rings.append([piece.verts.new((0, 0, z))])
                continue
            ring = []
            for i in range(segments):
                a = 2 * math.pi * i / segments
                k = lump(a, z) if lump else 1.0
                ring.append(piece.verts.new((r * k * math.cos(a), r * k * math.sin(a), z)))
            rings.append(ring)
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
        matrix = Matrix.Translation(Vector(center)) @ Matrix.Diagonal(Vector(scale)).to_4x4()
        bmesh.ops.transform(piece, matrix=matrix, verts=piece.verts)
        index = self.slot(mat)
        for face in piece.faces:
            face.material_index = index
            face.smooth = True
        mesh = bpy.data.meshes.new("zoo-piece")
        piece.to_mesh(mesh)
        piece.free()
        self.bm.from_mesh(mesh)
        bpy.data.meshes.remove(mesh)

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


def ball(radius, rings=6):
    """A closed sphere profile about its centre."""
    return [(0, -radius)] + arc(0, 0, radius, -90, 90, rings)[1:-1] + [(0, radius)]


def dome(radius, height, rings=4):
    """A flat-bottomed elliptical dome from z = 0 to ``height``."""
    return [(0, 0)] + [(radius * math.cos(math.radians(a)), height * math.sin(math.radians(a))) for a in range(0, 90, 90 // rings)] + [(0, height)]


def cone(radius, z0, height, fillet):
    """A cone with a rounded rim from z0 and a softened tip."""
    rim = arc(radius - fillet, z0 + fillet, fillet, -90, 60, 3)
    return [(0, z0)] + rim + [(radius * 0.08, z0 + height * 0.94), (0, z0 + height)]


def trunk(bottom, top, height):
    """A tapered trunk with a small root flare."""
    return [(0, 0), (bottom * 1.35, 0), (bottom, height * 0.12), (top, height), (0, height)]


# ---------------------------------------------------------------- pieces

def build_tree_round(b):
    b.lathe("trunk", trunk(0.085, 0.06, 0.8), segments=8)
    b.lathe("leaf", ball(0.38), (0, 0, 0.98), segments=12, scale=(1, 1, 0.92))
    b.lathe("leaf", ball(0.25), (-0.2, 0.1, 0.84), segments=10)
    b.lathe("leaf-light", ball(0.25), (0.12, -0.06, 1.26), segments=10)
    return {"trunkHeight": 0.8, "crownRadius": 0.38}


def build_tree_pine(b):
    b.lathe("trunk", trunk(0.07, 0.055, 0.4), segments=8)
    b.lathe("pine", cone(0.42, 0.28, 0.66, 0.08), segments=12)
    b.lathe("pine-light", cone(0.33, 0.68, 0.56, 0.07), segments=12)
    b.lathe("pine", cone(0.24, 1.04, 0.44, 0.06), segments=10)
    b.lathe("pine-light", ball(0.06, 3), (0, 0, 1.45), segments=8)
    return {"trunkHeight": 0.4, "tiers": 3}


def build_bush_round(b):
    b.lathe("bush", dome(0.3, 0.44), (0, 0, 0), segments=12)
    b.lathe("bush-light", dome(0.2, 0.32), (0.24, -0.12, 0), segments=10)
    b.lathe("bush", dome(0.19, 0.28), (-0.22, 0.14, 0), segments=10)
    for x, y, z in ((0.06, -0.27, 0.27), (-0.18, -0.16, 0.3), (0.32, -0.2, 0.2), (0.14, 0.12, 0.42)):
        b.lathe("berry", ball(0.045, 3), (x, y, z), segments=6)
    return {"domes": 3, "berries": 4}


def lumpy(seed):
    """A fixed analytic lumpiness: no randomness, the same outline on every build."""
    return lambda a, z: 1 + 0.1 * math.sin(3 * a + seed) + 0.06 * math.sin(5 * a + 2 * seed + 4 * z)


def build_rock_round(b):
    b.lathe("rock", dome(0.3, 0.32, 5), (-0.04, 0.02, 0), segments=10, scale=(1.05, 0.85, 1), lump=lumpy(0.7))
    b.lathe("rock-light", dome(0.11, 0.12, 3), (0.27, -0.16, 0), segments=8, lump=lumpy(2.1))
    return {"stones": 2}


BUILDERS = {("tree", "round"): build_tree_round, ("tree", "pine"): build_tree_pine,
            ("bush", "round"): build_bush_round, ("rock", "round"): build_rock_round}


def build(kind, variant, collection, location=(0, 0, 0)):
    """Build one piece under an empty root ``zoo.<kind>.<variant>`` at ``location`` (glTF axes)."""
    if (kind, variant) not in BUILDERS:
        raise ValueError(f"zoo scenery piece must be one of {', '.join(f'{k}/{v}' for k, v in PIECES)}")
    root = bpy.data.objects.new(f"zoo.{kind}.{variant}", None)
    root.empty_display_size = 0.2
    collection.objects.link(root)
    b = Builder(f"zoo.{kind}.{variant}.mesh")
    info = BUILDERS[(kind, variant)](b)
    b.finish(collection, root)
    x, y, z = location
    root.location = Vector((x, -z, y))
    return root, info


def generate(output_path, arguments, inputs):
    if not isinstance(arguments, dict) or set(arguments) != {"schemaVersion", "kind", "variant"} or arguments["schemaVersion"] != 1:
        raise ValueError("zoo scenery arguments must be exactly {schemaVersion: 1, kind, variant}")
    if inputs:
        raise ValueError("zoo scenery recipe does not accept extra resources")
    kind, variant = arguments["kind"], arguments["variant"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    root, info = build(kind, variant, bpy.context.scene.collection)
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
    return {"recipe": "zoo-scenery-v1", "kind": kind, "variant": variant, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "footprint-ground-center", "facing": "+Z", "triangleCount": triangles, "bounds": bounds, "piece": info}
