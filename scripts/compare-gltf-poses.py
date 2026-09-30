"""Independent Blender source/candidate pose comparison; run with --python-exit-code 1.

This is a bounded core glTF fidelity proof, not a retargeter or visual approval.
Blender owns import, animation evaluation, skin deformation and world transforms.
"""

import json
import math
import sys

import bpy


TOLERANCE_METERS = 1e-5
SAMPLE_FRACTIONS = (0, 0.25, 0.5, 0.75, 1)


def snapshot():
    graph = bpy.context.evaluated_depsgraph_get()
    result = {}
    bone_shapes = {
        bone.custom_shape
        for obj in bpy.context.scene.objects if obj.type == "ARMATURE"
        for bone in obj.pose.bones if bone.custom_shape
    }
    for obj in sorted(bpy.context.scene.objects, key=lambda entry: entry.name):
        if obj.type != "MESH" or obj in bone_shapes:
            continue
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        try:
            result[obj.name] = {
                "vertices": [list(evaluated.matrix_world @ vertex.co) for vertex in mesh.vertices],
                "polygons": [list(polygon.vertices) for polygon in mesh.polygons],
            }
        finally:
            evaluated.to_mesh_clear()
    if not result or not any(mesh["vertices"] for mesh in result.values()):
        raise ValueError("pose comparison requires nonempty mesh geometry")
    return result


def imported_poses(filename):
    # Import both artifacts into the same empty scene/context with the same frame origin.
    for collection in (bpy.data.objects, bpy.data.actions, bpy.data.meshes, bpy.data.armatures, bpy.data.materials):
        for block in list(collection):
            collection.remove(block, do_unlink=True)
    bpy.context.scene.frame_set(0)
    bpy.ops.import_scene.gltf(filepath=filename)
    scene = bpy.context.scene
    animations = [obj.animation_data for obj in scene.objects if obj.animation_data]
    clips = {}
    for animation in animations:
        animation.action = None
        animation.use_nla = False
        for track in animation.nla_tracks:
            track.mute = True
            if len(track.strips) != 1:
                raise ValueError(f"unsupported imported NLA track structure: {track.name}")
            strip = track.strips[0]
            interval = tuple(strip.action.frame_range)
            if track.name in clips and clips[track.name] != interval:
                raise ValueError(f"inconsistent imported clip interval: {track.name}")
            clips[track.name] = interval
    scene.frame_set(0)
    bpy.context.view_layer.update()
    poses = {"animation-disabled": snapshot()}
    base_transforms = [
        (obj, obj.matrix_basis.copy(),
         [(bone, bone.matrix_basis.copy()) for bone in obj.pose.bones] if obj.type == "ARMATURE" else [])
        for obj in scene.objects
    ]
    for name, (start, end) in sorted(clips.items()):
        for animation in animations:
            animation.action = None
        for obj, matrix, bones in base_transforms:
            obj.matrix_basis = matrix
            for bone, bone_matrix in bones:
                bone.matrix_basis = bone_matrix
        for animation in animations:
            for track in animation.nla_tracks:
                if track.name == name:
                    strip = track.strips[0]
                    animation.action = strip.action
                    animation.action_slot = strip.action_slot
        for fraction in SAMPLE_FRACTIONS:
            frame = start + (end - start) * fraction
            whole = math.floor(frame)
            scene.frame_set(whole, subframe=frame - whole)
            bpy.context.view_layer.update()
            poses[f"{name}@{fraction}"] = snapshot()
    return {"clips": clips, "fps": scene.render.fps / scene.render.fps_base, "poses": poses}


def compare(source, candidate):
    if source["clips"] != candidate["clips"] or source["fps"] != candidate["fps"]:
        raise ValueError("source/candidate animation names or intervals differ")
    if source["poses"].keys() != candidate["poses"].keys():
        raise ValueError("source/candidate pose inventory differs")
    maximum_error = 0
    vertex_comparisons = 0
    for pose_name, expected in source["poses"].items():
        actual = candidate["poses"][pose_name]
        if expected.keys() != actual.keys():
            raise ValueError(f"{pose_name}: source/candidate mesh inventory differs")
        for name, mesh in expected.items():
            result = actual[name]
            if mesh["polygons"] != result["polygons"] or len(mesh["vertices"]) != len(result["vertices"]):
                raise ValueError(f"{pose_name}/{name}: topology differs")
            for index, (point, other) in enumerate(zip(mesh["vertices"], result["vertices"], strict=True)):
                if not all(math.isfinite(value) for value in point + other):
                    raise ValueError(f"{pose_name}/{name}/{index}: nonfinite world-space vertex")
                error = math.dist(point, other)
                maximum_error = max(maximum_error, error)
                vertex_comparisons += 1
                if error > TOLERANCE_METERS:
                    raise ValueError(f"{pose_name}/{name}/{index}: world-space error {error} exceeds {TOLERANCE_METERS}")
    # Report source movement so a purported animated proof cannot hide frozen sampling.
    maximum_motion = 0
    for name in source["clips"]:
        first = source["poses"][f"{name}@0"]
        for fraction in SAMPLE_FRACTIONS[1:]:
            for mesh_name, mesh in source["poses"][f"{name}@{fraction}"].items():
                for point, initial in zip(mesh["vertices"], first[mesh_name]["vertices"], strict=True):
                    maximum_motion = max(maximum_motion, math.dist(point, initial))
    return {
        "status": "passed",
        "blenderVersion": bpy.app.version_string,
        "blenderBuildHash": bpy.app.build_hash.decode(),
        "coordinateSpace": "Blender world space, meters",
        "toleranceMeters": TOLERANCE_METERS,
        "maxWorldVertexErrorMeters": maximum_error,
        "maxSourceSampleMotionMeters": maximum_motion,
        "vertexComparisons": vertex_comparisons,
        "sampleFractions": SAMPLE_FRACTIONS,
        "clipCount": len(source["clips"]),
        "poseCount": len(source["poses"]),
    }


if __name__ == "__main__":
    source_path, candidate_path, report_path, expected_version = sys.argv[sys.argv.index("--") + 1:]
    if ".".join(map(str, bpy.app.version)) != expected_version:
        raise ValueError(f"Blender version must be {expected_version}; got {bpy.app.version_string}")
    report = compare(imported_poses(source_path), imported_poses(candidate_path))
    with open(report_path, "w", encoding="utf8") as output:
        json.dump(report, output, allow_nan=False)
