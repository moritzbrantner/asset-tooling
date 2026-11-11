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

SPECIES = ("zebra", "giraffe", "tiger", "elephant")
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
    "giraffe-tan": (0.82, 0.52, 0.22),
    "giraffe-cream": (0.97, 0.9, 0.74),
    "giraffe-dark": (0.33, 0.2, 0.12),
    "tiger-orange": (0.96, 0.52, 0.12),
    "tiger-black": (0.09, 0.07, 0.07),
    "tiger-white": (0.98, 0.95, 0.9),
    "nose-pink": (0.9, 0.52, 0.55),
    "eye-amber": (0.95, 0.72, 0.18),
    "elephant-grey": (0.6, 0.63, 0.7),
    "elephant-dark": (0.43, 0.45, 0.52),
    "toenail": (0.93, 0.9, 0.82),
    "tusk": (0.98, 0.96, 0.88),
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


# ---------------------------------------------------------------- giraffe

GIRAFFE = {
    "body": (0.0, 0.0, 1.72), "neck": (0.52, 0.0, 1.98), "tail": (-0.7, 0.0, 1.78),
    # the withers stand higher than the rump, so the back slopes down to the tail
    "hips": {"leg_0": (-0.46, -0.17, 1.6), "leg_1": (-0.46, 0.17, 1.6), "leg_2": (0.44, -0.17, 1.78), "leg_3": (0.44, 0.17, 1.78)},
    "upper": {"front": 0.8, "hind": 0.72},
    "neck_dir": (0.36, 0, 1), "neck_length": 1.2,
}


def giraffe_net(part, origin, spacing, width, base="giraffe-tan"):
    """The reticulated coat: cream lines cut across the tan in three directions, leaving rounded polygon patches."""
    o = Vector(origin)
    slabs = []
    for normal, offset in (((1, 0, 0.62), 0.0), ((1, 0, -0.62), 0.5), ((0.12, 0, 1), 0.25)):
        n = Vector(normal).normalized()
        for k in range(-6, 7):
            slabs.append((o + n * spacing * (k + offset), n, width))
    part.paint(base, "giraffe-cream", slabs)


def build_giraffe(collection):
    g = GIRAFFE
    root = bpy.data.objects.new("animal_root", None)
    root.empty_display_size = 0.5
    collection.objects.link(root)

    # Body: a short, deep barrel, higher at the chest, with the coat net and a cream belly.
    body = Part("body", g["body"])
    barrel = [(0, -0.72), (0.2, -0.69), (0.32, -0.6), (0.38, -0.44), (0.4, -0.2), (0.4, 0.05), (0.42, 0.28), (0.4, 0.46),
              (0.33, 0.6), (0.2, 0.69), (0, 0.72)]
    body.lathe("giraffe-tan", barrel, g["body"], direction=(1, 0, 0.14), scale=(0.95, 0.85, 1), segments=14)
    body.paint("giraffe-tan", "giraffe-cream", [((0, 0, 1.36), (0, 0, 1), 0.2)])  # the belly
    giraffe_net(body, g["body"], 0.42, 0.038)
    body = body.finish(collection, root)

    # Legs: long and slim, the upper leg patched, the lower leg cream, with dark hooves.
    for leg, hip in g["hips"].items():
        front = leg in ("leg_2", "leg_3")
        hip = Vector(hip)
        length = g["upper"]["front" if front else "hind"]
        upper = Part(leg, hip)
        upper.lathe("giraffe-tan", capsule(0.11 if front else 0.13, 0.065, length, cap=0.15), hip, segments=8,
                    scale=(1.0 if front else 1.2, 1, 1))
        giraffe_net(upper, hip - Vector((0, 0, 0.3)), 0.3, 0.03)
        upper.paint("giraffe-tan", "giraffe-cream", [((hip.x, 0, hip.z - length + 0.12), (0, 0, 1), 0.24)])
        upper = upper.finish(collection, body)
        knee = hip - Vector((0, 0, length))
        lower = Part(f"{leg}_lower", knee)
        lower.lathe("giraffe-cream", capsule(0.062, 0.05, knee.z - 0.09, 2), knee, segments=8)
        lower.lathe("giraffe-cream", ball(0.07, 3), knee, segments=8)  # a round knee
        hoof = [(0, 0), (0.075, 0), (0.077, 0.025), (0.058, 0.1), (0, 0.1)]
        lower.lathe("hoof", hoof, (knee.x + 0.012, knee.y, 0.0), segments=8, scale=(1.1, 1, 1))
        lower.finish(collection, upper)

    # Tail: a thin whip with a dark tuft.
    tail = Part("tail", g["tail"])
    tail.lathe("giraffe-tan", capsule(0.035, 0.02, 0.6, 2), g["tail"], direction=(0.25, 0, 1), segments=7)
    tail.lathe("giraffe-dark", ball(0.06, 4), (-0.85, 0, 1.12), direction=(-0.25, 0, -1), scale=(0.75, 0.75, 1.9), segments=8)
    tail.finish(collection, body)

    # Neck: a long tapering column with the coat net and a short dark mane along its back.
    neck_dir = Vector(g["neck_dir"]).normalized()
    n0 = Vector(g["neck"])
    neck = Part("neck", n0)
    neck.lathe("giraffe-tan", capsule(0.21, 0.12, g["neck_length"], 3), n0, direction=-neck_dir, scale=(1.0, 0.8, 1), segments=12)
    giraffe_net(neck, n0 + neck_dir * 0.5, 0.34, 0.034)
    back = Vector((-neck_dir.z, 0, neck_dir.x))
    neck.lathe("giraffe-dark", ball(1.0, 4), n0 + neck_dir * 0.62 + back * 0.15, direction=neck_dir, scale=(0.07, 0.035, 0.62),
               segments=6)
    neck = neck.finish(collection, body)

    # Head: a round cranium, a long cream muzzle, ossicones with dark tips, a big friendly eye on each side.
    hp = n0 + neck_dir * g["neck_length"]
    head = Part("head", hp)
    cranium = hp + Vector((0.02, 0, 0.06))
    head.lathe("giraffe-tan", ball(0.23, 6), cranium, scale=(1.08, 0.92, 0.95), segments=12)
    muzzle_dir = Vector((1, 0, -0.42)).normalized()
    head.lathe("giraffe-tan", ball(0.24, 7), cranium + muzzle_dir * 0.24, direction=muzzle_dir, scale=(0.52, 0.48, 1.0), segments=12)
    head.paint("giraffe-tan", "giraffe-cream", [(cranium + muzzle_dir * 0.42, muzzle_dir, 0.16)])
    head.paint("giraffe-tan", "giraffe-cream", [(cranium + Vector((0.06, 0, 0.1)), (0.3, 0, 1), 0.06)])  # a pale forehead blaze
    for side in (-1, 1):
        head.lathe("giraffe-dark", ball(0.022, 3), cranium + muzzle_dir * 0.46 + Vector((0.0, side * 0.05, 0.04)),
                   scale=(1, 1, 0.6), segments=6)  # nostrils
        base = cranium + Vector((-0.05, side * 0.08, 0.18))
        ossicone_dir = Vector((-0.2, side * 0.18, 1)).normalized()
        head.lathe("giraffe-tan", capsule(0.035, 0.03, 0.16, 2, cap=0.2), base, direction=-ossicone_dir, segments=7)
        head.lathe("giraffe-dark", ball(0.045, 4), base + ossicone_dir * 0.17, segments=8)
    head = head.finish(collection, neck)

    for side, name in ((1, "left"), (-1, "right")):
        base = cranium + Vector((-0.11, side * 0.16, 0.1))
        ear = Part(f"ear_{name}", base)
        ear_dir = Vector((-0.25, side * 1.0, 0.35)).normalized()  # giraffe ears stick out sideways
        leaf = [(0, 0), (0.045, 0.02), (0.06, 0.08), (0.05, 0.15), (0.02, 0.2), (0, 0.22)]
        ear.lathe("giraffe-tan", leaf, base, direction=ear_dir, scale=(1, 0.45, 1), segments=8)
        ear.lathe("ear-inner", [(0, 0), (0.04, 0.03), (0.035, 0.11), (0, 0.16)], base + Vector((0, 0, 0.02)), direction=ear_dir,
                  scale=(1, 0.3, 1), segments=6)
        ear.finish(collection, head)

        eye_c = cranium + Vector((0.08, side * 0.165, 0.04))
        eye = Part(f"eye_{name}", eye_c)
        look = Vector((0.5, side * 1.0, 0.1)).normalized()
        eye.lathe("eye-white", ball(0.075, 4), eye_c, direction=look, scale=(1, 1, 0.82), segments=10)
        eye.lathe("eye-pupil", ball(0.044, 3), eye_c + look * 0.044 + Vector((0.014, 0, 0.004)), direction=look, scale=(1, 1, 0.68), segments=8)
        eye.lathe("eye-white", ball(0.013, 3), eye_c + look * 0.074 + Vector((0.022, 0, 0.022)), segments=6)
        eye.lathe("giraffe-dark", [(0, 0), (0.07, 0), (0.07, 0.012), (0, 0.012)], eye_c + Vector((0, side * 0.014, 0.058)),
                  direction=(0.2, side * 0.6, 1), scale=(1, 0.5, 1), segments=8)  # a lid line with lashes
        eye.finish(collection, head)

    return root


