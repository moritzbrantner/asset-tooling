"""Original movement-state melee strikes authored on the Ranger rig in Blender (#709: the running and jumping strike per
weapon, and the standing strikes that complete the mace, staff and spear chains).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), from explicit weapon frames solved with two-bone arm IK on top of
a base pose: the first ``Idle_Loop`` pose for the standing strikes, each ``Jog_Fwd_Loop`` frame for the running strikes
and ``Jump_Loop``, ``Jump_Start`` and ``Jump_Land`` poses for the jumping strikes. No source motion is copied beyond
those base poses; the CC0 UAL1 seeds were only watched as reference.

- The one-handed weapons ride ``hand_r.weapon`` (``arguments["sockets"]["weapon"]``): the sword with the shield on
  ``hand_l.shield`` (``shield``), the mace with a free left fist, the dagger with a second dagger on ``hand_l.weapon``
  (``offhand``). The staff and the spear ride ``hand_r.staff`` (``staff``) with the left hand on the shaft on
  ``hand_l.staff`` (``staffLeft``), the shaft sliding through it (``SHAFT_REACH``). A key names the right hand's grip
  (``g``) and the weapon's +Y (``b``); between keys they follow a Hermite curve through the keys, and a blade's edge
  (+X) turns along the tip's motion, so every cut leads with its edge. When the arm alone cannot reach its key, the
  clavicle rolls toward it (``reach``).
- Every strike has one contact: the frame the weapon's strike point (``WEAPONS[...]["tip"]`` up the item's +Y; the
  staff strikes with its foot) reaches its target. The observations record ``contactSeconds``, the strike point there
  in the root frame (``tipAt``), its height band (``band``: ``low`` below ``BANDS[0]`` m, ``high`` above ``BANDS[1]``,
  else ``mid``) and its horizontal reach from the root (``reachMeters``).
- The running strikes are full body on ``Jog_Fwd_Loop``'s legs, one whole cycle long and starting at its first frame,
  so they blend in and out of the run without a stop; the upper body leaves the run's pose and returns to it. The
  jumping strikes are full body: they start in ``Jump_Loop``'s first pose, tuck as ``Jump_Start`` does in the air,
  land as ``Jump_Land`` starts and end in its deepest crouch (``to``), so ``Jump_Land`` or the idle takes over. Both
  record a skirt and cape pose for the #391 chain joints (``secondaryPose``).
- ``Mace_Swing_C``, ``Staff_Strike_C``, ``Spear_Thrust_A`` and ``Spear_Thrust_B`` keep only the ``spine_01`` subtree, as
  the #420 mace and staff chains, and start and end in the first ``Idle_Loop`` pose.
- #711 adds the bare-fist, two-handed maul and bow-in-melee sets on the same rules. The maul rides ``hand_r.weapon``
  with the left hand fixed on its ``grip.offhand``; the bow rides ``hand_l.bow`` (``bow``) and is the left hand's, the
  right a free fist; a bare fist strikes with its ``KNUCKLES`` from the hand the clip names (``hand``). ``Bow_Bash_B``
  kicks (the right ankle on its keys, the strike point the ball of the foot) and ``Unarmed_Run_Strike`` barges with the
  right shoulder; both record that joint as ``strikeJoint``. ``Unarmed_Jab``/``Cross``/``Hook``,
  ``TwoHand_Swing_A``/``B``/``C`` and ``Bow_Bash_A`` keep the ``spine_01`` subtree.
- #711 also authors the hit reactions and deaths (``REACTS``), full body from the first ``Idle_Loop`` pose: the arms,
  chest and whole body turned about the pelvis through keys, the feet planted or riding the body, and no foot, knee or
  hand below the ground (``floor_feet``). They record ``hitSide``, ``peakSeconds`` and, for the deaths, ``landSeconds``
  and how they lie (``lies``), and no contact.

No randomness.
"""
import json
import math
import struct

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 30
UPPER_ROOT = "spine_01"
STAND, RUN, JUMP, TAKEOFF, LAND = "Idle_Loop", "Jog_Fwd_Loop", "Jump_Loop", "Jump_Start", "Jump_Land"
ARMS = {"l": ("upperarm_l", "lowerarm_l", "hand_l"), "r": ("upperarm_r", "lowerarm_r", "hand_r")}
LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
SPINE = (("spine_01", .3), ("spine_02", .35), ("spine_03", .35))
X, Y, UP = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
POLE = {"r": Vector((-.8, .35, -.5)), "l": Vector((.8, .35, -.5))}
FINGERS = ("index", "middle", "ring", "pinky", "thumb")
SOCKETS = ("weapon", "offhand", "shield", "staff", "staffLeft", "bow")
# The hand shapes (as the gather clips): degrees per finger joint toward the palm, and a spread per finger.
SHAPES = {
    "rest": {"curl": {"index": (14, 18, 12), "middle": (16, 20, 12), "ring": (18, 22, 14), "pinky": (20, 24, 14), "thumb": (6, 10, 10)},
             "spread": {"pinky": 4}},
    "grip": {"curl": {"index": (50, 70, 45), "middle": (52, 72, 46), "ring": (54, 72, 46), "pinky": (56, 74, 48), "thumb": (25, 35, 30)},
             "spread": {}},
    "fist": {"curl": {"index": (80, 95, 60), "middle": (82, 95, 60), "ring": (84, 95, 60), "pinky": (86, 95, 60), "thumb": (30, 40, 35)},
             "spread": {}},
}
PALM = Vector((0, .05, .02))

# The weapons: the item, the right hand's socket, the strike point up the item's +Y (metres from the grip; the staff
# strikes with its foot, 0.8 m below) and what the left hand holds. On a staff or a spear the shaft slides through the left
# hand, as in a thrust: it holds the shaft where the shaft passes nearest ``SHAFT_REACH`` ahead of and below its shoulder,
# between ``range`` metres up it from the right hand.
WEAPONS = {
    "sword": {"item": "equipment.sword.arming", "socket": "weapon", "tip": .84, "left": "shield", "leftItem": "equipment.shield.heater"},
    "mace": {"item": "equipment.mace.flanged", "socket": "weapon", "tip": .5, "left": "fist"},
    "dagger": {"item": "equipment.dagger.blackened", "socket": "weapon", "tip": .41, "left": "offhand", "leftItem": "equipment.dagger.blackened"},
    "staff": {"item": "equipment.staff.quarter", "socket": "staff", "tip": -.8, "left": "shaft", "range": (.3, .6)},
    "spear": {"item": "equipment.spear.leaf", "socket": "staff", "tip": 1.46, "left": "shaft", "range": (.15, .6)},
    # #711: the maul's left hand stays on its ``grip.offhand`` frame, 0.22 m down the haft; the strike point is its
    # head. Bare fists strike with the knuckles (``KNUCKLES``) of the hand a clip names (``hand``), the other fist in
    # guard. The bow rides the left hand and strikes with its upper limb, the right a free fist.
    "maul": {"item": "equipment.warhammer.maul", "socket": "weapon", "tip": .68, "left": "shaft", "range": (-.22, -.22)},
    "fist": {"socket": "fist", "left": "guard"},
    "bow": {"item": "equipment.bow.long", "socket": "bow", "side": "l", "tip": .62, "left": "fist"},
}
# A fist's strike point in the palm frame (+Y along the hand, +Z out of the palm): the front of the closed knuckles.
KNUCKLES = Vector((0, .1, .03))
# The free hands' default direction (+Y) and palm (+Z), right hand mirrored from the left; a guard fist's knuckles up.
FREE = {"l": ((-.3, -.6, .6), (-1, 0, 0)), "r": ((.3, -.6, .6), (1, 0, 0))}
GUARD = {"l": ((-.1, -.4, .9), (-1, 0, 0)), "r": ((.1, -.4, .9), (1, 0, 0))}
# The kick's knee pole (ahead and up) and the joints a foot or shoulder strike lands with.
KNEE = Vector((0, -1, .3))
STRIKE_JOINTS = {"foot": "ball_r", "shoulder": "upperarm_r"}
SOCKET_IDS = {"weapon": "hand_r.weapon", "staff": "hand_r.staff", "shield": "hand_l.shield", "offhand": "hand_l.weapon", "shaft": "hand_l.staff",
              "bow": "hand_l.bow"}
