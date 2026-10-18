"""Compare a reconstructed mesh with its ground-truth asset (#122).

    blender --background --factory-startup --python examples/image-to-3d-eval/compare.py -- \
        <ground-truth.gltf> <candidate.glb> <metrics.json> <beauty.png> <gameplay distance m>

The candidate's frame is unknown, so it is aligned first:

- every axis-aligned orientation (24) and eight yaws are tried;
- each one is scaled so its height matches the ground truth's and centred on it;
- the one with the best mean silhouette IoU over three coarse views wins.

The aligned pair is then measured:

- silhouette IoU from six views (front, back, left, right, top, front-left);
- triangle and vertex counts;
- loose parts and non-manifold edges;
- whether the candidate has UVs, textures or vertex colours;
- a side-by-side render at the case's gameplay distance.

Higher IoU means a closer shape; the counts estimate the clean-up a game asset would still need.
"""
import json
import math
import sys

import bmesh
import bpy
import numpy
from mathutils import Euler, Matrix, Vector

COARSE, FINE = 96, 256
VIEWS = {"front": (0, -1, 0), "back": (0, 1, 0), "left": (-1, 0, 0), "right": (1, 0, 0), "top": (0, 0, 1), "front-left": (-.6, -1, .4)}


def import_objects(path):
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    objects = [o for o in bpy.context.scene.objects if o not in before]
    meshes = [o for o in objects if o.type == "MESH" and not o.name.startswith("Icosphere")]
    root = bpy.data.objects.new(f"root:{path}", None)
    bpy.context.scene.collection.objects.link(root)
    for obj in objects:
        if obj.parent is None:
            obj.parent = root
    for obj in objects:
        if obj.name.startswith("Icosphere"):
            obj.hide_render = True
    return root, meshes


def bounds(meshes):
    bpy.context.view_layer.update()
    points = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
    low = Vector([min(p[i] for p in points) for i in range(3)])
    high = Vector([max(p[i] for p in points) for i in range(3)])
    return low, high


def mesh_stats(meshes):
    triangles = vertices = loose = non_manifold = 0
    uvs = colors = textures = False
    for obj in meshes:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.triangulate(bm, faces=bm.faces)
        triangles += len(bm.faces)
        vertices += len(bm.verts)
        non_manifold += sum(1 for edge in bm.edges if not edge.is_manifold)
        seen = set()
        for face in bm.faces:
            if face.index in seen:
                continue
            loose += 1
            stack = [face]
            while stack:
                current = stack.pop()
                if current.index in seen:
                    continue
                seen.add(current.index)
                for edge in current.edges:
                    stack.extend(f for f in edge.link_faces if f.index not in seen)
        bm.free()
        uvs = uvs or len(obj.data.uv_layers) > 0
        colors = colors or len(obj.data.color_attributes) > 0
        textures = textures or any(slot.material and slot.material.node_tree and any(n.type == "TEX_IMAGE" for n in slot.material.node_tree.nodes)
                                   for slot in obj.material_slots)
    return {"triangles": triangles, "vertices": vertices, "looseParts": loose, "nonManifoldEdges": non_manifold,
            "hasUVs": uvs, "hasVertexColors": colors, "hasTextures": textures}


def setup_mask_scene():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "SINGLE"
    scene.display.shading.single_color = (1, 1, 1)
    scene.render.film_transparent = True
    scene.render.image_settings.color_mode = "RGBA"
    camera = bpy.data.objects.new("mask-camera", bpy.data.cameras.new("mask-camera"))
    camera.data.type = "ORTHO"
    scene.collection.objects.link(camera)
    scene.camera = camera
    return camera


