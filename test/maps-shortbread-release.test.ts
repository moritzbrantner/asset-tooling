import { describe, expect, test } from "bun:test";

import evidence from "../examples/maps-shortbread/evidence.json";
import {
  APPROVED_REGIONS,
  OSM_SOURCE,
  createMapsShortbreadReleaseIndex,
  publicationFilename,
} from "../scripts/build-maps-shortbread-release.ts";

function candidates() {
  return evidence.mapsMetadataCompatibility.map((result, index) => {
    const metadata = structuredClone(result.metadata);
    metadata.provenance = metadata.provenance.replace(
      "bd5cca3fdcb4e9900ad74b4c33e554750088705bd4b4deaa35c1517d7be2378b",
      OSM_SOURCE.sha256,
    );
    metadata.observation.snapshot = OSM_SOURCE.snapshot;
    return {
      ...metadata,
      archiveRef: {
        format: "pmtiles" as const,
        version: 3 as const,
        path: `${APPROVED_REGIONS[index]!.name}.pmtiles`,
        sha256: result.candidateSha256,
        bytes: [2_780_045, 1_366_814][index]!,
        mvtExtent: 4096 as const,
      },
    };
  });
}

describe("Maps regional release promotion", () => {
  test("pins reviewed source metadata and content-addresses the resulting archives", () => {
    expect(APPROVED_REGIONS.map((region) => region.name)).toEqual(
      evidence.candidates.map((candidate) => candidate.id),
    );
    const index = createMapsShortbreadReleaseIndex(candidates());
    expect(index.source).toEqual(OSM_SOURCE);
    expect(index.tilesets.map((tileset) => tileset.archiveRef.path)).toEqual(
      APPROVED_REGIONS.map((pin, i) => publicationFilename(pin, candidates()[i]!.archiveRef.sha256)),
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

  test("metadata drift and license loss fail closed; exact content revisions remain distinct", () => {
    const wrongHash = candidates();
    wrongHash[0]!.archiveRef.sha256 = "0".repeat(64);
    expect(() => createMapsShortbreadReleaseIndex(wrongHash)).toThrow();
    const wrongLicense = candidates();
    wrongLicense[0]!.license = "CC0-1.0";
    expect(() => createMapsShortbreadReleaseIndex(wrongLicense)).toThrow(/metadata contract/);
    const wrongSnapshot = candidates();
    wrongSnapshot[0]!.observation.snapshot = "today";
    expect(() => createMapsShortbreadReleaseIndex(wrongSnapshot)).toThrow(/maintained source pin/);
    const historicalSource = candidates();
    historicalSource[0]!.provenance = evidence.mapsMetadataCompatibility[0]!.metadata.provenance;
    expect(() => createMapsShortbreadReleaseIndex(historicalSource)).toThrow(/maintained source pin/);
    const regenerated = candidates();
    regenerated[0]!.archiveRef.sha256 = "a".repeat(64);
    regenerated[0]!.dataRevision = `sha256:${"a".repeat(64)}`;
    const newIndex = createMapsShortbreadReleaseIndex(regenerated);
    expect(newIndex.tilesets[0]!.archiveRef.path).toContain("a".repeat(64));
    expect(newIndex.tilesets[1]!.archiveRef.path).not.toContain("a".repeat(64));
    expect(() => createMapsShortbreadReleaseIndex(candidates().slice(0, 1))).toThrow(
      /every approved/,
    );
  });
});
