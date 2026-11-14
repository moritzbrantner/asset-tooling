// Redbrand faction kit (#517, docs/redbrand-kit.md). The authored garments and plates are skinned to the male Ranger
// rig. The test checks the verified gltf-resources-v1 bundle:
//   - two complete figures (Dark `default`, `skin.light`) and the socketed plates;
//   - every texture KTX2;
//   - each figure keeps the Ranger's joints, skins, face and age/build morph targets and the coat and scarf chains;
//   - the descriptor's outfit record is in the Ranger's humanoid-appearance shape;
//   - a second build gives the same tar.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2, `ktx` is available and the .blend and the
// Quaternius character packs are hydrated.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { slotKtx2Encoding } from "../../../src/ktx2-encodings.js";
import { RANGER_FIGURES, RANGER_PEASANT_OUTFITS } from "../../../src/ranger-figure.js";
import {
  REDBRAND_ARMOR_KEY, REDBRAND_DESCRIPTOR_ATTACHMENT, REDBRAND_DESCRIPTOR_SCHEMA, REDBRAND_GEOMETRY, REDBRAND_OUTFIT_ID, REDBRAND_OUTFIT_KEY,
  REDBRAND_RELEASE, REDBRAND_SKINS, REDBRAND_TAR_NAME, buildRedbrandKit, createRedbrandAssetSpec,
} from "../../../scripts/build-redbrand-kit.ts";
import { ROLLING_RELEASES } from "../../../scripts/publish-release.ts";
import { BLENDER_SUITES } from "../../../scripts/ci-plan.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const lfsPointer = async (file: string) => (await readFile(path.join(root, file))).subarray(0, 64).toString().startsWith("version https://git-lfs");
const storage = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const packs = storage.entries.filter((entry: any) => /quaternius\.(universal-base-characters|modular-character-outfits-fantasy)-standard\./.test(entry.path));
const hydrated = !(await lfsPointer(REDBRAND_GEOMETRY)) && !(await Promise.all(packs.map((entry: any) => lfsPointer(entry.path)))).some(Boolean);
const ktx = !!Bun.which(process.env.ASSET_TOOLING_KTX ?? "ktx");
const skip = !process.env.ASSET_TOOLING_BLENDER ? "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)"
  : !ktx ? "requires KTX-Software's ktx CLI (ASSET_TOOLING_KTX or ktx on PATH)"
  : !hydrated ? "requires the hydrated redbrand-kit.blend and Quaternius character packs (git lfs pull)" : false;

test("the redbrand spec runs the packaged recipe on one output, from the authored .blend, armor.py and the fit target", () => {
  const spec = createRedbrandAssetSpec({ output: "cloth", scriptSha256: "a".repeat(64), armorSha256: "b".repeat(64), kitSha256: "c".repeat(64), targetSha256: "d".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, output: "cloth" } });
  assert.equal(spec.assetId, "redbrand.kit.cloth");
  assert.deepEqual(Object.keys(spec.inputs).sort(), ["armor", "kit", "script", "target"]);
  assert.equal(REDBRAND_RELEASE, "redbrand-kit", "one rolling release, never numbered");
  assert.equal(REDBRAND_TAR_NAME, "redbrand.kit.tar");
  assert.ok(ROLLING_RELEASES.some((r) => r.name === REDBRAND_RELEASE && r.script === "scripts/build-redbrand-kit.ts" && r.blender && r.lfs && r.ktx));
  assert.ok(BLENDER_SUITES.some((s) => s.suite === "redbrand" && s.ktx && s.lfs.includes("assets/authored/redbrand-kit.blend")));
  assert.equal(slotKtx2Encoding(new Set(["baseColorTexture"])), "uastc-srgb");
  assert.equal(slotKtx2Encoding(new Set(["normalTexture"])), "uastc");
  assert.equal(slotKtx2Encoding(new Set(["occlusionTexture", "metallicRoughnessTexture"])), "etc1s-linear");
  assert.ok(RANGER_PEASANT_OUTFITS.male && RANGER_FIGURES.male.key === "humanoid.ranger.male");
});

