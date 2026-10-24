# Live-Blender helpers for the #379 class outfit block-out (exec'd into the MCP namespace).
import bpy, bmesh, json, math
from mathutils import Matrix, Vector, Quaternion

ROOT = "/home/moenarch/resident-build/male/bundle/"
SCENES = ROOT + "scenes/"
WEAPONS = "/home/moenarch/asset-tooling-kit/.artifacts/weapons/"
A = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
SOCKETS = {s["id"]: s for s in json.load(open("/home/moenarch/asset-tooling-kit/assets/descriptors/humanoid.ranger.male.sockets.json"))["sockets"]}
SC = bpy.data.scenes["class-outfits"]


def srgb(hexcode):
    h = hexcode.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= .04045 else ((x + .055) / 1.055) ** 2.4 for x in c)


def mat(name, rgb, metal=0.0, rough=.85, emit=None):
    m = bpy.data.materials.get("co." + name) or bpy.data.materials.new("co." + name)
    m.use_nodes = True
    p = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    if isinstance(rgb, str):
        rgb = srgb(rgb)
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Metallic"].default_value = metal
    p.inputs["Roughness"].default_value = rough
    m.diffuse_color = (*rgb, 1)
    return m


def collection(name):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        SC.collection.children.link(c)
    bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection.children[c.name]
    return c


def gltf_rest_worlds(path):
    data = json.load(open(path))
    nodes = data["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}

    def local(n):
        if "matrix" in n:
            return Matrix([n["matrix"][i::4] for i in range(4)])
        t = Matrix.Translation(n.get("translation", (0, 0, 0)))
        x, y, z, w = n.get("rotation", (0, 0, 0, 1))
        s = n.get("scale", (1, 1, 1))
        return t @ Quaternion((w, x, y, z)).to_matrix().to_4x4() @ Matrix.Diagonal((*s, 1))

    def world(i):
        return (world(parent[i]) @ local(nodes[i])) if i in parent else local(nodes[i])
    return {n.get("name"): world(i) for i, n in enumerate(nodes)}


REST = gltf_rest_worlds(SCENES + "humanoid.ranger.male/default.gltf")


def import_into(path, cname):
    collection(cname)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path, guess_original_bind_pose=False)
    return [o for o in bpy.data.objects if o not in before]


def character(variant, cname):
    objs = import_into(SCENES + f"humanoid.ranger.male/{variant}.gltf", cname)
    arm = next(o for o in objs if o.type == "ARMATURE")
    arm.name = cname + ".rig"
    for o in objs:
        if o.type == "MESH":
            o.name = cname + "." + o.name.split(".")[0]
    return arm, objs


def attach(obj, arm, bone):
    """Bone-parent ``obj`` keeping its rest-pose world placement (armature must be in rest at the origin)."""
    w = obj.matrix_world.copy()
    obj.parent = arm
    obj.parent_type = "BONE"
    obj.parent_bone = bone
    bpy.context.view_layer.update()
    obj.matrix_world = w


def socket_world(socket_id):
    s = SOCKETS[socket_id]
    x, y, z, w = s["rotation"]
    trs = Matrix.Translation(s["translation"]) @ Quaternion((w, x, y, z)).to_matrix().to_4x4()
    return A @ REST[s["joint"]] @ trs @ A.inverted(), s["joint"]


def equip(path, arm, socket_id, cname):
    objs = import_into(path, cname)
    roots = [o for o in objs if o.parent is None]
    holder = bpy.data.objects.new(f"{cname}.{socket_id}", None)
    bpy.data.collections[cname].objects.link(holder)
    for o in roots:
        o.parent = holder
    world, joint = socket_world(socket_id)
    holder.matrix_world = world
    attach(holder, arm, joint)
    return holder, objs


def armor(entry, arm, cname, skip=()):
    objs = import_into(SCENES + f"{entry}/default.gltf", cname)
    sockets = {p["node"]: p["socket"] for o in OUTFITS.values() if o.get("armor") and o["armor"]["entry"] == entry for p in o["armor"]["pieces"]}
    kept = []
    for o in objs:
        node = o.name.split(".0")[0] if o.name.count(".") > 1 else o.name
        node = next((n for n in sockets if o.name.startswith(n)), None)
        if node is None or node in skip:
            bpy.data.objects.remove(o)
            continue
        attach(o, arm, SOCKETS[sockets[node]]["joint"])
        o.name = f"{cname}.{node}"
        kept.append(o)
    return kept


