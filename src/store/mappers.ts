// Row → object mappers shared by the SQLite and D1 stores. This module has no
// runtime dependencies (no node:sqlite), so it is safe to import inside a Worker.
import type { Cipher } from "../util/crypto.js";
import type { RunSummaryRow, StoredSite } from "./types.js";

export type Row = Record<string, number | bigint | string | null>;

export function toSite(row: Row): StoredSite {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    brand: String(row.brand),
    domain: String(row.domain),
    aliases: JSON.parse(String(row.aliases ?? "[]")),
    competitors: JSON.parse(String(row.competitors ?? "[]")),
    models: JSON.parse(String(row.models ?? "[]")),
  };
}

export function toRunSummary(row: Row): RunSummaryRow {
  return {
    id: Number(row.id),
    createdAt: String(row.created_at),
    totalAnswers: Number(row.total_answers),
    brandMentionRate: Number(row.brand_mention_rate),
    domainCiteRate: Number(row.domain_cite_rate),
    shareOfVoice: Number(row.share_of_voice),
    avgRank: row.avg_rank === null ? null : Number(row.avg_rank),
  };
}

/** Decrypt a stored key; tolerate plaintext (e.g. a deployment with no secret yet). */
export async function reveal(
  cipher: Cipher | null,
  raw: number | bigint | string | null,
): Promise<string | null> {
  if (raw === null) return null;
  const value = String(raw);
  if (!cipher) return value;
  try {
    return await cipher.decrypt(value);
  } catch {
    return value;
  }
}
