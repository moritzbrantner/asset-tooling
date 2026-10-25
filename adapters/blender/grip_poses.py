"""Grip poses: the Ranger's fingers wrapped around held items (#285), authored on the Ranger rig in Blender.

The declared input ``target`` is the composed Ranger GLB. ``arguments["grips"]`` lists one grip per output clip:

- ``clip``: the clip name, for example ``Grip_Weapon_R``.
- ``socket``: the hand socket holding the item (``joint`` ``hand_l`` or ``hand_r``, ``translation``, ``rotation``), in
  the joint's glTF frame, as in the sockets descriptor.
- ``surface``: what the hand closes on, in the held item's grip frame. ``{"kind": "cylinder", "axis", "radius"}`` is a
  handle, shaft or riser through the grip origin; ``{"kind": "relaxed"}`` is a flat item held against the back of
  the hand (the tome), which leaves the hand loosely curled.

On a cylinder each finger (index, middle, ring, pinky) curls toward the palm joint by joint from the knuckle, one
degree at a time, until the segment reaches the handle (its distance from the axis is the radius plus the finger's
half thickness) or the joint's limit. The thumb then swings to rest over the wrapped index finger, and its two outer
joints close onto the handle. Poses are authored at rest; finger joints are local to the hand, so a grip holds in
every arm pose.

Every clip is a static pose of two identical frames (Blender exports them as STEP; the build relabels them LINEAR).
The returned observations hold each grip's curl in degrees per joint. No Mixamo data, no randomness.
"""
import json
import math
import struct

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 30
FINGERS = ("index", "middle", "ring", "pinky")
# Joint limits in degrees (01, 02, 03) and half thicknesses in metres of the finger and thumb segments.
FINGER_LIMIT = (90, 105, 80)
THUMB_LIMIT = (40, 70, 70)
FINGER_HALF = (.010, .009, .008)
THUMB_HALF = .009
# The least bend of the thumb's outer joints (02, 03) on a handle.
THUMB_BEND = (20, 30)
# The thumb rests on the outside of the wrapped index finger, this far out from it.
THUMB_REST = .012
# The relaxed hand (a flat item such as the tome against the back of the hand): degrees per joint (01, 02, 03).
RELAXED = {"index": (12, 20, 12), "middle": (15, 25, 15), "ring": (18, 28, 15), "pinky": (22, 32, 18), "thumb": (5, 10, 10)}
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "grips"} or p["schemaVersion"] != 1:
        raise ValueError("grip poses require exactly schemaVersion 1 and grips")
    if set(inputs) != {"target"}:
        raise ValueError("grip poses take exactly the declared input target")
    if not isinstance(p["grips"], list) or not p["grips"]:
        raise ValueError("grip poses need at least one grip")
    names = set()
    for grip in p["grips"]:
        if type(grip) is not dict or set(grip) != {"clip", "socket", "surface"}:
            raise ValueError("each grip needs exactly clip, socket and surface")
        if not isinstance(grip["clip"], str) or grip["clip"] in names:
            raise ValueError("grip clip names must be unique strings")
        names.add(grip["clip"])
        if grip["socket"].get("joint") not in ("hand_l", "hand_r"):
            raise ValueError(f"{grip['clip']}: the socket must be on hand_l or hand_r")
        surface = grip["surface"]
        if surface.get("kind") == "cylinder":
            if set(surface) != {"kind", "axis", "radius"} or not 0 < surface["radius"] < .06:
                raise ValueError(f"{grip['clip']}: a cylinder needs an axis and a radius in (0, 0.06) m")
        elif surface != {"kind": "relaxed"}:
            raise ValueError(f"{grip['clip']}: surface kind must be cylinder or relaxed")


