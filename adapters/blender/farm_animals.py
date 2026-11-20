"""Greyhaven farm animals: a cow, a horse, a donkey, a pig, a sheep, a goat and a chicken for Greyhaven's farms and villages.

Five animals come from CC0 Quaternius sources, each the declared ``source`` input: the Ultimate Animated Animals
``Cow.glb``, ``Horse.glb`` and ``Donkey.glb``, and the Farm Animals ``Pig.blend`` and ``Sheep.blend``. The recipe keeps
their skinned mesh, armature and the authored clips it needs, renamed ``Idle``, ``Walk`` and, where the source has one,
``Eat`` (head down grazing). No CC0 Quaternius goat or chicken exists, so those two are original: low-poly rigid parts
on a small armature, every vertex weighted fully to one bone, with scripted ``Idle``, ``Walk`` and ``Eat`` loops.

Like the ambient animals (docs/greyhaven-ambient-animals.md): a new root node ``greyhaven.farm.<animal>`` scales the
animal to its Greyhaven size in metres (measured at the first Idle frame), turns its head to glTF +Z and puts the centre
of its footprint on the ground at the origin. Every clip loops in place. Farm Animals shades with Diffuse BSDF nodes,
which the glTF exporter ignores; their colour moves to a matte Principled BSDF. Every material ships nonmetallic, coats,
wool, skin, feathers and horns with a generated detail texture (``ORGANIC``, #781). There is no randomness.

``prepare(animal, source_path)`` also runs in a live Blender session (``source_path`` is ``None`` for the goat and the
chicken).
"""
import math

import bmesh
import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

FPS = 24
# size: (measured axis, metres). "height" is the top of the idle pose. turn: degrees about Blender +Z to face glTF +Z.
ANIMALS = {
    "cow": {"format": "glb", "armature": "AnimalArmature", "turn": 0.0, "size": ("height", 1.55),
            "clips": {"Idle": "AnimalArmature|Idle", "Walk": "AnimalArmature|Walk", "Eat": "AnimalArmature|Eating"}},
    "horse": {"format": "glb", "armature": "AnimalArmature", "turn": 0.0, "size": ("height", 1.8),
              "clips": {"Idle": "AnimalArmature|Idle", "Walk": "AnimalArmature|Walk", "Eat": "AnimalArmature|Eating"}},
    "donkey": {"format": "glb", "armature": "AnimalArmature", "turn": 0.0, "size": ("height", 1.4),
               "clips": {"Idle": "AnimalArmature|Idle", "Walk": "AnimalArmature|Walk", "Eat": "AnimalArmature|Eating"}},
    "pig": {"format": "blend", "armature": "Armature", "mesh": "Pig", "turn": 0.0, "size": ("height", 0.7),
            "clips": {"Idle": "Idle", "Walk": "Walk"}},
    "sheep": {"format": "blend", "armature": "Armature", "mesh": "Sheep", "turn": 0.0, "size": ("height", 1.0),
              "clips": {"Idle": "Idle", "Walk": "Walk"}},
    "goat": {"format": "authored", "turn": -90.0, "size": ("height", 0.95)},
    "chicken": {"format": "authored", "turn": -90.0, "size": ("height", 0.45)},
}


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "animal"} or p["schemaVersion"] != 1 or p["animal"] not in ANIMALS:
        raise ValueError(f"farm animals takes schemaVersion 1 and an animal of {sorted(ANIMALS)}")
    expected = set() if ANIMALS[p["animal"]]["format"] == "authored" else {"source"}
    if set(inputs) != expected:
        raise ValueError(f"farm animal {p['animal']} takes exactly the inputs {sorted(expected)}")


def slot_for(owner, action):
    animation = owner.animation_data or owner.animation_data_create()
    animation.action = action
    slots = getattr(animation, "action_suitable_slots", None)
    if slots:
        animation.action_slot = slots[0]


def bounds(meshes):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    low, high = Vector((math.inf,) * 3), Vector((-math.inf,) * 3)
    for mesh in meshes:
        evaluated = mesh.evaluated_get(depsgraph)
        data = evaluated.to_mesh()
        for vertex in data.vertices:
            point = evaluated.matrix_world @ vertex.co
            low = Vector(map(min, low, point))
            high = Vector(map(max, high, point))
        evaluated.to_mesh_clear()
    return low, high


