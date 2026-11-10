"""The layered surface of the limestone rocks (docs/limestone-rocks.md#layered-surface-trial, #567).

The ``layered`` build ships the baked kit's meshes without their baked maps. Each piece instead carries the sculpt's
blend masks per vertex, and every piece shares one small library of tileable materials that the game blends.

The arguments are ``part``: a piece, whose game mesh this rebuilds exactly as ``limestone_rocks.py`` (the declared input
``rocks``) does, without the bake, and exports with the sculpt's ``Mask`` attribute as ``COLOR_0``; or ``library``, the
shared materials: limestone colour and normal, moss colour and soil colour, each graded to mmorpg's palette as the bake
source is (``cliff_outcrop.py``, the declared input ``outcrop``), on one quad per material.
"""
import runpy

import bpy
import numpy as np

RECIPE = "limestone-rock-surface-v1"
LIBRARY = "library"
LIBRARY_EDGE = 1024  # pixels per tile
# Library material: the scan, its palette entry in cliff_outcrop.py and metres per repeat.
LAYERS = {
    "limestone": ("rockColour", "rock"),
    "moss": ("mossColour", "moss"),
    "soil": ("gravelColour", "gravel"),
}
NORMAL_STRENGTH = 0.85  # as the bake source's bump node
NORMAL_DISTANCE = 0.09  # metres of relief at full height, as the bake source's bump node
PIECE_INPUTS = {"rocks", "outcrop"}
LIBRARY_INPUTS = {"outcrop", "rockColour", "rockHeight", "mossColour", "gravelColour"}


def validate(arguments, inputs, parts):
    if type(arguments) is not dict or set(arguments) != {"schemaVersion", "part"} or arguments["schemaVersion"] != 1:
        raise ValueError("limestone rock surface arguments must be {schemaVersion: 1, part}")
    if arguments["part"] != LIBRARY and arguments["part"] not in parts:
        raise ValueError(f"limestone rock surface part must be one of {', '.join(parts)} or {LIBRARY}")
    expected = LIBRARY_INPUTS if arguments["part"] == LIBRARY else PIECE_INPUTS
    if set(inputs) != expected:
        raise ValueError(f"limestone rock surface takes exactly the inputs {', '.join(sorted(expected))}")


def export(output_path, objects, colours):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False,
        export_vertex_color="NAME" if colours else "NONE", export_vertex_color_name="Mask", export_all_vertex_colors=False,
        export_image_format="AUTO", export_animations=False, export_skins=False, export_morph=False, export_cameras=False,
        export_lights=False, export_extras=False)


def tile_pixels(path, edge, colour):
    """A scan scaled to ``edge`` pixels, as an (edge, edge, 4) float array of Blender's (sRGB-encoded) pixels."""
    image = bpy.data.images.load(path, check_existing=False)
    image.colorspace_settings.is_data = not colour
    image.scale(edge, edge)
    pixels = np.empty(edge * edge * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    return image, pixels.reshape(edge, edge, 4)


def linear_to_srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)


def graded_tile(o, path, palette, edge):
    """The scan divided by its mean and multiplied by the palette colour in linear light, as the bake source does."""
    image, pixels = tile_pixels(path, edge, True)
    mean = o["srgb_to_linear"](pixels[..., :3].reshape(-1, 3)[::7].astype(float)).mean(axis=0)
    target = o["srgb_to_linear"](np.array([(palette >> 16 & 255) / 255, (palette >> 8 & 255) / 255, (palette & 255) / 255]))
    pixels[..., :3] = np.clip(linear_to_srgb(o["srgb_to_linear"](pixels[..., :3].astype(float)) * (target / mean)), 0, 1)
    pixels[..., 3] = 1
    return image, pixels


