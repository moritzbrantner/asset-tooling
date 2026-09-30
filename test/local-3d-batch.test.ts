import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  normalizeLocal3DBatchConfig,
  parseLocal3DQueue,
} from "../src/local-3d-batch.js";


function configBase() {
  return {
    schemaVersion: 1,
    queue: "WEEKEND_MODELS.md",
    outputDir: "build/test-weekend-3d",
    promptPrefix: "",
    promptSuffix: "",
    negativePrompt: "",
    cooldownSeconds: 0,
    background: {
      backgroundFloor: 224,
      transparentAbove: 250,
    },
    stableDiffusion: {
      pipeline: {
        id: "diffusion",
        path: "models/diffusion.zip",
      },
      device: "cuda",
      dtype: "float16",
      steps: 20,
      guidanceScale: 7,
      scheduler: "euler-a",
      deterministicAlgorithms: false,
    },
  };
}

function configPaths() {
  const root = path.join(os.tmpdir(), "asset-tooling-local-3d-config");
  return {
    root,
    configPath: path.join(root, "weekend-3d.local.json"),
  };
}

test("legacy v1 batch config defaults to Stable Fast 3D without requiring TRELLIS.2", () => {
  const { root, configPath } = configPaths();
  const normalized = normalizeLocal3DBatchConfig(
    {
      ...configBase(),
      stableFast3D: {
        source: { id: "sf3d-source", path: "models/sf3d-source.zip" },
        model: { id: "sf3d-model", path: "models/sf3d-model.zip" },
        tokenizer: { id: "dino-v2", path: "models/dino-v2.zip" },
        device: "cuda",
        textureResolution: 1024,
        remesh: "triangle",
        targetVertexCount: 12000,
        deterministicAlgorithms: false,
      },
    },
    configPath,
    root,
  );

  assert.equal(normalized.reconstructionBackend, "stable-fast-3d");
  assert.equal(normalized.stableFast3D.model.id, "sf3d-model");
  assert.equal(normalized.trellis2, undefined);
});

test("TRELLIS.2 batch config needs only its own reconstruction bundles", () => {
  const { root, configPath } = configPaths();
  const normalized = normalizeLocal3DBatchConfig(
    {
      ...configBase(),
      reconstructionBackend: "trellis2",
      trellis2: {
        source: { id: "trellis-source", path: "models/trellis-source.zip" },
        model: { id: "trellis-model", path: "models/trellis-model.zip" },
        legacyDecoder: { id: "trellis-legacy", path: "models/trellis-legacy.zip" },
        imageEncoder: { id: "dino-v3", path: "models/dino-v3.zip" },
        device: "cuda",
        pipelineType: "1024-cascade",
        maxNumTokens: 49152,
        decimationTarget: 100000,
        textureSize: 2048,
        remesh: true,
        extensionWebp: false,
        deterministicAlgorithms: false,
      },
    },
    configPath,
    root,
  );

  assert.equal(normalized.reconstructionBackend, "trellis2");
  assert.equal(normalized.stableFast3D, undefined);
  assert.equal(normalized.trellis2.legacyDecoder.id, "trellis-legacy");
  assert.equal(normalized.trellis2.imageEncoder.id, "dino-v3");
});

test("TRELLIS.2 batch config rejects unsupported CPU execution before model access", () => {
  const { root, configPath } = configPaths();
  assert.throws(
    () =>
      normalizeLocal3DBatchConfig(
        {
          ...configBase(),
          reconstructionBackend: "trellis2",
          trellis2: {
            source: { id: "trellis-source", path: "models/trellis-source.zip" },
            model: { id: "trellis-model", path: "models/trellis-model.zip" },
            legacyDecoder: { id: "trellis-legacy", path: "models/trellis-legacy.zip" },
            imageEncoder: { id: "dino-v3", path: "models/dino-v3.zip" },
            device: "cpu",
            pipelineType: "1024-cascade",
            maxNumTokens: 49152,
            decimationTarget: 100000,
            textureSize: 2048,
            remesh: true,
            extensionWebp: false,
            deterministicAlgorithms: false,
          },
        },
        configPath,
        root,
      ),
    /config\.trellis2\.device must be one of cuda/,
  );
});

test("weekend queue reads unchecked object prompts in file order", () => {
  const items = parseLocal3DQueue([
    "# Weekend batch",
    "",
    "- [ ] raid-defense.town-hall :: fortified medieval town hall",
    "- [x] raid-defense.old-tower :: intentionally disabled",
    "- [ ] raid-defense.arrow-tower :: narrow arrow tower",
  ].join("\n"));

  assert.deepEqual(items, [
    {
      id: "raid-defense.town-hall",
      prompt: "fortified medieval town hall",
      line: 3,
    },
    {
      id: "raid-defense.arrow-tower",
      prompt: "narrow arrow tower",
      line: 5,
    },
  ]);
});

test("weekend queue rejects malformed checkbox jobs instead of silently skipping them", () => {
  assert.throws(
    () => parseLocal3DQueue("- [ ] town hall without delimiter"),
    /must use '- \[ \] asset\.id :: prompt text'/,
  );
});

test("weekend queue rejects duplicate asset ids", () => {
  assert.throws(
    () =>
      parseLocal3DQueue([
        "- [ ] raid-defense.tower :: first",
        "- [ ] raid-defense.tower :: second",
      ].join("\n")),
    /duplicate asset id/,
  );
});

test("weekend queue requires at least one active item", () => {
  assert.throws(
    () => parseLocal3DQueue("- [x] raid-defense.done :: already generated"),
    /no unchecked jobs/,
  );
});

test("weekend batch source remains local and sequential by construction", async () => {
  const source = await readFile(
    new URL("../src/local-3d-batch.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /for \(let index = 0; index < selected\.length; index \+= 1\)/);
  assert.match(source, /await runOne\(/);
  assert.match(source, /executeStableDiffusionImageOperation/);
  assert.match(source, /reconstructionBackend/);
  assert.match(source, /executeStableFast3DMeshOperation/);
  assert.match(source, /executeTrellis2MeshOperation/);
  assert.match(source, /config\.reconstructionBackend === "stable-fast-3d"/);
  assert.match(source, /model-lock\.json/);
  assert.match(source, /state\.json/);
  assert.doesNotMatch(source, /fetch\(/);
  assert.doesNotMatch(source, /https?:\/\//);
});
