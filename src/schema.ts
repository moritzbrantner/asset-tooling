import path from "node:path";
import { readFile } from "node:fs/promises";
import { canonicalJson, type CanonicalJsonValue } from "./canonical.js";
import type { GeneratorIdentity } from "./backend-contract.js";
import { sha256Text } from "./hash.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_SEED_PATTERN = /^(0|[1-9][0-9]*)$/;

type PlainObject = Record<string, unknown>;
export type AssetSpecParameters = Record<string, CanonicalJsonValue>;

export type AssetRandomness =
  | { mode: "none" }
  | { mode: "seeded"; seed: string };

export interface AssetArtifactReference {
  path: string;
  sha256: string;
}

export interface AssetModelReference extends AssetArtifactReference {
  id: string;
}

export type AssetArtifactMap = Record<string, AssetArtifactReference>;
export type AssetModelMap = Record<string, AssetModelReference>;

export interface AssetSpec {
  schemaVersion: 1;
  assetId: string;
  generator: GeneratorIdentity;
  randomness: AssetRandomness;
  inputs: AssetArtifactMap;
  models: AssetModelMap;
  parameters: AssetSpecParameters;
  output: {
    path: string;
  };
  reproducibility: {
    expected: "exact" | "approximate";
  };
}

export interface AssetSpecDocument {
  spec: AssetSpec;
  absolutePath: string;
  root: string;
  canonical: string;
  sha256: string;
}

export interface GenerationReceiptV1 {
  schemaVersion: 1;
  assetId: string;
  spec: {
    sha256: string;
    canonicalizer: "asset-tooling-canonical-json-v1";
  };
  tool: {
    name: "asset-tooling";
    version: string;
    sourceFingerprint: {
      algorithm: "sha256-tree-v1";
      sha256: string;
    };
  };
  generator: GeneratorIdentity;
  randomness: AssetRandomness;
  inputs: AssetArtifactMap;
  models: AssetModelMap;
  parametersSha256: string;
  environment: {
    schemaVersion: 1;
    platform: {
      os: string;
      arch: string;
    };
    runtime: {
      name: string;
      version: string;
      executableSha256: string;
    };
    components: PlainObject[];
    sha256: string;
  };
  output: {
    path: string;
    sha256: string;
  };
  reproducibility: {
    expected: "exact" | "approximate";
    baseline: "constrained" | "approximate";
    reasons: string[];
  };
}

function isObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, location: string): PlainObject {
  if (!isObject(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value;
}

function assertExactKeys(value: PlainObject, allowed: ReadonlySet<string>, location: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${location} contains unknown field '${key}'`);
    }
  }
}

function assertNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function assertSha256(value: unknown, location: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${location} must be a lowercase 64-character SHA-256 digest`);
  }
  return value;
}

