/**
 * `image.generate@1`: prompt-level image generation with an explicit, versioned provider and a
 * pinned model profile (asset-tooling#222, Atlas Decisions 5.1.2 and 5.1.4).
 *
 * A recipe names `provider`, `model`, `prompt`, `seed`, `width` and `height`, plus optional
 * sampler knobs. `resolveImageGenerateParameters` fills the profile defaults; callers pass the
 * resolved parameters to `runAssetOperation`, so build identity always uses resolved values.
 * The profile's model file pins, template sha256 and injection map, the provider and (for
 * ComfyUI) the server identity are the registration's implementation identity.
 *
 * The ComfyUI provider fills a repository-owned, hash-pinned API-format template
 * (src/image-generate-templates/) and runs it through the shared ComfyUI transport. The Diffusers
 * provider is registered but supports neither model yet and fails visibly. There is no fallback
 * between providers. See docs/image-generate.md.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { storeAssetObject, type AssetOperationRunRegistration } from "./asset-store.js";
import { canonicalJson } from "./canonical.js";
import {
  assertKeys,
  assertPositiveInteger,
  assertRecord,
  assertServerIdentityUnchanged,
  assertString,
  awaitOutput,
  fetchOutput,
  isRecord,
  normalizeEndpoint,
  pinnedFileSignature,
  submitPrompt,
  verifyPinnedFile,
  verifyPng,
  type ComfyUiServerIdentity,
} from "./comfyui-transport.js";
import { sha256Bytes, sha256Text } from "./hash.js";
import {
  createAssetOperationRegistry,
  type AssetOperationResult,
  type CanonicalJsonObject,
  type ReadonlyAssetOperationDescriptor,
} from "./operations.js";

const OPERATION_ID = "image.generate";
const OPERATION_VERSION = "1";
const IMPLEMENTATION_ID = "asset-tooling.image-generate";
const IMPLEMENTATION_VERSION = "1";
const PROVIDERS = ["comfyui", "diffusers"] as const;
const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_DIMENSION = 2048;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const KNOB_NAME_PATTERN = /^[a-z0-9_]+$/;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type ImageGenerateProvider = (typeof PROVIDERS)[number];
export type ImageGenerateModelRole = "diffusionModel" | "textEncoder" | "vae";
export type ImageGenerateOverride = "steps" | "sampler" | "scheduler" | "guidance" | "shift";

const ROLES: readonly ImageGenerateModelRole[] = ["diffusionModel", "textEncoder", "vae"];
const OVERRIDES: readonly ImageGenerateOverride[] = ["steps", "sampler", "scheduler", "guidance", "shift"];
const REQUIRED_FIELDS = ["provider", "model", "prompt", "seed", "width", "height"] as const;
const VALUE_INJECTIONS = ["prompt", "seed", "width", "height", ...OVERRIDES] as const;
type ValueInjection = (typeof VALUE_INJECTIONS)[number];
type InjectionName = ValueInjection | ImageGenerateModelRole;

// ─── Descriptor ─────────────────────────────────────────────────────────────────────────────────

const DIMENSION_SCHEMA = { type: "integer", minimum: 8, maximum: MAX_DIMENSION, multipleOf: 8 };
const KNOB_NAME_SCHEMA = { type: "string", pattern: KNOB_NAME_PATTERN.source };
const POSITIVE_NUMBER_SCHEMA = { type: "number", exclusiveMinimum: 0 };

const OPERATION_REGISTRY = createAssetOperationRegistry([
  {
    schemaVersion: 1,
    id: OPERATION_ID,
    version: OPERATION_VERSION,
    label: "Image generation",
    description:
      "Generate one PNG from a prompt with an explicitly selected provider and a pinned model profile (model files, template workflow and sampling defaults). Unset sampler knobs take the profile defaults; there is no provider fallback.",
    category: "image.generate",
    inputs: [],
    outputs: [
      {
        id: "image",
        label: "Generated PNG",
        assetKinds: ["image"],
        mediaTypes: ["image/png"],
        cardinality: "single",
      },
    ],
    parameterSchema: {
      type: "object",
      additionalProperties: false,
      required: [...REQUIRED_FIELDS],
      properties: {
        provider: { type: "string", enum: [...PROVIDERS] },
        model: { type: "string", pattern: MODEL_ID_PATTERN.source },
        prompt: { type: "string", minLength: 1 },
        seed: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        width: DIMENSION_SCHEMA,
        height: DIMENSION_SCHEMA,
        steps: { type: "integer", minimum: 1 },
        sampler: KNOB_NAME_SCHEMA,
        scheduler: KNOB_NAME_SCHEMA,
        guidance: POSITIVE_NUMBER_SCHEMA,
        shift: POSITIVE_NUMBER_SCHEMA,
      },
    },
  },
]);

export const IMAGE_GENERATE_OPERATION: ReadonlyAssetOperationDescriptor = OPERATION_REGISTRY.get(OPERATION_ID, OPERATION_VERSION)!;

// ─── Model profiles ─────────────────────────────────────────────────────────────────────────────

export interface ImageGenerateModelFile {
  name: string;
  /** ComfyUI models subdirectory (`diffusion_models`, `text_encoders`, `vae`). */
  directory: string;
  sha256: string;
  byteLength: number;
  license: string;
  source: { provider: string; repository: string; revision: string; path: string };
}

