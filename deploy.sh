#!/usr/bin/env bash
# Single source of truth for releasing the app. Prevents the gitignored deploy/ staging folder from drifting
# out of sync with the tested root source: it runs the full test battery (gate), copies the canonical files
# into deploy/, then firebase deploy. Always use this instead of a bare `firebase deploy`.
set -euo pipefail
cd "$(dirname "$0")"

echo "== test gate =="
node engine.test.js
node whoop-sync.test.js
node feeds.test.js

echo "== sync deploy/ from the tested root =="
mkdir -p deploy
cp index.html engine.js manifest.json service-worker.js icon.svg icon-180.png icon-192.png icon-512.png deploy/

echo "== firebase deploy =="
# protagonist-db3fd lives under the lawrence.a.whitaker@gmail.com Firebase account (NOT lawhitaker21@).
# Pin it so a drifted active account can't fail the deploy with a "permission" error.
firebase deploy --only hosting --project protagonist-db3fd --account lawrence.a.whitaker@gmail.com
echo "== done: https://protagonist-db3fd.firebaseapp.com =="
