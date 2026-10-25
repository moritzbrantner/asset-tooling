"""Male character variety (#380): age and build shape keys, heights and skin tones, for the pinned Blender backend.

Everything here runs on a dressed character in its rest pose, in Blender's rest model space (Z up, front is -Y), and
works on any mesh, so the resident and class outfits, their armour plates, the hair and the facial hair follow the same
keys. As a recipe (``generate``) it authors the keys on a copy of a character variant (``mode: character``, with its
outfit's plates as the optional ``items`` input) or on an item worn on the body (``mode: item``: the item is keyed
against the ``body`` input). The build copies only the morph targets back onto the shipped assets.

- Age keys on the head, eyebrows and facial hair: ``age.young``, ``age.middle``, ``age.old`` and ``age.weathered``.
  They are smooth displacement fields placed on the face landmarks of ``face_variants.landmarks``, and like the face
  keys they never move the cranium, the ears, the back of the head or the neck cut, so hair and headwear keep fitting.
  Eye lids turn around the eyeball centre, so they slide over it instead of cutting in. The eyeballs never move.
- Build keys on every mesh: ``build.lean`` and ``build.heavy`` (the base mesh is the average build). Each vertex is
  scaled away from (or towards) the axis of the bones it is skinned to, blended by its skin weights; meshes that are
  not skinned to the body (rigid plates, facial hair, hair) take the weights of the nearest body vertices. Because the
  displacement grows with the distance from the bone axis, outer layers move a little more than the body under them
  and keep their clearance. The heavy build also fills the cheeks and the jaw line; the lean build hollows them.
  Hanging garments (tabards, robes, aprons) take no leg weights and grow only sideways round the body's vertical axis,
  so their hems hang straight instead of flaring with the thighs.
- Height: a per-character uniform scale of the rig (``HEIGHTS``, about +-9%), set by the consumer.
- Skin tones as base-colour multipliers over the light skin texture (``SKIN_TONES``); the painted aged and weathered
  variants per tone are in ``skin_overlays.py``, the hand-modelled hair and beards in ``hair_beards.py``.
"""
import math

import bpy
from mathutils import Vector
from mathutils.kdtree import KDTree

AGE_KEYS = ["age.young", "age.middle", "age.old", "age.weathered"]
BUILD_KEYS = ["build.lean", "build.heavy"]
BODY_MESHES = ("Male_Peasant_Arms", "Male_Peasant_Body", "Male_Peasant_Feet", "Male_Peasant_Legs", "SuperHero_Male")

# Skin tones: a multiplier over the light skin base colour (linear), from fair to deep brown.
SKIN_TONES = {
    "tone.fair": (1.05, 1, .97),
    "tone.light": (1, 1, 1),
    "tone.olive": (.8, .72, .55),
    "tone.tan": (.68, .52, .38),
    "tone.brown": (.42, .29, .2),
    "tone.deep": (.24, .16, .11),
}

# Build: the radial scale around each bone's axis (lean, heavy), with an extra forward push on the belly.
BUILD = {
    "pelvis": (.87, 1.32), "spine_01": (.8, 1.45), "spine_02": (.82, 1.36), "spine_03": (.87, 1.22),
    "neck_01": (.85, 1.28), "clavicle": (.93, 1.12), "upperarm": (.78, 1.32), "lowerarm": (.84, 1.18),
    "hand": (.95, 1.07), "thigh": (.8, 1.28), "calf": (.85, 1.13),
}
# Extra forward growth of the belly per metre in front of the axis (lean, heavy), and of the seat behind it.
BELLY = {"pelvis": (-.06, .3), "spine_01": (-.12, .6), "spine_02": (-.08, .4)}
SEAT = {"pelvis": (-.04, .14)}
# The height range: a uniform scale of the character root (and everything attached to it).
HEIGHTS = (.91, 1.09)
# Garments that hang from the body (no leg weights, horizontal growth only).
HANGING = ("tabard", "robe", "habit", "smock", "apron", "skirt", "coat")
LEG_BONES = ("thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l", "foot_r", "ball_l", "ball_r")


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def bump(p, centre, radii):
    d = sum(((p[i] - centre[i]) / radii[i]) ** 2 for i in range(3))
    return (1 - d) ** 2 if d < 1 else 0.0


