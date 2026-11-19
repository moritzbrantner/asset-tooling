// Build the strike effect meshes (#724, #754, #771, docs/strike-effects.md) from the scripted recipe adapters/blender/strike_effects.py:
//   ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-strike-effects.ts --out <directory>
// Each entry is one external.blender.script@1 run, imported through scene.import.gltf@2. The strike-effects-descriptor-v1
// attachment lists each entry's clip, alignment, intended scale, triangles and bounds. <directory> becomes the object-store
// root; the bundle is exported to <directory>/bundle and packed to <directory>/strike.effects.tar. No game spawns them yet.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { GLTF_RESOURCES_BUNDLE_PROFILE } from "../src/asset-bundle.js";
import { storeAssetObject } from "../src/asset-store.js";
import { blenderScriptSpec } from "../src/blender-script-spec.js";
import { readBlenderRecipeSource } from "../src/blender-recipe-source.js";
import { canonicalJson } from "../src/canonical.js";
import { buildKitPart, byKey, exportKitBundle, runKitCli, triangles, type KitPart } from "../src/kit-bundle.js";

export const STRIKE_EFFECTS = [
  "strike-arc-cut", "strike-arc-heavy", "cleave-sweep", "combo-glint", "strike-thrust", "impact-burst", "ground-slam", "lunge-dust",
  "leap-slam", "dash-trail", "dash-dust",
] as const;
export type StrikeEffect = (typeof STRIKE_EFFECTS)[number];
export const STRIKE_KEY_PREFIX = "strike.effects";
export const STRIKE_VARIANT = "default";
/** One rolling release (Atlas Decision 7.1.5), never numbered. */
export const STRIKE_RELEASE = "strike-effects";
export const STRIKE_TAR_NAME = "strike.effects.tar";
export const STRIKE_DESCRIPTOR_SCHEMA = "strike-effects-descriptor-v1";
export const STRIKE_DESCRIPTOR_ATTACHMENT = "strike-effects-descriptor";
export const STRIKE_MATERIALS = ["strike-dust", "strike-glow"] as const;
/** The issue's ceiling for every entry, so a strike costs next to nothing to draw. */
export const STRIKE_TRIANGLE_BUDGET = 200;
/** Each entry's one-shot clip `Play`, in seconds. */
export const STRIKE_CLIPS: Record<StrikeEffect, number> = {
  "strike-arc-cut": 0.18, "strike-arc-heavy": 0.25, "cleave-sweep": 0.3, "combo-glint": 0.3, "strike-thrust": 0.15, "impact-burst": 0.2, "ground-slam": 0.4, "lunge-dust": 0.35,
  "leap-slam": 0.6, "dash-trail": 0.4, "dash-dust": 0.35,
};
/** What each entry marks in a fight, copied into the descriptor. */
export const STRIKE_USE: Record<StrikeEffect, string> = {
  "strike-arc-cut": "sword, dagger and axe chain hits",
  "strike-arc-heavy": "finishers, maces and two-handed weapons",
  "cleave-sweep": "a slash that hits more than one enemy",
  "combo-glint": "the weapon while a follow-up window is open",
  "strike-thrust": "spear and dagger stabs",
  "impact-burst": "any hit on a body",
  "ground-slam": "a jumping strike's landing",
  "lunge-dust": "a running strike's start",
  "leap-slam": "Leap Slam's landing (spawn at the Leap_Slam contact, 0.36 s in)",
  "dash-trail": "a dash or Dash_Lunge, stretched from its start to its end",
  "dash-dust": "a dash's start foot",
};

export const strikeKey = (entry: StrikeEffect) => `${STRIKE_KEY_PREFIX}.${entry}`;

export function createStrikeSpec({ entry, scriptSha256, blenderVersion }: { entry: StrikeEffect; scriptSha256: string; blenderVersion: string }) {
  return blenderScriptSpec({
    assetId: strikeKey(entry), inputs: { script: { path: "strike_effects.py", sha256: scriptSha256 } },
    blenderVersion, arguments: { schemaVersion: 1, entry }, output: "strike.glb",
  });
}

type Built = KitPart & { entry: StrikeEffect };

