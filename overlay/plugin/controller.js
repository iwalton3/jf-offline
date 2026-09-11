/* Offline Sync settings page.
 *
 * jellyfin-web resolves the page's data-controller through importModule and
 * constructs this module's default export with (viewElement, params). The UI is
 * vdx-web: plain ES modules, no build step, nothing added to jellyfin-web.
 */

import { Component, defineComponent, html, each, when } from '/web/plugin/vdx-framework.js';
import { knownServers, SourceServer } from '/web/plugin/source.js';
import {
    downloadItem, downloadSeries, removeDownload, listDownloads, ensurePersistentStorage
} from '/web/plugin/downloader.js';

// One request to the source server per press of Load more. Large libraries are
// the normal case, so the list pages rather than truncating at some limit that
// looks like the whole library.
const PAGE = 100;

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
        downloads: [],
        held: [],
        storage: { usage: 0, quota: 0 },
        persisted: false,
        persistSupported: true,
        status: '',
        error: '',
        busy: false,
        loadingItems: false
    }

    static styles = /*css*/`
        .osx { display: flex; flex-direction: column; gap: 1.25em; }
        .osx-row { display: flex; flex-wrap: wrap; gap: .75em; align-items: flex-end; }
        .osx-field { display: flex; flex-direction: column; gap: .3em; min-width: 15em; }
        .osx-field label { font-size: .8em; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
        .osx-field select { padding: .5em; }
        .osx-note { opacity: .7; font-size: .9em; }
        .osx-error { color: #e08189; }
        .osx-list { display: flex; flex-direction: column; border: 1px solid rgba(128,128,128,.3); }
        .osx-item { display: flex; gap: .75em; align-items: center; padding: .55em .8em;
                    border-bottom: 1px solid rgba(128,128,128,.2); }
        .osx-item:last-child { border-bottom: none; }
        .osx-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .osx-tag { font-size: .75em; opacity: .65; text-transform: uppercase; letter-spacing: .06em; }
        .osx-bar { height: 4px; background: rgba(128,128,128,.25); width: 8em; }
        .osx-bar span { display: block; height: 100%; background: currentColor; }
        .osx-scroll { max-height: 26em; overflow-y: auto; }
        .osx h3 { margin: 0 0 .4em; }
    `;

    async mounted() {
        const servers = knownServers(window.PS_SCHEMA.ID.SERVER);
        this.state.servers = servers;
        if (servers.length === 1) {
            this.state.serverId = servers[0].id;
            await this.loadViews();
        }
        await this.refreshDownloads();
    }

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

    onServerChange(ev) {
        this.state.serverId = ev.target.value;
        this.state.views = [];
        this.state.viewId = '';
        this.state.items = [];
        this.state.itemsTotal = 0;
        if (this.state.serverId) this.loadViews();
    }

    onViewChange(ev) {
        this.state.viewId = ev.target.value;
        this.state.items = [];
        this.state.itemsTotal = 0;
        if (this.state.viewId) this.loadItems();
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
        const startIndex = append ? this.state.items.length : 0;
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
            // TotalRecordCount is what says there is more; the page length cannot,
            // because a full page is also what the last page looks like.
            this.state.itemsTotal = res.TotalRecordCount != null
                ? res.TotalRecordCount
                : this.state.items.length;
        });
        this.state.loadingItems = false;
    }

    loadMore() {
        this.loadItems(true);
    }

    download(item) {
        const server = this.server();
        // Asked here, in the click handler, because Firefox only grants persistence
        // in response to a user gesture. Without it the browser is free to evict
        // the whole library the moment it wants the space back.
        const persisting = ensurePersistentStorage();
        this.guard(`Downloading ${item.Name}`, async () => {
            const grant = await persisting;
            this.state.persisted = grant.persisted;
            this.state.persistSupported = grant.supported;
            if (item.Type === 'Series') {
                const result = await downloadSeries(server, item, (done, total, unit, name) => {
                    this.state.status = `${item.Name}: ${done}/${total} ${unit}` + (name ? ` — ${name}` : '');
                });
                if (result.failures.length) {
                    this.state.error = `${result.failures.length} of ${result.episodes} episodes failed: `
                        + result.failures.map((f) => f.name).join(', ');
                }
            } else {
                await downloadItem(server, item, (done, total, unit) => {
                    this.state.status = unit === 'bytes'
                        ? `${item.Name}: ${fmtBytes(done)}${total ? ' of ' + fmtBytes(total) : ''}`
                        : `${item.Name}: segment ${done} of ${total}`;
                });
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
        this.state.persistSupported = grant.supported;
    }

    renderStorage() {
        const { usage, quota } = this.state.storage;
        const pct = quota ? Math.min(100, (usage / quota) * 100) : 0;
        return html`
            <div class="osx-note">
                Using ${fmtBytes(usage)} of ${fmtBytes(quota)} available to this site
                <div class="osx-bar" style="width:100%;margin-top:.35em">
                    <span style="width:${pct.toFixed(1)}%"></span>
                </div>
            </div>
            ${when(this.state.persisted, () => html`
                <p class="osx-note">Storage is persistent. Downloads survive until you remove them.</p>
            `)}
            ${when(!this.state.persisted, () => html`
                <div class="osx-row" style="align-items:center">
                    <span class="osx-error">
                        Storage is not persistent — the browser may delete downloads to reclaim space.
                    </span>
                    <button class="emby-button raised" on-click="${() => this.requestPersistence()}">
                        Make persistent
                    </button>
                </div>
            `)}
        `;
    }

    template() {
        const s = this.state;
        return html`
            <div class="osx">
                ${when(!s.servers.length, () => html`
                    <p class="osx-note">
                        No other servers are signed in yet. Add your Jellyfin server from the
                        server selection screen and sign in, then come back here.
                    </p>
                `)}

                ${when(s.servers.length > 0, () => html`
                    <div class="osx-row">
                        <div class="osx-field">
                            <label for="osx-server">Source server</label>
                            <select id="osx-server" on-change="${this.onServerChange}">
                                <option value="">Choose a server</option>
                                ${each(s.servers, (srv) => html`
                                    <option value="${srv.id}" selected="${srv.id === s.serverId}">${srv.name}</option>
                                `)}
                            </select>
                        </div>
                        <div class="osx-field">
                            <label for="osx-view">Library</label>
                            <select id="osx-view" on-change="${this.onViewChange}" disabled="${!s.views.length}">
                                <option value="">Choose a library</option>
                                ${each(s.views, (v) => html`
                                    <option value="${v.Id}" selected="${v.Id === s.viewId}">${v.Name}</option>
                                `)}
                            </select>
                        </div>
                    </div>
                `)}

                ${when(!!s.status, () => html`<p class="osx-note">${s.status}</p>`)}
                ${when(!!s.error, () => html`<p class="osx-error">${s.error}</p>`)}

                ${when(s.items.length > 0, () => html`
                    <div>
                        <h3>Available to download</h3>
                        <div class="osx-list osx-scroll">
                            ${each(s.items, (item) => html`
                                <div class="osx-item">
                                    <span class="osx-item-name">${item.Name}</span>
                                    <span class="osx-tag">${item.Type}${item.ProductionYear ? ' · ' + item.ProductionYear : ''}</span>
                                    ${when(s.held.includes(item.Id), () => html`<span class="osx-tag">held</span>`)}
                                    <button
                                        class="emby-button raised"
                                        disabled="${s.busy}"
                                        on-click="${() => this.download(item)}"
                                    >Download</button>
                                </div>
                            `, (item) => item.Id)}
                        </div>
                        <div class="osx-row" style="margin-top:.6em;align-items:center">
                            <span class="osx-note">
                                Showing ${s.items.length} of ${s.itemsTotal}
                            </span>
                            ${when(s.items.length < s.itemsTotal, () => html`
                                <button
                                    class="emby-button raised"
                                    disabled="${s.busy || s.loadingItems}"
                                    on-click="${() => this.loadMore()}"
                                >Load more</button>
                            `)}
                        </div>
                    </div>
                `)}

                <div>
                    <h3>Downloaded</h3>
                    ${this.renderStorage()}
                    ${when(!s.downloads.length, () => html`<p class="osx-note">Nothing downloaded yet.</p>`)}
                    ${when(s.downloads.length > 0, () => html`
                        <div class="osx-list osx-scroll" style="margin-top:.6em">
                            ${each(s.downloads, (row) => html`
                                <div class="osx-item">
                                    <span class="osx-item-name">${row.name || row.itemId}</span>
                                    <span class="osx-tag">${row.type} · ${row.mode} · ${fmtBytes(row.bytesDone)}</span>
                                    <span class="osx-tag">${row.state}</span>
                                    ${when(!!row.error, () => html`<span class="osx-error">${row.error}</span>`)}
                                    <button
                                        class="emby-button raised"
                                        disabled="${s.busy}"
                                        on-click="${() => this.removeHeld(row)}"
                                    >Remove</button>
                                </div>
                            `, (row) => row.srv + row.itemId + row.sourceId)}
                        </div>
                    `)}
                </div>
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
