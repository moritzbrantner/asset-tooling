// The quadruped-rigid profile (#128): profile selection, invalid rigs, clips and bounds, source lineage and stable
// packaging. The rejection and packaging cases use a synthetic rig; the real Zoo animals run when hydrated.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeIO, type Document } from "@gltf-transform/core";
import { animationViewerIneligibility, animationViewerRigKind } from "../src/animation-viewer-eligibility.ts";
import { storeAssetObject } from "../src/asset-store.ts";
import { assertAssetCatalogSourceReusable, createAssetCatalog } from "../src/catalog.ts";
import { assertQuadrupedRigid, inspectQuadrupedRigid, packageQuadrupedRigidFamily, type QuadrupedFamilyLicense } from "../src/quadruped-rigid.ts";
import { ROLLING_RELEASES, planEntry, rollingRelease } from "../scripts/publish-release.ts";
import { quadruped, type Quadruped } from "./quadruped-rigid-fixture.ts";

const readJson = (file: string) => JSON.parse(require("node:fs").readFileSync(path.join(import.meta.dir, "..", file), "utf8"));

const channelOf = (quad: Quadruped, clip: string) => quad.document.getRoot().listAnimations().find((animation) => animation.getName() === clip)!;
const issuesOf = (quad: Quadruped) => inspectQuadrupedRigid(quad.document).issues;

