"""Greyhaven ambient animals: a cat, a dog and a small rodent from CC0 Quaternius sources (#364, mmorpg#419).

The declared ``source`` input is one catalog payload: the Animal Pack Vol.2 ``Cat.blend``, the Ultimate Animated
Animals ``ShibaInu.glb`` or the Easy Enemy ``Rat.glb``. The recipe keeps the skinned mesh, its armature and two
in-place clips, renamed ``Idle`` and ``Walk``. A new root node ``greyhaven.ambient.<animal>`` scales the animal to
its Greyhaven size in metres (measured at the first Idle frame), turns its head to glTF +Z and puts the centre of
its footprint on the ground at the origin. The rodent's grey fur becomes brown, so it does not read as mmorpg's
hostile grey Rat. No re-rigging and no new clips.

The cat is refined (mmorpg#799): its faceted 400-face mesh is subdivided once and smooth-shaded, its snout shortened
and amber eyes with slit pupils skinned to the head; its Walk's paws plant, each stance sweeping back in a straight
line at one constant speed over a 32-frame cycle instead of easing in and out, so a consumer that moves it at
``walkStride`` metres per cycle keeps every planted paw still.

Every material ships nonmetallic, with roughness from ``ORGANIC``; coats carry a generated short-hair detail texture
and noses, ears, paws and tails a soft skin one, and the flat-shaded dog and rodent are welded and smooth-shaded (#780).
The cat's near-black fur is lifted to charcoal, still dark, so its hair texture shows.

``prepare(animal, source_path)`` also runs in a live Blender session, which is how the sizes were reviewed at
Greyhaven's game camera.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

# size: (measured axis, metres). "height" is the top of the idle pose; "length" its longest horizontal extent.
ANIMALS = {
    "cat": {"format": "blend", "armature": "CatArmature", "clips": {"Idle": "Idle", "Walk": "Walking"},
            "turn": -90.0, "size": ("height", 0.45),
            "feet": ["IKFrontRight", "IKFrontLeft", "IKBackRight", "IKBackLeft"], "tint": {"Grey": (0.13, 0.12, 0.115, 1.0)}},
    "dog": {"format": "glb", "armature": "AnimalArmature", "clips": {"Idle": "AnimalArmature|Idle", "Walk": "AnimalArmature|Walk"},
            "turn": 0.0, "size": ("height", 0.65)},
    "rodent": {"format": "glb", "armature": "RatArmature", "clips": {"Idle": "RatArmature|Rat_Idle", "Walk": "RatArmature|Rat_Walk"},
               "turn": 0.0, "size": ("length", 0.5), "tint": {"Grey": (0.2, 0.12, 0.07, 1.0)}},
}

# The Animal Pack cat, mesh-local: +X is forward (the nose), +Z up, about 0.1 m a unit.
CAT_HEAD_BONE = "Bone.003"
CAT_SNOUT = (0.4, 0.6)  # the last 0.4 units of the head, shortened to 60 %
CAT_EYES = {"height": 2.92, "spread": 0.25, "radius": 0.14, "iris": (0.78, 0.52, 0.04, 1.0)}
# The cat's Walk: each IK paw's stance keys in the source's 40 frames (frame 40 is frame 0), straightened into one
# linear backward sweep of SWEEP bone units, then the whole clip retimed to FRAMES.
CAT_WALK = {"source": 40, "frames": 32, "sweep": 1.7, "stance": {
    "IKFrontRight": (20, 40), "IKFrontLeft": (0, 10, 20), "IKBackRight": (10, 30), "IKBackLeft": (30, 40, 10)}}


def ellipsoid(bm, shape, slot, around=12, rings=8):
    """A smooth unit UV sphere transformed by ``shape`` into ``bm`` in a fixed vertex and face order (unlike
    ``bmesh.ops.create_uvsphere``, whose loop order varies between runs); returns its vertices."""
    poles = [bm.verts.new(shape @ Vector((0.0, 0.0, z))) for z in (1.0, -1.0)]
    ring = [[bm.verts.new(shape @ Vector((math.sin(v) * math.cos(u), math.sin(v) * math.sin(u), math.cos(v))))
             for u in (math.tau * i / around for i in range(around))]
            for v in (math.pi * j / rings for j in range(1, rings))]
    faces = [(poles[0], ring[0][i - 1], ring[0][i]) for i in range(around)]
    faces += [(a[i], a[i - 1], b[i - 1], b[i]) for a, b in zip(ring, ring[1:]) for i in range(around)]
    faces += [(poles[1], ring[-1][i], ring[-1][i - 1]) for i in range(around)]
    for corners in faces:
        face = bm.faces.new(corners)
        face.material_index, face.smooth = slot, True
    return poles + [vertex for row in ring for vertex in row]


def refine_cat_mesh(mesh, fur):
    """Round the faceted Animal Pack cat into a smooth-shaded one with a shorter snout and amber eyes."""
    data = mesh.data
    head = mesh.vertex_groups[CAT_HEAD_BONE].index
    nose = max(v.co.x for v in data.vertices)
    start = nose - CAT_SNOUT[0]
    for vertex in data.vertices:
        if vertex.co.x > start and any(g.group == head and g.weight > 0.5 for g in vertex.groups):
            vertex.co.x = start + (vertex.co.x - start) * CAT_SNOUT[1]
    subdivision = mesh.modifiers.new("Subdivision", "SUBSURF")
    subdivision.levels = subdivision.render_levels = 1
    with bpy.context.temp_override(object=mesh, active_object=mesh):
        while mesh.modifiers[0] != subdivision:
            bpy.ops.object.modifier_move_up(modifier=subdivision.name)
        bpy.ops.object.modifier_apply(modifier=subdivision.name)
    data.shade_smooth()

    # Eyes: an amber disc in each side of the face, each with a slit pupil in the fur colour, skinned to the head.
    eye = bpy.data.materials.new("Eye")
    eye.use_nodes = True
    principled = next(n for n in eye.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    principled.inputs["Base Color"].default_value = CAT_EYES["iris"]
    principled.inputs["Roughness"].default_value = 0.25
    principled.inputs["Metallic"].default_value = 0.0
    data.materials.append(eye)
    iris_slot, pupil_slot = len(data.materials) - 1, list(data.materials).index(fur)
    tree = BVHTree.FromPolygons([v.co for v in data.vertices], [p.vertices for p in data.polygons])
    bm = bmesh.new()
    bm.from_mesh(data)
    deform = bm.verts.layers.deform.verify()
    radius = CAT_EYES["radius"]
    for side in (1, -1):
        hit, normal, _, _ = tree.ray_cast(Vector((nose + 1.0, side * CAT_EYES["spread"], CAT_EYES["height"])), Vector((-1.0, 0.0, 0.0)))
        if hit is None:
            raise ValueError("cat eye ray missed the head")
        facing = normal.to_track_quat("Z", "Y").to_matrix().to_4x4()
        # (scale across, up and out of the face, in eye radii; depth below the surface; material slot)
        for scale, depth, slot in (((1.0, 0.8, 0.4), 0.1, iris_slot), ((0.2, 0.72, 0.3), -0.05, pupil_slot)):
            shape = Matrix.Translation(hit - normal * radius * depth) @ facing @ Matrix.Diagonal((*(radius * s for s in scale), 1.0))
            for vertex in ellipsoid(bm, shape, slot):
                vertex[deform][head] = 1.0
    bm.to_mesh(data)
    bm.free()
    # Triangulate here, on a fixed diagonal, so the export never depends on how the exporter splits the new quads.
    triangulate = mesh.modifiers.new("Triangulate", "TRIANGULATE")
    triangulate.quad_method, triangulate.ngon_method = "FIXED", "CLIP"
    with bpy.context.temp_override(object=mesh, active_object=mesh):
        while mesh.modifiers[0] != triangulate:
            bpy.ops.object.modifier_move_up(modifier=triangulate.name)
        bpy.ops.object.modifier_apply(modifier=triangulate.name)


def plant_cat_walk(action):
    """Straighten each paw's stance into a constant-speed sweep and retime the walk (see CAT_WALK)."""
    fcurves = action.layers[0].strips[0].channelbag(action.slots[0]).fcurves
    end, sweep = CAT_WALK["source"], CAT_WALK["sweep"]
    alias = lambda frame: [frame, end - frame] if frame in (0, end) else [frame]  # frames 0 and end are one pose
    for bone, keys in CAT_WALK["stance"].items():
        # Bone-local +Y is forward along the body, +Z up; the stance runs front to back on the ground.
        along, up = (fcurves.find(f'pose.bones["{bone}"].location', index=i) for i in (1, 2))
        at = [{round(k.co.x): k for k in curve.keyframe_points} for curve in (along, up)]
        centre, steps = (at[0][keys[0]].co.y + at[0][keys[-1]].co.y) / 2, len(keys) - 1
        for step, key in enumerate(keys):
            for frame in alias(key):
                at[0][frame].co.y = centre + sweep / 2 - sweep * step / steps
                at[1][frame].co.y = 0.0
                if step < steps:
                    at[0][frame].interpolation = at[1][frame].interpolation = "LINEAR"
    retime = CAT_WALK["frames"] / end
    for curve in fcurves:
        for key in curve.keyframe_points:
            for point in (key.co, key.handle_left, key.handle_right):
                point.x *= retime
    for curve in fcurves:
        curve.update()
    action.frame_range = (0, CAT_WALK["frames"])
    action.use_frame_range = True


