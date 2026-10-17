// Acceptance contract for #211: Warden ability-icon candidates.
//
// Owner decision (2026-10-17, #211): generated review candidates live in a separate
// Git LFS review namespace `review/warden-icons/`, outside `assets/canonical/` and
// without catalog storage entries. A plain-JSON candidates manifest pins every
// candidate's bytes and provenance. Pages hydrates only that folder, re-hashes it
// against the manifest (fail closed) and derives true 64/48/32 px views next to the
// 512 px master on a Warden review page. Candidates are never approved here:
// approval stays an exact-sha `approved-png-v1` export (Atlas Decision 4.1.3).
//
// Owner decision (2026-10-17, Atlas 4.1.4): FLUX.2 [klein] 4B and Z-Image Turbo are the supported
// local image models; SD 1.5 is deprecated and its candidates stay only as history.
//
// Owner decision (2026-10-17, Atlas 4.1.5): FLUX.2 [klein] 4B is the model for the Warden set and
// every icon is a margin-free close-up (briefs v3). The tight-framed klein set is the current
// candidate set; the v2 klein/Z-Image comparison and the SD 1.5 run stay as superseded sets.
//
// Seams this file fixes for the implementer:
// - review/warden-icons/briefs.json, briefs.v2.json, briefs.v3.json  versioned style + four ability briefs (plain JSON)
// - review/warden-icons/workflow.*.api.json    prepared ComfyUI API-format workflows (plain JSON)
// - review/warden-icons/candidates.json        candidates manifest v3: briefs, models, sets, candidates
// - review/warden-icons/candidates/*.png       candidate bytes (Git LFS)
// - src/warden-icon-review.ts exports
//     loadWardenCandidateReview(reviewDirectory) -> { briefs, manifest, candidates }
//     buildWardenReviewPage({ root, reviewDirectory, outputDirectory })
//       -> { page: "index.html", candidates: [{ id, ability, images: [{ size, url }] }] }
//   `root` is a disposable workspace for the object store; `url`s are relative to
//   `outputDirectory`. Both fail closed on missing, unhydrated or altered bytes.
// - scripts/build-generated-previews.ts writes the page to dist/pages/review/warden-icons/
//   and the gallery index links to it; .github/workflows/pages.yml hydrates only review/.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "../src/hash.js";
import { storeAssetObject } from "../src/asset-store.js";
import { loadPreparedComfyUiApiWorkflow } from "../src/comfyui-workflow.js";
import { createGeneratedGalleryAssets, extendCatalogGalleryModel } from "../src/generated-gallery-assets.js";
import { renderCatalogGalleryHtml } from "../src/catalog-pages-site.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW = "review/warden-icons";
const REVIEW_DIR = path.join(ROOT, ...REVIEW.split("/"));
const WORKFLOW_FILE = "workflow.sd15-icon.api.json";
const MODEL_WORKFLOWS: Record<string, { file: string; status: string; nodes: string[] }> = {
  "flux2-klein-4b": {
    file: "workflow.flux2-klein-4b-icon.api.json",
    status: "supported",
    nodes: ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "EmptyFlux2LatentImage", "Flux2Scheduler", "SamplerCustomAdvanced", "SaveImage"],
  },
  "z-image-turbo": {
    file: "workflow.z-image-turbo-icon.api.json",
    status: "supported",
    nodes: ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "EmptySD3LatentImage", "KSampler", "SaveImage"],
  },
  sd15: { file: WORKFLOW_FILE, status: "deprecated", nodes: ["CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "SaveImage"] },
};
const SUPPORTED_MODELS = ["flux2-klein-4b", "z-image-turbo"];
const CURRENT_SET = { id: "warden.v3.flux2-klein-tight", model: "flux2-klein-4b", briefs: "briefs.v3.json" };
const SUPERSEDED_SETS = ["warden.v2.model-comparison", "warden.v1.sd15"];
const ABILITIES = [
  { id: "warden.ability.1", abilityId: 1, name: "Heroic Strike" },
  { id: "warden.ability.2", abilityId: 2, name: "Shield Bash" },
  { id: "warden.ability.3", abilityId: 3, name: "Rallying Cry" },
  { id: "warden.ability.4", abilityId: 4, name: "Cleave" },
];
const REVIEW_SIZES = [512, 64, 48, 32];
// Owner decision (2026-10-17, #211): "just do 3 of them, and defer the other 9" — 3 total, any
// abilities. The manifest lists exactly the candidates that exist; an ability may have none yet.
const MIN_CANDIDATES_TOTAL = 1;
// Fixture: three candidates over two abilities, leaving Shield Bash and Cleave without one.
const FIXTURE_CANDIDATE_ABILITIES = [0, 0, 2];
const SHA256 = /^[0-9a-f]{64}$/;
const COPYRIGHTED_REFERENCES = /warcraft|\bwow\b|dota|blizzard|valve/i;
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(file, "utf8"));
}

