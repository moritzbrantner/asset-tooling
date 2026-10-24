"""Ranger facial variants (#348) as shape keys for the pinned Blender script backend.

The declared input ``source`` is the Ranger head part: the Universal Base Characters body cut to its head and face
(``scene.subset.skinned.gltf@1``), with the ``Eyes`` and ``Eyebrows`` meshes, still skinned to the 65-joint rig. The
script adds one shape key per facial option to the head, eye and eyebrow meshes and exports the part again with its
morph targets. The build copies only the morph targets back onto the original part (vertex by vertex, by position),
so the skin, materials and attributes of the shipped head never pass through Blender.

Four features, each with a base (no key) and two keys, selected independently:

- face: ``face.broad`` (square, wider jaw and chin) and ``face.narrow`` (slimmer cheeks, longer chin);
- eyes: ``eyes.large`` (eyeballs and lids scaled up) and ``eyes.narrow`` (almond lids with raised outer corners);
- nose: ``nose.broad`` (wide wings, flatter tip) and ``nose.long`` (longer, prominent tip, raised bridge);
- mouth: ``mouth.full`` (fuller, wider lips) and ``mouth.thin`` (thinner, narrower lips).

Every key is a smooth displacement field in the rest model space, placed on landmarks measured from the mesh (eye
centres, nose tip, mouth line, chin), so it fits both the male and the female head. The keys of different features
touch separate regions and add up. No key moves the cranium (above the brows), the ears and back of the head, or the
neck where the part meets the outfit, so hair, headwear, the hood and the head sockets keep fitting. Eye lids move
along the eyeball's sphere, so they never cut into it. No randomness is used.
"""
import math

import bpy
from mathutils import Vector

FEATURES = {
    "face": ["face.broad", "face.narrow"],
    "eyes": ["eyes.large", "eyes.narrow"],
    "nose": ["nose.broad", "nose.long"],
    "mouth": ["mouth.full", "mouth.thin"],
}
KEYS = [key for keys in FEATURES.values() for key in keys]
# The male interocular distance the field sizes were tuned on; other heads scale every radius and offset by theirs.
REFERENCE_INTEROCULAR = 0.0676


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion"} or p["schemaVersion"] != 1 or type(p["schemaVersion"]) is not int:
        raise ValueError("face variants require exactly schemaVersion 1")
    if set(inputs) != {"source"}:
        raise ValueError("face variants take exactly the declared input source")


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def bump(p, centre, radii):
    """1 at the centre, falling smoothly to 0 on the ellipsoid with these radii."""
    d = sum(((p[i] - centre[i]) / radii[i]) ** 2 for i in range(3))
    return (1 - d) ** 2 if d < 1 else 0.0


def world_points(obj):
    m = obj.matrix_world
    return [m @ v.co for v in obj.data.vertices]


def landmarks(head, eyes):
    """Eye centres, nose tip, mouth line and chin of the head in rest model space (Blender axes: front is -Y)."""
    eye_points = world_points(eyes)
    centres = []
    for side in (1, -1):
        side_points = [p for p in eye_points if p.x * side > 0]
        lo = Vector([min(p[i] for p in side_points) for i in range(3)])
        hi = Vector([max(p[i] for p in side_points) for i in range(3)])
        centres.append(((lo + hi) / 2, max(hi - lo) / 2))
    (left, radius), (right, _) = centres
    scale = (left - right).length / REFERENCE_INTEROCULAR
    eye_z = left.z
    mid = [p for p in world_points(head) if abs(p.x) < 0.003 * scale]
    front = [p for p in mid if eye_z - 0.09 * scale < p.z < eye_z - 0.01 * scale]
    tip = min(front, key=lambda p: p.y)
    # The mouth line is the deepest midline point between the nose and the chin (the inner mouth).
    mouth = max((p for p in mid if tip.z - 0.06 * scale < p.z < tip.z - 0.015 * scale and p.y < tip.y + 0.06 * scale), key=lambda p: p.y)
    chin = min((p for p in mid if mouth.z - 0.05 * scale < p.z < mouth.z - 0.02 * scale), key=lambda p: p.y)
    return {"eyes": [left, right], "eyeRadius": radius, "scale": scale, "tip": tip, "mouth": mouth, "chin": chin}


