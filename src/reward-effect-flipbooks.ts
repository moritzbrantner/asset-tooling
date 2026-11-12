// Baked reward-feedback flipbooks for ui's Pop/Pulse components (ui#60, part of #136, docs/reward-effects.md): a
// four-point sparkle, an expanding ring, a radial burst of rays and one tumbling confetti piece, each in a `subtle`
// and a `strong` variant. They are white alpha masks, so the UI tints them with its own theme tokens (for example CSS
// `mask-image` over `background-color: var(--primary)`), and 16-frame horizontal strips, so CSS can step through them
// with `steps()`. UI owns timing, springs, particle motion and lifecycle; these are artwork only. Each frame is a
// fixed list of shapes drawn by the shared deterministic rasterizer in effect-flipbook-raster.ts.
import {
  type EffectFlipbookLayout, type Rgb, type Shape, easeOut, rasterizeFlipbookAtlas, smoothstep,
} from "./effect-flipbook-raster.ts";

export type RewardEffectKind = "sparkle" | "ring" | "burst" | "confetti";
export const REWARD_EFFECT_KINDS: readonly RewardEffectKind[] = ["sparkle", "ring", "burst", "confetti"];
export type RewardEffectVariant = "subtle" | "strong";
export const REWARD_EFFECT_VARIANTS: readonly RewardEffectVariant[] = ["subtle", "strong"];

/** 16 cells of 64 px in one row: a 1024×64 strip that CSS steps through along x. */
export const REWARD_EFFECT_LAYOUT: EffectFlipbookLayout = Object.freeze({ cell: 64, columns: 16, rows: 1, frameCount: 16, width: 1024, height: 64, filter: "linear" as const });

/** Every texel is white; only alpha carries the shape, so the consumer's tint is the colour. */
export const MASK_RGB: Rgb = [255, 255, 255];

export type RewardEffectRecipe = {
  kind: RewardEffectKind;
  description: string;
  /** Suggested drawn size in CSS pixels per variant; the 64 px cell gives 2× density at that size. */
  cssSize: Record<RewardEffectVariant, number>;
};

export const REWARD_EFFECT_RECIPES: Readonly<Record<RewardEffectKind, RewardEffectRecipe>> = Object.freeze({
  sparkle: {
    kind: "sparkle", cssSize: { subtle: 24, strong: 32 },
    description: "a four-point twinkle with long vertical and horizontal points and short diagonals that pops in, turns slightly, shrinks and fades; strong adds a soft halo and two satellite glints",
  },
  ring: {
    kind: "ring", cssSize: { subtle: 28, strong: 36 },
    description: "a ring that expands from the centre, thins and fades; strong is wider and trails a faint second ring",
  },
  burst: {
    kind: "burst", cssSize: { subtle: 28, strong: 36 },
    description: "a central flash with radial rays that fly outward, shorten and fade; subtle has 8 even rays, strong 12 alternating long and short",
  },
  confetti: {
    kind: "confetti", cssSize: { subtle: 14, strong: 18 },
    description: "one confetti strip that turns and tumbles about its long axis, its back face drawn lighter, and fades at the end; the consumer moves it",
  },
});

const C = REWARD_EFFECT_LAYOUT.cell / 2;
const W = MASK_RGB;
const fade = (t: number, from: number) => 1 - smoothstep(from, 1, t);

function sparkleFrame(t: number, strong: boolean): Shape[] {
  const R = strong ? 27 : 21, alpha = fade(t, 0.55), shapes: Shape[] = [];
  const size = smoothstep(0, 0.2, t + 0.03) * (1 - 0.6 * smoothstep(0.3, 1, t)), turn = 0.3 * t;
  if (strong && t < 0.6) shapes.push({ type: "ellipse", x: C, y: C, rx: 0.55 * R * size, ry: 0.55 * R * size, color: W, alpha: 0.28 * (1 - t / 0.6) });
  const point = (angle: number, length: number, width: number) => shapes.push({ type: "lens", x: C, y: C, length, width, angle, color: W, alpha });
  point(turn, 2 * R * size, 0.3 * R * size);
  point(Math.PI / 2 + turn, 2 * R * size, 0.3 * R * size);
  point(Math.PI / 4 + turn, R * size, 0.2 * R * size);
  point(-Math.PI / 4 + turn, R * size, 0.2 * R * size);
  shapes.push({ type: "ellipse", x: C, y: C, rx: 0.14 * R * size, ry: 0.14 * R * size, color: W, alpha });
  if (strong && t > 0.15) {
    // Two small glints that appear off the diagonals and fade before the main star.
    const g = smoothstep(0.15, 0.35, t) * (1 - smoothstep(0.55, 0.85, t));
    for (const [dx, dy, s] of [[16, -15, 1], [-14, 16, 0.75]] as const) {
      const r = 6 * s * g;
      shapes.push({ type: "lens", x: C + dx, y: C + dy, length: 2 * r, width: 0.45 * r, angle: 0, color: W, alpha: g });
      shapes.push({ type: "lens", x: C + dx, y: C + dy, length: 2 * r, width: 0.45 * r, angle: Math.PI / 2, color: W, alpha: g });
    }
  }
  return shapes;
}

