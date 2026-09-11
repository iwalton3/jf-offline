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
    const paging = await page.evaluate(async (viewShows) => {
        const SEED = 250;
        const rows = [];
        for (let i = 0; i < SEED; i++) {
            const id = 'aaaa' + String(i).padStart(28, '0');
            rows.push({
                srv: 'seed', id, type: 'Series',
                dto: {
                    Id: id, Name: 'Seeded Show ' + String(i).padStart(3, '0'),
                    SortName: 'Seeded Show ' + String(i).padStart(3, '0'),
                    Type: 'Series', IsFolder: true, ServerId: 'seed', ImageTags: {}, BackdropImageTags: []
                },
                seriesId: null, seasonId: null, addedAt: Date.now() + i
            });
        }
        await window.PS_DB.putMany('items', rows);

        const get = async (start, limit) => (await (await fetch(
            `/Items?ParentId=${viewShows}&IncludeItemTypes=Series&SortBy=SortName&StartIndex=${start}&Limit=${limit}`
        )).json());

        const first = await get(0, 100);
        const second = await get(100, 100);
        const third = await get(200, 100);
        const beyond = await get(1000, 100);

        const seen = new Set([...first.Items, ...second.Items, ...third.Items].map((i) => i.Id));

        for (const r of rows) await window.PS_DB.del('items', ['seed', r.id]);

        return {
            total: first.TotalRecordCount,
            counts: [first.Items.length, second.Items.length, third.Items.length],
            startIndexEchoed: second.StartIndex,
            distinct: seen.size,
            overlap: first.Items[0].Id === second.Items[0].Id,
            beyondEnd: beyond.Items.length,
            firstName: first.Items[0].Name,
            secondName: second.Items[0].Name
        };
    }, await page.evaluate(() => window.PS_SCHEMA.ID.VIEW_SHOWS));

    check('a large library reports its full total', paging.total >= 250, String(paging.total));
    check('pages are full and consecutive', paging.counts[0] === 100 && paging.counts[1] === 100,
        paging.counts.join(','));
    check('pages do not repeat', !paging.overlap && paging.distinct === 250,
        `${paging.distinct} distinct across 3 pages, first=${paging.firstName} second=${paging.secondName}`);
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
            jsIsModule: js.includes('export default'),
            menu: pages.map((p) => p.DisplayName)
        };
    });
    check('plugin page is a jellyfin view with a controller', plugin.isView);
    check('plugin markup survives translateHtml', plugin.survivesTranslate);
    check('plugin controller serves as a module', plugin.jsIsModule && /javascript/.test(plugin.jsType || ''), plugin.jsType);
    check('plugin appears in the dashboard menu', plugin.menu.includes('Offline Sync'), plugin.menu.join(','));

    // The settings page has to mount inside the running app, not just parse.
    await page.goto(`${APP}/web/#/configurationpage?name=offlinesync`, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(4000);
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
    check('Load more fetches past the first page',
        !uiPaging.error && (uiPaging.total <= uiPaging.afterFirst || uiPaging.afterSecond > uiPaging.afterFirst),
        uiPaging.error || `${uiPaging.afterFirst} then ${uiPaging.afterSecond} of ${uiPaging.total}`);
    check('paged items are not duplicated',
        !uiPaging.error && uiPaging.distinct === uiPaging.afterSecond,
        uiPaging.error || `${uiPaging.distinct} distinct of ${uiPaging.afterSecond}`);

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
        const manifest = await caches.open('phantom-app').then((c) => c.keys());
        const chunks = manifest.map((r) => new URL(r.url).pathname).filter((p) => p.endsWith('.chunk.js'));
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