def gltf_rest_worlds(path):
    """World matrices (glTF axes) of every named node of the declared target, at rest."""
    data = open(path, "rb").read()
    doc = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]] if data[:4] == b"glTF" else data)
    nodes, worlds = doc["nodes"], {}

    def local(node):
        if "matrix" in node:
            m = node["matrix"]
            return Matrix([m[0:4], m[4:8], m[8:12], m[12:16]]).transposed()
        r = node.get("rotation", [0, 0, 0, 1])
        return Matrix.LocRotScale(Vector(node.get("translation", [0, 0, 0])), Quaternion((r[3], r[0], r[1], r[2])),
                                  Vector(node.get("scale", [1, 1, 1])))

    def walk(index, parent):
        world = parent @ local(nodes[index])
        if "name" in nodes[index]:
            worlds[nodes[index]["name"]] = world
        for child in nodes[index].get("children", []):
            walk(child, world)

    for root in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        walk(root, Matrix.Identity(4))
    return worlds


class Hand:
    """Pose access in the glTF joint frames (the frames the sockets are declared in), in Blender world space."""

    def __init__(self, rig, gltf_worlds):
        self.rig = rig
        self.bones = rig.pose.bones
        self.reset()
        world = rig.matrix_world
        self.offset = {b.name: (world @ b.matrix_local).inverted() @ C4 @ gltf_worlds[b.name] for b in rig.data.bones}
        # The palm faces down (-Z) in the rest T-pose; keep that direction in each hand's joint frame.
        self.palm = {side: self.joint(f"hand_{side}").to_3x3().inverted() @ Vector((0, 0, -1)) for side in "lr"}

    def joint(self, name):
        return self.rig.matrix_world @ self.bones[name].matrix @ self.offset[name]

    def head(self, name):
        return self.joint(name).translation.copy()

    def turn(self, name, axis, degrees):
        """Rotate a joint (and its children) about a world axis through its head."""
        world = self.joint(name)
        centre = world.translation.copy()
        rotation = Matrix.Translation(centre) @ Matrix.Rotation(math.radians(degrees), 4, axis) @ Matrix.Translation(-centre)
        self.bones[name].matrix = self.rig.matrix_world.inverted() @ rotation @ world @ self.offset[name].inverted()
        bpy.context.view_layer.update()

    def reset(self):
        for pb in self.bones:
            pb.matrix_basis = Matrix.Identity(4)
        bpy.context.view_layer.update()


def chain(finger, side):
    return [f"{finger}_{k}_{side}" for k in ("01", "02", "03", "04_leaf")]


class Handle:
    """The held cylinder in Blender world space; ``gap`` is a point's clearance over it."""

    def __init__(self, hand, socket, surface):
        t, r = socket["translation"], socket["rotation"]
        frame = hand.joint(socket["joint"]) @ Matrix.LocRotScale(Vector(t), Quaternion((r[3], r[0], r[1], r[2])), Vector((1, 1, 1)))
        self.origin = frame.translation.copy()
        self.direction = (frame.to_3x3() @ Vector(surface["axis"])).normalized()
        self.radius = surface["radius"]

    def outward(self, point):
        """The direction from the axis to ``point``."""
        v = point - self.origin
        return (v - self.direction * v.dot(self.direction)).normalized()

    def gap(self, point):
        v = point - self.origin
        return (v - self.direction * v.dot(self.direction)).length - self.radius

    def segment_gap(self, a, b):
        return min(self.gap(a.lerp(b, i / 8)) for i in range(9))


def close(hand, joint, child, axis, surface, half, limit):
    """Turn ``joint`` about ``axis`` until its segment touches ``surface`` or reaches ``limit``; the degrees turned."""
    turned = 0
    while turned < limit and surface.segment_gap(hand.head(joint), hand.head(child)) > half:
        hand.turn(joint, axis, 1.0)
        turned += 1
    return turned