def points(obj):
    m = obj.matrix_world
    return [m @ v.co for v in obj.data.vertices]


def set_key(obj, name, new_points):
    if not obj.data.shape_keys:
        obj.shape_key_add(name="Basis", from_mix=False)
    block = obj.data.shape_keys.key_blocks.get(name) or obj.shape_key_add(name=name, from_mix=False)
    inverse = obj.matrix_world.inverted()
    largest = 0.0
    for index, (v, q) in enumerate(zip(obj.data.vertices, new_points)):
        block.data[index].co = inverse @ q
        largest = max(largest, (block.data[index].co - v.co).length)
    return largest


# --- Age ---------------------------------------------------------------------------------------------------------

def age_fields(lm):
    s, tip, mouth, chin = lm["scale"], lm["tip"], lm["mouth"], lm["chin"]
    eyes = lm["eyes"]
    front_y = tip.y
    brow_z = eyes[0].z + .022 * s

    def lids(p, upper_angle, lower_angle):
        """Turns the lids around the eyeball centre (positive angles close the eye)."""
        q = p.copy()
        for centre, sgn in ((eyes[0], 1), (eyes[1], -1)):
            if p.x * sgn <= 0:
                continue
            w = bump(p, centre, (.028 * s, .03 * s, .024 * s))
            if not w:
                continue
            d = p - centre
            # The upper lid turns down, the lower lid up; nothing at the eye's horizontal line.
            k = smooth(d.z / (.006 * s)) * upper_angle - smooth(-d.z / (.006 * s)) * lower_angle
            a = k * w  # rotation about the X axis: positive turns the front of the eye downward
            c, si = math.cos(a), math.sin(a)
            q = centre + Vector((d.x, d.y * c - d.z * si, d.y * si + d.z * c))
        return q

    def jowls(p, down, out):
        q = p.copy()
        for sgn in (1, -1):
            w = bump(p, (sgn * .05 * s, chin.y + .03 * s, chin.z + .012 * s), (.032 * s, .04 * s, .026 * s))
            q.z -= down * s * w
            q.x += sgn * out * s * w
        return q

    def cheeks(p, inward, back, height=0.0):
        """Hollows (positive) or fills (negative) the cheek under the cheekbone."""
        q = p.copy()
        for sgn in (1, -1):
            w = bump(p, (sgn * .048 * s, tip.y + .035 * s, mouth.z + (.022 + height) * s), (.026 * s, .03 * s, .024 * s))
            q.x -= sgn * inward * s * w
            q.y += back * s * w
        return q

    def cheekbones(p, out, forward):
        q = p.copy()
        for sgn in (1, -1):
            w = bump(p, (sgn * .05 * s, tip.y + .03 * s, eyes[0].z - .022 * s), (.022 * s, .026 * s, .016 * s))
            q.x += sgn * out * s * w
            q.y -= forward * s * w
        return q

    def brow(p, forward, down, outer_droop=0.0):
        q = p.copy()
        w = bump(p, (0, front_y + .04 * s, brow_z), (.075 * s, .03 * s, .016 * s))
        q.y -= forward * s * w
        q.z -= down * s * w
        if outer_droop:
            for sgn in (1, -1):
                o = bump(p, (sgn * .045 * s, front_y + .045 * s, brow_z - .004 * s), (.02 * s, .03 * s, .016 * s))
                q.z -= outer_droop * s * o
        return q

    def nose(p, length, scale):
        q = p.copy()
        t = bump(p, tip, (.018 * s, .022 * s, .02 * s))
        q.y -= length * s * t * .6
        q.z -= length * s * t
        w = bump(p, (0, tip.y + .012 * s, tip.z), (.03 * s, .03 * s, .03 * s))
        q.x += p.x * (scale - 1) * w
        q.y += (p.y - (tip.y + .02 * s)) * (scale - 1) * w
        return q

    def lips(p, thin, corners):
        q = p.copy()
        w = bump(p, (0, mouth.y - .018 * s, mouth.z), (.034 * s, .03 * s, .017 * s))
        q.z -= (p.z - mouth.z) * thin * w
        for sgn in (1, -1):
            c = bump(p, (sgn * .024 * s, mouth.y - .012 * s, mouth.z), (.012 * s, .02 * s, .012 * s))
            q.z -= corners * s * c
        return q

    def chin_shape(p, down, forward, narrow):
        q = p.copy()
        c = bump(p, (0, chin.y + .004 * s, chin.z), (.04 * s, .035 * s, .026 * s))
        q.z -= down * s * c
        q.y -= forward * s * c
        q.x -= p.x * narrow * c
        return q

    def eye_bags(p, amount):
        q = p.copy()
        for centre, sgn in ((eyes[0], 1), (eyes[1], -1)):
            w = bump(p, (centre.x + sgn * .003 * s, centre.y - .006 * s, centre.z - .017 * s), (.017 * s, .016 * s, .008 * s))
            q.y -= amount * s * w
            q.z -= amount * .5 * s * w
        return q

    def folds(p, amount):
        """Cheek fat beside the nose-to-mouth line, pushed forward so the line reads as a fold."""
        q = p.copy()
        for sgn in (1, -1):
            w = bump(p, (sgn * .034 * s, tip.y + .022 * s, mouth.z + .012 * s), (.011 * s, .02 * s, .02 * s))
            q.y -= amount * s * w
            q.z -= amount * .4 * s * w
        return q

    def temples(p, amount):
        q = p.copy()
        for sgn in (1, -1):
            w = bump(p, (sgn * .068 * s, front_y + .06 * s, brow_z + .005 * s), (.012 * s, .025 * s, .02 * s))
            q.x -= sgn * amount * s * w
        return q

    def chain(*steps):
        def f(p):
            q = p
            for step in steps:
                q = step(q)
            return q
        return f

    young = chain(lambda p: cheeks(p, -.003, -.002), lambda p: jowls(p, 0, -.002), lambda p: brow(p, -.0015, -.0005),
                  lambda p: nose(p, -.001, .94), lambda p: chin_shape(p, -.001, 0, .06), lambda p: lips(p, -.15, -.0008),
                  lambda p: lids(p, -.05, .0))
    middle = chain(lambda p: jowls(p, .004, .003), lambda p: brow(p, .002, .001), lambda p: nose(p, .0015, 1.05),
                   lambda p: cheeks(p, .0015, .001, -.008), lambda p: lids(p, .1, -.04), lambda p: lips(p, .15, .001),
                   lambda p: eye_bags(p, .0012), lambda p: folds(p, .0015))
    old = chain(lambda p: jowls(p, .015, .006), lambda p: cheeks(p, .01, .005), lambda p: brow(p, .002, .0025, .005),
                lambda p: nose(p, .008, 1.12), lambda p: lips(p, .7, .005), lambda p: chin_shape(p, .002, -.001, 0),
                lambda p: lids(p, .32, -.14), lambda p: eye_bags(p, .005), lambda p: folds(p, .005), lambda p: temples(p, .006))
    weathered = chain(lambda p: brow(p, .0045, .0018), lambda p: cheekbones(p, .0035, .0025), lambda p: cheeks(p, .004, .002),
                      lambda p: lids(p, .2, .14), lambda p: nose(p, .001, 1.1), lambda p: lips(p, .3, .001),
                      lambda p: folds(p, .0025), lambda p: temples(p, .002))
    return {"age.young": young, "age.middle": middle, "age.old": old, "age.weathered": weathered}


