import { DatabaseSync } from "node:sqlite";
import type { MentionResult, VisibilitySummary } from "../engine/types.js";
import type { Cipher } from "../util/crypto.js";
import { generateApiKey, hashKey } from "../util/keys.js";
import { reveal, type Row, toRunSummary, toSite } from "./mappers.js";
import { SCHEMA } from "./schema.js";
import type { RateResult, RunSummaryRow, SiteInput, Store, StoredSite, User } from "./types.js";

const LOCAL_EMAIL = "local@localhost";

/** Local persistence backed by Node's built-in SQLite (no external dependency). */
export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(
    path: string,
    private cipher: Cipher | null = null,
  ) {
    this.db = new DatabaseSync(path);
  }

  async init(): Promise<void> {
    this.db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of SCHEMA) this.db.exec(statement);
    // Additive migration for local DBs created before the alert_webhook column.
    try {
      this.db.exec("ALTER TABLE users ADD COLUMN alert_webhook TEXT");
    } catch {
      /* column already exists */
    }
  }

  // --- Users & auth ---

  async createUser(email: string): Promise<{ id: number; apiKey: string }> {
    const now = new Date().toISOString();
    const info = this.db
      .prepare("INSERT INTO users (email, created_at) VALUES (?, ?)")
      .run(email, now);
    const id = Number(info.lastInsertRowid);
    const apiKey = generateApiKey();
    this.db
      .prepare("INSERT INTO api_keys (user_id, key_hash, label, created_at) VALUES (?, ?, ?, ?)")
      .run(id, await hashKey(apiKey), "default", now);
    return { id, apiKey };
  }

  async getUserByApiKey(apiKey: string): Promise<User | null> {
    const row = this.db
      .prepare(
        `SELECT u.id, u.email, u.openrouter_key, u.alert_webhook
           FROM api_keys k JOIN users u ON u.id = k.user_id
          WHERE k.key_hash = ?`,
      )
      .get(await hashKey(apiKey)) as Row | undefined;
    return row ? this.toUser(row) : null;
  }

  async getUser(id: number): Promise<User | null> {
    const row = this.db
      .prepare("SELECT id, email, openrouter_key, alert_webhook FROM users WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? this.toUser(row) : null;
  }

  async setOpenrouterKey(userId: number, key: string | null): Promise<void> {
    const stored = key && this.cipher ? await this.cipher.encrypt(key) : key;
    this.db.prepare("UPDATE users SET openrouter_key = ? WHERE id = ?").run(stored, userId);
  }

  async setAlertWebhook(userId: number, url: string | null): Promise<void> {
    const stored = url && this.cipher ? await this.cipher.encrypt(url) : url;
    this.db.prepare("UPDATE users SET alert_webhook = ? WHERE id = ?").run(stored, userId);
  }

  async ensureLocalUser(): Promise<number> {
    this.db
      .prepare("INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)")
      .run(LOCAL_EMAIL, new Date().toISOString());
    const row = this.db.prepare("SELECT id FROM users WHERE email = ?").get(LOCAL_EMAIL) as Row;
    return Number(row.id);
  }

  private async toUser(row: Row): Promise<User> {
    return {
      id: Number(row.id),
      email: String(row.email),
      openrouterKey: await reveal(this.cipher, row.openrouter_key),
      alertWebhook: await reveal(this.cipher, row.alert_webhook),
    };
  }

  // --- Sites ---

  async upsertSite(userId: number, site: SiteInput): Promise<number> {
    this.db
      .prepare(
        `INSERT INTO sites (user_id, brand, domain, aliases, competitors, models, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, brand, domain) DO UPDATE SET
           aliases = excluded.aliases,
           competitors = excluded.competitors,
           models = excluded.models`,
      )
      .run(
        userId,
        site.brand,
        site.domain,
        JSON.stringify(site.aliases),
        JSON.stringify(site.competitors),
        JSON.stringify(site.models),
        new Date().toISOString(),
      );
    const id = await this.findSite(userId, site.brand, site.domain);
    if (id === null) throw new Error("failed to upsert site");
    return id;
  }

  async findSite(userId: number, brand: string, domain: string): Promise<number | null> {
    const row = this.db
      .prepare("SELECT id FROM sites WHERE user_id = ? AND brand = ? AND domain = ?")
      .get(userId, brand, domain) as Row | undefined;
    return row ? Number(row.id) : null;
  }

  async getSite(siteId: number): Promise<StoredSite | null> {
    const row = this.db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId) as Row | undefined;
    return row ? toSite(row) : null;
  }

  async listSites(userId: number): Promise<StoredSite[]> {
    const rows = this.db
      .prepare("SELECT * FROM sites WHERE user_id = ? ORDER BY id")
      .all(userId) as Row[];
    return rows.map(toSite);
  }

  async listAllSites(): Promise<StoredSite[]> {
    const rows = this.db.prepare("SELECT * FROM sites ORDER BY id").all() as Row[];
    return rows.map(toSite);
  }

  // --- Questions ---

  async setQuestions(siteId: number, questions: string[]): Promise<void> {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      "INSERT INTO questions (site_id, text, created_at) VALUES (?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM questions WHERE site_id = ?").run(siteId);
      for (const q of questions) insert.run(siteId, q, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async getQuestions(siteId: number): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT text FROM questions WHERE site_id = ? ORDER BY id")
      .all(siteId) as Row[];
    return rows.map((r) => String(r.text));
  }

  // --- Runs ---

  async saveRun(
    siteId: number,
    summary: VisibilitySummary,
    results: MentionResult[],
  ): Promise<number> {
    const now = new Date().toISOString();
    const runInfo = this.db
      .prepare(
        `INSERT INTO runs
           (site_id, created_at, total_answers, brand_mention_rate, domain_cite_rate, share_of_voice, avg_rank)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        siteId,
        now,
        summary.totalAnswers,
        summary.brandMentionRate,
        summary.domainCiteRate,
        summary.shareOfVoice,
        summary.avgRank,
      );
    const runId = Number(runInfo.lastInsertRowid);

    const insertMention = this.db.prepare(
      `INSERT INTO mentions
         (run_id, question, model, brand_mentioned, domain_cited, rank, competitors_found, cited_urls, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec("BEGIN");
    try {
      for (const r of results) {
        insertMention.run(
          runId,
          r.question,
          r.model,
          r.brandMentioned ? 1 : 0,
          r.domainCited ? 1 : 0,
          r.rank ?? null,
          JSON.stringify(r.competitorsFound),
          JSON.stringify(r.citedUrls),
          r.error ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return runId;
  }

  async listRuns(siteId: number, limit = 50): Promise<RunSummaryRow[]> {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, total_answers, brand_mention_rate, domain_cite_rate, share_of_voice, avg_rank
         FROM runs WHERE site_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(siteId, limit) as Row[];
    return rows.map(toRunSummary);
  }

  async hitRateLimit(bucket: string, limit: number, windowSec: number): Promise<RateResult> {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare("SELECT count, reset_at FROM rate_limits WHERE bucket = ?")
      .get(bucket) as Row | undefined;
    if (!row || Number(row.reset_at) <= now) {
      const resetAt = now + windowSec;
      this.db
        .prepare(
          `INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
           ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
        )
        .run(bucket, resetAt);
      return { ok: true, remaining: limit - 1, resetAt };
    }
    const count = Number(row.count) + 1;
    this.db.prepare("UPDATE rate_limits SET count = ? WHERE bucket = ?").run(count, bucket);
    return { ok: count <= limit, remaining: Math.max(0, limit - count), resetAt: Number(row.reset_at) };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
