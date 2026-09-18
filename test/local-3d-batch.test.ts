import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseLocal3DQueue } from "../src/local-3d-batch.js";

test("weekend queue reads unchecked object prompts in file order", () => {
  const items = parseLocal3DQueue([
    "# Weekend batch",
    "",
    "- [ ] raid-defense.town-hall :: fortified medieval town hall",
    "- [x] raid-defense.old-tower :: intentionally disabled",
    "- [ ] raid-defense.arrow-tower :: narrow arrow tower",
  ].join("\n"));

  assert.deepEqual(items, [
    {
      id: "raid-defense.town-hall",
      prompt: "fortified medieval town hall",
      line: 3,
    },
    {
      id: "raid-defense.arrow-tower",
      prompt: "narrow arrow tower",
      line: 5,
    },
  ]);
});

test("weekend queue rejects malformed checkbox jobs instead of silently skipping them", () => {
  assert.throws(
    () => parseLocal3DQueue("- [ ] town hall without delimiter"),
    /must use '- \[ \] asset\.id :: prompt text'/,
  );
});

test("weekend queue rejects duplicate asset ids", () => {
  assert.throws(
    () =>
      parseLocal3DQueue([
        "- [ ] raid-defense.tower :: first",
        "- [ ] raid-defense.tower :: second",
      ].join("\n")),
    /duplicate asset id/,
  );
});

test("weekend queue requires at least one active item", () => {
  assert.throws(
    () => parseLocal3DQueue("- [x] raid-defense.done :: already generated"),
    /no unchecked jobs/,
  );
});

test("weekend batch source remains local and sequential by construction", async () => {
  const source = await readFile(
    new URL("../src/local-3d-batch.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /for \(let index = 0; index < selected\.length; index \+= 1\)/);
  assert.match(source, /await runOne\(/);
  assert.match(source, /executeStableDiffusionImageOperation/);
  assert.match(source, /executeStableFast3DMeshOperation/);
  assert.match(source, /model-lock\.json/);
  assert.match(source, /state\.json/);
  assert.doesNotMatch(source, /fetch\(/);
  assert.doesNotMatch(source, /https?:\/\//);
});
