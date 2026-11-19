"""Wolf den (docs/wolf-den.md, #754): a rocky den mouth with flattened bedding and scattered bones, for mmorpg's Wolfrun Den.

``den-mouth`` is the placeable prop: two jamb boulders and a lintel slab over a dark hollow, backed by an earthen,
mossy mound, on an apron of trodden earth with a flattened nest of bedding at the mouth and old bones in front.
``bone-scatter`` (a few long bones and ribs) and ``bedding-patch`` (another flattened nest) dress the ground around it.

Every piece is a set of blocks: dense sculpted shapes, each decimated to its own game mesh so small parts keep their shape.
Surface layers are painted per vertex (``wx``: R moss, G bone, B bedding, A the hollow's shade; ``wy``: R earth) and
baked into the atlas with Cycles. The game-mesh helpers and the atlas packing are ``cliff_outcrop.py``'s (the declared
input ``outcrop``), and two small steps come from ``limestone_rocks.py`` (``limestone``). The rock, moss and forest
floor are CC0 Poly Haven scans, each divided by its mean and multiplied by mmorpg's palette, as the rock kits do.

The arguments are ``part``: a piece, or ``atlas`` to pack the pieces' baked maps. Noise is ``mathutils.noise``, which holds
no random state, and the scan offsets come from ``numpy``'s legacy ``RandomState``. Shapes are authored +Y up with the
den facing +Z; the GLB is exported the same way, with its origin on the ground at the footprint centre.
"""
import math
import runpy

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector, noise

RECIPE = "wolf-den-v1"
ROCK_TILE, MOSS_TILE, GROUND_TILE = 1.4, 1.1, 1.6  # metres per repeat of the scans
HEAL_PASSES = 32  # how many texels a bake's empty spot may be filled across
SHARP_ANGLE = math.radians(60)  # game-mesh edges above this stay hard
CAGE, REACH = 0.08, 0.25  # the bake's cage extrusion and ray reach, in metres: short, so a bone never samples the ground under it
# The mouth: the hollow under the lintel, between the jambs, x within MOUTH_HALF of 0, up to MOUTH_TOP, from MOUTH_FRONT back.
MOUTH_HALF, MOUTH_TOP, MOUTH_FRONT = 0.55, 0.95, 0.5


def boulder(centre, radii, seed, triangles, yaw=0.0, tilt=0.0, lumps=0.12, earth=0.0, collide=None):
    """A lumpy ellipsoid turned by ``yaw`` about Y and ``tilt`` about Z; ``earth`` buries it under soil and moss."""
    return dict(kind="boulder", centre=centre, radii=radii, seed=seed, triangles=triangles, yaw=yaw, tilt=tilt, lumps=lumps, earth=earth, collide=collide)


def apron(centre, radii, seed, triangles, nest=None):
    """A ground sheet that sinks below y = 0 at its rim; ``nest`` is (x, z, rx, rz) of the flattened bedding on it."""
    return dict(kind="apron", centre=centre, radii=radii, seed=seed, triangles=triangles, nest=nest, collide=None)


def bone(at, length, radius, yaw, seed, triangles=70, bend=0.0, roll=0.0):
    """A long bone lying on the ground at ``at`` (x, y, z); ``bend`` curves it into a rib."""
    return dict(kind="bone", at=at, length=length, radius=radius, yaw=yaw, seed=seed, triangles=triangles, bend=bend, roll=roll, collide=None)


BONES = [
    bone((-0.85, 0.05, 1.55), 0.44, 0.034, 0.5, 21),
    bone((0.95, 0.05, 1.95), 0.36, 0.03, -1.2, 22),
    bone((0.3, 0.04, 0.95), 0.2, 0.02, 2.2, 23, triangles=50),
    *[bone((-0.25 + 0.13 * k, 0.05, 2.15 + 0.03 * k), 0.36 - 0.03 * k, 0.012, 0.15 + 0.08 * k, 24 + k, triangles=60, bend=0.45, roll=0.25) for k in range(3)],
]

