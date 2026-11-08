import { NodeIO } from "@gltf-transform/core";

/**
 * The GLB without its textures and images (#516): the geometry, skins, morph targets, animations and material factors
 * stay. A Blender recipe that only reads geometry (shape keys, clips, armour fitting) gets this instead of the
 * full-resolution textures it would decode and re-save; the shipped asset keeps its own textures, since only the
 * recipe's morph targets or animations come back (`transferMorphTargets`, `scene.extract.animation.gltf@1`). A GLB
 * without textures is returned unchanged.
 */
export async function withoutTextures(bytes: Uint8Array): Promise<Uint8Array> {
  const io = new NodeIO().setAllowNetwork(false);
  const document = await io.readBinary(bytes);
  const textures = document.getRoot().listTextures();
  if (!textures.length) return bytes;
  for (const texture of textures) texture.dispose();
  return io.writeBinary(document);
}
