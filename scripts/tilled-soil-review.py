"""Inspect actual PBR review quads under identical native camera and lighting.

Run through pinned Blender; outputs stay in the declared disposable example directory.
"""
from pathlib import Path

import bpy
from mathutils import Vector

root = Path(__file__).resolve().parent.parent / ".artifacts" / "tilled-soil"
names = ("soil-tilled-shallow", "soil-tilled-deep", "soil-tilled-crosswise")
for name in names:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(root / f"{name}.glb"))
    # Two UV repeats expose the periodic tile boundaries in the material.
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            for uv in obj.data.uv_layers.active.data:
                uv.uv *= 2
    bpy.ops.object.camera_add(location=(3, -5, 5))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 3.1
    bpy.context.scene.camera = camera
    bpy.ops.object.light_add(type="AREA", location=(-3, -4, 6))
    bpy.context.object.data.energy = 1000
    bpy.context.object.data.size = 3
    scene = bpy.context.scene
    scene.world.color = (0.2, 0.2, 0.2)
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 32
    scene.cycles.seed = 0
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(root / f"{name}-preview.png")
    bpy.ops.render.render(write_still=True)
print(root)
