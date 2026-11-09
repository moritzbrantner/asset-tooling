// The young residents face page (#556), bundled into dist/pages/compare/young/app.js by scripts/build-catalog-pages.ts.
// Everything shown comes from the bundle's descriptor. The Idle and Walk buttons borrow the Ranger clips the comparison
// page already serves, as the descriptor tells a consumer to. Contract: docs/young-residents.md#sliders.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

type Rgb = [number, number, number];
type Figure = { key: string; figure: string; label: string; pelvisScale: number; look: { skin: number; hair: Rgb; cloth: Rgb; skirt?: Rgb; sliders: Record<string, number> } };
type People = { id: string; label: string; skin: number; offsets: Record<string, number> };
type Descriptor = { morphs: { groups: { id: string; label: string; sliders: { target: string; label: string }[] }[] }; skinTones: Rgb[]; hairColours: Rgb[]; peoples: People[]; figures: Figure[] };
type Manifest = { assets: { key: string; variant: string; path: string; attachments?: { name: string; path: string }[] }[] };
type Look = { dials: Record<string, number>; skin: number; hair: Rgb };

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusLine = element("status");
const css = (rgb: Rgb) => `rgb(${rgb.map((v) => Math.round(255 * Math.pow(Math.min(1, v), 1 / 2.2))).join(",")})`;
const clamp = (v: number) => Math.max(-1, Math.min(1, v));
const button = (text: string, onClick: () => void) => {
  const node = document.createElement("button");
  node.type = "button"; node.textContent = text; node.setAttribute("aria-pressed", "false"); node.onclick = onClick;
  return node;
};