SHAFT_REACH = (0, -.3, -.2)
# The height bands of a strike point above the ground (metres): low below the first, high above the second.
BANDS = (.7, 1.4)

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up; metres (the pelvis stands at about z 0.91,
# the shoulders at 1.43, the ground at 0). A positive yaw turns the chest to the figure's left; a positive pitch bends
# it forward; a positive roll leans it to its left; a positive neck tips the head down.
#
# A strike: ``kind`` (``run``, ``jump`` or ``stand``), ``duration`` (a running strike lasts one ``Jog_Fwd_Loop``),
# ``contact`` (the fraction of the contact key) and ``keys`` (fraction, key): the right grip ``g``, the weapon's +Y
# ``b`` and the chest's ``yaw``, ``pitch``, ``roll`` and ``neck`` (0 when absent); the left hand's key ``l`` holds the
# shield (``g``, face ``f``, top ``t``), the off-hand dagger (``g``, blade ``b``) or the fist (``g``) and is held between
# the keys that name it. A strike blends from its base pose into the first key by ``into`` and, unless it ends in a
# crouch, back out of the last from ``out``.
SHIELD_GUARD = {"g": (.1, -.36, 1.22), "f": (-.15, -1, .05), "t": (.05, 0, 1)}
DAGGER_GUARD = {"g": (.2, -.3, 1.06), "b": (-.1, -.7, .7)}
FIST = {"g": (.24, -.2, 1.12)}
# #711: the fists' guard at the chin (the striking hand's own key, and the other hand's), the bow's free right fist and
# the idle's right ankle the kick leaves and returns to. A key may also turn the striking palm (``z``), lift its elbow
# (``e``, the arm's pole) and, on a kick, place the right ankle (``k``) with the foot along ``kd``; a left-handed strike
# (``hand: "l"``) keys the right hand as ``r``.
L_GUARD_KEY = {"b": GUARD["l"][0], "z": GUARD["l"][1]}
R_GUARD_KEY = {"b": GUARD["r"][0], "z": GUARD["r"][1]}
L_GUARD = {"g": (.16, -.3, 1.42), **L_GUARD_KEY}
R_GUARD = {"g": (-.12, -.22, 1.44), **R_GUARD_KEY}
R_FIST = {"g": (-.24, -.2, 1.12)}
IDLE_ANKLE_R = (-.166, .293, .088)
STRIKES = {
    # A forehand diagonal cut on the run: the blade cocked back over the right shoulder, held, then driven down across
    # the body at chest height as the right foot strikes the ground, the shield pulled in.
    "Sword_Run_Strike": {"weapon": "sword", "kind": "run", "contact": .55, "into": .16, "out": .78, "keys": [
        (.16, {"g": (-.24, -.08, 1.44), "b": (-.15, .45, .88), "yaw": -20, "pitch": 2, "l": SHIELD_GUARD}),
        (.42, {"g": (-.3, .04, 1.58), "b": (-.35, .55, .76), "yaw": -34, "pitch": -4, "l": {"g": (.14, -.42, 1.28), "f": (-.2, -1, .1), "t": (.05, 0, 1)}}),
        (.49, {"g": (-.22, -.28, 1.52), "b": (-.15, -.45, .88), "yaw": -10, "pitch": 4}),
        (.55, {"g": (-.06, -.5, 1.2), "b": (.36, -.9, -.22), "yaw": 16, "pitch": 12, "l": {"g": (.24, -.2, 1.14), "f": (-.4, -.9, 0), "t": (0, 0, 1)}}),
        (.68, {"g": (.12, -.3, .9), "b": (.7, -.35, -.62), "yaw": 30, "pitch": 16}),
        (.82, {"g": (.02, -.32, 1.0), "b": (.45, -.65, .3), "yaw": 18, "pitch": 10, "l": SHIELD_GUARD}),
    ]},
    # Leaping in with the blade raised high behind the head, chopping straight down as the feet touch, the follow-through
    # carried low into the landing crouch.
    "Sword_Jump_Strike": {"weapon": "sword", "kind": "jump", "contact": .5, "keys": [
        (.14, {"g": (-.18, -.05, 1.62), "b": (.05, .55, .84), "pitch": -6, "neck": -6, "l": SHIELD_GUARD}),
        (.36, {"g": (-.14, .08, 1.74), "b": (0, .85, .5), "pitch": -14, "neck": -10, "l": {"g": (.16, -.34, 1.36), "f": (-.15, -1, .2), "t": (0, .2, 1)}}),
        (.5, {"g": (-.1, -.48, 1.2), "b": (.02, -.88, -.45), "pitch": 18, "neck": 4, "l": {"g": (.26, -.18, 1.1), "f": (-.3, -.9, 0), "t": (0, 0, 1)}}),
        (.72, {"g": (-.08, -.38, .78), "b": (.08, -.45, -.88), "pitch": 30, "neck": -10}),
        (1.0, {"g": (-.08, -.4, .8), "b": (.12, -.55, -.82), "pitch": 28, "neck": -12, "l": {"g": (.24, -.26, .98), "f": (-.3, -.9, .1), "t": (0, .1, 1)}}),
    ]},
    # An overhand smash on the run: the mace swung back and up behind the shoulder, then brought over and down on to a
    # head-height target, the weight of the head carrying it low.
    "Mace_Run_Strike": {"weapon": "mace", "kind": "run", "contact": .55, "into": .16, "out": .78, "keys": [
        (.16, {"g": (-.26, .02, 1.44), "b": (.05, .6, .8), "yaw": -16, "l": FIST}),
        (.42, {"g": (-.24, .1, 1.64), "b": (0, .7, .72), "yaw": -28, "pitch": -6, "l": {"g": (.22, -.32, 1.2)}}),
        (.49, {"g": (-.2, -.24, 1.62), "b": (0, -.45, .89), "yaw": -8, "pitch": 2}),
        (.55, {"g": (-.12, -.52, 1.26), "b": (.04, -.8, -.6), "yaw": 14, "pitch": 14, "l": {"g": (.26, -.08, 1.08)}}),
        (.68, {"g": (-.06, -.38, .96), "b": (.1, -.35, -.93), "yaw": 20, "pitch": 18}),
        (.82, {"g": (-.14, -.34, 1.1), "b": (0, -.5, .85), "yaw": 10, "pitch": 8, "l": FIST}),
    ]},
    # Leaping with the mace raised overhead in the fist, slammed straight down as the feet touch, driven low.
    "Mace_Jump_Strike": {"weapon": "mace", "kind": "jump", "contact": .5, "keys": [
        (.14, {"g": (-.2, -.02, 1.64), "b": (0, .45, .9), "pitch": -6, "l": FIST}),
        (.36, {"g": (-.14, .08, 1.74), "b": (0, .55, .83), "pitch": -14, "neck": -10, "l": {"g": (.26, -.28, 1.4)}}),
        (.44, {"g": (-.12, -.2, 1.66), "b": (0, -.45, .89), "pitch": -4, "neck": -4}),
        (.5, {"g": (-.1, -.46, 1.18), "b": (0, -.75, -.66), "pitch": 18, "neck": 4, "l": {"g": (.28, -.06, 1.06)}}),
        (.72, {"g": (-.08, -.36, .76), "b": (.05, -.3, -.95), "pitch": 30, "neck": -10}),
        (1.0, {"g": (-.08, -.38, .78), "b": (.05, -.38, -.92), "pitch": 28, "neck": -12, "l": {"g": (.26, -.14, .96)}}),
    ]},
    # A lunging stab on the run: the right dagger drawn back to the hip, then driven straight ahead at the belly, the
    # left dagger held low in guard.
    "Dagger_Run_Strike": {"weapon": "dagger", "kind": "run", "contact": .55, "into": .16, "out": .78, "keys": [
        (.16, {"g": (-.24, -.18, 1.08), "b": (0, -.85, .5), "yaw": -10, "l": DAGGER_GUARD}),
        (.44, {"g": (-.26, .08, 1.1), "b": (.05, -.95, .3), "yaw": -30, "pitch": 4, "l": {"g": (.18, -.36, 1.12), "b": (-.15, -.8, .55)}}),
        (.55, {"g": (-.08, -.56, 1.2), "b": (.05, -1, .05), "yaw": 20, "pitch": 12, "l": {"g": (.24, -.06, 1.0), "b": (-.1, -.6, .8)}}),
        (.68, {"g": (-.08, -.5, 1.16), "b": (.08, -1, -.05), "yaw": 18, "pitch": 12}),
        (.82, {"g": (-.22, -.22, 1.06), "b": (0, -.85, .5), "yaw": 4, "l": DAGGER_GUARD}),
    ]},
    # Leaping with both daggers raised, plunged together down and ahead as the feet touch.
    "Dagger_Jump_Strike": {"weapon": "dagger", "kind": "jump", "contact": .5, "keys": [
        (.14, {"g": (-.2, -.12, 1.5), "b": (0, -.3, .95), "pitch": -6, "l": {"g": (.2, -.12, 1.5), "b": (0, -.3, .95)}}),
        (.36, {"g": (-.18, .02, 1.68), "b": (0, .2, 1), "pitch": -14, "neck": -10, "l": {"g": (.18, .02, 1.68), "b": (0, .2, 1)}}),
        (.5, {"g": (-.12, -.46, 1.14), "b": (0, -.7, -.7), "pitch": 18, "neck": 4, "l": {"g": (.12, -.46, 1.14), "b": (0, -.7, -.7)}}),
        (.72, {"g": (-.12, -.4, .8), "b": (0, -.45, -.9), "pitch": 30, "neck": -10, "l": {"g": (.12, -.4, .8), "b": (0, -.45, -.9)}}),
        (1.0, {"g": (-.14, -.4, .82), "b": (0, -.5, -.86), "pitch": 28, "neck": -12, "l": {"g": (.14, -.4, .82), "b": (0, -.5, -.86)}}),
    ]},
    # A lunging thrust on the run with the staff's foot: the staff drawn back along the body, then driven out straight
    # ahead at chest height, both hands pushing.
    "Staff_Run_Strike": {"weapon": "staff", "kind": "run", "contact": .55, "into": .16, "out": .78, "keys": [
        (.16, {"g": (-.12, -.3, 1.04), "b": (.5, .6, .62), "yaw": 14}),
        (.42, {"g": (-.16, -.1, 1.06), "b": (.45, .75, .5), "yaw": 26, "pitch": -2}),
        (.55, {"g": (-.06, -.58, 1.14), "b": (.25, .92, .3), "yaw": -8, "pitch": 12}),
        (.68, {"g": (-.06, -.52, 1.12), "b": (.28, .9, .32), "yaw": -4, "pitch": 10}),
        (.82, {"g": (-.12, -.32, 1.04), "b": (.5, .6, .62), "yaw": 12, "pitch": 4}),
    ]},
    # Leaping with the staff raised high in both hands, its foot ahead, then driven down into the ground ahead.
    "Staff_Jump_Strike": {"weapon": "staff", "kind": "jump", "contact": .56, "keys": [
        (.14, {"g": (-.12, -.3, 1.2), "b": (.4, .85, .3), "pitch": -4}),
        (.36, {"g": (-.12, -.2, 1.6), "b": (.1, .92, -.38), "pitch": -12, "neck": -8}),
        (.56, {"g": (-.06, -.4, 1.0), "b": (.05, .6, .8), "pitch": 22, "neck": -4}),
        (.72, {"g": (-.06, -.38, .86), "b": (.05, .55, .83), "pitch": 30, "neck": -10}),
        (1.0, {"g": (-.06, -.38, .88), "b": (.05, .56, .82), "pitch": 28, "neck": -12}),
    ]},
    # A lunging spear thrust on the run: the spear level at the hip, drawn back, then driven out at chest height.
    "Spear_Run_Strike": {"weapon": "spear", "kind": "run", "contact": .55, "into": .16, "out": .78, "keys": [
        (.16, {"g": (-.15, .04, 1.08), "b": (.2, -.97, .1), "yaw": -12}),
        (.42, {"g": (-.2, .18, 1.1), "b": (.22, -.96, .15), "yaw": -20, "pitch": -2}),
        (.55, {"g": (-.14, -.2, 1.16), "b": (.1, -.99, .04), "yaw": 8, "pitch": 12}),
        (.68, {"g": (-.14, -.16, 1.14), "b": (.1, -.99, .03), "yaw": 8, "pitch": 10}),
        (.82, {"g": (-.15, .04, 1.08), "b": (.2, -.97, .1), "yaw": -10, "pitch": 4}),
    ]},
    # Leaping with the spear raised overhand, its point driven down into the ground ahead on landing.
    "Spear_Jump_Strike": {"weapon": "spear", "kind": "jump", "contact": .56, "keys": [
        (.14, {"g": (-.2, .04, 1.16), "b": (.2, -.97, .1), "yaw": -8, "pitch": -4}),
        (.36, {"g": (-.22, .14, 1.52), "b": (.12, -.97, -.1), "yaw": -12, "pitch": -12, "neck": -8}),
        (.56, {"g": (-.12, -.16, .98), "b": (.05, -.82, -.57), "yaw": 4, "pitch": 22, "neck": -4}),
        (.72, {"g": (-.12, -.14, .86), "b": (.05, -.78, -.62), "yaw": 4, "pitch": 30, "neck": -10}),
        (1.0, {"g": (-.12, -.14, .88), "b": (.05, -.79, -.61), "yaw": 4, "pitch": 28, "neck": -12}),
    ]},
    # The mace chain's finisher: a big wind-up high over the right shoulder, then a vertical smash down the centre line.
    "Mace_Swing_C": {"weapon": "mace", "kind": "stand", "duration": .9, "contact": .5, "into": .14, "out": .8, "keys": [
        (.14, {"g": (-.26, .0, 1.46), "b": (.05, .55, .84), "yaw": -14, "l": FIST}),
        (.38, {"g": (-.2, .1, 1.7), "b": (-.05, .6, .8), "yaw": -24, "pitch": -10, "neck": -6, "l": {"g": (.24, -.34, 1.24)}}),
        (.45, {"g": (-.14, -.22, 1.62), "b": (0, -.4, .92), "yaw": -8, "pitch": 0}),
        (.5, {"g": (-.1, -.42, 1.2), "b": (0, -.78, -.62), "yaw": 8, "pitch": 18, "l": {"g": (.28, -.06, 1.06)}}),
        (.64, {"g": (-.08, -.3, 1.02), "b": (.08, -.3, -.95), "yaw": 12, "pitch": 22}),
        (.8, {"g": (-.18, -.26, 1.08), "b": (0, -.4, .9), "yaw": 4, "pitch": 8, "l": FIST}),
    ]},
    # The staff chain's third strike: the staff swung up over the head, its foot brought down on a head-height target.
    "Staff_Strike_C": {"weapon": "staff", "kind": "stand", "duration": .8, "contact": .5, "into": .14, "out": .82, "keys": [
        (.14, {"g": (-.12, -.36, 1.04), "b": (.55, .55, .62), "yaw": 16}),
        (.26, {"g": (-.14, -.3, 1.3), "b": (.25, .95, -.15), "yaw": 8}),
        (.38, {"g": (-.14, -.2, 1.6), "b": (.05, .35, -.94), "pitch": -8, "neck": -8}),
        (.5, {"g": (-.08, -.4, 1.16), "b": (.05, .95, .3), "pitch": 14}),
        (.64, {"g": (-.08, -.36, 1.04), "b": (.05, .85, .52), "pitch": 16}),
        (.82, {"g": (-.12, -.36, 1.04), "b": (.55, .55, .62), "yaw": 16}),
    ]},
    # A quick jab: from the guard, the spear drawn back a hand and thrust out at the belly.
    "Spear_Thrust_A": {"weapon": "spear", "kind": "stand", "duration": .6, "contact": .45, "into": .16, "out": .8, "keys": [
        (.16, {"g": (-.15, .04, 1.08), "b": (.2, -.97, .1), "yaw": -12}),
        (.3, {"g": (-.2, .14, 1.08), "b": (.2, -.97, .1), "yaw": -18}),
        (.45, {"g": (-.14, -.14, 1.1), "b": (.1, -.99, .03), "yaw": 6, "pitch": 8}),
        (.6, {"g": (-.15, -.16, 1.08), "b": (.11, -.99, .04), "yaw": 4, "pitch": 6}),
        (.8, {"g": (-.15, .04, 1.08), "b": (.2, -.97, .1), "yaw": -12}),
    ]},
    # A heavier overhand thrust at the face: the spear lifted to the shoulder, cocked back and driven out high.
    "Spear_Thrust_B": {"weapon": "spear", "kind": "stand", "duration": .75, "contact": .5, "into": .14, "out": .82, "keys": [
        (.14, {"g": (-.15, .04, 1.08), "b": (.2, -.97, .1), "yaw": -12}),
        (.36, {"g": (-.26, .16, 1.46), "b": (.15, -.98, -.1), "yaw": -14, "pitch": -6}),
        (.5, {"g": (-.16, -.14, 1.48), "b": (.06, -1, 0), "yaw": 6, "pitch": 6}),
        (.64, {"g": (-.16, -.1, 1.44), "b": (.07, -1, 0), "yaw": 6, "pitch": 6}),
        (.82, {"g": (-.15, .04, 1.08), "b": (.2, -.97, .1), "yaw": -12}),
    ]},
    # --- #711: bare fists. The jab and hook are the left's, the cross the right's; the other fist guards the chin.
    # A quick jab: the left fist drawn back a hand, then snapped straight out at the face, turned palm down.
    "Unarmed_Jab": {"weapon": "fist", "hand": "l", "kind": "stand", "duration": .6, "contact": .4, "into": .16, "out": .8, "keys": [
        (.16, {"g": (.16, -.3, 1.42), "yaw": -6, "r": R_GUARD, **L_GUARD_KEY}),
        (.3, {"g": (.18, -.22, 1.36), "b": (-.05, -.3, .95), "z": (-1, 0, 0), "yaw": 8, "pitch": -2}),
        (.4, {"g": (.08, -.6, 1.42), "b": (-.1, -1, .05), "z": (0, 0, -1), "yaw": -22, "pitch": 6}),
        (.52, {"g": (.09, -.56, 1.41), "b": (-.1, -1, .05), "z": (0, 0, -1), "yaw": -20, "pitch": 6}),
        (.8, {"g": (.16, -.3, 1.42), "yaw": -6, **L_GUARD_KEY}),
    ]},
    # The cross: the weight turned on to the back foot and held, then the right fist driven across at the face, the
    # right shoulder through, the chest turning past square.
    "Unarmed_Cross": {"weapon": "fist", "kind": "stand", "duration": .75, "contact": .48, "into": .14, "out": .8, "keys": [
        (.14, {"g": (-.12, -.22, 1.44), "yaw": -6, "l": L_GUARD, **R_GUARD_KEY}),
        (.38, {"g": (-.16, -.12, 1.38), "b": (.05, -.3, .95), "z": (1, 0, 0), "yaw": -24, "pitch": -2, "roll": 4}),
        (.48, {"g": (.02, -.62, 1.42), "b": (.1, -1, .05), "z": (0, 0, -1), "yaw": 34, "pitch": 10, "roll": -4}),
        (.62, {"g": (.03, -.56, 1.38), "b": (.1, -1, 0), "z": (0, 0, -1), "yaw": 30, "pitch": 9}),
        (.8, {"g": (-.12, -.22, 1.44), "yaw": -6, **R_GUARD_KEY}),
    ]},
    # The hook: the left elbow lifted and the chest wound to the left and held, then the fist swung round level at
    # the side of the head, the chest snapping right.
    "Unarmed_Hook": {"weapon": "fist", "hand": "l", "kind": "stand", "duration": .75, "contact": .5, "into": .14, "out": .8, "keys": [
        (.14, {"g": (.16, -.3, 1.42), "yaw": -4, "r": R_GUARD, **L_GUARD_KEY}),
        (.38, {"g": (.36, -.22, 1.36), "b": (.1, -.7, .3), "z": (-.8, 0, -.5), "e": (1, .3, .2), "yaw": 24, "pitch": 2}),
        (.5, {"g": (.0, -.44, 1.44), "b": (-.9, -.4, 0), "z": (0, 0, -1), "e": (1, -.2, .3), "yaw": -26, "pitch": 8}),
        (.62, {"g": (-.06, -.36, 1.4), "b": (-.9, -.1, 0), "z": (0, 0, -1), "e": (1, -.2, .2), "yaw": -32, "pitch": 8}),
        (.8, {"g": (.16, -.3, 1.42), "yaw": -4, **L_GUARD_KEY}),
    ]},
    # A shoulder barge on the run: both fists tucked to the chest, the right shoulder drawn back, then driven down and
    # through as the right foot lands.
    "Unarmed_Run_Strike": {"weapon": "fist", "kind": "run", "point": "shoulder", "contact": .55, "into": .16, "out": .8, "keys": [
        (.16, {"g": (-.1, -.26, 1.22), "b": (.4, -.4, .8), "z": (1, 0, 0), "yaw": -10, "l": {"g": (.16, -.26, 1.24)}}),
        (.42, {"g": (-.14, -.18, 1.24), "b": (.4, -.4, .8), "z": (1, 0, 0), "yaw": -22, "pitch": 4, "l": {"g": (.18, -.28, 1.26)}}),
        (.55, {"g": (.02, -.2, 1.18), "b": (.6, -.2, .7), "z": (1, 0, 0), "yaw": 38, "pitch": 18, "roll": -12, "l": {"g": (.2, -.12, 1.16)}}),
        (.68, {"g": (.02, -.2, 1.16), "b": (.6, -.2, .7), "z": (1, 0, 0), "yaw": 34, "pitch": 16, "roll": -10}),
        (.82, {"g": (-.1, -.26, 1.22), "b": (.4, -.4, .8), "z": (1, 0, 0), "yaw": 6, "pitch": 6, "l": {"g": (.16, -.26, 1.24)}}),
    ]},
    # Leaping with both fists clasped high overhead, hammered straight down as the feet touch, carried low.
    "Unarmed_Jump_Strike": {"weapon": "fist", "kind": "jump", "contact": .5, "keys": [
        (.14, {"g": (-.06, -.18, 1.5), "b": (0, -.2, 1), "z": (1, 0, 0), "pitch": -6, "l": {"g": (.06, -.18, 1.5), "b": (0, -.2, 1), "z": (-1, 0, 0)}}),
        (.36, {"g": (-.05, .02, 1.78), "b": (0, .45, .9), "z": (1, 0, 0), "pitch": -14, "neck": -10, "l": {"g": (.05, .02, 1.78), "b": (0, .45, .9), "z": (-1, 0, 0)}}),
        (.44, {"g": (-.05, -.24, 1.66), "b": (0, -.5, .85), "z": (1, 0, 0), "pitch": -4, "neck": -4, "l": {"g": (.05, -.24, 1.66), "b": (0, -.5, .85), "z": (-1, 0, 0)}}),
        (.5, {"g": (-.05, -.5, 1.14), "b": (0, -.75, -.65), "z": (1, 0, 0), "pitch": 18, "neck": 4, "l": {"g": (.05, -.5, 1.14), "b": (0, -.75, -.65), "z": (-1, 0, 0)}}),
        (.72, {"g": (-.05, -.4, .8), "b": (0, -.3, -.95), "z": (1, 0, 0), "pitch": 30, "neck": -10, "l": {"g": (.05, -.4, .8), "b": (0, -.3, -.95), "z": (-1, 0, 0)}}),
        (1.0, {"g": (-.06, -.4, .82), "b": (0, -.35, -.93), "z": (1, 0, 0), "pitch": 28, "neck": -12, "l": {"g": (.06, -.4, .82), "b": (0, -.35, -.93), "z": (-1, 0, 0)}}),
    ]},
    # --- #711: the two-handed maul, the left hand on its grip.offhand. Slow: a long held wind-up, a strike of three or
    # four frames and a follow-through the head's weight drags on.
    # A: cocked high over the right shoulder, the head hanging behind, then hewn down across to the left.
    "TwoHand_Swing_A": {"weapon": "maul", "kind": "stand", "duration": 1.1, "contact": .55, "into": .14, "out": .84, "keys": [
        (.14, {"g": (-.18, -.2, 1.3), "b": (-.15, .3, .94), "yaw": -14}),
        (.36, {"g": (-.24, .06, 1.56), "b": (-.3, .75, .58), "yaw": -38, "pitch": -6, "neck": -4}),
        (.45, {"g": (-.26, .08, 1.6), "b": (-.3, .8, .5), "yaw": -42, "pitch": -8, "neck": -4}),
        (.51, {"g": (-.2, -.24, 1.5), "b": (-.2, -.4, .9), "yaw": -16, "pitch": 2}),
        (.55, {"g": (-.02, -.44, 1.18), "b": (.45, -.82, -.35), "yaw": 14, "pitch": 14}),
        (.68, {"g": (.12, -.3, .96), "b": (.75, -.3, -.6), "yaw": 30, "pitch": 20}),
        (.84, {"g": (.08, -.32, 1.0), "b": (.7, -.4, -.55), "yaw": 26, "pitch": 18}),
    ]},
    # B: wound to the left hip, then a flat backhand sweep across to the right at the waist, the hips turning through.
    "TwoHand_Swing_B": {"weapon": "maul", "kind": "stand", "duration": 1.2, "contact": .55, "into": .14, "out": .84, "keys": [
        (.14, {"g": (-.1, -.26, 1.2), "b": (.2, .3, .93), "yaw": 6}),
        (.36, {"g": (.18, -.02, 1.14), "b": (.65, .72, .25), "yaw": 40, "pitch": 4}),
        (.46, {"g": (.2, .0, 1.14), "b": (.62, .76, .2), "yaw": 44, "pitch": 4}),
        (.51, {"g": (.14, -.36, 1.1), "b": (.8, -.55, .1), "yaw": 22, "pitch": 6}),
        (.55, {"g": (-.04, -.46, 1.08), "b": (-.55, -.83, .05), "yaw": -6, "pitch": 8}),
        (.68, {"g": (-.22, -.3, 1.08), "b": (-.92, .2, .1), "yaw": -34, "pitch": 6}),
        (.84, {"g": (-.22, -.24, 1.1), "b": (-.85, .4, .2), "yaw": -38, "pitch": 4}),
    ]},
    # C: the finisher; the maul hauled up overhead until the head hangs behind the back, held, then smashed straight down
    # the centre line.
    "TwoHand_Swing_C": {"weapon": "maul", "kind": "stand", "duration": 1.3, "contact": .56, "into": .14, "out": .86, "keys": [
        (.14, {"g": (-.12, -.24, 1.32), "b": (0, .2, .98), "yaw": -6}),
        (.34, {"g": (-.06, .0, 1.72), "b": (0, .8, .1), "pitch": -10, "neck": -10}),
        (.46, {"g": (-.06, .04, 1.74), "b": (0, .9, -.2), "pitch": -14, "neck": -12}),
        (.52, {"g": (-.06, -.26, 1.64), "b": (0, -.3, .95), "pitch": 0, "neck": -4}),
        (.56, {"g": (-.04, -.46, 1.1), "b": (0, -.86, -.5), "pitch": 18, "neck": 4}),
        (.7, {"g": (-.04, -.38, .9), "b": (0, -.45, -.89), "pitch": 26}),
        (.86, {"g": (-.04, -.38, .92), "b": (0, -.5, -.86), "pitch": 24}),
    ]},
    # On the run: the maul swung back over the right shoulder, then down across the body on the right foot's plant.
    "TwoHand_Run_Strike": {"weapon": "maul", "kind": "run", "contact": .55, "into": .16, "out": .8, "keys": [
        (.16, {"g": (-.18, -.22, 1.28), "b": (-.15, .3, .94), "yaw": -12}),
        (.42, {"g": (-.24, .06, 1.56), "b": (-.3, .75, .58), "yaw": -36, "pitch": -4}),
        (.5, {"g": (-.2, -.24, 1.5), "b": (-.2, -.4, .9), "yaw": -14, "pitch": 4}),
        (.55, {"g": (-.02, -.44, 1.18), "b": (.45, -.82, -.35), "yaw": 14, "pitch": 14}),
        (.68, {"g": (.12, -.3, .98), "b": (.75, -.3, -.6), "yaw": 26, "pitch": 18}),
        (.82, {"g": (-.12, -.26, 1.22), "b": (0, .1, 1), "yaw": 6, "pitch": 8}),
    ]},
    # A ground slam: leaping with the maul raised overhead, the head driven into the ground ahead as the feet touch.
    "TwoHand_Jump_Strike": {"weapon": "maul", "kind": "jump", "contact": .5, "keys": [
        (.14, {"g": (-.12, -.22, 1.4), "b": (0, .3, .95), "pitch": -6}),
        (.36, {"g": (-.06, .02, 1.74), "b": (0, .85, .2), "pitch": -14, "neck": -10}),
        (.44, {"g": (-.06, -.24, 1.62), "b": (0, -.3, .95), "pitch": -4, "neck": -4}),
        (.5, {"g": (-.04, -.42, .92), "b": (0, -.62, -.78), "pitch": 22, "neck": 4}),
        (.72, {"g": (-.04, -.38, .7), "b": (0, -.5, -.86), "pitch": 32, "neck": -10}),
        (1.0, {"g": (-.04, -.38, .72), "b": (0, -.52, -.85), "pitch": 30, "neck": -12}),
    ]},
    # --- #711: the bow in melee, in the left hand (it strikes with its upper limb), the right a fist.
    # A: the bow drawn back across to the right shoulder and held, then whipped out to the left at the head.
    "Bow_Bash_A": {"weapon": "bow", "kind": "stand", "duration": .8, "contact": .5, "into": .14, "out": .82, "keys": [
        (.14, {"g": (.16, -.3, 1.14), "b": (0, -.25, .97), "yaw": 4, "r": R_FIST}),
        (.36, {"g": (-.06, -.24, 1.38), "b": (-.6, .4, .7), "yaw": -26, "pitch": 2}),
        (.44, {"g": (-.08, -.22, 1.4), "b": (-.62, .42, .66), "yaw": -30, "pitch": 2}),
        (.5, {"g": (.22, -.46, 1.3), "b": (.35, -.92, .15), "yaw": 22, "pitch": 8, "r": {"g": (-.26, -.12, 1.1)}}),
        (.64, {"g": (.34, -.3, 1.22), "b": (.9, -.3, .3), "yaw": 32, "pitch": 8}),
        (.82, {"g": (.16, -.3, 1.14), "b": (0, -.25, .97), "yaw": 6, "r": R_FIST}),
    ]},
    # B: the bow held up in guard, the right knee chambered and held, then a push kick driven out at the belly.
    "Bow_Bash_B": {"weapon": "bow", "kind": "stand", "full": True, "point": "foot", "duration": .9, "contact": .48, "into": .12, "out": .84, "keys": [
        (.12, {"g": (.16, -.3, 1.16), "b": (0, -.25, .97), "k": IDLE_ANKLE_R, "kd": (-.1, -.7, -.7), "pitch": 2, "r": R_FIST}),
        (.32, {"g": (.18, -.28, 1.2), "b": (0, -.2, .98), "k": (-.12, -.16, .52), "kd": (0, -.5, -.85), "pitch": -6}),
        (.42, {"g": (.18, -.28, 1.2), "b": (0, -.2, .98), "k": (-.12, -.2, .56), "kd": (0, -.5, -.85), "pitch": -8}),
        (.48, {"g": (.2, -.24, 1.22), "b": (0, -.2, .98), "k": (-.1, -.62, .78), "kd": (0, -.75, .65), "pitch": -16, "r": {"g": (-.28, -.04, 1.14)}}),
        (.6, {"g": (.2, -.24, 1.22), "b": (0, -.2, .98), "k": (-.1, -.54, .7), "kd": (0, -.7, .7), "pitch": -14}),
        (.76, {"g": (.16, -.3, 1.16), "b": (0, -.25, .97), "k": (-.14, .1, .3), "kd": (0, -.6, -.8), "pitch": -2}),
        (.84, {"g": (.16, -.3, 1.16), "b": (0, -.25, .97), "k": IDLE_ANKLE_R, "kd": (-.1, -.7, -.7), "r": R_FIST}),
    ]},
    # On the run: the bow cocked across the chest, then backhanded out to the left on the right foot's plant.
    "Bow_Run_Strike": {"weapon": "bow", "kind": "run", "contact": .55, "into": .16, "out": .8, "keys": [
        (.16, {"g": (.16, -.3, 1.16), "b": (0, -.25, .97), "yaw": 2, "r": R_FIST}),
        (.42, {"g": (-.06, -.24, 1.38), "b": (-.6, .4, .7), "yaw": -24, "pitch": 4}),
        (.55, {"g": (.22, -.46, 1.3), "b": (.35, -.92, .15), "yaw": 22, "pitch": 12, "r": {"g": (-.26, -.12, 1.1)}}),
        (.68, {"g": (.34, -.3, 1.2), "b": (.9, -.3, .3), "yaw": 28, "pitch": 12}),
        (.82, {"g": (.16, -.3, 1.16), "b": (0, -.25, .97), "yaw": 6, "pitch": 6, "r": R_FIST}),
    ]},
    # Leaping with the bow raised high in the left hand, chopped down with the upper limb as the feet touch.
    "Bow_Jump_Strike": {"weapon": "bow", "kind": "jump", "contact": .5, "keys": [
        (.14, {"g": (.16, -.26, 1.4), "b": (0, .1, 1), "pitch": -6, "r": R_FIST}),
        (.36, {"g": (.12, .0, 1.74), "b": (0, .8, .3), "pitch": -14, "neck": -10, "r": {"g": (-.3, -.1, 1.3)}}),
        (.44, {"g": (.12, -.24, 1.66), "b": (0, -.3, .95), "pitch": -4, "neck": -4}),
        (.5, {"g": (.1, -.46, 1.14), "b": (0, -.7, -.7), "pitch": 18, "neck": 4, "r": {"g": (-.28, .02, 1.12)}}),
        (.72, {"g": (.1, -.38, .8), "b": (0, -.35, -.94), "pitch": 30, "neck": -10}),
        (1.0, {"g": (.1, -.38, .82), "b": (0, -.4, -.92), "pitch": 28, "neck": -12, "r": {"g": (-.26, -.1, .98)}}),
    ]},
}
# The jumping strikes' body: ``Jump_Loop``'s first pose, tucked as ``Jump_Start`` is at its highest by ``tuck``, the
# feet touching down in ``Jump_Land``'s first pose at ``touch`` and sinking into its deepest crouch by ``crouch``.
JUMP_BODY = {"duration": .8, "tuck": .3, "touch": .44, "crouch": .72}

# #711: hit reactions and deaths, full body, played on the victim. A key (fraction, fields) holds every field it leaves
# out at the previous key's value: the chest's ``yaw``, ``pitch``, ``roll``, ``neck`` and ``look``; the whole body
# turned about the pelvis by ``tip`` (positive pitches it forward), ``lean`` (positive to its left) and ``spin``
# (positive to its left), in that order, and moved by ``px``, ``py``, ``pz`` (in its own frame before the spin); each
# arm swung forward (``lf``/``rf``), out (``lo``/``ro``) and its elbow bent (``le``/``re``); each ankle moved from where
# it stands in the idle by ``lx``/``ly``/``lz`` (``rx``...) and planted there ``lp``/``rp`` of the way (1: the feet stay
# planted while the body moves; 0: they ride the body). ``peak`` is the hit's moment; a death records when it hits
# the ground (``land``) and how it lies.
# The lowest an ankle and a ball of the foot may go (metres above the ground) while the body falls and lies.
FLOOR = (.07, .02)
REACT_FIELDS = {"yaw": 0, "pitch": 0, "roll": 0, "neck": 0, "look": 0, "tip": 0, "lean": 0, "spin": 0, "px": 0, "py": 0, "pz": 0,
                "lf": 0, "lo": 0, "le": 0, "rf": 0, "ro": 0, "re": 0, "lx": 0, "ly": 0, "lz": 0, "lp": 1, "rx": 0, "ry": 0, "rz": 0, "rp": 1}
REACTS = {
    # A small flinch from a hit on the left: the chest snaps away to the right and the left shoulder back, the weight
    # shifts on to the right foot, the right arm lifts for balance, then all eases back.
    "Hit_Light_L": {"duration": .4, "side": "left", "peak": .25, "keys": [
        (0, {}), (.25, {"roll": -9, "yaw": 12, "neck": 4, "look": -10, "px": -.04, "pz": -.015, "lo": 8, "le": 15, "ro": 14, "re": 10}),
        (.55, {"roll": -3, "yaw": 4, "neck": 1, "look": -3, "px": -.012, "pz": -.005, "lo": 3, "le": 5, "ro": 4, "re": 3}), (1, REACT_FIELDS)]},
    "Hit_Light_R": {"duration": .4, "side": "right", "peak": .25, "keys": [
        (0, {}), (.25, {"roll": 9, "yaw": -12, "neck": 4, "look": 10, "px": .04, "pz": -.015, "ro": 8, "re": 15, "lo": 14, "le": 10}),
        (.55, {"roll": 3, "yaw": -4, "neck": 1, "look": 3, "px": .012, "pz": -.005, "ro": 3, "re": 5, "lo": 4, "le": 3}), (1, REACT_FIELDS)]},
    # A heavy blow to the chest: the chest jolted back and the arms thrown forward, the right foot stepping back to
    # catch the weight, then a step back in and up into the idle.
    "Hit_Heavy_Front": {"duration": .7, "side": "front", "peak": .14, "keys": [
        (0, {}), (.14, {"pitch": -14, "neck": 12, "py": .06, "lf": 28, "rf": 28, "le": 30, "re": 30}),
        (.24, {"pitch": -10, "neck": 8, "py": .12, "pz": -.03, "ry": .14, "rz": .07, "lf": 22, "rf": 22}),
        (.36, {"pitch": -2, "neck": 2, "py": .16, "pz": -.07, "ry": .26, "rz": 0, "lf": 10, "rf": 10, "le": 20, "re": 20}),
        (.55, {"pitch": 6, "neck": 0, "py": .12, "pz": -.05, "ry": .26, "lf": 4, "rf": 4, "le": 12, "re": 12}),
        (.72, {"pitch": 3, "py": .04, "pz": -.02, "ry": .1, "rz": .05}), (1, REACT_FIELDS)]},
    # Thrown back: the arms flung up, the knees buckling, the body tipping over backwards on to its back, a small
    # bounce, and lying still with the arms out and the head rolled aside.
    "Death_Back": {"duration": 1.4, "side": "front", "peak": .1, "land": .7, "lies": "back", "keys": [
        (0, {}), (.1, {"pitch": -12, "neck": 10, "py": .06, "lf": 45, "rf": 45, "le": 30, "re": 30}),
        (.3, {"pitch": -6, "neck": 4, "tip": -12, "py": .1, "pz": -.22, "lf": 55, "rf": 50, "lo": 20, "ro": 20}),
        (.52, {"tip": -50, "py": .26, "pz": -.5, "lp": .3, "rp": .3, "lf": 40, "rf": 40, "lo": 45, "ro": 45, "neck": -8}),
        (.7, {"tip": -90, "py": .38, "pz": -.77, "lp": 0, "rp": 0, "lf": 6, "rf": 8, "lo": 70, "ro": 65, "le": 12, "re": 14, "neck": 8}),
        (.8, {"tip": -83, "pz": -.75, "neck": 4}),
        (1, {"tip": -87, "pz": -.78, "lf": -4, "rf": -2, "lo": 60, "ro": 52, "le": 6, "re": 8, "neck": 6, "look": 35})]},
    # Folding forward: doubled over, the knees giving way on to the ground, then pitching forward on to the front, the
    # arms out to the sides and the head turned on its cheek.
    "Death_Fwd": {"duration": 1.5, "side": "front", "peak": .1, "land": .74, "lies": "front", "keys": [
        (0, {}), (.1, {"pitch": 18, "neck": 10, "py": .04, "lf": 12, "rf": 12, "le": 50, "re": 50}),
        (.38, {"pitch": 24, "neck": 12, "tip": 8, "py": .12, "pz": -.42, "lf": 18, "rf": 18, "le": 45, "re": 45}),
        (.56, {"pitch": 14, "neck": 4, "tip": 40, "py": -.06, "pz": -.52, "lp": .5, "rp": .5, "lo": 25, "ro": 25, "le": 30, "re": 30}),
        (.74, {"pitch": 0, "neck": -6, "tip": 90, "py": -.4, "pz": -.76, "lp": 0, "rp": 0, "lo": 55, "ro": 50, "lf": 0, "rf": 0, "le": 20, "re": 20}),
        (.84, {"tip": 84, "pz": -.74, "look": 30}),
        (1, {"tip": 87, "pz": -.77, "neck": -10, "look": 70, "lf": -10, "rf": -10, "lo": 70, "ro": 65, "le": 10, "re": 10})]},
    # Spun round to its right by the blow, staggering, the arms flung wide, the knees giving way and toppling on to its
    # right side, lying curled with the left arm thrown over.
    "Death_Spin": {"duration": 1.6, "side": "left", "peak": .08, "land": .76, "lies": "side", "keys": [
        (0, {}), (.08, {"yaw": 20, "roll": -10, "spin": -20, "lp": .6, "rp": .6, "lo": 30, "ro": 40, "le": 20}),
        (.3, {"yaw": 30, "roll": -6, "spin": -110, "lp": .2, "rp": .2, "pz": -.08, "lo": 60, "ro": 55, "lf": 20}),
        (.52, {"yaw": 14, "roll": -14, "spin": -180, "lean": -20, "px": -.08, "pz": -.25, "lp": 0, "rp": 0, "lo": 45, "ro": 35, "le": 40}),
        (.76, {"yaw": 0, "roll": -4, "spin": -205, "lean": -88, "px": -.3, "pz": -.74, "lo": 20, "lf": 60, "rf": 60, "ro": 10, "le": 30, "re": 20, "neck": 6}),
        (.86, {"lean": -82, "pz": -.72}),
        (1, {"lean": -86, "pz": -.75, "pitch": 14, "lf": 60, "lo": 10, "le": 40, "rf": 80, "ro": 0, "re": 30, "neck": 10, "look": -15})]},
}

CLIPS = (*STRIKES, *REACTS)
UPPER = {name for name, spec in STRIKES.items() if spec["kind"] == "stand" and not spec.get("full")}
# The #391 chain joints the full-body clips key, and how far the panels follow the thighs (as the social clips).
CAPE = "cape_01"
SWING = {"share": .7, "front": 70.0, "sideShare": .8, "side": 75.0, "back": 20.0}
BACK = Vector((0, 1, 0))
PLUMB = ("skirt_f_03", "skirt_l_02", "skirt_r_02")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets"}:
        raise ValueError("strike clips require exactly schemaVersion, clips and sockets")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"strike clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"strike clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    if set(inputs) != {"target"}:
        raise ValueError("strike clips take exactly the declared input target")


def gltf_rest_worlds(path):
    """World matrices (glTF axes) of every named node of the declared target, at rest."""
    data = open(path, "rb").read()
    doc = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]] if data[:4] == b"glTF" else data)
    nodes, worlds = doc["nodes"], {}

    def local(node):
        if "matrix" in node:
            m = node["matrix"]
            return Matrix([m[0:4], m[4:8], m[8:12], m[12:16]]).transposed()
        r = node.get("rotation", [0, 0, 0, 1])
        return Matrix.LocRotScale(Vector(node.get("translation", [0, 0, 0])), Quaternion((r[3], r[0], r[1], r[2])),
                                  Vector(node.get("scale", [1, 1, 1])))

    def walk(index, parent):
        world = parent @ local(nodes[index])
        if "name" in nodes[index]:
            worlds[nodes[index]["name"]] = world
        for child in nodes[index].get("children", []):
            walk(child, world)

    for root in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        walk(root, Matrix.Identity(4))
    return worlds


