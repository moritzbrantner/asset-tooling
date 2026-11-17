"""Spell effect meshes (docs/spell-effects.md, #726): school bolts, impacts, a frost nova, a beam segment, heal motes,
and proper arrow, crossbow-bolt and throwing-knife models.

``bolt-<school>`` are looping projectile heads with a crossed-plane tail; ``impact-<school>`` are short bursts that end
gone; ``frost-nova`` is a ring of ice spikes that bursts out to 8 m and sinks; ``beam-segment`` is a one-metre tileable
beam piece with a ``Crackle`` morph; ``heal-motes`` are soft motes that rise around a target. Each is one glTF scene
whose nodes (and, for the tails and the beam, one morph target) are animated by one clip: ``Loop`` for the bolts and the
beam, ``Play`` for the rest. ``arrow``, ``crossbow-bolt`` and ``throwing-knife`` are static, opaque models.

Colour and opacity are per vertex (``COLOR_0``, RGBA). The vertex colour only shades within a hue (white is the
material's own colour), so a game recolours an entry through its material's base and emissive colours. The spell
materials are core glTF, blended, double-sided and emissive, one per school (``spell-fire``, ``spell-shadow``,
``spell-holy``, ``spell-nature``, ``spell-frost``), plus ``spell-fel`` for the shadow bolt's green wisps and
``spell-energy`` (a pale neutral glow) for the beam and the motes, which a game tints per spell. ``shot`` is one opaque
material whose vertex colours give wood, steel, leather and feathers.

Authored in glTF axes, metres, at the game's projectile scale. Bolts and shots have their origin at the tip with +Z
forward (the body trails back along -Z); impacts sit at the hit point; the nova and the motes sit on the ground at the
caster or target (+Y up); the beam runs from z = 0 to z = 1.

``arguments`` are ``{schemaVersion: 1, entry}``. No randomness: every direction and offset is a fixed table.
``build(entry, collection)`` also works in a live Blender session.
"""
import math

import bpy
from bpy_extras import anim_utils
from mathutils import Vector

RECIPE = "spell-effects-v1"
SCHOOLS = ("fire", "shadow", "holy", "nature", "frost")
ENTRIES = (
    "bolt-fire", "bolt-shadow", "bolt-holy", "bolt-nature",
    "impact-fire", "impact-shadow", "impact-holy", "impact-nature", "impact-frost",
    "arrow", "crossbow-bolt", "throwing-knife",
    "frost-nova", "beam-segment", "heal-motes",
)
CLIP_FPS = 100  # whole frames for every clip length below
# Entry: (clip name, seconds); the shots have no clip.
CLIPS = {
    "bolt-fire": ("Loop", 0.4), "bolt-shadow": ("Loop", 0.6), "bolt-holy": ("Loop", 0.5), "bolt-nature": ("Loop", 0.6),
    "impact-fire": ("Play", 0.35), "impact-shadow": ("Play", 0.4), "impact-holy": ("Play", 0.4), "impact-nature": ("Play", 0.45),
    "impact-frost": ("Play", 0.35), "frost-nova": ("Play", 0.5), "beam-segment": ("Loop", 0.24), "heal-motes": ("Play", 0.8),
}
ALIGN = {
    **{e: "tip" for e in ("bolt-fire", "bolt-shadow", "bolt-holy", "bolt-nature", "arrow", "crossbow-bolt", "throwing-knife")},
    **{f"impact-{s}": "hit" for s in SCHOOLS},
    "frost-nova": "ground", "heal-motes": "ground", "beam-segment": "beam",
}
TRIANGLE_BUDGET = 240
NOVA_RADIUS = 8.0  # Frost Nova's 800-unit radius in mmorpg
BEAM_LENGTH = 1.0

# sRGB material colours. The spell vertex colours stay at or below white, so these are each school's brightest hue.
COLOURS = {
    "spell-fire": (1.0, 0.66, 0.3), "spell-shadow": (0.7, 0.42, 1.0), "spell-fel": (0.6, 1.0, 0.42),
    "spell-holy": (1.0, 0.88, 0.55), "spell-nature": (0.62, 1.0, 0.42), "spell-frost": (0.7, 0.9, 1.0),
    "spell-energy": (0.86, 0.93, 1.0), "shot": (1.0, 1.0, 1.0),
}
SHOT = "shot"

# Vertex colours of the shots (sRGB).
WOOD, DARK_WOOD, STEEL, DARK_STEEL = (0.66, 0.5, 0.32), (0.4, 0.27, 0.17), (0.66, 0.69, 0.72), (0.36, 0.38, 0.41)
LEATHER, FEATHER, COCK_FEATHER = (0.28, 0.19, 0.13), (0.86, 0.84, 0.78), (0.72, 0.16, 0.12)


def to_blender(point):
    """A glTF (+Y up) point in Blender's +Z-up frame."""
    x, y, z = point
    return Vector((x, -z, y))


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def clamp01(t):
    return min(max(t, 0.0), 1.0)


def smooth(t):
    t = clamp01(t)
    return t * t * (3 - 2 * t)


def ease_out(t):
    return 1 - (1 - clamp01(t)) ** 3


def ease_in(t):
    t = clamp01(t)
    return t * t


def pulse(t, cycles=1):
    """0 at both ends of the loop, 1 halfway through each cycle."""
    return 0.5 - 0.5 * math.cos(2 * math.pi * cycles * t)


# ---------------------------------------------------------------- materials