# Each piece: its blocks and its baked edge (pixels).
PIECES = {
    "den-mouth": dict(edge=1536, blocks=[
        # The jambs and the lintel frame the mouth; an earthen bank, two shoulders and a capstone bury them into a hillside.
        boulder((-0.98, 0.45, 0.15), (0.56, 0.7, 0.7), 1, 900, yaw=0.3, collide="left"),
        boulder((1.0, 0.4, 0.05), (0.56, 0.64, 0.68), 2, 900, yaw=-0.4, collide="right"),
        boulder((0.0, 1.17, -0.2), (1.38, 0.44, 0.95), 3, 900, yaw=0.15, tilt=0.07, lumps=0.14, collide="bank"),
        boulder((0.0, 0.35, -2.0), (2.4, 1.65, 1.6), 4, 1200, lumps=0.14, earth=0.95, collide="bank"),
        boulder((-1.75, 0.2, -0.75), (1.0, 0.85, 1.15), 9, 500, yaw=0.5, lumps=0.16, earth=0.9, collide="bank"),
        boulder((1.8, 0.15, -0.85), (0.95, 0.8, 1.1), 10, 500, yaw=-0.6, lumps=0.16, earth=0.9, collide="bank"),
        boulder((0.65, 1.75, -1.15), (0.7, 0.48, 0.6), 5, 450, yaw=0.9, tilt=-0.15),
        boulder((1.75, 0.08, 0.85), (0.32, 0.26, 0.3), 6, 220),
        boulder((-1.65, 0.06, 1.05), (0.27, 0.22, 0.25), 7, 200),
        apron((0.0, 0.0, 0.75), (2.15, 1.75), 8, 900, nest=(0.1, 1.2, 0.72, 0.52)),
        *BONES,
    ]),
    "bone-scatter": dict(edge=512, blocks=[
        bone((-0.15, 0.0, -0.1), 0.44, 0.03, 0.3, 31),
        bone((0.25, 0.0, 0.2), 0.3, 0.024, -0.9, 32),
        bone((-0.3, 0.0, 0.3), 0.18, 0.02, 1.9, 33, triangles=50),
        *[bone((0.05 + 0.12 * k, 0.0, -0.3 + 0.02 * k), 0.34 - 0.03 * k, 0.012, 1.4 + 0.1 * k, 34 + k, triangles=60, bend=0.45, roll=-0.3) for k in range(3)],
    ]),
    "bedding-patch": dict(edge=512, blocks=[apron((0.0, 0.0, 0.0), (0.95, 0.75), 41, 500, nest=(0.0, 0.0, 0.8, 0.6))]),
}
for _block in PIECES["den-mouth"]["blocks"]:
    _block["mouth"] = True  # only the den mouth's blocks are shaded by its hollow
ATLAS = "atlas"
ATLAS_EDGE = 2048
ATLAS_RECTS = {"den-mouth": (0, 0), "bone-scatter": (1536, 0), "bedding-patch": (1536, 512)}  # top-left pixels
CELLS = {part: {"edge": cfg["edge"]} for part, cfg in PIECES.items()}
INPUTS = {"outcrop", "limestone", "rockColour", "rockHeight", "mossColour", "groundColour"}
ATLAS_INPUTS = {"outcrop", "limestone"} | {f"{kind}{i}" for kind in ("colour", "normal", "rough") for i in range(len(PIECES))}
PALETTE = {"rock": 0x8b877e, "moss": 0x667447, "earth": 0x5b4b3a, "straw": 0x86744a, "bone": 0xd6cbb0}


def validate(arguments, inputs):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "part"} or arguments["schemaVersion"] != 1:
        raise ValueError("wolf den arguments must be {schemaVersion: 1, part}")
    if arguments["part"] != ATLAS and arguments["part"] not in PIECES:
        raise ValueError(f"wolf den part must be one of {', '.join(PIECES)} or {ATLAS}")
    expected = ATLAS_INPUTS if arguments["part"] == ATLAS else INPUTS
    if set(inputs) != expected:
        raise ValueError(f"wolf den takes exactly the inputs {', '.join(sorted(expected))}")


