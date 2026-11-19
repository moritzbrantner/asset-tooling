"""Review renders of #775's effects (#772's conventions): each effect at a few moments of its clip, at the mmorpg game
camera (0.42 rad pitch from 12 m), beside the published Ranger for scale, rendered with EEVEE.

    blender -b --factory-startup -P effects.py -- <adapters/blender> <ranger.gltf> <out dir>

Writes <effect>-<frame>.png (the clips run at 100 fps).
"""
import math
import os
import sys

import bpy
from mathutils import Vector

adapters, figure, out = sys.argv[sys.argv.index("--") + 1:][:3]
SHOTS = {"spell_effects.py": {"flask-splash": [0, 40, 80], "chemical-ignite": [0, 25, 55]},
         "strike_effects.py": {"bomb-blast": [5, 15, 30, 50, 70], "trap-snap": [3, 8, 15, 22]}}

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
scene.render.resolution_x, scene.render.resolution_y = 520, 400
scene.render.image_settings.file_format = "PNG"
world = bpy.data.worlds.new("world")
world.use_nodes = True
next(n for n in world.node_tree.nodes if n.type == "BACKGROUND").inputs[0].default_value = (.25, .27, .3, 1)
scene.world = world
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3.0
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
scene.collection.objects.link(sun)
ground = bpy.data.objects.new("ground", bpy.data.meshes.new("ground"))
ground.data.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
gm = bpy.data.materials.new("ground")
gm.use_nodes = True
next(n for n in gm.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (.2, .18, .14, 1)
ground.data.materials.append(gm)
scene.collection.objects.link(ground)
before = set(scene.objects)
bpy.ops.import_scene.gltf(filepath=figure, bone_heuristic="BLENDER", guess_original_bind_pose=False)
for o in scene.objects:
    if o not in before and o.parent is None:
        o.location = (1.6, 0.4, 0)
camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
scene.collection.objects.link(camera)
scene.camera = camera
pitch, centre = .42, Vector((.6, 0, .6))
d = Vector((math.sin(math.radians(-30)) * math.cos(pitch), -math.cos(math.radians(-30)) * math.cos(pitch), math.sin(pitch)))
camera.location = centre + d * 12
camera.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
camera.data.sensor_fit = "VERTICAL"
camera.data.angle_y = 2 * math.atan(4.4 / 2 / 12)
os.makedirs(out, exist_ok=True)
for script, entries in SHOTS.items():
    recipe = {"__name__": script}
    path = os.path.join(adapters, script)
    exec(compile(open(path).read(), path, "exec"), recipe)
    for entry, frames in entries.items():
        col = bpy.data.collections.new(entry)
        scene.collection.children.link(col)
        root, _ = recipe["build"](entry, col)
        scene.render.fps = recipe["CLIP_FPS"]
        for frame in frames:
            scene.frame_set(frame)
            scene.render.filepath = os.path.join(out, f"{entry}-{frame:03d}.png")
            bpy.ops.render.render(write_still=True)
        for o in list(col.objects):
            bpy.data.objects.remove(o)
        bpy.data.collections.remove(col)