export interface ImageGenerateTemplateBinding {
  node: string;
  input: string;
}

export interface ImageGenerateModelProfile {
  id: string;
  label: string;
  providers: ImageGenerateProvider[];
  files: Record<ImageGenerateModelRole, ImageGenerateModelFile>;
  template: {
    /** Repository-relative path of the API-format template workflow. */
    path: string;
    /** sha256 of the template file bytes; a mismatch fails before anything is sent. */
    sha256: string;
    /** Where each resolved value and each model file name is written into the template. */
    injections: Partial<Record<InjectionName, ImageGenerateTemplateBinding>>;
    /** The single SaveImage node whose image is imported. */
    output: string;
  };
  defaults: Partial<Record<ImageGenerateOverride, string | number>>;
  supportedOverrides: ImageGenerateOverride[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const QWEN3_4B_TEXT_ENCODER: ImageGenerateModelFile = {
  name: "qwen_3_4b_fp8_mixed.safetensors",
  directory: "text_encoders",
  sha256: "72450b19758172c5a7273cf7de729d1c17e7f434a104a00167624cba94f68f15",
  byteLength: 5631994051,
  license: "apache-2.0",
  source: {
    provider: "huggingface",
    repository: "Comfy-Org/z_image_turbo",
    revision: "6fc90a3b1b653e935a0d175e260736de25b84df5",
    path: "split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors",
  },
};

const LOADER_INJECTIONS = {
  diffusionModel: { node: "1", input: "unet_name" },
  textEncoder: { node: "2", input: "clip_name" },
  vae: { node: "3", input: "vae_name" },
};

/**
 * The owner-approved model profiles (Decision 4.1.4, 5.1.4). File pins equal
 * review/warden-icons/candidates.json `models`; templates are newly authored for this operation.
 */
export const IMAGE_GENERATE_MODEL_PROFILES: Readonly<Record<string, Readonly<ImageGenerateModelProfile>>> = deepFreeze({
  "flux2-klein-4b": {
    id: "flux2-klein-4b",
    label: "FLUX.2 [klein] 4B",
    providers: ["comfyui"],
    files: {
      diffusionModel: {
        name: "flux-2-klein-4b-fp8.safetensors",
        directory: "diffusion_models",
        sha256: "97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6",
        byteLength: 4070624520,
        license: "apache-2.0",
        source: {
          provider: "huggingface",
          repository: "black-forest-labs/FLUX.2-klein-4b-fp8",
          revision: "5b4408e59397a4a37ccb46afe426d8ed86379441",
          path: "flux-2-klein-4b-fp8.safetensors",
        },
      },
      textEncoder: { ...QWEN3_4B_TEXT_ENCODER, source: { ...QWEN3_4B_TEXT_ENCODER.source } },
      vae: {
        name: "flux2-vae.safetensors",
        directory: "vae",
        sha256: "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3",
        byteLength: 336211292,
        license: "apache-2.0",
        source: {
          provider: "huggingface",
          repository: "Comfy-Org/vae-text-encorder-for-flux-klein-4b",
          revision: "5f526678002e43af5551dadb73ce2e8c91b43afe",
          path: "split_files/vae/flux2-vae.safetensors",
        },
      },
    },
    template: {
      path: "src/image-generate-templates/flux2-klein-4b.api.json",
      sha256: "c01d72f3f5091281cd958e160d3b9afa3164f62c094c2c3e432504fece25b88d",
      injections: {
        ...LOADER_INJECTIONS,
        prompt: { node: "20", input: "text" },
        seed: { node: "33", input: "noise_seed" },
        width: { node: "10", input: "value" },
        height: { node: "11", input: "value" },
        steps: { node: "32", input: "steps" },
        sampler: { node: "31", input: "sampler_name" },
        guidance: { node: "30", input: "cfg" },
      },
      output: "60",
    },
    defaults: { steps: 4, sampler: "euler", guidance: 1 },
    supportedOverrides: ["steps", "sampler", "guidance"],
  },
  "z-image-turbo": {
    id: "z-image-turbo",
    label: "Z-Image Turbo",
    providers: ["comfyui"],
    files: {
      diffusionModel: {
        name: "z_image_turbo_bf16.safetensors",
        directory: "diffusion_models",
        sha256: "2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6",
        byteLength: 12309866400,
        license: "apache-2.0",
        source: {
          provider: "huggingface",
          repository: "Comfy-Org/z_image_turbo",
          revision: "6fc90a3b1b653e935a0d175e260736de25b84df5",
          path: "split_files/diffusion_models/z_image_turbo_bf16.safetensors",
        },
      },
      textEncoder: { ...QWEN3_4B_TEXT_ENCODER, source: { ...QWEN3_4B_TEXT_ENCODER.source } },
      vae: {
        name: "ae.safetensors",
        directory: "vae",
        sha256: "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
        byteLength: 335304388,
        license: "apache-2.0",
        source: {
          provider: "huggingface",
          repository: "Comfy-Org/z_image_turbo",
          revision: "6fc90a3b1b653e935a0d175e260736de25b84df5",
          path: "split_files/vae/ae.safetensors",
        },
      },
    },
    template: {
      path: "src/image-generate-templates/z-image-turbo.api.json",
      sha256: "00dbe3a0b32cea3ad5cdc754f5ea521c19ffe47e14f555a0477b041241ab64f8",
      injections: {
        ...LOADER_INJECTIONS,
        prompt: { node: "20", input: "text" },
        seed: { node: "40", input: "seed" },
        width: { node: "30", input: "width" },
        height: { node: "30", input: "height" },
        steps: { node: "40", input: "steps" },
        sampler: { node: "40", input: "sampler_name" },
        scheduler: { node: "40", input: "scheduler" },
        guidance: { node: "40", input: "cfg" },
        shift: { node: "4", input: "shift" },
      },
      output: "60",
    },
    defaults: { steps: 8, sampler: "res_multistep", scheduler: "simple", guidance: 1, shift: 3 },
    supportedOverrides: ["steps", "sampler", "scheduler", "guidance", "shift"],
  },
} satisfies Record<string, ImageGenerateModelProfile>);

function isSafeRelativeName(value: string): boolean {
  return !(
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function parseBinding(value: unknown, location: string): ImageGenerateTemplateBinding {
  const binding = assertRecord(value, location);
  assertKeys(binding, ["node", "input"], location);
  return { node: assertString(binding.node, `${location}.node`), input: assertString(binding.input, `${location}.input`) };
}

/** Validate a caller-supplied profile; returns a detached copy. */
function parseProfile(id: string, value: unknown): ImageGenerateModelProfile {
  const where = `image.generate model profile '${id}'`;
  const profile = assertRecord(value, where);
  assertKeys(profile, ["id", "label", "providers", "files", "template", "defaults", "supportedOverrides"], where);
  if (profile.id !== id) throw new Error(`${where} has id '${String(profile.id)}'`);
  const providers = profile.providers;
  if (!Array.isArray(providers) || providers.some((provider) => !PROVIDERS.includes(provider))) {
    throw new Error(`${where} providers must be a list of ${PROVIDERS.join(", ")}`);
  }
  const files = assertRecord(profile.files, `${where} files`);
  assertKeys(files, ROLES, `${where} files`);
  for (const role of ROLES) {
    const file = assertRecord(files[role], `${where} files.${role}`);
    const name = assertString(file.name, `${where} files.${role}.name`);
    const directory = assertString(file.directory, `${where} files.${role}.directory`);
    if (!isSafeRelativeName(name) || !isSafeRelativeName(directory)) {
      throw new Error(`${where} files.${role} must name a relative path inside the models directory`);
    }
    if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`${where} files.${role}.sha256 must be a lowercase 64-character SHA-256 digest`);
    }
    if (typeof file.byteLength !== "number" || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0) {
      throw new Error(`${where} files.${role}.byteLength must be a non-negative safe integer`);
    }
    assertString(file.license, `${where} files.${role}.license`);
    assertRecord(file.source, `${where} files.${role}.source`);
  }
  const template = assertRecord(profile.template, `${where} template`);
  assertKeys(template, ["path", "sha256", "injections", "output"], `${where} template`);
  const templatePath = assertString(template.path, `${where} template.path`);
  if (!isSafeRelativeName(templatePath)) throw new Error(`${where} template.path must be repository-relative`);
  if (typeof template.sha256 !== "string" || !SHA256_PATTERN.test(template.sha256)) {
    throw new Error(`${where} template.sha256 must be a lowercase 64-character SHA-256 digest`);
  }
  const injections = assertRecord(template.injections, `${where} template.injections`);
  assertKeys(injections, [...VALUE_INJECTIONS, ...ROLES], `${where} template.injections`);
  for (const [name, binding] of Object.entries(injections)) parseBinding(binding, `${where} template.injections.${name}`);
  assertString(template.output, `${where} template.output`);
  const supported = profile.supportedOverrides;
  if (!Array.isArray(supported) || supported.some((name) => !OVERRIDES.includes(name))) {
    throw new Error(`${where} supportedOverrides must be a list of ${OVERRIDES.join(", ")}`);
  }
  const defaults = assertRecord(profile.defaults, `${where} defaults`);
  assertKeys(defaults, supported, `${where} defaults`);
  for (const name of [...supported, "prompt", "seed", "width", "height", ...ROLES]) {
    if (!Object.hasOwn(injections, name)) throw new Error(`${where} template.injections must bind '${name}'`);
  }
  for (const name of supported) {
    if (!Object.hasOwn(defaults, name)) throw new Error(`${where} defaults must set '${name}'`);
  }
  return structuredClone(profile) as unknown as ImageGenerateModelProfile;
}

function parseProfiles(value: unknown): Readonly<Record<string, ImageGenerateModelProfile>> {
  if (value === undefined) return IMAGE_GENERATE_MODEL_PROFILES as Record<string, ImageGenerateModelProfile>;
  const record = assertRecord(value, "image.generate registration profiles");
  const profiles: Record<string, ImageGenerateModelProfile> = {};
  for (const [id, profile] of Object.entries(record)) profiles[id] = parseProfile(id, profile);
  return deepFreeze(profiles);
}

// ─── Parameters ─────────────────────────────────────────────────────────────────────────────────

export interface ImageGenerateParameters {
  provider: ImageGenerateProvider;
  model: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  steps?: number;
  sampler?: string;
  scheduler?: string;
  guidance?: number;
  shift?: number;
}

function checkOverride(name: ImageGenerateOverride, value: unknown): string | number {
  if (name === "steps") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error("image.generate parameter 'steps' must be a positive integer");
    }
    return value;
  }
  if (name === "sampler" || name === "scheduler") {
    if (typeof value !== "string" || !KNOB_NAME_PATTERN.test(value)) {
      throw new Error(`image.generate parameter '${name}' must be a ComfyUI ${name} name matching ${KNOB_NAME_PATTERN.source}`);
    }
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`image.generate parameter '${name}' must be a finite number greater than 0`);
  }
  return value;
}

