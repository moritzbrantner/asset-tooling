/// <reference path="../../src/gltf-validator.d.ts" />
// Real-source acceptance for #118 slice 1 (owner decisions Q1 (a) and Q2 (a), 2026-10-14):
// the hydrated Greyhaven starter members import through `scene.import.gltf@2` with the named
// `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` exception, and CommonTree_1 additionally with the
// declared `gltf-color-clamp-v1` repair (bound 2e-4). Members are resolved through the public
// catalog-storage API, as in test/hydrated/greyhaven-starter-sources.test.ts. These checks need hydrated
// Git LFS payloads: they skip with a reason when the payloads are pointers, and fail instead
// when ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 (set in the hosted canonical-storage job).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, type Document } from "@gltf-transform/core";
import { validateBytes } from "gltf-validator";
import { resolveAssetObject } from "../../src/asset-store.js";
import { createAssetCatalog } from "../../src/catalog.js";
import { importAssetCatalogStorageSource } from "../../src/catalog-storage.js";
import { executeGltfAnalyzeOperation, executeGltfProductionImportOperation } from "../../src/gltf-production-operations.js";
import type { AssetOperationResult, AssetRef } from "../../src/operations.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const REQUIRE_HYDRATED = process.env.ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE === "1";
const TANGENT_WARNING = "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE";
const CLAMP = "gltf-color-clamp-v1";
const CLAMP_BOUND = 2e-4;
const TIMEOUT = 300_000;

const MEDIEVAL = "quaternius.medieval-village-megakit-standard";
const FANTASY = "quaternius.fantasy-props-megakit-standard";
const NATURE = "quaternius.stylized-nature-megakit-standard";

type Json = Record<string, any>;
interface Asset { label: string; archive: string; gltf: string; tree: boolean }
const ASSETS: Asset[] = [
  { label: "wall", archive: MEDIEVAL, gltf: "glTF/Wall_Plaster_Door_Flat.gltf", tree: false },
  { label: "door", archive: MEDIEVAL, gltf: "glTF/Door_1_Flat.gltf", tree: false },
  { label: "door frame", archive: MEDIEVAL, gltf: "glTF/DoorFrame_Flat_WoodDark.gltf", tree: false },
  { label: "barrel", archive: FANTASY, gltf: "Exports/glTF/Barrel.gltf", tree: false },
  { label: "tree", archive: NATURE, gltf: "glTF/CommonTree_1.gltf", tree: true },
];

const providersDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/providers.json"), "utf8"));
const sourcesDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8"));
const storageDocument = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
const rawSources: Json[] = sourcesDocument.sources;
const rawEntries: Json[] = storageDocument.entries;
const catalog = createAssetCatalog({ providers: providersDocument.providers, sources: sourcesDocument.sources });

function memberSourceId(archive: string, memberPath: string): string {
  const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && source.archiveMember?.path === memberPath);
  assert.equal(matches.length, 1, `'${memberPath}' must be registered once in '${archive}'`);
  return matches[0]!.id;
}

/** The single registered member of `archive` with the URI's basename (spec-recorded paths). */
function resourceSourceId(archive: string, uri: string): string {
  const name = path.posix.basename(decodeURIComponent(uri));
  const matches = rawSources.filter((source) => source.archiveMember?.archive === archive && path.posix.basename(source.archiveMember.path) === name);
  assert.equal(matches.length, 1, `URI '${uri}' must resolve to exactly one member of '${archive}'`);
  return matches[0]!.id;
}

function storagePath(sourceId: string): string {
  const entries = rawEntries.filter((entry) => entry.sourceId === sourceId);
  assert.equal(entries.length, 1, `'${sourceId}' must have one storage entry`);
  return entries[0]!.path;
}

