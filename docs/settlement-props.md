# Greyhaven settlement props

This is the build recipe for the reusable settlement props of one Greyhaven Outpost public space ([#369](https://github.com/moritzbrantner/asset-tooling/issues/369), consumer [mmorpg#421](https://github.com/moritzbrantner/mmorpg/issues/421)). mmorpg#421 asks for at least one prop from each of three families: work and market props, street furniture and architectural dressing. The footbridge ([#651](https://github.com/moritzbrantner/asset-tooling/issues/651)) joins the street family for the region's stream crossings.
The cottage furniture (bed, table, chair, chest and hearth) joins the dressing family to furnish the cottage interiors of [mmorpg#843](https://github.com/moenarch-games/mmorpg/issues/843). Its `sleep`, `top` and `fire` observations stay in the recipe result; the descriptor schema keeps its published extras.

- **Approach:** an original scripted Blender recipe, [`adapters/blender/settlement_props.py`](../adapters/blender/settlement_props.py), as Atlas Decisions 1.1.7 and 3.1.2 direct for mmorpg's humanlike-world environments. Quaternius props were the inspiration only. The set uses no imported meshes and no third-party assets.
- **Style:** it matches the [Outpost building kit](outpost-kit.md) and the [Greyhaven inn](greyhaven-inn.md): dark braced timber, plain plank wood, iron straps and hoops, coursed stone footings and shingle. The recipe builds its props with the kit's own `Builder`, materials and numpy textures, so the textures are byte-identical to the kit's.
- **Release:** one rolling release, `settlement-props` (Atlas Decision 7.1.5), never a numbered one.

## Build

```sh
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-settlement-props.ts --out <directory>
```

[`scripts/build-settlement-props.ts`](../scripts/build-settlement-props.ts) works like the [Outpost build](outpost-kit.md#build):

1. One `external.blender.script@1` run per prop. The kit recipe `outpost.py` is a declared, hash-pinned Python input named `outpost`, and the props recipe loads it with `inputs.load_source("outpost")`.
2. Each GLB is imported through `scene.import.gltf@2`, with no validator exceptions.
3. The descriptor is written from the recipe's observations and the measured bounds.
4. The result is exported as a `gltf-resources-v1` bundle (`asset.bundle@4`) and packed to `<directory>/settlement.props.tar`. The script also writes `lineage.json`, `descriptor.json` and `export.ref.json`.

The build takes about a minute. It needs no network, no LFS payloads and no GPU. Snap Blender can only read and write under `$HOME`, so set `TMPDIR` to a directory there.

In a live Blender session, run `outpost.py` and `settlement_props.py` into two namespaces, bind the shared helpers with `outpost_namespace["use_common"](runpy.run_path("adapters/blender/kit_common.py"))`, then call `use_kit(outpost_namespace)`. After that, `build(prop, collection, location, yaw)` and `build_composition("square", collection, location)` work, for example through the Blender MCP.

## Props

| Key | Family | Triangles | Footprint W × D × H (m) | Collision proxies | Notes |
| --- | --- | --- | --- | --- | --- |
| `settlement.props.stall` | market | 968 | 2.60 × 1.83 × 2.60 | `counter`, `awning` | A 2.4 × 1.4 m plank counter with four posts and a striped canvas awning with a pointed valance, sloping to the front. It carries a crate, two sacks and a board. |
| `settlement.props.cart` | market | 1,326 | 1.34 × 2.44 × 0.99 | `cart` | A two-wheeled handcart with 0.92 m spoked wheels and iron tyres, resting level on a prop leg. The shafts point to +Z. It carries a sack and a crate. |
| `settlement.props.crate` | market | 180 | 0.71 × 0.71 × 0.70 | `crate` | A plank crate in a timber frame with braces. `stackTop` is 0.7. |
| `settlement.props.barrel` | market | 390 | 0.61 × 0.61 × 0.90 | `barrel` | A coopered barrel with four iron hoops and a sunk head. `stackTop` is 0.9. |
| `settlement.props.signpost` | street | 304 | 1.37 × 0.44 × 2.96 | `post` | A post on a stone footing with a braced arm towards +X and a hanging painted board facing ±Z. Its empty node `sign` is at the board's centre. |
| `settlement.props.lantern-post` | street | 262 | 0.40 × 0.87 × 3.06 | `post` | A 3 m post on a stone footing with an iron bracket towards +Z and a horn-paned lantern. Its empty node `light` is at the flame, about 2.5 m up. |
| `settlement.props.bench` | street | 260 | 1.60 × 0.42 × 0.46 | `bench` | A two-plank bench on trestle legs with a wedged stretcher. The seat is at 0.46 m. |
| `settlement.props.fence` | dressing | 172 | 2.00 × 0.16 × 1.14 | `fence` | A 2 m post-and-rail segment along X. Like the kit's walls, it has half a post at each end, so neighbouring segments share one post. |
| `settlement.props.planter` | dressing | 420 | 1.20 × 0.50 × 0.83 | `planter` | A timber planter box with soil and three leafy shrubs. |
| `settlement.props.firewood` | dressing | 968 | 1.90 × 0.82 × 1.20 | `woodpile` | Five rows of split billets on sleepers between end stakes, end grain to the front, under a short shingle cover. |
| `settlement.props.footbridge` | street | 2,136 | 2.30 × 9.07 × 3.17 | `deck`, `ramp-back`, `ramp-front`, `rail-left`, `rail-right` | A 9 m plank footbridge along Z (#651): a level 6.6 m deck 0.55 m up on two stringers and two braced trestles, 1.2 m sloped ends down to the ground and post-and-rail sides. Its ends rest on the ground; the trestle posts reach 1.6 m below it, into a stream bed. |
| `settlement.props.bed` | dressing | 432 | 1.00 × 2.00 × 0.95 | `bed`, `headboard` | A plank bed along Z, its headboard at −Z: a straw mattress under a dyed blanket and a pillow ([mmorpg#843](https://github.com/moenarch-games/mmorpg/issues/843)). |
| `settlement.props.table` | dressing | 386 | 1.40 × 0.80 × 1.01 | `table` | A trestle table, its top 0.76 m up, with a jug and two bowls. |
| `settlement.props.chair` | dressing | 128 | 0.45 × 0.45 × 0.95 | `chair` | A slat-backed chair, its back towards −Z. The seat is at 0.45 m. |
| `settlement.props.chest` | dressing | 168 | 0.92 × 0.53 × 0.55 | `chest` | An iron-bound chest with a slightly domed lid and a hasp to +Z. |
| `settlement.props.hearth` | dressing | 372 | 1.80 × 0.85 × 2.60 | `hearth`, `flue` | A stone fireplace for a wall at −Z: a raised firebox with logs and embers under a mantel and a hood narrowing to a 2.6 m flue. |
| `settlement.props.barrel-group` | market | 766 | 1.27 × 1.25 × 0.90 | `barrels-back`, `barrel-lying` | Two standing barrels at the back and a third lying along X on wedges in front ([#657](https://github.com/moritzbrantner/asset-tooling/issues/657)). |
| `settlement.props.crate-stack` | market | 720 | 1.96 × 0.84 × 1.32 | `crates`, `crate-top` | Two 0.7 m crates side by side, a 0.62 m crate turned across them and a small crate beside, for a wall at −Z. |
| `settlement.props.grain-sacks` | market | 564 | 1.42 × 0.99 × 0.63 | `sacks` | Five tied sacks standing in two rows and one lying across the front. |
| `settlement.props.wheelbarrow` | market | 330 | 0.70 × 1.71 × 0.85 | `wheelbarrow` | A plank wheelbarrow, its wheel to +Z and handles to −Z, resting on two legs with a sack in the tray. |
| `settlement.props.well` | street | 550 | 2.20 × 1.59 × 2.64 | `curb`, `post-left`, `post-right` | A 1.5 m round stone well curb with dark water inside, two posts with a windlass and crank (+X), a rope to a hanging bucket and a shingle gable roof, ridge along X. |
| `settlement.props.fingerpost` | street | 222 | 1.54 × 1.07 × 2.61 | `post` | A 2.5 m fingerpost on a stone footing with three pointed, lettered arms at different heights and bearings. |
| `settlement.props.hay-bale` | dressing | 100 | 1.00 × 0.48 × 0.50 | `bale` | A rectangular bale tied with two twine bands, a few wisps on top. `stackTop` is 0.45. |
| `settlement.props.haystack` | dressing | 230 | 2.65 × 2.61 × 2.75 | `haystack` | A rounded field haystack 2.3 m high around a pole, with a skirt of fallen hay. |
| `settlement.props.chopping-block` | dressing | 228 | 1.63 × 0.94 × 0.94 | `block`, `logs` | A stump with an axe bitten into it, split pieces at its foot and three logs to its left (−X). |
| `settlement.props.washing-line` | dressing | 298 | 3.70 × 1.05 × 2.05 | `post-left`, `post-right` | A 3.6 m line along X between two T-posts, sagging under a sheet, a shirt and two cloths, with a basket in front. Only the posts collide. |
| `settlement.props.flower-tub` | dressing | 492 | 0.74 × 0.74 × 0.69 | `tub` | A hooped half-barrel of soil with leafy clumps and red, white and yellow flowers. |
| `settlement.props.vegetable-bed` | dressing | 342 | 1.80 × 1.00 × 0.43 | `bed` | A raised plank bed with two rows of cabbages and a row of carrot tops at the front. |
| `settlement.props.kennel` | dressing | 216 | 1.13 × 1.55 × 1.06 | `kennel` | A plank dog kennel with a shingle gable, its doorway to +Z, and a water bowl in front. |
| `settlement.props.dresser` | dressing | 754 | 1.28 × 0.50 × 1.96 | `cupboard`, `racks` | A kitchen dresser for a wall at −Z ([#663](https://github.com/moritzbrantner/asset-tooling/issues/663)): a two-door cupboard under a worktop and open plate racks above, with plates, cups and a jug. |
| `settlement.props.settle` | dressing | 300 | 1.50 × 0.51 × 1.25 | `seat`, `back` | A high-backed settle for a wall at −Z, shaped arms and a cushion. The seat is at 0.45 m (`seat`). |
| `settlement.props.rug` | dressing | 276 | 2.14 × 1.30 × 0.02 | `rug` | A flat woven rug: dyed field, light border, centre lozenge and fringed ends along ±X. Its 1.6 cm proxy can be walked over or ignored. |
| `settlement.props.cooking-pot` | dressing | 716 | 1.12 × 1.18 × 1.26 | `hearth`, `pot` | An iron pot on a chain from a 1.2 m iron tripod over a ring of stones, logs and embers. The embers are a warm-light spot at about y 0.05. |
| `settlement.props.jar-shelf` | dressing | 844 | 1.24 × 0.32 × 1.94 | `shelf` | A freestanding shelf unit for a wall at −Z, four shelves of jars, crocks and bottles. |
| `settlement.props.spinning-wheel` | dressing | 480 | 0.95 × 0.39 × 1.10 | `spinning-wheel` | A spinning wheel on a slanted three-legged bench: the spoked wheel to +X, the treadle in front, the flyer to −X and a distaff of wool. |
| `settlement.props.cradle` | dressing | 240 | 1.04 × 0.48 × 0.61 | `cradle` | A rocking cradle on two rockers, hooded head to −X, bedding and a blanket. |
| `settlement.props.hall-table` | dressing | 884 | 3.60 × 0.90 × 1.01 | `table` | A long trestle table for Westmere Lodge's hall, top 0.78 m up on three trestles, laid with platters, a loaf, tankards, bowls and a candle. |
| `settlement.props.shrine` | street | 590 | 0.84 × 0.78 × 2.25 | `plinth`, `pillar` | A roadside shrine facing +Z ([#665](https://github.com/moritzbrantner/asset-tooling/issues/665)): a coursed stone pillar on a stepped plinth, a gabled timber niche with a figure and a candle at 1.5 m, an offering bowl of flowers on the step. |
| `settlement.props.standing-stone` | street | 452 | 1.63 × 1.22 × 2.40 | `stone` | A 2.4 m weathered standing stone, its broad face to +Z carved with a spiral and a column of runes, fallen stones at its foot. |
| `settlement.props.watchtower-ruin` | street | 576 | 5.43 × 6.27 × 3.50 | `wall0` … `wall15` | The stump of a round stone watchtower 4.6 m across, its 0.55 m wall broken off between 1.2 and 3.5 m, a doorway gap toward +Z, rubble around. One box proxy per wall segment (15); the inside is open ground. |
| `settlement.props.bridge-railing` | street | 132 | 3.00 × 0.19 × 1.07 | `railing` | A weathered 3 m timber railing segment along X for a bridge deck's edge, half a post at each end (`module` width 3), a sagging top rail, a broken mid rail and a leaning centre post. |
| `settlement.props.stall-awning` | market | 1,146 | 2.90 × 1.81 × 2.64 | `counter`, `awning` | A market stall variant: a 2.4 m trestle counter with baskets of produce, loaves and a crate below, under a red canvas gable awning with a light pointed valance, ridge along X. |
| `settlement.props.bread-basket` | market | 424 | 0.56 × 0.56 × 0.24 | `basket` | A wide, shallow wicker bread basket ([#669](https://github.com/moritzbrantner/asset-tooling/issues/669)) heaped with five round loaves and two long ones; for a counter or the ground. |
| `settlement.props.cheese-board` | market | 260 | 0.80 × 0.45 × 0.23 | `board` | A plank cheese board for a counter: two stacked wheels, a cut wheel with its wedge beside it and a knife. |
| `settlement.props.fish-crate` | market | 936 | 0.70 × 0.51 × 0.24 | `crate` | A shallow plank fish crate on straw, heaped with a dozen grey fish. |
| `settlement.props.apple-crate` | market | 630 | 0.60 × 0.56 × 0.42 | `crate` | A slatted crate heaped with red, yellow and green apples, two rolled out in front. |
| `settlement.props.hanging-meats` | market | 660 | 1.70 × 0.50 × 1.98 | `frame` | A 1.5 m timber hanging frame for a butcher's or smokehouse front: two hams and three strings of sausages on cords from a crossbar at 1.9 m. |
| `settlement.props.cask-rack` | market | 1,234 | 1.40 × 0.80 × 1.02 | `rack` | Three wine and ale casks lying head-out toward +Z on a timber gantry, two on the rails with wooden taps, one in the groove above. |
| `settlement.props.merchant-scale` | market | 454 | 0.90 × 0.40 × 1.24 | `scale` | A merchant's balance: a turned post on a stepped base, an iron beam with two brass pans on chains and a row of weights. |
| `settlement.props.cloth-bolts` | market | 624 | 1.20 × 0.80 × 0.94 | `table` | A draper's trestle table stacked with folded bolts of cloth in four colours, two more bolts leaning against its front. |
| `settlement.props.pottery` | market | 786 | 1.08 × 0.71 × 0.66 | `jar`, `ware` | A group of terracotta ware: a tall storage jar, two handled jugs, a wide pot, a pitcher and a stack of bowls. |
| `settlement.props.anvil` | dressing | 322 | 0.97 × 0.60 × 0.78 | `anvil`, `bucket` | A blacksmith's anvil on an elm stump, horn toward +X, a hammer and tongs leaning on the stump and a quench bucket beside it. |
| `settlement.props.grindstone` | dressing | 500 | 1.16 × 0.69 × 1.16 | `grindstone` | A 0.76 m sandstone grindstone on an iron axle between timber uprights, a crank toward +Z, a water trough below on splayed legs. |
| `settlement.props.cooper-barrel` | dressing | 420 | 1.92 × 1.42 × 0.85 | `barrel` | A cooper's barrel being raised: fourteen staves gathered in two hoops at the foot and splayed open at the top, loose staves and a spare hoop beside it. The proxy covers only the barrel. |
| `settlement.props.table-set` | dressing | 994 | 1.04 × 0.58 × 0.24 | `set` | Inn table dressing ([#671](https://github.com/moritzbrantner/asset-tooling/issues/671)) for a 1.2 × 0.6 m top, its origin on the tabletop: four places of plates with food and tankards (two pewter, two turned wood), a jug, a loaf on a board and a candle. Place it on any table. |
| `settlement.props.candles` | dressing | 202 | 0.29 × 0.23 × 0.25 | `dish` | Three candles of different heights on a pewter dish with a ring handle, for a table, shelf or mantel. Its empty node `light` is at the tallest flame. |
| `settlement.props.candelabra` | dressing | 452 | 0.71 × 0.48 × 1.66 | `candelabrum` | A 1.5 m wrought-iron floor candelabrum: three splayed feet, a shaft and a crossarm of three candles in drip cups. Its `light` node is at the middle flame, 1.64 m up. |
| `settlement.props.inn-sign` | street | 192 | 0.18 × 1.12 × 0.90 | `bracket` | A blank hanging inn sign for a wall at −Z: a wall plate and a braced iron bracket reaching 1.1 m out toward +Z, a 0.7 × 0.55 m board hanging edge-on to the wall, blank inside a dark border. The origin is the foot of the wall plate; mount it about 2.4 m up. Its `sign` node and board bounds are for a consumer's painted emblem. |
| `settlement.props.stool` | dressing | 178 | 0.34 × 0.35 × 0.45 | `stool` | A three-legged round tavern stool with a stretcher ring; the seat is at 0.45 m. |
| `settlement.props.bar-counter` | dressing | 784 | 2.00 × 0.76 × 1.05 | `counter` | A 2 m inn bar counter segment along X (`module` width 2, so segments chain): a panelled front toward the room at +Z with an iron footrail, a 1.05 m top, and behind it a pot shelf with tankards. |
| `settlement.props.log-stack` | dressing | 364 | 1.06 × 0.45 × 0.46 | `logs` | Firewood stacked by a hearth: three rows of split logs on iron log-dogs, a straw basket of kindling beside it toward +X. |
| `settlement.props.wall-shield` | dressing | 336 | 1.47 × 0.15 × 1.43 | `shield` | A round painted shield with a boss and a pale cross over two crossed spears, for a wall at −Z, facing +Z. The origin is the bottom of its back; mount it at the height you want. |
| `settlement.props.wall-trophy` | dressing | 294 | 0.94 × 0.18 × 0.98 | `trophy` | A stag's antlers and skull on a carved oak plaque, for a wall at −Z, facing +Z. The origin is the bottom of its back; mount it at the height you want. |
| `settlement.props.rowing-boat` | dressing | 886 | 3.57 × 1.20 × 0.67 | `hull` | A 3.6 m rowing boat drawn up on the bank ([#675](https://github.com/moritzbrantner/asset-tooling/issues/675)), bow toward +X: a lofted plank hull with a transom stern, a gunwale, a keel, three thwarts, two oars laid along them and a mooring ring at the stem. Its keel is on the ground. |
| `settlement.props.jetty` | street | 608 | 3.00 × 1.61 × 1.96 | `deck`, `piles` | A 3 m plank jetty segment along X (`module` width 3, so segments chain out over the water): a 1.6 m deck 0.5 m above the water line (y = 0) on stringers and bearers, round piles 1.5 m apart reaching 1.2 m down into the bed, and two bollards. |
| `settlement.props.fishing-nets` | dressing | 1,330 | 2.64 × 1.20 × 2.20 | `poles`, `trestle` | Fishing nets hung to dry: two 2.2 m poles with a cross pole, a sagging net with cork floats on its head rope, a second net heaped over a trestle and a creel. |
| `settlement.props.banner-outpost` | street | 434 | 1.00 × 0.36 × 3.72 | `pole` | A 3.6 m banner pole on a stone footing ([#677](https://github.com/moritzbrantner/asset-tooling/issues/677)) with a crossbar carrying a 0.8 × 1.5 m swallow-tailed banner in the Outpost's livery: Marshal indigo with an ochre band and pale, hanging in gentle folds and facing ±Z. |
| `settlement.props.banner-village` | street | 418 | 1.00 × 0.36 × 3.72 | `pole` | The same banner in a village's livery: undyed linen with two madder-red stripes. |
| `settlement.props.pennant-outpost` | street | 202 | 2.02 × 0.36 × 4.32 | `pole` | A 4.2 m pole flying a 1.8 m tapering indigo pennant with an ochre hoist, streaming toward +X. |
| `settlement.props.pennant-village` | street | 202 | 2.02 × 0.36 × 4.32 | `pole` | The same pennant in linen with a red hoist. |
| `settlement.props.bunting` | street | 556 | 6.28 × 0.28 × 3.20 | `pole-1`, `pole1` | A market bunting line: two 3.2 m poles 6 m apart along X and a sagging cord hung with 18 triangular flags in red, linen, indigo, ochre and green. |
| `settlement.props.scarecrow` | dressing | 760 | 1.59 × 0.62 × 2.10 | `pole`, `body` | A scarecrow on a 2.2 m cross pole ([#695](https://github.com/moritzbrantner/asset-tooling/issues/695)): a patched red coat with a rope belt and straw at the hem, a stitched sacking head and a wide straw hat. **Animated:** `Sway_Loop` (4 s) flutters its sleeves and hat. |
| `settlement.props.weather-vane` | dressing | 582 | 1.20 × 0.71 × 1.53 | `spindle` | A rooster weather vane for a roof ridge or a post top: an iron spindle on a 0.2 m mounting plate, compass arms lettered N (−Z), E (+X), S (+Z) and W (−X), and a gilt rooster on an arrow pointing to +X. The origin is the foot of the plate; mount it at the height you want. **Animated:** `Turn_Loop` (8 s) veers the vane slowly back and forth. |
| `settlement.props.beehive-skeps` | dressing | 836 | 1.40 × 0.43 × 0.94 | `bench` | Three coiled straw skeps on a plank bench, their entrances facing +Z, the middle one under a straw hackle. |
| `settlement.props.water-trough` | dressing | 222 | 1.60 × 0.62 × 0.55 | `trough` | A hewn stone trough along X, half full of dark water. |
| `settlement.props.feed-trough` | dressing | 120 | 1.50 × 0.56 × 0.45 | `trough` | A low plank trough along X on splayed trestle legs for pigs and sheep, mash in the bottom. |
| `settlement.props.hen-coop` | dressing | 372 | 1.16 × 1.57 × 1.40 | `coop`, `ramp` | A small hen coop on four legs: a plank house under a shingle gable (ridge along X), a hatch and a pop hole to +Z and a cleated ramp down to the ground in front. |
| `settlement.props.plough` | dressing | 546 | 0.65 × 2.83 × 0.94 | `plough` | A wooden mouldboard plough along Z, resting level on a small front wheel (+Z) with a hitch ring: an iron coulter and share, a curved board turning the furrow to +X and two handles with a rung reaching back to −Z. |
| `settlement.props.watermill` | dressing | 2,040 | 5.45 × 4.19 × 4.46 | `house`, `steps`, `wheel` | A timber watermill ([#699](https://github.com/moritzbrantner/asset-tooling/issues/699)): a plank mill house in a braced frame on a stone footing under a shingle gable (ridge along X), with a door, steps and a shuttered window to +Z and sacks by the door, and a 2.9 m undershot wheel on its +X side between the wall and an outer bearing post. The floats reach the ground plane: set the wheel side over a stream. **Animated:** `Turn_Loop` (6 s a turn) turns the wheel. |
| `settlement.props.water-wheel` | dressing | 928 | 1.52 × 2.66 × 2.70 | `post-left`, `post-right`, `wheel` | The undershot wheel alone, 2.7 m across, on a timber axle between two braced bearing posts on sills along Z, to set into a stream beside any building. The floats reach the ground plane, so put the origin at the water line. **Animated:** `Turn_Loop` (6 s a turn) turns the wheel. |
| `settlement.props.windmill` | dressing | 1,926 | 7.37 × 5.50 × 9.08 | `trestle`, `body`, `ladder` | A small post mill: a weatherboarded body under a shingle gable (ridge along Z) on a main post braced by quarter bars from crossed sills on four stone piers, a door and ladder at the back (−Z) and four 4.4 m lattice sails with canvas to the front (+Z). Only the trestle, body and ladder collide. **Animated:** `Turn_Loop` (8 s a turn) turns the sails anticlockwise, seen from the front. |
| `settlement.props.forge` | dressing | 1,026 | 3.57 × 1.45 × 3.50 | `hearth`, `chimney`, `bellows`, `tub` | A village forge: a waist-high stone hearth with a glowing coal bed (emissive `ember`) in a stone rim, a back wall at −Z under a hood narrowing to a chimney, a quench tub to +X and a lever bellows to −X with its nozzle into the hearth. Its `fire` point (recipe observation) is where a warm light belongs. **Animated:** `Pump_Loop` (2 s) lifts the bellows by its lever and lets it fall. |
| `settlement.props.well-windlass` | dressing | 780 | 2.42 × 1.24 × 1.66 | `frame-left`, `frame-right` | A windlass to set over a well curb like the `well`'s 1.5 m one: two A-frame trestles 1.9 m apart on sills along Z under a tie beam, a drum along X wound with rope, a rope down the shaft and an iron crank to +X. The origin is the well's centre. The `well` keeps its own static windlass and roof; use this over a bare curb. **Animated:** `Crank_Loop` (3 s a turn) winds the drum, the rope side rising. |
| `settlement.props.spit-roast` | dressing | 934 | 1.93 × 1.13 × 1.07 | `fire`, `post-left`, `post-right` | A campfire spit ([#703](https://github.com/moritzbrantner/asset-tooling/issues/703)): a ring of stones round a glowing coal bed (emissive `ember`) with charred logs, two forked posts at ±X and an iron spit along X through a tied joint, with a crank at +X. The origin is the fire's centre; its `fire` point (recipe observation) is where a warm light belongs. **Animated:** `Turn_Loop` (5 s a turn) turns the spit. |
| `settlement.props.butter-churn` | dressing | 386 | 0.43 × 0.43 × 1.47 | `churn` | A tall plunger churn: a tapering stave churn in three iron hoops under a collared lid, the dasher's handle standing half a metre out of it. |
| `settlement.props.loom` | dressing | 936 | 1.84 × 0.56 × 2.08 | `loom` | An upright warp-weighted loom leaning back against a wall at −Z: two 2.1 m uprights, a cloth beam with the half-woven cloth wound on and hanging to mid-height in dyed stripes, a heddle rod on pegs, a shed rod and the warp in two sheets down to rows of clay loom weights. |
| `settlement.props.potters-wheel` | dressing | 1,110 | 0.86 × 1.15 × 1.06 | `wheel`, `seat` | A potter's kick wheel: a timber frame on sills with a work board round the wheel head, a slip bowl, a seat plank to −Z and a spoked flywheel at the foot of an iron shaft whose head carries a half-thrown pot. **Animated:** `Spin_Loop` (1 s a turn) spins the flywheel, head and pot. |
| `settlement.props.hide-frame` | dressing | 566 | 1.94 × 0.70 × 1.95 | `frame` | The tanner's stretching frame: two posts on feet along Z, braced from −Z, joined by top and bottom bars, with a hide laced taut inside by cords to every side, hair side to +Z and the pale scraped flesh side to −Z. |
| `settlement.props.shop-sign-smith` | street | 400 | 0.18 × 1.02 × 0.95 | `bracket` | A hanging shop sign for a wall at −Z, mounted like the `inn-sign` (origin at the foot of the wall plate, about 2.4 m up): a braced iron bracket reaching 1 m out toward +Z and a painted board hanging edge-on to the wall, so it faces ±X. The smith's is a square ochre board with an anvil under a hammer. **Animated:** `Swing_Loop` (3 s) swings the board gently about the bracket arm. |
| `settlement.props.shop-sign-baker` | street | 684 | 0.19 × 1.02 × 0.95 | `bracket` | The baker's sign, the same bracket with an arched red board, a scored loaf and a roll. **Animated:** `Swing_Loop` (3 s). |
| `settlement.props.shop-sign-tailor` | street | 708 | 0.18 × 1.02 × 0.95 | `bracket` | The tailor's sign, the same bracket with an indigo shield-shaped board and open shears. **Animated:** `Swing_Loop` (3 s). |

The village dressing from `barrel-group` down ([#657](https://github.com/moritzbrantner/asset-tooling/issues/657)) is for Greyhaven's villages, Barrowdown and Fenford. The existing `cart`, `firewood` and `planter` complement it.
The interiors from `dresser` down ([#663](https://github.com/moritzbrantner/asset-tooling/issues/663)) furnish more walk-in farmhouses and Westmere Lodge's hall, beside the cottage furniture.
The landmarks from `shrine` down ([#665](https://github.com/moritzbrantner/asset-tooling/issues/665)) mark Greyhaven's roads, crossings and market corners.
The market goods and workshops from `bread-basket` down ([#669](https://github.com/moritzbrantner/asset-tooling/issues/669)) stock Greyhaven's stalls, shops and smithies.
The inn and hall clutter from `table-set` down ([#671](https://github.com/moritzbrantner/asset-tooling/issues/671)) dresses inns, taverns and halls; the wall pieces stand on their own back edge so they can be hung at any height.
The river and lake props from `rowing-boat` down ([#675](https://github.com/moritzbrantner/asset-tooling/issues/675)) dress Greyhaven's banks and landings. Lily pads and reeds are in the [marsh plants](greyhaven-marsh-plants.md) (`water-lilies`, `reeds-stand`, `reeds-edge`, `cattails`).
The banners from `banner-outpost` down ([#677](https://github.com/moritzbrantner/asset-tooling/issues/677)) fly the Outpost's livery, the Marshal's indigo with ochre heraldry as on the [fortress kit](fortress-kit.md)'s banners, or a neutral village one. The cloth is two-sided; only the poles collide.
The farmstead dressing from `scarecrow` down ([#695](https://github.com/moritzbrantner/asset-tooling/issues/695)) is for Greyhaven's farms and hamlets (mmorpg#880). It joins this release rather than a new one, because it is the same style, recipe, materials and descriptor; it adds no materials or textures.
The village machinery from `watermill` down ([#699](https://github.com/moritzbrantner/asset-tooling/issues/699)) gives Millbrook its mill and the smithy a forge. Its moving parts are separate nodes turned by named loop clips, as the farmstead's are. It adds two plain materials, `ember` and `leather`, and no textures. [`review/settlement-props/village-machinery.jpg`](../review/settlement-props/village-machinery.jpg) is a viewport capture from the live Blender session.
The craft stations and shop signs from `spit-roast` down ([#703](https://github.com/moritzbrantner/asset-tooling/issues/703)) give Greyhaven's tanner, innkeeper, farmers and market traders places to work. The spit, the potter's wheel and the signs' boards are separate nodes moved by named loop clips. They add no materials or textures. [`review/settlement-props/craft-stations.jpg`](../review/settlement-props/craft-stations.jpg) is a viewport capture from the live Blender session.

The numbers are from the build of 2026-10-24, the farmstead dressing, the village machinery and the craft stations from the builds of 2026-11-16. The descriptor carries the measured values of each build. The budgets in `SETTLEMENT_TRIANGLE_BUDGET` are for the Greyhaven camera (12 m, 0.42 rad pitch, 50° fov).

## Frame

- **Units and axes:** metres, +Y up, right-handed.
- **Origin:** on the ground at the centre of the prop's footprint (`footprint-base-center`). The front faces +Z.
- **Fence:** the segment spans x −1..1, so segments chain on a 2 m grid.

## Composition

The descriptor's `compositions.square` is a working layout of a small market corner, 12 × 9 m, in a centre-ground frame. The open square is towards +Z. It has 21 items:

- at the back, two stalls with stacked crates, barrels, the handcart and the woodpile, in front of a 12 m fence run;
- at the front, a lantern post, a bench, a planter, a barrel, a crate and the signpost, all facing the walkway.

`walkway` is a 3 m wide box along X through the middle (z −1.5..1.5). The test checks that no item's collision proxy enters it and that every item stays inside the footprint. The layout is a starting point. mmorpg chooses the real space and the placements.

## Look and materials

The props use the kit's wood, stone and shingle texture sets (colour, normal and ORM, 512 px each) and its `timber`, `iron` and `soot` materials. The recipe adds these plain-colour materials:

- `canvas` and `dye`: the awning stripes and the painted sign;
- `sacking`: the sacks;
- `soil` and `leaf`: the planter;
- `endgrain`: the billet ends;
- `horn`: the lantern panes;
- `straw`: the hay bale, haystack, bread basket and fish-crate bedding;
- `monolith`: the standing stone, the grindstone and the fish, a plain weathered grey where coursed masonry would read wrong;
- `clay`: the terracotta pottery and the sausages;
- `indigo` and `ochre`: the Outpost's banner livery and the bunting;
- `leather`: the forge bellows;
- `ember`: the forge's and the spit roast's coal beds, the one emissive material (`emissiveFactor` a warm orange, strength 1).

Every face has backface culling. In the bundle there are 9 KTX2 textures in all, each stored once. Repeated props in a scene share their GLB resources. The tar is about 6.8 MB.

**Determinism:** there is no randomness. Variation comes from SHA-256 of fixed keys, through the kit's `rnd`.

### Animated props

The scarecrow, the weather vane, the village machinery, the spit roast, the potter's wheel and the shop signs carry named glTF node-animation clips that loop; there is no skin. Each animated part is its own node, with its origin at the joint it turns about:

| Prop | Clip | Length | Nodes |
| --- | --- | --- | --- |
| `scarecrow` | `Sway_Loop` | 4 s | `settlement.scarecrow.sleeve-left`, `settlement.scarecrow.sleeve-right` (at the shoulders, flapping about the crossbar), `settlement.scarecrow.hat` (on the head) |
| `weather-vane` | `Turn_Loop` | 8 s | `settlement.weather-vane.vane` (on the spindle, veering about +Y) |
| `watermill` | `Turn_Loop` | 6 s | `settlement.watermill.wheel` (wheel and axle, a full turn about X; the floats at the bottom move to +Z) |
| `water-wheel` | `Turn_Loop` | 6 s | `settlement.water-wheel.wheel` (wheel and axle, a full turn about X; the floats at the bottom move to +Z) |
| `windmill` | `Turn_Loop` | 8 s | `settlement.windmill.sails` (sails, hub and windshaft, a full turn about Z) |
| `forge` | `Pump_Loop` | 2 s | `settlement.forge.bellows` (top board, leather and lever, hinged at the nozzle about Z) |
| `well-windlass` | `Crank_Loop` | 3 s | `settlement.well-windlass.drum` (drum, axle and crank, a full turn about X) |
| `spit-roast` | `Turn_Loop` | 5 s | `settlement.spit-roast.spit` (spit, joint and crank, a full turn about X) |
| `potters-wheel` | `Spin_Loop` | 1 s | `settlement.potters-wheel.wheel` (flywheel, shaft, head and pot, a full turn about Y, anticlockwise seen from above) |
| `shop-sign-smith`, `shop-sign-baker`, `shop-sign-tailor` | `Swing_Loop` | 3 s | `settlement.shop-sign-<trade>.board` (board and hangers, swinging about 7° each way about the bracket arm, Z; each trade starts at its own phase) |

A clip's last key equals its first, so a consumer plays it on repeat (three.js: `AnimationMixer.clipAction(clip).play()` with the default `LoopRepeat`), and may offset each instance's start time so neighbours don't move in step. The recipe keys the rotations at 24 fps in one Blender action per clip, with a slot per node, which the glTF exporter writes as one animation. The turning loops are keyed linearly, so they keep a steady speed across the seam; a full turn ends on the identity rotation, and the exporter may flip a quaternion's sign on the way round, which interpolation along the shortest arc (three.js) ignores. The clip names are in each GLB and in the bundle manifest's `observations.animations`; the published descriptor schema keeps its fields, so `SETTLEMENT_CLIPS` in the build script lists them for tests.

### Textures on the GPU

Every texture ships as KTX2 (Basis Universal, `KHR_texture_basisu`, required, no PNG or JPEG fallback), with a full mip chain and encoded once per image by the shared kit pass (`ktx2Asset`, [`src/kit-bundle.ts`](../src/kit-bundle.ts), with KTX-Software's `ktx` CLI): base colour ETC1S sRGB, ORM and other data ETC1S linear, normals UASTC. A GPU transcodes Basis to a block format of at most 1 byte per texel, a quarter of RGBA8. Consumers need a Basis transcoder (in three.js, `KTX2Loader` registered with the `GLTFLoader`); a client without one cannot read the bundle. The 9 textures are about 0.8 MB; the tar went from 2.1 MB (9 PNGs) to 1.4 MB.

## Descriptor `settlement-props-descriptor-v1`

The descriptor is canonical JSON and the `settlement-descriptor` attachment of `settlement.props.stall`. Its schema is [`schemas/settlement-props-descriptor-v1.schema.json`](../schemas/settlement-props-descriptor-v1.schema.json).

| Field | Meaning |
| --- | --- |
| `schema`, `units`, `up`, `facing`, `handedness`, `origin` | `"settlement-props-descriptor-v1"`, `"metre"`, `"+Y"`, `"+Z"`, `"right"`, `"footprint-base-center"` |
| `assets[]` | Sorted by `key`. Each has `key`, `role`, `family` (`market`, `street` or `dressing`), `parentName`, `triangles`, `footprint`, measured `bounds` and `collisionProxies`. |
| `assets[].stackTop` | `crate`, `barrel`: the height another one stacks on. |
| `assets[].seat` | `bench`: `{ height, length, depth }`. |
| `assets[].module` | `fence`: `{ width: 2, height }`. |
| `assets[].light` | `lantern-post`: `{ node: "light", position }`. |
| `assets[].sign` | `signpost`: `{ node: "sign", board: { min, max } }`. |
| `compositions.square` | `{ footprint, walkway, items[] }`, where an item is `{ key, variant, translation, yawDegrees }` and the yaw is about +Y. |

`collisionProxies` are axis-aligned `solid` boxes `{ name, tag, center, size }` in the prop's frame. They are presentation metadata. The props carry no gameplay: a consumer keeps its own colliders and interactions, and it may use, replace or ignore these proxies (mmorpg#421).

## Release

The bundle is distributed as the rolling `settlement-props` GitHub release, whose assets are replaced in place. A consumer pins the release, the tar sha256 and its own copy of `export.ref.json` ([asset-bundles.md](asset-bundles.md#release-distribution-and-consumer-pinning)). It reads each prop with `readAssetBundleGltf(dir, manifest, "settlement.props.<prop>", "default")` and the descriptor with `readAssetBundleAttachment(dir, manifest, "settlement.props.stall", "default", "settlement-descriptor")`. CI publishes it when a change to its recipe merges ([Publishing a rolling release](../README.md#publishing-a-rolling-release)).

## Tests

`test/blender/kits/settlement-props.test.ts` runs in the hosted `blender-script` job. It checks:

- the tar and the bundle verify, with one `default` entry per prop;
- the descriptor conforms to the schema;
- there are exactly 9 resources, all KTX2: the kit's wood, stone and shingle;
- every prop stays within its triangle budget (`SETTLEMENT_TRIANGLE_BUDGET`), has its family and stands on the ground;
- the scarecrow, the weather vane, the village machinery, the spit roast, the potter's wheel and the shop signs carry exactly their named clips at their lengths, in the GLB and the bundle manifest, with no skin, and no other prop animates;
- the forge's and the spit roast's `ember` material is emissive;
- the fence fills its 2 m module, the crate's `stackTop` is its top, and the lantern and the sign hang above head height;
- in the square, every item is a bundle entry, all three families are placed, and every proxy stays inside the footprint and out of the walkway.

Without `ASSET_TOOLING_BLENDER` it skips.

## Not covered here

These belong to the mmorpg side, mmorpg#421:

- choosing the public space and placing the props;
- the fallback when resources fail;
- the matched-camera game capture;
- native parity.

Publishing the `settlement-props` release is also not covered here.
