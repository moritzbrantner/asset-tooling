import { resolveAssetObject } from "./asset-store.js";
import { canonicalJson } from "./canonical.js";
import { createAssetRef, type AssetRef } from "./operations.js";

export interface PreparedComfyUiApiWorkflow {
  /** Exact content-addressed source, independent of the ComfyUI server. */
  readonly asset: AssetRef;
  /** Original UTF-8 API-format JSON; no node, parameter, or link rewriting. */
  readonly promptJson: string;
  readonly nodeCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Offline, non-mutating preflight for a prepared ComfyUI API-format workflow.
 *
 * This verifies source bytes through the existing object store and checks only
 * the API-format envelope. ComfyUI remains the authority for node definitions,
 * link types, model availability and actual graph execution.
 *
 * This is deliberately not an executor or a public asset operation yet.
 */
export async function loadPreparedComfyUiApiWorkflow(
  root: string,
  workflowValue: unknown,
): Promise<PreparedComfyUiApiWorkflow> {
  const asset = createAssetRef(workflowValue);
  if (asset.kind !== "workflow" || asset.mediaType !== "application/json") {
    throw new Error("ComfyUI API workflow must be a workflow AssetRef with application/json media type");
  }

  const bytes = await resolveAssetObject(root, asset);
  let promptJson: string;
  try {
    promptJson = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("ComfyUI API workflow must contain valid UTF-8 JSON");
  }

  let prompt: unknown;
  try {
    prompt = JSON.parse(promptJson);
  } catch {
    throw new Error("ComfyUI API workflow must contain valid JSON");
  }
  if (!isRecord(prompt) || Object.keys(prompt).length === 0) {
    throw new Error("ComfyUI API workflow must be a non-empty node-id-to-node object");
  }

  for (const [id, node] of Object.entries(prompt)) {
    if (!isRecord(node) || typeof node.class_type !== "string" || !node.class_type.trim()) {
      throw new Error(`ComfyUI API workflow node '${id}' must declare a class_type`);
    }
    if (!isRecord(node.inputs)) {
      throw new Error(`ComfyUI API workflow node '${id}' must declare an inputs object`);
    }
  }

  // JSON.parse accepts excessively large exponent values as Infinity. Reuse
  // the existing canonical JSON validator, but preserve original source bytes.
  canonicalJson(prompt);

  return { asset, promptJson, nodeCount: Object.keys(prompt).length };
}
