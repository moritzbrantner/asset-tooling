# Riding horse and riding clips (#769)

Stills rendered with Workbench in headless Blender 5.2.2 from this branch's `adapters/blender/mounts.py` (the horse,
with the `src/mounts.ts` arguments) and `adapters/blender/ride_clips.py` (authored on the published male and female
Rangers, textures stripped, merged as in `../ranger-clips-767/merge.py`). Labels are `<clip>-<view>-<frame>` (30 fps).
`game` is the mmorpg game camera's angle (0.42 rad pitch from 12 m, three-quarter front, from the horse's right);
`near` is the same from its left, where the rider mounts; `side` and `tall` look from the horse's left at a flat
angle.

- `Horse_Gaits_Side.jpg`: one stride each of `Walk_Loop`, `Trot_Loop`, `Canter_Loop` and `Gallop_Loop`, eight evenly
  spaced frames, over ground marks every 25 cm.
- `Horse_Rear_Halt_Idle_Side.jpg`: `Rear`, `Halt` and `Ride_Idle_Loop`.
- `Horse_Turns_Game.jpg`: `Turn_L`, `Turn_R` and the gallop at the game camera.
- `Rider_Gaits_Game.jpg`, `Rider_Gaits_Side.jpg`: the male Ranger on the horse through the idle, walk, trot (seated
  and risen), canter, gallop and both turns, each rider clip played with its horse clip from the same frame, the
  rider's root on `saddle.seat`.
- `Rider_Female_Side.jpg`: the same for the female Ranger.
- `Mount_Near.jpg`, `Dismount_Near.jpg`: the male Ranger mounting and dismounting from the near side.

**Hooves.** The recipe measures the worst planted slide with the gait's speed added back: walk 8 mm, trot 0,
canter 0.1 mm, gallop 0.2 mm, the turns 6 mm (descriptor `hoofSlideMeters`). The footfall order is in each gait's
`footfalls` and checked by `test/blender/mounts/`.

**Rider fit**, measured by `ride.py` every frame (cm): the deepest rider vertex inside the horse or its tack (a vertex
counts as inside only when rays up, left, right and ahead each cross the surface an odd number of times), the
rider joint there, the palm's middle from its `reins.*` point and the ball of the foot from its `stirrup.*` point
while seated, and the pelvis's highest rise off `saddle.seat`.

| Clip | Male inside | at | palm | ball | rise | Female inside | at | palm | ball | rise |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| `Ride_Idle_Loop` | 1.5 | thigh | 2.5 | 0 | 0 | 1.9 | calf | 0 | 0 | 0 |
| `Ride_Walk_Loop` | 1.6 | thigh | 2.4 | 0 | 0 | 2.3 | calf | 0 | 0 | 0 |
| `Ride_Trot_Loop` | 1.9 | calf | 1.3 | 0 | 7.5 | 3.0 | calf | 0 | 0 | 2.8 |
| `Ride_Canter_Loop` | 1.7 | thigh | 1.8 | 0 | 1.0 | 2.4 | calf | 0 | 0 | 1.0 |
| `Ride_Gallop_Loop` | 2.5 | calf | 10.6* | 0 | 8.2 | 5.0 | calf | 10.6* | 0 | 3.4 |
| `Ride_Turn_L` | 1.7 | thigh | 5.4* | 0 | 0 | 2.0 | calf | 5.4* | 0 | 0 |
| `Ride_Turn_R` | 1.5 | thigh | 6.7* | 0 | 0 | 2.1 | calf | 4.9* | 0 | 0 |
| `Mount_Horse` | 1.7 | fingers | – | – | – | 1.9 | calf | – | – | – |
| `Dismount_Horse` | 1.7 | fingers | – | – | – | 1.9 | calf | – | – | – |

\* by design: in the gallop the fists ride 10 cm forward down the reins, and in a turn the inside fist opens 5 cm.

The overlaps are contact, not pass-through: the seat's underside pressing into the saddle (the thigh) and the
boot's inner side against the flap and flank (the calf, mostly the right one).
The largest, the female's right calf in the gallop's two-point at 5 cm, presses the flank behind the girth; it does not
show through at the game camera. The female figure is shorter in the leg, so on the same stirrups she rises less out
of the saddle (the recipe keeps every knee bent to at most 96% of the leg). Mounting and dismounting stand on the
ground while the horse idles, so the feet move with its breathing by under a centimetre.

The scripts: `horse.py <horse.glb> <out> <view> [clip=frames]` renders the horse's clips; `ride.py <config.json>`
authors the ride clips on a Ranger, seats it on the horse, measures the fit and renders; `gen.py` runs the ride
recipe's own `generate` as the Ranger build does; `sheet.py` tiles the stills. Shaped and checked in the live Blender
too (the tack's look and the gait poses). Not yet viewed in the game.
