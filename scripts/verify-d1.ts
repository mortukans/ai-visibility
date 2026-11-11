// Dev-only check: run the real D1Store against a fake D1 backed by in-memory
// SQLite, so the D1 driver calls (bind/run/all/first/batch, meta.last_row_id) and
// the key-encryption path are exercised without a Cloudflare account.
//   npx tsx scripts/verify-d1.ts
import "../src/util/quiet.js";
import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Store } from "../src/store/d1.js";
import { makeCipher } from "../src/util/crypto.js";
import { runChecks } from "../src/engine/run.js";
import { summarize } from "../src/engine/visibility.js";
import type { SiteConfig } from "../src/engine/types.js";

process.env.MOCK = "1"; // use canned answers

function coerce(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

/** Minimal D1 API over node:sqlite — just the surface D1Store uses. */
class FakeStmt {
  constructor(
    private sdb: DatabaseSync,
    private sql: string,
    private vals: unknown[] = [],
  ) {}
  bind(...vals: unknown[]): FakeStmt {
    return new FakeStmt(this.sdb, this.sql, vals);
  }
  async run() {
    const info = this.sdb.prepare(this.sql).run(...(this.vals.map(coerce) as never[]));
    return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } };
  }
  async all() {
    return { results: this.sdb.prepare(this.sql).all(...(this.vals.map(coerce) as never[])) };
  }
  async first() {
    return this.sdb.prepare(this.sql).get(...(this.vals.map(coerce) as never[])) ?? null;
  }
}
class FakeD1 {
  constructor(private sdb: DatabaseSync) {}
  prepare(sql: string): FakeStmt {
    return new FakeStmt(this.sdb, sql);
  }
  async batch(stmts: FakeStmt[]) {
    this.sdb.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.sdb.exec("COMMIT");
      return out;
    } catch (e) {
      this.sdb.exec("ROLLBACK");
      throw e;
    }
  }
}

let failures = 0;
function assert(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

async function main() {
  const sdb = new DatabaseSync(":memory:");
  const store = new D1Store(new FakeD1(sdb) as unknown as D1Database, makeCipher("test-secret"));
  await store.init();

  const { id, apiKey } = await store.createUser("demo@example.com");
  assert("createUser returns id + apiKey", id > 0 && apiKey.startsWith("av_"));

  const byKey = await store.getUserByApiKey(apiKey);
  assert("getUserByApiKey finds the user", byKey?.id === id);
  assert("bad api key → null", (await store.getUserByApiKey("av_wrong")) === null);

  const secret = "sk-or-REALKEY123";
  await store.setOpenrouterKey(id, secret);
  const user = await store.getUser(id);
  assert("stored OpenRouter key decrypts back", user?.openrouterKey === secret);

  const rawRow = sdb.prepare("SELECT openrouter_key FROM users WHERE id = ?").get(id) as {
    openrouter_key: string;
  };
  assert("key is encrypted at rest (ciphertext != plaintext)", rawRow.openrouter_key !== secret);

  const siteId = await store.upsertSite(id, {
    brand: "Acme Analytics",
    domain: "acme-analytics.com",
    aliases: ["Acme"],
    competitors: ["Mixpanel", "Amplitude"],
    models: [{ id: "openai/gpt-4o-mini", label: "GPT-4o mini", grounding: "online" }],
  });
  assert("upsertSite returns id", siteId > 0);
  assert("upsertSite is idempotent", (await store.upsertSite(id, {
    brand: "Acme Analytics",
    domain: "acme-analytics.com",
    aliases: ["Acme"],
    competitors: ["Mixpanel", "Amplitude"],
    models: [{ id: "openai/gpt-4o-mini", label: "GPT-4o mini", grounding: "online" }],
  })) === siteId);

  await store.setQuestions(siteId, ["best product analytics tools", "alternatives to GA"]);
  assert("getQuestions round-trips", (await store.getQuestions(siteId)).length === 2);

  const config: SiteConfig = {
    brand: "Acme Analytics",
    aliases: ["Acme"],
    domain: "acme-analytics.com",
    competitors: ["Mixpanel", "Amplitude"],
    models: [{ id: "openai/gpt-4o-mini", label: "GPT-4o mini", grounding: "online" }],
  };
  const questions = await store.getQuestions(siteId);
  for (let i = 0; i < 2; i++) {
    const results = await runChecks("mock", config, questions);
    await store.saveRun(siteId, summarize(results, config), results);
  }
  const runs = await store.listRuns(siteId);
  assert("two runs saved + listed", runs.length === 2);
  assert("run summary has share of voice", typeof runs[0].shareOfVoice === "number");

  assert("listAllSites sees the site", (await store.listAllSites()).some((s) => s.id === siteId));

  // alert webhook round-trips and is encrypted at rest
  const hook = "https://hooks.slack.com/services/XXX/YYY/ZZZ";
  await store.setAlertWebhook(id, hook);
  assert("alert webhook decrypts back", (await store.getUser(id))?.alertWebhook === hook);
  const rawHook = sdb.prepare("SELECT alert_webhook FROM users WHERE id = ?").get(id) as {
    alert_webhook: string;
  };
  assert("webhook encrypted at rest", rawHook.alert_webhook !== hook);

  // rate limiting: a 3rd hit against a limit of 2 is blocked
  const rl1 = await store.hitRateLimit("test:bucket", 2, 60);
  const rl2 = await store.hitRateLimit("test:bucket", 2, 60);
  const rl3 = await store.hitRateLimit("test:bucket", 2, 60);
  assert("rate limit allows up to the limit", rl1.ok && rl2.ok);
  assert("rate limit blocks over the limit", !rl3.ok);

  console.log(failures === 0 ? "\nD1 store: all checks passed\n" : `\n${failures} check(s) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