# ---------------------------------------------------------------- tiger

TIGER = {
    "body": (0.0, 0.0, 0.62), "neck": (0.46, 0.0, 0.76), "tail": (-0.6, 0.0, 0.7),
    "hips": {"leg_0": (-0.42, -0.14, 0.62), "leg_1": (-0.42, 0.14, 0.62), "leg_2": (0.4, -0.14, 0.64), "leg_3": (0.4, 0.14, 0.64)},
    "upper": 0.3, "paw": 0.05,  # the paw's centre above the grass
    "neck_dir": (0.8, 0, 1), "neck_length": 0.22,
}


def tiger_stripes(part, x_from, x_to, count, width, keep):
    """Thin bands down from the spine, all leaning back a little by varying amounts, alternately wide and narrow."""
    slabs = []
    for k in range(count):
        x = x_from + (x_to - x_from) * (k + 0.5) / count
        a = math.radians(4 + 7 * ((k * 5) % 3) / 2)
        slabs.append(((x, 0, 0.7), (math.cos(a), 0, math.sin(a)), width * (0.8 if k % 3 == 1 else 1.0)))
    part.paint("tiger-orange", "tiger-black", slabs, keep)


def build_tiger(collection):
    g = TIGER
    root = bpy.data.objects.new("animal_root", None)
    root.empty_display_size = 0.3
    collection.objects.link(root)

    # Body: long, low and muscular, with a deeper chest, a white belly and stripes that stop short of it.
    body = Part("body", g["body"])
    barrel = [(0, -0.64), (0.15, -0.61), (0.23, -0.52), (0.26, -0.36), (0.25, -0.15), (0.245, 0.05), (0.26, 0.25), (0.27, 0.4),
              (0.24, 0.52), (0.15, 0.6), (0, 0.63)]
    body.lathe("tiger-orange", barrel, g["body"], direction=(1, 0, 0.03), scale=(1.0, 0.92, 1), segments=14)
    body.paint("tiger-orange", "tiger-white", [((0, 0, 0.4), (0, 0, 1), 0.16)])
    tiger_stripes(body, -0.62, 0.5, 10, 0.05, keep=lambda c: c.z > 0.5 + 0.05 * math.sin(c.x * 11))
    body = body.finish(collection, root)

    # Legs: sturdy, striped on the outside, with big round cream paws.
    for leg, hip in g["hips"].items():
        front = leg in ("leg_2", "leg_3")
        hip = Vector(hip)
        upper = Part(leg, hip)
        upper.lathe("tiger-orange", capsule(0.12 if not front else 0.105, 0.075, g["upper"], cap=0.15), hip, segments=8,
                    scale=(1.15 if not front else 1.0, 1, 1))
        upper.paint("tiger-orange", "tiger-black", [((hip.x, 0, hip.z - 0.1 - 0.1 * k), (0.2, 0, 1), 0.035) for k in range(2)])
        upper = upper.finish(collection, body)
        knee = hip - Vector((0, 0, g["upper"]))
        lower = Part(f"{leg}_lower", knee)
        lower.lathe("tiger-orange", capsule(0.072, 0.066, knee.z - g["paw"], 2), knee, segments=8)
        lower.paint("tiger-orange", "tiger-black", [((knee.x, 0, knee.z - 0.08 - 0.08 * k), (0, 0, 1), 0.03) for k in range(2)])
        lower.lathe("tiger-white", ball(0.08, 4), (knee.x + 0.035, knee.y, g["paw"]), scale=(1.35, 1.0, 0.62), segments=10)
        lower.finish(collection, upper)

    # Tail: thick, hanging and curling up at the end, ringed in black with a black tip.
    t0 = Vector(g["tail"])
    tail = Part("tail", t0)
    first = Vector((-0.75, 0, -1)).normalized()
    tail.lathe("tiger-orange", capsule(0.06, 0.05, 0.42, 2), t0, direction=-first, segments=8)
    bend = t0 + first * 0.42
    second = Vector((-1, 0, 0.35)).normalized()
    tail.lathe("tiger-orange", capsule(0.05, 0.045, 0.3, 2), bend, direction=-second, segments=8)
    tail.lathe("tiger-orange", ball(0.052, 4), bend, segments=8)
    tail.paint("tiger-orange", "tiger-black", [(t0 + first * (0.1 + 0.11 * k), first, 0.04) for k in range(3)]
               + [(bend + second * (0.08 + 0.1 * k), second, 0.04) for k in range(2)] + [(bend + second * 0.33, second, 0.1)])
    tail.finish(collection, body)

    # Neck: short and thick, carrying the head well forward.
    neck_dir = Vector(g["neck_dir"]).normalized()
    n0 = Vector(g["neck"])
    neck = Part("neck", n0)
    neck.lathe("tiger-orange", capsule(0.2, 0.17, g["neck_length"], 3), n0, direction=-neck_dir, scale=(1.0, 0.95, 1), segments=12)
    neck.paint("tiger-orange", "tiger-white", [(n0 + Vector((0.12, 0, -0.1)), (1, 0, -0.6), 0.14)])  # a white throat
    neck.paint("tiger-orange", "tiger-black", [(n0 + neck_dir * (0.05 + 0.08 * k), (-0.4, 0, 1), 0.03) for k in range(2)],
               keep=lambda c: c.z > n0.z + 0.05)
    neck = neck.finish(collection, body)

    # Head: big and round, with white cheek ruffs, a two-lobed white muzzle, a pink nose and forehead stripes.
    hp = n0 + neck_dir * g["neck_length"]
    head = Part("head", hp)
    cranium = hp + Vector((0.06, 0, 0.06))
    head.lathe("tiger-orange", ball(0.25, 7), cranium, scale=(0.92, 1.08, 0.9), segments=14)
    head.paint("tiger-orange", "tiger-black",
               [(cranium + Vector((0, 0, 0.11 + 0.05 * k)), (0.35, 0, 1), 0.02) for k in range(2)],
               keep=lambda c: abs(c.y) < 0.1 and c.x > cranium.x + 0.04)  # the forehead marks
    head.paint("tiger-orange", "tiger-black", [(cranium + Vector((0, side * 0.19, 0.0)), (0, side, 0.5 * k), 0.025)
                                              for side in (-1, 1) for k in (-1, 1)], keep=lambda c: c.x < cranium.x + 0.06)
    for side in (-1, 1):
        head.lathe("tiger-white", ball(0.11, 4), cranium + Vector((0.05, side * 0.2, -0.08)), scale=(0.8, 0.85, 0.75), segments=10)
        head.lathe("tiger-white", ball(0.08, 4), cranium + Vector((0.2, side * 0.055, -0.07)), scale=(1.0, 1.0, 0.85), segments=10)
        head.lathe("tiger-white", ball(0.045, 3), cranium + Vector((0.155, side * 0.11, 0.115)), scale=(0.7, 1.3, 0.55), segments=8)  # brows
    head.lathe("tiger-white", ball(0.055, 3), cranium + Vector((0.18, 0, -0.14)), scale=(1, 1.1, 0.7), segments=8)  # chin
    # a small smile: a line down from the nose between the muzzle lobes, and the mouth along their underside
    head.paint("tiger-white", "tiger-black", [(cranium + Vector((0.25, 0, -0.08)), (0, 1, 0), 0.012)],
               keep=lambda c: cranium.z - 0.11 < c.z < cranium.z - 0.04)
    head.paint("tiger-white", "tiger-black", [(cranium + Vector((0, 0, -0.1)), (0, 0, 1), 0.012)],
               keep=lambda c: c.x > cranium.x + 0.2 and abs(c.y) < 0.09)
    head.lathe("nose-pink", ball(0.045, 3), cranium + Vector((0.27, 0, -0.03)), scale=(0.7, 1.2, 0.75), segments=8)
    head = head.finish(collection, neck)

    for side, name in ((1, "left"), (-1, "right")):
        base = cranium + Vector((-0.04, side * 0.15, 0.17))
        ear = Part(f"ear_{name}", base)
        ear_dir = Vector((0.3, side * 0.45, 1)).normalized()  # turned forwards, so the white inside shows
        round_ear = [(0, 0), (0.075, 0.01), (0.085, 0.05), (0.07, 0.1), (0.035, 0.13), (0, 0.14)]
        ear.lathe("tiger-black", round_ear, base, direction=ear_dir, scale=(1, 0.45, 1), segments=10)
        ear.lathe("tiger-white", [(0, 0), (0.06, 0.02), (0.055, 0.08), (0, 0.11)], base + Vector((0.018, 0, 0.005)), direction=ear_dir,
                  scale=(1, 0.3, 1), segments=8)
        ear.finish(collection, head)

        eye_c = cranium + Vector((0.17, side * 0.1, 0.04))
        eye = Part(f"eye_{name}", eye_c)
        look = Vector((1.0, side * 0.45, 0.05)).normalized()
        eye.lathe("eye-white", ball(0.06, 4), eye_c, direction=look, scale=(1, 1, 0.85), segments=10)
        eye.lathe("eye-amber", ball(0.046, 3), eye_c + look * 0.03, direction=look, scale=(1, 1, 0.55), segments=10)
        eye.lathe("eye-pupil", ball(0.027, 3), eye_c + look * 0.052, direction=look, scale=(1, 1, 0.35), segments=10)  # in front of the iris
        eye.lathe("eye-white", ball(0.01, 3), eye_c + look * 0.064 + Vector((0, 0, 0.016)), segments=6)
        eye.finish(collection, head)

    return root


