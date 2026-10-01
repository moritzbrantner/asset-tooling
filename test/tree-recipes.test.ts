import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { executeGltfImportOperation } from "../src/gltf-import-operations.js";
import { storeAssetObject } from "../src/asset-store.js";
import { createTreeAssetSpec, TREE_PRESETS, SAPLING_TREE_SOURCE, readTreeRecipeSource } from "../src/tree-recipes.js";

type Bone = { id: string; parent: string | null; head: number[]; tail: number[] };
type TreeEvidence = { source: { sha256: string }; wind: string; splines: number;
  componentGeometrySha256: Record<string, string>; branchHierarchy: Bone[] };
// The legacy core is outside the incremental strict project. This fixture bridge types
// only the returned evidence exercised below; generation still crosses the public API.
const { generateAsset, verifyAsset }: {
  generateAsset(specPath: string): Promise<{ receipt: { observations: { script: TreeEvidence } } }>;
  verifyAsset(specPath: string): Promise<{ status: string }>;
} = await import(new URL("../src/core.js", import.meta.url).href);

const source = await readTreeRecipeSource();
const spec = (parameters: unknown = TREE_PRESETS.broadleaf) => createTreeAssetSpec({
  assetId: "test.tree", parameters, scriptSha256: source.sha256, blenderVersion: source.blenderVersion,
});
test("tree recipe pins its authoritative offline generator and complete explicit controls", () => {
  const actual = spec();
  assert.deepEqual(actual.generator, { id: "external.blender.script", version: "1" });
  assert.deepEqual(actual.inputs.sapling, { path: "sapling.zip", sha256: SAPLING_TREE_SOURCE.sha256 });
  assert.deepEqual(actual.parameters.arguments, TREE_PRESETS.broadleaf);
  assert.equal(Reflect.set(TREE_PRESETS.broadleaf, "seed", "12"), false);
  for (const component of ["trunk", "branches", "foliage", "composed"]) {
    assert.notDeepEqual(spec({ ...TREE_PRESETS.broadleaf, component }), spec({ ...TREE_PRESETS.conifer, component }));
  }
});
test("tree recipes reject malformed controls and unbounded work before invocation", () => {
  for (const change of [{ height: 0 }, { height: Infinity }, { seed: "-1" }, { seed: "2147483648" },
    { primaryBranches: 33 }, { secondaryBranches: 9 }, { levels: 4 }, { foliageDensity: 513 },
    { trunkTaper: -1 }, { branchAngle: NaN }, { component: "wind" }, { maxTriangles: 1000001 }, { extra: true }]) {
    assert.throws(() => spec({ ...TREE_PRESETS.broadleaf, ...change }));
  }
});

