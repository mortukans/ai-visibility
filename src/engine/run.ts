import type { MentionResult, SiteConfig } from "./types.js";
import { askGrounded } from "./openrouter.js";
import { analyze } from "./detect.js";

/**
 * Run every question against every model and analyze each answer.
 * This is the shared core: the CLI uses it today, the Worker/API will reuse it.
 */
export async function runChecks(
  apiKey: string,
  site: SiteConfig,
  questions: string[],
): Promise<MentionResult[]> {
  const results: MentionResult[] = [];
  for (const model of site.models) {
    const label = model.label ?? model.id;
    for (const question of questions) {
      try {
        const answer = await askGrounded(apiKey, model, question);
        results.push(analyze(question, label, answer, site));
      } catch (err) {
        results.push({
          question,
          model: label,
          brandMentioned: false,
          domainCited: false,
          citedUrls: [],
          competitorsFound: [],
          rank: null,
          answer: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return results;
}
