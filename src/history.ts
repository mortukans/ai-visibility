import "./util/quiet.js";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SiteConfig } from "./engine/types.js";
import type { RunSummaryRow } from "./store/types.js";
import { SqliteStore } from "./store/sqlite.js";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v ?? fallback;
}

const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4);

/** A small bar, 0..1 scaled to 20 blocks, for an at-a-glance trend. */
function bar(value: number): string {
  const filled = Math.round(value * 20);
  return "█".repeat(filled) + "·".repeat(20 - filled);
}

async function main() {
  const configPath = arg("--config", "config.example.json");
  const dbPath = arg("--db", "data/ai-visibility.db");

  const site = JSON.parse(readFileSync(configPath, "utf8")) as SiteConfig;

  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new SqliteStore(dbPath);
  await store.init();
  const userId = await store.ensureLocalUser();
  const siteId = await store.findSite(userId, site.brand, site.domain);
  if (siteId === null) {
    console.log(`\nNo runs saved yet for "${site.brand}". Run \`npm run check\` first.\n`);
    await store.close();
    return;
  }
  const runs = await store.listRuns(siteId, 50);
  await store.close();

  // listRuns returns newest-first; show oldest-first so the trend reads left→right.
  const chrono: RunSummaryRow[] = [...runs].reverse();

  console.log(`\nHistory for "${site.brand}" — ${runs.length} run(s)\n`);
  console.log(`  date/time          share of voice          mention  cite   rank`);
  for (const r of chrono) {
    const when = r.createdAt.slice(0, 16).replace("T", " ");
    const rank = r.avgRank === null ? "  — " : `#${r.avgRank.toFixed(1)}`;
    console.log(
      `  ${when}  ${bar(r.shareOfVoice)} ${pct(r.shareOfVoice)}   ` +
        `${pct(r.brandMentionRate)}   ${pct(r.domainCiteRate)}  ${rank}`,
    );
  }

  if (chrono.length >= 2) {
    const first = chrono[0].shareOfVoice;
    const last = chrono[chrono.length - 1].shareOfVoice;
    const deltaPp = Math.round((last - first) * 100);
    const arrow = deltaPp > 0 ? "▲" : deltaPp < 0 ? "▼" : "▪";
    const sign = deltaPp > 0 ? "+" : "";
    console.log(
      `\n  Share of voice: ${pct(first).trim()} → ${pct(last).trim()}  ` +
        `${arrow} ${sign}${deltaPp}pp since first run`,
    );
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
