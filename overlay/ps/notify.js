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

    async function libraryChanged() {
        await broadcast({
            MessageType: 'LibraryChanged',
            Data: { ItemsAdded: [], ItemsRemoved: [], ItemsUpdated: [], CollectionFolders: [] }
        });
    }

    g.PS_NOTIFY = { broadcast, userDataChanged, libraryChanged, precacheProgress };
})(self);
