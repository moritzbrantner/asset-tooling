"""Measure the #778 creatures' motion: blender -b --factory-startup -P check.py -- <glb_dir> <descriptor-like clips.json>

For every clip: the lowest mesh point (ground penetration) and, with the descriptor's root motion added back, how far
each planted lynx paw slides (a paw counts as planted while its sole is within 6 mm of the ground), how far the
adder's body strays from the path its neck traced, and the adder's closest approach between body parts more than
0.2 m apart along it, less their radii (negative is an intersection)."""
import json
import math
import sys

import bpy
from mathutils import Vector

glbs, clips_path = sys.argv[sys.argv.index("--") + 1:][:2]
clips = json.load(open(clips_path))  # {animal: {clip: {travelSpeed?, rootTravel?}}}
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24


def forward(info, t):
    if "travelSpeed" in info:
        return info["travelSpeed"] * t / 24
    if "rootTravel" in info:
        r = info["rootTravel"]
        return r["metres"] * min(max((t / 24 - r["startSeconds"]) / (r["endSeconds"] - r["startSeconds"]), 0), 1)
    return 0.0


for animal in ("lynx", "marsh-adder"):
    before, before_actions = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=f"{glbs}/{animal}.glb")
    objs = [o for o in bpy.data.objects if o not in before]
    rig = next(o for o in objs if o.type == "ARMATURE")
    mesh = next(o for o in objs if o.type == "MESH" and o.parent == rig)  # not the importer's bone-shape sphere
    paws = {g.name: [v.index for v in mesh.data.vertices if any(e.group == g.index and e.weight > 0.5 for e in v.groups)]
            for g in mesh.vertex_groups if g.name.startswith("Paw")}
    actions = {a.name.split(".")[0]: a for a in bpy.data.actions if a not in before_actions}
    rig.animation_data_create()
    for clip, action in actions.items():
        rig.animation_data.action = action
        if action.slots:
            rig.animation_data.action_slot = action.slots[0]
        info = clips[animal].get(clip, {})
        start, end = (int(round(v)) for v in action.frame_range)
        lowest, slides, planted, stray, contact, grounded = 1.0, {}, {}, 0.0, 1.0, 0
        neck_path = []
        frames = []
        for f in range(start, end + 1):
            scene.frame_set(f)
            depsgraph = bpy.context.evaluated_depsgraph_get()
            evaluated = mesh.evaluated_get(depsgraph)
            world = [mesh.matrix_world @ v.co for v in evaluated.data.vertices]
            lowest = min(lowest, min(p.z for p in world))
            fwd = Vector((0, -forward(info, f), 0))  # glTF +Z forward is Blender -Y
            bones = {pb.name: (rig.matrix_world @ pb.head + fwd, rig.matrix_world @ pb.tail + fwd) for pb in rig.pose.bones}
            frames.append(bones)
            if animal == "lynx":
                for name, indices in paws.items():
                    tail = min((world[i] for i in indices), key=lambda p: p.z) + fwd
                    if tail.z < 0.006:
                        grounded += 1
                        if name in planted:
                            slides[name] = max(slides.get(name, 0.0), (tail.xy - planted[name].xy).length)
                        else:
                            planted[name] = tail.copy()
                    else:
                        planted.pop(name, None)
            else:
                neck_path.append(bones["Spine1"][0].copy())
        result = {"lowest": round(lowest, 4)}
        if animal == "lynx" and info:
            result["maxSlide"] = round(max(slides.values(), default=0.0), 4)
            result["plantedPawFrames"] = grounded
        if animal == "marsh-adder":
            spine = [f"Spine{i}" for i in range(1, 15)]
            if clip == "Slither_Loop":
                loop = info["travelSpeed"] * (end - start) / 24  # the path repeats every loop's travel, behind (+Y)
                path = [p.xy + Vector((0, k * loop)) for k in range(5) for p in neck_path]
                for bones in frames:
                    for name in spine:
                        q = bones[name][0].xy
                        stray = max(stray, min((q - p).length for p in path))
                result["pathStray"] = round(stray, 4)
            # Self-contact: joints and bone midpoints more than 0.2 m apart along the body.
            for bones in frames:
                pts = []
                for i, name in enumerate(spine):
                    head, tail = bones[name][0], (bones[spine[i + 1]][0] if i + 1 < len(spine) else bones[name][1])
                    pts += [(i * 0.093, head), (i * 0.093 + 0.0465, (head + tail) / 2)]
                for a in range(len(pts)):
                    for b in range(a + 1, len(pts)):
                        sa, pa = pts[a]
                        sb, pb = pts[b]
                        if sb - sa > 0.2:
                            radius = lambda s: 0.037 if 0.4 < s < 0.9 else 0.03 if s < 1.1 else 0.015
                            contact = min(contact, (pa - pb).length - radius(sa) - radius(sb))
            result["minClearance"] = round(contact, 4)
        print("CHECK", animal, clip, json.dumps(result))
    for o in objs:
        bpy.data.objects.remove(o)
