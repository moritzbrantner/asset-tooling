"""Review renders of the Shooter weapon kit (docs/shooter-weapons.md, #594) on the robot kit's review builds.

    <blender 5.2.2> -b --factory-startup -P scripts/review-shooter-weapons.py -- --descriptor <build>/descriptor.json --out review/shooter-weapons

Reads the weapon kit's descriptor (compositions, anchors, states), builds every part from the recipes
(adapters/blender/combat_robot.py and shooter_weapons.py, so no bundle is needed), places them by the descriptor's
transforms, poses weapons by their baked states and renders EEVEE contact sheets as JPEGs. In a live Blender it runs the
same way in a new scene: ``runpy.run_path("scripts/review-shooter-weapons.py", run_name="review", init_globals=
{"ARGS": ["--descriptor", ..., "--out", ...]})``.

The muzzle flashes, bolts, beams, flames, the grapple's cable and the falling parts are review cues drawn here from the
descriptor's muzzle and cable frames; they are not shipped (Shooter owns its effects and physics). Placeholder parts
(the tracks, #634) are translucent purple boxes. Every render is at third-person gameplay scale unless noted: 3.6 m from
the build, the eye 1.7 m up, a 60 degree vertical field of view.
"""
import json
import math
import os
import runpy
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.path.join(os.getcwd(), "scripts")
ROOT = os.path.dirname(HERE)
ADAPTERS = os.path.join(ROOT, "adapters", "blender")
PANEL = (720, 540)
GLTF_TO_BLENDER = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))  # glTF (x, y, z) -> Blender (x, -z, y)
TINTS = {}


def arguments():
    argv = globals().get("ARGS") or (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    out = {"descriptor": None, "out": None, "only": None}
    for i in range(0, len(argv), 2):
        out[argv[i].lstrip("-")] = argv[i + 1]
    if not out["descriptor"] or not out["out"]:
        raise SystemExit("usage: -- --descriptor <descriptor.json> --out <directory> [--only <sheet>]")
    return out


# ---------------------------------------------------------------- scene

def fresh_scene():
    scene = bpy.data.scenes.new("weapons-review")
    if bpy.context.window is not None:
        bpy.context.window.scene = scene
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = PANEL
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    try:
        scene.eevee.taa_render_samples = 32
    except AttributeError:
        pass
    world = bpy.data.worlds.new("weapons-review")
    world.use_nodes = True
    background = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    background.inputs[0].default_value = (0.3, 0.32, 0.36, 1)
    background.inputs[1].default_value = 0.9
    scene.world = world
    for name, energy, rotation in (("sun", 3.5, (0.5, 0.0, 0.8)), ("fill", 1.0, (1.2, 0.0, -2.3))):
        light = bpy.data.objects.new(f"review-{name}", bpy.data.lights.new(f"review-{name}", "SUN"))
        light.data.energy = energy
        light.rotation_euler = rotation
        scene.collection.objects.link(light)
    ground = bpy.data.meshes.new("review-ground")
    ground.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
    obj = bpy.data.objects.new("review-ground", ground)
    obj.data.materials.append(flat_material("review-ground", (0.12, 0.125, 0.13), 0.0))
    scene.collection.objects.link(obj)
    camera = bpy.data.objects.new("review-camera", bpy.data.cameras.new("review-camera"))
    camera.data.sensor_fit = "VERTICAL"
    camera.data.angle = math.radians(60)
    camera.data.clip_start = 0.05
    scene.collection.objects.link(camera)
    scene.camera = camera
    return scene


def flat_material(name, colour, emission, alpha=1.0):
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*colour, 1)
    bsdf.inputs["Roughness"].default_value = 0.8
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*colour, 1)
        bsdf.inputs["Emission Strength"].default_value = emission
    if alpha < 1:
        bsdf.inputs["Alpha"].default_value = alpha
        try:
            mat.surface_render_method = "BLENDED"
        except AttributeError:
            mat.blend_method = "BLEND"
    return mat