const enabled = Boolean(process.env.ASSET_TOOLING_BLENDER && process.env.ASSET_TOOLING_SAPLING_ARCHIVE);
test("actual Sapling components have bounded grounded geometry, native hierarchy and replay parity", {
  skip: !enabled && "pinned Blender and Sapling archive are required", timeout: 180000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tree-recipe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = process.env.ASSET_TOOLING_SAPLING_ARCHIVE;
  assert.ok(archive);
  const archiveBytes = await readFile(archive);
  await writeFile(path.join(root, "tree.py"), source.bytes);
  await writeFile(path.join(root, "sapling.zip"), archiveBytes);
  const specPath = path.join(root, "asset.json");
  const outputPath = path.join(root, "tree.glb");
  for (const parameters of Object.values(TREE_PRESETS)) {
    let composedHashes: unknown;
    for (const component of ["composed", "trunk", "branches", "foliage"] as const) {
      await writeFile(specPath, JSON.stringify(spec({ ...parameters, component })));
      const generated = await generateAsset(specPath);
      const bytes = await readFile(outputPath);
      const verified = await verifyAsset(specPath);
      assert.equal(verified.status, "exact");
      const document = await new NodeIO().readBinary(new Uint8Array(bytes));
      const scene = document.getRoot();
      assert.equal(scene.listMeshes().length, component === "composed" ? 3 : 1);
      assert.equal(scene.listSkins().length, 0);
      assert.equal(scene.listAnimations().length, 0);
      assert.equal(scene.listTextures().length, 0);
      const stored = await storeAssetObject(root, { bytes, kind: "mesh", mediaType: "model/gltf-binary" });
      await executeGltfImportOperation(root, { inputs: { source: stored.asset }, parameters: {} });
      let triangles = 0, minimumY = Infinity, maximumY = -Infinity;
      for (const mesh of scene.listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          const positions = primitive.getAttribute("POSITION");
          const normals = primitive.getAttribute("NORMAL");
          const uvs = primitive.getAttribute("TEXCOORD_0");
          assert.ok(positions && normals && uvs);
          assert.equal(normals.getCount(), positions.getCount());
          assert.equal(uvs.getCount(), positions.getCount());
          const indices = primitive.getIndices();
          assert.ok(indices);
          triangles += indices.getCount() / 3;
          for (let i = 0; i < indices.getCount(); i++) assert.ok(indices.getScalar(i) < positions.getCount());
          for (let i = 0; i < positions.getCount(); i++) {
            const point: number[] = [], normal: number[] = [], uv: number[] = [];
            positions.getElement(i, point); normals.getElement(i, normal); uvs.getElement(i, uv);
            assert.ok(point.every(Number.isFinite) && normal.every(Number.isFinite) && uv.every(Number.isFinite));
            assert.ok(Math.abs(normal.reduce((sum, value) => sum + value * value, 0) - 1) < 1e-4);
            minimumY = Math.min(minimumY, point[1]!); maximumY = Math.max(maximumY, point[1]!);
          }
        }
      }
      assert.ok(triangles > 0 && triangles <= parameters.maxTriangles);
      assert.ok(minimumY >= -1e-5);
      if (component === "composed") {
        assert.ok(Math.abs(minimumY) < 1e-5);
        assert.ok(Math.abs(maximumY - parameters.height) < 1e-5);
        assert.equal(scene.listMaterials().length, 2, "trunk and branches share one bark material");
      }
      const observations = generated.receipt.observations.script;
      assert.equal(observations.source.sha256, SAPLING_TREE_SOURCE.sha256);
      assert.equal(observations.wind, "none");
      assert.ok(observations.splines <= 1 + parameters.primaryBranches + parameters.primaryBranches * parameters.secondaryBranches);
      if (component === "composed") composedHashes = observations.componentGeometrySha256;
      else assert.deepEqual(observations.componentGeometrySha256, composedHashes);
      const bones = observations.branchHierarchy;
      const byId = new Map(bones.map(bone => [bone.id, bone]));
      assert.equal(byId.size, bones.length);
      assert.equal(bones.filter(bone => bone.parent === null).length, 1);
      assert.deepEqual(bones[0]?.head, [0, 0, 0]);
      for (const bone of bones) {
        assert.ok([...bone.head, ...bone.tail].every(Number.isFinite));
        if (bone.parent === null) continue;
        const parent = byId.get(bone.parent);
        assert.ok(parent);
        const ancestorIds = new Set([bone.id]);
        let ancestor = parent;
        while (true) {
          assert.ok(!ancestorIds.has(ancestor.id), "native hierarchy is acyclic");
          ancestorIds.add(ancestor.id);
          if (ancestor.parent === null) break;
          const next = byId.get(ancestor.parent); assert.ok(next); ancestor = next;
        }
        if (bone.id.split(".")[0] === parent.id.split(".")[0]) assert.deepEqual(bone.head, parent.tail);
        else {
          // Independent distance to the coarse parent-bone segment; native Bezier attachment
          // can lie off this chord. The fixture permits at most 2% of total authored height.
          const v = parent.tail.map((value, i) => value - parent.head[i]!);
          const w = bone.head.map((value, i) => value - parent.head[i]!);
          const lengthSquared = v.reduce((sum, value) => sum + value * value, 0);
          assert.ok(lengthSquared > 0);
          const fraction = Math.max(0, Math.min(1, v.reduce((sum, value, i) => sum + value * w[i]!, 0) / lengthSquared));
          const distance = Math.hypot(...bone.head.map((value, i) => value - (parent.head[i]! + fraction * v[i]!)));
          assert.ok(distance <= parameters.height * .02);
        }
      }
      const before = await stat(outputPath);
      await generateAsset(specPath);
      assert.equal((await stat(outputPath)).mtimeMs, before.mtimeMs);
      assert.deepEqual(await readFile(outputPath), bytes);
    }
  }
  const accepted = await readFile(outputPath), before = await stat(outputPath);
  await writeFile(path.join(root, "sapling.zip"), Buffer.alloc(archiveBytes.length));
  await assert.rejects(generateAsset(specPath), /hash|sha256/);
  await rm(path.join(root, "sapling.zip"));
  await assert.rejects(generateAsset(specPath));
  assert.deepEqual(await readFile(outputPath), accepted);
  assert.equal((await stat(outputPath)).mtimeMs, before.mtimeMs);
  await writeFile(path.join(root, "sapling.zip"), archiveBytes);
  await writeFile(specPath, JSON.stringify(spec({ ...TREE_PRESETS.broadleaf, maxTriangles: 128 })));
  await assert.rejects(generateAsset(specPath), /maxTriangles/);
  const direct = spec();
  direct.parameters.arguments = { ...TREE_PRESETS.broadleaf, undeclared: true };
  await writeFile(specPath, JSON.stringify(direct));
  await assert.rejects(generateAsset(specPath), /complete declared controls/);
  assert.deepEqual(await readFile(outputPath), accepted);
});
