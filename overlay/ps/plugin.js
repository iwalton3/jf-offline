/* The Offline Sync "plugin", which is how the download manager gets a UI.
 *
 * jellyfin-web's dashboard renders a plugin's settings page by fetching HTML from
 * /web/configurationpage?name=X (routes.tsx:49 -> ServerContentPage) and then
 * resolving the page's data-controller attribute through importModule against
 * /web/configurationpage?name=X.js (viewContainer.js:22). Both come from the
 * server, so serving them here puts our own UI inside the app with no change to
 * jellyfin-web at all.
 *
 * Service worker only.
 */
(function (g) {
    'use strict';

    const { json, text, notFound } = g.PS_HTTP;

    const PLUGIN_ID = '0ff11e00-0000-0000-0000-00000000a020';
    const PAGE_NAME = 'offlinesync';

    const PLUGIN_INFO = {
        Name: 'Offline Sync',
        Id: PLUGIN_ID,
        Version: '0.1.0',
        ConfigurationFileName: null,
        Description: 'Downloads media from your other servers into this browser.',
        CanUninstall: false,
        HasImage: false,
        Status: 'Active'
    };

    const PAGE_INFO = {
        Name: PAGE_NAME,
        EnableInMainMenu: true,
        DisplayName: 'Offline Sync',
        MenuSection: 'server',
        MenuIcon: 'cloud_download',
        PluginId: PLUGIN_ID
    };

    /** Network first so edits land, cache second so being offline is not fatal. */
    async function readOverlayFile(path) {
        try {
            const res = await fetch(path, { cache: 'no-store' });
            if (res.ok) return res.text();
        } catch {
            // offline; fall through
        }
        const cached = await caches.match(path);
        return cached ? cached.text() : null;
    }

    const plugins = () => json([PLUGIN_INFO]);

    const configurationPages = () => json([PAGE_INFO]);

    // globalize.translateHtml() walks this looking for ${Token} and substitutes
    // translations, so the markup must contain no ${ sequence of its own.
    const PAGE_HTML = `<div id="offlineSyncPage" data-role="page" class="page type-interior pluginConfigurationPage"
     data-controller="__plugin/${PAGE_NAME}.js">
    <div data-role="content">
        <div class="content-primary">
            <div class="verticalSection">
                <h2 class="sectionTitle">Offline Sync</h2>
                <p class="fieldDescription" style="margin-bottom:1em">
                    Media downloaded here is served by a service worker in this browser,
                    so it plays with no network at all.
                </p>
            </div>
            <div id="offlineSyncRoot"></div>
        </div>
    </div>
</div>`;

    async function page(ctx, name) {
        if (name === PAGE_NAME) {
            return text(PAGE_HTML, 'text/html; charset=utf-8');
        }
        if (name === PAGE_NAME + '.js') {
            // A shim, not the module itself. jellyfin-web insists on loading a
            // plugin controller from configurationpage?name=…, a URL that only
            // exists inside this worker; the manager proper lives at a real file
            // so that ps-ui.js can import it on a first visit, before the worker
            // controls anything. Generated rather than stored, so there is no
            // second copy to drift.
            // A static re-export, not a dynamic import: the module graph is then
            // fetched in parallel with no top-level await, which is a round trip
            // the plugin page would otherwise spend before it can render.
            const url = g.PS_SCHEMA.basePath + '/web/plugin/manager.js';
            return text(
                `export { default } from '${url}';\n`,
                'text/javascript; charset=utf-8'
            );
        }
        return notFound('configuration page ' + name);
    }

    g.PS_PLUGIN = { plugins, configurationPages, page, PLUGIN_ID, PAGE_NAME };
})(self);
