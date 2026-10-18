# Per-entry release downloads

The rolling releases of experimental bundles (Atlas Decision 7.1.5), `humanoid-ranger-male` and `greyhaven-starter`, publish each bundle entry as its own downloads, so a consumer fetches only what it uses. These are owner decisions of 2026-10-18 (per-variant downloads, `EXT_meshopt_compression`, KTX2/Basis textures). The full `gltf-resources-v1` tar stays on the release for review and for the Pages comparison.

[`scripts/pack-downloads.ts`](../scripts/pack-downloads.ts) turns a built bundle into the downloads:

```sh
ASSET_TOOLING_KTX=<ktx CLI> bun scripts/pack-downloads.ts --bundle <dir>/bundle --out <downloads> --name humanoid-ranger-male --clips humanoid.ranger.male/default
gh release upload humanoid-ranger-male <downloads>/* --clobber
```

| File | Contents |
| --- | --- |
| `<key>.<variant>.gltf` + `.bin` | One entry, for example `humanoid.ranger.male.outfit.knight.lod1`. The `.bin` is meshopt-compressed (`EXT_meshopt_compression` with `KHR_mesh_quantization`). |
| `tex-<hash>.ktx2` | Textures as KTX2 (`KHR_texture_basisu`), content-addressed and shared by every entry that uses them, so a Dark/Light pair or a level chain downloads them once. |
| `<key>.clips.glb` | Ranger only: the joints and every clip, with no meshes. Every character entry has the same joints at the same rest pose, so a consumer plays these clips on any variant or level by joint name. |
| `<key>.<variant>.<attachment>.json` | The entry's attachments, for example `humanoid.ranger.male.default.humanoid-sockets.json`. |
| `<name>.index.json` | `asset-downloads-v1`: each entry's files, textures and total bytes, the clips file, each texture's encoding, and a `runtime` cost per entry (#124): draw calls, materials, triangles, and the texture memory estimated from the KTX2 headers. That estimate is 1 byte per texel after Basis transcodes to a block format (BC7/ETC2/ASTC), against 4 bytes per texel for an RGBA8 fallback, with a third added for mips. |

**Texture encoding**, chosen per texture by the material slots that use it:

- **Normal maps:** UASTC (quality 2) with Zstandard level 18. Normals band badly under ETC1S.
- **Base colour and emissive:** ETC1S (BasisLZ, `qlevel` 160), sRGB.
- **Data maps** (ORM, roughness, occlusion such as the armour's AO): ETC1S, linear.

All textures get mipmaps. Images whose sides are not powers of two, such as the 1008 × 981 flower sheet, are resampled to the nearest power of two; otherwise they decoded black on WebGL's block-compressed path (#124). The encoder is KTX-Software's `ktx create` (4.4.2, Apache-2.0). Set `ASSET_TOOLING_KTX` to its CLI; it is not bundled.

**Consumer setup (three.js):**

```js
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
const loader = new GLTFLoader()
  .setKTX2Loader(new KTX2Loader().setTranscoderPath("<three>/examples/jsm/libs/basis/").detectSupport(renderer))
  .setMeshoptDecoder(MeshoptDecoder);
const clips = (await loader.loadAsync("humanoid.ranger.male.clips.glb")).animations;
const knight = await loader.loadAsync("humanoid.ranger.male.outfit.knight.gltf");
new THREE.AnimationMixer(knight.scene).clipAction(THREE.AnimationClip.findByName(clips, "Walk_Loop")).play();
```

The index lists what to fetch. An entry's `.gltf` refers to its `.bin` and its `tex-*.ktx2` by relative URI, so the files must sit side by side, for example when downloaded into one folder or served from the release download URL.

**Verified:** the packed knight, Light-skin soldier, knight LOD2 and Light-skin LOD1 were loaded in headless Chromium (three.js 0.186, swiftshader WebGL) with this setup. They played the shared clips correctly.

**Sizes** (built 2026-10-18). For the Ranger, the review tar went from 75.7 MB, with clips embedded in every variant and level, to 30.9 MB with the clips stored once. The downloads total 16 MB:

- shared clips: 2.97 MB;
- one character entry with its textures: about 4.9–5.3 MB;
- a variant with all three levels: about 5.4–5.9 MB, because the levels share the textures.

The starter kit now resizes to game resolution before bundling (#124, the Ranger's per-slot limits: 1024 px colour and normal, 512 px data maps). Its tar dropped from 72.2 MB to 21.6 MB, and its downloads total 11 MB. Example runtime costs per entry: the wall is 3.6 MB to download, with about 9.4 MB of transcoded texture memory (37.7 MB as RGBA8); the barrel is 2.1 MB with about 6.3 MB.

## Review

[`examples/compressed-review/review.ts`](../examples/compressed-review/review.ts) renders an entry in headless Chromium with three.js, side by side: the bundle's PNG scene on the left and the KTX2 + meshopt download on the right, from the same camera distance. Checked on 2026-10-18 at gameplay distances:

- Ranger default at 2.6 m and 10 m;
- knight at 2.6 m;
- wall, barrel, tree and flowering bush.

Normal maps, alpha cut-outs and the packed ORM channels read the same. The ETC1S alpha edges of the flower petals show a faint fringe close up.