function checkDimension(name: "width" | "height", value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value % 8 !== 0 || value > MAX_DIMENSION) {
    throw new Error(`image.generate parameter '${name}' must be a positive integer multiple of 8 up to ${MAX_DIMENSION}`);
  }
  return value;
}

function resolveWith(profiles: Readonly<Record<string, ImageGenerateModelProfile>>, value: unknown): ImageGenerateParameters {
  const parameters = assertRecord(value, "image.generate parameters");
  const provider = parameters.provider;
  if (typeof provider !== "string" || !PROVIDERS.includes(provider as ImageGenerateProvider)) {
    throw new Error(`image.generate parameter 'provider' must explicitly select one of ${PROVIDERS.join(", ")}`);
  }
  const model = parameters.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error(`image.generate parameter 'model' must name a model profile (${Object.keys(profiles).join(", ")})`);
  }
  const profile = Object.hasOwn(profiles, model) ? profiles[model] : undefined;
  if (profile === undefined) {
    throw new Error(`image.generate model '${model}' is unknown; known model profiles: ${Object.keys(profiles).join(", ")}`);
  }
  if (Object.hasOwn(parameters, "negativePrompt")) {
    throw new Error(`image.generate parameter 'negativePrompt' is rejected for model '${model}': the profile uses no negative prompt`);
  }
  assertKeys(parameters, [...REQUIRED_FIELDS, ...OVERRIDES], "image.generate parameters");
  if (typeof parameters.prompt !== "string" || parameters.prompt.length === 0) {
    throw new Error("image.generate parameter 'prompt' must be a non-empty string");
  }
  const seed = parameters.seed;
  if (typeof seed !== "number" || !Number.isSafeInteger(seed) || seed < 0) {
    throw new Error("image.generate parameter 'seed' must be a non-negative safe integer");
  }
  const resolved: ImageGenerateParameters = {
    provider: provider as ImageGenerateProvider,
    model,
    prompt: parameters.prompt,
    seed,
    width: checkDimension("width", parameters.width),
    height: checkDimension("height", parameters.height),
  };
  for (const name of OVERRIDES) {
    if (!Object.hasOwn(parameters, name)) continue;
    const checked = checkOverride(name, parameters[name]);
    if (!profile.supportedOverrides.includes(name)) {
      throw new Error(`image.generate model '${model}' does not support the '${name}' override (supported: ${profile.supportedOverrides.join(", ")})`);
    }
    (resolved as unknown as Record<string, unknown>)[name] = checked;
  }
  for (const name of profile.supportedOverrides) {
    if (!Object.hasOwn(resolved, name)) (resolved as unknown as Record<string, unknown>)[name] = profile.defaults[name];
  }
  if (!profile.providers.includes(resolved.provider)) {
    throw new Error(
      `image.generate provider '${resolved.provider}' is not supported for model '${model}' (supported: ${profile.providers.join(", ")}); there is no fallback to another provider`,
    );
  }
  return resolved;
}