class Kits:
    """Builds robot and weapon parts from their recipes, one fresh object per instance (each rig poses on its own)."""

    def __init__(self, collection):
        common = runpy.run_path(os.path.join(ADAPTERS, "kit_common.py"))
        self.robot = runpy.run_path(os.path.join(ADAPTERS, "combat_robot.py"))
        self.robot["use_common"](common)
        self.weapons = runpy.run_path(os.path.join(ADAPTERS, "shooter_weapons.py"))
        # The weapon recipe rebinds its own copy of the robot recipe to the weapon atlas.
        self.weapons["use_sources"](runpy.run_path(os.path.join(ADAPTERS, "combat_robot.py")), common)
        self.collection = collection

    def build(self, key, variant="default", level=0):
        if key.startswith("robot."):
            obj, _ = self.robot["build"](key, self.collection, level, variant)
        else:
            obj, _ = self.weapons["build"](key, self.collection, level)
        rig = obj.parent
        if rig is not None and rig.animation_data:
            for track in rig.animation_data.nla_tracks:
                track.mute = True
        return obj


def gltf_matrix(translation, rotation):
    """A descriptor placement (glTF translation and quaternion x, y, z, w) as a Blender world matrix."""
    x, y, z, w = rotation
    r = GLTF_TO_BLENDER @ Quaternion((w, x, y, z)).to_matrix() @ GLTF_TO_BLENDER.transposed()
    m = r.to_4x4()
    m.translation = GLTF_TO_BLENDER @ Vector(translation)
    return m


def to_blender(v):
    return GLTF_TO_BLENDER @ Vector(v)


def root(obj):
    return obj.parent or obj


def apply_state(obj, state, frame):
    """Pose a weapon's rig at ``frame`` of its baked state (an NLA track), then keep that pose with every track muted."""
    rig = obj.parent
    tracks = rig.animation_data.nla_tracks
    for track in tracks:
        track.mute = track.name != state
    scene = bpy.context.scene
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    values = {pb.name: (pb.location.copy(), pb.rotation_quaternion.copy(), pb.scale.copy()) for pb in rig.pose.bones}
    for track in tracks:
        track.mute = True
    scene.frame_set(frame)
    for name, (loc, rot, scale) in values.items():
        pb = rig.pose.bones[name]
        pb.location, pb.rotation_quaternion, pb.scale = loc, rot, scale
    bpy.context.view_layer.update()


def bone_point(obj, bone, point_gltf):
    """A point given in the weapon's glTF part frame at rest, carried by ``bone``'s current pose, in world space."""
    rig = obj.parent
    pb = rig.pose.bones[bone]
    rest = rig.data.bones[bone].matrix_local
    local = to_blender(point_gltf)
    return rig.matrix_world @ (pb.matrix @ rest.inverted() @ local)


def bone_direction(obj, bone, dir_gltf):
    rig = obj.parent
    pb = rig.pose.bones[bone]
    rest = rig.data.bones[bone].matrix_local
    m = (rig.matrix_world @ pb.matrix @ rest.inverted()).to_3x3()
    return (m @ to_blender(dir_gltf)).normalized()


