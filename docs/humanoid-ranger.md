# Ranger character bundle

This is the build recipe for the first clothed, skinned humanoid of [#110](https://github.com/moritzbrantner/asset-tooling/issues/110): the Quaternius **Male_Ranger** outfit ([Atlas Decision 1.1.3](decisions/atlas.md)) with the Universal Base Characters head, and the UAL1 `Idle_Loop` and `Walk_Loop` clips retargeted onto its rig. It follows the owner answers of 2026-10-17 on #110:

- The clips are retargeted with 3d-lab's `three_d_animation::retarget` and an explicit semantic bone map.
- The walk is in place.
- The conventions are metres, +Y up, facing +Z and the origin between the feet.
- The result is a `gltf-resources-v1` bundle ([asset-bundles.md](asset-bundles.md#gltf-resources-profile)). It is published to the rolling GitHub release `humanoid-ranger-male` (`humanoid-ranger-female` for the female figure), whose assets are replaced in place on each update (Atlas Decision 7.1.5). The numbered releases `humanoid-ranger-male-v1` … `-v9` stay published for consumers that pin them, but no new numbered releases are made. 
- Acceptance is structural checks, the #111 viewer snapshots and consumer smoke tests. There is no byte-exact replay and no Blender world-space oracle.

The source members are listed in [humanoid-sources.md](humanoid-sources.md).

## Contents

There is one current recipe and no numbered bundle versions (Atlas Decision 7.1.5). Each build replaces the assets of the rolling release. The older numbered releases (`humanoid-ranger-male-v1` … `-v9`, `humanoid-ranger-female-v7` … `-v9`) stay published for consumers that pin them, but the recipe no longer reproduces them.

The `humanoid.ranger.male` bundle holds the following.

- **Character entry `humanoid.ranger.male`:**
  - **Composition:** the Male_Ranger outfit composed with the Universal Base Characters head subset on the shared 65-joint skeleton.
  - **Textures:** game-resolution PNGs ([Textures](#textures)).
  - **Variants:**
    - `default`: the archer, Dark skin.
    - `skin.light`: the Light skin, with the outfit's skin texture derived by a colour transfer (#116 Q13).
    - `outfit.soldier` and `outfit.knight`, plus their `.skin.light` variants: the Peasant outfit under the [armour](armor-recipes.md) (#117, #301, male only).
    - `outfit.farmer`, `outfit.innkeeper` and `outfit.monk`, plus their `.skin.light` variants: the Peasant outfit with the [resident clothes](armor-recipes.md#resident-outfits-376) (#376, male only).
    - `outfit.class.warden`, `outfit.class.ranger`, `outfit.class.arcanist`, `outfit.class.necromancer`, `outfit.class.rogue`, `outfit.class.cleric` and `outfit.class.druid`, plus their `.skin.light` variants and `outfit.class.necromancer.skin.grey`: the [class starter outfits](armor-recipes.md#class-starter-outfits-379) (#379, male only).
    - `outfit.tanner` and `outfit.tanner.skin.light` (female only): the Female_Peasant outfit with the [tanner's work skirt and leather apron](armor-recipes.md#tanner-378) (#378).
  - **Attachments:**
    - `humanoid-sockets`: the [sockets descriptor](humanoid-sockets.md), with hand, stowed, archery, hair and armour sockets.
    - `humanoid-clips`: per-clip motion metadata ([Clip motion](#clip-motion)).
    - `humanoid-appearance` (`humanoid-appearance-v1`): skins, the toggleable hood (`outfit.hood`), hairstyles with their textures and tints, eyebrows that follow the hair tint, and the outfits, and (male) the `headwear` list: each piece's `entry`, `label`, `socket` and the appearance parts it `hides` while worn (`outfit.hood` and `hair`). The `face` section lists the [facial variants](#facial-variants).
      - `presets`: the male figure's [Resident presets](#resident-presets) and [Class presets](#class-presets); the female figure's `resident.tanner` ([Resident presets](#resident-presets)).
      - Male only: `facialHair`, and `ages`, `builds`, `heights`, `skinTones` and `headSkins` ([Male variety](#male-variety-380)).
      - The class outfits add `hood` (their hood garment, also listed as an `outfit.hood` part node, so hair that needs the hood off hides under it) and `classTrim` (the recolourable `class` material and its default linear colour).
- **Facial variants (#348):** see [Facial variants](#facial-variants).
- **Secondary motion chains (#391, male):** accessory joints on the long robes, skirts, aprons, capes, the long and tied hair and the long and full beards; see [Secondary motion chains](#secondary-motion-chains-391).
- **Levels of detail (#123):** every character variant has `lod1` and `lod2` variants (`lod1`/`lod2` for `default`, `<variant>.lod1`/`.lod2` otherwise). They are listed in `humanoid-appearance.levelsOfDetail` ([levels-of-detail.md](levels-of-detail.md)).
- **Clips:** they ship once, embedded in `default`. Every other character variant and level shares the same joints and rest pose, and plays them by joint name. Every clip is in place. In bundle order:
  - the UAL1/UAL2 library clips retargeted with 3d-lab (idle, walk, the run gaits, sword, shield, death, the #112 traversal clips and the #114 combat clips with their roles);
  - the authored gait clips: the jog and walk directional family `Jog_Bwd_Loop`, `Jog_Strafe_*`, `Walk_Bwd_Loop`, `Walk_Strafe_*`, then `Walk_Start`, `Walk_Stop` and `Turn_*` ([Authored gait clips](#authored-gait-clips));
  - the authored bow clips ([Authored bow clips](#authored-bow-clips));
  - the static finger grip poses `Grip_*` for held items ([Grip poses](#grip-poses-285));
  - the authored water clips ([Water clips](#water-clips-393));
  - the authored hit reactions `Hit_Upper_*` and `Hit_Shove_Spin` ([Authored hit clips](#authored-hit-clips-399));
  - the authored climb, mantle, ladder and rope clips ([Traversal clips](#traversal-clips-416));
  - the authored sword-and-shield clips of the Warden and the Redbrand ([Sword and shield clips](#sword-and-shield-clips-417));
  - the authored dagger, throw, flourish and bandage clips of the Rogue ([Dagger, throw and bandage clips](#dagger-throw-and-bandage-clips-418));
  - the upper-body bow, rapid and power clips and the crossbow clips ([Upper-body bow, rapid and power clips](#upper-body-bow-rapid-and-power-clips-419), [Crossbow clips](#crossbow-clips-419));
  - the casters' casting styles, staff and mace strikes and the war cry ([Casting, staff and mace clips](#casting-staff-and-mace-clips-420)).

  No clip uses Mixamo data (#399). Mixamo is only a motion reference, so the build needs no local input and both figures publish from CI.

  The authored clips come from one table, `RANGER_CLIP_FAMILIES` in [`src/ranger-clips.ts`](../src/ranger-clips.ts) (#425). Each row is a family (gait, bow, grips, swim, hit): its recipe, its clip names, its arguments and how its observations become the clip's `humanoid-clips` fields. The build runs each family's recipe once with `arguments.clips` (the grips with `arguments.grips`). The recipe writes one action per clip, each authored from the freshly imported rig, and the build extracts each clip by name. Adding a family is one row plus its recipe; adding a clip is one name in its row. An authored clip's `source.animationSha256` is the extracted clip, not the family's whole GLB.
- **Equipment entries:** `equipment.sword.arming`, `equipment.shield.heater`, the class set `equipment.dagger.blackened` (on `hand_r.weapon`) and `equipment.staff.bone`, `equipment.staff.gilded`, `equipment.staff.gnarled` (on `hand_r.staff`, #372), the class starter props `equipment.staff.crystal` (on `hand_r.staff`), `equipment.book.tome` (on `hand_l.shield`) and `equipment.mace.flanged` (on `hand_r.weapon`, #379) ([weapon recipes](weapon-recipes.md)) and `equipment.bow.long` (skinned to `grip` and `nock`), `equipment.arrow`, `equipment.quiver.back` and `equipment.crossbow` (on `hand_r.crossbow`, #389) ([archery](weapon-recipes.md#archery)), all parented at runtime through the sockets.
- **Hair entries:** `hair.buzzed`, `hair.simple-parted` and `hair.long` (male) or `hair.long` and `hair.buns` (female), each with the variants `hair-1` and `hair-2`, on the `head.hair` socket. The pack textures `T_Hair_1` and `T_Hair_2` are per-mesh bakes with different UV layouts, so every style carries its own pack in both variants (#336; swapping packs garbled the strands). The male `hair.long` also merges the `Hair_Buzzed` cap as its crown, because Quaternius `Hair_Long` is only a fringe and a back curtain; its `tintMaterials` are `MI_Hair_2` (strands) and `MI_Hair_1` (crown). The hair materials are opaque, like the source: the packs have no alpha. The male figure also has the hand-modelled `hair.balding`, `hair.receding`, `hair.swept` and `hair.tied` ([Male variety](#male-variety-380)), each with the one variant `hair-1`.
- **Armour entries:** `armor.soldier`, `armor.knight`, `armor.farmer`, `armor.innkeeper`, `armor.monk`, the class plates `armor.class.<id>` and `armor.redbrand` (#389) (male); `armor.tanner` (female, #378).
- **Facial hair entry (#376, male):** `facial-hair.beards`, with the hand-modelled nodes `beard.full`, `beard.short`, `beard.long`, `beard.goatee`, `beard.moustache` and `beard.walrus` (#380, [Male variety](#male-variety-380)).
- **Head skins entry (#380, male):** `skin.head`, one small quad per painted head skin, named after its material ([Male variety](#male-variety-380)).
- **Headwear entries (#336, #376, male):** `equipment.cap.ranger` (Ranger's Cap: felt crown, leather band and plume), `equipment.hat.straw` (Straw Hat: low flat crown, leather band, wide brim drooping at the edge; #376) and `equipment.helm.ironcrest` (Ironcrest Helm: iron dome, brass rim and crest fin, nasal bar) from the [headwear recipe](../adapters/blender/headwear.py). Each GLB holds one mesh node named after its piece and an identity `grip` node; the geometry is in the male rest model space around the head, so the `head.armor` socket places it. The owner approved the cap and helm on the live Ranger (2026-10-21). All three hide the hair (owner answer, 2026-10-21).

### Facial variants

Face shape, eyes, nose and mouth can each be chosen independently (#348). Each feature has a base and two authored options. Every option except the base is a glTF morph target on the head (`SuperHero_Male` or `Superhero_Female`) and on the `Eyes` and `Eyebrows` meshes:

| Feature | Options |
| --- | --- |
| `face` | `face.base`, `face.broad` (square, wider jaw and chin), `face.narrow` (slimmer cheeks, longer chin) |
| `eyes` | `eyes.base`, `eyes.large` (larger eyeballs and lids), `eyes.narrow` (almond lids, outer corners raised) |
| `nose` | `nose.base`, `nose.broad` (wide wings, flatter tip), `nose.long` (longer, prominent tip, raised bridge) |
| `mouth` | `mouth.base`, `mouth.full` (fuller, wider lips), `mouth.thin` (thinner, narrower lips) |

- **Authoring:** [`adapters/blender/face_variants.py`](../adapters/blender/face_variants.py) adds one shape key per option to the head part in Blender. Each key is a smooth displacement field placed on landmarks measured from the mesh (eye centres, nose tip, mouth line, chin), so the same recipe fits the male and the female head. It was shaped and reviewed in the live Blender. Only the morph targets come back onto the original head part, matched vertex by vertex by position (`src/face-variants.ts`), so the shipped skin, materials and attributes never pass through Blender. The targets are sparse accessors where most vertices stay still.
- **Compatibility:** no key moves the cranium above the brows, the ears and back of the head, or the neck down to the cut where the head meets the outfit; the recipe fails if one does. Hair, headwear, the hood, the head sockets and every skin and outfit therefore stay compatible. The keys of different features touch separate regions and add up. Lids slide over the eyeball's sphere, so they never cut into it. The morph is applied before skinning, so the face follows every clip like the rest of the head.
- **Descriptor:** `humanoid-appearance.face` has `nodes` (the meshes carrying the targets), `features` (each with `id`, `label`, `default` and `options`; each option's `morphs` maps target names to weights, empty for the base), `variants` (the full-detail character variants that carry the targets: `default`, `skin.light` and the outfit variants) and `unsupported`. A consumer sets the weights on `mesh.morphTargetInfluences` by `morphTargetDictionary` name.
- **Unsupported:** the `lod1`/`lod2` variants carry no morph targets and show the base face (`face.unsupported`). A consumer must refuse a non-base option on them, or use the full-detail variant. At their switch distances (15 m and more) the face is a few pixels.
- **Build:** the plain composition stays the clip-authoring rig, the armour fit target and the source of the default levels of detail. The shipped characters compose the head part with the morph targets.

### Resident presets

The named Greyhaven residents of [mmorpg#418](https://github.com/moritzbrantner/mmorpg/issues/418) get one complete look each (#376), on the male figure and its clips, except Tanner Hilda Brook, who is on the female figure (#378, in `humanoid.ranger.female`'s descriptor). A preset only combines options the descriptor already offers, and the build fails if one names an option that is missing (`validateAppearancePresets`).

| Preset | Resident | Outfit | Skin | Hair and tint | Headwear | Facial hair | Face, eyes, nose, mouth |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `resident.marshal` | Marshal Elden Greywatch | `outfit.knight` without `knight.bascinet`, Greyhaven faction colour | Light | `hair.simple-parted`, grey | none | full beard, moustache | broad, narrow, long, thin |
| `resident.guard` | the four Greyhaven Guards | `outfit.soldier` (kettle hat), Greyhaven faction colour | Dark | `hair.buzzed`, black | none | short beard | broad, base, broad, base |
| `resident.innkeeper` | Innkeeper Bram Tolliver | `outfit.innkeeper` (white apron, leather belt) | Light | `hair.buzzed`, brown | none | moustache | broad, large, broad, full |
| `resident.farmer` | Farmer Osric Mill | `outfit.farmer` (green smock, rope belt) | Dark | hidden, blond | straw hat | short beard | narrow, base, long, base |
| `resident.healer` | Brother Aldous | `outfit.monk` (brown ankle-length habit, rope belt) | Light | `hair.buzzed`, grey | none | full beard | narrow, narrow, long, thin |
| `resident.tanner` (female) | Tanner Hilda Brook | `outfit.tanner` (green-grey ankle-length work skirt, long tan leather apron, leather belt) | Light | `hair.buns`, brown | none | none | broad, base, broad, base |

- **Descriptor:** `humanoid-appearance.presets` lists each preset's `id`, `label`, `outfit`, `skin`, `hair` (absent when the headwear hides it), `tint`, `headwear`, `facialHair` (ids), `face` (one option per feature), `hiddenArmor` (plate nodes of the outfit's armour entry to leave off) and `faction` (a linear RGBA base-colour factor for the outfit's faction material, for the soldier and knight). A consumer resolves the outfit's variant for the preset's skin through `outfits[].skins`.
- **Facial hair:** `humanoid-appearance.facialHair` names the entry `facial-hair.beards` and its `options`. Each option is one node with its `socket` (`head.armor`) and `tintMaterials`; several can be worn together. Since #380 the pieces are hand-modelled ([Male variety](#male-variety-380)) and wear the hair material `MI_Hair_1`, so `facialHair.tints` are the hair tints. They ride `Head`.
- **Grey hair:** the `tint.grey` hair tint (#376) is close to white, so the hair shows the grey of its texture.
- **Greyhaven faction colour:** `RANGER_GREYHAVEN_FACTION`, a dark slate blue (linear 0.05, 0.08, 0.15).

### Class presets

One starter look per mmorpg class (#379), in its [class outfit](armor-recipes.md#class-starter-outfits-379) and with its starter props, for mmorpg's class adoption. Hooded classes have no `hair`: their hood hides it. The props are not part of the preset; mmorpg's class weapons pick them.

| Preset | Outfit | Skin | Hair and tint | Facial hair | Face, eyes, nose, mouth | Starter props |
| --- | --- | --- | --- | --- | --- | --- |
| `class.warden` | `outfit.class.warden` (knight plate with the bascinet, class-coloured tabard) | Light | `hair.simple-parted`, brown | short beard | broad, base, broad, base | sword, heater shield |
| `class.ranger` | `outfit.class.ranger` (hooded cloak, jerkin, work trousers, class sash) | Dark | hood, brown | short beard | narrow, base, long, base | longbow (stowed), quiver |
| `class.arcanist` | `outfit.class.arcanist` (long robe, bell sleeves, mantle, high collar) | Light | `hair.long`, brown | short beard, moustache | narrow, narrow, long, thin | crystal staff, tome |
| `class.necromancer` | `outfit.class.necromancer` (tattered robe and sleeves, hood, bone trim) | Grey | hood, black | none | narrow, large, long, thin | bone staff |
| `class.rogue` | `outfit.class.rogue` (cowl, half-mask, one-shoulder cape, wrapped forearms) | Dark | hood, black | none | base, narrow, base, base | two daggers |
| `class.cleric` | `outfit.class.cleric` (ivory robe, sun tabard edged in the class colour, gold spaulders) | Light | `hair.simple-parted`, brown | none | broad, base, base, full | flanged mace |
| `class.druid` | `outfit.class.druid` (moss robe, bark-and-leaf mantle, antler circlet) | Dark | `hair.long`, brown | full beard, moustache | broad, base, broad, base | gnarled staff |

### Male variety (#380)

So that not every man is "the same man with a different costume" (owner, 2026-10-25), the male figure keeps one rig and adds ages, builds, heights, skin tones and more hair and facial hair. Residents and NPCs combine them; mmorpg's seeded per-NPC look is a separate mmorpg issue.

- **Ages:** `humanoid-appearance.ages` lists `age.base` (the default; no change), `age.young`, `age.middle`, `age.old` and `age.weathered`. Each option has the morph weights it sets and the painted head `skin` it pairs with (`base`, `middle`, `aged` or `weathered`). The targets `age.*` are on the head and eyebrows (`ages.nodes`) and on the facial hair (`ages.followers`), so beards follow the jaw. Like the face keys they never move the cranium, ears or neck seam, so hair and headwear keep fitting; lids turn around the eyeball.
- **Builds:** `builds` lists `build.lean`, `build.average` (the default; no change) and `build.heavy`. The targets `build.lean` and `build.heavy` are on every mesh of every full-detail character variant (`builds.variants`) except the eyes, and on the armour, hair and facial-hair entries (`builds.entries`): a consumer sets the same weights on everything the character wears. Each vertex is scaled away from (heavy) or toward (lean) the axis of the bones it is skinned to, with a belly and seat; items take the weights of the nearest body vertices, so outer layers keep their clearance. Hanging garments (tabards, robes) grow round the body's vertical axis from the belly, so their hems hang straight.
- **Heights:** `heights` (0.91–1.09, default 1) is a uniform scale of the character root; attached items follow.
- **Skin tones:** `skinTones` lists six linear base-colour factors (`tone.fair` … `tone.deep`) for the Light skin's skin materials (`MI_Superhero_Male`, `MI_Regular_Male`).
- **Head skins:** `headSkins` names the entry `skin.head`: per base skin (`skin.dark`, `skin.light`), age skin and stubble shade, a material (`<skin>.<age>[.stubble.<shade>]`) whose base-colour and normal textures a consumer puts on the head material (`MI_Superhero_Male`). The aged and weathered skins are painted (forehead and frown lines, crow's feet, folds, spots; sun, ruddiness, squint lines and a scar), the middle-aged skin is a light version of the aged one, and every line is also cut into the normal map. Stubble is part of the skin texture, in a dark shade (black and brown hair) and a light one (blond and grey; `headSkins.stubbleShades`). Tones multiply the painted Light skins as they do the plain one.
- **Hair and facial hair:** hand-modelled in the Marshal's chunky-lock style ([`hair_beards.py`](../adapters/blender/hair_beards.py)): ridged locks on `T_Hair_1`, edges that thin into the skin and pointed clumps where hair hangs free. The hairstyles `hair.balding` (horseshoe with a clean edge), `hair.receding`, `hair.swept` and `hair.tied` (gathered at the nape by a leather tie that keeps its colour) ride `head.hair`; the beards and moustaches ride `head.armor` and replace the #376 kit shells under their names, so the presets keep naming `beard.full`, `beard.short` and `beard.moustache`.
- **Authoring:** [`male_variety.py`](../adapters/blender/male_variety.py) authors the keys in Blender on a copy of each outfit's character variant (with its plates) and of each hair entry; only the morph targets come back onto the shipped assets, after the face targets (`transferMorphTargets`, matched by position within 3 mm, because the composed characters re-pose a few neck vertices by up to 2 mm). [`skin_overlays.py`](../adapters/blender/skin_overlays.py) paints the head skins in the head's UV layout from the rest positions of its texels. The shape was reviewed in the live Blender; the review sheets come from `examples/male-variety/review.py`, which composes eight men from the built bundle.
- **Unsupported:** the levels of detail carry no age or build targets (`ages.unsupported`, `builds.unsupported`); the head skins and tones apply to them.

### Secondary motion chains (#391)

Short accessory-bone chains on the male figure's long hair, beards and loose garments, for bounded, presentation-only secondary motion ([mmorpg#498](https://github.com/moenarch-games/mmorpg/issues/498)). A consumer springs the joints on top of the clips; there is no cloth engine and no new clip tracks. [`src/humanoid-secondary.ts`](../src/humanoid-secondary.ts) adds them after the age and build keys (`applySecondaryChains`).

- **Rest is unchanged:** each chain hangs from a `parent` joint and takes over part of that joint's skin weight only. At rest a chain joint moves rigidly with its parent, so a chain left in its bind pose deforms the mesh exactly as before, in every clip. Other joints keep their weights, so a robe's hem still follows the striding thighs and only the pelvis share swings.
- **Ramp:** the share a vertex hands over grows from 0 at the chain's first joint to all of it a few centimetres lower, so the waist, the shoulders, the scalp and the jaw never move. Side by side, chains blend by angle round the body (cos²), so a skirt does not tear between its front and side panels.
- **Joints:** named `<prefix>_01` … from the top. At rest each joint has the character's orientation (identity world rotation) and sits on the garment surface at its height; the chain runs straight down. Short garments get fewer joints (at least 12 cm apart).

| Where | Chains (parent → joints) |
| --- | --- |
| Long robes and coats: `outfit.monk`, `outfit.class.arcanist`, `outfit.class.necromancer`, `outfit.class.cleric` (with its tabard), `outfit.class.druid`, `outfit.redbrand` | `pelvis` → `skirt_f_01..03`, `skirt_b_01..03`, `skirt_l_01..02`, `skirt_r_01..02` |
| Shorter skirts: `outfit.farmer` (smock), `outfit.soldier` (gambeson) | the same, with fewer joints |
| Tabards: `outfit.knight`, `outfit.class.warden` | `pelvis` → `skirt_f_*`, `skirt_b_*` |
| Apron: `outfit.innkeeper` | `pelvis` → `apron_01..02` (front only) |
| Capes and mantles: `outfit.class.ranger` (cloak), `outfit.class.rogue` (cape), `outfit.class.arcanist`, `outfit.class.necromancer`, `outfit.class.druid` (mantles) | `spine_03` → `cape_01..03` (back only) |
| Hanging strap: `outfit.redbrand` (scarf end) | `spine_03` → `scarf_01` |
| `hair.long` (both textures) | `hair_root` → `hair_back_01..03` (the back curtain; the crown and fringe stay) |
| `hair.tied` | `hair_root` → `hair_tail_01..02` (below the tie) |
| `facial-hair.beards`: `beard.long`, `beard.full` | `beard_root` → `beard_01..02` (below the chin) |

- **Items:** the hair and facial-hair entries were static. The chained ones now have a skin whose root joint (`hair_root`, `beard_root`) is the item's scene origin with an identity transform, so it rides its socket exactly as before. Every other vertex of the item (the scalp, the jaw, the other beards in the entry) is weighted fully to the root.
- **Descriptor:** `humanoid-appearance` lists the chains by data, not by name: `outfits[].secondary`, `hair[].secondary` and `facialHair.options[].secondary`. Each chain has `id` (`skirt.front`, `skirt.back`, `skirt.left`, `skirt.right`, `apron`, `cape`, `scarf`, `hair.back`, `hair.tail`, `beard`), `kind` (`skirt`, `apron`, `cape`, `strap`, `hair`, `beard`), `parent`, the ordered `joints`, the mesh `nodes` it moves and a suggested `swingLimitDegrees` per joint (skirts 20, apron 15, capes 25, strap 30, hair back 15, tail 25, beard 12). Every skin variant of an outfit carries its chains.
- **Unsupported:** the levels of detail carry no chains (`secondary.unsupported`); at their switch distances a consumer fades the motion out anyway. The female figure has none yet.

### Authored gait clips

[`adapters/blender/gait_clips.py`](../adapters/blender/gait_clips.py) authors these clips in Blender on the animated Ranger (#112, #399, owner answers 2026-10-18 and 2026-10-29, Atlas 6.1.7). No Mixamo data is used. The walk and jog clips form one matched family, so a consumer (mmorpg#517, mmorpg#538) can blend walk and jog by angle and by speed. They share the stance, the left foot plants at phase 0 in the backward loops, and the strafes share their swing phases and foot spans.

| Clip | Length | Motion | `humanoid-clips` |
| --- | --- | --- | --- |
| `Jog_Bwd_Loop` | 0.93 s (the jog's) | UAL1 `Jog_Fwd_Loop` played backwards, with the lowest spine joint pitched 18° back | `groundSpeedMetersPerSecond` |
| `Walk_Bwd_Loop` | 1.33 s (the walk's) | UAL1 `Walk_Loop` played backwards, pitched 2° back. The walk leans 5.5° forward and the jog 22°, so both backward loops end near the idle's lean | `groundSpeedMetersPerSecond` |
| `Jog_Strafe_Left_Loop` / `_Right_` | 0.5 s | side-step at 1.4 m/s | `sourceRootSpeedMetersPerSecond` 1.4 |
| `Walk_Strafe_Left_Loop` / `_Right_` | 0.8 s | the same side-step at 0.875 m/s: the same foot spans at a slower cadence, with lower lifts (6 cm and 4.5 cm), half the bob and a 3° roll | `sourceRootSpeedMetersPerSecond` 0.875 |
| `Walk_Start` | 0.8 s | the first `Idle_Loop` pose blended into `Walk_Loop`, ending exactly at its phase 0 | the travel at the rising walk speed |
| `Walk_Stop` | 0.8 s | `Walk_Loop` from phase 0 blended into the first `Idle_Loop` pose | the travel at the falling walk speed |
| `Turn_Left` / `Turn_Right` | 0.93 s | a 90° turn on the spot in two steps, inside foot first; the head and chest lead by up to 14° | the body ends rotated 90° (owner answer #112 Q2) |

In the strafes, each foot follows an explicit in-place trajectory. A planted foot slides against the travel direction at the reference speed. The lead foot swings out (phases 0.6 to 1.0, so it plants at phase 0). The trail foot swings in (0.3 to 0.55) and lands 12 cm short of the lead foot, so the legs never cross. A two-bone solve keeps the knees forward and the feet level, and the pelvis drops as far as the spread legs need. The upper body keeps the source loop's mean posture, with the swing damped to 45 %.

The travelling clips report the travel that the in-place clip stands for as `sourceRootDisplacement`, and its speed as `sourceRootSpeedMetersPerSecond`.

### Authored hit clips (#399)

[`adapters/blender/hit_clips.py`](../adapters/blender/hit_clips.py) authors the hit reactions from the first `Idle_Loop` pose with explicit joint turns. No Mixamo data is used. They follow the water clips in bundle order.

- **`Hit_Upper_Front` / `_Back` / `_Left` / `_Right`** (roles `hit.upper.front`, `hit.upper.back`, `hit.upper.left` and `hit.upper.right`): 0.33 s one-shots. They key only the rotations of the `spine_01` subtree, so the pelvis and legs keep the walk or run underneath. The side names where the hit lands. Within 0.07 s the torso snaps away from it: back for a front hit, forward for a back hit, and sideways and twisted for a side hit. The head lags and the arms are thrown the other way, then everything eases back to the idle pose.
- **`Hit_Shove_Spin`** (role `hit.shove`): 1.8 s, full body. The shove jolts the torso back and spins the figure once round to its right on the spot, in four pivot steps, with the arms flung out and the chest lagging. It then crouches 6 cm to catch its balance and recovers into the idle pose, facing the way it started.

### Authored bow clips

[`adapters/blender/bow_clips.py`](../adapters/blender/bow_clips.py) authors the bow clips in Blender on the animated Ranger (#277, owner answer 2026-10-18: original keyframes, Mixamo only as reference). They follow the gait clips in bundle order. No Mixamo data is used.

| Clip | Role | Length | Motion |
| --- | --- | --- | --- |
| `Bow_Aim_Loop` | `bow.aim` | 2.5 s loop | Bow raised at the target, arrow nocked, the string set (partly drawn). |
| `Bow_Draw` | `bow.draw` | 0.7 s | From the set string to full draw; the chest turns side-on. |
| `Bow_Hold_Loop` | `bow.hold` | 2.5 s loop | Held at full draw, the nock at the right cheek. |
| `Bow_Release` | `bow.release` | 0.47 s | The string hand lets go on the second frame, flies back and opens; the bow arm drops a little. |
| `Bow_Recovery` | `bow.recovery` | 1.1 s | The string hand reaches the back quiver, then nocks and sets the next arrow. |
| `Bow_Cancel` | `bow.cancel` | 0.6 s | From full draw, the string is let down to the set pose. |

The clips form one loop: aim → draw → hold → release → recovery → aim, with cancel from hold back to aim.

- **Stance:** the pelvis turns 40° and each spine joint up to 15° more (5° at the set pose), so the left shoulder points at the target and the neck and head turn back to face it. The feet spread and turn with the pelvis.
- **Arms:** the bow sits in the left hand through `hand_l.bow`, and the arrow's nock in the right through `hand_r.arrow`. A two-bone solve places each arm; the elbow hinges about the joint's local X axis, and half of the wrist twist moves into the forearm.
- **Breathing:** the loops keep the breathing of the CC0 UAL1 `Idle_Loop`; the one-shots use its first frame.
- **Fingers:** they curl toward the palm: a fist on the bow's grip, a three-finger hook on the string, and an open hand after the release.

Each clip's `humanoid-clips` entry has a `bow` object:

- `sampleRate` (30) and `drawMeters`, one value per frame: how far the arrow socket sits behind the braced string along the bow's draw axis, 0 when the hand is off the string.
  - A consumer drives the bow's `nock` joint by this distance along `BOW_DRAW_CONTRACT.drawAxis`, or places `nock` at the `hand_r.arrow` socket.
  - The set pose is about 0.27 m, and full draw is 0.48 m: the nock 0.66 m behind the grip.
- `releaseSeconds` (`Bow_Release`): the string leaves the hand, the moment to launch the arrow.
- `arrowDrawnSeconds` and `nockedSeconds` (`Bow_Recovery`): the hand at the quiver, and the next arrow on the string.

`Bow_Release` also has the usual `contact` on `hand_r` (the fastest sample, kept as it is: consumers time against it).

The cycle is full body: the pelvis turns and the feet spread. For shots on the move, play the upper-body set (#419, [below](#upper-body-bow-rapid-and-power-clips-419)) over the gait instead.

### Grip poses (#285)

The retargeted clips leave the fingers at their open rest pose, so a held item would lie across an open hand. [`adapters/blender/grip_poses.py`](../adapters/blender/grip_poses.py) authors one static grip pose per hand socket and held role in Blender (`RANGER_GRIPS`). Each clip keys only the 15 finger and thumb rotations (`*_01`, `*_02`, `*_03`) of one hand, and the poses follow the bow clips in bundle order:

| Clip | Socket | Role | Hand |
| --- | --- | --- | --- |
| `Grip_Weapon_R`, `Grip_Weapon_L` | `hand_r.weapon`, `hand_l.weapon` | `one-hand-weapon` | A fist round a 14.5 mm grip (sword, dagger, mace). |
| `Grip_Shield_L`, `Grip_Shield_R` | `hand_l.shield`, `hand_r.shield` | `shield` | A fist round the shield's 12 mm hand handle. |
| `Grip_Book_L`, `Grip_Book_R` | `hand_l.shield`, `hand_r.shield` | `book` | A relaxed hand; the tome rests on the back of the hand. |
| `Grip_Staff_R`, `Grip_Staff_L` | `hand_r.staff`, `hand_l.staff` | `staff` | A fist round a 19 mm shaft. |
| `Grip_Bow_L` | `hand_l.bow` | `bow` | A fist round the 22 mm riser. |
| `Grip_Crossbow_R`, `Grip_Crossbow_L` | `hand_r.crossbow`, `hand_l.crossbow` | `crossbow` | A fist round the stock's 20 mm wrist; the handle is the crossbow's grip-frame Z axis (#389). |
| `Grip_Crank_L` | `hand_l.weapon` | `crank` | A fist round the crossbow crank's 12 mm handle, along the grip frame's Y (#419, `Crossbow_Reload`). |
| `Grip_Knife_Pinch_R` | `hand_r.weapon` | `throwing-knife` | A pinch (#418): the index bends round the blade, the thumb closes onto it and the other fingers fold into the palm (fixed curls, `PINCH`). |
| `Grip_Flask_R` | `hand_r.weapon` | `flask` | The fingers and thumb close round a 40 mm-radius ball centred on the grip point (a flask or bomb, #418). |

- **Wrap:** each finger curls toward the palm, joint by joint from the knuckle, until its segment touches the handle (the radius plus the finger's half thickness from the handle's axis) or reaches the joint's limit (90°, 105°, 80°). The thumb then swings over the wrapped index finger and bends its tip round the handle. The handle is the item's grip-frame Y axis through the socket (Z for the crossbow).
- **Metadata:** each `humanoid-clips` entry has `role: "grip"`, `loop: true` and `grip: { socket, role }`.
- **Consumer:** while a hand socket holds an item, play the grip whose `grip.socket` and `grip.role` match on top of the body clip. The grip replaces that hand's finger rotations: drop them from the body clip, or give the grip the full weight on those joints. The bow clips already carry their own finger curl (a fist on the grip and a hook on the string), so they need no grip.
- **Shield handle:** in the hand sockets the heater is held with the forearm across the board (`examples/weapons/derive-sockets.ts`), so the shield's hand handle runs along its Y axis, across the palm, and the forearm strap sits toward +X round the left forearm (#285). Before #285 the handle ran along the fingers, so a fist could not close round it.

### Water clips (#393)

[`adapters/blender/swim_clips.py`](../adapters/blender/swim_clips.py) authors the water locomotion for mmorpg#499 (Atlas 6.6.41) in Blender on the animated Ranger, from explicit limb trajectories. Mixamo was only watched as reference. The clips are in place and follow the grip poses in bundle order. A consumer plays them by name.

| Clip | Length | Motion |
| --- | --- | --- |
| `Wade_Fwd_Loop` | 1.5 s loop | Waist-deep walk at 0.75 m/s: the swing foot lifts 20 cm with the knee forward, the pelvis sits 5 cm lower, the torso leans 9° forward, and the forearms are held up and forward. `humanoid-clips` records its `groundSpeedMetersPerSecond` like the land gaits. |
| `Swim_Idle_Loop` | 1.6 s loop | Treading water upright: eggbeater legs (thighs about 48° forward, knees circling out of phase), the forearms sculling in front of the chest, and the head up. |
| `Swim_Fwd_Loop` | 1.3 s loop | Front crawl. Each arm pulls under the body and recovers over the back with a high elbow, the torso rolls 28° with the pull, and there are three flutter kicks per cycle. Its entry has `strokeSpeedMetersPerSecond: 1.8`. |
| `Swim_Down_Loop` | 1.6 s loop | Breaststroke with a long glide. |
| `Swim_Up_Loop` | 1.15 s loop | A quicker breaststroke whose pull sweeps the hands down to the hips. |
| `Swim_Enter` | 0.8 s | From the first `Idle_Loop` pose, the arms rise to the surface and the legs draw up, ending in the first `Swim_Idle_Loop` pose. |
| `Swim_Exit` | 1.0 s | From the first `Swim_Idle_Loop` pose, one leg reaches down and the arms press the water, ending in the first `Idle_Loop` pose. |

The strokes are authored **upright**, with the body along +Y and facing +Z. Overhead is "ahead" in the swim, and in front of the chest is the pool floor. The consumer pitches the whole body (`crates/mmorpg-presentation/src/units/swim.rs`), so an authored lean would be applied twice.

### Traversal clips (#416)

[`adapters/blender/traversal_clips.py`](../adapters/blender/traversal_clips.py) authors the climbing, mantling, ladder and rope clips for mmorpg#490 (`ActionId::Climb` / `Mantle`) and mmorpg#500 (Atlas 6.6.43) in Blender on the animated Ranger. Hand and foot targets on the face, ledge, rung or rope are solved with two-bone IK each frame. Mixamo and the CC0 UAL2 `ClimbUp_1m_RM` were only watched as reference. The clips are in place, follow the hit reactions in bundle order, and key their own fingers (a crimp on holds and edges, a fist round rungs and the rope), so no `Grip_*` applies while climbing. The surface is in front of the body (+Z).

| Clip | Length | Motion | `humanoid-clips` |
| --- | --- | --- | --- |
| `Climb_Idle_Loop` | 1.0 s loop | Four holds, 30 cm from the pelvis to the face; breathing, and the right hand re-grips once. | |
| `Climb_Up_Loop`, `Climb_Down_Loop` | 1.0 s loops | Hand over hand, diagonal limbs together (the feet 0.15 cycle after the hands), 54 cm per move. Down is Up played backwards. | `climbSpeedMetersPerSecond: 0.9` |
| `Climb_Left_Loop`, `Climb_Right_Loop` | 1.0 s loops | Shuffling sideways, the hand on the travelling side first, then the feet. | `climbSpeedMetersPerSecond: 0.75` |
| `Climb_TopOut` | 1.0 s | From the first `Climb_Idle_Loop` pose: pull on the edge just above the high hold, press, right knee over, stand on top; ends in the first `Idle_Loop` pose. | `edgeHeightMeters`, `travelSamples` |
| `Climb_LetGo` | 0.4 s | The hands open, arms and legs push away from the face, the body leans back. | |
| `Mantle_Low` | 0.6 s | A 0.7 m ledge: hands on the edge, step up, stand. | `ledgeHeightMeters: 0.7`, `travelSamples` |
| `Mantle_Mid` | 0.9 s | A 1.3 m ledge: chest-high pull-up, press, knee over, stand. | `ledgeHeightMeters: 1.3`, `travelSamples` |
| `Mantle_High` | 1.3 s | A 1.9 m ledge: reach and hop to the edge, hang with the feet on the face, pull, press, stand. | `ledgeHeightMeters: 1.9`, `travelSamples` |
| `Ladder_Idle_Loop`, `Ladder_Up_Loop`, `Ladder_Down_Loop` | 1.0 s loops | Rungs every 0.30 m, 36 cm in front of the pelvis; each hand and foot moves two rungs a step. | `rungSpacingMeters: 0.3`, `climbSpeedMetersPerSecond: 0.6` (Up, Down) |
| `Rope_Idle_Loop`, `Rope_Up_Loop`, `Rope_Down_Loop` | 1.0 s loops | A vertical rope 20 cm in front of the pelvis: hand over hand, the feet clamp the rope and re-clamp higher once a cycle. | `climbSpeedMetersPerSecond: 0.6` (Up, Down) |

- **Travel:** every clip is in place. The loops' travel is their `climbSpeedMetersPerSecond`: scale the playback rate by the zone's speed over it. The mantles and the top-out stand for the rise and forward step in `sourceRootDisplacement` (`y` the ledge or edge height, `z` the step onto the top), and `travelSamples` (`sampleRate` 30, one glTF translation per frame) is the root path the body was authored against: rising with the pull, then stepping forward. A consumer moving its capsule on another path still gets the hands on the edge as long as the capsule is near that path; the contacts tell it where.
- **Contacts:** `contacts` lists each hand and foot plant: `limb` (`hand_l`, `hand_r`, `foot_l`, `foot_r`), `startSeconds`, `endSeconds` (past the clip's end when a loop's plant wraps) and `position`, the joint's model-space position (glTF axes, metres) when the plant starts. For bounded hand and foot placement (mmorpg#500), offset the limb by the difference between the real hold or edge and that position.
- **Chain pose:** `secondaryPose` is `{ sampleRate: 30, joints }`: for `skirt_f_01`, `skirt_b_01`, `skirt_l_01`, `skirt_r_01` and `cape_01`, one local rotation per frame (glTF `[x, y, z, w]`, under `pelvis`, or `spine_03` for the cape), which the consumer blends under its spring (mmorpg#498) when the worn outfit has that chain. The front and side panels turn forward by 45% of the thighs' forward lift (front at most 40°, sides 40°), the back panel back by a thigh's backward reach (at most 20°), and the cape hangs but stays off the back. The joints below the first keep their rest. No clip keys the chain joints themselves: the shared clips have no chain nodes.
- **Review:** reviewed in the live Blender on the male `outfit.monk` and `outfit.class.arcanist` with their #391 chains driven by `secondaryPose`. On the highest climbing step the shin shows through the side of the robe, and the robe meets the face, ladder and rope where the knees come up to it. The female tanner's skirt has no chains and was not reviewed.

### Sword and shield clips (#417)

[`adapters/blender/sword_clips.py`](../adapters/blender/sword_clips.py) authors the mmorpg Warden's sword-and-shield clips and the Redbrand specials in Blender on the animated Ranger. Each key names the sword grip (its position, the blade direction and the leading edge) on the `hand_r.weapon` socket and the shield grip (its position, face and top) on `hand_l.shield`; two-bone arm IK puts the hands there, and the chest turn is spread over `spine_01`–`03`. Between keys the grips follow a Catmull-Rom curve that starts and ends at rest. Mixamo was only watched as reference. The clips are in place, follow the traversal clips in bundle order and key no fingers: the consumer keeps `Grip_Weapon_R` and `Grip_Shield_L` over them. The strikes start and end in the guard's ready pose: the first `Idle_Shield_Loop` pose with the sword at the right hip, blade forward and up.

| Clip | Length | Layer | Motion | `humanoid-clips` |
| --- | --- | --- | --- | --- |
| `Sword_Slash_{High,Mid,Low}_{L,C,R}` | 0.6 s | `spine_01` | Wind-up by 0.18 s, contact at 0.3 s, follow-through by 0.41 s. `L` is a forehand diagonal ending on the figure's left, `R` a backhand ending on its right; `C` is an overhead blow (high), a thrust (mid) or a low sweep (low). The row sets the height the blade crosses: head, chest or thigh. The shield opens out to the left while the sword passes. | `role: sword.directed`, `aim: { height, side }` (`high`/`mid`/`low`, `left`/`centre`/`right`), `contact` (`hand_r`) |
| `Sword_Heroic` | 0.8 s | `spine_01` | A slow wind-up high over the right shoulder, leaning back, then a hard diagonal chop at 0.53 s. | `role: sword.heroic`, `contact` |
| `Sword_Cleave` | 0.9 s | full | A flat sweep from the right-back to the left; the torso turns 120° (a third in the pelvis, feet planted) and dips 7 cm. | `role: sword.cleave`, `contact` |
| `Charge_Run_Loop` | 0.6 s loop | full | The `Sprint_Loop` legs (its cycle in 0.6 s), the chest leaning 16° forward, the shield ahead of the chest, the sword held back and up. | `role: charge.run` |
| `Charge_Impact` | 0.5 s | full | From the charge's first pose: the shield and left shoulder drive forward at 0.1 s while the legs brake into the guard stance, then back to the ready pose. | `role: charge.impact`, `contact` (`hand_l`) |
| `Shield_Guard_{High,Mid,Low}_Loop` | 2.0 s loops | `spine_01` | `Idle_Shield_Loop` resampled to 2 s with the shield held in the lane: over the face and brow, before the chest, or low before the thighs with the chest bent 16°. | `role: shield.guard-high` / `-mid` / `-low` |
| `Stun_Loop` | 1.5 s loop | full | From `Idle_Loop`: knees soft, the pelvis sways in a figure of eight, the chest hangs and rolls, the head lolls behind it, the arms hang. | `role: stun` |
| `Respawn_Rise` | 1.5 s | full | From kneeling on the right knee with the head bowed to the first `Idle_Loop` pose; the rise runs from 0.33 s to 1.32 s. | `role: respawn` |
| `Sword_Whirl` | 1.2 s | full | Telegraphed: a crouch winding 42° to the left (to 0.41 s), one turn round to the right with the blade held out (0.46–0.94 s, the feet pivoting in two steps each), then the guard. Ends facing the way it started. | `role: sword.whirl`, `contact` |
| `Sword_Overhead_Smash` | 1.4 s | full | The arming sword in the right hand, the left hand joining on the hilt; a slow two-handed raise high overhead (to 0.7 s) with a held, trembling top, the slam to the ground in front by 0.98 s with the knees bent 18 cm, a slow recovery. | `role: sword.overhead-smash`, `contact` |

- **Layer:** the `spine_01` clips keep only the rotations of `spine_01` and its descendants, so a consumer plays them over walking or running legs (mmorpg `UPPER_BODY_ROOT`).
- **Contact:** `contact` is the presentation landmark the build records for every strike (the moment the joint moves fastest). It never times gameplay: the zone keeps owning windup, active and recovery.
- **Review:** reviewed in the live Blender on the male `outfit.class.warden` and `outfit.knight` with the arming sword and heater shield on their sockets. The tabard chains are not posed by these clips (no `secondaryPose`): in `Respawn_Rise`'s kneel the knight's front panel meets the raised thigh.

### Dagger, throw and bandage clips (#418)

[`adapters/blender/dagger_clips.py`](../adapters/blender/dagger_clips.py) authors the mmorpg Rogue's kit in Blender on the animated Ranger. The Rogue fights with two daggers, the main one on `hand_r.weapon` and the off-hand one on `hand_l.weapon`. Each key names a hand's grip position, blade direction (the item's +Y) and edge (+X); two-bone arm IK puts the hands there and the chest turn is spread over `spine_01`–`03`. Between keys the grips follow a Catmull-Rom curve that starts and ends in the ready stance; a cut turns its edge along the hand's motion. Mixamo was only watched as reference. Every clip starts from the first `Idle_Loop` pose, keeps only the `spine_01` subtree (played over standing, walking or running legs, mmorpg `UPPER_BODY_ROOT`), keys no fingers and follows the sword clips in bundle order. The strikes start and end in the stance's first pose.

| Clip | Length | Motion | `humanoid-clips` |
| --- | --- | --- | --- |
| `Dagger_Idle_Loop` | 2.0 s loop | The low twin-dagger stance: the chest bent 10°, the main dagger low before the right hip, the off-hand dagger before the left of the chest, both pointing forward and up. The hands ride the `Idle_Loop` breathing; the chest sways ±3°. | `role: dagger.idle` |
| `Dagger_Stab_R` | 0.4 s | The main dagger cocks back by 0.12 s and thrusts straight ahead at chest height (0.21 s), the chest turning into it. | `role: dagger.stab`, `contact` (`hand_r`) |
| `Dagger_Slash_L` | 0.4 s | The off-hand dagger winds up high on the left and cuts down across to the right, past the chest at 0.21 s. With `Dagger_Stab_R` it is the alternating auto-attack. | `role: dagger.slash`, `contact` (`hand_l`) |
| `Dagger_Sinister` | 0.6 s | A double stab: right at 0.19 s, left at 0.38 s. | `role: dagger.sinister`, `contact` (`hand_r`) |
| `Dagger_Poison` | 0.8 s | The off hand holds up the vial (its dagger turned up out of the way); the main blade lies across it and is drawn back to the right (0.12–0.26 s), winds up and slashes across (0.54 s). | `role: dagger.poison`, `contact` (`hand_r`) |
| `Dagger_Gouge` | 0.5 s | The main dagger turned so the pommel leads, a jab at face height (0.25 s). | `role: dagger.gouge`, `contact` (`hand_r`) |
| `Flourish_Haste` | 0.7 s | Both blades come up before the chest; their tips circle twice in opposite senses (0.1–0.49 s), then they cross and return. Also the Ranger's Rapid Fire buff. | `role: flourish.haste` |
| `Throw_Knife` | 0.5 s | The right hand reaches the belt (`drawSeconds` 0.09), cocks out to the right and back, and flicks flat forward sidearm, letting go at `releaseSeconds` 0.28; the off hand points the way. | `role: throw.knife`, `contact` (`hand_r`), `drawSeconds`, `releaseSeconds` |
| `Throw_Lob` | 0.8 s | The right hand reaches the belt (0.16 s), swings underarm back past the hip and up, and lets go before the face at 0.5 s; the off hand points the way. | `role: throw.lob`, `contact` (`hand_r`), `drawSeconds`, `releaseSeconds` |
| `Bandage_Self` | 1.5 s | The left forearm comes up across the body; the right hand wraps round it three times, creeping from the wrist up the forearm (0.3–1.17 s), and tugs the end out to the right. The chest bends 16° to look at it. | `role: bandage.self` |

- **Items:** the clips key only the hands; what each hand holds is the consumer's choice. For a throw, at `drawSeconds` the hand's grip frame is the `belt.throwable` socket's frame: sheathe the main dagger at `hip_r.stowed` and move the knife (`Grip_Knife_Pinch_R`) or the flask or bomb (`Grip_Flask_R`) from `belt.throwable` into `hand_r.weapon`. At `releaseSeconds` the projectile leaves the hand; the dagger comes back to the hand when the clip ends. For `Bandage_Self`, sheathe both daggers (`hip_l.stowed`, `hip_r.stowed`) or keep them: the right hand's grip frame circles the forearm with its blade along it.
- **Contact:** a presentation landmark only, as for the sword clips, but at the authored strike (the times above) or, for a throw, at `releaseSeconds`, not at the fastest sample: a dagger hand turns fastest in its wind-up.
- **Review:** reviewed in the live Blender on the male `outfit.class.rogue` with the blackened dagger on `hand_r.weapon` and `hand_l.weapon` (no grip poses applied). The cape chain is not posed by these clips. The pinch and flask grips were not reviewed on an item.

### Upper-body bow, rapid and power clips (#419)

[`adapters/blender/bow_clips.py`](../adapters/blender/bow_clips.py) also authors the ranged kit for shots on the move (mmorpg#517), Rapid Fire and the Aimed or Piercing Shot (`RANGER_BOW_UPPER_CLIPS`, the `bow-upper` family). They follow the dagger clips in bundle order, so the clips before them keep their places. Every one keeps only the `spine_01` subtree (mmorpg `UPPER_BODY_ROOT`): the pelvis and legs are left in the idle and come from the gait the consumer plays under them.

| Clip | Length | Motion | `humanoid-clips` |
| --- | --- | --- | --- |
| `Bow_Aim_Upper_Loop`, `Bow_Draw_Upper`, `Bow_Hold_Upper_Loop`, `Bow_Release_Upper`, `Bow_Recovery_Upper`, `Bow_Cancel_Upper` | as the cycle | The cycle re-authored with the hips square: the chest turns about 70° over still hips (60% of the cycle's 40° pelvis turn moves into `spine_01`-`03`, on top of the spine's own 5-15° per joint). The set string is shorter than the cycle's (about 0.21 m), full draw about the same (0.46 m). | `role: bow.<cycle role>.upper`, `bow`; `Bow_Release_Upper` has `contact` |
| `Bow_Rapid_Release` | 0.33 s | From the set string: full draw by frame 3, loosed on frame 4 (`releaseSeconds` 0.13); the hand flies back toward the quiver, takes the next arrow (`arrowDrawnSeconds` 0.23) and is set on the string again at the end (`nockedSeconds`), so it plays back to back. | `role: bow.rapid-release`, `bow`, `contact` |
| `Bow_Power_Draw` | 1.0 s | A slow draw from the set string past full draw: the nock 5 cm further back in the second half, the chest turning 30% further. It ends held; loose with `Bow_Release_Upper` (the draw jumps 5 cm back to full draw on its first frame). | `role: bow.power-draw`, `bow` |

- **Draw:** each entry has the cycle's `bow` object (`sampleRate`, `drawMeters` per frame, and `releaseSeconds`, `arrowDrawnSeconds`, `nockedSeconds` where the clip has them); drive the nock from it exactly as for the cycle (mmorpg#563).
- **Contact:** at `releaseSeconds` (the cycle's `Bow_Release` keeps its fastest-sample contact).
- **Review:** reviewed in the live Blender on the male `outfit.class.ranger` with the long bow on `hand_l.bow`, the arrow on `hand_r.arrow` and the quiver on `back.quiver` (the bow's `nock` was not driven in review). The cloak and hood chains are not posed by these clips.

### Crossbow clips (#419)

[`adapters/blender/crossbow_clips.py`](../adapters/blender/crossbow_clips.py) authors the Redbrand Crossbowman's kit in Blender on the animated Ranger (`RANGER_CROSSBOW_CLIPS`, the `crossbow` family, after the upper-body bow clips in bundle order). Each key names the crossbow's frame: two-bone arm IK puts the right hand's `hand_r.crossbow` grip on the stock's wrist and the left hand's `hand_l.crossbow` grip on the fore-stock, 20 cm ahead of the wrist and just under it. Every clip starts from the first `Idle_Loop` pose, keeps only the `spine_01` subtree and keys no fingers. Mixamo was only watched as reference.

| Clip | Length | Motion | `humanoid-clips` |
| --- | --- | --- | --- |
| `Crossbow_Idle_Loop` | 2.0 s loop | Carried low in both hands across the body, the wrist before the right hip and the prod forward and to the left; the hands ride the `Idle_Loop` breathing and the chest sways ±2°. | `role: crossbow.idle` |
| `Crossbow_Aim_Loop` | 2.0 s loop | The butt in the right shoulder, just in front of the collarbone, the groove 11 cm under the right eye and level; the chest turns 15° to bring the right shoulder back and the head leans onto the stock. Breathing as the idle. | `role: crossbow.aim` |
| `Crossbow_Fire` | 0.4 s | From the aim: the bolt looses on frame 2 (`releaseSeconds` 0.067); the muzzle kicks up 7° about the butt and the stock pushes back 3.5 cm by 0.1 s, then settles back to the aim. | `role: crossbow.fire`, `crossbow`, `contact` (`hand_r`) |
| `Crossbow_Reload` | 1.6 s | From and back to the aim: the crossbow comes down muzzle-first, butt to the belly (0.26 s); the left hand takes the crank on the left of the stock and winds it twice (0.32-0.85 s, `spannedSeconds`); the crossbow comes level at the waist, where the left hand holds it alone (`leftHandSeconds` 0.96-1.44 s) while the right hand draws a bolt over the right shoulder from `back.quiver` (`boltDrawnSeconds` 1.15) and lays it in the groove (`reloadedSeconds` 1.34), then retakes the wrist; up to the shoulder by 1.6 s. | `role: crossbow.reload`, `crossbow` |

- **Items:** the crossbow (`equipment.crossbow`) rides `hand_r.crossbow` with `Grip_Crossbow_R`, and the left hand plays `Grip_Crossbow_L`. On the reload the left hand plays `Grip_Crank_L` over `crankSeconds` (the crank is the crossbow's own; no item goes on `hand_l.weapon`). Over `leftHandSeconds` the crossbow rides the left hand: at the start, reparent it to `hand_l` keeping its world transform, and at the end put it back on `hand_r.crossbow` (the right hand's grip is on the wrist again there). The bolt rides `hand_r.arrow` (nock at the origin, shaft along +Z) from `boltDrawnSeconds` to `reloadedSeconds`, then stays in the groove until the next `releaseSeconds`. The crossbow stays spanned in its mesh throughout.
- **`crossbow` object:** `releaseSeconds` (fire), and `crankSeconds` (the winding, start and end), `spannedSeconds`, `leftHandSeconds`, `boltDrawnSeconds`, `reloadedSeconds` (reload).
- **Contact:** at `releaseSeconds`.
- **Socket change:** the crossbow sockets turned 180° about the stock (`docs/humanoid-sockets.md`): the top of the stock now faces the fingertips, so the forearm hangs under it and the elbow drops at the shoulder.
- **Review:** reviewed in the live Blender on the male `outfit.redbrand` with the crossbow on `hand_r.crossbow` and an arrow standing in for the bolt on `hand_r.arrow` (no grip poses applied; the Redbrand wears no quiver, so the bolt comes from where `back.quiver` would be).

### Casting, staff and mace clips (#420)

[`adapters/blender/cast_clips.py`](../adapters/blender/cast_clips.py) authors the casters' kit in Blender on the animated Ranger (`RANGER_CAST_CLIPS`, the `cast` family, after the crossbow clips in bundle order). The clips are shared **cast styles**: the school (fire, frost, shadow, holy, nature) shows through VFX, not separate clips. Each key names the right hand's item frame (the staff on `hand_r.staff`, or the mace or sword on `hand_r.weapon`) and the left hand's palm (the wrist, the fingers and the palm's normal), or for the two-handed staff strikes the left hand's `hand_l.staff` grip 0.42 m up the shaft from the right hand. Two-bone arm IK puts the hands there, the chest turn is spread over `spine_01`-`03`, and the left hand's casting shape (open, cupped, clawed, pointing or a fist) is keyed on its finger joints. The right hand's fingers are left to the grip pose. Mixamo was only watched as reference. Every clip starts from the first `Idle_Loop` pose and is in place.

| Clip | Length | Layer | Motion | `humanoid-clips` |
| --- | --- | --- | --- | --- |
| `Cast_Charge_Loop` | 1.0 s loop | `spine_01` | The staff upright before the right of the chest, the left hand cupped before the chest toward it, circling 2.5 cm; the chest sways ±2°. | `role: cast.charge` |
| `Cast_Release_Push` | 0.5 s | `spine_01` | From the charge's first pose: the palm draws back, then thrusts forward, palm out, at 0.22 s; back to the idle. | `role: cast.release.push`, `contact` (`hand_l`) |
| `Cast_Release_Overhand` | 0.6 s | `spine_01` | From the charge: the left hand winds up beside the head and hurls forward and down at 0.31 s. | `role: cast.release.overhand`, `contact` (`hand_l`) |
| `Cast_Channel_Beam_Loop` | 1.5 s loop | `spine_01` | The staff aimed forward and up, braced by the left palm beside it; a slight push and tremble. The beam starts at the staff's head. | `role: cast.channel.beam` |
| `Cast_Channel_Drain_Loop` | 1.5 s loop | `spine_01` | The clawed left hand reaching forward, pulling back 16 cm twice per loop (`pulseSeconds` 0.375, 1.125) while the chest leans back. | `role: cast.channel.drain` |
| `Cast_Channel_Sky_Loop` | 2.0 s loop | `spine_01` | The staff raised high at the right, its head circling 4 cm; the left palm open upward; the head tipped back. | `role: cast.channel.sky` |
| `Cast_Nova` | 0.8 s | full body | The staff lifts, then stamps its foot on the ground beside the right foot at 0.38 s while the knees bend 9 cm (the feet stay planted) and the left arm sweeps out low. | `role: cast.nova`, `contact` (`hand_r`) |
| `Cast_Cone` | 0.9 s | `spine_01` | Palm forward, swept from the right to the left with a 56° chest turn between 0.29 and 0.67 s (`sweepSeconds`). | `role: cast.cone`, `contact` (`hand_l`) |
| `Cast_Curse_Point` | 0.5 s | `spine_01` | A pointing hand flicked forward from the chest at 0.25 s. | `role: cast.curse`, `contact` (`hand_l`) |
| `Cast_Ground_Sweep` | 0.7 s | `spine_01` | The palm raised, then swept down toward the ground ahead at 0.39 s, the chest bending 16°. | `role: cast.ground`, `contact` (`hand_l`) |
| `Cast_Self_Ward` | 0.9 s | `spine_01` | Fist to the chest, then both arms thrown open (the staff tipped out) at 0.54 s. | `role: cast.self`, `contact` (`hand_l`) |
| `Cast_Ally` | 0.7 s | `spine_01` | An open palm reaching forward and a little to the left at 0.34 s. | `role: cast.ally`, `contact` (`hand_l`) |
| `Warcry` | 1.0 s | `spine_01` | The weapon on `hand_r.weapon` thrust straight up by 0.4 s and held, the left fist clenched, chest and head thrown back. | `role: warcry` |
| `Cast_Summon_Raise` | 1.5 s | full body | Kneels on the right knee with the staff planted (0.45-1.05 s, `kneelSeconds`), the left palm reaching down beside the knee; the palm turns up and rises (the summon at 0.93 s) while the caster stands. | `role: cast.summon.raise`, `contact` (`hand_l`), `secondaryPose` |
| `Cast_Summon_Call` | 1.2 s | `spine_01` | Two fingers to the mouth for a whistle (0.5 s), then a beckoning sweep of the open hand. | `role: cast.summon.call` |
| `Staff_Strike_A`, `Staff_Strike_B` | 0.7 s | `spine_01` | Two-handed, from a guard with the right hand forward on the grip, the left hand behind it on the shaft and the staff's foot leading: a jab (contact 0.32 s) and a right-to-left sweep at waist height (0.35 s). | `role: staff.strike.jab`, `staff.strike.sweep`, `contact` (`hand_r`) |
| `Mace_Swing_A`, `Mace_Swing_B` | 0.7 s | `spine_01` | The mace on `hand_r.weapon`: an overhand blow from over the right shoulder, and a backhand from the left shoulder out to the right; contact at 0.35 s. | `role: mace.strike.overhand`, `mace.strike.backhand`, `contact` (`hand_r`) |
| `Cast_Raise_Wall` | 1.0 s | `spine_01` | Both hands low, palms up, lifted to head height at 0.66 s. | `role: cast.wall`, `contact` (`hand_l`) |
| `Cast_Interrupted` | 0.4 s | `spine_01` | From the charge: a recoil, hands thrown back and apart, the head back, then the idle. | `role: cast.interrupted` |

- **`cast` object:** `releaseSeconds` (every one-shot: the spell leaves the hand, the staff stamps, the blow lands, the ally is touched), `startsFrom: "Cast_Charge_Loop"` (the releases and the interrupt start in the charge's first pose, so crossfade from it), `channelJoint` and `channelPoint` (where the effect starts: `hand_l` and the middle of the palm, or `hand_r` and the staff's head 1.05 m up the shaft, or for the nova its foot; `channelPoint` is in the joint's glTF frame), `sweepSeconds` (cone), `pulseSeconds` (drain) and `kneelSeconds` (summon).
- **Contact:** at `releaseSeconds`, not at the fastest sample: a wind-up moves faster than the release.
- **Items:** the staff (`equipment.staff.*`) rides `hand_r.staff` with `Grip_Staff_R`; in the staff strikes the left hand plays `Grip_Staff_L`. The Arcanist's tome rides `hand_l.shield` with `Grip_Book_L` and simply follows the casting hand (playing `Grip_Book_L` replaces the keyed casting shape). The Cleric's mace and the Warden's sword ride `hand_r.weapon` with `Grip_Weapon_R`; the casting clips put the right hand where the staff would be, so a mace in that hand just follows it.
- **Chain pose:** `Cast_Summon_Raise` has a `secondaryPose` as the traversal clips (`skirt_f_01`, `skirt_b_01`, `skirt_l_01`, `skirt_r_01`, `cape_01`, one local rotation per frame), with a larger swing for the level front thigh: the front and side panels follow 70% of the thigh's lift (front at most 70°, sides 55°), so the robe stays over the knee.
- **Long robes:** the clips keep the feet under the body. `Cast_Nova` bends the knees with the feet planted rather than stepping out; the robe stretches over the knees but no leg passes through it.
- **Review:** reviewed in the live Blender on the male `outfit.class.arcanist` with the crystal staff on `hand_r.staff` and the tome on `hand_l.shield`, and on `outfit.class.cleric` with the flanged mace on `hand_r.weapon` (no grip poses applied). In `Cast_Summon_Raise`, with the chain pose driven, the front panel lies over the raised knee and the shin shows below its hem; the reaching palm stays about 0.45 m above the ground.

## Female Ranger

`--figure female` (#115, owner answer Q1 = A) builds `humanoid.ranger.female` with the same recipe. Of the Peasant-based outfits it has only the tanner (#378, over the pack's `Female_Peasant` outfit), and it has no headwear, facial hair or male variety. It uses the Universal Base Characters `Superhero_Female_FullBody` head (`keepMeshes: ["Eyebrows", "Eyes"]`) on the full `Female_Ranger` outfit ([humanoid-sources.md](humanoid-sources.md#female-body-and-outfit-115)).

Both figures share the 65-joint rig, so the female Ranger gets the same bone maps, clips, equipment entries and `humanoid-clips` metadata. Its hips reference height is measured on its own rig. This is the second real humanoid performing the same clip set through the shared operation path.

Its sockets are derived from the Female_Ranger rig into [`humanoid.ranger.female.sockets.json`](../assets/descriptors/humanoid.ranger.female.sockets.json) (`bun examples/weapons/derive-sockets.ts --rig <Female_Ranger.gltf> --out <file> --character humanoid.ranger.female`). They have the same ids as the male sockets, and the stowed sockets keep the male joint-frame values.

Its tar goes to the rolling `humanoid-ranger-female` release.

## Build

Both figures are rolling releases that CI builds (#399): merging a change to their sources starts the `Publish rolling releases` workflow, which runs one job per figure ([Publishing a rolling release](../README.md#publishing-a-rolling-release)). Republish one by hand with `gh workflow run publish-releases.yml -f release=humanoid-ranger-male` (or `-female`). Each job checks out the pinned 3d-lab processor, installs Rust, Blender and KTX-Software, and runs [`scripts/build-ranger-release.ts`](../scripts/build-ranger-release.ts), which builds the bundle and writes the per-entry downloads ([`pack-downloads.ts`](../scripts/pack-downloads.ts)) next to the tar. The Ranger jobs have a 240-minute timeout instead of the default 60: a local build of one figure takes about 1.5 hours, and both figures build in parallel.

To build locally:

```sh
git clone https://github.com/moritzbrantner/3d-lab <checkout>
git -C <checkout> checkout 4e69c0f64177d3babdf0ea991a631c62f577e684   # the stability/processors.json pin
cargo fetch --manifest-path <checkout>/examples/asset-tooling-animation-adapter/Cargo.toml
git lfs pull   # the humanoid members under assets/canonical/
ASSET_TOOLING_BLENDER=<blender 5.2.2> bun scripts/build-ranger-character.ts --processor-checkout <absolute checkout> --out <directory> [--figure male|female]
# or the whole release, downloads included:
ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB=<absolute checkout> ASSET_TOOLING_KTX=<ktx CLI> bun scripts/build-ranger-release.ts --out <directory> --figure male
```

The equipment, armour and authored clips run through `external.blender.script@1`, so the build needs Blender 5.2.2. `ASSET_TOOLING_BLENDER` names it, otherwise `blender` on `PATH` is used. Blender installed as a snap can only read and write under `$HOME`, so set `TMPDIR` to a directory there. The image codec also needs `ffmpeg` and `ffprobe`.

The independent Blender-bound groups (the outfit kits with their levels of detail, the pack and hand-modelled hairstyles, and the weapon, archery and headwear items) run through a bounded pool (#427). `ASSET_TOOLING_JOBS` sets how many steps run at once; the default is one less than `os.availableParallelism()`. Each step has its own workspace, and the results are added in their declared order, so the tar is the same at any job count. Every log line starts with the elapsed build time (`[mmm:ss]`), so a log is a step profile.

A rebuild into the same `--out` is incremental: Blender steps reuse the generation cache keyed in their spec workspace, and operations reuse the operation-result cache in the object store. Only steps whose inputs changed run again.

[`scripts/build-ranger-character.ts`](../scripts/build-ranger-character.ts) is the maintained recipe. It needs no network after `cargo fetch`: the processor runs `cargo run --offline`. The processor checkout must be source-clean at the pinned commit. `Cargo.lock` and `target/` may be present, but nothing else may differ. Its identity (`git-clean-exact-head`, cargo/rustc versions and the probe) is part of the `animation.retarget@1` build identity. `<directory>` becomes the object-store root, which holds every intermediate AssetRef. The script prints the bundle directory, the tar path, the tar sha256 and the export ref, and writes `lineage.json` next to them with every intermediate AssetRef and the retarget observations.

| Step | Operation | Inputs and parameters |
| --- | --- | --- |
| 1 | `scene.import.gltf@2` | The Male_Ranger outfit, and the Superhero body with its two [declared substitutions](humanoid-sources.md#declared-substitution). |
| 2 | `scene.subset.skinned.gltf@1` | The body, cut down to its head and face with the [Ranger recipe](gltf-subset.md#ranger-character-recipe). |
| 3 | `scene.compose.skinned.gltf@1` | Skeleton = outfit, parts = the head subset. |
| 3b | `external.blender.script@1`, then `scene.compose.skinned.gltf@1` | [`face_variants.py`](../adapters/blender/face_variants.py) on the head subset; its morph targets are copied onto the head subset, which is composed with the outfit again for the shipped characters ([Facial variants](#facial-variants)). |
| 4 | `scene.extract.animation.gltf@1` | The composed GLB with `hipsJoint: "pelvis"`: the target rig only. |
| 5 | `scene.extract.animation.gltf@1` | Once per clip: the UAL1 GLB with `hipsJoint: "DEF-hips"`, or for `Idle_Shield_Loop` the UAL2 GLB with `hipsJoint: "pelvis"`. Each run yields the source rig and the clip. |
| 6 | `animation.retarget@1` | Each library clip with its source rig and the target rig, its library's bone map (below), `sampleRate: 30` and `rootMotion: "in-place"`. The authored clips come from Blender instead (see [Contents](#contents)). |
| 7 | `scene.embed.animation.gltf@1` | The composed GLB with every retargeted clip, under its source name, in the order of the clip table. |
| 8 | `external.blender.script@1`, then `scene.import.gltf@2` | The weapon, archery and armour recipes, the hairstyles, the Light skin and the outfit variants (see [Contents](#contents)). |
| 8b | `scene.textures.resize.gltf@1` | Every character and item GLB with `RANGER_TEXTURE_POLICY` ([Textures](#textures)). GLBs without images are bundled unchanged. |
| 8c | `external.blender.script@1` (male) | [Male variety](#male-variety-380): the age and build keys of each outfit variant (with its plates) and hair entry, copied onto the shipped assets; the hand-modelled hairstyles and facial hair; the painted head skins. |
| 9 | `asset.bundle@4` | `gltf-resources-v1` with every entry and attachment listed under [Contents](#contents). The sockets descriptor is validated against the rig's joints. |
| 10 | `scripts/pack-asset-bundle.ts` | Packs `<directory>/bundle` into `<directory>/humanoid.ranger.male.tar` and its `.sha256`. |

Every step uses the `NODE_SKINNED_MESH_NON_ROOT` and `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` validator exceptions, the same ones the bundle profile fixes.

## Bone map

`animation.retarget@1` binds 3d-lab `HumanoidBone` ids to a joint name in each rig. The UAL1 rig is a 53-joint Rigify `DEF-*` skeleton. The UBC/Outfits rig has 65 joints in the Unreal style. Both have three spine joints. `RANGER_BONE_MAP` maps each of them exactly once through the optional `upper-chest` bone, which sits between `chest` and `neck` (3d-lab `4e69c0f`).

| HumanoidBone | UAL1 joint | UBC/Outfits joint |
| --- | --- | --- |
| `root` | `root` | `root` |
| `hips` | `DEF-hips` | `pelvis` |
| `spine` | `DEF-spine.001` | `spine_01` |
| `chest` | `DEF-spine.002` | `spine_02` |
| `upper-chest` | `DEF-spine.003` | `spine_03` |
| `neck` | `DEF-neck` | `neck_01` |
| `head` | `DEF-head` | `Head` |
| `left-shoulder` / `right-shoulder` | `DEF-shoulder.L` / `.R` | `clavicle_l` / `_r` |
| `left-upper-arm` / `right-upper-arm` | `DEF-upper_arm.L` / `.R` | `upperarm_l` / `_r` |
| `left-lower-arm` / `right-lower-arm` | `DEF-forearm.L` / `.R` | `lowerarm_l` / `_r` |
| `left-hand` / `right-hand` | `DEF-hand.L` / `.R` | `hand_l` / `_r` |
| `left-upper-leg` / `right-upper-leg` | `DEF-thigh.L` / `.R` | `thigh_l` / `_r` |
| `left-lower-leg` / `right-lower-leg` | `DEF-shin.L` / `.R` | `calf_l` / `_r` |
| `left-foot` / `right-foot` | `DEF-foot.L` / `.R` | `foot_l` / `_r` |
| `left-toes` / `right-toes` | `DEF-toe.L` / `.R` | `ball_l` / `_r` |

Several joints are not mapped: the fingers and thumbs and the `*_leaf` joints. They keep their rest pose, so the hands stay open; a consumer closes a hand round a held item with the [grip poses](#grip-poses-285).

UAL2 uses the same 65-joint Unreal-style rig as UBC/Outfits. `RANGER_UBC_BONE_MAP` (23 ids) therefore binds each `HumanoidBone` id to the same joint name on both sides, for example `hips` → `pelvis` / `pelvis`. Its rest pose is close to the Ranger's but not identical. The retarget transfers rotation deltas from each rig's own rest, so the difference does not leak into the result.

## Retargeting

Asset-tooling implements no part of the retargeting. Processor `three-d-animation-retarget` (3d-lab `4e69c0f`, contract in 3d-lab `docs/contracts/animation-processing.md`) does all of it:

- It samples the source clip at each sample time.
- It transfers each mapped bone's local rotation delta onto the target's rest pose.
- It scales hips and root translation by the ratio of the reference heights.
- With `in-place`, it removes the model-space horizontal part of that translation and keeps the vertical bob.

The reference height of each rig is its hips joint's model-space height at rest, taken through every ancestor (`scene.extract.animation.gltf@1`): 0.9167 m for UAL1 `DEF-hips`, 0.9167 m for UAL2 `pelvis` and 0.9491 m for UBC `pelvis`. The sample grid is `start + i/30` up to the clip's last key. The last sample is always exactly the clip's last key, never past it, so both loop endpoints are sampled. Output keys are written as LINEAR glTF samplers on the skin's joint nodes.

## Clips

Clip names are the source names. Every clip is in place. These measurements come from the recorded build of the numbered release v2:

| Clip | Source | Use | Duration | Samples | Channels | Keys |
| --- | --- | --- | --- | --- | --- | --- |
| `Idle_Loop` | UAL1 | idle (v1) | 2.5 s | 76 | 46 | 3,496 |
| `Walk_Loop` | UAL1 | walk (v1) | 1.333 s | 41 | 46 | 1,886 |
| `Jog_Fwd_Loop` | UAL1 | run, jog gait (#260) | 0.933 s | 29 | 46 | 1,334 |
| `Sprint_Loop` | UAL1 | run, sprint gait (#260) | 0.667 s | 21 | 46 | 966 |
| `Sword_Idle` | UAL1 | sword idle (#113) | 1.667 s | 51 | 46 | 2,346 |
| `Sword_Attack` | UAL1 | melee attack (#260, #113) | 1.533 s | 47 | 46 | 2,162 |
| `Death01` | UAL1 | death (#260) | 2.4 s | 73 | 46 | 3,358 |
| `Idle_Shield_Loop` | UAL2 | shield guard (#113) | 2.5 s | 76 | 46 | 3,496 |

Across the 22 mapped bones, each clip has 22 rotation channels, 2 translation channels (hips and root) and 22 scale channels. v5 maps 23 bones, so each clip has 48 channels instead of 46, with the same samples: 3,648 keys for `Idle_Loop` and `Idle_Shield_Loop`, 1,968 for `Walk_Loop`, 1,392 for `Jog_Fwd_Loop`, 1,008 for `Sprint_Loop`, 2,448 for `Sword_Idle`, 2,256 for `Sword_Attack` and 3,504 for `Death01`. The scale channels appear because both libraries key scale on every mapped bone; for UAL1 the keyed scale stays within 4e-7 of 1. UAL1 also ships `Sword_Attack_RM`, a root-motion variant. The bundle takes the plain `Sword_Attack`, and `in-place` removes any remaining horizontal hips travel. `Death01` keeps its vertical drop, because in-place removes only horizontal motion.

## Conventions

The character keeps the Quaternius export's conventions; no transform is changed. The composed rest pose was checked against them:

- **Units and axes:** metres, +Y up.
- **Origin:** `root` is at the origin, and the feet are symmetric about x = 0. The ankles are at z = -0.09 and the balls of the feet at z = +0.06.
- **Facing:** +Z (the toes point to +Z) with the character's left at +X.
- **Height:** the pelvis is at 0.949 m and the head joint at 1.60 m.
- **Root motion:** every clip is in place. The pelvis's horizontal model-space position is constant over each clip; gameplay owns position and facing (mmorpg#39).

## Textures

The build runs every character GLB through [`scene.textures.resize.gltf@1`](gltf-texture-resize.md) with `RANGER_TEXTURE_POLICY`:

- the longest edge is at most 1024 px for `baseColor`, `normal` and `emissive`, and at most 512 px for `metallicRoughness` and `occlusion`;
- `default` is 1024 px;
- smaller images, such as the 256 px eye textures, are kept byte for byte.

The textures stay PNG, so no consumer needs a KTX2 or WebP decoder. Colour is averaged in linear light, ORM and roughness data as stored, and normal maps as renormalized vectors, and the PNGs are written at zlib level 9. Only image bytes change. The v3 character `.gltf` differs from v2 only in its `images` entries, the geometry and animation `.bin` is the same file, and the two equipment entries are byte-identical to v2.

From the recorded v3 build (the 13 images total 53,414,027 bytes before and 7,169,668 bytes after):

| Image | Slot | Before | After |
| --- | --- | --- | --- |
| `T_Ranger_Normal` | normal | 4096², 12,713,653 B | 1024², 962,296 B |
| `T_Ranger_BaseColor` | baseColor | 4096², 6,630,927 B | 1024², 871,737 B |
| `T_Ranger_ORM` | metallicRoughness | 4096², 10,792,085 B | 512², 249,136 B |
| `T_Regular_Male_Normal` | normal | 2048², 4,064,184 B | 1024², 915,837 B |
| `T_Regular_Male_Dark_BaseColor` | baseColor | 2048², 1,316,151 B | 1024², 473,503 B |
| `T_Regular_Male_Roughness` | metallicRoughness | 2048², 3,160,102 B | 512², 185,123 B |
| `T_Hair_1_BaseColor` | baseColor | 2048², 1,570,376 B | 1024², 651,218 B |
| `T_Hair_1_Normal.png` | normal | 2048², 4,326,126 B | 1024², 1,110,405 B |
| `T_Eye_Brown` | baseColor | 256², 35,958 B | unchanged |
| `T_Eye_Normal.png` | normal | 256², 15,099 B | unchanged |
| `T_Superhero_Male_Dark` | baseColor | 2048², 1,384,380 B | 1024², 499,951 B |
| `T_Superhero_Male_Normal` | normal | 2048², 4,252,937 B | 1024², 1,013,633 B |
| `T_Superhero_Male_Roughness` | metallicRoughness | 2048², 3,152,049 B | 512², 185,772 B |

**Visual parity:** the socket sheets (`examples/weapons/socket-sheets.py`, Blender 5.2.2 Cycles) were rendered for v2 and v3 at rest, `Idle_Loop` middle, `Walk_Loop` middle and `Sword_Attack` 50 %. The renders are deterministic: a fresh v2 render matched the published v2 `Sword_Attack` sheet exactly. The v2 to v3 differences, as mean and maximum absolute RGB difference on a 0–255 scale over the 1440 × 960 sheet, were:

| Pose | Mean | Max | Pixels differing by more than 16 |
| --- | --- | --- | --- |
| rest | 0.062 | 49 | 0.010 % |
| `Idle_Loop` middle | 0.130 | 39 | 0.042 % |
| `Walk_Loop` middle | 0.135 | 44 | 0.058 % |
| `Sword_Attack` 50 % | 0.094 | 49 | 0.010 % |

v6 adds these clips, also in place, with 48 channels each:

| Clip | Source | Use | Duration |
| --- | --- | --- | --- |
| `Jump_Start` | UAL1 | jump takeoff | 1.333 s |
| `Jump_Loop` | UAL1 | airborne / fall loop | 2.5 s |
| `Jump_Land` | UAL1 | landing | 1.267 s |
| `Crouch_Idle_Loop` | UAL1 | crouch idle | 2.933 s |
| `Crouch_Fwd_Loop` | UAL1 | crouch walk | 2 s |
| `Roll` | UAL1 | dodge roll, in-place source | 1.467 s |
| `Roll_RM` | UAL1 | dodge roll, root-motion source | 1.467 s |
| `ClimbUp_1m_RM` | UAL2 | climb up a 1 m ledge | 0.667 s |
| `Slide_Start` | UAL2 | slide entry | 0.833 s |
| `Slide_Loop` | UAL2 | slide loop | 2 s |
| `Slide_Exit` | UAL2 | slide exit | 0.5 s |

In-place retargeting removes the horizontal hips travel of the `_RM` sources and keeps vertical motion. `ClimbUp_1m_RM` therefore still rises about 1 m and the slide clips drop and raise the pelvis about 0.8 m. The source travel is recorded in [Clip motion](#clip-motion), so a consumer can move the gameplay body to match.

v7 adds these clips (UAL2 unless noted), also in place:

| Clip | `role` | Duration | Contact (`hand_r` unless noted) |
| --- | --- | --- | --- |
| `Sword_Regular_A`, `_A_Rec` | `sword.light-strike`, `.recovery` | 0.433 s, 0.967 s | 0.25 s |
| `Sword_Regular_B`, `_B_Rec` | `sword.counter`, `.recovery` | 0.533 s, 1.033 s | 0.25 s |
| `Sword_Regular_C` | `sword.heavy-strike` | 2 s | 0.65 s |
| `Sword_Regular_Combo` | `sword.light-chain` | 3 s | 1.55 s |
| `Sword_Block` | `shield.block-impact` | 1.233 s | |
| `Idle_Shield_Break` | `shield.block-break` | 1.067 s | |
| `Shield_OneShot` | `shield.bash` | 0.833 s | 0.083 s (`hand_l`) |
| `Hit_Chest`, `Hit_Head` (UAL1), `Hit_Knockback` | `hit.chest`, `hit.head`, `hit.knockback` | 0.333, 0.433, 0.833 s | |
| `Spell_Simple_Enter`, `_Idle_Loop`, `_Shoot`, `_Exit` (UAL1) | `cast.enter`, `cast.hold`, `cast.release`, `cast.exit` | 0.533, 2.1, 0.5, 0.433 s | 0.083 s (`_Shoot`) |

The v2 clips `Sword_Idle`, `Sword_Attack`, `Death01` and `Idle_Shield_Loop` get the roles `sword.ready`, `sword.strike` (contact 0.383 s), `death` and `shield.guard-hold`.

## Clip motion

From v6 the character entry carries a `humanoid-clips` attachment, schema `humanoid-clips-v1`. It is canonical JSON with `units: "m"`, `up: "+Y"`, `facing: "+Z"` and one entry per clip, in bundle order:

- `name`, and `source`: the library's catalog id, the source clip name and the sha256 of the extracted source animation (`lineage.json` lists the same AssetRef);
- `durationSeconds`, `loop` (the source name ends in `_Loop`), `interpolation: "LINEAR"` and `rootMotion: "in-place"`;
- `sourceRootDisplacement` `{x, y, z}`: the source hips' model-space travel from the first to the last key, scaled by the hips reference-height ratio (0.9491 / 0.9167). `x` and `z` were removed from the clip; `y` is still in it;
- from v7, `role` for the combat clips, and for strikes `contact` `{joint, seconds, speedMetersPerSecond}`: the midpoint of the sample interval in which that joint moves fastest in model space. This is a presentation landmark. It never times gameplay, and the consumer owns windup, active and recovery phases;
- `sourceRootSpeedMetersPerSecond` for the authored travelling clips (strafes, walk start and stop): the travel the in-place clip stands for (its `sourceRootDisplacement` `x` and `z`) over its duration;
- `groundSpeedMetersPerSecond`, only for the gaits in `RANGER_GAITS`: `Walk_Loop`, `Jog_Fwd_Loop`, `Sprint_Loop`, `Crouch_Fwd_Loop`, `Wade_Fwd_Loop`, and the backward `Jog_Bwd_Loop` and `Walk_Bwd_Loop`, whose planted foot moves forwards and whose speed is reported positive. It is the median speed at which the lower foot moves backwards (−Z) between consecutive samples of the retargeted clip, which is the body speed at which that foot would not slide. The source gaits are themselves in place, so this is the only speed they define.

From the recorded v6 build: ground speeds 1.0434 m/s (walk), 1.7637 m/s (jog), 2.1345 m/s (sprint) and 0.657 m/s (crouch walk). Root displacement: `Roll_RM` z 5.2693 m, `ClimbUp_1m_RM` y 1.0353 m and z 1.7356 m, `Jump_Start` y 0.358 m, `Slide_Start` y −0.8079 m and `Slide_Exit` y +0.8079 m. These are measurements, not a gameplay contract: the consumer owns movement speed and collision.

The largest differences are in the hand close-ups, where fine texture detail is lost.

**Normal maps:** each resized normal map keeps the sign of its mean X and Y components, which rules out a flipped green channel. The mean vector length is 1.000, so the maps are not washed out. The mean angle to a plain box downscale of the source is 0.18–0.34°.

## Bundle and consumer pinning

The entries are listed under [Contents](#contents). The character's `default.gltf` has one geometry/animation `.bin` and its PNG textures as hash-addressed resources. Items are unskinned and unanimated except the bow. A consumer parents an item's scene root under the socket joint with the socket's TRS ([humanoid-sockets.md](humanoid-sockets.md)). `manifest.json` records each embedded GLB's AssetRef as `source`, and `lineage.json` from the build links every entry back to the canonical members.

A consumer downloads `humanoid.ranger.male.tar` from the rolling `humanoid-ranger-male` release (Decision 7.1.5). It checks the tar against the release's `export.ref.json` with `bun scripts/pack-asset-bundle.ts --verify humanoid.ranger.male.tar --ref export.ref.json` (or `verifyAssetBundle` after extracting). It loads:

- the character with `readAssetBundleGltf(dir, manifest, "humanoid.ranger.male", "<variant>")`;
- the items the same way;
- the attachments with `readAssetBundleAttachment(dir, manifest, "humanoid.ranger.male", "default", "<name>")`.

A consumer that needs a fixed input keeps its own copy of the tar. Adopting a newer rolling build is a deliberate consumer change. The numbered releases remain for consumers that still pin them: mmorpg (v7), arpg (v1, v4) and 3d-lab (v8).

## Tests

- `bun test test/gltf-animation-operations.test.ts` uses hand-authored skinned fixtures. It covers the rig, the hips reference height through a non-joint armature, clip extraction on joint indices, skipping a non-joint channel, an extract → embed → extract round trip, and the rejection of existing or duplicate clip names and of out-of-range nodes.
- `bun test test/animation-retarget-operations.test.ts` runs a fixture adapter. It covers the name → index binding conversion, the `sampleRate` grid, output and observation checks, and parameter failures.
- `bun scripts/check-processor-contract.ts <checkout> <commit> moritzbrantner/3d-lab examples/asset-tooling-animation-adapter/Cargo.toml animation.retarget` runs the pinned processor on two tiny rigs, twice, including an `upper-chest` bend that must land on the target's `upper-chest` joint. This is also the hosted stability matrix entry.
- `bun test test/gltf-texture-resize-operations.test.ts` covers the texture operation ([gltf-texture-resize.md](gltf-texture-resize.md#tests)).
- `test/humanoid-ranger.test.ts` always checks the clip list, the authored clips, the combat and hit roles, the bone maps (each spine joint mapped once, UAL2 binding the same targets), the equipment, figures, appearance and `RANGER_TEXTURE_POLICY`. It also runs the whole recipe and checks the bundle structurally:
  - every clip name in order, each with a positive duration;
  - in place: the pelvis's horizontal model-space drift, with root and pelvis keys composed, is at most 1 cm;
  - retargeted library clips animate only mapped joints; every clip has LINEAR samplers and rotates `spine_02`;
  - the weapon entries are unskinned, unanimated and have a `grip` node, and the bow is skinned to `grip` and `nock`;
  - the variants and armour entries are present;
  - the `humanoid-sockets` attachment matches the committed descriptor byte for byte and validates against the 65 joints;
  - the `humanoid-clips` attachment lists every clip in order with its source animation sha256, loop flag and in-place root motion; the gait speeds increase from crouch walk to sprint, and `Roll_RM` and `ClimbUp_1m_RM` record their removed travel;
  - the 13 character textures fit their slot limits, none is upscaled, the image bytes shrink at least fourfold, and the equipment has no images;
  - every variant in `humanoid-appearance.face.variants` carries the eight face morph targets on the head, eyes and eyebrows, and the levels of detail carry none.
- `test/male-variety.test.ts` checks the age, build, height, tone, hairstyle and beard tables against the Blender recipes, the descriptor sections and the transfer that appends the variety targets after the face targets.
- `test/blender/recipes/face-variants.test.ts` checks the option table against the Blender recipe and the morph-target transfer. With `BLENDER_TESTS=1`, `ASSET_TOOLING_BLENDER` and hydrated LFS, it authors the keys on the real male and female head parts, checks that every key visibly moves the head and leaves the cranium, ears and neck still, and composes the result onto the outfit with the targets intact.

  The full run skips unless the Git LFS payloads are hydrated, `ASSET_TOOLING_PROCESSOR_CHECKOUT_3DLAB` names the pinned checkout and `ASSET_TOOLING_BLENDER` names Blender 5.2.2.

## Visual check of the v2 clips

The socket sheets were rendered with the sword in `hand_r.weapon` and the shield in `hand_l.shield` at `Jog_Fwd_Loop` and `Sprint_Loop` (a quarter and the middle), `Sword_Idle` (the middle), `Sword_Attack` (30, 50 and 70 %), `Death01` (the middle and the end) and `Idle_Shield_Loop` (the middle). They show no inverted or twisted limbs and no root drift: the pelvis keeps its horizontal position in every clip. The gaits run in place, so the feet slide backwards by design; gameplay moves the character. Known limits:

- **Hands:** the fingers keep their open rest pose (#115), so the sword lies across an open hand in every clip. Since #285 the [grip poses](#grip-poses-285) close the hand.
- **Sword angle (bundle-v2 sockets, fixed in v4):** the `hand_r.weapon` socket was authored for a hanging arm. In `Sword_Idle` the blade points sideways at hip height rather than forward, and in `Sword_Attack` it follows the extended arm.
- **Shield guard (bundle-v2 sockets, fixed in v4):** `hand_l.shield` aligns the shield's vertical axis with the forearm. In `Idle_Shield_Loop` the forearm is held across the body, so the shield sits on its side with the point toward the character's left instead of down.
- **Death:** at the end of `Death01` the character lies on its back with the pelvis joint 6.5 cm above the ground, and the right hand's fingertip joints sink up to 9 cm below it. See [Death01 ground penetration](#death01-ground-penetration) for the cause, fixed in v5.

## Visual check of the v4 sockets

The socket sheets (`examples/weapons/socket-sheets.py`, Blender 5.2.2 Cycles) were rendered from the v4 bundle, with the sword in `hand_r.weapon` and the shield in `hand_l.shield`, at these poses:

- rest;
- the middle of `Idle_Loop`;
- a quarter and the middle of `Walk_Loop`;
- `Sword_Idle` 50 %;
- `Sword_Attack` 30, 50 and 70 %;
- `Idle_Shield_Loop` 50 %;
- the end of `Death01`.

Directions below are the character's own.

| Pose | Finding |
| --- | --- |
| rest (T-pose) | The grip lies under the open palm along the knuckle line, and the blade runs past the thumb. The shield hangs under the left forearm, face down. |
| `Idle_Loop` middle | The sword points forward from the hanging right hand, slightly raised and clear of the leg. The shield stands on the outside of the left arm, face out, its top tilted forward and its point down and back. |
| `Walk_Loop` quarter and middle | The same as `Idle_Loop`. The shield is close to upright on the outside of the arm. Nothing clips. |
| `Sword_Idle` 50 % | The stance turns about 40° to the right, with the sword hand low beside the right hip. The blade points forward along the stance, slightly to the right, and about 24° up. Seen from the world front, it still reads as pointing out to the right, because the whole stance is turned. With the bundle-v2 socket it was level and pointed straight to the right. |
| `Sword_Attack` 30 % and 50 % | The lunge to the left extends the arm, and the blade continues the arm's line: a level thrust in the strike direction. The shield is held back on the left with its face outward. |
| `Sword_Attack` 70 % | In the recovery, the blade is raised forward and up from the right hand. |
| `Death01` end | The sword and shield lie flat beside the body and partly below the ground, like the right hand ([below](#death01-ground-penetration)). |
| `Idle_Shield_Loop` 50 % | The shield stands upright in front of the chest with its face forward and its point down. Its top edge is at chin height. The sword hangs from the right hand, pointing forward and down. |

The sheets show no gross clipping. Known limits:

- The fingers are open (#115; the [grip poses](#grip-poses-285) close them since #285).
- The shield's forearm strap floats behind the board beside the wrist ([humanoid-sockets.md](humanoid-sockets.md#ranger-sockets)).
- The hanging-arm poses tilt the shield forward.
- The `Sword_Idle` stance itself is turned, and with it the guard.

## Visual check of v5

The socket sheets were rendered from the v5 bundle with the same setup as for v4, at `Sword_Idle` 50 %, `Sword_Attack` 50 %, the end of `Death01`, `Idle_Shield_Loop` 50 % and the middle of `Walk_Loop`, and compared with the v4 sheets. The legs, the pelvis and the in-place behaviour are unchanged. The chest now follows the source's middle spine bend, so the upper body changes as follows:

| Pose | Change from v4 |
| --- | --- |
| `Walk_Loop` middle | No visible change. |
| `Sword_Idle` 50 % | The upper body leans further forward and the head is lower. The blade is close to level instead of raised about 24°. The shield hangs lower in front of the left hip. |
| `Sword_Attack` 50 % | The torso is hunched forward over the lunge, with the head down. The thrust now points forward and down instead of level. The shield is raised high on the left, with its rim beside the hood. |
| `Idle_Shield_Loop` 50 % | The head is tilted further down, and the shield's top edge is at eye height instead of chin height. The sword points further down. |
| `Death01` end | The body lies the same way, but the shoulders and head are higher and both hands lie on the ground instead of below it. The sword and shield lie flat beside the body. The sheets have no ground plane, so whether their edges touch it cannot be read from them. |

The sheets show no inverted or twisted limbs and no gross clipping. The known limits of v4 (open fingers, the floating shield strap, the turned `Sword_Idle` stance) still apply.

## Death01 ground penetration

At the end of `Death01`, the right fingertip joints of the v2–v4 bundles are 8.7 cm below the ground. UAL1's own fingers are about 2 cm above it. The cause is not the retarget's height handling:

- **Hips height:** the pelvis lies 6.5 cm above the ground, which is UAL1's 6.3 cm scaled by 0.9491 / 0.9167.
- **Root translation:** in-place removes only the horizontal part.
- **Limb length:** the Ranger's upper arm (0.251 m) and forearm (0.240 m) are shorter than UAL1's (0.274 m and 0.273 m), not longer.

The cause is the bone map. UAL1 has three spine joints (`DEF-spine.001`, `.002` and `.003`). The 22-bone `HumanoidBone` vocabulary of 3d-lab `86e5fe1` had only `spine` and `chest`, and v1–v4 bind these to `spine_01` and `spine_03`. The local rotation of `DEF-spine.002` is therefore dropped, and the Ranger's `spine_02` keeps its rest pose. The chest's world orientation is off by the bend of `DEF-spine.002`. At the end of `Death01` that bend is 6.0°, and the arm hangs from the chest.

**Fix (v5, [#268](https://github.com/moritzbrantner/asset-tooling/issues/268)):** 3d-lab `4e69c0f` adds the optional `upper-chest` bone, and v5 maps all three spine joints ([Bone map](#bone-map)). IK would not have fixed this, and a fold of `DEF-spine.002` into `DEF-spine.003` before the retarget would have put animation semantics into asset-tooling.

The chest error is the angle between the world-frame rotation deltas from rest, W(t) · W(rest)⁻¹, of the Ranger's `spine_03` and the source's `DEF-spine.003` (for `Idle_Shield_Loop`, UAL2's `spine_03`). It is measured at 11 evenly spaced samples per clip, from the start to the last key:

| Clip | Maximum chest error, v4 | Maximum chest error, v5 |
| --- | --- | --- |
| `Idle_Loop` | 5.9° | 0.5° |
| `Walk_Loop` | 5.2° | 0.7° |
| `Jog_Fwd_Loop` | 16.1° | 5.5° |
| `Sprint_Loop` | 11.8° | 4.2° |
| `Sword_Idle` | 20.4° | 1.9° |
| `Sword_Attack` | 29.8° | 11.3° |
| `Death01` | 14.4° | 1.8° |
| `Idle_Shield_Loop` | 12.9° | 2.2° |

At the end of `Death01` in v5, the lowest right fingertip joint (`ring_04_leaf_r`) is 0.9 cm above the ground (v4: `middle_04_leaf_r`, 8.7 cm below). The right shoulder (`upperarm_r`) is at 6.2 cm (v4: 2.3 cm), the wrists (`hand_r`, `hand_l`) at 3.6 and 2.6 cm (v4: −4.1 and −2.8 cm), and the lowest left fingertip at 0.2 cm (v4: −7.3 cm). The pelvis stays at 6.5 cm.

**Remaining error:** in v5, the pelvis, `spine_01` and `spine_02` follow the source within 1.6°. The rest of the error appears at `spine_03`. In `Sword_Attack`, `DEF-spine.003` twists up to 75° from its rest, and the rest orientations of `spine_03` and `DEF-spine.003` differ by 11.1° in world space. The processor transfers each bone's local rotation delta onto the target's rest, so a large twist of a joint whose rest axes differ from the source's is applied about slightly different world axes. That is a property of `three-d-animation-humanoid-retarget-v1` in 3d-lab, not of the bone map.

## Not covered here

These remain open on #110 and its consumers:

- the #111 viewer snapshot set at rest, idle and walk. The v2 clips were checked with the Blender socket sheets instead (`examples/weapons/socket-sheets.py --poses=…`), with the findings below;
- the source-versus-runtime pose comparisons;
- the consumer smoke tests in mmorpg#210 and arpg;
- publishing the GitHub Release.
