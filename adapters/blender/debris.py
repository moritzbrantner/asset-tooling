"""Pre-fractured debris for breakable kit props (#319 for mmorpg#288), split in Blender with fixed planes.

The declared input ``source`` is one placed static kit asset (its footprint base centre at the origin, metres, glTF
+Y up). Its meshes are joined in the placed frame, welded at UV and normal seams, then cut by every plane in
``arguments["planes"]`` in turn (``bmesh.ops.bisect_plane``). Each cut is capped (``holes_fill``) and the cap is given the
cut face's material with a planar UV projection, so a chunk is closed wherever the source surface was. Pieces smaller
than ``minimumShare`` of the bounds volume merge into nothing (dropped). No randomness and no add-on.

A plane is ``{"point": [fx, fy, fz], "normal": [x, y, z]}``: the point as fractions of the source bounds and the normal
in the placed glTF frame. Each chunk becomes one node named ``<name>.chunk<NN>`` whose origin is the centre of its
bounds, so it stands where it was in the intact prop. The observations list every chunk with its centre, its box
half-extents (the chunk's collision proxy, axis-aligned in the placed frame) and its share of the summed box volume.
"""
import bmesh
import bpy
from mathutils import Vector


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "name", "planes", "minimumShare"}:
        raise ValueError("debris requires exactly schemaVersion, name, planes and minimumShare")
    if p["schemaVersion"] != 1 or not isinstance(p["name"], str) or not p["name"]:
        raise ValueError("debris name must be a non-empty string")
    if type(p["planes"]) is not list or not 1 <= len(p["planes"]) <= 4:
        raise ValueError("debris takes 1..4 planes")
    for plane in p["planes"]:
        if type(plane) is not dict or set(plane) != {"point", "normal"}:
            raise ValueError("a debris plane is {point, normal}")
    if set(inputs) != {"source"}:
        raise ValueError("debris takes exactly the declared input source")


def to_blender(v):
    return Vector((v[0], -v[2], v[1]))


def to_gltf(v):
    # Adding 0.0 turns -0.0 into 0.0, so the values survive a JSON round trip unchanged.
    return [round(v[0], 4) + 0.0, round(v[2], 4) + 0.0, round(-v[1], 4) + 0.0]


def bounds(points):
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return lo, hi


def cut(bm, co, no, keep_below):
    """Keep one side of ``bm`` and cap the cut; returns False when nothing is left."""
    result = bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces), dist=1e-6, plane_co=co, plane_no=no,
                                    clear_outer=keep_below, clear_inner=not keep_below)
    if not bm.faces:
        return False
    edges = [e for e in result["geom_cut"] if isinstance(e, bmesh.types.BMEdge) and e.is_valid and e.is_boundary]
    if edges:
        before = set(bm.faces)
        bmesh.ops.holes_fill(bm, edges=edges, sides=0)
        caps = [f for f in bm.faces if f not in before]
        uv = bm.loops.layers.uv.active
        t1 = no.orthogonal().normalized()
        t2 = no.cross(t1).normalized()
        for face in caps:
            # The cap takes the material of a neighbouring cut face and a planar projection (0.5 UV per metre).
            neighbours = [other for edge in face.edges for other in edge.link_faces if other is not face and other not in caps]
            if neighbours:
                face.material_index = neighbours[0].material_index
            if uv is not None:
                for loop in face.loops:
                    loop[uv].uv = (loop.vert.co.dot(t1) * .5, loop.vert.co.dot(t2) * .5)
    return True


