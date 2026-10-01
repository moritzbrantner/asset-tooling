"""Static self-contained core-glTF derivatives; invoke through the validated public recipe."""
import math
import sys
import struct
from array import array
from pathlib import Path
from types import ModuleType



def exact_object(value, keys, label):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError(f"invalid {label} fields")
    return value


def bounded(value, minimum, maximum, label):
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"invalid {label}")
    return value


def vector(value, minimum, maximum, label):
    if type(value) is not list or len(value) != 3:
        raise ValueError(f"invalid {label}")
    return [bounded(coordinate, minimum, maximum, label) for coordinate in value]


def direction(value, label):
    result = vector(value, -1000, 1000, label)
    if math.hypot(*result) < 0.000001:
        raise ValueError(f"zero {label}")
    return result


def validate_arguments(arguments):
    keys = ("schemaVersion", "width", "height", "projection", "selection", "viewDirection", "padding",
            "lightDirection", "lightEnergy", "lightSize", "worldColor", "worldStrength", "background", "exposure", "samples", "seed")
    if type(arguments) is dict and "framing" in arguments:
        keys += ("framing",)
    p = exact_object(arguments, keys, "render")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("static render requires version 1")
    for key, minimum, maximum in (("width", 1, 1024), ("height", 1, 1024), ("samples", 1, 64), ("seed", 0, 2147483647)):
        if type(p[key]) is not int or not minimum <= p[key] <= maximum:
            raise ValueError(f"invalid {key}")
    projection = p["projection"]
    exact_object(projection, ("type", "horizontalFovDegrees") if type(projection) is dict and projection.get("type") == "perspective" else ("type",), "projection")
    if projection["type"] == "perspective":
        bounded(projection["horizontalFovDegrees"], 10, 100, "horizontalFovDegrees")
    elif projection["type"] != "orthographic":
        raise ValueError("unsupported projection")
    selection = p["selection"]
    exact_object(selection, ("type", "names") if type(selection) is dict and selection.get("type") == "nodes" else ("type",), "selection")
    if selection["type"] == "nodes":
        names = selection["names"]
        if (type(names) is not list or not 1 <= len(names) <= 64 or
                any(type(name) is not str or not 1 <= len(name.encode("utf-16-le", errors="surrogatepass")) // 2 <= 256 for name in names) or
                len(set(names)) != len(names)):
            raise ValueError("invalid selection.names")
    elif selection["type"] != "scene":
        raise ValueError("unsupported selection")
    view = direction(p["viewDirection"], "viewDirection")
    if abs(view[1]) / math.hypot(*view) > 0.999:
        raise ValueError("viewDirection is parallel to source up")
    direction(p["lightDirection"], "lightDirection")
    vector(p["worldColor"], 0, 1, "worldColor")
    for key, minimum, maximum in (("padding", 0, 0.4), ("lightEnergy", 1, 10000), ("lightSize", 0.01, 10),
                                  ("worldStrength", 0, 2), ("exposure", -4, 4)):
        bounded(p[key], minimum, maximum, key)
    if p["background"] not in ("transparent", "opaque"):
        raise ValueError("unsupported background")
    if "framing" in p:
        framing = exact_object(p["framing"], ("type", "center", "horizontalSpan", "pivot"), "framing")
        if framing["type"] != "shared-orthographic" or projection["type"] != "orthographic":
            raise ValueError("shared framing requires orthographic projection")
        vector(framing["center"], -100000, 100000, "framing.center")
        vector(framing["pivot"], -100000, 100000, "framing.pivot")
        bounded(framing["horizontalSpan"], 0.000001, 100000, "framing.horizontalSpan")
    return p


def image_dimensions(data, mime_type):
    # Header-only budget inspection; Blender remains the image decoder.
    if mime_type == "image/png":
        if len(data) < 33 or bytes(data[:8]) != b"\x89PNG\r\n\x1a\n" or bytes(data[12:16]) != b"IHDR" or struct.unpack_from(">I", data, 8)[0] != 13:
            raise ValueError("invalid embedded PNG header")
        return struct.unpack_from(">II", data, 16)
    if mime_type == "image/jpeg" and bytes(data[:2]) == b"\xff\xd8":
        offset = 2
        while offset < len(data):
            if data[offset] != 0xff:
                break
            while offset < len(data) and data[offset] == 0xff:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in (0xd9, 0xda):  # End or scan data without a recognized frame header.
                break
            if marker == 0x01 or 0xd0 <= marker <= 0xd8:
                continue
            if offset + 2 > len(data):
                break
            length = struct.unpack_from(">H", data, offset)[0]
            if length < 2 or offset + length > len(data):
                break
            if marker in (0xc0, 0xc1, 0xc2) and length >= 8:
                height, width = struct.unpack_from(">HH", data, offset + 3)
                return width, height
            offset += length
    raise ValueError("unknown embedded image dimensions")


def validate_source(source_path, parameters):
    from io_scene_gltf2.io.imp.gltf2_io_gltf import glTFImporter
    # Reuse Blender's GLB/JSON parser without loading URIs or decoding accessors/images.
    with open(source_path, "rb") as source:
        content = source.read(64 * 1024 * 1024 + 1)
    if len(content) > 64 * 1024 * 1024:
        raise ValueError("render source exceeds 64 MiB budget")
    parser = glTFImporter(source_path, {"import_user_extensions": []})
    raw, binary = parser.load_glb(memoryview(content))
    parser.check_version(raw)

    def no_extensions(value):
        if type(value) is list:
            for child in value:
                no_extensions(child)
        elif type(value) is dict:
            for key, child in value.items():
                if key in ("extensions", "extensionsUsed", "extensionsRequired") and child:
                    raise ValueError("render source contains unsupported extensions")
                if key != "extras":
                    no_extensions(child)

    def array(key):
        value = raw.get(key, [])
        if type(value) is not list or any(type(item) is not dict for item in value):
            raise ValueError(f"invalid source {key}")
        return value

    def integer(value, minimum, maximum, label):
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError(f"invalid source {label} budget")
        return value

    no_extensions(raw)
    buffers, views, accessors = array("buffers"), array("bufferViews"), array("accessors")
    nodes, meshes, scenes = array("nodes"), array("meshes"), array("scenes")
    if len(buffers) != 1 or binary is None or "uri" in buffers[0]:
        raise ValueError("render source must be a self-contained GLB without resource URIs")
    byte_length = integer(buffers[0].get("byteLength"), 1, len(binary), "buffer length")
    if len(binary) - byte_length > 3:
        raise ValueError("invalid source buffer padding")
    if len(scenes) != 1 or not nodes or len(nodes) > 4096 or not meshes:
        raise ValueError("render source exceeds scene/node budget")
    if array("skins") or array("animations") or any("skin" in node for node in nodes):
        raise ValueError("render source must be static without skins or animations")
    for view in views:
        if view.get("buffer") != 0:
            raise ValueError("invalid source buffer view")
        offset = integer(view.get("byteOffset", 0), 0, byte_length, "buffer view offset")
        length = integer(view.get("byteLength"), 1, byte_length, "buffer view length")
        if offset + length > byte_length:
            raise ValueError("source buffer view exceeds available bytes")

    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
    decoded_bytes = 0
    for accessor in accessors:
        count = integer(accessor.get("count"), 1, 3000000, "accessor count")
        if accessor.get("type") not in components:
            raise ValueError("invalid source accessor type")
        decoded_bytes += count * components[accessor["type"]] * 4
        if decoded_bytes > 64 * 1024 * 1024:
            raise ValueError("render accessors exceed decoded memory budget")

    def accessor_count(index):
        return accessors[integer(index, 0, len(accessors) - 1, "accessor index")]["count"]

    positions, mesh_triangles = set(), []
    for mesh in meshes:
        primitives = mesh.get("primitives")
        if type(primitives) is not list or not primitives:
            raise ValueError("render source requires mesh primitives")
        triangles = 0
        for primitive in primitives:
            if type(primitive) is not dict or primitive.get("mode", 4) != 4 or primitive.get("targets"):
                raise ValueError("render source requires non-morph triangles")
            attributes = primitive.get("attributes")
            if type(attributes) is not dict or "POSITION" not in attributes:
                raise ValueError("render source requires POSITION")
            position = attributes["POSITION"]
            accessor_count(position)
            positions.add(position)
            triangles += accessor_count(primitive.get("indices", position)) / 3
        mesh_triangles.append(triangles)
    if sum(accessor_count(index) for index in positions) > 1000000 or sum(mesh_triangles) > 1000000:
        raise ValueError("render source exceeds vertex/triangle budget")
    selection = parameters["selection"]
    if selection["type"] == "nodes":
        for name in selection["names"]:
            matches = [node for node in nodes if node.get("name") == name]
            if len(matches) != 1 or "mesh" not in matches[0]:
                raise ValueError("selected source mesh node must be unique")
    instances = 0
    for node in nodes:
        if "mesh" in node:
            index = integer(node["mesh"], 0, len(meshes) - 1, "mesh index")
            if selection["type"] == "scene" or node.get("name") in selection["names"]:
                instances += mesh_triangles[index]
    if instances > 1000000:
        raise ValueError("render selection exceeds instantiated triangle budget")
    pixels = 0
    for image in array("images"):
        if "uri" in image:
            raise ValueError("render source image must be embedded without resource URIs")
        view = views[integer(image.get("bufferView"), 0, len(views) - 1, "image buffer view")]
        offset = view.get("byteOffset", 0)
        width, height = image_dimensions(binary[offset:offset + view["byteLength"]], image.get("mimeType"))
        integer(width, 1, 4096, "texture width")
        integer(height, 1, 4096, "texture height")
        pixels += width * height
        if pixels > 16777216:
            raise ValueError("render textures exceed decoded pixel budget")
    return raw


def constant_invisible_material(material):
    # Texture alpha cannot exceed one. Cull only when the declared factor/mode proves
    # no fragment can contribute; OPAQUE and MASK cutoff zero must remain visible.
    factor = material.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])
    if type(factor) is not list or len(factor) != 4:
        return False
    alpha = factor[3]
    if type(alpha) not in (int, float) or not math.isfinite(alpha) or not 0 <= alpha <= 1:
        return False
    mode = material.get("alphaMode", "OPAQUE")
    if mode == "BLEND":
        return alpha == 0
    if mode == "MASK":
        cutoff = material.get("alphaCutoff", 0.5)
        return type(cutoff) in (int, float) and math.isfinite(cutoff) and 0 <= cutoff <= 1 and alpha < cutoff
    return False


