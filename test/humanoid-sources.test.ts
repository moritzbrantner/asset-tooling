// Acceptance for the first humanoid source members (#109, slice 2), per Atlas
// Decisions 1.1.3, 6.1.1 and 6.1.2 and docs/humanoid-sources.md. Mirrors
// test/greyhaven-starter-sources.test.ts. The structure checks read the
// committed catalog and run in ordinary `bun run check`. The resource-closure,
// clip and integrity checks need hydrated Git LFS payloads: they skip with a
// reason when the payloads are pointers, and fail instead when
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

const BASE = "quaternius.universal-base-characters-standard";
const OUTFITS = "quaternius.modular-character-outfits-fantasy-standard";
const UAL = "quaternius.universal-animation-library-standard";
const ARCHIVES = [BASE, OUTFITS, UAL] as const;

interface ArchivePin {
  url: string;
  upstreamId?: string;
  sha256: string;
  byteLength: number;
  evidenceUrl?: string;
}

// The pinned archives named in Decision 6.1.2 and the #109 findings.
const ARCHIVE_PINS: Record<(typeof ARCHIVES)[number], ArchivePin> = {
  [BASE]: {
    url: "https://quaternius.itch.io/universal-base-characters",
    upstreamId: "15861669",
    sha256: "fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40",
    byteLength: 128_968_391,
    evidenceUrl: "https://quaternius.com/packs/universalbasecharacters.html",
  },
  [OUTFITS]: {
    url: "https://quaternius.itch.io/modular-character-outfits-fantasy",
    upstreamId: "16289385",
    sha256: "c3468b18871cc8c8f05ab14df7712baf22cb9f389cbd870babf130e595187f70",
    byteLength: 294_347_394,
  },
  [UAL]: {
    url: "https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip",
    sha256: "18ff1a7215f4852b320203e8aaf02a1578b5c8eef9027fbaedfcedc7b85a3ac2",
    byteLength: 14_541_205,
  },
};

type Role = "body" | "outfit" | "clips";
const ROLES: readonly Role[] = ["body", "outfit", "clips"];
const BASELINE_TAG = "humanoid-baseline";

const BODY_DIR = "Universal Base Characters[Standard]/Base Characters/Godot - UE";
const OUTFIT_DIR = "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits";
const CLIPS_PATH = "Animation Library[Standard]/Godot/AnimationLibrary_Godot_Standard.glb";

interface Asset {
  role: Role;
  archive: string;
  /** The root member: a .gltf whose URIs are closed over, or a self-contained .glb. */
  root: string;
  referenced: string[];
  /** URIs the root references that the archive does not contain (recorded known gap). */
  knownGap: string[];
}

// Decision 6.1.2's selected members, with every referenced resource that exists.
const ASSETS: Asset[] = [
  {
    role: "body",
    archive: BASE,
    root: `${BODY_DIR}/Superhero_Male_FullBody.gltf`,
    referenced: [
      "Superhero_Male_FullBody.bin",
      "T_Hair_1_BaseColor.png",
      "T_Eye_Brown.png",
      "T_Superhero_Male_Normal.png",
      "T_Superhero_Male_Dark.png",
      "T_Superhero_Male_Roughness.png",
    ].map((name) => `${BODY_DIR}/${name}`),
    knownGap: ["T_Hair_1_Normal_png.png", "T_Eye_Normal_png.png"],
  },
  {
    role: "outfit",
    archive: OUTFITS,
    root: `${OUTFIT_DIR}/Male_Ranger.gltf`,
    referenced: [
      "Male_Ranger.bin",
      "T_Ranger_Normal.png",
      "T_Ranger_BaseColor.png",
      "T_Ranger_ORM.png",
      "T_Regular_Male_Normal.png",
      "T_Regular_Male_Dark_BaseColor.png",
      "T_Regular_Male_Roughness.png",
    ].map((name) => `${OUTFIT_DIR}/${name}`),
    knownGap: [],
  },
  { role: "clips", archive: UAL, root: CLIPS_PATH, referenced: [], knownGap: [] },
];
const REQUIRED_CLIPS = ["Idle_Loop", "Walk_Loop"];
const KNOWN_GAP = ASSETS.flatMap((asset) => asset.knownGap.map((uri) => ({ asset, uri })));

function memberId(archive: string, memberPath: string): string {
  const slug = path.posix
    .basename(memberPath)
    .toLowerCase()
    .replace(/[_. ]/g, "-")
    .replace(/-+/g, "-");
  return `${archive}.${slug}`;
}