def normal_tile(path, tile, edge):
    """A tangent-space normal map from the height scan, wrapping at the edges so it tiles."""
    image, pixels = tile_pixels(path, edge, False)
    height = pixels[..., 0].astype(float) * NORMAL_DISTANCE * NORMAL_STRENGTH
    step = 2 * tile / edge
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / step
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / step  # Blender's rows run bottom-up, so +row is +v
    n = np.stack([-dx, -dy, np.ones_like(dx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    pixels[..., :3] = n * 0.5 + 0.5
    pixels[..., 3] = 1
    return image, pixels


def image_from(name, pixels, colour):
    edge = pixels.shape[0]
    image = bpy.data.images.new(name, edge, edge, alpha=False)
    image.colorspace_settings.is_data = not colour
    image.pixels.foreach_set(pixels.ravel())
    image.file_format = "PNG"
    image.pack()
    return image


def generate_library(output_path, inputs, o):
    """One quad per shared material; the build reads the textures off them."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    objects = []
    for index, (layer, (scan, palette)) in enumerate(LAYERS.items()):
        mesh = bpy.data.meshes.new(f"surface-{layer}")
        mesh.from_pydata([(index * 1.2, 0, 0), (index * 1.2 + 1, 0, 0), (index * 1.2 + 1, 1, 0), (index * 1.2, 1, 0)], [], [(0, 1, 2, 3)])
        mesh.uv_layers.new(name="UVMap")
        mesh.update()
        mat = bpy.data.materials.new(f"surface.{layer}")
        mat.use_nodes = True
        tree = mat.node_tree
        bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Roughness"].default_value = 0.95
        bsdf.inputs["Metallic"].default_value = 0.0
        colour = tree.nodes.new("ShaderNodeTexImage")
        colour.image = image_from(f"surface-{layer}-colour", graded_tile(o, inputs[scan], o["PALETTE"][palette], LIBRARY_EDGE)[1], True)
        tree.links.new(colour.outputs["Color"], bsdf.inputs["Base Color"])
        if layer == "limestone":
            normal = tree.nodes.new("ShaderNodeTexImage")
            normal.image = image_from("surface-limestone-normal", normal_tile(inputs["rockHeight"], o["TILE"]["rock"], LIBRARY_EDGE)[1], False)
            normal_map = tree.nodes.new("ShaderNodeNormalMap")
            tree.links.new(normal.outputs["Color"], normal_map.inputs["Color"])
            tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
        mesh.materials.append(mat)
        obj = bpy.data.objects.new(f"surface-{layer}", mesh)
        bpy.context.scene.collection.objects.link(obj)
        objects.append(obj)
    export(output_path, objects, False)
    return {"recipe": RECIPE, "part": LIBRARY, "edge": LIBRARY_EDGE,
            "tiles": {layer: o["TILE"][palette] for layer, (_, palette) in LAYERS.items()}}


def generate(output_path, arguments, inputs):
    o = runpy.run_path(inputs["outcrop"])
    if arguments.get("part") == LIBRARY:
        validate(arguments, inputs, ())
        return generate_library(output_path, inputs, o)
    r = runpy.run_path(inputs["rocks"])
    validate(arguments, inputs, r["CELLS"])
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    part = arguments["part"]
    cfg = r["CELLS"][part]
    collection = bpy.context.scene.collection
    name = f"limestone_{part}"
    # The same steps, in the same order, as limestone_rocks.py's generate, up to the bake it leaves out.
    if part in r["ROCKS"]:
        p, masks, rise = r["bedded_arrays"](cfg, o)
        o["collision_mesh"].__globals__.update(BURY=r["BURY"], COLLISION_FOOT=max(0.2, rise * 1.5))
        sculpted = o["grid_mesh"](f"{name}_sculpt", p, masks, collection, cfg, np.random.RandomState(cfg["seed"] + 99))
    else:
        sculpted = r["scree_mesh"](f"{name}_sculpt", cfg, collection)
    low = o["game_mesh"](sculpted, cfg["triangles"], collection)
    r["drop_splinters"](low)
    bpy.data.objects.remove(sculpted)
    low.name = low.data.name = name
    low.data.color_attributes.active_color = low.data.color_attributes["Mask"]
    export(output_path, [low], True)
    return {"recipe": RECIPE, "part": part, "vertices": len(low.data.vertices)}
