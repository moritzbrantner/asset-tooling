// Promote the verified #406 regional candidates into one content-pinned rolling release.
// Acquisition is an explicit separate CI step; this build never downloads data or executables.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { readAssetBundleTar, writeAssetBundleTar } from "../src/asset-bundle-pack.ts";
import { canonicalJson } from "../src/canonical.ts";
import { sha256Bytes } from "../src/hash.ts";
import {
  validateMapsArchiveCandidate,
  verifyMapsArchive,
  type MapsArchiveCandidate,
} from "../src/maps-shortbread.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const CANDIDATES = path.join(ROOT, ".asset-tooling/maps-shortbread");
const RELEASE = "maps-shortbread";
const INDEX = "maps-shortbread.json";
const TAR = `${RELEASE}.tar`;
const REF = "export.ref.json";

export type PublishedRegionPin = {
  name: string;
  sourceId: string;
  sha256: string;
  bytes: number;
};

// Reviewed real-world #409 output hashes. A drifted regeneration must get a new review,
// not silently replace an immutable Maps dataRevision or filename.
export const APPROVED_REGIONS: readonly PublishedRegionPin[] = [
  {
    name: "liechtenstein",
    sourceId: "maps-liechtenstein",
    sha256: "749bc3ac9a430b41fb7613686b7898b43ed11d8e8321624559ea591f49cc8fdf",
    bytes: 2_780_045,
  },
  {
    name: "liechtenstein-north",
    sourceId: "maps-liechtenstein-north",
    sha256: "7761a554051b9d8a77cf9c1f790b03a4e66a15fbe91dde46c488a10e0f95bf3e",
    bytes: 1_366_814,
  },
];

export const OSM_SOURCE = {
  provider: "Geofabrik",
  url: "https://download.geofabrik.de/europe/liechtenstein-261025.osm.pbf",
  sha256: "bd5cca3fdcb4e9900ad74b4c33e554750088705bd4b4deaa35c1517d7be2378b",
  snapshot: "2026-10-25T21:21:21Z",
  license: "ODbL-1.0",
  licenseUrl: "https://www.openstreetmap.org/copyright",
} as const;

export type MapsShortbreadReleaseIndex = {
  schema: "maps-shortbread-release-v1";
  release: typeof RELEASE;
  source: typeof OSM_SOURCE;
  tilesets: MapsArchiveCandidate[];
};

export function publicationFilename(pin: PublishedRegionPin): string {
  return `${pin.name}-${pin.sha256}.pmtiles`;
}

function verifiedMetadata(
  original: MapsArchiveCandidate,
  pin: PublishedRegionPin,
  source: typeof OSM_SOURCE,
): MapsArchiveCandidate {
  validateMapsArchiveCandidate(original);
  if (
    original.sourceId !== pin.sourceId ||
    original.archiveRef.sha256 !== pin.sha256 ||
    original.archiveRef.bytes !== pin.bytes ||
    original.license !== source.license ||
    original.observation.snapshot !== source.snapshot ||
    !original.attribution.includes("OpenStreetMap contributors") ||
    !original.provenance.includes(source.sha256)
  ) {
    throw new Error(
      `Maps ${pin.name}: the candidate differs from the reviewed source or archive pin`,
    );
  }
  return {
    ...original,
    provenance: original.provenance.replace(
      "Candidate only; no owner approval or runtime transport claim.",
      "Published and content-pinned for Maps #270; browser transport is independently verified by Maps.",
    ),
    archiveRef: { ...original.archiveRef, path: publicationFilename(pin) },
  };
}

export function createMapsShortbreadReleaseIndex(
  candidates: readonly MapsArchiveCandidate[],
  pins: readonly PublishedRegionPin[] = APPROVED_REGIONS,
  source: typeof OSM_SOURCE = OSM_SOURCE,
): MapsShortbreadReleaseIndex {
  if (candidates.length !== pins.length) {
    throw new Error("Maps release requires every approved regional candidate");
  }
  const tilesets = pins.map((pin, index) => verifiedMetadata(candidates[index]!, pin, source));
  if (new Set(tilesets.map((tileset) => tileset.dataRevision)).size !== tilesets.length) {
    throw new Error("Maps release contains a revision collision");
  }
  return { schema: "maps-shortbread-release-v1", release: RELEASE, source, tilesets };
}

function indexBytes(index: MapsShortbreadReleaseIndex): Buffer {
  return Buffer.from(`${canonicalJson(index)}\n`);
}

function refBytes(index: Buffer): Buffer {
  return Buffer.from(
    `${canonicalJson({ schema: "maps-shortbread-ref-v1", sha256: sha256Bytes(index), byteLength: index.length })}\n`,
  );
}

