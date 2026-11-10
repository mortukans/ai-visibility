import type { MentionResult, SiteConfig, VisibilitySummary } from "./types.js";

/** Aggregate per-answer results into the headline visibility numbers. */
export function summarize(results: MentionResult[], site: SiteConfig): VisibilitySummary {
  const valid = results.filter((r) => !r.error);
  const denom = valid.length || 1;

  const brandHits = valid.filter((r) => r.brandMentioned).length;
  const citeHits = valid.filter((r) => r.domainCited).length;

  // Share of voice: your mentions vs all brand mentions (you + each competitor).
  let yourMentions = 0;
  const competitorMentions: Record<string, number> = {};
  for (const c of site.competitors) competitorMentions[c] = 0;
  for (const r of valid) {
    if (r.brandMentioned) yourMentions++;
    for (const c of r.competitorsFound) {
      competitorMentions[c] = (competitorMentions[c] ?? 0) + 1;
    }
  }
  const competitorTotal = Object.values(competitorMentions).reduce((a, b) => a + b, 0);
  const allMentions = yourMentions + competitorTotal;
  const shareOfVoice = allMentions === 0 ? 0 : yourMentions / allMentions;

  const ranks = valid.map((r) => r.rank).filter((x): x is number => x !== null);
  const avgRank = ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null;

  const perModel: VisibilitySummary["perModel"] = {};
  for (const r of valid) {
    const m = (perModel[r.model] ??= { answers: 0, mentionRate: 0, citeRate: 0 });
    m.answers++;
    if (r.brandMentioned) m.mentionRate++;
    if (r.domainCited) m.citeRate++;
  }
  for (const m of Object.values(perModel)) {
    m.mentionRate /= m.answers;
    m.citeRate /= m.answers;
  }

  return {
    totalAnswers: valid.length,
    brandMentionRate: brandHits / denom,
    domainCiteRate: citeHits / denom,
    shareOfVoice,
    avgRank,
    perModel,
    competitorMentions,
  };
}
