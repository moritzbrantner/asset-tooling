"""Young residents (docs/young-residents.md, #556): children and teenagers on the adults' 65-joint rig.

One run builds one figure from the CC0 Peasant outfit, a Universal Base Characters head and pack hair, always dressed. Only
the head and neck are kept from the base body. The age proportions are baked into the rest pose as new joint positions and
vertex positions: every joint keeps the adult's rotation, so adult clips play by joint name. The face is shaped by morph
targets, one linear displacement per slider, placed on the landmarks of ``face_variants.py``.

``arguments`` is ``figure``. Declared inputs are the recipe's helper ``face`` (``face_variants.py``) and the source glTF,
buffer and texture files, read by file name. Freckles are seeded by the figure's name. Tints are left to the descriptor: the
skin, hair and outfit textures here are untinted.
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector

RECIPE = "young-residents-v1"
TEXTURE_SIZE = 1024
# (width, length) of each bone relative to the figure's overall scale.
PROFILES = {
    "teen_m": {"Head": (1.06, 1.06), "neck_01": (.86, 1.05), "pelvis": (.88, 1), "spine": (.88, 1), "clavicle": (.9, .92), "upperarm": (.8, 1), "lowerarm": (.8, 1),
               "hand": (.78, .78), "fingers": (.78, .78), "thigh": (.82, 1.03), "calf": (.82, 1.03), "foot": (.94, .94), "ball": (.94, .94)},
    "teen_f": {"Head": (1.04, 1.04), "neck_01": (.74, 1.1), "pelvis": (.88, 1), "spine": (.8, 1), "clavicle": (.74, .74), "upperarm": (.68, .98), "lowerarm": (.68, .98),
               "hand": (.7, .72), "fingers": (.7, .72), "thigh": (.8, 1.03), "calf": (.78, 1.03), "foot": (.86, .86), "ball": (.86, .86)},
    "child_m": {"Head": (1.25, 1.25), "neck_01": (.82, .78), "pelvis": (.92, 1), "spine": (.92, .98), "clavicle": (.84, .86), "upperarm": (.8, .94), "lowerarm": (.8, .94),
                "hand": (.76, .76), "fingers": (.76, .76), "thigh": (.86, .92), "calf": (.86, .92), "foot": (1, 1), "ball": (1, 1)},
    "child_f": {"Head": (1.24, 1.24), "neck_01": (.76, .8), "pelvis": (.92, 1), "spine": (.86, .98), "clavicle": (.74, .76), "upperarm": (.72, .94), "lowerarm": (.72, .94),
                "hand": (.7, .72), "fingers": (.7, .72), "thigh": (.84, .92), "calf": (.82, .92), "foot": (.94, .94), "ball": (.94, .94)},
}
FIGURES = {
    "teen-boy": {"head": "Male", "hair": "Hair_Buzzed", "profile": "teen_m", "height": 1.66, "paint": {"blush": .1}, "creases": .2, "browThin": .5},
    "teen-girl": {"head": "Female", "hair": "Hair_Long", "profile": "teen_f", "height": 1.55, "skirt": (.2, .26, .34), "paint": {"blush": .25, "lips": .2, "freckles": 70}, "creases": .3, "browThin": .55},
    "child-boy": {"head": "Male", "hair": "Hair_SimpleParted", "hairFlat": .62, "profile": "child_m", "height": 1.3, "paint": {"blush": .26, "freckles": 90}, "creases": .12, "browThin": .48},
    "child-girl": {"head": "Female", "hair": "Hair_Buns", "profile": "child_f", "height": 1.25, "skirt": (.4, .14, .1), "paint": {"blush": .3, "lips": .12}, "creases": .3, "browThin": .55},
}
SLIDERS = ("low_face", "face_w", "jaw_w", "chin_w", "chin_len", "cheek", "cheekbone", "eye_size", "eye_space", "eye_tilt", "eye_open", "lid_full",
           "nose_size", "nose_bridge", "nose_w", "nose_len", "lips", "mouth_w", "smile", "brow_h", "brow_ridge")
FINGERS = ("index", "middle", "ring", "pinky", "thumb")
MAIN_CHILD = {"root": "pelvis", "pelvis": "spine_01", "spine_03": "neck_01", "hand_l": "middle_01_l", "hand_r": "middle_01_r"}
NECK_HALF_WIDTH = .056  # male head: the neck flares into the trapezius above the collar, which shows on a slim frame
SKIRT_RINGS, SKIRT_SEGMENTS = 12, 72
SKIRT_SWING = .6  # how much of the hem follows the thighs; the rest stays with the pelvis
BOOT_ABOVE_HEM = .03  # metres of boot shaft kept above the hem


def smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "figure"} or arguments["schemaVersion"] != 1 or arguments["figure"] not in FIGURES:
        raise ValueError("young residents require schemaVersion 1 and a known figure")
    if "face" not in inputs:
        raise ValueError("young residents need the declared face input")


def bone_profile(name, profile):
    if name.startswith(FINGERS):
        return profile["fingers"]
    if name.startswith("spine"):
        return profile["spine"]
    return profile.get(name.rsplit("_", 1)[0] if name.endswith(("_l", "_r")) else name, (1, 1))


def imported(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    # The importer adds a sphere it uses to draw the bones.
    for o in [x for x in new if x.type == "MESH" and x.name.startswith("Icosphere")]:
        new.remove(o)
        bpy.data.objects.remove(o)
    return new


def bsdf_of(material):
    return next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def base_texture(material):
    node = bsdf_of(material).inputs["Base Color"].links[0].from_node
    while node.type != "TEX_IMAGE":
        node = next(s.links[0].from_node for s in node.inputs if s.is_linked)
    return node


def group_weight(obj, vertex, names):
    wanted = {obj.vertex_groups[n].index for n in names if n in obj.vertex_groups}
    return sum(g.weight for g in vertex.groups if g.group in wanted)


def keep_head_only(obj):
    """The Ranger head subset: everything below the neck is removed, and the neck ring follows the neck alone."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    doomed = [bm.verts[v.index] for v in obj.data.vertices if group_weight(obj, v, ("neck_01", "Head")) < .5]
    bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    keep = {obj.vertex_groups[n].index for n in ("neck_01", "Head") if n in obj.vertex_groups}
    for v in obj.data.vertices:
        for group in [g.group for g in v.groups if g.group not in keep]:
            obj.vertex_groups[group].remove([v.index])


