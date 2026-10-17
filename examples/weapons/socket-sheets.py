"""Render humanoid-sockets-v1 inspection sheets in Blender.

    blender --background --factory-startup --python examples/weapons/socket-sheets.py -- \
        <character.gltf> <sockets.json> <out-dir> <socket-id>=<item.glb> [<socket-id>=<item.glb> ...]

Each attached item's grip frame (its GLB origin) is placed at
``joint world x socket TRS``, evaluated in glTF terms. The script imports the
character with its node rest pose, measures each bone's import correction at
rest, and so recovers the glTF joint world transform at every evaluated frame.
For every pose (rest, Idle_Loop mid, Walk_Loop quarter and mid) it writes a
3 x 2 sheet: front, side (from the character's left) and back views over
close-ups of the right hand, the left hand from outside and the left hand from
behind.
"""
import json
import math
import os
import sys

import bpy
import numpy
from mathutils import Matrix, Quaternion, Vector

TILE = 480
# glTF (x, y, z) -> Blender (x, -z, y), the importer's axis conversion.
A = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def trs(translation=(0, 0, 0), rotation=(0, 0, 0, 1), scale=(1, 1, 1)):
    x, y, z, w = rotation
    return Matrix.Translation(translation) @ Quaternion((w, x, y, z)).to_matrix().to_4x4() @ Matrix.Diagonal((*scale, 1))


def gltf_rest_worlds(path):
    with open(path) as handle:
        nodes = json.load(handle)["nodes"]
    parent = {child: index for index, node in enumerate(nodes) for child in node.get("children", [])}
    def world(index):
        node = nodes[index]
        local = Matrix([node["matrix"][i::4] for i in range(4)]) if "matrix" in node else trs(
            node.get("translation", (0, 0, 0)), node.get("rotation", (0, 0, 0, 1)), node.get("scale", (1, 1, 1)))
        return (world(parent[index]) @ local) if index in parent else local
    return {node.get("name"): world(index) for index, node in enumerate(nodes)}


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    character, sockets_path, out_dir, attachments = args[0], args[1], args[2], [a.split("=", 1) for a in args[3:]]
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=character, guess_original_bind_pose=False)
    armature = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    rest = gltf_rest_worlds(character)
    with open(sockets_path) as handle:
        sockets = {s["id"]: s for s in json.load(handle)["sockets"]}
    # Bone import correction: Blender rest = glTF rest world (converted) x correction.
    correction = {bone.name: (A @ rest[bone.name] @ A.inverted()).inverted() @ armature.matrix_world @ bone.matrix_local
                  for bone in armature.data.bones}
    items = []
    for socket_id, path in attachments:
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        imported = set(bpy.context.scene.objects) - before
        root = bpy.data.objects.new(f"attach-{socket_id}", None)
        bpy.context.scene.collection.objects.link(root)
        for obj in imported:
            if obj.parent is None:
                obj.parent = root
        socket = sockets[socket_id]
        local = A @ trs(socket["translation"], socket["rotation"], socket.get("scale", (1, 1, 1))) @ A.inverted()
        items.append((root, socket["joint"], local))
    data = armature.animation_data_create()
    for track in list(data.nla_tracks):
        data.nla_tracks.remove(track)
    actions = {action.name: action for action in bpy.data.actions}
    print("[sheets] actions", sorted(actions))

    def pose(clip, fraction):
        data.action = None
        for bone in armature.pose.bones:
            bone.matrix_basis = Matrix.Identity(4)
        if clip:
            action = next(a for name, a in actions.items() if name.startswith(clip))
            data.action = action
            if hasattr(data, "action_slot") and action.slots:
                data.action_slot = action.slots[0]
            start, end = action.frame_range
            frame = start + (end - start) * fraction
            bpy.context.scene.frame_set(int(math.floor(frame)), subframe=frame - math.floor(frame))
        else:
            bpy.context.scene.frame_set(0)
        bpy.context.view_layer.update()
        for root, joint, local in items:
            world = armature.matrix_world @ armature.pose.bones[joint].matrix @ correction[joint].inverted()
            root.matrix_world = world @ local
        bpy.context.view_layer.update()

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 4
    scene.render.resolution_x = scene.render.resolution_y = TILE
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("sheet") if scene.world is None else scene.world
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (.55, .58, .62, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = .9
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(-30))
    scene.collection.objects.link(sun)
    camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    camera.data.type = "ORTHO"
    scene.collection.objects.link(camera)
    scene.camera = camera

    def shot(target, direction, span, path):
        direction = Vector(direction).normalized()
        camera.location = Vector(target) + direction * 6
        camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
        camera.data.ortho_scale = span
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(path)
        pixels = numpy.empty(TILE * TILE * 4, dtype=numpy.float32)
        image.pixels.foreach_get(pixels)
        bpy.data.images.remove(image)
        os.remove(path)
        return pixels.reshape(TILE, TILE, 4)

    def hand(joint):
        return (armature.matrix_world @ armature.pose.bones[joint].matrix).translation

    for name, clip, fraction in [("rest", None, 0), ("idle-mid", "Idle_Loop", .5), ("walk-quarter", "Walk_Loop", .25), ("walk-mid", "Walk_Loop", .5)]:
        pose(clip, fraction)
        tile = os.path.join(out_dir, "tile.png")
        tiles = [
            shot((0, 0, .95), (0, -1, 0), 2.2, tile), shot((0, 0, .95), (1, 0, 0), 2.2, tile), shot((0, 0, .95), (0, 1, 0), 2.2, tile),
            shot(hand("hand_r"), (-.6, -1, .25), .5, tile), shot(hand("hand_l"), (.8, -1, .25), .9, tile), shot(hand("hand_l"), (.3, 1, .2), .9, tile),
        ]
        # Blender images are stored bottom row first: the top sheet row is front | left side | back.
        sheet = numpy.concatenate([numpy.concatenate(tiles[3:], axis=1), numpy.concatenate(tiles[:3], axis=1)], axis=0)
        image = bpy.data.images.new(f"sheet-{name}", TILE * 3, TILE * 2, alpha=True)
        image.pixels.foreach_set(sheet.ravel())
        image.filepath_raw = os.path.join(out_dir, f"sheet-{name}.png")
        image.file_format = "PNG"
        image.save()
        print(f"[sheets] wrote {image.filepath_raw}")


main()
