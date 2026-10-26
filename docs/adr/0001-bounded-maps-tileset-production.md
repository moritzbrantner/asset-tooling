# ADR 0001: Reuse Planetiler for bounded Maps tileset preparation

Status: accepted implementation boundary for asset-tooling #406.

Maps needs licensed, inspectable real MVT data without owning an asset pipeline.
Use a pinned Planetiler executable and local-source configurable YAML through the
existing AssetSpec generation/receipt backend. Keep network acquisition explicit,
real outputs disposable candidates, and a tiny owned archive fixture hermetic.
Use upstream PMTiles/MVT readers and the upstream inspector as format oracles.

The Maps-specific metadata adapter can consume Maps' server-safe public metadata
validator from a declared source checkout. This is recipe compatibility evidence,
not a generic asset runtime dependency. The archive reference remains asset-owned;
Maps owns transport binding, runtime semantics, HTTP Range and hosting integration.
No new geospatial engine, archive encoder or workflow service is introduced.

The generator makes no unconditional exact-byte promise. Verify by actual replay;
record bounded performance observations independently of deterministic receipts.
