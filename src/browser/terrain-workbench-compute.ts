// Terrain workbench session (#127, docs/terrain-workbench.md): builds the 2×2 patch grid with the recipe's own
// `buildTerrainPatchFiles`, passing the previous successful build of each patch so only components whose inputs
// changed execute (#139), and `preserve` for the components the user keeps. A refused or failed build changes
// nothing: the previous build stays the basis of the next one.
import {
  buildTerrainPatchFiles, decodeGrayPng, type TerrainDetailInstance, type TerrainPatchBuild, type TerrainPatchBuildRecord,
  type TerrainPatchRecipe, type Vec2,
} from "../terrain-patch-recipes.js";
import { TERRAIN_WORKBENCH_GRID } from "./terrain-workbench-state.js";

export type TerrainWorkbenchPatch = {
  patch: Vec2;
  width: number;
  depth: number;
  /** Decoded from the build's own height.png, slope.png, exclusion.png and paint-<name>.png. */
  heights: Uint16Array;
  slope: Uint8Array;
  exclusion: Uint8Array;
  paint: Record<string, Uint8Array>;
  detail: TerrainDetailInstance[];
  record: TerrainPatchBuildRecord;
  stages: TerrainPatchBuild["stages"];
  heightSamplesEvaluated: number;
  files: Record<string, { sha256: string; byteLength: number }>;
};

export class TerrainWorkbenchSession {
  #previous = new Map<string, { record: TerrainPatchBuildRecord; files: Record<string, Uint8Array> }>();

  /** Builds every grid patch; reuses verified components of the last successful run and refuses to change `preserve`. */
  async run(recipe: TerrainPatchRecipe, preserve: readonly string[] = []): Promise<TerrainWorkbenchPatch[]> {
    const builds: TerrainPatchBuild[] = [];
    for (const patch of TERRAIN_WORKBENCH_GRID) {
      const previous = this.#previous.get(patch.join(","));
      builds.push(await buildTerrainPatchFiles(recipe, patch, {
        preserve,
        ...(previous ? { previous: { record: previous.record, read: (file: string) => previous.files[file] } } : {}),
      }));
    }
    // Every patch built: only now does this run become the basis of the next one.
    for (const build of builds) this.#previous.set(build.record.patch.join(","), { record: build.record, files: build.files });
    const [width, depth] = recipe.samples;
    return builds.map((build) => ({
      patch: build.record.patch, width, depth,
      heights: decodeGrayPng(build.files["height.png"]!, width, depth, 16) as Uint16Array,
      slope: decodeGrayPng(build.files["slope.png"]!, width, depth, 8) as Uint8Array,
      exclusion: decodeGrayPng(build.files["exclusion.png"]!, width, depth, 8) as Uint8Array,
      paint: Object.fromEntries(Object.keys(recipe.paint).map((name) =>
        [name, decodeGrayPng(build.files[`paint-${name}.png`]!, width, depth, 8) as Uint8Array])),
      detail: build.detail, record: build.record, stages: build.stages, heightSamplesEvaluated: build.heightSamplesEvaluated,
      files: Object.fromEntries(Object.entries(build.files).map(([name, bytes]) =>
        [name, { sha256: build.record.components[componentOf(name, build.record)]!.files[name]!, byteLength: bytes.byteLength }])),
    }));
  }
}

function componentOf(file: string, record: TerrainPatchBuildRecord): string {
  return Object.keys(record.components).find((name) => Object.hasOwn(record.components[name]!.files, file))!;
}
