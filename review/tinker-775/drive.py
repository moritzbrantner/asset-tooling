"""Dev driver (#775): author the Tinker clips on the published Ranger, skin the published mesh on them, show the devices
in the hand or set on the ground, render stills at the game camera's angle and measure foot slide, the lowest joint and
how deep a device goes into the body (the hands excluded).

    blender -b --factory-startup -P drive.py -- config.json

config: {"recipe", "dl" (the merged figure, merge.py), "out", "clips", "items": {name: glb}, "stills": {clip: [fraction]},
"views", "height", "res", "shown": {clip: [{"item", "from", "to", "at": "hand" | "set"}]}} (seconds; "set" keeps the
item where the hand's weapon socket was at "from").
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

cfg = json.load(open(sys.argv[sys.argv.index("--") + 1]))
DL = cfg["dl"]
recipe = {"__name__": "recipe"}
exec(compile(open(cfg["recipe"]).read(), cfg["recipe"], "exec"), recipe)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps, scene.render.fps_base = 30, 1
before = set(scene.objects)
target = os.path.join(DL, "ranger.gltf")
bpy.ops.import_scene.gltf(filepath=target, bone_heuristic="BLENDER", guess_original_bind_pose=False)
figure = [o for o in scene.objects if o not in before]
rig = next(o for o in figure if o.type == "ARMATURE")
rig.animation_data_create()
rig.animation_data.action = None
descriptor = {s["id"]: s for s in json.load(open(os.path.join(DL, "humanoid.ranger.male.default.humanoid-sockets.json")))["sockets"]}
sockets = {"weapon": {k: descriptor["hand_r.weapon"][k] for k in ("joint", "translation", "rotation")}}
authored = recipe["author_all"](rig, {"schemaVersion": 1, "clips": cfg["clips"], "sockets": sockets}, target)
R = recipe["Rig"](rig, sockets, recipe["gltf_rest_worlds"](target))
C4i = recipe["C4"].inverted()
report = {name: {k: v for k, v in obs.items() if k != "secondaryPose"} for name, (_, obs) in authored.items()}

items = {}
for name, path in cfg.get("items", {}).items():
    seen = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    mesh = next(o for o in scene.objects if o not in seen and o.type == "MESH")
    items[name] = (mesh, mesh.matrix_world.copy())
    mesh.hide_render = True


def apply(pose):
    for name, basis in pose.items():
        rig.pose.bones[name].matrix_basis = basis
    bpy.context.view_layer.update()


HAND = ("hand_", "index_", "middle_", "ring_", "pinky_", "thumb_", "lowerarm_")
body = next(o for o in figure if o.type == "MESH" and any(g.name.startswith("index_01") for g in o.vertex_groups))
hand_groups = {g.index for g in body.vertex_groups if g.name.startswith(HAND)}
hand_verts = {v.index for v in body.data.vertices if any(e.group in hand_groups and e.weight > .3 for e in v.groups)}
keep_polys = [p.index for p in body.data.polygons if not any(i in hand_verts for i in p.vertices)]


def depth(mesh):
    """How far the item's vertices go inside the body (hands and forearms excluded), metres."""
    ev = body.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    verts = [body.matrix_world @ v.co for v in ev.vertices]
    tree = BVHTree.FromPolygons(verts, [tuple(ev.polygons[i].vertices) for i in keep_polys])
    body.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
    worst = 0.0
    for v in mesh.data.vertices:
        p = mesh.matrix_world @ v.co
        hit = tree.find_nearest(p, .2)
        if hit[0] is not None and (p - hit[0]).dot(hit[1]) < 0:
            worst = max(worst, (p - hit[0]).length)
    return worst


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
gm = bpy.data.materials.new("ground")
gm.diffuse_color = (.45, .43, .38, 1)
ground.data.materials.append(gm)
scene.collection.objects.link(ground)
VIEWS = {"side": -90, "34": -45, "front": 0, "behind": 180, "right": 90}


def view(name, height):
    center = cfg.get("center", (0, -.25, .9))
    a, pitch = math.radians(VIEWS[name]), cfg.get("pitch", .42)
    d = Vector((math.sin(a) * math.cos(pitch), -math.cos(a) * math.cos(pitch), math.sin(pitch)))
    camera.location = Vector(center) + d * 12
    camera.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    camera.data.angle_y = 2 * math.atan(height / 2 / 12)


os.makedirs(cfg["out"], exist_ok=True)
scene.render.resolution_x, scene.render.resolution_y = cfg.get("res", (400, 400))
for clip in cfg["clips"]:
    poses = authored[clip][0]
    shown = cfg.get("shown", {}).get(clip, [])
    grips = []
    for pose in poses:
        apply(pose)
        grips.append(rig.matrix_world @ R.grip("weapon"))

    def place(k):
        t = k / 30
        for name, (mesh, _) in items.items():
            mesh.hide_render = True
        live = []
        for entry in shown:
            if entry["from"] - 1e-6 <= t <= entry.get("to", 99):
                mesh, rest = items[entry["item"]]
                at = grips[k]
                if entry.get("at") == "set":  # left where it was set down, its ground frame dropped on to the ground
                    at = grips[int(round(entry.get("set", entry["from"]) * 30))].copy()
                    at.translation.z -= (at @ recipe["TRAP_GROUND"]).z
                mesh.matrix_world = at @ C4i @ rest
                mesh.hide_render = False
                live.append((entry, mesh))
        bpy.context.view_layer.update()
        return live

    drift, lowest, deepest = {}, 9.0, {}
    balls = {side: [] for side in "lr"}
    for k, pose in enumerate(poses):
        apply(pose)
        for side in "lr":
            balls[side].append((rig.matrix_world @ rig.pose.bones["ball_" + side].head).copy())
            lowest = min(lowest, *((rig.matrix_world @ rig.pose.bones[f"{joint}_{side}"].head).z for joint in ("ball", "foot", "hand")))
        if k % 2 == 0:
            for entry, mesh in place(k):
                deepest[entry["item"]] = max(deepest.get(entry["item"], 0.0), round(depth(mesh), 4))
    for side, pts in balls.items():
        worst, span = 0.0, 0.0
        for a, b in zip(pts, pts[1:]):
            span = span + (b - a).xy.length if a.z < .03 and b.z < .03 else 0.0
            worst = max(worst, span)
        drift[side] = round(worst, 4)
    report[clip].update({"plantedDrift": drift, "lowestJoint": round(lowest, 4), "itemDepth": deepest})
    for fraction in cfg.get("stills", {}).get(clip, []):
        k = int(round(fraction * (len(poses) - 1)))
        apply(poses[k])
        place(k)
        for vn in cfg.get("views", ["side", "34"]):
            view(vn, cfg.get("height", 2.3))
            scene.render.filepath = os.path.join(cfg["out"], f"{clip}-{vn}-{k:03d}.png")
            bpy.ops.render.render(write_still=True)
json.dump(report, open(os.path.join(cfg["out"], "report.json"), "w"), indent=1, default=str)
print("REPORT", json.dumps({c: {k: v for k, v in r.items() if k in ("plantedDrift", "lowestJoint", "itemDepth", "tinker")} for c, r in report.items()}))
