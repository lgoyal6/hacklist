#!/bin/bash
# Installs a launchd job that runs both signed-in local passes twice a day,
# shortly after the GitHub sweeps land fresh data (8:30am and 8:30pm Pacific):
# personalized discovery (pushes new seeds for the next sweep to crawl) and the
# Luma calendar sync.
#
# This runs locally on purpose: the sync needs a signed-in Luma session, which
# must never be placed in CI. The Mac has to be awake and logged in; launchd
# runs the job at the next opportunity if it was asleep.
#
# Usage:  bash scripts/install-luma-schedule.sh [--uninstall]
set -euo pipefail

LABEL="com.hacklist.local-passes"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
CAL_NAME="${LUMA_CALENDAR_NAME:-HackList SF}"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL."
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/logs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/local-passes.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LUMA_CALENDAR_NAME</key><string>$CAL_NAME</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StandardOutPath</key><string>$REPO/logs/local-passes.log</string>
  <key>StandardErrorPath</key><string>$REPO/logs/local-passes.log</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

cat <<EOF

Installed $LABEL
  Runs:     8:30am and 8:30pm (this Mac's local time), when awake
  Does:     personalized discovery (pushes seeds) + Luma calendar sync
  Calendar: $CAL_NAME
  Log:      $REPO/logs/local-passes.log

  Run now:      launchctl kickstart -p gui/$(id -u)/$LABEL
  Check status: launchctl print gui/$(id -u)/$LABEL | head -20
  Remove:       bash scripts/install-luma-schedule.sh --uninstall

The sync is idempotent, so an extra run costs nothing. If the session signs
out or Luma shows a CAPTCHA it stops without losing queue state, and the log
will say so — re-run it by hand and sign in when that happens.
EOF
