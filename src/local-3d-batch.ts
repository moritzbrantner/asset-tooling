import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { canonicalJson } from "./canonical.js";
import { executeStableDiffusionImageOperation } from "./generation-operations.js";
import { sha256Text } from "./hash.js";
import { executeImageBorderWhiteAlphaOperation } from "./image-background-operations.js";
import {
  executeImageDecodeOperation,
  executeImageEncodePngOperation,
} from "./image-codec-operations.js";
import { resolveAssetObject, storeAssetObject } from "./asset-store.js";
import { executeStableFast3DMeshOperation } from "./stable-fast-3d-operation.js";
import { captureToolIdentity } from "./tool.js";

const SCHEMA_VERSION = 1;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const QUEUE_LINE = /^\s*-\s+\[\s\]\s+([a-z0-9]+(?:[.-][a-z0-9]+)*)\s+::\s+(.+?)\s*$/;
const CHECKBOX = /^\s*-\s+\[[ xX]\]/;
const CHECKED = /^\s*-\s+\[[xX]\]/;
const STAGES = ["concept", "decoded", "matte", "prepared", "mesh"];

function hasCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

function object(value, location) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(location + " must be a plain object");
  }
  return value;
}

function nonEmpty(value, location) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(location + " must be a non-empty string");
  }
  return value;
}

function integer(value, location, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(location + " must be an integer in " + minimum + ".." + maximum);
  }
  return value;
}

function choice(value, values, location) {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(location + " must be one of " + values.join(", "));
  }
  return value;
}

function bool(value, location) {
  if (typeof value !== "boolean") throw new Error(location + " must be a boolean");
  return value;
}

function bundle(value, location, base) {
  const entry = object(value, location);
  return {
    id: nonEmpty(entry.id, location + ".id"),
    path: path.resolve(base, nonEmpty(entry.path, location + ".path")),
  };
}

export function parseLocal3DQueue(markdown) {
  if (typeof markdown !== "string") throw new Error("3D queue Markdown must be a string");
  const items = [];
  const ids = new Set();
  markdown.split(/\r?\n/).forEach((line, index) => {
    if (CHECKED.test(line) || !CHECKBOX.test(line)) return;
    const match = QUEUE_LINE.exec(line);
    if (!match) {
      throw new Error(
        "queue line " + (index + 1) + " must use '- [ ] asset.id :: prompt text'",
      );
    }
    const id = match[1];
    const prompt = match[2].trim();
    if (!ID_PATTERN.test(id)) throw new Error("invalid queue asset id '" + id + "'");
    if (ids.has(id)) throw new Error("queue contains duplicate asset id '" + id + "'");
    ids.add(id);
    items.push({ id, prompt, line: index + 1 });
  });
  if (items.length === 0) throw new Error("3D queue contains no unchecked jobs");
  return items;
}

