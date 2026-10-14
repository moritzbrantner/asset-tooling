import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

// Real-Chromium acceptance tests against the built Pages site (dist/pages).
// The Pages site is rebuilt and served on a free loopback port for every run.
// Workers inherit the chosen port through the environment so that every
// process agrees on the same baseURL.
const PORT_ENV = "ASSET_TOOLING_BROWSER_PORT";

function freeLoopbackPort(): string {
  const probe =
    "const s=require('node:net').createServer();" +
    "s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});";
  return execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" }).trim();
}

const configuredPort = process.env[PORT_ENV];
const port = configuredPort !== undefined && /^[0-9]+$/.test(configuredPort) ? configuredPort : freeLoopbackPort();
process.env[PORT_ENV] = port;
const baseURL = `http://127.0.0.1:${port}/`;

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.ts",
  outputDir: "./test-results/playwright",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: "bun scripts/build-catalog-pages.ts && bun scripts/serve-pages.ts",
    env: { PORT: port },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
