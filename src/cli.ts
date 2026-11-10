import "./util/quiet.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SiteConfig } from "./engine/types.js";
import { runChecks } from "./engine/run.js";
import { summarize } from "./engine/visibility.js";
import { SqliteStore } from "./store/sqlite.js";

/** Read `--flag value` from argv, or fall back to a default. */
function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v ?? fallback;
}

async function main() {
  const configPath = arg("--config", "config.example.json");
  const questionsPath = arg("--questions", "questions.example.txt");
  const outPath = arg("--out", "results.json");
  const dbPath = arg("--db", "data/ai-visibility.db");

  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey && process.env.MOCK !== "1") {
    console.error("Set OPENROUTER_API_KEY (or MOCK=1 to try it with canned answers).");
    process.exit(1);
  }

  const site = JSON.parse(readFileSync(configPath, "utf8")) as SiteConfig;
  const questions = readFileSync(questionsPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  console.log(
    `\nChecking "${site.brand}" across ${site.models.length} model(s) × ${questions.length} question(s)...\n`,
  );

  const results = await runChecks(apiKey, site, questions);
  const summary = summarize(results, site);

  for (const r of results) {
    if (r.error) {
      console.log(`  x [${r.model}] ${r.question} — ${r.error}`);
      continue;
    }
    const marks = [
      r.brandMentioned ? "mentioned" : "—",
      r.domainCited ? "cited" : "—",
      r.rank ? `#${r.rank}` : "unranked",
    ].join("  ");
    const vs = r.competitorsFound.length ? `  vs ${r.competitorsFound.join(", ")}` : "";
    console.log(`  [${r.model}] ${r.question}\n      ${marks}${vs}`);
  }

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  console.log(`\n─── ${site.brand} — AI visibility ───`);
  console.log(`  Brand mention rate : ${pct(summary.brandMentionRate)}`);
  console.log(`  Domain cite rate   : ${pct(summary.domainCiteRate)}`);
  console.log(`  Share of voice     : ${pct(summary.shareOfVoice)}`);
  console.log(`  Avg rank when shown: ${summary.avgRank ? summary.avgRank.toFixed(1) : "—"}`);
  console.log(`  By model:`);
  for (const [m, v] of Object.entries(summary.perModel)) {
    console.log(`    ${m}: mentioned ${pct(v.mentionRate)}, cited ${pct(v.citeRate)} (${v.answers} answers)`);
  }
  console.log(
    `  Competitor mentions: ` +
      Object.entries(summary.competitorMentions)
        .map(([c, n]) => `${c} ${n}`)
        .join(", "),
  );

  writeFileSync(
    outPath,
    JSON.stringify({ site: site.brand, when: new Date().toISOString(), summary, results }, null, 2),
  );
  console.log(`\nSaved full results → ${outPath}`);

  // Persist this run so history and trends build up over time (skip with --no-save).
  if (!process.argv.includes("--no-save")) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const store = new SqliteStore(dbPath);
    await store.init();
    const userId = await store.ensureLocalUser();
    const siteId = await store.upsertSite(userId, {
      brand: site.brand,
      domain: site.domain,
      aliases: site.aliases ?? [],
      competitors: site.competitors,
      models: site.models,
    });
    const runId = await store.saveRun(siteId, summary, results);
    await store.close();
    console.log(`Saved run #${runId} → ${dbPath}  (run \`npm run history\` for trends)`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
