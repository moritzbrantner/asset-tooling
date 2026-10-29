"""Original water locomotion clips authored on the Ranger rig in Blender (#393, mmorpg#499, Atlas 6.6.41).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors one new in-place
clip, named ``arguments["clip"]``, from explicit limb trajectories (no source motion is copied):

- ``Wade_Fwd_Loop``: a slow waist-deep walk. The feet follow in-place trajectories (a stance foot slides back at the
  reference speed, the swing foot lifts high with the knee forward), the pelvis sits a little lower, the torso leans
  into the water and the forearms are held up and forward, swinging slightly against the legs.
- ``Swim_Idle_Loop``: treading water upright. Eggbeater legs (thighs forward, knees circling out of phase), arms out
  to the sides sculling at chest height, head up.
- ``Swim_Fwd_Loop``: front crawl, authored **upright** (body along +Z in Blender, facing -Y): "ahead" in the swim is
  overhead and "down" is in front of the chest; the consumer pitches the whole body. Alternating arms pull through
  the front and recover over the back with a high elbow, the torso rolls with the pull, flutter kick.
- ``Swim_Down_Loop``: a long-glide breaststroke (the consumer tilts the body head-down).
- ``Swim_Up_Loop``: a quicker breaststroke whose pull sweeps the hands down to the hips (the consumer tilts head-up).
- ``Swim_Enter``: from the standing ``Idle_Loop`` pose, arms rising and legs drawing up, into the tread pose.
- ``Swim_Exit``: from the tread pose, one leg reaching down and the arms pressing the water, to the standing pose.

Mixamo and other clips were only watched as motion reference. The output GLB is the target skeleton with its meshes
and the single clip, which the build extracts and embeds like the other clips. No randomness.
"""
import math

import bpy
from mathutils import Matrix, Quaternion, Vector

CLIPS = ("Wade_Fwd_Loop", "Swim_Idle_Loop", "Swim_Fwd_Loop", "Swim_Down_Loop", "Swim_Up_Loop", "Swim_Enter", "Swim_Exit")
STAND = "Idle_Loop"
FPS = 30
LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
ARMS = {"l": ("upperarm_l", "lowerarm_l", "hand_l"), "r": ("upperarm_r", "lowerarm_r", "hand_r")}
SIDE = {"l": 1.0, "r": -1.0}
UP, FWD, BACK = Vector((0, 0, 1)), Vector((0, -1, 0)), Vector((0, 1, 0))
# Wading: metres, seconds, metres per second; stance/swing as cycle fractions.
WADE = {"period": 1.5, "speed": .75, "stance": .6, "lift": .2, "drop": .05, "lean": 9.0}
TREAD = {"period": 1.6}
CRAWL = {"period": 1.3, "speed": 1.8, "roll": 28.0, "kicks": 3}
BREAST = {
    "Swim_Down_Loop": {"period": 1.6, "pull": .3, "glide": .32, "deep": False},
    "Swim_Up_Loop": {"period": 1.15, "pull": .38, "glide": .12, "deep": True},
}
TRANSITION = {"Swim_Enter": .8, "Swim_Exit": 1.0}


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clip"}:
        raise ValueError("swim clip requires exactly schemaVersion and clip")
    if p["schemaVersion"] != 1 or p["clip"] not in CLIPS:
        raise ValueError(f"swim clip must be one of {CLIPS}")
    if set(inputs) != {"target"}:
        raise ValueError("swim clip takes exactly the declared input target")


def action_curves(action):
    curves = list(getattr(action, "fcurves", None) or [])
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                curves.extend(bag.fcurves)
    return curves


def smooth(u):
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)


def window(p, start, end):
    """0 before ``start``, 1 after ``end``, smooth between (cycle phase ``p``)."""
    return smooth((p - start) / (end - start))


def vec(x, y, z):
    return Vector((x, y, z)).normalized()


class Rig:
    def __init__(self, rig):
        self.rig = rig
        self.bones = rig.pose.bones
        self.rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}

    def capture(self):
        return {pb.name: pb.matrix_basis.copy() for pb in self.bones}

    def apply(self, pose):
        for name, basis in pose.items():
            self.bones[name].matrix_basis = basis
        bpy.context.view_layer.update()

    def head(self, name):
        return self.bones[name].head.copy()

    def length(self, a, b):
        return (self.rest[b].translation - self.rest[a].translation).length


