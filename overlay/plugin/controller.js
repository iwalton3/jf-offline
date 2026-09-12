/* Offline Sync settings page.
 *
 * jellyfin-web resolves the page's data-controller through importModule and
 * constructs this module's default export with (viewElement, params). The UI is
 * vdx-web: plain ES modules, no build step, nothing added to jellyfin-web.
 *
 * Two layout rules run through all of it, because this page loads over a network
 * and a page that reflows while it loads is unpleasant to use:
 *
 *  - Rows are a fixed height and the list is windowed, so a thousand items cost
 *    the same as ten and nothing resizes as they arrive.
 *  - Every region that can be empty reserves its height, so a status line
 *    appearing does not shove the list out from under the pointer.
 */

import { Component, defineComponent, html, each, when } from '/web/plugin/vdx/lib/framework.js';
import '/web/plugin/vdx/ui/selection/dropdown.js';
import '/web/plugin/vdx/ui/data/virtual-list.js';
import { knownServers, SourceServer } from '/web/plugin/source.js';
import {
    downloadItem, downloadSeries, removeDownload, listDownloads,
    ensurePersistentStorage, inspectSubtitles, inspectSeries, inspectSeriesTracks,
    inspectEpisodeTracks, bulkSelect, cancelDownload, cancelAll
} from '/web/plugin/downloader.js';

// One request per automatic top-up, which happens when the list is
// scrolled near its end. There is no Load more button: the list is windowed.
const PAGE = 100;
const ROW_HEIGHT = 52;
const LIST_HEIGHT = 420;
// Start the next page while this much already-loaded list remains, so the fetch
// is usually finished before the user reaches the bottom.
const SCROLL_THRESHOLD = ROW_HEIGHT * 6;
// Taller than a list row: a grid row carries two dropdowns.
const GRID_ROW_HEIGHT = 44;

/**
 * Everything the download question owns, and nothing else.
 *
 * One definition, used both to seed the component and to clear it, so a field
 * added here is automatically initialised AND reset. Keeping a separate list of
 * things to clear is how a cancelled series left its episode grid, its season
 * list and its subtitle tracks sitting in front of the next one.
 */
const askDefaults = () => ({
    asking: null,
    askTracks: [],
    askAudio: [],
    askChoice: 'auto',
    askAudioChoice: '',
    askSeasons: [],
    askSeasonId: '',
    askUnwatchedOnly: false,
    askSummary: '',
    askTranscode: false,
    askQuality: '',
    askPicture: [],
    askServerWouldBurn: null,
    askContainer: '',
    askInconsistent: false,
    // The per-episode grid. Also the largest thing here by far — one
    // PlaybackInfo per episode — so leaving it behind wastes memory as well as
    // showing the wrong show's episodes.
    gridRows: [],
    gridChoices: {},
    gridLoading: false,
    gridProgress: '',
    gridUnresolved: 0
});

const fmtBytes = (n) => {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
};

class OfflineSyncManager extends Component {
    state = Object.assign({
        servers: [],
        serverId: '',
        views: [],
        viewId: '',
        items: [],
        itemsTotal: 0,
        loadingItems: false,
        downloads: [],
        held: [],
        storage: { usage: 0, quota: 0 },
        persisted: false,
        precache: { done: 0, total: 0 },
        status: '',
        error: '',
        busy: false,
        // Notes from the LAST download, which outlive the question that produced
        // them: they are a result, not part of what is being asked.
        notes: [],
        // Which tree nodes are open, by node id.
        expanded: [],
        items_: null,
        downloading: null,
        // Type-to-filter for each list.
        itemFilter: '',
        heldFilter: ''
    }, askDefaults());