def material(name):
    """A core-glTF material whose base colour is multiplied by the vertex colour (COLOR_0); spell materials are
    blended, double-sided and emissive, and take their alpha from the vertex alpha; ``shot`` is opaque."""
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
    linear = tuple(srgb_to_linear(c) for c in COLOURS[name]) + (1.0,)
    tint.inputs[6].default_value = linear
    links.new(attr.outputs["Color"], tint.inputs[7])
    links.new(tint.outputs[2], bsdf.inputs["Base Color"])
    links.new(bsdf.outputs[0], out.inputs[0])
    mat.use_backface_culling = False
    if name == SHOT:
        bsdf.inputs["Roughness"].default_value = 0.6
        bsdf.inputs["Metallic"].default_value = 0.0
        return mat
    bsdf.inputs["Roughness"].default_value = 1.0
    links.new(attr.outputs["Alpha"], bsdf.inputs["Alpha"])
    bsdf.inputs["Emission Color"].default_value = linear
    bsdf.inputs["Emission Strength"].default_value = 1.0
    try:
        mat.surface_render_method = "BLENDED"
    except (AttributeError, TypeError):
        mat.blend_method = "BLEND"
    return mat


# ---------------------------------------------------------------- geometry

class Mesh:
    """Triangles in glTF axes with a per-vertex sRGB colour and alpha."""

    def __init__(self):
        self.verts, self.colours, self.faces = [], [], []

    def v(self, point, alpha=1.0, rgb=(1.0, 1.0, 1.0)):
        self.verts.append(tuple(point))
        self.colours.append((*rgb, alpha))
        return len(self.verts) - 1

    def tri(self, a, b, c):
        self.faces.append((a, b, c))

    def quad(self, a, b, c, d):
        self.tri(a, b, c)
        self.tri(a, c, d)

    def finish(self, name, collection, mat, parent=None, origin=(0, 0, 0)):
        mesh = bpy.data.meshes.new(name)
        o = Vector(origin)
        mesh.from_pydata([to_blender(Vector(p) - o) for p in self.verts], [], self.faces)
        mesh.materials.append(bpy.data.materials[mat])
        layer = mesh.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
        for poly in mesh.polygons:
            poly.use_smooth = mat == SHOT
            for li in poly.loop_indices:
                r, g, b, a = self.colours[mesh.loops[li].vertex_index]
                layer.data[li].color = (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), a)
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


def morph(obj, name, target):
    """Add one morph target: every vertex moves to ``target(index, point)`` (glTF axes, mesh-local)."""
    obj.shape_key_add(name="Basis")
    key = obj.shape_key_add(name=name)
    for i, vert in enumerate(obj.data.vertices):
        p = vert.co
        key.data[i].co = to_blender(target(i, (p.x, p.z, -p.y)))
    return key


def ball(m, centre, radius, alpha, rgb=(1, 1, 1), rim_alpha=None, stretch=1.0, rings=2, sides=6):
    """A low sphere about ``centre``, ``stretch`` times longer along Z; its poles carry ``alpha``, its equator
    ``rim_alpha`` (default the same), so a shell can be bright at its ends and soft at its sides."""
    rim_alpha = alpha if rim_alpha is None else rim_alpha
    cx, cy, cz = centre
    front = m.v((cx, cy, cz + radius * stretch), alpha, rgb)
    back = m.v((cx, cy, cz - radius * stretch), alpha, rgb)
    bands = []
    for r in range(1, rings + 1):
        phi = math.pi * r / (rings + 1)
        ring_r, z = radius * math.sin(phi), radius * stretch * math.cos(phi)
        offset = 0.5 * (r % 2)
        bands.append([m.v((cx + ring_r * math.cos(2 * math.pi * (k + offset) / sides), cy + ring_r * math.sin(2 * math.pi * (k + offset) / sides), cz + z), rim_alpha, rgb) for k in range(sides)])
    for k in range(sides):
        j = (k + 1) % sides
        m.tri(front, bands[0][k], bands[0][j])
        m.tri(back, bands[-1][j], bands[-1][k])
    for a, b in zip(bands, bands[1:]):
        for k in range(sides):
            j = (k + 1) % sides
            m.quad(a[k], b[k], b[j], a[j])


def spike(m, base, direction, length, width, base_alpha, tip_alpha, rgb=(1, 1, 1), tip_rgb=None, sides=3):
    """A thin pyramid from ``base`` along ``direction``."""
    d = Vector(direction).normalized()
    side = d.cross(Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))).normalized()
    other = d.cross(side)
    b = Vector(base)
    ring = [m.v(b + width * (math.cos(2 * math.pi * k / sides) * side + math.sin(2 * math.pi * k / sides) * other), base_alpha, rgb) for k in range(sides)]
    tip = m.v(b + d * length, tip_alpha, tip_rgb or rgb)
    for k in range(sides):
        m.tri(ring[k], ring[(k + 1) % sides], tip)
    return ring, tip


def tail(m, length, width, alpha, z0=0.0, segments=4, rgb=(1, 1, 1)):
    """Two crossed planes trailing back from ``z0`` along -Z, bright on their axis and fading to their edges and their
    end. Returns the per-segment vertex rows, so a morph can sway them."""
    rows = []
    for i in range(segments + 1):
        u = i / segments
        z = z0 - length * u
        w = width * (1 - 0.8 * u)
        a = alpha * (1 - u) ** 1.3
        rows.append([m.v((0, 0, z), a, rgb), m.v((w, 0, z), 0.0, rgb), m.v((-w, 0, z), 0.0, rgb), m.v((0, w, z), 0.0, rgb), m.v((0, -w, z), 0.0, rgb)])
    for a, b in zip(rows, rows[1:]):
        for edge in (1, 2, 3, 4):
            m.quad(a[0], a[edge], b[edge], b[0])
    return rows


