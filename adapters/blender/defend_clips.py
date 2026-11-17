"""Original defensive clips authored on the Ranger rig in Blender (#729: dodges, sidesteps, parries, ripostes, the shield
block and bash and a push kick, so blocking and evading read differently per weapon).

The declared input ``target`` is the composed Ranger GLB with its embedded clips. The recipe authors in-place clips,
every name in ``arguments["clips"]`` in one run (#425), on top of the first ``Idle_Loop`` pose (the whole loop
resampled for ``Shield_Block_Loop``). No source motion is copied beyond that base pose.

- The upper-body clips (parries, ripostes, the shield clips) keep only the ``spine_01`` subtree (#422). A key names a
  hand's frame (the socket ``s``, the grip ``g``, the item's +Y ``b`` and a hint for its +X ``x`` or +Z ``z``), solved
  with two-bone arm IK; between keys the grip follows a Hermite curve and the rotation turns at an eased rate. Each
  starts and ends in its family's guard, the pose the #717 guard loops hold (the sword's is its idle with the shield
  up), or in the shield brace. A parry records ``parrySeconds``, the deflection frame: the weapon has beaten across the
  line and stops there. A riposte and the bash record ``contactSeconds`` and where the strike point is then (``tipAt``
  in the root frame, ``band``, ``reachMeters``), as the strike clips do.
- The full-body clips (the roll, the sidesteps, the hop back and the kick) turn and move the whole body about the
  pelvis through keys, swing the arms and put each ankle on a key (or, tucked in the roll, bend the legs at hip and
  knee); a foot is never below the ground. They are in place: the pelvis's travel (``px``/``py``) is taken off every
  joint and recorded as ``removedTravel`` (glTF x, z), so the game moves the capsule. They start and end in the
  ``Idle_Loop`` pose and record a skirt and cape pose for the #391 chain joints (``secondaryPose``).

No randomness.
"""
import json
import math
import struct

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 30
UPPER_ROOT = "spine_01"
STAND = "Idle_Loop"
ARMS = {"l": ("upperarm_l", "lowerarm_l", "hand_l"), "r": ("upperarm_r", "lowerarm_r", "hand_r")}
LEGS = {"l": ("thigh_l", "calf_l", "foot_l", "ball_l"), "r": ("thigh_r", "calf_r", "foot_r", "ball_r")}
SPINE = (("spine_01", .3), ("spine_02", .35), ("spine_03", .35))
X, Y, UP = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
C4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
POLE = {"r": Vector((-.8, .35, -.5)), "l": Vector((.8, .35, -.5))}
KNEE = Vector((0, -1, .3))
FINGERS = ("index", "middle", "ring", "pinky", "thumb")
SOCKETS = ("weapon", "offhand", "shield", "staff", "staffLeft")
SOCKET_IDS = {"weapon": "hand_r.weapon", "offhand": "hand_l.weapon", "shield": "hand_l.shield", "staff": "hand_r.staff",
              "staffLeft": "hand_l.staff"}
SHAPES = {
    "open": {"curl": {"index": (4, 6, 4), "middle": (5, 6, 4), "ring": (6, 8, 5), "pinky": (7, 9, 5), "thumb": (2, 4, 4)},
             "spread": {"pinky": 8, "index": -4}},
    "grip": {"curl": {"index": (50, 70, 45), "middle": (52, 72, 46), "ring": (54, 72, 46), "pinky": (56, 74, 48), "thumb": (25, 35, 30)},
             "spread": {}},
    "fist": {"curl": {"index": (80, 95, 60), "middle": (82, 95, 60), "ring": (84, 95, 60), "pinky": (86, 95, 60), "thumb": (30, 40, 35)},
             "spread": {}},
}
PALM = Vector((0, .05, .02))
# The height bands of a strike point above the ground (metres): low below the first, high above the second.
BANDS = (.7, 1.4)

# Blender armature axes: +X is the figure's left, -Y in front of it, +Z up; metres (the pelvis stands at about z 0.91,
# the shoulders at 1.43, the ground at 0). A positive yaw turns the chest to the figure's left; a positive pitch bends
# it forward; a positive roll leans it to its left; a positive neck tips the head down.
#
# The families' guards (as adapters/blender/ready_clips.py): the item, the hand socket that holds it, the strike point
# up its +Y, the second hand on a long item (metres up the shaft from the first) and the pose, a right key ``r``, a left
# key ``l`` and the chest.
SHIELD_GUARD = {"s": "shield", "g": (.1, -.36, 1.22), "b": (.05, 0, 1), "z": (-.15, -1, .05)}


def fist(side, g, b, x=(0, 0, -1)):
    """An empty fist at ``g``, the forearm along ``b``, the elbow tucked down."""
    return {"s": f"palm_{side}", "g": g, "b": b, "x": x, "shape": "fist", "pole": (.3 if side == "l" else -.3, .1, -1)}