const MEDIA_TYPES: Record<string, { mediaType: string; kind: string }> = {
  ".gltf": { mediaType: "model/gltf+json", kind: "mesh" },
  ".bin": { mediaType: "application/octet-stream", kind: "buffer" },
  ".png": { mediaType: "image/png", kind: "texture" },
  ".glb": { mediaType: "model/gltf-binary", kind: "animation" },
};

interface ExpectedMember {
  id: string;
  archive: string;
  path: string;
  mediaType: string;
  kind: string;
  role: Role;
  storagePath: string;
}

const EXPECTED = new Map<string, ExpectedMember>();
for (const asset of ASSETS) {
  for (const memberPath of [asset.root, ...asset.referenced]) {
    const id = memberId(asset.archive, memberPath);
    assert.ok(!EXPECTED.has(id), `expected-member table: duplicate id '${id}'`);
    const type = MEDIA_TYPES[path.posix.extname(memberPath)];
    assert.ok(type, `expected-member table: no media type for '${memberPath}'`);
    EXPECTED.set(id, {
      id,
      archive: asset.archive,
      path: memberPath,
      mediaType: type.mediaType,
      kind: type.kind,
      role: asset.role,
      storagePath: `assets/canonical/${id}/${path.posix.basename(memberPath)}`,
    });
  }
}

const providersDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
const sourcesDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
const storageDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
const rawSources: any[] = sourcesDocument.sources;
const rawEntries: any[] = storageDocument.entries;
const archiveSet = new Set<string>(ARCHIVES);

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

function buildCatalog(sources: any[] = rawSources) {
  return createAssetCatalog({ providers: providersDocument.providers, sources });
}

async function readDoc(): Promise<string> {
  try {
    return await readFile(path.join(ROOT, "docs/humanoid-sources.md"), "utf8");
  } catch {
    assert.fail("docs/humanoid-sources.md must exist and describe the humanoid source set");
  }
}

// Hydration state of the expected payloads, decided before the tests are declared.
type Hydration =
  | { state: "hydrated" }
  | { state: "pointer"; paths: string[] }
  | { state: "unregistered" }
  | { state: "missing"; path: string };
async function detectHydration(): Promise<Hydration> {
  const anyStored = rawEntries.some((entry) => EXPECTED.has(entry.sourceId));
  // Nothing promoted yet: the registration tests already fail closed on that.
  if (!anyStored) return { state: "unregistered" };
  const pointers: string[] = [];
  for (const member of EXPECTED.values()) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(ROOT, ...member.storagePath.split("/")));
    } catch {
      return { state: "missing", path: member.storagePath };
    }
    if (bytes.subarray(0, 128).toString("utf8").startsWith(LFS_POINTER_PREFIX)) pointers.push(member.storagePath);
  }
  return pointers.length > 0 ? { state: "pointer", paths: pointers } : { state: "hydrated" };
}
const hydration = await detectHydration();
const hydratedSkip: string | false =
  hydration.state === "pointer" && !REQUIRE_HYDRATED
    ? `Git LFS payloads are not hydrated (${hydration.paths.length} pointer files, e.g. ${hydration.paths[0]}); run 'git lfs pull' or set ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 in the hosted canonical-storage job`
    : hydration.state === "unregistered"
      ? "no humanoid member is stored yet; the registration and storage tests fail on that"
      : false;

// ---------------------------------------------------------------- structure

test("expected-member table: 16 members (7 body, 8 outfit, 1 clips GLB)", () => {
  assert.equal(EXPECTED.size, 16);
  const byRole = (role: Role) => [...EXPECTED.values()].filter((member) => member.role === role).length;
  assert.deepEqual([byRole("body"), byRole("outfit"), byRole("clips")], [7, 8, 1]);
  assert.equal(
    memberId(BASE, `${BODY_DIR}/Superhero_Male_FullBody.gltf`),
    "quaternius.universal-base-characters-standard.superhero-male-fullbody-gltf",
  );
  assert.equal(
    memberId(UAL, CLIPS_PATH),
    "quaternius.universal-animation-library-standard.animationlibrary-godot-standard-glb",
  );
});

test("the committed catalog and storage manifest build", () => {
  const catalog = buildCatalog();
  createAssetCatalogStorageManifest({ catalog, entries: storageDocument.entries });
});

