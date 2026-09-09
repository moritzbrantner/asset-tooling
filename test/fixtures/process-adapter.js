import { readFile, writeFile } from "node:fs/promises";

const [mode, requestPath, outputPath, observationsPath] = process.argv.slice(2);

if (mode === "probe") {
  process.stdout.write(`${JSON.stringify([
    {
      id: "fixture.runtime",
      version: "1",
      protocol: "asset-tooling-process-adapter-v1",
    },
  ])}\n`);
  process.exit(0);
}

if (mode !== "generate" || !requestPath || !outputPath || !observationsPath) {
  process.stderr.write("usage: process-adapter.js probe | generate REQUEST OUTPUT OBSERVATIONS\n");
  process.exit(2);
}

const request = JSON.parse(await readFile(requestPath, "utf8"));
if (typeof request.message !== "string") {
  throw new Error("fixture request.message must be a string");
}
await writeFile(outputPath, Buffer.from(`fixture:${request.message}\n`, "utf8"));
await writeFile(
  observationsPath,
  `${JSON.stringify({ protocol: "fixture-v1", messageLength: request.message.length })}\n`,
  "utf8",
);