def smooth(lo, hi, x):
    t = max(0.0, min(1.0, (x - lo) / (hi - lo)))
    return t * t * (3 - 2 * t)


def hollow(p):
    """How deep in the den's hollow a point is, 0 outside to 1 at the back."""
    depth = smooth(MOUTH_FRONT, -0.35, p.z) * smooth(-1.1, -0.6, p.z)  # only the hollow, not the bank's back
    lateral = 1 - smooth(MOUTH_HALF * 0.6, MOUTH_HALF * 1.5, abs(p.x))
    vertical = 1 - smooth(MOUTH_TOP * 0.75, MOUTH_TOP * 1.05, p.y)
    return depth * lateral * vertical


# ---------------------------------------------------------------- shapes

def boulder_mesh(cfg):
    """A lumpy, faceted ellipsoid, painted: moss on top, earth at the foot (or all over a mound), shade in the hollow."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=5, radius=1.0)
    seed, (rx, ry, rz), lumps = cfg["seed"], cfg["radii"], cfg["lumps"]
    offset = Vector((seed * 1.7, seed * 0.9, seed * 2.3))
    turn = Matrix.Rotation(cfg["yaw"], 3, "Y") @ Matrix.Rotation(cfg["tilt"], 3, "Z")
    centre = Vector(cfg["centre"])
    for vert in bm.verts:
        d = vert.co.normalized()
        broad = noise.noise(d * 1.6 + offset) * lumps * 1.6 + noise.noise(d * 3.5 + offset) * lumps * 0.6
        facets = abs(noise.noise(d * 6 + offset)) * -0.05 + noise.noise(d * 14 + offset) * 0.012
        flat = 1 - 0.35 * smooth(-0.3, -0.8, d.y)  # a flatter underside, so it sits rather than balances
        p = Vector((d.x * rx, d.y * ry * flat, d.z * rz)) * (1 + broad + facets)
        vert.co = centre + turn @ p
    bm.normal_update()
    wx, wy = {}, {}
    for vert in bm.verts:
        p, n = vert.co, vert.normal
        field = noise.noise(p * 2.2 + offset) * 0.7 + noise.noise(p * 7 + offset) * 0.3
        moss = smooth(0.25, 0.85, n.y) * smooth(-0.25, 0.2, field + 0.15 * cfg["earth"])
        earth = max(1 - smooth(0.02, 0.3, p.y), cfg["earth"] * smooth(-0.4, 0.1, -field) * smooth(0.0, 0.5, n.y + 0.4))
        shade = hollow(p) if cfg.get("mouth") else 0.0
        wx[vert] = (moss * (1 - shade), 0.0, 0.0, shade)
        wy[vert] = (earth, 0.0, 0.0, 1.0)
    return bm, wx, wy


def apron_mesh(cfg):
    """A ground sheet of rings, highest in the middle and sinking under the terrain at its rim, with a flattened nest."""
    bm = bmesh.new()
    cx, _, cz = cfg["centre"]
    rx, rz = cfg["radii"]
    rings, sides = 48, 128
    offset = Vector((cfg["seed"] * 1.3, 0, cfg["seed"] * 0.7))
    nest = cfg["nest"]

    def nest_at(x, z):
        if not nest:
            return 0.0
        nx, nz, nrx, nrz = nest
        r = math.hypot((x - nx) / nrx, (z - nz) / nrz)
        wobble = noise.noise(Vector((x * 3, 0, z * 3)) + offset) * 0.2 + noise.noise(Vector((x * 11, 0, z * 11)) + offset) * 0.06
        return 1 - smooth(0.82, 1.05, r + wobble)

    def height(x, z, r):
        rim = smooth(0.78, 1.0, r)
        lumps = noise.noise(Vector((x * 2.5, 0, z * 2.5)) + offset) * 0.025 + noise.noise(Vector((x * 9, 0, z * 9)) + offset) * 0.008
        bed = nest_at(x, z)
        # The nest is pressed flat in the middle and heaped into a low rim of tufts at its edge.
        tufts = (abs(noise.noise(Vector((x * 22, 0, z * 22)) + offset)) * 0.05) * smooth(0.3, 0.9, bed) * (1 - smooth(0.9, 1.0, bed))
        return 0.035 * (1 - rim) - 0.08 * rim + lumps * (1 - 0.6 * bed) + 0.035 * bed * (1 - smooth(0.0, 0.85, bed)) + tufts + 0.01 * bed

    verts = []
    centre_vert = bm.verts.new((cx, height(cx, cz, 0.0), cz))
    for i in range(1, rings + 1):
        r = (i / rings) ** 0.85
        row = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            # A ragged rim, so the apron does not read as a disc where it meets the terrain.
            ragged = 1 + 0.14 * noise.noise(Vector((math.cos(a) * 1.5, 0, math.sin(a) * 1.5)) + offset) * r
            x, z = cx + rx * r * ragged * math.cos(a), cz + rz * r * ragged * math.sin(a)
            row.append(bm.verts.new((x, height(x, z, r), z)))
        verts.append(row)
    for k in range(sides):
        bm.faces.new((centre_vert, verts[0][(k + 1) % sides], verts[0][k]))
    for a, b in zip(verts, verts[1:]):
        for k in range(sides):
            j = (k + 1) % sides
            bm.faces.new((a[k], a[j], b[j], b[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bm.faces[0].normal.y < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.normal_update()
    wx, wy = {}, {}
    for vert in bm.verts:
        p = vert.co
        bed = nest_at(p.x, p.z)
        moss = smooth(0.3, 0.6, noise.noise(p * 1.8 + offset)) * smooth(0.5, 0.95, math.hypot((p.x - cx) / rx, (p.z - cz) / rz)) * (1 - bed)
        shade = hollow(p) if cfg.get("mouth") else 0.0
        wx[vert] = (moss * (1 - shade), 0.0, bed * (1 - shade), shade)
        wy[vert] = (1.0, 0.0, 0.0, 1.0)
    return bm, wx, wy


def bone_mesh(cfg):
    """A tube with knobbed ends along x, curved by ``bend`` into a rib, lying at ``at`` turned by ``yaw``."""
    bm = bmesh.new()
    length, radius, bend = cfg["length"], cfg["radius"], cfg["bend"]
    rows, sides = 24, 10
    offset = Vector((cfg["seed"], cfg["seed"] * 0.5, 0))
    rings = []
    for i in range(rows + 1):
        u = i / rows
        x = (u - 0.5) * length
        # Knobs at both ends of a long bone; a rib only tapers.
        knob = 0.0 if bend else 0.75 * (smooth(0.82, 0.97, abs(2 * u - 1)) - smooth(0.97, 1.0, abs(2 * u - 1)))
        r = radius * (1 + knob) * ((0.55 + 0.45 * math.sin(math.pi * u)) if bend else 1.0)
        if i in (0, rows):
            r *= 0.35
        lift = bend * length * 0.5 * (1 - (2 * u - 1) ** 2)  # a rib arches up in the middle
        ring = []
        for k in range(sides):
            a = 2 * math.pi * k / sides
            w = 1 + 0.1 * noise.noise(Vector((u * 5, a, 0)) + offset)
            ring.append(bm.verts.new((x, r * w * math.cos(a) + lift * math.cos(cfg["roll"]), r * w * 1.15 * math.sin(a) + lift * math.sin(cfg["roll"]))))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for k in range(sides):
            j = (k + 1) % sides
            bm.faces.new((a[k], a[j], b[j], b[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    x, y, z = cfg["at"]
    # Lying on the ground: the lowest point of the bone touches y.
    lowest = min(v.co.y for v in bm.verts)
    bm.transform(Matrix.Translation((x, y - lowest - 0.004, z)) @ Matrix.Rotation(cfg["yaw"], 4, "Y"))
    bm.normal_update()
    wx, wy = {}, {}
    for vert in bm.verts:
        stain = smooth(-0.2, 0.5, noise.noise(vert.co * 30 + offset)) * 0.4
        wx[vert] = (0.0, 1.0 - stain, 0.0, 0.0)
        wy[vert] = (0.0, 0.0, 0.0, 1.0)
    return bm, wx, wy


def block_mesh(name, cfg):
    """One block's dense mesh in Blender axes, with its ``wx`` and ``wy`` paint."""
    bm, wx, wy = {"boulder": boulder_mesh, "apron": apron_mesh, "bone": bone_mesh}[cfg["kind"]](cfg)
    for label, paint in (("wx", wx), ("wy", wy)):
        layer = bm.loops.layers.float_color.new(label)
        for face in bm.faces:
            for loop in face.loops:
                loop[layer] = paint.get(loop.vert, (0.0, 0.0, 0.0, 0.0) if label == "wx" else (0.0, 0.0, 0.0, 1.0))
    for vert in bm.verts:  # authored +Y up, front +Z; Blender Z up, front -Y
        y, z = vert.co.y, vert.co.z
        vert.co.y, vert.co.z = -z, y
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.polygons.foreach_set("use_smooth", np.ones(len(mesh.polygons), dtype=bool))
    mesh.update()
    return mesh


