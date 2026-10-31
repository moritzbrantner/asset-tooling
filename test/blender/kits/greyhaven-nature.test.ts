import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { getBounds } from "@gltf-transform/functions";
import { readAssetBundleAttachment, readAssetBundleGltf, verifyAssetBundle, type GltfResourcesBundleManifest } from "../../../src/asset-bundle.js";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { sha256Bytes } from "../../../src/hash.js";
import {
  buildGreyhavenNature, NATURE_COLLISION_PROXY, NATURE_DESCRIPTOR_ATTACHMENT, NATURE_DESCRIPTOR_SCHEMA, NATURE_LOD_SCREEN_SIZES, NATURE_LOD_VARIANTS,
  BUSH_TRIANGLES, NATURE_LODS, NATURE_MEMBERS, ROCK_TRIANGLES,
} from "../../../scripts/build-greyhaven-nature.ts";

type Provenance = { license: string; source?: { sha256: string }; crown?: { observations: { recipe: string }; inputs?: Record<string, unknown> }; authored?: { observations: { recipe: string } } };

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const storage: { entries: { sourceId: string; path: string }[] } = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const nature = storage.entries.filter((entry) => entry.sourceId.startsWith("quaternius.stylized-nature-megakit-standard."));
const pointers = [];
for (const entry of nature) {
  if ((await readFile(path.join(root, entry.path))).subarray(0, 64).toString().startsWith("version https://git-lfs.github.com/spec/v1")) pointers.push(entry.path);
}
const skip = !process.env.ASSET_TOOLING_BLENDER ? "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)"
  : pointers.length ? "requires hydrated canonical nature payloads (git lfs pull)" : false;

