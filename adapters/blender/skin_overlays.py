"""Painted skin variants for the male head (#380): aged and weathered textures per skin tone, and a stubble mask.

The head's base-colour texture is painted in its own UV layout: every texel the head covers gets its rest-pose
position (the head triangles are rasterised in UV space), and the marks are painted as functions of that position,
placed on the face landmarks of ``face_variants.landmarks``. So the strokes land on the face wherever the UV islands are,
and the same painting fits any head that shares the landmarks.

- ``aged``: forehead lines, a frown line between the brows, crow's feet, lines under the eyes, deep nose-to-mouth folds,
  lines from the mouth corners, neck lines, a few age spots and a slightly paler, less saturated skin.
- ``weathered``: a sun-darkened, ruddier face (cheeks, nose, forehead), deep squint lines at the eyes, two deep forehead
  lines, blotchy uneven tone and a pale scar across the left cheek.
- ``stubble``: a speckled mask over the beard area (jaw, chin, upper lip, cheeks below the beard line); a consumer
  darkens the skin under it with the hair tint. It replaces the stubble shell.

Each tone of ``SKIN_TONES`` gets ``skin.<tone>.aged.png`` and ``skin.<tone>.weathered.png``: the light base texture times
the tone, with the painting on top. No randomness beyond a fixed seed.
"""
import math
import os

import bpy
import numpy

SEED = 380