class Build:
    """One composition placed in the scene, offset by ``at`` (Blender), turned by ``yaw`` about up."""

    def __init__(self, kits, descriptor, name, at=(0, 0, 0), yaw=0.0):
        self.kits, self.descriptor = kits, descriptor
        self.composition = next(c for c in descriptor["compositions"] if c["name"] == name)
        self.base = Matrix.Translation(Vector(at)) @ Matrix.Rotation(yaw, 4, "Z")
        self.items, self.objects, self.mods, self.matrices = {}, {}, {}, {}
        for item in self.composition["items"]:
            self.items[item["id"]] = item
            m = self.base @ gltf_matrix(item["translation"], item["rotation"])
            self.matrices[item["id"]] = m
            if item.get("placeholder"):
                obj = placeholder(item, kits.collection)
            else:
                obj = kits.build(item["key"], item.get("variant", "default"))
            root(obj).matrix_world = m
            self.objects[item["id"]] = obj
            if item.get("mod"):
                mod = kits.build(item["mod"]["key"])
                mod.matrix_world = self.base @ gltf_matrix(item["mod"]["translation"], item["mod"]["rotation"])
                part = next(p for p in descriptor["parts"] if p["key"] == item["key"])
                anchor = next(a for a in part["anchors"] if a["name"] == item["mod"]["anchor"])
                if obj.parent is not None:  # ride the anchor's node, so a recoiling barrel carries its long barrel
                    world = mod.matrix_world.copy()
                    mod.parent = obj.parent
                    mod.parent_type = "BONE"
                    mod.parent_bone = anchor["node"]
                    bpy.context.view_layer.update()
                    mod.matrix_world = world
                self.mods[item["id"]] = mod
        bpy.context.view_layer.update()

    def part(self, item_id):
        return next(p for p in self.descriptor["parts"] if p["key"] == self.items[item_id]["key"])

    def anchor_world(self, item_id, name):
        """An anchor's position and normal in world space, following its node's pose (or a mounted long barrel)."""
        part = self.part(item_id)
        obj = self.objects[item_id]
        anchor = next(a for a in part["anchors"] if a["name"] == name)
        if name.startswith("muzzle") and item_id in self.mods and self.items[item_id]["mod"]["key"] == "mod.long-barrel":
            mod = self.mods[item_id]
            tip = next(a for a in self.descriptor["mods"] if a["key"] == "mod.long-barrel")["anchors"][0]
            return mod.matrix_world @ to_blender(tip["position"]), (mod.matrix_world.to_3x3() @ to_blender(tip["normal"])).normalized()
        node = anchor.get("node", "base")
        return bone_point(obj, node, anchor["position"]), bone_direction(obj, node, anchor["normal"])

    def subtree(self, item_id):
        ids = {item_id}
        changed = True
        while changed:
            changed = False
            for i, item in self.items.items():
                if item.get("parent") in ids and i not in ids:
                    ids.add(i)
                    changed = True
        return ids

    def detach(self, item_id, drop, turn, axis="X"):
        """Move ``item_id`` and everything mounted on it as one rigid piece: turned about its mount point, then dropped."""
        pivot = self.matrices[item_id].translation.copy()
        move = Matrix.Translation(pivot + Vector(drop)) @ Matrix.Rotation(turn, 4, axis) @ Matrix.Translation(-pivot)
        for i in self.subtree(item_id):
            r = root(self.objects[i])
            r.matrix_world = move @ r.matrix_world
            if i in self.mods and self.mods[i].parent is None:
                self.mods[i].matrix_world = move @ self.mods[i].matrix_world
        bpy.context.view_layer.update()

    def centre(self):
        points = [self.matrices[i].translation for i in self.items]
        lo = Vector([min(p[k] for p in points) for k in range(3)])
        hi = Vector([max(p[k] for p in points) for k in range(3)])
        return (lo + hi) / 2 + Vector((0, 0, 0.25))


def placeholder(item, collection):
    cells = item["cells"]
    mesh = bpy.data.meshes.new(f"placeholder-{item['id']}")
    lo, hi = (-0.1, -0.1, 0.0), (cells[0] * 0.2 - 0.1, cells[1] * 0.2 - 0.1, cells[2] * 0.2)
    verts = [(lo[0] if c & 1 == 0 else hi[0], lo[1] if c & 2 == 0 else hi[1], lo[2] if c & 4 == 0 else hi[2]) for c in range(8)]
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new(f"placeholder-{item['id']}", mesh)
    obj.data.materials.append(flat_material("review-placeholder", (0.55, 0.2, 0.75), 0.3, 0.45))
    collection.objects.link(obj)
    return obj


# ---------------------------------------------------------------- review cues (not shipped)

def cue_material(tint, strength=6.0):
    key = tuple(round(c, 3) for c in tint)
    return flat_material(f"review-cue-{key}-{strength}", tint, min(strength, 3.0) * 0.8)


