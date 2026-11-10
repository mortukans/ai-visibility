# AI Visibility

Check whether your site gets **mentioned and cited by AI models** when people ask
questions in your space — across many models, web-grounded, through one OpenRouter
key. Think "rank tracking", but for AI answers (ChatGPT-search, Perplexity, Gemini)
instead of Google.

- **BYOK** — each user brings their own [OpenRouter](https://openrouter.ai/keys) key,
  so running this costs ~nothing and scales to anyone.
- **Web-grounded** — models search the live web before answering, so results reflect
  what AI search actually says today (not stale training data).
- **Engine-first** — the core here is plain TypeScript, built to drop straight into a
  Cloudflare Worker + API later (see Roadmap).

## What it measures

For each question × model it records:

| Signal | Meaning |
| --- | --- |
| **Brand mentioned** | Your brand name appeared in the answer |
| **Domain cited** | Your URL appeared in the answer's sources (the strongest signal) |
| **Rank** | Where you first appear vs competitors in the answer |
| **Share of voice** | Your mentions ÷ all brand mentions (you + competitors) |

## Try it now (no key needed)

```bash
npm install
MOCK=1 npm run check
```

`MOCK=1` uses canned answers so you can see the output shape instantly.

## Run it for real

1. Get a key at https://openrouter.ai/keys
2. `export OPENROUTER_API_KEY=sk-or-...`  (Windows PowerShell: `$env:OPENROUTER_API_KEY="sk-or-..."`)
3. Edit `config.example.json` (your brand, domain, competitors, models) and
   `questions.example.txt` (the questions your buyers actually ask).
4. Run:

```bash
npm run check
```

Flags: `--config <file>` `--questions <file>` `--out <file>` `--db <file>` `--no-save`.
Full results are written to `results.json`, and each run is saved to a local
SQLite database (`data/ai-visibility.db` by default).

## History & trends

Every `npm run check` saves a run. To see how your AI visibility moves over time:

```bash
npm run history
```

```
History for "Acme Analytics" — 3 run(s)

  date/time          share of voice          mention  cite   rank
  2026-11-04 09:01   ██████·············· 30%   100%   100%  #3.0
  2026-11-04 09:30   ████████████········ 60%   100%   100%  #2.0
  2026-11-04 10:12   ████████████████···· 80%   100%   100%  #1.0

  Share of voice: 30% → 80%  ▲ +50pp since first run
```

Storage sits behind a small `Store` interface (`src/store/`), backed by Node's
**built-in** `node:sqlite` — no external database, no native build. The same SQL
moves to Cloudflare D1 in Phase 4 by adding a second `Store` implementation.

## HTTP API (multi-user, BYOK)

Start the API:

```bash
npm run api        # http://localhost:8787  (PORT and DB_PATH are configurable)
```

Anyone can build their own interface on top of it. The API is a single
Fetch-style handler (`Request` → `Response`), so the exact same code runs on
Cloudflare Workers in Phase 4 — only the dev-server adapter is Node-specific.

**Auth:** create an account to get an API key (shown once, stored hashed). Send it
as `Authorization: Bearer <key>`. Each account's sites are private to that account.

**Your OpenRouter key stays yours (BYOK):** store it once with
`PUT /v1/me/openrouter-key`, or pass `openrouterKey` in a run's body. The server
never ships with a key and never pays for your tokens.

| Method & path | Does |
| --- | --- |
| `POST /v1/users` | Create account → returns your API key |
| `GET /v1/me` | Account info |
| `PUT /v1/me/openrouter-key` | Store your OpenRouter key |
| `POST /v1/sites` | Add a site (brand, domain, competitors, models) |
| `GET /v1/sites` | List your sites |
| `GET /v1/sites/:id` | One site + its questions |
| `POST /v1/sites/:id/questions` | Set the questions to track |
| `POST /v1/sites/:id/run` | Run a check now → summary |
| `GET /v1/sites/:id/runs` | Run history (summaries) |
| `GET /v1/sites/:id/visibility` | Latest run + trend |

Example:

```bash
# 1. account
KEY=$(curl -s -X POST localhost:8787/v1/users \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).apiKey')

# 2. store your OpenRouter key
curl -s -X PUT localhost:8787/v1/me/openrouter-key \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"key":"sk-or-..."}'

# 3. add a site + questions, then run
curl -s -X POST localhost:8787/v1/sites \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"brand":"Acme","domain":"acme.com","competitors":["Mixpanel"]}'
curl -s -X POST localhost:8787/v1/sites/1/questions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"questions":["best analytics tools"]}'
curl -s -X POST localhost:8787/v1/sites/1/run -H "authorization: Bearer $KEY"
```

## Config

```jsonc
{
  "brand": "Acme Analytics",
  "aliases": ["Acme"],            // other spellings of your brand
  "domain": "acme-analytics.com", // bare domain
  "competitors": ["Mixpanel", "Amplitude"],
  "models": [
    { "id": "perplexity/sonar",       "grounding": "native" }, // searches on its own
    { "id": "openai/gpt-4o-mini",     "grounding": "online" }, // +OpenRouter web plugin
    { "id": "google/gemini-2.5-flash","grounding": "online" }
  ]
}
```

> Model slugs change over time — check https://openrouter.ai/models for current ones.
> `grounding: "online"` is the actionable mode (live web). `"none"` measures a model's
> training-data memory only.

## Dashboard

A zero-build web dashboard ships in `public/` and is served by the dev server:

```bash
npm run api     # then open http://localhost:8787/
```

From there you can create an account, store your OpenRouter key, add a site and its
questions, run a check, and watch **share of voice, mention/cite rates, the trend
over time, a per-model breakdown, and you-vs-competitors** — all against the same
API any other front-end would use. It's a single `index.html` (no framework, no
build), light/dark aware, and talks to the API over `fetch`, so you can also point
it at your deployed Worker.

