import { FileSource, PMTiles } from "pmtiles";
import { VectorTile, classifyRings } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256Bytes, sha256File } from "../../src/hash.js";
import { verifyMapsArchive, type MapsArchiveCandidate } from "../../src/maps-shortbread.js";
// The existing generation API is at the repository's gradual untyped migration seam.
const { generateAsset, verifyAsset }: {
  generateAsset: (p: string) => Promise<unknown>;
  verifyAsset: (p: string) => Promise<{status: string;checks?: Record<string,boolean>}>;
} = await import(new URL("../../src/core.js", import.meta.url).href);
const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const root = path.join(repository, ".asset-tooling/maps-shortbread");
const pins = {
  planetiler: { file:"planetiler.jar", url:"https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar", sha256:"f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d", bytes:93278824 },
  osm: { file:"liechtenstein-261025.osm.pbf", url:"https://download.geofabrik.de/europe/liechtenstein-261025.osm.pbf", sha256:"bd5cca3fdcb4e9900ad74b4c33e554750088705bd4b4deaa35c1517d7be2378b", bytes:3480519 },
  inspector: { file:"pmtiles.tar.gz", url:"https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Linux_x86_64.tar.gz", sha256:"3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f", bytes:17444324, executableSha256:"a7e9ae10184d109c83f456ccdf6df4f3e2a64ba6cf69d9ed0f9f1840305055c1" },
};
async function reconcile(file: string, bytes: string | Uint8Array) {
  const current = Bun.file(file);
  if (await current.exists() && Buffer.from(await current.arrayBuffer()).equals(Buffer.from(bytes))) { return; }
  await writeFile(`${file}.partial`,bytes); await rename(`${file}.partial`,file);
}
async function acquire() {
  await mkdir(root,{recursive:true});
  for (const pin of Object.values(pins)) {
    const file = path.join(root,pin.file);
    if (await Bun.file(file).exists() && await sha256File(file)===pin.sha256 && (await stat(file)).size===pin.bytes) { continue; }
    const response = await fetch(pin.url,{signal:AbortSignal.timeout(120000)});
    if (!response.ok) { throw new Error(`acquisition failed ${pin.url}: ${response.status}`); }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (sha256Bytes(bytes)!==pin.sha256 || bytes.length!==pin.bytes) { throw new Error(`source pin mismatch ${pin.url}`); }
    await reconcile(file,bytes);
  }
  if (process.platform!=="linux" || process.arch!=="x64") { throw new Error("inspector acquisition currently supports Linux x64; use pinned upstream build on other hosts"); }
  const inspector = path.join(root,"pmtiles");
  if (!await Bun.file(inspector).exists() || await sha256File(inspector)!==pins.inspector.executableSha256) {
    await execute("tar",["-xzf",path.join(root,pins.inspector.file),"-C",root,"pmtiles"],{timeout:10000});
  }
  if (await sha256File(inspector)!==pins.inspector.executableSha256) { throw new Error("inspector executable pin mismatch"); }
  await reconcile(path.join(root,"acquisition.json"),JSON.stringify({version:1,inputs:pins,source:{license:"ODbL-1.0",attribution:"© OpenStreetMap contributors (ODbL-1.0)",licenseUrl:"https://www.openstreetmap.org/copyright",snapshot:"2026-10-25T21:21:21Z",producer:"Geofabrik",terms:"https://download.geofabrik.de/",planetilerLicense:"Apache-2.0",inspectorLicense:"BSD-3-Clause"}},null,2)+"\n");
}
const candidates = [
  {id:"liechtenstein",bounds:[9.47,47.04,9.64,47.28]},
  {id:"liechtenstein-north",bounds:[9.47,47.16,9.64,47.28]},
];
async function verify(id: string) {
  if (await sha256File(path.join(root,"pmtiles"))!==pins.inspector.executableSha256) { throw new Error("inspector executable pin mismatch; run explicit acquisition"); }
  const manifest = JSON.parse(await readFile(path.join(root,`${id}.manifest.json`),"utf8"));
  await execute(path.join(root,"pmtiles"),["verify",path.join(root,`${id}.pmtiles`)],{timeout:30000});
  const content = await verifyMapsArchive(await readFile(path.join(root,`${id}.pmtiles`)),manifest);
  const replay = await verifyAsset(path.join(root,`${id}.asset.json`));
  // Approximate backend: exact means replay bytes matched here, not a universal promise.
  if (replay.status!=="exact") { throw new Error(`replay verification failed: ${JSON.stringify(replay)}`); }
  return {id,upstreamInspector:"go-pmtiles 1.31.2 verify passed",content,replay};
}
async function exportSmoke() {
  const directory = path.join(root,"smoke"); await mkdir(directory,{recursive:true});
  const samples = [];
  for (const c of candidates) {
    const bytes = await readFile(path.join(root,`${c.id}.pmtiles`));
    const manifest = JSON.parse(await readFile(path.join(root,`${c.id}.manifest.json`),"utf8"));
    const verified = await verifyMapsArchive(bytes,manifest);
    const archive = new PMTiles(new FileSource(new File([bytes],c.id)));
    for (const purpose of ["waterHole","water_lines","buildings"]) {
      const location = verified.representatives[purpose]; if (!location) { throw new Error(`missing ${purpose}`); }
      const {z,x,y} = location; const raw = await archive.getZxy(z,x,y); if (!raw) { throw new Error("missing smoke tile"); }
      const tileBytes = new Uint8Array(raw.data), file = `${c.id}-${purpose}-${z}-${x}-${y}.mvt`;
      await reconcile(path.join(directory,file),tileBytes);
      const tile = new VectorTile(new Pbf(tileBytes));
      const counts: Record<string,number> = {}; let holes=0;
      for (const [name,layer] of Object.entries(tile.layers)) {
        counts[name]=layer.length;
        if (name === "water_polygons") { for (let i=0;i<layer.length;i++) { holes += classifyRings(layer.feature(i).loadGeometry()).reduce((sum,p)=>sum+p.length-1,0); } }
      }
      samples.push({candidate:c.id,purpose,z,x,y,path:file,sha256:sha256Bytes(tileBytes),bytes:tileBytes.length,counts,waterHoles:holes,archiveSha256:manifest.archiveRef.sha256});
    }
  }
  const handoff = {version:1,format:"mvt",schema:"shortbread/1.0",extent:4096,nominalTileSize:512,minZoom:10,maxZoom:14,
    attribution:"© OpenStreetMap contributors (ODbL-1.0)",license:"ODbL-1.0",samples};
  await reconcile(path.join(directory,"handoff.json"),JSON.stringify(handoff,null,2)+"\n");
  console.log(JSON.stringify({handoff:path.join(directory,"handoff.json"),samples:samples.length}));
}
async function build() {
  await mkdir(root,{recursive:true});
  for (const pin of Object.values(pins)) {
    if (await sha256File(path.join(root,pin.file))!==pin.sha256) { throw new Error("acquire pinned dependencies first"); }
  }
  await reconcile(path.join(root,"profile.yml"),await readFile(new URL("profile.yml",import.meta.url)));
  const profileHash = await sha256File(path.join(root,"profile.yml"));
  const results = [];
  for (const candidate of candidates) {
    const spec = {schemaVersion:1,assetId:`maps.${candidate.id}`,generator:{id:"external.planetiler.shortbread",version:"1"},randomness:{mode:"none"},
      inputs:{profile:{path:"profile.yml",sha256:profileHash},osm:{path:pins.osm.file,sha256:pins.osm.sha256},planetiler:{path:pins.planetiler.file,sha256:pins.planetiler.sha256}},models:{},
      parameters:{javaVersion:"21.0.10",bounds:candidate.bounds,minZoom:10,maxZoom:14},output:{path:`${candidate.id}.pmtiles`},reproducibility:{expected:"approximate"}};
    const specPath = path.join(root,`${candidate.id}.asset.json`);
    await reconcile(specPath,JSON.stringify(spec,null,2)+"\n");
    const generation = await generateAsset(specPath);
    const bytes = await readFile(path.join(root,`${candidate.id}.pmtiles`));
    const sha256 = sha256Bytes(bytes);
    const manifest: MapsArchiveCandidate = {version:1,sourceId:`maps-${candidate.id}`,dataRevision:`sha256:${sha256}`,format:"mvt",schema:{id:"shortbread",version:"1.0",sourceLayers:["land","water_polygons","water_lines","streets","buildings","boundaries"]},projection:"web-mercator",scheme:"xyz",bounds:candidate.bounds,minZoom:10,maxZoom:14,tileSize:512,
      attribution:"© OpenStreetMap contributors (ODbL-1.0)",license:"ODbL-1.0",provenance:`Geofabrik Liechtenstein PBF ${pins.osm.sha256}; Planetiler 0.10.2 JAR ${pins.planetiler.sha256}; profile ${profileHash}. Candidate only; no owner approval or runtime transport claim.`,observation:{snapshot:"2026-10-25T21:21:21Z"},
      archiveRef:{format:"pmtiles",version:3,path:`${candidate.id}.pmtiles`,sha256,bytes:bytes.length,mvtExtent:4096}};
    await reconcile(path.join(root,`${candidate.id}.manifest.json`),JSON.stringify(manifest,null,2)+"\n");
    results.push({generation,verification:await verify(candidate.id)});
  }
  if (results[0]?.verification.content.archiveSha256===results[1]?.verification.content.archiveSha256) { throw new Error("candidate revision collision"); }
  await reconcile(path.join(root,"verification.json"),JSON.stringify(results,null,2)+"\n");
  console.log(JSON.stringify(results,null,2));
}
switch(process.argv[2]) {
  case "acquire": await acquire(); break;
  case "build": await build(); await exportSmoke(); break;
  case "export-smoke": await exportSmoke(); break;
  case "verify": for (const c of candidates) { console.log(JSON.stringify(await verify(c.id))); } break;
  default: throw new Error("Usage: bun examples/maps-shortbread/build.ts acquire|build|verify|export-smoke");
}
