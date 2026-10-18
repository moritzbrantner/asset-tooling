/// <reference path="../src/gltf-validator.d.ts" />
// End-to-end #118 Greyhaven starter recipe (docs/greyhaven-starter-bundle.md): the hydrated wall,
// door, door frame, barrel and CommonTree_1 members -> scene.import.gltf@2 -> scene.place.gltf@1 ->
// a gltf-resources-v1 bundle with the greyhaven-starter-descriptor-v1 attachment -> release tar.
// Needs hydrated Git LFS payloads: skips with a reason on pointers, and fails instead when
// ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 (set in the hosted canonical-storage job).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { readAssetBundleTar, verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import {
  GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, readAssetBundleGltf, verifyAssetBundle,
  type GltfResourcesBundleManifest,
} from "../src/asset-bundle.js";
import {
  GREYHAVEN_BUNDLE_VARIANT, GREYHAVEN_DESCRIPTOR_ATTACHMENT, GREYHAVEN_DESCRIPTOR_SCHEMA, GREYHAVEN_MEMBERS, GREYHAVEN_VARIATIONS,
  buildGreyhavenStarter, worldTriangles,
} from "../scripts/build-greyhaven-starter.ts";

type Json = Record<string, any>;
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REQUIRE_HYDRATED = process.env.ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE === "1";
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
/** The #118 pre-flight measurement of the wall's opening (2026-10-14). */
const PREFLIGHT_DOORWAY = { width: 1.2956, height: 2.1511 };
const WOODTRIM = ["t-woodtrim-normal-png", "t-woodtrim-basecolor-png", "t-woodtrim-roughness-png"]
  .map((slug) => `quaternius.medieval-village-megakit-standard.${slug}`);

const sources: Json[] = JSON.parse(await readFile(path.join(ROOT, "catalog/sources.json"), "utf8")).sources;
const storage: Json = JSON.parse(await readFile(path.join(ROOT, "catalog/storage.json"), "utf8"));
const archives = new Set(GREYHAVEN_MEMBERS.map((member) => member.archive));
const memberIds = new Set(sources.filter((source) => archives.has(source.archiveMember?.archive)).map((source) => source.id as string));

async function hydration(): Promise<{ pointers: string[]; missing: string[] }> {
  const pointers: string[] = [], missing: string[] = [];
  for (const entry of storage.entries.filter((candidate: Json) => memberIds.has(candidate.sourceId))) {
    try {
      const head = (await readFile(path.join(ROOT, entry.path))).subarray(0, 64).toString("utf8");
      if (head.startsWith(LFS_POINTER_PREFIX)) pointers.push(entry.path);
    } catch { missing.push(entry.path); }
  }
  return { pointers, missing };
}
const state = await hydration();
const skip: string | false = state.pointers.length > 0 && !REQUIRE_HYDRATED
  ? `Git LFS payloads are not hydrated (${state.pointers.length} pointer files, e.g. ${state.pointers[0]}); run 'git lfs pull' or set ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`
  : false;

type Box = { min: number[]; max: number[] };
const boxOf = (proxy: { center: number[]; size: number[] }): Box => ({
  min: proxy.center.map((c, i) => c - proxy.size[i]! / 2), max: proxy.center.map((c, i) => c + proxy.size[i]! / 2),
});
/** Overlap volume, ignoring overlaps up to the descriptor's 1e-6 m rounding on any axis. */
const overlapVolume = (a: Box, b: Box) => [0, 1, 2].reduce((volume, i) => volume * Math.max(0, Math.min(a.max[i]!, b.max[i]!) - Math.max(a.min[i]!, b.min[i]!) - 1e-5), 1);

test("hydration state of the starter bundle members", () => {
  assert.deepEqual(state.missing, [], "starter payloads missing from durable storage");
  if (REQUIRE_HYDRATED) assert.deepEqual(state.pointers, [], "ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1 but payloads are LFS pointers");
});

