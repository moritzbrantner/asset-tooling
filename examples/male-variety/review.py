"""Male variety review sheets (#380, phase 1 block-out), rendered headless:

    blender -b --factory-startup --python examples/male-variety/review.py -- <bundle dir> <beards glb> <out dir>

``<bundle dir>`` is a built humanoid-ranger-male bundle; ``<beards glb>`` is the ``beard`` kit's plates GLB from
``adapters/blender/armor.py`` (it carries the new #380 beards). Eight men wear the Greyhaven Marshal's outfit (the
knight kit without its bascinet, in the Greyhaven blue), each with his own age, build, face, skin tone, hair and beard
from ``adapters/blender/male_variety.py``. Lit like the #377/#379 sheets (procedural sky at 0.06 and a 3.5 sun):

- ``male-variety-12m.png``: the line-up in Idle_Loop at the mmorpg game camera (12 m from a pivot 0.6 m up, pitched
  0.42 rad, 50 degree vertical field of view);
- ``male-variety-closeup.png``: one front tile per man, and below it a three-quarter head tile.
"""
import math
import os
import runpy
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
review = {"__name__": "class_outfits_review"}
exec(open(os.path.join(ROOT, "examples", "class-outfits", "review.py")).read().rsplit("\nmain()", 1)[0], review)
MV = runpy.run_path(os.path.join(ROOT, "adapters", "blender", "male_variety.py"))
FV = runpy.run_path(os.path.join(ROOT, "adapters", "blender", "face_variants.py"))

FACTION = (0.05, 0.08, 0.15, 1)  # Greyhaven blue (resident.marshal)
HAIR_TINTS = {"black": (.02, .02, .02, 1), "brown": (.18, .09, .04, 1), "blond": (.62, .48, .25, 1), "grey": (.9, .9, .88, 1)}
BEARD_TINTS = {"black": (.0055, .0055, .0055, 1), "brown": (.0495, .0248, .011, 1), "blond": (.1705, .132, .0688, 1),
               "grey": (.2475, .2475, .242, 1)}
HAIR_OBJECTS = {"hair.simple-parted": ["Hair_SimpleParted"], "hair.buzzed": ["Hair_Buzzed"], "hair.long": ["Hair_Long", "Hair_Long_base"],
                "hair.balding": ["hair.balding"], "hair.receding": ["hair.receding"], "hair.swept": ["hair.swept"],
                "hair.tied": ["hair.tied"], None: []}
# The eight men: age key, build key (None is the average build), face keys, skin tone, hair, hair colour, facial hair.
MEN = [
    {"label": "young / lean", "age": "age.young", "build": "build.lean", "face": ["face.narrow", "eyes.large"],
     "skin": "skin.light", "hair": "hair.swept", "colour": "brown", "beard": ["beard.stubble"]},
    {"label": "middle / average", "age": "age.middle", "build": None, "face": ["face.broad", "nose.broad"],
     "skin": "skin.olive", "hair": "hair.simple-parted", "colour": "black", "beard": ["beard.short"]},
    {"label": "old / heavy", "age": "age.old", "build": "build.heavy", "face": ["nose.long"],
     "skin": "skin.fair", "hair": "hair.balding", "colour": "grey", "beard": ["beard.long", "beard.moustache"]},
    {"label": "weathered / lean", "age": "age.weathered", "build": "build.lean", "face": ["eyes.narrow", "mouth.thin"],
     "skin": "skin.tan", "hair": "hair.buzzed", "colour": "brown", "beard": ["beard.goatee", "beard.moustache"]},
    {"label": "young / heavy", "age": "age.young", "build": "build.heavy", "face": ["nose.broad", "mouth.full"],
     "skin": "skin.brown", "hair": "hair.tied", "colour": "black", "beard": []},
    {"label": "middle / lean", "age": "age.middle", "build": "build.lean", "face": ["face.narrow", "nose.long"],
     "skin": "skin.deep", "hair": None, "colour": "black", "beard": ["beard.full", "beard.moustache"]},
    {"label": "old / average", "age": "age.old", "build": None, "face": ["face.broad", "eyes.narrow"],
     "skin": "skin.light", "hair": "hair.receding", "colour": "grey", "beard": ["beard.walrus"]},
    {"label": "weathered / heavy", "age": "age.weathered", "build": "build.heavy", "face": ["face.broad", "mouth.thin"],
     "skin": "skin.olive", "hair": "hair.long", "colour": "blond", "beard": ["beard.short"]},
]
SPACING = 1.8


