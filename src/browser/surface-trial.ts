// The limestone surface trial page (#567), bundled into dist/pages/compare/limestone-surface/app.js by
// scripts/build-catalog-pages.ts. It instances both kits on the same Greyhaven-like scatter and blends the layered kit
// with a reference triplanar shader written from the bundle's descriptor. The game owns its own blend shader.
// scripts/measure-surface-trial.ts drives `window.surfaceTrial` for the committed numbers and renders.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

type Manifest = { assets: { key: string; variant: string; path: string; attachments?: { name: string; path: string }[] }[] };
type Level = { variant: string; referenceMaxDistance: number | null };
type Entry = { key: string; role: string; lods: { boundingSphere: { center: number[]; radius: number }; levels: Level[] } };
type Weathering = Record<string, { moss: number; cavity: number }>;
type Surface = { maskAttribute: string; library: { key: string; layers: Record<string, { material: string; tileMetres: number }> }; weathering: Weathering };
type Descriptor = { assets: Entry[]; surface?: Surface };
type Kit = { name: "baked" | "layered"; descriptor: Descriptor; meshes: Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>; library?: Map<string, THREE.MeshStandardMaterial>; bytes: { textureFiles: number; geometryFiles: number } };
type Mode = "baked" | "light" | "medium" | "heavy";
type View = "game" | "mid" | "overview";
type Instance = { role: string; x: number; z: number; rotation: number; scale: number };
type Results = {
  machine?: { gpu?: string; renderer?: string; browser?: string; viewport?: string; note?: string };
  kits?: Record<string, Record<string, number | string>>;
  frames?: { mode: string; view: string; msPerFrame: number; drawCalls: number; triangles: number }[];
  images?: { file: string; caption: string }[];
};

const MODES: Mode[] = ["baked", "light", "medium", "heavy"];
/** The Greyhaven game camera (12 m, 0.42 rad pitch, 50° FOV), then two wider ones that put more rocks on screen. */
const VIEWS: Record<View, { label: string; distance: number; pitch: number; fov: number; target: [number, number, number] }> = {
  game: { label: "Game camera", distance: 12, pitch: 0.42, fov: 50, target: [0, 1, 3] },
  mid: { label: "30 m", distance: 30, pitch: 0.5, fov: 50, target: [0, 0, 6] },
  overview: { label: "Overview", distance: 110, pitch: 0.62, fov: 50, target: [0, 0, -30] },
};
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusLine = element("status");
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MB`;

/** Clusters of an outcrop or ledge with blocks and scree round it, as rocks lie in Greyhaven's fields. */
export function scatter(seed = 567): Instance[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const instances: Instance[] = [];
  const centres: [number, number][] = [[0, 0], [16, -14], [-18, -26]];
  while (centres.length < 48) centres.push([(random() - 0.5) * 360, -random() * 320 + 40]);
  for (const [cx, cz] of centres) {
    const place = (role: string, near: number, far: number, scale: [number, number]) => {
      const angle = random() * Math.PI * 2, reach = near + random() * (far - near);
      instances.push({ role, x: cx + Math.cos(angle) * reach, z: cz + Math.sin(angle) * reach, rotation: random() * Math.PI * 2, scale: scale[0] + random() * (scale[1] - scale[0]) });
    };
    place(pick(["outcrop-1", "outcrop-2", "ledge"]), 0, 0.5, [0.8, 1.2]);
    for (let i = 0, n = 2 + Math.floor(random() * 3); i < n; i += 1) place(pick(["block-1", "block-2", "block-3"]), 4, 10, [0.75, 1.25]);
    for (let i = 0, n = 1 + Math.floor(random() * 2); i < n; i += 1) place(pick(["scree-1", "scree-2"]), 3, 9, [0.8, 1.2]);
  }
  return instances;
}

/** The reference blend: triplanar limestone, moss and soil by the piece's masks, with weathering as thresholds. */
function layeredMaterial(surface: Surface, library: Map<string, THREE.MeshStandardMaterial>) {
  const layer = (name: string) => library.get(surface.library.layers[name]!.material)!;
  const uniforms = {
    uLimestone: { value: layer("limestone").map }, uLimestoneNormal: { value: layer("limestone").normalMap },
    uMoss: { value: layer("moss").map }, uSoil: { value: layer("soil").map },
    uTiles: { value: new THREE.Vector3(surface.library.layers.limestone!.tileMetres, surface.library.layers.moss!.tileMetres, surface.library.layers.soil!.tileMetres) },
    uWeathering: { value: new THREE.Vector2(surface.weathering.medium!.moss, surface.weathering.medium!.cavity) },
  };
  for (const texture of [uniforms.uLimestone, uniforms.uLimestoneNormal, uniforms.uMoss, uniforms.uSoil]) texture.value!.wrapS = texture.value!.wrapT = THREE.RepeatWrapping;
  const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const mask = surface.maskAttribute.toLowerCase();
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
attribute vec4 ${mask};
varying vec4 vMask; varying vec3 vObjPos; varying vec3 vObjNormal; varying vec3 vW0; varying vec3 vW1; varying vec3 vW2;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vMask = ${mask}; vObjPos = position; vObjNormal = normal;
mat3 toWorld = mat3(modelMatrix);
#ifdef USE_INSTANCING
toWorld = toWorld * mat3(instanceMatrix);
#endif
vW0 = toWorld[0]; vW1 = toWorld[1]; vW2 = toWorld[2];`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
uniform sampler2D uLimestone; uniform sampler2D uLimestoneNormal; uniform sampler2D uMoss; uniform sampler2D uSoil;
uniform vec3 uTiles; uniform vec2 uWeathering;
varying vec4 vMask; varying vec3 vObjPos; varying vec3 vObjNormal; varying vec3 vW0; varying vec3 vW1; varying vec3 vW2;
vec3 triWeights(vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z); }
vec3 tri(sampler2D map, vec3 p, vec3 w) { return texture2D(map, p.zy).rgb * w.x + texture2D(map, p.xz).rgb * w.y + texture2D(map, p.xy).rgb * w.z; }`)
      .replace("#include <map_fragment>", `vec3 triW = triWeights(normalize(vObjNormal));
