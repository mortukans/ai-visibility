export type Grounding = "native" | "online" | "none";

export interface ModelConfig {
  /** OpenRouter model slug, e.g. "openai/gpt-4o-mini". */
  id: string;
  /** Friendly name used in reports; falls back to `id`. */
  label?: string;
  /**
   * "native" = model searches the web on its own (e.g. Perplexity sonar),
   * "online" = append OpenRouter's :online web plugin to any model,
   * "none"   = answer from training data only (measures model "memory").
   * Defaults to "online".
   */
  grounding?: Grounding;
}

export interface SiteConfig {
  brand: string;
  /** Other ways your brand is written, e.g. ["Acme", "AcmeAnalytics"]. */
  aliases?: string[];
  /** Bare domain, e.g. "example.com". */
  domain: string;
  competitors: string[];
  models: ModelConfig[];
}

export interface MentionResult {
  question: string;
  model: string;
  brandMentioned: boolean;
  domainCited: boolean;
  citedUrls: string[];
  competitorsFound: string[];
  /** 1-based order of first appearance among all brands; null if not mentioned. */
  rank: number | null;
  answer: string;
  error?: string;
}

export interface VisibilitySummary {
  totalAnswers: number;
  /** Share of answers mentioning your brand (0..1). */
  brandMentionRate: number;
  /** Share of answers citing your domain (0..1). */
  domainCiteRate: number;
  /** Your mentions / all brand mentions (you + competitors). */
  shareOfVoice: number;
  /** Average rank across answers where you appear; null if never. */
  avgRank: number | null;
  perModel: Record<string, { answers: number; mentionRate: number; citeRate: number }>;
  competitorMentions: Record<string, number>;
}
