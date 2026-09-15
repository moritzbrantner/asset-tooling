import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveCargoManifestPath } from "../src/pinned-process-processor.js";

test("relative Cargo manifests resolve from the processor execution root", () => {
  const root = path.resolve("workspace", "execution-root");
  const relativeManifest = path.join("processor", "Cargo.toml");
  assert.equal(
    resolveCargoManifestPath(root, relativeManifest),
    path.resolve(root, relativeManifest),
  );

  const absoluteManifest = path.resolve(root, "processor", "Cargo.toml");
  assert.equal(resolveCargoManifestPath(root, absoluteManifest), absoluteManifest);
});
