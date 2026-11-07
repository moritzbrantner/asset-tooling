"""Crag kit (#480): rock modules that dress Greyhaven's box-shaped crags and cliffs.

One run builds one part at one level of detail (``lod`` 0, 1 or 2) in the part's own frame: metres, glTF
right-handed +Y up. The modules lie over the faces of an axis-aligned box (the game's crag or cliff collider) by the
layout rule in docs/crag-kit.md:

- ``face-sheer-1..3`` and ``face-climb-1..3``: rock slabs over a 3 x 3 m cell of a box face. The cell's back (z = 0)
  is the box face, the origin the bottom centre of the cell, and the relief stands proud towards +Z. A slab overhangs
  its cell by ``OVERLAP`` to the sides and below and sinks into the face along its ragged border, so neighbouring
  slabs interpenetrate like the joints of real rock and no cell edge shows. Sheer slabs are smooth fracture planes
  with water streaks; climbable slabs are broken into strata with ledges, blocks and cracks.
- ``corner-sheer-1/2`` and ``corner-climb-1/2``: 3 m tall slabs bent round a vertical box edge. The edge runs along
  +Y through the origin; the box fills x < 0, z < 0, and the slab's arms lie ``ARM`` along the faces z = 0 and x = 0.
- ``cap-1/2``: 3 m rims along a top edge. The edge runs along +X through the origin; the box fills y < 0, z < 0.
  The cap curls ``LIP`` down the face (z = 0) and ``BACK`` over the top (y = 0).
- ``cap-corner``: a weathered knob over a top corner of the box (the box fills x < 0, y < 0, z < 0).
- ``rock-macro``: a 1 m quad (XZ plane, facing +Y) carrying the tileable rock macro-variation texture.

The face texture is the CC0 Poly Haven ``rock_face_03`` (Greyhaven's terrain rock layer) at one repeat per 3 m, the
same on every module, so the shipped bundle stores it once; each variant offsets its UVs so neighbours don't repeat.
``COLOR_0`` multiplies it: cavities and joints darken, moss (tinted by the CC0 Poly Haven ``mossy_rock`` scan)
collects on up-facing ledges and rims, sheer faces carry dark water streaks, and a broad drift moves towards the
``rock_boulder_dry`` scan. The macro texture mixes the same scans' mean colours in tileable fractal noise.

No randomness: variation comes from a SHA-256 of fixed keys (``rnd``) and numpy's legacy ``RandomState``.
``build(part, lod, collection, inputs)`` also works in a live Blender session after
``use_common(runpy.run_path('kit_common.py'))``; ``generate`` is the script-backend entry point.
"""
import math

import bpy
import bmesh
import numpy as np
from mathutils import Vector

RECIPE = "crag-kit-v1"
PITCH = 3.0  # face cell width and height, cap length, corner height (metres)
OVERLAP = 0.5  # how far a slab overhangs its cell on every side
FACES = {f"face-{family}-{v}": (family, v) for family in ("sheer", "climb") for v in (1, 2, 3)}
CORNERS = {f"corner-{family}-{v}": (family, v) for family in ("sheer", "climb") for v in (1, 2)}
CAPS = {"cap-1": 1, "cap-2": 2}
PARTS = (*FACES, *CORNERS, *CAPS, "cap-corner", "rock-macro")
LODS = (0, 1, 2)
STEP = (0.1, 0.25, 0.6)  # grid spacing per level of detail
ARM = 1.2  # corner arm length along each face
EDGE_RADIUS = 0.25  # how far round the edge the corner's and cap's bend reaches
LIP, BACK = 0.9, 1.4  # cap: down the face, back over the top
KNOB_IN = (1.1, 0.7)  # cap-corner: horizontal and vertical reach into the box
KNOB_OUT = (0.42, 0.32)  # cap-corner: reach past the faces and above the top
DIP = 0.15  # how deep a slab's border sinks into the box
BORDER = 0.3  # the width of the border's fall
MACRO_EDGE = 1024
MACRO_METRES = 32.0  # world metres one macro repeat covers
STAND_OFF = 0.36  # the Ranger's Climb_* distance from the grip plane to the pelvis
SHARP_ANGLE = math.radians(50)
MOSS_CHROMA = 2.4  # how far the moss tint pushes the mossy_rock mean colour away from grey

_common = {}


def use_common(common):
    for name in common["NAMES"]:
        globals()[name] = common[name]
    _common.update(common)


