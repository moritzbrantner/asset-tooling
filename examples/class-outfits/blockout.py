# WIP (#379, phase 1): the class starter outfit block-out as it was built in the live Blender for the
# owner's review sheet. Run it in a Blender session that has a scene named "class-outfits"
#   exec(open("examples/class-outfits/blockout.py").read())
# It reads a built humanoid-ranger-male bundle (ROOT in blockout_helpers.py) and the .artifacts/weapons
# class weapons. Phase 2 turns the approved shapes into armour/headwear recipe kits.
import os
import random

# Run from the repository root, or set HERE to this directory before exec'ing.
exec(open(os.path.join(globals().get("HERE", "examples/class-outfits"), "blockout_helpers.py")).read())

ORDER = ["warden", "ranger", "arcanist", "necro", "rogue", "cleric", "druid"]
LABELS = {"warden": "Warden", "ranger": "Ranger", "arcanist": "Arcanist", "necro": "Necromancer",
          "rogue": "Rogue", "cleric": "Cleric", "druid": "Druid"}
# Class colours follow mmorpg's in-world looks (web/src/character-visuals.ts).
KNIGHT_PLATES = ("bascinet", "breastplate", "couter_l", "couter_r", "cuisse_l", "cuisse_r", "gauntlet_l", "gauntlet_r",
                 "greave_l", "greave_r", "pauldron_l", "pauldron_r", "sabaton_l", "sabaton_r", "spaulder_l", "spaulder_r")


def start(name, variant):
    arm, objs = character(variant, name)
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    for o in objs:
        if "Icosphere" in o.name:
            o.hide_render = o.hide_viewport = True
    return arm, objs


def robe(name, skirt, top):
    r, s = bpy.data.objects[name + ".monk.001"], bpy.data.objects[name + ".monk"]
    r.name, s.name = name + ".robe", name + ".robe-shirt"
    set_cloth(r.data.materials[0], skirt)
    set_cloth(s.data.materials[0], top)
    return r, s


def tint_hair(name, rgb):
    for o in bpy.data.collections[name].objects:
        if o.name.startswith(name + ".Hair"):
            for m in o.data.materials:
                tint_textured(m, rgb, .6)


def warden():
    C = "warden"
    arm, _ = start(C, "outfit.knight.skin.light")
    armor("armor.knight", arm, C)  # full plate, bascinet on
    tab = bpy.data.objects[C + ".knight"]
    tab.name = C + ".knight.tabard"
    set_cloth(tab.data.materials[0], "#3f5f57")
    equip(SCENES + "equipment.shield.heater/default.gltf", arm, "hand_l.shield", C)
    equip(SCENES + "equipment.sword.arming/default.gltf", arm, "hand_r.weapon", C)
    for o in bpy.data.collections[C].objects:
        if o.type == "MESH" and o.name.startswith("shield"):
            o.data.materials[0] = o.data.materials[0].copy()
            set_cloth(o.data.materials[0], "#3f5f57")
    return arm


def ranger():
    C = "ranger"
    arm, _ = start(C, "default")
    equip(SCENES + "equipment.bow.long/default.gltf", arm, "back.bow.stowed", C)
    equip(SCENES + "equipment.quiver.back/default.gltf", arm, "back.quiver", C)
    return arm


