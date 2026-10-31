/** Filesystem boundary of bundle export and reading: link and containment checks, atomic writes and pinned reads. */
import path from "node:path";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { sha256Bytes } from "./hash.js";
import type { AssetRef } from "./operations.js";

export function assertAbsolute(root:string):void { if(typeof root!=="string" || !path.isAbsolute(root)) throw new Error("bundle directory/root must be an absolute path"); }
export function hasCode(error:unknown,code:string):boolean { return error instanceof Error && "code" in error && error.code===code; }
export async function assertRegular(file:string,allowMissing=false):Promise<void> {
  try { const info=await lstat(file);if(info.isSymbolicLink() || !info.isFile()) throw new Error(`bundle file '${path.basename(file)}' must be a regular file`); }
  catch(error:unknown) { if(allowMissing && hasCode(error,"ENOENT")) return;throw error; }
}
export async function assertDirectory(directory:string,allowMissing=false):Promise<void> {
  try { const info=await lstat(directory);if(info.isSymbolicLink() || !info.isDirectory()) throw new Error("bundle output directory must not be a symbolic link or file"); }
  catch(error:unknown) { if(allowMissing && hasCode(error,"ENOENT")) return;throw error; }
}
export async function assertExportBoundary(root:string,directory:string):Promise<void> {
  assertAbsolute(root);assertAbsolute(directory);
  const relative=path.relative(root,directory),segments=relative.split(path.sep).map(segment=>segment.toLowerCase());
  if(segments.some(segment=>/[. ]$/.test(segment) || segment.includes(":")) || !relative || path.isAbsolute(relative) || segments[0]===".." || segments[0]===".git" || segments[0]===".asset-tooling" ||
     (segments[0]==="assets" && segments[1]==="canonical")) throw new Error("bundle export must be inside a separate declared output directory below its asset root");
  await assertDirectory(root);let prefix=root;
  for(const segment of relative.split(path.sep)) {prefix=path.join(prefix,segment);await assertDirectory(prefix,true);}
}
export async function writeAtomicIfChanged(directory:string,relative:string,bytes:Buffer,signal?:AbortSignal):Promise<"changed"|"unchanged"> {
  signal?.throwIfAborted();const target=path.join(directory,...relative.split("/"));await assertRegular(target,true);
  try { if((await lstat(target)).size===bytes.byteLength && (await readFile(target)).equals(bytes)) {signal?.throwIfAborted();return "unchanged";} }
  catch(error:unknown) { if(!hasCode(error,"ENOENT")) throw error; }
  const temporary=await mkdtemp(path.join(directory,".bundle-export-"));
  try { const staged=path.join(temporary,"payload");await writeFile(staged,bytes,{flag:"wx"});signal?.throwIfAborted();await rename(staged,target); }
  finally { await rm(temporary,{recursive:true,force:true}); }
  return "changed";
}
/** Read a regular file without following a final symbolic link, so a swapped-in link cannot satisfy a pin check. */
export async function readRegularNoFollow(file:string):Promise<Buffer> {
  await assertRegular(file);
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW ?? 0));
  try { if(!(await handle.stat()).isFile()) throw new Error(`bundle file '${path.basename(file)}' must be a regular file`);return await handle.readFile(); }
  finally { await handle.close(); }
}
export async function readPinned(directory:string,relative:string,source:AssetRef):Promise<Buffer> {
  await assertDirectory(directory);if(relative.startsWith("assets/")) await assertDirectory(path.join(directory,"assets"));
  const file=path.join(directory,...relative.split("/"));await assertRegular(file);
  if((await lstat(file)).size!==source.byteLength) throw new Error("packaged asset byte length does not match content pin");
  const bytes=await readFile(file);if(sha256Bytes(bytes)!==source.sha256) throw new Error("packaged asset hash does not match content pin");return bytes;
}
/** Read a packaged file below directory, rejecting links in any segment, and check its length/sha256. */
export async function readHashed(directory:string,relative:string,sha256:string,byteLength:number|undefined,maxBytes:number):Promise<Buffer> {
  await assertDirectory(directory);let current=directory;const segments=relative.split("/");
  for(const segment of segments.slice(0,-1)) {current=path.join(current,segment);await assertDirectory(current);}
  const file=path.join(current,segments.at(-1)!);await assertRegular(file);
  const size=(await lstat(file)).size;
  if((byteLength!==undefined && size!==byteLength) || size>maxBytes) throw new Error(`packaged file '${relative}' byte length does not match its content pin`);
  const bytes=await readRegularNoFollow(file);
  if(sha256Bytes(bytes)!==sha256) throw new Error(`packaged file '${relative}' hash does not match its content pin`);
  return bytes;
}
