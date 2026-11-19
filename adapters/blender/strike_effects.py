"""Strike effect meshes (docs/strike-effects.md, #724, #754, #771): eleven small animated meshes a game spawns at a strike's contact
point or on the weapon.

``strike-arc-cut`` and ``strike-arc-heavy`` are crescent ribbons that sweep through the contact point and thin onto
their bright edge; ``cleave-sweep`` is a wider, flatter fan for a slash that hits more than one enemy;
``combo-glint`` is a star glint on the weapon while a follow-up window is open; ``strike-thrust`` is a narrow streak
with a flare; ``impact-burst`` is a star of short spikes that pops and shrinks; ``ground-slam`` is a ring shockwave with rising chips;
``lunge-dust`` is low dust puffs at the feet. For the movement clips (#771): ``leap-slam`` cracks the ground under a
leaping attacker, rolls a dust ring out and throws stones forward; ``dash-trail`` is pale speed streaks along a dash;
``dash-dust`` is dust and grit kicked back from the start foot.
Each is one glTF scene whose nodes (and, for the ribbons and the ring, one morph target ``Thin``) are animated by one
clip, ``Play``, that starts at the contact frame and ends with the effect gone (zero scale or zero area).

Colour and opacity are per vertex (``COLOR_0``, RGBA): a bright edge at alpha 1 fading to alpha 0. The two materials
are core glTF, so any renderer can draw them: ``strike-glow`` (blended, double-sided, warm white base and the same
emissive colour, for an unlit or emissive pass) and ``strike-dust`` (blended, double-sided, dusty brown, no emission).
A game tints them through the material colours.

Authored in glTF axes, metres, sized for the Ranger's reach. The strike entries have their origin at the contact point
with +Z along the strike direction; the arcs curve back towards -X (their swing centre) and lie in the XZ plane, so a
game rolls them about Z for a diagonal or vertical cut and mirrors X for the other hand. ``ground-slam`` and
``lunge-dust`` (and ``leap-slam`` and ``dash-dust``) sit on the ground: origin at the landing or foot point, +Y up and +Z
the attacker's facing. ``dash-trail`` runs from the dash's start (z = 0, on the ground) to its end (z = 1).

``arguments`` are ``{schemaVersion: 1, entry}``. No randomness: chip and spike directions are fixed tables.
``build(entry, collection)`` also works in a live Blender session.
"""
import math

import bpy
from bpy_extras import anim_utils
from mathutils import Vector

RECIPE = "strike-effects-v1"
ENTRIES = ("strike-arc-cut", "strike-arc-heavy", "cleave-sweep", "combo-glint", "strike-thrust", "impact-burst", "ground-slam", "lunge-dust",
           "leap-slam", "dash-trail", "dash-dust")
GLOW, DUST = "strike-glow", "strike-dust"
CLIP = "Play"
CLIP_FPS = 100  # whole frames for every clip length below
CLIP_SECONDS = {"strike-arc-cut": 0.18, "strike-arc-heavy": 0.25, "cleave-sweep": 0.3, "combo-glint": 0.3, "strike-thrust": 0.15, "impact-burst": 0.2, "ground-slam": 0.4, "lunge-dust": 0.35,
                "leap-slam": 0.6, "dash-trail": 0.4, "dash-dust": 0.35}
ALIGN = {"strike-arc-cut": "strike", "strike-arc-heavy": "strike", "cleave-sweep": "strike", "combo-glint": "weapon", "strike-thrust": "strike", "impact-burst": "strike", "ground-slam": "ground", "lunge-dust": "ground",
         "leap-slam": "ground", "dash-trail": "path", "dash-dust": "ground"}
TRIANGLE_BUDGET = 200

# sRGB material colours; the vertex colours carry the gradient.
GLOW_COLOUR = (1.0, 0.93, 0.78)
DUST_COLOUR = (0.74, 0.66, 0.54)

# Ribbon arcs: swing radius (blade tip from the swing centre), leading width, arc behind the contact, arc ahead of
# it, segments, and the height of the heavy arc's edge band.
ARCS = {
    "strike-arc-cut": {"radius": 1.15, "width": 0.16, "behind": 115, "ahead": 10, "segments": 16, "band": 0.0, "sweep": (-40, 12)},
    "strike-arc-heavy": {"radius": 1.55, "width": 0.3, "behind": 150, "ahead": 12, "segments": 20, "band": 0.07, "sweep": (-55, 15)},
    # The cleave sweeps a wide, flat fan: a slash that carries on through more than one enemy.
    "cleave-sweep": {"radius": 1.6, "width": 0.5, "behind": 175, "ahead": 14, "segments": 22, "band": 0.11, "sweep": (-85, 20)},
}


