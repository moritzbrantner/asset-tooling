import { readFile } from "node:fs/promises";
import { sha256Bytes } from "./hash.js";

/** Read a packaged Blender authoring source with its exact release identity. */
export async function readBlenderRecipeSource(filename: string) {
  if (!/^[a-z_]+\.py$/.test(filename)) throw new Error("Blender recipe source must be a packaged Python basename");
  const bytes = await readFile(new URL(`../adapters/blender/${filename}`, import.meta.url));
  const release: unknown = JSON.parse(await readFile(new URL("../adapters/blender/release.json", import.meta.url), "utf8"));
  if (!release || typeof release !== "object" || !("version" in release) || typeof release.version !== "string" || !/^\d+\.\d+\.\d+$/.test(release.version)) throw new Error("packaged Blender release must declare an exact version");
  return { bytes, sha256: sha256Bytes(bytes), blenderVersion: release.version };
}
