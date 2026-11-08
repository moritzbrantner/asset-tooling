// Crag kit (#480, docs/crag-kit.md): the scripted Blender recipe builds a verified gltf-resources-v1 bundle of rock
// slabs, corners and caps that share one KTX2 rock material (stored once), carry the climbing kit's surface metadata
// (rock grip on climbable modules, none on sheer ones), box collision proxies and shrinking LOD chains, plus the
// tileable macro texture. The layout rule covers any 6-16 m box. The build skips unless ASSET_TOOLING_BLENDER names
// Blender 5.2.2, `ktx` is available and the rock scans are hydrated.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { emptyTranslation } from "../../../src/kit-bundle.js";
import type { Document } from "@gltf-transform/core";
import {
  CRAG_DESCRIPTOR_ATTACHMENT, CRAG_FACES, CRAG_MACRO, CRAG_MODULES, CRAG_OUTCROPS, CRAG_PARTS, CRAG_PITCH, CRAG_RELEASE, CRAG_SOURCES,
  buildCragKit, cragKey, cragLayout, cragOutcropKey, createCragAssetSpec,
} from "../../../scripts/build-crag-kit.ts";
import type { Document } from "@gltf-transform/core";
import { ROLLING_RELEASES } from "../../../scripts/publish-release.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const storage = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const sources = JSON.parse(await readFile(path.join(root, "catalog/sources.json"), "utf8")).sources;
async function hydrated(sourceId: string) {
  const entry = storage.entries.find((item: any) => item.sourceId === sourceId);
  return entry && !(await readFile(path.join(root, entry.path))).subarray(0, 64).toString().startsWith("version https://git-lfs");
}
const allHydrated = (await Promise.all(Object.values(CRAG_SOURCES).map(hydrated))).every(Boolean);
const ktx = !!Bun.which(process.env.ASSET_TOOLING_KTX ?? "ktx");
const skip = !process.env.ASSET_TOOLING_BLENDER ? "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)"
  : !ktx ? "requires KTX-Software's ktx CLI (ASSET_TOOLING_KTX or ktx on PATH)"
  : !allHydrated ? "requires the hydrated rock scans (git lfs pull)" : false;

test("the crag spec runs the packaged recipe with one part at one level, from CC0 catalogued scans", () => {
  const spec = createCragAssetSpec({ part: "face-climb-2", lod: 1, scriptSha256: "a".repeat(64), commonSha256: "b".repeat(64),
    inputSha256: { diff: "c".repeat(64), normal: "d".repeat(64), arm: "e".repeat(64), boulder: "f".repeat(64), moss: "0".repeat(64) }, blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "face-climb-2", lod: 1 } });
  assert.equal(spec.assetId, "crag.kit.face-climb-2");
  assert.deepEqual(Object.keys(spec.inputs).sort(), ["arm", "boulder", "common", "diff", "moss", "normal", "script"]);
  assert.equal(CRAG_MODULES.length, 13);
  assert.equal(CRAG_RELEASE, "crag-kit", "one rolling release, never numbered");
  assert.ok(ROLLING_RELEASES.some((r) => r.name === CRAG_RELEASE && r.script === "scripts/build-crag-kit.ts" && r.blender && r.lfs && r.ktx));
  for (const id of Object.values(CRAG_SOURCES)) {
    const source = sources.find((item: any) => item.id === id);
    assert.equal(source?.license.spdx, "CC0-1.0", id);
    assert.ok(storage.entries.some((entry: any) => entry.sourceId === id), `${id} is stored`);
  }
});

