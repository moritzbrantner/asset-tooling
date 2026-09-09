import { readFile } from "node:fs/promises";
import { canonicalJson, stablePrettyJson } from "./canonical.js";
import { getBackend } from "./backends.js";
import { normalizeGenerationResult, receiptGenerator } from "./backend-contract.js";
import { captureEnvironment } from "./environment.js";
import { sha256Bytes, sha256File, sha256Text } from "./hash.js";
import { assertSafeMutationPaths, writeIfChanged } from "./mutation-safety.js";
import { parseGenerationReceipt } from "./receipts.js";
import { assertPortableRelativePath, readAssetSpec, resolveSpecPath } from "./schema.js";
import { captureToolIdentity } from "./tool.js";

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

async function generationMutationPaths(document, receiptPath) {
  const protectedArtifacts = [];
  for (const [name, input] of Object.entries(document.spec.inputs)) {
    protectedArtifacts.push({
      absolutePath: resolveSpecPath(document.root, input.path),
      description: `input '${name}'`,
    });
  }
  for (const [name, model] of Object.entries(document.spec.models)) {
    protectedArtifacts.push({
      absolutePath: resolveSpecPath(document.root, model.path),
      description: `model '${name}'`,
    });
  }
  return assertSafeMutationPaths({
    root: document.root,
    specAbsolutePath: document.absolutePath,
    specDescription: "asset spec",
    outputPortablePath: document.spec.output.path,
    receiptPortablePath: receiptPath,
    resolvePortablePath: resolveSpecPath,
    protectedArtifacts,
  });
}

function expectedReproducibility(specDocument, backend) {
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
  return { expected, baseline, reasons };
}

async function buildReceipt(specDocument, backend, outputSha256, observations) {
  const environment = await captureEnvironment(await backend.environmentComponents(specDocument));
  const tool = await captureToolIdentity();

  return {
    schemaVersion: 2,
    assetId: specDocument.spec.assetId,
    spec: {
      sha256: specDocument.sha256,
      canonicalizer: "asset-tooling-canonical-json-v1",
    },
    tool,
    generator: receiptGenerator(specDocument.spec.generator, backend),
    randomness: specDocument.spec.randomness,
    inputs: specDocument.spec.inputs,
    models: specDocument.spec.models,
    parameters: specDocument.spec.parameters,
    parametersSha256: sha256Text(canonicalJson(specDocument.spec.parameters)),
    observations,
    environment,
    output: {
      path: specDocument.spec.output.path,
      sha256: outputSha256,
    },
    reproducibility: expectedReproducibility(specDocument, backend),
  };
}

export async function validateSpec(specPath) {
  const document = await readAssetSpec(specPath);
  const backend = getBackend(document.spec.generator);
  backend.validate(document);
  receiptGenerator(document.spec.generator, backend);
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
  receiptGenerator(document.spec.generator, backend);
  const receiptPath = receiptPortablePath(document.spec, options.receiptPath);
  const { outputAbsolutePath, receiptAbsolutePath } = await generationMutationPaths(document, receiptPath);
  await verifyDeclaredArtifacts(document);

  const generated = normalizeGenerationResult(await backend.generate(document), backend.id);
  const outputSha256 = sha256Bytes(generated.bytes);
  const outputChanged = await writeIfChanged(outputAbsolutePath, generated.bytes);

  const receipt = await buildReceipt(document, backend, outputSha256, generated.observations);
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
    receiptGenerator(document.spec.generator, backend);
    const receiptPath = receiptPortablePath(document.spec, options.receiptPath);
    const { outputAbsolutePath, receiptAbsolutePath } = await generationMutationPaths(document, receiptPath);
    await verifyDeclaredArtifacts(document);
    const receipt = parseGenerationReceipt(JSON.parse(await readFile(receiptAbsolutePath, "utf8")));

    const acceptedOutputSha256 = await sha256File(outputAbsolutePath);
    const regenerated = normalizeGenerationResult(await backend.generate(document), backend.id);
    const regeneratedOutputSha256 = sha256Bytes(regenerated.bytes);
    const currentEnvironment = await captureEnvironment(await backend.environmentComponents(document));
    const currentTool = await captureToolIdentity();
    const receiptEnvironmentFingerprint = {
      schemaVersion: receipt.environment.schemaVersion,
      platform: receipt.environment.platform,
      runtime: receipt.environment.runtime,
      components: receipt.environment.components,
    };
    const expectedGenerator = receipt.schemaVersion === 1
      ? document.spec.generator
      : receiptGenerator(document.spec.generator, backend);
    const expectedParametersSha256 = sha256Text(canonicalJson(document.spec.parameters));

    const checks = {
      assetIdMatches: receipt.assetId === document.spec.assetId,
      specMatchesReceipt: receipt.spec.sha256 === document.sha256,
      outputPathMatches: receipt.output.path === document.spec.output.path,
      acceptedOutputMatchesReceipt: acceptedOutputSha256 === receipt.output.sha256,
      regeneratedOutputMatchesReceipt: regeneratedOutputSha256 === receipt.output.sha256,
      toolMatchesReceipt: canonicalJson(currentTool) === canonicalJson(receipt.tool),
      generatorMatchesReceipt: canonicalJson(expectedGenerator) === canonicalJson(receipt.generator),
      randomnessMatchesReceipt: canonicalJson(document.spec.randomness) === canonicalJson(receipt.randomness),
      inputsMatchReceipt: canonicalJson(document.spec.inputs) === canonicalJson(receipt.inputs),
      modelsMatchReceipt: canonicalJson(document.spec.models) === canonicalJson(receipt.models),
      parametersMatchReceipt:
        expectedParametersSha256 === receipt.parametersSha256 &&
        (receipt.schemaVersion === 1 || canonicalJson(document.spec.parameters) === canonicalJson(receipt.parameters)),
      observationsMatchReceipt:
        receipt.schemaVersion === 1 || canonicalJson(regenerated.observations) === canonicalJson(receipt.observations),
      reproducibilityMatchesReceipt:
        canonicalJson(expectedReproducibility(document, backend)) === canonicalJson(receipt.reproducibility),
      receiptEnvironmentFingerprintValid:
        sha256Text(canonicalJson(receiptEnvironmentFingerprint)) === receipt.environment.sha256,
      environmentMatchesReceipt: currentEnvironment.sha256 === receipt.environment.sha256,
    };

    const artifactChecks = [
      checks.assetIdMatches,
      checks.specMatchesReceipt,
      checks.outputPathMatches,
      checks.acceptedOutputMatchesReceipt,
      checks.regeneratedOutputMatchesReceipt,
      checks.toolMatchesReceipt,
      checks.generatorMatchesReceipt,
      checks.randomnessMatchesReceipt,
      checks.inputsMatchReceipt,
      checks.modelsMatchReceipt,
      checks.parametersMatchReceipt,
      checks.observationsMatchReceipt,
      checks.reproducibilityMatchesReceipt,
      checks.receiptEnvironmentFingerprintValid,
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