    static styles = /*css*/`
        :host {
            /* vdx components read these through the shadow boundary, so the dark
               palette is set once here rather than per component. */
            --primary-color: #00a4dc;
            --primary-hover: #0b8ec0;
            --text-color: #dde1e6;
            --text-secondary: #aab1b8;
            --text-tertiary: #777d84;
            --text-muted: #8b9299;
            --input-bg: #202429;
            --input-border: #3a4048;
            --input-text: #dde1e6;
            --hover-bg: #2b3038;
            --selected-bg: #123044;
            --disabled-bg: #2a2e34;
            --border-color: #343a42;
            --card-bg: #1b1f24;
            --error-color: #f0868e;
            --success-color: #6dd36d;

            display: block;
            color: var(--text-color);
            font-size: 14px;
        }

        .osx { display: flex; flex-direction: column; gap: 1.5em; }
        .row { display: flex; flex-wrap: wrap; gap: .75em; align-items: flex-end; }
        /* No flex-grow. Growing to fill the row spread two dropdowns across the
           whole width with a chasm between them; they want to be their own size. */
        .field { display: flex; flex-direction: column; gap: .35em; width: 18em; max-width: 100%; }
        .field > label {
            font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
            color: var(--text-muted);
        }

        h3 { margin: 0 0 .5em; font-size: 15px; font-weight: 600; color: var(--text-color); }
        .note { color: var(--text-muted); font-size: 13px; margin: 0; }
        .bad { color: var(--error-color); }
        .good { color: var(--success-color); }

        /* Reserved, so an appearing message never moves what is under it. */
        .statusline { min-height: 1.4em; font-size: 13px; }

        .panel {
            border: 1px solid var(--border-color);
            background: var(--card-bg);
            border-radius: 3px;
            transition: opacity .15s ease;
        }
        /* Busy is shown on the container, not on each row: a row is memoised and
           would keep whatever it was drawn with. Scrolling still works. */
        .panel.busy { opacity: .55; }
        @media (prefers-reduced-motion: reduce) { .panel { transition: none; } }

        /* max-height, not height: a two-row list should be two rows tall. A fixed
           height left a tall empty region that still counted as a scroll container,
           so the wheel went into something with nothing to scroll and went nowhere.
           No overscroll containment either, for the same reason: with nothing to
           scroll the page below it must still move. */
        .scroller {
            max-height: ${LIST_HEIGHT}px;
            overflow-y: auto;
        }

        .item {
            display: flex; align-items: center; gap: .75em;
            /* The virtual list positions each row in a box of its own; without a
               full width the row shrinks to its content and the button sits
               wherever the text ends instead of at the right edge. */
            width: 100%;
            height: ${ROW_HEIGHT}px;
            padding: 0 .85em;
            border-bottom: 1px solid var(--border-color);
            box-sizing: border-box;
            overflow: hidden;
        }
        .item:last-child { border-bottom: none; }
        /* The name takes the slack and truncates; min-width:0 is what lets a flex
           child shrink below its content, without which the button is pushed off
           the right edge on a phone instead of the text being clipped. */
        .name {
            flex: 1 1 auto; min-width: 0;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .tag {
            flex: none;
            font-size: 11px; color: var(--text-muted);
            text-transform: uppercase; letter-spacing: .06em;
        }
        .tag.held { color: var(--primary-color); }
        /* Always hard against the right edge, whatever survives to its left. */
        .item > button.act { margin-left: auto; }

        /* On a phone the tags are the first thing worth losing: the name and the
           button are what the row is for. */
        @media (max-width: 640px) {
            .item { gap: .5em; padding: 0 .6em; }
            .item .tag { display: none; }
            .item .tag.keep { display: inline; max-width: 7em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            button.act { min-width: 0; padding: .35em .6em; }
            .field { width: 100%; }
            .row { gap: .5em; }
        }

        input.filter {
            background: var(--input-bg);
            border: 1px solid var(--input-border);
            color: var(--input-text);
            border-radius: 3px;
            padding: .45em .7em;
            font: inherit; font-size: 13px;
            width: 100%; box-sizing: border-box;
        }
        input.filter:focus { outline: none; border-color: var(--primary-color); }
        .listhead { display: flex; gap: .75em; align-items: center; margin-bottom: .5em; }
        .listhead h3 { margin: 0; flex: none; }
        .listhead .grow { flex: 1 1 auto; min-width: 8em; }

        button.act {
            flex: none;
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-color);
            border-radius: 3px;
            padding: .35em .9em;
            font: inherit; font-size: 13px;
            cursor: pointer;
            min-width: 6.5em;
        }
        button.act:hover:not(:disabled) { background: var(--hover-bg); border-color: var(--primary-color); }
        button.act:disabled { opacity: .45; cursor: default; }
        button.act.primary { border-color: var(--primary-color); color: var(--primary-color); }

        /* The same height as a real row, so the list does not resize when data lands. */
        .skeleton { display: flex; align-items: center; height: ${ROW_HEIGHT}px; padding: 0 .85em; }
        .skeleton span {
            display: block; height: 12px; border-radius: 2px;
            background: linear-gradient(90deg, #23272d 25%, #2d3239 37%, #23272d 63%);
            background-size: 400% 100%;
            animation: shimmer 1.3s ease infinite;
        }
        @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
        @media (prefers-reduced-motion: reduce) { .skeleton span { animation: none; } }

        .bar { height: 4px; background: #2a2e34; border-radius: 2px; overflow: hidden; }
        .bar > span { display: block; height: 100%; background: var(--primary-color); }

        .check { display: flex; align-items: center; gap: .5em; font-size: 13px; cursor: pointer; }
        .check input { accent-color: var(--primary-color); width: 1em; height: 1em; }

        .caret {
            flex: none; width: 1.1em; text-align: center;
            color: var(--text-muted); font-size: 11px;
            transition: transform .12s ease;
        }
        .caret.open { transform: rotate(90deg); }
        .caret.leaf { opacity: 0; }
        .node-group .name { font-weight: 600; }
        /* The affordance and the binding have to be the same shape: pointer on the
           row means the row is clickable. */
        .item.node-group { cursor: pointer; }
        .item.node-group button.act { cursor: pointer; }
        @media (prefers-reduced-motion: reduce) { .caret { transition: none; } }

        .warn {
            border-left: 3px solid var(--warning, #d4b846);
            padding: .5em .75em;
            background: rgba(212, 184, 70, .08);
            font-size: 13px;
            color: var(--text-secondary);
        }
        .warn strong { color: #d4b846; font-weight: 600; }

        .grid-row {
            display: flex; align-items: center; gap: .6em;
            height: ${GRID_ROW_HEIGHT}px;
            padding: 0 .7em;
            border-bottom: 1px solid var(--border-color);
            box-sizing: border-box; width: 100%;
        }
        .grid-row.unresolved { background: rgba(212, 184, 70, .10); }
        .grid-ep { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .grid-num { flex: none; width: 4.5em; color: var(--text-muted); font-size: 12px; }
        .grid-row select {
            flex: none; width: 13em; max-width: 34vw;
            background: var(--input-bg); color: var(--input-text);
            border: 1px solid var(--input-border); border-radius: 3px;
            padding: .25em .4em; font: inherit; font-size: 12px;
        }
        .bulkbar { display: flex; flex-wrap: wrap; gap: .5em; align-items: center; margin-bottom: .5em; }
        @media (max-width: 640px) {
            .grid-row { gap: .4em; padding: 0 .45em; }
            .grid-num { display: none; }
            .grid-row select { width: 9em; }
        }

        .ask {
            border: 1px solid var(--primary-color);
            background: var(--card-bg);
            border-radius: 3px;
            padding: 1em;
            display: flex; flex-direction: column; gap: .8em;
        }
    `;

    // --- lifecycle --------------------------------------------------------

    async mounted() {
        this.state.servers = knownServers(window.PS_SCHEMA.ID.SERVER);
        if (this.state.servers.length === 1) {
            this.state.serverId = this.state.servers[0].id;
            await this.loadViews();
        }
        await this.refreshDownloads();

        if (window.__phantom && window.__phantom.onPrecache) {
            this._offPrecache = window.__phantom.onPrecache((p) => {
                this.state.precache = { done: p.done, total: p.total };
            });
            window.__phantom.refreshPrecache();
        }
    }

    unmounted() {
        if (this._offPrecache) this._offPrecache();
    }

    // --- data -------------------------------------------------------------

    server() {
        const info = this.state.servers.find((s) => s.id === this.state.serverId);
        return info ? new SourceServer(info) : null;
    }

    async refreshDownloads() {
        const rows = await listDownloads();
        this.state.downloads = rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        this.state.held = rows.map((r) => r.itemId);
        // The rows say what is held; the item store says what it belongs to. The
        // tree needs both, and the join is cheap on a library this size.
        this.state.items_ = await window.PS_DB.all('items');
        this.state.storage = await window.PS_OPFS.usage();
        this.state.persisted = navigator.storage && navigator.storage.persisted
            ? await navigator.storage.persisted()
            : false;
    }

