# Protagonist

Your life as a System. A bespoke, gamified life-OS — six dimensions (Physical, Mental, Spiritual, Family, Social, Financial) where every "rep" stacks mini-wins, and your body/mind/spirit/family/social health sets a **Vybrancy multiplier** that levels up your **income** (the main quest). Styled after the Solo Leveling "System."

## Architecture

- **`engine.js`** — pure, DOM-free, deterministic game core (works in the browser as `window.SYSTEM` and in Node). All rules, leveling, penalties, dedup, and the external-source ingestion live here. Versioned save with migration; every input is finite-guarded at the boundary.
- **`index.html`** — the System UI (view only). Reads engine state, renders, turns engine events into the glowing notification windows. Installable PWA.
- **`engine.test.js`** — Node stress battery (54 tests) covering the engine invariants.
- **`whoop-sync.js` / `whoop-sync.test.js`** — the WHOOP "game-master": maps a day's WHOOP data into reps and ingests it idempotently. CLI: `node whoop-sync.js save.json whoop.json`.
- **`manifest.json` / `service-worker.js` / `icon.svg`** — PWA shell (offline-capable, network-first for fresh builds).

### Auto-sources (mini-wins, everywhere)
`externalActivityToRep` in `engine.js` is the single place to register an auto-source. Today: WHOOP (→ Physical), and Amazon MCF orders / IG outreach / Gmail / sales (→ Financial). Adding a new source is one `case`. All ingestion is deduped by a collision-proof key.

### WHOOP sync — three paths, one idempotent engine
The PWA is static (no backend), and live WHOOP data lives in a Claude session's MCP. The bridge offers three ways in, all routed through the same `ingestWhoopDays` → `ingestExternal` path, so they dedupe against each other and can never double-count:

1. **Deep link** `…/#wh=<base64url JSON>` — one tap on the deployed phone PWA. Claude (with WHOOP MCP) pulls the day and hands over the link; the app decodes, ingests, then self-clears the hash. The phone path, since GitHub Pages never gets the data file.
2. **Auto-fetch** `whoop-today.json` — on boot the app `fetch()`es the file beside it and ingests silently (no toast unless something new lands). Works when the app is **served alongside the data file** (local / self-host); Claude keeps the file fresh from MCP. Absent on Pages → skipped.
3. **Manual** paste / file — universal fallback in the "Sync WHOOP" panel.

Workout XP rewards the *better* of duration (`min/3`) or intensity (`strain×2.2`), bounded [8,40]; recovery uses WHOOP's green/yellow/red bands; sleep ≥7h banks a bonus. The latest day's recovery/sleep/strain/HRV/RHR is stamped to `state.whoop` and shown in the **WHOOP Vitals** panel (display only — XP always lives in history). Time is monotonic: a multi-day backfill all credits *today*, never the past.

Day shape (`strain` and sleep `performance` optional):
```json
{ "date": "2026-06-16",
  "recovery": { "score": 66, "hrv": 95, "rhr": 49 },
  "sleep": { "id": "…", "hours": 7.53, "performance": 81 },
  "strain": 5.41,
  "workouts": [ { "id": "…", "sport": "walking", "durationMin": 53, "strain": 5.12 } ] }
```

## Develop

```bash
node engine.test.js       # run the engine stress battery
node whoop-sync.test.js   # run the WHOOP pipeline tests
```

Open `index.html` (served over http/https) to run the app.

## Deploy

Pushing to `main` runs the test suites and, if green, auto-deploys the app shell to GitHub Pages (`.github/workflows/deploy.yml`). Personal data (`save.json`, `whoop-today.json`) is gitignored and never published.
