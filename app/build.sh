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
codesign --force --sign - --identifier com.artemis.desktop "$APP" >/dev/null 2>&1 || {
  echo "warning: codesign failed; the microphone prompt may not appear" >&2
}

echo "built $APP"
