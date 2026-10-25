"""Male character variety (#380), block-out: age and build shape keys, extra hairstyles and skin tones.

WIP for the phase 1 review sheet. Everything here runs on a dressed character in its rest pose, in Blender's rest model
space (Z up, front is -Y), and works on any mesh, so the class and resident outfits follow the same keys:

- Age keys on the head, eyebrows and facial hair: ``age.young``, ``age.middle``, ``age.old`` and ``age.weathered``.
  They are smooth displacement fields placed on the face landmarks of ``face_variants.landmarks``, and like the face
  keys they never move the cranium, the ears, the back of the head or the neck cut, so hair and headwear keep fitting.
  Eye lids turn around the eyeball centre, so they slide over it instead of cutting in. The eyeballs never move.
- Build keys on every mesh: ``build.lean`` and ``build.heavy`` (the base mesh is the average build). Each vertex is
  scaled away from (or towards) the axis of the bones it is skinned to, blended by its skin weights; meshes that are
  not skinned to the body (rigid plates, facial hair, hair) take the weights of the nearest body vertices. Because the
  displacement grows with the distance from the bone axis, outer layers move a little more than the body under them
  and keep their clearance. The heavy build also fills the cheeks and the jaw line; the lean build hollows them.
- Hairstyles derived from the Universal Base Characters ``Hair_Buzzed`` cap, the only close-fitting cap in the pack:
  ``hair.balding`` (horseshoe), ``hair.receding`` (high temples), ``hair.swept`` (short, swept back with volume) and
  ``hair.tied`` (a close cap with a tied tail at the nape).
- Skin tones as base-colour multipliers over the light skin texture (``SKIN_TONES``).
"""
import math

import bmesh
import bpy
from mathutils import Vector
from mathutils.kdtree import KDTree

AGE_KEYS = ["age.young", "age.middle", "age.old", "age.weathered"]
BUILD_KEYS = ["build.lean", "build.heavy"]
BODY_MESHES = ("Male_Peasant_Arms", "Male_Peasant_Body", "Male_Peasant_Feet", "Male_Peasant_Legs", "SuperHero_Male")

# Skin tones: a multiplier over the light skin base colour (linear), from fair to deep brown.
SKIN_TONES = {
    "skin.fair": (1.05, 1.0, .97),
    "skin.light": (1.0, 1.0, 1.0),
    "skin.olive": (.8, .72, .55),
    "skin.tan": (.68, .52, .38),
    "skin.brown": (.42, .29, .2),
    "skin.deep": (.24, .16, .11),
}

# Build: the radial scale around each bone's axis (lean, heavy), with an extra forward push on the belly.
BUILD = {
    "pelvis": (.92, 1.22), "spine_01": (.88, 1.3), "spine_02": (.9, 1.24), "spine_03": (.93, 1.14),
    "neck_01": (.9, 1.18), "clavicle": (.96, 1.07), "upperarm": (.86, 1.2), "lowerarm": (.9, 1.12),
    "hand": (.97, 1.05), "thigh": (.89, 1.18), "calf": (.92, 1.08),
}
# Extra forward growth of the belly per metre in front of the axis (heavy only), and of the seat behind it.
BELLY = {"pelvis": .2, "spine_01": .45, "spine_02": .3}
SEAT = {"pelvis": .1}


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


def add_age_keys(head, eyes, brows, landmarks, followers=()):
    """Age keys on the head and eyebrows; ``followers`` (facial hair) take the same field. The eyeballs never move."""
    lm = landmarks(head, eyes)
    fields = age_fields(lm)
    s = lm["scale"]
    brow_top = max(p.z for p in points(brows))
    stats = {}
    for obj in (head, brows, *followers):
        base = points(obj)
        for key in AGE_KEYS:
            moved = []
            for p in base:
                fixed = obj is head and (p.z > brow_top + .01 * s or p.z < lm["chin"].z - .035 * s or p.y - lm["tip"].y > .13 * s)
                moved.append(p if fixed else fields[key](p))
            stats.setdefault(key, {})[obj.name] = round(set_key(obj, key, moved), 5)
    for key in AGE_KEYS:
        set_key(eyes, key, points(eyes))
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


def build_offset(p, bone, axes, which):
    kind = bone_kind(bone)
    if kind not in BUILD or bone not in axes:
        return Vector()
    a, b = axes[bone]
    u = b - a
    t = max(0.0, min(1.0, (p - a).dot(u) / u.length_squared))
    d = p - (a + u * t)
    k = BUILD[kind][which] - 1
    offset = d * k
    if which == 1:
        front = max(0.0, -d.y)
        offset.y -= front * BELLY.get(kind, 0)
        offset.y += max(0.0, d.y) * SEAT.get(kind, 0)
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


