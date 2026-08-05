#!/bin/bash
# Make the local passes fire on time even with the lid shut.
#
# The problem this solves, measured rather than assumed. There was already a
# `pmset repeat wakepoweron at 7:55AM` on this machine, and it does fire — the
# power log shows it armed as `request=UserWake wakeAt=07:55:00`. It is useless
# anyway, because macOS goes straight back to sleep: the log shows wake, then
# "Entering Sleep state due to 'Maintenance Sleep'" within 3-77 seconds. By the
# time the 08:30 job is due the machine has been asleep for half an hour, so
# launchd coalesces the missed fire and runs it whenever you next open the lid.
# In the log that is exactly what happened: the 08:30 job ran at 08:35:28.
#
# There was also no evening wake at all, so the 20:30 pass only ever ran when you
# happened to be using the laptop.
#
# Two changes fix it:
#
#   1. The wake lands one minute before the job instead of 35 minutes before, so
#      the machine is still awake when launchd fires and caffeinate can take over.
#   2. `pmset repeat` allows only one wake time per day, and there are two runs, so
#      scripts/local-passes.sh arms the *next* wake at the end of every run. That
#      needs `pmset schedule` without a password prompt, which is what the sudoers
#      rule below grants — narrowly, for that one command.
#
# Run this once. It needs your password (it edits /etc/sudoers.d and arms a wake).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUDOERS_FILE="/etc/sudoers.d/hacklist-pmset"
USER_NAME="$(id -un)"

echo "This grants $USER_NAME passwordless sudo for exactly two pmset"
echo "subcommands — scheduling and cancelling wake events — and nothing else."
echo "It cannot be used to change any other power setting or run any other tool."
echo

# NOPASSWD is scoped to `pmset schedule ...` and `pmset schedulepower ...` only.
# pmset takes no shell metacharacters and cannot execute anything, so this does
# not widen into general root access the way a broad rule would.
TMP="$(mktemp)"
cat > "$TMP" <<EOF
# Installed by scripts/install-wake-schedule.sh for hacklist-sf.
# Lets the local discovery passes arm their own next wake-from-sleep, so they run
# on schedule with the lid shut. Scoped to wake scheduling only.
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/pmset schedule *
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/pmset schedulepower *
EOF

# Never install a sudoers file without checking it first: a malformed one can
# lock you out of sudo entirely.
if ! sudo visudo -c -f "$TMP" >/dev/null; then
  echo "Refusing to install: the generated sudoers file did not validate." >&2
  rm -f "$TMP"
  exit 1
fi
sudo install -m 0440 -o root -g wheel "$TMP" "$SUDOERS_FILE"
rm -f "$TMP"
echo "Installed $SUDOERS_FILE"

# Verify the grant actually works before relying on it.
if sudo -n /usr/bin/pmset -g sched >/dev/null 2>&1; then
  echo "note: pmset -g sched needs no sudo, so that was not a real check"
fi

# Drop the old, mistimed repeat wake and set one that lands just before the
# morning run. The evening one is armed by local-passes.sh after each run.
sudo pmset repeat cancel || true
sudo pmset repeat wakeorpoweron MTWRFSU 08:29:00
echo "Set a daily repeating wake at 08:29 (one minute before the 08:30 pass)."

# Arm tonight's wake immediately rather than waiting for the next run to do it.
bash "$REPO/scripts/arm-next-wake.sh" || true

echo
echo "Current schedule:"
pmset -g sched
echo
echo "Real-world test: shut the lid and leave it. Tomorrow, check that"
echo "  grep 'local passes starting' logs/local-passes.log"
echo "shows runs at ~08:30 and ~20:30 rather than whenever you opened it."