def leaf(m, centre, along, across, length, width, alpha, rgb):
    """A flat leaf: a diamond with a raised midrib, four triangles."""
    c, a, s = Vector(centre), Vector(along).normalized(), Vector(across).normalized()
    up = a.cross(s).normalized()
    stem = m.v(c - a * length * 0.5, alpha, rgb)
    point = m.v(c + a * length * 0.5, alpha * 0.6, rgb)
    left = m.v(c + s * width * 0.5, alpha * 0.8, rgb)
    right = m.v(c - s * width * 0.5, alpha * 0.8, rgb)
    rib = m.v(c + up * width * 0.12, alpha, (1, 1, 1))
    m.tri(stem, left, rib)
    m.tri(rib, left, point)
    m.tri(stem, rib, right)
    m.tri(rib, point, right)


# ---------------------------------------------------------------- animation

class Clip:
    """One action with a slot per animated node or shape-key block, sampled every frame."""

    def __init__(self, name, seconds):
        self.name = name
        self.action = bpy.data.actions.new(name)
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

    def weight(self, obj, name, at):
        """``at(t)`` gives the morph weight of ``name``."""
        keys = obj.data.shape_keys
        self._slot(keys, "KEY")
        block = keys.key_blocks[name]
        for f in range(self.frames + 1):
            block.value = clamp01(at(f / self.frames))
            block.keyframe_insert("value", frame=f)

    def finish(self, loop):
        for slot in self.action.slots:
            bag = anim_utils.action_get_channelbag_for_slot(self.action, slot)
            for fc in bag.fcurves:
                for k in fc.keyframe_points:
                    k.interpolation = "LINEAR"
        return {"name": self.name, "duration": round(self.frames / CLIP_FPS, 6), "loop": loop}


STILL = ((0, 0, 0), (0, 0, 0), (1, 1, 1))
TAU = 2 * math.pi


def sway_tail(obj, rows, clip, name="Flicker", amount=0.06):
    """A morph that bends the tail sideways, more towards its end, played as a loop."""
    shift = {}
    for i, ids in enumerate(rows):
        u = i / (len(rows) - 1)
        for vid in ids:
            shift[vid] = (amount * u * u * (1 if i % 2 else 0.6), amount * 0.6 * u * (-1 if i % 2 else 1))
    morph(obj, name, lambda i, p: (p[0] + shift.get(i, (0, 0))[0], p[1] + shift.get(i, (0, 0))[1], p[2]))
    clip.weight(obj, name, lambda t: pulse(t, 2))


# ---------------------------------------------------------------- bolts

def bolt_fire(entry, col, root, clip):
    """A tumbling flame head (a hot core in a shell of back-swept tongues) and a flickering tail."""
    head = node(f"{entry}.head", col, root, (0, 0, -0.12))
    core = Mesh()
    ball(core, (0, 0, 0), 0.075, 1.0, (1.0, 1.0, 0.85), stretch=1.2)
    core.finish(f"{entry}.core", col, "spell-fire", head)
    flame = Mesh()
    for k in range(8):
        a = TAU * k / 8
        out = (math.cos(a), math.sin(a), -1.6 - 0.4 * (k % 2))
        spike(flame, (0.03 * math.cos(a), 0.03 * math.sin(a), 0.05), out, 0.22 + 0.05 * (k % 3), 0.04, 0.8, 0.0, (1.0, 0.9, 0.6), (0.9, 0.35, 0.15))
    ball(flame, (0, 0, -0.01), 0.11, 0.3, (1.0, 0.7, 0.4), rim_alpha=0.08, stretch=1.1)
    shell = flame.finish(f"{entry}.flame", col, "spell-fire", head)
    m = Mesh()
    rows = tail(m, 0.6, 0.09, 0.8, z0=-0.1, rgb=(1.0, 0.6, 0.3))
    trail = m.finish(f"{entry}.tail", col, "spell-fire", root)
    sway_tail(trail, rows, clip, amount=0.07)
    clip.node(shell, lambda t: ((0, 0, 0), (0.15 * math.sin(TAU * t), 0.15 * math.cos(TAU * t), TAU * t), (1 + 0.12 * pulse(t, 2),) * 3))
    clip.node(trail, lambda t: ((0, 0, 0), (0, 0, -TAU * t), (1, 1, 0.85 + 0.25 * pulse(t, 2))))
    return {}


def bolt_shadow(entry, col, root, clip):
    """A violet orb wrapped in two green wisps that wind about it, and a dark violet tail."""
    orb = node(f"{entry}.orb", col, root, (0, 0, -0.12))
    m = Mesh()
    ball(m, (0, 0, 0), 0.07, 1.0, (0.85, 0.7, 1.0))
    ball(m, (0, 0, 0), 0.115, 0.5, (0.6, 0.4, 0.9), rim_alpha=0.2, rings=2, sides=8)
    sphere = m.finish(f"{entry}.sphere", col, "spell-shadow", orb)
    w = Mesh()
    for strand in range(2):
        rows = []
        for i in range(9):
            u = i / 8
            a = TAU * (strand / 2 + 0.9 * u)
            r = 0.13 + 0.03 * u
            z = 0.05 - 0.42 * u
            width = 0.035 * (1 - u) + 0.006
            alpha = 0.95 * (1 - u) ** 1.2
            c = Vector((r * math.cos(a), r * math.sin(a), z))
            radial = Vector((math.cos(a), math.sin(a), 0))
            rows.append([w.v(c + radial * width, alpha), w.v(c - radial * width, alpha * 0.5)])
        for a, b in zip(rows, rows[1:]):
            w.quad(a[0], b[0], b[1], a[1])
    wisps = w.finish(f"{entry}.wisps", col, "spell-fel", orb)
    t_mesh = Mesh()
    rows = tail(t_mesh, 0.5, 0.08, 0.7, z0=-0.12, rgb=(0.7, 0.5, 0.9))
    trail = t_mesh.finish(f"{entry}.tail", col, "spell-shadow", root)
    sway_tail(trail, rows, clip, amount=0.05)
    clip.node(sphere, lambda t: ((0, 0, 0), (0, 0, -TAU * t), (1 + 0.1 * pulse(t, 2),) * 3))
    clip.node(wisps, lambda t: ((0, 0, 0), (0, 0, TAU * t), (1, 1, 1)))
    return {}


