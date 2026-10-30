# asset-tooling

Reproducible, traceable tooling for generating and processing game and application assets.

The repository treats generated and processed assets as build artifacts. Generation intent, generator/model identity, declared dependency bytes, execution environment, outputs, processing observations, and replay evidence are recorded so reproducibility can be tested instead of assumed.

The [Greyhaven nature bundle](docs/greyhaven-nature-bundle.md) delivers game-resolution broadleaf, conifer and rock families for the MMORPG.

The [Greyhaven ambient animals](docs/greyhaven-ambient-animals.md) are a cat, a dog and a small rodent from CC0 Quaternius sources, each with in-place `Idle` and `Walk` clips, sized for the MMORPG's game camera.

The [undead crypt kit](docs/crypt-kit.md) is a scripted Blender recipe for ARPG's first adventure: 2 m wall and doorway modules, a hinged door, floor tiles, pillars and props.

The [sunken shrine and cave kit](docs/shrine-kit.md) is a scripted Blender recipe for the MMORPG's Sunken Shrine in Stillwater Lake: 4 m limestone wall and arch modules with a carved fish-and-wave frieze, fluted pillars, a relic altar, joinable cave tunnel modules, a wider air-pocket room and props.

The [Greyhaven Outpost building kit](docs/outpost-kit.md) is a scripted Blender recipe for the MMORPG's Outpost house and smithy exteriors: 2 m timber-frame wall modules with windows and a doorway, a hinged plank door, corner posts, a gable, shingle or slate roof sections and a chimney, with compositions for the house and smithy footprints.

The [Greyhaven settlement props](docs/settlement-props.md) are a scripted Blender prop set in the same style for an Outpost public space: a market stall, handcart, crate and barrel, a signpost, lantern post and bench, and a fence segment, planter and woodpile, with a market-square composition.

