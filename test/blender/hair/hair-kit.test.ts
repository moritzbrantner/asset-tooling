// Hair and beard kit (#517, docs/hair-kit.md). The authored hairstyles and beards and the pack hairstyles are skinned to
// the Ranger's `Head` joint. The test checks the verified gltf-resources-v1 bundle:
//   - one entry per piece (the pack hairstyles' hair-1 and hair-2 variants, the hand-modelled pieces once each);
//   - every texture KTX2;
//   - every piece has a Head joint at the rest pose, the chain joints the Ranger gives it, and its build keys
//     (beards also age keys);
//   - the descriptor lists pieces, sockets, joints, tint materials and what they hide;
//   - a second build gives the same tar.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2, `ktx` is available and the .blend and the
// Quaternius character packs are hydrated.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Document } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import { addSecondaryChains } from "../../../src/humanoid-secondary.js";
import { VARIETY_BEARDS, VARIETY_HAIRSTYLES } from "../../../src/male-variety.js";
import {
  BEARD_SOCKET, BEARD_VARIANT, HAIR_AUTHORED_VARIANT, HAIR_DESCRIPTOR_ATTACHMENT, HAIR_DESCRIPTOR_SCHEMA, HAIR_GEOMETRY, HAIR_HEAD_JOINT, HAIR_PACK_STYLES, HAIR_PACK_VARIANTS,
  HAIR_RELEASE, HAIR_SOCKET, HAIR_TAR_NAME, bindToHead, buildHairKit, chainsFor, createHairKitAssetSpec, headRest,
} from "../../../scripts/build-hair-kit.ts";
import { ROLLING_RELEASES } from "../../../scripts/publish-release.ts";
import { BLENDER_SUITES } from "../../../scripts/ci-plan.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const lfsPointer = async (file: string) => (await readFile(path.join(root, file))).subarray(0, 64).toString().startsWith("version https://git-lfs");
const storage = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const packs = storage.entries.filter((entry: any) => /quaternius\.(universal-base-characters|modular-character-outfits-fantasy)-standard\./.test(entry.path));
const hydrated = !(await lfsPointer(HAIR_GEOMETRY)) && !(await Promise.all(packs.map((entry: any) => lfsPointer(entry.path)))).some(Boolean);
const ktx = !!Bun.which(process.env.ASSET_TOOLING_KTX ?? "ktx");
const skip = !process.env.ASSET_TOOLING_BLENDER ? "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)"
  : !ktx ? "requires KTX-Software's ktx CLI (ASSET_TOOLING_KTX or ktx on PATH)"
  : !hydrated ? "requires the hydrated hair-kit.blend and Quaternius character packs (git lfs pull)" : false;

const PACK_KEYS = HAIR_PACK_STYLES.map(({ key }) => key);
const BEARDS = Object.keys(VARIETY_BEARDS);

test("the hair kit spec runs the packaged recipe on one output, from the authored .blend and the pack material", () => {
  const spec = createHairKitAssetSpec({ output: "beards", scriptSha256: "a".repeat(64), kitSha256: "b".repeat(64), materialSha256: "c".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, output: "beards" } });
  assert.equal(spec.assetId, "hair.kit.beards");
  assert.deepEqual(Object.keys(spec.inputs).sort(), ["kit", "material", "script"]);
  assert.equal(HAIR_RELEASE, "hair-kit", "one rolling release, never numbered");
  assert.equal(HAIR_TAR_NAME, "hair.kit.tar");
  assert.ok(ROLLING_RELEASES.some((r) => r.name === HAIR_RELEASE && r.script === "scripts/build-hair-kit.ts" && r.blender && r.lfs && r.ktx));
  assert.ok(BLENDER_SUITES.some((s) => s.suite === "hair" && s.ktx && s.lfs.includes(HAIR_GEOMETRY)));
  assert.deepEqual(PACK_KEYS, ["hair.buzzed", "hair.simple-parted", "hair.long"]);
});

test("the head skin lands the piece's Head joint on the figure's through the socket", async () => {
  const head = await headRest();
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([0, 1.7, 0, 0.1, 1.7, 0, 0, 1.6, -0.1]));
  const primitive = document.createPrimitive().setAttribute("POSITION", position);
  const node = document.createNode("hair.tied").setMesh(document.createMesh("hair.tied").addPrimitive(primitive));
  document.createScene("scene").addChild(node);
  bindToHead(document, head);
  const skin = node.getSkin()!;
  assert.equal(skin.listJoints()[0]!.getName(), HAIR_HEAD_JOINT);
  // Socket x Head rest = identity, so the head joint rides the figure's Head exactly.
  const worldZero = skin.getInverseBindMatrices()!.getElement(0, []);
  assert.deepEqual(worldZero.map((value) => Math.round(value * 1e4) / 1e4), head.bindMatrix.map((value) => Math.round(value * 1e4) / 1e4));
  const joint = skin.listJoints()[0]!;
  assert.ok(Math.abs(joint.getTranslation()[1] - 1.5986) < 0.01, "the Head joint rests at the head's height");
  const weights = primitive.getAttribute("WEIGHTS_0")!;
  assert.deepEqual([...weights.getElement(0, [])], [1, 0, 0, 0]);
  // A chain still takes over part of the Head joint's weight.
  const chains = addSecondaryChains(document, chainsFor("hair.tied").map((spec) => ({ ...spec, nodes: ["hair.tied"], top: 1.72, axis: [0, 0] as [number, number], select: { type: "all" } as const, count: 1, minSegment: 0.05 })));
  assert.equal(chains[0]!.parent, HAIR_HEAD_JOINT);
});