def bolt_holy(entry, col, root, clip):
    """A gold core with a star of white rays that turns and breathes, and a pale gold tail."""
    star = node(f"{entry}.star", col, root, (0, 0, -0.12))
    m = Mesh()
    ball(m, (0, 0, 0), 0.08, 1.0, (1.0, 0.82, 0.45))
    core = m.finish(f"{entry}.core", col, "spell-holy", star)
    r = Mesh()
    for k in range(6):
        a = TAU * k / 6
        spike(r, (0, 0, 0), (math.cos(a), math.sin(a), -0.25), 0.26 if k % 2 else 0.19, 0.022, 1.0, 0.0)
    for x, y in ((0.4, 0.3), (-0.4, -0.3)):
        spike(r, (0, 0, 0), (x, y, -1), 0.3, 0.02, 0.9, 0.0)
    rays = r.finish(f"{entry}.rays", col, "spell-holy", star)
    t_mesh = Mesh()
    rows = tail(t_mesh, 0.55, 0.07, 0.75, z0=-0.12)
    trail = t_mesh.finish(f"{entry}.tail", col, "spell-holy", root)
    sway_tail(trail, rows, clip, amount=0.03)
    clip.node(rays, lambda t: ((0, 0, 0), (0, 0, TAU * t), (1 + 0.15 * pulse(t, 2),) * 3))
    clip.node(core, lambda t: ((0, 0, 0), (0, 0, 0), (1 + 0.12 * pulse(t, 2),) * 3))
    return {}


def bolt_nature(entry, col, root, clip):
    """A green seed of light with three leaves spinning about it, and a pale green tail."""
    seed = node(f"{entry}.seed", col, root, (0, 0, -0.135))
    m = Mesh()
    ball(m, (0, 0, 0), 0.055, 1.0, (0.95, 1.0, 0.8), stretch=1.5)
    ball(m, (0, 0, 0), 0.095, 0.4, (0.7, 1.0, 0.55), rim_alpha=0.15, stretch=1.2)
    glow = m.finish(f"{entry}.glow", col, "spell-nature", seed)
    l = Mesh()
    for k in range(3):
        a = TAU * k / 3
        radial = Vector((math.cos(a), math.sin(a), 0))
        tangent = Vector((-math.sin(a), math.cos(a), 0))
        leaf(l, radial * 0.14 + Vector((0, 0, -0.03)), tangent + Vector((0, 0, -0.5)), Vector((0, 0, 1)) + radial * 0.3, 0.13, 0.06, 0.95, (0.55, 0.85, 0.35))
    leaves = l.finish(f"{entry}.leaves", col, "spell-nature", seed)
    t_mesh = Mesh()
    rows = tail(t_mesh, 0.5, 0.06, 0.7, z0=-0.135, rgb=(0.8, 1.0, 0.7))
    trail = t_mesh.finish(f"{entry}.tail", col, "spell-nature", root)
    sway_tail(trail, rows, clip, amount=0.05)
    clip.node(leaves, lambda t: ((0, 0, 0), (0, 0, TAU * 2 * t), (1, 1, 1)))
    clip.node(glow, lambda t: ((0, 0, 0), (0, 0, 0), (1 + 0.15 * pulse(t, 3),) * 3))
    return {}


# ---------------------------------------------------------------- impacts

def flash(m, radius, alpha, rgb=(1, 1, 1), points=8, inner=0.45):
    """A flat star facing +Z, bright at its centre."""
    centre = m.v((0, 0, 0), alpha, rgb)
    rim = []
    for k in range(points * 2):
        a = TAU * k / (points * 2)
        reach = radius if k % 2 == 0 else radius * inner
        rim.append(m.v((reach * math.cos(a), reach * math.sin(a), 0), 0.0, rgb))
    for k in range(len(rim)):
        m.tri(centre, rim[k], rim[(k + 1) % len(rim)])


def pop(t, peak=0.25, rise=1.15):
    """Scale that pops past full size, settles and shrinks to nothing by the end."""
    if t < peak:
        return 0.2 + (rise - 0.2) * ease_out(t / peak)
    return rise * (1 - ease_in((t - peak) / (1 - peak)))


def impact_fire(entry, col, root, clip):
    """Flame tongues thrown out and up from a hot flash."""
    m = Mesh()
    flash(m, 0.35, 1.0, (1.0, 0.95, 0.75))
    flare = m.finish(f"{entry}.flash", col, "spell-fire", root)
    t = Mesh()
    ball(t, (0, 0, 0), 0.12, 1.0, (1.0, 0.95, 0.7))
    for k, (x, y, z, length) in enumerate(((0, 1, 0, 0.55), (0.8, 0.7, 0.2, 0.45), (-0.8, 0.7, -0.1, 0.45), (0.5, 0.4, -0.8, 0.4), (-0.5, 0.5, 0.8, 0.4),
                                           (1, 0.1, 0, 0.35), (-1, 0.15, 0.2, 0.35), (0.2, 0.3, 1, 0.3), (-0.2, 0.3, -1, 0.35), (0, -1, 0, 0.2))):
        spike(t, (0, 0, 0), (x, y, z), length, 0.06, 1.0, 0.0, (1.0, 0.8, 0.5), (0.85, 0.3, 0.12))
    tongues = t.finish(f"{entry}.tongues", col, "spell-fire", root)
    clip.node(flare, lambda t: ((0, 0, 0), (0, 0, 0.8 * t), (pop(t, 0.15, 1.3),) * 3))
    clip.node(tongues, lambda t: ((0, 0.25 * ease_out(t), 0), (0, 1.2 * t, 0), (pop(t, 0.3),) * 3))
    return {}


