# Decision Atlas

This is the owner-controlled source of **what asset-tooling should let users produce, inspect, customize and export**. Its only semantic entries are **Decisions** (explicit owner choices) and **Questions** (consequential choices not yet settled). IDs are stable: preserve Questions after answering them, append Decisions with an `Answers` link, and retain historical intent when revising a Decision. A Decision records desired behavior, **not** proof that it is implemented or visually approved.

Engineering boundaries and reproducibility rules remain in [AGENTS.md](../../AGENTS.md); issues track execution, not another product-intent authority. Other asset families may have different visual styles.

## 1. Humanoid characters

### 1.1. Character visual identity

#### Decision 1.1.1 — Move beyond block-built humanoids

**Approved by owner:** 2026-10-14. **Revises** the 2026-09-30 Quaternius-based direction recorded in [issue #107](https://github.com/moritzbrantner/asset-tooling/issues/107).

~~Use Quaternius Universal Base Characters as the reference and make them only a little less cartoony.~~ Produce recognizably **humanlike, properly modeled fantasy humanoids** rather than Roblox/Minecraft/Lego-like collections of rectangular primitives. Natural-looking body, head, hand and joint shapes; credible clothing, footwear and materials; and convincing movement matter more than merely adding polygons or bones.

Contemporary *World of Warcraft* characters are an **intermediate quality and presentation reference**: recognizable articulated people, shaped bodies, readable garments and equipment, and usable fantasy stylization. This is not a commitment to duplicate Blizzard models, a fixed polygon/bone count, or photorealism. Existing primitive-built characters may remain debug fallbacks but do not meet the intended visual result. Judge real model candidates in motion and at their intended gameplay camera distance, not only through validation results.

### 1.2. Animation as character content

#### Decision 1.2.1 — Rigged, moving humanoids with inspectable animation clips

**Approved by owner:** 2026-10-14.

Game-ready humanoid assets include a genuine articulated skeleton, skin/deformation relationships, and animation clips. Arms, hands, legs, shoulders and other relevant joints should **bend and move as parts of a character**, not behave like rigid block assemblies. A raw increase in bone count is not the acceptance criterion.

Users can select an asset, view its rest pose, play and inspect its available animations, and judge how the geometry and garments deform across poses. Animation is part of the reusable character asset/bundle rather than an unrelated demo effect. The asset viewer must make movement observable before an entire character family is accepted.

### 1.3. Appearance and part replacement

#### Decision 1.3.1 — Interchangeable visible character parts

**Approved by owner:** 2026-10-14.

A user can modify a humanoid's visible appearance by selecting **different heads, shoes/boots and shirts/tops**, with further compatible body, hair, clothing and armor variants able to use the same family workflow. The assembled result must remain a coherent **animatable character**: parts do not float, tear apart, or silently clip through the body during representative motion. Unsupported combinations are surfaced instead of being presented as successful.

These are editable, reusable visual-asset compositions that can be inspected and exported through asset-tooling; the consuming game retains ownership of inventory rules, equipment legality and gameplay state.

#### Question 1.3.2 — First supported source of replacement parts

For the first usable Pages-based humanoid customization experience, should users initially (A) choose from a curated library of pre-compatible heads/tops/footwear, (B) also import outside parts with explicit compatibility checks and failure feedback but no automatic refit, or (C) expect arbitrary imported parts to be automatically fitted and rigged? The chosen initial boundary materially changes what a successful first live edit proves. The longer-term scope can expand separately.

## 2. Character inspection and editing

### 2.1. Asset workbench

#### Decision 2.1.1 — Inspect, animate, alter and export from one asset-tooling experience

**Approved by owner:** 2026-10-14.

The asset-tooling experience must make humanoid content **visually inspectable and modifiable**, not only generate files behind a CLI. Users should be able to open a real character, inspect its skeleton-influenced movement and animations, change supported appearance components, compare the resulting character, and produce a reusable asset. Animation playback and part changes belong to that same understandable workflow, without requiring gameplay or a separate game's character editor.

This complements other procedural, 2D, environment and effect capabilities rather than replacing them. It does not authorize a competing 3D renderer, rigging algorithm, animation engine or workflow system: those stay with their established owners. Technical correctness, owner visual approval and consumer readiness remain distinct.

## Related execution coverage

Existing issues already cover the main outcomes: [#108](https://github.com/moritzbrantner/asset-tooling/issues/108) visual baseline, [#109](https://github.com/moritzbrantner/asset-tooling/issues/109) approved source, [#110](https://github.com/moritzbrantner/asset-tooling/issues/110) first skinned bundle, [#111](https://github.com/moritzbrantner/asset-tooling/issues/111) animation viewer, [#116](https://github.com/moritzbrantner/asset-tooling/issues/116) appearance variants, [#117](https://github.com/moritzbrantner/asset-tooling/issues/117) garments and armor, and [#127](https://github.com/moritzbrantner/asset-tooling/issues/127) editable workbench. Those issues are implementation scope, not alternate product Decisions. The open Question 1.3.2 should not block the independently settled visual or animation work.
