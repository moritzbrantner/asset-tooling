// The biped-rigid profile (#605): the two-legged sibling of quadruped-rigid shares its rules and differs in the
// joints, and a family can package both kinds side by side, each checked against its own profile.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { storeAssetObject } from "../src/asset-store.ts";
import { BIPED_RIGID, assertBipedRigid, inspectBipedRigid } from "../src/biped-rigid.ts";
import { inspectQuadrupedRigid, packageQuadrupedRigidFamily } from "../src/quadruped-rigid.ts";
import { quadruped } from "./quadruped-rigid-fixture.ts";

const bird = () => quadruped({ legs: ["leg_0", "leg_1"], wings: true, neck: true });

describe("biped-rigid profile", () => {
  test("a grounded two-legged rig with wings passes and is measured", () => {
    const observations = assertBipedRigid(bird().document);
    expect(observations.profile).toBe("biped-rigid");
    expect(observations.joints).toEqual(["animal_root", "body", "head", "leg_0", "leg_1", "tail", "wing_left", "wing_right"]);
    expect(observations.clips.walk!.channels).toEqual(["leg_0.rotation", "leg_1.rotation"]);
    expect(observations.bounds.min[1]).toBe(0);
  });

  test("each profile rejects the other's legs", () => {
    expect(inspectQuadrupedRigid(bird().document).issues.join("\n")).toMatch(/required joint 'leg_2' is missing/);
    const issues = inspectBipedRigid(quadruped().document).issues.join("\n");
    expect(issues).toMatch(/required joint 'wing_left' is missing/);
    expect(issues).toMatch(/required joint 'wing_right' is missing/);
  });

  test("keeps the shared rules: wings that move geometry, an in-place walk, grounded clips", () => {
    const hollow = bird(); hollow.nodes.get("wing_left")!.setMesh(null);
    expect(inspectBipedRigid(hollow.document).issues.join("\n")).toMatch(/joint 'wing_left' moves no geometry/);
    const still = bird();
    for (const channel of still.document.getRoot().listAnimations().find((clip) => clip.getName() === "walk")!.listChannels()) {
      if (channel.getTargetNode()!.getName() === "leg_1") channel.getSampler()!.getOutput()!.setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]));
    }
    expect(inspectBipedRigid(still.document).issues.join("\n")).toMatch(/clip 'walk' barely moves joint 'leg_1'/);
    const sunk = bird(); sunk.nodes.get("leg_0")!.setTranslation([0, 0.5, 0.1]);
    expect(() => assertBipedRigid(sunk.document, "bird")).toThrow(/bird fails biped-rigid:[\s\S]*below the ground plane/);
  });

  test("a family packages quadrupeds and bipeds together, each under its own profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biped-"));
    try {
      const io = new NodeIO();
      const store = async (document: ReturnType<typeof quadruped>["document"]) =>
        (await storeAssetObject(root, { bytes: await io.writeBinary(document), kind: "mesh", mediaType: "model/gltf-binary" })).asset;
      const members = [
        { key: "test.animal.zebra", source: await store(quadruped().document), provenance: {} },
        { key: "test.animal.flamingo", profile: BIPED_RIGID, source: await store(bird().document), provenance: {} },
      ];
      const built = await packageQuadrupedRigidFamily(root, {
        release: "family", tarName: "family.tar", descriptorFile: "family.descriptor.json", descriptorSchema: "family-descriptor-v1", descriptorAttachment: "family-descriptor",
        conventions: { facing: "+X" }, members, license: { spdx: "MIT", attribution: "Test", evidenceUrl: "https://example.test", text: "MIT" },
      });
      expect(built.descriptor.assets.map((asset) => [asset.key, asset.profile])).toEqual([["test.animal.flamingo", "biped-rigid"], ["test.animal.zebra", "quadruped-rigid"]]);
      // Without its profile, the bird is checked as a quadruped and fails closed.
      await expect(packageQuadrupedRigidFamily(root, {
        release: "family", tarName: "family.tar", descriptorFile: "family.descriptor.json", descriptorSchema: "family-descriptor-v1", descriptorAttachment: "family-descriptor",
        conventions: { facing: "+X" }, members: [{ ...members[1]!, profile: undefined }], license: { spdx: "MIT", attribution: "Test", evidenceUrl: "https://example.test", text: "MIT" },
      })).rejects.toThrow(/test\.animal\.flamingo source fails quadruped-rigid/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});
