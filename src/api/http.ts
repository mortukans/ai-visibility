import type { Store, User } from "../store/types.js";

/** Thrown by handlers to return a specific status; the router turns it into JSON. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  store: Store;
  user?: User;
}

export type Handler = (c: Ctx) => Promise<Response> | Response;

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

/** Parse a JSON request body, or throw a 400. */
export async function readJson<T>(c: Ctx): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** Wrap a handler so it only runs for a valid API key, with c.user populated. */
export function auth(handler: Handler): Handler {
  return async (c) => {
    const header = c.req.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new HttpError(401, "missing bearer token");
    const user = await c.store.getUserByApiKey(match[1].trim());
    if (!user) throw new HttpError(401, "invalid api key");
    c.user = user;
    return handler(c);
  };
}

/** Minimal path router over the Fetch API — the same handler runs on Workers. */
export class Router {
  private routes: { method: string; parts: string[]; handler: Handler }[] = [];

  private add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
  }
  get(path: string, handler: Handler): void {
    this.add("GET", path, handler);
  }
  post(path: string, handler: Handler): void {
    this.add("POST", path, handler);
  }
  put(path: string, handler: Handler): void {
    this.add("PUT", path, handler);
  }

  async handle(req: Request, store: Store): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);
    const segs = url.pathname.split("/").filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      if (route.parts.length !== segs.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.parts.length; i++) {
        const part = route.parts[i];
        if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(segs[i]);
        else if (part !== segs[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      try {
        return await route.handler({ req, url, params, store });
      } catch (err) {
        if (err instanceof HttpError) return error(err.status, err.message);
        return error(500, err instanceof Error ? err.message : "internal error");
      }
    }
    return error(404, "not found");
  }
}
