import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import {
  createInstanceSet,
  encodeInstanceSet,
  INSTANCE_SET_ASSET_KIND,
  INSTANCE_SET_COORDINATE_QUANTIZATION,
  INSTANCE_SET_COORDINATE_SYSTEM,
  INSTANCE_SET_MEDIA_TYPE,
  INSTANCE_SET_SCHEMA_VERSION,
  parseInstanceSet,
} from "../src/instance-set.js";
import { encodeRgba8Image, RGBA8_IMAGE_MEDIA_TYPE } from "../src/image-rgba8.js";
import {
  INSTANCE_OPERATIONS,
  createHeightfieldProjectionOperationBuildIdentity,
  createMinimumDistanceScatterOperationBuildIdentity,
  createUniformScatterOperationBuildIdentity,
  executeHeightfieldProjectionOperation,
  executeMinimumDistanceScatterOperation,
  executeUniformScatterOperation,
  generateMinimumDistanceInstanceSet,
  generateUniformInstanceSet,
  projectInstanceSetToHeightfield,
} from "../src/scatter-operations.js";

function pixel(value) {
  return [value, value, value, 255];
}

function pixels(...values) {
  return Buffer.from(values.flat());
}

async function storeInstanceSet(root, value) {
  return (
    await storeAssetObject(root, {
      bytes: encodeInstanceSet(value),
      kind: INSTANCE_SET_ASSET_KIND,
      mediaType: INSTANCE_SET_MEDIA_TYPE,
      metadata: { schemaVersion: INSTANCE_SET_SCHEMA_VERSION },
    })
  ).asset;
}

async function storeHeight(root, width, height, pixelBytes) {
  return (
    await storeAssetObject(root, {
      bytes: encodeRgba8Image({ width, height, pixels: pixelBytes }),
      kind: "image",
      mediaType: RGBA8_IMAGE_MEDIA_TYPE,
      metadata: {
        width,
        height,
        pixelFormat: "rgba8",
        colorSpace: "srgb",
        alphaMode: "straight",
        field: "height",
      },
    })
  ).asset;
}

function baseInstanceSet(instances) {
  return {
    schemaVersion: INSTANCE_SET_SCHEMA_VERSION,
    coordinateSystem: INSTANCE_SET_COORDINATE_SYSTEM,
    coordinateQuantization: INSTANCE_SET_COORDINATE_QUANTIZATION,
    bounds: { widthMicro: 2_000_000, depthMicro: 2_000_000 },
    instances,
  };
}

test("instance set contract canonicalizes exact fixed-micro placement bytes", () => {
  const value = baseInstanceSet([
    { id: "a", positionMicro: [-1_000_000, 0, -1_000_000] },
    { id: "b", positionMicro: [999_999, 10, 999_999] },
  ]);
  const bytes = encodeInstanceSet(value);
  assert.equal(
    bytes.toString("utf8"),
    '{"bounds":{"depthMicro":2000000,"widthMicro":2000000},"coordinateQuantization":"1e-6-unit","coordinateSystem":"right-handed-y-up","instances":[{"id":"a","positionMicro":[-1000000,0,-1000000]},{"id":"b","positionMicro":[999999,10,999999]}],"schemaVersion":1}\n',
  );
  assert.deepEqual(parseInstanceSet(bytes), createInstanceSet(value));
});

test("instance set contract rejects duplicate ids and positions outside centered bounds", () => {
  assert.throws(
    () =>
      createInstanceSet(
        baseInstanceSet([
          { id: "a", positionMicro: [0, 0, 0] },
          { id: "a", positionMicro: [1, 0, 1] },
        ]),
      ),
    /duplicate id/,
  );
  assert.throws(
    () => createInstanceSet(baseInstanceSet([{ id: "a", positionMicro: [1_000_000, 0, 0] }])),
    /positionMicro\[0\]/,
  );
});

