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

const expectedProcessors = new Map([
  [
    "three-d-lod",
    {
      repository: "moritzbrantner/3d-lab",
      manifestPath: "examples/asset-tooling-lod-adapter/Cargo.toml",
      operation: "mesh.simplify",
    },
  ],
  [
    "three-d-lod-chain",
    {
      repository: "moritzbrantner/3d-lab",
      manifestPath: "examples/asset-tooling-lod-adapter/Cargo.toml",
      operation: "mesh.lod_chain",
    },
  ],
  [
    "three-d-animation-resample",
    {
      repository: "moritzbrantner/3d-lab",
      manifestPath: "examples/asset-tooling-animation-adapter/Cargo.toml",
      operation: "animation.resample",
    },
  ],
  [
    "three-d-animation-reduce",
    {
      repository: "moritzbrantner/3d-lab",
      manifestPath: "examples/asset-tooling-animation-adapter/Cargo.toml",
      operation: "animation.reduce",
    },
  ],
]);

const expectedWorkflowStack = {
  editor: {
    repository: "moritzbrantner/workflow-editor",
    commit: "2797dcb357f00f3d388442a3de4dbfeb7e82cb96",
  },
  runner: {
    repository: "moritzbrantner/workflow-runner",
    commit: "2249f4bc9140b0586461c0455d2f9c84327811ef",
  },
};

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

function assertExactCommit(value, description) {
  assert(/^[0-9a-f]{40}$/.test(value), `${description} must be an exact lowercase Git commit SHA`);
}

const consumerManifest = JSON.parse(
  await readFile(new URL("../stability/consumers.json", import.meta.url), "utf8"),
);
assertExactFields(consumerManifest, new Set(["schemaVersion", "consumers"]), "stability manifest");
assert(consumerManifest.schemaVersion === 1, "stability manifest schemaVersion must be 1");
assert(Array.isArray(consumerManifest.consumers), "stability manifest consumers must be an array");
assert(
  consumerManifest.consumers.length === expectedConsumers.size,
  "stability manifest must contain exactly the accepted Zoo and Medieval consumers",
);

const seenConsumers = new Set();
for (const consumer of consumerManifest.consumers) {
  assertExactFields(
    consumer,
    new Set(["id", "repository", "commit", "specPath", "assetId"]),
    "consumer evidence",
  );
  assert(
    typeof consumer.id === "string" && expectedConsumers.has(consumer.id),
    `unexpected consumer id '${consumer.id}'`,
  );
  assert(!seenConsumers.has(consumer.id), `duplicate consumer id '${consumer.id}'`);
  seenConsumers.add(consumer.id);

  const expected = expectedConsumers.get(consumer.id);
  assert(
    consumer.repository === expected.repository,
    `${consumer.id} repository must remain '${expected.repository}'`,
  );
  assert(
    consumer.specPath === expected.specPath,
    `${consumer.id} specPath must remain '${expected.specPath}'`,
  );
  assert(
    consumer.assetId === expected.assetId,
    `${consumer.id} assetId must remain '${expected.assetId}'`,
  );
  assertExactCommit(consumer.commit, `${consumer.id} commit`);
  assertPortableRelativePath(consumer.specPath, `${consumer.id} specPath`);
}
assert(seenConsumers.size === expectedConsumers.size, "all accepted consumers must be present exactly once");

const processorManifest = JSON.parse(
  await readFile(new URL("../stability/processors.json", import.meta.url), "utf8"),
);
assertExactFields(
  processorManifest,
  new Set(["schemaVersion", "processors"]),
  "processor stability manifest",
);
assert(processorManifest.schemaVersion === 1, "processor stability manifest schemaVersion must be 1");
assert(Array.isArray(processorManifest.processors), "processor stability manifest processors must be an array");
assert(
  processorManifest.processors.length === expectedProcessors.size,
  "processor stability manifest must contain exactly the accepted 3d-lab processors",
);

const seenProcessors = new Set();
for (const processor of processorManifest.processors) {
  assertExactFields(
    processor,
    new Set(["id", "repository", "commit", "manifestPath", "operation"]),
    "processor evidence",
  );
  assert(
    typeof processor.id === "string" && expectedProcessors.has(processor.id),
    `unexpected processor id '${processor.id}'`,
  );
  assert(!seenProcessors.has(processor.id), `duplicate processor id '${processor.id}'`);
  seenProcessors.add(processor.id);

  const expected = expectedProcessors.get(processor.id);
  assert(
    processor.repository === expected.repository,
    `${processor.id} repository must remain '${expected.repository}'`,
  );
  assert(
    processor.manifestPath === expected.manifestPath,
    `${processor.id} manifestPath must remain '${expected.manifestPath}'`,
  );
  assert(
    processor.operation === expected.operation,
    `${processor.id} operation must remain '${expected.operation}'`,
  );
  assertExactCommit(processor.commit, `${processor.id} commit`);
  assertPortableRelativePath(processor.manifestPath, `${processor.id} manifestPath`);
}
assert(seenProcessors.size === expectedProcessors.size, "all accepted processors must be present exactly once");

const workflowStack = JSON.parse(
  await readFile(new URL("../stability/workflow-stack.json", import.meta.url), "utf8"),
);
assertExactFields(
  workflowStack,
  new Set(["schemaVersion", "editor", "runner"]),
  "workflow stack stability manifest",
);
assert(workflowStack.schemaVersion === 1, "workflow stack stability manifest schemaVersion must be 1");
for (const role of ["editor", "runner"]) {
  const actual = workflowStack[role];
  const expected = expectedWorkflowStack[role];
  assertExactFields(actual, new Set(["repository", "commit"]), `workflow stack ${role} evidence`);
  assert(actual.repository === expected.repository, `workflow stack ${role} repository must remain '${expected.repository}'`);
  assertExactCommit(actual.commit, `${role} commit`);
  assert(actual.commit === expected.commit, `workflow stack ${role} commit must remain '${expected.commit}'`);
}

console.log(
  JSON.stringify({
    status: "stable-contract-valid",
    consumers: [...seenConsumers].sort(),
    processors: [...seenProcessors].sort(),
    workflowStack: {
      editor: workflowStack.editor.commit,
      runner: workflowStack.runner.commit,
    },
  }),
);
