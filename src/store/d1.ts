import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { MentionResult, VisibilitySummary } from "../engine/types.js";
import type { Cipher } from "../util/crypto.js";
import { generateApiKey, hashKey } from "../util/keys.js";
import { reveal, type Row, toRunSummary, toSite } from "./mappers.js";
import { SCHEMA } from "./schema.js";
import type { RunSummaryRow, SiteInput, Store, StoredSite, User } from "./types.js";

const LOCAL_EMAIL = "local@localhost";

/**
 * Cloudflare D1 implementation of the same Store interface as SqliteStore.
 * D1 is SQLite, so every query matches; only the driver calls (bind/run/all/first/
 * batch, async) differ. The Worker uses this; nothing here touches node:* modules.
 */
export class D1Store implements Store {
  private initialized = false;

  constructor(
    private db: D1Database,
    private cipher: Cipher | null = null,
  ) {}

  async init(): Promise<void> {
    // Schema is normally applied via `wrangler d1 migrations apply`; this makes a
    // fresh local D1 (wrangler dev) just work. Runs once per isolate.
    if (this.initialized) return;
    await this.db.batch(SCHEMA.map((s) => this.db.prepare(s)));
    this.initialized = true;
  }

  // --- Users & auth ---

  async createUser(email: string): Promise<{ id: number; apiKey: string }> {
    const now = new Date().toISOString();
    const info = await this.db
      .prepare("INSERT INTO users (email, created_at) VALUES (?, ?)")
      .bind(email, now)
      .run();
    const id = Number(info.meta.last_row_id);
    const apiKey = generateApiKey();
    await this.db
      .prepare("INSERT INTO api_keys (user_id, key_hash, label, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, await hashKey(apiKey), "default", now)
      .run();
    return { id, apiKey };
  }

  async getUserByApiKey(apiKey: string): Promise<User | null> {
    const row = (await this.db
      .prepare(
        `SELECT u.id, u.email, u.openrouter_key
           FROM api_keys k JOIN users u ON u.id = k.user_id
          WHERE k.key_hash = ?`,
      )
      .bind(await hashKey(apiKey))
      .first()) as Row | null;
    return row ? this.toUser(row) : null;
  }

  async getUser(id: number): Promise<User | null> {
    const row = (await this.db
      .prepare("SELECT id, email, openrouter_key FROM users WHERE id = ?")
      .bind(id)
      .first()) as Row | null;
    return row ? this.toUser(row) : null;
  }

  async setOpenrouterKey(userId: number, key: string | null): Promise<void> {
    const stored = key && this.cipher ? await this.cipher.encrypt(key) : key;
    await this.db.prepare("UPDATE users SET openrouter_key = ? WHERE id = ?").bind(stored, userId).run();
  }

  async ensureLocalUser(): Promise<number> {
    await this.db
      .prepare("INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)")
      .bind(LOCAL_EMAIL, new Date().toISOString())
      .run();
    const row = (await this.db
      .prepare("SELECT id FROM users WHERE email = ?")
      .bind(LOCAL_EMAIL)
      .first()) as Row;
    return Number(row.id);
  }

  private async toUser(row: Row): Promise<User> {
    return {
      id: Number(row.id),
      email: String(row.email),
      openrouterKey: await reveal(this.cipher, row.openrouter_key),
    };
  }

  // --- Sites ---

  async upsertSite(userId: number, site: SiteInput): Promise<number> {
    await this.db
      .prepare(
        `INSERT INTO sites (user_id, brand, domain, aliases, competitors, models, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, brand, domain) DO UPDATE SET
           aliases = excluded.aliases,
           competitors = excluded.competitors,
           models = excluded.models`,
      )
      .bind(
        userId,
        site.brand,
        site.domain,
        JSON.stringify(site.aliases),
        JSON.stringify(site.competitors),
        JSON.stringify(site.models),
        new Date().toISOString(),
      )
      .run();
    const id = await this.findSite(userId, site.brand, site.domain);
    if (id === null) throw new Error("failed to upsert site");
    return id;
  }

  async findSite(userId: number, brand: string, domain: string): Promise<number | null> {
    const row = (await this.db
      .prepare("SELECT id FROM sites WHERE user_id = ? AND brand = ? AND domain = ?")
      .bind(userId, brand, domain)
      .first()) as Row | null;
    return row ? Number(row.id) : null;
  }

  async getSite(siteId: number): Promise<StoredSite | null> {
    const row = (await this.db
      .prepare("SELECT * FROM sites WHERE id = ?")
      .bind(siteId)
      .first()) as Row | null;
    return row ? toSite(row) : null;
  }

  async listSites(userId: number): Promise<StoredSite[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM sites WHERE user_id = ? ORDER BY id")
      .bind(userId)
      .all();
    return (results as Row[]).map(toSite);
  }

  async listAllSites(): Promise<StoredSite[]> {
    const { results } = await this.db.prepare("SELECT * FROM sites ORDER BY id").all();
    return (results as Row[]).map(toSite);
  }

  // --- Questions ---

  async setQuestions(siteId: number, questions: string[]): Promise<void> {
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      this.db.prepare("DELETE FROM questions WHERE site_id = ?").bind(siteId),
      ...questions.map((q) =>
        this.db
          .prepare("INSERT INTO questions (site_id, text, created_at) VALUES (?, ?, ?)")
          .bind(siteId, q, now),
      ),
    ];
    await this.db.batch(statements);
  }

  async getQuestions(siteId: number): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT text FROM questions WHERE site_id = ? ORDER BY id")
      .bind(siteId)
      .all();
    return (results as Row[]).map((r) => String(r.text));
  }

  // --- Runs ---

  async saveRun(
    siteId: number,
    summary: VisibilitySummary,
    results: MentionResult[],
  ): Promise<number> {
    const now = new Date().toISOString();
    const runInfo = await this.db
      .prepare(
        `INSERT INTO runs
           (site_id, created_at, total_answers, brand_mention_rate, domain_cite_rate, share_of_voice, avg_rank)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        siteId,
        now,
        summary.totalAnswers,
        summary.brandMentionRate,
        summary.domainCiteRate,
        summary.shareOfVoice,
        summary.avgRank,
      )
      .run();
    const runId = Number(runInfo.meta.last_row_id);

    const statements = results.map((r) =>
      this.db
        .prepare(
          `INSERT INTO mentions
             (run_id, question, model, brand_mentioned, domain_cited, rank, competitors_found, cited_urls, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          runId,
          r.question,
          r.model,
          r.brandMentioned ? 1 : 0,
          r.domainCited ? 1 : 0,
          r.rank ?? null,
          JSON.stringify(r.competitorsFound),
          JSON.stringify(r.citedUrls),
          r.error ?? null,
        ),
    );
    if (statements.length) await this.db.batch(statements);
    return runId;
  }

  async listRuns(siteId: number, limit = 50): Promise<RunSummaryRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, created_at, total_answers, brand_mention_rate, domain_cite_rate, share_of_voice, avg_rank
         FROM runs WHERE site_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(siteId, limit)
      .all();
    return (results as Row[]).map(toRunSummary);
  }

  async close(): Promise<void> {
    // D1 connections are managed by the runtime; nothing to close.
  }
}
