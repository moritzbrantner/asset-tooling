# The `quadruped-rigid` profile and the Zoo animals

[#128](https://github.com/moritzbrantner/asset-tooling/issues/128) proves the pipeline carries one non-humanoid family, under [Decisions 8.1.2 and 8.1.4](decisions/atlas.md). It reuses Zoo's already-authored low-poly animals: nothing is modelled, skinned or animated here. The first animal is the **zebra**, and the **giraffe** goes through the same path to prove reuse. This covers Zoo's actual art and deformation contract (rigid parts on pivoted joints) and makes no claim about skinned quadrupeds.

## Source and licence

| Key (variant `default`) | Catalog source | Size (W × H × D, m) | Triangles | Parts | Materials |
| --- | --- | --- | --- | --- | --- |
| `zoo.animal.zebra` | `zoo.zebra-glb` | 1.50 × 1.26 × 0.60 | 2,260 | 24 | 2 |
| `zoo.animal.giraffe` | `zoo.giraffe-glb` | 1.39 × 2.12 × 0.60 | 2,432 | 33 | 3 |

Both GLBs are from [moenarch-games/zoo](https://github.com/moenarch-games/zoo) at commit `a357730`, generated there by `tools/build_assets.py` from Blender primitives with no imported third-party content. They are catalog sources of the `moenarch-zoo` provider, pinned by SHA-256 and byte length and stored in Git LFS under `assets/canonical/`.

**Licence:** MIT, as the owner declared on [#128](https://github.com/moritzbrantner/asset-tooling/issues/128#issuecomment-6719424007) (2026-11-08), matching the Zoo crates. That statement is the licence evidence. The copyright notice (`Copyright (c) 2026 moritzbrantner`, [`licenses/zoo-animals-MIT.txt`](../licenses/zoo-animals-MIT.txt)) travels inside the bundle's descriptor attachment, and is published next to the tar as `zoo-animals.LICENSE.txt`.

## Profile rules

`src/quadruped-rigid.ts` holds the rules. It selects by the catalog tag `quadruped-rigid`, and packaging validates the same `inspectQuadrupedRigid` checks at each stage, reporting every issue at once. A source tagged both `skinning` and `quadruped-rigid` is rejected as ambiguous, so the humanoid path and this one do not overlap. A species may add joints beyond the required ones, for example the giraffe's `neck`.

| Area | Rule |
| --- | --- |
| Rig | One scene root named `animal_root`, with an identity transform. No skin, and no morph targets or morph channels. Every node is named uniquely and sits under the root. |
| Joints | Required: `animal_root`, `body`, `head`, `tail`, `leg_0` to `leg_3`. Each except the root must move geometry. A leg's pivot sits at the top of its own mesh, within 2 cm. |
| Clips | Required: `idle` and `walk`, each with a name, a duration and at least two strictly increasing finite keys per channel. Channels must target rig nodes and may not repeat a node and path. |
| `idle` | At least one channel moves. |
| `walk` | Rotates all four legs. In place: the net horizontal travel of `animal_root` and `body` from the first to the last key is at most 1 mm. A vertical bob and other joints are free. |
| Bounds | Rest pose: finite and grounded (minimum y within 1 cm of 0). Each extent between 0.05 m and 8 m, with the rig origin inside the footprint. |

The profile does not judge art. A walk whose legs rotate on the wrong axis still passes it, as the zebra's does; see [What the viewer shows](#what-the-viewer-shows).

## The `biped-rigid` sibling

Two-legged animals such as Zoo's flamingo and penguin use `biped-rigid` (`src/biped-rigid.ts`, owner answer on [#605](https://github.com/moritzbrantner/asset-tooling/issues/605)). It keeps every rule above and differs only in the joints: it requires `animal_root`, `body`, `head`, `tail`, `leg_0`, `leg_1`, `wing_left` and `wing_right`, and its `walk` must rotate the two legs. `quadruped-rigid` and its animals are unchanged.

A family may package both kinds together: a member that names `profile: BIPED_RIGID` is checked against it at every stage, and its descriptor entry records `"profile": "biped-rigid"`. The descriptor's top-level `profile` stays `quadruped-rigid`, the family default; each entry's own `profile` is the one it passed.

## Packaging

`packageQuadrupedRigidFamily` takes a family's pinned sources through the shared boundaries: the profile checks the source, `scene.import.gltf@2` imports it and the profile checks it again, a `gltf-resources-v1` bundle is exported and packed, and the profile checks the packaged glTF. The rig measurements must match at every stage. The build fails closed on any mismatch, and a rebuild packs byte-identical tars. Neither animal has textures, so there is no KTX2 step.

```sh
git lfs pull --include="assets/canonical/zoo.zebra-glb/**,assets/canonical/zoo.giraffe-glb/**"
bun scripts/build-zoo-animals.ts --out .artifacts/zoo-animals
```

It writes `zoo-animals.tar` (+ `.sha256`), `export.ref.json`, `zoo-animals.descriptor.json`, `zoo-animals.LICENSE.txt` and `lineage.json`, in under a second and without Blender. The descriptor `zoo-animals-descriptor-v1` is attached to the first animal and holds the conventions, the licence with its full text, and per animal the source `AssetRef`, provenance and measured rig. CI publishes the rolling `zoo-animals` release when this merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)).

Conventions are as authored: metres, +Y up, right-handed, the animal faces **+X** (the Greyhaven animals face +Z), and the root is on the ground plane. Each entry stays presentation only. Placement, gameplay and physics belong to the consumer.

## Inspecting

Open `viewer/?asset=zoo.zebra-glb` or `viewer/?asset=zoo.giraffe-glb` in the [existing animation viewer](animation-viewer.md) on Pages; the viewer plays their real `idle` and `walk` clips from the pinned source, with the rig kind, licence and copyright notice listed. Because the animals face +X, the viewer's **Front** preset shows their profile and its **Side** preset shows them head-on.

`test/browser/zoo-animals-viewer.spec.ts` checks the real animals in Chromium when the LFS payloads are hydrated. `test/quadruped-rigid.test.ts` covers the selection, rig, clip and bounds rejections, source lineage and byte-stable packaging with a synthetic rig that needs no hydrated payloads.

### What the viewer shows

- Both animals read clearly as a zebra and a giraffe, with the expected proportions and stripes or ossicones. Idle is a gentle head, tail and root-bob loop.
- **Authoring issue kept as is:** Zoo's `walk` rotates each leg about the X axis, and the animals face +X, so the legs splay sideways instead of swinging forward and back. From the side the legs barely move. The generator line is `animate_rotation(leg, "walk", "X", ...)`. It is reported here for [Zoo #112](https://github.com/moenarch-games/zoo/issues/112), and this repository does not reshape the animals.

## Follow-up slices

1. **Zoo runtime adoption** stays with [Zoo #112](https://github.com/moenarch-games/zoo/issues/112): load `zoo-animals`, decide whether to replace the sideways walk (a new or corrected source of the same animal, through this path), and meet its own guest-viewable exhibit acceptance.
2. **More Zoo quadrupeds.** The elephant and capybara share this rig shape; each needs a catalog entry and a key in `ZOO_ANIMALS`. Check them against the profile first. The penguin and flamingo are bipeds and use the `biped-rigid` sibling.
3. **An MMORPG/ARPG creature** ([Atlas 6.6.20](decisions/atlas.md)) is a skinned rig with its own family-specific attacks and boss signature clips, so it needs its own validated profile. It may reuse this profile's bundle and clip conventions, but it is not delivered by this proof.
4. **Mounted units and siege equipment** have separate rider composition and mechanical motion needs, and come much later.
