"""Dev driver: author recipe clips on the published Ranger clips rig, skin the published mesh on it, render stills at
the game camera's angle and measure hand/load penetration.

    blender -b --factory-startup -P drive.py -- config.json
"""
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector, Quaternion

cfg = json.load(open(sys.argv[sys.argv.index("--") + 1]))
DL = cfg["dl"]
recipe = {"__name__": "recipe"}
exec(compile(open(cfg["recipe"]).read(), cfg["recipe"], "exec"), recipe)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps, scene.render.fps_base = 30, 1
before = set(scene.objects)
clips_glb = os.path.join(DL, "ranger.gltf")
bpy.ops.import_scene.gltf(filepath=clips_glb, bone_heuristic="BLENDER", guess_original_bind_pose=False)
figure = [o for o in scene.objects if o not in before]
rig = next(o for o in figure if o.type == "ARMATURE")
print("ARMATURES", [(o.name, len(o.data.bones)) for o in figure if o.type == "ARMATURE"])
for o in figure:
    if o.type == "ARMATURE":
        o.animation_data_create()
        o.animation_data.action = None
descriptor = {s["id"]: s for s in json.load(open(os.path.join(DL, "humanoid.ranger.male.default.humanoid-sockets.json")))["sockets"]}
sockets = {name: {k: descriptor[i][k] for k in ("joint", "translation", "rotation")} for name, i in cfg["sockets"].items()}
args = {"schemaVersion": 1, "clips": cfg["clips"], "sockets": sockets}
authored = recipe["author_all"](rig, args, clips_glb)
R = recipe["Rig"](rig, sockets, recipe["gltf_rest_worlds"](clips_glb))
C4i = recipe["C4"].inverted()
report = {name: obs for name, (_, obs) in authored.items()}

items = {}
for name, path in cfg.get("items", {}).items():
    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    mesh = next(o for o in scene.objects if o not in before and o.type == "MESH")
    items[name] = (mesh, mesh.matrix_world.copy())


def apply(pose):
    rig.animation_data.action = None
    for name, basis in pose.items():
        for arm in (o for o in figure if o.type == "ARMATURE"):
            if name in arm.pose.bones:
                arm.pose.bones[name].matrix_basis = basis
    bpy.context.view_layer.update()


def place_items(shown):
    for name, (mesh, rest) in items.items():
        mesh.hide_render = name not in shown
        if name in shown:
            mesh.matrix_world = rig.matrix_world @ R.grip(shown[name]) @ C4i @ rest


# The load box on chest.carry (+Y up, +Z away from the chest), and the hand vertices' depth inside it.
load_box = None
if cfg.get("load"):
    w, h, d = cfg["load"]
    load = bpy.data.objects.new("load", bpy.data.meshes.new("load"))
    vs = [(x, y, z) for x in (-w / 2, w / 2) for y in (-h / 2, h / 2) for z in (0, d)]
    fs = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    load.data.from_pydata(vs, [], fs)
    mat = bpy.data.materials.new("crate")
    mat.diffuse_color = (.55, .38, .2, 1)
    load.data.materials.append(mat)
    scene.collection.objects.link(load)
    load_box = (w, h, d, load)
HAND = ("hand_", "index_", "middle_", "ring_", "pinky_", "thumb_")
body = next(o for o in figure if o.type == "MESH" and any(g.name.startswith("index_01") for g in o.vertex_groups))
hand_groups = {g.index for g in body.vertex_groups if g.name.startswith(HAND)}
hand_verts = [v.index for v in body.data.vertices if any(e.group in hand_groups and e.weight > .5 for e in v.groups)]


WORST = [None]


