// Check that a Ranger figure's release build is byte-reproducible (#440, docs/humanoid-ranger.md#reproducibility):
//   bun scripts/check-ranger-reproducible.ts --figure male|female --out <dir>
//     builds the release twice, into <dir>/first and <dir>/second, and compares the tars and export.ref.json files.
//     When they differ it lists the Blender steps whose outputs differ and the release files that differ.
//   bun scripts/check-ranger-reproducible.ts --replay <out>
//     replays every Blender step of one finished build under <out> with `verify` (the receipt's output against a fresh
//     run of the same spec and inputs) and lists the steps that drift: one build, a few minutes more.
// Same environment as scripts/build-ranger-release.ts (ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB, ASSET_TOOLING_BLENDER,
// TMPDIR under $HOME for snap Blender). A male build's --out holds about 8 GB, so the two-build check needs twice that.
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import pLimit from "p-limit";
import { verifyAsset } from "../src/core.js";
import { sha256Bytes } from "../src/hash.js";
import { RANGER_FIGURES, type RangerFigure } from "./build-ranger-character.ts";
import { buildRangerRelease } from "./build-ranger-release.ts";

/** Every Blender step workspace (an `asset.json` beside a receipt) under a build's --out, as sorted relative paths. */
export async function blenderSteps(out: string): Promise<string[]> {
  const steps: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "asset.json") && entries.some((entry) => entry.name.endsWith(".receipt.json"))) {
      steps.push(path.relative(out, dir).split(path.sep).join("/"));
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "bundle") await walk(path.join(dir, entry.name));
  };
  await walk(out);
  return steps.sort();
}

/** Each step's receipted output sha256, by step path. */
async function stepOutputs(out: string): Promise<Map<string, string>> {
  const outputs = new Map<string, string>();
  for (const step of await blenderSteps(out)) {
    const dir = path.join(out, step);
    const receipt = (await readdir(dir)).find((name) => name.endsWith(".receipt.json"))!;
    outputs.set(step, JSON.parse(await readFile(path.join(dir, receipt), "utf8")).output.sha256);
  }
  return outputs;
}

/** Top-level release files (tar, downloads, export.ref.json) by name and sha256. */
async function releaseHashes(out: string): Promise<Map<string, string>> {
  const files = (await readdir(out, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  return new Map(await Promise.all(files.map(async (name) => [name, sha256Bytes(await readFile(path.join(out, name)))] as [string, string])));
}

const differing = (a: Map<string, string>, b: Map<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])].sort().filter((key) => a.get(key) !== b.get(key));

async function twice(figure: RangerFigure, outDir: string, processorCheckout: string): Promise<number> {
  const dirs = ["first", "second"].map((name) => path.resolve(outDir, name));
  const results = [];
  for (const dir of dirs) {
    console.error(`build ${figure} into ${dir}`);
    results.push(await buildRangerRelease({ outDir: dir, figure, processorCheckout, log: (line) => console.error(line) }));
  }
  const refs = await Promise.all(results.map(async (result) => sha256Bytes(await readFile(result.exportRefPath))));
  const same = results[0]!.tarSha256 === results[1]!.tarSha256 && refs[0] === refs[1];
  console.log(JSON.stringify({ figure, reproducible: same, tarSha256: results.map((result) => result.tarSha256), exportRefSha256: refs }, null, 2));
  if (same) return 0;
  const steps = differing(...(await Promise.all(dirs.map(stepOutputs))) as [Map<string, string>, Map<string, string>]);
  const files = differing(...(await Promise.all(dirs.map(releaseHashes))) as [Map<string, string>, Map<string, string>]);
  console.log(JSON.stringify({ differingBlenderSteps: steps, differingReleaseFiles: files }, null, 2));
  return 1;
}

async function replay(out: string): Promise<number> {
  const root = path.resolve(out);
  const steps = await blenderSteps(root);
  const limit = pLimit(Math.max(1, Number(process.env.ASSET_TOOLING_JOBS) || availableParallelism() - 1));
  const drift: string[] = [];
  await Promise.all(steps.map((step) => limit(async () => {
    const result = await verifyAsset(path.join(root, step, "asset.json"));
    console.error(`${result.status} ${step}${result.error ? `: ${result.error}` : ""}`);
    if (result.status !== "exact") drift.push(step);
  })));
  console.log(JSON.stringify({ steps: steps.length, drift: drift.sort() }, null, 2));
  return drift.length ? 1 : 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2), option = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const replayDir = option("--replay"), figure = option("--figure"), outDir = option("--out");
  const processorCheckout = process.env.ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB;
  try {
    if (replayDir) process.exitCode = await replay(replayDir);
    else if (outDir && figure && Object.hasOwn(RANGER_FIGURES, figure) && processorCheckout) process.exitCode = await twice(figure as RangerFigure, outDir, processorCheckout);
    else {
      console.error("Usage: ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB=<checkout> bun scripts/check-ranger-reproducible.ts --figure male|female --out <dir>\n" +
        "       bun scripts/check-ranger-reproducible.ts --replay <out of one build>");
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
