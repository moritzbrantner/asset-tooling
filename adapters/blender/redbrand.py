"""Redbrand faction kit (#517): the authored Redbrand garments and plates, skinned and finished on the Ranger rig.

The look is the Redbrand bandit's from the armour recipe (#389): a rough dark oxblood long coat to mid-calf, its hem
worn ragged, with long sleeves over brown work trousers and the Peasant boots, the band's red scarf in the
recolourable ``faction`` slot, a leather belt and leather bracers. The geometry is no longer fitted by ``armor.py``.
It is hand-authored in ``assets/authored/redbrand-kit.blend`` (the declared input ``kit``), first seeded from
``armor.py``'s redbrand output and then shaped in Blender (Decision 3.1.3):

- collection ``redbrand.cloth``: one mesh object per garment node (``redbrand.coat``, ``redbrand.coat-skirt``,
  ``redbrand.trousers``, ``redbrand.sleeves``, ``redbrand.scarf``, ``redbrand.scarf-end``). Each carries its skin
  weights as vertex groups named by the Ranger's joints.
- collection ``redbrand.plates``: one mesh object per rigid piece (``redbrand.belt``, ``redbrand.bracer_l``,
  ``redbrand.bracer_r``) with its UVs.

Every object sits at identity, in the character's rest model space (Blender's Z-up frame of the glTF character).
Its JSON custom property ``redbrand`` names the piece it belongs to, its material slots in order, the base nodes it
hides and, for a plate, the joint it rides. Materials in the ``.blend`` are placeholders. ``armor.py`` (the declared
Python input ``armor``) gives the factor-only palette and the plates' occlusion bake, so the kit keeps the armour
recipe's materials.

``arguments["output"]`` selects ``cloth`` (the garments skinned to the target's own armature, for
``scene.compose.skinned.gltf@1``) or ``plates`` (the rigid pieces with a baked occlusion map each). The declared input
``target`` is the fit target: the Peasant outfit and the head on the Ranger's 65-joint skeleton, without textures. The
observations have the shape of ``armor.py``'s, so the build treats both alike. No randomness is used.
"""
import json

import bpy

OUTPUTS = ("plates", "cloth")
COLLECTIONS = {"plates": "redbrand.plates", "cloth": "redbrand.cloth"}
PROPERTY = "redbrand"
GEOMETRY = {"path": None}


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "output"}:
        raise ValueError("redbrand requires exactly schemaVersion and output")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("redbrand schemaVersion must be 1")
    if p["output"] not in OUTPUTS:
        raise ValueError("redbrand output must be plates or cloth")
    if set(inputs) != {"target", "kit", "armor"}:
        raise ValueError("redbrand takes exactly the declared inputs target, kit (redbrand-kit.blend) and armor (armor.py)")


def use_geometry(path):
    """Bind the authored geometry (a live Blender session can call this with the repository's .blend)."""
    GEOMETRY["path"] = path


def load_collection(name, collection):
    """Append collection ``name`` of the authored geometry into ``collection``; its objects by name, with their
    ``redbrand`` properties. Placeholder materials are renamed ``<name>.authored`` so the palette keeps its names."""
    with bpy.data.libraries.load(GEOMETRY["path"], link=False) as (source, target):
        if name not in source.collections:
            raise ValueError(f"{GEOMETRY['path']} has no collection {name}")
        target.collections = [name]
    loaded = target.collections[0]
    objects = sorted(loaded.all_objects, key=lambda o: o.name)
    for obj in objects:
        collection.objects.link(obj)
        if obj.type != "MESH" or PROPERTY not in obj:
            raise ValueError(f"{name}: {obj.name} must be a mesh with the '{PROPERTY}' property")
        for placeholder in obj.data.materials:
            if placeholder and not placeholder.name.endswith(".authored"):
                placeholder.name = f"{placeholder.name}.authored"
    bpy.data.collections.remove(loaded)
    return [(obj, json.loads(obj[PROPERTY])) for obj in objects]


def triangle_count(mesh):
    return sum(len(p.vertices) - 2 for p in mesh.polygons)


def bounds(obj):
    points = [obj.matrix_world @ v.co for v in obj.data.vertices]
    gltf = [(p.x, p.z, -p.y) for p in points]
    return {"min": [round(min(p[i] for p in gltf), 6) for i in range(3)], "max": [round(max(p[i] for p in gltf), 6) for i in range(3)]}


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    armor = inputs.load_source("armor")
    use_geometry(inputs["kit"])
    output = arguments["output"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=inputs["target"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
    rigs = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    if len(rigs) != 1:
        raise ValueError("the target GLB must have one armature")
    rig_object = rigs[0]
    bones = {bone.name for bone in rig_object.data.bones}
    authored = load_collection(COLLECTIONS[output], bpy.context.scene.collection)
    palette = {}

    def slot(name):
        if name not in palette:
            palette[name] = armor["material"](name)
        return palette[name]

    exported, pieces, grouped = [], [], {}
    for obj, meta in authored:
        if any(abs(a - b) > 1e-6 for row_a, row_b in zip(obj.matrix_world, ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))) for a, b in zip(row_a, row_b)):
            raise ValueError(f"{obj.name} must sit at identity in the character's rest space")
        if len(meta["materials"]) != len(obj.data.materials):
            raise ValueError(f"{obj.name} names {len(meta['materials'])} materials for {len(obj.data.materials)} slots")
        bases = [slot(name) for name in meta["materials"]]
        for index, base in enumerate(bases):
            obj.data.materials[index] = base
        exported.append(obj)
        if output == "plates":
            if meta["joint"] not in bones:
                raise ValueError(f"{obj.name} rides joint {meta['joint']}, which the target rig lacks")
            obj.modifiers.clear()
            obj.vertex_groups.clear()
            armor["bake_ambient_occlusion"](obj, bases)
            pieces.append({"node": obj.name, "kind": "rigid", "joint": meta["joint"], "materials": [m.name for m in obj.data.materials],
                           "triangleCount": triangle_count(obj.data), "bounds": bounds(obj), "hides": list(meta.get("hides", []))})
        else:
            missing = sorted({group.name for group in obj.vertex_groups} - bones)
            if missing or not obj.vertex_groups:
                raise ValueError(f"{obj.name} must be weighted to the target's joints (unknown: {', '.join(missing)})")
            obj.modifiers.clear()
            obj.parent = rig_object
            obj.matrix_parent_inverse = rig_object.matrix_world.inverted()
            modifier = obj.modifiers.new("Armature", "ARMATURE")
            modifier.object = rig_object
            piece = grouped.setdefault(meta["piece"], {"node": meta["piece"], "kind": "skinned", "nodes": [], "materials": [],
                                                       "triangleCount": 0, "points": [], "hides": list(meta.get("hides", []))})
            piece["nodes"].append(obj.name)
            piece["materials"] += [name for name in meta["materials"] if name not in piece["materials"]]
            piece["triangleCount"] += triangle_count(obj.data)
            piece["points"].append(bounds(obj))
    for name in sorted(grouped):
        piece = grouped[name]
        boxes = piece.pop("points")
        piece["nodes"].sort()
        piece["bounds"] = {"min": [min(b["min"][i] for b in boxes) for i in range(3)], "max": [max(b["max"][i] for b in boxes) for i in range(3)]}
        pieces.append(piece)
    if output == "cloth":
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
    return {"recipe": "redbrand-kit-v1", "kit": "redbrand", "output": output, "unit": "meter", "axes": "right-handed-y-up",
            "space": "character-rest", "pieces": pieces, "factionMaterial": "faction", "geometrySha256": armor["geometry_hash"](meshes)}
