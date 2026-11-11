import type { MentionResult, ModelConfig, VisibilitySummary } from "../engine/types.js";

/** One past run's headline numbers, for history and trends. */
export interface RunSummaryRow {
  id: number;
  createdAt: string; // ISO timestamp
  totalAnswers: number;
  brandMentionRate: number;
  domainCiteRate: number;
  shareOfVoice: number;
  avgRank: number | null;
}

export interface RateResult {
  ok: boolean;
  remaining: number;
  resetAt: number; // unix seconds when the window resets
}

export interface User {
  id: number;
  email: string;
  /** The user's own OpenRouter key (BYOK), or null if not set yet. */
  openrouterKey: string | null;
  /** Webhook URL (Slack/Discord/generic) for drop alerts, or null. */
  alertWebhook: string | null;
}

/** Everything needed to create or update a site. */
export interface SiteInput {
  brand: string;
  domain: string;
  aliases: string[];
  competitors: string[];
  models: ModelConfig[];
}

export interface StoredSite extends SiteInput {
  id: number;
  userId: number;
}

/**
 * Persistence seam. The local SQLite store implements this today; a Cloudflare D1
 * store implements the same interface later (D1 is SQLite, so the SQL carries over —
 * only the driver calls change). Methods are async so the async D1 version fits
 * without changing any caller.
 */
export interface Store {
  init(): Promise<void>;

  // Users & auth (BYOK)
  createUser(email: string): Promise<{ id: number; apiKey: string }>;
  getUserByApiKey(apiKey: string): Promise<User | null>;
  getUser(id: number): Promise<User | null>;
  setOpenrouterKey(userId: number, key: string | null): Promise<void>;
  setAlertWebhook(userId: number, url: string | null): Promise<void>;
  /** Get-or-create the default local user used by the CLI. */
  ensureLocalUser(): Promise<number>;

  // Sites
  upsertSite(userId: number, site: SiteInput): Promise<number>;
  findSite(userId: number, brand: string, domain: string): Promise<number | null>;
  getSite(siteId: number): Promise<StoredSite | null>;
  listSites(userId: number): Promise<StoredSite[]>;
  /** Every site across all users — used by the scheduled (cron) job. */
  listAllSites(): Promise<StoredSite[]>;

  // Questions
  setQuestions(siteId: number, questions: string[]): Promise<void>;
  getQuestions(siteId: number): Promise<string[]>;

  // Runs
  saveRun(siteId: number, summary: VisibilitySummary, results: MentionResult[]): Promise<number>;
  listRuns(siteId: number, limit?: number): Promise<RunSummaryRow[]>;

  // Rate limiting (fixed window, keyed by an arbitrary bucket string)
  hitRateLimit(bucket: string, limit: number, windowSec: number): Promise<RateResult>;

  close(): Promise<void>;
}
