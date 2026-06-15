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

## Develop

```bash
node engine.test.js       # run the engine stress battery
node whoop-sync.test.js   # run the WHOOP pipeline tests
```

Open `index.html` (served over http/https) to run the app.

## Deploy

Pushing to `main` runs the test suites and, if green, auto-deploys the app shell to GitHub Pages (`.github/workflows/deploy.yml`). Personal data (`save.json`, `whoop-today.json`) is gitignored and never published.