def arcanist():
    C = "arcanist"
    arm, _ = start(C, "outfit.monk.skin.light")
    _, shirt = robe(C, "#3b3d63", "#55587e")
    for b in armor("armor.monk", arm, C):
        b.data.materials[0] = mat("arcanist.sash", "#b08a3e", metal=.3, rough=.5)
    cape = mat("arcanist.mantle", "#6f6a96", rough=.8)
    solid(rig_mesh("mantle", mantle([shirt], (0, .02), (1.49, .11, .09, .1), (1.32, 1.22, .27, .16, .17), seed=7, flare=.6),
                   arm, "spine_03", cape, C))
    # high collar: the back of a flared ring standing up behind the head, lower toward the front
    bm, n, rows, grid = bmesh.new(), 24, 4, []
    for r in range(rows + 1):
        k, row = r / rows, []
        for i in range(n + 1):
            t = math.radians(-25 + 230 * i / n)
            z = 1.47 + k * .24 - (.08 * k if math.sin(t) < 0 else 0)
            row.append(bm.verts.new((math.cos(t) * (.115 + k * .07), .02 + math.sin(t) * (.12 + k * .06), z)))
        grid.append(row)
    for r in range(rows):
        for i in range(n):
            bm.faces.new([grid[r][i], grid[r][i + 1], grid[r + 1][i + 1], grid[r + 1][i]])
    solid(rig_mesh("collar", bm, arm, "spine_03", cape, C), .01)
    # book held in the left hand (shield socket: face +Z)
    w, j = socket_world("hand_l.shield")
    for name, size, offset, m in (("book", (.17, .23, .06), (0, 0, .04), mat("arcanist.book", "#5b2430", rough=.6)),
                                  ("book-pages", (.165, .215, .05), (.008, 0, .04), mat("parchment", "#d9cfae"))):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1, matrix=Matrix.Diagonal((*size, 1)))
        o = rig_mesh(name, bm, arm, j, m, C)
        o.parent = None
        o.matrix_world = w @ Matrix.Translation(offset)
        attach(o, arm, j)
    rest_piece(SCENES + "hair.long/hair-1.gltf", arm, "Head", C)
    for o in rest_piece(SCENES + "facial-hair.beards/default.gltf", arm, "Head", C, keep=["beard.short", "beard.moustache"]):
        o.data.materials[0] = mat("hair.brown", "#3a2618", rough=.9)
    tint_hair(C, (.16, .09, .05))
    return arm