def stride(armature, feet, action, scene):
    """The walk's metres per cycle and the planted paws' worst slip in metres per frame: the mean speed of a paw on
    the ground (within 0.2 mm of its lowest) times the cycle's frames, measured in the scene after scaling."""
    start, end = (int(round(v)) for v in action.frame_range)
    track = {foot: [] for foot in feet}
    for frame in range(start, end + 1):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        for foot in feet:
            track[foot].append(armature.matrix_world @ armature.pose.bones[foot].head)
    speeds = []
    for points in track.values():
        floor = min(p.z for p in points) + 0.0002
        speeds += [math.dist(a.xy, b.xy) for a, b in zip(points, points[1:]) if a.z <= floor and b.z <= floor]
    mean = sum(speeds) / len(speeds)
    return mean * (end - start), max(abs(s - mean) for s in speeds)


# ---------------------------------------------------------------- organic surface (#780)

# Material -> (detail, metres per texture repeat, roughness); detail None keeps a plain colour. Every animal lists every
# material and every material ships nonmetallic: the dog's and rodent's Quaternius GLBs author metallic 0.4 and roughness
# 0.415, which a PBR renderer draws as dull metal. Each detailed material multiplies its colour by a small tileable
# greyscale detail texture (glTF baseColorTexture times baseColorFactor), so coats read as short hair and noses, ears,
# paws and tails as soft skin at the game camera. The two textures are generated identically for every animal, so the
# bundle carries each once (the approach of the farm animals, #781, and the wildlife, #779).
EYE = (None, 0, 0.3)
ORGANIC = {
    "cat": {"Grey": ("hair", 0.08, 0.9), "White": ("hair", 0.08, 0.9), "Pink": ("skin", 0.04, 0.7), "Eye": (None, 0, 0.25)},
    "dog": {"Main": ("hair", 0.12, 0.9), "Main_Light": ("hair", 0.12, 0.9), "Black": (None, 0, 0.5),
            "Eyes_White": EYE, "Eyes_Pupil": EYE, "Eyes_Black": EYE},
    "rodent": {"Grey": ("hair", 0.06, 0.9), "Pink": ("skin", 0.04, 0.7)},
}
# The dog's and rodent's GLBs are flat-shaded, every triangle its own three vertices. They are welded and shade smooth
# within SMOOTH_ANGLE, keeping sharp creases (paw soles, ear rims) beyond it; the cat is already smooth (#799).
SMOOTH_ANGLE = 75.0
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