def x_of(i):
    return (i - (len(MEN) - 1) / 2) * SPACING


def template(bundle, beards_glb):
    """The Marshal, dressed, with every hair and beard option on his head, and the #380 keys on every mesh."""
    info = review["attachments"](bundle)
    appearance = info["appearance"]
    marshal = dict(next(p for p in appearance["presets"] if p["id"] == "resident.marshal"), id="class.marshal", hair=None,
                   facialHair=None)
    appearance["presets"].append(marshal)
    review["PROPS"]["marshal"] = []
    default = os.path.join(bundle, "scenes", appearance["character"], "default.gltf")
    rest = review["gltf_rest_worlds"](default)
    for o in review["imported"](default):
        bpy.data.objects.remove(o)
    rig = review["dress"](bundle, info, rest, "marshal", 0)
    rig.data.pose_position = "REST"
    bpy.context.view_layer.update()
    scenes = os.path.join(bundle, "scenes")
    for entry in ("hair.simple-parted", "hair.buzzed", "hair.long"):
        for o in review["imported"](os.path.join(scenes, entry, "hair-1.gltf")):
            if o.name.startswith("Hair_Buzzed") and entry == "hair.long":
                o.name = "Hair_Long_base"
            review["attach"](o, rig, "Head", o.matrix_world.copy())
    for o in review["imported"](beards_glb):
        o.name = o.name.split(".0")[0]
        review["attach"](o, rig, "Head", o.matrix_world.copy())
    bpy.context.view_layer.update()
    objects = {o.name: o for o in bpy.data.objects if o.parent == rig}
    MV["hairstyles"](objects["Hair_Buzzed"])
    objects = {o.name: o for o in bpy.data.objects if o.parent == rig}
    beards = [o for n, o in objects.items() if n.startswith("beard.")]
    lm, age = MV["add_age_keys"](objects["SuperHero_Male"], objects["Eyes"], objects["Eyebrows"], FV["landmarks"], followers=beards)
    build = MV["add_build_keys"](rig, list(objects.values()), lm)
    print("[review] age keys", age)
    print("[review] build keys", build)
    for o in objects.values():
        for m in o.data.materials:
            if m and m.name.startswith("faction"):
                next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = FACTION
    return rig, objects


def pristine(material):
    """A copy of material without any earlier tint (the class review tints the preset hair in place)."""
    copy = material.copy()
    for node in [n for n in copy.node_tree.nodes if n.bl_idname == "ShaderNodeMix" and n.blend_type == "MULTIPLY"
                 and n.inputs[0].default_value == 1.0 and not n.inputs[7].is_linked]:
        source = node.inputs[6].links[0].from_socket
        for link in list(node.outputs[2].links):
            copy.node_tree.links.new(source, link.to_socket)
        copy.node_tree.nodes.remove(node)
    return copy


