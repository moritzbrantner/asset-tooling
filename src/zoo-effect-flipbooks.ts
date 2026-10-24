// Toy-style baked particle flipbooks for Zoo's keeper dust, leaf and splash bursts (#136 slice 1, docs/zoo-effects.md).
// A deterministic 2D rasterizer: every frame is a fixed list of flat-colour circles, ellipses and lenses, each drawn
// with a darker rim, supersampled 4×4 per pixel and composited "over" in order. There is no randomness, no
// third-party art, no Blender and no GPU, so the same inputs always produce the same bytes. The renderer plays each
// atlas once over a particle's lifetime (3d-lab docs/contracts/browser-renderer.md, "Seeded bursts").
import { deflateSync } from "node:zlib";

export type Rgb = readonly [number, number, number];
export type ZooEffectKind = "dust" | "leaf" | "splash";
export const ZOO_EFFECT_KINDS: readonly ZooEffectKind[] = ["dust", "leaf", "splash"];

/** Atlas layout: 4×4 cells of 64 px, a 256×256 power-of-two texture, frames row-major from the top-left. */
export const ZOO_EFFECT_LAYOUT = Object.freeze({ cell: 64, columns: 4, rows: 4, frameCount: 16, width: 256, height: 256, filter: "linear" as const });
const SUPERSAMPLE = 4;

/** Palette after Zoo's park-scene.ts and the zoo-scenery leaf colours (sRGB bytes). */
export const ZOO_EFFECT_PALETTE = Object.freeze({
  dust: { rim: [194, 169, 121] as Rgb, fill: [220, 197, 154] as Rgb, light: [241, 232, 204] as Rgb },
  leaf: { rim: [52, 110, 44] as Rgb, fill: [84, 158, 69] as Rgb, back: [127, 187, 90] as Rgb, vein: [61, 122, 51] as Rgb },
  splash: { rim: [63, 143, 176] as Rgb, fill: [95, 179, 209] as Rgb, light: [168, 220, 239] as Rgb, shine: [255, 255, 255] as Rgb },
});

/**
 * Burst motion in the shape of 3d-lab's `BurstPreset` (`./flipbook` compileBurst). Times are seconds of the consumer's
 * cosmetic clock, distances metres (one Zoo tile is 1 m), +Y up.
 */
export type BurstPreset = {
  count: number; lifetime: number; emitDuration: number; speed: [number, number]; direction: [number, number, number];
  spread: number; gravity: [number, number, number]; endScale: number; fadeOut: boolean;
};
export type ZooEffectRecipe = { kind: ZooEffectKind; description: string; scale: number; presets: { standard: BurstPreset; subtle: BurstPreset } };

const UP: [number, number, number] = [0, 1, 0];
export const ZOO_EFFECT_RECIPES: Readonly<Record<ZooEffectKind, ZooEffectRecipe>> = Object.freeze({
  dust: {
    kind: "dust", scale: 0.35,
    description: "a cream dust puff of overlapping round blobs that swells, then thins and fades out by the last frame",
    presets: {
      standard: { count: 10, lifetime: 0.7, emitDuration: 0.15, speed: [0.25, 0.6], direction: UP, spread: 1.3, gravity: [0, -0.3, 0], endScale: 1.8, fadeOut: false },
      subtle: { count: 5, lifetime: 0.6, emitDuration: 0.1, speed: [0.2, 0.45], direction: UP, spread: 1.3, gravity: [0, -0.3, 0], endScale: 1.5, fadeOut: false },
    },
  },
  leaf: {
    kind: "leaf", scale: 0.18,
    description: "an opaque two-tone green leaf with a midrib that turns once and flips over, showing its lighter back",
    presets: {
      standard: { count: 6, lifetime: 1.2, emitDuration: 0.2, speed: [0.6, 1.1], direction: UP, spread: 0.9, gravity: [0, -1.2, 0], endScale: 1, fadeOut: true },
      subtle: { count: 3, lifetime: 1.0, emitDuration: 0.15, speed: [0.5, 0.9], direction: UP, spread: 0.8, gravity: [0, -1.2, 0], endScale: 1, fadeOut: true },
    },
  },
  splash: {
    kind: "splash", scale: 0.12,
    description: "a blue water drop that starts stretched, rounds out with a white shine, then breaks into three droplets and fades",
    presets: {
      standard: { count: 14, lifetime: 0.6, emitDuration: 0.05, speed: [1.2, 2.0], direction: UP, spread: 0.5, gravity: [0, -6, 0], endScale: 0.6, fadeOut: false },
      subtle: { count: 7, lifetime: 0.5, emitDuration: 0.05, speed: [1.0, 1.6], direction: UP, spread: 0.45, gravity: [0, -6, 0], endScale: 0.6, fadeOut: false },
    },
  },
});