def add_age_keys(head, eyes, brows, landmarks, followers=(), keyed=None):
    """Age keys on the head and eyebrows; ``followers`` (facial hair) take the same field. The eyeballs never move.
    ``keyed`` limits which of the head, eyebrows and followers get the keys (default: all of them)."""
    lm = landmarks(head, eyes)
    fields = age_fields(lm)
    s = lm["scale"]
    brow_top = max(p.z for p in points(brows))
    stats = {}
    for obj in keyed if keyed is not None else (head, brows, *followers):
        base = points(obj)
        for key in AGE_KEYS:
            moved = []
            for p in base:
                fixed = obj is head and (p.z > brow_top + .01 * s or p.z < lm["chin"].z - .035 * s or p.y - lm["tip"].y > .13 * s)
                moved.append(p if fixed else fields[key](p))
            stats.setdefault(key, {})[obj.name] = round(set_key(obj, key, moved), 5)
    return lm, stats


# --- Build -------------------------------------------------------------------------------------------------------

def bone_kind(name):
    for side in ("_l", "_r"):
        if name.endswith(side):
            return name[:-2]
    return name


def bone_axes(rig):
    m = rig.matrix_world
    return {b.name: (m @ b.head_local, m @ b.tail_local) for b in rig.data.bones}


def build_offset(p, bone, axes, which, hanging=False):
    kind = bone_kind(bone)
    if kind not in BUILD or bone not in axes:
        return Vector()
    a, b = axes[bone]
    if hanging:
        # Round the body's vertical axis through the bone, sideways and forward only.
        d = p - a
        d.z = 0
    else:
        u = b - a
        t = max(0.0, min(1.0, (p - a).dot(u) / u.length_squared))
        d = p - (a + u * t)
    k = BUILD[kind][which] - 1
    offset = d * k
    front = max(0.0, -d.y)
    offset.y -= front * BELLY.get(kind, (0, 0))[which]
    offset.y += max(0.0, d.y) * SEAT.get(kind, (0, 0))[which]
    return offset