## Deploy to Cloudflare

The same API, engine, **and dashboard** run on Cloudflare Workers, with **D1** for
storage and a **Cron Trigger** that re-runs every site's checks on a schedule.
Workers scale to zero, so idle cost is nothing and each user still pays only for
their own tokens (BYOK). One-time setup (needs a free Cloudflare account):

```bash
# 0. log in
npx wrangler login

# 1. create the D1 database, then paste the printed id into wrangler.toml
npx wrangler d1 create ai-visibility

# 2. create the tables on the remote database
npx wrangler d1 migrations apply ai-visibility --remote

# 3. set the secret that encrypts stored OpenRouter keys at rest
npx wrangler secret put KEY_SECRET

# 4. deploy (dashboard + API + daily cron) → prints your URL
npx wrangler deploy
```

Open the printed `https://ai-visibility.<you>.workers.dev` URL — the dashboard loads
from the Worker (served via `[assets]`), the API is at `/v1/*`, and the cron fires
daily. Redeploy any time with `npx wrangler deploy`.

- **`src/worker.ts`** is the entry point: `fetch` serves the identical API, and
  `scheduled` is the cron job (default `0 6 * * *` — daily 06:00 UTC, editable in
  `wrangler.toml`).
- **Keys at rest are encrypted** (AES-GCM) whenever `KEY_SECRET` is set — true both
  on the Worker and the local dev server (`KEY_SECRET=... npm run api`).
- Locally you can run the Worker build with D1 via `npm run dev:worker`
  (`wrangler dev`), or keep using `npm run api` (the Node dev server) for iteration.

## Project layout

```
src/
  engine/
    types.ts        shared types
    openrouter.ts   the only file that talks to OpenRouter
    detect.ts       brand + domain + competitor detection, ranking
    visibility.ts   share-of-voice aggregation
    run.ts          questions × models orchestration (shared core)
  store/
    types.ts        Store interface (persistence seam)
    schema.ts       shared table definitions
    mappers.ts      row → object mappers (no node deps)
    sqlite.ts       local SQLite store (node:sqlite)
    d1.ts           Cloudflare D1 store (same interface)
  api/
    http.ts         framework-free router + auth + JSON helpers
    app.ts          routes — the Worker-ready Fetch handler
  util/
    keys.ts         API-key generation + hashing (Web Crypto)
    crypto.ts       AES-GCM encryption for keys at rest
    quiet.ts        silences the node:sqlite experimental notice
  cli.ts            local runner (check + save)
  history.ts        history & trend reporter
  server.ts         Node dev server (serves the API + dashboard)
  worker.ts         Cloudflare Worker entry (fetch + scheduled cron)
public/
  index.html        dashboard — single file, no build step
```

## Roadmap

- **Phase 1 (done):** engine + CLI.
- **Phase 2 (done):** persistence (local SQLite) + history & trends.
- **Phase 3 (done):** REST API + per-user API keys (BYOK) → connect any interface.
- **Phase 4 (done):** Cloudflare D1 store + Cron Triggers + Workers deploy, keys
  encrypted at rest.

The four phases are complete — a working engine, history, a multi-tenant API, and a
deployable serverless backend — plus a web dashboard on top. Natural next steps if
you take it further: email/Slack alerts when share-of-voice drops, per-question
drill-downs, and rate limiting.