def combined(name, meshes):
    bm = bmesh.new()
    for mesh in meshes:
        bm.from_mesh(mesh)
    result = bpy.data.meshes.new(name)
    bm.to_mesh(result)
    bm.free()
    result.polygons.foreach_set("use_smooth", np.ones(len(result.polygons), dtype=bool))
    result.update()
    return result


def linked(name, mesh, collection):
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def decimated(mesh, target, collection):
    """A copy of ``mesh`` reduced to about ``target`` triangles."""
    obj = linked(f"{mesh.name}_reduce", mesh, collection)
    mesh.calc_loop_triangles()
    obj.modifiers.new("decimate", "DECIMATE").ratio = min(1.0, target / max(1, len(mesh.loop_triangles)))
    bpy.context.view_layer.update()
    reduced = bpy.data.meshes.new_from_object(obj.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(obj)
    return reduced


def collision(name, meshes):
    """A box round the part of ``meshes`` above the ground, in glTF axes: {name, tag, center, size} (see ``kit_common.proxy``)."""
    points = np.concatenate([np.array([v.co[:] for v in mesh.vertices]) for mesh in meshes])
    above = points[points[:, 2] >= 0]
    lo = (float(above[:, 0].min()), 0.0, float(-above[:, 1].max()))
    hi = (float(above[:, 0].max()), float(above[:, 2].max()), float(-above[:, 1].min()))
    return {"name": name, "tag": "solid", "center": [round((lo[i] + hi[i]) / 2, 3) for i in range(3)], "size": [round(hi[i] - lo[i], 3) for i in range(3)]}


# ---------------------------------------------------------------- material

def sculpt_material(name, inputs, seed, o):
    """The bake source: rock, earth, moss, bedding and bone, mixed by the paint, and darkened in the hollow."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    n, l = tree.nodes, tree.links
    bsdf = next(node for node in n if node.type == "BSDF_PRINCIPLED")
    rng = np.random.RandomState(seed)
    coords = n.new("ShaderNodeTexCoord")

    def math_node(operation, *values):
        node = n.new("ShaderNodeMath")
        node.operation = operation
        for socket, value in zip(node.inputs, values):
            if isinstance(value, float):
                socket.default_value = value
            else:
                l.new(value, socket)
        return node.outputs[0]

    def mix(factor, a, b):
        node = n.new("ShaderNodeMix")
        node.data_type = "RGBA"
        l.new(factor, node.inputs["Factor"])
        for socket, value in ((node.inputs[6], a), (node.inputs[7], b)):
            if isinstance(value, tuple):
                socket.default_value = value
            else:
                l.new(value, socket)
        return node.outputs[2]

    def scan(path, tile, colour):
        mapping = n.new("ShaderNodeMapping")
        mapping.inputs["Location"].default_value = tuple(float(v) for v in rng.uniform(0, 17, 3))
        mapping.inputs["Scale"].default_value = (1 / tile, 1 / tile, 1 / tile)
        l.new(coords.outputs["Object"], mapping.inputs["Vector"])
        texture = n.new("ShaderNodeTexImage")
        texture.image = bpy.data.images.load(path, check_existing=True)
        texture.image.colorspace_settings.is_data = not colour
        texture.projection, texture.projection_blend = "BOX", 0.3
        l.new(mapping.outputs["Vector"], texture.inputs["Vector"])
        return texture

    def palette(key):
        c = PALETTE[key]
        return o["srgb_to_linear"](np.array([(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255]))

    def graded(texture, key):
        node = n.new("ShaderNodeVectorMath")
        node.operation = "MULTIPLY"
        l.new(texture.outputs["Color"], node.inputs[0])
        node.inputs[1].default_value = tuple(float(v) for v in palette(key) / o["mean_linear"](texture.image))
        return node.outputs[0]

    def channels(layer):
        attr = n.new("ShaderNodeVertexColor")
        attr.layer_name = layer
        split = n.new("ShaderNodeSeparateColor")
        l.new(attr.outputs["Color"], split.inputs[0])
        return split.outputs, attr.outputs["Alpha"]

    (moss_f, bone_f, bed_f), shade_f = channels("wx")
    (earth_f, _, _), _ = channels("wy")
    rock_height = scan(inputs["rockHeight"], ROCK_TILE, False)
    ground = scan(inputs["groundColour"], GROUND_TILE, True)
    surface = mix(earth_f, graded(scan(inputs["rockColour"], ROCK_TILE, True), "rock"), graded(ground, "earth"))
    surface = mix(moss_f, surface, graded(scan(inputs["mossColour"], MOSS_TILE, True), "moss"))
    # Bedding is the forest floor's litter, bleached towards dry grass and streaked, as if pressed flat by lying wolves.
    streaks = n.new("ShaderNodeTexWave")
    streaks.inputs["Scale"].default_value = 9.0
    streaks.inputs["Distortion"].default_value = 6.0
    l.new(coords.outputs["Object"], streaks.inputs["Vector"])
    straw = mix(math_node("MULTIPLY", streaks.outputs["Fac"], 0.45), graded(scan(inputs["groundColour"], GROUND_TILE * 0.6, True), "straw"), (*(float(v) * 1.35 for v in palette("straw")), 1.0))
    # Darker, matted patches, so the nest reads as pressed litter rather than sand.
    matted = n.new("ShaderNodeTexNoise")
    matted.inputs["Scale"].default_value = 5.0
    matted.inputs["Detail"].default_value = 6.0
    l.new(coords.outputs["Object"], matted.inputs["Vector"])
    straw = mix(math_node("MULTIPLY", matted.outputs["Fac"], 0.75), straw, graded(ground, "earth"))
    surface = mix(bed_f, surface, straw)
    blotch = n.new("ShaderNodeTexNoise")
    blotch.inputs["Scale"].default_value = 18.0
    l.new(coords.outputs["Object"], blotch.inputs["Vector"])
    bone_colour = mix(math_node("MULTIPLY", blotch.outputs["Fac"], 0.5), (*(float(v) for v in palette("bone")), 1.0), (*(float(v) * 0.55 for v in palette("bone")), 1.0))
    surface = mix(bone_f, surface, bone_colour)
    surface = mix(math_node("MULTIPLY", shade_f, 0.92), surface, (0.012, 0.01, 0.009, 1.0))
    l.new(surface, bsdf.inputs["Base Color"])
    bsdf.inputs["Metallic"].default_value = 0.0
    l.new(math_node("MULTIPLY_ADD", bone_f, -0.3, 0.95), bsdf.inputs["Roughness"])
    # Rock relief on stone; the ground's own colour stands in for its height on earth and bedding.
    relief = mix(math_node("MAXIMUM", earth_f, bed_f), rock_height.outputs["Color"], ground.outputs["Color"])
    height = math_node("MULTIPLY", relief, math_node("MULTIPLY_ADD", bone_f, -1.0, 1.0))
    bump = n.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value, bump.inputs["Distance"].default_value = 0.6, 0.04
    l.new(height, bump.inputs["Height"])
    l.new(bump.outputs[0], bsdf.inputs["Normal"])
    return mat


# ---------------------------------------------------------------- build

def bake(passes, name, edge):
    """Cycles bakes the sculpts' colour, normal and roughness onto the game mesh, as ``cliff_outcrop.bake`` does but with a
    short cage and in passes: ``passes`` pairs each sculpt with the part of the game mesh it covers, so the ground under a
    bone samples the ground, never the bone. Later passes keep what earlier ones baked; returns the game material."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 4
    scene.cycles.use_denoising = False
    scene.cycles.seed = 0
    mat = bpy.data.materials.new(f"{name}_rock")
    mat.use_nodes = True
    for _, low in passes:
        low.data.materials.append(mat)
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    target = tree.nodes.new("ShaderNodeTexImage")
    settings = scene.render.bake
    settings.use_selected_to_active = True
    settings.cage_extrusion = CAGE
    settings.max_ray_distance = REACH
    # A later pass's margin may not reach into an earlier pass's islands, which the unwrap keeps a few texels apart.
    settings.margin = 8 if len(passes) == 1 else 2
    settings.use_pass_direct = False
    settings.use_pass_indirect = False
    settings.use_pass_color = True
    images = {}
    for kind, label, colour, size in (("DIFFUSE", "colour", True, edge), ("NORMAL", "normal", False, edge), ("ROUGHNESS", "roughness", False, edge // 2)):
        image = bpy.data.images.new(f"{name}_{label}", size, size, alpha=False, float_buffer=False)
        image.colorspace_settings.is_data = not colour
        target.image = image
        tree.nodes.active = target
        for index, (sculpted, low) in enumerate(passes):
            settings.use_clear = index == 0
            bpy.ops.object.select_all(action="DESELECT")
            sculpted.select_set(True)
            low.select_set(True)
            bpy.context.view_layer.objects.active = low
            bpy.ops.object.bake(type=kind, normal_space="TANGENT")
        images[label] = image
    tree.nodes.remove(target)
    colour = tree.nodes.new("ShaderNodeTexImage")
    colour.image = images["colour"]
    tree.links.new(colour.outputs["Color"], bsdf.inputs["Base Color"])
    rough = tree.nodes.new("ShaderNodeTexImage")
    rough.image = images["roughness"]
    tree.links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    normal = tree.nodes.new("ShaderNodeTexImage")
    normal.image = images["normal"]
    normal_map = tree.nodes.new("ShaderNodeNormalMap")
    tree.links.new(normal.outputs["Color"], normal_map.inputs["Color"])
    tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def heal(image):
    """Fill black texels, where the bake's rays found no surface, from their neighbours; returns how many were found."""
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    pixels = pixels.reshape(height, width, 4)
    empty = pixels[..., :3].sum(-1) < 0.004
    found = int(empty.sum())
    for _ in range(HEAL_PASSES):
        if not empty.any():
            break
        solid = ~empty
        total = np.zeros_like(pixels)
        count = np.zeros((height, width), dtype=np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            total += np.roll(pixels * solid[..., None], (dy, dx), (0, 1))
            count += np.roll(solid, (dy, dx), (0, 1))
        fill = empty & (count > 0)
        pixels[fill] = total[fill] / count[fill][:, None]
        empty[fill] = False
    image.pixels.foreach_set(pixels.ravel())
    return found


def split(low, layer, collection):
    """The faces of ``low`` on bake layer ``layer`` (0 ground and stone, 1 bone) as their own object, UVs kept."""
    part = low.copy()
    part.data = low.data.copy()
    part.name = f"{low.name}_{layer}"
    collection.objects.link(part)
    bm = bmesh.new()
    bm.from_mesh(part.data)
    tags = bm.faces.layers.int["layer"]
    bmesh.ops.delete(bm, geom=[face for face in bm.faces if face[tags] != layer], context="FACES")
    bm.to_mesh(part.data)
    bm.free()
    part.data.update()
    return part


def build(part, collection, inputs, o, limestone):
    """One bake pass per layer, each (sculpt, game-mesh part), plus what the build reports. The sculpts share one material."""
    cfg = PIECES[part]
    name = f"wolf-den_{part}"
    blocks = [(block, block_mesh(f"{name}_{i}", block)) for i, block in enumerate(cfg["blocks"])]
    material = sculpt_material(f"{name}_sculpt", inputs, cfg["blocks"][0]["seed"], o)
    reduced_meshes = []
    for block, mesh in blocks:
        reduced_mesh = decimated(mesh, block["triangles"], collection)
        tag = reduced_mesh.attributes.new("layer", "INT", "FACE")
        tag.data.foreach_set("value", np.full(len(reduced_mesh.polygons), int(block["kind"] == "bone"), dtype=np.int32))
        reduced_meshes.append(reduced_mesh)
    reduced = combined(f"{name}_reduced", reduced_meshes)
    while reduced.color_attributes:
        reduced.color_attributes.remove(reduced.color_attributes[0])
    reduced_object = linked(f"{name}_reduced", reduced, collection)
    low = o["game_mesh"](reduced_object, o["triangles"](reduced_object), collection)  # already at its target: this unwraps it
    bpy.data.objects.remove(reduced_object)
    low.data.set_sharp_from_angle(angle=SHARP_ANGLE)
    splinters = limestone["drop_splinters"](low)
    limestone["inset_uvs"](low)
    passes = []
    for layer in (1, 0):  # bones first, then the ground and stone they lie on
        members = [mesh for block, mesh in blocks if int(block["kind"] == "bone") == layer]
        if not members:
            continue
        sculpted = linked(f"{name}_sculpt{layer}", combined(f"{name}_sculpt{layer}", members), collection)
        sculpted.data.materials.append(material)
        passes.append((sculpted, split(low, layer, collection)))
    bpy.data.objects.remove(low)
    points = np.concatenate([np.array([v.co[:] for v in mesh.vertices]) for _, mesh in blocks])
    names = list(dict.fromkeys(block["collide"] for block, _ in blocks if block["collide"]))  # blocks sharing a name share one box
    proxies = [collision(box_name, [mesh for block, mesh in blocks if block["collide"] == box_name]) for box_name in names]
    return passes, {"bury": round(float(-points[:, 2].min()), 3), "splinterFaces": splinters, "blocks": len(blocks), "proxies": proxies}


def joined(name, lows):
    """The baked game-mesh parts as one object again."""
    bm = bmesh.new()
    for low in lows:
        bm.from_mesh(low.data)
    mesh = lows[0].data
    bm.to_mesh(mesh)
    bm.free()
    if "layer" in mesh.attributes:
        mesh.attributes.remove(mesh.attributes["layer"])
    for low in lows[1:]:
        bpy.data.objects.remove(low)
    lows[0].name = mesh.name = name
    return lows[0]


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    o = runpy.run_path(inputs["outcrop"])
    part = arguments["part"]
    if part == ATLAS:
        # generate_atlas packs the table it finds in its own module, so it is pointed at this kit's.
        o["generate_atlas"].__globals__.update(OUTCROPS=CELLS, ATLAS_EDGE=ATLAS_EDGE, ATLAS_RECTS=ATLAS_RECTS)
        return {**o["generate_atlas"](output_path, inputs), "recipe": RECIPE}
    limestone = runpy.run_path(inputs["limestone"])
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    name = f"wolf-den_{part}"
    passes, info = build(part, bpy.context.scene.collection, inputs, o, limestone)
    edge = PIECES[part]["edge"]
    bake(passes, name, edge)
    empty_texels = {label: heal(bpy.data.images[f"{name}_{label}"]) for label in ("colour", "normal", "roughness")}
    for sculpted, _ in passes:
        bpy.data.objects.remove(sculpted)
    low = joined(name, [low for _, low in passes])
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE", export_image_format="AUTO",
        export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    proxies = info.pop("proxies")
    return {"recipe": RECIPE, "part": part, "triangles": o["triangles"](low), "bakeEdge": edge, "bury": info["bury"],
            "fit": {"blocks": info["blocks"]}, "splinterFaces": info["splinterFaces"], "emptyTexels": empty_texels,
            **({"collisionProxies": proxies} if proxies else {})}