# ---------------------------------------------------------------- elephant

ELEPHANT = {
    "body": (0.0, 0.0, 1.35), "neck": (0.75, 0.0, 1.55), "tail": (-0.9, 0.0, 1.55),
    "hips": {"leg_0": (-0.55, -0.36, 1.12), "leg_1": (-0.55, 0.36, 1.12), "leg_2": (0.55, -0.36, 1.15), "leg_3": (0.55, 0.36, 1.15)},
    "upper": 0.5, "foot": 0.06,  # the foot pad's centre above the grass
    "neck_dir": (1, 0, 0.4), "neck_length": 0.18,
    "trunk": (0.4, 0, -0.18), "trunk_dirs": ((0.25, 0, -1), (0.3, 0, -1)), "trunk_lengths": (0.5, 0.45),
}


def build_elephant(collection):
    g = ELEPHANT
    root = bpy.data.objects.new("animal_root", None)
    root.empty_display_size = 0.5
    collection.objects.link(root)

    # Body: a big round barrel, a little higher at the shoulders.
    body = Part("body", g["body"])
    barrel = [(0, -0.95), (0.4, -0.88), (0.6, -0.72), (0.7, -0.45), (0.72, -0.15), (0.72, 0.15), (0.73, 0.42), (0.66, 0.7),
              (0.42, 0.88), (0, 0.95)]
    body.lathe("elephant-grey", barrel, g["body"], direction=(1, 0, 0.06), scale=(0.9, 0.85, 1), segments=16)
    body = body.finish(collection, root)

    # Legs: thick columns on round feet with three cream toenails at the front.
    for leg, hip in g["hips"].items():
        front = leg in ("leg_2", "leg_3")
        hip = Vector(hip)
        upper = Part(leg, hip)
        upper.lathe("elephant-grey", capsule(0.27, 0.22, g["upper"], cap=0.04), hip, segments=10)
        upper = upper.finish(collection, body)
        knee = hip - Vector((0, 0, g["upper"]))
        lower = Part(f"{leg}_lower", knee)
        lower.lathe("elephant-grey", capsule(0.22, 0.23, knee.z - 0.2, 2), knee, segments=10)  # its round end sits in the foot
        lower.lathe("elephant-grey", ball(0.22, 3), knee, segments=10)  # a round knee
        lower.lathe("elephant-dark", [(0, 0), (0.24, 0), (0.25, 0.04), (0.24, 0.11), (0, 0.11)], (knee.x, knee.y, 0.0), segments=12)
        for k in (-1, 0, 1):
            nail = Vector((knee.x + 0.21 * math.cos(math.radians(32 * k)), knee.y + 0.21 * math.sin(math.radians(32 * k)), 0.06))
            lower.lathe("toenail", ball(0.065, 3), nail, scale=(0.7, 1.0, 0.8), segments=8)
        lower.finish(collection, upper)

    # Tail: a thin rope with a dark tuft.
    tail = Part("tail", g["tail"])
    tail.lathe("elephant-grey", capsule(0.045, 0.03, 0.55, 2), g["tail"], direction=(0.3, 0, 1), segments=7)
    tail.lathe("elephant-dark", ball(0.06, 4), (-1.07, 0, 1.0), direction=(-0.3, 0, -1), scale=(0.8, 0.8, 1.7), segments=8)
    tail.finish(collection, body)

    # Neck: a short stub between the shoulders and the big head.
    neck_dir = Vector(g["neck_dir"]).normalized()
    n0 = Vector(g["neck"])
    neck = Part("neck", n0)
    neck.lathe("elephant-grey", capsule(0.48, 0.45, g["neck_length"], 3), n0, direction=-neck_dir, segments=12)
    neck = neck.finish(collection, body)

    # Head: big and domed, with small ivory tusks and a dark mouth line under the trunk.
    hp = n0 + neck_dir * g["neck_length"]
    head = Part("head", hp)
    cranium = hp + Vector((0.25, 0, 0.12))
    head.lathe("elephant-grey", ball(0.55, 7), cranium, scale=(0.9, 1.0, 0.95), segments=16)
    head.lathe("elephant-grey", ball(0.3, 5), cranium + Vector((0.3, 0, -0.12)), scale=(0.9, 1.0, 0.9), segments=12)  # the cheeks
    for side in (-1, 1):
        root_t = cranium + Vector((0.42, side * 0.17, -0.25))
        head.lathe("tusk", capsule(0.05, 0.02, 0.22, 2, cap=0.3), root_t, direction=-Vector((1, side * 0.2, 0.35)), segments=8)
    head.lathe("elephant-dark", ball(0.07, 3), cranium + Vector((0.43, 0, -0.33)), scale=(0.8, 1.4, 0.4), segments=8)  # mouth
    head = head.finish(collection, neck)

    # Trunk: two joints, so it can sway, curl and lift food, with soft wrinkle rings and a darker tip.
    t0 = cranium + Vector(g["trunk"])
    d1, d2 = (Vector(d).normalized() for d in g["trunk_dirs"])
    l1, l2 = g["trunk_lengths"]
    trunk = Part("trunk", t0)
    trunk.lathe("elephant-grey", capsule(0.17, 0.13, l1, 2, cap=0.5), t0, direction=-d1, segments=10)
    trunk.paint("elephant-grey", "elephant-dark", [(t0 + d1 * (0.18 + 0.12 * k), d1, 0.018) for k in range(3)])
    trunk = trunk.finish(collection, head)
    t1 = t0 + d1 * l1
    tip = Part("trunk_tip", t1)
    tip.lathe("elephant-grey", capsule(0.13, 0.105, l2, 2, cap=0.5), t1, direction=-d2, segments=10)
    tip.lathe("elephant-grey", ball(0.13, 4), t1, segments=10)
    tip.paint("elephant-grey", "elephant-dark", [(t1 + d2 * (0.1 + 0.11 * k), d2, 0.016) for k in range(3)])
    tip.lathe("elephant-dark", ball(0.12, 4), t1 + d2 * (l2 + 0.03), direction=d2, scale=(1, 1, 0.55), segments=10)
    tip.finish(collection, trunk)

    for side, name in ((1, "left"), (-1, "right")):
        # big round ears fanned out to the side, their pink fronts facing forwards
        base = cranium + Vector((-0.02, side * 0.42, 0.12))
        ear = Part(f"ear_{name}", base)
        normal = Vector((0.8, side * 0.45, 0.0)).normalized()
        out = Vector((-0.45, side * 0.8, 0.0)).normalized()
        centre = base + out * 0.36 + Vector((0, 0, -0.1))
        ear.lathe("elephant-grey", ball(1.0, 5), centre, direction=normal, scale=(0.45, 0.45, 0.07), segments=14)
        ear.lathe("elephant-grey", ball(1.0, 4), centre + Vector((0, 0, -0.22)) - out * 0.06, direction=normal,
                  scale=(0.3, 0.3, 0.06), segments=12)  # the lower lobe
        ear.lathe("ear-inner", ball(1.0, 4), centre + normal * 0.03 + Vector((0, 0, -0.04)), direction=normal,
                  scale=(0.34, 0.34, 0.04), segments=12)
        ear.finish(collection, head)

        eye_c = cranium + Vector((0.4, side * 0.3, 0.1))
        eye = Part(f"eye_{name}", eye_c)
        look = Vector((1.0, side * 0.55, 0.05)).normalized()
        eye.lathe("eye-white", ball(0.085, 4), eye_c, direction=look, scale=(1, 1, 0.8), segments=10)
        eye.lathe("eye-pupil", ball(0.055, 3), eye_c + look * 0.05, direction=look, scale=(1, 1, 0.55), segments=10)
        eye.lathe("eye-white", ball(0.016, 3), eye_c + look * 0.085 + Vector((0, 0, 0.025)), segments=6)
        eye.finish(collection, head)

    return root


