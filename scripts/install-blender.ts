// Installs the pinned Blender release from adapters/blender/release.json into a directory and
// prints the executable path. Acquisition is separate from generation: the Blender script backend
// never downloads; it only runs the executable named by ASSET_TOOLING_BLENDER (or `blender`).
//
//   bun scripts/install-blender.ts <install-directory>

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const manifest = JSON.parse(
  await readFile(new URL("../adapters/blender/release.json", import.meta.url), "utf8"),
);
const platformKey = `${process.platform}-${process.arch}`;
const release = manifest.releases[platformKey];
if (!release) {
  throw new Error(`no pinned Blender ${manifest.version} release for ${platformKey}`);
}

const installDirectory = path.resolve(process.argv[2] ?? ".blender");
const executable = path.join(installDirectory, release.executable);
if (!existsSync(executable)) {
  const response = await fetch(release.url);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${release.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== release.sha256) {
    throw new Error(`Blender archive sha256 ${sha256} does not match pinned ${release.sha256}`);
  }
  await rm(installDirectory, { recursive: true, force: true });
  await mkdir(installDirectory, { recursive: true });
  const archive = path.join(installDirectory, path.basename(new URL(release.url).pathname));
  await writeFile(archive, bytes);
  const extracted = spawnSync("tar", ["-xf", archive, "-C", installDirectory], { stdio: "inherit" });
  if (extracted.status !== 0) throw new Error("failed to extract the Blender archive");
  await rm(archive);
}
console.log(executable);