def action_curves(action):
    curves = list(getattr(action, "fcurves", None) or [])
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                curves.extend(bag.fcurves)
    return curves


def smooth(u):
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)


def window(u, start, end):
    return smooth((u - start) / (end - start))


def v(t):
    return Vector(t)


def frame_of(position, y_axis, z_hint):
    """A frame at ``position`` whose +Y is ``y_axis`` and +Z as close to ``z_hint`` as it can be."""
    yy = y_axis.normalized()
    zz = z_hint - yy * z_hint.dot(yy)
    if zz.length < 1e-4:
        zz = (Vector((1, 0, 0)) if abs(yy.x) < .9 else Vector((0, 0, 1))).cross(yy)
    zz.normalize()
    m = Matrix((yy.cross(zz), yy, zz)).transposed().to_4x4()
    m.translation = position
    return m


def palm_frame(point, y_axis, z_hint, offset=PALM):
    """The palm (wrist) frame whose ``offset`` point lands on ``point``."""
    m = frame_of(Vector(), y_axis, z_hint)
    m.translation = point - m.to_3x3() @ offset
    return m


class Rig:
    def __init__(self, rig, sockets, rest_gltf):
        self.rig = rig
        self.bones = rig.pose.bones
        self.rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}
        self.rest_gltf = rest_gltf
        # The socket frame in its joint's bone frame: the frame in armature space is the bone matrix times this.
        self.socket = {}
        for name, s in sockets.items():
            joint, r = s["joint"], s["rotation"]
            local = Matrix.LocRotScale(Vector(s["translation"]), Quaternion((r[3], r[0], r[1], r[2])), Vector((1, 1, 1)))
            self.socket[name] = (joint, self.rest[joint].inverted() @ C4 @ rest_gltf[joint] @ local)
        # The palms: at the wrist, +Y along the hand toward the fingers, +Z out of the palm (down in the rest T-pose).
        for side in "lr":
            joint = f"hand_{side}"
            rest = self.rest[joint]
            self.socket[f"palm_{side}"] = (joint, rest.inverted() @ frame_of(rest.translation, rest.to_3x3() @ Y, Vector((0, 0, -1))))

    def capture(self):
        return {pb.name: pb.matrix_basis.copy() for pb in self.bones}

    def apply(self, pose):
        for name, basis in pose.items():
            self.bones[name].matrix_basis = basis
        bpy.context.view_layer.update()

    def head(self, name):
        return self.bones[name].head.copy()

    def length(self, a, b):
        return (self.rest[b].translation - self.rest[a].translation).length

    def grip(self, name):
        joint, local = self.socket[name]
        return self.bones[joint].matrix @ local


