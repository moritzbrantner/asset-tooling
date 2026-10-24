// Zoo's baked particle flipbooks (#136 slice 1, docs/zoo-effects.md): the deterministic 2D recipe bakes
// power-of-two straight-alpha atlases whose cells are transparent at their borders, carries BurstPresets inside the
// bounds of 3d-lab's compileBurst, packages them as a verified static-glb-png-v1 tar and replays to the same bytes.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { readAssetBundleAsset, verifyAssetBundle } from "../src/asset-bundle.js";
import {
  ZOO_EFFECT_KINDS, ZOO_EFFECT_LAYOUT, ZOO_EFFECT_RECIPES, burstPresetErrors, rasterizeZooEffectAtlas, transparentRgb,
} from "../src/zoo-effect-flipbooks.ts";
import {
  ZOO_EFFECTS_DESCRIPTOR_SCHEMA, ZOO_EFFECTS_RELEASE, ZOO_EFFECT_VARIANT, buildZooEffects, zooEffectKey,
} from "../scripts/build-zoo-effects.ts";

const schemaUrl = new URL("../schemas/zoo-effects-descriptor-v1.schema.json", import.meta.url);

/** The JSON Schema subset the descriptor schema uses: const, enum, type, pattern, required, additionalProperties, items, $ref. */
function conforms(schema: any, value: any, root: any, at = "$"): string[] {
  if (schema.$ref) return conforms(root.$defs[schema.$ref.split("/").pop()], value, root, at);
  if ("const" in schema) return value === schema.const ? [] : [`${at} is not ${schema.const}`];
  if (schema.enum) return schema.enum.includes(value) ? [] : [`${at} is not one of ${schema.enum}`];
  if (schema.type === "number" || schema.type === "integer") return typeof value === "number" && (schema.type === "number" || Number.isInteger(value)) ? [] : [`${at} is not a ${schema.type}`];
  if (schema.type === "boolean") return typeof value === "boolean" ? [] : [`${at} is not a boolean`];
  if (schema.type === "string") return typeof value === "string" && (!schema.pattern || new RegExp(schema.pattern).test(value)) ? [] : [`${at} is not a matching string`];
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${at} is not an array`];
    if ((schema.minItems ?? 0) > value.length || (schema.maxItems ?? Infinity) < value.length) return [`${at} has the wrong length`];
    return value.flatMap((item, i) => conforms(schema.items, item, root, `${at}[${i}]`));
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${at} is not an object`];
    const errors = (schema.required ?? []).filter((key: string) => !(key in value)).map((key: string) => `${at}.${key} is missing`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...conforms(schema.properties[key], child, root, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key} is not allowed`);
    }
    return errors;
  }
  return [];
}

/** Decode an 8-bit RGBA, non-interlaced PNG with only filter-0 rows (what the recipe writes). */
function decodePng(png: Uint8Array) {
  const bytes = Buffer.from(png);
  assert.equal(bytes.toString("latin1", 1, 4), "PNG");
  let offset = 8, width = 0, height = 0;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("latin1", offset + 4, offset + 8), data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0]); }
    if (type === "IDAT") idat.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat)), pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width * 4 + 1)], 0);
    pixels.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, pixels };
}

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
