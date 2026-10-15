#!/usr/bin/env bash
# Installs frame-push for the current macOS user: builds it, asks for Calendar access, stores the
# push token in the login Keychain and loads a LaunchAgent that pushes every 5 minutes.
#
#   ./install.sh --list-calendars   build, ask for Calendar access, print calendars to choose from
#   ./install.sh                    install (or update) and start
#   ./install.sh --new-token        same, and replace the token stored in the Keychain
#   ./install.sh --print-token      print a new random token for PUSH_CALENDARS, change nothing
#
# Everything goes under your user account; nothing needs sudo. Undo with ./uninstall.sh.
set -euo pipefail

LABEL="io.github.photo-frame-dashboard.frame-push"
SERVICE="frame-push" # Keychain service name; the account is the config's pushId
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/Library/Application Support/frame-push"
BIN="$APP_DIR/frame-push"
CONFIG="$APP_DIR/config.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/frame-push.log"

say() { printf '%s\n' "$*"; }

REBUILT=0
# Builds only when the source changed: a new build has a new signature, which needs the Calendar
# permission and the Keychain token's access granted again.
build() {
  command -v swiftc >/dev/null || { say "swiftc not found. Install the Xcode command line tools: xcode-select --install"; exit 1; }
  mkdir -p "$APP_DIR"
  local sum
  sum="$(cat "$HERE/frame-push.swift" "$HERE/Info.plist" | shasum -a 256 | cut -c1-64)"
  if [ -x "$BIN" ] && [ "$(cat "$APP_DIR/.build-sha256" 2>/dev/null)" = "$sum" ]; then
    return
  fi
  say "Building frame-push..."
  swiftc -O "$HERE/frame-push.swift" -o "$BIN.new" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$HERE/Info.plist"
  # A stable identifier, so macOS keeps the Calendar permission with this tool.
  codesign --force --sign - --identifier "$LABEL" "$BIN.new"
  mv "$BIN.new" "$BIN"
  echo "$sum" >"$APP_DIR/.build-sha256"
  REBUILT=1
}

case "${1:-}" in
  --print-token)
    LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40; echo
    exit 0
    ;;
  --list-calendars)
    build
    "$BIN" --request-access
    say ""
    say "Account / calendar / identifier (put identifiers in \"calendars\" in $CONFIG):"
    "$BIN" --list-calendars
    exit 0
    ;;
  ""|--new-token) ;;
  *) say "Unknown option: $1"; exit 2 ;;
esac

build

if [ ! -f "$CONFIG" ]; then
  cp "$HERE/config.example.json" "$CONFIG"
  chmod 600 "$CONFIG"
  say "Created $CONFIG from the example."
  say "Edit it (server, pushId, calendars), then run ./install.sh again."
  say "To see your calendars: ./install.sh --list-calendars"
  exit 0
fi

PUSH_ID="$(/usr/bin/plutil -extract pushId raw -o - "$CONFIG")"
if ! [[ "$PUSH_ID" =~ ^[a-z0-9_-]{1,32}$ ]]; then
  say "pushId in $CONFIG must be 1-32 chars of a-z, 0-9, _ or - (the id from PUSH_CALENDARS)."
  exit 1
fi

"$BIN" --request-access

NEED_TOKEN=0
[ "${1:-}" = "--new-token" ] && NEED_TOKEN=1
[ "$REBUILT" = 1 ] && NEED_TOKEN=1 # the new build must be allowed to read the token
security find-generic-password -s "$SERVICE" -a "$PUSH_ID" >/dev/null 2>&1 || NEED_TOKEN=1
if [ "$NEED_TOKEN" = 1 ]; then
  say ""
  say "Paste the token for \"$PUSH_ID\" (the same value as in PUSH_CALENDARS on the server)."
  say "macOS asks for it twice; it is not shown or saved anywhere else."
  # -w last with no value: security prompts for it, so the token never appears in a command line.
  # -T lets this frame-push build read it in the background without a Keychain prompt.
  security add-generic-password -U -s "$SERVICE" -a "$PUSH_ID" -l "frame-push ($PUSH_ID)" -T "$BIN" -w
else
  say "Keychain already has a token for \"$PUSH_ID\" (use --new-token to replace it)."
fi

say ""
say "Checking what would be sent (titles and times only):"
"$BIN" --dry-run >/dev/null

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
/usr/bin/plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

say ""
say "Installed. frame-push runs now and every 5 minutes."
say "Log: $LOG    (tail -f \"$LOG\")"
say "Undo: $HERE/uninstall.sh"
