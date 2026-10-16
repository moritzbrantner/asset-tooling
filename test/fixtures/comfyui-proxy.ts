/**
 * Test helpers around the #212 ComfyUI fake (test/fixtures/comfyui-fake-server.ts), without
 * changing it: a loopback proxy that forwards every request to the fake unless `intercept`
 * answers it, and a "trap" server that only records requests that reach it.
 */
export interface ComfyUiProxy {
  readonly endpoint: string;
  intercept?: (request: Request, url: URL, forward: () => Promise<Response>) => Promise<Response | undefined> | Response | undefined;
  stop(): Promise<void>;
}

export async function startComfyUiProxy(upstream: string): Promise<ComfyUiProxy> {
  const proxy: { intercept?: ComfyUiProxy["intercept"] } = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      const forward = () =>
        fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body,
          redirect: "manual",
        });
      const intercepted = await proxy.intercept?.(request, url, forward);
      return intercepted ?? (await forward());
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    get intercept() {
      return proxy.intercept;
    },
    set intercept(value) {
      proxy.intercept = value;
    },
    async stop() {
      await server.stop(true);
    },
  };
}

export interface TrapServer {
  readonly origin: string;
  readonly hits: string[];
  stop(): Promise<void>;
}

/** Answers like a plausible ComfyUI so a client that follows a redirect would get far. */
export async function startTrapServer(): Promise<TrapServer> {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      hits.push(`${request.method} ${url.pathname}`);
      return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    hits,
    async stop() {
      await server.stop(true);
    },
  };
}
