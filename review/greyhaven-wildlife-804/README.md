# Stag combat clips review (#804)

Viewport (material preview) stills of the stag GLB the `greyhaven-wildlife` recipe builds on this branch, imported into
Blender at its shipped 2 m scale, from the game camera's 0.42 rad pitch at 6.5 m, three-quarter front-left. Clips are in
place: `Attack_A`'s charge leaves its 2.0 m `rootTravel` to the consumer.

- `stag-attack-a-strip.jpg`: the lowered-antler charge, frames 0, 5 (weight back on the haunches, antlers lowered,
  forefoot pawing), 11 (lowered-head gallop), 14 (hind legs driving), 15 (contact, 0.625 s), 17 (hook), 20, 25, 32
  (alert stance).
- `stag-attack-b-strip.jpg`: the rearing antler swipe, frames 0, 4 (gathered, head cocked right), 8 (reared, forelegs
  tucked), 11, 12, 13 (contact, 0.542 s, forefeet landing), 16 (follow-through), 20, 26 (alert stance).
- `stag-alert-strip.jpg`: frames 3 (head up), 6 (forefoot lifted), 7 (stamp), 16 (head toss), 24 (alert stance).
- `stag-death-strip.jpg`: frames 6, 12, 15 (head lands, antler tips touch down), 19, 26 (lying, antlers clear of the body).

Ground contact measured with [`../greyhaven-wildlife-782/check.py`](../greyhaven-wildlife-782/check.py) on the built
GLB: `Alert`, `Attack_B` and `Hit` 0 cm, `Attack_A` −3.4 cm (its gallop), `Death` −2.8 cm, `Run` −3.8 cm (source
`Gallop`). Antler-against-body triangle overlap, checked per frame while shaping: none in `Attack_A`, `Alert`, `Hit` or
`Death`; two triangles where the antler base meets the skull at the top of `Attack_B`'s rear.
