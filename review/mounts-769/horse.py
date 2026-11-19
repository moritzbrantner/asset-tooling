"""Renders the riding horse's clips (Workbench, headless Blender 5.2.2) and tiles them per clip:

    blender -b --factory-startup -P horse.py -- <horse.glb> <out dir> [view] [clip=frames,...]

``view`` is ``side`` (a long lens from the horse's left), ``tall`` (the same, framed for the rear) or ``game`` (the mmorpg game camera: 0.42 rad
pitch from 12 m, three-quarter front). Each still is ``<clip>-<view>-<frame>.png``.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
glb, out = args[0], args[1]
view = args[2] if len(args) > 2 else "side"
wanted = dict(a.split("=") for a in args[3:])
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30
bpy.ops.import_scene.gltf(filepath=glb)
arm = next(o for o in scene.objects if o.type == "ARMATURE")
for o in list(scene.objects):
    if o.name.startswith("Icosphere"):
        bpy.data.objects.remove(o)
ground = bpy.data.objects.new("ground", bpy.data.meshes.new("ground"))
ground.data.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
gm = bpy.data.materials.new("ground")
gm.diffuse_color = (.45, .43, .38, 1)
ground.data.materials.append(gm)
scene.collection.objects.link(ground)
# Ground marks every 0.25 m so a planted hoof's slide shows.
for k in range(-12, 13):
    mark = bpy.data.objects.new(f"mark{k}", bpy.data.meshes.new("mark"))
    y = k * .25
    mark.data.from_pydata([(.6, y - .01, .001), (.9, y - .01, .001), (.9, y + .01, .001), (.6, y + .01, .001)], [], [(0, 1, 2, 3)])
    mm = bpy.data.materials.new("mark")
    mm.diffuse_color = (.2, .2, .2, 1)
    mark.data.materials.append(mm)
    scene.collection.objects.link(mark)
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
scene.render.resolution_x, scene.render.resolution_y = (520, 360) if view == "side" else (400, 400)
if view in ("side", "tall"):
    d = Vector((1, 0, .08)).normalized()
    centre, height = (Vector((0, .2, 1.4)), 3.4) if view == "tall" else (Vector((0, 0, 1.0)), 2.6)
else:
    a, pitch = math.radians(-45), .42
    d = Vector((math.sin(a) * math.cos(pitch), -math.cos(a) * math.cos(pitch), math.sin(pitch)))
    centre, height = Vector((0, 0, 1.0)), 3.0
camera.location = centre + d * 12
camera.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
camera.data.angle_y = 2 * math.atan(height / 2 / 12)
os.makedirs(out, exist_ok=True)
for action in bpy.data.actions:
    if wanted and action.name not in wanted:
        continue
    arm.animation_data.action = action
    slots = arm.animation_data.action_suitable_slots
    if slots:
        arm.animation_data.action_slot = slots[0]
    last = int(round(action.frame_range[1]))
    frames = [int(f) for f in wanted[action.name].split(",")] if wanted.get(action.name) else [round(last * k / 7) for k in range(8)]
    for f in frames:
        scene.frame_set(f)
        scene.render.filepath = os.path.join(out, f"{action.name}-{view}-{f:03d}.png")
        bpy.ops.render.render(write_still=True)
    print("RENDERED", action.name, last, frames)