def sample(rig, action, seconds):
    """The pose of ``action`` at ``seconds`` from its start."""
    data = rig.rig.animation_data
    data.action = action
    if hasattr(data, "action_slot") and action.slots:
        data.action_slot = action.slots[0]
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    frame = action.frame_range[0] + seconds * fps
    bpy.context.scene.frame_set(int(math.floor(frame)), subframe=frame - math.floor(frame))
    bpy.context.view_layer.update()
    pose = rig.capture()
    data.action = None
    return pose


def action_seconds(action):
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    return (action.frame_range[1] - action.frame_range[0]) / fps


def rotate_world(rig, name, axis, degrees, pivot=None):
    pb = rig.bones[name]
    head = (pivot if pivot is not None else pb.matrix.translation).copy()
    pb.matrix = Matrix.Translation(head) @ Matrix.Rotation(math.radians(degrees), 4, axis) @ Matrix.Translation(-head) @ pb.matrix
    bpy.context.view_layer.update()


def aim(rig, name, direction):
    pb = rig.bones[name]
    current = (pb.matrix.to_3x3() @ Vector((0, 1, 0))).normalized()
    turn = current.rotation_difference(direction.normalized()).to_matrix()
    m = (turn @ pb.matrix.to_3x3()).to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


def two_bone(rig, a, b, c, target, pole):
    root = rig.head(a)
    l1, l2 = rig.length(a, b), rig.length(b, c)
    reach = target - root
    d = max(min(reach.length, (l1 + l2) * .999), abs(l1 - l2) + 1e-3)
    u = reach.normalized()
    x = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    h = math.sqrt(max(l1 * l1 - x * x, 0.0))
    side = pole - u * pole.dot(u)
    side = side.normalized() if side.length > 1e-6 else Vector((0, 0, -1))
    middle = root + u * x + side * h
    aim(rig, a, middle - root)
    aim(rig, b, (root + u * d) - middle)


