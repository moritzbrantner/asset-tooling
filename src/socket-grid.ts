// The socket-grid part convention shared by the Shooter robot, weapon and locomotion kits (docs/combat-robot-kit.md,
// #595, #594, #634). It mirrors Shooter's part frames (crates/shooter-sim/src/robot.rs, shooter#71): parts are cuboids of
// whole 20 cm cells, sockets sit one per surface cell on the faces a part type declares, numbered face by face and row
// by row, and a child sits on one parent socket with its own mount face (its -z face) against the parent's face.
//
// Asset frame: metres, +Y up, right-handed glTF. A part's own x, y, z (Shooter's frame, z the height) are glTF +X, -Z
// and +Y. The origin is the mount anchor: the centre of the base's first cell (0, 0) on the mount face. Rotating a part
// about its mount anchor therefore turns its footprint exactly as Shooter's quarter turns do.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** The edge of one socket cell in metres (Shooter's CELL_MM, provisional Atlas Q2.i70.2). */
export const SOCKET_CELL = 0.2;

/** Every face, in Shooter's socket-numbering order (`Face::ALL`). `NegZ` is a part's mount face. */
export const FACES = ["PosX", "NegX", "PosY", "NegY", "PosZ", "NegZ"] as const;
export type Face = (typeof FACES)[number];

/** Each face's normal axis and sign, and the part axes of its socket grid's u and v (Shooter's `Face::grid`). */
const FACE_AXES: Record<Face, { normal: 0 | 1 | 2; sign: 1 | -1; u: 0 | 1 | 2; v: 0 | 1 | 2 }> = {
  PosX: { normal: 0, sign: 1, u: 1, v: 2 },
  NegX: { normal: 0, sign: -1, u: 2, v: 1 },
  PosY: { normal: 1, sign: 1, u: 2, v: 0 },
  NegY: { normal: 1, sign: -1, u: 0, v: 2 },
  PosZ: { normal: 2, sign: 1, u: 0, v: 1 },
  NegZ: { normal: 2, sign: -1, u: 1, v: 0 },
};

/** A part-frame vector (x, y, z; z up) as a glTF vector (+X, +Y up, +Z). */
export const partToGltf = ([x, y, z]: readonly number[]): Vec3 => [clean(x!), clean(z!), clean(-y!)];
/** A glTF vector as a part-frame vector. */
export const gltfToPart = ([x, y, z]: readonly number[]): Vec3 => [clean(x!), clean(-z!), clean(y!)];

const clean = (value: number) => { const r = Math.round(value * 1e9) / 1e9; return r === 0 ? 0 : r; };
const unit = (axis: number, sign = 1): Vec3 => { const v: Vec3 = [0, 0, 0]; v[axis] = sign; return v; };

/** A face's socket grid on a cuboid of `cells`: (columns, rows). */
export function faceGrid(face: Face, cells: readonly number[]): [number, number] {
  const { u, v } = FACE_AXES[face];
  return [cells[u]!, cells[v]!];
}

/** A face's outward normal and its grid's u and v axes, in the part frame. u x v is the normal. */
export function faceFrame(face: Face) {
  const { normal, sign, u, v } = FACE_AXES[face];
  return { normal: unit(normal, sign), u: unit(u), v: unit(v) };
}

export type Socket = { id: number; face: Face; u: number; v: number; position: Vec3; normal: Vec3; uAxis: Vec3; vAxis: Vec3 };

/**
 * Every socket of a part type, by Shooter's `PartType::socket` numbering: faces in `FACES` order, on a face row by row
 * (`id = base + v * columns + u`), cells counted from the cuboid's minimum corner. Positions are the centres of the
 * cells on the face, normals and grid axes are unit vectors, all in the glTF asset frame.
 */
export function partSockets(cells: readonly number[], faces: readonly Face[]): Socket[] {
  const sockets: Socket[] = [];
  for (const face of FACES) {
    if (!faces.includes(face)) continue;
    const { normal, sign, u: uAxis, v: vAxis } = FACE_AXES[face];
    const [columns, rows] = faceGrid(face, cells);
    const frame = faceFrame(face);
    for (let v = 0; v < rows; v += 1) for (let u = 0; u < columns; u += 1) {
      const local = [0, 0, 0];
      local[normal] = sign > 0 ? cells[normal]! : 0;
      local[uAxis] = u + 0.5;
      local[vAxis] = v + 0.5;
      // Cells to metres, from the minimum corner to the mount anchor (cell (0, 0) of the base, on the mount face).
      const position = partToGltf([(local[0]! - 0.5) * SOCKET_CELL, (local[1]! - 0.5) * SOCKET_CELL, local[2]! * SOCKET_CELL]);
      sockets.push({ id: sockets.length, face, u, v, position, normal: partToGltf(frame.normal), uAxis: partToGltf(frame.u), vAxis: partToGltf(frame.v) });
    }
  }
  return sockets;
}