function normalizeConfig(raw, configPath, root) {
  const value = object(raw, "weekend 3D config");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("weekend 3D config schemaVersion must be 1");
  }
  const base = path.dirname(configPath);
  const background = object(value.background, "config.background");
  const stableDiffusion = object(value.stableDiffusion, "config.stableDiffusion");
  const stableFast3D = object(value.stableFast3D, "config.stableFast3D");
  const outputDir = path.resolve(base, nonEmpty(value.outputDir, "config.outputDir"));
  const relativeOutput = path.relative(root, outputDir);
  if (
    relativeOutput === "" ||
    relativeOutput === ".." ||
    relativeOutput.startsWith(".." + path.sep) ||
    path.isAbsolute(relativeOutput)
  ) {
    throw new Error("config.outputDir must resolve inside the repository");
  }

  const backgroundFloor = integer(
    background.backgroundFloor,
    "config.background.backgroundFloor",
    0,
    254,
  );
  const transparentAbove = integer(
    background.transparentAbove,
    "config.background.transparentAbove",
    1,
    255,
  );
  if (backgroundFloor >= transparentAbove) {
    throw new Error("backgroundFloor must be below transparentAbove");
  }

  const targetVertexCount = stableFast3D.targetVertexCount;
  if (
    targetVertexCount !== -1 &&
    (!Number.isSafeInteger(targetVertexCount) ||
      targetVertexCount < 1000 ||
      targetVertexCount > 20000)
  ) {
    throw new Error("config.stableFast3D.targetVertexCount must be -1 or 1000..20000");
  }

  return {
    queuePath: path.resolve(base, nonEmpty(value.queue, "config.queue")),
    outputDir,
    promptPrefix: typeof value.promptPrefix === "string" ? value.promptPrefix : "",
    promptSuffix: typeof value.promptSuffix === "string" ? value.promptSuffix : "",
    negativePrompt: typeof value.negativePrompt === "string" ? value.negativePrompt : "",
    cooldownSeconds: integer(value.cooldownSeconds ?? 0, "config.cooldownSeconds", 0, 3600),
    background: { backgroundFloor, transparentAbove },
    stableDiffusion: {
      pipeline: bundle(stableDiffusion.pipeline, "config.stableDiffusion.pipeline", base),
      device: choice(stableDiffusion.device, ["cpu", "cuda", "mps"], "config.stableDiffusion.device"),
      dtype: choice(
        stableDiffusion.dtype,
        ["float32", "float16", "bfloat16"],
        "config.stableDiffusion.dtype",
      ),
      steps: integer(stableDiffusion.steps, "config.stableDiffusion.steps", 1, 200),
      guidanceScale:
        typeof stableDiffusion.guidanceScale === "number" &&
        Number.isFinite(stableDiffusion.guidanceScale) &&
        stableDiffusion.guidanceScale >= 0 &&
        stableDiffusion.guidanceScale <= 30
          ? stableDiffusion.guidanceScale
          : (() => {
              throw new Error("config.stableDiffusion.guidanceScale must be in 0..30");
            })(),
      scheduler: choice(
        stableDiffusion.scheduler,
        ["default", "ddim", "euler", "euler-a"],
        "config.stableDiffusion.scheduler",
      ),
      deterministicAlgorithms: bool(
        stableDiffusion.deterministicAlgorithms,
        "config.stableDiffusion.deterministicAlgorithms",
      ),
    },
    stableFast3D: {
      source: bundle(stableFast3D.source, "config.stableFast3D.source", base),
      model: bundle(stableFast3D.model, "config.stableFast3D.model", base),
      tokenizer: bundle(stableFast3D.tokenizer, "config.stableFast3D.tokenizer", base),
      device: choice(stableFast3D.device, ["cpu", "cuda"], "config.stableFast3D.device"),
      textureResolution: integer(
        stableFast3D.textureResolution,
        "config.stableFast3D.textureResolution",
        512,
        2048,
      ),
      remesh: choice(
        stableFast3D.remesh,
        ["none", "triangle", "quad"],
        "config.stableFast3D.remesh",
      ),
      targetVertexCount,
      deterministicAlgorithms: bool(
        stableFast3D.deterministicAlgorithms,
        "config.stableFast3D.deterministicAlgorithms",
      ),
    },
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, filePath);
}

async function importBundle(root, descriptor, role) {
  const bytes = await readFile(descriptor.path);
  return (
    await storeAssetObject(root, {
      bytes,
      kind: "model",
      mediaType: "application/zip",
      metadata: { id: descriptor.id, role },
    })
  ).asset;
}

async function pinModels(root, config, refreshLock) {
  const models = {
    stableDiffusion: await importBundle(
      root,
      config.stableDiffusion.pipeline,
      "stable-diffusion-pipeline",
    ),
    stableFast3DSource: await importBundle(
      root,
      config.stableFast3D.source,
      "stable-fast-3d-source",
    ),
    stableFast3DModel: await importBundle(
      root,
      config.stableFast3D.model,
      "stable-fast-3d-model",
    ),
    stableFast3DTokenizer: await importBundle(
      root,
      config.stableFast3D.tokenizer,
      "stable-fast-3d-tokenizer",
    ),
  };
  const lock = {
    schemaVersion: 1,
    models: Object.fromEntries(
      Object.entries(models).map(([role, asset]) => [
        role,
        {
          id: asset.metadata.id,
          sha256: asset.sha256,
          byteLength: asset.byteLength,
        },
      ]),
    ),
  };
  const lockPath = path.join(config.outputDir, "model-lock.json");
  const existing = await readJson(lockPath, null);
  if (existing && !refreshLock && canonicalJson(existing) !== canonicalJson(lock)) {
    throw new Error(
      "local model bundle bytes changed; inspect them and rerun with --refresh-lock to accept",
    );
  }
  if (!existing || refreshLock) await writeJson(lockPath, lock);
  return { models, lock };
}

