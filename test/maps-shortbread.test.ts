import { describe, expect, test } from "bun:test";
import { parseAssetSpec } from "../src/schema.js";
import { PLANETILER_BACKEND } from "../src/maps-shortbread-backend.js";

function document(parameters: Record<string, unknown> = {}) {
  const parsed = parseAssetSpec({schemaVersion:1,assetId:"maps.test",generator:{id:"external.planetiler.shortbread",version:"1"},
    randomness:{mode:"none"},inputs:Object.fromEntries(["profile","osm","planetiler"].map(name=>[name,{path:name,sha256:name === "planetiler" ? "f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d" : "0".repeat(64)}])),models:{},
    parameters:{javaVersion:"21.0.10",bounds:[9.47,47.04,9.64,47.28],minZoom:10,maxZoom:14,...parameters},output:{path:".asset-tooling/test.pmtiles"},reproducibility:{expected:"approximate"}});
  return {spec:parsed,canonical:"",sha256:"0".repeat(64),root:"/tmp",absolutePath:"/tmp/asset.json"};
}

describe("bounded Shortbread recipe",()=>{
  test("accepts bounded regional MVT generation",()=>{expect(()=>PLANETILER_BACKEND.validate(document())).not.toThrow();});
  test.each([
    {bounds:[-180,-85,180,85]}, {maxZoom:20}, {minZoom:14,maxZoom:12}, {javaVersion:"latest"}, {download:true},
  ])("rejects unbounded or undeclared execution %j",parameters=>{expect(()=>PLANETILER_BACKEND.validate(document(parameters))).toThrow();});
});

import { readFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { verifyMapsArchive, validateMapsArchiveCandidate, type MapsArchiveCandidate } from "../src/maps-shortbread.js";
import { sha256Bytes } from "../src/hash.js";
const fixture = await readFile(new URL("fixtures/maps-shortbread/fixture.pmtiles", import.meta.url));
function candidate(bytes: Uint8Array = fixture): MapsArchiveCandidate {
  const sha256 = sha256Bytes(bytes);
  return { version:1,sourceId:"maps-hermetic-fixture",dataRevision:`sha256:${sha256}`,format:"mvt",schema:{id:"shortbread",version:"1.0",sourceLayers:["land","water_polygons","water_lines","streets","buildings","boundaries"]},
    projection:"web-mercator",scheme:"xyz",bounds:[9.47,47.04,9.64,47.28],minZoom:10,maxZoom:11,tileSize:512,
    attribution:"Asset-tooling contributors (CC0-1.0)",license:"CC0-1.0",provenance:"Owned illustrative fixture; Planetiler v0.10.2; no real-world geographic claims",observation:{snapshot:"fixture-v1"},
    archiveRef:{format:"pmtiles",version:3,path:"fixture.pmtiles",sha256,bytes:bytes.length,mvtExtent:4096}};
}
describe("hermetic PMTiles v3 Shortbread compatibility",()=>{
  test("verifies all six layers and a water hole using upstream readers",async()=>{
    const result = await verifyMapsArchive(fixture,candidate());
    expect(result.tiles).toBeGreaterThan(0);expect(result.waterHoleFeatures).toBeGreaterThan(0);
    expect(Object.keys(result.counts).sort()).toEqual(candidate().schema.sourceLayers.sort());
  });
  test.each([
    {format:"png"},{projection:"geographic"},{schema:{id:"openmaptiles",version:"1.0",sourceLayers:["water"]}},
    {attribution:""},{license:""},{dataRevision:"moving-latest"},{bounds:[0,0,1,1]},
  ])("rejects mismatched metadata %j",async patch=>{await expect(verifyMapsArchive(fixture,{...candidate(),...patch})).rejects.toThrow();});
  test("rejects bad output hash and an accidental source revision collision",async()=>{
    const bytes=Uint8Array.from(fixture);bytes[0]=0;
    await expect(verifyMapsArchive(bytes,candidate())).rejects.toThrow("hash/size");
    expect(()=>validateMapsArchiveCandidate({...candidate(),dataRevision:`sha256:${"0".repeat(64)}`})).toThrow("revision collision");
    await expect(verifyMapsArchive(bytes,candidate(bytes))).rejects.toThrow();
  });
  test("rejects missing addressed tiles",async()=>{
    const bytes=Uint8Array.from(fixture);const view=new DataView(bytes.buffer);view.setBigUint64(72,view.getBigUint64(72,true)+1n,true);
    await expect(verifyMapsArchive(bytes,candidate(bytes))).rejects.toThrow("missing tiles");
  });
  test("rejects duplicate directory tile IDs",async()=>{
    const bytes=Uint8Array.from(fixture);const view=new DataView(bytes.buffer);
    const offset=Number(view.getBigUint64(8,true)),length=Number(view.getBigUint64(16,true));
    const directory=gunzipSync(bytes.slice(offset,offset+length));
    // The upstream-generated fixture has multiple entries. Skip the count and first TileID varint,
    // then corrupt the second delta to zero; no hand-written archive encoder is used.
    expect(directory[0]).toBeGreaterThanOrEqual(2);
    let position=1;while(directory[position++]! & 128) { /* skip first TileID */ }
    let end=position;while(directory[end++]! & 128) { /* skip second TileID */ }
    const compressed=gzipSync(Buffer.concat([directory.subarray(0,position),Buffer.of(0),directory.subarray(end)]));expect(offset+compressed.length).toBeLessThan(16384);
    view.setBigUint64(16,BigInt(compressed.length),true);bytes.set(compressed,offset);
    await expect(verifyMapsArchive(bytes,candidate(bytes))).rejects.toThrow("duplicate");
  });
});

test("the shared hermetic fixture retains its reviewed input/profile/output pins",async()=>{
  const provenance = JSON.parse(await readFile(new URL("fixtures/maps-shortbread/provenance.json",import.meta.url),"utf8"));
  expect(provenance.license).toBe("CC0-1.0");
  for (const [file,pin] of Object.entries(provenance.files)) {
    const bytes=await readFile(new URL(`fixtures/maps-shortbread/${file}`,import.meta.url));
    expect(pin).toEqual({sha256:sha256Bytes(bytes),bytes:bytes.length});
  }
});