/**
 * Validate parameters and fill every profile default. Pass the result to `runAssetOperation`:
 * build identity uses these resolved values, so explicit and omitted defaults share one identity.
 */
export function resolveImageGenerateParameters(
  parameters: Record<string, unknown>,
  options: { profiles?: Readonly<Record<string, ImageGenerateModelProfile>> } = {},
): ImageGenerateParameters {
  const profiles = options.profiles === undefined
    ? IMAGE_GENERATE_MODEL_PROFILES as Record<string, ImageGenerateModelProfile>
    : parseProfiles(options.profiles);
  return resolveWith(profiles, parameters);
}

/** Parameters reaching `runAssetOperation` must already be resolved, so identity never depends on omission. */
function requireResolved(profiles: Readonly<Record<string, ImageGenerateModelProfile>>, value: unknown): ImageGenerateParameters {
  const resolved = resolveWith(profiles, value);
  if (canonicalJson(resolved as unknown as CanonicalJsonObject) !== canonicalJson(value as CanonicalJsonObject)) {
    throw new Error("image.generate parameters must be fully resolved with resolveImageGenerateParameters before running");
  }
  return resolved;
}

// ─── Registration options ───────────────────────────────────────────────────────────────────────

export interface ImageGenerateComfyUiRegistrationOptions {
  provider: "comfyui";
  /** Explicit loopback http URL of the ComfyUI server; there is no default. */
  endpoint: string;
  /** Identity from `probeComfyUiServer`; execution fails closed if the server drifted from it. */
  server: ComfyUiServerIdentity;
  /** 40-hex ComfyUI commit from the managed setup receipt, when known. */
  comfyuiCommit?: string;
  /** ComfyUI `models` directory; each pinned file is hashed at `<modelsDirectory>/<directory>/<name>`. */
  modelsDirectory: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Defaults to IMAGE_GENERATE_MODEL_PROFILES. */
  profiles?: Record<string, ImageGenerateModelProfile>;
}

