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
    ensurePersistentStorage, inspectSubtitles
} from '/web/plugin/downloader.js';

// One request per press of Load more, and per automatic top-up when the list is
// scrolled near its end.
const PAGE = 100;
const ROW_HEIGHT = 52;
const LIST_HEIGHT = 420;
// Start the next page while this much already-loaded list remains, so the fetch
// is usually finished before the user reaches the bottom.
const SCROLL_THRESHOLD = ROW_HEIGHT * 6;

const fmtBytes = (n) => {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
};

class OfflineSyncManager extends Component {
    state = {
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
        // The subtitle question, asked about one item at a time.
        asking: null,
        askTracks: [],
        askChoice: 'auto'
    };

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
        .field { display: flex; flex-direction: column; gap: .35em; min-width: 16em; flex: 1 1 16em; }
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
        }

        .scroller {
            height: ${LIST_HEIGHT}px;
            overflow-y: auto;
            overscroll-behavior: contain;
        }

        .item {
            display: flex; align-items: center; gap: .75em;
            height: ${ROW_HEIGHT}px;
            padding: 0 .85em;
            border-bottom: 1px solid var(--border-color);
            box-sizing: border-box;
        }
        .item:last-child { border-bottom: none; }
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
        this.state.storage = await window.PS_OPFS.usage();
        this.state.persisted = navigator.storage && navigator.storage.persisted
            ? await navigator.storage.persisted()
            : false;
    }

    async guard(label, fn) {
        this.state.busy = true;
        this.state.error = '';
        this.state.status = label;
        try {
            await fn();
        } catch (err) {
            console.error('[offline sync]', err);
            this.state.error = String(err && err.message || err);
        } finally {
            this.state.busy = false;
            this.state.status = '';
        }
    }

    async loadViews() {
        await this.guard('Loading libraries', async () => {
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
        await this.guard(startIndex ? 'Loading more' : 'Loading items', async () => {
            const res = await this.server().items({
                ParentId: view.Id,
                IncludeItemTypes: view.CollectionType === 'movies' ? 'Movie' : 'Series',
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

    loadMore() {
        this.loadItems(true);
    }

    /** Top up before the list runs out, so scrolling never stops at a boundary. */
    onListScroll(ev) {
        const el = ev.currentTarget;
        if (!el) return;
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
    start(item) {
        const server = this.server();
        this.guard(`Checking ${item.Name}`, async () => {
            // A series is asked about once, using its first episode as the sample.
            const sample = item.Type === 'Series'
                ? ((await server.episodes(item.Id)).Items || [])[0]
                : item;
            if (!sample) throw new Error('series has no episodes');

            const { tracks } = await inspectSubtitles(server, sample);
            if (!tracks.some((t) => !t.canExtract)) {
                await this.run(item, { mode: 'auto' });
                return;
            }
            this.state.askTracks = tracks;
            this.state.askChoice = 'auto';
            this.state.asking = item;
        });
    }

    confirmAsk() {
        const item = this.state.asking;
        const choice = this.state.askChoice;
        this.state.asking = null;
        const subtitle = choice === 'auto' || choice === 'none'
            ? { mode: choice }
            : { mode: 'burn', index: Number(choice) };
        this.run(item, subtitle);
    }

    cancelAsk() {
        this.state.asking = null;
    }

    onAskChange(ev) {
        this.state.askChoice = ev.detail ? ev.detail.value : ev.target.value;
    }

    // --- downloading ------------------------------------------------------

    run(item, subtitle) {
        const server = this.server();
        // Asked on the gesture, because Firefox only grants persistence while
        // handling one. Without it the browser may evict the whole library.
        const persisting = ensurePersistentStorage();
        return this.guard(`Downloading ${item.Name}`, async () => {
            const grant = await persisting;
            this.state.persisted = grant.persisted;

            const onProgress = (done, total, unit, name) => {
                this.state.status = unit === 'bytes'
                    ? `${item.Name}: ${fmtBytes(done)}${total ? ' of ' + fmtBytes(total) : ''}`
                    : `${item.Name}: ${done} of ${total} ${unit}${name ? ' — ' + name : ''}`;
            };

            if (item.Type === 'Series') {
                const result = await downloadSeries(server, item, { subtitle, onProgress });
                if (result.failures.length) {
                    this.state.error = `${result.failures.length} of ${result.episodes} episodes failed: `
                        + result.failures.map((f) => f.name).join(', ');
                }
            } else {
                await downloadItem(server, item, { subtitle, onProgress });
            }
            await this.refreshDownloads();
            await window.__phantom.libraryChanged();
        });
    }

    removeHeld(row) {
        this.guard(`Removing ${row.name || row.itemId}`, async () => {
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
            { label: 'Extract text tracks as subtitles', value: 'auto' },
            { label: 'No subtitles', value: 'none' }
        ];
        for (const t of this.state.askTracks) {
            if (t.canExtract) continue;
            opts.push({ label: `Burn in: ${t.title} (${t.codec})`, value: String(t.index) });
        }
        return opts;
    }

    renderItem(item) {
        const held = this.state.held.includes(item.Id);
        return html`
            <div class="item">
                <span class="name">${item.Name}</span>
                <span class="tag">${item.Type}${item.ProductionYear ? ' · ' + item.ProductionYear : ''}</span>
                ${when(held, () => html`<span class="tag held">held</span>`)}
                <button class="act" disabled="${this.state.busy}"
                    on-click="${() => this.start(item)}">Download</button>
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
        const { usage, quota } = this.state.storage;
        const pct = quota ? Math.min(100, (usage / quota) * 100) : 0;
        return html`
            <div>
                <h3>Storage</h3>
                <p class="note">Using ${fmtBytes(usage)} of ${fmtBytes(quota)} available to this site</p>
                <div class="bar" style="margin-top:.4em"><span style="width:${pct.toFixed(1)}%"></span></div>
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

                <div class="statusline">
                    ${when(!!s.status, () => html`<span class="note">${s.status}</span>`)}
                    ${when(!!s.error, () => html`<span class="bad">${s.error}</span>`)}
                </div>

                ${when(!!s.asking, () => html`
                    <div class="ask">
                        <h3>Subtitles for ${s.asking.Name}</h3>
                        <p class="note">
                            This item has picture-based subtitles. They carry no text to extract,
                            so the only way to see them offline is to burn one track into the
                            video. That means transcoding, and it fixes the choice for good.
                        </p>
                        <div class="field">
                            <label for="osx-subs">Subtitles</label>
                            <cl-dropdown id="osx-subs"
                                options="${this.askOptions}"
                                value="${s.askChoice}"
                                on-change="${(ev) => this.onAskChange(ev)}"></cl-dropdown>
                        </div>
                        <div class="row">
                            <button class="act primary" on-click="${() => this.confirmAsk()}">Download</button>
                            <button class="act" on-click="${() => this.cancelAsk()}">Cancel</button>
                        </div>
                    </div>
                `)}

                ${when(!!s.viewId, () => html`
                    <div>
                        <h3>Available to download</h3>
                        <div class="panel scroller" on-scroll="${(ev) => this.onListScroll(ev)}">
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
                        <div class="row" style="margin-top:.6em; align-items:center">
                            <span class="note">Showing ${s.items.length} of ${s.itemsTotal}</span>
                            ${when(s.items.length < s.itemsTotal, () => html`
                                <button class="act" disabled="${s.busy || s.loadingItems}"
                                    on-click="${() => this.loadMore()}">Load more</button>
                            `)}
                        </div>
                    </div>
                `)}

                <div>
                    <h3>Downloaded</h3>
                    ${when(!s.downloads.length, () => html`<p class="note">Nothing downloaded yet.</p>`)}
                    ${when(s.downloads.length > 0, () => html`
                        <div class="panel" style="max-height:${LIST_HEIGHT}px; overflow-y:auto">
                            ${each(s.downloads, (row) => html`
                                <div class="item">
                                    <span class="name">${row.name || row.itemId}</span>
                                    <span class="tag">${row.mode} · ${fmtBytes(row.bytesDone)}</span>
                                    ${when(!!(row.subtitles && row.subtitles.length), () => html`
                                        <span class="tag">${row.subtitles.length} subs</span>
                                    `)}
                                    ${when(row.burnedSubtitleIndex != null, () => html`
                                        <span class="tag held">burned in</span>
                                    `)}
                                    <span class="tag">${row.state}</span>
                                    <button class="act" disabled="${s.busy}"
                                        on-click="${() => this.removeHeld(row)}">Remove</button>
                                </div>
                            `, (row) => row.srv + row.itemId + row.sourceId)}
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