def to_blender(point):
    """A glTF (+Y up) point in Blender's +Z-up frame."""
    x, y, z = point
    return Vector((x, -z, y))


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def smooth(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def ease_out(t):
    t = min(max(t, 0.0), 1.0)
    return 1 - (1 - t) ** 3


def clamp01(t):
    return min(max(t, 0.0), 1.0)


def ease_in(t):
    t = min(max(t, 0.0), 1.0)
    return t * t


# ---------------------------------------------------------------- materials

def material(name):
    """A core-glTF blended material whose base colour is multiplied by the vertex colour and alpha (COLOR_0)."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    tint = nodes.new("ShaderNodeMix")
    tint.data_type = "RGBA"
    tint.blend_type = "MULTIPLY"
    tint.inputs[0].default_value = 1.0
    colour = GLOW_COLOUR if name == GLOW else DUST_COLOUR
    linear = tuple(srgb_to_linear(c) for c in colour) + (1.0,)
    tint.inputs[6].default_value = linear
    links.new(attr.outputs["Color"], tint.inputs[7])
    links.new(tint.outputs[2], bsdf.inputs["Base Color"])
    links.new(attr.outputs["Alpha"], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 1.0
    if name == GLOW:
        bsdf.inputs["Emission Color"].default_value = linear
        bsdf.inputs["Emission Strength"].default_value = 1.0
    links.new(bsdf.outputs[0], out.inputs[0])
    mat.use_backface_culling = False
    try:
        mat.surface_render_method = "BLENDED"
    except (AttributeError, TypeError):
        mat.blend_method = "BLEND"
    return mat


# ---------------------------------------------------------------- geometry

class Mesh:
    """Triangles in glTF axes with a per-corner RGBA colour; ``rows`` remembers vertex groups for a morph."""

    def __init__(self):
        self.verts, self.alphas, self.faces = [], [], []

    def v(self, point, alpha):
        self.verts.append(tuple(point))
        self.alphas.append(alpha)
        return len(self.verts) - 1

    def tri(self, a, b, c):
        self.faces.append((a, b, c))

    def quad(self, a, b, c, d):
        self.tri(a, b, c)
        self.tri(a, c, d)

    def finish(self, name, collection, mat, parent=None, origin=(0, 0, 0), white=1.0):
        mesh = bpy.data.meshes.new(name)
        o = Vector(origin)
        mesh.from_pydata([to_blender(Vector(p) - o) for p in self.verts], [], self.faces)
        mesh.materials.append(mat)
        layer = mesh.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
        for poly in mesh.polygons:
            poly.use_smooth = False
            for li in poly.loop_indices:
                a = self.alphas[mesh.loops[li].vertex_index]
                layer.data[li].color = (white, white, white, a)
        mesh.color_attributes.active_color = layer
        obj = bpy.data.objects.new(name, mesh)
        collection.objects.link(obj)
        obj.parent = parent
        obj.location = to_blender(origin)
        return obj


def node(name, collection, parent, point=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_size = 0.1
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = to_blender(point)
    return obj


def thin_key(obj, target):
    """Add the morph target ``Thin``: every vertex moves to ``target(index, point)`` (glTF axes, mesh-local)."""
    obj.shape_key_add(name="Basis")
    key = obj.shape_key_add(name="Thin")
    for i, vert in enumerate(obj.data.vertices):
        p = vert.co
        key.data[i].co = to_blender(target(i, (p.x, p.z, -p.y)))
    return key


# ---------------------------------------------------------------- animation

class Clip:
    """One action, ``Play``, with a slot per animated node or shape-key block, sampled every frame."""

    def __init__(self, seconds):
        self.action = bpy.data.actions.new(CLIP)
        self.frames = round(seconds * CLIP_FPS)

    def _slot(self, idb, id_type):
        idb.animation_data_create()
        slot = self.action.slots.new(id_type=id_type, name=idb.name)
        idb.animation_data.action = self.action
        idb.animation_data.action_slot = slot

    def node(self, obj, at):
        """``at(t)`` gives the node's glTF translation, rotation (radians about glTF X, Y, Z) and scale at t in [0, 1]."""
        self._slot(obj, "OBJECT")
        obj.rotation_mode = "XYZ"
        for f in range(self.frames + 1):
            translation, rotation, scale = at(f / self.frames)
            obj.location = to_blender(translation)
            rx, ry, rz = rotation
            obj.rotation_euler = (rx, -rz, ry)
            sx, sy, sz = scale
            obj.scale = (sx, sz, sy)
            for path in ("location", "rotation_euler", "scale"):
                obj.keyframe_insert(path, frame=f)

    def weight(self, obj, at):
        """``at(t)`` gives the ``Thin`` morph weight."""
        keys = obj.data.shape_keys
        self._slot(keys, "KEY")
        block = keys.key_blocks["Thin"]
        for f in range(self.frames + 1):
            block.value = min(max(at(f / self.frames), 0.0), 1.0)
            block.keyframe_insert("value", frame=f)

    def finish(self):
        for slot in self.action.slots:
            bag = anim_utils.action_get_channelbag_for_slot(self.action, slot)
            for fc in bag.fcurves:
                for k in fc.keyframe_points:
                    k.interpolation = "LINEAR"
        return {"name": CLIP, "duration": round(self.frames / CLIP_FPS, 6)}


STILL = ((0, 0, 0), (0, 0, 0), (1, 1, 1))


# ---------------------------------------------------------------- entries

def arc(entry, col, root, clip):
    """A crescent ribbon about the swing centre (-radius, 0, 0): its outer edge is the blade tip's path through the
    contact point, tangent to +Z there; it is widest just behind the contact and tapers to nothing at its tail."""
    spec = ARCS[entry]
    r, w0, n, band = spec["radius"], spec["width"], spec["segments"], spec["band"]
    behind, ahead = math.radians(spec["behind"]), math.radians(spec["ahead"])
    centre = (-r, 0.0, 0.0)
    m = Mesh()
    rows = []  # per segment: (outer, mid, inner[, top, bottom]) vertex ids
    for i in range(n + 1):
        u = i / n
        theta = ahead - u * (ahead + behind)  # from the leading point back to the tail
        lead = min(1.0, (ahead - theta) / max(ahead, 1e-6) * 1.5) if theta > 0 else 1.0
        tail = (1 - u) ** 1.4
        width = w0 * lead * tail
        alpha = 0.9 * min(1.0, 1.25 * tail) * (0.6 + 0.4 * lead)
        c, s = math.cos(theta), math.sin(theta)
        at = lambda radius, y=0.0: (centre[0] + radius * c, y, centre[2] + radius * s)
        ids = [m.v(at(r), alpha), m.v(at(r - 0.3 * width), 0.35 * alpha), m.v(at(r - width), 0.0)]
        if band:
            h = band * lead * tail
            ids += [m.v(at(r, h), 0.0), m.v(at(r, -h), 0.0)]
        rows.append(ids)
    for a, b in zip(rows, rows[1:]):
        m.quad(a[0], b[0], b[1], a[1])
        m.quad(a[1], b[1], b[2], a[2])
        if band:
            m.quad(a[3], b[3], b[0], a[0])
            m.quad(a[0], b[0], b[4], a[4])
    pivot = node(f"{entry}.pivot", col, root, centre)
    obj = m.finish(f"{entry}.ribbon", col, bpy.data.materials[GLOW], pivot, origin=centre)
    obj.location = (0, 0, 0)  # the pivot already stands at the swing centre
    edge = {}
    for ids in rows:
        for vid in ids[1:]:
            edge[vid] = ids[0]
    verts = m.verts
    thin_key(obj, lambda i, p: tuple(verts[edge.get(i, i)][k] - centre[k] for k in range(3)))
    lo, hi = (math.radians(a) for a in spec["sweep"])
    # rotating by phi about +Y moves an arc angle theta to theta - phi, so the sweep runs from -lo down to -hi
    clip.node(pivot, lambda t: (centre, (0, -(lo + (hi - lo) * ease_out(t)), 0), (1, 1, 1)))
    clip.weight(obj, lambda t: ease_in((t - 0.3) / 0.7))
    return {"swingRadius": r}


def thrust(entry, col, root, clip):
    """A six-sided streak along +Z, brightest at the contact point and tapering to its tail, and a flat flare there."""
    m = Mesh()
    sides = 6
    tip = m.v((0, 0, 0.16), 1.0)
    rings = [(0.0, 0.08, 1.0), (-0.38, 0.055, 0.55)]
    ids = []
    for z, radius, alpha in rings:
        ids.append([m.v((radius * math.cos(2 * math.pi * k / sides), radius * math.sin(2 * math.pi * k / sides), z), alpha) for k in range(sides)])
    tail = m.v((0, 0, -1.0), 0.0)
    for k in range(sides):
        j = (k + 1) % sides
        m.tri(tip, ids[0][k], ids[0][j])
        m.quad(ids[0][j], ids[0][k], ids[1][k], ids[1][j])
        m.tri(ids[1][j], ids[1][k], tail)
    streak = m.finish(f"{entry}.streak", col, bpy.data.materials[GLOW], root)
    f = Mesh()
    centre = f.v((0, 0, 0), 1.0)
    rim = []
    for k in range(8):
        a = 2 * math.pi * k / 8
        reach = 0.3 if k % 2 == 0 else 0.11
        rim.append(f.v((reach * math.cos(a), reach * math.sin(a), 0), 0.0))
    for k in range(8):
        f.tri(centre, rim[k], rim[(k + 1) % 8])
    flare = f.finish(f"{entry}.flare", col, bpy.data.materials[GLOW], root)

    def streak_at(t):
        grow = ease_out(t / 0.4)
        fade = 1 - smooth((t - 0.45) / 0.55)
        return ((0, 0, -0.3 + 0.35 * grow), (0, 0, 0), (fade, fade, 0.4 + 0.9 * grow))

    def flare_at(t):
        s = ease_out(t / 0.3) * (1 - smooth((t - 0.3) / 0.7))
        return ((0, 0, 0), (0, 0, 0.6 * t), (s, s, s))

    clip.node(streak, streak_at)
    clip.node(flare, flare_at)
    return {}


# Fixed spike directions: a star around the contact, a little denser back towards the attacker (-Z).
SPIKES = [
    (0, 1, 0, 0.42), (0, -1, 0, 0.3), (1, 0, 0, 0.4), (-1, 0, 0, 0.38),
    (0.7, 0.7, -0.2, 0.34), (-0.7, 0.7, -0.2, 0.3), (0.7, -0.7, -0.2, 0.32), (-0.7, -0.7, -0.2, 0.34),
    (0.3, 0.35, -0.9, 0.36), (-0.35, -0.3, -0.9, 0.33), (0.45, -0.2, 0.85, 0.24), (-0.4, 0.3, 0.85, 0.24),
    (0, 0, -1, 0.3), (0.1, 0.95, 0.3, 0.26),
]


def burst(entry, col, root, clip):
    """A small core and fourteen three-sided spikes, bright at the core and fading to their tips."""
    m = Mesh()
    core = [m.v(p, 1.0) for p in ((0.07, 0, 0), (-0.07, 0, 0), (0, 0.07, 0), (0, -0.07, 0), (0, 0, 0.07), (0, 0, -0.07))]
    for a, b in ((0, 2), (2, 1), (1, 3), (3, 0)):
        m.tri(core[a], core[b], core[4])
        m.tri(core[b], core[a], core[5])
    for x, y, z, length in SPIKES:
        d = Vector((x, y, z)).normalized()
        side = d.cross(Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))).normalized()
        other = d.cross(side)
        base = [m.v(d * 0.04 + 0.03 * (math.cos(a) * side + math.sin(a) * other), 1.0) for a in (0, 2.094, 4.189)]
        tip = m.v(d * length, 0.15)
        for k in range(3):
            m.tri(base[k], base[(k + 1) % 3], tip)
    star = m.finish(f"{entry}.star", col, bpy.data.materials[GLOW], root)

    def at(t):
        if t < 0.25:
            s = 0.15 + 1.0 * ease_out(t / 0.25)
        elif t < 0.4:
            s = 1.15 - 0.15 * smooth((t - 0.25) / 0.15)
        else:
            s = 1.0 - ease_in((t - 0.4) / 0.6)
        return ((0, 0, 0), (0, 0, 0.35 * t), (s, s, s))

    clip.node(star, at)
    return {}


