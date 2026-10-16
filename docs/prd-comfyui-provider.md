# PRD: ComfyUI-backed image generation

**Issue:** [#212](https://github.com/moritzbrantner/asset-tooling/issues/212)  
**Status:** Owner-approved product direction; integration acceptance pending.  
**Authority:** [Decision Atlas 5.1.1](decisions/atlas.md) and [ComfyUI-first architecture](comfyui-first.md). This PRD specifies acceptance; it is not a second decision registry or implementation status tracker.

## User outcome

A project developer supplies an already prepared, license-checked ComfyUI API-format image workflow and declared local inputs/models. Through one versioned asset-tooling operation, they can run it on their chosen local ComfyUI instance, import the exact resulting image bytes, inspect candidate outputs, explicitly approve a chosen master and export a verified, game-ready bundle. The consuming game must not require ComfyUI, an inference model or an agent.

Use ComfyUI for the native media graph, custom nodes, model inference, queue and internal cache. Asset-tooling owns only the **project-facing operation and asset contract**: inputs, pinned implementation identities, provenance, verified imports, review states and exports.

## First end-to-end acceptance

1. **Prepare:** Provide one runnable ComfyUI **API-format prompt graph** (not the UI's canvas/links export), a prepared local checkpoint with recorded source/license/revision and input files. No implicit model installation or network downloads during generation. Setup tooling is handled separately by [#214](https://github.com/moritzbrantner/asset-tooling/pull/214).
2. **Declare and verify:** Store the exact workflow JSON bytes as a `workflow` / `application/json` `AssetRef`. Validate the byte hash before parsing; retain native graph content and identity. Verify declared model/input dependencies and the external provider's identity before dispatch. A provider choice and its effective versions are explicit; existing internal operations are not silently redirected.
3. **Execute:** Invoke the **whole native graph as one external job** using the ComfyUI local server's supported API, without translating native nodes into our own runner. Handle unavailable server, invalid graphs, queue rejection, execution failures, progress, cancellation, timeouts and ambiguous submissions without blind duplicate retries or global interruption of unrelated jobs.
4. **Import:** Fetch the actual image output bytes, verify file type and dimensions, create a content-addressed image `AssetRef` and record the workflow/inputs/model/provider/job/output identities. A seed is only a generation input, not proof of byte-identical replay. Failed or incomplete runs must not promote outputs or approvals.
5. **Review and export:** Preview actual candidates using the existing asset workbench, approve selected exact bytes, and export using the existing bundle contract. Replacing or rebuilding a candidate cannot inherit approval. An independent consumer verifies the bundle and decodes its PNG without ComfyUI.
6. **Conformance:** The operation is usable through the existing `AssetOperationDescriptor` registry and `workflow-editor`/`workflow-runner` bridge. No new graph interpreter, model loader, queue, gallery, blob store, approval database or runner is introduced.

## First small offline PR slice

The first low-risk implementation adds `loadPreparedComfyUiApiWorkflow` and focused regressions. It has **no server access, subprocess execution, model acquisition or mutable side effects**:

- Verify a stored workflow `AssetRef` through the existing content-addressed object store **before** reading its bytes.
- Decode strict UTF-8 JSON, distinguish a basic ComfyUI API node map from a UI graph, and require each node's `class_type` and `inputs` envelope.
- Reject missing, corrupted, malformed, non-JSON and non-finite-number inputs. Do **not** validate node classes, connection semantics, model names or graph feasibility locally; ComfyUI remains authoritative.
- Return the original JSON text without rewriting or canonicalizing native node contents, together with its exact-byte `AssetRef`.
- Keep this helper internal until the real provider operation and its invocation contract are accepted. It is **not** proof of working model inference.

## Further work remaining in #212

| Area | Evidence required |
| --- | --- |
| Provider boundary | A single versioned, typed asset operation with explicit ComfyUI provider selection and no breaking changes to existing operations |
| Dependency safety | Hash-pinned native workflow, checkpoint/custom-node/tool identities, input hashes and verified rights evidence |
| Transport | Real `POST /prompt`, job-scoped completion/history/output retrieval; scoped safe cancellation and ambiguous-submission behavior |
| Output ingestion | Actual PNG bytes, decoder/dimension validation, verified `AssetRef`, truthful run receipt and idempotent export |
| User-facing proof | Real local ComfyUI graph → approved image preview → exported bundle → independent consumer validation |
| Regression proof | Negative offline protocol tests, repeated safe run/export, existing `bun run check` and relevant hosted acceptance |

Local API reference: [ComfyUI server routes](https://docs.comfy.org/development/comfyui-server/comms_routes). MCP may help an agent author a graph but is **not** the runtime transport. External paid/cloud nodes are not an implicit fallback.

## Boundaries and dependencies

- [#211](https://github.com/moritzbrantner/asset-tooling/issues/211) remains the owner of actual four-icon MMORPG Warden visual approval; do not duplicate that product acceptance here.
- [#127](https://github.com/moritzbrantner/asset-tooling/issues/127) remains responsible for inspection and approval UI.
- [workflow-runner #8](https://github.com/moritzbrantner/workflow-runner/issues/8) owns generic external-executor retry, cancellation and timeout semantics; one ComfyUI graph is one external executor invocation.
- Existing Diffusers, procedural generators, 3D processors and published asset contracts remain valid. A future first-party implementation may compete with a pinned ComfyUI reference **one operation at a time** with explicit provider choice, consumer parity evidence and rollback.
- The real local model/checkpoint, approved native workflow and ComfyUI instance remain **integration prerequisites**, not data to synthesize in fixtures. If unavailable, report the missing acceptance evidence rather than marking #212 complete.