vec3 surface = tri(uLimestone, vObjPos / uTiles.x, triW);
vec3 moss = tri(uMoss, vObjPos / uTiles.y, triW);
surface = mix(surface, moss, smoothstep(uWeathering.x, uWeathering.x + 0.3, vMask.g) * 0.9);
surface = mix(surface, tri(uSoil, vObjPos / uTiles.z, triW), vMask.r);
surface = mix(surface, moss, vMask.b);
surface *= mix(vec3(1.0), vec3(0.18, 0.17, 0.16), clamp(uWeathering.y * vMask.a, 0.0, 1.0));
diffuseColor.rgb *= surface;`)
      .replace("#include <normal_fragment_maps>", `{
vec3 n0 = normalize(vObjNormal); vec3 p = vObjPos / uTiles.x;
vec2 tx = texture2D(uLimestoneNormal, p.zy).xy * 2.0 - 1.0;
vec2 ty = texture2D(uLimestoneNormal, p.xz).xy * 2.0 - 1.0;
vec2 tz = texture2D(uLimestoneNormal, p.xy).xy * 2.0 - 1.0;
vec3 detailed = normalize(vec3(0.0, tx.y, tx.x) * triW.x + vec3(ty.x, 0.0, ty.y) * triW.y + vec3(tz, 0.0) * triW.z + n0);
normal = normalize((viewMatrix * vec4(normalize(mat3(vW0, vW1, vW2) * detailed), 0.0)).xyz);
}`);
  };
  return { material, uniforms };
}

async function loadKit(name: Kit["name"], loader: GLTFLoader): Promise<Kit> {
  const response = await fetch(`${name}/manifest.json`);
  if (!response.ok) throw new Error(`no ${name} bundle`);
  const manifest = await response.json() as Manifest;
  const attachment = manifest.assets.flatMap((asset) => asset.attachments ?? []).find((entry) => entry.name === "limestone-rocks-descriptor")!;
  const descriptor = await (await fetch(`${name}/${attachment.path}`)).json() as Descriptor;
  const meshes = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>();
  let library: Map<string, THREE.MeshStandardMaterial> | undefined;
  const files = new Map<string, number>();
  const measure = async (gltf: GLTF, base: string) => {
    const json = gltf.parser.json as { images?: { uri?: string }[]; buffers?: { uri?: string }[] };
    for (const [kind, list] of [["texture", json.images ?? []], ["geometry", json.buffers ?? []]] as const) {
      for (const item of list) if (item.uri) {
        const url = new URL(item.uri, new URL(base, location.href)).href;
        if (!files.has(`${kind} ${url}`)) files.set(`${kind} ${url}`, (await (await fetch(url)).arrayBuffer()).byteLength);
      }
    }
  };
  // Every piece's GLB names the same atlas files; share one texture per file, as a game's loader would.
  const shared = new Map<string, THREE.Texture>();
  const share = (gltf: GLTF, url: string) => {
    const json = gltf.parser.json as { textures?: { source?: number; extensions?: Record<string, { source?: number }> }[]; images?: { uri?: string }[] };
    gltf.scene.traverse((node) => {
      const material = (node as THREE.Mesh).material as (THREE.MeshStandardMaterial & Record<string, unknown>) | undefined;
      if (!material) return;
      for (const slot of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap"]) {
        const texture = material[slot] as THREE.Texture | null;
        const index = texture && gltf.parser.associations.get(texture)?.textures;
        if (index === undefined || index === null || !texture) continue;
        const entry = json.textures![index]!;
        const image = entry.extensions?.KHR_texture_basisu?.source ?? entry.source;
        const uri = image === undefined ? undefined : json.images?.[image]?.uri;
        if (!uri) continue;
        const key = new URL(uri, new URL(url, location.href)).href;
        if (shared.has(key)) material[slot] = shared.get(key)!; else shared.set(key, texture);
      }
    });
  };
  for (const asset of manifest.assets) {
    const url = `${name}/${asset.path}`;
    const gltf = await loader.loadAsync(url);
    await measure(gltf, url);
    share(gltf, url);
    if (descriptor.surface && asset.key === descriptor.surface.library.key) {
      library = new Map();
      gltf.scene.traverse((node) => { if ((node as THREE.Mesh).isMesh) { const material = (node as THREE.Mesh).material as THREE.MeshStandardMaterial; library!.set(material.name, material); } });
      continue;
    }
    gltf.scene.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) meshes.set(`${asset.key}#${asset.variant}`, { geometry: (node as THREE.Mesh).geometry, material: (node as THREE.Mesh).material as THREE.Material });
    });
  }
  const sum = (kind: string) => [...files].filter(([key]) => key.startsWith(kind)).reduce((total, [, bytes]) => total + bytes, 0);
  return { name, descriptor, meshes, library, bytes: { textureFiles: sum("texture"), geometryFiles: sum("geometry") } };
}

