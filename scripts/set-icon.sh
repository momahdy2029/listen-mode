#!/bin/bash
# Activate one icon variant (A|B|C|D) for Chrome (icons/), the Safari
# extension resources, and the Mac app icon catalog. Rebuild Safari after.
set -euo pipefail
V="${1:-}"; [[ "$V" =~ ^[ABCD]$ ]] || { echo "usage: $0 A|B|C|D"; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/icons/variants/$V"
XC="/Users/mo/ZCodeProject/YouTube Audio Mode"
EXT="$XC/Shared (Extension)/Resources/icons"
APPICON="$XC/Shared (App)/Assets.xcassets/AppIcon.appiconset"
LARGE="$XC/Shared (App)/Assets.xcassets/LargeIcon.imageset"

for f in icon16 icon32 icon48 icon128 toolbar16 toolbar32 toolbar48; do
  cp "$SRC/$f.png" "$REPO/icons/$f.png"
  cp "$SRC/$f.png" "$EXT/$f.png"
done
cp "$SRC"/mac-icon-*.png "$SRC/universal-icon-1024@1x.png" "$APPICON/"
cp "$SRC/icon128.png" "$LARGE/icon128.png"
cp "$SRC/Icon.png" "$XC/Shared (App)/Resources/Icon.png"
echo "$V" > "$REPO/icons/ACTIVE"
echo "icon variant $V active"
