// Shared deterministic 2D rasterizer for baked particle flipbooks (docs/zoo-effects.md, docs/combat-effects.md).
// Every frame is a fixed list of flat-colour circles, ellipses, lenses and round-capped lines, supersampled 4×4 per
// pixel and composited "over" in order. There is no randomness, no third-party art, no Blender and no GPU, so the
// same inputs always produce the same bytes. The renderer plays each atlas once over a particle's lifetime
// (3d-lab docs/contracts/browser-renderer.md, "Seeded bursts").
import { deflateSync } from "node:zlib";

export type Rgb = readonly [number, number, number];

/** Atlas layout: `columns × rows` square cells of `cell` px, frames row-major from the top-left. */
export type EffectFlipbookLayout = Readonly<{ cell: number; columns: number; rows: number; frameCount: number; width: number; height: number; filter: "linear" | "nearest" }>;

/** 4×4 cells of 64 px, a 256×256 power-of-two texture holding 16 frames. */
export const EFFECT_FLIPBOOK_LAYOUT: EffectFlipbookLayout = Object.freeze({ cell: 64, columns: 4, rows: 4, frameCount: 16, width: 256, height: 256, filter: "linear" as const });
const SUPERSAMPLE = 4;

/**
 * Burst motion in the shape of 3d-lab's `BurstPreset` (`./flipbook` compileBurst), every optional field written out.
 * Times are seconds of the consumer's cosmetic clock, distances metres, +Y up.
 */
export type BurstPreset = {
  count: number; lifetime: number; emitDuration: number; speed: [number, number]; direction: [number, number, number];
  spread: number; gravity: [number, number, number]; endScale: number; fadeOut: boolean;
};

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
export type Shape =
  | { type: "ellipse"; x: number; y: number; rx: number; ry: number; angle?: number; color: Rgb; alpha?: number }
  | { type: "lens"; x: number; y: number; length: number; width: number; angle: number; color: Rgb; alpha?: number }
  | { type: "line"; x0: number; y0: number; x1: number; y1: number; width: number; color: Rgb; alpha?: number };

function inside(shape: Shape, px: number, py: number): boolean {
  switch (shape.type) {
    case "ellipse": {
      if (shape.rx <= 0 || shape.ry <= 0) return false;
      const a = shape.angle ?? 0, dx = px - shape.x, dy = py - shape.y;
      const u = dx * Math.cos(a) + dy * Math.sin(a), v = -dx * Math.sin(a) + dy * Math.cos(a);
      return (u / shape.rx) ** 2 + (v / shape.ry) ** 2 <= 1;
    }
    case "lens": {
      // Intersection of two discs whose chord is the long axis: pointed tips at ±length/2, max half-width width/2.
      const dx = px - shape.x, dy = py - shape.y;
      const u = dx * Math.cos(shape.angle) + dy * Math.sin(shape.angle), v = -dx * Math.sin(shape.angle) + dy * Math.cos(shape.angle);
      const h = shape.length / 2, w = shape.width / 2;
      if (w <= 0 || h <= 0) return false;
      const r = (h * h + w * w) / (2 * w), c = r - w;
      return Math.hypot(u, v - c) <= r && Math.hypot(u, v + c) <= r;
    }
    case "line": {
      if (shape.width <= 0) return false;
      const ex = shape.x1 - shape.x0, ey = shape.y1 - shape.y0, len2 = ex * ex + ey * ey;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - shape.x0) * ex + (py - shape.y0) * ey) / len2));
      return Math.hypot(px - (shape.x0 + t * ex), py - (shape.y0 + t * ey)) <= shape.width / 2;
    }
  }
}

/** The shape grown or shrunk by `d` pixels (approximately, which is all a cel rim needs). */
export function inset(shape: Shape, d: number, color: Rgb): Shape {
  switch (shape.type) {
    case "ellipse": return { ...shape, rx: Math.max(0, shape.rx - d), ry: Math.max(0, shape.ry - d), color };
    case "lens": return { ...shape, length: Math.max(0, shape.length - 2 * d), width: Math.max(0, shape.width - 2 * d), color };
    case "line": return { ...shape, width: Math.max(0, shape.width - 2 * d), color };
  }
}

