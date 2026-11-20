"""Render stills of wildlife GLBs at the Greyhaven game camera's angle (12 m, 0.42 rad pitch), zoomed onto the animal,
in EEVEE under a sun and a grey sky so the textured, nonmetallic materials show as a game renderer would light them
(#782; the #778 sheets used Workbench, which shows flat colours only):
blender -b --factory-startup -P render.py -- <shots.json> <out_dir>

shots.json: [{"glb": path, "clip": name, "frame": n, "yaw": degrees (90 = side), "forward": metres the root has
travelled (the consumer's root motion added back), "name": file stem, "pitch": optional radians, "span": optional
metres of view height, "center": optional [x, y, z]}]. Several GLBs may share one shot ("glb" a list) for a size line-up,
each with its own "offset" [x, y]."""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

shots_path, out = sys.argv[sys.argv.index("--") + 1:][:2]
shots = json.load(open(shots_path))
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24
for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        pass
scene.view_settings.view_transform = "Standard"
world = bpy.data.worlds.new("world")
world.use_nodes = True
next(n for n in world.node_tree.nodes if n.type == "BACKGROUND").inputs["Color"].default_value = (.32, .36, .42, 1)
next(n for n in world.node_tree.nodes if n.type == "BACKGROUND").inputs["Strength"].default_value = 0.9
scene.world = world
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3.2
sun.rotation_euler = (math.radians(45), 0, math.radians(30))
scene.collection.objects.link(sun)
ground = bpy.data.objects.new("ground", bpy.data.meshes.new("ground"))
ground.data.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
gm = bpy.data.materials.new("ground")
gm.use_nodes = True
next(n for n in gm.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (.22, .26, .14, 1)
ground.data.materials.append(gm)
scene.collection.objects.link(ground)
camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
scene.collection.objects.link(camera)
scene.camera = camera
camera.data.sensor_fit = "VERTICAL"
scene.render.resolution_x, scene.render.resolution_y = 360, 300
loaded = {}


def load(glb):
    if glb not in loaded:
        before, before_actions = set(bpy.data.objects), set(bpy.data.actions)
        bpy.ops.import_scene.gltf(filepath=glb)
        objs = [o for o in bpy.data.objects if o not in before]
        root = next(o for o in objs if o.parent is None)
        rig = next(o for o in objs if o.type == "ARMATURE")
        rig.animation_data_create()
        actions = {a.name.split(".")[0]: a for a in bpy.data.actions if a not in before_actions}
        loaded[glb] = (root, rig, objs, actions)
    return loaded[glb]


for shot in shots:
    glbs = shot["glb"] if isinstance(shot["glb"], list) else [shot["glb"]]
    offsets = shot.get("offset", [[0, 0]] * len(glbs))
    clips = shot["clip"] if isinstance(shot["clip"], list) else [shot["clip"]] * len(glbs)
    for glb in loaded:
        for o in loaded[glb][2]:
            o.hide_render = True
    for glb, offset, clip in zip(glbs, offsets, clips):
        root, rig, objs, actions = load(glb)
        for o in objs:
            o.hide_render = False
        action = actions[clip]
        rig.animation_data.action = action
        if hasattr(rig.animation_data, "action_slot") and action.slots:
            rig.animation_data.action_slot = action.slots[0]
        # glTF +Z (the animal's forward) imports as Blender -Y.
        root.location = Vector((offset[0], offset[1] - shot.get("forward", 0.0), 0))
    scene.frame_set(int(shot["frame"]))
    bpy.context.view_layer.update()
    a, p = math.radians(shot.get("yaw", 90)), shot.get("pitch", .42)
    d = Vector((math.cos(a) * math.cos(p), -math.sin(a) * math.cos(p), math.sin(p)))
    center = Vector(shot.get("center", (0, -shot.get("forward", 0.0), .3)))
    camera.location = center + d * 12
    camera.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    camera.data.angle_y = 2 * math.atan(shot.get("span", 1.6) / 2 / 12)
    scene.render.filepath = os.path.join(out, f"{shot['name']}.png")
    bpy.ops.render.render(write_still=True)
