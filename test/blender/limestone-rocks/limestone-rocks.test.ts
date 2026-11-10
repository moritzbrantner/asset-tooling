// Limestone rocks (docs/limestone-rocks.md, #536): the recipe builds a verified gltf-resources-v1 bundle of eight pieces on
// one atlas, whose bodies survived decimation, whose rocks carry closed collision and whose LODs at least halve.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  LIMESTONE_DESCRIPTOR_ATTACHMENT, LIMESTONE_LOD_DISTANCES, LIMESTONE_MATERIAL, LIMESTONE_PARTS, LIMESTONE_RELEASE, buildLimestoneRocks, createLimestoneSpec, limestoneKey,
} from "../../../scripts/build-limestone-rocks.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { SURFACE_MASK_ATTRIBUTE, takeRockSurface } from "../../../scripts/baked-rock-kit.ts";

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

test("the limestone spec runs the packaged recipe for exactly one piece", () => {
  const inputSha256 = { rockColour: "c".repeat(64), rockHeight: "d".repeat(64), grassColour: "e".repeat(64), gravelColour: "f".repeat(64), mossColour: "0".repeat(64) };
  const spec = createLimestoneSpec({ part: "ledge", scriptSha256: "a".repeat(64), outcropSha256: "b".repeat(64), inputSha256, blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "ledge" } });
  assert.equal(spec.assetId, "limestone-rocks.kit.ledge");
  assert.equal(LIMESTONE_RELEASE, "limestone-rocks", "one rolling release, never numbered");
});

test("--surface picks the baked or layered build and defaults to baked", () => {
  const argv = ["bun", "build", "--surface", "layered", "--out", "x"];
  assert.equal(takeRockSurface(argv), "layered");
  assert.deepEqual(argv, ["bun", "build", "--out", "x"]);
  assert.equal(takeRockSurface(argv), "baked");
  assert.throws(() => takeRockSurface(["--surface", "painted"]), /--surface must be one of baked, layered/);
});

test("the recipe builds a verified kit on one atlas within its limits", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 2_400_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "limestone-rocks-"));
  try {
    const built = await buildLimestoneRocks({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      LIMESTONE_PARTS.flatMap((part) => ["default", "lod1", "lod2"].map((variant) => `${limestoneKey(part)}#${variant}`)).sort());

    // One material on one atlas: colour, normal and roughness, KTX2 and stored once, inside the kit's cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png") || name.endsWith(".jpg")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 3);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [LIMESTONE_MATERIAL]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[LIMESTONE_RELEASE]!), []);

    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, limestoneKey(LIMESTONE_PARTS[0]), "default", LIMESTONE_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.assets.length, LIMESTONE_PARTS.length);
    // mmorpg's lit material needs both, or a piece renders black up close.
    for (const part of LIMESTONE_PARTS) for (const mesh of built.documents[part].getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      assert.ok(primitive.getAttribute("COLOR_0") && primitive.getAttribute("TANGENT"), `${part} has vertex colours and tangents`);
    }
    for (const entry of d.assets) {
      const [lod0, lod1, lod2] = entry.lods.levels;
      assert.ok(lod1.triangles * 2 <= lod0.triangles && lod2.triangles * 2 <= lod1.triangles, `${entry.role}: LODs ${lod0.triangles} ${lod1.triangles} ${lod2.triangles} at least halve`);
      assert.deepEqual(entry.lods.levels.map((level: any) => level.referenceMaxDistance), [...LIMESTONE_LOD_DISTANCES, null]);
      assert.ok(entry.bounds.min[1] < 0, `${entry.role} reaches below the ground`);
      if (entry.kind === "scree") {
        assert.equal(entry.collision, "none", `${entry.role}: walk-on debris declares no collision`);
        continue;
      }
      assert.ok(entry.bounds.max[1] > entry.fit.height * 0.75, `${entry.role} reaches its height`);
      // A decimation that collapses the body keeps the bounds but loses the volume, so a blocky rock must fill more than a cone.
      const enclosed = enclosedVolume(built.documents[entry.role as (typeof LIMESTONE_PARTS)[number]]);
      const cone = (Math.PI * entry.fit.radii[0] * entry.fit.radii[1] * entry.fit.height) / 3;
      assert.ok(enclosed > cone, `${entry.role} encloses ${enclosed.toFixed(1)} m³ of a ${cone.toFixed(1)} m³ cone`);
      const { vertices, triangles: faces } = entry.collisionMesh as { vertices: number[][]; triangles: [number, number, number][] };
      const edges = new Map<string, number>();
      let signed = 0;
      for (const [a, b, c] of faces) {
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
      assert.ok(signed > enclosed * 0.5 && signed < enclosed * 1.3, `${entry.role}: collision encloses ${signed.toFixed(1)} m³ of the rock's ${enclosed.toFixed(1)} m³`);
    }

    // The --surface layered trial (#567): the same pieces, no per-piece maps, masks per vertex and one shared library.
    const bakedCost = cost;
    const layered = await buildLimestoneRocks({ outDir, surface: "layered" });
    assert.ok(layered.tar.endsWith("limestone-rocks-layered.kit.tar"));
    const layeredManifest = (await verifyAssetBundle(layered.bundleDir, layered.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE })).manifest;
    const library = layered.descriptor.surface!.library.key;
    assert.deepEqual(layeredManifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      [...LIMESTONE_PARTS.flatMap((part) => ["default", "lod1", "lod2"].map((variant) => `${limestoneKey(part)}#${variant}`)), `${library}#default`].sort());
    const layeredCost = await kitCost(layered.bundleDir);
    assert.deepEqual(layeredCost.materials, ["limestone-rock-layered", "surface.limestone", "surface.moss", "surface.soil"]);
    assert.ok(layeredCost.textureMemoryBytes < bakedCost.textureMemoryBytes / 2, `the shared library takes ${layeredCost.textureMemoryBytes} bytes`);
    assert.deepEqual(Object.keys(layered.descriptor.surface!.weathering), ["light", "medium", "heavy"]);
    for (const part of LIMESTONE_PARTS) for (const mesh of layered.documents[part].getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      assert.ok(primitive.getAttribute(SURFACE_MASK_ATTRIBUTE) && primitive.getAttribute("COLOR_0"), `${part} carries its masks`);
      assert.equal(primitive.getAttribute("TEXCOORD_0"), null, `${part} needs no UVs`);
      assert.equal(primitive.getMaterial()!.getBaseColorTexture(), null, `${part} has no texture of its own`);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
