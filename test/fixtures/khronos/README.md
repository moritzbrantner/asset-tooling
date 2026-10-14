# Khronos glTF sample fixtures

Local copies of two pinned catalog sources, served in place of
`raw.githubusercontent.com` by the browser acceptance tests in
`test/browser/` so that no test reaches the network. The viewer still checks
these bytes against the catalog pin (`catalog/sources.json`).

| File | Catalog id | SHA-256 | Bytes | License |
| --- | --- | --- | --- | --- |
| `RiggedFigure.glb` | `khronos.riggedfigure-glb` | `d6be85417d3e256861ee733eea6916093a7af7c79c16366181fd8abcaeb38cf5` | 50116 | CC-BY-4.0 |
| `SimpleSkin.gltf` | `khronos.simpleskin-embedded-gltf` | `7d0c3f48d0510d101269cb4fdd3ee035eaada0e04809a0899e0b4cfe8c38e68f` | 3566 | CC0-1.0 |

Both come unmodified from
[KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
at revision `90d7ede14c7e280af263824604b427a1ca02cb66`:

- `Models/RiggedFigure/glTF-Binary/RiggedFigure.glb`: Rigged Figure © 2017
  Cesium, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Source: Khronos glTF Sample Assets
  ([license evidence](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/90d7ede14c7e280af263824604b427a1ca02cb66/Models/RiggedFigure/README.md)).
- `Models/SimpleSkin/glTF-Embedded/SimpleSkin.gltf`: dedicated to the public
  domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
  ([license evidence](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/90d7ede14c7e280af263824604b427a1ca02cb66/Models/SimpleSkin/LICENSE.md)).

The test-only variants (two clips, no clips, malformed GLB) are derived from
`SimpleSkin.gltf` in memory by `test/browser/viewer-harness.ts` and are not
stored here.
