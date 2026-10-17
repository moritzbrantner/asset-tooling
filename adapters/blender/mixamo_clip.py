"""Retarget one Mixamo "Without Skin" FBX clip onto the Ranger rig in Blender (#112, owner answer Q6, Atlas 6.1.6).

The declared ``target`` is the composed Ranger GLB. Its skeleton is imported with Blender's round-trip bone
heuristic, so the exported joints keep their glTF frames. Each mapped target joint copies the **world-space
rotation** of its Mixamo bone, offset by the two rigs' rest-pose difference. A Copy Rotation constraint follows an
empty that rides on the source bone, and the result is baked with visual keying. The pelvis gets the source hips'
vertical motion only, scaled by the rigs' hips heights, so every clip is in place. Its horizontal travel is
reported in the observations. Yaw is kept, so turns end rotated.

The output GLB is the target skeleton with its meshes and the single clip, named ``arguments["clip"]``. The build
extracts that clip and embeds it in the character. Raw Mixamo bytes stay on the author's machine; only the
retargeted clip in a game bundle is distributed.
"""
import hashlib

import bpy
from mathutils import Vector


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clip", "bones", "hips"}:
        raise ValueError("mixamo clip requires exactly schemaVersion, clip, bones and hips")
    if p["schemaVersion"] != 1 or type(p["clip"]) is not str or not p["clip"].replace("_", "").isalnum():
        raise ValueError("mixamo clip name must be letters, digits and underscores")
    if type(p["bones"]) is not dict or not p["bones"] or not all(type(k) is str and type(v) is str for k, v in p["bones"].items()):
        raise ValueError("mixamo clip bones must map Mixamo bone names to target joint names")
    if type(p["hips"]) is not list or len(p["hips"]) != 2 or p["hips"][0] not in p["bones"] or p["bones"][p["hips"][0]] != p["hips"][1]:
        raise ValueError("mixamo clip hips must be a mapped [source, target] bone pair")
    if set(inputs) != {"fbx", "target"}:
        raise ValueError("mixamo clip takes exactly the declared inputs fbx and target")


def action_curves(action):
    curves = list(getattr(action, "fcurves", None) or [])
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                curves.extend(bag.fcurves)
    return curves


