/**
 * Warden ability-icon candidate review (asset-tooling#211, first slice).
 *
 * Generated review candidates live in the Git LFS review namespace `review/warden-icons/`
 * (owner decision on #211, 2026-10-17), outside `assets/canonical/` and the catalog. A plain-JSON
 * manifest pins every candidate's bytes and ComfyUI provenance. This module re-verifies that folder
 * fail closed and renders a static review page with the 512 px master and true 64/48/32 px views.
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
const MASTER_SIZE = 512;
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
  negativePrompt: string;
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

export interface WardenCandidateProvenance {
  provider: "comfyui";
  operation: "image.comfyui.generate@1";
  workflow: { path: string; sha256: string };
  checkpoint: { name: string; sha256: string; byteLength: number; license: string };
  seed: number;
  positivePrompt: string;
  negativePrompt?: string;
  [key: string]: unknown;
}

export interface WardenCandidateEntry {
  id: string;
  ability: string;
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
  schemaVersion: 1;
  briefs: { path: "briefs.json"; sha256: string };
  candidates: WardenCandidateEntry[];
}

export interface WardenCandidate extends WardenCandidateEntry {
  abilityBrief: WardenAbilityBrief;
  bytes: Buffer;
}

export interface WardenCandidateReview {
  briefs: WardenBriefs;
  manifest: WardenCandidateManifest;
  candidates: WardenCandidate[];
}

export interface WardenReviewImage {
  size: number;
  url: string;
}

export interface WardenReviewPageResult {
  page: "index.html";
  candidates: { id: string; ability: string; images: WardenReviewImage[] }[];
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
    negativePrompt: text(styleValue.negativePrompt, "Warden style brief negativePrompt"),
  };
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

/**
 * Load and re-verify a Warden candidate review folder. Rejects (and so fails any Pages build) on a
 * stale briefs or workflow hash, a missing, unhydrated (Git LFS pointer) or altered candidate, a
 * non-PNG or wrongly sized candidate, a state other than `candidate`, a path escaping the folder,
 * an empty candidate list, an ability outside the four briefs, or a candidate file the manifest
 * does not list. An ability may have no candidates yet.
 */
