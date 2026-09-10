import test from "node:test";
import assert from "node:assert/strict";
import {
  createAssetOperationBuildIdentity,
  createAssetOperationCacheKey,
  createAssetOperationDescriptor,
  createAssetOperationRegistry,
  createAssetRef,
  normalizeAssetOperationInputs,
  normalizeAssetOperationResult,
} from "../src/operations.js";

const SOURCE = {
  schemaVersion: 1,
  kind: "image",
  mediaType: "image/png",
  sha256: "a".repeat(64),
  byteLength: 128,
  metadata: {
    width: 16,
    height: 16,
  },
};

const OUTPUT = {
  schemaVersion: 1,
  kind: "image",
  mediaType: "image/png",
  sha256: "b".repeat(64),
  byteLength: 96,
  metadata: {
    height: 16,
    width: 16,
  },
};

const BLUR = {
  schemaVersion: 1,
  id: "image.blur.gaussian",
  version: "1",
  label: "Gaussian blur",
  category: "image.filter",
  inputs: [
    {
      id: "source",
      assetKinds: ["image"],
      mediaTypes: ["image/png"],
    },
  ],
  outputs: [
    {
      id: "output",
      assetKinds: ["image"],
      mediaTypes: ["image/png"],
    },
  ],
  parameterSchema: {
    type: "object",
    required: ["radius"],
    properties: {
      radius: { type: "integer", minimum: 1 },
    },
  },
};

test("asset refs normalize deterministic metadata and reject invalid content identity", () => {
  assert.deepEqual(createAssetRef(SOURCE), {
    schemaVersion: 1,
    kind: "image",
    mediaType: "image/png",
    sha256: "a".repeat(64),
    byteLength: 128,
    metadata: {
      height: 16,
      width: 16,
    },
  });

  assert.throws(
    () => createAssetRef({ ...SOURCE, sha256: "A".repeat(64) }),
    /lowercase 64-character SHA-256/,
  );
  assert.throws(
    () => createAssetRef({ ...SOURCE, metadata: { score: Number.NaN } }),
    /non-finite number/,
  );
});

test("operation descriptors reject ambiguous port contracts", () => {
  const descriptor = createAssetOperationDescriptor(BLUR);
  assert.equal(descriptor.id, "image.blur.gaussian");
  assert.equal(descriptor.inputs[0].cardinality, "single");
  assert.equal(descriptor.inputs[0].required, true);

  assert.throws(
    () =>
      createAssetOperationDescriptor({
        ...BLUR,
        inputs: [{ id: "source" }, { id: "source" }],
      }),
    /duplicate port ids/,
  );
});

test("operation registry rejects duplicates and lists deterministically", () => {
  const registry = createAssetOperationRegistry([
    { ...BLUR, id: "image.resize", version: "2" },
    BLUR,
  ]);

  assert.deepEqual(
    registry.list().map(({ id, version }) => `${id}@${version}`),
    ["image.blur.gaussian@1", "image.resize@2"],
  );
  assert.equal(registry.get("image.blur.gaussian", "1")?.label, "Gaussian blur");
  assert.equal(registry.has("image.blur.gaussian", "1"), true);
  assert.throws(() => registry.register(BLUR), /already registered/);
});

test("operation inputs and results enforce typed asset ports", () => {
  assert.deepEqual(normalizeAssetOperationInputs(BLUR, { source: SOURCE }).source, createAssetRef(SOURCE));

  assert.throws(
    () => normalizeAssetOperationInputs(BLUR, {}),
    /missing required port 'source'/,
  );
  assert.throws(
    () => normalizeAssetOperationInputs(BLUR, { source: { ...SOURCE, kind: "mesh" } }),
    /asset kind 'mesh' is not accepted/,
  );
  assert.throws(
    () => normalizeAssetOperationInputs(BLUR, { source: SOURCE, extra: SOURCE }),
    /unknown port 'extra'/,
  );

  const result = normalizeAssetOperationResult(BLUR, {
    outputs: { output: OUTPUT },
    observations: { appliedRadius: 2 },
  });
  assert.deepEqual(result.outputs.output, createAssetRef(OUTPUT));
  assert.deepEqual(result.observations, { appliedRadius: 2 });
});

test("operation build identity and cache key are canonical and implementation-sensitive", () => {
  const first = {
    operation: BLUR,
    implementation: {
      id: "sharp",
      version: "0.34.4",
      revision: "libvips-8.17.2",
    },
    parameters: {
      radius: 2,
      mode: "clamp",
    },
    inputs: { source: SOURCE },
  };
  const reordered = {
    operation: BLUR,
    implementation: {
      revision: "libvips-8.17.2",
      version: "0.34.4",
      id: "sharp",
    },
    parameters: {
      mode: "clamp",
      radius: 2,
    },
    inputs: {
      source: {
        ...SOURCE,
        metadata: {
          height: 16,
          width: 16,
        },
      },
    },
  };

  assert.deepEqual(createAssetOperationBuildIdentity(first), createAssetOperationBuildIdentity(reordered));
  assert.equal(createAssetOperationCacheKey(first), createAssetOperationCacheKey(reordered));
  assert.notEqual(
    createAssetOperationCacheKey(first),
    createAssetOperationCacheKey({
      ...first,
      implementation: {
        ...first.implementation,
        revision: "libvips-8.17.3",
      },
    }),
  );
  assert.notEqual(
    createAssetOperationCacheKey(first),
    createAssetOperationCacheKey({
      ...first,
      inputs: {
        source: {
          ...SOURCE,
          sha256: "c".repeat(64),
        },
      },
    }),
  );
});
