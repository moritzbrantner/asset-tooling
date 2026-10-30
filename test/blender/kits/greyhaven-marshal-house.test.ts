// Marshal Elden Greywatch's house (#413, docs/greyhaven-marshal-house.md): the scripted Blender recipe builds a
// verified gltf-resources-v1 bundle on mmorpg's 8 x 6 m house footprint (collider 103), with an open doorway, a door
// whose open sweep stays inside the room, furniture clear of the entrance and of the bedside, and the knock,
// doorway, bedside and sleep spots. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  HOUSE_DESCRIPTOR_ATTACHMENT, HOUSE_DESCRIPTOR_SCHEMA, HOUSE_PARTS, buildGreyhavenMarshalHouse, createHouseAssetSpec, houseKey,
} from "../../../scripts/build-greyhaven-marshal-house.ts";

type Box = { min: number[]; max: number[] };
const overlaps = (a: Box, b: Box, epsilon = 1e-6) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! - epsilon && b.min[k]! < a.max[k]! - epsilon);
const inside = (a: Box, b: Box, epsilon = 1e-6) => [0, 1, 2].every((k) => a.min[k]! >= b.min[k]! - epsilon && a.max[k]! <= b.max[k]! + epsilon);
const around = (p: number[], r: number, h = 1.8): Box => ({ min: [p[0]! - r, p[1]!, p[2]! - r], max: [p[0]! + r, p[1]! + h, p[2]! + r] });

test("the house spec runs the packaged recipe with the kit and the settlement props as inputs", () => {
  const spec = createHouseAssetSpec({ part: "door", scriptSha256: "a".repeat(64), outpostSha256: "b".repeat(64), settlementSha256: "c".repeat(64), commonSha256: "d".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "door" } });
  assert.deepEqual(Object.keys(spec.inputs).sort(), ["common", "outpost", "script", "settlement"]);
  assert.deepEqual([...HOUSE_PARTS], ["shell", "ceiling", "roof", "door", "furniture", "collision"]);
});

test("the house recipe builds a verified bundle on collider 103 with an open doorway, a clear door swing and clear spots", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 900_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "marshal-house-"));
  try {
    const built = await buildGreyhavenMarshalHouse({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => entry.key).sort(), HOUSE_PARTS.map(houseKey).sort());
    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, houseKey("shell"), "default", HOUSE_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.schema, HOUSE_DESCRIPTOR_SCHEMA);
    assert.deepEqual(d.hideForInterior, [houseKey("roof"), houseKey("ceiling")]);
    // The kit's house: walls on the 8 x 6 m footprint, eaves 0.35 m and verges 0.3 m beyond it, the chimney outside +X.
    assert.ok(inside(d.bounds, { min: [-4.31, -0.1, -3.45], max: [4.9, 6.1, 3.45] }), "the house stands on its footprint");

    const colliders = d.colliders as (Box & { node: string; tag: string; name: string; frame: string })[];
    assert.deepEqual([...new Set(colliders.map((c) => c.tag))].sort(), ["door", "floor", "furniture", "wall"]);
    for (const c of colliders) assert.equal(c.node, `collider.${c.tag}.${c.name}`);
    const furniture = colliders.filter((c) => c.tag === "furniture");
    assert.deepEqual(furniture.map((c) => c.name).sort(), [...d.furniture].sort(), "every furniture node has its collider");
    for (const item of ["bed", "chest", "table", "chair", "bench", "hearth", "weapon-rack"]) assert.ok(d.furniture.includes(item), `${item} is furnished`);

    const doorway: Box = { min: [-0.6, 0, 2.68], max: [0.6, 2.2, 3] };
    for (const wall of colliders.filter((c) => c.tag === "wall")) assert.ok(!overlaps(wall, doorway), `${wall.name} stays out of the doorway`);
    assert.ok(inside(d.door.closed, { min: [-0.6, 0, 2.68], max: [0.6, 2.2, 3] }), "closed leaf fits the doorway");
    const room: Box = d.room;
    assert.ok(inside(d.door.open, { min: [-0.7, 0, room.min[2]!], max: [room.max[0]!, room.max[1]!, d.door.mount.translation[2] + 0.02] }), "open leaf stays inside the room (its hinge edge in the wall)");

    // Nothing stands in the door's swing, the walk in, the doorway spot or beside the bed.
    const swing: Box = { min: [-0.7, 0, 1.6], max: [0.6, 2.2, 2.9] };
    const walk: Box = { min: [-0.6, 0, -1.2], max: [0.6, 2, 2.68] };
    const clear = [swing, walk, d.spots.doorway as Box, around(d.spots.bedside.position, 0.3)];
    for (const item of furniture) {
      assert.ok(inside(item, { min: [room.min[0]!, 0, room.min[2]!], max: room.max }), `${item.name} is inside the room`);
      for (const box of clear) assert.ok(!overlaps(item, box), `${item.name} keeps the entrance and the bedside clear`);
      for (const other of furniture.filter((c) => c.name > item.name)) assert.ok(!overlaps(item, other), `${item.name} and ${other.name} do not overlap`);
    }
    const bed = furniture.find((c) => c.name === "bed")!;
    assert.ok(inside({ min: d.spots.sleep.position, max: d.spots.sleep.position }, bed), "the sleep spot lies on the bed");
    assert.ok(d.spots.doorstep.position[2] > 3, "the knock spot is outside the front wall");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