function runCommand(executable, args, root, env = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw new Error("could not execute " + executable + ": " + result.error.message);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(
      executable + " " + args.join(" ") + " failed with status " + result.status +
        (detail ? ": " + detail : ""),
    );
  }
  return String(result.stdout || "").trim();
}

export async function doctorLocal3DBatch(rootValue, configPathValue, options = {}) {
  const root = path.resolve(rootValue);
  const configPath = path.resolve(root, configPathValue);
  const config = normalizeConfig(
    JSON.parse(await readFile(configPath, "utf8")),
    configPath,
    root,
  );
  const queue = parseLocal3DQueue(await readFile(config.queuePath, "utf8"));
  const pinned = await pinModels(root, config, options.refreshLock === true);

  runCommand("ffmpeg", ["-version"], root);
  runCommand("ffprobe", ["-version"], root);
  runCommand("python3", [path.join(root, "adapters/python/stable_diffusion.py"), "probe"], root, {
    ASSET_TOOLING_REQUESTED_DEVICE: config.stableDiffusion.device,
  });
  runCommand("python3", [path.join(root, "adapters/python/stable_fast_3d.py"), "probe"], root, {
    ASSET_TOOLING_REQUESTED_DEVICE: config.stableFast3D.device,
  });

  return {
    status: "ready",
    queuedJobs: queue.length,
    outputDir: path.relative(root, config.outputDir),
    modelLock: pinned.lock,
  };
}

function seedFor(item) {
  const digest = sha256Text(item.id + "\0" + item.prompt);
  return BigInt("0x" + digest.slice(0, 16)).toString(10);
}

function combinedPrompt(config, item) {
  return (config.promptPrefix + item.prompt + config.promptSuffix).trim();
}

function itemDir(config, item) {
  return path.join(config.outputDir, item.id);
}

async function validAsset(root, asset) {
  if (!asset) return undefined;
  try {
    await resolveAssetObject(root, asset);
    return asset;
  } catch {
    return undefined;
  }
}

async function normalizeStages(root, job) {
  const stages = { ...(job.stages ?? {}) };
  let invalid = false;
  for (const stage of STAGES) {
    if (invalid) {
      delete stages[stage];
      continue;
    }
    if (!(await validAsset(root, stages[stage]))) {
      delete stages[stage];
      invalid = true;
    }
  }
  return { ...job, stages };
}

async function materialize(root, asset, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, await resolveAssetObject(root, asset));
}

async function materializeJob(root, config, item, job) {
  const directory = itemDir(config, item);
  await materialize(root, job.stages.concept, path.join(directory, "concept.png"));
  await materialize(root, job.stages.prepared, path.join(directory, "prepared.png"));
  await materialize(root, job.stages.mesh, path.join(directory, "model.glb"));
  await writeJson(path.join(directory, "job.json"), {
    schemaVersion: 1,
    id: item.id,
    prompt: item.prompt,
    seed: job.seed,
    jobKey: job.jobKey,
    stages: job.stages,
  });
}

