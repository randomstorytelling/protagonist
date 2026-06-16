# Live WHOOP → Firestore feed

Push WHOOP into your cloud game state so the deployed PWA shows it **live** (its `onSnapshot`
listener + `mergeStates` fire within ~1s — no taps, no deep link, no public data file).

```
WHOOP MCP ──(pull)──> whoop-today.json ──(whoop-to-firestore.js, Admin SDK)──> Firestore users/{uid}
                                                                                      │ onSnapshot (~1s)
                                                                                      ▼
                                                                        deployed PWA merges + shows it
```

Firestore rules lock the doc to your signed-in account (verified: unauthenticated read/write → 403).
The writer uses a **Firebase Admin service-account key**, which bypasses rules — so it can write your
state server-side. It never clobbers progress: it reads the current cloud state, ingests WHOOP through
the same engine path as the app (`ingestWhoopDays`, deduped by activity id), writes back, and the app
**merges** it (monotonic union) — app edits and feed writes always converge.

## One-time setup (you do this once, ~1 min)

1. Firebase Console → project **protagonist-db3fd** → ⚙ **Project settings** → **Service accounts** tab.
2. Click **Generate new private key** → **Generate key** → a `.json` downloads.
3. Move it OUT of iCloud/git (the key is admin-level — keep it private, never commit):
   ```sh
   mkdir -p ~/.protagonist && mv ~/Downloads/protagonist-db3fd-*.json ~/.protagonist/sa.json
   ```
4. Tell Claude "the key is in" → first live push runs immediately, then the recurring feed gets wired.

## Manual push (one day)

```sh
cd "<this folder>"
npm install firebase-admin           # once
node whoop-to-firestore.js ~/.protagonist/sa.json whoop-today.json
```

## Recurring feed (set up after the first push works)

A local job (launchd/cron) every ~20–30 min, or a scheduled Claude routine, that:
1. pulls today's WHOOP (recovery, sleep, strain, workouts) → writes `whoop-today.json`
2. runs `whoop-to-firestore.js`

That's the live feed: WHOOP changes → Firestore → your phone updates within a second if the app is open,
or on next open if it isn't.