FAMILIES = {
    "sword": {"item": "equipment.sword.arming", "socket": "weapon", "tip": .84, "offhand": "equipment.shield.round",
              "guard": {"r": {"s": "weapon", "g": (-.18, -.3, 1.08), "b": (.18, -.6, .78), "x": (-.1, -.7, -.3)},
                        "l": SHIELD_GUARD, "pitch": 6}},
    "mace": {"item": "equipment.mace.flanged", "socket": "weapon", "tip": .5,
             "guard": {"r": {"s": "weapon", "g": (-.15, -.36, 1.24), "b": (.42, -.2, .88), "x": (0, -1, 0)},
                       "l": fist("l", (.15, -.38, 1.3), (-.25, -.5, .8)), "pitch": 9, "yaw": -6, "neck": 4}},
    "dagger": {"item": "equipment.dagger.blackened", "socket": "weapon", "tip": .41, "offhand": "equipment.dagger.blackened",
               "guard": {"r": {"s": "weapon", "g": (-.13, -.4, 1.18), "b": (.15, -.9, .4), "x": (0, 0, -1)},
                         "l": {"s": "offhand", "g": (.1, -.3, 1.3), "b": (-.45, -.55, .7), "x": (0, -.4, -1)},
                         "pitch": 14, "yaw": -10, "neck": 6}},
    "staff": {"item": "equipment.staff.quarter", "socket": "staff", "tip": .8, "shaft": (.35, .7),
              "guard": {"r": {"s": "staff", "g": (-.22, -.34, 1.12), "b": (.9, -.15, .4), "z": (0, -.6, .8)}, "l": "shaft",
                        "pitch": 10, "yaw": 8, "neck": 4}},
    "spear": {"item": "equipment.spear.leaf", "socket": "staff", "tip": 1.46, "shaft": (.2, .6),
              "guard": {"r": {"s": "staff", "g": (-.15, .04, 1.1), "b": (.18, -.95, .22), "z": (-.4, -.6, .3)}, "l": "shaft",
                        "pitch": 10, "yaw": -12, "neck": 4}},
    "two-hand": {"item": "equipment.warhammer.maul", "socket": "weapon", "tip": .68, "shaft": (-.22, -.22),
                 "guard": {"r": {"s": "weapon", "g": (-.12, -.36, 1.12), "b": (.12, -.45, .88), "x": (-.2, -.3, .9)}, "l": "shaft",
                           "pitch": 10, "yaw": -6, "neck": 4}},
    # The shield braced: raised close in front of the face and chest, its top tipped back, the left shoulder behind it
    # and the head down; the sword held at the right side, its point up and forward beside the shield.
    "shield": {"item": "equipment.sword.arming", "socket": "weapon", "tip": .84, "offhand": "equipment.shield.round",
               "guard": {"r": {"s": "weapon", "g": (-.3, -.18, 1.1), "b": (-.1, -.6, .8), "x": (0, -1, -.2)},
                         "l": {"s": "shield", "g": (.05, -.36, 1.3), "b": (.02, .12, 1), "z": (-.25, -1, .1)},
                         "pitch": 12, "yaw": -10, "neck": 5}},
}