[Marshal Elden Greywatch's house](docs/greyhaven-marshal-house.md) is an enterable, furnished private home on the MMORPG's west Outpost house footprint: the kit's house exterior with a hinged door, a floor, a hideable ceiling and roof, a bed, chest, table, bench, chair, hearth, the Marshal's weapon rack and shield, box colliders, and spots for the knock, the doorway and the bed.

The [toy-like farm structures](docs/farm-structures.md) are a scripted Blender recipe for My Farm: a chunky red-and-white Farmhouse with a dark roof and a pale domed Silo, sized for 2 × 2 tile footprints.

The [toy zoo scenery](docs/zoo-scenery.md) is a scripted Blender recipe for Zoo: flat-colour, untextured round and pine trees, a berry bush and a boulder, each fitting one 1 m tile.

The [Zoo particle flipbooks](docs/zoo-effects.md) are baked 16-frame dust, leaf and splash atlases with matching `BurstPreset`s for 3d-lab's seeded bursts, from a deterministic 2D recipe.

The [ARPG combat flipbooks](docs/combat-effects.md) are baked 16-frame hit-spark, block-spark, impact-dust and weapon-trail atlases with matching `BurstPreset`s for arpg's strike feedback, from the same deterministic 2D rasterizer.

The [combat sounds](docs/combat-sounds.md) are 35 CC0 mono WAV clips (Kenney and OpenGameArt) for arpg's combat, pickup, encounter and UI cues, trimmed and normalised, with a game-audio `SoundManifest`.

## Review current assets

Start with the [asset gallery](https://moritzbrantner.github.io/asset-tooling/). It links directly to the [Ranger animation comparison](https://moritzbrantner.github.io/asset-tooling/compare/ranger/), the [Warden icon review](https://moritzbrantner.github.io/asset-tooling/review/warden-icons/), and the [browser 3D studio](https://moritzbrantner.github.io/asset-tooling/generate/). Compare at the intended camera, animation frame and action-bar size before requesting a new generator or foundation capability.

During experimentation, generated outputs are replaceable **current** work, not a series of required release versions. Each experimental bundle has one rolling release named after it (for example `humanoid-ranger-male`) whose assets are replaced in place (Decision 7.1.5). The public Ranger comparison shows that release at Pages build time and identifies it in the caption by its tar hash; a local build can supply any working Ranger tar. It does not automatically inspect uncommitted local candidates. Once a consumer accepts an artifact, that consumer deliberately updates its input. Source licenses and the checks needed to load compatible assets remain separate from disposable-output history. See [Decision 7.1.4](docs/decisions/atlas.md).

## Publishing a rolling release

Rolling releases publish themselves from CI (#397). Merging a change starts the [`Publish rolling releases`](.github/workflows/publish-releases.yml) workflow on `main`. It rebuilds every release whose sources the push changed and replaces that release's assets in place with `gh release upload --clobber`, under the release's one name. It never creates a numbered release. Workers do not hand the owner upload commands for these releases.

- **Which releases.** `ROLLING_RELEASES` in [`scripts/publish-release.ts`](scripts/publish-release.ts) lists each release with its build script and what its job needs (Blender, LFS, a pinned 3d-lab processor, KTX-Software and a longer timeout for the two Ranger figures, #399). A release's sources are its build script and that script's local imports, the repository files they name (for example `adapters/blender/outpost.py` or `catalog/storage.json`), Blender's pin and the LFS payloads when the build needs them, and `package.json`, `bun.lock` and `scripts/pack-asset-bundle.ts`. The workflow installs Blender from the official tarball pinned in `adapters/blender/release.json`, caches the archive, and hydrates `assets/canonical/` for the builds that read catalog payloads.
- **What it uploads.** Every top-level file of the build output: the tar, its `.sha256`, `export.ref.json`, `lineage.json`, descriptors and the flipbook PNGs. `export.ref.json` goes last, so a consumer keyed on it never sees a new ref beside the old tar. Then it dispatches `pages.yml`.
- **Checks first.** It verifies the tar against its `export.ref.json`. When the live release already holds the same tar, it uploads nothing. A consumer that pins the release (below) must already pin the new build, on its default branch or on its open `agent/repin-<release>` branch. Otherwise the job fails and publishes nothing, so a known consumer is never handed content it cannot load.
- **Manual rebuild.** Run `gh workflow run publish-releases.yml -f release=<release>`, or use **Run workflow** in the Actions tab. Use it to retry a release or to publish a build that merged but was never uploaded. Dispatches publish only from `main`.
- **Not yet in CI.** `MANUAL_RELEASES` names the releases CI cannot build, and why: `greyhaven-starter` and `farm-crops`. Their publishing still ends with the owner's upload commands, which `prepare-release.ts` prints.

Some consumers pin a rolling release, either by their own copy of its `export.ref.json` or by its tar sha256. A pinned consumer fails as soon as the release assets are replaced. [`consumers.json`](consumers.json) lists the consumers of each release: the repo, the pinned files, and how each file pins the release. A `tar-sha256` pin replaces the first sha256 after its `after` anchor. An `export-ref` or `file` pin is a copy of that release file. An optional `format` command runs in the consumer checkout after the rewrite. An entry with `"pinned": false` reads the live release and needs no re-pin. Update the list when a consumer adds or drops a pin.

When the publish job refuses a release because of a pinned consumer, it keeps the exact build as a workflow artifact named after the release. Download it with `gh run download <run id> -n <release> -D <dir>` and prepare the re-pins:

```sh
bun scripts/prepare-release.ts <release> <artifactsDir> [--downloads <dir>] [--dry-run]
```

`<artifactsDir>` holds the build: one `<name>.tar` with its `.sha256`, `export.ref.json`, and any other top-level release JSON such as `lineage.json` or `<name>.descriptor.json`. `--downloads` defaults to `<artifactsDir>/downloads`. The script:

1. verifies the tar against its `export.ref.json` with `pack-asset-bundle.ts --verify`;
2. finds the release's pinned consumers in `consumers.json`;
3. clones each one to `~/.cache/agent-work/<repo>-repin-<release>`, rewrites its pins on `agent/repin-<release>`, pushes, and opens (or updates) a **draft** PR titled `Re-pin <release>`;
4. prints how to publish, then one line that marks the re-pin PRs ready and lands them. For a release CI builds, that is a re-run of the refused job or `gh workflow run publish-releases.yml -f release=<release>`. The re-run rebuilds the same commit and now finds the re-pin branch pinning it. For a release in `MANUAL_RELEASES`, it prints the owner's `gh release upload … --clobber` commands for the bundle files and the downloads, and `gh workflow run pages.yml`.

It never uploads. Once the release is replaced, the coordinator runs the land line, so a consumer is red only between the publish and its re-pin landing. `--dry-run` verifies the build and prints the commands without cloning or opening PRs.

## Stability

The reusable core has completed its first stabilization milestone. Published schema versions are immutable compatibility contracts, CLI exit semantics and the deliberately small root programmatic API are protected by deterministic tests, generation cache reuse is fail-closed and content-addressed, and the package shape is validated without publishing it.

The same public CLI/spec boundary is proven by merged Zoo and Medieval consumers. `bun run stability:check` exercises the local compatibility/package/reproducibility gate, while the hosted `Stability` workflow reruns the current `asset-tooling` head against exact accepted consumer commits, external processor revisions, and the pinned workflow-editor/workflow-runner conformance pair recorded under `stability/`.

The package remains `0.1.0` until a stable release is intentionally cut; stabilization readiness does not publish or tag a release by itself. See `docs/stability.md`.

## Local tool setup

Run `python3 scripts/setup-tools.py doctor --profile all --json` to inspect repository tool readiness. The idempotent `setup` command prepares the chosen `core`, `previews`, or `comfyui` profile, with an explicit NVIDIA or CPU backend for ComfyUI. See [local tool setup](docs/local-tool-setup.md) for pinned versions, host prerequisites and model-acquisition boundaries.

## Generation

The generation architecture supports the same provenance model across:

- deterministic/seeded procedural generators;
- consumer-owned Blender scripts run in an exactly pinned Blender release (`external.blender.script`, see `docs/blender-script.md`);
- local model-backed generators such as Stable Diffusion, TRELLIS.2, Stable Fast 3D, and TripoSR;
- utility backends used to prove contracts.

`builtin.procedural.svg-scatter` is the deterministic procedural reference backend. `model.stable-diffusion.diffusers` consumes a hash-pinned local Diffusers pipeline bundle. `model.trellis2` consumes a prepared RGBA image plus separately pinned TRELLIS.2 source, 4B model, legacy sparse decoder, and DINOv3 encoder bundles and emits a PBR GLB. `model.stable-fast-3d` remains the lighter textured image-to-3D path with separately pinned source/model/DINOv2 bundles, while `model.triposr` is the lower-resource geometry fallback. `mesh.image-to-3d.generate@1` is the provider-neutral operation over all three.

Model generation is offline and fail-closed: model acquisition is separate from generation, and undeclared cache/network dependencies are not accepted as reproducibility evidence. A seed is an input, not proof of deterministic output. For local game-asset reconstruction, TRELLIS.2 is the high-fidelity PBR path when its Linux/CUDA runtime fits; Stable Fast 3D is the lighter textured path and TripoSR remains the lower-resource fallback.

For unattended local batches, choose either the Stable Fast 3D example or the TRELLIS.2 example, point it at the desired Markdown queue, run `bun run weekend:3d:doctor`, then start `bun run weekend:3d`. The same sequential runner checkpoints each expensive stage, pins only the selected reconstruction backend, and resumes verified work after interruption; see `docs/local-3d-weekend-batch.md`.

For acquisition, `scripts/acquire-huggingface-model.py` resolves a requested Hugging Face revision to an immutable commit, downloads that exact complete snapshot, records license and per-file evidence, and emits a deterministic hash-pinned ZIP plus an independently verifiable receipt. The manually dispatched `Hugging Face model acquisition evidence` workflow provides the same boundary in hosted CI without promoting model bytes automatically.

The [GitHub Pages asset gallery](https://moritzbrantner.github.io/asset-tooling/) contains real previews of the built-in recipes, including rotating generated GLBs, surface/2D PNGs, effect-frame galleries, and playable feedback-kit WAV cues. These files are **presentation-only generated samples**, not canonical catalog sources, license evidence, or output-replay receipts. Pages CI uses the pinned Blender release and hash-checked Sapling input for 3D, and the existing procedural operations plus FFmpeg PNG codec for 2D. The static gallery consumes `dist/pages/previews/index.json`; missing media or missing recipes fail the Pages build rather than silently reverting to generic icons.

For a local preview build, use the Bun version pinned in `package.json`, the pinned Blender from `bun scripts/install-blender.ts <directory>`, FFmpeg, and the pinned Sapling ZIP referenced in `src/tree-recipes.ts`. Set `ASSET_TOOLING_BLENDER` and `ASSET_TOOLING_SAPLING_ARCHIVE`, then run `bun run pages:previews && bun run pages:build`. Ordinary `bun run check` does not require these optional native tools and can build the catalog-only fallback. Tests that spawn Blender run only with `BLENDER_TESTS=1` (as well as `ASSET_TOOLING_BLENDER`); iterate with `bun test <file>`.

For zero-Python browser use, the same static 3D studio runs locally and on GitHub Pages. Run `bun run studio` from a checkout or open `/generate/` on the deployed Pages site. **Prepare model** is an explicit acquisition step: it downloads the immutable, hash-pinned Stable Fast 3D WebGPU artifacts, re-verifies cached bytes, and then enables local WebGPU generation. Source images and generated GLBs stay in the browser. TRELLIS.2 remains local CUDA-only and is intentionally not exposed by Pages. See `docs/browser-3d-studio.md`.

See `docs/generation.md`, `docs/model-acquisition.md`, `docs/stable-diffusion.md`, `docs/trellis2.md`, `docs/stable-fast-3d.md`, `docs/triposr.md`, `docs/image-to-3d.md`, and `docs/cache.md`.

## Processing

`asset-tooling/operations/processing/scene` exposes `scene.normalize@1` and `scene.export.glb@1` for renderer-neutral scene documents. The pinned `3d-lab` processors own canonical hierarchy/geometry normalization and GLB serialization; asset-tooling verifies their identity, validates transport and observations, and stores outputs with source lineage. This is the static scene/export foundation for the broader production GLB profile tracked in #104.

`asset-tooling/operations/processing/gltf` adds `scene.import.gltf@1` for static glTF 2.0 with PBR materials and resources. `asset-tooling/operations/processing/gltf-production` adds `scene.import.gltf@2` for supported skins/animations and non-mutating `scene.analyze.gltf@1` with explicit production policy. These use glTF Transform and the Khronos validator over hash-verified inputs. See [the import contract](docs/gltf-import.md) for supported features, resource bindings and pinned Avocado/Rigged Figure proofs. Approved-character, visual and consumer acceptance remain tracked in #104/#109.

The versioned 3D processing receipt contracts cover mesh simplification, source-based LOD chains, animation resampling, animation reduction, and production humanoid rig validation while keeping the authoritative algorithms and semantics in their domain repositories. Cross-field validators check request/result consistency and replay evidence without copying those algorithms into `asset-tooling`.

Rigged-character preparation now follows the same boundary: `mesh.rigged-collision.fit@1` consumes a content-addressed bind-pose position/skeleton/skin document, invokes the exact accepted `three-d-rigged-assets` processor from `3d-lab`, and stores the resulting joint-local primitive collision proxies as a content-addressed collision asset. `asset-tooling` owns invocation and provenance; fitting and physics semantics remain outside this repository.

Generated artifacts feed processing through a content-addressed handoff: the processing receipt input SHA-256 is exactly the generation receipt output SHA-256. The supplemental handoff lineage records which generation receipt supplied those bytes without modifying the published processing receipt v1/v2 schemas.

See `docs/3d-processing.md` and `docs/generation-processing-handoff.md`.

## Canonical asset catalog and durable storage

The focused catalog boundary manages reusable third-party assets without conflating source discovery with trusted bytes. Provider policy, source identity, per-asset license evidence, exact byte pinning, durable storage, and downstream processing remain explicit stages.

Catalog/provider/storage manifests and provenance stay in normal Git. Approved payload bytes live under `assets/canonical/`, which is reserved for Git LFS through `.gitattributes`; this tree is intentionally outside the published npm package. `catalog/storage.json` is the closed-world mapping from a pinned catalog source to its one canonical LFS path.

A Git LFS pointer is not accepted as content evidence. `Validate / canonical-storage` checks out with LFS hydration, runs `git lfs fsck`, verifies that the payload tree exactly matches `catalog/storage.json`, and compares every hydrated payload's SHA-256 and byte length with the corresponding source pin. The ordinary cross-platform `bun run check` validates storage-manifest structure without downloading the full media corpus.

The `asset-tooling/catalog/storage` subpath is the consumer boundary for durable payloads. `readAssetCatalogStorageSource(...)` resolves only manifest-declared sources, rejects missing, drifted, symbolic-link, or pointer-only payloads, and verifies hydrated bytes against the catalog pin. `importAssetCatalogStorageSource(...)` then feeds those exact bytes through the existing canonical import into the consumer's disposable `.asset-tooling/objects` store, preserving the same provenance-bearing `AssetRef` and remaining idempotent on repeated imports. Network acquisition is never part of this consumer path.

The manually dispatched `Catalog Git LFS promotion` workflow acquires a registered shared source, measures or re-verifies its bytes, updates the source pin and storage manifest, places the payload under its deterministic `assets/canonical/<source-id>/...` path, stages it through Git LFS, and pushes a review branch. It never pushes canonical bytes directly to `main`; the resulting branch must still pass normal PR-triggered exact-head validation before integration.

CC0 is preferred; non-CC0 shared sources must retain explicit attribution, and providers such as Mixamo that should not be raw-redistributed remain project-local.

See `docs/catalog.md`.

## Unified asset operations

Milestone A introduces a runtime-neutral operation contract so generation, processing, analysis, composition, and export capabilities can share one small typed workflow vocabulary without replacing their authoritative algorithms or existing receipt contracts.

The focused `asset-tooling/operations` package subpath provides runtime `AssetRef` values, versioned operation descriptors, a deterministic operation registry, typed input/result validation, and canonical build/cache identities. `asset-tooling/operations/store` provides verified content-addressed intermediate objects. The root package API remains deliberately small.

The generator proof lives under `asset-tooling/operations/generation`: `procedural.svg.scatter@1` reuses the existing `builtin.procedural.svg-scatter@1` backend, maps its seed into operation build identity, writes through the object store, and is tested for byte/hash/observation parity with `generateAsset(...)`.

The processor proof lives under `asset-tooling/operations/processing`: `mesh.simplify@1` consumes a verified mesh `AssetRef`, invokes the exact accepted `three-d-lod` implementation from `moritzbrantner/3d-lab` through the shared process-adapter protocol, validates receipt-compatible observations, and stores the derived mesh as another content-addressed `AssetRef`. The processor algorithm and mesh semantics remain owned by `3d-lab`; `stability/processors.json` pins the accepted external revision.

The workflow bridge lives under `asset-tooling/operations/workflow`. It derives workflow-editor node templates from the same operation descriptors and provides one generic `asset.operation` workflow-runner executor. Asset-tooling owns this projection; workflow-editor and workflow-runner remain asset-agnostic. Operation observations are delivered through an external evidence callback instead of becoming workflow graph outputs.

See `docs/operations.md` and `ROADMAP.md`.

## CLI

```text
asset-tooling validate <asset-spec.json>
asset-tooling generate <asset-spec.json> [--receipt <relative-path>]
asset-tooling verify <asset-spec.json> [--receipt <relative-path>]
asset-tooling processing-input <asset-spec.json> --media-type <media-type> [--receipt <relative-path>]
asset-tooling fingerprint
```

Repository maintenance helpers include:

```text
bun run catalog:pin -- <catalog-source-id> <local-file>
bun run catalog:acquire -- <catalog-source-id> [destination-root]
bun run catalog:storage:check
bun run catalog:storage:verify
bun run catalog:lfs:promote -- <catalog-source-id>
python scripts/acquire-huggingface-model.py acquire --repo-id <owner/model> --revision <ref> --expected-license <license> --destination <dir>
python scripts/acquire-huggingface-model.py verify --bundle <model.zip> --receipt <receipt.json>
```

Exact reproducibility is established by replayed output bytes. Backend kind, absence or presence of a seed, deterministic runtime switches, cache presence, Git LFS pointer identity, or a familiar model family are never accepted as proof on their own.

## Programmatic API

Consumers importing the package root receive only the high-level operations `validateSpec`, `generateAsset`, `verifyAsset`, and `prepareProcessingHandoff`. Versioned schemas are separately available through the `./schemas/*` package export. Backend, cache, hashing, environment, acquisition/promotion maintenance, and receipt-construction internals are deliberately not part of the public package API.

The additive `asset-tooling/operations`, `asset-tooling/operations/store`, `asset-tooling/operations/generation`, `asset-tooling/operations/processing`, `asset-tooling/operations/workflow`, `asset-tooling/catalog`, and `asset-tooling/catalog/storage` subpaths contain focused operation/catalog surfaces; they do not widen the root export.

Tileable soil/tilled-soil/rock/wood surface recipes and independent color, height, normal and roughness channels are documented in [surface textures](docs/surface-textures.md). Generate the twelve controlled presets with `bun examples/surface-textures/build.ts`; `bun examples/surface-preservation/build.ts` demonstrates palette/normal edits that reuse accepted components and independently match cold full rebuilds.

A pinned Blender [rock recipe](docs/rock-recipes.md) produces grounded rounded, angular, flat and boulder GLBs with ordinary generation-cache and exact-verification evidence. Run `bun examples/rocks/build.ts` to exercise the family.

See [deterministic sprite atlases](docs/sprite-atlases.md) for selected-image packing, trim/pivot metadata and the actual PNG puzzle-art fixture.

[Static GLB material finishing](docs/gltf-materials.md) applies generated PNG colors to existing named slots. Run `bun examples/rock-materials/build.ts` after the rock master example to inspect gray/warm families without regenerating geometry.

[Static GLB render derivatives](docs/render-derivatives.md) declare transparent icons and thumbnails through the pinned Blender backend, preserving source identity and camera/framing evidence.

[Saved terrain masks](docs/terrain-masks.md) flatten a verified height field with explicit same-grid guide weights. Run `bun examples/terrain-mask/build.ts` for height bytes, unchanged-topology meshes and before/after renders.

[Offline tree recipes](docs/tree-recipes.md) invoke a separately acquired hash-pinned Sapling source through Blender, with broadleaf/conifer families and independent trunk, branch and foliage GLBs.

Static puff/ring ingredients with explicit alpha, geometry and intensity controls are available through [`./recipes/effect-artwork`](docs/effect-artwork.md).

See [leaf alpha artwork](docs/leaf-artwork.md) for independently generated masks, preserved recoloring, standalone PNG packaging and optional native tree-material inspection.

Selected static GLB/PNG and sprite-atlas/PNG handoff with original frame metadata, content-addressed resource closure, source lineage and recoverable export is available through [`./operations/bundle`](docs/asset-bundles.md). `bun examples/atlas-bundle/build.ts` proves package-only loading after deleting an independent source store.

See [complete static GLB PBR finishing](docs/gltf-pbr-materials.md) for applying existing normal/ORM material sets.

For controlled regular soil ridges and troughs, see the [tilled furrow recipe](docs/surface-textures.md#regular-tilled-furrows) and [actual tiled-material example](examples/tilled-soil/build.ts).

For controlled grain direction and length, see the [wood surface presets](docs/surface-textures.md#directional-wood-grain) and [PBR/recolor example](examples/wood-surfaces/build.ts), with independent pixel inspection and optional native renders.

[Saved instance exclusion masks](docs/instance-exclusion.md) remove cosmetic detail from an accepted candidate set while preserving retained IDs, order and XYZ positions. The native rock-field example compares a path mask with a localized edit under identical camera framing.

[Authored effect frame sequences](docs/authored-effect-sequences.md) compose explicit puff/ring poses and millisecond schedules into the existing atlas format, with preserved frame IDs/pivots, transparent one-shot endings and cancellation between stages.

[Feedback kits](docs/feedback-kits.md) pair an authored effect sequence with a synthesized, clip-free WAV cue per strong/subtle intensity, a reduced-motion still and declared onsets/concurrency in one content-addressed manifest.

The [selected-bundle adoption example](examples/selected-bundle/README.md) consumes the installed public package, verifies real recipe pixels and distribution provenance, and documents a clean consumer setup using the existing native generator.

[Native-ground tree appearances](docs/tree-appearances.md) derive explicit summer/autumn/winter foliage states from one accepted master, preserving bark, geometry and placement while supporting isolated material edits.

[Surface appearance families](docs/surface-appearances.md) derive dry/damp/wet-style states from one tileable surface. Height and normal stay shared and verified, and only each state's color and roughness are rebuilt.

[Authored Wheat appearances](examples/wheat/README.md) provide bounded early/mature/harvested-looking static meshes, isolated leaf palettes and derived icons through the existing Blender, material and bundle contracts. [Corn appearances](examples/corn/README.md) reuse the same native authoring and selected-package path in the same bright-toy style (asset-tooling#355): a golden Wheat sheaf and a tall green Corn stalk with a big yellow cob and an orange tassel.

[Grass/soil corner tiles](docs/transition-tiles.md) provide a complete sixteen-piece 2D transition family, ordered edge ports, selected atlas bundles and independently checked pixel seams.

[Modular fence pieces](docs/fence-kit.md) supply native end/straight/corner/tee GLBs, declared edge ports with quarter-turn rotation, and a reference layout evaluator for connection checks.

[Weapon recipes](docs/weapon-recipes.md) author an original arming sword and heater shield in the [humanlike style](docs/style-humanlike.md), each with a `grip` node at its origin. The [humanoid-sockets-v1](docs/humanoid-sockets.md) descriptor attaches them to the Ranger's hands, back and hip.

For Maps' bounded, licensed real-world MVT/PMTiles candidates, see
[the Shortbread recipe](docs/maps-shortbread.md). Generation uses pinned local
inputs and the existing asset receipts; ordinary tests use a tiny owned fixture.