test("the redbrand recipe builds two complete KTX2 figures on the Ranger rig and the socketed plates, reproducibly", { skip, timeout: 3_600_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "redbrand-kit-"));
  const again = await mkdtemp(path.join(os.tmpdir(), "redbrand-kit-"));
  try {
    const built = await buildRedbrandKit({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}/${entry.variant}`).sort(),
      [...REDBRAND_SKINS.map((skin) => `${REDBRAND_OUTFIT_KEY}/${skin.variant}`), `${REDBRAND_ARMOR_KEY}/default`].sort());
    const images = manifest.assets.flatMap((entry) => entry.resources).filter((r) => r.mediaType.startsWith("image/"));
    assert.ok(images.length > 0 && images.every((r) => r.mediaType === "image/ktx2"), "every texture is KTX2");

    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, REDBRAND_OUTFIT_KEY, "default", REDBRAND_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.schema, REDBRAND_DESCRIPTOR_SCHEMA);
    assert.equal(d.figure, "humanoid.ranger.male");
    const [outfit] = d.outfits;
    assert.equal(outfit.id, REDBRAND_OUTFIT_ID);
    assert.deepEqual(outfit.skins, [{ id: "skin.dark", entry: REDBRAND_OUTFIT_KEY, variant: "default" }, { id: "skin.light", entry: REDBRAND_OUTFIT_KEY, variant: "skin.light" }]);
    assert.deepEqual(outfit.base, { outfit: "Male_Peasant", hidden: ["Male_Peasant_Body", "Male_Peasant_Legs"] });
    assert.deepEqual(outfit.armor.pieces.map((p: any) => `${p.node}@${p.socket}`), ["redbrand.belt@pelvis.armor", "redbrand.bracer_l@lowerarm_l.armor", "redbrand.bracer_r@lowerarm_r.armor"]);
    assert.deepEqual(outfit.garments.map((g: any) => g.id).sort(), ["redbrand.coat", "redbrand.scarf", "redbrand.scarf-end", "redbrand.sleeves", "redbrand.trousers"]);
    assert.ok(outfit.secondary.some((chain: any) => chain.id === "scarf"), "the scarf-end chain");
    assert.deepEqual(outfit.faction.materials, ["faction"]);

    const [dark, light, plates] = built.documents;
    for (const document of [dark!, light!]) {
      const nodes = document.getRoot().listNodes().map((node) => node.getName());
      for (const node of ["redbrand.coat", "redbrand.coat-skirt", "redbrand.trousers", "redbrand.scarf-end", "SuperHero_Male", "Male_Peasant_Arms", "Male_Peasant_Feet"]) assert.ok(nodes.includes(node), node);
      for (const node of outfit.base.hidden) assert.ok(!nodes.includes(node), `${node} is hidden`);
      assert.equal(document.getRoot().listSkins().length > 0, true);
      assert.equal(document.getRoot().listAnimations().length, 0, "the figures play the Ranger default's clips");
      // The Ranger rig plus the chain joints.
      const joints = document.getRoot().listSkins().map((skin) => skin.listJoints().length);
      assert.equal(Math.min(...joints), d.rig.jointCount);
      assert.ok(Math.max(...joints) > d.rig.jointCount);
      for (const chain of ["skirt_f_01", "scarf_01"]) assert.ok(document.getRoot().listNodes().some((node) => node.getName() === chain), chain);
      for (const name of [...d.morphs.face.nodes.slice(0, 1), "redbrand.coat"]) {
        const mesh = document.getRoot().listNodes().find((node) => node.getName() === name)!.getMesh()!;
        assert.ok(mesh.listPrimitives().every((p) => p.listTargets().length > 0), `${name} carries morph targets`);
      }
      for (const material of document.getRoot().listMaterials()) {
        for (const texture of [material.getBaseColorTexture(), material.getNormalTexture(), material.getMetallicRoughnessTexture(), material.getOcclusionTexture()]) {
          if (texture) assert.equal(texture.getMimeType(), "image/ktx2", material.getName());
        }
      }
      assert.ok(document.getRoot().listMaterials().some((material) => material.getName() === "faction"));
    }
    assert.deepEqual(plates!.getRoot().listNodes().filter((node) => node.getMesh()).map((node) => node.getName()).sort(), ["redbrand.belt", "redbrand.bracer_l", "redbrand.bracer_r"]);
    assert.ok(plates!.getRoot().listMaterials().every((material) => material.getOcclusionTexture()?.getMimeType() === "image/ktx2"));

    const rebuilt = await buildRedbrandKit({ outDir: again });
    assert.equal(rebuilt.tarSha256, built.tarSha256, "two builds give the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(again, { recursive: true, force: true });
  }
});
