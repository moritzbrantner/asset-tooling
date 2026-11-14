"""Review renders of the Shooter arena kit (docs/shooter-arena.md, #593): its review compositions at Shooter's third-person camera.

    <blender 5.2.2> -b --factory-startup -P scripts/review-shooter-arena.py -- --descriptor <build>/descriptor.json --out review/shooter-arena

Reads the kit's descriptor (its compositions), builds every module from the recipe (adapters/blender/shooter_arena.py, so
no bundle is needed), places the compositions side by side and renders EEVEE contact sheets as JPEGs. In a live Blender
it runs the same way in a new scene: ``runpy.run_path("scripts/review-shooter-arena.py", run_name="review",
init_globals={"ARGS": ["--descriptor", ..., "--out", ...]})``.

The camera is Shooter's third-person camera (crates/shooter-client/src/camera.rs): 3.5 m behind the fighter, 0.6 m to the
right of its shoulder and 0.3 m above its 1.65 m eye, with a 1.2 rad (69 degree) vertical field of view. The fighter is
a graphite capsule stand-in, 1.8 m tall, for scale; it does not ship.
"""
import json
import math
import os
import runpy
import sys

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.path.join(os.getcwd(), "scripts")
ROOT = os.path.dirname(HERE)
ADAPTERS = os.path.join(ROOT, "adapters", "blender")
PANEL = (960, 540)
FOV_Y, DISTANCE, SHOULDER, LIFT, EYE = 1.2, 3.5, 0.6, 0.3, 1.65
# Where each composition stands in the review scene (metres along Blender X), so they never see each other.
OFFSET = {"yard": 0.0, "heights": 60.0, "cover": 120.0, "hull": 180.0}


def arguments():
    argv = globals().get("ARGS") or (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    out = {"descriptor": None, "out": None, "only": None}
    for i in range(0, len(argv), 2):
        out[argv[i].lstrip("-")] = argv[i + 1]
    if not out["descriptor"] or not out["out"]:
        raise SystemExit("usage: -- --descriptor <descriptor.json> --out <directory> [--only <sheet>]")
    return out


def fresh_scene():
    scene = bpy.data.scenes.new("arena-review")
    if bpy.context.window is not None:
        bpy.context.window.scene = scene
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = PANEL
    scene.view_settings.view_transform = "Standard"
    try:
        scene.eevee.taa_render_samples = 32
    except AttributeError:
        pass
    world = bpy.data.worlds.new("arena-review")
    world.use_nodes = True
    background = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    background.inputs[0].default_value = (0.42, 0.46, 0.52, 1)
    background.inputs[1].default_value = 0.7
    scene.world = world
    for name, energy, rotation in (("sun", 3.2, (0.75, 0.15, 0.9)), ("fill", 0.8, (1.3, 0.0, -2.4))):
        light = bpy.data.objects.new(f"review-{name}", bpy.data.lights.new(f"review-{name}", "SUN"))
        light.data.energy = energy
        light.rotation_euler = rotation
        scene.collection.objects.link(light)
    ground = bpy.data.meshes.new("review-ground")
    ground.from_pydata([(-60, -60, -0.11), (260, -60, -0.11), (260, 60, -0.11), (-60, 60, -0.11)], [], [(0, 1, 2, 3)])
    obj = bpy.data.objects.new("review-ground", ground)
    obj.data.materials.append(flat_material("review-ground", (0.08, 0.085, 0.09)))
    scene.collection.objects.link(obj)
    camera = bpy.data.objects.new("review-camera", bpy.data.cameras.new("review-camera"))
    camera.data.sensor_fit = "VERTICAL"
    camera.data.angle = FOV_Y
    camera.data.clip_start = 0.05
    camera.data.clip_end = 400
    scene.collection.objects.link(camera)
    scene.camera = camera
    return scene


def flat_material(name, colour, emission=0.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*colour, 1)
    bsdf.inputs["Roughness"].default_value = 0.6
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*colour, 1)
        bsdf.inputs["Emission Strength"].default_value = emission
    return mat


