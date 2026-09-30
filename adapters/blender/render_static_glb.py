"""Static self-contained core-glTF derivatives; invoke through the validated public recipe."""
import math
from array import array
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


def generate(output_path, arguments, inputs):
    p = arguments
    if p["schemaVersion"] != 1 or set(inputs) != {"source"}:
        raise ValueError("static render requires version 1 and exactly one source input")
    for key, minimum, maximum in (("width", 1, 1024), ("height", 1, 1024), ("samples", 1, 64), ("seed", 0, 2147483647)):
        if type(p[key]) is not int or not minimum <= p[key] <= maximum:
            raise ValueError(f"invalid {key}")
    if p["projection"]["type"] not in ("orthographic", "perspective") or p["background"] not in ("transparent", "opaque"):
        raise ValueError("unsupported projection/background")
    if not 0 <= p["padding"] <= 0.4:
        raise ValueError("invalid padding")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=inputs["source"])
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    selection = p["selection"]
    if selection["type"] == "nodes":
        names = selection["names"]
        meshes = [obj for obj in meshes if obj.name in names]
        if len(meshes) != len(names):
            raise ValueError("selected mesh nodes were not uniquely imported")
    elif selection["type"] != "scene":
        raise ValueError("unsupported selection")
    if not meshes or any(obj.modifiers for obj in meshes):
        raise ValueError("static render needs nonempty unmodified mesh geometry")
    selected = set(meshes)
    for obj in list(bpy.context.scene.objects):
        # Retain imported hierarchy/transforms. Only selected meshes contribute pixels; source
        # cameras/lights are hidden so render settings never inherit ambient authoring state.
        if obj.type != "EMPTY" and obj not in selected:
            obj.hide_render = True
    corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    if not all(math.isfinite(component) for point in corners for component in point):
        raise ValueError("non-finite source bounds")
    low = Vector(tuple(min(point[axis] for point in corners) for axis in range(3)))
    high = Vector(tuple(max(point[axis] for point in corners) for axis in range(3)))
    diagonal = (high - low).length
    if diagonal < 1e-8 or diagonal > 1e6:
        raise ValueError("empty or excessive source bounds")
    center = (low + high) * 0.5

    # The public camera/light directions are glTF right-handed Y-up; Blender is Z-up.
    def blender_direction(value):
        direction = Vector((value[0], -value[2], value[1]))
        if direction.length < 1e-6:
            raise ValueError("zero direction")
        return direction.normalized()

    direction = blender_direction(p["viewDirection"])
    if abs(direction.z) > 0.999:
        raise ValueError("camera is parallel to source up")
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    camera.data.sensor_fit = "HORIZONTAL"
    local = [camera.rotation_euler.to_matrix().transposed() @ (point - center) for point in corners]
    if max(point.x for point in local) - min(point.x for point in local) < diagonal * 1e-8 or max(point.y for point in local) - min(point.y for point in local) < diagonal * 1e-8:
        raise ValueError("source has degenerate projected bounds from this view")
    aspect = p["width"] / p["height"]
    usable = 1 - 2 * p["padding"]
    if p["projection"]["type"] == "orthographic":
        camera.data.type = "ORTHO"
        half_width = max(abs(point.x) for point in local)
        half_height = max(abs(point.y) for point in local)
        camera.data.ortho_scale = max(half_width * 2, half_height * 2 * aspect) / usable
        distance = diagonal * 2
    else:
        fov = p["projection"]["horizontalFovDegrees"]
        if not 10 <= fov <= 100:
            raise ValueError("invalid perspective field of view")
        tangent = math.tan(math.radians(fov) / 2)
        camera.data.type = "PERSP"
        camera.data.sensor_width = 36
        camera.data.lens = 36 / (2 * tangent)
        distance = max(max(abs(point.x) / (tangent * usable), abs(point.y) * aspect / (tangent * usable)) + point.z for point in local) + diagonal * 0.001
    camera.location = center + direction * distance
    camera.data.clip_start = max(1e-8, diagonal * 1e-5)
    camera.data.clip_end = max(1, distance + diagonal * 4)
    scene = bpy.context.scene
    scene.camera = camera
    scene.render.resolution_x = p["width"]
    scene.render.resolution_y = p["height"]
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
    bpy.context.view_layer.update()
    projected = [world_to_camera_view(scene, camera, point) for point in corners]
    if any(point.z <= 0 for point in projected):
        raise ValueError("camera framing puts source behind the near plane")
    projected_bounds = {"left": min(point.x for point in projected), "right": max(point.x for point in projected),
                        "top": 1 - max(point.y for point in projected), "bottom": 1 - min(point.y for point in projected)}
    if min(projected_bounds["left"], projected_bounds["top"], 1 - projected_bounds["right"], 1 - projected_bounds["bottom"]) < p["padding"] - 1e-5:
        raise ValueError("camera framing clips the declared padded bounds")

    bpy.ops.object.light_add(type="AREA")
    light = bpy.context.object
    light.location = center + blender_direction(p["lightDirection"]) * diagonal * 2
    light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
    # Reference watts for a one-meter source diagonal; scale flux with area to preserve
    # illumination when source units/size differ, rather than overexpose small catalog models.
    light.data.energy = p["lightEnergy"] * diagonal * diagonal
    light.data.shape = "DISK"
    light.data.size = diagonal * p["lightSize"]
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (*p["worldColor"], 1)
    background.inputs["Strength"].default_value = p["worldStrength"]
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = p["samples"]
    scene.cycles.seed = p["seed"]
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.use_denoising = False
    scene.render.film_transparent = p["background"] == "transparent"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 90
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = p["exposure"]
    scene.view_settings.gamma = 1
    scene.render.use_stamp = False
    native_path = Path(output_path).with_name("render-native.png")
    scene.render.filepath = str(native_path)
    try:
        bpy.ops.render.render(write_still=True)
        # Native render PNGs carry wall-clock and Cycles timing metadata independently of visible
        # stamps. Use Blender's own image API to copy the baked sRGB RGBA8 pixels into a fresh
        # byte image and save without render metadata. This performs no second tone transform.
        native = bpy.data.images.load(str(native_path), check_existing=False)
        pixels = array("f", [0]) * len(native.pixels)
        native.pixels.foreach_get(pixels)
        clean = bpy.data.images.new("metadata-free-render", width=p["width"], height=p["height"], alpha=True, float_buffer=False)
        clean.alpha_mode = "STRAIGHT"
        clean.colorspace_settings.name = "sRGB"
        clean.pixels.foreach_set(pixels)
        clean.file_format = "PNG"
        clean.filepath_raw = output_path
        clean.save()
        bpy.data.images.remove(clean)
        bpy.data.images.remove(native)
    finally:
        native_path.unlink(missing_ok=True)
    return {"recipe": "static-glb-render-v1", "renderer": "blender-cycles-cpu", "width": p["width"], "height": p["height"],
            "pivot": {"x": p["width"] / 2, "y": p["height"] / 2}, "projection": p["projection"], "padding": p["padding"],
            "projectedBounds": projected_bounds, "meshCount": len(meshes), "materialCount": len({m for obj in meshes for m in obj.data.materials if m}),
            "colorSpace": "srgb", "alphaMode": "straight", "background": p["background"], "viewDirection": p["viewDirection"],
            "samples": p["samples"], "seed": p["seed"], "sourceBoundsBlenderZUp": {"min": list(low), "max": list(high)}}
