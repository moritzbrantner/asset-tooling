// The `biped-rigid` profile (#605, docs/quadruped-rigid.md#the-biped-rigid-sibling): the two-legged sibling of
// `quadruped-rigid`, for birds such as Zoo's flamingo and penguin. It keeps every rule of that profile (rigid parts
// on named pivoted joints, no skin, grounded clips sampled at 30 Hz, in-place `walk`, `feed` and `rest`) and differs
// only in the joints: two legs, and a wing on each side.
import type { Document } from "@gltf-transform/core";
import { QUADRUPED_RIGID_ROOT, assertRigidAnimal, inspectRigidAnimal, type QuadrupedRigidObservations, type RigidAnimalProfile } from "./quadruped-rigid.js";

export const BIPED_RIGID_PROFILE = "biped-rigid";
export const BIPED_RIGID_LEGS = ["leg_0", "leg_1"] as const;
/** The joints every biped carries. A species may add its own, such as a `neck` or each leg's `_lower` part. */
export const BIPED_RIGID_JOINTS = [QUADRUPED_RIGID_ROOT, "body", "head", "tail", ...BIPED_RIGID_LEGS, "wing_left", "wing_right"] as const;
export const BIPED_RIGID: RigidAnimalProfile = { name: BIPED_RIGID_PROFILE, joints: BIPED_RIGID_JOINTS, legs: BIPED_RIGID_LEGS };

/** Every way `document` breaks biped-rigid, and the measurements the descriptor records. */
export function inspectBipedRigid(document: Document) {
  return inspectRigidAnimal(document, BIPED_RIGID);
}

/** The measurements of a valid biped-rigid `document`; throws naming every issue otherwise. */
export function assertBipedRigid(document: Document, label = "asset"): QuadrupedRigidObservations {
  return assertRigidAnimal(document, BIPED_RIGID, label);
}