def hand_depth():
    w, h, d, load = load_box
    grip = rig.matrix_world @ R.grip("carry")
    load.matrix_world = grip
    inv = load.matrix_world.inverted()
    ev = body.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    worst = 0.0
    for i in hand_verts:
        p = inv @ (body.matrix_world @ ev.vertices[i].co)
        inside = min(w / 2 - abs(p.x), h / 2 - abs(p.y), p.z, d - p.z)
        if inside > worst:
            worst = inside
            g = max(body.data.vertices[i].groups, key=lambda e: e.weight).group
            WORST[0] = (round(inside, 4), body.vertex_groups[g].name, tuple(round(c, 3) for c in p))
    body.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
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
VIEWS = {"side": -90, "34": -45, "front": 0, "behind": 180}


def view(name, height, center=None):
    center = center or cfg.get("center", (0, -.25, 1.15))
    a, pitch = math.radians(VIEWS[name]), cfg.get("pitch", .42)
    dvec = Vector((math.sin(a) * math.cos(pitch), -math.cos(a) * math.cos(pitch), math.sin(pitch)))
    camera.location = Vector(center) + dvec * 12
    camera.rotation_euler = (-dvec).to_track_quat("-Z", "Y").to_euler()
    camera.data.angle_y = 2 * math.atan(height / 2 / 12)


for x, y, z, r in cfg.get("rocks", []):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=r, location=(x, y, z))
    rock = bpy.context.active_object
    rock.scale = (1.0, .8, .75)
    rm = bpy.data.materials.new("rock")
    rm.diffuse_color = (.42, .4, .45, 1)
    rock.data.materials.append(rm)
os.makedirs(cfg["out"], exist_ok=True)
scene.render.resolution_x, scene.render.resolution_y = cfg.get("res", (400, 400))
for clip in cfg["clips"]:
    poses = authored[clip][0]
    shown = cfg.get("shown", {}).get(clip, {})
    if load_box:
        load_box[3].hide_render = clip not in cfg.get("load_clips", [])
        if clip in cfg.get("load_clips", []):
            depths = []
            for pose in poses:
                apply(pose)
                depths.append(hand_depth())
            report[clip]["handDepthMax"] = round(max(depths), 4)
            print("WORST", clip, WORST[0])
    # foot slide: ankle travel while planted (ball height < 4 cm)
    slides = {}
    for side in "lr":
        pts = []
        for pose in poses:
            apply(pose)
            pts.append((rig.matrix_world @ rig.pose.bones["ball_" + side].head).copy())
        low = [p for p in pts if p.z < min(q.z for q in pts) + .02]
        slides[side] = round(max((a - b).xy.length for a in low for b in low), 4) if low else None
    report[clip]["ballSpread"] = slides
    for fraction in cfg.get("stills", {}).get(clip, []):
        k = int(round(fraction * (len(poses) - 1)))
        apply(poses[k])
        place_items(shown)
        if load_box and clip in cfg.get("load_clips", []):
            load_box[3].matrix_world = rig.matrix_world @ R.grip("carry")
        for vn in cfg.get("views", ["side", "34"]):
            view(vn, cfg.get("height", 2.3))
            scene.render.filepath = os.path.join(cfg["out"], f"{clip}-{vn}-{k:03d}.png")
            bpy.ops.render.render(write_still=True)
json.dump(report, open(os.path.join(cfg["out"], "report.json"), "w"), indent=1, default=str)
print("REPORT", json.dumps({c: {k: v for k, v in r.items() if k in ("handDepthMax", "ballSpread", "tool", "strikeSeconds")} for c, r in report.items()}))
if cfg.get("debug"):
    p = authored[cfg["clips"][0]][0][0]
    apply(p)
    print("DBG hand_r", rig.pose.bones["hand_r"].head, "carry", R.grip("carry").translation, "action", rig.animation_data.action)
    body_mods = [(o.name, [(m.type, m.object.name if m.object else None) for m in o.modifiers]) for o in figure if o.type == "MESH"]
    print("DBG mods", body_mods, [o.parent.name if o.parent else None for o in figure if o.type == "MESH"])
    print("DBG pose keys", len(p), list(p)[:5])
