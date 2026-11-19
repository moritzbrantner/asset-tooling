// Greyhaven discoveries (docs/discoveries.md, #764): the recipe builds a verified gltf-resources-v1 bundle of three discovery
// sites' pieces on one atlas, each with LODs that at least halve, collision proxies or a declared absence, its open/closed
// and lit/unlit states in a shared frame, and the sites' compositions. The build skips unless ASSET_TOOLING_BLENDER names
// Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  DISCOVERY_CLUES, DISCOVERY_DESCRIPTOR_ATTACHMENT, DISCOVERY_LOD_DISTANCES, DISCOVERY_MATERIAL, DISCOVERY_PIECES, DISCOVERY_RELEASE,
  DISCOVERY_SITES, DISCOVERY_TRIANGLE_BUDGET, DISCOVERY_VARIANTS, buildDiscoveries, createDiscoverySpec, discoveryKey,
} from "../../../scripts/build-discoveries.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { scaledLodDistances } from "../../../src/kit-bundle.js";

test("the discoveries spec runs the packaged recipe for exactly one piece and level", () => {
  const spec = createDiscoverySpec({ piece: "signal-brazier-lit", level: 1, scriptSha256: "a".repeat(64), commonSha256: "b".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, piece: "signal-brazier-lit", level: 1 } });
  assert.equal(spec.assetId, "discoveries.kit.signal-brazier-lit");
  assert.equal(DISCOVERY_RELEASE, "discoveries", "one rolling release, never numbered");
});

test("the recipe builds a verified kit on one atlas within its limits, with states, collision and sites", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_800_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "discoveries-"));
  try {
    const built = await buildDiscoveries({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort(),
      DISCOVERY_PIECES.flatMap((piece) => DISCOVERY_VARIANTS.map((variant) => `${discoveryKey(piece)}#${variant}`)).sort());

    // One opaque material on one atlas of colour, normal, ORM and emission, stored once as KTX2, inside the cost limit.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 4);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, [DISCOVERY_MATERIAL]);
    assert.equal(cost.maxima.drawCalls, 1);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[DISCOVERY_RELEASE]!), []);

    // mmorpg's lit material reads tangents and COLOR_0: every primitive carries both.
    for (const [piece, document] of Object.entries(built.documents)) {
      for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
        assert.ok(primitive.getAttribute("TANGENT"), `${piece} has tangents`);
        assert.ok(primitive.getAttribute("COLOR_0"), `${piece} has COLOR_0`);
      }
    }

    const first = discoveryKey(DISCOVERY_PIECES[0]);
    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, first, "default", DISCOVERY_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.assets.length, DISCOVERY_PIECES.length);
    const tan = Math.tan(30 * Math.PI / 180);
    for (const asset of descriptor.assets) {
      const [lod0, lod1, lod2] = asset.lods.levels;
      assert.ok(lod0.triangles <= DISCOVERY_TRIANGLE_BUDGET, `${asset.key}: ${lod0.triangles} triangles`);
      assert.ok(lod1.triangles * 2 <= lod0.triangles, `${asset.key}: lod1 ${lod1.triangles} is at most half of ${lod0.triangles}`);
      assert.ok(lod2.triangles * 2 <= lod1.triangles, `${asset.key}: lod2 ${lod2.triangles} is at most half of ${lod1.triangles}`);
      const distances = scaledLodDistances(DISCOVERY_LOD_DISTANCES, asset.bounds);
      assert.deepEqual(asset.lods.levels.map((level: any) => level.referenceMaxDistance), [...distances, null]);
      const lod1End = asset.lods.boundingSphere.radius / (lod1.minScreenSize * tan);
      assert.ok(Math.abs(lod1End / distances[1]! - 1) < 0.02, `${asset.key}: lod1 ends about ${distances[1]} m away, not ${lod1End}`);
      // Structures carry boxes inside their bounds; dressing declares none.
      if (asset.kind === "structure") {
        assert.ok(asset.collisionProxies.length > 0, `${asset.key} has proxies`);
        for (const box of asset.collisionProxies) for (let k = 0; k < 3; k++) {
          assert.ok(box.size[k] > 0, `${asset.key} ${box.name} has a size`);
          assert.ok(box.center[k] - box.size[k] / 2 >= asset.bounds.min[k] - 0.15 && box.center[k] + box.size[k] / 2 <= asset.bounds.max[k] + 0.15, `${asset.key} ${box.name} lies in the piece`);
        }
      } else {
        assert.equal(asset.collision, "none", `${asset.key} is walk-through dressing`);
      }
    }
    const byRole = Object.fromEntries(descriptor.assets.map((asset: any) => [asset.role, asset]));
    // Each two-state object shares its frame and its collision.
    for (const [closed, open, node, states] of [["hunter-chest", "hunter-chest-open", "hunter-chest", ["closed", "open"]],
      ["signal-brazier", "signal-brazier-lit", "signal-brazier", ["unlit", "lit"]], ["supply-crates", "supply-crates-open", "supply-crates", ["closed", "open"]]] as const) {
      assert.deepEqual([byRole[closed].node, byRole[closed].state, byRole[open].node, byRole[open].state], [node, states[0], node, states[1]]);
      assert.deepEqual(byRole[closed].collisionProxies, byRole[open].collisionProxies, `${node}: both states collide alike`);
    }
    assert.ok(byRole["signal-brazier-lit"].light && !byRole["signal-brazier"].light, "only the lit brazier names a light");
    assert.equal(byRole["lookout-platform"].collisionProxies.find((box: any) => box.tag === "walkable").name, "deck");
    assert.ok(byRole["fen-punt"].draft > 0, "the punt rides low in the water");
    // Every site lists only kit pieces, and its clue is among them.
    assert.deepEqual(Object.keys(descriptor.sites).sort(), [...DISCOVERY_SITES].sort());
    for (const site of DISCOVERY_SITES) {
      const keys = descriptor.sites[site].items.map((item: any) => item.key);
      assert.ok(keys.includes(discoveryKey(DISCOVERY_CLUES[site])), `${site} shows its clue`);
      for (const key of keys) assert.ok(byRole[key.slice("discoveries.kit.".length)], `${site}: ${key} is a kit piece`);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