def add_build_keys(rig, meshes, lm):
    axes = bone_axes(rig)
    bones = set(axes)
    body = [o for o in meshes if o.name.split(".")[0] in BODY_MESHES]
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
                offset = Vector()
                for n, w in ws:
                    offset += build_offset(p, n, axes, which) * w
                head_w = sum(w for n, w in ws if n in ("Head", "neck_01"))
                q = p + offset
                if head_w and obj.name.split(".")[0] != "Eyes":
                    q = q + (fill(p) - p) * head_w
                moved.append(q)
            stats.setdefault(key, {})[obj.name] = round(set_key(obj, key, moved), 4)
    return stats


# --- Hair --------------------------------------------------------------------------------------------------------

def copy_object(src, name):
    obj = src.copy()
    obj.data = src.data.copy()
    obj.name = obj.data.name = name
    for c in src.users_collection:
        c.objects.link(obj)
    if obj.data.shape_keys:
        obj.shape_key_clear()
    return obj


def cut(obj, keep):
    """Deletes the faces of obj whose world centre fails keep(p)."""
    m = obj.matrix_world
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    gone = [f for f in bm.faces if not keep(m @ f.calc_center_median())]
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


def puff(obj, thickness):
    """Pushes each vertex out along its normal by thickness(p) (world metres)."""
    m, inverse = obj.matrix_world, obj.matrix_world.inverted()
    obj.data.update()
    for v in obj.data.vertices:
        p = m @ v.co
        n = (m.to_3x3() @ v.normal).normalized()
        v.co = inverse @ (p + n * thickness(p))


def shell(obj, depth):
    mod = obj.modifiers.new("shell", "SOLIDIFY")
    mod.thickness, mod.offset, mod.use_even_offset = depth, -1, False
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def hairstyles(buzzed):
    """New hairstyles as copies of the Hair_Buzzed cap, riding the same bone."""
    top = max(p.z for p in points(buzzed))
    styles = {}

    balding = copy_object(buzzed, "hair.balding")
    cut(balding, lambda p: p.z < top - .07 + .045 * smooth((p.y - .0) / .09) and p.y > -.045)
    puff(balding, lambda p: .003)
    shell(balding, .003)
    styles["hair.balding"] = balding

    receding = copy_object(buzzed, "hair.receding")
    cut(receding, lambda p: p.z < top - .07 or p.y > -.03 - .05 * (1 - smooth(abs(p.x) / .022)))
    puff(receding, lambda p: .003)
    shell(receding, .003)
    styles["hair.receding"] = receding

    swept = copy_object(buzzed, "hair.swept")
    puff(swept, lambda p: .003 + .014 * smooth((p.z - (top - .085)) / .07) * (1 - .4 * smooth((p.y + .02) / .1)))
    shell(swept, .004)
    styles["hair.swept"] = swept

    tied = copy_object(buzzed, "hair.tied")
    puff(tied, lambda p: .004 + .004 * smooth((p.z - (top - .08)) / .06))
    shell(tied, .003)
    styles["hair.tied"] = tied
    tail(tied, top)
    return styles


def tail(obj, top):
    """A tied tail at the nape, joined into obj: a tapering tube from the back of the head down the neck."""
    m_inv = obj.matrix_world.inverted()
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv.active
    # The tail's centre line (world): starts at the back of the head, bends down over the nape.
    path = [Vector((0, .1, top - .1)), Vector((0, .118, top - .135)), Vector((0, .124, top - .18)), Vector((0, .12, top - .23)),
            Vector((0, .112, top - .27))]
    radii = [.02, .019, .016, .012, .004]
    sides = 10
    rings = []
    for c, r in zip(path, radii):
        rings.append([bm.verts.new(m_inv @ (c + Vector((math.cos(a) * r, math.sin(a) * r * .8, 0))))
                      for a in (2 * math.pi * j / sides for j in range(sides))])
    for i in range(len(rings) - 1):
        for j in range(sides):
            f = bm.faces.new((rings[i][j], rings[i][(j + 1) % sides], rings[i + 1][(j + 1) % sides], rings[i + 1][j]))
            f.smooth = True
            for loop in f.loops:
                loop[uv].uv = (.3, .5)
    bm.normal_update()
    bm.to_mesh(obj.data)
    bm.free()


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