# The upper-body one-shots: the family, the length, the kind and the marked key (``mark``: the deflection for a parry,
# the contact for a riposte or the bash, the impact for a block hit), then (fraction, key) pairs. A key names a hand's
# frame (``r``, ``l``; ``"guard"`` the family's guard key) and the chest (the guard's where it leaves one out); a hand
# a key leaves out follows its other keys. Every clip starts and ends in the guard.
G = "guard"
UPPER = {
    # Sixte: the blade gathers in, then beats out across the right of the body, point up, and stops dead there.
    "Sword_Parry": {"family": "sword", "duration": .45, "kind": "parry", "mark": .42, "keys": [
        (0, {"r": G, "l": G}),
        (.28, {"r": {"g": (-.13, -.33, 1.12), "b": (.36, -.45, .82), "x": (.2, -.8, -.3)}, "yaw": 6, "pitch": 6}),
        (.42, {"r": {"g": (-.33, -.4, 1.16), "b": (-.38, -.42, .82), "x": (-.9, -.3, -.1)}, "yaw": -12, "pitch": 8}),
        (.56, {"r": {"g": (-.31, -.39, 1.15), "b": (-.32, -.45, .83), "x": (-.9, -.3, -.1)}, "yaw": -10, "pitch": 8}),
        (1, {"r": G, "l": G})]},
    # The haft beats out to the right, the head knocking the blow aside; the left fist stays up.
    "Mace_Parry": {"family": "mace", "duration": .45, "kind": "parry", "mark": .42, "keys": [
        (0, {"r": G, "l": G}),
        (.28, {"r": {"g": (-.1, -.38, 1.2), "b": (.62, -.3, .72), "x": (0, -1, 0)}, "yaw": -2}),
        (.42, {"r": {"g": (-.34, -.42, 1.24), "b": (-.32, -.42, .85), "x": (-.6, -.8, 0)}, "yaw": -16, "pitch": 11}),
        (.56, {"r": {"g": (-.32, -.41, 1.23), "b": (-.27, -.44, .86), "x": (-.6, -.8, 0)}, "yaw": -14, "pitch": 11}),
        (1, {"r": G, "l": G})]},
    # The off-hand dagger sweeps the blow out past the left shoulder; the right dagger draws back for the riposte.
    "Dagger_Parry": {"family": "dagger", "duration": .4, "kind": "parry", "mark": .42, "keys": [
        (0, {"r": G, "l": G}),
        (.26, {"l": {"s": "offhand", "g": (.03, -.34, 1.27), "b": (-.62, -.5, .6), "x": (.2, -.4, -.9)}, "yaw": -14}),
        (.42, {"l": {"s": "offhand", "g": (.3, -.42, 1.28), "b": (.25, -.6, .76), "x": (.9, -.2, -.3)},
               "r": {"s": "weapon", "g": (-.17, -.3, 1.14), "b": (.15, -.9, .4), "x": (0, 0, -1)}, "yaw": 8, "pitch": 14}),
        (.56, {"l": {"s": "offhand", "g": (.28, -.41, 1.27), "b": (.2, -.62, .76), "x": (.9, -.2, -.3)}, "yaw": 6}),
        (1, {"r": G, "l": G})]},
    # The staff, across the body in both hands, punched up and out so the blow glances off the shaft.
    "Staff_Parry": {"family": "staff", "duration": .45, "kind": "parry", "mark": .42, "keys": [
        (0, {"r": G}),
        (.28, {"r": {"g": (-.2, -.28, 1.06), "b": (.95, -.1, .28), "z": (0, -.6, .8)}, "pitch": 8}),
        (.42, {"r": {"g": (-.3, -.44, 1.32), "b": (.82, -.08, .56), "z": (0, -.8, .6)}, "yaw": 4, "pitch": 6, "neck": 0}),
        (.56, {"r": {"g": (-.29, -.43, 1.3), "b": (.84, -.08, .54), "z": (0, -.8, .6)}, "yaw": 5, "pitch": 6, "neck": 0}),
        (1, {"r": G})]},
    # The point circles under and beats across to the left, the shaft taking the blow.
    "Spear_Parry": {"family": "spear", "duration": .45, "kind": "parry", "mark": .42, "keys": [
        (0, {"r": G}),
        (.28, {"r": {"g": (-.17, .03, 1.08), "b": (-.12, -.96, .2), "z": (-.4, -.6, .3)}, "yaw": -16}),
        (.42, {"r": {"g": (-.12, .0, 1.13), "b": (.48, -.84, .26), "z": (-.4, -.6, .3)}, "yaw": -4, "pitch": 11}),
        (.56, {"r": {"g": (-.12, .0, 1.13), "b": (.43, -.86, .26), "z": (-.4, -.6, .3)}, "yaw": -5}),
        (1, {"r": G})]},
    # The maul's haft, upright, swung across to the right in both hands; slower and heavier than the one-handers.
    "TwoHand_Parry": {"family": "two-hand", "duration": .5, "kind": "parry", "mark": .44, "keys": [
        (0, {"r": G}),
        (.28, {"r": {"g": (-.06, -.42, 1.1), "b": (.22, -.52, .83), "x": (-.2, -.3, .9)}, "yaw": 0}),
        (.44, {"r": {"g": (-.3, -.42, 1.16), "b": (-.24, -.45, .86), "x": (-.6, -.3, .7)}, "yaw": -18, "pitch": 12}),
        (.6, {"r": {"g": (-.29, -.41, 1.15), "b": (-.2, -.46, .86), "x": (-.6, -.3, .7)}, "yaw": -16, "pitch": 12}),
        (1, {"r": G})]},
    # Straight from the guard: a short chamber, then the point driven forward at the chest with the right shoulder.
    "Sword_Riposte": {"family": "sword", "duration": .6, "kind": "riposte", "mark": .4, "keys": [
        (0, {"r": G, "l": G}),
        (.2, {"r": {"g": (-.22, -.18, 1.13), "b": (.06, -1, .12), "x": (-1, 0, 0)}, "yaw": -6, "pitch": 4}),
        (.4, {"r": {"g": (-.1, -.64, 1.2), "b": (.04, -1, .04), "x": (-1, 0, 0)},
              "l": {"s": "shield", "g": (.2, -.28, 1.16), "b": (.08, 0, 1), "z": (.2, -1, .05)}, "yaw": 20, "pitch": 12}),
        (.54, {"r": {"g": (-.11, -.6, 1.19), "b": (.05, -1, .06), "x": (-1, 0, 0)}, "yaw": 18, "pitch": 11}),
        (1, {"r": G, "l": G})]},
    # The right dagger stabs low under the opening while the left dagger checks high.
    "Dagger_Riposte": {"family": "dagger", "duration": .6, "kind": "riposte", "mark": .38, "keys": [
        (0, {"r": G, "l": G}),
        (.18, {"r": {"g": (-.19, -.22, 1.06), "b": (.1, -.9, .4), "x": (0, 0, -1)}, "yaw": -14}),
        (.38, {"r": {"g": (-.06, -.6, 1.04), "b": (.04, -.97, .22), "x": (0, 0, -1)},
               "l": {"s": "offhand", "g": (.16, -.44, 1.26), "b": (-.3, -.7, .6), "x": (0, -.4, -1)}, "yaw": 22, "pitch": 18}),
        (.52, {"r": {"g": (-.07, -.57, 1.05), "b": (.05, -.96, .26), "x": (0, 0, -1)}, "yaw": 20, "pitch": 17}),
        (1, {"r": G, "l": G})]},
    # The blow lands on the brace: the shield arm knocked back into the chest, the top tipping back, the chest
    # straightened; the arm rebounds and settles back into the brace.
    "Shield_Block_Hit": {"family": "shield", "duration": .35, "kind": "block-hit", "mark": .2, "keys": [
        (0, {"r": G, "l": G}),
        (.2, {"l": {"s": "shield", "g": (.06, -.25, 1.33), "b": (.0, .38, .93), "z": (-.25, -1, .35)},
              "r": {"s": "weapon", "g": (-.31, -.14, 1.11), "b": (-.1, -.58, .81), "x": (0, -1, -.2)}, "yaw": -4, "pitch": 3, "neck": 1}),
        (.5, {"l": {"s": "shield", "g": (.05, -.34, 1.3), "b": (.02, .1, 1), "z": (-.25, -1, .08)}, "pitch": 13}),
        (1, {"r": G, "l": G})]},
    # Gathered behind the shield, then the whole left side driven forward: the shield punched out at face height.
    "Shield_Bash": {"family": "shield", "duration": .6, "kind": "bash", "mark": .45, "keys": [
        (0, {"r": G, "l": G}),
        (.28, {"l": {"s": "shield", "g": (.12, -.24, 1.26), "b": (.04, .06, 1), "z": (-.4, -1, .05)},
               "r": {"s": "weapon", "g": (-.32, -.12, 1.08), "b": (-.12, -.55, .83), "x": (0, -1, -.2)}, "yaw": 8, "pitch": 6, "neck": 3}),
        (.45, {"l": {"s": "shield", "g": (-.02, -.64, 1.26), "b": (0, -.12, 1), "z": (-.1, -1, -.05)}, "yaw": -26, "pitch": 16, "neck": 6, "roll": -4}),
        (.58, {"l": {"s": "shield", "g": (-.02, -.61, 1.26), "b": (0, -.1, 1), "z": (-.1, -1, -.05)}, "yaw": -24, "pitch": 15, "neck": 6, "roll": -4}),
        (1, {"r": G, "l": G})]},
}
# The shield brace held: the family's pose over the whole ``Idle_Loop`` resampled to the clip, with a small sway, a
# breath and a bob that close on themselves.
LOOPS = {"Shield_Block_Loop": ("shield", 2.0, {"sway": 1.5, "breathe": 1, "bob": .006, "turn": 1})}