export async function buildStrikeEffects({ outDir, log = () => {} }: { outDir: string; log?: (line: string) => void }) {
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const source = await readBlenderRecipeSource("strike_effects.py");
  const built: Built[] = [];
  for (const entry of STRIKE_EFFECTS) {
    log(`generate ${entry}`);
    built.push({ entry, ...await buildKitPart(root, {
      workspace: path.join(root, "effects", entry), files: { "strike_effects.py": source.bytes },
      spec: createStrikeSpec({ entry, scriptSha256: source.sha256, blenderVersion: source.blenderVersion }),
    }) });
  }

  log("measure the descriptor");
  const assets = built.map(({ entry, document, observations }) => {
    const clip = document.getRoot().listAnimations().find((animation) => animation.getName() === "Play");
    if (!clip) throw new Error(`${entry} has no Play clip`);
    const duration = Math.max(...clip.listSamplers().map((sampler) => sampler.getInput()!.getMax([0])[0]!));
    if (Math.abs(duration - STRIKE_CLIPS[entry]) > 1e-4) throw new Error(`${entry}: Play lasts ${duration} s, not ${STRIKE_CLIPS[entry]} s`);
    return {
      key: strikeKey(entry), role: entry, use: STRIKE_USE[entry], align: observations.align,
      clip: { name: "Play", duration: STRIKE_CLIPS[entry], loop: false }, intendedScale: 1,
      ...(observations.swingRadius ? { swingRadius: observations.swingRadius } : {}),
      ...(observations.length ? { length: observations.length } : {}),
      triangles: triangles(document), bounds: observations.clipBounds,
      materials: [...new Set(document.getRoot().listMaterials().map((material) => material.getName()))].sort(),
    };
  }).sort(byKey);
  const descriptor = {
    schema: STRIKE_DESCRIPTOR_SCHEMA, units: "metre", up: "+Y", handedness: "right", reference: "the Ranger's reach",
    origins: {
      strike: "the contact point, with +Z along the strike direction; the arcs lie in the XZ plane and curve back to their swing centre at (-swingRadius, 0, 0)",
      ground: "the landing or foot point on the ground, +Y up and +Z the attacker's facing",
      weapon: "the point on the weapon to glint, usually the blade's tip or middle; the glint reads from any side, so its rotation does not matter",
      path: "the start of a move on the ground, +Y up and +Z along the move; the effect runs to z = length, so scale Z by the move's distance / length",
    },
    bounds: "Each entry's bounds hold every frame of its clip.",
    playback: "Spawn at the contact frame, play Play once and remove the instance when it ends: every entry ends with zero scale or zero area. Colour and opacity come from COLOR_0 (RGBA) times the material colour; tint through the material.",
    assets,
  };
  const descriptorAsset = (await storeAssetObject(root, { bytes: Buffer.from(`${canonicalJson(descriptor)}\n`), kind: STRIKE_DESCRIPTOR_ATTACHMENT, mediaType: "application/json" })).asset;

  const selections = built.map((part, index) => ({ key: strikeKey(part.entry), variant: STRIKE_VARIANT, ...(index === 0 ? { attachments: [{ name: STRIKE_DESCRIPTOR_ATTACHMENT }] } : {}) }));
  const packed = await exportKitBundle(root, {
    tarName: STRIKE_TAR_NAME, log,
    invocation: { parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: selections }, inputs: { assets: built.map((part) => part.asset), attachments: [descriptorAsset] } },
  });
  return {
    ...packed, descriptor,
    documents: Object.fromEntries(built.map((part) => [part.entry, part.document])) as Record<StrikeEffect, Document>,
    lineage: {
      recipe: { script: "adapters/blender/strike_effects.py", sha256: source.sha256, blenderVersion: source.blenderVersion },
      release: STRIKE_RELEASE, effects: Object.fromEntries(built.map((part) => [part.entry, part.asset])), descriptor: descriptorAsset,
    },
  };
}

if (import.meta.main) await runKitCli("scripts/build-strike-effects.ts", STRIKE_RELEASE, buildStrikeEffects, { descriptorFile: true });
