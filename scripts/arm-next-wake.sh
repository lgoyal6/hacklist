#!/bin/bash
# Arm a one-off wake one minute before the next scheduled local pass.
#
# The repeating wake set by install-wake-schedule.sh already covers the single
# daily run, so this is belt and braces: each run re-arms tomorrow's, so the
# schedule survives the repeating wake being cleared by anything else that calls
# `pmset repeat` (it holds only one, so any other user of it wins).
#
# Needs the sudoers rule from scripts/install-wake-schedule.sh. Without it this
# exits quietly rather than hanging on a password prompt that nobody will answer
# — a scheduled job blocking on stdin is worse than a missing wake.
set -uo pipefail

# Keep in step with the StartCalendarInterval entry in the launchd plist.
RUN_AT="20:30"
LEAD_SECONDS=60

if ! sudo -n /usr/bin/pmset schedule cancelall >/dev/null 2>&1; then
  echo "    no passwordless pmset; skipping wake arming (run scripts/install-wake-schedule.sh)" >&2
  exit 0
fi

# Whichever of the two run times comes next, minus the lead.
now_epoch=$(date +%s)
next_epoch=""
for hhmm in "$RUN_AT"; do
  for day_offset in 0 1; do
    # Shift the day first, then parse the result. Passing -v to the parsing call
    # as well applies the offset twice, which silently puts "tomorrow" two days
    # out — and a wake armed for the wrong day looks exactly like no wake at all.
    day=$(date -j -v+"${day_offset}"d +%Y-%m-%d)
    candidate=$(date -j -f "%Y-%m-%d %H:%M:%S" "$day ${hhmm}:00" +%s 2>/dev/null) || continue
    candidate=$((candidate - LEAD_SECONDS))
    if [ "$candidate" -gt "$((now_epoch + 120))" ]; then
      if [ -z "$next_epoch" ] || [ "$candidate" -lt "$next_epoch" ]; then
        next_epoch="$candidate"
      fi
    fi
  done
done

if [ -z "$next_epoch" ]; then
  echo "    could not work out the next run time; no wake armed" >&2
  exit 0
fi

# pmset wants "MM/dd/yy HH:mm:ss" in local time.
when=$(date -j -f %s "$next_epoch" "+%m/%d/%y %H:%M:%S")
if sudo -n /usr/bin/pmset schedule wake "$when" 2>/dev/null; then
  echo "    armed wake for $when"
else
  echo "    could not arm wake for $when" >&2
fi