def detail_texel(kind, x, y):
    """The linear multiplier (r, g, b) of a detail texture at (x, y) in the unit square; about 0.9 on average."""
    if kind == "hair":  # streaked tufts of short strands along v over a soft mottle, coarse enough to read at the game camera
        n = 0.45 * tile_noise(x, y, 24, 4, 1) + 0.35 * tile_noise(x, y, 48, 8, 2) + 0.2 * tile_noise(x, y, 96, 16, 3)
        b = (0.88 + 0.65 * (n - 0.5)) * (0.88 + 0.22 * tile_noise(x, y, 6, 6, 4))
        return b, b, b * 0.97
    # skin: soft blotches, ruddier where darker, with a fine pore grain
    m = tile_noise(x, y, 6, 6, 12)
    b = 0.9 + 0.16 * (m - 0.5) + 0.08 * (tile_noise(x, y, 48, 48, 13) - 0.5)
    return b * (1.0 + 0.04 * (0.5 - m)), b, b * (0.97 + 0.06 * m)


def detail_image(kind):
    image = bpy.data.images.new(kind, DETAIL_SIZE, DETAIL_SIZE, alpha=False)
    srgb = lambda v: 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055
    pixels = []
    for j in range(DETAIL_SIZE):
        for i in range(DETAIL_SIZE):
            pixels += [round(srgb(min(c, 1.0)) * 255) / 255 for c in detail_texel(kind, i / DETAIL_SIZE, j / DETAIL_SIZE)] + [1.0]
    image.pixels = pixels
    image.pack()
    return image