export async function loadWardenCandidateReview(reviewDirectory: string): Promise<WardenCandidateReview> {
  if (typeof reviewDirectory !== "string" || !reviewDirectory) throw new Error("reviewDirectory must be a path");
  const directory = path.resolve(reviewDirectory);
  const manifestValue = record(parseJson(await readReviewFile(directory, "candidates.json", "candidates manifest"), "candidates.json"), "candidates manifest");
  if (manifestValue.schemaVersion !== 1) throw new Error("candidates manifest schemaVersion must be 1");

  const briefsRef = record(manifestValue.briefs, "candidates manifest briefs");
  if (briefsRef.path !== "briefs.json") throw new Error("candidates manifest briefs.path must be briefs.json");
  const briefsSha = sha256(briefsRef.sha256, "candidates manifest briefs.sha256");
  const briefBytes = await readReviewFile(directory, "briefs.json", "briefs");
  if (sha256Bytes(briefBytes) !== briefsSha) {
    throw new Error(`briefs.json sha256 ${sha256Bytes(briefBytes)} does not match the manifest's pinned briefs sha256 ${briefsSha}`);
  }
  const briefs = parseBriefs(parseJson(briefBytes, "briefs.json"));

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
    const abilityBrief = briefs.abilities.find((ability) => ability.id === entry.ability);
    if (!abilityBrief) {
      throw new Error(`candidate ${id} ability ${JSON.stringify(entry.ability)} is not one of the four Warden ability briefs`);
    }
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
    if (entry.width !== MASTER_SIZE || entry.height !== MASTER_SIZE) {
      throw new Error(`candidate ${id} must be a ${MASTER_SIZE}x${MASTER_SIZE} master`);
    }

    const provenanceValue = record(entry.provenance, `candidate ${id} provenance`);
    if (provenanceValue.provider !== "comfyui" || provenanceValue.operation !== "image.comfyui.generate@1") {
      throw new Error(`candidate ${id} provenance must name provider comfyui and operation image.comfyui.generate@1`);
    }
    const workflow = record(provenanceValue.workflow, `candidate ${id} provenance.workflow`);
    if (typeof workflow.path !== "string" || !JSON_FILE.test(workflow.path)) {
      throw new Error(`candidate ${id} workflow path must be a JSON file in the review folder`);
    }
    const workflowSha = sha256(workflow.sha256, `candidate ${id} workflow sha256`);
    let actualWorkflowSha = workflowHashes.get(workflow.path);
    if (actualWorkflowSha === undefined) {
      actualWorkflowSha = sha256Bytes(await readReviewFile(directory, workflow.path, `candidate ${id} workflow`));
      workflowHashes.set(workflow.path, actualWorkflowSha);
    }
    if (actualWorkflowSha !== workflowSha) {
      throw new Error(`candidate ${id} workflow ${workflow.path} sha256 ${actualWorkflowSha} does not match the pinned ${workflowSha}`);
    }
    const checkpoint = record(provenanceValue.checkpoint, `candidate ${id} provenance.checkpoint`);
    const checkpointName = text(checkpoint.name, `candidate ${id} checkpoint name`);
    if (!checkpointName.endsWith(".safetensors")) throw new Error(`candidate ${id} checkpoint must be a .safetensors file`);
    sha256(checkpoint.sha256, `candidate ${id} checkpoint sha256`);
    positiveInteger(checkpoint.byteLength, `candidate ${id} checkpoint byteLength`);
    text(checkpoint.license, `candidate ${id} checkpoint license`);
    const seed = provenanceValue.seed;
    if (typeof seed !== "number" || !Number.isSafeInteger(seed) || seed < 0) throw new Error(`candidate ${id} provenance needs its seed`);
    const positivePrompt = text(provenanceValue.positivePrompt, `candidate ${id} positivePrompt`);
    if (!positivePrompt.includes(briefs.style.prompt) || !positivePrompt.includes(abilityBrief.prompt)) {
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
    if (dimensions.width !== MASTER_SIZE || dimensions.height !== MASTER_SIZE) {
      throw new Error(`candidate ${id} PNG is ${dimensions.width}x${dimensions.height}, expected ${MASTER_SIZE}x${MASTER_SIZE}`);
    }
    candidates.push({ ...(entry as unknown as WardenCandidateEntry), abilityBrief, bytes });
  }

  // Candidates are never approved in the manifest (Atlas 4.1.3): approval exists only in an export.
  if (mentionsApproval(manifestValue)) throw new Error("candidates manifest must not mention approval; every entry stays a candidate");

  // No stand-ins: the candidates folder holds exactly the listed PNGs.
  const listed = new Set(candidates.map((candidate) => candidate.path.slice("candidates/".length)));
  for (const file of await readdir(path.join(directory, "candidates"))) {
    if (!listed.has(file)) throw new Error(`candidates/${file} is not listed in the candidates manifest`);
  }

  return { briefs, manifest: manifestValue as unknown as WardenCandidateManifest, candidates };
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
 * Derive every small view of one master in a single FFmpeg run with area-averaging downscales,
 * so 64/48/32 px views are true pixel sizes rather than CSS-scaled masters.
 */
async function derivePngs(root: string, executable: string, candidate: WardenCandidate): Promise<Map<number, Buffer>> {
  const sizes = WARDEN_REVIEW_SIZES.filter((size) => size !== MASTER_SIZE);
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
    const views = new Map<number, Buffer>([[MASTER_SIZE, candidate.bytes]]);
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

function img(candidate: WardenCandidate, size: number): string {
  return `<img src="${escapeHtml(imageUrl(candidate.id, size))}" width="${size}" height="${size}" alt="${escapeHtml(`${candidate.abilityBrief.name} candidate ${candidate.id} at ${size} px`)}" loading="lazy">`;
}

function renderCandidate(candidate: WardenCandidate): string {
  const { provenance } = candidate;
  const rows: [string, string][] = [
    ["sha256", candidate.sha256],
    ["Bytes", String(candidate.byteLength)],
    ["Seed", String(provenance.seed)],
    ["Checkpoint", `${provenance.checkpoint.name} (${provenance.checkpoint.license}, sha256 ${provenance.checkpoint.sha256})`],
    ["Workflow", `${provenance.workflow.path} (sha256 ${provenance.workflow.sha256})`],
    ["Operation", `${provenance.operation} via ${provenance.provider}`],
  ];
  return `<article class="candidate" id="${escapeHtml(candidate.id)}">
      <header><h3><code>${escapeHtml(candidate.id)}</code></h3><span class="badge">candidate</span></header>
      <div class="views">
        <figure class="master">${img(candidate, MASTER_SIZE)}<figcaption>512 px master</figcaption></figure>
        <div class="small">${WARDEN_REVIEW_SIZES.filter((size) => size !== MASTER_SIZE)
          .map((size) => `<figure>${img(candidate, size)}<figcaption>${size} px</figcaption></figure>`)
          .join("")}</div>
      </div>
      <dl>${rows.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd><code>${escapeHtml(value)}</code></dd>`).join("")}</dl>
      <details><summary>Prompt</summary><p>${escapeHtml(provenance.positivePrompt)}</p>${provenance.negativePrompt ? `<p class="negative">Negative: ${escapeHtml(provenance.negativePrompt)}</p>` : ""}</details>
    </article>`;
}

function renderReviewHtml(review: WardenCandidateReview, derivedWith: string): string {
  const { briefs, candidates } = review;
  const sections = briefs.abilities.map((ability) => {
    const members = candidates.filter((candidate) => candidate.ability === ability.id);
    if (members.length === 0) {
      return `<section class="ability" aria-labelledby="${escapeHtml(ability.id)}-heading">
    <h2 id="${escapeHtml(ability.id)}-heading">${escapeHtml(ability.name)} <span class="ability-id">${escapeHtml(ability.id)} · brief v${ability.version}</span></h2>
    <p class="subject">${escapeHtml(ability.subject)}</p>
    <p class="none">No candidates generated yet for this brief.</p>
  </section>`;
    }
    return `<section class="ability" aria-labelledby="${escapeHtml(ability.id)}-heading">
    <h2 id="${escapeHtml(ability.id)}-heading">${escapeHtml(ability.name)} <span class="ability-id">${escapeHtml(ability.id)} · brief v${ability.version}</span></h2>
    <p class="subject">${escapeHtml(ability.subject)}</p>
    <div class="bar" aria-label="${escapeHtml(ability.name)} candidates side by side at 32 px">${members.map((candidate) => img(candidate, 32)).join("")}</div>
    <div class="candidates">${members.map(renderCandidate).join("\n    ")}</div>
  </section>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Warden ability-icon candidates</title>
  <meta name="description" content="Compare generated Warden ability-icon candidates at 512, 64, 48 and 32 px with their ComfyUI provenance.">
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #14161a; color: #e8e6e1; }
    a { color: #9cc4ff; }
    main { max-width: 1240px; margin: 0 auto; padding: 32px 24px 80px; }
    h1 { margin: 0 0 8px; font-size: clamp(1.8rem, 4vw, 2.8rem); }
    .lead { max-width: 820px; line-height: 1.55; color: #b9b6ae; }
    .style { margin: 16px 0 28px; padding: 14px 16px; border: 1px solid #2c3038; border-radius: 12px; background: #1b1e24; line-height: 1.5; }
    .ability { margin-top: 40px; }
    .ability h2 { margin: 0 0 4px; }
    .ability-id { font-size: .8rem; font-weight: 400; color: #8f8c85; }
    .subject { margin: 0 0 12px; color: #b9b6ae; }
    .bar { display: inline-flex; gap: 4px; padding: 6px; border-radius: 8px; background: #0b0c0e; border: 1px solid #2c3038; }
    .bar img { display: block; image-rendering: auto; }
    .candidates { display: grid; gap: 20px; margin-top: 16px; }
    .candidate { padding: 16px; border: 1px solid #2c3038; border-radius: 14px; background: #1b1e24; }
    .candidate header { display: flex; align-items: center; gap: 12px; }
    .candidate h3 { margin: 0; font-size: 1rem; }
    .badge { padding: 2px 8px; border: 1px solid #555a64; border-radius: 999px; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; }
    .views { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 20px; margin: 12px 0; }
    .views img { display: block; max-width: 100%; height: auto; }
    .small { display: flex; align-items: flex-end; gap: 16px; }
    .small img { height: auto; max-width: none; }
    figure { margin: 0; }
    figcaption { margin-top: 4px; font-size: .75rem; color: #8f8c85; }
    dl { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 4px 12px; margin: 0; font-size: .85rem; }
    dt { color: #8f8c85; }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
    details { margin-top: 10px; font-size: .85rem; color: #b9b6ae; }
    .negative, .none { color: #8f8c85; }
    @media (max-width: 560px) { main { padding-inline: 16px; } dl { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <a href="../../">← Back to gallery</a>
  <h1>Warden ability-icon candidates</h1>
  <p class="lead">Generated review candidates for the MMORPG Warden abilities. Every image here is a candidate and is not approved. Approval happens only when the owner names a candidate's exact sha256 in a bundle export selection (Decision Atlas 4.1.3). The 512 px image is the exact candidate file; the 64, 48 and 32 px views are real area-downscaled PNGs (${escapeHtml(derivedWith)}) shown at their true pixel size.</p>
  <div class="style"><strong>Style brief ${escapeHtml(briefs.style.id)} v${briefs.style.version}.</strong> ${escapeHtml(briefs.style.description)} <br><span class="negative">${candidates.length} candidates · manifest briefs sha256 <code>${escapeHtml(review.manifest.briefs.sha256)}</code></span></div>
  ${sections.join("\n  ")}
</main>
</body>
</html>
`;
}

/**
 * Re-verify the review folder and write `index.html` plus 512/64/48/32 px PNGs under
 * `outputDirectory/images/`. `root` is a disposable workspace for the content-addressed object
 * store that keeps the derived views. Nothing is written when verification fails, and any
 * existing `index.html` is removed first so a failed build never leaves a stale page behind.
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
    result.candidates.push({ id: candidate.id, ability: candidate.ability, images });
  }
  await writeFile(path.join(output, "index.html"), renderReviewHtml(review, derivedWith), "utf8");
  return result;
}