def sample(rig, action, frame):
    data = rig.rig.animation_data
    data.action = action
    if hasattr(data, "action_slot") and action.slots:
        data.action_slot = action.slots[0]
    bpy.context.scene.frame_set(int(math.floor(frame)), subframe=frame - math.floor(frame))
    bpy.context.view_layer.update()
    pose = rig.capture()
    data.action = None
    return pose


def blend(a, b, u):
    """Per-bone blend of two captured poses: slerped rotation, interpolated location."""
    out = {}
    for name in a:
        la, ra, _ = a[name].decompose()
        lb, rb, _ = b[name].decompose()
        if ra.dot(rb) < 0:
            rb.negate()
        out[name] = Matrix.Translation(la.lerp(lb, u)) @ ra.slerp(rb, u).to_matrix().to_4x4()
    return out


def rotate_world(rig, name, axis, degrees):
    """Rotate a bone about an armature-space axis through its head; its children follow."""
    pb = rig.bones[name]
    head = pb.matrix.translation.copy()
    pb.matrix = Matrix.Translation(head) @ Matrix.Rotation(math.radians(degrees), 4, axis) @ Matrix.Translation(-head) @ pb.matrix
    bpy.context.view_layer.update()


def aim(rig, name, direction, twist=0.0):
    """Point a bone (its local +Y) along ``direction`` by the minimal turn from its rest, then twist it about itself."""
    pb = rig.bones[name]
    rest = rig.rest[name]
    rest_y = (rest.to_3x3() @ Vector((0, 1, 0))).normalized()
    turn = rest_y.rotation_difference(direction.normalized()).to_matrix().to_4x4()
    m = Matrix.Rotation(math.radians(twist), 4, direction.normalized()) @ turn @ rest.to_3x3().to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


def level(rig, name):
    pb = rig.bones[name]
    m = rig.rest[name].to_3x3().to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


def arm(rig, side, upper, fore, twist=0.0):
    """Upper arm along ``upper``, forearm and hand along ``fore`` (armature space), forearm twisted by ``twist``."""
    a, b, c = ARMS[side]
    aim(rig, a, upper)
    aim(rig, b, fore, SIDE[side] * twist)
    aim(rig, c, fore, SIDE[side] * twist)


def leg_angles(rig, side, pitch, knee, splay=0.0, point=1.0):
    """Thigh pitched ``pitch`` degrees forward (towards -Y) and ``splay`` outwards, calf bent ``knee`` degrees back;
    the foot ``point`` = 1 is pointed along the shin, 0 is level."""
    thigh, calf, foot, ball = LEGS[side]
    s, pr, sp = SIDE[side], math.radians(pitch), math.radians(splay)
    upper = Vector((s * math.sin(sp), -math.sin(pr) * math.cos(sp), -math.cos(pr) * math.cos(sp)))
    aim(rig, thigh, upper)
    shin_pitch = math.radians(pitch - knee)
    lower = Vector((s * math.sin(sp), -math.sin(shin_pitch) * math.cos(sp), -math.cos(shin_pitch) * math.cos(sp)))
    aim(rig, calf, lower)
    if point >= 1.0:
        aim(rig, foot, lower + FWD * .35)
    else:
        level(rig, foot)
        if point > 0:
            pb = rig.bones[foot]
            rest_dir = (pb.matrix.to_3x3() @ Vector((0, 1, 0))).normalized()
            aim(rig, foot, rest_dir.lerp((lower + FWD * .35).normalized(), point))
    rig.bones[ball].matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


def solve_leg(rig, side, ankle, forward):
    thigh, calf, foot, ball = LEGS[side]
    hip = rig.head(thigh)
    l1, l2 = rig.length(thigh, calf), rig.length(calf, foot)
    reach = ankle - hip
    d = min(reach.length, (l1 + l2) * .999)
    u = reach.normalized()
    a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    knee = hip + u * a + (forward - u * forward.dot(u)).normalized() * h
    aim(rig, thigh, knee - hip)
    aim(rig, calf, (hip + u * d) - knee)
    level(rig, foot)
    rig.bones[ball].matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


