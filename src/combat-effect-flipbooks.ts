// Baked combat flipbooks for arpg's strike feedback (#362, arpg#67 67b, docs/combat-effects.md): warm hit sparks, cool
// block sparks, low impact dust and a soft weapon-trail streak. Each frame is a fixed list of flat-colour lines,
// circles and lenses drawn by the shared deterministic rasterizer in effect-flipbook-raster.ts. The effects differ by
// shape as well as hue (radial embers, a four-point glint, a flat puff, an elongated streak), and no texel is near
// white, so they stay readable under a reduced-flash palette.
import {
  EFFECT_FLIPBOOK_LAYOUT, type BurstPreset, type Rgb, type Shape, easeOut, rasterizeFlipbookAtlas, rimmed, smoothstep,
} from "./effect-flipbook-raster.ts";

export type CombatEffectKind = "spark" | "blockSpark" | "impactDust" | "trail";
export const COMBAT_EFFECT_KINDS: readonly CombatEffectKind[] = ["spark", "blockSpark", "impactDust", "trail"];
export const COMBAT_EFFECT_LAYOUT = EFFECT_FLIPBOOK_LAYOUT;

/** Brightest allowed channel minimum: a texel whose darkest channel reaches this reads as white flash. */
export const REDUCED_FLASH_LIMIT = 240;

/** sRGB bytes, after arpg's dark stone-and-brass look (web/src/styles.css). */
export const COMBAT_EFFECT_PALETTE = Object.freeze({
  spark: { halo: [226, 112, 34] as Rgb, ember: [246, 160, 64] as Rgb, core: [255, 214, 140] as Rgb },
  blockSpark: { halo: [92, 140, 204] as Rgb, edge: [150, 194, 240] as Rgb, core: [208, 230, 255] as Rgb },
  impactDust: { rim: [104, 92, 78] as Rgb, fill: [140, 126, 108] as Rgb, light: [170, 156, 136] as Rgb },
  trail: { outer: [190, 180, 156] as Rgb, mid: [218, 210, 188] as Rgb, core: [236, 230, 212] as Rgb },
});

/** How arpg draws a weapon swing: `segments` single trail instances along the arc, each `stagger` s after the last. */
export type TrailInstances = { segments: number; stagger: number };
export type CombatEffectRecipe = {
  kind: CombatEffectKind; description: string; scale: number;
  presets: { standard: BurstPreset; subtle: BurstPreset; heavy?: BurstPreset };
  instances?: { standard: TrailInstances; subtle: TrailInstances };
};

const UP: [number, number, number] = [0, 1, 0];
const preset = (p: Partial<BurstPreset> & Pick<BurstPreset, "count" | "lifetime" | "speed">): BurstPreset =>
  ({ emitDuration: 0, direction: UP, spread: Math.PI, gravity: [0, 0, 0], endScale: 1, fadeOut: false, ...p });

