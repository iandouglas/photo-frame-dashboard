#!/usr/bin/env bash
# Stops and removes frame-push for the current user.
#   ./uninstall.sh          remove the LaunchAgent and the binary; keep config and Keychain token
#   ./uninstall.sh --purge  also delete the config and the Keychain token
# The Calendar permission stays listed in System Settings → Privacy & Security → Calendars;
# switch it off there if you like.
set -euo pipefail

LABEL="io.github.photo-frame-dashboard.frame-push"
SERVICE="frame-push"
APP_DIR="$HOME/Library/Application Support/frame-push"
CONFIG="$APP_DIR/config.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST" "$APP_DIR/frame-push"
echo "LaunchAgent and binary removed."

if [ "${1:-}" = "--purge" ]; then
  if [ -f "$CONFIG" ]; then
    PUSH_ID="$(/usr/bin/plutil -extract pushId raw -o - "$CONFIG" 2>/dev/null || true)"
    if [ -n "$PUSH_ID" ]; then
      security delete-generic-password -s "$SERVICE" -a "$PUSH_ID" >/dev/null 2>&1 && echo "Keychain token removed." || true
    fi
  fi
  rm -rf "$APP_DIR"
  echo "Config removed."
fi
