"""Expressive cartoon Zoo animals on a rigid-part rig, an original scripted recipe for the pinned Blender script backend.

One run builds one animal (asset-tooling#589 zebra, consumer zoo#112/#142). It replaces nothing in Zoo: the
animals join the rolling ``zoo-animals`` release beside Zoo's old authored zebra and giraffe as the variant
``expressive`` (docs/zoo-animals.md). The rig follows the shared ``quadruped-rigid`` profile
(src/quadruped-rigid.ts): named transform nodes pivoting at their joints, rigid parts, no skin.

Frame: metres, glTF right-handed +Y up, the animal faces +X and its right side is +Z, origin on the ground
plane under the body (the frame of the existing ``zoo-animals`` members). Blender builds in its own axes
(+X forward, +Z up, the left side +Y) and the exporter converts.

Joints (parent > child):

    animal_root > body > neck > head > ear_left, ear_right, eye_left, eye_right
                  body > tail
                  body > leg_0 (hind right) > leg_0_lower, leg_1 (hind left), leg_2 (front right), leg_3 (front left)

Every joint pivots at its anatomical hinge, and a leg's pivot is the top of its own mesh. Hooves, hocks and
facial features are part of the moving mesh they belong to, so nothing can detach.

Clips (all loop, in place, and key the same channels so a consumer can cross-fade between any two):

- ``idle``: breathing, a slow look around, ear flicks, a blink and a tail swish;
- ``walk``: a four-beat lateral-sequence walk (hind left, fore left, hind right, fore right). Each leg swings
  about the animal's side axis, so hooves travel forward and back; the knees fold in the swing phase;
- ``feed``: neck and head down to the grass, nibbling, ears and tail still moving;
- ``rest``: lying down with the legs folded under the body, slow breathing and closed eyes.

Every part has one shared opaque material, ``zoo-animal``, with no textures; its flat palette colours travel
as per-corner ``COLOR_0``, so each part is a single draw call. Stripes are cut into the geometry with
planes, so their edges stay crisp at any distance. There is no randomness: the build order is fixed.
``build(species, collection)`` also runs in a live Blender session; ``generate`` is the script-backend entry.
"""
import math

import bmesh
import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

SPECIES = ("zebra",)
FPS = 30
KEY_STEP = 2  # frames between keys; every key is linear
SHARP_ANGLE = math.radians(50)
LEGS = ("leg_0", "leg_1", "leg_2", "leg_3")  # hind right, hind left, front right, front left (the existing members' order)
CLIPS = ("idle", "walk", "feed", "rest")

# name: sRGB colour. The names only pick colours while building; every part ships one material.
PALETTE = {
    "zebra-white": (0.95, 0.94, 0.9),
    "zebra-black": (0.1, 0.1, 0.11),
    "zebra-muzzle": (0.24, 0.22, 0.23),
    "ear-inner": (0.86, 0.72, 0.72),
    "hoof": (0.2, 0.19, 0.19),
    "eye-white": (1.0, 1.0, 1.0),
    "eye-pupil": (0.05, 0.05, 0.07),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


SHARED_MATERIAL = "zoo-animal"
SHARED_ROUGHNESS = 0.7


def shared_material():
    """The one opaque, factor-only material of every part; its colour comes from COLOR_0."""
    existing = bpy.data.materials.get(SHARED_MATERIAL)
    if existing is not None:
        return existing
    mat = bpy.data.materials.new(SHARED_MATERIAL)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = SHARED_ROUGHNESS
    colour = tree.nodes.new("ShaderNodeVertexColor")
    colour.layer_name = "Color"
    tree.links.new(colour.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def arc(cx, cz, r, a0, a1, steps):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * k / steps)), cz + r * math.sin(math.radians(a0 + (a1 - a0) * k / steps)))
            for k in range(steps + 1)]


def ball(radius=1.0, rings=6):
    """A closed sphere profile [(radius, height)], bottom to top."""
    return [(0, -radius)] + arc(0, 0, radius, -90, 90, rings)[1:-1] + [(0, radius)]


