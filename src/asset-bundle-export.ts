/** Publish a prepared bundle into its output directory; the manifest write is the sole commit point of every profile. */
import path from "node:path";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { compareCodeUnitStrings } from "./canonical.js";
import { sha256Bytes } from "./hash.js";
import type { BundleExportOptions, Invocation } from "./asset-bundle-contract.js";
import { assertDirectory, assertExportBoundary, assertRegular, hasCode, readRegularNoFollow, writeAtomicIfChanged } from "./asset-bundle-files.js";
import { exportGltfResources, type PreparedGltfResources } from "./asset-bundle-gltf.js";
import { storeManifest } from "./asset-bundle-manifest.js";
import { prepare, type PreparedApproved } from "./asset-bundle-prepare.js";

export async function exportAssetBundle(root:string,directory:string,invocation:Invocation={},options:BundleExportOptions={}) {
  options.signal?.throwIfAborted();await assertExportBoundary(root,directory);
  if(options.onArtifact!==undefined && typeof options.onArtifact!=="function") throw new Error("bundle onArtifact must be a function");
  const prepared=await prepare(root,invocation,options.signal);options.signal?.throwIfAborted();
  if(prepared.manifest.schemaVersion===3) return exportApproved(root,directory,prepared as PreparedApproved,options);
  if(prepared.manifest.schemaVersion===4) return exportGltfResources(root,directory,prepared as PreparedGltfResources,options);
  await assertDirectory(directory,true);await mkdir(directory,{recursive:true});await assertDirectory(path.join(directory,"assets"),true);await mkdir(path.join(directory,"assets"),{recursive:true});
  await assertRegular(path.join(directory,"manifest.json"),true);
  let blobsWritten=0,blobsReused=0,bytesWritten=0;
  for(const [portablePath,{bytes}] of prepared.blobs) {
    options.signal?.throwIfAborted();const status=await writeAtomicIfChanged(directory,portablePath,bytes,options.signal);
    if(status==="changed") {blobsWritten++;bytesWritten+=bytes.byteLength;} else blobsReused++;
    await options.onArtifact?.({path:portablePath,status,byteLength:bytes.byteLength});
  }
  const manifest=await storeManifest(root,prepared);options.signal?.throwIfAborted();
  // Sole commit point. Prior payloads remain available to readers holding the old manifest.
  const manifestStatus=await writeAtomicIfChanged(directory,"manifest.json",prepared.bytes,options.signal);
  if(manifestStatus==="changed") bytesWritten+=prepared.bytes.byteLength;
  return {manifest,manifestStatus,files:["manifest.json",...prepared.blobs.keys()].sort(compareCodeUnitStrings),assetsVerified:prepared.manifest.assets.length,blobsWritten,blobsReused,bytesWritten};
}
/**
 * approved-png-v1 export. Same publication rules as @1/@2, plus: every payload is re-read without following symlinks and
 * re-hashed against its approval immediately before the manifest commit, and a failure before that commit rolls back
 * the payloads and directories this call added or changed, so a rejected approved export leaves the directory as it was.
 */
async function exportApproved(root:string,directory:string,prepared:PreparedApproved,options:BundleExportOptions) {
  await assertDirectory(directory,true);const assetsDirectory=path.join(directory,"assets");
  const createdTop=await mkdir(directory,{recursive:true});await assertDirectory(assetsDirectory,true);
  const assetsCreated=await mkdir(assetsDirectory,{recursive:true});
  await assertRegular(path.join(directory,"manifest.json"),true);
  const written=new Map<string,Buffer|undefined>();
  let blobsWritten=0,blobsReused=0,bytesWritten=0,manifestStatus:"changed"|"unchanged";
  try {
    for(const [portablePath,{bytes}] of prepared.blobs) {
      options.signal?.throwIfAborted();const target=path.join(directory,...portablePath.split("/"));await assertRegular(target,true);
      let previous:Buffer|undefined;
      try { previous=await readFile(target); } catch(error:unknown) { if(!hasCode(error,"ENOENT")) throw error; }
      if(!previous?.equals(bytes)) written.set(portablePath,previous);
      const status=await writeAtomicIfChanged(directory,portablePath,bytes,options.signal);
      if(status==="changed") {blobsWritten++;bytesWritten+=bytes.byteLength;} else {blobsReused++;written.delete(portablePath);}
      await options.onArtifact?.({path:portablePath,status,byteLength:bytes.byteLength});
    }
    const manifest=await storeManifest(root,prepared);options.signal?.throwIfAborted();
    await assertDirectory(directory);await assertDirectory(assetsDirectory);
    for(const entry of prepared.manifest.assets) {
      const bytes=await readRegularNoFollow(path.join(directory,...entry.path.split("/")));
      if(bytes.byteLength!==entry.source.byteLength || sha256Bytes(bytes)!==entry.approved.sha256) throw new Error(`exported payload for '${entry.key}/${entry.variant}' no longer matches its approved sha256; the manifest was not committed`);
    }
    // Sole commit point. Prior payloads remain available to readers holding the old manifest.
    manifestStatus=await writeAtomicIfChanged(directory,"manifest.json",prepared.bytes,options.signal);
    if(manifestStatus==="changed") bytesWritten+=prepared.bytes.byteLength;
    return {manifest,manifestStatus,files:["manifest.json",...prepared.blobs.keys()].sort(compareCodeUnitStrings),assetsVerified:prepared.manifest.assets.length,blobsWritten,blobsReused,bytesWritten};
  } catch(error:unknown) {
    await rollbackApproved(directory,written,createdTop,assetsCreated);throw error;
  }
}
async function rollbackApproved(directory:string,written:Map<string,Buffer|undefined>,createdTop:string|undefined,assetsCreated:string|undefined):Promise<void> {
  for(const [portablePath,previous] of written) {
    const target=path.join(directory,...portablePath.split("/"));
    try { await rm(target,{force:true});if(previous) await writeFile(target,previous,{flag:"wx"}); } catch { /* best effort; the original error is reported */ }
  }
  const created=[...(assetsCreated?[path.join(directory,"assets")]:[])];
  if(createdTop) for(let current=directory;;current=path.dirname(current)) {created.push(current);if(current===createdTop || path.dirname(current)===current) break;}
  for(const created_ of created) { try { await rmdir(created_); } catch { /* not empty or already gone */ } }
}