/** 3d-lab's `MAX_BURST_PARTICLES`. */
export const MAX_BURST_PARTICLES = 256;

/** The bounds 3d-lab's compileBurst enforces on a preset, minus the per-trigger fields the consumer adds. */
export function burstPresetErrors(preset: BurstPreset): string[] {
  const errors: string[] = [];
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const vec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(finite);
  if (!Number.isSafeInteger(preset.count) || preset.count < 1 || preset.count > MAX_BURST_PARTICLES) errors.push(`count must be 1..${MAX_BURST_PARTICLES}`);
  if (!finite(preset.lifetime) || preset.lifetime <= 0) errors.push("lifetime must be positive");
  if (!finite(preset.emitDuration) || preset.emitDuration < 0) errors.push("emitDuration must be non-negative");
  const [min, max] = preset.speed ?? [];
  if (!finite(min) || !finite(max) || min! < 0 || max! < min!) errors.push("speed must be [min, max] with 0 <= min <= max");
  if (!vec3(preset.direction) || Math.hypot(...preset.direction) <= 0) errors.push("direction must be a non-zero vec3");
  if (!finite(preset.spread) || preset.spread < 0 || preset.spread > Math.PI) errors.push("spread must be 0..PI");
  if (!vec3(preset.gravity)) errors.push("gravity must be a vec3");
  if (!finite(preset.endScale) || preset.endScale < 0) errors.push("endScale must be non-negative");
  if (typeof preset.fadeOut !== "boolean") errors.push("fadeOut must be a boolean");
  return errors;
}

// --- shapes ------------------------------------------------------------------------------------------------------

/** A flat-colour primitive in cell pixels (top-left origin, Y down); `alpha` multiplies its coverage. */
type Shape =
  | { type: "ellipse"; x: number; y: number; rx: number; ry: number; angle?: number; color: Rgb; alpha?: number }
  | { type: "lens"; x: number; y: number; length: number; width: number; angle: number; color: Rgb; alpha?: number }
  | { type: "line"; x0: number; y0: number; x1: number; y1: number; width: number; color: Rgb; alpha?: number };

function inside(shape: Shape, px: number, py: number): boolean {
  switch (shape.type) {
    case "ellipse": {
      const a = shape.angle ?? 0, dx = px - shape.x, dy = py - shape.y;
      const u = dx * Math.cos(a) + dy * Math.sin(a), v = -dx * Math.sin(a) + dy * Math.cos(a);
      return (u / shape.rx) ** 2 + (v / shape.ry) ** 2 <= 1;
    }
    case "lens": {
      // Intersection of two discs whose chord is the leaf's long axis: pointed tips at ±length/2, max half-width width/2.
      const dx = px - shape.x, dy = py - shape.y;
      const u = dx * Math.cos(shape.angle) + dy * Math.sin(shape.angle), v = -dx * Math.sin(shape.angle) + dy * Math.cos(shape.angle);
      const h = shape.length / 2, w = shape.width / 2;
      if (w <= 0) return false;
      const r = (h * h + w * w) / (2 * w), c = r - w;
      return Math.hypot(u, v - c) <= r && Math.hypot(u, v + c) <= r;
    }
    case "line": {
      const ex = shape.x1 - shape.x0, ey = shape.y1 - shape.y0, len2 = ex * ex + ey * ey;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - shape.x0) * ex + (py - shape.y0) * ey) / len2));
      return Math.hypot(px - (shape.x0 + t * ex), py - (shape.y0 + t * ey)) <= shape.width / 2;
    }
  }
}