def place_grip(rig, socket, frame, pole):
    """Solve the arm holding ``socket`` so its frame lands on ``frame``; half the hand's twist goes to the forearm."""
    joint, local = rig.socket[socket]
    side = joint[-1]
    upper, lower, hand = ARMS[side]
    want = frame @ local.inverted()
    two_bone(rig, upper, lower, hand, want.translation, pole)
    rotation = want.to_3x3()
    fore = rig.bones[lower]
    axis = (fore.matrix.to_3x3() @ Vector((0, 1, 0))).normalized()
    relative = (rotation @ fore.matrix.to_3x3().inverted()).to_quaternion()
    projected = Vector((relative.x, relative.y, relative.z)).project(axis)
    if projected.length > 1e-9:
        twist = Quaternion((relative.w, *projected)).normalized()
        m = (Quaternion().slerp(twist, .5).to_matrix() @ fore.matrix.to_3x3()).to_4x4()
        m.translation = fore.head.copy()
        fore.matrix = m
        bpy.context.view_layer.update()
    m = rotation.to_4x4()
    m.translation = rig.bones[hand].head.copy()
    rig.bones[hand].matrix = m
    bpy.context.view_layer.update()


class Hands:
    """The finger poses: the seed's, and each hand shape keyed on top of the rest pose (local, so they hold in every
    arm pose)."""

    def __init__(self, rig, seed):
        self.joints = {side: [f"{f}_{k}_{side}" for f in FINGERS for k in ("01", "02", "03")] for side in "lr"}
        self.shapes = {side: {"seed": {n: seed[n].copy() for n in self.joints[side]}} for side in "lr"}
        rig.apply({name: Matrix.Identity(4) for name in rig.rest})
        palm = Vector((0, 0, -1))
        for side in "lr":
            for shape, spec in SHAPES.items():
                rig.apply({n: Matrix.Identity(4) for n in self.joints[side]})
                for finger in FINGERS:
                    chain = [f"{finger}_{k}_{side}" for k in ("01", "02", "03")]
                    along = (rig.bones[chain[1]].head - rig.bones[chain[0]].head).normalized()
                    hinge = along.cross(palm).normalized()
                    spread = spec["spread"].get(finger, 0.0)
                    if spread:
                        middle = (rig.bones[f"middle_02_{side}"].head - rig.bones[f"middle_01_{side}"].head).normalized()
                        away = 1.0 if along.cross(middle).dot(palm) > 0 else -1.0
                        rotate_world(rig, chain[0], palm, -away * spread)
                    for k, joint in enumerate(chain):
                        rotate_world(rig, joint, hinge, spec["curl"][finger][k])
                self.shapes[side][shape] = {n: rig.bones[n].matrix_basis.copy() for n in self.joints[side]}
        rig.apply(seed)

    def blend(self, side, a, b, u):
        out = {}
        for name in self.joints[side]:
            la, ra, _ = self.shapes[side][a][name].decompose()
            lb, rb, _ = self.shapes[side][b][name].decompose()
            if ra.dot(rb) < 0:
                rb.negate()
            out[name] = Matrix.Translation(la.lerp(lb, u)) @ ra.slerp(rb, u).to_matrix().to_4x4()
        return out


