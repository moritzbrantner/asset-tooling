import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = path.join(root, "dist", "pages");
const port = Number(process.env.PORT ?? "4173");

const mediaTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".glb", "model/gltf-binary"],
]);

function safeFilePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(outputRoot, relative || "index.html");
  const boundary = outputRoot + path.sep;
  if (candidate !== outputRoot && !candidate.startsWith(boundary)) return null;
  return candidate;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/") && path.extname(url.pathname) === "") {
      return Response.redirect(new URL(url.pathname + "/" + url.search, url), 308);
    }
    const pathname = url.pathname.endsWith("/")
      ? url.pathname + "index.html"
      : url.pathname;
    const candidate = safeFilePath(pathname);
    if (!candidate) return new Response("Not found", { status: 404 });
    const file = Bun.file(candidate);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    const type = mediaTypes.get(path.extname(candidate).toLowerCase());
    return new Response(file, {
      headers: type ? { "Content-Type": type, "Cache-Control": "no-store" } : { "Cache-Control": "no-store" },
    });
  },
});

console.log("asset-tooling studio: http://" + server.hostname + ":" + server.port + "/generate/");
