"""Bounded offline Sapling invocation; Blender owns branch/leaf geometry and export."""
import ast
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sys
import tempfile
import zipfile

SOURCE_SHA256 = "27a478262e1c86612a9c3daffe7f4dce2802f5bc2294033462e5adc6d9c0080f"
KEYS = {"schemaVersion", "seed", "family", "height", "levels", "primaryBranches", "secondaryBranches", "branchAngle",
        "trunkRatio", "trunkTaper", "canopyShape", "foliageDensity", "leafScale", "curveSegments", "maxTriangles", "component"}


def validate(p, inputs):
    if not isinstance(p, dict) or set(p) != KEYS or set(inputs) != {"sapling"}:
        raise ValueError("tree requires the complete declared controls and only the Sapling input")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("tree schemaVersion must be 1")
    if not isinstance(p["seed"], str) or len(p["seed"]) > 10 or not re.fullmatch(r"0|[1-9][0-9]*", p["seed"]) or int(p["seed"]) > 2147483647:
        raise ValueError("tree seed must be canonical decimal in 0..2147483647")
    for key, minimum, maximum, integer in [
        ("height", .1, 100, False), ("levels", 2, 3, True), ("primaryBranches", 1, 32, True), ("secondaryBranches", 0, 8, True),
        ("branchAngle", 10, 120, False), ("trunkRatio", .005, .08, False), ("trunkTaper", .1, 1, False),
        ("foliageDensity", 1, 512, True), ("leafScale", .005, 1, False), ("curveSegments", 2, 6, True), ("maxTriangles", 128, 200000, True),
    ]:
        value = p[key]
        if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum or (integer and type(value) is not int):
            raise ValueError(f"invalid tree control {key}")
    if ((p["levels"] == 2 and p["secondaryBranches"] != 0) or (p["levels"] == 3 and p["secondaryBranches"] == 0)):
        raise ValueError("secondary branches must match levels")
    for key, allowed in [("family", {"broadleaf", "conifer"}), ("canopyShape", {"rounded", "conical"}),
                         ("component", {"composed", "trunk", "branches", "foliage"})]:
        if not isinstance(p[key], str) or p[key] not in allowed:
            raise ValueError(f"invalid tree {key}")
    archive = Path(inputs["sapling"])
    if archive.stat().st_size != 36296 or hashlib.sha256(archive.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("Sapling archive does not match the accepted source pin")
    return archive


def generate(output_path, arguments, inputs):
    archive = validate(arguments, inputs)
    p = arguments
    import bpy
    # An exact fresh extraction contains no bytecode or ambient extension installation.
    with tempfile.TemporaryDirectory(prefix="asset-sapling-", dir=Path(output_path).parent) as temporary:
        directory = Path(temporary)
        with zipfile.ZipFile(archive) as bundle:
            if len(bundle.infolist()) != 12 or sum(info.file_size for info in bundle.infolist()) != 139097:
                raise ValueError("unexpected Sapling bundle contents")
            for info in bundle.infolist():
                destination = (directory / info.filename).resolve()
                if not destination.is_relative_to(directory.resolve()) or info.file_size > 100000:
                    raise ValueError("unsafe Sapling bundle path/size")
            bundle.extractall(directory)
        module_name = "asset_tooling_sapling"
        spec = importlib.util.spec_from_file_location(module_name, directory / "__init__.py", submodule_search_locations=[str(directory)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        module.register()
        try:
            preset = "small_maple" if p["family"] == "broadleaf" else "small_pine"
            controls = ast.literal_eval((directory / "presets" / f"{preset}.py").read_text("utf8"))
            segments = p["curveSegments"]
            controls.update(do_update=True, seed=int(p["seed"]), scale=p["height"], scaleV=0, scaleV0=0, levels=p["levels"],
                            branches=(0, p["primaryBranches"], p["secondaryBranches"], 0), segSplits=(0, 0, 0, 0), baseSplits=0,
                            downAngle=(90, p["branchAngle"], 45, 45), ratio=p["trunkRatio"], taper=(p["trunkTaper"], 1, 1, 1), autoTaper=False,
                            shape="1" if p["canopyShape"] == "rounded" else "0", leaves=p["foliageDensity"], leafScale=p["leafScale"],
                            leafScaleX=.65 if p["family"] == "broadleaf" else .06, curveRes=(segments, max(2, segments // 2), 2, 1),
                            resU=2, bevelRes=0, showLeaves=True, makeMesh=False, useArm=True, armLevels=p["levels"], armAnim=False, leafAnim=False)
            bpy.ops.object.select_all(action="SELECT")
            bpy.ops.object.delete(use_global=False)
            bpy.ops.curve.tree_add(**controls)
            tree, foliage, armature = (bpy.data.objects[name] for name in ("tree", "leaves", "treeArm"))
            splines = len(tree.data.splines)
            if not 2 <= splines <= 1 + p["primaryBranches"] + p["primaryBranches"] * p["secondaryBranches"]:
                raise ValueError("Sapling branch count exceeds the declared bounded hierarchy")
            hierarchy = [{"id": bone.name, "parent": bone.parent.name if bone.parent else None,
                          "head": list(bone.head_local), "tail": list(bone.tail_local)} for bone in armature.data.bones]
            # Native armature generation supplies hierarchy evidence only; static derivatives contain no wind/skin contract.
            for obj in (tree, foliage):
                obj.modifiers.clear()
            bpy.data.objects.remove(armature, do_unlink=True)
            branches = tree.copy()
            branches.data = tree.data.copy()
            bpy.context.scene.collection.objects.link(branches)
            branches.data.splines.remove(branches.data.splines[0])
            for spline in list(tree.data.splines)[1:]:
                tree.data.splines.remove(spline)
            tree.name, branches.name, foliage.name = "trunk", "branches", "foliage"
            bpy.ops.object.select_all(action="SELECT")
            bpy.ops.object.convert(target="MESH")
            meshes = {obj.name: obj for obj in bpy.context.scene.objects if obj.type == "MESH"}
            if set(meshes) != {"trunk", "branches", "foliage"}:
                raise ValueError("unexpected native tree components")
            # Sapling parents leaves to the trunk. Preserve native world placement before
            # applying a uniform family scale so the leaves do not inherit that scale twice.
            for obj in meshes.values():
                matrix = obj.matrix_world.copy()
                obj.parent = None
                obj.matrix_world = matrix
            bounds = [vertex.co.z for obj in meshes.values() for vertex in obj.data.vertices]
            if not bounds or any(not math.isfinite(z) for z in bounds) or min(bounds) < -1e-6 or max(bounds) <= 0:
                raise ValueError("tree geometry must preserve the native ground root")
            scale = p["height"] / max(bounds)
            for obj in meshes.values():
                obj.scale = (scale, scale, scale)
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            for bone in hierarchy:
                bone["head"] = [value * scale for value in bone["head"]]
                bone["tail"] = [value * scale for value in bone["tail"]]
            materials = {}
            for name, color in [("bark", (.20, .09, .03, 1)), ("foliage", (.16, .30, .06, 1))]:
                material = bpy.data.materials.new("tree-" + name)
                material.diffuse_color = color
                material.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = color
                material.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = .9
                materials[name] = material
            counts = {}
            geometry = {}
            for name, obj in meshes.items():
                obj.data.calc_loop_triangles()
                if any(not math.isfinite(value) for vertex in obj.data.vertices for value in vertex.co):
                    raise ValueError("non-finite native tree geometry")
                counts[name] = {"vertices": len(obj.data.vertices), "triangles": len(obj.data.loop_triangles)}
                geometry[name] = hashlib.sha256(json.dumps({"vertices": [list(v.co) for v in obj.data.vertices],
                    "faces": [list(face.vertices) for face in obj.data.polygons]}, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
                obj.data.materials.clear()
                obj.data.materials.append(materials["bark" if name != "foliage" else "foliage"])
            if sum(count["triangles"] for count in counts.values()) > p["maxTriangles"]:
                raise ValueError("tree family exceeds maxTriangles")
            selected = set(meshes) if p["component"] == "composed" else {p["component"]}
            for name, obj in meshes.items():
                obj.select_set(name in selected)
            bpy.ops.export_scene.gltf(filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
                                      export_animations=False, export_cameras=False, export_lights=False)
            return {"authoring": "blender-sapling-tree-gen", "source": {"id": "blender.sapling-tree-gen", "version": "0.3.7", "sha256": SOURCE_SHA256},
                    "parameters": p, "unit": "meter", "axes": "right-handed-y-up", "origin": "native-root-ground-anchor", "randomness": "isolated-seeded-generator",
                    "component": p["component"], "componentCounts": counts, "componentGeometrySha256": geometry, "splines": splines,
                    "hierarchyAxes": "blender-z-up", "branchHierarchy": hierarchy, "wind": "none"}
        finally:
            module.unregister()
            for name in [key for key in sys.modules if key == module_name or key.startswith(module_name + ".")]:
                del sys.modules[name]
