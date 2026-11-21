// Textured hair kit (#557, docs/textured-hair-kit.md). The recipe grows six hairstyles (seven entries: the box braids
// loose and tied back) on the male and female heads. The test checks the verified gltf-resources-v1 bundle:
//   - one entry per piece, a `male` and a `female` variant each;
//   - every piece is skinned to a Head joint at its fit's rest pose, with the chains it declares;
//   - the caps stay on the head: nothing of them hangs below the ears;
//   - two materials at most (the tinted atlas and the leather tie), every texture KTX2, within the release budget;
//   - a second build gives the same tar.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2, `ktx` is available and the Universal Base
// Characters bodies are hydrated.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  TEXTURED_HAIR_DESCRIPTOR_ATTACHMENT, TEXTURED_HAIR_DESCRIPTOR_SCHEMA, TEXTURED_HAIR_FITS, TEXTURED_HAIR_MATERIAL, TEXTURED_HAIR_PIECES, TEXTURED_HAIR_RELEASE,
  TEXTURED_HAIR_TAR_NAME, TEXTURED_HAIR_VARIANTS, TEXTURED_HAIR_YOUNG, buildTexturedHairKit, createTexturedHairSpec, texturedHairChains, texturedHairHeadRest,
} from "../../../scripts/build-textured-hair-kit.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";
import { ROLLING_RELEASES } from "../../../scripts/publish-release.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const lfsPointer = async (file: string) => (await readFile(path.join(root, file))).subarray(0, 64).toString().startsWith("version https://git-lfs");
const bodies = Object.values(TEXTURED_HAIR_FITS).flatMap(({ body }) => ["gltf", "bin"].map((ext) =>
  `assets/canonical/quaternius.universal-base-characters-standard.${body.toLowerCase().replace(/_/g, "-")}-${ext}/${body}.${ext}`));
const hydrated = !(await Promise.all(bodies.map(lfsPointer))).some(Boolean);
const ktx = !!Bun.which(process.env.ASSET_TOOLING_KTX ?? "ktx");
const skip = !process.env.ASSET_TOOLING_BLENDER ? "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)"
  : !ktx ? "requires KTX-Software's ktx CLI (ASSET_TOOLING_KTX or ktx on PATH)"
  : !hydrated ? "requires the hydrated Universal Base Characters bodies (git lfs pull)" : false;
const CAPS = new Set(["hair.short-coils", "hair.rounded-afro", "hair.cornrows", "hair.curly-bun"]);

test("the spec runs the packaged recipe on one head, with its body and buffer", () => {
  const spec = createTexturedHairSpec({ fit: "female", scriptSha256: "a".repeat(64), gltfSha256: "b".repeat(64), bufferSha256: "c".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, fit: "female" } });
  assert.equal(spec.assetId, "textured-hair.kit.female");
  assert.deepEqual(Object.keys(spec.inputs).sort(), ["body", "buffer", "script"]);
  assert.equal(TEXTURED_HAIR_RELEASE, "textured-hair-kit", "one rolling release, never numbered");
  assert.equal(TEXTURED_HAIR_TAR_NAME, "textured-hair.kit.tar");
  assert.ok(ROLLING_RELEASES.some((r) => r.name === TEXTURED_HAIR_RELEASE && r.script === "scripts/build-textured-hair-kit.ts" && r.blender && r.lfs && r.ktx));
  for (const bodyFile of bodies) assert.ok(bodyFile.includes("superhero-"), bodyFile);
});

test("every young resident wears a fitted head's pieces at its own head scale", () => {
  for (const [figure, { fit, scale }] of Object.entries(TEXTURED_HAIR_YOUNG)) {
    assert.ok(TEXTURED_HAIR_VARIANTS.includes(fit), figure);
    assert.ok(scale > .8 && scale < 1, `${figure} scale ${scale}`);
  }
});

test("the loose and tied braids and the curls swing on chains below Head; the caps have none", () => {
  const landmarks = { earTop: 1.715, earBottom: 1.668 };
  assert.deepEqual(texturedHairChains("hair.box-braids", landmarks).map((chain) => chain.direction), [180, 90, 270]);
  assert.equal(texturedHairChains("hair.box-braids-tied", landmarks, [0, 1.67, -.11])[0]!.prefix, "hair_tail");
  assert.equal(texturedHairChains("hair.loose-curls", landmarks).length, 1);
  for (const id of CAPS) assert.deepEqual(texturedHairChains(id, landmarks), []);
  for (const { id } of TEXTURED_HAIR_PIECES) for (const chain of texturedHairChains(id, landmarks, [0, 1.67, -.11])) assert.equal(chain.parent, "Head");
});