test("the Greyhaven starter recipe builds a verified bundle with a measured doorway and open collision proxies", { skip, timeout: 600_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "greyhaven-starter-"));
  try {
    // The lod1/lod2 variants need Blender (#123); the hosted storage job has none and checks the LOD0 entries.
    const lods = Boolean(process.env.ASSET_TOOLING_BLENDER);
    const built = await buildGreyhavenStarter({ outDir, lods });

    // Bundle and tar verify against the content-only export ref.
    const checked = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const manifest = checked.manifest as GltfResourcesBundleManifest;
    const tar = await readFile(built.tar);
    await verifyAssetBundleTar(tar, { sha256: built.tarSha256, ref: built.exportRef });
    assert.equal((await readFile(`${built.tar}.sha256`, "utf8")).split(/\s+/)[0], built.tarSha256);
    const keys = [...GREYHAVEN_MEMBERS, ...GREYHAVEN_VARIATIONS].map((member) => member.key);
    const variants = lods ? [GREYHAVEN_BUNDLE_VARIANT, "lod1", "lod2"] : [GREYHAVEN_BUNDLE_VARIANT];
    assert.deepEqual(manifest.assets.map((entry) => [entry.key, entry.variant]).sort(), keys.flatMap((key) => variants.map((variant) => [key, variant])).sort());

    // The WoodTrim textures shared by wall, door and door frame are stored once (resized for the game since #124,
    // so they are matched by image name rather than by their source pins).
    const entry = (key: string) => manifest.assets.find((candidate) => candidate.key === key && candidate.variant === GREYHAVEN_BUNDLE_VARIANT)!;
    const woodTrim = async (key: string) => {
      const json = JSON.parse((await readAssetBundleGltf(built.bundleDir, manifest, key, GREYHAVEN_BUNDLE_VARIANT)).gltf.toString("utf8"));
      return new Map<string, string>((json.images as Json[]).filter((image) => /^T_WoodTrim_/.test(image.name ?? "")).map((image) => [image.name, path.posix.basename(image.uri)]));
    };
    const [wallTrim, doorTrim, frameTrim] = await Promise.all(["greyhaven.starter.wall", "greyhaven.starter.door", "greyhaven.starter.door-frame"].map(woodTrim));
    assert.equal(wallTrim!.size, WOODTRIM.length, "the wall uses the three WoodTrim textures");
    for (const [name, file] of wallTrim!) {
      assert.equal(doorTrim!.get(name), file, `${name} is one resource of wall and door`);
      assert.equal(frameTrim!.get(name), file, `${name} is one resource of wall and door frame`);
      assert.equal(readAssetBundleTar(tar).filter((item) => path.posix.basename(item.path) === file).length, 1, `${name} is in the tar once`);
    }
    const distinct = new Set(manifest.assets.flatMap((item) => item.resources.map((resource) => resource.path)));
    assert.deepEqual((await readdir(path.join(built.bundleDir, "resources"))).sort(), [...distinct].map((p) => path.posix.basename(p)).sort());
    assert.ok(distinct.size < manifest.assets.reduce((sum, item) => sum + item.resources.length, 0), "shared resources are deduplicated");

    // The descriptor attachment is the one the build returned.
    const descriptor: Json = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "greyhaven.starter.wall", GREYHAVEN_BUNDLE_VARIANT, GREYHAVEN_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.deepEqual(descriptor as unknown, built.descriptor);
    assert.equal(descriptor.schema, GREYHAVEN_DESCRIPTOR_SCHEMA);
    assert.equal(descriptor.units, "metre");
    assert.equal(descriptor.up, "+Y");
    const asset = (role: string) => descriptor.assets.find((item: Json) => item.role === role);
    assert.deepEqual(descriptor.assets.map((item: Json) => item.key).sort(), [...keys].sort());
    // #123: each level has fewer triangles than the one before and shares its LOD0's textures.
    for (const described of descriptor.assets) {
      const levels = described.lods as Json[];
      assert.equal(levels.length, lods ? 3 : 1, described.key);
      for (let index = 1; index < levels.length; index += 1) assert.ok(levels[index]!.triangles < levels[index - 1]!.triangles, `${described.key} ${levels[index]!.variant}`);
      if (lods) {
        const images = (variant: string) => new Set(manifest.assets.find((item) => item.key === described.key && item.variant === variant)!.resources.filter((resource) => resource.path.endsWith(".png")).map((resource) => resource.path));
        for (const image of images("lod2")) assert.ok(images(GREYHAVEN_BUNDLE_VARIANT).has(image), `${described.key} lod2 shares ${image}`);
      }
    }
    // #121 variations: their requested size, their source recorded, and the source's textures shared, not copied.
    for (const variation of GREYHAVEN_VARIATIONS) {
      const described = descriptor.assets.find((item: Json) => item.key === variation.key);
      const base = GREYHAVEN_MEMBERS.find((member) => member.role === variation.base)!;
      assert.equal(described.variationOf, base.key, variation.key);
      for (const [axis, field] of [["x", "width"], ["y", "height"], ["z", "depth"]] as const) {
        if (variation.size[axis] !== undefined) assert.ok(Math.abs(described.footprint[field] - variation.size[axis]!) < 1e-4, `${variation.key} ${field}`);
      }
      const images = (key: string) => new Set(entry(key).resources.filter((resource) => resource.path.endsWith(".png")).map((resource) => resource.path));
      for (const image of images(variation.key)) assert.ok(images(base.key).has(image), `${variation.key} shares ${image} with ${base.key}`);
    }

    // Every placed asset stands on y = 0, measured on the bundled glTF, under its greyhaven.<role> parent.
    const io = new NodeIO();
    for (const member of GREYHAVEN_MEMBERS) {
      const { gltf, resources } = await readAssetBundleGltf(built.bundleDir, manifest, member.key, GREYHAVEN_BUNDLE_VARIANT);
      const document = await io.readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries(resources) as Record<string, Uint8Array<ArrayBuffer>> });
      assert.deepEqual(document.getRoot().getDefaultScene()!.listChildren().map((node) => node.getName()), [`greyhaven.${member.role}`]);
      const { positions } = worldTriangles(document);
      let minY = Infinity;
      for (let i = 1; i < positions.length; i += 3) minY = Math.min(minY, positions[i]!);
      assert.ok(Math.abs(minY) <= 1e-6, `${member.role}: placed min Y ${minY} is 0`);
      assert.equal(asset(member.role).bounds.min[1], 0, `${member.role}: descriptor min Y`);
    }

    // The door's hinge is its source node origin; it is recorded before and after placement.
    const door = asset("door");
    assert.equal(door.sourcePivot.node, "Door_1_Flat");
    assert.deepEqual(door.sourcePivot.sourceWorldPosition, [0, 0, 0]);
    door.sourcePivot.placedWorldPosition.forEach((value: number, i: number) => assert.ok(Math.abs(value - door.placement.translation[i]) <= 1e-6));

    // The measured doorway matches the pre-flight measurement and holds the closed door with clearance.
    const wall = asset("wall");
    const doorway = wall.doorway;
    assert.ok(Math.abs(doorway.width - PREFLIGHT_DOORWAY.width) <= 0.02, `doorway width ${doorway.width}`);
    assert.ok(Math.abs(doorway.height - PREFLIGHT_DOORWAY.height) <= 0.02, `doorway height ${doorway.height}`);
    assert.ok(doorway.depth > 0);
    assert.ok(door.footprint.width < doorway.width && door.footprint.height < doorway.height, "door clearance > 0");
    const mounted: Box = { min: door.bounds.min.map((v: number, i: number) => v + door.mount.translation[i]), max: door.bounds.max.map((v: number, i: number) => v + door.mount.translation[i]) };
    for (const i of [0, 1, 2]) assert.ok(mounted.min[i]! >= doorway.min[i] - 1e-6 && mounted.max[i]! <= doorway.max[i] + 1e-6, `mounted door inside the doorway on axis ${i}`);
    const doorCenter = door.collisionProxies[0].center.map((v: number, i: number) => v + door.mount.translation[i]);
    for (const i of [0, 1, 2]) assert.ok(doorCenter[i] > doorway.min[i] && doorCenter[i] < doorway.max[i], "doorway contains the door centre");

    // Wall proxies are the two jambs and the lintel; none of them reaches into the doorway.
    assert.deepEqual(wall.collisionProxies.map((proxy: Json) => proxy.name), ["left-jamb", "right-jamb", "lintel"]);
    const opening: Box = { min: doorway.min, max: doorway.max };
    for (const proxy of wall.collisionProxies) {
      assert.equal(proxy.tag, "solid");
      assert.equal(overlapVolume(boxOf(proxy), opening), 0, `${proxy.name} leaves the doorway clear`);
    }
    assert.deepEqual(door.collisionProxies.map((proxy: Json) => proxy.tag), ["dynamic-door"]);
    assert.equal(asset("barrel").collisionProxies.length, 1);
    const trunk = asset("tree").collisionProxies;
    assert.deepEqual(trunk.map((proxy: Json) => proxy.name), ["trunk"]);
    assert.ok(trunk[0].size[0] < 1.2 && trunk[0].size[2] < 1.2 && trunk[0].size[0] < asset("tree").footprint.width / 3, "trunk box is the trunk, not the crown");
  } finally { await rm(outDir, { recursive: true, force: true }); }
});
