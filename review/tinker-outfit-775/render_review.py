"""Review stills of fitted outfits at the mmorpg game camera's angle (#775):

    blender -b --factory-startup -P render_review.py -- config.json

config: {"out": dir, "res": [w, h], "figures": [{"name", "base": gltf, "hide": [mesh names], "pieces": [gltf], "joints": {node: joint},
"clips": gltf, "x": offset}], "shots": [{"name", "clip", "frame", "yaw" (degrees, 0 = facing the camera), "span" (metres framed),
"centre" (height), "pitch" (radians, default the game camera's 0.42), "figures": [names]}]}.
Each piece glTF is either skinned (re-bound to the figure's rig) or static in the rest model space (parented to its joint).
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

cfg = json.load(open(sys.argv[sys.argv.index("--") + 1]))
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30


def imported(path):
    before = set(bpy.data.objects)
    actions = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path, bone_heuristic="BLENDER", guess_original_bind_pose=False)
    return [o for o in bpy.data.objects if o not in before], [a for a in bpy.data.actions if a not in actions]


figures = {}
for spec in cfg["figures"]:
    objects, _ = imported(spec["base"])
    rig = next(o for o in objects if o.type == "ARMATURE")
    rig.animation_data_create()
    rig.animation_data.action = None
    for o in objects:
        if o.type != "MESH" or o.name.split(".0")[0] in spec.get("hide", []) or o.name.startswith("Icosphere"):
            if o.type != "ARMATURE":
                o.hide_render = True
    for path in spec.get("pieces", []):
        pieces, _ = imported(path)
        for o in pieces:
            name = o.name.split(".0")[0]
            if o.type == "MESH" and name in spec.get("joints", {}):
                mw = o.matrix_world.copy()
                o.parent, o.parent_type, o.parent_bone = rig, "BONE", spec["joints"][name]
                o.matrix_world = mw
            elif o.type == "MESH" and any(m.type == "ARMATURE" for m in o.modifiers):
                mw = o.matrix_world.copy()
                o.parent = rig
                o.matrix_world = mw
                for m in o.modifiers:
                    if m.type == "ARMATURE":
                        m.object = rig
            else:
                o.hide_render = True
    clips, actions = imported(spec["clips"])
    for o in clips:
        bpy.data.objects.remove(o, do_unlink=True)
    rig.location.x = spec.get("x", 0)
    figures[spec["name"]] = (rig, {a.name.split(".0")[0]: a for a in actions})

world = bpy.data.worlds.new("world")
world.use_nodes = True
background = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
background.inputs["Color"].default_value = (.32, .34, .36, 1)
background.inputs["Strength"].default_value = .9
scene.world = world
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3.2
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
scene.collection.objects.link(sun)
ground = bpy.data.objects.new("ground", bpy.data.meshes.new("ground"))
ground.data.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
gm = bpy.data.materials.new("ground")
gm.use_nodes = True
next(n for n in gm.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (.36, .34, .29, 1)
ground.data.materials.append(gm)
scene.collection.objects.link(ground)
camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
scene.collection.objects.link(camera)
scene.camera = camera
camera.data.sensor_fit = "VERTICAL"
engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
scene.render.engine = next(e for e in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT") if e in engines)
scene.render.resolution_x, scene.render.resolution_y = cfg["res"]
scene.render.image_settings.file_format = "PNG"
os.makedirs(cfg["out"], exist_ok=True)

for shot in cfg["shots"]:
    shown = shot.get("figures", list(figures))
    xs = []
    for name, (rig, actions) in figures.items():
        visible = name in shown
        for o in bpy.data.objects:
            if o.parent == rig and o.type == "MESH":
                if "base_hide" not in o:
                    o["base_hide"] = o.hide_render
                o.hide_render = bool(o["base_hide"]) or not visible
        if visible:
            xs.append(rig.location.x)
            action = actions.get(shot["clip"])
            rig.animation_data.action = action
            if action is not None:
                rig.animation_data.action_slot = action.slots[0]
    scene.frame_set(shot.get("frame", 0))
    pitch, yaw = shot.get("pitch", .42), math.radians(shot.get("yaw", 0))
    centre = Vector(((min(xs) + max(xs)) / 2, 0, shot.get("centre", .95)))
    direction = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    camera.location = centre + direction * 12
    camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    camera.data.angle = 2 * math.atan(shot.get("span", 2.4) / 2 / 12)
    scene.render.filepath = os.path.join(cfg["out"], shot["name"] + ".png")
    bpy.ops.render.render(write_still=True)
    print("RENDERED", shot["name"])
