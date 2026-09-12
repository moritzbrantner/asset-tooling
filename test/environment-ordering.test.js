import test from "node:test";
import assert from "node:assert/strict";

import { captureEnvironment } from "../src/environment.js";

test("environment fingerprint orders components independently of input order and locale", async () => {
  const components = [{ name: "ä" }, { name: "z" }, { name: "a" }];
  const forward = await captureEnvironment(components);
  const reverse = await captureEnvironment([...components].reverse());

  assert.deepEqual(forward.components, [{ name: "a" }, { name: "z" }, { name: "ä" }]);
  assert.deepEqual(reverse.components, forward.components);
  assert.equal(reverse.sha256, forward.sha256);
});