// Hydration state of the five glTF members and their resources, decided before tests are declared.
type Hydration = { state: "hydrated" } | { state: "pointer"; paths: string[] } | { state: "missing"; path: string };
async function detectHydration(): Promise<Hydration> {
  const pointers: string[] = [];
  for (const asset of ASSETS) {
    const gltfPath = storagePath(memberSourceId(asset.archive, asset.gltf));
    const paths = [gltfPath];
    let bytes: Buffer;
    try { bytes = await readFile(path.join(ROOT, gltfPath)); } catch { return { state: "missing", path: gltfPath }; }
    if (bytes.subarray(0, 128).toString("utf8").startsWith(LFS_POINTER_PREFIX)) { pointers.push(gltfPath); continue; }
    const json = JSON.parse(bytes.toString("utf8"));
    for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) paths.push(storagePath(resourceSourceId(asset.archive, entry.uri)));
    for (const member of paths.slice(1)) {
      let resource: Buffer;
      try { resource = await readFile(path.join(ROOT, member)); } catch { return { state: "missing", path: member }; }
      if (resource.subarray(0, 128).toString("utf8").startsWith(LFS_POINTER_PREFIX)) pointers.push(member);
    }
  }
  return pointers.length > 0 ? { state: "pointer", paths: pointers } : { state: "hydrated" };
}
const hydration = await detectHydration();
const hydratedSkip: string | false =
  hydration.state === "pointer" && !REQUIRE_HYDRATED
    ? `Git LFS payloads are not hydrated (${hydration.paths.length} pointer files, e.g. ${hydration.paths[0]}); run 'git lfs pull' or set ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 in the hosted canonical-storage job`
    : false;

/** Imports the member and its resources into a fresh object store through the public storage API. */
async function materialize(asset: Asset) {
  const root = await mkdtemp(path.join(os.tmpdir(), "greyhaven-import-"));
  const sourceId = memberSourceId(asset.archive, asset.gltf);
  const { asset: source } = await importAssetCatalogStorageSource({ catalog, storage: storageDocument, sourceId, storageRoot: ROOT, objectStoreRoot: root });
  const sourceBytes = Buffer.from(await resolveAssetObject(root, source));
  const json = JSON.parse(sourceBytes.toString("utf8"));
  const uris: string[] = [...(json.buffers ?? []), ...(json.images ?? [])].map((entry: Json) => entry.uri);
  const resources: AssetRef[] = [];
  const resourceBytes: Record<string, Uint8Array> = Object.create(null);
  for (const uri of uris) {
    const { asset: resource } = await importAssetCatalogStorageSource({
      catalog, storage: storageDocument, sourceId: resourceSourceId(asset.archive, uri), storageRoot: ROOT, objectStoreRoot: root,
    });
    resources.push(resource);
    resourceBytes[uri] = new Uint8Array(await resolveAssetObject(root, resource));
  }
  const policy: Json = asset.tree ? { allowedValidatorWarnings: [TANGENT_WARNING], repairs: [CLAMP] } : { allowedValidatorWarnings: [TANGENT_WARNING] };
  const call = (value: Json | undefined) => ({ inputs: { source, resources }, parameters: value === undefined ? { resourceUris: uris } : { resourceUris: uris, policy: value } });
  return { root, source, sourceBytes, json, resourceBytes, policy, call };
}

async function readSourceDocument(json: Json, resources: Record<string, Uint8Array>): Promise<Document> {
  return new NodeIO().readJSON({ json: structuredClone(json) as Parameters<NodeIO["readJSON"]>[0]["json"], resources: { ...resources } as Parameters<NodeIO["readJSON"]>[0]["resources"] });
}

async function listing(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).map(String).sort();
}

function codes(result: AssetOperationResult, field: string): string[] {
  const value = (result.observations as Json)[field];
  assert.ok(Array.isArray(value), `observations.${field} must be an array`);
  return [...new Set(value.map((warning: Json) => warning.code as string))].sort();
}

