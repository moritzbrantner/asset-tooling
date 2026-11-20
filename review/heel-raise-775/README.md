# Stance heel raises (#775)

`adapters/blender/defend_clips.py`'s `stance_pose` (#773) turned the foot about its ball by minus the keyed heel angle,
so every `lh`/`rh` that should raise a heel tipped the toes up and dug the heel into the ground instead. The recipe
documents positive as "raises the heel" and its keys are authored that way (small negatives only point a lifted foot's
toes). `tinker_clips.py` (#777) had copied the stance code with the sign already flipped back; it keeps that sign, and
`defend_clips.py` now matches it.

`Heel_Raise.jpg`: the released clip (left figure) and the fixed recipe's (right), from the side, in `Shield_Guard_Bash`
as the bash lands (`rh` 24: the rear foot drives off its ball) and in `Shield_Block_Impact` as the blow lands (`lh` 12:
the front heel lifts).

Measured on the published male Ranger with the fixed recipe (`gen_defend.py`, its own `generate`), every frame: the
heel-raise range per clip now runs from 0 up (to 23 degrees in the bash), where the released clips ran from 0 down
(to -23). Planted balls stay within 1.2 cm summed travel while on the ground; `Guard_Broken_Stagger`'s right foot
counts 4.3 cm, its step landing.