class Kit:
    """Builds each module and variant once from the recipe and places linked copies."""

    def __init__(self, collection):
        self.arena = runpy.run_path(os.path.join(ADAPTERS, "shooter_arena.py"))
        self.arena["use_sources"](runpy.run_path(os.path.join(ADAPTERS, "combat_robot.py")), runpy.run_path(os.path.join(ADAPTERS, "kit_common.py")))
        self.store = bpy.data.collections.new("arena-review-store")
        self.collection = collection
        self.cache = {}

    def meshes(self, key, variant="default", level=0):
        k = (key, variant, level)
        if k not in self.cache:
            objects = self.arena["build"](key, self.store, variant, level)
            self.cache[k] = [(obj.name, obj.data) for obj in objects]
        return self.cache[k]

    def place(self, key, translation, yaw_degrees=0, variant="default", level=0, offset=(0, 0, 0)):
        """A module at a glTF translation and yaw (about +Y, which is Blender's +Z), moved by a Blender offset."""
        out = []
        for name, data in self.meshes(key, variant, level):
            obj = bpy.data.objects.new(name, data)
            tx, ty, tz = translation
            obj.location = Vector((tx, -tz, ty)) + Vector(offset)
            obj.rotation_euler = (0, 0, math.radians(yaw_degrees))
            self.collection.objects.link(obj)
            out.append(obj)
        return out


def figure(collection, at, facing):
    """A 1.8 m capsule fighter stand-in with a cyan visor, at Blender point ``at`` facing the Blender direction ``facing``."""
    body = flat_material("review-figure", (0.12, 0.125, 0.13))
    visor = flat_material("review-visor", (0.25, 0.85, 1.0), 3.0)
    mesh = bpy.data.meshes.new("review-figure")
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=0.38)
    for v in bm.verts:
        v.co.z = v.co.z + (0.52 if v.co.z > 0 else -0.52) + 0.9
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("review-figure", mesh)
    obj.data.materials.append(body)
    obj.location = at
    collection.objects.link(obj)
    vm = bpy.data.meshes.new("review-visor")
    d = Vector(facing).normalized()
    side = Vector((-d.y, d.x, 0))
    c = Vector(at) + Vector((0, 0, 1.6)) + d * 0.36
    corners = [c + side * s * 0.18 + Vector((0, 0, h)) for s, h in ((-1, -0.05), (1, -0.05), (1, 0.05), (-1, 0.05))]
    vm.from_pydata(corners, [], [(0, 1, 2, 3)])
    vobj = bpy.data.objects.new("review-visor", vm)
    vobj.data.materials.append(visor)
    collection.objects.link(vobj)


def third_person(scene, collection, feet, toward, pitch=0.0):
    """Shooter's third-person camera behind a fighter standing at ``feet`` (Blender) and looking toward ``toward``."""
    feet, toward = Vector(feet), Vector(toward)
    flat = Vector((toward.x - feet.x, toward.y - feet.y, 0)).normalized()
    right = Vector((flat.y, -flat.x, 0))
    figure(collection, feet, flat)
    eye = feet + Vector((0, 0, EYE))
    look = (flat * math.cos(pitch) + Vector((0, 0, math.sin(pitch)))).normalized()
    camera = scene.camera
    camera.location = eye - look * DISTANCE + right * SHOULDER + Vector((0, 0, LIFT))
    camera.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()


def aim(scene, eye, target):
    scene.camera.location = eye
    scene.camera.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat("-Z", "Y").to_euler()


def render(path):
    scene = bpy.context.scene
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(path)
    pixels = np.array(image.pixels[:], dtype=np.float32).reshape(image.size[1], image.size[0], 4)[::-1, :, :3]
    bpy.data.images.remove(image)
    os.remove(path)
    return pixels


def sheet(panels, columns, path):
    rows = math.ceil(len(panels) / columns)
    h, w = panels[0].shape[:2]
    out = np.ones((rows * h + (rows - 1) * 4, columns * w + (columns - 1) * 4, 3), dtype=np.float32) * 0.08
    for i, panel in enumerate(panels):
        r, c = divmod(i, columns)
        out[r * (h + 4):r * (h + 4) + h, c * (w + 4):c * (w + 4) + w] = panel
    image = bpy.data.images.new(os.path.basename(path), out.shape[1], out.shape[0], alpha=False)
    rgba = np.concatenate([out, np.ones(out.shape[:2] + (1,), dtype=np.float32)], -1)
    image.pixels.foreach_set(rgba[::-1].ravel())
    image.filepath_raw = path
    image.file_format = "JPEG"
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 82
    image.save_render(path, scene=scene)
    bpy.data.images.remove(image)
    print(f"wrote {path}")


def b(point, name):
    """A glTF point of a composition as a Blender point in the review scene."""
    x, y, z = point
    return Vector((x + OFFSET[name], -z, y))