    /**
     * A download or a removal: one at a time.
     *
     * Separate from `task` below because they are different kinds of busy, and
     * conflating them meant filtering the library during a download cleared the
     * list and then refused to reload it, leaving the skeleton up for good.
     */
    async exclusive(label, fn) {
        if (this.state.busy) return;
        this.state.busy = true;
        this.state.error = '';
        this.state.status = label;
        try {
            await fn();
        } catch (err) {
            if (err && err.cancelled) {
                this.state.status = '';
            } else {
                console.error('[offline sync]', err);
                this.state.error = String(err && err.message || err);
            }
        } finally {
            this.state.busy = false;
            this.state.status = '';
            this.state.downloading = null;
        }
    }

    /** Fetching a list. Runs whatever else is happening. */
    async task(label, fn) {
        const previous = this.state.status;
        this.state.status = this.state.busy ? previous : label;
        try {
            await fn();
        } catch (err) {
            console.error('[offline sync]', err);
            this.state.error = String(err && err.message || err);
        } finally {
            if (!this.state.busy) this.state.status = '';
        }
    }

    async loadViews() {
        await this.task('Loading libraries', async () => {
            const res = await this.server().views();
            this.state.views = (res.Items || []).filter(
                (v) => v.CollectionType === 'movies' || v.CollectionType === 'tvshows'
            );
        });
    }

    /** Append the next page. `loadItems()` with no argument starts from the top. */
    async loadItems(append) {
        const view = this.state.views.find((v) => v.Id === this.state.viewId);
        if (!view) return;
        if (this.state.loadingItems) return;
        const startIndex = append ? this.state.items.length : 0;
        if (append && this.state.itemsTotal && startIndex >= this.state.itemsTotal) return;

        this.state.loadingItems = true;
        await this.task(startIndex ? 'Loading more' : 'Loading items', async () => {
            const res = await this.server().items({
                ParentId: view.Id,
                IncludeItemTypes: view.CollectionType === 'movies' ? 'Movie' : 'Series',
                SearchTerm: this.state.itemFilter || undefined,
                StartIndex: startIndex,
                Limit: PAGE
            });
            const page = res.Items || [];
            this.state.items = startIndex ? this.state.items.concat(page) : page;
            // TotalRecordCount is what says there is more; a full page cannot,
            // because that is also what the last page looks like.
            this.state.itemsTotal = res.TotalRecordCount != null
                ? res.TotalRecordCount
                : this.state.items.length;
        });
        this.state.loadingItems = false;
    }

    /**
     * Filter the source library.
     *
     * Sent to the source server rather than applied to what is loaded, because a
     * filter that only searched the first hundred of a thousand would answer
     * "nothing" for most of the library and look broken.
     */
    onItemFilter(ev) {
        this.state.itemFilter = ev.target.value;
        clearTimeout(this._filterTimer);
        // Typing is faster than the round trip; without this every keystroke is a
        // request and the answers arrive out of order.
        this._filterTimer = setTimeout(() => {
            this.state.items = [];
            this.state.itemsTotal = 0;
            this.loadItems();
        }, 250);
    }

    /** The held list is small and already in memory, so this one is local. */
    onHeldFilter(ev) {
        this.state.heldFilter = ev.target.value;
    }

    /**
     * The held library as a tree: films flat, episodes under their season under
     * their series.
     *
     * A flat list of episodes is unusable once a series is downloaded — twenty
     * rows called "Chapter Four" with nothing saying what they belong to — and
     * removing a whole series should be one action rather than twenty.
     */
    downloadTree() {
        const rows = this.matchingDownloads();
        const byId = new Map((this.state.items_ || []).map((r) => [r.srv + '|' + r.id, r.dto]));
        const dtoOf = (row) => byId.get(row.srv + '|' + row.itemId) || {};

        const films = [];
        const series = new Map();

        for (const row of rows) {
            const dto = dtoOf(row);
            if (dto.Type !== 'Episode') {
                films.push({ row, dto });
                continue;
            }
            const seriesId = dto.SeriesId || 'unknown';
            if (!series.has(seriesId)) {
                const seriesDto = byId.get(row.srv + '|' + seriesId) || {};
                series.set(seriesId, {
                    id: seriesId,
                    name: seriesDto.Name || dto.SeriesName || 'Unknown series',
                    seasons: new Map()
                });
            }
            const seasonId = dto.SeasonId || 'unknown';
            const seasons = series.get(seriesId).seasons;
            if (!seasons.has(seasonId)) {
                const seasonDto = byId.get(row.srv + '|' + seasonId) || {};
                seasons.set(seasonId, {
                    id: seasonId,
                    name: seasonDto.Name || (dto.ParentIndexNumber != null ? 'Season ' + dto.ParentIndexNumber : 'Episodes'),
                    index: seasonDto.IndexNumber != null ? seasonDto.IndexNumber : (dto.ParentIndexNumber || 0),
                    episodes: []
                });
            }
            seasons.get(seasonId).episodes.push({ row, dto });
        }

        const nodes = [];
        const size = (entries) => entries.reduce((n, e) => n + (e.row.bytesDone || 0), 0);
        const isOpen = (id) => this.state.expanded.includes(id);

        if (films.length) {
            films.sort((a, b) => String(a.row.name).localeCompare(String(b.row.name)));
            nodes.push({
                kind: 'group', id: 'films', depth: 0, title: 'Movies and videos',
                count: films.length, bytes: size(films), open: isOpen('films'),
                rows: films.map((e) => e.row)
            });
            if (isOpen('films')) {
                for (const entry of films) {
                    nodes.push({ kind: 'item', id: 'f:' + entry.row.itemId, depth: 1, entry });
                }
            }
        }

        for (const show of [...series.values()].sort((a, b) => a.name.localeCompare(b.name))) {
            const all = [...show.seasons.values()].flatMap((se) => se.episodes);
            const showId = 's:' + show.id;
            nodes.push({
                kind: 'series', id: showId, depth: 0, title: show.name,
                count: all.length, bytes: size(all), open: isOpen(showId),
                rows: all.map((e) => e.row)
            });
            if (!isOpen(showId)) continue;

            for (const season of [...show.seasons.values()].sort((a, b) => a.index - b.index)) {
                const seasonId = 'se:' + season.id;
                nodes.push({
                    kind: 'season', id: seasonId, depth: 1, title: season.name,
                    count: season.episodes.length, bytes: size(season.episodes),
                    open: isOpen(seasonId), rows: season.episodes.map((e) => e.row)
                });
                if (!isOpen(seasonId)) continue;
                season.episodes.sort((a, b) => (a.dto.IndexNumber || 0) - (b.dto.IndexNumber || 0));
                for (const entry of season.episodes) {
                    nodes.push({ kind: 'item', id: 'e:' + entry.row.itemId, depth: 2, entry });
                }
            }
        }
        return nodes;
    }

