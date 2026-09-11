/* Paste into the browser console on http://127.0.0.1:8099/web/ and send back the
 * single JSON blob it prints. Answers, in order: did the worker install, is it
 * controlling this page, did the bootstrap run, does the phantom server reply,
 * and does storage work at all.
 */
(async () => {
    const out = { ua: navigator.userAgent, url: location.href };
    const safe = async (name, fn) => {
        try { out[name] = await fn(); } catch (e) { out[name] = 'THREW: ' + (e && e.message || e); }
    };

    await safe('registrations', async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        return regs.map((r) => ({
            scope: r.scope,
            active: r.active && r.active.scriptURL,
            activeState: r.active && r.active.state,
            installing: !!r.installing,
            waiting: !!r.waiting
        }));
    });

    out.controlled = !!navigator.serviceWorker.controller;
    out.controllerUrl = navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL;
    out.bootstrapRan = !!window.PS_SCHEMA;
    out.bridgeReady = !!window.__phantom;
    out.socketShimmed = window.WebSocket && window.WebSocket.name;

    await safe('systemInfo', async () => {
        const r = await fetch('/System/Info/Public', { cache: 'no-store' });
        const text = await r.text();
        return { status: r.status, type: r.headers.get('Content-Type'), body: text.slice(0, 160) };
    });

    await safe('usersPublic', async () => {
        const r = await fetch('/Users/Public', { cache: 'no-store' });
        return { status: r.status, body: (await r.text()).slice(0, 120) };
    });

    await safe('storage', async () => ({
        opfs: typeof navigator.storage?.getDirectory === 'function',
        persisted: navigator.storage?.persisted ? await navigator.storage.persisted() : 'unsupported',
        estimate: navigator.storage?.estimate ? await navigator.storage.estimate() : 'unsupported',
        // createWritable is the one Firefox gated for longest; without it the
        // downloader cannot write a file at all.
        createWritable: typeof FileSystemFileHandle !== 'undefined'
            && typeof FileSystemFileHandle.prototype.createWritable === 'function'
    }));

    await safe('appServer', async () => {
        const creds = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
        return {
            servers: (creds.Servers || []).map((s) => ({
                id: s.Id, name: s.Name, address: s.ManualAddress, hasToken: !!s.AccessToken
            })),
            apiClient: window.ApiClient ? window.ApiClient.serverAddress() : null
        };
    });

    // Try to register by hand: a failure here carries the real reason, which the
    // app's own catch swallows into a log line.
    await safe('manualRegister', async () => {
        const r = await navigator.serviceWorker.register('/web/serviceworker.js');
        return { scope: r.scope, active: !!r.active };
    });

    console.log('PHANTOM DIAGNOSTIC\n' + JSON.stringify(out, null, 2));
    return out;
})();
