# Greyhaven starter environment sources

This is the first source slice of [#118](https://github.com/moritzbrantner/asset-tooling/issues/118) under [Decision 3.1.1](decisions/atlas.md). It covers Quaternius Medieval Village and Fantasy Props MegaKits for the building and the everyday prop, plus the owner-approved Stylized Nature MegaKit for the tree. All three are CC0. Using the [archive-member sources](catalog.md#archive-member-sources) capability, the catalog pins each archive by hash and stores only the members listed below in Git LFS. The owner approved about 49 MB of unique member payloads for this first set ([comment](https://github.com/moritzbrantner/asset-tooling/issues/118)).

This slice registers, pins and promotes the source payloads only. Normalizing the assets into the production profile, composing the scene recipe and bundling are the next #118 slice.

## Archives

| Catalog id | Archive | License evidence |
| --- | --- | --- |
| `quaternius.medieval-village-megakit-standard` | `medieval_village_megakitstandard.zip` (existing record) | quaternius.com pack page, CC0 |
| `quaternius.fantasy-props-megakit-standard` | `fantasy_props_megakitstandard.zip` (existing record) | quaternius.com pack page, CC0 |
| `quaternius.stylized-nature-megakit-standard` | `https://opengameart.org/sites/default/files/stylized_nature_megakitstandard.zip`, measured 104,088,529 bytes, SHA-256 `298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9` | `https://quaternius.com/packs/stylizednaturemegakit.html`. The bundled `License_Standard.txt` states CC0 1.0. |

## Selected assets and their complete member sets

Each selected glTF and **every** buffer and image URI it references is a separate member record. A URI resolves to the member next to the glTF; when no such file exists, it resolves to the explicitly recorded member path under the archive's texture folder.

| Role | Archive | glTF member | Referenced members |
| --- | --- | --- | --- |
| Building piece with doorway | Medieval Village | `glTF/Wall_Plaster_Door_Flat.gltf` | `glTF/Wall_Plaster_Door_Flat.bin`; `glTF/T_WoodTrim_{Normal,BaseColor,Roughness}.png`; `glTF/T_Plaster_{Normal,BaseColor,ORM}.png`; `glTF/T_RockTrim_{Normal,BaseColor,ORM}.png` |
| Door | Medieval Village | `glTF/Door_1_Flat.gltf` | `glTF/Door_1_Flat.bin`; `glTF/T_WoodTrim_{Normal,BaseColor,Roughness}.png` (the same records as the wall's) |
| Door frame | Medieval Village | `glTF/DoorFrame_Flat_WoodDark.gltf` | `glTF/DoorFrame_Flat_WoodDark.bin`; `glTF/T_WoodTrim_{Normal,BaseColor,Roughness}.png` (the same records as the wall's and the door's) |
| Everyday prop | Fantasy Props | `Exports/glTF/Barrel.gltf` | `Exports/glTF/Barrel.bin`; `Textures/T_Trim_Furniture_{Normal,BaseColor,ORM}.png`; `Textures/T_Trim_Metal_{Normal,BaseColor,ORM}.png` |
| Tree | Stylized Nature | `glTF/CommonTree_1.gltf` | `glTF/CommonTree_1.bin`; `glTF/Bark_NormalTree_Normal.png`; `glTF/Bark_NormalTree.png`; `glTF/Leaves_NormalTree_C.png` |

Shared textures, such as the WoodTrim set used by the wall, the door and the door frame, have exactly one member record and one stored payload.

The door frame answers #118 Q8 (owner decision, 2026-10-14): the wall has no faces across its 0.2 m thickness inside the doorway, so the kit's matching frame member is pinned and promoted like the other members. Selection (routine; the owner can object): `DoorFrame_Flat_WoodDark` is the flat-topped frame that matches the flat doorway and the wooden door, and it adds only its 3,792-byte buffer, because its textures are the WoodTrim records already stored. It spans x −0.786..0.788, y −0.009..2.304 and z −0.243..0.145 m around the 1.2956 × 2.1511 m opening. `DoorFrame_Flat_Brick` (RockTrim, 58,928-byte buffer) and the `Round` variants were not selected.

## Record conventions

- **Member ids** are `<archive id>.<slug>`, where the slug is the member's basename in lowercase with `_` and `.` replaced by `-`. Example: `quaternius.medieval-village-megakit-standard.door-1-flat-gltf`.
- **Media types:** `model/gltf+json` for `.gltf`, `application/octet-stream` for `.bin` and `image/png` for `.png`.
- **Kinds:** `mesh` for glTF, `buffer` for binary buffers and `texture` for images.
- **Tags:** every member is tagged with `greyhaven-starter`, plus the role (`building`, `door`, `door-frame`, `prop` or `tree`) of each asset that uses it.
- Every archive and member record is pinned, and every member has exactly one `catalog/storage.json` entry under `assets/canonical/<member id>/<basename>`. Archives have no storage entry.

## Acceptance

- **Resource closure:** for each selected glTF, every buffer and image URI it references resolves to exactly one registered member of the same archive, using the rule above.
- **Members and pins:** every listed member is registered, pinned and stored, and no unlisted member of these archives is stored.
- **Shared payloads:** a texture shared between assets is stored once.
- **Integrity:** each stored payload's SHA-256 and byte length match its pin. `bun run catalog:storage:verify` passes from a hydrated checkout, and the hosted canonical-storage job runs `git lfs fsck`.
- **Licenses:** archive and member licenses are identical CC0 records.
- **Gate:** `bun run check` passes.