/** A part type's cuboid in the glTF asset frame. */
export function partCuboid(cells: readonly number[]): { min: Vec3; max: Vec3 } {
  const a = partToGltf([-SOCKET_CELL / 2, -SOCKET_CELL / 2, 0]);
  const b = partToGltf([cells[0]! * SOCKET_CELL - SOCKET_CELL / 2, cells[1]! * SOCKET_CELL - SOCKET_CELL / 2, cells[2]! * SOCKET_CELL]);
  return { min: [0, 1, 2].map((k) => Math.min(a[k]!, b[k]!)) as Vec3, max: [0, 1, 2].map((k) => Math.max(a[k]!, b[k]!)) as Vec3 };
}

/** Shooter's orientation: binary angles (65 536 a turn), yaw about the socket normal, then pitch, then roll (intrinsic Z-Y-X). */
export type Orientation = { yaw: number; pitch: number; roll: number };
export const IDENTITY: Orientation = { yaw: 0, pitch: 0, roll: 0 };
export const QUARTER_TURN = 16_384;

type Mat3 = [Vec3, Vec3, Vec3]; // columns
const mulVec = (m: Mat3, v: readonly number[]): Vec3 => [0, 1, 2].map((r) => m[0][r]! * v[0]! + m[1][r]! * v[1]! + m[2][r]! * v[2]!) as Vec3;
const mulMat = (a: Mat3, b: Mat3): Mat3 => [mulVec(a, b[0]), mulVec(a, b[1]), mulVec(a, b[2])];
const rot = (axis: 0 | 1 | 2, binary: number): Mat3 => {
  const t = (binary / 65_536) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
  const [i, j] = ([[1, 2], [2, 0], [0, 1]] as const)[axis]; // cyclic, so every turn is right-handed about its axis
  const m: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  m[i]![i] = c; m[i]![j] = s; m[j]![i] = -s; m[j]![j] = c;
  return m;
};

/** A rigid transform in the glTF frame: a rotation (columns) and a translation. */
export type Transform = { rotation: Mat3; translation: Vec3 };
export const IDENTITY_TRANSFORM: Transform = { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0] };

export function compose(a: Transform, b: Transform): Transform {
  const t = mulVec(a.rotation, b.translation);
  return { rotation: mulMat(a.rotation, b.rotation), translation: [0, 1, 2].map((k) => t[k]! + a.translation[k]!) as Vec3 };
}

export const apply = (t: Transform, p: readonly number[]): Vec3 => {
  const r = mulVec(t.rotation, p);
  return [0, 1, 2].map((k) => r[k]! + t.translation[k]!) as Vec3;
};

/**
 * Where a child sits on a parent socket, in the parent's glTF frame: the child's mount anchor on the socket, its +X
 * along the socket's u, its -Z along v and its +Y along the outward normal, then turned by `orientation` in the
 * socket's (u, v, normal) frame.
 */
export function mountTransform(socket: Pick<Socket, "position" | "normal" | "uAxis" | "vAxis">, orientation: Orientation = IDENTITY): Transform {
  const basis: Mat3 = [[...socket.uAxis], [...socket.vAxis], [...socket.normal]];
  const turn = mulMat(mulMat(rot(2, orientation.yaw), rot(1, orientation.pitch)), rot(0, orientation.roll));
  // glTF part axes into (u, v, n): +X -> u, +Y -> n, +Z -> -v.
  const childAxes: Mat3 = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
  return { rotation: mulMat(mulMat(basis, turn), childAxes), translation: [...socket.position] };
}

/** A rotation matrix (columns) as a unit quaternion [x, y, z, w]. */
export function quaternion(m: Mat3): Quat {
  const [[m00, m10, m20], [m01, m11, m21], [m02, m12, m22]] = m;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return q.map((value) => clean(Number(value.toFixed(9)))) as Quat;
}

/** The faces a Shooter `Faces` value names: every face, only the moving side (+z), or none. */
export const SOCKET_FACES = { ALL: [...FACES], TOP: ["PosZ"], NONE: [] } as const satisfies Record<string, readonly Face[]>;
