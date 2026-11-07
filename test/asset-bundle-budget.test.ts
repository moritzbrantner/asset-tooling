import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssetRef } from "../src/operations.js";
import { MAX_BUNDLE_BYTES, type BundleResource } from "../src/asset-bundle-contract.js";
import { BundleBudget, checkBudget } from "../src/asset-bundle-manifest.js";

const mib=1024*1024;
function entry(id:number,byteLength:number):BundleResource {
  const sha256=id.toString(16).padStart(64,"0");
  return {path:`assets/${sha256}.png`,source:createAssetRef({kind:"image",mediaType:"image/png",sha256,byteLength})};
}
function failure(run:()=>void):string|undefined {
  try {run();return undefined;} catch(error:unknown) {return error instanceof Error?error.message:String(error);}
}

test("incremental budget accounts for unique paths and accepts exactly 256 MiB",()=>{
  const entries=[1,2,3,4].map(id=>entry(id,64*mib));
  assert.equal(entries.reduce((n,item)=>n+item.source.byteLength,0),MAX_BUNDLE_BYTES);
  const incremental=new BundleBudget(entries);
  checkBudget(entries);
  incremental.add(entries[0]!);incremental.check(); // Duplicate source remains free.
  checkBudget([...entries,entries[0]!]);
  const overflow=entry(5,1);
  assert.equal(failure(()=>checkBudget([...entries,overflow])),"bundle exceeds the 256 MiB unique payload budget");
  incremental.add(overflow);
  assert.equal(failure(()=>incremental.check()),"bundle exceeds the 256 MiB unique payload budget");
});

test("conflicting lengths retain the original error precedence even after a nominal overflow",()=>{
  const initial=[entry(1,64*mib),entry(2,64*mib),entry(3,64*mib),entry(4,64*mib)];
  const overflow=entry(5,1),conflict=entry(1,64*mib-1);
  assert.equal(failure(()=>checkBudget([...initial,overflow,conflict])),"conflicting byte lengths for identical bundle content");
  assert.equal(failure(()=>new BundleBudget([...initial,overflow,conflict])),"conflicting byte lengths for identical bundle content");
  const incremental=new BundleBudget(initial);
  assert.equal(failure(()=>incremental.add(conflict)),"conflicting byte lengths for identical bundle content");
  incremental.check(); // A rejected conflicting addition must not corrupt the accumulated state.
});

test("incremental admission matches independent full-recheck semantics across deterministic duplicate sequences",()=>{
  for(const seed of [7,31,101]) {
    let state=seed;const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
    const entries:BundleResource[]=[],budget=new BundleBudget();
    for(let index=0;index<240;index++) {
      const id=next()%85,bytes=(next()%4000)+1;
      // Most duplicates reuse their original length; every 17th repeated path introduces a conflict.
      const previous=entries.find(e=>e.path===entry(id,bytes).path);
      const item=entry(id,previous && index%17!==0?previous.source.byteLength:bytes);
      const expected=failure(()=>checkBudget([...entries,item]));
      const actual=failure(()=>{budget.add(item);budget.check();});
      assert.equal(actual,expected,`seed ${seed}, step ${index}`);
      if(actual) break;
      entries.push(item);
    }
  }
});