def impact_shadow(entry, col, root, clip):
    """A violet shell that swells and collapses inward, with green sparks thrown out."""
    m = Mesh()
    ball(m, (0, 0, 0), 0.32, 0.08, (0.6, 0.4, 0.9), rim_alpha=0.25, rings=3, sides=8)
    ball(m, (0, 0, 0), 0.1, 1.0, (0.9, 0.8, 1.0))
    shell = m.finish(f"{entry}.shell", col, "spell-shadow", root)
    s = Mesh()
    for k in range(8):
        a = TAU * k / 8
        spike(s, (0.12 * math.cos(a), 0.12 * math.sin(a), 0), (math.cos(a), math.sin(a), 0.4 * (-1) ** k), 0.3, 0.025, 1.0, 0.0)
    sparks = s.finish(f"{entry}.sparks", col, "spell-fel", root)

    def shell_at(t):
        s = 0.3 + 0.9 * ease_out(t / 0.35) if t < 0.35 else 1.2 * (1 - ease_in((t - 0.35) / 0.65))
        return ((0, 0, 0), (0, -1.5 * t, 0), (s, s, s))

    clip.node(shell, shell_at)
    clip.node(sparks, lambda t: ((0, 0, 0), (0, 0, 1.5 * t), ((0.4 + 1.2 * ease_out(t)) * (1 - smooth((t - 0.5) / 0.5)),) * 3))
    return {}


def impact_holy(entry, col, root, clip):
    """A gold flash star and a column of light that rises and narrows away."""
    m = Mesh()
    flash(m, 0.45, 1.0, points=6, inner=0.3)
    flash_obj = m.finish(f"{entry}.flash", col, "spell-holy", root)
    c = Mesh()
    rows = []
    for i, (y, w, a) in enumerate(((-0.2, 0.14, 0.0), (0.0, 0.16, 1.0), (0.6, 0.12, 0.7), (1.4, 0.06, 0.0))):
        rows.append([c.v((0, y, 0), a), c.v((w, y, 0), 0.0), c.v((-w, y, 0), 0.0), c.v((0, y, w), 0.0), c.v((0, y, -w), 0.0)])
    for a, b in zip(rows, rows[1:]):
        for edge in (1, 2, 3, 4):
            c.quad(a[0], a[edge], b[edge], b[0])
    column = c.finish(f"{entry}.column", col, "spell-holy", root)
    r = Mesh()
    for k in range(6):
        a = TAU * k / 6 + 0.3
        spike(r, (0, 0, 0), (math.cos(a), 0.3, math.sin(a)), 0.4, 0.03, 1.0, 0.0)
    rays = r.finish(f"{entry}.rays", col, "spell-holy", root)
    clip.node(flash_obj, lambda t: ((0, 0, 0), (0, 0, 0.5 * t), (pop(t, 0.15, 1.2),) * 3))
    clip.node(column, lambda t: ((0, 0, 0), (0, 0, 0), ((1 - ease_in(t)) * 1.0, 0.4 + 0.8 * ease_out(t), (1 - ease_in(t)))))
    clip.node(rays, lambda t: ((0, 0, 0), (0, 0.8 * t, 0), (pop(t, 0.25),) * 3))
    return {}


# Leaves thrown out by a nature hit: direction and spin.
LEAVES = [((1, 0.6, 0.2), 9), ((-0.9, 0.7, -0.3), -8), ((0.3, 0.8, -1), 10), ((-0.2, 0.9, 1), -9), ((0.9, 0.2, -0.8), 7), ((-0.8, 0.3, 0.9), -7)]


def impact_nature(entry, col, root, clip):
    """A green flash and six leaves thrown up and out, spinning and shrinking."""
    m = Mesh()
    flash(m, 0.32, 1.0, (0.95, 1.0, 0.8), points=5, inner=0.4)
    ball(m, (0, 0, 0), 0.09, 0.9, (0.95, 1.0, 0.85))
    glow = m.finish(f"{entry}.flash", col, "spell-nature", root)
    clip.node(glow, lambda t: ((0, 0, 0), (0, 0, 0.6 * t), (pop(t, 0.2, 1.25),) * 3))
    for index, (direction, spin) in enumerate(LEAVES):
        l = Mesh()
        leaf(l, (0, 0, 0), (1, 0, 0), (0, 0, 1), 0.16, 0.08, 1.0, (0.55, 0.85, 0.35))
        obj = l.finish(f"{entry}.leaf{index}", col, "spell-nature", root)
        d = Vector(direction).normalized()

        def at(t, d=d, spin=spin):
            out = 0.05 + 0.6 * ease_out(t)
            s = smooth(t / 0.1) * (1 - smooth((t - 0.6) / 0.4))
            return (tuple(d * out + Vector((0, -0.25 * t * t, 0))), (spin * t, 0.5 * spin * t, 0.3 * spin * t), (s, s, s))

        clip.node(obj, at)
    return {}


# Ice shards of a frost hit: direction and length.
SHARDS = [((0, 1, 0), 0.4), ((0.9, 0.5, 0.1), 0.34), ((-0.9, 0.5, -0.1), 0.34), ((0.4, 0.3, 0.9), 0.3), ((-0.4, 0.3, -0.9), 0.3),
          ((0.6, -0.4, -0.7), 0.26), ((-0.6, -0.4, 0.7), 0.26), ((1, -0.2, 0.6), 0.24), ((-1, -0.1, -0.5), 0.24)]