def sheets(descriptor, out, only):
    scene = fresh_scene()
    collection = scene.collection
    kit = Kit(collection)
    for composition in descriptor["compositions"]:
        for item in composition["items"]:
            kit.place(item["key"], item["translation"], item.get("yawDegrees", 0), item.get("variant", "default"), offset=(OFFSET[composition["name"]], 0, 0))

    def shot(feet, toward, name, pitch=0.0):
        third_person(scene, collection, b(feet, name), b(toward, name), pitch)
        pixels = render(os.path.join(out, "_panel.png"))
        for obj in list(collection.objects):
            if obj.name.startswith("review-figure") or obj.name.startswith("review-visor"):
                bpy.data.objects.remove(obj, do_unlink=True)
        return pixels

    def want(name):
        return only is None or only == name

    # Ground level: down the long lane over the low cover; at the doorway out of the yard; past the container toward the pillar.
    if want("yard"):
        sheet([
            shot((-6, 0, 4), (6, 0, -6), "yard"),
            shot((0, 0, -4), (0, 0, -12), "yard"),
            shot((6, 0, 2), (-8, 0, -6), "yard"),
            shot((-4, 0, 6), (6, 0, -6), "yard", pitch=-0.25),
        ], 2, os.path.join(out, "yard.jpg"))
    # Height: under the walkway toward the tower; on the platform across to the walkway; on the walkway down at the
    # platform and the shed; at the tower's foot by its jump pad, up at its top.
    if want("heights"):
        sheet([
            shot((-2, 0, 9), (11, 3, -6), "heights"),
            shot((-1, 2, -5), (6, 3, 6), "heights"),
            shot((7, 3, 6), (-3, 0, -6), "heights", pitch=-0.3),
            shot((9, 0, 1), (11, 7, -7), "heights", pitch=0.45),
        ], 2, os.path.join(out, "heights.jpg"))
    # Destruction: the intact lane and the broken twin side by side, and the doors.
    if want("cover"):
        sheet([
            shot((-9, 0, 0), (6, 0, 0), "cover"),
            shot((-4, 0, 5), (-4, 0, -5), "cover", pitch=-0.1),
            shot((2, 0, 0), (8, 0, 0), "cover"),
            shot((9, 0, -3), (-2, 0, 3), "cover"),
        ], 2, os.path.join(out, "cover.jpg"))
    # The hull section: on the deck between the ribs and the mast; from the drydock floor up at the shoulder; an overview.
    if want("hull"):
        panels = [
            shot((-5, 6, 0), (6, 6, 0), "hull"),
            shot((-8, 0, 7), (0, 5, 0), "hull", pitch=0.3),
            shot((5.5, 6, -1), (-6, 6, 1), "hull", pitch=-0.1),
        ]
        aim(scene, b((14, 12, 14), "hull"), b((0, 3, 0), "hull"))
        panels.append(render(os.path.join(out, "_panel.png")))
        sheet(panels, 2, os.path.join(out, "hull.jpg"))
    # Every composition from above, then every module and variant in a row, close.
    if want("overview"):
        panels = []
        for name, eye in (("yard", (16, 18, 20)), ("heights", (20, 20, 22)), ("cover", (14, 14, 16)), ("hull", (16, 14, 16))):
            aim(scene, b(eye, name), b((0, 0, 0), name))
            panels.append(render(os.path.join(out, "_panel.png")))
        sheet(panels, 2, os.path.join(out, "overview.jpg"))
    if want("modules"):
        for obj in list(collection.objects):
            if obj.type == "MESH" and obj.name != "review-ground":
                bpy.data.objects.remove(obj, do_unlink=True)
        x = 0.0
        rows = []
        for asset in descriptor["assets"]:
            for variant in asset["variants"]:
                for level, suffix in ((0, ""), (1, " lod1")):
                    if level and not any(l["variant"].endswith("lod1") for l in asset["variants"][variant]["lods"]["levels"]):
                        continue
                    rows.append((asset, variant, level))
        groups = [rows[i:i + 6] for i in range(0, len(rows), 6)]
        panels = []
        for group in groups:
            for obj in list(collection.objects):
                if obj.type == "MESH" and obj.name != "review-ground":
                    bpy.data.objects.remove(obj, do_unlink=True)
            x = 0.0
            for asset, variant, level in group:
                lo, hi = asset["box"]["min"], asset["box"]["max"]
                kit.place(asset["key"], (x - lo[0], 0, 0), 0, variant, level)
                x += hi[0] - lo[0] + 1.0
            width = x - 1.0
            scene.camera.data.angle = 0.6  # a longer lens for the catalogue
            aim(scene, Vector((width / 2, -(width + 3), 4.0)), Vector((width / 2, 0, 1.2)))
            panels.append(render(os.path.join(out, "_panel.png")))
        sheet(panels, 2, os.path.join(out, "modules.jpg"))


def main():
    args = arguments()
    with open(args["descriptor"], encoding="utf8") as handle:
        descriptor = json.load(handle)
    os.makedirs(args["out"], exist_ok=True)
    sheets(descriptor, args["out"], args["only"])


if __name__ in ("__main__", "review"):
    main()
