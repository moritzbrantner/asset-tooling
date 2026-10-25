// Acceptance for the first humanoid source members (#109, slices 2 and 3), per Atlas
// Decisions 1.1.3, 6.1.1, 6.1.2 and 6.1.3 and docs/humanoid-sources.md. Slice 3
// (owner answers 2026-10-17): the two broken normal-map URIs of the body glTF are
// bound by a declared substitution to the same-folder textures, which are promoted
// as body members carrying metadata.substitutesFor; and every humanoid member
// re-imports idempotently through the public storage→AssetRef boundary. Mirrors
// test/greyhaven-starter-sources.test.ts. The structure checks read the
// committed catalog and run in ordinary `bun run check`. The resource-closure,
// clip and integrity checks need hydrated Git LFS payloads: they skip with a
// reason when the payloads are pointers, and fail instead when
// ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 (set it in the hosted
// canonical-storage job).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "../src/hash.js";
import { createAssetCatalog } from "../src/catalog.js";
import {
  createAssetCatalogStorageManifest,
  importAssetCatalogStorageSource,
  readAssetCatalogStorageSource,
  verifyAssetCatalogStorageBytes,
} from "../src/catalog-storage.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const REQUIRE_HYDRATED = process.env.ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE === "1";

const BASE = "quaternius.universal-base-characters-standard";
const OUTFITS = "quaternius.modular-character-outfits-fantasy-standard";
const UAL = "quaternius.universal-animation-library-standard";
const UAL2 = "quaternius.universal-animation-library-2-standard";
const ARCHIVES = [BASE, OUTFITS, UAL, UAL2] as const;

interface ArchivePin {
  url: string;
  upstreamId?: string;
  sha256: string;
  byteLength: number;
  evidenceUrl?: string;
  /** Archive record kind; the original three are `asset-pack`, UAL2 was registered earlier as an `animation-pack`. */
  kind?: string;
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
  [UAL2]: {
    url: "https://opengameart.org/sites/default/files/universal_animation_library_2standard.zip",
    upstreamId: "universal-animation-library-2-standard",
    sha256: "ec0e40d6d78fe9aaad59e322f40865a8675c22f0745e291622e54520391a9217",
    byteLength: 10_257_419,
    evidenceUrl: "https://quaternius.com/packs/universalanimationlibrary2.html",
    kind: "animation-pack",
  },
};

type Role = "body" | "outfit" | "clips";
const ROLES: readonly Role[] = ["body", "outfit", "clips"];
const BASELINE_TAG = "humanoid-baseline";

const BODY_DIR = "Universal Base Characters[Standard]/Base Characters/Godot - UE";
const HAIR_DIR = "Universal Base Characters[Standard]/Hairstyles/Origin at 0/glTF (Godot)";
const OUTFIT_DIR = "Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits";
const CLIPS_PATH = "Animation Library[Standard]/Godot/AnimationLibrary_Godot_Standard.glb";
const CLIPS2_PATH = "Universal Animation Library 2 [Standard]/Unreal-Godot/UAL2_Standard.glb";

interface Substitution {
  /** The URI the root references, which the archive does not contain under that name. */
  uri: string;
  /** The same-folder member that stands in for it (Decision 6.1.3). */
  path: string;
}