# Chips: outward direction (degrees about Y from +Z), launch speed share and peak height.
CHIPS = [(20, 1.0, 0.42), (85, 0.8, 0.34), (150, 0.95, 0.4), (205, 0.85, 0.3), (265, 1.0, 0.38), (325, 0.75, 0.32)]


def slam(entry, col, root, clip):
    """A flat ring with a low shock lip on the ground, which grows and thins away, and six chips thrown up and out."""
    m = Mesh()
    n = 24
    inner, crest, outer = 0.64, 0.84, 0.95
    rows = []
    for k in range(n):
        a = 2 * math.pi * k / n
        c, s = math.cos(a), math.sin(a)
        rows.append([m.v((inner * s, 0.01, inner * c), 0.0), m.v((crest * s, 0.04, crest * c), 0.75),
                     m.v((outer * s, 0.02, outer * c), 0.0), m.v((crest * s, 0.16, crest * c), 0.0)])
    for k in range(n):
        a, b = rows[k], rows[(k + 1) % n]
        m.quad(a[0], b[0], b[1], a[1])
        m.quad(a[1], b[1], b[2], a[2])
        m.quad(a[1], b[1], b[3], a[3])
    ring = m.finish(f"{entry}.ring", col, bpy.data.materials[GLOW], root)
    crest_of = {}
    for ids in rows:
        for vid in ids:
            crest_of[vid] = ids[1]
    verts = m.verts
    thin_key(ring, lambda i, p: (verts[crest_of[i]][0], 0.04, verts[crest_of[i]][2]))

    def ring_at(t):
        s = 0.3 + 1.6 * ease_out(t)
        return ((0, 0, 0), (0, 0, 0), (s, 1 - 0.6 * t, s))

    clip.node(ring, ring_at)
    clip.weight(ring, lambda t: smooth((t - 0.1) / 0.9))
    for index, (heading, speed, peak) in enumerate(CHIPS):
        c = Mesh()
        size = 0.05 + 0.012 * (index % 3)
        pts = [(size, 0, 0), (-size * 0.6, 0, size * 0.8), (-size * 0.5, 0, -size * 0.8), (0, size * 1.1, 0)]
        ids = [c.v(p, 0.9) for p in pts]
        for a, b, d in ((0, 1, 2), (0, 3, 1), (1, 3, 2), (2, 3, 0)):
            c.tri(ids[a], ids[b], ids[d])
        chip = c.finish(f"{entry}.chip{index}", col, bpy.data.materials[DUST], root, white=0.85)
        h = math.radians(heading)
        direction = (math.sin(h), math.cos(h))

        def chip_at(t, direction=direction, speed=speed, peak=peak, index=index):
            out = 0.3 + 0.75 * speed * ease_out(t)
            y = 4 * peak * t * (1 - t)
            s = smooth(t / 0.12) * (1 - smooth((t - 0.7) / 0.3))
            spin = 7 * t * (1 if index % 2 else -1)
            return ((direction[0] * out, y, direction[1] * out), (spin, 0.5 * spin, 0), (s, s, s))

        clip.node(chip, chip_at)
    return {}