async function reviewModule(): Promise<any> {
  return import("../src/warden-icon-review.js");
}

function hasFfmpeg() {
  return spawnSync("ffmpeg", ["-version"], { windowsHide: true, timeout: 30_000 }).status === 0 &&
    spawnSync("ffprobe", ["-version"], { windowsHide: true, timeout: 30_000 }).status === 0;
}

function pngSize(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  assert(buffer.subarray(0, 8).equals(PNG_SIGNATURE), "expected PNG signature");
  assert.equal(buffer.subarray(12, 16).toString("latin1"), "IHDR");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function lfsPointer(bytes: Uint8Array) {
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.startsWith(LFS_POINTER_PREFIX)) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  assert(oid && size, "malformed Git LFS pointer");
  return { sha256: oid, byteLength: Number(size) };
}

function gitAttribute(relativePath: string, attribute: string) {
  const result = spawnSync("git", ["-C", ROOT, "check-attr", attribute, "--", relativePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(": ").at(-1);
}

function collectKeysAndStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) collectKeysAndStrings(item, out);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectKeysAndStrings(item, out);
    }
  } else if (typeof value === "string") out.push(value);
  return out;
}

function withoutNegatedApproval(text: string) {
  return text.replace(/\b(?:not|never)\s+(?:yet\s+)?approved\b/gi, "").replace(/\bunapproved\b/gi, "");
}

// ---- tiny deterministic PNG encoder for fixtures (no ffmpeg needed to create them) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function encodePng(size: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) raw.set(pixel(x, y), row + 1 + x * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---- fixture review folder shaped exactly like the committed one ----
const FIXTURE_CHECKPOINT = {
  name: "v1-5-pruned-emaonly.safetensors",
  sha256: "6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa",
  byteLength: 4265146304,
  license: "creativeml-openrail-m",
};