test("the head rest of each fit is the inverse of its head.hair socket", async () => {
  for (const fit of TEXTURED_HAIR_VARIANTS) {
    const head = await texturedHairHeadRest(fit);
    assert.ok(head.translation[1] > 1.5 && head.translation[1] < 1.65, `${fit} head height ${head.translation[1]}`);
  }
});

test("the recipe builds a verified, reproducible kit of hairstyles on both heads", { skip, timeout: 1_200_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "textured-hair-"));
  const rebuildDir = await mkdtemp(path.join(os.tmpdir(), "textured-hair-rebuild-"));
  try {
    const built = await buildTexturedHairKit({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const ids = TEXTURED_HAIR_PIECES.map(({ id }) => id);
    assert.deepEqual([...new Set(manifest.assets.map((entry) => entry.key))].sort(), [...ids].sort());
    for (const id of ids) assert.deepEqual(manifest.assets.filter((entry) => entry.key === id).map((entry) => entry.variant).sort(), [...TEXTURED_HAIR_VARIANTS].sort());

    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, ids[0]!, "male", TEXTURED_HAIR_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(descriptor.schema, TEXTURED_HAIR_DESCRIPTOR_SCHEMA);
    assert.deepEqual(descriptor.hair.map((record: { id: string }) => record.id), ids);
    for (const record of descriptor.hair) {
      assert.deepEqual(record.tintMaterials, [TEXTURED_HAIR_MATERIAL], record.id);
      assert.deepEqual(record.fixedMaterials, ["hair.box-braids-tied", "hair.curly-bun"].includes(record.id) ? ["hair.tie"] : [], record.id);
      for (const fit of TEXTURED_HAIR_VARIANTS) assert.ok(record.triangles[fit] >= 800 && record.triangles[fit] <= 5200, `${record.id}/${fit}: ${record.triangles[fit]} triangles`);
    }

    for (const fit of TEXTURED_HAIR_VARIANTS) {
      const head = await texturedHairHeadRest(fit);
      const earBottom = descriptor.fits[fit].landmarks.earBottom as number;
      for (const id of ids) {
        const document = built.documents.get((built.lineage.parts as Record<string, { sha256: string }>)[`${id}/${fit}`]!.sha256)!;
        const rootNode = document.getRoot();
        const joint = rootNode.listNodes().find((node) => node.getName() === "Head")!;
        assert.ok(joint.getTranslation().every((value, index) => Math.abs(value - head.translation[index]!) < 1e-5), `${id}/${fit}: Head at the rest pose`);
        const mesh = rootNode.listNodes().find((node) => node.getName() === id)!;
        const chains = texturedHairChains(id, { earTop: 0, earBottom: 0 }, [0, 0, 0]).map((chain) => chain.prefix);
        const joints = mesh.getSkin()!.listJoints().map((node) => node.getName());
        assert.equal(joints[0], "Head");
        for (const prefix of chains) assert.ok(joints.some((name) => name.startsWith(`${prefix}_`)), `${id}/${fit}: chain ${prefix}`);
        for (const texture of rootNode.listTextures()) assert.equal(texture.getMimeType(), "image/ktx2", `${id}/${fit}`);
        if (CAPS.has(id) && id !== "hair.cornrows") {
          let low = Infinity;
          for (const primitive of mesh.getMesh()!.listPrimitives()) {
            const position = primitive.getAttribute("POSITION")!;
            for (let index = 0; index < position.getCount(); index += 1) low = Math.min(low, position.getElement(index, [0, 0, 0])[1]!);
          }
          assert.ok(low > earBottom - .045, `${id}/${fit}: the cap reaches ${low}, below the nape`);
        }
      }
    }

    const cost = await kitCost(built.bundleDir);
    assert.ok(cost.materials.length <= 2, cost.materials.join(", "));
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[TEXTURED_HAIR_RELEASE]!), []);

    const rebuilt = await buildTexturedHairKit({ outDir: rebuildDir });
    assert.equal(rebuilt.tarSha256, built.tarSha256, "two builds are byte-identical");
  } finally {
    await Promise.all([rm(outDir, { recursive: true, force: true }), rm(rebuildDir, { recursive: true, force: true })]);
  }
});
