#!/bin/bash
# The passes that can only run from this machine, once a day at 8:30pm.
#
# Two different reasons they are here rather than in CI:
#   * They need a signed-in Luma session — personalized discovery, the calendar
#     sync, the tagging pass — and that session must never reach CI.
#   * Or they need a residential Bay Area IP: Luma's discover feed is
#     geolocated, and search engines block datacenter addresses outright.
#
# No step can abort another, and a failure never leaves bad state: discovery
# output is merged rather than replaced, the sync is idempotent, and both the
# Luma feed pull and the normalizer refuse to overwrite good data with a
# collapsed run.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
CAL_NAME="${LUMA_CALENDAR_NAME:-HackList SF}"

# Credentials for the passes that want one, read from a gitignored .env.
#
# launchd hands this job a fixed, minimal environment, so anything the scheduled
# run needs has to come from somewhere on disk. A plist would work but stores
# secrets in plaintext in ~/Library, which is a worse place for them than a
# gitignored file inside the repo that only this script reads. Without it the
# search passes fall back to the keyless provider, which works from a residential
# address but finds a fraction as much.
if [ -f "$REPO/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO/.env"
  set +a
  echo "    loaded .env"
fi

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

# Luma's rich discover pull is the one for wherever the caller is, so the Bay
# Area's 889 events only arrive from here; from a datacenter that same call
# returns a couple of events and a 200. The per-region place feeds beside it work
# from anywhere. It refuses to overwrite a good pull with a collapsed one, so a
# bad run leaves the last good file alone.
echo "--- luma discover feed"
"$NODE" scripts/discover-luma-api.mjs || \
  echo "    luma api pass failed; previous pull kept" >&2

# LinkedIn runs here as well as in CI because search engines answer a residential
# address and block a datacenter one, so this is where it actually finds anything.
echo "--- linkedin discovery"
"$NODE" scripts/discover-linkedin.mjs || \
  echo "    linkedin pass failed; continuing" >&2

echo "--- personalized discovery"
"$NODE" scripts/discover-personalized.mjs $HEADLESS_FLAG || \
  echo "    personalized pass failed; continuing to sync" >&2

# Both passes only write seed files, which the next GitHub sweep crawls and
# classifies. Committed together so one push covers whichever of them changed.
# luma-api.json rides along: the GitHub sweep reads its calendar seeds, and the
# normalizer its candidates and enrichment, but only this machine can produce it.
SEED_FILES=(data/personalized-seeds.json data/linkedin-seeds.json data/luma-api.json)
# Validate before committing. A conflicted file once reached CI this way: the
# markers made it invalid JSON, and every reader treats a parse failure as "file
# absent", so a whole sweep ran without its calendar seeds and enrichment and
# nothing said a word.
for f in "${SEED_FILES[@]}"; do
  [ -f "$f" ] || continue
  if ! "$NODE" -e "JSON.parse(require('node:fs').readFileSync('$f','utf8'))" 2>/dev/null; then
    echo "    REFUSING to commit: $f is not valid JSON (conflict markers?)" >&2
    exit 1
  fi
done

# Refuse to commit into a repo where commits cannot reach origin. A failed
# rebase below once left this repo mid-rebase on a detached HEAD, and because
# nothing checked, the next four nightly runs committed onto that detached HEAD
# and reported success. Six days of seed collection sat unpushed and unnoticed;
# personalized-seeds.json only exists here, so nothing else could recover it.
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  echo "    REFUSING to commit: a rebase is in progress. Finish it or run" >&2
  echo "    'git rebase --abort', then check for commits stranded off main." >&2
  exit 1
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  if [ "$BRANCH" = "HEAD" ]; then
    echo "    REFUSING to commit: HEAD is detached at $(git rev-parse --short HEAD)." >&2
  else
    echo "    REFUSING to commit: HEAD is on branch $BRANCH, not main." >&2
  fi
  echo "    Commits made here would not reach origin. Check for stranded ones." >&2
  exit 1
fi

if ! git diff --quiet -- "${SEED_FILES[@]}"; then
  git add "${SEED_FILES[@]}"
  git -c user.name="hacklist-local" \
      -c user.email="local@hacklist.invalid" \
      commit -q -m "data: refresh local discovery seeds and Luma feed"
  # Teach git to union these files rather than text-merge them. Without this the
  # rebase below conflicts on data/linkedin-seeds.json every time a sweep landed
  # first, because CI writes that file too, which is what stranded five nights
  # of seeds. See scripts/merge-seeds.mjs.
  bash "$REPO/scripts/install-merge-driver.sh"
  # Rebase before pushing: a scheduled sweep may have committed in between.
  for attempt in 1 2 3; do
    git push -q origin HEAD:main && { echo "    pushed seeds"; break; }
    echo "    push rejected (attempt $attempt), rebasing"
    # Unwind a rebase that stops on a conflict. Leaving it in progress is what
    # stranded the commits: the repo stays on a detached HEAD, and every later
    # run commits there instead of main. Aborting keeps the commit on main so
    # the next run can retry it against a fresher origin.
    if ! git pull --rebase --autostash -q origin main; then
      echo "    rebase failed; aborting it, seeds stay committed for next run" >&2
      git rebase --abort 2>/dev/null || true
      break
    fi
  done
else
  echo "    no seed changes"
fi

# Whether or not this run committed, say plainly when commits are not on origin.
# The stranded-seeds incident ran for five nights unnoticed because the only
# evidence was a rebase error midway down a long log and a CI staleness warning
# that is deliberately not fatal (luma-api is geolocated, so CI cannot refresh
# it and must not go red for that). Nothing said "the seeds are not published".
git fetch -q origin 2>/dev/null || true
UNPUSHED="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
if [ "${UNPUSHED:-0}" -gt 0 ]; then
  echo "    WARNING: $UNPUSHED commit(s) here have never reached origin, so the" >&2
  echo "    seeds collected on this Mac are not in the published board." >&2
  echo "    Inspect with: git -C $REPO log --oneline origin/main..HEAD" >&2
fi

# One Luma calendar per region, named in config/discovery.json. A region whose
# calendar does not exist yet says so and the next region still runs.
REGIONS="$("$NODE" -e "const c=require('./config/discovery.json'); console.log(Object.entries(c.regions ?? {}).filter(([, r]) => r.lumaCalendarName).map(([k]) => k).join(' '))")"
DEFAULT_REGION="$("$NODE" -e "const c=require('./config/discovery.json'); console.log(c.defaultRegion ?? Object.keys(c.regions ?? {})[0] ?? '')")"
for REGION in $REGIONS; do
  # The env override, when set, names the default region's calendar. Every other
  # region takes its name from config.
  NAME_FLAG=()
  if [ -n "${LUMA_CALENDAR_NAME:-}" ] && [ "$REGION" = "$DEFAULT_REGION" ]; then
    NAME_FLAG=(--name "$CAL_NAME")
  fi

  echo "--- luma calendar sync ($REGION)"
  "$NODE" scripts/luma-sync-ui.mjs --region "$REGION" "${NAME_FLAG[@]}" $HEADLESS_FLAG || \
    echo "    sync did not complete for $REGION; queue state preserved" >&2

  echo "--- luma event tags ($REGION)"
  "$NODE" scripts/luma-tag-events.mjs --region "$REGION" "${NAME_FLAG[@]}" $HEADLESS_FLAG || \
    echo "    tagging did not complete for $REGION; already-applied tags are recorded" >&2
done

# Re-arm tomorrow's wake so the schedule survives the repeating wake being
# cleared by anything else that calls `pmset repeat` (it holds only one).
# Silently skipped when the sudoers rule is not installed.
echo "--- next wake"
bash "$REPO/scripts/arm-next-wake.sh" || true

echo "=== $(date '+%Y-%m-%d %H:%M:%S') local passes done"