def place_pelvis(rig, rest_hips, dz):
    pelvis = rig.bones["pelvis"]
    m = pelvis.matrix.copy()
    m.translation = rest_hips + Vector((0, 0, dz))
    pelvis.matrix = m
    bpy.context.view_layer.update()


def wade(rig, p, base):
    """Waist-deep walk at phase ``p``: high-stepping in-place feet, raised forearms."""
    rig.apply(base["rest"])
    period, stance = WADE["period"], WADE["stance"]
    span = WADE["speed"] * period * stance
    bob = .015 * math.cos(4 * math.pi * p)
    place_pelvis(rig, base["hips"], -WADE["drop"] + bob)
    targets = {}
    for side, offset in (("l", 0.0), ("r", .5)):
        q = (p + offset) % 1.0
        ankle = base["ankle"][side].copy()
        if q < stance:
            ankle.y += -span / 2 + span * q / stance
        else:
            u = (q - stance) / (1 - stance)
            ankle.y += span / 2 - span * smooth(u)
            ankle.z += WADE["lift"] * math.sin(math.pi * u) ** 1.5
            ankle.y -= .06 * math.sin(math.pi * u)
        ankle.z -= WADE["drop"] * .2
        targets[side] = ankle
    for side in LEGS:
        solve_leg(rig, side, targets[side], FWD)
    for side in ARMS:
        s = SIDE[side]
        # Opposite to the same-side leg: the left arm leads as the right leg steps.
        swing = math.sin(2 * math.pi * (p + (0.0 if side == "l" else .5)))
        arm(rig, side, vec(s * .75, -.25 + .12 * swing, -.55), vec(s * .3, -1, .3 + .05 * swing), twist=-40)
    # A positive turn about +X tips the head forwards (-Y).
    rotate_world(rig, "spine_01", Vector((1, 0, 0)), WADE["lean"])
    rotate_world(rig, "spine_01", UP, 5 * math.sin(2 * math.pi * p))


def tread(rig, p, base):
    """Treading water at phase ``p``: eggbeater legs, sculling arms, head up."""
    rig.apply(base["rest"])
    place_pelvis(rig, base["hips"], .015 * math.sin(4 * math.pi * p))
    for side, offset in (("l", 0.0), ("r", .5)):
        c = 2 * math.pi * (p + offset)
        leg_angles(rig, side, 48 + 8 * math.sin(c), 88 + 22 * math.cos(c), splay=22 + 10 * math.sin(c), point=.4)
    for side in ARMS:
        s = SIDE[side]
        # Sculling: the forearms sweep in and out level in front of the chest, the palms turning with the sweep.
        sweep = math.sin(2 * math.pi * p * 2)
        arm(rig, side, vec(s * .7, -.3, -.65), vec(s * (.35 + .3 * sweep), -1, -.05), twist=-25 * sweep)
    rotate_world(rig, "spine_01", Vector((1, 0, 0)), 4)
    rotate_world(rig, "neck_01", Vector((1, 0, 0)), -6)


def crawl(rig, p, base):
    """Front crawl at phase ``p``, upright: overhead is ahead, in front of the chest is the pool floor."""
    rig.apply(base["rest"])
    place_pelvis(rig, base["hips"], 0.0)
    for side, offset in (("r", 0.0), ("l", .5)):
        s = SIDE[side]
        q = (p + offset) % 1.0
        if q < .55:
            # Pull: from overhead, under the body (in front of the chest), to the hip; the elbow bends mid-pull.
            u = smooth(q / .55)
            theta = math.pi * u
            upper = vec(s * (.15 - .1 * math.sin(theta)), -math.sin(theta), math.cos(theta))
            fore = (upper + FWD * (.15 + .9 * math.sin(theta))).normalized()
            twist = 0.0
        else:
            # Recovery: high elbow out to the side and over the back, hand trailing, back to overhead.
            u = smooth((q - .55) / .45)
            theta = math.pi * (1 + u)
            upper = vec(s * (.15 + .75 * math.sin(math.pi * u)), -math.sin(theta) * .8, math.cos(theta))
            fore = (upper + FWD * .2 - UP * (1.1 * math.sin(math.pi * u)) + Vector((s * -.3 * math.sin(math.pi * u), 0, 0))).normalized()
            twist = 50 * math.sin(math.pi * u)
        arm(rig, side, upper, fore, twist)
    kick = 2 * math.pi * CRAWL["kicks"] * p
    for side, offset in (("l", 0.0), ("r", math.pi)):
        k = math.sin(kick + offset)
        # Flutter kick: the downbeat (towards the floor, -Y) with a bent knee, the upbeat straight.
        leg_angles(rig, side, 4 + 14 * k, 6 + 18 * max(0.0, -math.cos(kick + offset)), splay=3, point=1.0)
    rotate_world(rig, "spine_01", UP, CRAWL["roll"] * math.sin(2 * math.pi * (p + .25)))
    rotate_world(rig, "pelvis", UP, .35 * CRAWL["roll"] * math.sin(2 * math.pi * (p + .25)))