def generate(output_path, arguments, inputs):
    p = validate_arguments(arguments)
    if set(inputs) != {"source"}:
        raise ValueError("static render requires exactly one source input")
    # Validation precedes importing Blender modules or touching source/output state.
    import bpy
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector

    source = validate_source(inputs["source"], p)
    materials = source.get("materials", [])
    invisible_meshes = {index for index, mesh in enumerate(source["meshes"])
                       if all("material" in primitive and constant_invisible_material(materials[primitive["material"]])
                              for primitive in mesh["primitives"])}

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    # The supported glTF import extension hook binds original nodes to actual objects. Object
    # names can be truncated or disambiguated by Blender and are not source-node identifiers.
    imported_nodes = {}

    class NodeIdentity:
        is_critical = True

        def gather_import_node_after_hook(self, vnode, gltf_node, obj, gltf):
            if gltf_node is not None and obj is not None and obj.type == "MESH":
                imported_nodes.setdefault(gltf_node.name, []).append(obj)
                # Skipping provably invisible objects avoids Cycles' finite transparent-ray
                # limit turning dense zero-alpha layers black. Keep their geometry for bounds.
                if gltf_node.mesh in invisible_meshes:
                    obj.hide_render = True

    extension_name = "asset_tooling_render_node_identity"
    extension_module = ModuleType(extension_name)
    extension_module.glTF2ImportUserExtension = NodeIdentity
    sys.modules[extension_name] = extension_module
    extension_addon = bpy.context.preferences.addons.new()
    extension_addon.module = extension_name
    try:
        bpy.ops.import_scene.gltf(filepath=inputs["source"])
    finally:
        bpy.context.preferences.addons.remove(extension_addon)
        del sys.modules[extension_name]
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    selection = p["selection"]
    if selection["type"] == "nodes":
        names = selection["names"]
        if any(len(imported_nodes.get(name, [])) != 1 for name in names):
            raise ValueError("selected mesh nodes were not uniquely imported")
        meshes = [imported_nodes[name][0] for name in names]
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
    source_diagonal = diagonal
    framing = p.get("framing")
    if framing:
        # A declared world-space target/span locks scale and framing across
        # independent states/directions. No source bounds are rewritten.
        center = Vector((framing["center"][0], -framing["center"][2], framing["center"][1]))
        diagonal = framing["horizontalSpan"] * max(1, p["height"] / p["width"])

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
    if max(point.x for point in local) - min(point.x for point in local) < source_diagonal * 1e-8 or max(point.y for point in local) - min(point.y for point in local) < source_diagonal * 1e-8:
        raise ValueError("source has degenerate projected bounds from this view")
    aspect = p["width"] / p["height"]
    usable = 1 - 2 * p["padding"]
    if p["projection"]["type"] == "orthographic":
        camera.data.type = "ORTHO"
        half_width = max(abs(point.x) for point in local)
        half_height = max(abs(point.y) for point in local)
        camera.data.ortho_scale = framing["horizontalSpan"] if framing else max(half_width * 2, half_height * 2 * aspect) / usable
        distance = max(diagonal * 2, max(point.z for point in local) + diagonal)
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
    camera.data.clip_start = max(1e-8, min(diagonal, source_diagonal) * 1e-5)
    camera.data.clip_end = max(1, distance - min(point.z for point in local) + max(diagonal, source_diagonal) * 4) if framing else max(1, distance + diagonal * 4)
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
    pivot = {"x": p["width"] / 2, "y": p["height"] / 2}
    if framing:
        point = framing["pivot"]
        projected_pivot = world_to_camera_view(scene, camera, Vector((point[0], -point[2], point[1])))
        if projected_pivot.z <= 0 or not (-1e-5 <= projected_pivot.x <= 1 + 1e-5 and -1e-5 <= projected_pivot.y <= 1 + 1e-5):
            raise ValueError("logical pivot falls outside the shared frame")
        pivot = {"x": min(p["width"], max(0, projected_pivot.x * p["width"])),
                 "y": min(p["height"], max(0, (1 - projected_pivot.y) * p["height"]))}

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
    observations = {"recipe": "static-glb-render-v1", "renderer": "blender-cycles-cpu", "width": p["width"], "height": p["height"],
            "pivot": pivot, "projection": p["projection"], "padding": p["padding"],
            "projectedBounds": projected_bounds, "meshCount": len(meshes), "materialCount": len({m for obj in meshes for m in obj.data.materials if m}),
            "colorSpace": "srgb", "alphaMode": "straight", "background": p["background"], "viewDirection": p["viewDirection"],
            "samples": p["samples"], "seed": p["seed"], "sourceBoundsBlenderZUp": {"min": list(low), "max": list(high)}}
    if framing:
        observations["framing"] = {**framing, "coordinateSpace": "gltf-world-y-up",
                                   "worldUnitsPerPixel": framing["horizontalSpan"] / p["width"], "trimOffset": {"x": 0, "y": 0}}
    return observations
