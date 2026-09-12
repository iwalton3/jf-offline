#!/bin/sh
# Apply, revert or check this repository's optional jellyfin-web patches against
# a jellyfin-web checkout, so a patched build can be produced and served locally.
#
#   tools/patch-web.sh apply    [path]   add the entry points, then npm run build:production
#   tools/patch-web.sh revert   [path]   take them back out
#   tools/patch-web.sh status   [path]   is the checkout patched?
#
# The patches are optional by design: the overlay works against a stock build and
# the manager stays reachable through its Offline Sync settings page. This is for
# seeing the menu entries.
set -eu

ACTION="${1:-status}"
WEB="${2:-$HOME/Desktop/jellyfin-web}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCHES="$HERE/../patches"

[ -e "$WEB/.git" ] || { echo "not a git checkout of jellyfin-web: $WEB" >&2; exit 1; }
cd "$WEB"

case "$ACTION" in
    apply)
        for patch in "$PATCHES"/*.patch; do
            [ -e "$patch" ] || continue
            if git apply --check "$patch" 2>/dev/null; then
                git apply "$patch"
                echo "applied $(basename "$patch")"
            elif git apply --reverse --check "$patch" 2>/dev/null; then
                echo "already applied: $(basename "$patch")"
            else
                echo "does NOT apply to this checkout: $(basename "$patch")" >&2
                exit 1
            fi
        done
        echo
        echo "now build it:  (cd $WEB && npm run build:production)"
        echo "then serve:    python3 serve.py --webroot $WEB/dist"
        ;;
    revert)
        for patch in "$PATCHES"/*.patch; do
            [ -e "$patch" ] || continue
            if git apply --reverse --check "$patch" 2>/dev/null; then
                git apply --reverse "$patch"
                echo "reverted $(basename "$patch")"
            else
                echo "not applied: $(basename "$patch")"
            fi
        done
        ;;
    status)
        for patch in "$PATCHES"/*.patch; do
            [ -e "$patch" ] || continue
            if git apply --reverse --check "$patch" 2>/dev/null; then
                echo "applied:     $(basename "$patch")"
            elif git apply --check "$patch" 2>/dev/null; then
                echo "not applied: $(basename "$patch")"
            else
                echo "conflicts:   $(basename "$patch")"
            fi
        done
        echo
        echo "checkout: $WEB ($(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD))"
        ;;
    *)
        echo "usage: $0 {apply|revert|status} [path-to-jellyfin-web]" >&2
        exit 1
        ;;
esac
