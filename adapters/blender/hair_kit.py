"""Hair and beard kit (#517): the authored hairstyles and beards as static meshes wearing the pack's hair material.

The hand-modelled pieces are authored geometry in ``assets/authored/hair-kit.blend`` (the declared input ``kit``,
Decision 3.1.3): collection ``hair.kit.hair`` holds ``hair.balding``, ``hair.receding``, ``hair.swept`` and
``hair.tied``; collection ``hair.kit.beards`` holds ``beard.full``, ``beard.long``, ``beard.short``, ``beard.goatee``,
``beard.moustache`` and ``beard.walrus``. Every object sits at identity in the male Ranger's rest model space
(Blender's Z-up frame of the glTF character), with its UVs in the strand column of the pack's ``T_Hair_1`` and a JSON
custom property ``hairkit`` naming its material slots in order. The ``.blend`` holds no third-party bytes: materials in
it are placeholders, and the real ``MI_Hair_1`` comes from the declared input ``material`` (the pack's Hair_Buzzed,
through the Ranger's import). ``hair.tie`` is a factor-only leather material.

``arguments["output"]`` selects ``hair`` or ``beards``. The build adds the age and build keys, the head skin and the
accessory chains after this recipe (``scripts/build-hair-kit.ts``), so the output is just the fitted, textured meshes.
No randomness is used.
"""
import json

import bpy

OUTPUTS = {"hair": "hair.kit.hair", "beards": "hair.kit.beards"}
PROPERTY = "hairkit"
TIE = ((.06, .03, .015, 1), .7)


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "output"}:
        raise ValueError("the hair kit requires exactly schemaVersion and output")
    if type(p["schemaVersion"]) is not int or p["schemaVersion"] != 1:
        raise ValueError("the hair kit schemaVersion must be 1")
    if p["output"] not in OUTPUTS:
        raise ValueError(f"the hair kit output must be one of {sorted(OUTPUTS)}")
    if set(inputs) != {"kit", "material"}:
        raise ValueError("the hair kit takes exactly the inputs kit (hair-kit.blend) and material")


def triangle_count(mesh):
    return sum(len(p.vertices) - 2 for p in mesh.polygons)


def hair_material(path):
    """The pack hairstyle's ``MI_Hair_1`` (T_Hair_1 base colour and normal map); the import's objects are dropped."""
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=path, bone_heuristic="BLENDER", guess_original_bind_pose=False)
    imported = [o for o in bpy.context.scene.objects if o not in before]
    material = next((m for o in imported if o.type == "MESH" for m in o.data.materials if m and m.name.startswith("MI_Hair_1")), None)
    if material is None:
        raise ValueError("the material input has no MI_Hair_1")
    material.name = "MI_Hair_1"
    for o in imported:
        bpy.data.objects.remove(o, do_unlink=True)
    return material


def tie_material():
    material = bpy.data.materials.new("hair.tie")
    material.use_nodes = True
    shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = TIE[0]
    shader.inputs["Roughness"].default_value = TIE[1]
    return material


def load_collection(path, name):
    with bpy.data.libraries.load(path, link=False) as (source, target):
        if name not in source.collections:
            raise ValueError(f"{path} has no collection {name}")
        target.collections = [name]
    loaded = target.collections[0]
    objects = sorted(loaded.all_objects, key=lambda o: o.name)
    for obj in objects:
        bpy.context.scene.collection.objects.link(obj)
        if obj.type != "MESH" or PROPERTY not in obj:
            raise ValueError(f"{name}: {obj.name} must be a mesh with the '{PROPERTY}' property")
        for placeholder in obj.data.materials:
            if placeholder and not placeholder.name.endswith(".authored"):
                placeholder.name = f"{placeholder.name}.authored"
    bpy.data.collections.remove(loaded)
    return objects


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    hair = hair_material(inputs["material"])
    tie = None
    pieces = []
    objects = load_collection(inputs["kit"], OUTPUTS[arguments["output"]])
    for obj in objects:
        if any(abs(a - b) > 1e-6 for row_a, row_b in zip(obj.matrix_world, ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))) for a, b in zip(row_a, row_b)):
            raise ValueError(f"{obj.name} must sit at identity in the character's rest space")
        if not obj.data.uv_layers:
            raise ValueError(f"{obj.name} has no UVs")
        names = json.loads(obj[PROPERTY])["materials"]
        if len(names) != len(obj.data.materials):
            raise ValueError(f"{obj.name} names {len(names)} materials for {len(obj.data.materials)} slots")
        for index, name in enumerate(names):
            if name == "MI_Hair_1":
                obj.data.materials[index] = hair
            elif name == "hair.tie":
                tie = tie or tie_material()
                obj.data.materials[index] = tie
            else:
                raise ValueError(f"{obj.name} wears the unknown material {name}")
        obj.vertex_groups.clear()
        obj.modifiers.clear()
        pieces.append({"node": obj.name, "materials": names, "triangles": triangle_count(obj.data)})
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True, export_texcoords=True,
        export_normals=True, export_tangents=False, export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False, export_image_format="AUTO")
    return {"recipe": "hair-kit-v1", "output": arguments["output"], "pieces": pieces}