def skin_weights(obj, rig_bones):
    names = {g.index: g.name for g in obj.vertex_groups if g.name in rig_bones}
    result = []
    for v in obj.data.vertices:
        ws = [(names[g.group], g.weight) for g in v.groups if g.group in names and g.weight > 1e-4]
        total = sum(w for _, w in ws) or 1
        result.append([(n, w / total) for n, w in ws])
    return result


def face_fill(lm, amount):
    """The heavy build's fuller cheeks and jaw line (amount 1), or the lean build's hollow cheeks (amount -1)."""
    s, tip, mouth, chin = lm["scale"], lm["tip"], lm["mouth"], lm["chin"]

    def f(p):
        q = p.copy()
        for sgn in (1, -1):
            w = bump(p, (sgn * .05 * s, tip.y + .04 * s, mouth.z + .005 * s), (.035 * s, .045 * s, .04 * s))
            q.x += sgn * .006 * amount * s * w
            q.y -= .002 * amount * s * w
        c = bump(p, (0, chin.y + .03 * s, chin.z - .012 * s), (.05 * s, .04 * s, .022 * s))
        q.z -= .006 * max(0, amount) * s * c
        q.y -= .006 * max(0, amount) * s * c
        return q
    return f


def add_build_keys(rig, meshes, lm, body=None):
    """Build keys on ``meshes``; ``body`` (default: the body meshes among them) gives the skin weights to follow."""
    axes = bone_axes(rig)
    bones = set(axes)
    body = body if body is not None else [o for o in meshes if o.name.split(".")[0] in BODY_MESHES]
    tree_points, tree_weights = [], []
    for o in body:
        tree_points += points(o)
        tree_weights += skin_weights(o, bones)
    tree = KDTree(len(tree_points))
    for i, p in enumerate(tree_points):
        tree.insert(p, i)
    tree.balance()
    stats = {}
    for obj in meshes:
        base = points(obj)
        own = obj in body  # everything else takes the nearest body weights, so layers follow one field
        weights = skin_weights(obj, bones) if own else None
        hanging = not own and any(h in obj.name for h in HANGING)
        for which, key in enumerate(BUILD_KEYS):
            fill = face_fill(lm, -1 if which == 0 else 1)
            moved = []
            for i, p in enumerate(base):
                if weights is not None and weights[i]:
                    ws = weights[i]
                else:
                    near = tree.find_n(p, 4)
                    total = sum(1 / (d + 1e-4) for _, _, d in near)
                    mix = {}
                    for _, index, d in near:
                        for n, w in tree_weights[index]:
                            mix[n] = mix.get(n, 0) + w / (d + 1e-4) / total
                    ws = list(mix.items())
                if hanging:
                    # Leg and hip weights go to the belly, so the hem hangs straight down from it, not round the thighs.
                    merged = {}
                    for n, w in ws:
                        n = "spine_01" if n in LEG_BONES or n == "pelvis" else n
                        merged[n] = merged.get(n, 0) + w
                    ws = list(merged.items())
                offset = Vector()
                for n, w in ws:
                    offset += build_offset(p, n, axes, which, hanging) * w
                head_w = sum(w for n, w in ws if n in ("Head", "neck_01"))
                q = p + offset
                if head_w and obj.name.split(".")[0] != "Eyes":
                    q = q + (fill(p) - p) * head_w
                moved.append(q)
            stats.setdefault(key, {})[obj.name] = round(set_key(obj, key, moved), 4)
    return stats