BUILDERS = {"zebra": build_zebra, "giraffe": build_giraffe, "tiger": build_tiger, "elephant": build_elephant}


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


# Lying down (rest): how far the body lowers, and the folded knee's centre above the grass, per species.
LYING_DROP = {"zebra": -0.4, "giraffe": -1.1, "tiger": -0.3, "elephant": -0.6}
KNEE_HEIGHT = {"zebra": 0.075, "giraffe": 0.1, "tiger": 0.14, "elephant": 0.26}


def fold_legs(pose, hips, upper_length, drop, knee_height):
    """Lie on folded legs rather than on the belly: each upper leg reaches down and forwards until its knee is on
    the grass, the lower leg turns back to lie flat along the ground, and the legs spread a little so they show
    beside the body. ``hips`` are rest-pose hip pivots; ``upper_length(leg)`` is the upper leg's length."""
    for leg in LEGS:
        hip = hips[leg]
        reach = math.acos(min(1.0, (hip[2] + drop - knee_height) / upper_length(leg)))
        spread = math.radians(14) * (1 if hip[1] > 0 else -1)
        pose[f"{leg}.r"] = (spread, -reach, 0)
        pose[f"{leg}_lower.r"] = (0, math.radians(90) + reach, 0)


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
        "body.t": (0, 0, LYING_DROP["zebra"] + 0.008 * breath),
        "body.r": (0, 0, 0),
        "neck.r": (0, math.radians(18) + math.radians(2) * breath, math.radians(-8)),
        "head.r": (math.radians(-4), math.radians(22) + math.radians(3) * breath, 0),
        "ear_left.r": (math.radians(-25) * pulse(t, 2.4, 0.4), math.radians(30), 0),
        "ear_right.r": (0, math.radians(30), 0),
        "eye_left.s": (1, 1, 0.12), "eye_right.s": (1, 1, 0.12),
        "tail.r": (math.radians(-20), math.radians(-70), math.radians(4) * math.sin(w)),
    }
    fold_legs(pose, ZEBRA["hips"], lambda leg: ZEBRA["upper"], LYING_DROP["zebra"], KNEE_HEIGHT["zebra"])
    return pose


