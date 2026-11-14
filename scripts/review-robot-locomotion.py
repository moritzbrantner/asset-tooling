"""Review renders of the Shooter locomotion kit (docs/robot-locomotion.md, #634) on the robot and weapon kits' parts.

    <blender 5.2.2> -b --factory-startup -P scripts/review-robot-locomotion.py -- --descriptor <build>/descriptor.json --out review/shooter-robot-locomotion

Reads the kit's descriptor (compositions, axles, belt), builds every part from the recipes (adapters/blender/
combat_robot.py, shooter_weapons.py and robot_locomotion.py, so no bundle is needed), places them by the descriptor's
transforms and renders EEVEE contact sheets as JPEGs. In a live Blender it runs the same way in a new scene:
``runpy.run_path("scripts/review-robot-locomotion.py", run_name="review", init_globals={"ARGS": [...]})``.

Motion is kinematic, for review: a build is carried along a path and every wheel and track is turned by the distance its
ground contact rolls (angle = distance / the descriptor's rolling radius, signed by its axle's direction), the belt
moved by the same angle as the roll clip moves it. Shooter moves robots physically; the falling parts and the grapple's
cable are review cues. Unless noted, every render is at third-person gameplay scale: 3.6 m from the build, the eye 1.7 m
up, a 60 degree vertical field of view.
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
# The grapple's frames from the weapon kit's descriptor (scripts/build-shooter-weapons.ts WEAPON_RIGS): where the cable
# leaves the launch tube and where it ends on the hook, in the weapon's glTF part frame.
GRAPPLE_MUZZLE, GRAPPLE_CABLE = (0, 0.283, 0), (0, 0.24, 0)


def arguments():
    argv = globals().get("ARGS") or (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    out = {"descriptor": None, "out": None, "only": None}
    for i in range(0, len(argv), 2):
        out[argv[i].lstrip("-")] = argv[i + 1]
    if not out["descriptor"] or not out["out"]:
        raise SystemExit("usage: -- --descriptor <descriptor.json> --out <directory> [--only <sheet>]")
    return out


# ---------------------------------------------------------------- scene

def flat_material(name, colour, emission=0.0, alpha=1.0):
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
    return mat


def ground_material():
    """A dark floor with a faint 1 m grid, so a build's travel reads between frames."""
    mat = bpy.data.materials.get("review-ground")
    if mat is not None:
        return mat
    mat = bpy.data.materials.new("review-ground")
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.9
    checker = tree.nodes.new("ShaderNodeTexChecker")
    checker.inputs["Scale"].default_value = 1.0
    checker.inputs["Color1"].default_value = (0.075, 0.078, 0.082, 1)
    checker.inputs["Color2"].default_value = (0.058, 0.06, 0.064, 1)
    coords = tree.nodes.new("ShaderNodeTexCoord")
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (0.5, 0.5, 0.5)  # 1 m squares
    tree.links.new(coords.outputs["Object"], mapping.inputs["Vector"])
    tree.links.new(mapping.outputs["Vector"], checker.inputs["Vector"])
    tree.links.new(checker.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def fresh_scene():
    scene = bpy.data.scenes.new("locomotion-review")
    if bpy.context.window is not None:
        bpy.context.window.scene = scene
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = PANEL
    scene.view_settings.view_transform = "Standard"
    try:
        scene.eevee.taa_render_samples = 32
    except AttributeError:
        pass
    world = bpy.data.worlds.new("locomotion-review")
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
    obj.data.materials.append(ground_material())
    scene.collection.objects.link(obj)
    camera = bpy.data.objects.new("review-camera", bpy.data.cameras.new("review-camera"))
    camera.data.sensor_fit = "VERTICAL"
    camera.data.angle = math.radians(60)
    camera.data.clip_start = 0.05
    scene.collection.objects.link(camera)
    scene.camera = camera
    return scene


class Kits:
    """Builds robot, weapon and locomotion parts from their recipes, one fresh object per instance."""

    def __init__(self, collection):
        common = runpy.run_path(os.path.join(ADAPTERS, "kit_common.py"))
        self.robot = runpy.run_path(os.path.join(ADAPTERS, "combat_robot.py"))
        self.robot["use_common"](common)
        self.weapons = runpy.run_path(os.path.join(ADAPTERS, "shooter_weapons.py"))
        self.weapons["use_sources"](runpy.run_path(os.path.join(ADAPTERS, "combat_robot.py")), common)
        self.locomotion = runpy.run_path(os.path.join(ADAPTERS, "robot_locomotion.py"))
        self.locomotion["use_sources"](runpy.run_path(os.path.join(ADAPTERS, "combat_robot.py")), common)
        self.collection = collection

    def build(self, key, variant="default", level=0):
        if key in self.locomotion["PARTS"]:
            obj, _ = self.locomotion["build"](key, self.collection, level, variant)
        elif key.startswith("robot."):
            obj, _ = self.robot["build"](key, self.collection, level, variant)
        else:
            obj, _ = self.weapons["build"](key, self.collection, level)
        rig = obj.parent
        if rig is not None and rig.animation_data:
            for track in rig.animation_data.nla_tracks:
                track.mute = True
        return obj


def gltf_matrix(translation, rotation):
    x, y, z, w = rotation
    r = GLTF_TO_BLENDER @ Quaternion((w, x, y, z)).to_matrix() @ GLTF_TO_BLENDER.transposed()
    m = r.to_4x4()
    m.translation = GLTF_TO_BLENDER @ Vector(translation)
    return m


def to_blender(v):
    return GLTF_TO_BLENDER @ Vector(v)


def root(obj):
    return obj.parent or obj


def bone_frame(v):
    return Vector((v[0], v[2], -v[1]))


def pose_state(obj, state, frame):
    """Pose a rig at ``frame`` of one of its baked NLA tracks, then keep that pose with every track muted."""
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


class Build:
    """One composition placed in the scene and carried by ``self.base`` (a Blender matrix: where its origin is now)."""

    def __init__(self, kits, descriptor, name, base=None, variants=None, skip=()):
        self.kits, self.descriptor, self.name = kits, descriptor, name
        self.composition = next(c for c in descriptor["compositions"] if c["name"] == name)
        self.items, self.objects, self.local = {}, {}, {}
        self.angles = {}
        for item in self.composition["items"]:
            if item["id"] in skip:
                continue
            self.items[item["id"]] = item
            self.local[item["id"]] = gltf_matrix(item["translation"], item["rotation"])
            variant = (variants or {}).get(item["id"], item.get("variant", "default"))
            self.objects[item["id"]] = kits.build(item["key"], variant)
        self.place(base or Matrix.Identity(4))

    def place(self, base):
        self.base = base
        for item_id, obj in self.objects.items():
            root(obj).matrix_world = base @ self.local[item_id]
        bpy.context.view_layer.update()

    def part(self, key):
        return next((p for p in self.descriptor["parts"] if p["key"] == key), None)

    def rolling(self):
        """Each wheel or track: (item id, locomotion block, world contact point at its first body, world axle)."""
        out = []
        for item_id, item in self.items.items():
            part = self.part(item["key"])
            if not part:
                continue
            loc = part["locomotion"]
            m = self.base @ self.local[item_id]
            centres = [m @ to_blender(b["centre"]) for b in loc["bodies"]]
            centre = sum(centres, Vector()) / len(centres)
            axle = (m.to_3x3() @ to_blender(loc["axis"])).normalized()
            out.append((item_id, loc, centre, axle))
        return out

    def drive(self, path, steps=24):
        """Carry the build along ``path`` (a list of Blender matrices for its base) and turn every wheel and track by how
        far its contact rolls: angle += (displacement . rolling direction) / rolling radius, where the rolling direction
        is axle x up (a positive turn about the axle rolls the body that way)."""
        for a, b in zip(path, path[1:]):
            for k in range(steps):
                m0, m1 = interpolate(a, b, k / steps), interpolate(a, b, (k + 1) / steps)
                self.place(m0)
                before = {item_id: (centre, axle, loc) for item_id, loc, centre, axle in self.rolling()}
                self.place(m1)
                for item_id, loc, centre, axle in self.rolling():
                    c0, axle0, _ = before[item_id]
                    forward = axle0.cross(Vector((0, 0, 1)))
                    self.angles[item_id] = self.angles.get(item_id, 0.0) + (centre - c0).dot(forward) / loc["rollingRadius"]
        self.place(path[-1])
        self.apply_roll()

    def apply_roll(self):
        for item_id, angle in self.angles.items():
            roll(self.kits, self.objects[item_id], self.part(self.items[item_id]["key"])["locomotion"], angle)

    def world(self, item_id):
        return self.base @ self.local[item_id]

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

    def detach(self, item_id, move):
        """Move ``item_id`` and everything on it by the Blender matrix ``move`` (applied in world space)."""
        for i in self.subtree(item_id):
            r = root(self.objects[i])
            r.matrix_world = move @ r.matrix_world
        bpy.context.view_layer.update()

    def centre(self):
        points = [self.world(i).translation for i in self.items]
        lo = Vector([min(p[k] for p in points) for k in range(3)])
        hi = Vector([max(p[k] for p in points) for k in range(3)])
        return (lo + hi) / 2 + Vector((0, 0, 0.2))


def interpolate(a, b, t):
    la, ra, _ = a.decompose()
    lb, rb, _ = b.decompose()
    m = ra.slerp(rb, t).to_matrix().to_4x4()
    m.translation = la.lerp(lb, t)
    return m


def at(x, y, yaw=0.0):
    return Matrix.Translation((x, y, 0)) @ Matrix.Rotation(yaw, 4, "Z")


def hub(build, item_id):
    """The middle of a wheel or track's axles, in the world."""
    item = build.items[item_id]
    loc = build.part(item["key"])["locomotion"]
    m = build.world(item_id)
    return sum((m @ to_blender(b["centre"]) for b in loc["bodies"]), Vector()) / len(loc["bodies"])


def side_on(key, x):
    """A wheel or track standing as if mounted on a robot's left side: its axle (+z) along the world -Y (its outer face
    towards -Y), on the ground, the middle of its axles at (x, 0)."""
    if key == "robot.wheel":
        # Rx(90): part (x, y, z) -> (x, -z, y); the axle (0.1, 0.1, 0.1) -> (0.1, -0.1, 0.1), lifted to its 0.18 m radius.
        return Matrix.Translation((x - 0.1, 0.1, 0.08)) @ Matrix.Rotation(math.pi / 2, 4, "X")
    # Rz(90) then Rx(90): part x -> up, y -> -X, z -> -Y; the axles (0, 0 .. 0.6, 0.2) -> (0 .. -0.6, -0.2, 0).
    return Matrix.Translation((x + 0.3, 0.2, 0.1)) @ Matrix.Rotation(math.pi / 2, 4, "X") @ Matrix.Rotation(math.pi / 2, 4, "Z")


def roll(kits, obj, loc, angle):
    """Turn a wheel or track part's nodes by ``angle`` about its axle, as the roll clip does at time
    (angle mod 2 pi) / 2 pi: every wheel node turns, and each link moves angle x the rolling radius along the belt."""
    rig = obj.parent
    k = kits.locomotion
    for name in loc["wheels"]:
        rig.pose.bones[name].rotation_quaternion = Quaternion(bone_frame((0, 0, 1)), angle)
    if "tread" in loc:
        shift = angle * loc["tread"]["metresPerRadian"]
        for i, name in enumerate(loc["tread"]["links"]):
            (x0, y0), a0 = k["belt_point"](i * k["PITCH"])
            (x1, y1), a1 = k["belt_point"](i * k["PITCH"] + shift)
            pb = rig.pose.bones[name]
            pb.rotation_quaternion = Quaternion(bone_frame((0, 0, 1)), a1 - a0)
            pb.location = bone_frame((x1 - x0, y1 - y0, 0))
    bpy.context.view_layer.update()


def grapple(build, item_id, target=None, hook_out=0.0):
    """Fire the grapple (its launch pose: claws open), push the hook ``hook_out`` metres out (or to ``target``, a world
    point) and draw the cable from the muzzle to the hook: a review cue (Shooter moves the hook and draws the cable)."""
    obj = build.objects[item_id]
    pose_state(obj, "launch", 6)
    rig = obj.parent
    m = rig.matrix_world
    muzzle = m @ to_blender(GRAPPLE_MUZZLE)
    direction = (m.to_3x3() @ to_blender((0, 1, 0))).normalized()
    if target is not None:
        hook_out = (Vector(target) - muzzle).dot(direction)
    pb = rig.pose.bones["hook"]
    pb.location = (0, hook_out + 0.12, 0)  # bones run along the weapon's +z (the bone's +Y); the launch pose is 0.12 out
    bpy.context.view_layer.update()
    rest = rig.data.bones["hook"].matrix_local
    end = m @ (pb.matrix @ rest.inverted() @ to_blender(GRAPPLE_CABLE))
    cylinder_between(build.kits.collection, muzzle, end, 0.007, (0.75, 0.75, 0.7))


def cylinder_between(collection, a, b, radius, colour, sides=8):
    a, b = Vector(a), Vector(b)
    axis = b - a
    ref = Vector((0, 0, 1)) if abs(axis.normalized().z) < 0.9 else Vector((1, 0, 0))
    u = axis.cross(ref).normalized()
    v = axis.normalized().cross(u)
    verts = [end + (u * math.cos(2 * math.pi * s / sides) + v * math.sin(2 * math.pi * s / sides)) * radius for end in (a, b) for s in range(sides)]
    faces = [(s, (s + 1) % sides, sides + (s + 1) % sides, sides + s) for s in range(sides)] + [tuple(reversed(range(sides))), tuple(range(sides, 2 * sides))]
    mesh = bpy.data.meshes.new("cue")
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new("cue", mesh)
    obj.data.materials.append(flat_material("review-cable", colour))
    collection.objects.link(obj)
    return obj


def post(collection, location, height=1.4):
    """A grey post the grapple hooks onto (a review prop)."""
    mesh = bpy.data.meshes.new("post")
    x, y = location
    r = 0.12
    verts = [(x + dx, y + dy, z) for z in (0, height) for dx, dy in ((-r, -r), (r, -r), (r, r), (-r, r))]
    mesh.from_pydata(verts, [], [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)])
    obj = bpy.data.objects.new("post", mesh)
    obj.data.materials.append(flat_material("review-post", (0.35, 0.36, 0.38)))
    collection.objects.link(obj)
    return obj


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


