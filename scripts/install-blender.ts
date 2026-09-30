// Installs the pinned Blender release from adapters/blender/release.json into a directory and
// prints the executable path. Acquisition is separate from generation: the Blender script backend
// never downloads; it only runs the executable named by ASSET_TOOLING_BLENDER (or `blender`).
//
//   bun scripts/install-blender.ts <install-directory>

import { readFile } from "node:fs/promises";
import { installPinnedBlender } from "./blender-installation.ts";

const manifest = JSON.parse(
  await readFile(new URL("../adapters/blender/release.json", import.meta.url), "utf8"),
);
const platformKey = `${process.platform}-${process.arch}`;
const release = manifest.releases[platformKey];
if (!release) {
  throw new Error(`no pinned Blender ${manifest.version} release for ${platformKey}`);
}

console.log(await installPinnedBlender(process.argv[2] ?? ".blender", release));
