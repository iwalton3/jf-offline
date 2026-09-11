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

    async function loadAll() {
        const [rows, ud] = await Promise.all([DB.all('items'), DB.all('userdata')]);
        const udMap = new Map(ud.map((u) => [u.srv + ':' + u.itemId, u]));
        return { rows, udMap };
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
        const dto = DB.mergeUserData(row.dto, udMap.get(row.srv + ':' + row.id));
        dto.ServerId = S.ID.SERVER;
        dto.ParentId = parentKeyOf(row.dto);
        // Everything we hold is playable; the source server's own flags described a
        // file this browser may never have been able to play.
        dto.LocationType = 'FileSystem';
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
        const scored = [];
        for (const dto of dtos) {
            const name = (dto.Name || '').toLowerCase();
            const series = (dto.SeriesName || '').toLowerCase();
            let score;
            if (name === needle) score = 0;
            else if (name.startsWith(needle)) score = 1;
            else if (new RegExp('\\b' + needle.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&')).test(name)) score = 2;
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
        const { rows } = await loadAll();
        const row = rows.find((r) => r.id === id);
        if (!row) return notFound('item ' + id);
        const file = await g.PS_OPFS.file(S.paths.image(row.srv, id, type));
        if (!file) return notFound('image');
        return serveFile(file, ctx.request, file.type || 'image/jpeg');
    }

    g.PS_LIBRARY = {
        loadAll, present, parentKeyOf, queryItems, viewDto,
        userViews, items, itemById, latest, resume, nextUp, seasons, episodes, ancestors, image,
        searchHints, rankSearch,
        emptyList
    };
})(self);