def tone(material, factor):
    """Multiplies the skin base colour by factor (a copy of the material is expected)."""
    shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    base = shader.inputs["Base Color"]
    if not base.is_linked:
        base.default_value = (*[c * f for c, f in zip(base.default_value[:3], factor)], 1)
        return
    mix = material.node_tree.nodes.new("ShaderNodeMix")
    mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
    mix.inputs[0].default_value = 1.0
    material.node_tree.links.new(base.links[0].from_socket, mix.inputs[6])
    mix.inputs[7].default_value = (*factor, 1)
    material.node_tree.links.new(mix.outputs[2], base)


# --- Recipe --------------------------------------------------------------------------------------------------------

HEAD, EYES, BROWS = "SuperHero_Male", "Eyes", "Eyebrows"
MODES = ("character", "item")


def validate(p, inputs):
    if type(p) is not dict or set(p) - {"schemaVersion", "mode", "age"} or p.get("schemaVersion") != 1:
        raise ValueError("male variety takes schemaVersion 1, mode and optionally age")
    if p.get("mode") not in MODES or type(p.get("age", False)) is not bool:
        raise ValueError(f"mode must be one of {MODES} and age a boolean")
    needed = {"source", "face"} | ({"body"} if p["mode"] == "item" else set())
    allowed = needed | ({"items"} if p["mode"] == "character" else set())
    if not needed <= set(inputs) or set(inputs) - allowed:
        raise ValueError(f"mode {p['mode']} takes the inputs {sorted(allowed)}")


def import_glb(path):
    """Imports a GLB at its node rest pose. The composed characters bind the head skin a little differently from the
    outfit skin at the neck, so Blender re-poses a few neck vertices by up to 2 mm; the transfer allows for that."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path, bone_heuristic="BLENDER", guess_original_bind_pose=False)
    return [o for o in bpy.data.objects if o not in before]


def generate(output_path, arguments, inputs):
    """Authors the age and build keys on a copy of ``source`` and exports it with its morph targets.

    - ``mode: character``: ``source`` is a character variant (body, head and outfit); its plates (``items``) come
      along. The head and eyebrows get the age keys, every mesh but the eyes the build keys.
    - ``mode: item``: ``source`` holds meshes in the character's rest model space (hair, facial hair, plates), keyed
      against the ``body`` character; ``age: true`` also gives them the age keys (facial hair).
    """
    validate(arguments, inputs)
    face = inputs.load_source("face")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    character = arguments["mode"] == "character"
    body = import_glb(inputs["source"] if character else inputs["body"])
    items = import_glb(inputs["items"]) if "items" in inputs else []
    if not character:
        items = import_glb(inputs["source"])
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    rig = next(o for o in body if o.type == "ARMATURE")
    rig.data.pose_position = "REST"
    bpy.context.view_layer.update()
    named = {o.name: o for o in body if o.type == "MESH"}
    head, eyes, brows = named[HEAD], named[EYES], named[BROWS]
    body_meshes = [o for o in body if o.type == "MESH" and o.name.split(".")[0] in BODY_MESHES]
    meshes = [o for o in (body if character else []) + items if o.type == "MESH" and not o.name.startswith("Icosphere") and o.name != EYES]
    if character:
        keyed = [head, brows]
    else:
        keyed = [o for o in items if o.type == "MESH"] if arguments.get("age") else []
    lm, age = add_age_keys(head, eyes, brows, face["landmarks"], keyed=keyed)
    build = add_build_keys(rig, meshes, lm, body=body_meshes)
    exported = (body + items) if character else items
    bpy.ops.object.select_all(action="DESELECT")
    for o in exported:
        if not o.name.startswith("Icosphere"):
            o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True, export_texcoords=True,
        export_normals=True, export_tangents=False, export_animations=False, export_skins=True, export_morph=True,
        export_morph_normal=True, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "male-variety-v1", "mode": arguments["mode"], "age": age, "build": build,
            "keyedMeshes": sorted(o.name for o in meshes)}
