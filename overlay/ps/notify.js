/* Pushes server messages into running pages.
 *
 * A service worker cannot intercept a WebSocket — no hook exists — so the phantom
 * server has no socket to send on. ps-bootstrap.js replaces window.WebSocket in
 * the page with a stand-in that reports itself open and takes its messages from
 * here, which both stops the SDK's reconnect loop and gives us the push channel
 * the real server would have had.
 *
 * Service worker only.
 */
(function (g) {
    'use strict';

    const S = g.PS_SCHEMA;

    async function broadcast(message) {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clients) {
            client.postMessage({ __phantom: true, kind: 'socket', message });
        }
    }

    /**
     * Announce changed user data the way a real server does.
     *
     * The entries come from the library rather than being built here, so a card
     * refreshed by this push and the same card refreshed by a fetch cannot
     * disagree. What a parent entry may contain was measured against a real
     * 12.0.0 with tools/userdata-probe.py and is written up in SCOPE.md; the
     * one deliberate divergence is that the real server pushes a single
     * ancestor and this pushes every one it holds, because the phantom has no
     * other way to refresh a Series card and jellyfin-web applies each entry to
     * the card whose data-id matches it.
     */
    async function userDataChanged(itemId, dto) {
        const list = await g.PS_LIBRARY.userDataEntries(
            [itemId, dto && dto.SeasonId, dto && dto.SeriesId, dto && dto.ParentId]);
        if (!list.length) return;

        await broadcast({
            MessageType: 'UserDataChanged',
            Data: { UserId: S.ID.USER, ServerId: S.ID.SERVER, UserDataList: list }
        });
    }

    /** Progress of the offline app-shell precache, for the settings page. */
    async function precacheProgress(status) {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clients) {
            client.postMessage({ __phantom: true, kind: 'precache-progress', status });
        }
    }

    /**
     * Announce a download or a removal, as `{ added, removed }` lists of `{ id, type }`.
     *
     * jellyfin-web drops a LibraryChanged whose ItemsAdded and ItemsRemoved are
     * both empty, and a grid bound to a library refreshes only when one of the
     * folder lists names it. The push alone cannot refresh the home page — see
     * invalidateAppQueries in ps-bootstrap.js — but its shape should still be
     * the server's. ItemsAdded is fetched by the app's new-item notification, so
     * `/Items` has to honour `ids` for this to announce the right thing.
     */
    async function libraryChanged(change) {
        const added = (change && change.added) || [];
        const removed = (change && change.removed) || [];
        const libraryOf = (entry) => entry.type === 'Movie' ? S.ID.VIEW_MOVIES : S.ID.VIEW_SHOWS;
        const addedTo = [...new Set(added.map(libraryOf))];
        const removedFrom = [...new Set(removed.map(libraryOf))];
        await broadcast({
            MessageType: 'LibraryChanged',
            Data: {
                FoldersAddedTo: addedTo,
                FoldersRemovedFrom: removedFrom,
                ItemsAdded: added.map((e) => e.id),
                ItemsRemoved: removed.map((e) => e.id),
                ItemsUpdated: [],
                CollectionFolders: [...new Set(addedTo.concat(removedFrom))],
                IsEmpty: !added.length && !removed.length
            }
        });
    }

    g.PS_NOTIFY = { broadcast, userDataChanged, libraryChanged, precacheProgress };
})(self);