def walk(build, phase):
    """Pose a build's legs at ``phase`` of the robot kit's biped walk clip (left 0, right half a cycle on)."""
    for item_id, offset in (("leg-left", 0.0), ("leg-right", 0.5)):
        if item_id in build.objects:
            pose_state(build.objects[item_id], "walk-biped", round(((phase + offset) % 1.0) * 30))


# ---------------------------------------------------------------- the sheets

def sheets(descriptor, out, only):
    scene = fresh_scene()
    collection = bpy.data.collections.new("locomotion-review-parts")
    scene.collection.children.link(collection)
    kits = Kits(collection)
    camera = scene.camera
    temp = tempfile.mkdtemp(prefix="locomotion-review-")
    counter = [0]

    def shot():
        counter[0] += 1
        return render(os.path.join(temp, f"{counter[0]:03d}.png"))

    def want(name):
        return only is None or name in only.split(",")

    if want("parts"):
        # Both parts, intact and damaged, close through a 30 degree lens, standing as if mounted on a robot's left side
        # (axle horizontal), from outside three-quarter and from the mount side.
        camera.data.angle = math.radians(30)
        panels = []
        for view in ("outside", "mount"):
            clear(collection)
            for i, (key, variant) in enumerate((("robot.wheel", "default"), ("robot.wheel", "damaged"), ("robot.track", "default"), ("robot.track", "damaged"))):
                root(kits.build(key, variant)).matrix_world = side_on(key, (0.0, 0.55, 1.3, 2.3)[i])
            bpy.context.view_layer.update()
            scene.render.resolution_x = 1440
            orbit(camera, Vector((1.15, 0, 0.15)), -75 if view == "outside" else 105, distance=2.7, eye_height=0.9)
            panels.append(shot())
        camera.data.angle = math.radians(60)
        scene.render.resolution_x = PANEL[0]
        sheet(panels, 1, os.path.join(out, "parts.jpg"))

    if want("lods"):
        clear(collection)
        for i, key in enumerate(("robot.wheel", "robot.track")):
            for level in (0, 1, 2):
                root(kits.build(key, "default", level)).matrix_world = Matrix.Translation((0, i * 0.8, 0)) @ side_on(key, level * (0.6 if i == 0 else 0.9))
        bpy.context.view_layer.update()
        orbit(camera, Vector((0.6, 0.4, 0.15)), -60, distance=2.6, eye_height=1.4)
        sheet([shot()], 1, os.path.join(out, "lods.jpg"))

    if want("compare"):
        # Biped, wheeler and mini-tank side by side, then each at gameplay distance from the front three-quarter.
        panels = []
        clear(collection)
        builds = []
        for x, name in ((0, "biped"), (1.6, "wheeler"), (3.4, "mini-tank")):
            build = Build(kits, descriptor, name, at(x, 0))
            walk(build, 0.2)
            builds.append(build)
        scene.render.resolution_x, scene.render.resolution_y = 1440, 540
        aim(camera, Vector((1.7, -3.9, 1.7)), Vector((1.7, 0, 0.55)))
        panels.append(shot())
        scene.render.resolution_x, scene.render.resolution_y = PANEL
        sheet(panels, 1, os.path.join(out, "compare.jpg"))
        panels = []
        for name in ("biped", "wheeler", "mini-tank"):
            clear(collection)
            build = Build(kits, descriptor, name)
            walk(build, 0.2)
            for azimuth in (-35, 145):
                orbit(camera, build.centre(), azimuth)
                panels.append(shot())
        sheet(panels, 2, os.path.join(out, "compare-views.jpg"))

    if want("motion"):
        # Six frames each: the wheeler drives forward then turns left on a 2 m arc; the mini-tank drives forward, pivots
        # on the spot (tracks counter-rotating) and drives off, its turret turning. A fixed camera, so travel reads.
        for name, path, eye, target in (
            ("wheeler", [at(-1.2, 0), at(0, 0), at(0.9, 0.2, 0.45), at(1.4, 1.0, 1.1)], Vector((0.4, -3.6, 1.7)), Vector((0.2, 0.2, 0.3))),
            ("mini-tank", [at(-1.6, 0), at(0.0, 0), at(0.0, 0, 0.8), at(0.0, 0, 1.6), at(-0.1, 1.2, 1.6)], Vector((0.0, -3.4, 1.7)), Vector((-0.1, 0.3, 0.3))),
        ):
            panels = []
            clear(collection)
            build = Build(kits, descriptor, name, path[0])
            frames = [path[0]] + [interpolate(a, b, t) for a, b in zip(path, path[1:]) for t in (0.5, 1.0)]
            frames = frames[:6] if len(frames) >= 6 else frames
            for k, m in enumerate(frames):
                build.drive([build.base, m])
                if name == "mini-tank":
                    turret = build.objects["rotor"].parent
                    turret.pose.bones["rotor"].rotation_quaternion = Quaternion(bone_frame((0, 0, 1)), 0.35 * k)
                    hinge = build.objects["elevation"].parent
                    hinge.pose.bones["hinge"].rotation_quaternion = Quaternion(bone_frame((1, 0, 0)), -0.08 * k)
                    bpy.context.view_layer.update()
                aim(camera, eye, target)
                panels.append(shot())
            sheet(panels, 3, os.path.join(out, f"motion-{name}.jpg"))

    if want("close"):
        # Close (1.6 m) on the wheels and a track while they roll: the tread lugs, the belt's links on the sprocket.
        panels = []
        for name, item_id, steps in (("wheeler", "wheel-left-front", (0.0, 0.25)), ("mini-tank", "track-left", (0.0, 0.12))):
            clear(collection)
            build = Build(kits, descriptor, name)
            for dx in steps:
                build.drive([build.base, at(dx, 0)])
                c = build.world(item_id).translation
                orbit(camera, c + Vector((0.2, 0, 0.0)), -70, distance=1.6, eye_height=0.7)
                panels.append(shot())
        sheet(panels, 2, os.path.join(out, "motion-close.jpg"))

    if want("unusual"):
        # Shooter's strafer (wheels on the front and back: the same drive moves it sideways) and the crab (tracks on the
        # hull's ends), three frames each, moving along the world Y.
        panels = []
        for name in ("strafer", "crab"):
            clear(collection)
            build = Build(kits, descriptor, name, at(0, -0.6))
            for y in (-0.6, 0.0, 0.6):
                build.drive([build.base, at(0, y)])
                aim(camera, Vector((3.2, -1.6, 1.7)), Vector((0, 0, 0.35)))
                panels.append(shot())
        sheet(panels, 3, os.path.join(out, "unusual.jpg"))

    if want("grapple"):
        # The wheeler and the mini-tank hook a post 4 m ahead and reel themselves towards it, wheels and tracks turning.
        panels = []
        for name in ("wheeler", "mini-tank"):
            target = None
            for k, (x, hook) in enumerate(((0.0, 1.2), (0.0, None), (1.6, None))):
                clear(collection)
                build = Build(kits, descriptor, name)
                if target is None:  # the post stands 4 m out along the grapple's line from where the build starts
                    rig = build.objects["grapple"].parent
                    target = rig.matrix_world @ to_blender(GRAPPLE_MUZZLE) + (rig.matrix_world.to_3x3() @ to_blender((0, 1, 0))).normalized() * 4.0
                post(collection, (target.x + 0.12, target.y), height=max(1.4, target.z + 0.4))
                build.drive([build.base, at(x, 0)])
                grapple(build, "grapple", None if hook else target, hook or 0.0)
                aim(camera, Vector((1.0, -3.4, 1.7)), Vector((1.9, 0.0, 0.6)))
                panels.append(shot())
        sheet(panels, 3, os.path.join(out, "grapple.jpg"))

    if want("damage"):
        # Part loss at gameplay distance: the biped's leg, a wheel and a track shot off, lying where they fell, the rest
        # of each build tipped onto the missing support; then each damaged variant beside the intact one, close.
        panels = []
        clear(collection)
        build = Build(kits, descriptor, "biped", skip=())
        walk(build, 0.0)
        build.detach("leg-right", Matrix.Translation((0.25, -0.75, 0.1)) @ Matrix.Rotation(0.5, 4, "Z") @ Matrix.Rotation(math.pi / 2, 4, "Y") @ build.world("leg-right").inverted())
        orbit(camera, build.centre() + Vector((0, 0, -0.3)), -40)
        panels.append(shot())
        # The wheeler loses its right front wheel, which rolls away; the chassis drops onto that corner (its socket bare).
        clear(collection)
        build = Build(kits, descriptor, "wheeler", at(0, 0), variants={"wheel-left-rear": "damaged"})
        build.detach("wheel-right-front", Matrix.Translation((0.9, -1.1, 0)) @ Matrix.Rotation(-0.7, 4, "Z") @ side_on("robot.wheel", 0) @ build.world("wheel-right-front").inverted())
        sink = Matrix.Translation((0.2, -0.3, 0.0)) @ Matrix.Rotation(0.16, 4, "Y") @ Matrix.Rotation(0.12, 4, "X") @ Matrix.Translation((-0.2, 0.3, 0.0))
        for item_id in build.items:
            if item_id != "wheel-right-front":
                root(build.objects[item_id]).matrix_world = Matrix.Translation((0, 0, -0.05)) @ sink @ root(build.objects[item_id]).matrix_world
        bpy.context.view_layer.update()
        orbit(camera, build.centre() + Vector((0.3, -0.3, -0.3)), -40)
        panels.append(shot())
        # The mini-tank loses its right track, which lies flat on its frame beside it; the hull sags onto that side.
        clear(collection)
        build = Build(kits, descriptor, "mini-tank", at(0, 0), variants={"track-left": "damaged"})
        build.detach("track-right", Matrix.Translation((0.5, -1.1, 0.0)) @ Matrix.Rotation(1.9, 4, "Z") @ Matrix.Translation((0, -0.3, 0)) @ build.world("track-right").inverted())
        sag = Matrix.Translation((0, -0.3, 0)) @ Matrix.Rotation(-0.12, 4, "X") @ Matrix.Translation((0, 0.3, 0))
        for item_id in build.items:
            if item_id != "track-right":
                root(build.objects[item_id]).matrix_world = sag @ root(build.objects[item_id]).matrix_world
        bpy.context.view_layer.update()
        orbit(camera, build.centre() + Vector((0.2, -0.4, -0.2)), -55)
        panels.append(shot())
        # Close (40 degree lens): the wheeler's damaged rear wheel and the tank's damaged track on their builds, then a lost
        # wheel and track on their own, upside down, showing their closed mount faces.
        camera.data.angle = math.radians(40)
        clear(collection)
        build = Build(kits, descriptor, "wheeler", variants={"wheel-left-rear": "damaged"})
        orbit(camera, hub(build, "wheel-left-rear"), 115, distance=1.5, eye_height=0.75)
        panels.append(shot())
        clear(collection)
        build = Build(kits, descriptor, "mini-tank", variants={"track-left": "damaged"})
        orbit(camera, hub(build, "track-left"), 70, distance=1.8, eye_height=0.9)
        panels.append(shot())
        clear(collection)
        root(kits.build("robot.wheel", "damaged")).matrix_world = Matrix.Translation((0, 0, 0.2)) @ Matrix.Rotation(math.pi, 4, "X")
        root(kits.build("robot.track", "damaged")).matrix_world = Matrix.Translation((0.55, 0.1, 0.36)) @ Matrix.Rotation(math.pi, 4, "X")
        bpy.context.view_layer.update()
        orbit(camera, Vector((0.4, -0.1, 0.1)), -60, distance=1.8, eye_height=1.2)
        panels.append(shot())
        camera.data.angle = math.radians(60)
        sheet(panels, 3, os.path.join(out, "damage.jpg"))

    if want("gameplay"):
        clear(collection)
        for i, name in enumerate(("biped", "wheeler", "strafer", "mini-tank", "crab")):
            build = Build(kits, descriptor, name, at(-0.6 * (i % 2), 5.2 - i * 2.6, math.radians(-15)))
            walk(build, 0.2)
        scene.render.resolution_x, scene.render.resolution_y = 1440, 810
        aim(camera, Vector((9.5, -2.5, 1.7)), Vector((0, 0, 0.5)))
        panels = [shot()]
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
