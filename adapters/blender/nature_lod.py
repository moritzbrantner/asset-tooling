"""Greyhaven nature levels of detail (asset-tooling#449): far versions of a placed LOD0 tree or rock.

The declared input ``source`` is the placed, resized LOD0 GLB of one greyhaven-nature member. The output keeps its
frame, node names and materials, so a consumer swaps the level in place. ``arguments["method"]`` picks the level:

* ``decimate`` (rocks): weld, then edge-collapse Decimate to ``ratio``. The collapse keeps the baked UVs, so the
  level reuses LOD0's baked maps (the build resizes them per level).
* ``thin`` (trees, LOD1): the bark is decimated to ``barkRatio``; the opaque core stays; a seeded ``keep`` share of the
  leaf cards stays, each grown about its centre by ``1 / sqrt(keep)`` (times ``grow``) so the crown keeps its
  coverage, silhouette and colour. Each kept card keeps its bent normals, UVs and COLOR_0.
* ``hull`` (broadleaf, LOD2): the cards and core are replaced by one opaque clump hull: the core pushed out along its
  normals to where the cards sit (``inflate`` times their median offset, so the clump lobes stay), fitted band by
  band to the cards' ``fit``-quantile reach around the crown axis and decimated to at most ``hullTriangles``.
* ``envelope`` (conifer, LOD2): the cards and core are replaced by one closed surface of revolution (``bands`` rings
  of ``sectors`` vertices) whose radius in each band and sector is the cards' ``fit``-quantile reach there, so the
  tier notches and drooping fringes stay in the outline.

For both far shells every vertex takes the mean colour of its ``neighbours`` nearest cards (COLOR_0 times the card
image's mean grey), mixed with the nearest core colour by ``coreShare`` (LOD0's core shows between the cards),
darkened on downward faces towards ``underside`` and scaled by ``gain``: the crown's colour and darkness carry over
with no texture. The bark wholly inside the shell is removed and the rest decimated to ``barkRatio``.

Everything is deterministic from the arguments (``seed``). Blender coordinates are Z up; the GLB is exported +Y up.
"""
import math
import random

import bmesh
import bpy
import numpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

RECIPE = "nature-lod-v1"
METHODS = {
    "decimate": {"ratio"},
    "thin": {"seed", "keep", "grow", "barkRatio"},
    "hull": {"inflate", "fit", "hullTriangles", "neighbours", "coreShare", "gain", "underside", "barkRatio"},
    "envelope": {"bands", "sectors", "fit", "neighbours", "coreShare", "gain", "underside", "barkRatio"},
}
CARD_MATERIALS = ("Leaves_NormalTree", "Leaves_Pine")
CORE_MATERIAL = "Leaves_Core"


def validate(p, inputs):
    if type(p) is not dict or p.get("schemaVersion") != 1 or p.get("method") not in METHODS:
        raise ValueError(f"nature lod requires schemaVersion 1 and a method in {sorted(METHODS)}")
    if set(p) != {"schemaVersion", "method"} | METHODS[p["method"]]:
        raise ValueError(f"nature lod '{p['method']}' takes exactly {sorted(METHODS[p['method']])}")
    for name in ("ratio", "keep", "barkRatio"):
        if name in p and not (type(p[name]) in (int, float) and 0.01 <= p[name] <= 1):
            raise ValueError(f"nature lod {name} must be in 0.01..1")
    if set(inputs) != {"source"}:
        raise ValueError("nature lod takes exactly the declared input source")


