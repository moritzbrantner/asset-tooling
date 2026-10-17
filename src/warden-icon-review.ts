/**
 * Warden ability-icon candidate review (asset-tooling#211).
 *
 * Generated review candidates live in the Git LFS review namespace `review/warden-icons/`
 * (owner decision on #211, 2026-10-17), outside `assets/canonical/` and the catalog. A plain-JSON
 * manifest pins every brief version, every image model (its hash-pinned files, licences and
 * supported/deprecated status, Atlas 4.1.4), every candidate set (current or superseded, Atlas
 * 4.1.5) and every candidate's bytes and ComfyUI provenance. This module re-verifies that folder
 * fail closed and renders a static review page that shows the current set of each ability first,
 * at 512 px and true 64/48/32 px, with superseded sets collapsed and grouped by model.
 *
 * Candidates are never approved here. Approval is the exact sha256 named in a bundle export
 * selection (Decision Atlas 4.1.3); this page only supports comparing candidates.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";

import { storeAssetObject } from "./asset-store.js";
import { sha256Bytes } from "./hash.js";

export const WARDEN_ABILITIES = [
  { id: "warden.ability.1", abilityId: 1, name: "Heroic Strike" },
  { id: "warden.ability.2", abilityId: 2, name: "Shield Bash" },
  { id: "warden.ability.3", abilityId: 3, name: "Rallying Cry" },
  { id: "warden.ability.4", abilityId: 4, name: "Cleave" },
] as const;

export const WARDEN_REVIEW_SIZES = [512, 64, 48, 32] as const;
/** The largest review view; a candidate master is this size or the 1024 px output of newer models. */
const MASTER_SIZE = 512;
const MASTER_SIZES = new Set([512, 1024]);
const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;
const MODEL_STATUSES = new Set(["supported", "deprecated"]);
const MODEL_FILE_ROLES = ["checkpoint", "diffusionModel", "textEncoder", "vae"] as const;
const SET_ID = /^warden\.v[0-9]+\.[a-z0-9-]+$/;
const SET_STATUSES = new Set(["current", "superseded"]);
const SHA256 = /^[0-9a-f]{64}$/;
const CANDIDATE_ID = /^warden\.ability\.[1-4]\.candidate\.[a-z0-9-]+$/;
const CANDIDATE_PATH = /^candidates\/[a-z0-9][a-z0-9._-]*\.png$/;
const JSON_FILE = /^[a-z0-9][a-z0-9._-]*\.json$/;
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface WardenStyleBrief {
  id: string;
  version: number;
  description: string;
  prompt: string;
  /** Only for models that honour negative prompts; style v2 states its exclusions in `prompt`. */
  negativePrompt?: string;
}

export interface WardenAbilityBrief {
  id: string;
  abilityId: number;
  name: string;
  version: number;
  subject: string;
  prompt: string;
}

export interface WardenBriefs {
  schemaVersion: 1;
  style: WardenStyleBrief;
  abilities: WardenAbilityBrief[];
}

export interface WardenModelFile {
  name: string;
  sha256: string;
  byteLength: number;
  license: string;
  [key: string]: unknown;
}

export interface WardenImageModel {
  id: string;
  label: string;
  status: "supported" | "deprecated";
  workflow: string;
  /** `checkpoint` (single file) or `diffusionModel` is the file the operation hashes and injects. */
  files: Partial<Record<(typeof MODEL_FILE_ROLES)[number], WardenModelFile>>;
  [key: string]: unknown;
}

/** A generation round for this icon set; superseded sets stay as history (Atlas 4.1.5). */
export interface WardenCandidateSet {
  id: string;
  label: string;
  status: "current" | "superseded";
  /** For a superseded set: the set that replaced it. */
  supersededBy?: string;
  [key: string]: unknown;
}

export interface WardenCandidateProvenance {
  provider: "comfyui";
  operation: "image.comfyui.generate@1";
  workflow: { path: string; sha256: string };
  checkpoint: { name: string; sha256: string; byteLength: number; license: string };
  textEncoder?: { name: string; sha256: string; byteLength: number; license: string };
  vae?: { name: string; sha256: string; byteLength: number; license: string };
  seed: number;
  positivePrompt: string;
  negativePrompt?: string;
  [key: string]: unknown;
}

export interface WardenCandidateEntry {
  id: string;
  ability: string;
  model: string;
  set: string;
  briefs: string;
  state: "candidate";
  path: string;
  mediaType: "image/png";
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
  provenance: WardenCandidateProvenance;
}

export interface WardenCandidateManifest {
  schemaVersion: 3;
  briefs: { path: string; sha256: string }[];
  models: WardenImageModel[];
  sets: WardenCandidateSet[];
  candidates: WardenCandidateEntry[];
}

export interface WardenCandidate extends WardenCandidateEntry {
  abilityBrief: WardenAbilityBrief;
  styleBrief: WardenStyleBrief;
  imageModel: WardenImageModel;
  candidateSet: WardenCandidateSet;
  bytes: Buffer;
}

export interface WardenCandidateReview {
  /** Brief versions by file name (for example `briefs.json`, `briefs.v2.json`). */
  briefs: Map<string, WardenBriefs>;
  models: WardenImageModel[];
  /** Current sets first, then superseded ones, each in manifest order. */
  sets: WardenCandidateSet[];
  manifest: WardenCandidateManifest;
  candidates: WardenCandidate[];
}

export interface WardenReviewImage {
  size: number;
  url: string;
}

export interface WardenReviewPageResult {
  page: "index.html";
  /** `master` is the URL of the exact candidate bytes when the master is larger than 512 px. */
  candidates: { id: string; ability: string; model: string; set: string; images: WardenReviewImage[]; master?: string }[];
  /** The committed approved-png-v1 export, when the review folder has one; images are its exact bytes. */
  approved?: { manifestSha256: string; images: { key: string; variant: string; sha256: string; url: string }[] };
}

