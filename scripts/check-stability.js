import { readFile } from "node:fs/promises";

const expectedConsumers = new Map([
  [
    "zoo",
    {
      repository: "moritzbrantner/zoo",
      specPath: "apps/web/public/generated-assets/zoo-park-texture.asset.json",
      assetId: "zoo.web.park-texture",
    },
  ],
  [
    "medieval",
    {
      repository: "moritzbrantner/medieval",
      specPath: "web/generated-assets/medieval-camp-texture.asset.json",
      assetId: "medieval.web.camp-texture",
    },
  ],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactFields(value, allowed, description) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${description} must be an object`);
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${description} contains unknown field '${key}'`);
  }
  for (const key of allowed) {
    assert(key in value, `${description} is missing '${key}'`);
  }
}

function assertPortableRelativePath(value, description) {
  assert(typeof value === "string" && value.length > 0, `${description} must be a non-empty string`);
  assert(!value.startsWith("/"), `${description} must be relative`);
  assert(!value.includes("\\"), `${description} must use '/' separators`);
  const segments = value.split("/");
  assert(segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."), `${description} must be normalized`);
}

const manifest = JSON.parse(await readFile(new URL("../stability/consumers.json", import.meta.url), "utf8"));
assertExactFields(manifest, new Set(["schemaVersion", "consumers"]), "stability manifest");
assert(manifest.schemaVersion === 1, "stability manifest schemaVersion must be 1");
assert(Array.isArray(manifest.consumers), "stability manifest consumers must be an array");
assert(manifest.consumers.length === expectedConsumers.size, "stability manifest must contain exactly the accepted Zoo and Medieval consumers");

const seen = new Set();
for (const consumer of manifest.consumers) {
  assertExactFields(
    consumer,
    new Set(["id", "repository", "commit", "specPath", "assetId"]),
    "consumer evidence",
  );
  assert(typeof consumer.id === "string" && expectedConsumers.has(consumer.id), `unexpected consumer id '${consumer.id}'`);
  assert(!seen.has(consumer.id), `duplicate consumer id '${consumer.id}'`);
  seen.add(consumer.id);

  const expected = expectedConsumers.get(consumer.id);
  assert(consumer.repository === expected.repository, `${consumer.id} repository must remain '${expected.repository}'`);
  assert(consumer.specPath === expected.specPath, `${consumer.id} specPath must remain '${expected.specPath}'`);
  assert(consumer.assetId === expected.assetId, `${consumer.id} assetId must remain '${expected.assetId}'`);
  assert(/^[0-9a-f]{40}$/.test(consumer.commit), `${consumer.id} commit must be an exact lowercase Git commit SHA`);
  assertPortableRelativePath(consumer.specPath, `${consumer.id} specPath`);
}

assert(seen.size === expectedConsumers.size, "all accepted consumers must be present exactly once");
console.log(JSON.stringify({ status: "stable-contract-valid", consumers: [...seen].sort() }));
