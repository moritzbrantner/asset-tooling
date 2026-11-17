"""Before/after review renders of the #737 reference attacks (docs/combat-animation-standard.md).

    blender -b --factory-startup -P review/combat-standard/render.py -- <config.json>

The config names a texture-free Ranger GLB with its clips (``glb``), its ``humanoid-sockets`` descriptor (``sockets``),
the decoded equipment GLBs (``items``: item id -> path), the output folder (``out``) and per clip its weapon and the
seconds to show as stills (``clips``: [{"name", "weapon", "stills"}]). Every clip renders with Workbench at the mmorpg
game camera's angle (0.42 rad pitch from 12 m, zoomed onto the figure): its stills from the side, three-quarter front
and behind (``<clip>-<view>-<k>.png``, 400x300) and every frame from three-quarter front for the clip video
(``<clip>-video-<frame>.png``, 320x480). An upper-body clip is layered over the first ``Idle_Loop`` pose, as the game
plays it; the items ride their sockets.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
SOCKET_OF = {"sword": ("equipment.sword.arming", "weapon"), "maul": ("equipment.warhammer.maul", "weapon"), "spear": ("equipment.spear.leaf", "staff")}
SOCKET_IDS = {"weapon": "hand_r.weapon", "offhand": "hand_l.weapon", "shield": "hand_l.shield", "staff": "hand_r.staff", "staffLeft": "hand_l.staff",
              "bow": "hand_l.bow"}
VIEWS = {"side": -90, "34": -45, "behind": 180}


def main(config):
    recipe = {"__name__": "strike_clips"}
    path = os.path.join(HERE, "..", "..", "adapters", "blender", "strike_clips.py")
    exec(compile(open(path).read(), path, "exec"), recipe)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = 30, 1
    bpy.ops.import_scene.gltf(filepath=config["glb"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
    rig = next(o for o in scene.objects if o.type == "ARMATURE")
    descriptor = {s["id"]: s for s in json.load(open(config["sockets"]))["sockets"]}
    sockets = {name: {k: descriptor[i][k] for k in ("joint", "translation", "rotation")} for name, i in SOCKET_IDS.items()}
    R = recipe["Rig"](rig, sockets, recipe["gltf_rest_worlds"](config["glb"]))
    items = {}
    for item, file in config["items"].items():
        before = set(scene.objects)
        bpy.ops.import_scene.gltf(filepath=file)
        mesh = next(o for o in scene.objects if o not in before and o.type == "MESH")
        items[item] = (mesh, mesh.matrix_world.copy())
    C4i = recipe["C4"].inverted()

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
    scene.render.image_settings.file_format = "PNG"
    ground = bpy.data.objects.new("ground", bpy.data.meshes.new("ground"))
    ground.data.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
    ground_material = bpy.data.materials.new("ground")
    ground_material.diffuse_color = (.45, .43, .38, 1)
    ground.data.materials.append(ground_material)
    scene.collection.objects.link(ground)

    def view(name, height):
        a, pitch = math.radians(VIEWS[name]), .42
        d = Vector((math.sin(a) * math.cos(pitch), -math.cos(a) * math.cos(pitch), math.sin(pitch)))
        camera.location = Vector((0, -.35, .95)) + d * 12
        camera.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        camera.data.angle_y = 2 * math.atan(height / 2 / 12)

    idle = recipe["sample"](R, bpy.data.actions["Idle_Loop"], 0.0)
    for clip in config["clips"]:
        action = bpy.data.actions[clip["name"]]
        item, socket = SOCKET_OF[clip["weapon"]]
        shown = [(item, socket)] + ([("equipment.shield.heater", "shield")] if clip["weapon"] == "sword" else [])
        for name, (mesh, _) in items.items():
            mesh.hide_render = name not in [s[0] for s in shown]

        def pose(seconds):
            R.apply(idle)
            rig.animation_data.action = action
            frame = action.frame_range[0] + seconds * 30
            scene.frame_set(int(math.floor(frame)), subframe=frame - math.floor(frame))
            for name, socket_name in shown:
                mesh, rest = items[name]
                mesh.matrix_world = rig.matrix_world @ R.grip(socket_name) @ C4i @ rest

        def shot(path):
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)

        count = int(round((action.frame_range[1] - action.frame_range[0])))
        scene.render.resolution_x, scene.render.resolution_y = 400, 300
        for name in VIEWS:
            view(name, 2.5)
            for k, seconds in enumerate(clip["stills"]):
                pose(seconds)
                shot(os.path.join(config["out"], f"{clip['name']}-{name}-{k}.png"))
        scene.render.resolution_x, scene.render.resolution_y = 320, 480
        view("34", 2.9)
        for frame in range(count + 1):
            pose(frame / 30)
            shot(os.path.join(config["out"], f"{clip['name']}-video-{frame:03d}.png"))


main(json.load(open(sys.argv[sys.argv.index("--") + 1])))
