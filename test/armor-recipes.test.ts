import { test } from "node:test";
import assert from "node:assert/strict";
import { ARMOR_JOINTS, createArmorAssetSpec, normalizeArmorParameters, readArmorRecipeSource } from "../src/armor-recipes.js";

test("armour parameters name a kit and an output and nothing else", () => {
  assert.deepEqual(normalizeArmorParameters({ schemaVersion: 1, kit: "knight", output: "plates" }), { schemaVersion: 1, kit: "knight", output: "plates" });
  assert.throws(() => normalizeArmorParameters({ schemaVersion: 1, kit: "archer", output: "plates" }), /kit/);
  assert.throws(() => normalizeArmorParameters({ schemaVersion: 1, kit: "soldier", output: "boots" }), /output/);
  assert.throws(() => normalizeArmorParameters({ schemaVersion: 1, kit: "soldier", output: "cloth", extra: 1 }), /exactly/);
  // #376: the resident kits have both outputs; #380: the beard kit is gone (hair_beards.py).
  for (const kit of ["farmer", "innkeeper", "monk"]) for (const output of ["plates", "cloth"]) normalizeArmorParameters({ schemaVersion: 1, kit, output });
  assert.throws(() => normalizeArmorParameters({ schemaVersion: 1, kit: "beard", output: "plates" }), /kit/);
});

test("the armour spec declares the recipe script and the fitting target as hash-pinned inputs", async () => {
  const source = await readArmorRecipeSource();
  const spec = createArmorAssetSpec({ assetId: "armor.soldier.cloth", parameters: { schemaVersion: 1, kit: "soldier", output: "cloth" },
    scriptSha256: source.sha256, targetSha256: "a".repeat(64), blenderVersion: source.blenderVersion });
  assert.deepEqual(Object.keys(spec.inputs).sort(), ["script", "target"]);
  assert.equal(spec.generator.id, "external.blender.script");
  assert.equal(new Set(ARMOR_JOINTS).size, ARMOR_JOINTS.length);
});