def mask(camera, objects, hidden, centre, extent, direction, size, path):
    scene = bpy.context.scene
    for obj in hidden:
        obj.hide_render = True
    for obj in objects:
        obj.hide_render = False
    d = Vector(direction).normalized()
    camera.location = centre + d * extent * 4
    camera.rotation_euler = (-d).to_track_quat("-Z", "Y" if abs(d.z) < .9 else "X").to_euler()
    camera.data.ortho_scale = extent * 1.2
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(path)
    pixels = numpy.empty(size * size * 4, dtype=numpy.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels.reshape(-1, 4)[:, 3] > .5


def iou(a, b):
    union = numpy.logical_or(a, b).sum()
    return float(numpy.logical_and(a, b).sum() / union) if union else 0.0


def main():
    gt_path, candidate_path, out_json, beauty, distance = sys.argv[sys.argv.index("--") + 1:]
    distance = float(distance)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    gt_root, gt_meshes = import_objects(gt_path)
    candidate_root, candidate_meshes = import_objects(candidate_path)
    low, high = bounds(gt_meshes)
    centre, size = (low + high) / 2, high - low
    extent = max(size)
    camera = setup_mask_scene()
    scratch = out_json + ".mask.png"
    gt_masks = {name: mask(camera, gt_meshes, candidate_meshes, centre, extent, d, COARSE, scratch) for name, d in VIEWS.items()}

    def place(rotation):
        candidate_root.matrix_world = Matrix.Identity(4)
        candidate_root.rotation_euler = rotation
        bpy.context.view_layer.update()
        c_low, c_high = bounds(candidate_meshes)
        scale = size.z / max(c_high.z - c_low.z, 1e-6)
        c_centre = (c_low + c_high) / 2
        candidate_root.matrix_world = (Matrix.Translation(centre) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-c_centre)
                                       @ candidate_root.matrix_world)
        bpy.context.view_layer.update()

    best, best_score = None, -1.0
    tilts = [(0, 0), (math.pi / 2, 0), (-math.pi / 2, 0), (math.pi, 0), (0, math.pi / 2), (0, -math.pi / 2)]
    for tx, ty in tilts:
        for yaw in range(8):
            rotation = Euler((tx, ty, yaw * math.pi / 4))
            place(rotation)
            score = numpy.mean([iou(gt_masks[v], mask(camera, candidate_meshes, gt_meshes, centre, extent, VIEWS[v], COARSE, scratch))
                                for v in ("front", "left", "top")])
            if score > best_score:
                best, best_score = rotation, score
    place(best)
    per_view = {}
    for name, d in VIEWS.items():
        a = mask(camera, gt_meshes, candidate_meshes, centre, extent, d, FINE, scratch)
        b = mask(camera, candidate_meshes, gt_meshes, centre, extent, d, FINE, scratch)
        per_view[name] = round(iou(a, b), 4)
    metrics = {
        "silhouetteIoU": per_view, "meanSilhouetteIoU": round(float(numpy.mean(list(per_view.values()))), 4),
        "alignment": {"eulerXYZ": [round(v, 4) for v in best]},
        "groundTruth": mesh_stats(gt_meshes), "candidate": mesh_stats(candidate_meshes),
    }
    # Gameplay-distance beauty render: ground truth on the left, candidate on the right. A candidate that carries only
    # vertex colours is shown with them (the glTF importer does not wire COLOR_0 into the material).
    for obj in candidate_meshes:
        if obj.data.color_attributes and not mesh_stats([obj])["hasTextures"]:
            shaded = bpy.data.materials.new("vertex-colour")
            shaded.use_nodes = True
            attribute = shaded.node_tree.nodes.new("ShaderNodeVertexColor")
            attribute.layer_name = obj.data.color_attributes[0].name
            shaded.node_tree.links.new(attribute.outputs["Color"], shaded.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
            obj.data.materials.clear()
            obj.data.materials.append(shaded)
    scene = bpy.context.scene
    for obj in gt_meshes + candidate_meshes:
        obj.hide_render = False
    gt_root.location.x -= extent * .65
    candidate_root.matrix_world = Matrix.Translation((extent * .65, 0, 0)) @ candidate_root.matrix_world
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.cycles.device = "CPU"
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGB"
    scene.render.resolution_x, scene.render.resolution_y = 960, 540
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("beauty")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (.62, .68, .76, 1)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(45), 0, math.radians(-35))
    scene.collection.objects.link(sun)
    view = bpy.data.objects.new("view", bpy.data.cameras.new("view"))
    view.data.lens = 35
    scene.collection.objects.link(view)
    scene.camera = view
    target = centre
    view.location = target + Vector((0, -1, .45)).normalized() * distance
    view.rotation_euler = (target - view.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = beauty
    bpy.ops.render.render(write_still=True)
    with open(out_json, "w") as handle:
        json.dump(metrics, handle, indent=1)


main()