# Puffs: ground position, radius and start delay (share of the clip).
PUFFS = [((0.16, -0.1), 0.24, 0.0), ((-0.15, -0.14), 0.23, 0.04), ((0.34, -0.4), 0.3, 0.12), ((-0.32, -0.42), 0.29, 0.15), ((0.02, -0.66), 0.34, 0.22)]


def dust(entry, col, root, clip):
    """Five low, flattened dust puffs at and behind the feet, which bloom, drift back and dissipate."""
    for index, ((x, z), radius, delay) in enumerate(PUFFS):
        m = Mesh()
        sides = 6
        top = m.v((0, radius * 0.8, 0), 0.15)
        upper = [m.v((radius * 0.75 * math.cos(2 * math.pi * k / sides), radius * 0.45, radius * 0.75 * math.sin(2 * math.pi * k / sides)), 0.45) for k in range(sides)]
        lower = [m.v((radius * math.cos(2 * math.pi * (k + 0.5) / sides), radius * 0.05, radius * math.sin(2 * math.pi * (k + 0.5) / sides)), 0.6) for k in range(sides)]
        bottom = m.v((0, 0, 0), 0.4)
        for k in range(sides):
            j = (k + 1) % sides
            m.tri(top, upper[j], upper[k])
            m.quad(upper[k], upper[j], lower[k], lower[(k - 1) % sides])
            m.tri(bottom, lower[k], lower[j])
        puff = m.finish(f"{entry}.puff{index}", col, bpy.data.materials[DUST], root, origin=(x, 0, z), white=0.95)

        def puff_at(t, x=x, z=z, delay=delay):
            local = min(max((t - delay) / (1 - delay), 0.0), 1.0)
            s = (0.25 + 0.75 * ease_out(local / 0.5)) * (1 - ease_in((local - 0.45) / 0.55)) if local > 0 else 0.0
            return ((x * (1 + 0.5 * local), 0.12 * local, z - 0.22 * ease_out(local)), (0, 0.4 * local, 0), (s, s * (1 - 0.3 * local), s))

        clip.node(puff, puff_at)
    return {}


