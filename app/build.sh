#!/usr/bin/env bash
# Builds Artemis.app. No Xcode required — swiftc plus a hand-assembled bundle.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
OUT="$HERE/build"
APP="$OUT/Artemis.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# The repo path is baked in so the app always runs the current working copy.
sed "s|__ARTEMIS_ROOT__|$ROOT|g" "$HERE/Info.plist.in" > "$APP/Contents/Info.plist"

# Icon. Regenerated from makeicon.swift when missing, so a fresh clone doesn't
# need the binary committed — every size is drawn at its own resolution rather
# than downsampled, which is what keeps it legible at 16px.
if [ ! -f "$HERE/AppIcon.icns" ]; then
  echo "generating app icon…"
  swiftc -O -o "$OUT/makeicon" "$HERE/makeicon.swift"
  ( cd "$HERE" && "$OUT/makeicon" "$HERE/AppIcon.icns" )
fi
cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

swiftc -O \
  -o "$APP/Contents/MacOS/Artemis" \
  "$HERE"/Sources/*.swift

# Ad-hoc signature: enough for the microphone prompt to appear. It changes on
# every build, so macOS may re-ask for mic access after a rebuild.
# A STABLE identity keeps macOS permission grants (Accessibility, Input
# Monitoring, microphone) valid across rebuilds. Ad-hoc signing changes the
# code hash every build and silently invalidates them all.
SIGN_ID="FlowClone Dev"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_ID"; then
  codesign --force --sign "$SIGN_ID" --identifier com.artemis.desktop "$APP" || {
    echo "warning: identity signing failed; falling back to ad-hoc" >&2
    codesign --force --sign - --identifier com.artemis.desktop "$APP" >/dev/null 2>&1 || true
  }
else
  codesign --force --sign - --identifier com.artemis.desktop "$APP" >/dev/null 2>&1 || {
    echo "warning: codesign failed; the microphone prompt may not appear" >&2
  }
fi

echo "built $APP"

# Ad-hoc signing means every rebuild changes the app's code hash, and macOS
# silently invalidates Accessibility/microphone grants keyed to the old hash
# (the checkbox still LOOKS on). Until the app has a stable signing identity,
# say it out loud after every build:
echo ""
echo "⚠ rebuild note: if hold-fn dictation or WhatsApp sends stop working,"
echo "  re-trust the app: System Settings → Privacy & Security → Accessibility →"
echo "  remove Artemis (−) and re-add it (+), then reopen Artemis."
