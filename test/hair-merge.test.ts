// #336: a hairstyle and its crown cap merged into one static glTF with one buffer.
import {test} from "node:test";
import assert from "node:assert/strict";
import {mergeStaticGltfJson} from "../scripts/build-ranger-character.js";

const part=(name:string,bytes:number)=>({buffer:new Uint8Array(bytes).fill(bytes),json:{asset:{version:"2.0"},scene:0,scenes:[{nodes:[0]}],
 nodes:[{mesh:0,name}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],materials:[{name:`MI_${name}`,
 normalTexture:{index:0},pbrMetallicRoughness:{baseColorTexture:{index:1}}}],textures:[{sampler:0,source:0},{sampler:0,source:1}],
 images:[{uri:`${name}_N.png`},{uri:`${name}_C.png`}],samplers:[{}],accessors:[{bufferView:0},{bufferView:1}],
 bufferViews:[{buffer:0,byteOffset:0,byteLength:2},{buffer:0,byteOffset:2,byteLength:bytes-2}],buffers:[{uri:`${name}.bin`,byteLength:bytes}]}});

test("merged hair keeps every part's mesh, material and textures over one aligned buffer",()=>{
 const {json,buffer}=mergeStaticGltfJson([part("Long",6),part("Cap",8)],"Long_Cap.bin");
 assert.deepEqual(json.buffers,[{uri:"Long_Cap.bin",byteLength:16}]);
 assert.equal(buffer.byteLength,16);assert.equal(buffer[0],6);assert.equal(buffer[8],8);
 assert.deepEqual(json.bufferViews.map((v:any)=>[v.buffer,v.byteOffset]),[[0,0],[0,2],[0,8],[0,10]]);
 assert.deepEqual(json.accessors.map((a:any)=>a.bufferView),[0,1,2,3]);
 assert.deepEqual(json.meshes[1].primitives[0],{attributes:{POSITION:2},indices:3,material:1});
 assert.deepEqual(json.materials[1],{name:"MI_Cap",normalTexture:{index:2},pbrMetallicRoughness:{baseColorTexture:{index:3}}});
 assert.deepEqual(json.textures.map((t:any)=>[t.source,t.sampler]),[[0,0],[1,0],[2,1],[3,1]]);
 assert.deepEqual(json.scenes,[{nodes:[0,1]}]);assert.deepEqual(json.nodes.map((n:any)=>[n.name,n.mesh]),[["Long",0],["Cap",1]]);
 assert.throws(()=>mergeStaticGltfJson([part("Long",6),part("Long",6)],"x.bin"),/share the URI/);
});
