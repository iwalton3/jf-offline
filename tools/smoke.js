/* End-to-end smoke test for the phantom server.
 *
 * Drives a real browser against the dev host, because every interesting part of
 * this only exists inside a service worker and none of it can be exercised in
 * node. Needs the dev host on 8099 and a real Jellyfin server on 8096.
 *
 *   NODE_PATH=/working/mrepo-web/tests/node_modules node tools/smoke.js
 *   HEADFUL=1 ... to watch it
 */
const puppeteer = require('puppeteer');

const APP = process.env.PHANTOM_APP || 'http://127.0.0.1:8099';
const SOURCE = process.env.JF_BASE || 'http://127.0.0.1:8096';
const USER = process.env.JF_USER || 'qa-user';
const PASS = process.env.JF_PASS || 'stdjflib';
// A single-source mp4 of h264/aac, so the direct path is covered as well as the
// transcode path. Single-source matters: most of the QA library is multi-version,
// and those list an mkv first.
const DIRECT_ITEM = process.env.JF_DIRECT_ITEM || '564f0e0061169c95971a719eb87891f6';
// Nine extractable subrip tracks, and one with only a picture-based track.
const SUBTITLE_ITEM = process.env.JF_SUBTITLE_ITEM || '585d3907f46356aceeecff57c7f4f030';
const BURN_ITEM = process.env.JF_BURN_ITEM || 'b7e1d10a787bf92cbb75f4ffef2a8197';
// A styled ASS track with the font it was authored against embedded alongside.
const ASS_ITEM = process.env.JF_ASS_ITEM || 'c481c35858cfe4b4ec22187d8c96dc92';
// Six audio tracks, container default index 1.
const MULTI_AUDIO_ITEM = process.env.JF_AUDIO_ITEM || 'c72448f6b10acfae9edd95c2b1d06775';
// One subtitle track, flagged forced.
const FORCED_SUB_ITEM = process.env.JF_FORCED_ITEM || '7eda0c4da7bb755f0e6ef4f6e84caad8';
// h264 in an mkv, 1920x804 — taller than the default 720p cap, so a cap that is
// sent when it should not be is visible in the output rather than a no-op.
const REMUX_TALL_ITEM = process.env.JF_REMUX_ITEM || '1531031ad1fb4f42b9bcd819c42f2760';
// h264 picture, DTS 5.1 sound: the picture is copied and only the sound converted.
const REMUX_FOREIGN_AUDIO_ITEM = process.env.JF_REMUX_AUDIO_ITEM || '443e17b426971cdc8c7d4d3dd1ff14cf';
// hevc, which the transcoding profile cannot target, so it is genuinely re-encoded.
const REENCODE_ITEM = process.env.JF_REENCODE_ITEM || '0a7fa7476a1ee92a53e895d4618ad76a';
// Three seasons, sixty episodes: enough to tell a season filter from no filter.
const MULTI_SEASON_SERIES = process.env.JF_SERIES || '2f9ea3e079631ea97fae6ebadb569063';
// One season, one episode: cheap to hold so later checks have a real series.
const SMALL_SERIES = process.env.JF_SMALL_SERIES || '5b12d67700af1f19b8764804c7788343';
// Two trickplay sheets, one media source, and used by nothing else, so a tile
// fetch can be failed part way through without disturbing another check.
const PARTIAL_TRICKPLAY_ITEM = process.env.JF_PARTIAL_TP_ITEM || 'c36e4717f55e81c0fc64269a5fe83ca8';
// Three media sources on one episode. The downloader keeps one, and the stored
// DTO must not go on offering the other two.
const MULTI_VERSION_ITEM = process.env.JF_MULTIVERSION_ITEM || '8067b51b1997c74ed5be368b49aab7e4';
// Six episodes of 73 KB in one real season folder. Multi-episode matters: a
// parent entry copied from its child is indistinguishable from a correct one
// when the parent has exactly one child.
const PARENT_SERIES = process.env.JF_PARENT_SERIES || 'a55eda8ece2cbb424daaadd6cdbb8960';
// Accounts whose Jellyfin policy withholds one of the two permissions a
// download needs, so the gate is tested against a real refusal.
const NO_DOWNLOAD_USER = process.env.JF_NODL_USER || 'qa-nodownload';
const NO_TRANSCODE_USER = process.env.JF_NOTC_USER || 'qa-notranscode';
const HEADFUL = !!process.env.HEADFUL;

