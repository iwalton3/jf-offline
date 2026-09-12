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
    let loading = null;

    /**
     * The manager module registers the element as a side effect of loading.
     *
     * A REAL file, not the worker's configurationpage route. That route only
     * exists inside the service worker, and a page is not controlled by the
     * worker on its first visit — so importing it there failed outright until
     * the second load, which is exactly when somebody tries the new menu entry.
     */
    function loadManager() {
        if (!loading) loading = import(`${base}/web/plugin/manager.js`);
        return loading;
    }

    function build() {
        // Through the parser rather than document.createElement: jellyfin-web's
        // webcomponents polyfill replaces createElement and an element made that
        // way is never upgraded. See overlay/plugin/vdx-native-dom.js.
        const holder = document.createElement('div');
        holder.innerHTML = `
            <div class="phantom-modal" role="dialog" aria-modal="true" aria-label="Offline downloads">
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

        const style = document.createElement('style');
        style.textContent = `
            .phantom-modal { position: fixed; inset: 0; z-index: 100000;
                display: flex; align-items: center; justify-content: center; }
            .phantom-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.72); }
            .phantom-modal-panel {
                position: relative; display: flex; flex-direction: column;
                width: min(1100px, 94vw); height: min(88vh, 100%);
                background: #14171b; color: #dde1e6;
                border: 1px solid #343a42; border-radius: 4px;
                box-shadow: 0 12px 48px rgba(0,0,0,.55);
            }
            .phantom-modal-bar {
                display: flex; align-items: center; gap: 1em;
                padding: .85em 1em; border-bottom: 1px solid #343a42; flex: none;
            }
            .phantom-modal-bar h2 { margin: 0; font-size: 16px; font-weight: 600; flex: 1 1 auto; }
            .phantom-modal-close {
                flex: none; background: transparent; color: inherit;
                border: 1px solid #343a42; border-radius: 3px;
                padding: .4em 1em; font: inherit; font-size: 13px; cursor: pointer;
            }
            .phantom-modal-close:hover { border-color: #00a4dc; color: #00a4dc; }
            /* The body scrolls, not the page behind it. */
            .phantom-modal-body { flex: 1 1 auto; overflow-y: auto; padding: 1em; }
            @media (max-width: 640px) {
                .phantom-modal-panel { width: 100vw; height: 100vh; border: none; border-radius: 0; }
            }
        `;
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
    g.__phantom.ui = { open, close, isOpen: () => !!overlay };
})(window);