def necromancer():
    C = "necro"
    rnd = random.Random(379)
    arm, _ = start(C, "outfit.monk.skin.light")
    skirt, shirt = robe(C, "#1f1a28", "#2a2333")
    for m in {m for o in bpy.data.collections[C].objects if o.type == "MESH" for m in o.data.materials
              if "Superhero" in m.name or "Regular" in m.name}:
        tint_textured(m, (.62, .66, .68), .12)  # pale grey skin
    # hood: the Ranger hood, enlarged and peaked
    src = bpy.data.objects["ranger.Male_Ranger_Head_Hood"]
    hood = bpy.data.objects.new(C + ".hood", src.data.copy())
    bpy.data.collections[C].objects.link(hood)
    for g in src.vertex_groups:
        hood.vertex_groups.new(name=g.name)
    for v, sv in zip(hood.data.vertices, src.data.vertices):
        for g in sv.groups:
            hood.vertex_groups[src.vertex_groups[g.group].name].add([v.index], g.weight, "REPLACE")
    hood.data.materials.clear()
    hood.data.materials.append(mat("necro.hood", "#1f1a28", rough=.95))
    hood.parent = arm
    hood.modifiers.new("arm", "ARMATURE").object = arm
    hc = bone_head(arm, "Head") + Vector((0, 0, .08))
    for v in hood.data.vertices:
        d = v.co - hc
        v.co = hc + Vector((d.x * 1.1, d.y * 1.12, d.z * 1.08))
        if d.z > .06 and d.y > .02:
            v.co.y += .05 * (d.z - .06) / .1
    # tattered hem below the skirt
    zmin = min(v.co.z for v in skirt.data.vertices)
    ring = [v.co.copy() for v in skirt.data.vertices if v.co.z < zmin + .02]
    c = sum(ring, Vector()) / len(ring)
    ring.sort(key=lambda p: math.atan2(p.y - c.y, p.x - c.x))
    bm = bmesh.new()
    pts = ring[::max(1, len(ring) // 28)]
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        out = (a + b) / 2 - c
        out.z = 0
        out.normalize()
        tip = (a + b) / 2 + Vector((0, 0, -rnd.uniform(.05, .13))) + out * .02
        a2, b2 = a + out * .004, b + out * .004
        bm.faces.new([bm.verts.new(a2 + Vector((0, 0, .03))), bm.verts.new(b2 + Vector((0, 0, .03))), bm.verts.new(b2),
                      bm.verts.new(tip), bm.verts.new(a2)])
    me = bpy.data.meshes.new("tatters")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat("necro.robe-tatter", "#1f1a28", rough=.95))
    tat = bpy.data.objects.new(C + ".tatters", me)
    bpy.data.collections[C].objects.link(tat)
    skin_like(tat, skirt, arm)
    for b in armor("armor.monk", arm, C):
        b.data.materials[0] = mat("necro.belt", "#2a1d14", rough=.7)
    bone = mat("bone", "#ddd5bd", rough=.6)
    mo = rig_mesh("mantle", mantle([shirt], (0, .02), (1.49, .11, .09, .1), (1.28, 1.18, .27, .16, .17), tatter=.08, seed=7, flare=.6),
                  arm, "spine_03", mat("necro.mantle", "#4b3e5e", rough=.95), C)
    solid(mo)
    bm = bmesh.new()
    for i, p in enumerate(sorted((v.co.copy() for v in mo.data.vertices), key=lambda p: -p.z)[:40]):
        if i % 2 == 0:
            d = (p - Vector((0, .02, p.z))).normalized()
            bmesh.ops.create_icosphere(bm, subdivisions=1, radius=.016, matrix=Matrix.Translation(p + d * .012))
    rig_mesh("bone-collar", bm, arm, "spine_03", bone, C)
    for sx, sd in ((1, "l"), (-1, "r")):
        sh = surface([shirt, skirt], (sx * .17, .03, 1.3), (0, 0, 1), reach=.4)
        bm = bmesh.new()
        for k, (dx, dy) in enumerate(((0, -.04), (.02, 0), (0, .04))):
            base = sh + Vector((sx * dx, dy, -.01))
            cone(bm, base, base + Vector((sx * .06, dy * .6, .13 - .02 * abs(k - 1))), .018)
        rig_mesh(f"bone-spikes_{sd}", bm, arm, f"clavicle_{sd}", bone, C)
    belt = bpy.data.objects[C + ".monk.belt"]
    zc = sum(v.co.z for v in belt.data.vertices) / len(belt.data.vertices)
    yf = min(v.co.y for v in belt.data.vertices)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=.035, matrix=Matrix.Translation((0, yf - .02, zc)) @ Matrix.Diagonal((1, .7, 1.15, 1)))
    rig_mesh("skull-clasp", bm, arm, "pelvis", bone, C)
    equip(WEAPONS + "staff.bone/weapon.glb", arm, "hand_r.staff", C)
    return arm


def rogue():
    C = "rogue"
    arm, objs = start(C, "default")
    pauldron = bpy.data.objects[C + ".Male_Ranger_Acc_Pauldron"]
    pauldron.hide_render = pauldron.hide_viewport = True  # lighter build: no shoulder plate
    for m in {m for o in objs if o.type == "MESH" for m in o.data.materials if m.name.startswith("MI_Ranger")}:
        tint_textured(m, (.32, .29, .27), .25)  # charcoal leather
    # half-mask: the head below the eyes, pushed out 7 mm
    eyes, head = bpy.data.objects[C + ".Eyes"], bpy.data.objects[C + ".SuperHero_Male"]
    ez = sum(v.co.z for v in eyes.data.vertices) / len(eyes.data.vertices)
    ey = min(v.co.y for v in eyes.data.vertices)
    me = head.data.copy()
    mask = bpy.data.objects.new(C + ".half-mask", me)
    bpy.data.collections[C].objects.link(mask)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z > ez - .035 or v.co.y > ey + .09], context="VERTS")
    for v in bm.verts:
        v.co += v.normal * .007
    bm.to_mesh(me)
    bm.free()
    me.materials.clear()
    me.materials.append(mat("rogue.mask", "#1b1a19", rough=.9))
    skin_like(mask, head, arm)
    mask.modifiers.new("solid", "SOLIDIFY").thickness = .004
    body = [bpy.data.objects[C + n] for n in (".Male_Ranger_Body", ".Male_Ranger_Body_Belt_1", ".Male_Ranger_Body_Belt_2")]
    solid(rig_mesh("sash", baldric(body, (0, .03), 1.40, 1.0, side=-1), arm, "spine_02", mat("rogue.sash", "#6b2a26"), C), .006)
    equip(WEAPONS + "dagger/weapon.glb", arm, "hand_r.weapon", C)
    equip(WEAPONS + "dagger/weapon.glb", arm, "hand_l.weapon", C)
    return arm