# The full-body clips: a key (fraction, fields) holds every field it leaves out at the previous key's value. The pelvis
# travels ``px``/``py`` (taken off in place), shifts ``sx``/``sy`` (kept) and drops ``pz``; the whole body turns about
# the pelvis by ``tip`` (positive pitches it forward), ``lean`` (positive to its left) and ``spin``; the chest turns
# by ``yaw``, ``pitch``, ``roll``, ``neck`` and ``look``; each arm swings forward (``lf``/``rf``), out (``lo``/``ro``)
# and bends its elbow (``le``/``re``); each leg bends at the hip (``lk``) and knee (``lb``) and its ankle goes
# ``lp``/``rp`` of the way to where it stands in the idle moved by ``lx``/``ly``/``lz`` (``rx``...), the foot pitched
# ``lh``/``rh`` degrees (positive raises the heel, negative the toes).
BODY_FIELDS = {"px": 0, "py": 0, "sx": 0, "sy": 0, "pz": 0, "tip": 0, "lean": 0, "spin": 0, "yaw": 0, "pitch": 0, "roll": 0, "neck": 0,
               "look": 0, "lf": 0, "lo": 0, "le": 0, "rf": 0, "ro": 0, "re": 0, "lk": 0, "lb": 0, "rk": 0, "rb": 0,
               "lx": 0, "ly": 0, "lz": 0, "lp": 1, "lh": 0, "rx": 0, "ry": 0, "rz": 0, "rp": 1, "rh": 0}
