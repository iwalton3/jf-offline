#!/bin/sh
# Copy the vdx-web files the settings page uses into the overlay.
#
# Copied rather than referenced because the overlay is what gets served, and vdx
# has no build step: its ui/ components import '../../lib/framework.js' by
# relative path, so the directory shape has to survive the copy.
#
# One rewrite is applied on the way in: `document.createElement(` becomes
# `vdxCreateElement(`. jellyfin-web loads the 2015 v0 webcomponents polyfill for
# its own emby-* elements, and an element created through that polyfill's
# replacement createElement is never upgraded by the native registry — so every
# vdx component built that way throws in connectedCallback instead of rendering.
# See overlay/plugin/vdx-native-dom.js.
set -eu
SRC="${1:-/working/vdx-web}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/../overlay/plugin/vdx"

rm -rf "$DEST"
mkdir -p "$DEST/ui/selection" "$DEST/ui/data" "$DEST/ui/misc" "$DEST/styles"
cp -r "$SRC/lib" "$DEST/lib"
cp "$SRC/ui/selection/dropdown.js"  "$DEST/ui/selection/"
cp "$SRC/ui/data/virtual-list.js"   "$DEST/ui/data/"
cp "$SRC/ui/misc/spinner.js"        "$DEST/ui/misc/"
cp "$SRC/styles/theme.css"          "$DEST/styles/"
find "$DEST" -name "*.map" -delete

patched=0
for file in $(grep -rl "document\.createElement(" "$DEST" --include="*.js"); do
    sed -i 's/document\.createElement(/vdxCreateElement(/g' "$file"
    sed -i "1i import { vdxCreateElement } from '/web/plugin/vdx-native-dom.js';" "$file"
    patched=$((patched + 1))
done

echo "vdx synced from $SRC -> $DEST ($patched files rewritten for createElement)"