def smoothstep(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def seed(*keys):
    return int(rnd(*keys) * 2**31)


# ---------------------------------------------------------------- periodic noise at points

def pnoise(u, v, cells, key):
    """Smooth value noise at points (u, v), periodic with period 1 in both; ``cells`` lattice cells per period."""
    cu, cv = cells
    grid = np.random.RandomState(seed("noise", *key)).rand(cv, cu)
    x, y = np.asarray(u, dtype=float) * cu, np.asarray(v, dtype=float) * cv
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    x0, y0, x1, y1 = x0 % cu, y0 % cv, (x0 + 1) % cu, (y0 + 1) % cv
    a = grid[y0, x0] * (1 - fx) + grid[y0, x1] * fx
    b = grid[y1, x0] * (1 - fx) + grid[y1, x1] * fx
    return a * (1 - fy) + b * fy


def pfbm(u, v, base, octaves, key, stretch=(1, 1)):
    """Fractal periodic noise in [0, 1] (period 1 in u and v)."""
    total, weight, amp = 0.0, 0.0, 1.0
    for o in range(octaves):
        c = base * 2**o
        total = total + amp * pnoise(u, v, (max(1, int(c * stretch[0])), max(1, int(c * stretch[1]))), (*key, o))
        weight += amp
        amp *= 0.5
    return total / weight


def signed(u, v, base, octaves, key, stretch=(1, 1)):
    """Fractal noise in about [-1, 1]."""
    return (pfbm(u, v, base, octaves, key, stretch) - 0.5) * 2


# ---------------------------------------------------------------- relief

def border_mask(s, y, s_half, y_lo, y_hi, key):
    """1 inside a slab, falling to 0 over BORDER at its ragged border."""
    u, v = s / 8.0, y / 8.0
    d = np.minimum(s_half - np.abs(s), np.minimum(y - y_lo, y_hi - y))
    d = d + 0.14 * signed(u, v, 3, 2, (*key, "border")) + 0.07 * signed(u, v, 12, 2, (*key, "ragged"))
    return smoothstep(0.0, BORDER, d)


def sheer_plateau(s, y, key):
    """Smooth fracture planes: two ridges and a valley of tilted planes, a broad swell and fine roughness."""
    planes = []
    for k in range(4):
        pk = (*key, "plane", k)
        planes.append(0.26 + 0.12 * rnd(*pk, "c") + (rnd(*pk, "a") - 0.5) * 0.24 * s + (rnd(*pk, "b") - 0.5) * 0.16 * (y - 1.5))
    facets = np.maximum(np.minimum(planes[0], planes[1]), np.minimum(planes[2], planes[3]))
    u, v = s / 8.0, y / 8.0
    swell = 0.09 * signed(u, v, 2, 2, (*key, "swell"))
    fine = 0.018 * signed(u, v, 24, 3, (*key, "fine"))
    # A shallow fracture step or two across the slab.
    step = 0.0
    for k in range(2):
        pk = (*key, "step", k)
        angle = (rnd(*pk, "a") - 0.5) * 1.2
        offset = (rnd(*pk, "o") - 0.5) * 2.0
        line = s * math.sin(angle) + (y - 1.5) * math.cos(angle) - offset + 0.08 * signed(u, v, 8, 2, (*pk, "w"))
        step = step + 0.05 * (rnd(*pk, "h") - 0.3) * smoothstep(-0.05, 0.05, line)
    return facets + swell + fine + step


def climb_plateau(s, y, key, base=0.36):
    """Strata of blocks: ledges where a stratum stands prouder than the one above, joints, wandering cracks."""
    u, v = s / 8.0, y / 8.0
    yy = y + 0.12 * signed(u, v * 0.3, 4, 2, (*key, "wobble"))
    # The strata's bedding dips a little across the slab, so ledges are not level lines.
    yy = yy + (rnd(*key, "dip") - 0.5) * 0.16 * s
    edges, y_, k = [-1.2], -0.6, 0
    while y_ < PITCH + 0.8:
        y_ += 0.6 + 1.1 * rnd(*key, "layer", k) ** 1.3
        edges.append(y_)
        k += 1
    out = np.zeros_like(s)
    for i in range(len(edges) - 1):
        lo, hi = edges[i], edges[i + 1]
        inside = smoothstep(lo - 0.015, lo + 0.06, yy) * (1 - smoothstep(hi - 0.05, hi + 0.015, yy))
        # Blocks along the stratum, each with its own depth and lean, divided by slanted joints; the depth
        # also drifts along the stratum, so a ledge widens and narrows.
        cuts = sorted((rnd(*key, "cut", i, j) - 0.5) * 2 * (PITCH / 2 + 0.4) for j in range(1 + int(1.4 * rnd(*key, "cuts", i))))
        depth = 0.42 * rnd(*key, "depth", i, 0) - 0.14
        drift = 0.16 * signed(u, np.full_like(u, 0.11 * i), 3, 2, (*key, "drift", i))
        block, joint = np.full_like(s, depth) + drift, np.zeros_like(s)
        for j, c in enumerate(cuts):
            slant = (rnd(*key, "slant", i, j) - 0.5) * 0.9
            c = c + slant * (yy - lo) + 0.06 * signed(np.full_like(yy, 0.1 * j), yy / 8.0, 8, 2, (*key, "cutw", i, j))
            side = smoothstep(c - 0.12, c + 0.12, s)
            block = block + side * (0.16 * rnd(*key, "depth", i, j + 1) - 0.08)
            joint = np.maximum(joint, (1 - smoothstep(0.02, 0.07, np.abs(s - c))) * (rnd(*key, "open", i, j) > 0.7))
        lean = 0.08 * (rnd(*key, "lean", i) - 0.35) * (yy - lo)
        # Rounded weathering of each block's top: the ledge's lip falls away a little.
        lip = -0.05 * smoothstep(hi - 0.18, hi, yy)
        out = out + inside * (block + lean + lip - 0.1 * joint)
    # Cracks: wandering clefts through several strata.
    for c in range(1 + int(rnd(*key, "cracks") * 2)):
        ck = (*key, "crack", c)
        cx = (rnd(*ck, "x") - 0.5) * 2.0
        y0 = -0.2 + 1.4 * rnd(*ck, "y0")
        y1 = y0 + 2.0 + 1.6 * rnd(*ck, "len")
        slope = (rnd(*ck, "slope") - 0.5) * 0.6
        path = cx + slope * (y - y0) + 0.2 * signed(np.full_like(v, 0.13 * c), v, 6, 3, (*ck, "path"))
        width = 0.14 + 0.08 * pfbm(np.full_like(v, 0.4), v, 5, 2, (*ck, "width"))
        along = smoothstep(y0, y0 + 0.8, y) * (1 - smoothstep(y1 - 0.8, y1, y))
        out = out - 0.2 * along * np.clip(1 - np.abs(s - path) / width, 0.0, 1.0) ** 1.5
    fine = 0.025 * signed(u, v, 24, 3, (*key, "fine"))
    knobs = 0.04 * signed(u, v, 10, 2, (*key, "knobs"))
    return base + out + fine + knobs


def slab(s, y, s_half, y_lo, y_hi, family, key):
    plateau = sheer_plateau(s, y, key) if family == "sheer" else climb_plateau(s, y, key)
    m = border_mask(s, y, s_half, y_lo, y_hi, key)
    # Never below the box face inside the slab, so no crack opens onto the collider.
    return np.maximum(plateau, 0.06) * m - DIP * (1 - m)


# ---------------------------------------------------------------- materials

def mean_colour(path, step=16):
    image = bpy.data.images.load(path, check_existing=True)
    pixels = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(pixels)
    return pixels.reshape(-1, 4)[::step, :3].mean(axis=0)


def tints(inputs):
    """COLOR_0 multipliers that turn the face scan's mean colour towards the boulder scan's and the moss scan's."""
    if "tints" not in _common:
        lin = lambda c: np.array([srgb_to_linear(float(k)) for k in c])
        face, boulder, moss = (lin(mean_colour(inputs[name])) for name in ("diff", "boulder", "moss"))
        drift = boulder / face
        # The moss scan's mean is half grey rock: its chroma is doubled towards the living moss.
        grey = moss.mean()
        green = np.clip(grey + MOSS_CHROMA * (moss - grey), 0.01, None) / face
        _common["tints"] = (drift / drift.mean(), green / green.max())
    return _common["tints"]


def image_node(tree, path, colour):
    node = tree.nodes.new("ShaderNodeTexImage")
    node.image = bpy.data.images.load(path, check_existing=True)
    node.image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    return node


def rock_material(inputs):
    existing = bpy.data.materials.get("crag-rock")
    if existing is not None:
        return existing
    mat = bpy.data.materials.new("crag-rock")
    mat.use_nodes = True
    tree = mat.node_tree
    nodes, links = tree.nodes, tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    diff, nor, arm = image_node(tree, inputs["diff"], True), image_node(tree, inputs["normal"], False), image_node(tree, inputs["arm"], False)
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    mul = nodes.new("ShaderNodeMix")
    mul.data_type, mul.blend_type = "RGBA", "MULTIPLY"
    mul.inputs[0].default_value = 1.0
    links.new(diff.outputs["Color"], mul.inputs[6])
    links.new(attr.outputs["Color"], mul.inputs[7])
    links.new(mul.outputs[2], bsdf.inputs["Base Color"])
    nmap = nodes.new("ShaderNodeNormalMap")
    links.new(nor.outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    sep = nodes.new("ShaderNodeSeparateColor")
    links.new(arm.outputs["Color"], sep.inputs["Color"])
    links.new(sep.outputs[1], bsdf.inputs["Roughness"])
    links.new(sep.outputs[2], bsdf.inputs["Metallic"])
    # The glTF exporter reads ambient occlusion from a "glTF Material Output" group's Occlusion socket.
    group = bpy.data.node_groups.get("glTF Material Output")
    if group is None:
        group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    out = nodes.new("ShaderNodeGroup")
    out.node_tree = group
    links.new(sep.outputs[0], out.inputs["Occlusion"])
    return mat


# ---------------------------------------------------------------- colour

def colour_field(points, normals, cavity, family, part, inputs):
    """COLOR_0 per vertex: cavity darkening, moss on up-facing rock, sheer streaks, a broad drift."""
    drift_tint, green = tints(inputs)
    x, y, z = points[:, 0], points[:, 1], points[:, 2]
    u, v = x / 8.0, y / 8.0
    col = np.ones((len(points), 3)) * np.clip(1.0 + 3.0 * cavity, 0.45, 1.08)[:, None]
    # Recessed rock (near the box) is shadowed by its neighbours.
    col *= np.clip(0.78 + 0.9 * np.maximum(z, 0.0), 0.78, 1.0)[:, None] if family in ("sheer", "climb") else 1.0
    drift = pfbm(u, v, 2, 2, (part, "drift"))
    col *= (0.9 + 0.2 * drift)[:, None]
    col = col * (1 + (drift_tint[None, :] - 1) * (0.6 * smoothstep(0.45, 0.8, drift))[:, None])
    if family == "sheer":
        streak = pfbm(u, v, 20, 3, (part, "streak"), (1.0, 0.12))
        dark = smoothstep(0.5, 0.75, streak) * (0.4 + 0.6 * smoothstep(0.0, PITCH, y))
        col *= (1 - 0.3 * dark)[:, None]
    up = smoothstep(0.45, 0.85, normals[:, 1])
    patch = pfbm(u, v + z * 0.1, 6, 4, (part, "moss"))
    moss = up * smoothstep(0.4, 0.6, patch) * (0.35 if family == "sheer" else 0.9)
    moss = np.clip(moss + 0.4 * smoothstep(0.02, 0.08, -cavity) * smoothstep(0.45, 0.65, patch), 0, 1)
    col = col * (1 - moss[:, None]) + (col * green[None, :] * 0.85) * moss[:, None]
    return np.clip(col, 0.0, 1.0)


# ---------------------------------------------------------------- mesh

def grid_mesh(name, P, uv_front, collection, parent, inputs, family, part, uv_top=None):
    """A mesh from a (rows, cols, 3) grid of glTF points; quads run along the columns then the rows."""
    rows, cols = P.shape[:2]
    faces = []
    for j in range(rows - 1):
        for i in range(cols - 1):
            a = j * cols + i
            faces.append((a, a + 1, a + cols + 1, a + cols))
    return finish_mesh(name, P.reshape(-1, 3), faces, uv_front.reshape(-1, 2), collection, parent, inputs, family, part,
                       None if uv_top is None else uv_top.reshape(-1, 2), cavity_grid(P))


def cavity_grid(P, reach=3):
    """Each grid point's offset from the mean of its neighbourhood, to measure along its normal."""
    rows, cols = P.shape[:2]
    pad = np.pad(P, ((reach, reach), (reach, reach), (0, 0)), mode="edge")
    acc = np.zeros_like(P)
    n = 2 * reach + 1
    for dj in range(n):
        for di in range(n):
            acc += pad[dj:dj + rows, di:di + cols]
    return P - acc / (n * n)


def finish_mesh(name, pts, faces, uv_front, collection, parent, inputs, family, part, uv_top=None, offsets=None):
    mesh = bpy.data.meshes.new(f"{name}-geometry")
    mesh.from_pydata([Vector((p[0], -p[2], p[1])) for p in pts], [], faces)
    mesh.update()
    for poly in mesh.polygons:
        poly.use_smooth = True
    mesh.set_sharp_from_angle(angle=SHARP_ANGLE)
    mesh.materials.append(rock_material(inputs))
    normals = np.array([(v.normal.x, v.normal.z, -v.normal.y) for v in mesh.vertices])
    cavity = np.sum(offsets.reshape(-1, 3) * normals, axis=1) if offsets is not None else np.zeros(len(pts))
    colours = colour_field(np.asarray(pts), normals, cavity, family, part, inputs)
    uv = mesh.uv_layers.new(name="UVMap")
    col = mesh.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    for poly in mesh.polygons:
        top = uv_top is not None and abs(poly.normal.z) > 0.6  # Blender +Z is glTF +Y
        for loop in poly.loop_indices:
            vi = mesh.loops[loop].vertex_index
            uv.data[loop].uv = tuple(uv_top[vi] if top else uv_front[vi])
            c = colours[vi]
            col.data[loop].color = (float(c[0]), float(c[1]), float(c[2]), 1.0)
    mesh.color_attributes.active_color = col
    mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.parent = parent
    return obj


def samples(lo, hi, step):
    n = max(1, int(round((hi - lo) / step)))
    return np.linspace(lo, hi, n + 1)


def texcoords(part, a, b):
    """UVs at one texture repeat per PITCH metres, offset and (for every other part) mirrored per part."""
    flip = -1.0 if rnd(part, "flip") >= 0.5 else 1.0
    return np.stack([flip * a / PITCH + round(rnd(part, "u"), 3), b / PITCH + round(rnd(part, "v"), 3)], -1)


def climb_meta(family, faces, gripline, tile, extra=None):
    climbable = family == "climb"
    climb = {"grip": "rock" if climbable else None, "clips": "Climb_*" if climbable else None, **faces,
             "standOff": STAND_OFF, "gripLine": gripline, "tile": tile, **(extra or {})}
    if not climbable:
        climb["note"] = "Sheer: smooth and unclimbable, no grip."
    return climb


# ---------------------------------------------------------------- parts

def face_relief(x, y, family, variant):
    return slab(x, y, PITCH / 2 + OVERLAP, -OVERLAP, PITCH + OVERLAP, family, ("face", family, variant))


def build_face(part, lod, col, root, inputs):
    family, variant = FACES[part]
    xs, ys = samples(-PITCH / 2 - OVERLAP, PITCH / 2 + OVERLAP, STEP[lod]), samples(-OVERLAP, PITCH + OVERLAP, STEP[lod])
    X, Y = np.meshgrid(xs, ys)
    Z = face_relief(X, Y, family, variant)
    P = np.stack([X, Y, Z], -1)
    uv = texcoords(part, X, Y)
    uv_top = texcoords(part, X, -Z)
    grid_mesh(f"crag.{part}.mesh", P, uv, col, root, inputs, family, part, uv_top)
    # Relief statistics over the cell, from the LOD0 sampling, so every level carries the same metadata.
    X0, Y0 = np.meshgrid(samples(-PITCH / 2, PITCH / 2, STEP[0]), samples(0.0, PITCH, STEP[0]))
    Z0 = face_relief(X0, Y0, family, variant)
    mean, low, top = round(float(Z0.mean()), 4), round(float(Z0.min()), 4), round(float(Z0.max()), 4)
    climb = climb_meta(family, {"approach": "+Z", "face": {"normal": [0, 0, 1], "z": mean, "width": PITCH, "height": PITCH}},
                       {"from": [0, 0.0, mean], "to": [0, PITCH, mean]}, {"axes": ["+X", "+Y"], "pitch": [PITCH, PITCH], "overlap": OVERLAP},
                       {"relief": {"plane": 0.0, "min": low, "mean": mean, "max": top}})
    proxies = [proxy("face", "climbable" if family == "climb" else "solid", (-PITCH / 2, 0.0, 0.0), (PITCH / 2, PITCH, mean))]
    return {"family": family, "kind": "face", "cell": {"width": PITCH, "height": PITCH, "depth": top},
            "climb": climb, "collisionProxies": proxies, "gripEnds": ((0, 0.0, mean), (0, PITCH, mean))}


def bend(a_s, arm_a, arm_b):
    """The unfolded coordinate, base point and outward normal along a path that turns round an edge.

    ``a_s`` runs from -arm_a (along the first face, normal +second axis) round the edge to +arm_b (along the second
    face, normal +first axis); within EDGE_RADIUS of the edge the base point is the edge and the normal turns."""
    base, normal = [], []
    for a in a_s:
        if a <= -EDGE_RADIUS:
            base.append((a + EDGE_RADIUS, 0.0)), normal.append((0.0, 1.0))
        elif a >= EDGE_RADIUS:
            base.append((0.0, -(a - EDGE_RADIUS))), normal.append((1.0, 0.0))
        else:
            phi = (a + EDGE_RADIUS) / (2 * EDGE_RADIUS) * math.pi / 2
            base.append((0.0, 0.0)), normal.append((math.sin(phi), math.cos(phi)))
    return np.array(base), np.array(normal)


def corner_path(step, arm_a, arm_b):
    total_a, total_b = arm_a + EDGE_RADIUS, arm_b + EDGE_RADIUS
    a_s = np.concatenate([np.linspace(-total_a, -EDGE_RADIUS, max(1, int(round(arm_a / step))) + 1)[:-1],
                          np.linspace(-EDGE_RADIUS, EDGE_RADIUS, max(2, int(round(0.6 / step))) + 1)[:-1],
                          np.linspace(EDGE_RADIUS, total_b, max(1, int(round(arm_b / step))) + 1)])
    return a_s


def corner_relief(A, Y, family, variant):
    key = ("corner", family, variant)
    half = ARM + EDGE_RADIUS
    plateau = sheer_plateau(A, Y, key) if family == "sheer" else climb_plateau(A, Y, key, base=0.42)
    m = border_mask(A, Y, half, -OVERLAP, PITCH + OVERLAP, key)
    # The bend stands a little prouder, so the corner reads as one rounded edge over the panels' ends.
    proud = 0.08 * (1 - smoothstep(EDGE_RADIUS, half, np.abs(A)))
    return np.maximum(plateau + proud, 0.06) * m - DIP * (1 - m)


def build_corner(part, lod, col, root, inputs):
    family, variant = CORNERS[part]
    a_s = corner_path(STEP[lod], ARM, ARM)
    ys = samples(-OVERLAP, PITCH + OVERLAP, STEP[lod])
    A, Y = np.meshgrid(a_s, ys)
    R = corner_relief(A, Y, family, variant)
    base, nrm = bend(a_s, ARM, ARM)
    P = np.stack([base[None, :, 0] + nrm[None, :, 0] * R, Y, base[None, :, 1] + nrm[None, :, 1] * R], -1)
    uv = texcoords(part, A, Y)
    grid_mesh(f"crag.{part}.mesh", P, uv, col, root, inputs, family, part)
    A0, Y0 = np.meshgrid(corner_path(STEP[0], ARM, ARM), samples(0.0, PITCH, STEP[0]))
    R0 = corner_relief(A0, Y0, family, variant)
    mean, top = round(float(R0.mean()), 4), round(float(R0.max()), 4)
    climb = climb_meta(family, {"approach": "+X+Z", "faces": [{"normal": [0, 0, 1], "z": mean, "width": ARM}, {"normal": [1, 0, 0], "x": mean, "width": ARM}]},
                       {"from": [0.0, 0.0, 0.0], "to": [0.0, PITCH, 0.0]}, {"axes": ["+Y"], "pitch": [PITCH], "overlap": OVERLAP},
                       {"relief": {"plane": 0.0, "mean": mean, "max": top}})
    tag = "climbable" if family == "climb" else "solid"
    proxies = [proxy("arm-z", tag, (-ARM - EDGE_RADIUS, 0.0, 0.0), (mean, PITCH, mean)),
               proxy("arm-x", tag, (0.0, 0.0, -ARM - EDGE_RADIUS), (mean, PITCH, 0.0))]
    return {"family": family, "kind": "corner", "cell": {"width": ARM + EDGE_RADIUS, "height": PITCH, "depth": top},
            "climb": climb, "collisionProxies": proxies, "gripEnds": ((0.0, 0.0, 0.0), (0.0, PITCH, 0.0))}


def cap_relief(X, A, variant):
    """Cap relief over x and the bend coordinate a (negative down the lip, positive back over the top)."""
    key = ("cap", variant)
    u, v = X / 8.0, A / 8.0
    back = np.clip(A, 0.0, None) / (BACK + EDGE_RADIUS)
    plateau = 0.3 + 0.08 * signed(u, v, 3, 2, (*key, "swell")) - 0.16 * back
    plateau = plateau + 0.03 * signed(u, v, 24, 3, (*key, "fine"))
    for k in range(2):
        pk = (*key, "shelf", k)
        line = A - (rnd(*pk, "a") - 0.5) * 1.2 + 0.15 * signed(u, np.full_like(u, 0.2 * k), 6, 2, (*pk, "w"))
        plateau = plateau + 0.07 * (rnd(*pk, "h") - 0.5) * smoothstep(-0.04, 0.04, line)
    m = border_mask(X, A, PITCH / 2 + OVERLAP, -LIP - EDGE_RADIUS, BACK + EDGE_RADIUS, key)
    return plateau * m - DIP * (1 - m)


def build_cap(part, lod, col, root, inputs):
    variant = CAPS[part]
    a_s = corner_path(STEP[lod], LIP, BACK)
    xs = samples(-PITCH / 2 - OVERLAP, PITCH / 2 + OVERLAP, STEP[lod])
    X, A = np.meshgrid(xs, a_s)
    R = cap_relief(X, A, variant)
    # The bend's first axis is y (the lip runs down -y with normal +Z), its second z (the top runs back along -z
    # with normal +Y).
    base, nrm = bend(a_s, LIP, BACK)
    PY = base[:, None, 0] + nrm[:, None, 0] * R
    PZ = base[:, None, 1] + nrm[:, None, 1] * R
    P = np.stack([X, PY, PZ], -1)
    uv = texcoords(part, X, A)
    grid_mesh(f"crag.{part}.mesh", P, uv, col, root, inputs, "cap", part)
    top = round(float(P[..., 1].max()), 4)
    climb = {"grip": None, "clips": None, "approach": "+Z", "standOff": STAND_OFF,
             "top": {"normal": [0, 1, 0], "y": 0.0, "depth": BACK}, "lip": {"normal": [0, 0, 1], "z": 0.0, "height": LIP},
             "tile": {"axes": ["+X"], "pitch": [PITCH], "overlap": OVERLAP},
             "note": "The rim over a top edge, where a climb tops out: walkable, not a grip."}
    proxies = [proxy("rim", "solid", (-PITCH / 2, -LIP, -BACK), (PITCH / 2, top, 0.3))]
    return {"family": "cap", "kind": "cap", "cell": {"width": PITCH, "height": LIP, "depth": BACK},
            "climb": climb, "collisionProxies": proxies, "gripEnds": None}


def build_cap_corner(part, lod, col, root, inputs):
    rings, segs = ((14, 28), (8, 14), (5, 8))[lod]
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    # A rounded box corner: it reaches KNOB_OUT past each face and the top, KNOB_IN into the box, so it meets the
    # caps' and corners' relief instead of bulging out of the crag.
    rh, rv = KNOB_IN
    for v in bm.verts:
        d = Vector((v.co.x, v.co.z, -v.co.y))  # glTF direction
        u_, w_ = math.atan2(d.z, d.x) / (2 * math.pi) + 0.5, d.y * 0.5 + 0.5
        r = 0.8 + 0.4 * float(pfbm(np.array(u_), np.array(w_), 4, 3, ("cap-corner", "lump")))
        reach = [KNOB_OUT[0] if d.x > 0 else rh, KNOB_OUT[1] if d.y > 0 else rv, KNOB_OUT[0] if d.z > 0 else rh]
        p = (d.x * reach[0] * r, d.y * reach[1] * r, d.z * reach[2] * r)
        v.co = Vector((p[0], -p[2], p[1]))
    buried = [f for f in bm.faces if all(v.co.x < -0.1 and v.co.y > 0.1 and v.co.z < -0.1 for v in f.verts)]
    bmesh.ops.delete(bm, geom=buried, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.verts.index_update()
    pts = np.array([(v.co.x, v.co.z, -v.co.y) for v in bm.verts])
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    uv_front = texcoords(part, pts[:, 0] - pts[:, 2], pts[:, 1])
    uv_top = texcoords(part, pts[:, 0], -pts[:, 2])
    radial = np.linalg.norm(pts / np.where(pts > 0, [KNOB_OUT[0], KNOB_OUT[1], KNOB_OUT[0]], [rh, rv, rh]), axis=1, keepdims=True)
    offsets = (radial - 1.0) * 0.12 * pts / np.maximum(np.linalg.norm(pts, axis=1, keepdims=True), 1e-6)
    finish_mesh(f"crag.{part}.mesh", pts, faces, uv_front, col, root, inputs, "cap", part, uv_top, offsets)
    top = round(float(pts[:, 1].max()), 4)
    reach = round(float(max(pts[:, 0].max(), pts[:, 2].max())), 4)
    climb = {"grip": None, "clips": None, "approach": "+X+Z", "standOff": STAND_OFF, "top": {"normal": [0, 1, 0], "y": 0.0},
             "note": "The knob over a top corner: walkable, not a grip."}
    proxies = [proxy("knob", "solid", (-rh, -rv, -rh), (reach, top, reach))]
    return {"family": "cap", "kind": "cap-corner", "cell": {"width": rh, "height": rv, "depth": rh},
            "climb": climb, "collisionProxies": proxies, "gripEnds": None}


def macro_pixels(inputs, size=MACRO_EDGE):
    """The tileable macro variation: linear RGB multipliers halved (0.5 = no change), one repeat per MACRO_METRES."""
    drift_tint, green = tints(inputs)
    coords = (np.arange(size) + 0.5) / size
    U, V = np.meshgrid(coords, coords)
    broad = pfbm(U, V, 3, 5, ("macro", "broad"))
    patches = pfbm(U, V, 6, 4, ("macro", "patch"))
    bands = pfbm(U, V, 2, 3, ("macro", "bands"), (1, 6))
    bright = 0.8 + 0.36 * broad + 0.1 * (bands - 0.5)
    col = np.ones((size, size, 3)) * bright[..., None]
    col = col * (1 + (drift_tint[None, None, :] - 1) * smoothstep(0.45, 0.75, patches)[..., None])
    mossy = 0.35 * smoothstep(0.6, 0.85, broad * 0.6 + patches * 0.4)
    col = col * (1 + (green[None, None, :] * 0.9 - 1) * mossy[..., None])
    return np.clip(col * 0.5, 0.0, 1.0)


def build_macro(part, lod, col, root, inputs):
    pixels = macro_pixels(inputs)
    # A colour texture: its sRGB-decoded (linear) value is half the multiplier, so it reads as a glTF base colour.
    encoded = np.where(pixels <= 0.0031308, pixels * 12.92, 1.055 * np.power(pixels, 1 / 2.4) - 0.055)
    image = make_image("crag-rock-macro", encoded, True)
    mat = bpy.data.materials.get("crag-macro") or bpy.data.materials.new("crag-macro")
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Metallic"].default_value = 0.0
    mesh = bpy.data.meshes.new("crag.rock-macro-geometry")
    # glTF quad on the XZ plane facing +Y, u along +X, v along +Z (as the greyhaven-terrain layers).
    mesh.from_pydata([Vector((-0.5, 0.5, 0)), Vector((0.5, 0.5, 0)), Vector((0.5, -0.5, 0)), Vector((-0.5, -0.5, 0))], [], [(0, 3, 2, 1)])
    mesh.update()
    uv = mesh.uv_layers.new(name="UVMap")
    corners = {0: (0, 1), 1: (1, 1), 2: (1, 0), 3: (0, 0)}
    for poly in mesh.polygons:
        for loop in poly.loop_indices:
            uv.data[loop].uv = corners[mesh.loops[loop].vertex_index]
    mesh.materials.append(mat)
    obj = bpy.data.objects.new("crag.rock-macro.mesh", mesh)
    col.objects.link(obj)
    obj.parent = root
    stats = pixels.reshape(-1, 3)
    return {"family": "macro", "kind": "macro", "cell": {"width": 1.0, "height": 0.0, "depth": 1.0},
            "macro": {"worldMetres": MACRO_METRES, "edge": MACRO_EDGE, "mean": [round(float(c), 4) for c in stats.mean(axis=0)],
                      "min": round(float(stats.min()), 4), "max": round(float(stats.max()), 4)},
            "gripEnds": None}


# ---------------------------------------------------------------- entry points

def build(part, lod, collection, inputs, location=(0, 0, 0)):
    """Build one part at one level under an empty root ``crag.<part>`` at ``location`` (glTF axes)."""
    if part not in PARTS or lod not in LODS:
        raise ValueError(f"crag part must be one of {', '.join(PARTS)} and lod 0, 1 or 2")
    root = bpy.data.objects.new(f"crag.{part}", None)
    root.empty_display_size = 0.3
    collection.objects.link(root)
    builder = (build_face if part in FACES else build_corner if part in CORNERS else build_cap if part in CAPS
               else build_cap_corner if part == "cap-corner" else build_macro)
    info = builder(part, lod, collection, root, inputs)
    ends = info.pop("gripEnds")
    if ends:
        empty("climb.bottom", collection, root, ends[0])
        empty("climb.top", collection, root, ends[1])
    root.location = to_blender(location)
    return root, info


INPUTS = {"common", "diff", "normal", "arm", "boulder", "moss"}


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or set(arguments) != {"schemaVersion", "part", "lod"} or arguments["schemaVersion"] != 1:
        raise ValueError("crag arguments must be exactly {schemaVersion: 1, part, lod}")
    if arguments["part"] not in PARTS or arguments["lod"] not in LODS:
        raise ValueError(f"crag part must be one of {', '.join(PARTS)} and lod 0, 1 or 2")
    if set(inputs) != INPUTS:
        raise ValueError(f"crag recipe takes exactly {', '.join(sorted(INPUTS))}")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_common(inputs.load_source("common"))
    part, lod = arguments["part"], arguments["lod"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    root, info = build(part, lod, bpy.context.scene.collection, inputs)
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
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=part != "rock-macro",
        export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_animations=False, export_skins=False,
        export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "part": part, "lod": lod, "unit": "meter", "axes": "right-handed-y-up",
            "triangleCount": triangles, "bounds": bounds, **info}
