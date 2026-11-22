"""Armour fit probe (#814): one armour kit on its fit target, headless.

    blender -b --factory-startup --python examples/armour-fit/review.py -- \\
        <target.glb> <clips dir> <out prefix> <kit outputs dir> <kit> [render]

``<target.glb>`` is the recipe's fit target (a Ranger build's ``armor/<kit>-plates/target.glb``). ``<kit outputs dir>``
holds ``<kit>-plates.glb`` and ``<kit>-cloth.glb`` with their observations (``build.py``). ``<clips dir>`` holds
``clips.base.glb`` and ``clips.sword.glb``: the figure's clip GLBs, decoded to plain glTF with ``decode.ts`` when they
come from a published bundle. ``POSES=tpose,walk`` limits the poses; ``DETAIL=<piece>`` prints where that piece is
penetrated (rest height, front or back, middle or side).

Poses: the rest T-pose, then one frame each of idle, walk, sprint, crouch, a high slash, the cleave and the shield guard.
For each pose and piece it reports the median gap of the piece's body-facing surface to the posed body (cm), its 90th
percentile and the share of its vertices more than 3 mm inside the body. With ``render`` it writes, per pose, the mmorpg
game camera's view from 7 m (narrowed to the figure; the walk also at the full 50 degree field), a close-up and a
close-up of the left shoulder. The probe JSON goes to ``<out prefix>-probe.json``.
"""
import json
import math
import os
import struct
import sys

import bpy
import numpy
from mathutils import Matrix, Quaternion, Vector

# glTF (+Y up) to Blender (+Z up).
Y_UP = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
target, clips_dir, prefix, kit_dir, kit = argv[:5]
render = "render" in argv[5:]
POSES = [("tpose", None, None, None), ("idle", "base", "Idle_Loop", .2), ("walk", "base", "Walk_Loop", .25),
         ("sprint", "base", "Sprint_Loop", .3), ("crouch", "base", "Crouch_Idle_Loop", .3),
         ("strike", "sword", "Sword_Slash_High_R", .45), ("cleave", "sword", "Sword_Cleave", .5),
         ("guard", "sword", "Shield_Guard_High_Loop", .3)]
if os.environ.get("POSES"):
    POSES = [p for p in POSES if p[0] in os.environ["POSES"].split(",")]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def imported(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path, guess_original_bind_pose=False)
    return [o for o in bpy.data.objects if o not in before]


body_objects = imported(target)
rig = next(o for o in body_objects if o.type == "ARMATURE")
body = [o for o in body_objects if o.type == "MESH"]
rigs = [rig]
pieces = {}
for output in ("plates", "cloth"):
    path = os.path.join(kit_dir, f"{kit}-{output}.glb")
    observed = json.load(open(path + ".json"))
    objects = imported(path)
    rigs += [o for o in objects if o.type == "ARMATURE"]
    for piece in observed["pieces"]:
        nodes = piece.get("nodes", [piece["node"]])
        found = [o for o in objects if o.type == "MESH" and (o.name in nodes or o.name.split(".0")[0] in nodes)]
        pieces[piece["node"]] = {"kind": piece["kind"], "joint": piece.get("joint"), "objects": found}
        if piece["kind"] == "rigid":
            for obj in found:
                bone = rig.data.bones[piece["joint"]]
                world = obj.matrix_world.copy()
                obj.parent, obj.parent_type, obj.parent_bone = rig, "BONE", piece["joint"]
                obj.matrix_parent_inverse = (rig.matrix_world @ bone.matrix_local @ Matrix.Translation((0, bone.length, 0))).inverted()
                obj.matrix_basis = world

