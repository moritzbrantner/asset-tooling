// Loads a built release through the game's real loaders before it is published (#691): every glTF/GLB entry of
// its tar (gltf-resources-v1) and of its per-file downloads (asset-downloads-v1), through
//   - three's GLTFLoader with the meshopt decoder and a KTX2Loader, configured as moenarch-games/mmorpg's web client
//     configures them, in real Chromium (scripts/game-loaders/web-check.ts), and
//   - mmorpg's native path: its meshopt/quantization decoder, the `basisu` transcoder and the `gltf` crate
//     (consumers/mmorpg-native, the game's own crate versions).
// With --live <release> only the entries whose files differ from the live release are loaded: a downloads entry
// when one of its files' SHA-256 differs from the live asset digest, every tar entry when the tar differs.
//   bun scripts/check-game-loaders.ts <out> [--live <release>]
// Exits 1 when the game could not load an entry.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WebResult } from "./game-loaders/web-check.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const TOOLING_REPO = process.env.GITHUB_REPOSITORY ?? "moritzbrantner/asset-tooling";
const NATIVE = path.join(ROOT, "consumers/mmorpg-native");

/** One loadable entry: its glTF or GLB file and every file it reads, relative to `root`. */
export type Entry = { id: string; root: string; file: string; files: string[] };

async function sha256(file: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await readFile(file)).digest("hex");
}

/** The entries of every `asset-downloads-v1` index in `dir`: each entry's glTF and the shared clip libraries. */
export async function downloadEntries(dir: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const name of (await readdir(dir)).filter((name) => name.endsWith(".index.json")).sort()) {
    const index = JSON.parse(await readFile(path.join(dir, name), "utf8")) as {
      schema?: string;
      entries?: { key: string; variant: string; files: string[]; textures: string[]; clips?: string }[];
    };
    if (index.schema !== "asset-downloads-v1") continue;
    const clips = new Set<string>();
    for (const entry of index.entries ?? []) {
      const files = [...entry.files, ...entry.textures];
      const scene = entry.files.find((file) => file.endsWith(".gltf") || file.endsWith(".glb"));
      if (scene) entries.push({ id: `${entry.key}/${entry.variant}`, root: dir, file: scene, files });
      if (entry.clips) clips.add(entry.clips);
    }
    for (const file of clips) entries.push({ id: file, root: dir, file, files: [file] });
  }
  return entries;
}

/** The entries of an unpacked `gltf-resources-v1` bundle in `dir`. */
export async function bundleEntries(dir: string): Promise<Entry[]> {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as {
    assets?: { key: string; variant: string; path: string; resources?: { path: string }[] }[];
  };
  return (manifest.assets ?? [])
    .filter((asset) => /\.(gltf|glb)$/.test(asset.path))
    .map((asset) => ({
      id: `${asset.key}/${asset.variant}`,
      root: dir,
      file: asset.path,
      files: [asset.path, ...(asset.resources ?? []).map((resource) => resource.path)],
    }));
}

