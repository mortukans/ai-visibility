import type { Store, StoredSite, User } from "./store/types.js";

/** Fire an alert when share of voice drops by at least this many points. */
const DROP_THRESHOLD_PP = 10;

/**
 * After a run is saved, post a webhook alert if the site's share of voice fell by
 * DROP_THRESHOLD_PP points vs the previous run. The body carries both `text`
 * (Slack) and `content` (Discord) so one webhook URL works for either, or any
 * generic endpoint. Best-effort: callers should ignore failures.
 */
export async function maybeAlert(store: Store, user: User, site: StoredSite): Promise<void> {
  if (!user.alertWebhook) return;

  const runs = await store.listRuns(site.id, 2); // newest first: [latest, previous]
  if (runs.length < 2) return;

  const now = runs[0].shareOfVoice;
  const prev = runs[1].shareOfVoice;
  const dropPp = Math.round((prev - now) * 100);
  if (dropPp < DROP_THRESHOLD_PP) return;

  const text =
    `⚠️ AI visibility drop for ${site.brand}: share of voice ` +
    `${Math.round(prev * 100)}% → ${Math.round(now * 100)}% (${dropPp}pp drop) · ${site.domain}`;

  await fetch(user.alertWebhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, content: text }),
  });
}
