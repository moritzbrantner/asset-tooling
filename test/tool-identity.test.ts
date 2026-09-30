import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { canonicalJson, compareCodeUnitStrings } from "../src/canonical.js";
import { sha256File, sha256Text } from "../src/hash.js";
import { captureToolIdentity } from "../src/tool.js";

const SOURCE_ROOT = path.resolve(fileURLToPath(new URL("../src/", import.meta.url)));

async function collectSourceHashes(
  directory: string,
  prefix = "",
): Promise<Record<string, string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const hashes: Record<string, string> = {};

  for (const entry of entries.sort((left, right) => compareCodeUnitStrings(left.name, right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(hashes, await collectSourceHashes(absolute, relative));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      hashes[relative] = await sha256File(absolute);
    }
  }

  return hashes;
}

test("tool identity fingerprints the authored TypeScript source tree", async () => {
  const sourceHashes = await collectSourceHashes(SOURCE_ROOT);
  assert.ok(Object.hasOwn(sourceHashes, "tool.ts"));
  assert.ok(Object.keys(sourceHashes).length > 1);

  const identity = await captureToolIdentity();
  const expectedSha256 = sha256Text(canonicalJson(sourceHashes));

  assert.equal(identity.sourceFingerprint.algorithm, "sha256-tree-v1");
  assert.equal(identity.sourceFingerprint.sha256, expectedSha256);
});
