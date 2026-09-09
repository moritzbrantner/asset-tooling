import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { canonicalJson } from "./canonical.js";
import { sha256File, sha256Text } from "./hash.js";
import { parseGenerationReceipt } from "./receipts.js";
import { assertPortableRelativePath, readAssetSpec, resolveSpecPath } from "./schema.js";

function defaultGenerationReceiptPath(spec) {
  return `${spec.output.path}.receipt.json`;
}

async function assertRegularFileWithoutSymlink(root, portablePath, description) {
  let prefix = root;
  for (const segment of portablePath.split("/")) {
    prefix = path.join(prefix, segment);
    const metadata = await lstat(prefix);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${description} must not contain symbolic links`);
    }
  }
  if (!(await lstat(resolveSpecPath(root, portablePath))).isFile()) {
    throw new Error(`${description} must be a regular file`);
  }
}

function assertReceiptMatchesSpec(document, receipt) {
  if (receipt.assetId !== document.spec.assetId) {
    throw new Error("generation receipt assetId does not match the asset spec");
  }
  if (receipt.spec.sha256 !== document.sha256) {
    throw new Error("generation receipt spec hash does not match the asset spec");
  }
  if (receipt.output.path !== document.spec.output.path) {
    throw new Error("generation receipt output path does not match the asset spec");
  }
  if (canonicalJson(receipt.randomness) !== canonicalJson(document.spec.randomness)) {
    throw new Error("generation receipt randomness does not match the asset spec");
  }
  if (canonicalJson(receipt.inputs) !== canonicalJson(document.spec.inputs)) {
    throw new Error("generation receipt inputs do not match the asset spec");
  }
  if (canonicalJson(receipt.models) !== canonicalJson(document.spec.models)) {
    throw new Error("generation receipt models do not match the asset spec");
  }
  if (receipt.schemaVersion >= 2 && canonicalJson(receipt.parameters) !== canonicalJson(document.spec.parameters)) {
    throw new Error("generation receipt parameters do not match the asset spec");
  }
  const expectedParametersSha256 = sha256Text(canonicalJson(document.spec.parameters));
  if (receipt.parametersSha256 !== expectedParametersSha256) {
    throw new Error("generation receipt parameter hash does not match the asset spec");
  }
}

export async function prepareProcessingHandoff(specPath, options = {}) {
  const document = await readAssetSpec(specPath);
  const receiptPath = assertPortableRelativePath(
    options.receiptPath ?? defaultGenerationReceiptPath(document.spec),
    "generation receipt path",
  );
  if (typeof options.mediaType !== "string" || options.mediaType.length === 0) {
    throw new Error("processing handoff mediaType must be a non-empty string");
  }

  await assertRegularFileWithoutSymlink(document.root, document.spec.output.path, "generation output");
  await assertRegularFileWithoutSymlink(document.root, receiptPath, "generation receipt");

  const receiptAbsolutePath = resolveSpecPath(document.root, receiptPath);
  const outputAbsolutePath = resolveSpecPath(document.root, document.spec.output.path);
  const receiptBytes = await readFile(receiptAbsolutePath);
  let parsedReceipt;
  try {
    parsedReceipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`generation receipt is not valid JSON: ${error.message}`);
  }
  const receipt = parseGenerationReceipt(parsedReceipt);
  assertReceiptMatchesSpec(document, receipt);

  const outputSha256 = await sha256File(outputAbsolutePath);
  if (outputSha256 !== receipt.output.sha256) {
    throw new Error(
      `generation output hash mismatch: receipt records ${receipt.output.sha256}, accepted bytes are ${outputSha256}`,
    );
  }

  return {
    schemaVersion: 1,
    input: {
      sha256: outputSha256,
      mediaType: options.mediaType,
    },
    lineage: {
      kind: "generation-receipt",
      assetId: receipt.assetId,
      generationReceiptSchemaVersion: receipt.schemaVersion,
      generationReceiptPath: receiptPath,
      generationReceiptSha256: sha256Text(receiptBytes.toString("utf8")),
    },
  };
}
