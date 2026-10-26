import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256Bytes, sha256File } from "./hash.js";
import { type AssetSpecDocument, type AssetArtifactReference, resolveSpecPath } from "./schema.js";

const execute = promisify(execFile);
const ID = "external.planetiler.shortbread";
const JAR_SHA256 = "f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d";

function validate(document: AssetSpecDocument) {
  const { spec } = document;
  if (Object.keys(spec.inputs).sort().join() !== "osm,planetiler,profile" || Object.keys(spec.models).length || spec.randomness.mode !== "none") {
    throw new Error(`${ID} requires profile, osm and planetiler inputs, no models and no randomness`);
  }
  if (spec.inputs.planetiler!.sha256 !== JAR_SHA256) { throw new Error("Planetiler must match pinned v0.10.2 JAR"); }
  const p = spec.parameters;
  if (Object.keys(p).sort().join() !== "bounds,javaVersion,maxZoom,minZoom") { throw new Error("unsupported Planetiler parameters"); }
  if (typeof p.javaVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(p.javaVersion)) { throw new Error("javaVersion must be an exact release"); }
  const b = p.bounds;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(n => typeof n === "number" && Number.isFinite(n))) { throw new Error("bounds must contain four finite degrees"); }
  // Narrowed JSON array elements are numbers after the all-elements guard above.
  const [west, south, east, north] = b as number[];
  if (west === undefined || south === undefined || east === undefined || north === undefined || west < -180 || east > 180 || south < -85 || north > 85 || east <= west || north <= south || east - west > 1 || north - south > 1) { throw new Error("bounds must describe a non-wrapping region of at most one degree per axis"); }
  const { minZoom, maxZoom } = p;
  if (typeof minZoom !== "number" || typeof maxZoom !== "number" || !Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom < 0 || maxZoom > 14 || minZoom > maxZoom) { throw new Error("zooms must be integral, ordered and within 0..14"); }
  return { bounds: [west, south, east, north], minZoom, maxZoom, javaVersion: p.javaVersion };
}

async function directoryBytes(root: string): Promise<number> {
  let result = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) { result += await directoryBytes(file); }
    else if (entry.isFile()) { try { result += (await stat(file)).size; } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { throw error; } } }
  }
  return result;
}

export async function readPlanetilerInput(root: string, name: string, artifact: AssetArtifactReference) {
  const inputPath = resolveSpecPath(root, artifact.path);
  const budget = name === "osm" ? 16 * 1024 * 1024 : name === "profile" ? 65536 : 128 * 1024 * 1024;
  if ((await stat(inputPath)).size > budget) { throw new Error(`input ${name} exceeds regional recipe size budget`); }
  const bytes = await readFile(inputPath);
  // Retain size and identity checks across the stat/read mutation window.
  if (bytes.length > budget) { throw new Error(`input ${name} exceeds regional recipe size budget`); }
  if (sha256Bytes(bytes) !== artifact.sha256) { throw new Error(`input '${name}' bytes changed before execution`); }
  return bytes;
}

export const PLANETILER_BACKEND = {
  id: ID, version: "1", kind: "utility", exactCapable: false,
  validate,
  async environmentComponents(document: AssetSpecDocument) {
    const p = validate(document);
    const java = Bun.which("java");
    if (!java) { throw new Error("Java must be acquired before generation"); }
    const result = await execute(java, ["-version"], { timeout: 10000, env: { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C", TZ: "UTC" } });
    const stderr = result.stderr;
    if (!stderr.includes(`version "${p.javaVersion}"`)) { throw new Error(`Java does not match declared version ${p.javaVersion}: ${stderr}`); }
    return [{ id: "java", version: p.javaVersion, executableSha256: await sha256File(java) },
      { id: "planetiler", jarSha256: document.spec.inputs.planetiler!.sha256, heapMiB: 1024, threads: 2 }];
  },
  async generate(document: AssetSpecDocument) {
    const p = validate(document);
    await this.environmentComponents(document);
    const root = await mkdtemp(path.join(tmpdir(), "asset-shortbread-"));
    try {
      // Snapshot and recheck ALL bytes before crossing the subprocess boundary.
      for (const [name, artifact] of Object.entries(document.spec.inputs)) {
        const bytes = await readPlanetilerInput(document.root, name, artifact);
        await writeFile(path.join(root, name), bytes);
      }
      const profile = await readFile(path.join(root, "profile"), "utf8");
      const parsed: unknown = Bun.YAML.parse(profile);
      if (!parsed || typeof parsed !== "object" || !("sources" in parsed) || JSON.stringify(parsed.sources) !== JSON.stringify({ osm: { type: "osm", local_path: "${ args.input_path }" } }) || /\burl:/.test(profile)) {
        throw new Error("profile must use only the declared local OSM source; acquisition is separate");
      }
      const output = path.join(root, "output.pmtiles");
      const java = Bun.which("java");
      if (!java) { throw new Error("Java unavailable"); }
      const start = performance.now();
      let sampledPeakTemporaryBytes = await directoryBytes(root);
      let sampling = Promise.resolve();
      const timer = setInterval(() => {
        sampling = sampling.then(async () => { sampledPeakTemporaryBytes = Math.max(sampledPeakTemporaryBytes, await directoryBytes(root)); });
      }, 100);
      let stderr: string;
      try {
      const result = await execute("/usr/bin/time", ["-f", "asset_peak_rss_kib=%M", "timeout", "--kill-after=5", "180", java, "-Xmx1g", "-jar", path.join(root, "planetiler"), "generate-custom",
        `--schema=${path.join(root, "profile")}`, `--input_path=${path.join(root, "osm")}`, `--output=${output}`,
        `--bounds=${p.bounds.join(",")}`, `--minzoom=${p.minZoom}`, `--maxzoom=${p.maxZoom}`, "--threads=2", "--nodemap_storage=ram", `--tmpdir=${path.join(root, "work")}`,
        "--download=false", "--force", "--keep_unzipped=false"],
        { cwd: root, timeout: 190000, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C", TZ: "UTC" } });
      stderr = result.stderr;
      } finally { clearInterval(timer); await sampling; }
      const bytes = await readFile(output);
      console.error(JSON.stringify({ operation: "planetiler-generation", metrics: { wallTimeMs: Math.round(performance.now() - start), peakRssKiB: Number(stderr.match(/asset_peak_rss_kib=(\d+)/)?.[1] ?? 0),
        sampledPeakTemporaryBytes, temporaryDiskMeasurement: "logical file bytes sampled every 100ms including input snapshots; lower bound on instantaneous peak", archiveBytes: bytes.length,
        generator: "Planetiler v0.10.2", reproducibility: "provenance/content only; exact bytes not promised" } }));
      return { bytes, observations: { generator: "Planetiler v0.10.2", archiveBytes: bytes.length, schema: "shortbread/1.0", repro: "provenance/content only" } };
    } finally { await rm(root, { recursive: true, force: true }); }
  },
};
