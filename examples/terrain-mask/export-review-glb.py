"""Example-only native OBJ to neutral GLB handoff for the existing review renderer."""
from pathlib import Path


def generate(output_path, arguments, inputs):
    if arguments != {} or set(inputs) != {"source"}:
        raise ValueError("terrain review export requires only a declared OBJ source")
    source = Path(inputs["source"])
    if source.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("terrain review OBJ exceeds 8 MiB")
    # This example's canonical generator emits vertices/faces only. Do not let the native
    # importer discover an undeclared material file or another external resource.
    for line in source.read_text("utf8").splitlines():
        if line.strip() and not line.startswith(("#", "v ", "f ")):
            raise ValueError("terrain review OBJ must contain only vertices and faces")
    import bpy
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.wm.obj_import(filepath=str(source), forward_axis="NEGATIVE_Z", up_axis="Y")
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if len(meshes) != 1 or len(meshes[0].data.vertices) > 65536:
        raise ValueError("terrain review needs one bounded mesh")
    material = bpy.data.materials.new("neutral-terrain-review")
    material.diffuse_color = (0.32, 0.37, 0.29, 1)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = material.diffuse_color
    shader.inputs["Roughness"].default_value = 0.9
    meshes[0].data.materials.append(material)
    bpy.ops.export_scene.gltf(filepath=output_path, export_format="GLB", export_yup=True,
                              export_animations=False, export_cameras=False, export_lights=False)
    return {"authoring": "blender-native-obj-import-glb-export", "purpose": "neutral review derivative",
            "vertices": len(meshes[0].data.vertices), "polygons": len(meshes[0].data.polygons)}
