# Native-ground tree appearance states

The `asset-tooling/recipes/tree-appearances` recipe maps explicit state IDs to material appearances of one accepted tree master. It consumes existing PNG AssetRefs and calls the existing `scene.material.base-color` processor. It generates no geometry, chooses no season, and runs no simulation RNG.

```ts
import { executeTreeAppearanceFamily, executeTreeAppearanceState } from "asset-tooling/recipes/tree-appearances";

const family = {
  schemaVersion: 1, id: "broadleaf.reference", source: acceptedTreeRef,
  placement: { axes: "right-handed-y-up", unit: "meter", origin: "native-root-ground-anchor" },
  states: [
    { id: "summer", baseColor: greenLeafPngRef, factor: [1, 1, 1, 1] },
    { id: "autumn", baseColor: orangeLeafPngRef, factor: [1, 1, 1, 1] },
    { id: "winter", baseColor: greenLeafPngRef, factor: [1, 1, 1, 0] },
  ],
};
const full = await executeTreeAppearanceFamily(root, family);
const autumnOnly = await executeTreeAppearanceState(root, editedFamily, "autumn");
```

The supported master has one static, embedded-resource scene with exactly three root nodes: `trunk`, `branches`, and `foliage`, all with identity transforms. Bark components use `tree-bark`; foliage uses `tree-foliage` with UV0. Actual trunk positions must reach Y=0 and all components must remain above ground within a 1e-6-meter tolerance. Source metadata must agree with the declared axes, meter units, and native-ground origin. These are the existing Sapling recipe's placement assumptions, not a universal origin/anchor schema. Incompatible authored components fail explicitly. Source byte/accessor limits reuse the existing GLB policy; families contain 1..16 unique portable state IDs.

Allowed changes are the selected foliage PNG and four 0..1 base-color factors. All states use straight-alpha PNGs, linear clamp-to-edge sampling and glTF MASK with cutoff 0.5. The finisher preserves all geometry attributes, indices, node transforms/hierarchy, bark and other material channels. Winter's zero alpha hides its retained foliage triangles; it does **not** remove geometry, save draw/vertex costs, change collision, or represent a depleted authoritative resource. Geometric bounds stay unchanged while visible bounds may differ. Consumers explicitly select appearances and retain season/growth/depletion, collision and placement authority.

Full execution preflights the master and every state's dependency before creating any output. Returned state results carry original input AssetRefs, existing material build identities and full output refs. Source/master bytes remain immutable. State order normalizes by ID, and each build identity depends on its selected state controls and shared source, never sibling order or parameters. Single-state execution runs one material derivation and verifies only its own texture plus the shared master. Reuse previously accepted sibling results while changing a state; use full execution as the independent replay. This adds no family cache, mutable registry or implicit scheduler. A shared source change changes every dependent state's build identity.

Package selected states through the existing static bundle profile, using the family ID as the key and state ID as the variant. Each GLB embeds its required textures. The existing exporter validates inputs before reuse and publishes the accepted manifest atomically, so a failed family derivation cannot replace an accepted package. Keep complete family/build evidence alongside your explicit distribution provenance contract; incidental metadata source hashes are not automatically fetched by static packaging.

Run the documented [tree generation](tree-recipes.md) example first, then:

```bash
bun examples/tree-appearances/build.ts
python3 examples/tree-appearances/review.py
```

The example reuses the accepted broadleaf master, colors one preserved leaf mask green/orange, and shares the green PNG with winter. It cold-replays the family, changes autumn alone and compares that result plus untouched siblings against full replay, verifies every geometry element and bark setting, packages three states, and loads them after deleting the independent source store. Static rendering skips meshes only when their original material alpha mode/factor proves every fragment invisible. This avoids finite transparent-ray bounce limits producing black silhouettes; culled geometry still contributes source bounds and framing. Opaque, zero-cutoff MASK and mixed-material meshes remain visible.

Four native Blender renders (master plus states) are independently rebuilt under identical camera/light settings. Ignored evidence records original refs/builds, operation counts and selected package identity. No consumer-camera or game-integration approval is claimed. #141 remains open for other concrete families, crop stages and runtime acceptance.