def impact_frost(entry, col, root, clip):
    """A pale flash and a burst of four-sided ice shards that snap out and shrink."""
    m = Mesh()
    flash(m, 0.3, 1.0, points=6, inner=0.35)
    glow = m.finish(f"{entry}.flash", col, "spell-frost", root)
    s = Mesh()
    for direction, length in SHARDS:
        spike(s, (0, 0, 0), direction, length, 0.04, 0.95, 0.5, (0.75, 0.88, 1.0), (1, 1, 1), sides=4)
    shards = s.finish(f"{entry}.shards", col, "spell-frost", root)
    clip.node(glow, lambda t: ((0, 0, 0), (0, 0, 0), (pop(t, 0.15, 1.2),) * 3))
    clip.node(shards, lambda t: ((0, 0, 0), (0, 0.4 * t, 0), (pop(t, 0.2, 1.1),) * 3))
    return {}


# ---------------------------------------------------------------- shots

def shaft(m, z0, z1, radius, rgb, sides=6):
    """An open prism along Z from z0 back to z1, returning its end rings."""
    rings = [[m.v((radius * math.cos(TAU * (k + 0.5) / sides), radius * math.sin(TAU * (k + 0.5) / sides), z), 1.0, rgb) for k in range(sides)] for z in (z0, z1)]
    for k in range(sides):
        j = (k + 1) % sides
        m.quad(rings[0][k], rings[1][k], rings[1][j], rings[0][j])
    return rings


def cap(m, ring, point, rgb):
    centre = m.v(point, 1.0, rgb)
    for k in range(len(ring)):
        m.tri(ring[(k + 1) % len(ring)], ring[k], centre)


def blade(m, tip_z, base_z, half_width, half_thickness, rgb, edge_rgb=None, back=None):
    """A flat double-edged point: diamond cross-section from the tip back to ``base_z`` (and on to ``back`` if given)."""
    tip = m.v((0, 0, tip_z), 1.0, edge_rgb or rgb)
    ring = [m.v((half_width, 0, base_z), 1.0, edge_rgb or rgb), m.v((0, half_thickness, base_z), 1.0, rgb),
            m.v((-half_width, 0, base_z), 1.0, edge_rgb or rgb), m.v((0, -half_thickness, base_z), 1.0, rgb)]
    for k in range(4):
        m.tri(tip, ring[k], ring[(k + 1) % 4])
    if back is not None:
        end = m.v((0, 0, back), 1.0, rgb)
        for k in range(4):
            m.tri(ring[(k + 1) % 4], ring[k], end)
    return ring


def vane(m, z_front, z_back, height, angle, root_radius, rgb):
    """A trapezoid fletching vane standing out from the shaft at ``angle`` about Z."""
    r = Vector((math.cos(angle), math.sin(angle), 0))
    a = m.v(r * root_radius + Vector((0, 0, z_front)), 1.0, rgb)
    b = m.v(r * root_radius + Vector((0, 0, z_back)), 1.0, rgb)
    c = m.v(r * (root_radius + height) + Vector((0, 0, z_back + 0.01)), 1.0, rgb)
    d = m.v(r * (root_radius + height * 0.7) + Vector((0, 0, z_front - 0.035)), 1.0, rgb)
    m.quad(a, b, c, d)


def arrow(entry, col, root, clip):
    """A 0.8 m arrow: steel broadhead, ash shaft, three feather vanes (one red cock feather) and a dark nock."""
    m = Mesh()
    blade(m, 0.0, -0.055, 0.017, 0.003, STEEL, (0.85, 0.87, 0.9), back=-0.075)
    socket = shaft(m, -0.05, -0.08, 0.0075, DARK_STEEL)
    cap(m, socket[0], (0, 0, -0.045), DARK_STEEL)
    shaft(m, -0.075, -0.78, 0.005, WOOD)
    nock = shaft(m, -0.78, -0.8, 0.0058, DARK_WOOD)
    cap(m, nock[1], (0, 0, -0.8), DARK_WOOD)
    for k, rgb in enumerate((COCK_FEATHER, FEATHER, FEATHER)):
        vane(m, -0.63, -0.76, 0.024, TAU * k / 3 + math.pi / 2, 0.005, rgb)
    m.finish(f"{entry}.model", col, SHOT, root)
    return {"length": 0.8}


def crossbow_bolt(entry, col, root, clip):
    """A stubby 0.45 m quarrel: square bodkin head, thick shaft and two stiff leather vanes."""
    m = Mesh()
    head = [m.v((0, 0, 0), 1.0, (0.8, 0.82, 0.85))]
    ring = [m.v((0.012 * math.cos(TAU * k / 4 + math.pi / 4), 0.012 * math.sin(TAU * k / 4 + math.pi / 4), -0.05), 1.0, STEEL) for k in range(4)]
    for k in range(4):
        m.tri(head[0], ring[k], ring[(k + 1) % 4])
    collar = shaft(m, -0.05, -0.07, 0.0095, DARK_STEEL, sides=6)
    cap(m, collar[0], (0, 0, -0.05), DARK_STEEL)
    body = shaft(m, -0.07, -0.45, 0.0085, DARK_WOOD, sides=6)
    cap(m, body[1], (0, 0, -0.45), DARK_WOOD)
    for k in range(2):
        vane(m, -0.36, -0.445, 0.022, math.pi * k, 0.0085, LEATHER)
    m.finish(f"{entry}.model", col, SHOT, root)
    return {"length": 0.45}


