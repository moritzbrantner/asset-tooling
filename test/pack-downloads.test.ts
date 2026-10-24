import { test } from "node:test";
import assert from "node:assert/strict";
import { ktxArguments, textureEncoding } from "../scripts/pack-downloads.ts";

test("textures are encoded by slot: UASTC for normals, sRGB ETC1S for colour, linear ETC1S for data maps", () => {
  assert.equal(textureEncoding(new Set(["normalTexture"])), "uastc");
  assert.equal(textureEncoding(new Set(["baseColorTexture"])), "etc1s-srgb");
  assert.equal(textureEncoding(new Set(["emissiveTexture"])), "etc1s-srgb");
  assert.equal(textureEncoding(new Set(["metallicRoughnessTexture", "occlusionTexture"])), "etc1s-linear");
  assert.equal(textureEncoding(new Set(["normalTexture", "occlusionTexture"])), "uastc");
  const uastc = ktxArguments("uastc", "in.png", "out.ktx2");
  assert.ok(uastc.includes("uastc") && uastc.includes("--zstd") && uastc.includes("R8G8B8A8_UNORM"));
  const color = ktxArguments("etc1s-srgb", "in.png", "out.ktx2");
  assert.ok(color.includes("basis-lz") && color.includes("R8G8B8A8_SRGB") && color.includes("--generate-mipmap"));
  assert.deepEqual(color.slice(-2), ["in.png", "out.ktx2"]);
});

test("non-power-of-two textures are resampled to the nearest power of two, and KTX2 sizes come from the header", async () => {
  const { powerOfTwo, ktx2Size } = await import("../scripts/pack-downloads.ts");
  assert.deepEqual([1008, 981, 1024, 700, 1, 3000].map(powerOfTwo), [1024, 1024, 1024, 512, 1, 4096]);
  const header = new Uint8Array(80);
  header.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(header.buffer).setUint32(20, 512, true);
  new DataView(header.buffer).setUint32(24, 256, true);
  assert.deepEqual(ktx2Size(header), { width: 512, height: 256 });
  assert.throws(() => ktx2Size(new Uint8Array(80)), /not a KTX2/);
  const sized = ktxArguments("etc1s-srgb", "in.png", "out.ktx2", { width: 1024, height: 1024 });
  assert.deepEqual(sized.slice(sized.indexOf("--width"), sized.indexOf("--width") + 4), ["--width", "1024", "--height", "1024"]);
});

test("the shared clips keep only animation accessors: meshes, primitives and morph targets are dropped", async () => {
  const { Document, NodeIO } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const { meshopt } = await import("@gltf-transform/functions");
  const { MeshoptDecoder, MeshoptEncoder } = await import("meshoptimizer");
  const { validateBytes } = await import("gltf-validator");
  const { stripToClips } = await import("../scripts/pack-downloads.ts");
  await MeshoptEncoder.ready;
  const document = new Document();
  const buffer = document.createBuffer();
  const vec3 = (values: number[]) => document.createAccessor().setType("VEC3").setArray(new Float32Array(values)).setBuffer(buffer);
  const target = document.createPrimitiveTarget("face.wide").setAttribute("POSITION", vec3([0.1, 0, 0, 0, 0, 0, 0, 0, 0]));
  const primitive = document.createPrimitive().setAttribute("POSITION", vec3([0, 0, 0, 1, 0, 0, 0, 1, 0])).addTarget(target);
  const mesh = document.createMesh("Head").addPrimitive(primitive).setWeights([0]);
  const joint = document.createNode("pelvis");
  document.createScene().addChild(document.createNode("Head").setMesh(mesh)).addChild(joint);
  const sampler = document.createAnimationSampler()
    .setInput(document.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer))
    .setOutput(vec3([0, 0, 0, 0, 1, 0]));
  document.createAnimation("Walk_Loop").addSampler(sampler)
    .addChannel(document.createAnimationChannel().setTargetNode(joint).setTargetPath("translation").setSampler(sampler));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
  const clips = stripToClips(document);
  await clips.transform(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  const glb = await io.writeBinary(clips);
  const { json } = await io.binaryToJSON(glb);
  assert.equal(json.meshes, undefined);
  const animated = new Set(json.animations!.flatMap((animation) => animation.samplers.flatMap((s) => [s.input, s.output])));
  assert.deepEqual(json.accessors!.map((_, index) => index).filter((index) => !animated.has(index)), []);
  for (const accessor of json.accessors!) assert.ok(accessor.bufferView !== undefined, "every accessor has data");
  const report = await validateBytes(glb, { maxIssues: 0 });
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
});
