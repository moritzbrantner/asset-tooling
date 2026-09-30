import test from "node:test";
import assert from "node:assert/strict";
import {
  THREE_D_PRODUCTION_PROFILE_V1,
  createThreeDProductionManifest,
  normalizeThreeDProductionIdentifier,
  normalizeThreeDProductionManifest,
} from "../src/three-d-production-profile.js";
import {
  MEDIEVAL_CHARACTER_PALETTES,
  buildMedievalCharacterPackageManifest,
} from "../src/medieval-character-materials.js";

test("3D production profile makes coordinate, scale, transform, naming, skinning, normalization, export, and proxy conventions explicit", () => {
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.id, "asset-tooling-3d-production-v1");
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.coordinateSystem, "right-handed-y-up");
  assert.deepEqual(THREE_D_PRODUCTION_PROFILE_V1.units.scaleToMeters, {
    meter: "1",
    centimeter: "0.01",
    millimeter: "0.001",
  });
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.transforms.space, "local");
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.transforms.rotationRepresentation, "quaternion-xyzw");
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.naming.convention, "lower-kebab-case");
  assert.equal(
    THREE_D_PRODUCTION_PROFILE_V1.skinning.authority,
    "moritzbrantner/3d-lab/three-d-animation",
  );
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.skinning.hierarchyOrder, "parent-before-child");
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.skinning.matrixLayout, "column-major-4x4");
  assert.equal(
    THREE_D_PRODUCTION_PROFILE_V1.skinning.skinMatrixRule,
    "joint-world-times-inverse-bind",
  );
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.skinning.influenceSlotsPerVertex, 4);
  assert.equal(
    THREE_D_PRODUCTION_PROFILE_V1.skinning.weightRule,
    "finite-nonnegative-normalized-sum-one",
  );
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.skinning.jointIndexRule, "active-indices-in-range");
  assert.equal(
    THREE_D_PRODUCTION_PROFILE_V1.normalization.authority,
    "moritzbrantner/3d-lab/three-d-scene",
  );
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.normalization.outputUnit, "meter");
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.normalization.meshOrder, "stable-id");
  assert.equal(
    THREE_D_PRODUCTION_PROFILE_V1.normalization.hierarchyOrder,
    "parent-before-child-stable-id",
  );
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.normalization.vertexOrder, "first-index-use");
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.normalization.unusedVertices, "removed");
  assert.equal(
    THREE_D_PRODUCTION_PROFILE_V1.normalization.quaternionSign,
    "canonical-equivalent-sign",
  );
  assert.equal(
    THREE_D_PRODUCTION_PROFILE_V1.export.authority,
    "moritzbrantner/3d-lab/three-d-export",
  );
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.export.format, "glb-2.0");
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.export.normalizedBeforeExport, true);
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.collisionProxies.declaration, "explicit-manifest-entry");
  assert.equal(THREE_D_PRODUCTION_PROFILE_V1.collisionProxies.namingInference, false);
  assert(Object.isFrozen(THREE_D_PRODUCTION_PROFILE_V1));
});

test("production manifests derive exact scale and preserve stable semantic ids", () => {
  const manifest = createThreeDProductionManifest({
    unit: "centimeter",
    materials: ["cloth-primary", "steel"],
    animations: ["idle", "walk-forward"],
    collisionProxies: [
      { id: "body-collider", target: "body", shape: "capsule" },
      { id: "shield-collider", target: "shield", shape: "convex-hull" },
    ],
  });
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    profile: "asset-tooling-3d-production-v1",
    coordinateSystem: "right-handed-y-up",
    unit: "centimeter",
    unitScaleToMeters: "0.01",
    transformSpace: "local",
    rotationRepresentation: "quaternion-xyzw",
    materials: ["cloth-primary", "steel"],
    animations: ["idle", "walk-forward"],
    collisionProxies: [
      { id: "body-collider", target: "body", shape: "capsule" },
      { id: "shield-collider", target: "shield", shape: "convex-hull" },
    ],
  });
});

test("profile validation fails closed on contradictory scale, magic naming, duplicates, and unsupported proxies", () => {
  const valid = createThreeDProductionManifest({
    unit: "meter",
    materials: ["steel"],
    animations: ["idle"],
    collisionProxies: [{ id: "body-collider", target: "body", shape: "capsule" }],
  });
  assert.throws(
    () => normalizeThreeDProductionManifest({ ...valid, unitScaleToMeters: "0.001" }),
    /unitScaleToMeters must be '1' for unit 'meter'/,
  );
  assert.throws(
    () => normalizeThreeDProductionManifest({ ...valid, materials: ["steel", "steel"] }),
    /must not contain duplicate identifiers/,
  );
  assert.throws(
    () => normalizeThreeDProductionManifest({ ...valid, animations: ["Walk Forward"] }),
    /must use lower-kebab-case/,
  );
  assert.throws(
    () => normalizeThreeDProductionManifest({
      ...valid,
      collisionProxies: [{ id: "body-collider", target: "body", shape: "triangle-mesh" }],
    }),
    /shape must be one of box, sphere, capsule, convex-hull/,
  );
  assert.throws(
    () => normalizeThreeDProductionManifest({
      ...valid,
      collisionProxies: [{ id: "UCX_Body", target: "body", shape: "capsule" }],
    }),
    /must use lower-kebab-case/,
  );
});

test("existing medieval material roles and package scale fit the production profile", () => {
  for (const material of MEDIEVAL_CHARACTER_PALETTES[0].materials) {
    assert.equal(normalizeThreeDProductionIdentifier(material.id), material.id);
  }
  const packageManifest = buildMedievalCharacterPackageManifest();
  assert.equal(packageManifest.productionProfile.unit, "millimeter");
  assert.equal(packageManifest.productionProfile.unitScaleToMeters, "0.001");
  assert.equal(packageManifest.productionProfile.coordinateSystem, packageManifest.geometry.coordinateSystem);
  assert.equal(packageManifest.productionProfile.unit, packageManifest.geometry.unit);
  assert.equal(
    packageManifest.productionProfile.unitScaleToMeters,
    packageManifest.geometry.consumerScaleToMeters,
  );
  assert.deepEqual(
    packageManifest.productionProfile.materials,
    MEDIEVAL_CHARACTER_PALETTES[0].materials.map((material) => material.id),
  );
  assert.deepEqual(packageManifest.productionProfile.animations, []);
  assert.deepEqual(packageManifest.productionProfile.collisionProxies, []);
});

test("package exports the 3D production profile through a focused subpath", async () => {
  const profile = await import("asset-tooling/3d/production-profile");
  assert.equal(profile.THREE_D_PRODUCTION_PROFILE_V1.id, "asset-tooling-3d-production-v1");
  assert.deepEqual(
    profile.createThreeDProductionManifest({ unit: "millimeter" }).materials,
    [],
  );
});
