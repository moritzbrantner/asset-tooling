// Acceptance for the Greyhaven starter source members (#118), per
// docs/greyhaven-starter-sources.md. The structure checks read the committed
// catalog and run in ordinary `bun run check`. The resource-closure and
// integrity checks need hydrated Git LFS payloads: they skip with a reason when
// the payloads are pointers, and fail instead when
// ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 (set it in the hosted
// canonical-storage job).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "../src/hash.js";
import { createAssetCatalog } from "../src/catalog.js";
import {
  createAssetCatalogStorageManifest,
  readAssetCatalogStorageSource,
  verifyAssetCatalogStorageBytes,
} from "../src/catalog-storage.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const REQUIRE_HYDRATED = process.env.ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE === "1";

const MEDIEVAL = "quaternius.medieval-village-megakit-standard";
const FANTASY = "quaternius.fantasy-props-megakit-standard";
const NATURE = "quaternius.stylized-nature-megakit-standard";
const ARCHIVES = [MEDIEVAL, FANTASY, NATURE] as const;

const NATURE_URL = "https://opengameart.org/sites/default/files/stylized_nature_megakitstandard.zip";
const NATURE_BYTE_LENGTH = 104_088_529;
const NATURE_SHA256 = "298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9";
const NATURE_EVIDENCE_URL = "https://quaternius.com/packs/stylizednaturemegakit.html";

type Role = "building" | "door" | "door-frame" | "prop" | "tree";
const ROLES: readonly Role[] = ["building", "door", "door-frame", "prop", "tree"];

/** Expands one brace set, e.g. `glTF/T_WoodTrim_{Normal,BaseColor}.png`. */
function expand(pattern: string): string[] {
  const match = /^(.*)\{([^{}]+)\}(.*)$/.exec(pattern);
  if (!match) return [pattern];
  const [, prefix, alternatives, suffix] = match as unknown as [string, string, string, string];
  return alternatives.split(",").map((alternative) => `${prefix}${alternative}${suffix}`);
}

interface Asset {
  role: Role;
  archive: string;
  gltf: string;
  referenced: string[];
}

// The spec's "Selected assets and their complete member sets" table, verbatim.
const ASSETS: Asset[] = [
  {
    role: "building",
    archive: MEDIEVAL,
    gltf: "glTF/Wall_Plaster_Door_Flat.gltf",
    referenced: [
      "glTF/Wall_Plaster_Door_Flat.bin",
      ...expand("glTF/T_WoodTrim_{Normal,BaseColor,Roughness}.png"),
      ...expand("glTF/T_Plaster_{Normal,BaseColor,ORM}.png"),
      ...expand("glTF/T_RockTrim_{Normal,BaseColor,ORM}.png"),
    ],
  },
  {
    role: "door",
    archive: MEDIEVAL,
    gltf: "glTF/Door_1_Flat.gltf",
    referenced: ["glTF/Door_1_Flat.bin", ...expand("glTF/T_WoodTrim_{Normal,BaseColor,Roughness}.png")],
  },
  {
    role: "door-frame",
    archive: MEDIEVAL,
    gltf: "glTF/DoorFrame_Flat_WoodDark.gltf",
    referenced: ["glTF/DoorFrame_Flat_WoodDark.bin", ...expand("glTF/T_WoodTrim_{Normal,BaseColor,Roughness}.png")],
  },
  {
    role: "prop",
    archive: FANTASY,
    gltf: "Exports/glTF/Barrel.gltf",
    referenced: [
      "Exports/glTF/Barrel.bin",
      ...expand("Textures/T_Trim_Furniture_{Normal,BaseColor,ORM}.png"),
      ...expand("Textures/T_Trim_Metal_{Normal,BaseColor,ORM}.png"),
    ],
  },
  {
    role: "tree",
    archive: NATURE,
    gltf: "glTF/CommonTree_1.gltf",
    referenced: [
      "glTF/CommonTree_1.bin",
      "glTF/Bark_NormalTree_Normal.png",
      "glTF/Bark_NormalTree.png",
      "glTF/Leaves_NormalTree_C.png",
    ],
  },
];

function memberId(archive: string, memberPath: string): string {
  const slug = path.posix.basename(memberPath).toLowerCase().replaceAll("_", "-").replaceAll(".", "-");
  return `${archive}.${slug}`;
}

