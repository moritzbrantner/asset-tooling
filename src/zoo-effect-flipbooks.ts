// Toy-style baked particle flipbooks for Zoo's keeper dust, leaf and splash bursts (#136 slice 1, docs/zoo-effects.md).
// Each frame is a fixed list of flat-colour circles, ellipses and lenses with a darker rim, drawn by the shared
// deterministic rasterizer in effect-flipbook-raster.ts.
import {
  EFFECT_FLIPBOOK_LAYOUT, type BurstPreset, type Rgb, type Shape, clamp01, easeOut, rasterizeFlipbookAtlas, rimmed, smoothstep,
} from "./effect-flipbook-raster.ts";

export type ZooEffectKind = "dust" | "leaf" | "splash";
export const ZOO_EFFECT_KINDS: readonly ZooEffectKind[] = ["dust", "leaf", "splash"];

/** Atlas layout: 4×4 cells of 64 px, a 256×256 power-of-two texture, frames row-major from the top-left. */
export const ZOO_EFFECT_LAYOUT = EFFECT_FLIPBOOK_LAYOUT;

/** Palette after Zoo's park-scene.ts and the zoo-scenery leaf colours (sRGB bytes). */
export const ZOO_EFFECT_PALETTE = Object.freeze({
  dust: { rim: [194, 169, 121] as Rgb, fill: [220, 197, 154] as Rgb, light: [241, 232, 204] as Rgb },
  leaf: { rim: [52, 110, 44] as Rgb, fill: [84, 158, 69] as Rgb, back: [127, 187, 90] as Rgb, vein: [61, 122, 51] as Rgb },
  splash: { rim: [63, 143, 176] as Rgb, fill: [95, 179, 209] as Rgb, light: [168, 220, 239] as Rgb, shine: [255, 255, 255] as Rgb },
});

/** Presets are `BurstPreset`s in seconds and metres (one Zoo tile is 1 m), +Y up. */
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

/** The fully transparent texels keep this RGB so linear filtering never bleeds a dark fringe. */
export const transparentRgb = (kind: ZooEffectKind): Rgb => ZOO_EFFECT_PALETTE[kind].rim;

/** The whole atlas: `width × height × 4` straight-alpha sRGB bytes, top row first. */
export const rasterizeZooEffectAtlas = (kind: ZooEffectKind): Uint8Array => rasterizeFlipbookAtlas(FRAMES[kind], transparentRgb(kind), ZOO_EFFECT_LAYOUT);
