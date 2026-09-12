/* The phantom server's library: query engine plus the browse/detail handlers.
 *
 * The endpoint shapes implemented here were recorded off a real 12.0.0 server
 * with tools/probe-requests.js rather than read out of jellyfin-web, so the set
 * is what the home, browse and series/season screens actually ask for.
 *
 * Scope for v0 is those screens plus search. Filtering, genres, studios and
 * collections deliberately answer with well-formed empties: an empty result
 * renders, an error does not.
 */
(function (g) {
    'use strict';

    const S = g.PS_SCHEMA;
    const DB = g.PS_DB;
    const { json, emptyList, notFound, serveFile } = g.PS_HTTP;

    const VIEW_BY_ID = new Map(S.VIEWS.map((v) => [v.Id, v]));

    // --- reading ----------------------------------------------------------

    /**
     * Everything held, with the parents of nothing left out.
     *
     * An items row for a Movie or an Episode means that file is on disk — the row
     * is written when it downloads and deleted when it is removed. Series and
     * Season rows are different: they are written so an episode has something to
     * belong to, and they outlive their children. Left in, a show whose episodes
     * were all deleted keeps appearing in search, in Next Up and on the home
     * screen, and its page lists seasons that hold nothing.
     *
     * Derived here rather than pruned on delete, so it is right however the rows
     * went away — a failed download, a cancelled one, a season filter that took
     * nothing — instead of only on the path somebody remembered to clean up.
     */
    async function loadAll() {
        const [all, ud, downloads] = await Promise.all([
            DB.all('items'), DB.all('userdata'), DB.all('downloads')
        ]);
        const udMap = new Map(ud.map((u) => [u.srv + ':' + u.itemId, u]));
        const dlMap = new Map(downloads.map((d) => [d.srv + ':' + d.itemId, d]));

        // Played is counted here beside the total, because a container's counts
        // and its user data are the same question asked twice and answering them
        // in two places is how the series card came to show a count from the
        // source server over the episodes actually on disk.
        const heldCount = new Map();
        const playedCount = new Map();
        const bump = (map, id) => { if (id) map.set(id, (map.get(id) || 0) + 1); };
        for (const row of all) {
            if (row.dto.Type !== 'Episode') continue;
            bump(heldCount, row.dto.SeasonId);
            bump(heldCount, row.dto.SeriesId);
            const ud = udMap.get(row.srv + ':' + row.id);
            if (ud && ud.played) {
                bump(playedCount, row.dto.SeasonId);
                bump(playedCount, row.dto.SeriesId);
            }
        }

        const rows = all.filter((row) => {
            const type = row.dto.Type;
            if (type !== 'Series' && type !== 'Season') return true;
            return (heldCount.get(row.id) || 0) > 0;
        });
        for (const row of rows) {
            // Hung on the row rather than threaded through present(), which has
            // thirteen call sites; `held` above arrived the same way.
            row.download = dlMap.get(row.srv + ':' + row.id) || null;
            if (!heldCount.has(row.id)) continue;
            row.held = { total: heldCount.get(row.id), played: playedCount.get(row.id) || 0 };
        }

        return { rows, udMap };
    }

    /**
     * The user data for one held item, as jellyfin-web should see it.
     *
     * ONE definition, and the reason is that there were three: the REST read
     * merged the source server's object, the socket push built its own, and the
     * mark-played response built a third. They disagreed in both directions —
     * the push gave a series the episode's Played flag and date, and the read
     * gave the same series the source's UnplayedItemCount over the episodes
     * actually held.
     *
     * `held` is present for a container and absent for a file. Measured against
     * a real 12.0.0 with tools/userdata-probe.py: a container's entry carries
     * counts over its own children and never a child's played flag, position,
     * play count or date. Nothing here is spread in from the stored DTO, because
     * that is where the source server's counts came in.
     */
    function userDataOf(dto, ud, held) {
        const entry = {
            ItemId: dto.Id,
            Key: dto.Id,
            Played: false,
            PlaybackPositionTicks: 0,
            PlayCount: 0,
            IsFavorite: !!(ud && ud.isFavorite)
        };
        if (held) {
            entry.Played = held.total > 0 && held.played === held.total;
            entry.UnplayedItemCount = held.total - held.played;
            entry.PlayedPercentage = held.total ? (held.played / held.total) * 100 : 0;
            return entry;
        }
        if (!ud) return entry;
        entry.Played = !!ud.played;
        entry.PlaybackPositionTicks = ud.positionTicks || 0;
        entry.PlayCount = ud.playCount || 0;
        entry.LastPlayedDate = ud.lastPlayedDate || undefined;
        entry.PlayedPercentage = ud.positionTicks && dto.RunTimeTicks
            ? Math.min(100, (ud.positionTicks / dto.RunTimeTicks) * 100)
            : undefined;
        return entry;
    }

    /**
     * User-data entries for these ids, skipping any this library does not hold.
     *
     * The socket push and the mark-played response both come through here, so
     * neither can describe an item differently from the way the same item reads
     * over REST.
     */
    async function userDataEntries(ids) {
        const { rows, udMap } = await loadAll();
        const byId = new Map(rows.map((row) => [row.id, row]));
        const out = [];
        const seen = new Set();
        for (const id of ids) {
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const row = byId.get(id);
            if (!row) continue;
            out.push(userDataOf(row.dto, udMap.get(row.srv + ':' + row.id), row.held));
        }
        return out;
    }

    /**
     * The parent this item hangs off inside the phantom library.
     *
     * Derived rather than stored: a downloaded item's real ParentId points at a
     * library folder on the source server that we deliberately do not mirror, so
     * the answer is a property of our own view structure and would only go stale
     * if it were written down.
     */
    function parentKeyOf(dto) {
        switch (dto.Type) {
            case 'Episode': return dto.SeasonId || dto.ParentId;
            case 'Season': return dto.SeriesId || dto.ParentId;
            case 'Movie': return S.ID.VIEW_MOVIES;
            case 'Series': return S.ID.VIEW_SHOWS;
            default: return dto.ParentId;
        }
    }

    /** A stored row as jellyfin-web should see it: our server, our parents, live user data. */
    function present(row, udMap) {
        const dto = Object.assign({}, row.dto);
        dto.UserData = userDataOf(row.dto, udMap.get(row.srv + ':' + row.id), row.held);
        dto.ServerId = S.ID.SERVER;
        dto.ParentId = parentKeyOf(row.dto);
        // Everything we hold is playable; the source server's own flags described a
        // file this browser may never have been able to play.
        dto.LocationType = 'FileSystem';

        // Counts describe what is here, not what the source server has. A show
        // page saying "24 episodes" over the three that were downloaded is a
        // worse answer than no number at all.
        if (row.held) {
            dto.ChildCount = row.held.total;
            dto.RecursiveItemCount = row.held.total;
        }

        // The versions and the tracks describe the copy, because they came off
        // the source server describing the file it has. jellyfin-web's detail
        // page builds a Version selector straight from this list and defaults to
        // its first entry, so a multi-version item downloaded here offered two
        // versions that are not on disk and pre-selected one of them
        // (itemDetails/index.js:197-230 in the read-only reference checkout).
        //
        // Substituted from the download row rather than pruned, and by the same
        // definition PlaybackInfo answers with, so the page and the player cannot
        // describe one file two ways. Removed outright for a Series or a Season:
        // there is no copy on disk for them to describe, and a real server sends
        // no MediaSources for a folder either.
        if (row.download) {
            const source = g.PS_PLAYBACK.mediaSourceFor(row.download, row.dto);
            dto.MediaSources = [source];
            dto.MediaStreams = source.MediaStreams;
        } else {
            delete dto.MediaSources;
            delete dto.MediaStreams;
        }
        return dto;
    }

    function viewDto(view, childCount) {
        return {
            Name: view.Name,
            Id: view.Id,
            ServerId: S.ID.SERVER,
            Type: 'CollectionFolder',
            CollectionType: view.CollectionType,
            IsFolder: true,
            ChildCount: childCount,
            UserData: { PlaybackPositionTicks: 0, PlayCount: 0, Played: false },
            ImageTags: {},
            BackdropImageTags: []
        };
    }

    // --- search -----------------------------------------------------------

    /**
     * Match and rank by name.
     *
     * Deliberately not the server's search: there is no index here and no
     * inverted lookup, and a held library is small enough that walking it is
     * cheaper than anything cleverer would be to maintain. Ranking is by where
     * the match falls, so typing a title's first word puts that title first
     * rather than burying it among episodes that merely mention it.
     */
    function rankSearch(dtos, term) {
        const needle = term.toLowerCase();
        // Hoisted: nothing in it depends on the item. Built once per search
        // instead of once per item, and both the hints and the results call this
        // on every keystroke over the whole held library.
        const atWordStart = new RegExp('\\b' + needle.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&'));
        const scored = [];
        for (const dto of dtos) {
            const name = (dto.Name || '').toLowerCase();
            const series = (dto.SeriesName || '').toLowerCase();
            let score;
            if (name === needle) score = 0;
            else if (name.startsWith(needle)) score = 1;
            else if (atWordStart.test(name)) score = 2;
            else if (name.includes(needle)) score = 3;
            else if (series.includes(needle)) score = 4;
            else continue;
            scored.push({ dto, score });
        }
        // Sort applies afterwards, so hold the rank on the item and let a caller
        // that asked for an explicit order still get one.
        scored.sort((a, b) => a.score - b.score || (a.dto.Name || '').localeCompare(b.dto.Name || ''));
        return scored.map((e) => e.dto);
    }

    /**
     * The type-ahead list. A hint is a thinner shape than an item, and the search
     * screen draws it before it asks for anything else.
     */
    async function searchHints(ctx) {
        const term = (ctx.params.get('searchTerm') || '').trim();
        if (!term) return json({ SearchHints: [], TotalRecordCount: 0 });

        const { rows, udMap } = await loadAll();
        const types = ctx.params.list('includeItemTypes').map((t) => t.toLowerCase());
        let dtos = rows.map((r) => present(r, udMap));
        if (types.length) dtos = dtos.filter((d) => types.includes(String(d.Type).toLowerCase()));

        const matched = rankSearch(dtos, term).slice(0, ctx.params.int('limit', 20));
        return json({
            SearchHints: matched.map((d) => ({
                ItemId: d.Id,
                Id: d.Id,
                Name: d.Name,
                Type: d.Type,
                ProductionYear: d.ProductionYear,
                RunTimeTicks: d.RunTimeTicks,
                MediaType: d.MediaType,
                Series: d.SeriesName,
                IndexNumber: d.IndexNumber,
                ParentIndexNumber: d.ParentIndexNumber,
                PrimaryImageTag: d.ImageTags && d.ImageTags.Primary,
                IsFolder: !!d.IsFolder
            })),
            TotalRecordCount: matched.length
        });
    }

    // --- sorting ----------------------------------------------------------

    const SORTERS = {
        sortname: (d) => (d.SortName || d.Name || '').toLowerCase(),
        name: (d) => (d.Name || '').toLowerCase(),
        productionyear: (d) => d.ProductionYear || 0,
        premieredate: (d) => Date.parse(d.PremiereDate || 0) || 0,
        datecreated: (d) => Date.parse(d.DateCreated || 0) || 0,
        communityrating: (d) => d.CommunityRating || 0,
        runtime: (d) => d.RunTimeTicks || 0,
        indexnumber: (d) => d.IndexNumber || 0,
        parentindexnumber: (d) => d.ParentIndexNumber || 0,
        isfolder: (d) => (d.IsFolder ? 0 : 1),
        datelastcontentadded: (d) => Date.parse(d.DateCreated || 0) || 0
    };

    function sortItems(dtos, sortBy, descending) {
        const keys = (sortBy || []).map((s) => SORTERS[String(s).toLowerCase()]).filter(Boolean);
        if (sortBy.some((s) => String(s).toLowerCase() === 'random')) {
            // Fisher-Yates rather than sort(() => Math.random() - 0.5), which is not
            // a shuffle and is biased enough to be visible on a short list.
            for (let i = dtos.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [dtos[i], dtos[j]] = [dtos[j], dtos[i]];
            }
            return dtos;
        }
        if (!keys.length) keys.push(SORTERS.sortname);
        return dtos.sort((a, b) => {
            for (const key of keys) {
                const av = key(a);
                const bv = key(b);
                if (av < bv) return descending ? 1 : -1;
                if (av > bv) return descending ? -1 : 1;
            }
            return 0;
        });
    }

    // --- the query --------------------------------------------------------

    async function queryItems(p) {
        const { rows, udMap } = await loadAll();

        const searchTerm = (p.get('searchTerm') || '').trim();
        const types = p.list('includeItemTypes').map((t) => t.toLowerCase());
        const excludeTypes = p.list('excludeItemTypes').map((t) => t.toLowerCase());
        const parentId = p.get('parentId') || p.get('ParentId');
        const recursive = p.bool('recursive', false);

        const byId = new Map(rows.map((r) => [r.id, r]));

        const ancestorOf = (row) => {
            const chain = [];
            let key = parentKeyOf(row.dto);
            for (let i = 0; i < 8 && key; i++) {
                chain.push(key);
                const next = byId.get(key);
                if (!next) break;
                key = parentKeyOf(next.dto);
            }
            return chain;
        };

        let candidates = rows;

        if (parentId) {
            const view = VIEW_BY_ID.get(parentId);
            if (view) {
                candidates = recursive
                    ? rows.filter((r) => ancestorOf(r).includes(parentId))
                    : rows.filter((r) => view.itemTypes.includes(r.dto.Type));
            } else {
                candidates = recursive
                    ? rows.filter((r) => ancestorOf(r).includes(parentId))
                    : rows.filter((r) => parentKeyOf(r.dto) === parentId);
            }
        } else if (types.length || searchTerm) {
            // A search with no type filter looks at everything: an episode nobody
            // can reach from the top level is exactly what someone searching for it
            // is trying to find.
            candidates = rows;
        } else {
            // No parent, no type filter and no search: only top-level items, or a
            // library of series answers with every episode in it.
            candidates = rows.filter((r) => r.dto.Type === 'Movie' || r.dto.Type === 'Series');
        }

        if (types.length) candidates = candidates.filter((r) => types.includes(String(r.dto.Type).toLowerCase()));
        if (excludeTypes.length) candidates = candidates.filter((r) => !excludeTypes.includes(String(r.dto.Type).toLowerCase()));

        // mediaTypes is how the search screen separates its sections: the video
        // section asks for MediaType Video, and a Series has no media type at all
        // because it is a folder. Ignoring it puts every result in the first
        // section and leaves the rest looking empty.
        const mediaTypes = p.list('mediaTypes').map((m) => m.toLowerCase());
        if (mediaTypes.length) {
            candidates = candidates.filter((r) =>
                mediaTypes.includes(String(r.dto.MediaType || '').toLowerCase()));
        }

        let dtos = candidates.map((r) => present(r, udMap));

        if (searchTerm) dtos = rankSearch(dtos, searchTerm);

        const filters = p.list('filters').map((f) => f.toLowerCase());
        if (filters.includes('isplayed')) dtos = dtos.filter((d) => d.UserData && d.UserData.Played);
        if (filters.includes('isunplayed')) dtos = dtos.filter((d) => !(d.UserData && d.UserData.Played));
        if (filters.includes('isresumable')) dtos = dtos.filter((d) => d.UserData && d.UserData.PlaybackPositionTicks > 0);

        const sortBy = p.list('sortBy');
        const descending = String(p.get('sortOrder', 'Ascending')).toLowerCase() === 'descending';
        // rankSearch already ordered these by relevance. Sorting again would replace
        // that with the default alphabetical order and bury the best match.
        if (!searchTerm || sortBy.length) sortItems(dtos, sortBy, descending);

        const total = dtos.length;
        const start = p.int('startIndex', 0);
        const limit = p.int('limit', 0);
        const page = limit > 0 ? dtos.slice(start, start + limit) : dtos.slice(start);
        return { items: page, total, start };
    }

    // --- handlers ---------------------------------------------------------

    async function userViews() {
        const { rows } = await loadAll();
        const items = S.VIEWS
            .map((v) => {
                const count = rows.filter((r) => v.itemTypes.includes(r.dto.Type)).length;
                return count ? viewDto(v, count) : null;
            })
            .filter(Boolean);
        return json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
    }

    async function items(ctx) {
        const { items: page, total, start } = await queryItems(ctx.params);
        return json({ Items: page, TotalRecordCount: total, StartIndex: start });
    }

    async function itemById(ctx, id) {
        const view = VIEW_BY_ID.get(id);
        if (view) {
            const { rows } = await loadAll();
            return json(viewDto(view, rows.filter((r) => view.itemTypes.includes(r.dto.Type)).length));
        }
        const { rows, udMap } = await loadAll();
        const row = rows.find((r) => r.id === id);
        if (!row) return notFound('item ' + id);
        return json(present(row, udMap));
    }

    /** `/Items/Latest` answers with a bare array, not a list wrapper. */
    async function latest(ctx) {
        const { rows, udMap } = await loadAll();
        const parentId = ctx.params.get('parentId');
        const view = VIEW_BY_ID.get(parentId);
        let candidates = rows.filter((r) => r.dto.Type === 'Movie' || r.dto.Type === 'Series');
        if (view) candidates = rows.filter((r) => view.itemTypes.includes(r.dto.Type));
        const limit = ctx.params.int('limit', 16);
        const dtos = candidates
            .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
            .slice(0, limit)
            .map((r) => present(r, udMap));
        return json(dtos);
    }

    async function resume(ctx) {
        const { rows, udMap } = await loadAll();
        const mediaTypes = ctx.params.list('mediaTypes').map((m) => m.toLowerCase());
        const dtos = rows
            .map((r) => present(r, udMap))
            .filter((d) => d.UserData && d.UserData.PlaybackPositionTicks > 0 && !d.UserData.Played)
            .filter((d) => !mediaTypes.length || mediaTypes.includes(String(d.MediaType || '').toLowerCase()))
            .sort((a, b) => Date.parse(b.UserData.LastPlayedDate || 0) - Date.parse(a.UserData.LastPlayedDate || 0))
            .slice(0, ctx.params.int('limit', 12));
        return json({ Items: dtos, TotalRecordCount: dtos.length, StartIndex: 0 });
    }

    /**
     * The first unwatched episode of each held series, or of one series when asked.
     *
     * Offline, there is nobody to ask what to watch next, which is the whole reason
     * the episode rows are held locally in the first place.
     */
    async function nextUp(ctx) {
        const { rows, udMap } = await loadAll();
        const seriesFilter = ctx.params.get('seriesId');
        const episodes = rows.filter((r) => r.dto.Type === 'Episode');

        const bySeries = new Map();
        for (const ep of episodes) {
            const sid = ep.dto.SeriesId;
            if (!sid || (seriesFilter && sid !== seriesFilter)) continue;
            if (!bySeries.has(sid)) bySeries.set(sid, []);
            bySeries.get(sid).push(ep);
        }

        const picks = [];
        for (const list of bySeries.values()) {
            list.sort((a, b) =>
                (a.dto.ParentIndexNumber || 0) - (b.dto.ParentIndexNumber || 0)
                || (a.dto.IndexNumber || 0) - (b.dto.IndexNumber || 0));
            const next = list.find((ep) => {
                const ud = udMap.get(ep.srv + ':' + ep.id);
                return !(ud && ud.played);
            });
            if (next) picks.push(present(next, udMap));
        }

        const limit = ctx.params.int('limit', 24);
        return json({ Items: picks.slice(0, limit), TotalRecordCount: picks.length, StartIndex: 0 });
    }

    async function seasons(ctx, seriesId) {
        const { rows, udMap } = await loadAll();
        const dtos = rows
            .filter((r) => r.dto.Type === 'Season' && r.dto.SeriesId === seriesId)
            .map((r) => present(r, udMap))
            .sort((a, b) => (a.IndexNumber || 0) - (b.IndexNumber || 0));
        return json({ Items: dtos, TotalRecordCount: dtos.length, StartIndex: 0 });
    }

    async function episodes(ctx, seriesId) {
        const { rows, udMap } = await loadAll();
        const seasonId = ctx.params.get('seasonId');
        const dtos = rows
            .filter((r) => r.dto.Type === 'Episode' && r.dto.SeriesId === seriesId)
            .filter((r) => !seasonId || r.dto.SeasonId === seasonId)
            .map((r) => present(r, udMap))
            .sort((a, b) =>
                (a.ParentIndexNumber || 0) - (b.ParentIndexNumber || 0)
                || (a.IndexNumber || 0) - (b.IndexNumber || 0));
        return json({ Items: dtos, TotalRecordCount: dtos.length, StartIndex: 0 });
    }

    /** Breadcrumbs. Walks our own parent chain and tops it with the view. */
    async function ancestors(ctx, id) {
        const { rows, udMap } = await loadAll();
        const byId = new Map(rows.map((r) => [r.id, r]));
        const chain = [];
        let key = byId.has(id) ? parentKeyOf(byId.get(id).dto) : null;
        for (let i = 0; i < 8 && key; i++) {
            const view = VIEW_BY_ID.get(key);
            if (view) {
                chain.push(viewDto(view, 0));
                break;
            }
            const row = byId.get(key);
            if (!row) break;
            chain.push(present(row, udMap));
            key = parentKeyOf(row.dto);
        }
        return json(chain);
    }

    async function image(ctx, id, type) {
        // Indexed, not loadAll(). A browse grid asks for a hundred posters at
        // once and each one used to rebuild the whole presented library — two
        // full table scans, a user-data map and a held-count pass — to read one
        // field. loadAll() is for producing a library; this needs a row.
        const rows = await DB.allByIndex('items', 'by_id', id);
        const row = rows[0];
        if (!row) return notFound('item ' + id);
        const file = await g.PS_OPFS.file(S.paths.image(row.srv, id, type));
        if (!file) return notFound('image');
        return serveFile(file, ctx.request, file.type || 'image/jpeg');
    }

    g.PS_LIBRARY = {
        loadAll, present, parentKeyOf, queryItems, viewDto, userDataOf, userDataEntries,
        userViews, items, itemById, latest, resume, nextUp, seasons, episodes, ancestors, image,
        searchHints, rankSearch,
        emptyList
    };
})(self);