def man(i, spec, rig, objects):
    keep = ["Male_Peasant_Arms", "Male_Peasant_Body", "Male_Peasant_Feet", "Male_Peasant_Legs", "SuperHero_Male", "Eyes",
            "Eyebrows", *[n for n in objects if n.startswith("knight.")], *HAIR_OBJECTS[spec["hair"]], *spec["beard"]]
    new_rig = rig.copy()
    new_rig.name = f"man{i}.rig"
    bpy.context.scene.collection.objects.link(new_rig)
    keys = {spec["age"], spec["build"], *spec["face"]} - {None}
    tone = MV["SKIN_TONES"][spec["skin"]]
    hair = HAIR_TINTS[spec["colour"]]
    copies = {}
    for name in keep:
        src = objects[name]
        o = src.copy()
        o.data = src.data.copy()
        o.name = f"man{i}.{name}"
        bpy.context.scene.collection.objects.link(o)
        o.parent = new_rig
        o.matrix_parent_inverse = src.matrix_parent_inverse.copy()
        for mod in o.modifiers:
            if mod.type == "ARMATURE":
                mod.object = new_rig
        if o.data.shape_keys:
            for block in o.data.shape_keys.key_blocks[1:]:
                block.value = 1.0 if block.name in keys else 0.0
        for slot, m in enumerate(o.data.materials):
            if m is None:
                continue
            base = m.name.split(".")[0]
            if base in ("MI_Superhero_Male", "MI_Regular_Male"):
                copy = m.copy()
                MV["tone"](copy, tone)
                o.data.materials[slot] = copy
            elif base.startswith("MI_Hair"):
                copy = pristine(m)
                review["tinted"](copy, hair)
                o.data.materials[slot] = copy
            elif base == "beard":
                copy = m.copy()
                shader = next(n for n in copy.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
                shader.inputs["Base Color"].default_value = BEARD_TINTS[spec["colour"]]
                if "stubble" in m.name:
                    shader.inputs["Alpha"].default_value = .45  # stubble shades the skin rather than covering it
                o.data.materials[slot] = copy
        copies[name] = o
    new_rig.location.x = x_of(i)
    return new_rig


def labels(scene):
    material = bpy.data.materials.new("label")
    material.use_nodes = True
    next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (.9, .87, .8, 1)
    for i, spec in enumerate(MEN):
        curve = bpy.data.curves.new(f"label.{i}", "FONT")
        curve.body, curve.align_x, curve.size, curve.extrude = spec["label"], "CENTER", .2, .004
        curve.materials.append(material)
        label = bpy.data.objects.new(f"label.{i}", curve)
        label.location = (x_of(i), -.75, .003)
        scene.collection.objects.link(label)


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    bundle, beards_glb, out = args
    os.makedirs(out, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    scene = bpy.context.scene
    rig, objects = template(bundle, beards_glb)
    rigs = [man(i, spec, rig, objects) for i, spec in enumerate(MEN)]
    for o in [rig, *objects.values()]:
        bpy.data.objects.remove(o)
    camera = review["stage"](scene)
    for o in [o for o in scene.objects if o.name.startswith("label.")]:
        bpy.data.objects.remove(o)
    labels(scene)
    for r in rigs:
        frame = review["play"](r, "Idle_Loop", 0)
    scene.frame_set(int(frame))
    camera.data.angle_y = math.radians(50)
    camera.location = (0, -12 * math.cos(.42), .6 + 12 * math.sin(.42))
    camera.rotation_euler = (math.pi / 2 - .42, 0, 0)
    review["shoot"](scene, camera, os.path.join(out, "male-variety-12m.png"), 1920, 1080, 48)
    camera.data.angle_y = math.radians(30)
    direction = Vector((0, -1, .16)).normalized()
    bodies = [Vector((x_of(i), -.2, .98)) for i in range(len(MEN))]
    row_body = review["tiles"](scene, camera, os.path.join(out, "closeup"),
                               [(tuple(t + direction * 5.3), tuple(t)) for t in bodies], 480, 750, 32)
    camera.data.angle_y = math.radians(14)
    quarter = Vector((.45, -.89, -.03)).normalized()
    heads = [Vector((x_of(i), -.03, 1.63)) for i in range(len(MEN))]
    row_head = review["tiles"](scene, camera, os.path.join(out, "head"),
                               [(tuple(t + quarter * 2.0), tuple(t)) for t in heads], 480, 480, 32)
    review["save"]([row_body, row_head], os.path.join(out, "male-variety-closeup.png"))
    print("[review] wrote", out)


main()