# Glint stars: ray length, cross-ray length, delay (share of the clip), peak scale and spin (radians over the clip).
GLINTS = [(0.46, 0.13, 0.0, 1.0, 0.7), (0.26, 0.09, 0.2, 0.85, -0.9)]


def glint(entry, col, root, clip):
    """A four-pointed star glint and a smaller, later twinkle beside it, each three crossed star planes about a bright
    core, so they read from any side. Both pop, turn a little and shrink to nothing: one cue as the follow-up opens."""
    for index, (ray, cross, delay, peak, spin) in enumerate(GLINTS):
        m = Mesh()
        core = [m.v(p, 1.0) for p in ((0.03, 0, 0), (-0.03, 0, 0), (0, 0.03, 0), (0, -0.03, 0), (0, 0, 0.03), (0, 0, -0.03))]
        for a, b in ((0, 2), (2, 1), (1, 3), (3, 0)):
            m.tri(core[a], core[b], core[4])
            m.tri(core[b], core[a], core[5])
        for plane in range(3):
            def at(u, v, plane=plane):
                return ((u, v, 0), (0, v, u), (u, 0, v))[plane]
            centre = m.v((0, 0, 0), 1.0)
            rim = []
            for k in range(8):
                a = 2 * math.pi * k / 8
                reach = (ray if plane == 0 else ray * 0.8) if k % 2 == 0 else cross * 0.35
                rim.append(m.v(at(reach * math.cos(a), reach * math.sin(a)), 0.0 if k % 2 == 0 else 0.5))
            for k in range(8):
                m.tri(centre, rim[k], rim[(k + 1) % 8])
        offset = (0, 0, 0) if index == 0 else (0.09, 0.11, 0.0)
        star = m.finish(f"{entry}.star{index}", col, bpy.data.materials[GLOW], root)

        def star_at(t, offset=offset, delay=delay, peak=peak, spin=spin):
            local = min(max((t - delay) / (1 - delay), 0.0), 1.0)
            if local <= 0:
                s = 0.0
            elif local < 0.3:
                s = peak * 1.15 * ease_out(local / 0.3)
            else:
                s = peak * (1.15 - 0.15 * smooth((local - 0.3) / 0.2)) * (1 - ease_in((local - 0.5) / 0.5))
            return (offset, (0, 0, spin * local), (s, s, s))

        clip.node(star, star_at)
    return {}