def touching_groups(bm, gap=.025):
    """Split ``bm`` into groups of connected parts whose boxes touch (within ``gap``); a group moves as one body.

    Separate parts that do not touch, such as two fence rails cut free of their post, become separate chunks. The
    2.5 cm gap keeps open shells together, such as the floor's separate top and bottom planks 2 cm apart.
    """
    faces = set(bm.faces)
    islands = []
    while faces:
        seed = faces.pop()
        island, stack = {seed}, [seed]
        while stack:
            face = stack.pop()
            for edge in face.edges:
                for other in edge.link_faces:
                    if other in faces:
                        faces.discard(other)
                        island.add(other)
                        stack.append(other)
        islands.append(island)
    if len(islands) == 1:
        return [bm]
    boxes = [bounds([v.co for f in island for v in f.verts]) for island in islands]
    parent = list(range(len(islands)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i in range(len(islands)):
        for j in range(i + 1, len(islands)):
            (alo, ahi), (blo, bhi) = boxes[i], boxes[j]
            if all(alo[k] <= bhi[k] + gap and blo[k] <= ahi[k] + gap for k in range(3)):
                parent[find(i)] = find(j)
    groups = {}
    for i, island in enumerate(islands):
        groups.setdefault(find(i), set()).update(island)
    if len(groups) == 1:
        return [bm]
    result = []
    for members in groups.values():
        bm.faces.index_update()
        index = {f.index for f in members}
        part = bm.copy()
        part.faces.index_update()
        bmesh.ops.delete(part, geom=[f for f in part.faces if f.index not in index], context="FACES")
        result.append(part)
    bm.free()
    return result


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    name = arguments["name"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=inputs["source"])
    meshes = sorted((o for o in bpy.context.scene.objects if o.type == "MESH"), key=lambda o: o.name)
    if not meshes:
        raise ValueError("the source has no meshes")
    # Join every mesh in the placed frame.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.make_single_user(object=True, obdata=True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    for other in [o for o in bpy.context.scene.objects if o is not joined]:
        bpy.data.objects.remove(other, do_unlink=True)
    source = bmesh.new()
    source.from_mesh(joined.data)
    bmesh.ops.remove_doubles(source, verts=source.verts, dist=1e-5)
    lo, hi = bounds([v.co for v in source.verts])
    size = hi - lo
    total_volume = size.x * size.y * size.z

    pieces = [source]
    for plane in arguments["planes"]:
        f = plane["point"]
        # Fractions are along the glTF axes: x, y (up) and z (Blender -y).
        co = Vector((lo.x + f[0] * size.x, hi.y - f[2] * size.y, lo.z + f[1] * size.z))
        no = to_blender(plane["normal"]).normalized()
        next_pieces = []
        for piece in pieces:
            for keep_below in (True, False):
                half = piece.copy()
                if cut(half, co, no, keep_below):
                    next_pieces.append(half)
                else:
                    half.free()
            piece.free()
        pieces = next_pieces

    pieces = [group for piece in pieces for group in touching_groups(piece)]
    chunks = []
    kept = []
    for piece in pieces:
        plo, phi = bounds([v.co for v in piece.verts])
        share = ((phi - plo).x * (phi - plo).y * (phi - plo).z) / total_volume
        if share < arguments["minimumShare"]:
            piece.free()
            continue
        kept.append((piece, plo, phi))
    # Stable order: by centre height, then x, then depth.
    kept.sort(key=lambda item: (round(((item[1] + item[2]) / 2).z, 3), round(((item[1] + item[2]) / 2).x, 3), round(((item[1] + item[2]) / 2).y, 3)))
    box_total = sum((phi - plo).x * (phi - plo).y * (phi - plo).z for _, plo, phi in kept)
    for index, (piece, plo, phi) in enumerate(kept):
        centre = (plo + phi) / 2
        bmesh.ops.translate(piece, verts=piece.verts, vec=-centre)
        mesh = joined.data.copy()
        piece.to_mesh(mesh)
        piece.free()
        node = f"{name}.chunk{index:02d}"
        mesh.name = node
        obj = bpy.data.objects.new(node, mesh)
        obj.location = centre
        bpy.context.scene.collection.objects.link(obj)
        half = (phi - plo) / 2
        chunks.append({"node": node, "center": to_gltf(centre), "halfExtents": [round(half.x, 4) + 0.0, round(half.z, 4) + 0.0, round(half.y, 4) + 0.0],
                       "triangles": sum(len(p.vertices) - 2 for p in mesh.polygons),
                       "volumeShare": round((phi - plo).x * (phi - plo).y * (phi - plo).z / box_total, 4)})
    bpy.data.objects.remove(joined, do_unlink=True)
    if len(chunks) < 2:
        raise ValueError(f"{name}: the planes left {len(chunks)} chunk(s)")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "debris-planes-v1", "name": name, "planes": arguments["planes"], "chunks": chunks,
            "sourceBounds": {"min": to_gltf(Vector((lo.x, hi.y, lo.z))), "max": to_gltf(Vector((hi.x, lo.y, hi.z)))}}
