// #823: the heavy run's legs are authored by two recipes (gait_clips.py's Heavy_Run_Fwd_Loop and strike_clips.py's heavy
// running strikes and carry loops), which each must stay self-contained; the strikes start and end on the loop's
// stride only while both carry the same block.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const block = async (recipe: string) => {
  const source = await readFile(new URL(`../adapters/blender/${recipe}`, import.meta.url), "utf8");
  const start = source.indexOf("# --- The heavy stride (#823)");
  const end = source.indexOf("# --- end of the heavy stride");
  assert.ok(start >= 0 && end > start, recipe);
  return source.slice(start, end);
};

test("the gait and strike recipes carry the same heavy stride", async () => {
  assert.equal(await block("strike_clips.py"), await block("gait_clips.py"));
});
