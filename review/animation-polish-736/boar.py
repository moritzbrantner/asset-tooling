"""Render a wildlife GLTF clip at stills: blender -b --factory-startup -P boar.py -- <gltf> <clip> <out_dir> <tag> <frames,...> [pitch]"""
import math
import os
import sys

import bpy
from mathutils import Vector

gltf, clip, out, tag, frames = sys.argv[sys.argv.index("--") + 1:][:5]
pitch = float((sys.argv[sys.argv.index("--") + 1:] + [None] * 6)[5] or .42)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=gltf)
rig = next(o for o in scene.objects if o.type == "ARMATURE")
action = next(a for a in bpy.data.actions if a.name.startswith(clip))
rig.animation_data_create()
rig.animation_data.action = action
if hasattr(rig.animation_data, "action_slot") and action.slots:
    rig.animation_data.action_slot = action.slots[0]
print("RANGE", action.frame_range, scene.render.fps)
camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
scene.collection.objects.link(camera)
scene.camera = camera
camera.data.sensor_fit = "VERTICAL"
scene.render.engine = "BLENDER_WORKBENCH"
shading = scene.display.shading
shading.light, shading.color_type, shading.show_shadows, shading.show_cavity = "STUDIO", "MATERIAL", True, True
world = bpy.data.worlds.new("world")
world.color = (.32, .34, .36)
scene.world = world
ground = bpy.data.objects.new("ground", bpy.data.meshes.new("ground"))
ground.data.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
gm = bpy.data.materials.new("ground")
gm.diffuse_color = (.45, .43, .38, 1)
ground.data.materials.append(gm)
scene.collection.objects.link(ground)
scene.render.resolution_x, scene.render.resolution_y = 360, 300
os.makedirs(out, exist_ok=True)
# glTF +X forward becomes Blender... look from the side, three-quarter front and three-quarter behind.
for name, yaw in (("side", 90), ("34", 45), ("front34", 20), ("low", 60)):
    a = math.radians(yaw)
    p = pitch if name != "low" else .12
    d = Vector((math.cos(a) * math.cos(p), -math.sin(a) * math.cos(p), math.sin(p)))
    for f in frames.split(","):
        scene.frame_set(int(f))
        bpy.context.view_layer.update()
        center = Vector((.2, 0, .45))
        camera.location = center + d * 12
        camera.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        camera.data.angle_y = 2 * math.atan(1.6 / 2 / 12)
        scene.render.filepath = os.path.join(out, f"{tag}-{name}-{int(f):03d}.png")
        bpy.ops.render.render(write_still=True)