/** Bytes the GPU holds for a material's textures: compressed mip chains as uploaded, others as RGBA8 with mips. */
function textureMemory(materials: THREE.Material[], extra: (THREE.Texture | null | undefined)[] = []) {
  const seen = new Set<THREE.Texture>();
  for (const material of materials) for (const value of Object.values(material)) if (value instanceof THREE.Texture) seen.add(value);
  for (const texture of extra) if (texture) seen.add(texture);
  let bytes = 0;
  const formats = new Set<string>();
  for (const texture of seen) {
    const mipmaps = (texture as THREE.CompressedTexture).mipmaps as { data: ArrayBufferView }[] | undefined;
    if ((texture as THREE.CompressedTexture).isCompressedTexture && mipmaps?.length) {
      bytes += mipmaps.reduce((total, level) => total + level.data.byteLength, 0);
      formats.add(String(texture.format));
    } else {
      const image = texture.image as { width: number; height: number };
      bytes += Math.round(image.width * image.height * 4 * 4 / 3);
      formats.add("rgba8");
    }
  }
  return { textures: seen.size, bytes, formats: [...formats] };
}

async function showResults() {
  const response = await fetch("results/results.json");
  if (!response.ok) return null;
  const results = await response.json() as Results;
  const rows: string[] = [];
  if (results.kits) {
    const keys = [...new Set(Object.values(results.kits).flatMap((kit) => Object.keys(kit)))];
    rows.push(`<table><tr><th></th>${Object.keys(results.kits).map((name) => `<th>${name}</th>`).join("")}</tr>${keys.map((key) => `<tr><td>${key}</td>${Object.values(results.kits!).map((kit) => `<td>${kit[key] ?? ""}</td>`).join("")}</tr>`).join("")}</table>`);
  }
  if (results.frames?.length) {
    rows.push(`<table style="margin-top:10px"><tr><th>camera · surface</th><th>ms / frame</th><th>draws</th><th>triangles</th></tr>${results.frames.map((frame) => `<tr><td>${frame.view} · ${frame.mode}</td><td>${frame.msPerFrame.toFixed(2)}</td><td>${frame.drawCalls}</td><td>${frame.triangles.toLocaleString("en")}</td></tr>`).join("")}</table>`);
  }
  if (results.machine) rows.push(`<p class="note">${Object.entries(results.machine).map(([key, value]) => `${key}: ${value}`).join("<br>")}</p>`);
  element("results").innerHTML = rows.join("");
  return results;
}

