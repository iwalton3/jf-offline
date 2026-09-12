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
mkdir -p "$DEST/lib" "$DEST/ui/selection" "$DEST/ui/data" "$DEST/ui/misc" "$DEST/styles"

# The pre-built bundles rather than lib/'s 27 source modules: the whole app is
# precached for offline use, and 27 files is 27 cache entries and 27 requests
# for the same code. They are copied to lib/ under their own names because that
# is the path ui/ components import them by, so nothing has to be rewritten.
for bundle in framework utils windowing overlay gestures; do
    cp "$SRC/dist/$bundle.js" "$DEST/lib/$bundle.js"
done
cp "$SRC/ui/selection/dropdown.js"  "$DEST/ui/selection/"
cp "$SRC/ui/data/virtual-list.js"   "$DEST/ui/data/"
cp "$SRC/ui/misc/spinner.js"        "$DEST/ui/misc/"
cp "$SRC/styles/theme.css"          "$DEST/styles/"
find "$DEST" -name "*.map" -delete

# The import is RELATIVE, computed per file, because the site may be deployed in
# a subdirectory (GitHub Pages project sites are) and an absolute /web/... path
# would only resolve at an origin root.
patched=0
for file in $(grep -rl "document\.createElement(" "$DEST" --include="*.js"); do
    rel="${file#"$DEST"/}"
    depth=$(printf '%s' "$rel" | tr -cd '/' | wc -c)
    up=""
    i=0
    while [ "$i" -lt "$depth" ]; do up="../$up"; i=$((i + 1)); done
    sed -i 's/document\.createElement(/vdxCreateElement(/g' "$file"
    sed -i "1i import { vdxCreateElement } from '${up}../vdx-native-dom.js';" "$file"
    patched=$((patched + 1))
done

echo "vdx synced from $SRC -> $DEST ($patched files rewritten for createElement)"
