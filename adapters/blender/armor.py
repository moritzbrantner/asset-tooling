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

KITS = ("soldier", "knight")
OUTPUTS = ("plates", "cloth")
MATERIALS = {
    # name: (linear base colour, metallic, roughness)
    "steel": ((.62, .64, .66), 1.0, .32),
    "iron": ((.29, .28, .27), 1.0, .48),
    "leather": ((.2, .1, .05), 0.0, .72),
    "gambeson": ((.42, .36, .26), 0.0, .9),
    "faction": ((.25, .04, .04), 0.0, .8),
}
SHARP_ANGLE = math.radians(35)
SHIRT = "Male_Peasant_Body"
# Pieces whose wearer hides a base mesh node completely (the hidden-body-region list, Q12).
HIDES = {"soldier.gambeson": [SHIRT]}


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "kit", "output"}:
        raise ValueError("armor requires exactly schemaVersion, kit and output")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("armor schemaVersion must be 1")
    if p["kit"] not in KITS or p["output"] not in OUTPUTS:
        raise ValueError("armor kit must be soldier or knight and output plates or cloth")
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

    def shell(self, surface, thickness, material, mask=None, apex=None):
        """A closed plate: the fitted outer surface, an inner surface ``thickness`` inside it and bands on open edges."""
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
                    self.face([outer[(top, j)], outer[(top, k)], tip_out], material)
                    self.face([inner[(top, k)], inner[(top, j)], tip_in], material)

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
        thigh = body.select([f"thigh_{side}", f"calf_{side}"], meshes=["Male_Peasant_Legs"], minimum=.5)
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
        waist = body.select(["pelvis", "spine_01", "thigh_l", "thigh_r"], meshes=[SHIRT, "Male_Peasant_Legs"], minimum=.5)
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
    if kit == "soldier":
        hips = body.select(["pelvis", "spine_01", "thigh_l", "thigh_r"], meshes=[SHIRT, "Male_Peasant_Legs"], minimum=.5)
        centre = Vector((0, 0, float(body.array[hips][:, 2].mean())))
        def skirt_profile(t, theta, r):
            quilt = .003 * math.cos(theta * 14)
            return r + .02 * t + quilt
        skirt = ring_grid(body, hips, centre + Vector((0, 1.0, 0)), centre + Vector((0, .70, 0)), FRONT, Vector((1, 0, 0)),
                          (0, 1), 8, None, 32, .016, skirt_profile, slab=.03)
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
        bodies = [o for o in bpy.context.scene.objects if o.type == "MESH" and o.name in (SHIRT, "Male_Peasant_Legs")]
        settle_tabard(surface, mask, bodies, colliders)
        garments.append(("knight.tabard", "faction", surface, mask))
    return garments


TABARD_HALF_WIDTH = .155
ARM_JOINTS = {f"{joint}_{side}" for joint in ("clavicle", "upperarm", "lowerarm", "hand") for side in "lr"}


def tabard_surface(body, rig, obstacles=()):
    """Front and back panels hanging from the shoulders, over the breastplate, joined across the shoulders."""
    torso = body.select(None, meshes=[SHIRT, "Male_Peasant_Legs"], minimum=0)
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
            clearance = (.066 if front else .07) if y >= 1.0 else .042
            row = []
            for j, x in enumerate(xs):
                z = extreme(x, y, front)
                z = (zc + (.12 if front else -.12)) if z is None else z + (clearance if front else -clearance)
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


def offset_shirt(source, distance):
    """The Peasant shirt's surface and skin weights, pushed ``distance`` outward along its normals."""
    mesh = source.data.copy()
    mesh.name = "soldier.gambeson-shirt"
    for vertex in mesh.vertices:
        vertex.co = vertex.co + vertex.normal * distance
    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])
    mesh.materials.clear()
    return mesh


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


