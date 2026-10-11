"""Presentation-only OBJ to GLB conversion for the static asset gallery.

This does not change the canonical OBJ recipe or establish a consumer processing profile.
"""
import sys

import bpy


arguments = sys.argv[sys.argv.index("--") + 1:]
if len(arguments) != 2:
    raise SystemExit("usage: blender --background --python blender-preview-obj.py -- input.obj output.glb")

source, destination = arguments
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.wm.obj_import(filepath=source, forward_axis="NEGATIVE_Z", up_axis="Y")

material = bpy.data.materials.new(name="gallery-neutral-preview")
material.diffuse_color = (0.55, 0.65, 0.72, 1.0)
material.use_nodes = True
shader = material.node_tree.nodes.get("Principled BSDF")
if shader:
    shader.inputs["Base Color"].default_value = material.diffuse_color
    shader.inputs["Roughness"].default_value = 0.8

for obj in bpy.context.scene.objects:
    if obj.type != "MESH":
        continue
    # The published character OBJ uses millimetres; the gallery model uses metres.
    obj.scale = (0.001, 0.001, 0.001)
    obj.data.materials.clear()
    obj.data.materials.append(material)

bpy.ops.export_scene.gltf(filepath=destination, export_format="GLB", use_selection=False)
