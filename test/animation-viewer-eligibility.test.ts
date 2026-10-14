import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  animationViewerHrefFromAssetPage,
  animationViewerIneligibility,
  isAnimationViewerEligible,
} from "../src/animation-viewer-eligibility.ts";
import { createCatalogPagesModel, renderCatalogAssetHtml } from "../src/catalog-pages-site.ts";

const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

describe("animation viewer eligibility (#111)", () => {
  const model = createCatalogPagesModel({
    providers: readJson("catalog/providers.json"),
    sources: readJson("catalog/sources.json"),
    storage: readJson("catalog/storage.json"),
  }) as { assets: { id: string }[] };

  test("exactly the pinned rigged and animated glTF sources are eligible today", () => {
    const eligible = model.assets.filter(isAnimationViewerEligible).map((asset) => asset.id).sort();
    expect(eligible).toEqual(["khronos.riggedfigure-glb", "khronos.simpleskin-embedded-gltf"]);
  });

  test("each requirement is enforced", () => {
    const base = {
      kind: "mesh",
      mediaType: "model/gltf-binary",
      tags: ["animation", "skinning"],
      source: { url: "https://example.test/a.glb", sha256: "a".repeat(64), byteLength: 12 },
    };
    expect(animationViewerIneligibility(base)).toBeNull();
    expect(animationViewerIneligibility({ ...base, kind: "animation" })).toMatch(/mesh/);
    expect(animationViewerIneligibility({ ...base, mediaType: "model/obj" })).toMatch(/glTF/);
    expect(animationViewerIneligibility({ ...base, tags: ["skinning"] })).toMatch(/animation/);
    expect(animationViewerIneligibility({ ...base, tags: ["animation"] })).toMatch(/skinning/);
    expect(animationViewerIneligibility({ ...base, source: { ...base.source, sha256: null } })).toMatch(/SHA-256/);
    expect(animationViewerIneligibility({ ...base, source: { ...base.source, byteLength: null } })).toMatch(/byte-length/);
    expect(animationViewerIneligibility(null)).not.toBeNull();
  });

  test("only eligible asset pages link to the viewer, relatively", () => {
    for (const asset of model.assets) {
      const html = renderCatalogAssetHtml(asset) as string;
      const links = html.match(/>Inspect animation</g) ?? [];
      expect(links.length).toBe(isAnimationViewerEligible(asset) ? 1 : 0);
      if (links.length) expect(html).toContain(`href="${animationViewerHrefFromAssetPage(asset.id)}"`);
    }
  });
});