ARMS_UP = {"lf": 35, "lo": 12, "le": 70, "rf": 35, "ro": 12, "re": 70}
BODY = {
    # Down into a squat, sat back on to the ground, rolled over the back and the shoulders with the knees tucked to the
    # chest and the hands pushing by the ears, the feet planted behind into a crouch and up into the stand: 1.3 m back.
    "Roll_Bwd": {"duration": .8, "kind": "dodge", "direction": "back", "tumble": True, "keys": [
        (0, {}),
        (.12, {"py": .06, "pz": -.38, "tip": 12, "pitch": 18, "neck": 8, "lf": 40, "rf": 40, "le": 40, "re": 40, "ly": 0, "ry": 0}),
        (.26, {"py": .3, "pz": -.66, "tip": -30, "pitch": 38, "neck": 24, "lk": 80, "lb": 120, "rk": 80, "rb": 120, "lp": .5, "rp": .5,
               "lf": 60, "rf": 60, "le": 70, "re": 70}),
        (.38, {"py": .5, "pz": -.7, "tip": -95, "pitch": 40, "neck": 28, "lk": 125, "lb": 150, "rk": 125, "rb": 150, "lp": 0, "rp": 0,
               "lf": 150, "rf": 150, "le": 110, "re": 110}),
        (.52, {"py": .72, "pz": -.5, "tip": -180, "pitch": 42, "lf": 165, "rf": 165, "le": 60, "re": 60}),
        (.64, {"py": .98, "pz": -.5, "tip": -258, "pitch": 36, "neck": 20, "lk": 105, "lb": 110, "rk": 105, "rb": 110,
               "lf": 90, "rf": 90, "le": 50, "re": 50}),
        (.75, {"py": 1.34, "pz": -.46, "tip": -300, "pitch": 28, "neck": 10, "lk": 0, "lb": 0, "rk": 0, "rb": 0, "lp": 1, "rp": 1, "ly": 1.3, "ry": 1.3,
               "lf": 50, "rf": 50, "le": 60, "re": 60}),
        (.89, {"py": 1.31, "pz": -.16, "tip": -345, "pitch": 10, "neck": 3, "lf": 30, "rf": 30, "le": 50, "re": 50}),
        (1, {**BODY_FIELDS, "py": 1.3, "tip": -360, "ly": 1.3, "ry": 1.3})]},
    # A quick hop aside: dip, the right leg drives the body over, the left foot reaches and lands, the right closes.
    "Sidestep_L": {"duration": .45, "kind": "dodge", "direction": "left", "keys": [
        (0, {}),
        (.16, {"sx": -.03, "pz": -.07, "lean": -3, "roll": 2, "lo": 10, "ro": 10, "le": 20, "re": 20}),
        (.36, {"px": .22, "sx": 0, "pz": -.02, "lean": 6, "roll": -3, "lx": .32, "lz": .1, "lh": -10, "rh": 25, "lo": 12, "ro": 9}),
        (.58, {"px": .46, "pz": -.04, "lean": 4, "lx": .6, "lz": 0, "lh": 0, "rx": .3, "rz": .08, "rh": 10}),
        (.78, {"px": .58, "pz": -.08, "lean": 0, "roll": 1, "rx": .6, "rz": 0, "rh": 0, "lo": 8, "ro": 8}),
        (1, {**BODY_FIELDS, "px": .6, "lx": .6, "rx": .6})]},
    "Sidestep_R": {"duration": .45, "kind": "dodge", "direction": "right", "keys": [
        (0, {}),
        (.16, {"sx": .03, "pz": -.07, "lean": 3, "roll": -2, "lo": 10, "ro": 10, "le": 20, "re": 20}),
        (.36, {"px": -.22, "sx": 0, "pz": -.02, "lean": -6, "roll": 3, "rx": -.32, "rz": .1, "rh": -10, "lh": 25, "lo": 9, "ro": 12}),
        (.58, {"px": -.46, "pz": -.04, "lean": -4, "rx": -.6, "rz": 0, "rh": 0, "lx": -.3, "lz": .08, "lh": 10}),
        (.78, {"px": -.58, "pz": -.08, "lean": 0, "roll": -1, "lx": -.6, "lz": 0, "lh": 0, "lo": 8, "ro": 8}),
        (1, {**BODY_FIELDS, "px": -.6, "lx": -.6, "rx": -.6})]},
    # Dip, both feet spring the body back, the chest staying over the knees, land on the balls and settle.
    "Dodge_Back": {"duration": .5, "kind": "dodge", "direction": "back", "keys": [
        (0, {}),
        (.18, {"pz": -.11, "pitch": 10, "tip": 4, "lh": 8, "rh": 8, "lf": 15, "rf": 15, "le": 30, "re": 30}),
        (.4, {"py": .22, "pz": -.01, "pitch": 12, "tip": 4, "ly": .14, "ry": .14, "lz": .11, "rz": .11, "lh": 22, "rh": 22, "lf": 28, "rf": 28}),
        (.6, {"py": .44, "pz": -.14, "pitch": 14, "tip": 6, "ly": .46, "ry": .46, "lz": 0, "rz": 0, "lh": 10, "rh": 10}),
        (.8, {"py": .5, "pz": -.06, "pitch": 6, "tip": 2, "ly": .5, "ry": .5, "lh": 0, "rh": 0, "lf": 18, "rf": 18}),
        (1, {**BODY_FIELDS, "py": .5, "ly": .5, "ry": .5})]},
    # A push kick: the fists up, the right knee chambered high, the heel driven out at the hip's height with the hips
    # behind it and the chest leaning back, snapped back to the chamber and set down where it stood.
    "Kick_Front": {"duration": .7, "kind": "kick", "mark": .44, "keys": [
        (0, {}),
        (.2, {**ARMS_UP, "pz": -.04, "sy": .02, "tip": -2, "pitch": 4, "rp": 1, "ry": -.46, "rz": .46, "rh": -20, "lh": 0}),
        (.44, {"pz": -.03, "sy": -.06, "tip": -14, "pitch": -4, "neck": 6, "ry": -1.06, "rz": .64, "rh": -62, "lf": 40, "rf": 15, "re": 50}),
        (.56, {"sy": -.04, "tip": -12, "ry": -1.0, "rz": .62}),
        (.74, {**ARMS_UP, "pz": -.04, "sy": .02, "tip": -3, "pitch": 2, "neck": 0, "ry": -.42, "rz": .42, "rh": -15}),
        (1, BODY_FIELDS)]},
}
CLIPS = (
    "Roll_Bwd", "Sidestep_L", "Sidestep_R", "Dodge_Back",
    "Sword_Parry", "Dagger_Parry", "Staff_Parry", "Spear_Parry", "TwoHand_Parry", "Mace_Parry",
    "Sword_Riposte", "Dagger_Riposte", "Shield_Block_Loop", "Shield_Block_Hit", "Shield_Bash", "Kick_Front",
)
# The lowest an ankle and a ball of the foot may go (metres above the ground), and the trunk's joints a tumble keeps
# ``TRUNK_CLEAR`` above it.
FLOOR = (.07, .02)
TRUNK = ("pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head", "upperarm_l", "upperarm_r")
TRUNK_CLEAR = .1
# The #391 chain joints the full-body clips key (as adapters/blender/strike_clips.py).
CAPE = "cape_01"
SWING = {"share": .7, "front": 70.0, "sideShare": .8, "side": 75.0, "back": 20.0}
BACK = Vector((0, 1, 0))
PLUMB = ("skirt_f_03", "skirt_l_02", "skirt_r_02")


def validate(p, inputs):
    if type(p) is not dict or set(p) != {"schemaVersion", "clips", "sockets"}:
        raise ValueError("defend clips require exactly schemaVersion, clips and sockets")
    clips = p["clips"]
    if p["schemaVersion"] != 1 or type(clips) is not list or not clips or len(set(clips)) != len(clips) or any(c not in CLIPS for c in clips):
        raise ValueError(f"defend clips must be distinct names from {CLIPS}")
    sockets = p["sockets"]
    if type(sockets) is not dict or set(sockets) != set(SOCKETS):
        raise ValueError(f"defend clips need the sockets {SOCKETS}")
    for name, socket in sockets.items():
        if set(socket) != {"joint", "translation", "rotation"} or len(socket["translation"]) != 3 or len(socket["rotation"]) != 4:
            raise ValueError(f"socket {name} needs joint, translation and rotation")
    if set(inputs) != {"target"}:
        raise ValueError("defend clips take exactly the declared input target")


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


def item_frame(position, y_axis, x_hint):
    """A frame at ``position`` whose +Y is ``y_axis`` and +X as close to ``x_hint`` as it can be."""
    yy = y_axis.normalized()
    xx = x_hint - yy * x_hint.dot(yy)
    if xx.length < 1e-4:
        xx = (Vector((0, 0, 1)) if abs(yy.z) < .9 else Vector((1, 0, 0))).cross(yy)
    xx.normalize()
    m = Matrix((xx, yy, xx.cross(yy))).transposed().to_4x4()
    m.translation = position
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
        # The palms: at the wrist, +Y along the hand toward the fingers, +Z out of the palm, offset to the middle of the
        # palm so a fist key names where the fist is.
        for side in "lr":
            joint = f"hand_{side}"
            rest = self.rest[joint]
            palm = rest.inverted() @ frame_of(rest.translation, rest.to_3x3() @ Y, Vector((0, 0, -1)))
            self.socket[f"palm_{side}"] = (joint, palm @ Matrix.Translation(PALM))

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


