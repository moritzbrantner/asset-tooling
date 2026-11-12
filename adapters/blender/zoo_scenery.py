"""Toy-style, flat-colour Zoo scenery (tree, bush, grass, rock), an original scripted recipe for the pinned Blender script backend.

One run builds one scenery piece (asset-tooling#357, consumer zoo#59 slice S2 / zoo#86). Owner answer of
2026-10-24 on zoo#59: a small flat-colour, toy-style scenery set in the ``farm-structures`` format, loaded
through 3d-lab's untextured ``static-glb`` loader with no 3d-lab change. Zoo scatters these many times
outside the park fence as instance batches, so the meshes stay small.

Frame: metres (one Zoo tile is 1 m), glTF right-handed +Y up, front +Z, origin at the centre of the
footprint on the ground plane (y = 0). Each piece is one mesh node ``zoo.<kind>.<variant>.mesh`` with
plain-colour materials (no textures, no vertex colours). The palette follows Zoo's code-built scenery
(``apps/web/src/park-scene.ts``), a touch brighter for the toy look.

- ``tree`` / ``round``: a tapered brown trunk under a chunky three-ball leaf crown;
- ``tree`` / ``pine``: a short trunk under three stacked rounded cones and a ball tip;
- ``bush`` / ``round``: three overlapping leaf domes with a few red berries;
- ``rock`` / ``round``: a lumpy grey boulder with a small pebble beside it;
- ``tree`` / ``acacia``: a thin trunk forking once under a flat, olive umbrella crown (#359, habitats);
- ``grass`` / ``tuft``: five three-sided blades, the lightest piece because it repeats the most (#359);
- ``rock`` / ``boulder``: a taller, angular six-sided boulder with a small chip beside it (#359);
- ``rock`` / ``flat``: a low, wide, slightly tilted slab with a thin chip beside it, the flat member of
  the rounded/angular/flat rock family (#132).

Park pieces (#625, consumer zoo#190) replace Zoo's code-built fences, gates, benches, signs and pond edges:

- ``fence`` / ``wood``, ``steel``, ``boundary``: one 1 m tile-edge segment along X with half a post at each
  end, so neighbouring segments share one post; ``post-wood``, ``post-steel``, ``post-boundary`` are the
  matching full posts for open ends and corners;
- ``gate`` / ``service``: two posts under a lintel and a closed, braced plank leaf, in place of a segment;
- ``bench`` / ``park``: slatted wooden seat and back on dark metal side frames, facing +Z;
- ``sign`` / ``education`` and ``post``: a plain cream board on two posts and a small yellow signpost;
- ``pond`` / ``edge``, ``corner``, ``reeds``: rim stones along one water-tile edge, an outer-corner stone
  pair and a reed clump with two cattails.

The natural shapes are lathes of a rounded profile (the rocks with a fixed analytic lumpiness), the park
pieces flat-shaded blocks, all built directly into one BMesh, so the face order is fixed and there is no randomness. ``build(kind, variant, collection,
location)`` also works in a live Blender session; ``generate`` is the script-backend entry point.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

PIECES = (("tree", "round"), ("tree", "pine"), ("tree", "acacia"), ("bush", "round"), ("grass", "tuft"),
          ("rock", "round"), ("rock", "boulder"), ("rock", "flat"),
          ("fence", "wood"), ("fence", "steel"), ("fence", "boundary"),
          ("fence", "post-wood"), ("fence", "post-steel"), ("fence", "post-boundary"),
          ("gate", "service"), ("bench", "park"), ("sign", "education"), ("sign", "post"),
          ("pond", "edge"), ("pond", "corner"), ("pond", "reeds"))
SHARP_ANGLE = math.radians(48)

# name: (sRGB base colour, roughness)
MATERIALS = {
    "trunk": ((0.48, 0.33, 0.21), 0.8),
    "leaf": ((0.33, 0.62, 0.27), 0.7),
    "leaf-light": ((0.42, 0.7, 0.33), 0.7),
    "pine": ((0.18, 0.47, 0.29), 0.7),
    "pine-light": ((0.23, 0.55, 0.36), 0.7),
    "bush": ((0.36, 0.63, 0.28), 0.7),
    "bush-light": ((0.44, 0.7, 0.34), 0.7),
    "berry": ((0.86, 0.2, 0.18), 0.45),
    "rock": ((0.6, 0.6, 0.55), 0.85),
    "rock-light": ((0.69, 0.68, 0.62), 0.85),
    "acacia": ((0.43, 0.6, 0.25), 0.7),
    "acacia-light": ((0.5, 0.66, 0.3), 0.7),
    # park pieces (#625)
    "wood": ((0.48, 0.35, 0.23), 0.8),
    "wood-dark": ((0.34, 0.24, 0.16), 0.8),
    "steel": ((0.5, 0.54, 0.57), 0.5),
    "iron": ((0.22, 0.23, 0.25), 0.6),
    "hedge": ((0.18, 0.35, 0.27), 0.6),
    "board": ((0.95, 0.92, 0.82), 0.8),
    "sign-yellow": ((0.95, 0.82, 0.45), 0.7),
    "reed": ((0.42, 0.58, 0.3), 0.7),
    "cattail": ((0.45, 0.3, 0.18), 0.8),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(name):
    existing = bpy.data.materials.get(f"zoo-{name}")
    if existing is not None:
        return existing
    colour, roughness = MATERIALS[name]
    mat = bpy.data.materials.new(f"zoo-{name}")
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = tuple(srgb_to_linear(c) for c in colour) + (1,)
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = tuple(srgb_to_linear(c) for c in colour) + (1,)
    return mat


class Builder:
    """One mesh in Blender axes (Z up, front towards -Y), one material slot per colour."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.materials = []

    def slot(self, mat):
        if mat not in self.materials:
            self.materials.append(mat)
        return self.materials.index(mat)

    def lathe(self, mat, profile, center=(0, 0, 0), segments=12, scale=(1, 1, 1), lump=None, tilt=None):
        """Revolve ``profile`` [(radius, height), ...], bottom to top, about local Z. ``lump(angle, height)``
        scales the radius of each ring vertex for an irregular, still deterministic outline. ``tilt`` =
        (degrees, heading in degrees) leans the local Z axis that far towards the heading, about ``center``."""
        piece = bmesh.new()
        rings = []
        for r, z in profile:
            if r <= 1e-9:
                rings.append([piece.verts.new((0, 0, z))])
                continue
            ring = []
            for i in range(segments):
                a = 2 * math.pi * i / segments
                k = lump(a, z) if lump else 1.0
                ring.append(piece.verts.new((r * k * math.cos(a), r * k * math.sin(a), z)))
            rings.append(ring)
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
        matrix = Matrix.Translation(Vector(center)) @ Matrix.Diagonal(Vector(scale)).to_4x4()
        if tilt:
            lean, heading = (math.radians(t) for t in tilt)
            axis = Vector((-math.sin(heading), math.cos(heading), 0))
            matrix = Matrix.Translation(Vector(center)) @ Matrix.Rotation(lean, 4, axis) @ Matrix.Diagonal(Vector(scale)).to_4x4()
        bmesh.ops.transform(piece, matrix=matrix, verts=piece.verts)
        index = self.slot(mat)
        for face in piece.faces:
            face.material_index = index
            face.smooth = True
        mesh = bpy.data.meshes.new("zoo-piece")
        piece.to_mesh(mesh)
        piece.free()
        self.bm.from_mesh(mesh)
        bpy.data.meshes.remove(mesh)

    def block(self, mat, rings, roll=None):
        """A closed, flat-shaded block through ``rings`` [(z, x0, x1, y0, y1), ...], bottom to top: a box with
        two rings, a capped post with three. ``roll`` = (degrees, (cx, cz)) turns it about the Y axis through
        that point (a diagonal brace)."""
        piece = bmesh.new()
        loops = [[piece.verts.new(co) for co in ((x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z))] for z, x0, x1, y0, y1 in rings]
        piece.faces.new(list(reversed(loops[0])))
        for a, b in zip(loops, loops[1:]):
            for i in range(4):
                j = (i + 1) % 4
                piece.faces.new((a[i], a[j], b[j], b[i]))
        piece.faces.new(loops[-1])
        if roll:
            angle, (cx, cz) = roll
            matrix = Matrix.Translation((cx, 0, cz)) @ Matrix.Rotation(math.radians(angle), 4, "Y") @ Matrix.Translation((-cx, 0, -cz))
            bmesh.ops.transform(piece, matrix=matrix, verts=piece.verts)
        index = self.slot(mat)
        for face in piece.faces:
            face.material_index = index
            face.smooth = False
        mesh = bpy.data.meshes.new("zoo-piece")
        piece.to_mesh(mesh)
        piece.free()
        self.bm.from_mesh(mesh)
        bpy.data.meshes.remove(mesh)

    def box(self, mat, x, y, z, roll=None):
        """An axis-aligned box over the ranges ``x``, ``y`` and ``z`` (Blender axes)."""
        self.block(mat, [(z[0], x[0], x[1], y[0], y[1]), (z[1], x[0], x[1], y[0], y[1])], roll)

    def finish(self, collection, parent):
        mesh = bpy.data.meshes.new(self.name)
        for vert in self.bm.verts:  # a leaning base ring rests on the ground plane instead of dipping below it
            if vert.co.z < 0:
                vert.co.z = 0
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for name in self.materials:
            mesh.materials.append(material(name))
        mesh.set_sharp_from_angle(angle=SHARP_ANGLE)
        obj = bpy.data.objects.new(self.name, mesh)
        collection.objects.link(obj)
        obj.parent = parent
        return obj


