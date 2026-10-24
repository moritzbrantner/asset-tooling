"""Greyhaven ambient animals: a cat, a dog and a small rodent from CC0 Quaternius sources (#364, mmorpg#419).

The declared ``source`` input is one catalog payload: the Animal Pack Vol.2 ``Cat.blend``, the Ultimate Animated
Animals ``ShibaInu.glb`` or the Easy Enemy ``Rat.glb``. The recipe keeps the skinned mesh, its armature and two
in-place clips, renamed ``Idle`` and ``Walk``. A new root node ``greyhaven.ambient.<animal>`` scales the animal to
its Greyhaven size in metres (measured at the first Idle frame), turns its head to glTF +Z and puts the centre of
its footprint on the ground at the origin. The rodent's grey fur becomes brown, so it does not read as mmorpg's
hostile grey Rat. Nothing else of the source changes: no remeshing, no re-rigging, no new clips.

``prepare(animal, source_path)`` also runs in a live Blender session, which is how the sizes were reviewed at
Greyhaven's game camera.
"""
import math

import bpy
from mathutils import Vector

# size: (measured axis, metres). "height" is the top of the idle pose; "length" its longest horizontal extent.
ANIMALS = {
    "cat": {"format": "blend", "armature": "CatArmature", "clips": {"Idle": "Idle", "Walk": "Walking"},
            "turn": -90.0, "size": ("height", 0.45)},
    "dog": {"format": "glb", "armature": "AnimalArmature", "clips": {"Idle": "AnimalArmature|Idle", "Walk": "AnimalArmature|Walk"},
            "turn": 0.0, "size": ("height", 0.65)},
    "rodent": {"format": "glb", "armature": "RatArmature", "clips": {"Idle": "RatArmature|Rat_Idle", "Walk": "RatArmature|Rat_Walk"},
               "turn": 0.0, "size": ("length", 0.5), "tint": {"Grey": (0.2, 0.12, 0.07, 1.0)}},
}


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "animal"} or p["schemaVersion"] != 1 or p["animal"] not in ANIMALS:
        raise ValueError(f"ambient animals takes schemaVersion 1 and an animal of {sorted(ANIMALS)}")
    if set(inputs) != {"source"}:
        raise ValueError("ambient animals takes exactly the declared input source")


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


def load(spec, source_path):
    if spec["format"] == "glb":
        bpy.ops.import_scene.gltf(filepath=source_path)
        return
    with bpy.data.libraries.load(source_path) as (source, target):
        target.objects = [name for name in source.objects if name in (spec["armature"], "Cat")]
        target.actions = list(spec["clips"].values())
    for obj in target.objects:
        bpy.context.scene.collection.objects.link(obj)


def prepare(animal, source_path):
    """Load and normalise ``animal`` into the current scene; return its root and measurements."""
    spec = ANIMALS[animal]
    before_objects, before_actions = set(bpy.data.objects), set(bpy.data.actions)
    load(spec, source_path)
    loaded = [obj for obj in bpy.data.objects if obj not in before_objects]
    armature = next(obj for obj in loaded if obj.type == "ARMATURE" and obj.name.startswith(spec["armature"]))
    meshes = [obj for obj in loaded if obj.type == "MESH" and obj.find_armature() == armature]
    if not meshes:
        raise ValueError(f"{animal}: no mesh is skinned to {armature.name}")
    # Keep the armature's own ancestor chain (glTF RootNode) and the skinned meshes; drop bone-tip empties and the
    # importer's bone-shape icosphere.
    keep = set(meshes) | {armature}
    parent = armature.parent
    while parent:
        keep.add(parent)
        parent = parent.parent
    for obj in loaded:
        if obj not in keep:
            bpy.data.objects.remove(obj)
    actions = {name: next(a for a in bpy.data.actions if a not in before_actions and a.name == source)
               for name, source in spec["clips"].items()}
    for action in [a for a in bpy.data.actions if a not in before_actions and a not in actions.values()]:
        bpy.data.actions.remove(action)
    for name, action in actions.items():
        action.name = name
        action.use_fake_user = True
    # Animal Pack Vol.2 shades with Diffuse BSDF nodes, whose colour the glTF exporter ignores; carry it to a matte
    # Principled BSDF so the cat keeps its colours.
    for material in {slot.material for mesh in meshes for slot in mesh.material_slots if slot.material}:
        nodes = material.node_tree.nodes
        diffuse = next((n for n in nodes if n.type == "BSDF_DIFFUSE"), None)
        if diffuse is None or any(n.type == "BSDF_PRINCIPLED" for n in nodes):
            continue
        principled = nodes.new("ShaderNodeBsdfPrincipled")
        principled.inputs["Base Color"].default_value = diffuse.inputs["Color"].default_value
        principled.inputs["Roughness"].default_value = 0.8
        principled.inputs["Metallic"].default_value = 0.0
        output = next(n for n in nodes if n.type == "OUTPUT_MATERIAL")
        material.node_tree.links.new(principled.outputs[0], output.inputs[0])
        nodes.remove(diffuse)
    for material, colour in spec.get("tint", {}).items():
        node = next(n for n in bpy.data.materials[material].node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        node.inputs["Base Color"].default_value = colour

    root = bpy.data.objects.new(f"greyhaven.ambient.{animal}", None)
    bpy.context.scene.collection.objects.link(root)
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
    scene.render.fps, scene.render.fps_base = 24, 1.0
    root, armature, meshes, actions, measured = prepare(animal, inputs["source"])
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
        "recipe": "ambient-animals-v1", "animal": animal, "root": root.name, "armature": armature.name,
        "joints": len(armature.data.bones), "meshes": sorted(m.name for m in meshes),
        "materials": sorted({s.material.name for m in meshes for s in m.material_slots if s.material}),
        "idleBounds": {"min": gltf(Vector((low.x, high.y, low.z))), "max": gltf(Vector((high.x, low.y, high.z)))},
        "scale": round(root.scale.x, 6), "turnDegrees": ANIMALS[animal]["turn"],
        "clips": {name: {"frames": frames, "fps": scene.render.fps} for name, frames in measured["frames"].items()},
        "walkTravel": round(measured["travel"], 4),
    }
