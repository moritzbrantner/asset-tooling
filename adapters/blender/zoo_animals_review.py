"""Review renders of posed zoo-animals GLBs (scripts/review-zoo-animals.ts writes them and the plan).

    blender -b --factory-startup --python-exit-code 1 --python zoo_animals_review.py -- <directory>

<directory>/plan.json lists the poses and <directory>/poses/<id>.glb holds each one, already posed from the
packaged clips, so nothing here evaluates animation. The animals are scaled to Zoo's on-screen animal height
(about 0.55 m on its 1 m tiles) and shown at Zoo's default camera: yaw −38°, pitch 46°, a 36° vertical field of
view, at a park distance and at a close animal-watch distance, plus two more orbit angles, a current-versus-
candidate comparison, a grid of every clip's poses and a looping walk GIF. Evidence only; it decides nothing.
"""
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

OUT = sys.argv[sys.argv.index("--") + 1]
PLAN = json.load(open(os.path.join(OUT, "plan.json")))
ZOO_HEIGHT = 0.55  # metres: Zoo's code-built zebra is about this tall on its 1 m tile
FOV_Y = math.radians(36)
YAW, PITCH = -38.0, 46.0
WIDTH, HEIGHT = 1280, 720


def linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def flat_material(name, srgb):
    mat = bpy.data.materials.new(name)
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = tuple(linear(c) for c in srgb) + (1,)
    bsdf.inputs["Roughness"].default_value = 0.9
    return mat


def setup():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            pass
    try:
        scene.view_settings.view_transform = "Standard"
    except TypeError:
        pass
    scene.render.resolution_x, scene.render.resolution_y = WIDTH, HEIGHT
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 88
    world = bpy.data.worlds.new("sky")
    scene.world = world
    background = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    background.inputs[0].default_value = (0.62, 0.72, 0.82, 1)
    background.inputs[1].default_value = 1.0
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.0
    sun.data.angle = math.radians(8)
    sun.rotation_euler = (math.radians(42), 0, math.radians(-60))
    scene.collection.objects.link(sun)
    # 1 m tiles in two grass tones, an enclosure of 7 × 5 tiles, and a low fence of posts and rails around it.
    grass, grass_light = flat_material("grass", (0.36, 0.55, 0.24)), flat_material("grass-light", (0.4, 0.6, 0.27))
    mesh = bpy.data.meshes.new("tiles")
    bm = bmesh.new()
    for ix in range(-12, 12):
        for iy in range(-10, 10):
            verts = [bm.verts.new((ix + dx, iy + dy, 0)) for dx, dy in ((0, 0), (1, 0), (1, 1), (0, 1))]
            face = bm.faces.new(verts)
            face.material_index = (ix + iy) % 2
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(grass)
    mesh.materials.append(grass_light)
    scene.collection.objects.link(bpy.data.objects.new("tiles", mesh))
    wood = flat_material("fence", (0.55, 0.38, 0.22))
    fence = bpy.data.meshes.new("fence")
    bm = bmesh.new()
    x0, x1, y0, y1 = -3.5, 3.5, -2.5, 2.5

    def box(center, size):
        result = bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.transform(bm, verts=result["verts"], matrix=__import__("mathutils").Matrix.Diagonal(Vector(size)).to_4x4())
        bmesh.ops.translate(bm, verts=result["verts"], vec=Vector(center))

    for x in range(-3, 4):
        for y in (y0, y1):
            box((x + 0.5 if x < 3 else x, y, 0.18), (0.06, 0.06, 0.36))
    for y in range(-2, 3):
        for x in (x0, x1):
            box((x, y, 0.18), (0.06, 0.06, 0.36))
    for y in (y0, y1):
        box((0, y, 0.28), (x1 - x0, 0.04, 0.05))
    for x in (x0, x1):
        box((x, 0, 0.28), (0.04, y1 - y0, 0.05))
    bm.to_mesh(fence)
    bm.free()
    fence.materials.append(wood)
    scene.collection.objects.link(bpy.data.objects.new("fence", fence))
    camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    camera.data.sensor_fit = "VERTICAL"
    camera.data.angle_y = FOV_Y
    scene.collection.objects.link(camera)
    scene.camera = camera
    return scene, camera


