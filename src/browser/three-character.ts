// Plain three.js character loading for the Pages viewers (Atlas Decision 7.1.1, #281): GLTFLoader parses the
// glTF, SkeletonUtils clones a posable copy per view, and an AnimationMixer per copy seeks clips. No custom
// skinning or clip sampling.
import { AnimationMixer, DirectionalLight, Group, HemisphereLight, Scene, type AnimationAction, type AnimationClip, type Mesh, type Object3D } from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

/** One posed copy of a character; `seek` takes a clip by name or index. */
export type CharacterInstance = { root: Object3D; seek(clip: string | number, seconds: number): void; dispose(): void };
/** `name` is the authored glTF name; GLTFLoader invents `animation_N` for unnamed clips, which is not shown. */
export type CharacterClip = { index: number; name: string | null; duration: number };
export type CharacterAsset = { gltf: GLTF; clips: CharacterClip[]; createInstance(): CharacterInstance; dispose(): void };

export function characterAsset(gltf: GLTF, animations: AnimationClip[] = gltf.animations): CharacterAsset {
  return {
    gltf,
    clips: animations.map((clip, index) => ({ index, name: authoredName(gltf, clip), duration: clip.duration })),
    createInstance() {
      const root = cloneSkinned(gltf.scene);
      // GLTFLoader binds tracks of unnamed nodes by uuid; give the clone's unnamed nodes the source uuids.
      const sources: Object3D[] = [];
      gltf.scene.traverse((node) => { sources.push(node); });
      let position = 0;
      root.traverse((node) => { const source = sources[position++]; if (source && !source.name) node.uuid = source.uuid; });
      const mixer = new AnimationMixer(root);
      const actions = new Map<AnimationClip, AnimationAction>();
      let current: AnimationAction | null = null;
      return {
        root,
        seek(selector, seconds) {
          const clip = typeof selector === "number" ? animations[selector] : animations.find((candidate) => candidate.name === selector);
          if (!clip) return;
          let action = actions.get(clip);
          if (!action) actions.set(clip, (action = mixer.clipAction(clip)));
          if (current !== action) { current?.stop(); current = action; action.play(); }
          action.time = Math.max(0, Math.min(seconds, clip.duration));
          mixer.update(0);
        },
        dispose() { mixer.stopAllAction(); mixer.uncacheRoot(root); },
      };
    },
    dispose() {
      gltf.scene.traverse((node) => {
        const mesh = node as Mesh;
        mesh.geometry?.dispose();
        for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
          for (const value of Object.values(material)) if (value && typeof value === "object" && "isTexture" in value) (value as { dispose(): void }).dispose();
          material.dispose();
        }
      });
    },
  };
}

function authoredName(gltf: GLTF, clip: AnimationClip): string | null {
  const position = gltf.animations.indexOf(clip);
  if (position < 0) return clip.name || null;
  const source = (gltf.parser?.json as { animations?: { name?: string }[] } | undefined)?.animations;
  return source?.[position]?.name ?? null;
}

/** A scene with neutral studio light and one group whose children are replaced per render. */
export function viewerScene(): { scene: Scene; content: Group } {
  const scene = new Scene();
  scene.add(new HemisphereLight(0xffffff, 0x445566, 1.5));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const content = new Group();
  scene.add(content);
  return { scene, content };
}