APPEARANCE = json.load(open(ROOT + "attachments/f0bb5d15f0d410688dfd58db43e4e15eaf2125904af9c36ba1e4bfed06870023.json"))
OUTFITS = {o["id"]: o for o in APPEARANCE["outfits"]}


def rig_mesh(name, bm, arm, bone, material, cname):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(material)
    o = bpy.data.objects.new(f"{cname}.{name}", me)
    bpy.data.collections[cname].objects.link(o)
    attach(o, arm, bone)
    return o


def skin_like(obj, source, arm):
    """Skin a new mesh to ``arm`` by copying the nearest weights from ``source`` (block-out quality)."""
    for g in source.vertex_groups:
        if g.name not in obj.vertex_groups:
            obj.vertex_groups.new(name=g.name)
    w = obj.matrix_world.copy()
    obj.parent = arm
    obj.parent_type = "OBJECT"
    obj.matrix_world = w
    dt = obj.modifiers.new("dt", "DATA_TRANSFER")
    dt.object = source
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    dt.layers_vgroup_select_src = "ALL"
    dt.layers_vgroup_select_dst = "NAME"
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier="dt")
    m = obj.modifiers.new("arm", "ARMATURE")
    m.object = arm


def bone_head(arm, bone):
    return arm.matrix_world @ arm.data.bones[bone].head_local


def tint_textured(material, factor, saturation=1.0):
    """Multiply a textured material's base colour by ``factor`` (and optionally desaturate)."""
    nt = material.node_tree
    p = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    inp = p.inputs["Base Color"]
    if not inp.links:
        inp.default_value = (*factor, 1)
        return
    src = inp.links[0].from_socket
    hs = nt.nodes.new("ShaderNodeHueSaturation")
    hs.inputs["Saturation"].default_value = saturation
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs[0].default_value = 1.0
    nt.links.new(src, hs.inputs["Color"])
    nt.links.new(hs.outputs["Color"], mix.inputs[6])
    mix.inputs[7].default_value = (*factor, 1)
    nt.links.new(mix.outputs[2], inp)


def pose(arm, clip="Idle_Loop", frame=None):
    arm.data.pose_position = "POSE"
    ad = arm.animation_data_create()
    act = bpy.data.actions.get(clip)
    ad.action = act
    if hasattr(ad, "action_slot") and act.slots:
        ad.action_slot = act.slots[0]


def surface(objs, centre, direction, reach=.6):
    """Outermost hit on ``objs`` (rest pose, identity transforms) looking from ``centre + direction*reach`` inward."""
    direction = Vector(direction).normalized()
    start = Vector(centre) + direction * reach
    best = None
    for o in objs:
        ok, loc, nrm, idx = o.ray_cast(o.matrix_world.inverted() @ start, o.matrix_world.inverted().to_3x3() @ -direction, distance=reach)
        if ok:
            loc = o.matrix_world @ loc
            if best is None or (loc - start).length < (best - start).length:
                best = loc
    return best


def ellipse_ring(bm, centre, rx, ry_front, ry_back, z, n, radius, sub=1):
    for i in range(n):
        t = 2 * math.pi * i / n
        y = math.sin(t) * (ry_back if math.sin(t) > 0 else ry_front)
        bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=radius,
                                   matrix=Matrix.Translation(Vector(centre) + Vector((math.cos(t) * rx, y, z))))


def cone(bm, base, tip, r1, r2=0.0, seg=8):
    base, tip = Vector(base), Vector(tip)
    d = tip - base
    rot = d.to_track_quat("Z", "Y").to_matrix().to_4x4()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r1, radius2=r2, depth=d.length,
                          matrix=Matrix.Translation((base + tip) / 2) @ rot)


def set_cloth(material, colour):
    """Recolour a factor-only cloth material (plain base colour, or the shirt's vertex-colour x factor Mix)."""
    rgb = srgb(colour) if isinstance(colour, str) else colour
    nt = material.node_tree
    p = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    mix = next((n for n in nt.nodes if n.type == "MIX" and n.blend_type == "MULTIPLY" and n.inputs[6].is_linked and not n.inputs[7].is_linked), None)
    if p.inputs["Base Color"].is_linked and mix is not None:
        mix.inputs[7].default_value = (*rgb, 1)
    else:
        p.inputs["Base Color"].default_value = (*rgb, 1)