def giraffe_idle(t, duration):
    w = 2 * math.pi * t / duration
    blink = pulse(t, 3.4, 0.22)
    return {
        "body.t": (0, 0, 0.008 * (1 - math.cos(2 * w))),
        "body.r": (0, math.radians(0.5) * math.sin(2 * w), 0),
        # the long neck sways slowly and the head turns to look around, as if curious
        "neck.r": (math.radians(2) * math.sin(w), math.radians(-3) + math.radians(2) * math.sin(w), math.radians(5) * math.sin(w)),
        "head.r": (math.radians(8) * pulse(t, 1.6, 1.4), math.radians(4) * math.sin(2 * w), math.radians(20) * math.sin(w + 0.4)),
        "ear_left.r": (math.radians(-30) * pulse(t, 0.8, 0.35), 0, math.radians(8) * math.sin(w)),
        "ear_right.r": (math.radians(30) * pulse(t, 4.2, 0.35), 0, math.radians(8) * math.sin(w + 1)),
        "eye_left.s": (1, 1, 1 - 0.88 * blink), "eye_right.s": (1, 1, 1 - 0.88 * blink),
        "tail.r": (math.radians(24) * math.sin(w * 2), math.radians(-5) * (1 + math.sin(w)), 0),
    }


def giraffe_walk(t, duration):
    u = t / duration
    pose = {}
    # a giraffe walks almost like a pacer: each front leg follows its hind leg on the same side closely
    phases = {"leg_1": 0.0, "leg_3": 0.12, "leg_0": 0.5, "leg_2": 0.62}
    for leg, phase in phases.items():
        swing, fold = leg_cycle((u + 1 - phase) % 1, leg in ("leg_2", "leg_3"))
        pose[f"{leg}.r"] = (0, -swing * 0.9, 0)
        pose[f"{leg}_lower.r"] = (0, fold * 0.85, 0)
    w = 2 * math.pi * u
    pose.update({
        "body.t": (0, 0, 0.008 + 0.008 * (1 - math.cos(2 * w))),
        # the body rolls towards the side whose legs are planted, and the neck pumps forward with each stride
        "body.r": (math.radians(2.5) * math.sin(w), math.radians(0.8) * math.sin(2 * w), 0),
        "neck.r": (math.radians(-1.5) * math.sin(w), math.radians(6) * math.sin(2 * w - 0.6) + math.radians(4), 0),
        "head.r": (0, math.radians(-5) * math.sin(2 * w - 1.0) - math.radians(4), 0),
        "ear_left.r": (math.radians(6), 0, 0), "ear_right.r": (math.radians(-6), 0, 0),
        "eye_left.s": (1, 1, 1), "eye_right.s": (1, 1, 1),
        "tail.r": (math.radians(12) * math.sin(w), math.radians(-10), 0),
    })
    return pose


