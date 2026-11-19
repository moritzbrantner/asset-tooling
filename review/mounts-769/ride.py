"""Authors adapters/blender/ride_clips.py's clips on a published Ranger and plays each on the riding horse of
adapters/blender/mounts.py, the rider's root on ``saddle.seat`` and both clips in step; renders stills and measures the
fit:

    blender -b --factory-startup -P ride.py -- config.json

config: ``horse`` (the mounts GLB), ``horseObserved`` (its recipe observations, for the sockets), ``ranger`` (the merged
figure, see ../ranger-clips-767/merge.py, textures stripped), ``recipe``, ``arguments`` (the ride family's), ``clips``
({rider clip: horse clip}), ``out``, ``views`` and ``stills`` ({clip: [fractions]}).

Reported per clip: the deepest rider vertex inside the horse or its tack (metres, and the rider's bone there), the
worst palm-to-rein and ball-to-stirrup distances while seated, and the pelvis's rise off the seat.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

cfg = json.load(open(sys.argv[sys.argv.index("--") + 1]))
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps, scene.render.fps_base = 30, 1

before = set(scene.objects)
bpy.ops.import_scene.gltf(filepath=cfg["horse"])
horse_objects = [o for o in scene.objects if o not in before]
horse = next(o for o in horse_objects if o.type == "ARMATURE")
horse_meshes = [o for o in horse_objects if o.type == "MESH" and not o.name.startswith("Icosphere")]
horse_actions = {a.name: a for a in bpy.data.actions}
for o in horse_objects:
    if o.name.startswith("Icosphere"):
        bpy.data.objects.remove(o)

before = set(scene.objects)
bpy.ops.import_scene.gltf(filepath=cfg["ranger"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
figure = [o for o in scene.objects if o not in before]
rider = next(o for o in figure if o.type == "ARMATURE")
for o in list(figure):
    if o.name.startswith("Icosphere"):
        bpy.data.objects.remove(o)
        figure.remove(o)
rider_meshes = [o for o in figure if o.type == "MESH"]
rider.animation_data_create()
rider.animation_data.action = None

recipe = {"__name__": "ride_clips"}
exec(compile(open(cfg["recipe"]).read(), cfg["recipe"], "exec"), recipe)
args = {**cfg["arguments"], "clips": list(cfg["clips"])}
authored = recipe["author_all"](rider, args, cfg["ranger"])
palms = recipe["Rig"](rider, {}, recipe["gltf_rest_worlds"](cfg["ranger"]))

# The sockets at rest, in Blender world axes, and their offset from Torso2.
horse.animation_data_create()
horse.animation_data.action = None
for pb in horse.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()
observed = json.load(open(cfg["horseObserved"]))
to_blender = lambda g: Vector((g[0], -g[2], g[1]))
bone_world = lambda: horse.matrix_world @ horse.pose.bones["Torso2"].matrix
rest = bone_world()
local = {name: rest.inverted() @ Matrix.Translation(to_blender(s["at"])) for name, s in observed["sockets"].items()}


def socket(name):
    m = bone_world() @ local[name]
    loc, rot, _ = m.decompose()
    return Matrix.LocRotScale(loc, rot, Vector((1, 1, 1)))


top = rider
while top.parent:
    top = top.parent


def apply(rider_pose, horse_action, frame):
    horse.animation_data.action = horse_action
    slots = horse.animation_data.action_suitable_slots
    if slots:
        horse.animation_data.action_slot = slots[0]
    scene.frame_set(frame)
    rider.animation_data.action = None
    for name, basis in rider_pose.items():
        rider.pose.bones[name].matrix_basis = basis
    bpy.context.view_layer.update()
    seat = socket("saddle.seat")
    top.matrix_world = seat @ (rider.matrix_world.inverted() @ top.matrix_world) if top is not rider else seat
    bpy.context.view_layer.update()


def bvh_of(meshes):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    verts, polys = [], []
    for mesh in meshes:
        ev = mesh.evaluated_get(depsgraph)
        data = ev.to_mesh()
        base = len(verts)
        verts.extend(ev.matrix_world @ v.co for v in data.vertices)
        polys.extend(tuple(base + i for i in p.vertices) for p in data.polygons)
        ev.to_mesh_clear()
    return BVHTree.FromPolygons(verts, polys)


body = max(rider_meshes, key=lambda o: len(o.data.vertices))
groups = {g.index: g.name for g in body.vertex_groups}
sample = list(range(0, len(body.data.vertices), 3))


def crossings(tree, p, direction):
    count, origin = 0, p.copy()
    for _ in range(40):
        h, _, _, _ = tree.ray_cast(origin, direction, 5.0)
        if h is None:
            break
        count += 1
        origin = h + direction * 1e-4
    return count


def deepest():
    """The deepest rider vertex inside the horse and tack (by the nearest face's normal), with its bone."""
    tree = bvh_of(horse_meshes)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    worst, where = 0.0, None
    for mesh in rider_meshes:
        ev = mesh.evaluated_get(depsgraph)
        data = ev.to_mesh()
        for i in (sample if mesh is body else range(len(data.vertices))):
            p = ev.matrix_world @ data.vertices[i].co
            hit, normal, _, dist = tree.find_nearest(p, .2)
            if hit is not None and normal.dot(p - hit) < 0 and dist > worst:
                # Confirm with rays up, sideways and ahead: inside a closed surface each crosses an odd number of faces.
                # The low-poly horse has open and overlapping shells, so one ray alone is fooled.
                if all(crossings(tree, p, d) % 2 == 1 for d in (Vector((0, 0, 1)), Vector((1, 0, 0)), Vector((-1, 0, 0)), Vector((0, -1, 0)))):
                    worst = dist
                    g = max(mesh.data.vertices[i].groups, key=lambda e: e.weight).group if mesh.data.vertices[i].groups else None
                    seat = socket("saddle.seat").inverted() @ p
                    where = (mesh.name, mesh.vertex_groups[g].name if g is not None else None, [round(c, 3) for c in seat])
        ev.to_mesh_clear()
    return worst, where


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
VIEWS = {"side": (-90, .08, 3.0), "game": (-45, .42, 3.4), "near": (45, .42, 3.4), "front": (0, .3, 3.0), "close": (-70, .25, 1.9), "back": (150, .35, 3.0)}


def view(name):
    a, pitch, height = VIEWS[name]
    a = math.radians(a)
    d = Vector((math.sin(a) * math.cos(pitch), -math.cos(a) * math.cos(pitch), math.sin(pitch)))
    centre = Vector(cfg.get("center", (0, 0, 1.35)))
    camera.location = centre + d * 12
    camera.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    camera.data.angle_y = 2 * math.atan(height / 2 / 12)


os.makedirs(cfg["out"], exist_ok=True)
scene.render.resolution_x, scene.render.resolution_y = cfg.get("res", (420, 420))
report = {}
for clip, horse_clip in cfg["clips"].items():
    poses, obs = authored[clip]
    action = horse_actions[horse_clip]
    count = int(round(action.frame_range[1] - action.frame_range[0]))
    depth, where, hands, feet, rise = 0.0, None, 0.0, 0.0, 0.0
    seated = clip not in ("Mount_Horse", "Dismount_Horse")
    for k, pose in enumerate(poses):
        apply(pose, action, k % count if count else 0)
        d, w = deepest()
        if d > depth:
            depth, where = d, (k, *w)
        if seated:
            for side in "lr":
                # The middle of the palm, as the recipe targets it (its palm frame times the PALM point).
                palm = rider.matrix_world @ palms.grip(f"palm_{side}") @ recipe["PALM"]
                hands = max(hands, (palm - socket(f"reins.{side}").translation).length)
                ball = rider.matrix_world @ rider.pose.bones[f"ball_{side}"].head
                feet = max(feet, (ball - socket(f"stirrup.{side}").translation).length)
            pelvis = rider.matrix_world @ rider.pose.bones["pelvis"].head
            rise = max(rise, (socket("saddle.seat").inverted() @ pelvis).z)
    report[clip] = {"insideHorseMeters": round(depth, 4), "deepestAt": where, "palmFromReinsMeters": round(hands, 4),
                    "ballFromStirrupMeters": round(feet, 4), "pelvisRiseMeters": round(rise, 4), "frames": len(poses)}
    print("FIT", clip, json.dumps(report[clip]))
    for fraction in cfg.get("stills", {}).get(clip, []):
        k = int(round(fraction * (len(poses) - 1)))
        apply(poses[k], action, k % count if count else 0)
        for vn in cfg.get("views", ["game"]):
            view(vn)
            scene.render.filepath = os.path.join(cfg["out"], f"{clip}-{vn}-{k:03d}.png")
            bpy.ops.render.render(write_still=True)
json.dump(report, open(os.path.join(cfg["out"], "report.json"), "w"), indent=1)