const MEDIA_TYPES: Record<string, { mediaType: string; kind: string }> = {
  ".gltf": { mediaType: "model/gltf+json", kind: "mesh" },
  ".bin": { mediaType: "application/octet-stream", kind: "buffer" },
  ".png": { mediaType: "image/png", kind: "texture" },
};

interface ExpectedMember {
  id: string;
  archive: string;
  path: string;
  mediaType: string;
  kind: string;
  roles: Set<Role>;
  storagePath: string;
}

const EXPECTED = new Map<string, ExpectedMember>();
for (const asset of ASSETS) {
  for (const memberPath of [asset.gltf, ...asset.referenced]) {
    const id = memberId(asset.archive, memberPath);
    const existing = EXPECTED.get(id);
    if (existing) {
      assert.equal(existing.path, memberPath, `expected-member table: id '${id}' names two paths`);
      existing.roles.add(asset.role);
      continue;
    }
    const type = MEDIA_TYPES[path.posix.extname(memberPath)];
    assert.ok(type, `expected-member table: no media type for '${memberPath}'`);
    EXPECTED.set(id, {
      id,
      archive: asset.archive,
      path: memberPath,
      mediaType: type.mediaType,
      kind: type.kind,
      roles: new Set([asset.role]),
      storagePath: `assets/canonical/${id}/${path.posix.basename(memberPath)}`,
    });
  }
}

const providersDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
const sourcesDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
const storageDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
const rawSources: any[] = sourcesDocument.sources;
const rawEntries: any[] = storageDocument.entries;

function rawSource(id: string): any {
  const matches = rawSources.filter((source) => source.id === id);
  assert.equal(matches.length, 1, `catalog/sources.json must register '${id}' exactly once`);
  return matches[0];
}

function assertPinned(source: any): void {
  assert.match(String(source.source?.sha256), /^[0-9a-f]{64}$/, `'${source.id}' must carry a sha256 pin`);
  assert.ok(
    Number.isSafeInteger(source.source?.byteLength) && source.source.byteLength > 0,
    `'${source.id}' must carry a positive integer byteLength pin`,
  );
}

function buildCatalog() {
  return createAssetCatalog({ providers: providersDocument.providers, sources: sourcesDocument.sources });
}

// Hydration state of the expected payloads, decided before the tests are declared.
type Hydration = { state: "hydrated" } | { state: "pointer"; paths: string[] } | { state: "missing" };
async function detectHydration(): Promise<Hydration> {
  const pointers: string[] = [];
  for (const member of EXPECTED.values()) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(ROOT, ...member.storagePath.split("/")));
    } catch {
      return { state: "missing" };
    }
    if (bytes.subarray(0, 128).toString("utf8").startsWith(LFS_POINTER_PREFIX)) pointers.push(member.storagePath);
  }
  return pointers.length > 0 ? { state: "pointer", paths: pointers } : { state: "hydrated" };
}
const hydration = await detectHydration();
const hydratedSkip: string | false =
  hydration.state === "pointer" && !REQUIRE_HYDRATED
    ? `Git LFS payloads are not hydrated (${hydration.paths.length} pointer files, e.g. ${hydration.paths[0]}); run 'git lfs pull' or set ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 in the hosted canonical-storage job`
    : false;

// ---------------------------------------------------------------- structure

test("expected-member table: 28 unique members, shared WoodTrim set counted once", () => {
  assert.equal(EXPECTED.size, 28);
  for (const name of expand("glTF/T_WoodTrim_{Normal,BaseColor,Roughness}.png")) {
    const member = EXPECTED.get(memberId(MEDIEVAL, name));
    assert.deepEqual([...(member?.roles ?? [])].sort(), ["building", "door", "door-frame"]);
  }
});

test("the committed catalog and storage manifest build", () => {
  const catalog = buildCatalog();
  createAssetCatalogStorageManifest({ catalog, entries: storageDocument.entries });
});

