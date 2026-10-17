// Pack an exported asset bundle into a deterministic release tar, or verify one (docs/asset-bundles.md).
//   bun scripts/pack-asset-bundle.ts <exportDir> <outFile.tar>
//   bun scripts/pack-asset-bundle.ts --verify <file.tar> [--ref <pinned export.ref.json>]
// Packing writes <outFile.tar> and <outFile.tar>.sha256 (sha256sum format). Nothing touches the network;
// publishing the tar as a GitHub Release asset is a separate, explicit step.
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { packAssetBundle, verifyAssetBundleTar } from "../src/asset-bundle-pack.js";

const USAGE = "Usage: bun scripts/pack-asset-bundle.ts <exportDir> <outFile.tar> | --verify <file.tar> [--ref <export.ref.json>]";

async function main(args: string[]): Promise<number> {
  if (args[0] === "--verify") {
    const [, tarFile, flag, refFile, ...rest] = args;
    if (!tarFile || rest.length || (flag !== undefined && (flag !== "--ref" || !refFile))) { console.error(USAGE); return 2; }
    const tar = await readFile(path.resolve(tarFile));
    // The sidecar must be exactly one sha256sum line for this tar: "<64 lowercase hex>  <basename>\n".
    const sidecar = await readFile(`${path.resolve(tarFile)}.sha256`, "utf8");
    const match = /^([0-9a-f]{64}) {2}([^\n]+)\n$/.exec(sidecar);
    if (!match || match[2] !== path.basename(tarFile)) throw new Error(`${path.basename(tarFile)}.sha256 must be exactly one line '<64 lowercase hex sha256>  ${path.basename(tarFile)}'`);
    const pinned = match[1]!;
    const ref = refFile ? JSON.parse(await readFile(path.resolve(refFile), "utf8")) : undefined;
    const checked = await verifyAssetBundleTar(tar, { sha256: pinned, ...(ref ? { ref } : {}) });
    console.log(JSON.stringify({ verified: true, sha256: pinned, profile: checked.manifest.profile, manifest: checked.ref.sha256, files: checked.files.length }));
    return 0;
  }
  const [exportDir, outFile, ...rest] = args;
  if (!exportDir || !outFile || rest.length) { console.error(USAGE); return 2; }
  const packed = await packAssetBundle(path.resolve(exportDir)), out = path.resolve(outFile);
  await writeFile(out, packed.tar);
  await writeFile(`${out}.sha256`, `${packed.sha256}  ${path.basename(out)}\n`);
  console.log(JSON.stringify({ tar: out, sha256: packed.sha256, byteLength: packed.tar.byteLength, manifest: packed.ref.sha256, files: packed.files.length + 1 }));
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
