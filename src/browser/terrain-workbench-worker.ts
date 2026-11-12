// Web Worker of the terrain workbench (#127): runs the terrain recipe's own component build off the main thread and
// keeps the previous build, so an edit executes only the components it reaches. The page bundle maps `node:zlib` to
// node-zlib-shim.ts.
import "./node-buffer-shim.js";
import { TerrainWorkbenchSession, type TerrainWorkbenchPatch } from "./terrain-workbench-compute.js";
import { terrainWorkbenchRecipe } from "./terrain-workbench-state.js";

export type TerrainWorkbenchJob = { id: number; recipe: unknown; preserve: string[] };
export type TerrainWorkbenchResult =
  | { id: number; ok: true; patches: TerrainWorkbenchPatch[]; milliseconds: number }
  | { id: number; ok: false; error: string };

const session = new TerrainWorkbenchSession();

self.onmessage = async (event: MessageEvent<TerrainWorkbenchJob>) => {
  const { id } = event.data;
  try {
    const started = performance.now();
    const patches = await session.run(terrainWorkbenchRecipe(event.data.recipe), event.data.preserve);
    const result: TerrainWorkbenchResult = { id, ok: true, patches, milliseconds: Math.round(performance.now() - started) };
    const transfer = patches.flatMap((p) => [p.heights.buffer, p.slope.buffer, p.exclusion.buffer, ...Object.values(p.paint).map((m) => m.buffer)]);
    (self as unknown as Worker).postMessage(result, transfer as ArrayBuffer[]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies TerrainWorkbenchResult);
  }
};