def grip_pose(hand, side, surface):
    """Wrap the fingers of hand ``side`` around ``surface`` (a Handle, or None for the relaxed hand) from the rest
    pose; the degrees per joint."""
    hand.reset()
    palm = hand.joint(f"hand_{side}").to_3x3() @ hand.palm[side]
    curl = {}
    for finger in (*FINGERS, "thumb") if surface is None else FINGERS:
        joints = chain(finger, side)
        # One hinge per finger: across the finger, in the palm plane; turning about it moves the finger toward the palm.
        axis = (hand.head(joints[1]) - hand.head(joints[0])).normalized().cross(palm).normalized()
        for k in range(3):
            if surface is None:
                hand.turn(joints[k], axis, RELAXED[finger][k])
                curl[joints[k]] = RELAXED[finger][k]
            else:
                curl[joints[k]] = close(hand, joints[k], joints[k + 1], axis, surface, FINGER_HALF[k], FINGER_LIMIT[k])
    thumb = chain("thumb", side)
    if surface is not None:
        # Swing the thumb to rest over the wrapped index finger, then close its outer joints onto the handle.
        index = chain("index", side)
        over = hand.head(index[1]).lerp(hand.head(index[2]), .5)
        target = over + surface.outward(over) * THUMB_REST
        base = hand.head(thumb[0])
        axis, angle = (hand.head(thumb[3]) - base).rotation_difference(target - base).to_axis_angle()
        hand.turn(thumb[0], axis, math.degrees(angle))
        curl[thumb[0]] = round(math.degrees(angle), 1)
        for k in (1, 2):
            direction = (hand.head(thumb[k + 1]) - hand.head(thumb[k])).normalized()
            hinge = direction.cross(-surface.outward(hand.head(thumb[k]))).normalized()
            curl[thumb[k]] = close(hand, thumb[k], thumb[k + 1], hinge, surface, THUMB_HALF, THUMB_LIMIT[k])
            # Already touching at the joint: bend the rest of the thumb round the handle until its end touches too.
            while curl[thumb[k]] < THUMB_BEND[k - 1] and surface.gap(hand.head(thumb[k + 1])) > THUMB_HALF:
                hand.turn(thumb[k], hinge, 1.0)
                curl[thumb[k]] += 1
    return {pb.name: pb.matrix_basis.copy() for pb in hand.bones}, curl


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=inputs["target"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
    target_objects = [o for o in bpy.context.scene.objects if o not in before]
    rigs = [o for o in target_objects if o.type == "ARMATURE"]
    if len(rigs) != 1:
        raise ValueError("the target GLB must have one armature")
    rig = rigs[0]
    data = rig.animation_data_create()
    data.action = None
    for other in list(bpy.data.actions):
        bpy.data.actions.remove(other)
    hand = Hand(rig, gltf_rest_worlds(inputs["target"]))

    poses, observed = {}, {}
    for grip in arguments["grips"]:
        hand.reset()
        side = grip["socket"]["joint"][-1]
        handle = Handle(hand, grip["socket"], grip["surface"]) if grip["surface"]["kind"] == "cylinder" else None
        pose, curl = grip_pose(hand, side, handle)
        poses[grip["clip"]] = pose
        observed[grip["clip"]] = curl
    hand.reset()

    bpy.context.scene.render.fps, bpy.context.scene.render.fps_base = FPS, 1
    for clip, pose in poses.items():
        action = bpy.data.actions.new(clip)
        data.action = action
        for frame in (0, 1):
            for name, basis in pose.items():
                pb = rig.pose.bones[name]
                pb.matrix_basis = basis
                pb.keyframe_insert("rotation_quaternion", frame=frame)
        action.use_fake_user = True
        data.action = None
    hand.reset()
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = 0, 1

    bpy.ops.object.select_all(action="DESELECT")
    for item in target_objects:
        if item.name in bpy.data.objects:
            item.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=False, export_tangents=False, export_materials="NONE",
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=False, export_optimize_animation_keep_anim_armature=True,
        export_skins=True, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "grip-pose-v1", "fps": FPS, "grips": observed}
