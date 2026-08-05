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

# Resolve node at run time rather than trusting a path captured at install
# time. A node upgrade renames the nvm directory, which silently broke this job
# once already; launchd also starts with a minimal PATH that has no nvm in it.
find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1
}
NODE="$(find_node)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') cannot find node; aborting" >&2
  exit 1
fi
export PATH="$(dirname "$NODE"):$PATH"

# Hold sleep off for the duration. Without this the Mac can doze mid-run and
# leave the browser half-finished; the sync is idempotent so it would recover,
# but there is no reason to make it recover from something avoidable.
if command -v caffeinate >/dev/null && [ -z "${HACKLIST_CAFFEINATED:-}" ]; then
  export HACKLIST_CAFFEINATED=1
  exec caffeinate -i -m "$0" "$@"
fi

echo "=== $(date '+%Y-%m-%d %H:%M:%S') local passes starting"

# Headless on the schedule: this fires when the lid opens, and a Chrome window
# seizing the screen at that moment is obnoxious. Both scripts detect when a
# human is genuinely needed (sign-out, CAPTCHA) and stop with state intact, so
# you re-run them headed only then.
HEADLESS_FLAG="--headless"
[ "${HACKLIST_HEADED:-0}" = "1" ] && HEADLESS_FLAG=""

# LinkedIn discovery runs here rather than only in CI for one reason: its paid
# search fallback goes through the `zero` CLI, which is signed in on this
# machine and absent in GitHub Actions. In CI the keyless search endpoint is
# usually throttled to nothing, so without this pass the LinkedIn leg would
# quietly find nothing most days. Costs a fraction of a cent per run, and only
# when the free provider came back empty.
echo "--- linkedin discovery"
"$NODE" scripts/discover-linkedin.mjs || \
  echo "    linkedin pass failed; continuing" >&2

echo "--- personalized discovery"
"$NODE" scripts/discover-personalized.mjs $HEADLESS_FLAG || \
  echo "    personalized pass failed; continuing to sync" >&2

# Both passes only write seed files, which the next GitHub sweep crawls and
# classifies. Committed together so one push covers whichever of them changed.
SEED_FILES=(data/personalized-seeds.json data/linkedin-seeds.json)
if ! git diff --quiet -- "${SEED_FILES[@]}"; then
  git add "${SEED_FILES[@]}"
  git -c user.name="hacklist-local" \
      -c user.email="local@hacklist.invalid" \
      commit -q -m "data: refresh personalized and LinkedIn seeds"
  # Rebase before pushing: a scheduled sweep may have committed in between.
  for attempt in 1 2 3; do
    git push -q origin HEAD:main && { echo "    pushed seeds"; break; }
    echo "    push rejected (attempt $attempt), rebasing"
    git pull --rebase --autostash -q origin main || break
  done
else
  echo "    no seed changes"
fi

echo "--- luma calendar sync"
"$NODE" scripts/luma-sync-ui.mjs --name "$CAL_NAME" $HEADLESS_FLAG || \
  echo "    sync did not complete; queue state preserved" >&2

echo "--- luma event tags"
"$NODE" scripts/luma-tag-events.mjs --name "$CAL_NAME" $HEADLESS_FLAG || \
  echo "    tagging did not complete; already-applied tags are recorded" >&2

# Arm the wake for the next run before exiting, so the chain sustains itself with
# the lid shut. `pmset repeat` only holds one wake time and there are two runs.
# Silently skipped when the sudoers rule is not installed.
echo "--- next wake"
bash "$REPO/scripts/arm-next-wake.sh" || true

echo "=== $(date '+%Y-%m-%d %H:%M:%S') local passes done"
