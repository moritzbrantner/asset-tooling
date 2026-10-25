"""Male variety review sheets (#380, phase 1b), rendered headless:

    blender -b --factory-startup --python examples/male-variety/review.py -- <bundle dir> <textures dir> <out dir> [suffix]

``<bundle dir>`` is a built humanoid-ranger-male bundle. ``<textures dir>`` receives the painted skin variants of
``adapters/blender/skin_overlays.py`` (aged and weathered per skin tone, and the stubble mask). Eight men wear the
Greyhaven Marshal's outfit (the knight kit without its bascinet, in the Greyhaven blue), each with his own height, age,
build, face, skin, hair and beard: the age and build keys of ``male_variety.py``, the hand-modelled hair and beards of
``hair_beards.py`` (and the pack's parted, buzzed and long hair). Lit like the #377/#379 sheets (procedural sky at 0.06
and a 3.5 sun):

- ``male-variety-12m<suffix>.png``: the line-up in Idle_Loop at the mmorpg game camera (12 m from a pivot 0.6 m up,
  pitched 0.42 rad, 50 degree vertical field of view);
- ``male-variety-closeup<suffix>.png``: one front tile per man, and below it a three-quarter head tile.
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
BLENDER = os.path.join(ROOT, "adapters", "blender")
MV = runpy.run_path(os.path.join(BLENDER, "male_variety.py"))
FV = runpy.run_path(os.path.join(BLENDER, "face_variants.py"))
HB = runpy.run_path(os.path.join(BLENDER, "hair_beards.py"))
SO = runpy.run_path(os.path.join(BLENDER, "skin_overlays.py"))

FACTION = (0.05, 0.08, 0.15, 1)  # Greyhaven blue (resident.marshal)
HAIR_TINTS = {"black": (.02, .02, .02, 1), "brown": (.18, .09, .04, 1), "blond": (.62, .48, .25, 1), "grey": (.9, .9, .88, 1)}
HAIR_OBJECTS = {"hair.simple-parted": ["Hair_SimpleParted"], "hair.buzzed": ["Hair_Buzzed"], "hair.long": ["Hair_Long", "Hair_Long_base"],
                "hair.balding": ["hair.balding"], "hair.receding": ["hair.receding"], "hair.swept": ["hair.swept"],
                "hair.tied": ["hair.tied"], None: []}
# Which painted skin goes with which age key (the young and middle-aged keep the plain toned skin).
AGE_SKIN = {"age.old": "aged", "age.weathered": "weathered"}
# The eight men: height (rig scale), age key, build key (None is the average build), face keys, skin tone, hair, hair
# colour, facial hair and stubble.
MEN = [
    {"label": "young / lean", "height": 1.04, "age": "age.young", "build": "build.lean", "face": ["face.narrow", "eyes.large"],
     "skin": "skin.light", "hair": "hair.swept", "colour": "brown", "beard": [], "stubble": True},
    {"label": "middle / average", "height": 1.0, "age": "age.middle", "build": None, "face": ["face.broad", "nose.broad"],
     "skin": "skin.olive", "hair": "hair.simple-parted", "colour": "black", "beard": ["beard.short"]},
    {"label": "old / heavy", "height": .95, "age": "age.old", "build": "build.heavy", "face": ["nose.long"],
     "skin": "skin.fair", "hair": "hair.balding", "colour": "grey", "beard": ["beard.long", "beard.moustache"]},
    {"label": "weathered / lean", "height": 1.06, "age": "age.weathered", "build": "build.lean", "face": ["eyes.narrow", "mouth.thin"],
     "skin": "skin.tan", "hair": "hair.buzzed", "colour": "brown", "beard": ["beard.goatee", "beard.moustache"], "stubble": True},
    {"label": "young / heavy", "height": .97, "age": "age.young", "build": "build.heavy", "face": ["nose.broad", "mouth.full"],
     "skin": "skin.brown", "hair": "hair.tied", "colour": "black", "beard": []},
    {"label": "middle / lean", "height": 1.02, "age": "age.middle", "build": "build.lean", "face": ["face.narrow", "nose.long"],
     "skin": "skin.deep", "hair": None, "colour": "black", "beard": ["beard.full", "beard.moustache"]},
    {"label": "old / average", "height": .94, "age": "age.old", "build": None, "face": ["face.broad", "eyes.narrow"],
     "skin": "skin.light", "hair": "hair.receding", "colour": "grey", "beard": ["beard.walrus"], "stubble": True},
    {"label": "weathered / heavy", "height": 1.01, "age": "age.weathered", "build": "build.heavy", "face": ["face.broad", "mouth.thin"],
     "skin": "skin.olive", "hair": "hair.long", "colour": "blond", "beard": ["beard.short"]},
]
SPACING = 1.8
STUBBLE = .75  # how far the stubble mask pulls the skin toward the hair tint


def x_of(i):
    return (i - (len(MEN) - 1) / 2) * SPACING


def template(bundle):
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
    bpy.context.view_layer.update()
    objects = {o.name: o for o in bpy.data.objects if o.parent == rig}
    HB["make"](objects["SuperHero_Male"], rig, objects["Hair_Buzzed"].data.materials[0], bpy.context.scene.collection)
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
    return rig, objects, lm


def skin_textures(objects, lm, out):
    """Paints (or reuses) the aged and weathered skins per tone and the stubble mask; returns them as loaded images."""
    head = objects["SuperHero_Male"]
    material = head.data.materials[0]
    base = base_texture(material).image
    paths = {f"{tone}.{kind}": os.path.join(out, f"{tone}.{kind}.png") for tone in MV["SKIN_TONES"] for kind in ("aged", "weathered")}
    paths["stubble"] = os.path.join(out, "stubble.png")
    if not all(os.path.exists(p) for p in paths.values()):
        paths = SO["generate"](head, base, lm, MV["SKIN_TONES"], out)
    images = {}
    for key, path in paths.items():
        image = bpy.data.images.load(path, check_existing=True)
        if key == "stubble":
            image.colorspace_settings.name = "Non-Color"
        images[key] = image
    return images


def base_texture(material):
    """The image node feeding the base colour (through the importer's vertex-colour mix, if any)."""
    shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    queue = [shader.inputs["Base Color"].links[0].from_node]
    while queue:
        node = queue.pop(0)
        if node.type == "TEX_IMAGE":
            return node
        queue += [i.links[0].from_node for i in node.inputs if i.is_linked]
    raise ValueError(f"{material.name} has no base-colour texture")


def stubble(material, mask, tint):
    """Darkens the skin under the stubble mask toward the hair tint."""
    tree = material.node_tree
    shader = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    base = shader.inputs["Base Color"]
    source = base.links[0].from_socket
    texture = tree.nodes.new("ShaderNodeTexImage")
    texture.image = mask
    texture.location = base_texture(material).location
    uv = base_texture(material).inputs["Vector"]
    if uv.is_linked:
        tree.links.new(uv.links[0].from_socket, texture.inputs["Vector"])
    amount = tree.nodes.new("ShaderNodeMath")
    amount.operation, amount.inputs[1].default_value = "MULTIPLY", STUBBLE
    tree.links.new(texture.outputs["Color"], amount.inputs[0])
    mix = tree.nodes.new("ShaderNodeMix")
    mix.data_type, mix.blend_type = "RGBA", "MIX"
    tree.links.new(amount.outputs[0], mix.inputs[0])
    tree.links.new(source, mix.inputs[6])
    mix.inputs[7].default_value = tuple(c * .3 for c in tint[:3]) + (1,)
    tree.links.new(mix.outputs[2], base)


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


def man(i, spec, rig, objects, skins):
    keep = ["Male_Peasant_Arms", "Male_Peasant_Body", "Male_Peasant_Feet", "Male_Peasant_Legs", "SuperHero_Male", "Eyes",
            "Eyebrows", *[n for n in objects if n.startswith("knight.")], *HAIR_OBJECTS[spec["hair"]], *spec["beard"]]
    new_rig = rig.copy()
    new_rig.name = f"man{i}.rig"
    bpy.context.scene.collection.objects.link(new_rig)
    keys = {spec["age"], spec["build"], *spec["face"]} - {None}
    tone = MV["SKIN_TONES"][spec["skin"]]
    painted = AGE_SKIN.get(spec["age"])
    hair = HAIR_TINTS[spec["colour"]]
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
            if base == "MI_Superhero_Male":
                copy = m.copy()
                if painted:
                    base_texture(copy).image = skins[f"{spec['skin']}.{painted}"]
                else:
                    MV["tone"](copy, tone)
                if spec.get("stubble"):
                    stubble(copy, skins["stubble"], hair)
                o.data.materials[slot] = copy
            elif base == "MI_Regular_Male":
                copy = m.copy()
                MV["tone"](copy, tone)
                o.data.materials[slot] = copy
            elif base.startswith("MI_Hair"):
                copy = pristine(m)
                review["tinted"](copy, hair)
                o.data.materials[slot] = copy
    new_rig.location.x = x_of(i)
    new_rig.scale = (spec["height"],) * 3
    return new_rig


def labels(scene):
    material = bpy.data.materials.new("label")
    material.use_nodes = True
    next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (.9, .87, .8, 1)
    for i, spec in enumerate(MEN):
        curve = bpy.data.curves.new(f"label.{i}", "FONT")
        curve.body = f"{spec['label']}\n{(spec['height'] - 1) * 100:+.0f}%"
        curve.align_x, curve.size, curve.extrude = "CENTER", .2, .004
        curve.materials.append(material)
        label = bpy.data.objects.new(f"label.{i}", curve)
        label.location = (x_of(i), -.75, .003)
        scene.collection.objects.link(label)


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    bundle, textures, out = args[:3]
    suffix = args[3] if len(args) > 3 else ""
    os.makedirs(out, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    scene = bpy.context.scene
    rig, objects, lm = template(bundle)
    skins = skin_textures(objects, lm, textures)
    rigs = [man(i, spec, rig, objects, skins) for i, spec in enumerate(MEN)]
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
    review["shoot"](scene, camera, os.path.join(out, f"male-variety-12m{suffix}.png"), 1920, 1080, 48)
    camera.data.angle_y = math.radians(30)
    direction = Vector((0, -1, .16)).normalized()
    bodies = [Vector((x_of(i), -.2, .98)) for i in range(len(MEN))]
    row_body = review["tiles"](scene, camera, os.path.join(out, "closeup"),
                               [(tuple(t + direction * 5.3), tuple(t)) for t in bodies], 480, 750, 32)
    camera.data.angle_y = math.radians(14)
    quarter = Vector((.45, -.89, -.03)).normalized()
    heads = [Vector((x_of(i), -.03, 1.63 * spec["height"])) for i, spec in enumerate(MEN)]
    row_head = review["tiles"](scene, camera, os.path.join(out, "head"),
                               [(tuple(t + quarter * 2.0), tuple(t)) for t in heads], 480, 480, 32)
    review["save"]([row_body, row_head], os.path.join(out, f"male-variety-closeup{suffix}.png"))
    print("[review] wrote", out)


main()