/** The live release's assets by name with their SHA-256, or undefined when it cannot be read. */
function liveDigests(release: string): Map<string, string> | undefined {
  const result = spawnSync("gh", ["api", `repos/${TOOLING_REPO}/releases/tags/${release}`, "--jq", ".assets[] | [.name, .digest // \"\"] | @tsv"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return new Map(result.stdout.split("\n").filter(Boolean).map((line) => {
    const [name, digest] = line.split("\t");
    return [name!, (digest ?? "").replace(/^sha256:/, "")];
  }));
}

/** Whether any of `entry`'s files differs from the live release's asset of that name. */
async function changed(entry: Entry, live: Map<string, string>): Promise<boolean> {
  for (const file of entry.files) {
    if (live.get(path.basename(file)) !== await sha256(path.join(entry.root, file))) return true;
  }
  return false;
}

/** Loads `entries` in Chromium through three's loaders, as the game's web client does. */
async function webCheck(entries: Entry[]): Promise<WebResult[]> {
  const { chromium } = await import("@playwright/test");
  const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "game-loaders/web-check.ts")], target: "browser", minify: true });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const script = await built.outputs[0]!.text();
  const basis = path.join(ROOT, "node_modules/three/examples/jsm/libs/basis");
  const origin = "http://game-loaders.invalid";
  const roots = [...new Set(entries.map((entry) => entry.root))];
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage();
    await page.route(`${origin}/**`, async (route) => {
      const url = new URL(route.request().url());
      const send = async (file: string, contentType?: string) => {
        if (!existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
        return route.fulfill({ body: Buffer.from(await readFile(file)), ...(contentType ? { contentType } : {}) });
      };
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><script type="module" src="check.js"></script>` });
      if (url.pathname === "/check.js") return route.fulfill({ contentType: "text/javascript", body: script });
      if (url.pathname.startsWith("/basis/")) return send(path.join(basis, path.basename(url.pathname)), url.pathname.endsWith(".wasm") ? "application/wasm" : "text/javascript");
      const match = /^\/root(\d+)\/(.+)$/.exec(decodeURIComponent(url.pathname));
      const root = match ? roots[Number(match[1])] : undefined;
      if (!match || !root) return route.fulfill({ status: 404, body: "not found" });
      const file = path.resolve(root, match[2]!);
      if (!file.startsWith(root + path.sep)) return route.fulfill({ status: 403, body: "outside the release" });
      return send(file);
    });
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => typeof window.checkGameLoaders === "function", undefined, { timeout: 60_000 });
    const urls = entries.map((entry) => `${origin}/root${roots.indexOf(entry.root)}/${entry.file}`);
    return await page.evaluate((list) => window.checkGameLoaders(list), urls);
  } finally {
    await browser.close();
  }
}

type NativeResult = { file: string; ok: boolean; error?: string; summary?: unknown };

/** Loads `entries` through the game's native path (consumers/mmorpg-native), built here with its locked crates. */
function nativeCheck(entries: Entry[]): NativeResult[] {
  const target = path.join(NATIVE, "target");
  const build = spawnSync("cargo", ["build", "--release", "--locked", "--quiet", "--manifest-path", path.join(NATIVE, "Cargo.toml")], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? target },
  });
  if (build.status !== 0) throw new Error("could not build consumers/mmorpg-native");
  const binary = path.join(process.env.CARGO_TARGET_DIR ?? target, "release", "mmorpg-native-consumer");
  const run = spawnSync(binary, entries.map((entry) => path.join(entry.root, entry.file)), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  return run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as NativeResult);
}

export async function checkGameLoaders(out: string, live?: string): Promise<boolean> {
  const dir = path.resolve(out);
  const names = await readdir(dir);
  const digests = live ? liveDigests(live) : undefined;
  if (live && !digests) console.log(`${live}: the live release cannot be read; loading every entry`);
  const unpacked: string[] = [];
  try {
    let entries = await downloadEntries(dir);
    if (digests) entries = (await Promise.all(entries.map(async (entry) => (await changed(entry, digests)) ? entry : undefined))).filter((entry) => entry !== undefined);
    for (const tar of names.filter((name) => name.endsWith(".tar"))) {
      if (digests && digests.get(tar) === await sha256(path.join(dir, tar))) continue;
      const target = await mkdtemp(path.join(tmpdir(), "game-loaders-"));
      unpacked.push(target);
      const extract = spawnSync("tar", ["-xf", path.join(dir, tar), "-C", target]);
      if (extract.status !== 0) throw new Error(`could not unpack ${tar}`);
      if (existsSync(path.join(target, "manifest.json"))) entries.push(...(await bundleEntries(target)).map((entry) => ({ ...entry, id: `${tar}:${entry.id}` })));
    }
    if (entries.length === 0) {
      console.log(JSON.stringify({ status: "unchanged", checked: 0 }));
      return true;
    }
    console.log(`Loading ${entries.length} changed entries through the game's web and native loaders`);
    const web = await webCheck(entries);
    const native = nativeCheck(entries);
    const failures = entries.flatMap((entry, index) => {
      const problems: string[] = [];
      const page = web[index];
      if (!page || !page.ok) problems.push(`web: ${page && !page.ok ? page.error : "no result"}`);
      const desktop = native[index];
      if (!desktop || !desktop.ok) problems.push(`native: ${desktop?.error ?? "no result"}`);
      return problems.length ? [`${entry.id} (${entry.file}): ${problems.join("; ")}`] : [];
    });
    for (const failure of failures) console.error(`The game could not load ${failure}`);
    console.log(JSON.stringify({ status: failures.length ? "refused" : "accepted", checked: entries.length, failed: failures.length }));
    return failures.length === 0;
  } finally {
    await Promise.all(unpacked.map((target) => rm(target, { recursive: true, force: true })));
  }
}

if (import.meta.main) {
  const [out, flag, release, ...rest] = process.argv.slice(2);
  if (!out || rest.length || (flag !== undefined && (flag !== "--live" || !release))) {
    console.error("Usage: bun scripts/check-game-loaders.ts <out> [--live <release>]");
    process.exit(2);
  }
  process.exit((await checkGameLoaders(out, release)) ? 0 : 1);
}
