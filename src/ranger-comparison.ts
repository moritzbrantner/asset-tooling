// Data for the Ranger source-versus-processed comparison page (#111, owner answers Q1 = A and
// Q2 = A, 2026-10-17), written to dist/pages/compare/ranger/ by scripts/build-catalog-pages.ts.
// It copies the exact canonical bytes of the Ranger source (Universal Base Characters body and
// Male_Ranger outfit with every referenced resource) and of the two clip libraries, the verified
// release tar of the processed bundle, and the primitive-built archer OBJ. Every copied file is
// pinned in data.json; the browser re-verifies each pin before rendering.
// Contract: docs/animation-viewer.md#ranger-comparison.
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readAssetBundleTar, verifyAssetBundleTar } from "./asset-bundle-pack.js";
import { sha256Bytes } from "./hash.js";
import { generateMedievalCharacterObj } from "./medieval-character-kit.js";

type Json = Record<string, any>;
export type PinnedFile = { path: string; sha256: string; byteLength: number };
export type PinnedGltf = { document: PinnedFile; resources: Record<string, PinnedFile> };

/** The processed bundle the page compares: a published release, pinned like any consumer pins it. */
export const RANGER_COMPARISON_BUNDLE = {
  tag: "humanoid-ranger-male-v7",
  url: "https://github.com/moritzbrantner/asset-tooling/releases/tag/humanoid-ranger-male-v7",
  tarSha256: "62bbe8637421f6ef22fa4f91ff329ba1b8092836bb47e202bf5e6dfa3f9b0c0a",
  exportRef: {
    byteLength: 11744, kind: "asset-bundle", mediaType: "application/vnd.moritzbrantner.asset-bundle+json",
    metadata: {}, schemaVersion: 1, sha256: "f211bdbdcf086a4af1c887afa9ecbd34ad7945ca1067f72ef119182a8d3ed8c7",
  },
  key: "humanoid.ranger.male",
  variant: "default",
} as const;

/** Original Ranger source members (docs/humanoid-ranger.md) and the clip libraries the bundle retargets. */
export const RANGER_COMPARISON_SOURCES = {
  body: { archive: "quaternius.universal-base-characters-standard", path: "Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf" },
  outfit: { archive: "quaternius.modular-character-outfits-fantasy-standard", path: "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Ranger.gltf" },
  libraries: [
    { archive: "quaternius.universal-animation-library-standard", path: "Animation Library[Standard]/Godot/AnimationLibrary_Godot_Standard.glb", label: "UAL1 mannequin" },
    { archive: "quaternius.universal-animation-library-2-standard", path: "Universal Animation Library 2 [Standard]/Unreal-Godot/UAL2_Standard.glb", label: "UAL2 mannequin" },
  ],
} as const;

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

export type RangerComparisonData = {
  schema: "ranger-comparison-v1";
  ranger: { body: PinnedGltf; outfit: PinnedGltf; bodyId: string; outfitId: string };
  libraries: { catalogId: string; label: string; file: PinnedFile }[];
  bundle: { tag: string; url: string; tarSha256: string; key: string; variant: string; manifest: string };
  archer: { file: PinnedFile; unitScale: number };
};

/**
 * Writes the comparison data into `outDir`. Returns `{status: "unavailable", reason}` without writing
 * anything when the canonical payloads are LFS pointers or no bundle tar is given, unless `require` is
 * set, in which case it throws. Any pin mismatch always throws.
 */