def positions(obj, size):
    """(size, size, 3) rest positions per texel of obj's UV layout and a (size, size) coverage mask."""
    mesh = obj.data
    mesh.calc_loop_triangles()
    uv = mesh.uv_layers.active.data
    m = obj.matrix_world
    world = numpy.array([tuple(m @ v.co) for v in mesh.vertices])
    pos = numpy.zeros((size, size, 3))
    mask = numpy.zeros((size, size), bool)
    for tri in mesh.loop_triangles:
        t = numpy.array([tuple(uv[i].uv) for i in tri.loops]) * size
        p = world[list(tri.vertices)]
        x0, y0 = numpy.floor(t.min(0)).astype(int)
        x1, y1 = numpy.ceil(t.max(0)).astype(int)
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, size - 1), min(y1, size - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = numpy.meshgrid(numpy.arange(x0, x1 + 1) + .5, numpy.arange(y0, y1 + 1) + .5)
        (ax, ay), (bx, by), (cx, cy) = t
        det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(det) < 1e-12:
            continue
        w0 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / det
        w1 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / det
        w2 = 1 - w0 - w1
        # A one-texel margin keeps the seams painted.
        inside = (w0 >= -.02) & (w1 >= -.02) & (w2 >= -.02)
        if not inside.any():
            continue
        q = w0[..., None] * p[0] + w1[..., None] * p[1] + w2[..., None] * p[2]
        ys_i, xs_i = (ys[inside] - .5).astype(int), (xs[inside] - .5).astype(int)
        pos[ys_i, xs_i] = q[inside]
        mask[ys_i, xs_i] = True
    return pos, mask


def line(d, width):
    return numpy.exp(-(d / width) ** 2)


def segment_distance(px, pz, a, b):
    ax, az = a
    bx, bz = b
    vx, vz = bx - ax, bz - az
    t = numpy.clip(((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz), 0, 1)
    return numpy.hypot(px - (ax + t * vx), pz - (az + t * vz)), t


def polyline(px, pz, points, width, taper=True):
    out = numpy.zeros_like(px)
    n = len(points) - 1
    for k, (a, b) in enumerate(zip(points, points[1:])):
        d, t = segment_distance(px, pz, a, b)
        along = (k + t) / n
        strength = numpy.sin(numpy.pi * numpy.clip(along, 0, 1)) ** .6 if taper else 1
        out = numpy.maximum(out, line(d, width) * strength)
    return out


def smoothstep(e0, e1, x):
    t = numpy.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def noise(p, scale, seed):
    """Smooth value-free noise from a few seeded sine waves (-1..1)."""
    rng = numpy.random.default_rng(seed)
    out = numpy.zeros(p.shape[:2])
    for _ in range(6):
        k = rng.normal(size=3)
        k = k / numpy.linalg.norm(k) * scale * rng.uniform(.6, 1.4)
        out += numpy.sin(p @ k + rng.uniform(0, 2 * math.pi))
    return out / 6 * 1.6


def paint(pos, mask, lm):
    """The darkening (0..1) and colour layers of every painting, as arrays over the texture."""
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    ax = numpy.abs(x)
    eye = lm["eyes"][0]
    brow = eye.z + .022
    tip, mouth, chin = lm["tip"], lm["mouth"], lm["chin"]
    front = smoothstep(-.02, -.05, y) * mask
    out = {}

    forehead = numpy.zeros_like(x)
    for k, h in enumerate((.017, .03, .043)):
        zl = brow + h + .55 * x * x + .0015 * numpy.sin(x * 95 + k)
        forehead = numpy.maximum(forehead, line(z - zl, .0015) * (1 - smoothstep(.035, .058, ax)) * (.7 + .3 * (k == 1)))
    frown = sum(polyline(x, z, [(s * .006, brow - .006), (s * .007, brow + .012)], .0008) for s in (1, -1))
    crows = numpy.zeros_like(x)
    for s in (1, -1):
        corner = (s * (abs(eye.x) + .021), eye.z + .001)
        for angle in (-28, -8, 12, 30):
            a = math.radians(angle)
            end = (corner[0] + s * .011 * math.cos(a), corner[1] + .011 * math.sin(a))
            start = (corner[0] + s * .003 * math.cos(a), corner[1] + .003 * math.sin(a))
            crows = numpy.maximum(crows, polyline(x, z, [start, end], .0011))
    crows *= smoothstep(.04, .055, ax) * mask
    under = numpy.zeros_like(x)
    for s in (1, -1):
        r = numpy.hypot(x - s * abs(eye.x), z - (eye.z + .004))
        under = numpy.maximum(under, line(r - .0215, .0012) * smoothstep(eye.z - .006, eye.z - .014, z) * (numpy.abs(x - s * abs(eye.x)) < .02))
    under *= front
    folds = numpy.zeros_like(x)
    marionette = numpy.zeros_like(x)
    for s in (1, -1):
        folds = numpy.maximum(folds, polyline(x, z, [(s * .019, tip.z - .006), (s * .029, mouth.z + .012), (s * .034, mouth.z - .004)], .0017))
        marionette = numpy.maximum(marionette, polyline(x, z, [(s * .027, mouth.z - .002), (s * .029, mouth.z - .022)], .0012))
    folds *= front
    marionette *= front
    neck = sum(line(z - h - .3 * x * x, .0013) for h in (chin.z - .04, chin.z - .056)) * smoothstep(.01, -.03, y - chin.y - .04) * mask
    rng = numpy.random.default_rng(SEED)
    spots = numpy.zeros_like(x)
    for _ in range(16):
        c = numpy.array([rng.uniform(-.06, .06), rng.uniform(-.09, -.05), rng.uniform(1.64, 1.79)])
        spots = numpy.maximum(spots, line(numpy.linalg.norm(pos - c, axis=-1), rng.uniform(.0018, .0035)) * rng.uniform(.4, 1))
    spots *= mask * (y < 0)
    out["aged"] = {"lines": numpy.clip(.8 * forehead + .8 * frown + .9 * crows + .7 * under + 1.0 * folds + .7 * marionette + .6 * neck, 0, 1) * mask,
                   "spots": spots}

    squint = numpy.zeros_like(x)
    for s in (1, -1):
        corner = (s * (abs(eye.x) + .02), eye.z)
        for angle in (-22, -6, 10, 26):
            a = math.radians(angle)
            squint = numpy.maximum(squint, polyline(x, z, [(corner[0] + s * .002 * math.cos(a), corner[1] + .002 * math.sin(a)),
                                                           (corner[0] + s * .014 * math.cos(a), corner[1] + .014 * math.sin(a))], .0013))
    squint *= smoothstep(.04, .055, ax) * mask
    deep = numpy.zeros_like(x)
    for k, h in enumerate((.022, .038)):
        zl = brow + h + .5 * x * x + .002 * numpy.sin(x * 70 + 2 * k)
        deep = numpy.maximum(deep, line(z - zl, .0014) * (1 - smoothstep(.03, .055, ax)))
    sun = front * smoothstep(1.56, 1.6, z)
    cheeks = sum(numpy.exp(-(((x - s * .045) / .02) ** 2 + ((z - (tip.z - .004)) / .016) ** 2)) for s in (1, -1))
    nose = numpy.exp(-((x / .013) ** 2 + ((z - tip.z - .006) / .02) ** 2)) * front
    blotch = noise(pos, 110, SEED + 1) * mask
    scar = polyline(x, z, [(.052, eye.z - .012), (.04, tip.z - .006), (.033, mouth.z + .004)], .0011, taper=True) * front
    out["weathered"] = {"lines": numpy.clip(.9 * deep + 1.0 * squint + .9 * frown + .7 * folds + .4 * under + .4 * crows, 0, 1) * mask,
                        "sun": sun, "ruddy": numpy.clip((cheeks * front) * .9 + nose, 0, 1), "blotch": blotch, "scar": scar}

    # Stubble: the beard area round the head's vertical axis (as the beards), and the upper lip, without the lips.
    theta = numpy.degrees(numpy.arctan2(x, -(y - .005)))
    k = numpy.clip(numpy.abs(theta) / 95, 0, 1)
    top = 1.606 + .1 * k ** 1.25
    area = smoothstep(top + .004, top - .004, z) * smoothstep(1.53, 1.56, z) * (numpy.abs(theta) < 97)
    lip = smoothstep(.033, .024, ax) * smoothstep(mouth.z + .003, mouth.z + .007, z) * smoothstep(tip.z - .007, tip.z - .013, z) * (y < -.04)
    area = numpy.maximum(area, lip)
    lips = numpy.exp(-((x / .026) ** 2 + ((z - mouth.z) / .0075) ** 2))
    area = area * (1 - smoothstep(.4, .7, lips)) * mask
    speckle = numpy.random.default_rng(SEED + 2).uniform(0, 1, x.shape)
    out["stubble"] = area * (.55 + .45 * speckle)
    return out


def luminance(c):
    return c[..., 0] * .2126 + c[..., 1] * .7152 + c[..., 2] * .0722


def compose(base, layers, tone, kind):
    """base (H, W, 3, linear) times tone, with the painting of ``kind``."""
    c = base * numpy.array(tone) ** (1 / 2.2)  # the texture is sRGB; the tones are linear multipliers
    if kind == "aged":
        lum = luminance(c)[..., None]
        c = c * .85 + lum * .15
        c = c * (1 - layers["lines"][..., None] * numpy.array((.3, .37, .42)))
        c = c * (1 - layers["spots"][..., None] * numpy.array((.25, .38, .5)))
    else:
        sun = layers["sun"][..., None]
        c = c * (1 - sun * (1 - numpy.array((.86, .76, .68))))
        c = c * (1 - layers["ruddy"][..., None] * numpy.array((.0, .2, .24)))
        c = c * (1 + .045 * layers["blotch"][..., None] * sun)
        c = c * (1 - layers["lines"][..., None] * numpy.array((.33, .41, .46)))
        scar = layers["scar"][..., None]
        c = c * (1 - scar) + scar * (c * .6 + numpy.array((.3, .2, .19)) * luminance(base).mean() * 2.2)
    return numpy.clip(c, 0, 1)


def save(array, path, size):
    image = bpy.data.images.new(os.path.basename(path), size, size, alpha=True)
    rgba = numpy.ones((size, size, 4), numpy.float32)
    if array.ndim == 2:
        rgba[..., :3] = array[..., None]
    else:
        rgba[..., :3] = array
    image.pixels.foreach_set(rgba.ravel())
    image.filepath_raw, image.file_format = path, "PNG"
    image.save()
    bpy.data.images.remove(image)


def generate(head, image, lm, tones, out_dir):
    """Writes skin.<tone>.aged.png, skin.<tone>.weathered.png and stubble.png for head's base-colour image."""
    os.makedirs(out_dir, exist_ok=True)
    size = image.size[0]
    pixels = numpy.empty(size * size * 4, numpy.float32)
    image.pixels.foreach_get(pixels)
    base = pixels.reshape(size, size, 4)[..., :3].astype(numpy.float64)
    pos, mask = positions(head, size)
    painted = paint(pos, mask, lm)
    written = {}
    for tone, factor in tones.items():
        for kind in ("aged", "weathered"):
            path = os.path.join(out_dir, f"{tone}.{kind}.png")
            save(compose(base, painted[kind], factor, kind), path, size)
            written[f"{tone}.{kind}"] = path
    path = os.path.join(out_dir, "stubble.png")
    save(painted["stubble"], path, size)
    written["stubble"] = path
    return written
