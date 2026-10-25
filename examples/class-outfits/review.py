"""Class starter outfit review sheets (#379), rendered headless:

    blender -b --factory-startup --python examples/class-outfits/review.py -- <bundle dir> <out dir> [redbrand]

``redbrand`` (#389) renders the Redbrand bandit and crossbowman in the Redbrand outfit instead of the classes, under the
same file names.

``<bundle dir>`` is a built humanoid-ranger-male bundle (its ``scenes/`` and ``attachments/``). Each class wears its
``outfit.class.<id>`` variant (the skin of its ``class.<id>`` appearance preset), its ``armor.class.<id>`` plates on their
sockets, the preset's hair and facial hair, and its starter props. Writes, lit like the armour sheets (procedural sky at
0.06 and a 3.5 sun):

- ``class-lineup-12m.png``: the line-up in Idle_Loop at the mmorpg game camera (12 m from a pivot 0.6 m up, pitched
  0.42 rad, 50 degree vertical field of view);
- ``class-front-closeup.png``: one front tile per class;
- ``class-walk.png``: one Walk_Loop frame per class from the front three-quarter and from behind, to check the cloth.
"""
import json
import math
import os
import sys

import bpy
import numpy
from mathutils import Matrix, Quaternion, Vector

A = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
ORDER = ["warden", "ranger", "arcanist", "necromancer", "rogue", "cleric", "druid"]
LABELS = {"warden": "Warden", "ranger": "Ranger", "arcanist": "Arcanist", "necromancer": "Necromancer", "rogue": "Rogue",
          "cleric": "Cleric", "druid": "Druid"}
# The starter props: (entry, socket).
PROPS = {"warden": [("equipment.sword.arming", "hand_r.weapon"), ("equipment.shield.heater", "hand_l.shield")],
         "ranger": [("equipment.bow.long", "back.bow.stowed"), ("equipment.quiver.back", "back.quiver")],
         "arcanist": [("equipment.staff.crystal", "hand_r.staff"), ("equipment.book.tome", "hand_l.shield")],
         "necromancer": [("equipment.staff.bone", "hand_r.staff")],
         "rogue": [("equipment.dagger.blackened", "hand_r.weapon"), ("equipment.dagger.blackened", "hand_l.weapon")],
         "cleric": [("equipment.mace.flanged", "hand_r.weapon")],
         "druid": [("equipment.staff.gnarled", "hand_r.staff")],
         "bandit": [("equipment.sword.arming", "hand_r.weapon")], "crossbowman": [("equipment.crossbow", "hand_r.crossbow")]}
# ``redbrand`` (#389): mmorpg's Redbrand rank and file in the Redbrand outfit, its scarf in the band's red (mmorpg's
# REDBRAND_RED), looks of the kind the game authors over the bundle's options.
REDBRAND_ORDER = ["bandit", "crossbowman"]
LABELS.update({"bandit": "Redbrand Bandit", "crossbowman": "Redbrand Crossbowman"})
REDBRAND_RED = (.3, .025, .02, 1)
REDBRAND_PRESETS = {
    "bandit": {"outfit": "outfit.redbrand", "skin": "skin.light", "hair": "hair.buzzed", "tint": "tint.brown", "facialHair": ["beard.short"]},
    "crossbowman": {"outfit": "outfit.redbrand", "skin": "skin.dark", "hair": "hair.buzzed", "tint": "tint.black", "facialHair": ["beard.moustache"]},
}


