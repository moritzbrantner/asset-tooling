# Blender script backend

`external.blender.script@1` runs a consumer-owned, hash-pinned Python script inside an exactly pinned Blender release and records the result with the ordinary receipt/verify contract. asset-tooling owns the runner, version pinning, and provenance; the consumer owns the script and therefore the art and game semantics it encodes.

## Spec

```json
{
  "schemaVersion": 1,
  "assetId": "zoo.animal.zebra",
  "generator": { "id": "external.blender.script", "version": "1" },
  "randomness": { "mode": "none" },
  "inputs": {
    "script": { "path": "build_assets.py", "sha256": "<sha256 of the script>" }
  },
  "models": {},
  "parameters": {
    "blenderVersion": "5.2.2",
    "arguments": { "asset": "zebra" }
  },
  "output": { "path": "production/zebra.glb" },
  "reproducibility": { "expected": "exact" }
}
```

- `inputs.script` is required and must be a `.py` file. Every other declared input is passed to the script by name as its portable `/`-separated path relative to the spec directory, which is the runner's working directory.
- `parameters.blenderVersion` must be an exact `MAJOR.MINOR.PATCH` release. There is no floating "latest": the probe fails closed when the executable's version differs, so a receipt always names the Blender that produced it.
- `parameters.arguments` is an arbitrary JSON object handed to the script. Seed any randomness through it; `randomness.mode` must be `none`.
- `models` must be empty; Blender itself is pinned by version, and the receipt's environment records its build hash, executable SHA-256, and Python runner SHA-256.

## Script contract

The script must define:

```python
def generate(output_path: str, arguments: dict, inputs: dict[str, str]) -> dict:
    ...
```

It runs in a `--factory-startup` background session, writes exactly one file at `output_path`, and returns JSON-serializable observations. It must not read undeclared files or the network. Receipt observations wrap the script's observations as `{"runner": "blender-script-runner-v1", "blenderVersion": ..., "script": {...}}`.

The runner reads the declared script once, verifies that byte snapshot against the source pin, and compiles/executes the same bytes. It ignores source-adjacent Python bytecode caches and does not create them when loading the declared script. Normal module metadata and the source's own compiler/future semantics are preserved. The runner's existing SHA-256 environment component records this implementation change; receipts from an older runner report environment drift rather than silently claiming the same execution.

## Determinism

The backend declares exact capability, and `verify` replays the script and compares output bytes. With one Blender binary, Blender's glTF exporter produces byte-identical output across processes for scripts that avoid nondeterministic data. One known exception: bevel-derived UV coordinates can differ in their final float bits between runs, so untextured assets should export with `export_texcoords=False`.

## Installing Blender

Generation never downloads Blender. `adapters/blender/release.json` pins the current release (version, official archive URL, and SHA-256), and

```sh
bun scripts/install-blender.ts <install-directory>
```

downloads that archive, verifies its SHA-256, extracts it, and prints the executable path. Point `ASSET_TOOLING_BLENDER` at it (otherwise `blender` on `PATH` is used). The `Validate / blender-script` job does exactly this before running the round-trip tests.

Repeated installation verifies the cached archive again and compares the complete installed tree with a fresh extraction, including file hashes, executable permissions, and symbolic links. An identical installation is reused without rewriting it; drift is reconciled from the verified archive. Corrupt archive cache entries fail closed. Archive cache bytes live in OS temporary storage.

## Updating Blender

To move to a newer Blender release, update `adapters/blender/release.json` (version, URL, and the official SHA-256 from `download.blender.org`), run the round-trip tests with the new executable, and update consumers' `parameters.blenderVersion`. Consumers then regenerate: their receipts change because the environment changed, and `verify` must report `exact` against the new receipts.