def capsule(r0, r1, length, rings=3, cap=0.6):
    """A tapered, round-ended limb from z = 0 down to z = -length: radius r0 at the top, r1 at the bottom. The top
    dome rises ``cap`` × r0 above z = 0; a leg uses a low one, so its hip pivot stays the top of its mesh."""
    top = [(r0 * math.cos(math.radians(a)), r0 * cap * math.sin(math.radians(a))) for a in range(90, -1, -90 // rings)]
    bottom = [(r1 * math.cos(math.radians(a)), -length + r1 * 0.6 * math.sin(math.radians(a))) for a in range(0, -91, -90 // rings)]
    return [(0, r0 * cap)] + top[1:] + bottom[:-1] + [(0, -length - r1 * 0.6)]


def frame_towards(direction):
    """A rotation turning local +Z to ``direction``."""
    return Vector((0, 0, 1)).rotation_difference(Vector(direction).normalized()).to_matrix().to_4x4()


class Part:
    """One rigid part: a mesh in its joint's local frame (Blender axes), one material slot per colour."""

    def __init__(self, name, pivot):
        self.name = name
        self.pivot = Vector(pivot)
        self.bm = bmesh.new()
        self.materials = []

    def slot(self, name):
        if name not in self.materials:
            self.materials.append(name)
        return self.materials.index(name)

    def lathe(self, mat, profile, center, direction=(0, 0, 1), scale=(1, 1, 1), segments=12, spin=0.0, flat=False):
        """Revolve ``profile`` about local Z, scale it, turn Z towards ``direction`` and place it at ``center``
        (world coordinates of the rest pose)."""
        piece = bmesh.new()
        rings = []
        for r, z in profile:
            if r <= 1e-9:
                rings.append([piece.verts.new((0, 0, z))])
                continue
            rings.append([piece.verts.new((r * math.cos(2 * math.pi * i / segments + spin), r * math.sin(2 * math.pi * i / segments + spin), z))
                          for i in range(segments)])
        for a, b in zip(rings, rings[1:]):
            for i in range(segments):
                j = (i + 1) % segments
                if len(a) == 1 and len(b) == 1:
                    continue
                if len(a) == 1:
                    piece.faces.new((a[0], b[j], b[i]))
                elif len(b) == 1:
                    piece.faces.new((a[i], a[j], b[0]))
                else:
                    piece.faces.new((a[i], a[j], b[j], b[i]))
        matrix = Matrix.Translation(Vector(center) - self.pivot) @ frame_towards(direction) @ Matrix.Diagonal(Vector(scale)).to_4x4()
        bmesh.ops.transform(piece, matrix=matrix, verts=piece.verts)
        index = self.slot(mat)
        for face in piece.faces:
            face.material_index = index
            face.smooth = not flat
        mesh = bpy.data.meshes.new("zoo-piece")
        piece.to_mesh(mesh)
        piece.free()
        self.bm.from_mesh(mesh)
        bpy.data.meshes.remove(mesh)

    def paint(self, base, mat, slabs, keep=None):
        """Cut every ``slab`` = (point, normal, width) into the faces of material ``base`` and paint the faces
        inside it with ``mat``. Points and normals are world coordinates; ``keep(center)`` (world) may veto
        a face, which tapers a stripe."""
        base_index, index = self.slot(base), self.slot(mat)
        for point, normal, width in slabs:
            n = Vector(normal).normalized()
            p = Vector(point) - self.pivot
            for offset in (-width / 2, width / 2):
                faces = [f for f in self.bm.faces if f.material_index == base_index]
                geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
                bmesh.ops.bisect_plane(self.bm, geom=geom, plane_co=p + n * offset, plane_no=n)
            for face in self.bm.faces:
                if face.material_index != base_index:
                    continue
                c = face.calc_center_median()
                if abs((c - p).dot(n)) < width / 2 and (keep is None or keep(c + self.pivot)):
                    face.material_index = index

    def finish(self, collection, parent):
        mesh = bpy.data.meshes.new(self.name)
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        bmesh.ops.triangulate(self.bm, faces=[f for f in self.bm.faces if len(f.verts) > 4])
        # The palette travels as linear per-corner COLOR_0 under one shared opaque material, so each part is
        # one draw call; the material slots used while building only pick the colours.
        layer = self.bm.loops.layers.float_color.new("Color")
        palette = [tuple(srgb_to_linear(c) for c in PALETTE[name]) + (1.0,) for name in self.materials]
        for face in self.bm.faces:
            for loop in face.loops:
                loop[layer] = palette[face.material_index]
            face.material_index = 0
        self.bm.to_mesh(mesh)
        self.bm.free()
        # the exporter writes the active/render colour attribute as COLOR_0; a bmesh layer is neither by default
        colours = mesh.color_attributes["Color"]
        mesh.color_attributes.active_color = colours
        mesh.color_attributes.render_color_index = list(mesh.color_attributes).index(colours)
        mesh.materials.append(shared_material())
        mesh.set_sharp_from_angle(angle=SHARP_ANGLE)
        obj = bpy.data.objects.new(self.name, mesh)
        collection.objects.link(obj)
        obj.parent = parent
        obj.location = self.pivot - (parent_pivot(parent))
        obj.rotation_mode = "QUATERNION"
        obj["pivot"] = tuple(self.pivot)
        return obj


def parent_pivot(parent):
    return Vector(parent["pivot"]) if parent is not None and "pivot" in parent else Vector((0, 0, 0))


# ---------------------------------------------------------------- zebra

ZEBRA = {
    "body": (0.0, 0.0, 0.8), "neck": (0.4, 0.0, 0.94), "head": (0.66, 0.0, 1.32), "tail": (-0.5, 0.0, 0.9),
    "hips": {"leg_0": (-0.3, -0.135, 0.74), "leg_1": (-0.3, 0.135, 0.74), "leg_2": (0.29, -0.13, 0.74), "leg_3": (0.29, 0.13, 0.74)},
    "upper": 0.34, "lower": 0.4,
}


def zebra_stripes(part, x_from, x_to, count, width, tilt, keep=None):
    """Vertical bands along the body axis, each leaning ``tilt(x)`` radians from upright."""
    slabs = []
    for k in range(count):
        x = x_from + (x_to - x_from) * (k + 0.5) / count
        a = tilt(x)
        slabs.append(((x, 0, 0.8), (math.cos(a), 0, math.sin(a)), width))
    part.paint("zebra-white", "zebra-black", slabs, keep)


def build_zebra(collection):
    z = ZEBRA
    root = bpy.data.objects.new("animal_root", None)
    root.empty_display_size = 0.3
    collection.objects.link(root)

    # Body: a barrel with a rounder rump and a deeper chest, striped across, the belly left white.
    body = Part("body", z["body"])
    # rump to chest along the body axis: (radius, position); the rump and chest bulge, the waist is a touch slimmer
    barrel = [(0, -0.6), (0.15, -0.58), (0.23, -0.51), (0.27, -0.38), (0.275, -0.2), (0.265, 0.0), (0.27, 0.2), (0.265, 0.36),
              (0.23, 0.48), (0.15, 0.56), (0, 0.58)]
    body.lathe("zebra-white", barrel, (0.0, 0, 0.8), direction=(1, 0, 0.04), scale=(1.0, 0.9, 1), segments=12)
    zebra_stripes(body, -0.62, 0.52, 9, 0.055, lambda x: math.radians(-8 + 55 * max(0.0, -x - 0.12) / 0.4),
                  keep=lambda c: c.z > 0.64 + 0.06 * math.sin(c.x * 9))
    body = body.finish(collection, root)

    # Legs: an upper limb and a lower limb ending in a black hoof, with a black knee band.
    for leg, hip in z["hips"].items():
        front = leg in ("leg_2", "leg_3")
        hip = Vector(hip)
        upper = Part(leg, hip)
        upper.lathe("zebra-white", capsule(0.085 if not front else 0.075, 0.052, z["upper"], cap=0.15), hip, segments=8,
                    scale=(1.15 if not front else 1.0, 1, 1))
        upper.paint("zebra-white", "zebra-black", [((hip.x, 0, hip.z - 0.12 - 0.09 * k), (0, 0, 1), 0.035) for k in range(2)])
        upper = upper.finish(collection, body)
        knee = hip - Vector((0, 0, z["upper"]))
        lower = Part(f"{leg}_lower", knee)
        lower.lathe("zebra-white", capsule(0.048, 0.04, z["lower"] - 0.07, 2), knee, segments=8)
        lower.paint("zebra-white", "zebra-black", [((knee.x, 0, knee.z - 0.07 - 0.085 * k), (0, 0, 1), 0.03) for k in range(3)])
        hoof = [(0, 0), (0.06, 0), (0.062, 0.02), (0.048, 0.08), (0, 0.08)]
        lower.lathe("hoof", hoof, (knee.x + 0.01, knee.y, 0.0), segments=8, scale=(1.1, 1, 1))
        lower.finish(collection, upper)

    # Tail: a thin whip with a black tuft, pivoting at the rump.
    tail = Part("tail", z["tail"])
    tail.lathe("zebra-white", capsule(0.03, 0.018, 0.36, 2), z["tail"], direction=(0.35, 0, 1), segments=7)
    tail.lathe("zebra-black", ball(0.05, 4), (-0.63, 0, 0.53), direction=(-0.35, 0, -1), scale=(0.75, 0.75, 1.7), segments=8)
    tail.finish(collection, body)

    # Neck: a thick, flattened column leaning forwards, striped across, with an upright striped mane.
    neck_dir = Vector((0.55, 0, 1)).normalized()
    neck = Part("neck", z["neck"])
    neck.lathe("zebra-white", capsule(0.15, 0.1, 0.42, 2), Vector(z["neck"]), direction=-neck_dir,
               scale=(1.0, 0.78, 1), segments=12)
    back = Vector((-neck_dir.z, 0, neck_dir.x))  # the back edge of the neck, in its plane
    neck.lathe("zebra-white", ball(1.0, 4), Vector(z["neck"]) + neck_dir * 0.27 + back * 0.13, direction=neck_dir,
               scale=(0.1, 0.035, 0.29), segments=6)
    neck.paint("zebra-white", "zebra-black", [(Vector(z["neck"]) + neck_dir * (0.04 + 0.085 * k), neck_dir, 0.04) for k in range(6)])
    neck.paint("zebra-white", "zebra-black", [(Vector(z["neck"]) + back * 0.215, back, 0.05)])  # the mane's dark crest
    neck = neck.finish(collection, body)

    # Head: a big round cranium, a long tapering muzzle with a dark nose, forehead stripes and a forelock.
    hp = Vector(z["head"])
    head = Part("head", hp)
    head.lathe("zebra-white", ball(0.16, 6), hp + Vector((0.03, 0, 0.02)), scale=(1.05, 0.95, 1.0), segments=12)
    muzzle_dir = Vector((1, 0, -0.55)).normalized()
    head.lathe("zebra-white", ball(0.2, 7), hp + Vector((0.03, 0, 0.02)) + muzzle_dir * 0.2, direction=muzzle_dir,
               scale=(0.5, 0.45, 1.0), segments=12)
    head.paint("zebra-white", "zebra-muzzle", [(hp + Vector((0.03, 0, 0.02)) + muzzle_dir * 0.36, muzzle_dir, 0.1)])
    head.paint("zebra-white", "zebra-black", [(hp + Vector((0.03, 0, 0.02)) + muzzle_dir * (0.11 + 0.06 * k), muzzle_dir, 0.026) for k in range(3)],
               keep=lambda c: c.z > hp.z - 0.06)
    head.lathe("zebra-black", [(0, 0), (0.05, 0), (0.035, 0.08), (0, 0.11)], hp + Vector((0.05, 0, 0.15)), direction=(0.6, 0, 1),
               scale=(1, 0.6, 1), segments=6)
    for side in (-1, 1):  # nostrils
        head.lathe("zebra-black", ball(0.018, 3), hp + Vector((0.03, 0, 0.02)) + muzzle_dir * 0.38 + Vector((0.0, side * 0.045, 0.03)),
                   scale=(1, 1, 0.6), segments=6)
    head = head.finish(collection, neck)

    for side, name in ((1, "left"), (-1, "right")):
        base = hp + Vector((-0.02, side * 0.08, 0.13))
        ear = Part(f"ear_{name}", base)
        ear_dir = Vector((-0.15, side * 0.55, 1)).normalized()
        leaf = [(0, 0), (0.045, 0.02), (0.06, 0.08), (0.05, 0.15), (0.02, 0.21), (0, 0.23)]
        ear.lathe("zebra-white", leaf, base, direction=ear_dir, scale=(1, 0.45, 1), segments=8)
        ear.lathe("ear-inner", [(0, 0), (0.04, 0.03), (0.035, 0.12), (0, 0.17)], base + Vector((0.025, 0, 0.0)), direction=ear_dir,
                  scale=(1, 0.3, 1), segments=6)
        ear.paint("zebra-white", "zebra-black", [(base + ear_dir * 0.205, ear_dir, 0.05)])
        ear.finish(collection, head)

        eye_c = hp + Vector((0.075, side * 0.118, 0.06))
        eye = Part(f"eye_{name}", eye_c)
        look = Vector((0.55, side * 1.0, 0.1)).normalized()
        eye.lathe("eye-white", ball(0.052, 4), eye_c, direction=look, scale=(1, 1, 0.8), segments=10)
        eye.lathe("eye-pupil", ball(0.03, 3), eye_c + look * 0.03 + Vector((0.012, 0, 0.004)), direction=look, scale=(1, 1, 0.65), segments=8)
        eye.lathe("eye-white", ball(0.009, 3), eye_c + look * 0.05 + Vector((0.018, 0, 0.018)), segments=6)
        eye.finish(collection, head)

    return root


BUILDERS = {"zebra": build_zebra}


# ---------------------------------------------------------------- clips

def joints(root):
    return {o.name: o for o in root.children_recursive}


def smooth(t):
    return t * t * (3 - 2 * t)


def pulse(t, at, length):
    """0 → 1 → 0 over [at, at + length], smooth."""
    u = (t - at) / length
    return math.sin(math.pi * u) ** 2 if 0 <= u <= 1 else 0.0


def leg_cycle(u, front):
    """Upper swing (positive brings the hoof forwards) and knee fold over one stride at phase ``u``."""
    stance = 0.62
    amplitude = math.radians(17)
    if u < stance:
        s = u / stance
        return amplitude * (1 - 2 * s), 0.0
    s = (u - stance) / (1 - stance)
    swing = -amplitude + 2 * amplitude * smooth(s)
    fold = math.radians(52 if front else 40) * math.sin(math.pi * s)
    return swing, fold if front else -fold


def standing(t):
    return {"body.t": (0, 0, 0)}


def pose_idle(t, duration):
    w = 2 * math.pi * t / duration
    blink = pulse(t, 2.6, 0.22)
    return {
        "body.t": (0, 0, 0.006 * (1 - math.cos(2 * w))),
        "body.r": (0, math.radians(0.6) * math.sin(2 * w), 0),
        "neck.r": (0, math.radians(-3) * math.sin(w), math.radians(6) * math.sin(w)),
        "head.r": (math.radians(5) * math.sin(w), math.radians(4) * math.sin(2 * w), math.radians(14) * math.sin(w + 0.6)),
        "ear_left.r": (math.radians(-35) * pulse(t, 1.1, 0.35), math.radians(10) * math.sin(w), 0),
        "ear_right.r": (math.radians(35) * pulse(t, 3.0, 0.35), math.radians(10) * math.sin(w + 1), 0),
        "eye_left.s": (1, 1, 1 - 0.88 * blink), "eye_right.s": (1, 1, 1 - 0.88 * blink),
        "tail.r": (math.radians(28) * math.sin(w * 2), math.radians(-6) * (1 + math.sin(w)), 0),
    }


def pose_walk(t, duration):
    u = t / duration
    pose = {}
    # lateral sequence: hind left 0, front left 0.25, hind right 0.5, front right 0.75
    phases = {"leg_1": 0.0, "leg_3": 0.25, "leg_0": 0.5, "leg_2": 0.75}
    for leg, phase in phases.items():
        swing, fold = leg_cycle((u + 1 - phase) % 1, leg in ("leg_2", "leg_3"))
        pose[f"{leg}.r"] = (0, -swing, 0)
        pose[f"{leg}_lower.r"] = (0, fold, 0)
    w = 2 * math.pi * u
    pose.update({
        "body.t": (0, 0, 0.006 + 0.006 * (1 - math.cos(2 * w))),
        "body.r": (math.radians(1.5) * math.sin(w), math.radians(1.0) * math.sin(2 * w), math.radians(1.5) * math.sin(w)),
        "neck.r": (0, math.radians(4) * math.sin(2 * w - 0.8), 0),
        "head.r": (0, math.radians(-3) * math.sin(2 * w - 1.2), 0),
        "ear_left.r": (0, math.radians(-4), 0), "ear_right.r": (0, math.radians(-4), 0),
        "eye_left.s": (1, 1, 1), "eye_right.s": (1, 1, 1),
        "tail.r": (math.radians(14) * math.sin(w), math.radians(-12), 0),
    })
    return pose


def pose_feed(t, duration):
    w = 2 * math.pi * t / duration
    nibble = 0.5 + 0.5 * math.sin(3 * w)
    return {
        "body.t": (0, 0, 0.004 * (1 - math.cos(w))),
        "body.r": (0, 0, 0),
        "neck.r": (0, math.radians(108) + math.radians(2) * math.sin(w), math.radians(5) * math.sin(w)),
        "head.r": (math.radians(4) * math.sin(w), math.radians(30) + math.radians(6) * nibble, 0),
        "leg_2.r": (0, math.radians(-9), 0), "leg_3.r": (0, math.radians(-9), 0),
        "ear_left.r": (math.radians(-20) * pulse(t, 0.6, 0.4), math.radians(15), 0),
        "ear_right.r": (math.radians(20) * pulse(t, 2.1, 0.4), math.radians(15), 0),
        "eye_left.s": (1, 1, 0.75), "eye_right.s": (1, 1, 0.75),
        "tail.r": (math.radians(30) * math.sin(w * 2), math.radians(-4), 0),
    }


def pose_rest(t, duration):
    w = 2 * math.pi * t / duration
    breath = 0.5 - 0.5 * math.cos(w)
    pose = {
        "body.t": (0, 0, -0.46 + 0.008 * breath),
        "body.r": (math.radians(4), 0, 0),
        "neck.r": (0, math.radians(18) + math.radians(2) * breath, math.radians(-8)),
        "head.r": (math.radians(-4), math.radians(22) + math.radians(3) * breath, 0),
        "ear_left.r": (math.radians(-25) * pulse(t, 2.4, 0.4), math.radians(30), 0),
        "ear_right.r": (0, math.radians(30), 0),
        "eye_left.s": (1, 1, 0.12), "eye_right.s": (1, 1, 0.12),
        "tail.r": (math.radians(-20), math.radians(-70), math.radians(4) * math.sin(w)),
    }
    for leg in LEGS:
        front = leg in ("leg_2", "leg_3")
        pose[f"{leg}.r"] = (0, math.radians(84) if front else math.radians(-80), 0)
        pose[f"{leg}_lower.r"] = (0, math.radians(-160) if front else math.radians(150), 0)
    return pose


POSES = {"idle": (pose_idle, 4.0), "walk": (pose_walk, 1.2), "feed": (pose_feed, 3.0), "rest": (pose_rest, 5.0)}


def channels(root):
    """Every channel any clip animates: rotation of every joint, the body's translation and the eyes' scale."""
    names = sorted(joints(root))
    return [f"{name}.r" for name in names] + ["body.t", "eye_left.s", "eye_right.s"]


def apply_pose(objects, pose, keys):
    for key in keys:
        name, kind = key.split(".")
        obj = objects[name]
        value = pose.get(key)
        if kind == "r":
            obj.rotation_quaternion = Euler(value or (0, 0, 0), "XYZ").to_quaternion()
        elif kind == "t":
            obj.location = Vector(obj["rest"]) + Vector(value or (0, 0, 0))
        else:
            obj.scale = value or (1, 1, 1)


def animate(root):
    objects = joints(root)
    for obj in objects.values():
        obj["rest"] = tuple(obj.location)
    keys = channels(root)
    bpy.context.scene.render.fps = FPS
    for clip in CLIPS:
        function, duration = POSES[clip]
        frames = round(duration * FPS)
        actions = {}
        for obj in objects.values():
            ad = obj.animation_data or obj.animation_data_create()
            actions[obj.name] = bpy.data.actions.new(f"{obj.name}|{clip}")
            ad.action = actions[obj.name]
        for frame in range(0, frames + 1, KEY_STEP):
            apply_pose(objects, function(min(frame, frames) / FPS, duration), keys)
            for key in keys:
                name, kind = key.split(".")
                path = {"r": "rotation_quaternion", "t": "location", "s": "scale"}[kind]
                objects[name].keyframe_insert(path, frame=frame)
        for obj in objects.values():
            ad = obj.animation_data
            action = ad.action
            ad.action = None
            if action is None or not any(True for _ in action_fcurves(action)):
                if action is not None:
                    bpy.data.actions.remove(action)
                continue
            for fcurve in action_fcurves(action):
                for point in fcurve.keyframe_points:
                    point.interpolation = "LINEAR"
            track = ad.nla_tracks.new()
            track.name = clip
            strip = track.strips.new(clip, 0, action)
            if hasattr(strip, "action_slot") and len(action.slots) > 0:
                strip.action_slot = action.slots[0]
            track.mute = True  # the scene and the exported nodes keep the standing rest pose
    apply_pose(objects, {}, keys)


def action_fcurves(action):
    """F-curves of a (slotted, Blender 4.4+) action."""
    if hasattr(action, "layers") and len(action.layers) > 0:
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    yield from bag.fcurves
    elif hasattr(action, "fcurves"):
        yield from action.fcurves


# ---------------------------------------------------------------- measuring

def to_gltf(p):
    return (p.x, p.z, -p.y)


def measure_clips(root):
    """Per clip: the lowest point of any mesh over the clip (ground contact), and the body's net travel."""
    objects = joints(root)
    meshes = [o for o in objects.values() if o.type == "MESH"]
    keys = channels(root)
    result = {}
    for clip in CLIPS:
        function, duration = POSES[clip]
        frames = round(duration * FPS)
        lowest, start, end = math.inf, None, None
        for frame in range(0, frames + 1, KEY_STEP):
            apply_pose(objects, function(frame / FPS, duration), keys)
            bpy.context.view_layer.update()
            for obj in meshes:
                matrix = obj.matrix_world
                lowest = min(lowest, min((matrix @ v.co).z for v in obj.data.vertices))
            position = objects["body"].matrix_world.translation.copy()
            start = position if start is None else start
            end = position
        result[clip] = {"seconds": round(frames / FPS, 6), "lowestPoint": round(lowest, 4),
                        "bodyTravel": round(math.hypot(end.x - start.x, end.y - start.y), 6)}
    apply_pose(objects, {}, keys)
    bpy.context.view_layer.update()
    return result


def build(species, collection):
    if species not in BUILDERS:
        raise ValueError(f"zoo animal species must be one of {', '.join(SPECIES)}")
    root = BUILDERS[species](collection)
    animate(root)
    return root


def generate(output_path, arguments, inputs):
    if not isinstance(arguments, dict) or set(arguments) != {"schemaVersion", "species"} or arguments["schemaVersion"] != 1:
        raise ValueError("zoo animal arguments must be exactly {schemaVersion: 1, species}")
    if inputs:
        raise ValueError("zoo animal recipe does not accept extra resources")
    species = arguments["species"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    root = build(species, bpy.context.scene.collection)
    clips = measure_clips(root)
    objects = [root] + list(root.children_recursive)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.update()
    triangles = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects if o.type == "MESH")
    points = [to_gltf(o.matrix_world @ v.co) for o in objects if o.type == "MESH" for v in o.data.vertices]
    bounds = {"min": [round(min(p[i] for p in points), 6) for i in range(3)], "max": [round(max(p[i] for p in points), 6) for i in range(3)]}
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=False, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
        export_animations=True, export_animation_mode="NLA_TRACKS", export_force_sampling=False,
        export_optimize_animation_size=False, export_optimize_animation_keep_anim_object=True,
        export_skins=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "zoo-animals-v1", "species": species, "unit": "meter", "axes": "right-handed-y-up", "facing": "+X",
            "origin": "rig-root-on-the-ground-plane", "triangleCount": triangles, "bounds": bounds,
            "joints": sorted(o.name for o in objects), "clips": clips}