describe("quadruped-rigid profile", () => {
  test("a grounded rig with the required joints and clips passes and is measured", () => {
    const observations = assertQuadrupedRigid(quadruped().document);
    expect(observations.profile).toBe("quadruped-rigid");
    expect(observations.joints).toEqual(["animal_root", "body", "head", "leg_0", "leg_1", "leg_2", "leg_3", "tail"]);
    expect(observations.bounds.min[1]).toBe(0);
    expect(observations.clips.walk).toEqual({ seconds: 1, channels: ["leg_0.rotation", "leg_1.rotation", "leg_2.rotation", "leg_3.rotation"], walkTravel: 0 });
    expect(observations.triangles).toBe(7 * 12);
  });

  test("selects by its catalog tag, and never for a skinned or ambiguous entry", () => {
    const base = { kind: "mesh", mediaType: "model/gltf-binary", source: { url: "https://example.test/a.glb", sha256: "a".repeat(64), byteLength: 12 } };
    expect(animationViewerRigKind({ ...base, tags: ["animation", "quadruped-rigid"] })).toBe("quadruped-rigid");
    expect(animationViewerRigKind({ ...base, tags: ["animation", "skinning"] })).toBe("skinned");
    expect(animationViewerRigKind({ ...base, tags: ["animation", "skinning", "quadruped-rigid"] })).toBeNull();
    expect(animationViewerIneligibility({ ...base, tags: ["animation", "skinning", "quadruped-rigid"] })).toMatch(/both/);
    expect(animationViewerIneligibility({ ...base, tags: ["animation", "quadruped-rigid"] })).toBeNull();
    expect(animationViewerIneligibility({ ...base, tags: ["quadruped-rigid"] })).toMatch(/animation/);
  });

  test("rejects a skinned asset", () => {
    const quad = quadruped();
    const joint = quad.document.createNode("bone");
    quad.document.createSkin("skin").addJoint(joint);
    quad.rootNode.addChild(joint);
    expect(issuesOf(quad).join("\n")).toMatch(/skin/);
  });

  test("rejects morph targets and morph channels", () => {
    const quad = quadruped();
    const leg = quad.nodes.get("leg_0")!;
    const position = quad.document.createAccessor().setType("VEC3").setArray(new Float32Array(leg.getMesh()!.listPrimitives()[0]!.getAttribute("POSITION")!.getCount() * 3));
    leg.getMesh()!.listPrimitives()[0]!.addTarget(quad.document.createPrimitiveTarget().setAttribute("POSITION", position));
    const sampler = channelOf(quad, "idle").listSamplers()[0]!;
    channelOf(quad, "idle").addChannel(quad.document.createAnimationChannel().setTargetNode(leg).setTargetPath("weights").setSampler(sampler));
    const issues = issuesOf(quad).join("\n");
    expect(issues).toMatch(/morph targets/);
    expect(issues).toMatch(/morph weights/);
  });

  test("rejects a missing joint and a joint that moves no geometry", () => {
    const missing = quadruped(); missing.nodes.get("leg_3")!.setName("rear_leg");
    expect(issuesOf(missing).join("\n")).toMatch(/required joint 'leg_3' is missing/);
    const hollow = quadruped(); hollow.nodes.get("tail")!.setMesh(null);
    expect(issuesOf(hollow).join("\n")).toMatch(/joint 'tail' moves no geometry/);
  });

  test("rejects a second root node, a node outside the rig, and an unnamed node", () => {
    const quad = quadruped();
    const scene = quad.document.getRoot().listScenes()[0]!;
    scene.addChild(quad.document.createNode("stray"));
    const issues = issuesOf(quad).join("\n");
    expect(issues).toMatch(/single root node 'animal_root'/);
    const stray = quadruped();
    stray.document.createNode("orphan");
    expect(issuesOf(stray).join("\n")).toMatch(/node 'orphan' is outside the rig/);
    const unnamed = quadruped(); unnamed.nodes.get("tail")!.setName("");
    expect(issuesOf(unnamed).join("\n")).toMatch(/needs a name/);
  });

  test("rejects a leg whose pivot is not at the top of its leg", () => {
    const quad = quadruped();
    const leg = quad.nodes.get("leg_1")!;
    const position = leg.getMesh()!.listPrimitives()[0]!.getAttribute("POSITION")!;
    const array = position.getArray()!;
    for (let index = 1; index < array.length; index += 3) array[index] = array[index]! + 0.3;
    expect(issuesOf(quad).join("\n")).toMatch(/joint 'leg_1' pivots at y 0\.6, not at the top of its leg/);
  });

  test("rejects a missing required clip and a duplicate clip name", () => {
    const quad = quadruped();
    channelOf(quad, "walk").setName("gallop");
    expect(issuesOf(quad).join("\n")).toMatch(/required clip 'walk' is missing/);
    const twice = quadruped();
    channelOf(twice, "idle").setName("walk");
    expect(issuesOf(twice).join("\n")).toMatch(/clip name 'walk' is used twice/);
  });

  test("rejects broken clip references", () => {
    const untargeted = quadruped();
    channelOf(untargeted, "walk").listChannels()[0]!.setTargetNode(null);
    expect(issuesOf(untargeted).join("\n")).toMatch(/channel with no target node/);
    const outside = quadruped();
    const other = outside.document.createNode("elsewhere");
    outside.document.createScene("Other").addChild(other);
    channelOf(outside, "idle").listChannels()[0]!.setTargetNode(other);
    expect(issuesOf(outside).join("\n")).toMatch(/targets node 'elsewhere' outside the rig/);
    const dropped = quadruped();
    channelOf(dropped, "walk").listChannels()[0]!.detach();
    expect(issuesOf(dropped).join("\n")).toMatch(/does not rotate joint 'leg_0'/);
    const noKeys = quadruped();
    channelOf(noKeys, "idle").listChannels()[0]!.getSampler()!.getInput()!.setArray(new Float32Array([0]));
    expect(issuesOf(noKeys).join("\n")).toMatch(/at least two keys/);
  });

  test("rejects a walk that travels, and an idle that does not move", () => {
    const quad = quadruped();
    const travel = channelOf(quad, "walk").addChannel(quad.document.createAnimationChannel().setTargetNode(quad.rootNode).setTargetPath("translation").setSampler(channelOf(quad, "idle").listSamplers()[0]!));
    expect(issuesOf(quad)).toEqual([]);
    const output = quad.document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 0.5, 0, 0, 1, 0, 0]));
    travel.listChannels().at(-1)!.getSampler()!.setOutput(output);
    expect(issuesOf(quad).join("\n")).toMatch(/travels 1 m; quadruped-rigid walks are in place/);

    const still = quadruped();
    const idle = channelOf(still, "idle").listChannels()[0]!.getSampler()!.getOutput()!;
    idle.setArray(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(issuesOf(still).join("\n")).toMatch(/clip 'idle' does not move/);
  });

  test("the in-place check applies to walk: idle may bob and drift on the root", () => {
    const quad = quadruped();
    const idle = channelOf(quad, "idle").listChannels()[0]!.getSampler()!.getOutput()!;
    idle.setArray(new Float32Array([0, 0, 0, 0, 0.03, 0, 0.5, 0, 0]));
    expect(issuesOf(quad)).toEqual([]);
  });

  test("rejects invalid bounds: not grounded, implausible size, off-origin footprint, non-finite", () => {
    const floating = quadruped();
    for (const node of floating.rootNode.listChildren()) node.setTranslation([node.getTranslation()[0], node.getTranslation()[1] + 0.5, node.getTranslation()[2]]);
    expect(issuesOf(floating).join("\n")).toMatch(/stands at y 0\.5, not on the ground plane/);

    const giant = quadruped();
    for (const node of giant.rootNode.listChildren()) node.setScale([20, 20, 20]);
    expect(issuesOf(giant).join("\n")).toMatch(/outside 0\.05–8 m/);

    const beside = quadruped();
    for (const node of beside.rootNode.listChildren()) node.setTranslation([node.getTranslation()[0] + 5, node.getTranslation()[1], node.getTranslation()[2]]);
    expect(issuesOf(beside).join("\n")).toMatch(/rig origin lies outside/);

    const shifted = quadruped(); shifted.rootNode.setTranslation([0, 1, 0]);
    expect(issuesOf(shifted).join("\n")).toMatch(/identity transform/);

    const broken = quadruped();
    const leg = broken.nodes.get("leg_2")!.getMesh()!.listPrimitives()[0]!.getAttribute("POSITION")!;
    leg.getArray()![0] = NaN;
    const { issues } = inspectQuadrupedRigid(broken.document);
    expect(issues.join("\n")).toMatch(/joint 'leg_2' has no finite geometry/);
    expect(issues.join("\n")).toMatch(/no finite mesh bounds/);
  });

  test("assertQuadrupedRigid names every issue when it throws", () => {
    const quad = quadruped();
    channelOf(quad, "walk").setName("gallop");
    quad.nodes.get("leg_3")!.setName("rear");
    expect(() => assertQuadrupedRigid(quad.document, "test")).toThrow(/test fails quadruped-rigid:[\s\S]*leg_3[\s\S]*walk/);
  });
});