/** Independent per-attribute measurement of COLOR_n float components outside [0, 1]. */
function colorExcess(document: Document) {
  const measured: { path: string; count: number; maxExcess: number }[] = [];
  document.getRoot().listMeshes().forEach((mesh, meshIndex) => mesh.listPrimitives().forEach((primitive, primitiveIndex) => {
    for (const semantic of primitive.listSemantics().filter((name) => /^COLOR_\d+$/.test(name)).sort()) {
      const accessor = primitive.getAttribute(semantic)!;
      if (accessor.getComponentType() !== 5126) continue;
      let count = 0, maxExcess = 0;
      for (const value of accessor.getArray()!) {
        const excess = value > 1 ? value - 1 : value < 0 ? -value : 0;
        if (excess > 0) { count += 1; maxExcess = Math.max(maxExcess, excess); }
      }
      if (count) measured.push({ path: `/meshes/${meshIndex}/primitives/${primitiveIndex}/attributes/${semantic}`, count, maxExcess });
    }
  }));
  return measured;
}

test("hydration state of the starter import sources", () => {
  if (hydration.state === "missing") assert.fail(`starter payload missing from durable storage: ${hydration.path}`);
  if (hydration.state === "pointer" && REQUIRE_HYDRATED) {
    assert.fail(`ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 but ${hydration.paths.length} payloads are LFS pointers`);
  }
});