def reach(rig, socket, frame, limit=25.0):
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

    def shape(self, side, name):
        return self.shapes[side][name]


def upper_joints(rig):
    return [UPPER_ROOT, *(bone.name for bone in rig.rig.data.bones[UPPER_ROOT].children_recursive)]


def frames_of(duration):
    return int(round(duration * FPS))


def root_point(p):
    """An armature-space point in the root's glTF axes (+Y up, +Z facing), rounded."""
    g = C4.inverted() @ p
    return [round(g.x, 4), round(g.y, 4), round(g.z, 4)]


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


def interpolate(track, u):
    """Position (Hermite through the keys) and rotation (eased slerp per span) of (fraction, frame) keys."""
    if u <= track[0][0]:
        return track[0][1]
    if u >= track[-1][0]:
        return track[-1][1]
    i = max(k for k in range(len(track) - 1) if track[k][0] <= u)
    (t0, m0), (t1, m1) = track[i], track[i + 1]
    position = hermite([(t, m.translation) for t, m in track], u)
    q0, q1 = m0.to_quaternion(), m1.to_quaternion()
    if q0.dot(q1) < 0:
        q1.negate()
    m = q0.slerp(q1, smooth((u - t0) / (t1 - t0))).to_matrix().to_4x4()
    m.translation = position
    return m


# --- The upper-body clips ----------------------------------------------------------------------------------------------


def key_frame(key):
    """An explicit hand key's frame."""
    if "x" in key:
        return item_frame(v(key["g"]), v(key["b"]), v(key["x"]))
    return frame_of(v(key["g"]), v(key["b"]), v(key["z"]))


class Guarded:
    """One family on the rig: its guard keys resolved to frames, the shaft hand and the finger shapes."""

    def __init__(self, rig, seed, family):
        self.rig, self.seed, self.name = rig, seed, family
        self.spec = FAMILIES[family]
        self.hands = Hands(rig, seed)
        guard = self.spec["guard"]
        self.chest = {n: float(guard.get(n, 0.0)) for n in ("yaw", "pitch", "roll", "neck")}
        self.guard = {side: self.side_key(side, guard[side]) for side in "rl"}

    def side_key(self, side, key, default_socket=None):
        """A hand key as (socket, frame, pole, shape), or ``"shaft"`` for the second hand on a long item."""
        if key == "shaft":
            return "shaft"
        socket = key.get("s", default_socket)
        return (socket, key_frame(key), v(key["pole"]) if "pole" in key else POLE[side], key.get("shape", "grip"))

    def place(self, base, keys, chest):
        """The base pose with the chest turned and each hand on its frame (``keys``: side to (socket, frame, pole,
        shape) or ``"shaft"``)."""
        rig = self.rig
        rig.apply(base)
        turn_chest(rig, chest["yaw"], chest["pitch"], chest["roll"], chest["neck"])
        main = None
        for side in "rl":
            key = keys[side]
            if key == "shaft":
                continue
            socket, frame, pole, _ = key
            reach(rig, socket, frame)
            place_grip(rig, socket, frame, pole)
            if side == "r":
                main = frame
        if keys["l"] == "shaft":
            shaft = main.to_3x3().col[1].normalized()
            back = main.to_3x3().col[2]
            want = rig.head("upperarm_l") + Vector((0, -.3, -.2))
            low, high = self.spec["shaft"]
            self.on_shaft = min(high, max(low, (want - main.translation).dot(shaft)))
            frame = frame_of(main.translation + shaft * self.on_shaft, shaft, Vector((-back.x, back.y, back.z)))
            reach(rig, "staffLeft", frame)
            place_grip(rig, "staffLeft", frame, POLE["l"])
        for side in "rl":
            shape = "grip" if keys[side] == "shaft" else keys[side][3]
            rig.apply(self.hands.shape(side, shape))
        return rig.capture()


def strike_point(rig, socket, tip):
    """A strike point in the root frame, its height band and horizontal reach."""
    at = root_point(rig.grip(socket) @ Vector((0, tip, 0)))
    band = "low" if at[1] < BANDS[0] else "high" if at[1] > BANDS[1] else "mid"
    return {"tipAt": at, "band": band, "reachMeters": round(math.hypot(at[0], at[2]), 4)}