export interface ImageGenerateDiffusersRegistrationOptions {
  provider: "diffusers";
  profiles?: Record<string, ImageGenerateModelProfile>;
}

export type ImageGenerateRegistrationOptions = ImageGenerateComfyUiRegistrationOptions | ImageGenerateDiffusersRegistrationOptions;

function profileIdentity(profiles: Readonly<Record<string, ImageGenerateModelProfile>>): CanonicalJsonObject {
  const identity: CanonicalJsonObject = {};
  for (const [id, profile] of Object.entries(profiles)) {
    const files: CanonicalJsonObject = {};
    for (const role of ROLES) {
      const { name, directory, sha256, byteLength } = profile.files[role];
      files[role] = { name, directory, sha256, byteLength };
    }
    identity[id] = {
      providers: [...profile.providers],
      files,
      template: {
        sha256: profile.template.sha256,
        injections: structuredClone(profile.template.injections) as CanonicalJsonObject,
        output: profile.template.output,
      },
    };
  }
  return identity;
}

function assertProvider(registered: ImageGenerateProvider, selected: ImageGenerateProvider): void {
  if (registered !== selected) {
    throw new Error(
      `image.generate parameters select provider '${selected}' but this registration provides '${registered}'; there is no fallback between providers`,
    );
  }
}

