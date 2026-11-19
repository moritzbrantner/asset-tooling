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

test("compacting the clips drops only the channels no clip moves off the rest pose, keeps names and durations, and validates (#683)", async () => {
  const { Document, NodeIO } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const { meshopt } = await import("@gltf-transform/functions");
  const { MeshoptDecoder, MeshoptEncoder } = await import("meshoptimizer");
  const { validateBytes } = await import("gltf-validator");
  const { compactClips } = await import("../scripts/pack-downloads.ts");
  await MeshoptEncoder.ready;
  const document = new Document();
  const buffer = document.createBuffer();
  const accessor = (type: "SCALAR" | "VEC3" | "VEC4", values: number[]) => document.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
  const pelvis = document.createNode("pelvis").setTranslation([0, 1, 0]);
  const finger = document.createNode("finger").setTranslation([0, 0.1, 0]).setRotation([0, 0, 0, 1]);
  document.createScene().addChild(pelvis.addChild(finger));
  const clip = (name: string, duration: number, channels: [typeof pelvis, "translation" | "rotation", number[]][]) => {
    const animation = document.createAnimation(name);
    const input = accessor("SCALAR", [0, duration]);
    for (const [node, path, values] of channels) {
      const sampler = document.createAnimationSampler().setInput(input).setOutput(accessor(path === "rotation" ? "VEC4" : "VEC3", values));
      animation.addSampler(sampler).addChannel(document.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
    }
  };
  // The pelvis moves in Walk; the finger's translation never leaves its rest, and its rotation rests in Idle only.
  clip("Walk", 1, [[pelvis, "translation", [0, 1, 0, 0, 1.1, 0]], [finger, "translation", [0, 0.1, 0, 0, 0.1, 0]], [finger, "rotation", [0, 0, 0, 1, 0, 0, 0, -1]]]);
  clip("Idle", 2, [[pelvis, "translation", [0, 1, 0, 0, 1, 0]], [finger, "translation", [0, 0.1, 0, 0, 0.1, 0]], [finger, "rotation", [0, 0, 0, 1, 0, 0.5, 0, 0.866]]]);
  clip("Rest", 0.5, [[finger, "translation", [0, 0.1, 0, 0, 0.1, 0]]]);
  assert.equal(await compactClips(document), 2);
  const channels = Object.fromEntries(document.getRoot().listAnimations().map((animation) => [animation.getName(),
    animation.listChannels().map((channel) => `${channel.getTargetNode()!.getName()}.${channel.getTargetPath()}`)]));
  assert.deepEqual(channels, { Walk: ["pelvis.translation", "finger.rotation"], Idle: ["pelvis.translation", "finger.rotation"], Rest: ["finger.translation"] });
  const durations = document.getRoot().listAnimations().map((animation) => Math.max(...animation.listSamplers().map((sampler) => sampler.getInput()!.getMax([])[0]!)));
  assert.deepEqual(durations, [1, 2, 0.5]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
  await document.transform(meshopt({ encoder: MeshoptEncoder, level: "high" }));
  const report = await validateBytes(await io.writeBinary(document), { maxIssues: 0 });
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
});

test("clip families split the clips once each, and a family file keeps only its clips on the whole skeleton (#733)", async () => {
  const { Document } = await import("@gltf-transform/core");
  const { clipDuration, clipFamilyProblems, keepClips } = await import("../scripts/pack-downloads.ts");
  assert.deepEqual(clipFamilyProblems(["Idle", "Walk", "Wave"], [{ family: "base", clips: ["Idle", "Walk"] }, { family: "emotes", clips: ["Wave"] }]), []);
  assert.deepEqual(clipFamilyProblems(["Idle", "Walk", "Wave"], [{ family: "base", clips: ["Idle", "Jump"] }, { family: "Emotes", clips: ["Idle"] }]), [
    "'Jump' (base) is not a clip of the entry", "family 'Emotes' is not a file-name word", "'Idle' is in 'base' and 'Emotes'",
    "'Walk' is in no family", "'Wave' is in no family",
  ]);
  const document = new Document();
  const buffer = document.createBuffer();
  const pelvis = document.createNode("pelvis"), hand = document.createNode("hand");
  document.createScene().addChild(pelvis.addChild(hand));
  for (const [name, duration] of [["Idle", 2], ["Walk", 1], ["Wave", 1.5]] as const) {
    const sampler = document.createAnimationSampler()
      .setInput(document.createAccessor().setType("SCALAR").setArray(new Float32Array([0, duration])).setBuffer(buffer))
      .setOutput(document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 0, 1, 0])).setBuffer(buffer));
    document.createAnimation(name).addSampler(sampler)
      .addChannel(document.createAnimationChannel().setTargetNode(pelvis).setTargetPath("translation").setSampler(sampler));
  }
  keepClips(document, new Set(["Wave", "Idle"]));
  assert.deepEqual(document.getRoot().listAnimations().map((animation) => [animation.getName(), clipDuration(animation)]), [["Idle", 2], ["Wave", 1.5]]);
  assert.deepEqual(document.getRoot().listNodes().map((node) => node.getName()), ["pelvis", "hand"]);
});

test("clip family entries join onto the skeleton by joint name, keys and interpolation intact (#775)", async () => {
  const { Document } = await import("@gltf-transform/core");
  const { addClips } = await import("../scripts/pack-downloads.ts");
  const skeleton = (document: InstanceType<typeof Document>) => {
    const pelvis = document.createNode("pelvis"), hand = document.createNode("hand");
    document.createScene().addChild(pelvis.addChild(hand));
    return { pelvis, hand };
  };
  const family = (clips: [string, number][]) => {
    const document = new Document(), buffer = document.createBuffer(), { hand } = skeleton(document);
    const input = document.createAccessor().setType("SCALAR").setBuffer(buffer);
    for (const [name, duration] of clips) {
      input.setArray(new Float32Array([0, duration]));
      const sampler = document.createAnimationSampler().setInterpolation("STEP").setInput(input)
        .setOutput(document.createAccessor().setType("VEC4").setArray(new Float32Array([0, 0, 0, 1, 0, 1, 0, 0])).setBuffer(buffer));
      document.createAnimation(name).addSampler(sampler)
        .addChannel(document.createAnimationChannel().setTargetNode(hand).setTargetPath("rotation").setSampler(sampler));
    }
    return document;
  };
  const target = new Document(), { hand } = skeleton(target);
  addClips(target, [family([["Idle", 2]]), family([["Wave", 1.5]])]);
  const clips = target.getRoot().listAnimations();
  assert.deepEqual(clips.map((clip) => clip.getName()), ["Idle", "Wave"]);
  for (const clip of clips) {
    const [channel] = clip.listChannels();
    assert.equal(channel!.getTargetNode(), hand);
    assert.equal(channel!.getSampler()!.getInterpolation(), "STEP");
    assert.deepEqual([...channel!.getSampler()!.getOutput()!.getArray()!], [0, 0, 0, 1, 0, 1, 0, 0]);
  }
  assert.equal(target.getRoot().listNodes().length, 2);
  const lacking = new Document();
  lacking.createScene().addChild(lacking.createNode("pelvis"));
  assert.throws(() => addClips(lacking, [family([["Idle", 2]])]), /moves 'hand', which the skeleton lacks/);
});