export async function writeRangerComparisonData({ repositoryRoot, outDir, bundleTar, require = false }: {
  repositoryRoot: string; outDir: string; bundleTar?: string; require?: boolean;
}): Promise<{ status: "built"; data: RangerComparisonData } | { status: "unavailable"; reason: string }> {
  const sources: Json[] = JSON.parse(await readFile(path.join(repositoryRoot, "catalog/sources.json"), "utf8")).sources;
  const storage: Json[] = JSON.parse(await readFile(path.join(repositoryRoot, "catalog/storage.json"), "utf8")).entries;
  const unavailable = (reason: string) => {
    if (require) throw new Error(`Ranger comparison data unavailable: ${reason}`);
    return { status: "unavailable" as const, reason };
  };
  const memberId = ({ archive, path: memberPath }: { archive: string; path: string }) => {
    const matches = sources.filter((source) => source.archiveMember?.archive === archive && source.archiveMember?.path === memberPath);
    if (matches.length !== 1) throw new Error(`'${memberPath}' must be registered exactly once in '${archive}'`);
    return matches[0]!.id as string;
  };
  const resourceId = (archive: string, gltfId: string, uri: string) => {
    const substitutes = sources.filter((source) => source.metadata?.substitutesFor?.member === gltfId && source.metadata.substitutesFor.uri === uri);
    if (substitutes.length === 1) return substitutes[0]!.id as string;
    const matches = sources.filter((source) => source.archiveMember?.archive === archive && path.posix.basename(source.archiveMember.path) === uri);
    if (matches.length !== 1) throw new Error(`URI '${uri}' must resolve to exactly one member of '${archive}'`);
    return matches[0]!.id as string;
  };
  // Reads one hydrated member, checked against its catalog pin; undefined while it is an LFS pointer.
  const readMember = async (sourceId: string) => {
    const source = sources.find((candidate) => candidate.id === sourceId)!;
    const entry = storage.find((candidate) => candidate.sourceId === sourceId);
    if (!entry) throw new Error(`'${sourceId}' has no storage entry`);
    const bytes = await readFile(path.join(repositoryRoot, entry.path));
    if (bytes.subarray(0, 128).toString("utf8").startsWith(LFS_POINTER_PREFIX)) return undefined;
    const pin = source.source;
    if (bytes.byteLength !== pin.byteLength || sha256Bytes(bytes) !== pin.sha256) throw new Error(`'${sourceId}' bytes do not match its catalog pin`);
    return { bytes, name: path.posix.basename(entry.path) };
  };

  const files = new Map<string, Uint8Array>();
  const add = (bytes: Uint8Array, name: string): PinnedFile => {
    const sha256 = sha256Bytes(bytes);
    const file = `sources/${sha256}${path.posix.extname(name)}`;
    files.set(file, bytes);
    return { path: file, sha256, byteLength: bytes.byteLength };
  };
  const gltf = async (member: { archive: string; path: string }): Promise<PinnedGltf | undefined> => {
    const id = memberId(member);
    const document = await readMember(id);
    if (!document) return undefined;
    const json = JSON.parse(Buffer.from(document.bytes).toString("utf8"));
    const resources: Record<string, PinnedFile> = {};
    for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
      if (typeof item.uri !== "string") continue;
      const resource = await readMember(resourceId(member.archive, id, item.uri));
      if (!resource) return undefined;
      resources[item.uri] = add(resource.bytes, resource.name);
    }
    return { document: add(document.bytes, document.name), resources };
  };

  const body = await gltf(RANGER_COMPARISON_SOURCES.body);
  const outfit = await gltf(RANGER_COMPARISON_SOURCES.outfit);
  const libraries: RangerComparisonData["libraries"] = [];
  for (const library of RANGER_COMPARISON_SOURCES.libraries) {
    const catalogId = memberId(library);
    const member = await readMember(catalogId);
    if (!member) return unavailable("the canonical humanoid payloads are Git LFS pointers; run 'git lfs pull'");
    libraries.push({ catalogId, label: library.label, file: add(member.bytes, member.name) });
  }
  if (!body || !outfit) return unavailable("the canonical humanoid payloads are Git LFS pointers; run 'git lfs pull'");
  if (!bundleTar) return unavailable(`no ${RANGER_COMPARISON_BUNDLE.tag} tar given (ASSET_TOOLING_RANGER_BUNDLE_TAR)`);

  const tar = await readFile(bundleTar);
  await verifyAssetBundleTar(tar, { sha256: RANGER_COMPARISON_BUNDLE.tarSha256, ref: RANGER_COMPARISON_BUNDLE.exportRef });
  for (const entry of readAssetBundleTar(tar)) files.set(`bundle/${entry.path}`, entry.bytes);

  const archer = add(Buffer.from(generateMedievalCharacterObj("archer").bytes), "archer.obj");
  const data: RangerComparisonData = {
    schema: "ranger-comparison-v1",
    ranger: { body, outfit, bodyId: memberId(RANGER_COMPARISON_SOURCES.body), outfitId: memberId(RANGER_COMPARISON_SOURCES.outfit) },
    libraries,
    bundle: {
      tag: RANGER_COMPARISON_BUNDLE.tag, url: RANGER_COMPARISON_BUNDLE.url, tarSha256: RANGER_COMPARISON_BUNDLE.tarSha256,
      key: RANGER_COMPARISON_BUNDLE.key, variant: RANGER_COMPARISON_BUNDLE.variant, manifest: "bundle/manifest.json",
    },
    archer: { file: archer, unitScale: 0.001 },
  };
  await rm(outDir, { recursive: true, force: true });
  for (const [file, bytes] of files) {
    await mkdir(path.dirname(path.join(outDir, file)), { recursive: true });
    await writeFile(path.join(outDir, file), bytes);
  }
  await writeFile(path.join(outDir, "data.json"), `${JSON.stringify(data, null, 2)}\n`);
  return { status: "built", data };
}
