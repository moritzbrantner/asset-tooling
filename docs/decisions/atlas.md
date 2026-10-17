# Decision Atlas

This is the owner-controlled source of **what asset-tooling should let users produce, inspect, customize and export**. Its only semantic entries are **Decisions** (explicit owner choices) and **Questions** (consequential choices not yet settled). IDs are stable: preserve Questions after answering them, append Decisions with an `Answers` link, and retain historical intent when revising a Decision. A Decision records desired behavior, **not** proof that it is implemented or visually approved.

Engineering boundaries and reproducibility rules remain in [AGENTS.md](../../AGENTS.md); issues track execution, not another product-intent authority. Other asset families may have different visual styles.

## 1. Humanoid characters

### 1.1. Character visual identity

#### Decision 1.1.1 — Move beyond block-built humanoids

**Approved by owner:** 2026-10-14. **Revises** the 2026-09-30 Quaternius-based direction recorded in [issue #107](https://github.com/moritzbrantner/asset-tooling/issues/107).

~~Use Quaternius Universal Base Characters as the reference and make them only a little less cartoony.~~ Produce recognizably **humanlike, properly modeled fantasy humanoids** rather than Roblox/Minecraft/Lego-like collections of rectangular primitives. Natural-looking body, head, hand and joint shapes; credible clothing, footwear and materials; and convincing movement matter more than merely adding polygons or bones.

Contemporary *World of Warcraft* characters are an **intermediate quality and presentation reference**: recognizable articulated people, shaped bodies, readable garments and equipment, and usable fantasy stylization. This is not a commitment to duplicate Blizzard models, a fixed polygon/bone count, or photorealism. Existing primitive-built characters may remain debug fallbacks but do not meet the intended visual result. Judge real model candidates in motion and at their intended gameplay camera distance, not only through validation results.


#### Question 1.1.2 — First real humanoid source candidate

In [issue #108](https://github.com/moritzbrantner/asset-tooling/issues/108), the owner compared three candidates for the **first** humanlike clothed, skinned fantasy character: (A) Quaternius Universal Base Characters (Standard) plus Modular Character Outfits – Fantasy (Standard), `Male_Ranger`; (B) KayKit Adventurers 2.0 Ranger; or (C) MPFB/MakeHuman CC0 character. This selects the source direction for a verified baseline; it is not by itself a passed animation/appearance inspection.

**Answered by Decision 1.1.3.**

#### Decision 1.1.3 — Start the humanoid baseline with Quaternius Ranger (candidate A)

**Approved by owner:** 2026-10-15. **Answers 1.1.2 (option A).**

Use the **Quaternius Universal Base Characters (Standard)** and **Modular Character Outfits – Fantasy (Standard), Male_Ranger** as the selected **first character source/baseline** for the actual rigged, clothed archer comparison and production candidate. The freely licensed Standard variants and matching source identities evaluated in [issue #108](https://github.com/moritzbrantner/asset-tooling/issues/108) are the starting point, not permission to import unverified assets, discard source provenance or expand a whole library now. Other candidates remain comparison references, not equal defaults.

**Preserve Decision 1.1.1's humanlike quality requirement and Decision 1.2.1's real skinned animation requirement.** The source outfit/body do not come with suitable plain idle/walk clips; the evaluation used third-party Universal Animation Library clips without proper rest-pose correction. Production use therefore requires a licensed, pinned animation source, authoritative retargeting where necessary, and independently inspectable rest/idle/walk deformation, materials, equipment fit and actual gameplay-distance comparison. Record outstanding material/normal-map dependencies and source/rig mismatches rather than hiding them. **Selecting A does not claim the scratch renders, finished GLB, exact rebuild, visual quality or MMORPG/ARPG consumer use have passed acceptance.** Canonical source promotion and the usable bundle remain owned by #109 and #110, with inspection under #108/#111.

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

#### Decision 1.3.3 — Start customization with a curated compatible parts library

**Answers:** 1.3.2. **Approved by owner:** 2026-10-14, option A.

The first usable character-customization experience offers a **curated library of pre-compatible heads, shirts/tops and shoes/boots**. A user selects alternatives on the same rigged character, previews the changes during actual animation, and exports/reopens the assembled animated asset. Preserve fitting, attachment, skin deformation and declared source/rig compatibility instead of presenting incompatible parts as successful.

Importing arbitrary third-party replacement parts or automatically fitting/rigging them is **not required for this first release**; those are possible later extensions, not currently approved commitments. The curated approach is a staged delivery boundary, not a limit on the intended realistic character quality or other asset-workbench capabilities.

## 2. Character inspection and editing

### 2.1. Asset workbench

#### Decision 2.1.1 — Inspect, animate, alter and export from one asset-tooling experience

**Approved by owner:** 2026-10-14.

The asset-tooling experience must make humanoid content **visually inspectable and modifiable**, not only generate files behind a CLI. Users should be able to open a real character, inspect its skeleton-influenced movement and animations, change supported appearance components, compare the resulting character, and produce a reusable asset. Animation playback and part changes belong to that same understandable workflow, without requiring gameplay or a separate game's character editor.

This complements other procedural, 2D, environment and effect capabilities rather than replacing them. It does not authorize a competing 3D renderer, rigging algorithm, animation engine or workflow system: those stay with their established owners. Technical correctness, owner visual approval and consumer readiness remain distinct.


## 3. Greyhaven environment assets

### 3.1. Initial sources and future originals

#### Decision 3.1.1 — Start with Medieval Village and Fantasy Props MegaKits

**Approved by owner:** 2026-10-14. **Resolves** the environment-source/style question in [issue #118](https://github.com/moritzbrantner/asset-tooling/issues/118).

Use **Quaternius Medieval Village MegaKit** and **Fantasy Props MegaKit** as the initial source kits for the reusable Greyhaven environment bundle, beginning with a building, a tree and an everyday prop. Apply the existing license/provenance, catalog, material and packaging requirements; assess the assembled scene at the actual gameplay camera. The kits' stylization is acceptable for this first environment slice even though humanoid characters follow the more humanlike direction in Decision 1.1.1.

Use these kits as **inspiration for our own original environment assets in the future**; their adoption does not establish them as a permanent asset dependency or mandate their exact visual style for future content. Creating original replacements is not a prerequisite for delivering [#118](https://github.com/moritzbrantner/asset-tooling/issues/118), and existing game/physics ownership boundaries remain unchanged.

## 4. Production-quality 2D game icons

### 4.1. Generated, reviewed ability artwork

#### Decision 4.1.1 — Curated ComfyUI MCP generation through asset-tooling

**Approved by owner:** 2026-10-16. **Chooses B — curated asset-tooling pipeline using local ComfyUI MCP, not fal.**

`asset-tooling` owns a reusable **generate candidates → compare → explicitly approve → process → export** workflow for original, high-quality **painted raster fantasy game icons**. A coding agent may drive a locally installed ComfyUI instance through its existing [Comfy-Org MCP server](https://github.com/Comfy-Org/comfy-mcp), but **ComfyUI owns image inference only**; the MCP connection is authoring-time tooling and never a game-runtime service. The pipeline must accept and verify externally produced images using existing content-addressed assets, image-processing operations, receipts/provenance and selected PNG bundle exports, not build a parallel generation engine, workflow runner, approval database or PNG packer.

Versioned per-icon briefs describe semantic subject, intended ability, original visual style, composition/contrast, reference permissions and chosen export sizes. Keep the exact ComfyUI workflow/model/checkpoint/seed/node or dependency revisions, candidate/input/output hashes and license evidence needed to explain a run; **a seed does not establish byte-identical replay**, and externally generated candidate bytes are not declared reproducible without actual verification. Approval is explicit and tied to **selected asset bytes**, with candidate and approved states distinguishable; regenerate/replace never silently inherits approval. Preserve the source master and practical game-size outputs. Generated, paid-partner or cloud-model outputs must not be silently used; an approved local workflow can run offline from declared prepared inputs, and an unavailable ComfyUI/MCP/model must fail visibly rather than emit a fabricated success.

**MCP is optional to consumers**: games load only stable, approved exports and do not need ComfyUI, a coding agent, network access or model weights at runtime. Do not regenerate artwork automatically when a Decision Atlas entry or ability code changes. Existing asset-tooling 2D operations, review surface and bundle contract remain canonical; 3D-to-icon derivation is an optional separate capability. ([asset-tooling #135](https://github.com/moritzbrantner/asset-tooling/issues/135); [#142](https://github.com/moritzbrantner/asset-tooling/issues/142); [#125](https://github.com/moritzbrantner/asset-tooling/issues/125); [#127](https://github.com/moritzbrantner/asset-tooling/issues/127))

#### Decision 4.1.2 — First coherent Warden ability-icon set

**Approved by owner:** 2026-10-16. **First consumer: MMORPG Warden.**

Prove the pipeline with **Heroic Strike, Shield Bash, Rallying Cry and Cleave** (MMORPG stable ability IDs **1–4**), not an entire speculative ability library. The quality reference is the small-size readability, class identity and painterly polish of established fantasy games such as *World of Warcraft* and *Dota 2*, **never their copyrighted image content, characters or distinctive copied compositions**. Design original square, expressive ability illustrations with immediately recognizable silhouettes, restrained clutter, appropriate steel/impact/defense/healing cues and a **coherent set-wide treatment**. Prefer a square high-resolution raster master (initially around 512×512) with derived browser/native-use PNGs (initially 64, 48 and 32 pixels) where useful; exact sizes are consumer export tuning, not a universal asset schema.

**Acceptance:** In asset-tooling's real published preview/gallery, compare actual candidate images and inspect four explicitly selected approved masters as a set, including their real **32–64 px appearance**. The chosen outputs must be distinguishable without relying only on hue and must retain their identity when adjacent in a compact action bar. Export a content-verified four-ability PNG package with stable `warden.ability.<id>` keys and source/provenance evidence. Only then may MMORPG consume it. No false approval from a prompt, generator exit status or passing pixel hash alone. Future Ranger, Arcanist, item or aura icon families may reuse the pipeline but are **not** required by this first slice. ([MMORPG Decision Atlas](https://github.com/moritzbrantner/mmorpg/blob/main/docs/decisions/atlas.md))

#### Decision 4.1.3 — Approval is the exact selection in a bundle export

**Approved by owner:** 2026-10-17 ("I want the method that has the least overhead"), during the #223 preflight. This chose the bundle-selection option over a committed approval manifest or a catalog "generated" source.

A human approves generated images by **naming the exact approved bytes (sha256) in a bundle export's selection**. Exporting is the approval act; there is no separate approval manifest, review commit or approval database. The export admits only selections whose source bytes match the named sha. A regenerated image has new bytes and is therefore never approved implicitly. Candidates that are not selected stay candidates. Approval does not exist outside an export, so a preview or gallery cannot show "approved but not yet exported" unless a later Decision adds that. Keep existing bundle versions compatible by using a new bundle version or profile. Decision 4.1.2's visual acceptance (comparing candidates, judging at 32–64 px) still applies before the owner names the selected bytes.

#### Decision 4.1.4 — FLUX.2 [klein] 4B and Z-Image Turbo replace SD 1.5 for icon generation

**Approved by owner:** 2026-10-17 ("SD 1.5 can be deprecated or removed entirely"), on [#211](https://github.com/moritzbrantner/asset-tooling/issues/211). **Supersedes** the model choice of the 2026-10-16 owner decision recorded in [#212](https://github.com/moritzbrantner/asset-tooling/issues/212) (Stable Diffusion 1.5 for the first real ComfyUI run). Decisions 4.1.1–4.1.3 and 5.1.1 are unchanged.

The supported local image models for ability-icon generation through ComfyUI are **FLUX.2 [klein] 4B** (Black Forest Labs) and **Z-Image Turbo** (Tongyi-MAI). Both are Apache-2.0 according to their official Hugging Face model cards. Use them as prepared, revision-pinned and hash-verified local files, never as hosted or partner models, and compare their candidates side by side before the owner selects a master. **Stable Diffusion 1.5 is deprecated**: do not generate new candidates with it. Its existing review candidates, workflow and pins stay as provenance history and are marked deprecated. This Decision does not withdraw an approval the owner already gave to SD 1.5 bytes, and a new model's image never inherits it (Decision 4.1.3). This chooses models; it does not claim that any candidate is visually accepted.

#### Decision 4.1.5 — The Warden set uses FLUX.2 [klein] 4B with tight, margin-free framing

**Approved by owner:** 2026-10-17 ("we shall go with the FLUX.2 options. Each icon needs to be a bit more zoomed in. We can't waste pixels on margins."), on [#211](https://github.com/moritzbrantner/asset-tooling/issues/211), after comparing the candidates of Decision 4.1.4. **Narrows** Decision 4.1.4 for this set only; Decisions 4.1.1–4.1.4 are otherwise unchanged.

**FLUX.2 [klein] 4B** is the selected model for the Warden ability-icon set (Decision 4.1.2). Z-Image Turbo stays a supported model under Decision 4.1.4, but it is not used for this set. Every Warden icon is a **tight close-up whose subject fills the square**: the subject may run off the edges, and there is no empty background border, vignette margin or frame. A small icon must not spend pixels on margins. Earlier FLUX.2 [klein] and Z-Image Turbo candidates for this set stay as superseded history. If a kept render still shows a margin, a tighter square crop through the existing image operations is allowed when it is recorded as a derivation from the original master (both hashes) and is never upscaled beyond the master's detail. This chooses model and framing; it does not approve any candidate (Decision 4.1.3).

## Related execution coverage

Existing issues already cover the main outcomes: [#108](https://github.com/moritzbrantner/asset-tooling/issues/108) visual baseline, [#109](https://github.com/moritzbrantner/asset-tooling/issues/109) approved source, [#110](https://github.com/moritzbrantner/asset-tooling/issues/110) first skinned bundle, [#111](https://github.com/moritzbrantner/asset-tooling/issues/111) animation viewer, [#116](https://github.com/moritzbrantner/asset-tooling/issues/116) appearance variants, [#117](https://github.com/moritzbrantner/asset-tooling/issues/117) garments and armor, and [#127](https://github.com/moritzbrantner/asset-tooling/issues/127) editable workbench. Those issues are implementation scope, not alternate product Decisions. The open Question 1.3.2 should not block the independently settled visual or animation work.

## 5. ComfyUI-first production and capability convergence

### 5.1. External golden reference and selective internal implementations

#### Decision 5.1.1 — Wrap ComfyUI first, then selectively match and improve its capabilities

**Approved by owner:** 2026-10-16. **Extends** Decision 4.1.1 beyond ability icons; it does not replace that decision's review/approval requirements.

Use **ComfyUI as the golden reference for supported generative-media capabilities**, with `asset-tooling` as the reusable, project-facing wrapper. Initially call real prepared ComfyUI workflows through supported external interfaces instead of rebuilding ComfyUI's native graph editor, model loaders, inference engine, queue, or internal caching. Preserve native ComfyUI workflow identity while exposing stable versioned asset operations, verifiable input/output identities, provenance, inspectable candidates, explicit approval, and game/application-ready exports. ComfyUI and its models are **authoring/production dependencies only**; consuming applications run without them.

Over time, `asset-tooling` may **reimplement, refine and replace individual frequently used ComfyUI capabilities** where a real consumer demonstrates a meaningful advantage. For each capability, compare a pinned ComfyUI reference and the proposed first-party implementation with actual functional/visual acceptance, performance and failure/recovery evidence. Preserve compatible asset-facing contracts and an **explicit, versioned external-versus-internal provider choice** so adoption and rollback never silently change past builds or approved outputs. A seed alone does not establish byte reproducibility; do not require identical pixels of nondeterministic generation as a false proxy for quality. Do not clone ComfyUI wholesale or copy external code/assets without honoring their licenses.

Keep generic workflow ownership separate: `workflow-editor` authors higher-level typed workflows, `workflow-runner` executes generic operations and hands an entire ComfyUI graph to ComfyUI as one external job, and `workflow-engine` handles workflow registration, schedules, and top-level dispatch. Do not add a second ComfyUI graph authority or inference queue. Current deterministic procedural tools and authoritative Blender/3d-lab processors continue to work independently. This is approved direction, **not evidence of a working ComfyUI adapter or visually approved artwork**.

Implementation boundary and evidence: [ComfyUI-first architecture](../comfyui-first.md), [first provider slice #212](https://github.com/moritzbrantner/asset-tooling/issues/212), and [Warden consumer acceptance #211](https://github.com/moritzbrantner/asset-tooling/issues/211).


#### Decision 5.1.2 — One evolved image-generation operation with an explicit provider

**Approved by owner:** 2026-10-17 ("we will use flux and zimage turbo, but yea. That option."), on [#222](https://github.com/moritzbrantner/asset-tooling/issues/222). **Applies** Decision 5.1.1's explicit provider choice to prompt-level image generation.

Where an internal (Diffusers) and a ComfyUI path both generate images, they sit behind **one evolved, versioned operation with prompt-level inputs and a required `provider` choice** (`diffusers` or `comfyui`). The ComfyUI provider fills a **repository-owned, hash-pinned template workflow** and runs it through the existing ComfyUI transport. The provider is part of the build identity. There is no implicit fallback, and an unavailable provider fails visibly. The existing `image.stable-diffusion.generate@1` stays unchanged and Diffusers-only, so past builds never switch provider. The target models are FLUX.2 [klein] 4B and Z-Image Turbo (Decision 4.1.4), not only SD 1.5. The operation's exact name and its model-specific parameters (for example guidance, scheduler, precision and text encoders) are an implementation question for #222 and still need owner confirmation. They are not settled by this Decision.

#### Decision 5.1.3 — Local tool setup is idempotent and converges managed state

**Approved by owner:** 2026-10-17 ("There should be idempotent scripts to set up the environment."), on [#220](https://github.com/moritzbrantner/asset-tooling/issues/220). **Replaces** the earlier setup rule that an inconsistent managed installation always fails closed instead of being upgraded.

Re-running repository setup on a managed installation under `.artifacts/toolchain` brings it to the pinned, declared state. Re-running it on a correct installation changes nothing. `doctor` stays read-only and reports any mismatch until setup is re-run. Convergence only touches tool-managed state; user-owned or unmanaged installations are never modified. The first case is the ComfyUI CPU profile: an existing install with a CUDA torch build, or no torch record, converges to the hash-pinned `+cpu` torch and torchvision wheels (Linux x86_64, cp310–cp315 only; other platforms fail closed before installing). Other kinds of drift keep failing closed until they gain an explicit convergence step.

#### Decision 5.1.4 — `image.generate@1`: provider plus pinned model profiles

**Approved by owner:** 2026-10-17, answering the #222 pre-implementation questions. **Refines** Decision 5.1.2, settling the operation name and parameters that 5.1.2 left open.

- **Operation:** the evolved operation is **`image.generate@1`** with a required `provider`.
- **Model profile:** a required `model` id (initially `flux2-klein-4b` and `z-image-turbo`) pins the model files (diffusion model, text encoder, VAE), a newly authored, repository-owned template workflow and the default settings.
- **Recipe parameters:** recipes set `prompt`, `seed`, `width` and `height`, plus an optional `steps`. The sampler settings (`sampler`, `scheduler`, `guidance`/cfg, `shift`) are **optional overrides with sensible profile defaults** ("like that but also the sampler knobs as optional parameters (with sane defaults)").
- **Negative prompts:** `negativePrompt` is rejected by profiles that don't use one.
- **Providers:** ComfyUI is the first provider for both models. Diffusers support for these models is a follow-up, and selecting a provider that doesn't support the chosen model fails visibly.
- **Unchanged:** `image.stable-diffusion.generate@1`, and the #211 review workflows, which stay review provenance.

#### Decision 5.1.5 — Cancelling a ComfyUI job only touches that job

**Approved by owner:** 2026-10-17, answering the #224 pre-implementation questions.

- **Signal:** cancellation reaches an asset operation as an `AbortSignal` passed to `runAssetOperation(..., { signal })`. The workflow executor forwards the runner's signal into it.
- **Queued prompt:** a queued prompt of this operation is deleted.
- **Running prompt:** it is **never interrupted**, neither globally nor by a targeted interrupt. The run is reported as ambiguous ("may still finish on the server"), and nothing is stored or cached.
- **Completion race:** the cancel wins. An output that completed meanwhile is neither imported nor cached.
- **Cancel during submission:** the operation looks up its own `client_id` in the queue and deletes the prompt if it is queued. Otherwise it reports an ambiguous submission and never resubmits.

## 6. Shared source acquisition

### 6.1. Sources without a stable download URL

#### Decision 6.1.1 — Promote itch.io-only CC0 sources from an owner-downloaded local file

**Approved by owner:** 2026-10-17, on [#109](https://github.com/moritzbrantner/asset-tooling/issues/109). It chose local-file promotion over an itch.io signed-URL resolver or an owner-hosted mirror.

Some selected sources, such as the Quaternius Universal Base Characters and Modular Character Outfits packs, are distributed only through itch.io's short-lived signed download URLs. The owner downloads such an archive once. A **local-file mode of canonical LFS promotion** (`catalog:lfs:promote -- <id> --from <file>`) then pins and stores it. The **SHA-256 and byte-length pin is authoritative**. The source record keeps the itch.io page and upload id as provenance, along with the license evidence. Archive-member selection, license policy and the review-branch/PR validation are unchanged. The LFS object becomes the durable copy, so hosted re-acquisition of such a source is not expected.

#### Decision 6.1.2 — First humanoid source set from Universal Base Characters

**Approved by owner:** 2026-10-17, answering the #109 pre-implementation questions. **Applies** Decisions 1.1.3 and 6.1.1.

The first humanoid source is the **Quaternius Universal Base Characters** pack (<https://quaternius.com/packs/universalbasecharacters.html>), not the Ultimate Animated Character pack that mmorpg picked up by mistake (corrected in mmorpg#210).

- **Members promoted:** the **Male Ranger** outfit from Modular Character Outfits – Fantasy and the **matching male base body**, together with every buffer and texture they reference, stored as archive members in canonical LFS.
- **Missing normal maps:** ~~two normal maps that the base body references but the archive does not contain are left out, and that is recorded as a known import gap. No data is invented. Whether they can be derived deterministically (for example by a Blender bake) is investigated separately.~~ Superseded by Decision 6.1.3: the known gap is replaced by a declared substitution.
- **Clips:** the **UAL1 Standard `Idle_Loop` and `Walk_Loop`** clips are promoted as source members. Retargeting stays with #110/#115.

#### Decision 6.1.3 — Declared substitution for the two misnamed normal maps

**Approved by owner:** 2026-10-17, on [#109](https://github.com/moritzbrantner/asset-tooling/issues/109). **Supersedes** the known gap in Decision 6.1.2.

`Superhero_Male_FullBody.gltf` references two normal maps under names the archive does not contain. This is a Blender glTF exporter `_png.png` naming artifact, not a missing bake. The two URIs are bound to the textures in the same folder:

- `T_Hair_1_Normal_png.png` → `T_Hair_1_Normal.png`
- `T_Eye_Normal_png.png` → `T_Eye_Normal.png`

The substitutes are the archive's +Y (OpenGL) normal maps. They are promoted as ordinary archive members, and each record names the URI it stands in for in `metadata.substitutesFor`. **No bytes are invented or edited:** the source glTF and both textures stay exactly as the archive ships them. A minimal idempotent re-import is the provenance proof: importing again into the same object store changes nothing.
