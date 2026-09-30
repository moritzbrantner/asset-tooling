"""Offline inspection of the example's actual exported GLBs under one fixed view.

Usage: blender --background --factory-startup --python scripts/render-rock-family.py -- .artifacts/rocks
Rendered pixels are visual evidence, not an exact-byte generation contract.
"""
import json
import sys
from pathlib import Path, PurePosixPath

import bpy
from mathutils import Vector

root = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
asset_ids = ("rounded", "angular", "flat", "boulder")
review_path = root / "review-inputs.json"
review_inputs = None
if review_path.exists():
    review = json.loads(review_path.read_text("utf8"))
    if review.get("schemaVersion") != 1 or set(review.get("meshes", {})) != set(asset_ids):
        raise ValueError("review inputs must declare exactly the rock family")
    review_inputs = review["meshes"]
for asset_id in asset_ids:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    workspace = root / asset_id
    if review_inputs is None:
        spec = json.loads((workspace / "asset.json").read_text("utf8"))
        source_path = workspace / spec["output"]["path"]
    else:
        declared = review_inputs[asset_id]
        if not isinstance(declared, str) or "\\" in declared:
            raise ValueError("review mesh paths must be portable")
        relative = PurePosixPath(declared)
        if relative.is_absolute() or any(part in (".", "..") for part in declared.split("/")):
            raise ValueError("review mesh paths must stay inside the review directory")
        source_path = root / relative
    bpy.ops.import_scene.gltf(filepath=str(source_path))
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.002))
    ground = bpy.data.materials.new("inspection-ground")
    ground.diffuse_color = (0.12, 0.13, 0.14, 1)
    bpy.context.object.data.materials.append(ground)
    bpy.ops.object.camera_add(location=(4, -6, 4))
    camera = bpy.context.object
    target = Vector((0, 0, 0.65))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 4
    scene = bpy.context.scene
    scene.camera = camera
    bpy.ops.object.light_add(type="AREA", location=(-3, -4, 7))
    bpy.context.object.data.energy = 1400
    bpy.context.object.data.shape = "DISK"
    bpy.context.object.data.size = 5
    scene.world.color = (0.15, 0.15, 0.15)
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 32
    scene.cycles.seed = 0
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(root / f"{asset_id}-preview.png")
    bpy.ops.render.render(write_still=True)