/** Presets follow arpg's tuned placeholder presets (arpg web/src/combat-vfx.js); `subtle` is the lighter setting. */
export const COMBAT_EFFECT_RECIPES: Readonly<Record<CombatEffectKind, CombatEffectRecipe>> = Object.freeze({
  spark: {
    kind: "spark", scale: 0.16,
    description: "warm radial embers: an amber flash whose six orange streaks fly outward, shorten and fade by the last frame",
    presets: {
      standard: preset({ count: 10, lifetime: 0.28, speed: [1.6, 3], spread: 1.1, gravity: [0, -6, 0], endScale: 0.4 }),
      subtle: preset({ count: 5, lifetime: 0.24, speed: [1.4, 2.4], spread: 1.0, gravity: [0, -6, 0], endScale: 0.4 }),
    },
  },
  blockSpark: {
    kind: "blockSpark", scale: 0.22,
    description: "a cool steel-blue four-point glint with shorter diagonal points and four chips, which turns slightly, shrinks and fades",
    presets: {
      standard: preset({ count: 8, lifetime: 0.3, speed: [1.2, 2.4], spread: 0.9, gravity: [0, -4, 0], endScale: 0.5 }),
      subtle: preset({ count: 4, lifetime: 0.26, speed: [1.0, 2.0], spread: 0.8, gravity: [0, -4, 0], endScale: 0.5 }),
      heavy: preset({ count: 18, lifetime: 0.45, speed: [1.6, 3.4], spread: 1.4, gravity: [0, -5, 0], endScale: 0.5 }),
    },
  },
  impactDust: {
    kind: "impactDust", scale: 0.3,
    description: "a low grey-brown puff of flattened blobs that spreads sideways, rises a little, thins and fades by the last frame",
    presets: {
      standard: preset({ count: 6, lifetime: 0.5, speed: [0.3, 0.8], spread: 1.2, gravity: [0, -0.4, 0], endScale: 1.8 }),
      subtle: preset({ count: 3, lifetime: 0.45, speed: [0.25, 0.6], spread: 1.2, gravity: [0, -0.4, 0], endScale: 1.6 }),
    },
  },
  trail: {
    kind: "trail", scale: 0.5,
    description: "a soft horizontal streak, brighter toward its leading end, that thins and fades out by the last frame",
    presets: {
      standard: preset({ count: 1, lifetime: 0.22, speed: [0, 0], spread: 0 }),
      subtle: preset({ count: 1, lifetime: 0.18, speed: [0, 0], spread: 0 }),
    },
    instances: { standard: { segments: 5, stagger: 0.025 }, subtle: { segments: 3, stagger: 0.03 } },
  },
});

// --- effects ------------------------------------------------------------------------------------------------------

const C = COMBAT_EFFECT_LAYOUT.cell / 2;
const fade = (t: number, from: number) => 1 - smoothstep(from, 1, t);

/** Six slightly irregular ember directions, so the burst does not read as a regular star. */
const EMBER_ANGLES = [0.2, 1.22, 2.28, 3.25, 4.2, 5.25] as const;

function sparkFrame(t: number): Shape[] {
  const { halo, ember, core } = COMBAT_EFFECT_PALETTE.spark, alpha = fade(t, 0.55), shapes: Shape[] = [];
  // The flash: a halo and an amber core that are gone by mid-life.
  const flash = 1 - smoothstep(0, 0.5, t);
  if (flash > 0) {
    shapes.push({ type: "ellipse", x: C, y: C, rx: 9 * flash + 2, ry: 9 * flash + 2, color: halo, alpha: 0.55 * flash });
    shapes.push({ type: "ellipse", x: C, y: C, rx: 5.5 * flash, ry: 5.5 * flash, color: core, alpha: flash });
  }
  // Embers: streaks that leave the centre, shorten and thin.
  const inner = 4 + 19 * easeOut(t), length = 11 * (1 - t) + 2.5, width = 3.4 * (1 - 0.5 * t);
  for (const [i, a] of EMBER_ANGLES.entries()) {
    const ux = Math.cos(a), uy = Math.sin(a), r0 = inner * (i % 2 ? 0.9 : 1), r1 = r0 + length;
    const line = { type: "line" as const, x0: C + ux * r0, y0: C + uy * r0, x1: C + ux * r1, y1: C + uy * r1, width, color: halo, alpha };
    shapes.push(line, { ...line, width: Math.max(0, width - 1.6), color: ember }, { ...line, x0: C + ux * (r1 - length * 0.35), y0: C + uy * (r1 - length * 0.35), width: Math.max(0, width - 2.2), color: core });
  }
  return shapes;
}