// ─── ComfyUI provider ───────────────────────────────────────────────────────────────────────────

/** Read the template, check its bytes against the profile pin and its declared injection targets. */
async function loadTemplate(profile: ImageGenerateModelProfile): Promise<Record<string, any>> {
  const file = path.resolve(PACKAGE_ROOT, profile.template.path);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    throw new Error(`image.generate template for model '${profile.id}' is missing at ${file}: ${(error as Error).message}`);
  }
  const actual = sha256Bytes(bytes);
  if (actual !== profile.template.sha256) {
    throw new Error(
      `image.generate template ${profile.template.path} for model '${profile.id}' has sha256 ${actual}, but the profile pins ${profile.template.sha256}`,
    );
  }
  const prompt = assertRecord(JSON.parse(bytes.toString("utf8")), `image.generate template ${profile.template.path}`);
  for (const [name, binding] of Object.entries(profile.template.injections) as [string, ImageGenerateTemplateBinding][]) {
    const node = prompt[binding.node];
    if (!isRecord(node) || !isRecord(node.inputs) || !Object.hasOwn(node.inputs, binding.input) || Array.isArray(node.inputs[binding.input])) {
      throw new Error(`image.generate template ${profile.template.path} has no literal input '${binding.input}' on node '${binding.node}' for injection '${name}'`);
    }
  }
  const output = prompt[profile.template.output];
  if (!isRecord(output) || output.class_type !== "SaveImage") {
    throw new Error(`image.generate template ${profile.template.path} output node '${profile.template.output}' is not a SaveImage node`);
  }
  return prompt;
}