def secondary(rig, follow=0.0):
    """The #391 chain pose of this frame (as adapters/blender/social_clips.py): per chain joint it keys, its local
    rotation (glTF xyzw) under its parent (``pelvis``, ``spine_03`` for ``cape_01``, the joint above for the plumb
    joints). The front panel rides the higher thigh, each side panel follows its own thigh out and forward, and past the
    knee both hang plumb over the shin; the back panel and the cape hang but never pass into the legs or the back."""
    down = Vector((0, 0, -1))
    thigh = {s: (rig.bones[LEGS[s][1]].head - rig.bones[LEGS[s][0]].head).normalized() for s in "lr"}
    lift = {s: math.degrees(math.atan2(max(0.0, -thigh[s].y), max(1e-6, -thigh[s].z))) if thigh[s].z < 0 else 90.0 for s in "lr"}
    reach = max(0.0, *(math.degrees(math.asin(max(0.0, min(1.0, thigh[s].y)))) for s in "lr"))
    turn = lambda degrees: Matrix.Rotation(math.radians(degrees), 3, Vector((1, 0, 0))) @ down

    def toward(direction, share, limit):
        angle = min(limit, share * math.degrees(down.angle(direction)))
        axis = down.cross(direction)
        return Matrix.Rotation(math.radians(angle), 3, axis.normalized()) @ down if axis.length > 1e-6 else down

    directions = {
        "skirt_f_01": turn(-min(SWING["front"], SWING["share"] * max(lift.values()))),
        "skirt_b_01": turn(min(SWING["back"], SWING["share"] * reach)),
        "skirt_l_01": toward(thigh["l"], SWING["sideShare"], SWING["side"]),
        "skirt_r_01": toward(thigh["r"], SWING["sideShare"], SWING["side"]),
    }
    spine = rig.bones["spine_03"].matrix.to_3x3()
    back = (spine @ rig.rest["spine_03"].to_3x3().inverted() @ BACK).normalized()
    cape = down.copy()
    if cape.dot(back) < .1:
        cape = (cape + back * (.1 - cape.dot(back))).normalized()
    directions[CAPE] = cape
    gltf = lambda m: C4.to_3x3().inverted() @ m @ C4.to_3x3()
    out, swings = {}, {}
    for joint, direction in directions.items():
        parent = "spine_03" if joint == CAPE else "pelvis"
        delta = (rig.bones[parent].matrix.to_3x3() @ rig.rest[parent].to_3x3().inverted())
        parent_world = gltf(delta) @ rig.rest_gltf[parent].to_3x3()
        swings[joint] = gltf(down.rotation_difference(direction).to_matrix())
        out[joint] = (parent_world.inverted() @ swings[joint]).to_quaternion()
    # The chain joints rest with no rotation in the world, so a joint hanging plumb under a turned first joint (the
    # joints between keep its turn) takes its inverse turn: the front panel from its third joint, past the knee.
    for joint in PLUMB:
        out[joint] = swings[joint[:-2] + "01"].inverted().to_quaternion()
    return {joint: [round(q.x, 5), round(q.y, 5), round(q.z, 5), round(q.w, 5)] for joint, q in out.items()}


def record_chains(rig, poses):
    chains = {}
    for pose in poses:
        rig.apply(pose)
        for joint, rotation in secondary(rig).items():
            chains.setdefault(joint, []).append(rotation)
    return {"sampleRate": FPS, "joints": chains}


def upper_joints(rig):
    return [UPPER_ROOT, *(bone.name for bone in rig.rig.data.bones[UPPER_ROOT].children_recursive)]


def root_point(p):
    """An armature-space point in the root's glTF axes (+Y up, +Z facing), rounded."""
    g = C4.inverted() @ p
    return [round(g.x, 4), round(g.y, 4), round(g.z, 4)]


def frames_of(duration):
    return int(round(duration * FPS))


def turn_chest(rig, yaw=0.0, pitch=0.0, roll=0.0, neck=0.0, gaze=.5, look=0.0):
    """Spread a chest turn over spine_01-03; the neck and head take back ``gaze`` of the yaw and half the pitch, then
    tip by ``neck`` (negative looks up) and turn ``look`` degrees more to the figure's left."""
    for joint, share in SPINE:
        if yaw:
            rotate_world(rig, joint, UP, yaw * share)
        if pitch:
            rotate_world(rig, joint, X, pitch * share)
        if roll:
            rotate_world(rig, joint, Y, -roll * share)
    if yaw * gaze - look:
        rotate_world(rig, "neck_01", UP, -yaw * gaze + look)
    if pitch - 2 * neck:
        rotate_world(rig, "neck_01", X, -pitch * .5 + neck)


def blend(a, b, w):
    la, ra, _ = a.decompose()
    lb, rb, _ = b.decompose()
    return Matrix.LocRotScale(la.lerp(lb, w), ra.slerp(rb, w), Vector((1, 1, 1)))


def one_shot(duration, frame):
    count = frames_of(duration)
    return [frame(k / count) for k in range(count + 1)]


def blend_poses(a, b, w):
    return {name: blend(a[name], b[name], w) for name in a}


def item_frame(position, y_axis, x_hint):
    """A grip frame at ``position`` whose +Y is ``y_axis`` and +X (the edge) as close to ``x_hint`` as it can be."""
    yy = y_axis.normalized()
    xx = x_hint - yy * x_hint.dot(yy)
    if xx.length < 1e-4:
        xx = (Vector((0, 0, 1)) if abs(yy.z) < .9 else Vector((1, 0, 0))).cross(yy)
    xx.normalize()
    m = Matrix((xx, yy, xx.cross(yy))).transposed().to_4x4()
    m.translation = position
    return m


def shield_frame(g, face, top):
    """The shield grip frame: its face (+Z) towards ``face`` and its top (+Y) towards ``top``."""
    zz = face.normalized()
    yy = (top - zz * top.dot(zz)).normalized()
    m = Matrix((yy.cross(zz), yy, zz)).transposed().to_4x4()
    m.translation = g
    return m


def reach(rig, socket, frame, limit=20.0):
    """Roll the shoulder toward ``frame`` when the arm alone cannot reach it: the clavicle turns about its root by at
    most ``limit`` degrees, as far as the shortfall needs."""
    joint, local = rig.socket[socket]
    side = joint[-1]
    upper, lower, hand = ARMS[side]
    clavicle = f"clavicle_{side}"
    root, shoulder = rig.head(clavicle), rig.head(upper)
    wrist = (frame @ local.inverted()).translation
    short = (wrist - shoulder).length - (rig.length(upper, lower) + rig.length(lower, hand)) * .98
    a, b = shoulder - root, wrist - root
    if short <= 0 or a.cross(b).length < 1e-6:
        return
    angle = min(math.radians(limit), a.angle(b), math.asin(min(1.0, short / a.length)))
    rotate_world(rig, clavicle, a.cross(b).normalized(), math.degrees(angle), pivot=root)


def hermite(keys, u):
    """A curve through ``keys`` ((fraction, value) pairs, values floats or Vectors): the slope at an inner key is its
    neighbours' difference over their spacing, the ends ease in and out, and it holds past the ends."""
    if u <= keys[0][0]:
        return keys[0][1]
    if u >= keys[-1][0]:
        return keys[-1][1]
    i = max(k for k in range(len(keys) - 1) if keys[k][0] <= u)
    (t0, p0), (t1, p1) = keys[i], keys[i + 1]

    def slope(k):
        if k == 0 or k == len(keys) - 1:
            return p0 * 0
        return (keys[k + 1][1] - keys[k - 1][1]) / (keys[k + 1][0] - keys[k - 1][0])

    h = t1 - t0
    s = (u - t0) / h
    s2, s3 = s * s, s * s * s
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * h * slope(i) + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * h * slope(i + 1)


