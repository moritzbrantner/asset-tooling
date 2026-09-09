import path from "node:path";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { canonicalJson, stablePrettyJson } from "./canonical.js";
import { getBackend } from "./backends.js";
import { captureEnvironment } from "./environment.js";
import { sha256Bytes, sha256File, sha256Text } from "./hash.js";
import { assertPortableRelativePath, parseGenerationReceipt, readAssetSpec, resolveSpecPath } from "./schema.js";
import { captureToolIdentity } from "./tool.js";

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeIfChanged(filePath, bytes) {
  if (await fileExists(filePath)) {
    const current = await readFile(filePath);
    if (current.equals(Buffer.from(bytes))) {
      return false;
    }
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  return true;
}

async function verifyDeclaredArtifacts(specDocument) {
  for (const [name, input] of Object.entries(specDocument.spec.inputs)) {
    const actual = await sha256File(resolveSpecPath(specDocument.root, input.path));
    if (actual !== input.sha256) {
      throw new Error(`input '${name}' hash mismatch: expected ${input.sha256}, got ${actual}`);
    }
  }
  for (const [name, model] of Object.entries(specDocument.spec.models)) {
    const actual = await sha256File(resolveSpecPath(specDocument.root, model.path));
    if (actual !== model.sha256) {
      throw new Error(`model '${name}' hash mismatch: expected ${model.sha256}, got ${actual}`);
    }
  }
}

function defaultReceiptPath(spec) {
  return `${spec.output.path}.receipt.json`;
}

function receiptPortablePath(spec, receiptPath) {
  return assertPortableRelativePath(receiptPath ?? defaultReceiptPath(spec), "receipt path");
}

async function filesystemIdentity(filePath) {
  let resolved;
  try {
    resolved = await realpath(filePath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    const parent = path.dirname(filePath);
    if (parent === filePath) throw error;
    resolved = path.join(await filesystemIdentity(parent), path.basename(filePath));
  }
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

async function assertDistinctReceiptPath(document, receiptPath) {
  const receiptAbsolutePath = resolveSpecPath(document.root, receiptPath);
  const protectedPaths = new Map([
    [document.absolutePath, "asset spec"],
    [resolveSpecPath(document.root, document.spec.output.path), "output"],
  ]);
  for (const [name, input] of Object.entries(document.spec.inputs)) {
    protectedPaths.set(resolveSpecPath(document.root, input.path), `input '${name}'`);
  }
  for (const [name, model] of Object.entries(document.spec.models)) {
    protectedPaths.set(resolveSpecPath(document.root, model.path), `model '${name}'`);
  }

  const receiptIdentity = await filesystemIdentity(receiptAbsolutePath);
  for (const [protectedPath, description] of protectedPaths) {
    if ((await filesystemIdentity(protectedPath)) === receiptIdentity) {
      throw new Error(`receipt path must not collide with ${description}`);
    }
  }
  return receiptAbsolutePath;
}

async function buildReceipt(specDocument, outputSha256) {
  const backend = getBackend(specDocument.spec.generator);
  const environment = await captureEnvironment(await backend.environmentComponents(specDocument));
  const tool = await captureToolIdentity();
  const expected = specDocument.spec.reproducibility.expected;
  const reasons = [];
  let baseline = "constrained";

  if (!backend.exactCapable) {
    baseline = "approximate";
    reasons.push("generator backend does not declare exact reproducibility capability");
  } else if (expected === "approximate") {
    baseline = "approximate";
    reasons.push("asset specification requests approximate reproducibility");
  }

  return {
    schemaVersion: 1,
    assetId: specDocument.spec.assetId,
    spec: {
      sha256: specDocument.sha256,
      canonicalizer: "asset-tooling-canonical-json-v1",
    },
    tool,
    generator: specDocument.spec.generator,
    randomness: specDocument.spec.randomness,
    inputs: specDocument.spec.inputs,
    models: specDocument.spec.models,
    parametersSha256: sha256Text(canonicalJson(specDocument.spec.parameters)),
    environment,
    output: {
      path: specDocument.spec.output.path,
      sha256: outputSha256,
    },
    reproducibility: {
      expected,
      baseline,
      reasons,
    },
  };
}

export async function validateSpec(specPath) {
  const document = await readAssetSpec(specPath);
  const backend = getBackend(document.spec.generator);
  backend.validate(document);
  return {
    status: "valid",
    assetId: document.spec.assetId,
    specSha256: document.sha256,
  };
}

export async function generateAsset(specPath, options = {}) {
  const document = await readAssetSpec(specPath);
  const backend = getBackend(document.spec.generator);
  backend.validate(document);
  const receiptPath = receiptPortablePath(document.spec, options.receiptPath);
  const receiptAbsolutePath = await assertDistinctReceiptPath(document, receiptPath);
  await verifyDeclaredArtifacts(document);

  const outputBytes = await backend.generate(document);
  const outputSha256 = sha256Bytes(outputBytes);
  const outputAbsolutePath = resolveSpecPath(document.root, document.spec.output.path);
  const outputChanged = await writeIfChanged(outputAbsolutePath, outputBytes);

  const receipt = await buildReceipt(document, outputSha256);
  const receiptChanged = await writeIfChanged(receiptAbsolutePath, Buffer.from(stablePrettyJson(receipt), "utf8"));

  return {
    status: outputChanged || receiptChanged ? "changed" : "unchanged",
    outputChanged,
    receiptChanged,
    outputSha256,
    receiptPath,
    receipt,
  };
}

export async function verifyAsset(specPath, options = {}) {
  try {
    const document = await readAssetSpec(specPath);
    const backend = getBackend(document.spec.generator);
    backend.validate(document);
    const receiptPath = receiptPortablePath(document.spec, options.receiptPath);
    const receiptAbsolutePath = await assertDistinctReceiptPath(document, receiptPath);
    await verifyDeclaredArtifacts(document);
    const receipt = parseGenerationReceipt(JSON.parse(await readFile(receiptAbsolutePath, "utf8")));

    const outputAbsolutePath = resolveSpecPath(document.root, document.spec.output.path);
    const acceptedOutputSha256 = await sha256File(outputAbsolutePath);
    const regeneratedBytes = await backend.generate(document);
    const regeneratedOutputSha256 = sha256Bytes(regeneratedBytes);
    const currentEnvironment = await captureEnvironment(await backend.environmentComponents(document));

    const checks = {
      assetIdMatches: receipt.assetId === document.spec.assetId,
      specMatchesReceipt: receipt.spec.sha256 === document.sha256,
      outputPathMatches: receipt.output.path === document.spec.output.path,
      acceptedOutputMatchesReceipt: acceptedOutputSha256 === receipt.output.sha256,
      regeneratedOutputMatchesReceipt: regeneratedOutputSha256 === receipt.output.sha256,
      environmentMatchesReceipt: currentEnvironment.sha256 === receipt.environment.sha256,
    };

    const artifactChecks = [
      checks.assetIdMatches,
      checks.specMatchesReceipt,
      checks.outputPathMatches,
      checks.acceptedOutputMatchesReceipt,
      checks.regeneratedOutputMatchesReceipt,
    ];

    const status = artifactChecks.every(Boolean) ? "exact" : "drift";
    return {
      status,
      checks,
      acceptedOutputSha256,
      regeneratedOutputSha256,
      receiptEnvironmentSha256: receipt.environment.sha256,
      currentEnvironmentSha256: currentEnvironment.sha256,
    };
  } catch (error) {
    return {
      status: "broken",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
