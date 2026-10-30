// The external.blender.script@1 asset spec every Blender recipe declares (#424). Kept apart from
// blender-recipe-run.ts so spec-only modules do not import the generation core.
import { parseAssetSpec } from "./schema.js";

/** A declared spec input: its workspace-relative path and SHA-256. */
export type BlenderSpecInput = { path: string; sha256: string };

/** The external.blender.script@1 asset spec. `inputs` holds the recipe (`script`) and any further declared inputs. */
export function blenderScriptSpec({ assetId, inputs, blenderVersion, arguments: args, output, reproducibility = "exact" }: {
  assetId: string; inputs: { script: BlenderSpecInput } & Record<string, BlenderSpecInput>; blenderVersion: string; arguments: unknown;
  output: string; reproducibility?: "exact" | "approximate";
}) {
  return parseAssetSpec({
    schemaVersion: 1, assetId, generator: { id: "external.blender.script", version: "1" }, randomness: { mode: "none" },
    inputs, models: {}, parameters: { blenderVersion, arguments: args }, output: { path: output }, reproducibility: { expected: reproducibility },
  });
}