def breast(rig, p, base, clip):
    """Breaststroke at phase ``p``, upright: pull, recover the arms and legs together, kick, glide."""
    rig.apply(base["rest"])
    place_pelvis(rig, base["hips"], 0.0)
    style = BREAST[clip]
    pull, glide = style["pull"], style["glide"]
    recover = pull + .14
    kick_end = 1 - glide
    for side in ARMS:
        s = SIDE[side]
        if p < pull:
            u = p / pull
            out = math.sin(math.pi * min(1.0, u * 1.4) / 2) if u < .7 else 1.0
            if style["deep"]:
                # Full sweep: hands from overhead out and down to the hips.
                theta = math.pi * .95 * smooth(u)
                upper = vec(s * math.sin(theta) * .9, -.25 * math.sin(theta), math.cos(theta))
                fore = (upper + FWD * .5 * math.sin(math.pi * u)).normalized()
            else:
                # Outsweep then insweep: elbows high, hands sweep out and in under the chest.
                spread = .6 * out * (1 - smooth((u - .55) / .45))
                drop = smooth((u - .3) / .7)
                upper = vec(s * (.12 + spread + .5 * drop), -.6 * drop, 1 - 1.3 * drop)
                fore = (upper * (1 - drop) + vec(-s * .4, -1, .9) * drop + FWD * .2).normalized()
            twist = 40 * math.sin(math.pi * u)
        elif p < recover:
            # Hands shoot forward (overhead) together.
            u = smooth((p - pull) / (recover - pull))
            if style["deep"]:
                start_upper, start_fore = vec(s * .9, -.25, -.4), vec(s * .9, -.25, -.4)
            else:
                start_upper, start_fore = vec(s * .62, -.6, -.3), vec(-s * .4, -1, .9)
            upper = start_upper.lerp(vec(s * .1, -.05, 1), u).normalized()
            fore = start_fore.lerp(vec(s * .06, -.05, 1), u).normalized()
            twist = 0.0
        else:
            upper, fore, twist = vec(s * .1, -.05, 1), vec(s * .06, -.05, 1), 0.0
        arm(rig, side, upper, fore, twist)
    # Legs: straight through the pull, heels drawn up as the arms recover, whip kick out and together, then glide.
    draw_start = pull - .08
    if p < draw_start:
        pitch, knee, splay = 0.0, 4.0, 2.0
    elif p < recover:
        u = smooth((p - draw_start) / (recover - draw_start))
        pitch, knee, splay = 38 * u, 4 + 106 * u, 2 + 14 * u
    elif p < kick_end:
        u = smooth((p - recover) / (kick_end - recover))
        pitch, knee, splay = 38 * (1 - u), 110 * (1 - u) + 4 * u, 16 + 18 * math.sin(math.pi * u)
    else:
        pitch, knee, splay = 0.0, 4.0, 2.0
    for side in LEGS:
        leg_angles(rig, side, pitch, knee, splay, point=1.0 if (p < draw_start or p >= kick_end) else .2)
    # The head lifts (back, towards the surface) during the pull.
    rotate_world(rig, "neck_01", Vector((1, 0, 0)), -14 * window(p, pull * .5, pull) * (1 - window(p, recover, recover + .1)))