def bake_ambient_occlusion(obj, base):
    """Unwrap ``obj``, bake its AO into a PNG and give it its own copy of ``base`` with that occlusion map."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(island_margin=PLATE_AO["island_margin"])
    bpy.ops.uv.pack_islands(margin=PLATE_AO["island_margin"])
    bpy.ops.object.mode_set(mode="OBJECT")
    material = base.copy()
    material.name = f"{base.name}.{obj.name}"
    obj.data.materials.clear()
    obj.data.materials.append(material)
    image = bpy.data.images.new(f"{obj.name}-ao", PLATE_AO["size"], PLATE_AO["size"], alpha=False)
    image.colorspace_settings.name = "Non-Color"
    nodes = material.node_tree.nodes
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    nodes.active = texture
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
    separate = nodes.new("ShaderNodeSeparateColor")
    material.node_tree.links.new(texture.outputs["Color"], separate.inputs["Color"])
    output = nodes.new("ShaderNodeGroup")
    output.node_tree = gltf_output_group()
    material.node_tree.links.new(separate.outputs["Red"], output.inputs["Occlusion"])
    return material


def finish_plate(obj, base):
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
    bake_ambient_occlusion(obj, base)
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
    body = Body(rig)
    if not body.select(None, meshes=[SHIRT], minimum=0):
        raise ValueError(f"the target must contain the base outfit node {SHIRT}")
    palette = {name: material(name) for name in sorted(MATERIALS)}
    exported, pieces = [], []
    if output == "plates":
        grouped = {}
        for name, joint, slot, surface, mask, apex, thickness in plate_surfaces(body, rig, kit):
            grouped.setdefault(name, (joint, slot, []))[2].append((surface, mask, apex, thickness))
        for name in sorted(grouped):
            joint, slot, parts = grouped[name]
            builder = Builder()
            for surface, mask, apex, thickness in parts:
                builder.shell(surface, thickness, 0, mask, apex)
            if name == "soldier.belt":
                front = max(parts[0][0]["grid"][1], key=lambda p: p.z)
                builder.box(front + Vector((0, 0, .006)), (.026, .022, .006), 0)
            points = list(builder.points)
            mesh, triangles = finish_mesh(builder, name, [palette[slot]])
            obj = bpy.data.objects.new(name, mesh)
            bpy.context.scene.collection.objects.link(obj)
            triangles = finish_plate(obj, palette[slot])
            exported.append(obj)
            pieces.append({"node": name, "kind": "rigid", "joint": joint, "materials": [obj.data.materials[0].name], "triangleCount": triangles,
                           "bounds": bounds(points), "hides": HIDES.get(name, [])})
    else:
        shirt = next(o for o in bpy.context.scene.objects if o.type == "MESH" and o.name == SHIRT)
        for name, slot, surface, mask in cloth_surfaces(body, rig, kit):
            builder = Builder()
            builder.shell(surface, .005 if slot == "faction" else .006, 0, mask)
            points = list(builder.points)
            allowed = body.select(None, meshes=[SHIRT, "Male_Peasant_Legs"], minimum=0)
            if name in ("knight.tabard", "soldier.sash"):
                # These ride the torso: arm and shoulder joints must not pull them off the shoulder or into a plate (#309).
                allowed = [i for i in allowed if max(body.weights[i], key=body.weights[i].get) not in ARM_JOINTS]
            tree = cloth_tree(body, allowed)
            weights = [blend_weights(body, tree, Vector(p)) for p in builder.points]
            if name == "knight.tabard":
                # Over the breastplate the tabard rides spine_03 like the plate, so the plate cannot push through it;
                # it blends back to the body's own weights between the plate's lower edge and the hips.
                weights = [follow(w, "spine_03", (p[1] - TABARD_RIGID_FROM[0]) / (TABARD_RIGID_FROM[1] - TABARD_RIGID_FROM[0]))
                           for w, p in zip(weights, builder.points)]
            if name == "soldier.sash":
                # Over the shoulder the sash rides the upper chest, so the arm swing cannot lift it off (#309).
                weights = [follow(w, "spine_03", (p[1] - 1.25) / .15) for w, p in zip(weights, builder.points)]
            mesh, triangles = finish_mesh(builder, name, [palette[slot]])
            # bmesh keeps vertex order through triangulation, so the weights stay aligned with the vertices.
            parts = [skinned_object(name if name != "soldier.gambeson" else "soldier.gambeson-skirt", mesh, rig_object, weights)]
            if name == "soldier.gambeson":
                shirt_mesh = offset_shirt(shirt, .012)
                shirt_mesh.materials.append(palette["gambeson"])
                copy = bpy.data.objects.new("soldier.gambeson", shirt_mesh)
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
            pieces.append({"node": name, "kind": "skinned", "nodes": sorted(p.name for p in parts), "materials": [slot],
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
    return {"recipe": "armor-v1", "kit": kit, "output": output, "unit": "meter", "axes": "right-handed-y-up",
            "space": "character-rest", "pieces": pieces, "factionMaterial": "faction",
            "geometrySha256": geometry_hash(meshes)}