# ---------------------------------------------------------------- movement (#771)

def rock(m, size, alpha=0.95):
    """A small four-sided stone, flat-bottomed and pointed up."""
    pts = [(size, 0, 0), (-size * 0.6, 0, size * 0.8), (-size * 0.5, 0, -size * 0.8), (0, size * 1.1, 0)]
    ids = [m.v(p, alpha) for p in pts]
    for a, b, d in ((0, 1, 2), (0, 3, 1), (1, 3, 2), (2, 3, 0)):
        m.tri(ids[a], ids[b], ids[d])


def puff(m, radius, length=1.0):
    """A low dust puff, ``length`` times longer along Z, flat on the ground under its centre."""
    sides = 6
    ring = lambda r, y, a, k: m.v((r * math.cos(2 * math.pi * k / sides), y, r * length * math.sin(2 * math.pi * k / sides)), a)
    top = m.v((0, radius * 0.7, 0), 0.12)
    upper = [ring(radius * 0.75, radius * 0.42, 0.45, k) for k in range(sides)]
    lower = [ring(radius, radius * 0.05, 0.6, k + 0.5) for k in range(sides)]
    bottom = m.v((0, 0, 0), 0.4)
    for k in range(sides):
        j = (k + 1) % sides
        m.tri(top, upper[j], upper[k])
        m.quad(upper[k], upper[j], lower[k], lower[(k - 1) % sides])
        m.tri(bottom, lower[k], lower[j])


# Leap-slam cracks: heading (degrees about Y from +Z, the attacker's facing), length, and the share along the crack where
# a short branch splits off (0: none). The long cracks run ahead of the attacker.
CRACKS = [(0, 1.35, 0.5), (34, 1.05, 0.0), (-30, 1.15, 0.55), (88, 0.75, 0.0), (-95, 0.8, 0.45), (150, 0.55, 0.0), (-148, 0.6, 0.0)]
# Kinks across each crack, as a share of its length, at a third and two thirds of the way.
KINKS = [(0.06, -0.05), (-0.07, 0.04), (0.05, 0.06), (-0.04, -0.06)]
# Leap-slam stones: heading, throw distance (m) and peak height (m).
STONES = [(-12, 1.15, 0.62), (24, 0.95, 0.5), (60, 0.8, 0.44), (-58, 0.9, 0.55), (170, 0.55, 0.36)]