def gltf_rest_worlds(path):
    data = json.load(open(path))
    nodes = data["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}

    def local(n):
        if "matrix" in n:
            return Matrix([n["matrix"][i::4] for i in range(4)])
        x, y, z, w = n.get("rotation", (0, 0, 0, 1))
        return (Matrix.Translation(n.get("translation", (0, 0, 0))) @ Quaternion((w, x, y, z)).to_matrix().to_4x4()
                @ Matrix.Diagonal((*n.get("scale", (1, 1, 1)), 1)))

    def world(i):
        return world(parent[i]) @ local(nodes[i]) if i in parent else local(nodes[i])
    return {n.get("name"): world(i) for i, n in enumerate(nodes)}


def attachments(bundle):
    found = {}
    manifest = json.load(open(os.path.join(bundle, "manifest.json")))
    text = json.dumps(manifest)
    for name in os.listdir(os.path.join(bundle, "attachments")):
        data = json.load(open(os.path.join(bundle, "attachments", name)))
        if data.get("schema") == "humanoid-appearance-v1":
            found["appearance"] = data
        elif "sockets" in data:
            found["sockets"] = {s["id"]: s for s in data["sockets"]}
    if "appearance" not in found or "sockets" not in found or not text:
        raise ValueError("the bundle needs its appearance and sockets attachments")
    return found


def imported(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path, guess_original_bind_pose=False)
    return [o for o in bpy.data.objects if o not in before]


def attach(obj, rig, bone, world):
    obj.parent = rig
    obj.parent_type = "BONE"
    obj.parent_bone = bone
    bpy.context.view_layer.update()
    obj.matrix_world = world


def dress(bundle, info, rest, name, x):
    appearance = info["appearance"]
    preset = REDBRAND_PRESETS.get(name) or next(p for p in appearance["presets"] if p["id"] == f"class.{name}")
    outfit = next(o for o in appearance["outfits"] if o["id"] == preset["outfit"])
    variant = next(s["variant"] for s in outfit["skins"] if s["id"] == preset["skin"])
    scenes = os.path.join(bundle, "scenes")
    objs = imported(os.path.join(scenes, appearance["character"], f"{variant}.gltf"))
    rig = next(o for o in objs if o.type == "ARMATURE")
    rig.name = f"{name}.rig"
    for o in objs:
        if o.type == "MESH" and "Icosphere" in o.name:
            bpy.data.objects.remove(o)
    rig.data.pose_position = "REST"
    bpy.context.view_layer.update()
    sockets = info["sockets"]

    def socket_world(socket_id):
        s = sockets[socket_id]
        qx, qy, qz, qw = s["rotation"]
        trs = Matrix.Translation(s["translation"]) @ Quaternion((qw, qx, qy, qz)).to_matrix().to_4x4()
        return A @ rest[s["joint"]] @ trs @ A.inverted(), s["joint"]

    def entry(key, variant_name, socket_id, keep=None):
        new = imported(os.path.join(scenes, key, f"{variant_name}.gltf"))
        world, joint = socket_world(socket_id)
        dropped = [o for o in new if o.type == "MESH" and keep is not None and not any(o.name.startswith(k) for k in keep)]
        kept = [o for o in new if o not in dropped]
        for o in dropped:
            bpy.data.objects.remove(o)
        for o in [o for o in kept if o.parent is None]:
            attach(o, rig, joint, world @ o.matrix_world)
    # Plates: each node on its own socket (the sockets are the inverse joint rests, so they sit where they were fitted).
    if outfit.get("armor"):
        hidden = set(preset.get("hiddenArmor", []))
        new = imported(os.path.join(scenes, outfit["armor"]["entry"], "default.gltf"))
        for piece in outfit["armor"]["pieces"]:
            obj = next((o for o in new if o.name.startswith(piece["node"])), None)
            if obj is None:
                continue
            if piece["node"] in hidden:
                new.remove(obj)
                bpy.data.objects.remove(obj)
                continue
            world, joint = socket_world(piece["socket"])
            attach(obj, rig, joint, world @ obj.matrix_world)
    if preset.get("hair") and not outfit.get("hood"):
        hair = next(h for h in appearance["hair"] if h["id"] == preset["hair"])
        entry(hair["entry"], "hair-1", hair["socket"])
        tint = next(t for t in appearance["tints"] if t["id"] == preset["tint"])["baseColorFactor"]
        for o in bpy.data.objects:
            if o.parent == rig and o.type == "MESH" and o.parent_type == "BONE" and o.parent_bone == "Head":
                for m in o.data.materials:
                    if m.name.split(".")[0] in hair["tintMaterials"]:
                        tinted(m, tint)
    if preset.get("facialHair"):
        facial = appearance["facialHair"]
        option = {o["id"]: o for o in facial["options"]}
        entry(facial["entry"], "default", option[preset["facialHair"][0]]["socket"], keep=preset["facialHair"])
    for key, socket_id in PROPS[name]:
        entry(key, "default", socket_id)
    if name in REDBRAND_PRESETS:
        for o in bpy.data.objects:
            if o.type == "MESH" and (o.parent == rig or o.find_armature() == rig):
                for m in o.data.materials:
                    if m.name.split(".")[0] in outfit.get("faction", {}).get("materials", []):
                        tinted(m, REDBRAND_RED)
    rig.location.x = x
    return rig


def tinted(material, factor):
    shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    base = shader.inputs["Base Color"]
    if not base.is_linked:
        base.default_value = factor
        return
    mix = material.node_tree.nodes.new("ShaderNodeMix")
    mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
    mix.inputs[0].default_value = 1.0
    material.node_tree.links.new(base.links[0].from_socket, mix.inputs[6])
    mix.inputs[7].default_value = factor
    material.node_tree.links.new(mix.outputs[2], base)


def play(rig, clip, fraction):
    rig.data.pose_position = "POSE"
    data = rig.animation_data_create()
    action = bpy.data.actions[clip]
    data.action = action
    if hasattr(data, "action_slot") and action.slots:
        data.action_slot = action.slots[0]
    start, end = action.frame_range
    return start + (end - start) * fraction


def stage(scene):
    world = bpy.data.worlds.new("review")
    scene.world = world
    world.use_nodes = True
    background = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    sky = world.node_tree.nodes.new("ShaderNodeTexSky")
    if hasattr(sky, "sun_disc"):
        sky.sun_disc = False
    world.node_tree.links.new(sky.outputs["Color"], background.inputs[0])
    background.inputs[1].default_value = .06
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(-30))
    scene.collection.objects.link(sun)
    ground_mesh = bpy.data.meshes.new("ground")
    ground_mesh.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
    ground = bpy.data.objects.new("ground", ground_mesh)
    material = bpy.data.materials.new("ground")
    material.use_nodes = True
    next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (.1, .116, .08, 1)
    ground_mesh.materials.append(material)
    scene.collection.objects.link(ground)
    label_material = bpy.data.materials.new("label")
    label_material.use_nodes = True
    next(n for n in label_material.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (.9, .87, .8, 1)
    for i, name in enumerate(ORDER):
        curve = bpy.data.curves.new(f"label.{name}", "FONT")
        curve.body, curve.align_x, curve.size, curve.extrude = LABELS[name], "CENTER", .26, .004
        curve.materials.append(label_material)
        label = bpy.data.objects.new(f"label.{name}", curve)
        label.location = (2 * i - (len(ORDER) - 1), -.75, .003)
        scene.collection.objects.link(label)
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "Standard"
    camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    scene.collection.objects.link(camera)
    camera.data.sensor_fit = "VERTICAL"
    scene.camera = camera
    return camera


def shoot(scene, camera, path, width, height, samples):
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.cycles.samples = samples
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def tiles(scene, camera, path, views, width, height, samples):
    images = []
    for location, target in views:
        camera.location = location
        camera.rotation_euler = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y").to_euler()
        tile = path + ".tile.png"
        shoot(scene, camera, tile, width, height, samples)
        image = bpy.data.images.load(tile)
        pixels = numpy.empty(width * height * 4, dtype=numpy.float32)
        image.pixels.foreach_get(pixels)
        bpy.data.images.remove(image)
        os.remove(tile)
        images.append(pixels.reshape(height, width, 4))
    return images


def save(rows, path):
    sheet = numpy.concatenate([numpy.concatenate(row, axis=1) for row in reversed(rows)], axis=0)
    image = bpy.data.images.new(os.path.basename(path), sheet.shape[1], sheet.shape[0], alpha=True)
    image.pixels.foreach_set(sheet.ravel())
    image.filepath_raw, image.file_format = path, "PNG"
    image.save()


def main():
    global ORDER
    args = sys.argv[sys.argv.index("--") + 1:]
    bundle, out = args[0], args[1]
    if args[2:] == ["redbrand"]:
        ORDER = REDBRAND_ORDER
    os.makedirs(out, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    info = attachments(bundle)
    character = info["appearance"]["character"]
    default = os.path.join(bundle, "scenes", character, "default.gltf")
    rest = gltf_rest_worlds(default)
    for o in imported(default):
        bpy.data.objects.remove(o)
    scene = bpy.context.scene
    rigs = {name: dress(bundle, info, rest, name, 2 * i - (len(ORDER) - 1)) for i, name in enumerate(ORDER)}
    camera = stage(scene)
    for rig in rigs.values():
        frame = play(rig, "Idle_Loop", 0)
    scene.frame_set(int(frame))
    camera.data.angle_y = math.radians(50)
    camera.location = (0, -12 * math.cos(.42), .6 + 12 * math.sin(.42))
    camera.rotation_euler = (math.pi / 2 - .42, 0, 0)
    shoot(scene, camera, os.path.join(out, "class-lineup-12m.png"), 1920, 1080, 48)
    camera.data.angle_y = math.radians(30)
    direction = Vector((0, -1, .16)).normalized()
    targets = [Vector((2 * i - (len(ORDER) - 1), -.2, .98)) for i in range(len(ORDER))]
    save([tiles(scene, camera, os.path.join(out, "closeup"), [(tuple(t + direction * 5.3), tuple(t)) for t in targets], 640, 1000, 32)],
         os.path.join(out, "class-front-closeup.png"))
    for rig in rigs.values():
        frame = play(rig, "Walk_Loop", .3)
    scene.frame_set(int(frame), subframe=frame - int(frame))
    front = Vector((.55, -.83, .12)).normalized()
    back = Vector((-.35, .93, .12)).normalized()
    targets = [Vector((2 * i - (len(ORDER) - 1), 0, .95)) for i in range(len(ORDER))]
    rows = [tiles(scene, camera, os.path.join(out, "walk"), [(tuple(t + d * 5.0), tuple(t)) for t in targets], 520, 820, 24) for d in (front, back)]
    save(rows, os.path.join(out, "class-walk.png"))
    print("[review] wrote", out)


main()
