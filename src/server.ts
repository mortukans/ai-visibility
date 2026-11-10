import "./util/quiet.js";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { SqliteStore } from "./store/sqlite.js";
import { createApp } from "./api/app.js";
import { makeCipher } from "./util/crypto.js";

const PORT = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? "data/ai-visibility.db";

// Serve the dashboard (and any static file) from ./public; "/" → index.html.
const PUBLIC_DIR = resolve("public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
function servePublic(pathname: string): { body: Buffer; type: string } | null {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = resolve(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return { body: readFileSync(full), type: MIME[extname(full)] ?? "application/octet-stream" };
}

/** Convert a Node request into a Fetch Request so the Worker-style handler can use it. */
async function toRequest(nreq: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of nreq) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  const headers = new Headers();
  for (const [key, value] of Object.entries(nreq.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }

  const method = nreq.method ?? "GET";
  const url = `http://${nreq.headers.host ?? `localhost:${PORT}`}${nreq.url ?? "/"}`;
  const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
  return new Request(url, { method, headers, body: hasBody ? body : undefined });
}

async function main() {
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new SqliteStore(dbPath, makeCipher(process.env.KEY_SECRET));
  await store.init();
  const app = createApp(store);

  const server = createServer(async (nreq, nres) => {
    try {
      const method = nreq.method ?? "GET";
      const pathname = new URL(nreq.url ?? "/", "http://localhost").pathname;
      if (method === "GET" || method === "HEAD") {
        const file = servePublic(pathname);
        if (file) {
          nres.statusCode = 200;
          nres.setHeader("content-type", file.type);
          nres.end(method === "HEAD" ? undefined : file.body);
          return;
        }
      }

      const response = await app(await toRequest(nreq));
      nres.statusCode = response.status;
      response.headers.forEach((value, key) => nres.setHeader(key, value));
      nres.end(await response.text());
    } catch (err) {
      nres.statusCode = 500;
      nres.setHeader("content-type", "application/json");
      nres.end(JSON.stringify({ error: err instanceof Error ? err.message : "internal error" }));
    }
  });

  server.listen(PORT, () => {
    console.log(`ai-visibility → http://localhost:${PORT}`);
    console.log(`  dashboard  http://localhost:${PORT}/`);
    console.log(`  POST /v1/users                 create account + API key`);
    console.log(`  PUT  /v1/me/openrouter-key     store your OpenRouter key`);
    console.log(`  POST /v1/sites                 add a site`);
    console.log(`  POST /v1/sites/:id/questions   set questions`);
    console.log(`  POST /v1/sites/:id/run         run a check`);
    console.log(`  GET  /v1/sites/:id/visibility  latest + trend`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