    toggleNode(id) {
        const open = this.state.expanded;
        const at = open.indexOf(id);
        // Replaced rather than mutated: the template reads the array and a splice
        // in place does not always announce itself.
        this.state.expanded = at === -1 ? open.concat([id]) : open.filter((x) => x !== id);
    }

    /** The button sits inside the row, and the row toggles; stop it doing both. */
    removeGroup(ev, node) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        this.removeMany(node.rows, node.title);
    }

    removeMany(rows, label) {
        this.exclusive(`Removing ${label}`, async () => {
            for (const row of rows) await removeDownload(row);
            await this.refreshDownloads();
            await window.__phantom.libraryChanged();
        });
    }

    cancelCurrent() {
        cancelAll();
        const current = this.state.downloading;
        if (current) cancelDownload(current.srv, current.itemId, current.sourceId);
        this.state.status = 'Cancelling…';
    }

    matchingDownloads() {
        const rows = Array.from(this.state.downloads || []);
        const needle = (this.state.heldFilter || '').trim().toLowerCase();
        if (!needle) return rows;
        return rows.filter((row) => String(row.name || row.itemId).toLowerCase().includes(needle));
    }

    /** Top up before the list runs out, so scrolling never stops at a boundary. */
    onListScroll(ev) {
        const el = ev.currentTarget;
        if (!el) return;
        // Only when there is something to scroll AND something left to fetch.
        // Without the first test a list shorter than its box reports zero
        // remaining on every wheel event and asks for the next page each time.
        if (el.scrollHeight <= el.clientHeight) return;
        if (this.state.loadingItems) return;
        if (this.state.itemsTotal && this.state.items.length >= this.state.itemsTotal) return;
        const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (remaining < SCROLL_THRESHOLD) this.loadItems(true);
    }

    // --- selection --------------------------------------------------------

    onServerChange(ev) {
        this.state.serverId = ev.detail ? ev.detail.value : ev.target.value;
        this.state.views = [];
        this.state.viewId = '';
        this.state.items = [];
        this.state.itemsTotal = 0;
        if (this.state.serverId) this.loadViews();
    }

    onViewChange(ev) {
        this.state.viewId = ev.detail ? ev.detail.value : ev.target.value;
        this.state.items = [];
        this.state.itemsTotal = 0;
        if (this.state.viewId) this.loadItems();
    }

    // --- the subtitle question -------------------------------------------

    /**
     * Ask before downloading, but only when there is something to ask.
     *
     * An item with no subtitles, or only extractable ones, has a right answer and
     * asking would be noise. A picture-based track has no text to extract, so the
     * only way to see it offline is to burn it in — which fixes the choice of
     * track, forces a transcode, and cannot be changed without downloading the
     * item again.
     */
    /**
     * Ask before downloading, but only when there is something to ask.
     *
     * A film with no subtitle or audio decision to make has a right answer and a
     * dialog would be noise. A series always asks, because which seasons and
     * whether to skip what has been watched are questions with no right answer,
     * and getting them wrong means downloading gigabytes nobody wanted.
     */
    start(item) {
        const server = this.server();
        // Cleared before anything is read, so a question that fails part way
        // through cannot leave the previous one's answers on screen either.
        this.resetAsk();
        this.state.notes = [];
        this.exclusive(`Checking ${item.Name}`, async () => {
            const isSeries = item.Type === 'Series';
            let series = null;
            let sample = item;
            let consistency = null;

            if (isSeries) {
                series = await inspectSeries(server, item);
                sample = series.sample;
                if (!sample) throw new Error('series has no episodes');
                const episodes = (await server.episodes(item.Id)).Items || [];
                consistency = await inspectSeriesTracks(server, episodes);
            }

            const inspected = await inspectSubtitles(server, sample);
            const { tracks, audio } = inspected;
            const needsSubtitleChoice = tracks.some((t) => !t.canExtract);
            // More than one audio track is a question too: the browser plays
            // whichever the container defaults to and cannot switch, so picking
            // another one has to happen now or not at all.
            const needsAudioChoice = audio.length > 1;

            // A transcode is work on somebody else's machine, and a series is that
            // work once per episode, so it is worth saying before rather than after.
            if (!isSeries && !needsSubtitleChoice && !needsAudioChoice && !inspected.willTranscode) {
                await this.run(item, { mode: 'auto' }, null, {});
                return;
            }

            this.state.askTracks = needsSubtitleChoice ? tracks : [];
            this.state.askAudio = needsAudioChoice ? audio : [];
            this.state.askChoice = 'auto';
            const preferred = audio.find((a) => a.isContainerDefault) || audio[0];
            this.state.askAudioChoice = preferred ? String(preferred.index) : '';

            this.state.askSeasons = series ? series.seasons : [];
            this.state.askSeasonId = '';
            this.state.askUnwatchedOnly = false;
            this.state.askSummary = series
                ? `${series.episodes} episodes, ${series.unwatched} unwatched`
                : '';
            this.state.askInconsistent = !!(consistency && !consistency.consistent);
            this.state.askTranscode = !!inspected.willTranscode;
            this.state.askQuality = window.PS_SCHEMA.DEFAULT_QUALITY;
            this.state.askPicture = inspected.pictureTracks || [];
            this.state.askServerWouldBurn = inspected.serverWouldBurn || null;
            this.state.askContainer = inspected.container || '';
            this.state.asking = item;
        });
    }

    confirmAsk() {
        // Everything is read out before the reset, because the reset is what makes
        // the next question start clean.
        const item = this.state.asking;
        const choice = this.state.askChoice;
        const audioChoice = this.state.askAudioChoice;
        const chosenTrack = this.state.askTracks.find((t) => t.index === Number(choice));
        const series = {
            seasonId: this.state.askSeasonId || null,
            unwatchedOnly: this.state.askUnwatchedOnly,
            quality: this.state.askQuality,
            perEpisode: Object.keys(this.state.gridChoices).length ? this.state.gridChoices : null
        };
        this.resetAsk();
        this.state.asking = null;
        let subtitle;
        if (choice === 'auto' || choice === 'none') {
            subtitle = { mode: choice };
        } else {
            const index = Number(choice);
            const track = chosenTrack;
            subtitle = { mode: 'burn', index };
            // For a series the index is meaningless beyond the file it came from,
            // so carry what the track is and let each episode resolve its own.
            if (item.Type === 'Series' && track) {
                subtitle.match = {
                    language: track.language,
                    codec: track.codec,
                    isForced: track.isForced,
                    title: track.title,
                    canExtract: track.canExtract
                };
            }
        }
        this.run(item, subtitle, audioChoice === '' ? null : Number(audioChoice), series);
    }

    // --- per-episode arbitration ------------------------------------------

    /** Which episodes this download would actually take, so the grid matches it. */
    async episodesInScope() {
        const server = this.server();
        const item = this.state.asking;
        let list = (await server.episodes(item.Id)).Items || [];
        if (this.state.askSeasonId) list = list.filter((ep) => ep.SeasonId === this.state.askSeasonId);
        if (this.state.askUnwatchedOnly) list = list.filter((ep) => !(ep.UserData && ep.UserData.Played));
        return list;
    }

    openGrid() {
        const server = this.server();
        this.state.gridLoading = true;
        this.task('Reading tracks', async () => {
            const list = await this.episodesInScope();
            const rows = await inspectEpisodeTracks(server, list, (done, total) => {
                this.state.gridProgress = `${done} of ${total}`;
            });
            this.state.gridRows = rows;
            this.state.gridChoices = {};
            this.state.gridUnresolved = 0;
            this.state.gridProgress = '';
            // No rule applied on open. Guessing "subbed" at a show that is not
            // anime resolves nothing and paints every row as a problem, which is
            // alarming and wrong: the honest starting point is the same one the
            // download would use anyway, which is to burn nothing in.
        });
        this.state.gridLoading = false;
    }

    /** Put the question back to nothing. Every entry and exit goes through here. */
    resetAsk() {
        Object.assign(this.state, askDefaults());
    }

    closeGrid() {
        this.state.gridRows = [];
        this.state.gridChoices = {};
        this.state.gridUnresolved = 0;
        this.state.gridProgress = '';
    }

    applyBulk(mode, opts) {
        const { choices, unresolved } = bulkSelect(this.state.gridRows, mode, opts || {});
        // Merged, not replaced: a rule that does not fit an episode leaves the
        // answer already there rather than wiping it.
        this.state.gridChoices = Object.assign({}, this.state.gridChoices, choices);
        this.state.gridUnresolved = unresolved.length;
    }

    setEpisodeSubtitle(id, value) {
        const current = this.state.gridChoices[id] || {};
        this.state.gridChoices = Object.assign({}, this.state.gridChoices, {
            [id]: Object.assign({}, current, { subtitleIndex: value === '' ? null : Number(value) })
        });
    }

    setEpisodeAudio(id, value) {
        const current = this.state.gridChoices[id] || {};
        this.state.gridChoices = Object.assign({}, this.state.gridChoices, {
            [id]: Object.assign({}, current, { audioIndex: value === '' ? null : Number(value) })
        });
    }

    /** Grid rows carrying their own current choice, so a memoised row can see it. */
    gridView() {
        const choices = this.state.gridChoices;
        return this.state.gridRows.map((row) => {
            const choice = choices[row.id] || {};
            return Object.assign({}, row, {
                subtitleIndex: choice.subtitleIndex == null ? '' : String(choice.subtitleIndex),
                audioIndex: choice.audioIndex == null ? '' : String(choice.audioIndex),
                resolved: choice.subtitleIndex != null || choice.audioIndex != null
            });
        });
    }

    onAskQualityChange(ev) {
        this.state.askQuality = ev.detail ? String(ev.detail.value) : ev.target.value;
    }

    get qualityOptions() {
        return (window.PS_SCHEMA.QUALITIES || []).map((q) => ({ label: q.label, value: q.id }));
    }

    onAskSeasonChange(ev) {
        this.state.askSeasonId = ev.detail ? String(ev.detail.value) : ev.target.value;
    }

    onAskUnwatchedChange(ev) {
        this.state.askUnwatchedOnly = !!ev.target.checked;
    }

    get askSeasonOptions() {
        const total = this.state.askSeasons.reduce((n, se) => n + se.episodes, 0);
        return [{ label: `All seasons (${total} episodes)`, value: '' }].concat(
            this.state.askSeasons.map((se) => ({
                label: `${se.name} (${se.episodes} episodes, ${se.unwatched} unwatched)`,
                value: se.id
            }))
        );
    }

    onAskAudioChange(ev) {
        this.state.askAudioChoice = ev.detail ? String(ev.detail.value) : ev.target.value;
    }

    get askAudioOptions() {
        return this.state.askAudio.map((a) => ({
            label: `${a.title}${a.channels ? ' · ' + a.channels + 'ch' : ''}${a.isContainerDefault ? ' (default)' : ''}`,
            value: String(a.index)
        }));
    }

    cancelAsk() {
        this.resetAsk();
    }

    onAskChange(ev) {
        this.state.askChoice = ev.detail ? ev.detail.value : ev.target.value;
    }

    // --- downloading ------------------------------------------------------

    run(item, subtitle, audioStreamIndex, series = {}) {
        const server = this.server();
        // Asked on the gesture, because Firefox only grants persistence while
        // handling one. Without it the browser may evict the whole library.
        const persisting = ensurePersistentStorage();
        return this.exclusive(`Downloading ${item.Name}`, async () => {
            const grant = await persisting;
            this.state.persisted = grant.persisted;

            this.state.downloading = { srv: server.id, itemId: item.Id, sourceId: null };
            const onProgress = (done, total, unit, name) => {
                this.state.status = unit === 'bytes'
                    ? `${item.Name}: ${fmtBytes(done)}${total ? ' of ' + fmtBytes(total) : ''}`
                    : `${item.Name}: ${done} of ${total} ${unit}${name ? ' — ' + name : ''}`;
            };

            if (item.Type === 'Series') {
                const result = await downloadSeries(server, item, {
                    subtitle, audioStreamIndex, onProgress,
                    seasonId: series.seasonId,
                    unwatchedOnly: series.unwatchedOnly,
                    quality: series.quality,
                    perEpisode: series.perEpisode
                });
                if (result.failures.length) {
                    this.state.error = `${result.failures.length} of ${result.episodes} episodes failed: `
                        + result.failures.map((f) => f.name).join(', ');
                }
                this.state.notes = result.notes || [];
            } else {
                await downloadItem(server, item, {
                    subtitle, audioStreamIndex, onProgress, quality: series.quality
                });
            }
            await this.refreshDownloads();
            await window.__phantom.libraryChanged();
        });
    }

    removeHeld(row) {
        this.exclusive(`Removing ${row.name || row.itemId}`, async () => {
            await removeDownload(row);
            await this.refreshDownloads();
            await window.__phantom.libraryChanged();
        });
    }

    async requestPersistence() {
        const grant = await ensurePersistentStorage();
        this.state.persisted = grant.persisted;
    }

    // --- rendering --------------------------------------------------------

    get serverOptions() {
        return this.state.servers.map((s) => ({ label: s.name, value: s.id }));
    }

    get viewOptions() {
        return this.state.views.map((v) => ({ label: v.Name, value: v.Id }));
    }

    get askOptions() {
        const opts = [
            { label: 'Keep text tracks (styling preserved)', value: 'auto' },
            { label: 'No subtitles', value: 'none' }
        ];
        for (const t of this.state.askTracks) {
            if (t.canExtract) continue;
            opts.push({ label: `Burn in: ${t.title} (${t.codec})`, value: String(t.index) });
        }
        return opts;
    }

    /**
     * A row.
     *
     * Nothing here may read state outside `item`. The virtual list memoises rows
     * by key, so a row drawn while something else was busy keeps that appearance
     * for good — which is what left every button greyed out after a filter, since
     * filtering set `busy` for the length of the request the rows were drawn by.
     * Re-entry is refused in `guard` instead, where it is one check rather than
     * one per row.
     */
    renderItem(item) {
        const held = this.state.held.includes(item.Id);
        return html`
            <div class="item">
                <span class="name">${item.Name}</span>
                <span class="tag">${item.Type}${item.ProductionYear ? ' · ' + item.ProductionYear : ''}</span>
                ${when(held, () => html`<span class="tag held">held</span>`)}
                <button class="act" on-click="${() => this.start(item)}">Download</button>
            </div>
        `;
    }

    /**
     * One line of the tree.
     *
     * Reads only its node, like every other row in a virtual list: the node is
     * rebuilt whenever expansion or the download set changes, so its `open` flag
     * travels with it rather than being looked up at render time.
     */
    renderNode(node) {
        if (node.kind === 'item') {
            const { row, dto } = node.entry;
            const number = dto.IndexNumber != null ? dto.IndexNumber + '. ' : '';
            return html`
                <div class="item" style="padding-left:${0.85 + node.depth * 1.4}em">
                    <span class="caret leaf">▸</span>
                    <span class="name">${number}${row.name || row.itemId}</span>
                    <span class="tag">${row.mode} · ${fmtBytes(row.bytesDone)}</span>
                    ${when(!!(row.subtitles && row.subtitles.length), () => html`
                        <span class="tag">${row.subtitles.length} subs</span>
                    `)}
                    ${when(row.burnedSubtitleIndex != null, () => html`
                        <span class="tag held">burned in</span>
                    `)}
                    <span class="tag keep">${row.state}</span>
                    <button class="act" on-click="${() => this.removeHeld(row)}">Remove</button>
                </div>
            `;
        }

        const label = node.kind === 'season' ? 'season' : (node.kind === 'series' ? 'series' : 'group');
        return html`
            <div class="item node-group"
                style="padding-left:${0.85 + node.depth * 1.4}em"
                on-click="${() => this.toggleNode(node.id)}">
                <span class="caret ${node.open ? 'open' : ''}">▸</span>
                <span class="name">${node.title}</span>
                <span class="tag">${node.count} items · ${fmtBytes(node.bytes)}</span>
                <button class="act" on-click="${(ev) => this.removeGroup(ev, node)}">Remove ${label}</button>
            </div>
        `;
    }

    /**
     * One episode in the arbitration grid.
     *
     * Plain <select> rather than cl-dropdown: there is one of these per episode
     * and per track column, and an overlay-based dropdown inside a windowed list
     * that recycles its rows is a fight not worth having.
     */
    renderGridRow(row) {
        const label = (row.season != null && row.index != null)
            ? `S${String(row.season).padStart(2, '0')}E${String(row.index).padStart(2, '0')}`
            : '';
        return html`
            <div class="grid-row ${row.resolved ? '' : 'unresolved'}">
                <span class="grid-num">${label}</span>
                <span class="grid-ep">${row.name}</span>
                <select aria-label="Audio" on-change="${(ev) => this.setEpisodeAudio(row.id, ev.target.value)}">
                    <option value="" selected="${row.audioIndex === ''}">Audio: default</option>
                    ${each(row.audio, (a) => html`
                        <option value="${a.index}" selected="${row.audioIndex === String(a.index)}">${a.title}</option>
                    `)}
                </select>
                <select aria-label="Subtitles" on-change="${(ev) => this.setEpisodeSubtitle(row.id, ev.target.value)}">
                    <option value="" selected="${row.subtitleIndex === ''}">Subtitles: none burned</option>
                    ${each(row.subtitles, (t) => html`
                        <option value="${t.index}" selected="${row.subtitleIndex === String(t.index)}">
                            ${t.title} (${t.codec})
                        </option>
                    `)}
                </select>
            </div>
        `;
    }

    renderSkeletons() {
        const widths = ['42%', '61%', '35%', '54%', '48%', '66%', '39%', '57%'];
        return html`
            <div>
                ${each(widths, (w) => html`<div class="skeleton"><span style="width:${w}"></span></div>`)}
            </div>
        `;
    }

    renderPrecache() {
        const { done, total } = this.state.precache;
        const complete = total > 0 && done >= total;
        const pct = total ? Math.min(100, (done / total) * 100) : 0;
        return html`
            <div>
                <h3>Offline app</h3>
                ${when(complete, () => html`
                    <p class="note good">The whole web client is held offline. Airplane mode will work.</p>
                `)}
                ${when(!complete, () => html`
                    <p class="note">
                        Holding the web client for offline use: ${done} of ${total || '…'} files.
                        Leave this page open until it finishes.
                    </p>
                    <div class="bar" style="margin-top:.4em"><span style="width:${pct.toFixed(1)}%"></span></div>
                `)}
            </div>
        `;
    }

    renderStorage() {
        // Used only, no percentage and no bar. Chromium does not report a real
        // quota: it answers with roughly what you are using plus a constant, so a
        // "13.4 GB available" reading moves as you download and says nothing about
        // the disk. A number we cannot stand behind is worse than no number.
        const { usage } = this.state.storage;
        return html`
            <div>
                <h3>Storage</h3>
                <p class="note">Downloads are using ${fmtBytes(usage)}.</p>
                <div class="statusline" style="margin-top:.5em">
                    ${when(this.state.persisted, () => html`
                        <span class="note good">Storage is persistent. Downloads stay until you remove them.</span>
                    `)}
                    ${when(!this.state.persisted, () => html`
                        <span class="note bad">Storage is not persistent — the browser may delete downloads.</span>
                        <button class="act" style="margin-left:.6em"
                            on-click="${() => this.requestPersistence()}">Make persistent</button>
                    `)}
                </div>
            </div>
        `;
    }

    template() {
        const s = this.state;
        return html`
            <div class="osx">
                ${when(!s.servers.length, () => html`
                    <p class="note">
                        No other servers are signed in yet. Add your Jellyfin server from the
                        server selection screen and sign in, then come back here.
                    </p>
                `)}

                ${when(s.servers.length > 0, () => html`
                    <div class="row">
                        <div class="field">
                            <label for="osx-server">Source server</label>
                            <cl-dropdown id="osx-server"
                                options="${this.serverOptions}"
                                value="${s.serverId}"
                                placeholder="Choose a server"
                                on-change="${(ev) => this.onServerChange(ev)}"></cl-dropdown>
                        </div>
                        <div class="field">
                            <label for="osx-view">Library</label>
                            <cl-dropdown id="osx-view"
                                options="${this.viewOptions}"
                                value="${s.viewId}"
                                placeholder="Choose a library"
                                disabled="${!s.views.length}"
                                on-change="${(ev) => this.onViewChange(ev)}"></cl-dropdown>
                        </div>
                    </div>
                `)}

                ${when(s.notes.length > 0, () => html`
                    <div class="warn">
                        <strong>${s.notes.length} episode(s) could not use the subtitle track you chose.</strong>
                        ${s.notes.slice(0, 6).map((n) => n.name).join(', ')}${s.notes.length > 6 ? '…' : ''}
                    </div>
                `)}

                <div class="statusline row" style="align-items:center">
                    ${when(!!s.status, () => html`<span class="note">${s.status}</span>`)}
                    ${when(!!s.error, () => html`<span class="bad">${s.error}</span>`)}
                    ${when(s.busy, () => html`
                        <button class="act" on-click="${() => this.cancelCurrent()}">Cancel</button>
                    `)}
                </div>

                ${when(!!s.asking, () => html`
                    <div class="ask">
                        <h3>Before downloading ${s.asking.Name}</h3>
                        ${when(!!s.askSummary, () => html`<p class="note">${s.askSummary}</p>`)}

                        ${when(s.askTranscode, () => html`
                            <div class="warn">
                                <strong>This needs your server to transcode.</strong>
                                The file is ${s.askContainer || 'in a container'} that this browser
                                cannot play, so the server has to re-encode it — for every episode,
                                one after another. That is real work on the machine hosting your
                                library, and it may be slow or heavy for whoever else is using it.
                            </div>
                            <div class="field">
                                <label for="osx-quality">Transcode quality</label>
                                <cl-dropdown id="osx-quality"
                                    options="${this.qualityOptions}"
                                    value="${s.askQuality}"
                                    on-change="${(ev) => this.onAskQualityChange(ev)}"></cl-dropdown>
                            </div>
                        `)}

                        ${when(s.askPicture.length > 0 && s.askChoice === 'auto', () => html`
                            <div class="warn">
                                <strong>Picture-based subtitles will not be included.</strong>
                                ${s.askPicture.length} track(s) here are images rather than text
                                (${s.askPicture.map((t) => t.codec).join(', ')}), so they cannot be
                                extracted and will be absent offline unless you burn one in above.
                            </div>
                        `)}

                        ${when(s.askInconsistent, () => html`
                            <div class="warn">
                                <strong>These episodes do not describe their subtitles the same way.</strong>
                                Track numbering and languages differ between files in this show, so a
                                single choice cannot simply be applied to all of them. Whatever you
                                pick will be matched per episode by language and format; any episode
                                with no equivalent is downloaded without burned-in subtitles and
                                listed afterwards.
                            </div>
                        `)}

                        ${when(!!s.askServerWouldBurn, () => html`
                            <div class="warn">
                                <strong>Your server would have burned one in.</strong>
                                Left to itself it would encode
                                "${s.askServerWouldBurn.title}" into the picture permanently,
                                because it is the default track. This tool turns that off, so
                                nothing is burned in unless you choose it here.
                            </div>
                        `)}
                        ${when(s.askTracks.length > 0, () => html`
                            <p class="note">
                                This item has picture-based subtitles. They carry no text to
                                extract, so the only way to see them offline is to burn one track
                                into the video. That means transcoding, and it fixes the choice
                                for good.
                            </p>
                        `)}
                        ${when(s.askAudio.length > 0, () => html`
                            <p class="note">
                                This item has more than one audio track. A browser plays whichever
                                the file itself defaults to and cannot switch, so choosing another
                                one means transcoding, and it also fixes that choice for good.
                            </p>
                        `)}
                        ${when(s.askSeasons.length > 0, () => html`
                            <div class="field">
                                <label for="osx-season">Seasons</label>
                                <cl-dropdown id="osx-season"
                                    options="${this.askSeasonOptions}"
                                    value="${s.askSeasonId}"
                                    on-change="${(ev) => this.onAskSeasonChange(ev)}"></cl-dropdown>
                            </div>
                            <label class="check">
                                <input type="checkbox" id="osx-unwatched"
                                    checked="${s.askUnwatchedOnly}"
                                    on-change="${(ev) => this.onAskUnwatchedChange(ev)}">
                                <span>Only episodes I have not watched</span>
                            </label>
                        `)}
                        ${when(s.askTracks.length > 0, () => html`
                            <div class="field">
                                <label for="osx-subs">Subtitles</label>
                                <cl-dropdown id="osx-subs"
                                    options="${this.askOptions}"
                                    value="${s.askChoice}"
                                    on-change="${(ev) => this.onAskChange(ev)}"></cl-dropdown>
                            </div>
                        `)}
                        ${when(s.askAudio.length > 0, () => html`
                            <div class="field">
                                <label for="osx-audio">Audio</label>
                                <cl-dropdown id="osx-audio"
                                    options="${this.askAudioOptions}"
                                    value="${s.askAudioChoice}"
                                    on-change="${(ev) => this.onAskAudioChange(ev)}"></cl-dropdown>
                            </div>
                        `)}
                        ${when(s.askSeasons.length > 0, () => html`
                            <div>
                                <div class="bulkbar">
                                    ${when(!s.gridRows.length, () => html`
                                        <button class="act" on-click="${() => this.openGrid()}">
                                            Choose tracks per episode
                                        </button>
                                        <span class="note">
                                            ${s.gridProgress || 'Reads every episode from your server, once.'}
                                        </span>
                                    `)}
                                    ${when(s.gridRows.length > 0, () => html`
                                        <span class="note">Apply to all:</span>
                                        <button class="act" on-click="${() => this.applyBulk('subbed')}">Subbed</button>
                                        <button class="act" on-click="${() => this.applyBulk('dubbed')}">Dubbed</button>
                                        <button class="act" on-click="${() => this.applyBulk('track', { ordinal: 0 })}">First track</button>
                                        <button class="act" on-click="${() => this.applyBulk('track', { ordinal: 1 })}">Second track</button>
                                        <button class="act" on-click="${() => this.applyBulk('none')}">None</button>
                                        <button class="act" on-click="${() => this.closeGrid()}">Close</button>
                                    `)}
                                </div>
                                ${when(s.gridUnresolved > 0, () => html`
                                    <div class="warn">
                                        <strong>${s.gridUnresolved} episode(s) did not fit that rule.</strong>
                                        They are highlighted below; set them by hand, or apply a
                                        different rule. A rule never overwrites an answer it cannot
                                        improve on.
                                    </div>
                                `)}
                                ${when(s.gridRows.length > 0, () => html`
                                    <div class="panel scroller">
                                        <cl-virtual-list
                                            items="${this.gridView()}"
                                            itemHeight="${GRID_ROW_HEIGHT}"
                                            scrollContainer="parent"
                                            renderItem="${(row) => this.renderGridRow(row)}"
                                            keyFn="${(row) => row.id + ':' + row.subtitleIndex + ':' + row.audioIndex}"></cl-virtual-list>
                                    </div>
                                `)}
                            </div>
                        `)}

                        <div class="row">
                            <button class="act primary" on-click="${() => this.confirmAsk()}">Download</button>
                            <button class="act" on-click="${() => this.cancelAsk()}">Cancel</button>
                        </div>
                    </div>
                `)}

                ${when(!!s.viewId, () => html`
                    <div>
                        <div class="listhead">
                            <h3>Available to download</h3>
                            <span class="grow">
                                <input class="filter" type="search" id="osx-item-filter"
                                    placeholder="Type to filter this library"
                                    value="${s.itemFilter}"
                                    on-input="${(ev) => this.onItemFilter(ev)}">
                            </span>
                        </div>
                        <div class="panel scroller ${s.busy ? 'busy' : ''}"
                            on-scroll="${(ev) => this.onListScroll(ev)}">
                            ${when(!s.items.length, () => this.renderSkeletons())}
                            ${when(s.items.length > 0, () => html`
                                <cl-virtual-list
                                    items="${s.items}"
                                    itemHeight="${ROW_HEIGHT}"
                                    scrollContainer="parent"
                                    renderItem="${(item) => this.renderItem(item)}"
                                    keyFn="${(item) => item.Id}"></cl-virtual-list>
                            `)}
                        </div>
                        <div class="statusline" style="margin-top:.5em">
                            <span class="note">Showing ${s.items.length} of ${s.itemsTotal}</span>
                        </div>
                    </div>
                `)}

                <div>
                    <div class="listhead">
                        <h3>Downloaded</h3>
                        ${when(s.downloads.length > 4, () => html`
                            <span class="grow">
                                <input class="filter" type="search" id="osx-held-filter"
                                    placeholder="Type to find a download"
                                    value="${s.heldFilter}"
                                    on-input="${(ev) => this.onHeldFilter(ev)}">
                            </span>
                        `)}
                    </div>
                    ${when(!s.downloads.length, () => html`<p class="note">Nothing downloaded yet.</p>`)}
                    ${when(s.downloads.length > 0, () => html`
                        <div class="panel scroller ${s.busy ? 'busy' : ''}">
                            <cl-virtual-list
                                items="${this.downloadTree()}"
                                itemHeight="${ROW_HEIGHT}"
                                scrollContainer="parent"
                                emptyMessage="Nothing matches that."
                                renderItem="${(node) => this.renderNode(node)}"
                                keyFn="${(node) => node.id}"></cl-virtual-list>
                        </div>
                    `)}
                </div>

                ${this.renderStorage()}
                ${this.renderPrecache()}
            </div>
        `;
    }
}

defineComponent('offline-sync-manager', OfflineSyncManager);

export default class OfflineSyncPage {
    constructor(view) {
        this.view = view;
        this.mount = () => {
            const root = view.querySelector('#offlineSyncRoot');
            if (!root || root.firstElementChild) return;
            // Through the parser, NOT document.createElement. jellyfin-web bundles the
            // webcomponents ES5 shim, which patches document.createElement to build
            // elements its own way; a custom element made that way is never upgraded,
            // so connectedCallback runs against a bare HTMLElement and the component
            // throws before it renders. innerHTML upgrades natively.
            root.innerHTML = '<offline-sync-manager></offline-sync-manager>';
        };
        // viewshow fires on every navigation back to the page; the mount guard
        // above keeps that idempotent.
        view.addEventListener('viewshow', this.mount);
        this.mount();
    }
}