def giraffe_feed(t, duration):
    """Browsing high: the neck reaches up and forwards and the head tilts up to nibble leaves."""
    w = 2 * math.pi * t / duration
    nibble = 0.5 + 0.5 * math.sin(4 * w)
    return {
        "body.t": (0, 0, 0.006 * (1 - math.cos(w))),
        "body.r": (0, 0, 0),
        "neck.r": (math.radians(2) * math.sin(w), math.radians(-22) + math.radians(2) * math.sin(w), math.radians(4) * math.sin(w)),
        "head.r": (math.radians(5) * math.sin(w), math.radians(-52) + math.radians(8) * nibble, 0),
        "ear_left.r": (math.radians(-20) * pulse(t, 0.7, 0.4), math.radians(-10), 0),
        "ear_right.r": (math.radians(20) * pulse(t, 2.2, 0.4), math.radians(-10), 0),
        "eye_left.s": (1, 1, 0.7), "eye_right.s": (1, 1, 0.7),
        "tail.r": (math.radians(26) * math.sin(w * 2), math.radians(-4), 0),
    }


def giraffe_rest(t, duration):
    """Lying on folded legs, the neck still upright and the head nodding, eyes half closed. The body rests on its
    legs rather than the ground: each upper leg reaches down and forwards to a knee on the grass, the lower leg
    lies back along the ground, and the legs spread a little so they show beside the body."""
    w = 2 * math.pi * t / duration
    breath = 0.5 - 0.5 * math.cos(w)
    pose = {
        "body.t": (0, 0, LYING_DROP["giraffe"] + 0.01 * breath),
        "body.r": (0, 0, 0),
        "neck.r": (0, math.radians(-2) + math.radians(2) * breath, math.radians(-6)),
        "head.r": (math.radians(-4), math.radians(26) + math.radians(3) * breath, 0),
        "ear_left.r": (math.radians(-25) * pulse(t, 2.4, 0.4), math.radians(25), 0),
        "ear_right.r": (0, math.radians(25), 0),
        "eye_left.s": (1, 1, 0.15), "eye_right.s": (1, 1, 0.15),
        "tail.r": (math.radians(-15), math.radians(-60), math.radians(4) * math.sin(w)),
    }
    fold_legs(pose, GIRAFFE["hips"], lambda leg: GIRAFFE["upper"]["front" if leg in ("leg_2", "leg_3") else "hind"],
              LYING_DROP["giraffe"], KNEE_HEIGHT["giraffe"])
    return pose


def tiger_idle(t, duration):
    w = 2 * math.pi * t / duration
    blink = pulse(t, 1.9, 0.22) + pulse(t, 4.4, 0.22)
    yawn = pulse(t, 2.6, 1.2)
    return {
        "body.t": (0, 0, 0.005 * (1 - math.cos(2 * w))),
        "body.r": (0, math.radians(0.6) * math.sin(2 * w), 0),
        "neck.r": (0, math.radians(-4) * yawn, math.radians(8) * math.sin(w)),
        # a slow look around, then a cat's head tilt and a big stretch of the neck up, like a yawn
        "head.r": (math.radians(12) * pulse(t, 0.6, 1.2), math.radians(-14) * yawn, math.radians(16) * math.sin(w + 0.5)),
        "ear_left.r": (math.radians(-25) * pulse(t, 1.2, 0.3), 0, math.radians(10) * pulse(t, 3.6, 0.5)),
        "ear_right.r": (math.radians(25) * pulse(t, 3.2, 0.3), 0, 0),
        "eye_left.s": (1, 1, 1 - 0.9 * min(1.0, blink + 0.7 * yawn)), "eye_right.s": (1, 1, 1 - 0.9 * min(1.0, blink + 0.7 * yawn)),
        # the tail hangs and its tip flicks lazily, as a resting cat's does
        "tail.r": (math.radians(14) * math.sin(w), math.radians(-6) + math.radians(8) * math.sin(2 * w), 0),
    }


def tiger_walk(t, duration):
    u = t / duration
    pose = {}
    phases = {"leg_1": 0.0, "leg_3": 0.25, "leg_0": 0.5, "leg_2": 0.75}  # a cat's lateral-sequence walk
    for leg, phase in phases.items():
        swing, fold = leg_cycle((u + 1 - phase) % 1, leg in ("leg_2", "leg_3"))
        pose[f"{leg}.r"] = (0, -swing * 1.1, 0)
        pose[f"{leg}_lower.r"] = (0, fold, 0)
    w = 2 * math.pi * u
    pose.update({
        "body.t": (0, 0, 0.004 + 0.004 * (1 - math.cos(2 * w))),
        # a prowl: the shoulders roll, the head stays low and level, the tail sways behind
        "body.r": (math.radians(2) * math.sin(w), math.radians(0.8) * math.sin(2 * w), math.radians(2) * math.sin(w)),
        "neck.r": (0, math.radians(10), math.radians(-3) * math.sin(w)),
        "head.r": (0, math.radians(-8) - math.radians(2) * math.sin(2 * w), math.radians(3) * math.sin(w)),
        "ear_left.r": (0, 0, 0), "ear_right.r": (0, 0, 0),
        "eye_left.s": (1, 1, 1), "eye_right.s": (1, 1, 1),
        "tail.r": (math.radians(16) * math.sin(w), math.radians(-12), math.radians(14) * math.sin(w + 0.8)),
    })
    return pose