def select_bones(rig, names):
    for pose_bone in rig.pose.bones:
        holder = pose_bone if hasattr(pose_bone, "select") else pose_bone.bone  # Blender 5 selects pose bones
        holder.select = pose_bone.name in names


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bones, (source_hips, target_hips) = arguments["bones"], arguments["hips"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    # Source: the Mixamo skeleton, with the importer's centimetre scale and Y-up rotation baked into the rest pose.
    bpy.ops.import_scene.fbx(filepath=inputs["fbx"])
    imported = list(bpy.context.scene.objects)
    armatures = [o for o in imported if o.type == "ARMATURE"]
    if len(armatures) != 1 or any(o.type == "MESH" for o in imported):
        raise ValueError("expected one armature and no mesh (Mixamo 'Without Skin' export)")
    source = armatures[0]
    if source.animation_data is None or source.animation_data.action is None:
        raise ValueError("the FBX carries no action")
    missing = [name for name in bones if name not in source.data.bones]
    if missing:
        raise ValueError(f"the Mixamo armature lacks mapped bones {missing}")
    action = source.animation_data.action
    start, end = (int(round(v)) for v in action.frame_range)
    factor = source.scale.x
    if abs(source.scale.y - factor) > 1e-9 or abs(source.scale.z - factor) > 1e-9:
        raise ValueError("the armature scale is not uniform")
    bpy.ops.object.select_all(action="DESELECT")
    source.select_set(True)
    bpy.context.view_layer.objects.active = source
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for curve in action_curves(action):
        if curve.data_path.endswith(".location"):
            for key in curve.keyframe_points:
                key.co[1] *= factor
                key.handle_left[1] *= factor
                key.handle_right[1] *= factor

    # Target: the composed Ranger, imported so that re-exported joints keep their glTF frames.
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=inputs["target"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
    target_objects = [o for o in bpy.context.scene.objects if o not in before]
    rigs = [o for o in target_objects if o.type == "ARMATURE"]
    if len(rigs) != 1:
        raise ValueError("the target GLB must have one armature")
    rig = rigs[0]
    unknown = [joint for joint in bones.values() if joint not in rig.data.bones]
    if unknown:
        raise ValueError(f"the target rig lacks joints {unknown}")
    if rig.animation_data:
        rig.animation_data_clear()

    # World-space rotation copy with the constant rest offset, then a visual-keying bake.
    source.data.pose_position = "REST"
    bpy.context.view_layer.update()
    rest_hips = (source.matrix_world @ source.data.bones[source_hips].matrix_local).translation.copy()
    target_rest_hips = (rig.matrix_world @ rig.data.bones[target_hips].matrix_local).translation.copy()
    ratio = target_rest_hips.z / rest_hips.z
    empties = []
    for name, joint in bones.items():
        empty = bpy.data.objects.new(f"follow:{name}", None)
        bpy.context.scene.collection.objects.link(empty)
        empty.parent, empty.parent_type, empty.parent_bone = source, "BONE", name
        bpy.context.view_layer.update()
        empty.matrix_world = rig.matrix_world @ rig.data.bones[joint].matrix_local
        empties.append(empty)
        constraint = rig.pose.bones[joint].constraints.new("COPY_ROTATION")
        constraint.target, constraint.owner_space, constraint.target_space = empty, "WORLD", "WORLD"
    source.data.pose_position = "POSE"
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = start, end
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    select_bones(rig, set(bones.values()))
    bpy.ops.nla.bake(frame_start=start, frame_end=end, only_selected=True, visual_keying=True, clear_constraints=True,
                     use_current_action=False, bake_types={"POSE"})

    # In place: the pelvis follows the source hips' height change only (Blender Z is glTF Y).
    pelvis = rig.pose.bones[target_hips]
    travel = []
    for frame in range(start, end + 1):
        bpy.context.scene.frame_set(frame)
        hips = (source.matrix_world @ source.pose.bones[source_hips].matrix).translation
        travel.append(((hips.x - rest_hips.x) * ratio, (hips.y - rest_hips.y) * ratio))
        world = rig.matrix_world @ pelvis.matrix
        world.translation = Vector((target_rest_hips.x, target_rest_hips.y, target_rest_hips.z + (hips.z - rest_hips.z) * ratio))
        pelvis.matrix = rig.matrix_world.inverted() @ world
        bpy.context.view_layer.update()
        pelvis.keyframe_insert("location", frame=frame)
    bpy.ops.object.mode_set(mode="OBJECT")
    baked = rig.animation_data.action
    baked.name = arguments["clip"]
    for curve in action_curves(baked):
        for key in curve.keyframe_points:
            key.interpolation = "LINEAR"
    for item in empties + [source]:
        bpy.data.objects.remove(item)
    for other in list(bpy.data.actions):
        if other is not baked:
            bpy.data.actions.remove(other)

    bpy.ops.object.select_all(action="DESELECT")
    for item in target_objects:
        if item.name in bpy.data.objects:
            item.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=False, export_tangents=False, export_materials="NONE",
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=False, export_optimize_animation_keep_anim_armature=True,
        export_skins=True, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    with open(inputs["fbx"], "rb") as handle:
        fbx_sha256 = hashlib.sha256(handle.read()).hexdigest()
    # Horizontal travel removed from the pelvis, in glTF axes (x, z), first to last frame.
    dx, dz = travel[-1][0] - travel[0][0], -(travel[-1][1] - travel[0][1])
    return {"recipe": "mixamo-retarget-v1", "clip": arguments["clip"], "source": "Mixamo (Adobe)", "fbxSha256": fbx_sha256,
            "frames": [start, end], "fps": bpy.context.scene.render.fps, "hipsRatio": round(ratio, 6),
            "removedTravel": [round(dx, 4), round(dz, 4)]}
