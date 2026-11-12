import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { parseRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import { createAssetRef } from "../src/operations.js";
import { generateRingSvg, generateStarSvg, svgNumber } from "../src/procedural-shapes.js";
import {
  createProceduralStarVectorOperationBuildIdentity,
  executeProceduralRingVectorOperation,
  executeProceduralStarVectorOperation,
} from "../src/procedural-shape-operations.js";
import {
  VECTOR_RASTERIZE_OPERATION,
  createVectorRasterizeOperationBuildIdentity,
  diagnoseSvgForRasterization,
  executeVectorRasterizeOperation,
} from "../src/vector-rasterize-operations.js";

const star = {
  width: 64, height: 64, centerX: 32, centerY: 32, points: 5, outerRadius: 20, innerRadius: 8,
  rotationDegrees: 0, fill: "#f7d548", stroke: "#5a3b12", strokeWidth: 4, strokeJoin: "round" as const,
};

async function storeSvg(root: string, text: string) {
  return (await storeAssetObject(root, { bytes: Buffer.from(text), kind: "vector-image", mediaType: "image/svg+xml" })).asset;
}

test("star SVG serializes canonical vertices starting at the upward outer point", () => {
  const svg = generateStarSvg({ ...star, points: 4, outerRadius: 10, innerRadius: 5, stroke: "none", strokeWidth: 0, strokeJoin: "miter" });
  assert.equal(
    svg.bytes.toString("utf8"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
      + '<polygon points="32,22 35.536,28.464 42,32 35.536,35.536 32,42 28.464,35.536 22,32 28.464,28.464" fill="#f7d548"/></svg>\n',
  );
  assert.match(generateStarSvg(star).bytes.toString("utf8"), / stroke="#5a3b12" stroke-width="4" stroke-linejoin="round" stroke-miterlimit="4"\/>/);
  assert.equal(svgNumber(-0.0001), "0");
  assert.equal(svgNumber(12.5), "12.5");
});

test("star and ring geometry fail closed instead of clipping", () => {
  assert.throws(() => generateStarSvg({ ...star, outerRadius: 31 }), /fit inside the canvas/);
  assert.throws(() => generateStarSvg({ ...star, innerRadius: 21 }), /innerRadius/);
  assert.throws(() => generateStarSvg({ ...star, stroke: "none" }), /exactly when strokeWidth is 0/);
  assert.throws(() => generateRingSvg({ width: 32, height: 32, centerX: 16, centerY: 16, radius: 14, strokeWidth: 6, stroke: "#000000" }), /fit inside/);
  assert.equal(
    generateRingSvg({ width: 32, height: 32, centerX: 16, centerY: 16, radius: 12, strokeWidth: 4, stroke: "#2f6f9f" }).bytes.toString("utf8"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="none" stroke="#2f6f9f" stroke-width="4"/></svg>\n',
  );
});

test("star vector build identity validates geometry before execution", async () => {
  const build = await createProceduralStarVectorOperationBuildIdentity({ parameters: star });
  assert.equal(build.implementation.algorithm, "canonical-svg-star-polygon-3dp-v1");
  await assert.rejects(() => createProceduralStarVectorOperationBuildIdentity({ parameters: { ...star, outerRadius: 40 } }), /fit inside/);
  await assert.rejects(() => createProceduralStarVectorOperationBuildIdentity({ parameters: { ...star, extra: 1 } }), /unknown field 'extra'/);
});

test("rasterization diagnoses every unsupported SVG feature instead of flattening it", () => {
  const generated = generateStarSvg(star).bytes;
  assert.deepEqual(diagnoseSvgForRasterization(generated), { width: 64, height: 64, diagnostics: [] });
  const { diagnostics } = diagnoseSvgForRasterization(Buffer.from(
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10" class="x">'
      + '<defs><linearGradient id="g"/></defs><text x="1">Hi</text><rect width="4" height="4" fill="url(#g)" style="opacity:1"/>'
      + '<image href="a.png"/><g filter="blur"/></svg>',
  ));
  for (const expected of [
    /DOCTYPE/, /attribute 'class'/, /unitless positive integer width/, /<defs> is not supported/, /<linearGradient>/,
    /<text> is not supported/, /text content 'Hi'/, /fill='url\(#g\)'/, /<rect> attribute 'style'/, /<image> is not supported/,
    /<g> attribute 'filter'/,
  ]) {
    assert.ok(diagnostics.some((line) => expected.test(line)), `missing ${expected}: ${diagnostics.join(" | ")}`);
  }
  assert.match(diagnoseSvgForRasterization(Buffer.from("<svg")).diagnostics.join(), /root <svg>/);
});

test("rasterized SVG keeps transparent edges, straight alpha and transparent padding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-vector-raster-"));
  const source = await storeSvg(
    root,
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4" viewBox="0 0 8 4">'
      + '<rect x="0" y="0" width="4" height="4" fill="#ff8000" fill-opacity="0.5"/><circle cx="6" cy="2" r="1.5" fill="#20a040"/></svg>',
  );
  const invocation = { inputs: { source }, parameters: { width: 16, height: 8, padding: 3 } };
  const first = await executeVectorRasterizeOperation(root, invocation);
  const second = await executeVectorRasterizeOperation(root, invocation);
  assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
  assert.equal(first.outputs.output.mediaType, RGBA8_IMAGE_MEDIA_TYPE);
  const image = parseRgba8Image(await resolveAssetObject(root, createAssetRef(first.outputs.output)));
  assert.equal(image.width, 22);
  assert.equal(image.height, 14);
  const at = (x: number, y: number) => Array.from(image.pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
  // Padding and uncovered texels are fully transparent black: no colour fringe for filtering to pull in.
  for (let x = 0; x < image.width; x += 1) {
    assert.deepEqual(at(x, 0), [0, 0, 0, 0]);
    assert.deepEqual(at(x, image.height - 1), [0, 0, 0, 0]);
  }
  for (let index = 0; index < image.width * image.height; index += 1) {
    if (image.pixels[index * 4 + 3] === 0) assert.deepEqual(Array.from(image.pixels.slice(index * 4, index * 4 + 3)), [0, 0, 0]);
  }
  // The half-opaque rectangle is stored as straight (not premultiplied) colour.
  const half = at(3 + 2, 3 + 2);
  assert.ok(Math.abs(half[0]! - 255) <= 1 && Math.abs(half[1]! - 128) <= 2 && half[2] === 0, `got ${half}`);
  assert.ok(Math.abs(half[3]! - 128) <= 1, `got ${half}`);
  // Anti-aliased edge texels of an opaque fill keep the fill colour; only alpha falls off.
  let edges = 0;
  for (let x = 3 + 8; x < 3 + 16; x += 1) {
    for (let y = 3; y < 3 + 8; y += 1) {
      const [r, g, b, a] = at(x, y);
      if (a! >= 64 && a! < 255) {
        edges += 1;
        assert.ok(Math.abs(r! - 0x20) <= 2 && Math.abs(g! - 0xa0) <= 2 && Math.abs(b! - 0x40) <= 2, `edge ${x},${y} = ${[r, g, b, a]}`);
      }
    }
  }
  assert.ok(edges > 0, "expected anti-aliased circle edges");
});

test("rasterize build identity pins the rasterizer and rejects mismatched sizes or missing sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-vector-raster-"));
  const source = createAssetRef((await executeProceduralRingVectorOperation(root, {
    parameters: { width: 32, height: 32, centerX: 16, centerY: 16, radius: 12, strokeWidth: 4, stroke: "#2f6f9f" },
  })).outputs.output);
  const build = await createVectorRasterizeOperationBuildIdentity(root, { inputs: { source }, parameters: { width: 64, height: 64, padding: 0 } });
  assert.deepEqual(build.operation, { id: VECTOR_RASTERIZE_OPERATION.id, version: "1" });
  const rasterizer = build.implementation.rasterizer as { package: string; version: string; wasmSha256: string };
  assert.equal(rasterizer.package, "@resvg/resvg-wasm");
  assert.match(rasterizer.version, /^\d+\.\d+\.\d+$/);
  assert.match(rasterizer.wasmSha256, /^[0-9a-f]{64}$/);
  await assert.rejects(
    () => executeVectorRasterizeOperation(root, { inputs: { source }, parameters: { width: 64, height: 32, padding: 0 } }),
    /aspect ratio/,
  );
  const empty = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-vector-raster-"));
  await assert.rejects(() => executeVectorRasterizeOperation(empty, { inputs: { source }, parameters: { width: 32, height: 32, padding: 0 } }));
  const unsupported = await storeSvg(root, '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><text>x</text></svg>');
  await assert.rejects(
    () => executeVectorRasterizeOperation(root, { inputs: { source: unsupported }, parameters: { width: 4, height: 4, padding: 0 } }),
    /unsupported features: .*<text>/,
  );
});

test("a generated star rasterizes to the same bytes in a cold store", async () => {
  const run = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-vector-raster-"));
    const svg = createAssetRef((await executeProceduralStarVectorOperation(root, { parameters: star })).outputs.output);
    return (await executeVectorRasterizeOperation(root, { inputs: { source: svg }, parameters: { width: 32, height: 32, padding: 2 } })).outputs.output.sha256;
  };
  assert.equal(await run(), await run());
});