function injectValues(prompt: Record<string, any>, profile: ImageGenerateModelProfile, parameters: ImageGenerateParameters): Record<string, any> {
  const injections = profile.template.injections;
  for (const role of ROLES) {
    const binding = injections[role]!;
    prompt[binding.node].inputs[binding.input] = profile.files[role].name;
  }
  for (const name of VALUE_INJECTIONS) {
    const value = (parameters as unknown as Record<string, unknown>)[name];
    if (value === undefined) continue;
    const binding = injections[name]!;
    prompt[binding.node].inputs[binding.input] = value;
  }
  return prompt;
}

function createComfyUiRegistration(
  config: Record<string, unknown>,
  profiles: Readonly<Record<string, ImageGenerateModelProfile>>,
): AssetOperationRunRegistration {
  assertKeys(
    config,
    ["provider", "endpoint", "server", "comfyuiCommit", "modelsDirectory", "timeoutMs", "pollIntervalMs", "profiles"],
    "image.generate ComfyUI registration options",
  );
  const endpoint = normalizeEndpoint(config.endpoint);
  const serverValue = assertRecord(config.server, "image.generate ComfyUI registration server identity");
  assertString(serverValue.comfyuiVersion, "image.generate ComfyUI registration server.comfyuiVersion");
  const serverJson = canonicalJson(serverValue as CanonicalJsonObject);
  const server = JSON.parse(serverJson) as CanonicalJsonObject;
  const comfyuiCommit = config.comfyuiCommit;
  if (comfyuiCommit !== undefined && (typeof comfyuiCommit !== "string" || !COMMIT_PATTERN.test(comfyuiCommit))) {
    throw new Error("image.generate ComfyUI registration comfyuiCommit must be a lowercase 40-character commit");
  }
  const modelsDirectory = path.resolve(assertString(config.modelsDirectory, "image.generate ComfyUI registration modelsDirectory"));
  const timeoutMs = assertPositiveInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "image.generate ComfyUI registration timeoutMs");
  const pollIntervalMs = assertPositiveInteger(config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "image.generate ComfyUI registration pollIntervalMs");

  const implementation: CanonicalJsonObject = {
    id: IMPLEMENTATION_ID,
    version: IMPLEMENTATION_VERSION,
    provider: "comfyui",
    server,
    ...(comfyuiCommit !== undefined ? { comfyuiCommit } : {}),
    profiles: profileIdentity(profiles),
    reproducibility: "approximate",
  };

  // Signatures of the model files the immediately preceding `verifyDependencies` hashed. Only the
  // `execute` that follows it may reuse them (when the signature is unchanged), as
  // image.comfyui.generate@1 does; every other check, including every cache hit, re-hashes the files,
  // so a rewrite that preserves size and timestamps is still detected.
  const verified = new Map<string, string>();
  async function verifyModelFiles(profile: ImageGenerateModelProfile): Promise<void> {
    for (const role of ROLES) {
      const pin = profile.files[role];
      const file = path.join(modelsDirectory, ...pin.directory.split("/"), ...pin.name.split("/"));
      const known = verified.get(file);
      if (known !== undefined && known === (await pinnedFileSignature(file, pin.sha256))) continue;
      verified.delete(file);
      verified.set(file, await verifyPinnedFile(file, pin, `image.generate ${profile.id} ${role} model file`));
    }
  }

  async function preflight(value: unknown): Promise<{ parameters: ImageGenerateParameters; profile: ImageGenerateModelProfile; prompt: Record<string, any> }> {
    const parameters = requireResolved(profiles, value);
    assertProvider("comfyui", parameters.provider);
    const profile = profiles[parameters.model]!;
    const prompt = await loadTemplate(profile);
    await verifyModelFiles(profile);
    return { parameters, profile, prompt };
  }

  return {
    descriptor: IMAGE_GENERATE_OPERATION,
    implementation,
    // Runs before every cache lookup (hits included): template and model files must still match.
    async verifyDependencies(_root, invocation): Promise<void> {
      verified.clear();
      await preflight(invocation?.parameters);
    },
    async execute(root, invocation): Promise<AssetOperationResult> {
      // 1. Local preflight: resolved parameters, pinned template bytes, pinned model files.
      let checked: Awaited<ReturnType<typeof preflight>>;
      try {
        checked = await preflight(invocation?.parameters);
      } finally {
        verified.clear();
      }
      const { parameters, profile, prompt } = checked;
      const submitted = injectValues(prompt, profile, parameters);

      // 2. The server must still be the one this registration was created for.
      const deadline = Date.now() + timeoutMs;
      await assertServerIdentityUnchanged(endpoint, serverJson, timeoutMs);

      // 3. Submit once; await this prompt's history; fetch the declared output exactly once.
      const clientId = `asset-tooling-${randomUUID()}`;
      const promptId = await submitPrompt(endpoint, submitted, clientId, deadline - Date.now());
      const image = await awaitOutput(endpoint, promptId, profile.template.output, deadline, pollIntervalMs);
      const bytes = await fetchOutput(endpoint, promptId, image, deadline);

      // 4. Verify and import the actual bytes.
      verifyPng(bytes, promptId, parameters.width, parameters.height);
      const stored = await storeAssetObject(root, {
        bytes,
        kind: "image",
        mediaType: "image/png",
        metadata: { width: parameters.width, height: parameters.height },
      });

      const comfyui: CanonicalJsonObject = { version: server.comfyuiVersion as string };
      if (comfyuiCommit !== undefined) comfyui.commit = comfyuiCommit;
      return {
        outputs: { image: stored.asset },
        observations: {
          provider: "comfyui",
          model: profile.id,
          reproducibility: "approximate",
          parameters: { ...parameters } as unknown as CanonicalJsonObject,
          promptId,
          clientId,
          template: { path: profile.template.path, sha256: profile.template.sha256 },
          files: structuredClone(profile.files) as unknown as CanonicalJsonObject,
          submittedPrompt: { sha256: sha256Text(canonicalJson(submitted)) },
          comfyui,
          output: {
            node: profile.template.output,
            filename: image.filename,
            subfolder: image.subfolder,
            type: image.type,
            sha256: sha256Bytes(bytes),
          },
        },
      };
    },
  };
}