test("the three archives are registered, pinned, CC0 zips with no storage entry", () => {
  for (const id of ARCHIVES) {
    const archive = rawSource(id);
    assert.equal(archive.schemaVersion ?? 1, 1, `'${id}' must be a schemaVersion 1 record`);
    assert.equal(archive.provider, "quaternius");
    assert.equal(archive.mediaType, "application/zip");
    assert.equal(archive.license?.spdx, "CC0-1.0", `'${id}' must be CC0-1.0`);
    assertPinned(archive);
    assert.equal(
      rawEntries.filter((entry) => entry.sourceId === id).length,
      0,
      `archive '${id}' must not have a storage entry`,
    );
  }
  const nature = rawSource(NATURE);
  assert.equal(nature.source.url, NATURE_URL);
  assert.equal(nature.source.byteLength, NATURE_BYTE_LENGTH);
  assert.equal(nature.source.sha256, NATURE_SHA256);
  assert.equal(nature.license.evidenceUrl, NATURE_EVIDENCE_URL);
});

test("every expected member is registered with the conventional id, path, type, kind and tags", () => {
  for (const member of EXPECTED.values()) {
    const source = rawSource(member.id);
    assert.equal(source.schemaVersion, 2, `'${member.id}' must be a schemaVersion 2 member record`);
    assert.deepEqual(source.archiveMember, { archive: member.archive, path: member.path }, member.id);
    assert.equal(source.provider, "quaternius", member.id);
    assert.equal(source.mediaType, member.mediaType, member.id);
    assert.equal(source.kind, member.kind, member.id);
    const tags: string[] = source.tags ?? [];
    assert.ok(tags.includes("greyhaven-starter"), `'${member.id}' must be tagged greyhaven-starter`);
    const roleTags = ROLES.filter((role) => tags.includes(role));
    assert.deepEqual(roleTags, ROLES.filter((role) => member.roles.has(role)), `'${member.id}' role tags`);
  }
});

test("member licenses are identical CC0 records to their archive's", () => {
  for (const member of EXPECTED.values()) {
    const source = rawSource(member.id);
    const archive = rawSource(member.archive);
    assert.equal(source.license?.spdx, "CC0-1.0", member.id);
    assert.deepEqual(source.license, archive.license, `'${member.id}' license must equal '${member.archive}'`);
  }
});

test("every member is pinned and has exactly one storage entry at assets/canonical/<id>/<basename>", () => {
  const catalog = buildCatalog();
  for (const member of EXPECTED.values()) {
    assertPinned(rawSource(member.id));
    const entries = rawEntries.filter((entry) => entry.sourceId === member.id);
    assert.equal(entries.length, 1, `'${member.id}' must have exactly one storage entry`);
    assert.deepEqual(
      entries[0],
      { schemaVersion: 1, sourceId: member.id, storage: "git-lfs", path: member.storagePath },
      member.id,
    );
  }
  const manifest = createAssetCatalogStorageManifest({ catalog, entries: storageDocument.entries });
  for (const member of EXPECTED.values()) {
    assert.equal(manifest.entries.filter((entry: any) => entry.sourceId === member.id).length, 1);
  }
});

test("no unlisted member of these archives is registered or stored", () => {
  const archiveSet = new Set<string>(ARCHIVES);
  const registered = rawSources
    .filter((source) => source.archiveMember && archiveSet.has(source.archiveMember.archive))
    .map((source) => source.id)
    .sort();
  assert.deepEqual(registered, [...EXPECTED.keys()].sort());

  const stored = rawEntries
    .map((entry) => entry.sourceId as string)
    .filter((sourceId) => {
      const source = rawSources.find((candidate) => candidate.id === sourceId);
      return archiveSet.has(sourceId) || (source?.archiveMember && archiveSet.has(source.archiveMember.archive));
    })
    .sort();
  assert.deepEqual(stored, [...EXPECTED.keys()].sort());
});

test("a shared texture has exactly one member record and one stored payload", () => {
  for (const name of expand("glTF/T_WoodTrim_{Normal,BaseColor,Roughness}.png")) {
    const records = rawSources.filter(
      (source) => source.archiveMember?.archive === MEDIEVAL && source.archiveMember?.path === name,
    );
    assert.equal(records.length, 1, `'${name}' must have exactly one member record`);
    const storagePaths = rawEntries.filter((entry) => entry.sourceId === records[0].id).map((entry) => entry.path);
    assert.equal(storagePaths.length, 1, `'${name}' must be stored once`);
    const sameBasename = rawEntries.filter((entry) => path.posix.basename(entry.path) === path.posix.basename(name));
    assert.equal(sameBasename.length, 1, `'${path.posix.basename(name)}' must be stored once across the catalog`);
  }
});

