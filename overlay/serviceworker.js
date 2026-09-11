/* The phantom Jellyfin server.
 *
 * The host answers /System/Info/Public and injects the bootstrap tags into
 * index.html, because both have to happen before this file exists; see serve.py.
 * Everything else is answered here.
 *
 * This file replaces jellyfin-web's own dist/serviceworker.js. That is the whole
 * change to the built app, and it works because of how worker scope is defined:
 * jellyfin-web registers this script with no scope option (src/index.jsx:197),
 * which yields scope /web/, and a worker's scope decides which *pages* it
 * controls rather than which URLs it may answer. Controlling /web/index.html
 * means seeing every request that page makes, including /Items and /Videos at the
 * origin root, which is where the phantom server lives.
 *
 * jellyfin-web's original notification handling is kept at the bottom, unchanged.
 */

/* eslint-disable no-restricted-globals -- self is the global in a service worker */

/* This file is ALSO loaded as an ordinary page script.
 *
 * jellyfin-web's build lists the serviceworker chunk in HtmlWebpackPlugin's
 * `chunks` (webpack.common.js:74), so dist/index.html carries a
 * <script defer src="serviceworker.js">. Upstream that is inert — their worker
 * only registers a notificationclick handler, which on window does nothing. Ours
 * calls importScripts, which does not exist in a page and throws before the app
 * has finished booting, so everything below the guard runs in the worker only.
 */
const IS_SERVICE_WORKER = typeof ServiceWorkerGlobalScope !== 'undefined'
    && self instanceof ServiceWorkerGlobalScope;

if (IS_SERVICE_WORKER) {
    importScripts(
        'ps/schema.js',
        'ps/db.js',
        'ps/opfs.js',
        'ps/http.js',
        'ps/notify.js',
        'ps/library.js',
        'ps/playback.js',
        'ps/plugin.js',
        'ps/router.js'
    );
}

const APP_CACHE = 'phantom-app-v2';

if (IS_SERVICE_WORKER) {
    self.addEventListener('install', (event) => {
        event.waitUntil(self.skipWaiting());
    });

    self.addEventListener('activate', (event) => {
        event.waitUntil((async () => {
            for (const name of await caches.keys()) {
                if (name.startsWith('phantom-app-') && name !== APP_CACHE) await caches.delete(name);
            }
            await self.clients.claim();
        })());
    });

    // --- app shell -----------------------------------------------------------

    const isNavigation = (request, url) =>
        request.mode === 'navigate'
        || url.pathname === '/web/'
        || url.pathname === '/web/index.html';

    /**
     * Files the overlay owns, as opposed to jellyfin-web's build output.
     *
     * The distinction that matters is not whose file it is but whether the URL
     * pins the content: jellyfin-web's bundles carry a content hash, so a cached
     * copy can never be stale. Ours do not, so cache-first serves last session's
     * module forever — which shows up as an import failing for an export that is
     * plainly there in the file on disk.
     */
    const isOverlayAsset = (pathname) =>
        pathname.startsWith('/web/ps/')
        || pathname.startsWith('/web/plugin/')
        || pathname === '/web/ps-bootstrap.js'
        || pathname === '/web/serviceworker.js'
        || pathname === '/web/config.json'
        || pathname === '/web/diag.html';

    async function appShell(request, url) {
        const cache = await caches.open(APP_CACHE);
        const key = new Request(url.pathname, { method: 'GET' });

        if (isNavigation(request, url)) {
            // Network first, so an updated build lands without clearing storage;
            // the cached copy is what makes the app open with no network at all.
            // The host serves index.html with the bootstrap tags already in it, so
            // there is nothing to rewrite here.
            try {
                const fresh = await fetch('/web/index.html', { cache: 'no-store' });
                if (fresh.ok) {
                    await cache.put(key, fresh.clone());
                    return fresh;
                }
            } catch {
                // offline; fall through to whatever we hold
            }
            const cached = await cache.match(key);
            if (cached) return cached;
            return new Response('offline and no cached app shell', { status: 503 });
        }

        if (isOverlayAsset(url.pathname)) {
            // Network first, cache only as the offline fallback.
            try {
                const fresh = await fetch(request, { cache: 'no-store' });
                if (fresh.ok && fresh.type === 'basic') await cache.put(key, fresh.clone());
                return fresh;
            } catch {
                const cached = await cache.match(key);
                if (cached) return cached;
                return new Response('offline: ' + url.pathname, { status: 503 });
            }
        }

        const cached = await cache.match(key);
        if (cached) return cached;

        try {
            const fresh = await fetch(request);
            // Opaque and error responses are not worth holding: a cached 404 outlives
            // whatever made the file briefly unavailable.
            if (fresh.ok && fresh.type === 'basic') await cache.put(key, fresh.clone());
            return fresh;
        } catch (err) {
            return new Response('offline: ' + url.pathname, { status: 503 });
        }
    }

    // --- dispatch ------------------------------------------------------------

    self.addEventListener('fetch', (event) => {
        const request = event.request;
        const url = new URL(request.url);

        // Everything cross-origin belongs to somebody else, and one of those somebodies
        // is the downloader fetching from the user's real servers. Touching it here
        // would break the thing that feeds us.
        if (url.origin !== self.location.origin) return;

        if (!self.PS_ROUTER.handles(url.pathname)) {
            event.respondWith(appShell(request, url));
            return;
        }

        event.respondWith(self.PS_ROUTER.dispatch(request, url));
    });

    // --- page bridge ---------------------------------------------------------

    self.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || !data.__phantom) return;

        if (data.kind === 'ping') {
            event.source.postMessage({ __phantom: true, kind: 'pong' });
            return;
        }
        if (data.kind === 'library-changed') {
            event.waitUntil(self.PS_NOTIFY.libraryChanged());
        }
    });
}

// --- jellyfin-web's own notification handling, unchanged -----------------

function getApiClient(serverId) {
    return Promise.resolve(window.connectionManager.getApiClient(serverId));
}

function executeAction(action, data, serverId) {
    return getApiClient(serverId).then(function (apiClient) {
        switch (action) {
            case 'cancel-install':
                return apiClient.cancelPackageInstallation(data.id);
            case 'restart':
                return apiClient.restartServer();
            default:
                clients.openWindow('/');
                return Promise.resolve();
        }
    });
}

self.addEventListener('notificationclick', function (event) {
    const notification = event.notification;
    notification.close();

    const data = notification.data;
    const serverId = data.serverId;
    const action = event.action;

    if (!action) {
        clients.openWindow('/');
        event.waitUntil(Promise.resolve());
        return;
    }

    event.waitUntil(executeAction(action, data, serverId));
}, false);