test("the hair kit builds attachable KTX2 pieces on the Head joint, reproducibly", { skip, timeout: 3_600_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "hair-kit-"));
  const again = await mkdtemp(path.join(os.tmpdir(), "hair-kit-"));
  try {
    const built = await buildHairKit({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const keys = [
      ...PACK_KEYS.flatMap((key) => HAIR_PACK_VARIANTS.map((variant) => `${key}/${variant}`)),
      ...VARIETY_HAIRSTYLES.map((key) => `${key}/${HAIR_AUTHORED_VARIANT}`),
      ...BEARDS.map((key) => `${key}/${BEARD_VARIANT}`),
    ];
    assert.deepEqual(manifest.assets.map((entry) => `${entry.key}/${entry.variant}`).sort(), [...keys].sort());
    const images = manifest.assets.flatMap((entry) => entry.resources).filter((r) => r.mediaType.startsWith("image/"));
    assert.ok(images.length > 0 && images.every((r) => r.mediaType === "image/ktx2"), "every texture is KTX2");

    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, PACK_KEYS[0]!, "hair-1", HAIR_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.schema, HAIR_DESCRIPTOR_SCHEMA);
    assert.equal(d.figure, "humanoid.ranger.male");
    assert.equal(d.rig.joint, HAIR_HEAD_JOINT);
    const hair = new Map(d.hair.map((piece: any) => [piece.id, piece]));
    assert.deepEqual([...hair.keys()], [...PACK_KEYS, ...VARIETY_HAIRSTYLES]);
    assert.deepEqual(d.facialHair.options.map((option: any) => option.id), BEARDS);
    for (const piece of [...hair.values()] as any[]) {
      assert.equal(piece.socket, HAIR_SOCKET);
      assert.deepEqual(piece.requires, { "outfit.hood": false });
      assert.deepEqual(piece.hides, []);
    }
    for (const option of d.facialHair.options) assert.equal(option.socket, BEARD_SOCKET);
    assert.deepEqual((hair.get("hair.long") as any).variants, [...HAIR_PACK_VARIANTS]);
    assert.ok((hair.get("hair.long") as any).secondary.some((chain: any) => chain.joints.includes("hair_back_01")));
    assert.ok((hair.get("hair.tied") as any).joints.includes("hair_tail_01"));
    assert.ok((hair.get("hair.tied") as any).fixedMaterials.includes("hair.tie"));
    const beard = (id: string) => d.facialHair.options.find((option: any) => option.id === id);
    assert.ok(beard("beard.long").joints.some((joint: string) => joint.startsWith("beard_")));
    assert.deepEqual(beard("beard.short").joints, [HAIR_HEAD_JOINT]);
    assert.deepEqual(beard("beard.moustache").morphs.age.length > 0, true);

    const pieceDocs = new Map(manifest.assets.map((entry: any, index) => [`${entry.key}/${entry.variant}`, built.documents.get(built.lineage.parts[`${entry.key}/${entry.variant}`].sha256)!]));
    assert.equal(pieceDocs.size, keys.length);
    for (const [key, document] of pieceDocs) {
      const root_ = document.getRoot();
      const joints = new Set(root_.listSkins().flatMap((skin) => skin.listJoints().map((joint) => joint.getName())));
      assert.ok(joints.has(HAIR_HEAD_JOINT), `${key} is skinned to the Head joint`);
      assert.equal(root_.listAnimations().length, 0);
      const meshes = root_.listNodes().filter((node) => node.getMesh());
      assert.ok(meshes.length > 0);
      for (const node of meshes) {
        assert.ok(node.getSkin(), `${key}: ${node.getName()} is skinned`);
        for (const primitive of node.getMesh()!.listPrimitives()) assert.ok(primitive.listTargets().length > 0, `${key}: ${node.getName()} carries its keys`);
      }
      for (const material of root_.listMaterials()) {
        for (const texture of [material.getBaseColorTexture(), material.getNormalTexture(), material.getMetallicRoughnessTexture(), material.getOcclusionTexture()]) {
          if (texture) assert.equal(texture.getMimeType(), "image/ktx2", `${key}: ${material.getName()}`);
        }
      }
    }
    const rebuilt = await buildHairKit({ outDir: again });
    assert.equal(rebuilt.tarSha256, built.tarSha256, "two builds give the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(again, { recursive: true, force: true });
  }
});
