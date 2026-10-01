"""Example-only native placement of a saved static master and cosmetic instance subset."""
import json
import math
import struct
from pathlib import Path


def generate(output_path, arguments, inputs):
    if set(arguments) != {"schemaVersion", "width", "depth", "scale", "maxTriangles"} or arguments["schemaVersion"] != 1 or set(inputs) != {"master", "instances", "guide"}:
        raise ValueError("instance review requires only the declared placement, master and mask inputs")
    for name, low, high in [("width", 1, 100), ("depth", 1, 100), ("scale", .01, 2), ("maxTriangles", 2, 200000)]:
        value = arguments[name]
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError("invalid instance review control " + name)
    if type(arguments["maxTriangles"]) is not int:
        raise ValueError("maxTriangles must be integer")
    source = json.loads(Path(inputs["instances"]).read_text("utf8"))
    if source["schemaVersion"] != 1 or source["coordinateSystem"] != "right-handed-y-up" or source["coordinateQuantization"] != "1e-6-unit":
        raise ValueError("unexpected instance transport")
    if source["bounds"] != {"widthMicro": arguments["width"] * 1000000, "depthMicro": arguments["depth"] * 1000000} or not 0 <= len(source["instances"]) <= 64:
        raise ValueError("unexpected review footprint/count")
    master_bytes = Path(inputs["master"]).read_bytes()
    if len(master_bytes) > 64 * 1024 * 1024 or len(master_bytes) < 28:
        raise ValueError("master GLB exceeds source budget")
    magic, version, total, length, chunk = struct.unpack_from("<IIIII", master_bytes)
    if magic != 0x46546C67 or version != 2 or total != len(master_bytes) or chunk != 0x4E4F534A or length > total - 20:
        raise ValueError("invalid master GLB header")
    document = json.loads(master_bytes[20:20 + length])
    if document.get("skins") or document.get("animations") or document.get("extensionsUsed") or any("uri" in item for table in ["buffers", "images"] for item in document.get(table, [])):
        raise ValueError("review master must be static and resource-contained")
    guide = Path(inputs["guide"]).read_bytes()
    if len(guide) > 8 * 1024 * 1024 or guide[:8] != b"\x89PNG\r\n\x1a\n" or len(guide) < 24 or guide[12:16] != b"IHDR" or any(not 1 <= size <= 256 for size in struct.unpack_from(">II", guide, 16)):
        raise ValueError("guide requires a bounded PNG header")
    import bpy
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=inputs["master"])
    originals = list(bpy.context.scene.objects)
    masters = [obj for obj in originals if obj.type == "MESH"]
    if len(masters) != 1:
        raise ValueError("review requires one static rock mesh")
    master = masters[0]
    master.data.calc_loop_triangles()
    if len(master.data.loop_triangles) * len(source["instances"]) + 2 > arguments["maxTriangles"]:
        raise ValueError("instance review exceeds triangle budget")
    master_triangles = len(master.data.loop_triangles)
    ids = set()
    for instance in source["instances"]:
        identifier, position = instance["id"], instance["positionMicro"]
        if not isinstance(identifier, str) or not identifier or identifier in ids or identifier == "review-ground" or len(position) != 3 or any(type(v) is not int for v in position):
            raise ValueError("invalid instance identity/position")
        ids.add(identifier)
        x, y, z = position
        if y != 0 or not -source["bounds"]["widthMicro"] // 2 <= x < source["bounds"]["widthMicro"] // 2 or not -source["bounds"]["depthMicro"] // 2 <= z < source["bounds"]["depthMicro"] // 2:
            raise ValueError("review supports only flat saved cosmetic positions in the declared footprint")
        clone = master.copy()
        # Linked native data preserves one reusable master, independent of placement count.
        clone.data = master.data
        bpy.context.scene.collection.objects.link(clone)
        clone.parent = None
        clone.matrix_world = master.matrix_world.copy()
        clone.name = identifier
        clone.scale *= arguments["scale"]
        # glTF Y-up to Blender Z-up, without evaluating or resampling the saved positions.
        from mathutils import Vector
        clone.location += Vector((x / 1000000, -z / 1000000, y / 1000000))
    for obj in originals:
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.mesh.primitive_plane_add(size=2)
    ground = bpy.context.object
    ground.name = "review-ground"
    ground.scale = ((arguments["width"] + 1 - .000001) / 2, (arguments["depth"] + 1 - .000001) / 2, 1)
    # A half-meter review border contains every scaled source rock and fixes framing.
    ground.location = (-.0000005, .0000005, 0)
    material = bpy.data.materials.new("saved-exclusion-guide")
    if material.node_tree is None:
        material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Roughness"].default_value = 1
    image = bpy.data.images.load(inputs["guide"], check_existing=False)
    image.colorspace_settings.name = "sRGB"
    texture = material.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image, texture.interpolation, texture.extension = image, "Closest", "EXTEND"
    material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    w, h = image.size
    # Native nearest sampling uses pixel centers; map the saved endpoint lattice
    # into those centers rather than silently changing the filter's world domain.
    for loop in ground.data.uv_layers.active.data:
        u = (loop.uv.x * (arguments["width"] + 1 - .000001) - .5) / (arguments["width"] - .000001)
        loop.uv.x = (u * (w - 1) + .5) / w
        v = (loop.uv.y * (arguments["depth"] + 1 - .000001) - .5) / (arguments["depth"] - .000001)
        loop.uv.y = (v * (h - 1) + .5) / h
    ground.data.materials.append(material)
    bpy.ops.export_scene.gltf(filepath=output_path, export_format="GLB", export_yup=True, export_animations=False, export_cameras=False, export_lights=False)
    return {"purpose": "flat cosmetic exclusion review; no terrain/navigation policy", "unit": "meter", "sourceRockGeneratorsExecuted": 0,
            "instances": len(ids), "sourceMasterTriangles": master_triangles, "nativeMeshDataBlocks": 2,
            "positions": [{"id": i["id"], "positionMicro": i["positionMicro"]} for i in source["instances"]]}
