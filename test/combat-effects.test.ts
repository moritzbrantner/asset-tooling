// arpg's baked combat flipbooks (#362, docs/combat-effects.md): the deterministic 2D recipe bakes power-of-two
// straight-alpha atlases with transparent cell borders, no near-white texels and shape-distinct hit/block sparks,
// carries BurstPresets inside the bounds of 3d-lab's compileBurst, packages them as a verified static-glb-png-v1 tar
// and replays to the same bytes.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { readAssetBundleAsset, verifyAssetBundle } from "../src/asset-bundle.js";
import { burstPresetErrors } from "../src/effect-flipbook-raster.ts";
import {
  COMBAT_EFFECT_KINDS, COMBAT_EFFECT_LAYOUT, COMBAT_EFFECT_RECIPES, REDUCED_FLASH_LIMIT, rasterizeCombatEffectAtlas, transparentRgb,
  type CombatEffectKind,
} from "../src/combat-effect-flipbooks.ts";
import {
  COMBAT_EFFECTS_DESCRIPTOR_SCHEMA, COMBAT_EFFECTS_RELEASE, COMBAT_EFFECT_VARIANT, buildCombatEffects, combatEffectKey,
} from "../scripts/build-combat-effects.ts";
import { conforms, decodePng } from "./effect-flipbook-helpers.ts";

const schemaUrl = new URL("../schemas/combat-effects-descriptor-v1.schema.json", import.meta.url);
const { width, height, cell, columns, rows, frameCount } = COMBAT_EFFECT_LAYOUT;
const atlases = new Map(COMBAT_EFFECT_KINDS.map((kind) => [kind, rasterizeCombatEffectAtlas(kind)]));

/** Alpha of `frame` at cell pixel (x, y). */
const alphaAt = (kind: CombatEffectKind, frame: number, x: number, y: number) =>
  atlases.get(kind)![(((Math.floor(frame / columns) * cell + y) * width) + (frame % columns) * cell + x) * 4 + 3]!;
function mask(kind: CombatEffectKind, frame: number): boolean[] {
  const out: boolean[] = [];
  for (let y = 0; y < cell; y += 1) for (let x = 0; x < cell; x += 1) out.push(alphaAt(kind, frame, x, y) > 64);
  return out;
}
function bounds(kind: CombatEffectKind, frame: number) {
  let x0 = cell, x1 = -1, y0 = cell, y1 = -1;
  for (let y = 0; y < cell; y += 1) for (let x = 0; x < cell; x += 1) if (alphaAt(kind, frame, x, y) > 32) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

test("every preset stays inside 3d-lab's BurstPreset bounds; subtle is lighter and heavy stronger", () => {
  for (const kind of COMBAT_EFFECT_KINDS) {
    const { presets, instances } = COMBAT_EFFECT_RECIPES[kind];
    for (const [name, preset] of Object.entries(presets)) assert.deepEqual(burstPresetErrors(preset), [], `${kind}/${name}`);
    assert.ok(presets.subtle.count < presets.standard.count || (instances && instances.subtle.segments < instances.standard.segments), `${kind} subtle is lighter`);
    if (presets.heavy) assert.ok(presets.heavy.count > presets.standard.count, `${kind} heavy is stronger`);
  }
  assert.equal(COMBAT_EFFECTS_RELEASE, "combat-effects", "one rolling release, never numbered");
});

test("each atlas is a power-of-two grid of visible, centred frames that fade out, with transparent cell borders", () => {
  assert.ok((width & (width - 1)) === 0 && (height & (height - 1)) === 0, "power-of-two texture");
  assert.equal(width, cell * columns); assert.equal(height, cell * rows);
  for (const kind of COMBAT_EFFECT_KINDS) {
    const pixels = atlases.get(kind)!, [hr, hg, hb] = transparentRgb(kind);
    assert.deepEqual(pixels, rasterizeCombatEffectAtlas(kind), `${kind} rasterizes deterministically`);
    const coverage: number[] = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      const ox = (frame % columns) * cell, oy = Math.floor(frame / columns) * cell;
      let sum = 0, cx = 0, cy = 0;
      for (let y = 0; y < cell; y += 1) for (let x = 0; x < cell; x += 1) {
        const i = ((oy + y) * width + ox + x) * 4, a = pixels[i + 3]!;
        if (x < 2 || y < 2 || x >= cell - 2 || y >= cell - 2) assert.equal(a, 0, `${kind} frame ${frame} border (${x}, ${y}) is transparent`);
        if (a === 0) assert.deepEqual([pixels[i], pixels[i + 1], pixels[i + 2]], [hr, hg, hb], `${kind} hidden RGB avoids a dark fringe`);
        else assert.ok(Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) < REDUCED_FLASH_LIMIT, `${kind} frame ${frame} has no near-white texel`);
        sum += a; cx += a * x; cy += a * y;
      }
      coverage.push(sum / 255);
      if (frame < frameCount - 1) {
        assert.ok(sum > 0, `${kind} frame ${frame} is visible`);
        assert.ok(Math.abs(cx / sum - cell / 2) < 12 && Math.abs(cy / sum - cell / 2) < 14, `${kind} frame ${frame} stays near the cell centre`);
      }
    }
    assert.ok(coverage[frameCount - 1]! < Math.max(...coverage) * 0.1, `${kind} fades out by its last frame`);
  }
});

