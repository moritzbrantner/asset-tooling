# Humanoid source set

This covers the second and third slices of [#109](https://github.com/moritzbrantner/asset-tooling/issues/109). It registers, pins and promotes the first humanoid source members under [Atlas Decisions 1.1.3, 6.1.1, 6.1.2 and 6.1.3](decisions/atlas.md): the **Male Ranger** outfit from Modular Character Outfits – Fantasy, the matching **male base body** from Universal Base Characters, and the original Universal Animation Library (UAL1) Standard clips, including `Idle_Loop` and `Walk_Loop`. All three packs are CC0. Using [archive-member sources](catalog.md#archive-member-sources), the catalog pins each archive by hash and stores only the members listed below in Git LFS: 18 members, 62,624,527 bytes of unique payloads. A later addition for the Ranger bundle v2 ([#260](https://github.com/moritzbrantner/asset-tooling/issues/260), [#113](https://github.com/moritzbrantner/asset-tooling/issues/113)) adds one more clips member from Universal Animation Library 2 (UAL2), for its `Idle_Shield_Loop` shield guard. That brings the set to 19 members and 70,686,127 bytes.

This slice covers the source payloads only. Retargeting the clips onto the outfit's skeleton stays with #110 and #115. Building the processed public bundle and proving it in a real consumer is #110. The build recipe for that bundle, with its bone map and conventions, is in [humanoid-ranger.md](humanoid-ranger.md).

## Archives and provenance

| Catalog id | Where it comes from | Pin (SHA-256, bytes) | License evidence |
| --- | --- | --- | --- |
| `quaternius.universal-base-characters-standard` | `https://quaternius.itch.io/universal-base-characters`, itch.io upload id `15861669` | `fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40`, 128,968,391 | `https://quaternius.com/packs/universalbasecharacters.html`; the bundled `License_Standard.txt` states CC0 1.0 |
| `quaternius.modular-character-outfits-fantasy-standard` | `https://quaternius.itch.io/modular-character-outfits-fantasy`, itch.io upload id `16289385` | `c3468b18871cc8c8f05ab14df7712baf22cb9f389cbd870babf130e595187f70`, 294,347,394 | the itch.io page; the bundled `License_Standard.txt` states CC0 1.0 |
| `quaternius.universal-animation-library-standard` | `https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip` (Quaternius's OpenGameArt upload) | `18ff1a7215f4852b320203e8aaf02a1578b5c8eef9027fbaedfcedc7b85a3ac2`, 14,541,205 | `https://opengameart.org/content/universal-animation-library`; the bundled `License.txt` states CC0 1.0 |
| `quaternius.universal-animation-library-2-standard` | `https://opengameart.org/sites/default/files/universal_animation_library_2standard.zip` (Quaternius's OpenGameArt upload) | `ec0e40d6d78fe9aaad59e322f40865a8675c22f0745e291622e54520391a9217`, 10,257,419 | `https://quaternius.com/packs/universalanimationlibrary2.html`; the bundled `License.txt` states CC0 1.0 |

The two itch.io packs have no stable download URL, because itch.io hands out only short-lived signed links. Under [Decision 6.1.1](decisions/atlas.md) the archive was downloaded once and promoted from that local file. The record keeps the itch.io page in `source.url`, the upload id in `source.upstreamId` and a descriptive original file name in `source.path`. The **SHA-256 and byte-length pin is authoritative**, and the LFS objects are now the durable copies. UAL1 and UAL2 have stable OpenGameArt URLs, but each was promoted from a verified local copy. Their pins are authoritative too. The UAL2 archive was registered earlier as an unpinned `animation-pack` record, and its first member promotion pinned it.

## Members

Each selected glTF and every buffer and image it references is a separate member record. Every referenced file sits next to its glTF in the archive. Two body URIs resolve through a [declared substitution](#declared-substitution) rather than by name. The UAL1 GLB is self-contained.

**Body**: `Universal Base Characters[Standard]/Base Characters/Godot - UE/` in the Universal Base Characters archive.

| Member | Kind | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `Superhero_Male_FullBody.gltf` | mesh | 30,989 | `e7fcea214ecf8855afbf910b50de6f9c7d1decfb71ca28bad8a4481452dafeb4` |
| `Superhero_Male_FullBody.bin` | buffer | 720,076 | `459003f9745853ae562a85506a2b94dd56515c1f37728f9fa3d2ce1a3e4cd92f` |
| `T_Hair_1_BaseColor.png` | texture | 1,570,376 | `bc7aa863bd22ab0a995cd838cceb4d3a5186ee54ee2fb0108fad85d20c057e6e` |
| `T_Eye_Brown.png` | texture | 35,958 | `d08e3356a83211bc6ca21fe3a8e39f4b5c1a3b8f85457fc2c0fb57be09935025` |
| `T_Superhero_Male_Normal.png` | texture | 4,252,937 | `9b25cf9200216eb754b79cf4c63b5380c419780788322f3c57cdd2b3e02679a6` |
| `T_Superhero_Male_Dark.png` | texture | 1,384,380 | `df680cbc1967a61e85998bfafb8f7bc0a36dd604bb3266486c4b06b1a184bb45` |
| `T_Superhero_Male_Roughness.png` | texture | 3,152,049 | `c70dabf48574cda55644d556beae1ee7cf1bdcf68a50d259d20f2f2358f27991` |
| `T_Hair_1_Normal.png` (substitute) | texture | 4,326,126 | `57fd0ad8c96a4d01b38769637e066cecaa285b456f6e48ce00863754a457affb` |
| `T_Eye_Normal.png` (substitute) | texture | 15,099 | `9ed61f7726a54fe346a78b9e5a18905d8e2b88f86235d97f53cd207a26f3f8c7` |

**Outfit**: `Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/` in the Modular Character Outfits – Fantasy archive.

| Member | Kind | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `Male_Ranger.gltf` | mesh | 41,447 | `e1033a212332d84d98c19bc4927c621635478d0aa15d13c79da68d3ba9e0196f` |
| `Male_Ranger.bin` | buffer | 1,746,884 | `5bbb0d42cb324c6c27ce00417e68a876d92978f07d161f83590f0d7c0570eff6` |
| `T_Ranger_Normal.png` | texture | 12,713,653 | `dd64da2af3180f0c8f0b721cfc5f0d2720c351b97da8285c6cf49e7717c84147` |
| `T_Ranger_BaseColor.png` | texture | 6,630,927 | `846ef2170b04ee584ad83bb8a1e86dab57a9a43b1193204505912c274d949925` |
| `T_Ranger_ORM.png` | texture | 10,792,085 | `aca03d2fba12508ef07d5968ca22267fb207ea26ae898b6b2def8a296bd44f1c` |
| `T_Regular_Male_Normal.png` | texture | 4,064,184 | `10cd71e2453e577fdd43e912b6016a99baf64964f0593e524bdd304855e15e2a` |
| `T_Regular_Male_Dark_BaseColor.png` | texture | 1,316,151 | `b4dcc0f4139aab548d7c070c4655bd2080ef16caeaaabee6c4aeb693c524e802` |
| `T_Regular_Male_Roughness.png` | texture | 3,160,102 | `086c2eb25bddfdb77d8e639ccbffb8df723ef4a1910d8e1b217e852f8668bfe5` |

**Clips**: from the UAL1 archive.

| Member | Kind | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `Animation Library[Standard]/Godot/AnimationLibrary_Godot_Standard.glb` | animation | 6,671,104 | `1b7bf67866360665426bb99e4c71bd619f19b408453c24e30f0c3071601eee5c` |

The GLB carries 46 named clips. They include exactly one `Idle_Loop` and one `Walk_Loop`, which are the clips Decision 6.1.2 selects. The Ranger bundle v2 also takes `Jog_Fwd_Loop`, `Sprint_Loop`, `Sword_Idle`, `Sword_Attack` and `Death01` from it. Its skeleton uses 52 `DEF-*` joints, while the body and outfit use a 65-joint skin, so the clips need retargeting (#110/#115) before they drive the outfit.

**Clips (UAL2)**: from the UAL2 archive.

| Member | Kind | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `Universal Animation Library 2 [Standard]/Unreal-Godot/UAL2_Standard.glb` | animation | 8,061,600 | `0815dd05531cae9bc313fc9c0ba81330bc72f8e19ec45f73738e74ddc5796a43` |

The GLB carries 43 named clips, including exactly one `Idle_Shield_Loop`. UAL1 has no shield guard. Its skin is the same 65-joint Unreal-style rig as the body and outfit (`root`, `pelvis`, `spine_01` …), so the Ranger recipe retargets it with a same-name bone map that absorbs the small rest-pose differences.

### Female body and outfit (#115)

Owner answer #115.Q1 = A (2026-10-17) adds the female base body and the matching full `Female_Ranger` outfit, from the same two archives and folders. They were promoted from the same verified local archive files, so no download was needed. `T_Eye_Brown.png`, `T_Eye_Normal.png` and the three `T_Ranger_*` textures are shared with the male assets and stored once.

| Member | Kind | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `Superhero_Female_FullBody.gltf` | mesh | 31,656 | `adedf28000a0716f689b009a70314506fc62f827498f77ba852acb5610f3f3f4` |
| `Superhero_Female_FullBody.bin` | buffer | 990,808 | `3a8220a485b33d05d879115a50697728b45a151781106033afb8b8c243fca208` |
| `T_Hair_2_BaseColor.png` | texture | 1,729,467 | `f9f4f2fb3eeeefb0b6f0fdef38b0770fd6607640c1c680b8139dd76697e9f9b3` |
| `T_Hair_2_Normal.png` | texture | 4,710,013 | `172f230aae0d4366c3cfc0402b2e6d1811b11f8487344bff28605eeacac1558d` |
| `T_Superhero_Female_Dark_BaseColor.png` | texture | 1,319,410 | `d366843ee7d9e9f37ec87a0e1c98c7f2e45573c08eeb80a51a6d9344e68cf288` |
| `T_Superhero_Female_Normal.png` | texture | 3,940,537 | `cf922460b43ccd31e983e34db05514c9d451dd2f9cdd01a843978e797719f859` |
| `T_Superhero_Female_Roughness.png` | texture | 3,277,022 | `d2beabf2bd0313e32c68dcdbb80dca371a6e994fabf96efa97128bf9f14fa57b` |
| `Female_Ranger.gltf` | mesh | 45,461 | `9b98b2ae6af3b4a1ec22bf8928b939e0751f08b25b636de82bfa7364fb34d3e1` |
| `Female_Ranger.bin` | buffer | 1,959,556 | `d015964ba0a26eee9c9d2ea6f07aa660bba88aa536cf8bb6b67944b9e97c46df` |
| `T_Regular_Female_Dark_BaseColor.png` | texture | 1,348,542 | `3b6ab973f9f3d6f8961226a0dbd99cf6d1b72df3795a8a5c1620a55754c161c2` |
| `T_Regular_Female_Normal.png` | texture | 3,913,459 | `e1051d3d56df9cf061bc14c769c37253aecd595f8275f9d4c0d6e0e953c00e18` |
| `T_Regular_Female_Roughness.png` | texture | 3,274,215 | `da541fbd4b3bffe754fada5c29f8a0d8f836bf20ce7df8273607af4729a3a5ae` |

`Superhero_Female_FullBody.gltf` references `T_Eye_Normal_png.png`, the same exporter artifact as the male body. The same Decision 6.1.3 substitution binds it to `T_Eye_Normal.png`. Its hair normal map, `T_Hair_2_Normal.png`, resolves by name.

### Light skins and hairstyles (#116)

The owner's #116 answers add the Light skin base colours, used for the `skin.light` variants, and four "Origin at 0" hairstyles: `Hair_Buzzed`, `Hair_SimpleParted` and `Hair_Long` for the male figure, and `Hair_Long` and `Hair_Buns` for the female figure. They come from the same Universal Base Characters archive file.

The hairstyles reference `T_Hair_1_*` or `T_Hair_2_*` in their own folder. Those files are byte-identical to the body folder's members (same SHA-256), so they resolve to the stored members by name and are not stored twice.

| Member | Kind | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `Textures/T_Superhero_Male_Ligh.png` | texture | 1,389,170 | `419f96dbb8811511e2d515bcdabc085ff2f219ec7b8b4e91050a84cba6888fe9` |
| `Textures/T_Superhero_Female_Light_BaseColor.png` | texture | 1,317,541 | `743f811857db0b950f3ad09a0733dfa4888801ead332313ca25becea14c54f8d` |
| `glTF (Godot)/Hair_Buzzed.gltf` | mesh | 2,006 | `43752a4c8f2464eb2494a8ab179bf7ad237638a3d47fb3de0a38361db40e1451` |
| `glTF (Godot)/Hair_Buzzed.bin` | buffer | 19,892 | `89992fc7a5319df6f2908e44a3b694329fac4b500629a573224702e5fdd16f77` |
| `glTF (Godot)/Hair_SimpleParted.gltf` | mesh | 2,010 | `ce6c666d00bcca2baa0c58d0442505f90f8feff952592effc4697a2341e9e56d` |
| `glTF (Godot)/Hair_SimpleParted.bin` | buffer | 32,032 | `57c6359703a37e346ee38a9c7ba55c8dee761c0a02da99847d06f5a91728f3cc` |
| `glTF (Godot)/Hair_Long.gltf` | mesh | 2,056 | `94500e2e37e09efc8b8b920b8c6437ef1c76ca35863992b82d0d5de6e77122e9` |
| `glTF (Godot)/Hair_Long.bin` | buffer | 115,996 | `13996da35c7afbf8cb5097da37207ee5b7c2e2904d4ab9e2ace9843030fff8d5` |
| `glTF (Godot)/Hair_Buns.gltf` | mesh | 2,243 | `2bb3593575e21c9af39a53e48c42c1314b0a894e9577f3f14abffcb145cd56c5` |
| `glTF (Godot)/Hair_Buns.bin` | buffer | 131,768 | `4f6d4c010201278483da8d6d46ec40e3beb8d9e679ec2139bed216c561bccd38` |

## Declared substitution

`Superhero_Male_FullBody.gltf` uses two normal-map URIs, and `Superhero_Female_FullBody.gltf` uses the eye one, that the archive does not contain under those names. Under [Atlas Decision 6.1.3](decisions/atlas.md), each one is bound to the texture in the same folder:

- `T_Hair_1_Normal_png.png` (`images[0]`, the `MI_Hair_1` normal map) → `T_Hair_1_Normal.png`
- `T_Eye_Normal_png.png` (`images[2]`, the `MI_Eyes` normal map) → `T_Eye_Normal.png`

The substitutes are the same-folder +Y (OpenGL) normal maps. Their bytes are identical to the copies under `Textures/Normals Unity - Godot/`. The broken names are a Blender glTF exporter `_png.png` naming artifact, not a missing bake: the same folder also ships `T_Hair_1_BaseColor.png` and a byte-identical `T_Hair_1_BaseColor_png.png`. Both substitutes are ordinary members, promoted like the others. Each record names the URI it stands in for:

```json
"metadata": { "substitutesFor": [{ "member": "quaternius.universal-base-characters-standard.superhero-male-fullbody-gltf", "uri": "T_Hair_1_Normal_png.png" }] }
```

`substitutesFor` is a list, because `T_Eye_Normal.png` stands in for the same URI in both bodies. Each entry is `{ member, uri }`.

The source glTF bytes stay unchanged, and no bytes are invented or edited. The broken URIs themselves are not registered or stored. A consumer binds each URI to its substitute through the glTF importer's `resourceUris`. This replaces the known gap recorded under Decision 6.1.2.

## Record conventions

- **Member ids** are `<archive id>.<slug>`. The slug is the member's basename in lowercase, with `_`, `.` and spaces replaced by `-` and runs of `-` collapsed. Example: `quaternius.universal-base-characters-standard.superhero-male-fullbody-gltf`.
- **Media types and kinds:** a `.gltf` is `model/gltf+json` with kind `mesh`, a `.bin` is `application/octet-stream` with kind `buffer`, a `.png` is `image/png` with kind `texture`, and the clip `.glb` is `model/gltf-binary` with kind `animation`.
- **Tags:** every member is tagged `humanoid-baseline` plus exactly one role: `body`, `outfit` or `clips`.
- **Licenses:** each member's license record is identical to its archive's.
- **Storage:** every archive and member is pinned. Each member has exactly one `catalog/storage.json` entry, under `assets/canonical/<member id>/<basename>`. The archives have no storage entry.

## How the members were promoted

The first 21 records were added to `catalog/sources.json` with the archives unpinned and every member's `source` empty. Each member was then promoted with one local-file invocation. The first promotion from each archive measured and pinned it, and every later one re-verified that pin. The tool wrote the pins, the storage entries and the payloads; Git LFS turned the staged payloads into pointers. The UAL2 member followed the same way: one member record with `"source": {}`, then one promotion that pinned the UAL2 archive.

```text
bun run catalog:lfs:promote -- quaternius.universal-base-characters-standard.superhero-male-fullbody-gltf --from .artifacts/humanoid-candidates/base/pack.zip
bun run catalog:lfs:promote -- quaternius.universal-base-characters-standard.superhero-male-fullbody-bin --from .artifacts/humanoid-candidates/base/pack.zip
bun run catalog:lfs:promote -- quaternius.universal-base-characters-standard.t-hair-1-basecolor-png --from .artifacts/humanoid-candidates/base/pack.zip
bun run catalog:lfs:promote -- quaternius.universal-base-characters-standard.t-eye-brown-png --from .artifacts/humanoid-candidates/base/pack.zip
bun run catalog:lfs:promote -- quaternius.universal-base-characters-standard.t-superhero-male-normal-png --from .artifacts/humanoid-candidates/base/pack.zip
bun run catalog:lfs:promote -- quaternius.universal-base-characters-standard.t-superhero-male-dark-png --from .artifacts/humanoid-candidates/base/pack.zip
bun run catalog:lfs:promote -- quaternius.universal-base-characters-standard.t-superhero-male-roughness-png --from .artifacts/humanoid-candidates/base/pack.zip
bun run catalog:lfs:promote -- quaternius.universal-base-characters-standard.t-hair-1-normal-png --from .artifacts/humanoid-candidates/base/pack.zip
bun run catalog:lfs:promote -- quaternius.universal-base-characters-standard.t-eye-normal-png --from .artifacts/humanoid-candidates/base/pack.zip
bun run catalog:lfs:promote -- quaternius.modular-character-outfits-fantasy-standard.male-ranger-gltf --from .artifacts/humanoid-candidates/outfits/pack.zip
bun run catalog:lfs:promote -- quaternius.modular-character-outfits-fantasy-standard.male-ranger-bin --from .artifacts/humanoid-candidates/outfits/pack.zip
bun run catalog:lfs:promote -- quaternius.modular-character-outfits-fantasy-standard.t-ranger-normal-png --from .artifacts/humanoid-candidates/outfits/pack.zip
bun run catalog:lfs:promote -- quaternius.modular-character-outfits-fantasy-standard.t-ranger-basecolor-png --from .artifacts/humanoid-candidates/outfits/pack.zip
bun run catalog:lfs:promote -- quaternius.modular-character-outfits-fantasy-standard.t-ranger-orm-png --from .artifacts/humanoid-candidates/outfits/pack.zip
bun run catalog:lfs:promote -- quaternius.modular-character-outfits-fantasy-standard.t-regular-male-normal-png --from .artifacts/humanoid-candidates/outfits/pack.zip
bun run catalog:lfs:promote -- quaternius.modular-character-outfits-fantasy-standard.t-regular-male-dark-basecolor-png --from .artifacts/humanoid-candidates/outfits/pack.zip
bun run catalog:lfs:promote -- quaternius.modular-character-outfits-fantasy-standard.t-regular-male-roughness-png --from .artifacts/humanoid-candidates/outfits/pack.zip
bun run catalog:lfs:promote -- quaternius.universal-animation-library-standard.animationlibrary-godot-standard-glb --from .artifacts/humanoid-candidates/ual1.zip
bun run catalog:lfs:promote -- quaternius.universal-animation-library-2-standard.ual2-standard-glb --from .artifacts/humanoid-candidates/animations/quaternius.universal-animation-library-2-standard/universal_animation_library_2standard.zip
```

The `--from` file is the whole archive. Its name doesn't matter, because the pin identifies the bytes.

## Adding more members

The archives are plain catalog sources, so another member of the same packs needs no code. A future consumer might want an arpg knight outfit (`Male_Knight.gltf`), the female body or another outfit. For each one, add a `schemaVersion: 2` member record with `"source": {}` for the glTF and for every buffer and texture it references. Then run one `bun run catalog:lfs:promote -- <member id> --from <archive file>` per record. The existing archive pin is re-verified against the file.

## Acceptance

[`test/humanoid-sources.test.ts`](../test/humanoid-sources.test.ts) covers this slice:

- the archive and member records and their pins;
- the storage entries, with no unlisted member stored;
- the license records;
- the declared substitution: each substitute's `metadata.substitutesFor`, and that the broken URIs are not registered.

With hydrated payloads it also checks:

- each payload's integrity against its pin;
- resource closure: every URI the glTF references resolves to exactly one member, either by its adjacent basename or by exactly one declared substitution;
- that both broken URIs are used as normal textures and their substitutes are stored at their pins;
- that the UAL1 GLB contains `Idle_Loop`, `Walk_Loop` and the other Ranger clips, and that the UAL2 GLB contains `Idle_Shield_Loop` on a 65-joint skin;
- re-import: every humanoid member imports into a fresh object store, and a second import returns `unchanged` with an identical `AssetRef`, leaving the store byte-for-byte unchanged.

The hosted canonical-storage job sets `ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`, so these hydrated checks fail there instead of skipping. `bun run catalog:storage:verify` passes from a hydrated checkout.

### Peasant outfit (#117)

The soldier and knight wear the Peasant outfit under their armour (owner answers on #117, 2026-10-17). These members were promoted from the same verified local archive. The outfit's skin textures (`T_Regular_Male_*`) are shared with the Male_Ranger and stored once.

| Member | Kind | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `Male_Peasant.gltf` | mesh | 32,681 | `8f5a6cf6c1cf96e0a0f8e1a861b4245d42b7f88d44e5076da3d48f3fc52f4e76` |
| `Male_Peasant.bin` | buffer | 674,764 | `e46bde795f7b69b351d322d7a5628e07131cfb48ed0afe366293f1b3f530433c` |
| `T_Peasant_BaseColor.png` | texture | 5,055,760 | `a43635628d95571cd62fd4db0cc3a6ea32778b2bc02f242dda224c89d07f1ade` |
| `T_Peasant_Normal.png` | texture | 14,110,336 | `7598fa7b63e46fd4dac29708bf5a81e05eb9a67280f7b13c61e28a9110eeb679` |
| `T_Peasant_ORM.png` | texture | 9,903,835 | `e1932f5f91104afca89c501416a5fec09069b8552734237fc09045fabc4ca9b4` |
| `Female_Peasant.gltf` (#378) | mesh | 29,529 | `43ba98058b933cae9acbde0f3ef8c3dda4ba9f69f338606f9d87666d9efffb31` |
| `Female_Peasant.bin` (#378) | buffer | 658,600 | `40eccaa2bd545c893142ef7dca0866ea8f20df3a86c67c5615024bc4fe546e83` |

The female Peasant outfit (#378, the tanner's base) uses only the `T_Peasant_*` textures: it shows no skin.