export function assertPortableRelativePath(value: unknown, location: string): string {
  const candidate = assertNonEmptyString(value, location);
  if (candidate.includes("\\")) {
    throw new Error(`${location} must use '/' separators`);
  }
  if (/^[A-Za-z]:/.test(candidate)) {
    throw new Error(`${location} must not be drive-qualified`);
  }
  if (path.posix.isAbsolute(candidate)) {
    throw new Error(`${location} must be relative`);
  }

  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${location} must not contain empty, '.' or '..' segments`);
  }
  return candidate;
}

function parseGenerator(value: unknown): GeneratorIdentity {
  const generator = assertObject(value, "generator");
  assertExactKeys(generator, new Set(["id", "version"]), "generator");
  return {
    id: assertNonEmptyString(generator.id, "generator.id"),
    version: assertNonEmptyString(generator.version, "generator.version"),
  };
}

function parseRandomness(value: unknown): AssetRandomness {
  const randomness = assertObject(value, "randomness");
  if (randomness.mode === "none") {
    assertExactKeys(randomness, new Set(["mode"]), "randomness");
    return { mode: "none" };
  }
  if (randomness.mode === "seeded") {
    assertExactKeys(randomness, new Set(["mode", "seed"]), "randomness");
    if (typeof randomness.seed !== "string" || !DECIMAL_SEED_PATTERN.test(randomness.seed)) {
      throw new Error("randomness.seed must be a non-negative decimal integer encoded as a string");
    }
    return { mode: "seeded", seed: randomness.seed };
  }
  throw new Error("randomness.mode must be 'none' or 'seeded'");
}

type ArtifactFor<WithId extends boolean> = WithId extends true
  ? AssetModelReference
  : AssetArtifactReference;

function parseArtifactMap<WithId extends boolean>(
  value: unknown,
  location: string,
  withId: WithId,
): Record<string, ArtifactFor<WithId>> {
  const map = assertObject(value, location);
  const result: Record<string, ArtifactFor<WithId>> = {};
  for (const name of Object.keys(map).sort()) {
    assertNonEmptyString(name, `${location} key`);
    const artifact = assertObject(map[name], `${location}.${name}`);
    const keys = withId ? new Set(["id", "path", "sha256"]) : new Set(["path", "sha256"]);
    assertExactKeys(artifact, keys, `${location}.${name}`);
    const parsed = withId
      ? {
          id: assertNonEmptyString(artifact.id, `${location}.${name}.id`),
          path: assertPortableRelativePath(artifact.path, `${location}.${name}.path`),
          sha256: assertSha256(artifact.sha256, `${location}.${name}.sha256`),
        }
      : {
          path: assertPortableRelativePath(artifact.path, `${location}.${name}.path`),
          sha256: assertSha256(artifact.sha256, `${location}.${name}.sha256`),
        };
    result[name] = parsed as ArtifactFor<WithId>;
  }
  return result;
}

function parseOutput(value: unknown): AssetSpec["output"] {
  const output = assertObject(value, "output");
  assertExactKeys(output, new Set(["path"]), "output");
  return { path: assertPortableRelativePath(output.path, "output.path") };
}

function parseReproducibility(value: unknown): AssetSpec["reproducibility"] {
  const reproducibility = assertObject(value, "reproducibility");
  assertExactKeys(reproducibility, new Set(["expected"]), "reproducibility");
  if (reproducibility.expected !== "exact" && reproducibility.expected !== "approximate") {
    throw new Error("reproducibility.expected must be 'exact' or 'approximate'");
  }
  return { expected: reproducibility.expected };
}

export function parseGenerationReceipt(value: unknown): GenerationReceiptV1 {
  const receipt = assertObject(value, "receipt");
  assertExactKeys(
    receipt,
    new Set([
      "schemaVersion",
      "assetId",
      "spec",
      "tool",
      "generator",
      "randomness",
      "inputs",
      "models",
      "parametersSha256",
      "environment",
      "output",
      "reproducibility",
    ]),
    "receipt",
  );
  if (receipt.schemaVersion !== 1) throw new Error("receipt schemaVersion must be 1");

  const spec = assertObject(receipt.spec, "receipt.spec");
  assertExactKeys(spec, new Set(["sha256", "canonicalizer"]), "receipt.spec");
  if (spec.canonicalizer !== "asset-tooling-canonical-json-v1") {
    throw new Error("receipt.spec.canonicalizer is unsupported");
  }

  const tool = assertObject(receipt.tool, "receipt.tool");
  assertExactKeys(tool, new Set(["name", "version", "sourceFingerprint"]), "receipt.tool");
  if (tool.name !== "asset-tooling") throw new Error("receipt.tool.name must be 'asset-tooling'");
  const sourceFingerprint = assertObject(tool.sourceFingerprint, "receipt.tool.sourceFingerprint");
  assertExactKeys(
    sourceFingerprint,
    new Set(["algorithm", "sha256"]),
    "receipt.tool.sourceFingerprint",
  );
  if (sourceFingerprint.algorithm !== "sha256-tree-v1") {
    throw new Error("receipt.tool.sourceFingerprint.algorithm is unsupported");
  }

  const environment = assertObject(receipt.environment, "receipt.environment");
  assertExactKeys(
    environment,
    new Set(["schemaVersion", "platform", "runtime", "components", "sha256"]),
    "receipt.environment",
  );
  if (environment.schemaVersion !== 1) {
    throw new Error("receipt.environment.schemaVersion must be 1");
  }
  const platform = assertObject(environment.platform, "receipt.environment.platform");
  assertExactKeys(platform, new Set(["os", "arch"]), "receipt.environment.platform");
  const runtime = assertObject(environment.runtime, "receipt.environment.runtime");
  assertExactKeys(
    runtime,
    new Set(["name", "version", "executableSha256"]),
    "receipt.environment.runtime",
  );
  if (!Array.isArray(environment.components)) {
    throw new Error("receipt.environment.components must be an array");
  }
  const components = environment.components.map((component, index) =>
    assertObject(component, `receipt.environment.components[${index}]`),
  );

  const output = assertObject(receipt.output, "receipt.output");
  assertExactKeys(output, new Set(["path", "sha256"]), "receipt.output");

  const reproducibility = assertObject(receipt.reproducibility, "receipt.reproducibility");
  assertExactKeys(
    reproducibility,
    new Set(["expected", "baseline", "reasons"]),
    "receipt.reproducibility",
  );
  if (reproducibility.expected !== "exact" && reproducibility.expected !== "approximate") {
    throw new Error("receipt.reproducibility.expected is invalid");
  }
  if (reproducibility.baseline !== "constrained" && reproducibility.baseline !== "approximate") {
    throw new Error("receipt.reproducibility.baseline is invalid");
  }
  if (
    !Array.isArray(reproducibility.reasons) ||
    reproducibility.reasons.some((reason) => typeof reason !== "string")
  ) {
    throw new Error("receipt.reproducibility.reasons must be an array of strings");
  }
  const reasons = reproducibility.reasons as string[];

  return {
    schemaVersion: 1,
    assetId: assertNonEmptyString(receipt.assetId, "receipt.assetId"),
    spec: {
      sha256: assertSha256(spec.sha256, "receipt.spec.sha256"),
      canonicalizer: "asset-tooling-canonical-json-v1",
    },
    tool: {
      name: "asset-tooling",
      version: assertNonEmptyString(tool.version, "receipt.tool.version"),
      sourceFingerprint: {
        algorithm: "sha256-tree-v1",
        sha256: assertSha256(
          sourceFingerprint.sha256,
          "receipt.tool.sourceFingerprint.sha256",
        ),
      },
    },
    generator: parseGenerator(receipt.generator),
    randomness: parseRandomness(receipt.randomness),
    inputs: parseArtifactMap(receipt.inputs, "receipt.inputs", false),
    models: parseArtifactMap(receipt.models, "receipt.models", true),
    parametersSha256: assertSha256(receipt.parametersSha256, "receipt.parametersSha256"),
    environment: {
      schemaVersion: 1,
      platform: {
        os: assertNonEmptyString(platform.os, "receipt.environment.platform.os"),
        arch: assertNonEmptyString(platform.arch, "receipt.environment.platform.arch"),
      },
      runtime: {
        name: assertNonEmptyString(runtime.name, "receipt.environment.runtime.name"),
        version: assertNonEmptyString(runtime.version, "receipt.environment.runtime.version"),
        executableSha256: assertSha256(
          runtime.executableSha256,
          "receipt.environment.runtime.executableSha256",
        ),
      },
      components,
      sha256: assertSha256(environment.sha256, "receipt.environment.sha256"),
    },
    output: {
      path: assertPortableRelativePath(output.path, "receipt.output.path"),
      sha256: assertSha256(output.sha256, "receipt.output.sha256"),
    },
    reproducibility: {
      expected: reproducibility.expected,
      baseline: reproducibility.baseline,
      reasons: [...reasons],
    },
  };
}

function assertJsonValue(value: unknown, location: string): asserts value is CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${location} contains a non-finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${location}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${location}.${key}`);
    }
    return;
  }
  throw new Error(`${location} contains unsupported JSON value type '${typeof value}'`);
}

