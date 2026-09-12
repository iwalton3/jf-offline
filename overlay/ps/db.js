/* Promise wrapper over the phantom server's IndexedDB.
 *
 * Classic script, loaded in both the service worker and the page. See ps/schema.js.
 */
(function (g) {
    'use strict';

    const S = g.PS_SCHEMA;

    // The two ways this build and the stored database can disagree about a
    // version, and the only sentences anybody shows a person about either. One
    // table, because three surfaces observe this failure -- a navigation, a
    // request to the phantom server and the settings page -- and three surfaces
    // inventing their own wording is three chances to describe it wrongly.
    //
    // Neither arm is legible in IndexedDB's own terms: `blocked` carries no
    // message at all, and a VersionError says "The requested version (2) is less
    // than the existing version (3)", which names numbers the person has never
    // seen and no action they can take.
    const UNOPENABLE = {
        blocked: 'Another tab is still running the previous version of this app, '
            + 'and it is holding the downloads open. Close the other tabs and reload.',
        obsolete: 'This tab is running an older version of the app than the one '
            + 'that stored your downloads. Reload to pick it up.'
    };

    const fault = (kind, cause) => Object.assign(new Error(UNOPENABLE[kind]),
        { unopenable: kind, cause });

    /** Which disagreement an error is, or null when it is some other failure. */
    const unopenable = (err) => (err && err.unopenable) || null;

    // Memoised, but a failure is forgotten rather than cached. A denied storage
    // permission or a blocked upgrade used to poison every later call for the
    // lifetime of the worker, and the worker answers navigations from this.
    const open = S.once(() => new Promise((resolve, reject) => {
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
        req.onsuccess = () => {
            // Let go when someone else needs to upgrade. Without this a tab
            // running the previous build holds the old version open and the new
            // build's open() never completes — it does not fail, it waits, so
            // the app simply never finishes starting and nothing says why.
            //
            // The memo is forgotten alongside the close, because `once` caches a
            // SUCCESS: leaving it would hand the closed database to every later
            // transaction in this context. Reopening after a real bump is a
            // VersionError for a build pinned at the old version, which is that
            // build being obsolete rather than this going wrong.
            req.result.onversionchange = () => {
                req.result.close();
                open.forget();
            };
            resolve(req.result);
        };
        req.onerror = () => reject(req.error && req.error.name === 'VersionError'
            ? fault('obsolete', req.error) : req.error);
        req.onblocked = () => reject(fault('blocked'));
    }));

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

    /** Append an outbound operation. Nothing drains this in v0, by design. */
    function journal(op, srv, itemId, payload) {
        return put('journal', {
            op, srv, itemId, payload,
            createdAt: Date.now(),
            sentAt: null
        });
    }

    g.PS_DB = { open, unopenable, tx, wrap, get, put, del, all, allByIndex, putMany, meta, getUserData, journal };
})(self);