const results = [];
const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        headless: HEADFUL ? false : 'new',
        args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });

    const consoleErrors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
        if (process.env.VERBOSE) console.log('   [page]', msg.type(), msg.text().slice(0, 200));
    });
    page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

    // ---- 1. install ------------------------------------------------------

    await page.goto(`${APP}/web/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(
        () => navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active)),
        { timeout: 30000 }
    ).catch(() => {});
    check('jellyfin-web registers the phantom worker by itself',
        await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active));

    // The first visit, before any reload. The app probes for a server during boot
    // and registers the worker only afterwards, so if nothing answers that probe
    // it settles on "no servers" and never retries. The host answering
    // /System/Info/Public is what makes this pass.
    await sleep(3000);
    const firstVisit = await page.evaluate(() => ({
        servers: (JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}').Servers || []).length,
        bootstrap: !!window.PS_SCHEMA,
        address: window.ApiClient ? window.ApiClient.serverAddress() : null
    }));
    check('the first visit finds the phantom server with no reload',
        firstVisit.servers === 1, `${firstVisit.servers} server(s), address ${firstVisit.address}`);
    check('the bootstrap is present on the first visit', firstVisit.bootstrap === true);

    // Everything before this point ran with no worker, so the app's own probe of
    // /System/Info/Public reached the dev host and was refused. Expected once.
    const firstLoadErrors = consoleErrors.length;

    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 20000 }).catch(() => {});
    check('worker controls the page', await page.evaluate(() => !!navigator.serviceWorker.controller));
    check('bootstrap injected into index.html',
        await page.evaluate(() => !!window.__phantom && !!window.PS_SCHEMA));
    check('WebSocket is shimmed',
        await page.evaluate(() => window.WebSocket.name === 'WebSocketShim'));

    // ---- 2. the phantom server is a server -------------------------------

    const info = await page.evaluate(async () => (await fetch('/System/Info/Public')).json());
    check('System/Info/Public answered from storage',
        info && info.ProductName === 'Phantom Jellyfin Server', info && info.ServerName);

    const publicUsers = await page.evaluate(async () => (await fetch('/Users/Public')).json());
    check('one public user, no password',
        Array.isArray(publicUsers) && publicUsers.length === 1 && publicUsers[0].HasPassword === false);

    await page.waitForFunction(() => !!window.ApiClient, { timeout: 30000 });
    const signedIn = await page.evaluate(async () => {
        const r = await window.ApiClient.authenticateUserByName('Offline', '');
        return { id: r.User?.Id, admin: r.User?.Policy?.IsAdministrator };
    }).catch((e) => ({ error: e.message }));
    check('sign in through the app\'s own client', !!signedIn.id, signedIn.error || signedIn.id);
    check('the offline user is an administrator', signedIn.admin === true);

    const emptyViews = await page.evaluate(async () =>
        (await fetch('/UserViews?userId=' + window.ApiClient.getCurrentUserId())).json());
    check('an empty library is a well-formed empty list',
        Array.isArray(emptyViews.Items) && emptyViews.Items.length === 0);

    // ---- 3. a source server the downloader can reach ---------------------

    const added = await page.evaluate(async (base, user, pass) => {
        const probe = await fetch(base + '/System/Info/Public').then((r) => r.json()).catch(() => null);
        if (!probe) return { error: 'source server unreachable' };
        const auth = await (await fetch(base + '/Users/AuthenticateByName', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'MediaBrowser Client="Offline Sync", Device="Browser", DeviceId="phantom-downloader", Version="0.1.0"'
            },
            body: JSON.stringify({ Username: user, Pw: pass })
        })).json();
        const creds = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
        creds.Servers = creds.Servers || [];
        creds.Servers = creds.Servers.filter((s) => s.Id !== auth.ServerId);
        creds.Servers.push({
            ManualAddress: base, Id: auth.ServerId, UserId: auth.User.Id,
            AccessToken: auth.AccessToken, Name: probe.ServerName,
            LastConnectionMode: 2, DateLastAccessed: Date.now()
        });
        localStorage.setItem('jellyfin_credentials', JSON.stringify(creds));
        return { serverId: auth.ServerId, name: probe.ServerName };
    }, SOURCE, USER, PASS);
    check('source server visible to the downloader', !!added.serverId, added.error || added.name);

    const phantomId = await page.evaluate(() => window.PS_SCHEMA.ID.SERVER);

    // ---- 4. download both ways -------------------------------------------

    const download = (itemId) => page.evaluate(async (pid, id) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem } = await import('/web/plugin/downloader.js');
        const servers = knownServers(pid);
        if (!servers.length) return { error: 'no source servers' };
        const server = new SourceServer(servers[0]);
        const item = id
            ? await server.item(id)
            : (await server.items({ IncludeItemTypes: 'Movie', Limit: 1, SortBy: 'SortName' })).Items[0];
        if (!item) return { error: 'nothing to download' };
        try {
            const row = await downloadItem(server, item, {});
            return { name: item.Name, id: item.Id, mode: row.mode, state: row.state, bytes: row.bytesDone, segments: row.segments };
        } catch (err) {
            return { error: String(err.message || err), name: item.Name, id: item.Id };
        }
    }, phantomId, itemId);

    const hls = await download(null);
    check('download an item the browser cannot play (transcode path)',
        hls.state === 'complete' && hls.mode === 'hls',
        hls.error || `${hls.name} · ${hls.mode} · ${hls.segments} segments · ${hls.bytes} bytes`);

    const direct = await download(DIRECT_ITEM);
    check('download an item the browser can play (original file)',
        direct.state === 'complete' && direct.mode === 'direct',
        direct.error || `${direct.name} · ${direct.mode} · ${direct.bytes} bytes`);

    // The settings page holds its list in vdx reactive state, so the item handed to
    // the downloader is a Proxy — which IndexedDB refuses to clone. A download
    // driven by a plain fetch never sees it.
    const viaUi = await page.evaluate(async (pid) => {
        const { reactive } = await import('/web/plugin/vdx/lib/framework.js');
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const res = await server.items({ IncludeItemTypes: 'Movie', Limit: 2, SortBy: 'SortName' });
        const state = reactive({ items: res.Items });
        try {
            const row = await downloadItem(server, state.items[state.items.length - 1], {});
            return { ok: true, state: row.state };
        } catch (err) {
            return { ok: false, error: String(err.message || err) };
        }
    }, phantomId);
    check('downloading an item held in reactive UI state', viaUi.ok && viaUi.state === 'complete',
        viaUi.error || viaUi.state);

    const persistence = await page.evaluate(async () => {
        const { ensurePersistentStorage } = await import('/web/plugin/downloader.js');
        return ensurePersistentStorage();
    });
    check('persistent storage is requested and reported', persistence.supported === true,
        `supported=${persistence.supported} persisted=${persistence.persisted}`);

    // ---- 5. the library is now browsable ---------------------------------

    const after = await page.evaluate(async () => {
        const uid = window.ApiClient.getCurrentUserId();
        const views = await (await fetch('/UserViews?userId=' + uid)).json();
        const items = await (await fetch('/Items?userId=' + uid + '&Recursive=true')).json();
        const latest = await (await fetch('/Items/Latest?userId=' + uid + '&limit=10')).json();
        return {
            views: views.Items.map((v) => v.Name),
            total: items.TotalRecordCount,
            serverIds: [...new Set(items.Items.map((i) => i.ServerId))],
            latestIsArray: Array.isArray(latest)
        };
    });
    check('views appear for what is held', after.views.length >= 1, after.views.join(','));
    check('top-level query returns the held items', after.total >= 1, String(after.total));
    check('items are re-homed onto the phantom server',
        after.serverIds.length === 1 && after.serverIds[0] === phantomId, after.serverIds.join(','));
    check('Items/Latest answers with a bare array', after.latestIsArray);

    // Paging, against a library big enough for it to matter. Seeded directly and
    // removed again, because the point is the query engine, not the downloader.
    // Seeded as movies, not series: a series with no episodes is deliberately not
    // presented, so synthetic parents would be filtered out before paging ran.
    const paging = await page.evaluate(async (viewMovies) => {
        const SEED = 250;
        const rows = [];
        for (let i = 0; i < SEED; i++) {
            const id = 'aaaa' + String(i).padStart(28, '0');
            rows.push({
                srv: 'seed', id, type: 'Movie',
                dto: {
                    Id: id, Name: 'Seeded Film ' + String(i).padStart(3, '0'),
                    SortName: 'Seeded Film ' + String(i).padStart(3, '0'),
                    Type: 'Movie', MediaType: 'Video', IsFolder: false,
                    ServerId: 'seed', ImageTags: {}, BackdropImageTags: []
                },
                seriesId: null, seasonId: null, addedAt: Date.now() + i
            });
        }
        await window.PS_DB.putMany('items', rows);

        const get = async (start, limit) => (await (await fetch(
            `/Items?ParentId=${viewMovies}&IncludeItemTypes=Movie&SortBy=SortName&StartIndex=${start}&Limit=${limit}`
        )).json());

        const first = await get(0, 100);
        const second = await get(100, 100);
        const third = await get(200, 100);
        const beyond = await get(1000, 100);

        const seen = new Set([...first.Items, ...second.Items, ...third.Items].map((i) => i.Id));
        const pageCount = first.Items.length + second.Items.length + third.Items.length;

        for (const r of rows) await window.PS_DB.del('items', ['seed', r.id]);

        return {
            total: first.TotalRecordCount,
            counts: [first.Items.length, second.Items.length, third.Items.length],
            startIndexEchoed: second.StartIndex,
            distinct: seen.size,
            pageCount,
            overlap: first.Items[0].Id === second.Items[0].Id,
            beyondEnd: beyond.Items.length,
            firstName: first.Items[0].Name,
            secondName: second.Items[0].Name
        };
    }, await page.evaluate(() => window.PS_SCHEMA.ID.VIEW_MOVIES));

    check('a large library reports its full total', paging.total >= 250, String(paging.total));
    check('pages are full and consecutive', paging.counts[0] === 100 && paging.counts[1] === 100,
        paging.counts.join(','));
    check('pages do not repeat', !paging.overlap && paging.distinct === paging.pageCount,
        `${paging.distinct} distinct of ${paging.pageCount} returned across 3 pages`);
    check('a start index past the end returns empty, not the first page', paging.beyondEnd === 0,
        String(paging.beyondEnd));

    // ---- 6. media actually serves ----------------------------------------

    const mediaFor = (itemId) => page.evaluate(async (id) => {
        const info = await (await fetch(`/Items/${id}/PlaybackInfo`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ DeviceProfile: {} })
        })).json();
        const ms = info.MediaSources[0];
        if (!ms) return { error: 'no media source offered' };

        if (ms.SupportsDirectPlay) {
            const url = `/Videos/${id}/stream.${ms.Container}?Static=true`;
            const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });
            const body = await res.arrayBuffer();
            const whole = await fetch(url);
            return {
                mode: 'direct', url,
                status: res.status,
                contentRange: res.headers.get('Content-Range'),
                bytes: body.byteLength,
                fullStatus: whole.status,
                fullLength: (await whole.arrayBuffer()).byteLength
            };
        }

        const playlistRes = await fetch(ms.TranscodingUrl);
        const playlist = await playlistRes.text();
        const first = playlist.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
        const seg = await fetch(first, { headers: { Range: 'bytes=0-99' } });
        const segBody = await seg.arrayBuffer();
        return {
            mode: 'hls', url: ms.TranscodingUrl,
            playlistStatus: playlistRes.status,
            playlistType: playlistRes.headers.get('Content-Type'),
            vod: playlist.includes('#EXT-X-ENDLIST'),
            rewritten: !!first && first.startsWith('/videos/'),
            status: seg.status,
            contentRange: seg.headers.get('Content-Range'),
            bytes: segBody.byteLength
        };
    }, itemId);

    const d = await mediaFor(direct.id);
    check('original file serves a 206 with Content-Range',
        d.status === 206 && !!d.contentRange, `${d.status} ${d.contentRange}`);
    check('a range returns exactly the bytes asked for', d.bytes === 100, String(d.bytes));
    check('an unranged read returns the whole file',
        d.fullStatus === 200 && d.fullLength === direct.bytes, `${d.fullLength} of ${direct.bytes}`);

    const h = await mediaFor(hls.id);
    check('stored playlist serves as HLS', h.playlistStatus === 200 && /mpegurl/i.test(h.playlistType || ''), h.playlistType);
    check('stored playlist is a complete VOD stream', h.vod === true);
    check('segment URIs are rewritten to the phantom server', h.rewritten === true);
    check('segments serve ranged', h.status === 206 && h.bytes === 100, `${h.status} ${h.bytes}`);

    // The assumption the whole design rests on: a real media element, not fetch.
    const decoded = await page.evaluate(async (url) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.src = url;
        document.body.appendChild(v);
        return new Promise((resolve) => {
            v.onloadedmetadata = () => resolve({ ok: true, duration: v.duration });
            v.onerror = () => resolve({ ok: false, error: v.error && v.error.message });
            setTimeout(() => resolve({ ok: false, error: 'timed out' }), 15000);
        });
    }, d.url);
    check('a <video> element loads metadata from the worker',
        decoded.ok && decoded.duration > 0, decoded.error || `duration ${decoded.duration}s`);

    // The real proof: playback started by the app itself, through its own detail
    // page and its own player, rather than a URL we fetched by hand.
    async function playThroughApp(itemId, label) {
        await page.goto(`${APP}/web/#/details?id=${itemId}`, { waitUntil: 'networkidle2', timeout: 45000 });
        await sleep(3500);
        const clicked = await page.evaluate(() => {
            const candidates = [...document.querySelectorAll('button, .button-flat, .cardOverlayButton')]
                .filter((b) => /play/i.test(b.getAttribute('data-action') || '')
                    || /btnPlay|btnResume/.test(b.className)
                    || /play_arrow/.test(b.textContent));
            const btn = candidates.find((b) => b.offsetParent !== null) || candidates[0];
            if (!btn) return false;
            btn.click();
            return true;
        });
        if (!clicked) return { error: 'no play control found on the detail page' };

        return page.evaluate(() => new Promise((resolve) => {
            const deadline = Date.now() + 25000;
            const tick = () => {
                const v = document.querySelector('video');
                if (v && v.error) return resolve({ error: 'media error: ' + v.error.message });
                if (v && v.readyState >= 2 && v.currentTime > 0.05) {
                    return resolve({ ok: true, currentTime: v.currentTime, duration: v.duration, src: v.currentSrc.slice(0, 90) });
                }
                if (v && v.paused && v.readyState >= 2) v.play().catch(() => {});
                if (Date.now() > deadline) {
                    return resolve({ error: v ? `stalled readyState=${v.readyState} t=${v.currentTime}` : 'no video element' });
                }
                setTimeout(tick, 400);
            };
            tick();
        }));
    }

    // Clear the journal first so anything in it afterwards came from the app, not
    // from a fetch this test made itself.
    await page.evaluate(async () => {
        const db = await window.PS_DB.open();
        await new Promise((res, rej) => {
            const t = db.transaction('journal', 'readwrite');
            t.objectStore('journal').clear();
            t.oncomplete = res; t.onerror = () => rej(t.error);
        });
    });

    const playedDirect = await playThroughApp(direct.id, 'direct');
    check('jellyfin-web plays a downloaded original', playedDirect.ok === true,
        playedDirect.error || `t=${playedDirect.currentTime.toFixed(2)}s of ${playedDirect.duration.toFixed(0)}s`);

    // Let the player's own reporting interval come round at least once.
    await sleep(12000);
    const reported = await page.evaluate(async () => {
        const rows = await window.PS_DB.all('journal');
        return { ops: rows.map((r) => r.op), positions: rows.map((r) => r.payload && r.payload.positionTicks) };
    });
    check('the app\'s own play state reports reach the phantom server',
        reported.ops.includes('started') || reported.ops.includes('progress'),
        `journal ops: ${reported.ops.join(',') || 'none'}`);

    await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.pause(); } });

    const playedHls = await playThroughApp(hls.id, 'hls');
    check('jellyfin-web plays a downloaded transcode through hls.js', playedHls.ok === true,
        playedHls.error || `t=${playedHls.currentTime.toFixed(2)}s`);
    await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.pause(); } });

    // ---- 6a2. remux versus re-encode -------------------------------------
    //
    // The server stream-copies a source whose codec the transcoding profile
    // already targets, at full resolution. Sending it a quality cap is what
    // turns that copy into a re-encode — so a 1920x804 h264 mkv came back at
    // 1718x720 and a third of the size, for a file that needed nothing done to
    // it. tools/remux-probe.py is the measurement these assertions come from.

    const plans = await page.evaluate(async (pid, ids) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { hlsPlan, inspectSubtitles } = await import('/web/plugin/downloader.js');
        const known = knownServers(pid)[0];
        if (!known) return { error: 'not signed in to the source server' };
        const server = new SourceServer(known);
        const out = {};
        for (const [key, id] of Object.entries(ids)) {
            const info = await server.playbackInfo(id);
            const source = (info.MediaSources || [])[0];
            out[key] = {
                plan: hlsPlan(source, {}),
                burned: hlsPlan(source, { burning: true }),
                inspected: await inspectSubtitles(server, await server.item(id))
            };
        }
        return out;
    }, phantomId, {
        tallCopy: REMUX_TALL_ITEM, foreignAudio: REMUX_FOREIGN_AUDIO_ITEM, encode: REENCODE_ITEM
    });

    check('an h264 source in a foreign container is a remux, not a transcode',
        !plans.error && plans.tallCopy.plan.videoCopy === true
        && plans.tallCopy.inspected.willRemux === true
        && plans.tallCopy.inspected.willTranscode === false,
        plans.error || JSON.stringify(plans.tallCopy && plans.tallCopy.plan));

    check('a codec the profile cannot target is a real re-encode',
        !plans.error && plans.encode.plan.videoCopy === false
        && plans.encode.inspected.willTranscode === true
        && plans.encode.inspected.willRemux === false,
        plans.error || JSON.stringify(plans.encode && plans.encode.plan));

    check('sound the profile cannot carry is converted while the picture is copied',
        !plans.error && plans.foreignAudio.plan.videoCopy === true
        && plans.foreignAudio.plan.audioCopy === false
        && plans.foreignAudio.inspected.audioWillConvert === true,
        plans.error || JSON.stringify(plans.foreignAudio && plans.foreignAudio.plan));

    check('burning a subtitle in forces the encode a copy would have avoided',
        !plans.error && plans.tallCopy.burned.videoCopy === false,
        plans.error || JSON.stringify(plans.tallCopy && plans.tallCopy.burned));

    // What the download actually asks the server for. The classification above is
    // only worth anything if the cap follows it, and nothing else can see that.
    const capUse = await page.evaluate(async (pid, copyId, quality) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem, removeDownload } = await import('/web/plugin/downloader.js');
        const known = knownServers(pid)[0];
        if (!known) return { error: 'not signed in to the source server' };
        const server = new SourceServer(known);
        const asked = [];
        const originalFetch = window.fetch;
        window.fetch = function (input, init) {
            asked.push(String(input && input.url ? input.url : input));
            return originalFetch.call(this, input, init);
        };
        try {
            const row = await downloadItem(server, await server.item(copyId), { quality });
            await removeDownload(row);
        } finally {
            window.fetch = originalFetch;
        }
        const hls = asked.filter((u) => /m3u8|hls1\//.test(u));
        return {
            requests: hls.length,
            capped: hls.filter((u) => /MaxHeight|VideoBitrate=3000000/.test(u)).length,
            sample: hls[0] || null
        };
    }, phantomId, REMUX_TALL_ITEM, '720p');

    check('a copied download is never asked for at a reduced height',
        !capUse.error && capUse.requests > 0 && capUse.capped === 0,
        capUse.error || `${capUse.capped} of ${capUse.requests} requests carried a cap`);

    // ---- 6b. images, subtitles, burn-in ----------------------------------

    const imageProbe = await page.evaluate(async (id) => {
        const res = await fetch(`/Items/${id}/Images/Primary?fillWidth=400&quality=90`);
        return { status: res.status, type: res.headers.get('Content-Type'), bytes: (await res.arrayBuffer()).byteLength };
    }, direct.id);
    check('item artwork serves from storage',
        imageProbe.status === 200 && /^image\//.test(imageProbe.type || '') && imageProbe.bytes > 1000,
        `${imageProbe.status} ${imageProbe.type} ${imageProbe.bytes}b`);

    // An item with nine extractable text tracks.
    const subtitled = await page.evaluate(async (pid, id) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem, inspectSubtitles } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const item = await server.item(id);
        const inspected = await inspectSubtitles(server, item);
        const row = await downloadItem(server, item, {});

        const info = await (await fetch(`/Items/${id}/PlaybackInfo`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        })).json();
        const ms = info.MediaSources[0];
        const subs = (ms.MediaStreams || []).filter((st) => st.Type === 'Subtitle');
        const first = subs[0];
        const fetched = first ? await fetch(first.DeliveryUrl) : null;
        const body = fetched ? await fetched.text() : '';
        return {
            offered: inspected.tracks.length,
            extractable: inspected.tracks.filter((t) => t.canExtract).length,
            stored: row.subtitles.length,
            exposed: subs.length,
            external: subs.every((st) => st.DeliveryMethod === 'External' && st.Codec === 'webvtt'),
            status: fetched ? fetched.status : 0,
            isVtt: body.trim().startsWith('WEBVTT')
        };
    }, phantomId, SUBTITLE_ITEM);
    check('text subtitle tracks are extracted', subtitled.stored > 0,
        `${subtitled.stored} of ${subtitled.extractable} extractable, ${subtitled.offered} offered`);
    check('held subtitles are offered as external webvtt',
        subtitled.exposed === subtitled.stored && subtitled.external,
        `${subtitled.exposed} exposed`);
    check('a subtitle file serves as WebVTT',
        subtitled.status === 200 && subtitled.isVtt, `${subtitled.status}`);

    // An item whose only subtitles are picture-based: the burn-in decision.
    const burned = await page.evaluate(async (pid, id) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem, inspectSubtitles } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const item = await server.item(id);
        const { tracks } = await inspectSubtitles(server, item);
        const picture = tracks.find((t) => !t.canExtract);
        if (!picture) return { error: 'no picture-based track on the fixture' };

        const row = await downloadItem(server, item, { subtitle: { mode: 'burn', index: picture.index } });
        const info = await (await fetch(`/Items/${id}/PlaybackInfo`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        })).json();
        const ms = info.MediaSources[0];
        return {
            needsChoice: true,
            codec: picture.codec,
            mode: row.mode,
            burnedIndex: row.burnedSubtitleIndex,
            state: row.state,
            segments: row.segments,
            subtitleStreams: (ms.MediaStreams || []).filter((st) => st.Type === 'Subtitle').length
        };
    }, phantomId, BURN_ITEM);
    check('a picture-based track is recognised as needing a decision',
        !burned.error && burned.needsChoice, burned.error || burned.codec);
    check('burning in forces a transcode and records the choice',
        burned.mode === 'hls' && burned.burnedIndex != null && burned.state === 'complete',
        `${burned.mode}, index ${burned.burnedIndex}, ${burned.segments} segments`);
    check('a burned-in track is not also offered as a switchable one',
        burned.subtitleStreams === 0, String(burned.subtitleStreams));

    // Styled subtitles must survive as themselves. jellyfin-web renders ass and
    // ssa with libass; converting them to WebVTT on the way in would throw away
    // the typesetting and there would be no way to get it back.
    const ass = await page.evaluate(async (pid, id) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const item = await server.item(id);
        const row = await downloadItem(server, item, {});

        const info = await (await fetch(`/Items/${id}/PlaybackInfo`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        })).json();
        const ms = info.MediaSources[0];
        const track = (ms.MediaStreams || []).find((st) => st.Type === 'Subtitle');
        const subRes = track ? await fetch(track.DeliveryUrl) : null;
        const subBody = subRes ? await subRes.text() : '';

        const font = (ms.MediaAttachments || [])[0];
        const fontRes = font ? await fetch(font.DeliveryUrl) : null;
        const fontBytes = fontRes ? (await fontRes.arrayBuffer()).byteLength : 0;

        const encoding = await (await fetch('/System/Configuration/encoding')).json();

        return {
            storedFormat: (row.subtitles[0] || {}).format,
            storedCodec: (row.subtitles[0] || {}).codec,
            exposedCodec: track && track.Codec,
            deliveryUrl: track && track.DeliveryUrl,
            subStatus: subRes ? subRes.status : 0,
            isAss: subBody.trimStart().startsWith('[Script Info]'),
            attachments: (ms.MediaAttachments || []).length,
            fontMime: font && font.MimeType,
            fontStatus: fontRes ? fontRes.status : 0,
            fontBytes,
            fallbackFont: encoding.EnableFallbackFont
        };
    }, phantomId, ASS_ITEM);

    check('an ASS track is kept as ASS, not converted',
        ass.storedFormat === 'ass' && ass.isAss && ass.subStatus === 200,
        `stored ${ass.storedFormat} from ${ass.storedCodec}, served ${ass.subStatus}`);
    check('the track is reported with the codec that routes it to libass',
        ass.exposedCodec === 'ass' && /\.ass$/.test(ass.deliveryUrl || ''), ass.exposedCodec);
    check('the embedded font is downloaded and served',
        ass.attachments === 1 && ass.fontStatus === 200 && ass.fontBytes > 10000,
        `${ass.attachments} attachment(s), ${ass.fontMime}, ${ass.fontBytes} bytes`);
    check('the encoding config answers, so libass actually starts',
        ass.fallbackFont === false, String(ass.fallbackFont));

    // A file with several audio tracks. The browser plays whichever the container
    // defaults to and cannot switch, so picking another has to force a transcode.
    const dualAudio = await page.evaluate(async (pid, id) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem, inspectSubtitles } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const item = await server.item(id);
        const { audio } = await inspectSubtitles(server, item);
        const alternate = audio.find((a) => !a.isContainerDefault);
        if (!alternate) return { error: 'fixture has only one audio track' };

        const row = await downloadItem(server, item, { audioStreamIndex: alternate.index });
        const info = await (await fetch(`/Items/${id}/PlaybackInfo`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        })).json();
        return {
            tracks: audio.length,
            chosen: alternate.index,
            containerDefault: (audio.find((a) => a.isContainerDefault) || {}).index,
            mode: row.mode,
            state: row.state,
            recorded: row.audioStreamIndex,
            reported: info.MediaSources[0].DefaultAudioStreamIndex
        };
    }, phantomId, MULTI_AUDIO_ITEM);

    check('a multi-audio file offers every track', !dualAudio.error && dualAudio.tracks > 1,
        dualAudio.error || `${dualAudio.tracks} tracks, container default ${dualAudio.containerDefault}`);
    check('choosing a non-default audio track forces a transcode',
        dualAudio.mode === 'hls' && dualAudio.state === 'complete',
        `${dualAudio.mode}, ${dualAudio.state}`);
    check('the chosen audio track is what plays',
        dualAudio.recorded === dualAudio.chosen && dualAudio.reported === dualAudio.chosen,
        `chose ${dualAudio.chosen}, reported ${dualAudio.reported}`);

    // Default subtitle selection has to survive the trip, and must never name a
    // track we did not keep.
    const defaults = await page.evaluate(async (pid, forcedId, manyId) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const read = async (id) => {
            const item = await server.item(id);
            const row = await downloadItem(server, item, {});
            const info = await (await fetch(`/Items/${id}/PlaybackInfo`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            })).json();
            const ms = info.MediaSources[0];
            const subs = (ms.MediaStreams || []).filter((st) => st.Type === 'Subtitle');
            return {
                held: row.subtitles.map((sub) => sub.index),
                sourceDefault: row.defaultSubtitleStreamIndex,
                reported: ms.DefaultSubtitleStreamIndex,
                forcedIndex: (subs.find((st) => st.IsForced) || {}).Index
            };
        };
        return { forced: await read(forcedId), many: await read(manyId) };
    }, phantomId, FORCED_SUB_ITEM, SUBTITLE_ITEM);

    // The server's own choice, not ours. Measured on this fixture it picks the
    // default-flagged track over the forced one, and second-guessing that would be
    // inventing a subtitle policy we have no information to run.
    check('the source server\'s default subtitle is the one selected',
        defaults.forced.sourceDefault != null
            && defaults.forced.reported === defaults.forced.sourceDefault,
        `source said ${defaults.forced.sourceDefault}, reported ${defaults.forced.reported}`);
    check('the default subtitle never names a track we did not keep',
        defaults.many.reported === null || defaults.many.held.includes(defaults.many.reported),
        `reported ${defaults.many.reported} of held [${defaults.many.held.join(',')}]`);

    // ---- 6d. searching the held library ----------------------------------

    const search = await page.evaluate(async () => {
        const uid = window.ApiClient.getCurrentUserId();
        const get = async (u) => (await (await fetch(u)).json());
        const all = await get(`/Items?userId=${uid}&Recursive=true`);
        const sample = all.Items[0];
        const word = (sample.Name || '').split(' ')[0];

        const byName = await get(`/Items?userId=${uid}&Recursive=true&searchTerm=${encodeURIComponent(word)}`);
        const nonsense = await get(`/Items?userId=${uid}&Recursive=true&searchTerm=zzzznotathing`);
        const hints = await get(`/Search/Hints?userId=${uid}&searchTerm=${encodeURIComponent(word)}&limit=10`);
        const exact = await get(`/Items?userId=${uid}&Recursive=true&searchTerm=${encodeURIComponent(sample.Name)}`);

        return {
            word,
            matched: byName.TotalRecordCount,
            hits: byName.Items.map((i) => i.Name),
            empty: nonsense.TotalRecordCount,
            hintCount: hints.SearchHints.length,
            hintShape: hints.SearchHints[0] ? Object.keys(hints.SearchHints[0]).includes('ItemId') : false,
            bestFirst: exact.Items[0] && exact.Items[0].Name === sample.Name
        };
    });
    check('the held library answers a search', search.matched > 0,
        `"${search.word}" matched ${search.matched}`);
    check('a search that matches nothing returns nothing', search.empty === 0);
    check('search hints answer in their own shape', search.hintCount > 0 && search.hintShape,
        `${search.hintCount} hints`);
    check('an exact title ranks first', search.bestFirst === true);

    // ---- 6e. picking what of a series to take ----------------------------

    const seriesOptions = await page.evaluate(async (pid, seriesId) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { inspectSeries, downloadSeries } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const dto = await server.item(seriesId);
        const info = await inspectSeries(server, dto);

        // A season id that matches nothing proves the filter is applied rather
        // than ignored, without downloading twenty episodes to find out.
        const none = await downloadSeries(server, dto, { seasonId: 'nosuchseason' });

        return {
            seasons: info.seasons.length,
            perSeason: info.seasons.map((se) => se.episodes),
            total: info.episodes,
            unwatched: info.unwatched,
            filteredToNothing: none.episodes
        };
    }, phantomId, MULTI_SEASON_SERIES);

    const smallSeries = await page.evaluate(async (pid, id) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadSeries } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const dto = await server.item(id);
        const result = await downloadSeries(server, dto, {});
        return { name: dto.Name, episodes: result.episodes };
    }, phantomId, SMALL_SERIES);
    check('a whole small series downloads', smallSeries.episodes > 0,
        `${smallSeries.name}: ${smallSeries.episodes} episodes`);

    check('a series reports its seasons and their episode counts',
        seriesOptions.seasons > 1 && seriesOptions.perSeason.every((n) => n > 0),
        `${seriesOptions.seasons} seasons: ${seriesOptions.perSeason.join('/')} of ${seriesOptions.total}`);
    check('a season filter actually filters', seriesOptions.filteredToNothing === 0,
        String(seriesOptions.filteredToNothing));

    const unwatched = await page.evaluate(async (pid, seriesId) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { inspectSeries, downloadSeries } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const dto = await server.item(seriesId);

        const before = await inspectSeries(server, dto);
        const episodes = (await server.episodes(seriesId)).Items;
        // Mark every episode played on the SOURCE, so "unwatched only" has
        // nothing left to take.
        for (const ep of episodes) {
            await server.fetch(`${server.url}/UserPlayedItems/${ep.Id}?userId=${server.userId}`, { method: 'POST' });
        }
        const after = await inspectSeries(server, dto);
        const took = await downloadSeries(server, dto, { unwatchedOnly: true });

        for (const ep of episodes) {
            await server.fetch(`${server.url}/UserPlayedItems/${ep.Id}?userId=${server.userId}`, { method: 'DELETE' });
        }
        return { beforeUnwatched: before.unwatched, afterUnwatched: after.unwatched, took: took.episodes, total: before.episodes };
    }, phantomId, MULTI_SEASON_SERIES);

    check('watched state is read back from the source',
        unwatched.beforeUnwatched === unwatched.total && unwatched.afterUnwatched === 0,
        `${unwatched.beforeUnwatched} then ${unwatched.afterUnwatched} of ${unwatched.total}`);
    check('"only unwatched" takes nothing when everything is watched',
        unwatched.took === 0, String(unwatched.took));

    // jellyfin-web sends list parameters REPEATED, not comma separated. Keeping
    // only the last value made the search screen ask for a dozen types and get a
    // filter of one, so the library looked empty in every section but the first.
    const repeated = await page.evaluate(async () => {
        const uid = window.ApiClient.getCurrentUserId();
        const get = async (u) => (await (await fetch(u)).json());
        const repeatedTypes = await get(
            `/Items?userId=${uid}&Recursive=true&includeItemTypes=Movie&includeItemTypes=Series`);
        const commaTypes = await get(
            `/Items?userId=${uid}&Recursive=true&includeItemTypes=Movie,Series`);
        const videoOnly = await get(`/Items?userId=${uid}&Recursive=true&mediaTypes=Video`);
        const excluded = await get(
            `/Items?userId=${uid}&Recursive=true&excludeItemTypes=Movie&excludeItemTypes=Episode`);
        const types = (r) => [...new Set(r.Items.map((i) => i.Type))].sort();
        return {
            repeated: types(repeatedTypes),
            comma: types(commaTypes),
            videoOnly: types(videoOnly),
            excluded: types(excluded)
        };
    });
    check('repeated list parameters are all read, not just the last',
        repeated.repeated.includes('Movie') && repeated.repeated.includes('Series'),
        repeated.repeated.join(','));
    check('a comma-separated list still works', repeated.comma.join(',') === repeated.repeated.join(','),
        repeated.comma.join(','));
    check('mediaTypes excludes folders like Series',
        !repeated.videoOnly.includes('Series') && repeated.videoOnly.length > 0,
        repeated.videoOnly.join(','));
    check('repeated excludeItemTypes all apply',
        !repeated.excluded.includes('Movie') && !repeated.excluded.includes('Episode'),
        repeated.excluded.join(','));

    // The reported symptom: search showed videos and never a series.
    const seriesSearch = await page.evaluate(async () => {
        const uid = window.ApiClient.getCurrentUserId();
        const all = await (await fetch(`/Items?userId=${uid}&Recursive=true&includeItemTypes=Series`)).json();
        if (!all.Items.length) return { skipped: true };
        const name = all.Items[0].Name;
        const word = name.split(' ')[0];
        const hit = await (await fetch(
            `/Items?userId=${uid}&Recursive=true&searchTerm=${encodeURIComponent(word)}&includeItemTypes=Movie&includeItemTypes=Series&includeItemTypes=Episode`
        )).json();
        return { name, word, types: [...new Set(hit.Items.map((i) => i.Type))], found: hit.Items.some((i) => i.Id === all.Items[0].Id) };
    });
    check('a search finds series, not only videos',
        seriesSearch.skipped || seriesSearch.found === true,
        seriesSearch.skipped ? 'no series held' : `"${seriesSearch.word}" -> ${seriesSearch.types.join(',')}`);

    // The reported symptom: a real server sections search results and the phantom
    // server put everything under Videos. The section query asks for a dozen types
    // at once and jellyfin-web splits the answer by Type.
    const sections = await page.evaluate(async () => {
        const uid = window.ApiClient.getCurrentUserId();
        const typed = await (await fetch(`/Items?userId=${uid}&Recursive=true&searchTerm=a`
            + '&includeItemTypes=Movie&includeItemTypes=Series&includeItemTypes=Episode'
            + '&includeItemTypes=Playlist&includeItemTypes=BoxSet')).json();
        const videos = await (await fetch(`/Items?userId=${uid}&Recursive=true&searchTerm=a`
            + '&excludeItemTypes=Movie&excludeItemTypes=Episode&excludeItemTypes=TvChannel'
            + '&mediaTypes=Video')).json();
        const held = await (await fetch(`/Items?userId=${uid}&Recursive=true&searchTerm=a`)).json();
        return {
            typed: [...new Set(typed.Items.map((i) => i.Type))].sort(),
            held: [...new Set(held.Items.map((i) => i.Type))].sort(),
            videosSection: [...new Set(videos.Items.map((i) => i.Type))].sort()
        };
    });
    // Only the types actually asked for: a Season is held but was not in the list,
    // and jellyfin-web does not put one in a section either.
    const asked = ['Movie', 'Series', 'Episode', 'Playlist', 'BoxSet'];
    const expected = sections.held.filter((t) => asked.includes(t));
    check('the typed search query returns every kind so sections can form',
        expected.length > 1 && expected.every((t) => sections.typed.includes(t)),
        `got ${sections.typed.join(',')}, expected ${expected.join(',')}`);
    check('the Videos section does not swallow movies and episodes',
        !sections.videosSection.includes('Movie') && !sections.videosSection.includes('Episode'),
        sections.videosSection.join(',') || 'empty');

    // Only one audio track may be offered, because only one can be played.
    const audioExposure = await page.evaluate(async (id) => {
        const info = await (await fetch(`/Items/${id}/PlaybackInfo`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        })).json();
        const ms = info.MediaSources[0];
        const audio = (ms.MediaStreams || []).filter((st) => st.Type === 'Audio');
        return { count: audio.length, index: audio[0] && audio[0].Index, def: ms.DefaultAudioStreamIndex };
    }, MULTI_AUDIO_ITEM);
    check('a six-track file offers exactly one audio track',
        audioExposure.count === 1 && audioExposure.index === audioExposure.def,
        `${audioExposure.count} offered, index ${audioExposure.index}`);

    // Nothing is burned in unless somebody chose it.
    const burnGuard = await page.evaluate(async (pid, id) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { inspectSubtitles } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const item = await server.item(id);
        const info = await inspectSubtitles(server, item);
        const row = await window.PS_DB.get('downloads', [server.id, id, id]);
        return {
            pictureTracks: (info.pictureTracks || []).length,
            wouldBurn: !!info.serverWouldBurn,
            burnedIndex: row ? row.burnedSubtitleIndex : 'no row'
        };
    }, phantomId, BURN_ITEM);
    check('a picture-based track is reported so the UI can warn about it',
        burnGuard.pictureTracks > 0, `${burnGuard.pictureTracks} picture track(s)`);

    const unchosen = await page.evaluate(async (pid, id) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem, removeDownload } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const item = await server.item(id);
        const existing = await window.PS_DB.get('downloads', [server.id, id, id]);
        if (existing) await removeDownload(existing);
        // No subtitle choice at all: the server must not fall back to burning its
        // own default track in.
        const row = await downloadItem(server, item, { quality: '480p' });
        return { mode: row.mode, burned: row.burnedSubtitleIndex, quality: row.quality };
    }, phantomId, BURN_ITEM);
    check('nothing is burned in when the user did not choose it',
        unchosen.burned === null, String(unchosen.burned));
    check('the chosen transcode quality is recorded', unchosen.quality === '480p', unchosen.quality);

    // Cancelling has to stop the transfer, not just stop reporting it.
    const cancelled = await page.evaluate(async (pid) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem, cancelDownload, listDownloads } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        // Something not already held, so the cancel can only affect its own row.
        const held = new Set((await listDownloads()).map((r) => r.itemId));
        const candidates = await server.items({ IncludeItemTypes: 'Movie', Limit: 60, SortBy: 'SortName' });
        const big = (candidates.Items || []).find((i) => !held.has(i.Id));
        if (!big) return { skipped: true };

        const before = (await listDownloads()).length;
        const promise = downloadItem(server, big, {});
        let stopped = false;
        for (let i = 0; i < 200 && !stopped; i++) {
            stopped = await cancelDownload(server.id, big.Id, big.Id);
            if (!stopped) await new Promise((r) => setTimeout(r, 10));
        }
        let outcome = 'completed';
        try { await promise; } catch (err) { outcome = err.cancelled ? 'cancelled' : 'error:' + err.message; }
        const after = (await listDownloads()).length;

        // The user-visible claim, which holds wherever in the download the cancel
        // landed: the library is derived from ITEM rows, not download rows, so an
        // item row left behind lists a cancelled item as playable and nothing
        // ever removes it. Asked of the phantom server rather than the store,
        // because that is what a person would see.
        const listed = await (await fetch('/Items?Recursive=true&IncludeItemTypes=Movie')).json();
        const inLibrary = (listed.Items || []).some((i) => i.Id === big.Id);
        const artwork = !!(await window.PS_OPFS.file(
            window.PS_SCHEMA.paths.image(server.id, big.Id, 'Primary')));
        return { stopped, outcome, before, after, inLibrary, artwork };
    }, phantomId);
    check('an in-flight download can be cancelled',
        cancelled.skipped || (cancelled.stopped === true && cancelled.outcome === 'cancelled'),
        cancelled.skipped ? 'no fixture' : `${cancelled.outcome}`);
    check('a cancelled item is not left in the library',
        cancelled.skipped || (cancelled.inLibrary === false && cancelled.artwork === false),
        cancelled.skipped ? 'nothing to cancel'
            : `listed ${cancelled.inLibrary}, artwork ${cancelled.artwork}`);
    check('a cancelled download leaves no half-written row',
        cancelled.skipped || cancelled.after === cancelled.before,
        `${cancelled.before} rows before, ${cancelled.after} after`);

    const reDownload = await page.evaluate(async (pid, id) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const item = await server.item(id);
        const before = await window.PS_DB.get('downloads', [server.id, id, id]);
        const started = Date.now();
        const row = await downloadItem(server, item, {});
        return { wasHeld: !!before, sameRow: before && row.createdAt === before.createdAt, ms: Date.now() - started };
    }, phantomId, DIRECT_ITEM);
    check('an item already held is not downloaded again',
        reDownload.wasHeld && reDownload.sameRow === true,
        `held ${reDownload.wasHeld}, returned in ${reDownload.ms}ms`);

    // A series whose episodes were all removed must not linger anywhere.
    const orphans = await page.evaluate(async (pid, seriesId) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadSeries, removeDownload, listDownloads } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const dto = await server.item(seriesId);
        const uid = window.ApiClient.getCurrentUserId();

        const seasons = (await server.seasons(seriesId)).Items || [];
        const one = seasons[0];
        await downloadSeries(server, dto, { seasonId: one.Id });

        const get = async (u) => (await (await fetch(u)).json());
        const withEpisodes = {
            series: (await get(`/Items?userId=${uid}&Recursive=true&includeItemTypes=Series`))
                .Items.some((i) => i.Id === seriesId),
            seasons: (await get(`/Shows/${seriesId}/Seasons?userId=${uid}`)).Items.length,
            nextUp: (await get(`/Shows/NextUp?userId=${uid}&seriesId=${seriesId}`)).Items.length,
            childCount: (await get(`/Items/${seriesId}?userId=${uid}`)).ChildCount
        };

        // Only this series' episodes: another show is deliberately held so the
        // checks after this one still have a series to look at.
        const items = await window.PS_DB.all('items');
        const ofThisSeries = new Set(items
            .filter((r) => r.dto.Type === 'Episode' && r.dto.SeriesId === seriesId)
            .map((r) => r.id));
        const mine = (await listDownloads()).filter((r) => ofThisSeries.has(r.itemId));
        for (const row of mine) await removeDownload(row);

        const after = {
            series: (await get(`/Items?userId=${uid}&Recursive=true&includeItemTypes=Series`))
                .Items.some((i) => i.Id === seriesId),
            search: (await get(`/Items?userId=${uid}&Recursive=true&searchTerm=${encodeURIComponent(dto.Name)}`))
                .Items.some((i) => i.Id === seriesId),
            nextUp: (await get(`/Shows/NextUp?userId=${uid}&seriesId=${seriesId}`)).Items.length,
            seasons: (await get(`/Shows/${seriesId}/Seasons?userId=${uid}`)).Items.length
        };
        return { totalSeasons: seasons.length, withEpisodes, after };
    }, phantomId, MULTI_SEASON_SERIES);

    check('the seasons list shows only seasons with episodes held',
        orphans.withEpisodes.seasons === 1 && orphans.totalSeasons > 1,
        `${orphans.withEpisodes.seasons} of ${orphans.totalSeasons} seasons`);
    check('the episode count describes what is held, not what the source has',
        orphans.withEpisodes.childCount > 0, String(orphans.withEpisodes.childCount));
    check('removing every episode removes the series from browse and search',
        orphans.after.series === false && orphans.after.search === false,
        `browse ${orphans.after.series}, search ${orphans.after.search}`);
    check('removing every episode removes it from Next Up',
        orphans.after.nextUp === 0 && orphans.after.seasons === 0,
        `${orphans.after.nextUp} next up, ${orphans.after.seasons} seasons`);

    // Every byte an item wrote comes back when it stops being held.
    //
    // Walked rather than asserted against the remove calls: the tree has three
    // lifetimes in it — media keyed by source, an item's row and artwork keyed
    // by item, and a series' or season's artwork, which has no download row at
    // all and lives only as long as a descendant does — and a grep over the
    // writes cannot tell which tree a path still belongs to.
    const reclaim = await page.evaluate(async (pid, seriesId) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadSeries, removeDownload, listDownloads } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const dto = await server.item(seriesId);

        const paths = async () => (await window.PS_OPFS.walk([])).map((f) => f.path.join('/')).sort();
        const before = await paths();
        await downloadSeries(server, dto, {});
        const written = (await paths()).filter((p) => !before.includes(p));

        const items = await window.PS_DB.all('items');
        const mine = new Set(items
            .filter((r) => r.dto.Type === 'Episode' && r.dto.SeriesId === seriesId)
            .map((r) => r.id));
        for (const row of (await listDownloads()).filter((r) => mine.has(r.itemId))) {
            await removeDownload(row);
        }
        const left = (await paths()).filter((p) => !before.includes(p));
        const rows = await window.PS_DB.all('items');
        return {
            written: written.length,
            left,
            seriesRow: rows.some((r) => r.id === seriesId),
            seasonRows: rows.filter((r) => r.dto.Type === 'Season' && r.dto.SeriesId === seriesId).length
        };
    }, phantomId, PARENT_SERIES);

    check('removing every episode of a series leaves no bytes behind',
        reclaim.written > 0 && reclaim.left.length === 0,
        `wrote ${reclaim.written} files, ${reclaim.left.length} left: `
        + JSON.stringify(reclaim.left.slice(0, 6)));
    // The rows are meant to stay. library.js hides a parent with no held
    // children at read time, deliberately, so that it is right however the
    // children went away; pruning them here as well would put one decision in
    // two places. Only the bytes are reclaimed.
    check('a parent row outlives its children on purpose',
        reclaim.seriesRow && reclaim.seasonRows > 0,
        `series row ${reclaim.seriesRow}, ${reclaim.seasonRows} season rows`);

    // Track numbering is per file; a series-wide choice has to be resolved per file.
    const matching = await page.evaluate(async () => {
        const { matchTrack } = await import('/web/plugin/downloader.js');
        const want = { language: 'eng', codec: 'pgssub', isForced: false, title: 'Signs', canExtract: false };
        const shuffled = [
            { index: 5, language: 'jpn', codec: 'pgssub', isForced: false, title: 'Full', canExtract: false },
            { index: 9, language: 'eng', codec: 'pgssub', isForced: false, title: 'Signs', canExtract: false }
        ];
        const renamed = [
            { index: 4, language: 'eng', codec: 'pgssub', isForced: false, title: 'Signs & Songs', canExtract: false }
        ];
        const absent = [
            { index: 2, language: 'jpn', codec: 'pgssub', isForced: false, title: 'Full', canExtract: false }
        ];
        const ambiguous = [
            { index: 2, language: 'eng', codec: 'pgssub', isForced: false, title: 'A', canExtract: false },
            { index: 3, language: 'eng', codec: 'pgssub', isForced: false, title: 'B', canExtract: false }
        ];
        const wrongKind = [
            { index: 2, language: 'eng', codec: 'subrip', isForced: false, title: 'Signs', canExtract: true }
        ];
        const pick = (list) => { const t = matchTrack(list, want); return t ? t.index : null; };
        return {
            reordered: pick(shuffled),
            renamed: pick(renamed),
            absent: pick(absent),
            ambiguous: pick(ambiguous),
            wrongKind: pick(wrongKind)
        };
    });
    check('a re-ordered track is found by what it is, not where it sits',
        matching.reordered === 9, String(matching.reordered));
    check('a differently titled track still matches on language and codec',
        matching.renamed === 4, String(matching.renamed));
    check('a file without the chosen track matches nothing',
        matching.absent === null, String(matching.absent));
    check('two indistinguishable candidates are left for a person to arbitrate',
        matching.ambiguous === null, String(matching.ambiguous));
    check('a text track is never substituted for a picture one',
        matching.wrongKind === null, String(matching.wrongKind));

    // The bulk rules, against track layouts shaped like real release groups.
    const bulk = await page.evaluate(async () => {
        const { bulkSelect, dialogueWeight, signWeight } = await import('/web/plugin/downloader.js');
        const anime = (id, subs) => ({
            id,
            audio: [
                { index: 1, language: 'jpn', title: 'Japanese', codec: 'aac' },
                { index: 2, language: 'eng', title: 'English', codec: 'aac' },
                { index: 3, language: 'eng', title: 'English Commentary', codec: 'aac' }
            ],
            subtitles: subs
        });
        const full = { index: 4, language: 'eng', title: 'Full Dialogue', codec: 'ass', isForced: false, canExtract: true };
        const signs = { index: 5, language: 'eng', title: 'Signs & Songs', codec: 'ass', isForced: false, canExtract: true };
        // Second episode has them the other way round and differently numbered.
        const fullB = { index: 7, language: 'eng', title: 'Main', codec: 'ass', isForced: false, canExtract: true };
        const signsB = { index: 6, language: 'eng', title: 'OP/ED', codec: 'ass', isForced: false, canExtract: true };
        const rows = [anime('a', [full, signs]), anime('b', [signsB, fullB])];
        // A third with no English subtitles at all: no rule can place it.
        const orphan = { id: 'c', audio: [{ index: 1, language: 'jpn', title: 'Japanese', codec: 'aac' }], subtitles: [] };

        const subbed = bulkSelect([...rows, orphan], 'subbed');
        const dubbed = bulkSelect(rows, 'dubbed');
        const track = bulkSelect(rows, 'track', { ordinal: 0 });
        return {
            subbedA: subbed.choices.a, subbedB: subbed.choices.b,
            subbedUnresolved: subbed.unresolved,
            dubbedA: dubbed.choices.a, dubbedB: dubbed.choices.b,
            trackA: track.choices.a,
            dialogueBeatsSigns: dialogueWeight('Full Dialogue') < dialogueWeight('Signs & Songs'),
            signsAreSigns: signWeight('Signs & Songs') > 0 && signWeight('Full Dialogue') === 0
        };
    });

    check('subbed picks original audio with the dialogue track',
        bulk.subbedA && bulk.subbedA.audioIndex === 1 && bulk.subbedA.subtitleIndex === 4,
        JSON.stringify(bulk.subbedA));
    check('subbed follows the track across an episode that renumbered it',
        bulk.subbedB && bulk.subbedB.audioIndex === 1 && bulk.subbedB.subtitleIndex === 7,
        JSON.stringify(bulk.subbedB));
    check('dubbed picks the dub with signs and songs only',
        bulk.dubbedA && bulk.dubbedA.audioIndex === 2 && bulk.dubbedA.subtitleIndex === 5
            && bulk.dubbedB.subtitleIndex === 6,
        `${JSON.stringify(bulk.dubbedA)} / ${JSON.stringify(bulk.dubbedB)}`);
    check('an episode no rule fits is left for the person to fix',
        bulk.subbedUnresolved.length === 1 && bulk.subbedUnresolved[0] === 'c',
        bulk.subbedUnresolved.join(','));
    check('the dialogue and signs weights order the way they must',
        bulk.dialogueBeatsSigns && bulk.signsAreSigns);
    check('picking the nth track ignores language entirely',
        bulk.trackA && bulk.trackA.subtitleIndex === 4, JSON.stringify(bulk.trackA));

    // The grid's answers have to reach the download, not just the screen.
    const perEpisode = await page.evaluate(async (pid, seriesId) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { inspectEpisodeTracks, downloadSeries, removeDownload, listDownloads } =
            await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const dto = await server.item(seriesId);
        const episodes = ((await server.episodes(seriesId)).Items || []).slice(0, 1);
        if (!episodes.length) return { skipped: true };

        let progressSeen = 0;
        const rows = await inspectEpisodeTracks(server, episodes, (done) => { progressSeen = done; });

        const held = await listDownloads();
        for (const row of held.filter((r) => r.itemId === episodes[0].Id)) await removeDownload(row);

        const audio = rows[0].audio[rows[0].audio.length - 1];
        await downloadSeries(server, dto, {
            perEpisode: { [episodes[0].Id]: { audioIndex: audio.index, subtitleIndex: null } }
        });
        const row = (await listDownloads()).find((r) => r.itemId === episodes[0].Id);
        return {
            progressSeen,
            tracksRead: rows[0].audio.length,
            chose: audio.index,
            recorded: row && row.audioStreamIndex,
            mode: row && row.mode
        };
    }, phantomId, SMALL_SERIES);

    check('the grid reads every episode\'s tracks with progress',
        perEpisode.skipped || (perEpisode.progressSeen > 0 && perEpisode.tracksRead > 0),
        perEpisode.skipped ? 'no episodes' : `${perEpisode.tracksRead} audio tracks read`);
    check('a per-episode choice is what gets downloaded',
        perEpisode.skipped || perEpisode.recorded === perEpisode.chose,
        `chose ${perEpisode.chose}, recorded ${perEpisode.recorded}`);

    // Downloading is a permission the Jellyfin administrator grants per user. A
    // tool that ignored it would let anyone aim a stranger's server at itself.
    const permissions = await page.evaluate(async (base, noDl, noTc, movieId) => {
        const { SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem, assertAllowed } = await import('/web/plugin/downloader.js');

        const signIn = async (name) => {
            const auth = await (await fetch(base + '/Users/AuthenticateByName', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'MediaBrowser Client="gate", Device="gate", DeviceId="gate1", Version="1.0"'
                },
                body: JSON.stringify({ Username: name, Pw: 'stdjflib' })
            })).json();
            return new SourceServer({
                id: auth.ServerId + ':' + name, name, url: base,
                userId: auth.User.Id, token: auth.AccessToken
            });
        };

        const blocked = await signIn(noDl);
        const blockedPolicy = await blocked.policy();
        let blockedError = null;
        try {
            await downloadItem(blocked, await blocked.item(movieId), {});
        } catch (err) { blockedError = err.message; }

        const noTranscode = await signIn(noTc);
        const noTranscodePolicy = await noTranscode.policy();
        let directOk = true;
        try { await assertAllowed(noTranscode); } catch { directOk = false; }
        let transcodeError = null;
        try { await assertAllowed(noTranscode, { transcoding: true }); }
        catch (err) { transcodeError = err.message; }

        return {
            blockedPolicy: blockedPolicy.EnableContentDownloading,
            blockedError,
            noTranscodePolicy: noTranscodePolicy.EnableVideoPlaybackTranscoding,
            directOk,
            transcodeError
        };
    }, SOURCE, NO_DOWNLOAD_USER, NO_TRANSCODE_USER, DIRECT_ITEM);

    check('the download permission is read from the server',
        permissions.blockedPolicy === false, String(permissions.blockedPolicy));
    check('an account without the download permission is refused',
        /not allowed to download/i.test(permissions.blockedError || ''),
        permissions.blockedError || 'the download was allowed');
    check('an account without the transcode permission may still take originals',
        permissions.directOk === true && permissions.noTranscodePolicy === false);
    check('but is refused a download that would need re-encoding',
        /not allowed to transcode/i.test(permissions.transcodeError || ''),
        permissions.transcodeError || 'the transcode was allowed');

    // ---- 6c. the offline app shell ---------------------------------------

    const manifest = await page.evaluate(async () => {
        const res = await fetch('/web/precache-manifest.json', { cache: 'no-store' });
        const body = await res.json();
        return { status: res.status, version: body.version, files: body.files.length };
    });
    check('libass ships in the offline app shell',
        await page.evaluate(async () => {
            const files = (await (await fetch('/web/precache-manifest.json')).json()).files;
            return files.some((f) => f.includes('subtitles-octopus-worker.js'))
                && files.some((f) => f.includes('subtitles-octopus-worker.wasm'));
        }));

    check('the host publishes a precache manifest',
        manifest.status === 200 && manifest.files > 100, `${manifest.files} files, ${manifest.version}`);

    const precached = await page.evaluate(async () => {
        const wait = async (fn, ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                if (fn()) return true;
                await new Promise((r) => setTimeout(r, 500));
            }
            return false;
        };
        await wait(() => window.__phantom.precache.total > 0, 20000);
        const started = window.__phantom.precache.done;
        const total = window.__phantom.precache.total;
        // It may already have finished: the run before this point is long enough
        // for 2400 files over localhost, and "no progress" then means done, not stuck.
        const grew = started >= total
            || await wait(() => window.__phantom.precache.done > started + 50, 40000);
        return { total, done: window.__phantom.precache.done, grew };
    });
    check('the app shell precaches in the background', precached.grew === true,
        `${precached.done} of ${precached.total}`);

    const caches_ = await page.evaluate(async () => {
        const names = (await caches.keys()).filter((n) => n.startsWith('phantom-app-'));
        const counts = {};
        for (const n of names) counts[n] = (await (await caches.open(n)).keys()).length;
        const active = names.find((n) => counts[n] > 100);
        return { names, counts, hasIndex: active ? !!(await (await caches.open(active)).match('/web/index.html')) : false };
    });
    check('exactly one app cache survives a completed precache',
        caches_.names.length === 1, caches_.names.join(', '));
    check('the live cache holds the document a navigation asks for',
        caches_.hasIndex === true, JSON.stringify(caches_.counts));

    // A memoised promise that keeps its rejection turns one blip into a permanent
    // fault: the IndexedDB handle, a server's permission policy and the manager
    // module the modal imports all had this shape, and none of them could recover
    // without a reload.
    const memo = await page.evaluate(async () => {
        let calls = 0;
        const flaky = window.PS_SCHEMA.once(async () => {
            calls++;
            if (calls === 1) throw new Error('first call fails');
            return 'ok';
        });
        let firstError = null;
        try { await flaky(); } catch (err) { firstError = err.message; }
        const second = await flaky();
        const third = await flaky();
        return { firstError, second, third, calls };
    });

    check('a memoised call forgets a failure and retries',
        memo.firstError === 'first call fails' && memo.second === 'ok', JSON.stringify(memo));
    check('and then caches the success rather than repeating it',
        memo.third === 'ok' && memo.calls === 2, `${memo.calls} calls`);

    // ---- 6f. what removal actually removes --------------------------------
    //
    // Images hang off the item and the media off the media source, so removing
    // the media directory left the artwork behind — bytes nothing would ever
    // delete and that the settings page's own storage figure cannot see, because
    // it sums download rows.
    const removalSweep = await page.evaluate(async (pid, itemId) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem, removeDownload, listDownloads } = await import('/web/plugin/downloader.js');
        const source = knownServers(pid)[0];
        if (!source) return { error: 'not signed in to the source server' };
        const server = new SourceServer(source);

        for (const old of (await listDownloads()).filter((r) => r.itemId === itemId)) {
            await removeDownload(old);
        }
        const row = await downloadItem(server, await server.item(itemId), {});
        const path = window.PS_SCHEMA.paths.image(row.srv, row.itemId, 'Primary');
        const before = !!(await window.PS_OPFS.file(path));
        await removeDownload(row);
        const after = !!(await window.PS_OPFS.file(path));
        const media = !!(await window.PS_OPFS.file(
            window.PS_SCHEMA.paths.original(row.srv, row.itemId, row.sourceId, row.container)));

        // Put it back. This is the item the play-state checks below read from,
        // and removing a download takes its userdata row with it — so leaving it
        // gone makes later checks fail for a reason that has nothing to do with
        // what they test.
        await downloadItem(server, await server.item(itemId), {});
        return { before, after, media };
    }, phantomId, DIRECT_ITEM);

    // Stated as its own check because the removal check below is vacuous if the
    // image was never written in the first place.
    check('a download stores the item artwork',
        !removalSweep.error && removalSweep.before === true,
        removalSweep.error || (removalSweep.before ? 'written' : 'nothing was written'));
    check('removing a download takes its artwork with it',
        !removalSweep.error && removalSweep.after === false && removalSweep.media === false,
        removalSweep.error || `image left ${removalSweep.after}, media left ${removalSweep.media}`);

    // ---- 6g. a stored DTO describes the copy ------------------------------
    //
    // Scoped to the fields that describe the FILE. Series and season rows
    // deliberately keep source identity, names and hierarchy for offline
    // browsing, and there is nothing on disk for them to describe.
    //
    // Which fields are in the rule was decided by reading the consumer in the
    // read-only jellyfin-web checkout rather than by symmetry:
    //   MediaSources  -> itemDetails renders a Version selector from it, and
    //                    defaults to MediaSources[0], which need not be the one
    //                    that was downloaded.
    //   Trickplay     -> the video OSD reads Width, Height, Interval, TileWidth
    //                    and TileHeight, and computes the sheet index from the
    //                    scrub position. It never reads ThumbnailCount, so the
    //                    bound that matters is the runtime, not the count.
    const storedDto = await page.evaluate(async (pid, multiId, tpId) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem, listDownloads } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);

        const sourceMulti = await server.item(multiId);
        const row = await downloadItem(server, sourceMulti, {});
        const served = await (await fetch('/Items/' + multiId)).json();
        // What the player will actually be given, so the two are compared with
        // each other rather than against an id spelled out here.
        const playback = await (await fetch('/Items/' + multiId + '/PlaybackInfo', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ DeviceProfile: {} })
        })).json();

        const tp = await (await fetch('/Items/' + tpId)).json();
        const tpRow = (await listDownloads()).find((r) => r.itemId === tpId);
        const byWidth = tpRow && ((tp.Trickplay || {})[tpRow.sourceId] || {});
        const widths = Object.keys(byWidth || {});
        const info = widths.length ? byWidth[widths[0]] : null;

        // The index the OSD would ask for at the very end of the file, computed
        // the way it computes it. Counted in SHEETS; ThumbnailCount counts
        // individual thumbnails, and comparing the two compares different units.
        let missing = null;
        if (info) {
            const lastTile = Math.floor((tp.RunTimeTicks / 10000) / info.Interval);
            const maxIndex = Math.floor(lastTile / (info.TileWidth * info.TileHeight));
            missing = [];
            for (let i = 0; i <= maxIndex; i++) {
                const held = await window.PS_OPFS.file(window.PS_SCHEMA.paths.trickplayTile(
                    tpRow.srv, tpId, tpRow.sourceId, Number(widths[0]), i));
                if (!held) missing.push(i);
            }
        }
        return {
            sourceSources: (sourceMulti.MediaSources || []).length,
            servedSources: (served.MediaSources || []).map((m) => m.Id),
            playbackSources: (playback.MediaSources || []).map((m) => m.Id),
            sourceWidths: Object.keys((sourceMulti.Trickplay || {})[row.sourceId] || {}).length,
            widths,
            info,
            missing
        };
    }, phantomId, MULTI_VERSION_ITEM, SUBTITLE_ITEM);

    check('the multi-version fixture really has more than one source',
        storedDto.sourceSources > 1, `${storedDto.sourceSources} on the source server`);
    check('a served item offers exactly the version the player will be given',
        storedDto.servedSources.length === 1
            && storedDto.servedSources.join() === storedDto.playbackSources.join(),
        `item offers ${JSON.stringify(storedDto.servedSources)}, `
        + `PlaybackInfo offers ${JSON.stringify(storedDto.playbackSources)}`);

    check('the trickplay fixture really has trickplay',
        storedDto.widths.length > 0 && !!storedDto.info,
        `${storedDto.widths.length} width(s) held`);
    check('a stored item offers only the trickplay width that was downloaded',
        storedDto.widths.length === 1, storedDto.widths.join(','));
    check('every trickplay sheet the player can ask for is held',
        !!storedDto.missing && storedDto.missing.length === 0,
        storedDto.missing ? `missing sheets ${JSON.stringify(storedDto.missing)}` : 'no descriptor');

    // A tile fetch that fails part way is the only way the descriptor and the
    // disk can disagree, and no server state produces it — the loop breaks on
    // the first failure, so the failure has to be injected. Driven through
    // downloadItem rather than downloadTrickplay so the store write, the DTO
    // prune and the row all see what really happened.
    const partialTrickplay = await page.evaluate(async (pid, itemId) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadItem, removeDownload, listDownloads } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const dto = await server.item(itemId);

        const sourceId = (dto.MediaSources || [{}])[0].Id;
        const byWidth = (dto.Trickplay || {})[sourceId] || {};
        const widths = Object.keys(byWidth).map(Number).filter(Number.isFinite);
        if (!widths.length) return { error: 'fixture has no trickplay' };
        const width = Math.max(...widths);
        const info = byWidth[width];
        const sheets = Math.ceil(info.ThumbnailCount / (info.TileWidth * info.TileHeight));

        let asked = 0;
        const real = server.fetchSignal.bind(server);
        server.fetchSignal = (url, signal) => {
            if (/\/Trickplay\//i.test(String(url)) && asked++ >= 1) {
                return Promise.reject(new Error('injected tile failure'));
            }
            return real(url, signal);
        };

        const row = await downloadItem(server, dto, {});
        const served = await (await fetch('/Items/' + itemId)).json();
        const held = [];
        for (let i = 0; i < sheets; i++) {
            held.push(!!(await window.PS_OPFS.file(window.PS_SCHEMA.paths
                .trickplayTile(row.srv, itemId, row.sourceId, width, i))));
        }
        const out = {
            sheets,
            asked,
            held,
            descriptor: served.Trickplay && Object.keys(served.Trickplay).length
                ? served.Trickplay : null
        };
        for (const r of (await listDownloads()).filter((r) => r.itemId === itemId)) {
            await removeDownload(r);
        }
        return out;
    }, phantomId, PARTIAL_TRICKPLAY_ITEM);

    check('the partial-trickplay fixture needs more than one sheet',
        !partialTrickplay.error && partialTrickplay.sheets > 1 && partialTrickplay.asked > 1,
        partialTrickplay.error || `${partialTrickplay.sheets} sheets, ${partialTrickplay.asked} asked for`);
    check('a trickplay download that lost a sheet stores no descriptor',
        !partialTrickplay.error && partialTrickplay.descriptor === null,
        JSON.stringify(partialTrickplay.descriptor));
    check('and keeps none of the sheets that did arrive',
        !partialTrickplay.error && (partialTrickplay.held || []).every((h) => !h),
        JSON.stringify(partialTrickplay.held));

    // ---- 7. play state ----------------------------------------------------

    const playstate = await page.evaluate(async (itemId) => {
        const post = (path, body) => fetch(path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const read = async () => (await (await fetch('/Items/' + itemId)).json()).UserData;
        // Relative to wherever real playback left it: this item has already been
        // played by the app above, and the floor never goes back down.
        const start = (await read()).PlaybackPositionTicks || 0;
        const target = start + 5000000;
        await post('/Sessions/Playing', { ItemId: itemId, PositionTicks: start });
        await post('/Sessions/Playing/Progress', { ItemId: itemId, PositionTicks: target });
        const advanced = (await read()).PlaybackPositionTicks;
        await post('/Sessions/Playing/Progress', { ItemId: itemId, PositionTicks: start });
        const afterRewind = (await read()).PlaybackPositionTicks;
        await fetch('/UserPlayedItems/' + itemId, { method: 'POST' });
        const marked = (await read()).Played;
        await fetch('/UserPlayedItems/' + itemId, { method: 'DELETE' });
        const unmarked = (await read()).Played;
        return { start, target, advanced, afterRewind, marked, unmarked };
    }, direct.id);
    check('progress is recorded', playstate.advanced === playstate.target, `${playstate.advanced} (wanted ${playstate.target})`);
    check('progress is advance-only', playstate.afterRewind === playstate.target, `rewind to ${playstate.start} left it at ${playstate.afterRewind}`);
    // playedSetBy says HOW the played flag got its value, and schema.js records
    // that it cannot be recovered once written. It was rewritten on every write,
    // so a progress report arriving after a deliberate mark relabelled the mark,
    // and favouriting an item relabelled a playback-derived flag as deliberate.
    const setBy = await page.evaluate(async (itemId) => {
        const post = (path, body) => fetch(path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const row = async () => {
            const all = await window.PS_DB.all('userdata');
            return all.find((u) => u.itemId === itemId) || {};
        };
        await fetch('/UserPlayedItems/' + itemId, { method: 'POST' });
        const afterMark = (await row()).playedSetBy;

        const at = ((await row()).positionTicks || 0) + 5000000;
        await post('/Sessions/Playing/Progress', { ItemId: itemId, PositionTicks: at });
        const afterProgress = (await row()).playedSetBy;

        const fav = await fetch('/UserFavoriteItems/' + itemId, { method: 'POST' });
        const afterFavourite = (await row()).playedSetBy;
        if (!fav.ok) return { error: 'favourite route answered ' + fav.status };

        return { afterMark, afterProgress, afterFavourite };
    }, direct.id);

    check('a deliberate mark is recorded as one',
        !setBy.error && setBy.afterMark === 'explicit', setBy.error || String(setBy.afterMark));
    check('a later progress report does not relabel that mark',
        !setBy.error && setBy.afterProgress === 'explicit',
        setBy.error || `became ${setBy.afterProgress}`);
    check('and neither does an unrelated write',
        !setBy.error && setBy.afterFavourite === 'explicit',
        setBy.error || `became ${setBy.afterFavourite}`);

    check('an explicit mark is verbatim in both directions',
        playstate.marked === true && playstate.unmarked === false,
        `${playstate.marked} then ${playstate.unmarked}`);

    const journal = await page.evaluate(async () => {
        const rows = await window.PS_DB.all('journal');
        return { count: rows.length, unsent: rows.filter((r) => r.sentAt === null).length, ops: [...new Set(rows.map((r) => r.op))] };
    });
    check('the journal records outbound work', journal.count > 0, `${journal.count} entries: ${journal.ops.join(',')}`);
    check('the journal is never drained in v0', journal.unsent === journal.count);

    // ---- 8. the plugin page ----------------------------------------------

    const plugin = await page.evaluate(async () => {
        const html = await (await fetch('/web/configurationpage?name=offlinesync')).text();
        const jsRes = await fetch('/web/configurationpage?name=offlinesync.js');
        const js = await jsRes.text();
        const pages = await (await fetch('/web/ConfigurationPages?enableInMainMenu=true')).json();
        return {
            isView: html.includes('data-role="page"') && html.includes('data-controller="__plugin/offlinesync.js"'),
            survivesTranslate: !html.includes('${'),
            jsType: jsRes.headers.get('Content-Type'),
            jsIsModule: /export\s*\{\s*default/.test(js) || js.includes('export default'),
            menu: pages.map((p) => p.DisplayName)
        };
    });
    check('plugin page is a jellyfin view with a controller', plugin.isView);
    check('plugin markup survives translateHtml', plugin.survivesTranslate);
    check('plugin controller serves as a module', plugin.jsIsModule && /javascript/.test(plugin.jsType || ''), plugin.jsType);
    check('plugin appears in the dashboard menu', plugin.menu.includes('Offline Sync'), plugin.menu.join(','));

    // The settings page has to mount inside the running app, not just parse.
    await page.goto(`${APP}/web/#/configurationpage?name=offlinesync`, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForFunction(() => !!document.querySelector('offline-sync-manager'), { timeout: 20000 })
        .catch(() => {});
    await sleep(2500);
    const mounted = await page.evaluate(() => {
        const el = document.querySelector('offline-sync-manager');
        return { present: !!el, rendered: !!(el && el.shadowRoot ? el.shadowRoot.textContent : el && el.textContent || '').match(/Download/i) };
    });
    check('the vdx settings page renders in the app', mounted.present && mounted.rendered, JSON.stringify(mounted));

    // The reported symptom was a library that stopped at the first page. Driven
    // through the component's own methods rather than its DOM, so the check is
    // about paging rather than about selector spelling.
    const uiPaging = await page.evaluate(async () => {
        const el = document.querySelector('offline-sync-manager');
        if (!el) return { error: 'settings page did not mount' };
        const wait = async (fn, ms = 20000) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                if (fn()) return true;
                await new Promise((r) => setTimeout(r, 200));
            }
            return false;
        };

        if (!await wait(() => el.state.servers.length > 0)) return { error: 'no source servers listed' };
        el.state.serverId = el.state.servers[0].id;
        await el.loadViews();
        if (!el.state.views.length) return { error: 'no libraries listed' };

        // The biggest library available, because paging only shows up past one page.
        let best = null;
        for (const view of el.state.views) {
            el.state.viewId = view.Id;
            el.state.items = [];
            await el.loadItems();
            if (!best || el.state.itemsTotal > best.total) {
                best = { name: view.Name, total: el.state.itemsTotal, first: el.state.items.length };
            }
            if (el.state.itemsTotal > 100) break;
        }

        const afterFirst = el.state.items.length;
        const total = el.state.itemsTotal;
        await el.loadItems(true);
        const afterSecond = el.state.items.length;
        const ids = new Set(el.state.items.map((i) => i.Id));

        return { library: best.name, total, afterFirst, afterSecond, distinct: ids.size };
    });

    check('the settings page reports a library\'s full size',
        !uiPaging.error && uiPaging.total > 0, uiPaging.error || `${uiPaging.library}: ${uiPaging.total}`);
    check('the list pages past the first page as it scrolls',
        !uiPaging.error && (uiPaging.total <= uiPaging.afterFirst || uiPaging.afterSecond > uiPaging.afterFirst),
        uiPaging.error || `${uiPaging.afterFirst} then ${uiPaging.afterSecond} of ${uiPaging.total}`);
    // Films sit at the top level with no group above them. A group carries a
    // "Remove group" button, and the one over the films meant "remove every film
    // I hold" — a whole catalogue one click away, wearing the same control that
    // removes a single season.
    const tree = await page.evaluate(async () => {
        const el = document.querySelector('offline-sync-manager');
        if (!el) return { error: 'settings page did not mount' };
        const nodes = el.downloadTree();
        return {
            total: nodes.length,
            groups: nodes.filter((n) => n.kind === 'group').length,
            // A node is a bulk delete if removing it takes more than one row.
            bulkRows: Math.max(0, ...nodes.filter((n) => n.rows).map((n) => n.rows.length)),
            bulkKinds: [...new Set(nodes.filter((n) => n.rows).map((n) => n.kind))],
            filmsAtTop: nodes.filter((n) => n.kind === 'item' && n.depth === 0).length
        };
    });

    // "Downloads are using X" means every byte on disk (SCOPE.md, the owner's
    // answer). Compared against a walk of the store rather than against the sum
    // it is computed from, because a figure checked against its own inputs
    // cannot see what those inputs never counted: bytesDone records the media
    // transfer, and subtitles, font attachments, trickplay tiles and artwork are
    // all written without touching it.
    const figure = await page.evaluate(async () => {
        const el = document.querySelector('offline-sync-manager');
        if (!el) return { error: 'settings page did not mount' };
        await el.refreshDownloads();
        const files = await window.PS_OPFS.walk([]);
        const onDisk = files.reduce((n, f) => n + f.size, 0);
        const kinds = new Set(files.map((f) => (f.path[0] === 'images' ? 'images' : f.path[4] || 'media')));
        const rows = el.state.downloads || [];
        return {
            reported: el.heldBytes(),
            onDisk,
            mediaOnly: rows.reduce((n, r) => n + (r.bytesDone || 0), 0),
            kinds: [...kinds].sort(),
            files: files.length
        };
    });

    // Vacuous unless the store holds something the media transfer does not
    // account for, which is the whole point of the figure being wrong.
    check('the store holds sidecars and artwork, not only media',
        !figure.error && figure.kinds.length > 1,
        figure.error || `${figure.files} files across ${figure.kinds.join(', ')}`);
    check('the storage figure equals the bytes actually on disk',
        !figure.error && figure.onDisk > 0 && figure.reported === figure.onDisk,
        figure.error || `reports ${figure.reported}, on disk ${figure.onDisk}`
            + `, media transfers alone ${figure.mediaOnly}`);

    // cl-virtual-list memoises with trustKey, so a cached row for a key is reused
    // without calling the render function again. Anything a row draws from that
    // is not in its key is therefore frozen at whatever it was first drawn with.
    const keys = await page.evaluate(async () => {
        const el = document.querySelector('offline-sync-manager');
        if (!el) return { error: 'settings page did not mount' };
        const item = (el.state.items || [])[0];
        if (!item) return { error: 'no items loaded' };

        const wasHeld = el.state.held.includes(item.Id);
        const before = el.itemKey(item);
        el.state.held = wasHeld
            ? el.state.held.filter((id) => id !== item.Id)
            : el.state.held.concat([item.Id]);
        const after = el.itemKey(item);
        el.state.held = wasHeld
            ? el.state.held.concat([item.Id])
            : el.state.held.filter((id) => id !== item.Id);

        const group = el.downloadTree().find((n) => n.kind === 'series' || n.kind === 'season');
        const groupKeys = group
            ? {
                shut: el.nodeKey(Object.assign({}, group, { open: false })),
                open: el.nodeKey(Object.assign({}, group, { open: true })),
                grown: el.nodeKey(Object.assign({}, group, { count: group.count + 1 }))
            }
            : null;
        return { before, after, groupKeys };
    });

    check('a row\'s key changes when its held state does',
        !keys.error && keys.before !== keys.after,
        keys.error || `${keys.before} vs ${keys.after}`);
    check('a group\'s key changes when it opens or grows',
        !keys.error && (!keys.groupKeys || (keys.groupKeys.shut !== keys.groupKeys.open
            && keys.groupKeys.shut !== keys.groupKeys.grown)),
        keys.error || JSON.stringify(keys.groupKeys));

    check('films are listed with no group to delete them all at once',
        !tree.error && tree.groups === 0 && tree.filmsAtTop > 0,
        tree.error || JSON.stringify(tree));
    check('only a series or a season can be removed in bulk',
        !tree.error && tree.bulkKinds.every((k) => k === 'series' || k === 'season'),
        tree.error || `bulk nodes: ${(tree.bulkKinds || []).join(',') || 'none'}`);

    const rowState = await page.evaluate(async () => {
        const el = document.querySelector('offline-sync-manager');
        if (!el) return { count: 0, disabled: 0, error: 'settings page did not mount' };
        const root = el.shadowRoot || el;
        // Filtering sets the component busy for the length of the request the rows
        // are drawn by; a row that reads `busy` is memoised in that state for good.
        el.state.busy = true;
        await new Promise((r) => setTimeout(r, 300));
        el.state.busy = false;
        await new Promise((r) => setTimeout(r, 500));
        const buttons = [...root.querySelectorAll('.item button.act')];
        return { count: buttons.length, disabled: buttons.filter((b) => b.disabled).length };
    });
    // The reported leak: cancel out of one series and the next one inherited its
    // grid, its seasons and its subtitle tracks.
    const leak = await page.evaluate(async (bigId, smallId) => {
        const el = document.querySelector('offline-sync-manager');
        if (!el) return { error: 'settings page did not mount' };
        const wait = async (fn, ms = 30000) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                if (fn()) return true;
                await new Promise((r) => setTimeout(r, 150));
            }
            return false;
        };
        const byId = async (id) => {
            const { knownServers, SourceServer } = await import('/web/plugin/source.js');
            const server = new SourceServer(knownServers(window.PS_SCHEMA.ID.SERVER)[0]);
            return server.item(id);
        };

        el.state.serverId = el.state.servers[0].id;

        const big = await byId(bigId);
        el.start(big);
        if (!await wait(() => el.state.asking && el.state.asking.Id === bigId)) return { error: 'first ask never opened' };
        const bigSeasons = el.state.askSeasons.length;

        el.openGrid();
        if (!await wait(() => el.state.gridRows.length > 0)) return { error: 'grid never filled' };
        const gridRows = el.state.gridRows.length;
        const gridChoices = Object.keys(el.state.gridChoices).length;
        const openedClean = el.state.gridUnresolved === 0 && gridChoices === 0;
        // Two halves of the contract, on real files: a rule that fits every
        // episode fills the grid, and one that fits none leaves them all marked
        // for a person rather than guessing.
        const withSubtitles = el.state.gridRows.filter((r) => r.subtitles.length).length;
        el.applyBulk('none');
        const afterFitting = Object.keys(el.state.gridChoices).length;
        const unresolvedAfterFitting = el.state.gridUnresolved;
        el.state.gridChoices = {};
        el.applyBulk('track', { ordinal: 0 });
        const afterUnfitting = Object.keys(el.state.gridChoices).length;
        const unresolvedAfterUnfitting = el.state.gridUnresolved;
        el.state.gridChoices = {};

        el.cancelAsk();
        const afterCancel = {
            asking: el.state.asking,
            gridRows: el.state.gridRows.length,
            gridChoices: Object.keys(el.state.gridChoices).length,
            seasons: el.state.askSeasons.length,
            tracks: el.state.askTracks.length,
            quality: el.state.askQuality
        };

        const small = await byId(smallId);
        el.start(small);
        if (!await wait(() => el.state.asking && el.state.asking.Id === smallId)) return { error: 'second ask never opened' };
        const second = {
            gridRows: el.state.gridRows.length,
            gridChoices: Object.keys(el.state.gridChoices).length,
            seasons: el.state.askSeasons.length
        };
        el.cancelAsk();
        return { bigSeasons, gridRows, gridChoices, openedClean, withSubtitles,
            afterFitting, unresolvedAfterFitting, afterUnfitting, unresolvedAfterUnfitting,
            afterCancel, second };
    }, MULTI_SEASON_SERIES, SMALL_SERIES);

    check('the per-episode grid fills for the series being asked about',
        !leak.error && leak.gridRows > 0 && leak.openedClean,
        leak.error || `${leak.gridRows} episodes, nothing presumed`);
    check('a bulk rule that fits fills the whole grid',
        !leak.error && leak.afterFitting === leak.gridRows && leak.unresolvedAfterFitting === 0,
        leak.error || `${leak.afterFitting} of ${leak.gridRows} set`);
    check('a bulk rule that fits nothing marks every row instead of guessing',
        !leak.error && (leak.withSubtitles > 0
            ? leak.afterUnfitting === leak.withSubtitles
            : leak.afterUnfitting === 0 && leak.unresolvedAfterUnfitting === leak.gridRows),
        leak.error || `${leak.withSubtitles} episodes have subtitles, ${leak.afterUnfitting} set, `
            + `${leak.unresolvedAfterUnfitting} left for a person`);
    check('cancelling the question clears everything it owned',
        !leak.error && leak.afterCancel.asking === null && leak.afterCancel.gridRows === 0
            && leak.afterCancel.gridChoices === 0 && leak.afterCancel.seasons === 0
            && leak.afterCancel.tracks === 0,
        leak.error || JSON.stringify(leak.afterCancel));
    check('the next series does not inherit the cancelled one',
        !leak.error && leak.second.gridRows === 0 && leak.second.gridChoices === 0
            && leak.second.seasons < leak.bigSeasons,
        leak.error || `${leak.second.seasons} seasons vs the previous ${leak.bigSeasons}, grid ${leak.second.gridRows}`);

    // A copy becomes an encode the moment a subtitle is chosen to burn in, and the
    // dialog has to follow that. Otherwise the remux note keeps saying nothing is
    // lost while the hidden default quality cap is applied to a rebuilt picture.
    const burnFlipsPlan = await page.evaluate(async (itemId) => {
        const el = document.querySelector('offline-sync-manager');
        if (!el) return { error: 'settings page did not mount' };
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const source = knownServers(window.PS_SCHEMA.ID.SERVER)[0];
        const server = new SourceServer(source);
        const item = await server.item(itemId);

        el.state.servers = knownServers(window.PS_SCHEMA.ID.SERVER);
        el.state.serverId = source.id;
        el.start(item);

        const deadline = Date.now() + 60000;
        while (Date.now() < deadline && !el.state.asking && !el.state.error) {
            await new Promise((r) => setTimeout(r, 200));
        }
        if (!el.state.asking) return { error: el.state.error || 'never asked' };

        const picture = el.state.askTracks.find((t) => !t.canExtract);
        const before = { remux: el.state.askRemux, encode: el.willEncode() };
        el.state.askChoice = picture ? String(picture.index) : 'auto';
        const after = { encode: el.willEncode(), pictureTrack: !!picture };
        el.resetAsk();
        el.state.asking = null;
        return { before, after };
    }, BURN_ITEM);

    check('an h264 file with a picture track starts out as a copy',
        !burnFlipsPlan.error && burnFlipsPlan.before.remux === true
        && burnFlipsPlan.before.encode === false,
        burnFlipsPlan.error || JSON.stringify(burnFlipsPlan.before));
    check('choosing to burn one in turns it into an encode, and says so',
        !burnFlipsPlan.error && burnFlipsPlan.after.pictureTrack === true
        && burnFlipsPlan.after.encode === true,
        burnFlipsPlan.error || JSON.stringify(burnFlipsPlan.after));

    // An item with nothing to ask about must still download. This is the path
    // that silently did nothing: start() held the exclusive lock, so the run()
    // it called at the end was refused and the download never began.
    const noQuestions = await page.evaluate(async (itemId) => {
        const el = document.querySelector('offline-sync-manager');
        if (!el) return { error: 'settings page did not mount' };
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { removeDownload, listDownloads, inspectSubtitles } = await import('/web/plugin/downloader.js');
        const source = knownServers(window.PS_SCHEMA.ID.SERVER)[0];
        const server = new SourceServer(source);
        const item = await server.item(itemId);

        const info = await inspectSubtitles(server, item);
        const asksNothing = !info.willTranscode
            && !info.tracks.some((t) => !t.canExtract) && info.audio.length <= 1;

        for (const row of (await listDownloads()).filter((r) => r.itemId === itemId)) {
            await removeDownload(row);
        }

        el.state.servers = knownServers(window.PS_SCHEMA.ID.SERVER);
        el.state.serverId = source.id;
        el.start(item);

        const deadline = Date.now() + 120000;
        let row = null;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 500));
            row = (await listDownloads()).find((r) => r.itemId === itemId);
            if (row && row.state === 'complete') break;
            if (el.state.error) break;
        }
        return {
            asksNothing,
            asked: !!el.state.asking,
            state: row ? row.state : 'no row',
            error: el.state.error || null
        };
    }, DIRECT_ITEM);

    check('an item with nothing to ask about needs no dialog',
        !noQuestions.error && noQuestions.asksNothing === true && noQuestions.asked === false,
        noQuestions.error || `asksNothing=${noQuestions.asksNothing} asked=${noQuestions.asked}`);
    check('and downloads when Download is pressed',
        noQuestions.state === 'complete', noQuestions.error || noQuestions.state);

    check('rows keep working buttons after a busy render',
        rowState.count > 0 && rowState.disabled === 0,
        `${rowState.disabled} of ${rowState.count} disabled`);

    check('paged items are not duplicated',
        !uiPaging.error && uiPaging.distinct === uiPaging.afterSecond,
        uiPaging.error || `${uiPaging.distinct} distinct of ${uiPaging.afterSecond}`);

    // ---- 8b. the modal, and the optional jellyfin-web patch --------------

    const modal = await page.evaluate(async (pid) => {
        if (!window.__phantom || !window.__phantom.ui) return { error: 'no ui api' };
        await window.__phantom.ui.open();
        await new Promise((r) => setTimeout(r, 2000));
        const panel = document.querySelector('[data-phantom-modal]');
        const manager = window.__phantom.ui.element();
        const root = manager && (manager.shadowRoot || manager);
        const state = {
            open: !!panel,
            upgraded: manager ? typeof manager._parseAttributes === 'function' : false,
            rendered: !!(root && /Downloaded|servers/i.test(root.textContent || '')),
            scrollLocked: document.documentElement.style.overflow === 'hidden'
        };
        window.__phantom.ui.close();
        await new Promise((r) => setTimeout(r, 200));
        state.closed = !document.querySelector('[data-phantom-modal]');
        state.scrollRestored = document.documentElement.style.overflow !== 'hidden';
        return state;
    }, phantomId);

    check('the manager opens as a modal without the jellyfin-web patch',
        !modal.error && modal.open && modal.upgraded && modal.rendered,
        modal.error || JSON.stringify(modal));
    check('the modal locks the page behind it and releases it on close',
        !modal.error && modal.scrollLocked && modal.closed && modal.scrollRestored,
        modal.error || `locked ${modal.scrollLocked}, closed ${modal.closed}`);

    // The chrome is in jellyfin-web's document rather than a shadow root, so
    // the only thing keeping its stylesheets out of the modal is that every
    // layout property in ps-ui.js is !important and every chrome element is
    // reset. This drops a deliberately hostile stylesheet on the page and
    // measures: against chrome that merely styles itself, the close button
    // lands hundreds of pixels outside a phone-width panel.
    const HOSTILE = `
        button { padding: 2em 3em !important; font-size: 2em !important;
                 margin: 1em !important; min-width: 12em !important; flex: 1 1 auto !important; }
        h2 { font-size: 2.5em !important; margin: 1em !important;
             flex: 3 1 auto !important; white-space: nowrap !important; }
        div { box-sizing: content-box !important; }
        html { font-size: 27px; }`;

    await page.setViewport({ width: 412, height: 915 });
    const hostile = await page.evaluate(async (css) => {
        const sheet = document.createElement('style');
        sheet.textContent = css;
        document.head.appendChild(sheet);
        await window.__phantom.ui.open();
        await new Promise((r) => setTimeout(r, 1000));
        const panel = document.querySelector('[data-phantom-modal] .phantom-modal-panel');
        const close = document.querySelector('[data-phantom-modal] .phantom-modal-close');
        const out = panel && close ? (() => {
            const p = panel.getBoundingClientRect();
            const c = close.getBoundingClientRect();
            return {
                // Half a pixel of slack for subpixel layout; a real escape is hundreds.
                insidePanel: c.right <= p.right + 0.5 && c.left >= p.left - 0.5,
                insideViewport: c.right <= window.innerWidth + 0.5 && c.left >= -0.5,
                visible: c.width > 0 && c.height > 0,
                panelFits: p.width <= window.innerWidth + 0.5,
                geometry: `close ${Math.round(c.left)}-${Math.round(c.right)}, `
                    + `panel ${Math.round(p.left)}-${Math.round(p.right)}, view ${window.innerWidth}`
            };
        })() : { error: 'modal did not open' };
        window.__phantom.ui.close();
        sheet.remove();
        return out;
    }, HOSTILE);
    await page.setViewport({ width: 1400, height: 1000 });

    check('the modal chrome holds against a hostile page stylesheet',
        !hostile.error && hostile.visible && hostile.insidePanel
        && hostile.insideViewport && hostile.panelFits,
        hostile.error || hostile.geometry);

    // Opening onto one item is what the context-menu entry does.
    const modalForItem = await page.evaluate(async (pid, itemId) => {
        const { knownServers } = await import('/web/plugin/source.js');
        const source = knownServers(pid)[0];
        if (!source) return { error: 'no source server' };
        await window.__phantom.ui.open({ serverId: source.id, itemId });
        const deadline = Date.now() + 20000;
        let manager = null;
        while (Date.now() < deadline) {
            manager = window.__phantom.ui.element();
            if (manager && manager.state && (manager.state.asking || manager.state.error)) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        const out = {
            asked: !!(manager && manager.state && manager.state.asking),
            askedFor: manager && manager.state && manager.state.asking && manager.state.asking.Id,
            error: manager && manager.state && manager.state.error,
            serverSelected: manager && manager.state && manager.state.serverId === source.id
        };
        window.__phantom.ui.close();
        return out;
    }, phantomId, BURN_ITEM);

    check('the modal can open straight onto one item',
        !modalForItem.error && modalForItem.serverSelected && modalForItem.askedFor === BURN_ITEM,
        modalForItem.error || `asked for ${modalForItem.askedFor}`);

    // The patch is optional, so its absence is reported rather than failed.
    const patched = await page.evaluate(async () => {
        const btn = [...document.querySelectorAll('button')]
            .find((b) => /account|user/i.test(b.getAttribute('aria-label') || ''));
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 800));
        const entry = [...document.querySelectorAll('[role="menuitem"], li')]
            .find((e) => e.textContent.trim() === 'Manage Downloads');
        if (!entry) {
            document.body.click();
            return { present: false };
        }
        entry.click();
        await new Promise((r) => setTimeout(r, 2000));
        const opened = !!document.querySelector('[data-phantom-modal]');
        window.__phantom.ui.close();
        return { present: true, opened };
    });
    check(patched.present
        ? 'the patched menu entry opens the manager'
        : 'the build carries no patch, which is the supported case',
    patched.present ? patched.opened === true : true,
    patched.present ? 'patch present' : 'stock jellyfin-web');

    // An update has to reach the user rather than sitting installed forever.
    const updates = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return {
            bridge: !!(window.__phantom && window.__phantom.onUpdate),
            checksOnLoad: typeof reg.update === 'function',
            waiting: !!(window.__phantom && window.__phantom.update
                && typeof window.__phantom.update.waiting === 'boolean')
        };
    });
    check('the page checks for a worker update and can report one',
        updates.bridge && updates.checksOnLoad && updates.waiting,
        JSON.stringify(updates));

    // ---- 9. the socket shim ----------------------------------------------

    const socket = await page.evaluate(async (itemId) => {
        const ws = new WebSocket(location.origin.replace('http', 'ws') + '/socket?ApiKey=x');
        const opened = await new Promise((res) => { ws.onopen = () => res(true); setTimeout(() => res(false), 2000); });
        const got = new Promise((res) => {
            ws.onmessage = (e) => res(JSON.parse(e.data).MessageType);
            setTimeout(() => res(null), 4000);
        });
        await fetch('/UserPlayedItems/' + itemId, { method: 'POST' });
        return { opened, message: await got, state: ws.readyState };
    }, direct.id);
    check('the shimmed socket opens and stays open', socket.opened === true && socket.state === 1);
    check('play state is pushed over the shimmed socket', socket.message === 'UserDataChanged', String(socket.message));

    // A parent entry describes the parent, not the episode that moved.
    //
    // Measured against a real 12.0.0 with tools/userdata-probe.py: the server
    // pushes the episode and ONE ancestor, and that ancestor's entry carries
    // Played false, PlayCount 0, no LastPlayedDate, and a PlayedPercentage and
    // UnplayedItemCount counted over its children. The fixture is held by this
    // check rather than borrowed, and only half of it is held, so a count taken
    // from the source server rather than from what is on disk is visible.
    const parents = await page.evaluate(async (pid, seriesId) => {
        const { knownServers, SourceServer } = await import('/web/plugin/source.js');
        const { downloadSeries, removeDownload, listDownloads } = await import('/web/plugin/downloader.js');
        const server = new SourceServer(knownServers(pid)[0]);
        const dto = await server.item(seriesId);
        await downloadSeries(server, dto, {});

        const mine = () => window.PS_DB.all('items').then((rows) => rows
            .filter((r) => r.dto.Type === 'Episode' && r.dto.SeriesId === seriesId));
        const downloaded = await mine();
        // Half of them go straight back out, so held and source disagree.
        const drop = new Set(downloaded.slice(Math.ceil(downloaded.length / 2)).map((r) => r.id));
        for (const row of (await listDownloads()).filter((r) => drop.has(r.itemId))) {
            await removeDownload(row);
        }
        const held = await mine();
        const episodeId = held.length ? held[0].id : null;

        const ws = new WebSocket(location.origin.replace('http', 'ws') + '/socket?ApiKey=x');
        await new Promise((res) => { ws.onopen = () => res(); setTimeout(res, 2000); });
        const got = new Promise((res) => {
            ws.onmessage = (e) => {
                const msg = JSON.parse(e.data);
                if (msg.MessageType === 'UserDataChanged') res(msg.Data.UserDataList);
            };
            setTimeout(() => res(null), 5000);
        });
        await fetch('/UserPlayedItems/' + episodeId, { method: 'POST' });
        const list = await got;
        const seriesRest = await (await fetch('/Items/' + seriesId)).json();

        const cleanup = (await listDownloads()).filter((r) => held.some((h) => h.id === r.itemId));
        for (const row of cleanup) await removeDownload(row);

        return {
            heldCount: held.length,
            sourceCount: downloaded.length,
            episodeId,
            entries: list,
            seriesUserData: seriesRest.UserData || null
        };
    }, phantomId, PARENT_SERIES);

    // Loud rather than skipped. The check this replaces returned `skipped` when
    // nothing was held and passed on it, which is the state it was least able to
    // survive: a vacuous pass over the exact defect it was written for.
    check('a multi-episode series is held for the parent-entry check',
        parents.heldCount >= 2 && parents.heldCount < parents.sourceCount,
        `held ${parents.heldCount} of ${parents.sourceCount} downloaded`);

    const parentEntries = (parents.entries || []).filter((u) => u.ItemId !== parents.episodeId);
    const carriesEpisodeState = parentEntries.filter((u) => u.Played || u.LastPlayedDate
        || u.PlayCount > 0 || u.PlaybackPositionTicks > 0);
    check('a parent entry does not carry the episode\'s played state',
        parentEntries.length > 0 && carriesEpisodeState.length === 0,
        parentEntries.length
            ? `${carriesEpisodeState.length} of ${parentEntries.length} parent entries do: `
              + JSON.stringify(carriesEpisodeState[0] || null)
            : 'no parent entry was pushed at all');

    // One of `heldCount` episodes is played, so these are the only two answers
    // that describe the parent rather than the child.
    const wantUnplayed = parents.heldCount - 1;
    const wantPercent = (1 / parents.heldCount) * 100;
    const counted = parentEntries.filter((u) => u.UnplayedItemCount === wantUnplayed
        && Math.abs((u.PlayedPercentage || 0) - wantPercent) < 0.01);
    check('a parent entry counts its own held children',
        parentEntries.length > 0 && counted.length === parentEntries.length,
        `want UnplayedItemCount ${wantUnplayed} and PlayedPercentage ${wantPercent.toFixed(1)}, got `
        + JSON.stringify(parentEntries.map((u) => [u.UnplayedItemCount, u.PlayedPercentage])));

    check('a served series counts the episodes held, not the ones the source has',
        !!parents.seriesUserData && parents.seriesUserData.UnplayedItemCount === wantUnplayed,
        `UnplayedItemCount ${parents.seriesUserData && parents.seriesUserData.UnplayedItemCount}`
        + ` over ${parents.heldCount} held, source has ${parents.sourceCount}`);

    // ---- 10. offline ------------------------------------------------------

    // Errors raised from here on are about a network that is deliberately gone.
    const beforeOffline = consoleErrors.length;
    await page.setOfflineMode(true);
    await page.goto(`${APP}/web/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(3000);
    const offline = await page.evaluate(async () => {
        const boot = !!window.PS_SCHEMA;
        const sys = await fetch('/System/Info/Public').then((r) => r.json()).catch((e) => ({ error: String(e) }));
        const items = await fetch('/Items?Recursive=true').then((r) => r.json()).catch((e) => ({ error: String(e) }));
        return { boot, server: sys.ServerName, total: items.TotalRecordCount, error: sys.error || items.error };
    });
    check('the app boots with no network', offline.boot === true, offline.error);
    check('the phantom server answers with no network',
        offline.server === 'Offline Library' && offline.total >= 1, `${offline.server} · ${offline.total} items`);

    const offlinePlugin = await page.evaluate(async () => {
        const htmlRes = await fetch('/web/configurationpage?name=offlinesync');
        const jsRes = await fetch('/web/configurationpage?name=offlinesync.js');
        const js = await jsRes.text();
        return {
            htmlStatus: htmlRes.status,
            jsStatus: jsRes.status,
            isModule: /export\s*\{\s*default/.test(js) || js.includes('export default')
        };
    });
    check('the download manager still loads with no network',
        offlinePlugin.htmlStatus === 200 && offlinePlugin.jsStatus === 200 && offlinePlugin.isModule,
        `html ${offlinePlugin.htmlStatus}, controller ${offlinePlugin.jsStatus}`);

    const offlineMedia = await page.evaluate(async (id) => {
        const info = await (await fetch(`/Items/${id}/PlaybackInfo`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ DeviceProfile: {} })
        })).json();
        const ms = info.MediaSources[0];
        const url = ms.SupportsDirectPlay
            ? `/Videos/${id}/stream.${ms.Container}?Static=true`
            : ms.TranscodingUrl;
        const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
        return { status: res.status, bytes: (await res.arrayBuffer()).byteLength, url };
    }, direct.id);
    check('media serves with no network', offlineMedia.status === 206 && offlineMedia.bytes === 1024,
        `${offlineMedia.status} ${offlineMedia.bytes} ${offlineMedia.url}`);
    const offlineRoute = await page.evaluate(async () => {
        // A lazily-loaded chunk for a route this session never opened. Cached on
        // demand it would not be here; precached, it is.
        const names = (await caches.keys()).filter((n) => n.startsWith('phantom-app-'));
        let entries = [];
        for (const name of names) {
            const keys = await (await caches.open(name)).keys();
            if (keys.length > entries.length) entries = keys;
        }
        const chunks = entries.map((r) => new URL(r.url).pathname).filter((p) => p.endsWith('.chunk.js'));
        if (!chunks.length) return { error: 'no chunks held' };
        const res = await fetch(chunks[Math.floor(chunks.length / 2)]);
        return { status: res.status, held: chunks.length, sample: chunks[Math.floor(chunks.length / 2)] };
    });
    check('an unvisited route\'s code is available with no network',
        !offlineRoute.error && offlineRoute.status === 200,
        offlineRoute.error || `${offlineRoute.held} chunks held`);

    await page.setOfflineMode(false);

    // ---- errors -----------------------------------------------------------

    const sourceHost = new URL(SOURCE).host;
    const unexpected = consoleErrors
        .slice(firstLoadErrors)
        .filter((e, i) => !(i + firstLoadErrors >= beforeOffline && e.includes(sourceHost)))
        .filter((e) =>
        // hls.js cannot spawn its demuxer worker in headless Chrome and says so
        // non-fatally. A real Jellyfin server produces the identical error on the
        // same item; tools/dbg-hls-baseline.js is that comparison.
        !/favicon|manifest|Failed to load resource.*40[34]|ERR_INTERNET_DISCONNECTED|failed to fetch system info|internalException/i.test(e));
    check('no unexpected console errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));

    if (HEADFUL) await sleep(600000);
    await browser.close();

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
