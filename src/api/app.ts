import { maybeAlert } from "../alerts.js";
import type { ModelConfig, SiteConfig } from "../engine/types.js";
import { runChecks } from "../engine/run.js";
import { summarize } from "../engine/visibility.js";
import type { SiteInput, Store, StoredSite } from "../store/types.js";
import { auth, Ctx, HttpError, json, readJson, Router } from "./http.js";

const DEFAULT_MODELS: ModelConfig[] = [
  { id: "perplexity/sonar", label: "Perplexity Sonar", grounding: "native" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o mini", grounding: "online" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", grounding: "online" },
];

/** Load the site named by :id and confirm the authenticated user owns it. */
async function requireOwnedSite(c: Ctx): Promise<StoredSite> {
  const id = Number(c.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, "invalid site id");
  const site = await c.store.getSite(id);
  if (!site || site.userId !== c.user!.id) throw new HttpError(404, "site not found");
  return site;
}

/** Best-effort client IP, used as a rate-limit key. */
function clientIp(c: Ctx): string {
  return (
    c.req.headers.get("cf-connecting-ip") ||
    c.req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "local"
  );
}

/** Fixed-window rate limit; throws 429 when the bucket is over its limit. */
async function enforceLimit(
  c: Ctx,
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<void> {
  const r = await c.store.hitRateLimit(bucket, limit, windowSec);
  if (!r.ok) {
    const retry = Math.max(0, r.resetAt - Math.floor(Date.now() / 1000));
    throw new HttpError(429, `rate limit exceeded — retry in ${retry}s`);
  }
}

/**
 * Build the API as a single Fetch handler: (Request) => Response.
 * Runs behind the Node dev server now and inside a Cloudflare Worker later.
 */
export function createApp(store: Store): (req: Request) => Promise<Response> {
  const r = new Router();

  r.get("/", () => json({ name: "ai-visibility", version: "0.3.0", docs: "/v1" }));

  // --- Account & BYOK key ---

  r.post("/v1/users", async (c) => {
    await enforceLimit(c, "signup:" + clientIp(c), 5, 3600); // 5 new accounts / IP / hour
    const b = await readJson<{ email?: string }>(c);
    if (!b.email) throw new HttpError(400, "email required");
    try {
      const { id, apiKey } = await store.createUser(b.email);
      return json(
        { id, email: b.email, apiKey, note: "Save this API key — it is shown only once." },
        201,
      );
    } catch (err) {
      if (String(err).includes("UNIQUE")) throw new HttpError(409, "email already registered");
      throw err;
    }
  });

  r.get(
    "/v1/me",
    auth(async (c) => {
      const u = c.user!;
      return json({
        id: u.id,
        email: u.email,
        openrouterKeySet: u.openrouterKey !== null,
        alertWebhookSet: u.alertWebhook !== null,
      });
    }),
  );

  r.put(
    "/v1/me/openrouter-key",
    auth(async (c) => {
      const b = await readJson<{ key?: string | null }>(c);
      await store.setOpenrouterKey(c.user!.id, b.key ?? null);
      return json({ openrouterKeySet: !!b.key });
    }),
  );

  r.put(
    "/v1/me/alert-webhook",
    auth(async (c) => {
      const b = await readJson<{ url?: string | null }>(c);
      await store.setAlertWebhook(c.user!.id, b.url ?? null);
      return json({ alertWebhookSet: !!b.url });
    }),
  );

  // --- Sites ---

  r.post(
    "/v1/sites",
    auth(async (c) => {
      const b = await readJson<Partial<SiteInput>>(c);
      if (!b.brand || !b.domain) throw new HttpError(400, "brand and domain required");
      const site: SiteInput = {
        brand: b.brand,
        domain: b.domain,
        aliases: b.aliases ?? [],
        competitors: b.competitors ?? [],
        models: b.models?.length ? b.models : DEFAULT_MODELS,
      };
      const id = await store.upsertSite(c.user!.id, site);
      return json({ id, ...site }, 201);
    }),
  );

  r.get(
    "/v1/sites",
    auth(async (c) => json(await store.listSites(c.user!.id))),
  );

  r.get(
    "/v1/sites/:id",
    auth(async (c) => {
      const site = await requireOwnedSite(c);
      const questions = await store.getQuestions(site.id);
      return json({ ...site, questions });
    }),
  );

  // --- Questions ---

  r.post(
    "/v1/sites/:id/questions",
    auth(async (c) => {
      const site = await requireOwnedSite(c);
      const b = await readJson<{ questions?: unknown }>(c);
      if (!Array.isArray(b.questions)) throw new HttpError(400, "questions must be an array");
      const questions = b.questions.map(String).filter((q) => q.trim());
      await store.setQuestions(site.id, questions);
      return json({ count: questions.length });
    }),
  );

  // --- Run a check ---

  r.post(
    "/v1/sites/:id/run",
    auth(async (c) => {
      const site = await requireOwnedSite(c);
      await enforceLimit(c, "run:" + c.user!.id, 60, 3600); // 60 runs / user / hour

      // Body is optional; it may carry a one-off OpenRouter key.
      let b: { openrouterKey?: string } = {};
      try {
        b = await c.req.json();
      } catch {
        /* empty body is fine */
      }
      const key =
        b.openrouterKey ??
        c.user!.openrouterKey ??
        (process.env.MOCK === "1" ? "mock" : null);
      if (!key) {
        throw new HttpError(
          400,
          "no OpenRouter key: set one via PUT /v1/me/openrouter-key or pass openrouterKey in the body",
        );
      }

      const questions = await store.getQuestions(site.id);
      if (questions.length === 0) {
        throw new HttpError(400, "add questions first via POST /v1/sites/:id/questions");
      }

      const config: SiteConfig = {
        brand: site.brand,
        aliases: site.aliases,
        domain: site.domain,
        competitors: site.competitors,
        models: site.models,
      };
      const results = await runChecks(key, config, questions);
      const summary = summarize(results, config);
      const runId = await store.saveRun(site.id, summary, results);
      await maybeAlert(store, c.user!, site).catch(() => {});
      return json({ runId, summary });
    }),
  );

  // --- History & trends ---

  r.get(
    "/v1/sites/:id/runs",
    auth(async (c) => {
      const site = await requireOwnedSite(c);
      const limit = Number(c.url.searchParams.get("limit") ?? "50");
      return json(await store.listRuns(site.id, Number.isFinite(limit) ? limit : 50));
    }),
  );

  r.get(
    "/v1/sites/:id/visibility",
    auth(async (c) => {
      const site = await requireOwnedSite(c);
      const runs = await store.listRuns(site.id, 50);
      return json({ latest: runs[0] ?? null, trend: [...runs].reverse() });
    }),
  );

  return (req) => r.handle(req, store);
}