// ---------------------------------------------------- hydrated payload checks

test("hydration state of the starter payloads", () => {
  if (hydration.state === "pointer" && REQUIRE_HYDRATED) {
    assert.fail(`ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 but ${hydration.paths.length} payloads are LFS pointers`);
  }
});

test("integrity: every stored payload matches its pin through the public storage API", { skip: hydratedSkip }, async () => {
  const catalog = buildCatalog();
  for (const member of EXPECTED.values()) {
    const source = rawSource(member.id);
    const stored = await readAssetCatalogStorageSource({
      catalog,
      storage: storageDocument,
      sourceId: member.id,
      storageRoot: ROOT,
    });
    assert.equal(stored.entry.path, member.storagePath);
    assert.equal(stored.bytes.byteLength, source.source.byteLength, `'${member.id}' byteLength`);
    assert.equal(sha256Bytes(stored.bytes), source.source.sha256, `'${member.id}' sha256`);
    verifyAssetCatalogStorageBytes(catalog, stored.entry, stored.bytes);
  }
});

/**
 * Resolves a glTF URI to a member of the same archive: the member next to the
 * glTF when one is registered, otherwise the single registered member with the
 * URI's basename (the explicitly recorded path, e.g. Fantasy Props `Textures/`).
 */
function resolveUri(archive: string, gltfPath: string, uri: string): string {
  assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(uri), `'${gltfPath}' URI '${uri}' must be a relative file reference`);
  const decoded = decodeURIComponent(uri);
  const members = rawSources.filter((source) => source.archiveMember?.archive === archive);
  const adjacent = path.posix.normalize(path.posix.join(path.posix.dirname(gltfPath), decoded));
  const nextTo = members.filter((source) => source.archiveMember.path === adjacent);
  if (nextTo.length > 0) {
    assert.equal(nextTo.length, 1, `'${gltfPath}' URI '${uri}' resolves to several members`);
    return nextTo[0].archiveMember.path;
  }
  const recorded = members.filter(
    (source) => path.posix.basename(source.archiveMember.path) === path.posix.basename(decoded),
  );
  assert.equal(recorded.length, 1, `'${gltfPath}' URI '${uri}' must resolve to exactly one member of '${archive}'`);
  return recorded[0].archiveMember.path;
}

test("resource closure: every buffer and image URI resolves to exactly one member of the same archive", { skip: hydratedSkip }, async () => {
  const catalog = buildCatalog();
  for (const asset of ASSETS) {
    const id = memberId(asset.archive, asset.gltf);
    const stored = await readAssetCatalogStorageSource({
      catalog,
      storage: storageDocument,
      sourceId: id,
      storageRoot: ROOT,
    });
    const gltf = JSON.parse(stored.bytes.toString("utf8"));
    const uris: string[] = [
      ...(gltf.buffers ?? []).map((buffer: any) => buffer.uri),
      ...(gltf.images ?? []).map((image: any) => image.uri),
    ].filter((uri): uri is string => typeof uri === "string");

    const mapping: Record<string, string> = {};
    for (const uri of uris) {
      const resolved = resolveUri(asset.archive, asset.gltf, uri);
      const resolvedId = memberId(asset.archive, resolved);
      assert.ok(EXPECTED.has(resolvedId), `'${asset.gltf}' URI '${uri}' resolves to unlisted member '${resolved}'`);
      assert.equal(
        rawEntries.filter((entry) => entry.sourceId === resolvedId).length,
        1,
        `'${resolved}' must be stored once`,
      );
      mapping[uri] = resolved;
    }

    // The member set is exact, so the URI→member mapping must equal the spec table.
    const expectedMapping = Object.fromEntries(
      asset.referenced.map((memberPath) => [path.posix.basename(memberPath), memberPath]),
    );
    assert.deepEqual(mapping, expectedMapping, `'${asset.gltf}' URI→member mapping`);
    assert.equal(uris.length, asset.referenced.length, `'${asset.gltf}' must reference each member once`);
  }
});
