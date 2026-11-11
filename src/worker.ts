import type { D1Database } from "@cloudflare/workers-types";
import { maybeAlert } from "./alerts.js";
import { createApp } from "./api/app.js";
import type { SiteConfig } from "./engine/types.js";
import { runChecks } from "./engine/run.js";
import { summarize } from "./engine/visibility.js";
import { D1Store } from "./store/d1.js";
import { makeCipher } from "./util/crypto.js";

interface Env {
  /** D1 binding (see wrangler.toml). */
  DB: D1Database;
  /** Secret used to encrypt stored OpenRouter keys: `wrangler secret put KEY_SECRET`. */
  KEY_SECRET?: string;
}

/**
 * Cloudflare Worker entry point. `fetch` serves the same API as the Node dev
 * server (the handler is identical); `scheduled` is the cron job that re-runs
 * every site's checks on a timer.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const store = new D1Store(env.DB, makeCipher(env.KEY_SECRET));
    await store.init();
    return createApp(store)(request);
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    const store = new D1Store(env.DB, makeCipher(env.KEY_SECRET));
    await store.init();

    for (const site of await store.listAllSites()) {
      const user = await store.getUser(site.userId);
      const key = user?.openrouterKey;
      const questions = await store.getQuestions(site.id);
      if (!key || questions.length === 0) continue; // nothing to run yet

      const config: SiteConfig = {
        brand: site.brand,
        aliases: site.aliases,
        domain: site.domain,
        competitors: site.competitors,
        models: site.models,
      };
      const results = await runChecks(key, config, questions);
      const summary = summarize(results, config);
      await store.saveRun(site.id, summary, results);
      await maybeAlert(store, user!, site).catch(() => {});
    }
  },
};
