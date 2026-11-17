// Build the spell effect meshes (#726, docs/spell-effects.md) from the scripted recipe adapters/blender/spell_effects.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-spell-effects.ts --out <directory>
// Each entry is one external.blender.script@1 run, imported through scene.import.gltf@2. The spell-effects-descriptor-v1
// attachment lists each entry's clip, alignment, intended scale, school tint, triangles and bounds. <directory> becomes the
// object-store root; the bundle is exported to <directory>/bundle and packed to <directory>/spell.effects.tar.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { buildKitPart, byKey, exportKitBundle, runKitCli, triangles, type KitPart } from "../src/kit-bundle.js";

export const SPELL_EFFECTS = [
  "bolt-fire", "bolt-shadow", "bolt-holy", "bolt-nature",
  "impact-fire", "impact-shadow", "impact-holy", "impact-nature", "impact-frost",
  "arrow", "crossbow-bolt", "throwing-knife",
  "frost-nova", "beam-segment", "heal-motes",
] as const;
export type SpellEffect = (typeof SPELL_EFFECTS)[number];
export const SPELL_KEY_PREFIX = "spell.effects";
export const SPELL_VARIANT = "default";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const SPELL_RELEASE = "spell-effects";
export const SPELL_TAR_NAME = "spell.effects.tar";
export const SPELL_DESCRIPTOR_SCHEMA = "spell-effects-descriptor-v1";
export const SPELL_DESCRIPTOR_ATTACHMENT = "spell-effects-descriptor";
export const SPELL_MATERIALS = ["shot", "spell-energy", "spell-fel", "spell-fire", "spell-frost", "spell-holy", "spell-nature", "spell-shadow"] as const;
/** The ceiling for every entry, so a spell costs next to nothing to draw. */
export const SPELL_TRIANGLE_BUDGET = 240;
/** Each animated entry's one clip: `Loop` repeats while the effect lives, `Play` runs once and ends gone. */
export const SPELL_CLIPS: Partial<Record<SpellEffect, { name: "Loop" | "Play"; duration: number }>> = {
  "bolt-fire": { name: "Loop", duration: 0.4 }, "bolt-shadow": { name: "Loop", duration: 0.6 },
  "bolt-holy": { name: "Loop", duration: 0.5 }, "bolt-nature": { name: "Loop", duration: 0.6 },
  "impact-fire": { name: "Play", duration: 0.35 }, "impact-shadow": { name: "Play", duration: 0.4 },
  "impact-holy": { name: "Play", duration: 0.4 }, "impact-nature": { name: "Play", duration: 0.45 },
  "impact-frost": { name: "Play", duration: 0.35 }, "frost-nova": { name: "Play", duration: 0.5 },
  "beam-segment": { name: "Loop", duration: 0.24 }, "heal-motes": { name: "Play", duration: 0.8 },
};
/** What each entry is for and which school tints it, copied into the descriptor. */
export const SPELL_USE: Record<SpellEffect, { use: string; school: string; tint: string }> = {
  "bolt-fire": { use: "Firebolt", school: "fire", tint: "spell-fire" },
  "bolt-shadow": { use: "Shadow Bolt, Corruption", school: "shadow", tint: "spell-shadow" },
  "bolt-holy": { use: "Smite", school: "holy", tint: "spell-holy" },
  "bolt-nature": { use: "Wrath", school: "nature", tint: "spell-nature" },
  "impact-fire": { use: "a fire spell's hit", school: "fire", tint: "spell-fire" },
  "impact-shadow": { use: "a shadow spell's hit", school: "shadow", tint: "spell-shadow" },
  "impact-holy": { use: "a holy spell's hit", school: "holy", tint: "spell-holy" },
  "impact-nature": { use: "a nature spell's hit", school: "nature", tint: "spell-nature" },
  "impact-frost": { use: "a frost spell's hit", school: "frost", tint: "spell-frost" },
  "arrow": { use: "bow shots", school: "physical", tint: "shot" },
  "crossbow-bolt": { use: "crossbow shots", school: "physical", tint: "shot" },
  "throwing-knife": { use: "thrown knives", school: "physical", tint: "shot" },
  "frost-nova": { use: "Frost Nova", school: "frost", tint: "spell-frost" },
  "beam-segment": { use: "Lightning Beam, Holy Beam", school: "any", tint: "spell-energy" },
  "heal-motes": { use: "Renew, Rejuvenation and heals", school: "any", tint: "spell-energy" },
};
/** A material's base colour as an sRGB hex string, the colour a game would replace to recolour the entry. */
function srgbHex(document: Document, name: string) {
  const material = document.getRoot().listMaterials().find((candidate) => candidate.getName() === name);
  if (!material) throw new Error(`no material ${name}`);
  const toSrgb = (c: number) => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return `#${material.getBaseColorFactor().slice(0, 3).map((c) => Math.round(toSrgb(c) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export const spellKey = (entry: SpellEffect) => `${SPELL_KEY_PREFIX}.${entry}`;

export function createSpellSpec({ entry, scriptSha256, blenderVersion }: { entry: SpellEffect; scriptSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: spellKey(entry), inputs: { script: { path: "spell_effects.py", sha256: scriptSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, entry }, output: "spell.glb",
  });
}

type Built = KitPart & { entry: SpellEffect };

export async function buildSpellEffects({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("spell_effects.py");
  const built: Built[] = [];
  for (const entry of SPELL_EFFECTS) {
    log(`generate ${entry}`);
    built.push({ entry, ...await buildKitPart(root, {
      workspace: path.join(root, "effects", entry), files: { "spell_effects.py": source.bytes },
      spec: createSpellSpec({ entry, scriptSha256: source.sha256, blenderVersion: source.blenderVersion }),
    }) });
  }

  log("measure the descriptor");
  const assets = built.map(({ entry, document, observations }) => {
    const expected = SPELL_CLIPS[entry];
    const animations = document.getRoot().listAnimations();
    if (!expected && animations.length) throw new Error(`${entry} is static but has a clip`);
    let clip = null;
    if (expected) {
      const animation = animations.find((candidate) => candidate.getName() === expected.name);
      if (!animation) throw new Error(`${entry} has no ${expected.name} clip`);
      const duration = Math.max(...animation.listSamplers().map((sampler) => sampler.getInput()!.getMax([0])[0]!));
      if (Math.abs(duration - expected.duration) > 1e-4) throw new Error(`${entry}: ${expected.name} lasts ${duration} s, not ${expected.duration} s`);
      clip = { ...expected, loop: expected.name === "Loop" };
    }
    const { use, school, tint } = SPELL_USE[entry];
    return {
      key: spellKey(entry), role: entry, use, school, align: observations.align, clip, intendedScale: 1,
      tint: { material: tint, colour: srgbHex(document, tint) },
      ...(observations.radius ? { radius: observations.radius } : {}),
      ...(observations.tileLength ? { tileLength: observations.tileLength } : {}),
      ...(observations.length ? { length: observations.length } : {}),
      triangles: triangles(document), bounds: observations.clipBounds,
      materials: [...new Set(document.getRoot().listMaterials().map((material) => material.getName()))].sort(),
    };
  }).sort(byKey);
  const descriptor = {
    schema: SPELL_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", reference: "mmorpg's projectile and Frost Nova scale",
    origins: {
      tip: "the projectile's tip, +Z forward; the body and tail trail back along -Z",
      hit: "the hit point; the burst is roughly round, its holy column and flame tongues rise along +Y",
      ground: "the caster's or target's feet on the ground, +Y up",
      beam: "the beam's start; one segment runs from z = 0 to z = tileLength, and both ends share a cross-section, so scale it along Z or lay copies end to end",
    },
    bounds: "Each entry's bounds hold every frame of its clip.",
    playback: "Loop clips repeat while the projectile or beam lives; Play clips run once from the hit or cast and end with zero scale or zero area, so remove the instance when they end. Shots are static: the game spins a knife itself.",
    tinting: "Colour and opacity come from COLOR_0 (RGBA) times the material colour; spell vertex colours stay at or below white, so set a material's base and emissive colour to recolour. tint names each entry's main material and its authored sRGB colour.",
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: SPELL_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  const selections = built.map((part, index) => ({ key: spellKey(part.entry), variant: SPELL_VARIANT, ...(index === 0 ? { attachments: [{ name: SPELL_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: SPELL_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: built.map((part) => part.asset), attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((part) => [part.entry, part.document])) as Record<SpellEffect, Document>,
    lineage: {
      recipe: { script: "adapters/blender/spell_effects.py", sha256: source.sha256, blenderVersion: source.blenderVersion },
      release: SPELL_RELEASE, effects: Object.fromEntries(built.map((part) => [part.entry, part.asset])), descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-spell-effects.ts", SPELL_RELEASE, buildSpellEffects, { descriptorFile: true });
