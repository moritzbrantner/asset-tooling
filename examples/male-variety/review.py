"""Male variety review sheets (#380), rendered headless from a built humanoid-ranger-male bundle:

    blender -b --factory-startup --python examples/male-variety/review.py -- <bundle dir> <out dir> [suffix]

Eight men wear the Greyhaven Marshal's outfit (``outfit.knight`` without its bascinet, in the Greyhaven blue), each
composed the way a consumer would from the bundle's ``humanoid-appearance`` descriptor: the character variant of his
skin, the armour plates on their sockets, his hairstyle and facial hair entries, the morph weights of his age, build
and face options on every mesh, his skin tone (a base-colour factor over the Light skin), the painted head skin of his
age and stubble from the ``skin.head`` entry, and his height as the rig's scale. Lit like the #377/#379 sheets
(procedural sky at 0.06 and a 3.5 sun):

- ``male-variety-12m<suffix>.png``: the line-up in Idle_Loop at the mmorpg game camera (12 m from a pivot 0.6 m up,
  pitched 0.42 rad, 50 degree vertical field of view);
- ``male-variety-closeup<suffix>.png``: one front tile per man, and below it a three-quarter head tile.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
review = {"__name__": "class_outfits_review"}
exec(open(os.path.join(ROOT, "examples", "class-outfits", "review.py")).read().rsplit("\nmain()", 1)[0], review)

FACTION = (0.05, 0.08, 0.15, 1)  # Greyhaven blue (resident.marshal)
# The eight men: height, age, build, face options, base skin and tone, hair, tint, facial hair and stubble.
MEN = [
    {"label": "young / lean", "height": 1.06, "age": "age.young", "build": "build.lean", "face": ["face.narrow", "eyes.large"],
     "skin": "skin.light", "tone": "tone.light", "hair": "hair.swept", "tint": "tint.brown", "beard": [], "stubble": True},
    {"label": "middle / average", "height": 1.0, "age": "age.middle", "build": "build.average", "face": ["face.broad", "nose.broad"],
     "skin": "skin.light", "tone": "tone.olive", "hair": "hair.simple-parted", "tint": "tint.black", "beard": ["beard.short"]},
    {"label": "old / heavy", "height": .93, "age": "age.old", "build": "build.heavy", "face": ["nose.long"],
     "skin": "skin.light", "tone": "tone.fair", "hair": "hair.balding", "tint": "tint.grey", "beard": ["beard.long", "beard.moustache"]},
    {"label": "weathered / lean", "height": 1.09, "age": "age.weathered", "build": "build.lean", "face": ["eyes.narrow", "mouth.thin"],
     "skin": "skin.light", "tone": "tone.tan", "hair": "hair.buzzed", "tint": "tint.brown", "beard": ["beard.goatee", "beard.moustache"], "stubble": True},
    {"label": "young / heavy", "height": .96, "age": "age.young", "build": "build.heavy", "face": ["nose.broad", "mouth.full"],
     "skin": "skin.light", "tone": "tone.brown", "hair": "hair.tied", "tint": "tint.black", "beard": []},
    {"label": "middle / lean", "height": 1.03, "age": "age.middle", "build": "build.lean", "face": ["face.narrow", "nose.long"],
     "skin": "skin.light", "tone": "tone.deep", "hair": None, "tint": "tint.black", "beard": ["beard.full", "beard.moustache"]},
    {"label": "old / average", "height": .91, "age": "age.old", "build": "build.average", "face": ["face.broad", "eyes.narrow"],
     "skin": "skin.light", "tone": "tone.light", "hair": "hair.receding", "tint": "tint.grey", "beard": ["beard.walrus"], "stubble": True},
    {"label": "weathered / heavy", "height": 1.01, "age": "age.weathered", "build": "build.heavy", "face": ["face.broad", "mouth.thin"],
     "skin": "skin.dark", "tone": None, "hair": "hair.long", "tint": "tint.blond", "beard": ["beard.short"]},
]
SPACING = 1.8


def x_of(i):
    return (i - (len(MEN) - 1) / 2) * SPACING


def option(section, option_id):
    return next(o for o in section["options"] if o["id"] == option_id)


def image_nodes(material):
    """The image nodes feeding the base colour and the normal map of a material."""
    tree = material.node_tree
    shader = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")

    def upstream(socket, kind):
        queue = [socket.links[0].from_node] if socket.is_linked else []
        while queue:
            node = queue.pop(0)
            if node.type == kind:
                return node
            queue += [i.links[0].from_node for i in node.inputs if i.is_linked]
        return None
    normal_map = upstream(shader.inputs["Normal"], "NORMAL_MAP")
    return upstream(shader.inputs["Base Color"], "TEX_IMAGE"), normal_map and upstream(normal_map.inputs["Color"], "TEX_IMAGE")


def head_skins(bundle, appearance):
    """The painted head skins of the skin.head entry: material name -> (base colour image, normal image)."""
    names = {texture["material"] for texture in appearance["headSkins"]["textures"]}
    objects = review["imported"](os.path.join(bundle, "scenes", appearance["headSkins"]["entry"], "default.gltf"))
    skins = {}
    for o in objects:
        if o.type == "MESH":
            material = o.data.materials[0]
            name = next(n for n in names if material.name == n or material.name.startswith(n + ".0"))
            color, normal = image_nodes(material)
            skins[name] = (color.image, normal.image)
        bpy.data.objects.remove(o)
    return skins


def compose(i, spec, bundle, info, rest, skins):
    appearance = info["appearance"]
    name = f"man{i}"
    appearance["presets"].append({"id": f"class.{name}", "outfit": "outfit.knight", "skin": spec["skin"], "hair": spec["hair"],
                                  "tint": spec["tint"], "facialHair": spec["beard"], "hiddenArmor": ["knight.bascinet"]})
    review["PROPS"][name] = []
    before = set(bpy.data.objects)
    rig = review["dress"](bundle, info, rest, name, x_of(i))
    objects = [o for o in bpy.data.objects if o not in before]
    weights = {}
    for section, choice in (("ages", spec["age"]), ("builds", spec["build"])):
        weights.update(option(appearance[section], choice)["morphs"])
    for feature in appearance["face"]["features"]:
        for choice in spec["face"]:
            if any(o["id"] == choice for o in feature["options"]):
                weights.update(option(feature, choice)["morphs"])
    for o in objects:
        if o.type == "MESH" and o.data.shape_keys:
            for block in o.data.shape_keys.key_blocks[1:]:
                block.value = weights.get(block.name, 0.0)
    tint = next(t for t in appearance["tints"] if t["id"] == spec["tint"])["baseColorFactor"]
    brows = appearance["eyebrows"]
    tone = spec["tone"] and next(t for t in appearance["skinTones"]["tones"] if t["id"] == spec["tone"])["baseColorFactor"]
    age_skin = option(appearance["ages"], spec["age"])["skin"]
    shade = appearance["headSkins"]["stubbleShades"][spec["tint"]] if spec.get("stubble") else None
    painted = next((t["material"] for t in appearance["headSkins"]["textures"]
                    if t["skin"] == spec["skin"] and t["age"] == age_skin and t.get("stubble") == shade), None)
    for o in objects:
        if o.type != "MESH":
            continue
        for slot, material in enumerate(o.data.materials):
            if material is None:
                continue
            base = material.name.split(".")[0]
            if base.startswith("faction"):
                next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = FACTION
            beard = next((b for b in appearance["facialHair"]["options"] if o.name.startswith(b["node"])), None)
            if beard and base in beard["tintMaterials"]:
                copy = material.copy()
                review["tinted"](copy, tint)
                o.data.materials[slot] = copy
            if o.name.split(".")[0] in brows["nodes"] and base in brows["tintMaterials"]:
                copy = material.copy()
                review["tinted"](copy, tint)
                o.data.materials[slot] = copy
            if base == appearance["headSkins"]["material"] and painted:
                copy = material.copy()
                color, normal = image_nodes(copy)
                color.image, normal.image = skins[painted]
                o.data.materials[slot] = material = copy
            if tone and base in appearance["skinTones"]["materials"]:
                copy = material.copy()
                review["tinted"](copy, tone)
                o.data.materials[slot] = copy
    rig.scale = (spec["height"],) * 3
    return rig


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
    bundle, out = args[:2]
    suffix = args[2] if len(args) > 2 else ""
    os.makedirs(out, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    scene = bpy.context.scene
    info = review["attachments"](bundle)
    appearance = info["appearance"]
    default = os.path.join(bundle, "scenes", appearance["character"], "default.gltf")
    rest = review["gltf_rest_worlds"](default)
    for o in review["imported"](default):
        bpy.data.objects.remove(o)
    skins = head_skins(bundle, appearance)
    rigs = [compose(i, spec, bundle, info, rest, skins) for i, spec in enumerate(MEN)]
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