const MIT: QuadrupedFamilyLicense = {
  spdx: "MIT", attribution: "Copyright (c) 2026 Test", evidenceUrl: "https://github.com/o/r/issues/1#issuecomment-1", text: "MIT License\n\nCopyright (c) 2026 Test\n",
};

async function packageFamily(root: string, documents: Record<string, Document>) {
  const io = new NodeIO();
  const members = [];
  for (const [key, document] of Object.entries(documents)) {
    const { asset } = await storeAssetObject(root, { bytes: await io.writeBinary(document), kind: "mesh", mediaType: "model/gltf-binary" });
    members.push({ key, source: asset, provenance: { catalogSource: `test.${key}` } });
  }
  return packageQuadrupedRigidFamily(root, {
    release: "family", tarName: "family.tar", descriptorFile: "family.descriptor.json", descriptorSchema: "family-descriptor-v1", descriptorAttachment: "family-descriptor",
    conventions: { facing: "+X", origin: "ground" }, members, license: MIT,
  });
}

describe("quadruped-rigid packaging", () => {
  test("packages a family through the shared import and bundle boundaries, stably", async () => {
    const dirs = await Promise.all(Array.from({ length: 2 }, () => mkdtemp(path.join(os.tmpdir(), "quadruped-"))));
    try {
      const build = (root: string) => packageFamily(root, { "test.animal.zebra": quadruped().document, "test.animal.giraffe": quadruped({ neck: true }).document });
      const [first, second] = await Promise.all(dirs.map(build));
      expect(first!.tarSha256).toBe(second!.tarSha256);
      expect(first!.descriptor.assets.map((asset) => asset.key)).toEqual(["test.animal.giraffe", "test.animal.zebra"]);
      expect(first!.descriptor.assets.every((asset) => asset.profile === "quadruped-rigid" && asset.license === "MIT")).toBe(true);
      expect(first!.descriptor.license).toEqual(MIT);
      expect(first!.lineage.license).toEqual({ spdx: "MIT", attribution: MIT.attribution, evidenceUrl: MIT.evidenceUrl });
      expect(first!.lineage.animals["test.animal.zebra"]!.provenance).toEqual({ catalogSource: "test.test.animal.zebra" });
      expect(first!.manifest.assets.map((entry) => entry.observations.skins)).toEqual([0, 0]);
      expect(first!.manifest.assets.every((entry) => entry.observations.animations.includes("idle") && entry.observations.animations.includes("walk"))).toBe(true);
      expect(await readFile(path.join(dirs[0]!, "family.LICENSE.txt"), "utf8")).toBe(MIT.text);
      const descriptorText = await readFile(path.join(dirs[0]!, "family.descriptor.json"), "utf8");
      expect(descriptorText).toContain("MIT License");
      expect(descriptorText).toContain("Copyright (c) 2026 Test");
    } finally { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); }
  }, 60_000);

  test("fails closed on a source that breaks the profile, before any bundle is written", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quadruped-"));
    try {
      const broken = quadruped(); channelOf(broken, "walk").setName("gallop");
      await expect(packageFamily(root, { "test.animal.zebra": broken.document })).rejects.toThrow(/test\.animal\.zebra source fails quadruped-rigid:[\s\S]*walk/);
      await expect(readFile(path.join(root, "family.descriptor.json"))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe("Zoo animal source lineage", () => {
  const sources: { id: string; provider: string; license: { spdx: string; attribution?: string; evidenceUrl: string }; source: { url: string; revision: string; path: string; sha256: string; byteLength: number }; tags: string[]; metadata: Record<string, string> }[] = readJson("catalog/sources.json").sources;
  const animals = [
    { id: "zoo.zebra-glb", sha256: "116ba91bc5b18fe97e7ca49ae9678f53f532419d743aeacd5ed85b9e86e63f32", byteLength: 215236 },
    { id: "zoo.giraffe-glb", sha256: "b20df27bd3e131934d4675c66b2578f6766f7656487f54aba76b006d296b7827", byteLength: 221116 },
  ];

  test("each animal is an MIT source of the Zoo provider, pinned to its commit and bytes, with its owner statement", () => {
    for (const { id, sha256, byteLength } of animals) {
      const source = sources.find((entry) => entry.id === id)!;
      expect(source.provider).toBe("moenarch-zoo");
      expect(source.license.spdx).toBe("MIT");
      expect(source.license.attribution).toContain("Copyright (c) 2026 moritzbrantner");
      expect(source.license.evidenceUrl).toBe("https://github.com/moritzbrantner/asset-tooling/issues/128#issuecomment-6719424007");
      expect(source.source.url).toBe(`https://raw.githubusercontent.com/moenarch-games/zoo/${source.source.revision}/${source.source.path}`);
      expect(source.source.sha256).toBe(sha256);
      expect(source.source.byteLength).toBe(byteLength);
      expect(source.tags).toEqual(expect.arrayContaining(["animation", "quadruped-rigid"]));
      expect(source.metadata.generator).toContain(source.source.revision);
    }
  });

  test("the Zoo provider accepts only MIT, and a canonical storage entry exists for each animal", () => {
    const providers = readJson("catalog/providers.json").providers;
    const zebra = sources.find((entry) => entry.id === "zoo.zebra-glb")!;
    const catalog = createAssetCatalog({ providers, sources: [{ ...zebra, license: { spdx: "CC-BY-4.0", evidenceUrl: zebra.license.evidenceUrl, attribution: "x" } }] });
    expect(() => assertAssetCatalogSourceReusable(catalog, zebra.id)).toThrow(/not accepted/);
    const storage = readJson("catalog/storage.json").entries;
    for (const { id } of animals) expect(storage.some((entry: { sourceId: string }) => entry.sourceId === id)).toBe(true);
    expect(readJson("catalog/storage.json").entries.find((entry: { sourceId: string }) => entry.sourceId === "zoo.zebra-glb")).toEqual({ schemaVersion: 1, sourceId: "zoo.zebra-glb", storage: "git-lfs", path: "assets/canonical/zoo.zebra-glb/zebra.glb" });
  });

  test("the MIT notice carried with the bundles names the owner's copyright", async () => {
    const text = await readFile(new URL("../licenses/zoo-animals-MIT.txt", import.meta.url), "utf8");
    expect(text).toContain("MIT License");
    expect(text).toContain("Copyright (c) 2026 moritzbrantner");
  });

  test("zoo-animals is one rolling release built from the canonical payloads, without Blender", () => {
    expect(planEntry(rollingRelease("zoo-animals"))).toEqual({ release: "zoo-animals", blender: false, lfs: true, processor: "", ktx: false, timeout: 60 });
    expect(ROLLING_RELEASES.filter((release) => release.name === "zoo-animals")).toHaveLength(1);
  });

  for (const { id, sha256, byteLength } of animals) {
    const file = path.join(import.meta.dir, "..", "assets/canonical", id, `${id.replace(/^zoo\.|-glb$/g, "")}.glb`);
    test.skipIf(!isHydrated(file, byteLength))(`hydrated ${id} matches its pin and passes quadruped-rigid`, async () => {
      const bytes = new Uint8Array(await readFile(file));
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sha256);
      const observations = assertQuadrupedRigid(await new NodeIO().readBinary(bytes), id);
      expect(Object.keys(observations.clips).sort()).toEqual(["idle", "walk"]);
      expect(observations.clips.walk!.walkTravel).toBe(0);
      expect(observations.bounds.min[1]).toBe(0.005);
    });
  }
});

function isHydrated(file: string, byteLength: number): boolean {
  try { return require("node:fs").statSync(file).size === byteLength; } catch { return false; }
}
