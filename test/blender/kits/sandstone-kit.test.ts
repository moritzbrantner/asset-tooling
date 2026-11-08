// Red sandstone building kit (docs/sandstone-kit.md): the recipe builds a verified gltf-resources-v1 bundle whose wall
// modules sit on the 2 m grid, whose doorway stays open for the door leaf and whose compositions fill their footprints,
// with doors on long sides and gable ends. The build skips unless ASSET_TOOLING_BLENDER names Blender 5.2.2.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Document } from "@gltf-transform/core";
import { verifyAssetBundleTar } from "../../../src/asset-bundle-pack.js";
import { GLTF_RESOURCES_BUNDLE_PROFILE, readAssetBundleAttachment, verifyAssetBundle } from "../../../src/asset-bundle.js";
import {
  SANDSTONE_DESCRIPTOR_ATTACHMENT, SANDSTONE_PARTS, SANDSTONE_RELEASE, SANDSTONE_TRIANGLE_BUDGET, buildSandstoneKit, createSandstoneAssetSpec, sandstoneKey,
} from "../../../scripts/build-sandstone-kit.ts";
import { KIT_BUDGETS, kitBudgetViolations, kitCost } from "../../../scripts/report-kit-costs.ts";

/** Every vertex of a document in its module frame. */
function vertices(document: Document): number[][] {
  const out: number[][] = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!, p: number[] = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i += 1) {
        position.getElement(i, p);
        out.push([0, 1, 2].map((k) => m[k]! * p[0]! + m[4 + k]! * p[1]! + m[8 + k]! * p[2]! + m[12 + k]!));
      }
    }
  }
  return out;
}