def cylinder_between(collection, a, b, radius, tint, strength=6.0, radius2=None, sides=12):
    a, b = Vector(a), Vector(b)
    axis = b - a
    mesh = bpy.data.meshes.new("cue")
    r2 = radius if radius2 is None else radius2
    ref = Vector((0, 0, 1)) if abs(axis.normalized().z) < 0.9 else Vector((1, 0, 0))
    u = axis.cross(ref).normalized()
    v = axis.normalized().cross(u)
    verts = []
    for end, r in ((a, radius), (b, r2)):
        for s in range(sides):
            t = 2 * math.pi * s / sides
            verts.append(end + (u * math.cos(t) + v * math.sin(t)) * r)
    faces = [(s, (s + 1) % sides, sides + (s + 1) % sides, sides + s) for s in range(sides)]
    faces += [tuple(reversed(range(sides))), tuple(range(sides, 2 * sides))]
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new("cue", mesh)
    obj.data.materials.append(cue_material(tint, strength))
    collection.objects.link(obj)
    return obj


def sphere_at(collection, centre, radius, tint, strength=8.0):
    mesh = bpy.data.meshes.new("cue-flash")
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=radius)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("cue-flash", mesh)
    obj.location = centre
    obj.data.materials.append(cue_material(tint, strength))
    collection.objects.link(obj)
    return obj


def fire_cue(build, item_id, kind, length=2.5):
    """Draw a review-only shot from a weapon's muzzle frame: a flash and a bolt, beam, flame, pellets or a rocket trail."""
    part = build.part(item_id)
    tint = Vector(next(c for c in part["channels"] if c["name"] == "charge")["colour"])
    names = [a["name"] for a in part["anchors"] if a["kind"] in ("muzzle", "emitter", "launcher")]
    p, d = build.anchor_world(item_id, names[0])
    col = build.kits.collection
    if kind == "bolt":
        sphere_at(col, p + d * 0.02, 0.05, tint)
        cylinder_between(col, p + d * 0.4, p + d * (0.4 + length * 0.35), 0.02, tint, 10)
    elif kind == "rail":
        sphere_at(col, p + d * 0.03, 0.07, tint)
        cylinder_between(col, p, p + d * length * 2, 0.012, tint, 12)
        for k in range(5):
            ring = cylinder_between(col, p + d * (0.3 + k * 0.45), p + d * (0.32 + k * 0.45), 0.05 + 0.015 * k, tint, 5, sides=16)
            ring.scale = (1, 1, 1)
    elif kind == "beam":
        sphere_at(col, p + d * 0.01, 0.035, tint, 10)
        cylinder_between(col, p, p + d * length * 2, 0.008, tint, 14)
    elif kind == "flame":
        cylinder_between(col, p, p + d * 1.4, 0.03, (1.0, 0.55, 0.1), 7, radius2=0.35, sides=16)
        cylinder_between(col, p, p + d * 0.8, 0.02, (1.0, 0.85, 0.4), 9, radius2=0.12, sides=12)
    elif kind == "pellets":
        sphere_at(col, p + d * 0.03, 0.07, tint)
        ref = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        u = d.cross(ref).normalized()
        v = d.cross(u)
        for k in range(7):
            t = 2 * math.pi * k / 7
            spread = (u * math.cos(t) + v * math.sin(t)) * 0.12
            q = p + d * 0.5 + spread * 0.5
            cylinder_between(col, q, q + (d + spread).normalized() * 0.35, 0.008, tint, 10, sides=6)
    elif kind == "rocket":
        obj = build.objects[item_id]
        rocket = bone_point(obj, "rocket-a", (0.008, 0.3, 0))
        cylinder_between(col, rocket - d * 0.02, rocket - d * 0.6, 0.03, (1.0, 0.6, 0.2), 8, radius2=0.09, sides=12)
        sphere_at(col, p, 0.08, (1.0, 0.7, 0.3), 6)


