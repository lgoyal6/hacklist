#!/bin/bash
# The two passes that need a signed-in browser, run together on a schedule.
#
# 1. Personalized discovery: collects the events Luma shows this account, then
#    commits and pushes them so the next GitHub sweep crawls and classifies
#    them. Only public event URLs are written; the session never leaves here.
# 2. Luma calendar sync: adds newly published events to the HackList SF
#    calendar through Luma's own admin UI.
#
# Neither step is allowed to abort the other, and a failure here never leaves
# bad state: discovery output is merged, and the sync is idempotent.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
CAL_NAME="${LUMA_CALENDAR_NAME:-HackList SF}"
export PATH="$(dirname "$(command -v node)"):/usr/local/bin:/opt/homebrew/bin:$PATH"

# Hold sleep off for the duration. Without this the Mac can doze mid-run and
# leave the browser half-finished; the sync is idempotent so it would recover,
# but there is no reason to make it recover from something avoidable.
if command -v caffeinate >/dev/null && [ -z "${HACKLIST_CAFFEINATED:-}" ]; then
  export HACKLIST_CAFFEINATED=1
  exec caffeinate -i -m "$0" "$@"
fi

echo "=== $(date '+%Y-%m-%d %H:%M:%S') local passes starting"

echo "--- personalized discovery"
if node scripts/discover-personalized.mjs; then
  if ! git diff --quiet -- data/personalized-seeds.json; then
    git add data/personalized-seeds.json
    git -c user.name="hacklist-local" \
        -c user.email="local@hacklist.invalid" \
        commit -q -m "data: refresh personalized Luma seeds"
    # Rebase before pushing: a scheduled sweep may have committed in between.
    for attempt in 1 2 3; do
      git push -q origin HEAD:main && { echo "    pushed seeds"; break; }
      echo "    push rejected (attempt $attempt), rebasing"
      git pull --rebase --autostash -q origin main || break
    done
  else
    echo "    no seed changes"
  fi
else
  echo "    personalized pass failed; continuing to sync" >&2
fi

echo "--- luma calendar sync"
node scripts/luma-sync-ui.mjs --name "$CAL_NAME" || \
  echo "    sync did not complete; queue state preserved" >&2

echo "=== $(date '+%Y-%m-%d %H:%M:%S') local passes done"