def capture_loop(rig, author, period):
    frames = int(round(period * FPS))
    poses = []
    for k in range(frames + 1):
        author((k % frames) / frames)
        poses.append(rig.capture())
    return poses


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    clip = arguments["clip"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=inputs["target"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
    target_objects = [o for o in bpy.context.scene.objects if o not in before]
    rigs = [o for o in target_objects if o.type == "ARMATURE"]
    if len(rigs) != 1:
        raise ValueError("the target GLB must have one armature")
    poses, observations = author(Rig(rigs[0]), clip)
    write_action(rigs[0], clip, poses)
    bpy.ops.object.select_all(action="DESELECT")
    for item in target_objects:
        if item.name in bpy.data.objects:
            item.select_set(True)
    bpy.context.view_layer.objects.active = rigs[0]
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=False, export_tangents=False, export_materials="NONE",
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=False, export_optimize_animation_keep_anim_armature=True,
        export_skins=True, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "swim-clip-v1", "clip": clip, "fps": FPS, "frames": len(poses), **observations}


def author(rig, clip):
    """The clip's poses (one per frame at FPS; loops repeat the first pose last) and its observations."""
    stand_action = bpy.data.actions.get(STAND)
    if stand_action is None:
        raise ValueError(f"the target GLB has no {STAND} clip")
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    import_fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    rest_pose = {name: Matrix.Identity(4) for name in rig.rest}
    rig.apply(rest_pose)
    base = {"rest": rest_pose, "hips": rig.head("pelvis"), "ankle": {side: rig.head(LEGS[side][2]) for side in LEGS}}
    stand = sample(rig, stand_action, stand_action.frame_range[0])
    if clip == "Wade_Fwd_Loop":
        poses = capture_loop(rig, lambda p: wade(rig, p, base), WADE["period"])
        observations = {"periodSeconds": WADE["period"], "referenceSpeedMetersPerSecond": WADE["speed"]}
    elif clip == "Swim_Idle_Loop":
        poses = capture_loop(rig, lambda p: tread(rig, p, base), TREAD["period"])
        observations = {"periodSeconds": TREAD["period"]}
    elif clip == "Swim_Fwd_Loop":
        poses = capture_loop(rig, lambda p: crawl(rig, p, base), CRAWL["period"])
        observations = {"stroke": "front-crawl", "periodSeconds": CRAWL["period"], "strokeSpeedMetersPerSecond": CRAWL["speed"]}
    elif clip in BREAST:
        poses = capture_loop(rig, lambda p: breast(rig, p, base, clip), BREAST[clip]["period"])
        observations = {"stroke": "breaststroke", "periodSeconds": BREAST[clip]["period"]}
    else:
        tread(rig, 0.0, base)
        treading = rig.capture()
        duration = TRANSITION[clip]
        frames = int(round(duration * FPS))
        # A middle key: arms lifted to the surface and the legs half drawn (entry), or one leg reaching down (exit).
        rig.apply(blend(stand, treading, .5))
        for side in ARMS:
            s = SIDE[side]
            if clip == "Swim_Enter":
                arm(rig, side, vec(s, -.2, .15), vec(s * .7, -.6, .25), twist=-20)
            else:
                arm(rig, side, vec(s * .8, -.3, -.5), vec(s * .5, -.6, -.6), twist=-30)
        if clip == "Swim_Exit":
            leg_angles(rig, "r", 10, 15, splay=4, point=.2)
        middle = rig.capture()
        start, end = (stand, treading) if clip == "Swim_Enter" else (treading, stand)
        poses = []
        for k in range(frames + 1):
            u = k / frames
            poses.append(blend(start, middle, smooth(u / .45)) if u < .45 else blend(middle, end, smooth((u - .45) / .55)))
        observations = {"durationSeconds": duration, "from": "stand" if clip == "Swim_Enter" else "Swim_Idle_Loop",
                        "to": "Swim_Idle_Loop" if clip == "Swim_Enter" else "stand"}
    return poses, observations


def write_action(rig_object, clip, poses):
    data = rig_object.animation_data or rig_object.animation_data_create()
    data.action = None
    for other in list(bpy.data.actions):
        bpy.data.actions.remove(other)
    action = bpy.data.actions.new(clip)
    data.action = action
    bpy.context.scene.render.fps, bpy.context.scene.render.fps_base = FPS, 1
    for frame, pose in enumerate(poses):
        for name, basis in pose.items():
            pb = rig_object.pose.bones[name]
            pb.matrix_basis = basis
            pb.keyframe_insert("location", frame=frame)
            pb.keyframe_insert("rotation_quaternion", frame=frame)
    for curve in action_curves(action):
        for key in curve.keyframe_points:
            key.interpolation = "LINEAR"
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = 0, len(poses) - 1