/** Draw a shape with a darker rim: the rim colour at full size, then the fill `width` pixels inside it. */
export function rimmed(shape: Shape, rim: Rgb, width = 1.5): Shape[] {
  return [{ ...shape, color: rim }, inset(shape, width, shape.color)];
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const smoothstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const easeOut = (t: number) => 1 - (1 - t) ** 2;

// --- raster -------------------------------------------------------------------------------------------------------

/** The normalized time a frame represents: the middle of its interval, the same rule the renderer samples by. */
export const frameTime = (frame: number, layout: EffectFlipbookLayout = EFFECT_FLIPBOOK_LAYOUT) => (frame + 0.5) / layout.frameCount;

/** Rasterize one cell's shapes into straight-alpha sRGB RGBA bytes (`cell × cell × 4`, top row first). */
export function rasterizeShapes(shapes: readonly Shape[], size: number, hidden: Rgb): Uint8Array {
  const [hr, hg, hb] = hidden, out = new Uint8Array(size * size * 4), n = SUPERSAMPLE * SUPERSAMPLE;
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
    const i = (y * size + x) * 4, a8 = Math.round((a / n) * 255);
    if (a8 === 0) out.set([hr, hg, hb, 0], i);
    else out.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), a8], i);
  }
  return out;
}

/**
 * The whole atlas: `width × height × 4` straight-alpha sRGB bytes, top row first. `frame(t)` returns the shapes at
 * normalized time `t`; fully transparent texels keep `hidden` RGB so linear filtering never bleeds a dark fringe.
 */
export function rasterizeFlipbookAtlas(frame: (t: number) => Shape[], hidden: Rgb, layout: EffectFlipbookLayout = EFFECT_FLIPBOOK_LAYOUT): Uint8Array {
  const { cell, columns, width, height, frameCount } = layout;
  const pixels = new Uint8Array(width * height * 4);
  const [hr, hg, hb] = hidden;
  for (let i = 0; i < pixels.length; i += 4) pixels.set([hr, hg, hb, 0], i);
  for (let k = 0; k < frameCount; k += 1) {
    const cellPixels = rasterizeShapes(frame(frameTime(k, layout)), cell, hidden), ox = (k % columns) * cell, oy = Math.floor(k / columns) * cell;
    for (let y = 0; y < cell; y += 1) pixels.set(cellPixels.subarray(y * cell * 4, (y + 1) * cell * 4), ((oy + y) * width + ox) * 4);
  }
  return pixels;
}

/** An atlas framed on each background at 2× (nearest), with the cell borders marked, as one review image. */
export function reviewBoard(
  atlas: Uint8Array, backgrounds: readonly ((x: number, y: number) => readonly number[])[], layout: EffectFlipbookLayout = EFFECT_FLIPBOOK_LAYOUT,
): { width: number; height: number; pixels: Uint8Array } {
  const { width: w, height: h } = layout, zoom = 2, gap = 8;
  const width = backgrounds.length * (w * zoom + gap) + gap, height = h * zoom + 2 * gap;
  const pixels = new Uint8Array(width * height * 4).fill(255);
  backgrounds.forEach((bg, panel) => {
    const ox = gap + panel * (w * zoom + gap);
    for (let y = 0; y < h * zoom; y += 1) for (let x = 0; x < w * zoom; x += 1) {
      const s = ((y / zoom | 0) * w + (x / zoom | 0)) * 4, a = atlas[s + 3]! / 255, b = bg(x, y);
      const border = (x / zoom) % layout.cell === 0 || (y / zoom) % layout.cell === 0;
      const rgb = border ? [255, 80, 160] : [0, 1, 2].map((c) => Math.round(atlas[s + c]! * a + b[c]! * (1 - a)));
      pixels.set([...rgb, 255], ((gap + y) * width + ox + x) * 4);
    }
  });
  return { width, height, pixels };
}

/** The checkerboard every review board starts with. */
export const checkerboard = (x: number, y: number) => ((x >> 3) + (y >> 3)) % 2 ? [205, 205, 205] : [250, 250, 250];

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