def triangles(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def weld(obj):
    # glTF splits vertices at UV and normal seams; weld them so the collapse sees one surface (UVs stay per corner).
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(obj.data)
    bm.free()


def decimate(obj, ratio):
    if ratio >= 1:
        return
    modifier = obj.modifiers.new("lod", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = ratio
    modifier.use_collapse_triangulate = True
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=modifier.name)


def split_by_material(obj):
    """Separate a joined tree mesh into one object per material, keyed by material name."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    with bpy.context.temp_override(object=obj, active_object=obj, selected_editable_objects=[obj]):
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.separate(type="MATERIAL")
        bpy.ops.object.mode_set(mode="OBJECT")
    parts = {}
    for part in [o for o in bpy.context.scene.objects if o.type == "MESH" and o.data is not None]:
        used = {part.data.materials[p.material_index].name for p in part.data.polygons if part.data.materials}
        if len(used) != 1:
            raise ValueError(f"{part.name}: expected one material per part, found {sorted(used)}")
        name = used.pop()
        base = next((m for m in (*CARD_MATERIALS, CORE_MATERIAL) if name.startswith(m)), name)
        parts[base] = part
    return parts


def card_of(parts):
    cards = [parts[name] for name in CARD_MATERIALS if name in parts]
    if len(cards) != 1 or CORE_MATERIAL not in parts:
        raise ValueError(f"a tree needs one leaf-card part and a {CORE_MATERIAL} part, found {sorted(parts)}")
    bark = [part for name, part in parts.items() if name not in (*CARD_MATERIALS, CORE_MATERIAL)]
    if len(bark) != 1:
        raise ValueError(f"a tree needs one bark part, found {len(bark)}")
    return cards[0], parts[CORE_MATERIAL], bark[0]


def read_cards(obj):
    """Every card (a connected face island) with its corners: position, normal, UV and colour."""
    mesh = obj.data
    normals = [Vector(n.vector) for n in mesh.corner_normals]
    uv = mesh.uv_layers.active.data if mesh.uv_layers.active else None
    col = mesh.color_attributes.active_color
    if col is None or col.domain != "CORNER":
        raise ValueError(f"{obj.name}: the cards need a corner COLOR_0")
    parent = list(range(len(mesh.vertices)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for poly in mesh.polygons:
        first = find(poly.vertices[0])
        for v in poly.vertices[1:]:
            parent[find(v)] = first
    groups = {}
    for poly in mesh.polygons:
        groups.setdefault(find(poly.vertices[0]), []).append(poly)
    cards = []
    for polys in groups.values():
        corners = [(Vector(mesh.vertices[mesh.loops[li].vertex_index].co), normals[li],
                    tuple(uv[li].uv) if uv else (0.0, 0.0), tuple(col.data[li].color)) for p in polys for li in p.loop_indices]
        faces = [len(p.loop_indices) for p in polys]
        centre = sum((c[0] for c in corners), Vector()) / len(corners)
        size = max((c[0] - centre).length for c in corners)
        colour = tuple(sum(c[3][k] for c in corners) / len(corners) for k in range(3))
        cards.append({"corners": corners, "faces": faces, "centre": centre, "size": size, "colour": colour})
    cards.sort(key=lambda card: (round(card["centre"].x, 4), round(card["centre"].y, 4), round(card["centre"].z, 4)))
    return cards


def write_cards(obj, cards, grow):
    """Rebuild the card mesh from ``cards``, each scaled by ``grow`` about its centre; corner data stays."""
    verts, faces, normals, uvs, colours = [], [], [], [], []
    for card in cards:
        at = 0
        for count in card["faces"]:
            face = []
            for corner in card["corners"][at:at + count]:
                position, normal, uv, colour = corner
                face.append(len(verts))
                verts.append(tuple(card["centre"] + (position - card["centre"]) * grow))
                normals.append(tuple(normal))
                uvs.append(uv)
                colours.append(colour)
            faces.append(face)
            at += count
    mesh = obj.data
    materials = list(mesh.materials)
    name = mesh.color_attributes.active_color.name
    fresh = bpy.data.meshes.new(mesh.name)
    fresh.from_pydata(verts, [], faces)
    for material in materials:
        fresh.materials.append(material)
    uv = fresh.uv_layers.new(name="UVMap")
    col = fresh.color_attributes.new(name, "BYTE_COLOR", "CORNER")
    for poly in fresh.polygons:
        poly.use_smooth = True
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[fresh.loops[li].vertex_index]
            col.data[li].color = colours[fresh.loops[li].vertex_index]
    fresh.normals_split_custom_set([normals[loop.vertex_index] for loop in fresh.loops])
    obj.data = fresh
    bpy.data.meshes.remove(mesh)


def card_grey(obj):
    """Mean grey of the card image where it is opaque: the factor the image multiplies COLOR_0 by."""
    material = obj.data.materials[0]
    image = next(n.image for n in material.node_tree.nodes if n.type == "TEX_IMAGE" and n.image)
    px = numpy.empty(len(image.pixels), dtype=numpy.float32)
    image.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    opaque = px[px[:, 3] > 0.5][:, :3]
    return float((opaque @ numpy.array([0.2126, 0.7152, 0.0722], dtype=numpy.float32)).mean()) if len(opaque) else 1.0


def inside(bvh, point):
    """Whether ``point`` is inside the closed mesh behind ``bvh``: the nearest face faces away from it."""
    location, normal, _index, _distance = bvh.find_nearest(point)
    return location is not None and (point - location).dot(normal) < 0


FIT_BANDS = 24


def fit_silhouette(mesh, cards, quantile):
    """Scale the hull horizontally about the crown axis, band by band, so its reach matches the cards' ``quantile``
    reach at that height: the hull's outline then follows LOD0's ragged one (fir sprigs spray past each skirt rim)."""
    corners = [c[0] for card in cards for c in card["corners"]]
    lo, hi = min(c.z for c in corners), max(c.z for c in corners)
    axis = sum((c.xy for c in corners), Vector((0, 0))) / len(corners)
    step = (hi - lo) / FIT_BANDS

    def band(z):
        return min(FIT_BANDS - 1, max(0, int((z - lo) / step)))

    card_reach = [[] for _ in range(FIT_BANDS)]
    for c in corners:
        card_reach[band(c.z)].append((c.xy - axis).length)
    hull_reach = [0.0] * FIT_BANDS
    for v in mesh.vertices:
        hull_reach[band(v.co.z)] = max(hull_reach[band(v.co.z)], (v.co.xy - axis).length)
    scale = []
    for b in range(FIT_BANDS):
        reach = sorted(card_reach[b])
        target = reach[min(len(reach) - 1, int(len(reach) * quantile))] if reach else 0.0
        scale.append(min(1.6, max(0.8, target / hull_reach[b])) if target and hull_reach[b] > 0.05 else 1.0)
    smooth = [sum(scale[max(0, b - 1):b + 2]) / len(scale[max(0, b - 1):b + 2]) for b in range(FIT_BANDS)]
    for v in mesh.vertices:
        offset = v.co.xy - axis
        v.co.xy = axis + offset * smooth[band(v.co.z)]


def inflated_core(cards, core, p, collection):
    """The opaque core, pushed out along its normals to where LOD0's cards sit (``inflate`` times their median
    offset), so it keeps the clump lobes, then fitted to the cards' silhouette and decimated to ``hullTriangles``."""
    weld(core)
    bm = bmesh.new()
    bm.from_mesh(core.data)
    bvh = BVHTree.FromBMesh(bm)
    bm.free()
    offsets = sorted(max(0.0, (card["centre"] - bvh.find_nearest(card["centre"])[0]).length) for card in cards)
    reach = offsets[len(offsets) // 2] * p["inflate"]
    shell = bpy.data.objects.new("lod_hull", core.data.copy())
    collection.objects.link(shell)
    mesh = shell.data
    for v in mesh.vertices:
        v.co += v.normal * reach
    fit_silhouette(mesh, cards, p["fit"])
    decimate(shell, min(1.0, p["hullTriangles"] / max(1, triangles(shell))))
    return shell


def envelope(cards, core, p, collection):
    """A closed surface of revolution around the crown axis whose radius, per height band and sector, is the cards'
    ``fit`` quantile reach there: it follows a fir's tier silhouette, including the drooping fringe under each tier."""
    corners = [c[0] for card in cards for c in card["corners"]]
    lo, hi = min(c.z for c in corners), max(c.z for c in corners)
    axis = sum((c.xy for c in corners), Vector((0, 0))) / len(corners)
    bands, sectors = p["bands"], p["sectors"]
    step = (hi - lo) / bands
    cells = [[[] for _ in range(sectors)] for _ in range(bands)]
    for c in corners:
        offset = c.xy - axis
        b = min(bands - 1, int((c.z - lo) / step))
        s = int((math.atan2(offset.y, offset.x) / (2 * math.pi) % 1.0) * sectors) % sectors
        cells[b][s].append(offset.length)
    radius = [[0.0] * sectors for _ in range(bands)]
    for b in range(bands):
        whole = sorted(r for cell in cells[b] for r in cell)
        fallback = whole[int(len(whole) * p["fit"])] if whole else 0.0
        for s in range(sectors):
            reach = sorted(cells[b][s])
            radius[b][s] = reach[min(len(reach) - 1, int(len(reach) * p["fit"]))] if len(reach) >= 4 else fallback
    # Soften sector noise (not the bands: they carry the tier notches).
    radius = [[(radius[b][s - 1] + 2 * radius[b][s] + radius[b][(s + 1) % sectors]) / 4 for s in range(sectors)] for b in range(bands)]
    verts, faces = [(axis.x, axis.y, lo)], []
    for b in range(bands):
        z = lo + (b + 0.5) * step
        for s in range(sectors):
            a = 2 * math.pi * (s + 0.5) / sectors
            verts.append((axis.x + math.cos(a) * radius[b][s], axis.y + math.sin(a) * radius[b][s], z))
    verts.append((axis.x, axis.y, hi))
    ring = lambda b, s: 1 + b * sectors + s % sectors  # noqa: E731
    for s in range(sectors):
        faces.append((0, ring(0, s + 1), ring(0, s)))
        faces.append((len(verts) - 1, ring(bands - 1, s), ring(bands - 1, s + 1)))
        for b in range(bands - 1):
            faces.append((ring(b, s), ring(b, s + 1), ring(b + 1, s + 1), ring(b + 1, s)))
    mesh = bpy.data.meshes.new("lod_envelope")
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(core.data.materials[0])
    mesh.color_attributes.new(core.data.color_attributes.active_color.name, "BYTE_COLOR", "CORNER")
    shell = bpy.data.objects.new("lod_envelope", mesh)
    collection.objects.link(shell)
    return shell


def colour_hull(shell, cards, core, p, grey):
    """Every hull vertex takes the mean colour of its nearest cards (times the card image grey), mixed with the
    nearest core colour by ``coreShare`` (the core shows between LOD0's cards), times ``gain``."""
    tree = KDTree(len(cards))
    for i, card in enumerate(cards):
        tree.insert(card["centre"], i)
    tree.balance()
    # The core shows through the gaps between LOD0's cards; its nearest colour is mixed in by coreShare.
    source = core.data
    core_colour = [Vector() for _ in source.vertices]
    core_count = [0] * len(source.vertices)
    core_layer = source.color_attributes.active_color
    for loop in source.loops:
        core_colour[loop.vertex_index] += Vector(core_layer.data[loop.index].color[:3])
        core_count[loop.vertex_index] += 1
    core_tree = KDTree(len(source.vertices))
    for v in source.vertices:
        core_tree.insert(v.co, v.index)
    core_tree.balance()
    mesh = shell.data
    col = mesh.color_attributes.active_color
    vertex_colour = []
    for v in mesh.vertices:
        near = tree.find_n(v.co, p["neighbours"])
        weights = [1.0 / (0.05 + d) for _co, _i, d in near]
        rgb = Vector([sum(w * cards[i]["colour"][k] for w, (_co, i, _d) in zip(weights, near)) / sum(weights) for k in range(3)]) * grey
        _co, index, _d = core_tree.find(v.co)
        rgb = rgb.lerp(core_colour[index] / max(1, core_count[index]), p["coreShare"])
        # Undersides read as shadow bands in LOD0 (cards over the dark core); darken them by ``underside``.
        shade = 1.0 + (p["underside"] - 1.0) * max(0.0, -v.normal.z)
        vertex_colour.append(tuple(min(1.0, c * p["gain"] * shade) for c in rgb))
    for loop in mesh.loops:
        col.data[loop.index].color = (*vertex_colour[loop.vertex_index], 1.0)
    for poly in mesh.polygons:
        poly.use_smooth = True


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    p = arguments
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=inputs["source"])
    imported = list(bpy.context.scene.objects)
    meshes = [o for o in imported if o.type == "MESH"]
    if len(meshes) != 1:
        raise ValueError(f"a nature member has one mesh node, found {len(meshes)}")
    obj = meshes[0]
    before = triangles(obj)
    observations = {"recipe": RECIPE, "method": p["method"], "trianglesBefore": before}
    if p["method"] == "decimate":
        weld(obj)
        decimate(obj, p["ratio"])
        result = obj
    else:
        node, matrix, parent = obj.name, obj.matrix_world.copy(), obj.parent
        cards_obj, core, bark = card_of(split_by_material(obj))
        cards = read_cards(cards_obj)
        observations["cardsBefore"] = len(cards)
        if p["method"] == "thin":
            rng = random.Random(p["seed"])
            kept = [card for card in cards if rng.random() < p["keep"]]
            write_cards(cards_obj, kept, p["grow"] / math.sqrt(p["keep"]))
            observations["cardsAfter"] = len(kept)
            keep = [bark, core, cards_obj]
        else:
            grey = card_grey(cards_obj)
            build = inflated_core if p["method"] == "hull" else envelope
            shell = build(cards, core, p, bpy.context.scene.collection)
            colour_hull(shell, cards, core, p, grey)
            shell.matrix_world = cards_obj.matrix_world
            observations["cardGrey"] = round(grey, 4)
            observations["hullTriangles"] = triangles(shell)
            # Bark wholly inside the hull is never seen: drop it before the collapse.
            bm = bmesh.new()
            bm.from_mesh(shell.data)
            bvh = BVHTree.FromBMesh(bm)
            bm.free()
            bm = bmesh.new()
            bm.from_mesh(bark.data)
            hidden = [f for f in bm.faces if all(inside(bvh, v.co) for v in f.verts)]
            bmesh.ops.delete(bm, geom=hidden, context="FACES")
            bm.to_mesh(bark.data)
            bm.free()
            for gone in (cards_obj, core):
                bpy.data.objects.remove(gone)
            keep = [bark, shell]
        weld(bark)
        decimate(bark, p["barkRatio"])
        observations["barkTriangles"] = triangles(bark)
        bpy.ops.object.select_all(action="DESELECT")
        for part in keep:
            part.select_set(True)
        bpy.context.view_layer.objects.active = bark
        with bpy.context.temp_override(active_object=bark, selected_editable_objects=keep):
            bpy.ops.object.join()
        result = bark
        result.name = node
        result.parent = parent
        result.matrix_world = matrix
        colours = result.data.color_attributes
        colours.active_color = colours[0]
        colours.render_color_index = colours.active_color_index
    observations["triangles"] = triangles(result)
    bpy.ops.object.select_all(action="DESELECT")
    node = result
    while node:
        node.select_set(True)
        node = node.parent
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False,
        export_vertex_color="ACTIVE" if p["method"] != "decimate" else "MATERIAL", export_all_vertex_colors=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return observations
