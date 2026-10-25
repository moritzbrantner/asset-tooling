"""Original soldier and knight armour fitted to a humanoid's rest pose (#117) for the pinned Blender script backend.

The declared input ``target`` is the composed base character GLB: the Peasant outfit, the head subset and the
65-joint skeleton in its rest pose. Every piece is fitted to that geometry. A piece samples the rest-pose vertices
skinned to its joints in rings around an axis, keeps the outermost radius in each angular sector, smooths it and adds
a clearance, so the plate follows the real body and clothing instead of a primitive proxy.

``arguments["output"]`` selects one of two GLBs per kit:

- ``plates``: the rigid pieces (owner answer #117 Q2 = A). Each piece is one mesh node named ``<kit>.<piece>``
  with an identity transform. Its geometry is in the character's rest model space (metres, glTF +Y up, facing +Z),
  so the piece attaches to the single joint it rides on through a socket that is the inverse of that joint's rest
  transform, like the hairstyles' ``head.hair`` socket. The piece then sits where it was fitted and follows the joint.
- ``cloth``: the garments that must deform with the body (the soldier's gambeson tunic and sash, the knight's
  tabard). They are skinned to the target's own joints, so ``scene.compose.skinned.gltf@1`` adds them to the
  character. The gambeson copies the Peasant shirt's surface and skin weights, offset outward, and adds a quilted
  skirt; the other garments are fitted surfaces whose weights blend the nearest body vertices.

The resident kits (#376) reuse the fitting for plain clothes: ``farmer`` (smock), ``innkeeper`` (apron) and ``monk``
(ankle-length habit), each with a belt as its plate. The facial hair moved to ``hair_beards.py`` (#380).

Materials are factor-only PBR (docs/style-humanlike.md): ``steel``, ``iron``, ``leather``, ``gambeson`` and the
``faction`` slot (owner answer Q11: the knight's tabard and the soldier's sash, default muted dark red). The
observations list, per piece, the joint it rides on and the base-character mesh nodes it hides (the per-piece
hidden-body-region list, Q12). No randomness is used.
"""
import hashlib
import json
import math
import struct

import bmesh
import bpy
import numpy
from mathutils import Matrix, Quaternion, Vector, kdtree

# Class starter outfits (#379): the seven mmorpg classes over the same Peasant base, in the Greyhaven Marshal's style.
CLASS_KITS = ("class.warden", "class.ranger", "class.arcanist", "class.necromancer", "class.rogue", "class.cleric", "class.druid")
KITS = ("soldier", "knight", "farmer", "innkeeper", "monk", *CLASS_KITS, "redbrand", "tanner")
# Resident outfits (#376): plain clothes over the Peasant base; their only rigid piece is a belt. The tanner (#378) is
# the female figure's: a long work skirt and a leather apron over the Female_Peasant outfit.
RESIDENT_KITS = ("farmer", "innkeeper", "monk", "tanner")
# Kits fitted on the female figure (#378); every other kit is fitted on the male figure.
FEMALE_KITS = ("tanner",)
OUTPUTS = ("plates", "cloth")
MATERIALS = {
    # name: (linear base colour, metallic, roughness)
    "steel": ((.62, .64, .66), 1.0, .32),
    "iron": ((.29, .28, .27), 1.0, .48),
    "leather": ((.2, .1, .05), 0.0, .72),
    "gambeson": ((.42, .36, .26), 0.0, .9),
    "faction": ((.25, .04, .04), 0.0, .8),
    # Resident cloth (#376): plant-dyed and undyed wool and linen, told apart by colour at the game camera.
    "smock": ((.16, .17, .08), 0.0, .9),
    "linen": ((.62, .6, .52), 0.0, .85),
    "habit": ((.09, .055, .03), 0.0, .92),
    "rope": ((.36, .28, .15), 0.0, .9),
    # The tanner (#378): a dark green-grey wool work skirt under a tan-brown, oiled cowhide apron.
    "skirt.wool": ((.045, .055, .04), 0.0, .92),
    "leather.tan": ((.16, .075, .03), 0.0, .62),
}
SHARP_ANGLE = math.radians(35)
# The Peasant base's mesh nodes and the head part per figure; ``use_figure`` switches them to the target's (#378).
FIGURES = {
    "male": ("Male_Peasant_Body", "Male_Peasant_Legs", "Male_Peasant_Arms", "Male_Peasant_Feet", "SuperHero_Male"),
    "female": ("Female_Peasant_Body", "Female_Peasant_Legs", "Female_Peasant_Arms", "Female_Peasant_Feet", "Superhero_Female"),
}
SHIRT, LEGS, ARMS, FEET, HEAD = FIGURES["male"]


def use_figure(figure):
    global SHIRT, LEGS, ARMS, FEET, HEAD
    SHIRT, LEGS, ARMS, FEET, HEAD = FIGURES[figure]
# Pieces whose wearer hides a base mesh node completely (the hidden-body-region list, Q12).
HIDES = {"soldier.gambeson": [SHIRT], "farmer.smock": [SHIRT], "monk.habit": [SHIRT]}
# Tunics: the Peasant shirt's surface and skin weights pushed out (material, offset), plus a fitted skirt.
TUNICS = {"soldier.gambeson": ("gambeson", .012), "farmer.smock": ("smock", .01), "monk.habit": ("habit", .012)}


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "kit", "output"}:
        raise ValueError("armor requires exactly schemaVersion, kit and output")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("armor schemaVersion must be 1")
    if p["kit"] not in KITS or p["output"] not in OUTPUTS:
        raise ValueError(f"armor kit must be one of {', '.join(KITS)} and output plates or cloth")
    if set(inputs) != {"target"}:
        raise ValueError("armor takes exactly the declared input target")


def to_blender(p):
    return (p[0], -p[2], p[1])


def to_gltf(v):
    return Vector((v.x, v.z, -v.y))


# ---------------------------------------------------------------------------------------------- target analysis

def glb_json(path):
    with open(path, "rb") as handle:
        data = handle.read()
    length, kind = struct.unpack_from("<II", data, 12)
    if kind != 0x4E4F534A:
        raise ValueError("target GLB must start with a JSON chunk")
    return json.loads(data[20:20 + length])


def rest_worlds(gltf):
    nodes = gltf["nodes"]
    parent = {child: index for index, node in enumerate(nodes) for child in node.get("children", [])}
    cache = {}

    def world(index):
        if index not in cache:
            node = nodes[index]
            if "matrix" in node:
                local = Matrix([node["matrix"][i::4] for i in range(4)])
            else:
                x, y, z, w = node.get("rotation", (0, 0, 0, 1))
                local = (Matrix.Translation(node.get("translation", (0, 0, 0))) @ Quaternion((w, x, y, z)).to_matrix().to_4x4()
                         @ Matrix.Diagonal((*node.get("scale", (1, 1, 1)), 1)))
            cache[index] = world(parent[index]) @ local if index in parent else local
        return cache[index]
    return {node.get("name"): world(index) for index, node in enumerate(nodes)}


class Body:
    """Rest-pose vertices of the target's skinned meshes in glTF model space, with their joint weights."""

    def __init__(self, rig):
        self.positions, self.weights, self.meshes = [], [], []
        for obj in sorted((o for o in bpy.context.scene.objects if o.type == "MESH" and o.vertex_groups), key=lambda o: o.name):
            names = {group.index: group.name for group in obj.vertex_groups}
            for vertex in obj.data.vertices:
                weights = {names[g.group]: g.weight for g in vertex.groups if g.weight > 0}
                if not weights:
                    continue
                self.positions.append(to_gltf(obj.matrix_world @ vertex.co))
                self.weights.append(weights)
                self.meshes.append(obj.name)
        self.array = numpy.array([tuple(p) for p in self.positions])
        self.rig = rig

    def select(self, joints=None, meshes=None, exclude=None, minimum=.5):
        """Indices whose weight on ``joints`` sums to at least ``minimum``, optionally limited to mesh nodes."""
        chosen = []
        for index, weights in enumerate(self.weights):
            if meshes is not None and self.meshes[index] not in meshes:
                continue
            if exclude is not None and self.meshes[index] in exclude:
                continue
            if joints is not None and sum(weights.get(j, 0) for j in joints) < minimum:
                continue
            chosen.append(index)
        return chosen


# ---------------------------------------------------------------------------------------------- fitted surfaces

def basis(u, ref, hint):
    e1 = (ref - u * ref.dot(u)).normalized()
    e2 = u.cross(e1)
    if hint is not None and e2.dot(hint) < 0:
        e2 = -e2
    return e1, e2


def fit_radii(body, indices, origin, u, e1, e2, ts, thetas, slab, sector, full_circle):
    """Outermost radius around the axis in each (ring, sector) cell, gaps filled from neighbours, then smoothed."""
    points = body.array[indices] - numpy.array(tuple(origin))
    t = points @ numpy.array(tuple(u))
    radial = points - numpy.outer(t, numpy.array(tuple(u)))
    r = numpy.linalg.norm(radial, axis=1)
    theta = numpy.arctan2(radial @ numpy.array(tuple(e2)), radial @ numpy.array(tuple(e1)))
    grid = numpy.full((len(ts), len(thetas)), numpy.nan)
    for i, ti in enumerate(ts):
        near = numpy.abs(t - ti) <= slab
        if not near.any():
            continue
        for j, tj in enumerate(thetas):
            difference = numpy.abs((theta[near] - tj + math.pi) % (2 * math.pi) - math.pi)
            hit = difference <= sector
            if hit.any():
                grid[i, j] = r[near][hit].max()
    for i in range(len(ts)):
        row = grid[i]
        known = numpy.flatnonzero(~numpy.isnan(row))
        if len(known) == 0:
            continue
        if len(known) < len(row):
            positions = numpy.arange(len(row))
            if full_circle:
                xp = numpy.concatenate([known - len(row), known, known + len(row)])
                fp = numpy.concatenate([row[known]] * 3)
            else:
                xp, fp = known, row[known]
            grid[i] = numpy.interp(positions, xp, fp)
    filled = ~numpy.isnan(grid).any(axis=1)
    if not filled.any():
        raise ValueError("armor piece found no body vertices to fit")
    for i in range(len(ts)):
        if not filled[i]:
            nearest = min(numpy.flatnonzero(filled), key=lambda k: (abs(k - i), k))
            grid[i] = grid[nearest]
    # Dilate (keep the outermost of each 3 x 3 neighbourhood), then average, so the plate never dips into a seam.
    pad = "wrap" if full_circle else "edge"
    dilated = numpy.pad(grid, ((1, 1), (0, 0)), mode="edge")
    dilated = numpy.pad(dilated, ((0, 0), (1, 1)), mode=pad)
    grid = numpy.max([dilated[a:a + len(ts), b:b + len(thetas)] for a in range(3) for b in range(3)], axis=0)
    smoothed = numpy.pad(numpy.pad(grid, ((1, 1), (0, 0)), mode="edge"), ((0, 0), (1, 1)), mode=pad)
    return numpy.mean([smoothed[a:a + len(ts), b:b + len(thetas)] for a in range(3) for b in range(3)], axis=0)


def ring_grid(body, indices, a, b, ref, hint, t_range, rows, theta_range, columns, clearance, profile=None, slab=None):
    """Grid of points (rows along a->b, columns around it) fitted around the selected body vertices."""
    axis = b - a
    length = axis.length
    u = axis / length
    e1, e2 = basis(u, ref, hint)
    full = theta_range is None
    ts = [length * (t_range[0] + (t_range[1] - t_range[0]) * i / (rows - 1)) for i in range(rows)]
    if full:
        thetas = [2 * math.pi * j / columns for j in range(columns)]
    else:
        thetas = [theta_range[0] + (theta_range[1] - theta_range[0]) * j / (columns - 1) for j in range(columns)]
    sector = math.pi / columns if full else max(abs(theta_range[1] - theta_range[0]) / (2 * (columns - 1)), math.radians(8))
    slab = slab or max(abs(ts[-1] - ts[0]) / (2 * (rows - 1)), .012)
    radii = fit_radii(body, indices, a, u, e1, e2, ts, thetas, slab, sector, full)
    grid = []
    for i, t in enumerate(ts):
        row = []
        for j, theta in enumerate(thetas):
            r = radii[i, j] + clearance
            if profile:
                r = profile(i / (rows - 1), theta, r)
            row.append(a + u * t + (e1 * math.cos(theta) + e2 * math.sin(theta)) * r)
        grid.append(row)
    return {"grid": grid, "closed": full, "axis": (a, u), "thetas": thetas, "ts": ts}


