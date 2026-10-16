# ComfyUI-first asset production

**Owner-approved direction:** [Decision 5.1.1](decisions/atlas.md), 2026-10-16. This document defines integration boundaries, not implementation status. GitHub issues and verified consumer runs track implementation.

## Responsibilities

- **ComfyUI is the golden reference for supported generative-media workflows.** Its native workflow graph, model loading, custom nodes, inference, execution queue, internal partial re-execution and cache remain ComfyUI-owned. Do not reproduce these in `asset-tooling` merely to provide an integration.
- **asset-tooling is the reusable front door for the owner's projects.** It owns versioned asset-operation descriptors, provider selection, prepared inputs, `AssetRef` identity, dependency/provenance evidence, technical verification, separately recorded human approval, image/mesh/audio processing through existing owners, and consumer-ready bundles.
- **workflow-editor** owns *general* typed workflow authoring. One complete ComfyUI workflow is an opaque external operation projected through the existing asset-operation bridge, not a collection of locally duplicated ComfyUI Nodes. **workflow-runner** owns generic single-run executor dispatch and lifecycle; **workflow-engine** owns top-level registration, triggers and run records. Neither replaces ComfyUI's internal graph executor or inference queue.
- Existing deterministic procedural generators, Blender/3d-lab operations and other authoritative algorithms remain independent of ComfyUI. Projects consume verified exported assets without ComfyUI or model weights at runtime.

## First external-provider integration

1. Select one real **prepared local ComfyUI API-format workflow**. Keep its native JSON as the authoritative media graph; identify its exact bytes and required model/checkpoint/custom-node revisions. Where dependency hashes or licenses cannot be verified, report the gap instead of asserting a reproducible run.
2. Bind its declared inputs and outputs through an existing versioned asset operation. Any applicable **ComfyUI vs. first-party implementation** choice is explicit in the versioned invocation/recipe and reflected in execution identity and evidence. Preserve existing published operations and consumers; migrate them deliberately rather than silently changing an existing operation's behavior.
3. Use a supported ComfyUI transport (local server API or a verified compatible official SDK). [Comfy MCP](https://github.com/Comfy-Org/comfy-mcp) is an optional agent/authoring interface, not a mandatory consumer/runtime protocol. ComfyUI owns prompt submission, its queue and internal progress; an asset-operation adapter observes the **one external job** rather than scheduling its internal nodes.
4. Record workflow/model/provider/runtime identity, verified inputs, external job/prompt ID, received outputs, hashes and truthful reproducibility/rights evidence. Treat uncertain dispatch, timeouts, cancellation and retries conservatively: no duplicate paid/expensive inference on an ambiguous response, and no global interrupt of another job. Never leak credentials or assume a seed guarantees byte-identical replay.
5. Verify returned bytes before creating `AssetRef`s, using the existing object store, processing, preview and bundle/export contracts. Candidate, technically validated and human-approved states remain distinct and tied to exact bytes. Fail visibly when ComfyUI, the model, a workflow dependency or an approved source is unavailable. No implicit cloud/paid fallback or hidden model downloads.

Official local-server endpoints include `POST /prompt`, `GET /history/{prompt_id}`, `GET /view` and `/ws`; use their documented semantics rather than assuming a particular SDK version works with an unproxied local server. See [ComfyUI server routes](https://docs.comfy.org/development/comfyui-server/comms_routes). Do not create a competing transport/framework merely for this first slice.

## Selective internal convergence

Keep ComfyUI as the external, testable reference while selectively **reimplementing and improving individual high-use capabilities** when an actual project needs different quality, cost, reproducibility, performance, reliability, offline behavior or control. Avoid a speculative all-at-once clone.

For each candidate capability, use an existing operation ID or an explicitly versioned evolution of it and a **single owning GitHub issue** to capture:

- An actual consumer, an accepted ComfyUI workflow/output reference, and the measurable shortcoming to improve.
- An optional first-party provider behind the same stable asset-facing inputs, outputs and provenance guarantees, with an explicit provider selection and a reversible rollout. Do not automatically change previously accepted builds.
- Side-by-side **functional, visual and consumer-quality acceptance**, failure/cancellation/idempotency behavior, performance/resource measurements where relevant, and honest treatment of stochastic outputs (not obligatory pixel equality).
- Licensing/source provenance, independently inspectable exports and regression/conformance tests against the pinned external reference. Prefer existing processors rather than creating a second implementation.
- Only switch the preferred provider for a specific proven operation after that evidence passes. Retain an external path or deliberate migration/rollback route until retirement is justified.

There is **one operation registry** in asset-tooling and **one implementation status source** in GitHub issues. This document defines policy, not a second capability backlog, scheduler, state store or adapter catalog.

## First vertical slices

- [#212](https://github.com/moritzbrantner/asset-tooling/issues/212): one real pinned ComfyUI operation through existing asset contracts, initially with the external provider.
- [#211](https://github.com/moritzbrantner/asset-tooling/issues/211): produce, inspect, approve and export four actual MMORPG Warden ability icons using that reusable integration where appropriate.
- [#127](https://github.com/moritzbrantner/asset-tooling/issues/127): reuse the existing asset workbench for comparison/approval instead of creating a second ComfyUI editor or gallery.
