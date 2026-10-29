"""Marshal Elden Greywatch's house, a furnished private home for the existing pinned Blender script backend.

One run builds one part (#413, docs/greyhaven-marshal-house.md) of the enterable home on mmorpg's west
Outpost house, collider 103 (consumer mmorpg#158). The exterior is exactly the Outpost kit's ``house``
composition (docs/outpost-kit.md), which mmorpg's house 105 already draws. The interior adds a plank
floor, a ceiling and a modest Marshal's furniture. Everything is built with the kit's own ``Builder``,
materials and textures, so the PNG bytes are identical to the kit's. The barrel comes from the settlement
props.

Frame, shared by every part: metres, glTF right-handed +Y up, origin at the footprint's base centre,
the door on the +Z front. The walls stand on the 8 x 6 m footprint (outer faces at x = +-4, z = +-3,
0.32 m thick); the room is 7.36 x 5.36 m.

Parts:
- ``shell``: the kit's walls, corners and outside chimney, the plank floor, an empty node ``door.hinge``
  where the door hangs and the chimney's ``smoke`` node;
- ``ceiling``: the board ceiling and its joists, hideable for interior views;
- ``roof``: the kit's roof sections, verges and gables, hideable for interior views;
- ``door``: the kit's plank door, its origin the hinge (+Y), closed along +X, empty node ``hinge``;
- ``furniture``: one named node per item: ``bed``, ``chest``, ``table``, ``bench``, ``chair``,
  ``hearth``, ``log-stack``, ``barrel`` and the Marshal's ``weapon-rack`` with his shield;
- ``collision``: one axis-aligned box per collider, ``collider.<wall|floor|door|furniture>.<name>``;
  the door's leaf box is in the door's frame.

The kit recipe (``outpost.py``) and the settlement props (``settlement_props.py``) are declared Python
inputs named ``outpost`` and ``settlement``. No randomness.

``build(part, collection)`` also works in a live Blender session after ``use_sources(outpost, settlement)``;
``generate`` is the script-backend entry point.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

PARTS = ("shell", "ceiling", "roof", "door", "furniture", "collision")
SHELL_MODULES = ("wall", "wall-half", "wall-window", "wall-door", "corner", "chimney")
ROOF_MODULES = ("roof", "roof-half", "roof-verge", "gable")

W, D = 8.0, 6.0
WALL_T = 0.32
IX, IZ = W / 2 - WALL_T, D / 2 - WALL_T   # inner wall faces
FLOOR_TOP = 0.02
CEILING = 2.95                            # ceiling boards' underside
DOOR_X = (-0.6, 0.6)
DOOR_H = 2.2

# Plain-colour materials added to the kit's: (sRGB base colour, metallic, roughness, texture).
EXTRA_MATERIALS = {
    "wool": ((0.34, 0.38, 0.44), 0.0, 0.95, None),    # Greywatch blue-grey
    "linen": ((0.82, 0.78, 0.68), 0.0, 0.95, None),
    "leather": ((0.33, 0.2, 0.11), 0.0, 0.7, None),
    "steel": ((0.62, 0.62, 0.64), 1.0, 0.32, None),
    "ember": ((0.85, 0.32, 0.08), 0.0, 0.9, None),
    "parchment": ((0.84, 0.76, 0.58), 0.0, 0.95, None),
}

# Where the game can put people (glTF frame). yawDegrees turns +Z about +Y (90 faces +X).
SPOTS = {
    "doorstep": {"position": [0.0, 0.0, 3.6], "yawDegrees": 180, "note": "outside, facing the door: the knock spot"},
    "doorway": {"position": [0.0, FLOOR_TOP, 2.18], "yawDegrees": 0, "min": [-0.5, FLOOR_TOP, round(IZ - 1.0, 6)], "max": [0.5, 2.0, IZ],
                "note": "the 1 m standing spot just inside the doorway, facing out"},
    "bedside": {"position": [-2.1, FLOOR_TOP, -1.6], "yawDegrees": -90, "note": "beside the bed, facing it"},
    "sleep": {"position": [-3.09, 0.53, -1.75], "yawDegrees": 180, "note": "lying on the mattress, head towards -Z"},
}

K = {}   # the outpost kit's namespace
S = {}   # the settlement props' namespace


def use_sources(outpost, settlement):
    """Bind the kit's and the settlement props' namespaces; the props bind the kit themselves."""
    K.clear()
    K.update(outpost)
    S.clear()
    S.update(settlement)
    S["use_kit"](K)
    K["MATERIALS"].update(EXTRA_MATERIALS)


def r6(v):
    return [round(c, 6) for c in v]


def house_items():
    return K["compositions"]()["house"]["items"]


def module_of(item):
    return item["key"].split(".")[-1]


# ---------------------------------------------------------------- helpers

def bake(objects, name, collection, parent=None):
    """Join ``objects``' meshes, in world space, into one object ``name``; empties keep their world place."""
    meshes = [o for o in objects if o.type == "MESH"]
    roots = [o for o in objects if o.type == "EMPTY" and o.name.startswith(("outpost.", "settlement."))]
    bpy.context.view_layer.update()
    for o in objects:
        world = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = world
    for o in meshes:
        o.data.transform(o.matrix_world)
        o.matrix_world = Matrix.Identity(4)
    keep = meshes[0]
    if len(meshes) > 1:
        with bpy.context.temp_override(active_object=keep, selected_editable_objects=meshes, object=keep):
            bpy.ops.object.join()
    keep.name = name
    keep.data.name = f"{name}-geometry"
    bm = bmesh.new()
    bm.from_mesh(keep.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(keep.data)
    bm.free()
    for o in roots:
        bpy.data.objects.remove(o)
    if parent is not None:
        keep.parent = parent
    if keep.name not in collection.objects:
        for c in list(keep.users_collection):
            c.objects.unlink(keep)
        collection.objects.link(keep)
    return keep


def kit_modules(modules, collection):
    objects = []
    for item in house_items():
        part = module_of(item)
        if part not in modules:
            continue
        root, _ = K["build"](part, collection, tuple(item["translation"]), "shingle", item["yawDegrees"])
        objects += [root] + list(root.children_recursive)
    return objects


def placed(b, matrix, fn):
    """Run ``fn`` and move the faces it made by ``matrix`` (glTF axes). The settlement ``lathe`` leaves
    loose vertices behind (its caps re-create the whole ring list); they are removed here."""
    for v in b.bm.verts:
        v.tag = True
    fn()
    loose = [v for v in b.bm.verts if not v.tag and not v.link_faces]
    bmesh.ops.delete(b.bm, geom=loose, context="VERTS")
    b.transform([f for f in b.bm.faces if not any(v.tag for v in f.verts)], matrix)
    for v in b.bm.verts:
        v.tag = False


def rod(b, a, c, radius, mat, key, segments=8):
    a, c = Vector(a), Vector(c)
    d = c - a
    turn = Vector((0, 1, 0)).rotation_difference(d.normalized()).to_matrix().to_4x4()
    placed(b, Matrix.Translation(a) @ turn, lambda: S["lathe"](b, [(0, radius), (d.length, radius)], segments, mat, key))


# ---------------------------------------------------------------- parts

def build_shell(collection):
    objects = kit_modules(SHELL_MODULES, collection)
    b = K["Builder"]("marshal-house.floor")
    # Floorboards along X, 0.2 m wide, with a joint line between them.
    z, k = -IZ, 0
    while z < IZ - 1e-9:
        z1 = min(z + 0.2, IZ)
        b.box((-IX, 0.0, z + 0.004), (IX, FLOOR_TOP, z1 - 0.004), "wood", f"floor/board{k}", grain=(1, 0, 0))
        z, k = z1, k + 1
    b.box((-IX, -0.01, -IZ), (IX, FLOOR_TOP - 0.004, IZ), "soot", "floor/joints")
    objects.append(b.finish(collection))
    shell = bake(objects, "marshal-house.shell", collection)
    return {"nodes": ["door.hinge", "smoke"], "mesh": shell.name}


def build_ceiling(collection):
    b = K["Builder"]("marshal-house.ceiling")
    b.box((-IX, CEILING, -IZ), (IX, CEILING + 0.05, IZ), "wood", "ceiling/boards", grain=(0, 0, 1))
    for x in (-2.4, -0.8, 0.8, 2.4):
        b.block((x - 0.08, CEILING - 0.16, -IZ), (x + 0.08, CEILING, IZ), "timber", 0.015, f"ceiling/joist{x}", grain=(0, 0, 1))
    b.finish(collection)
    return {}


def build_roof(collection):
    bake(kit_modules(ROOF_MODULES, collection), "marshal-house.roof", collection)
    return {}


def build_door(collection):
    root, info = K["build"]("door", collection)
    root.name = "marshal-house.door"
    for o in root.children:
        if o.type == "MESH":
            o.name = "marshal-house.door.leaf"
    return {"hinge": info["hinge"], "leafBounds": info["leafBounds"]}


# ---------------------------------------------------------------- furniture

def bed(b):
    x0, x1, z0, z1 = -3.64, -2.54, -2.64, -0.54
    p = 0.08
    for x in (x0, x1 - p):
        b.block((x, 0, z0), (x + p, 1.0, z0 + p), "timber", 0.012, f"bed/headpost{x}", grain=(0, 1, 0))
        b.block((x, 0, z1 - p), (x + p, 0.62, z1), "timber", 0.012, f"bed/footpost{x}", grain=(0, 1, 0))
    for x in (x0 + 0.01, x1 - 0.07):
        b.block((x, 0.2, z0 + p), (x + 0.06, 0.36, z1 - p), "timber", 0.01, f"bed/rail{x}", grain=(0, 0, 1))
    b.block((x0 + p, 0.42, z0 + 0.015), (x1 - p, 0.92, z0 + 0.055), "wood", 0.01, "bed/headboard", grain=(1, 0, 0))
    b.block((x0 + p, 0.2, z1 - 0.06), (x1 - p, 0.48, z1 - 0.02), "wood", 0.01, "bed/footboard", grain=(1, 0, 0))
    b.box((x0 + 0.06, 0.3, z0 + p), (x1 - 0.06, 0.34, z1 - p), "wood", "bed/slats", grain=(1, 0, 0))
    b.block((x0 + 0.08, 0.34, z0 + 0.08), (x1 - 0.08, 0.5, z1 - 0.08), "sacking", 0.05, "bed/mattress")
    b.block((x0 + 0.16, 0.5, z0 + 0.1), (x1 - 0.16, 0.62, z0 + 0.48), "linen", 0.05, "bed/pillow")
    b.block((x0 + 0.04, 0.36, z0 + 0.62), (x1 - 0.04, 0.54, z1 - 0.07), "wool", 0.03, "bed/blanket")
    b.box((x0 + 0.035, 0.535, z1 - 0.42), (x1 - 0.035, 0.55, z1 - 0.3), "dye", "bed/stripe", grain=(1, 0, 0))


def chest(b):
    x0, x1, z0, z1 = -3.5, -2.68, -0.46, -0.02
    b.block((x0, 0, z0), (x1, 0.4, z1), "wood", 0.015, "chest/body", grain=(1, 0, 0))
    b.block((x0 - 0.015, 0.4, z0 - 0.015), (x1 + 0.015, 0.54, z1 + 0.015), "wood", 0.02, "chest/lid", grain=(1, 0, 0))
    for x in (x0 + 0.12, x1 - 0.16):  # iron straps over the lid and down the front
        b.box((x, 0.04, z1 + 0.012), (x + 0.04, 0.545, z1 + 0.024), "iron", f"chest/strap{x}", grain=(0, 1, 0))
        b.box((x, 0.54, z0 - 0.02), (x + 0.04, 0.555, z1 + 0.024), "iron", f"chest/strap-top{x}", grain=(0, 0, 1))
    b.box((-3.13, 0.3, z1 + 0.012), (-3.05, 0.42, z1 + 0.035), "iron", "chest/lock")
    for x, z in ((x0, z0), (x1 - 0.05, z0), (x0, z1 - 0.05), (x1 - 0.05, z1 - 0.05)):
        b.box((x - 0.005, 0, z - 0.005), (x + 0.055, 0.4, z + 0.055), "timber", f"chest/corner{x}{z}", grain=(0, 1, 0))


def table(b):
    x0, x1, z0, z1 = 0.9, 2.3, -1.6, -0.8
    b.block((x0, 0.72, z0), (x1, 0.78, z1), "wood", 0.012, "table/top", grain=(1, 0, 0))
    for x in (x0 + 0.06, x1 - 0.14):
        for z in (z0 + 0.06, z1 - 0.14):
            b.block((x, 0, z), (x + 0.08, 0.72, z + 0.08), "timber", 0.01, f"table/leg{x}{z}", grain=(0, 1, 0))
    b.block((x0 + 0.1, 0.12, -1.23), (x1 - 0.1, 0.19, -1.17), "timber", 0.01, "table/stretcher", grain=(1, 0, 0))
    for z in (z0 + 0.06, z1 - 0.14):
        b.block((x0 + 0.06, 0.6, z + 0.01), (x1 - 0.06, 0.72, z + 0.07), "timber", 0.01, f"table/apron{z}", grain=(1, 0, 0))
    # A patrol map, a candlestick and a tankard.
    b.box((1.25, 0.78, -1.42), (1.75, 0.784, -1.06), "parchment", "table/map", grain=(1, 0, 0))
    placed(b, Matrix.Translation((2.05, 0, -1.4)), lambda: S["lathe"](
        b, [(0.78, 0.06), (0.8, 0.06), (0.815, 0.016), (0.95, 0.016), (0.96, 0.035), (0.975, 0.035)], 8, "iron", "table/candlestick"))
    placed(b, Matrix.Translation((2.05, 0, -1.4)), lambda: S["lathe"](b, [(0.975, 0.016), (1.06, 0.016), (1.06, 0)], 8, "linen", "table/candle"))
    placed(b, Matrix.Translation((1.95, 0, -1.0)), lambda: S["lathe"](b, [(0.78, 0.045), (0.92, 0.042), (0.92, 0)], 8, "wood", "table/tankard"))
    b.box((1.985, 0.81, -1.005), (2.02, 0.89, -0.995), "iron", "table/tankard-handle")


def bench(b):
    x0, x1, z0, z1 = 0.95, 2.25, -2.15, -1.85
    b.block((x0, 0.42, z0), (x1, 0.47, z1), "wood", 0.01, "bench/seat", grain=(1, 0, 0))
    for x in (x0 + 0.1, x1 - 0.16):
        b.block((x, 0, z0 + 0.03), (x + 0.06, 0.42, z1 - 0.03), "wood", 0.01, f"bench/leg{x}", grain=(0, 1, 0))
    b.block((x0 + 0.16, 0.16, -2.03), (x1 - 0.16, 0.22, -1.97), "timber", 0.01, "bench/stretcher", grain=(1, 0, 0))


def chair(b):
    x0, x1, z0, z1 = 1.37, 1.83, -0.62, -0.16
    b.block((x0, 0.43, z0), (x1, 0.47, z1), "wood", 0.01, "chair/seat", grain=(1, 0, 0))
    for x in (x0 + 0.02, x1 - 0.07):
        b.block((x, 0, z0 + 0.02), (x + 0.05, 0.43, z0 + 0.07), "timber", 0.008, f"chair/front-leg{x}", grain=(0, 1, 0))
        b.block((x, 0, z1 - 0.07), (x + 0.05, 0.98, z1 - 0.02), "timber", 0.008, f"chair/back-post{x}", grain=(0, 1, 0))
    for y in (0.62, 0.86):
        b.block((x0 + 0.07, y, z1 - 0.065), (x1 - 0.07, y + 0.08, z1 - 0.03), "wood", 0.008, f"chair/back-rail{y}", grain=(1, 0, 0))


def hearth(b):
    b.block((2.72, 0, -0.85), (IX, 0.12, 0.85), "stone", 0.02, "hearth/hearthstone", grain=(0, 0, 1))
    for z0, z1 in ((-0.8, -0.5), (0.5, 0.8)):
        b.block((3.06, 0.12, z0), (IX, 1.1, z1), "stone", 0.02, f"hearth/cheek{z0}", grain=(0, 1, 0))
    b.block((3.5, 0.12, -0.5), (IX, 1.1, 0.5), "stone", 0.02, "hearth/back")
    b.box((3.48, 0.12, -0.5), (3.5, 1.1, 0.5), "soot", "hearth/fireback")
    b.box((3.06, 1.0, -0.5), (3.5, 1.1, 0.5), "soot", "hearth/throat")
    b.block((3.0, 1.1, -0.86), (IX, 1.28, 0.86), "timber", 0.015, "hearth/lintel", grain=(0, 0, 1))
    b.block((2.94, 1.28, -0.92), (IX, 1.33, 0.92), "timber", 0.01, "hearth/mantel", grain=(0, 0, 1))
    b.block((3.12, 1.33, -0.7), (IX, CEILING, 0.7), "stone", 0.02, "hearth/breast", grain=(1, 0, 0))
    # Andirons, two logs and the embers.
    for z in (-0.25, 0.25):
        b.box((3.12, 0.12, z - 0.015), (3.42, 0.3, z + 0.015), "iron", f"hearth/andiron{z}", grain=(1, 0, 0))
    b.box((3.14, 0.12, -0.38), (3.44, 0.17, 0.38), "ember", "hearth/embers", grain=(0, 0, 1))
    rod(b, (3.24, 0.3, -0.4), (3.24, 0.3, 0.4), 0.07, "timber", "hearth/log1", 7)
    rod(b, (3.36, 0.36, -0.36), (3.31, 0.42, 0.38), 0.06, "soot", "hearth/log2", 7)
    # A pot hanging from a crane arm.
    b.box((3.3, 0.85, -0.02), (3.47, 0.88, 0.02), "iron", "hearth/crane", grain=(1, 0, 0))
    b.box((3.3, 0.6, -0.01), (3.32, 0.86, 0.01), "iron", "hearth/hook", grain=(0, 1, 0))
    placed(b, Matrix.Translation((3.31, 0, 0)), lambda: S["lathe"](
        b, [(0.42, 0), (0.42, 0.08), (0.47, 0.13), (0.56, 0.14), (0.62, 0.12), (0.62, 0)], 10, "iron", "hearth/pot"))


def log_stack(b):
    for row, (y, zs) in enumerate(((0.07, (1.1, 1.26, 1.42)), (0.2, (1.18, 1.34)), (0.33, (1.26,)))):
        for k, z in enumerate(zs):
            key = f"logs/billet{row}-{k}"
            rod(b, (3.05, y, z), (3.6, y + 0.005, z + 0.01), 0.07, "timber", key, 6)


def blade(b, key, base, length, width):
    """A straight sword point-down: crossguard at ``base`` (glTF), the blade below, the grip above."""
    x, y, z = base
    b.box((x - 0.006, y - length, z - width / 2), (x + 0.006, y, z + width / 2), "steel", f"{key}/blade", grain=(0, 1, 0))
    b.box((x - 0.02, y, z - 0.11), (x + 0.02, y + 0.03, z + 0.11), "iron", f"{key}/guard", grain=(0, 0, 1))
    rod(b, (x, y + 0.03, z), (x, y + 0.2, z), 0.016, "leather", f"{key}/grip", 6)
    placed(b, Matrix.Translation((x, y + 0.2, z)), lambda: S["lathe"](b, [(0, 0.026), (0.04, 0.026), (0.05, 0)], 8, "iron", f"{key}/pommel"))


def weapon_rack(b):
    x0, x1, z0, z1 = -3.66, -3.3, 0.95, 2.25
    b.block((x0 + 0.02, 0, z0), (x1, 0.1, z1), "timber", 0.012, "rack/foot", grain=(0, 0, 1))
    for z in (z0 + 0.02, z1 - 0.1):
        b.block((x0 + 0.02, 0.1, z), (x0 + 0.12, 1.55, z + 0.08), "timber", 0.012, f"rack/upright{z}", grain=(0, 1, 0))
    b.block((x0 + 0.02, 1.32, z0 + 0.02), (x0 + 0.14, 1.4, z1 - 0.02), "timber", 0.01, "rack/top-rail", grain=(0, 0, 1))
    b.block((x0 + 0.12, 0.34, z0 + 0.1), (x1, 0.4, z1 - 0.1), "timber", 0.01, "rack/slot-rail", grain=(0, 0, 1))
    # A spear and a poleaxe leaning in the rack; a sword point-down.
    rod(b, (-3.42, 0.1, 1.25), (-3.6, 2.15, 1.25), 0.018, "wood", "rack/spear-shaft")
    placed(b, Matrix.Translation((-3.6, 2.15, 1.25)) @ Matrix.Rotation(math.atan2(0.18, 2.05), 4, "Z"),
           lambda: S["lathe"](b, [(0, 0.022), (0.05, 0.03), (0.08, 0.035), (0.28, 0)], 4, "steel", "rack/spear-head"))
    rod(b, (-3.42, 0.1, 1.95), (-3.6, 1.95, 1.95), 0.02, "wood", "rack/poleaxe-shaft")
    axe = [(-0.02, -0.02), (0.18, -0.08), (0.2, 0.0), (0.18, 0.12), (-0.02, 0.05)]
    placed(b, Matrix.Translation((-3.585, 1.72, 1.95)) @ Matrix.Rotation(-math.pi / 2, 4, "Y"),
           lambda: b.prism(axe, -0.008, 0.008, "steel", "rack/poleaxe-blade", grain=(1, 0, 0)))
    b.box((-3.6, 1.95, 1.94), (-3.57, 2.1, 1.96), "steel", "rack/poleaxe-spike", grain=(0, 1, 0))
    blade(b, "rack/sword", (-3.44, 0.98, 1.6), 0.86, 0.05)
    # The Marshal's heater shield hangs on the wall above the rack: blue-grey with a red pale and an iron boss.
    shield = [(-0.27, 0.0), (-0.24, -0.28), (-0.14, -0.48), (0.0, -0.58), (0.14, -0.48), (0.24, -0.28), (0.27, 0.0)]
    outline = shield + [(0.27, 0.06), (-0.27, 0.06)]
    turn = Matrix.Translation((x0, 2.36, 1.6)) @ Matrix.Rotation(math.pi / 2, 4, "Y")
    placed(b, turn, lambda: b.prism(list(reversed(outline)), 0.0, 0.035, "wool", "rack/shield", grain=(0, 1, 0)))
    pale = [(-0.06, 0.06), (-0.06, -0.55), (0.0, -0.58), (0.06, -0.55), (0.06, 0.06)]
    placed(b, turn, lambda: b.prism(list(reversed(pale)), 0.035, 0.04, "dye", "rack/shield-pale", grain=(0, 1, 0)))
    placed(b, turn @ Matrix.Translation((0, -0.2, 0.04)) @ Matrix.Rotation(math.pi / 2, 4, "X"),
           lambda: S["lathe"](b, [(-0.001, 0.07), (0.02, 0.06), (0.04, 0)], 8, "iron", "rack/shield-boss"))


FURNITURE = {"bed": bed, "chest": chest, "table": table, "bench": bench, "chair": chair, "hearth": hearth,
             "log-stack": log_stack, "weapon-rack": weapon_rack}
BARREL = (3.24, -2.24)


def build_furniture(collection):
    nodes = []
    for name, fn in FURNITURE.items():
        b = K["Builder"](name)
        fn(b)
        b.finish(collection)
        nodes.append(name)
    root, _ = S["build"]("barrel", collection, (BARREL[0], 0, BARREL[1]), 0)
    bake([root] + list(root.children_recursive), "barrel", collection)
    nodes.append("barrel")
    return {"furniture": sorted(nodes), "spots": SPOTS}


# ---------------------------------------------------------------- collision

def world_box(objects):
    bpy.context.view_layer.update()
    points = [o.matrix_world @ v.co for o in objects if o.type == "MESH" for v in o.data.vertices]
    gltf = [(p.x, p.z, -p.y) for p in points]
    return [min(p[i] for p in gltf) for i in range(3)], [max(p[i] for p in gltf) for i in range(3)]


def build_collision(collection):
    boxes = [
        ("wall", "front.left", (-W / 2, 0, IZ), (DOOR_X[0], 3.2, D / 2)),
        ("wall", "front.right", (DOOR_X[1], 0, IZ), (W / 2, 3.2, D / 2)),
        ("wall", "front.lintel", (DOOR_X[0], DOOR_H, IZ), (DOOR_X[1], 3.2, D / 2)),
        ("wall", "back", (-W / 2, 0, -D / 2), (W / 2, 3.2, -IZ)),
        ("wall", "left", (-W / 2, 0, -IZ), (-IX, 3.2, IZ)),
        ("wall", "right", (IX, 0, -IZ), (W / 2, 3.2, IZ)),
        ("floor", "interior", (-IX, 0, -IZ), (IX, FLOOR_TOP, IZ)),
    ]
    # The outside chimney, measured on the kit's module.
    scratch = bpy.data.collections.new("marshal-house.scratch")
    bpy.context.scene.collection.children.link(scratch)
    for item in house_items():
        if module_of(item) == "chimney":
            root, _ = K["build"]("chimney", scratch, tuple(item["translation"]), "shingle", item["yawDegrees"])
            lo, hi = world_box(list(root.children_recursive))
            boxes.append(("wall", "chimney", lo, hi))
    door_root, door = K["build"]("door", scratch)
    leaf = next(p for p in door["collisionProxies"] if p["tag"] == "dynamic-door")
    boxes.append(("door", "leaf", [leaf["center"][i] - leaf["size"][i] / 2 for i in range(3)], [leaf["center"][i] + leaf["size"][i] / 2 for i in range(3)]))
    build_furniture(scratch)
    for name in list(FURNITURE) + ["barrel"]:
        lo, hi = world_box([bpy.data.objects[name]])
        boxes.append(("furniture", name, lo, hi))
    for o in list(scratch.all_objects):
        bpy.data.objects.remove(o)
    bpy.data.collections.remove(scratch)
    for tag, name, lo, hi in boxes:
        b = K["Builder"](f"collider.{tag}.{name}")
        b.box(r6(lo), r6(hi), "soot", f"collider/{name}")
        b.finish(collection)
    return {"colliders": len(boxes)}


BUILDERS = {"shell": build_shell, "ceiling": build_ceiling, "roof": build_roof, "door": build_door,
            "furniture": build_furniture, "collision": build_collision}


def build(part, collection):
    if part not in BUILDERS:
        raise ValueError(f"marshal-house part must be one of {', '.join(PARTS)}")
    return BUILDERS[part](collection)


def validate(arguments, inputs):
    if not isinstance(arguments, dict) or arguments.get("schemaVersion") != 1 or set(arguments) != {"schemaVersion", "part"}:
        raise ValueError("marshal-house arguments must be {schemaVersion: 1, part}")
    if arguments["part"] not in PARTS:
        raise ValueError(f"marshal-house part must be one of {', '.join(PARTS)}")
    if set(inputs) != {"outpost", "settlement"}:
        raise ValueError("marshal-house recipe takes exactly the inputs 'outpost' (outpost.py) and 'settlement' (settlement_props.py)")


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    use_sources(inputs.load_source("outpost"), inputs.load_source("settlement"))
    part = arguments["part"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    collection = bpy.context.scene.collection
    info = build(part, collection)
    objects = list(collection.all_objects)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    triangles = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects if o.type == "MESH")
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=True,
        export_vertex_color="NONE", export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "greyhaven-marshal-house-v1", "part": part, "unit": "meter", "axes": "right-handed-y-up",
            "origin": "footprint-base-center", "facing": "+Z", "triangleCount": triangles, **info}
