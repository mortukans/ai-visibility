import type { ModelConfig } from "./types.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface GroundedAnswer {
  text: string;
  /** URLs the model cited, from OpenRouter's url_citation annotations. */
  citedUrls: string[];
}

/**
 * Ask one model one question through OpenRouter, with web grounding when configured.
 * Returns the answer text plus any URLs the model cited.
 *
 * This is the only place that talks to OpenRouter, so swapping providers or
 * moving into a Cloudflare Worker later touches just this file.
 */
export async function askGrounded(
  apiKey: string,
  model: ModelConfig,
  question: string,
): Promise<GroundedAnswer> {
  // `process` may be undefined in a Worker; guard so this stays cross-platform.
  if (typeof process !== "undefined" && process.env?.MOCK === "1") return mockAnswer(question);

  const grounding = model.grounding ?? "online";
  // OpenRouter's ":online" suffix attaches its web-search plugin to any model.
  // "native" models (e.g. Perplexity sonar) already search, so leave them as-is.
  const slug = grounding === "online" ? `${model.id}:online` : model.id;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: slug,
      messages: [{ role: "user", content: question }],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as any;
  const message = data?.choices?.[0]?.message ?? {};
  const text: string = typeof message.content === "string" ? message.content : "";

  // Cited sources come back as annotations of type "url_citation".
  const annotations: any[] = Array.isArray(message.annotations) ? message.annotations : [];
  const citedUrls = annotations
    .filter((a) => a?.type === "url_citation" && a?.url_citation?.url)
    .map((a) => a.url_citation.url as string);

  return { text, citedUrls };
}

/** Canned answer so the tool is runnable without a key (MOCK=1). */
function mockAnswer(question: string): GroundedAnswer {
  const text =
    `For "${question}", popular options include Mixpanel and Amplitude. ` +
    `Acme Analytics is a strong privacy-focused alternative, and PostHog is also worth a look. ` +
    `See https://acme-analytics.com/guide and https://mixpanel.com for details.`;
  return { text, citedUrls: ["https://acme-analytics.com/guide", "https://mixpanel.com"] };
}
