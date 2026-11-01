# Greyhaven terrain materials

The `greyhaven-terrain` rolling release (`greyhaven.terrain.tar`) supplies the ground materials for [mmorpg#525](https://github.com/moenarch-games/mmorpg/issues/525): seven CC0 [Poly Haven](https://polyhaven.com) PBR scans, one per terrain layer. [`scripts/build-greyhaven-terrain.ts`](../scripts/build-greyhaven-terrain.ts) builds it from the hydrated catalog (the 2K JPG maps `diff`, `nor_gl`, `arm` and `disp`, catalogued as `poly-haven.<id>-<map>-2k-jpg` and tagged `greyhaven-terrain`); it needs FFmpeg but no Blender or network. The game owns blending, tiling and placement.

| Stable key | Poly Haven scan | `tileMetres` |
| --- | --- | --- |
| `greyhaven.terrain.grass` | [`forrest_ground_01`](https://polyhaven.com/a/forrest_ground_01) | 2 |
| `greyhaven.terrain.forest` | [`forest_leaves_02`](https://polyhaven.com/a/forest_leaves_02) | 3 |
| `greyhaven.terrain.path` | [`rocky_trail`](https://polyhaven.com/a/rocky_trail) | 2 |
| `greyhaven.terrain.gravel` | [`rocks_ground_02`](https://polyhaven.com/a/rocks_ground_02) | 2 |
| `greyhaven.terrain.rock` | [`rock_face_03`](https://polyhaven.com/a/rock_face_03) | 2.7 |
| `greyhaven.terrain.mud` | [`brown_mud_02`](https://polyhaven.com/a/brown_mud_02) | 1.3 |
| `greyhaven.terrain.sand` | [`sand_01`](https://polyhaven.com/a/sand_01) | 1.5 |

`tileMetres` is the scan's real-world edge (Poly Haven `dimensions` in millimetres / 1000, rounded to 0.01): one texture repeat covers that many metres of ground.

## Entry contract

Each key has variant `default`, a glTF with one mesh: a 1 m × 1 m quad on the XZ plane facing +Y with `POSITION`, `NORMAL`, `TEXCOORD_0` (0..1, u along +X, v along +Z) and `TANGENT` (+X, w = 1). Its one material is named after the layer (`grass`, `forest`, …):

- `pbrMetallicRoughness.baseColorTexture`: RGBA PNG, 1024². RGB is the Poly Haven colour (sRGB). A encodes height: `round(255 × (0.5 + 0.5 × h))`, where h is the `disp` map normalised so its 1st percentile maps to 0 and its 99th to 1 (clamped), so alpha lies in 128..255;
- `metallicRoughnessTexture`: PNG, 512², from `arm` (R = ambient occlusion, G = roughness, B = metal), also the `occlusionTexture` (the same image);
- `normalTexture`: PNG, 1024², from `nor_gl` (OpenGL, +Y);
- `metallicFactor` 0, roughness factor 1 and a white base colour factor (glTF defaults, so omitted from the JSON), `alphaMode` `MASK` with `alphaCutoff` 0.5, so every texel is opaque;
- one sampler: `REPEAT`/`REPEAT`, `LINEAR_MIPMAP_LINEAR` minification, `LINEAR` magnification.

The 2K maps are downscaled by `scene.textures.resize.gltf@1` (area average; colour in linear light, normals as unit vectors).

## Descriptor

The `terrain-descriptor` attachment (on the `grass` entry, schema `greyhaven-terrain-descriptor-v1`) lists per layer: `key`, `variant`, `layer`, `polyHavenId`, `tileMetres`, `meanColor` (the mean RGB of the shipped 1024² base-colour texture in linear light, 4 decimals, so a client can divide by it and keep only the detail around its own palette) and `provenance` (catalog source ids and sha256 per map, `CC0-1.0`, authors, the Poly Haven evidence URL and the height percentiles used).