test("the effects differ by shape, not only by hue", () => {
  // Hit sparks (radial embers) and block sparks (a four-point glint) share only their central flash early on, then barely overlap.
  for (let frame = 0; frame < frameCount - 1; frame += 1) {
    const a = mask("spark", frame), b = mask("blockSpark", frame);
    const both = a.filter((v, i) => v && b[i]).length, either = a.filter((v, i) => v || b[i]).length;
    const limit = frame < 4 ? 0.5 : 0.15;
    assert.ok(both / either < limit, `spark and blockSpark masks differ at frame ${frame} (IoU ${(both / either).toFixed(2)})`);
  }
  const trail = bounds("trail", 0);
  assert.ok(trail.w >= 2.5 * trail.h, `the trail is an elongated streak (${trail.w}×${trail.h})`);
  const dust = bounds("impactDust", 6);
  assert.ok(dust.w > 1.4 * dust.h, `the impact dust is low and wide (${dust.w}×${dust.h})`);
});

test("the build packages verified atlases with a schema-conforming descriptor and replays to the same tar", { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "combat-effects-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "combat-effects-replay-"));
  try {
    const built = await buildCombatEffects({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef);
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}/${entry.variant}`).sort(), COMBAT_EFFECT_KINDS.map((kind) => `${combatEffectKey(kind)}/${COMBAT_EFFECT_VARIANT}`).sort());
    assert.deepEqual(COMBAT_EFFECT_KINDS.map(combatEffectKey), ["spark.flipbook", "block-spark.flipbook", "impact-dust.flipbook", "trail.flipbook"]);

    const d = JSON.parse(await readFile(built.descriptorPath, "utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.equal(d.schema, COMBAT_EFFECTS_DESCRIPTOR_SCHEMA);
    assert.deepEqual(conforms(schema, d, schema), []);
    for (const [index, effect] of d.effects.entries()) {
      const png = await readAssetBundleAsset(built.bundleDir, manifest, effect.key, effect.variant);
      assert.equal(Buffer.from(png).length, effect.png.byteLength);
      const decoded = decodePng(png);
      assert.deepEqual([decoded.width, decoded.height], [effect.atlas.width, effect.atlas.height]);
      assert.deepEqual(decoded.pixels, atlases.get(COMBAT_EFFECT_KINDS[index]!), `${effect.key} PNG round-trips the baked pixels`);
    }
    assert.equal(built.lineage.release, COMBAT_EFFECTS_RELEASE);

    const replay = await buildCombatEffects({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "an independent rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});
