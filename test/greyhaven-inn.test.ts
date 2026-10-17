// Greyhaven Outpost inn (#272, docs/greyhaven-inn.md): the scripted Blender recipe builds a verified
// gltf-resources-v1 bundle whose descriptor fits mmorpg's inn collider 101, keeps the doorway open, and
// gives the door a hinge whose open sweep stays inside the room and clear of the furniture.
// The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2 (the hosted blender-script job).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { verifyAssetBundleTar } from "../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../src/asset-bundle.js";
import { INN_DESCRIPTOR_ATTACHMENT, INN_DESCRIPTOR_SCHEMA, INN_PARTS, INN_PLACEMENT_FOOTPRINT, buildGreyhavenInn, createInnAssetSpec } from "../scripts/build-greyhaven-inn.ts";

type Box = { min: number[]; max: number[] };
const overlaps = (a: Box, b: Box, epsilon = 1e-6) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! - epsilon && b.min[k]! < a.max[k]! - epsilon);
const inside = (a: Box, b: Box, epsilon = 1e-6) => [0, 1, 2].every((k) => a.min[k]! >= b.min[k]! - epsilon && a.max[k]! <= b.max[k]! + epsilon);

test("the inn spec runs the packaged recipe with exactly one part", () => {
  const spec = createInnAssetSpec({ part: "door", scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "door" } });
  assert.deepEqual([...INN_PARTS], ["shell", "ceiling", "roof", "door", "furniture", "collision"]);
});

test("the inn recipe builds a verified bundle that fits collider 101 with an open doorway and a clear door swing", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 900_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "greyhaven-inn-"));
  try {
    const built = await buildGreyhavenInn({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    assert.deepEqual(manifest.assets.map((entry) => entry.key).sort(), INN_PARTS.map((part) => `greyhaven.inn.${part}`).sort());
    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "greyhaven.inn.shell", "default", INN_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    assert.equal(d.schema, INN_DESCRIPTOR_SCHEMA);
    assert.deepEqual(d.footprint, INN_PLACEMENT_FOOTPRINT, "the inn fills mmorpg's 14 x 10 x 6 m footprint exactly");
    assert.deepEqual(d.bounds, { min: [-7, 0, -5], max: [7, 6, 5] });
    assert.deepEqual(d.hideForInterior, ["greyhaven.inn.roof", "greyhaven.inn.ceiling"]);

    const colliders = d.colliders as (Box & { node: string; tag: string; name: string; frame: string })[];
    assert.deepEqual([...new Set(colliders.map((c) => c.tag))].sort(), ["door", "floor", "furniture", "wall"]);
    for (const c of colliders) assert.equal(c.node, `collider.${c.tag}.${c.name}`);
    assert.deepEqual(colliders.filter((c) => c.tag === "furniture").map((c) => c.name).sort(), [...d.furniture].sort(), "every furniture node has its collider");
    // The doorway (between the jambs, below the lintel, through the wall) is free of every wall collider.
    const doorway: Box = { min: [-0.6, 0, 4.5], max: [0.6, 2.2, 4.8] };
    for (const wall of colliders.filter((c) => c.tag === "wall")) assert.ok(!overlaps(wall, doorway), `${wall.name} stays out of the doorway`);
    // The closed leaf sits in the doorway; the open leaf lies inside the room.
    assert.ok(inside(d.door.closed, { min: [-0.6, 0, 4.4], max: [0.6, 2.2, 4.8] }), "closed leaf fits the doorway");
    const room: Box = { min: [-6.5, 0, -4.5], max: [6.5, 3.0, 4.53] };
    assert.ok(inside(d.door.open, room), "open leaf stays inside the room");
    // Nothing stands in the door's swing or in the walk from the door to the bar.
    const swing: Box = { min: [-0.72, 0, 3.3], max: [0.6, 2.2, 4.53] };
    const path: Box = { min: [-0.6, 0, -1.6], max: [0.6, 2, 4.5] };
    for (const item of colliders.filter((c) => c.tag === "furniture")) {
      assert.ok(inside(item, room), `${item.name} is inside the room`);
      assert.ok(!overlaps(item, swing) && !overlaps(item, path), `${item.name} keeps the entrance clear`);
      for (const other of colliders.filter((c) => c.tag === "furniture" && c.name > item.name && !(c.name.startsWith("bar-counter") && item.name.startsWith("bar-counter")))) {
        assert.ok(!overlaps(item, other), `${item.name} and ${other.name} do not overlap`);
      }
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