def cleric():
    C = "cleric"
    arm, _ = start(C, "outfit.monk.skin.light")
    robe(C, "#d6cdb8", "#e0d8c4")
    gold = mat("gold", "#d9b44a", metal=1.0, rough=.35)
    for b in armor("armor.monk", arm, C):
        b.data.materials[0] = gold
    src = bpy.data.objects["warden.knight.tabard"]
    tab = src.copy()
    tab.data = src.data.copy()
    bpy.data.collections[C].objects.link(tab)
    for col in list(tab.users_collection):
        if col.name != C:
            col.objects.unlink(tab)
    tab.name = C + ".tabard"
    tab.parent = arm
    tab.matrix_parent_inverse = tab.matrix_basis = Matrix.Identity(4)
    for m in tab.modifiers:
        if m.type == "ARMATURE":
            m.object = arm
    tab.data.materials[0] = mat("cleric.tabard", "#f4f1e8", rough=.8)
    for p in armor("armor.knight", arm, C, skip=[f"knight.{n}" for n in KNIGHT_PLATES if not n.startswith("spaulder")]):
        for i in range(len(p.data.materials)):
            p.data.materials[i] = gold
    # gold sun on the tabard's chest
    c = surface([tab], (0, .02, 1.34), (0, -1, 0)) + Vector((0, -.012, 0))
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=.055, radius2=.055, depth=.008,
                          matrix=Matrix.Translation(c) @ Matrix.Rotation(math.radians(90), 4, "X"))
    for i in range(12):
        t = 2 * math.pi * i / 12
        d, s = Vector((math.cos(t), 0, math.sin(t))), Vector((math.sin(t), 0, -math.cos(t))) * .014
        bm.faces.new([bm.verts.new(c + d * .05 + s), bm.verts.new(c + d * (.11 if i % 2 == 0 else .085)), bm.verts.new(c + d * .05 - s)])
    rig_mesh("sun", bm, arm, "spine_03", gold, C)
    # flanged mace, grip frame +Z toward the head
    bm = bmesh.new()
    cone(bm, (0, 0, -.12), (0, 0, .42), .016, .016, seg=10)
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=.05, matrix=Matrix.Translation((0, 0, .47)))
    for i in range(6):
        t = 2 * math.pi * i / 6
        bmesh.ops.create_cube(bm, size=1, matrix=Matrix.Translation((math.cos(t) * .05, math.sin(t) * .05, .47))
                              @ Matrix.Rotation(t, 4, "Z") @ Matrix.Diagonal((.05, .012, .12, 1)))
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=.022, matrix=Matrix.Translation((0, 0, -.13)))
    w, j = socket_world("hand_r.weapon")
    o = rig_mesh("mace", bm, arm, j, gold, C)
    o.parent = None
    o.matrix_world = w
    attach(o, arm, j)
    rest_piece(SCENES + "hair.simple-parted/hair-1.gltf", arm, "Head", C)
    tint_hair(C, (.30, .20, .10))
    return arm