// ─── Diffusers provider ─────────────────────────────────────────────────────────────────────────

function createDiffusersRegistration(
  config: Record<string, unknown>,
  profiles: Readonly<Record<string, ImageGenerateModelProfile>>,
): AssetOperationRunRegistration {
  assertKeys(config, ["provider", "profiles"], "image.generate Diffusers registration options");
  // Fails visibly for every profile that does not list Diffusers; none does yet (follow-up to #222).
  const reject = (value: unknown): never => {
    const parameters = resolveWith(profiles, value);
    assertProvider("diffusers", parameters.provider);
    throw new Error(`image.generate provider 'diffusers' is not supported for model '${parameters.model}' yet; there is no fallback to another provider`);
  };
  return {
    descriptor: IMAGE_GENERATE_OPERATION,
    implementation: {
      id: IMPLEMENTATION_ID,
      version: IMPLEMENTATION_VERSION,
      provider: "diffusers",
      profiles: profileIdentity(profiles),
    },
    async verifyDependencies(_root, invocation): Promise<void> {
      reject(invocation?.parameters);
    },
    async execute(_root, invocation): Promise<AssetOperationResult> {
      return reject(invocation?.parameters);
    },
  };
}

/**
 * Create the `runAssetOperation` registration for `image.generate@1` and one explicit provider.
 * Performs no network or file I/O.
 */
export function createImageGenerateRegistration(options: ImageGenerateRegistrationOptions): AssetOperationRunRegistration {
  const config = assertRecord(options, "image.generate registration options");
  const profiles = parseProfiles(config.profiles);
  if (config.provider === "comfyui") return createComfyUiRegistration(config, profiles);
  if (config.provider === "diffusers") return createDiffusersRegistration(config, profiles);
  throw new Error(`image.generate registration provider must be one of ${PROVIDERS.join(", ")}, got ${JSON.stringify(config.provider ?? null)}`);
}