/** The shape grown or shrunk by `d` pixels (approximately, which is all a cel rim needs). */
function inset(shape: Shape, d: number, color: Rgb): Shape {
  switch (shape.type) {
    case "ellipse": return { ...shape, rx: Math.max(0, shape.rx - d), ry: Math.max(0, shape.ry - d), color };
    case "lens": return { ...shape, length: Math.max(0, shape.length - 2 * d), width: Math.max(0, shape.width - 2 * d), color };
    case "line": return { ...shape, width: Math.max(0, shape.width - 2 * d), color };
  }
}

/** Draw a shape with a darker rim: the rim colour at full size, then the fill `rim` pixels inside it. */
function rimmed(shape: Shape, rim: Rgb, width = 1.5): Shape[] {
  return [{ ...shape, color: rim }, inset(shape, width, shape.color)];
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smoothstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeOut = (t: number) => 1 - (1 - t) ** 2;

// --- effects ------------------------------------------------------------------------------------------------------

/** Fixed blob layout of the dust puff (offsets and radii in cell pixels at full size). */
const DUST_BLOBS = [
  { x: 0, y: 2.5, r: 13 }, { x: -11, y: 6, r: 9.5 }, { x: 11, y: 5, r: 10 }, { x: -5, y: -7, r: 9.5 }, { x: 7, y: -6, r: 8.5 },
] as const;

function dustFrame(t: number): Shape[] {
  const { rim, fill, light } = ZOO_EFFECT_PALETTE.dust, c = ZOO_EFFECT_LAYOUT.cell / 2;
  const grow = 0.5 + 0.55 * easeOut(clamp01(t / 0.6));
  const spread = 1 + 0.5 * t;
  const alpha = 1 - smoothstep(0.45, 1, t);
  // Late in the puff the blobs thin out from the outside in, so it breaks up instead of only fading.
  const thin = smoothstep(0.5, 1, t);
  const shapes: Shape[] = [];
  DUST_BLOBS.forEach((blob, i) => {
    const r = blob.r * grow * (1 - thin * (i === 0 ? 0.35 : 0.6));
    if (r < 1) return;
    const x = c + blob.x * spread, y = c + blob.y * spread - 4 * t;
    shapes.push(...rimmed({ type: "ellipse", x, y, rx: r, ry: r * 0.92, color: fill, alpha }, rim));
    shapes.push({ type: "ellipse", x: x - r * 0.3, y: y - r * 0.35, rx: r * 0.38, ry: r * 0.3, color: light, alpha });
  });
  return shapes;
}

function leafFrame(t: number): Shape[] {
  const { rim, fill, back, vein } = ZOO_EFFECT_PALETTE.leaf, c = ZOO_EFFECT_LAYOUT.cell / 2;
  const angle = -0.6 + 2 * Math.PI * t;        // one full turn in the picture plane
  const flip = Math.cos(2 * Math.PI * t);      // one flip about the long axis: front, back, front
  const length = 44, width = 22 * Math.max(0.12, Math.abs(flip));
  const face = flip >= 0 ? fill : back;
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const stem: Shape = { type: "line", x0: c - ux * 20, y0: c - uy * 20, x1: c - ux * 26, y1: c - uy * 26, width: 3, color: vein };
  const blade: Shape = { type: "lens", x: c, y: c, length, width, angle, color: face };
  const midrib: Shape = { type: "line", x0: c - ux * 17, y0: c - uy * 17, x1: c + ux * 15, y1: c + uy * 15, width: 1.6, color: vein };
  return [stem, ...rimmed(blade, rim, 1.6), ...(width > 6 ? [midrib] : [])];
}

function dropShapes(x: number, y: number, rx: number, ry: number, alpha: number): Shape[] {
  const { rim, fill, light, shine } = ZOO_EFFECT_PALETTE.splash;
  if (rx < 0.8) return [];
  return [
    ...rimmed({ type: "ellipse", x, y, rx, ry, color: fill, alpha }, rim, Math.min(1.5, rx * 0.3)),
    { type: "ellipse", x: x + rx * 0.15, y: y + ry * 0.3, rx: rx * 0.55, ry: ry * 0.4, color: light, alpha },
    { type: "ellipse", x: x - rx * 0.35, y: y - ry * 0.4, rx: rx * 0.26, ry: ry * 0.2, color: shine, alpha },
  ];
}

function splashFrame(t: number): Shape[] {
  const c = ZOO_EFFECT_LAYOUT.cell / 2;
  if (t < 0.65) {
    // Stretched along the flight at the start, settling into a round drop.
    const stretch = 1 + 0.7 * (1 - smoothstep(0, 0.35, t));
    const r = 11;
    return dropShapes(c, c, r / Math.sqrt(stretch), r * stretch, 1);
  }
  // Breaks into three droplets that drift apart, shrink and fade.
  const k = smoothstep(0.65, 1, t), alpha = 1 - smoothstep(0.75, 1, t);
  const r = 8 * (1 - 0.55 * k);
  return [
    ...dropShapes(c, c - 2 - 8 * k, r, r, alpha),
    ...dropShapes(c - 4 - 12 * k, c + 4 + 4 * k, r * 0.7, r * 0.7, alpha),
    ...dropShapes(c + 4 + 12 * k, c + 3 + 5 * k, r * 0.65, r * 0.65, alpha),
  ];
}

const FRAMES: Record<ZooEffectKind, (t: number) => Shape[]> = { dust: dustFrame, leaf: leafFrame, splash: splashFrame };

/** The normalized time a frame represents: the middle of its interval, the same rule the renderer samples by. */
export const frameTime = (frame: number) => (frame + 0.5) / ZOO_EFFECT_LAYOUT.frameCount;

/** The fully transparent texels keep this RGB so linear filtering never bleeds a dark fringe. */
export const transparentRgb = (kind: ZooEffectKind): Rgb => ZOO_EFFECT_PALETTE[kind].rim;

/** Rasterize one cell into straight-alpha sRGB RGBA bytes (`cell × cell × 4`, top row first). */
export function rasterizeZooEffectFrame(kind: ZooEffectKind, frame: number): Uint8Array {
  if (!Number.isInteger(frame) || frame < 0 || frame >= ZOO_EFFECT_LAYOUT.frameCount) throw new Error(`frame ${frame} is outside the flipbook`);
  const size = ZOO_EFFECT_LAYOUT.cell, shapes = FRAMES[kind](frameTime(frame)), [hr, hg, hb] = transparentRgb(kind);
  const out = new Uint8Array(size * size * 4), n = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    let r = 0, g = 0, b = 0, a = 0; // premultiplied sums over subsamples
    for (let sy = 0; sy < SUPERSAMPLE; sy += 1) for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
      const px = x + (sx + 0.5) / SUPERSAMPLE, py = y + (sy + 0.5) / SUPERSAMPLE;
      let cr = 0, cg = 0, cb = 0, ca = 0;
      for (const shape of shapes) {
        if (!inside(shape, px, py)) continue;
        const sa = shape.alpha ?? 1;
        cr = shape.color[0] * sa + cr * (1 - sa); cg = shape.color[1] * sa + cg * (1 - sa); cb = shape.color[2] * sa + cb * (1 - sa);
        ca = sa + ca * (1 - sa);
      }
      r += cr; g += cg; b += cb; a += ca;
    }
    const i = (y * size + x) * 4, alpha = a / n;
    const a8 = Math.round(alpha * 255);
    if (a8 === 0) out.set([hr, hg, hb, 0], i);
    else out.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), a8], i);
  }
  return out;
}

/** The whole atlas: `width × height × 4` straight-alpha sRGB bytes, top row first. */
export function rasterizeZooEffectAtlas(kind: ZooEffectKind): Uint8Array {
  const { cell, columns, width, height, frameCount } = ZOO_EFFECT_LAYOUT;
  const pixels = new Uint8Array(width * height * 4);
  const [hr, hg, hb] = transparentRgb(kind);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([hr, hg, hb, 0], i);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const cellPixels = rasterizeZooEffectFrame(kind, frame), ox = (frame % columns) * cell, oy = Math.floor(frame / columns) * cell;
    for (let y = 0; y < cell; y += 1) pixels.set(cellPixels.subarray(y * cell * 4, (y + 1) * cell * 4), ((oy + y) * width + ox) * 4);
  }
  return pixels;
}

// --- PNG ----------------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Encode straight-alpha sRGB RGBA8 as a deterministic PNG (filter 0 rows, zlib level 9, sRGB chunk, no metadata). */
export function encodeRgbaPng(width: number, height: number, pixels: Uint8Array): Buffer {
  if (pixels.length !== width * height * 4) throw new Error("pixel buffer does not match the image size");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("sRGB", Uint8Array.of(0)), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array()),
  ]);
}
