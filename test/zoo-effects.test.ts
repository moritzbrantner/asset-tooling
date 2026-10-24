// Zoo's baked particle flipbooks (#136 slice 1, docs/zoo-effects.md): the deterministic 2D recipe bakes
// power-of-two straight-alpha atlases whose cells are transparent at their borders, carries BurstPresets inside the
// bounds of 3d-lab's compileBurst, packages them as a verified static-glb-png-v1 tar and replays to the same bytes.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { burstPresetErrors } from "../src/effect-flipbook-raster.ts";
import { conforms, decodePng } from "./effect-flipbook-helpers.ts";
import { readAssetBundleAsset, verifyAssetBundle } from "../src/asset-bundle.js";
import {
  ZOO_EFFECT_KINDS, ZOO_EFFECT_LAYOUT, ZOO_EFFECT_RECIPES, rasterizeZooEffectAtlas, transparentRgb,
} from "../src/zoo-effect-flipbooks.ts";
import {
  ZOO_EFFECTS_DESCRIPTOR_SCHEMA, ZOO_EFFECTS_RELEASE, ZOO_EFFECT_VARIANT, buildZooEffects, zooEffectKey,
} from "../scripts/build-zoo-effects.ts";

const schemaUrl = new URL("../schemas/zoo-effects-descriptor-v1.schema.json", import.meta.url);

test("every recipe preset stays inside 3d-lab's BurstPreset bounds, and bad presets are rejected", () => {
  for (const kind of ZOO_EFFECT_KINDS) for (const [name, preset] of Object.entries(ZOO_EFFECT_RECIPES[kind].presets)) {
    assert.deepEqual(burstPresetErrors(preset), [], `${kind}/${name}`);
  }
  for (const kind of ZOO_EFFECT_KINDS) assert.ok(ZOO_EFFECT_RECIPES[kind].presets.subtle.count < ZOO_EFFECT_RECIPES[kind].presets.standard.count, `${kind} subtle is lighter`);
  const base = ZOO_EFFECT_RECIPES.dust.presets.standard;
  assert.ok(burstPresetErrors({ ...base, count: 257 }).length > 0, "over the particle cap");
  assert.ok(burstPresetErrors({ ...base, lifetime: 0 }).length > 0, "zero lifetime");
  assert.ok(burstPresetErrors({ ...base, speed: [2, 1] }).length > 0, "inverted speed range");
  assert.ok(burstPresetErrors({ ...base, spread: 4 }).length > 0, "spread over PI");
  assert.equal(ZOO_EFFECTS_RELEASE, "zoo-effects", "one rolling release, never numbered");
});

test("each atlas is a power-of-two grid of visible, centred frames with transparent cell borders", () => {
  const { width, height, cell, columns, rows, frameCount } = ZOO_EFFECT_LAYOUT;
  assert.ok((width & (width - 1)) === 0 && (height & (height - 1)) === 0, "power-of-two texture");
  assert.equal(width, cell * columns); assert.equal(height, cell * rows); assert.ok(frameCount >= 8 && frameCount <= columns * rows);
  for (const kind of ZOO_EFFECT_KINDS) {
    const pixels = rasterizeZooEffectAtlas(kind), [hr, hg, hb] = transparentRgb(kind);
    assert.deepEqual(pixels, rasterizeZooEffectAtlas(kind), `${kind} rasterizes deterministically`);
    const coverage: number[] = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      const ox = (frame % columns) * cell, oy = Math.floor(frame / columns) * cell;
      let sum = 0, cx = 0, cy = 0;
      for (let y = 0; y < cell; y += 1) for (let x = 0; x < cell; x += 1) {
        const i = ((oy + y) * width + ox + x) * 4, a = pixels[i + 3]!;
        if (x < 2 || y < 2 || x >= cell - 2 || y >= cell - 2) assert.equal(a, 0, `${kind} frame ${frame} border (${x}, ${y}) is transparent`);
        if (a === 0) assert.deepEqual([pixels[i], pixels[i + 1], pixels[i + 2]], [hr, hg, hb], `${kind} hidden RGB avoids a dark fringe`);
        sum += a; cx += a * x; cy += a * y;
      }
      coverage.push(sum / 255);
      if (frame < frameCount - 1) {
        assert.ok(sum > 0, `${kind} frame ${frame} is visible`);
        assert.ok(Math.abs(cx / sum - cell / 2) < 12 && Math.abs(cy / sum - cell / 2) < 14, `${kind} frame ${frame} stays near the cell centre`);
      }
    }
    if (kind !== "leaf") assert.ok(coverage[frameCount - 1]! < coverage[frameCount / 2]! * 0.1, `${kind} fades out by its last frame`);
    else assert.ok(Math.min(...coverage) > 0, "the leaf stays visible; the preset's fadeOut fades it");
  }
});

test("the build packages verified atlases with a schema-conforming descriptor and replays to the same tar", { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "zoo-effects-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "zoo-effects-replay-"));
  try {
    const built = await buildZooEffects({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef);
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}/${entry.variant}`), ZOO_EFFECT_KINDS.map((kind) => `${zooEffectKey(kind)}/${ZOO_EFFECT_VARIANT}`).sort());

    const d = JSON.parse(await readFile(built.descriptorPath, "utf8"));
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.equal(d.schema, ZOO_EFFECTS_DESCRIPTOR_SCHEMA);
    assert.deepEqual(conforms(schema, d, schema), []);
    for (const effect of d.effects) {
      const png = await readAssetBundleAsset(built.bundleDir, manifest, effect.key, effect.variant);
      assert.equal(Buffer.from(png).length, effect.png.byteLength);
      const decoded = decodePng(png);
      assert.deepEqual([decoded.width, decoded.height], [effect.atlas.width, effect.atlas.height]);
      assert.deepEqual(decoded.pixels, rasterizeZooEffectAtlas(effect.role), `${effect.role} PNG round-trips the baked pixels`);
    }
    assert.deepEqual(built.lineage.release, ZOO_EFFECTS_RELEASE);

    const replay = await buildZooEffects({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "an independent rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});
