/* Identity, storage layout and shared constants for the phantom Jellyfin server.
 *
 * Loaded as a classic script in BOTH contexts: importScripts() in the service
 * worker, and a <script> tag the worker injects into index.html for the page.
 * `self` is the global in both, which is the whole reason this file is plain
 * script rather than a module — the worker jellyfin-web registers is classic
 * (src/index.jsx calls register() with no type), so it cannot import modules.
 */
(function (g) {
    'use strict';

    // Jellyfin ids are 32 hex characters and jellyfin-web will happily round-trip
    // anything of that shape. These are ours; nothing on a real server can collide
    // with them because no real server mints ids beginning 0ff11e.
    const ID = {
        SERVER: '0ff11e0000000000000000000000ffff',
        USER: '0ff11e0000000000000000000000a010',
        VIEW_MOVIES: '0ff11e0000000000000000000000a001',
        VIEW_SHOWS: '0ff11e0000000000000000000000a002'
    };

    const VIEWS = [
        { Id: ID.VIEW_MOVIES, Name: 'Movies', CollectionType: 'movies', itemTypes: ['Movie'] },
        { Id: ID.VIEW_SHOWS, Name: 'Shows', CollectionType: 'tvshows', itemTypes: ['Series'] }
    ];

    const DB = {
        NAME: 'phantom',
        // 2 added by_id on items and by_item_id on downloads. Both are lookups
        // the worker does on the hot path — once per poster in a grid, once per
        // HLS segment during playback — and without them each one was a full
        // scan of every stored item.
        VERSION: 2,
        // Every store is keyed by an explicit key path so a row can be written from
        // either context without the caller having to remember the key shape.
        STORES: {
            meta: { keyPath: 'name' },
            servers: { keyPath: 'id' },
            items: {
                keyPath: ['srv', 'id'],
                indexes: {
                    // Not unique: the same item id can be held from two servers.
                    by_id: { keyPath: 'id' },
                    by_type: { keyPath: 'type' },
                    by_series: { keyPath: 'seriesId' },
                    by_season: { keyPath: 'seasonId' },
                    by_added: { keyPath: 'addedAt' }
                }
            },
            // Keyed by media source as well as item, so a second version of the same
            // item can be held later without a migration.
            downloads: {
                keyPath: ['srv', 'itemId', 'sourceId'],
                indexes: {
                    by_item: { keyPath: ['srv', 'itemId'] },
                    // By item alone, for the lookups that arrive from jellyfin-web
                    // knowing only an item id.
                    by_item_id: { keyPath: 'itemId' },
                    by_state: { keyPath: 'state' }
                }
            },
            userdata: { keyPath: ['srv', 'itemId'] },
            // Written from v0 and never drained. Syncback is then a drain loop
            // rather than a migration over history nobody recorded.
            journal: { keyPath: 'seq', autoIncrement: true }
        }
    };

    const DOWNLOAD_STATE = {
        QUEUED: 'queued',
        RUNNING: 'running',
        COMPLETE: 'complete',
        ERROR: 'error',
        CANCELLED: 'cancelled'
    };

    /**
     * Transcode quality, chosen at sync time.
     *
     * Defaults to 720p rather than source: a download asks somebody else's server
     * to transcode, often several episodes back to back, and the person pressing
     * the button is not the person whose CPU pays for it.
     */
    const QUALITIES = [
        { id: 'original', label: 'Source quality', maxHeight: null, bitrate: null },
        { id: '1080p', label: '1080p', maxHeight: 1080, bitrate: 8000000 },
        { id: '720p', label: '720p', maxHeight: 720, bitrate: 3000000 },
        { id: '480p', label: '480p', maxHeight: 480, bitrate: 1500000 }
    ];
    const DEFAULT_QUALITY = '720p';

    // 'direct' stores the source file untouched; 'hls' stores a downloaded VOD
    // transcode as playlist plus segments.
    const DOWNLOAD_MODE = { DIRECT: 'direct', HLS: 'hls' };

    /**
     * What to do about subtitles, decided at sync time because it cannot be
     * revisited afterwards.
     *
     * 'auto' extracts every text track as a sidecar the player can switch between.
     * Image-based tracks (PGS, VobSub, DVB) have no text to extract, so the only
     * way to see them offline is to burn one into the picture, which fixes the
     * choice of track and forces a transcode. That is a decision only the person
     * downloading can make.
     */
    const SUBTITLE_MODE = { AUTO: 'auto', BURN: 'burn', NONE: 'none' };

    // Which writer last set played state. v0 has one consumer (nothing), but the
    // distinction has to exist before rows are written: playback progress is a
    // floor that may only advance, while an explicit mark is authoritative both
    // ways, and syncback cannot tell them apart after the fact.
    const SET_BY = { PLAYBACK: 'playback', EXPLICIT: 'explicit' };

    const TICKS_PER_MS = 10000;

    // OPFS lives under one root so a wipe is one removeEntry call.
    const OPFS_ROOT = 'phantom';

    /**
     * The path this deployment is mounted at, '' at an origin root.
     *
     * GitHub Pages gives a project site a subdirectory rather than a host, so the
     * app lands at /jf-offline/web/ and the phantom server has to answer
     * /jf-offline/Items. Derived rather than configured, and from a different
     * source in each context: the worker knows its own registration scope, and
     * the page knows where it was served from.
     */
    function basePath() {
        try {
            const path = (self.registration && self.registration.scope)
                ? new URL(self.registration.scope).pathname
                : self.location.pathname;
            const at = path.indexOf('/web/');
            if (at > 0) return path.slice(0, at);
        } catch {
            // Fall through to the root, which is right for the dev host.
        }
        return '';
    }

    /**
     * Memoise an async call, but never memoise its rejection.
     *
     * `if (!cached) cached = somethingAsync()` is the obvious shape and it is a
     * trap: one transient failure is cached for the lifetime of the page or the
     * worker, and every later caller is handed an error about a network that has
     * since come back. Three places wanted this — the IndexedDB handle, a source
     * server's permission policy, and the manager module the modal imports — and
     * in all three a single blip became a permanent fault with no way back but a
     * reload. A success is cached; a failure is forgotten so the next caller
     * tries again.
     */
    function once(fn) {
        let pending = null;
        return function (...args) {
            if (!pending) {
                pending = Promise.resolve().then(() => fn.apply(this, args));
                // Clears the memo without swallowing the rejection: callers still
                // see it, because they hold `pending` itself and not this branch.
                pending.catch(() => { pending = null; });
            }
            return pending;
        };
    }

    const paths = {
        mediaDir: (srv, itemId, sourceId) => ['media', srv, itemId, sourceId],
        original: (srv, itemId, sourceId, container) =>
            ['media', srv, itemId, sourceId, 'original.' + (container || 'bin')],
        hlsPlaylist: (srv, itemId, sourceId) => ['media', srv, itemId, sourceId, 'hls', 'main.m3u8'],
        hlsSegment: (srv, itemId, sourceId, n) => ['media', srv, itemId, sourceId, 'hls', n + '.ts'],
        // The type is lower-cased here rather than by the callers, because the
        // router matches on a lower-cased path (see ps/router.js) and therefore
        // hands handlers a lower-cased capture, while the downloader writes with
        // Jellyfin's own capitalisation. Two spellings of the same file is a 404
        // on every image with no error anywhere to say so.
        // The extension is the subtitle's real format, not always vtt: ASS and SSA
        // are kept as themselves so jellyfin-web can hand them to libass with their
        // styling intact. Converting them to WebVTT throws away exactly the
        // positioning and typesetting that makes them worth having.
        subtitle: (srv, itemId, sourceId, index, format) =>
            ['media', srv, itemId, sourceId, 'subs', index + '.' + (format || 'vtt')],
        attachment: (srv, itemId, sourceId, index) =>
            ['media', srv, itemId, sourceId, 'attachments', String(index)],
        trickplayDir: (srv, itemId, sourceId, width) =>
            ['media', srv, itemId, sourceId, 'trickplay', String(width)],
        trickplayTile: (srv, itemId, sourceId, width, index) =>
            ['media', srv, itemId, sourceId, 'trickplay', String(width), index + '.jpg'],
        // Images hang off the item, not off a media source: a multi-version item
        // has one poster. Which is why imageDir exists — removing a download
        // removes its media directory, and without a directory of its own the
        // artwork would be stranded in a tree nothing walks.
        imageDir: (srv, itemId) => ['images', srv, itemId],
        image: (srv, itemId, type) => ['images', srv, itemId, String(type).toLowerCase()]
    };

    g.PS_SCHEMA = {
        ID, VIEWS, DB, DOWNLOAD_STATE, DOWNLOAD_MODE, SUBTITLE_MODE, QUALITIES, DEFAULT_QUALITY,
        SET_BY, TICKS_PER_MS, OPFS_ROOT, paths, once, basePath: basePath()
    };
})(self);