def mantle(body, centre, top, bottom, n=40, rows=8, clearance=.02, tatter=0.0, flare=1.0, seed=0, collar=None):
    """A capelet around ``centre`` (x, y): rings from ``top`` (z, rx, ry_front, ry_back) down to
    ``bottom`` (z_front, z_back, rx, ry_front, ry_back), pushed clear of ``body``. Returns a bmesh."""
    import random
    rnd = random.Random(seed)
    bm = bmesh.new()
    grid = []
    cx, cy = centre
    jag = [rnd.uniform(0, 1) for _ in range(n)]
    rings = rows + (1 if collar else 0)
    for r in range(rings + 1):
        row = []
        for i in range(n):
            t = 2 * math.pi * i / n
            s, c = math.sin(t), math.cos(t)
            back = s > 0
            if collar and r == 0:
                z, rx, ryf, ryb = collar
                rr, zz = (rx, ryb if back else ryf), z
            else:
                k = (r - (1 if collar else 0)) / rows
                k2 = k ** flare
                zt, rxt, ryft, rybt = top
                zf, zb, rxb, ryfb, rybb = bottom
                zbt = zf + (zb - zf) * (s * .5 + .5)
                zz = zt + (zbt - zt) * k
                rr = (rxt + (rxb - rxt) * k2, (rybt + (rybb - rybt) * k2) if back else (ryft + (ryfb - ryft) * k2))
                if r == rings and tatter:
                    zz -= tatter * (jag[i] if i % 2 else .15)
            p = Vector((cx + c * rr[0], cy + s * rr[1], zz))
            hit = surface(body, Vector((cx, cy, zz)), Vector((c, s, 0)), reach=.32) if abs(c) < .6 else None
            if hit is not None:
                d = (hit - Vector((cx, cy, zz))).length + clearance
                cur = (p - Vector((cx, cy, zz))).length
                if d > cur:
                    p = Vector((cx, cy, zz)) + (p - Vector((cx, cy, zz))) * (d / cur)
            row.append(bm.verts.new(p))
        grid.append(row)
    for r in range(rings):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([grid[r][i], grid[r][j], grid[r + 1][j], grid[r + 1][i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def solid(obj, thickness=.008):
    m = obj.modifiers.new("solid", "SOLIDIFY")
    m.thickness = thickness
    m.offset = 1
    return obj


def rest_piece(path, arm, joint, cname, keep=None):
    """Import pieces authored in rest model space (hair, beards) and bone-parent them to ``joint``."""
    objs = import_into(path, cname)
    out = []
    rigs = [o for o in objs if o.type == "ARMATURE"]
    for o in objs:
        if o.type == "ARMATURE":
            continue
        if o.type != "MESH" or (keep and not any(o.name.startswith(k) for k in keep)):
            bpy.data.objects.remove(o)
            continue
        o.name = f"{cname}.{o.name}"
        if o.parent and o.parent.type == "ARMATURE":
            o.parent = None
        for m in list(o.modifiers):
            o.modifiers.remove(m)
        attach(o, arm, joint)
        out.append(o)
    for o in rigs:
        bpy.data.objects.remove(o)
    return out


def baldric(body, centre, z_high, z_low, width=.06, n=40, clearance=.015, side=1):
    """A diagonal band around the torso from the ``side`` shoulder (z_high) to the opposite hip (z_low)."""
    bm = bmesh.new()
    cx, cy = centre
    top, bot = [], []
    for i in range(n):
        t = 2 * math.pi * i / n
        c, s = math.cos(t), math.sin(t)
        z = (z_high + z_low) / 2 + side * c * (z_high - z_low) / 2
        hit = surface(body, Vector((cx, cy, z)), Vector((c, s, 0)), reach=.35)
        r = ((hit - Vector((cx, cy, z))).length if hit else .16) + clearance
        p = Vector((cx + c * r, cy + s * r, z))
        top.append(bm.verts.new(p + Vector((0, 0, width / 2))))
        bot.append(bm.verts.new(p - Vector((0, 0, width / 2))))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([top[i], top[j], bot[j], bot[i]])
    return bm