families = {}
for name in sorted({p[1] for p in POSES if p[1]}):
    before = set(bpy.data.actions)
    loaded = imported(os.path.join(clips_dir, f"clips.{name}.glb"))
    path = os.path.join(clips_dir, f"clips.{name}.glb")
    data = open(path, "rb").read()
    length = struct.unpack_from("<I", data, 12)[0]
    nodes = json.loads(data[20:20 + length])["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}

    def local(n):
        x, y, z, w = n.get("rotation", (0, 0, 0, 1))
        return (Matrix.Translation(n.get("translation", (0, 0, 0))) @ Quaternion((w, x, y, z)).to_matrix().to_4x4()
                @ Matrix.Diagonal((*n.get("scale", (1, 1, 1)), 1)))

    def world(i):
        return world(parent[i]) @ local(nodes[i]) if i in parent else local(nodes[i])
    rest = {n.get("name"): Y_UP @ world(i) @ Y_UP.inverted() for i, n in enumerate(nodes)}
    empties = {}
    for o in loaded:
        if o.type == "EMPTY":
            base = o.name.rsplit(".", 1)[0] if o.name.rsplit(".", 1)[-1].isdigit() else o.name
            empties[base] = o
    families[name] = {"empties": empties, "rest": rest, "actions": {a.name: a for a in bpy.data.actions if a not in before}}


def chain(bone):
    depth = 0
    while bone.parent:
        bone, depth = bone.parent, depth + 1
    return depth


ORDER = sorted(rig.pose.bones, key=chain)


def pose(family, clip, phase):
    if clip is None:
        for r in rigs:
            for bone in r.pose.bones:
                bone.matrix_basis = Matrix()
        bpy.context.view_layer.update()
        return
    data = families[family]
    action = data["actions"][clip]
    for name, obj in data["empties"].items():
        slot = next((s for s in action.slots if s.identifier in ("OB" + obj.name, "OB" + name)), None)
        obj.animation_data_create()
        obj.animation_data.action = action if slot else None
        if slot:
            obj.animation_data.action_slot = slot
    start, end = action.frame_range
    scene.frame_set(int(round(start + (end - start) * phase)))
    bpy.context.view_layer.update()
    inverse = rig.matrix_world.inverted()
    for bone in ORDER:
        empty = data["empties"].get(bone.name)
        if empty is None:
            continue
        rest_bone = rig.matrix_world @ bone.bone.matrix_local
        bone.matrix = inverse @ empty.matrix_world @ data["rest"][bone.name].inverted() @ rest_bone
        bpy.context.view_layer.update()
    for other in rigs[1:]:
        for bone in other.pose.bones:
            if bone.name in rig.pose.bones:
                bone.matrix_basis = rig.pose.bones[bone.name].matrix_basis.copy()
    bpy.context.view_layer.update()


def world_mesh(objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    verts, polys, normals = [], [], []
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        matrix = obj.matrix_world
        base = len(verts)
        verts += [matrix @ v.co for v in mesh.vertices]
        rotation = matrix.to_3x3()
        normals += [(rotation @ v.normal).normalized() for v in mesh.vertices]
        polys += [[base + i for i in p.vertices] for p in mesh.polygons]
        evaluated.to_mesh_clear()
    return verts, polys, normals


def probe():
    bverts, bpolys, _ = world_mesh(body)
    tree = BVHTree.FromPolygons(bverts, bpolys)
    report = {}
    for name, piece in sorted(pieces.items()):
        verts, _polys, normals = world_mesh(piece["objects"])
        gaps, inner = [], []
        for v, n in zip(verts, normals):
            location, normal, _index, distance = tree.find_nearest(v)
            if location is None:
                continue
            signed = distance if (v - location).dot(normal) >= 0 else -distance
            gaps.append(signed)
            # The surface facing the body: its normal points toward the nearest body point.
            inner.append(n.dot(location - v) > 0)
        gaps, inner = numpy.array(gaps), numpy.array(inner)
        if os.environ.get("DETAIL") and os.environ["DETAIL"] in name:
            rest = [(o.matrix_world @ v.co) for o in piece["objects"] for v in o.data.vertices]
            bins = {}
            for g, r in zip(gaps, rest):
                if g < -.003:
                    key = (round(r.z, 1), "front" if r.y < 0 else "back", "mid" if abs(r.x) < .08 else "side")
                    bins[key] = bins.get(key, 0) + 1
            print("DETAIL", name, sorted(bins.items(), key=lambda kv: -kv[1])[:12])
        facing = gaps[inner] if inner.any() else gaps
        report[name] = {"median": round(float(numpy.median(facing)) * 100, 2), "p90": round(float(numpy.percentile(facing, 90)) * 100, 2),
                        "inside": round(float((gaps < -.003).mean()) * 100, 1), "deepest": round(float(gaps.min()) * 100, 2)}
    return report


def setup_render():
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1280, 960
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (.32, .34, .38, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = .9
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    scene.collection.objects.link(sun)
    ground = bpy.data.meshes.new("ground")
    ground.from_pydata([(-20, -20, 0), (20, -20, 0), (20, 20, 0), (-20, 20, 0)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new("ground", ground)
    mat = bpy.data.materials.new("ground")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (.18, .2, .15, 1)
    ground.materials.append(mat)
    scene.collection.objects.link(g)
    # The fit target has no textures: give the base meshes plain clothing colours.
    colours = {"Body": (.32, .22, .13), "Legs": (.12, .1, .08), "Arms": (.6, .42, .32), "Feet": (.09, .06, .04)}
    for obj in body:
        key = next((k for k in colours if k in obj.name), None)
        colour = colours.get(key, (.62, .45, .36))
        m = bpy.data.materials.new("base." + obj.name)
        m.use_nodes = True
        m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*colour, 1)
        m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = .8
        obj.data.materials.clear()
        obj.data.materials.append(m)
    camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    scene.collection.objects.link(camera)
    scene.camera = camera
    return camera


def shoot(camera, eye, look, fov, path, size=(1280, 960)):
    scene.render.resolution_x, scene.render.resolution_y = size
    camera.location = eye
    camera.rotation_euler = (look - eye).to_track_quat("-Z", "Y").to_euler()
    camera.data.sensor_fit = "VERTICAL"
    camera.data.angle_y = math.radians(fov)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


camera = setup_render() if render else None
results = {}
for label, family, clip, phase in POSES:
    pose(family, clip, phase)
    results[label] = probe()
    if render:
        # Blender is Z-up; the figure faces -Y. The game camera: pivot 0.6 m up, 50 degree vertical field of view, pitched
        # 0.42 rad, here at 7 m from the front three-quarter. The close-up frames the shoulders and chest.
        pivot = Vector((0, 0, .6 + .5))
        direction = Vector((math.sin(math.radians(30)) * math.cos(.42), -math.cos(math.radians(30)) * math.cos(.42), math.sin(.42)))
        if label == "walk":
            shoot(camera, pivot + direction * 7, pivot, 50, f"{prefix}-{label}-game-wide.png", (1280, 960))
        # The same eye, narrowed to the figure.
        shoot(camera, pivot + direction * 7, pivot + Vector((0, 0, -.15)), 17, f"{prefix}-{label}-game.png", (760, 1000))
        chest = rig.matrix_world @ rig.pose.bones["spine_03"].head
        close = Vector((math.sin(math.radians(25)), -math.cos(math.radians(25)), .2)).normalized()
        shoot(camera, chest + close * 1.6, chest, 50, f"{prefix}-{label}-close.png", (900, 900))
        shoulder = rig.matrix_world @ rig.pose.bones["upperarm_l"].head
        side = Vector((.8, -.55, .3)).normalized()
        shoot(camera, shoulder + side * .9, shoulder + Vector((0, 0, -.08)), 45, f"{prefix}-{label}-shoulder.png", (700, 700))
with open(f"{prefix}-probe.json", "w") as handle:
    json.dump(results, handle, indent=1)
print("PROBE " + json.dumps(results))
