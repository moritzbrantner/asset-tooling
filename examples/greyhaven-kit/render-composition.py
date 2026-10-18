"""Render a starter-kit composition for review (#119).

    blender --background --factory-startup --python examples/greyhaven-kit/render-composition.py -- \
        <bundle dir> <composition.json> <out.png> [--figure=<character .gltf>]

Each item places a bundle entry (`scenes/<key>/default.gltf`) at `at` (glTF metres) with an optional `yaw` in degrees.
An item with `open` and `pivotNode` rotates that joint, for example the chest lid. `--figure` places a character at
the composition's `figure.at` for scale. Placement and scene meaning stay with the consuming game.
"""
import bpy, sys, json, math, os, numpy
from mathutils import Vector
a = [x for x in sys.argv[sys.argv.index("--")+1:] if not x.startswith("--figure=")]
figure = next((x[len("--figure="):] for x in sys.argv if x.startswith("--figure=")), None)
bundle, layout_path, out = a
layout = json.load(open(layout_path))
if figure:
    layout["items"].append({"key": "figure", "file": figure, "at": layout["figure"]["at"]})
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for item in layout["items"]:
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=item.get("file") or os.path.join(bundle, "scenes", item["key"], "default.gltf"))
    new = [o for o in bpy.context.scene.objects if o not in before]
    root = bpy.data.objects.new("place:" + item["key"], None); bpy.context.scene.collection.objects.link(root)
    for o in new:
        if o.parent is None: o.parent = root
    x, y, z = item.get("at", [0, 0, 0])
    root.location = (x, -z, y)
    root.rotation_euler = (0, 0, math.radians(item.get("yaw", 0)))
    s = item.get("scale", 1); root.scale = (s, s, s)
    if item.get("open") and item.get("pivotNode"):
        for o in new:
            if o.type == "ARMATURE" and item["pivotNode"] in o.pose.bones:
                o.pose.bones[item["pivotNode"]].rotation_mode = "XYZ"; o.pose.bones[item["pivotNode"]].rotation_euler = (math.radians(-70), 0, 0)
for o in bpy.context.scene.objects:
    if o.name.startswith("Icosphere"): o.hide_render = True
bpy.ops.mesh.primitive_plane_add(size=60); g = bpy.context.object
m = bpy.data.materials.new("ground"); m.use_nodes = True; m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (.18, .24, .12, 1); g.data.materials.append(m)
sc = bpy.context.scene; W, H = 1280, 720
sc.render.resolution_x, sc.render.resolution_y = W, H; sc.view_settings.view_transform = "Standard"
sc.render.engine = "CYCLES"; sc.cycles.samples = 32; sc.cycles.device = "CPU"
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True; w.node_tree.nodes["Background"].inputs[0].default_value = (.6, .68, .78, 1); w.node_tree.nodes["Background"].inputs[1].default_value = 0.8
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sun.data.energy = 3.0; sun.rotation_euler = (math.radians(45), 0, math.radians(35)); sc.collection.objects.link(sun)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.lens = layout.get("lens", 35)
tx, ty, tz = layout["target"]; target = Vector((tx, -tz, ty))
cx, cy, cz = layout["camera"]; cam.location = Vector((cx, -cz, cy))
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
sc.render.filepath = out; bpy.ops.render.render(write_still=True)
