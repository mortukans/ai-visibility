import type { MentionResult, SiteConfig } from "./types.js";
import type { GroundedAnswer } from "./openrouter.js";

/** Escape a string so it can sit inside a RegExp literally. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive, boundary-aware check that `name` appears in `text`.
 * The boundaries stop "Heap" from matching inside "cheaper".
 */
function mentions(text: string, name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  return new RegExp(`(?<![a-z0-9])${esc(n)}(?![a-z0-9])`, "i").test(text);
}

/** Earliest index at which any of `names` appears, or Infinity if none do. */
function firstIndex(text: string, names: string[]): number {
  let best = Infinity;
  for (const name of names) {
    const n = name.trim();
    if (!n) continue;
    const m = new RegExp(`(?<![a-z0-9])${esc(n)}(?![a-z0-9])`, "i").exec(text);
    if (m && m.index < best) best = m.index;
  }
  return best;
}

/** Turn one model answer into a structured visibility result. */
export function analyze(
  question: string,
  modelLabel: string,
  answer: GroundedAnswer,
  site: SiteConfig,
): MentionResult {
  const text = answer.text ?? "";
  const brandNames = [site.brand, ...(site.aliases ?? [])];

  const brandMentioned = brandNames.some((n) => mentions(text, n));

  const domainLower = site.domain.toLowerCase();
  const domainCited =
    answer.citedUrls.some((u) => u.toLowerCase().includes(domainLower)) ||
    text.toLowerCase().includes(domainLower);

  const competitorsFound = site.competitors.filter((c) => mentions(text, c));

  // Rank = order of first appearance among every brand that appears at all.
  const appearances: { at: number; isYou: boolean }[] = [];
  const brandAt = firstIndex(text, brandNames);
  if (brandAt !== Infinity) appearances.push({ at: brandAt, isYou: true });
  for (const c of site.competitors) {
    const at = firstIndex(text, [c]);
    if (at !== Infinity) appearances.push({ at, isYou: false });
  }
  appearances.sort((a, b) => a.at - b.at);
  const youIndex = appearances.findIndex((a) => a.isYou);
  const rank = youIndex === -1 ? null : youIndex + 1;

  return {
    question,
    model: modelLabel,
    brandMentioned,
    domainCited,
    citedUrls: answer.citedUrls,
    competitorsFound,
    rank,
    answer: text,
  };
}