def soften_tunic(body):
    """Girls' tunics lose the shoulder lacing and the diamond buckle."""
    bm = bmesh.new()
    bm.from_mesh(body.data)
    seen, doomed = set(), []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, island = [v], []
        seen.add(v.index)
        while stack:
            c = stack.pop()
            island.append(c)
            for edge in c.link_edges:
                n = edge.other_vert(c)
                if n.index not in seen:
                    seen.add(n.index)
                    stack.append(n)
        top = max(i.co.z for i in island)
        inner, outer = min(abs(i.co.x) for i in island), max(abs(i.co.x) for i in island)
        if (len(island) <= 70 and top > 1.5 and inner > .22) or (len(island) <= 40 and outer < .06 and top < 1.16 and max(i.co.y for i in island) < -.09):
            doomed += island
    bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(body.data)
    bm.free()


def skirt_mesh(arm, legs, body, colour):
    """A long skirt tucked under the tunic, fitted to the trousers it covers and skinned to the pelvis and thighs."""
    hem_top = min(v.co.z for v in body.data.vertices) + .1
    leg_points = [v.co.copy() for v in legs.data.vertices]
    knee, foot = arm.data.bones["calf_l"].head_local.z, arm.data.bones["foot_l"].head_local.z
    hem = foot + (knee - foot) * .34
    centre_y = sum(p.y for p in leg_points) / len(leg_points)
    covered = [p for p in leg_points if hem - .05 < p.z < hem_top + .05]
    near_top = [p for p in leg_points if abs(p.z - hem_top) < .07]
    rx_top, ry_top = max(abs(p.x) for p in near_top) + .02, max(abs(p.y - centre_y) for p in near_top) + .02
    rx_hem, ry_hem = max(abs(p.x) for p in covered) + .09, max(abs(p.y - centre_y) for p in covered) + .09
    bm = bmesh.new()
    grid = []
    for i in range(SKIRT_RINGS + 1):
        t = i / SKIRT_RINGS
        rx, ry = rx_top + (rx_hem - rx_top) * t ** .7, ry_top + (ry_hem - ry_top) * t ** .7
        ring = []
        for j in range(SKIRT_SEGMENTS):
            a = 2 * math.pi * j / SKIRT_SEGMENTS
            fold = 1 + t ** 1.4 * (.06 * math.sin(a * 11 + .6) + .025 * math.sin(a * 23 + 1.9))
            ring.append(bm.verts.new((math.cos(a) * rx * fold, centre_y + math.sin(a) * ry * fold, hem_top + (hem - hem_top) * t)))
        grid.append(ring)
    for i in range(SKIRT_RINGS):
        for j in range(SKIRT_SEGMENTS):
            k = (j + 1) % SKIRT_SEGMENTS
            bm.faces.new((grid[i][j], grid[i][k], grid[i + 1][k], grid[i + 1][j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new("skirt")
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("skirt", mesh)
    bpy.context.scene.collection.objects.link(obj)
    pelvis, left, right = (obj.vertex_groups.new(name=n) for n in ("pelvis", "thigh_l", "thigh_r"))
    side = 1 if arm.data.bones["thigh_l"].head_local.x > 0 else -1
    for v in mesh.vertices:
        # The legs share the hem across the middle, so the cloth can't tear there when they swing apart.
        t = (hem_top - v.co.z) / (hem_top - hem) * SKIRT_SWING
        to_left = smooth(-rx_hem * .55, rx_hem * .55, v.co.x * side)
        pelvis.add([v.index], 1 - t, "REPLACE")
        left.add([v.index], t * to_left, "REPLACE")
        right.add([v.index], t * (1 - to_left), "REPLACE")
    obj.parent = arm
    obj.modifiers.new("Armature", "ARMATURE").object = arm
    material = bpy.data.materials.new("skirt")
    material.use_nodes = True
    bsdf_of(material).inputs["Base Color"].default_value = (*colour, 1)
    bsdf_of(material).inputs["Roughness"].default_value = .9
    mesh.materials.append(material)
    return obj


def paint_face(head, lm, paint, seed, bump):
    """Blush, lip colour, a soft lash line and seeded freckles, painted through a position map of the head's UVs."""
    tex = base_texture(head.material_slots[0].material)
    size = TEXTURE_SIZE
    image = tex.image.copy()
    image.scale(size, size)
    px = np.empty(4 * size * size, dtype=np.float32)
    image.pixels.foreach_get(px)
    px = px.reshape(size, size, 4)
    pos, mask = np.zeros((size, size, 3)), np.zeros((size, size), bool)
    mesh = head.data
    mesh.calc_loop_triangles()
    uvs = mesh.uv_layers.active.data
    for tri in mesh.loop_triangles:
        uv = np.array([uvs[loop].uv for loop in tri.loops]) * size
        p = np.array([mesh.vertices[v].co for v in tri.vertices])
        x0, y0 = np.clip(np.floor(uv.min(0)).astype(int), 0, size - 1)
        x1, y1 = np.clip(np.ceil(uv.max(0)).astype(int), 0, size - 1)
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        area = (uv[1, 0] - uv[0, 0]) * (uv[2, 1] - uv[0, 1]) - (uv[2, 0] - uv[0, 0]) * (uv[1, 1] - uv[0, 1])
        if abs(area) < 1e-9:
            continue
        b1 = ((gx + .5 - uv[0, 0]) * (uv[2, 1] - uv[0, 1]) - (uv[2, 0] - uv[0, 0]) * (gy + .5 - uv[0, 1])) / area
        b2 = ((uv[1, 0] - uv[0, 0]) * (gy + .5 - uv[0, 1]) - (gx + .5 - uv[0, 0]) * (uv[1, 1] - uv[0, 1])) / area
        b0 = 1 - b1 - b2
        inside = (b0 >= -.02) & (b1 >= -.02) & (b2 >= -.02)
        pos[gy[inside], gx[inside]] = b0[inside, None] * p[0] + b1[inside, None] * p[1] + b2[inside, None] * p[2]
        mask[gy[inside], gx[inside]] = True

    def field(centre, radii):
        d = sum(((pos[..., i] - centre[i]) / radii[i]) ** 2 for i in range(3))
        return np.where(mask & (d < 1), (1 - d) ** 2, 0.0)

    def multiply(weight, colour):
        px[..., :3] *= 1 - weight[..., None] * (1 - np.array(colour))

    s, tip, mouth = lm["scale"], lm["tip"], lm["mouth"]
    cheeks = sum(field((n * .045 * s, tip.y + .04 * s, tip.z + .004 * s), (.038 * s, .06 * s, .03 * s)) for n in (1, -1))
    multiply(np.minimum(cheeks, 1) * paint.get("blush", 0), (1, .74, .68))
    multiply(field((0, mouth.y, mouth.z), (.032 * s, .05 * s, .013 * s)) * paint.get("lips", 0), (.82, .42, .4))
    for centre in lm["eyes"]:
        e = np.sqrt(((pos[..., 0] - centre.x) / (.0165 * s)) ** 2 + ((pos[..., 2] - centre.z) / (.009 * s)) ** 2)
        multiply(np.where(mask & (pos[..., 1] < centre.y), np.exp(-((e - 1) / .22) ** 2), 0) * .12, (.45, .34, .3))
    count = int(paint.get("freckles", 0))
    if count:
        rng = np.random.RandomState(seed)
        zone = np.argwhere(cheeks + field((0, tip.y, tip.z + .012 * s), (.03 * s, .05 * s, .03 * s)) > .2)
        for y, x in zone[rng.choice(len(zone), count)]:
            r, strength = rng.randint(1, 3), rng.uniform(.15, .38)
            yy, xx = np.mgrid[max(y - r, 0):min(y + r + 1, size), max(x - r, 0):min(x + r + 1, size)]
            g = np.exp(-((yy - y) ** 2 + (xx - x) ** 2) / (.5 * r * r))
            px[yy, xx, :3] *= 1 - (g * strength)[..., None] * (1 - np.array((.62, .46, .34)))
    image.pixels.foreach_set(np.clip(px, 0, 1).ravel())
    image.update()
    image.pack()
    tex.image = image
    return image


def slider_fields(lm, old, bump):
    """One linear displacement per slider, so any morph weight in -1..1 is meaningful."""
    s, tip, mouth, chin = lm["scale"], lm["tip"], lm["mouth"], lm["chin"]
    left, right = lm["eyes"]
    eye_z = left.z
    sides, eyes = (1, -1), ((left, 1), (right, -1))

    def reused(name):
        return lambda p, eyeball: Vector() if eyeball else old[name](p) - p

    def skin(fn):
        return lambda p, eyeball: Vector() if eyeball else fn(p)

    def both(fn):
        return lambda p: sum((fn(p, n) for n in sides), Vector())

    def around_eye(fn):
        def field(p, eyeball=False):
            d = Vector()
            for centre, n in eyes:
                if p.x * n > 0:
                    d += fn(p, centre, n, eyeball)
            return d
        return field

    def low_face(p):
        d = Vector()
        front = 1 - smooth(tip.y + .08 * s, tip.y + .17 * s, p.y)
        if p.z < eye_z and front > 0:
            d.z += (eye_z - max(p.z, chin.z)) * .16 * smooth(chin.z - .05 * s, chin.z, p.z) * front
        d.y += .006 * s * bump(p, (0, tip.y + .03 * s, eye_z + .03 * s), (.075 * s, .05 * s, .024 * s))
        return d

    def nose_size(p):
        return ((p - tip) * .3 + Vector((0, 0, -.004 * s))) * (1 - smooth(.012 * s, .045 * s, (p - tip).length))

    fields = {
        "low_face": skin(low_face),
        "face_w": skin(both(lambda p, n: Vector((n * .008 * s, 0, 0)) * bump(p, (n * .066 * s, tip.y + .07 * s, tip.z - .004 * s), (.05 * s, .075 * s, .062 * s)))),
        "jaw_w": skin(both(lambda p, n: Vector((n * .012 * s, 0, -.004 * s)) * bump(p, (n * .056 * s, tip.y + .078 * s, chin.z + .02 * s), (.052 * s, .06 * s, .042 * s)))),
        "chin_w": skin(both(lambda p, n: Vector((n * .006 * s, 0, 0)) * bump(p, (n * .02 * s, chin.y + .01 * s, chin.z + .006 * s), (.032 * s, .042 * s, .028 * s)))),
        "chin_len": skin(lambda p: Vector((0, -.002 * s, -.009 * s)) * bump(p, (0, chin.y + .004 * s, chin.z), (.05 * s, .045 * s, .03 * s))),
        "cheek": skin(both(lambda p, n: Vector((n * .005 * s, -.007 * s, 0)) * bump(p, (n * .043 * s, tip.y + .04 * s, tip.z + .002 * s), (.04 * s, .045 * s, .036 * s)))),
        "cheekbone": skin(both(lambda p, n: Vector((n * .004 * s, -.005 * s, .002 * s)) * bump(p, (n * .052 * s, tip.y + .05 * s, tip.z + .014 * s), (.032 * s, .042 * s, .024 * s)))),
        "eye_size": around_eye(lambda p, c, n, ball: (p - c) * .2 * (1.0 if ball else bump(p, c, (.028 * s, .03 * s, .024 * s)))),
        "eye_space": around_eye(lambda p, c, n, ball: Vector((n * .0055 * s, 0, 0)) * (1.0 if ball else bump(p, c, (.036 * s, .04 * s, .032 * s)))),
        "eye_tilt": skin(around_eye(lambda p, c, n, ball: Vector((-(p.z - c.z), 0, p.x - c.x)) * bump(p, c, (.028 * s, .03 * s, .024 * s)) * .17 * n)),
        "eye_open": skin(around_eye(lambda p, c, n, ball: Vector((0, 0, (p.z - c.z) * .34)) * bump(p, c, (.025 * s, .03 * s, .019 * s)))),
        "lid_full": skin(around_eye(lambda p, c, n, ball: Vector((0, -.003 * s, -.0022 * s)) * bump(p, (c.x, c.y - .012 * s, c.z + .012 * s), (.024 * s, .022 * s, .013 * s)))),
        "nose_size": skin(nose_size),
        "nose_bridge": skin(lambda p: Vector((0, -.007 * s, 0)) * bump(p, (0, tip.y + .02 * s, eye_z - .012 * s), (.016 * s, .042 * s, .036 * s))),
        "nose_w": reused("nose.broad"),
        "nose_len": reused("nose.long"),
        "lips": reused("mouth.full"),
        "mouth_w": skin(both(lambda p, n: Vector((n * .004 * s, 0, 0)) * bump(p, (n * .028 * s, mouth.y - .012 * s, mouth.z), (.024 * s, .03 * s, .017 * s)))),
        "smile": skin(both(lambda p, n: Vector((n * .002 * s, 0, .0055 * s)) * bump(p, (n * .027 * s, mouth.y - .012 * s, mouth.z), (.02 * s, .03 * s, .016 * s)))),
        "brow_h": skin(both(lambda p, n: Vector((0, 0, .0045 * s)) * bump(p, (n * .032 * s, tip.y + .03 * s, eye_z + .032 * s), (.04 * s, .05 * s, .02 * s)))),
        "brow_ridge": skin(both(lambda p, n: Vector((0, -.006 * s, 0)) * bump(p, (n * .03 * s, tip.y + .03 * s, eye_z + .029 * s), (.042 * s, .045 * s, .02 * s)))),
    }
    if tuple(fields) != SLIDERS:
        raise ValueError("slider fields do not match the slider table")
    return fields


def add_slider_keys(meshes, eyes, lm, fields):
    for obj in meshes:
        points = [v.co.copy() for v in obj.data.vertices]
        obj.shape_key_add(name="Basis", from_mix=False)
        for name in SLIDERS:
            block = obj.shape_key_add(name=name, from_mix=False)
            field = fields[name]
            for i, p in enumerate(points):
                block.data[i].co = p + field(p, obj is eyes)


def skin_median(image):
    copy = image.copy()
    copy.scale(96, 96)
    px = np.empty(4 * 96 * 96, dtype=np.float32)
    copy.pixels.foreach_get(px)
    bpy.data.images.remove(copy)
    rgb = px.reshape(-1, 4)[:, :3]
    return np.median(rgb[rgb.sum(1) > .3], axis=0)


def match_hands(material, face_image):
    """The outfit's forearms come in one tanned shade: bring them to the light face, so one tone colour tints both."""
    tex = base_texture(material)
    ratio = skin_median(face_image) / skin_median(tex.image)
    image = tex.image.copy()
    image.scale(TEXTURE_SIZE, TEXTURE_SIZE)
    px = np.empty(4 * TEXTURE_SIZE ** 2, dtype=np.float32)
    image.pixels.foreach_get(px)
    px = px.reshape(TEXTURE_SIZE, TEXTURE_SIZE, 4)
    px[..., :3] = np.clip(px[..., :3] * ratio, 0, 1)
    image.pixels.foreach_set(px.ravel())
    image.update()
    image.pack()
    tex.image = image


def proportions(arm, meshes, profile, height):
    """New joint positions and vertices for one proportion table. Joints keep their rotations; only their offsets change."""
    bones = arm.data.bones
    names = [b.name for b in bones]
    index = {n: i for i, n in enumerate(names)}
    pos = np.array([b.head_local for b in bones])

    def direction(bone):
        child = bones.get(MAIN_CHILD.get(bone.name, "")) or (bone.children[0] if bone.children else None)
        if child is not None:
            d = np.array(child.head_local) - np.array(bone.head_local)
            return d / np.linalg.norm(d)
        return direction(bone.parent) if bone.parent else np.array((0.0, 0.0, 1.0))

    order = [b for b in bones if b.parent is None]
    for bone in order:
        order.extend(bone.children)
    base_s = {}
    for bone in bones:
        width, length = (1, 1) if bone.name == "root" else bone_profile(bone.name, profile)
        d = direction(bone)
        base_s[bone.name] = width * np.eye(3) + (length - width) * np.outer(d, d)

    weights = {}
    for obj in meshes:
        w = np.zeros((len(obj.data.vertices), len(names)))
        for v in obj.data.vertices:
            for g in v.groups:
                w[v.index, index[obj.vertex_groups[g.group].name]] = g.weight
        total = w.sum(1)
        if (total <= 0).any():
            raise ValueError(f"{obj.name}: a vertex has no skin weight")
        weights[obj.name] = w / total[:, None]

    def solve(scale, lift):
        s = {n: m * scale for n, m in base_s.items()}
        new = pos.copy()
        for bone in order:
            if bone.parent is not None:
                p = index[bone.parent.name]
                new[index[bone.name]] = new[p] + s[bone.parent.name] @ (pos[index[bone.name]] - pos[p])
        new[1:] += lift if names[0] == "root" else 0
        return s, new

    def mapped(co, w, s, new):
        out = np.zeros_like(co)
        for i, name in enumerate(names):
            used = w[:, i] > 0
            if used.any():
                out[used] += w[used, i, None] * (new[i] + (co[used] - pos[i]) @ s[name].T)
        return out

    def basis(obj):
        co = np.empty(3 * len(obj.data.vertices))
        obj.data.vertices.foreach_get("co", co)
        return co.reshape(-1, 3)

    def extent(scale, lift):
        s, new = solve(scale, lift)
        z = np.concatenate([mapped(basis(o), weights[o.name], s, new)[:, 2] for o in meshes])
        return z.min(), z.max()

    low, high = extent(1.0, np.zeros(3))
    scale = height / (high - low)
    low, _ = extent(scale, np.zeros(3))
    s, new = solve(scale, np.array((0, 0, -low)))
    for obj in meshes:
        w = weights[obj.name]
        if obj.data.shape_keys:
            for block in obj.data.shape_keys.key_blocks:
                co = np.empty(3 * len(block.data))
                block.data.foreach_get("co", co)
                block.data.foreach_set("co", mapped(co.reshape(-1, 3), w, s, new).ravel())
        else:
            obj.data.vertices.foreach_set("co", mapped(basis(obj), w, s, new).ravel())
        obj.data.update()
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for e in arm.data.edit_bones:
        e.use_connect = False
    for e in arm.data.edit_bones:
        target = Vector(new[index[e.name]])
        offset = e.tail - e.head
        e.head, e.tail = target, target + offset
    bpy.ops.object.mode_set(mode="OBJECT")
    return float(scale), float(new[index["pelvis"]][2] / pos[index["pelvis"]][2])


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    figure = FIGURES[arguments["figure"]]
    files = {os.path.basename(str(p)): os.path.abspath(str(p)) for p in inputs.values()}
    face = inputs.load_source("face")
    bump, landmarks, face_fields = face["bump"], face["landmarks"], face["face_fields"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    outfit = imported(files["Male_Peasant.gltf"])
    arm = next(o for o in outfit if o.type == "ARMATURE")
    head_parts = imported(files[f"Superhero_{figure['head']}_FullBody.gltf"])
    head_arm = next(o for o in head_parts if o.type == "ARMATURE")
    head_meshes = [o for o in head_parts if o.type == "MESH"]
    meshes = [o for o in outfit if o.type == "MESH"]
    for o in meshes + head_meshes:
        o.data.transform(o.matrix_world)
        o.matrix_world.identity()
    eyes = next(o for o in head_meshes if o.material_slots[0].material.name.startswith("MI_Eyes"))
    head = max((o for o in head_meshes if o is not eyes), key=lambda o: len(o.data.vertices))
    brows = next(o for o in head_meshes if o not in (head, eyes))
    keep_head_only(head)
    for o in head_meshes:
        o.parent = arm
        next(m for m in o.modifiers if m.type == "ARMATURE").object = arm
    bpy.data.objects.remove(head_arm)
    for o in [x for x in bpy.data.objects if x.type == "EMPTY"]:
        bpy.data.objects.remove(o)

    lm = landmarks(head, eyes)
    tex = base_texture(head.material_slots[0].material)
    light = "T_Superhero_Female_Light_BaseColor.png" if figure["head"] == "Female" else "T_Superhero_Male_Ligh.png"
    tex.image = bpy.data.images.load(files[light])
    face_image = paint_face(head, lm, figure["paint"], sum(map(ord, arguments["figure"])), bump)
    bsdf_of(eyes.material_slots[0].material).inputs["Roughness"].default_value = .12
    for link in list(bsdf_of(eyes.material_slots[0].material).inputs["Roughness"].links):
        eyes.material_slots[0].material.node_tree.links.remove(link)
    for node in head.material_slots[0].material.node_tree.nodes:
        if node.type == "NORMAL_MAP":
            node.inputs["Strength"].default_value = figure["creases"]
    for sign in (1, -1):
        half = [v for v in brows.data.vertices if v.co.x * sign > 0]
        middle = sum(v.co.z for v in half) / len(half)
        for v in half:
            v.co.z = middle + (v.co.z - middle) * figure["browThin"]
    if figure["head"] == "Male":
        for v in head.data.vertices:
            if v.co.z < lm["chin"].z:
                v.co.x = max(-NECK_HALF_WIDTH, min(NECK_HALF_WIDTH, v.co.x))
    add_slider_keys((head, brows, eyes), eyes, lm, slider_fields(lm, face_fields(lm), bump))

    head_top = max(v.co.z for v in head.data.vertices) if not head.data.shape_keys else max(v.co.z for v in head.data.shape_keys.key_blocks["Basis"].data)
    hair = next(o for o in imported(files[figure["hair"] + ".gltf"]) if o.type == "MESH")
    hair.data.transform(hair.matrix_world)
    hair.matrix_world.identity()
    if figure.get("hairFlat"):
        for v in hair.data.vertices:
            if v.co.z > head_top - .02:
                v.co.z = head_top - .02 + (v.co.z - (head_top - .02)) * figure["hairFlat"]
    hair.vertex_groups.new(name="Head").add(range(len(hair.data.vertices)), 1, "REPLACE")
    hair.parent = arm
    hair.modifiers.new("Armature", "ARMATURE").object = arm
    for o in [x for x in bpy.data.objects if x.type == "EMPTY"]:
        bpy.data.objects.remove(o)

    legs = next(o for o in meshes if o.name.endswith("Legs"))
    body = next(o for o in meshes if o.name.endswith("Body"))
    for slot in (s for o in meshes for s in o.material_slots):
        if slot.material.name.startswith("MI_Regular"):
            match_hands(slot.material, face_image)
            break
    parts = [*meshes, head, eyes, brows, hair]
    if "skirt" in figure:
        soften_tunic(body)
        skirt = skirt_mesh(arm, legs, body, figure["skirt"])
        parts.append(skirt)
        # The skirt replaces the trousers and the boot shafts: kept hidden underneath, they would poke through at every stride.
        parts.remove(legs)
        bpy.data.objects.remove(legs)
        feet = next(o for o in meshes if o.name.endswith("Feet"))
        hem = min(v.co.z for v in skirt.data.vertices)
        bm = bmesh.new()
        bm.from_mesh(feet.data)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z > hem + BOOT_ABOVE_HEM], context="VERTS")
        bm.to_mesh(feet.data)
        bm.free()

    scale, pelvis_scale = proportions(arm, parts, PROFILES[figure["profile"]], figure["height"])

    renames = {head: "head", eyes: "eyes", brows: "brows", hair: "hair"}
    for o in parts:
        for key in (["custom_normal"] if "custom_normal" in o.data.attributes else []):
            o.data.attributes.remove(o.data.attributes[key])
        o.data.polygons.foreach_set("use_smooth", [True] * len(o.data.polygons))
        o.data.update()
        o.name = renames.get(o, o.name.split(".")[0].replace("Male_Peasant_", "outfit.").lower())
        for slot in o.material_slots:
            m = slot.material
            m.name = ("hands" if m.name.startswith("MI_Regular") else "outfit") if m.name.startswith(("MI_Regular", "MI_Peasant")) else {head: "skin", eyes: "eyes", brows: "brows", hair: "hair"}.get(o, m.name)
    for image in list(bpy.data.images):
        if image.size[0] > TEXTURE_SIZE:
            image.scale(TEXTURE_SIZE, TEXTURE_SIZE)
            image.pack()

    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    for o in parts:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_skins=True, export_morph=True, export_morph_normal=True, export_morph_tangent=False, export_animations=False, export_cameras=False, export_lights=False,
        export_extras=False, export_def_bones=False, export_apply=False, export_try_sparse_sk=False)
    bpy.context.view_layer.update()
    return {"recipe": RECIPE, "figure": arguments["figure"], "scale": round(scale, 6), "pelvisScale": round(pelvis_scale, 6), "height": figure["height"], "morphs": list(SLIDERS)}