async function writeFixtureReview(directory: string, { abilityIndices = FIXTURE_CANDIDATE_ABILITIES } = {}) {
  await mkdir(path.join(directory, "candidates"), { recursive: true });
  const style = {
    id: "warden.style",
    version: 1,
    description: "Fixture painterly dark-fantasy icon style.",
    prompt: "fixture painterly dark fantasy game icon, strong silhouette",
    negativePrompt: "text, watermark, frame, blurry",
  };
  const briefs = {
    schemaVersion: 1,
    style,
    abilities: ABILITIES.map((ability) => ({
      ...ability,
      version: 1,
      subject: `fixture subject for ${ability.name}`,
      prompt: `fixture ${ability.name.toLowerCase()} emblem`,
    })),
  };
  const briefBytes = Buffer.from(JSON.stringify(briefs, null, 2) + "\n");
  await writeFile(path.join(directory, "briefs.json"), briefBytes);
  const workflowBytes = await readFile(path.join(ROOT, "test", "fixtures", "comfyui", "sd15-txt2img.api.json"));
  await writeFile(path.join(directory, WORKFLOW_FILE), workflowBytes);

  const candidates = [];
  const counts = new Map<number, number>();
  for (const abilityIndex of abilityIndices) {
    const ability = briefs.abilities[abilityIndex]!;
    const k = (counts.get(abilityIndex) ?? 0) + 1;
    counts.set(abilityIndex, k);
    {
      const tint = (abilityIndex * 60 + k * 17) % 256;
      const bytes = encodePng(512, (x, y) => {
        const inside = Math.abs(x - 256) + Math.abs(y - 256) < 120 + abilityIndex * 30 + k * 5;
        return inside ? [240, tint, 40 + k * 20, 255] : [20, 24, 30 + abilityIndex * 20, 255];
      });
      const file = `candidates/${ability.id}.candidate.${String(k).padStart(2, "0")}.png`;
      await writeFile(path.join(directory, ...file.split("/")), bytes);
      candidates.push({
        id: `${ability.id}.candidate.${String(k).padStart(2, "0")}`,
        ability: ability.id,
        model: "sd15",
        set: "warden.v1.fixture",
        briefs: "briefs.json",
        state: "candidate",
        path: file,
        mediaType: "image/png",
        sha256: sha256Bytes(bytes),
        byteLength: bytes.length,
        width: 512,
        height: 512,
        provenance: {
          provider: "comfyui",
          operation: "image.comfyui.generate@1",
          workflow: { path: WORKFLOW_FILE, sha256: sha256Bytes(workflowBytes) },
          checkpoint: { ...FIXTURE_CHECKPOINT },
          seed: 1000 + abilityIndex * 10 + k,
          positivePrompt: `${style.prompt}, ${ability.prompt}`,
          negativePrompt: style.negativePrompt,
        },
      });
    }
  }
  const manifest = {
    schemaVersion: 3,
    briefs: [{ path: "briefs.json", sha256: sha256Bytes(briefBytes) }],
    models: [{
      id: "sd15",
      label: "Fixture SD 1.5",
      status: "deprecated",
      workflow: WORKFLOW_FILE,
      files: { checkpoint: { ...FIXTURE_CHECKPOINT } },
    }],
    sets: [{ id: "warden.v1.fixture", label: "Fixture first run", status: "current" }],
    candidates,
  };
  await writeFile(path.join(directory, "candidates.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { briefs, manifest };
}

async function withFixture<T>(run: (context: { root: string; review: string; output: string; manifest: any }) => Promise<T>, options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-warden-review-"));
  try {
    const review = path.join(base, "review");
    const output = path.join(base, "out");
    const root = path.join(base, "workspace");
    await mkdir(root, { recursive: true });
    const { manifest } = await writeFixtureReview(review, options);
    return await run({ root, review, output, manifest });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// =========================== committed data ===========================

for (const [file, styleVersion] of [["briefs.json", 1], ["briefs.v2.json", 2], ["briefs.v3.json", 3]] as const) test(`briefs: ${file} is one versioned original style brief and four stable Warden ability briefs`, async () => {
  const briefs = await readJson(path.join(REVIEW_DIR, file));
  assert.equal(briefs.schemaVersion, 1);
  const { style } = briefs;
  assert.match(style.id, /^warden\.style(?:\.[a-z0-9-]+)*$/);
  assert.equal(style.version, styleVersion, "style brief must be versioned");
  for (const field of ["description", "prompt"]) {
    assert.equal(typeof style[field], "string");
    assert(style[field].trim().length > 0, `style.${field} must be non-empty`);
  }
  // Style v2 targets CFG-1 models that ignore negative prompts; its exclusions live in the prompt.
  if (styleVersion === 1) assert(style.negativePrompt.trim());
  else assert.match(style.prompt, /no text/i);
  // Style v3 (Atlas 4.1.5): tight close-ups that fill the square, no wasted margin.
  if (styleVersion >= 3) {
    assert.match(style.prompt, /close-up/i);
    assert.match(style.prompt, /fills the entire square/i);
    assert.match(style.prompt, /no empty background border/i);
    assert.match(style.prompt, /no frame/i);
    assert.doesNotMatch(style.prompt, /vignette background/i, "v3 drops the v2 vignette background");
  }

  assert.equal(briefs.abilities.length, 4);
  for (const [index, expected] of ABILITIES.entries()) {
    const ability = briefs.abilities[index];
    assert.equal(ability.id, expected.id);
    assert.equal(ability.abilityId, expected.abilityId);
    assert.equal(ability.name, expected.name);
    assert(Number.isSafeInteger(ability.version) && ability.version >= 1, `${ability.id} must be versioned`);
    assert(typeof ability.subject === "string" && ability.subject.trim(), `${ability.id} needs a subject`);
    assert(typeof ability.prompt === "string" && ability.prompt.trim(), `${ability.id} needs a prompt`);
    if (styleVersion >= 3) {
      assert.equal(ability.version, 3);
      assert.match(ability.prompt, /close-up/i, `${ability.id} v3 is framed as a close-up`);
    }
  }
  if (styleVersion >= 3) {
    // The original subjects stay; only the framing changes.
    const [strike, bash, cry, cleave] = briefs.abilities.map((ability: any) => ability.prompt);
    assert.match(strike, /longsword/i);
    assert.match(strike, /slash/i);
    assert.match(bash, /round steel shield/i);
    assert.match(bash, /impact/i);
    assert.match(cry, /ivory war horn/i);
    assert.match(cry, /rings of sound/i);
    assert.match(cleave, /battle axe/i);
    assert.match(cleave, /arc/i);
  }
  assert.equal(new Set(briefs.abilities.map((ability: any) => ability.prompt)).size, 4, "ability prompts must be distinct");
  // WoW/Dota are quality benchmarks only, never prompt sources (Atlas 4.1.2).
  for (const text of [style.prompt, style.negativePrompt ?? "", ...briefs.abilities.map((ability: any) => ability.prompt)]) {
    assert.doesNotMatch(text, COPYRIGHTED_REFERENCES);
  }
});

for (const [model, expected] of Object.entries(MODEL_WORKFLOWS)) test(`workflow: the prepared ${model} icon workflow is a valid API-format workflow AssetRef`, async () => {
  const bytes = await readFile(path.join(REVIEW_DIR, expected.file));
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-tooling-warden-workflow-"));
  try {
    const stored = await storeAssetObject(root, {
      bytes,
      kind: "workflow",
      mediaType: "application/json",
      metadata: { format: "comfyui-api-prompt" },
    });
    const prepared = await loadPreparedComfyUiApiWorkflow(root, stored.asset);
    assert.equal(prepared.asset.sha256, sha256Bytes(bytes));
    const nodes = Object.values(JSON.parse(prepared.promptJson)) as any[];
    const classes = new Set(nodes.map((node) => node.class_type));
    for (const required of expected.nodes) assert(classes.has(required), `${expected.file} must contain ${required}`);
    if (model === "sd15") {
      const latent = nodes.find((node) => node.class_type === "EmptyLatentImage");
      assert.deepEqual([latent.inputs.width, latent.inputs.height], [512, 512]);
      return;
    }
    // Newer models: 1024 px, few distilled steps at CFG 1 (klein 4 steps, Z-Image Turbo 8 steps).
    const widths = nodes.filter((node) => node.class_type === "PrimitiveInt" || /Latent/.test(node.class_type));
    assert(widths.some((node) => node.inputs.value === 1024 || node.inputs.width === 1024), `${expected.file} renders 1024 px`);
    const steps = nodes.find((node) => node.class_type === "Flux2Scheduler" || node.class_type === "KSampler").inputs.steps;
    assert.equal(steps, model === "flux2-klein-4b" ? 4 : 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("models: FLUX.2 [klein] 4B and Z-Image Turbo are supported with pinned Apache-2.0 files; SD 1.5 is deprecated", async () => {
  const manifest = await readJson(path.join(REVIEW_DIR, "candidates.json"));
  assert.deepEqual(
    manifest.models.filter((model: any) => model.status === "supported").map((model: any) => model.id),
    SUPPORTED_MODELS,
  );
  assert.deepEqual(manifest.models.filter((model: any) => model.status === "deprecated").map((model: any) => model.id), ["sd15"]);
  for (const model of manifest.models) {
    assert.equal(model.workflow, MODEL_WORKFLOWS[model.id]!.file);
    for (const [role, file] of Object.entries(model.files) as [string, any][]) {
      assert.match(file.sha256, SHA256, `${model.id} ${role}`);
      assert(Number.isSafeInteger(file.byteLength) && file.byteLength > 0);
      assert.equal(file.source.provider, "huggingface");
      assert.match(file.source.revision, /^[0-9a-f]{40}$/, `${model.id} ${role} is pinned to an exact revision`);
      if (model.status === "supported") assert.equal(file.license, "apache-2.0", `${model.id} ${role} licence`);
    }
    if (model.status === "supported") assert.deepEqual(Object.keys(model.files).sort(), ["diffusionModel", "textEncoder", "vae"]);
  }
});

test("manifest: provenance-pinned candidates for the four Warden briefs, all in state candidate", async () => {
  const manifest = await readJson(path.join(REVIEW_DIR, "candidates.json"));
  assert.equal(manifest.schemaVersion, 3);
  const briefSets = new Map<string, any>();
  for (const ref of manifest.briefs) {
    assert.equal(ref.sha256, sha256Bytes(await readFile(path.join(REVIEW_DIR, ref.path))), `${ref.path} pin`);
    briefSets.set(ref.path, await readJson(path.join(REVIEW_DIR, ref.path)));
  }
  assert.deepEqual([...briefSets.keys()], ["briefs.json", "briefs.v2.json", "briefs.v3.json"]);
  const models = new Map<string, any>(manifest.models.map((model: any) => [model.id, model]));
  // Atlas 4.1.5: one current set (tight-framed klein); earlier sets stay as superseded history.
  assert.deepEqual(manifest.sets.filter((set: any) => set.status === "current").map((set: any) => set.id), [CURRENT_SET.id]);
  assert.deepEqual(manifest.sets.filter((set: any) => set.status === "superseded").map((set: any) => set.id), SUPERSEDED_SETS);
  const setIds = new Set(manifest.sets.map((set: any) => set.id));
  for (const set of manifest.sets) if (set.status === "superseded") assert(setIds.has(set.supersededBy), `${set.id} names its successor`);

  const ids = new Set();
  const hashes = new Set();
  for (const candidate of manifest.candidates) {
    assert.match(candidate.id, /^warden\.ability\.[1-4]\.candidate\.[a-z0-9-]+$/);
    assert(!ids.has(candidate.id), `duplicate candidate id ${candidate.id}`);
    ids.add(candidate.id);
    assert(candidate.id.startsWith(candidate.ability + "."), `${candidate.id} must belong to ${candidate.ability}`);
    assert.equal(candidate.state, "candidate", `${candidate.id} must be a candidate`);
    assert.match(candidate.path, /^candidates\/[a-z0-9][a-z0-9._-]*\.png$/);
    assert.equal(candidate.mediaType, "image/png");
    assert.match(candidate.sha256, SHA256);
    assert(!hashes.has(candidate.sha256), `${candidate.id} duplicates another candidate's bytes`);
    hashes.add(candidate.sha256);
    assert(Number.isSafeInteger(candidate.byteLength) && candidate.byteLength > 0);
    assert(candidate.width === 512 || candidate.width === 1024, `${candidate.id} master size`);
    assert.equal(candidate.height, candidate.width);
    const model = models.get(candidate.model);
    assert(model, `${candidate.id} names a listed model`);
    assert(setIds.has(candidate.set), `${candidate.id} names a listed set`);
    if (candidate.set === CURRENT_SET.id) {
      assert.equal(candidate.model, CURRENT_SET.model, `${candidate.id}: the current set is FLUX.2 [klein] only`);
      assert.equal(candidate.briefs, CURRENT_SET.briefs, `${candidate.id}: the current set uses briefs v3`);
    } else {
      assert.notEqual(candidate.briefs, CURRENT_SET.briefs, `${candidate.id}: briefs v3 candidates belong to the current set`);
    }
    // New candidates come only from supported models; deprecated SD 1.5 keeps its 512 px history.
    if (model.status === "deprecated") assert.equal(candidate.width, 512);
    else assert(candidate.width >= 768 && candidate.width <= 1024, `${candidate.id} master is 768–1024 px`);
    const briefs = briefSets.get(candidate.briefs);
    assert(briefs, `${candidate.id} names a pinned briefs file`);

    const { provenance } = candidate;
    assert.equal(provenance.provider, "comfyui");
    assert.equal(provenance.operation, "image.comfyui.generate@1");
    assert.match(provenance.workflow.path, /^[a-z0-9][a-z0-9._-]*\.json$/);
    assert.equal(
      provenance.workflow.sha256,
      sha256Bytes(await readFile(path.join(REVIEW_DIR, provenance.workflow.path))),
      `${candidate.id} workflow hash must match the committed workflow`,
    );
    assert(typeof provenance.checkpoint.name === "string" && provenance.checkpoint.name.endsWith(".safetensors"));
    assert.match(provenance.checkpoint.sha256, SHA256);
    assert(Number.isSafeInteger(provenance.checkpoint.byteLength) && provenance.checkpoint.byteLength > 0);
    assert(typeof provenance.checkpoint.license === "string" && provenance.checkpoint.license.trim());
    assert.equal(provenance.workflow.path, model.workflow);
    assert.equal(provenance.checkpoint.sha256, (model.files.checkpoint ?? model.files.diffusionModel).sha256);
    for (const role of ["textEncoder", "vae"]) {
      if (model.files[role]) assert.equal(provenance[role]?.sha256, model.files[role].sha256, `${candidate.id} ${role}`);
    }
    assert(Number.isSafeInteger(provenance.seed) && provenance.seed >= 0, `${candidate.id} needs its seed`);
    // Coherent set: every candidate uses the shared style brief plus its own ability brief.
    const ability = briefs.abilities.find((entry: any) => entry.id === candidate.ability);
    assert(ability, `${candidate.id} references unknown ability ${candidate.ability}`);
    assert(provenance.positivePrompt.includes(briefs.style.prompt), `${candidate.id} must use the style brief`);
    assert(provenance.positivePrompt.includes(ability.prompt), `${candidate.id} must use its ability brief`);
  }
  assert(manifest.candidates.length >= MIN_CANDIDATES_TOTAL, "the manifest lists at least one candidate");
  // Owner request 2026-10-17: the v2 comparison kept two to three candidates per ability from each
  // supported model; the current tight-framed klein set keeps the best three per ability.
  for (const ability of ABILITIES) {
    for (const model of SUPPORTED_MODELS) {
      const count = manifest.candidates.filter((candidate: any) => candidate.set === "warden.v2.model-comparison" && candidate.model === model && candidate.ability === ability.id).length;
      assert(count >= 2 && count <= 3, `${model} has ${count} ${ability.id} v2 candidates`);
    }
    const current = manifest.candidates.filter((candidate: any) => candidate.set === CURRENT_SET.id && candidate.ability === ability.id).length;
    assert.equal(current, 3, `the current set has ${current} ${ability.id} candidates`);
  }
  const briefIds = new Set(ABILITIES.map((ability) => ability.id));
  for (const candidate of manifest.candidates) {
    assert(briefIds.has(candidate.ability), `${candidate.id} must belong to one of the four Warden briefs`);
  }
  // Approval exists only in an approved-png-v1 export (Atlas 4.1.3), never in this manifest.
  for (const entry of collectKeysAndStrings(manifest)) assert.doesNotMatch(entry, /approv/i);
});

test("candidate bytes: LFS-tracked PNGs that re-hash to the manifest; manifest stays plain JSON", async () => {
  const manifest = await readJson(path.join(REVIEW_DIR, "candidates.json"));
  for (const plain of ["candidates.json", "briefs.json", "briefs.v2.json", "briefs.v3.json", ...Object.values(MODEL_WORKFLOWS).map((entry) => entry.file)]) {
    assert.notEqual(gitAttribute(`${REVIEW}/${plain}`, "filter"), "lfs", `${plain} must stay reviewable plain JSON`);
  }
  let hydrated = 0;
  for (const candidate of manifest.candidates) {
    const relative = `${REVIEW}/${candidate.path}`;
    assert.equal(gitAttribute(relative, "filter"), "lfs", `${relative} must be Git LFS-tracked`);
    const bytes = await readFile(path.join(REVIEW_DIR, ...candidate.path.split("/")));
    const pointer = lfsPointer(bytes);
    if (pointer) {
      // Unhydrated checkout (ordinary Validate job): the pointer must at least name the pinned object.
      assert.deepEqual(pointer, { sha256: candidate.sha256, byteLength: candidate.byteLength }, relative);
      continue;
    }
    hydrated += 1;
    assert.equal(bytes.length, candidate.byteLength, relative);
    assert.equal(sha256Bytes(bytes), candidate.sha256, relative);
    assert.deepEqual(pngSize(bytes), { width: candidate.width, height: candidate.height }, relative);
  }
  if (process.env.ASSET_TOOLING_REQUIRE_REVIEW_LFS === "1") {
    assert.equal(hydrated, manifest.candidates.length, "every review candidate must be hydrated");
  }
});

test("no generic SVG, catalog or reference image is presented as a candidate", async () => {
  const manifest = await readJson(path.join(REVIEW_DIR, "candidates.json"));
  const files = await readdir(path.join(REVIEW_DIR, "candidates"));
  assert.deepEqual(
    files.filter((file) => !file.endsWith(".png")),
    [],
    "the candidates folder holds only generated PNG candidates",
  );
  assert.deepEqual(
    [...files].sort(),
    manifest.candidates.map((candidate: any) => candidate.path.slice("candidates/".length)).sort(),
    "every candidate file is listed in the manifest and vice versa",
  );
  const sources = await readJson(path.join(ROOT, "catalog", "sources.json"));
  const catalogHashes = new Set(sources.sources.map((source: any) => source.source?.sha256).filter(Boolean));
  for (const candidate of manifest.candidates) {
    assert(!catalogHashes.has(candidate.sha256), `${candidate.id} reuses a catalog/reference image`);
  }
});

test("rules: AGENTS.md names the review folder; canonical storage and catalog stay unaffected", async () => {
  const agents = await readFile(path.join(ROOT, "AGENTS.md"), "utf8");
  assert.match(agents, /review\/(?:warden-icons\/?|\*\*)?/, "AGENTS.md must name the review/ LFS exception");
  const storage = await readJson(path.join(ROOT, "catalog", "storage.json"));
  assert(storage.entries.every((entry: any) => !String(entry.path).startsWith("review/")));
  const sources = await readJson(path.join(ROOT, "catalog", "sources.json"));
  assert(sources.sources.every((source: any) => !String(source.id).startsWith("warden.")));
  const check = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-catalog-storage.ts")], {
    cwd: ROOT, encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
});

test("Pages workflow hydrates only review/ and requires the built Warden review page", async () => {
  const workflow = await readFile(path.join(ROOT, ".github", "workflows", "pages.yml"), "utf8");
  assert.match(workflow, /lfs: false/, "the checkout itself stays unhydrated");
  assert.match(workflow, /git lfs pull[^\n]*--include[= ]["']?review\//, "Pages must hydrate only review/");
  assert.doesNotMatch(workflow, /git lfs pull[^\n]*assets\/canonical/);
  assert.match(workflow, /- "review\/\*\*"/, "review/** changes must trigger Pages");
  assert.match(workflow, /test -s dist\/pages\/review\/warden-icons\/index\.html/);
});

// =========================== Pages review build ===========================

test("gallery index links the Warden review page and adds no Warden recipe or catalog entry", () => {
  const model = extendCatalogGalleryModel({ schemaVersion: 1, assets: [], providers: [] });
  const html = renderCatalogGalleryHtml(model);
  assert.match(html, /href="(?:\.\/)?review\/warden-icons\/(?:index\.html)?"/);
  // Existing gallery entries are untouched: candidates are not recipes or catalog sources.
  assert(createGeneratedGalleryAssets().every((asset) => !asset.id.startsWith("warden.") && asset.state === "recipe"));
});

test("review loader validates the manifest and fails closed", async () => {
  const { loadWardenCandidateReview } = await reviewModule();
  await withFixture(async ({ review, manifest }) => {
    const loaded = await loadWardenCandidateReview(review);
    assert.equal(loaded.candidates.length, manifest.candidates.length);
    assert(loaded.candidates.every((candidate: any) => candidate.state === "candidate"));
  });
  const cases: Array<[string, (review: string, manifest: any) => Promise<void>, RegExp]> = [
    ["altered bytes", async (review, manifest) => {
      const file = path.join(review, manifest.candidates[0].path);
      const bytes = await readFile(file);
      bytes[bytes.length - 20] ^= 0xff;
      await writeFile(file, bytes);
    }, /sha-?256|hash|byte/i],
    ["missing file", async (review, manifest) => {
      await rm(path.join(review, manifest.candidates[1].path));
    }, /missing|ENOENT|not found/i],
    ["unhydrated LFS pointer", async (review, manifest) => {
      const candidate = manifest.candidates[2];
      await writeFile(path.join(review, candidate.path),
        `${LFS_POINTER_PREFIX}\noid sha256:${candidate.sha256}\nsize ${candidate.byteLength}\n`);
    }, /lfs|pointer|hydrat/i],
    ["approved state", async (review, manifest) => {
      manifest.candidates[0].state = "approved";
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest));
    }, /state|candidate/i],
    ["empty candidate list", async (review, manifest) => {
      manifest.candidates = [];
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest));
    }, /empty|at least|candidates/i],
    ["unknown ability", async (review, manifest) => {
      manifest.candidates[0].ability = "warden.ability.5";
      manifest.candidates[0].id = "warden.ability.5.candidate.01";
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest));
    }, /ability|brief/i],
    ["SVG presented as candidate", async (review, manifest) => {
      manifest.candidates[0].path = "candidates/generic.svg";
      manifest.candidates[0].mediaType = "image/svg+xml";
      await writeFile(path.join(review, "candidates", "generic.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest));
    }, /png|svg|media/i],
    ["stale workflow hash", async (review) => {
      await writeFile(path.join(review, WORKFLOW_FILE), "{\"1\":{\"class_type\":\"SaveImage\",\"inputs\":{}}}");
    }, /workflow|sha-?256|hash/i],
    ["stale briefs hash", async (review) => {
      const briefs = await readJson(path.join(review, "briefs.json"));
      briefs.style.version = 2;
      await writeFile(path.join(review, "briefs.json"), JSON.stringify(briefs));
    }, /brief|sha-?256|hash/i],
    ["unknown set", async (review, manifest) => {
      manifest.candidates[0].set = "warden.v9.missing";
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest));
    }, /set/i],
    ["superseded set without a successor", async (review, manifest) => {
      manifest.sets.push({ id: "warden.v0.old", label: "Old", status: "superseded" });
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest));
    }, /supersededBy|superseded/i],
    ["no current set", async (review, manifest) => {
      manifest.sets[0].status = "superseded";
      manifest.sets[0].supersededBy = "warden.v1.fixture";
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest));
    }, /set/i],
    ["unknown model", async (review, manifest) => {
      manifest.candidates[0].model = "sd99";
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest));
    }, /model/i],
    ["checkpoint provenance differs from the model pin", async (review, manifest) => {
      manifest.candidates[0].provenance.checkpoint.sha256 = "0".repeat(64);
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest));
    }, /checkpoint|pinned/i],
    ["unpinned text encoder in provenance", async (review, manifest) => {
      manifest.candidates[0].provenance.textEncoder = { ...FIXTURE_CHECKPOINT, name: "te.safetensors" };
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest));
    }, /textEncoder|pinned/i],
    ["escaping path", async (review, manifest) => {
      manifest.candidates[0].path = "../outside.png";
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest));
    }, /path/i],
  ];
  for (const [label, mutate, error] of cases) {
    await withFixture(async ({ review, manifest }) => {
      await mutate(review, manifest);
      await assert.rejects(loadWardenCandidateReview(review), error, label);
    });
  }
});

