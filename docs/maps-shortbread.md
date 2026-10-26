# Bounded Shortbread PMTiles candidates for Maps

This recipe produces two **unapproved candidates**, not canonical catalog assets:
a Liechtenstein extract and its northern half. They differ in geographic contents,
coverage and immutable archive digest. The north candidate deliberately omits the
southern area; switching sources must visibly change that area. No historical
claims, effective dates, rendered-tile scraping or global downloads are involved.

On Linux x64 with Java **21.0.10**, GNU `time`, GNU `timeout`, `tar` and Bun installed:

```sh
bun install --frozen-lockfile
# Explicit acquisition. Downloads ~114 MB; checks every declared SHA-256 and length.
bun examples/maps-shortbread/build.ts acquire
# Offline generation, upstream inspection, exhaustive tile verification and replay.
bun examples/maps-shortbread/build.ts build
# Offline, cache-independent replay and non-mutating archive verification.
bun examples/maps-shortbread/build.ts verify
```

The commands resolve paths relative to their source, regardless of caller CWD.
Acquisition is separate from generation and saves the source license, snapshot,
URLs, hashes and byte lengths in `.asset-tooling/maps-shortbread/acquisition.json`.
A changed/missing pin fails generation; it never invokes Planetiler downloads.
The acquired `.osm.pbf` is a legitimate Geofabrik regional extract, not OSM served
tiles. Source timestamp is `2026-10-25T21:21:21Z` from its PBF replication header.
ODbL data requires **© OpenStreetMap contributors** attribution and the
[OpenStreetMap copyright/license information](https://www.openstreetmap.org/copyright).
See also [Geofabrik downloads](https://download.geofabrik.de/europe/liechtenstein.html).
These are contemporary source observations, not historical validity assertions.

Pinned external implementations:

- Planetiler **0.10.2**, release JAR SHA-256
  `f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d`,
  93,278,824 bytes, upstream revision `0e5588c4a6e8c29a270a33afe8df62027d889604`,
  Apache-2.0. Uses its [configurable YAML facility](https://github.com/onthegomap/planetiler/tree/v0.10.2/planetiler-custommap).
- Geofabrik `liechtenstein-261025.osm.pbf`, SHA-256
  `bd5cca3fdcb4e9900ad74b4c33e554750088705bd4b4deaa35c1517d7be2378b`,
  3,480,519 bytes, ODbL-1.0.
- [go-pmtiles 1.31.2](https://github.com/protomaps/go-pmtiles/releases/tag/v1.31.2)
  Linux x64 release archive SHA-256
  `3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f`,
  17,444,324 bytes, BSD-3-Clause. `pmtiles verify` is mandatory for the real recipe.
- The locked `pmtiles` 4.3.0 and `@mapbox/vector-tile` 2.0.4 upstream readers
  independently inspect the archive and every addressed MVT. No archive encoder,
  OSM parser, geometry engine or hosting service is implemented here.

## Profile and contract boundary

`examples/maps-shortbread/profile.yml` intentionally emits only the Maps-supported
Shortbread 1.0 geometry subset: `land`, `water_polygons`, `water_lines`, `streets`,
`buildings`, `boundaries`. Polygon/line geometry and `kind` properties follow that
subset; boundaries retain numeric `admin_level`. This is not Planetiler's default
OpenMapTiles output or a full Shortbread label/style implementation. Inland
coverage does not need an ocean dataset; do not reuse this profile for coastline
claims. Source bounds can contain empty areas; missing blank tiles are valid,
missing **addressed** tiles are invalid. Features crossing the clipped region
boundary are included using Planetiler's normal clipping/buffering.

Each candidate emits an ordinary version-1 AssetSpec, version-2 generation
receipt, `.pmtiles` archive, and `.manifest.json`. Generation uses the existing
`generateAsset`/`verifyAsset` receipt, dependency verification and cache policy.
The backend snapshots and verifies all declared inputs before launching Java.
Its observations are deterministic; measured timing/RSS/disk are emitted as
separate stderr JSON, so they cannot cause false receipt drift.

The manifest contains the Maps v1 **data metadata** plus asset-owned `archiveRef`.
`dataRevision` is exactly `sha256:<archive digest>`; `sourceId` is logical and
independent of URLs and snapshot dates. `tileSize: 512` means nominal CSS pixels;
`archiveRef.mvtExtent: 4096` describes MVT geometry units. Attribution, license and
source/generator provenance are required.

This metadata-only record is **not an activatable `MapsTileset`**. There is no
fake XYZ URL. Maps #268 owns the common metadata contract; #269 must bind an
archive reference to its PMTiles transport explicitly. Browser request scheduling,
styles, Map View state, geographic semantic authority, HTTP Range and CORS belong
to Maps #269/#270. A local verified archive does not establish runtime adoption.

Verification checks format/schema/CRS, digest/size/revision agreement, header
bounds/zoom/center, attribution, ordered unique directory entries, addressed tile
count, every tile's coverage, MVT version/extent, actual layer geometry/properties,
and representatives of water holes, waterways and buildings. A source-revision
collision fails closed. The generator initially exposed an upstream center-zoom
inconsistency for `minZoom:12`; the recipe uses `minZoom:10` and the inspector
rejects the invalid form rather than editing archive headers after generation.

## Resources and evidence

Both candidates are bounded to zooms **10–14**, with no more than 4096 addressed
tiles. A covers `[9.47,47.04,9.64,47.28]`; B covers
`[9.47,47.16,9.64,47.28]`. Generation uses two threads, 1 GiB JVM heap and a
180-second process limit with a five-second forced-termination grace period.
A source PBF above 16 MiB, profile above 64 KiB or JAR above 128 MiB is refused.
Allow at least **2 GiB RAM and 1 GiB free temporary disk** for this operation;
heap size is not total process RSS. It is an opt-in regional workload, never an
ordinary CI download or planet job.

The build logs wall milliseconds, GNU-time process peak RSS KiB, archive bytes,
and logical temporary file bytes sampled every 100 ms. Disk samples include
input snapshots and are a **lower bound** on instantaneous peak; filesystem
allocated blocks may differ. See the reviewable observation in
`examples/maps-shortbread/evidence.json`. Both candidates were rebuilt separately
and matching bytes were observed in this environment. The backend remains
`exactCapable:false` and specs request `approximate`; these runs prove this pair's
repeat bytes, not a universal reproducibility guarantee across Java/OS versions.
`verifyAsset` reports `exact` only when its actual replay checks all match.

## Hermetic fixture and distribution

`test/fixtures/maps-shortbread/input.geojson` is owned, illustrative CC0-1.0
geometry with all six layers and a polygon interior ring. It asserts no actual
geographic facts. Its ~17 KiB archive is intentionally committed as a shared
format/compatibility smoke artifact. Ordinary tests read it locally; they need
neither Java, downloaded PBFs nor network access. Regenerate deliberately with the
pinned JAR and fixture `profile.yml`, `--input_path=<absolute input.geojson>`,
`--minzoom=10 --maxzoom=11 --bounds=9.47,47.04,9.64,47.28 --threads=1`.
The fixture provenance manifest records the exact input/profile/archive hashes.

Real archives and raw downloaded inputs stay under ignored `.asset-tooling/`.
They are not canonical payloads, are not inserted into `catalog/storage.json`, and
are not checked into normal Git. Consumer smoke testing can use the generated
local archive/manifest/receipt now. After review, use the existing **single rolling
release per experimental bundle** policy (Decision 7.1.5), with digest-pinned
candidate manifests; publication and consumer adoption are deliberate separate
steps. No release or accepted/canonical status is granted by this recipe.

Do not advertise a release asset URL as browser-compatible until Maps has
verified actual **Range 206**, correct Content-Range and suitable CORS on that
host. GitHub release download availability alone does not prove that contract.

`asset-tooling/maps/shortbread` exports the candidate validator and archive verifier
for consumer compatibility tests. With a clean, pre-acquired Maps source checkout
that exports its metadata validator, check the explicit consumer boundary using:

```sh
bun examples/maps-shortbread/verify-maps-contract.ts /path/to/maps .asset-tooling/maps-shortbread/liechtenstein.manifest.json
```

The command records Maps' exact source revision and validates only common data
metadata through Maps' public server-safe validator. It adds no Maps dependency to
generic generation. `build` also exports six raw decoder-ready MVT samples and a
hash/coordinate/count-bearing `smoke/handoff.json` beside the archives; `export-smoke`
reconciles just this handoff. Maps can decode these through its own Rust/WASM
boundary independently of archive transport.

`examples/maps-shortbread/maps-decoder-evidence.json` records Maps' independent
Rust/WASM verification of all six SHA-verified raw samples: geographic and tile
pixel decoding agree on feature counts, actual water holes survive, building and
waterway geometry decode, and all geographic coordinates are finite. It identifies the exact
Maps source, WASM and handoff digests. This is decoder compatibility, not PMTiles
activation, browser performance or HTTP serving proof.

Reproduce that explicit compatibility observation after building the clean Maps
checkout's WASM artifacts:

```sh
bun examples/maps-shortbread/verify-maps-decoder.ts /path/to/maps .asset-tooling/maps-shortbread/smoke/handoff.json .asset-tooling/maps-shortbread/maps-decoder-evidence.json
```

This small adapter calls Maps' own public Rust/WASM exports. It does not reproduce
the decoder. MVT feature counts and decoded multipart primitive counts are kept
separate; geographic/pixel primitive totals and water-hole counts must agree.