function jobIdentity(item, config, models, tool) {
  return sha256Text(
    canonicalJson({
      schemaVersion: 1,
      id: item.id,
      prompt: item.prompt,
      seed: seedFor(item),
      promptPrefix: config.promptPrefix,
      promptSuffix: config.promptSuffix,
      negativePrompt: config.negativePrompt,
      background: config.background,
      stableDiffusion: {
        model: models.stableDiffusion.sha256,
        device: config.stableDiffusion.device,
        dtype: config.stableDiffusion.dtype,
        steps: config.stableDiffusion.steps,
        guidanceScale: config.stableDiffusion.guidanceScale,
        scheduler: config.stableDiffusion.scheduler,
        deterministicAlgorithms: config.stableDiffusion.deterministicAlgorithms,
      },
      stableFast3D: {
        source: models.stableFast3DSource.sha256,
        model: models.stableFast3DModel.sha256,
        tokenizer: models.stableFast3DTokenizer.sha256,
        device: config.stableFast3D.device,
        textureResolution: config.stableFast3D.textureResolution,
        remesh: config.stableFast3D.remesh,
        targetVertexCount: config.stableFast3D.targetVertexCount,
        deterministicAlgorithms: config.stableFast3D.deterministicAlgorithms,
      },
      tool: tool.sourceFingerprint.sha256,
    }),
  );
}

function report(queue, state, config, root) {
  const lines = [
    "# Local 3D batch report",
    "",
    "| Asset | Status | Seed | Output/error |",
    "| --- | --- | ---: | --- |",
  ];
  for (const item of queue) {
    const job = state.jobs[item.id];
    const status = job?.status ?? "pending";
    const seed = job?.seed ?? "—";
    let detail = "—";
    if (status === "completed") {
      detail = path.relative(root, path.join(itemDir(config, item), "model.glb")).replaceAll(path.sep, "/");
    } else if (job?.error) {
      detail = String(job.error).replaceAll("|", "\\|").replaceAll("\n", " ");
    }
    lines.push("| " + item.id + " | " + status + " | " + seed + " | " + detail + " |");
  }
  return lines.join("\n") + "\n";
}

async function checkpoint(queue, state, config, root, statePath) {
  await writeJson(statePath, state);
  await mkdir(config.outputDir, { recursive: true });
  await writeFile(path.join(config.outputDir, "REPORT.md"), report(queue, state, config, root), "utf8");
}