def leap_slam(entry, col, root, clip):
    """A dark crater and seven jagged cracks that split the ground ahead of the attacker, a billowing dust ring that
    rolls out from the landing and five stones thrown up and forward. The cracks snap open at once and thin away last."""
    m = Mesh()
    pair = {}

    def strip(points, widths, alpha):
        rows = []
        for i, ((x, z), w) in enumerate(zip(points, widths)):
            if i + 1 < len(points):
                dx, dz = points[i + 1][0] - x, points[i + 1][1] - z
            else:
                dx, dz = x - points[i - 1][0], z - points[i - 1][1]
            n = math.hypot(dx, dz)
            sx, sz = -dz / n * w, dx / n * w
            rows.append((m.v((x + sx, 0.006, z + sz), alpha), m.v((x - sx, 0.006, z - sz), alpha)))
        for a, b in zip(rows, rows[1:]):
            m.quad(a[0], b[0], b[1], a[1])
        for left, right in rows:
            pair[left], pair[right] = right, left

    crater = [m.v((0.3 * math.sin(2 * math.pi * k / 8), 0.004, 0.08 + 0.3 * math.cos(2 * math.pi * k / 8)), 0.0) for k in range(8)]
    middle = m.v((0, 0.004, 0.08), 0.8)
    for k in range(8):
        m.tri(middle, crater[k], crater[(k + 1) % 8])
    for index, (heading, length, branch) in enumerate(CRACKS):
        h = math.radians(heading)
        f, s = (math.sin(h), math.cos(h)), (math.cos(h), -math.sin(h))
        kink = KINKS[index % len(KINKS)]
        offsets = (0.0, kink[0], kink[1], 0.0)
        points = [(f[0] * length * u + s[0] * length * o, f[1] * length * u + s[1] * length * o) for u, o in zip((0.12, 0.42, 0.72, 1.0), offsets)]
        strip(points, (0.055, 0.04, 0.025, 0.004), 0.9)
        if branch:
            start = points[2]
            b = h + (0.7 if index % 2 else -0.7)
            strip([start, (start[0] + 0.3 * length * math.sin(b), start[1] + 0.3 * length * math.cos(b))], (0.02, 0.003), 0.85)
    cracks = m.finish(f"{entry}.cracks", col, bpy.data.materials[DUST], root, white=0.3)
    verts = m.verts
    # The crater collapses to its middle; every crack strip onto its centre line.
    thin_key(cracks, lambda i, p: verts[middle] if i in crater or i == middle else tuple((verts[i][k] + verts[pair[i]][k]) / 2 for k in range(3)))
    clip.node(cracks, lambda t: ((0, 0, 0), (0, 0, 0), (0.3 + 0.7 * ease_out(t / 0.12), 1, 0.3 + 0.7 * ease_out(t / 0.12))))
    clip.weight(cracks, lambda t: smooth((t - 0.5) / 0.5))

    d = Mesh()
    n = 14
    rows = []
    for k in range(n):
        a = 2 * math.pi * (k + 0.5) / n
        c, s = math.cos(a), math.sin(a)
        rows.append([d.v((0.5 * s, 0.02, 0.5 * c), 0.0), d.v((0.72 * s, 0.13, 0.72 * c), 0.55),
                     d.v((0.86 * s, 0.03, 0.86 * c), 0.0), d.v((0.66 * s, 0.42, 0.66 * c), 0.0)])
    for k in range(n):
        a, b = rows[k], rows[(k + 1) % n]
        d.quad(a[0], b[0], b[1], a[1])
        d.quad(a[1], b[1], b[2], a[2])
        d.quad(a[1], b[1], b[3], a[3])
    ring = d.finish(f"{entry}.dust", col, bpy.data.materials[DUST], root, white=0.95)
    crest_of = {vid: ids[1] for ids in rows for vid in ids}
    dverts = d.verts
    thin_key(ring, lambda i, p: dverts[crest_of[i]])

    def ring_at(t):
        r = 0.4 + 1.9 * ease_out(t)
        return ((0, 0, 0.15 * ease_out(t)), (0, 0, 0), (r, 0.6 + 1.2 * ease_out(t / 0.6), r))

    clip.node(ring, ring_at)
    clip.weight(ring, lambda t: smooth((t - 0.3) / 0.7))

    for index, (heading, reach, peak) in enumerate(STONES):
        c = Mesh()
        rock(c, 0.07 + 0.015 * (index % 3))
        stone = c.finish(f"{entry}.stone{index}", col, bpy.data.materials[DUST], root, white=0.6)
        h = math.radians(heading)

        def stone_at(t, h=h, reach=reach, peak=peak, index=index):
            flight = min(t / 0.8, 1.0)
            out = 0.25 + reach * flight
            s = smooth(t / 0.06) * (1 - smooth((t - 0.8) / 0.2))
            y = 4 * peak * flight * (1 - flight) + 0.12 * s  # a spinning stone never dips below the ground
            spin = 9 * flight * (1 if index % 2 else -1)
            return ((math.sin(h) * out, y, math.cos(h) * out), (spin, 0.4 * spin, 0), (s, s, s))

        clip.node(stone, stone_at)
    return {}


# Dash streaks: offset across (x), height and half-width (m), and how long the streak's tail lingers (share of the clip).
STREAKS = [(-0.2, 1.3, 0.07, 0.0), (0.22, 1.02, 0.065, 0.1), (-0.04, 1.6, 0.05, 0.16), (0.14, 0.62, 0.06, 0.06), (-0.26, 0.42, 0.05, 0.2)]
DASH_LENGTH = 1.0


def dash_trail(entry, col, root, clip):
    """Five pale speed streaks along the dash, from z = 0 (where the dash starts) to z = 1 (where it ends): each streak's
    head runs ahead with the dasher and its tail follows it in, so the streak stretches out and closes up at the end."""
    for index, (x, y, width, linger) in enumerate(STREAKS):
        m = Mesh()
        rows = []
        segments = 3
        for i in range(segments + 1):
            u = i / segments  # 0 at the tail, 1 at the head
            a = 0.45 * u ** 1.3
            w = width * (0.35 + 0.65 * u)
            rows.append([m.v((0, 0, u), a), m.v((w, 0, u), 0.0), m.v((-w, 0, u), 0.0), m.v((0, w, u), 0.0), m.v((0, -w, u), 0.0)])
        for a, b in zip(rows, rows[1:]):
            for edge in (1, 2, 3, 4):
                m.quad(a[0], a[edge], b[edge], b[0])
        streak = m.finish(f"{entry}.streak{index}", col, bpy.data.materials[GLOW], root)

        def streak_at(t, x=x, y=y, linger=linger):
            head = ease_out(t / 0.7)
            tail = ease_in((t - 0.12 - linger * 0.5) / (0.88 - linger * 0.5))
            fade = 1 - 0.5 * ease_in(t)
            return ((x, y, DASH_LENGTH * tail), (0, 0, 0), (fade, fade, max(DASH_LENGTH * (head - tail), 0.0)))

        clip.node(streak, streak_at)
    return {"length": DASH_LENGTH}


# Dash dust: puff position (x, z), radius, length along Z and start delay; grit: heading (degrees from +Z), distance, peak.
DASH_PUFFS = [((0.06, -0.06), 0.2, 1.5, 0.0), ((-0.1, -0.2), 0.24, 1.7, 0.08), ((0.04, -0.42), 0.28, 1.6, 0.18)]
GRIT = [(160, 0.7, 0.22), (195, 0.85, 0.28), (140, 0.5, 0.16), (220, 0.6, 0.2), (180, 0.95, 0.3)]