/** The verified committed export as the page renders it (see src/warden-icon-export.ts). */
interface ApprovedSetView {
  manifestRef: { sha256: string; byteLength: number };
  selection: { bundle: string; ownerSelection: { date: string; issue: string; message: string }; license: { attribution: string } };
  images: { key: string; name: string; candidate: string; variant: string; sha256: string; width: number; bytes: Buffer }[];
}

// ─── Validation helpers ─────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location} must be an object`);
  return value;
}

function text(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} must be a non-empty string`);
  return value;
}

function version(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${location} must be a positive integer version`);
  }
  return value;
}

function sha256(value: unknown, location: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${location} must be a lowercase sha256`);
  return value;
}

function positiveInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${location} must be a positive integer`);
  }
  return value;
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/** Read a regular file inside `directory`; `relative` is a validated `/`-separated path. */
async function readReviewFile(directory: string, relative: string, location: string): Promise<Buffer> {
  const resolved = path.resolve(directory, ...relative.split("/"));
  const inside = path.relative(directory, resolved);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error(`${location} path '${relative}' escapes the review folder`);
  }
  let stats;
  try {
    stats = await lstat(resolved);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error(`${location} file '${relative}' is missing`);
    throw error;
  }
  if (!stats.isFile()) throw new Error(`${location} path '${relative}' must be a regular file`);
  return readFile(resolved);
}

function parseJson(bytes: Buffer, location: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${location} must be valid UTF-8 JSON`);
  }
}

function parseBriefs(value: unknown): WardenBriefs {
  const briefs = record(value, "Warden briefs");
  if (briefs.schemaVersion !== 1) throw new Error("Warden briefs schemaVersion must be 1");
  const styleValue = record(briefs.style, "Warden briefs style");
  const style: WardenStyleBrief = {
    id: text(styleValue.id, "Warden style brief id"),
    version: version(styleValue.version, "Warden style brief version"),
    description: text(styleValue.description, "Warden style brief description"),
    prompt: text(styleValue.prompt, "Warden style brief prompt"),
  };
  if (styleValue.negativePrompt !== undefined) {
    style.negativePrompt = text(styleValue.negativePrompt, "Warden style brief negativePrompt");
  }
  if (!/^warden\.style(?:\.[a-z0-9-]+)*$/.test(style.id)) throw new Error("Warden style brief id must start with warden.style");
  const abilityValues: unknown = briefs.abilities;
  if (!Array.isArray(abilityValues) || abilityValues.length !== WARDEN_ABILITIES.length) {
    throw new Error(`Warden briefs must declare exactly ${WARDEN_ABILITIES.length} ability briefs`);
  }
  const abilities = WARDEN_ABILITIES.map((expected, index) => {
    const entry = record(abilityValues[index], `Warden ability brief ${index + 1}`);
    if (entry.id !== expected.id || entry.abilityId !== expected.abilityId || entry.name !== expected.name) {
      throw new Error(`Warden ability brief ${index + 1} must be ${expected.id} (${expected.abilityId}, ${expected.name})`);
    }
    return {
      id: expected.id,
      abilityId: expected.abilityId,
      name: expected.name,
      version: version(entry.version, `${expected.id} brief version`),
      subject: text(entry.subject, `${expected.id} brief subject`),
      prompt: text(entry.prompt, `${expected.id} brief prompt`),
    } satisfies WardenAbilityBrief;
  });
  if (new Set(abilities.map((ability) => ability.prompt)).size !== abilities.length) {
    throw new Error("Warden ability brief prompts must be distinct");
  }
  return { schemaVersion: 1, style, abilities };
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function mentionsApproval(value: unknown): boolean {
  if (typeof value === "string") return /approv/i.test(value);
  if (Array.isArray(value)) return value.some(mentionsApproval);
  if (isRecord(value)) return Object.entries(value).some(([key, item]) => /approv/i.test(key) || mentionsApproval(item));
  return false;
}

// ─── Loader ─────────────────────────────────────────────────────────────────────────────────────

function parseModelFile(value: unknown, location: string): WardenModelFile {
  const file = record(value, location);
  const name = text(file.name, `${location} name`);
  if (!name.endsWith(".safetensors")) throw new Error(`${location} must be a .safetensors file`);
  sha256(file.sha256, `${location} sha256`);
  positiveInteger(file.byteLength, `${location} byteLength`);
  text(file.license, `${location} license`);
  return file as WardenModelFile;
}

function parseModel(value: unknown, index: number): WardenImageModel {
  const model = record(value, `model ${index}`);
  const id = text(model.id, `model ${index} id`);
  if (!MODEL_ID.test(id)) throw new Error(`model id '${id}' must be lowercase letters, digits, '.' or '-'`);
  text(model.label, `model ${id} label`);
  if (typeof model.status !== "string" || !MODEL_STATUSES.has(model.status)) {
    throw new Error(`model ${id} status must be "supported" or "deprecated", not ${JSON.stringify(model.status)}`);
  }
  if (typeof model.workflow !== "string" || !JSON_FILE.test(model.workflow)) {
    throw new Error(`model ${id} workflow must be a JSON file in the review folder`);
  }
  const files = record(model.files, `model ${id} files`);
  for (const role of Object.keys(files)) {
    if (!(MODEL_FILE_ROLES as readonly string[]).includes(role)) throw new Error(`model ${id} file role '${role}' is unknown`);
    parseModelFile(files[role], `model ${id} ${role}`);
  }
  if ((files.checkpoint === undefined) === (files.diffusionModel === undefined)) {
    throw new Error(`model ${id} must pin exactly one of checkpoint or diffusionModel`);
  }
  return model as WardenImageModel;
}

function parseSets(value: unknown): WardenCandidateSet[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("candidates manifest sets must list at least one candidate set");
  const sets = value.map((item, index) => {
    const set = record(item, `set ${index}`);
    const id = text(set.id, `set ${index} id`);
    if (!SET_ID.test(id)) throw new Error(`set id '${id}' must look like warden.v<n>.<name>`);
    text(set.label, `set ${id} label`);
    if (typeof set.status !== "string" || !SET_STATUSES.has(set.status)) {
      throw new Error(`set ${id} status must be "current" or "superseded", not ${JSON.stringify(set.status)}`);
    }
    if ((set.status === "superseded") !== (set.supersededBy !== undefined)) {
      throw new Error(`set ${id} must name supersededBy exactly when it is superseded`);
    }
    return set as WardenCandidateSet;
  });
  const ids = new Set(sets.map((set) => set.id));
  if (ids.size !== sets.length) throw new Error("candidates manifest lists a set id twice");
  for (const set of sets) {
    if (set.supersededBy !== undefined && (set.supersededBy === set.id || !ids.has(set.supersededBy))) {
      throw new Error(`set ${set.id} supersededBy ${JSON.stringify(set.supersededBy)} is not another listed set`);
    }
  }
  if (!sets.some((set) => set.status === "current")) throw new Error("candidates manifest needs a current set");
  return [...sets.filter((set) => set.status === "current"), ...sets.filter((set) => set.status === "superseded")];
}

function sameFile(actual: unknown, pinned: WardenModelFile, location: string): void {
  const file = record(actual, location);
  if (file.name !== pinned.name || file.sha256 !== pinned.sha256 || file.byteLength !== pinned.byteLength || file.license !== pinned.license) {
    throw new Error(`${location} does not match the model's pinned ${pinned.name} (sha256 ${pinned.sha256}, ${pinned.byteLength} bytes, ${pinned.license})`);
  }
}

