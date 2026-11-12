// ui's reward-feedback flipbooks (part of #136, docs/reward-effects.md): the deterministic 2D recipe bakes white
// alpha-mask strips with transparent cell borders, ordered visible frames that end blank, distinct shapes per role and
// a strong variant that covers more than its subtle one, packages them as a verified static-glb-png-v1 tar and replays
// to the same bytes.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { readAssetBundleAsset, verifyAssetBundle } from "../src/asset-bundle.js";
import {
  REWARD_EFFECT_KINDS, REWARD_EFFECT_LAYOUT, REWARD_EFFECT_VARIANTS, rasterizeRewardEffectStrip, type RewardEffectKind, type RewardEffectVariant,
} from "../src/reward-effect-flipbooks.ts";
import { REWARD_EFFECTS_DESCRIPTOR_SCHEMA, REWARD_EFFECTS_RELEASE, buildRewardEffects, rewardEffectKey } from "../scripts/build-reward-effects.ts";
import { conforms, decodePng } from "./effect-flipbook-helpers.ts";

const schemaUrl = new URL("../schemas/reward-effects-descriptor-v1.schema.json", import.meta.url);
const { width, height, cell, columns, rows, frameCount } = REWARD_EFFECT_LAYOUT;
const id = (kind: RewardEffectKind, variant: RewardEffectVariant) => `${kind}/${variant}`;
const strips = new Map(REWARD_EFFECT_KINDS.flatMap((kind) => REWARD_EFFECT_VARIANTS.map((variant) => [id(kind, variant), rasterizeRewardEffectStrip(kind, variant)] as const)));

const alphaAt = (strip: Uint8Array, frame: number, x: number, y: number) =>
  strip[(((Math.floor(frame / columns) * cell + y) * width) + (frame % columns) * cell + x) * 4 + 3]!;
const coverage = (strip: Uint8Array, frame: number) => {
  let sum = 0;
  for (let y = 0; y < cell; y += 1) for (let x = 0; x < cell; x += 1) sum += alphaAt(strip, frame, x, y);
  return sum / 255;
};
const mask = (strip: Uint8Array, frame: number) => {
  const out: boolean[] = [];
  for (let y = 0; y < cell; y += 1) for (let x = 0; x < cell; x += 1) out.push(alphaAt(strip, frame, x, y) > 64);
  return out;
};

test("each strip is a power-of-two row of white-mask frames with transparent borders that ends blank", () => {
  assert.ok((width & (width - 1)) === 0 && (height & (height - 1)) === 0, "power-of-two texture");
  assert.deepEqual([width, height, rows], [cell * columns, cell, 1], "one row, so CSS steps along x");
  for (const [name, strip] of strips) {
    const [kind, variant] = name.split("/") as [RewardEffectKind, RewardEffectVariant];
    assert.deepEqual(strip, rasterizeRewardEffectStrip(kind, variant), `${name} rasterizes deterministically`);
    for (let i = 0; i < strip.length; i += 4) assert.deepEqual([strip[i], strip[i + 1], strip[i + 2]], [255, 255, 255], `${name} is a pure alpha mask`);
    for (let frame = 0; frame < frameCount; frame += 1) {
      let sum = 0, cx = 0, cy = 0;
      for (let y = 0; y < cell; y += 1) for (let x = 0; x < cell; x += 1) {
        const a = alphaAt(strip, frame, x, y);
        if (x < 2 || y < 2 || x >= cell - 2 || y >= cell - 2) assert.equal(a, 0, `${name} frame ${frame} border (${x}, ${y}) is transparent`);
        sum += a; cx += a * x; cy += a * y;
      }
      if (frame < frameCount - 1) {
        assert.ok(sum > 0, `${name} frame ${frame} is visible`);
        assert.ok(Math.abs(cx / sum - cell / 2) < 4 && Math.abs(cy / sum - cell / 2) < 4, `${name} frame ${frame} stays centred`);
      }
    }
    const covered = Array.from({ length: frameCount }, (_, frame) => coverage(strip, frame));
    assert.ok(covered[frameCount - 1]! < Math.max(...covered) * 0.05, `${name} is blank by its last frame`);
    assert.ok(covered.indexOf(Math.max(...covered)) < frameCount - 4, `${name} peaks before it fades`);
  }
});

test("roles differ by shape, and the strong variant covers more than the subtle one", () => {
  for (const variant of REWARD_EFFECT_VARIANTS) for (const [i, a] of REWARD_EFFECT_KINDS.entries()) for (const b of REWARD_EFFECT_KINDS.slice(i + 1)) {
    const ma = mask(strips.get(id(a, variant))!, 5), mb = mask(strips.get(id(b, variant))!, 5);
    const both = ma.filter((v, k) => v && mb[k]).length, either = ma.filter((v, k) => v || mb[k]).length;
    assert.ok(both / either < 0.5, `${a} and ${b} (${variant}) differ in shape at frame 5 (IoU ${(both / either).toFixed(2)})`);
  }
  for (const kind of REWARD_EFFECT_KINDS) {
    const total = (variant: RewardEffectVariant) => Array.from({ length: frameCount }, (_, f) => coverage(strips.get(id(kind, variant))!, f)).reduce((s, v) => s + v, 0);
    assert.ok(total("strong") > 1.15 * total("subtle"), `${kind} strong is stronger than subtle`);
  }
  // The ring expands: its mean radius grows frame over frame while it is visible.
  const ring = strips.get(id("ring", "strong"))!;
  const radius = (frame: number) => {
    let sum = 0, r = 0;
    for (let y = 0; y < cell; y += 1) for (let x = 0; x < cell; x += 1) { const a = alphaAt(ring, frame, x, y); sum += a; r += a * Math.hypot(x + 0.5 - cell / 2, y + 0.5 - cell / 2); }
    return r / sum;
  };
  for (let frame = 1; frame < frameCount - 1; frame += 1) assert.ok(radius(frame) > radius(frame - 1) - 0.5, `ring grows at frame ${frame}`);
});

test("the build packages verified strips with a schema-conforming descriptor and replays to the same tar", { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "reward-effects-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "reward-effects-replay-"));
  try {
    const built = await buildRewardEffects({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef);
    const expected = REWARD_EFFECT_KINDS.flatMap((kind) => REWARD_EFFECT_VARIANTS.map((variant) => `${rewardEffectKey(kind)}/${variant}`));
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}/${entry.variant}`).sort(), [...expected].sort());

    const d = JSON.parse(await readFile(built.descriptorPath, "utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.equal(d.schema, REWARD_EFFECTS_DESCRIPTOR_SCHEMA);
    assert.deepEqual(conforms(schema, d, schema), []);
    assert.equal(d.effects.length, expected.length);
    for (const effect of d.effects) {
      const png = await readAssetBundleAsset(built.bundleDir, manifest, effect.key, effect.variant);
      assert.equal(Buffer.from(png).length, effect.png.byteLength);
      const decoded = decodePng(png);
      assert.deepEqual([decoded.width, decoded.height], [effect.atlas.width, effect.atlas.height]);
      assert.deepEqual(decoded.pixels, strips.get(id(effect.role, effect.variant)), `${effect.key}/${effect.variant} PNG round-trips the baked pixels`);
    }
    assert.equal(built.lineage.release, REWARD_EFFECTS_RELEASE);
    assert.ok(built.tarByteLength < 128 * 1024, `the whole release stays small (${built.tarByteLength} bytes)`);

    const replay = await buildRewardEffects({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "an independent rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});
