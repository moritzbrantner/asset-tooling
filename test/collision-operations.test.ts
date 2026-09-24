import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { resolveAssetObject } from "../src/asset-store.js";
import {
  COLLISION_OPERATIONS,
  COLLISION_PROXY_SET_MEDIA_TYPE,
  createCollisionProxySetBuildIdentity,
  executeCollisionProxySetBuildOperation,
  normalizeCollisionProxySetBuildParameters,
} from "../src/collision-operations.js";

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-collision-"));
}

const compoundWindow = {
  unit: "meter",
  proxies: [
    { id: "right-jamb", target: "window-frame", shape: "box", center: ["1.35", "1.25", "0"], size: ["0.3", "2.5", "0.25"] },
    { id: "left-jamb", target: "window-frame", shape: "box", center: ["-1.35", "1.25", "0"], size: ["0.3", "2.5", "0.25"] },
    { id: "lintel", target: "window-frame", shape: "box", center: ["0", "2.35", "0"], size: ["2.4", "0.3", "0.25"] },
    { id: "sill", target: "window-frame", shape: "box", center: ["0", "0.15", "0"], size: ["2.4", "0.3", "0.25"] },
  ],
};

test("collision operation registry exposes a typed content-addressed proxy bundle", () => {
  assert.deepEqual(COLLISION_OPERATIONS.map((operation) => operation.id), ["collision.proxy-set.build"]);
  assert.equal(COLLISION_OPERATIONS[0]?.outputs[0]?.assetKinds[0], "collision");
  assert.equal(COLLISION_OPERATIONS[0]?.outputs[0]?.mediaTypes[0], COLLISION_PROXY_SET_MEDIA_TYPE);
});

test("proxy normalization canonicalizes exact decimals and proxy order", () => {
  const normalized = normalizeCollisionProxySetBuildParameters({
    unit: "meter",
    proxies: [
      { id: "crate", target: "crate", shape: "box", center: ["-0.000", "0.500000", "0"], size: ["1.000", "1", "1.0"] },
      { id: "barrel", target: "barrel", shape: "capsule", center: ["0", "0.45", "0"], radius: "0.3000", segmentLength: "0.300000" },
    ],
  });

  assert.deepEqual(normalized, {
    unit: "meter",
    proxies: [
      { id: "barrel", target: "barrel", shape: "capsule", center: ["0", "0.45", "0"], radius: "0.3", segmentLength: "0.3", axis: "y" },
      { id: "crate", target: "crate", shape: "box", center: ["0", "0.5", "0"], size: ["1", "1", "1"] },
    ],
  });
});

test("compound window collision preserves the opening and is byte-stable across input order", async () => {
  const root = await workspace();
  try {
    const first = await executeCollisionProxySetBuildOperation(root, { parameters: compoundWindow });
    const second = await executeCollisionProxySetBuildOperation(root, {
      parameters: { ...compoundWindow, proxies: [...compoundWindow.proxies].reverse() },
    });

    assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
    assert.equal(first.outputs.output.mediaType, COLLISION_PROXY_SET_MEDIA_TYPE);
    assert.equal(first.outputs.output.metadata.proxyCount, 4);
    assert.equal(first.outputs.output.metadata.targetCount, 1);
    assert.deepEqual(first.outputs.output.metadata.shapeCounts, { box: 4, sphere: 0, capsule: 0 });

    const document = JSON.parse((await resolveAssetObject(root, first.outputs.output)).toString("utf8"));
    assert.equal(document.coordinateSystem, "right-handed-y-up");
    assert.equal(document.unitScaleToMeters, "1");
    assert.equal(document.proxies.length, 4);
    assert.equal(document.proxies.some((proxy: { center: string[] }) => proxy.center[0] === "0" && proxy.center[1] === "1.25"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("door frame and leaf can remain separate collision targets", async () => {
  const root = await workspace();
  try {
    const result = await executeCollisionProxySetBuildOperation(root, {
      parameters: {
        unit: "meter",
        proxies: [
          { id: "door-frame-left", target: "door-frame", shape: "box", center: ["-0.55", "1.1", "0"], size: ["0.1", "2.2", "0.2"] },
          { id: "door-frame-right", target: "door-frame", shape: "box", center: ["0.55", "1.1", "0"], size: ["0.1", "2.2", "0.2"] },
          { id: "door-frame-lintel", target: "door-frame", shape: "box", center: ["0", "2.15", "0"], size: ["1", "0.1", "0.2"] },
          { id: "door-leaf", target: "door-leaf", shape: "box", center: ["0", "1.05", "0"], size: ["1", "2.1", "0.08"] },
        ],
      },
    });
    assert.equal(result.outputs.output.metadata.targetCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proxy validation fails closed on invalid geometry before build identity is accepted", async () => {
  const root = await workspace();
  try {
    await assert.rejects(
      () => createCollisionProxySetBuildIdentity(root, { parameters: { unit: "meter", proxies: [] } }),
      /must contain 1\.\.128 entries/,
    );
    await assert.rejects(
      () => createCollisionProxySetBuildIdentity(root, {
        parameters: { unit: "meter", proxies: [{ id: "bad", target: "crate", shape: "box", center: ["0", "0", "0"], size: ["1", "0", "1"] }] },
      }),
      /size\[1\] must be greater than zero/,
    );
    await assert.rejects(
      () => createCollisionProxySetBuildIdentity(root, {
        parameters: { unit: "meter", proxies: [{ id: "bad", target: "barrel", shape: "cylinder", center: ["0", "0", "0"], radius: "0.3", height: "1" }] },
      }),
      /shape must be one of box, sphere, capsule/,
    );
    await assert.rejects(
      () => createCollisionProxySetBuildIdentity(root, {
        parameters: { unit: "meter", proxies: [
          { id: "same", target: "crate", shape: "box", center: ["0", "0.5", "0"], size: ["1", "1", "1"] },
          { id: "same", target: "crate", shape: "sphere", center: ["0", "0.5", "0"], radius: "0.5" },
        ] },
      }),
      /must not contain duplicate ids/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