interface Asset {
  role: Role;
  archive: string;
  /** The root member: a .gltf whose URIs are closed over, or a self-contained .glb. */
  root: string;
  referenced: string[];
  /** Declared substitutions for URIs that resolve by no adjacent basename. */
  substitutions: Substitution[];
  /** URIs that resolve to an identical member stored once elsewhere in the archive (same bytes, #116 hair textures). */
  shared?: string[];
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
    substitutions: [
      { uri: "T_Hair_1_Normal_png.png", path: `${BODY_DIR}/T_Hair_1_Normal.png` },
      { uri: "T_Eye_Normal_png.png", path: `${BODY_DIR}/T_Eye_Normal.png` },
    ],
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
    substitutions: [],
  },
  // #115 (owner answer Q1 = A): the female base body and the matching Female_Ranger outfit from the same archives.
  {
    role: "body",
    archive: BASE,
    root: `${BODY_DIR}/Superhero_Female_FullBody.gltf`,
    referenced: [
      "Superhero_Female_FullBody.bin",
      "T_Hair_2_Normal.png",
      "T_Hair_2_BaseColor.png",
      "T_Eye_Brown.png",
      "T_Superhero_Female_Normal.png",
      "T_Superhero_Female_Dark_BaseColor.png",
      "T_Superhero_Female_Roughness.png",
    ].map((name) => `${BODY_DIR}/${name}`),
    substitutions: [{ uri: "T_Eye_Normal_png.png", path: `${BODY_DIR}/T_Eye_Normal.png` }],
  },
  {
    role: "outfit",
    archive: OUTFITS,
    root: `${OUTFIT_DIR}/Female_Ranger.gltf`,
    referenced: [
      "Female_Ranger.bin",
      "T_Ranger_Normal.png",
      "T_Ranger_BaseColor.png",
      "T_Ranger_ORM.png",
      "T_Regular_Female_Normal.png",
      "T_Regular_Female_Dark_BaseColor.png",
      "T_Regular_Female_Roughness.png",
    ].map((name) => `${OUTFIT_DIR}/${name}`),
    substitutions: [],
  },
  // #117 (owner answers 2026-10-17): the Male_Peasant outfit under the soldier and knight armour; its skin textures are the Ranger's.
  {
    role: "outfit",
    archive: OUTFITS,
    root: `${OUTFIT_DIR}/Male_Peasant.gltf`,
    referenced: [
      "Male_Peasant.bin",
      "T_Peasant_Normal.png",
      "T_Peasant_BaseColor.png",
      "T_Peasant_ORM.png",
      "T_Regular_Male_Normal.png",
      "T_Regular_Male_Dark_BaseColor.png",
      "T_Regular_Male_Roughness.png",
    ].map((name) => `${OUTFIT_DIR}/${name}`),
    substitutions: [],
  },
  // #378: the Female_Peasant outfit under the tanner's skirt and apron; it shows no skin, so only the Peasant textures.
  {
    role: "outfit",
    archive: OUTFITS,
    root: `${OUTFIT_DIR}/Female_Peasant.gltf`,
    referenced: ["Female_Peasant.bin", "T_Peasant_Normal.png", "T_Peasant_BaseColor.png", "T_Peasant_ORM.png"].map((name) => `${OUTFIT_DIR}/${name}`),
    substitutions: [],
  },
  // #116 (owner answers 2026-10-17): the Light skin textures and the "Origin at 0" hairstyles. The hairstyles'
  // T_Hair_* textures are byte-identical to the body folder's members and resolve to them.
  { role: "body", archive: BASE, root: "Universal Base Characters[Standard]/Base Characters/Textures/T_Superhero_Male_Ligh.png", referenced: [], substitutions: [] },
  { role: "body", archive: BASE, root: "Universal Base Characters[Standard]/Base Characters/Textures/T_Superhero_Female_Light_BaseColor.png", referenced: [], substitutions: [] },
  ...(["Hair_Buzzed", "Hair_SimpleParted", "Hair_Long", "Hair_Buns"] as const).map((hair): Asset => ({
    role: "body", archive: BASE, root: `${HAIR_DIR}/${hair}.gltf`, referenced: [`${HAIR_DIR}/${hair}.bin`], substitutions: [],
    shared: hair === "Hair_Long" || hair === "Hair_Buns" ? ["T_Hair_2_Normal.png", "T_Hair_2_BaseColor.png"] : ["T_Hair_1_Normal.png", "T_Hair_1_BaseColor.png"],
  })),
  { role: "clips", archive: UAL, root: CLIPS_PATH, referenced: [], substitutions: [] },
  { role: "clips", archive: UAL2, root: CLIPS2_PATH, referenced: [], substitutions: [] },
];
// The clips the Ranger bundle retargets from each library (docs/humanoid-ranger.md).
const REQUIRED_CLIPS = ["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Sword_Idle", "Sword_Attack", "Death01"];
const REQUIRED_CLIPS2 = ["Idle_Shield_Loop"];
const SUBSTITUTIONS = ASSETS.flatMap((asset) => asset.substitutions.map((substitution) => ({ asset, ...substitution })));

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
  for (const memberPath of [asset.root, ...asset.referenced, ...asset.substitutions.map((entry) => entry.path)]) {
    const id = memberId(asset.archive, memberPath);
    // Members shared by the male and female assets (eye textures, the Ranger textures) are listed once.
    if (EXPECTED.has(id)) {
      assert.equal(EXPECTED.get(id)!.path, memberPath, `expected-member table: id '${id}' names two paths`);
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
  // Members without a storage entry are failed by the registration/storage tests.
  for (const member of [...EXPECTED.values()].filter((candidate) => rawEntries.some((entry) => entry.sourceId === candidate.id))) {
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

test("expected-member table: 48 members (26 body incl. 2 substitutes, 2 light skins and 8 hair, 20 outfit, 2 clips GLBs)", () => {
  assert.equal(EXPECTED.size, 48);
  const byRole = (role: Role) => [...EXPECTED.values()].filter((member) => member.role === role).length;
  assert.deepEqual([byRole("body"), byRole("outfit"), byRole("clips")], [26, 20, 2]);
  assert.deepEqual(
    SUBSTITUTIONS.map(({ path: memberPath }) => memberId(BASE, memberPath)),
    [`${BASE}.t-hair-1-normal-png`, `${BASE}.t-eye-normal-png`, `${BASE}.t-eye-normal-png`],
  );
  assert.equal(
    memberId(BASE, `${BODY_DIR}/Superhero_Male_FullBody.gltf`),
    "quaternius.universal-base-characters-standard.superhero-male-fullbody-gltf",
  );
  assert.equal(
    memberId(UAL, CLIPS_PATH),
    "quaternius.universal-animation-library-standard.animationlibrary-godot-standard-glb",
  );
  assert.equal(memberId(UAL2, CLIPS2_PATH), "quaternius.universal-animation-library-2-standard.ual2-standard-glb");
});

test("the committed catalog and storage manifest build", () => {
  const catalog = buildCatalog();
  createAssetCatalogStorageManifest({ catalog, entries: storageDocument.entries });
});

test("the four archives are registered, pinned, CC0 pack zips with provenance and no storage entry", () => {
  for (const id of ARCHIVES) {
    const archive = rawSource(id);
    const pin = ARCHIVE_PINS[id];
    assert.equal(archive.schemaVersion ?? 1, 1, `'${id}' must be a schemaVersion 1 record`);
    assert.equal(archive.kind, pin.kind ?? "asset-pack", `'${id}' kind`);
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

const BODY_ROOT_ID = memberId(BASE, `${BODY_DIR}/Superhero_Male_FullBody.gltf`);

test("declared substitution: each substitute member names the broken URI it stands in for", () => {
  assert.deepEqual(
    SUBSTITUTIONS.map(({ uri, path: memberPath }) => [uri, path.posix.basename(memberPath)]),
    [
      ["T_Hair_1_Normal_png.png", "T_Hair_1_Normal.png"],
      ["T_Eye_Normal_png.png", "T_Eye_Normal.png"],
      ["T_Eye_Normal_png.png", "T_Eye_Normal.png"],
    ],
  );
  for (const { asset, uri, path: memberPath } of SUBSTITUTIONS) {
    const id = memberId(asset.archive, memberPath);
    const source = rawSource(id);
    assert.equal(path.posix.dirname(memberPath), path.posix.dirname(asset.root), `'${id}' must be a same-folder member`);
    assert.ok(Array.isArray(source.metadata?.substitutesFor), `'${id}' metadata.substitutesFor must be a list`);
    assert.equal(
      source.metadata.substitutesFor.filter((entry: any) => entry.member === memberId(asset.archive, asset.root) && entry.uri === uri).length, 1,
      `'${id}' must carry metadata.substitutesFor naming '${uri}' for '${asset.root}'`,
    );
  }
  assert.equal(memberId(BASE, `${BODY_DIR}/Superhero_Male_FullBody.gltf`), BODY_ROOT_ID);
  // Exactly these two records declare a substitution, and the declaration survives the public catalog.
  const declaring = rawSources.filter((source) => source.metadata?.substitutesFor !== undefined).map((source) => source.id).sort();
  assert.deepEqual(declaring, [...new Set(SUBSTITUTIONS.map(({ asset, path: memberPath }) => memberId(asset.archive, memberPath)))].sort());
  const catalog = buildCatalog();
  for (const id of declaring) {
    assert.deepEqual(catalog.getSource(id).metadata.substitutesFor, rawSource(id).metadata.substitutesFor, id);
  }
});

test("declared substitution: the broken URIs themselves remain neither registered nor stored", () => {
  for (const { asset, uri } of SUBSTITUTIONS) {
    const brokenPath = `${path.posix.dirname(asset.root)}/${uri}`;
    assert.equal(
      rawSources.filter(
        (source) =>
          source.id === memberId(asset.archive, brokenPath) ||
          (source.archiveMember && path.posix.basename(source.archiveMember.path) === uri),
      ).length,
      0,
      `'${uri}' must not be registered (no member named after it, no invented bytes)`,
    );
    assert.equal(
      rawEntries.filter((entry) => path.posix.basename(entry.path) === uri).length,
      0,
      `'${uri}' must not be stored`,
    );
  }
});

test("docs/humanoid-sources.md describes the set, provenance, local-file promotion and the declared substitution", async () => {
  const doc = await readDoc();
  for (const id of ARCHIVES) assert.ok(doc.includes(id), `doc must name archive '${id}'`);
  for (const pin of Object.values(ARCHIVE_PINS)) {
    assert.ok(doc.includes(pin.sha256), `doc must record sha256 ${pin.sha256}`);
    if (pin.upstreamId) assert.ok(doc.includes(pin.upstreamId), `doc must record itch upload id ${pin.upstreamId}`);
  }
  for (const member of EXPECTED.values()) {
    assert.ok(doc.includes(path.posix.basename(member.path)), `doc must list member '${member.path}'`);
  }
  for (const clip of [...REQUIRED_CLIPS, ...REQUIRED_CLIPS2]) assert.ok(doc.includes(clip), `doc must name clip '${clip}'`);
  assert.match(doc, /catalog:lfs:promote[^\n]*--from/, "doc must show the local-file promotion command");
  assert.match(doc, /substitut/i, "doc must document the declared substitution");
  const lines = doc.split("\n");
  for (const { uri, path: memberPath } of SUBSTITUTIONS) {
    const substitute = path.posix.basename(memberPath);
    assert.ok(
      lines.some((line) => line.includes(uri) && line.includes(substitute)),
      `doc must state the mapping '${uri}' -> '${substitute}' (both on one line)`,
    );
  }
  assert.ok(doc.includes("6.1.2"), "doc must cite Atlas Decision 6.1.2");
  assert.ok(doc.includes("6.1.3"), "doc must cite Atlas Decision 6.1.3");
});

test("generic: the archives are plain catalog sources, so another member needs no code", () => {
  // The archive records validate on their own through the public catalog API.
  const archivesOnly = buildCatalog(ARCHIVES.map((id) => rawSource(id)));
  for (const id of ARCHIVES) {
    const source = archivesOnly.getSource(id);
    assert.ok(source, `'${id}' must validate through createAssetCatalog`);
    assert.equal(source.schemaVersion, 1);
    assert.equal(source.kind, ARCHIVE_PINS[id].kind ?? "asset-pack");
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

test("resource closure: every URI resolves to exactly one member, by adjacent basename or by one declared substitution", { skip: hydratedSkip }, async () => {
  const catalog = buildCatalog();
  for (const asset of ASSETS.filter((candidate) => candidate.root.endsWith(".gltf"))) {
    const rootId = memberId(asset.archive, asset.root);
    const stored = await readMember(catalog, rootId);
    const gltf = JSON.parse(stored.bytes.toString("utf8"));
    const uris: string[] = [
      ...(gltf.buffers ?? []).map((buffer: any) => buffer.uri),
      ...(gltf.images ?? []).map((image: any) => image.uri),
    ].filter((uri): uri is string => typeof uri === "string");
    const members = rawSources.filter((source) => source.archiveMember?.archive === asset.archive);
    const declarations = members.flatMap((source) => (source.metadata?.substitutesFor ?? []).filter((entry: any) => entry.member === rootId).map((entry: any) => ({ source, uri: entry.uri as string })));

    const byName: string[] = [];
    const bySubstitution: string[] = [];
    const resolvedUrisByName = new Set<string>();
    for (const uri of uris) {
      assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(uri), `'${asset.root}' URI '${uri}' must be a relative file reference`);
      const adjacent = path.posix.normalize(path.posix.join(path.posix.dirname(asset.root), decodeURIComponent(uri)));
      const matches = members.filter((source) => source.archiveMember.path === adjacent);
      assert.ok(matches.length <= 1, `'${asset.root}' URI '${uri}' resolves to several members`);
      let target: any;
      if (matches.length === 1) {
        target = matches[0];
        resolvedUrisByName.add(uri);
        byName.push(adjacent);
      } else if (asset.shared?.includes(uri)) {
        const elsewhere = members.filter((source) => path.posix.basename(source.archiveMember.path) === uri);
        assert.equal(elsewhere.length, 1, `'${asset.root}' shared URI '${uri}' must name exactly one member`);
        target = elsewhere[0];
        resolvedUrisByName.add(uri);
      } else {
        const substitutes = declarations.filter((declaration) => declaration.uri === uri);
        assert.equal(substitutes.length, 1, `'${asset.root}' URI '${uri}' must resolve by exactly one declared substitution`);
        target = substitutes[0]!.source;
        bySubstitution.push(`${uri}=>${target.archiveMember.path}`);
      }
      assert.ok(EXPECTED.has(target.id), `'${asset.root}' URI '${uri}' resolves to unlisted member '${target.id}'`);
      assert.equal(rawEntries.filter((entry) => entry.sourceId === target.id).length, 1, `'${target.id}' must be stored once`);
    }
    assert.deepEqual(byName.sort(), [...asset.referenced].sort(), `'${asset.root}' URI→member mapping by name`);
    assert.deepEqual(
      bySubstitution.sort(),
      asset.substitutions.map(({ uri, path: memberPath }) => `${uri}=>${memberPath}`).sort(),
      `'${asset.root}' URIs resolved by substitution must be exactly the declared ones`,
    );
    for (const { source: declaration, uri } of declarations) {
      assert.ok(uris.includes(uri), `'${declaration.id}' substitutes for '${uri}', which '${asset.root}' does not reference`);
      assert.ok(!resolvedUrisByName.has(uri), `'${declaration.id}' substitutes for '${uri}', which already resolves by name`);
    }
  }
});

test("declared substitution: the body glTF uses each broken URI as a normalTexture; each substitute is stored at its pin", { skip: hydratedSkip }, async () => {
  const catalog = buildCatalog();
  const body = await readMember(catalog, BODY_ROOT_ID);
  const gltf = JSON.parse(body.bytes.toString("utf8"));
  const normalImageUris = new Set<string>(
    (gltf.materials ?? [])
      .map((material: any) => material.normalTexture?.index)
      .filter((index: unknown): index is number => typeof index === "number")
      .map((index: number) => gltf.images?.[gltf.textures?.[index]?.source]?.uri),
  );
  for (const { asset, uri, path: memberPath } of SUBSTITUTIONS) {
    const images = (gltf.images ?? []).filter((image: any) => image.uri === uri);
    assert.equal(images.length, 1, `body images[] must contain '${uri}' exactly once`);
    assert.ok(normalImageUris.has(uri), `'${uri}' must be used as a normalTexture`);
    const id = memberId(asset.archive, memberPath);
    const stored = await readMember(catalog, id);
    assert.equal(sha256Bytes(stored.bytes), rawSource(id).source.sha256, `'${id}' stored sha256 must equal the catalog pin`);
    assert.equal(stored.bytes.byteLength, rawSource(id).source.byteLength, `'${id}' stored byteLength must equal the catalog pin`);
    assert.equal(stored.bytes.toString("latin1", 1, 4), "PNG", `'${id}' must be a PNG`);
  }
});

function readGlbJson(bytes: Buffer): any {
  assert.equal(bytes.toString("latin1", 0, 4), "glTF", "GLB magic");
  assert.equal(bytes.readUInt32LE(4), 2, "GLB version 2");
  const chunkLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, "first GLB chunk must be JSON");
  return JSON.parse(bytes.toString("utf8", 20, 20 + chunkLength));
}

test("clips: the UAL1 GLB contains the Ranger clips (Idle_Loop, Walk_Loop, run, sword, death) among its named clips", { skip: hydratedSkip }, async () => {
  const catalog = buildCatalog();
  const stored = await readMember(catalog, memberId(UAL, CLIPS_PATH));
  const gltf = readGlbJson(stored.bytes);
  const names: string[] = (gltf.animations ?? []).map((animation: any) => animation.name);
  for (const clip of REQUIRED_CLIPS) {
    assert.equal(names.filter((name) => name === clip).length, 1, `GLB must contain exactly one '${clip}' clip`);
  }
  assert.equal(names.length, 46, "UAL1 Standard GLB carries 46 named clips");
});

test("clips: the UAL2 GLB contains Idle_Shield_Loop on the 65-joint UE rig", { skip: hydratedSkip }, async () => {
  const catalog = buildCatalog();
  const gltf = readGlbJson((await readMember(catalog, memberId(UAL2, CLIPS2_PATH))).bytes);
  const names: string[] = (gltf.animations ?? []).map((animation: any) => animation.name);
  for (const clip of REQUIRED_CLIPS2) assert.equal(names.filter((name) => name === clip).length, 1, `GLB must contain exactly one '${clip}' clip`);
  assert.equal(gltf.skins.length, 1);
  assert.equal(gltf.skins[0].joints.length, 65);
  assert.equal(gltf.nodes[gltf.skins[0].joints[1]].name, "pelvis");
});

// ------------------------------------------------- idempotent re-import (6.1.3 (b))

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const relative of (await readdir(root, { recursive: true })).map(String).sort()) {
    try {
      files[relative] = sha256Bytes(await readFile(path.join(root, relative)));
    } catch (error: any) {
      if (error?.code !== "EISDIR") throw error;
      files[relative] = "<dir>";
    }
  }
  return files;
}

test("re-import: every humanoid member imports twice into a fresh object store with identical AssetRefs and no second-run change", { skip: hydratedSkip, timeout: 300_000 }, async () => {
  const catalog = buildCatalog();
  const humanoid = rawSources
    .filter((source) => source.archiveMember && archiveSet.has(source.archiveMember.archive))
    .map((source) => source.id as string)
    .sort();
  assert.ok(humanoid.length > 0, "no humanoid member is registered");
  const objectStoreRoot = await mkdtemp(path.join(os.tmpdir(), "humanoid-reimport-"));
  try {
    const importAll = async () => {
      const results: Record<string, any> = {};
      for (const sourceId of humanoid) {
        results[sourceId] = await importAssetCatalogStorageSource({
          catalog, storage: storageDocument, sourceId, storageRoot: ROOT, objectStoreRoot,
        });
      }
      return results;
    };
    const first = await importAll();
    const afterFirst = await snapshot(objectStoreRoot);
    const second = await importAll();
    const afterSecond = await snapshot(objectStoreRoot);
    for (const sourceId of humanoid) {
      const source = rawSource(sourceId);
      assert.equal(first[sourceId].status, "changed", `'${sourceId}' first import into a fresh store must change it`);
      assert.equal(second[sourceId].status, "unchanged", `'${sourceId}' second import must change nothing`);
      assert.deepEqual(second[sourceId].asset, first[sourceId].asset, `'${sourceId}' AssetRef must be identical across imports`);
      assert.equal(first[sourceId].asset.sha256, source.source.sha256, `'${sourceId}' AssetRef sha256 must equal the pin`);
      assert.equal(first[sourceId].asset.metadata.catalog.id, sourceId);
      assert.equal(first[sourceId].asset.metadata.catalog.archiveMemberPath, source.archiveMember.path);
    }
    assert.deepEqual(afterSecond, afterFirst, "the second import must leave the object store file set and bytes unchanged");
  } finally {
    await rm(objectStoreRoot, { recursive: true, force: true });
  }
});
