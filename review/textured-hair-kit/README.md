# Textured hair kit: mockup

Mockup for [#557](https://github.com/moritzbrantner/asset-tooling/issues/557), the curly, coily and braided hairstyles, before anything is built (review rule: mockup first). Nothing here is shipped: the pieces are procedural block-outs in a scratch Blender scene, fitted on the released `humanoid.ranger.male`, `humanoid.ranger.female` and `young-residents.kit.child-girl` heads, hood hidden. The skin is tinted darker for this mockup only.

- `sheet.jpg`: all six pieces on the three heads, three-quarter view.
- `close-<piece>.jpg`: front, three-quarter and back on each head.
- `game.jpg`: the Greyhaven game camera (12 m, 0.42 rad pitch, 50° FOV), from behind and from the front, as a native 1080p crop.

## Pieces

Every piece sits on the same hairline: forehead, temples, above and behind the ears, down to the nape. Each would be skinned to the shared `Head` joint and attached through `head.hair`, like the [hair kit](../../docs/hair-kit.md).

| Piece | Look | Proposed construction | Est. triangles | Secondary motion |
| --- | --- | --- | --- | --- |
| `hair.short-coils` | Close coily crop, shorter at the sides and nape | One opaque shell over the scalp, inner shell removed; coil tile in the shared atlas | 900–1,300 | none |
| `hair.rounded-afro` | Full, round afro, about 5 cm out at the crown, rising from the hairline, trimmed at the nape | Opaque shell with a rounded outer silhouette; larger coil tile | 1,800–2,400 | none |
| `hair.cornrows` | About 20 straight-back rows from the whole hairline, converging at the nape into short braided ends; the scalp shows in the parts | Low half-tubes on the scalp with a plait normal strip; the head's skin is the parting | 2,400–3,000 | none |
| `hair.box-braids` | Square-parted braids with a centre part, falling to the shoulders (loose); a variant gathers them into a low tail with a leather tie | About 40 outer braids as 4-sided tubes with a plait strip over an opaque under-layer shell | 4,500–5,200 (tied: about 4,000) | loose: 3 chains (left, right, back), as `hair.long`; tied: a tail chain plus `hair.tie`, as `hair.tied` |
| `hair.loose-curls` | Soft curly volume with defined ringlets to about the jaw and nape | Opaque shell plus about 30 ringlet clumps as twisted 4-sided tubes | 4,000–4,800 | one back chain |
| `hair.curly-bun` | Coils drawn up close to the scalp into a full curly puff on the crown, with a tie | Thin shell, a lumpy bun mesh and a small tie band | 1,400–1,700 | none |

The mockup meshes are denser than these targets (up to about 130,000 triangles for the box braids); the targets are what a build would aim at, in the range of the hair kit's pieces (830 to 5,096).

**Textures and cost.** One shared, tintable 1024 px atlas (coil tile, curl clump, plait strip) as an ETC1S base colour, plus a 512 px UASTC normal map: about 1.75 MB of GPU textures by `report-kit-costs` counting, against the hair kit's 6 MB budget. Two materials: the tinted hair material and the fixed `hair.tie`, against the hair kit's 3. The hair kit's tints (`tint.black`, `tint.brown`, `tint.blond`, `tint.grey`) apply. Everything stays opaque and single-sided. The download is estimated at 4–6 MB.

**Fits.** All six fit the adult male, the adult female and the young head. In the mockup they were generated from each head's own scalp. A build would fit them to the male and female heads and carry the young proportions the way the young-residents kit already carries pack hair. As in the hair kit, a hairstyle needs the hood off. The afro and the bun also clash with helmets.

**Sources.** The catalog has no curly, coily or braided hair. Rather than promoting a new source, the pieces would be original, authored in `assets/authored/` like the hair kit's hand-modelled pieces.