def face_fields(lm):
    """Displacement functions p -> new p for every key, in rest model space."""
    s, tip, mouth, chin = lm["scale"], lm["tip"], lm["mouth"], lm["chin"]
    eyes, eye_radius = lm["eyes"], lm["eyeRadius"]
    front_y = tip.y

    def jaw_weight(p):
        # The lower face from the cheekbones down to the jaw line, fading out on the neck and toward the ears.
        top = smooth((tip.z + 0.004 * s - p.z) / (0.035 * s))
        bottom = smooth((p.z - (chin.z - 0.03 * s)) / (0.018 * s))
        back = smooth((0.035 * s - (p.y - front_y - 0.09 * s)) / (0.035 * s))
        return top * bottom * back

    def side(p, amount):
        return math.copysign(amount, p.x) * smooth(abs(p.x) / (0.07 * s))

    def face_broad(p):
        w = jaw_weight(p)
        q = p.copy()
        q.x += side(p, 0.008 * s) * w
        c = bump(p, (0, chin.y + 0.004 * s, chin.z + 0.002 * s), (0.04 * s, 0.035 * s, 0.026 * s))
        q.x += p.x * 0.22 * c
        q.y -= 0.002 * s * c
        return q

    def face_narrow(p):
        w = jaw_weight(p)
        q = p.copy()
        q.x -= side(p, 0.009 * s) * w
        c = bump(p, (0, chin.y + 0.004 * s, chin.z), (0.045 * s, 0.04 * s, 0.03 * s))
        q.z -= 0.009 * s * c
        q.y -= 0.002 * s * c
        q.x -= p.x * 0.1 * c
        return q

    def lids(p, change, eyeball):
        # Points around each eye, moved by `change(d, w, side)` relative to the eyeball centre, with their
        # distance from it kept where they rest on the eyeball, so lids slide over it instead of cutting in.
        q = p.copy()
        for centre, sgn in ((eyes[0], 1), (eyes[1], -1)):
            if p.x * sgn <= 0:
                continue
            w = 1.0 if eyeball else bump(p, centre, (0.028 * s, 0.03 * s, 0.024 * s))
            if w:
                d = p - centre
                q = centre + change(d, w, sgn)
        return q

    def eyes_large(p, eyeball=False):
        return lids(p, lambda d, w, sgn: d * (1 + 0.26 * w), eyeball)

    def eyes_narrow(p, eyeball=False):
        if eyeball:
            return p.copy()

        def change(d, w, sgn):
            length = d.length
            angle = math.radians(12) * w * sgn  # outer corners up: +X eye turns counter-clockwise seen from the front
            x = d.x * math.cos(angle) - d.z * math.sin(angle)
            z = d.x * math.sin(angle) + d.z * math.cos(angle)
            out = Vector((x * (1 + 0.06 * w), d.y, z * (1 - 0.42 * w)))
            # On and near the eyeball's surface, keep the distance from its centre.
            on_shell = smooth((eye_radius * 1.6 - length) / (eye_radius * 0.6))
            if out.length > 1e-9:
                out = out.lerp(out.normalized() * length, on_shell)
            return out
        return lids(p, change, False)

    wings = (0, tip.y + 0.014 * s, tip.z - 0.008 * s)

    def nose_broad(p):
        q = p.copy()
        w = bump(p, wings, (0.03 * s, 0.03 * s, 0.019 * s))
        q.x += p.x * 0.42 * w
        t = bump(p, tip, (0.016 * s, 0.016 * s, 0.016 * s))
        q.y += 0.004 * s * t
        q.z -= 0.0015 * s * t
        return q

    def nose_long(p):
        q = p.copy()
        t = bump(p, tip, (0.018 * s, 0.022 * s, 0.02 * s))
        q.y -= 0.009 * s * t
        q.z -= 0.004 * s * t
        b = bump(p, (0, tip.y + 0.012 * s, tip.z + 0.022 * s), (0.012 * s, 0.02 * s, 0.016 * s))
        q.y -= 0.0035 * s * b
        w = bump(p, wings, (0.03 * s, 0.03 * s, 0.019 * s))
        q.x -= p.x * 0.18 * w
        return q

    lips = (0, mouth.y - 0.018 * s, mouth.z)
    lip_radii = (0.034 * s, 0.03 * s, 0.017 * s)

    def mouth_full(p):
        q = p.copy()
        w = bump(p, lips, lip_radii)
        q.z += (p.z - mouth.z) * 0.8 * w
        q.y -= 0.004 * s * w
        q.x += p.x * 0.1 * w
        return q

    def mouth_thin(p):
        q = p.copy()
        w = bump(p, lips, lip_radii)
        q.z -= (p.z - mouth.z) * 0.5 * w
        q.y += 0.002 * s * w
        q.x -= p.x * 0.1 * w
        return q

    return {
        "face.broad": face_broad, "face.narrow": face_narrow,
        "eyes.large": eyes_large, "eyes.narrow": eyes_narrow,
        "nose.broad": nose_broad, "nose.long": nose_long,
        "mouth.full": mouth_full, "mouth.thin": mouth_thin,
    }


