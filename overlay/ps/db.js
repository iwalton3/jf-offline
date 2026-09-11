/* Promise wrapper over the phantom server's IndexedDB.
 *
 * Classic script, loaded in both the service worker and the page. See ps/schema.js.
 */
(function (g) {
    'use strict';

    const S = g.PS_SCHEMA;
    let opening = null;

    function open() {
        if (opening) return opening;
        opening = new Promise((resolve, reject) => {
            const req = indexedDB.open(S.DB.NAME, S.DB.VERSION);
            req.onupgradeneeded = (ev) => {
                const db = req.result;
                // Additive only: a database this build touches must still open in the
                // build before it. Never drop or rewrite a store here.
                for (const [name, def] of Object.entries(S.DB.STORES)) {
                    const store = db.objectStoreNames.contains(name)
                        ? ev.target.transaction.objectStore(name)
                        : db.createObjectStore(name, {
                            keyPath: def.keyPath,
                            autoIncrement: !!def.autoIncrement
                        });
                    for (const [iname, idef] of Object.entries(def.indexes || {})) {
                        if (!store.indexNames.contains(iname)) store.createIndex(iname, idef.keyPath);
                    }
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('phantom db upgrade blocked by another tab'));
        });
        return opening;
    }

    const wrap = (req) => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

    async function tx(names, mode, fn) {
        const db = await open();
        const t = db.transaction(names, mode);
        const stores = Array.isArray(names)
            ? Object.fromEntries(names.map((n) => [n, t.objectStore(n)]))
            : t.objectStore(names);
        const result = await fn(stores, t);
        // Resolve on the transaction, not on the last request: a write that
        // succeeds in a transaction that later aborts has not happened.
        await new Promise((resolve, reject) => {
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error || new Error('transaction aborted'));
        });
        return result;
    }

    const get = (store, key) => tx(store, 'readonly', (s) => wrap(s.get(key)));
    const put = (store, value) => tx(store, 'readwrite', (s) => wrap(s.put(value)));
    const del = (store, key) => tx(store, 'readwrite', (s) => wrap(s.delete(key)));
    const all = (store) => tx(store, 'readonly', (s) => wrap(s.getAll()));

    const allByIndex = (store, index, query) =>
        tx(store, 'readonly', (s) => wrap(s.index(index).getAll(query)));

    async function putMany(store, values) {
        return tx(store, 'readwrite', async (s) => {
            for (const v of values) await wrap(s.put(v));
            return values.length;
        });
    }

    // --- typed helpers ----------------------------------------------------

    const meta = {
        get: async (name, fallback) => {
            const row = await get('meta', name);
            return row ? row.value : fallback;
        },
        set: (name, value) => put('meta', { name, value })
    };

    async function getUserData(srv, itemId) {
        return (await get('userdata', [srv, itemId])) || null;
    }

    /** Merge user data into a DTO copy. Never mutates the stored item. */
    function mergeUserData(dto, ud) {
        const out = Object.assign({}, dto);
        out.UserData = Object.assign({}, dto.UserData, ud ? {
            Played: !!ud.played,
            PlaybackPositionTicks: ud.positionTicks || 0,
            PlayCount: ud.playCount || 0,
            LastPlayedDate: ud.lastPlayedDate || undefined,
            IsFavorite: !!ud.isFavorite,
            PlayedPercentage: ud.positionTicks && dto.RunTimeTicks
                ? Math.min(100, (ud.positionTicks / dto.RunTimeTicks) * 100)
                : undefined
        } : {});
        return out;
    }

    /** Append an outbound operation. Nothing drains this in v0, by design. */
    function journal(op, srv, itemId, payload) {
        return put('journal', {
            op, srv, itemId, payload,
            createdAt: Date.now(),
            sentAt: null
        });
    }

    g.PS_DB = { open, tx, wrap, get, put, del, all, allByIndex, putMany, meta, getUserData, mergeUserData, journal };
})(self);
