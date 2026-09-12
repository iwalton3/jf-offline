/* The download manager as a modal, for jellyfin-web to open from its own menus.
 *
 * This is the entire surface the optional jellyfin-web patch talks to. The patch
 * adds two menu entries, each guarded on `window.__phantom?.ui`, and calls
 * `open()`. Nothing here is required: without the patch the same manager is
 * still reachable through the Offline Sync plugin page, which is why the overlay
 * works against a stock build.
 *
 * Loaded in the page, after ps-bootstrap.js.
 */
(function (g) {
    'use strict';

    const base = (g.PS_SCHEMA && g.PS_SCHEMA.basePath) || '';
    const TAG = 'offline-sync-manager';

    let overlay = null;

    /**
     * The manager module registers the element as a side effect of loading.
     *
     * A REAL file, not the worker's configurationpage route. That route only
     * exists inside the service worker, and a page is not controlled by the
     * worker on its first visit — so importing it there failed outright until
     * the second load, which is exactly when somebody tries the new menu entry.
     *
     * Memoised through once(), which forgets a failure: an import that fails
     * while the network is down must not leave the menu entry permanently dead
     * once it comes back.
     */
    const loadManager = (g.PS_SCHEMA && g.PS_SCHEMA.once)
        ? g.PS_SCHEMA.once(() => import(`${base}/web/plugin/manager.js`))
        : () => import(`${base}/web/plugin/manager.js`);

    /* Deliberately NOT a shadow root, though this is a lone panel in someone
     * else's document and a shadow root is the obvious way to isolate one.
     * vdx-web's styling relies on reaching the component from the document, and
     * a shadow boundary around it breaks that outright. The manager is its own
     * shadow-DOM component in any case, so the only markup exposed to
     * jellyfin-web's stylesheets is the chrome below — which is defended by
     * hand instead. Every layout property here is !important and every chrome
     * element is reset rather than assumed.
     */
    const CSS = `
        [data-phantom-modal] {
            position: fixed !important; inset: 0 !important; z-index: 100000 !important;
            display: flex !important; align-items: center !important; justify-content: center !important;
            margin: 0 !important; padding: 0 !important;
            /* Fixes the em unit to ours rather than to html's. jellyfin-web sets
               html's font-size from the viewport, and which of fonts.scss and
               fonts.sized.scss a build carries decides how far it moves. */
            font: 400 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif !important;
            color: #dde1e6;
        }
        [data-phantom-modal] * { box-sizing: border-box; }
        [data-phantom-modal] .phantom-modal-backdrop {
            position: absolute !important; inset: 0 !important;
            background: rgba(0,0,0,.72) !important;
        }
        [data-phantom-modal] .phantom-modal-panel {
            position: relative !important;
            display: flex !important; flex-direction: column !important;
            /* Percentages, never viewport units: these resolve against the fixed
               container, whereas 100vw counts a scrollbar and 100vh counts mobile
               browser chrome that is not there. A panel wider than the container
               centring it hangs off both sides, and the right-hand side is where
               the close button is. */
            width: min(1100px, 94%) !important; max-width: 100% !important;
            height: 88% !important; max-height: 100% !important;
            margin: 0 !important;
            background: #14171b !important;
            border: 1px solid #343a42 !important; border-radius: 4px !important;
            box-shadow: 0 12px 48px rgba(0,0,0,.55);
            overflow: hidden !important;
        }
        [data-phantom-modal] .phantom-modal-bar {
            display: flex !important; align-items: center !important; gap: .75em !important;
            flex: none !important; margin: 0 !important; padding: .85em 1em !important;
            border-bottom: 1px solid #343a42 !important;
            overflow: hidden !important;
        }
        [data-phantom-modal] .phantom-modal-bar h2 {
            /* min-width:0 is what lets the title shrink instead of shoving the
               button off the edge, and jellyfin-web sizes a bare h2 at 1.5em. */
            flex: 1 1 auto !important; min-width: 0 !important;
            margin: 0 !important; padding: 0 !important;
            font-size: 16px !important; font-weight: 600 !important; line-height: 1.4 !important;
            overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important;
        }
        [data-phantom-modal] .phantom-modal-close {
            flex: none !important; max-width: 40% !important;
            margin: 0 !important; padding: .4em 1em !important;
            font: inherit !important; font-size: 13px !important; text-transform: none !important;
            white-space: nowrap !important;
            color: inherit !important; background: transparent !important;
            border: 1px solid #343a42 !important; border-radius: 3px !important;
            -webkit-appearance: none; appearance: none; cursor: pointer;
        }
        [data-phantom-modal] .phantom-modal-close:hover {
            border-color: #00a4dc !important; color: #00a4dc !important;
        }
        /* The body scrolls, not the page behind it. */
        [data-phantom-modal] .phantom-modal-body {
            flex: 1 1 auto !important; margin: 0 !important; padding: 1em !important;
            overflow-y: auto !important; overflow-x: hidden !important;
        }
        @media (max-width: 640px) {
            [data-phantom-modal] .phantom-modal-panel {
                width: 100% !important; height: 100% !important;
                border: none !important; border-radius: 0 !important;
            }
            [data-phantom-modal] .phantom-modal-bar { padding: .7em .75em !important; gap: .5em !important; }
            [data-phantom-modal] .phantom-modal-close { padding: .4em .7em !important; }
            [data-phantom-modal] .phantom-modal-body { padding: .75em !important; }
        }`;

    function build() {
        // Through the parser rather than document.createElement: jellyfin-web's
        // webcomponents polyfill replaces createElement and an element made that
        // way is never upgraded. See overlay/plugin/vdx-native-dom.js.
        const holder = document.createElement('div');
        holder.innerHTML = `
            <div data-phantom-modal role="dialog" aria-modal="true" aria-label="Offline downloads">
                <div class="phantom-modal-backdrop"></div>
                <div class="phantom-modal-panel">
                    <div class="phantom-modal-bar">
                        <h2>Offline downloads</h2>
                        <button type="button" class="phantom-modal-close" aria-label="Close">Close</button>
                    </div>
                    <div class="phantom-modal-body"><${TAG}></${TAG}></div>
                </div>
            </div>`;
        const el = holder.firstElementChild;

        // Inside the modal, so closing it takes the stylesheet with it.
        const style = document.createElement('style');
        style.textContent = CSS;
        el.appendChild(style);
        return el;
    }

    function close() {
        if (!overlay) return;
        overlay.remove();
        overlay = null;
        document.documentElement.style.removeProperty('overflow');
        document.removeEventListener('keydown', onKeyDown, true);
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
        }
    }

    /**
     * Show the manager.
     *
     * With `{ serverId, itemId }` it opens straight onto that item's download
     * question, which is what the context-menu entry wants; with no arguments it
     * is the manager as the settings page shows it.
     */
    async function open(options = {}) {
        await loadManager();
        if (overlay) close();

        overlay = build();
        document.body.appendChild(overlay);
        // The page behind must not scroll under a full-height panel.
        document.documentElement.style.overflow = 'hidden';

        overlay.querySelector('.phantom-modal-close').addEventListener('click', close);
        overlay.querySelector('.phantom-modal-backdrop').addEventListener('click', close);
        document.addEventListener('keydown', onKeyDown, true);

        const manager = overlay.querySelector(TAG);
        if (options.itemId && manager) {
            // The element upgrades asynchronously; openFor exists once it has.
            const deadline = Date.now() + 5000;
            while (typeof manager.openFor !== 'function' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (typeof manager.openFor === 'function') {
                await manager.openFor(options.serverId, options.itemId);
            }
        }
        return overlay;
    }

    g.__phantom = g.__phantom || {};
    g.__phantom.ui = {
        open,
        close,
        isOpen: () => !!overlay,
        element: () => (overlay ? overlay.querySelector(TAG) : null)
    };
})(window);
