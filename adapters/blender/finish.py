"""Reusable asset finishing recipe (#120, Atlas Decisions 5.1.6/5.1.7): inspect -> explicit repair -> export.

Runs under ``external.blender.script@1``. One editable source (a ``.gltf``/``.glb`` with its declared resources,
or an authored ``.blend`` collection) is loaded into a factory-startup session, inspected, finished by the ordered
repairs the caller declares and exported as one self-contained GLB. The source file is only read; it is never
saved, so the source/master bytes stay untouched and the GLB is a separate derived asset.

Blender does every geometry, normal, UV and bake step itself; this file only selects and orders Blender's own
operators and records what they changed. Unsupported cases fail closed with a recorded reason instead of being
erased to make validation pass:

* an undeclared or missing resource (a glTF buffer/image URI that is not a declared input, an external image in a
  ``.blend``, a linked library);
* animation data (this recipe does not finish clips);
* ``apply-transforms`` or ``bake-ao`` on skinned or shape-keyed meshes (they would break the binding);
* ``uv-unwrap`` on a mesh that already has UVs (it would orphan the authored texture mapping);
* ``bake-ao`` on a material shared with an object outside the finished set, or without UVs;
* an empty material slot or a mesh without any material;
* an edit naming a material the source does not have;
* any UV layer, colour attribute, vertex group, shape key or material lost between inspection and export.

``generate`` returns the before/after inspection, the repairs it applied and the rejection checks it ran as the
receipt's observations.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import struct
from urllib.parse import unquote

import bmesh
import bpy

RECIPE = "finish-v1"
REPAIRS = ("apply-transforms", "merge-by-distance", "recalculate-normals", "weighted-normals", "uv-unwrap", "bake-ao")
MERGE_DISTANCE = 1e-5
UV_ISLAND_MARGIN = .02
AO = {"size": 512, "samples": 32, "distance": .1, "margin": 4}
EDIT_EPSILON = 1e-6


class FinishRejected(ValueError):
    """A declared input or repair that the recipe does not support; nothing is exported."""


def reject(message):
    raise FinishRejected(f"finish rejected: {message}")


# ---------------------------------------------------------------------------------------------- arguments


def _number(value, label, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{label} must be a finite number in {low}..{high}")
    return float(value)


def _exact_keys(value, required, optional, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    unknown = set(value) - set(required) - set(optional)
    missing = set(required) - set(value)
    if unknown or missing:
        raise ValueError(f"{label} has unknown {sorted(unknown)} or missing {sorted(missing)} keys")


def validate(arguments, inputs):
    """Check the arguments and inputs the TypeScript side normalised (src/finishing-recipe.ts) before any scene
    mutation."""
    _exact_keys(arguments, ("schemaVersion", "source", "edits", "repairs", "policy"), (), "arguments")
    if arguments["schemaVersion"] != 1:
        raise ValueError("schemaVersion must be 1")
    source = arguments["source"]
    _exact_keys(source, ("format",), ("collection",), "source")
    if source["format"] not in ("gltf", "blend"):
        raise ValueError("source.format must be gltf or blend")
    if (source["format"] == "blend") != ("collection" in source):
        raise ValueError("source.collection is required for, and only for, a blend source")
    edits = arguments["edits"]
    _exact_keys(edits, ("scale", "materials"), (), "edits")
    if not isinstance(edits["scale"], list) or len(edits["scale"]) != 3:
        raise ValueError("edits.scale must be three factors")
    for axis, factor in zip("xyz", edits["scale"]):
        _number(factor, f"edits.scale.{axis}", .01, 100)
    if not isinstance(edits["materials"], dict):
        raise ValueError("edits.materials must be an object")
    for name, edit in edits["materials"].items():
        _exact_keys(edit, (), ("baseColor", "roughness", "metallic"), f"edits.materials.{name}")
        if not edit:
            raise ValueError(f"edits.materials.{name} must change something")
        if "baseColor" in edit:
            if not isinstance(edit["baseColor"], list) or len(edit["baseColor"]) != 4:
                raise ValueError(f"edits.materials.{name}.baseColor must be linear RGBA")
            for channel in edit["baseColor"]:
                _number(channel, f"edits.materials.{name}.baseColor", 0, 1)
        for key in ("roughness", "metallic"):
            if key in edit:
                _number(edit[key], f"edits.materials.{name}.{key}", 0, 1)
    repairs = arguments["repairs"]
    if not isinstance(repairs, list) or len(set(repairs)) != len(repairs) or any(r not in REPAIRS for r in repairs):
        raise ValueError(f"repairs must be unique names from {list(REPAIRS)}")
    if "bake-ao" in repairs and "uv-unwrap" in repairs and repairs.index("bake-ao") < repairs.index("uv-unwrap"):
        raise ValueError("bake-ao must follow uv-unwrap")
    policy = arguments["policy"]
    _exact_keys(policy, ("maxTriangles",), (), "policy")
    if isinstance(policy["maxTriangles"], bool) or not isinstance(policy["maxTriangles"], int) or not 1 <= policy["maxTriangles"] <= 1_000_000:
        raise ValueError("policy.maxTriangles must be an integer in 1..1000000")
    if "source" not in inputs:
        raise ValueError("the source must be the declared input 'source'")
    suffix = os.path.splitext(inputs["source"])[1].lower()
    if (source["format"] == "blend") != (suffix == ".blend") or (source["format"] == "gltf") != (suffix in (".gltf", ".glb")):
        raise ValueError(f"source.format {source['format']} does not match the source file {inputs['source']}")


# ---------------------------------------------------------------------------------------------- loading


def _gltf_uris(path):
    """Every external URI a .gltf/.glb references (buffers and images)."""
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:4] == b"glTF":
        length = struct.unpack_from("<I", data, 12)[0]
        document = json.loads(data[20:20 + length].decode("utf8"))
    else:
        document = json.loads(data.decode("utf8"))
    uris = []
    for entry in document.get("buffers", []) + document.get("images", []):
        uri = entry.get("uri")
        if uri is not None and not uri.startswith("data:"):
            uris.append(uri)
    return uris


def load_source(arguments, inputs):
    """Load the source into the empty scene and return its objects. Reads only declared inputs."""
    source = inputs["source"]
    declared = {os.path.normpath(path) for name, path in inputs.items() if name != "source"}
    if arguments["source"]["format"] == "gltf":
        base = os.path.dirname(source)
        for uri in _gltf_uris(source):
            resolved = os.path.normpath(os.path.join(base, unquote(uri)))
            if resolved not in declared:
                reject(f"source resource {uri!r} is not a declared input")
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=source)
        objects = [obj for obj in bpy.data.objects if obj not in before]
    else:
        name = arguments["source"]["collection"]
        with bpy.data.libraries.load(source, link=False) as (available, target):
            if name not in available.collections:
                reject(f"{source} has no collection {name!r}")
            target.collections = [name]
        collection = target.collections[0]
        bpy.context.scene.collection.children.link(collection)
        objects = list(collection.all_objects)
    bpy.context.view_layer.update()
    if not any(obj.type == "MESH" for obj in objects):
        reject("the source has no mesh")
    # Appending leaves the source registered as a library; reject only datablocks that are still linked from
    # somewhere else (the source's own linked libraries).
    for collection in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.node_groups):
        for block in collection:
            if block.library is not None:
                reject(f"{block.name!r} is linked from library {block.library.filepath!r}, which is not supported")
    for image in bpy.data.images:
        if image.source == "FILE" and image.packed_file is None:
            path = os.path.normpath(os.path.relpath(bpy.path.abspath(image.filepath), os.getcwd()))
            if path not in declared:
                reject(f"image {image.name!r} resolves to {path!r}, which is not a declared input")
    return objects


# ---------------------------------------------------------------------------------------------- inspection


def _round(value, digits=6):
    return round(float(value), digits) + 0.0


def _is_skinned(obj):
    return any(m.type == "ARMATURE" for m in obj.modifiers) or (obj.parent is not None and obj.parent.type == "ARMATURE")


def _mesh_report(obj):
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    non_manifold = sum(1 for edge in bm.edges if not edge.is_manifold and not edge.is_boundary)
    boundary = sum(1 for edge in bm.edges if edge.is_boundary)
    loose = sum(1 for vert in bm.verts if not vert.link_edges)
    degenerate = sum(1 for face in bm.faces if face.calc_area() < 1e-12)
    ngons = sum(1 for face in bm.faces if len(face.verts) > 4)
    triangles = sum(len(face.verts) - 2 for face in bm.faces)
    bm.free()
    translation, rotation, scale = obj.matrix_world.decompose()
    identity = abs(rotation.angle) < 1e-9 and all(abs(s - 1) < 1e-9 for s in scale)
    return {
        "name": obj.name,
        "vertices": len(mesh.vertices),
        "triangles": triangles,
        "transform": {
            # Rotation and scale only: placement (translation) belongs to scene.place.gltf@1.
            "identityRotationScale": identity,
            "translation": [_round(t) for t in translation],
            "negativeScale": obj.matrix_world.determinant() < 0,
            "scale": [_round(s) for s in scale],
        },
        "topology": {"nonManifoldEdges": non_manifold, "boundaryEdges": boundary, "looseVertices": loose,
                     "degenerateFaces": degenerate, "ngons": ngons},
        "normals": {"customSplitNormals": bool(mesh.has_custom_normals)},
        "attributes": {
            "uvLayers": sorted(layer.name for layer in mesh.uv_layers),
            "colorAttributes": sorted(attribute.name for attribute in mesh.color_attributes),
            "vertexGroups": sorted(group.name for group in obj.vertex_groups),
            "shapeKeys": sorted(key.name for key in mesh.shape_keys.key_blocks) if mesh.shape_keys else [],
        },
        "materials": [slot.material.name if slot.material else None for slot in obj.material_slots],
        "skinned": _is_skinned(obj),
    }


def _material_report(material):
    report = {"name": material.name, "users": material.users}
    principled = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if material.node_tree else None
    if principled is not None:
        base = principled.inputs["Base Color"]
        report["baseColor"] = [_round(c) for c in base.default_value]
        report["baseColorTextured"] = base.is_linked
        report["roughness"] = _round(principled.inputs["Roughness"].default_value)
        report["metallic"] = _round(principled.inputs["Metallic"].default_value)
    nodes = material.node_tree.nodes if material.node_tree else []
    report["images"] = sorted(n.image.name for n in nodes if n.type == "TEX_IMAGE" and n.image)
    return report


def inspect(objects):
    meshes = [obj for obj in objects if obj.type == "MESH"]
    materials = sorted({slot.material for obj in meshes for slot in obj.material_slots if slot.material}, key=lambda m: m.name)
    corners = [obj.matrix_world @ v.co for obj in meshes for v in obj.data.vertices]
    low = [min(c[i] for c in corners) for i in range(3)]
    high = [max(c[i] for c in corners) for i in range(3)]
    reports = [_mesh_report(obj) for obj in sorted(meshes, key=lambda o: o.name)]
    return {
        "meshes": reports,
        "materials": [_material_report(m) for m in materials],
        "triangles": sum(report["triangles"] for report in reports),
        # Blender is Z-up; report the glTF frame (+Y up) the export writes: width X, depth Y->Z, height Z->Y.
        "dimensions": {"width": _round(high[0] - low[0]), "depth": _round(high[1] - low[1]), "height": _round(high[2] - low[2])},
        "animated": any(obj.animation_data and obj.animation_data.action for obj in objects) or len(bpy.data.actions) > 0,
    }


# ---------------------------------------------------------------------------------------------- repairs


def _activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def _with_mesh_editor(obj, operation):
    _activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    operation()
    bpy.ops.object.mode_set(mode="OBJECT")


def apply_transforms(objects):
    roots = [obj for obj in objects if obj.parent is None or obj.parent not in objects]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = roots[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return {"objects": sorted(obj.name for obj in objects), "applied": ["rotation", "scale"]}


def merge_by_distance(meshes):
    merged = {}
    for obj in meshes:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        before = len(bm.verts)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=MERGE_DISTANCE)
        bm.to_mesh(obj.data)
        bm.free()
        merged[obj.name] = before - len(obj.data.vertices)
    return {"distance": MERGE_DISTANCE, "mergedVertices": merged}


def recalculate_normals(meshes):
    for obj in meshes:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(obj.data)
        bm.free()
    return {"objects": sorted(obj.name for obj in meshes), "direction": "outside"}


def weighted_normals(meshes):
    for obj in meshes:
        modifier = obj.modifiers.new("finish-weighted-normals", "WEIGHTED_NORMAL")
        modifier.keep_sharp = True
        _activate(obj)
        bpy.ops.object.modifier_move_to_index(modifier=modifier.name, index=0)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    return {"objects": sorted(obj.name for obj in meshes), "keepSharp": True}


def uv_unwrap(meshes):
    for obj in meshes:
        if obj.data.uv_layers:
            reject(f"uv-unwrap on {obj.name}, which already has UV layers {[l.name for l in obj.data.uv_layers]}")
    for obj in meshes:
        obj.data.uv_layers.new(name="UVMap")
        _with_mesh_editor(obj, lambda: (bpy.ops.uv.smart_project(island_margin=UV_ISLAND_MARGIN),
                                        bpy.ops.uv.pack_islands(margin=UV_ISLAND_MARGIN)))
    return {"objects": sorted(obj.name for obj in meshes), "method": "smart-project", "islandMargin": UV_ISLAND_MARGIN}


def _gltf_output_group():
    group = bpy.data.node_groups.get("glTF Material Output")
    if group is None:
        group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    return group


def bake_ao(meshes):
    finished = set(meshes)
    for obj in meshes:
        if not obj.data.uv_layers:
            reject(f"bake-ao on {obj.name}, which has no UVs (declare uv-unwrap first)")
        if len(obj.data.uv_layers) != 1:
            reject(f"bake-ao on {obj.name}, which has {len(obj.data.uv_layers)} UV layers")
        for slot in obj.material_slots:
            users = {o for o in bpy.data.objects if o.type == "MESH" and any(s.material == slot.material for s in o.material_slots)}
            if users - finished or len(users) > 1:
                reject(f"bake-ao: material {slot.material.name!r} is shared by {sorted(o.name for o in users)}")
    scene = bpy.context.scene
    try:
        scene.render.engine = "CYCLES"
    except TypeError as error:
        reject(f"bake-ao needs Cycles: {error}")
    scene.cycles.device = "CPU"
    scene.cycles.samples = AO["samples"]
    scene.cycles.seed = 0
    scene.world = scene.world or bpy.data.worlds.new("bake")
    scene.world.light_settings.distance = AO["distance"]
    scene.render.bake.margin = AO["margin"]
    baked = []
    for obj in meshes:
        image = bpy.data.images.new(f"{obj.name}-ao", AO["size"], AO["size"], alpha=False)
        image.colorspace_settings.name = "Non-Color"
        textures = []
        for slot in obj.material_slots:
            nodes = slot.material.node_tree.nodes
            texture = nodes.new("ShaderNodeTexImage")
            texture.image = image
            nodes.active = texture
            textures.append((slot.material, texture))
        _activate(obj)
        bpy.ops.object.bake(type="AO", margin=AO["margin"], use_clear=True)
        image.filepath_raw = f"//{obj.name}-ao.png"
        image.file_format = "PNG"
        image.pack()
        for material, texture in textures:
            separate = material.node_tree.nodes.new("ShaderNodeSeparateColor")
            material.node_tree.links.new(texture.outputs["Color"], separate.inputs["Color"])
            group = material.node_tree.nodes.new("ShaderNodeGroup")
            group.node_tree = _gltf_output_group()
            material.node_tree.links.new(separate.outputs["Red"], group.inputs["Occlusion"])
        baked.append({"object": obj.name, "image": image.name, "materials": sorted(m.name for m, _ in textures)})
    return {"size": AO["size"], "samples": AO["samples"], "distance": AO["distance"], "baked": baked}


REPAIR_STEPS = {
    "apply-transforms": lambda objects, meshes: apply_transforms(objects),
    "merge-by-distance": lambda objects, meshes: merge_by_distance(meshes),
    "recalculate-normals": lambda objects, meshes: recalculate_normals(meshes),
    "weighted-normals": lambda objects, meshes: weighted_normals(meshes),
    "uv-unwrap": lambda objects, meshes: uv_unwrap(meshes),
    "bake-ao": lambda objects, meshes: bake_ao(meshes),
}


def check_repairs(repairs, before):
    """Reject declared repairs that would destroy data the source carries, before anything changes."""
    for mesh in before["meshes"]:
        if None in mesh["materials"] or not mesh["materials"]:
            reject(f"{mesh['name']} has an empty material slot or no material")
        destructive = [r for r in ("apply-transforms", "bake-ao") if r in repairs]
        if destructive and (mesh["skinned"] or mesh["attributes"]["shapeKeys"]):
            reject(f"{destructive} on {mesh['name']}, which is skinned or has shape keys")
        if "uv-unwrap" in repairs and mesh["attributes"]["uvLayers"]:
            reject(f"uv-unwrap on {mesh['name']}, which already has UV layers {mesh['attributes']['uvLayers']}")
    if before["animated"]:
        reject("the source carries animation, which this recipe does not finish")


# ---------------------------------------------------------------------------------------------- edits


def apply_edits(objects, edits):
    applied = {}
    scale = edits["scale"]
    if any(abs(f - 1) > EDIT_EPSILON for f in scale):
        roots = [obj for obj in objects if obj.parent is None or obj.parent not in objects]
        # The edit is in the glTF frame (X, Y up, Z); Blender is Z-up, so glTF Y is Blender Z and glTF Z is Blender -Y.
        blender = (scale[0], scale[2], scale[1])
        for root in roots:
            root.scale = tuple(s * f for s, f in zip(root.scale, blender))
        bpy.context.view_layer.update()
        applied["scale"] = scale
    if edits["materials"]:
        present = {m.name: m for m in bpy.data.materials}
        for name, edit in sorted(edits["materials"].items()):
            material = present.get(name)
            if material is None or not material.node_tree:
                reject(f"edits.materials names {name!r}, which the source does not have")
            principled = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if principled is None:
                reject(f"material {name!r} has no Principled BSDF to edit")
            if "baseColor" in edit:
                if principled.inputs["Base Color"].is_linked:
                    reject(f"material {name!r} has a base colour texture; editing its factor is not supported")
                principled.inputs["Base Color"].default_value = edit["baseColor"]
            if "roughness" in edit:
                if principled.inputs["Roughness"].is_linked:
                    reject(f"material {name!r} has a roughness texture; editing its factor is not supported")
                principled.inputs["Roughness"].default_value = edit["roughness"]
            if "metallic" in edit:
                if principled.inputs["Metallic"].is_linked:
                    reject(f"material {name!r} has a metallic texture; editing its factor is not supported")
                principled.inputs["Metallic"].default_value = edit["metallic"]
        applied["materials"] = edits["materials"]
    return applied


# ---------------------------------------------------------------------------------------------- export


def lost_attributes(before, after):
    """Attributes and materials present before finishing but absent after, per mesh."""
    after_by_name = {mesh["name"]: mesh for mesh in after["meshes"]}
    lost = []
    for mesh in before["meshes"]:
        result = after_by_name.get(mesh["name"])
        if result is None:
            lost.append({"mesh": mesh["name"], "lost": "mesh"})
            continue
        for key, names in mesh["attributes"].items():
            missing = sorted(set(names) - set(result["attributes"][key]))
            if missing:
                lost.append({"mesh": mesh["name"], "attribute": key, "lost": missing})
        missing = sorted({m for m in mesh["materials"] if m} - {m for m in result["materials"] if m})
        if missing:
            lost.append({"mesh": mesh["name"], "attribute": "materials", "lost": missing})
    return lost


def geometry_sha256(meshes):
    digest = hashlib.sha256()
    for obj in sorted(meshes, key=lambda o: o.name):
        digest.update(obj.name.encode("utf8"))
        for vertex in obj.data.vertices:
            digest.update(struct.pack("<3d", *(obj.matrix_world @ vertex.co)))
        for polygon in obj.data.polygons:
            digest.update(struct.pack(f"<{len(polygon.vertices)}I", *polygon.vertices))
    return digest.hexdigest()


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    objects = load_source(arguments, inputs)
    meshes = [obj for obj in objects if obj.type == "MESH"]
    before = inspect(objects)
    repairs = arguments["repairs"]
    check_repairs(repairs, before)
    edits = apply_edits(objects, arguments["edits"])
    applied = []
    for repair in repairs:
        applied.append({"repair": repair, **REPAIR_STEPS[repair](objects, meshes)})
    after = inspect(objects)
    lost = lost_attributes(before, after)
    if lost:
        reject(f"finishing lost attributes {lost}")
    if after["triangles"] > arguments["policy"]["maxTriangles"]:
        reject(f"{after['triangles']} triangles exceed policy.maxTriangles {arguments['policy']['maxTriangles']}")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_apply=False,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials="EXPORT", export_image_format="AUTO", export_animations=False, export_skins=True,
        export_morph=True, export_cameras=False, export_lights=False, export_extras=False)
    return {
        "recipe": RECIPE, "unit": "meter", "axes": "right-handed-y-up",
        "source": {"format": arguments["source"]["format"], "path": inputs["source"],
                   **({"collection": arguments["source"]["collection"]} if "collection" in arguments["source"] else {})},
        "before": before, "after": after, "edits": edits, "repairs": applied, "lostAttributes": lost,
        "geometrySha256": geometry_sha256(meshes),
    }
