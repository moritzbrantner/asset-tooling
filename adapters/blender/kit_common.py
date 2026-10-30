"""Shared helpers for the scripted environment kits (crypt.py, shrine.py, outpost.py; #426).

Each kit declares this file as its Python input ``common`` and binds the helpers with
``use_common(inputs.load_source("common"))`` before building. In a live Blender session, bind them
with ``use_common(runpy.run_path("kit_common.py"))``.

No randomness: ``rnd`` hashes fixed keys with SHA-256, and the textures come from numpy's legacy
``RandomState``, which is stable across numpy versions.
"""

import hashlib

import bpy
import numpy as np
from mathutils import Vector

# The names a kit binds into its own module with use_common.
NAMES = ("rnd", "to_blender", "srgb_to_linear", "periodic_noise", "fbm", "normal_map", "make_image", "empty", "proxy")


def rnd(*keys):
    """A deterministic float in [0, 1) for the given keys."""
    digest = hashlib.sha256("/".join(str(k) for k in keys).encode("ascii")).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def to_blender(point):
    """A glTF (+Y up) point in Blender's +Z-up frame."""
    x, y, z = point
    return Vector((x, -z, y))


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def periodic_noise(size, cells, seed):
    """Smooth value noise on a torus: tiles in both directions."""
    grid = np.random.RandomState(seed).rand(cells[1], cells[0])
    def axis(n, c):
        t = np.arange(n) * c / n
        i0 = np.floor(t).astype(int)
        f = t - i0
        return i0 % c, (i0 + 1) % c, f * f * (3 - 2 * f)
    x0, x1, fx = axis(size, cells[0])
    y0, y1, fy = axis(size, cells[1])
    a = grid[np.ix_(y0, x0)] * (1 - fx) + grid[np.ix_(y0, x1)] * fx
    b = grid[np.ix_(y1, x0)] * (1 - fx) + grid[np.ix_(y1, x1)] * fx
    return a * (1 - fy)[:, None] + b * fy[:, None]


def fbm(size, base, octaves, seed, stretch=(1, 1)):
    """Tileable fractal noise in [0, 1]: ``octaves`` layers of periodic noise, each twice as fine."""
    total, weight, amp = np.zeros((size, size)), 0.0, 1.0
    for o in range(octaves):
        c = base * 2**o
        total += amp * periodic_noise(size, (int(c * stretch[0]), int(c * stretch[1])), seed + o)
        weight += amp
        amp *= 0.5
    return total / weight


def normal_map(height, strength):
    """A tangent-space normal map in [0, 1] from a top-down height image (as make_image takes it)."""
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * strength
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * strength
    n = np.stack([-dx, dy, np.ones_like(height)], -1)  # rows run top-down in the image, +v up
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def make_image(name, pixels, colour):
    """A packed PNG image from top-down RGB pixels; ``colour`` picks sRGB, otherwise Non-Color."""
    size = pixels.shape[0]
    image = bpy.data.images.get(name)
    if image is None or tuple(image.size) != (size, size):
        if image is not None:
            bpy.data.images.remove(image)
        image = bpy.data.images.new(name, size, size, alpha=False)
    image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    rgba = np.concatenate([pixels, np.ones(pixels.shape[:2] + (1,))], -1).astype(np.float32)
    image.pixels.foreach_set(rgba[::-1].ravel())  # Blender rows run bottom-up
    image.file_format = "PNG"
    image.pack()
    return image


def empty(name, collection, parent, point=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 0.15
    obj.location = to_blender(point)
    collection.objects.link(obj)
    obj.parent = parent
    return obj


def proxy(name, tag, lo, hi):
    """A collision-proxy box observation from its glTF min and max corners."""
    return {"name": name, "tag": tag, "center": [round((lo[i] + hi[i]) / 2, 6) for i in range(3)],
            "size": [round(hi[i] - lo[i], 6) for i in range(3)]}