test("instance operation registry exposes scatter and heightfield projection separately", () => {
  assert.deepEqual(
    INSTANCE_OPERATIONS.map((operation) => operation.id),
    [
      "instances.project.heightfield",
      "instances.scatter.minimum-distance",
      "instances.scatter.uniform",
    ],
  );
  assert.deepEqual(INSTANCE_OPERATIONS[0].inputs.map((input) => input.id), ["source", "height"]);
  assert.equal(INSTANCE_OPERATIONS[1].parameterSchema.properties.count.maximum, 4096);
  assert.deepEqual(INSTANCE_OPERATIONS[2].inputs, []);
});

test("uniform scatter pins the SHA-256-seeded SplitMix64 candidate stream", () => {
  const generated = generateUniformInstanceSet({ seed: "42", count: 4, width: 2, depth: 2 });
  assert.equal(generated.candidateCount, 4);
  assert.equal(generated.rejectedCount, 0);
  assert.deepEqual(
    generated.instanceSet.instances.map((instance) => instance.positionMicro),
    [
      [-363_406, 0, 59_701],
      [403_054, 0, -430_277],
      [-720_626, 0, -769_949],
      [145_671, 0, -265_417],
    ],
  );
});

test("minimum-distance scatter has exact accepted points and enforces the requested separation", () => {
  const generated = generateMinimumDistanceInstanceSet({
    seed: "42",
    count: 6,
    width: 10,
    depth: 10,
    minDistance: 2,
  });
  assert.equal(generated.candidateCount, 7);
  assert.equal(generated.rejectedCount, 1);
  assert.equal(generated.minDistanceMicro, 2_000_000);
  assert.deepEqual(
    generated.instanceSet.instances.map((instance) => instance.positionMicro),
    [
      [-363_406, 0, 4_059_701],
      [4_403_054, 0, -430_277],
      [-4_720_626, 0, 3_230_051],
      [-1_854_329, 0, 1_734_583],
      [1_831_839, 0, -4_399_339],
      [-1_327_436, 0, -4_522_268],
    ],
  );
  const positions = generated.instanceSet.instances.map((instance) => instance.positionMicro);
  const minimumSquared = 2_000_000n * 2_000_000n;
  for (let left = 0; left < positions.length; left += 1) {
    for (let right = left + 1; right < positions.length; right += 1) {
      const dx = BigInt(positions[left][0] - positions[right][0]);
      const dz = BigInt(positions[left][2] - positions[right][2]);
      assert.ok(dx * dx + dz * dz >= minimumSquared);
    }
  }
});

test("minimum-distance scatter fails closed when the requested packing cannot be satisfied", () => {
  assert.throws(
    () =>
      generateMinimumDistanceInstanceSet({
        seed: "7",
        count: 2,
        width: 1,
        depth: 1,
        minDistance: 2,
      }),
    /unable to place 2 instances/,
  );
});

test("heightfield projection preserves ids and XZ while sampling exact luma heights", () => {
  const source = baseInstanceSet([
    { id: "nw", positionMicro: [-1_000_000, 0, -1_000_000] },
    { id: "ne", positionMicro: [999_999, 0, -1_000_000] },
    { id: "sw", positionMicro: [-1_000_000, 0, 999_999] },
    { id: "se", positionMicro: [999_999, 0, 999_999] },
  ]);
  const heightBytes = encodeRgba8Image({
    width: 2,
    height: 2,
    pixels: pixels(pixel(0), pixel(64), pixel(128), pixel(255)),
  });
  const projected = projectInstanceSetToHeightfield(source, heightBytes, { heightScale: 10 });
  assert.deepEqual(
    projected.instances,
    [
      { id: "nw", positionMicro: [-1_000_000, 0, -1_000_000] },
      { id: "ne", positionMicro: [999_999, 2_509_804, -1_000_000] },
      { id: "sw", positionMicro: [-1_000_000, 5_019_608, 999_999] },
      { id: "se", positionMicro: [999_999, 10_000_000, 999_999] },
    ],
  );
});