def dash_dust(entry, col, root, clip):
    """Three stretched dust puffs kicked back from the start foot and five grit chips flicked back behind it."""
    for index, ((x, z), radius, length, delay) in enumerate(DASH_PUFFS):
        m = Mesh()
        puff(m, radius, length)
        cloud = m.finish(f"{entry}.puff{index}", col, bpy.data.materials[DUST], root, white=0.95)

        def puff_at(t, x=x, z=z, delay=delay):
            local = clamp01((t - delay) / (1 - delay))
            s = (0.3 + 0.7 * ease_out(local / 0.4)) * (1 - ease_in((local - 0.4) / 0.6)) if local > 0 else 0.0
            return ((x, 0.06 * local, z - 0.4 * ease_out(local)), (0, 0, 0), (s, s * (1 - 0.35 * local), s * (1 + 0.4 * local)))

        clip.node(cloud, puff_at)
    for index, (heading, reach, peak) in enumerate(GRIT):
        c = Mesh()
        rock(c, 0.03 + 0.008 * (index % 2), 0.9)
        grit = c.finish(f"{entry}.grit{index}", col, bpy.data.materials[DUST], root, white=0.65)
        h = math.radians(heading)

        def grit_at(t, h=h, reach=reach, peak=peak, index=index):
            flight = min(t / 0.75, 1.0)
            out = 0.05 + reach * ease_out(flight)
            s = smooth(t / 0.05) * (1 - smooth((t - 0.7) / 0.3))
            return ((math.sin(h) * out, 4 * peak * flight * (1 - flight) + 0.045 * s, math.cos(h) * out), (8 * flight, 0, 3 * flight * (1 if index % 2 else -1)), (s, s, s))

        clip.node(grit, grit_at)
    return {}


BUILDERS = {"strike-arc-cut": arc, "strike-arc-heavy": arc, "cleave-sweep": arc, "combo-glint": glint, "strike-thrust": thrust, "impact-burst": burst, "ground-slam": slam, "lunge-dust": dust,
            "leap-slam": leap_slam, "dash-trail": dash_trail, "dash-dust": dash_dust}


def build(entry, collection, location=(0, 0, 0)):
    """Build one entry under an empty root ``strike-effects.<entry>`` at ``location`` (glTF axes), with its clip."""
    if entry not in BUILDERS:
        raise ValueError(f"strike-effects entry must be one of {', '.join(ENTRIES)}")
    for name in (GLOW, DUST):
        if name not in bpy.data.materials:
            material(name)
    root = node(f"strike-effects.{entry}", collection, None, location)
    clip = Clip(CLIP_SECONDS[entry])
    info = BUILDERS[entry](entry, collection, root, clip)
    info["clip"] = clip.finish()
    return root, info


def clip_bounds(scene, objects, frames):
    """The glTF-axes box every frame of the clip stays inside, with morphs applied, relative to the root."""
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for f in range(frames + 1):
        scene.frame_set(f)
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for obj in objects:
            if obj.type != "MESH":
                continue
            evaluated = obj.evaluated_get(depsgraph)
            mesh = evaluated.to_mesh()
            for vert in mesh.vertices:
                p = evaluated.matrix_world @ vert.co
                for k, value in enumerate((p.x, p.z, -p.y)):
                    lo[k], hi[k] = min(lo[k], value), max(hi[k], value)
            evaluated.to_mesh_clear()
    clean = lambda v: [round(x, 4) + 0.0 for x in v]
    return {"min": clean(lo), "max": clean(hi)}


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or set(arguments) != {"schemaVersion", "entry"}:
        raise ValueError("strike-effects arguments must be {schemaVersion: 1, entry}")
    if arguments["entry"] not in ENTRIES:
        raise ValueError(f"strike-effects entry must be one of {', '.join(ENTRIES)}")
    if set(inputs):
        raise ValueError("strike-effects recipe takes no inputs")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = CLIP_FPS, 1.0
    entry = arguments["entry"]
    root, info = build(entry, scene.collection)
    objects = [root] + list(root.children_recursive)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    triangles = sum(len(p.vertices) - 2 for o in objects if o.type == "MESH" for p in o.data.polygons)
    if triangles > TRIANGLE_BUDGET:
        raise ValueError(f"{entry} has {triangles} triangles, over {TRIANGLE_BUDGET}")
    scene.frame_start, scene.frame_end = 0, round(CLIP_SECONDS[entry] * CLIP_FPS)
    info["clipBounds"] = clip_bounds(scene, objects, round(CLIP_SECONDS[entry] * CLIP_FPS))
    scene.frame_set(0)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=False, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False, export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True,
        export_skins=False, export_morph=True, export_morph_normal=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "entry": entry, "unit": "meter", "axes": "right-handed-y-up", "align": ALIGN[entry],
            "triangleCount": triangles, **info}