test("the three archives are registered, pinned, CC0 asset-pack zips with provenance and no storage entry", () => {
  for (const id of ARCHIVES) {
    const archive = rawSource(id);
    const pin = ARCHIVE_PINS[id];
    assert.equal(archive.schemaVersion ?? 1, 1, `'${id}' must be a schemaVersion 1 record`);
    assert.equal(archive.kind, "asset-pack", `'${id}' kind`);
    assert.equal(archive.provider, "quaternius", `'${id}' provider`);
    assert.equal(archive.mediaType, "application/zip", `'${id}' mediaType`);
    assert.equal(archive.archiveMember, undefined, `'${id}' must not be an archive member`);
    assert.equal(archive.license?.spdx, "CC0-1.0", `'${id}' must be CC0-1.0`);
    assert.equal(typeof archive.license?.evidenceUrl, "string", `'${id}' must carry license evidence`);
    if (pin.evidenceUrl) assert.equal(archive.license.evidenceUrl, pin.evidenceUrl, `'${id}' evidenceUrl`);
    assertPinned(archive);
    assert.equal(archive.source.sha256, pin.sha256, `'${id}' sha256 pin`);
    assert.equal(archive.source.byteLength, pin.byteLength, `'${id}' byteLength pin`);
    assert.equal(archive.source.url, pin.url, `'${id}' source.url`);
    if (pin.upstreamId) assert.equal(archive.source.upstreamId, pin.upstreamId, `'${id}' upstreamId (itch upload id)`);
    assert.equal(
      rawEntries.filter((entry) => entry.sourceId === id).length,
      0,
      `archive '${id}' must not have a storage entry`,
    );
  }
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
    assert.ok(tags.includes(BASELINE_TAG), `'${member.id}' must be tagged ${BASELINE_TAG}`);
    assert.deepEqual(
      ROLES.filter((role) => tags.includes(role)),
      [member.role],
      `'${member.id}' must carry exactly the role tag '${member.role}'`,
    );
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

test("known gap: the two absent normal-map URIs are neither registered nor stored", () => {
  assert.deepEqual(
    KNOWN_GAP.map(({ uri }) => uri),
    ["T_Hair_1_Normal_png.png", "T_Eye_Normal_png.png"],
  );
  for (const { asset, uri } of KNOWN_GAP) {
    const gapPath = `${path.posix.dirname(asset.root)}/${uri}`;
    assert.equal(
      rawSources.filter(
        (source) =>
          source.id === memberId(asset.archive, gapPath) ||
          (source.archiveMember && path.posix.basename(source.archiveMember.path) === uri),
      ).length,
      0,
      `'${uri}' must not be registered (no member, no invented bytes)`,
    );
    assert.equal(
      rawEntries.filter((entry) => path.posix.basename(entry.path) === uri).length,
      0,
      `'${uri}' must not be stored`,
    );
  }
});

test("docs/humanoid-sources.md describes the set, provenance, local-file promotion and the known gap", async () => {
  const doc = await readDoc();
  for (const id of ARCHIVES) assert.ok(doc.includes(id), `doc must name archive '${id}'`);
  for (const pin of Object.values(ARCHIVE_PINS)) {
    assert.ok(doc.includes(pin.sha256), `doc must record sha256 ${pin.sha256}`);
    if (pin.upstreamId) assert.ok(doc.includes(pin.upstreamId), `doc must record itch upload id ${pin.upstreamId}`);
  }
  for (const member of EXPECTED.values()) {
    assert.ok(doc.includes(path.posix.basename(member.path)), `doc must list member '${member.path}'`);
  }
  for (const clip of REQUIRED_CLIPS) assert.ok(doc.includes(clip), `doc must name clip '${clip}'`);
  assert.match(doc, /catalog:lfs:promote[^\n]*--from/, "doc must show the local-file promotion command");
  assert.match(doc, /known gap/i, "doc must record the known gap");
  for (const { uri } of KNOWN_GAP) assert.ok(doc.includes(uri), `doc must list known-gap URI '${uri}'`);
  assert.ok(doc.includes("6.1.2"), "doc must cite Atlas Decision 6.1.2");
});

test("generic: the archives are plain catalog sources, so another member needs no code", () => {
  // The archive records validate on their own through the public catalog API.
  const archivesOnly = buildCatalog(ARCHIVES.map((id) => rawSource(id)));
  for (const id of ARCHIVES) {
    const source = archivesOnly.getSource(id);
    assert.ok(source, `'${id}' must validate through createAssetCatalog`);
    assert.equal(source.schemaVersion, 1);
    assert.equal(source.kind, "asset-pack");
  }
  // A future consumer (e.g. an arpg knight outfit) adds an unpinned member record
  // of the same archive; the existing catalog accepts it unchanged.
  const extra = {
    schemaVersion: 2,
    id: `${OUTFITS}.male-knight-gltf`,
    title: "Modular Character Outfits – Fantasy — Male_Knight (glTF)",
    provider: "quaternius",
    kind: "mesh",
    mediaType: "model/gltf+json",
    license: rawSource(OUTFITS).license,
    archiveMember: { archive: OUTFITS, path: `${OUTFIT_DIR}/Male_Knight.gltf` },
    source: {},
    tags: [BASELINE_TAG, "outfit"],
  };
  const extended = buildCatalog([...rawSources, extra]);
  assert.ok(extended.getSource(extra.id), "an additional member of an existing archive must validate");
});

// ---------------------------------------------------- hydrated payload checks

test("hydration state of the humanoid payloads", () => {
  if (hydration.state === "missing") assert.fail(`stored payload '${hydration.path}' is missing from the working tree`);
  if (hydration.state === "pointer" && REQUIRE_HYDRATED) {
    assert.fail(`ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 but ${hydration.paths.length} payloads are LFS pointers`);
  }
  if (hydration.state === "unregistered" && REQUIRE_HYDRATED) {
    assert.fail("ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 but no humanoid member is stored");
  }
});

async function readMember(catalog: any, id: string) {
  return readAssetCatalogStorageSource({ catalog, storage: storageDocument, sourceId: id, storageRoot: ROOT });
}

test("integrity: every stored payload matches its pin through the public storage API", { skip: hydratedSkip }, async () => {
  const catalog = buildCatalog();
  for (const member of EXPECTED.values()) {
    const source = rawSource(member.id);
    const stored = await readMember(catalog, member.id);
    assert.equal(stored.entry.path, member.storagePath);
    assert.equal(stored.bytes.byteLength, source.source.byteLength, `'${member.id}' byteLength`);
    assert.equal(sha256Bytes(stored.bytes), source.source.sha256, `'${member.id}' sha256`);
    verifyAssetCatalogStorageBytes(catalog, stored.entry, stored.bytes);
  }
});

test("resource closure: every present URI resolves to exactly one adjacent member; gap URIs resolve to none", { skip: hydratedSkip }, async () => {
  const catalog = buildCatalog();
  for (const asset of ASSETS.filter((candidate) => candidate.root.endsWith(".gltf"))) {
    const stored = await readMember(catalog, memberId(asset.archive, asset.root));
    const gltf = JSON.parse(stored.bytes.toString("utf8"));
    const uris: string[] = [
      ...(gltf.buffers ?? []).map((buffer: any) => buffer.uri),
      ...(gltf.images ?? []).map((image: any) => image.uri),
    ].filter((uri): uri is string => typeof uri === "string");
    const members = rawSources.filter((source) => source.archiveMember?.archive === asset.archive);

    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const uri of uris) {
      assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(uri), `'${asset.root}' URI '${uri}' must be a relative file reference`);
      const adjacent = path.posix.normalize(path.posix.join(path.posix.dirname(asset.root), decodeURIComponent(uri)));
      const matches = members.filter((source) => source.archiveMember.path === adjacent);
      assert.ok(matches.length <= 1, `'${asset.root}' URI '${uri}' resolves to several members`);
      if (matches.length === 0) {
        unresolved.push(uri);
        continue;
      }
      const id = matches[0].id;
      assert.ok(EXPECTED.has(id), `'${asset.root}' URI '${uri}' resolves to unlisted member '${id}'`);
      assert.equal(rawEntries.filter((entry) => entry.sourceId === id).length, 1, `'${adjacent}' must be stored once`);
      resolved.push(adjacent);
    }
    assert.deepEqual(resolved.sort(), [...asset.referenced].sort(), `'${asset.root}' URI→member mapping`);
    assert.deepEqual(unresolved.sort(), [...asset.knownGap].sort(), `'${asset.root}' unresolved URIs must be exactly the known gap`);
  }
});

function readGlbJson(bytes: Buffer): any {
  assert.equal(bytes.toString("latin1", 0, 4), "glTF", "GLB magic");
  assert.equal(bytes.readUInt32LE(4), 2, "GLB version 2");
  const chunkLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, "first GLB chunk must be JSON");
  return JSON.parse(bytes.toString("utf8", 20, 20 + chunkLength));
}

test("clips: the UAL1 GLB contains Idle_Loop and Walk_Loop among its named clips", { skip: hydratedSkip }, async () => {
  const catalog = buildCatalog();
  const stored = await readMember(catalog, memberId(UAL, CLIPS_PATH));
  const gltf = readGlbJson(stored.bytes);
  const names: string[] = (gltf.animations ?? []).map((animation: any) => animation.name);
  for (const clip of REQUIRED_CLIPS) {
    assert.equal(names.filter((name) => name === clip).length, 1, `GLB must contain exactly one '${clip}' clip`);
  }
  assert.equal(names.length, 46, "UAL1 Standard GLB carries 46 named clips");
});