/**
 * Load and re-verify a Warden candidate review folder. Rejects (and so fails any Pages build) on a
 * stale briefs or workflow hash, a missing, unhydrated (Git LFS pointer) or altered candidate, a
 * non-PNG or wrongly sized candidate, a state other than `candidate`, a path escaping the folder,
 * an empty candidate list, an ability outside the four briefs, an unknown model, provenance that
 * does not match its model's pinned files or workflow, or a candidate file the manifest does not
 * list. An ability may have no candidates yet.
 */
export async function loadWardenCandidateReview(reviewDirectory: string): Promise<WardenCandidateReview> {
  if (typeof reviewDirectory !== "string" || !reviewDirectory) throw new Error("reviewDirectory must be a path");
  const directory = path.resolve(reviewDirectory);
  const manifestValue = record(parseJson(await readReviewFile(directory, "candidates.json", "candidates manifest"), "candidates.json"), "candidates manifest");
  if (manifestValue.schemaVersion !== 3) throw new Error("candidates manifest schemaVersion must be 3");

  // Every brief version a candidate was generated from stays pinned (style v1 for SD 1.5, v2 since).
  if (!Array.isArray(manifestValue.briefs) || manifestValue.briefs.length === 0) {
    throw new Error("candidates manifest briefs must list at least one pinned briefs file");
  }
  const briefs = new Map<string, WardenBriefs>();
  for (const [index, value] of manifestValue.briefs.entries()) {
    const briefsRef = record(value, `candidates manifest briefs ${index}`);
    if (typeof briefsRef.path !== "string" || !/^briefs(?:\.v[0-9]+)?\.json$/.test(briefsRef.path)) {
      throw new Error(`candidates manifest briefs ${index} path must be briefs.json or briefs.v<n>.json`);
    }
    if (briefs.has(briefsRef.path)) throw new Error(`candidates manifest pins ${briefsRef.path} twice`);
    const briefsSha = sha256(briefsRef.sha256, `candidates manifest ${briefsRef.path} sha256`);
    const briefBytes = await readReviewFile(directory, briefsRef.path, "briefs");
    if (sha256Bytes(briefBytes) !== briefsSha) {
      throw new Error(`${briefsRef.path} sha256 ${sha256Bytes(briefBytes)} does not match the manifest's pinned briefs sha256 ${briefsSha}`);
    }
    briefs.set(briefsRef.path, parseBriefs(parseJson(briefBytes, briefsRef.path)));
  }

  if (!Array.isArray(manifestValue.models) || manifestValue.models.length === 0) {
    throw new Error("candidates manifest models must list at least one image model");
  }
  const models = manifestValue.models.map(parseModel);
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error("candidates manifest lists a model id twice");
  const sets = parseSets(manifestValue.sets);

  // Owner decision on #211 (2026-10-17): candidates exist only for some abilities so far; the
  // manifest lists exactly the candidates that exist, but never none at all.
  if (!Array.isArray(manifestValue.candidates) || manifestValue.candidates.length === 0) {
    throw new Error("candidates manifest must list at least one candidate (the candidate list is empty)");
  }
  const workflowHashes = new Map<string, string>();
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const candidates: WardenCandidate[] = [];
  for (const [index, value] of manifestValue.candidates.entries()) {
    const entry = record(value, `candidate ${index}`);
    const id = text(entry.id, `candidate ${index} id`);
    const briefSet = typeof entry.briefs === "string" ? briefs.get(entry.briefs) : undefined;
    if (!briefSet) throw new Error(`candidate ${id} briefs ${JSON.stringify(entry.briefs)} is not a pinned briefs file`);
    const abilityBrief = briefSet.abilities.find((ability) => ability.id === entry.ability);
    if (!abilityBrief) {
      throw new Error(`candidate ${id} ability ${JSON.stringify(entry.ability)} is not one of the four Warden ability briefs`);
    }
    const imageModel = models.find((model) => model.id === entry.model);
    if (!imageModel) throw new Error(`candidate ${id} model ${JSON.stringify(entry.model)} is not a listed image model`);
    const candidateSet = sets.find((set) => set.id === entry.set);
    if (!candidateSet) throw new Error(`candidate ${id} set ${JSON.stringify(entry.set)} is not a listed candidate set`);
    if (!CANDIDATE_ID.test(id)) throw new Error(`candidate id '${id}' must look like warden.ability.<n>.candidate.<name>`);
    if (ids.has(id)) throw new Error(`duplicate candidate id ${id}`);
    ids.add(id);
    if (typeof entry.path !== "string" || !CANDIDATE_PATH.test(entry.path)) {
      throw new Error(`candidate ${id} path ${JSON.stringify(entry.path)} must be candidates/<name>.png inside the review folder`);
    }
    if (entry.mediaType !== "image/png") throw new Error(`candidate ${id} mediaType must be image/png, not ${JSON.stringify(entry.mediaType)}`);
    if (entry.state !== "candidate") throw new Error(`candidate ${id} state must be "candidate", not ${JSON.stringify(entry.state)}`);
    if (!id.startsWith(abilityBrief.id + ".")) {
      throw new Error(`candidate ${id} must belong to its declared ability ${JSON.stringify(entry.ability)}`);
    }
    const candidateSha = sha256(entry.sha256, `candidate ${id} sha256`);
    if (hashes.has(candidateSha)) throw new Error(`candidate ${id} duplicates another candidate's bytes`);
    hashes.add(candidateSha);
    const byteLength = positiveInteger(entry.byteLength, `candidate ${id} byteLength`);
    if (entry.width !== entry.height || typeof entry.width !== "number" || !MASTER_SIZES.has(entry.width)) {
      throw new Error(`candidate ${id} must be a square ${[...MASTER_SIZES].join(" or ")} px master`);
    }
    const masterSize = entry.width;

    const provenanceValue = record(entry.provenance, `candidate ${id} provenance`);
    if (provenanceValue.provider !== "comfyui" || provenanceValue.operation !== "image.comfyui.generate@1") {
      throw new Error(`candidate ${id} provenance must name provider comfyui and operation image.comfyui.generate@1`);
    }
    const workflow = record(provenanceValue.workflow, `candidate ${id} provenance.workflow`);
    if (workflow.path !== imageModel.workflow) {
      throw new Error(`candidate ${id} workflow ${JSON.stringify(workflow.path)} is not model ${imageModel.id}'s workflow ${imageModel.workflow}`);
    }
    const workflowSha = sha256(workflow.sha256, `candidate ${id} workflow sha256`);
    let actualWorkflowSha = workflowHashes.get(imageModel.workflow);
    if (actualWorkflowSha === undefined) {
      actualWorkflowSha = sha256Bytes(await readReviewFile(directory, imageModel.workflow, `candidate ${id} workflow`));
      workflowHashes.set(imageModel.workflow, actualWorkflowSha);
    }
    if (actualWorkflowSha !== workflowSha) {
      throw new Error(`candidate ${id} workflow ${imageModel.workflow} sha256 ${actualWorkflowSha} does not match the pinned ${workflowSha}`);
    }
    // The operation hashes and injects the checkpoint (or diffusion model); the text encoder and VAE
    // are workflow literals whose pinned identities the candidate must also carry.
    sameFile(provenanceValue.checkpoint, (imageModel.files.checkpoint ?? imageModel.files.diffusionModel)!, `candidate ${id} provenance.checkpoint`);
    for (const role of ["textEncoder", "vae"] as const) {
      const pinned = imageModel.files[role];
      if (pinned) sameFile(provenanceValue[role], pinned, `candidate ${id} provenance.${role}`);
      else if (provenanceValue[role] !== undefined) throw new Error(`candidate ${id} provenance.${role} is not pinned by model ${imageModel.id}`);
    }
    const seed = provenanceValue.seed;
    if (typeof seed !== "number" || !Number.isSafeInteger(seed) || seed < 0) throw new Error(`candidate ${id} provenance needs its seed`);
    const positivePrompt = text(provenanceValue.positivePrompt, `candidate ${id} positivePrompt`);
    if (!positivePrompt.includes(briefSet.style.prompt) || !positivePrompt.includes(abilityBrief.prompt)) {
      throw new Error(`candidate ${id} positivePrompt must be built from the style brief and the ${abilityBrief.id} brief`);
    }

    const bytes = await readReviewFile(directory, entry.path, `candidate ${id}`);
    if (bytes.toString("utf8", 0, LFS_POINTER_PREFIX.length) === LFS_POINTER_PREFIX) {
      throw new Error(`candidate ${id} file ${entry.path} is an unhydrated Git LFS pointer; run git lfs pull --include="review/**"`);
    }
    const actualSha = sha256Bytes(bytes);
    if (bytes.length !== byteLength || actualSha !== candidateSha) {
      throw new Error(`candidate ${id} bytes do not match the manifest (sha256 ${actualSha}, ${bytes.length} bytes; pinned ${candidateSha}, ${byteLength} bytes)`);
    }
    const dimensions = pngDimensions(bytes);
    if (!dimensions) throw new Error(`candidate ${id} is not a PNG`);
    if (dimensions.width !== masterSize || dimensions.height !== masterSize) {
      throw new Error(`candidate ${id} PNG is ${dimensions.width}x${dimensions.height}, expected ${masterSize}x${masterSize}`);
    }
    candidates.push({ ...(entry as unknown as WardenCandidateEntry), abilityBrief, styleBrief: briefSet.style, imageModel, candidateSet, bytes });
  }

  // Candidates are never approved in the manifest (Atlas 4.1.3): approval exists only in an export.
  if (mentionsApproval(manifestValue)) throw new Error("candidates manifest must not mention approval; every entry stays a candidate");

  // No stand-ins: the candidates folder holds exactly the listed PNGs.
  const listed = new Set(candidates.map((candidate) => candidate.path.slice("candidates/".length)));
  for (const file of await readdir(path.join(directory, "candidates"))) {
    if (!listed.has(file)) throw new Error(`candidates/${file} is not listed in the candidates manifest`);
  }

  return { briefs, models, sets, manifest: manifestValue as unknown as WardenCandidateManifest, candidates };
}