test("the layout rule dresses every face cell, edge and top corner of 6-16 m boxes within the scale range", () => {
  for (const [width, depth, height] of [[6, 6, 8], [10, 7, 16], [8, 9, 11], [7, 10, 14]] as const) {
    for (const family of ["sheer", "climb"] as const) {
      const placements = cragLayout({ width, depth, height, family, seed: `crag-${width}-${depth}-${height}` });
      const rows = Math.round(height / CRAG_PITCH);
      const columns = [width, depth, width, depth].map((l) => Math.round(l / CRAG_PITCH));
      const faces = placements.filter((p) => p.key.includes(".face-"));
      assert.equal(faces.length, rows * columns.reduce((a, b) => a + b, 0));
      assert.ok(faces.every((p) => (CRAG_FACES[family] as readonly string[]).includes(p.key.slice("crag.kit.".length))), "family faces only");
      assert.equal(placements.filter((p) => p.key.includes(".corner-")).length, 4 * rows);
      assert.equal(placements.filter((p) => p.key === cragKey("cap-corner")).length, 4);
      for (const p of placements) for (const s of p.scale.slice(0, 2)) assert.ok(Math.abs(s) >= 0.75 && Math.abs(s) <= 1.25, `scale ${s}`);
      // The cells span each face exactly: the top row reaches the box top.
      const top = Math.max(...faces.map((p) => p.translation[1] + CRAG_PITCH * p.scale[1]));
      assert.ok(Math.abs(top - height) < 1e-5);
      // Every face module lies on its face plane.
      for (const p of faces) {
        const [x, , z] = p.translation;
        assert.ok(Math.abs(Math.abs(z) - depth / 2) < 1e-5 || Math.abs(Math.abs(x) - width / 2) < 1e-5);
      }
    }
  }
  assert.deepEqual(cragLayout({ width: 8, depth: 8, height: 12, family: "climb", seed: "a" }), cragLayout({ width: 8, depth: 8, height: 12, family: "climb", seed: "a" }));
});

/** The signed volume enclosed by a document's triangles, in cubic metres. */
function enclosedVolume(document: Document): number {
  let volume = 0;
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute("POSITION")!, indices = primitive.getIndices()!;
    const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
    for (let i = 0; i < indices.getCount(); i += 3) {
      position.getElement(indices.getScalar(i), a);
      position.getElement(indices.getScalar(i + 1), b);
      position.getElement(indices.getScalar(i + 2), c);
      volume += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
    }
  }
  return Math.abs(volume);
}