export function parseAssetSpec(value: unknown): AssetSpec {
  const spec = assertObject(value, "asset spec");
  assertExactKeys(
    spec,
    new Set([
      "schemaVersion",
      "assetId",
      "generator",
      "randomness",
      "inputs",
      "models",
      "parameters",
      "output",
      "reproducibility",
    ]),
    "asset spec",
  );

  if (spec.schemaVersion !== 1) {
    throw new Error("asset spec schemaVersion must be 1");
  }

  const parameters = assertObject(spec.parameters, "parameters");
  assertJsonValue(parameters, "parameters");

  return {
    schemaVersion: 1,
    assetId: assertNonEmptyString(spec.assetId, "assetId"),
    generator: parseGenerator(spec.generator),
    randomness: parseRandomness(spec.randomness),
    inputs: parseArtifactMap(spec.inputs, "inputs", false),
    models: parseArtifactMap(spec.models, "models", true),
    parameters: parameters as AssetSpecParameters,
    output: parseOutput(spec.output),
    reproducibility: parseReproducibility(spec.reproducibility),
  };
}

export async function readAssetSpec(specPath: string): Promise<AssetSpecDocument> {
  const absolutePath = path.resolve(specPath);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  const spec = parseAssetSpec(parsed);
  const canonical = canonicalJson(spec);
  return {
    spec,
    absolutePath,
    root: path.dirname(absolutePath),
    canonical,
    sha256: sha256Text(canonical),
  };
}

export function resolveSpecPath(root: string, portablePath: string): string {
  return path.join(root, ...portablePath.split("/"));
}