def add_keys(head, eyes, brows):
    """Adds a Basis and every key to the three meshes; returns the landmarks and per-key displacement maxima."""
    lm = landmarks(head, eyes)
    fields = face_fields(lm)
    stats = {}
    for obj in (head, eyes, brows):
        if obj.data.shape_keys:
            obj.shape_key_clear()
        obj.shape_key_add(name="Basis", from_mix=False)
        m, inverse = obj.matrix_world, obj.matrix_world.inverted()
        points = world_points(obj)
        for key in KEYS:
            block = obj.shape_key_add(name=key, from_mix=False)
            field = fields[key]
            eyeball = obj is eyes and key.startswith("eyes.")
            largest = 0.0
            for index, p in enumerate(points):
                q = field(p, True) if eyeball else field(p)
                if obj is eyes and not key.startswith("eyes."):
                    q = p  # only the eye keys move the eyeballs
                largest = max(largest, (q - p).length)
                block.data[index].co = inverse @ q
            stats.setdefault(key, {})[obj.name] = round(largest, 6)
        obj.data.update()
    return lm, stats


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=inputs["source"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    imported = list(bpy.context.scene.objects)
    for obj in imported:
        if obj.type == "ARMATURE":
            obj.data.pose_position = "REST"
    bpy.context.view_layer.update()
    meshes = {o.name: o for o in imported if o.type == "MESH" and not o.name.startswith("Icosphere")}
    if "Eyes" not in meshes or "Eyebrows" not in meshes or len(meshes) != 3:
        raise ValueError(f"the head part must hold Eyes, Eyebrows and one head mesh, not {sorted(meshes)}")
    eyes, brows = meshes.pop("Eyes"), meshes.pop("Eyebrows")
    (head,) = meshes.values()
    lm, stats = add_keys(head, eyes, brows)
    # Compatibility: the cranium above the brows (hair, headwear, hood), the ears and back of the head, and the neck
    # down to the cut where the part meets the outfit stay where they are.
    s = lm["scale"]
    brow_top = max(p.z for p in world_points(brows))
    points = world_points(head)
    fixed = {i for i, p in enumerate(points)
             if p.z > brow_top + 0.01 * s or p.z < lm["chin"].z - 0.035 * s or p.y - lm["tip"].y > 0.13 * s}
    moved = 0.0
    for block in head.data.shape_keys.key_blocks[1:]:
        for i in fixed:
            distance = (block.data[i].co - head.data.vertices[i].co).length
            moved = max(moved, distance)
            if distance > 1e-6:
                raise ValueError(f"{block.name} moves the fixed cranium, ears or neck by {distance} m at {points[i]}")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in imported:
        if not obj.name.startswith("Icosphere"):
            obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_animations=False, export_skins=True, export_morph=True, export_morph_normal=True,
        export_cameras=False, export_lights=False, export_extras=False)
    v = lambda p: [round(p.x, 5), round(p.z, 5), round(-p.y, 5)]  # glTF axes
    return {
        "recipe": "face-variants-v1", "features": FEATURES, "head": head.name,
        "landmarks": {"eyes": [v(p) for p in lm["eyes"]], "noseTip": v(lm["tip"]), "mouth": v(lm["mouth"]), "chin": v(lm["chin"]),
                      "scale": round(lm["scale"], 5)},
        "maxDisplacement": stats, "fixedVertices": len(fixed), "fixedMaxDisplacement": moved,
    }
