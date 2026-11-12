// Pure state helpers of the terrain workbench (#127, docs/terrain-workbench.md): the workbench recipe form (schema 2
// with a seed per detail layer), URL state, the field a validation message is about and accepted-baseline diffs.
// No DOM access, so tests import them directly.
import { canonicalJson } from "../canonical.js";
import {
  normalizeTerrainPatchRecipe, type TerrainPatchBuildRecord, type TerrainPatchRecipe, type Vec2,
} from "../terrain-patch-recipes.js";
import { fromBase64Url, toBase64Url } from "./texture-workbench-state.js";

/** The patches the workbench builds: the same 2×2 grid, in the same order, as examples/terrain-patches/build.ts. */
export const TERRAIN_WORKBENCH_GRID: readonly Vec2[] = [[-1, -1], [0, -1], [-1, 0], [0, 0]];

/**
 * Normalizes a recipe and lifts schema 1 to schema 2 by giving every detail layer the recipe seed. That conversion
 * keeps every component key and output byte (docs/terrain-patches.md#seed-groups-and-partial-rebuilds), and gives the
 * workbench a seed per layer to lock or reseed.
 */
export function terrainWorkbenchRecipe(value: unknown): TerrainPatchRecipe {
  const recipe = normalizeTerrainPatchRecipe(value);
  if (recipe.schemaVersion === 2) return recipe;
  return normalizeTerrainPatchRecipe({ ...recipe, schemaVersion: 2, detail: recipe.detail.map((layer) => ({ ...layer, seed: recipe.seed })) });
}

export function terrainRecipeKey(recipe: TerrainPatchRecipe): string {
  return canonicalJson(recipe);
}

export function encodeTerrainParam(recipe: TerrainPatchRecipe): string {
  return toBase64Url(terrainRecipeKey(recipe));
}

/** The recipe in a query value, or undefined when it is missing, malformed or invalid. */
export function decodeTerrainParam(value: string | null): TerrainPatchRecipe | undefined {
  if (!value) return undefined;
  try {
    return terrainWorkbenchRecipe(JSON.parse(fromBase64Url(value)));
  } catch {
    return undefined;
  }
}

/** Form field names of a recipe, in page order. Shapes (edits, exclusions, paint) are edited as JSON. */
export function terrainFormFields(recipe: Pick<TerrainPatchRecipe, "shaping" | "detail">): string[] {
  const shaping = recipe.shaping.kind === "island" ? ["shaping.center.0", "shaping.center.1", "shaping.radius", "shaping.falloff", "shaping.seaLevel"]
    : recipe.shaping.kind === "terrace" ? ["shaping.step", "shaping.sharpness"] : [];
  return [
    "id", "seed", "origin.0", "origin.1", "sampleSpacing", "samples.0", "samples.1", "height.min", "height.max", "height.precision",
    "noise.baseHeight", "noise.amplitude", "noise.featureSize", "noise.octaves", "noise.roughness", "shaping.kind", ...shaping,
    "edits", "exclusions", "paint",
    ...recipe.detail.flatMap((_, i) => ["id", "seed", "density", "minSpacing", "slopeDegrees.0", "slopeDegrees.1", "height.0", "height.1",
      "maxExclusion", "paint", "scale.0", "scale.1", "variants"].map((name) => `detail.${i}.${name}`)),
  ];
}

/**
 * The form field a recipe validation message is about. Messages start with the recipe path (`noise.amplitude`,
 * `detail[1].slopeDegrees[0]`, `edits[0].shape.center`): the longest field that contains the path wins, then the first
 * field inside it, so a message about a shape lands on its JSON box and one about a pair on the pair's first input.
 */
export function terrainFieldForError(message: string, fields: readonly string[]): string | undefined {
  const label = /^(?:paint key|[A-Za-z]+(?:\[\d+\]|\.[A-Za-z]+)*)/.exec(message)?.[0];
  if (!label) return undefined;
  const path = label === "paint key" ? "paint" : label.replace(/\[(\d+)\]/g, ".$1");
  const containing = fields.filter((field) => path === field || path.startsWith(`${field}.`)).sort((a, b) => b.length - a.length)[0];
  return containing ?? fields.find((field) => field.startsWith(`${path}.`));
}

/** Every seed in a recipe: `seed` for the height and `detail.<i>.seed` per layer. */
export function terrainSeedFields(recipe: TerrainPatchRecipe): string[] {
  return ["seed", ...recipe.detail.map((_, i) => `detail.${i}.seed`)];
}

/** The recipe with new random seeds for every seed field that is not locked. */
export function reseedTerrainRecipe(recipe: TerrainPatchRecipe, locked: ReadonlySet<string>, random: () => number): TerrainPatchRecipe {
  return terrainWorkbenchRecipe({
    ...recipe,
    seed: locked.has("seed") ? recipe.seed : random(),
    detail: recipe.detail.map((layer, i) => ({ ...layer, seed: locked.has(`detail.${i}.seed`) ? layer.seed : random() })),
  });
}

/**
 * One identity per component across the grid: its output hashes (and a detail layer's instance hash) in every patch.
 * Keys are left out on purpose: the comparison is about the produced bytes, not about why they were produced.
 */
export function componentIdentities(records: readonly TerrainPatchBuildRecord[]): Record<string, string> {
  const out: Record<string, string[]> = {};
  for (const record of records) {
    for (const [name, component] of Object.entries(record.components)) {
      (out[name] ??= []).push(canonicalJson({ patch: record.patch, files: component.files, instances: component.instances ?? null }));
    }
  }
  return Object.fromEntries(Object.entries(out).map(([name, parts]) => [name, parts.join("|")]));
}

/** Components whose output differs from the accepted identities, plus those only one side has. */
export function changedComponents(accepted: Record<string, string>, current: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(accepted), ...Object.keys(current)])];
  return names.filter((name) => accepted[name] !== current[name]).sort();
}

/** The component names a recipe builds, in build order (docs/terrain-patches.md#seed-groups-and-partial-rebuilds). */
export function terrainComponentNames(recipe: TerrainPatchRecipe): string[] {
  return ["height", "exclusion", ...Object.keys(recipe.paint).map((name) => `paint.${name}`), ...recipe.detail.map((layer) => `detail.${layer.id}`), "detail"];
}