def druid():
    C = "druid"
    rnd = random.Random(304)
    arm, _ = start(C, "outfit.monk")
    _, shirt = robe(C, "#4d5a33", "#5e6b3e")
    armor("armor.monk", arm, C)
    mo = rig_mesh("mantle", mantle([shirt], (0, .02), (1.49, .11, .09, .1), (1.30, 1.20, .28, .17, .18), tatter=.05, seed=11, flare=.6),
                  arm, "spine_03", mat("druid.bark", "#4a3a26", rough=.95), C)
    solid(mo, .012)
    vs = [v.co.copy() for v in mo.data.vertices]
    bm = bmesh.new()
    for _ in range(70):
        p = rnd.choice(vs)
        d = Vector((p.x, p.y - .02, 0)).normalized()
        side = d.cross(Vector((0, 0, 1))).normalized()
        L = rnd.uniform(.05, .08)
        tip = (Matrix.Rotation(rnd.uniform(-.6, .6), 3, d) @ Vector((0, 0, -1))).normalized()
        base = p + d * .016
        bm.faces.new([bm.verts.new(base), bm.verts.new(base + tip * L * .5 + side * L * .225 + d * .01),
                      bm.verts.new(base + tip * L + d * .015), bm.verts.new(base + tip * L * .5 - side * L * .225 + d * .01)])
    rig_mesh("leaves", bm, arm, "spine_03", mat("druid.leaf", "#55702e", rough=.8), C)
    # antler circlet: a band around the brow and two branching antlers
    hc = bone_head(arm, "Head")
    eyes, head = bpy.data.objects[C + ".Eyes"], bpy.data.objects[C + ".SuperHero_Male"]
    zc = sum(v.co.z for v in eyes.data.vertices) / len(eyes.data.vertices) + .045
    ring = []
    for i in range(24):
        t = 2 * math.pi * i / 24
        h = surface([head], Vector((0, hc.y, zc)), Vector((math.cos(t), math.sin(t), 0)), reach=.25)
        ring.append(h + Vector((math.cos(t), math.sin(t), 0)) * .012)
    bm = bmesh.new()
    for i in range(24):
        cone(bm, ring[i], ring[(i + 1) % 24], .008, .008, seg=6)
    for sx in (1, -1):
        t = math.radians(-90 + sx * 55)
        b0 = Vector((0, hc.y, zc)) + Vector((math.cos(t) * .09, math.sin(t) * .09, 0))
        b0 = ring[min(range(24), key=lambda i: (ring[i] - b0).length)]
        p1 = b0 + Vector((sx * .05, .02, .11))
        p2 = p1 + Vector((sx * .06, .04, .10))
        cone(bm, b0, p1, .012, .009)
        cone(bm, p1, p2, .009, .003)
        cone(bm, p1, p1 + Vector((0, -.04, .07)), .007, .002)
        m1 = b0 + (p1 - b0) * .5
        cone(bm, m1, m1 + Vector((sx * .06, -.02, .03)), .006, .002)
        cone(bm, p2 - (p2 - p1) * .3, p2 + Vector((-sx * .03, .03, .05)), .005, .002)
    rig_mesh("antler-circlet", bm, arm, "Head", mat("druid.antler", "#b9a888", rough=.7), C)
    rest_piece(SCENES + "hair.long/hair-1.gltf", arm, "Head", C)
    for o in rest_piece(SCENES + "facial-hair.beards/default.gltf", arm, "Head", C, keep=["beard.full", "beard.moustache"]):
        o.data.materials[0] = mat("hair.dark", "#24180f", rough=.9)
    tint_hair(C, (.14, .09, .05))
    equip(WEAPONS + "staff.gnarled/weapon.glb", arm, "hand_r.staff", C)
    return arm


