import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { Document, NodeIO } from "@gltf-transform/core";
import { resolveAssetObject, storeAssetObject } from "../src/asset-store.js";
import { getBackend } from "../src/backends.js";
import {
  IMAGE_TO_3D_OPERATION,
  IMAGE_TO_3D_PROVIDERS,
  createImageTo3DOperationBuildIdentity,
  createImageTo3DOperationExecutor,
  glbMaterialLevel,
} from "../src/image-to-3d-operation.js";

const TRIPOSR_PARAMETERS = {
  bundleId: "triposr-local-bundle",
  preprocessMode: "prepared",
  device: "cuda",
  chunkSize: 8192,
  mcResolution: 256,
  deterministicAlgorithms: true,
};
const SF3D_PARAMETERS = {
  sourceBundleId: "stable-fast-3d-source",
  modelBundleId: "stabilityai/stable-fast-3d",
  tokenizerBundleId: "facebook/dinov2-large",
  preprocessMode: "prepared-rgba",
  device: "cuda",
  textureResolution: 1024,
  remesh: "triangle",
  targetVertexCount: 12000,
  deterministicAlgorithms: true,
};

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "asset-tooling-image-to-3d-"));
}

async function triangleGlb() {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", position);
  const mesh = document.createMesh("generated").addPrimitive(primitive);
  const node = document.createNode("generated").setMesh(mesh);
  document.createScene("scene").addChild(node);
  return Buffer.from(await new NodeIO().writeBinary(document));
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function texturedGlb() {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const uv = document
    .createAccessor()
    .setType("VEC2")
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const texture = document.createTexture("albedo").setImage(PNG_1X1).setMimeType("image/png");
  const material = document.createMaterial("albedo").setBaseColorTexture(texture);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("TEXCOORD_0", uv)
    .setMaterial(material);
  const mesh = document.createMesh("generated").addPrimitive(primitive);
  document.createScene("scene").addChild(document.createNode("generated").setMesh(mesh));
  return Buffer.from(await new NodeIO().writeBinary(document));
}

async function objectCount(root) {
  try {
    const entries = await readdir(path.join(root, ".asset-tooling", "objects"), { recursive: true });
    return entries.length;
  } catch {
    return 0;
  }
}

function fakeBackend(id, { bytes, calls, environmentVersion = "1", exactCapable }) {
  const authoritative = getBackend({ id, version: "1" });
  return {
    id: authoritative.id,
    version: authoritative.version,
    kind: authoritative.kind,
    exactCapable: exactCapable ?? authoritative.exactCapable,
    validate(document) {
      authoritative.validate(document);
    },
    async environmentComponents() {
      const version = typeof environmentVersion === "function" ? environmentVersion() : environmentVersion;
      return [{ id: `test-${id}-runtime`, version }];
    },
    async generate(document) {
      calls.push(document);
      return { bytes: await bytes(), observations: { faceCount: 1 } };
    },
  };
}

async function store(root, text, kind, mediaType) {
  return (
    await storeAssetObject(root, {
      bytes: Buffer.from(text, "utf8"),
      kind,
      mediaType,
      metadata: {},
    })
  ).asset;
}

async function triposrRequest(root, overrides = {}) {
  const view = await store(root, "front-view", "image", "image/png");
  const model = await store(root, "triposr-bundle", "model", "application/zip");
  return {
    parameters: {
      provider: {
        id: "triposr",
        modelId: "stabilityai/TripoSR",
        modelRevision: "a".repeat(40),
        assets: ["model"],
        parameters: TRIPOSR_PARAMETERS,
      },
      views: [{ id: "front", viewpoint: "front" }],
      description: "weathered stone well",
      quality: "standard",
      requirements: { materials: "geometry" },
      ...overrides,
    },
    inputs: { views: [view], "provider-assets": [model] },
  };
}

async function sf3dRequest(root) {
  const view = await store(root, "front-rgba-view", "image", "image/png");
  const assets = [
    await store(root, "sf3d-source", "model", "application/zip"),
    await store(root, "sf3d-model", "model", "application/zip"),
    await store(root, "sf3d-tokenizer", "model", "application/zip"),
  ];
  return {
    parameters: {
      provider: {
        id: "stable-fast-3d",
        modelId: "stabilityai/stable-fast-3d",
        modelRevision: "b".repeat(40),
        assets: ["source", "model", "tokenizer"],
        parameters: SF3D_PARAMETERS,
      },
      views: [{ id: "hero", viewpoint: "front-left" }],
      quality: "high",
      requirements: { materials: "textured" },
    },
    inputs: { views: [view], "provider-assets": assets },
  };
}

test("one provider-neutral contract declares ordered views, masks, and provider assets", () => {
  assert.equal(IMAGE_TO_3D_OPERATION.id, "mesh.image-to-3d.generate");
  assert.equal(IMAGE_TO_3D_OPERATION.version, "1");
  assert.deepEqual(
    IMAGE_TO_3D_OPERATION.inputs.map((port) => [port.id, port.required]),
    [
      ["views", true],
      ["masks", false],
      ["provider-assets", true],
    ],
  );
  assert.deepEqual(IMAGE_TO_3D_OPERATION.outputs[0].mediaTypes, ["model/gltf-binary"]);
  assert.deepEqual(
    IMAGE_TO_3D_PROVIDERS.map((provider) => [provider.id, provider.materials, provider.operation.id]),
    [
      ["triposr", "geometry", "mesh.triposr.generate"],
      ["stable-fast-3d", "textured", "mesh.stable-fast-3d.generate"],
      ["trellis2", "pbr", "mesh.trellis2.generate"],
    ],
  );
});

for (const [name, backendId, request] of [
  ["TripoSR", "model.triposr", triposrRequest],
  ["Stable Fast 3D", "model.stable-fast-3d", sf3dRequest],
]) {
  test(`${name} runs through the provider-neutral operation with recorded provenance`, async () => {
    const root = await workspace();
    const calls = [];
    const glb = request === triposrRequest ? await triangleGlb() : await texturedGlb();
    const execute = createImageTo3DOperationExecutor({
      backends: { [request === triposrRequest ? "triposr" : "stable-fast-3d"]: fakeBackend(backendId, { bytes: async () => glb, calls }) },
    });
    const invocation = await request(root);
    const result = await execute(root, invocation);

    assert.equal(calls.length, 1);
    assert.deepEqual(await resolveAssetObject(root, result.outputs.output), glb);
    const metadata = result.outputs.output.metadata;
    assert.equal(metadata.reproducibility, "approximate");
    assert.deepEqual(metadata.provider.backend, { id: backendId, version: "1" });
    assert.equal(metadata.provider.modelId, invocation.parameters.provider.modelId);
    assert.equal(metadata.provider.modelRevision, invocation.parameters.provider.modelRevision);
    assert.deepEqual(
      metadata.provider.assets,
      invocation.parameters.provider.assets.map((role, index) => ({
        role,
        sha256: invocation.inputs["provider-assets"][index].sha256,
      })),
    );
    assert.deepEqual(metadata.views, [
      {
        index: 0,
        id: invocation.parameters.views[0].id,
        viewpoint: invocation.parameters.views[0].viewpoint,
        sha256: invocation.inputs.views[0].sha256,
        mediaType: "image/png",
      },
    ]);
    assert.equal(metadata.quality, invocation.parameters.quality);
    assert.deepEqual(metadata.requirements, invocation.parameters.requirements);
    assert.equal(result.observations.cache, "miss");
    assert.equal(result.observations.reproducibility, "approximate");
  });
}

test("the facade owns TripoSR's GLB output format", async () => {
  const root = await workspace();
  const calls = [];
  const glb = await triangleGlb();
  const execute = createImageTo3DOperationExecutor({
    backends: { triposr: fakeBackend("model.triposr", { bytes: async () => glb, calls }) },
  });
  await execute(root, await triposrRequest(root));
  assert.equal(calls[0].spec.parameters.outputFormat, "glb");

  const request = await triposrRequest(root);
  request.parameters.provider.parameters = { ...TRIPOSR_PARAMETERS, outputFormat: "obj" };
  await assert.rejects(execute(root, request), /sets provider parameter 'outputFormat'/);
});

test("identical requests keep build identity and reuse only a hash-verified cache entry", async () => {
  const root = await workspace();
  const calls = [];
  const glb = await triangleGlb();
  const backends = {
    triposr: fakeBackend("model.triposr", { bytes: async () => glb, calls }),
  };
  const execute = createImageTo3DOperationExecutor({ backends });
  const request = await triposrRequest(root);

  const first = await createImageTo3DOperationBuildIdentity(root, request, { backends });
  const second = await createImageTo3DOperationBuildIdentity(root, structuredClone(request), {
    backends,
  });
  assert.deepEqual(first, second);

  const miss = await execute(root, request);
  const hit = await execute(root, structuredClone(request));
  assert.equal(calls.length, 1);
  assert.equal(miss.observations.cache, "miss");
  assert.equal(hit.observations.cache, "hit");
  assert.equal(hit.observations.buildSha256, miss.observations.buildSha256);
  assert.deepEqual(hit.outputs.output, miss.outputs.output);

  const blobs = path.join(root, ".asset-tooling", "cache", "v1", "blobs");
  const [blob] = await readdir(blobs);
  await writeFile(path.join(blobs, blob), Buffer.from("tampered"));
  await assert.rejects(execute(root, request), /generation cache blob hash mismatch/);

  const bypass = await createImageTo3DOperationExecutor({ backends, cache: false })(root, request);
  assert.equal(bypass.observations.cache, "miss");
  assert.equal(calls.length, 2);
  assert.deepEqual(bypass.outputs.output, miss.outputs.output);
});

test("provider output must pass GLB validation before it becomes an asset", async () => {
  const root = await workspace();
  const execute = createImageTo3DOperationExecutor({
    backends: {
      triposr: fakeBackend("model.triposr", {
        bytes: async () => Buffer.from("not-a-glb"),
        calls: [],
      }),
    },
  });
  const request = await triposrRequest(root);
  const before = await objectCount(root);
  await assert.rejects(execute(root, request), /not a GLB|failed Khronos validation/);
  assert.equal(await objectCount(root), before);
  await assert.rejects(readdir(path.join(root, ".asset-tooling", "cache")), /ENOENT/);
});

test("output must deliver the requested material level", async () => {
  const root = await workspace();
  const execute = createImageTo3DOperationExecutor({
    backends: {
      "stable-fast-3d": fakeBackend("model.stable-fast-3d", { bytes: triangleGlb, calls: [] }),
    },
  });
  const request = await sf3dRequest(root);
  const before = await objectCount(root);
  await assert.rejects(execute(root, request), /delivers geometry output, not the required textured/);
  assert.equal(await objectCount(root), before);
  assert.equal(glbMaterialLevel(await texturedGlb()), "textured");
  // An unused textured material does not make untextured geometry textured.
  const unused = new Document();
  const buffer = unused.createBuffer();
  const position = unused
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const texture = unused.createTexture("albedo").setImage(PNG_1X1).setMimeType("image/png");
  unused.createMaterial("unused").setBaseColorTexture(texture);
  const mesh = unused.createMesh().addPrimitive(unused.createPrimitive().setAttribute("POSITION", position));
  unused.createScene().addChild(unused.createNode().setMesh(mesh));
  assert.equal(glbMaterialLevel(Buffer.from(await new NodeIO().writeBinary(unused))), "geometry");

  // A textured mesh no scene node renders is not delivered output.
  const orphan = new Document();
  const orphanBuffer = orphan.createBuffer();
  const orphanPosition = orphan
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(orphanBuffer);
  orphan.createMesh().addPrimitive(orphan.createPrimitive().setAttribute("POSITION", orphanPosition));
  orphan.createScene().addChild(orphan.createNode("empty"));
  assert.equal(glbMaterialLevel(Buffer.from(await new NodeIO().writeBinary(orphan))), "none");

  const jpeg = await sf3dRequest(root);
  jpeg.inputs.views = [await store(root, "jpeg-view", "image", "image/jpeg")];
  await assert.rejects(
    createImageTo3DOperationBuildIdentity(root, jpeg, {
      backends: {
        "stable-fast-3d": fakeBackend("model.stable-fast-3d", { bytes: texturedGlb, calls: [] }),
      },
    }),
    /cannot read view 0 as image\/jpeg/,
  );
});

test("a runtime change after preparation fails instead of generating", async () => {
  const root = await workspace();
  const calls = [];
  let probes = 0;
  const execute = createImageTo3DOperationExecutor({
    backends: {
      triposr: fakeBackend("model.triposr", {
        bytes: triangleGlb,
        calls,
        environmentVersion: () => String(++probes),
      }),
    },
  });
  await assert.rejects(execute(root, await triposrRequest(root)), /runtime changed/);
  assert.equal(calls.length, 0);
});

test("exact-capable backends are not labeled exact without replay evidence", async () => {
  const root = await workspace();
  const execute = createImageTo3DOperationExecutor({
    backends: {
      triposr: fakeBackend("model.triposr", { bytes: triangleGlb, calls: [], exactCapable: true }),
    },
  });
  const result = await execute(root, await triposrRequest(root));
  assert.equal(result.outputs.output.metadata.reproducibility, "unverified-exact-capable");
});

test("mutable model revisions are rejected", async () => {
  const root = await workspace();
  const request = await triposrRequest(root);
  request.parameters.provider.modelRevision = "main";
  await assert.rejects(
    createImageTo3DOperationBuildIdentity(root, request, {
      backends: { triposr: fakeBackend("model.triposr", { bytes: triangleGlb, calls: [] }) },
    }),
    /immutable/,
  );
});

test("requests a provider cannot honor fail closed", async () => {
  const root = await workspace();
  const backends = {
    triposr: fakeBackend("model.triposr", { bytes: triangleGlb, calls: [] }),
  };
  const identity = (request) => createImageTo3DOperationBuildIdentity(root, request, { backends });

  const multiView = await triposrRequest(root);
  multiView.inputs.views.push(await store(root, "back-view", "image", "image/png"));
  multiView.parameters.views.push({ id: "back", viewpoint: "back" });
  await assert.rejects(identity(multiView), /accepts at most 1 view/);

  const unnamed = await triposrRequest(root);
  unnamed.inputs.views.push(await store(root, "back-view", "image", "image/png"));
  await assert.rejects(identity(unnamed), /must describe each of the 2 view inputs in order/);

  const duplicate = await triposrRequest(root, {
    views: [
      { id: "front", viewpoint: "front" },
      { id: "front", viewpoint: "back" },
    ],
  });
  await assert.rejects(identity(duplicate), /is not unique/);

  const masked = await triposrRequest(root);
  masked.inputs.masks = [await store(root, "mask", "image", "image/png")];
  await assert.rejects(identity(masked), /does not accept separate masks/);

  await assert.rejects(
    identity(await triposrRequest(root, { requirements: { materials: "pbr" } })),
    /delivers geometry output, not the required pbr/,
  );
  await assert.rejects(identity(await triposrRequest(root, { seed: "7" })), /no user-controlled seed/);

  const reordered = await sf3dRequest(root);
  reordered.parameters.provider.assets = ["model", "source", "tokenizer"];
  await assert.rejects(
    createImageTo3DOperationBuildIdentity(root, reordered, {
      backends: {
        "stable-fast-3d": fakeBackend("model.stable-fast-3d", { bytes: triangleGlb, calls: [] }),
      },
    }),
    /requires provider.assets to be \[source, model, tokenizer\]/,
  );

  const trellis = await triposrRequest(root);
  trellis.parameters.provider.id = "trellis2";
  await assert.rejects(identity(trellis), /requires parameters.seed/);
});
