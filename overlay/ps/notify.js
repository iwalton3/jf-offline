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
     * The parent is included alongside the item because jellyfin-web refreshes a
     * container's own indicators from this list, and an episode finishing should
     * update the series card it sits under.
     */
    async function userDataChanged(itemId, ud, dto) {
        const entry = {
            ItemId: itemId,
            Key: itemId,
            Played: !!ud.played,
            PlaybackPositionTicks: ud.positionTicks || 0,
            PlayCount: ud.playCount || 0,
            IsFavorite: !!ud.isFavorite,
            LastPlayedDate: ud.lastPlayedDate || undefined,
            PlayedPercentage: ud.positionTicks && dto && dto.RunTimeTicks
                ? Math.min(100, (ud.positionTicks / dto.RunTimeTicks) * 100)
                : undefined
        };
        const list = [entry];
        const parentId = dto && (dto.SeasonId || dto.SeriesId || dto.ParentId);
        if (parentId) list.push(Object.assign({}, entry, { ItemId: parentId, Key: parentId }));

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