class Motion:
    """A strike's keys as curves: the right grip and weapon direction, the chest scalars and the left hand's key."""

    def __init__(self, spec, off="l"):
        keys = spec["keys"]
        self.grip = [(u, v(k["g"])) for u, k in keys]
        self.blade = [(u, v(k["b"]).normalized()) for u, k in keys]
        self.chest = {name: [(u, float(k.get(name, 0.0))) for u, k in keys] for name in ("yaw", "pitch", "roll", "neck")}
        # The striking palm, elbow pole and kicking ankle and foot, each through the keys that name it.
        self.extra = {name: [(u, v(k[name])) for u, k in keys if name in k] for name in ("z", "e", "k", "kd")}
        self.left = {}
        for u, k in keys:
            for name, value in k.get(off, {}).items():
                self.left.setdefault(name, []).append((u, v(value)))
        # A key that leaves the left hand out holds it where the last named it.
        named = [u for u, k in keys if off in k]
        for name, track in self.left.items():
            if named and track[-1][0] < keys[-1][0]:
                track.append((keys[-1][0], track[-1][1]))

    def at(self, u):
        g, b = hermite(self.grip, u), hermite(self.blade, u).normalized()
        return g, b, {name: hermite(track, u) for name, track in self.chest.items()}

    def left_at(self, u):
        return {name: hermite(track, u) for name, track in self.left.items()}

    def extra_at(self, u):
        return {name: hermite(track, u) for name, track in self.extra.items() if track}


class Striker:
    """The clip-independent state of one strike: the rig, its weapon, the striking hand, the finger shapes and the
    motion."""

    def __init__(self, rig, seed, clip):
        self.rig, self.seed, self.clip = rig, seed, clip
        self.spec = STRIKES[clip]
        self.weapon = WEAPONS[self.spec["weapon"]]
        self.side = self.spec.get("hand", self.weapon.get("side", "r"))
        self.off = "l" if self.side == "r" else "r"
        self.motion = Motion(self.spec, self.off)
        self.hands = Hands(rig, seed)
        self.fist = self.weapon["socket"] == "fist"
        self.socket = f"palm_{self.side}" if self.fist else self.weapon["socket"]
        self.tip = KNUCKLES if self.fist else Vector((0, self.weapon["tip"], 0))

    def weapon_frame(self, u, du=.01):
        """The striking hand's socket frame at ``u``: the grip and direction of the keys, the edge (+X) turned along the
        strike point's motion (half a turn toward it when it barely moves). A fist turns its palm (+Z) toward the key's
        ``z``, the bow its string (+Z) back toward the body."""
        g, b, chest = self.motion.at(u)
        extra = self.motion.extra_at(u)
        if self.fist:
            hint = extra.get("z", Vector((0, 0, -1)))
            return palm_frame(g, b, hint, offset=KNUCKLES), chest
        if self.weapon["socket"] == "bow":
            return frame_of(g, b, extra.get("z", Vector((-.3, .8, 0)))), chest
        a, b0, _ = self.motion.at(max(0.0, u - du))
        c, b1, _ = self.motion.at(min(1.0, u + du))
        reach = self.weapon["tip"]
        velocity = (c + b1 * reach) - (a + b0 * reach)
        sideways = velocity - b * velocity.dot(b)
        hint = Vector((-.2, -.3, .9)) if self.weapon["socket"] == "weapon" else Vector((-.4, -.6, .3))
        w = min(1.0, sideways.length / .06)
        edge = hint.normalized().lerp(sideways.normalized() if sideways.length > 1e-6 else hint.normalized(), w)
        if self.weapon["socket"] == "staff":
            return frame_of(g, b, Vector((-.4, -.6, .3))), chest
        return item_frame(g, b, edge), chest

    def place(self, u):
        """Turn the chest, put both hands on their keys and, on a kick, the right foot on its key, on whatever body
        the rig holds."""
        rig = self.rig
        frame, chest = self.weapon_frame(u)
        extra = self.motion.extra_at(u)

        def hold(socket, target, pole):
            reach(rig, socket, target)
            place_grip(rig, socket, target, pole)

        turn_chest(rig, chest["yaw"], chest["pitch"], chest["roll"], chest["neck"])
        hold(self.socket, frame, extra.get("e", POLE[self.side]))
        left = self.weapon["left"]
        keys = self.motion.left_at(u)
        off = self.off
        if left == "shaft":
            shaft = frame.to_3x3().col[1].normalized()
            back = frame.to_3x3().col[2]
            want = rig.head("upperarm_l") + v(SHAFT_REACH)
            low, high = self.weapon["range"]
            self.on_shaft = min(high, max(low, (want - frame.translation).dot(shaft)))
            hold("staffLeft", frame_of(frame.translation + shaft * self.on_shaft, shaft, Vector((-back.x, back.y, back.z))), POLE["l"])
        elif left == "shield":
            hold("shield", shield_frame(keys["g"], keys["f"], keys["t"]), POLE["l"])
        elif left == "offhand":
            hold("offhand", item_frame(keys["g"], keys["b"], Vector((.2, -.3, .9))), POLE["l"])
        elif left == "guard":
            direction, palm = GUARD[off]
            hold(f"palm_{off}", palm_frame(keys["g"], keys.get("b", v(direction)), keys.get("z", v(palm)), offset=KNUCKLES), POLE[off])
        else:
            direction, palm = FREE[off]
            hold(f"palm_{off}", palm_frame(keys["g"], v(direction), v(palm)), POLE[off])
        if "k" in extra:
            kick(rig, extra["k"], extra["kd"])
        strike = "fist" if self.fist else "grip"
        rest = "fist" if left in ("fist", "guard") else "grip"
        for side, shape in ((self.side, strike), (off, rest)):
            rig.apply(self.hands.blend(side, shape, shape, 1.0))
        return frame

    def pose(self, base, u, w):
        """The base pose with the strike laid over it ``w`` of the way."""
        rig = self.rig
        rig.apply(base)
        self.place(u)
        struck = rig.capture()
        return blend_poses(base, struck, w) if w < 1 else struck

    def contact(self, base, u):
        """Where the solved body puts the strike point at the contact frame, in the root frame, its band and reach: the
        weapon's strike point, the knuckles, the ball of the kicking foot or the barging shoulder."""
        rig = self.rig
        rig.apply(base)
        self.place(u)
        point = self.spec.get("point")
        tip = rig.head(STRIKE_JOINTS[point]) if point else rig.grip(self.socket) @ self.tip
        at = root_point(tip)
        reach = round(math.hypot(at[0], at[2]), 4)
        band = "low" if at[1] < BANDS[0] else "high" if at[1] > BANDS[1] else "mid"
        if self.fist:
            weapon = {"joint": f"hand_{self.side}"}
        else:
            weapon = {"item": self.weapon["item"], "socket": SOCKET_IDS[self.weapon["socket"]], "strikePoint": [0, self.weapon["tip"], 0]}
        left = self.weapon["left"]
        held = {"item": self.weapon["leftItem"], "socket": SOCKET_IDS[left]} if "leftItem" in self.weapon else None
        if left == "shaft":
            held = {"socket": SOCKET_IDS["shaft"], "onShaftMeters": round(self.on_shaft, 4)}
        return {"weapon": weapon, **({"offhand": held} if held else {}), **({"strikeJoint": STRIKE_JOINTS[point]} if point else {}),
                "tipAt": at, "band": band, "reachMeters": reach}


def kick(rig, ankle, along):
    """Put the right ankle on ``ankle``, the knee ahead and up, and turn the foot so its ball lies along ``along``."""
    thigh, calf, foot, ball = LEGS["r"]
    two_bone(rig, thigh, calf, foot, ankle, KNEE)
    toward = rig.head(ball) - rig.head(foot)
    turn = toward.rotation_difference(along.normalized())
    pb = rig.bones[foot]
    m = (turn.to_matrix() @ pb.matrix.to_3x3()).to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


def contact_frame(spec, count):
    return int(round(spec["contact"] * count))


# --- The strikes -----------------------------------------------------------------------------------------------------


def stand_strike(striker, actions):
    """A standing strike: from the idle, through the keys and back to the idle."""
    spec = striker.spec
    count = frames_of(spec["duration"])
    hit = contact_frame(spec, count)

    def frame(u):
        w = window(u, 0.0, spec["into"]) * (1 - window(u, spec["out"], 1.0))
        return striker.pose(striker.seed, u, w)

    poses = one_shot(spec["duration"], frame)
    return poses, {"contactSeconds": round(hit / FPS, 4), **striker.contact(striker.seed, hit / count)}


def run_strike(striker, actions):
    """A running strike over one whole ``Jog_Fwd_Loop`` cycle: the legs run on, the upper body leaves the run's pose,
    strikes and returns to it."""
    spec, rig = striker.spec, striker.rig
    run = actions[RUN]
    duration = action_seconds(run)
    count = frames_of(duration)
    hit = contact_frame(spec, count)
    bases = [sample(rig, run, k / count * duration) for k in range(count + 1)]
    poses = []
    for k in range(count + 1):
        u = k / count
        w = window(u, 0.0, spec["into"]) * (1 - window(u, spec["out"], 1.0))
        poses.append(striker.pose(bases[k], u, w))
    return poses, {"source": RUN, "durationSeconds": round(duration, 4), "contactSeconds": round(hit / FPS, 4),
                   **striker.contact(bases[hit], hit / count)}


def lowest_pelvis(rig, action):
    """The time of ``action``'s lowest pelvis (its deepest crouch), on its own frames."""
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    first, last = (int(round(f)) for f in action.frame_range)
    best = None
    for f in range(first, last + 1):
        seconds = (f - first) / fps
        rig.apply(sample(rig, action, seconds))
        z = rig.bones["pelvis"].head.z
        if best is None or z < best[0]:
            best = (z, seconds)
    return best[1]


def highest_feet(rig, action):
    """The time ``action`` lifts its feet highest (the tuck in the air), on its own frames."""
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    first, last = (int(round(f)) for f in action.frame_range)
    best = None
    for f in range(first, last + 1):
        seconds = (f - first) / fps
        rig.apply(sample(rig, action, seconds))
        z = rig.bones["foot_l"].head.z + rig.bones["foot_r"].head.z
        if best is None or z > best[0]:
            best = (z, seconds)
    return best[1]