def cable(build, item_id, hook_out):
    """Push the grapple's hook node ``hook_out`` metres along its fire direction and draw the cable from its anchors."""
    obj = build.objects[item_id]
    rig = obj.parent
    pb = rig.pose.bones["hook"]
    pb.location = (0, hook_out, 0)  # bones run along the weapon's +z: the bone's +Y
    bpy.context.view_layer.update()
    start, _ = build.anchor_world(item_id, "muzzle")
    end, _ = build.anchor_world(item_id, "cable")
    cylinder_between(build.kits.collection, start, end, 0.006, (0.75, 0.75, 0.7), 0.3, sides=6)


# ---------------------------------------------------------------- camera and sheets

def aim(camera, eye, target):
    camera.location = eye
    camera.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat("-Z", "Y").to_euler()


def orbit(camera, target, azimuth, distance=3.6, eye_height=1.7):
    a = math.radians(azimuth)
    target = Vector(target)
    flat = math.sqrt(max(distance ** 2 - (eye_height - target.z) ** 2, 0.1))
    aim(camera, target + Vector((math.cos(a) * flat, math.sin(a) * flat, 0)) + Vector((0, 0, eye_height - target.z)), target)


def render(path):
    scene = bpy.context.scene
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(path)
    pixels = np.array(image.pixels[:], dtype=np.float32).reshape(image.size[1], image.size[0], 4)[::-1, :, :3]
    bpy.data.images.remove(image)
    return pixels


def sheet(panels, columns, path):
    rows = math.ceil(len(panels) / columns)
    h, w = panels[0].shape[:2]
    out = np.ones((rows * h + (rows - 1) * 4, columns * w + (columns - 1) * 4, 3), dtype=np.float32) * 0.08
    for i, panel in enumerate(panels):
        r, c = divmod(i, columns)
        out[r * (h + 4):r * (h + 4) + h, c * (w + 4):c * (w + 4) + w] = panel
    image = bpy.data.images.new(os.path.basename(path), out.shape[1], out.shape[0], alpha=False)
    rgba = np.concatenate([out, np.ones(out.shape[:2] + (1,), dtype=np.float32)], -1)
    image.pixels.foreach_set(rgba[::-1].ravel())
    image.filepath_raw = path
    image.file_format = "JPEG"
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 82
    image.save_render(path, scene=scene)
    bpy.data.images.remove(image)
    print(f"wrote {path}")


