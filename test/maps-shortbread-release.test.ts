import { describe, expect, test } from "bun:test";

import evidence from "../examples/maps-shortbread/evidence.json";
import {
  APPROVED_REGIONS,
  OSM_SOURCE,
  createMapsShortbreadReleaseIndex,
  publicationFilename,
} from "../scripts/build-maps-shortbread-release.ts";

function candidates() {
  return evidence.mapsMetadataCompatibility.map((result, index) => ({
    ...result.metadata,
    archiveRef: {
      format: "pmtiles" as const,
      version: 3 as const,
      path: `${APPROVED_REGIONS[index]!.name}.pmtiles`,
      sha256: result.candidateSha256,
      bytes: APPROVED_REGIONS[index]!.bytes,
      mvtExtent: 4096 as const,
    },
  }));
}

describe("Maps regional release promotion", () => {
  test("only the independently reviewed archive bytes can be promoted", () => {
    expect(APPROVED_REGIONS.map((region) => region.sha256)).toEqual(
      evidence.candidates.map((candidate) => candidate.content.archiveSha256),
    );
    const index = createMapsShortbreadReleaseIndex(candidates());
    expect(index.source).toEqual(OSM_SOURCE);
    expect(index.tilesets.map((tileset) => tileset.archiveRef.path)).toEqual(
      APPROVED_REGIONS.map(publicationFilename),
    );
    expect(index.tilesets.every((tileset) => tileset.license === "ODbL-1.0")).toBe(true);
    expect(index.tilesets.every((tileset) => !tileset.provenance.includes("Candidate only"))).toBe(
      true,
    );
    expect(
      index.tilesets.every(
        (tileset) => tileset.dataRevision === `sha256:${tileset.archiveRef.sha256}`,
      ),
    ).toBe(true);
  });

  test("metadata drift, license loss and unapproved revisions fail closed", () => {
    const wrongHash = candidates();
    wrongHash[0]!.archiveRef.sha256 = "0".repeat(64);
    expect(() => createMapsShortbreadReleaseIndex(wrongHash)).toThrow();
    const wrongLicense = candidates();
    wrongLicense[0]!.license = "CC0-1.0";
    expect(() => createMapsShortbreadReleaseIndex(wrongLicense)).toThrow(/reviewed source/);
    const wrongSnapshot = candidates();
    wrongSnapshot[0]!.observation.snapshot = "today";
    expect(() => createMapsShortbreadReleaseIndex(wrongSnapshot)).toThrow(/reviewed source/);
    expect(() => createMapsShortbreadReleaseIndex(candidates().slice(0, 1))).toThrow(
      /every approved/,
    );
  });
});