/** A module-frame point turned by ``yaw`` degrees about +Y and moved by ``t``. */
const place = (p: number[], t: number[], yaw: number) => {
  const a = (yaw * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [p[0]! * c + p[2]! * s + t[0]!, p[1]! + t[1]!, -p[0]! * s + p[2]! * c + t[2]!];
};
const part = (item: { key: string }) => item.key.split(".").pop()!;

test("the sandstone spec runs the packaged recipe with exactly one module", () => {
  const spec = createSandstoneAssetSpec({ part: "roof-8", scriptSha256: "a".repeat(64), outpostSha256: "b".repeat(64), commonSha256: "c".repeat(64), kitSha256: "d".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(spec.parameters, { blenderVersion: "5.2.2", arguments: { schemaVersion: 1, part: "roof-8" } });
  assert.equal(spec.assetId, "sandstone.kit.roof-8");
  assert.equal(SANDSTONE_RELEASE, "sandstone-kit", "one rolling release, never numbered");
  const halved = createSandstoneAssetSpec({ part: "wall", atlas: "1024", scriptSha256: "a".repeat(64), outpostSha256: "b".repeat(64), commonSha256: "c".repeat(64), kitSha256: "d".repeat(64), blenderVersion: "5.2.2" });
  assert.deepEqual(halved.parameters.arguments, { schemaVersion: 1, part: "wall", atlas: "1024" });
});

test("the 1024 atlas mode builds the same kit with a quarter of the texture memory", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "sandstone-kit-1024-"));
  try {
    const built = await buildSandstoneKit({ outDir, atlas: "1024" });
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, ["sandstone-kit-1024"]);
    assert.equal(cost.textureMemoryBytes, Math.round((1024 * 1024 * 4) / 3) * 3);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[SANDSTONE_RELEASE]!), []);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("the sandstone recipe builds a verified kit whose doorway stays open and whose compositions fill their footprints", {
  skip: process.env.ASSET_TOOLING_BLENDER ? false : "set ASSET_TOOLING_BLENDER to Blender 5.2.2 (snap Blender: TMPDIR under $HOME)", timeout: 1_200_000,
}, async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "sandstone-kit-"));
  try {
    const built = await buildSandstoneKit({ outDir });
    await verifyAssetBundleTar(await readFile(built.tar), { sha256: built.tarSha256, ref: built.exportRef });
    const { manifest } = await verifyAssetBundle(built.bundleDir, built.exportRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
    const entries = manifest.assets.map((entry) => `${entry.key}#${entry.variant}`).sort();
    assert.deepEqual(entries, SANDSTONE_PARTS.map((name) => `${sandstoneKey(name)}#default`).sort());
    const d = JSON.parse((await readAssetBundleAttachment(built.bundleDir, manifest, "sandstone.kit.wall", "default", SANDSTONE_DESCRIPTOR_ATTACHMENT)).toString("utf8"));
    const asset = Object.fromEntries(d.assets.map((a: any) => [a.role, a]));

    // One atlas: colour, normal and ORM, all KTX2 and stored once, and the kit fits its cost budget.
    const resources = await readdir(path.join(built.bundleDir, "resources"));
    assert.equal(resources.filter((name) => name.endsWith(".png")).length, 0);
    assert.equal(resources.filter((name) => name.endsWith(".ktx2")).length, 3);
    const cost = await kitCost(built.bundleDir);
    assert.deepEqual(cost.materials, ["sandstone-kit"]);
    assert.deepEqual(kitBudgetViolations(cost, KIT_BUDGETS[SANDSTONE_RELEASE]!), []);

    for (const name of SANDSTONE_PARTS) assert.ok(asset[name].triangles <= SANDSTONE_TRIANGLE_BUDGET[name], `${name}: ${asset[name].triangles} triangles`);

    // Wall modules fill their grid width, stand 4 m high and keep the wall thickness.
    for (const [name, width] of [["wall", 2], ["wall-half", 1], ["wall-window", 2], ["wall-door", 2]] as const) {
      const a = asset[name];
      assert.ok(Math.abs(a.bounds.min[0] + width / 2) < 1e-6 && Math.abs(a.bounds.max[0] - width / 2) < 1e-6, `${name} spans its module`);
      assert.ok(Math.abs(a.bounds.max[1] - 4) < 1e-6, `${name} is 4 m high`);
      assert.ok(a.bounds.min[2] >= -0.5 - 1e-6, `${name} stays inside the wall thickness`);
    }

    // Nothing reaches into the doorway below the arch's spring, and the closed leaf fits it.
    const doorway = asset["wall-door"].doorway;
    const clear = { min: [doorway.min[0] + 1e-3, 0.01, doorway.min[2] + 1e-3], max: [doorway.max[0] - 1e-3, doorway.spring - 1e-3, doorway.max[2] - 1e-3] };
    for (const v of vertices(built.documents["wall-door"])) assert.ok(!v.every((c, k) => c > clear.min[k]! && c < clear.max[k]!), `wall-door vertex ${v} is inside the doorway`);
    const mount = asset["wall-door"].mount.translation, leaf = asset.door.leafBounds;
    assert.ok(mount[0] + leaf.min[0] >= doorway.min[0] && mount[0] + leaf.max[0] <= doorway.max[0], "the closed leaf fits the doorway's width");
    assert.ok(mount[1] + leaf.max[1] <= doorway.max[1] && mount[1] >= 0, "the closed leaf fits the doorway's height");
    assert.equal(asset.door.hinge.node, "hinge");

    // Gables stand above their roof and a chimney clears the ridge.
    for (const span of [6, 8]) assert.ok(asset[`gable-${span}`].gable.apex > asset[`roof-${span}`].roof.ridgeTop, `the ${span} m gable stands above its roof`);
    assert.ok(asset["roof-8"].roof.ridgeTop > asset["roof-6"].roof.ridgeTop);

    assert.deepEqual(Object.keys(d.compositions).sort(), ["cottage", "gable-house", "hall", "longhouse", "merchant", "workshop"]);
    const WALLS = ["wall", "wall-half", "wall-window", "wall-door"];
    for (const [name, { footprint, items }] of Object.entries<any>(d.compositions)) {
      const hx = footprint.width / 2, hz = footprint.depth / 2;
      for (const item of items) assert.ok(entries.includes(`${item.key}#${item.variant}`), `${name}: ${item.key}#${item.variant}`);
      const walls = items.filter((item: any) => WALLS.includes(part(item)));
      for (const [axis, half, other] of [[2, hz, hx], [2, -hz, hx], [0, hx, hz], [0, -hx, hz]] as const) {
        const side = walls.filter((item: any) => Math.abs(item.translation[axis] - half) < 1e-6);
        const width = side.reduce((sum: number, item: any) => sum + asset[part(item)].module.width, 0);
        assert.ok(Math.abs(width - other * 2) < 1e-6, `${name}: the side at ${axis === 2 ? "z" : "x"} = ${half} is filled (${width} m)`);
        for (const item of side) {
          const outward = place([0, 0, 1], [0, 0, 0], item.yawDegrees);
          assert.ok(Math.abs(outward[axis]! - Math.sign(half)) < 1e-6, `${name}: ${item.key} at ${item.translation} faces outwards`);
        }
      }
      // Every doorway has its leaf, no door sits in a run's end module (the corner stones are there), and +Z has a door.
      const doors = items.filter((item: any) => part(item) === "door"), wallDoors = items.filter((item: any) => part(item) === "wall-door");
      assert.equal(doors.length, wallDoors.length, `${name}: one leaf per doorway`);
      for (const wallDoor of wallDoors) {
        const hinge = place(mount, wallDoor.translation, wallDoor.yawDegrees);
        assert.ok(doors.some((door: any) => hinge.every((c, k) => Math.abs(c - door.translation[k]) < 1e-6) && door.yawDegrees === wallDoor.yawDegrees), `${name}: the door is mounted`);
        const run = Math.abs(Math.abs(wallDoor.translation[2]) - hz) < 1e-6 ? hx : hz;
        const along = Math.abs(Math.abs(wallDoor.translation[2]) - hz) < 1e-6 ? wallDoor.translation[0] : wallDoor.translation[2];
        assert.ok(Math.abs(along) + 1 < run - 0.5, `${name}: the door at ${wallDoor.translation} clears the corner stones`);
      }
      assert.ok(wallDoors.some((item: any) => Math.abs(item.translation[2] - hz) < 1e-6), `${name}: a doorway faces +Z`);
    }
    // The door variations the kit exists for: two doors in one long side, and a door in the gable end.
    assert.equal(d.compositions.longhouse.items.filter((item: any) => part(item) === "door").length, 2);
    const gableHouse = d.compositions["gable-house"];
    assert.ok(gableHouse.footprint.depth > gableHouse.footprint.width, "the gable house's door is in its short end");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