export async function buildMapsShortbreadRelease(outDir: string): Promise<void> {
  // Existing generation verifies both the original receipts and actual archive contents.
  execFileSync("bun", ["examples/maps-shortbread/build.ts", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 420_000,
  });
  const candidates = await Promise.all(
    APPROVED_REGIONS.map(async (pin) =>
      JSON.parse(await readFile(path.join(CANDIDATES, `${pin.name}.manifest.json`), "utf8")),
    ),
  );
  const index = createMapsShortbreadReleaseIndex(candidates);
  await mkdir(outDir, { recursive: true });
  const entries: { path: string; bytes: Buffer }[] = [];
  for (const [offset, pin] of APPROVED_REGIONS.entries()) {
    const bytes = await readFile(path.join(CANDIDATES, `${pin.name}.pmtiles`));
    await verifyMapsArchive(bytes, index.tilesets[offset]);
    const publishedName = publicationFilename(pin);
    await copyFile(path.join(CANDIDATES, `${pin.name}.pmtiles`), path.join(outDir, publishedName));
    entries.push({ path: publishedName, bytes });
  }
  const manifest = indexBytes(index);
  const ref = refBytes(manifest);
  entries.push({ path: INDEX, bytes: manifest }, { path: REF, bytes: ref });
  await writeFile(path.join(outDir, INDEX), manifest);
  await writeFile(path.join(outDir, REF), ref);
  const tar = writeAssetBundleTar(entries);
  await writeFile(path.join(outDir, TAR), tar);
  await writeFile(path.join(outDir, `${TAR}.sha256`), `${sha256Bytes(tar)}  ${TAR}\n`);
  await verifyMapsShortbreadRelease(outDir);
}

/** Verify the complete published directory and the canonical tar without trusting a release name. */
export async function verifyMapsShortbreadRelease(
  outDir: string,
  pins: readonly PublishedRegionPin[] = APPROVED_REGIONS,
  source: typeof OSM_SOURCE = OSM_SOURCE,
): Promise<{ verified: true; files: number; sha256: string }> {
  const manifest = await readFile(path.join(outDir, INDEX));
  const parsed: unknown = JSON.parse(manifest.toString("utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as MapsShortbreadReleaseIndex).tilesets)
  ) {
    throw new Error("Maps release index is malformed");
  }
  const index = parsed as MapsShortbreadReleaseIndex;
  if (
    index.schema !== "maps-shortbread-release-v1" ||
    index.release !== RELEASE ||
    canonicalJson(index.source) !== canonicalJson(source) ||
    index.tilesets.length !== pins.length ||
    !manifest.equals(indexBytes(index))
  ) {
    throw new Error("Maps release index/source is not the approved canonical metadata");
  }
  const byPath = new Map<string, Buffer>([
    [INDEX, manifest],
    [REF, refBytes(manifest)],
  ]);
  for (const [offset, pin] of pins.entries()) {
    const tileset = index.tilesets[offset]!;
    if (
      tileset.sourceId !== pin.sourceId ||
      tileset.archiveRef.path !== publicationFilename(pin) ||
      tileset.archiveRef.sha256 !== pin.sha256 ||
      tileset.archiveRef.bytes !== pin.bytes ||
      tileset.license !== source.license ||
      tileset.observation.snapshot !== source.snapshot ||
      tileset.provenance.includes("Candidate only")
    ) {
      throw new Error(`Maps release ${pin.name} is not the approved content revision`);
    }
    const bytes = await readFile(path.join(outDir, publicationFilename(pin)));
    await verifyMapsArchive(bytes, tileset);
    byPath.set(publicationFilename(pin), bytes);
  }
  const tar = await readFile(path.join(outDir, TAR));
  const tarHash = sha256Bytes(tar);
  const sidecar = await readFile(path.join(outDir, `${TAR}.sha256`), "utf8");
  if (sidecar !== `${tarHash}  ${TAR}\n`) {
    throw new Error("Maps release tar SHA-256 sidecar is invalid");
  }
  const entries = readAssetBundleTar(tar);
  if (
    entries.length !== byPath.size ||
    entries.some(({ path: file, bytes }) => !byPath.get(file)?.equals(bytes))
  ) {
    throw new Error("Maps release tar differs from the independently verified files");
  }
  const actualFiles = (await readdir(outDir)).sort();
  const approvedFiles = [...byPath.keys(), TAR, `${TAR}.sha256`].sort();
  if (canonicalJson(actualFiles) !== canonicalJson(approvedFiles)) {
    throw new Error("Maps release has unexpected or missing files");
  }
  if (!(await readFile(path.join(outDir, REF))).equals(byPath.get(REF)!)) {
    throw new Error("Maps release manifest reference is invalid");
  }
  return { verified: true, files: entries.length, sha256: tarHash };
}

if (import.meta.main) {
  if (process.argv.length !== 4 || process.argv[2] !== "--out") {
    throw new Error("Usage: bun scripts/build-maps-shortbread-release.ts --out <directory>");
  }
  await buildMapsShortbreadRelease(path.resolve(process.argv[3]!));
}