test("nature bundle supplies independently shaped, grounded families with game-resolution textures and provenance", {
  skip, timeout: 900_000,
}, async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "greyhaven-nature-"));
  try {
    const built = await buildGreyhavenNature(out);
    const verified = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: "gltf-resources-v1" });
    const manifest = verified.manifest as GltfResourcesBundleManifest;
    await verifyAssetBundleTar(await readFile(built.tar), { ref: built.exportRef });
    assert.deepEqual(manifest.assets.map((item) => `${item.key}/${item.variant}`).sort(),
      NATURE_MEMBERS.flatMap((item) => ["default", ...NATURE_LOD_VARIANTS].map((variant) => `${item.key}/${variant}`)).sort());
    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "greyhaven.nature.tree.broadleaf", "default", NATURE_DESCRIPTOR_ATTACHMENT)).toString());
    assert.equal(descriptor.schema, NATURE_DESCRIPTOR_SCHEMA);
    assert.equal(descriptor.units, "metre");
    const rockShapes = new Set<string>();
    const io = new NodeIO();
    for (const entry of NATURE_MEMBERS) {
      const item = await readAssetBundleGltf(built.bundleDir, manifest, entry.key, "default");
      const document = await io.readJSON({ json: JSON.parse(item.gltf.toString()), resources: Object.fromEntries(item.resources) });
      const scene = document.getRoot().getDefaultScene();
      assert.ok(scene);
      const bounds = getBounds(scene);
      assert.ok(Math.abs(bounds.min[1]) < 1e-5, `${entry.key}: base on ground`);
      for (const axis of [0, 2] as const) assert.ok(Math.abs(bounds.max[axis] + bounds.min[axis]) < 1e-5, `${entry.key}: centred footprint`);
      assert.ok(document.getRoot().listTextures().length > 0);
      for (const image of document.getRoot().listTextures()) {
        const size = image.getSize();
        assert.ok(size && Math.max(...size) <= 1024, `${entry.key}: game texture resolution`);
      }
      const metadata = descriptor.assets.find((item: { key: string }) => item.key === entry.key);
      const provenance: Provenance = metadata.provenance;
      assert.equal(provenance.license, "CC0-1.0");
      // #449: an LOD chain in the same frame, triangles falling by level, screen-size switch points in the descriptor.
      const lods = metadata[NATURE_LODS];
      assert.deepEqual(lods.levels.map((level: { variant: string }) => level.variant), ["default", ...NATURE_LOD_VARIANTS]);
      assert.deepEqual(lods.levels.map((level: { minScreenSize: number }) => level.minScreenSize), [...NATURE_LOD_SCREEN_SIZES[entry.family], 0]);
      assert.ok(lods.boundingSphere.radius > 0);
      const trianglesIn = (doc: typeof document) => doc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())
        .reduce((sum, primitive) => sum + primitive.getIndices()!.getCount() / 3, 0);
      const lod0Triangles = trianglesIn(document);
      assert.equal(lods.levels[0].triangles, lod0Triangles);
      for (const [index, variant] of NATURE_LOD_VARIANTS.entries()) {
        const level = await readAssetBundleGltf(built.bundleDir, manifest, entry.key, variant);
        const lod = await io.readJSON({ json: JSON.parse(level.gltf.toString()), resources: Object.fromEntries(level.resources) });
        const lodBounds = getBounds(lod.getRoot().getDefaultScene()!);
        for (const axis of [0, 1, 2] as const) {
          assert.ok(Math.abs(lodBounds.max[axis] - bounds.max[axis]) < 0.6 && Math.abs(lodBounds.min[axis] - bounds.min[axis]) < 0.6,
            `${entry.key}/${variant}: in LOD0's frame, at LOD0's size`);
        }
        const triangles = trianglesIn(lod);
        assert.equal(lods.levels[index + 1].triangles, triangles);
        const share = triangles / lod0Triangles;
        // A bush keeps its whole small core at lod1, so its shares are higher; its absolute budget is far lower.
        const [lod1Share, lod2Share] = entry.family === "bush" ? [0.6, 0.25] : [0.45, 0.12];
        assert.ok(index === 0 ? share >= 0.25 && share <= lod1Share : share <= lod2Share, `${entry.key}/${variant}: ${triangles} triangles (${share.toFixed(2)} of LOD0)`);
        if (entry.family === "rock") {
          for (const texture of lod.getRoot().listTextures()) assert.ok(Math.max(...texture.getSize()!) <= 512 / 2 ** index, `${entry.key}/${variant}: smaller baked maps`);
        }
        if (entry.family === "bush" && index === 1) {
          const names = lod.getRoot().listMaterials().map((material) => material.getName());
          assert.deepEqual(names, ["Leaves_Core"], `${entry.key}/lod2: an opaque vertex-coloured hull, no cards`);
        }
        if (entry.family === "tree" && index === 1) {
          const names = lod.getRoot().listMaterials().map((material) => material.getName()).sort();
          assert.deepEqual(names, ["Bark_NormalTree", "Leaves_Core"], `${entry.key}/lod2: an opaque vertex-coloured crown shell, no cards`);
        }
      }
      if (entry.family === "rock") {
        // #451: an authored rock with one baked PBR material within the rock budget, and a convex-hull collision proxy.
        const primitives = document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives());
        assert.equal(primitives.length, 1);
        const material = primitives[0]!.getMaterial()!;
        assert.ok(material.getBaseColorTexture() && material.getNormalTexture() && material.getMetallicRoughnessTexture(), `${entry.key}: baked PBR maps`);
        const triangles = primitives[0]!.getIndices()!.getCount() / 3;
        assert.ok(triangles <= ROCK_TRIANGLES * 1.05, `${entry.key}: ${triangles} triangles within the rock budget`);
        const vertices = primitives[0]!.getAttribute("POSITION")!.getArray()!;
        rockShapes.add(sha256Bytes(Buffer.from(vertices.buffer, vertices.byteOffset, vertices.byteLength)));
        assert.equal(provenance.authored?.observations.recipe, "nature-rock-v1");
        const proxy: { shape: string; vertices: number[][]; triangles: number[][] } = metadata[NATURE_COLLISION_PROXY];
        assert.equal(proxy.shape, "convex-hull");
        assert.ok(proxy.vertices.length >= 8 && proxy.triangles.length <= 92, `${entry.key}: a low-face hull`);
        assert.equal(proxy.vertices.length - proxy.triangles.length / 2, 2, `${entry.key}: a closed triangulated hull (V - E + F = 2)`);
        for (const vertex of proxy.vertices) {
          for (const axis of [0, 1, 2] as const) {
            assert.ok(vertex[axis]! >= bounds.min[axis] - 1e-3 && vertex[axis]! <= bounds.max[axis] + 1e-3, `${entry.key}: hull inside the mesh bounds`);
          }
        }
      } else if (entry.family === "bush") {
        // #462: an authored bush of leaf cards (alpha MASK) over a dark core, both vertex-coloured, within the bush budget.
        const primitives = document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives());
        assert.deepEqual(primitives.map((primitive) => primitive.getMaterial()?.getName()).sort(), ["Leaves_Bush", "Leaves_Core"]);
        for (const primitive of primitives) assert.ok(primitive.getAttribute("COLOR_0"), "bush colour variation is COLOR_0");
        const cards = primitives.find((primitive) => primitive.getMaterial()?.getName() === "Leaves_Bush")!;
        assert.equal(cards.getMaterial()!.getAlphaMode(), "MASK");
        assert.ok(lod0Triangles <= BUSH_TRIANGLES, `${entry.key}: ${lod0Triangles} triangles within the bush budget`);
        assert.equal(provenance.authored?.observations.recipe, "nature-bush-v1");
      } else {
        assert.match(provenance.source?.sha256 ?? "", /^[0-9a-f]{64}$/);
      }
      if (entry.shape === "broadleaf") {
        // #446: the source bark stays; the leaves are the rebuilt, vertex-coloured crown within a foreground budget.
        const primitives = document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives());
        const names = primitives.map((primitive) => primitive.getMaterial()?.getName()).sort();
        assert.deepEqual(names, ["Bark_NormalTree", "Leaves_Core", "Leaves_NormalTree"]);
        for (const primitive of primitives) assert.ok(primitive.getAttribute("COLOR_0"), "crown colour variation is COLOR_0");
        const leaves = primitives.find((primitive) => primitive.getMaterial()?.getName() === "Leaves_NormalTree")!;
        assert.equal(leaves.getMaterial()!.getAlphaMode(), "MASK");
        const triangles = primitives.reduce((sum, primitive) => sum + primitive.getIndices()!.getCount() / 3, 0);
        assert.ok(triangles <= 8000, `broadleaf triangles ${triangles} within the foreground budget`);
        assert.equal(provenance.crown?.observations.recipe, "broadleaf-crown-v1");
      }
      if (entry.shape === "conifer") {
        // #450/#454: Pine_1's trunk stays; solid fir tiers (sprig cards over opaque skirts) replace its leaves, within the same budget.
        const primitives = document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives());
        const names = primitives.map((primitive) => primitive.getMaterial()?.getName()).sort();
        assert.deepEqual(names, ["Bark_NormalTree", "Leaves_Core", "Leaves_Pine"]);
        for (const primitive of primitives) assert.ok(primitive.getAttribute("COLOR_0"), "crown colour variation is COLOR_0");
        const needles = primitives.find((primitive) => primitive.getMaterial()?.getName() === "Leaves_Pine")!;
        assert.equal(needles.getMaterial()!.getAlphaMode(), "MASK");
        const triangles = primitives.reduce((sum, primitive) => sum + primitive.getIndices()!.getCount() / 3, 0);
        assert.ok(triangles <= 8000, `conifer triangles ${triangles} within the foreground budget`);
        assert.equal(provenance.crown?.observations.recipe, "conifer-crown-v2");
        assert.deepEqual(Object.keys(provenance.crown?.inputs ?? {}).sort(), ["needleAlpha", "needles"]);
      }
    }
    assert.equal(rockShapes.size, 3, "rock variants have distinct vertex geometry");
  } finally { await rm(out, { recursive: true, force: true }); }
});