def guarded_clip(rig, seed, clip):
    """A parry, riposte, block hit or bash: the hands through their keys from the guard back to it."""
    spec = UPPER[clip]
    guarded = Guarded(rig, seed, spec["family"])
    family = guarded.spec
    tracks = {"r": [], "l": []}
    chest_track = {n: [] for n in ("yaw", "pitch", "roll", "neck")}
    for u, key in spec["keys"]:
        for n in chest_track:
            chest_track[n].append((u, float(key.get(n, guarded.chest[n]))))
        for side in "rl":
            if guarded.guard[side] == "shaft" or side not in key:
                continue
            value = key[side]
            if value == G:
                tracks[side].append((u, guarded.guard[side]))
            else:
                tracks[side].append((u, guarded.side_key(side, value, guarded.guard[side][0])))
    for side in "rl":
        if guarded.guard[side] != "shaft" and tracks[side][-1][0] < 1:
            tracks[side].append((1.0, guarded.guard[side]))
    count = frames_of(spec["duration"])
    poses = []
    for k in range(count + 1):
        u = k / count
        keys = {}
        for side in "rl":
            if guarded.guard[side] == "shaft":
                keys[side] = "shaft"
                continue
            track = tracks[side]
            nearest = min(track, key=lambda item: abs(item[0] - u))[1]
            keys[side] = (nearest[0], interpolate([(t, key[1]) for t, key in track], u), nearest[2], nearest[3])
        poses.append(guarded.place(seed, keys, {n: hermite(track, u) for n, track in chest_track.items()}))
    mark = int(round(spec["mark"] * count))
    seconds = round(mark / FPS, 4)
    kind = spec["kind"]
    defend = {"kind": kind, "family": "sword" if spec["family"] == "shield" else spec["family"], "item": family["item"],
              "socket": SOCKET_IDS[family["socket"]]}
    if "offhand" in family:
        defend["offhand"] = {"item": family["offhand"], "socket": SOCKET_IDS["shield" if "shield" in family["offhand"] else "offhand"]}
    rig.apply(poses[mark])
    observed = {}
    if kind == "parry":
        defend["parrySeconds"] = seconds
    elif kind == "block-hit":
        defend["impactSeconds"] = seconds
    else:
        observed["contactSeconds"] = seconds
        if kind == "bash":
            defend.update({"strikeSocket": SOCKET_IDS["shield"], **strike_point(rig, "shield", 0.0)})
        else:
            defend.update({"strikePoint": [0, family["tip"], 0], **strike_point(rig, family["socket"], family["tip"])})
    if spec["family"] == "shield":
        defend["from"] = defend["to"] = "Shield_Block_Loop"
    else:
        defend["from"] = defend["to"] = f"{spec['family']}.guard"
    return poses, {**observed, "defend": defend}


def loop(rig, stand, clip):
    """The shield brace held: the pose over the whole ``Idle_Loop`` resampled to the clip, swaying, breathing and
    bobbing in cycles that close on themselves."""
    family, duration, motion = LOOPS[clip]
    seed = sample(rig, stand, 0.0)
    guarded = Guarded(rig, seed, family)
    source = action_seconds(stand)
    count = frames_of(duration)
    rig.apply(seed)
    chest_rest = rig.head("spine_03")
    poses = []
    for k in range(count + 1):
        phase = 2 * math.pi * (k % count) / count
        base = sample(rig, stand, (k % count) / count * source)
        rig.apply(base)
        breathe = rig.head("spine_03") - chest_rest
        chest = dict(guarded.chest)
        chest["yaw"] += motion["sway"] * math.sin(phase)
        chest["pitch"] += motion["breathe"] * math.sin(2 * phase)
        placed = {}
        for side in "rl":
            socket, frame, pole, shape = guarded.guard[side]
            late = 0.0 if side == "r" else math.pi / 2
            lift = Vector((0, 0, motion["bob"] * math.sin(2 * phase - late))) + breathe
            turn = Matrix.Rotation(math.radians(motion["sway"] * math.sin(phase)) * .6, 4, UP)
            spin = Matrix.Rotation(math.radians(motion["turn"] * math.sin(phase)), 4, X) @ Matrix.Rotation(math.radians(motion["turn"] * math.cos(phase)), 4, UP)
            pivot = rig.head("spine_01")
            moved = Matrix.Translation(pivot) @ turn @ Matrix.Translation(-pivot) @ frame
            m = (spin.to_3x3() @ moved.to_3x3()).to_4x4()
            m.translation = moved.translation + lift
            placed[side] = (socket, m, pole, shape)
        poses.append(guarded.place(base, placed, chest))
    spec = guarded.spec
    return poses, {"defend": {"kind": "block", "family": "sword", "item": spec["item"], "socket": SOCKET_IDS[spec["socket"]],
                              "offhand": {"item": spec["offhand"], "socket": SOCKET_IDS["shield"]}},
                   "seedSeconds": round(source, 4)}


# --- The full-body clips -----------------------------------------------------------------------------------------------


def body_tracks(spec):
    """Every field's keys, each key holding what it leaves out at the previous key's value."""
    held, tracks = dict(BODY_FIELDS), {name: [] for name in BODY_FIELDS}
    for u, key in spec["keys"]:
        held.update(key)
        for name in BODY_FIELDS:
            tracks[name].append((u, float(held[name])))
    return tracks


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
    """Keep the feet out of the ground: an ankle below ``FLOOR[0]`` is lifted on to it and a ball below ``FLOOR[1]`` is
    turned up about the ankle. A knee, hand or finger in the ground first swings its whole leg or arm up."""
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


def body_pose(rig, seed, idle, k, tumble):
    """The idle with the arms swung, the chest turned, the legs bent, the whole body turned and moved about the pelvis,
    the travel taken off and each ankle ``lp``/``rp`` of the way to its key."""
    rig.apply(seed)
    for side in "lr":
        upper, lower, _ = ARMS[side]
        rotate_world(rig, upper, X, -k[side + "f"])
        rotate_world(rig, upper, Y, -k[side + "o"] if side == "l" else k[side + "o"])
        rotate_world(rig, lower, X, -k[side + "e"])
    turn_chest(rig, k["yaw"], k["pitch"], k["roll"], k["neck"], look=k["look"])
    for side in "lr":
        thigh, calf, _, _ = LEGS[side]
        if k[side + "k"]:
            rotate_world(rig, thigh, X, -k[side + "k"])
        if k[side + "b"]:
            rotate_world(rig, calf, X, k[side + "b"])
    head = rig.head("pelvis")
    rotate_world(rig, "pelvis", X, k["tip"])
    rotate_world(rig, "pelvis", Y, k["lean"])
    rotate_world(rig, "pelvis", UP, k["spin"])
    pelvis = rig.bones["pelvis"]
    m = pelvis.matrix.copy()
    m.translation = head + Vector((k["sx"], k["sy"], k["pz"]))
    pelvis.matrix = m
    bpy.context.view_layer.update()
    if tumble:
        # A rolling trunk rides on the ground, never through it.
        low = min(rig.head(name).z for name in TRUNK)
        if low < TRUNK_CLEAR:
            m = pelvis.matrix.copy()
            m.translation = m.translation + Vector((0, 0, TRUNK_CLEAR - low))
            pelvis.matrix = m
            bpy.context.view_layer.update()
    travel = Vector((k["px"], k["py"], 0))
    for side in "lr":
        planted = max(0.0, min(1.0, k[side + "p"]))
        if planted < .02:
            continue
        thigh, calf, foot, _ = LEGS[side]
        hip, knee, ankle = rig.head(thigh), rig.head(calf), rig.head(foot)
        rest_ankle, rest_turn = idle[side]
        target = ankle.lerp(rest_ankle + Vector((k[side + "x"], k[side + "y"], k[side + "z"])) - travel, planted)
        pitched = (Matrix.Rotation(math.radians(k[side + "h"]), 3, X) @ rest_turn.to_matrix()).to_quaternion()
        turn = rig.bones[foot].matrix.to_quaternion().slerp(pitched, planted)
        # The knee keeps bending the way it bends (forward when the leg is near straight).
        line = (ankle - hip).normalized()
        bend = (knee - hip) - line * (knee - hip).dot(line)
        two_bone(rig, thigh, calf, foot, target, bend.normalized() if bend.length > .02 else KNEE)
        f = turn.to_matrix().to_4x4()
        f.translation = rig.head(foot)
        rig.bones[foot].matrix = f
        bpy.context.view_layer.update()
    floor_feet(rig, Vector((0, -1, 0)))
    return rig.capture()


