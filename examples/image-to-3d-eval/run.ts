// Image-to-3D evaluation (#122): render each ground-truth case, reconstruct it with every ready provider through
// mesh.image-to-3d.generate@1, and compare the result with the ground truth (examples/image-to-3d-eval/README in
// docs/image-to-3d-evaluation.md):
//   bun examples/image-to-3d-eval/run.ts --kit <greyhaven bundle dir> --ranger <ranger bundle dir> --out <dir> \
//     --bundle triposr:model=<triposr bundle.zip> [--bundle stable-fast-3d:source=<zip>,model=<zip>,tokenizer=<zip>]
// Providers marked pending in providers.json, or without a bundle, are skipped. A later run adds a provider without
// redoing the others: results are written per provider and case, and the report is rebuilt from all of them.
// Needs Blender (ASSET_TOOLING_BLENDER or `blender`) and each provider's Python runtime on PATH.
import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { storeAssetObject, resolveAssetObject } from "../../src/asset-store.js";
import { executeImageTo3DOperation } from "../../src/image-to-3d-operation.js";

type Json = Record<string, any>;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const blender = process.env.ASSET_TOOLING_BLENDER ?? "blender";

function runBlender(script: string, args: string[]) {
  const run = Bun.spawnSync([blender, "--background", "--factory-startup", "--python", path.join(HERE, script), "--", ...args], { stdout: "pipe", stderr: "pipe" });
  const output = run.stdout.toString() + run.stderr.toString();
  if (run.exitCode !== 0 || /Traceback/.test(output)) throw new Error(`${script} failed:\n${output.slice(-2000)}`);
}

async function main() {
  const args = process.argv.slice(2), option = (flag: string) => args.flatMap((value, index) => (value === flag ? [args[index + 1]!] : []));
  const [kit] = option("--kit"), [ranger] = option("--ranger"), [out] = option("--out");
  if (!kit || !ranger || !out) throw new Error("usage: run.ts --kit <bundle> --ranger <bundle> --out <dir> --bundle <provider>:<role>=<zip>[,...]");
  const bundles = new Map(option("--bundle").map((spec) => {
    const [provider, roles] = spec.split(":") as [string, string];
    return [provider, Object.fromEntries(roles.split(",").map((pair) => pair.split("=") as [string, string]))];
  }));
  const root = path.resolve(out);
  await mkdir(root, { recursive: true });
  const { cases } = JSON.parse(await readFile(path.join(HERE, "cases.json"), "utf8"));
  const { providers } = JSON.parse(await readFile(path.join(HERE, "providers.json"), "utf8"));
  const bundleDirs: Record<string, string> = { kit: path.resolve(kit), ranger: path.resolve(ranger) };
  for (const provider of providers) {
    const files = bundles.get(provider.id);
    if (provider.status !== "ready" || !files) { console.error(`[eval] skip ${provider.id} (${provider.status}${files ? "" : ", no bundle"})`); continue; }
    const assets = [];
    for (const role of provider.assets) {
      if (!files[role]) throw new Error(`${provider.id} needs --bundle ${provider.id}:${role}=<zip>`);
      assets.push((await storeAssetObject(root, { bytes: await readFile(files[role]), kind: "model", mediaType: "application/zip" })).asset);
    }
    for (const entry of cases) {
      const caseDir = path.join(root, provider.id, entry.id);
      await mkdir(caseDir, { recursive: true });
      const truth = path.join(bundleDirs[entry.bundle]!, "scenes", entry.key, "default.gltf");
      const viewPath = path.join(caseDir, "view.png");
      runBlender("render_view.py", [truth, viewPath, provider.viewMedia]);
      const view = (await storeAssetObject(root, { bytes: await readFile(viewPath), kind: "image", mediaType: "image/png" })).asset;
      const started = performance.now();
      const result = await executeImageTo3DOperation(root, {
        parameters: {
          provider: { id: provider.id, modelId: provider.modelId, modelRevision: provider.modelRevision, assets: provider.assets, parameters: provider.parameters },
          views: [{ id: "front-left", viewpoint: "front-left" }], description: entry.category, quality: "standard",
          requirements: { materials: provider.materials },
        },
        inputs: { views: [view], "provider-assets": assets },
      });
      const seconds = (performance.now() - started) / 1000;
      const output = result.outputs.output as any;
      const candidate = path.join(caseDir, "candidate.glb");
      await writeFile(candidate, await resolveAssetObject(root, output));
      runBlender("compare.py", [truth, candidate, path.join(caseDir, "metrics.json"), path.join(caseDir, "gameplay.png"), String(entry.gameplayDistance)]);
      const metrics = JSON.parse(await readFile(path.join(caseDir, "metrics.json"), "utf8"));
      await writeFile(path.join(caseDir, "run.json"), JSON.stringify({ provider: provider.id, case: entry.id, seconds: Math.round(seconds * 10) / 10, output: output.sha256, metrics }, null, 1));
      console.error(`[eval] ${provider.id}/${entry.id}: IoU ${metrics.meanSilhouetteIoU}, ${metrics.candidate.triangles} triangles, ${seconds.toFixed(1)} s`);
    }
  }
  // The report covers every provider run so far, so a later provider just adds columns.
  const rows: string[] = [];
  for (const provider of (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith("."))) {
    for (const entry of cases) {
      const file = path.join(root, provider.name, entry.id, "run.json");
      const run: Json | undefined = await readFile(file, "utf8").then(JSON.parse, () => undefined);
      if (!run) continue;
      const m = run.metrics, c = m.candidate, g = m.groundTruth;
      rows.push(`| ${provider.name} | ${entry.id} (${entry.category}) | ${m.meanSilhouetteIoU} | ${c.triangles.toLocaleString("en")} vs ${g.triangles.toLocaleString("en")} | ${c.looseParts} / ${c.nonManifoldEdges} | ${c.hasTextures ? "textures" : c.hasVertexColors ? "vertex colours" : "none"} | ${run.seconds} s |`);
    }
  }
  const report = ["| Provider | Case | Mean silhouette IoU | Triangles (candidate vs truth) | Loose parts / non-manifold edges | Surface colour | Time |",
    "| --- | --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
  await writeFile(path.join(root, "report.md"), `${report}\n`);
  console.log(report);
}

await main();
