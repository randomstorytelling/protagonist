#!/bin/bash
# Autonomous WHOOP -> GitHub Pages publisher. Run by launchd (~every 20 min).
# Pulls live WHOOP, and IF the feed changed, commits + pushes whoop-today.json so the deployed
# Protagonist app auto-loads fresh recovery/sleep/strain/workouts. Logs to ~/.protagonist/.
NODE="/Users/lawrencewhitakeriii/.local/node/bin/node"
REPO="/Users/lawrencewhitakeriii/Library/Mobile Documents/com~apple~CloudDocs/CLAUDE/Protagonist"
LOG="$HOME/.protagonist/whoop-sync.log"
mkdir -p "$HOME/.protagonist"
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/github_protagonist -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
cd "$REPO" || { echo "[$(date)] cannot cd to repo" >> "$LOG"; exit 1; }
{
  echo "[$(date)] --- run ---"
  if ! "$NODE" whoop-pull.js; then echo "pull failed"; exit 1; fi
  if git diff --quiet -- whoop-today.json; then echo "no change"; exit 0; fi
  git pull --rebase --autostash origin main || true        # absorb concurrent commits (other files); feed file rarely conflicts
  git add whoop-today.json
  git -c user.name="whoop-feed" -c user.email="feed@protagonist.local" commit -m "chore(feed): refresh WHOOP $(date -u +%Y-%m-%dT%H:%MZ)" || { echo "nothing to commit"; exit 0; }
  if ! git push origin main; then                           # retry once after rebasing if origin moved
    git pull --rebase --autostash origin main && git push origin main
  fi
  echo "pushed refreshed feed"
} >> "$LOG" 2>&1
