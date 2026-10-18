"""Source-derived level-of-detail meshes with Blender's Decimate modifier (#123, owner answer A, Atlas Decision 5.1.6).

The declared input ``source`` is one self-contained GLB: a placed static kit asset or a composed skinned character
without clips. Every mesh is reduced with an edge-collapse Decimate to ``arguments["ratio"]`` of its triangles.
Coincident vertices are welded first. Collapse then interpolates UVs, normals and vertex-group (skin) weights, and triangulates, so materials, texture seams and
skinning survive. Node names, materials, the armature and the scene structure are kept. Animations are not exported:
the build embeds the character's clips again, so every level plays exactly the same clips.
"""
import bmesh
import bpy


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "ratio"}:
        raise ValueError("lod requires exactly schemaVersion and ratio")
    if p["schemaVersion"] != 1 or type(p["ratio"]) not in (int, float) or not 0.05 <= p["ratio"] < 1:
        raise ValueError("lod ratio must be in 0.05..1")
    if set(inputs) != {"source"}:
        raise ValueError("lod takes exactly the declared input source")


def triangles(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    count = len(bm.faces)
    bm.free()
    return count


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    ratio = float(arguments["ratio"])
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=inputs["source"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    imported = list(bpy.context.scene.objects)
    meshes = sorted((o for o in imported if o.type == "MESH" and not o.name.startswith("Icosphere")), key=lambda o: o.name)
    if not meshes:
        raise ValueError("the source has no meshes")
    levels = []
    for obj in meshes:
        before = triangles(obj)
        # glTF splits vertices at UV and normal seams; weld them first so the collapse sees one connected surface
        # (Blender keeps UVs per face corner, so the seams survive). Without this, collapse shreds seamed meshes.
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        bm.to_mesh(obj.data)
        bm.free()
        modifier = obj.modifiers.new("lod", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        levels.append({"node": obj.name, "trianglesBefore": before, "trianglesAfter": triangles(obj)})
    skinned = any(o.type == "ARMATURE" for o in imported)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in imported:
        if obj.name.startswith("Icosphere"):
            continue
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_animations=False, export_skins=skinned, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "lod-decimate-v1", "ratio": ratio, "skinned": skinned, "meshes": levels,
            "trianglesBefore": sum(level["trianglesBefore"] for level in levels),
            "trianglesAfter": sum(level["trianglesAfter"] for level in levels)}
