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

    /**
     * Built inside a shadow root.
     *
     * jellyfin-web's stylesheets are global and opinionated about buttons and
     * headings, and they reached in here: on a phone the close button was pushed
     * outside the panel. A shadow root is the only way to be sure nothing does
     * that, and it costs one wrapper element.
     */
    function build() {
        const host = document.createElement('div');
        host.setAttribute('data-phantom-modal', '');
        const root = host.attachShadow({ mode: 'open' });

        root.innerHTML = `
            <style>
                /* Everything inside is ours; nothing leaks in or out. */
                :host { all: initial; }
                * { box-sizing: border-box; font-family: inherit; }
                .wrap {
                    position: fixed; inset: 0; z-index: 100000;
                    display: flex; align-items: center; justify-content: center;
                    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
                    color: #dde1e6;
                }
                .backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.72); }
                .panel {
                    position: relative; display: flex; flex-direction: column;
                    width: min(1100px, 94vw); max-width: 100%;
                    height: min(88vh, 100%); max-height: 100%;
                    background: #14171b;
                    border: 1px solid #343a42; border-radius: 4px;
                    box-shadow: 0 12px 48px rgba(0,0,0,.55);
                    overflow: hidden;
                }
                .bar {
                    display: flex; align-items: center; gap: .75em;
                    padding: .85em 1em; border-bottom: 1px solid #343a42;
                    flex: none; overflow: hidden;
                }
                /* min-width:0 is what lets the title shrink instead of shoving the
                   button off the edge, which is what happened on a phone. */
                .bar h2 {
                    margin: 0; font-size: 16px; font-weight: 600;
                    flex: 1 1 auto; min-width: 0;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                }
                .close {
                    flex: none; white-space: nowrap;
                    background: transparent; color: inherit;
                    border: 1px solid #343a42; border-radius: 3px;
                    padding: .4em 1em; font: inherit; font-size: 13px; cursor: pointer;
                    min-width: 0; max-width: 40%;
                }
                .close:hover { border-color: #00a4dc; color: #00a4dc; }
                .body { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding: 1em; }
                @media (max-width: 640px) {
                    .panel { width: 100%; height: 100%; border: none; border-radius: 0; }
                    .bar { padding: .7em .75em; gap: .5em; }
                    .close { padding: .4em .7em; }
                    .body { padding: .75em; }
                }
            </style>
            <div class="wrap" role="dialog" aria-modal="true" aria-label="Offline downloads">
                <div class="backdrop"></div>
                <div class="panel">
                    <div class="bar">
                        <h2>Offline downloads</h2>
                        <button type="button" class="close" aria-label="Close">Close</button>
                    </div>
                    <div class="body"><${TAG}></${TAG}></div>
                </div>
            </div>`;
        return host;
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

        const root = overlay.shadowRoot;
        root.querySelector('.close').addEventListener('click', close);
        root.querySelector('.backdrop').addEventListener('click', close);
        document.addEventListener('keydown', onKeyDown, true);

        const manager = root.querySelector(TAG);
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
        // The manager lives in a shadow root, so reaching it needs a way in.
        element: () => (overlay ? overlay.shadowRoot.querySelector(TAG) : null)
    };
})(window);
