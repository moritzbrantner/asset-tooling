# Native grass clumps

Run `bun examples/grass-clumps/build.ts` with the declared Blender available, then `python3 examples/grass-clumps/review.py` (Pillow). Paths resolve from the scripts. Generation uses packaged, hash-pinned `grass.py` and the existing Wheat native leaf authoring/export helpers through verified input snapshots; there is no acquisition or ambient extension installation.

The public `asset-tooling/recipes/grass` recipe supplies short, bent and tuft presets. Complete controls declare seed, blade count, height envelope, blade width, root spread, bend, curve resolution and triangle budget. Counts are bounded to 32, resolution to six and triangles to 8,000. Seeded per-blade variation stays isolated from game randomness; adding blades preserves existing blade geometry and placement. Height is an upper envelope, rather than an exact maximum: seeded height variation and bend lower individual tips.

Three actual GLBs retain native UVs/normals, meter/Y-up units, identity transforms and root-plane ground anchoring. Static import validates each, and cache-independent verification rebuilds every output. The native closed blade cross-section uses opaque material geometry; foliage alpha artwork remains available through the existing material/2D pipeline. No images, wind attributes or runtime vegetation behavior are embedded here.

Three transparent native renders use one explicit 1.25m world span and ground pivot. The inspector verifies current source/script/spec/receipt/output pins and marks the common anchor. This producer comparison does not establish an actual game camera, species accuracy or consumer spacing/collision approval.

The existing static bundle profile distributes all three meshes and previews, retains complete AssetRefs/source lineage, compares cold exports and loads all six assets after deleting the cold object store. Repeated generation reconciles identical outputs and receipts. Outputs/screenshots under `.artifacts/grass-clumps` remain disposable; #133 retains real consumer acceptance and LOD work. Consumer repositories remain read-only.