def organic_surface(animal, meshes):
    """Weld and smooth the flat-shaded GLB meshes, box-project a UV map in metres (call once the animal has its shipped
    size) and give every material its ``ORGANIC`` roughness, metallic 0 and detail texture."""
    spec = ORGANIC[animal]
    missing = sorted({s.material.name for obj in meshes for s in obj.material_slots if s.material} - set(spec))
    if missing:
        raise ValueError(f"{animal}: ORGANIC lists no surface for {missing}")
    for obj in meshes:
        mesh = obj.data
        if ANIMALS[animal]["format"] == "glb":
            bm = bmesh.new()
            bm.from_mesh(mesh)
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
            bm.to_mesh(mesh)
            bm.free()
            with bpy.context.temp_override(object=obj, active_object=obj):
                if mesh.has_custom_normals:
                    bpy.ops.mesh.customdata_custom_splitnormals_clear()
            mesh.shade_smooth()
            mesh.set_sharp_from_angle(angle=math.radians(SMOOTH_ANGLE))
        layer = mesh.uv_layers.get("UVMap") or mesh.uv_layers.new(name="UVMap")
        normals = obj.matrix_world.to_3x3().inverted().transposed()
        for poly in mesh.polygons:
            _, tile, _ = spec[obj.material_slots[poly.material_index].material.name]
            tile = tile or 0.1
            n = normals @ poly.normal
            axis = max(range(3), key=lambda k: abs(n[k]))
            for i in poly.loop_indices:
                p = obj.matrix_world @ mesh.vertices[mesh.loops[i].vertex_index].co
                a, b = (p[k] for k in range(3) if k != axis)
                layer.data[i].uv = (a / tile, b / tile)
    images = {}
    materials = {slot.material.name: slot.material for obj in meshes for slot in obj.material_slots if slot.material}
    for name in sorted(materials):
        kind, _, roughness = spec[name]
        tree = materials[name].node_tree
        shader = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Metallic"].default_value = 0.0
        if kind is None:
            continue
        if kind not in images:
            images[kind] = detail_image(kind)
        texture = tree.nodes.new("ShaderNodeTexImage")
        texture.image = images[kind]
        mix = tree.nodes.new("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs[7].default_value = shader.inputs["Base Color"].default_value
        tree.links.new(texture.outputs["Color"], mix.inputs[6])
        tree.links.new(mix.outputs[2], shader.inputs["Base Color"])


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
    if animal == "cat":
        refine_cat_mesh(meshes[0], next(s.material for s in meshes[0].material_slots if s.material.name.split(".")[0] == "Grey"))
        plant_cat_walk(actions["Walk"])

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
    gait = stride(armature, spec["feet"], actions["Walk"], scene) if "feet" in spec else None
    slot_for(armature, actions["Idle"])
    scene.frame_set(int(actions["Idle"].frame_range[0]))
    travel = math.dist(centres[0], centres[1])
    return root, armature, meshes, actions, {
        "low": low, "high": high, "travel": travel, "gait": gait,
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
        **({"walkStride": round(measured["gait"][0], 4), "walkSlip": round(measured["gait"][1], 5)} if measured["gait"] else {}),
    }