def jump_strike(striker, actions):
    """A jumping strike: from ``Jump_Loop``'s first pose, tucked in the air, touching down as ``Jump_Land`` starts and
    sinking into its deepest crouch, where it ends."""
    spec, rig, body = striker.spec, striker.rig, JUMP_BODY
    tuck_at = highest_feet(rig, actions[TAKEOFF])
    crouch_at = lowest_pelvis(rig, actions[LAND])
    air = sample(rig, actions[JUMP], 0.0)
    tuck = sample(rig, actions[TAKEOFF], tuck_at)
    touch = sample(rig, actions[LAND], 0.0)

    def base(u):
        if u <= body["tuck"]:
            return blend_poses(air, tuck, smooth(u / body["tuck"]))
        if u <= body["touch"]:
            return blend_poses(tuck, touch, smooth((u - body["tuck"]) / (body["touch"] - body["tuck"])))
        s = min(1.0, (u - body["touch"]) / (body["crouch"] - body["touch"]))
        return sample(rig, actions[LAND], crouch_at * (1 - (1 - s) * (1 - s)))

    count = frames_of(body["duration"])
    hit = contact_frame(spec, count)
    bases = [base(k / count) for k in range(count + 1)]
    poses = [striker.pose(bases[k], k / count, window(k / count, 0.0, .14)) for k in range(count + 1)]
    return poses, {"source": JUMP, "contactSeconds": round(hit / FPS, 4), "landSeconds": round(body["touch"] * body["duration"], 4),
                   "from": JUMP, "to": {"clip": LAND, "seconds": round(crouch_at, 4)}, **striker.contact(bases[hit], hit / count)}


AUTHORS = {"stand": stand_strike, "run": run_strike, "jump": jump_strike}


# --- The reactions ---------------------------------------------------------------------------------------------------


def react_track(spec):
    """Every field's keys, each key holding what it leaves out at the previous key's value."""
    held, tracks = dict(REACT_FIELDS), {name: [] for name in REACT_FIELDS}
    for u, key in spec["keys"]:
        held.update(key)
        for name in REACT_FIELDS:
            tracks[name].append((u, float(held[name])))
    return tracks


def react_pose(rig, seed, idle, k):
    """The idle with the arms swung, the chest turned, the whole body turned and moved about the pelvis and the
    feet planted ``lp``/``rp`` of the way back on their keys."""
    rig.apply(seed)
    for side in "lr":
        upper, lower, _ = ARMS[side]
        rotate_world(rig, upper, X, -k[side + "f"])
        rotate_world(rig, upper, Y, -k[side + "o"] if side == "l" else k[side + "o"])
        rotate_world(rig, lower, X, -k[side + "e"])
    turn_chest(rig, k["yaw"], k["pitch"], k["roll"], k["neck"], look=k["look"])
    head = rig.head("pelvis")
    rotate_world(rig, "pelvis", X, k["tip"])
    rotate_world(rig, "pelvis", Y, k["lean"])
    rotate_world(rig, "pelvis", UP, k["spin"])
    spin = Matrix.Rotation(math.radians(k["spin"]), 3, UP)
    pelvis = rig.bones["pelvis"]
    m = pelvis.matrix.copy()
    m.translation = head + spin @ Vector((k["px"], k["py"], k["pz"]))
    pelvis.matrix = m
    bpy.context.view_layer.update()
    for side in "lr":
        planted = min(1.0, k[side + "p"])
        if planted <= 0:
            continue
        thigh, calf, foot, _ = LEGS[side]
        hip, knee, ankle = rig.head(thigh), rig.head(calf), rig.head(foot)
        line = (ankle - hip).normalized()
        bend = (knee - hip) - line * (knee - hip).dot(line)
        pole = bend.normalized() if bend.length > 1e-5 else spin @ Vector((0, -1, 0))
        rest_ankle, rest_turn = idle[side]
        target = ankle.lerp(rest_ankle + Vector((k[side + "x"], k[side + "y"], k[side + "z"])), planted)
        turn = rig.bones[foot].matrix.to_quaternion().slerp(rest_turn, planted)
        two_bone(rig, thigh, calf, foot, target, pole)
        f = turn.to_matrix().to_4x4()
        f.translation = rig.head(foot)
        rig.bones[foot].matrix = f
        bpy.context.view_layer.update()
    floor_feet(rig, spin @ Vector((0, -1, 0)))
    return rig.capture()


def lift(rig, root, joints, floor):
    """Swing ``root`` up about its head until the lowest of ``joints`` is no lower than ``floor``."""
    for _ in range(4):
        z, low = min((rig.head(name).z, name) for name in joints)
        if z >= floor - 1e-3:
            return
        arm = rig.head(low) - rig.head(root)
        flat = Vector((arm.x, arm.y, 0))
        if flat.length < 1e-3:
            return
        rotate_world(rig, root, flat.normalized().cross(UP), math.degrees(min(.6, (floor - z) / max(flat.length, .1))))


def floor_feet(rig, ahead):
    """Keep a falling or lying body's feet out of the ground: an ankle below ``FLOOR[0]`` is lifted on to it (the
    knee toward where it bends, or ``ahead``) and a ball below ``FLOOR[1]`` is turned up about the ankle. A knee, hand
    or finger in the ground first swings its whole leg or arm up about the hip or shoulder."""
    for side in "lr":
        lift(rig, LEGS[side][0], [LEGS[side][1]], FLOOR[0])
        fingers = [f"{f}_{k}_{side}" for f in FINGERS for k in ("01", "02", "03")]
        lift(rig, ARMS[side][0], [ARMS[side][1], ARMS[side][2], *fingers], FLOOR[1])
    for side in "lr":
        thigh, calf, foot, ball = LEGS[side]
        hip, knee, ankle = rig.head(thigh), rig.head(calf), rig.head(foot)
        if ankle.z < FLOOR[0]:
            line = (ankle - hip).normalized()
            bend = (knee - hip) - line * (knee - hip).dot(line)
            turn = rig.bones[foot].matrix.to_3x3()
            two_bone(rig, thigh, calf, foot, Vector((ankle.x, ankle.y, FLOOR[0])), bend.normalized() if bend.length > 1e-5 else ahead)
            f = turn.to_4x4()
            f.translation = rig.head(foot)
            rig.bones[foot].matrix = f
            bpy.context.view_layer.update()
        ankle, toe = rig.head(foot), rig.head(ball)
        along = toe - ankle
        flat = Vector((along.x, along.y, 0))
        if toe.z < FLOOR[1] and flat.length > 1e-5:
            rise = FLOOR[1] - ankle.z
            if abs(rise) < along.length:
                want = flat.normalized() * math.sqrt(along.length ** 2 - rise ** 2) + Vector((0, 0, rise))
                pb = rig.bones[foot]
                m = (along.rotation_difference(want).to_matrix() @ pb.matrix.to_3x3()).to_4x4()
                m.translation = pb.head.copy()
                pb.matrix = m
                bpy.context.view_layer.update()


def react(rig, seed, spec):
    """A hit reaction or death, full body, from the idle through its keys."""
    rig.apply(seed)
    idle = {side: (rig.head(LEGS[side][2]), rig.bones[LEGS[side][2]].matrix.to_quaternion()) for side in "lr"}
    tracks = react_track(spec)
    poses = one_shot(spec["duration"], lambda u: react_pose(rig, seed, idle, {name: hermite(track, u) for name, track in tracks.items()}))
    observations = {"hitSide": spec["side"], "peakSeconds": round(spec["peak"] * spec["duration"], 4)}
    if "land" in spec:
        observations.update({"landSeconds": round(spec["land"] * spec["duration"], 4), "lies": spec["lies"]})
    return poses, observations


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    seed = sample(rig, actions[STAND], 0.0)
    if clip in REACTS:
        poses, observations = react(rig, seed, REACTS[clip])
        return poses, {"source": STAND, "durationSeconds": round((len(poses) - 1) / FPS, 4), **observations,
                       "secondaryPose": record_chains(rig, poses)}
    striker = Striker(rig, seed, clip)
    poses, observations = AUTHORS[striker.spec["kind"]](striker, actions)
    if clip not in UPPER:
        observations["secondaryPose"] = record_chains(rig, poses)
    return poses, {"source": STAND, "durationSeconds": round((len(poses) - 1) / FPS, 4), **observations,
                   **({"layer": UPPER_ROOT, "joints": upper_joints(rig)} if clip in UPPER else {})}


def imported_state(rig_object):
    data = rig_object.animation_data
    scene = bpy.context.scene
    return {"action": data.action if data else None, "slot": getattr(data, "action_slot", None) if data else None,
            "pose": {pb.name: pb.matrix_basis.copy() for pb in rig_object.pose.bones},
            "frame": scene.frame_current, "fps": (scene.render.fps, scene.render.fps_base)}


def restore_state(rig_object, state):
    data = rig_object.animation_data
    if data is not None:
        data.action = state["action"]
        if state["action"] is not None and state["slot"] is not None and hasattr(data, "action_slot"):
            data.action_slot = state["slot"]
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = state["fps"]
    scene.frame_set(state["frame"])
    for name, basis in state["pose"].items():
        rig_object.pose.bones[name].matrix_basis = basis


def write_actions(rig_object, clips):
    """Replace every action with one LINEAR action per clip, keyed at FPS from frame 0."""
    data = rig_object.animation_data or rig_object.animation_data_create()
    data.action = None
    for other in list(bpy.data.actions):
        bpy.data.actions.remove(other)
    bpy.context.scene.render.fps, bpy.context.scene.render.fps_base = FPS, 1
    for clip, poses in clips.items():
        new = bpy.data.actions.new(clip)
        data.action = new
        for frame, pose in enumerate(poses):
            for name, basis in pose.items():
                pb = rig_object.pose.bones[name]
                pb.matrix_basis = basis
                pb.keyframe_insert("location", frame=frame)
                pb.keyframe_insert("rotation_quaternion", frame=frame)
        for curve in action_curves(new):
            for key in curve.keyframe_points:
                key.interpolation = "LINEAR"
        new.use_fake_user = True
        data.action = None
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = 0, max(len(poses) for poses in clips.values()) - 1


def author_all(rig_object, arguments, target_path):
    """Author every requested clip on ``rig_object`` (each from the imported state); {clip: (poses, observations)}."""
    actions = {}
    for name in (STAND, RUN, JUMP, TAKEOFF, LAND):
        found = bpy.data.actions.get(name)
        if found is None:
            raise ValueError(f"the target GLB has no {name} clip")
        actions[name] = found
    rest_gltf = gltf_rest_worlds(target_path)
    fresh = imported_state(rig_object)
    authored = {}
    for clip in arguments["clips"]:
        restore_state(rig_object, fresh)
        authored[clip] = author(Rig(rig_object, arguments["sockets"], rest_gltf), clip, actions)
    restore_state(rig_object, fresh)
    return authored


def generate(output_path, arguments, inputs):
    validate(arguments, inputs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=inputs["target"], bone_heuristic="BLENDER", guess_original_bind_pose=False)
    target_objects = [o for o in bpy.context.scene.objects if o not in before]
    rigs = [o for o in target_objects if o.type == "ARMATURE"]
    if len(rigs) != 1:
        raise ValueError("the target GLB must have one armature")
    authored = author_all(rigs[0], arguments, inputs["target"])
    write_actions(rigs[0], {clip: poses for clip, (poses, _) in authored.items()})
    bpy.ops.object.select_all(action="DESELECT")
    for item in target_objects:
        if item.name in bpy.data.objects:
            item.select_set(True)
    bpy.context.view_layer.objects.active = rigs[0]
    bpy.ops.export_scene.gltf(
        filepath=output_path, export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=False, export_tangents=False, export_materials="NONE",
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=False, export_optimize_animation_keep_anim_armature=True,
        export_skins=True, export_morph=False, export_cameras=False, export_lights=False, export_extras=False)
    return {"recipe": "strike-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
