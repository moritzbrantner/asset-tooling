"""Ground contact of every clip of a wildlife GLB: blender -b --factory-startup -P check.py -- <animal.glb> [clip ...]

Prints, per clip, the lowest point of the skinned meshes over its frames (metres; negative is below the ground) and the
highest of those per-frame minima. With named clips it also prints every frame's value."""
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = 24
bpy.ops.import_scene.gltf(filepath=argv[0])
rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.find_armature()]
for name in argv[1:] or sorted(a.name for a in bpy.data.actions):
    action = bpy.data.actions[name]
    rig.animation_data.action = action
    if action.slots:
        rig.animation_data.action_slot = action.slots[0]
    lows = []
    for frame in range(int(action.frame_range[0]), int(action.frame_range[1]) + 1):
        bpy.context.scene.frame_set(frame)
        depsgraph = bpy.context.evaluated_depsgraph_get()
        lows.append(round(min(min((o.evaluated_get(depsgraph).matrix_world @ v.co).z for v in o.evaluated_get(depsgraph).to_mesh().vertices)
                              for o in meshes), 3))
    print("GROUND", name, min(lows), max(lows), lows if len(argv) > 1 else "")
