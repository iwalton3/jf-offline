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

/* Caches are named for the manifest version they hold, and the *active* name is
 * a stored pointer rather than a constant.
 *
 * The previous version deleted the live cache and refilled it, which left a
 * window of tens of seconds during which the app had nothing cached — an app
 * that intermittently stopped working, and always right after an update. Writes
 * issued during that window went into a deleted cache and vanished.
 *
 * So: fill the new cache completely, swap the pointer, and only then drop the
 * old one. A reader is always looking at a cache that is whole.
 */
const CACHE_PREFIX = 'phantom-app-';
// Used until the first precache completes, so a first visit still caches.
const BOOTSTRAP_CACHE = CACHE_PREFIX + 'runtime';

if (IS_SERVICE_WORKER) {
    self.addEventListener('install', (event) => {
        event.waitUntil(self.skipWaiting());
    });

    /** The cache the app is currently served from. */
    async function activeCacheName() {
        const version = await self.PS_DB.meta.get('precacheVersion', null);
        return version ? CACHE_PREFIX + version : BOOTSTRAP_CACHE;
    }

    const activeCache = async () => caches.open(await activeCacheName());

    self.addEventListener('activate', (event) => {
        // Nothing is deleted here. A new worker version says nothing about whether
        // the assets it holds are stale, and dropping them on activation is exactly
        // the window this design exists to remove.
        event.waitUntil(self.clients.claim());
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
        const cache = await activeCache();
        // Navigations are keyed on the document itself, which is the name the
        // manifest uses, so a precached cache already holds the entry a
        // navigation will look for.
        const key = isNavigation(request, url) ? '/web/index.html' : url.pathname;

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

    // --- offline app shell ---------------------------------------------------

    let precacheRun = null;

    /**
     * Hold the whole app, not just the parts that have been used.
     *
     * jellyfin-web is two thousand lazily-loaded chunks, so caching on demand
     * leaves every route the user has not visited yet broken in airplane mode,
     * and there is no way to know in advance which routes those are.
     *
     * Resumable on purpose: a worker doing two thousand fetches will be killed
     * part-way, so each file is skipped if the cache already holds it and the run
     * simply picks up where it stopped when something wakes the worker again.
     * ps-bootstrap.js pokes it while a page is open, which is what keeps it alive.
     */
    async function precacheAppShell() {
        if (precacheRun) return precacheRun;
        precacheRun = (async () => {
            const manifest = await (await fetch('/web/precache-manifest.json', { cache: 'no-store' })).json();
            const target = CACHE_PREFIX + manifest.version;
            const currentName = await activeCacheName();
            const fresh = await caches.open(target);

            // Carry over what the previous cache already holds, but only for URLs
            // that pin their content with a hash. jellyfin-web's bundles do, so a
            // rebuild copies almost everything instead of re-downloading 55 MB;
            // the overlay's files do not, so they are always fetched again.
            if (currentName !== target) {
                const previous = await caches.open(currentName);
                for (const url of manifest.files) {
                    const path = new URL(url, self.location.origin).pathname;
                    if (isOverlayAsset(path) || path === '/web/index.html') continue;
                    if (await fresh.match(url)) continue;
                    const hit = await previous.match(url);
                    if (hit) await fresh.put(url, hit);
                }
            }

            const pending = [];
            for (const url of manifest.files) {
                if (!(await fresh.match(url))) pending.push(url);
            }

            let done = manifest.files.length - pending.length;
            const total = manifest.files.length;
            const report = () => self.PS_NOTIFY.precacheProgress({ done, total, version: manifest.version });
            report();

            // Small concurrency: enough to keep the connection busy, not so much
            // that the precache competes with whatever the user is doing.
            const CONCURRENCY = 6;
            let cursor = 0;
            const worker = async () => {
                for (;;) {
                    const index = cursor++;
                    if (index >= pending.length) return;
                    const url = pending[index];
                    try {
                        const res = await fetch(url, { cache: 'no-store' });
                        if (res.ok) await fresh.put(url, res);
                    } catch {
                        // One unreachable file must not abandon the other 2399.
                    }
                    done++;
                    if (done % 25 === 0) report();
                }
            };
            await Promise.all(Array.from({ length: CONCURRENCY }, worker));

            // The swap. Everything above wrote into a cache nobody was reading;
            // this one line is what makes it live, and it happens only once the
            // cache is complete.
            await self.PS_DB.meta.set('precacheVersion', manifest.version);

            for (const name of await caches.keys()) {
                if (name.startsWith(CACHE_PREFIX) && name !== target) await caches.delete(name);
            }

            report();
            return { done, total, version: manifest.version };
        })().finally(() => { precacheRun = null; });
        return precacheRun;
    }

    async function precacheStatus() {
        const manifest = await (await fetch('/web/precache-manifest.json', { cache: 'no-store' }))
            .json().catch(() => null);
        if (!manifest) {
            // Offline: report what the live cache holds rather than nothing, so the
            // settings page does not claim the app is unheld while it is serving it.
            const held = await (await activeCache()).keys();
            return { done: held.length, total: held.length, offline: true };
        }
        const building = await caches.open(CACHE_PREFIX + manifest.version);
        const keys = await building.keys();
        return { done: keys.length, total: manifest.files.length, version: manifest.version };
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
            return;
        }
        if (data.kind === 'precache') {
            // waitUntil keeps the worker alive for the duration of this slice.
            event.waitUntil(precacheAppShell());
            return;
        }
        if (data.kind === 'precache-status') {
            event.waitUntil(precacheStatus().then((status) =>
                event.source.postMessage({ __phantom: true, kind: 'precache-status', status })));
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