def crouch_legs(pose, hips, upper, paw, drop, pitch, lift=(0.0, 0.0)):
    """Bend every leg so the body lowers by ``drop`` (and pitches nose-down by ``pitch`` radians) with the paws
    still under the hips: the elbows go back and the hind knees forward, each lower leg mirroring its upper. ``lift``
    (front, hind) raises the paws a touch, since a tilted paw dips its rim, the hind toes most."""
    for leg in LEGS:
        hip = hips[leg]
        front = leg in ("leg_2", "leg_3")
        height = hip[2] + drop - hip[0] * math.sin(pitch) - paw - lift[0 if front else 1]
        lower = hip[2] - upper - paw
        a = math.acos(max(-1.0, min(1.0, height / (upper + lower))))
        world = a if front else -a
        pose[f"{leg}.r"] = (0, world - pitch, 0)
        pose[f"{leg}_lower.r"] = (0, -2 * world, 0)


def tiger_feed(t, duration):
    """Crouched over food on the ground: front low, head down, chewing with sideways tugs, the tail flicking."""
    w = 2 * math.pi * t / duration
    chew = math.sin(4 * w)
    pitch = math.radians(9)
    pose = {
        "body.t": (0, 0, -0.14),
        "body.r": (0, pitch, 0),
        "neck.r": (0, math.radians(52), math.radians(4) * math.sin(w)),
        "head.r": (math.radians(10) * chew, math.radians(30) + math.radians(5) * (0.5 + 0.5 * chew), math.radians(4) * chew),
        "ear_left.r": (math.radians(-15) * pulse(t, 0.9, 0.3), math.radians(-10), 0),
        "ear_right.r": (math.radians(15) * pulse(t, 2.3, 0.3), math.radians(-10), 0),
        "eye_left.s": (1, 1, 0.65), "eye_right.s": (1, 1, 0.65),
        "tail.r": (math.radians(10) * math.sin(w), math.radians(-4), math.radians(22) * math.sin(2 * w)),
    }
    crouch_legs(pose, TIGER["hips"], TIGER["upper"], TIGER["paw"], -0.14, pitch, lift=(0.01, 0.055))
    return pose


def tiger_rest(t, duration):
    """Lying like a sphinx: elbows on the grass and forepaws stretched out in front, hind legs folded, the head
    held up with the eyes shut and nodding a little, the tail curled forward along the body and its tip twitching."""
    w = 2 * math.pi * t / duration
    breath = 0.5 - 0.5 * math.cos(w)
    drop = LYING_DROP["tiger"]
    pose = {
        "body.t": (0, 0, drop + 0.008 * breath),
        "body.r": (0, 0, 0),
        "neck.r": (0, math.radians(-4) + math.radians(2) * breath, math.radians(-4)),
        "head.r": (math.radians(-8), math.radians(12) + math.radians(4) * breath, math.radians(-6)),
        "ear_left.r": (math.radians(-25) * pulse(t, 2.8, 0.35), math.radians(10), 0),
        "ear_right.r": (0, math.radians(10), 0),
        "eye_left.s": (1, 1, 0.1), "eye_right.s": (1, 1, 0.1),
        "tail.r": (math.radians(-6), math.radians(38), math.radians(70) + math.radians(6) * pulse(t, 3.5, 0.6)),
    }
    fold_legs(pose, TIGER["hips"], lambda leg: TIGER["upper"], drop, KNEE_HEIGHT["tiger"])
    for leg in ("leg_2", "leg_3"):
        hip = TIGER["hips"][leg]
        back = math.acos(min(1.0, (hip[2] + drop - KNEE_HEIGHT["tiger"]) / TIGER["upper"]))
        pose[f"{leg}.r"] = (0, back, 0)  # the elbow back on the grass
        pose[f"{leg}_lower.r"] = (0, -math.radians(90) - back, 0)  # the forearm forward, flat
    return pose


def ears_open(left, right=None):
    """Elephant ears fanned forwards by ``left`` (and ``right``) radians: each turns about its root's vertical."""
    return {"ear_left.r": (0, 0, -left), "ear_right.r": (0, 0, left if right is None else right)}


def keyed(u, keys):
    """Smoothly interpolate ``keys`` = [(u, value or tuple), ...] (ascending u in [0, 1], first and last equal)."""
    for (u0, v0), (u1, v1) in zip(keys, keys[1:]):
        if u0 <= u <= u1:
            s = smooth((u - u0) / (u1 - u0)) if u1 > u0 else 1.0
            return tuple(a + (b - a) * s for a, b in zip(v0, v1))
    return keys[-1][1]


def elephant_idle(t, duration):
    w = 2 * math.pi * t / duration
    blink = pulse(t, 4.1, 0.25)
    flap = 0.5 - 0.5 * math.cos(2 * w)
    pose = {
        "body.t": (0, 0, 0.01 * (1 - math.cos(2 * w))),
        "body.r": (math.radians(1.2) * math.sin(w), 0, 0),
        "neck.r": (0, math.radians(2) * math.sin(w), 0),
        "head.r": (math.radians(3) * math.sin(w), math.radians(-3) * math.sin(2 * w), math.radians(6) * math.sin(w + 0.5)),
        # the trunk sways from side to side, its tip curling and uncurling
        "trunk.r": (math.radians(12) * math.sin(w), math.radians(-6) * math.sin(2 * w), 0),
        "trunk_tip.r": (math.radians(6) * math.sin(w - 0.6), math.radians(30) * (0.5 + 0.5 * math.sin(2 * w - 1.0)), 0),
        "eye_left.s": (1, 1, 1 - 0.88 * blink), "eye_right.s": (1, 1, 1 - 0.88 * blink),
        "tail.r": (math.radians(20) * math.sin(w * 2), math.radians(-5), 0),
    }
    pose.update(ears_open(math.radians(22) * flap, math.radians(22) * (0.5 - 0.5 * math.cos(2 * w - 0.5))))
    return pose