test("the crag recipe builds a verified KTX2 bundle with shared textures, climbing surfaces and shrinking LOD chains", { skip, timeout: 3_600_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "crag-kit-"));
  try {
    const built = await buildCragKit({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}/${entry.variant}`).sort(),
      [...CRAG_MODULES.flatMap((part) => ["default", "lod1", "lod2"].map((v) => `${cragKey(part)}/${v}`)), `${cragKey(CRAG_MACRO)}/default`,
        ...CRAG_OUTCROPS.flatMap((part) => ["default", "lod1", "lod2"].map((v) => `${cragOutcropKey(part)}/${v}`))].sort());
    // Three rock textures and the macro texture, each stored once although 39 scenes use the rock material, and the
    // three maps of the atlas every outcrop level shares.
    const textures = new Set(manifest.assets.flatMap((entry) => entry.resources).filter((r) => r.mediaType === "image/ktx2").map((r) => r.path));
    assert.equal(textures.size, 4 + 3, [...textures].join(", "));
    assert.deepEqual(kitBudgetViolations(await kitCost(built.bundleDir), KIT_BUDGETS[CRAG_RELEASE]!), []);
    for (const part of CRAG_OUTCROPS) {
      const gltf = JSON.parse(await readFile(path.join(built.bundleDir, manifest.assets.find((entry) => entry.key === cragOutcropKey(part) && entry.variant === "default")!.path), "utf8"));
      assert.deepEqual(gltf.materials.map((m: { name: string }) => m.name), ["outcrop-rock"], `${part} draws with the shared material`);
    }
    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, cragKey(CRAG_PARTS[0]), "default", CRAG_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    for (const entry of d.outcrops.entries) {
      const levels = entry.lods.levels.map((level: any) => level.triangles);
      assert.ok(levels[0] > levels[1] && levels[1] > levels[2] && levels[2] > 100, `${entry.role} LOD triangles ${levels}`);
      assert.ok(entry.bounds.min[1] < -0.5 && entry.bounds.max[1] > entry.fit.height * 0.9, `${entry.role} is buried at the foot and reaches its height`);
      // A decimation that collapses the body keeps the bounds but loses the volume: the rock must still fill a cone of its size.
      const enclosed = enclosedVolume(built.documents[`outcrop-${entry.role}.default`]!);
      const cone = (Math.PI * entry.fit.radii[0] * entry.fit.radii[1] * entry.fit.height) / 3;
      assert.ok(enclosed > cone * 0.7, `${entry.role} encloses ${enclosed.toFixed(1)} m³ of a ${cone.toFixed(1)} m³ cone`);
      // The collision mesh is closed, wound outward, small enough for physics and about the size of the visible rock.
      const { vertices, triangles: faces } = entry.collisionMesh as { vertices: number[][]; triangles: number[][] };
      const edges = new Map<string, number>();
      let signed = 0;
      for (const [a, b, c] of faces as [number, number, number][]) {
        for (const [from, to] of [[a, b], [b, c], [c, a]] as const) edges.set(`${from}>${to}`, (edges.get(`${from}>${to}`) ?? 0) + 1);
        const [p, q, r] = [vertices[a]!, vertices[b]!, vertices[c]!];
        signed += (p[0]! * (q[1]! * r[2]! - q[2]! * r[1]!) - p[1]! * (q[0]! * r[2]! - q[2]! * r[0]!) + p[2]! * (q[0]! * r[1]! - q[1]! * r[0]!)) / 6;
      }
      for (const [edge, count] of edges) {
        const [from, to] = edge.split(">");
        assert.equal(count, 1, `${entry.role}: directed edge ${edge} repeats`);
        assert.equal(edges.get(`${to}>${from}`), 1, `${entry.role}: edge ${edge} has no partner, so the mesh is open`);
      }
      assert.ok(faces.length <= 240, `${entry.role}: ${faces.length} collision triangles`);
      assert.ok(signed > enclosed * 0.55 && signed < enclosed * 1.25, `${entry.role}: collision encloses ${signed.toFixed(1)} m³ of the rock's ${enclosed.toFixed(1)} m³`);
    }
    const asset = Object.fromEntries(d.assets.map((a: any) => [a.role, a]));
    for (const part of CRAG_MODULES) {
      const a = asset[part];
      const climbable = part.includes("-climb-");
      assert.equal(a.climb.grip, climbable ? "rock" : null, `${part} grip`);
      assert.equal(a.climb.standOff, 0.36);
      assert.ok(a.collisionProxies.length > 0 && a.collisionProxies.every((p: any) => p.name && p.tag && p.center.length === 3 && p.size.length === 3));
      if (climbable) assert.ok(a.collisionProxies.some((p: any) => p.tag === "climbable"));
      const counts = a.lods.levels.map((l: any) => l.triangles);
      assert.ok(counts[0] > counts[1] && counts[1] > counts[2], `${part} LOD chain ${counts}`);
      assert.deepEqual(a.lods.levels.map((l: any) => l.variant), ["default", "lod1", "lod2"]);
      const material = built.documents[`${part}.default`]!.getRoot().listMaterials()[0]!;
      assert.equal(material.getBaseColorTexture()?.getMimeType(), "image/ktx2");
      assert.equal(material.getNormalTexture()?.getMimeType(), "image/ktx2");
      assert.equal(material.getMetallicRoughnessTexture()?.getMimeType(), "image/ktx2");
    }
    for (const part of [...CRAG_FACES.sheer, ...CRAG_FACES.climb]) {
      const { relief, face, gripLine } = asset[part].climb;
      assert.deepEqual(face.normal, [0, 0, 1]);
      assert.ok(relief.max > relief.mean && relief.mean > 0, `${part} relief`);
      assert.deepEqual(emptyTranslation(built.documents[`${part}.default`]!, "climb.bottom"), gripLine.from);
      assert.deepEqual(emptyTranslation(built.documents[`${part}.default`]!, "climb.top"), gripLine.to);
    }
    // Climbable faces stand prouder and rougher than sheer ones.
    const mean = (parts: readonly string[], k: string) => parts.reduce((s, p) => s + asset[p].climb.relief[k], 0) / parts.length;
    assert.ok(mean(CRAG_FACES.climb, "max") - mean(CRAG_FACES.climb, "min") > mean(CRAG_FACES.sheer, "max") - mean(CRAG_FACES.sheer, "min"));
    assert.equal(asset[CRAG_MACRO].macro.worldMetres, d.macro.worldMetres);
    const macroMean = asset[CRAG_MACRO].macro.mean;
    assert.ok(macroMean.every((c: number) => c > 0.4 && c < 0.6), `macro centred on 0.5: ${macroMean}`);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