class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.points = []

    def vert(self, point):
        self.points.append(tuple(point))
        return self.bm.verts.new(to_blender(point))

    def face(self, verts, material):
        face = self.bm.faces.new(verts)
        face.material_index = material
        return face

    def blob(self, centre, radius, material, scale=(1, 1, 1), subdivisions=1):
        """An icosphere at ``centre`` (glTF), scaled per glTF axis: beads, a skull clasp."""
        matrix = Matrix.Translation(to_blender(centre)) @ Matrix.Diagonal((scale[0], scale[2], scale[1], 1))
        verts = bmesh.ops.create_icosphere(self.bm, subdivisions=subdivisions, radius=radius, matrix=matrix)["verts"]
        self._claim(verts, material)

    def spike(self, base, tip, radius, tip_radius, material, segments=8):
        """A tapered cone from ``base`` to ``tip`` (glTF): spikes, antler tines."""
        b, t = Vector(to_blender(base)), Vector(to_blender(tip))
        matrix = Matrix.Translation((b + t) / 2) @ (t - b).to_track_quat("Z", "Y").to_matrix().to_4x4()
        verts = bmesh.ops.create_cone(self.bm, cap_ends=True, segments=segments, radius1=radius, radius2=tip_radius,
                                      depth=(t - b).length, matrix=matrix)["verts"]
        self._claim(verts, material)

    def _claim(self, verts, material):
        for vert in verts:
            self.points.append(tuple(to_gltf(vert.co)))
        for face in {face for vert in verts for face in vert.link_faces}:
            face.material_index = material

    def shell(self, surface, thickness, material, mask=None, apex=None):
        """A closed plate: the fitted outer surface, an inner surface ``thickness`` inside it and bands on open edges.
        ``material`` is a slot index, or a function of the grid cell (row, column) for striped or edged pieces (#379)."""
        slot = material if callable(material) else (lambda _i, _j, index=material: index)
        grid, closed = surface["grid"], surface["closed"]
        origin, u = surface["axis"]
        rows, columns = len(grid), len(grid[0])
        span = range(columns) if closed else range(columns - 1)

        def neighbour(j, step):
            return (j + step) % columns if closed else min(max(j + step, 0), columns - 1)

        normals = []
        for i in range(rows):
            row = []
            for j in range(columns):
                di = grid[min(i + 1, rows - 1)][j] - grid[max(i - 1, 0)][j]
                dj = grid[i][neighbour(j, 1)] - grid[i][neighbour(j, -1)]
                row.append(dj.cross(di).normalized())
            normals.append(row)
        middle = rows // 2
        outward = sum(normals[middle][j].dot(grid[middle][j] - origin - u * (grid[middle][j] - origin).dot(u)) for j in range(columns))
        sign = 1 if outward >= 0 else -1
        keep = {(i, j): mask is None or mask(i, j) for i in range(rows - 1) for j in span}
        used = {(i + di, (j + dj) % columns) for (i, j), kept in keep.items() if kept for di in (0, 1) for dj in (0, 1)}
        outer = {key: self.vert(grid[key[0]][key[1]]) for key in sorted(used)}
        inner = {key: self.vert(grid[key[0]][key[1]] - normals[key[0]][key[1]] * (sign * thickness)) for key in sorted(used)}
        for (i, j), kept in sorted(keep.items()):
            if not kept:
                continue
            k = (j + 1) % columns
            corners = [(i, j), (i, k), (i + 1, k), (i + 1, j)]
            material = slot(i, j)
            self.face([outer[c] for c in corners], material)
            self.face([inner[c] for c in reversed(corners)], material)
            for a, b, other in [((i, j), (i, k), (i - 1, j)), ((i, k), (i + 1, k), (i, j + 1)),
                                ((i + 1, k), (i + 1, j), (i + 1, j)), ((i + 1, j), (i, j), (i, j - 1))]:
                if other[1] < 0 or other[1] >= columns:
                    neighbour_kept = closed and keep.get((other[0], other[1] % columns), False)
                else:
                    neighbour_kept = keep.get(other, False)
                if apex is not None and a[0] == rows - 1 and b[0] == rows - 1:
                    continue
                if not neighbour_kept:
                    self.face([outer[a], outer[b], inner[b], inner[a]], material)
        if apex is not None:
            top = rows - 1
            tip_out = self.vert(apex)
            tip_in = self.vert(apex - (apex - origin).normalized() * thickness)
            for j in span:
                k = (j + 1) % columns
                if keep.get((top - 1, j), False):
                    self.face([outer[(top, j)], outer[(top, k)], tip_out], slot(top - 1, j))
                    self.face([inner[(top, k)], inner[(top, j)], tip_in], slot(top - 1, j))

    def box(self, centre, half, material):
        x, y, z = half
        corners = [centre + Vector((sx * x, sy * y, sz * z)) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
        verts = [self.vert(c) for c in corners]
        for face in [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]:
            self.face([verts[i] for i in face], material)


def material(name):
    colour, metallic, roughness = MATERIALS[name]
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*colour, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    return result


# ---------------------------------------------------------------------------------------------- the rig

class Rig:
    def __init__(self, worlds):
        self.worlds = worlds

    def at(self, joint):
        return self.worlds[joint].to_translation()

    def side(self, joint, side):
        return joint.replace("_s", "_" + side) if joint.endswith("_s") else joint


SIDES = (("l", 1.0), ("r", -1.0))
UP, FRONT = Vector((0, 1, 0)), Vector((0, 0, 1))


def head_centre(body):
    indices = body.select(["Head"], minimum=.9)
    points = body.array[indices]
    return Vector((float(points[:, 0].mean()), float(points[:, 1].max()), float(points[:, 2].mean()))), indices


def bascinet(body, centre, indices):
    """A bascinet (#301): a smooth skull fitted to the head's extents, rising to a point set back over the crown, with
    sides and back falling to the jaw and nape, and an arched open face. Analytic, so it reads as a forged shape
    instead of a scan of the head."""
    points = body.array[indices]
    top = centre.y
    half_x = float(points[:, 0].max() - points[:, 0].min()) / 2 + .024
    half_z = float(points[:, 2].max() - points[:, 2].min()) / 2 + .026
    mid_z = float(points[:, 2].max() + points[:, 2].min()) / 2
    brow = top - .075
    bottom, crown_top = top - .27, top + .045
    rows, columns = 30, 56
    thetas = [2 * math.pi * j / columns for j in range(columns)]
    grid, ts = [], []
    for i in range(rows):
        t = i / rows
        y = bottom + (crown_top - bottom) * t
        if y <= brow:
            # Below the brow the walls fall almost straight, flaring slightly outward toward the rim.
            r, back = 1 + .06 * (brow - y) / (brow - bottom), 0.0
        else:
            u = (y - brow) / (crown_top - brow)
            # A superellipse that narrows to a point; the point leans back over the crown.
            r, back = (1 - u ** 2.4) ** (1 / 2.4), -.035 * u * u
        row = [Vector((centre.x + half_x * r * math.sin(theta), y, mid_z + back + half_z * r * math.cos(theta))) for theta in thetas]
        grid.append(row)
        ts.append(t)
    surface = {"grid": grid, "closed": True, "axis": (Vector((centre.x, bottom, mid_z)), Vector((0, 1, 0))), "thetas": thetas, "ts": ts}

    def mask(i, j):
        # The face opening: an arch whose top is the brow and whose sides drop to the cheeks.
        theta = abs((surface["thetas"][j] + math.pi / columns + math.pi) % (2 * math.pi) - math.pi)
        y = (grid[i][j].y + grid[i + 1][j].y) / 2
        if theta > math.radians(58):
            return True
        return y > brow - .025 * (theta / math.radians(58)) ** 2
    apex = Vector((centre.x, crown_top + .03, mid_z - .05))
    return surface, mask, apex


def helmet(body, kit):
    """Bascinet (knight) or kettle hat (soldier): a dome fitted around the head, closed at the crown."""
    centre, indices = head_centre(body)
    top = centre.y
    base = Vector((centre.x, top - .28, centre.z))
    crown = Vector((centre.x, top + .02, centre.z))
    if kit == "knight":
        return bascinet(body, centre, indices)
    def profile(t, theta, r):
        return r
    dome = ring_grid(body, indices, base, crown, FRONT, Vector((1, 0, 0)), (.62, .97), 7, None, 24, .02, profile)
    # Kettle-hat brim: rings continuing the dome's lowest row outward and slightly down.
    grid = dome["grid"]
    first = grid[0]
    brim = []
    for spread, drop in [(.075, .028), (.05, .016), (.025, .006)]:
        brim.append([p + (p - Vector((centre.x, p.y, centre.z))).normalized() * spread - Vector((0, drop, 0)) for p in first])
    dome["grid"] = brim + grid
    dome["ts"] = [0] * 3 + dome["ts"]
    return dome, None, crown + Vector((0, .012, 0))

def plate_surfaces(body, rig, kit):
    """Every rigid piece of the kit: (node name, joint, material, surface, mask, apex, thickness)."""
    if kit in CLASS_KITS:
        return class_plates(body, rig, kit)
    if kit == "redbrand":
        return redbrand_plates(body, rig)
    if kit in RESIDENT_KITS:
        return resident_plates(body, kit)
    pieces = []
    surface, mask, apex = helmet(body, kit)
    pieces.append((f"{kit}.{'bascinet' if kit == 'knight' else 'kettle-hat'}", "Head", "iron" if kit == "soldier" else "steel",
                   surface, mask, apex, .004))
    for side, s in SIDES:
        out = Vector((s, 0, 0))
        knee, ankle, hip = rig.at(f"calf_{side}"), rig.at(f"foot_{side}"), rig.at(f"thigh_{side}")
        calf = body.select([f"calf_{side}"], minimum=.5)
        if kit == "soldier":
            # Front greaves over the boots, open behind the calf.
            # #309: fitted only to vertices fully on the calf, and starting below the knee, so the bending knee and the
            # boot cuff do not push the plate away from the shin in the walk.
            shin = body.select([f"calf_{side}"], minimum=.95)
            greave = ring_grid(body, shin, knee, ankle, FRONT, out, (.2, .82), 9, (-math.radians(100), math.radians(100)), 13, .008)
        else:
            greave = ring_grid(body, calf, knee, ankle, FRONT, out, (.04, .86), 10, None, 20, .013)
        pieces.append((f"{kit}.greave_{side}", f"calf_{side}", "iron" if kit == "soldier" else "steel", greave, None, None, .003))
        if kit != "knight":
            continue
        # Cuisse with the knee cop at its foot: front and outer thigh, ending over the knee.
        thigh = body.select([f"thigh_{side}", f"calf_{side}"], meshes=[LEGS], minimum=.5)
        def cuisse_profile(t, theta, r):
            return r + .012 * max(0, (t - .82) / .18) * math.cos(theta)
        cuisse = ring_grid(body, thigh, hip, knee + (knee - hip).normalized() * .07, FRONT, out, (.18, 1.0), 11,
                           (-math.radians(70), math.radians(125)), 12, .016, cuisse_profile)
        pieces.append((f"knight.cuisse_{side}", f"thigh_{side}", "steel", cuisse, None, None, .003))
        # Sabaton over the top of the foot.
        foot = body.select([f"foot_{side}", f"ball_{side}"], minimum=.5)
        toe = rig.at(f"ball_{side}") + Vector((0, 0, .1))
        sabaton = ring_grid(body, foot, ankle, toe, UP, out, (.0, .98), 8, (-math.radians(95), math.radians(95)), 11, .01)
        pieces.append((f"knight.sabaton_{side}", f"foot_{side}", "steel", sabaton, None, None, .003))
        # Arm pieces (the rest pose is a T-pose: the arm runs along +-X, the back of the hand faces up).
        shoulder, elbow, wrist = rig.at(f"upperarm_{side}"), rig.at(f"lowerarm_{side}"), rig.at(f"hand_{side}")
        arm = (elbow - shoulder).normalized()
        upper = body.select([f"upperarm_{side}", f"clavicle_{side}"], minimum=.5)
        def lames(t, theta, r):
            return r + .004 * math.floor(t * 3.999) + .006 * (1 - t)
        # #301: the shoulder cop rides the clavicle, so it stays on the shoulder when the arm hangs or rises; the lames
        # below it ride the upper arm and slide under the cop.
        cop_surface = ring_grid(body, upper, shoulder - arm * .06, shoulder + arm * .05, UP, FRONT, (0, 1), 9,
                                (-math.radians(85), math.radians(85)), 15, .022, lambda t, theta, r: r + .01 * math.sin(math.pi * t))
        pieces.append((f"knight.spaulder_{side}", f"clavicle_{side}", "steel", cop_surface, None, None, .003))
        pauldron = ring_grid(body, upper, shoulder + arm * .03, shoulder + arm * .15, UP, FRONT, (0, 1), 9,
                             (-math.radians(80), math.radians(80)), 15, .012, lames)
        pieces.append((f"knight.pauldron_{side}", f"upperarm_{side}", "steel", pauldron, None, None, .003))
        around = body.select([f"upperarm_{side}", f"lowerarm_{side}"], minimum=.5)
        def cop(t, theta, r):
            return r + .014 * math.sin(math.pi * t) * max(0, math.cos(theta))
        couter = ring_grid(body, around, elbow - arm * .065, elbow + arm * .065, Vector((0, 0, -1)), UP, (0, 1), 7,
                           (-math.radians(95), math.radians(95)), 11, .014, cop)
        pieces.append((f"knight.couter_{side}", f"lowerarm_{side}", "steel", couter, None, None, .003))
        forearm = body.select([f"lowerarm_{side}", f"hand_{side}"], minimum=.5)
        def flare(t, theta, r):
            return r + .022 * (1 - t) ** 2
        cuff = ring_grid(body, forearm, wrist - arm * .1, wrist + arm * .015, UP, FRONT, (0, 1), 6, None, 16, .012, flare)
        pieces.append((f"knight.gauntlet_{side}", f"hand_{side}", "steel", cuff, None, None, .003))
        # #301: a mitten gauntlet over the whole hand and fingers. The bone maps leave the fingers at their rest pose,
        # so a rigid shell on the hand fits in every clip.
        fingers = [name for name in rig.worlds if name.endswith(f"_{side}") and name.split("_")[0] in ("index", "middle", "ring", "pinky", "thumb")]
        hand = body.select([f"hand_{side}", *fingers], minimum=.5)
        reach = max(float((body.array[i] - numpy.array(tuple(wrist))) @ numpy.array(tuple(arm))) for i in hand)
        def mitten(t, theta, r):
            return r + .004 * math.sin(math.pi * min(1.0, t * 1.2))
        glove = ring_grid(body, hand, wrist - arm * .01, wrist + arm * (reach + .01), UP, FRONT, (0, 1), 12, None, 20, .009, mitten)
        pieces.append((f"knight.gauntlet_{side}", f"hand_{side}", "steel", glove, None, wrist + arm * (reach + .018), .003))
    if kit == "knight":
        torso = body.select(["spine_01", "spine_02", "spine_03", "clavicle_l", "clavicle_r", "pelvis"], meshes=[SHIRT], minimum=.5)
        centre = Vector((0, 0, float(body.array[torso][:, 2].mean())))
        def breast(t, theta, r):
            # A flared lower edge and a central keel down the front (#301).
            return r + .012 * max(0, .25 - t) / .25 + .014 * max(0.0, math.cos(theta)) ** 10 * (1 - .5 * t)
        plate = ring_grid(body, torso, centre + Vector((0, 1.13, 0)), centre + Vector((0, 1.45, 0)), FRONT, Vector((1, 0, 0)),
                          (0, 1), 16, None, 40, .022, breast)
        def armholes(i, j):
            p = plate["grid"][i][j]
            return not (abs(p.x) > .115 and p.y > 1.33)
        pieces.append(("knight.breastplate", "spine_03", "steel", plate, armholes, None, .004))
    if kit == "soldier":
        waist = body.select(["pelvis", "spine_01", "thigh_l", "thigh_r"], meshes=[SHIRT, LEGS], minimum=.5)
        centre = Vector((0, 0, float(body.array[waist][:, 2].mean())))
        belt = ring_grid(body, waist, centre + Vector((0, .985, 0)), centre + Vector((0, 1.035, 0)), FRONT, Vector((1, 0, 0)),
                         (0, 1), 3, None, 28, .026, slab=.03)
        pieces.append(("soldier.belt", "pelvis", "leather", belt, None, None, .005))
    return pieces


# ---------------------------------------------------------------------------------------------- cloth

def blend_weights(body, tree, point, indices_allowed=None, k=10):
    found = tree.find_n(point, k)
    total, mix = 0.0, {}
    for _co, index, distance in found:
        weight = 1 / (distance + .01) ** 2
        total += weight
        for joint, value in body.weights[index].items():
            mix[joint] = mix.get(joint, 0) + value * weight
    ranked = sorted(mix.items(), key=lambda item: (-item[1], item[0]))[:4]
    norm = sum(value for _joint, value in ranked)
    return {joint: value / norm for joint, value in ranked}


TABARD_RIGID_FROM = (1.0, 1.2)


def follow(weights, joint, amount):
    amount = min(1.0, max(0.0, amount))
    mixed = {name: value * (1 - amount) for name, value in weights.items()}
    mixed[joint] = mixed.get(joint, 0) + amount
    ranked = sorted(((name, value) for name, value in mixed.items() if value > 0), key=lambda item: (-item[1], item[0]))[:4]
    norm = sum(value for _name, value in ranked)
    return {name: value / norm for name, value in ranked}


def cloth_tree(body, indices):
    tree = kdtree.KDTree(len(indices))
    for slot, index in enumerate(indices):
        tree.insert(body.positions[index], index)
    tree.balance()
    return tree


def cloth_surfaces(body, rig, kit):
    """Skinned garments: list of (node name, material, builder vertices -> weights, kind)."""
    garments = []
    if kit in CLASS_KITS:
        return class_cloth(body, rig, kit)
    if kit == "redbrand":
        return redbrand_cloth(body, rig)
    if kit in RESIDENT_KITS:
        return resident_cloth(body, kit)
    if kit == "soldier":
        skirt = tunic_skirt(body, .70, .02, 8, lambda theta: .003 * math.cos(theta * 14))
        garments.append(("soldier.gambeson", "gambeson", skirt, None))
        torso = body.select(["spine_01", "spine_02", "spine_03", "clavicle_l", "clavicle_r"], meshes=[SHIRT], minimum=.5)
        middle = Vector((0, 1.25, float(body.array[torso][:, 2].mean())))
        shoulder, hip = Vector((.13, 1.5, 0)), Vector((-.15, .99, 0))
        along = (shoulder - hip).normalized()
        normal = Vector((along.y, -along.x, 0))
        sash = ring_grid(body, torso + body.select(["pelvis"], meshes=[SHIRT], minimum=.5), middle - normal * .035,
                         middle + normal * .035, FRONT, along, (0, 1), 3, None, 40, .026, slab=.03)
        garments.append(("soldier.sash", "faction", sash, None))
    else:
        # The tabard also clears the breastplate's own surface (keel and rim), not only the body under it (#309).
        plates = plate_surfaces(body, rig, "knight")
        plate = next(surface for name, _joint, _slot, surface, *_rest in plates if name == "knight.breastplate")
        surface = tabard_surface(body, rig, [p for row in plate["grid"] for p in row])
        mask = tabard_mask(surface)
        # The cloth falls over the body and the breastplate (#314). The cuisses sit inside the hanging skirt's clearance
        # already, and as colliders they snag the gathered cloth at the hips.
        colliders = []
        for name, _joint, _slot, plate_surface, plate_mask, apex, thickness in plates:
            if name == "knight.breastplate":
                builder = Builder()
                builder.shell(plate_surface, thickness, 0, plate_mask, apex)
                collider_mesh = bpy.data.meshes.new(f"{name}-collider")
                builder.bm.to_mesh(collider_mesh)
                builder.bm.free()
                colliders.append((name, collider_mesh))
        bodies = [o for o in bpy.context.scene.objects if o.type == "MESH" and o.name in (SHIRT, LEGS)]
        settle_tabard(surface, mask, bodies, colliders)
        garments.append(("knight.tabard", "faction", surface, mask))
    return garments


def tunic_skirt(body, bottom, flare, rows, ripple=None):
    """A skirt fitted around the hips from the waist (1.0 m) down to ``bottom``, widening by ``flare`` at the hem."""
    hips = body.select(["pelvis", "spine_01", "thigh_l", "thigh_r"], meshes=[SHIRT, LEGS], minimum=.5)
    centre = Vector((0, 0, float(body.array[hips][:, 2].mean())))
    def profile(t, theta, r):
        return r + flare * t + (ripple(theta) if ripple else 0)
    return ring_grid(body, hips, centre + Vector((0, 1.0, 0)), centre + Vector((0, bottom, 0)), FRONT, Vector((1, 0, 0)),
                     (0, 1), rows, None, 32, .016, profile, slab=.03)


# Resident skirts (#376): (bottom height, hem flare, rows). The smock ends above the knee, the habit at the ankle.
RESIDENT_SKIRTS = {"farmer.smock": (.6, .05, 10), "monk.habit": (.16, .15, 20)}
# How far each long skirt blends toward the pelvis at its hem: (amount, from height, hem height).
SETTLE = {"farmer.smock": (.3, 1.0, .6), "monk.habit": (.6, 1.0, .16), "innkeeper.apron": (.3, 1.03, .66)}
# How far each side of a skirt follows the thigh on that side at its hem: (amount, from height, hem height, half-width of
# the middle strip that blends between the thighs).
STRIDE = {"farmer.smock": (1.0, 1.0, .6, .03), "monk.habit": (.6, 1.0, .16, .05), "innkeeper.apron": (.8, 1.03, .66, .05)}
# The innkeeper's apron: bib from the chest to the waist, a wider skirt from the waist to mid-thigh; below the waist
# the thighs move it (STRIDE).
APRON = {"top": 1.37, "waist": 1.03, "hem": .66, "bib": .1, "skirt": .17, "clearance": .012, "rows": 20, "columns": 15}
# The tanner (#378, female figure): an ankle-length work skirt (Marshal style: no short skirts), and over it a long
# leather apron from the chest to mid-shin, wide enough to wrap the skirt's front.
TANNER_SKIRT = (.14, .18, 20)
TANNER_APRON = {"top": 1.33, "waist": 1.0, "hem": .3, "bib": .095, "skirt": .2, "clearance": .012, "rows": 26, "columns": 17,
                 "smooth": 3}
SETTLE["tanner.skirt"], STRIDE["tanner.skirt"] = SETTLE["monk.habit"], STRIDE["monk.habit"]
SETTLE["tanner.apron"], STRIDE["tanner.apron"] = (.4, 1.0, .3), (.6, 1.0, .3, .05)


def resident_plates(body, kit):
    """The resident kits' one rigid piece: a rope (farmer, monk) or leather (innkeeper, tanner) belt at the waist."""
    waist = body.select(["pelvis", "spine_01", "thigh_l", "thigh_r"], meshes=[SHIRT, LEGS], minimum=.5)
    centre = Vector((0, 0, float(body.array[waist][:, 2].mean())))
    if kit == "tanner":
        # Over the apron and the skirt's waistband.
        belt = ring_grid(body, waist, centre + Vector((0, .975, 0)), centre + Vector((0, 1.02, 0)), FRONT, Vector((1, 0, 0)),
                         (0, 1), 3, None, 28, .036, slab=.03)
        return [("tanner.belt", "pelvis", "leather", belt, None, None, .006)]
    leather = kit == "innkeeper"
    low, high = (.985, 1.03) if leather else (.99, 1.015)
    belt = ring_grid(body, waist, centre + Vector((0, low, 0)), centre + Vector((0, high, 0)), FRONT, Vector((1, 0, 0)),
                     (0, 1), 3, None, 28, .03 if kit != "monk" else .032, slab=.03)
    return [(f"{kit}.belt", "pelvis", "leather" if leather else "rope", belt, None, None, .006 if leather else .008)]


def apron_surface(body, spec=APRON, under=()):
    """A front panel that follows the chest and belly, then hangs straight from the waist with soft folds. It also
    clears the ``under`` points (the tanner's skirt, #378)."""
    allowed = [i for i in body.select(None, meshes=[SHIRT, LEGS], minimum=0)
               if max(body.weights[i], key=body.weights[i].get) not in ARM_JOINTS]
    points = body.array[allowed]
    if len(under):
        points = numpy.vstack([points, numpy.array([tuple(p) for p in under])])
    APRON = spec
    top, waist, hem, rows, columns = APRON["top"], APRON["waist"], APRON["hem"], APRON["rows"], APRON["columns"]
    ys = [hem + (top - hem) * i / (rows - 1) for i in range(rows)]
    step = ys[1] - ys[0]
    grid, previous = [], None
    for y in reversed(ys):
        below = min(1.0, max(0.0, (waist + .03 - y) / .09))
        half = APRON["bib"] + (APRON["skirt"] - APRON["bib"]) * below
        hang = min(1.0, max(0.0, (waist - y) / .35))
        row = []
        for j in range(columns):
            x = -half + 2 * half * j / (columns - 1)
            near = (numpy.abs(points[:, 0] - x) < .035) & (numpy.abs(points[:, 1] - y) < .03)
            z = float(points[near][:, 2].max()) + APRON["clearance"] + .02 * hang if near.any() else None
            if previous is not None:
                # Below the waist the cloth hangs: it never falls back toward the legs faster than a slight slope.
                z = previous[j][2] - .15 * step if z is None else max(z, previous[j][2] - (.15 + .85 * (1 - hang)) * step)
            if z is None:
                raise ValueError("the apron found no body at its top edge")
            fold = .008 * hang * math.sin(2 * math.pi * x / .09)
            row.append(Vector((x, y, z + fold)))
        grid.append(row)
        previous = row
    grid.reverse()
    for _ in range(APRON.get("smooth", 0)):
        # Stiff leather (#378): even out the depth across each row, so the panel shows broad folds, not the body's bumps.
        for row in grid:
            depths = [p.z for p in row]
            for j in range(1, len(row) - 1):
                row[j].z = max(depths[j], (depths[j - 1] + 2 * depths[j] + depths[j + 1]) / 4)
    zc = float(points[:, 2].mean())
    return {"grid": grid, "closed": False, "axis": (Vector((0, 1.0, zc)), Vector((1, 0, 0))),
            "thetas": [p.x for p in grid[0]], "ts": ys}


def resident_cloth(body, kit):
    if kit == "innkeeper":
        return [("innkeeper.apron", "linen", apron_surface(body), None)]
    if kit == "tanner":
        skirt = tunic_skirt(body, *TANNER_SKIRT)
        apron = apron_surface(body, TANNER_APRON, [p for row in skirt["grid"] for p in row])
        return [("tanner.skirt", "skirt.wool", skirt, None), ("tanner.apron", "leather.tan", apron, None)]
    name = f"{kit}.{'smock' if kit == 'farmer' else 'habit'}"
    bottom, flare, rows = RESIDENT_SKIRTS[name]
    return [(name, TUNICS[name][0], tunic_skirt(body, bottom, flare, rows), None)]


TABARD_HALF_WIDTH = .155
ARM_JOINTS = {f"{joint}_{side}" for joint in ("clavicle", "upperarm", "lowerarm", "hand") for side in "lr"}


def tabard_surface(body, rig, obstacles=(), clearance=(.066, .07, .042)):
    """Front and back panels hanging from the shoulders, over the breastplate, joined across the shoulders.
    ``clearance``: front and back above the waist (over the plate), and below it."""
    torso = body.select(None, meshes=[SHIRT, LEGS], minimum=0)
    torso = [i for i in torso if max(body.weights[i], key=body.weights[i].get) not in
             {"upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r"}]
    points = body.array[torso]
    zc = float(points[:, 2].mean())
    columns = 23
    xs = [-TABARD_HALF_WIDTH + 2 * TABARD_HALF_WIDTH * j / (columns - 1) for j in range(columns)]
    # The panels rise above the breastplate's top edge (1.45 m), so its rim never shows at the collar (#309).
    ys = [.6 + (1.475 - .6) * i / 23 for i in range(24)]

    def extreme(x, y, front):
        near = (numpy.abs(points[:, 0] - x) < .04) & (numpy.abs(points[:, 1] - y) < .035)
        if not near.any():
            return None
        values = points[near][:, 2]
        return float(values.max() if front else values.min())

    def panel(front):
        rows = []
        previous = None
        for y in reversed(ys):
            # Over the breastplate, then over the cuisses below it.
            gap = (clearance[0] if front else clearance[1]) if y >= 1.0 else clearance[2]
            row = []
            for j, x in enumerate(xs):
                z = extreme(x, y, front)
                z = (zc + (.12 if front else -.12)) if z is None else z + (gap if front else -gap)
                near = [p.z for p in obstacles if abs(p.x - x) < .03 and abs(p.y - y) < .03]
                if near:
                    z = max(z, max(near) + .018) if front else min(z, min(near) - .018)
                if previous is not None:
                    # Hang: below the chest the cloth falls almost straight instead of following the waist.
                    z = max(z, previous[j] - .2 * (ys[1] - ys[0])) if front else min(z, previous[j] + .2 * (ys[1] - ys[0]))
                row.append(z)
            rows.append(row)
            previous = row
        return list(reversed(rows))

    front, back = panel(True), panel(False)
    shoulder = []
    for x in xs:
        near = (numpy.abs(points[:, 0] - x) < .03) & (numpy.abs(points[:, 2] - zc) < .07)
        shoulder.append(float(points[near][:, 1].max()) + .03 if near.any() else 1.5)
    def drape(x, y, z, side):
        # #301: below the waist the cloth widens and falls in soft vertical folds that deepen toward the hem.
        hang = min(1.0, max(0.0, (1.12 - y) / .5))
        # Deeper folds with a little irregularity, and a hem that rises and falls with them, so it reads as cloth (#309).
        fold = math.sin(2 * math.pi * x / .105) + .35 * math.sin(2 * math.pi * x / .047 + 1.3)
        return Vector((x * (1 + .22 * hang), y + .012 * hang * hang * fold, z + side * .024 * hang * fold))
    grid = [[drape(x, ys[i], front[i][j], 1) for j, x in enumerate(xs)] for i in range(len(ys))]
    grid.append([Vector((x, shoulder[j], zc)) for j, x in enumerate(xs)])
    grid += [[drape(x, ys[i], back[i][j], -1) for j, x in enumerate(xs)] for i in reversed(range(len(ys)))]
    return {"grid": grid, "closed": False, "axis": (Vector((0, 1.0, zc)), Vector((1, 0, 0))), "thetas": xs, "ts": list(range(len(grid))),
            "frontRows": len(ys)}


# #314: the tabard's drape is a Blender cloth simulation over the knight's body and breastplate, baked into its rest
# shape. The panels stay pinned where they ride the breastplate (above TABARD_PIN_FROM). Just under the breastplate's
# rim the cloth is gathered to TABARD_GATHER of its width (TABARD_BELT), so the wider skirt below it buckles into
# real folds as it settles instead of hanging as a flat panel.
TABARD_PIN_FROM = TABARD_RIGID_FROM[0]
TABARD_BELT = (.9, .95)
TABARD_GATHER = .78
TABARD_CLOTH = {"frames": 72, "quality": 8, "mass": .2, "tension": 12.0, "compression": 12.0, "shear": 5.0, "bending": .6,
                "air": 1.0, "collision": .008, "round": 1e-5}


def collider(name, mesh):
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    modifier = obj.modifiers.new("collision", "COLLISION")
    obj.collision.thickness_outer = TABARD_CLOTH["collision"]
    obj.collision.cloth_friction = 5.0
    return obj, modifier


def settle_tabard(surface, mask, body_objects, plates):
    """Simulate the tabard grid as cloth over the body and plates and write the settled positions back into it."""
    grid = surface["grid"]
    rows, columns = len(grid), len(grid[0])
    bm = bmesh.new()
    verts = [[bm.verts.new(to_blender(grid[i][j])) for j in range(columns)] for i in range(rows)]
    for i in range(rows - 1):
        for j in range(columns - 1):
            if mask(i, j):
                bm.faces.new([verts[i][j], verts[i][j + 1], verts[i + 1][j + 1], verts[i + 1][j]])
    mesh = bpy.data.meshes.new("tabard-sim")
    bm.to_mesh(mesh)
    bm.free()
    cloth = bpy.data.objects.new("tabard-sim", mesh)
    bpy.context.scene.collection.objects.link(cloth)
    pin = cloth.vertex_groups.new(name="pin")
    cloth.shape_key_add(name="rest")
    gathered = cloth.shape_key_add(name="gathered", from_mix=False)
    gathered.value = 1.0
    for index in range(rows * columns):
        point = grid[index // columns][index % columns]
        if point.y >= TABARD_PIN_FROM or TABARD_BELT[0] <= point.y <= TABARD_BELT[1]:
            pin.add([index], 1.0, "REPLACE")
        if point.y < TABARD_PIN_FROM:
            # Full gather at the belt, easing back to the cut width over the plate above it.
            amount = 1.0 if point.y <= TABARD_BELT[1] else 1 - (point.y - TABARD_BELT[1]) / (TABARD_PIN_FROM - TABARD_BELT[1])
            scale = 1 - (1 - TABARD_GATHER) * amount if point.y >= TABARD_BELT[0] else 1.0
            gathered.data[index].co.x = point.x * scale
    temporary = [cloth]
    for obj in body_objects:
        copy = bpy.data.objects.new(f"{obj.name}-collider", obj.data)
        copy.matrix_world = obj.matrix_world.copy()
        bpy.context.scene.collection.objects.link(copy)
        copy.modifiers.new("collision", "COLLISION")
        copy.collision.thickness_outer = TABARD_CLOTH["collision"]
        temporary.append(copy)
    for name, mesh_data in plates:
        temporary.append(collider(name, mesh_data)[0])
    modifier = cloth.modifiers.new("cloth", "CLOTH")
    settings = modifier.settings
    settings.quality = TABARD_CLOTH["quality"]
    settings.mass = TABARD_CLOTH["mass"]
    settings.tension_stiffness = TABARD_CLOTH["tension"]
    settings.compression_stiffness = TABARD_CLOTH["compression"]
    settings.shear_stiffness = TABARD_CLOTH["shear"]
    settings.bending_stiffness = TABARD_CLOTH["bending"]
    settings.air_damping = TABARD_CLOTH["air"]
    settings.vertex_group_mass = "pin"
    # The springs keep the cut (ungathered) lengths, so the gathered cloth buckles instead of shrinking.
    settings.rest_shape_key = cloth.data.shape_keys.key_blocks["rest"]
    modifier.collision_settings.distance_min = TABARD_CLOTH["collision"]
    modifier.collision_settings.use_self_collision = False
    cache = modifier.point_cache
    cache.frame_start, cache.frame_end = 1, TABARD_CLOTH["frames"]
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, TABARD_CLOTH["frames"]
    for frame in range(1, TABARD_CLOTH["frames"] + 1):
        scene.frame_set(frame)
    evaluated = cloth.evaluated_get(bpy.context.evaluated_depsgraph_get())
    step = TABARD_CLOTH["round"]
    settled = [to_gltf(evaluated.matrix_world @ vertex.co) for vertex in evaluated.data.vertices]
    for index, point in enumerate(settled):
        grid[index // columns][index % columns] = Vector(tuple(round(c / step) * step for c in point))
    scene.frame_set(1)
    for obj in temporary:
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.meshes.remove(mesh)
    return surface


def tabard_mask(surface):
    """The neck opening: the middle columns stop below the collar, deeper in front than behind."""
    grid, front_rows = surface["grid"], surface["frontRows"]
    def mask(i, j):
        x = (grid[i][j].x + grid[i][j + 1].x) / 2
        y = min(grid[i][j].y, grid[i + 1][j].y)
        if abs(x) > .075:
            return True
        # Only the strips that bridge over the shoulders are opened for the neck (#309): the panels themselves stay
        # whole, so no slot shows across the chest.
        return not (front_rows - 1 <= i <= front_rows)
    return mask


def skinned_object(name, mesh, rig_object, weights):
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = rig_object
    obj.matrix_parent_inverse = rig_object.matrix_world.inverted()
    joints = sorted({joint for vertex in weights for joint in vertex})
    groups = {joint: obj.vertex_groups.new(name=joint) for joint in joints}
    for index, vertex in enumerate(weights):
        for joint, value in vertex.items():
            groups[joint].add([index], value, "REPLACE")
    modifier = obj.modifiers.new("Armature", "ARMATURE")
    modifier.object = rig_object
    return obj


def offset_shirt(source, distance, name):
    """The Peasant shirt's surface and skin weights, pushed ``distance`` outward along its normals."""
    mesh = source.data.copy()
    mesh.name = name
    for vertex in mesh.vertices:
        vertex.co = vertex.co + vertex.normal * distance
    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])
    mesh.materials.clear()
    return mesh


# ---------------------------------------------------------------------------------------------- class outfits (#379)

def linear(code):
    """An sRGB hex colour as linear factors, rounded to 4 decimals."""
    value = [int(code[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(round(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4, 4) for c in value)


# The class colour slot ``class`` and its default per kit (mmorpg's class looks): the tabard, sash, mantle or leaves that
# keep the class readable when armour drops replace other pieces.
CLASS_TRIM = {"class.warden": "#3f5f57", "class.ranger": "#2f5a2c", "class.arcanist": "#6f6a96", "class.necromancer": "#4b3e5e",
              "class.rogue": "#6b2a26", "class.cleric": "#c9a23e", "class.druid": "#53613a"}
MATERIALS.update({name: (linear(code), metallic, roughness) for name, (code, metallic, roughness) in {
    "class": ("#808080", 0.0, .8),
    "jerkin.green": ("#4b5634", 0.0, .75), "jerkin.charcoal": ("#2e2b29", 0.0, .78),
    "trousers.brown": ("#3d3324", 0.0, .9), "trousers.charcoal": ("#2a2826", 0.0, .9),
    "wool.olive": ("#4d4a3b", 0.0, .95), "wool.charcoal": ("#2b2826", 0.0, .95), "wool.umber": ("#4a3d32", 0.0, .95),
    "wrap.light": ("#57504a", 0.0, .95), "wrap.dark": ("#3a3430", 0.0, .95), "mask": ("#1b1a19", 0.0, .9),
    "robe.indigo": ("#3b3d63", 0.0, .9), "sleeve.indigo": ("#4a4d75", 0.0, .88),
    "robe.black": ("#1f1a28", 0.0, .95), "sleeve.black": ("#2a2333", 0.0, .95),
    "robe.ivory": ("#d6cdb8", 0.0, .85), "sleeve.ivory": ("#e0d8c4", 0.0, .85), "tabard.white": ("#f4f1e8", 0.0, .8),
    "robe.moss": ("#4b4f3a", 0.0, .92), "sleeve.moss": ("#4f4a37", 0.0, .92), "bark": ("#4a3a26", 0.0, .95),
    "antler": ("#b9a888", 0.0, .7), "bone": ("#ddd5bd", 0.0, .6), "gold": ("#d9b44a", 1.0, .35), "sash.gold": ("#b08a3e", .3, .5),
}.items()})
TABARDS = {"knight.tabard", "class.warden.tabard", "class.cleric.tabard"}
HANGING_ARM = {f"{joint}_{side}" for joint in ("upperarm", "lowerarm", "hand") for side in "lr"}
# Long robes (owner, 2026-10-25: no short skirts on anyone): (skirt colour, top and sleeve colour).
CLASS_ROBES = {"class.arcanist": ("robe.indigo", "sleeve.indigo"), "class.necromancer": ("robe.black", "sleeve.black"),
               "class.cleric": ("robe.ivory", "sleeve.ivory"), "class.druid": ("robe.moss", "robe.moss")}
# Hip-length jerkins over straight work trousers (owner, 2026-10-25: no slim tucked trousers).
CLASS_JERKINS = {"class.ranger": ("jerkin.green", "trousers.brown"), "class.rogue": ("jerkin.charcoal", "trousers.charcoal")}
for _kit, (_skirt, _top) in CLASS_ROBES.items():
    _name = f"{_kit}.robe"
    TUNICS[_name], HIDES[_name] = (_top, .012), [SHIRT]
    SETTLE[_name], STRIDE[_name] = SETTLE["monk.habit"], STRIDE["monk.habit"]
for _kit, (_jerkin, _trousers) in CLASS_JERKINS.items():
    TUNICS[f"{_kit}.jerkin"], HIDES[f"{_kit}.jerkin"] = (_jerkin, .012), [SHIRT]
    SETTLE[f"{_kit}.jerkin"], STRIDE[f"{_kit}.jerkin"] = (.3, 1.0, .86), (1.0, 1.0, .86, .03)
    HIDES[f"{_kit}.trousers"] = [LEGS]
# Below the waist the Ranger's cloak settles toward the pelvis, so a striding thigh does not lift its back.
SETTLE["class.ranger.cloak"] = (.6, 1.05, .82)
# Hoods: clearance around the head, crown height, backward peak, and how far the drape flares onto the shoulders.
HOODS = {"class.ranger": {"clearance": .03, "crown": .05, "peak": .035, "drape": .3, "slot": "wool.olive"},
         "class.rogue": {"clearance": .022, "crown": .04, "peak": .02, "drape": .22, "slot": "wool.charcoal"},
         "class.necromancer": {"clearance": .045, "crown": .085, "peak": .075, "drape": .4, "slot": "robe.black"}}


def scene_mesh(name):
    return next(o for o in bpy.context.scene.objects if o.type == "MESH" and o.name == name)


def triangle_wave(x):
    """0 at whole numbers, 1 halfway between: the jagged edge of a tattered hem."""
    return abs((x % 2) - 1)


class Derived:
    """A garment cut from a base mesh (#379): the faces whose vertices all pass ``keep`` (a glTF point test), pushed
    ``offset`` out along the normals. It keeps the base's skin weights, so it moves exactly like the body under it."""

    def __init__(self, source, keep, offset, slots):
        self.source, self.slots = source, list(slots)
        self.inverse = source.matrix_world.inverted()
        self.matrix = source.matrix_world.copy()
        self.bm = bmesh.new()
        self.bm.from_mesh(source.data)
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-5)
        bmesh.ops.delete(self.bm, geom=[f for f in self.bm.faces if not all(keep(self.at(v)) for v in f.verts)], context="FACES")
        bmesh.ops.delete(self.bm, geom=[v for v in self.bm.verts if not v.link_faces], context="VERTS")
        if not self.bm.verts:
            raise ValueError(f"no part of {source.name} passes the garment cut")
        for face in self.bm.faces:
            face.material_index = 0
        self.bm.normal_update()
        normals = [v.normal.copy() for v in self.bm.verts]
        for vert, normal in zip(self.bm.verts, normals):
            vert.co += normal * offset
        self.deform = self.bm.verts.layers.deform.active

    def at(self, vert):
        return to_gltf(self.matrix @ vert.co)

    def put(self, vert, point):
        vert.co = self.inverse @ Vector(to_blender(point))

    def move(self, change):
        for vert in self.bm.verts:
            self.put(vert, change(self.at(vert)))

    def hang(self, pick, rows):
        """Extrude the open edges whose vertices pass ``pick``, once per row; each row maps the original edge vertex
        (glTF) to the new row's position. New vertices copy the weights of the edge vertex they grow from."""
        edges = [e for e in self.bm.edges if e.is_boundary and all(pick(self.at(v)) for v in e.verts)]
        origin = {v: self.at(v) for e in edges for v in e.verts}
        root = {v: v for v in origin}
        last = set(origin)
        for row in rows:
            result = bmesh.ops.extrude_edge_only(self.bm, edges=edges)
            fresh = [g for g in result["geom"] if isinstance(g, bmesh.types.BMVert)]
            for vert in fresh:
                source = next(o for e in vert.link_edges for o in e.verts if o in last)
                root[vert] = root[source]
                self.put(vert, row(origin[root[vert]]))
                weights = root[vert][self.deform]
                for group in list(vert[self.deform].keys()):
                    del vert[self.deform][group]
                for group, value in weights.items():
                    vert[self.deform][group] = value
            fresh_set = set(fresh)
            edges = [g for g in result["geom"] if isinstance(g, bmesh.types.BMEdge) and all(v in fresh_set for v in g.verts)]
            last = fresh_set
        self.bm.normal_update()

    def finish(self, name, materials, rig_object):
        bmesh.ops.triangulate(self.bm, faces=self.bm.faces, quad_method="FIXED", ngon_method="EAR_CLIP")
        self.triangles = len(self.bm.faces)
        self.points = [tuple(self.at(v)) for v in self.bm.verts]
        mesh = bpy.data.meshes.new(f"{name}-geometry")
        self.bm.to_mesh(mesh)
        self.bm.free()
        while mesh.uv_layers:
            mesh.uv_layers.remove(mesh.uv_layers[0])
        mesh.materials.clear()
        for slot in materials:
            mesh.materials.append(slot)
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.parent = rig_object
        obj.matrix_parent_inverse = self.source.matrix_parent_inverse.copy()
        obj.matrix_basis = self.source.matrix_basis.copy()
        for group in self.source.vertex_groups:
            obj.vertex_groups.new(name=group.name)
        obj.modifiers.new("Armature", "ARMATURE").object = rig_object
        return obj


def trousers(body, rig, slot):
    """Straight-cut work trousers: the Peasant legs pushed out, the lower legs widened into straight tubes that fall
    over the boot shafts, and lengthened to just above the ankle."""
    garment = Derived(scene_mesh(LEGS), lambda p: True, .008, [slot])
    knee_y = rig.at("calf_l").y
    legs, feet = set(body.select(None, meshes=[LEGS], minimum=0)), set(body.select(None, meshes=[FEET], minimum=0))
    tubes = {}
    for side, s in SIDES:
        knee = numpy.array([tuple(body.positions[i]) for i in legs if body.positions[i].x * s > 0 and abs(body.positions[i].y - knee_y) < .04])
        boot = numpy.array([tuple(body.positions[i]) for i in feet if body.positions[i].x * s > 0 and .3 < body.positions[i].y < .45])
        # The tube is centred on the boot shaft and wide enough for the knee above it and the shaft below.
        centre = Vector((float(boot[:, 0].mean()), 0, float(boot[:, 2].mean())))
        def spread(points, centre):
            return numpy.hypot(points[:, 0] - centre.x, points[:, 2] - centre.z)
        knee_centre = Vector((float(knee[:, 0].mean()), 0, float(knee[:, 2].mean())))
        tubes[s] = (centre, max(float(spread(knee, knee_centre).max()) + .004, float(numpy.percentile(spread(boot, centre), 90)) + .016))

    def straighten(p):
        centre, radius = tubes[1 if p.x > 0 else -1]
        k = min(1.0, max(0.0, (knee_y + .08 - p.y) / .16))
        offset = Vector((p.x - centre.x, 0, p.z - centre.z))
        r = offset.length
        if r < 1e-6 or k == 0:
            return p
        return Vector((centre.x, p.y, centre.z)) + offset * ((r + (max(r, radius) - r) * k) / r)
    garment.move(straighten)

    def row(y, extra):
        def place(p):
            centre, radius = tubes[1 if p.x > 0 else -1]
            direction = Vector((p.x - centre.x, 0, p.z - centre.z)).normalized()
            return Vector((centre.x, y, centre.z)) + direction * (radius + extra)
        return place
    garment.hang(lambda p: p.y < .45, [row(.32, .002), row(.21, .004), row(.13, .007)])
    return garment


def sleeves(rig, slot, offset=.014, flare=0.0, tatter=0.0):
    """Long sleeves: the Peasant arms from the shoulder to the wrist pushed out, with a cuff that opens by ``flare``
    and, for a tattered sleeve, ends in uneven points."""
    shoulder, wrist = rig.at("upperarm_l").x, rig.at("hand_l").x
    garment = Derived(scene_mesh(ARMS), lambda p: shoulder + .01 < abs(p.x) < wrist - .025, offset, [slot])
    axis = rig.at("lowerarm_l")

    def row(k):
        def place(p):
            s = 1 if p.x > 0 else -1
            radial = Vector((0, p.y - axis.y, p.z - axis.z))
            angle = math.atan2(radial.z, radial.y)
            radial.normalize()
            length = (.012 + .055 * k) * (1 - tatter * triangle_wave(angle * 6 / math.pi))
            return p + Vector((s * length, 0, 0)) + radial * flare * k * k
        return place
    garment.hang(lambda p: abs(p.x) > wrist - .07, [row(.5), row(1.0)])
    return garment


MANTLE_TOP = 1.535
MANTLE_ZC = -.03


def drape_surface(body, front, back, clearance=.035, arc=None, rows=14, flare=.03, slope=.25, tatter=0.0, arms=0.0):
    """A mantle, cloak or cape (#379): rings around the torso from the neckline down to a hem that runs from ``front``
    (its height at the chest) to ``back``. Each ring clears the torso and the shoulder caps by ``clearance``, and going
    down it never narrows faster than ``slope`` (metres of radius per metre), so the cloth falls from the shoulders and
    shoulder blades instead of following the small of the back. ``arc`` (degrees from the front toward the left
    shoulder) leaves the rest open; ``arms`` keeps the cloth at least that far out at the sides, over the hanging arms;
    the hem flares by ``flare`` and, tattered, ends in uneven points."""
    allowed = [i for i in body.select(None, meshes=[SHIRT, LEGS], minimum=0) if abs(body.positions[i].x) < .24]
    points = body.array[allowed]
    radial = numpy.hypot(points[:, 0], points[:, 2] - MANTLE_ZC)
    angles = numpy.arctan2(points[:, 0], points[:, 2] - MANTLE_ZC)
    columns = 36 if arc else 48
    thetas = ([math.radians(arc[0] + (arc[1] - arc[0]) * j / (columns - 1)) for j in range(columns)] if arc
              else [2 * math.pi * j / columns for j in range(columns)])
    sector = math.pi / columns * 1.5 if not arc else math.radians(abs(arc[1] - arc[0])) / (columns - 1) * .75
    heights = numpy.zeros((rows, columns))
    radii = numpy.full((rows, columns), numpy.nan)
    for j, theta in enumerate(thetas):
        hem = front + (back - front) * (1 - math.cos(theta)) / 2
        difference = numpy.abs((angles - theta + math.pi) % (2 * math.pi) - math.pi)
        in_sector = difference <= sector
        for i in range(rows):
            heights[i, j] = MANTLE_TOP + (hem - MANTLE_TOP) * i / (rows - 1)
            near = in_sector & (numpy.abs(points[:, 1] - heights[i, j]) < .025)
            if near.any():
                radii[i, j] = float(radial[near].max())
    for i in range(rows):
        known = ~numpy.isnan(radii[i])
        radii[i] = numpy.interp(numpy.arange(columns), numpy.flatnonzero(known), radii[i][known]) if known.any() else .1
    # The cloth spans the spine's groove and the folds instead of dipping into them: the outermost of each column's
    # neighbours, then averaged, then the clearance.
    pad = "wrap" if arc is None else "edge"
    wide = numpy.pad(radii, ((0, 0), (2, 2)), mode=pad)
    radii = numpy.max([wide[:, k:k + columns] for k in range(5)], axis=0)
    wide = numpy.pad(radii, ((0, 0), (1, 1)), mode=pad)
    radii = numpy.mean([wide[:, k:k + columns] for k in range(3)], axis=0) + clearance
    grid = [[None] * columns for _ in range(rows)]
    for j, theta in enumerate(thetas):
        previous = None
        for i in range(rows):
            r, y = float(radii[i, j]), float(heights[i, j])
            if previous is not None:
                r = max(r, previous - slope * (heights[0, j] - heights[-1, j]) / (rows - 1))
            if arms and y < 1.42:
                r = max(r, arms * abs(math.sin(theta)) ** 2)
            previous = r
            drop = 0.0
            if i == rows - 1:
                r += flare
                drop = tatter * .06 * (.35 + .65 * triangle_wave(j * .5))
            elif i == rows - 2:
                r += flare * .4
            grid[i][j] = Vector((math.sin(theta) * r, y - drop, MANTLE_ZC + math.cos(theta) * r))
    return {"grid": grid, "closed": arc is None, "axis": (Vector((0, MANTLE_TOP, MANTLE_ZC)), Vector((0, -1, 0))), "thetas": thetas,
            "ts": list(range(rows))}


def leaves(surface, every=3, length=.07):
    """Leaf cards hanging over the lower half of a mantle (the Druid), drawn into the mantle's own builder (slot 1)."""
    grid = surface["grid"]
    rows = len(grid)

    def draw(builder):
        for i in range(rows // 2, rows - 1):
            for j in range(0, len(grid[0]), every):
                index = i * 31 + j * 7
                p = grid[i][(j + i) % len(grid[0])]
                out = Vector((p.x, 0, p.z - MANTLE_ZC)).normalized()
                side = out.cross(Vector((0, 1, 0))).normalized()
                tip = (Vector((0, -1, 0)) + side * (((index * 37) % 11) - 5) / 12).normalized()
                size = length * (.8 + .4 * ((index * 13) % 7) / 6)
                base = p + out * .008
                quad = [base, base + tip * size * .5 + side * size * .22 + out * .01, base + tip * size + out * .016,
                        base + tip * size * .5 - side * size * .22 + out * .01]
                verts = [builder.vert(q) for q in quad]
                builder.face(verts, 1)
                builder.face(list(reversed([builder.vert(q - out * .002) for q in quad])), 1)
    return draw


def hood_surface(body, spec):
    """A hood (#379): a soft dome fitted to the head's extents with a peak that falls back over the crown, an open face
    from the chin to the brow, and a drape that flares out and settles onto the shoulders."""
    centre, indices = head_centre(body)
    points = body.array[indices]
    top = centre.y
    half_x = float(points[:, 0].max() - points[:, 0].min()) / 2 + spec["clearance"]
    half_z = float(points[:, 2].max() - points[:, 2].min()) / 2 + spec["clearance"] + .008
    mid_z = float(points[:, 2].max() + points[:, 2].min()) / 2
    brow, chin = top - .07, top - .255
    bottom, crown = top - .33, top + spec["crown"]
    shirt = body.array[body.select(None, meshes=[SHIRT], minimum=0)]
    rows, columns = 26, 40
    thetas = [2 * math.pi * j / columns for j in range(columns)]
    grid = []
    for i in range(rows):
        y = bottom + (crown - bottom) * i / (rows - 1)
        if y <= brow:
            r, back = 1 + spec["drape"] * max(0.0, (chin + .02 - y) / (chin + .02 - bottom)) ** 1.5, 0.0
        else:
            u = (y - brow) / (crown - brow)
            r, back = (1 - u ** 2.4) ** (1 / 2.4), -spec["peak"] * u * u
        row = []
        for theta in thetas:
            p = Vector((centre.x + half_x * r * math.sin(theta), y, mid_z + back + half_z * r * math.cos(theta)))
            # The drape rests on the shoulders instead of passing through them.
            near = shirt[(numpy.abs(shirt[:, 0] - p.x) < .03) & (numpy.abs(shirt[:, 2] - p.z) < .03)]
            if len(near):
                p.y = max(p.y, float(near[:, 1].max()) + .04)
            row.append(p)
        grid.append(row)
    surface = {"grid": grid, "closed": True, "axis": (Vector((centre.x, bottom, mid_z)), Vector((0, 1, 0))), "thetas": thetas,
               "ts": list(range(rows))}

    def mask(i, j):
        theta = abs((thetas[j] + math.pi / columns + math.pi) % (2 * math.pi) - math.pi)
        y = (grid[i][j].y + grid[i + 1][j].y) / 2
        return not (theta < math.radians(52) and chin - .01 < y < brow + .02)
    return surface, mask, (chin - .03, chin + .03)


def sash(body, mirror=1):
    """A sash from one shoulder to the other hip, like the soldier's (#309), over a jerkin."""
    torso = body.select(["spine_01", "spine_02", "spine_03", "clavicle_l", "clavicle_r", "pelvis"], meshes=[SHIRT], minimum=.5)
    middle = Vector((0, 1.25, float(body.array[torso][:, 2].mean())))
    shoulder, hip = Vector((.13 * mirror, 1.5, 0)), Vector((-.15 * mirror, .99, 0))
    along = (shoulder - hip).normalized()
    normal = Vector((along.y, -along.x, 0))
    return ring_grid(body, torso, middle - normal * .035, middle + normal * .035, FRONT, along, (0, 1), 3, None, 40, .03, slab=.03)


def class_robe(body, kit, tatter=0.0):
    skirt = tunic_skirt(body, .16, .15, 20)
    if tatter:
        hem = skirt["grid"][-1]
        for j, p in enumerate(hem):
            hem[j] = p - Vector((0, tatter * (.35 + .65 * triangle_wave(j * .5)), 0))
    return (f"{kit}.robe", CLASS_ROBES[kit][0], skirt, None)


def class_cloth(body, rig, kit):
    garments = []
    if kit == "class.warden":
        for name, slot, surface, mask in cloth_surfaces(body, rig, "knight"):
            garments.append((name.replace("knight.", "class.warden."), "class", surface, mask))
        return garments
    if kit in CLASS_JERKINS:
        jerkin, legwear = CLASS_JERKINS[kit]
        garments.append((f"{kit}.jerkin", jerkin, tunic_skirt(body, .86, .03, 5), None))
        garments.append((f"{kit}.trousers", None, trousers(body, rig, legwear), None))
        garments.append((f"{kit}.sleeves", None, sleeves(rig, jerkin), None))
        garments.append((f"{kit}.sash", "class", sash(body, 1 if kit == "class.ranger" else -1), None,
                         {"torso": True, "follow": ("spine_03", 1.25, 1.40)}))
    if kit in CLASS_ROBES:
        garments.append(class_robe(body, kit, .07 if kit == "class.necromancer" else 0.0))
    if kit in HOODS:
        surface, mask, (low, high) = hood_surface(body, HOODS[kit])
        garments.append((f"{kit}.hood", HOODS[kit]["slot"], surface, mask,
                         {"allowed": {f"{kit}.hood": [SHIRT, HEAD]}, "torso": True, "follow": ("Head", low, high)}))
    # Mantles, the cloak and the cape ride the chest and shoulders; the hanging arms do not drag them.
    drape = {"exclude": HANGING_ARM, "follow": ("spine_03", 1.12, 1.3)}
    if kit == "class.ranger":
        # Open at the chest but wrapped over both shoulders, so it reads from the front too (owner, 2026-10-25).
        garments.append((f"{kit}.cloak", "wool.olive", drape_surface(body, 1.06, .82, clearance=.042, arc=(42, 318), rows=16, flare=.04,
                                                                     slope=.12, arms=.3), None, drape))
    if kit == "class.rogue":
        # One shoulder: over the left shoulder, across the back and down the left side of the chest.
        garments.append((f"{kit}.cape", "wool.umber", drape_surface(body, 1.12, 1.02, clearance=.04, arc=(12, 200), rows=12, flare=.03,
                                                                       slope=.18, tatter=.7, arms=.28), None, drape))
    if kit == "class.arcanist":
        garments.append((f"{kit}.sleeves", None, sleeves(rig, "sleeve.indigo", flare=.10), None))
        garments.append((f"{kit}.mantle", "class", drape_surface(body, 1.3, 1.2), None, drape))
    if kit == "class.necromancer":
        garments.append((f"{kit}.sleeves", None, sleeves(rig, "sleeve.black", flare=.07, tatter=.8), None))
        garments.append((f"{kit}.mantle", "class", drape_surface(body, 1.27, 1.15, flare=.035, tatter=.9), None, drape))
    if kit == "class.cleric":
        garments.append((f"{kit}.sleeves", None, sleeves(rig, "sleeve.ivory", flare=.03), None))
        # The sun tabard over the robe, with the class colour along its sides and hems (the cloth itself, no decal).
        surface = tabard_surface(body, rig, clearance=(.032, .036, .1))
        mask = tabard_mask(surface)
        robe = Builder()
        robe.shell(class_robe(body, kit)[2], .006, 0)
        robe_mesh = bpy.data.meshes.new("cleric-robe-collider")
        robe.bm.to_mesh(robe_mesh)
        robe.bm.free()
        bodies = [o for o in bpy.context.scene.objects if o.type == "MESH" and o.name in (SHIRT, LEGS)]
        settle_tabard(surface, mask, bodies, [("robe", robe_mesh)])
        last = len(surface["grid"]) - 2
        columns = len(surface["grid"][0]) - 1

        def edging(i, j):
            return 1 if j in (0, columns - 1) or i in (0, last) else 0
        garments.append((f"{kit}.tabard", "tabard.white", surface, mask, {"slots": ["class"], "material": edging}))
    if kit == "class.druid":
        garments.append((f"{kit}.sleeves", None, sleeves(rig, "sleeve.moss", flare=.04, tatter=.4), None))
        cape = drape_surface(body, 1.28, 1.17, flare=.035, tatter=.5)
        garments.append((f"{kit}.mantle", "bark", cape, None, {**drape, "slots": ["class"], "decorate": leaves(cape)}))
    return garments


def class_belt(body, name, slot, clearance):
    waist = body.select(["pelvis", "spine_01", "thigh_l", "thigh_r"], meshes=[SHIRT, LEGS], minimum=.5)
    centre = Vector((0, 0, float(body.array[waist][:, 2].mean())))
    belt = ring_grid(body, waist, centre + Vector((0, .985, 0)), centre + Vector((0, 1.03, 0)), FRONT, Vector((1, 0, 0)),
                     (0, 1), 3, None, 28, clearance, slab=.03)
    return (name, "pelvis", slot, belt, None, None, .006)


def forearm_band(body, rig, side, start, end, clearance, rows, profile=None):
    elbow, wrist = rig.at(f"lowerarm_{side}"), rig.at(f"hand_{side}")
    forearm = body.select([f"lowerarm_{side}"], meshes=[ARMS], minimum=.5)
    return ring_grid(body, forearm, elbow + (wrist - elbow) * start, elbow + (wrist - elbow) * end, UP, FRONT, (0, 1), rows, None, 16,
                     clearance, profile)


def half_mask(body):
    """The Rogue's cloth half-mask: a band around the lower face from under the chin to just below the eyes."""
    centre, _indices = head_centre(body)
    head = body.select(["Head", "neck_01"], minimum=.5)
    a = Vector((centre.x, 1.44, centre.z))
    reach, columns = math.radians(100), 25
    thetas = [-reach + 2 * reach * j / (columns - 1) for j in range(columns)]
    ts = [1.552 - a.y + (1.668 - 1.552) * i / 9 for i in range(10)]
    radii = fit_radii(body, head, a, UP, FRONT, Vector((1, 0, 0)), ts, thetas, .006, math.radians(5), False) + .008
    grid = [[a + UP * t + (FRONT * math.cos(theta) + Vector((1, 0, 0)) * math.sin(theta)) * float(radii[i, j])
             for j, theta in enumerate(thetas)] for i, t in enumerate(ts)]
    return {"grid": grid, "closed": False, "axis": (a, UP), "thetas": thetas, "ts": ts}


def neck_ring(body, height, extra, count):
    """Points around the shirt's neckline at ``height``, ``extra`` outside it (the Necromancer's bone beads)."""
    shirt = [i for i in body.select(None, meshes=[SHIRT], minimum=0) if abs(body.positions[i].x) < .16]
    a = Vector((0, height - .02, -.03))
    thetas = [2 * math.pi * j / count for j in range(count)]
    radii = fit_radii(body, shirt, a, UP, FRONT, Vector((1, 0, 0)), [.02], thetas, .012, math.pi / count, True)
    return [a + UP * .02 + (FRONT * math.cos(t) + Vector((1, 0, 0)) * math.sin(t)) * (float(radii[0, j]) + extra) for j, t in enumerate(thetas)]


def shirt_top(body, x, z, reach=.025):
    shirt = body.array[body.select(None, meshes=[SHIRT], minimum=0)]
    near = shirt[(numpy.abs(shirt[:, 0] - x) < reach) & (numpy.abs(shirt[:, 2] - z) < .06)]
    return float(near[:, 1].max())


def front_of(body, meshes, y, x=0.0):
    points = body.array[body.select(None, meshes=meshes, minimum=0)]
    near = points[(numpy.abs(points[:, 0] - x) < .03) & (numpy.abs(points[:, 1] - y) < .02)]
    return float(near[:, 2].max())


def class_plates(body, rig, kit):
    if kit == "class.warden":
        return [(name.replace("knight.", "class.warden."), *rest) for name, *rest in plate_surfaces(body, rig, "knight")]
    pieces = []
    robed = kit in CLASS_ROBES
    belt = {"class.ranger": "leather", "class.rogue": "leather", "class.arcanist": "sash.gold", "class.necromancer": "leather",
            "class.cleric": "gold", "class.druid": "rope"}[kit]
    pieces.append(class_belt(body, f"{kit}.belt", belt, .032 if robed else .03))
    if kit in ("class.ranger", "class.rogue"):
        for side, _s in SIDES:
            if kit == "class.ranger":
                def bracer(t, theta, r):
                    return r + .006 * math.sin(math.pi * t)
                pieces.append((f"{kit}.bracer_{side}", f"lowerarm_{side}", "leather", forearm_band(body, rig, side, .3, .92, .024, 6, bracer),
                               None, None, .004))
            else:
                def wrap(t, theta, r):
                    return r + .002 * math.sin(math.pi * t * 8)
                pieces.append((f"{kit}.wraps_{side}", f"lowerarm_{side}", ("wrap.light", "wrap.dark"),
                               forearm_band(body, rig, side, .12, .96, .022, 9, wrap), None, None, (.004, lambda i, j: i % 2)))
    if kit == "class.rogue":
        pieces.append((f"{kit}.mask", "Head", "mask", half_mask(body), None, None, .004))
    if kit == "class.arcanist":
        # The high collar: the back of a flared ring standing up behind the head, lower toward its front ends.
        shirt = [i for i in body.select(None, meshes=[SHIRT], minimum=0) if abs(body.positions[i].x) < .16]
        a = Vector((0, 1.51, -.03))
        thetas = [math.radians(-25 + 230 * j / 22) for j in range(23)]
        # Angles from +x toward the back (-z): theta 0 is the left side, 90 degrees the back.
        directions = [Vector((math.cos(t), 0, -math.sin(t))) for t in thetas]
        base = fit_radii(body, shirt, a, UP, Vector((1, 0, 0)), Vector((0, 0, -1)), [.02], thetas, .012, math.radians(6), False)[0]
        grid = []
        for i in range(5):
            k = i / 4
            grid.append([a + Vector((0, .02 + .17 * k - (.05 * k if math.sin(t) < 0 else 0), 0)) + d * (float(base[j]) + .046 + .045 * k)
                         for j, (t, d) in enumerate(zip(thetas, directions))])
        collar = {"grid": grid, "closed": False, "axis": (a, UP), "thetas": thetas, "ts": list(range(5))}
        pieces.append((f"{kit}.collar", "spine_03", "class", collar, None, None, .006))
    if kit == "class.necromancer":
        # Smooth beads (two subdivisions shade round without the plate bevel multiplying their edges).
        beads = neck_ring(body, 1.5, .047, 12)
        pieces.append((f"{kit}.bone-collar", "spine_03", "bone", lambda builder: [builder.blob(p, .019, 0, subdivisions=2) for p in beads],
                       None, None, 0))
        for side, s in SIDES:
            top = shirt_top(body, .15 * s, -.03)
            def spikes(builder, s=s, top=top):
                for k, dz in enumerate((.04, 0, -.04)):
                    base = Vector((.15 * s, top + .02, -.03 + dz))
                    builder.spike(base, base + Vector((.06 * s, .13 - .02 * abs(k - 1), dz * .6)), .018, .0, 0)
            pieces.append((f"{kit}.bone-spikes_{side}", f"clavicle_{side}", "bone", spikes, None, None, 0))
        clasp = Vector((0, 1.007, front_of(body, [SHIRT, LEGS], 1.0) + .05))
        pieces.append((f"{kit}.skull-clasp", "pelvis", "bone", lambda builder: builder.blob(clasp, .034, 0, (1, 1.15, .7), 2), None, None, 0))
    if kit == "class.cleric":
        for name, joint, _slot, surface, mask, apex, thickness in plate_surfaces(body, rig, "knight"):
            if "spaulder" in name:
                pieces.append((name.replace("knight.", "class.cleric."), joint, "gold", surface, mask, apex, thickness))
        for side, _s in SIDES:
            pieces.append((f"{kit}.cuff_{side}", f"lowerarm_{side}", "gold", forearm_band(body, rig, side, .86, .97, .03, 3), None, None, .003))
        centre = Vector((0, 1.34, front_of(body, [SHIRT], 1.34) + .05))
        thetas = [2 * math.pi * j / 24 for j in range(24)]
        grid = [[centre + Vector((math.cos(t) * r, math.sin(t) * r, .008 * (1 - r / .1))) for t in thetas] for r in (.004, .025, .05)]
        grid.append([centre + Vector((math.cos(t), math.sin(t), 0)) * (.1 if j % 2 == 0 else .066) for j, t in enumerate(thetas)])
        sun = {"grid": grid, "closed": True, "axis": (centre - FRONT * .05, FRONT), "thetas": thetas, "ts": list(range(4))}
        pieces.append((f"{kit}.sun", "spine_03", "gold", sun, None, None, .005))
    if kit == "class.druid":
        centre, indices = head_centre(body)
        brow = centre.y - .075
        circlet = ring_grid(body, indices, Vector((centre.x, brow - .004, centre.z)), Vector((centre.x, brow + .016, centre.z)), FRONT,
                            Vector((1, 0, 0)), (0, 1), 2, None, 32, .011)
        mid_z = float(body.array[indices][:, 2].mean())

        def antlers(builder):
            for s in (1, -1):
                b0 = Vector((.072 * s, brow + .014, mid_z + .005))
                p1 = b0 + Vector((.05 * s, .11, -.02))
                p2 = p1 + Vector((.06 * s, .1, -.04))
                builder.spike(b0, p1, .012, .009, 0)
                builder.spike(p1, p2, .009, .003, 0)
                builder.spike(p1, p1 + Vector((0, .07, .04)), .007, .002, 0)
                m1 = b0 + (p1 - b0) * .5
                builder.spike(m1, m1 + Vector((.06 * s, .03, .02)), .006, .002, 0)
                q = p2 - (p2 - p1) * .3
                builder.spike(q, p2 + Vector((-.03 * s, .05, -.03)), .005, .002, 0)
        pieces.append((f"{kit}.antler-circlet", "Head", "antler", circlet, None, None, .005))
        pieces.append((f"{kit}.antler-circlet", "Head", "antler", antlers, None, None, 0))
    return pieces


# ---------------------------------------------------------------------------------------------- Redbrand bandit (#389)

# A rough long coat in dark oxblood wool to mid-calf, its hem worn ragged, with long sleeves over brown work trousers
# and the Peasant boots; a cowl in the recolourable ``faction`` slot (the band's red) round the neck and shoulders, a
# leather belt and leather bracers.
MATERIALS.update({"coat.redbrand": (linear("#4a1f17"), 0.0, .93)})
REDBRAND_COAT = {"hem": .32, "flare": .1, "rows": 18, "tatter": .035}
TUNICS["redbrand.coat"], HIDES["redbrand.coat"] = ("coat.redbrand", .014), [SHIRT]
SETTLE["redbrand.coat"] = (.6, 1.0, REDBRAND_COAT["hem"])
STRIDE["redbrand.coat"] = (.7, 1.0, REDBRAND_COAT["hem"], .05)
HIDES["redbrand.trousers"] = [LEGS]


REDBRAND_SCARF = {"bottom": 1.5, "top": 1.59, "rows": 7, "columns": 28, "clearance": .012, "roll": .016}


def redbrand_scarf(body):
    """The band's red scarf: a thick wrap rolled round the neck, an ellipse round the neck and the shirt collar with a
    rounded roll and a few twists, resting on the collar."""
    spec = REDBRAND_SCARF
    points = body.array[[i for i in body.select(None, meshes=[SHIRT, HEAD], minimum=0)
                         if spec["bottom"] - .01 < body.positions[i].y < spec["top"] and abs(body.positions[i].x) < .1]]
    xc, zc = float(points[:, 0].mean()), float(numpy.median(points[:, 2]))
    half_x = float(numpy.percentile(numpy.abs(points[:, 0] - xc), 98)) + spec["clearance"]
    half_z = float(numpy.percentile(numpy.abs(points[:, 2] - zc), 90)) + spec["clearance"]
    rows, columns = spec["rows"], spec["columns"]
    thetas = [2 * math.pi * j / columns for j in range(columns)]
    ts = [spec["bottom"] + (spec["top"] - spec["bottom"]) * i / (rows - 1) for i in range(rows)]
    grid = []
    for i, y in enumerate(ts):
        t = i / (rows - 1)
        row = []
        for theta in thetas:
            grow = spec["roll"] * math.sin(math.pi * t) + .004 * math.sin(theta * 3 + t * 5) + .01 * (1 - t) ** 3
            row.append(Vector((xc + (half_x + grow) * math.sin(theta), y, zc + (half_z + grow) * math.cos(theta))))
        grid.append(row)
    return {"grid": grid, "closed": True, "axis": (Vector((xc, spec["bottom"], zc)), UP), "thetas": thetas, "ts": ts}


def redbrand_scarf_tail(body):
    """The scarf's loose end, hanging from the wrap down the left of the chest over the coat."""
    rows, columns = 8, 4
    ys = [1.53 - .18 * i / (rows - 1) for i in range(rows)]
    grid = []
    for i, y in enumerate(ys):
        drift = .02 * i / (rows - 1)
        row = []
        for j in range(columns):
            x = .035 + drift + .06 * j / (columns - 1)
            row.append(Vector((x, y, front_of(body, [SHIRT], y, x) + .03 - .006 * i / (rows - 1))))
        grid.append(row)
    return {"grid": grid, "closed": False, "axis": (Vector((0, 1.45, 0)), UP), "thetas": [p.x for p in grid[0]], "ts": ys}


def redbrand_cloth(body, rig):
    coat = tunic_skirt(body, REDBRAND_COAT["hem"], REDBRAND_COAT["flare"], REDBRAND_COAT["rows"], lambda theta: .004 * math.cos(theta * 9))
    hem = coat["grid"][-1]
    for j, p in enumerate(hem):
        hem[j] = p - Vector((0, REDBRAND_COAT["tatter"] * triangle_wave(j * .37), 0))
    columns = len(coat["grid"][0])

    def split(i, j):
        """The coat is open at the front below the belt, the split widening toward the hem over the trousers."""
        half = 0 if i < 2 else 1 if i < 10 else 2
        return not (j < half or j >= columns - half)
    scarf = redbrand_scarf(body)
    return [("redbrand.coat", "coat.redbrand", coat, split),
            ("redbrand.trousers", None, trousers(body, rig, "trousers.brown"), None),
            ("redbrand.sleeves", None, sleeves(rig, "coat.redbrand", offset=.016, flare=.025), None),
            ("redbrand.scarf", "faction", scarf, None, {"exclude": HANGING_ARM, "torso": True, "follow": ("neck_01", 1.52, 1.59)}),
            ("redbrand.scarf-end", "faction", redbrand_scarf_tail(body), None, {"exclude": HANGING_ARM, "torso": True,
                                                                                  "follow": ("spine_03", 1.2, 1.35)})]


def redbrand_plates(body, rig):
    pieces = [class_belt(body, "redbrand.belt", "leather", .026)]
    for side, _s in SIDES:
        def bracer(t, theta, r):
            return r + .005 * math.sin(math.pi * t)
        pieces.append((f"redbrand.bracer_{side}", f"lowerarm_{side}", "leather", forearm_band(body, rig, side, .35, .9, .03, 6, bracer),
                       None, None, .004))
    return pieces


# ---------------------------------------------------------------------------------------------- output

def finish_mesh(builder, name, materials):
    bm = builder.bm
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="FIXED", ngon_method="EAR_CLIP")
    for face in bm.faces:
        face.smooth = True
    for edge in bm.edges:
        faces = edge.link_faces
        edge.smooth = len(faces) == 2 and faces[0].material_index == faces[1].material_index and edge.calc_face_angle(math.pi) < SHARP_ANGLE
    triangles = len(bm.faces)
    mesh = bpy.data.meshes.new(f"{name}-geometry")
    bm.to_mesh(mesh)
    bm.free()
    for slot in materials:
        mesh.materials.append(slot)
    return mesh, triangles


# Blender finishing for rigid plates (Atlas Decision 5.1.6): a narrow bevel rounds every hard edge so plate rims catch
# light instead of reading as knife edges, and weighted normals keep the large faces flat-shaded and clean.
PLATE_BEVEL = {"width": .004, "segments": 3, "angle": math.radians(40)}
# Owner answer on #120 (option A): Smart-UV unwrap and pack, then a baked ambient-occlusion map per piece, bound as the
# glTF occlusion texture so crevices and overlaps read at the game camera.
PLATE_AO = {"size": 512, "samples": 64, "distance": .08, "island_margin": .02, "bake_margin": 4}


def gltf_output_group():
    """The node group the glTF exporter reads extra outputs from (its `Occlusion` input becomes occlusionTexture)."""
    group = bpy.data.node_groups.get("glTF Material Output")
    if group is None:
        group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    return group


def bake_ambient_occlusion(obj, bases):
    """Unwrap ``obj``, bake its AO into a PNG and give it its own copy of each of ``bases`` (its material slots, in
    order) with that occlusion map."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(island_margin=PLATE_AO["island_margin"])
    bpy.ops.uv.pack_islands(margin=PLATE_AO["island_margin"])
    bpy.ops.object.mode_set(mode="OBJECT")
    image = bpy.data.images.new(f"{obj.name}-ao", PLATE_AO["size"], PLATE_AO["size"], alpha=False)
    image.colorspace_settings.name = "Non-Color"
    materials = []
    for base in bases:
        material = base.copy()
        material.name = f"{base.name}.{obj.name}"
        nodes = material.node_tree.nodes
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = image
        nodes.active = texture
        materials.append((material, texture))
    obj.data.materials.clear()
    for material, _texture in materials:
        obj.data.materials.append(material)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = PLATE_AO["samples"]
    scene.cycles.seed = 0
    scene.world = scene.world or bpy.data.worlds.new("bake")
    scene.world.light_settings.distance = PLATE_AO["distance"]
    scene.render.bake.margin = PLATE_AO["bake_margin"]
    bpy.ops.object.bake(type="AO", margin=PLATE_AO["bake_margin"], use_clear=True)
    image.filepath_raw = f"//{obj.name}-ao.png"
    image.file_format = "PNG"
    image.pack()
    # Bind it: the red channel of the baked image feeds the glTF output group's Occlusion socket.
    for material, texture in materials:
        nodes = material.node_tree.nodes
        separate = nodes.new("ShaderNodeSeparateColor")
        material.node_tree.links.new(texture.outputs["Color"], separate.inputs["Color"])
        output = nodes.new("ShaderNodeGroup")
        output.node_tree = gltf_output_group()
        material.node_tree.links.new(separate.outputs["Red"], output.inputs["Occlusion"])
    return [material for material, _texture in materials]


def finish_plate(obj, bases):
    """Apply the plate finishing modifiers and the AO bake to ``obj`` in place and return its triangle count."""
    bevel = obj.modifiers.new("bevel", "BEVEL")
    bevel.width, bevel.segments = PLATE_BEVEL["width"], PLATE_BEVEL["segments"]
    bevel.limit_method, bevel.angle_limit = "ANGLE", PLATE_BEVEL["angle"]
    bevel.harden_normals = False
    weighted = obj.modifiers.new("weighted-normals", "WEIGHTED_NORMAL")
    weighted.keep_sharp = True
    bpy.context.view_layer.objects.active = obj
    for modifier in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    bake_ambient_occlusion(obj, bases)
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="FIXED", ngon_method="EAR_CLIP")
    count = len(bm.faces)
    bm.free()
    return count


def geometry_hash(meshes):
    digest = hashlib.sha256()
    for mesh in meshes:
        for v in mesh.vertices:
            digest.update(b"".join(float(c).hex().encode("ascii") + b"\n" for c in v.co))
        for f in mesh.polygons:
            digest.update((",".join(str(i) for i in f.vertices) + ":" + str(f.material_index) + "\n").encode("ascii"))
    return digest.hexdigest()


def bounds(points):
    return {"min": [round(min(p[i] for p in points), 6) for i in range(3)], "max": [round(max(p[i] for p in points), 6) for i in range(3)]}


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    kit, output = arguments["kit"], arguments["output"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=inputs["target"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
    rigs = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    if len(rigs) != 1:
        raise ValueError("the target GLB must have one armature")
    rig_object = rigs[0]
    rig = Rig(rest_worlds(glb_json(inputs["target"])))
    # #378: the female kits fit the Female_Peasant base; the target names the figure by its base nodes.
    use_figure("female" if kit in FEMALE_KITS else "male")
    body = Body(rig)
    if not body.select(None, meshes=[SHIRT], minimum=0):
        raise ValueError(f"the target must contain the base outfit node {SHIRT}")
    palette = {name: material(name) for name in sorted(MATERIALS)}
    if kit in CLASS_TRIM:
        shader = palette["class"].node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = (*linear(CLASS_TRIM[kit]), 1)
    exported, pieces = [], []
    if output == "plates":
        grouped = {}
        for name, joint, slot, surface, mask, apex, thickness in plate_surfaces(body, rig, kit):
            grouped.setdefault(name, (joint, slot, []))[2].append((surface, mask, apex, thickness))
        for name in sorted(grouped):
            joint, slot, parts = grouped[name]
            # A piece has one slot, or several (#379) that its surfaces pick per grid cell or per primitive.
            slots = [slot] if isinstance(slot, str) else list(slot)
            builder = Builder()
            for surface, mask, apex, thickness in parts:
                if callable(surface):
                    surface(builder)
                elif isinstance(thickness, tuple):
                    builder.shell(surface, thickness[0], thickness[1], mask, apex)
                else:
                    builder.shell(surface, thickness, 0, mask, apex)
            if name == "soldier.belt":
                front = max(parts[0][0]["grid"][1], key=lambda p: p.z)
                builder.box(front + Vector((0, 0, .006)), (.026, .022, .006), 0)
            points = list(builder.points)
            mesh, triangles = finish_mesh(builder, name, [palette[s] for s in slots])
            obj = bpy.data.objects.new(name, mesh)
            bpy.context.scene.collection.objects.link(obj)
            triangles = finish_plate(obj, [palette[s] for s in slots])
            exported.append(obj)
            pieces.append({"node": name, "kind": "rigid", "joint": joint, "materials": [m.name for m in obj.data.materials], "triangleCount": triangles,
                           "bounds": bounds(points), "hides": HIDES.get(name, [])})
    else:
        shirt = next(o for o in bpy.context.scene.objects if o.type == "MESH" and o.name == SHIRT)
        for name, slot, surface, mask, *extra in cloth_surfaces(body, rig, kit):
            if isinstance(surface, Derived):
                # #379: a garment cut from a base mesh, keeping the base's own skin weights.
                obj = surface.finish(name, [palette[s] for s in surface.slots], rig_object)
                exported.append(obj)
                pieces.append({"node": name, "kind": "skinned", "nodes": [obj.name], "materials": list(surface.slots),
                               "triangleCount": surface.triangles, "bounds": bounds(surface.points), "hides": HIDES.get(name, [])})
                continue
            spec = extra[0] if extra else {}
            slots = [slot] + spec.get("slots", [])
            builder = Builder()
            builder.shell(surface, .005 if slot in ("faction", "class") or name in TABARDS else .006, spec.get("material", 0), mask)
            if spec.get("decorate"):
                spec["decorate"](builder)
            points = list(builder.points)
            allowed = body.select(None, meshes=[SHIRT, LEGS], minimum=0)
            if name in spec.get("allowed", ()):
                allowed = body.select(None, meshes=spec["allowed"][name], minimum=0)
            if name in TABARDS or name in ("soldier.sash", "innkeeper.apron", "tanner.apron") or spec.get("torso"):
                # These ride the torso: arm and shoulder joints must not pull them off the shoulder or into a plate (#309).
                allowed = [i for i in allowed if max(body.weights[i], key=body.weights[i].get) not in ARM_JOINTS]
            if spec.get("exclude"):
                allowed = [i for i in allowed if max(body.weights[i], key=body.weights[i].get) not in spec["exclude"]]
            tree = cloth_tree(body, allowed)
            weights = [blend_weights(body, tree, Vector(p)) for p in builder.points]
            if spec.get("follow"):
                joint, low, high = spec["follow"]
                weights = [follow(w, joint, (p[1] - low) / (high - low)) for w, p in zip(weights, builder.points)]
            if name in TABARDS:
                # Over the breastplate the tabard rides spine_03 like the plate, so the plate cannot push through it;
                # it blends back to the body's own weights between the plate's lower edge and the hips.
                weights = [follow(w, "spine_03", (p[1] - TABARD_RIGID_FROM[0]) / (TABARD_RIGID_FROM[1] - TABARD_RIGID_FROM[0]))
                           for w, p in zip(weights, builder.points)]
            if name in SETTLE:
                # Long resident skirts blend toward the pelvis down to the hem, so a striding thigh does not drag the
                # whole hem with it.
                amount, top, bottom = SETTLE[name]
                weights = [follow(w, "pelvis", amount * (top - p[1]) / (top - bottom)) for w, p in zip(weights, builder.points)]
            if name in STRIDE:
                # Then each side of the skirt swings with the thigh on that side, so a striding knee cannot push through;
                # only a narrow strip down the middle stretches between them.
                amount, top, bottom, middle = STRIDE[name]
                weights = [follow(w, "thigh_l" if p[0] > 0 else "thigh_r", amount * (top - p[1]) / (top - bottom) * min(1.0, abs(p[0]) / middle))
                           for w, p in zip(weights, builder.points)]
            if name == "soldier.sash":
                # Over the shoulder the sash rides the upper chest, so the arm swing cannot lift it off (#309).
                weights = [follow(w, "spine_03", (p[1] - 1.25) / .15) for w, p in zip(weights, builder.points)]
            mesh, triangles = finish_mesh(builder, name, [palette[s] for s in slots])
            # bmesh keeps vertex order through triangulation, so the weights stay aligned with the vertices.
            parts = [skinned_object(name if name not in TUNICS else f"{name}-skirt", mesh, rig_object, weights)]
            if name in TUNICS:
                tunic_material, offset = TUNICS[name]
                shirt_mesh = offset_shirt(shirt, offset, f"{name}-shirt")
                shirt_mesh.materials.append(palette[tunic_material])
                copy = bpy.data.objects.new(name, shirt_mesh)
                bpy.context.scene.collection.objects.link(copy)
                copy.matrix_world = shirt.matrix_world.copy()
                copy.parent = rig_object
                copy.matrix_parent_inverse = shirt.matrix_parent_inverse.copy()
                for group in shirt.vertex_groups:
                    copy.vertex_groups.new(name=group.name)
                modifier = copy.modifiers.new("Armature", "ARMATURE")
                modifier.object = rig_object
                parts.append(copy)
                triangles += sum(len(p.vertices) - 2 for p in shirt_mesh.polygons)
                points += [tuple(to_gltf(copy.matrix_world @ v.co)) for v in shirt_mesh.vertices]
            exported += parts
            pieces.append({"node": name, "kind": "skinned", "nodes": sorted(p.name for p in parts), "materials": slots,
                           "triangleCount": triangles, "bounds": bounds(points), "hides": HIDES.get(name, [])})
        exported.append(rig_object)
    for obj in list(bpy.context.scene.objects):
        if obj not in exported:
            bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in exported:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = exported[0]
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=output == "plates", export_normals=True, export_tangents=False,
        export_animations=False, export_skins=output == "cloth", export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    meshes = [obj.data for obj in exported if obj.type == "MESH"]
    observations = {"recipe": "armor-v1", "kit": kit, "output": output, "unit": "meter", "axes": "right-handed-y-up",
                    "space": "character-rest", "pieces": pieces, "factionMaterial": "faction",
                    "geometrySha256": geometry_hash(meshes)}
    if kit in CLASS_TRIM:
        # #379: the class colour slot and its default (linear) colour, for the appearance descriptor.
        observations["classMaterial"] = "class"
        observations["classTrim"] = [*linear(CLASS_TRIM[kit]), 1]
    return observations