// ─── Derived sizes ──────────────────────────────────────────────────────────────────────────────

function ffmpegVersion(executable: string): string {
  const result = spawnSync(executable, ["-version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Warden review needs FFmpeg to derive small views: '${executable} -version' failed${result.error ? `: ${result.error.message}` : ""}`);
  }
  return result.stdout.split(/\r?\n/, 1)[0]!.trim();
}

/**
 * Derive every smaller view of one master in a single FFmpeg run with area-averaging downscales,
 * so 64/48/32 px (and, for a 1024 px master, 512 px) views are true pixel sizes rather than
 * CSS-scaled masters. A 512 px master is its own 512 px view.
 */
async function derivePngs(root: string, executable: string, candidate: WardenCandidate): Promise<Map<number, Buffer>> {
  const sizes = WARDEN_REVIEW_SIZES.filter((size) => size !== candidate.width);
  await mkdir(path.join(root, ".asset-tooling"), { recursive: true });
  const scratch = await mkdtemp(path.join(root, ".asset-tooling", "warden-review-"));
  try {
    const labels = sizes.map((size) => `[s${size}]`);
    const filter = `[0:v]format=rgba,split=${sizes.length}${sizes.map((_, index) => `[in${index}]`).join("")};` +
      sizes.map((size, index) => `[in${index}]scale=${size}:${size}:flags=area${labels[index]}`).join(";");
    const args = ["-v", "error", "-nostdin", "-f", "png_pipe", "-i", "pipe:0", "-filter_complex", filter];
    for (const [index, size] of sizes.entries()) {
      args.push("-map", labels[index]!, "-frames:v", "1", "-pix_fmt", "rgba", "-f", "image2", path.join(scratch, `${size}.png`));
    }
    const result = spawnSync(executable, args, { input: candidate.bytes, timeout: 60_000, windowsHide: true });
    if (result.error || result.status !== 0) {
      const stderr = result.stderr?.toString("utf8").trim();
      throw new Error(`FFmpeg could not derive small views for ${candidate.id}: ${result.error?.message ?? stderr ?? `status ${result.status}`}`);
    }
    const views = new Map<number, Buffer>(candidate.width === MASTER_SIZE ? [[MASTER_SIZE, candidate.bytes]] : []);
    for (const size of sizes) {
      const png = await readFile(path.join(scratch, `${size}.png`));
      const dimensions = pngDimensions(png);
      if (!dimensions || dimensions.width !== size || dimensions.height !== size) {
        throw new Error(`derived ${size} px view of ${candidate.id} is not a ${size}x${size} PNG`);
      }
      // Keep the derived bytes content-addressed beside the other disposable objects.
      await storeAssetObject(root, { bytes: png, kind: "image", mediaType: "image/png", metadata: { width: size, height: size, sourceSha256: candidate.sha256 } });
      views.set(size, png);
    }
    return views;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ─── Page ───────────────────────────────────────────────────────────────────────────────────────

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function imageUrl(id: string, size: number): string {
  return `images/${id}.${size}.png`;
}

function masterUrl(id: string): string {
  return `images/${id}.master.png`;
}

function img(candidate: WardenCandidate, size: number): string {
  return `<img src="${escapeHtml(imageUrl(candidate.id, size))}" width="${size}" height="${size}" alt="${escapeHtml(`${candidate.abilityBrief.name} candidate ${candidate.id} (${candidate.imageModel.label}) at ${size} px`)}" loading="lazy">`;
}

function short(sha: string): string {
  return `${sha.slice(0, 12)}…`;
}

function fileText(file: { name: string; sha256: string; license: string }): string {
  return `${file.name} (${file.license}, sha256 ${file.sha256})`;
}

/** Supported models first, in manifest order, then deprecated ones. */
function orderedModels(models: WardenImageModel[]): WardenImageModel[] {
  return [...models.filter((model) => model.status === "supported"), ...models.filter((model) => model.status === "deprecated")];
}

function statusBadge(model: WardenImageModel): string {
  return model.status === "deprecated"
    ? `<span class="badge deprecated">deprecated</span>`
    : `<span class="badge supported">supported</span>`;
}

const APPROVED_SET_CSS = `    .badge.approved { display: inline-block; line-height: 1.4; border-color: #c9a227; color: #f2d77a; text-decoration: none; }
    .approved-set { margin: 24px 0 8px; padding: 18px; border: 2px solid #c9a227; border-radius: 16px; background: #1f1c14; }
    .approved-set h2 { margin: 0 0 6px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .approved-set .lead { margin: 0 0 14px; overflow-wrap: anywhere; }
    .approved-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 16px; margin-top: 16px; }
    .approved-card { padding: 12px; border: 1px solid #5a4a1c; border-radius: 14px; background: #191710; }
    .approved-card header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
    .approved-card h3 { margin: 0; font-size: 1.05rem; }
    .candidates-heading { margin: 40px 0 0; }
`;

function approvedUrl(key: string, variant: string): string {
  return `images/approved/${key}.${variant}.png`;
}

/** The owner-selected set as exported: 512 px views, a compact action bar at 64/48/32 px, and the consumer pin. */
function renderApprovedSet(approved: ApprovedSetView): string {
  const keys = [...new Set(approved.images.map((image) => image.key))];
  const image = (key: string, variant: string) => approved.images.find((entry) => entry.key === key && entry.variant === variant)!;
  const tag = (key: string, variant: string, size: number) => {
    const entry = image(key, variant);
    return `<img src="${escapeHtml(approvedUrl(key, variant))}" width="${size}" height="${size}" alt="${escapeHtml(`${entry.name} (${key}) approved icon at ${size} px`)}">`;
  };
  const cards = keys.map((key) => {
    const master = image(key, "master");
    const rows = ["master", "512", "64", "48", "32"].map((variant) => `<dt>${escapeHtml(variant === "master" ? `master ${image(key, variant).width} px` : `${variant} px`)}</dt><dd><code>${escapeHtml(image(key, variant).sha256)}</code></dd>`).join("");
    return `<article class="approved-card" id="approved-${escapeHtml(key)}">
        <header><h3>${escapeHtml(master.name)} <span class="ability-id">${escapeHtml(key)}</span></h3><span class="badge approved">approved · exported</span></header>
        <figure class="master">${tag(key, "512", 512)}<figcaption>512 px · <a href="${escapeHtml(approvedUrl(key, "master"))}">${master.width} px master</a> · from <a href="#${escapeHtml(master.candidate)}"><code>${escapeHtml(master.candidate)}</code></a></figcaption></figure>
        <div class="small">${[64, 48, 32].map((size) => `<figure>${tag(key, String(size), size)}<figcaption>${size} px</figcaption></figure>`).join("")}</div>
        <details><summary>Exported sha256</summary><dl>${rows}</dl></details>
      </article>`;
  }).join("\n      ");
  const bars = [64, 48, 32].map((size) => `<div class="bar-row"><span class="bar-label">Action bar at ${size} px</span><div class="bar" aria-label="${escapeHtml(`Approved Warden icons at ${size} px`)}">${keys.map((key) => tag(key, String(size), size)).join("")}</div></div>`).join("\n      ");
  const owner = approved.selection.ownerSelection;
  return `<section class="approved-set" aria-labelledby="approved-heading">
    <h2 id="approved-heading">Approved Warden set <span class="badge approved">approved-png-v1 export</span></h2>
    <p class="lead">The owner selected these four masters on ${escapeHtml(owner.date)} (<a href="${escapeHtml(owner.issue)}">#211</a>: “${escapeHtml(owner.message)}”). They are approved because the committed <code>approved-png-v1</code> export names their exact sha256 (Decision Atlas 4.1.3). Every image in this section is read from that verified export: manifest sha256 <code>${escapeHtml(approved.manifestRef.sha256)}</code> at <code>review/warden-icons/${escapeHtml(approved.selection.bundle)}/manifest.json</code>. ${escapeHtml(approved.selection.license.attribution)}</p>
    <div class="bars">
      ${bars}
    </div>
    <div class="approved-cards">
      ${cards}
    </div>
  </section>`;
}

function renderCandidate(candidate: WardenCandidate, approvedCandidates: Set<string> = new Set()): string {
  const { provenance } = candidate;
  const rows: [string, string][] = [
    ["sha256", candidate.sha256],
    ["Master", `${candidate.width}×${candidate.height} px, ${candidate.byteLength} bytes`],
    ["Seed", String(provenance.seed)],
    ["Model", `${candidate.imageModel.label} (${candidate.imageModel.status})`],
    ["Set", `${candidate.candidateSet.id} (${candidate.candidateSet.status})`],
    ["Checkpoint", fileText(provenance.checkpoint)],
  ];
  if (provenance.textEncoder) rows.push(["Text encoder", fileText(provenance.textEncoder)]);
  if (provenance.vae) rows.push(["VAE", fileText(provenance.vae)]);
  rows.push(
    ["Workflow", `${provenance.workflow.path} (sha256 ${provenance.workflow.sha256})`],
    ["Brief", `${candidate.briefs}: style ${candidate.styleBrief.id} v${candidate.styleBrief.version}, ${candidate.abilityBrief.id} v${candidate.abilityBrief.version}`],
    ["Operation", `${provenance.operation} via ${provenance.provider}`],
  );
  const master = candidate.width === MASTER_SIZE
    ? "512 px master"
    : `512 px view · <a href="${escapeHtml(masterUrl(candidate.id))}">${candidate.width} px master</a>`;
  return `<article class="candidate" id="${escapeHtml(candidate.id)}">
          <header><h5><code>${escapeHtml(candidate.id)}</code></h5><span class="badge">candidate</span>${approvedCandidates.has(candidate.id) ? `<a class="badge approved" href="#approved-${escapeHtml(candidate.ability)}">selected · approved export</a>` : ""}</header>
          <figure class="master">${img(candidate, MASTER_SIZE)}<figcaption>${master}</figcaption></figure>
          <div class="small">${WARDEN_REVIEW_SIZES.filter((size) => size !== MASTER_SIZE)
            .map((size) => `<figure>${img(candidate, size)}<figcaption>${size} px</figcaption></figure>`)
            .join("")}</div>
          <details><summary>Provenance</summary><dl>${rows.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd><code>${escapeHtml(value)}</code></dd>`).join("")}</dl>
          <p>${escapeHtml(provenance.positivePrompt)}</p>${provenance.negativePrompt ? `<p class="negative">Negative: ${escapeHtml(provenance.negativePrompt)}</p>` : ""}</details>
        </article>`;
}

function renderModelColumn(model: WardenImageModel, members: WardenCandidate[], approvedCandidates: Set<string>): string {
  return `<div class="model-column${model.status === "deprecated" ? " is-deprecated" : ""}">
          <h4>${escapeHtml(model.label)} ${statusBadge(model)}</h4>
          <div class="cards">${members.map((candidate) => renderCandidate(candidate, approvedCandidates)).join("\n          ")}</div>
        </div>`;
}

function setBadge(set: WardenCandidateSet): string {
  return `<span class="badge ${set.status}">${escapeHtml(set.status)}</span>`;
}

/** One candidate set of one ability: a 64/48/32 px strip per model, then the candidates by model. */
function renderSetBody(ability: WardenAbilityBrief, set: WardenCandidateSet, members: WardenCandidate[], review: WardenCandidateReview, approvedCandidates: Set<string>): string {
  const models = orderedModels(review.models).filter((model) => members.some((candidate) => candidate.model === model.id));
  const bars = models
    .map((model) => {
      const own = members.filter((candidate) => candidate.model === model.id);
      return `<div class="bar-row"><span class="bar-label">${escapeHtml(model.label)}${model.status === "deprecated" ? " (deprecated)" : ""}</span>${[64, 48, 32]
        .map((size) => `<div class="bar" aria-label="${escapeHtml(`${ability.name} ${set.label} ${model.label} candidates at ${size} px`)}">${own.map((candidate) => img(candidate, size)).join("")}</div>`)
        .join("")}</div>`;
    })
    .join("\n        ");
  return `<div class="bars">
        ${bars}
      </div>
      <div class="models" style="--columns: ${models.length}">
        ${models.map((model) => renderModelColumn(model, members.filter((candidate) => candidate.model === model.id), approvedCandidates)).join("\n        ")}
      </div>`;
}

function renderAbility(ability: WardenAbilityBrief, review: WardenCandidateReview, approvedCandidates: Set<string>): string {
  const members = review.candidates.filter((candidate) => candidate.ability === ability.id);
  const heading = `<h2 id="${escapeHtml(ability.id)}-heading">${escapeHtml(ability.name)} <span class="ability-id">${escapeHtml(ability.id)}</span></h2>
    <p class="subject">${escapeHtml(ability.subject)}</p>`;
  if (members.length === 0) {
    return `<section class="ability" aria-labelledby="${escapeHtml(ability.id)}-heading">
    ${heading}
    <p class="none">No candidates generated yet for this ability.</p>
  </section>`;
  }
  // Current sets open, in front; superseded sets collapsed as history (Atlas 4.1.5).
  const sets = review.sets
    .map((set) => ({ set, own: members.filter((candidate) => candidate.set === set.id) }))
    .filter(({ own }) => own.length > 0)
    .map(({ set, own }) => set.status === "current"
      ? `<div class="set is-current">
      <h3>${escapeHtml(set.label)} ${setBadge(set)}</h3>
      ${renderSetBody(ability, set, own, review, approvedCandidates)}
    </div>`
      : `<details class="set is-superseded"><summary>${escapeHtml(set.label)} ${setBadge(set)}: ${own.length} earlier candidates kept as history</summary>
      ${renderSetBody(ability, set, own, review, approvedCandidates)}
    </details>`)
    .join("\n    ");
  return `<section class="ability" aria-labelledby="${escapeHtml(ability.id)}-heading">
    ${heading}
    ${sets}
  </section>`;
}

function renderSetLegend(review: WardenCandidateReview): string {
  return review.sets
    .map((set) => {
      const count = review.candidates.filter((candidate) => candidate.set === set.id).length;
      const replaced = set.supersededBy ? ` · superseded by <code>${escapeHtml(set.supersededBy)}</code>` : "";
      const note = typeof set.note === "string" ? ` ${escapeHtml(set.note)}` : "";
      return `<li><strong>${escapeHtml(set.label)}</strong> ${setBadge(set)} <span class="negative"><code>${escapeHtml(set.id)}</code> · ${count} candidates${replaced}.${note}</span></li>`;
    })
    .join("");
}

function renderModelLegend(review: WardenCandidateReview): string {
  return orderedModels(review.models)
    .map((model) => {
      const files = MODEL_FILE_ROLES.filter((role) => model.files[role])
        .map((role) => `<li>${escapeHtml(role)}: <code>${escapeHtml(model.files[role]!.name)}</code> · ${escapeHtml(model.files[role]!.license)} · sha256 <code title="${escapeHtml(model.files[role]!.sha256)}">${escapeHtml(short(model.files[role]!.sha256))}</code></li>`)
        .join("");
      const count = review.candidates.filter((candidate) => candidate.model === model.id).length;
      const note = typeof model.note === "string" ? `<p class="negative">${escapeHtml(model.note)}</p>` : "";
      return `<div class="legend-model${model.status === "deprecated" ? " is-deprecated" : ""}"><strong>${escapeHtml(model.label)}</strong> ${statusBadge(model)} <span class="negative">${count} candidates · workflow <code>${escapeHtml(model.workflow)}</code></span><ul>${files}</ul>${note}</div>`;
    })
    .join("\n    ");
}

function renderReviewHtml(review: WardenCandidateReview, derivedWith: string, approved?: ApprovedSetView): string {
  const { candidates } = review;
  const approvedCandidates = new Set(approved?.images.map((image) => image.candidate) ?? []);
  const lead = approved
    ? `The approved Warden set comes first, read from the committed approved-png-v1 export. Below it are the generated review candidates, grouped by ability: each ability shows its current candidate set first, and earlier sets stay collapsed as history, grouped by image model. A candidate is approved only when an export names its exact sha256 (Decision Atlas 4.1.3); the selected candidates link to their exported icons.`
    : `Generated review candidates for the MMORPG Warden abilities, grouped by ability. Each ability shows its current candidate set first; earlier sets stay collapsed below it as history, grouped by image model. Every image here is a candidate and is not approved. Approval happens only when the owner names a candidate's exact sha256 in a bundle export selection (Decision Atlas 4.1.3).`;
  const latest = [...review.briefs.values()].at(-1)!;
  const styles = [...review.briefs.entries()]
    .map(([file, briefs]) => `<p><strong>${escapeHtml(file)}: style ${escapeHtml(briefs.style.id)} v${briefs.style.version}.</strong> ${escapeHtml(briefs.style.description)}</p>`)
    .join("\n    ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${approved ? "Warden ability icons" : "Warden ability-icon candidates"}</title>
  <meta name="description" content="Compare generated Warden ability-icon candidates by image model at 512, 64, 48 and 32 px with their ComfyUI provenance.">
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #14161a; color: #e8e6e1; }
    a { color: #9cc4ff; }
    main { max-width: 1440px; margin: 0 auto; padding: 32px 24px 80px; }
    h1 { margin: 0 0 8px; font-size: clamp(1.8rem, 4vw, 2.8rem); }
    .lead { max-width: 900px; line-height: 1.55; color: #b9b6ae; }
    .style, .legend { margin: 16px 0; padding: 14px 16px; border: 1px solid #2c3038; border-radius: 12px; background: #1b1e24; line-height: 1.5; }
    .style p { margin: 0 0 8px; }
    .legend { display: grid; gap: 12px; }
    .legend ul { margin: 4px 0 0; padding-left: 20px; font-size: .85rem; overflow-wrap: anywhere; }
    .legend-model.is-deprecated, .model-column.is-deprecated { opacity: .75; }
    .ability { margin-top: 48px; padding-top: 8px; border-top: 1px solid #2c3038; }
    .ability h2 { margin: 0 0 4px; }
    .ability-id { font-size: .8rem; font-weight: 400; color: #8f8c85; }
    .subject { margin: 0 0 12px; color: #b9b6ae; }
    .bars { display: grid; gap: 8px; }
    .bar-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }
    .bar-label { width: 190px; font-size: .85rem; color: #b9b6ae; }
    .bar { display: inline-flex; gap: 4px; padding: 6px; border-radius: 8px; background: #0b0c0e; border: 1px solid #2c3038; }
    .bar img { display: block; }
    .models { display: grid; grid-template-columns: repeat(var(--columns), minmax(0, 1fr)); gap: 20px; margin-top: 16px; }
    .set { margin-top: 16px; }
    .set h3 { margin: 0 0 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .set.is-superseded { padding: 10px 14px; border: 1px dashed #4a3c32; border-radius: 12px; }
    .set.is-superseded .model-column { opacity: .8; }
    .legend ul.sets { margin: 0; padding-left: 20px; font-size: .9rem; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 16px; }
    .model-column h4 { margin: 0 0 10px; display: flex; align-items: center; gap: 10px; }
    .candidate { padding: 14px; border: 1px solid #2c3038; border-radius: 14px; background: #1b1e24; }
    .candidate header { display: flex; align-items: center; gap: 12px; }
    .candidate h5 { margin: 0 0 8px; font-size: .95rem; }
    .badge { padding: 2px 8px; border: 1px solid #555a64; border-radius: 999px; font-size: .7rem; font-weight: 400; text-transform: uppercase; letter-spacing: .06em; }
    .badge.supported { border-color: #3f7f5a; color: #9fd8b4; }
    .badge.deprecated, .badge.superseded { border-color: #8a5a3a; color: #e0b08a; }
    .badge.current { border-color: #3f7f5a; color: #9fd8b4; }
${approved ? APPROVED_SET_CSS : ""}    .master img { display: block; max-width: 100%; height: auto; }
    .small { display: flex; align-items: flex-end; gap: 16px; margin-top: 10px; }
    .small img { display: block; max-width: none; }
    figure { margin: 0; }
    figcaption { margin-top: 4px; font-size: .75rem; color: #8f8c85; }
    dl { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 4px 12px; margin: 8px 0; font-size: .8rem; }
    dt { color: #8f8c85; }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
    details { margin-top: 10px; font-size: .85rem; color: #b9b6ae; }
    .negative, .none { color: #8f8c85; }
    @media (max-width: 900px) { .models { grid-template-columns: 1fr; } }
    @media (max-width: 560px) { main { padding-inline: 16px; } dl { grid-template-columns: 1fr; } .bar-label { width: 100%; } }
  </style>
</head>
<body>
<main>
  <a href="../../">← Back to gallery</a>
  <h1>${approved ? "Warden ability icons" : "Warden ability-icon candidates"}</h1>
  <p class="lead">${escapeHtml(lead)} The 512 px view is the exact candidate file for 512 px masters and an area downscale of 1024 px masters (the master is linked); the 64, 48 and 32 px views are real area-downscaled PNGs (${escapeHtml(derivedWith)}) shown at their true pixel size.</p>
  ${approved ? renderApprovedSet(approved) : ""}
  <h2 class="candidates-heading">Candidates</h2>
  <div class="legend">
    <ul class="sets">${renderSetLegend(review)}</ul>
    ${renderModelLegend(review)}
  </div>
  <div class="style">
    ${styles}
    <span class="negative">${candidates.length} candidates · ${review.manifest.briefs.map((ref) => `${escapeHtml(ref.path)} sha256 <code>${escapeHtml(short(ref.sha256))}</code>`).join(" · ")}</span>
  </div>
  ${latest.abilities.map((ability) => renderAbility(ability, review, approvedCandidates)).join("\n  ")}
</main>
</body>
</html>
`;
}

/**
 * Re-verify the review folder and write `index.html` plus 512/64/48/32 px PNGs (and the exact
 * bytes of any 1024 px master) under `outputDirectory/images/`. `root` is a disposable workspace for
 * the content-addressed object store that keeps the derived views. Nothing is written when
 * verification fails, and any existing `index.html` is removed first so a failed build never
 * leaves a stale page behind.
 */
export async function buildWardenReviewPage({
  root,
  reviewDirectory,
  outputDirectory,
}: {
  root: string;
  reviewDirectory: string;
  outputDirectory: string;
}): Promise<WardenReviewPageResult> {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Warden review root must be an absolute path");
  if (typeof outputDirectory !== "string" || !outputDirectory) throw new Error("Warden review outputDirectory must be a path");
  const output = path.resolve(outputDirectory);
  await rm(path.join(output, "index.html"), { force: true });

  const review = await loadWardenCandidateReview(reviewDirectory);
  // The committed approved export, when present, is re-verified (fail closed) before anything is written.
  const exports = await import("./warden-icon-export.js");
  const approved: ApprovedSetView | undefined = await exports.hasWardenExportSelection(reviewDirectory)
    ? await exports.loadApprovedWardenExport(reviewDirectory, review)
    : undefined;
  const ffmpeg = "ffmpeg";
  const derivedWith = ffmpegVersion(ffmpeg);
  const derived = new Map<string, Map<number, Buffer>>();
  for (const candidate of review.candidates) derived.set(candidate.id, await derivePngs(root, ffmpeg, candidate));

  await mkdir(path.join(output, "images"), { recursive: true });
  const result: WardenReviewPageResult = { page: "index.html", candidates: [] };
  for (const candidate of review.candidates) {
    const images: WardenReviewImage[] = [];
    for (const size of WARDEN_REVIEW_SIZES) {
      const url = imageUrl(candidate.id, size);
      await writeFile(path.join(output, ...url.split("/")), derived.get(candidate.id)!.get(size)!);
      images.push({ size, url });
    }
    const entry: WardenReviewPageResult["candidates"][number] = { id: candidate.id, ability: candidate.ability, model: candidate.model, set: candidate.set, images };
    if (candidate.width !== MASTER_SIZE) {
      entry.master = masterUrl(candidate.id);
      await writeFile(path.join(output, ...entry.master.split("/")), candidate.bytes);
    }
    result.candidates.push(entry);
  }
  if (approved) {
    await mkdir(path.join(output, "images", "approved"), { recursive: true });
    result.approved = { manifestSha256: approved.manifestRef.sha256, images: [] };
    for (const image of approved.images) {
      const url = approvedUrl(image.key, image.variant);
      await writeFile(path.join(output, ...url.split("/")), image.bytes);
      result.approved.images.push({ key: image.key, variant: image.variant, sha256: image.sha256, url });
    }
  }
  await writeFile(path.join(output, "index.html"), renderReviewHtml(review, derivedWith, approved), "utf8");
  return result;
}
