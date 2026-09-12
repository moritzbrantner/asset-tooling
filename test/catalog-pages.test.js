import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogPagesModel, renderCatalogPagesHtml } from "../src/catalog-pages.js";

function fixture() {
  return {
    providers: {
      schemaVersion: 1,
      providers: [
        {
          schemaVersion: 1,
          id: "shared",
          label: "Shared Provider",
          homepage: "https://example.com/shared",
          distribution: "shared",
          acceptedLicenses: ["CC-BY-4.0", "CC0-1.0"],
        },
        {
          schemaVersion: 1,
          id: "local",
          label: "Local Provider",
          homepage: "https://example.com/local",
          distribution: "project-local",
          acceptedLicenses: ["CC0-1.0"],
        },
      ],
    },
    sources: {
      schemaVersion: 1,
      sources: [
        {
          schemaVersion: 1,
          id: "z-candidate",
          provider: "local",
          title: "Candidate",
          kind: "mesh",
          mediaType: "model/gltf-binary",
          source: { url: "https://example.com/candidate.glb", revision: "latest", path: "candidate.glb" },
          license: { spdx: "CC0-1.0", evidenceUrl: "https://example.com/license" },
          tags: ["three-d"],
          metadata: { purpose: "Project-local experiment" },
        },
        {
          schemaVersion: 1,
          id: "a-pinned",
          provider: "shared",
          title: "Pinned",
          kind: "texture",
          mediaType: "image/png",
          source: {
            url: "https://example.com/pinned.png",
            revision: "abc",
            path: "pinned.png",
            sha256: "a".repeat(64),
            byteLength: 12,
          },
          license: {
            spdx: "CC-BY-4.0",
            attribution: "Example Artist — Example Texture",
            evidenceUrl: "https://example.com/license",
          },
          tags: ["z", "a"],
          metadata: { purpose: "Pinned texture" },
        },
        {
          schemaVersion: 1,
          id: "m-canonical",
          provider: "shared",
          title: "Canonical",
          kind: "audio",
          mediaType: "audio/wav",
          source: {
            url: "https://example.com/canonical.wav",
            revision: "def",
            path: "canonical.wav",
            sha256: "b".repeat(64),
            byteLength: 34,
          },
          license: { spdx: "CC0-1.0", evidenceUrl: "https://example.com/license" },
          tags: [],
          metadata: {},
        },
      ],
    },
    storage: {
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          sourceId: "m-canonical",
          storage: "git-lfs",
          path: "assets/canonical/m-canonical/canonical.wav",
        },
      ],
    },
  };
}

test("catalog Pages model distinguishes candidate, pinned, and canonical state with ordinal ordering", () => {
  const model = createCatalogPagesModel(fixture());
  assert.deepEqual(model.assets.map((asset) => asset.id), ["a-pinned", "m-canonical", "z-candidate"]);
  assert.deepEqual(model.assets.map((asset) => asset.state), ["pinned", "canonical", "candidate"]);
  assert.deepEqual(model.assets[0].tags, ["a", "z"]);
  assert.equal(model.assets[0].license.attribution, "Example Artist — Example Texture");
  assert.deepEqual(model.assets[1].storage, {
    kind: "git-lfs",
    path: "assets/canonical/m-canonical/canonical.wav",
  });
  assert.equal(model.assets[2].provider.distribution, "project-local");
});

test("catalog Pages model runs canonical catalog and storage validation", () => {
  const documents = fixture();
  documents.storage.entries[0].path = "assets/canonical/wrong.wav";
  assert.throws(
    () => createCatalogPagesModel(documents),
    /path must be 'assets\/canonical\/m-canonical\/canonical\.wav'/,
  );
});

test("catalog Pages model fails closed on unknown providers", () => {
  const documents = fixture();
  documents.sources.sources[0].provider = "missing";
  assert.throws(() => createCatalogPagesModel(documents), /references unknown provider 'missing'/);
});

test("catalog Pages HTML is deterministic, includes attribution, and safely embeds catalog strings", () => {
  const model = createCatalogPagesModel(fixture());
  model.assets[0].title = "</script><script>alert(1)</script>";
  const first = renderCatalogPagesHtml(model);
  const second = renderCatalogPagesHtml(model);
  assert.equal(second, first);
  assert.doesNotMatch(first, /<\/script><script>alert\(1\)<\/script>/);
  assert.match(first, /\\u003c\/script>/);
  assert.match(first, /Example Artist — Example Texture/);
  assert.match(first, /text\(details, "Attribution", asset\.license\.attribution\)/);
  assert.match(first, /id="search"/);
  assert.match(first, /id="provider"/);
  assert.match(first, /preview or Git LFS pointer as content evidence/);
});
