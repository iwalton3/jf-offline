/* Page-context bootstrap, injected into index.html by the service worker.
 *
 * Runs before jellyfin-web's bundle. Two jobs:
 *
 *  1. Stand in for the WebSocket the phantom server cannot provide. A service
 *     worker cannot intercept a socket — there is no hook — and jellyfin-web will
 *     definitely try to open one: every item grid subscribes to UserDataChanged
 *     when it mounts (emby-itemscontainer.js:294). Left alone the SDK reconnects
 *     forever on exponential backoff (websocket-service.js:92). Standing in stops
 *     that and, more usefully, gives the phantom server a push channel, which is
 *     how a play state write reaches an open grid without a reload.
 *
 *  2. Expose the storage layer to the plugin UI, so the downloader and the worker
 *     share one schema rather than two copies of it.
 */
(function (g) {
    'use strict';

    /* Captured before jellyfin-web's bundle runs, which is the only moment they
     * are still the browser's own. jellyfin-web loads the 2015 v0 webcomponents
     * polyfill for its emby-* elements, and that replaces document.createElement
     * with one whose elements the native custom-element registry never upgrades.
     * See overlay/plugin/vdx-native-dom.js for what needs them back. */
    const nativeDom = {
        createElement: g.document.createElement,
        importNode: g.document.importNode
    };

    const NativeWebSocket = g.WebSocket;
    const live = new Set();
    let lastLibraryChange = 0;

    const isPhantomSocket = (url) => {
        try {
            const u = new URL(String(url), g.location.href);
            return u.host === g.location.host && /\/socket$/i.test(u.pathname.replace(/\/+$/, ''));
        } catch {
            return false;
        }
    };

    class PhantomSocket extends EventTarget {
        constructor(url, protocols) {
            super();
            this.url = String(url);
            this.protocol = Array.isArray(protocols) ? protocols[0] : (protocols || '');
            this.extensions = '';
            this.binaryType = 'blob';
            this.bufferedAmount = 0;
            this.readyState = PhantomSocket.CONNECTING;
            this.onopen = null;
            this.onmessage = null;
            this.onerror = null;
            this.onclose = null;

            live.add(this);
            // Asynchronous so a caller that assigns onopen straight after
            // construction still sees the event, as it would with a real socket.
            setTimeout(() => {
                if (this.readyState !== PhantomSocket.CONNECTING) return;
                this.readyState = PhantomSocket.OPEN;
                this._emit(new Event('open'), 'onopen');
            }, 0);
        }

        _emit(event, handlerName) {
            if (typeof this[handlerName] === 'function') {
                try { this[handlerName](event); } catch (err) { console.error('[phantom socket]', err); }
            }
            this.dispatchEvent(event);
        }

        deliver(message) {
            if (this.readyState !== PhantomSocket.OPEN) return;
            this._emit(new MessageEvent('message', { data: JSON.stringify(message) }), 'onmessage');
        }

        // Subscription start/stop messages have nowhere to go: the phantom server
        // pushes what it has when it has it, and never on an interval.
        send() {}

        close(code, reason) {
            if (this.readyState === PhantomSocket.CLOSED) return;
            this.readyState = PhantomSocket.CLOSED;
            live.delete(this);
            this._emit(new CloseEvent('close', { code: code || 1000, reason: reason || '', wasClean: true }), 'onclose');
        }
    }

    PhantomSocket.CONNECTING = 0;
    PhantomSocket.OPEN = 1;
    PhantomSocket.CLOSING = 2;
    PhantomSocket.CLOSED = 3;

    /**
     * Replace the constructor, not the prototype.
     *
     * A real server may still be connected in the same app (multiserver mode is
     * how the downloader reaches the user's libraries), and its socket has to keep
     * working, so anything not addressed to us is handed straight to the native
     * implementation.
     */
    function WebSocketShim(url, protocols) {
        if (!isPhantomSocket(url)) return new NativeWebSocket(url, protocols);
        return new PhantomSocket(url, protocols);
    }

    WebSocketShim.prototype = NativeWebSocket.prototype;
    WebSocketShim.CONNECTING = 0;
    WebSocketShim.OPEN = 1;
    WebSocketShim.CLOSING = 2;
    WebSocketShim.CLOSED = 3;
    g.WebSocket = WebSocketShim;

    /**
     * Mark the phantom user's entries in jellyfin-web's query cache stale, or the
     * home page draws the old library for up to a minute after a download or a
     * removal. No server message reaches those keys (CLAUDE.md, "The home page is
     * drawn from jellyfin-web's query cache"), so the client is taken from the
     * `client` prop of the provider at the top of #reactRoot. That is React's
     * internals rather than a seam, which is why not finding it only logs.
     */
    function invalidateAppQueries() {
        try {
            const root = g.document.getElementById('reactRoot');
            const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
            const stack = key ? [root[key]] : [];
            for (let seen = 0; stack.length && seen < 200; seen++) {
                const fiber = stack.pop();
                const client = fiber.memoizedProps && fiber.memoizedProps.client;
                if (client && typeof client.invalidateQueries === 'function') {
                    // Stale rather than removed, so a grid on screen keeps its
                    // cards until the refetch replaces them.
                    Promise.resolve(client.invalidateQueries({ queryKey: ['User', g.PS_SCHEMA.ID.USER] }))
                        .catch((err) => console.warn('[phantom] refetch after a library change failed', err));
                    return;
                }
                if (fiber.sibling) stack.push(fiber.sibling);
                if (fiber.child) stack.push(fiber.child);
            }
            console.warn('[phantom] jellyfin-web\'s query cache was not found;'
                + ' the home page may show the old library for up to a minute');
        } catch (err) {
            console.warn('[phantom] could not mark jellyfin-web\'s query cache stale', err);
        }
    }

    if (g.navigator.serviceWorker) {
        g.navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || !data.__phantom || data.kind !== 'socket') return;
            // Whether or not a socket is open: the tab may be browsing a real
            // server, and its cache still holds the phantom's home page.
            if (data.message && data.message.MessageType === 'LibraryChanged') invalidateAppQueries();
            for (const socket of live) socket.deliver(data.message);
        });
    }

    // --- bridge for the plugin UI ----------------------------------------

    async function tellWorker(kind, payload) {
        const reg = await g.navigator.serviceWorker.ready;
        const target = reg.active || g.navigator.serviceWorker.controller;
        if (target) target.postMessage(Object.assign({ __phantom: true, kind }, payload));
    }

    // Offline app shell. The worker does the work; this keeps poking it, because a
    // worker part-way through two thousand fetches will be killed and only wakes
    // again when something sends it an event.
    const precache = { done: 0, total: 0, version: null, ready: false, listeners: new Set() };
    const update = { waiting: false, listeners: new Set() };

    const announce = () => {
        for (const fn of precache.listeners) {
            try { fn(precache); } catch (err) { console.error('[phantom]', err); }
        }
    };

    if (g.navigator.serviceWorker) {
        g.navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || !data.__phantom) return;
            if (data.kind !== 'precache-progress' && data.kind !== 'precache-status') return;
            Object.assign(precache, data.status);
            announce();
        });
    }

    const poke = () => {
        // Kept poking until the swap, not merely until the fetching stops: the
        // cache being full is not the same as it being the one in use.
        if (precache.ready) return;
        tellWorker('precache');
    };

    /**
     * Take an update on the next load, rather than whenever every tab happens to
     * close.
     *
     * A service worker update installs and then WAITS. Measured against Chrome
     * 121 with this app: changing a file the worker imports is detected and a new
     * worker installs, but skipWaiting() does NOT promote it — not from the
     * install handler and not from a message, even though the waiting worker
     * demonstrably receives messages and replies to them. What does promote it is
     * the next navigation, when the page being replaced leaves no clients behind.
     *
     * So the measured behaviour is: the load that finds the update installs it,
     * and the load after that runs it. That is one restart later than ideal, so
     * calling update() here matters — it makes the check happen on this load
     * instead of whenever the browser next feels like it, which is the difference
     * between "applies on the next start" and "applies eventually". The skip
     * request is kept because it costs nothing and other engines honour it, and
     * the waiting flag is surfaced so the settings page can say so out loud.
     */
    function adoptUpdates() {
        const sw = g.navigator.serviceWorker;
        if (!sw) return;

        const RELOAD_GUARD = 'phantom-reloaded-for-update';
        sw.addEventListener('controllerchange', () => {
            // Once per takeover. Without the guard a worker that keeps replacing
            // itself would reload the page forever.
            if (sessionStorage.getItem(RELOAD_GUARD)) return;
            try { sessionStorage.setItem(RELOAD_GUARD, '1'); } catch { /* private mode */ }
            g.location.reload();
        });

        sw.ready.then((reg) => {
            const nudge = () => {
                if (!reg.waiting) return false;
                reg.waiting.postMessage({ __phantom: true, kind: 'skip-waiting' });
                return true;
            };

            // Polled as well as event-driven. The update check is asynchronous and
            // `updatefound` can fire with `installing` already moved on, so relying
            // on the event alone left the new worker waiting until the load after
            // next — two restarts to pick up one change.
            let attempts = 0;
            const watch = setInterval(() => {
                if (reg.waiting && !update.waiting) {
                    update.waiting = true;
                    for (const fn of update.listeners) {
                        try { fn(update); } catch (err) { console.error('[phantom]', err); }
                    }
                }
                if (nudge() || ++attempts > 20) clearInterval(watch);
            }, 1000);

            reg.addEventListener('updatefound', () => {
                const installing = reg.installing;
                if (!installing) return;
                installing.addEventListener('statechange', () => {
                    if (installing.state === 'installed') nudge();
                });
            });

            // The browser checks on navigation anyway; asking explicitly makes the
            // check happen even in a tab that has been open for days.
            reg.update().catch(() => {});
        }).catch(() => {});
    }

    g.addEventListener('load', () => {
        adoptUpdates();
        tellWorker('precache-status');
        poke();
        setInterval(poke, 15000);
    });

    g.__phantom = {
        nativeDom,
        schema: g.PS_SCHEMA,
        db: g.PS_DB,
        opfs: g.PS_OPFS,
        socketsOpen: () => live.size,
        // `change` crosses postMessage, so it must be plain: a vdx Proxy does not clone.
        libraryChanged: (change) => {
            lastLibraryChange = Date.now();
            return tellWorker('library-changed', { change });
        },
        // Read by ps-ui.js to decide whether closing the manager reloads the page.
        lastLibraryChange: () => lastLibraryChange,
        precache,
        onPrecache: (fn) => {
            precache.listeners.add(fn);
            fn(precache);
            return () => precache.listeners.delete(fn);
        },
        refreshPrecache: () => tellWorker('precache-status'),
        update,
        onUpdate: (fn) => {
            update.listeners.add(fn);
            fn(update);
            return () => update.listeners.delete(fn);
        }
    };
})(window);