function ringFrame(t: number, strong: boolean): Shape[] {
  const grow = easeOut(t), alpha = fade(t, 0.45);
  const r = 5 + (strong ? 23 : 19) * grow, width = (strong ? 7 : 4.5) * (1 - 0.75 * t) + 0.8;
  const shapes: Shape[] = [{ type: "ring", x: C, y: C, r, width, color: W, alpha }];
  if (strong && t > 0.3) shapes.push({ type: "ring", x: C, y: C, r: 0.7 * r, width: 0.5 * width, color: W, alpha: 0.4 * alpha * smoothstep(0.3, 0.45, t) });
  return shapes;
}

function burstFrame(t: number, strong: boolean): Shape[] {
  const rays = strong ? 12 : 8, alpha = fade(t, 0.55), shapes: Shape[] = [];
  const flash = 1 - smoothstep(0, 0.35, t);
  if (flash > 0) shapes.push({ type: "ellipse", x: C, y: C, rx: (strong ? 7 : 5.5) * flash, ry: (strong ? 7 : 5.5) * flash, color: W });
  const inner = 4 + 18 * easeOut(t), width = (strong ? 4 : 3.2) * (1 - 0.5 * t);
  for (let i = 0; i < rays; i += 1) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / rays, short = strong && i % 2 === 1;
    const length = ((short ? 8 : 13) * (1 - t) + 2) * (strong ? 1 : 0.85), mid = inner * (short ? 0.85 : 1) + length / 2;
    shapes.push({ type: "lens", x: C + Math.cos(a) * mid, y: C + Math.sin(a) * mid, length, width, angle: a, color: W, alpha });
  }
  return shapes;
}

function confettiFrame(t: number, strong: boolean): Shape[] {
  // The strip turns in the plane while it tumbles about its long axis: its apparent width follows |cos|.
  const turns = strong ? 1.5 : 1, phase = 2 * Math.PI * turns * t, face = Math.cos(phase);
  const length = strong ? 24 : 20, width = (strong ? 10 : 8.5) * Math.max(0.2, Math.abs(face)), angle = 0.5 + 1.4 * t;
  const alpha = fade(t, 0.7) * (face >= 0 ? 1 : 0.62), hx = Math.cos(angle) * (length - width) / 2, hy = Math.sin(angle) * (length - width) / 2;
  return [{ type: "line", x0: C - hx, y0: C - hy, x1: C + hx, y1: C + hy, width, color: W, alpha }];
}

const FRAMES: Record<RewardEffectKind, (t: number, strong: boolean) => Shape[]> = { sparkle: sparkleFrame, ring: ringFrame, burst: burstFrame, confetti: confettiFrame };

/** The whole strip: `width × height × 4` straight-alpha sRGB bytes, top row first, every texel's RGB white. */
export const rasterizeRewardEffectStrip = (kind: RewardEffectKind, variant: RewardEffectVariant): Uint8Array =>
  rasterizeFlipbookAtlas((t) => FRAMES[kind](t, variant === "strong"), MASK_RGB, REWARD_EFFECT_LAYOUT);

/** A copy of a mask with its RGB replaced by `tint`, the way the consumer will draw it. */
export function tintMask(mask: Uint8Array, tint: Rgb): Uint8Array {
  const out = new Uint8Array(mask);
  for (let i = 0; i < out.length; i += 4) out.set(tint, i);
  return out;
}