def body_clip(rig, seed, clip):
    spec = BODY[clip]
    rig.apply(seed)
    idle = {side: (rig.head(LEGS[side][2]), rig.bones[LEGS[side][2]].matrix.to_quaternion()) for side in "lr"}
    tracks = body_tracks(spec)
    count = frames_of(spec["duration"])
    poses = [body_pose(rig, seed, idle, {name: hermite(track, k / count) for name, track in tracks.items()}, spec.get("tumble", False))
             for k in range(count + 1)]
    end = {name: track[-1][1] for name, track in tracks.items()}
    defend = {"kind": spec["kind"], "from": STAND, "to": STAND}
    observed = {}
    if "direction" in spec:
        defend["direction"] = spec["direction"]
    if end["px"] or end["py"]:
        # Blender +X is glTF +X (the figure's left), Blender +Y (behind it) glTF -Z.
        observed["removedTravel"] = [round(end["px"], 4) + 0.0, round(-end["py"], 4) + 0.0]
    if "mark" in spec:
        mark = int(round(spec["mark"] * count))
        rig.apply(poses[mark])
        at = root_point(rig.head("foot_r"))
        observed["contactSeconds"] = round(mark / FPS, 4)
        defend.update({"strikeJoint": "foot_r", "tipAt": at, "band": "low" if at[1] < BANDS[0] else "high" if at[1] > BANDS[1] else "mid",
                       "reachMeters": round(math.hypot(at[0], at[2]), 4)})
    return poses, {**observed, "defend": defend}


def secondary(rig):
    """The #391 chain pose of this frame (as adapters/blender/strike_clips.py): per chain joint it keys, its local
    rotation (glTF xyzw) under its parent. The front panel rides the higher thigh, each side panel follows its own
    thigh, and past the knee both hang plumb; the back panel and the cape hang but never pass into the legs or back."""
    down = Vector((0, 0, -1))
    thigh = {s: (rig.bones[LEGS[s][1]].head - rig.bones[LEGS[s][0]].head).normalized() for s in "lr"}
    lift_of = {s: math.degrees(math.atan2(max(0.0, -thigh[s].y), max(1e-6, -thigh[s].z))) if thigh[s].z < 0 else 90.0 for s in "lr"}
    reach_of = max(0.0, *(math.degrees(math.asin(max(0.0, min(1.0, thigh[s].y)))) for s in "lr"))
    turn = lambda degrees: Matrix.Rotation(math.radians(degrees), 3, Vector((1, 0, 0))) @ down

    def toward(direction, share, limit):
        angle = min(limit, share * math.degrees(down.angle(direction)))
        axis = down.cross(direction)
        return Matrix.Rotation(math.radians(angle), 3, axis.normalized()) @ down if axis.length > 1e-6 else down

    directions = {
        "skirt_f_01": turn(-min(SWING["front"], SWING["share"] * max(lift_of.values()))),
        "skirt_b_01": turn(min(SWING["back"], SWING["share"] * reach_of)),
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


def author(rig, clip, actions):
    """The clip's poses (one per frame at FPS; the loop repeats its first pose last) and its observations."""
    if rig.rig.animation_data is None:
        rig.rig.animation_data_create()
    rig.apply({name: Matrix.Identity(4) for name in rig.rest})
    if clip in LOOPS:
        poses, observations = loop(rig, actions[STAND], clip)
    elif clip in UPPER:
        poses, observations = guarded_clip(rig, sample(rig, actions[STAND], 0.0), clip)
    else:
        poses, observations = body_clip(rig, sample(rig, actions[STAND], 0.0), clip)
        observations["secondaryPose"] = record_chains(rig, poses)
        return poses, {"source": STAND, "durationSeconds": round((len(poses) - 1) / FPS, 4), **observations}
    return poses, {"source": STAND, "durationSeconds": round((len(poses) - 1) / FPS, 4), **observations,
                   "layer": UPPER_ROOT, "joints": upper_joints(rig)}


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
    found = bpy.data.actions.get(STAND)
    if found is None:
        raise ValueError(f"the target GLB has no {STAND} clip")
    actions = {STAND: found}
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
    return {"recipe": "defend-clip-v1", "fps": FPS,
            "clips": {clip: {"frames": len(poses), **observations} for clip, (poses, observations) in authored.items()}}
