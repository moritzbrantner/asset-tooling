"""Damage states of destructible building pieces (#318 for mmorpg destructible buildings), cut in Blender.

The declared input ``source`` is one placed static kit piece (its footprint base centre at the origin, metres, glTF
+Y up). Its meshes are joined in the placed frame and welded at UV and normal seams. ``arguments["state"]`` picks the
cut:

- ``damaged``: every ``breaches`` entry removes an irregular convex lump with an exact Boolean difference. A breach is
  ``{"center": [fx, fy, fz], "radius": [x, y, z]}``: the centre as fractions of the source bounds and the radii in
  metres along the glTF axes. The lump is the convex hull of 32 points on that ellipsoid whose distance varies by a
  fixed table, so the hole is ragged but the same on every build. Faces cut into the piece take the material of the
  piece's largest surface and box-mapped UVs.
- ``destroyed``: the piece is cut by every ``planes`` entry (``{"point", "normal"}``, as in debris.py) and only the
  side opposite each normal is kept, so several tilted planes leave a jagged stub. The cuts are capped. Parts that no
  longer rest on the piece's base (within 5 % of its height), directly or through touching parts, fall away and are
  dropped.

The result is one node ``<name>.<state>`` at the origin, so it replaces the intact piece in place. The observations
give its bounds, its triangle count and, for ``damaged``, each breach's box clipped to the source bounds. No randomness
and no add-on.
"""
import math

import bmesh
import bpy
from mathutils import Vector

# Fixed radial variation of the breach points (fractions of the radius); no randomness.
JITTER = [1.0, .72, .93, .64, .86, 1.0, .7, .9, .78, .97, .66, .88, .75, 1.0, .69, .92,
          .8, .95, .63, .87, .74, .99, .71, .84, .9, .67, .96, .77, .85, .7, 1.0, .82]


def validate(p, inputs):
    if type(p) is not dict or p.get("schemaVersion") != 1 or not isinstance(p.get("name"), str) or not p["name"]:
        raise ValueError("damage requires schemaVersion 1 and a non-empty name")
    if p.get("state") == "damaged":
        if set(p) != {"schemaVersion", "name", "state", "breaches"} or type(p["breaches"]) is not list or not 1 <= len(p["breaches"]) <= 4:
            raise ValueError("damaged takes exactly schemaVersion, name, state and 1..4 breaches")
        for breach in p["breaches"]:
            if type(breach) is not dict or set(breach) != {"center", "radius"} or any(r <= 0 for r in breach["radius"]):
                raise ValueError("a breach is {center, radius} with positive radii")
    elif p.get("state") == "destroyed":
        if set(p) != {"schemaVersion", "name", "state", "planes"} or type(p["planes"]) is not list or not 1 <= len(p["planes"]) <= 4:
            raise ValueError("destroyed takes exactly schemaVersion, name, state and 1..4 planes")
        for plane in p["planes"]:
            if type(plane) is not dict or set(plane) != {"point", "normal"}:
                raise ValueError("a plane is {point, normal}")
    else:
        raise ValueError("damage state must be damaged or destroyed")
    if set(inputs) != {"source"}:
        raise ValueError("damage takes exactly the declared input source")


def to_blender(v):
    return Vector((v[0], -v[2], v[1]))


def to_gltf(v):
    # Adding 0.0 turns -0.0 into 0.0, so the values survive a JSON round trip unchanged.
    return [round(v[0], 4) + 0.0, round(v[2], 4) + 0.0, round(-v[1], 4) + 0.0]


def bounds(points):
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return lo, hi


def gltf_box(lo, hi):
    """A Blender-frame box as glTF min/max."""
    return {"min": to_gltf(Vector((lo.x, hi.y, lo.z))), "max": to_gltf(Vector((hi.x, lo.y, hi.z)))}


def fraction_point(f, lo, size):
    # Fractions are along the glTF axes: x, y (up) and z (Blender -y).
    return Vector((lo.x + f[0] * size.x, lo.y + (1 - f[2]) * size.y, lo.z + f[1] * size.z))


def box_uv(bm, faces):
    """Box-mapped UVs (0.5 per metre) on the plane across each face's dominant normal axis."""
    uv = bm.loops.layers.uv.active
    if uv is None:
        return
    for face in faces:
        n = face.normal
        axis = max(range(3), key=lambda k: abs(n[k]))
        a, b = [k for k in range(3) if k != axis]
        for loop in face.loops:
            loop[uv].uv = (loop.vert.co[a] * .5, loop.vert.co[b] * .5)


def cut(bm, co, no):
    """Keep the side of ``bm`` opposite ``no`` and cap the cut; returns False when nothing is left."""
    result = bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces), dist=1e-6, plane_co=co, plane_no=no,
                                    clear_outer=True, clear_inner=False)
    if not bm.faces:
        return False
    edges = [e for e in result["geom_cut"] if isinstance(e, bmesh.types.BMEdge) and e.is_valid and e.is_boundary]
    if edges:
        before = set(bm.faces)
        bmesh.ops.holes_fill(bm, edges=edges, sides=0)
        caps = [f for f in bm.faces if f not in before]
        for face in caps:
            neighbours = [other for edge in face.edges for other in edge.link_faces if other is not face and other not in caps]
            if neighbours:
                face.material_index = neighbours[0].material_index
        box_uv(bm, caps)
    return True


