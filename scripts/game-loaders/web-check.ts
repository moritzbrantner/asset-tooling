// The browser side of scripts/check-game-loaders.ts (#691), bundled into the page it opens: three's GLTFLoader with
// the meshopt decoder and a KTX2Loader whose transcoder support is detected against a real WebGL renderer, as
// moenarch-games/mmorpg's web client configures them (web/src/world/units/quaternius-units.ts).
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

export type WebResult = { url: string; ok: true; meshes: number; textures: number; clips: number } | { url: string; ok: false; error: string };

const renderer = new THREE.WebGLRenderer({ canvas: document.createElement("canvas") });
const textures = new KTX2Loader().setTranscoderPath("basis/").detectSupport(renderer);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(textures);

// GLTFLoader reports a texture it could not decode with console.error and loads the scene without it; the game
// would draw it untextured, so a logged error fails the entry.
const logged: string[] = [];
const report = console.error.bind(console);
console.error = (...args: unknown[]) => {
  logged.push(args.map((arg) => arg instanceof Error ? arg.message : String(arg)).join(" "));
  report(...args);
};

async function load(url: string): Promise<WebResult> {
  logged.length = 0;
  try {
    const gltf = await loader.loadAsync(url);
    if (logged.length) throw new Error(logged.join("; "));
    let meshes = 0;
    const maps = new Set<THREE.Texture>();
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes += 1;
      const position = (object.geometry as THREE.BufferGeometry).getAttribute("position");
      if (!position || position.count === 0) throw new Error(`${object.name || "a mesh"} has no positions`);
      for (const material of [object.material].flat() as THREE.Material[]) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) maps.add(value);
      }
    });
    for (const map of maps) {
      if (!map.image && !(map as THREE.CompressedTexture).mipmaps?.length) throw new Error("a texture decoded to no image");
    }
    return { url, ok: true, meshes, textures: maps.size, clips: gltf.animations.length };
  } catch (error) {
    return { url, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

declare global {
  interface Window { checkGameLoaders(urls: string[]): Promise<WebResult[]> }
}

window.checkGameLoaders = async (urls) => {
  const results: WebResult[] = [];
  for (const url of urls) results.push(await load(url));
  return results;
};