def throwing_knife(entry, col, root, clip):
    """A 0.22 m throwing knife: double-edged leaf blade, leather-wrapped grip and a ring pommel."""
    m = Mesh()
    ring = blade(m, 0.0, -0.06, 0.017, 0.003, STEEL, (0.88, 0.9, 0.92))
    back = [m.v((0.012, 0, -0.13), 1.0, STEEL), m.v((0, 0.004, -0.13), 1.0, STEEL), m.v((-0.012, 0, -0.13), 1.0, STEEL), m.v((0, -0.004, -0.13), 1.0, STEEL)]
    for k in range(4):
        j = (k + 1) % 4
        m.quad(ring[k], back[k], back[j], ring[j])
    grip = shaft(m, -0.128, -0.198, 0.007, LEATHER, sides=4)
    cap(m, grip[0], (0, 0, -0.128), DARK_STEEL)
    # ring pommel: a flat octagon loop in the blade's plane
    loop = []
    for k in range(8):
        a = TAU * k / 8
        centre = Vector((0, 0, -0.21))
        loop.append([m.v(centre + Vector((0.013 * math.cos(a), sy, 0.013 * math.sin(a))), 1.0, DARK_STEEL) for sy in (0.003, -0.003)]
                    + [m.v(centre + Vector((0.008 * math.cos(a), sy, 0.008 * math.sin(a))), 1.0, DARK_STEEL) for sy in (0.003, -0.003)])
    for k in range(8):
        a, b = loop[k], loop[(k + 1) % 8]
        m.quad(a[0], b[0], b[2], a[2])
        m.quad(a[1], a[3], b[3], b[1])
        m.quad(a[0], a[1], b[1], b[0])
    m.finish(f"{entry}.model", col, SHOT, root)
    return {"length": 0.22}


# ---------------------------------------------------------------- area effects

def frost_nova(entry, col, root, clip):
    """A ring of ice spikes that bursts out from the caster to the nova's radius, with a frost wave on the ground under
    it, then sinks and fades."""
    n = 16
    m = Mesh()
    rows = []
    for k in range(n):
        a = TAU * k / n
        c, s = math.cos(a), math.sin(a)
        rows.append([m.v((0.9 * s, 0.01, 0.9 * c), 0.0), m.v((0.97 * s, 0.03, 0.97 * c), 0.85, (0.85, 0.95, 1.0)), m.v((1.0 * s, 0.01, 1.0 * c), 0.0)])
    for k in range(n):
        a, b = rows[k], rows[(k + 1) % n]
        m.quad(a[0], b[0], b[1], a[1])
        m.quad(a[1], b[1], b[2], a[2])
    wave = m.finish(f"{entry}.wave", col, "spell-frost", root)
    crest_of = {vid: ids[1] for ids in rows for vid in ids}
    verts = m.verts
    morph(wave, "Thin", lambda i, p: verts[crest_of[i]])

    def wave_at(t):
        r = 0.1 + (NOVA_RADIUS - 0.1) * ease_out(t / 0.7)
        return ((0, 0, 0), (0, 0, 0), (r, 1, r))

    clip.node(wave, wave_at)
    clip.weight(wave, "Thin", lambda t: smooth((t - 0.5) / 0.5))
    spikes = node(f"{entry}.spikes", col, root)
    for k in range(16):
        a = TAU * (k + 0.5) / 16
        sp = Mesh()
        outward = (math.sin(a) * 0.35, 1.0, math.cos(a) * 0.35)
        height = 1.1 + 0.3 * ((k * 7) % 3)
        spike(sp, (0, 0, 0), outward, height, 0.2, 0.9, 0.6, (0.7, 0.85, 1.0), (1, 1, 1), sides=4)
        spike(sp, (0.08 * math.cos(a), 0, -0.08 * math.sin(a)), (math.sin(a) * 0.8 + 0.3 * math.cos(a), 0.7, math.cos(a) * 0.8), height * 0.55, 0.13, 0.9, 0.55, (0.7, 0.85, 1.0), (1, 1, 1), sides=4)
        obj = sp.finish(f"{entry}.spike{k}", col, "spell-frost", spikes)
        delay = 0.03 * (k % 3)

        def at(t, a=a, delay=delay):
            local = clamp01((t - delay) / (0.8 - delay))
            r = 0.4 + (NOVA_RADIUS - 0.6) * ease_out(local)
            rise = ease_out(local / 0.35)
            sink = 1 - smooth((t - 0.7) / 0.3)
            s = rise * sink
            return ((math.sin(a) * r, -0.15 * (1 - sink), math.cos(a) * r), (0, 0, 0), (s, s, s))

        clip.node(obj, at)
    return {"radius": NOVA_RADIUS}


