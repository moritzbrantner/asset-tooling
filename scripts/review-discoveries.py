"""Review renders of the Greyhaven discoveries kit (docs/discoveries.md, #764): each site at mmorpg's game camera, and its
two-state pieces side by side.

    <blender 5.2.2> -b --factory-startup -P scripts/review-discoveries.py -- --out review/discoveries

Builds every piece from the recipe (adapters/blender/discoveries.py, so no bundle is needed), lays the three sites out
from the recipe's ``SITES`` on stand-in ground (grass, a rock shelf under the lookout, a mud bank, fen water and crude
reed cards at the fen cache; none of it ships) and renders EEVEE JPEGs. The camera is the Greyhaven game camera: 12 m
from the target, pitched down 0.42 rad, with a 50 degree field of view.
"""
import math
import os
import random
import runpy
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.path.join(os.getcwd(), "scripts")
ADAPTERS = os.path.join(os.path.dirname(HERE), "adapters", "blender")
SIZE = (1280, 720)
DISTANCE, PITCH, FOV = 12.0, 0.42, 50.0
# Where each site stands along Blender X, and the game-camera target and yaw it is reviewed from.
SITE_X = {"wolfrun-hunter-cache": -16.0, "greyfang-lookout": 0.0, "eastwater-fen-cache": 16.0}
SHOTS = {"game-hunter-cache": ((-15.6, -0.2, 0.8), 0.35, DISTANCE), "game-lookout": ((0.0, 0.0, 1.6), 0.45, DISTANCE),
         "game-fen-cache": ((15.4, -0.3, 0.3), -0.3, DISTANCE)}
# The state pairs, built side by side away from the sites: (piece, x) in a row at Blender y = 30.
STATE_ROW = [("hunter-chest", -4.6), ("hunter-chest-open", -3.4), ("signal-brazier", -1.2), ("signal-brazier-lit", 0.2),
             ("supply-crates", 2.6), ("supply-crates-open", 4.6)]


def out_dir():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) != 2 or argv[0] != "--out":
        raise SystemExit("usage: -- --out <directory>")
    return os.path.abspath(argv[1])


def material(name, rgb, roughness=0.9):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def mesh(name, verts, faces, mat, collection):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.materials.append(mat)
    obj = bpy.data.objects.new(name, data)
    collection.objects.link(obj)
    return obj


def quad(name, x0, y0, x1, y1, z0, z1, mat, collection):
    """A ground quad from (x0, y0) to (x1, y1), its height running from z0 at x0 to z1 at x1."""
    return mesh(name, [(x0, y0, z0), (x1, y0, z1), (x1, y1, z1), (x0, y1, z0)], [(0, 1, 2, 3)], mat, collection)


def stand_ins(collection):
    grass, rock = material("review-grass", (0.16, 0.2, 0.08)), material("review-rock", (0.25, 0.24, 0.22))
    mud, water = material("review-mud", (0.12, 0.09, 0.06)), material("review-water", (0.03, 0.05, 0.04), 0.05)
    quad("ground-hunter", -30, -12, -6, 12, 0, 0, grass, collection)
    quad("ground-lookout", -6, -12, 7, 12, -0.5, -0.5, grass, collection)
    shelf = [(x, y, z) for z in (-0.6, 0.0) for (x, y) in ((-3.2, -3.0), (3.2, -3.0), (3.2, 3.0), (-3.2, 3.0))]
    mesh("rock-shelf", shelf, [(4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], rock, collection)
    bank_x = SITE_X["eastwater-fen-cache"] - 1.0
    quad("fen-bank", bank_x, -8, bank_x + 10, 8, -0.25, 0.15, mud, collection)
    quad("fen-bed", bank_x - 9, -8, bank_x, 8, -0.6, -0.6, mud, collection)
    quad("fen-water", bank_x - 9, -8, bank_x + 0.6, 8, 0.0, 0.0, water, collection)
    rng, verts, faces = random.Random(764), [], []
    punt = SITE_X["eastwater-fen-cache"] - 1.9
    for _ in range(120):
        cx, cy = rng.uniform(bank_x - 9, bank_x - 0.1), rng.uniform(-4.5, 4.5)
        if abs(cx - punt) < 1.3 and abs(cy + 0.4) < 2.4:
            continue
        for _ in range(6):
            a, h, w = rng.uniform(0, 6.28), rng.uniform(1.2, 2.0), 0.025
            x, y, lean = cx + rng.uniform(-0.25, 0.25), cy + rng.uniform(-0.25, 0.25), rng.uniform(-0.2, 0.2)
            i = len(verts)
            verts += [(x - math.cos(a) * w, y - math.sin(a) * w, -0.2), (x + math.cos(a) * w, y + math.sin(a) * w, -0.2), (x + lean, y + lean * 0.5, h)]
            faces.append((i, i + 1, i + 2))
    mesh("reeds", verts, faces, material("review-reed", (0.25, 0.32, 0.12)), collection)
    quad("ground-states", -8, 26, 8, 34, 0, 0, grass, collection)


def aim(camera, target, yaw, distance, pitch=PITCH):
    d = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    camera.location = Vector(target) + d * distance
    camera.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()


def main():
    out = out_dir()
    os.makedirs(out, exist_ok=True)
    recipe = runpy.run_path(os.path.join(ADAPTERS, "discoveries.py"))
    recipe["use_common"](runpy.run_path(os.path.join(ADAPTERS, "kit_common.py")))
    scene = bpy.data.scenes.new("discoveries-review")
    bpy.context.window.scene = scene
    collection = bpy.data.collections.new("discoveries-review")
    scene.collection.children.link(collection)
    for site, placements in recipe["SITES"].items():
        for piece, x, y, z, yaw in placements:
            recipe["build"](piece, collection, 0, (x + SITE_X[site], y, z), yaw)
    for piece, x in STATE_ROW:
        recipe["build"](piece, collection, 0, (x, 0, -30), 0.0)
    stand_ins(collection)
    camera = bpy.data.objects.new("review-camera", bpy.data.cameras.new("review-camera"))
    camera.data.lens_unit = "FOV"
    camera.data.angle = math.radians(FOV)
    collection.objects.link(camera)
    scene.camera = camera
    sun = bpy.data.objects.new("review-sun", bpy.data.lights.new("review-sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))
    collection.objects.link(sun)
    world = bpy.data.worlds.new("review-world")
    world.use_nodes = True
    background = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    background.inputs[0].default_value = (0.55, 0.62, 0.72, 1.0)
    background.inputs[1].default_value = 0.8
    scene.world = world
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = SIZE
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 82
    shots = dict(SHOTS)
    shots["states"] = ((0.0, 30.0, 1.5), 0.0, 9.5)
    for name, (target, yaw, distance) in shots.items():
        aim(camera, target, yaw, distance, PITCH if name != "states" else 0.3)
        scene.render.filepath = os.path.join(out, f"{name}.jpg")
        bpy.ops.render.render(write_still=True)
        print(f"wrote {scene.render.filepath}")


main()