test("without the named exception every starter member still fails on missing tangents", { skip: hydratedSkip, timeout: TIMEOUT }, async () => {
  for (const asset of ASSETS) {
    const { root, call } = await materialize(asset);
    try {
      const before = await listing(root);
      await assert.rejects(executeGltfProductionImportOperation(root, call(undefined)), new RegExp(TANGENT_WARNING), `${asset.label}: strict import`);
      if (asset.tree) {
        // The tangent exception does not waive the tree's colour errors; the repair must be declared.
        await assert.rejects(executeGltfProductionImportOperation(root, call({ allowedValidatorWarnings: [TANGENT_WARNING] })),
          /\/meshes\/0\/primitives\/\d+\/attributes\/COLOR_0: ACCESSOR_NON_CLAMPED/, "tree without the clamp repair");
      }
      assert.deepEqual(await listing(root), before, `${asset.label}: failures store nothing`);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

for (const asset of ASSETS) {
  test(`${asset.label} (${asset.gltf}) imports through scene.import.gltf@2 with the tangent exception${asset.tree ? " and the color clamp repair" : ""}`,
    { skip: hydratedSkip, timeout: TIMEOUT }, async () => {
      const { root, source, sourceBytes, json, resourceBytes, policy, call } = await materialize(asset);
      try {
        const imported = await executeGltfProductionImportOperation(root, call(policy));
        const output = imported.outputs.output;
        assert.ok(output && !Array.isArray(output), "import stores one output");
        assert.deepEqual(codes(imported, "validatorWarnings"), [TANGENT_WARNING], "source evidence records only the accepted tangent warning");
        assert.ok(codes(imported, "outputValidatorWarnings").includes(TANGENT_WARNING), "output evidence records the tangent warning");
        assert.ok(!codes(imported, "outputValidatorWarnings").includes("ACCESSOR_NON_CLAMPED"));
        assert.deepEqual((imported.observations as Json).policy.allowedValidatorWarnings, [TANGENT_WARNING]);

        const glb = new Uint8Array(await resolveAssetObject(root, output));
        const report = await validateBytes(glb, {
          format: "glb", writeTimestamp: false, maxIssues: 0,
          externalResourceFunction: async (uri) => { throw new Error(`unexpected external resource ${uri}`); },
        });
        assert.equal(report.issues.numErrors, 0, `output validates: ${report.issues.messages.filter((m) => m.severity === 0).map((m) => m.code).join(", ")}`);
        assert.ok(!report.issues.messages.some((issue) => issue.code === "ACCESSOR_NON_CLAMPED"), "output has no ACCESSOR_NON_CLAMPED");

        // No tangents are generated; every other attribute is preserved (colors clamped only where out of range).
        const sourceDocument = await readSourceDocument(json, resourceBytes);
        const outputDocument = await new NodeIO().readBinary(glb);
        const sourceMeshes = sourceDocument.getRoot().listMeshes(), outputMeshes = outputDocument.getRoot().listMeshes();
        assert.equal(outputMeshes.length, sourceMeshes.length);
        sourceMeshes.forEach((mesh, meshIndex) => mesh.listPrimitives().forEach((primitive, primitiveIndex) => {
          const target = outputMeshes[meshIndex]!.listPrimitives()[primitiveIndex]!;
          const where = `${asset.label} /meshes/${meshIndex}/primitives/${primitiveIndex}`;
          assert.equal(target.getAttribute("TANGENT"), null, `${where}: no TANGENT generated`);
          if (primitive.getMaterial()?.getNormalTexture()) assert.ok(target.getMaterial()?.getNormalTexture(), `${where}: normal map preserved`);
          assert.deepEqual(target.listSemantics().sort(), primitive.listSemantics().sort(), `${where}: attribute set`);
          for (const semantic of primitive.listSemantics()) {
            const expected = Array.from(primitive.getAttribute(semantic)!.getArray()!);
            const actual = Array.from(target.getAttribute(semantic)!.getArray()!);
            const clamped = asset.tree && /^COLOR_\d+$/.test(semantic) && primitive.getAttribute(semantic)!.getComponentType() === 5126
              ? expected.map((value) => Math.min(1, Math.max(0, value))) : expected;
            assert.deepEqual(actual, clamped, `${where}/attributes/${semantic}`);
          }
        }));

        const repairs = (imported.observations as Json).repairs as Json[];
        if (asset.tree) {
          const measured = colorExcess(sourceDocument);
          assert.ok(measured.length > 0, "the tree source has out-of-range colors");
          assert.ok(Array.isArray(repairs));
          assert.deepEqual(repairs.map((entry) => entry.path).sort(), measured.map((entry) => entry.path).sort(), "one repair per out-of-range COLOR attribute");
          for (const entry of repairs) {
            const expected = measured.find((candidate) => candidate.path === entry.path)!;
            assert.equal(entry.repair, CLAMP);
            assert.equal(entry.clampedComponentCount, expected.count, `${entry.path}: clampedComponentCount`);
            assert.ok(Math.abs(entry.maxExcess - expected.maxExcess) <= 1e-9, `${entry.path}: maxExcess ${entry.maxExcess} vs measured ${expected.maxExcess}`);
            assert.ok(entry.maxExcess > 0 && entry.maxExcess <= CLAMP_BOUND, `${entry.path}: recorded maxExcess ${entry.maxExcess} must be in (0, ${CLAMP_BOUND}]`);
          }
          assert.ok(Math.max(...repairs.map((entry) => entry.maxExcess)) > 1.6e-4, "the measured 1.0001678 excess is recorded");
          assert.deepEqual(colorExcess(outputDocument), [], "output colors are within [0, 1]");
        }

        // Analysis reports the same repairs and acceptance and writes nothing.
        const before = await listing(root);
        const analyzed = await executeGltfAnalyzeOperation(root, call(policy));
        assert.equal(analyzed.observations.accepted, true);
        assert.deepEqual(analyzed.outputs, {});
        assert.deepEqual(codes(analyzed, "validatorWarnings"), [TANGENT_WARNING]);
        if (asset.tree) assert.deepEqual((analyzed.observations as Json).repairs, repairs);
        assert.deepEqual(await listing(root), before, "analysis writes no objects");

        // Exact replay; source bytes in the store are never modified.
        assert.deepEqual(await executeGltfProductionImportOperation(root, call(policy)), imported, "repeated import is identical");
        assert.ok(Buffer.from(await resolveAssetObject(root, source)).equals(sourceBytes), "stored source bytes unchanged");
        assert.ok((await readFile(path.join(ROOT, storagePath(memberSourceId(asset.archive, asset.gltf))))).equals(sourceBytes), "durable source bytes unchanged");
      } finally { await rm(root, { recursive: true, force: true }); }
    });
}