def place(pose_id, location, yaw_degrees):
    """Import one posed GLB under an empty, scaled to Zoo's animal height and turned by ``yaw_degrees``."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(OUT, "poses", f"{pose_id}.glb"))
    imported = [o for o in bpy.data.objects if o not in before]
    # glTF multiplies the base colour by COLOR_0 (three.js does so on its own); Blender's importer leaves it unwired.
    for obj in imported:
        if obj.type != "MESH" or len(obj.data.color_attributes) == 0:
            continue
        for mat in obj.data.materials:
            tree = mat.node_tree
            bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
            if bsdf.inputs["Base Color"].is_linked:
                continue
            colour = tree.nodes.new("ShaderNodeVertexColor")
            colour.layer_name = obj.data.color_attributes[0].name
            tree.links.new(colour.outputs["Color"], bsdf.inputs["Base Color"])
    holder = bpy.data.objects.new(f"pose:{pose_id}", None)
    bpy.context.scene.collection.objects.link(holder)
    for obj in imported:
        if obj.parent is None:
            obj.parent = holder
    bpy.context.view_layer.update()
    points = [o.matrix_world @ v.co for o in imported if o.type == "MESH" for v in o.data.vertices]
    height = max(p.z for p in points) - min(p.z for p in points)
    length = max(p.x for p in points) - min(p.x for p in points)
    return holder, imported, height, length


def arrange(holder, location, yaw_degrees, scale):
    holder.scale = (scale, scale, scale)
    holder.rotation_euler = (0, 0, math.radians(yaw_degrees))
    holder.location = Vector(location)


def show(groups, visible):
    for name, (holder, objects) in groups.items():
        for obj in [holder] + objects:
            obj.hide_render = name not in visible


def shoot(scene, camera, name, target, distance, yaw=YAW, pitch=PITCH, ortho=None):
    t = Vector(target)
    y, p = math.radians(yaw - 90), math.radians(pitch)  # Zoo's yaw 0 looks along +Y here; −38° turns it left
    camera.location = t + distance * Vector((math.cos(p) * math.cos(y), math.cos(p) * math.sin(y), math.sin(p)))
    camera.rotation_euler = (t - camera.location).to_track_quat("-Z", "Y").to_euler()
    if ortho:
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = ortho * scene.render.resolution_y / scene.render.resolution_x  # vertical fit: scale is the height
    else:
        camera.data.type = "PERSP"
    scene.render.filepath = os.path.join(OUT, name)
    bpy.ops.render.render(write_still=True)


def main():
    scene, camera = setup()
    groups, heights, lengths = {}, {}, {}
    for pose in PLAN["poses"]:
        holder, objects, height, length = place(pose["id"], (0, 0, 0), 0)
        groups[pose["id"]] = (holder, objects)
        heights[pose["id"]] = height
        lengths[pose["id"]] = length
    # one scale per animal, from its standing idle height
    scale_current = ZOO_HEIGHT / heights["current-idle"]
    scale_candidate = ZOO_HEIGHT / heights["idle-0"]

    def put(pose_id, location, yaw):
        arrange(groups[pose_id][0], location, yaw, scale_current if pose_id.startswith("current") else scale_candidate)

    # The enclosure: the candidate idling, walking, feeding and resting, and the current zebra for scale.
    enclosure = {"current-idle": ((-2.2, 1.2, 0), 200), "idle-0": ((-0.6, 1.4, 0), 160), "walk-3": ((1.4, 0.8, 0), 20),
                 "feed-1": ((-1.4, -1.1, 0), -30), "rest-1": ((1.6, -1.2, 0), 140)}
    for pose_id, (location, yaw) in enclosure.items():
        put(pose_id, location, yaw)
    show(groups, enclosure)
    shoot(scene, camera, "park.jpg", (0, 0, 0.2), 22)
    shoot(scene, camera, "watch.jpg", (0, 0, 0.25), 6.5)
    shoot(scene, camera, "orbit-front.jpg", (0, 0, 0.25), 6.5, yaw=YAW + 120, pitch=30)
    shoot(scene, camera, "orbit-back.jpg", (0, 0, 0.25), 6.5, yaw=YAW + 220, pitch=34)

    # Current and candidate side by side at the same height and angle.
    put("current-idle", (-0.5, 0, 0), 0)
    put("idle-0", (0.5, 0, 0), 0)
    put("current-walk", (-0.5, 0, 0), 0)
    show(groups, {"current-idle", "idle-0"})
    shoot(scene, camera, "compare.jpg", (0.05, 0, 0.28), 2.6, yaw=-28, pitch=22)

    # The candidate's face, close up from three-quarters front: the expression is what players bond with.
    put("idle-0", (0, 0, 0), 0)
    show(groups, {"idle-0"})
    bpy.context.view_layer.update()
    head = next(o for o in groups["idle-0"][1] if o.name.split(".")[0] == "head")
    face = [head.matrix_world @ v.co for v in head.data.vertices]
    size = max(max(p[i] for p in face) - min(p[i] for p in face) for i in range(3))
    centre = Vector([(max(p[i] for p in face) + min(p[i] for p in face)) / 2 for i in range(3)])
    shoot(scene, camera, "face.jpg", centre, 3.2 * size, yaw=118, pitch=10)  # framed by the head's own size

    # Every clip's poses in a row, seen from the animal's right side, spaced by the animal's own length.
    step = max(0.8, 1.15 * lengths["idle-0"] * scale_candidate)
    for clip in ("idle", "walk", "feed", "rest"):
        ids = [p["id"] for p in PLAN["poses"] if p["clip"] == clip and p["id"].startswith(clip)]
        if clip == "walk":
            ids = ids[::2]
        for index, pose_id in enumerate(ids):
            put(pose_id, (index * step - (len(ids) - 1) * step / 2, 0, 0), 0)
        show(groups, set(ids))
        shoot(scene, camera, f"strip-{clip}.jpg", (0, 0, 0.27), 12, yaw=0, pitch=10, ortho=step * len(ids) + 0.4)

    # A walk loop from the watch camera, as GIF frames.
    walk = [p["id"] for p in PLAN["poses"] if p["id"].startswith("walk-")]
    scene.render.resolution_x, scene.render.resolution_y = 480, 360
    for index, pose_id in enumerate(walk):
        put(pose_id, (0, 0, 0), 0)
        show(groups, {pose_id})
        shoot(scene, camera, f"walk-frames/{index:02d}.jpg", (0.05, 0, 0.28), 2.2, yaw=-20, pitch=24)


main()
