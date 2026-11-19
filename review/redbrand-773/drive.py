"""Review driver (#773): author defend_clips.py's guard and signal clips on the published Ranger, hold the items on
their sockets, render stills at the game camera and measure foot drift and item depth inside the body.

    blender -b --factory-startup -P drive.py -- config.json
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

cfg = json.load(open(sys.argv[sys.argv.index("--") + 1]))
recipe = {"__name__": "recipe"}
exec(compile(open(cfg["recipe"]).read(), cfg["recipe"], "exec"), recipe)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps, scene.render.fps_base = 30, 1
before = set(scene.objects)
target = cfg["target"]
bpy.ops.import_scene.gltf(filepath=target, bone_heuristic="BLENDER", guess_original_bind_pose=False)
figure = [o for o in scene.objects if o not in before]
rig = next(o for o in figure if o.type == "ARMATURE")
rig.animation_data_create()
rig.animation_data.action = None
descriptor = {s["id"]: s for s in json.load(open(cfg["sockets"]))["sockets"]}
sockets = {name: {k: descriptor[i][k] for k in ("joint", "translation", "rotation")} for name, i in recipe["SOCKET_IDS"].items()}
authored = recipe["author_all"](rig, {"schemaVersion": 1, "clips": cfg["clips"], "sockets": sockets}, target)
R = recipe["Rig"](rig, sockets, recipe["gltf_rest_worlds"](target))
C4i = recipe["C4"].inverted()
report = {name: {k: v for k, v in obs.items() if k != "secondaryPose"} for name, (_, obs) in authored.items()}

items = {}
for name, path in cfg["items"].items():
    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    mesh = next(o for o in scene.objects if o not in before and o.type == "MESH")
    mesh.parent = None
    items[name] = (mesh, mesh.matrix_world.copy(), [v.co.copy() for v in mesh.data.vertices])


def apply(pose):
    for name, basis in pose.items():
        rig.pose.bones[name].matrix_basis = basis
    bpy.context.view_layer.update()


def place(shown):
    for name, (mesh, rest, _) in items.items():
        mesh.hide_render = name not in shown
        if name in shown:
            mesh.matrix_world = rig.matrix_world @ R.grip(shown[name]) @ C4i @ rest


CAPS = [("torso", "pelvis", "neck_01", .12, 0), ("head", "Head", "Head", .1, .17), ("thigh_l", "thigh_l", "calf_l", .075, 0),
        ("thigh_r", "thigh_r", "calf_r", .075, 0)]


def capsule_depth(p):
    worst, part = -9.0, None
    for name, a, b, r, extend in CAPS:
        A = rig.pose.bones[a].head.copy()
        B = rig.pose.bones[b].head.copy() if a != b else A + (rig.pose.bones[a].tail - A).normalized() * extend
        ab = B - A
        t = max(0.0, min(1.0, (p - A).dot(ab) / max(ab.length_squared, 1e-9)))
        d = r - (p - (A + ab * t)).length
        if d > worst:
            worst, part = d, name
    return worst, part


def item_depth(shown):
    """The deepest item vertex inside the body capsules, ignoring vertices within 0.12 m of either hand."""
    worst = (-9.0, None, None)
    hands = [rig.pose.bones[f"hand_{s}"].head.copy() for s in "lr"]
    for name, socket in shown.items():
        mesh, rest, verts = items[name]
        m = R.grip(socket) @ C4i @ rest
        for co in verts[::2]:
            p = m @ co
            if min((p - h).length for h in hands) < .12:
                continue
            d, part = capsule_depth(p)
            if d > worst[0]:
                worst = (d, part, name)
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
ground = bpy.data.objects.new("ground", bpy.data.meshes.new("ground"))
ground.data.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
gm = bpy.data.materials.new("ground")
gm.diffuse_color = (.45, .43, .38, 1)
ground.data.materials.append(gm)
scene.collection.objects.link(ground)
for o in figure:
    if o.type == "MESH":
        for slot in o.material_slots:
            if slot.material:
                slot.material.diffuse_color = (.55, .45, .38, 1) if "skin" not in slot.material.name.lower() else (.7, .55, .45, 1)
VIEWS = {"side": -90, "34": -45, "front": 0, "behind": 180, "34r": 45}


def view(name, height, center):
    a, pitch = math.radians(VIEWS[name]), cfg.get("pitch", .42)
    dvec = Vector((math.sin(a) * math.cos(pitch), -math.cos(a) * math.cos(pitch), math.sin(pitch)))
    camera.location = Vector(center) + dvec * 12
    camera.rotation_euler = (-dvec).to_track_quat("-Z", "Y").to_euler()
    camera.data.angle_y = 2 * math.atan(height / 2 / 12)


os.makedirs(cfg["out"], exist_ok=True)
scene.render.resolution_x, scene.render.resolution_y = cfg.get("res", (360, 400))
for clip in cfg["clips"]:
    poses = authored[clip][0]
    shown = cfg["shown"][recipe["GUARD"][clip]["family"]]
    drift, lowest, depth = {}, 9.0, (-9.0, None, None, None)
    balls = {side: [] for side in "lr"}
    for k, pose in enumerate(poses):
        apply(pose)
        for side in "lr":
            balls[side].append((rig.matrix_world @ rig.pose.bones["ball_" + side].head).copy())
            lowest = min(lowest, *((rig.matrix_world @ rig.pose.bones[f"{joint}_{side}"].head).z for joint in ("ball", "foot")))
        drop = report[clip].get("signal", {}).get("dropSeconds")
        d = item_depth(shown) if drop is None or k / 30 <= drop else (-9.0, None, None)
        if d[0] > depth[0]:
            depth = (*d, k)
    for side, pts in balls.items():
        worst, span = 0.0, 0.0
        for a, b in zip(pts, pts[1:]):
            span = span + (b - a).xy.length if a.z < .03 and b.z < .03 else 0.0
            worst = max(worst, span)
        drift[side] = round(worst, 4)
    report[clip].update({"plantedDrift": drift, "lowestJoint": round(lowest, 4),
                         "itemDepth": {"meters": round(depth[0], 4), "part": depth[1], "item": depth[2], "frame": depth[3]}})
    print("CLIP", clip, json.dumps({k: report[clip][k] for k in ("plantedDrift", "lowestJoint", "itemDepth")}))
    stills = cfg.get("stills", 6)
    for s in range(stills):
        k = int(round(s * (len(poses) - 1) / (stills - 1)))
        apply(poses[k])
        place(shown)
        for vn in cfg.get("views", ["34"]):
            view(vn, cfg.get("height", 2.3), cfg.get("center", (0, -.1, 1.0)))
            scene.render.filepath = os.path.join(cfg["out"], f"{clip}-{vn}-{k:03d}.png")
            bpy.ops.render.render(write_still=True)
scene.render.resolution_x, scene.render.resolution_y = 420, 480
for clip, frames in cfg.get("closeups", {}).items():
    shown = cfg["shown"][recipe["GUARD"][clip]["family"]]
    for k in frames:
        apply(authored[clip][0][k])
        place(shown)
        for vn in ("front", "34", "side", "34r"):
            view(vn, 1.5, (0, -.15, 1.15))
            scene.render.filepath = os.path.join(cfg["out"], f"close-{clip}-{k:03d}-{vn}.png")
            bpy.ops.render.render(write_still=True)
json.dump(report, open(os.path.join(cfg["out"], "report.json"), "w"), indent=1, default=str)