def drop_unsupported(bm, base, tolerance, gap=.025):
    """Delete connected parts that no longer rest on the base; returns how many were dropped.

    A part is supported when it reaches ``base + tolerance`` or its box touches (within ``gap``) a supported part's
    box, so a beam lying on a standing plaster panel stays and a piece left hanging in the air falls away.
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
        islands.append((island, bounds([v.co for f in island for v in f.verts])))
    supported = [lo.z <= base + tolerance for _, (lo, _) in islands]
    changed = True
    while changed:
        changed = False
        for i, (_, (alo, ahi)) in enumerate(islands):
            if supported[i]:
                continue
            for j, (_, (blo, bhi)) in enumerate(islands):
                if supported[j] and all(alo[k] <= bhi[k] + gap and blo[k] <= ahi[k] + gap for k in range(3)):
                    supported[i] = changed = True
                    break
    dropped = [island for (island, _), keep in zip(islands, supported) if not keep]
    for island in dropped:
        bmesh.ops.delete(bm, geom=list(island), context="FACES")
    return len(dropped)


def breach_cutter(center, radius, material, uv_name):
    points = []
    n = len(JITTER)
    for i in range(n):
        # Fibonacci sphere directions, each scaled by its fixed jitter.
        y = 1 - 2 * (i + .5) / n
        r = math.sqrt(1 - y * y)
        a = i * math.pi * (3 - math.sqrt(5))
        d = Vector((math.cos(a) * r, y, math.sin(a) * r)) * JITTER[i]
        points.append(center + Vector((d.x * radius.x, d.y * radius.y, d.z * radius.z)))
    bm = bmesh.new()
    for p in points:
        bm.verts.new(p)
    bmesh.ops.convex_hull(bm, input=list(bm.verts))
    mesh = bpy.data.meshes.new("breach")
    mesh.uv_layers.new(name=uv_name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    obj = bpy.data.objects.new("breach", mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def triangles(mesh):
    return sum(len(p.vertices) - 2 for p in mesh.polygons)


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    name, state = arguments["name"], arguments["state"]
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=inputs["source"])
    meshes = sorted((o for o in bpy.context.scene.objects if o.type == "MESH"), key=lambda o: o.name)
    if not meshes:
        raise ValueError("the source has no meshes")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.make_single_user(object=True, obdata=True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    piece = bpy.context.view_layer.objects.active
    for other in [o for o in bpy.context.scene.objects if o is not piece]:
        bpy.data.objects.remove(other, do_unlink=True)
    bm = bmesh.new()
    bm.from_mesh(piece.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    lo, hi = bounds([v.co for v in bm.verts])
    size = hi - lo
    source_triangles = sum(len(f.verts) - 2 for f in bm.faces)
    observations = {"recipe": f"damage-{state}-v1", "name": name, "state": state, "sourceBounds": gltf_box(lo, hi), "sourceTriangles": source_triangles}

    if state == "destroyed":
        for plane in arguments["planes"]:
            if not cut(bm, fraction_point(plane["point"], lo, size), to_blender(plane["normal"]).normalized()):
                raise ValueError(f"{name}: the destroyed planes leave nothing")
        observations["droppedParts"] = drop_unsupported(bm, lo.z, .05 * size.z)
        if not bm.faces:
            raise ValueError(f"{name}: nothing of the stub reaches the base")
        bm.to_mesh(piece.data)
        bm.free()
        observations["planes"] = arguments["planes"]
    else:
        bm.to_mesh(piece.data)
        bm.free()
        # The cut faces take the material of the piece's largest surface.
        area = {}
        for poly in piece.data.polygons:
            area[poly.material_index] = area.get(poly.material_index, 0) + poly.area
        material = piece.data.materials[max(area, key=area.get)]
        uv_name = piece.data.uv_layers.active.name if piece.data.uv_layers.active else "UVMap"
        # The cutter carries a marker material, so the faces the Booleans cut in are known afterwards.
        marker = bpy.data.materials.new("breach-marker")
        boxes = []
        for breach in arguments["breaches"]:
            center = fraction_point(breach["center"], lo, size)
            radius = Vector((breach["radius"][0], breach["radius"][2], breach["radius"][1]))
            cutter = breach_cutter(center, radius, marker, uv_name)
            clo, chi = bounds([cutter.matrix_world @ v.co for v in cutter.data.vertices])
            clo = Vector((max(clo.x, lo.x), max(clo.y, lo.y), max(clo.z, lo.z)))
            chi = Vector((min(chi.x, hi.x), min(chi.y, hi.y), min(chi.z, hi.z)))
            boxes.append(gltf_box(clo, chi))
            modifier = piece.modifiers.new("breach", "BOOLEAN")
            modifier.operation = "DIFFERENCE"
            modifier.solver = "EXACT"
            modifier.object = cutter
            modifier.use_hole_tolerant = True
            modifier.material_mode = "TRANSFER"
            bpy.context.view_layer.objects.active = piece
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            bpy.data.objects.remove(cutter, do_unlink=True)
        # The cut faces get box-mapped UVs and the largest surface's material; the marker slot is removed.
        materials = list(piece.data.materials)
        cut_bm = bmesh.new()
        cut_bm.from_mesh(piece.data)
        if marker in materials:
            marker_index, index = materials.index(marker), materials.index(material)
            faces = [f for f in cut_bm.faces if f.material_index == marker_index]
            box_uv(cut_bm, faces)
            for face in faces:
                face.material_index = index
            for face in cut_bm.faces:
                if face.material_index > marker_index:
                    face.material_index -= 1
        cut_bm.to_mesh(piece.data)
        cut_bm.free()
        if marker in materials:
            piece.data.materials.pop(index=materials.index(marker))
        observations["breaches"] = [{"center": b["center"], "radius": b["radius"], "box": box} for b, box in zip(arguments["breaches"], boxes)]
        if not piece.data.polygons:
            raise ValueError(f"{name}: the breaches leave nothing")

    piece.name = piece.data.name = f"{name}.{state}"
    plo, phi = bounds([v.co for v in piece.data.vertices])
    observations["bounds"] = gltf_box(plo, phi)
    observations["triangles"] = triangles(piece.data)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return observations
