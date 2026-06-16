#!/bin/bash
# Live WHOOP feed publisher (run by launchd ~every 20 min) — the autonomous, zero-tap WHOOP feed.
#
# IMPORTANT: launchd is sandboxed OUT of iCloud "Mobile Documents" (it gets "Operation not permitted"
# trying to touch this repo here). So the LIVE copy of this script + a working CLONE live OUTSIDE iCloud:
#   - script: ~/.protagonist/whoop-sync-push.sh   (what launchd actually runs)
#   - clone:  ~/.protagonist/feed                 (a git clone of this repo, non-iCloud)
#   - agent:  ~/Library/LaunchAgents/com.protagonist.whoopfeed.plist  (StartInterval 1200)
#
# Install / re-install:
#   git clone git@github.com:randomstorytelling/protagonist.git ~/.protagonist/feed
#   cp whoop-sync-push.sh ~/.protagonist/whoop-sync-push.sh && chmod +x ~/.protagonist/whoop-sync-push.sh
#   launchctl load -w ~/Library/LaunchAgents/com.protagonist.whoopfeed.plist
# Disable:  launchctl unload ~/Library/LaunchAgents/com.protagonist.whoopfeed.plist
# Logs:     ~/.protagonist/whoop-sync.log
#
# What it does: pull live WHOOP (whoop-pull.js) -> whoop-today.json, and push ONLY when it changed,
# so GitHub Pages republishes the feed and the app's poller picks it up.
NODE="/Users/lawrencewhitakeriii/.local/node/bin/node"
FEED="$HOME/.protagonist/feed"
LOG="$HOME/.protagonist/whoop-sync.log"
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/github_protagonist -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
cd "$FEED" || { echo "[$(date)] no feed clone at $FEED" >> "$LOG"; exit 1; }
{
  echo "[$(date)] --- run ---"
  git pull --rebase --autostash origin main || true
  if ! "$NODE" whoop-pull.js; then echo "pull failed"; exit 1; fi
  if git diff --quiet -- whoop-today.json; then echo "no change"; exit 0; fi
  git add whoop-today.json
  git -c user.name="whoop-feed" -c user.email="feed@protagonist.local" commit -m "chore(feed): refresh WHOOP $(date -u +%Y-%m-%dT%H:%MZ)" || { echo "nothing to commit"; exit 0; }
  git push origin main || { git pull --rebase --autostash origin main && git push origin main; }
  echo "pushed refreshed feed"
} >> "$LOG" 2>&1