def beam_segment(entry, col, root, clip):
    """A one-metre beam from z = 0 to z = 1, three crossed glow planes about a jagged bright core; both ends share the
    same cross-section, so copies tile. ``Crackle`` jumps the core's kinks to new offsets."""
    segments = 8
    width = 0.13
    m = Mesh()
    rows = []
    for i in range(segments + 1):
        z = BEAM_LENGTH * i / segments
        ids = [m.v((0, 0, z), 0.35)]
        for k in range(3):
            a = math.pi * k / 3
            ids += [m.v((width * math.cos(a), width * math.sin(a), z), 0.0), m.v((-width * math.cos(a), -width * math.sin(a), z), 0.0)]
        rows.append(ids)
    for a, b in zip(rows, rows[1:]):
        for edge in range(1, 7):
            m.quad(a[0], a[edge], b[edge], b[0])
    # The jagged core: a thin crossed ribbon whose kinks sit at fixed offsets; its ends stay on the axis.
    kinks = [(0, 0), (0.035, 0.01), (-0.02, 0.03), (0.03, -0.025), (-0.035, -0.01), (0.015, 0.035), (-0.03, 0.0), (0.02, -0.03), (0, 0)]
    crackle = [(0, 0), (-0.03, -0.02), (0.035, -0.01), (-0.01, 0.035), (0.03, 0.02), (-0.035, -0.025), (0.025, 0.03), (-0.02, 0.01), (0, 0)]
    core_rows = []
    cw = 0.018
    for i, (x, y) in enumerate(kinks):
        z = BEAM_LENGTH * i / segments
        core_rows.append([m.v((x + cw, y, z), 1.0), m.v((x - cw, y, z), 1.0), m.v((x, y + cw, z), 1.0), m.v((x, y - cw, z), 1.0)])
    for a, b in zip(core_rows, core_rows[1:]):
        m.quad(a[0], b[0], b[1], a[1])
        m.quad(a[2], b[2], b[3], a[3])
    obj = m.finish(f"{entry}.beam", col, "spell-energy", root)
    shift = {}
    for i, ids in enumerate(core_rows):
        dx, dy = crackle[i][0] - kinks[i][0], crackle[i][1] - kinks[i][1]
        for vid in ids:
            shift[vid] = (dx, dy)
    morph(obj, "Crackle", lambda i, p: (p[0] + shift.get(i, (0, 0))[0], p[1] + shift.get(i, (0, 0))[1], p[2]))
    steps = (0.0, 1.0, 0.2, 0.9, 0.0)

    def weight(t):
        x = t * (len(steps) - 1)
        i = min(int(x), len(steps) - 2)
        return steps[i] + (steps[i + 1] - steps[i]) * (x - i)

    clip.weight(obj, "Crackle", weight)
    clip.node(obj, lambda t: ((0, 0, 0), (0, 0, 0), (1 + 0.15 * pulse(t, 2), 1 + 0.15 * pulse(t, 2), 1)))
    return {"tileLength": BEAM_LENGTH}


# Heal motes: angle around the target, start height, delay (share of the clip), size.
MOTES = [(0.0, 0.3, 0.0, 0.14), (2.3, 0.6, 0.06, 0.12), (4.4, 0.2, 0.12, 0.16), (1.2, 0.9, 0.18, 0.1),
         (3.3, 0.45, 0.08, 0.13), (5.4, 0.7, 0.2, 0.11), (0.7, 1.1, 0.25, 0.1), (2.9, 1.0, 0.15, 0.12)]


def heal_motes(entry, col, root, clip):
    """Eight soft motes that spiral up around the target, swell in and fade out."""
    for index, (angle, height, delay, size) in enumerate(MOTES):
        m = Mesh()
        centre = m.v((0, 0, 0), 1.0)
        for axis in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
            e = Vector((axis[1], axis[2], axis[0]))
            f = Vector(axis).cross(e)
            ring = [m.v(tuple(size * (math.cos(TAU * k / 4) * e + math.sin(TAU * k / 4) * f)), 0.0) for k in range(4)]
            for k in range(4):
                m.tri(centre, ring[k], ring[(k + 1) % 4])
        obj = m.finish(f"{entry}.mote{index}", col, "spell-energy", root)

        def at(t, angle=angle, height=height, delay=delay):
            local = clamp01((t - delay) / (1 - delay))
            a = angle + 2.2 * local
            r = 0.45 - 0.15 * local
            s = smooth(local / 0.2) * (1 - smooth((local - 0.6) / 0.4)) if t >= delay else 0.0
            return ((r * math.sin(a), height + 1.1 * ease_out(local), r * math.cos(a)), (0, 0, 0), (s, s, s))

        clip.node(obj, at)
    return {}


BUILDERS = {
    "bolt-fire": bolt_fire, "bolt-shadow": bolt_shadow, "bolt-holy": bolt_holy, "bolt-nature": bolt_nature,
    "impact-fire": impact_fire, "impact-shadow": impact_shadow, "impact-holy": impact_holy, "impact-nature": impact_nature,
    "impact-frost": impact_frost, "arrow": arrow, "crossbow-bolt": crossbow_bolt, "throwing-knife": throwing_knife,
    "frost-nova": frost_nova, "beam-segment": beam_segment, "heal-motes": heal_motes,
}


def build(entry, collection, location=(0, 0, 0)):
    """Build one entry under an empty root ``spell-effects.<entry>`` at ``location`` (glTF axes), with its clip."""
    if entry not in BUILDERS:
        raise ValueError(f"spell-effects entry must be one of {', '.join(ENTRIES)}")
    for name in COLOURS:
        if name not in bpy.data.materials:
            material(name)
    root = node(f"spell-effects.{entry}", collection, None, location)
    clip = Clip(*CLIPS[entry]) if entry in CLIPS else None
    info = BUILDERS[entry](entry, collection, root, clip)
    if clip:
        info["clip"] = clip.finish(clip.name == "Loop")
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
        raise ValueError("spell-effects arguments must be {schemaVersion: 1, entry}")
    if arguments["entry"] not in ENTRIES:
        raise ValueError(f"spell-effects entry must be one of {', '.join(ENTRIES)}")
    if set(inputs):
        raise ValueError("spell-effects recipe takes no inputs")


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
    frames = round(CLIPS[entry][1] * CLIP_FPS) if entry in CLIPS else 0
    scene.frame_start, scene.frame_end = 0, max(frames, 1)
    info["clipBounds"] = clip_bounds(scene, objects, frames)
    scene.frame_set(0)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=False, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
        export_all_vertex_colors=False, export_animations=entry in CLIPS, export_animation_mode="ACTIONS", export_force_sampling=True,
        export_skins=False, export_morph=True, export_morph_normal=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": RECIPE, "entry": entry, "unit": "meter", "axes": "right-handed-y-up", "align": ALIGN[entry],
            "triangleCount": triangles, **info}