def elephant_walk(t, duration):
    u = t / duration
    pose = {}
    phases = {"leg_1": 0.0, "leg_3": 0.25, "leg_0": 0.5, "leg_2": 0.75}  # a slow lateral-sequence amble
    for leg, phase in phases.items():
        swing, fold = leg_cycle((u + 1 - phase) % 1, leg in ("leg_2", "leg_3"))
        pose[f"{leg}.r"] = (0, -swing * (0.7 if leg in ("leg_2", "leg_3") else 0.58), 0)
        pose[f"{leg}_lower.r"] = (0, fold * (0.55 if leg in ("leg_2", "leg_3") else 0.9), 0)
    w = 2 * math.pi * u
    pose.update({
        "body.t": (0, 0, 0.042 + 0.01 * (1 - math.cos(2 * w))),  # the wide feet tip their rims as they swing
        "body.r": (math.radians(1) * math.sin(w), math.radians(0.8) * math.sin(2 * w), math.radians(1.5) * math.sin(w)),
        "neck.r": (0, math.radians(3) * math.sin(2 * w - 0.6), 0),
        "head.r": (0, math.radians(-2) * math.sin(2 * w - 1.0), math.radians(2) * math.sin(w)),
        # the trunk swings like a pendulum behind each stride
        "trunk.r": (math.radians(8) * math.sin(w - 0.8), math.radians(10) * math.sin(2 * w - 1.2), 0),
        "trunk_tip.r": (math.radians(6) * math.sin(w - 1.4), math.radians(12) + math.radians(10) * math.sin(2 * w - 1.8), 0),
        "eye_left.s": (1, 1, 1), "eye_right.s": (1, 1, 1),
        "tail.r": (math.radians(14) * math.sin(w), math.radians(-8), 0),
    })
    pose.update(ears_open(math.radians(10) + math.radians(8) * math.sin(2 * w)))
    return pose


ELEPHANT_FEED = [  # u, (neck, trunk, trunk tip, head) pitch in degrees: reach down, pick, lift and curl to the mouth, chew
    (0.0, (0, 0, 10, 0)), (0.28, (22, -24, -4, 10)), (0.4, (22, -24, 22, 10)), (0.62, (-4, 46, 135, -10)),
    (0.82, (-4, 46, 135, -10)), (1.0, (0, 0, 10, 0)),
]


def elephant_feed(t, duration):
    """The trunk reaches down to the grass, picks some up, curls it to the mouth, and the elephant chews."""
    u = t / duration
    w = 2 * math.pi * u
    neck, trunk, tip, head = (math.radians(v) for v in keyed(u, ELEPHANT_FEED))
    chew = pulse(u, 0.6, 0.3) * math.sin(6 * w)
    pose = {
        "body.t": (0, 0, 0.006 * (1 - math.cos(w))),
        "body.r": (0, 0, 0),
        "neck.r": (0, neck, 0),
        "head.r": (math.radians(2) * chew, head + math.radians(3) * chew, 0),
        "trunk.r": (0, trunk, 0),
        "trunk_tip.r": (0, tip, 0),
        "eye_left.s": (1, 1, 1 - 0.5 * pulse(u, 0.6, 0.3)), "eye_right.s": (1, 1, 1 - 0.5 * pulse(u, 0.6, 0.3)),
        "tail.r": (math.radians(22) * math.sin(w * 2), math.radians(-5), 0),
    }
    pose.update(ears_open(math.radians(14) * (0.5 - 0.5 * math.cos(2 * w))))
    return pose


def elephant_rest(t, duration):
    """Lying on folded legs, the trunk laid out on the grass in front with its tip curled, eyes shut, ears flat."""
    w = 2 * math.pi * t / duration
    breath = 0.5 - 0.5 * math.cos(w)
    drop = LYING_DROP["elephant"]
    pose = {
        "body.t": (0, 0, drop + 0.012 * breath),
        "body.r": (0, 0, 0),
        "neck.r": (0, math.radians(4) + math.radians(1.5) * breath, 0),
        "head.r": (0, math.radians(4), math.radians(-4)),
        "trunk.r": (0, math.radians(-24), 0),
        "trunk_tip.r": (0, math.radians(-26), math.radians(25) + math.radians(6) * pulse(t, 3.0, 0.8)),
        "eye_left.s": (1, 1, 0.1), "eye_right.s": (1, 1, 0.1),
        "tail.r": (math.radians(-10), math.radians(-50), 0),
    }
    pose.update(ears_open(math.radians(-6) + math.radians(10) * pulse(t, 2.2, 0.6), math.radians(-6)))
    fold_legs(pose, ELEPHANT["hips"], lambda leg: ELEPHANT["upper"], drop, KNEE_HEIGHT["elephant"])
    return pose


POSES = {
    "zebra": {"idle": (pose_idle, 4.0), "walk": (pose_walk, 1.2), "feed": (pose_feed, 3.0), "rest": (pose_rest, 5.0)},
    "giraffe": {"idle": (giraffe_idle, 5.0), "walk": (giraffe_walk, 1.6), "feed": (giraffe_feed, 3.0), "rest": (giraffe_rest, 6.0)},
    "tiger": {"idle": (tiger_idle, 5.0), "walk": (tiger_walk, 1.1), "feed": (tiger_feed, 3.0), "rest": (tiger_rest, 6.0)},
    "elephant": {"idle": (elephant_idle, 6.0), "walk": (elephant_walk, 1.5), "feed": (elephant_feed, 4.0), "rest": (elephant_rest, 6.0)},
}


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
        function, duration = POSES[root["species"]][clip]
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
        function, duration = POSES[root["species"]][clip]
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
    root["species"] = species
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