function blockSparkFrame(t: number): Shape[] {
  const { halo, edge, core } = COMBAT_EFFECT_PALETTE.blockSpark, alpha = fade(t, 0.5), shapes: Shape[] = [];
  const size = smoothstep(0, 0.12, t + 0.04) * (1 - 0.55 * smoothstep(0.1, 1, t)), turn = 0.3 * t;
  const point = (angle: number, length: number, width: number) => {
    const lens: Shape = { type: "lens", x: C, y: C, length, width, angle, color: edge, alpha };
    shapes.push(...rimmed(lens, halo, 1.4), { ...lens, length: length * 0.55, width: Math.max(0, width - 3.4), color: core });
  };
  // Long vertical and horizontal points, shorter diagonals: the four-point glint.
  point(Math.PI / 4 + turn, 26 * size, 6 * size);
  point(-Math.PI / 4 + turn, 26 * size, 6 * size);
  point(turn, 52 * size, 8 * size);
  point(Math.PI / 2 + turn, 52 * size, 8 * size);
  shapes.push({ type: "ellipse", x: C, y: C, rx: 4 * size, ry: 4 * size, color: core, alpha });
  // Four chips knocked off along the diagonals.
  if (t > 0.2) {
    const r = 9 + 15 * smoothstep(0.2, 1, t), chip = 2.4 * (1 - 0.4 * t);
    for (let k = 0; k < 4; k += 1) {
      const a = Math.PI / 4 + (k * Math.PI) / 2 + turn;
      shapes.push(...rimmed({ type: "ellipse", x: C + Math.cos(a) * r, y: C + Math.sin(a) * r, rx: chip, ry: chip, color: edge, alpha }, halo, 1));
    }
  }
  return shapes;
}

/** Fixed blob layout of the impact dust (offsets and radii in cell pixels at full size): wide and low. */
const DUST_BLOBS = [
  { x: 0, y: 4, r: 11 }, { x: -12, y: 6, r: 8.5 }, { x: 12, y: 6.5, r: 8 }, { x: -5, y: -2, r: 8 }, { x: 6, y: -1, r: 7.5 },
] as const;

function impactDustFrame(t: number): Shape[] {
  const { rim, fill, light } = COMBAT_EFFECT_PALETTE.impactDust, shapes: Shape[] = [];
  const grow = 0.55 + 0.5 * easeOut(Math.min(1, t / 0.55)), spread = 1 + 0.55 * t, alpha = fade(t, 0.4), thin = smoothstep(0.45, 1, t);
  DUST_BLOBS.forEach((blob, i) => {
    const r = blob.r * grow * (1 - thin * (i === 0 ? 0.35 : 0.6));
    if (r < 1) return;
    const x = C + blob.x * spread, y = C + blob.y - 3 * t;
    shapes.push(...rimmed({ type: "ellipse", x, y, rx: r, ry: r * 0.72, color: fill, alpha }, rim, 1.3));
    shapes.push({ type: "ellipse", x: x - r * 0.25, y: y - r * 0.3, rx: r * 0.4, ry: r * 0.24, color: light, alpha });
  });
  return shapes;
}

function trailFrame(t: number): Shape[] {
  const { outer, mid, core } = COMBAT_EFFECT_PALETTE.trail, alpha = (1 - t) ** 1.3, thin = 1 - 0.55 * t;
  // Nested lenses fake a soft falloff; the core sits toward the leading (+x) end.
  return [
    { type: "lens", x: C, y: C, length: 58, width: 20 * thin, angle: 0, color: outer, alpha: 0.3 * alpha },
    { type: "lens", x: C + 2, y: C, length: 50, width: 13 * thin, angle: 0, color: mid, alpha: 0.55 * alpha },
    { type: "lens", x: C + 6, y: C, length: 36, width: 6.5 * thin, angle: 0, color: core, alpha: 0.85 * alpha },
  ];
}

const FRAMES: Record<CombatEffectKind, (t: number) => Shape[]> = { spark: sparkFrame, blockSpark: blockSparkFrame, impactDust: impactDustFrame, trail: trailFrame };

/** The fully transparent texels keep the effect's outermost colour, so linear filtering never bleeds a dark fringe. */
export function transparentRgb(kind: CombatEffectKind): Rgb {
  const p = COMBAT_EFFECT_PALETTE;
  return { spark: p.spark.halo, blockSpark: p.blockSpark.halo, impactDust: p.impactDust.rim, trail: p.trail.outer }[kind];
}

/** The whole atlas: `width × height × 4` straight-alpha sRGB bytes, top row first. */
export const rasterizeCombatEffectAtlas = (kind: CombatEffectKind): Uint8Array => rasterizeFlipbookAtlas(FRAMES[kind], transparentRgb(kind), COMBAT_EFFECT_LAYOUT);
