"""Versioned rock authoring recipe for the existing pinned Blender script backend.

Blender owns topology, noise, UVs, normals and glTF export. This recipe only
controls deformation and placement; it never reads undeclared resources.
"""
import hashlib
import math

import bpy
from mathutils import Vector, noise


def parameters(value):
    keys = {"schemaVersion", "seed", "width", "height", "depth", "subdivisions",
            "angularity", "flattening", "irregularity", "noiseScale"}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("rock arguments must contain exactly the versioned controls")
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        raise ValueError("rock schemaVersion must be 1")
    seed = value["seed"]
    if not isinstance(seed, str) or not seed.isascii() or not seed.isdecimal() or (len(seed) > 1 and seed[0] == "0"):
        raise ValueError("rock seed must be a canonical decimal integer string")
    for key, bounds in {
        "width": (0.001, 1000), "height": (0.001, 1000), "depth": (0.001, 1000),
        "angularity": (0, 1), "flattening": (0, 1), "irregularity": (0, 0.35),
        "noiseScale": (0.1, 16), "subdivisions": (1, 5),
    }.items():
        item = value[key]
        if type(item) not in (int, float) or not math.isfinite(item) or not bounds[0] <= item <= bounds[1]:
            raise ValueError(f"{key} must be finite in {bounds[0]}..{bounds[1]}")
    if type(value["subdivisions"]) is not int:
        raise ValueError("subdivisions must be an integer")
    return value


def signed_power(value, exponent):
    return math.copysign(abs(value) ** exponent, value)


def generate(output_path, arguments, inputs):
    p = parameters(arguments)
    if inputs:
        raise ValueError("rock geometry recipe does not accept extra resources")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=p["subdivisions"], radius=1, calc_uvs=True)
    rock = bpy.context.object
    rock.name = "rock"
    rock.data.name = "rock-geometry"
    digest = hashlib.sha256(p["seed"].encode("ascii")).digest()
    offset = Vector(tuple(int.from_bytes(digest[i:i+4], "big") / (2**32) * 1000 for i in (0, 4, 8)))
    exponent = 1 - 0.65 * p["angularity"]
    for vertex in rock.data.vertices:
        unit = vertex.co.copy()
        # Evaluate authoritative continuous noise before shaping the unit sphere.
        perturbation = max(-1, min(1, noise.noise(unit * p["noiseScale"] + offset, noise_basis="PERLIN_ORIGINAL")))
        radius = 1 + p["irregularity"] * perturbation
        vertex.co = Vector(tuple(signed_power(component, exponent) for component in unit)) * radius
        if vertex.co.z < 0:
            vertex.co.z = signed_power(vertex.co.z, 1 - 0.75 * p["flattening"])
    minimum = [min(v.co[c] for v in rock.data.vertices) for c in range(3)]
    maximum = [max(v.co[c] for v in rock.data.vertices) for c in range(3)]
    # Blender uses Z up; the glTF exporter maps it to right-handed Y up.
    sizes = (p["width"], p["depth"], p["height"])
    for vertex in rock.data.vertices:
        vertex.co = Vector(tuple(
            (vertex.co[c] - minimum[c]) * sizes[c] / (maximum[c] - minimum[c])
            - (sizes[c] / 2 if c < 2 else 0)
            for c in range(3)))
    for face in rock.data.polygons:
        face.use_smooth = p["angularity"] < 0.5
    rock.data.update()
    material = bpy.data.materials.new("rock-surface")
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (0.25, 0.27, 0.29, 1)
    shader.inputs["Roughness"].default_value = 0.85
    rock.data.materials.append(material)
    if any(not math.isfinite(component) for vertex in rock.data.vertices for component in vertex.co):
        raise ValueError("rock deformation produced nonfinite positions")
    if any(face.area <= 0 for face in rock.data.polygons):
        raise ValueError("rock deformation produced degenerate triangles")
    triangles = len(rock.data.polygons)
    if triangles != 20 * 4 ** (p["subdivisions"] - 1):
        raise ValueError("authoritative primitive topology differs from the declared budget")
    geometry_bytes = b"".join(
        float(component).hex().encode("ascii") + b"\n"
        for vertex in rock.data.vertices for component in vertex.co)
    geometry_bytes += b"".join(
        (",".join(str(index) for index in face.vertices) + "\n").encode("ascii")
        for face in rock.data.polygons)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=True, export_normals=True,
        export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False)
    return {
        "recipe": "rock-v1", "parameters": p,
        "unit": "meter", "axes": "right-handed-y-up", "origin": "ground-contact-bounds-center",
        "sourceVertexCount": len(rock.data.vertices), "triangleCount": triangles,
        "topology": "closed-oriented-triangle-sphere-with-export-attribute-seams",
        "geometrySha256": hashlib.sha256(geometry_bytes).hexdigest(),
        "dimensions": {"width": p["width"], "height": p["height"], "depth": p["depth"]},
        "materialSlot": "rock-surface", "uv": "blender-icosphere-generated",
    }
