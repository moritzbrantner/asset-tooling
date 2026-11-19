/**
 * The riding horse and its rider (#769, docs/mounts.md): the numbers both recipes share. adapters/blender/mounts.py
 * places the tack and authors the gaits with them; adapters/blender/ride_clips.py (the Ranger's `ride` family) seats
 * the rider and times its loops with them, so the rider's hands, feet and pelvis land on the horse's sockets and its
 * loops run in step with the horse's.
 */

/** Each riding gait's stride in seconds and its ground speed in metres per second (both clips loop once a stride). */
export const MOUNT_GAITS = {
  Walk_Loop: { seconds: 1.1, speed: 1.5 },
  Trot_Loop: { seconds: 0.7333, speed: 3.4 },
  Canter_Loop: { seconds: 0.6, speed: 5.0 },
  Gallop_Loop: { seconds: 0.4667, speed: 8.0 },
} as const;

/** The horse's clips that run in place without travel; the rider's idle and turns match their lengths. */
export const MOUNT_STILL_SECONDS = { Ride_Idle_Loop: 4.0, Turn_L: 2.4, Turn_R: 2.4 } as const;

/**
 * The tack in the seat frame (metres; +X the horse's left, +Y up, +Z ahead; the origin is `saddle.seat`, where the
 * rider's pelvis joint sits): how far the seat is above the saddle's top, and the left rein hand and stirrup tread
 * (the right ones mirror them).
 */
export const MOUNT_TACK = { seatAbove: 0.09, reins: [0.08, 0.12, 0.28], stirrup: [0.38, -0.73, 0.12] } as const;

/** `saddle.seat` above the ground with the horse standing at rest (the recipe measures it; the test holds it). */
export const MOUNT_SEAT_HEIGHT = 1.604;

/** The horse recipe's arguments. */
export const mountArguments = () => ({
  schemaVersion: 1,
  gaits: Object.fromEntries(Object.entries(MOUNT_GAITS).map(([name, gait]) => [name, { ...gait }])),
  tack: { seatAbove: MOUNT_TACK.seatAbove, reins: [...MOUNT_TACK.reins], stirrup: [...MOUNT_TACK.stirrup] },
});

/** The ride family's tack, gait lengths and seat height (adapters/blender/ride_clips.py). */
export const rideArguments = () => ({
  gaits: Object.fromEntries([...Object.entries(MOUNT_GAITS), ...Object.entries(MOUNT_STILL_SECONDS)]
    .map(([name, gait]) => [name, { seconds: typeof gait === "number" ? gait : gait.seconds }])),
  tack: { reins: [...MOUNT_TACK.reins], stirrup: [...MOUNT_TACK.stirrup] },
  seatHeight: MOUNT_SEAT_HEIGHT,
});
