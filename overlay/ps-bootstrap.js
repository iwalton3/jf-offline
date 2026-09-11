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

    if (g.navigator.serviceWorker) {
        g.navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || !data.__phantom || data.kind !== 'socket') return;
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
    const precache = { done: 0, total: 0, version: null, listeners: new Set() };

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
        if (precache.total && precache.done >= precache.total) return;
        tellWorker('precache');
    };

    g.addEventListener('load', () => {
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
        libraryChanged: () => tellWorker('library-changed'),
        precache,
        onPrecache: (fn) => {
            precache.listeners.add(fn);
            fn(precache);
            return () => precache.listeners.delete(fn);
        },
        refreshPrecache: () => tellWorker('precache-status')
    };
})(window);