test("scatter build identities bind seed and deterministic candidate algorithms", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-scatter-"));
  const uniform = await createUniformScatterOperationBuildIdentity(root, {
    parameters: { seed: "42", count: 4, width: 2, depth: 2 },
    inputs: {},
  });
  const separated = await createMinimumDistanceScatterOperationBuildIdentity(root, {
    parameters: { seed: "42", count: 4, width: 10, depth: 10, minDistance: 2 },
    inputs: {},
  });
  assert.equal(uniform.implementation.randomness, "seeded");
  assert.equal(uniform.implementation.algorithm, "sha256-seeded-splitmix64-unique-uniform-micro-xz-v1");
  assert.equal(separated.implementation.algorithm, "sha256-seeded-splitmix64-min-distance-micro-xz-v1");
  assert.equal(separated.implementation.candidateBudgetPerInstance, 256);
});

test("scatter operations are content-addressed and idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-scatter-execute-"));
  const uniformInvocation = {
    parameters: { seed: "42", count: 8, width: 20, depth: 12 },
    inputs: {},
  };
  const first = await executeUniformScatterOperation(root, uniformInvocation);
  const second = await executeUniformScatterOperation(root, uniformInvocation);
  assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
  assert.deepEqual(first.observations, second.observations);
  assert.equal(first.outputs.output.kind, INSTANCE_SET_ASSET_KIND);
  assert.equal(first.outputs.output.mediaType, INSTANCE_SET_MEDIA_TYPE);
  assert.equal(first.outputs.output.metadata.count, 8);
  assert.equal(first.outputs.output.metadata.distribution, "uniform");
  assert.equal(first.outputs.output.metadata.seed, "42");

  const separated = await executeMinimumDistanceScatterOperation(root, {
    parameters: { seed: "42", count: 6, width: 10, depth: 10, minDistance: 2 },
    inputs: {},
  });
  assert.equal(separated.outputs.output.metadata.distribution, "minimum-distance");
  assert.equal(separated.outputs.output.metadata.minDistanceMicro, 2_000_000);
  assert.equal(parseInstanceSet(await resolveAssetObject(root, separated.outputs.output)).instances.length, 6);
});

test("heightfield projection validates both source assets and records exact lineage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-height-scatter-"));
  const source = await storeInstanceSet(
    root,
    baseInstanceSet([
      { id: "nw", positionMicro: [-1_000_000, 0, -1_000_000] },
      { id: "se", positionMicro: [999_999, 0, 999_999] },
    ]),
  );
  const height = await storeHeight(
    root,
    2,
    2,
    pixels(pixel(0), pixel(64), pixel(128), pixel(255)),
  );
  const build = await createHeightfieldProjectionOperationBuildIdentity(root, {
    parameters: { heightScale: 10 },
    inputs: { source, height },
  });
  assert.equal(build.implementation.algorithm, "nearest-q8-heightfield-instance-projection-v1");
  assert.equal(build.implementation.randomness, "none");
  assert.equal(build.inputs.source.sha256, source.sha256);
  assert.equal(build.inputs.height.sha256, height.sha256);

  const first = await executeHeightfieldProjectionOperation(root, {
    parameters: { heightScale: 10 },
    inputs: { source, height },
  });
  const second = await executeHeightfieldProjectionOperation(root, {
    parameters: { heightScale: 10 },
    inputs: { source, height },
  });
  assert.equal(first.outputs.output.sha256, second.outputs.output.sha256);
  assert.equal(first.outputs.output.metadata.sourceInstanceSetSha256, source.sha256);
  assert.equal(first.outputs.output.metadata.sourceHeightSha256, height.sha256);
  assert.equal(first.outputs.output.metadata.heightSampling, "nearest");
  assert.equal(first.outputs.output.metadata.heightScale, 10);
  assert.deepEqual(
    parseInstanceSet(await resolveAssetObject(root, first.outputs.output)).instances,
    [
      { id: "nw", positionMicro: [-1_000_000, 0, -1_000_000] },
      { id: "se", positionMicro: [999_999, 10_000_000, 999_999] },
    ],
  );
});
