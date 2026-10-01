import path from "node:path";
import {fileURLToPath} from "node:url";
import {createCornAssetSpec,readCornRecipeSource,CORN_PRESETS} from "asset-tooling/recipes/corn";
import {buildCropAppearanceExample} from "../crop-appearance.js";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),source=await readCornRecipeSource();
await buildCropAppearanceExample({root,directory:path.join(root,".artifacts/corn"),crop:"corn",
 stages:Object.entries(CORN_PRESETS).map(([id,parameters])=>({id,spec:createCornAssetSpec({assetId:`corn.${id}`,parameters,
  scriptSha256:source.sha256,authoringSha256:source.authoring.sha256,blenderVersion:source.blenderVersion})})),
 files:[{path:"corn.py",bytes:source.bytes},{path:"wheat.py",bytes:source.authoring.bytes}],sourceMetadata:{recipe:"corn-v1",scriptSha256:source.sha256,authoringSha256:source.authoring.sha256,},footprint:{width:1.1,depth:1.1},
});
