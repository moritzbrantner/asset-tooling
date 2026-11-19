// Greyhaven mounts (#769, docs/mounts.md): the recipe turns the hash-pinned CC0 Quaternius horse into a verified
// gltf-resources-v1 bundle of a tacked riding horse with its rider sockets and in-place riding gaits, and replays to the
// same tar. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2 and the source is hydrated (git lfs pull).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { readAssetBundleAttachment, readAssetBundleGltf, verifyAssetBundle, type GltfResourcesBundleManifest } from "../../../src/asset-bundle.js";
import { MOUNT_GAITS, MOUNT_SEAT_HEIGHT, MOUNT_STILL_SECONDS, MOUNT_TACK, rideArguments } from "../../../src/mounts.js";
import {
  HORSE_CLIPS, HORSE_KEY, HORSE_SOCKETS, HORSE_SOURCE, MOUNTS_DESCRIPTOR_ATTACHMENT, MOUNTS_DESCRIPTOR_FILE, MOUNTS_DESCRIPTOR_SCHEMA, MOUNTS_RELEASE,
  buildMounts, createMountAssetSpec,
} from "../../../scripts/build-mounts.ts";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const storage: { entries: { sourceId: string; path: string }[] } = JSON.parse(await readFile(path.join(root, "catalog/storage.json"), "utf8"));
const entry = storage.entries.find((item) => item.sourceId === HORSE_SOURCE.sourceId);
assert.ok(entry, `${HORSE_SOURCE.sourceId} has canonical storage`);
const pointer = (await readFile(path.join(root, entry.path))).subarray(0, 64).toString().startsWith("version https://git-lfs.github.com/spec/v1");
const skip = !process.env.ASSET_TOOLING_BLENDER ? "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)"
  : pointer ? "requires the hydrated Quaternius horse (git lfs pull)" : false;