async function start() {
  const manifestResponse = await fetch("bundle/manifest.json");
  if (!manifestResponse.ok) throw new Error("This page has no data yet: the young-residents release has not been published.");
  const manifest = await manifestResponse.json() as Manifest;
  const attachment = manifest.assets.flatMap((asset) => asset.attachments ?? []).find((entry) => entry.name === "young-residents-descriptor");
  if (!attachment) throw new Error("The bundle has no young-residents-descriptor attachment.");
  const descriptor = await (await fetch(`bundle/${attachment.path}`)).json() as Descriptor;
  const keys = descriptor.morphs.groups.flatMap((group) => group.sliders.map((slider) => slider.target));
  const peopleKeys = [...new Set(descriptor.peoples.flatMap((people) => Object.keys(people.offsets)))];

  const canvas = element<HTMLCanvasElement>("view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8f9184);
  scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x5a5346, 1.5));
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.4);
  sun.position.set(-1.2, 2.6, 2.4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(26, 1, .05, 40);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  const draw = () => renderer.render(scene, camera);
  controls.addEventListener("change", draw);
  const resize = () => {
    const { clientWidth: width, clientHeight: height } = canvas.parentElement!;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    draw();
  };
  new ResizeObserver(resize).observe(canvas.parentElement!);

  const ktx2 = new KTX2Loader().setTranscoderPath("basis/").detectSupport(renderer);
  const loader = new GLTFLoader().setKTX2Loader(ktx2);
  const models = new Map<string, THREE.Group>();
  const fresh = (figure: Figure): Look => ({ dials: Object.fromEntries(keys.map((key) => [key, figure.look.sliders[key] ?? 0])), skin: figure.look.skin, hair: figure.look.hair });
  const looks = new Map<string, Look>();
  for (const figure of descriptor.figures) {
    let saved: Look | null = null;
    try { saved = JSON.parse(localStorage.getItem(`young-face.${figure.figure}`) ?? "null"); } catch { /* storage may be unavailable */ }
    looks.set(figure.figure, saved ?? fresh(figure));
  }
  const remember = (figure: Figure) => { try { localStorage.setItem(`young-face.${figure.figure}`, JSON.stringify(looks.get(figure.figure))); } catch { /* storage may be unavailable */ } };

  let current = descriptor.figures[0]!;
  let model: THREE.Group | null = null;
  let view: "face" | "body" = "face";
  let mixer: THREE.AnimationMixer | null = null;
  let clipName = "none";
  let frameRequest = 0;
  const clock = new THREE.Clock();
  const paint = (material: THREE.MeshStandardMaterial, rgb: readonly number[]) => material.color.setRGB(rgb[0]!, rgb[1]!, rgb[2]!, THREE.LinearSRGBColorSpace);

  function apply() {
    if (!model) return;
    const look = looks.get(current.figure)!;
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.morphTargetDictionary) for (const [key, index] of Object.entries(mesh.morphTargetDictionary)) mesh.morphTargetInfluences![index] = look.dials[key] ?? 0;
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (material.name === "skin" || material.name === "hands") paint(material, descriptor.skinTones[look.skin]!);
      else if (material.name === "hair") paint(material, look.hair);
      else if (material.name === "brows") paint(material, look.hair.map((v) => v * .75));
      else if (material.name === "outfit") paint(material, current.look.cloth);
      else if (material.name === "skirt" && current.look.skirt) paint(material, current.look.skirt);
    });
    element<HTMLTextAreaElement>("json").value = JSON.stringify({ figure: current.figure, skin: look.skin, hair: look.hair, sliders: Object.fromEntries(Object.entries(look.dials).filter(([, v]) => Math.abs(v) > .004).map(([k, v]) => [k, +v.toFixed(2)])) });
    draw();
  }
  function frame() {
    if (!model) return;
    const box = new THREE.Box3();
    model.updateMatrixWorld(true);
    model.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh;
      if (!mesh.isMesh || !(view === "body" || mesh.morphTargetDictionary)) return;
      mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox!.clone());
    });
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const height = view === "body" ? size.y * 1.12 : size.y * 1.75;
    const distance = height / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    controls.target.copy(centre);
    camera.position.set(centre.x + distance * .16, centre.y + distance * .02, centre.z + distance);
    controls.minDistance = .25;
    controls.maxDistance = 9;
    controls.update();
    draw();
    element("view-face").setAttribute("aria-pressed", String(view === "face"));
    element("view-body").setAttribute("aria-pressed", String(view === "body"));
  }
  function syncControls() {
    const look = looks.get(current.figure)!;
    for (const input of document.querySelectorAll<HTMLInputElement>("#dials input")) {
      input.value = String(look.dials[input.dataset.key!]);
      input.nextElementSibling!.textContent = (+input.value).toFixed(2);
    }
    document.querySelectorAll("#skins button").forEach((node, index) => node.setAttribute("aria-pressed", String(index === look.skin)));
    document.querySelectorAll("#hairs button").forEach((node, index) => node.setAttribute("aria-pressed", String(descriptor.hairColours[index]!.join() === look.hair.join())));
  }
  const changed = () => { remember(current); syncControls(); apply(); };

  /** The rig rests with the arms out; the Still view lowers them, and a clip's rotation tracks replace this. */
  function relaxArms(root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    for (const side of ["l", "r"]) {
      for (const [name, childName, target] of [[`upperarm_${side}`, `lowerarm_${side}`, [.2, -1, .04]], [`lowerarm_${side}`, `hand_${side}`, [.1, -1, .3]]] as const) {
        const bone = root.getObjectByName(name)!, child = root.getObjectByName(childName)!;
        const from = child.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3())).normalize();
        const x = bone.getWorldPosition(new THREE.Vector3()).x;
        const to = new THREE.Vector3(Math.sign(x) * target[0], target[1], target[2]).normalize();
        const world = new THREE.Quaternion().setFromUnitVectors(from, to).multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
        bone.quaternion.copy(bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
        root.updateMatrixWorld(true);
      }
    }
  }

  async function show(figure: Figure) {
    current = figure;
    document.querySelectorAll<HTMLButtonElement>("#characters button").forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.id === figure.figure)));
    statusLine.textContent = "Loading the character…";
    if (!models.has(figure.figure)) {
      const asset = manifest.assets.find((entry) => entry.key === figure.key)!;
      const loaded = (await loader.loadAsync(`bundle/${asset.path}`)).scene;
      relaxArms(loaded);
      models.set(figure.figure, loaded);
    }
    if (model) scene.remove(model);
    model = models.get(figure.figure)!;
    scene.add(model);
    statusLine.textContent = "";
    syncControls();
    apply();
    frame();
    await playClip(clipName);
  }

  let adultClips: Promise<THREE.AnimationClip[]> | null = null;
  const loadAdultClips = () => adultClips ??= (async () => {
    const root = "../ranger/bundle/";
    const response = await fetch(`${root}manifest.json`);
    if (!response.ok) throw new Error("The Ranger clips aren't available on this page.");
    const ranger = await response.json() as Manifest;
    const asset = ranger.assets.find((entry) => entry.key === "humanoid.ranger.male" && entry.variant === "default");
    if (!asset) throw new Error("The Ranger bundle has no default character.");
    return (await new GLTFLoader().setKTX2Loader(ktx2).loadAsync(root + asset.path)).animations;
  })();
  /** The descriptor's rule: rotation tracks, and the pelvis translation scaled to the figure. */
  function youngClip(clip: THREE.AnimationClip, figure: Figure) {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      if (track.name.endsWith(".quaternion")) tracks.push(track);
      else if (track.name === "pelvis.position") {
        const scaled = track.clone();
        scaled.values = scaled.values.map((value) => value * figure.pelvisScale) as typeof scaled.values;
        tracks.push(scaled);
      }
    }
    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  }
  async function playClip(name: string) {
    clipName = name;
    cancelAnimationFrame(frameRequest);
    mixer?.stopAllAction();
    mixer = null;
    for (const id of ["none", "Idle_Loop", "Walk_Loop"]) element(`clip-${id}`).setAttribute("aria-pressed", String(id === name));
    if (name === "none" || !model) { draw(); return; }
    statusLine.textContent = "Loading the adult clips…";
    const clip = (await loadAdultClips()).find((candidate) => candidate.name === name);
    if (!clip) throw new Error(`The Ranger bundle has no ${name} clip.`);
    statusLine.textContent = "";
    if (clipName !== name || !model) return;
    mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(youngClip(clip, current)).play();
    clock.getDelta();
    const tick = () => {
      if (!mixer) return;
      mixer.update(clock.getDelta());
      draw();
      frameRequest = requestAnimationFrame(tick);
    };
    tick();
    (window as unknown as { __young: unknown }).__young = { mixer, draw };
  }
  const report = (error: unknown) => { statusLine.textContent = error instanceof Error ? error.message : String(error); };

  for (const figure of descriptor.figures) {
    const node = button(figure.label, () => { show(figure).catch(report); });
    node.dataset.id = figure.figure;
    element("characters").append(node);
  }
  for (const people of descriptor.peoples) {
    element("peoples").append(button(people.label, () => {
      const look = looks.get(current.figure)!;
      for (const key of peopleKeys) look.dials[key] = clamp((current.look.sliders[key] ?? 0) + (people.offsets[key] ?? 0));
      look.skin = people.skin;
      changed();
    }));
  }
  descriptor.skinTones.forEach((rgb, index) => {
    const node = button("", () => { looks.get(current.figure)!.skin = index; changed(); });
    node.className = "swatch"; node.title = `Skin tone ${index + 1}`; node.setAttribute("aria-label", node.title);
    node.style.background = css(rgb.map((v) => v * .72) as Rgb);
    element("skins").append(node);
  });
  descriptor.hairColours.forEach((rgb, index) => {
    const node = button("", () => { looks.get(current.figure)!.hair = rgb; changed(); });
    node.className = "swatch"; node.title = `Hair colour ${index + 1}`; node.setAttribute("aria-label", node.title);
    node.style.background = css(rgb);
    element("hairs").append(node);
  });
  for (const group of descriptor.morphs.groups) {
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = group.label;
    section.append(heading);
    for (const { target, label } of group.sliders) {
      const row = document.createElement("div");
      row.className = "dial";
      const text = document.createElement("label");
      text.textContent = label; text.htmlFor = `dial-${target}`;
      const input = document.createElement("input");
      Object.assign(input, { type: "range", id: `dial-${target}`, min: "-1", max: "1", step: ".01" });
      input.dataset.key = target;
      input.oninput = () => { looks.get(current.figure)!.dials[target] = +input.value; input.nextElementSibling!.textContent = (+input.value).toFixed(2); remember(current); apply(); };
      input.ondblclick = () => { looks.get(current.figure)!.dials[target] = current.look.sliders[target] ?? 0; changed(); };
      row.append(text, input, document.createElement("output"));
      section.append(row);
    }
    element("dials").append(section);
  }
  element("view-face").onclick = () => { view = "face"; frame(); };
  element("view-body").onclick = () => { view = "body"; frame(); };
  for (const id of ["none", "Idle_Loop", "Walk_Loop"]) element(`clip-${id}`).onclick = () => { playClip(id).catch(report); };
  element("reset").onclick = () => { looks.set(current.figure, fresh(current)); changed(); };
  element("copy").onclick = async () => {
    const note = element("copied");
    try { await navigator.clipboard.writeText(element<HTMLTextAreaElement>("json").value); note.textContent = "Copied."; }
    catch { note.textContent = "Your browser blocked copying. Select the text below instead."; }
  };
  resize();
  await show(current);
  (document.documentElement as HTMLElement).dataset.ready = "true";
}

start().catch((error) => { statusLine.textContent = error instanceof Error ? error.message : String(error); });
