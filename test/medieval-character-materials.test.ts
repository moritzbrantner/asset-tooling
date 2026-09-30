import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  MEDIEVAL_CHARACTER_PALETTES,
  MEDIEVAL_CHARACTER_PART_MATERIALS,
  buildMedievalCharacterMaterialManifest,
  buildMedievalCharacterPackageManifest,
} from "../src/medieval-character-materials.js";
import { MEDIEVAL_CHARACTER_RECIPES, buildMedievalCharacterKitManifest } from "../src/medieval-character-kit.js";

test("medieval character palettes expose a stable shared material role set", () => {
  assert.deepEqual(MEDIEVAL_CHARACTER_PALETTES.map((palette) => palette.id), ["burgundy", "azure", "neutral"]);
  const expectedRoles = ["cloth-primary", "cloth-secondary", "skin", "leather", "wood", "steel", "string"];
  for (const palette of MEDIEVAL_CHARACTER_PALETTES) {
    assert.deepEqual(palette.materials.map((material) => material.id), expectedRoles);
    assert(Object.isFrozen(palette));
    for (const material of palette.materials) {
      assert(Object.isFrozen(material));
      assert.equal(material.baseColorSrgb8.length, 4);
      assert(material.baseColorSrgb8.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255));
      assert(Number.isInteger(material.metallic) && material.metallic >= 0 && material.metallic <= 255);
      assert(Number.isInteger(material.roughness) && material.roughness >= 0 && material.roughness <= 255);
    }
  }
});

test("every generated character part has exactly one material role", () => {
  for (const [archetype, recipe] of Object.entries(MEDIEVAL_CHARACTER_RECIPES)) {
    assert.deepEqual(
      Object.keys(MEDIEVAL_CHARACTER_PART_MATERIALS[archetype]).sort(),
      recipe.parts.map((part) => part.name).sort(),
    );
  }
});

test("material manifest is renderer-neutral deterministic PBR factor data", () => {
  const first = buildMedievalCharacterMaterialManifest();
  const second = buildMedievalCharacterMaterialManifest();
  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.model, "pbr-metallic-roughness");
  assert.equal(first.factorEncoding, "unorm8");
  assert.equal(first.colorSpace, "srgb");
  assert.equal(first.palettes.length, 3);
  assert.deepEqual(first.bindings.knight.shield, "cloth-primary");
});

test("package manifest distinguishes current evidence from 3d-lab processing intent", () => {
  const packageManifest = buildMedievalCharacterPackageManifest();
  assert.deepEqual(packageManifest.geometry, buildMedievalCharacterKitManifest());
  assert.equal(packageManifest.processingPlan.status, "intent-only");
  assert.equal(packageManifest.processingPlan.authority, "moritzbrantner/3d-lab");
  assert.equal(packageManifest.processingPlan.sourceMediaType, "model/obj");
  assert.equal(packageManifest.processingPlan.targetMediaType, "model/gltf-binary");
  assert.deepEqual(
    packageManifest.processingPlan.lod.levels.map((level) => level.triangleRatioPermille),
    [1000, 500, 250],
  );
});

test("package exports the material/package recipe surface", async () => {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(
    packageJson.exports["./recipes/medieval-character-materials"],
    "./src/medieval-character-materials.ts",
  );
});