async function runOne(root, config, item, models, tool, state, statePath, queue) {
  const seed = seedFor(item);
  const key = jobIdentity(item, config, models, tool);
  let job = state.jobs[item.id];
  if (!job || job.jobKey !== key) {
    job = { schemaVersion: 1, jobKey: key, seed, prompt: item.prompt, status: "pending", stages: {} };
  } else {
    job = await normalizeStages(root, job);
  }
  state.jobs[item.id] = job;
  job.status = "running";
  delete job.error;
  await checkpoint(queue, state, config, root, statePath);

  try {
    if (!job.stages.concept) {
      const generated = await executeStableDiffusionImageOperation(root, {
        parameters: {
          pipelineId: config.stableDiffusion.pipeline.id,
          seed,
          prompt: combinedPrompt(config, item),
          negativePrompt: config.negativePrompt,
          width: 512,
          height: 512,
          steps: config.stableDiffusion.steps,
          guidanceScale: config.stableDiffusion.guidanceScale,
          scheduler: config.stableDiffusion.scheduler,
          dtype: config.stableDiffusion.dtype,
          device: config.stableDiffusion.device,
          deterministicAlgorithms: config.stableDiffusion.deterministicAlgorithms,
        },
        inputs: { model: models.stableDiffusion },
      });
      job.stages.concept = generated.outputs.output;
      await checkpoint(queue, state, config, root, statePath);
    }

    if (!job.stages.decoded) {
      const decoded = await executeImageDecodeOperation(root, {
        parameters: {},
        inputs: { source: job.stages.concept },
      });
      job.stages.decoded = decoded.outputs.output;
      await checkpoint(queue, state, config, root, statePath);
    }

    if (!job.stages.matte) {
      const matte = await executeImageBorderWhiteAlphaOperation(root, {
        parameters: config.background,
        inputs: { source: job.stages.decoded },
      });
      job.stages.matte = matte.outputs.output;
      await checkpoint(queue, state, config, root, statePath);
    }

    if (!job.stages.prepared) {
      const prepared = await executeImageEncodePngOperation(root, {
        parameters: { compressionLevel: 9 },
        inputs: { source: job.stages.matte },
      });
      job.stages.prepared = prepared.outputs.output;
      await checkpoint(queue, state, config, root, statePath);
    }

    if (!job.stages.mesh) {
      const mesh = await executeStableFast3DMeshOperation(root, {
        parameters: {
          sourceBundleId: config.stableFast3D.source.id,
          modelBundleId: config.stableFast3D.model.id,
          tokenizerBundleId: config.stableFast3D.tokenizer.id,
          preprocessMode: "prepared-rgba",
          device: config.stableFast3D.device,
          textureResolution: config.stableFast3D.textureResolution,
          remesh: config.stableFast3D.remesh,
          targetVertexCount: config.stableFast3D.targetVertexCount,
          deterministicAlgorithms: config.stableFast3D.deterministicAlgorithms,
        },
        inputs: {
          image: job.stages.prepared,
          source: models.stableFast3DSource,
          model: models.stableFast3DModel,
          tokenizer: models.stableFast3DTokenizer,
        },
      });
      job.stages.mesh = mesh.outputs.output;
      await checkpoint(queue, state, config, root, statePath);
    }

    await materializeJob(root, config, item, job);
    job.status = "completed";
    await checkpoint(queue, state, config, root, statePath);
    return { id: item.id, status: "completed" };
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    await checkpoint(queue, state, config, root, statePath);
    return { id: item.id, status: "failed", error: job.error };
  }
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function runLocal3DBatch(rootValue, configPathValue, options = {}) {
  const root = path.resolve(rootValue);
  const configPath = path.resolve(root, configPathValue);
  const config = normalizeConfig(
    JSON.parse(await readFile(configPath, "utf8")),
    configPath,
    root,
  );
  const queue = parseLocal3DQueue(await readFile(config.queuePath, "utf8"));
  let selected = options.only ? queue.filter((item) => item.id === options.only) : queue;
  if (options.only && selected.length === 0) {
    throw new Error("queue does not contain unchecked asset '" + options.only + "'");
  }
  if (options.maxItems !== undefined) selected = selected.slice(0, options.maxItems);

  const pinned = await pinModels(root, config, options.refreshLock === true);
  const tool = await captureToolIdentity();
  const statePath = path.join(config.outputDir, "state.json");
  const state = await readJson(statePath, { schemaVersion: 1, jobs: {} });
  if (state.schemaVersion !== 1 || typeof state.jobs !== "object" || state.jobs === null) {
    throw new Error("local 3D batch state has an unsupported shape");
  }

  if (options.dryRun) {
    return {
      status: "planned",
      jobs: selected.map((item) => ({
        id: item.id,
        seed: seedFor(item),
        prompt: combinedPrompt(config, item),
      })),
      outputDir: path.relative(root, config.outputDir),
      modelLock: pinned.lock,
    };
  }

  const results = [];
  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    const current = state.jobs[item.id];
    const expectedKey = jobIdentity(item, config, pinned.models, tool);
    if (current?.status === "completed" && current.jobKey === expectedKey) {
      const normalized = await normalizeStages(root, current);
      state.jobs[item.id] = normalized;
      if (STAGES.every((stage) => normalized.stages[stage])) {
        await materializeJob(root, config, item, normalized);
        results.push({ id: item.id, status: "completed", resumed: true });
        await checkpoint(queue, state, config, root, statePath);
        continue;
      }
    }

    results.push(
      await runOne(root, config, item, pinned.models, tool, state, statePath, queue),
    );
    if (index + 1 < selected.length && config.cooldownSeconds > 0) {
      await sleep(config.cooldownSeconds);
    }
  }

  const failed = results.filter((entry) => entry.status === "failed");
  return {
    status: failed.length === 0 ? "completed" : "completed-with-failures",
    completed: results.length - failed.length,
    failed: failed.length,
    results,
    report: path.relative(root, path.join(config.outputDir, "REPORT.md")),
  };
}
