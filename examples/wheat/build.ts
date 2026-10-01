import path from "node:path";
import {fileURLToPath} from "node:url";
import {createWheatAssetSpec,readWheatRecipeSource,WHEAT_PRESETS} from "asset-tooling/recipes/wheat";
import {buildCropAppearanceExample} from "../crop-appearance.js";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),source=await readWheatRecipeSource();
await buildCropAppearanceExample({root,directory:path.join(root,".artifacts/wheat"),crop:"wheat",
 stages:Object.entries(WHEAT_PRESETS).map(([id,parameters])=>({id,spec:createWheatAssetSpec({assetId:`wheat.${id}`,parameters,
  scriptSha256:source.sha256,blenderVersion:source.blenderVersion})})),
 files:[{path:"wheat.py",bytes:source.bytes}],sourceMetadata:{recipe:"wheat-v1",scriptSha256:source.sha256,},footprint:{width:.7,depth:.7},
});
