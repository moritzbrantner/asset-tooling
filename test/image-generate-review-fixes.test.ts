import { test } from "bun:test";
import assert from "node:assert/strict";
import { IMAGE_GENERATE_MODEL_PROFILES, resolveImageGenerateParameters } from "../src/image-generate-operation.js";

// Regression for the Codex P2 on PR #244: the public resolver must be able to resolve against the
// same profile set a registration was created with, so a changed default is not silently replaced
// by the built-in one.
test("#244: resolveImageGenerateParameters resolves defaults from caller-supplied profiles", () => {
  const profiles = structuredClone(IMAGE_GENERATE_MODEL_PROFILES) as Record<string, any>;
  profiles["z-image-turbo"].defaults.steps = 12;
  const base = { provider: "comfyui", model: "z-image-turbo", prompt: "shield", seed: 1, width: 64, height: 64 };
  assert.equal(resolveImageGenerateParameters(base).steps, 8);
  assert.equal(resolveImageGenerateParameters(base, { profiles }).steps, 12);
  assert.equal(resolveImageGenerateParameters({ ...base, steps: 3 }, { profiles }).steps, 3);
});