async function start() {
  const results = await showResults();
  const canvas = element<HTMLCanvasElement>("view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const ktx2 = new KTX2Loader().setTranscoderPath("basis/").detectSupport(renderer);
  const loader = new GLTFLoader().setKTX2Loader(ktx2);
  let kits: Kit[];
  try {
    kits = [await loadKit("baked", loader), await loadKit("layered", loader)];
  } catch {
    // No live data: show the committed renders instead.
    canvas.hidden = true;
    statusLine.hidden = true;
    const gallery = element("gallery");
    gallery.hidden = false;
    gallery.innerHTML = (results?.images ?? []).map((image) => `<figure><img src="results/${image.file}" alt="${image.caption}" loading="lazy"><figcaption>${image.caption}</figcaption></figure>`).join("")
      || `<p class="note">This page has no data: build both limestone kits and run scripts/measure-surface-trial.ts.</p>`;
    return;
  }
  const [baked, layered] = kits as [Kit, Kit];
  const surface = layered.descriptor.surface!;
  const blend = layeredMaterial(surface, layered.library!);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb9c3c9);
  scene.fog = new THREE.Fog(0xb9c3c9, 160, 420);
  scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x5a5346, 1.3));
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
  sun.position.set(-0.6, 1, 0.45);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x667d46, roughness: 1 }));
  scene.add(ground);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.3, 600);
  const instances = scatter();
  const groups = { baked: new THREE.Group(), layered: new THREE.Group() };
  scene.add(groups.baked, groups.layered);

  let mode: Mode = "baked";
  let view: View = "game";
  const place = () => {
    const v = VIEWS[view];
    const target = new THREE.Vector3(...v.target);
    camera.fov = v.fov;
    camera.position.set(target.x, target.y + v.distance * Math.sin(v.pitch), target.z + v.distance * Math.cos(v.pitch));
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    // Each instance takes the level its distance selects, as the descriptor's referenceMaxDistance says; one InstancedMesh per piece and level.
    for (const kit of kits) {
      const group = groups[kit.name];
      group.clear();
      const buckets = new Map<string, THREE.Matrix4[]>();
      for (const instance of instances) {
        const entry = kit.descriptor.assets.find((asset) => asset.role === instance.role)!;
        const distance = camera.position.distanceTo(new THREE.Vector3(instance.x, 0, instance.z));
        const level = entry.lods.levels.find((candidate) => candidate.referenceMaxDistance === null || distance <= candidate.referenceMaxDistance * instance.scale)!;
        const key = `${entry.key}#${level.variant}`;
        const matrix = new THREE.Matrix4().compose(new THREE.Vector3(instance.x, 0, instance.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), instance.rotation), new THREE.Vector3().setScalar(instance.scale));
        (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(matrix);
      }
      for (const [key, matrices] of buckets) {
        const mesh = kit.meshes.get(key)!;
        const instanced = new THREE.InstancedMesh(mesh.geometry, kit.name === "layered" ? blend.material : mesh.material, matrices.length);
        matrices.forEach((matrix, index) => instanced.setMatrixAt(index, matrix));
        instanced.computeBoundingSphere();
        group.add(instanced);
      }
    }
  };
  const apply = () => {
    groups.baked.visible = mode === "baked";
    groups.layered.visible = mode !== "baked";
    if (mode !== "baked") blend.uniforms.uWeathering.value.set(surface.weathering[mode]!.moss, surface.weathering[mode]!.cavity);
    for (const button of element("modes").children) button.setAttribute("aria-pressed", String(button.id === `mode-${mode}`));
    for (const button of element("views").children) button.setAttribute("aria-pressed", String(button.id === `view-${view}`));
    draw();
  };
  const draw = () => renderer.render(scene, camera);
  const resize = () => {
    const { clientWidth: width, clientHeight: height } = canvas.parentElement!;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    draw();
  };
  new ResizeObserver(resize).observe(canvas.parentElement!);

  const costs = {
    baked: { ...textureMemory([...baked.meshes.values()].map((mesh) => mesh.material)), files: baked.bytes, materials: new Set([...baked.meshes.values()].map((mesh) => mesh.material.name)).size },
    layered: {
      ...textureMemory([], [blend.uniforms.uLimestone.value, blend.uniforms.uLimestoneNormal.value, blend.uniforms.uMoss.value, blend.uniforms.uSoil.value]),
      files: layered.bytes, materials: new Set([...layered.meshes.values()].map((mesh) => mesh.material.name)).size,
    },
  };
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));

  /** Renders `frames` frames back to back and waits for the GPU: the average is the time one frame of this scene takes. */
  const measure = (frames = 240) => {
    const pixel = new Uint8Array(4);
    for (let i = 0; i < 20; i += 1) draw();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const start = performance.now();
    for (let i = 0; i < frames; i += 1) draw();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const msPerFrame = (performance.now() - start) / frames;
    return { mode, view, msPerFrame, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  };

  const statsTable = element("stats");
  const showStats = (frame?: ReturnType<typeof measure>) => {
    const row = (label: string, b: string, l: string) => `<tr><td>${label}</td><td>${b}</td><td>${l}</td></tr>`;
    statsTable.innerHTML = `<tr><th></th><th>baked</th><th>layered</th></tr>`
      + row("texture files", mb(costs.baked.files.textureFiles), mb(costs.layered.files.textureFiles))
      + row("geometry files", mb(costs.baked.files.geometryFiles), mb(costs.layered.files.geometryFiles))
      + row("texture GPU memory", mb(costs.baked.bytes), mb(costs.layered.bytes))
      + row("textures", String(costs.baked.textures), String(costs.layered.textures))
      + row("kit materials", String(costs.baked.materials), String(costs.layered.materials))
      + (frame ? row(`${frame.view} · ${frame.mode}`, `${frame.msPerFrame.toFixed(2)} ms`, `${frame.drawCalls} draws`) : "");
  };
  element("gpu").textContent = `Renderer: ${gpu}. Frame time is this browser's, rendering back to back without vsync and waiting for the GPU.`;

  for (const each of MODES) {
    const node = document.createElement("button");
    node.type = "button"; node.id = `mode-${each}`; node.textContent = each === "baked" ? "Baked" : `Layered · ${each}`;
    node.onclick = () => { mode = each; apply(); };
    element("modes").append(node);
  }
  for (const each of Object.keys(VIEWS) as View[]) {
    const node = document.createElement("button");
    node.type = "button"; node.id = `view-${each}`; node.textContent = VIEWS[each].label;
    node.onclick = () => { view = each; place(); apply(); };
    element("views").append(node);
  }
  element("measure").onclick = () => showStats(measure());
  element("live").hidden = false;
  statusLine.hidden = true;
  place();
  resize();
  apply();
  showStats();
  // Compile both programs before anyone measures.
  renderer.compile(scene, camera);
  (window as unknown as { surfaceTrial: unknown }).surfaceTrial = {
    set(next: { mode?: Mode; view?: View }) { if (next.view) { view = next.view; place(); } if (next.mode) mode = next.mode; apply(); },
    measure, costs, gpu, instances: instances.length,
  };
}

start().catch((error) => { statusLine.textContent = error instanceof Error ? error.message : String(error); });