def review(out_dir, suffix=""):
    """Line-up at the mmorpg game camera (12 m, 0.42 rad pitch, 50 deg vertical fov, pivot 0.6 m) and a front close-up
    sheet, lit like the armour sheets (procedural sky at 0.06 plus a 3.5 sun)."""
    import numpy
    col = collection("review")
    me = bpy.data.meshes.new("review.ground")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=40)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat("ground", "#59604f", rough=.95))
    col.objects.link(bpy.data.objects.new("review.ground", me))
    for i, c in enumerate(ORDER):
        cu = bpy.data.curves.new("review.label." + c, "FONT")
        cu.body, cu.align_x, cu.size, cu.extrude = LABELS[c], "CENTER", .26, .004
        cu.materials.append(mat("label", "#f2efe6", rough=.6))
        t = bpy.data.objects.new("review.label." + c, cu)
        t.location = (-6 + 2 * i, -.75, .003)
        col.objects.link(t)
    SC.world = bpy.data.worlds.new("class-review")
    SC.world.use_nodes = True
    nt = SC.world.node_tree
    bg = next(n for n in nt.nodes if n.type == "BACKGROUND")
    sky = nt.nodes.new("ShaderNodeTexSky")
    if hasattr(sky, "sun_disc"):
        sky.sun_disc = False
    nt.links.new(sky.outputs["Color"], bg.inputs[0])
    bg.inputs[1].default_value = .06
    sun = bpy.data.objects.new("review.sun", bpy.data.lights.new("review.sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(-30))
    col.objects.link(sun)
    cam = bpy.data.objects.new("review.game-cam", bpy.data.cameras.new("review.game-cam"))
    col.objects.link(cam)
    cam.data.sensor_fit, cam.data.angle_y = "VERTICAL", math.radians(50)
    pitch = .42
    cam.location = Vector((0, -12 * math.cos(pitch), .6 + 12 * math.sin(pitch)))
    cam.rotation_euler = (math.pi / 2 - pitch, 0, 0)
    SC.camera = cam
    SC.render.engine = "CYCLES"
    SC.cycles.samples, SC.cycles.use_denoising = 48, True
    SC.view_settings.view_transform = "Standard"
    r = SC.render
    r.resolution_x, r.resolution_y, r.filepath = 1920, 1080, os.path.join(out_dir, f"class-lineup-12m{suffix}.png")
    bpy.ops.render.render(write_still=True, scene=SC.name)
    close = bpy.data.objects.new("review.close-cam", bpy.data.cameras.new("review.close-cam"))
    col.objects.link(close)
    close.data.sensor_fit, close.data.angle_y = "VERTICAL", math.radians(30)
    SC.camera, SC.cycles.samples = close, 32
    W, H = 640, 1000
    r.resolution_x, r.resolution_y = W, H
    tiles = []
    for c in ORDER:
        target = Vector((bpy.data.objects[c + ".rig"].location.x, -.2, .98))
        d = Vector((0, -1, .16)).normalized()
        close.location = target + d * 5.3
        close.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        r.filepath = os.path.join(out_dir, "tile.png")
        bpy.ops.render.render(write_still=True, scene=SC.name)
        img = bpy.data.images.load(r.filepath)
        px = numpy.empty(W * H * 4, dtype=numpy.float32)
        img.pixels.foreach_get(px)
        bpy.data.images.remove(img)
        os.remove(r.filepath)
        tiles.append(px.reshape(H, W, 4))
    img = bpy.data.images.new("class-closeup", W * len(ORDER), H, alpha=True)
    img.pixels.foreach_set(numpy.concatenate(tiles, axis=1).ravel())
    img.filepath_raw, img.file_format = os.path.join(out_dir, f"class-front-closeup{suffix}.png"), "PNG"
    img.save()
    SC.camera = cam


def revision_1b():
    """Owner review of the first sheet (2026-10-25): long robes only, plain functional boots, and per-class fixes."""
    # Plain boots: the Ranger's tall buckled boots read as decorative; the Ranger and Rogue wear the Peasant boots.
    peasant = bpy.data.objects["necro.Male_Peasant_Feet"]
    for C in ("ranger", "rogue"):
        arm = bpy.data.objects[C + ".rig"]
        hide(bpy.data.objects[C + ".Male_Ranger_Feet_Boots"])
        boots = transplant(peasant, arm, C, "boots")
        boots.data.materials[0] = peasant.data.materials[0].copy()
        if C == "rogue":
            tint_textured(boots.data.materials[0], (.35, .32, .3), .3)

    # Ranger: a hip-length hooded cloak (the hood takes the cloak's cloth) and a forest-green class sash.
    C = "ranger"
    arm = bpy.data.objects[C + ".rig"]
    rest_mode(arm)
    body = [bpy.data.objects[C + n] for n in (".Male_Ranger_Body", ".Male_Ranger_Body_Belt_1", ".Male_Ranger_Body_Belt_2",
                                              ".Male_Ranger_Acc_Pauldron")]
    cloak = mat("ranger.cloak", "#4d4a3b", rough=.95)
    solid(rig_mesh("cloak", mantle(body, (0, .02), (1.50, .13, .10, .11), (1.0, .90, .32, .20, .23), rows=12, arc=(-40, 220),
                                   flare=.3, clearance=.025, seed=2), arm, "spine_03", cloak, C))
    bpy.data.objects[C + ".Male_Ranger_Head_Hood"].data.materials[0] = cloak
    solid(rig_mesh("sash", baldric(body[:3], (0, .03), 1.40, 1.0, side=1), arm, "spine_02", mat("ranger.sash", "#2f5a2c"), C), .006)
    for h in (C + ".back.quiver", C + ".back.bow.stowed"):
        bpy.data.objects[h].matrix_world = Matrix.Translation((0, .05, 0)) @ bpy.data.objects[h].matrix_world  # over the cloak
    pose_mode(arm, 0)

    # Rogue: an asymmetric short cape over the left shoulder and cloth-wrapped forearms instead of the bracers.
    C = "rogue"
    arm = bpy.data.objects[C + ".rig"]
    rest_mode(arm)
    hide(bpy.data.objects[C + ".Male_Ranger_Arms_Bracer"])
    body = [bpy.data.objects[C + n] for n in (".Male_Ranger_Body", ".Male_Ranger_Body_Belt_1", ".Male_Ranger_Body_Belt_2")]
    solid(rig_mesh("shoulder-cape", mantle(body, (0, .02), (1.50, .12, .10, .11), (1.22, 1.10, .27, .18, .2), rows=8, arc=(-70, 150),
                                           flare=.4, clearance=.03, tatter=.04, seed=9), arm, "spine_03", mat("rogue.cape", "#2b2826"), C))
    arms = bpy.data.objects[C + ".Male_Ranger_Arms"]
    for s in ("l", "r"):
        wrap = skinned_piece(C, f"wrap_{s}", sleeve([arms], arm, s, start=.52, end=.97, rows=9, n=12, clearance=.008), arm, arms,
                             mat("rogue.wrap", "#57504a", rough=.95), thickness=.004)
        wrap.data.materials.append(mat("rogue.wrap-dark", "#3a3430", rough=.95))
        for f in wrap.data.polygons:
            f.material_index = (f.index // 12) % 2
    pose_mode(arm, 0)

    # Long sleeves tell the robed classes apart: tattered (Necromancer), bell (Arcanist), fitted with gold cuffs
    # (Cleric), loose and frayed (Druid).
    for C, colour, kw in (("necro", "#2a2333", {"flare": .07, "tatter": .09}), ("arcanist", "#4a4d75", {"flare": .10, "end": 1.02}),
                          ("cleric", "#e0d8c4", {"flare": .03, "end": 1.0}), ("druid", "#4f4a37", {"flare": .04, "end": 1.0, "tatter": .04})):
        arm = bpy.data.objects[C + ".rig"]
        rest_mode(arm)
        arms, shirt = bpy.data.objects[C + ".Male_Peasant_Arms"], bpy.data.objects[C + ".robe-shirt"]
        for i, s in enumerate(("l", "r")):
            skinned_piece(C, f"sleeve_{s}", sleeve([arms, shirt], arm, s, seed=3 + i, **kw), arm, arms, mat(C + ".sleeve", colour, rough=.9))
            if C == "cleric":
                skinned_piece(C, f"cuff_{s}", sleeve([arms, shirt], arm, s, start=.9, end=1.0, rows=2, clearance=.02, flare=.035),
                              arm, arms, bpy.data.materials["co.gold"])
        pose_mode(arm, 0)

    # Arcanist: its own slim crystal-topped staff (equipment.staff.crystal), grip frame +Z, foot 0.8 m below the grip.
    C = "arcanist"
    arm = bpy.data.objects[C + ".rig"]
    rest_mode(arm)
    w, j = socket_world("hand_r.staff")
    bm = bmesh.new()
    cone(bm, (0, 0, -.80), (0, 0, .92), .014, .012, seg=8)
    cone(bm, (0, 0, .90), (0, 0, .96), .02, .02, seg=8)
    for k in range(3):
        d = Vector((math.cos(2 * math.pi * k / 3), math.sin(2 * math.pi * k / 3), 0))
        cone(bm, Vector((0, 0, .95)) + d * .012, Vector((0, 0, 1.06)) + d * .035, .006, .003, seg=5)
    gem = bmesh.new()
    bmesh.ops.create_cone(gem, cap_ends=True, segments=6, radius1=.035, radius2=0, depth=.11, matrix=Matrix.Translation((0, 0, 1.09)))
    bmesh.ops.create_cone(gem, cap_ends=True, segments=6, radius1=0, radius2=.035, depth=.05, matrix=Matrix.Translation((0, 0, 1.01)))
    crystal = mat("arcanist.crystal", "#8fd6ff", rough=.1)
    p = next(n for n in crystal.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    p.inputs["Emission Color"].default_value = (*srgb("#7cc8ff"), 1)
    p.inputs["Emission Strength"].default_value = 2.0
    for name, b, m in (("staff.crystal", bm, mat("arcanist.staff", "#8a8fa8", rough=.5)), ("staff.crystal-gem", gem, crystal)):
        o = rig_mesh(name, b, arm, j, m, C)
        o.parent = None
        o.matrix_world = w
        attach(o, arm, j)
    pose_mode(arm, 0)

    # Cleric: gold edging along the tabard's sides and hem, so it stands out from the ivory robe.
    C = "cleric"
    arm = bpy.data.objects[C + ".rig"]
    rest_mode(arm)
    tab = bpy.data.objects[C + ".tabard"]
    trim = tab.copy()
    trim.data = tab.data.copy()
    bpy.data.collections[C].objects.link(trim)
    trim.name = C + ".tabard-trim"
    bm = bmesh.new()
    bm.from_mesh(trim.data)
    from collections import defaultdict
    rows, cols = defaultdict(list), defaultdict(list)
    for v in bm.verts:
        rows[(v.co.y < .02, round(v.co.z / .02))].append(v.co.x)
        cols[(v.co.y < .02, round(v.co.x / .03))].append(v.co.z)

    def edge(v):
        front = v.co.y < .02
        xs = rows[(front, round(v.co.z / .02))]
        return v.co.z < 1.42 and (v.co.x < min(xs) + .022 or v.co.x > max(xs) - .022
                                  or v.co.z < min(cols[(front, round(v.co.x / .03))]) + .055)
    marked = {v for v in bm.verts if edge(v)}
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if sum(v in marked for v in f.verts) < 3], context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * .002
        d = Vector((v.co.x * .3, v.co.y - .02, 0))
        if d.length > 1e-4:
            v.co += d.normalized() * .004
    bm.to_mesh(trim.data)
    bm.free()
    trim.data.materials[0] = bpy.data.materials["co.gold"]
    trim.modifiers.new("solid", "SOLIDIFY").thickness = .004
    pose_mode(arm, 0)

    # Druid: the greens muted toward the Marshal's palette.
    set_cloth(bpy.data.objects["druid.robe"].data.materials[0], "#4b4f3a")
    set_cloth(bpy.data.objects["druid.robe-shirt"].data.materials[0], "#565a43")
    set_cloth(bpy.data.materials["co.druid.leaf"], "#53613a")


def build(out_dir=None, suffix="-v2"):
    rigs = {}
    # The Ranger first: the Necromancer borrows its hood; the Warden first among the plate users: the Cleric borrows its tabard.
    for name, fn in (("ranger", ranger), ("warden", warden), ("arcanist", arcanist), ("necro", necromancer),
                     ("rogue", rogue), ("cleric", cleric), ("druid", druid)):
        rigs[name] = fn()
        pose(rigs[name])
    revision_1b()
    for i, c in enumerate(ORDER):
        rigs[c].location.x = -6 + 2 * i
    SC.frame_set(1)
    if out_dir:
        review(out_dir, suffix)


build()
