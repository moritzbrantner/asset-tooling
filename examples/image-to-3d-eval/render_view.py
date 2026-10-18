"""Render the prepared input view of a ground-truth asset for image-to-3D (#122).

    blender --background --factory-startup --python examples/image-to-3d-eval/render_view.py -- \
        <asset.gltf> <out.png> <rgb|rgba>

The asset is framed from the front-left at eye height, filling 85 % of a 512 x 512 image. ``rgb`` composites it
over 50 % grey, which is TripoSR's prepared-input convention. ``rgba`` keeps a transparent background, for
providers that take RGBA such as Stable Fast 3D.
"""
import math
import sys

import bpy
import numpy
from mathutils import Vector

SIZE = 512


def main():
    path, out, media = sys.argv[sys.argv.index("--") + 1:]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.name.startswith("Icosphere")]
    corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    low = Vector([min(c[i] for c in corners) for i in range(3)])
    high = Vector([max(c[i] for c in corners) for i in range(3)])
    centre, extent = (low + high) / 2, max(high - low)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.device = "CPU"
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("eval")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (.8, .8, .8, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = .7
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(45), 0, math.radians(-35))
    scene.collection.objects.link(sun)
    camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = extent / .85
    scene.collection.objects.link(camera)
    scene.camera = camera
    # Front-left, slightly above: the asset's front faces -Y in Blender (glTF +Z).
    direction = Vector((.5, -1, .35)).normalized()
    camera.location = centre + direction * extent * 4
    camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = out
    scene.render.image_settings.color_mode = "RGBA"
    bpy.ops.render.render(write_still=True)
    if media == "rgb":
        # Composite over 50 % grey, so the RGB image matches TripoSR's prepared input.
        image = bpy.data.images.load(out)
        pixels = numpy.empty(SIZE * SIZE * 4, dtype=numpy.float32)
        image.pixels.foreach_get(pixels)
        pixels = pixels.reshape(-1, 4)
        alpha = pixels[:, 3:4]
        pixels[:, :3] = pixels[:, :3] * alpha + .5 * (1 - alpha)
        pixels[:, 3] = 1
        flat = bpy.data.images.new("flat", SIZE, SIZE, alpha=False)
        flat.pixels.foreach_set(pixels.ravel())
        flat.filepath_raw = out
        flat.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGB"
        flat.save_render(out, scene=scene)


main()