test("the mount spec runs the packaged recipe over the pinned horse with the shared gaits and tack", () => {
  const spec = createMountAssetSpec({ sourceSha256: "b".repeat(64), scriptSha256: "a".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(Object.keys(spec.inputs).sort(), ["script", "source"]);
  assert.deepEqual(Object.keys((spec.parameters.arguments as any).gaits), ["Walk_Loop", "Trot_Loop", "Canter_Loop", "Gallop_Loop"]);
  assert.equal(MOUNTS_RELEASE, "mounts", "one rolling release, never numbered");
  // The rider's family gets the same gait lengths, tack points and seat height.
  const ride = rideArguments();
  assert.deepEqual(ride.tack, { reins: [...MOUNT_TACK.reins], stirrup: [...MOUNT_TACK.stirrup] });
  assert.equal(ride.gaits.Trot_Loop!.seconds, MOUNT_GAITS.Trot_Loop.seconds);
  assert.equal(ride.gaits.Turn_L!.seconds, MOUNT_STILL_SECONDS.Turn_L);
});

test("the mounts recipe builds a verified, reproducible tacked horse with sockets and in-place gaits", { skip, timeout: 900_000 }, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "mounts-"));
  const replayDir = await mkdtemp(path.join(os.tmpdir(), "mounts-replay-"));
  try {
    const built = await buildMounts({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const manifest = (await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: "gltf-resources-v1" })).manifest as GltfResourcesBundleManifest;
    assert.deepEqual(manifest.assets.map((item) => item.key), [HORSE_KEY]);
    const descriptor = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, HORSE_KEY, "default", MOUNTS_DESCRIPTOR_ATTACHMENT)).toString());
    assert.equal(descriptor.schema, MOUNTS_DESCRIPTOR_SCHEMA);
    assert.deepEqual(descriptor, JSON.parse(await readFile(path.join(outDir, MOUNTS_DESCRIPTOR_FILE), "utf8")), "the attachment is the descriptor file");

    const item = await readAssetBundleGltf(built.bundleDir, manifest, HORSE_KEY, "default");
    const document = await new NodeIO().readJSON({ json: JSON.parse(item.gltf.toString()), resources: Object.fromEntries(item.resources) });
    const gltf = document.getRoot();
    assert.equal(gltf.listSkins().length, 1, "one skinned rig carries the horse and its tack");
    assert.deepEqual(gltf.listAnimations().map((a) => a.getName()).sort(), [...HORSE_CLIPS].sort());
    assert.equal(gltf.getDefaultScene()?.listChildren().map((node) => node.getName()).join(), HORSE_KEY, "root node");

    const horse = descriptor.assets[0];
    assert.equal(horse.restBounds.min[1], 0, "stands on y = 0");
    for (const k of [0, 2]) assert.ok(Math.abs(horse.restBounds.min[k] + horse.restBounds.max[k]) < 1e-3, "centred on its footprint");
    assert.ok(Math.abs(horse.size.height - 2.05) < 1e-3, "2.05 m at the ears");
    assert.ok(Math.abs(horse.seat.heightMeters - MOUNT_SEAT_HEIGHT) < .005, `the seat is ${MOUNT_SEAT_HEIGHT} m up, as the ride clips assume`);

    // The sockets ride Torso2; seen from the root at rest they sit at the tack's seat-frame points.
    assert.deepEqual(horse.sockets.map((s: any) => s.id), [...HORSE_SOCKETS]);
    const seat = horse.sockets.find((s: any) => s.id === "saddle.seat").restAt;
    for (const [id, local, mirror] of [["reins.l", MOUNT_TACK.reins, 1], ["reins.r", MOUNT_TACK.reins, -1], ["stirrup.l", MOUNT_TACK.stirrup, 1], ["stirrup.r", MOUNT_TACK.stirrup, -1]] as const) {
      const at = horse.sockets.find((s: any) => s.id === id).restAt;
      assert.deepEqual(at.map((v: number, k: number) => +(v - seat[k]).toFixed(3)), [mirror * local[0], local[1], local[2]], id);
    }
    for (const socket of horse.sockets) {
      assert.equal(socket.joint, "Torso2");
      assert.ok(Math.abs(Math.hypot(...socket.rotation) - 1) < 1e-4, `${socket.id} has a unit rotation`);
    }

    // Each gait loops a stride at its speed with the hooves planted (the speed added back) and in its footfall order.
    for (const [name, gait] of Object.entries(MOUNT_GAITS)) {
      const clip = horse.clips[name];
      assert.ok(Math.abs(clip.seconds - gait.seconds) < .02 && clip.speedMetersPerSecond === gait.speed, name);
      assert.ok(clip.hoofSlideMeters < .01, `${name} keeps its hooves planted (${clip.hoofSlideMeters} m)`);
    }
    const order = (name: string) => Object.entries(horse.clips[name].footfalls as Record<string, { touchdown: number }>)
      .sort((a, b) => a[1].touchdown - b[1].touchdown).map(([leg]) => leg);
    assert.deepEqual(order("Walk_Loop"), ["LH", "LF", "RH", "RF"], "the walk is a lateral four-beat");
    const trot = horse.clips.Trot_Loop.footfalls;
    assert.ok(trot.LH.touchdown === trot.RF.touchdown && trot.RH.touchdown === trot.LF.touchdown && trot.LH.touchdown !== trot.RH.touchdown, "the trot pairs the diagonals");
    const canter = horse.clips.Canter_Loop.footfalls;
    assert.equal(new Set(Object.values(canter).map((f: any) => f.touchdown)).size, 3, "the canter has three beats");
    assert.deepEqual(order("Gallop_Loop"), ["LH", "RH", "LF", "RF"], "the right-lead gallop is a transverse four-beat");
    assert.equal(horse.clips.Turn_L.turnDegrees, 90);
    assert.equal(horse.clips.Turn_R.turnDegrees, -90);
    for (const [name, seconds] of Object.entries(MOUNT_STILL_SECONDS)) assert.ok(Math.abs(horse.clips[name].seconds - seconds) < .02, name);
    assert.ok(horse.clips.Halt.travelMeters > .5, "the halt reports its travel");
    assert.equal(horse.provenance.license, "CC0-1.0");
    assert.equal(horse.provenance.catalogSource, HORSE_SOURCE.sourceId);

    const replay = await buildMounts({ outDir: replayDir });
    assert.equal(replay.tarSha256, built.tarSha256, "an independent rebuild packs the same tar");
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(replayDir, { recursive: true, force: true });
  }
});