def arc(cx, cz, r, a0, a1, steps):
    """Points of a profile arc around (cx, cz), angles in degrees."""
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * k / steps)), cz + r * math.sin(math.radians(a0 + (a1 - a0) * k / steps)))
            for k in range(steps + 1)]


def ball(radius, rings=6):
    """A closed sphere profile about its centre."""
    return [(0, -radius)] + arc(0, 0, radius, -90, 90, rings)[1:-1] + [(0, radius)]


def dome(radius, height, rings=4):
    """A flat-bottomed elliptical dome from z = 0 to ``height``."""
    return [(0, 0)] + [(radius * math.cos(math.radians(a)), height * math.sin(math.radians(a))) for a in range(0, 90, 90 // rings)] + [(0, height)]


def cone(radius, z0, height, fillet):
    """A cone with a rounded rim from z0 and a softened tip."""
    rim = arc(radius - fillet, z0 + fillet, fillet, -90, 60, 3)
    return [(0, z0)] + rim + [(radius * 0.08, z0 + height * 0.94), (0, z0 + height)]


def trunk(bottom, top, height):
    """A tapered trunk with a small root flare."""
    return [(0, 0), (bottom * 1.35, 0), (bottom, height * 0.12), (top, height), (0, height)]


# ---------------------------------------------------------------- pieces

def build_tree_round(b):
    b.lathe("trunk", trunk(0.085, 0.06, 0.8), segments=8)
    b.lathe("leaf", ball(0.38), (0, 0, 0.98), segments=12, scale=(1, 1, 0.92))
    b.lathe("leaf", ball(0.25), (-0.2, 0.1, 0.84), segments=10)
    b.lathe("leaf-light", ball(0.25), (0.12, -0.06, 1.26), segments=10)
    return {"trunkHeight": 0.8, "crownRadius": 0.38}


def build_tree_pine(b):
    b.lathe("trunk", trunk(0.07, 0.055, 0.4), segments=8)
    b.lathe("pine", cone(0.42, 0.28, 0.66, 0.08), segments=12)
    b.lathe("pine-light", cone(0.33, 0.68, 0.56, 0.07), segments=12)
    b.lathe("pine", cone(0.24, 1.04, 0.44, 0.06), segments=10)
    b.lathe("pine-light", ball(0.06, 3), (0, 0, 1.45), segments=8)
    return {"trunkHeight": 0.4, "tiers": 3}


def build_bush_round(b):
    b.lathe("bush", dome(0.3, 0.44), (0, 0, 0), segments=12)
    b.lathe("bush-light", dome(0.2, 0.32), (0.24, -0.12, 0), segments=10)
    b.lathe("bush", dome(0.19, 0.28), (-0.22, 0.14, 0), segments=10)
    for x, y, z in ((0.06, -0.27, 0.27), (-0.18, -0.16, 0.3), (0.32, -0.2, 0.2), (0.14, 0.12, 0.42)):
        b.lathe("berry", ball(0.045, 3), (x, y, z), segments=6)
    return {"domes": 3, "berries": 4}


def lumpy(seed):
    """A fixed analytic lumpiness: no randomness, the same outline on every build."""
    return lambda a, z: 1 + 0.1 * math.sin(3 * a + seed) + 0.06 * math.sin(5 * a + 2 * seed + 4 * z)


def build_rock_round(b):
    b.lathe("rock", dome(0.3, 0.32, 5), (-0.04, 0.02, 0), segments=10, scale=(1.05, 0.85, 1), lump=lumpy(0.7))
    b.lathe("rock-light", dome(0.11, 0.12, 3), (0.27, -0.16, 0), segments=8, lump=lumpy(2.1))
    return {"stones": 2}


def build_tree_acacia(b):
    b.lathe("trunk", trunk(0.06, 0.045, 0.78), segments=7)
    for lean, heading in ((24, 20), (26, 200)):
        b.lathe("trunk", [(0, 0), (0.042, 0), (0.03, 0.3), (0, 0.3)], (0, 0, 0.74), segments=6, tilt=(lean, heading))
    b.lathe("acacia", dome(0.5, 0.2, 3), (0, 0, 1.02), segments=12, scale=(1.08, 0.94, 1), lump=lumpy(1.3))
    b.lathe("acacia", [(0, 0), (0.42, 0.03), (0.5, 0.06)], (0, 0, 0.97), segments=12, scale=(1.08, 0.94, 1), lump=lumpy(1.3))
    b.lathe("acacia-light", dome(0.3, 0.12, 3), (0.12, -0.08, 1.16), segments=10, lump=lumpy(2.4))
    return {"trunkHeight": 0.78, "forks": 2}


def build_grass_tuft(b):
    # (lean, heading, height, colour): open three-sided spikes, the lowest-triangle piece of the set
    blades = ((0, 0, 0.23, "leaf-light"), (20, 40, 0.2, "leaf"), (26, 125, 0.17, "leaf-light"), (22, 210, 0.19, "leaf"), (28, 295, 0.16, "leaf"))
    for lean, heading, height, colour in blades:
        offset = 0.085 if lean else 0
        center = (offset * math.cos(math.radians(heading)), offset * math.sin(math.radians(heading)), 0)
        b.lathe(colour, [(0.06, 0), (0, height)], center, segments=3, tilt=(lean, heading) if lean else None)
    return {"blades": len(blades)}


def build_rock_boulder(b):
    profile = [(0, 0), (0.33, 0), (0.35, 0.2), (0.22, 0.44), (0.08, 0.5), (0, 0.5)]
    b.lathe("rock", profile, (0, 0, 0), segments=6, scale=(1, 0.82, 1), lump=lumpy(3.1))
    b.lathe("rock-light", [(0, 0), (0.1, 0), (0.08, 0.09), (0, 0.11)], (0.3, -0.2, 0), segments=5, lump=lumpy(0.4))
    return {"stones": 2}


def build_rock_flat(b):
    profile = [(0, 0), (0.36, 0), (0.39, 0.05), (0.33, 0.14), (0.12, 0.16), (0, 0.16)]
    b.lathe("rock", profile, (-0.06, 0.02, 0), segments=7, scale=(1.12, 0.82, 1), lump=lumpy(1.7), tilt=(5, 200))
    chip = [(0, 0), (0.17, 0), (0.18, 0.03), (0.13, 0.07), (0, 0.075)]
    b.lathe("rock-light", chip, (0.3, -0.19, 0), segments=6, scale=(1, 0.8, 1), lump=lumpy(4.2), tilt=(8, 320))
    return {"stones": 2}


# ---------------------------------------------------------------- park pieces (#625)
# Fence and gate pieces span one 1 m tile edge along X (x -0.5..0.5), centred on the edge. A fence segment
# carries half a post at each end, so neighbouring segments share one whole post; the full posts close a run's
# open ends and turned corners. The park pieces are flat-shaded blocks. In Blender axes the front is -Y.

# kind: (post width along the run, post depth, body height, cap height, cap scale, body material, cap material)
POSTS = {
    "wood": (0.08, 0.08, 0.5, 0.05, 0.35, "wood", "wood"),
    "steel": (0.05, 0.05, 0.97, 0.03, 0.5, "steel", "steel"),
    "boundary": (0.12, 0.2, 0.52, 0.08, 0.55, "rock", "rock-light"),
}


def post(b, kind, x0, x1, centre):
    """The slice x0..x1 of a ``kind`` post centred on ``centre``, with its tapered cap."""
    _, depth, height, cap, scale, mat, cap_mat = POSTS[kind]
    half, lip = depth / 2, depth / 2 + 0.006

    def taper(x):  # the cap narrows towards the post's centre
        return centre + (x - centre) * scale

    b.box(mat, (x0, x1), (-half, half), (0, height))
    b.block(cap_mat, [(height - 0.004, x0, x1, -lip, lip), (height + cap * 0.35, x0, x1, -lip, lip),
                      (height + cap, taper(x0), taper(x1), -half * scale, half * scale)])


def half_posts(b, kind):
    """Half a post at each end of a segment; returns the inner face's distance from the centre."""
    width = POSTS[kind][0]
    post(b, kind, -0.5, -0.5 + width / 2, -0.5)
    post(b, kind, 0.5 - width / 2, 0.5, 0.5)
    return 0.5 - width / 2


def rail(b, mat, inner, depth, z, height):
    """A rail between the half posts, reaching a little into each so it shares no vertex with them."""
    b.box(mat, (-inner - 0.01, inner + 0.01), (-depth / 2, depth / 2), (z - height / 2, z + height / 2))


def build_fence_wood(b):
    inner = half_posts(b, "wood")
    for z in (0.2, 0.42):
        rail(b, "wood", inner, 0.045, z, 0.06)
    return {"rails": 2, "halfPosts": 2, "tileEdge": 1}


def build_fence_steel(b):
    inner = half_posts(b, "steel")
    rails = (0.08, 0.51, 0.94)
    for z in rails:
        rail(b, "steel", inner, 0.032, z, 0.036)
    bars = 9  # an open grid of thin opaque bars, so the animals stay visible through it
    for i in range(bars):
        x = -inner + 2 * inner * (i + 1) / (bars + 1)
        b.box("steel", (x - 0.008, x + 0.008), (-0.008, 0.008), (rails[0], rails[-1]))
    return {"rails": len(rails), "bars": bars, "halfPosts": 2, "tileEdge": 1}


def build_fence_boundary(b):
    inner = half_posts(b, "boundary")
    b.box("rock", (-inner - 0.01, inner + 0.01), (-0.075, 0.075), (0, 0.2))
    b.box("rock-light", (-inner - 0.01, inner + 0.01), (-0.085, 0.085), (0.2, 0.235))
    for z in (0.34, 0.55):
        rail(b, "hedge", inner, 0.04, z, 0.044)
    balusters = 4
    for i in range(balusters):
        x = -inner + 2 * inner * (i + 1) / (balusters + 1)
        b.box("hedge", (x - 0.016, x + 0.016), (-0.016, 0.016), (0.235, 0.55))
    return {"wallHeight": 0.235, "rails": 2, "balusters": balusters, "halfPosts": 2, "tileEdge": 1}


def full_post(kind):
    def build_post(b):
        width = POSTS[kind][0]
        post(b, kind, -width / 2, width / 2, 0)
        return {"post": kind}
    return build_post


def build_gate_service(b):
    # Two wooden posts under a lintel, and a closed, braced plank leaf with steel hinges; it takes one segment's place.
    for x in (-0.44, 0.44):
        b.box("wood", (x - 0.045, x + 0.045), (-0.045, 0.045), (0, 0.6))
    b.box("wood", (-0.49, 0.49), (-0.05, 0.05), (0.6, 0.655))
    planks, left, right = 6, -0.39, 0.39
    pitch = (right - left) / planks
    for i in range(planks):
        x0 = left + i * pitch
        b.box("wood-dark", (x0 + 0.006, x0 + pitch - 0.006), (-0.012, 0.012), (0.06, 0.54))
    for z in (0.12, 0.46):  # ledges and hinges on the front face
        b.box("wood", (left, right), (-0.03, -0.012), (z - 0.03, z + 0.03))
        b.box("steel", (left - 0.005, left + 0.12), (-0.036, -0.03), (z - 0.02, z + 0.02))
    rise, run = 0.28, right - left - 0.1
    length = math.hypot(run, rise)
    b.box("wood", (-length / 2, length / 2), (-0.028, -0.014), (0.29 - 0.026, 0.29 + 0.026), roll=(-math.degrees(math.atan2(rise, run)), (0, 0.29)))
    return {"leaf": "closed", "planks": planks, "posts": 2, "tileEdge": 1}


def build_bench_park(b):
    # Three seat slats and two back slats on dark metal side frames, facing +Z.
    half = 0.36
    for y in (-0.145, -0.07, 0.005):
        b.box("wood", (-half, half), (y, y + 0.065), (0.19, 0.22))
    for z in (0.26, 0.34):
        b.box("wood", (-half, half), (0.09, 0.115), (z, z + 0.055))
    for x in (-0.29, 0.29):
        b.box("iron", (x - 0.018, x + 0.018), (-0.13, -0.1), (0, 0.19))  # front leg
        b.box("iron", (x - 0.018, x + 0.018), (0.115, 0.145), (0, 0.4))  # back leg and back support
        b.box("iron", (x - 0.02, x + 0.02), (-0.145, 0.13), (0.165, 0.19))  # seat bearer
        b.box("iron", (x - 0.02, x + 0.02), (-0.1, 0.115), (0.04, 0.06))  # foot rail
    return {"seatHeight": 0.22, "seatSlats": 3, "backSlats": 2}


def build_sign_education(b):
    # A plain light board in a dark wooden frame on two posts, under a small top rail, facing +Z.
    for x in (-0.19, 0.19):
        b.box("wood", (x - 0.03, x + 0.03), (0.0, 0.06), (0, 0.66))
    b.box("wood-dark", (-0.26, 0.26), (-0.03, 0.0), (0.37, 0.67))
    b.box("board", (-0.235, 0.235), (-0.04, -0.01), (0.395, 0.645))
    b.box("wood", (-0.28, 0.28), (-0.05, 0.035), (0.66, 0.685))
    return {"board": [0.52, 0.3], "boardTop": 0.685, "posts": 2}


def build_sign_post(b):
    # A small signpost with a plain yellow board, facing +Z.
    b.block("wood", [(0, -0.025, 0.025, 0.0, 0.05), (0.62, -0.025, 0.025, 0.0, 0.05), (0.66, -0.01, 0.01, 0.015, 0.035)])
    b.box("wood-dark", (-0.21, 0.21), (-0.025, 0.0), (0.46, 0.7))
    b.box("sign-yellow", (-0.195, 0.195), (-0.035, -0.015), (0.475, 0.685))
    return {"board": [0.42, 0.24], "boardTop": 0.7, "posts": 1}


def rim_stone(b, mat, x, y, radius, height, seed, squash=0.9):
    b.lathe(mat, dome(radius, height, 3), (x, y, 0), segments=7, scale=(1, squash, 1), lump=lumpy(seed))


def build_pond_edge(b):
    # Four rounded rim stones along one water-tile edge (x -0.5..0.5), centred on the edge.
    stones = ((-0.375, 0.01, 0.112, 0.1, "rock", 0.4), (-0.13, -0.015, 0.118, 0.115, "rock-light", 1.9),
              (0.125, 0.012, 0.11, 0.09, "rock", 3.3), (0.38, -0.01, 0.106, 0.105, "rock-light", 5.1))
    for x, y, radius, height, mat, seed in stones:
        rim_stone(b, mat, x, y, radius, height, seed)
    return {"stones": len(stones), "tileEdge": 1}


def build_pond_corner(b):
    rim_stone(b, "rock", -0.01, 0.01, 0.105, 0.11, 2.7, squash=1)
    rim_stone(b, "rock-light", 0.07, -0.075, 0.05, 0.06, 0.9, squash=1)
    return {"stones": 2, "corner": "outer"}


def build_pond_reeds(b):
    # Open three-sided reed blades and two cattails on thin stalks: the lightest park piece.
    blades = ((0, 0, 0.38), (14, 30, 0.33), (18, 150, 0.3), (16, 260, 0.34), (22, 330, 0.26))
    for lean, heading, height in blades:
        offset = 0.07 if lean else 0
        center = (offset * math.cos(math.radians(heading)), offset * math.sin(math.radians(heading)), 0)
        b.lathe("reed", [(0.035, 0), (0, height)], center, segments=3, tilt=(lean, heading) if lean else None)
    for x, y, height, lean, heading in ((0.04, 0.03, 0.4, 8, 60), (-0.06, -0.02, 0.35, 10, 200)):
        b.lathe("reed", [(0.008, 0), (0, height)], (x, y, 0), segments=3, tilt=(lean, heading))
        reach = height * 0.8
        top = (x + reach * math.sin(math.radians(lean)) * math.cos(math.radians(heading)),
               y + reach * math.sin(math.radians(lean)) * math.sin(math.radians(heading)), reach * math.cos(math.radians(lean)))
        b.lathe("cattail", [(0, -0.045), (0.02, -0.035), (0.02, 0.035), (0, 0.045)], top, segments=4, tilt=(lean, heading))
    return {"blades": len(blades), "cattails": 2}


BUILDERS = {("tree", "round"): build_tree_round, ("tree", "pine"): build_tree_pine, ("tree", "acacia"): build_tree_acacia,
            ("bush", "round"): build_bush_round, ("grass", "tuft"): build_grass_tuft,
            ("rock", "round"): build_rock_round, ("rock", "boulder"): build_rock_boulder,
            ("rock", "flat"): build_rock_flat,
            ("fence", "wood"): build_fence_wood, ("fence", "steel"): build_fence_steel, ("fence", "boundary"): build_fence_boundary,
            ("fence", "post-wood"): full_post("wood"), ("fence", "post-steel"): full_post("steel"),
            ("fence", "post-boundary"): full_post("boundary"), ("gate", "service"): build_gate_service,
            ("bench", "park"): build_bench_park, ("sign", "education"): build_sign_education, ("sign", "post"): build_sign_post,
            ("pond", "edge"): build_pond_edge, ("pond", "corner"): build_pond_corner, ("pond", "reeds"): build_pond_reeds}


def build(kind, variant, collection, location=(0, 0, 0)):
    """Build one piece under an empty root ``zoo.<kind>.<variant>`` at ``location`` (glTF axes)."""
    if (kind, variant) not in BUILDERS:
        raise ValueError(f"zoo scenery piece must be one of {', '.join(f'{k}/{v}' for k, v in PIECES)}")
    root = bpy.data.objects.new(f"zoo.{kind}.{variant}", None)
    root.empty_display_size = 0.2
    collection.objects.link(root)
    b = Builder(f"zoo.{kind}.{variant}.mesh")
    info = BUILDERS[(kind, variant)](b)
    b.finish(collection, root)
    x, y, z = location
    root.location = Vector((x, -z, y))
    return root, info


def generate(output_path, arguments, inputs):
    if not isinstance(arguments, dict) or set(arguments) != {"schemaVersion", "kind", "variant"} or arguments["schemaVersion"] != 1:
        raise ValueError("zoo scenery arguments must be exactly {schemaVersion: 1, kind, variant}")
    if inputs:
        raise ValueError("zoo scenery recipe does not accept extra resources")
    kind, variant = arguments["kind"], arguments["variant"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    root, info = build(kind, variant, bpy.context.scene.collection)
    objects = [root] + list(root.children_recursive)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    triangles = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects if o.type == "MESH")
    bpy.context.view_layer.update()
    points = [o.matrix_world @ v.co for o in objects if o.type == "MESH" for v in o.data.vertices]
    gltf = [(p.x, p.z, -p.y) for p in points]
    bounds = {"min": [round(min(p[i] for p in gltf), 6) for i in range(3)], "max": [round(max(p[i] for p in gltf), 6) for i in range(3)]}
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_vertex_color="NONE", export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "zoo-scenery-v1", "kind": kind, "variant": variant, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "footprint-ground-center", "facing": "+Z", "triangleCount": triangles, "bounds": bounds, "piece": info}