def clear(collection):
    for obj in list(collection.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


# ---------------------------------------------------------------- the sheets

def sheets(descriptor, out, only):
    scene = fresh_scene()
    collection = bpy.data.collections.new("weapons-review-parts")
    scene.collection.children.link(collection)
    kits = Kits(collection)
    camera = scene.camera
    temp = tempfile.mkdtemp(prefix="weapons-review-")
    counter = [0]

    def shot():
        counter[0] += 1
        return render(os.path.join(temp, f"{counter[0]:03d}.png"))

    def want(name):
        return only is None or name in only.split(",")

    weapons = [p["key"] for p in descriptor["parts"]]

    if want("weapons"):
        # Every weapon at full detail, then each mod on a weapon it fits: close-ups through a 30 degree lens.
        panels = []
        camera.data.angle = math.radians(30)
        mods = [("weapon.energy-rifle", "mod.rapid-cycler"), ("weapon.rail-gun", "mod.overcharger"), ("weapon.laser", "mod.long-barrel"),
                ("weapon.rocket-launcher", "mod.efficiency-coil"), ("weapon.energy-rifle", "mod.long-barrel"), ("weapon.shotgun", "mod.efficiency-coil")]
        for pairs in ([(k, None) for k in weapons[:4]], [(k, None) for k in weapons[4:]], mods[:3], mods[3:]):
            clear(collection)
            for i, (key, mod) in enumerate(pairs):
                obj = kits.build(key)
                root(obj).location = (i * 0.45, 0, 0)
                if mod:
                    part = next(p for p in descriptor["parts"] if p["key"] == key)
                    spec = next(m for m in descriptor["mods"] if m["key"] == mod)
                    anchor = next(a for a in part["anchors"] if a["name"] == spec["mountsOn"])
                    n, up = to_blender(anchor["normal"]), to_blender(anchor["up"])
                    u = up.cross(n)
                    # Mod frame (Blender, = its part frame): x -> u, y -> up, z -> normal.
                    m = Matrix((u, up, n)).transposed().to_4x4()
                    m.translation = to_blender(anchor["position"]) + Vector((i * 0.45, 0, 0))
                    kits.build(mod).matrix_world = m
            centre = Vector(((len(pairs) - 1) * 0.45 / 2, 0, 0.2))
            for azimuth in (-60, 120):
                orbit(camera, centre, azimuth, distance=2.6, eye_height=1.0)
                panels.append(shot())
        camera.data.angle = math.radians(60)
        sheet(panels, 2, os.path.join(out, "weapons.jpg"))

    if want("lods"):
        clear(collection)
        for i, key in enumerate(weapons):
            for level in (0, 1, 2):
                root(kits.weapons["build"](key, collection, level)[0]).location = (i * 0.45, level * 0.5, 0)
        for obj in collection.objects:
            if obj.type == "ARMATURE" and obj.animation_data:
                for t in obj.animation_data.nla_tracks:
                    t.mute = True
        panels = []
        for azimuth in (-70,):
            orbit(camera, Vector((1.6, 0.5, 0.2)), azimuth, distance=3.6, eye_height=1.5)
            panels.append(shot())
        sheet(panels, 1, os.path.join(out, "lods.jpg"))

    if want("loadouts"):
        # Shooter's four named loadouts, front three-quarter and back three-quarter, at gameplay scale.
        panels = []
        for name in ("standard", "heavy", "skirmisher", "marksman"):
            clear(collection)
            build = Build(kits, descriptor, name)
            for azimuth in (-35, 145):
                orbit(camera, build.centre(), azimuth)
                panels.append(shot())
        sheet(panels, 4, os.path.join(out, "loadouts.jpg"))

    for name in ("turret", "mini-tank"):
        if not want(name):
            continue
        clear(collection)
        build = Build(kits, descriptor, name)
        panels = []
        for azimuth in (0, -90, 180, -40):
            orbit(camera, build.centre(), azimuth)
            panels.append(shot())
        sheet(panels, 2, os.path.join(out, f"{name}.jpg"))

    if want("firing"):
        # One shot per weapon on a build, from the side of its fire direction: the fire state's pose and glow, and a review cue.
        shots = [("standard", "rifle", "fire", 1, "bolt"), ("standard", "shotgun", "fire", 1, "pellets"), ("turret", "laser", "beam", 7, "beam"),
                 ("turret", "flamethrower", "fire", 3, "flame"), ("heavy", "rail-gun", "fire", 1, "rail"), ("heavy", "rockets", "fire-a", 4, "rocket"),
                 ("mini-tank", "rail-gun", "fire", 1, "rail"), ("marksman", "rifle", "fire", 1, "bolt")]
        panels = []
        for name, item_id, state, frame, kind in shots:
            clear(collection)
            build = Build(kits, descriptor, name)
            apply_state(build.objects[item_id], state, frame)
            fire_cue(build, item_id, kind)
            muzzle = build.anchor_world(item_id, [a["name"] for a in build.part(item_id)["anchors"] if a["kind"] in ("muzzle", "emitter")][0])
            p, d = muzzle
            side = d.cross(Vector((0, 0, 1)))
            side = side.normalized() if side.length > 0.2 else Vector((0.7, -0.7, 0))
            target = (build.centre() + p + d * 0.6) / 2
            aim(camera, target + side * 2.4 + Vector((0, 0, 1.6 - target.z)) - d * 0.6, target)
            panels.append(shot())
        sheet(panels, 4, os.path.join(out, "firing.jpg"))

    if want("blade-grapple"):
        # STANDARD's blade (right arm) and grapple (top), at gameplay distance (3.6 m) and close (1.6 m). The blade:
        # retracted, extending, extended, then the swing's back, middle and follow-through. The grapple: ready, launching
        # (claws opening), launched, the hook 1 m and 2.5 m out on its cable (a review cue), then retracting.
        frames = [("blade", state, frame, 0) for state, frame in (("retract", 6), ("extend", 3), ("extend", 6), ("swing", 3), ("swing", 6), ("swing", 8))]
        frames += [("grapple", state, frame, hook) for state, frame, hook in (("launch", 0, 0), ("launch", 3, 0), ("launch", 6, 0), ("launch", 6, 1.0), ("launch", 6, 2.5), ("retract", 6, 0))]
        for distance, filename in ((3.6, "blade-grapple.jpg"), (1.6, "blade-grapple-close.jpg")):
            panels = []
            for item_id, state, frame, hook in frames:
                clear(collection)
                build = Build(kits, descriptor, "standard")
                apply_state(build.objects[item_id], state, frame)
                if hook:
                    cable(build, item_id, hook)
                at = build.matrices[item_id].translation
                target = at + Vector((0, 0, min(hook, 1.2) * 0.5 + 0.1)) if item_id == "grapple" else at + Vector((0, -0.15, 0.1))
                if distance > 2 and item_id == "grapple":
                    target = (target + build.centre()) / 2
                orbit(camera, target, -40, distance=distance + (hook * 0.6 if distance < 2 else 0), eye_height=target.z + (0.5 if distance < 2 else 1.7 - target.z))
                panels.append(shot())
            sheet(panels, 6, os.path.join(out, filename))

    if want("mods"):
        panels = []
        # Each mod close (1.4 m), then the two modded loadouts at gameplay distance.
        for name, item_id in (("skirmisher", "rifle"), ("skirmisher", "shotgun"), ("marksman", "rifle"), ("marksman", "rail-gun")):
            clear(collection)
            build = Build(kits, descriptor, name)
            mod = build.mods[item_id]
            centre = mod.matrix_world.translation
            frame = mod.matrix_world.to_3x3()
            normal, along = frame.col[2].normalized(), frame.col[1].normalized()
            aim(camera, centre + normal * 0.75 + along * 0.25 + Vector((0, 0, 0.3)) + normal.cross(along) * 0.3, centre + along * 0.05)
            panels.append(shot())
        for name in ("skirmisher", "marksman"):
            clear(collection)
            build = Build(kits, descriptor, name)
            orbit(camera, build.centre(), -40)
            panels.append(shot())
        sheet(panels, 3, os.path.join(out, "mods.jpg"))

    if want("detach"):
        panels = []
        # HEAVY loses its right arm with the blade on it, MARKSMAN its left arm with the long-barrel rifle: each falls as one piece.
        for name, item_id, drop, turn, axis in (("heavy", "arm-right", (0.15, 0.2, -0.75), 0.9, "X"), ("marksman", "arm-left", (0.1, -0.25, -0.8), -1.0, "X"),
                                                ("turret", "housing", (0.6, 0.0, -0.9), 0.7, "Y")):
            clear(collection)
            build = Build(kits, descriptor, name)
            build.detach(item_id, drop, turn, axis)
            orbit(camera, build.centre() + Vector((0, 0, -0.2)), -35)
            panels.append(shot())
        sheet(panels, 3, os.path.join(out, "detach.jpg"))

    if want("gameplay"):
        clear(collection)
        names = ["standard", "heavy", "skirmisher", "marksman", "turret", "mini-tank"]
        for i, name in enumerate(names):
            Build(kits, descriptor, name, at=(-0.6 * (i % 2), 6.5 - i * 2.6, 0), yaw=math.radians(-15))
        panels = []
        # About 10 m from the middle of the row, a third-person opponent's distance, at a wider panel.
        scene.render.resolution_x, scene.render.resolution_y = 1440, 810
        aim(camera, Vector((9.5, -2.5, 1.7)), Vector((0, 0, 0.7)))
        panels.append(shot())
        scene.render.resolution_x, scene.render.resolution_y = PANEL
        sheet(panels, 1, os.path.join(out, "gameplay.jpg"))


def main():
    args = arguments()
    with open(args["descriptor"], encoding="utf8") as handle:
        descriptor = json.load(handle)
    os.makedirs(args["out"], exist_ok=True)
    sheets(descriptor, args["out"], args["only"])


if __name__ in ("__main__", "review"):
    main()
