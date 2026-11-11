// Measure the limestone surface trial (#567, docs/limestone-rocks.md#layered-surface-trial) in real Chromium:
//   bun scripts/measure-surface-trial.ts --baked <limestone-rocks.kit.tar> --layered <limestone-rocks-layered.kit.tar> [--out <directory>]
// It builds the trial page, renders every surface from each camera, times frames and writes results.json and JPEG renders
// to <directory> (default review/limestone-rocks/surface-trial). Chromium is asked for the GPU; results.json names the
// renderer it got, so a software rasteriser is visible in the numbers.
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { writeSurfaceTrialPage } from "../src/surface-trial-page.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argument = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const bakedTar = argument("--baked"), layeredTar = argument("--layered");
const out = path.resolve(argument("--out") ?? path.join(ROOT, "review/limestone-rocks/surface-trial"));
if (!bakedTar || !layeredTar) {
  console.error("Usage: bun scripts/measure-surface-trial.ts --baked <tar> --layered <tar> [--out <directory>]");
  process.exit(2);
}
const MODES = ["baked", "light", "medium", "heavy"] as const;
const VIEWS = ["game", "mid", "overview"] as const;
const RUNS = 5;

const site = await mkdtemp(path.join(os.tmpdir(), "surface-trial-"));
await writeSurfaceTrialPage({ repositoryRoot: ROOT, outDir: site, bakedTar, layeredTar });
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const file = path.join(site, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!file.startsWith(site)) return new Response("forbidden", { status: 403 });
    const type = file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".js") ? "text/javascript" : undefined;
    return stat(file).then(() => new Response(Bun.file(file), type ? { headers: { "content-type": type } } : {}), () => new Response("not found", { status: 404 }));
  },
});
const browser = await chromium.launch({ args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-gpu-vsync", "--disable-frame-rate-limit"] });
type Trial = { set(next: { mode?: string; view?: string }): void; measure(frames?: number): { mode: string; view: string; msPerFrame: number; drawCalls: number; triangles: number }; costs: Record<string, any>; gpu: string; instances: number };
const open = async (width: number, height: number) => {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (error) => console.error(error));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => "surfaceTrial" in window, undefined, { timeout: 120_000 });
  return page;
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

try {
  await mkdir(out, { recursive: true });
  const timing = await open(1920, 1080);
  const { costs, gpu, instances } = await timing.evaluate(() => { const t = (window as any).surfaceTrial as Trial; return { costs: t.costs, gpu: t.gpu, instances: t.instances }; });
  console.error(`renderer: ${gpu}`);
  const frames = [];
  for (const view of VIEWS) for (const mode of MODES) {
    const runs = [];
    for (let run = 0; run < RUNS; run += 1) runs.push(await timing.evaluate(([v, m]) => { const t = (window as any).surfaceTrial as Trial; t.set({ view: v, mode: m }); return t.measure(240); }, [view, mode] as const));
    frames.push({ ...runs[0]!, msPerFrame: Number(median(runs.map((r) => r.msPerFrame)).toFixed(3)) });
    console.error(`${view} ${mode}: ${frames.at(-1)!.msPerFrame} ms, ${frames.at(-1)!.drawCalls} draws`);
  }
  await timing.close();

  const review = await open(1280, 720);
  const images = [];
  for (const view of ["game", "mid"] as const) for (const mode of MODES) {
    await review.evaluate(([v, m]) => ((window as any).surfaceTrial as Trial).set({ view: v, mode: m }), [view, mode] as const);
    const file = `${view}-${mode}.jpg`;
    await review.locator("#view").screenshot({ path: path.join(out, file), type: "jpeg", quality: 82 });
    images.push({ file, caption: `${view === "game" ? "Game camera (12 m, 0.42 rad, 50°)" : "30 m camera"} · ${mode === "baked" ? "baked" : `layered, ${mode} weathering`}` });
  }
  await review.close();

  const tarBytes = async (file: string) => (await readFile(file)).byteLength;
  const kit = (name: "baked" | "layered", tar: string) => ({
    "release tar (MB)": 0, "texture files (MB)": +(costs[name].files.textureFiles / 1048576).toFixed(2), "geometry files (MB)": +(costs[name].files.geometryFiles / 1048576).toFixed(2),
    "texture GPU memory (MB)": +(costs[name].bytes / 1048576).toFixed(2), textures: costs[name].textures, "kit materials": costs[name].materials, tar,
  });
  const kits = { baked: kit("baked", bakedTar), layered: kit("layered", layeredTar) };
  kits.baked["release tar (MB)"] = +((await tarBytes(bakedTar)) / 1048576).toFixed(2);
  kits.layered["release tar (MB)"] = +((await tarBytes(layeredTar)) / 1048576).toFixed(2);
  for (const each of Object.values(kits)) delete (each as Partial<typeof each>).tar;
  const results = {
    schema: "limestone-surface-trial-results-v1",
    machine: {
      renderer: gpu, browser: `Chromium ${browser.version()} (Playwright, headless)`, viewport: "1920 x 1080, antialias, pixel ratio 1",
      note: `Frame time is the median of ${RUNS} runs of 240 frames rendered back to back and waited for (readPixels), so no vsync. ${instances} rock instances, no shadows. Texture GPU memory counts the transcoded mip chains this browser uploaded; the layered row is the shared library, which every layered kit reuses.`,
    },
    kits, frames, images,
  };
  await writeFile(path.join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  server.stop(true);
  await rm(site, { recursive: true, force: true });
}
