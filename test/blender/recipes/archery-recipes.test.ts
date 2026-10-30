// Archery recipes (#113 bow slice, docs/weapon-recipes.md#archery): control bounds, and with Blender an exact,
// skinned bow whose string follows the `nock` joint, plus the static arrow and quiver.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { ARCHERY_PIECES, ARCHERY_PRESETS, ARCHERY_TRIANGLE_BUDGETS, BOW_DRAW_CONTRACT, createArcheryAssetSpec, normalizeArcheryParameters, readArcheryRecipeSource } from "../../../src/archery-recipes.js";
import { canonicalJson } from "../../../src/canonical.js";
import { generateAsset } from "../../../src/index.js";

test("archery controls are bounded and exact", () => {
  for (const piece of ARCHERY_PIECES) assert.deepEqual(normalizeArcheryParameters(ARCHERY_PRESETS[piece]), { ...ARCHERY_PRESETS[piece] });
  assert.throws(() => normalizeArcheryParameters({ ...ARCHERY_PRESETS["bow.long"], braceHeight: 0.5 }), /braceHeight/);
  assert.throws(() => normalizeArcheryParameters({ ...ARCHERY_PRESETS.arrow, extra: 1 }), /exactly the declared controls/);
  assert.throws(() => normalizeArcheryParameters({ ...ARCHERY_PRESETS["quiver.back"], maxTriangles: ARCHERY_TRIANGLE_BUDGETS["quiver.back"] + 1 }), /maxTriangles/);
});

test("the presets generate a skinned bow and static arrow and quiver", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 600_000,
}, async () => {
  const source = await readArcheryRecipeSource();
  const directory = await mkdtemp(path.join(os.tmpdir(), "archery-"));
  try {
    for (const piece of ARCHERY_PIECES) {
      const workspace = path.join(directory, piece);
      await import("node:fs/promises").then((fs) => fs.mkdir(workspace, { recursive: true }));
      await writeFile(path.join(workspace, "archery.py"), source.bytes);
      const spec = createArcheryAssetSpec({ assetId: `archery.${piece}`, parameters: ARCHERY_PRESETS[piece], scriptSha256: source.sha256, blenderVersion: source.blenderVersion });
      await writeFile(path.join(workspace, "asset.json"), canonicalJson(spec));
      const generated = await generateAsset(path.join(workspace, "asset.json"));
      const observations = (generated.receipt.observations as any).script;
      assert.ok(observations.triangleCount <= ARCHERY_TRIANGLE_BUDGETS[piece], piece);
      const document = await new NodeIO().readBinary(new Uint8Array(await readFile(path.join(workspace, "archery.glb"))));
      const skins = document.getRoot().listSkins();
      if (piece !== "bow.long") {
        assert.equal(skins.length, 0, piece);
        assert.ok(document.getRoot().listNodes().some((node) => node.getName() === "grip" && !node.getMesh()), piece);
        continue;
      }
      assert.deepEqual(skins[0]!.listJoints().map((joint) => joint.getName()), [...BOW_DRAW_CONTRACT.joints]);
      assert.deepEqual(observations.nockRest, [0, 0, -ARCHERY_PRESETS["bow.long"].braceHeight]);
      // String vertices are weighted between grip and nock; the limbs follow grip only.
      for (const primitive of document.getRoot().listMeshes()[0]!.listPrimitives()) {
        const weights = primitive.getAttribute("WEIGHTS_0")!, joints = primitive.getAttribute("JOINTS_0")!;
        let nockWeighted = 0;
        for (let i = 0; i < weights.getCount(); i += 1) {
          const w: number[] = [], j: number[] = [];
          weights.getElement(i, w); joints.getElement(i, j);
          nockWeighted += w.some((value, k) => value > 0 && j[k] === 1) ? 1 : 0;
        }
        const material = primitive.getMaterial()!.getName();
        if (material === "string") assert.ok(nockWeighted > weights.getCount() / 2, `string vertices follow nock: ${nockWeighted}`);
        else assert.equal(nockWeighted, 0, `${material} follows grip only`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
