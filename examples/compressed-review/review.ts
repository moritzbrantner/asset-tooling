// Render uncompressed-versus-compressed comparisons in headless Chromium with three.js (#124):
//   bun examples/compressed-review/review.ts --bundle <gltf-resources bundle dir> --downloads <pack-downloads dir> --out <dir> \
//     --case <key>/<variant>@<distance>[,<clip>] [--case ...] [--clips <clips.glb file name>]
// Each case writes <out>/<key>.<variant>.<distance>m.png: the bundle's PNG-textured scene on the left and the
// KTX2 + meshopt download on the right, framed from the given distance under the same light.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const args = process.argv.slice(2), option = (flag: string) => args.flatMap((value, index) => (value === flag ? [args[index + 1]!] : []));
const [bundle] = option("--bundle"), [downloads] = option("--downloads"), [out] = option("--out"), [clips] = option("--clips");
if (!bundle || !downloads || !out) throw new Error("usage: review.ts --bundle <dir> --downloads <dir> --out <dir> --case <key>/<variant>@<distance>[,<clip>]");
await mkdir(out, { recursive: true });
const server = Bun.serve({ port: 0, async fetch(request) {
  const url = new URL(request.url);
  const file = url.pathname.startsWith("/bundle/") ? path.join(bundle, url.pathname.slice(8))
    : url.pathname.startsWith("/dl/") ? path.join(downloads, url.pathname.slice(4))
      : url.pathname.startsWith("/three/") ? path.join(ROOT, "node_modules/three", url.pathname.slice(7)) : path.join(HERE, "index.html");
  const body = Bun.file(file);
  return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
} });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 600 } });
  for (const spec of option("--case")) {
    const [entry, rest] = spec.split("@") as [string, string];
    const [distance, clip] = rest.split(",");
    const [key, variant] = entry.split("/") as [string, string];
    const query = new URLSearchParams({ left: `/bundle/scenes/${key}/${variant}.gltf`, right: `/dl/${key}.${variant}.gltf`, distance: distance! });
    if (clips) { query.set("clips", `/dl/${clips}`); if (clip) query.set("clip", clip); }
    await page.goto(`http://localhost:${server.port}/?${query}`);
    await page.waitForFunction(() => document.title !== "", null, { timeout: 120_000 });
    const title = await page.title();
    if (title !== "ok") throw new Error(`${spec}: ${title}`);
    const file = path.join(out, `${key}.${variant}.${distance}m.png`);
    await page.screenshot({ path: file });
    console.error(`[review] ${file}`);
  }
} finally {
  await browser.close();
  server.stop();
}