if (hasFfmpeg()) {
  test("review page shows every candidate at 512 and true 64/48/32 px, labelled candidate with provenance", async () => {
    const { buildWardenReviewPage } = await reviewModule();
    await withFixture(async ({ root, review, output, manifest }) => {
      const result = await buildWardenReviewPage({ root, reviewDirectory: review, outputDirectory: output });
      assert.equal(result.page, "index.html");
      const html = await readFile(path.join(output, "index.html"), "utf8");
      assert.deepEqual(
        result.candidates.map((candidate: any) => candidate.id).sort(),
        manifest.candidates.map((candidate: any) => candidate.id).sort(),
      );
      for (const candidate of manifest.candidates) {
        const ability = ABILITIES.find((entry) => entry.id === candidate.ability)!;
        assert(html.includes(ability.name), `page names ${ability.name}`);
      }

      for (const entry of result.candidates) {
        const candidate = manifest.candidates.find((item: any) => item.id === entry.id);
        assert.equal(entry.ability, candidate.ability);
        assert(html.includes(candidate.id), `page lists ${candidate.id}`);
        // Provenance shown next to the actual image.
        assert(html.includes(candidate.sha256), `page shows ${candidate.id} sha256`);
        assert(html.includes(String(candidate.provenance.seed)), `page shows ${candidate.id} seed`);
        assert(html.includes(candidate.provenance.checkpoint.name), `page shows ${candidate.id} checkpoint`);
        assert(html.includes(candidate.provenance.workflow.sha256), `page shows ${candidate.id} workflow hash`);

        assert.deepEqual(entry.images.map((image: any) => image.size).sort((a: number, b: number) => b - a), REVIEW_SIZES);
        for (const image of entry.images) {
          assert.match(image.url, /^[a-z0-9][a-z0-9._/-]*\.png$/, "relative PNG URL inside the review page");
          const bytes = await readFile(path.join(output, ...image.url.split("/")));
          // True pixel size, not a CSS-scaled 512 master.
          assert.deepEqual(pngSize(bytes), { width: image.size, height: image.size }, image.url);
          if (image.size === 512 && candidate.width === 512) {
            assert.equal(sha256Bytes(bytes), candidate.sha256, "the 512 view is the exact candidate bytes");
          }
          const tag = new RegExp(`<img[^>]*src="${image.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`);
          const match = tag.exec(html);
          assert(match, `page shows ${image.url}`);
          assert.match(match[0], new RegExp(`width="${image.size}"`));
          assert.match(match[0], new RegExp(`height="${image.size}"`));
        }
      }
      assert.match(html, /\bcandidates?\b/i, "images are labelled as candidates");
      assert.doesNotMatch(withoutNegatedApproval(html), /\bapproved\b/i, "the review page never claims approval");
      assert.doesNotMatch(html, /<svg[^>]*class="[^"]*\bicon-placeholder/i);
    });
  });

  test("review page shows the current set first, collapses superseded sets and derives the 512 px view of a 1024 px master", async () => {
    const { buildWardenReviewPage } = await reviewModule();
    await withFixture(async ({ root, review, output, manifest }) => {
      const bytes = encodePng(1024, (x, y) => (Math.abs(x - 512) + Math.abs(y - 512) < 300 ? [230, 200, 60, 255] : [16, 18, 24, 255]));
      const file = "candidates/warden.ability.1.candidate.fixture-new-01.png";
      await writeFile(path.join(review, ...file.split("/")), bytes);
      const base = manifest.candidates[0];
      manifest.models.unshift({
        id: "fixture-new",
        label: "Fixture New Model",
        status: "supported",
        workflow: WORKFLOW_FILE,
        files: { diffusionModel: { ...FIXTURE_CHECKPOINT, name: "fixture-new.safetensors" } },
      });
      manifest.sets.unshift({ id: "warden.v2.fixture-new", label: "Fixture tight set", status: "current" });
      Object.assign(manifest.sets[1], { status: "superseded", supersededBy: "warden.v2.fixture-new" });
      manifest.candidates.push({
        ...base,
        id: "warden.ability.1.candidate.fixture-new-01",
        model: "fixture-new",
        set: "warden.v2.fixture-new",
        path: file,
        sha256: sha256Bytes(bytes),
        byteLength: bytes.length,
        width: 1024,
        height: 1024,
        provenance: { ...base.provenance, checkpoint: { ...FIXTURE_CHECKPOINT, name: "fixture-new.safetensors" }, seed: 7 },
      });
      await writeFile(path.join(review, "candidates.json"), JSON.stringify(manifest, null, 2) + "\n");
      const result = await buildWardenReviewPage({ root, reviewDirectory: review, outputDirectory: output });
      const entry = result.candidates.find((candidate: any) => candidate.id === "warden.ability.1.candidate.fixture-new-01");
      assert.equal(entry.model, "fixture-new");
      assert.equal(sha256Bytes(await readFile(path.join(output, ...entry.master.split("/")))), sha256Bytes(bytes), "the master link is the exact bytes");
      const view = await readFile(path.join(output, ...entry.images.find((image: any) => image.size === 512).url.split("/")));
      assert.deepEqual(pngSize(view), { width: 512, height: 512 });
      const html = await readFile(path.join(output, "index.html"), "utf8");
      assert(html.indexOf("Fixture New Model") < html.indexOf("Fixture SD 1.5"), "supported models come before deprecated ones");
      assert.match(html, /deprecated/);
      // Atlas 4.1.5: the current set leads each ability; superseded sets are collapsed history.
      const section = html.slice(html.indexOf('id="warden.ability.1-heading"'));
      const current = section.indexOf('class="set is-current"');
      const superseded = section.indexOf('<details class="set is-superseded">');
      assert(current >= 0 && superseded > current, "the current set comes first and the superseded set is collapsed");
      assert(section.indexOf(entry.images.find((image: any) => image.size === 32).url) < superseded, "the current set has its 32 px strip");
      assert(section.indexOf("warden.ability.1.candidate.01") > superseded, "older candidates sit in the collapsed set");
      assert.match(section.slice(superseded), /<details class="set is-superseded">[\s\S]*?<\/details>/);
      assert(html.includes(entry.master));
    });
  });

  test("review page build refuses altered bytes without publishing a partial page", async () => {
    const { buildWardenReviewPage } = await reviewModule();
    await withFixture(async ({ root, review, output, manifest }) => {
      const file = path.join(review, manifest.candidates[2].path);
      const bytes = await readFile(file);
      bytes[bytes.length - 20] ^= 0xff;
      await writeFile(file, bytes);
      await assert.rejects(buildWardenReviewPage({ root, reviewDirectory: review, outputDirectory: output }), /sha-?256|hash|byte/i);
      assert.equal(existsSync(path.join(output, "index.html")), false);
    });
  });
}
