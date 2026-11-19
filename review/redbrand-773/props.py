import sys, math, bpy
from mathutils import Vector
a = sys.argv[sys.argv.index("--") + 1:]
out, paths = a[0], a[1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
for i, p in enumerate(paths):
    b = set(sc.objects); bpy.ops.import_scene.gltf(filepath=p)
    for o in sc.objects:
        if o not in b and o.parent is None: o.location.x += i * 0.75
cam = bpy.data.objects.new("c", bpy.data.cameras.new("c")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = "ORTHO"; cam.data.ortho_scale = 1.5
sc.render.engine = "BLENDER_WORKBENCH"; sc.display.shading.color_type = "MATERIAL"; sc.display.shading.show_cavity = True
w = bpy.data.worlds.new("w"); w.color = (.3, .32, .34); sc.world = w
sc.render.resolution_x, sc.render.resolution_y = 640, 400
for name, d in (("front", (0, -1, .15)), ("34", (-.7, -.7, .4)), ("back", (.3, 1, .2))):
    d = Vector(d).normalized(); c = Vector((.37, 0, 0))
    cam.location = c + d * 4; cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = f"{out}-{name}.png"; bpy.ops.render.render(write_still=True)
