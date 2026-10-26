import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateMapsArchiveCandidate } from "../../src/maps-shortbread.js";

// Explicit consumer-specific compatibility operation; never imported by generic generation.
// The selected Maps checkout must already be acquired; no network or source mutation here.
const checkout = process.argv[2], candidate = process.argv[3];
if (!checkout || !candidate) { throw new Error("Usage: bun examples/maps-shortbread/verify-maps-contract.ts <Maps checkout> <manifest.json>"); }
const execute = promisify(execFile);
const {stdout:revision} = await execute("git",["-C",checkout,"rev-parse","HEAD"],{timeout:10000});
const {stdout:status} = await execute("git",["-C",checkout,"status","--porcelain=v1","--untracked-files=all"],{timeout:10000});
if (status.trim()) { throw new Error("Maps compatibility requires a clean declared source checkout"); }
const maps: { validateMapsTilesetMetadata?: (value: unknown) => unknown } = await import(pathToFileURL(path.join(path.resolve(checkout),"src/entries/core.ts")).href);
if (typeof maps.validateMapsTilesetMetadata !== "function") { throw new Error("Maps source does not export validateMapsTilesetMetadata"); }
const manifest = validateMapsArchiveCandidate(JSON.parse(await readFile(candidate,"utf8")));
const { archiveRef: _archiveRef, ...metadata } = manifest;
const validated = maps.validateMapsTilesetMetadata(metadata);
console.log(JSON.stringify({status:"passed",mapsRevision:revision.trim(),candidateSha256:manifest.archiveRef.sha256,metadata:validated,
  limitation:"Common data metadata compatibility only. Archive transport activation belongs to Maps #269."},null,2));
