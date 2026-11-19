"""Close-up of #775's devices in all their states, built by adapters/blender/held_items.py's own ``generate``: the flasks
and bombs upright, the traps set down on their ``ground`` frame, rendered with Workbench from a three-quarter view.

    blender -b --factory-startup -P props.py -- <adapters/blender/held_items.py> <work dir> <out.png>
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

recipe_path, work, out = sys.argv[sys.argv.index("--") + 1:][:3]
recipe = {"__name__": "held"}
exec(compile(open(recipe_path).read(), recipe_path, "exec"), recipe)
# Item, where its ground point goes (Blender axes) and whether it stands on its ground frame (the traps).
LAYOUT = [("tinker.flask", (-.45, .3), False), ("tinker.flask.thrown", (-.3, .3), False), ("tinker.bomb", (-.12, .3), False),
          ("tinker.bomb.lit", (.06, .3), False), ("tinker.trap", (-.45, -.15), True), ("tinker.trap.armed", (-.05, -.15), True),
          ("tinker.trap.triggered", (.4, -.15), True)]
placed = []
for item, (x, y), on_ground in LAYOUT:
    path = os.path.join(work, item + ".glb")
    frames = recipe["generate"](path, {"schemaVersion": 1, "item": item}, {})["frames"]
    placed.append((path, x, y, frames.get("ground") if on_ground else None))
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
for path, x, y, ground in placed:
    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    mesh = next(o for o in scene.objects if o not in before and o.type == "MESH")
    if ground:
        r = ground["rotation"]
        frame = Matrix.LocRotScale(Vector(ground["translation"]), Quaternion((r[3], r[0], r[1], r[2])), Vector((1, 1, 1)))
        mesh.matrix_world = Matrix.Translation((x, y, 0)) @ C4 @ frame.inverted() @ C4.inverted() @ mesh.matrix_world
    else:
        low = min((mesh.matrix_world @ v.co).z for v in mesh.data.vertices)
        mesh.matrix_world = Matrix.Translation((x, y, -low)) @ mesh.matrix_world
ground_plane = bpy.data.objects.new("ground", bpy.data.meshes.new("ground"))
ground_plane.data.from_pydata([(-5, -5, 0), (5, -5, 0), (5, 5, 0), (-5, 5, 0)], [], [(0, 1, 2, 3)])
scene.collection.objects.link(ground_plane)
camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
scene.collection.objects.link(camera)
scene.camera = camera
d = Vector((.55, -1, .75)).normalized()
camera.location = Vector((0, .05, .05)) + d * 2.2
camera.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
camera.data.lens = 50
scene.render.engine = "BLENDER_WORKBENCH"
shading = scene.display.shading
shading.light, shading.color_type, shading.show_shadows, shading.show_cavity = "STUDIO", "MATERIAL", True, True
scene.render.resolution_x, scene.render.resolution_y = 1200, 800
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