def principled_from_diffuse(material):
    """Point the active output at a matte Principled BSDF carrying the Diffuse BSDF's colour."""
    nodes = material.node_tree.nodes
    output = next((n for n in nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    if output is None or not output.inputs[0].links:
        return
    shader = output.inputs[0].links[0].from_node
    if shader.type != "BSDF_DIFFUSE":
        return
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Base Color"].default_value = shader.inputs["Color"].default_value
    principled.inputs["Roughness"].default_value = 0.8
    principled.inputs["Metallic"].default_value = 0.0
    material.node_tree.links.new(principled.outputs[0], output.inputs[0])


# ---------------------------------------------------------------- sourced animals

def load_source(animal, spec, source_path):
    before_objects, before_actions = set(bpy.data.objects), set(bpy.data.actions)
    if spec["format"] == "glb":
        bpy.ops.import_scene.gltf(filepath=source_path)
        found = lambda source: next(a for a in bpy.data.actions if a not in before_actions and a.name == source)
    else:
        with bpy.data.libraries.load(source_path) as (source, target):
            target.objects = [name for name in source.objects if name in (spec["armature"], spec["mesh"])]
            target.actions = list(spec["clips"].values())
        for obj in target.objects:
            bpy.context.scene.collection.objects.link(obj)
        # The appended datablocks, whatever names they got beside dependencies the objects brought along.
        appended = dict(zip(spec["clips"].values(), target.actions))
        found = lambda source: appended[source]
    loaded = [obj for obj in bpy.data.objects if obj not in before_objects]
    armature = next(obj for obj in loaded if obj.type == "ARMATURE" and obj.name.startswith(spec["armature"]))
    meshes = [obj for obj in loaded if obj.type == "MESH" and obj.find_armature() == armature]
    if not meshes:
        raise ValueError(f"{animal}: no mesh is skinned to {armature.name}")
    # Keep the armature's ancestor chain (glTF RootNode) and the skinned meshes; drop bone-tip empties and the
    # importer's bone-shape icosphere.
    keep = set(meshes) | {armature}
    parent = armature.parent
    while parent:
        keep.add(parent)
        parent = parent.parent
    for obj in loaded:
        if obj not in keep:
            bpy.data.objects.remove(obj)
    actions = {name: found(source) for name, source in spec["clips"].items()}
    for action in [a for a in bpy.data.actions if a not in before_actions and a not in actions.values()]:
        bpy.data.actions.remove(action)
    for material in {slot.material for mesh in meshes for slot in mesh.material_slots if slot.material}:
        principled_from_diffuse(material)
    return armature, meshes, actions


# ---------------------------------------------------------------- authored animals (Blender axes: +X forward, +Z up)

def colour_material(name, srgb, roughness=0.8):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    node = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    node.inputs["Base Color"].default_value = (*(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb), 1.0)
    node.inputs["Roughness"].default_value = roughness
    node.inputs["Metallic"].default_value = 0.0
    return material


class Rig:
    """Rigid parts in one bmesh, each part weighted fully to one bone."""

    def __init__(self, name, palette, bones):
        self.name, self.bones = name, bones  # bones: [(name, head, tail, parent)]
        self.materials = [colour_material(f"{name}-{key}", rgb) for key, rgb in palette.items()]
        self.index = {key: i for i, key in enumerate(palette)}
        self.groups = [b[0] for b in bones]
        self.bm = bmesh.new()
        self.deform = self.bm.verts.layers.deform.verify()

    def _own(self, made, bone, mat):
        verts = [e for e in made if isinstance(e, bmesh.types.BMVert)]
        g = self.groups.index(bone)
        for v in verts:
            v[self.deform][g] = 1.0
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = self.index[mat]

    def ellipsoid(self, bone, mat, center, radii, rotation=(0, 0, 0), segments=8, rings=5):
        m = Matrix.Translation(center) @ Euler(rotation).to_matrix().to_4x4() @ Matrix.Diagonal((*radii, 1.0))
        made = bmesh.ops.create_uvsphere(self.bm, u_segments=segments, v_segments=rings, radius=1.0, matrix=m)["verts"]
        self._own(made, bone, mat)

    def tube(self, bone, mat, a, b, r0, r1, segments=6):
        a, b = Vector(a), Vector(b)
        d = b - a
        m = Matrix.Translation((a + b) / 2) @ Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
        made = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segments, radius1=r0, radius2=r1, depth=d.length, matrix=m)["verts"]
        self._own(made, bone, mat)

    def finish(self, collection):
        arm_data = bpy.data.armatures.new(f"{self.name}Armature")
        armature = bpy.data.objects.new(f"{self.name}Armature", arm_data)
        collection.objects.link(armature)
        bpy.context.view_layer.objects.active = armature
        bpy.ops.object.mode_set(mode="EDIT")
        edit = {}
        for name, head, tail, parent in self.bones:
            bone = arm_data.edit_bones.new(name)
            bone.head, bone.tail = head, tail
            bone.roll = 0.0
            if parent:
                bone.parent = edit[parent]
            edit[name] = bone
        bpy.ops.object.mode_set(mode="OBJECT")
        mesh = bpy.data.meshes.new(self.name)
        # bmesh operators emit faces in pointer-hash order, so sort the triangles by position for a byte-identical replay.
        bmesh.ops.triangulate(self.bm, faces=self.bm.faces[:], quad_method="BEAUTY", ngon_method="BEAUTY")
        centre = lambda f: tuple(round(sum(v.co[k] for v in f.verts), 5) for k in range(3))
        order = sorted(self.bm.faces, key=lambda f: (f.material_index, centre(f), sorted(tuple(round(c, 5) for c in v.co) for v in f.verts)))
        rank = {f: i for i, f in enumerate(order)}
        self.bm.faces.sort(key=lambda f: rank[f])
        self.bm.faces.index_update()
        # A planar UV layer (side view) gives the exporter's vertex merging the same keys on every run.
        uv = self.bm.loops.layers.uv.new("UVMap")
        for face in self.bm.faces:
            for loop in face.loops:
                loop[uv].uv = (loop.vert.co.x, loop.vert.co.z)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for material in self.materials:
            mesh.materials.append(material)
        obj = bpy.data.objects.new(self.name, mesh)
        collection.objects.link(obj)
        for group in self.groups:
            obj.vertex_groups.new(name=group)
        obj.parent = armature
        obj.modifiers.new("Armature", "ARMATURE").object = armature
        for pb in armature.pose.bones:
            pb.rotation_mode = "QUATERNION"
        return armature, obj


GOAT_PALETTE = {"coat": (0.86, 0.83, 0.76), "patch": (0.42, 0.32, 0.24), "horn": (0.55, 0.5, 0.42), "dark": (0.08, 0.07, 0.07), "pink": (0.78, 0.58, 0.55)}
LEGS4 = (("FL", 0.22, 1), ("FR", 0.22, -1), ("HL", -0.24, 1), ("HR", -0.24, -1))


def build_goat(collection):
    hip, knee, up = 0.44, 0.22, -0.07  # ``up`` lowers the body, neck and head onto the shorter legs
    z = lambda p: (p[0], p[1], p[2] + up)
    bones = [("Body", z((-0.3, 0, 0.62)), z((0.3, 0, 0.62)), None), ("Neck", z((0.26, 0, 0.7)), z((0.42, 0, 0.96)), "Body"),
             ("Head", z((0.42, 0, 0.96)), z((0.6, 0, 0.88)), "Neck"), ("Tail", z((-0.34, 0, 0.72)), z((-0.39, 0, 0.79)), "Body")]
    for leg, x, s in LEGS4:
        bones += [(f"Leg{leg}", (x, s * 0.1, hip), (x, s * 0.1, knee), "Body"), (f"Shin{leg}", (x, s * 0.1, knee), (x, s * 0.1, 0.0), f"Leg{leg}")]
    r = Rig("Goat", GOAT_PALETTE, bones)
    r.ellipsoid("Body", "coat", z((0, 0, 0.62)), (0.38, 0.18, 0.18), segments=10, rings=6)
    r.ellipsoid("Body", "patch", z((-0.05, 0, 0.71)), (0.25, 0.13, 0.085), segments=8, rings=4)
    r.tube("Neck", "coat", z((0.24, 0, 0.66)), z((0.44, 0, 0.98)), 0.09, 0.065, 7)
    r.ellipsoid("Head", "coat", z((0.5, 0, 0.94)), (0.12, 0.07, 0.075), rotation=(0, 0.45, 0), segments=8, rings=5)
    r.ellipsoid("Head", "pink", z((0.6, 0, 0.87)), (0.05, 0.045, 0.04), segments=6, rings=4)
    r.tube("Head", "coat", z((0.5, 0, 0.84)), z((0.53, 0, 0.74)), 0.025, 0.006, 5)  # beard
    for s in (1, -1):
        r.tube("Head", "horn", z((0.47, s * 0.035, 1.0)), z((0.37, s * 0.065, 1.1)), 0.022, 0.006, 5)
        r.ellipsoid("Head", "coat", z((0.44, s * 0.1, 0.96)), (0.06, 0.02, 0.025), rotation=(s * 0.4, 0, s * 0.5), segments=6, rings=3)
        r.ellipsoid("Head", "dark", z((0.53, s * 0.06, 0.96)), (0.015, 0.012, 0.015), segments=5, rings=3)
    r.tube("Tail", "coat", z((-0.34, 0, 0.72)), z((-0.4, 0, 0.8)), 0.03, 0.01, 5)
    for leg, x, s in LEGS4:
        y = s * 0.1
        r.tube(f"Leg{leg}", "coat", (x, y, hip + 0.08), (x, y, knee - 0.01), 0.06, 0.037, 6)
        r.tube(f"Shin{leg}", "coat", (x, y, knee + 0.01), (x, y, 0.05), 0.034, 0.027, 6)
        r.tube(f"Shin{leg}", "dark", (x, y, 0.06), (x, y, 0.0), 0.031, 0.035, 6)
    return r.finish(collection)


CHICKEN_PALETTE = {"feather": (0.62, 0.36, 0.18), "dark": (0.25, 0.14, 0.08), "comb": (0.75, 0.12, 0.1), "beak": (0.92, 0.7, 0.25), "eye": (0.05, 0.05, 0.05)}


def build_chicken(collection):
    bones = [("Body", (-0.1, 0, 0.24), (0.1, 0, 0.24), None), ("Neck", (0.08, 0, 0.27), (0.14, 0, 0.4), "Body"),
             ("Tail", (-0.12, 0, 0.27), (-0.2, 0, 0.38), "Body"),
             ("WingL", (0.04, 0.1, 0.27), (-0.12, 0.1, 0.24), "Body"), ("WingR", (0.04, -0.1, 0.27), (-0.12, -0.1, 0.24), "Body"),
             ("LegL", (0.0, 0.045, 0.15), (0.0, 0.045, 0.0), "Body"), ("LegR", (0.0, -0.045, 0.15), (0.0, -0.045, 0.0), "Body")]
    r = Rig("Chicken", CHICKEN_PALETTE, bones)
    r.ellipsoid("Body", "feather", (0, 0, 0.24), (0.15, 0.1, 0.11), rotation=(0, -0.2, 0), segments=10, rings=6)
    r.tube("Neck", "feather", (0.08, 0, 0.27), (0.13, 0, 0.36), 0.055, 0.045, 6)
    r.ellipsoid("Neck", "feather", (0.14, 0, 0.38), (0.055, 0.045, 0.05), segments=8, rings=5)
    r.tube("Neck", "beak", (0.18, 0, 0.375), (0.23, 0, 0.365), 0.018, 0.002, 5)
    r.tube("Neck", "comb", (0.12, 0, 0.42), (0.17, 0, 0.44), 0.012, 0.022, 5)
    r.ellipsoid("Neck", "comb", (0.18, 0, 0.34), (0.012, 0.008, 0.022), segments=5, rings=3)
    for s in (1, -1):
        r.ellipsoid("Neck", "eye", (0.165, s * 0.035, 0.39), (0.009, 0.006, 0.009), segments=5, rings=3)
    r.ellipsoid("Tail", "dark", (-0.16, 0, 0.34), (0.06, 0.03, 0.08), rotation=(0, 0.4, 0), segments=6, rings=4)
    for s, wing in ((1, "WingL"), (-1, "WingR")):
        r.ellipsoid(wing, "dark", (-0.03, s * 0.095, 0.26), (0.1, 0.025, 0.06), rotation=(0, -0.2, 0), segments=7, rings=4)
    for s, leg in ((1, "LegL"), (-1, "LegR")):
        y = s * 0.045
        r.tube(leg, "beak", (0.0, y, 0.15), (0.0, y, 0.01), 0.012, 0.009, 5)
        for a in (-0.5, 0.0, 0.5):
            r.tube(leg, "beak", (0.0, y, 0.008), (0.05 * math.cos(a), y + 0.05 * math.sin(a), 0.006), 0.008, 0.004, 4)
        r.tube(leg, "beak", (0.0, y, 0.008), (-0.03, y, 0.006), 0.007, 0.004, 4)
    return r.finish(collection)


# ---------------------------------------------------------------- authored clips

def rot(axis, degrees):
    return Quaternion(Vector(axis), math.radians(degrees))


def key_pose(armature, frame, pose):
    """``pose``: {bone: [(axis, degrees), ...] or ("loc", (x, y, z))}; rotations are in armature axes at rest."""
    for pb in armature.pose.bones:
        rest = pb.bone.matrix_local.to_quaternion()
        q = Quaternion()
        offset = Vector()
        for item in pose.get(pb.name, ()):
            if item[0] == "loc":
                offset += Vector(item[1])
            else:
                q = rot(*item) @ q
        pb.rotation_quaternion = rest.inverted() @ q @ rest
        pb.location = rest.inverted() @ offset
        pb.keyframe_insert("rotation_quaternion", frame=frame)
        pb.keyframe_insert("location", frame=frame)


def wave(u, cycles=1.0, phase=0.0):
    return math.sin(2 * math.pi * (cycles * u + phase))


Y, Z = (0, 1, 0), (0, 0, 1)


def goat_pose(clip, u):
    if clip == "Idle":
        pose = {"Body": [("loc", (0, 0, 0.004 * wave(u, 2)))], "Neck": [(Z, 14 * wave(u, 1, 0.1)), (Y, -4 * wave(u, 1))],
                "Head": [(Y, 5 * wave(u, 2, 0.3))], "Tail": [(Y, -25 + 18 * wave(u, 4))]}
        return pose
    if clip == "Walk":
        pose = {"Body": [("loc", (0, 0, 0.012 * abs(wave(u, 1)))), (Y, 1.5 * wave(u, 2))], "Neck": [(Y, 4 * wave(u, 2, 0.25))],
                "Tail": [(Y, -20 + 8 * wave(u, 2))]}
        for leg, phase in (("HL", 0.0), ("FL", 0.25), ("HR", 0.5), ("FR", 0.75)):
            swing = wave(u, 1, phase)
            pose[f"Leg{leg}"] = [(Y, -24 * swing)]
            pose[f"Shin{leg}"] = [(Y, 32 * max(0.0, wave(u, 1, phase + 0.25)))]
        return pose
    # Eat: head down to the grass, nibbling, the tail still flicking.
    return {"Body": [(Y, 7)], "Neck": [(Y, 108 + 3 * wave(u, 2))], "Head": [(Y, -40 + 7 * wave(u, 6))],
            "LegFL": [(Y, -7)], "LegFR": [(Y, -7)], "Tail": [(Y, -25 + 15 * wave(u, 3))]}


def chicken_pose(clip, u):
    if clip == "Idle":
        look = 30 * wave(u, 1) if (u % 0.5) < 0.4 else 0
        return {"Body": [("loc", (0, 0, 0.003 * wave(u, 2)))], "Neck": [(Z, look), (Y, 6 * wave(u, 3))],
                "Tail": [(Y, -8 * wave(u, 2))], "WingL": [(Z, 3 * wave(u, 2))], "WingR": [(Z, -3 * wave(u, 2))]}
    if clip == "Walk":
        return {"Body": [("loc", (0, 0, 0.01 * abs(wave(u, 1)))), (Z, 4 * wave(u, 1))], "Neck": [(Y, 14 * wave(u, 2))],
                "LegL": [(Y, -32 * wave(u, 1))], "LegR": [(Y, 32 * wave(u, 1))], "Tail": [(Y, -6 * wave(u, 2))],
                "WingL": [(Z, 4 * wave(u, 2))], "WingR": [(Z, -4 * wave(u, 2))]}
    # Eat: tip forward and peck twice, then straighten a little and swallow.
    peck = max(0.0, wave(u, 2)) ** 2
    return {"Body": [(Y, 28 + 6 * peck), ("loc", (0, 0, -0.01))], "Neck": [(Y, 60 + 35 * peck)], "Tail": [(Y, -18)],
            "LegL": [(Y, -18)], "LegR": [(Y, -18)]}


AUTHORED = {"goat": (build_goat, goat_pose, {"Idle": 96, "Walk": 32, "Eat": 72}),
            "chicken": (build_chicken, chicken_pose, {"Idle": 72, "Walk": 16, "Eat": 48})}


def build_authored(animal, collection):
    build, pose_of, frames = AUTHORED[animal]
    armature, mesh = build(collection)
    actions = {}
    for clip, count in frames.items():
        action = bpy.data.actions.new(clip)
        slot_for(armature, action)
        for frame in range(0, count + 1, 2):
            key_pose(armature, frame, pose_of(clip, frame / count))
        actions[clip] = action
    for action in actions.values():
        for fcurve in getattr(action, "fcurves", ()):
            for point in fcurve.keyframe_points:
                point.interpolation = "LINEAR"
    return armature, [mesh], actions


# ---------------------------------------------------------------- organic surface (#781)

# Material -> (detail, metres per texture repeat, roughness); detail None keeps a plain colour. Every material ends
# nonmetallic: the Ultimate Animated Animals GLBs author metallic 0.4 and roughness 0.415 everywhere, which a PBR
# renderer draws as dull metal. Each detailed material multiplies its colour by a small tileable greyscale detail
# texture (glTF baseColorTexture times baseColorFactor), so coat, wool, skin and feathers read as different substances
# at the game camera: short streaked hair, clumped wool locks, soft mottled skin, overlapping feathers and horn rings.
UAA_ORGANIC = {"Main": ("hair", 0.3, 0.9), "Main_Light": ("hair", 0.3, 0.9), "Main_Dark": ("hair", 0.3, 0.9),
               "Muzzle": ("skin", 0.2, 0.75), "Hair": ("hair", 0.16, 0.85), "Horns": ("horn", 0.08, 0.6),
               "Hooves": (None, 0, 0.7), "Eye_Black": (None, 0, 0.3), "Eye_Dark": (None, 0, 0.3), "Eye_White": (None, 0, 0.4)}
ORGANIC = {
    "cow": UAA_ORGANIC, "horse": UAA_ORGANIC, "donkey": UAA_ORGANIC,
    "pig": {"Material.003": ("skin", 0.25, 0.7), "Material.001": (None, 0, 0.7)},
    "sheep": {"White": ("wool", 0.22, 0.95), "Black": ("hair", 0.16, 0.85)},
    "goat": {"Goat-coat": ("hair", 0.22, 0.9), "Goat-patch": ("hair", 0.22, 0.9), "Goat-horn": ("horn", 0.06, 0.6),
             "Goat-dark": (None, 0, 0.6), "Goat-pink": ("skin", 0.1, 0.75)},
    "chicken": {"Chicken-feather": ("feather", 0.14, 0.9), "Chicken-dark": ("feather", 0.1, 0.9), "Chicken-comb": ("skin", 0.06, 0.7),
                "Chicken-beak": (None, 0, 0.6), "Chicken-eye": (None, 0, 0.3)},
}
# These shade smooth within SMOOTH_ANGLE and keep sharp creases (tube caps, hooves) beyond it: the authored animals' rigid
# parts and the pig's faceted skin. The sheep keeps its blocky fleece.
SMOOTHED, SMOOTH_ANGLE = ("goat", "chicken", "pig"), 75.0
DETAIL_SIZE = 128


def lattice(ix, iy, seed):
    h = (ix * 374761393 + iy * 668265263 + seed * 982451653) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def tile_noise(x, y, cells_x, cells_y, seed):
    """Smooth value noise over the unit square that tiles: ``cells_x`` by ``cells_y`` lattice cells."""
    fx, fy = x * cells_x, y * cells_y
    ix, iy = math.floor(fx), math.floor(fy)
    sx, sy = fx - ix, fy - iy
    sx, sy = sx * sx * (3 - 2 * sx), sy * sy * (3 - 2 * sy)
    at = lambda a, b: lattice(a % cells_x, b % cells_y, seed)
    top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx
    bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx
    return top + (bottom - top) * sy


def smoothstep(a, b, v):
    s = min(max((v - a) / (b - a), 0.0), 1.0)
    return s * s * (3 - 2 * s)


def detail_texel(kind, x, y):
    """The linear multiplier (r, g, b) of a detail texture at (x, y) in the unit square; about 0.9 on average."""
    if kind == "hair":  # streaked tufts of short strands along v over a soft mottle, coarse enough to read at the game camera
        n = 0.45 * tile_noise(x, y, 24, 4, 1) + 0.35 * tile_noise(x, y, 48, 8, 2) + 0.2 * tile_noise(x, y, 96, 16, 3)
        b = (0.88 + 0.65 * (n - 0.5)) * (0.88 + 0.22 * tile_noise(x, y, 6, 6, 4))
        return b, b, b * 0.97
    if kind == "wool":  # clumped locks, darker and warmer in the creases between them
        c = 0.5 * tile_noise(x, y, 16, 16, 5) + 0.3 * tile_noise(x, y, 32, 32, 6) + 0.2 * tile_noise(x, y, 64, 64, 7)
        b = 0.68 + 0.34 * smoothstep(0.25, 0.75, c)
        return b, b * (0.95 + 0.05 * b), b * (0.86 + 0.14 * b)
    if kind == "skin":  # soft blotches, ruddier where darker, with a fine pore grain
        m = tile_noise(x, y, 6, 6, 12)
        b = 0.9 + 0.16 * (m - 0.5) + 0.08 * (tile_noise(x, y, 48, 48, 13) - 0.5)
        return b * (1.0 + 0.04 * (0.5 - m)), b, b * (0.97 + 0.06 * m)
    if kind == "feather":  # overlapping rows of round-tipped feathers, darker at each tip's rim, with barbs along v
        row = math.floor(y * 8)
        fx = x * 6 + 0.5 * (row % 2)
        cx, cy = fx - math.floor(fx) - 0.5, y * 8 - row
        rim = smoothstep(0.7, 0.95, cy + 1.2 * cx * cx)
        b = (0.98 - 0.3 * rim + 0.1 * (tile_noise(x, y, 48, 6, 14) - 0.5)) * (0.9 + 0.16 * tile_noise(x, y, 4, 4, 15))
        return b, b * 0.98, b * 0.95
    # horn: growth rings across v, a little uneven, with fine grain
    ring = 0.5 + 0.5 * math.cos(2 * math.pi * (8 * y + 0.3 * tile_noise(x, y, 4, 8, 8)))
    b = 0.8 + 0.16 * ring + 0.22 * (tile_noise(x, y, 32, 16, 9) - 0.5)
    return b, b * 0.98, b * 0.93


def detail_image(name, kind):
    image = bpy.data.images.new(name, DETAIL_SIZE, DETAIL_SIZE, alpha=False)
    srgb = lambda v: 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055
    pixels = []
    for j in range(DETAIL_SIZE):
        for i in range(DETAIL_SIZE):
            pixels += [round(srgb(min(c, 1.0)) * 255) / 255 for c in detail_texel(kind, i / DETAIL_SIZE, j / DETAIL_SIZE)] + [1.0]
    image.pixels = pixels
    image.pack()
    return image


def organic_surface(animal, meshes):
    """Box-project a UV map onto ``meshes`` in metres (call once the animal has its shipped size) and give each material
    its ``ORGANIC`` detail texture, roughness and metallic 0; smooth the ``SMOOTHED`` animals."""
    spec = ORGANIC[animal]
    for obj in meshes:
        mesh = obj.data
        if animal in SMOOTHED:
            mesh.shade_smooth()
            mesh.set_sharp_from_angle(angle=math.radians(SMOOTH_ANGLE))
        layer = mesh.uv_layers.get("UVMap") or mesh.uv_layers.new(name="UVMap")
        normals = obj.matrix_world.to_3x3().inverted().transposed()
        for poly in mesh.polygons:
            material = obj.material_slots[poly.material_index].material if obj.material_slots else None
            _, tile, _ = spec.get(material.name if material else "", (None, 0.3, 0.8))
            tile = tile or 0.3
            n = normals @ poly.normal
            axis = max(range(3), key=lambda k: abs(n[k]))
            for i in poly.loop_indices:
                p = obj.matrix_world @ mesh.vertices[mesh.loops[i].vertex_index].co
                a, b = (p[k] for k in range(3) if k != axis)
                layer.data[i].uv = (a / tile, b / tile)
        if ANIMALS[animal]["format"] == "blend":
            # Farm Animals' vertex colours are all white; the exporter would ship them as two unused attributes.
            for attribute in list(mesh.color_attributes):
                mesh.color_attributes.remove(attribute)
    images = {}
    materials = {slot.material.name: slot.material for obj in meshes for slot in obj.material_slots if slot.material}
    for name in sorted(materials):
        kind, _, roughness = spec.get(name, (None, 0, 0.8))
        # One Principled BSDF on one output. Farm Animals keeps a Diffuse BSDF on its all-renderer output beside an
        # EEVEE Principled one, and the glTF exporter then writes an empty material, which glTF draws white and fully
        # metallic.
        tree = materials[name].node_tree
        output = next(n for n in tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output)
        source = output.inputs[0].links[0].from_node
        colour = tuple(source.inputs["Base Color" if source.type == "BSDF_PRINCIPLED" else "Color"].default_value)
        tree.nodes.clear()
        output = tree.nodes.new("ShaderNodeOutputMaterial")
        shader = tree.nodes.new("ShaderNodeBsdfPrincipled")
        tree.links.new(shader.outputs[0], output.inputs[0])
        shader.inputs["Base Color"].default_value = colour
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Metallic"].default_value = 0.0
        if kind is None:
            continue
        if kind not in images:
            images[kind] = detail_image(f"{animal}-{kind}", kind)
        texture = tree.nodes.new("ShaderNodeTexImage")
        texture.image = images[kind]
        mix = tree.nodes.new("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs[7].default_value = shader.inputs["Base Color"].default_value
        tree.links.new(texture.outputs["Color"], mix.inputs[6])
        tree.links.new(mix.outputs[2], shader.inputs["Base Color"])


# ---------------------------------------------------------------- shared

def prepare(animal, source_path):
    """Load or build ``animal`` into the current scene, normalised; return its root and measurements."""
    spec = ANIMALS[animal]
    collection = bpy.context.scene.collection
    if spec["format"] == "authored":
        armature, meshes, actions = build_authored(animal, collection)
    else:
        armature, meshes, actions = load_source(animal, spec, source_path)
    for name, action in actions.items():
        action.name = name
        action.use_fake_user = True

    root = bpy.data.objects.new(f"greyhaven.farm.{animal}", None)
    collection.objects.link(root)
    top = armature
    while top.parent:
        top = top.parent
    top.parent = root
    root.rotation_euler = (0.0, 0.0, math.radians(spec["turn"]))
    slot_for(armature, actions["Idle"])
    scene = bpy.context.scene
    scene.frame_set(int(actions["Idle"].frame_range[0]))
    bpy.context.view_layer.update()
    low, high = bounds(meshes)
    axis, metres = spec["size"]
    measured = high.z - low.z if axis == "height" else max(high.x - low.x, high.y - low.y)
    root.scale = (metres / measured,) * 3
    bpy.context.view_layer.update()
    low, high = bounds(meshes)
    root.location = Vector((-(low.x + high.x) / 2, -(low.y + high.y) / 2, -low.z))
    bpy.context.view_layer.update()
    low, high = bounds(meshes)
    organic_surface(animal, meshes)

    # In-place check: the walk's horizontal travel of the mesh centre over the clip, in metres.
    slot_for(armature, actions["Walk"])
    start, end = (int(round(v)) for v in actions["Walk"].frame_range)
    centres = []
    for frame in (start, end):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        a, b = bounds(meshes)
        centres.append(((a.x + b.x) / 2, (a.y + b.y) / 2))
    slot_for(armature, actions["Idle"])
    scene.frame_set(int(actions["Idle"].frame_range[0]))
    travel = math.dist(centres[0], centres[1])
    return root, armature, meshes, actions, {
        "low": low, "high": high, "travel": travel,
        "frames": {name: [int(round(v)) for v in action.frame_range] for name, action in actions.items()},
    }


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    animal = arguments["animal"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = FPS, 1.0
    source = inputs["source"] if "source" in inputs else None
    root, armature, meshes, actions, measured = prepare(animal, source)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [root, *root.children_recursive]:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=False, export_optimize_animation_keep_anim_armature=True,
        export_skins=True, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    low, high = measured["low"], measured["high"]
    gltf = lambda v: [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]  # glTF axes
    return {
        "recipe": "farm-animals-v1", "animal": animal, "root": root.name, "armature": armature.name,
        "joints": len(armature.data.bones), "meshes": sorted(m.name for m in meshes),
        "materials": sorted({s.material.name for m in meshes for s in m.material_slots if s.material}),
        "idleBounds": {"min": gltf(Vector((low.x, high.y, low.z))), "max": gltf(Vector((high.x, low.y, high.z)))},
        "scale": round(root.scale.x, 6), "turnDegrees": ANIMALS[animal]["turn"],
        "clips": {name: {"frames": frames, "fps": scene.render.fps} for name, frames in measured["frames"].items()},
        "walkTravel": round(measured["travel"], 4),
    }
