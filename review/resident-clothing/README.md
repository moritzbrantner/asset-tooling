# Resident clothing kit: mockup

Mockup for [#560](https://github.com/moritzbrantner/asset-tooling/issues/560), purpose-made everyday garments for Greyhaven's residents, before anything is built (review rule: mockup first). Nothing here is shipped. The garments are procedural block-outs in a scratch Blender scene, fitted by raycasting onto the released `humanoid.ranger.male` (farmer), `humanoid.ranger.female` (tanner) and the four `young-residents` figures. The figures are posed in a relaxed A-pose, and their Peasant tunics, skirts and smocks are hidden. Hair comes from the `hair-kit` and the female Ranger and is tinted for the mockup only.

- `sheet.jpg`: the ten looks, three-quarter view.
- `close-<look>.jpg`: front, three-quarter and back.
- `game.jpg`: the Greyhaven game camera (12 m, 0.42 rad pitch, 50° FOV), from the front and from behind, as a native 1080p crop.

## Pieces

| # | Look | Figure | Pieces | Proposed construction | Est. triangles | Secondary motion |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Child's smock | child boy (and girl) | `smock` | Fitted yoke with a smocked band, loose A-line body gathered from the yoke into deep folds above the knee, full sleeves gathered into cuffs, bound neck with a two-button placket. Folds modelled; smocking, seams and hem in the texture. | 2,400–2,800 | none (the hem rides the thighs, like the Peasant tunic) |
| 2 | Smock dress + pinafore | child girl (teen girl) | `smock.long`, `pinafore` | The same yoke and sleeves, the body to mid-calf; a linen pinafore tied over it. | 3,000–3,400 + 300 | 4 skirt chains (#391 `skirt.*`), pinafore on the `apron` chain |
| 3 | Teen jerkin + shirt | teen boy (adult male) | `shirt`, `jerkin`, belt | Linen shirt: only the collar and sleeves show, so the hidden body faces are deleted. Sleeveless leather jerkin with a standing collar, front lacing, panel seams and a short skirt pointed at the front. | shirt 1,200–1,500, jerkin 1,600–2,000, belt 200 | none (stiff leather) |
| 4 | Teen kirtle | teen girl | `kirtle.teen` | As 5, cut for the teen: high, modest neckline, an easier bodice with no waist shaping, full-length sleeves over the chemise's cuffs. | 6,000–7,000 | 4 skirt chains |
| 5 | Kirtle | adult female | `chemise`, `kirtle` | **Layered:** a linen chemise shows at the scooped neckline and below the elbow-length kirtle sleeves; its hidden body is deleted. Fitted, laced bodice. **Gathered skirt:** cartridge pleats where it is sewn to the waist seam, relaxing into 16–18 deep tubular folds that reach the floor, with a hem that rises over the fold valleys. Folds modelled; weave, pleat creases and seams in the normal map. | chemise (visible parts) 800–1,000, kirtle 5,500–6,500 | 4 skirt chains (`skirt.front`, `.back`, `.left`, `.right`) |
| 6 | Kirtle, patched | adult female | as 5 + rope belt | The same meshes. Faded undyed wool, sewn-on patches and a darned elbow, and a shorter, frayed, uneven hem (a hem variant of the skirt mesh). Patches and darns are atlas decals, not extra geometry. | as 5 + 300 | as 5 |
| 7 | Kirtle, better-off | adult female | as 5 + belt, pouch | Woad-dyed wool with an embroidered hem band and red trimmed sleeve hems, a whiter chemise, a leather belt with a brass buckle and a pouch. | as 5 + 350 | as 5 |
| 8 | Work tunic, patched | adult male (teen boy) | `tunic`, rope belt | A loose, knee-length tunic belted with a rope: easy chest, folds gathered under the belt, keyhole neck with a lace, long sleeves. Patches on the chest, skirt, back and elbow, and a ragged hem. | 3,500–4,000 + 300 | 4 skirt chains |
| 9 | Tunic, better-off (innkeeper) | adult male | `tunic`, belt, pouch, half-apron | The same tunic mesh with a round neck, in madder-red wool, with an embroidered hem band, trimmed cuffs, a leather belt with a pouch, and a linen half-apron. | as 8 + 650 | as 8; the apron on the `apron` chain |
| 10 | Smith | adult male | short `tunic`, `apron.leather` | A plain, mid-thigh tunic under a heavy leather bib apron hanging to the knee, with neck straps and waist ties. | tunic 3,000, apron 500–700 | `apron` chain (swing 15°); the tunic needs none |

The mockup meshes are denser than these targets (subdivided lofts with 128–160 columns). The targets are what a build would aim for. A dressed figure would stay near the young residents' 18–20k triangles, because each kit piece replaces the Peasant parts it covers (tunic 3.3–3.9k, skirt 1.7k, legs 1.1k).

## "More sophistication"

The issue left open what more sophistication means. The proposal, against the 60 FPS target on an RTX 3060 Ti with many residents on screen:

- **Layered garments, but only where a layer shows.** The chemise shows at the neckline and the forearms, and the shirt at the collar and the sleeves. The hidden body of each under-layer is deleted. This avoids poke-through and doesn't pay for triangles nobody sees.
- **Authored folds in the geometry and the texture.** These are the gathers, cartridge pleats, smocking and hem shapes that make the garments read as real clothes at the game camera. They are modelled at rest, with a shared normal map for weave, seams and pleat creases.
- **Secondary motion only through the existing #391 accessory chains**, for skirts, long tunics and aprons. These are a few joints per figure, sprung by the consumer on top of the clips. That costs microseconds and keeps the clips and the rig unchanged. The female figure has no chains yet; this kit would add the same `skirt.*` and `apron` chains to the garments.
- **No simulated cloth.** A per-vertex simulation of a 5k-vertex skirt with leg collision, for dozens of residents, costs far more than the frame budget allows. It would also need its own collision proxies and can't be authored or reviewed as a static asset. If more life is wanted later, a cheap vertex-shader sway on the hem is the next step, not a simulation.

## Textures and cost

The kit would use one shared cloth atlas, 2048 px ETC1S base colour, plus a 1024 px UASTC normal map. The atlas holds linen, wool and leather tiles with the authored fold and seam detail, plus trim and embroidery strips and the patch and darn decals. By `report-kit-costs` counting, that is about 5.6 MB + 1.4 MB, or about 7 MB of GPU textures. Poor and better-off variants are atlas regions of the same textures, not extra textures.

The kit would have two materials: `cloth`, untinted (linen, leather and trims), and `cloth.dyed` (wool, tinted by the consumer from a dye palette: undyed, madder, woad, weld and green). These replace the figures' present `outfit` and `skirt`, so the draw calls don't change. Everything stays opaque and single-sided. Characters ship no levels of detail (#516). The download is estimated at 6–9 MB.

## Fits

The pieces would be skinned to the 65-joint Ranger rig and fitted to the adult male and female figures. The young proportions would be carried the way `young_residents.py` bakes them (`PROFILES`). Young figures' garments stay loose and age-appropriate: the smock falls A-line from the yoke, and the teen kirtle has a high neckline and no waist shaping.

| Piece | Adult male | Adult female | Teen boy | Teen girl | Child boy | Child girl |
| --- | --- | --- | --- | --- | --- | --- |
| smock | | | | | ✓ | ✓ |
| smock.long + pinafore | | | | ✓ | | ✓ |
| shirt | ✓ | | ✓ | | | |
| jerkin | ✓ | | ✓ | | | |
| chemise + kirtle | | ✓ | | ✓ (teen cut) | | |
| tunic (plain, patched, better-off) | ✓ | | ✓ | | | |
| apron.leather, half-apron | ✓ | ✓ | | | | |

**Sources.** The catalog has no fitting CC0 everyday garments (the Quaternius Peasant outfits are what the residents wear today). The pieces would be original, authored in `assets/authored/`.
